import { describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { compileForProfile } from "../src/core/compile/compile.js";
import { validateEtsiStruct } from "../src/core/validate/validate.js";
import {
  ApplicationService,
  AuthoringStore,
  normalizeToAuthoringInput,
  parseAndValidateSubmission,
  type RegistrarApplicantData,
  type SchemeDescriptor,
  type SigningConfig,
  type TrustedEntityApplication,
} from "../src/core/authoring/index.js";
import { PublicationStore } from "../src/core/publication/store.js";
import { getEnabledProfile } from "../src/core/profiles/registry.js";
import {
  REGISTRARS_LOTE_TYPE,
  REGISTRARS_SCHEME_RULES,
  REGISTRARS_STATUS_DETN,
  REGISTER_SERVICE_TYPE,
} from "../src/core/profiles/registrars/constants.js";
import { registrarFormHtml } from "../src/web/views/onboarding.js";
import { adminApplicationDetailHtml } from "../src/web/views/admin.js";
import type { LoTEDocument } from "../src/core/model/types.js";

const FAMILY = "registrars";
const fixture = (name: string) =>
  readFileSync(resolve(import.meta.dirname, "fixtures", name), "utf-8");
const TEST_CERT = fixture("test-cert.pem");
const TEST_CERT_PATH = resolve(
  import.meta.dirname,
  "fixtures",
  "test-cert.pem",
);
const TEST_KEY_PATH = resolve(import.meta.dirname, "fixtures", "test-key.pem");
const ISSUE = "2026-07-30T09:00:00.000Z";
const NEXT = "2027-01-29T09:00:00.000Z";

const scheme = (): SchemeDescriptor => ({
  schemeOperatorName: "Test",
  schemeOperatorStreet: "1 Scheme Street",
  schemeOperatorCountry: "IT",
  schemeOperatorEmail: "trustedlists@scheme.example",
  schemeOperatorWebsite: "https://scheme.example",
  schemeName: "Test Registrars and Registers List",
  schemeTerritory: "EU",
  schemeInformationUris: [
    "https://scheme.example/information",
    "https://scheme.example/previous-versions",
  ],
  policyUri: "https://scheme.example/policy",
  distributionPointUri: "https://scheme.example/latest",
  signerCertificates: [TEST_CERT],
});

function applicant(
  overrides: Partial<RegistrarApplicantData> = {},
): RegistrarApplicantData {
  return {
    entityName: "Test",
    entityStreetAddress: "1 Registrar Street",
    entityLocality: "Rome",
    entityPostalCode: "00100",
    entityCountry: "IT",
    entityInformationURI: "https://registrar.example/policy",
    entityEmail: "registrar@example.test",
    entityTelephone: "+39 02 1234567",
    responsibleMemberState: "IT",
    services: [
      {
        serviceType: "register",
        serviceName: "Primary Register",
        serviceSupplyPoint: "https://register.example/data",
        certificatePem: TEST_CERT,
      },
      {
        serviceType: "register",
        serviceName: "Secondary Register",
        serviceSupplyPoint: "https://register.example/secondary-data",
        certificatePem: TEST_CERT,
      },
    ],
    ...overrides,
  };
}

function application(
  overrides: Partial<RegistrarApplicantData> = {},
): TrustedEntityApplication {
  return {
    id: "registrar-application",
    schemaVersion: 1,
    family: FAMILY,
    targetListKey: "eu_test",
    state: "approved",
    submittedAt: ISSUE,
    approvedAt: ISSUE,
    applicantData: applicant(overrides),
  } as TrustedEntityApplication;
}

function document(
  overrides: Partial<RegistrarApplicantData> = {},
): LoTEDocument {
  return compileForProfile(
    FAMILY,
    normalizeToAuthoringInput(application(overrides), scheme(), ISSUE, NEXT, 1),
  ).document;
}

const fields = (
  overrides: Record<string, string> = {},
): Record<string, string> => ({
  entityName: "Test",
  entityStreetAddress: "1 Registrar Street",
  entityCountry: "IT",
  entityEmail: "registrar@example.test",
  entityTelephone: "+39 02 1234567",
  responsibleMemberState: "IT",
  entityPolicyURI: "https://registrar.example/policy",
  "service[0].serviceType": "register",
  "service[0].serviceName": "Primary Register",
  "service[0].serviceSupplyPoint": "https://register.example/data",
  "service[0].certificatePem": TEST_CERT,
  "service[1].serviceType": "register",
  "service[1].serviceName": "Secondary Register",
  "service[1].serviceSupplyPoint": "https://register.example/secondary-data",
  "service[1].certificatePem": TEST_CERT,
  ...overrides,
});

const signingConfig = (): SigningConfig => ({
  lists: [
    {
      listKey: "eu_test",
      family: FAMILY,
      schemeOperatorName: "Test",
      schemeOperatorStreet: "1 Scheme Street",
      schemeOperatorCountry: "IT",
      schemeName: "Test Registrars and Registers List",
      schemeTerritory: "EU",
      schemeOperatorContactUri: "https://scheme.example",
      distributionPointUri: "https://scheme.example/latest",
      keyFile: TEST_KEY_PATH,
      certFile: TEST_CERT_PATH,
      schemeOperatorEmail: "trustedlists@scheme.example",
      schemeOperatorWebsite: "https://scheme.example",
      schemeInformationUris: [
        "https://scheme.example/information",
        "https://scheme.example/previous-versions",
      ],
      policyUri: "https://scheme.example/policy",
    },
  ],
});

function temporaryDirectory() {
  const path = join(tmpdir(), `tlp-annexi-${randomBytes(8).toString("hex")}`);
  mkdirSync(path, { recursive: true });
  return path;
}

describe("Annex I Registrars and Registers", () => {
  it("publishes the fixed Annex I structure for multiple Registers", async () => {
    const profile = getEnabledProfile(FAMILY);
    expect(profile).toMatchObject({
      loTEType: REGISTRARS_LOTE_TYPE,
      statusDeterminationApproach: REGISTRARS_STATUS_DETN,
      schemeRules: REGISTRARS_SCHEME_RULES,
      maxNextUpdateMonths: 6,
      fixedSchemeTerritory: "EU",
      publishesSelfPointer: true,
      usesServiceStatus: false,
    });

    const result = document();
    const info = result.LoTE.ListAndSchemeInformation;
    expect(info.LoTEVersionIdentifier).toBe(1);
    expect(info.LoTESequenceNumber).toBe(1);
    expect(info.HistoricalInformationPeriod).toBeUndefined();
    expect(info.SchemeInformationURI).toHaveLength(2);
    expect(info.PointersToOtherLoTE?.[0]?.LoTELocation).toBe(
      info.DistributionPoints?.[0],
    );

    const entity = result.LoTE.TrustedEntitiesList?.[0]!;
    expect(entity.TrustedEntityInformation.TEInformationURI[0]?.uriValue).toBe(
      "https://registrar.example/policy",
    );
    expect(entity.TrustedEntityInformation.TEInformationURI[1]?.uriValue).toBe(
      "http://uri.etsi.org/19602/ListOfTrustedEntities/Registrar/IT",
    );
    expect(entity.TrustedEntityServices).toHaveLength(2);
    for (const service of entity.TrustedEntityServices) {
      expect(service.ServiceInformation.ServiceTypeIdentifier).toBe(
        REGISTER_SERVICE_TYPE,
      );
      expect(
        service.ServiceInformation.ServiceSupplyPoints?.[0]?.uriValue,
      ).toMatch(/^https:\/\//);
      expect(
        service.ServiceInformation.ServiceDigitalIdentity.X509Certificates,
      ).toHaveLength(1);
      expect(service.ServiceInformation.ServiceStatus).toBeUndefined();
      expect(service.ServiceInformation.StatusStartingTime).toBeUndefined();
    }
    expect((await validateEtsiStruct(result)).valid).toBe(true);
  });

  it("validates Registrar submission fields and certificate identity", () => {
    const validate = (overrides: Record<string, string> = {}) =>
      parseAndValidateSubmission(fields(overrides), "eu_test", FAMILY).valid;

    expect(validate()).toBe(true);
    expect(validate({ "service[0].serviceSupplyPoint": "" })).toBe(false);
    expect(validate({ "service[0].serviceSupplyPoint": "not a URI" })).toBe(
      false,
    );
    expect(validate({ "service[0].certificatePem": "not a certificate" })).toBe(
      false,
    );
    expect(validate({ entityName: "Different Registrar" })).toBe(false);
    expect(validate({ registrationIdentifier: "REG-123" })).toBe(false);
    expect(validate({ "service[0].serviceType": "issuance" })).toBe(false);
  });

  it("publishes removal as an immutable successor without a withdrawn status", async () => {
    const root = temporaryDirectory();
    try {
      const publicationStore = new PublicationStore({
        publicationDir: join(root, "publications"),
      });
      const service = new ApplicationService(
        new AuthoringStore({ authoringDir: join(root, "authoring") }),
        publicationStore,
        signingConfig(),
      );
      const app = service.createApp("eu_test", applicant(), FAMILY);
      expect(service.approve(app.id).success).toBe(true);
      expect((await service.publishApplication(app.id)).success).toBe(true);
      const removal = await service.removeRegistrarApplication(app.id);
      if (!removal.success) throw new Error(removal.error);
      expect(removal.success).toBe(true);
      expect(removal.data.state).toBe("removed");
      expect(removal.data.publication?.sequenceNumber).toBe(1);
      expect(removal.data.removal?.sequenceNumber).toBe(2);

      const first = JSON.parse(
        (await publicationStore.loadVersionBytes("eu_test", 1, "lote"))!,
      ) as LoTEDocument;
      const second = JSON.parse(
        (await publicationStore.loadVersionBytes("eu_test", 2, "lote"))!,
      ) as LoTEDocument;
      expect(first.LoTE.TrustedEntitiesList).toHaveLength(1);
      expect(second.LoTE.TrustedEntitiesList).toBeUndefined();
      expect(second.LoTE.ListAndSchemeInformation.LoTESequenceNumber).toBe(2);
      expect(
        second.LoTE.ListAndSchemeInformation.HistoricalInformationPeriod,
      ).toBeUndefined();
      for (const artifact of ["lote", "signature", "manifest"] as const)
        expect(
          await publicationStore.loadVersionBytes("eu_test", 2, artifact),
        ).toBeTruthy();
      expect((await validateEtsiStruct(second)).valid).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("offers Registrar onboarding and controlled removal in administration", () => {
    const form = registrarFormHtml({}, {}, []);
    expect(form).toContain("/onboarding/registrar");
    expect(form).toContain("Register URL");
    const html = adminApplicationDetailHtml({
      ...application(),
      state: "published",
      publication: {
        listKey: "eu_test",
        sequenceNumber: 1,
        publicationTimestamp: ISSUE,
        compactJadesSha256: "a".repeat(64),
        manifestSha256: "b".repeat(64),
      },
    });
    expect(html).toContain("Remove Registrar");
    expect(html).not.toContain("Withdraw notification");
  });
});
