import { afterAll, describe, it, expect, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { IncomingMessage } from "node:http";
import { get as httpGetRaw, request as httpRequestRaw } from "node:http";
import { compileForProfile } from "../src/core/compile/compile.js";
import { validateEtsiStruct } from "../src/core/validate/validate.js";
import {
  ApplicationService,
  AuthoringStore,
  buildAuthoringEntity,
  checkLosslessPreservation,
  checkServiceIdentifierUniqueness,
  convertLoTEToAuthoringEntities,
  createTrustedList,
  LIST_FAMILIES,
  getEnabledFamilies,
  normalizeToAuthoringInput,
  parseAndValidateSubmission,
  type SchemeDescriptor,
  type TrustedEntityApplication,
  type WalletRelyingPartyApplicantData,
} from "../src/core/authoring/index.js";
import { PublicationStore } from "../src/core/publication/store.js";
import { InspectorClient } from "../src/core/inspector/inspector.js";
import {
  getEnabledProfile,
  getProfile,
  PROFILE_REGISTRY,
} from "../src/core/profiles/registry.js";
import {
  WRPAC_PROVIDER_LOTE_TYPE,
  WRPAC_PROVIDER_ROLE_URI_PREFIX,
  WRPAC_PROVIDER_SCHEME_RULES,
  WRPAC_PROVIDER_STATUS_DETN,
  WRPAC_SERVICE_TYPE_ISSUANCE,
  WRPAC_SERVICE_TYPE_REVOCATION,
} from "../src/core/profiles/wrpac-provider/constants.js";
import {
  WRPRC_PROVIDER_LOTE_TYPE,
  WRPRC_PROVIDER_ROLE_URI_PREFIX,
  WRPRC_PROVIDER_SCHEME_RULES,
  WRPRC_PROVIDER_STATUS_DETN,
  WRPRC_SERVICE_TYPE_ISSUANCE,
  WRPRC_SERVICE_TYPE_REVOCATION,
} from "../src/core/profiles/wrprc-provider/constants.js";
import {
  certificateDerBase64,
  isStrictBase64,
} from "../src/core/model/lexical.js";
import { createWebServer, type ServerConfig } from "../src/web/server.js";
import {
  onboardingCatalogueHtml,
  wrpacProviderFormHtml,
  wrprcProviderFormHtml,
} from "../src/web/views/onboarding.js";
import { createListFormHtml } from "../src/web/views/list-creation.js";
import { adminApplicationDetailHtml } from "../src/web/views/admin.js";
import { parseInspectorEvaluation } from "../src/web/views/inspector-panel.js";
import type { LoTEDocument } from "../src/core/model/types.js";

const fixture = (name: string): string =>
  readFileSync(resolve(import.meta.dirname, "fixtures", name), "utf-8");

const TEST_CERT = fixture("test-cert.pem");
const TEST_CERT_PATH = resolve(
  import.meta.dirname,
  "fixtures",
  "test-cert.pem",
);
const TEST_KEY_PATH = resolve(import.meta.dirname, "fixtures", "test-key.pem");
/** Subject organisation of test-cert.pem. */
const CERT_ORGANISATION = "Test";

type RelyingPartyFamily = "wrpac-providers" | "wrprc-providers";
const RELYING_PARTY_FAMILIES: readonly RelyingPartyFamily[] = [
  "wrpac-providers",
  "wrprc-providers",
];

const scheme = (family: RelyingPartyFamily): SchemeDescriptor => ({
  schemeOperatorName: CERT_ORGANISATION,
  schemeOperatorStreet: "1 Scheme Street",
  schemeOperatorCountry: "IT",
  schemeOperatorEmail: "trustedlists@scheme.example",
  schemeOperatorWebsite: "https://scheme.example",
  schemeName: `Test ${family} List`,
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
  overrides: Partial<WalletRelyingPartyApplicantData> = {},
): WalletRelyingPartyApplicantData {
  return {
    entityName: CERT_ORGANISATION,
    entityStreetAddress: "1 Entity Street",
    entityLocality: "Warsaw",
    entityPostalCode: "00-001",
    entityCountry: "IT",
    entityInformationURI: "https://entity.example/policies",
    entityEmail: "trust@entity.example",
    entityTelephone: "+39 02 1234567",
    responsibleMemberState: "PL",
    registrationIdentifier: "NTRPL-0000123456",
    additionalInformationURI: "https://entity.example/info",
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
  family: RelyingPartyFamily,
  overrides: Partial<WalletRelyingPartyApplicantData> = {},
): TrustedEntityApplication {
  return {
    id: "app",
    schemaVersion: 1,
    family,
    targetListKey: "eu_test",
    state: "approved",
    submittedAt: "2026-07-30T09:00:00Z",
    applicantData: applicantData(overrides),
  };
}

function document(
  family: RelyingPartyFamily,
  overrides: Partial<WalletRelyingPartyApplicantData> = {},
): LoTEDocument {
  const input = normalizeToAuthoringInput(
    application(family, overrides),
    scheme(family),
    "2026-07-30T09:00:00.123Z",
    "2027-01-26T09:00:00.456Z",
    1,
  );
  return compileForProfile(family, input).document;
}

function tmpDir(): string {
  const path = join(tmpdir(), `tlp-annexfg-${randomBytes(8).toString("hex")}`);
  mkdirSync(path, { recursive: true });
  return path;
}

const wrpacCertificateDir = tmpDir();
const emptyOpenSslConfig = join(wrpacCertificateDir, "empty-openssl.cnf");
writeFileSync(emptyOpenSslConfig, "", "utf-8");
let wrpacCertificateSequence = 0;

function selfSignedCertificate(extensions: readonly string[]): string {
  const prefix = join(
    wrpacCertificateDir,
    `self-signed-${++wrpacCertificateSequence}`,
  );
  const key = `${prefix}-key.pem`;
  const certificate = `${prefix}-cert.pem`;
  execFileSync(
    "openssl",
    [
      "req",
      "-new",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:P-256",
      "-nodes",
      "-x509",
      "-keyout",
      key,
      "-out",
      certificate,
      "-days",
      "365",
      "-sha256",
      "-subj",
      "/C=EU/O=Test/CN=WRPAC test CA",
      "-config",
      emptyOpenSslConfig,
      ...extensions.flatMap((extension) => ["-addext", extension]),
    ],
    { stdio: "ignore" },
  );
  return readFileSync(certificate, "utf-8");
}

function issuedCertificate(
  extensions: readonly string[],
  selfIssued = false,
  reuseIssuerKey = false,
): string {
  const prefix = join(
    wrpacCertificateDir,
    `issued-${++wrpacCertificateSequence}`,
  );
  const issuerKey = `${prefix}-issuer-key.pem`;
  const issuerCertificate = `${prefix}-issuer-cert.pem`;
  const issuerSubject = "/C=EU/O=Test/CN=WRPAC issuer";
  execFileSync(
    "openssl",
    [
      "req",
      "-new",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:P-256",
      "-nodes",
      "-x509",
      "-keyout",
      issuerKey,
      "-out",
      issuerCertificate,
      "-days",
      "365",
      "-sha256",
      "-subj",
      issuerSubject,
      "-config",
      emptyOpenSslConfig,
      "-addext",
      "basicConstraints=critical,CA:TRUE",
      "-addext",
      "keyUsage=critical,keyCertSign",
      "-addext",
      "subjectKeyIdentifier=hash",
    ],
    { stdio: "ignore" },
  );

  const key = `${prefix}-key.pem`;
  const request = `${prefix}.csr`;
  const certificate = `${prefix}-cert.pem`;
  const extensionFile = `${prefix}.ext`;
  execFileSync(
    "openssl",
    [
      "req",
      "-new",
      ...(reuseIssuerKey
        ? ["-key", issuerKey]
        : [
            "-newkey",
            "ec",
            "-pkeyopt",
            "ec_paramgen_curve:P-256",
            "-nodes",
            "-keyout",
            key,
          ]),
      "-out",
      request,
      "-subj",
      selfIssued ? issuerSubject : "/C=EU/O=Test/CN=WRPAC subordinate CA",
      "-config",
      emptyOpenSslConfig,
    ],
    { stdio: "ignore" },
  );
  writeFileSync(extensionFile, `${extensions.join("\n")}\n`, "utf-8");
  execFileSync(
    "openssl",
    [
      "x509",
      "-req",
      "-in",
      request,
      "-CA",
      issuerCertificate,
      "-CAkey",
      issuerKey,
      "-CAcreateserial",
      "-out",
      certificate,
      "-days",
      "365",
      "-sha256",
      "-extfile",
      extensionFile,
    ],
    { stdio: "ignore" },
  );
  return readFileSync(certificate, "utf-8");
}

const VALID_RELYING_PARTY_CA_CERTIFICATE = selfSignedCertificate([
  "basicConstraints=critical,CA:TRUE",
  "keyUsage=critical,keyCertSign,cRLSign",
  "subjectKeyIdentifier=01:02:03:04",
]);

afterAll(() => rmSync(wrpacCertificateDir, { recursive: true, force: true }));

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
  family?: RelyingPartyFamily,
): Record<string, string> => ({
  entityName: CERT_ORGANISATION,
  entityStreetAddress: "1 Entity Street",
  entityCountry: "IT",
  entityEmail: "trust@entity.example",
  entityTelephone: "+39 02 1234567",
  responsibleMemberState: "PL",
  entityPolicyURI: "https://entity.example/policies",
  "service[0].serviceType": "issuance",
  "service[0].serviceName": "Issuance",
  "service[0].certificatePem":
    family === undefined ? TEST_CERT : VALID_RELYING_PARTY_CA_CERTIFICATE,
  ...overrides,
});

function wrpacCertificateError(certificate: string): string | undefined {
  const parsed = parseAndValidateSubmission(
    submissionFields({ "service[0].certificatePem": certificate }),
    "eu_test",
    "wrpac-providers",
  );
  if (parsed.valid) return undefined;
  return parsed.errors.find(
    (error) => error.field === "service[0].certificatePem",
  )?.message;
}

// ============================================================
// 1. Catalogue and profile registry
// ============================================================
describe("TS 119 602 family catalogue", () => {
  it("exposes the six families in annex order", () => {
    expect(LIST_FAMILIES.map((family) => [family.key, family.label])).toEqual([
      ["pid-providers", "PID Providers"],
      ["wallet-providers", "Wallet Providers"],
      ["wrpac-providers", "WRPAC Providers"],
      ["wrprc-providers", "WRPRC Providers"],
      ["pub-eaa-providers", "Pub-EAA Providers"],
      ["registrars", "Registrars and Registers"],
    ]);
  });

  it("no longer carries the Non-qualified EAA or QEAA entries", () => {
    expect(Object.keys(PROFILE_REGISTRY)).not.toContain(
      "non-qualified-eaa-providers",
    );
    expect(Object.keys(PROFILE_REGISTRY)).not.toContain("qeaa-providers");
  });

  it("enables five families and disables Registrars", () => {
    expect(getEnabledFamilies().map((family) => family.key)).toEqual([
      "pid-providers",
      "wallet-providers",
      "wrpac-providers",
      "wrprc-providers",
      "pub-eaa-providers",
    ]);
    for (const family of ["registrars"]) {
      expect(PROFILE_REGISTRY[family as "registrars"].enabled).toBe(false);
      expect(() => getProfile(family)).toThrow(/not implemented/);
    }
  });
});

describe("Annex F WRPAC profile", () => {
  it("carries the Annex F URIs and constraints", () => {
    const profile = getEnabledProfile("wrpac-providers");
    expect(profile).toMatchObject({
      family: "wrpac-providers",
      enabled: true,
      loTEType: "http://uri.etsi.org/19602/LoTEType/EUWRPACProvidersList",
      statusDeterminationApproach:
        "http://uri.etsi.org/19602/WRPACProvidersList/StatusDetn/EU",
      schemeRules:
        "http://uri.etsi.org/19602/WRPACProvidersList/schemerules/EU",
      roleUriPrefix:
        "http://uri.etsi.org/19602/ListOfTrustedEntities/WRPACProvider",
      maxNextUpdateMonths: 6,
      requiresServiceUniqueIdentifier: false,
      roleCountrySource: "responsible-member-state",
      signatureProfile: "JAdES-Compact-B",
    });
    expect(profile.allowedServiceTypes).toEqual([
      "http://uri.etsi.org/19602/SvcType/WRPAC/Issuance",
      "http://uri.etsi.org/19602/SvcType/WRPAC/Revocation",
    ]);
  });

  it("exports the same URIs as constants", () => {
    expect([
      WRPAC_PROVIDER_LOTE_TYPE,
      WRPAC_PROVIDER_STATUS_DETN,
      WRPAC_PROVIDER_SCHEME_RULES,
      WRPAC_PROVIDER_ROLE_URI_PREFIX,
      WRPAC_SERVICE_TYPE_ISSUANCE,
      WRPAC_SERVICE_TYPE_REVOCATION,
    ]).toEqual([
      "http://uri.etsi.org/19602/LoTEType/EUWRPACProvidersList",
      "http://uri.etsi.org/19602/WRPACProvidersList/StatusDetn/EU",
      "http://uri.etsi.org/19602/WRPACProvidersList/schemerules/EU",
      "http://uri.etsi.org/19602/ListOfTrustedEntities/WRPACProvider",
      "http://uri.etsi.org/19602/SvcType/WRPAC/Issuance",
      "http://uri.etsi.org/19602/SvcType/WRPAC/Revocation",
    ]);
  });
});

describe("Annex G WRPRC profile", () => {
  it("carries the Annex G URIs and constraints", () => {
    const profile = getEnabledProfile("wrprc-providers");
    expect(profile).toMatchObject({
      family: "wrprc-providers",
      enabled: true,
      loTEType: "http://uri.etsi.org/19602/LoTEType/EUWRPRCProvidersList",
      schemeRules:
        "http://uri.etsi.org/19602/WRPRCProvidersList/schemerules/EU",
      roleUriPrefix:
        "http://uri.etsi.org/19602/ListOfTrustedEntities/WRPRCProvider",
      maxNextUpdateMonths: 6,
      requiresServiceUniqueIdentifier: false,
      roleCountrySource: "responsible-member-state",
    });
    expect(profile.allowedServiceTypes).toEqual([
      "http://uri.etsi.org/19602/SvcType/WRPRC/Issuance",
      "http://uri.etsi.org/19602/SvcType/WRPRC/Revocation",
    ]);
  });

  /*
    Annex G prints the status-determination URI without the P of Providers.
    Reproducing it verbatim is the whole point of this assertion: a reader
    matches the URI literally.
  */
  it("preserves the Annex G WRPRCrovidersList literal", () => {
    expect(WRPRC_PROVIDER_STATUS_DETN).toBe(
      "http://uri.etsi.org/19602/WRPRCrovidersList/StatusDetn/EU",
    );
    expect(WRPRC_PROVIDER_STATUS_DETN).not.toContain("WRPRCProvidersList");
    expect(
      getEnabledProfile("wrprc-providers").statusDeterminationApproach,
    ).toBe(WRPRC_PROVIDER_STATUS_DETN);
    expect(WRPRC_PROVIDER_LOTE_TYPE).toContain("EUWRPRCProvidersList");
    expect(WRPRC_PROVIDER_SCHEME_RULES).toContain("WRPRCProvidersList");
  });
});

// ============================================================
// 2. Generated documents
// ============================================================
describe("Annex F/G generation", () => {
  const expectations: Record<
    RelyingPartyFamily,
    { loTEType: string; statusDetn: string; rules: string; role: string }
  > = {
    "wrpac-providers": {
      loTEType: WRPAC_PROVIDER_LOTE_TYPE,
      statusDetn: WRPAC_PROVIDER_STATUS_DETN,
      rules: WRPAC_PROVIDER_SCHEME_RULES,
      role: `${WRPAC_PROVIDER_ROLE_URI_PREFIX}/PL`,
    },
    "wrprc-providers": {
      loTEType: WRPRC_PROVIDER_LOTE_TYPE,
      statusDetn: WRPRC_PROVIDER_STATUS_DETN,
      rules: WRPRC_PROVIDER_SCHEME_RULES,
      role: `${WRPRC_PROVIDER_ROLE_URI_PREFIX}/PL`,
    },
  };

  for (const family of RELYING_PARTY_FAMILIES) {
    const expected = expectations[family];

    it(`${family}: emits the profile constants, EU territory and version 1`, () => {
      const info = document(family).LoTE.ListAndSchemeInformation;
      expect(info.LoTEType).toBe(expected.loTEType);
      expect(info.StatusDeterminationApproach).toBe(expected.statusDetn);
      expect(info.SchemeTypeCommunityRules).toEqual([
        { lang: "en", uriValue: expected.rules },
      ]);
      expect(info.SchemeTerritory).toBe("EU");
      expect(info.LoTEVersionIdentifier).toBe(1);
      expect(info.HistoricalInformationPeriod).toBeUndefined();
      expect(info.ListIssueDateTime).toBe("2026-07-30T09:00:00Z");
      expect(info.NextUpdate).toBe("2027-01-26T09:00:00Z");
    });

    it(`${family}: points at itself with the signing certificate`, () => {
      const pointers =
        document(family).LoTE.ListAndSchemeInformation.PointersToOtherLoTE;
      expect(pointers).toHaveLength(1);
      const pointer = pointers?.[0];
      expect(pointer?.LoTELocation).toBe("https://scheme.example/latest");
      expect(pointer?.LoTEQualifiers[0]).toMatchObject({
        LoTEType: expected.loTEType,
        SchemeTerritory: "EU",
        MimeType: "application/jose",
      });
      expect(
        pointer?.ServiceDigitalIdentities[0]?.X509Certificates?.[0]?.val,
      ).toBe(certificateDerBase64(TEST_CERT));
    });

    it(`${family}: publishes the role URI of the Responsible Member State`, () => {
      const entity = document(family).LoTE.TrustedEntitiesList?.[0];
      const uris = entity?.TrustedEntityInformation.TEInformationURI.map(
        (uri) => uri.uriValue,
      );
      expect(uris).toEqual([
        "https://entity.example/policies",
        expected.role,
        "https://entity.example/info",
      ]);
      // The entity's own country is IT; the role URI names the mandating state.
      expect(uris?.[1]).not.toContain("/IT");
      expect(
        entity?.TrustedEntityInformation.TEAddress.TEElectronicAddress.map(
          (address) => address.uriValue,
        ),
      ).toEqual([
        "mailto:trust@entity.example",
        "https://entity.example/policies",
        "tel:+39021234567",
      ]);
    });

    it(`${family}: omits the service unique identifier extension`, () => {
      const services =
        document(family).LoTE.TrustedEntitiesList?.[0]?.TrustedEntityServices ??
        [];
      expect(services).toHaveLength(2);
      for (const service of services) {
        expect(
          service.ServiceInformation.ServiceInformationExtensions,
        ).toBeUndefined();
        expect(service.ServiceInformation.ServiceStatus).toBeUndefined();
        expect(service.ServiceInformation.StatusStartingTime).toBeUndefined();
        expect(service.ServiceHistory).toBeUndefined();
        const value =
          service.ServiceInformation.ServiceDigitalIdentity
            .X509Certificates?.[0]?.val ?? "";
        expect(isStrictBase64(value)).toBe(true);
        expect(value).not.toContain("BEGIN CERTIFICATE");
      }
      expect(
        services.map(
          (service) => service.ServiceInformation.ServiceTypeIdentifier,
        ),
      ).toEqual(
        family === "wrpac-providers"
          ? [WRPAC_SERVICE_TYPE_ISSUANCE, WRPAC_SERVICE_TYPE_REVOCATION]
          : [WRPRC_SERVICE_TYPE_ISSUANCE, WRPRC_SERVICE_TYPE_REVOCATION],
      );
    });

    it(`${family}: omits the optional additional information URI when absent`, () => {
      const entity = document(family, {
        additionalInformationURI: undefined,
        registrationIdentifier: undefined,
      }).LoTE.TrustedEntitiesList?.[0];
      expect(
        entity?.TrustedEntityInformation.TEInformationURI.map(
          (uri) => uri.uriValue,
        ),
      ).toEqual(["https://entity.example/policies", expected.role]);
    });

    it(`${family}: validates against the pinned ETSI schema`, async () => {
      const result = await validateEtsiStruct(document(family));
      expect(result.findings).toEqual([]);
      expect(result.valid).toBe(true);
    });

    it(`${family}: refuses another family's service type`, () => {
      const foreign = buildAuthoringEntity(applicantData(), family);
      const foreignService = foreign.services[0]!;
      foreignService.serviceTypeIdentifier =
        "http://uri.etsi.org/19602/SvcType/PID/Issuance";
      expect(() =>
        compileForProfile(family, {
          ...normalizeToAuthoringInput(
            application(family),
            scheme(family),
            "2026-07-30T09:00:00Z",
            "2027-01-26T09:00:00Z",
            1,
          ),
          entities: [foreign],
        }),
      ).toThrow(/not allowed/);
    });

    it(`${family}: round-trips an entity that has no service identifiers`, () => {
      const generated = document(family);
      const converted = convertLoTEToAuthoringEntities(generated);
      expect(
        converted[0]?.services[0]?.serviceUniqueIdentifier,
      ).toBeUndefined();
      expect(
        checkLosslessPreservation(
          generated.LoTE.TrustedEntitiesList ?? [],
          converted,
          family,
        ),
      ).toEqual({ ok: true });
    });
  }

  it("does not treat two identifier-less services as duplicates", () => {
    const entity = buildAuthoringEntity(applicantData(), "wrpac-providers");
    expect(checkServiceIdentifierUniqueness([entity], entity)).toEqual({
      ok: true,
    });
  });
});

// ============================================================
// 3. Submission parsing
// ============================================================
describe("Annex F/G submission parsing", () => {
  it("rejects a WRPAC certificate whose basic constraints do not identify a CA", () => {
    const certificate = selfSignedCertificate([
      "basicConstraints=critical,CA:FALSE",
      "keyUsage=critical,keyCertSign",
      "subjectKeyIdentifier=hash",
    ]);
    expect(wrpacCertificateError(certificate)).toContain("basicConstraints");
  });

  it("rejects a WRPRC certificate whose basic constraints do not identify a CA", () => {
    const certificate = selfSignedCertificate([
      "basicConstraints=critical,CA:FALSE",
      "keyUsage=critical,keyCertSign",
      "subjectKeyIdentifier=hash",
    ]);
    const parsed = parseAndValidateSubmission(
      submissionFields(
        { "service[0].certificatePem": certificate },
        "wrprc-providers",
      ),
      "eu_test",
      "wrprc-providers",
    );
    expect(parsed.valid).toBe(false);
    const message = parsed.valid
      ? ""
      : parsed.errors.find(
          (error) => error.field === "service[0].certificatePem",
        )?.message;
    expect(message).toContain("WRPRC certificate");
    expect(message).toContain("basicConstraints");
  });

  it("rejects a WRPAC CA certificate whose basic constraints are not critical", () => {
    const certificate = selfSignedCertificate([
      "basicConstraints=CA:TRUE",
      "keyUsage=critical,keyCertSign",
      "subjectKeyIdentifier=hash",
    ]);
    expect(wrpacCertificateError(certificate)).toContain(
      "basicConstraints must be critical",
    );
  });

  it("rejects a WRPAC CA certificate without key usage", () => {
    const certificate = selfSignedCertificate([
      "basicConstraints=critical,CA:TRUE",
      "subjectKeyIdentifier=hash",
    ]);
    expect(wrpacCertificateError(certificate)).toContain("keyUsage");
  });

  it("rejects a WRPAC CA certificate whose key usage omits keyCertSign", () => {
    const certificate = selfSignedCertificate([
      "basicConstraints=critical,CA:TRUE",
      "keyUsage=critical,digitalSignature",
      "subjectKeyIdentifier=hash",
    ]);
    expect(wrpacCertificateError(certificate)).toContain("keyCertSign");
  });

  it("rejects a WRPAC CA certificate whose key usage is not critical", () => {
    const certificate = selfSignedCertificate([
      "basicConstraints=critical,CA:TRUE",
      "keyUsage=keyCertSign",
      "subjectKeyIdentifier=hash",
    ]);
    expect(wrpacCertificateError(certificate)).toContain(
      "keyUsage must be critical",
    );
  });

  it("rejects a WRPAC CA certificate without a subject key identifier", () => {
    const certificate = selfSignedCertificate([
      "basicConstraints=critical,CA:TRUE",
      "keyUsage=critical,keyCertSign",
      "subjectKeyIdentifier=none",
    ]);
    expect(wrpacCertificateError(certificate)).toContain(
      "SubjectKeyIdentifier",
    );
  });

  it("rejects a WRPAC CA certificate with a critical subject key identifier", () => {
    const certificate = selfSignedCertificate([
      "basicConstraints=critical,CA:TRUE",
      "keyUsage=critical,keyCertSign",
      "subjectKeyIdentifier=critical,hash",
    ]);
    expect(wrpacCertificateError(certificate)).toContain(
      "SubjectKeyIdentifier must be non-critical",
    );
  });

  it("rejects a non-self-signed WRPAC CA certificate without an authority key identifier", () => {
    const certificate = issuedCertificate([
      "basicConstraints=critical,CA:TRUE",
      "keyUsage=critical,keyCertSign",
      "subjectKeyIdentifier=hash",
      "authorityKeyIdentifier=none",
    ]);
    expect(wrpacCertificateError(certificate)).toContain(
      "AuthorityKeyIdentifier",
    );
  });

  it("rejects an authority key identifier that omits its keyIdentifier", () => {
    const certificate = issuedCertificate([
      "basicConstraints=critical,CA:TRUE",
      "keyUsage=critical,keyCertSign",
      "subjectKeyIdentifier=hash",
      "authorityKeyIdentifier=issuer:always",
    ]);
    expect(wrpacCertificateError(certificate)).toContain("keyIdentifier");
  });

  it("rejects a non-self-signed WRPAC CA certificate with a critical authority key identifier", () => {
    const certificate = issuedCertificate([
      "basicConstraints=critical,CA:TRUE",
      "keyUsage=critical,keyCertSign",
      "subjectKeyIdentifier=hash",
      "authorityKeyIdentifier=critical,keyid",
    ]);
    expect(wrpacCertificateError(certificate)).toContain(
      "AuthorityKeyIdentifier must be non-critical",
    );
  });

  it("rejects a critical authority key identifier on a self-signed WRPAC CA", () => {
    const certificate = issuedCertificate(
      [
        "basicConstraints=critical,CA:TRUE",
        "keyUsage=critical,keyCertSign",
        "subjectKeyIdentifier=hash",
        "authorityKeyIdentifier=critical,keyid",
      ],
      true,
      true,
    );
    expect(wrpacCertificateError(certificate)).toContain(
      "AuthorityKeyIdentifier must be non-critical",
    );
  });

  it("does not mistake a self-issued CA certificate for a self-signed one", () => {
    const certificate = issuedCertificate(
      [
        "basicConstraints=critical,CA:TRUE",
        "keyUsage=critical,keyCertSign",
        "subjectKeyIdentifier=hash",
        "authorityKeyIdentifier=none",
      ],
      true,
    );
    expect(wrpacCertificateError(certificate)).toContain(
      "AuthorityKeyIdentifier",
    );
  });

  it("accepts a non-self-signed WRPAC CA certificate with an authority key identifier", () => {
    const certificate = issuedCertificate([
      "basicConstraints=critical,CA:TRUE",
      "keyUsage=critical,keyCertSign,cRLSign",
      "subjectKeyIdentifier=01:02:03:04",
      "authorityKeyIdentifier=keyid",
    ]);
    expect(wrpacCertificateError(certificate)).toBeUndefined();
  });

  it("rejects an expired WRPAC CA certificate", () => {
    const certificate = selfSignedCertificate([
      "basicConstraints=critical,CA:TRUE",
      "keyUsage=critical,keyCertSign,cRLSign",
      "subjectKeyIdentifier=01:02:03:04",
    ]);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
    try {
      expect(wrpacCertificateError(certificate)).toContain("expired");
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a WRPAC CA certificate that is not yet valid", () => {
    const certificate = selfSignedCertificate([
      "basicConstraints=critical,CA:TRUE",
      "keyUsage=critical,keyCertSign",
      "subjectKeyIdentifier=hash",
    ]);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2020-01-01T00:00:00Z"));
    try {
      expect(wrpacCertificateError(certificate)).toContain("not yet valid");
    } finally {
      vi.useRealTimers();
    }
  });

  for (const family of RELYING_PARTY_FAMILIES) {
    it(`${family}: accepts the collected fields`, () => {
      const parsed = parseAndValidateSubmission(
        submissionFields(
          {
            entityTradeName: "Trade",
            registrationIdentifier: "NTRPL-0000123456",
            additionalInformationURI: "https://entity.example/info",
          },
          family,
        ),
        "eu_test",
        family,
      );
      expect(parsed.valid).toBe(true);
      if (!parsed.valid) return;
      expect(parsed.applicantData).toMatchObject({
        responsibleMemberState: "PL",
        registrationIdentifier: "NTRPL-0000123456",
        additionalInformationURI: "https://entity.example/info",
        entityInformationURI: "https://entity.example/policies",
      });
      expect(parsed.applicantData.services[0]).toEqual({
        serviceType: "issuance",
        serviceName: "Issuance",
        certificatePem: VALID_RELYING_PARTY_CA_CERTIFICATE.trim(),
      });
    });

    it(`${family}: treats the registration identifier and extra URL as optional`, () => {
      const parsed = parseAndValidateSubmission(
        submissionFields({}, family),
        "eu_test",
        family,
      );
      expect(parsed.valid).toBe(true);
      if (!parsed.valid) return;
      expect(parsed.applicantData.registrationIdentifier).toBeUndefined();
      expect(parsed.applicantData.additionalInformationURI).toBeUndefined();
    });

    it(`${family}: requires the Responsible Member State and policies URL`, () => {
      const fields = submissionFields({}, family);
      delete fields.responsibleMemberState;
      delete fields.entityPolicyURI;
      const parsed = parseAndValidateSubmission(fields, "eu_test", family);
      expect(parsed.valid).toBe(false);
      const failed = parsed.valid ? [] : parsed.errors.map((e) => e.field);
      expect(failed).toContain("responsibleMemberState");
      expect(failed).toContain("entityPolicyURI");
    });

    it(`${family}: rejects a malformed additional information URL`, () => {
      const parsed = parseAndValidateSubmission(
        submissionFields({ additionalInformationURI: "not a url" }, family),
        "eu_test",
        family,
      );
      expect(parsed.valid).toBe(false);
      expect(parsed.valid ? [] : parsed.errors[0]?.field).toBe(
        "additionalInformationURI",
      );
    });

    /*
      These profiles have no ServiceUniqueIdentifier, so a posted one is a form
      that has drifted from the parser rather than data to be silently dropped.
    */
    it(`${family}: reports a posted service unique identifier as unknown`, () => {
      const parsed = parseAndValidateSubmission(
        submissionFields(
          {
            "service[0].serviceUniqueIdentifier":
              "https://entity.example/svc/1",
          },
          family,
        ),
        "eu_test",
        family,
      );
      expect(parsed.valid).toBe(false);
      expect(
        parsed.valid
          ? []
          : parsed.errors.map((error) => `${error.field}: ${error.message}`),
      ).toContain("service[0].serviceUniqueIdentifier: Unknown form field.");
    });

    it(`${family}: still requires an X.509 certificate whose O is the entity`, () => {
      const parsed = parseAndValidateSubmission(
        submissionFields({ entityName: "Someone Else" }, family),
        "eu_test",
        family,
      );
      expect(parsed.valid).toBe(false);
      expect(parsed.valid ? "" : parsed.errors[0]?.field).toBe(
        "service[0].certificatePem",
      );
    });
  }

  it("keeps requiring the service unique identifier for Annex D/E", () => {
    const fields = submissionFields();
    delete fields.responsibleMemberState;
    delete fields.entityPolicyURI;
    fields.entityInformationURI = "https://entity.example/info";
    const parsed = parseAndValidateSubmission(fields, "eu_test");
    expect(parsed.valid).toBe(false);
    expect(parsed.valid ? [] : parsed.errors.map((e) => e.field)).toContain(
      "service[0].serviceUniqueIdentifier",
    );
  });
});

// ============================================================
// 4. Views
// ============================================================
describe("Annex F/G views", () => {
  it("offers onboarding cards for all four enabled families", () => {
    const html = onboardingCatalogueHtml();
    for (const route of [
      "/onboarding/pid-provider",
      "/onboarding/wallet-provider",
      "/onboarding/wrpac-provider",
      "/onboarding/wrprc-provider",
    ])
      expect(html).toContain(`href="${route}"`);
    expect(html).toContain("Pub-EAA Providers");
    expect(html).toContain("Registrars and Registers");
    expect(html).not.toContain("QEAA Providers");
  });

  it("renders the WRPAC certificate purpose and no identifier field", () => {
    const html = wrpacProviderFormHtml({}, {}, [
      { key: "eu_test", label: "Test (eu_test)" },
    ]);
    expect(html).toContain(
      "The certificate used to verify signatures or seals created by the WRPAC Provider on issued wallet-relying-party access certificates.",
    );
    expect(html).toContain("RFC 5280 CA certificate");
    expect(html).toContain("keyCertSign");
    expect(html).toContain("Policies and Terms URL");
    expect(html).toContain('name="registrationIdentifier"');
    expect(html).toContain('name="additionalInformationURI"');
    expect(html).toContain('name="responsibleMemberState"');
    expect(html).toContain('action="/onboarding/wrpac-provider"');
    expect(html).not.toContain("Service Unique Identifier");
    expect(html).toContain("currently mandated");
  });

  it("renders the WRPRC certificate purpose and no identifier field", () => {
    const html = wrprcProviderFormHtml();
    expect(html).toContain(
      "The certificate used to verify signatures or seals created by the WRPRC Provider on issued wallet-relying-party registration certificates.",
    );
    expect(html).toContain("RFC 5280 CA certificate");
    expect(html).toContain("keyCertSign");
    expect(html).toContain('action="/onboarding/wrprc-provider"');
    expect(html).not.toContain("Service Unique Identifier");
  });

  it("keeps posted values when a WRPAC submission is rejected", () => {
    const html = wrpacProviderFormHtml(
      {
        responsibleMemberState: "PL",
        registrationIdentifier: "NTRPL-1",
        entityPolicyURI: "https://entity.example/policies",
      },
      {
        responsibleMemberState:
          "Responsible Member State must be a 2-letter ISO code.",
      },
    );
    expect(html).toContain('value="PL"');
    expect(html).toContain('value="NTRPL-1"');
    expect(html).toContain('value="https://entity.example/policies"');
    expect(html).toContain("must be a 2-letter ISO code");
  });

  it("offers all enabled families on the Create Trusted List form", () => {
    const html = createListFormHtml();
    for (const family of [
      "pid-providers",
      "wallet-providers",
      "wrpac-providers",
      "wrprc-providers",
      "pub-eaa-providers",
    ])
      expect(html).toContain(`value="${family}"`);
    expect(html).not.toContain('value="registrars"');
  });

  it("shows the Annex F/G fields and the mandate meaning on admin review", () => {
    const html = adminApplicationDetailHtml(application("wrpac-providers"));
    expect(html).toContain("Policies and Terms URL");
    expect(html).toContain("Official Registration Identifier");
    expect(html).toContain("NTRPL-0000123456");
    expect(html).toContain("Additional Information URL");
    expect(html).toContain("Responsible Member State");
    expect(html).toContain("currently mandated");
    expect(html).not.toContain("Unique Identifier</th>");
  });
});

// ============================================================
// 5. Creation, publication and Inspector assessment
// ============================================================
describe("Annex F/G list creation and publication", () => {
  for (const family of RELYING_PARTY_FAMILIES) {
    const inspectorProfile =
      family === "wrpac-providers" ? "wrpac_providers" : "wrprc_providers";

    it(`${family}: creates an empty list, publishes v1 and assesses it`, async () => {
      const publicationDir = tmpDir();
      const configDir = tmpDir();
      const signingConfigPath = join(configDir, "signing-config.json");
      try {
        const store = new PublicationStore({ publicationDir });
        const result = await createTrustedList(
          {
            family,
            schemeName: `Created ${family} List`,
            schemeOperatorName: CERT_ORGANISATION,
            schemeTerritory: "EU",
            schemeOperatorStreet: "1 Scheme Street",
            schemeOperatorCountry: "IT",
            schemeOperatorEmail: "trustedlists@scheme.example",
            baseUrl: "https://scheme.example/list",
            keyFile: TEST_KEY_PATH,
            certFile: TEST_CERT_PATH,
            defects: [],
          },
          {
            publicationStore: store,
            signingConfigPath,
            inspectorClient: stubInspector(inspectorProfile),
          },
        );
        expect(result.success, result.success ? "" : result.error).toBe(true);
        if (!result.success) return;
        expect(result.entry.family).toBe(family);
        expect(result.sequenceNumber).toBe(1);
        expect(result.inspector.summary.status).toBe("pass");
        expect(result.inspector.summary.profile).toBe(inspectorProfile);
        const lote = JSON.parse(
          (await store.loadVersionBytes(result.listKey, 1, "lote")) ?? "{}",
        ) as LoTEDocument;
        expect(lote.LoTE.ListAndSchemeInformation.LoTEType).toBe(
          getEnabledProfile(family).loTEType,
        );
        expect(lote.LoTE.TrustedEntitiesList).toBeUndefined();
        expect(
          JSON.parse(readFileSync(signingConfigPath, "utf-8")) as {
            lists: { family: string }[];
          },
        ).toMatchObject({ lists: [{ family }] });
      } finally {
        for (const dir of [publicationDir, configDir])
          rmSync(dir, { recursive: true, force: true });
      }
    });

    it(`${family}: publishes two versions, each with its own evaluation`, async () => {
      const publicationDir = tmpDir();
      const authoringDir = tmpDir();
      try {
        const store = new PublicationStore({ publicationDir });
        const service = new ApplicationService(
          new AuthoringStore({ authoringDir }),
          store,
          {
            lists: [
              {
                listKey: "eu_test",
                family,
                schemeOperatorName: CERT_ORGANISATION,
                schemeOperatorStreet: "1 Scheme Street",
                schemeOperatorCountry: "IT",
                schemeName: `Test ${family} List`,
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
          },
          null,
          stubInspector(inspectorProfile),
        );
        for (const index of [1, 2]) {
          const app = service.createApp(
            "eu_test",
            applicantData({
              services: [
                {
                  serviceType: "issuance",
                  serviceName: `Issuance ${index}`,
                  certificatePem: TEST_CERT,
                },
              ],
            }),
            family,
          );
          expect(service.approve(app.id).success).toBe(true);
          const published = await service.publishApplication(app.id);
          expect(
            published.success,
            published.success ? "" : published.error,
          ).toBe(true);
        }
        // Version 1 stays byte-identical; version 2 is a new immutable version.
        expect(store.getHighestStoredSequence("eu_test")).toBe(2);
        const first = JSON.parse(
          (await store.loadVersionBytes("eu_test", 1, "lote")) ?? "{}",
        ) as LoTEDocument;
        const second = JSON.parse(
          (await store.loadVersionBytes("eu_test", 2, "lote")) ?? "{}",
        ) as LoTEDocument;
        expect(first.LoTE.TrustedEntitiesList).toHaveLength(1);
        expect(second.LoTE.TrustedEntitiesList).toHaveLength(2);
        expect(second.LoTE.ListAndSchemeInformation.LoTESequenceNumber).toBe(2);
        for (const sequence of [1, 2]) {
          const evaluation = parseInspectorEvaluation(
            store.readInspectorEvaluation("eu_test", sequence),
          );
          expect(evaluation?.summary.status).toBe("pass");
          expect(evaluation?.summary.profile).toBe(inspectorProfile);
        }
        expect(
          parseInspectorEvaluation(store.readInspectorEvaluation("eu_test", 1))
            ?.summary.evaluatedAt,
        ).not.toBe(undefined);
        const validated = await validateEtsiStruct(second);
        expect(validated.valid).toBe(true);
      } finally {
        for (const dir of [publicationDir, authoringDir])
          rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});

// ============================================================
// 6. HTTP surface
// ============================================================
describe("Annex F/G HTTP surface", () => {
  const httpGet = (
    url: string,
  ): Promise<{
    status: number;
    body: string;
    headers: IncomingMessage["headers"];
  }> =>
    new Promise((resolveGet, reject) => {
      httpGetRaw(url, (response) => {
        let body = "";
        response.on("data", (chunk) => (body += String(chunk)));
        response.on("end", () =>
          resolveGet({
            status: response.statusCode ?? 0,
            body,
            headers: response.headers,
          }),
        );
      }).on("error", reject);
    });

  const httpPost = (
    url: string,
    body: string,
    contentType: string,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; body: string }> =>
    new Promise((resolvePost, reject) => {
      const target = new URL(url);
      const request = httpRequestRaw(
        {
          hostname: target.hostname,
          port: target.port,
          path: `${target.pathname}${target.search}`,
          method: "POST",
          headers: {
            "Content-Type": contentType,
            "Content-Length": Buffer.byteLength(body),
            ...headers,
          },
        },
        (response) => {
          let received = "";
          response.on("data", (chunk) => (received += String(chunk)));
          response.on("end", () =>
            resolvePost({ status: response.statusCode ?? 0, body: received }),
          );
        },
      );
      request.on("error", reject);
      request.end(body);
    });

  async function withServer(
    config: ServerConfig,
    run: (baseUrl: string) => Promise<void>,
  ): Promise<void> {
    const server = createWebServer(config);
    await new Promise<void>((started, failed) => {
      server.listen(0, "127.0.0.1", started);
      server.on("error", failed);
    });
    const address = server.address() as AddressInfo;
    try {
      await run(`http://127.0.0.1:${address.port}`);
    } finally {
      await new Promise<void>((stopped) => server.close(() => stopped()));
    }
  }

  it("serves both onboarding forms and rejects an incomplete submission", async () => {
    const publicationDir = tmpDir();
    const authoringDir = tmpDir();
    const configDir = tmpDir();
    const signingConfigPath = join(configDir, "signing-config.json");
    writeFileSync(
      signingConfigPath,
      JSON.stringify({
        lists: RELYING_PARTY_FAMILIES.map((family) => ({
          listKey: family === "wrpac-providers" ? "eu_wrpac" : "eu_wrprc",
          family,
          schemeOperatorName: CERT_ORGANISATION,
          schemeOperatorStreet: "1 Scheme Street",
          schemeOperatorCountry: "IT",
          schemeName: `Test ${family} List`,
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
        })),
      }),
      "utf-8",
    );
    try {
      await withServer(
        {
          publicationDir,
          authoringDir,
          signingConfigPath,
          dataCollectionGui: true,
          adminToken: "test-token",
        },
        async (baseUrl) => {
          for (const path of [
            "/onboarding/wrpac-provider",
            "/onboarding/wrprc-provider",
          ]) {
            const page = await httpGet(`${baseUrl}${path}`);
            expect(page.status, path).toBe(200);
            expect(page.body).toContain('name="responsibleMemberState"');
            expect(page.body).not.toContain("Service Unique Identifier");
          }
          const catalogue = await httpGet(`${baseUrl}/onboarding`);
          expect(catalogue.body).toContain("/onboarding/wrpac-provider");
          expect(catalogue.body).toContain("/onboarding/wrprc-provider");

          const rejected = await httpPost(
            `${baseUrl}/onboarding/wrpac-provider`,
            "entityName=Test",
            "application/x-www-form-urlencoded",
          );
          expect(rejected.status).toBe(400);
          expect(rejected.body).toContain("Responsible Member State");

          const badFamily = await httpPost(
            `${baseUrl}/api/v1/admin/lists`,
            JSON.stringify({ family: "qeaa-providers" }),
            "application/json",
            { Authorization: "Bearer test-token" },
          );
          expect(badFamily.status).toBe(400);
          expect(badFamily.body).toContain("wrpac-providers");
          expect(badFamily.body).toContain("wrprc-providers");
        },
      );
    } finally {
      for (const dir of [publicationDir, authoringDir, configDir])
        rmSync(dir, { recursive: true, force: true });
    }
  });
});
