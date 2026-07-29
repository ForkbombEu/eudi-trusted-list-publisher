import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomBytes, randomUUID, X509Certificate } from "node:crypto";
import { resolve } from "node:path";
import {
  APPLICATION_SCHEMA_VERSION,
  type ApplicationState,
  type CommonApplicantData,
  type PIDProviderApplicantData,
  type PIDProviderApplication,
  type PublicationRecord,
  type TrustedEntityApplication,
  type WalletProviderApplicantData,
  type WalletProviderApplication,
} from "./application-model.js";
import { getEnabledProfile } from "../profiles/registry.js";

export interface AuthoringStoreConfig {
  authoringDir: string;
}
const SAFE_ID = /^[a-f0-9-]{32,128}$/;
const SAFE_LIST_KEY = /^[a-z0-9][a-z0-9_]{0,99}$/;
const STATES: readonly ApplicationState[] = [
  "submitted",
  "approved",
  "rejected",
  "published",
];
type RecordValue = Record<string, unknown>;
const isRecord = (value: unknown): value is RecordValue =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isIso = (value: unknown): value is string =>
  typeof value === "string" && !Number.isNaN(Date.parse(value));
const isString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;
const isApplicationState = (value: unknown): value is ApplicationState =>
  typeof value === "string" && STATES.includes(value as ApplicationState);

function validApplicantData(
  value: unknown,
  family: "wallet-providers",
): value is WalletProviderApplicantData;
function validApplicantData(
  value: unknown,
  family: "pid-providers",
): value is PIDProviderApplicantData;
function validApplicantData(
  value: unknown,
  family: "wallet-providers" | "pid-providers",
): value is CommonApplicantData {
  if (
    !isRecord(value) ||
    !isString(value.entityName) ||
    !isString(value.entityStreetAddress) ||
    !isString(value.entityCountry) ||
    !/^[A-Z]{2}$/.test(value.entityCountry) ||
    !isString(value.entityInformationURI)
  )
    return false;
  try {
    new URL(value.entityInformationURI);
  } catch {
    return false;
  }
  if (!Array.isArray(value.services) || value.services.length === 0)
    return false;
  for (const service of value.services) {
    if (
      !isRecord(service) ||
      (service.serviceType !== "issuance" &&
        service.serviceType !== "revocation") ||
      !isString(service.serviceName) ||
      !isString(service.certificatePem) ||
      !isString(service.serviceUniqueIdentifier)
    )
      return false;
    try {
      new X509Certificate(service.certificatePem);
      new URL(service.serviceUniqueIdentifier);
    } catch {
      return false;
    }
  }
  return (
    family !== "pid-providers" ||
    (isString(value.responsibleMemberState) &&
      /^[A-Z]{2}$/.test(value.responsibleMemberState))
  );
}

function parsePublication(
  value: unknown,
  listKey: string,
): PublicationRecord | null {
  if (
    !isRecord(value) ||
    !isString(value.listKey) ||
    value.listKey !== listKey ||
    typeof value.sequenceNumber !== "number" ||
    !Number.isInteger(value.sequenceNumber) ||
    value.sequenceNumber < 1 ||
    !isString(value.manifestSha256) ||
    !/^[a-f0-9]{64}$/i.test(value.manifestSha256) ||
    !isString(value.compactJadesSha256) ||
    !/^[a-f0-9]{64}$/i.test(value.compactJadesSha256) ||
    !isIso(value.publicationTimestamp)
  )
    return null;
  return {
    listKey: value.listKey,
    sequenceNumber: value.sequenceNumber,
    manifestSha256: value.manifestSha256,
    compactJadesSha256: value.compactJadesSha256,
    publicationTimestamp: value.publicationTimestamp,
  };
}

function parseApplication(
  value: unknown,
  expectedId: string,
): TrustedEntityApplication | null {
  if (
    !isRecord(value) ||
    value.id !== expectedId ||
    !SAFE_ID.test(expectedId) ||
    value.schemaVersion !== APPLICATION_SCHEMA_VERSION ||
    !isString(value.targetListKey) ||
    !SAFE_LIST_KEY.test(value.targetListKey) ||
    !isIso(value.submittedAt) ||
    !isApplicationState(value.state)
  )
    return null;
  if (value.family !== "wallet-providers" && value.family !== "pid-providers")
    return null;
  try {
    getEnabledProfile(value.family);
  } catch {
    return null;
  }
  if (value.approvedAt !== undefined && !isIso(value.approvedAt)) return null;
  if (value.rejectedAt !== undefined && !isIso(value.rejectedAt)) return null;
  if (value.adminNote !== undefined && !isString(value.adminNote)) return null;
  const publication =
    value.publication === undefined
      ? undefined
      : parsePublication(value.publication, value.targetListKey);
  if (value.publication !== undefined && publication === null) return null;
  if (
    (value.state === "submitted" &&
      (value.approvedAt !== undefined ||
        value.rejectedAt !== undefined ||
        value.adminNote !== undefined ||
        publication !== undefined)) ||
    (value.state === "approved" &&
      (value.approvedAt === undefined ||
        value.rejectedAt !== undefined ||
        value.adminNote !== undefined ||
        publication !== undefined)) ||
    (value.state === "rejected" &&
      (value.approvedAt !== undefined ||
        value.rejectedAt === undefined ||
        value.adminNote === undefined ||
        publication !== undefined)) ||
    (value.state === "published" &&
      (value.approvedAt === undefined ||
        value.rejectedAt !== undefined ||
        value.adminNote !== undefined ||
        publication === undefined))
  )
    return null;
  const common = {
    id: expectedId,
    schemaVersion: 1 as const,
    targetListKey: value.targetListKey,
    state: value.state,
    submittedAt: value.submittedAt,
    ...(typeof value.adminNote === "string"
      ? { adminNote: value.adminNote }
      : {}),
    ...(typeof value.approvedAt === "string"
      ? { approvedAt: value.approvedAt }
      : {}),
    ...(typeof value.rejectedAt === "string"
      ? { rejectedAt: value.rejectedAt }
      : {}),
    ...(publication ? { publication } : {}),
  };
  if (value.family === "pid-providers") {
    if (!validApplicantData(value.applicantData, "pid-providers")) return null;
    const application: PIDProviderApplication = {
      ...common,
      family: "pid-providers",
      applicantData: value.applicantData,
    };
    return application;
  }
  if (!validApplicantData(value.applicantData, "wallet-providers")) return null;
  const application: WalletProviderApplication = {
    ...common,
    family: "wallet-providers",
    applicantData: value.applicantData,
  };
  return application;
}

export class AuthoringStore {
  readonly authoringDir: string;
  private readonly canonicalRoot: string;
  constructor(config: AuthoringStoreConfig) {
    const root = resolve(config.authoringDir);
    if (!existsSync(root)) mkdirSync(root, { recursive: true });
    if (lstatSync(root).isSymbolicLink())
      throw new Error("Authoring root is a symlink — rejected for security");
    this.authoringDir = root;
    this.canonicalRoot = realpathSync(root);
  }
  private appPath(id: string): string {
    if (!SAFE_ID.test(id)) throw new Error(`Unsafe application ID: "${id}"`);
    return resolve(this.canonicalRoot, `${id}.json`);
  }
  private assertCanonicalRoot(): void {
    if (
      !existsSync(this.canonicalRoot) ||
      realpathSync(this.canonicalRoot) !== this.canonicalRoot
    )
      throw new Error("Authoring root was redirected — canonical root changed");
  }
  save(application: TrustedEntityApplication): void {
    this.assertCanonicalRoot();
    if (!parseApplication(application, application.id))
      throw new Error("Cannot save invalid application.");
    const path = this.appPath(application.id);
    const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(application, null, 2), {
        encoding: "utf-8",
        flag: "wx",
      });
      renameSync(temporary, path);
    } catch (error: unknown) {
      if (existsSync(temporary)) unlinkSync(temporary);
      throw error;
    }
  }
  load(id: string): TrustedEntityApplication | null {
    this.assertCanonicalRoot();
    const path = this.appPath(id);
    if (!existsSync(path) || lstatSync(path).isSymbolicLink()) return null;
    try {
      return parseApplication(
        JSON.parse(readFileSync(path, "utf-8")) as unknown,
        id,
      );
    } catch {
      return null;
    }
  }
  delete(id: string): boolean {
    this.assertCanonicalRoot();
    if (!this.load(id)) return false;
    unlinkSync(this.appPath(id));
    return true;
  }
  list(): TrustedEntityApplication[] {
    this.assertCanonicalRoot();
    return readdirSync(this.canonicalRoot, { withFileTypes: true })
      .flatMap((entry) => {
        if (!entry.isFile() || !entry.name.endsWith(".json")) return [];
        const id = entry.name.slice(0, -5);
        return SAFE_ID.test(id)
          ? [this.load(id)].filter(
              (app): app is TrustedEntityApplication => app !== null,
            )
          : [];
      })
      .sort((left, right) => left.submittedAt.localeCompare(right.submittedAt));
  }
  createId(): string {
    return randomUUID();
  }
}
