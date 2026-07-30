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
import {
  PUB_EAA_HISTORICAL_INFORMATION_PERIOD,
  PUB_EAA_PROVIDER_LOTE_TYPE,
  PUB_EAA_PROVIDER_ROLE_URI_PREFIX,
  PUB_EAA_PROVIDER_SCHEME_RULES,
  PUB_EAA_PROVIDER_STATUS_DETN,
  PUB_EAA_SERVICE_TYPE_ISSUANCE,
  PUB_EAA_SERVICE_TYPE_REVOCATION,
  PUB_EAA_SVC_STATUS_NOTIFIED,
  PUB_EAA_SVC_STATUS_WITHDRAWN,
} from "./pub-eaa-provider/constants.js";

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
  | "pid-providers"
  | "wallet-providers"
  | "wrpac-providers"
  | "wrprc-providers"
  | "pub-eaa-providers";

export interface TrustedEntityProfile {
  readonly family: ProfileFamily;
  readonly label: string;
  readonly enabled: boolean;
  readonly loTEType?: string;
  readonly statusDeterminationApproach?: string;
  readonly schemeRules?: string;
  readonly allowedServiceTypes: readonly string[];
  /** `<prefix>/<country code>` identifies the entity role; Annex D–H. */
  readonly roleUriPrefix?: string;
  readonly maxNextUpdateMonths?: number;
  /**
   * Annex D and Annex E require the ServiceUniqueIdentifier extension; Annex F,
   * G and H do not use it, so the onboarding forms of those families do not ask
   * for one and the compiler emits no extension container.
   */
  readonly requiresServiceUniqueIdentifier: boolean;
  /**
   * The country the entity role URI names. `entity` is the entity's own
   * country (Annex E); `responsible-member-state` is the Member State that
   * supervises, mandates or notifies it (Annex D, F, G, H).
   */
  readonly roleCountrySource: "entity" | "responsible-member-state";
  /**
   * Annex H publishes a ServiceStatus and a StatusStartingTime per service, and
   * keeps the previous state in ServiceHistory. Annex D–G publish neither:
   * presence in the current version is the whole statement there.
   */
  readonly usesServiceStatus: boolean;
  /** The two status URIs, present only where `usesServiceStatus` is true. */
  readonly serviceStatuses?: {
    readonly notified: string;
    readonly withdrawn: string;
  };
  /** Annex H fixes HistoricalInformationPeriod; the others omit the component. */
  readonly historicalInformationPeriod?: number;
  /**
   * Annex D–G require the list to point at itself. Annex H requires
   * PointersToOtherLoTE to be absent, so the component is emitted per profile
   * rather than whenever signing certificates happen to be available.
   */
  readonly publishesSelfPointer: boolean;
  /**
   * Annex D–G require an X.509 service digital identity. Annex H makes it
   * optional: a notified provider may be listed before its attestation-signing
   * certificate is known.
   */
  readonly requiresServiceCertificate: boolean;
  /**
   * Annex H requires the Union or national act under which the attestations are
   * issued, as an `OJ:` URI.
   */
  readonly requiresLegalBasisReference: boolean;
  /** Collected "where available" by Annex F, G and H; never published. */
  readonly collectsRegistrationIdentifier: boolean;
  /** Annex F/G publish a further information page beside the policies URL. */
  readonly collectsAdditionalInformationUri: boolean;
  /**
   * Whether the entity role URI and the legal-basis reference are also
   * published in `TEElectronicAddress`.
   *
   * Annex D–G readers find the role URI in `TEInformationURI`, which is where
   * this publisher has always put it. The live Trust Inspector's Annex H entity
   * check reads the entity's URIs from `TEElectronicAddress` instead and reports
   * `countryRoleUriPresent: false` when the role URI appears only in
   * `TEInformationURI` — established by probing the running Inspector, the same
   * way the Annex G `WRPRCrovidersList` literal was. Annex H therefore publishes
   * both members; neither is wrong, and duplicating a URI costs a reader
   * nothing.
   */
  readonly entityUrisInElectronicAddress: boolean;
  /**
   * Annex F, G and H collect the provider's policies and terms URL where
   * Annex D/E collect an information page. Both occupy the same position in the
   * published list, so only the wording differs.
   */
  readonly informationUriIsPolicyUrl: boolean;
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
    usesServiceStatus: false,
    publishesSelfPointer: false,
    requiresServiceCertificate: false,
    requiresLegalBasisReference: false,
    collectsRegistrationIdentifier: false,
    collectsAdditionalInformationUri: false,
    entityUrisInElectronicAddress: false,
    informationUriIsPolicyUrl: false,
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
    usesServiceStatus: false,
    publishesSelfPointer: true,
    requiresServiceCertificate: true,
    requiresLegalBasisReference: false,
    collectsRegistrationIdentifier: false,
    collectsAdditionalInformationUri: false,
    entityUrisInElectronicAddress: false,
    informationUriIsPolicyUrl: false,
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
    usesServiceStatus: false,
    publishesSelfPointer: true,
    requiresServiceCertificate: true,
    requiresLegalBasisReference: false,
    collectsRegistrationIdentifier: false,
    collectsAdditionalInformationUri: false,
    entityUrisInElectronicAddress: false,
    informationUriIsPolicyUrl: false,
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
    usesServiceStatus: false,
    publishesSelfPointer: true,
    requiresServiceCertificate: true,
    requiresLegalBasisReference: false,
    collectsRegistrationIdentifier: true,
    collectsAdditionalInformationUri: true,
    entityUrisInElectronicAddress: false,
    informationUriIsPolicyUrl: true,
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
    usesServiceStatus: false,
    publishesSelfPointer: true,
    requiresServiceCertificate: true,
    requiresLegalBasisReference: false,
    collectsRegistrationIdentifier: true,
    collectsAdditionalInformationUri: true,
    entityUrisInElectronicAddress: false,
    informationUriIsPolicyUrl: true,
    signatureProfile: "JAdES-Compact-B",
  }),
  "pub-eaa-providers": Object.freeze({
    family: "pub-eaa-providers",
    label: "Pub-EAA Providers",
    enabled: true,
    loTEType: PUB_EAA_PROVIDER_LOTE_TYPE,
    statusDeterminationApproach: PUB_EAA_PROVIDER_STATUS_DETN,
    schemeRules: PUB_EAA_PROVIDER_SCHEME_RULES,
    allowedServiceTypes: Object.freeze([
      PUB_EAA_SERVICE_TYPE_ISSUANCE,
      PUB_EAA_SERVICE_TYPE_REVOCATION,
    ]),
    roleUriPrefix: PUB_EAA_PROVIDER_ROLE_URI_PREFIX,
    maxNextUpdateMonths: MAX_NEXT_UPDATE_MONTHS,
    requiresServiceUniqueIdentifier: false,
    roleCountrySource: "responsible-member-state",
    usesServiceStatus: true,
    serviceStatuses: Object.freeze({
      notified: PUB_EAA_SVC_STATUS_NOTIFIED,
      withdrawn: PUB_EAA_SVC_STATUS_WITHDRAWN,
    }),
    historicalInformationPeriod: PUB_EAA_HISTORICAL_INFORMATION_PERIOD,
    publishesSelfPointer: false,
    requiresServiceCertificate: false,
    requiresLegalBasisReference: true,
    collectsRegistrationIdentifier: true,
    collectsAdditionalInformationUri: false,
    entityUrisInElectronicAddress: true,
    informationUriIsPolicyUrl: true,
    signatureProfile: "JAdES-Compact-B",
  }),
  registrars: disabled("registrars", "Registrars and Registers"),
});

const ENABLED_FAMILIES: readonly EnabledProfileFamily[] = Object.freeze([
  "pid-providers",
  "wallet-providers",
  "wrpac-providers",
  "wrprc-providers",
  "pub-eaa-providers",
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
