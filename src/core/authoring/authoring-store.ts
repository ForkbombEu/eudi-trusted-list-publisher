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
  type PublicationRecord,
  type TrustedEntityApplication,
} from "./application-model.js";
import {
  getEnabledProfile,
  isEnabledProfileFamily,
  type EnabledProfileFamily,
} from "../profiles/registry.js";

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
const ISO_UTC = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?Z$/;
const isIso = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  const match = ISO_UTC.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] =
    match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59)
    return false;
  const daysInMonth = [
    31,
    year % 400 === 0 || (year % 4 === 0 && year % 100 !== 0) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  const maximumDay = daysInMonth[month - 1];
  return maximumDay !== undefined && day >= 1 && day <= maximumDay;
};
const isString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;
const isApplicationState = (value: unknown): value is ApplicationState =>
  typeof value === "string" && STATES.includes(value as ApplicationState);

const isUrlString = (value: unknown): boolean => {
  if (!isString(value)) return false;
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
};
const isMemberState = (value: unknown): boolean =>
  isString(value) && /^[A-Z]{2}$/.test(value);

/**
 * Validates a stored applicant record against the family it claims. The family
 * decides which fields must be present: Annex D/E require a service unique
 * identifier and Annex F/G must not carry one, so a record written by a
 * different version of the form is rejected rather than half-read.
 */
function validApplicantData(
  value: unknown,
  family: EnabledProfileFamily,
): value is CommonApplicantData {
  const profile = getEnabledProfile(family);
  const relyingParty =
    family === "wrpac-providers" || family === "wrprc-providers";
  const supervised = profile.roleCountrySource === "responsible-member-state";
  if (
    !isRecord(value) ||
    !isString(value.entityName) ||
    !isString(value.entityStreetAddress) ||
    !isMemberState(value.entityCountry) ||
    !isUrlString(value.entityInformationURI)
  )
    return false;
  if (!Array.isArray(value.services) || value.services.length === 0)
    return false;
  for (const service of value.services) {
    if (
      !isRecord(service) ||
      (service.serviceType !== "issuance" &&
        service.serviceType !== "revocation") ||
      !isString(service.serviceName) ||
      !isString(service.certificatePem)
    )
      return false;
    if (profile.requiresServiceUniqueIdentifier) {
      if (!isUrlString(service.serviceUniqueIdentifier)) return false;
    } else if (service.serviceUniqueIdentifier !== undefined) return false;
    try {
      new X509Certificate(service.certificatePem);
    } catch {
      return false;
    }
  }
  if (supervised && !isMemberState(value.responsibleMemberState)) return false;
  if (!supervised && value.responsibleMemberState !== undefined) return false;
  if (!relyingParty)
    return (
      value.registrationIdentifier === undefined &&
      value.additionalInformationURI === undefined
    );
  if (
    value.registrationIdentifier !== undefined &&
    !isString(value.registrationIdentifier)
  )
    return false;
  return (
    value.additionalInformationURI === undefined ||
    isUrlString(value.additionalInformationURI)
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
  if (typeof value.family !== "string" || !isEnabledProfileFamily(value.family))
    return null;
  const family: EnabledProfileFamily = value.family;
  try {
    getEnabledProfile(family);
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
  if (!validApplicantData(value.applicantData, family)) return null;
  /*
    Every family shares the record shape; only the applicant data differs, and
    it has just been validated against this family, so the record can be
    restated as the family's application type.
  */
  return {
    ...common,
    family,
    applicantData: value.applicantData,
  } as TrustedEntityApplication;
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
      try {
        if (existsSync(temporary)) unlinkSync(temporary);
      } catch {
        // Preserve the original write or rename failure.
      }
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
