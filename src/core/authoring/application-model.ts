import type { AuthoringEntity, AuthoringInput } from "../model/authoring.js";
import {
  getProfile,
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
  serviceUniqueIdentifier: string;
}
export interface CommonApplicantData {
  entityName: string;
  entityTradeName?: string;
  entityStreetAddress: string;
  entityLocality?: string;
  entityPostalCode?: string;
  entityCountry: string;
  entityInformationURI: string;
  /**
   * Annex D/E require a trusted entity to be contactable by email and
   * telephone as well as by its information page.
   */
  entityEmail: string;
  entityTelephone: string;
  services: ProviderServiceInput[];
}
export interface WalletProviderApplicantData extends CommonApplicantData {}
export interface PIDProviderApplicantData extends CommonApplicantData {
  responsibleMemberState: string;
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
export type TrustedEntityApplication =
  WalletProviderApplication | PIDProviderApplication;
export type WalletProviderServiceInput = ProviderServiceInput;

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
    /*
      Annex D/E ask for an email address, a telephone number and an information
      page. The role URI states which country the entity is listed for and in
      which role: for a PID Provider that is the supervising Member State, for a
      Wallet Provider the entity's own country.
    */
    teElectronicAddress: [
      { lang: "en", uriValue: mailtoUri(data.entityEmail) },
      { lang: "en", uriValue: data.entityInformationURI },
      { lang: "en", uriValue: telUri(data.entityTelephone) },
    ],
    teInformationURI: [
      { lang: "en", uriValue: data.entityInformationURI },
      {
        lang: "en",
        uriValue: roleUri(
          profile.roleUriPrefix ?? "",
          "responsibleMemberState" in data
            ? (data as PIDProviderApplicantData).responsibleMemberState
            : data.entityCountry,
        ),
      },
    ],
    services: data.services.map((service) => {
      const serviceTypeIdentifier =
        family === "pid-providers"
          ? service.serviceType === "issuance"
            ? PID_SERVICE_TYPE_ISSUANCE
            : PID_SERVICE_TYPE_REVOCATION
          : service.serviceType === "issuance"
            ? SERVICE_TYPE_ISSUANCE
            : SERVICE_TYPE_REVOCATION;
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
        serviceUniqueIdentifier: service.serviceUniqueIdentifier,
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
  /** At least two, per Annex D/E. */
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
  return value === "wallet-providers" || value === "pid-providers";
}
export function isProfileFamily(value: string): value is ProfileFamily {
  return (
    isEnabledApplicationFamily(value) ||
    [
      "non-qualified-eaa-providers",
      "qeaa-providers",
      "wrpac-providers",
      "wrprc-providers",
      "registrars",
    ].includes(value)
  );
}
