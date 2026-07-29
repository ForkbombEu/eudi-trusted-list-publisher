// @ts-nocheck
import { SERVICE_TYPE_ISSUANCE, SERVICE_TYPE_REVOCATION } from "../profiles/wallet-provider/constants.js";
import { PID_SERVICE_TYPE_ISSUANCE, PID_SERVICE_TYPE_REVOCATION } from "../profiles/pid-provider/constants.js";
import { getProfile, type ProfileFamily } from "../profiles/registry.js";
import type { AuthoringEntity, AuthoringInput } from "../model/authoring.js";

export type ApplicationState = "submitted" | "approved" | "rejected" | "published";
export interface PublicationRecord { listKey: string; sequenceNumber: number; manifestSha256: string; compactJadesSha256: string; publicationTimestamp: string; }
export interface CommonApplicantData { entityName: string; entityTradeName?: string; entityStreetAddress: string; entityLocality?: string; entityPostalCode?: string; entityCountry: string; entityInformationURI: string; services: Array<{ serviceType: "issuance" | "revocation"; serviceName: string; certificatePem: string; serviceUniqueIdentifier: string }>; }
export interface WalletProviderApplicantData extends CommonApplicantData {}
export interface PIDProviderApplicantData extends CommonApplicantData { responsibleMemberState: string; }
export interface BaseApplication { id: string; schemaVersion: number; family: ProfileFamily; targetListKey: string; state: ApplicationState; submittedAt: string; adminNote?: string; approvedAt?: string; rejectedAt?: string; publication?: PublicationRecord; }
export interface WalletProviderApplication extends BaseApplication { family: "wallet-providers"; applicantData: WalletProviderApplicantData; }
export interface PIDProviderApplication extends BaseApplication { family: "pid-providers"; applicantData: PIDProviderApplicantData; }
export type TrustedEntityApplication = WalletProviderApplication | PIDProviderApplication;
export type WalletProviderServiceInput = WalletProviderApplicantData["services"][number];
export const APPLICATION_SCHEMA_VERSION = 1;
const VALID_TRANSITIONS = {
    submitted: ["approved", "rejected"],
    approved: ["published", "rejected"],
    rejected: [],
    published: [],
};
export function canTransition(from, to) {
    return VALID_TRANSITIONS[from].includes(to);
}
export function normalizeToAuthoringInput(app: TrustedEntityApplication, schemeOperatorName: string, schemeName: string, schemeTerritory: string, schemeOperatorAddress: { streetAddress: string; country: string }, schemeOperatorContactURI: string, distributionPointURI: string, listIssueDateTime: string, nextUpdate: string, loTESequenceNumber: number, existingEntities?: AuthoringEntity[]): AuthoringInput {
    getProfile(app.family);
    const data = app.applicantData;
    const input = {
        schemeOperator: {
            name: [{ lang: "en", value: schemeOperatorName }],
            postalAddress: [
                {
                    lang: "en",
                    StreetAddress: schemeOperatorAddress.streetAddress,
                    Country: schemeOperatorAddress.country,
                },
            ],
            electronicAddress: [{ lang: "en", uriValue: schemeOperatorContactURI }],
        },
        scheme: {
            schemeName: [{ lang: "en", value: schemeName }],
            schemeTerritory: schemeTerritory,
            distributionPoints: [distributionPointURI],
        },
        listIssueDateTime,
        nextUpdate,
        loTESequenceNumber,
        entities: [],
    };
    if (existingEntities) {
        input.entities = existingEntities;
    }
    else {
        input.entities = [buildAuthoringEntity(data, app.family)];
    }
    return input;
}
export function buildAuthoringEntity(data: CommonApplicantData, family: ProfileFamily = "wallet-providers") {
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
        teElectronicAddress: [{ lang: "en", uriValue: data.entityInformationURI }],
        teInformationURI: [{ lang: "en", uriValue: data.entityInformationURI }],
        services: data.services.map((svc) => {
            const typeIdentifier = family === "pid-providers"
                ? (svc.serviceType === "issuance" ? PID_SERVICE_TYPE_ISSUANCE : PID_SERVICE_TYPE_REVOCATION)
                : (svc.serviceType === "issuance" ? SERVICE_TYPE_ISSUANCE : SERVICE_TYPE_REVOCATION);
            if (!profile.allowedServiceTypes.includes(typeIdentifier)) throw new Error(`Service type is not allowed for ${profile.label}.`);
            return {
                serviceTypeIdentifier: typeIdentifier,
                serviceName: [{ lang: "en", value: svc.serviceName }],
                serviceDigitalIdentity: {
                    x509Certificates: [svc.certificatePem],
                },
                serviceUniqueIdentifier: svc.serviceUniqueIdentifier,
            };
        }),
    };
}
export const REQUIRED_DOCUMENTS = {
    onboarding_authorization: "{ONBOARDING_AUTHORIZATION}.md",
    service_provider_agreement: "{SERVICE_PROVIDER_AGREEMENT}.md",
};
export function documentPlaceholder(docKey) {
    return REQUIRED_DOCUMENTS[docKey] ?? "{UNKNOWN_DOCUMENT}.md";
}
//# sourceMappingURL=application-model.js.map
