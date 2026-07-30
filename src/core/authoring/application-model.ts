import type { AuthoringEntity, AuthoringInput } from "../model/authoring.js";
import {
  getProfile,
  isEnabledProfileFamily,
  type EnabledProfileFamily,
  type ProfileFamily,
} from "../profiles/registry.js";
import {
  PID_SERVICE_TYPE_ISSUANCE,
  PID_SERVICE_TYPE_REVOCATION,
} from "../profiles/pid-provider/constants.js";
import {
  SERVICE_TYPE_ISSUANCE,
  SERVICE_TYPE_REVOCATION,
} from "../profiles/wallet-provider/constants.js";
import {
  WRPAC_SERVICE_TYPE_ISSUANCE,
  WRPAC_SERVICE_TYPE_REVOCATION,
} from "../profiles/wrpac-provider/constants.js";
import {
  WRPRC_SERVICE_TYPE_ISSUANCE,
  WRPRC_SERVICE_TYPE_REVOCATION,
} from "../profiles/wrprc-provider/constants.js";
import {
  certificateDerBase64,
  mailtoUri,
  roleUri,
  telUri,
} from "../model/lexical.js";

export const APPLICATION_SCHEMA_VERSION = 1;
export type ApplicationState =
  "submitted" | "approved" | "rejected" | "published";
export type ServiceKind = "issuance" | "revocation";
export interface ProviderServiceInput {
  serviceType: ServiceKind;
  serviceName: string;
  certificatePem: string;
  /** Annex D/E only; Annex F/G services carry no unique identifier. */
  serviceUniqueIdentifier?: string;
}
export interface CommonApplicantData {
  entityName: string;
  entityTradeName?: string;
  entityStreetAddress: string;
  entityLocality?: string;
  entityPostalCode?: string;
  entityCountry: string;
  /**
   * The entity's public HTTP(S) URI. Annex D/E collect it as the entity's
   * information page; Annex F/G collect the provider's policies and terms URL,
   * which serves the same purpose in the published list.
   */
  entityInformationURI: string;
  /**
   * Annex D/E/F/G require a trusted entity to be contactable by email and
   * telephone as well as by its information page.
   */
  entityEmail: string;
  entityTelephone: string;
  services: ProviderServiceInput[];
}
export interface WalletProviderApplicantData extends CommonApplicantData {}
/**
 * Families whose entity role URI names a supervising or mandating Member State
 * rather than the entity's own country.
 */
export interface SupervisedApplicantData extends CommonApplicantData {
  responsibleMemberState: string;
}
export interface PIDProviderApplicantData extends SupervisedApplicantData {}
/**
 * Annex F (WRPAC) and Annex G (WRPRC) providers. Both carry the same applicant
 * data: the mandating Member State, the provider's official registration
 * identifier where one exists, the policies and terms URL in
 * `entityInformationURI`, and an optional further information page.
 */
export interface WalletRelyingPartyApplicantData extends SupervisedApplicantData {
  /** Official registration identifier, where available. */
  registrationIdentifier?: string;
  /** Optional additional information page, published beside the policies URL. */
  additionalInformationURI?: string;
}
export interface PublicationRecord {
  listKey: string;
  sequenceNumber: number;
  manifestSha256: string;
  compactJadesSha256: string;
  publicationTimestamp: string;
}
interface ApplicationBase<
  F extends EnabledProfileFamily,
  D extends CommonApplicantData,
> {
  id: string;
  schemaVersion: 1;
  family: F;
  targetListKey: string;
  state: ApplicationState;
  submittedAt: string;
  applicantData: D;
  adminNote?: string;
  approvedAt?: string;
  rejectedAt?: string;
  publication?: PublicationRecord;
}
export type WalletProviderApplication = ApplicationBase<
  "wallet-providers",
  WalletProviderApplicantData
>;
export type PIDProviderApplication = ApplicationBase<
  "pid-providers",
  PIDProviderApplicantData
>;
export type WRPACProviderApplication = ApplicationBase<
  "wrpac-providers",
  WalletRelyingPartyApplicantData
>;
export type WRPRCProviderApplication = ApplicationBase<
  "wrprc-providers",
  WalletRelyingPartyApplicantData
>;
export type TrustedEntityApplication =
  | WalletProviderApplication
  | PIDProviderApplication
  | WRPACProviderApplication
  | WRPRCProviderApplication;
export type WalletProviderServiceInput = ProviderServiceInput;

/** Applicant data shapes any enabled family can produce. */
export type AnyApplicantData =
  | WalletProviderApplicantData
  | PIDProviderApplicantData
  | WalletRelyingPartyApplicantData;

/**
 * The applicant data and application type each family works with. Keying them
 * by family lets one generic parse-and-create path serve all four families
 * while callers keep the precise type of the family they asked for.
 */
export interface ApplicantDataByFamily {
  "wallet-providers": WalletProviderApplicantData;
  "pid-providers": PIDProviderApplicantData;
  "wrpac-providers": WalletRelyingPartyApplicantData;
  "wrprc-providers": WalletRelyingPartyApplicantData;
}
export interface ApplicationByFamily {
  "wallet-providers": WalletProviderApplication;
  "pid-providers": PIDProviderApplication;
  "wrpac-providers": WRPACProviderApplication;
  "wrprc-providers": WRPRCProviderApplication;
}

/** The two service type URIs each family permits, by service kind. */
const SERVICE_TYPE_URIS: Readonly<
  Record<EnabledProfileFamily, Readonly<Record<ServiceKind, string>>>
> = Object.freeze({
  "wallet-providers": Object.freeze({
    issuance: SERVICE_TYPE_ISSUANCE,
    revocation: SERVICE_TYPE_REVOCATION,
  }),
  "pid-providers": Object.freeze({
    issuance: PID_SERVICE_TYPE_ISSUANCE,
    revocation: PID_SERVICE_TYPE_REVOCATION,
  }),
  "wrpac-providers": Object.freeze({
    issuance: WRPAC_SERVICE_TYPE_ISSUANCE,
    revocation: WRPAC_SERVICE_TYPE_REVOCATION,
  }),
  "wrprc-providers": Object.freeze({
    issuance: WRPRC_SERVICE_TYPE_ISSUANCE,
    revocation: WRPRC_SERVICE_TYPE_REVOCATION,
  }),
});

export function serviceTypeUri(
  family: EnabledProfileFamily,
  kind: ServiceKind,
): string {
  return SERVICE_TYPE_URIS[family][kind];
}

const TRANSITIONS: Readonly<
  Record<ApplicationState, readonly ApplicationState[]>
> = Object.freeze({
  submitted: ["approved", "rejected"],
  approved: ["published", "rejected"],
  rejected: [],
  published: [],
});
export function canTransition(
  from: ApplicationState,
  to: ApplicationState,
): boolean {
  return TRANSITIONS[from].includes(to);
}

export function buildAuthoringEntity(
  data: CommonApplicantData,
  family: EnabledProfileFamily,
): AuthoringEntity {
  const profile = getProfile(family);
  /*
    The role URI states which country the entity is listed for and in which
    role. For a Wallet Provider that is the entity's own country; for a PID,
    WRPAC or WRPRC Provider it is the Member State that supervises or mandates
    it, which the applicant declares as the Responsible Member State.
  */
  const roleCountry =
    profile.roleCountrySource === "responsible-member-state" &&
    "responsibleMemberState" in data
      ? (data as SupervisedApplicantData).responsibleMemberState
      : data.entityCountry;
  const additionalInformationURI =
    "additionalInformationURI" in data
      ? (data as WalletRelyingPartyApplicantData).additionalInformationURI
      : undefined;
  return {
    teName: [{ lang: "en", value: data.entityName }],
    teTradeName: data.entityTradeName
      ? [{ lang: "en", value: data.entityTradeName }]
      : undefined,
    tePostalAddress: [
      {
        lang: "en",
        StreetAddress: data.entityStreetAddress,
        Locality: data.entityLocality,
        PostalCode: data.entityPostalCode,
        Country: data.entityCountry,
      },
    ],
    /* Annex D/E/F/G ask for an email address, a telephone number and a page. */
    teElectronicAddress: [
      { lang: "en", uriValue: mailtoUri(data.entityEmail) },
      { lang: "en", uriValue: data.entityInformationURI },
      { lang: "en", uriValue: telUri(data.entityTelephone) },
    ],
    teInformationURI: [
      { lang: "en", uriValue: data.entityInformationURI },
      {
        lang: "en",
        uriValue: roleUri(profile.roleUriPrefix ?? "", roleCountry),
      },
      ...(additionalInformationURI
        ? [{ lang: "en", uriValue: additionalInformationURI }]
        : []),
    ],
    services: data.services.map((service) => {
      const serviceTypeIdentifier = serviceTypeUri(family, service.serviceType);
      if (!profile.allowedServiceTypes.includes(serviceTypeIdentifier))
        throw new Error(
          `Service type '${serviceTypeIdentifier}' is not allowed for ${profile.label}.`,
        );
      return {
        serviceTypeIdentifier,
        serviceName: [{ lang: "en", value: service.serviceName }],
        /*
          The applicant supplies PEM; the published list carries Base64 DER
          (clause 6.6.3), so the conversion happens once, here at the authoring
          boundary, and every later stage sees the published form.
        */
        serviceDigitalIdentity: {
          x509Certificates: [certificateDerBase64(service.certificatePem)],
        },
        /*
          ServiceStatus and StatusStartingTime are never emitted: in these
          profiles presence in the current list version is itself the statement
          that the provider is mandated, and losing the mandate removes the
          entity from the next version.
        */
        ...(profile.requiresServiceUniqueIdentifier
          ? { serviceUniqueIdentifier: service.serviceUniqueIdentifier }
          : {}),
      };
    }),
  };
}

/**
 * Everything about the scheme that the list itself must carry. It mirrors a
 * signing-configuration entry, which is where the operator declares it.
 */
export interface SchemeDescriptor {
  schemeOperatorName: string;
  schemeOperatorStreet: string;
  schemeOperatorCountry: string;
  schemeOperatorEmail: string;
  schemeOperatorWebsite: string;
  schemeName: string;
  schemeTerritory: string;
  /** At least two, per Annex D/E/F/G. */
  schemeInformationUris: string[];
  policyUri: string;
  distributionPointUri: string;
  /** Certificates that authenticate the list, for the self pointer. */
  signerCertificates: string[];
}

export function normalizeToAuthoringInput(
  app: TrustedEntityApplication,
  scheme: SchemeDescriptor,
  listIssueDateTime: string,
  nextUpdate: string,
  loTESequenceNumber: number,
  existingEntities?: AuthoringEntity[],
): AuthoringInput {
  return {
    schemeOperator: {
      name: [{ lang: "en", value: scheme.schemeOperatorName }],
      postalAddress: [
        {
          lang: "en",
          StreetAddress: scheme.schemeOperatorStreet,
          Country: scheme.schemeOperatorCountry,
        },
      ],
      /*
        clauses 6.3.5.1 and 6.3.5.2 want the operator reachable by email and on
        the web, so both URI schemes are always present.
      */
      electronicAddress: [
        { lang: "en", uriValue: mailtoUri(scheme.schemeOperatorEmail) },
        { lang: "en", uriValue: scheme.schemeOperatorWebsite },
      ],
    },
    scheme: {
      schemeName: [{ lang: "en", value: scheme.schemeName }],
      schemeTerritory: scheme.schemeTerritory,
      schemeInformationURI: scheme.schemeInformationUris.map((uriValue) => ({
        lang: "en",
        uriValue,
      })),
      distributionPoints: [scheme.distributionPointUri],
      policyUri: scheme.policyUri,
      selfPointerCertificates: scheme.signerCertificates,
    },
    listIssueDateTime,
    nextUpdate,
    loTESequenceNumber,
    entities: existingEntities ?? [
      buildAuthoringEntity(app.applicantData, app.family),
    ],
  };
}

export const REQUIRED_DOCUMENTS: Readonly<Record<string, string>> =
  Object.freeze({
    onboarding_authorization: "{ONBOARDING_AUTHORIZATION}.md",
    service_provider_agreement: "{SERVICE_PROVIDER_AGREEMENT}.md",
  });
export function documentPlaceholder(docKey: string): string {
  return REQUIRED_DOCUMENTS[docKey] ?? "{UNKNOWN_DOCUMENT}.md";
}
export function isEnabledApplicationFamily(
  value: string,
): value is EnabledProfileFamily {
  return isEnabledProfileFamily(value);
}
export function isProfileFamily(value: string): value is ProfileFamily {
  return (
    isEnabledApplicationFamily(value) ||
    ["pub-eaa-providers", "registrars"].includes(value)
  );
}
