import type { AuthoringInput } from "../model/authoring.js";
import {
  SERVICE_TYPE_ISSUANCE,
  SERVICE_TYPE_REVOCATION,
} from "../profiles/wallet-provider/constants.js";

export const APPLICATION_SCHEMA_VERSION = 1;

export type ApplicationState =
  "submitted" | "approved" | "rejected" | "published";

export interface WalletProviderServiceInput {
  serviceType: "issuance" | "revocation";
  serviceName: string;
  certificatePem: string;
  serviceUniqueIdentifier: string;
}

export interface WalletProviderApplicantData {
  entityName: string;
  entityTradeName?: string;
  entityStreetAddress: string;
  entityLocality?: string;
  entityPostalCode?: string;
  entityCountry: string;
  entityInformationURI: string;
  services: WalletProviderServiceInput[];
}

export interface PublicationRecord {
  listKey: string;
  sequenceNumber: number;
  manifestSha256: string;
  compactJadesSha256: string;
  publicationTimestamp: string;
}

export interface WalletProviderApplication {
  id: string;
  schemaVersion: number;
  family: "wallet-providers";
  state: ApplicationState;
  submittedAt: string;
  applicantData: WalletProviderApplicantData;
  adminNote?: string;
  approvedAt?: string;
  rejectedAt?: string;
  publication?: PublicationRecord;
}

const VALID_TRANSITIONS: Record<ApplicationState, readonly ApplicationState[]> =
  {
    submitted: ["approved", "rejected"],
    approved: ["published", "rejected"],
    rejected: [],
    published: [],
  };

export function canTransition(
  from: ApplicationState,
  to: ApplicationState,
): boolean {
  return VALID_TRANSITIONS[from].includes(to);
}

export function normalizeToAuthoringInput(
  app: WalletProviderApplication,
  schemeOperatorName: string,
  schemeName: string,
  schemeTerritory: string,
  schemeOperatorAddress: {
    streetAddress: string;
    country: string;
  },
  schemeOperatorContactURI: string,
  distributionPointURI: string,
  listIssueDateTime: string,
  nextUpdate: string,
  loTESequenceNumber: number,
): AuthoringInput {
  const data = app.applicantData;

  const input: AuthoringInput = {
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
    entities: [
      {
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
        teElectronicAddress: [
          { lang: "en", uriValue: data.entityInformationURI },
        ],
        teInformationURI: [{ lang: "en", uriValue: data.entityInformationURI }],
        services: data.services.map((svc) => {
          const typeIdentifier =
            svc.serviceType === "issuance"
              ? SERVICE_TYPE_ISSUANCE
              : SERVICE_TYPE_REVOCATION;

          return {
            serviceTypeIdentifier: typeIdentifier,
            serviceName: [{ lang: "en", value: svc.serviceName }],
            serviceDigitalIdentity: {
              x509Certificates: [svc.certificatePem],
            },
            serviceUniqueIdentifier: svc.serviceUniqueIdentifier,
          };
        }),
      },
    ],
  };

  return input;
}

export const REQUIRED_DOCUMENTS: Record<string, string> = {
  onboarding_authorization: "{ONBOARDING_AUTHORIZATION}.md",
  service_provider_agreement: "{SERVICE_PROVIDER_AGREEMENT}.md",
};

export function documentPlaceholder(docKey: string): string {
  return REQUIRED_DOCUMENTS[docKey] ?? "{UNKNOWN_DOCUMENT}.md";
}
