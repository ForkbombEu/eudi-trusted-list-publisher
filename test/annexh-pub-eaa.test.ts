import { describe, it, expect } from "vitest";
import { readFileSync, mkdirSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes, X509Certificate } from "node:crypto";
import { compileForProfile } from "../src/core/compile/compile.js";
import { validateEtsiStruct } from "../src/core/validate/validate.js";
import {
  ApplicationService,
  AuthoringStore,
  buildAuthoringEntity,
  checkCertificateSetConsistency,
  checkLosslessPreservation,
  convertLoTEToAuthoringEntities,
  getEnabledFamilies,
  normalizeToAuthoringInput,
  parseAndValidateSubmission,
  restateServiceStatusTimes,
  splitPemCertificates,
  type PubEAAProviderApplicantData,
  type SchemeDescriptor,
  type SigningConfig,
  type TrustedEntityApplication,
} from "../src/core/authoring/index.js";
import { PublicationStore } from "../src/core/publication/store.js";
import { InspectorClient } from "../src/core/inspector/inspector.js";
import { getProfile, PROFILE_REGISTRY } from "../src/core/profiles/registry.js";
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
} from "../src/core/profiles/pub-eaa-provider/constants.js";
import {
  isLegalBasisReference,
  isStrictBase64,
  legalBasisUri,
} from "../src/core/model/lexical.js";
import {
  publicKeyFingerprint,
  subjectKeyIdentifierBase64,
} from "../src/core/model/x509-ski.js";
import { pubEaaProviderFormHtml } from "../src/web/views/onboarding.js";
import { adminApplicationDetailHtml } from "../src/web/views/admin.js";
import type { LoTEDocument } from "../src/core/model/types.js";

const FAMILY = "pub-eaa-providers";

const fixture = (name: string): string =>
  readFileSync(resolve(import.meta.dirname, "fixtures", name), "utf-8");

const TEST_CERT = fixture("test-cert.pem");
const TEST_CERT2 = fixture("test-cert2.pem");
const TEST_CERT_PATH = resolve(
  import.meta.dirname,
  "fixtures",
  "test-cert.pem",
);
const TEST_KEY_PATH = resolve(import.meta.dirname, "fixtures", "test-key.pem");
/** Subject organisation of test-cert.pem. */
const CERT_ORGANISATION = "Test";

const scheme = (): SchemeDescriptor => ({
  schemeOperatorName: CERT_ORGANISATION,
  schemeOperatorStreet: "1 Scheme Street",
  schemeOperatorCountry: "IT",
  schemeOperatorEmail: "trustedlists@scheme.example",
  schemeOperatorWebsite: "https://scheme.example",
  schemeName: "Test Pub-EAA Providers List",
  schemeTerritory: "EU",
  schemeInformationUris: [
    "https://scheme.example/scheme",
    "https://scheme.example/practice-statement",
  ],
  policyUri: "https://scheme.example/policy",
  distributionPointUri: "https://scheme.example/latest",
  signerCertificates: [TEST_CERT],
});

function applicantData(
  overrides: Partial<PubEAAProviderApplicantData> = {},
): PubEAAProviderApplicantData {
  return {
    entityName: CERT_ORGANISATION,
    entityStreetAddress: "1 Entity Street",
    entityLocality: "Rome",
    entityPostalCode: "00100",
    entityCountry: "IT",
    entityInformationURI: "https://entity.example/policies",
    entityEmail: "trust@entity.example",
    entityTelephone: "+39 02 1234567",
    responsibleMemberState: "IT",
    registrationIdentifier: "NTRIT-0000123456",
    legalBasisReference: "OJ:EU32024R1183",
    services: [
      {
        serviceType: "issuance",
        serviceName: "Issuance",
        certificatePem: TEST_CERT,
      },
      {
        serviceType: "revocation",
        serviceName: "Revocation",
        certificatePem: TEST_CERT,
      },
    ],
    ...overrides,
  };
}

function application(
  overrides: Partial<PubEAAProviderApplicantData> = {},
  state: TrustedEntityApplication["state"] = "approved",
): TrustedEntityApplication {
  return {
    id: "app",
    schemaVersion: 1,
    family: FAMILY,
    targetListKey: "eu_test",
    state,
    submittedAt: "2026-07-30T09:00:00Z",
    applicantData: applicantData(overrides),
  } as TrustedEntityApplication;
}

const ISSUE = "2026-07-30T09:00:00.123Z";
const NEXT = "2027-01-26T09:00:00.456Z";

function document(
  overrides: Partial<PubEAAProviderApplicantData> = {},
): LoTEDocument {
  const input = normalizeToAuthoringInput(
    application(overrides),
    scheme(),
    ISSUE,
    NEXT,
    1,
  );
  return compileForProfile(FAMILY, input).document;
}

function tmpDir(): string {
  const path = join(tmpdir(), `tlp-annexh-${randomBytes(8).toString("hex")}`);
  mkdirSync(path, { recursive: true });
  return path;
}

/** Never reaches the network; the profile it reports is the one asked for. */
function stubInspector(profile: string): InspectorClient {
  return new InspectorClient({
    baseUrl: "https://inspector.test",
    fetchImpl: (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            result: {
              detected: { format: "jws", artifactKind: "json_lote" },
              ts119602Classification: { profile },
              ts119602: {
                conformanceLevel: "partially_conformant",
                checks: [{ id: "x", category: "structure", status: "pass" }],
                mandatoryFailures: [],
              },
            },
          }),
          { status: 200 },
        ),
      )) as unknown as typeof fetch,
  });
}

const submissionFields = (
  overrides: Record<string, string> = {},
): Record<string, string> => ({
  entityName: CERT_ORGANISATION,
  entityStreetAddress: "1 Entity Street",
  entityCountry: "IT",
  entityEmail: "trust@entity.example",
  entityTelephone: "+39 02 1234567",
  responsibleMemberState: "IT",
  entityPolicyURI: "https://entity.example/policies",
  legalBasisReference: "OJ:EU32024R1183",
  "service[0].serviceType": "issuance",
  "service[0].serviceName": "Issuance",
  "service[0].certificatePem": TEST_CERT,
  ...overrides,
});

const signingConfig = (listKey: string): SigningConfig => ({
  lists: [
    {
      listKey,
      family: FAMILY,
      schemeOperatorName: CERT_ORGANISATION,
      schemeOperatorStreet: "1 Scheme Street",
      schemeOperatorCountry: "IT",
      schemeName: "Test Pub-EAA Providers List",
      schemeTerritory: "EU",
      schemeOperatorContactUri: "https://scheme.example",
      distributionPointUri: "https://scheme.example/latest",
      keyFile: TEST_KEY_PATH,
      certFile: TEST_CERT_PATH,
      schemeOperatorEmail: "trustedlists@scheme.example",
      schemeOperatorWebsite: "https://scheme.example",
      schemeInformationUris: [
        "https://scheme.example/scheme",
        "https://scheme.example/practice-statement",
      ],
      policyUri: "https://scheme.example/policy",
    },
  ],
});

const services = (doc: LoTEDocument, entity = 0) =>
  doc.LoTE.TrustedEntitiesList![entity]!.TrustedEntityServices;

// ============================================================
// 1. Profile registry and Annex H constants
// ============================================================
describe("Annex H profile", () => {
  it("is the fifth enabled family, in annex order", () => {
    expect(getEnabledFamilies().map((family) => family.key)).toEqual([
      "pid-providers",
      "wallet-providers",
      "wrpac-providers",
      "wrprc-providers",
      "pub-eaa-providers",
    ]);
    expect(PROFILE_REGISTRY.registrars.enabled).toBe(false);
  });

  it("carries the Annex H URIs, statuses and history period", () => {
    expect(getProfile(FAMILY)).toMatchObject({
      loTEType: PUB_EAA_PROVIDER_LOTE_TYPE,
      statusDeterminationApproach: PUB_EAA_PROVIDER_STATUS_DETN,
      schemeRules: PUB_EAA_PROVIDER_SCHEME_RULES,
      roleUriPrefix: PUB_EAA_PROVIDER_ROLE_URI_PREFIX,
      allowedServiceTypes: [
        PUB_EAA_SERVICE_TYPE_ISSUANCE,
        PUB_EAA_SERVICE_TYPE_REVOCATION,
      ],
      maxNextUpdateMonths: 6,
      requiresServiceUniqueIdentifier: false,
      roleCountrySource: "responsible-member-state",
      usesServiceStatus: true,
      serviceStatuses: {
        notified: PUB_EAA_SVC_STATUS_NOTIFIED,
        withdrawn: PUB_EAA_SVC_STATUS_WITHDRAWN,
      },
      historicalInformationPeriod: PUB_EAA_HISTORICAL_INFORMATION_PERIOD,
      publishesSelfPointer: false,
      requiresServiceCertificate: false,
      requiresLegalBasisReference: true,
      signatureProfile: "JAdES-Compact-B",
    });
  });

  it("states the URIs exactly as Annex H prints them", () => {
    expect(PUB_EAA_PROVIDER_LOTE_TYPE).toBe(
      "http://uri.etsi.org/19602/LoTEType/EUPubEAAProvidersList",
    );
    expect(PUB_EAA_PROVIDER_STATUS_DETN).toBe(
      "http://uri.etsi.org/19602/PubEAAProvidersList/StatusDetn/EU",
    );
    expect(PUB_EAA_PROVIDER_SCHEME_RULES).toBe(
      "http://uri.etsi.org/19602/PubEAAProvidersList/schemerules/EU",
    );
    expect(PUB_EAA_SERVICE_TYPE_ISSUANCE).toBe(
      "http://uri.etsi.org/19602/SvcType/PubEAA/Issuance",
    );
    expect(PUB_EAA_SERVICE_TYPE_REVOCATION).toBe(
      "http://uri.etsi.org/19602/SvcType/PubEAA/Revocation",
    );
    expect(PUB_EAA_SVC_STATUS_NOTIFIED).toBe(
      "http://uri.etsi.org/19602/PubEAAProvidersList/SvcStatus/notified",
    );
    expect(PUB_EAA_SVC_STATUS_WITHDRAWN).toBe(
      "http://uri.etsi.org/19602/PubEAAProvidersList/SvcStatus/withdrawn",
    );
    expect(PUB_EAA_PROVIDER_ROLE_URI_PREFIX).toBe(
      "http://uri.etsi.org/19602/ListOfTrustedEntities/PubEAAProvider",
    );
    expect(PUB_EAA_HISTORICAL_INFORMATION_PERIOD).toBe(65535);
  });
});

// ============================================================
// 2. Scheme information
// ============================================================
describe("Annex H scheme information", () => {
  it("publishes version 1, EU territory and the fixed history period", () => {
    const scheme = document().LoTE.ListAndSchemeInformation;
    expect(scheme.LoTEVersionIdentifier).toBe(1);
    expect(scheme.SchemeTerritory).toBe("EU");
    expect(scheme.HistoricalInformationPeriod).toBe(65535);
    expect(scheme.LoTEType).toBe(PUB_EAA_PROVIDER_LOTE_TYPE);
    expect(scheme.StatusDeterminationApproach).toBe(
      PUB_EAA_PROVIDER_STATUS_DETN,
    );
    expect(scheme.SchemeTypeCommunityRules).toEqual([
      { lang: "en", uriValue: PUB_EAA_PROVIDER_SCHEME_RULES },
    ]);
  });

  it("publishes no PointersToOtherLoTE even when signer certificates exist", () => {
    expect(scheme().signerCertificates).toHaveLength(1);
    expect(
      document().LoTE.ListAndSchemeInformation.PointersToOtherLoTE,
    ).toBeUndefined();
  });

  it("keeps NextUpdate within six months of the issue time", () => {
    const scheme = document().LoTE.ListAndSchemeInformation;
    const issued = Date.parse(scheme.ListIssueDateTime);
    const next = Date.parse(scheme.NextUpdate);
    const maximum = new Date(issued);
    maximum.setUTCMonth(maximum.getUTCMonth() + 6);
    expect(next).toBeLessThanOrEqual(maximum.getTime());
  });

  it("emits the strict UTC lexical form with no fractional seconds", () => {
    const scheme = document().LoTE.ListAndSchemeInformation;
    expect(scheme.ListIssueDateTime).toBe("2026-07-30T09:00:00Z");
    expect(scheme.NextUpdate).toBe("2027-01-26T09:00:00Z");
  });

  it("refuses a history period other than the one Annex H fixes", () => {
    const input = normalizeToAuthoringInput(
      application(),
      scheme(),
      ISSUE,
      NEXT,
      1,
    );
    input.scheme.historicalInformationPeriod = 12;
    expect(() => compileForProfile(FAMILY, input)).toThrow(/65535/);
  });

  it("refuses a history period on a profile that publishes none", () => {
    const input = normalizeToAuthoringInput(
      application(),
      scheme(),
      ISSUE,
      NEXT,
      1,
    );
    input.scheme.historicalInformationPeriod = 65535;
    input.entities = [];
    expect(() => compileForProfile("wallet-providers", input)).toThrow(
      /does not publish HistoricalInformationPeriod/,
    );
  });
});

// ============================================================
// 3. Trusted entity
// ============================================================
describe("Annex H trusted entity", () => {
  it("publishes the Member-State role URI only in the electronic address", () => {
    const information = document({
      entityCountry: "DE",
      responsibleMemberState: "IT",
    }).LoTE.TrustedEntitiesList![0]!.TrustedEntityInformation;
    const role =
      "http://uri.etsi.org/19602/ListOfTrustedEntities/PubEAAProvider/IT";
    expect(
      information.TEAddress.TEElectronicAddress.map((uri) => uri.uriValue),
    ).toContain(role);
    expect(
      information.TEInformationURI.map((uri) => uri.uriValue),
    ).not.toContain(role);
  });

  it("publishes the legal basis only in TETradeName", () => {
    const information =
      document().LoTE.TrustedEntitiesList![0]!.TrustedEntityInformation;
    const legalBasis = "OJ:EU32024R1183";
    expect(information.TETradeName?.map((name) => name.value)).toContain(
      legalBasis,
    );
    expect(
      information.TEInformationURI.map((uri) => uri.uriValue),
    ).not.toContain(legalBasis);
    expect(
      information.TEAddress.TEElectronicAddress.map((uri) => uri.uriValue),
    ).not.toContain(legalBasis);
  });

  it("keeps only the policies URL in TEInformationURI", () => {
    const information =
      document().LoTE.TrustedEntitiesList![0]!.TrustedEntityInformation;
    expect(information.TEInformationURI).toEqual([
      { lang: "en", uriValue: "https://entity.example/policies" },
    ]);
  });

  it("requires the OJ: reference to identify EU or Member-State law", () => {
    expect(legalBasisUri("EU32024R1183")).toBe("OJ:EU32024R1183");
    expect(legalBasisUri("OJ:ITlegge-2024-12")).toBe("OJ:ITlegge-2024-12");
    expect(() => legalBasisUri("   ")).toThrow(/empty/);
    expect(() => legalBasisUri("OJ:USlaw-2024-12")).toThrow(
      /EU or an EU Member State/,
    );
    expect(isLegalBasisReference("OJ:EU32024R1183")).toBe(true);
    expect(isLegalBasisReference("ITlegge-2024-12")).toBe(true);
    expect(isLegalBasisReference("OJ:EU")).toBe(false);
    expect(isLegalBasisReference("OJ:USlaw-2024-12")).toBe(false);
    expect(isLegalBasisReference("OJ: EU32024R1183")).toBe(false);
    expect(isLegalBasisReference("not a reference")).toBe(false);
  });

  it("publishes the Annex H.3 values in mandatory TETradeName", () => {
    const information =
      document().LoTE.TrustedEntitiesList![0]!.TrustedEntityInformation;
    expect(information.TETradeName).toEqual([
      { lang: "en", value: "NTRIT-0000123456" },
      { lang: "en", value: "OJ:EU32024R1183" },
    ]);
  });

  it("keeps TETradeName mandatory when no registration identifier exists", () => {
    const information = document({
      registrationIdentifier: undefined,
    }).LoTE.TrustedEntitiesList![0]!.TrustedEntityInformation;
    expect(information.TETradeName).toEqual([
      { lang: "en", value: "OJ:EU32024R1183" },
    ]);
  });

  it("refuses Pub-EAA compiler input without the Annex H.3 values", () => {
    const input = normalizeToAuthoringInput(
      application(),
      scheme(),
      ISSUE,
      NEXT,
      1,
    );
    input.entities[0]!.teTradeName = undefined;
    expect(() => compileForProfile(FAMILY, input)).toThrow(/TETradeName/);
    input.entities[0]!.teTradeName = [
      { lang: "en", value: "NTRIT-0000123456" },
    ];
    expect(() => compileForProfile(FAMILY, input)).toThrow(/legal-basis URI/);
  });

  it("configures the Pub-EAA role URI for electronic address only", () => {
    const information =
      document().LoTE.TrustedEntitiesList![0]!.TrustedEntityInformation;
    const addresses = information.TEAddress.TEElectronicAddress.map(
      (entry) => entry.uriValue,
    );
    expect(addresses).toContain(
      "http://uri.etsi.org/19602/ListOfTrustedEntities/PubEAAProvider/IT",
    );
    expect(getProfile(FAMILY).roleUriInElectronicAddress).toBe(true);
    expect(getProfile(FAMILY).roleUriInInformationUri).toBe(false);
    for (const family of [
      "pid-providers",
      "wallet-providers",
      "wrpac-providers",
      "wrprc-providers",
    ] as const)
      expect(getProfile(family).roleUriInElectronicAddress).toBe(false);
  });

  it("is contactable by mailto, https and tel", () => {
    const address =
      document().LoTE.TrustedEntitiesList![0]!.TrustedEntityInformation
        .TEAddress;
    const uris = address.TEElectronicAddress.map((entry) => entry.uriValue);
    expect(uris).toContain("mailto:trust@entity.example");
    expect(uris).toContain("https://entity.example/policies");
    expect(uris).toContain("tel:+390212345 67".replace(/\s/g, ""));
    expect(address.TEPostalAddress[0]).toMatchObject({
      StreetAddress: "1 Entity Street",
      Country: "IT",
    });
  });

  it("publishes the official registration identifier in TETradeName", () => {
    const json = JSON.stringify(document());
    expect(json).toContain("NTRIT-0000123456");
  });
});

// ============================================================
// 4. Services and status
// ============================================================
describe("Annex H services", () => {
  it("publishes every service as notified from the publication event", () => {
    for (const service of services(document())) {
      expect(service.ServiceInformation.ServiceStatus).toBe(
        PUB_EAA_SVC_STATUS_NOTIFIED,
      );
      expect(service.ServiceInformation.StatusStartingTime).toBe(
        "2026-07-30T09:00:00Z",
      );
      expect(service.ServiceHistory).toBeUndefined();
    }
  });

  it("publishes certificates as strict Base64 DER and no extension container", () => {
    const information = services(document())[0]!.ServiceInformation;
    const value = information.ServiceDigitalIdentity.X509Certificates![0]!.val;
    expect(isStrictBase64(value)).toBe(true);
    expect(value).not.toContain("BEGIN CERTIFICATE");
    expect(information.ServiceInformationExtensions).toBeUndefined();
  });

  it("permits a service with no certificate at all", async () => {
    const doc = document({
      services: [{ serviceType: "issuance", serviceName: "Issuance" }],
    });
    const identity =
      services(doc)[0]!.ServiceInformation.ServiceDigitalIdentity;
    expect(identity.X509Certificates).toBeUndefined();
    expect(identity).toEqual({});
    expect((await validateEtsiStruct(doc)).valid).toBe(true);
  });

  it("requires a certificate on the profiles that mandate one", () => {
    expect(() =>
      buildAuthoringEntity(
        {
          ...applicantData(),
          services: [{ serviceType: "issuance", serviceName: "Issuance" }],
        },
        "wrpac-providers",
      ),
    ).toThrow(/require a service digital identity certificate/);
  });

  it("publishes several certificates for one service", () => {
    const doc = document({
      services: [
        {
          serviceType: "issuance",
          serviceName: "Issuance",
          certificatePem: `${TEST_CERT}\n${TEST_CERT}`,
        },
      ],
    });
    expect(
      services(doc)[0]!.ServiceInformation.ServiceDigitalIdentity
        .X509Certificates,
    ).toHaveLength(2);
  });

  it("refuses a status on a profile that publishes none", () => {
    /*
      A Wallet entity with an Annex H status bolted on: the service type is
      allowed there, so the status itself is what the compiler must refuse.
    */
    const entity = buildAuthoringEntity(
      { ...applicantData(), responsibleMemberState: undefined } as never,
      "wallet-providers",
    );
    entity.services[0]!.serviceStatus = PUB_EAA_SVC_STATUS_NOTIFIED;
    entity.services[0]!.statusStartingTime = ISSUE;
    const input = normalizeToAuthoringInput(
      application(),
      scheme(),
      ISSUE,
      NEXT,
      1,
      [entity],
    );
    delete input.scheme.historicalInformationPeriod;
    expect(() => compileForProfile("wallet-providers", input)).toThrow(
      /publish no ServiceStatus/,
    );
  });

  it("refuses a status without its starting time", () => {
    expect(() => buildAuthoringEntity(applicantData(), FAMILY)).toThrow(
      /status starting time/,
    );
  });
});

describe("Annex H status starting times", () => {
  it("restates a carried-over service with the new issue time", () => {
    /*
      clause 6.6.5: a current service's StatusStartingTime must not precede the
      list's ListIssueDateTime, so an entity carried into a new version cannot
      keep the timestamp of the version that first listed it.
    */
    const entity = buildAuthoringEntity(applicantData(), FAMILY, {
      statusStartingTime: "2026-07-30T09:00:00Z",
    });
    const restated = restateServiceStatusTimes(
      [entity],
      "2026-08-30T09:00:00.500Z",
      FAMILY,
    );
    for (const service of restated[0]!.services) {
      expect(service.statusStartingTime).toBe("2026-08-30T09:00:00Z");
      expect(service.serviceStatus).toBe(PUB_EAA_SVC_STATUS_NOTIFIED);
    }
    /* The original is untouched, and the profiles without a status are too. */
    expect(entity.services[0]!.statusStartingTime).toBe("2026-07-30T09:00:00Z");
    const wallet = buildAuthoringEntity(
      { ...applicantData(), responsibleMemberState: undefined } as never,
      "wallet-providers",
    );
    expect(
      restateServiceStatusTimes(
        [wallet],
        "2026-08-30T09:00:00Z",
        "wallet-providers",
      )[0]!.services[0]!.statusStartingTime,
    ).toBeUndefined();
  });
});

// ============================================================
// 5. Subject key identifiers
// ============================================================
describe("subject key identifiers", () => {
  it("reads the SubjectKeyIdentifier extension when the certificate has one", () => {
    const ski = subjectKeyIdentifierBase64(TEST_CERT);
    expect(isStrictBase64(ski)).toBe(true);
    /* The identifier read here is the one encoded in the certificate. */
    const der = new X509Certificate(TEST_CERT).raw.toString("hex");
    expect(der).toContain(Buffer.from(ski, "base64").toString("hex"));
  });

  it("accepts Base64 DER as well as PEM, and agrees on the value", () => {
    const der = new X509Certificate(TEST_CERT).raw.toString("base64");
    expect(subjectKeyIdentifierBase64(der)).toBe(
      subjectKeyIdentifierBase64(TEST_CERT),
    );
  });

  it("distinguishes two certificates with different keys", () => {
    expect(subjectKeyIdentifierBase64(TEST_CERT)).not.toBe(
      subjectKeyIdentifierBase64(TEST_CERT2),
    );
    expect(publicKeyFingerprint(new X509Certificate(TEST_CERT))).not.toBe(
      publicKeyFingerprint(new X509Certificate(TEST_CERT2)),
    );
  });
});

// ============================================================
// 6. Onboarding submission
// ============================================================
describe("Annex H onboarding submission", () => {
  it("accepts a complete Pub-EAA submission", () => {
    const result = parseAndValidateSubmission(
      submissionFields(),
      "eu_test",
      FAMILY,
    );
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.applicantData).toMatchObject({
      responsibleMemberState: "IT",
      legalBasisReference: "OJ:EU32024R1183",
      entityInformationURI: "https://entity.example/policies",
    });
  });

  it("requires a well-formed legal basis reference", () => {
    const missing = parseAndValidateSubmission(
      submissionFields({ legalBasisReference: "" }),
      "eu_test",
      FAMILY,
    );
    expect(missing.errors.map((error) => error.field)).toContain(
      "legalBasisReference",
    );
    const malformed = parseAndValidateSubmission(
      submissionFields({ legalBasisReference: "not a reference" }),
      "eu_test",
      FAMILY,
    );
    expect(
      malformed.errors.some((error) => /EU Member State/.test(error.message)),
    ).toBe(true);
  });

  it("accepts a submission with no certificate", () => {
    const result = parseAndValidateSubmission(
      submissionFields({ "service[0].certificatePem": "" }),
      "eu_test",
      FAMILY,
    );
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.applicantData.services[0]?.certificatePem).toBeUndefined();
  });

  it("still requires the subject organisation to equal the entity name", () => {
    const result = parseAndValidateSubmission(
      submissionFields({ entityName: "Someone Else" }),
      "eu_test",
      FAMILY,
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.message).toMatch(/organisation \(O\)/);
  });

  it("refuses two certificates with different keys or subjects", () => {
    const result = parseAndValidateSubmission(
      submissionFields({
        "service[0].certificatePem": `${TEST_CERT}\n${TEST_CERT2}`,
      }),
      "eu_test",
      FAMILY,
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.message).toMatch(/same public key|identical/);
  });

  it("accepts two renditions of one identity", () => {
    expect(splitPemCertificates(`${TEST_CERT}\n${TEST_CERT}`)).toHaveLength(2);
    expect(
      checkCertificateSetConsistency([
        new X509Certificate(TEST_CERT),
        new X509Certificate(TEST_CERT),
      ]),
    ).toBeNull();
    expect(
      checkCertificateSetConsistency([
        new X509Certificate(TEST_CERT),
        new X509Certificate(TEST_CERT2),
      ]),
    ).toMatch(/same public key/);
  });

  it("reports fields that belong to another family as unknown", () => {
    const result = parseAndValidateSubmission(
      submissionFields({
        additionalInformationURI: "https://entity.example/info",
        "service[0].serviceUniqueIdentifier": "https://entity.example/svc/1",
      }),
      "eu_test",
      FAMILY,
    );
    expect(result.valid).toBe(false);
    expect(result.errors.map((error) => error.field)).toEqual(
      expect.arrayContaining([
        "additionalInformationURI",
        "service[0].serviceUniqueIdentifier",
      ]),
    );
  });

  it("does not offer the legal basis field to the other families", () => {
    const result = parseAndValidateSubmission(
      {
        entityName: CERT_ORGANISATION,
        entityStreetAddress: "1 Entity Street",
        entityCountry: "IT",
        entityEmail: "trust@entity.example",
        entityTelephone: "+39 02 1234567",
        responsibleMemberState: "PL",
        entityPolicyURI: "https://entity.example/policies",
        legalBasisReference: "OJ:EU32024R1183",
        "service[0].serviceType": "issuance",
        "service[0].serviceName": "Issuance",
        "service[0].certificatePem": TEST_CERT,
      },
      "eu_test",
      "wrpac-providers",
    );
    expect(result.valid).toBe(false);
    expect(result.errors.map((error) => error.field)).toContain(
      "legalBasisReference",
    );
  });
});

// ============================================================
// 7. Schema validity and lossless round trip
// ============================================================
describe("Annex H schema validity", () => {
  it("validates against the pinned ETSI schema", async () => {
    const result = await validateEtsiStruct(document());
    expect(result.findings).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("rejects a Pub-EAA entity without TETradeName", async () => {
    const doc = document();
    delete doc.LoTE.TrustedEntitiesList![0]!.TrustedEntityInformation
      .TETradeName;
    const result = await validateEtsiStruct(doc);
    expect(result.valid).toBe(false);
    expect(
      result.findings.some((finding) =>
        /TETradeName/.test(`${finding.path} ${finding.message}`),
      ),
    ).toBe(true);
  });

  it("rejects a Pub-EAA TETradeName without the formatted law reference", async () => {
    const doc = document();
    doc.LoTE.TrustedEntitiesList![0]!.TrustedEntityInformation.TETradeName = [
      { lang: "en", value: "NTRIT-0000123456" },
    ];
    const result = await validateEtsiStruct(doc);
    expect(result.valid).toBe(false);
    expect(
      result.findings.some(
        (finding) =>
          /TETradeName/.test(finding.path) || /contain/.test(finding.message),
      ),
    ).toBe(true);
  });

  it("round-trips status and history without loss", () => {
    const doc = withdrawnDocument();
    const entities = convertLoTEToAuthoringEntities(doc, FAMILY);
    expect(entities[0]!.services[0]!.serviceStatus).toBe(
      PUB_EAA_SVC_STATUS_WITHDRAWN,
    );
    expect(entities[0]!.services[0]!.serviceHistory).toHaveLength(1);
    expect(
      checkLosslessPreservation(
        doc.LoTE.TrustedEntitiesList!,
        entities,
        FAMILY,
      ),
    ).toEqual({ ok: true });
  });

  it("refuses a Pub-EAA list read as another family", () => {
    expect(() =>
      convertLoTEToAuthoringEntities(document(), "wallet-providers"),
    ).toThrow(/ServiceStatus is present/);
  });
});

/** A version-2 document: services withdrawn, previous notified state in history. */
function withdrawnDocument(): LoTEDocument {
  const notified = buildAuthoringEntity(applicantData(), FAMILY, {
    statusStartingTime: ISSUE,
  });
  const withdrawn = {
    ...notified,
    services: notified.services.map((service) => ({
      ...service,
      serviceStatus: PUB_EAA_SVC_STATUS_WITHDRAWN,
      statusStartingTime: "2026-08-30T09:00:00Z",
      serviceHistory: [
        {
          serviceTypeIdentifier: service.serviceTypeIdentifier,
          serviceName: service.serviceName,
          x509Skis: service.serviceDigitalIdentity.x509Certificates.map(
            (certificate) => subjectKeyIdentifierBase64(certificate),
          ),
          serviceStatus: PUB_EAA_SVC_STATUS_NOTIFIED,
          statusStartingTime: "2026-07-30T09:00:00Z",
        },
      ],
    })),
  };
  const input = normalizeToAuthoringInput(
    application(),
    scheme(),
    "2026-08-30T09:00:00Z",
    "2027-02-26T09:00:00Z",
    2,
    [withdrawn],
  );
  return compileForProfile(FAMILY, input).document;
}

describe("Annex H service history", () => {
  it("states at least one X509SKI and never a certificate", async () => {
    const doc = withdrawnDocument();
    for (const service of services(doc)) {
      const history = service.ServiceHistory!;
      expect(history).toHaveLength(1);
      const identity = history[0]!.ServiceDigitalIdentity;
      expect(identity.X509SKIs!.length).toBeGreaterThanOrEqual(1);
      expect(identity.X509Certificates).toBeUndefined();
      expect(isStrictBase64(identity.X509SKIs![0]!)).toBe(true);
      expect(history[0]!.ServiceStatus).toBe(PUB_EAA_SVC_STATUS_NOTIFIED);
      expect(history[0]!.StatusStartingTime).toBe("2026-07-30T09:00:00Z");
      expect(service.ServiceInformation.ServiceStatus).toBe(
        PUB_EAA_SVC_STATUS_WITHDRAWN,
      );
    }
    expect((await validateEtsiStruct(doc)).valid).toBe(true);
  });

  it("refuses a history instance with no key identifier", () => {
    const entity = buildAuthoringEntity(applicantData(), FAMILY, {
      statusStartingTime: ISSUE,
    });
    entity.services[0]!.serviceHistory = [
      {
        serviceName: entity.services[0]!.serviceName,
        x509Skis: [],
        serviceStatus: PUB_EAA_SVC_STATUS_NOTIFIED,
        statusStartingTime: ISSUE,
      },
    ];
    const input = normalizeToAuthoringInput(
      application(),
      scheme(),
      ISSUE,
      NEXT,
      1,
      [entity],
    );
    expect(() => compileForProfile(FAMILY, input)).toThrow(/X509SKI/);
  });

  it("refuses a history instance carrying a certificate on read", () => {
    const doc = withdrawnDocument();
    services(doc)[0]!.ServiceHistory![0]!.ServiceDigitalIdentity = {
      X509Certificates: [{ val: "AAAA" }],
    };
    expect(() => convertLoTEToAuthoringEntities(doc, FAMILY)).toThrow(
      /carries an X509Certificate/,
    );
  });
});

// ============================================================
// 8. Publish, then withdraw
// ============================================================
describe("Annex H lifecycle", () => {
  it("publishes a notified provider and then withdraws it", async () => {
    const root = tmpDir();
    try {
      const publicationStore = new PublicationStore({
        publicationDir: join(root, "publications"),
      });
      const authoringStore = new AuthoringStore({
        authoringDir: join(root, "authoring"),
      });
      const service = new ApplicationService(
        authoringStore,
        publicationStore,
        signingConfig("eu_test"),
        null,
        stubInspector("pub_eaa_providers"),
      );

      const app = service.createApp("eu_test", applicantData(), FAMILY);
      expect(service.approve(app.id).success).toBe(true);
      const published = await service.publishApplication(app.id);
      expect(published.success).toBe(true);
      if (!published.success) return;
      expect(published.data.publication?.sequenceNumber).toBe(1);

      const withdrawn = await service.withdrawApplication(app.id);
      expect(withdrawn.success).toBe(true);
      if (!withdrawn.success) return;
      expect(withdrawn.data.state).toBe("withdrawn");
      expect(withdrawn.data.withdrawal?.sequenceNumber).toBe(2);
      /* The first publication record is kept: withdrawal adds a version. */
      expect(withdrawn.data.publication?.sequenceNumber).toBe(1);
      expect(withdrawn.data.withdrawnAt).toBeTruthy();

      const first = JSON.parse(
        (await publicationStore.loadVersionBytes("eu_test", 1, "lote"))!,
      ) as LoTEDocument;
      const second = JSON.parse(
        (await publicationStore.loadVersionBytes("eu_test", 2, "lote"))!,
      ) as LoTEDocument;

      /* Version 1 is untouched and still says notified. */
      for (const service of services(first)) {
        expect(service.ServiceInformation.ServiceStatus).toBe(
          PUB_EAA_SVC_STATUS_NOTIFIED,
        );
        expect(service.ServiceHistory).toBeUndefined();
      }
      /* Version 2 says withdrawn and keeps the notified state in history. */
      expect(services(second)).toHaveLength(2);
      for (const service of services(second)) {
        expect(service.ServiceInformation.ServiceStatus).toBe(
          PUB_EAA_SVC_STATUS_WITHDRAWN,
        );
        const history = service.ServiceHistory!;
        expect(history).toHaveLength(1);
        expect(history[0]!.ServiceStatus).toBe(PUB_EAA_SVC_STATUS_NOTIFIED);
        expect(
          history[0]!.ServiceDigitalIdentity.X509SKIs!.length,
        ).toBeGreaterThanOrEqual(1);
        expect(
          history[0]!.ServiceDigitalIdentity.X509Certificates,
        ).toBeUndefined();
        expect(history[0]!.StatusStartingTime).toBe(
          services(first)[0]!.ServiceInformation.StatusStartingTime,
        );
      }
      expect((await validateEtsiStruct(second)).valid).toBe(true);
      expect(
        second.LoTE.ListAndSchemeInformation.HistoricalInformationPeriod,
      ).toBe(65535);
      expect(second.LoTE.ListAndSchemeInformation.LoTESequenceNumber).toBe(2);

      /* Both versions are complete, immutable and downloadable. */
      for (const sequence of [1, 2]) {
        for (const artifact of ["lote", "signature", "manifest"] as const) {
          expect(
            await publicationStore.loadVersionBytes(
              "eu_test",
              sequence,
              artifact,
            ),
          ).toBeTruthy();
        }
        const evaluation = publicationStore.readInspectorEvaluation(
          "eu_test",
          sequence,
        );
        expect(evaluation).toBeTruthy();
      }

      /* A second withdrawal is refused: the state machine is terminal. */
      const again = await service.withdrawApplication(app.id);
      expect(again.success).toBe(false);
      expect(service.deleteApplication(app.id).success).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses to withdraw an entity of a profile with no service status", async () => {
    const root = tmpDir();
    try {
      const service = new ApplicationService(
        new AuthoringStore({ authoringDir: join(root, "authoring") }),
        new PublicationStore({ publicationDir: join(root, "publications") }),
        {
          lists: [
            {
              ...signingConfig("eu_wrpac").lists[0]!,
              family: "wrpac-providers",
            },
          ],
        },
        null,
        stubInspector("wrpac_providers"),
      );
      const app = service.createApp(
        "eu_wrpac",
        {
          ...applicantData(),
          legalBasisReference: undefined,
          registrationIdentifier: undefined,
        } as never,
        "wrpac-providers",
      );
      const result = await service.withdrawApplication(app.id);
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error).toMatch(/publish no service status/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ============================================================
// 9. Views
// ============================================================
describe("Annex H views", () => {
  it("renders the Pub-EAA onboarding form with its own fields", () => {
    const html = pubEaaProviderFormHtml({}, {}, [
      { key: "eu_test", label: "Test (eu_test)" },
    ]);
    expect(html).toContain("Pub-EAA Provider Application");
    expect(html).toContain('name="responsibleMemberState"');
    expect(html).toContain('name="legalBasisReference"');
    expect(html).toContain('name="registrationIdentifier"');
    expect(html).toContain('name="entityPolicyURI"');
    expect(html).toContain("Policies and Terms URL");
    expect(html).toContain("Notification");
    expect(html).toContain("notified");
    /* No service unique identifier, and the certificate is optional. */
    expect(html).not.toContain('name="service[0].serviceUniqueIdentifier"');
    expect(html).not.toContain('name="additionalInformationURI"');
    expect(html).toMatch(
      /<textarea name="service\[0\]\.certificatePem"(?! required)/,
    );
  });

  it("offers Withdraw on a published Pub-EAA application only", () => {
    const publishedRecord = {
      listKey: "eu_test",
      sequenceNumber: 1,
      manifestSha256: "a".repeat(64),
      compactJadesSha256: "b".repeat(64),
      publicationTimestamp: "2026-07-30T09:00:00Z",
    };
    const html = adminApplicationDetailHtml({
      ...application({}, "published"),
      approvedAt: "2026-07-30T09:00:00Z",
      publication: publishedRecord,
    } as TrustedEntityApplication);
    expect(html).toContain("Withdraw notification");
    expect(html).toContain("/withdraw");
    expect(html).toContain("Legal Basis Reference");
    expect(html).toContain("OJ:EU32024R1183");
    expect(html).toContain("Official Registration Identifier");
    expect(html).toContain("Policies and Terms URL");

    /* An approved application has nothing to withdraw yet. */
    expect(adminApplicationDetailHtml(application())).not.toContain(
      "Withdraw notification",
    );
  });

  it("shows both records once the notification has been withdrawn", () => {
    const record = (sequenceNumber: number) => ({
      listKey: "eu_test",
      sequenceNumber,
      manifestSha256: "a".repeat(64),
      compactJadesSha256: "b".repeat(64),
      publicationTimestamp: "2026-07-30T09:00:00Z",
    });
    const html = adminApplicationDetailHtml({
      ...application({}, "withdrawn"),
      approvedAt: "2026-07-30T09:00:00Z",
      publication: record(1),
      withdrawal: record(2),
      withdrawnAt: "2026-08-30T09:00:00Z",
    } as TrustedEntityApplication);
    expect(html).toContain("Publication Record");
    expect(html).toContain("Withdrawal Record");
    expect(html).toContain("has been withdrawn");
    expect(html).not.toContain("Withdraw notification");
  });
});

// ============================================================
// 10. WE BUILD evaluation as a negative fixture
// ============================================================
describe("WE BUILD Pub-EAA evaluation", () => {
  /**
   * `HITL/WP4-LoTE_evaluation.json` is the Trust Inspector's own report on the
   * WE BUILD WP4 LoTL. It is used only as a negative fixture: the Annex H rules
   * it records as failing are exactly the rules this profile satisfies. It is
   * never a signing oracle and never an example to copy.
   */
  const evaluationPath = resolve(
    import.meta.dirname,
    "..",
    "HITL",
    "WP4-LoTE_evaluation.json",
  );

  interface Check {
    id: string;
    status: string;
    evidence?: Record<string, unknown>;
  }

  function pubEaaChecks(): Check[] {
    const raw = JSON.parse(readFileSync(evaluationPath, "utf-8")) as {
      results?: Array<{ ts119602?: { checks?: Check[] } }>;
    };
    return (raw.results ?? []).flatMap((result) =>
      (result.ts119602?.checks ?? []).filter((check) =>
        check.id.startsWith("ts119602.profile.pub_eaa_providers."),
      ),
    );
  }

  it("records the Annex H rules this profile now satisfies as failing there", () => {
    const checks = pubEaaChecks();
    expect(checks.length).toBeGreaterThan(0);
    const schemeInformation = checks.find(
      (check) => check.id.endsWith(".scheme_information") && check.evidence,
    );
    expect(schemeInformation?.status).toBe("fail");
    const evidence = schemeInformation!.evidence as {
      historyPeriod: { expected: number; valid: boolean };
      pointers: { expected: string };
    };
    /* WE BUILD omits the history period; this publisher emits it. */
    expect(evidence.historyPeriod).toMatchObject({
      expected: PUB_EAA_HISTORICAL_INFORMATION_PERIOD,
      valid: false,
    });
    expect(evidence.pointers.expected).toBe("absent");
    expect(
      document().LoTE.ListAndSchemeInformation.HistoricalInformationPeriod,
    ).toBe(evidence.historyPeriod.expected);
  });

  it("records the entity rules this profile now satisfies as failing there", () => {
    const entity = pubEaaChecks().find(
      (check) => check.id.endsWith(".trusted_entity") && check.evidence,
    );
    expect(entity?.status).toBe("fail");
    const results = (
      entity!.evidence as {
        results: Array<{
          telephonePresent: boolean;
          countryRoleUriPresent: boolean;
          pubEaaLawReferencePresent: boolean;
        }>;
      }
    ).results;
    for (const result of results) {
      expect(result.telephonePresent).toBe(false);
      expect(result.countryRoleUriPresent).toBe(false);
      expect(result.pubEaaLawReferencePresent).toBe(false);
    }
    /* All three are present in their Annex H components. */
    const information =
      document().LoTE.TrustedEntitiesList![0]!.TrustedEntityInformation;
    expect(
      information.TEAddress.TEElectronicAddress.some((uri) =>
        uri.uriValue.startsWith(PUB_EAA_PROVIDER_ROLE_URI_PREFIX),
      ),
    ).toBe(true);
    expect(
      information.TETradeName?.some((name) => name.value.startsWith("OJ:")),
    ).toBe(true);
    expect(
      information.TEAddress.TEElectronicAddress.some((address) =>
        address.uriValue.startsWith("tel:"),
      ),
    ).toBe(true);
  });

  it("confirms the service type and status URIs the Inspector expects", () => {
    const service = pubEaaChecks().find(
      (check) => check.id.endsWith(".service") && check.evidence,
    );
    const first = (
      service!.evidence as {
        results: Array<{
          type: { allowed: string[] };
          status: { observed: string; rule: string };
          certificateRequirement: string;
          history: { pubEaaSkiOnlyRule: boolean };
        }>;
      }
    ).results[0]!;
    expect(first.type.allowed).toEqual([
      PUB_EAA_SERVICE_TYPE_ISSUANCE,
      PUB_EAA_SERVICE_TYPE_REVOCATION,
    ]);
    expect(first.status.observed).toBe(PUB_EAA_SVC_STATUS_NOTIFIED);
    expect(first.status.rule).toBe("pub_eaa");
    /* The certificate is optional in Annex H, which this profile mirrors. */
    expect(first.certificateRequirement).toBe("optional_pub_eaa");
    expect(getProfile(FAMILY).requiresServiceCertificate).toBe(false);
    expect(first.history.pubEaaSkiOnlyRule).toBe(true);
  });
});
