import { describe, it, expect } from "vitest";
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
  createTrustedList,
  deriveListKeyFromParts,
  LIST_DEFECTS,
  normalizeToAuthoringInput,
  schemeUrisFor,
  type SchemeDescriptor,
  type WalletProviderApplicantData,
} from "../src/core/authoring/index.js";
import { PublicationStore } from "../src/core/publication/store.js";
import {
  InspectorClient,
  inspectorStatusLabel,
} from "../src/core/inspector/inspector.js";
import {
  certificateDerBase64,
  isStrictBase64,
  isUtcDateTime,
  normalizeUtcDateTime,
  schemeNameWithTerritory,
  toUtcDateTime,
} from "../src/core/model/lexical.js";
import { createWebServer, type ServerConfig } from "../src/web/server.js";
import {
  inspectorPanelHtml,
  parseInspectorEvaluation,
  versionDownloadsHtml,
} from "../src/web/views/inspector-panel.js";
import { createListFormHtml } from "../src/web/views/list-creation.js";
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

const SCHEME: SchemeDescriptor = {
  schemeOperatorName: "Test",
  schemeOperatorStreet: "1 Scheme Street",
  schemeOperatorCountry: "IT",
  schemeOperatorEmail: "trustedlists@scheme.example",
  schemeOperatorWebsite: "https://scheme.example",
  schemeName: "Test Wallet Providers List",
  schemeTerritory: "EU",
  schemeInformationUris: [
    "https://scheme.example/scheme",
    "https://scheme.example/practice-statement",
  ],
  policyUri: "https://scheme.example/policy",
  distributionPointUri: "https://scheme.example/latest",
  signerCertificates: [TEST_CERT],
};

function applicantData(
  overrides: Partial<WalletProviderApplicantData> = {},
): WalletProviderApplicantData {
  return {
    entityName: CERT_ORGANISATION,
    entityStreetAddress: "1 Entity Street",
    entityCountry: "IT",
    entityInformationURI: "https://entity.example/info",
    entityEmail: "trust@entity.example",
    entityTelephone: "+39 02 1234567",
    services: [
      {
        serviceType: "issuance",
        serviceName: "Issuance",
        certificatePem: TEST_CERT,
        serviceUniqueIdentifier: "https://entity.example/svc/1",
      },
    ],
    ...overrides,
  };
}

function walletDocument(): LoTEDocument {
  const input = normalizeToAuthoringInput(
    {
      id: "app",
      schemaVersion: 1,
      family: "wallet-providers",
      targetListKey: "eu_test",
      state: "approved",
      submittedAt: "2026-07-30T09:00:00Z",
      applicantData: applicantData(),
    },
    SCHEME,
    "2026-07-30T09:00:00.123Z",
    "2027-01-26T09:00:00.456Z",
    1,
  );
  return compileForProfile("wallet-providers", input).document;
}

function tmpDir(): string {
  const path = join(tmpdir(), `tlp-annex-${randomBytes(8).toString("hex")}`);
  mkdirSync(path, { recursive: true });
  return path;
}

// ============================================================
// 1. Lexical rules
// ============================================================
describe("TS 119 602 lexical forms", () => {
  it("emits UTC date-times with seconds and no fraction", () => {
    const value = toUtcDateTime(new Date("2026-07-30T09:00:00.123Z"));
    expect(value).toBe("2026-07-30T09:00:00Z");
    expect(isUtcDateTime(value)).toBe(true);
  });

  it("normalizes a fractional timestamp and leaves a strict one alone", () => {
    expect(normalizeUtcDateTime("2026-07-30T09:00:00.999Z")).toBe(
      "2026-07-30T09:00:00Z",
    );
    expect(normalizeUtcDateTime("2026-07-30T09:00:00Z")).toBe(
      "2026-07-30T09:00:00Z",
    );
  });

  it("refuses a value that is not a date-time rather than inventing one", () => {
    expect(() => normalizeUtcDateTime("whenever")).toThrow(/not a date-time/);
  });

  it("prefixes the scheme name with the territory exactly once", () => {
    expect(schemeNameWithTerritory("Wallet Providers", "EU")).toBe(
      "EU:Wallet Providers",
    );
    expect(schemeNameWithTerritory("EU:Wallet Providers", "EU")).toBe(
      "EU:Wallet Providers",
    );
  });

  it("strips PEM armour to strict Base64 DER", () => {
    const der = certificateDerBase64(TEST_CERT);
    expect(der).not.toContain("BEGIN CERTIFICATE");
    expect(der).not.toMatch(/\s/);
    expect(isStrictBase64(der)).toBe(true);
    expect(certificateDerBase64(der)).toBe(der);
  });
});

// ============================================================
// 2. Compiled Annex E / Annex D content
// ============================================================
describe("compiled scheme information", () => {
  const document = walletDocument();
  const info = document.LoTE.ListAndSchemeInformation;

  it("uses strict UTC timestamps even when the input carries milliseconds", () => {
    expect(info.ListIssueDateTime).toBe("2026-07-30T09:00:00Z");
    expect(info.NextUpdate).toBe("2027-01-26T09:00:00Z");
  });

  it("carries the territory-prefixed scheme name", () => {
    expect(info.SchemeName?.[0]?.value).toBe("EU:Test Wallet Providers List");
  });

  it("publishes at least two scheme information URIs", () => {
    expect(info.SchemeInformationURI?.length).toBeGreaterThanOrEqual(2);
  });

  it("gives the operator a mailto URI and an HTTPS website", () => {
    const uris = info.SchemeOperatorAddress.SchemeOperatorElectronicAddress.map(
      (address) => address.uriValue,
    );
    expect(uris.some((uri) => uri.startsWith("mailto:"))).toBe(true);
    expect(uris.some((uri) => uri.startsWith("https://"))).toBe(true);
  });

  it("carries a policy or legal notice", () => {
    expect(info.PolicyOrLegalNotice).toBeDefined();
    expect(info.PolicyOrLegalNotice).toHaveLength(1);
    expect(info.PolicyOrLegalNotice?.[0]).toHaveProperty("LoTEPolicy");
  });

  it("points at itself, with the signing certificate and the artifact media type", () => {
    const pointer = info.PointersToOtherLoTE?.[0];
    expect(pointer?.LoTELocation).toBe(SCHEME.distributionPointUri);
    expect(
      pointer?.ServiceDigitalIdentities[0]?.X509Certificates?.[0]?.val,
    ).toBe(certificateDerBase64(TEST_CERT));
    const qualifier = pointer?.LoTEQualifiers[0];
    expect(qualifier?.LoTEType).toBe(info.LoTEType);
    expect(qualifier?.MimeType).toBe("application/jose");
    expect(qualifier?.SchemeTerritory).toBe("EU");
  });

  it("omits the self pointer when no signing certificate is available", () => {
    const input = normalizeToAuthoringInput(
      {
        id: "app",
        schemaVersion: 1,
        family: "wallet-providers",
        targetListKey: "eu_test",
        state: "approved",
        submittedAt: "2026-07-30T09:00:00Z",
        applicantData: applicantData(),
      },
      { ...SCHEME, signerCertificates: [] },
      "2026-07-30T09:00:00Z",
      "2027-01-26T09:00:00Z",
      1,
    );
    const compiled = compileForProfile("wallet-providers", input).document;
    expect(
      compiled.LoTE.ListAndSchemeInformation.PointersToOtherLoTE,
    ).toBeUndefined();
  });

  it("still validates against the pinned ETSI schema", async () => {
    const result = await validateEtsiStruct(document);
    expect(result.findings).toEqual([]);
    expect(result.valid).toBe(true);
  });
});

describe("compiled entity and service content", () => {
  const document = walletDocument();
  const entity = document.LoTE.TrustedEntitiesList?.[0];
  const service = entity?.TrustedEntityServices[0]?.ServiceInformation;

  it("gives the entity an email, a website and a telephone URI", () => {
    const uris =
      entity?.TrustedEntityInformation.TEAddress.TEElectronicAddress.map(
        (address) => address.uriValue,
      );
    expect(uris).toContain("mailto:trust@entity.example");
    expect(uris).toContain("https://entity.example/info");
    expect(uris).toContain("tel:+39021234567");
  });

  it("states the country and role of a Wallet Provider entity", () => {
    const uris = entity?.TrustedEntityInformation.TEInformationURI.map(
      (uri) => uri.uriValue,
    );
    expect(uris).toContain(
      "http://uri.etsi.org/19602/ListOfTrustedEntities/WalletProvider/IT",
    );
  });

  it("uses the responsible Member State in a PID Provider role URI", () => {
    const input = normalizeToAuthoringInput(
      {
        id: "app",
        schemaVersion: 1,
        family: "pid-providers",
        targetListKey: "eu_test_pid",
        state: "approved",
        submittedAt: "2026-07-30T09:00:00Z",
        applicantData: {
          ...applicantData(),
          responsibleMemberState: "DK",
        },
      },
      SCHEME,
      "2026-07-30T09:00:00Z",
      "2027-01-26T09:00:00Z",
      1,
    );
    const compiled = compileForProfile("pid-providers", input).document;
    const uris =
      compiled.LoTE.TrustedEntitiesList?.[0]?.TrustedEntityInformation.TEInformationURI.map(
        (uri) => uri.uriValue,
      );
    expect(uris).toContain(
      "http://uri.etsi.org/19602/ListOfTrustedEntities/PIDProvider/DK",
    );
  });

  it("publishes the service certificate as strict Base64 DER", () => {
    const value = service?.ServiceDigitalIdentity.X509Certificates?.[0]?.val;
    expect(value).toBe(certificateDerBase64(TEST_CERT));
    expect(value).not.toContain("BEGIN CERTIFICATE");
    expect(isStrictBase64(value ?? "")).toBe(true);
  });

  it("marks the service extension container with its criticality", () => {
    const extension = service?.ServiceInformationExtensions?.[0];
    expect(extension?.Critical).toBe(false);
    expect(extension?.ServiceUniqueIdentifier).toBe(
      "https://entity.example/svc/1",
    );
  });
});

// ============================================================
// 3. JAdES signing time
// ============================================================
describe("Compact JAdES protected header", () => {
  it("carries iat as an integer NumericDate", async () => {
    const { sign } = await import("../src/core/signing/signing.js");
    const { createPrivateKey } = await import("node:crypto");
    const privateKey = createPrivateKey(readFileSync(TEST_KEY_PATH, "utf-8"));
    const key = await crypto.subtle.importKey(
      "jwk",
      privateKey.export({ format: "jwk" }),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    );
    const signingTime = new Date("2026-07-30T09:00:00Z");
    const signed = await sign({
      document: walletDocument(),
      key,
      certificatePem: TEST_CERT,
      signingTime,
    });
    const header = JSON.parse(
      Buffer.from(signed.compact.split(".")[0]!, "base64url").toString(),
    );
    expect(header.iat).toBe(Math.floor(signingTime.getTime() / 1000));
    expect(Number.isInteger(header.iat)).toBe(true);
    expect(header.alg).toBe("ES256");
    expect(header.typ).toBe("JAdES");
    expect(Array.isArray(header.x5c)).toBe(true);
  });
});

// ============================================================
// 4. Inspector client
// ============================================================
describe("Trust Inspector client", () => {
  const inspectorResponse = (fails: number) => ({
    result: {
      detected: { format: "jws", artifactKind: "json_lote" },
      ts119602Classification: {
        profile: "wallet_providers",
        profileStatus: "selected",
      },
      ts119602: {
        applicable: true,
        conformanceLevel: fails === 0 ? "conformant" : "non_conformant",
        score: null,
        mandatoryFailures: [],
        checks: [
          {
            id: "a",
            category: "structure",
            status: "pass",
            severity: "info",
            message: "ok",
          },
          ...Array.from({ length: fails }, (_, index) => ({
            id: `fail-${index}`,
            category: "profile",
            status: "fail",
            severity: "error",
            message: `broken ${index}`,
          })),
        ],
      },
    },
  });

  function clientFor(
    handler: (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => Promise<Response>,
  ): InspectorClient {
    return new InspectorClient({
      baseUrl: "https://inspector.test",
      fetchImpl: handler as unknown as typeof fetch,
      now: () => new Date("2026-07-30T10:00:00Z"),
    });
  }

  it("reports pass when no locally decidable check fails", async () => {
    const client = clientFor(() =>
      Promise.resolve(
        new Response(JSON.stringify(inspectorResponse(0)), { status: 200 }),
      ),
    );
    const evaluation = await client.assess({
      compactJades: "a.b.c",
      source: "test",
    });
    expect(evaluation.summary.status).toBe("pass");
    expect(evaluation.summary.profile).toBe("wallet_providers");
    expect(evaluation.summary.conformanceLevel).toBe("conformant");
    expect(evaluation.summary.counts?.pass).toBe(1);
    expect(evaluation.summary.locallyDecidableFailures).toEqual([]);
    expect(evaluation.report).toBeDefined();
    expect(inspectorStatusLabel(evaluation.summary)).toBe("Pass");
  });

  it("reports fail and lists the failures", async () => {
    const client = clientFor(() =>
      Promise.resolve(
        new Response(JSON.stringify(inspectorResponse(2)), { status: 200 }),
      ),
    );
    const evaluation = await client.assess({
      compactJades: "a.b.c",
      source: "test",
    });
    expect(evaluation.summary.status).toBe("fail");
    expect(evaluation.summary.counts?.fail).toBe(2);
    expect(evaluation.summary.locallyDecidableFailures).toHaveLength(2);
    expect(inspectorStatusLabel(evaluation.summary)).toBe("Fail");
  });

  it("submits the Compact JAdES artifact, not a decoded LoTE", async () => {
    let seen: Record<string, unknown> = {};
    const client = clientFor((_input, init) => {
      seen = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Promise.resolve(
        new Response(JSON.stringify(inspectorResponse(0)), { status: 200 }),
      );
    });
    await client.assess({
      compactJades: "header.payload.signature",
      source: "eu_test/versions/1/lote.jades",
      declared: { mimeType: "application/jose", loteType: "x" },
    });
    expect(seen.content).toBe("header.payload.signature");
    expect(seen.contentType).toBe("application/jose");
    expect(seen.source).toBe("eu_test/versions/1/lote.jades");
  });

  it("reports unavailable — never conformance — when the Inspector fails", async () => {
    for (const handler of [
      () => Promise.reject(new Error("connect ECONNREFUSED")),
      () =>
        Promise.resolve(
          new Response("nope", { status: 502, statusText: "Bad Gateway" }),
        ),
      () => Promise.resolve(new Response("{}", { status: 200 })),
    ]) {
      const evaluation = await clientFor(handler).assess({
        compactJades: "a.b.c",
        source: "test",
      });
      expect(evaluation.summary.status).toBe("unavailable");
      expect(evaluation.summary.error).toBeTruthy();
      expect(evaluation.summary.conformanceLevel).toBeUndefined();
      expect(evaluation.report).toBeUndefined();
      expect(inspectorStatusLabel(evaluation.summary)).toBe("Unavailable");
    }
  });
});

// ============================================================
// 5. Inspector panel and downloads
// ============================================================
describe("version page Inspector panel", () => {
  it("shows status, profile, level, counts and timestamp", () => {
    const html = inspectorPanelHtml(
      {
        schemaVersion: 1,
        summary: {
          status: "pass",
          evaluatedAt: "2026-07-30T10:00:00Z",
          inspectorBaseUrl: "https://inspector.test",
          profile: "wallet_providers",
          conformanceLevel: "conformant",
          counts: {
            pass: 47,
            fail: 0,
            warn: 1,
            notApplicable: 15,
            notChecked: 6,
            other: 0,
          },
          locallyDecidableFailures: [],
        },
      },
      "eu_test",
      2,
    );
    expect(html).toContain("Pass");
    expect(html).toContain("Wallet Providers");
    expect(html).toContain("conformant");
    expect(html).toContain("47 passed, 0 failed");
    expect(html).toContain("2026-07-30T10:00:00Z");
    expect(html).toContain("View Inspector report");
    expect(html).toContain("Download Inspector JSON");
  });

  it("keeps profile acronyms upper-case", () => {
    const html = inspectorPanelHtml(
      {
        schemaVersion: 1,
        summary: {
          status: "pass",
          evaluatedAt: "2026-07-30T10:00:00Z",
          inspectorBaseUrl: "https://inspector.test",
          profile: "pid_providers",
          conformanceLevel: "conformant",
          locallyDecidableFailures: [],
        },
      },
      "eu_test",
      1,
    );
    expect(html).toContain("PID Providers");
    expect(html).not.toContain("Pid Providers");
  });

  it("never claims conformance when the assessment is unavailable", () => {
    const html = inspectorPanelHtml(
      {
        schemaVersion: 1,
        summary: {
          status: "unavailable",
          error: "Trust Inspector could not be reached: timeout.",
          evaluatedAt: "2026-07-30T10:00:00Z",
          inspectorBaseUrl: "https://inspector.test",
        },
      },
      "eu_test",
      1,
    );
    expect(html).toContain("Unavailable");
    expect(html).toContain("could not be reached");
    expect(html).toContain("not evaluated");
    expect(html).not.toContain(">conformant<");
  });

  it("says so plainly when no evaluation was ever stored", () => {
    const html = inspectorPanelHtml(null, "eu_test", 1);
    expect(html).toContain("Unavailable");
    expect(html).toContain("No conformance is claimed");
  });

  it("ignores an unusable stored evaluation instead of throwing", () => {
    expect(parseInspectorEvaluation(null)).toBeNull();
    expect(parseInspectorEvaluation("not json")).toBeNull();
    expect(parseInspectorEvaluation('{"nope":1}')).toBeNull();
    expect(
      parseInspectorEvaluation('{"summary":{"status":"pass"}}'),
    ).not.toBeNull();
  });

  it("offers JSON, Compact JAdES and Inspector report on every version page", () => {
    const html = versionDownloadsHtml("eu_test", 3);
    expect(html).toContain(">JSON<");
    expect(html).toContain(">Compact JAdES<");
    expect(html).toContain(">Inspector report<");
    expect(html).toContain("/api/v1/lists/eu_test/versions/3/lote?download=1");
    expect(html).toContain(
      "/api/v1/lists/eu_test/versions/3/signature?download=1",
    );
    expect(html).toContain("/api/v1/lists/eu_test/versions/3/inspector");
  });
});

// ============================================================
// 6. Publication stores an evaluation per version
// ============================================================
describe("evaluation storage", () => {
  it("stores one evaluation per version and rewrites it on request", async () => {
    const publicationDir = tmpDir();
    try {
      const store = new PublicationStore({ publicationDir });
      expect(store.readInspectorEvaluation("eu_missing", 1)).toBeNull();
      expect(() =>
        store.writeInspectorEvaluation("eu_missing", 1, "{}"),
      ).toThrow(/does not exist/);
    } finally {
      rmSync(publicationDir, { recursive: true, force: true });
    }
  });

  it("assesses each published version separately", async () => {
    const publicationDir = tmpDir();
    const authoringDir = tmpDir();
    const configDir = tmpDir();
    const signingConfigPath = join(configDir, "signing-config.json");
    const submitted: string[] = [];
    try {
      const store = new PublicationStore({ publicationDir });
      const service = new ApplicationService(
        new AuthoringStore({ authoringDir }),
        store,
        {
          lists: [
            {
              listKey: "eu_test",
              family: "wallet-providers",
              schemeOperatorName: CERT_ORGANISATION,
              schemeOperatorStreet: "1 Scheme Street",
              schemeOperatorCountry: "IT",
              schemeName: "Test Wallet Providers List",
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
        new InspectorClient({
          baseUrl: "https://inspector.test",
          fetchImpl: ((_input: unknown, init: RequestInit | undefined) => {
            submitted.push(
              String(
                (JSON.parse(String(init?.body)) as { content: string }).content,
              ),
            );
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  result: {
                    detected: { format: "jws", artifactKind: "json_lote" },
                    ts119602Classification: { profile: "wallet_providers" },
                    ts119602: {
                      conformanceLevel: "conformant",
                      checks: [],
                      mandatoryFailures: [],
                    },
                  },
                }),
                { status: 200 },
              ),
            );
          }) as unknown as typeof fetch,
        }),
      );
      writeFileSync(signingConfigPath, "{}", "utf-8");

      for (const index of [1, 2]) {
        const app = service.createApp(
          "eu_test",
          applicantData({
            services: [
              {
                serviceType: "issuance",
                serviceName: `Issuance ${index}`,
                certificatePem: TEST_CERT,
                serviceUniqueIdentifier: `https://entity.example/svc/${index}`,
              },
            ],
          }),
        );
        expect(service.approve(app.id).success).toBe(true);
        const published = await service.publishApplication(app.id);
        expect(published.success).toBe(true);
      }

      // One assessment per version, each stored beside its own version.
      expect(submitted).toHaveLength(2);
      expect(submitted[0]).not.toBe(submitted[1]);
      for (const sequence of [1, 2]) {
        const stored = store.readInspectorEvaluation("eu_test", sequence);
        expect(stored, `version ${sequence}`).not.toBeNull();
        const evaluation = parseInspectorEvaluation(stored);
        expect(evaluation?.summary.status).toBe("pass");
        expect(evaluation?.summary.profile).toBe("wallet_providers");
      }
      const first = parseInspectorEvaluation(
        store.readInspectorEvaluation("eu_test", 1),
      );
      const second = parseInspectorEvaluation(
        store.readInspectorEvaluation("eu_test", 2),
      );
      expect(first).not.toEqual(second);
    } finally {
      for (const dir of [publicationDir, authoringDir, configDir])
        rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ============================================================
// 7. Trusted List creation
// ============================================================
describe("Trusted List creation", () => {
  const baseRequest = {
    family: "wallet-providers" as const,
    schemeName: "Created Wallet Providers List",
    schemeOperatorName: "Test",
    schemeTerritory: "EU",
    schemeOperatorStreet: "1 Scheme Street",
    schemeOperatorCountry: "IT",
    schemeOperatorEmail: "trustedlists@scheme.example",
    baseUrl: "https://scheme.example/wallet-providers",
    keyFile: TEST_KEY_PATH,
    certFile: TEST_CERT_PATH,
    defects: [] as string[],
  };

  function stubInspector(): InspectorClient {
    return new InspectorClient({
      baseUrl: "https://inspector.test",
      fetchImpl: (() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              result: {
                detected: { format: "jws", artifactKind: "json_lote" },
                ts119602Classification: { profile: "wallet_providers" },
                ts119602: {
                  conformanceLevel: "conformant",
                  checks: [],
                  mandatoryFailures: [],
                },
              },
            }),
            { status: 200 },
          ),
        )) as unknown as typeof fetch,
    });
  }

  it("derives the same list key the manifest derives", () => {
    expect(deriveListKeyFromParts("EU", "Test Authority")).toBe(
      "eu_test_authority",
    );
    expect(deriveListKeyFromParts("EU", "Crédimi & Co")).toBe(
      "eu_cr_dimi___co",
    );
  });

  it("derives the scheme URIs from one base URL", () => {
    const uris = schemeUrisFor("https://example.eu/wallet/");
    expect(uris.website).toBe("https://example.eu/wallet");
    expect(uris.schemeInformationUris).toEqual([
      "https://example.eu/wallet/scheme",
      "https://example.eu/wallet/practice-statement",
    ]);
    expect(uris.policyUri).toBe("https://example.eu/wallet/policy");
    expect(uris.distributionPointUri).toBe("https://example.eu/wallet/latest");
  });

  it("publishes an empty, valid, assessed version 1 and registers the list", async () => {
    const publicationDir = tmpDir();
    const configDir = tmpDir();
    const signingConfigPath = join(configDir, "signing-config.json");
    try {
      const store = new PublicationStore({ publicationDir });
      const result = await createTrustedList(baseRequest, {
        publicationStore: store,
        signingConfigPath,
        inspectorClient: stubInspector(),
        now: () => new Date("2026-07-30T09:00:00Z"),
      });
      expect(result.success, result.success ? "" : result.error).toBe(true);
      if (!result.success) return;
      expect(result.listKey).toBe("eu_test");
      expect(result.sequenceNumber).toBe(1);
      expect(result.inspector.summary.status).toBe("pass");

      const lote = JSON.parse(
        (await store.loadVersionBytes("eu_test", 1, "lote")) ?? "{}",
      ) as LoTEDocument;
      expect(lote.LoTE.TrustedEntitiesList).toBeUndefined();
      const info = lote.LoTE.ListAndSchemeInformation;
      expect(info.SchemeName?.[0]?.value).toBe(
        "EU:Created Wallet Providers List",
      );
      expect(info.ListIssueDateTime).toBe("2026-07-30T09:00:00Z");
      expect(info.PointersToOtherLoTE).toHaveLength(1);
      expect(await validateEtsiStruct(lote)).toMatchObject({ valid: true });

      // The list is registered, so onboarding can target it.
      const written = JSON.parse(readFileSync(signingConfigPath, "utf-8")) as {
        lists: Array<{ listKey: string; policyUri: string }>;
      };
      expect(written.lists).toHaveLength(1);
      expect(written.lists[0]!.listKey).toBe("eu_test");
      expect(written.lists[0]!.policyUri).toBe(
        "https://scheme.example/wallet-providers/policy",
      );
      // The evaluation is stored beside the version.
      expect(store.readInspectorEvaluation("eu_test", 1)).not.toBeNull();
    } finally {
      for (const dir of [publicationDir, configDir])
        rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a duplicate list key", async () => {
    const publicationDir = tmpDir();
    const configDir = tmpDir();
    const signingConfigPath = join(configDir, "signing-config.json");
    try {
      const deps = {
        publicationStore: new PublicationStore({ publicationDir }),
        signingConfigPath,
        inspectorClient: stubInspector(),
      };
      expect((await createTrustedList(baseRequest, deps)).success).toBe(true);
      const second = await createTrustedList(baseRequest, deps);
      expect(second.success).toBe(false);
      if (second.success) return;
      expect(second.error).toContain("already exists");
    } finally {
      for (const dir of [publicationDir, configDir])
        rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects each invalid field with a message that names it", async () => {
    const publicationDir = tmpDir();
    const configDir = tmpDir();
    try {
      const deps = {
        publicationStore: new PublicationStore({ publicationDir }),
        signingConfigPath: join(configDir, "signing-config.json"),
        inspectorClient: stubInspector(),
      };
      const cases: Array<[Partial<typeof baseRequest>, RegExp]> = [
        [{ schemeName: "" }, /schemeName is required/],
        [{ baseUrl: "not a url" }, /baseUrl must be a valid URL/],
        [{ schemeOperatorEmail: "nope" }, /valid email address/],
        [{ schemeTerritory: "eu" }, /schemeTerritory must be a 2-letter code/],
        [{ keyFile: "/nonexistent/key.pem" }, /Signing key file not found/],
        [{ defects: ["not_a_defect"] }, /Unknown defect/],
      ];
      for (const [overrides, expected] of cases) {
        const result = await createTrustedList(
          { ...baseRequest, ...overrides },
          deps,
        );
        expect(result.success).toBe(false);
        if (result.success) continue;
        expect(result.error).toMatch(expected);
      }
    } finally {
      for (const dir of [publicationDir, configDir])
        rmSync(dir, { recursive: true, force: true });
    }
  });

  it("offers every defect on the form, selectable, with the family choice", () => {
    const html = createListFormHtml();
    expect(html).toContain("Wallet Providers");
    expect(html).toContain("PID Providers");
    expect(html).not.toContain("QEAA Providers");
    for (const defect of LIST_DEFECTS) {
      expect(html).toContain(`value="${defect.id}"`);
      expect(html).toContain(defect.label);
    }
    /*
      Broken generation is implemented, so every defect is a live checkbox. A
      disabled one would silently produce a healthy list.
    */
    expect(html.match(/name="defects"/g)).toHaveLength(LIST_DEFECTS.length);
    expect(html).not.toContain("disabled");
    expect(html).toContain("Intentionally broken test fixture");
  });
});

// ============================================================
// 8. HTTP surface
// ============================================================
describe("HTTP surface for creation and evaluation", () => {
  function httpGet(url: string): Promise<{
    status: number;
    body: string;
    headers: Record<string, string>;
  }> {
    return new Promise((done, reject) => {
      httpGetRaw(new URL(url), (response: IncomingMessage) => {
        let body = "";
        response.on("data", (chunk: Buffer) => (body += chunk.toString()));
        response.on("end", () =>
          done({
            status: response.statusCode ?? 0,
            body,
            headers: response.headers as Record<string, string>,
          }),
        );
      }).on("error", reject);
    });
  }

  function httpPostJson(
    url: string,
    body: string,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; body: string }> {
    return new Promise((done, reject) => {
      const request = httpRequestRaw(
        new URL(url),
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": String(Buffer.byteLength(body)),
            ...headers,
          },
        },
        (response: IncomingMessage) => {
          let text = "";
          response.on("data", (chunk: Buffer) => (text += chunk.toString()));
          response.on("end", () =>
            done({ status: response.statusCode ?? 0, body: text }),
          );
        },
      );
      request.on("error", reject);
      request.write(body);
      request.end();
    });
  }

  function startServer(
    config: ServerConfig,
  ): Promise<{ url: string; stop: () => Promise<void> }> {
    return new Promise((done, reject) => {
      const server = createWebServer(config);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address() as AddressInfo;
        done({
          url: `http://127.0.0.1:${address.port}`,
          stop: () => new Promise<void>((r) => server.close(() => r())),
        });
      });
      server.on("error", reject);
    });
  }

  it("requires the admin token on the creation API and refuses other methods", async () => {
    const publicationDir = tmpDir();
    const authoringDir = tmpDir();
    const configDir = tmpDir();
    const signingConfigPath = join(configDir, "signing-config.json");
    writeFileSync(signingConfigPath, JSON.stringify({ lists: [] }), "utf-8");
    const { url, stop } = await startServer({
      publicationDir,
      authoringDir,
      dataCollectionGui: true,
      adminToken: "creation-token",
      signingConfigPath,
    });
    try {
      const anonymous = await httpPostJson(
        `${url}/api/v1/admin/lists`,
        JSON.stringify({ family: "wallet-providers" }),
      );
      expect(anonymous.status).toBe(403);
      expect(anonymous.body).toContain("administrator token");

      const wrongMethod = await httpGet(`${url}/api/v1/admin/lists`);
      expect(wrongMethod.status).toBe(405);

      const badBody = await httpPostJson(
        `${url}/api/v1/admin/lists`,
        "not json",
        { Authorization: "Bearer creation-token" },
      );
      expect(badBody.status).toBe(400);
      expect(badBody.body).toContain("must be JSON");
    } finally {
      await stop();
      for (const dir of [publicationDir, authoringDir, configDir])
        rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports 404 for a version with no stored evaluation, as unavailable rather than clean", async () => {
    const publicationDir = tmpDir();
    const { url, stop } = await startServer({ publicationDir });
    try {
      const response = await httpGet(
        `${url}/api/v1/lists/eu_absent/versions/1/inspector`,
      );
      expect(response.status).toBe(404);
      expect(response.body).toContain("not a conformance statement");
    } finally {
      await stop();
      rmSync(publicationDir, { recursive: true, force: true });
    }
  });
});
