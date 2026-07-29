import {
  MAX_NEXT_UPDATE_MONTHS,
  SERVICE_TYPE_ISSUANCE,
  SERVICE_TYPE_REVOCATION,
  WALLET_PROVIDER_LOTE_TYPE,
  WALLET_PROVIDER_SCHEME_RULES,
  WALLET_PROVIDER_STATUS_DETN,
} from "./wallet-provider/constants.js";
import {
  PID_PROVIDER_LOTE_TYPE,
  PID_PROVIDER_SCHEME_RULES,
  PID_PROVIDER_STATUS_DETN,
  PID_SERVICE_TYPE_ISSUANCE,
  PID_SERVICE_TYPE_REVOCATION,
} from "./pid-provider/constants.js";

export type ProfileFamily =
  | "wallet-providers"
  | "pid-providers"
  | "non-qualified-eaa-providers"
  | "qeaa-providers"
  | "wrpac-providers"
  | "wrprc-providers"
  | "registrars";
export type EnabledProfileFamily = "wallet-providers" | "pid-providers";

export interface TrustedEntityProfile {
  readonly family: ProfileFamily;
  readonly label: string;
  readonly enabled: boolean;
  readonly loTEType?: string;
  readonly statusDeterminationApproach?: string;
  readonly schemeRules?: string;
  readonly allowedServiceTypes: readonly string[];
  readonly maxNextUpdateMonths?: number;
  readonly signatureProfile: "JAdES-Compact-B";
  readonly notImplementedNote?: string;
}

const disabled = (family: ProfileFamily, label: string): TrustedEntityProfile =>
  Object.freeze({
    family,
    label,
    enabled: false,
    allowedServiceTypes: Object.freeze([]),
    signatureProfile: "JAdES-Compact-B",
    notImplementedNote: "Not implemented yet",
  });

export const PROFILE_REGISTRY: Readonly<Record<ProfileFamily, TrustedEntityProfile>> =
  Object.freeze({
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
      maxNextUpdateMonths: MAX_NEXT_UPDATE_MONTHS,
      signatureProfile: "JAdES-Compact-B",
    }),
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
      maxNextUpdateMonths: MAX_NEXT_UPDATE_MONTHS,
      signatureProfile: "JAdES-Compact-B",
    }),
    "non-qualified-eaa-providers": disabled(
      "non-qualified-eaa-providers",
      "Non-qualified EAA Providers",
    ),
    "qeaa-providers": disabled("qeaa-providers", "QEAA Providers"),
    "wrpac-providers": disabled(
      "wrpac-providers",
      "WRPAC / Access CA Providers",
    ),
    "wrprc-providers": disabled("wrprc-providers", "WRPRC Providers"),
    registrars: disabled("registrars", "Registrars"),
  });

export function parseProfileFamily(family: string): ProfileFamily | undefined {
  return Object.prototype.hasOwnProperty.call(PROFILE_REGISTRY, family)
    ? (family as ProfileFamily)
    : undefined;
}

export function getProfile(family: string): TrustedEntityProfile {
  const parsed = parseProfileFamily(family);
  if (!parsed) throw new Error(`Unknown list family: ${family}`);
  const profile = PROFILE_REGISTRY[parsed];
  if (!profile.enabled) throw new Error(`List family is not implemented: ${family}`);
  return profile;
}

export function getEnabledProfile(family: string): TrustedEntityProfile & { readonly family: EnabledProfileFamily; readonly enabled: true } {
  const profile = getProfile(family);
  if (profile.family !== "wallet-providers" && profile.family !== "pid-providers") throw new Error(`List family is not implemented: ${family}`);
  return profile as TrustedEntityProfile & { readonly family: EnabledProfileFamily; readonly enabled: true };
}

export function profileForLoTEType(loTEType: string): TrustedEntityProfile | undefined {
  return Object.values(PROFILE_REGISTRY).find((profile) => profile.loTEType === loTEType);
}
