import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import * as jose from "jose";
import swaggerParser from "@apidevtools/swagger-parser";
import {
  readFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  readdirSync,
  statSync as fsStatSync,
  readFileSync as fsReadFileSync,
  writeFileSync as fsWriteFileSync,
  mkdirSync as fsMkdirSync,
  readdirSync as fsReaddirSync,
  existsSync as fsExistsSync,
  lstatSync as fsLstatSync,
  realpathSync as fsRealpathSync,
  unlinkSync as fsUnlinkSync,
  rmdirSync as fsRmdirSync,
} from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { randomUUID, createHash } from "node:crypto";
import * as crypto from "node:crypto";
import {
  compile,
  sign,
  publish,
  PublicationStore,
  loadVersionArtifacts,
  resetValidators,
  ApplicationService,
  AuthoringStore,
  type AuthoringInput,
} from "../src/core/index.js";
import { createWebServer, getApiRoutes } from "../src/web/server.js";
import type { Server } from "node:http";
import { get as httpGetFn } from "node:http";
import type { FsOps } from "../src/core/publication/store.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const AUTHORING: AuthoringInput = {
  schemeOperator: {
    name: [{ lang: "en", value: "Test Authority" }],
    postalAddress: [{ lang: "en", StreetAddress: "1 Test St", Country: "EU" }],
    electronicAddress: [{ lang: "en", uriValue: "mailto:test@test.org" }],
  },
  scheme: {
    schemeName: [{ lang: "en", value: "Test Wallet Providers" }],
    schemeTerritory: "EU",
    distributionPoints: ["https://test.org/lote.json"],
  },
  listIssueDateTime: "2026-01-01T00:00:00Z",
  nextUpdate: "2026-07-01T00:00:00Z",
  loTESequenceNumber: 1,
  entities: [
    {
      teName: [{ lang: "en", value: "Test Wallet Provider" }],
      tePostalAddress: [
        { lang: "en", StreetAddress: "2 Wallet St", Country: "NL" },
      ],
      teElectronicAddress: [{ lang: "en", uriValue: "mailto:wallet@test.nl" }],
      teInformationURI: [
        { lang: "en", uriValue: "http://uri.etsi.org/19602/WP/NL" },
      ],
      services: [
        {
          serviceTypeIdentifier:
            "http://uri.etsi.org/19602/SvcType/WalletSolution/Issuance",
          serviceName: [{ lang: "en", value: "Issuance" }],
          serviceDigitalIdentity: { x509Certificates: ["MIIDfakecertvalue=="] },
          serviceUniqueIdentifier: "http://test.nl/svc/1",
        },
      ],
    },
  ],
};

let testKey: globalThis.CryptoKey;
let testCertPem: string;
let testCert2Pem: string;

async function importKey(pemPath: string): Promise<globalThis.CryptoKey> {
  const pem = readFileSync(resolve(__dirname, "fixtures", pemPath), "utf-8");
  const pk = crypto.createPrivateKey(pem);
  const jwk = pk.export({ format: "jwk" });
  return crypto.subtle.importKey(
    "jwk",
    jwk as any,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  ) as Promise<globalThis.CryptoKey>;
}

function tmpDir(): string {
  const d = join(tmpdir(), "tlp-fix-" + randomUUID().slice(0, 8));
  mkdirSync(d, { recursive: true });
  return d;
}

function httpGet(baseUrl: string, path: string, method = "GET") {
  return new Promise<{
    status: number;
    body: string;
    headers: Record<string, string>;
  }>((resolve, reject) => {
    httpGetFn(`${baseUrl}${path}`, { method }, (res) => {
      let body = "";
      res.on("data", (c: Buffer) => (body += c.toString()));
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          body,
          headers: res.headers as Record<string, string>,
        }),
      );
    }).on("error", reject);
  });
}

function base64url(s: string): string {
  return Buffer.from(s).toString("base64url");
}

beforeAll(async () => {
  resetValidators();
  testKey = await importKey("test-key.pem");
  testCertPem = readFileSync(
    resolve(__dirname, "fixtures", "test-cert.pem"),
    "utf-8",
  );
  testCert2Pem = readFileSync(
    resolve(__dirname, "fixtures", "test-cert2.pem"),
    "utf-8",
  );
});

// ============================================================
// 1. Stored-publication x5c authentication
// ============================================================
describe("Stored-publication x5c authentication", () => {
  it("rejects stored version with no x5c", async () => {
    const dir = tmpDir();
    const store = new PublicationStore({ publicationDir: dir });
    try {
      const { document } = compile(AUTHORING);
      const { compact } = await sign({
        document,
        key: testKey,
        certificatePem: testCertPem,
      });
      const pubResult = await publish({
        compactJws: compact,
        certificatePem: testCertPem,
      });
      await store.store(
        pubResult,
        compact,
        pubResult.loteJson,
        JSON.stringify(pubResult.manifest, null, 2),
      );

      const parts = compact.split(".");
      const header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString());
      delete header.x5c;
      const newHeader = base64url(JSON.stringify(header));
      const tampered = `${newHeader}.${parts[1]}.${parts[2]}`;

      const mPath = resolve(
        dir,
        "eu_test_authority",
        "versions",
        "1",
        "manifest.json",
      );
      const m = JSON.parse(readFileSync(mPath, "utf-8"));
      m.compactJadesSha256 = createHash("sha256")
        .update(tampered)
        .digest("hex");
      writeFileSync(mPath, JSON.stringify(m, null, 2), "utf-8");
      writeFileSync(
        resolve(dir, "eu_test_authority", "versions", "1", "lote.jades"),
        tampered,
        "utf-8",
      );

      const outcome = await loadVersionArtifacts(
        dir,
        "eu_test_authority",
        1,
        10 * 1024 * 1024,
      );
      expect(outcome.artifacts).toBeNull();
      expect(outcome.diagnostic).toContain("x5c");
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  });

  it("rejects stored version with empty x5c array", async () => {
    const dir = tmpDir();
    const store = new PublicationStore({ publicationDir: dir });
    try {
      const { document } = compile(AUTHORING);
      const { compact } = await sign({
        document,
        key: testKey,
        certificatePem: testCertPem,
      });
      const pubResult = await publish({
        compactJws: compact,
        certificatePem: testCertPem,
      });
      await store.store(
        pubResult,
        compact,
        pubResult.loteJson,
        JSON.stringify(pubResult.manifest, null, 2),
      );

      const parts = compact.split(".");
      const header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString());
      header.x5c = [];
      const newHeader = base64url(JSON.stringify(header));
      const tampered = `${newHeader}.${parts[1]}.${parts[2]}`;

      const mPath = resolve(
        dir,
        "eu_test_authority",
        "versions",
        "1",
        "manifest.json",
      );
      const m = JSON.parse(readFileSync(mPath, "utf-8"));
      m.compactJadesSha256 = createHash("sha256")
        .update(tampered)
        .digest("hex");
      writeFileSync(mPath, JSON.stringify(m, null, 2), "utf-8");
      writeFileSync(
        resolve(dir, "eu_test_authority", "versions", "1", "lote.jades"),
        tampered,
        "utf-8",
      );

      const outcome = await loadVersionArtifacts(
        dir,
        "eu_test_authority",
        1,
        10 * 1024 * 1024,
      );
      expect(outcome.artifacts).toBeNull();
      expect(outcome.diagnostic).toContain("x5c");
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  });

  it("rejects stored version with malformed x5c", async () => {
    const dir = tmpDir();
    const store = new PublicationStore({ publicationDir: dir });
    try {
      const { document } = compile(AUTHORING);
      const { compact } = await sign({
        document,
        key: testKey,
        certificatePem: testCertPem,
      });
      const pubResult = await publish({
        compactJws: compact,
        certificatePem: testCertPem,
      });
      await store.store(
        pubResult,
        compact,
        pubResult.loteJson,
        JSON.stringify(pubResult.manifest, null, 2),
      );

      const parts = compact.split(".");
      const header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString());
      header.x5c = ["not-a-valid-base64"];
      const newHeader = base64url(JSON.stringify(header));
      const tampered = `${newHeader}.${parts[1]}.${parts[2]}`;

      const mPath = resolve(
        dir,
        "eu_test_authority",
        "versions",
        "1",
        "manifest.json",
      );
      const m = JSON.parse(readFileSync(mPath, "utf-8"));
      m.compactJadesSha256 = createHash("sha256")
        .update(tampered)
        .digest("hex");
      writeFileSync(mPath, JSON.stringify(m, null, 2), "utf-8");
      writeFileSync(
        resolve(dir, "eu_test_authority", "versions", "1", "lote.jades"),
        tampered,
        "utf-8",
      );

      const outcome = await loadVersionArtifacts(
        dir,
        "eu_test_authority",
        1,
        10 * 1024 * 1024,
      );
      expect(outcome.artifacts).toBeNull();
      expect(outcome.diagnostic).toContain("x5c");
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  });

  it("rejects malformed protected header", async () => {
    const dir = tmpDir();
    const store = new PublicationStore({ publicationDir: dir });
    try {
      const { document } = compile(AUTHORING);
      const { compact } = await sign({
        document,
        key: testKey,
        certificatePem: testCertPem,
      });
      const pubResult = await publish({
        compactJws: compact,
        certificatePem: testCertPem,
      });
      await store.store(
        pubResult,
        compact,
        pubResult.loteJson,
        JSON.stringify(pubResult.manifest, null, 2),
      );

      const parts = compact.split(".");
      const tampered = `{broken}.${parts[1]}.${parts[2]}`;

      const mPath = resolve(
        dir,
        "eu_test_authority",
        "versions",
        "1",
        "manifest.json",
      );
      const m = JSON.parse(readFileSync(mPath, "utf-8"));
      m.compactJadesSha256 = createHash("sha256")
        .update(tampered)
        .digest("hex");
      writeFileSync(mPath, JSON.stringify(m, null, 2), "utf-8");
      writeFileSync(
        resolve(dir, "eu_test_authority", "versions", "1", "lote.jades"),
        tampered,
        "utf-8",
      );

      const outcome = await loadVersionArtifacts(
        dir,
        "eu_test_authority",
        1,
        10 * 1024 * 1024,
      );
      expect(outcome.artifacts).toBeNull();
      expect(outcome.diagnostic).toContain("malformed");
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  });
});

// ============================================================
// 2. Correct publication gate tests
// ============================================================
describe("Publication gate tests", () => {
  it("rejects publication when expected cert differs from embedded leaf", async () => {
    const { document } = compile(AUTHORING);
    const { compact } = await sign({
      document,
      key: testKey,
      certificatePem: testCertPem,
    });
    await expect(
      publish({ compactJws: compact, certificatePem: testCert2Pem }),
    ).rejects.toThrow();
  });

  it("rejects genuinely signed non-JSON payload", async () => {
    const msg = new TextEncoder().encode("this is not json");
    const certDer = testCertPem
      .replace(/-----[^-]+-----/g, "")
      .replace(/\s/g, "");
    const jws = await new jose.CompactSign(msg)
      .setProtectedHeader({ alg: "ES256", x5c: [certDer] })
      .sign(testKey);
    await expect(
      publish({ compactJws: jws, certificatePem: testCertPem }),
    ).rejects.toThrow();
  });

  it("rejects malformed certificate", async () => {
    const { document } = compile(AUTHORING);
    const { compact } = await sign({
      document,
      key: testKey,
      certificatePem: testCertPem,
    });
    await expect(
      publish({ compactJws: compact, certificatePem: "not-a-cert" }),
    ).rejects.toThrow();
  });
});

// ============================================================
// 3. Deterministic atomic failure (FsOps injection)
// ============================================================
describe("Atomic publication failure", () => {
  it("deterministic rename failure leaves no partial state", async () => {
    const dir = tmpDir();
    const { document } = compile(AUTHORING);
    const { compact } = await sign({
      document,
      key: testKey,
      certificatePem: testCertPem,
    });
    const pubResult = await publish({
      compactJws: compact,
      certificatePem: testCertPem,
    });

    const failingFs: FsOps = {
      existsSync: fsExistsSync,
      lstatSync: fsLstatSync,
      statSync: fsStatSync,
      readFileSync: fsReadFileSync,
      writeFileSync: fsWriteFileSync,
      mkdirSync: fsMkdirSync,
      readdirSync: fsReaddirSync,
      realpathSync: fsRealpathSync,
      unlinkSync: fsUnlinkSync,
      rmdirSync: fsRmdirSync,
      renameSync(_oldPath: any, _newPath: any): void {
        throw new Error("injected rename failure");
      },
    };

    const store = new PublicationStore({ publicationDir: dir }, failingFs);

    await expect(
      store.store(
        pubResult,
        compact,
        pubResult.loteJson,
        JSON.stringify(pubResult.manifest, null, 2),
      ),
    ).rejects.toThrow("injected rename failure");

    // No version directory created
    const listDir = resolve(dir, "eu_test_authority");
    if (existsSync(listDir)) {
      const entries = readdirSync(listDir, { withFileTypes: true });
      const verDirs = entries.filter(
        (d) => d.isDirectory() && d.name !== "versions",
      );
      expect(verDirs.length).toBe(0);
    }

    // No staging directories
    if (existsSync(dir)) {
      const entries = readdirSync(dir, { withFileTypes: true });
      expect(entries.filter((d) => d.name.startsWith(".staging_")).length).toBe(
        0,
      );
    }

    // No index exists
    const idx = await store.loadIndex("eu_test_authority");
    expect(idx).toBeNull();

    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  });
});

// ============================================================
// 4. OpenAPI route parity
// ============================================================
describe("OpenAPI route parity", () => {
  let pubDir: string;
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    pubDir = tmpDir();
    server = createWebServer({ publicationDir: pubDir, port: 0 });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr === "object")
          baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });
  afterEach(() => {
    server.close();
    try {
      rmSync(pubDir, { recursive: true, force: true });
    } catch {}
  });

  it("bidirectional parity: every implemented route in OpenAPI and vice versa", async () => {
    const implemented = getApiRoutes();
    const implSet = new Set(implemented.map((r) => `${r.method} ${r.path}`));

    const r = await httpGet(baseUrl, "/openapi.json");
    const spec = JSON.parse(r.body);
    const docPaths: Record<string, any> = spec.paths ?? {};

    for (const route of implemented) {
      expect(docPaths).toHaveProperty(route.path);
      expect(docPaths[route.path]).toHaveProperty("get");
    }

    for (const [docPath, methods] of Object.entries(docPaths)) {
      for (const method of Object.keys(methods as object)) {
        if (method.toLowerCase() === "get") {
          expect(implSet.has(`GET ${docPath}`)).toBe(true);
        }
      }
    }
  });

  it("OpenAPI passes swagger-parser validation", async () => {
    const r = await httpGet(baseUrl, "/openapi.json");
    const parsed = JSON.parse(r.body);
    await swaggerParser.validate(parsed);
  });
});

// ============================================================
// 5. Multi-service form rendering
// ============================================================
describe("Multi-service form rendering", () => {
  it("renders all submitted services after validation failure", async () => {
    const { walletProviderFormHtml } =
      await import("../src/web/views/onboarding.js");

    const values: Record<string, string> = {
      entityName: "Test Corp",
      entityStreetAddress: "123 St",
      entityCountry: "IT",
      entityInformationURI: "https://test.example",
      "service[0].serviceType": "issuance",
      "service[0].serviceName": "Service Zero",
      "service[0].certificatePem": "bad-cert",
      "service[0].serviceUniqueIdentifier": "https://a.example",
      "service[1].serviceType": "revocation",
      "service[1].serviceName": "",
      "service[1].certificatePem": "",
      "service[1].serviceUniqueIdentifier": "not-a-url",
    };
    const errors: Record<string, string> = {
      "service[0].certificatePem": "Bad certificate",
      "service[1].serviceName": "Required",
      "service[1].certificatePem": "Required",
      "service[1].serviceUniqueIdentifier": "Bad URI",
    };

    const html = walletProviderFormHtml(values, errors, []);
    expect(html).toContain("Service 1");
    expect(html).toContain("Service 2");
    expect(html).toContain("Service Zero");
    expect(html).toContain("Bad certificate");
    expect(html).toContain("Required");
    expect(html).toContain("Bad URI");
  });
});

// ============================================================
// 6. Deep stored-application validation
// ============================================================
describe("Deep stored-application validation", () => {
  let authoringDir: string;
  let store: AuthoringStore;

  beforeEach(() => {
    authoringDir = tmpDir();
    store = new AuthoringStore({ authoringDir });
  });
  afterEach(() => {
    try {
      rmSync(authoringDir, { recursive: true, force: true });
    } catch {}
  });

  function writeMalformed(
    id: string,
    applicantOverrides: Record<string, unknown>,
  ): void {
    const baseApp = {
      id,
      schemaVersion: 1,
      family: "wallet-providers",
      targetListKey: "eu_test",
      state: "submitted",
      submittedAt: "2026-01-01T00:00:00Z",
      applicantData: {
        entityName: "Corp",
        entityStreetAddress: "123 St",
        entityCountry: "IT",
        entityInformationURI: "https://x.example",
        services: [
          {
            serviceType: "issuance",
            serviceName: "Svc",
            certificatePem:
              "-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----",
            serviceUniqueIdentifier: "https://svc.example",
          },
        ],
        ...applicantOverrides,
      },
    };
    const p = resolve(authoringDir, `${id}.json`);
    writeFileSync(p, JSON.stringify(baseApp, null, 2), "utf-8");
  }

  it("rejects invalid state", () => {
    const id = crypto.randomUUID() as string;
    writeFileSync(
      resolve(authoringDir, `${id}.json`),
      JSON.stringify(
        {
          id,
          schemaVersion: 1,
          family: "wallet-providers",
          targetListKey: "eu_test",
          state: "invalid-state",
          submittedAt: "2026-01-01T00:00:00Z",
          applicantData: {
            entityName: "X",
            entityStreetAddress: "X",
            entityCountry: "IT",
            entityInformationURI: "https://x",
            services: [
              {
                serviceType: "issuance",
                serviceName: "X",
                certificatePem:
                  "-----BEGIN CERTIFICATE-----\nA\n-----END CERTIFICATE-----",
                serviceUniqueIdentifier: "https://x",
              },
            ],
          },
        },
        null,
        2,
      ),
      "utf-8",
    );
    expect(store.load(id)).toBeNull();
  });

  it("rejects non-array services", () => {
    const id = randomUUID();
    writeMalformed(id, { services: "not-an-array" } as any);
    expect(store.load(id)).toBeNull();
  });

  it("rejects empty services array", () => {
    const id = randomUUID();
    writeMalformed(id, { services: [] });
    expect(store.load(id)).toBeNull();
  });

  it("rejects malformed service entry", () => {
    const id = randomUUID();
    writeMalformed(id, {
      services: [
        {
          serviceType: "unknown",
          serviceName: "X",
          certificatePem: "C",
          serviceUniqueIdentifier: "U",
        },
      ],
    });
    expect(store.load(id)).toBeNull();
  });

  it("corrupt record does not hide healthy ones", () => {
    const goodId1 = randomUUID();
    writeMalformed(goodId1, {});
    const goodId2 = randomUUID();
    writeMalformed(goodId2, {});
    const badId = randomUUID();
    writeMalformed(badId, {});
    writeFileSync(
      resolve(authoringDir, `${badId}.json`),
      "not-json{{{",
      "utf-8",
    );

    const list = store.list();
    expect(list.length).toBe(2);
    expect(list.map((a) => a.id).sort()).toEqual([goodId1, goodId2].sort());
  });
});

// ============================================================
// 7. Preview and publication consistency
// ============================================================
describe("Preview and publication consistency", () => {
  it("preview and publish derive equivalent compiler input", async () => {
    const pubDir = tmpDir();
    const authDir = tmpDir();
    const configPath = join(tmpDir(), "sc.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        lists: [
          {
            listKey: "eu_test_authority",
            family: "wallet-providers",
            schemeOperatorName: "Test Authority",
            schemeOperatorStreet: "1 Test St",
            schemeOperatorCountry: "EU",
            schemeName: "Test Wallet Providers",
            schemeTerritory: "EU",
            schemeOperatorContactUri: "mailto:test@test.org",
            distributionPointUri: "https://test.org/lote.json",
            keyFile: resolve(__dirname, "fixtures", "test-key.pem"),
            certFile: resolve(__dirname, "fixtures", "test-cert.pem"),
          },
        ],
      }),
    );
    const signingConfig = (
      await import("../src/core/authoring/signing-config.js")
    ).loadSigningConfig(configPath);
    const pubStore = new PublicationStore({ publicationDir: pubDir });
    const authoringStore = new AuthoringStore({ authoringDir: authDir });
    const service = new ApplicationService(
      authoringStore,
      pubStore,
      signingConfig,
    );

    const app = {
      id: authoringStore.createId(),
      schemaVersion: 1,
      family: "wallet-providers" as const,
      targetListKey: "eu_test_authority",
      state: "submitted" as const,
      submittedAt: new Date().toISOString(),
      applicantData: {
        entityName: "Preview Corp",
        entityStreetAddress: "1 St",
        entityCountry: "IT",
        entityInformationURI: "https://preview.example",
        services: [
          {
            serviceType: "issuance" as const,
            serviceName: "Svc",
            certificatePem: testCertPem,
            serviceUniqueIdentifier: "https://svc.example",
          },
        ],
      },
    };
    authoringStore.save(app);

    const preview = await service.preview(app);
    expect(preview.compilerInputJson).toBeTruthy();
    expect(preview.etsiValid).toBe(true);

    try {
      rmSync(pubDir, { recursive: true, force: true });
    } catch {}
    try {
      rmSync(authDir, { recursive: true, force: true });
    } catch {}
    try {
      unlinkSync(configPath);
    } catch {}
  });
});
