import { existsSync, readFileSync } from "node:fs";
import { X509Certificate } from "node:crypto";
import { parse as parseYaml } from "yaml";
import {
  getEnabledProfile,
  type EnabledProfileFamily,
} from "../profiles/registry.js";
import {
  isTrustedListConfigRecord,
  parseTrustedListConfigEntry,
  type TrustedListConfigEntry,
} from "../tsl612/list-config.js";

export interface SigningConfigEntry {
  listKey: string;
  family: EnabledProfileFamily;
  schemeOperatorName: string;
  schemeOperatorStreet: string;
  schemeOperatorCountry: string;
  schemeName: string;
  schemeTerritory: string;
  schemeOperatorContactUri: string;
  distributionPointUri: string;
  keyFile: string;
  certFile: string;
  /*
    Annex D/E scheme information. The operator declares these once per list; the
    published list cannot be conformant without them, so they are required
    rather than defaulted to something plausible.
  */
  schemeOperatorEmail: string;
  schemeOperatorWebsite: string;
  schemeInformationUris: string[];
  policyUri: string;
  /**
   * Defect IDs this list is deliberately generated with. Absent or empty for an
   * ordinary list.
   *
   * The selection is stored on the list rather than applied once at creation so
   * that entities registered later — a developer onboarding an Issuer or
   * Verifier to test their runtime detection — are published through the same
   * mutations. A list declared broken stays broken for every version it emits.
   */
  defects?: string[];
}
/**
 * One configuration file, two standards.
 *
 * The file holds a single `lists:` array whose entries are discriminated by
 * `standard`. An entry that states no standard is a TS 119 602 entry, so every
 * file written before TS 119 612 existed loads unchanged and `config.lists`
 * still means exactly what it meant to its existing readers.
 */
export interface SigningConfig {
  /** TS 119 602 JSON/JAdES lists. */
  lists: SigningConfigEntry[];
  /**
   * TS 119 612 XML/XAdES Trusted Lists. Optional so that a configuration
   * object built in code — as several tests do — stays valid without it.
   */
  trustedLists?: TrustedListConfigEntry[];
}
export interface SigningConfigEntryDisplay {
  listKey: string;
  family: EnabledProfileFamily;
  configured: boolean;
  certificateSubject?: string;
  certificateFingerprint?: string;
}
interface SigningConfigReadEntry extends Omit<SigningConfigEntry, "family"> {
  family: string;
}
interface SigningConfigReadModel {
  lists: readonly SigningConfigReadEntry[];
}
const FIELDS = [
  "listKey",
  "family",
  "schemeOperatorName",
  "schemeOperatorStreet",
  "schemeOperatorCountry",
  "schemeName",
  "schemeTerritory",
  "schemeOperatorContactUri",
  "distributionPointUri",
  "keyFile",
  "certFile",
  "schemeOperatorEmail",
  "schemeOperatorWebsite",
  "policyUri",
] as const;

/** Annex D/E require at least two scheme information URIs. */
const MIN_SCHEME_INFORMATION_URIS = 2;

function uriListField(record: Record<string, unknown>): string[] {
  const value = record.schemeInformationUris;
  if (!Array.isArray(value))
    throw new Error(
      "Signing configuration entry is missing schemeInformationUris.",
    );
  const uris = value.map((entry) => {
    if (typeof entry !== "string" || !entry.trim())
      throw new Error(
        "schemeInformationUris entries must be non-empty strings.",
      );
    return entry;
  });
  if (uris.length < MIN_SCHEME_INFORMATION_URIS)
    throw new Error(
      `schemeInformationUris must list at least ${MIN_SCHEME_INFORMATION_URIS} URIs.`,
    );
  return uris;
}
function stringField(
  record: Record<string, unknown>,
  field: (typeof FIELDS)[number],
): string {
  const value = record[field];
  if (typeof value !== "string" || !value.trim())
    throw new Error(`Signing configuration entry is missing ${field}.`);
  return value;
}
function parseEntry(value: unknown): SigningConfigEntry {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Signing configuration entry must be an object.");
  const record = value as Record<string, unknown>;
  const family = stringField(record, "family");
  getEnabledProfile(family);
  return {
    listKey: stringField(record, "listKey"),
    family: family as EnabledProfileFamily,
    schemeOperatorName: stringField(record, "schemeOperatorName"),
    schemeOperatorStreet: stringField(record, "schemeOperatorStreet"),
    schemeOperatorCountry: stringField(record, "schemeOperatorCountry"),
    schemeName: stringField(record, "schemeName"),
    schemeTerritory: stringField(record, "schemeTerritory"),
    schemeOperatorContactUri: stringField(record, "schemeOperatorContactUri"),
    distributionPointUri: stringField(record, "distributionPointUri"),
    keyFile: stringField(record, "keyFile"),
    certFile: stringField(record, "certFile"),
    schemeOperatorEmail: stringField(record, "schemeOperatorEmail"),
    schemeOperatorWebsite: stringField(record, "schemeOperatorWebsite"),
    schemeInformationUris: uriListField(record),
    policyUri: stringField(record, "policyUri"),
    ...defectsField(record),
  };
}

/**
 * Optional, and read defensively: an unreadable defect selection must not stop
 * a list from loading, because the signing configuration is also what an
 * ordinary healthy list depends on.
 */
function defectsField(record: Record<string, unknown>): { defects?: string[] } {
  const value = record.defects;
  if (!Array.isArray(value)) return {};
  const defects = value.filter(
    (entry): entry is string =>
      typeof entry === "string" && entry.trim() !== "",
  );
  return defects.length > 0 ? { defects } : {};
}
export function loadSigningConfig(path: string): SigningConfig {
  if (!existsSync(path)) return { lists: [], trustedLists: [] };
  const raw: unknown =
    path.endsWith(".yaml") || path.endsWith(".yml")
      ? parseYaml(readFileSync(path, "utf-8"))
      : (JSON.parse(readFileSync(path, "utf-8")) as unknown);
  if (
    typeof raw !== "object" ||
    raw === null ||
    Array.isArray(raw) ||
    !Array.isArray((raw as Record<string, unknown>).lists)
  )
    throw new Error("Signing configuration must contain a lists array.");
  const entries = (raw as Record<string, unknown>).lists as unknown[];
  const lists = entries
    .filter((entry) => !isTrustedListConfigRecord(entry))
    .map(parseEntry);
  const trustedLists = entries
    .filter(isTrustedListConfigRecord)
    .map(parseTrustedListConfigEntry);

  /*
    List keys are unique across both standards, not within each. A key decides
    a directory under the publication root, and one directory cannot hold both
    a JSON list and an XML Trusted List.
  */
  const keys = new Set<string>();
  for (const entry of [...lists, ...trustedLists]) {
    if (keys.has(entry.listKey))
      throw new Error(
        `Duplicate signing configuration list key: ${entry.listKey}`,
      );
    keys.add(entry.listKey);
  }
  return { lists, trustedLists };
}

/** The TS 119 612 Trusted List with this key, if the configuration has one. */
export function findTrustedListConfig(
  config: { readonly trustedLists?: readonly TrustedListConfigEntry[] },
  listKey: string,
): TrustedListConfigEntry | undefined {
  return config.trustedLists?.find((entry) => entry.listKey === listKey);
}

/** Every XML Trusted List that accepts applications for one onboarding family. */
export function getTrustedListConfigsForFamily(
  config: { readonly trustedLists?: readonly TrustedListConfigEntry[] },
  family: string,
): TrustedListConfigEntry[] {
  return (config.trustedLists ?? []).filter((entry) =>
    (entry.allowedServiceProfiles as readonly string[]).includes(family),
  );
}
export function findSigningConfig(
  config: SigningConfigReadModel,
  listKey: string,
): SigningConfigEntry | undefined {
  const entry = config.lists.find((candidate) => candidate.listKey === listKey);
  if (!entry) return undefined;
  getEnabledProfile(entry.family);
  return entry as SigningConfigEntry;
}
export function getWalletProviderConfigs(
  config: SigningConfig,
): SigningConfigEntry[] {
  return getFamilyConfigs(config, "wallet-providers");
}
export function getFamilyConfigs(
  config: SigningConfig,
  family: EnabledProfileFamily,
): SigningConfigEntry[] {
  getEnabledProfile(family);
  return config.lists.filter((entry) => entry.family === family);
}
export function signingConfigDisplay(
  config: SigningConfigReadModel,
): SigningConfigEntryDisplay[] {
  return config.lists.flatMap((entry) => {
    try {
      const family = getEnabledProfile(entry.family).family;
      let certificateSubject: string | undefined;
      let certificateFingerprint: string | undefined;
      if (existsSync(entry.certFile)) {
        try {
          const certificate = new X509Certificate(
            readFileSync(entry.certFile, "utf-8"),
          );
          certificateSubject = certificate.subject.replace(/\n/g, ", ");
          certificateFingerprint = certificate.fingerprint256
            .replace(/:/g, "")
            .toLowerCase();
        } catch {
          /* configuration status remains false */
        }
      }
      return [
        {
          listKey: entry.listKey,
          family,
          configured: existsSync(entry.certFile) && existsSync(entry.keyFile),
          certificateSubject,
          certificateFingerprint,
        },
      ];
    } catch {
      return [];
    }
  });
}
export function loadSigningKey(certFile: string): string {
  return readFileSync(certFile, "utf-8");
}
