import {
  MAX_NEXT_UPDATE_MONTHS,
  SERVICE_TYPE_ISSUANCE,
  SERVICE_TYPE_REVOCATION,
  WALLET_PROVIDER_LOTE_TYPE,
  WALLET_PROVIDER_ROLE_URI_PREFIX,
  WALLET_PROVIDER_SCHEME_RULES,
  WALLET_PROVIDER_STATUS_DETN,
} from "./wallet-provider/constants.js";
import {
  PID_PROVIDER_LOTE_TYPE,
  PID_PROVIDER_ROLE_URI_PREFIX,
  PID_PROVIDER_SCHEME_RULES,
  PID_PROVIDER_STATUS_DETN,
  PID_SERVICE_TYPE_ISSUANCE,
  PID_SERVICE_TYPE_REVOCATION,
} from "./pid-provider/constants.js";
import {
  WRPAC_PROVIDER_LOTE_TYPE,
  WRPAC_PROVIDER_ROLE_URI_PREFIX,
  WRPAC_PROVIDER_SCHEME_RULES,
  WRPAC_PROVIDER_STATUS_DETN,
  WRPAC_SERVICE_TYPE_ISSUANCE,
  WRPAC_SERVICE_TYPE_REVOCATION,
} from "./wrpac-provider/constants.js";
import {
  WRPRC_PROVIDER_LOTE_TYPE,
  WRPRC_PROVIDER_ROLE_URI_PREFIX,
  WRPRC_PROVIDER_SCHEME_RULES,
  WRPRC_PROVIDER_STATUS_DETN,
  WRPRC_SERVICE_TYPE_ISSUANCE,
  WRPRC_SERVICE_TYPE_REVOCATION,
} from "./wrprc-provider/constants.js";

/**
 * The six families of List of Trusted Entities that TS 119 602 profiles. The
 * order is the order the standard's annexes and the catalogue present them.
 */
export type ProfileFamily =
  | "pid-providers"
  | "wallet-providers"
  | "wrpac-providers"
  | "wrprc-providers"
  | "pub-eaa-providers"
  | "registrars";
export type EnabledProfileFamily =
  "pid-providers" | "wallet-providers" | "wrpac-providers" | "wrprc-providers";

export interface TrustedEntityProfile {
  readonly family: ProfileFamily;
  readonly label: string;
  readonly enabled: boolean;
  readonly loTEType?: string;
  readonly statusDeterminationApproach?: string;
  readonly schemeRules?: string;
  readonly allowedServiceTypes: readonly string[];
  /** `<prefix>/<country code>` identifies the entity role; Annex D/E/F/G. */
  readonly roleUriPrefix?: string;
  readonly maxNextUpdateMonths?: number;
  /**
   * Annex D and Annex E require the ServiceUniqueIdentifier extension; Annex F
   * and Annex G do not use it, so the onboarding forms of those families do not
   * ask for one and the compiler emits no extension container.
   */
  readonly requiresServiceUniqueIdentifier: boolean;
  /**
   * The country the entity role URI names. `entity` is the entity's own
   * country (Annex E); `responsible-member-state` is the Member State that
   * supervises or mandates it (Annex D, F, G).
   */
  readonly roleCountrySource: "entity" | "responsible-member-state";
  readonly signatureProfile: "JAdES-Compact-B";
  readonly notImplementedNote?: string;
}

const disabled = (family: ProfileFamily, label: string): TrustedEntityProfile =>
  Object.freeze({
    family,
    label,
    enabled: false,
    allowedServiceTypes: Object.freeze([]),
    requiresServiceUniqueIdentifier: false,
    roleCountrySource: "entity" as const,
    signatureProfile: "JAdES-Compact-B",
    notImplementedNote: "Not implemented yet",
  });

export const PROFILE_REGISTRY: Readonly<
  Record<ProfileFamily, TrustedEntityProfile>
> = Object.freeze({
  "pid-providers": Object.freeze({
    family: "pid-providers",
    label: "PID Providers",
    enabled: true,
    loTEType: PID_PROVIDER_LOTE_TYPE,
    statusDeterminationApproach: PID_PROVIDER_STATUS_DETN,
    schemeRules: PID_PROVIDER_SCHEME_RULES,
    allowedServiceTypes: Object.freeze([
      PID_SERVICE_TYPE_ISSUANCE,
      PID_SERVICE_TYPE_REVOCATION,
    ]),
    roleUriPrefix: PID_PROVIDER_ROLE_URI_PREFIX,
    maxNextUpdateMonths: MAX_NEXT_UPDATE_MONTHS,
    requiresServiceUniqueIdentifier: true,
    roleCountrySource: "responsible-member-state",
    signatureProfile: "JAdES-Compact-B",
  }),
  "wallet-providers": Object.freeze({
    family: "wallet-providers",
    label: "Wallet Providers",
    enabled: true,
    loTEType: WALLET_PROVIDER_LOTE_TYPE,
    statusDeterminationApproach: WALLET_PROVIDER_STATUS_DETN,
    schemeRules: WALLET_PROVIDER_SCHEME_RULES,
    allowedServiceTypes: Object.freeze([
      SERVICE_TYPE_ISSUANCE,
      SERVICE_TYPE_REVOCATION,
    ]),
    roleUriPrefix: WALLET_PROVIDER_ROLE_URI_PREFIX,
    maxNextUpdateMonths: MAX_NEXT_UPDATE_MONTHS,
    requiresServiceUniqueIdentifier: true,
    roleCountrySource: "entity",
    signatureProfile: "JAdES-Compact-B",
  }),
  "wrpac-providers": Object.freeze({
    family: "wrpac-providers",
    label: "WRPAC Providers",
    enabled: true,
    loTEType: WRPAC_PROVIDER_LOTE_TYPE,
    statusDeterminationApproach: WRPAC_PROVIDER_STATUS_DETN,
    schemeRules: WRPAC_PROVIDER_SCHEME_RULES,
    allowedServiceTypes: Object.freeze([
      WRPAC_SERVICE_TYPE_ISSUANCE,
      WRPAC_SERVICE_TYPE_REVOCATION,
    ]),
    roleUriPrefix: WRPAC_PROVIDER_ROLE_URI_PREFIX,
    maxNextUpdateMonths: MAX_NEXT_UPDATE_MONTHS,
    requiresServiceUniqueIdentifier: false,
    roleCountrySource: "responsible-member-state",
    signatureProfile: "JAdES-Compact-B",
  }),
  "wrprc-providers": Object.freeze({
    family: "wrprc-providers",
    label: "WRPRC Providers",
    enabled: true,
    loTEType: WRPRC_PROVIDER_LOTE_TYPE,
    statusDeterminationApproach: WRPRC_PROVIDER_STATUS_DETN,
    schemeRules: WRPRC_PROVIDER_SCHEME_RULES,
    allowedServiceTypes: Object.freeze([
      WRPRC_SERVICE_TYPE_ISSUANCE,
      WRPRC_SERVICE_TYPE_REVOCATION,
    ]),
    roleUriPrefix: WRPRC_PROVIDER_ROLE_URI_PREFIX,
    maxNextUpdateMonths: MAX_NEXT_UPDATE_MONTHS,
    requiresServiceUniqueIdentifier: false,
    roleCountrySource: "responsible-member-state",
    signatureProfile: "JAdES-Compact-B",
  }),
  "pub-eaa-providers": disabled("pub-eaa-providers", "Pub-EAA Providers"),
  registrars: disabled("registrars", "Registrars and Registers"),
});

const ENABLED_FAMILIES: readonly EnabledProfileFamily[] = Object.freeze([
  "pid-providers",
  "wallet-providers",
  "wrpac-providers",
  "wrprc-providers",
]);

export function isEnabledProfileFamily(
  value: string,
): value is EnabledProfileFamily {
  return (ENABLED_FAMILIES as readonly string[]).includes(value);
}

export function parseProfileFamily(family: string): ProfileFamily | undefined {
  return Object.prototype.hasOwnProperty.call(PROFILE_REGISTRY, family)
    ? (family as ProfileFamily)
    : undefined;
}

export function getProfile(family: string): TrustedEntityProfile {
  const parsed = parseProfileFamily(family);
  if (!parsed) throw new Error(`Unknown list family: ${family}`);
  const profile = PROFILE_REGISTRY[parsed];
  if (!profile.enabled)
    throw new Error(`List family is not implemented: ${family}`);
  return profile;
}

export function getEnabledProfile(family: string): TrustedEntityProfile & {
  readonly family: EnabledProfileFamily;
  readonly enabled: true;
} {
  const profile = getProfile(family);
  if (!isEnabledProfileFamily(profile.family))
    throw new Error(`List family is not implemented: ${family}`);
  return profile as TrustedEntityProfile & {
    readonly family: EnabledProfileFamily;
    readonly enabled: true;
  };
}

export function profileForLoTEType(
  loTEType: string,
): TrustedEntityProfile | undefined {
  return Object.values(PROFILE_REGISTRY).find(
    (profile) => profile.loTEType === loTEType,
  );
}
