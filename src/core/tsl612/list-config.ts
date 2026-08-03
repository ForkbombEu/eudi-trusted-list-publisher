/**
 * The configuration of one TS 119 612 national Trusted List.
 *
 * It lives in the same `lists:` array of the same signing-configuration file as
 * the TS 119 602 entries, discriminated by `standard`. An entry that does not
 * state a standard is a TS 119 602 entry, so every configuration file written
 * before this existed keeps loading unchanged.
 *
 * The fields are the ones the compiler cannot invent: scheme operator identity
 * and address, the URIs the standard requires an operator to declare, the
 * stable URL the signed XML is published at, and the pointer material for the
 * EU LOTL. `allowedServiceProfiles` decides which onboarding families may be
 * listed here — one XML list may accept EAA, QEAA or both.
 */
import { isTslFamily, type TslFamily } from "./registry.js";
import {
  EU_LOTL_LOCATION,
  EU_LOTL_SCHEME_RULES,
  EU_LOTL_SCHEME_TERRITORY,
  EU_LOTL_TSL_TYPE,
  TSL_MEDIA_TYPE,
} from "./constants.js";

export const TRUSTED_LIST_STANDARD = "TS 119 612" as const;

export interface TrustedListLotlPointerConfig {
  readonly location: string;
  readonly certificatesBase64Der: readonly string[];
  readonly schemeOperatorNames: readonly string[];
  readonly schemeTypeCommunityRules: string;
  readonly schemeTerritory: string;
  readonly tslType: string;
  readonly mimeType: string;
}

export interface TrustedListConfigEntry {
  readonly standard: typeof TRUSTED_LIST_STANDARD;
  readonly listKey: string;
  readonly schemeOperatorName: string;
  readonly schemeOperatorStreet: string;
  readonly schemeOperatorLocality: string;
  readonly schemeOperatorPostalCode?: string;
  readonly schemeOperatorStateOrProvince?: string;
  readonly schemeOperatorCountry: string;
  readonly schemeOperatorEmail: string;
  readonly schemeOperatorWebsite: string;
  readonly schemeOperatorTelephone?: string;
  readonly schemeName: string;
  /** The responsible Member State; never `EU` for a Member State list. */
  readonly schemeTerritory: string;
  readonly schemeInformationUri: string;
  readonly nationalSchemeRulesUri: string;
  readonly policyUri: string;
  /** The stable URL the signed XML is published at. */
  readonly distributionPointUri: string;
  readonly lotlPointer: TrustedListLotlPointerConfig;
  readonly keyFile: string;
  readonly certFile: string;
  /** Which onboarding service profiles this list accepts. Never empty. */
  readonly allowedServiceProfiles: readonly TslFamily[];
}

/** The LOTL pointer defaults an operator normally keeps. */
export function defaultLotlPointer(
  certificatesBase64Der: readonly string[],
  schemeOperatorNames: readonly string[],
): TrustedListLotlPointerConfig {
  return {
    location: EU_LOTL_LOCATION,
    certificatesBase64Der,
    schemeOperatorNames,
    schemeTypeCommunityRules: EU_LOTL_SCHEME_RULES,
    schemeTerritory: EU_LOTL_SCHEME_TERRITORY,
    tslType: EU_LOTL_TSL_TYPE,
    mimeType: TSL_MEDIA_TYPE,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(
  record: Record<string, unknown>,
  field: string,
): string {
  const value = record[field];
  if (typeof value !== "string" || value.trim() === "")
    throw new Error(`Trusted List configuration entry is missing ${field}.`);
  return value;
}

function optionalString(
  record: Record<string, unknown>,
  field: string,
): { [key: string]: string } | Record<string, never> {
  const value = record[field];
  if (typeof value !== "string" || value.trim() === "") return {};
  return { [field]: value };
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0)
    throw new Error(
      `Trusted List configuration ${field} must be a non-empty array.`,
    );
  return value.map((entry) => {
    if (typeof entry !== "string" || entry.trim() === "")
      throw new Error(
        `Trusted List configuration ${field} entries must be non-empty strings.`,
      );
    return entry;
  });
}

function parseLotlPointer(value: unknown): TrustedListLotlPointerConfig {
  if (!isRecord(value))
    throw new Error("Trusted List configuration entry is missing lotlPointer.");
  return {
    location: requiredString(value, "location"),
    certificatesBase64Der: stringArray(
      value.certificatesBase64Der,
      "lotlPointer.certificatesBase64Der",
    ),
    schemeOperatorNames: stringArray(
      value.schemeOperatorNames,
      "lotlPointer.schemeOperatorNames",
    ),
    schemeTypeCommunityRules: requiredString(value, "schemeTypeCommunityRules"),
    schemeTerritory: requiredString(value, "schemeTerritory"),
    tslType: requiredString(value, "tslType"),
    mimeType: requiredString(value, "mimeType"),
  };
}

/** True when a raw configuration entry declares itself a TS 119 612 list. */
export function isTrustedListConfigRecord(value: unknown): boolean {
  return isRecord(value) && value.standard === TRUSTED_LIST_STANDARD;
}

export function parseTrustedListConfigEntry(
  value: unknown,
): TrustedListConfigEntry {
  if (!isRecord(value))
    throw new Error("Trusted List configuration entry must be an object.");
  const profiles = stringArray(
    value.allowedServiceProfiles,
    "allowedServiceProfiles",
  );
  for (const profile of profiles) {
    if (!isTslFamily(profile))
      throw new Error(
        `allowedServiceProfiles contains '${profile}', which is not a TS 119 612 service profile.`,
      );
  }
  const territory = requiredString(value, "schemeTerritory");
  if (territory === "EU")
    throw new Error(
      "A TS 119 612 Member State Trusted List states the responsible Member State as its Scheme Territory, not 'EU'.",
    );
  return {
    standard: TRUSTED_LIST_STANDARD,
    listKey: requiredString(value, "listKey"),
    schemeOperatorName: requiredString(value, "schemeOperatorName"),
    schemeOperatorStreet: requiredString(value, "schemeOperatorStreet"),
    schemeOperatorLocality: requiredString(value, "schemeOperatorLocality"),
    ...optionalString(value, "schemeOperatorPostalCode"),
    ...optionalString(value, "schemeOperatorStateOrProvince"),
    schemeOperatorCountry: requiredString(value, "schemeOperatorCountry"),
    schemeOperatorEmail: requiredString(value, "schemeOperatorEmail"),
    schemeOperatorWebsite: requiredString(value, "schemeOperatorWebsite"),
    ...optionalString(value, "schemeOperatorTelephone"),
    schemeName: requiredString(value, "schemeName"),
    schemeTerritory: territory,
    schemeInformationUri: requiredString(value, "schemeInformationUri"),
    nationalSchemeRulesUri: requiredString(value, "nationalSchemeRulesUri"),
    policyUri: requiredString(value, "policyUri"),
    distributionPointUri: requiredString(value, "distributionPointUri"),
    lotlPointer: parseLotlPointer(value.lotlPointer),
    keyFile: requiredString(value, "keyFile"),
    certFile: requiredString(value, "certFile"),
    allowedServiceProfiles: profiles as TslFamily[],
  };
}

/** Whether this list accepts applications for the given onboarding family. */
export function allowsServiceProfile(
  entry: TrustedListConfigEntry,
  family: string,
): boolean {
  return (entry.allowedServiceProfiles as readonly string[]).includes(family);
}
