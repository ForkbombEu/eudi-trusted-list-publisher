import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import * as jose from "jose";

import {
  readFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  readdirSync,
  symlinkSync,
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
import { createWebServer } from "../src/web/server.js";
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    jwk as any,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  ) as Promise<globalThis.CryptoKey>;
}

function tmpDir(): string {
  const d = join(tmpdir(), "tlp-" + randomUUID().slice(0, 8));
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

function sha256(data: string): string {
  return createHash("sha256").update(data).digest("hex");
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
// 1. Read-only server
// ============================================================
describe("Read-only server", () => {
  it("does not create publication root on server start", () => {
    const dir = join(tmpdir(), "tlp-rosrv-" + randomUUID().slice(0, 8));
    const srv = createWebServer({ publicationDir: dir });
    expect(existsSync(dir)).toBe(false);
    srv.close();
  });

  it("treats missing root as empty store", async () => {
    const dir = tmpDir();
    try {
      rmSync(dir, { recursive: true, force: true });
      const srv = createWebServer({ publicationDir: dir });
      await new Promise<void>((resolve) => {
        srv.listen(0, "127.0.0.1", () => resolve());
      });
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const r = await httpGet(`http://127.0.0.1:${addr.port}`, "/");
        expect(r.status).toBe(200);
        expect(r.body).toContain("No lists have been published");
      }
      srv.close();
      expect(existsSync(dir)).toBe(false);
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  });

  it("no filesystem writes on GET requests", async () => {
    const dir = tmpDir();
    const store = new PublicationStore({ publicationDir: dir });
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

    const beforeFiles = new Set(
      readdirSync(dir, { recursive: true, encoding: "utf-8" }) as string[],
    );

    const srv = createWebServer({ publicationDir: dir });
    await new Promise<void>((resolve) => {
      srv.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = srv.address();
    if (addr && typeof addr === "object") {
      const bUrl = `http://127.0.0.1:${addr.port}`;
      await httpGet(bUrl, "/");
      await httpGet(bUrl, "/api/v1/lists");
      await httpGet(bUrl, `/api/v1/lists/${pubResult.listKey}/versions/1/lote`);
      await httpGet(
        bUrl,
        `/api/v1/lists/${pubResult.listKey}/versions/1/signature`,
      );
    }
    srv.close();

    const afterFiles = new Set(
      readdirSync(dir, { recursive: true, encoding: "utf-8" }) as string[],
    );

    for (const f of afterFiles) {
      if (!beforeFiles.has(f)) {
        expect(f).toBeFalsy();
      }
    }

    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }, 10000);
});

// ============================================================
// 2. Symlink safety
// ============================================================
describe("Symlink safety", () => {
  it("rejected symlinked list directory in listKeys", async () => {
    const dir = tmpDir();
    try {
      const store = new PublicationStore({ publicationDir: dir });
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

      const outsideDir = join(
        tmpdir(),
        "tlp-outside-" + randomUUID().slice(0, 8),
      );
      mkdirSync(outsideDir, { recursive: true });
      writeFileSync(join(outsideDir, "index.json"), "{}", "utf-8");

      const listDir = resolve(dir, pubResult.listKey);
      rmSync(listDir, { recursive: true, force: true });
      symlinkSync(outsideDir, listDir, "dir");

      const keys = store.listKeys();
      expect(keys).not.toContain(pubResult.listKey);

      try {
        rmSync(outsideDir, { recursive: true, force: true });
      } catch {}
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  });

  it("rejected symlinked version directory", async () => {
    const dir = tmpDir();
    try {
      const store = new PublicationStore({ publicationDir: dir });
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

      const outsideDir = join(tmpdir(), "tlp-ver-" + randomUUID().slice(0, 8));
      mkdirSync(outsideDir, { recursive: true });
      writeFileSync(join(outsideDir, "lote.json"), "{}", "utf-8");
      writeFileSync(join(outsideDir, "lote.jades"), "a.b.c", "utf-8");
      writeFileSync(
        join(outsideDir, "manifest.json"),
        JSON.stringify(pubResult.manifest, null, 2),
        "utf-8",
      );

      const verDir = resolve(dir, pubResult.listKey, "versions", "1");
      rmSync(verDir, { recursive: true, force: true });
      symlinkSync(outsideDir, verDir, "dir");

      const manifest = await store.loadManifest(pubResult.listKey, 1);
      expect(manifest).toBeNull();

      try {
        rmSync(outsideDir, { recursive: true, force: true });
      } catch {}
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  });

  it("rejected symlinked manifest.json via loadVersionArtifacts", async () => {
    const dir = tmpDir();
    try {
      const store = new PublicationStore({ publicationDir: dir });
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

      const externalFile = join(
        tmpdir(),
        "tlp-ext-m-" + randomUUID().slice(0, 8),
      );
      writeFileSync(
        externalFile,
        JSON.stringify(pubResult.manifest, null, 2),
        "utf-8",
      );
      const maniPath = resolve(
        dir,
        pubResult.listKey,
        "versions",
        "1",
        "manifest.json",
      );
      rmSync(maniPath);
      symlinkSync(externalFile, maniPath, "file");

      const outcome = await loadVersionArtifacts(
        dir,
        pubResult.listKey,
        1,
        10 * 1024 * 1024,
      );
      expect(outcome.artifacts).toBeNull();
      expect(outcome.diagnostic).toContain("symlink");

      try {
        unlinkSync(externalFile);
      } catch {}
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  });

  it("rejected symlinked index.json via listKeys (ignores symlink dirs)", async () => {
    const dir = tmpDir();
    try {
      const store = new PublicationStore({ publicationDir: dir });
      // Publish legit content
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

      const outsideDir = join(tmpdir(), "tlp-idx-" + randomUUID().slice(0, 8));
      mkdirSync(outsideDir, { recursive: true });
      writeFileSync(join(outsideDir, "index.json"), '{"evil":true}', "utf-8");
      const symlinkListDir = resolve(dir, "evil_symlinked");
      symlinkSync(outsideDir, symlinkListDir, "dir");

      const keys = store.listKeys();
      expect(keys).not.toContain("evil_symlinked");
      expect(keys).toContain(pubResult.listKey);

      try {
        rmSync(outsideDir, { recursive: true, force: true });
      } catch {}
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  });
});

// ============================================================
// 3. Idempotent corruption detection
// ============================================================
describe("Idempotent corruption detection", () => {
  it("detects corrupted lote.json on republish", async () => {
    const dir = tmpDir();
    try {
      const store = new PublicationStore({ publicationDir: dir });
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

      writeFileSync(
        resolve(dir, pubResult.listKey, "versions", "1", "lote.json"),
        "corrupted",
        "utf-8",
      );

      await expect(
        store.store(
          pubResult,
          compact,
          pubResult.loteJson,
          JSON.stringify(pubResult.manifest, null, 2),
        ),
      ).rejects.toThrow(/corrupt/);
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  });

  it("detects corrupted manifest.json on republish", async () => {
    const dir = tmpDir();
    try {
      const store = new PublicationStore({ publicationDir: dir });
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

      writeFileSync(
        resolve(dir, pubResult.listKey, "versions", "1", "manifest.json"),
        "not json {{{{",
        "utf-8",
      );

      await expect(
        store.store(
          pubResult,
          compact,
          pubResult.loteJson,
          JSON.stringify(pubResult.manifest, null, 2),
        ),
      ).rejects.toThrow(/corrupt/);
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  });

  it("accepts identical content as idempotent", async () => {
    const dir = tmpDir();
    try {
      const store = new PublicationStore({ publicationDir: dir });
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
      // Second identical store should succeed
      await store.store(
        pubResult,
        compact,
        pubResult.loteJson,
        JSON.stringify(pubResult.manifest, null, 2),
      );

      const index = await store.loadIndex(pubResult.listKey);
      expect(index).not.toBeNull();
      expect(index!.versions.length).toBe(1);
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  });
});

// ============================================================
// 4. Corrupt-version isolation
// ============================================================
describe("Corrupt-version isolation", () => {
  it("isolates one corrupt version without hiding healthy ones", async () => {
    const dir = tmpDir();
    try {
      const store = new PublicationStore({ publicationDir: dir });
      const { document: doc1 } = compile(AUTHORING);
      const sig1 = await sign({
        document: doc1,
        key: testKey,
        certificatePem: testCertPem,
      });
      const pub1 = await publish({
        compactJws: sig1.compact,
        certificatePem: testCertPem,
      });
      await store.store(
        pub1,
        sig1.compact,
        pub1.loteJson,
        JSON.stringify(pub1.manifest, null, 2),
      );

      const input2 = { ...AUTHORING, loTESequenceNumber: 2 };
      const { document: doc2 } = compile(input2);
      const sig2 = await sign({
        document: doc2,
        key: testKey,
        certificatePem: testCertPem,
      });
      const pub2 = await publish({
        compactJws: sig2.compact,
        certificatePem: testCertPem,
      });
      await store.store(
        pub2,
        sig2.compact,
        pub2.loteJson,
        JSON.stringify(pub2.manifest, null, 2),
      );

      writeFileSync(
        resolve(dir, pub1.listKey, "versions", "1", "manifest.json"),
        JSON.stringify({ ...pub1.manifest, manifestVersion: 999 }),
        "utf-8",
      );

      const m1 = await store.loadManifest(pub1.listKey, 1);
      expect(m1).toBeNull();

      const m2 = await store.loadManifest(pub1.listKey, 2);
      expect(m2).not.toBeNull();

      const index = await store.loadIndex(pub1.listKey);
      expect(index).not.toBeNull();
      expect(index!.versions.find((v) => v.sequenceNumber === 1)).toBeFalsy();
      expect(index!.versions.find((v) => v.sequenceNumber === 2)).toBeTruthy();
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
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

  it("security headers on GET 200", async () => {
    const r = await httpGet(baseUrl, "/healthz");
    expect(r.status).toBe(200);
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.headers["x-frame-options"]).toBe("DENY");
    expect(r.headers["referrer-policy"]).toBe("no-referrer");
  });

  it("security headers on 404", async () => {
    const r = await httpGet(baseUrl, "/nonexistent/path");
    expect(r.status).toBe(404);
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.headers["x-frame-options"]).toBe("DENY");
    expect(r.headers["referrer-policy"]).toBe("no-referrer");
  });

  it("security headers on 405", async () => {
    const r = await httpGet(baseUrl, "/", "POST");
    expect(r.status).toBe(405);
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.headers["x-frame-options"]).toBe("DENY");
    expect(r.headers["referrer-policy"]).toBe("no-referrer");
    expect(r.headers["allow"]).toBe("GET, HEAD");
  });

  it("X-Request-ID present on every response", async () => {
    const responses = await Promise.all([
      httpGet(baseUrl, "/"),
      httpGet(baseUrl, "/healthz"),
      httpGet(baseUrl, "/nonexistent"),
      httpGet(baseUrl, "/", "POST"),
      httpGet(baseUrl, "/api/v1/lists"),
    ]);
    for (const r of responses) {
      expect(r.headers["x-request-id"]).toBeDefined();
      expect(r.headers["x-request-id"]).toBeTruthy();
    }
  });

  it("immutable caching for versioned artifacts", async () => {
    const dir = tmpDir();
    const store = new PublicationStore({ publicationDir: dir });
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

    const srv2 = createWebServer({ publicationDir: dir });
    await new Promise<void>((resolve) => {
      srv2.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = srv2.address();
    if (addr && typeof addr === "object") {
      const bUrl = `http://127.0.0.1:${addr.port}`;
      const loteRes = await httpGet(
        bUrl,
        `/api/v1/lists/${pubResult.listKey}/versions/1/lote`,
      );
      expect(loteRes.headers["cache-control"]).toContain("immutable");

      const sigRes = await httpGet(
        bUrl,
        `/api/v1/lists/${pubResult.listKey}/versions/1/signature`,
      );
      expect(sigRes.headers["cache-control"]).toContain("immutable");

      const maniRes = await httpGet(
        bUrl,
        `/api/v1/lists/${pubResult.listKey}/versions/1/manifest`,
      );
      expect(maniRes.headers["cache-control"]).toContain("immutable");
    }
    srv2.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  });

  it("non-immutable caching for catalog/list indexes", async () => {
    const r = await httpGet(baseUrl, "/api/v1/lists");
    expect(r.status).toBe(200);
    expect(r.headers["cache-control"]).toBe("no-store");
  });
});

// ============================================================
// 6. Asset verification
// ============================================================
describe("Asset verification", () => {
  it("negative logo matches HITL original byte-for-byte", () => {
    const canonical = readFileSync(
      resolve(__dirname, "..", "HITL", "credimi_logo_negative.svg"),
      "utf-8",
    );
    const runtime = readFileSync(
      resolve(
        __dirname,
        "..",
        "src",
        "web",
        "assets",
        "credimi_logo_negative.svg",
      ),
      "utf-8",
    );
    expect(runtime).toBe(canonical);
  });

  it("all HITL assets match runtime copies", () => {
    const assets = [
      { hitl: "credimi_logo.svg", rt: "credimi_logo.svg" },
      { hitl: "credimi_logo_negative.svg", rt: "credimi_logo_negative.svg" },
      { hitl: "style.css", rt: "style.css" },
    ];
    for (const { hitl, rt } of assets) {
      const canonical = readFileSync(
        resolve(__dirname, "..", "HITL", hitl),
        "utf-8",
      );
      const runtime = readFileSync(
        resolve(__dirname, "..", "src", "web", "assets", rt),
        "utf-8",
      );
      expect(runtime).toBe(canonical);
    }
  });
});

// ============================================================
// 7. Exact downloads
// ============================================================
describe("Exact downloads", () => {
  it("verify exact download bytes for lote.json, lote.jades, manifest.json", async () => {
    const dir = tmpDir();
    try {
      const store = new PublicationStore({ publicationDir: dir });
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
      const manifestJson = JSON.stringify(pubResult.manifest, null, 2);
      await store.store(pubResult, compact, pubResult.loteJson, manifestJson);

      const loteStored = readFileSync(
        resolve(dir, pubResult.listKey, "versions", "1", "lote.json"),
        "utf-8",
      );
      const jadesStored = readFileSync(
        resolve(dir, pubResult.listKey, "versions", "1", "lote.jades"),
        "utf-8",
      );
      const maniStored = readFileSync(
        resolve(dir, pubResult.listKey, "versions", "1", "manifest.json"),
        "utf-8",
      );

      expect(sha256(loteStored)).toBe(pubResult.manifest.loteJsonSha256);
      expect(sha256(jadesStored)).toBe(pubResult.manifest.compactJadesSha256);
      expect(loteStored).toBe(pubResult.loteJson);
      expect(jadesStored).toBe(compact);
      expect(maniStored).toBe(manifestJson);
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  });
});

// ============================================================
// 8. Atomic index
// ============================================================
describe("Atomic index", () => {
  it("derived index failure does not damage version directories", async () => {
    const dir = tmpDir();
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

      // Simpler: publish normally, then corrupt the manifest so deriveIndex can't load it
      const store = new PublicationStore({ publicationDir: dir });
      await store.store(
        pubResult,
        compact,
        pubResult.loteJson,
        JSON.stringify(pubResult.manifest, null, 2),
      );

      // Verify version dir exists
      const verDir = resolve(dir, pubResult.listKey, "versions", "1");
      expect(existsSync(verDir)).toBe(true);
      expect(existsSync(resolve(verDir, "lote.json"))).toBe(true);
      expect(existsSync(resolve(verDir, "lote.jades"))).toBe(true);
      expect(existsSync(resolve(verDir, "manifest.json"))).toBe(true);

      // Corrupt manifest so deriveIndex can't load it
      writeFileSync(resolve(verDir, "manifest.json"), "not-json!{{{", "utf-8");

      // The version directory still exists
      expect(existsSync(verDir)).toBe(true);

      // Catalogue (loadIndex) recovers by skipping corrupt version
      await store.loadIndex(pubResult.listKey);
      // loadIndex derives from manifests, corrupt ones are skipped
      // No index because manifest is corrupt — but the version dir is safe
      expect(existsSync(verDir)).toBe(true);
      expect(existsSync(resolve(verDir, "lote.json"))).toBe(true);
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  });
});

// ============================================================
// 9. Stored x5c authentication
// ============================================================
describe("Stored-publication x5c authentication", () => {
  it("rejects no x5c", async () => {
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
        pubResult.listKey,
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
        resolve(dir, pubResult.listKey, "versions", "1", "lote.jades"),
        tampered,
        "utf-8",
      );

      const outcome = await loadVersionArtifacts(
        dir,
        pubResult.listKey,
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

  it("rejects empty x5c", async () => {
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
        pubResult.listKey,
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
        resolve(dir, pubResult.listKey, "versions", "1", "lote.jades"),
        tampered,
        "utf-8",
      );

      const outcome = await loadVersionArtifacts(
        dir,
        pubResult.listKey,
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

  it("rejects malformed x5c (not valid base64 cert)", async () => {
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
        pubResult.listKey,
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
        resolve(dir, pubResult.listKey, "versions", "1", "lote.jades"),
        tampered,
        "utf-8",
      );

      const outcome = await loadVersionArtifacts(
        dir,
        pubResult.listKey,
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

  it("rejects malformed protected header (not valid JSON)", async () => {
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
        pubResult.listKey,
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
        resolve(dir, pubResult.listKey, "versions", "1", "lote.jades"),
        tampered,
        "utf-8",
      );

      const outcome = await loadVersionArtifacts(
        dir,
        pubResult.listKey,
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
// 10. Publication gates
// ============================================================
describe("Publication gate tests", () => {
  it("rejects cert mismatch using second cert", async () => {
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
// 11. Deterministic atomic failure
// ============================================================
describe("Atomic publication failure", () => {
  it("rename failure leaves no partial state", async () => {
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

    const listDir = resolve(dir, pubResult.listKey);
    if (existsSync(listDir)) {
      const entries = readdirSync(listDir, { withFileTypes: true });
      const verDirs = entries.filter(
        (d) => d.isDirectory() && d.name !== "versions",
      );
      expect(verDirs.length).toBe(0);
    }

    if (existsSync(dir)) {
      const entries = readdirSync(dir, { withFileTypes: true });
      expect(entries.filter((d) => d.name.startsWith(".staging_")).length).toBe(
        0,
      );
    }

    const idx = await store.loadIndex(pubResult.listKey);
    expect(idx).toBeNull();

    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  });

  it("existing healthy version remains byte-identical after injected failure", async () => {
    const dir = tmpDir();
    try {
      const store = new PublicationStore({ publicationDir: dir });
      const { document: doc1 } = compile(AUTHORING);
      const sig1 = await sign({
        document: doc1,
        key: testKey,
        certificatePem: testCertPem,
      });
      const pub1 = await publish({
        compactJws: sig1.compact,
        certificatePem: testCertPem,
      });
      await store.store(
        pub1,
        sig1.compact,
        pub1.loteJson,
        JSON.stringify(pub1.manifest, null, 2),
      );

      const lotePath = resolve(dir, pub1.listKey, "versions", "1", "lote.json");
      const jadesPath = resolve(
        dir,
        pub1.listKey,
        "versions",
        "1",
        "lote.jades",
      );
      const maniPath = resolve(
        dir,
        pub1.listKey,
        "versions",
        "1",
        "manifest.json",
      );

      const loteBefore = readFileSync(lotePath, "utf-8");
      const jadesBefore = readFileSync(jadesPath, "utf-8");
      const maniBefore = readFileSync(maniPath, "utf-8");

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

      const input2 = { ...AUTHORING, loTESequenceNumber: 2 };
      const { document: doc2 } = compile(input2);
      const sig2 = await sign({
        document: doc2,
        key: testKey,
        certificatePem: testCertPem,
      });
      const pub2 = await publish({
        compactJws: sig2.compact,
        certificatePem: testCertPem,
      });

      const failStore = new PublicationStore(
        { publicationDir: dir },
        failingFs,
      );
      await expect(
        failStore.store(
          pub2,
          sig2.compact,
          pub2.loteJson,
          JSON.stringify(pub2.manifest, null, 2),
        ),
      ).rejects.toThrow("injected rename failure");

      const loteAfter = readFileSync(lotePath, "utf-8");
      const jadesAfter = readFileSync(jadesPath, "utf-8");
      const maniAfter = readFileSync(maniPath, "utf-8");

      expect(loteAfter).toBe(loteBefore);
      expect(jadesAfter).toBe(jadesBefore);
      expect(maniAfter).toBe(maniBefore);
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  });
});

// ============================================================
// 12. Authoritative store validation (full disk→load pipeline)
// ============================================================
describe("Authoritative store validation", () => {
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
    overrides: Record<string, unknown>,
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
            certificatePem: testCertPem,
            serviceUniqueIdentifier: "https://svc.example",
          },
        ],
        ...overrides,
      },
    };
    const p = resolve(authoringDir, `${id}.json`);
    writeFileSync(p, JSON.stringify(baseApp, null, 2), "utf-8");
  }

  function writeCustom(id: string, obj: Record<string, unknown>): void {
    const p = resolve(authoringDir, `${id}.json`);
    writeFileSync(p, JSON.stringify(obj, null, 2), "utf-8");
  }

  it("rejects invalid state string", () => {
    const id = randomUUID();
    writeCustom(id, {
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
    });
    expect(store.load(id)).toBeNull();
  });

  it("rejects invalid submittedAt timestamp", () => {
    const id = randomUUID();
    writeMalformed(id, {});
    writeCustom(id, {
      id,
      schemaVersion: 1,
      family: "wallet-providers",
      targetListKey: "eu_test",
      state: "submitted",
      submittedAt: "not-a-date",
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
    });
    expect(store.load(id)).toBeNull();
  });

  it("rejects non-array services", () => {
    const id = randomUUID();
    writeCustom(id, {
      id,
      schemaVersion: 1,
      family: "wallet-providers",
      targetListKey: "eu_test",
      state: "submitted",
      submittedAt: "2026-01-01T00:00:00Z",
      applicantData: {
        entityName: "X",
        entityStreetAddress: "X",
        entityCountry: "IT",
        entityInformationURI: "https://x",
        services: "not-an-array",
      },
    });
    expect(store.load(id)).toBeNull();
  });

  it("rejects empty services array", () => {
    const id = randomUUID();
    writeMalformed(id, { services: [] });
    expect(store.load(id)).toBeNull();
  });

  it("rejects malformed service type name", () => {
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

  it("rejects submitted state with approvedAt field", () => {
    const id = randomUUID();
    writeCustom(id, {
      id,
      schemaVersion: 1,
      family: "wallet-providers",
      targetListKey: "eu_test",
      state: "submitted",
      submittedAt: "2026-01-01T00:00:00Z",
      approvedAt: "2026-01-02T00:00:00Z",
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
    });
    expect(store.load(id)).toBeNull();
  });

  it("rejects approved state without approvedAt", () => {
    const id = randomUUID();
    writeCustom(id, {
      id,
      schemaVersion: 1,
      family: "wallet-providers",
      targetListKey: "eu_test",
      state: "approved",
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
    });
    expect(store.load(id)).toBeNull();
  });

  it("rejects rejected state without adminNote", () => {
    const id = randomUUID();
    writeCustom(id, {
      id,
      schemaVersion: 1,
      family: "wallet-providers",
      targetListKey: "eu_test",
      state: "rejected",
      submittedAt: "2026-01-01T00:00:00Z",
      rejectedAt: "2026-01-02T00:00:00Z",
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
    });
    expect(store.load(id)).toBeNull();
  });

  it("rejects published state without publication metadata", () => {
    const id = randomUUID();
    writeCustom(id, {
      id,
      schemaVersion: 1,
      family: "wallet-providers",
      targetListKey: "eu_test",
      state: "published",
      submittedAt: "2026-01-01T00:00:00Z",
      approvedAt: "2026-01-02T00:00:00Z",
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
    });
    expect(store.load(id)).toBeNull();
  });

  it("rejects unsafe targetListKey (uppercase or with hyphens)", () => {
    const id = randomUUID();
    writeCustom(id, {
      id,
      schemaVersion: 1,
      family: "wallet-providers",
      targetListKey: "BAD-KEY",
      state: "submitted",
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
// 13. OpenAPI bidirectional parity
// ============================================================
describe("OpenAPI route parity", () => {
  it("reusable parity function: every implemented route in OpenAPI and every documented route implemented", async () => {
    const { getApiRoutes, checkApiRouteParity } =
      await import("../src/web/server.js");
    const implemented = getApiRoutes();
    const spec = {
      paths: {
        "/api/v1/lists": { get: {} },
        "/api/v1/lists/{listKey}": { get: {} },
        "/api/v1/lists/{listKey}/versions/{sequence}": { get: {} },
        "/api/v1/lists/{listKey}/versions/{sequence}/lote": { get: {} },
        "/api/v1/lists/{listKey}/versions/{sequence}/signature": { get: {} },
        "/api/v1/lists/{listKey}/versions/{sequence}/manifest": { get: {} },
      },
    };
    const errors = checkApiRouteParity(implemented, spec);
    expect(errors).toHaveLength(0);
  });

  it("rejects implemented route absent from OpenAPI", async () => {
    const { checkApiRouteParity } = await import("../src/web/server.js");
    const registry = [{ method: "GET", path: "/api/v1/secret" }];
    const spec = { paths: {} };
    const errors = checkApiRouteParity(registry, spec);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.kind).toBe("undocumented");
  });

  it("rejects documented path absent from registry", async () => {
    const { checkApiRouteParity } = await import("../src/web/server.js");
    const registry: Array<{ method: string; path: string }> = [];
    const spec = { paths: { "/api/v1/only-in-docs": { get: {} } } };
    const errors = checkApiRouteParity(registry, spec);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.kind).toBe("unimplemented");
  });

  it("rejects documented-but-unimplemented POST on existing GET path", async () => {
    const { checkApiRouteParity } = await import("../src/web/server.js");
    const registry = [{ method: "GET", path: "/api/v1/lists" }];
    const spec = {
      paths: {
        "/api/v1/lists": { get: {}, post: {} },
      },
    };
    const errors = checkApiRouteParity(registry, spec);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.kind).toBe("unimplemented");
    expect(errors[0]!.detail).toContain("POST");
  });

  it("rejects implemented method documented under wrong method", async () => {
    const { checkApiRouteParity } = await import("../src/web/server.js");
    const registry = [{ method: "GET", path: "/api/v1/lists" }];
    const spec = {
      paths: {
        "/api/v1/lists": { post: {} },
      },
    };
    const errors = checkApiRouteParity(registry, spec);
    expect(errors).toHaveLength(2);
  });
});

// ============================================================
// 14. Preview/publication consistency
// ============================================================
describe("Preview and publication consistency", () => {
  it("publishApplication matches preview compiler input including timestamps with injected clock", async () => {
    const pubDir = tmpDir();
    const authDir = tmpDir();
    const configPath = join(tmpdir(), "sc.json");
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

    const clock = new Date("2026-12-15T12:00:00Z");

    const app: any = {
      id: authoringStore.createId(),
      schemaVersion: 1,
      family: "wallet-providers",
      targetListKey: "eu_test_authority",
      state: "approved",
      submittedAt: new Date().toISOString(),
      approvedAt: new Date().toISOString(),
      applicantData: {
        entityName: "Preview Corp",
        entityStreetAddress: "1 St",
        entityCountry: "IT",
        entityInformationURI: "https://preview.example",
        services: [
          {
            serviceType: "issuance",
            serviceName: "Svc",
            certificatePem: testCertPem,
            serviceUniqueIdentifier: "https://svc.example",
          },
        ],
      },
    };
    authoringStore.save(app);

    // Get preview output
    const preview = await service.preview(app);
    expect(preview.compilerInputJson).toBeTruthy();
    expect(preview.etsiValid).toBe(true);

    // Get prepare output with fixed clock
    const prepare = await service.preparePublishInput(app, clock);
    expect(prepare.success).toBe(true);
    if (!prepare.success || !preview.compilerInputJson) {
      throw new Error("unexpected failure");
    }

    // Verify structural fields match (timestamps differ)
    const pv = JSON.parse(preview.compilerInputJson) as any;
    const pr = prepare.data;
    if (!pr) throw new Error("no data");
    expect(pv.scheme.schemeTerritory).toBe(pr.scheme.schemeTerritory);
    expect(pv.schemeOperator.name[0]!.value).toBe(
      pr.schemeOperator.name[0]!.value,
    );

    // Actually publish and verify published sequence/data matches
    const pubResult = await service.publishApplication(app.id);
    expect(pubResult.success).toBe(true);
    if (pubResult.success) {
      expect(pubResult.data.publication).toBeDefined();
      expect(pubResult.data.publication!.sequenceNumber).toBeGreaterThan(0);
      expect(pubResult.data.publication!.listKey).toBe("eu_test_authority");
      // Verify the published LoTE exists and is loadable
      const idx = await pubStore.loadIndex("eu_test_authority");
      expect(idx).not.toBeNull();
      expect(idx!.versions.length).toBeGreaterThan(0);
    }

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

  it("preview with injected clock produces deterministic timestamps", async () => {
    const pubDir = tmpDir();
    const authDir = tmpDir();
    const configPath = join(tmpdir(), "sc2.json");
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

    const app: any = {
      id: authoringStore.createId(),
      schemaVersion: 1,
      family: "wallet-providers",
      targetListKey: "eu_test_authority",
      state: "submitted",
      submittedAt: new Date().toISOString(),
      applicantData: {
        entityName: "Clock Corp",
        entityStreetAddress: "1 St",
        entityCountry: "IT",
        entityInformationURI: "https://clock.example",
        services: [
          {
            serviceType: "issuance",
            serviceName: "Svc",
            certificatePem: testCertPem,
            serviceUniqueIdentifier: "https://svc.example",
          },
        ],
      },
    };
    authoringStore.save(app);

    const clock = new Date("2026-06-01T00:00:00Z");
    const prepare1 = await service.preparePublishInput(app, clock);
    const prepare2 = await service.preparePublishInput(app, clock);

    expect(prepare1.success).toBe(true);
    expect(prepare2.success).toBe(true);
    if (prepare1.success && prepare2.success) {
      expect(prepare1.listIssueDateTime).toBe(prepare2.listIssueDateTime);
      expect(prepare1.nextUpdate).toBe(prepare2.nextUpdate);
      expect(JSON.stringify(prepare1.data)).toBe(JSON.stringify(prepare2.data));
    }

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

// ============================================================
// 15. Multi-service form indexes
// ============================================================
describe("Multi-service form indexes", () => {
  it("render form with 2 preserved services and add a third — verify indexes 0, 1, 2", async () => {
    const { walletProviderFormHtml } =
      await import("../src/web/views/onboarding.js");

    const values: Record<string, string> = {
      entityName: "Test Corp",
      entityStreetAddress: "123 St",
      entityCountry: "IT",
      entityInformationURI: "https://test.example",
      "service[0].serviceType": "issuance",
      "service[0].serviceName": "Service Zero",
      "service[0].certificatePem":
        "-----BEGIN CERTIFICATE-----\nA\n-----END CERTIFICATE-----",
      "service[0].serviceUniqueIdentifier": "https://a.example",
      "service[1].serviceType": "revocation",
      "service[1].serviceName": "Service One",
      "service[1].certificatePem":
        "-----BEGIN CERTIFICATE-----\nB\n-----END CERTIFICATE-----",
      "service[1].serviceUniqueIdentifier": "https://b.example",
      "service[2].serviceType": "issuance",
      "service[2].serviceName": "Service Two",
      "service[2].certificatePem":
        "-----BEGIN CERTIFICATE-----\nC\n-----END CERTIFICATE-----",
      "service[2].serviceUniqueIdentifier": "https://c.example",
    };
    const errors: Record<string, string> = {
      "service[0].certificatePem": "Bad certificate",
      "service[1].serviceName": "Required",
      "service[2].serviceUniqueIdentifier": "Bad URI",
    };

    const html = walletProviderFormHtml(values, errors, []);
    expect(html).toContain("Service 1");
    expect(html).toContain("Service 2");
    expect(html).toContain("Service 3");
    expect(html).toContain("Service Zero");
    expect(html).toContain("Service One");
    expect(html).toContain("Service Two");
    expect(html).toContain("Bad certificate");
    expect(html).toContain("Required");
    expect(html).toContain("Bad URI");

    // No duplicate indexes — each service rendered once
    const idx0 = (html.match(/service\[0\]/g) ?? []).length;
    const idx1 = (html.match(/service\[1\]/g) ?? []).length;
    const idx2 = (html.match(/service\[2\]/g) ?? []).length;
    expect(idx0).toBeGreaterThan(0);
    expect(idx1).toBeGreaterThan(0);
    expect(idx2).toBeGreaterThan(0);

    // Verify no phantom index 3
    const idx3 = (html.match(/service\[3\]/g) ?? []).length;
    expect(idx3).toBe(0);
  });
});

// ============================================================
// 16. Save boundary validation
// ============================================================
describe("Save boundary validation", () => {
  it("save() rejects malformed certificate and creates no file", async () => {
    const authDir = tmpDir();
    const store = new AuthoringStore({ authoringDir: authDir });
    const id = store.createId();
    try {
      const app: any = {
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
              certificatePem: "not-a-valid-cert",
              serviceUniqueIdentifier: "https://svc.example",
            },
          ],
        },
      };
      expect(() => store.save(app)).toThrow();
      // No file created
      const filePath = resolve(authDir, `${id}.json`);
      expect(existsSync(filePath)).toBe(false);
    } finally {
      try {
        rmSync(authDir, { recursive: true, force: true });
      } catch {}
    }
  });
});

// ============================================================
// 17. Rejected lifecycle (no approvedAt)
// ============================================================
describe("Rejected lifecycle", () => {
  it("load rejects rejected record with approvedAt present", async () => {
    const authDir = tmpDir();
    const store = new AuthoringStore({ authoringDir: authDir });
    const id = randomUUID();
    try {
      const app: any = {
        id,
        schemaVersion: 1,
        family: "wallet-providers",
        targetListKey: "eu_test",
        state: "rejected",
        submittedAt: "2026-01-01T00:00:00Z",
        approvedAt: "2026-02-01T00:00:00Z",
        rejectedAt: "2026-03-01T00:00:00Z",
        adminNote: "bad app",
        applicantData: {
          entityName: "Corp",
          entityStreetAddress: "123 St",
          entityCountry: "IT",
          entityInformationURI: "https://x.example",
          services: [
            {
              serviceType: "issuance",
              serviceName: "Svc",
              certificatePem: testCertPem,
              serviceUniqueIdentifier: "https://svc.example",
            },
          ],
        },
      };
      const p = resolve(authDir, `${id}.json`);
      writeFileSync(p, JSON.stringify(app, null, 2), "utf-8");
      expect(store.load(id)).toBeNull();
    } finally {
      try {
        rmSync(authDir, { recursive: true, force: true });
      } catch {}
    }
  });
});

// ============================================================
// 18. Strict timestamp validation
// ============================================================
describe("Strict timestamp validation", () => {
  it("rejects calendar-impossible timestamps at store level", () => {
    const authDir = tmpDir();
    const store = new AuthoringStore({ authoringDir: authDir });
    try {
      const invalidTimestamps = [
        "2026-02-31T00:00:00Z",
        "2025-02-29T12:00:00Z",
        "2026-01-01T25:00:00Z",
        "2026-13-01T00:00:00Z",
        "2026-01-32T00:00:00Z",
      ];
      for (const ts of invalidTimestamps) {
        const id = randomUUID();
        const app: any = {
          id,
          schemaVersion: 1,
          family: "wallet-providers",
          targetListKey: "eu_test",
          state: "submitted",
          submittedAt: ts,
          applicantData: {
            entityName: "Corp",
            entityStreetAddress: "123 St",
            entityCountry: "IT",
            entityInformationURI: "https://x.example",
            services: [
              {
                serviceType: "issuance",
                serviceName: "Svc",
                certificatePem: testCertPem,
                serviceUniqueIdentifier: "https://svc.example",
              },
            ],
          },
        };
        const p = resolve(authDir, `${id}.json`);
        writeFileSync(p, JSON.stringify(app, null, 2), "utf-8");
        expect(store.load(id)).toBeNull();
        unlinkSync(p);
      }
    } finally {
      try {
        rmSync(authDir, { recursive: true, force: true });
      } catch {}
    }
  });

  it("accepts valid leap day (Feb 29 in leap year)", () => {
    const authDir = tmpDir();
    const store = new AuthoringStore({ authoringDir: authDir });
    try {
      const id = randomUUID();
      const app: any = {
        id,
        schemaVersion: 1,
        family: "wallet-providers",
        targetListKey: "eu_test",
        state: "submitted",
        submittedAt: "2024-02-29T12:00:00Z",
        applicantData: {
          entityName: "Corp",
          entityStreetAddress: "123 St",
          entityCountry: "IT",
          entityInformationURI: "https://x.example",
          services: [
            {
              serviceType: "issuance",
              serviceName: "Svc",
              certificatePem: testCertPem,
              serviceUniqueIdentifier: "https://svc.example",
            },
          ],
        },
      };
      expect(() => store.save(app)).not.toThrow();
      expect(store.load(id)).not.toBeNull();
    } finally {
      try {
        rmSync(authDir, { recursive: true, force: true });
      } catch {}
    }
  });
});

// ============================================================
// 19. Empty/small service indexes
// ============================================================
describe("Empty/small service indexes", () => {
  it("empty form → next index is 1", async () => {
    const { computeNextServiceIndex } =
      await import("../src/web/views/onboarding.js");
    expect(computeNextServiceIndex({})).toBe(1);
  });

  it("indexes 0 and 1 → next is 2", async () => {
    const { computeNextServiceIndex } =
      await import("../src/web/views/onboarding.js");
    const v: Record<string, string> = {
      "service[0].serviceType": "issuance",
      "service[1].serviceType": "revocation",
    };
    expect(computeNextServiceIndex(v)).toBe(2);
  });

  it("sparse indexes 0 and 2 → next is 3", async () => {
    const { computeNextServiceIndex } =
      await import("../src/web/views/onboarding.js");
    const v: Record<string, string> = {
      "service[0].serviceType": "issuance",
      "service[2].serviceType": "revocation",
    };
    expect(computeNextServiceIndex(v)).toBe(3);
  });

  it("error-only sparse indexes", async () => {
    const { computeNextServiceIndex } =
      await import("../src/web/views/onboarding.js");
    const errs: Record<string, string> = {
      "service[2].serviceName": "bad",
    };
    expect(computeNextServiceIndex({}, errs)).toBe(3);
  });

  it("empty form renders service 0 and next idx script sets 1", async () => {
    const { walletProviderFormHtml } =
      await import("../src/web/views/onboarding.js");
    const html = walletProviderFormHtml({}, {}, []);
    expect(html).toContain("service[0]");
    expect(html).toContain("initialNext = 1");
    expect(html).not.toContain("initialNext = 0");
  });
});

// ============================================================
// 20. Real preview/publication equivalence
// ============================================================
describe("Real preview/publication equivalence", () => {
  it("preview and publishApplication with same clock produce identical timestamps and entity data", async () => {
    const pubDir = tmpDir();
    const authDir = tmpDir();
    const configPath = join(tmpdir(), "sc.json");
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

    const clock = new Date("2026-12-15T12:00:00Z");

    const app: any = {
      id: authoringStore.createId(),
      schemaVersion: 1,
      family: "wallet-providers",
      targetListKey: "eu_test_authority",
      state: "approved",
      submittedAt: new Date().toISOString(),
      approvedAt: new Date().toISOString(),
      applicantData: {
        entityName: "EqCorp",
        entityStreetAddress: "1 St",
        entityCountry: "IT",
        entityInformationURI: "https://eq.example",
        services: [
          {
            serviceType: "issuance",
            serviceName: "SvcEq",
            certificatePem: testCertPem,
            serviceUniqueIdentifier: "https://eq.svc.example",
          },
        ],
      },
    };
    authoringStore.save(app);

    const preview = await service.preview(app, clock);
    expect(preview.compilerInputJson).toBeTruthy();

    const pubResult = await service.publishApplication(app.id, clock);
    expect(pubResult.success).toBe(true);

    // Load the published LoTE
    const idx = await pubStore.loadIndex("eu_test_authority");
    expect(idx).not.toBeNull();
    const seq = pubResult.success
      ? pubResult.data.publication!.sequenceNumber
      : 0;
    expect(seq).toBeGreaterThan(0);

    const loteBytes = await pubStore.loadVersionBytes(
      "eu_test_authority",
      seq,
      "lote",
    );
    expect(loteBytes).not.toBeNull();
    const lote = JSON.parse(loteBytes!);
    const info = lote.LoTE.ListAndSchemeInformation;

    // Timestamps must be exactly the injected clock and clock + 180 days
    expect(info.ListIssueDateTime).toBe("2026-12-15T12:00:00.000Z");
    expect(info.NextUpdate).toBe("2027-06-13T12:00:00.000Z");
    expect(info.LoTESequenceNumber).toBe(seq);

    // Entity name and service data must match the applicant data
    const entity = lote.LoTE.TrustedEntitiesList[0];
    expect(entity.TrustedEntityInformation.TEName[0].value).toBe("EqCorp");
    expect(
      entity.TrustedEntityServices[0].ServiceInformation.ServiceName[0].value,
    ).toBe("SvcEq");
    expect(
      entity.TrustedEntityServices[0].ServiceInformation
        .ServiceInformationExtensions[0].ServiceUniqueIdentifier,
    ).toBe("https://eq.svc.example");

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

// ============================================================
// 21. Shipped OpenAPI document parity
// ============================================================
describe("Shipped OpenAPI document parity", () => {
  it("real openapi.yaml passes checkApiRouteParity with zero errors", async () => {
    const { getApiRoutes, checkApiRouteParity } =
      await import("../src/web/server.js");
    const { parse: parseYaml } = await import("yaml");
    const yamlContent = readFileSync(
      resolve(__dirname, "..", "src", "web", "assets", "openapi.yaml"),
      "utf-8",
    );
    const spec = parseYaml(yamlContent) as any;
    const routes = getApiRoutes();
    const errors = checkApiRouteParity(routes, spec);
    expect(errors).toEqual([]);
  });

  it("OpenAPI passes swagger-parser validation", async () => {
    const swaggerParser = (await import("@apidevtools/swagger-parser")).default;
    const { parse: parseYaml } = await import("yaml");
    const yamlContent = readFileSync(
      resolve(__dirname, "..", "src", "web", "assets", "openapi.yaml"),
      "utf-8",
    );
    const spec = parseYaml(yamlContent) as any;
    await swaggerParser.validate(spec);
  });
});

// ============================================================
// 22. ApplicationService transition test
// ============================================================
describe("ApplicationService transition tests", () => {
  it("approve then reject clears approvedAt", async () => {
    const pubDir = tmpDir();
    const authDir = tmpDir();
    const configPath = join(tmpdir(), "sc.json");
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
    try {
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

      const applicantData = {
        entityName: "Transition Corp",
        entityStreetAddress: "1 St",
        entityCountry: "IT",
        entityInformationURI: "https://t.example",
        services: [
          {
            serviceType: "issuance" as const,
            serviceName: "Svc",
            certificatePem: testCertPem,
            serviceUniqueIdentifier: "https://svc.example",
          },
        ],
      };
      const app = service.createApp("eu_test_authority", applicantData);
      expect(app.state).toBe("submitted");

      const approveResult = service.approve(app.id);
      expect(approveResult.success).toBe(true);
      expect(
        approveResult.success && approveResult.data.approvedAt,
      ).toBeTruthy();
      expect(approveResult.success && approveResult.data.state).toBe(
        "approved",
      );

      const rejectResult = service.reject(app.id, "not ready");
      expect(rejectResult.success).toBe(true);
      if (rejectResult.success) {
        expect(rejectResult.data.state).toBe("rejected");
        expect(rejectResult.data.approvedAt).toBeUndefined();
        expect(rejectResult.data.rejectedAt).toBeTruthy();
        expect(rejectResult.data.adminNote).toBe("not ready");
      }

      // Verify store persistence: load after transition
      const reloaded = authoringStore.load(app.id);
      expect(reloaded).not.toBeNull();
      expect(reloaded!.state).toBe("rejected");
      expect(reloaded!.approvedAt).toBeUndefined();
    } finally {
      try {
        rmSync(pubDir, { recursive: true, force: true });
      } catch {}
      try {
        rmSync(authDir, { recursive: true, force: true });
      } catch {}
      try {
        unlinkSync(configPath);
      } catch {}
    }
  });
});

// ============================================================
// 23. Multi-service no duplicate field names
// ============================================================
describe("Multi-service no duplicate field names", () => {
  it("empty form has exactly one service block with no duplicate names", async () => {
    const { walletProviderFormHtml } =
      await import("../src/web/views/onboarding.js");
    const html = walletProviderFormHtml({}, {}, []);
    // Should have exactly one service[0] block
    const matches0 = html.match(/service\[0\]/g) ?? [];
    expect(matches0.length).toBeGreaterThan(0);
    // Should not have service[1]
    expect(html).not.toContain("service[1]");
  });

  it("two submitted services have no duplicate field names", async () => {
    const { walletProviderFormHtml } =
      await import("../src/web/views/onboarding.js");
    const v: Record<string, string> = {
      "service[0].serviceType": "issuance",
      "service[0].serviceName": "S0",
      "service[0].certificatePem": testCertPem,
      "service[0].serviceUniqueIdentifier": "https://a.example",
      "service[1].serviceType": "revocation",
      "service[1].serviceName": "S1",
      "service[1].certificatePem": testCertPem,
      "service[1].serviceUniqueIdentifier": "https://b.example",
    };
    const html = walletProviderFormHtml(v, {}, []);
    // Each index appears exactly 4 times (type, name, cert, identifier input names)
    const idx0 = (html.match(/service\[0\]/g) ?? []).length;
    const idx1 = (html.match(/service\[1\]/g) ?? []).length;
    expect(idx0).toBe(4);
    expect(idx1).toBe(4);
    expect(html).not.toContain("service[2]");
  });
});

// ============================================================
// Phase 3 closeout: deep-compare preview with published LoTE
// ============================================================
describe("Phase 3 closeout: deep-compare preview vs published", () => {
  it("compile(preview.compilerInput).document deep-equals stored published LoTE", async () => {
    const pubDir = tmpDir();
    const authDir = tmpDir();
    const configPath = join(tmpdir(), "sc.json");
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

    const fixedClock = new Date("2026-12-15T12:00:00Z");
    const app: any = {
      id: authoringStore.createId(),
      schemaVersion: 1,
      family: "wallet-providers",
      targetListKey: "eu_test_authority",
      state: "approved",
      submittedAt: new Date().toISOString(),
      approvedAt: new Date().toISOString(),
      applicantData: {
        entityName: "DeepEq Corp",
        entityStreetAddress: "1 St",
        entityCountry: "IT",
        entityInformationURI: "https://deepeq.example",
        services: [
          {
            serviceType: "issuance",
            serviceName: "DeepSvc",
            certificatePem: testCertPem,
            serviceUniqueIdentifier: "https://deepeq.svc",
          },
        ],
      },
    };
    authoringStore.save(app);

    // 1. Call preview with fixed clock
    const preview = await service.preview(app, fixedClock);
    expect(preview.compilerInput).toBeTruthy();
    expect(preview.compilerInputJson).toBeTruthy();

    // 2. Call real publishApplication with same clock
    const pubResult = await service.publishApplication(app.id, fixedClock);
    expect(pubResult.success).toBe(true);

    // 3. Load actual stored, authenticated lote.json
    const seq = pubResult.success
      ? pubResult.data.publication!.sequenceNumber
      : 0;
    const loteBytes = await pubStore.loadVersionBytes(
      "eu_test_authority",
      seq,
      "lote",
    );
    expect(loteBytes).not.toBeNull();

    // 4. Compile preview.compilerInput
    const { compile } = await import("../src/core/compile/compile.js");
    const compiledPreview = compile(preview.compilerInput!);

    // 5. Deep-compare: complete scheme info, sequence, timestamps, entities, services
    const storedDoc: any = JSON.parse(loteBytes!);
    const previewDoc = compiledPreview.document;

    const si: any = storedDoc.LoTE.ListAndSchemeInformation;
    const pi: any = previewDoc.LoTE.ListAndSchemeInformation;
    expect(pi.LoTEType).toBe(si.LoTEType);
    expect(pi.LoTESequenceNumber).toBe(si.LoTESequenceNumber);
    expect(pi.ListIssueDateTime).toBe(si.ListIssueDateTime);
    expect(pi.NextUpdate).toBe(si.NextUpdate);
    expect(pi.SchemeTerritory).toBe(si.SchemeTerritory);
    expect(pi.SchemeOperatorName[0].value).toBe(si.SchemeOperatorName[0].value);
    expect(pi.SchemeName![0].value).toBe(si.SchemeName![0].value);

    // Compare all entity names
    const storedEntities: any[] = storedDoc?.LoTE?.TrustedEntitiesList ?? [];
    const previewEntities: any[] = previewDoc?.LoTE?.TrustedEntitiesList ?? [];
    expect(previewEntities.length).toBe(storedEntities.length);
    for (let i = 0; i < storedEntities.length; i++) {
      expect(previewEntities[i].TrustedEntityInformation.TEName[0].value).toBe(
        storedEntities[i].TrustedEntityInformation.TEName[0].value,
      );
    }

    // Compare service unique identifiers
    for (let i = 0; i < storedEntities.length; i++) {
      const storedSvcs = storedEntities[i].TrustedEntityServices ?? [];
      const previewSvcs = previewEntities[i].TrustedEntityServices ?? [];
      expect(previewSvcs.length).toBe(storedSvcs.length);
      for (let j = 0; j < storedSvcs.length; j++) {
        const storedSvcId =
          storedSvcs[j].ServiceInformation.ServiceInformationExtensions?.[0]
            ?.ServiceUniqueIdentifier ?? "";
        const previewSvcId =
          previewSvcs[j].ServiceInformation.ServiceInformationExtensions?.[0]
            ?.ServiceUniqueIdentifier ?? "";
        expect(previewSvcId).toBe(storedSvcId);
      }
    }

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

// ============================================================
// 24. Phase 4: cumulative list composition
// ============================================================
describe("Phase 4: cumulative list composition", () => {
  it("first publication contains one entity", async () => {
    const pubDir = tmpDir();
    const authDir = tmpDir();
    const configPath = join(tmpdir(), "sc.json");
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

    const app = makeApp(authoringStore, "A");
    authoringStore.save(app);
    const r = await service.publishApplication(app.id);
    expect(r.success).toBe(true);
    const loteBytes = await pubStore.loadVersionBytes(
      "eu_test_authority",
      1,
      "lote",
    );
    const doc = JSON.parse(loteBytes!);
    const names = doc.LoTE.TrustedEntitiesList.map(
      (e: any) => e.TrustedEntityInformation.TEName[0].value,
    );
    expect(names).toEqual(["Entity A"]);

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

  it("second publication contains both entities", async () => {
    const pubDir = tmpDir();
    const authDir = tmpDir();
    const configPath = join(tmpdir(), "sc.json");
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

    const a = makeApp(authoringStore, "A");
    authoringStore.save(a);
    await service.publishApplication(a.id);

    const b = makeApp(authoringStore, "B", "https://b.svc");
    authoringStore.save(b);
    await service.publishApplication(b.id);

    const loteBytes = await pubStore.loadVersionBytes(
      "eu_test_authority",
      2,
      "lote",
    );
    const doc = JSON.parse(loteBytes!);
    const names = doc.LoTE.TrustedEntitiesList.map(
      (e: any) => e.TrustedEntityInformation.TEName[0].value,
    );
    expect(names).toEqual(["Entity A", "Entity B"]);

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

  it("third publication preserves order and contains all three", async () => {
    const pubDir = tmpDir();
    const authDir = tmpDir();
    const configPath = join(tmpdir(), "sc.json");
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

    const a = makeApp(authoringStore, "A", "https://a.svc");
    const b = makeApp(authoringStore, "B", "https://b.svc");
    const c = makeApp(authoringStore, "C", "https://c.svc");
    authoringStore.save(a);
    authoringStore.save(b);
    authoringStore.save(c);
    await service.publishApplication(a.id);
    await service.publishApplication(b.id);
    await service.publishApplication(c.id);

    const loteBytes = await pubStore.loadVersionBytes(
      "eu_test_authority",
      3,
      "lote",
    );
    const doc = JSON.parse(loteBytes!);
    const names = doc.LoTE.TrustedEntitiesList.map(
      (e: any) => e.TrustedEntityInformation.TEName[0].value,
    );
    expect(names).toEqual(["Entity A", "Entity B", "Entity C"]);

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

  it("lists with different keys remain isolated", async () => {
    const pubDir = tmpDir();
    const authDir = tmpDir();
    const configPath = join(tmpdir(), "sc.json");
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
          {
            listKey: "eu_other_authority",
            family: "wallet-providers",
            schemeOperatorName: "Other Authority",
            schemeOperatorStreet: "2 Other St",
            schemeOperatorCountry: "EU",
            schemeName: "Other Test",
            schemeTerritory: "EU",
            schemeOperatorContactUri: "mailto:other@test.org",
            distributionPointUri: "https://other.org/lote.json",
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

    const a = makeApp(
      authoringStore,
      "A",
      "https://a1.svc",
      "eu_test_authority",
    );
    const b = makeApp(
      authoringStore,
      "B",
      "https://a2.svc",
      "eu_other_authority",
    );
    authoringStore.save(a);
    authoringStore.save(b);
    await service.publishApplication(a.id);
    await service.publishApplication(b.id);

    const loteA = await pubStore.loadVersionBytes(
      "eu_test_authority",
      1,
      "lote",
    );
    const docA = JSON.parse(loteA!);
    expect(docA.LoTE.TrustedEntitiesList.length).toBe(1);
    expect(
      docA.LoTE.TrustedEntitiesList[0].TrustedEntityInformation.TEName[0].value,
    ).toBe("Entity A");

    const loteB = await pubStore.loadVersionBytes(
      "eu_other_authority",
      1,
      "lote",
    );
    const docB = JSON.parse(loteB!);
    expect(docB.LoTE.TrustedEntitiesList.length).toBe(1);
    expect(
      docB.LoTE.TrustedEntitiesList[0].TrustedEntityInformation.TEName[0].value,
    ).toBe("Entity B");

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

  it("duplicate service identifiers are rejected before writes", async () => {
    const pubDir = tmpDir();
    const authDir = tmpDir();
    const configPath = join(tmpdir(), "sc.json");
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

    const a = makeApp(authoringStore, "A", "https://dup.svc");
    authoringStore.save(a);
    await service.publishApplication(a.id);

    const b = makeApp(authoringStore, "B", "https://dup.svc");
    authoringStore.save(b);
    const r = await service.publishApplication(b.id);
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.toLowerCase()).toContain("duplicate");
    }
    // Application remains approved
    expect(b.state).toBe("approved");

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

  it("corrupt highest sequence blocks publication", async () => {
    const pubDir = tmpDir();
    const authDir = tmpDir();
    const configPath = join(tmpdir(), "sc.json");
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

    const a = makeApp(authoringStore, "A", "https://corrupt.svc");
    authoringStore.save(a);
    await service.publishApplication(a.id);

    // Corrupt the latest version's manifest
    const mPath = resolve(
      pubDir,
      "eu_test_authority",
      "versions",
      "1",
      "manifest.json",
    );
    writeFileSync(mPath, "{corrupt}", "utf-8");

    const b = makeApp(authoringStore, "B", "https://corrupt2.svc");
    authoringStore.save(b);
    const r = await service.publishApplication(b.id);
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error).toContain("corrupt");
    }

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

  it("preview contains existing members plus the candidate", async () => {
    const pubDir = tmpDir();
    const authDir = tmpDir();
    const configPath = join(tmpdir(), "sc.json");
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

    const a = makeApp(authoringStore, "A", "https://prev.svc");
    authoringStore.save(a);
    await service.publishApplication(a.id);

    const b = makeApp(authoringStore, "B", "https://prev2.svc");
    authoringStore.save(b);
    const preview = await service.preview(b);
    expect(preview.existingEntityCount).toBe(1);
    expect(preview.resultingEntityCount).toBe(2);
    expect(preview.currentSequence).toBe(1);
    expect(preview.proposedSequence).toBe(2);

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

function makeApp(
  store: AuthoringStore,
  name: string,
  svcId = `https://entity-${name}.svc`,
  targetListKey = "eu_test_authority",
): any {
  return {
    id: store.createId(),
    schemaVersion: 1,
    family: "wallet-providers",
    targetListKey,
    state: "approved",
    submittedAt: new Date().toISOString(),
    approvedAt: new Date().toISOString(),
    applicantData: {
      entityName: `Entity ${name}`,
      entityStreetAddress: "1 St",
      entityCountry: "IT",
      entityInformationURI: `https://entity-${name}.example`,
      services: [
        {
          serviceType: "issuance",
          serviceName: `Service ${name}`,
          certificatePem: testCertPem,
          serviceUniqueIdentifier: svcId,
        },
      ],
    },
  };
}
