import { createHash, createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { compileForProfile } from "../compile/compile.js";
import { getProfile, profileForLoTEType } from "../profiles/registry.js";
import type { AuthoringEntity, AuthoringInput } from "../model/authoring.js";
import type { PublicationStore } from "../publication/store.js";
import { validateEtsiStruct } from "../validate/validate.js";
import { sign as signLote } from "../signing/signing.js";
import { verify } from "../verification/verification.js";
import { publish, PublicationError } from "../publication/manifest.js";
import {
  canTransition,
  normalizeToAuthoringInput,
} from "./application-model.js";
import type {
  PIDProviderApplicantData,
  PublicationRecord,
  TrustedEntityApplication,
  WalletProviderApplicantData,
  WalletProviderApplication,
} from "./application-model.js";
import { AuthoringStore } from "./authoring-store.js";
import { findSigningConfig } from "./signing-config.js";
import type { SigningConfig, SigningConfigEntry } from "./signing-config.js";
import {
  parseAndValidateSubmission,
  type SubmissionFields,
  type SubmissionParseResult,
} from "./submission-parser.js";
import {
  loadLatestPublication,
  checkServiceIdentifierUniqueness,
  assembleNextList,
} from "./list-assembler.js";

export type ServiceResult<T> =
  | { success: true; data: T; message?: string; warning?: string }
  | { success: false; error: string };
export interface PartialCommitResult {
  success: false;
  code: "PUBLICATION_COMMITTED_APPLICATION_STALE";
  error: string;
  publication: PublicationRecord;
}
/** Legacy Wallet-compatible result type for callers that predate profile selection. */
export type PublishApplicationResult =
  ServiceResult<WalletProviderApplication> | PartialCommitResult;
/** Profile-aware publication result used by the multi-profile service implementation. */
export type ProfilePublishApplicationResult =
  ServiceResult<TrustedEntityApplication> | PartialCommitResult;
export interface PreparedPublication {
  success: true;
  data: AuthoringInput;
  sequenceNumber: number;
  listIssueDateTime: string;
  nextUpdate: string;
  entry: SigningConfigEntry;
  existingEntityCount: number;
}
export type PreparedPublicationResult =
  PreparedPublication | { success: false; error: string };
export interface PreviewResult {
  compilerInput: AuthoringInput | null;
  compilerInputJson: string | null;
  etsiValid: boolean | null;
  etsiFindings: { path: string; message: string }[];
  existingEntityCount: number;
  resultingEntityCount: number;
  currentSequence: number | null;
  proposedSequence: number | null;
  error?: string;
}
export class ApplicationService {
  readonly authoringStore: AuthoringStore;
  readonly publicationStore: PublicationStore;
  readonly signingConfig: SigningConfig | null | undefined;
  private readonly listLocks = new Map<string, Promise<void>>();
  constructor(
    authoringStore: AuthoringStore,
    publicationStore: PublicationStore,
    signingConfig?: SigningConfig | null,
  ) {
    this.authoringStore = authoringStore;
    this.publicationStore = publicationStore;
    this.signingConfig = signingConfig;
  }
  submitApplication(
    formFields: SubmissionFields,
    targetListKey: string,
    family: "wallet-providers" | "pid-providers" = "wallet-providers",
  ): SubmissionParseResult {
    return parseAndValidateSubmission(formFields, targetListKey, family);
  }
  createApp(
    targetListKey: string,
    applicantData: WalletProviderApplicantData,
    family?: "wallet-providers",
  ): import("./application-model.js").WalletProviderApplication;
  createApp(
    targetListKey: string,
    applicantData: PIDProviderApplicantData,
    family: "pid-providers",
  ): import("./application-model.js").PIDProviderApplication;
  createApp(
    targetListKey: string,
    applicantData: WalletProviderApplicantData | PIDProviderApplicantData,
    family: "wallet-providers" | "pid-providers" = "wallet-providers",
  ): TrustedEntityApplication {
    const id = this.authoringStore.createId();
    const submittedAt = new Date().toISOString();
    const app: TrustedEntityApplication =
      family === "pid-providers"
        ? "responsibleMemberState" in applicantData
          ? {
              id,
              schemaVersion: 1,
              family,
              targetListKey,
              state: "submitted",
              submittedAt,
              applicantData,
            }
          : (() => {
              throw new Error(
                "PID Provider applications require responsibleMemberState.",
              );
            })()
        : {
            id,
            schemaVersion: 1,
            family,
            targetListKey,
            state: "submitted",
            submittedAt,
            applicantData,
          };
    this.authoringStore.save(app);
    return app;
  }
  getApplication(id: string): TrustedEntityApplication | null {
    return this.authoringStore.load(id);
  }
  listApplications(): TrustedEntityApplication[] {
    return this.authoringStore.list();
  }
  approve(id: string): ServiceResult<TrustedEntityApplication> {
    const app = this.getApplication(id);
    if (!app) return { success: false, error: "Application not found." };
    if (!canTransition(app.state, "approved")) {
      return {
        success: false,
        error: `Cannot approve application in state: ${app.state}`,
      };
    }
    app.state = "approved";
    app.approvedAt = new Date().toISOString();
    this.authoringStore.save(app);
    return { success: true, data: app };
  }
  reject(id: string, note: string): ServiceResult<TrustedEntityApplication> {
    const app = this.getApplication(id);
    if (!app) return { success: false, error: "Application not found." };
    if (!canTransition(app.state, "rejected")) {
      return {
        success: false,
        error: `Cannot reject application in state: ${app.state}`,
      };
    }
    const trimmed = note.trim();
    if (!trimmed) {
      return { success: false, error: "Rejection note is required." };
    }
    app.state = "rejected";
    app.rejectedAt = new Date().toISOString();
    app.adminNote = trimmed;
    app.approvedAt = undefined;
    this.authoringStore.save(app);
    return { success: true, data: app };
  }
  deleteApplication(id: string): ServiceResult<undefined> {
    const app = this.getApplication(id);
    if (!app) return { success: false, error: "Application not found." };
    if (app.state === "published") {
      return {
        success: false,
        error: "Cannot delete a published application.",
      };
    }
    this.authoringStore.delete(id);
    return { success: true, data: undefined };
  }
  async preparePublishInput(
    app: TrustedEntityApplication,
    clock: Date | undefined = undefined,
  ): Promise<PreparedPublicationResult> {
    const entry = this.resolveListConfig(app);
    if (!entry) {
      return {
        success: false,
        error: `No signing configuration found for list key '${app.targetListKey}'.`,
      };
    }
    if (entry.family !== app.family) {
      return {
        success: false,
        error: `Application family '${app.family}' cannot publish to ${entry.family} list '${app.targetListKey}'.`,
      };
    }
    const profile = getProfile(app.family);
    const now = clock ?? new Date();
    const listIssueDateTime = now.toISOString();
    const nextUpdate = new Date(
      now.getTime() + 180 * 24 * 60 * 60 * 1000,
    ).toISOString();
    let existingEntities: AuthoringEntity[] = [];
    let nextSeq = 1;
    try {
      const latest = await loadLatestPublication(
        this.publicationStore,
        app.targetListKey,
        app.family,
      );
      if (latest.exists) {
        const storedType =
          latest.loteDocument.LoTE.ListAndSchemeInformation.LoTEType;
        if (
          storedType !== profile.loTEType ||
          profileForLoTEType(storedType ?? "")?.family !== app.family
        ) {
          return {
            success: false,
            error: `Stored LoTE type does not match configured family '${app.family}'.`,
          };
        }
      }
      existingEntities = latest.exists ? (latest.entities ?? []) : [];
      nextSeq = latest.exists ? latest.sequenceNumber + 1 : 1;
    } catch (e) {
      return {
        success: false,
        error: `Cannot load latest publication: ${e instanceof Error ? e.message : "unknown"}`,
      };
    }
    const candidateEntity = buildCandidateEntity(app);
    // Check duplicates
    const dupCheck = checkServiceIdentifierUniqueness(
      existingEntities,
      candidateEntity,
    );
    if (!dupCheck.ok) {
      return {
        success: false,
        error: `DUPLICATE_IDENTIFIER: ${dupCheck.duplicate}`,
      };
    }
    const input = assembleNextList(
      existingEntities,
      candidateEntity,
      app,
      entry,
      listIssueDateTime,
      nextUpdate,
      nextSeq,
    );
    if (!input)
      return {
        success: false,
        error: "Cannot assemble the next cumulative list.",
      };
    return {
      success: true,
      data: input,
      sequenceNumber: nextSeq,
      listIssueDateTime,
      nextUpdate,
      entry,
      existingEntityCount: existingEntities.length,
    };
  }
  async publishApplication(
    id: string,
    clock?: Date,
  ): Promise<PublishApplicationResult>;
  async publishApplication(
    id: string,
    clock: Date | undefined = undefined,
  ): Promise<ProfilePublishApplicationResult> {
    const app = this.getApplication(id);
    if (!app) return { success: false, error: "Application not found." };
    if (!canTransition(app.state, "published")) {
      return {
        success: false,
        error: `Cannot publish application in state: ${app.state}`,
      };
    }
    return this.withListLock(app.targetListKey, async () => {
      return this.doPublish(app, clock);
    });
  }
  async doPublish(
    app: TrustedEntityApplication,
    clock: Date | undefined = undefined,
  ): Promise<ProfilePublishApplicationResult> {
    const listEntry = this.resolveListConfig(app);
    if (!listEntry) {
      return {
        success: false,
        error: `No signing configuration found for list key '${app.targetListKey}'. Check signing-config.`,
      };
    }
    if (!listEntry.keyFile || !listEntry.certFile) {
      return {
        success: false,
        error: `Signing configuration for '${app.targetListKey}' is missing key or certificate paths.`,
      };
    }
    const prepare = await this.preparePublishInput(app, clock);
    if (!prepare.success) {
      return { success: false, error: prepare.error };
    }
    try {
      const compileResult = compileForProfile(app.family, prepare.data);
      const etsiResult = await validateEtsiStruct(compileResult.document);
      if (!etsiResult.valid) {
        const reasons = etsiResult.findings
          .map((f) => `${f.path}: ${f.message}`)
          .join("; ");
        return { success: false, error: `ETSI validation failed: ${reasons}` };
      }
      const keyPem = readFileString(listEntry.keyFile);
      const certPem = readFileString(listEntry.certFile);
      const privateKey = createPrivateKey(keyPem);
      const jwk = privateKey.export({ format: "jwk" });
      const signingKey = await crypto.subtle.importKey(
        "jwk",
        jwk,
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["sign"],
      );
      const signed = await signLote({
        document: compileResult.document,
        key: signingKey,
        certificatePem: certPem,
      });
      const verifyResult = await verify({
        compactJws: signed.compact,
        certificatePem: certPem,
      });
      if (!verifyResult.valid) {
        return { success: false, error: "Post-sign verification failed." };
      }
      const pubResult = await publish({
        compactJws: signed.compact,
        certificatePem: certPem,
      });
      if (pubResult.listKey !== app.targetListKey) {
        return {
          success: false,
          error: `Derived publication list key "${pubResult.listKey}" does not match target list key "${app.targetListKey}".`,
        };
      }
      const manifestJson = JSON.stringify(pubResult.manifest, null, 2);
      const storeResult = await this.publicationStore.store(
        pubResult,
        signed.compact,
        pubResult.loteJson,
        manifestJson,
      );
      const manifestHash = createHash("sha256")
        .update(manifestJson)
        .digest("hex");
      app.state = "published";
      app.publication = {
        listKey: pubResult.listKey,
        sequenceNumber: pubResult.sequenceNumber,
        manifestSha256: manifestHash,
        compactJadesSha256: pubResult.manifest.compactJadesSha256,
        publicationTimestamp: pubResult.manifest.publicationTimestamp,
      };
      try {
        this.authoringStore.save(app);
      } catch {
        const partial: PartialCommitResult = {
          success: false,
          code: "PUBLICATION_COMMITTED_APPLICATION_STALE",
          error: `Immutable publication succeeded for list key "${pubResult.listKey}" sequence ${pubResult.sequenceNumber} but the application record could not be updated. Run reconciliation to repair.`,
          publication: {
            listKey: pubResult.listKey,
            sequenceNumber: pubResult.sequenceNumber,
            manifestSha256: manifestHash,
            compactJadesSha256: pubResult.manifest.compactJadesSha256,
            publicationTimestamp: pubResult.manifest.publicationTimestamp,
          },
        };
        return partial;
      }
      let msg = "Application published successfully.";
      let warning;
      if (storeResult.indexWarning) {
        warning = storeResult.indexWarning;
      }
      return { success: true, data: app, message: msg, warning };
    } catch (e) {
      const msg =
        e instanceof PublicationError
          ? e.message
          : e instanceof Error
            ? e.message
            : "Publication failed";
      return { success: false, error: msg };
    }
  }
  async reconcileApplication(
    id: string,
  ): Promise<ServiceResult<TrustedEntityApplication>> {
    const app = this.getApplication(id);
    if (!app) return { success: false, error: "Application not found." };
    const latest = await loadLatestPublication(
      this.publicationStore,
      app.targetListKey,
      app.family,
    );
    if (!latest.exists) {
      return { success: false, error: "No publications exist for this list." };
    }
    const data = app.applicantData;
    const candidateIds = new Set(
      data.services.map((service) => service.serviceUniqueIdentifier),
    );
    // Find an entity whose service set EXACTLY matches all candidate IDs
    let matchEntity;
    const latestEntities: AuthoringEntity[] = latest.entities ?? [];
    for (const entity of latestEntities) {
      const entityIds = new Set(
        entity.services.map((service) => service.serviceUniqueIdentifier),
      );
      if (
        entityIds.size === candidateIds.size &&
        [...candidateIds].every((id) => entityIds.has(id))
      ) {
        matchEntity = entity;
        break;
      }
    }
    if (!matchEntity) {
      return {
        success: false,
        error:
          "Reconciliation failed: no published entity exactly matches all candidate service identifiers.",
      };
    }
    const manifest = await this.publicationStore.loadManifest(
      app.targetListKey,
      latest.sequenceNumber,
    );
    if (!manifest) {
      return {
        success: false,
        error: "Cannot load latest publication manifest.",
      };
    }
    const manifestBytes = await this.publicationStore.loadVersionBytes(
      app.targetListKey,
      latest.sequenceNumber,
      "manifest",
    );
    const manifestHash = manifestBytes
      ? createHash("sha256").update(manifestBytes).digest("hex")
      : "";
    app.state = "published";
    app.publication = {
      listKey: manifest.listKey,
      sequenceNumber: manifest.sequenceNumber,
      manifestSha256: manifestHash,
      compactJadesSha256: manifest.compactJadesSha256,
      publicationTimestamp: manifest.publicationTimestamp,
    };
    try {
      this.authoringStore.save(app);
      return {
        success: true,
        data: app,
        message: "Reconciliation successful.",
      };
    } catch (e) {
      return {
        success: false,
        error: `Reconciliation failed to save: ${e instanceof Error ? e.message : "unknown"}`,
      };
    }
  }
  async preview(
    app: TrustedEntityApplication,
    clock: Date | undefined = undefined,
  ): Promise<PreviewResult> {
    const prepare = await this.preparePublishInput(app, clock);
    if (!prepare.success) {
      return {
        compilerInput: null,
        compilerInputJson: null,
        etsiValid: null,
        etsiFindings: [],
        existingEntityCount: 0,
        resultingEntityCount: 0,
        currentSequence: null,
        proposedSequence: null,
        error: prepare.error,
      };
    }
    try {
      const compilerInputJson = JSON.stringify(prepare.data, null, 2);
      const { document } = compileForProfile(app.family, prepare.data);
      const etsiResult = await validateEtsiStruct(document);
      const existingCount =
        prepare.existingEntityCount ?? prepare.data.entities.length - 1;
      return {
        compilerInput: prepare.data,
        compilerInputJson,
        etsiValid: etsiResult.valid,
        etsiFindings: etsiResult.findings,
        existingEntityCount: Math.max(0, existingCount),
        resultingEntityCount: prepare.data.entities.length,
        currentSequence: prepare.sequenceNumber - 1 || null,
        proposedSequence: prepare.sequenceNumber,
      };
    } catch (e) {
      return {
        compilerInput: null,
        compilerInputJson: null,
        etsiValid: null,
        etsiFindings: [],
        existingEntityCount: 0,
        resultingEntityCount: 0,
        currentSequence: null,
        proposedSequence: null,
        error: e instanceof Error ? e.message : "Preview failed",
      };
    }
  }
  resolveListConfig(
    app: TrustedEntityApplication,
  ): SigningConfigEntry | undefined {
    if (!this.signingConfig) return undefined;
    const entry = findSigningConfig(this.signingConfig, app.targetListKey);
    if (entry && entry.family !== app.family) return undefined;
    return entry;
  }
  private async withListLock<T>(
    listKey: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const prev = this.listLocks.get(listKey) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.listLocks.set(listKey, tail);
    const result = prev
      .catch(() => {})
      .then(() => fn())
      .finally(() => release?.());
    try {
      const val = await result;
      // Only delete our own tail entry — never delete a later queued operation
      if (this.listLocks.get(listKey) === tail) {
        this.listLocks.delete(listKey);
      }
      return val;
    } catch (e) {
      if (this.listLocks.get(listKey) === tail) {
        this.listLocks.delete(listKey);
      }
      throw e;
    }
  }
  getSigningConfig(): SigningConfig | null | undefined {
    return this.signingConfig;
  }
}
function buildCandidateEntity(app: TrustedEntityApplication): AuthoringEntity {
  const input = normalizeToAuthoringInput(
    app,
    "",
    "",
    "",
    { streetAddress: "", country: "" },
    "",
    "",
    "",
    "",
    1,
  );
  const candidate = input.entities[0];
  if (!candidate)
    throw new Error("Application does not contain a publishable entity.");
  return candidate;
}
function readFileString(path: string): string {
  return readFileSync(path, "utf-8");
}
