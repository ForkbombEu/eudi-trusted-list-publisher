import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { certificateDerBase64 } from "../src/core/model/lexical.js";
import { existsSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import {
  LIST_FAMILIES,
  getEnabledFamilies,
  findFamily,
  canTransition,
  normalizeToAuthoringInput,
  type SchemeDescriptor,
  documentPlaceholder,
  AuthoringStore,
  loadSigningConfig,
  findSigningConfig,
  signingConfigDisplay,
  APPLICATION_SCHEMA_VERSION,
  type WalletProviderApplication,
} from "../src/core/authoring/index.js";
import { compile } from "../src/core/compile/compile.js";
import { validateEtsiStruct } from "../src/core/validate/validate.js";
import { verify } from "../src/core/verification/verification.js";
import { sign } from "../src/core/signing/signing.js";
import { publish } from "../src/core/publication/manifest.js";
import {
  PublicationStore,
  loadVersionArtifacts,
} from "../src/core/publication/store.js";

function tmpDir(): string {
  const dir = join(tmpdir(), "tlp-test-" + randomBytes(8).toString("hex"));
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Scheme description used by the normalization tests. It carries the Annex D/E
 * scheme fields the compiler needs; individual tests override what they assert.
 */
const TEST_SCHEME: SchemeDescriptor = {
  schemeOperatorName: "Credimi",
  schemeOperatorStreet: "Via Roma 1",
  schemeOperatorCountry: "IT",
  schemeOperatorEmail: "trustedlists@credimi.eu",
  schemeOperatorWebsite: "https://credimi.eu",
  schemeName: "EU Wallet Providers List",
  schemeTerritory: "EU",
  schemeInformationUris: [
    "https://credimi.eu/wallet-providers/scheme",
    "https://credimi.eu/wallet-providers/practice-statement",
  ],
  policyUri: "https://credimi.eu/wallet-providers/policy",
  distributionPointUri: "https://credimi.eu/wallet-providers/latest",
  signerCertificates: [],
};

const TEST_CERT = readFileSync(
  resolve(import.meta.dirname, "fixtures", "test-cert.pem"),
  "utf-8",
);
const TEST_KEY = readFileSync(
  resolve(import.meta.dirname, "fixtures", "test-key.pem"),
  "utf-8",
);

function createTestApplication(
  overrides?: Partial<WalletProviderApplication>,
): WalletProviderApplication {
  return {
    id: randomUUID(),
    schemaVersion: APPLICATION_SCHEMA_VERSION,
    family: "wallet-providers",
    targetListKey: "eu_credimi",
    state: "submitted",
    submittedAt: new Date().toISOString(),
    applicantData: {
      entityName: "Test Provider Inc.",
      entityTradeName: "TestWP",
      entityStreetAddress: "123 Test St",
      entityLocality: "Testville",
      entityPostalCode: "12345",
      entityCountry: "IT",
      entityInformationURI: "https://example.com/provider",
      entityEmail: "trust@entity.example",
      entityTelephone: "+39 02 1234567",
      services: [
        {
          serviceType: "issuance",
          serviceName: "Wallet Issuance Service",
          certificatePem: TEST_CERT,
          serviceUniqueIdentifier: "https://example.com/services/issuance",
        },
      ],
    },
    ...overrides,
  };
}

async function importSigningKey(): Promise<globalThis.CryptoKey> {
  const { createPrivateKey } = await import("node:crypto");
  const privateKey = createPrivateKey(TEST_KEY);
  const jwk = privateKey.export({ format: "jwk" });
  return crypto.subtle.importKey(
    "jwk",
    jwk as JsonWebKey,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
}

describe("List Family Catalogue", () => {
  it("contains the six TS 119 602 families and the two TS 119 612 families", () => {
    expect(LIST_FAMILIES).toHaveLength(8);
  });

  it("has the correct family labels", () => {
    const labels = LIST_FAMILIES.map((f) => f.label);
    expect(labels).toEqual([
      "PID Providers",
      "Wallet Providers",
      "WRPAC Providers",
      "WRPRC Providers",
      "Pub-EAA Providers",
      "EAA Providers",
      "QEAA Providers",
      "Registrars and Registers",
    ]);
  });

  it("enables every family except Registrars", () => {
    const enabled = getEnabledFamilies();
    expect(enabled.map((family) => [family.key, family.label])).toEqual([
      ["pid-providers", "PID Providers"],
      ["wallet-providers", "Wallet Providers"],
      ["wrpac-providers", "WRPAC Providers"],
      ["wrprc-providers", "WRPRC Providers"],
      ["pub-eaa-providers", "Pub-EAA Providers"],
      ["eaa-providers", "EAA Providers"],
      ["qeaa-providers", "QEAA Providers"],
    ]);
  });

  it("keeps Registrars disabled with 'Not implemented yet'", () => {
    const disabled = LIST_FAMILIES.filter((family) => !family.enabled);
    expect(disabled.map((family) => family.key)).toEqual(["registrars"]);
    for (const family of disabled)
      expect(family.notImplementedNote).toBe("Not implemented yet");
  });

  it("findFamily resolves both enabled families", () => {
    expect(findFamily("wallet-providers")).toMatchObject({
      key: "wallet-providers",
      label: "Wallet Providers",
    });
    expect(findFamily("pid-providers")).toMatchObject({
      key: "pid-providers",
      label: "PID Providers",
    });
  });

  it("findFamily returns undefined for unknown key", () => {
    expect(findFamily("nonexistent")).toBeUndefined();
  });
});

describe("Application Lifecycle", () => {
  it("allows submitted -> approved", () => {
    expect(canTransition("submitted", "approved")).toBe(true);
  });

  it("allows submitted -> rejected", () => {
    expect(canTransition("submitted", "rejected")).toBe(true);
  });

  it("allows approved -> published", () => {
    expect(canTransition("approved", "published")).toBe(true);
  });

  it("allows approved -> rejected", () => {
    expect(canTransition("approved", "rejected")).toBe(true);
  });

  it("rejects submitted -> published", () => {
    expect(canTransition("submitted", "published")).toBe(false);
  });

  it("rejects approved -> submitted", () => {
    expect(canTransition("approved", "submitted")).toBe(false);
  });

  it("rejects published -> approved", () => {
    expect(canTransition("published", "approved")).toBe(false);
  });

  it("rejects rejected -> submitted", () => {
    expect(canTransition("rejected", "submitted")).toBe(false);
  });

  it("rejects rejected -> published", () => {
    expect(canTransition("rejected", "published")).toBe(false);
  });
});

describe("Normalize to AuthoringInput", () => {
  it("maps applicant data to AuthoringInput correctly", () => {
    const app = createTestApplication();
    const input = normalizeToAuthoringInput(
      app,
      TEST_SCHEME,
      "2026-01-01T00:00:00Z",
      "2026-07-01T00:00:00Z",
      1,
    );

    expect(input.schemeOperator.name[0]!.value).toBe("Credimi");
    expect(input.scheme.schemeName[0]!.value).toBe("EU Wallet Providers List");
    expect(input.scheme.schemeTerritory).toBe("EU");
    expect(input.scheme.distributionPoints[0]).toBe(
      "https://credimi.eu/wallet-providers/latest",
    );
    expect(input.entities[0]!.teName[0]!.value).toBe("Test Provider Inc.");
    expect(input.entities[0]!.teTradeName?.[0]?.value).toBe("TestWP");
    expect(input.entities[0]!.tePostalAddress[0]!.Country).toBe("IT");
    expect(input.entities[0]!.teInformationURI[0]!.uriValue).toBe(
      "https://example.com/provider",
    );
    expect(input.entities[0]!.services[0]!.serviceTypeIdentifier).toBe(
      "http://uri.etsi.org/19602/SvcType/WalletSolution/Issuance",
    );
    expect(input.entities[0]!.services[0]!.serviceName[0]!.value).toBe(
      "Wallet Issuance Service",
    );
    // The authoring model holds the published form: Base64 DER, no PEM armour.
    expect(
      input.entities[0]!.services[0]!.serviceDigitalIdentity
        .x509Certificates[0],
    ).toBe(certificateDerBase64(TEST_CERT));
    expect(input.entities[0]!.services[0]!.serviceUniqueIdentifier).toBe(
      "https://example.com/services/issuance",
    );
  });

  it("generates scheme operator from trusted configuration", () => {
    const app = createTestApplication();
    const input = normalizeToAuthoringInput(
      app,
      {
        ...TEST_SCHEME,
        schemeOperatorName: "TrustedOp",
        schemeName: "Trusted List",
      },
      "2026-01-01T00:00:00Z",
      "2026-07-01T00:00:00Z",
      5,
    );
    expect(input.schemeOperator.name[0]!.value).toBe("TrustedOp");
    expect(input.scheme.schemeName[0]!.value).toBe("Trusted List");
    expect(input.loTESequenceNumber).toBe(5);
    // clauses 6.3.5.1/6.3.5.2: the operator is reachable by email and on the web.
    expect(
      input.schemeOperator.electronicAddress.map((a) => a.uriValue),
    ).toEqual(["mailto:trustedlists@credimi.eu", "https://credimi.eu"]);
  });

  it("maps revocation service type correctly", () => {
    const app = createTestApplication({
      applicantData: {
        entityName: "Revoker",
        entityStreetAddress: "1 Revoke St",
        entityCountry: "IT",
        entityInformationURI: "https://example.com",
        entityEmail: "trust@entity.example",
        entityTelephone: "+39 02 1234567",
        services: [
          {
            serviceType: "revocation",
            serviceName: "Revocation Service",
            certificatePem: TEST_CERT,
            serviceUniqueIdentifier: "https://example.com/rev",
          },
        ],
      },
    });
    const input = normalizeToAuthoringInput(
      app,
      TEST_SCHEME,
      "2026-01-01T00:00:00Z",
      "2026-07-01T00:00:00Z",
      1,
    );
    expect(input.entities[0]!.services[0]!.serviceTypeIdentifier).toBe(
      "http://uri.etsi.org/19602/SvcType/WalletSolution/Revocation",
    );
  });
});

describe("Document placeholders", () => {
  it("returns {FILENAME}.md format for known documents", () => {
    expect(documentPlaceholder("onboarding_authorization")).toBe(
      "{ONBOARDING_AUTHORIZATION}.md",
    );
    expect(documentPlaceholder("service_provider_agreement")).toBe(
      "{SERVICE_PROVIDER_AGREEMENT}.md",
    );
  });

  it("returns fallback for unknown document key", () => {
    expect(documentPlaceholder("unknown_key")).toBe("{UNKNOWN_DOCUMENT}.md");
  });
});

describe("Authoring Store", () => {
  let storeDir: string;
  let store: AuthoringStore;

  beforeEach(() => {
    storeDir = tmpDir();
    store = new AuthoringStore({ authoringDir: storeDir });
  });

  afterEach(() => {
    try {
      rmSync(storeDir, { recursive: true, force: true });
    } catch {}
  });

  it("creates a store directory if missing", () => {
    expect(existsSync(storeDir)).toBe(true);
  });

  it("saves and loads an application", () => {
    const app = createTestApplication();
    store.save(app);
    const loaded = store.load(app.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe(app.id);
    expect(loaded!.state).toBe("submitted");
    expect(loaded!.applicantData.entityName).toBe("Test Provider Inc.");
  });

  it("returns null for nonexistent application", () => {
    expect(store.load(randomUUID())).toBeNull();
  });

  it("lists applications in submission order", () => {
    const app1 = createTestApplication({ id: store.createId() });
    const app2 = createTestApplication({ id: store.createId() });
    app1.submittedAt = "2026-01-01T00:00:00Z";
    app2.submittedAt = "2026-02-01T00:00:00Z";
    store.save(app1);
    store.save(app2);
    const list = store.list();
    expect(list).toHaveLength(2);
    expect(list[0]!.id).toBe(app1.id);
    expect(list[1]!.id).toBe(app2.id);
  });

  it("deletes an unpublished application", () => {
    const app = createTestApplication();
    store.save(app);
    expect(store.load(app.id)).not.toBeNull();
    const deleted = store.delete(app.id);
    expect(deleted).toBe(true);
    expect(store.load(app.id)).toBeNull();
  });

  it("delete returns false for nonexistent", () => {
    expect(store.delete(randomUUID())).toBe(false);
  });

  it("creates stable opaque IDs", () => {
    const id1 = store.createId();
    const id2 = store.createId();
    expect(id1).not.toBe(id2);
    expect(id1).toMatch(/^[a-f0-9-]{36}$/);
  });

  it("writes formatted JSON records", () => {
    const app = createTestApplication();
    store.save(app);
    const appPath = join(storeDir, `${app.id}.json`);
    const raw = readFileSync(appPath, "utf-8");
    expect(raw).toContain('"id"');
    expect(raw).toContain(app.id);
    const parsed = JSON.parse(raw);
    expect(parsed.schemaVersion).toBe(APPLICATION_SCHEMA_VERSION);
  });
});

describe("Signing Config", () => {
  let configDir: string;

  beforeEach(() => {
    configDir = tmpDir();
  });

  afterEach(() => {
    try {
      rmSync(configDir, { recursive: true, force: true });
    } catch {}
  });

  it("loads empty config for nonexistent file", () => {
    const config = loadSigningConfig(join(configDir, "nonexistent.json"));
    expect(config.lists).toHaveLength(0);
  });

  it("finds signing config by list key", () => {
    const config = {
      lists: [
        {
          listKey: "eu_credimi",
          family: "wallet-providers",
          schemeOperatorName: "Credimi",
          schemeOperatorStreet: "Via Roma 1",
          schemeOperatorCountry: "IT",
          schemeName: "EU Wallet Providers List",
          schemeTerritory: "EU",
          schemeOperatorContactUri: "https://credimi.eu",
          distributionPointUri: "https://credimi.eu/latest",
          keyFile: "/k",
          certFile: "/c",
          schemeOperatorEmail: "operator@scheme.example",
          schemeOperatorWebsite: "https://scheme.example",
          schemeInformationUris: [
            "https://scheme.example/scheme",
            "https://scheme.example/practice-statement",
          ],
          policyUri: "https://scheme.example/policy",
        },
      ],
    };
    const found = findSigningConfig(config, "eu_credimi");
    expect(found).toBeDefined();
    expect(found!.family).toBe("wallet-providers");
  });

  it("returns undefined for missing list key", () => {
    const config = { lists: [] };
    expect(findSigningConfig(config, "nonexistent")).toBeUndefined();
  });

  it("displays signing config entries", () => {
    const config = {
      lists: [
        {
          listKey: "eu_test",
          family: "wallet-providers",
          schemeOperatorName: "Test",
          schemeOperatorStreet: "Test St",
          schemeOperatorCountry: "IT",
          schemeName: "Test List",
          schemeTerritory: "EU",
          schemeOperatorContactUri: "https://test.eu",
          distributionPointUri: "https://test.eu/latest",
          keyFile: "/nonexistent",
          certFile: "/nonexistent",
          schemeOperatorEmail: "operator@scheme.example",
          schemeOperatorWebsite: "https://scheme.example",
          schemeInformationUris: [
            "https://scheme.example/scheme",
            "https://scheme.example/practice-statement",
          ],
          policyUri: "https://scheme.example/policy",
        },
      ],
    };
    const entries = signingConfigDisplay(config);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.listKey).toBe("eu_test");
    expect(entries[0]!.configured).toBe(false);
  });
});

describe("GUI disabled by default", () => {
  it("defaults DATA_COLLECTION_GUI to false", () => {
    expect((process.env["DATA_COLLECTION_GUI"] ?? "false") === "true").toBe(
      false,
    );
  });
});

describe("End-to-end publication workflow", () => {
  let pubDir: string;
  let authoringDir: string;
  let store: PublicationStore;
  let authoringStore: AuthoringStore;

  beforeEach(() => {
    pubDir = tmpDir();
    authoringDir = tmpDir();
    store = new PublicationStore({ publicationDir: pubDir });
    authoringStore = new AuthoringStore({ authoringDir });
  });

  afterEach(() => {
    try {
      rmSync(pubDir, { recursive: true, force: true });
    } catch {}
    try {
      rmSync(authoringDir, { recursive: true, force: true });
    } catch {}
  });

  it("full compile → validate → sign → verify → publish → store workflow", async () => {
    const app = createTestApplication();
    authoringStore.save(app);

    const input = normalizeToAuthoringInput(
      app,
      TEST_SCHEME,
      "2026-07-28T00:00:00Z",
      "2027-01-28T00:00:00Z",
      1,
    );

    const { document } = compile(input);

    const etsiResult = await validateEtsiStruct(document);
    expect(etsiResult.valid).toBe(true);
    expect(etsiResult.findings).toHaveLength(0);

    const signingKey = await importSigningKey();
    const signedDoc = await sign({
      document,
      key: signingKey,
      certificatePem: TEST_CERT,
    });

    const verifyResult = await verify({
      compactJws: signedDoc.compact,
      certificatePem: TEST_CERT,
    });
    expect(verifyResult.valid).toBe(true);

    const pubResult = await publish({
      compactJws: signedDoc.compact,
      certificatePem: TEST_CERT,
    });

    expect(pubResult.listKey).toBe("eu_credimi");
    expect(pubResult.sequenceNumber).toBe(1);
    expect(pubResult.manifest.signatureValid).toBe(true);
    expect(pubResult.manifest.etsiSchemaValid).toBe(true);
    expect(pubResult.manifest.signerTrustStatus).toBe("not_evaluated");
    expect(pubResult.manifest.compactJadesSha256).toMatch(/^[0-9a-f]{64}$/);

    const manifestJson = JSON.stringify(pubResult.manifest, null, 2);
    await store.store(
      pubResult,
      signedDoc.compact,
      pubResult.loteJson,
      manifestJson,
    );

    const manifestHash = createHash("sha256")
      .update(manifestJson)
      .digest("hex");

    app.state = "published";
    app.approvedAt = new Date().toISOString();
    app.publication = {
      listKey: pubResult.listKey,
      sequenceNumber: pubResult.sequenceNumber,
      manifestSha256: manifestHash,
      compactJadesSha256: pubResult.manifest.compactJadesSha256,
      publicationTimestamp: pubResult.manifest.publicationTimestamp,
    };
    authoringStore.save(app);

    const loadedApp = authoringStore.load(app.id);
    expect(loadedApp!.publication).toBeDefined();
    expect(loadedApp!.publication!.listKey).toBe("eu_credimi");
    expect(loadedApp!.publication!.sequenceNumber).toBe(1);
    expect(loadedApp!.publication!.compactJadesSha256).toMatch(
      /^[0-9a-f]{64}$/,
    );

    const loadedManifest = await store.loadManifest(
      pubResult.listKey,
      pubResult.sequenceNumber,
    );
    expect(loadedManifest).not.toBeNull();
    expect(loadedManifest!.listKey).toBe("eu_credimi");

    const versionArtifacts = await loadVersionArtifacts(
      pubDir,
      pubResult.listKey,
      pubResult.sequenceNumber,
      10 * 1024 * 1024,
    );
    expect(versionArtifacts.artifacts).not.toBeNull();
    expect(versionArtifacts.artifacts!.manifest.signatureValid).toBe(true);
  });

  it("published application cannot transition back", () => {
    expect(canTransition("published", "approved")).toBe(false);
    expect(canTransition("published", "rejected")).toBe(false);
    expect(canTransition("published", "submitted")).toBe(false);
  });

  it("rejected application cannot be published", () => {
    expect(canTransition("rejected", "published")).toBe(false);
  });

  it("missing signing config should be detectable", () => {
    const config = loadSigningConfig("/nonexistent/path.json");
    expect(config.lists).toHaveLength(0);
    expect(findSigningConfig(config, "eu_credimi")).toBeUndefined();
  });
});
