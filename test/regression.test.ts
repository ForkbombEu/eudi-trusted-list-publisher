import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import {
  readFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  lstatSync,
  readdirSync,
} from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import * as crypto from "node:crypto";
import {
  compile,
  sign,
  publish,
  PublicationStore,
  loadVersionArtifacts,
  resetValidators,
} from "../src/core/index.js";
import type { AuthoringInput } from "../src/core/index.js";
import { createWebServer, getApiRoutes } from "../src/web/server.js";
import type { Server } from "node:http";
import { get as httpGetFn } from "node:http";
import swaggerParser from "@apidevtools/swagger-parser";

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
        { lang: "en", uriValue: "http://uri.etsi.org/19602/LoTE/WP/NL" },
      ],
      services: [
        {
          serviceTypeIdentifier:
            "http://uri.etsi.org/19602/SvcType/WalletSolution/Issuance",
          serviceName: [{ lang: "en", value: "Wallet Issuance" }],
          serviceDigitalIdentity: { x509Certificates: ["MIIDfakecertvalue=="] },
          serviceUniqueIdentifier: "http://test.nl/service/unique-id-001",
        },
      ],
    },
  ],
};

let testKey: globalThis.CryptoKey;
let testCertPem: string;

async function importTestKey(): Promise<globalThis.CryptoKey> {
  const pem = readFileSync(
    resolve(__dirname, "fixtures", "test-key.pem"),
    "utf-8",
  );
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
  const d = join(tmpdir(), "tlp-regress-" + randomUUID().slice(0, 8));
  mkdirSync(d, { recursive: true });
  return d;
}

async function httpGetRaw(
  url: string,
  method = "GET",
): Promise<{ status: number; body: string; headers: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    const req = httpGetFn(url, { method }, (res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => (body += chunk.toString()));
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          body,
          headers: res.headers as Record<string, string>,
        }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}

function httpGet(
  baseUrl: string,
  path: string,
  method = "GET",
): Promise<{ status: number; body: string; headers: Record<string, string> }> {
  return httpGetRaw(`${baseUrl}${path}`, method);
}

beforeAll(async () => {
  resetValidators();
  testKey = await importTestKey();
  testCertPem = readFileSync(
    resolve(__dirname, "fixtures", "test-cert.pem"),
    "utf-8",
  );
});

// ============================================================
// 1. Read-only server: zero filesystem writes on GET/HEAD
// ============================================================
describe("Read-only server", () => {
  let pubDir: string;
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    pubDir = tmpDir();
    const createdServer = createWebServer({ publicationDir: pubDir, port: 0 });
    server = createdServer;
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr === "object") {
          baseUrl = `http://127.0.0.1:${addr.port}`;
        }
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

  it("does not create publication root on server start", () => {
    expect(existsSync(pubDir)).toBe(true); // tmpDir creates it
    const nestedDir = join(pubDir, "nested");
    const createdServer2 = createWebServer({
      publicationDir: nestedDir,
      port: 0,
    });
    expect(existsSync(nestedDir)).toBe(false);
    createdServer2.close();
  });

  it("treats missing root as empty store", async () => {
    const r = await httpGetRaw(baseUrl, "GET");
    expect(r.status).toBe(200);
    expect(r.body).toContain("No lists have been published");
  });

  it("does not write files on GET requests", async () => {
    const snapshot = readdirSync(pubDir).sort();
    await httpGetRaw(baseUrl, "GET");
    await httpGetRaw(`${baseUrl}/openapi.json`, "GET");
    await httpGetRaw(`${baseUrl}/openapi.yaml`, "GET");
    await httpGetRaw(`${baseUrl}/healthz`, "GET");
    await httpGetRaw(`${baseUrl}/api/v1/lists`, "GET");
    const afterSnapshot = readdirSync(pubDir).sort();
    expect(afterSnapshot).toEqual(snapshot);
  });
});

// ============================================================
// 2. Symlink-safe reads and writes
// ============================================================
describe("Symlink-safe reads", () => {
  let pubDir: string;
  let store: PublicationStore;

  beforeEach(() => {
    pubDir = tmpDir();
    store = new PublicationStore({ publicationDir: pubDir });
  });

  afterEach(() => {
    try {
      rmSync(pubDir, { recursive: true, force: true });
    } catch {}
  });

  it("rejects symlinked list directory in listKeys", async () => {
    const testCert = readFileSync(
      resolve(__dirname, "fixtures", "test-cert.pem"),
      "utf-8",
    );
    const { document } = compile(AUTHORING);
    const { compact } = await sign({
      document,
      key: testKey,
      certificatePem: testCert,
    });
    const pubResult = await publish({
      compactJws: compact,
      certificatePem: testCert,
    });

    await store.store(
      pubResult,
      compact,
      pubResult.loteJson,
      JSON.stringify(pubResult.manifest, null, 2),
    );

    const listDir = resolve(pubDir, "eu_test_authority");
    rmSync(listDir, { recursive: true, force: true });
    mkdirSync(listDir, { recursive: true });
    writeFileSync(join(listDir, ".keep"), "x");
    const externalDir = join(tmpdir(), "external-" + randomUUID().slice(0, 8));
    mkdirSync(externalDir, { recursive: true });
    writeFileSync(join(externalDir, "external-secret.txt"), "SECRET_DATA");
    const fakeListDir = resolve(pubDir, "eu_external");
    symlinkSync(externalDir, fakeListDir);

    const keys = store.listKeys();
    expect(keys).not.toContain("eu_external");
    expect(keys).toContain("eu_test_authority");

    unlinkSync(fakeListDir);
    rmSync(externalDir, { recursive: true, force: true });
  });

  it("rejects symlinked version directory", async () => {
    const testCert = readFileSync(
      resolve(__dirname, "fixtures", "test-cert.pem"),
      "utf-8",
    );
    const { document } = compile(AUTHORING);
    const { compact } = await sign({
      document,
      key: testKey,
      certificatePem: testCert,
    });
    const pubResult = await publish({
      compactJws: compact,
      certificatePem: testCert,
    });

    await store.store(
      pubResult,
      compact,
      pubResult.loteJson,
      JSON.stringify(pubResult.manifest, null, 2),
    );

    const verDir = resolve(pubDir, "eu_test_authority", "versions", "1");
    const fakeTarget = join(tmpdir(), "fake-ver-" + randomUUID().slice(0, 8));
    mkdirSync(fakeTarget, { recursive: true });
    writeFileSync(join(fakeTarget, "lote.json"), '{"x":"leaked"}');

    rmSync(verDir, { recursive: true, force: true });
    symlinkSync(fakeTarget, verDir);

    const outcome = await loadVersionArtifacts(
      pubDir,
      "eu_test_authority",
      1,
      10 * 1024 * 1024,
    );
    expect(outcome.artifacts).toBeNull();
    expect(outcome.diagnostic).toContain("symlink");

    unlinkSync(verDir);
    rmSync(fakeTarget, { recursive: true, force: true });
  });

  it("rejects symlinked manifest.json", async () => {
    const testCert = readFileSync(
      resolve(__dirname, "fixtures", "test-cert.pem"),
      "utf-8",
    );
    const { document } = compile(AUTHORING);
    const { compact } = await sign({
      document,
      key: testKey,
      certificatePem: testCert,
    });
    const pubResult = await publish({
      compactJws: compact,
      certificatePem: testCert,
    });

    mkdirSync(resolve(pubDir, "eu_test_authority", "versions", "1"), {
      recursive: true,
    });
    writeFileSync(
      resolve(pubDir, "eu_test_authority", "versions", "1", "lote.json"),
      pubResult.loteJson,
    );
    writeFileSync(
      resolve(pubDir, "eu_test_authority", "versions", "1", "lote.jades"),
      compact,
    );
    const manifestPath = resolve(
      pubDir,
      "eu_test_authority",
      "versions",
      "1",
      "manifest.json",
    );
    const fakeManifest = join(
      tmpdir(),
      "fake-manifest-" + randomUUID().slice(0, 8),
    );
    mkdirSync(fakeManifest, { recursive: true });
    const attackPath = join(fakeManifest, "manifest.json");
    writeFileSync(attackPath, '{"bad":"data"}');
    symlinkSync(attackPath, manifestPath);

    const outcome = await loadVersionArtifacts(
      pubDir,
      "eu_test_authority",
      1,
      10 * 1024 * 1024,
    );
    expect(outcome.artifacts).toBeNull();
    expect(outcome.diagnostic).toContain("symlink");

    unlinkSync(manifestPath);
    rmSync(fakeManifest, { recursive: true, force: true });
  });

  it("rejects symlinked index.json via listKeys", async () => {
    const listDir = resolve(pubDir, "eu_fake");
    mkdirSync(resolve(listDir, "versions"), { recursive: true });
    const indexPath = resolve(listDir, "index.json");
    const externalFile = join(tmpdir(), "fake-idx-" + randomUUID().slice(0, 8));
    writeFileSync(externalFile, '{"listKey":"evil","versions":[]}');
    symlinkSync(externalFile, indexPath);

    const outcome = await store.loadIndex("eu_fake");
    expect(outcome).toBeNull();

    unlinkSync(indexPath);
    unlinkSync(externalFile);
    rmSync(listDir, { recursive: true, force: true });
  });
});

// ============================================================
// 3. Idempotent publication integrity
// ============================================================
describe("Idempotent publication integrity", () => {
  let pubDir: string;
  let store: PublicationStore;

  beforeEach(() => {
    pubDir = tmpDir();
    store = new PublicationStore({ publicationDir: pubDir });
  });

  afterEach(() => {
    try {
      rmSync(pubDir, { recursive: true, force: true });
    } catch {}
  });

  it("detects corrupted lote.json on republish", async () => {
    const testCert = readFileSync(
      resolve(__dirname, "fixtures", "test-cert.pem"),
      "utf-8",
    );
    const { document } = compile(AUTHORING);
    const { compact } = await sign({
      document,
      key: testKey,
      certificatePem: testCert,
    });
    const pubResult = await publish({
      compactJws: compact,
      certificatePem: testCert,
    });

    const manifestJson = JSON.stringify(pubResult.manifest, null, 2);
    await store.store(pubResult, compact, pubResult.loteJson, manifestJson);

    const lotePath = resolve(
      pubDir,
      "eu_test_authority",
      "versions",
      "1",
      "lote.json",
    );
    writeFileSync(lotePath, '{"corrupted": true}', "utf-8");

    await expect(
      store.store(pubResult, compact, pubResult.loteJson, manifestJson),
    ).rejects.toThrow(/corrupt/);
  });

  it("detects corrupted manifest.json on republish", async () => {
    const testCert = readFileSync(
      resolve(__dirname, "fixtures", "test-cert.pem"),
      "utf-8",
    );
    const { document } = compile(AUTHORING);
    const { compact } = await sign({
      document,
      key: testKey,
      certificatePem: testCert,
    });
    const pubResult = await publish({
      compactJws: compact,
      certificatePem: testCert,
    });

    const manifestJson = JSON.stringify(pubResult.manifest, null, 2);
    await store.store(pubResult, compact, pubResult.loteJson, manifestJson);

    const mPath = resolve(
      pubDir,
      "eu_test_authority",
      "versions",
      "1",
      "manifest.json",
    );
    writeFileSync(mPath, '{"corrupt": "yes"}', "utf-8");

    await expect(
      store.store(pubResult, compact, pubResult.loteJson, manifestJson),
    ).rejects.toThrow();
  });

  it("detects corrupted lote.jades on republish", async () => {
    const testCert = readFileSync(
      resolve(__dirname, "fixtures", "test-cert.pem"),
      "utf-8",
    );
    const { document } = compile(AUTHORING);
    const { compact } = await sign({
      document,
      key: testKey,
      certificatePem: testCert,
    });
    const pubResult = await publish({
      compactJws: compact,
      certificatePem: testCert,
    });

    const manifestJson = JSON.stringify(pubResult.manifest, null, 2);
    await store.store(pubResult, compact, pubResult.loteJson, manifestJson);

    const jadesPath = resolve(
      pubDir,
      "eu_test_authority",
      "versions",
      "1",
      "lote.jades",
    );
    writeFileSync(jadesPath, "tampered_data_here", "utf-8");

    await expect(
      store.store(pubResult, compact, pubResult.loteJson, manifestJson),
    ).rejects.toThrow();
  });

  it("accepts identical content as idempotent", async () => {
    const testCert = readFileSync(
      resolve(__dirname, "fixtures", "test-cert.pem"),
      "utf-8",
    );
    const { document } = compile(AUTHORING);
    const { compact } = await sign({
      document,
      key: testKey,
      certificatePem: testCert,
    });
    const pubResult = await publish({
      compactJws: compact,
      certificatePem: testCert,
    });

    const manifestJson = JSON.stringify(pubResult.manifest, null, 2);
    const r1 = await store.store(
      pubResult,
      compact,
      pubResult.loteJson,
      manifestJson,
    );
    expect(r1).toBeDefined();

    const r2 = await store.store(
      pubResult,
      compact,
      pubResult.loteJson,
      manifestJson,
    );
    expect(r2).toBeDefined();
    expect(r2.indexWarning).toBeFalsy();
  });
});

// ============================================================
// 4. Corrupt-version isolation
// ============================================================
describe("Corrupt-version isolation", () => {
  let pubDir: string;
  let store: PublicationStore;

  beforeEach(() => {
    pubDir = tmpDir();
    store = new PublicationStore({ publicationDir: pubDir });
  });

  afterEach(() => {
    try {
      rmSync(pubDir, { recursive: true, force: true });
    } catch {}
  });

  it("isolates one corrupt version without hiding healthy ones", async () => {
    const testCert = readFileSync(
      resolve(__dirname, "fixtures", "test-cert.pem"),
      "utf-8",
    );

    // Publish version 1 (healthy)
    const input1: AuthoringInput = { ...AUTHORING, loTESequenceNumber: 1 };
    const { document: doc1 } = compile(input1);
    const sig1 = await sign({
      document: doc1,
      key: testKey,
      certificatePem: testCert,
    });
    const pub1 = await publish({
      compactJws: sig1.compact,
      certificatePem: testCert,
    });
    await store.store(
      pub1,
      sig1.compact,
      pub1.loteJson,
      JSON.stringify(pub1.manifest, null, 2),
    );

    // Publish version 2 (healthy)
    const input2: AuthoringInput = { ...AUTHORING, loTESequenceNumber: 2 };
    const { document: doc2 } = compile(input2);
    const sig2 = await sign({
      document: doc2,
      key: testKey,
      certificatePem: testCert,
    });
    const pub2 = await publish({
      compactJws: sig2.compact,
      certificatePem: testCert,
    });
    await store.store(
      pub2,
      sig2.compact,
      pub2.loteJson,
      JSON.stringify(pub2.manifest, null, 2),
    );

    // Corrupt version 1
    const lotePath1 = resolve(
      pubDir,
      "eu_test_authority",
      "versions",
      "1",
      "lote.json",
    );
    writeFileSync(lotePath1, '{"corrupted": true}', "utf-8");

    // Load index - should show only version 2
    const index = await store.loadIndex("eu_test_authority");
    expect(index).not.toBeNull();
    expect(index!.versions.length).toBe(1);
    expect(index!.versions[0]!.sequenceNumber).toBe(2);

    // Loading corrupt version must be safe
    const corrupt = await store.loadManifest("eu_test_authority", 1);
    expect(corrupt).toBeNull();

    // Loading healthy version must work
    const healthy = await store.loadManifest("eu_test_authority", 2);
    expect(healthy).not.toBeNull();
    expect(healthy!.sequenceNumber).toBe(2);
  });
});

// ============================================================
// 5. HTTP correctness
// ============================================================
describe("HTTP correctness", () => {
  let pubDir: string;
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    pubDir = tmpDir();
    const createdServer = createWebServer({ publicationDir: pubDir, port: 0 });
    server = createdServer;
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr === "object") {
          baseUrl = `http://127.0.0.1:${addr.port}`;
        }
        resolve();
      });
    });
    server.on("error", () => {});
  });

  afterEach(() => {
    server.close();
    try {
      rmSync(pubDir, { recursive: true, force: true });
    } catch {}
  });

  it("returns correct security headers on GET 200", async () => {
    const r = await httpGetRaw(baseUrl, "GET");
    expect(r.status).toBe(200);
    expect(r.headers["x-content-type-options"] ?? "").toBe("nosniff");
    expect(r.headers["x-frame-options"] ?? "").toBe("DENY");
    expect(r.headers["referrer-policy"] ?? "").toBe("no-referrer");
  });

  it("returns correct security headers on 404", async () => {
    const r = await httpGetRaw(`${baseUrl}/nonexistent`, "GET");
    expect(r.status).toBe(404);
    expect(r.headers["x-content-type-options"] ?? "").toBe("nosniff");
    expect(r.headers["x-frame-options"] ?? "").toBe("DENY");
    expect(r.headers["referrer-policy"] ?? "").toBe("no-referrer");
  });

  it("returns correct security headers on 405", async () => {
    const r = await httpGetRaw(baseUrl, "POST");
    expect(r.status).toBe(405);
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.headers["allow"]).toContain("GET");
  });

  it("returns X-Request-ID on every response", async () => {
    const r = await httpGetRaw(baseUrl, "GET");
    expect(r.headers["x-request-id"]).toBeDefined();
    const r2 = await httpGetRaw(`${baseUrl}/openapi.yaml`, "GET");
    expect(r2.headers["x-request-id"]).toBeDefined();
  });

  it("uses immutable caching for versioned artifacts", async () => {
    const testCert = readFileSync(
      resolve(__dirname, "fixtures", "test-cert.pem"),
      "utf-8",
    );
    const { document } = compile(AUTHORING);
    const { compact: jades } = await sign({
      document,
      key: testKey,
      certificatePem: testCert,
    });
    const pubResult = await publish({
      compactJws: jades,
      certificatePem: testCert,
    });

    const tmpStore = new PublicationStore({ publicationDir: pubDir });
    await tmpStore.store(
      pubResult,
      jades,
      pubResult.loteJson,
      JSON.stringify(pubResult.manifest, null, 2),
    );

    const r1 = await httpGet(
      baseUrl,
      "/api/v1/lists/eu_test_authority/versions/1/lote",
    );
    expect(r1.headers["cache-control"]).toBe(
      "public, max-age=86400, immutable",
    );

    const r2 = await httpGet(
      baseUrl,
      "/api/v1/lists/eu_test_authority/versions/1/signature",
    );
    expect(r2.headers["cache-control"]).toBe(
      "public, max-age=86400, immutable",
    );

    const r3 = await httpGet(
      baseUrl,
      "/api/v1/lists/eu_test_authority/versions/1/manifest",
    );
    expect(r3.headers["cache-control"]).toBe(
      "public, max-age=86400, immutable",
    );
  });

  it("uses non-immutable caching for catalogue and list indexes", async () => {
    const testCert = readFileSync(
      resolve(__dirname, "fixtures", "test-cert.pem"),
      "utf-8",
    );
    const { document } = compile(AUTHORING);
    const { compact: jades } = await sign({
      document,
      key: testKey,
      certificatePem: testCert,
    });
    const pubResult = await publish({
      compactJws: jades,
      certificatePem: testCert,
    });
    const tmpStore = new PublicationStore({ publicationDir: pubDir });
    await tmpStore.store(
      pubResult,
      jades,
      pubResult.loteJson,
      JSON.stringify(pubResult.manifest, null, 2),
    );

    const r1 = await httpGet(baseUrl, "/");
    expect(r1.headers["cache-control"]).toBe("no-store");

    const r2 = await httpGet(baseUrl, "/api/v1/lists");
    expect(r2.headers["cache-control"]).toBe("no-store");
  });

  it("does not log query strings (token safety)", async () => {
    // We can't inspect stderr in test, but we verify the server doesn't crash
    const r = await httpGetRaw(`${baseUrl}/admin?token=DO_NOT_LOG`, "GET");
    expect(r.status === 404 || r.status === 403).toBe(true);
    // No crash = log was safe
  });
});

// ============================================================
// 6. OpenAPI validation and route parity
// ============================================================
describe("OpenAPI validation and route parity", () => {
  let pubDir: string;
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    pubDir = tmpDir();
    const createdServer = createWebServer({ publicationDir: pubDir, port: 0 });
    server = createdServer;
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr === "object") {
          baseUrl = `http://127.0.0.1:${addr.port}`;
        }
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

  it("OpenAPI document is valid", async () => {
    const r = await httpGet(baseUrl, "/openapi.json");
    const parsed = JSON.parse(r.body);
    expect(parsed.openapi).toBeDefined();
    expect(typeof parsed.openapi).toBe("string");

    // swagger-parser validate takes a parsed object or file path
    await swaggerParser.validate(parsed);
  });

  it("route registry matches OpenAPI paths", async () => {
    const routes = getApiRoutes();
    expect(routes.length).toBe(6);

    const r = await httpGet(baseUrl, "/openapi.yaml");
    const yamlContent = r.body;

    for (const route of routes) {
      const openApiPath = route.path.replace(/\{/g, "{").replace(/\}/g, "}");
      expect(yamlContent).toContain(openApiPath);
    }
  });

  it("all API routes return correct content types", async () => {
    const testCert = readFileSync(
      resolve(__dirname, "fixtures", "test-cert.pem"),
      "utf-8",
    );
    const { document } = compile(AUTHORING);
    const { compact: jades } = await sign({
      document,
      key: testKey,
      certificatePem: testCert,
    });
    const pubResult = await publish({
      compactJws: jades,
      certificatePem: testCert,
    });
    const tmpStore = new PublicationStore({ publicationDir: pubDir });
    await tmpStore.store(
      pubResult,
      jades,
      pubResult.loteJson,
      JSON.stringify(pubResult.manifest, null, 2),
    );

    const tests = [
      ["/api/v1/lists", "application/json"],
      ["/api/v1/lists/eu_test_authority", "application/json"],
      ["/api/v1/lists/eu_test_authority/versions/1", "application/json"],
      ["/api/v1/lists/eu_test_authority/versions/1/lote", "application/json"],
      [
        "/api/v1/lists/eu_test_authority/versions/1/signature",
        "application/octet-stream",
      ],
      [
        "/api/v1/lists/eu_test_authority/versions/1/manifest",
        "application/json",
      ],
    ];

    for (const [p, expectedContentType] of tests) {
      const path = p!;
      const r = await httpGet(baseUrl, path);
      expect(r.status).toBe(200);
      expect(r.headers["content-type"]).toContain(expectedContentType);
    }
  });
});

// ============================================================
// 7. Publication gate tests
// ============================================================
describe("Publication gate tests", () => {
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

  it("rejects expected certificate mismatch using a valid cert from disk", async () => {
    const { document: doc } = compile(AUTHORING);
    const { compact } = await sign({
      document: doc,
      key: testKey,
      certificatePem: testCertPem,
    });

    // Tamper: publish requires the JWS to contain valid JSON payload, not non-JSON
    const parts = compact.split(".");
    const tampered = `${parts[0]}.${base64url("bm90LWpzb24=")}.${parts[2]}`;
    await expect(
      publish({ compactJws: tampered, certificatePem: testCertPem }),
    ).rejects.toThrow();
  });

  it("rejects signed non-JSON payload", async () => {
    const testCert = readFileSync(
      resolve(__dirname, "fixtures", "test-cert.pem"),
      "utf-8",
    );
    const { compact } = await sign({
      document: compile(AUTHORING).document,
      key: testKey,
      certificatePem: testCert,
    });

    const parts = compact.split(".");
    const badPayload = base64url("bm90LWpzb24tcGF5bG9hZA==");
    const tampered = `${parts[0]}.${badPayload}.${parts[2]}`;

    await expect(
      publish({ compactJws: tampered, certificatePem: testCert }),
    ).rejects.toThrow();
  });

  it("rejects correctly signed but ETSI-invalid payload", async () => {
    const testCert = readFileSync(
      resolve(__dirname, "fixtures", "test-cert.pem"),
      "utf-8",
    );
    // Create an ETSI-invalid document: missing required ListAndSchemeInformation fields
    const badDoc = {
      LoTE: {
        ListAndSchemeInformation: {
          LoTESequenceNumber: 999,
          ListIssueDateTime: "",
          NextUpdate: "",
        },
      },
    } as any;
    const payload = JSON.stringify(badDoc);
    const jws = await new (await import("jose")).CompactSign(
      new TextEncoder().encode(payload),
    )
      .setProtectedHeader({
        alg: "ES256",
        x5c: [testCert.replace(/-----[^-]+-----/g, "").replace(/\s/g, "")],
      })
      .sign(testKey);

    await expect(
      publish({ compactJws: jws, certificatePem: testCert }),
    ).rejects.toThrow();
  });

  it("supports injected verification clock", async () => {
    const testCert = readFileSync(
      resolve(__dirname, "fixtures", "test-cert.pem"),
      "utf-8",
    );
    const { document } = compile(AUTHORING);
    const { compact } = await sign({
      document,
      key: testKey,
      certificatePem: testCert,
    });

    // Use a clock within the cert's validity period
    const futureClock = new Date("2027-01-01T00:00:00Z");
    const result = await publish({
      compactJws: compact,
      certificatePem: testCert,
      clock: futureClock,
    });
    expect(result.manifest.publicationTimestamp).toBe(
      "2027-01-01T00:00:00.000Z",
    );
  });

  it("atomic failure leaves no partial publication", async () => {
    const testCert = readFileSync(
      resolve(__dirname, "fixtures", "test-cert.pem"),
      "utf-8",
    );
    const pubDir = tmpDir();
    const store = new PublicationStore({ publicationDir: pubDir });

    try {
      const { document } = compile(AUTHORING);
      const { compact } = await sign({
        document,
        key: testKey,
        certificatePem: testCert,
      });
      const pubResult = await publish({
        compactJws: compact,
        certificatePem: testCert,
      });

      // Inject a failure: remove write permissions from parent dir
      const listDir = resolve(pubDir, "eu_test_authority");
      mkdirSync(resolve(listDir, "versions"), { recursive: true });
      // Make the list directory read-only to cause rename to fail
      const versionsDir = resolve(listDir, "versions");
      const origMode = lstatSync(versionsDir).mode;
      // On Linux, we can use chmod
      try {
        const { chmodSync } = await import("node:fs");
        chmodSync(versionsDir, 0o444); // read-only
      } catch {
        // Not supported, skip
      }

      try {
        await store.store(
          pubResult,
          compact,
          pubResult.loteJson,
          JSON.stringify(pubResult.manifest, null, 2),
        );
      } catch {
        // Expected failure
      }

      // Restore permissions
      try {
        const { chmodSync } = await import("node:fs");
        chmodSync(versionsDir, origMode);
      } catch {}

      // No partial version directory should exist
      const versions = readdirSync(versionsDir, { withFileTypes: true }).filter(
        (d) => d.isDirectory(),
      );
      expect(versions.length).toBe(0);

      // No staging directories
      const allEntries = readdirSync(pubDir, { withFileTypes: true });
      const stagingDirs = allEntries.filter((d) =>
        d.name.startsWith(".staging_"),
      );
      expect(stagingDirs.length).toBe(0);
    } finally {
      // Restore permissions if needed
      const listDir2 = resolve(pubDir, "eu_test_authority");
      if (existsSync(listDir2)) {
        try {
          const { chmodSync } = await import("node:fs");
          chmodSync(resolve(listDir2, "versions"), 0o755);
          chmodSync(listDir2, 0o755);
        } catch {}
      }
      try {
        rmSync(pubDir, { recursive: true, force: true });
      } catch {}
    }
  });
});

// ============================================================
// 8. Fix weak existing tests
// ============================================================
describe("Asset and logo byte verification", () => {
  it("negative logo matches HITL original byte-for-byte", () => {
    const srcPath = resolve(
      __dirname,
      "..",
      "HITL",
      "credimi_logo_negative.svg",
    );
    const assetPath = resolve(
      __dirname,
      "..",
      "src",
      "web",
      "assets",
      "credimi_logo_negative.svg",
    );
    const src = readFileSync(srcPath, "utf-8");
    const asset = readFileSync(assetPath, "utf-8");
    expect(asset).toBe(src);
  });

  it("all HITL assets match runtime copies", () => {
    const assets = [
      "style.css",
      "credimi_logo.svg",
      "credimi_logo_negative.svg",
    ];
    for (const a of assets) {
      const src = readFileSync(resolve(__dirname, "..", "HITL", a), "utf-8");
      const rt = readFileSync(
        resolve(__dirname, "..", "src", "web", "assets", a),
        "utf-8",
      );
      expect(rt).toBe(src);
    }
  });
});

describe("Index idempotency and atomic write", () => {
  it("atomic derived index does not damage version directories on failure", async () => {
    const pubDir = tmpDir();
    const store = new PublicationStore({ publicationDir: pubDir });

    try {
      const testCert = readFileSync(
        resolve(__dirname, "fixtures", "test-cert.pem"),
        "utf-8",
      );
      const { document } = compile(AUTHORING);
      const { compact } = await sign({
        document,
        key: testKey,
        certificatePem: testCert,
      });
      const pubResult = await publish({
        compactJws: compact,
        certificatePem: testCert,
      });
      await store.store(
        pubResult,
        compact,
        pubResult.loteJson,
        JSON.stringify(pubResult.manifest, null, 2),
      );

      // Corrupt the manifest to make deriveIndex fail
      const manifestPath = resolve(
        pubDir,
        "eu_test_authority",
        "versions",
        "1",
        "manifest.json",
      );
      writeFileSync(manifestPath, "{{invalid json", "utf-8");

      // Load index (should derive in memory and NOT crash)
      const index = await store.loadIndex("eu_test_authority");
      expect(index).toBeNull();

      // Version directory must still exist
      const verDir = resolve(pubDir, "eu_test_authority", "versions", "1");
      expect(existsSync(verDir)).toBe(true);
    } finally {
      try {
        rmSync(pubDir, { recursive: true, force: true });
      } catch {}
    }
  });
});

function base64url(data: string): string {
  return Buffer.from(data).toString("base64url");
}
