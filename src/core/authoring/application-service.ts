import { createHash, createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { compileForProfile } from "../compile/compile.js";
import {
  getProfile,
  profileForLoTEType,
  type EnabledProfileFamily,
} from "../profiles/registry.js";
import type {
  AuthoringEntity,
  AuthoringInput,
  AuthoringServiceHistoryInstance,
} from "../model/authoring.js";
import { subjectKeyIdentifierBase64 } from "../model/x509-ski.js";
import { certificateDerBase64, toUtcDateTime } from "../model/lexical.js";
import type { LoTEDocument } from "../model/types.js";
import {
  InspectorClient,
  type InspectorEvaluation,
} from "../inspector/inspector.js";
import type { PublicationStore } from "../publication/store.js";
import { validateEtsiStruct } from "../validate/validate.js";
import { sign as signLote } from "../signing/signing.js";
import { verify } from "../verification/verification.js";
import { publish, PublicationError } from "../publication/manifest.js";
import { normalizeDefectSelectionForStandard } from "../defects/registry.js";
import { unappliedSelectedDefects } from "../defects/fixture-metadata.js";
import {
  canTransition,
  buildAuthoringEntity,
  normalizeToAuthoringInput,
} from "./application-model.js";
import type {
  ApplicantDataByFamily,
  ApplicationByFamily,
  PublicationRecord,
  TrustedEntityApplication,
  WalletProviderApplication,
} from "./application-model.js";
import { AuthoringStore } from "./authoring-store.js";
import type { SettingsStore } from "./settings-store.js";
import { findSigningConfig } from "./signing-config.js";
import type { SigningConfig, SigningConfigEntry } from "./signing-config.js";
import {
  createApplicationRecord,
  parseAndValidateSubmission,
  type SubmissionFields,
  type SubmissionParseResult,
} from "./submission-parser.js";
import {
  loadLatestPublication,
  checkServiceIdentifierUniqueness,
  assembleNextList,
  restateServiceStatusTimes,
  schemeDescriptorFor,
} from "./list-assembler.js";
import {
  applyPostSignDefects,
  applyPreSignDefects,
  buildFixtureMetadata,
  type AppliedMutation,
} from "./defects.js";

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
/** Outcome of the shared compile/sign/verify/publish/store path. */
type CommitOutcome =
  | {
      success: true;
      pubResult: Awaited<ReturnType<typeof publish>>;
      storeResult: Awaited<ReturnType<PublicationStore["store"]>>;
      manifestHash: string;
    }
  | { success: false; error: string };

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
/**
 * Outcome of the automatic approval configured on the administration settings
 * page. `applied` is false when neither the family nor the target list opted
 * in, which leaves the application in the ordinary manual review queue.
 */
export interface AutoApproveOutcome {
  applied: boolean;
  published: boolean;
  error?: string;
}

export class ApplicationService {
  readonly authoringStore: AuthoringStore;
  readonly publicationStore: PublicationStore;
  readonly signingConfig: SigningConfig | null | undefined;
  readonly settingsStore: SettingsStore | null | undefined;
  /** Injected in tests so no assessment reaches the network. */
  readonly inspectorClient: InspectorClient | null | undefined;
  private readonly listLocks = new Map<string, Promise<void>>();
  constructor(
    authoringStore: AuthoringStore,
    publicationStore: PublicationStore,
    signingConfig?: SigningConfig | null,
    settingsStore?: SettingsStore | null,
    inspectorClient?: InspectorClient | null,
  ) {
    this.authoringStore = authoringStore;
    this.publicationStore = publicationStore;
    this.signingConfig = signingConfig;
    this.settingsStore = settingsStore;
    this.inspectorClient = inspectorClient;
  }
  /**
   * Applies the administrator's auto-approve settings to a freshly submitted
   * application: it is approved and published in one step, bypassing the
   * manual Approve and Publish actions on the application detail page.
   */
  async autoApproveIfEnabled(
    app: TrustedEntityApplication,
  ): Promise<AutoApproveOutcome> {
    if (!this.settingsStore) return { applied: false, published: false };
    if (!this.settingsStore.isAutoApprove(app.family, app.targetListKey)) {
      return { applied: false, published: false };
    }
    const approved = this.approve(app.id);
    if (!approved.success) {
      return { applied: true, published: false, error: approved.error };
    }
    const published = await this.publishApplication(app.id);
    if (!published.success) {
      return { applied: true, published: false, error: published.error };
    }
    return { applied: true, published: true };
  }
  submitApplication<F extends EnabledProfileFamily = "wallet-providers">(
    formFields: SubmissionFields,
    targetListKey: string,
    family?: F,
  ): SubmissionParseResult {
    return parseAndValidateSubmission(formFields, targetListKey, family);
  }
  createApp<F extends EnabledProfileFamily = "wallet-providers">(
    targetListKey: string,
    applicantData: ApplicantDataByFamily[F],
    family?: F,
  ): ApplicationByFamily[F] {
    const app = createApplicationRecord(
      this.authoringStore.createId(),
      targetListKey,
      applicantData,
      family,
    );
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
    if (app.state === "published" || app.state === "withdrawn") {
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
    const candidateEntity = buildCandidateEntity(app, listIssueDateTime);
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
      /* clause 6.6.5: a carried-over service is restamped with this issue time. */
      restateServiceStatusTimes(
        existingEntities,
        listIssueDateTime,
        app.family,
      ),
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
      const committed = await this.compileSignAndStore(
        app.family,
        prepare.data,
        listEntry,
        app.targetListKey,
      );
      if (!committed.success) return committed;
      const { pubResult, manifestHash, storeResult } = committed;
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
  /**
   * Compiles, validates, signs, verifies, publishes, stores and assesses one
   * assembled list. Publication and withdrawal differ only in how the entities
   * were assembled, so the commit boundary itself is written once.
   */
  private async compileSignAndStore(
    family: EnabledProfileFamily,
    input: AuthoringInput,
    listEntry: SigningConfigEntry,
    targetListKey: string,
  ): Promise<CommitOutcome> {
    const compileResult = compileForProfile(family, input);
    /*
      A list declared broken stays broken for every version it emits. The defect
      selection lives on the signing configuration entry rather than being
      applied once at creation, so an entity registered later — a developer
      onboarding an Issuer or Verifier to test that their runtime rejects a bad
      list — is published through the same mutations.
    */
    const defects = normalizeDefectSelectionForStandard(
      listEntry.defects ?? [],
      "TS 119 602",
    );
    const broken = defects.length > 0;
    const etsiResult = await validateEtsiStruct(compileResult.document);
    if (!etsiResult.valid && !broken) {
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

    const signingTime = new Date();
    const preSign = broken
      ? applyPreSignDefects(compileResult.document, defects, {
          family,
          schemeTerritory: listEntry.schemeTerritory,
          distributionPointUri: listEntry.distributionPointUri,
          loTEType:
            compileResult.document.LoTE.ListAndSchemeInformation.LoTEType ?? "",
          schemeOperatorName: listEntry.schemeOperatorName,
          signingCertificateDer: certificateDerBase64(certPem),
        })
      : {
          document: compileResult.document,
          mutations: [] as AppliedMutation[],
        };

    const localValidationFailures: string[] = [];
    if (broken) {
      const mutatedEtsi = await validateEtsiStruct(preSign.document);
      if (!mutatedEtsi.valid)
        localValidationFailures.push(
          ...mutatedEtsi.findings.map((f) => `${f.path}: ${f.message}`),
        );
    }

    const signed = await signLote({
      document: preSign.document,
      key: signingKey,
      certificatePem: certPem,
      signingTime,
    });
    const postSign = broken
      ? await applyPostSignDefects(signed.compact, defects, {
          certificatePem: certPem,
          signingKey,
          document: preSign.document,
          signingTime,
          schemeOperatorName: listEntry.schemeOperatorName,
          schemeTerritory: listEntry.schemeTerritory,
        })
      : {
          compact: signed.compact,
          certificatePem: certPem,
          mutations: [] as AppliedMutation[],
        };
    const mutations = [...preSign.mutations, ...postSign.mutations];
    const unapplied = unappliedSelectedDefects(defects, mutations);
    if (unapplied.length > 0)
      return {
        success: false,
        error: `Selected defects were not applied: ${unapplied.join(", ")}.`,
      };
    const verifyResult = await verify({
      compactJws: postSign.compact,
      certificatePem: postSign.certificatePem,
    });
    if (!verifyResult.valid) {
      return { success: false, error: "Post-sign verification failed." };
    }
    const pubResult = await publish({
      compactJws: postSign.compact,
      certificatePem: postSign.certificatePem,
      allowInvalidStructure: broken,
    });
    if (pubResult.listKey !== targetListKey) {
      return {
        success: false,
        error: `Derived publication list key "${pubResult.listKey}" does not match target list key "${targetListKey}".`,
      };
    }
    const manifestJson = JSON.stringify(pubResult.manifest, null, 2);
    const storeResult = await this.publicationStore.store(
      pubResult,
      postSign.compact,
      pubResult.loteJson,
      manifestJson,
    );
    /*
      Every new or updated version is assessed by the Trust Inspector and the
      complete evaluation is stored next to it. An Inspector that cannot be
      reached does not fail the publication — it is recorded as unavailable,
      which the version page reports as such rather than as conformance.
    */
    const evaluation = await this.evaluateWithInspector(
      pubResult.listKey,
      pubResult.sequenceNumber,
      postSign.compact,
      preSign.document,
    );
    if (broken) {
      try {
        this.publicationStore.writeFixtureMetadata(
          pubResult.listKey,
          pubResult.sequenceNumber,
          JSON.stringify(
            buildFixtureMetadata(
              defects,
              mutations,
              [...localValidationFailures, ...pubResult.structuralFindings],
              evaluation?.summary.locallyDecidableFailures ?? [],
              signingTime,
              family,
            ),
            null,
            2,
          ),
        );
      } catch {
        /* evidence only; the published version is already committed */
      }
    }
    return {
      success: true,
      pubResult,
      storeResult,
      manifestHash: createHash("sha256").update(manifestJson).digest("hex"),
    };
  }

  /**
   * Withdraws a published Pub-EAA notification. The published version is never
   * rewritten: a new immutable version is added in which every service of this
   * provider reads `withdrawn` and its previous state is kept in ServiceHistory.
   */
  async withdrawApplication(
    id: string,
    clock: Date | undefined = undefined,
  ): Promise<ProfilePublishApplicationResult> {
    const app = this.getApplication(id);
    if (!app) return { success: false, error: "Application not found." };
    if (!getProfile(app.family).usesServiceStatus)
      return {
        success: false,
        error: `${getProfile(app.family).label} publish no service status, so an entity cannot be withdrawn. Remove it from the next version of the list instead.`,
      };
    if (!canTransition(app.state, "withdrawn"))
      return {
        success: false,
        error: `Cannot withdraw application in state: ${app.state}`,
      };
    return this.withListLock(app.targetListKey, () =>
      this.doWithdraw(app, clock),
    );
  }

  private async doWithdraw(
    app: TrustedEntityApplication,
    clock: Date | undefined,
  ): Promise<ProfilePublishApplicationResult> {
    const listEntry = this.resolveListConfig(app);
    if (!listEntry)
      return {
        success: false,
        error: `No signing configuration found for list key '${app.targetListKey}'. Check signing-config.`,
      };
    const profile = getProfile(app.family);
    const withdrawnStatus = profile.serviceStatuses?.withdrawn;
    if (!withdrawnStatus)
      return {
        success: false,
        error: `${profile.label} declare no withdrawn service status.`,
      };
    let latest;
    try {
      latest = await loadLatestPublication(
        this.publicationStore,
        app.targetListKey,
        app.family,
      );
    } catch (e) {
      return {
        success: false,
        error: `Cannot load latest publication: ${e instanceof Error ? e.message : "unknown"}`,
      };
    }
    if (!latest.exists)
      return { success: false, error: "No publications exist for this list." };

    /*
      The entity is identified by its Trusted Entity Name. Annex H services carry
      no unique identifier, and the name is the published identity the profile
      already ties the certificates to, so an ambiguous name is refused rather
      than resolved by position.
    */
    const name = app.applicantData.entityName;
    const matches = latest.entities.filter(
      (entity) => entity.teName[0]?.value === name,
    );
    if (matches.length === 0)
      return {
        success: false,
        error: `No published entity is named "${name}" in the latest version of this list.`,
      };
    if (matches.length > 1)
      return {
        success: false,
        error: `The latest version of this list has ${matches.length} entities named "${name}", so the one to withdraw cannot be identified.`,
      };
    const target = matches[0]!;

    const now = clock ?? new Date();
    const listIssueDateTime = now.toISOString();
    const statusStartingTime = toUtcDateTime(now);
    const nextUpdate = new Date(
      now.getTime() + 180 * 24 * 60 * 60 * 1000,
    ).toISOString();

    let withoutIdentity = 0;
    let withdrawn: AuthoringEntity;
    try {
      withdrawn = {
        ...target,
        services: target.services.map((service) => {
          /*
            The superseded state is published by key identifier only. A service
            with no certificate has no key to identify, so it changes status
            without a history instance rather than publishing one that states no
            X509SKI — which Annex H does not allow.
          */
          const skis = service.serviceDigitalIdentity.x509Certificates.map(
            (certificate) => subjectKeyIdentifierBase64(certificate),
          );
          if (skis.length === 0) withoutIdentity += 1;
          const previous: AuthoringServiceHistoryInstance[] =
            skis.length > 0 &&
            service.serviceStatus &&
            service.statusStartingTime
              ? [
                  {
                    serviceTypeIdentifier: service.serviceTypeIdentifier,
                    serviceName: service.serviceName,
                    x509Skis: skis,
                    serviceStatus: service.serviceStatus,
                    statusStartingTime: service.statusStartingTime,
                  },
                ]
              : [];
          /* Most recent superseded state first. */
          const history = [...previous, ...(service.serviceHistory ?? [])];
          return {
            ...service,
            serviceStatus: withdrawnStatus,
            statusStartingTime,
            ...(history.length > 0 ? { serviceHistory: history } : {}),
          };
        }),
      };
    } catch (e) {
      return {
        success: false,
        error: `Cannot derive the service key identifiers to publish in ServiceHistory: ${e instanceof Error ? e.message : "unknown"}`,
      };
    }

    const entities = restateServiceStatusTimes(
      latest.entities,
      listIssueDateTime,
      app.family,
    ).map((entity, index) =>
      latest.entities[index] === target ? withdrawn : entity,
    );
    const input = normalizeToAuthoringInput(
      app,
      schemeDescriptorFor(listEntry),
      listIssueDateTime,
      nextUpdate,
      latest.sequenceNumber + 1,
      entities,
    );

    try {
      const committed = await this.compileSignAndStore(
        app.family,
        input,
        listEntry,
        app.targetListKey,
      );
      if (!committed.success) return committed;
      const { pubResult, manifestHash, storeResult } = committed;
      const record: PublicationRecord = {
        listKey: pubResult.listKey,
        sequenceNumber: pubResult.sequenceNumber,
        manifestSha256: manifestHash,
        compactJadesSha256: pubResult.manifest.compactJadesSha256,
        publicationTimestamp: pubResult.manifest.publicationTimestamp,
      };
      app.state = "withdrawn";
      app.withdrawnAt = new Date().toISOString();
      app.withdrawal = record;
      try {
        this.authoringStore.save(app);
      } catch {
        return {
          success: false,
          code: "PUBLICATION_COMMITTED_APPLICATION_STALE",
          error: `The withdrawal was published for list key "${pubResult.listKey}" sequence ${pubResult.sequenceNumber} but the application record could not be updated.`,
          publication: record,
        };
      }
      const warnings = [
        storeResult.indexWarning,
        withoutIdentity > 0
          ? `${withoutIdentity} service${withoutIdentity > 1 ? "s" : ""} carried no certificate, so no ServiceHistory instance could state a key identifier for ${withoutIdentity > 1 ? "them" : "it"}.`
          : undefined,
      ].filter((warning): warning is string => Boolean(warning));
      return {
        success: true,
        data: app,
        message: `Notification withdrawn. Version ${pubResult.sequenceNumber} publishes every service of "${name}" as withdrawn and keeps the previous state in ServiceHistory.`,
        ...(warnings.length > 0 ? { warning: warnings.join(" ") } : {}),
      };
    } catch (e) {
      return {
        success: false,
        error: e instanceof Error ? e.message : "Withdrawal publication failed",
      };
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
    /*
      Reconciliation identifies the published entity by its complete service
      identifier set. Annex F/G services have no identifiers, so there is
      nothing to match on and the operation is refused rather than matching the
      first entity that also has none.
    */
    const candidateIdentifiers = data.services.map(
      (service) => service.serviceUniqueIdentifier,
    );
    if (candidateIdentifiers.some((identifier) => !identifier))
      return {
        success: false,
        error:
          "Reconciliation is not available for this family: its services carry no unique identifiers, so a published entity cannot be identified unambiguously.",
      };
    const candidateIds = new Set(candidateIdentifiers as string[]);
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

  /**
   * Submits the Compact JAdES artifact to the Trust Inspector and stores the
   * evaluation beside the version. Storage failures are swallowed for the same
   * reason as Inspector failures: the immutable publication already succeeded,
   * and a missing evaluation is reported as unavailable.
   */
  async evaluateWithInspector(
    listKey: string,
    sequenceNumber: number,
    compactJades: string,
    document: LoTEDocument,
  ): Promise<InspectorEvaluation> {
    const client = this.inspectorClient ?? new InspectorClient();
    const schemeInformation = document.LoTE.ListAndSchemeInformation;
    const evaluation = await client.assess({
      compactJades,
      source: `${listKey}/versions/${sequenceNumber}/lote.jades`,
      declared: {
        mimeType: "application/jose",
        loteType: schemeInformation.LoTEType,
        schemeOperatorName: schemeInformation.SchemeOperatorName[0]?.value,
        schemeTerritory: schemeInformation.SchemeTerritory,
      },
    });
    try {
      this.publicationStore.writeInspectorEvaluation(
        listKey,
        sequenceNumber,
        JSON.stringify(evaluation, null, 2),
      );
    } catch {
      /* the evaluation is evidence, not part of the published version */
    }
    return evaluation;
  }
}
/**
 * Only the entity is wanted here, so the scheme description is irrelevant and
 * left empty; the caller supplies the real one when the list is assembled.
 */
function buildCandidateEntity(
  app: TrustedEntityApplication,
  statusStartingTime: string,
): AuthoringEntity {
  return buildAuthoringEntity(app.applicantData, app.family, {
    statusStartingTime,
  });
}
function readFileString(path: string): string {
  return readFileSync(path, "utf-8");
}
