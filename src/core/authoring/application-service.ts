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

export class ApplicationService {
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
      return {
        success: false,
        error: "Rejection note is required.",
      };
    }
    app.state = "rejected";
    app.rejectedAt = new Date().toISOString();
    app.adminNote = trimmed;
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

  prepareCompilerInput(
    app: WalletProviderApplication,
    listIssueDateTime: string,
    nextUpdate: string,
    sequenceNumber: number,
  ) {
    const entry = this.resolveListConfig(app);
    if (!entry) {
      return {
        success: false as const,
        error: `No signing configuration found for list key '${app.targetListKey}'.`,
      };
    }
    const input = normalizeToAuthoringInput(
      app,
      entry.schemeOperatorName,
      entry.schemeName,
      entry.schemeTerritory,
      {
        streetAddress: entry.schemeOperatorStreet,
        country: entry.schemeOperatorCountry,
      },
      entry.schemeOperatorContactUri,
      entry.distributionPointUri,
      listIssueDateTime,
      nextUpdate,
      sequenceNumber,
    );
    return { success: true as const, data: input, entry };
  }

  async publishApplication(
    id: string,
  ): Promise<ServiceResult<WalletProviderApplication>> {
    const app = this.getApplication(id);
    if (!app) return { success: false, error: "Application not found." };
    if (!canTransition(app.state, "published")) {
      return {
        success: false,
        error: `Cannot publish application in state: ${app.state}`,
      };
    }

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

    const now = new Date();
    const listIssueDateTime = now.toISOString();
    const nextUpdate = new Date(
      now.getTime() + 180 * 24 * 60 * 60 * 1000,
    ).toISOString();

    let nextSeq = 1;
    try {
      const existingIndex = await this.publicationStore.loadIndex(
        app.targetListKey,
      );
      if (existingIndex && existingIndex.versions.length > 0) {
        nextSeq =
          existingIndex.versions[existingIndex.versions.length - 1]!
            .sequenceNumber + 1;
      }
    } catch {
      /* use default 1 */
    }

    const prepare = this.prepareCompilerInput(
      app,
      listIssueDateTime,
      nextUpdate,
      nextSeq,
    );
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
        return {
          success: false,
          error: `ETSI validation failed: ${reasons}`,
        };
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
        return {
          success: false,
          error: "Post-sign verification failed.",
        };
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
      this.authoringStore.save(app);

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

  async preview(app: WalletProviderApplication): Promise<{
    compilerInput: AuthoringInput | null;
    compilerInputJson: string | null;
    etsiValid: boolean | null;
    etsiFindings: ValidationFinding[];
    error?: string;
  }> {
    const listEntry = this.resolveListConfig(app);
    if (!listEntry) {
      return {
        compilerInput: null,
        compilerInputJson: null,
        etsiValid: null,
        etsiFindings: [],
        error: `No signing configuration found for list key '${app.targetListKey}'.`,
      };
    }

    try {
      const now = new Date();
      let nextSeq = 1;
      const existingIndex = await this.publicationStore.loadIndex(
        app.targetListKey,
      );
      if (existingIndex && existingIndex.versions.length > 0) {
        nextSeq =
          existingIndex.versions[existingIndex.versions.length - 1]!
            .sequenceNumber + 1;
      }

      const input = normalizeToAuthoringInput(
        app,
        listEntry.schemeOperatorName,
        listEntry.schemeName,
        listEntry.schemeTerritory,
        {
          streetAddress: listEntry.schemeOperatorStreet,
          country: listEntry.schemeOperatorCountry,
        },
        listEntry.schemeOperatorContactUri,
        listEntry.distributionPointUri,
        now.toISOString(),
        new Date(now.getTime() + 180 * 24 * 60 * 60 * 1000).toISOString(),
        nextSeq,
      );
      const compilerInputJson = JSON.stringify(input, null, 2);
      const { document } = compile(input);
      const etsiResult = await validateEtsiStruct(document);
      return {
        compilerInput: input,
        compilerInputJson,
        etsiValid: etsiResult.valid,
        etsiFindings: etsiResult.findings,
      };
    } catch (e) {
      return {
        compilerInput: null,
        compilerInputJson: null,
        etsiValid: null,
        etsiFindings: [],
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

  getSigningConfig(): SigningConfig | null {
    return this.signingConfig;
  }
}

import { readFileSync } from "node:fs";

function readFileString(path: string): string {
  return readFileSync(path, "utf-8");
}
