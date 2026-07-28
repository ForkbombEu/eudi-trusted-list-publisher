import { createHash, createPrivateKey } from "node:crypto";
import { compile } from "../compile/compile.js";
import { validateEtsiStruct } from "../validate/validate.js";
import { sign as signLote } from "../signing/signing.js";
import { verify } from "../verification/verification.js";
import { publish, PublicationError } from "../publication/manifest.js";
import { PublicationStore } from "../publication/store.js";
import {
  AuthoringStore,
  canTransition,
  normalizeToAuthoringInput,
  type SigningConfig,
  findSigningConfig,
  type SigningConfigEntry,
} from "./index.js";
import {
  type WalletProviderApplication,
  type WalletProviderApplicantData,
} from "./application-model.js";
import {
  parseAndValidateSubmission,
  createApplicationRecord,
  type SubmissionParseResult,
} from "./submission-parser.js";
import type { AuthoringInput } from "../model/authoring.js";
import type { ValidationFinding } from "../validate/validate.js";
import {
  loadLatestPublication,
  checkServiceIdentifierUniqueness,
  assembleNextList,
} from "./list-assembler.js";

export type ServiceResult<T> =
  | { success: true; data: T; message?: string; warning?: string }
  | { success: false; error: string };

export interface PublishResult {
  listKey: string;
  sequenceNumber: number;
  manifestSha256: string;
  compactJadesSha256: string;
  publicationTimestamp: string;
  warning?: string;
}

export interface PreviewResult {
  compilerInput: AuthoringInput | null;
  compilerInputJson: string | null;
  etsiValid: boolean | null;
  etsiFindings: ValidationFinding[];
  error?: string;
  existingEntityCount: number;
  resultingEntityCount: number;
  currentSequence: number | null;
  proposedSequence: number | null;
}

export class ApplicationService {
  private listLocks: Map<string, Promise<void>> = new Map();

  constructor(
    private authoringStore: AuthoringStore,
    private publicationStore: PublicationStore,
    private signingConfig: SigningConfig | null,
  ) {}

  submitApplication(
    formFields: Record<string, string>,
    targetListKey: string,
  ): SubmissionParseResult {
    return parseAndValidateSubmission(formFields, targetListKey);
  }

  createApp(
    targetListKey: string,
    applicantData: WalletProviderApplicantData,
  ): WalletProviderApplication {
    const id = this.authoringStore.createId();
    const app = createApplicationRecord(id, targetListKey, applicantData);
    this.authoringStore.save(app);
    return app;
  }

  getApplication(id: string): WalletProviderApplication | null {
    return this.authoringStore.load(id);
  }

  listApplications(): WalletProviderApplication[] {
    return this.authoringStore.list();
  }

  approve(id: string): ServiceResult<WalletProviderApplication> {
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

  reject(id: string, note: string): ServiceResult<WalletProviderApplication> {
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

  deleteApplication(id: string): ServiceResult<void> {
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
    app: WalletProviderApplication,
    clock?: Date,
  ): Promise<
    | {
        success: true;
        data: AuthoringInput;
        sequenceNumber: number;
        listIssueDateTime: string;
        nextUpdate: string;
        entry: SigningConfigEntry;
      }
    | { success: false; error: string }
  > {
    const entry = this.resolveListConfig(app);
    if (!entry) {
      return {
        success: false,
        error: `No signing configuration found for list key '${app.targetListKey}'.`,
      };
    }

    const now = clock ?? new Date();
    const listIssueDateTime = now.toISOString();
    const nextUpdate = new Date(
      now.getTime() + 180 * 24 * 60 * 60 * 1000,
    ).toISOString();

    const latest = await loadLatestPublication(
      this.publicationStore,
      app.targetListKey,
    );
    const existingEntities = latest.exists ? latest.entities : [];
    const nextSeq = latest.exists ? latest.sequenceNumber + 1 : 1;

    const candidateEntity = buildCandidateEntity(app);

    const input = assembleNextList(
      existingEntities,
      candidateEntity,
      app,
      entry,
      listIssueDateTime,
      nextUpdate,
      nextSeq,
    );

    return {
      success: true,
      data: input,
      sequenceNumber: nextSeq,
      listIssueDateTime,
      nextUpdate,
      entry,
    };
  }

  async publishApplication(
    id: string,
    clock?: Date,
  ): Promise<ServiceResult<WalletProviderApplication>> {
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

  private async doPublish(
    app: WalletProviderApplication,
    clock?: Date,
  ): Promise<ServiceResult<WalletProviderApplication>> {
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

    // Load latest and build candidate for duplicate check
    const latest = await loadLatestPublication(
      this.publicationStore,
      app.targetListKey,
    );
    const existingEntities = latest.exists ? latest.entities : [];

    const candidateEntity = buildCandidateEntity(app);

    const dupCheck = checkServiceIdentifierUniqueness(
      existingEntities,
      candidateEntity,
    );
    if (!dupCheck.ok) {
      return {
        success: false,
        error: `Duplicate service identifier: ${dupCheck.duplicate} already exists in the current list.`,
      };
    }

    const prepare = await this.preparePublishInput(app, clock);
    if (!prepare.success) {
      return { success: false, error: prepare.error };
    }

    try {
      const compileResult = compile(prepare.data);

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
        jwk as JsonWebKey,
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
        return {
          success: true,
          data: app,
          message: `Publication succeeded but application record update failed. Reconciliation required for list key "${pubResult.listKey}" sequence ${pubResult.sequenceNumber}.`,
          warning: "APPLICATION_RECORD_STALE",
        };
      }

      let msg = "Application published successfully.";
      let warning: string | undefined;
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
  ): Promise<ServiceResult<WalletProviderApplication>> {
    const app = this.getApplication(id);
    if (!app) return { success: false, error: "Application not found." };

    const latest = await loadLatestPublication(
      this.publicationStore,
      app.targetListKey,
    );
    if (!latest.exists) {
      return { success: false, error: "No publications exist for this list." };
    }

    // Check if the applicant's service identifiers appear in the latest LoTE
    const data = app.applicantData;
    const svcIds = new Set(data.services.map((s) => s.serviceUniqueIdentifier));

    let found = false;
    for (const entity of latest.entities) {
      for (const svc of entity.services) {
        if (svcIds.has(svc.serviceUniqueIdentifier)) {
          found = true;
          break;
        }
      }
      if (found) break;
    }

    if (!found) {
      return {
        success: false,
        error:
          "Applicant's services are not present in the current published list.",
      };
    }

    // Load the latest manifest
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
    app: WalletProviderApplication,
    clock?: Date,
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
      const { document } = compile(prepare.data);
      const etsiResult = await validateEtsiStruct(document);

      const existingCount = prepare.data.entities.length - 1;

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

  private resolveListConfig(
    app: WalletProviderApplication,
  ): SigningConfigEntry | undefined {
    if (!this.signingConfig) return undefined;
    return findSigningConfig(this.signingConfig, app.targetListKey);
  }

  private async withListLock<T>(
    listKey: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const previous = this.listLocks.get(listKey) ?? Promise.resolve();
    let release: () => void = () => {};
    const lock = new Promise<void>((resolve) => {
      release = resolve;
    });

    const chained = previous
      .then(() => {})
      .then(() => {
        return fn().finally(() => release());
      });

    // Clean up after completion
    chained.finally(() => {
      if (this.listLocks.get(listKey) === lock) {
        this.listLocks.delete(listKey);
      }
    });

    this.listLocks.set(listKey, lock);

    return chained;
  }

  getSigningConfig(): SigningConfig | null {
    return this.signingConfig;
  }
}

function buildCandidateEntity(app: WalletProviderApplication) {
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
  return input.entities[0]!;
}

import { readFileSync } from "node:fs";

function readFileString(path: string): string {
  return readFileSync(path, "utf-8");
}
