import { existsSync, readFileSync } from "node:fs";
import { X509Certificate } from "node:crypto";
import { parse as parseYaml } from "yaml";
import {
  getEnabledProfile,
  type EnabledProfileFamily,
} from "../profiles/registry.js";

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
}
export interface SigningConfig {
  lists: SigningConfigEntry[];
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
  };
}
export function loadSigningConfig(path: string): SigningConfig {
  if (!existsSync(path)) return { lists: [] };
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
  const lists = ((raw as Record<string, unknown>).lists as unknown[]).map(
    parseEntry,
  );
  const keys = new Set<string>();
  for (const entry of lists) {
    if (keys.has(entry.listKey))
      throw new Error(
        `Duplicate signing configuration list key: ${entry.listKey}`,
      );
    keys.add(entry.listKey);
  }
  return { lists };
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
