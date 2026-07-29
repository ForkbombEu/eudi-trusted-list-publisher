import type { AuthoringEntity, AuthoringInput } from "../model/authoring.js";
import { getProfile, type EnabledProfileFamily, type ProfileFamily } from "../profiles/registry.js";
import { PID_SERVICE_TYPE_ISSUANCE, PID_SERVICE_TYPE_REVOCATION } from "../profiles/pid-provider/constants.js";
import { SERVICE_TYPE_ISSUANCE, SERVICE_TYPE_REVOCATION } from "../profiles/wallet-provider/constants.js";

export const APPLICATION_SCHEMA_VERSION = 1;
export type ApplicationState = "submitted" | "approved" | "rejected" | "published";
export type ServiceKind = "issuance" | "revocation";
export interface ProviderServiceInput { serviceType: ServiceKind; serviceName: string; certificatePem: string; serviceUniqueIdentifier: string; }
export interface CommonApplicantData { entityName: string; entityTradeName?: string; entityStreetAddress: string; entityLocality?: string; entityPostalCode?: string; entityCountry: string; entityInformationURI: string; services: ProviderServiceInput[]; }
export interface WalletProviderApplicantData extends CommonApplicantData {}
export interface PIDProviderApplicantData extends CommonApplicantData { responsibleMemberState: string; }
export interface PublicationRecord { listKey: string; sequenceNumber: number; manifestSha256: string; compactJadesSha256: string; publicationTimestamp: string; }
interface ApplicationBase<F extends EnabledProfileFamily, D extends CommonApplicantData> { id: string; schemaVersion: 1; family: F; targetListKey: string; state: ApplicationState; submittedAt: string; applicantData: D; adminNote?: string; approvedAt?: string; rejectedAt?: string; publication?: PublicationRecord; }
export type WalletProviderApplication = ApplicationBase<"wallet-providers", WalletProviderApplicantData>;
export type PIDProviderApplication = ApplicationBase<"pid-providers", PIDProviderApplicantData>;
export type TrustedEntityApplication = WalletProviderApplication | PIDProviderApplication;
export type WalletProviderServiceInput = ProviderServiceInput;

const TRANSITIONS: Readonly<Record<ApplicationState, readonly ApplicationState[]>> = Object.freeze({ submitted: ["approved", "rejected"], approved: ["published", "rejected"], rejected: [], published: [] });
export function canTransition(from: ApplicationState, to: ApplicationState): boolean { return TRANSITIONS[from].includes(to); }

export function buildAuthoringEntity(data: CommonApplicantData, family: EnabledProfileFamily): AuthoringEntity {
  const profile = getProfile(family);
  return {
    teName: [{ lang: "en", value: data.entityName }],
    teTradeName: data.entityTradeName ? [{ lang: "en", value: data.entityTradeName }] : undefined,
    tePostalAddress: [{ lang: "en", StreetAddress: data.entityStreetAddress, Locality: data.entityLocality, PostalCode: data.entityPostalCode, Country: data.entityCountry }],
    teElectronicAddress: [{ lang: "en", uriValue: data.entityInformationURI }],
    teInformationURI: [{ lang: "en", uriValue: data.entityInformationURI }],
    services: data.services.map((service) => {
      const serviceTypeIdentifier = family === "pid-providers" ? (service.serviceType === "issuance" ? PID_SERVICE_TYPE_ISSUANCE : PID_SERVICE_TYPE_REVOCATION) : (service.serviceType === "issuance" ? SERVICE_TYPE_ISSUANCE : SERVICE_TYPE_REVOCATION);
      if (!profile.allowedServiceTypes.includes(serviceTypeIdentifier)) throw new Error(`Service type '${serviceTypeIdentifier}' is not allowed for ${profile.label}.`);
      return { serviceTypeIdentifier, serviceName: [{ lang: "en", value: service.serviceName }], serviceDigitalIdentity: { x509Certificates: [service.certificatePem] }, serviceUniqueIdentifier: service.serviceUniqueIdentifier };
    }),
  };
}

export function normalizeToAuthoringInput(app: TrustedEntityApplication, schemeOperatorName: string, schemeName: string, schemeTerritory: string, schemeOperatorAddress: { streetAddress: string; country: string }, schemeOperatorContactURI: string, distributionPointURI: string, listIssueDateTime: string, nextUpdate: string, loTESequenceNumber: number, existingEntities?: AuthoringEntity[]): AuthoringInput {
  return { schemeOperator: { name: [{ lang: "en", value: schemeOperatorName }], postalAddress: [{ lang: "en", StreetAddress: schemeOperatorAddress.streetAddress, Country: schemeOperatorAddress.country }], electronicAddress: [{ lang: "en", uriValue: schemeOperatorContactURI }] }, scheme: { schemeName: [{ lang: "en", value: schemeName }], schemeTerritory, distributionPoints: [distributionPointURI] }, listIssueDateTime, nextUpdate, loTESequenceNumber, entities: existingEntities ?? [buildAuthoringEntity(app.applicantData, app.family)] };
}

export const REQUIRED_DOCUMENTS: Readonly<Record<string, string>> = Object.freeze({ onboarding_authorization: "{ONBOARDING_AUTHORIZATION}.md", service_provider_agreement: "{SERVICE_PROVIDER_AGREEMENT}.md" });
export function documentPlaceholder(docKey: string): string { return REQUIRED_DOCUMENTS[docKey] ?? "{UNKNOWN_DOCUMENT}.md"; }
export function isEnabledApplicationFamily(value: string): value is EnabledProfileFamily { return value === "wallet-providers" || value === "pid-providers"; }
export function isProfileFamily(value: string): value is ProfileFamily { return isEnabledApplicationFamily(value) || ["non-qualified-eaa-providers", "qeaa-providers", "wrpac-providers", "wrprc-providers", "registrars"].includes(value); }
