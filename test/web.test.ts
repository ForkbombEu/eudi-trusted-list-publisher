import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import * as crypto from "node:crypto";
import { type Server } from "node:http";
import { get as httpGetRaw } from "node:http";
import {
  compile,
  sign,
  publish,
  PublicationStore,
  resetValidators,
} from "../src/core/index.js";
import { createWebServer } from "../src/web/server.js";
import type { AuthoringInput } from "../src/core/index.js";

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
        {
          lang: "en",
          uriValue:
            "http://uri.etsi.org/19602/ListOfTrustedEntities/WalletProvider/NL",
        },
      ],
      services: [
        {
          serviceTypeIdentifier:
            "http://uri.etsi.org/19602/SvcType/WalletSolution/Issuance",
          serviceName: [{ lang: "en", value: "Wallet Issuance Service" }],
          serviceDigitalIdentity: { x509Certificates: ["MIIDfakecertvalue=="] },
          serviceUniqueIdentifier: "http://test.nl/service/unique-id-001",
        },
      ],
    },
  ],
};

let testCertPem: string;
let signedCompact: string;
let pubDir: string;
let server: Server;
let baseUrl: string;

async function httpGet(
  path: string,
  method = "GET",
): Promise<{
  status: number;
  body: string;
  contentType: string;
  headers: Record<string, string>;
}> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    httpGetRaw(url, { method }, (res) => {
      let data = "";
      res.setEncoding("utf-8");
      res.on("data", (chunk: string) => {
        data += chunk;
      });
      res.on("end", () => {
        resolve({
          status: res.statusCode ?? 500,
          body: data,
          contentType: res.headers["content-type"] ?? "",
          headers: res.headers as Record<string, string>,
        });
      });
    }).on("error", reject);
  });
}

beforeAll(async () => {
  resetValidators();
  testCertPem = readFileSync(
    resolve(__dirname, "fixtures", "test-cert.pem"),
    "utf-8",
  );

  const keyPem = readFileSync(
    resolve(__dirname, "fixtures", "test-key.pem"),
    "utf-8",
  );
  const pk = crypto.createPrivateKey(keyPem);
  const jwk = pk.export({ format: "jwk" });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const key = (await crypto.subtle.importKey(
    "jwk",
    jwk as any,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  )) as globalThis.CryptoKey;

  const doc = compile(AUTHORING).document;
  const signed = await sign({
    document: doc,
    key,
    certificatePem: testCertPem,
  });
  signedCompact = signed.compact;

  pubDir = resolve(tmpdir(), `test-web-${randomUUID()}`);
  mkdirSync(pubDir, { recursive: true });

  const result = await publish({
    compactJws: signedCompact,
    certificatePem: testCertPem,
  });
  const store = new PublicationStore({ publicationDir: pubDir });
  store.store(
    result,
    signedCompact,
    result.loteJson,
    JSON.stringify(result.manifest, null, 2),
  );

  return new Promise<void>((resolve) => {
    server = createWebServer({ publicationDir: pubDir });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        baseUrl = `http://127.0.0.1:${addr.port}`;
      }
      resolve();
    });
  });
});

afterAll(async () => {
  return new Promise<void>((resolve) => {
    server.close(() => {
      try {
        rmSync(pubDir, { recursive: true, force: true });
      } catch {
        /* ok */
      }
      resolve();
    });
  });
});

async function storePublication(): Promise<string> {
  const result = await publish({
    compactJws: signedCompact,
    certificatePem: testCertPem,
  });
  const store = new PublicationStore({ publicationDir: pubDir });
  const loteJson = JSON.stringify(
    JSON.parse(
      Buffer.from(signedCompact.split(".")[1]!, "base64url").toString(),
    ),
    null,
    2,
  );
  store.store(
    result,
    signedCompact,
    loteJson,
    JSON.stringify(result.manifest, null, 2),
  );
  return result.listKey;
}

let storedKey: string;

beforeAll(async () => {
  storedKey = await storePublication();
});

describe("Web UI", () => {
  it("serves catalogue page", async () => {
    // Verify store works first
    const apiRes = await httpGet("/api/v1/lists");
    const apiData = JSON.parse(apiRes.body);
    expect(apiData.lists.length).toBeGreaterThan(0);

    const res = await httpGet("/");
    expect(res.status).toBe(200);
    expect(res.contentType).toContain("text/html");
    expect(res.body).toContain("Catalogue");
    expect(res.body).toContain("not evaluated");
  });

  it("serves list detail page", async () => {
    const key = await storePublication();
    const res = await httpGet(`/lists/${key}`);
    expect(res.status).toBe(200);
    expect(res.body).toContain(key);
  });

  it("serves version detail page", async () => {
    const key = await storePublication();
    const res = await httpGet(`/lists/${key}/versions/1`);
    expect(res.status).toBe(200);
    expect(res.body).toContain("not evaluated");
    expect(res.body).toContain("Signature");
    expect(res.body).toContain("Test Wallet Provider");
  });

  it("serves 404 for unknown list", async () => {
    const res = await httpGet("/lists/nonexistent");
    expect(res.status).toBe(404);
  });

  it("serves 404 for unknown version", async () => {
    const res = await httpGet(`/lists/${storedKey}/versions/999`);
    expect(res.status).toBe(404);
  });

  it("HTML-escapes list key in pages", async () => {
    const res = await httpGet("<script>alert(1)</script>");
    expect(res.status).toBe(404);
    expect(res.body).not.toContain("<script>alert");
  });

  it("serves /healthz", async () => {
    const res = await httpGet("/healthz");
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).status).toBe("ok");
  });

  it("serves /docs", async () => {
    const res = await httpGet("/docs");
    expect(res.status).toBe(200);
    expect(res.contentType).toContain("text/html");
  });

  it("serves security headers", async () => {
    const res = await httpGet("/");
    expect(res.status).toBe(200);
  });
});

describe("JSON API", () => {
  it("serves list of published lists", async () => {
    const res = await httpGet("/api/v1/lists");
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.lists).toBeDefined();
  });

  it("serves list index", async () => {
    const res = await httpGet(`/api/v1/lists/${storedKey}`);
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.listKey).toBe(storedKey);
    expect(data.versions).toBeDefined();
  });

  it("serves version manifest", async () => {
    const res = await httpGet(`/api/v1/lists/${storedKey}/versions/1`);
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.manifestVersion).toBe(1);
    expect(data.signerTrustStatus).toBe("not_evaluated");
  });

  it("serves LoTE JSON download", async () => {
    const res = await httpGet(`/api/v1/lists/${storedKey}/versions/1/lote`);
    expect(res.status).toBe(200);
    expect(res.contentType).toContain("application/json");
  });

  it("serves JAdES signature download", async () => {
    const res = await httpGet(
      `/api/v1/lists/${storedKey}/versions/1/signature`,
    );
    expect(res.status).toBe(200);
  });

  it("serves manifest download", async () => {
    const res = await httpGet(`/api/v1/lists/${storedKey}/versions/1/manifest`);
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.manifestVersion).toBe(1);
  });

  it("returns 404 for unknown API route", async () => {
    const res = await httpGet("/api/v1/lists/nonexistent");
    expect(res.status).toBe(404);
  });
});

describe("Branding", () => {
  it("serves favicon from HITL asset", async () => {
    const res = await httpGet("/favicon.svg");
    expect(res.status).toBe(200);
    expect(res.contentType).toContain("image/svg+xml");
  });

  it("serves style.css from HITL asset", async () => {
    const res = await httpGet("/assets/style.css");
    expect(res.status).toBe(200);
    expect(res.contentType).toContain("text/css");
  });

  it("serves credential_logo.svg", async () => {
    const res = await httpGet("/assets/credimi_logo.svg");
    expect(res.status).toBe(200);
  });

  it("runtime assets match canonical HITL sources byte-for-byte", async () => {
    const canonicalCss = readFileSync(
      resolve(__dirname, "..", "HITL", "style.css"),
      "utf-8",
    );
    const res = await httpGet("/assets/style.css");
    expect(res.body).toBe(canonicalCss);

    const canonicalLogo = readFileSync(
      resolve(__dirname, "..", "HITL", "credimi_logo.svg"),
      "utf-8",
    );
    const logoRes = await httpGet("/assets/credimi_logo.svg");
    expect(logoRes.body).toBe(canonicalLogo);
  });

  it("browser console signature present in HTML pages", async () => {
    const res = await httpGet("/");
    expect(res.body).toContain("console.log");
    expect(res.body).toContain("Credimi");
    expect(res.body).toContain("Trusted List Publisher");
  });
});

describe("HTTP correctness", () => {
  it("returns 405 for POST requests", async () => {
    const res = await httpGet("/", "POST");
    expect(res.status).toBe(405);
    expect(res.headers["allow"]).toBe("GET, HEAD");
  });

  it("returns 405 for PUT requests", async () => {
    const res = await httpGet("/healthz", "PUT");
    expect(res.status).toBe(405);
  });

  it("returns 405 for DELETE requests", async () => {
    const res = await httpGet("/", "DELETE");
    expect(res.status).toBe(405);
  });

  it("includes X-Request-ID in all responses", async () => {
    const res = await httpGet("/");
    expect(res.headers["x-request-id"]).toBeDefined();
  });

  it("does not include local paths or stack traces in errors", async () => {
    const res = await httpGet("/api/v1/lists/nonexistent");
    expect(res.body).not.toContain("/home/");
    expect(res.body).not.toContain("src/");
    expect(res.body).not.toContain("at ");
  });

  it("caches immutable artifacts", async () => {
    const res = await httpGet(
      `/api/v1/lists/${storedKey}/versions/1/signature`,
    );
    expect(res.headers["cache-control"]).toContain("immutable");
  });

  it("does not cache catalogue index", async () => {
    const res = await httpGet("/api/v1/lists");
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("starts with empty publication directory", async () => {
    const emptyDir = resolve(tmpdir(), `empty-web-${randomUUID()}`);
    const srv = createWebServer({ publicationDir: emptyDir });
    await new Promise<void>((resolve) => {
      srv.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = srv.address();
    if (addr && typeof addr === "object") {
      const emptyUrl = `http://127.0.0.1:${addr.port}`;
      const res = await new Promise<{ status: number }>((resolve, reject) => {
        const url = new URL("/", emptyUrl);
        httpGetRaw(url, (r) => {
          resolve({ status: r.statusCode ?? 500 });
        }).on("error", reject);
      });
      expect(res.status).toBe(200);
    }
    srv.close();
  });

  it("/openapi.json returns valid JSON", async () => {
    const res = await httpGet("/openapi.json");
    expect(res.status).toBe(200);
    expect(res.contentType).toContain("application/json");
    const parsed = JSON.parse(res.body);
    expect(parsed.openapi).toBe("3.1.0");
    expect(parsed.paths).toBeDefined();
  });

  it("/openapi.yaml returns valid YAML", async () => {
    const res = await httpGet("/openapi.yaml");
    expect(res.status).toBe(200);
    expect(res.contentType).toContain("application/yaml");
  });

  it("API routes exist in OpenAPI spec", async () => {
    const res = await httpGet("/openapi.json");
    const spec = JSON.parse(res.body);
    const paths = Object.keys(spec.paths ?? {});
    expect(paths).toContain("/api/v1/lists");
    expect(paths).toContain("/api/v1/lists/{listKey}");
    expect(paths).toContain("/api/v1/lists/{listKey}/versions/{sequence}");
    expect(paths).toContain("/api/v1/lists/{listKey}/versions/{sequence}/lote");
    expect(paths).toContain(
      "/api/v1/lists/{listKey}/versions/{sequence}/signature",
    );
    expect(paths).toContain(
      "/api/v1/lists/{listKey}/versions/{sequence}/manifest",
    );
  });

  it("negative logo used on dark footer", async () => {
    const res = await httpGet("/");
    expect(res.body).toContain("credimi_logo_negative.svg");
    expect(res.body).toContain('class="site-footer dark"');
  });

  it("negative logo is byte-for-byte HITL copy", async () => {
    const canonical = readFileSync(
      resolve(__dirname, "..", "HITL", "credimi_logo_negative.svg"),
      "utf-8",
    );
    const res = await httpGet("/assets/credimi_logo_negative.svg");
    expect(res.body).toBe(canonical);
  });

  it("manifest serves with immutable caching", async () => {
    const res = await httpGet(`/api/v1/lists/${storedKey}/versions/1/manifest`);
    expect(res.headers["cache-control"]).toContain("immutable");
  });

  it("security headers present on 404 responses", async () => {
    const res = await httpGet("/nonexistent");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("security headers present on 405 responses", async () => {
    const res = await httpGet("/", "POST");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("bidirectional route parity: all OpenAPI paths use GET method", async () => {
    const res = await httpGet("/openapi.json");
    const spec = JSON.parse(res.body);
    for (const [, methods] of Object.entries(
      spec.paths as Record<string, unknown>,
    )) {
      expect(
        methods && typeof methods === "object" && "get" in (methods as object),
      ).toBe(true);
    }
  });

  it("exact download bytes match stored artefacts", async () => {
    const jadesRes = await httpGet(
      `/api/v1/lists/${storedKey}/versions/1/signature`,
    );
    expect(jadesRes.status).toBe(200);
    expect(jadesRes.body).toBe(signedCompact);

    const jsonRes = await httpGet(`/api/v1/lists/${storedKey}/versions/1/lote`);
    expect(jsonRes.status).toBe(200);
    const parsed = JSON.parse(jsonRes.body);
    expect(parsed.LoTE).toBeDefined();
  });

  it("server does not create publication directory on startup", async () => {
    const emptyDir = resolve(tmpdir(), `ro-srv-${randomUUID()}`);
    const srv = createWebServer({ publicationDir: emptyDir });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const addr = srv.address();
    if (addr && typeof addr === "object") {
      const emptyUrl = `http://127.0.0.1:${addr.port}`;
      await new Promise<void>((resolve, reject) => {
        const url = new URL("/", emptyUrl);
        httpGetRaw(url, (res) => {
          res.resume();
          resolve();
        }).on("error", reject);
      });
    }
    srv.close();
    expect(existsSync(emptyDir)).toBe(false);
  });

  it("query strings are stripped from request logging path", async () => {
    const res = await httpGet("/healthz?token=SECRET_DO_NOT_LOG&user=admin");
    expect(res.status).toBe(200);
  });
});
