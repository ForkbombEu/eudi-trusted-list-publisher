import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { createWebServer } from "../src/web/server.js";
import type { ServerConfig } from "../src/web/server.js";
import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { LIST_FAMILIES } from "../src/core/authoring/list-family-catalogue.js";

function extractCookie(setCookieHeaders: string[]): string {
  return setCookieHeaders.map((h) => h.split(";")[0]!).join("; ");
}

async function postThenFollow(
  url: string,
  body: string,
  cookie: string,
): Promise<{ status: number; body: string; location: string }> {
  const r = await httpPost(url, body, cookie);
  if (r.status === 303 && r.headers.location) {
    const loc = r.headers.location;
    const u = new URL(url);
    const tgt = loc.startsWith("/") ? `${u.protocol}//${u.host}${loc}` : loc;
    const r2 = await httpGet(tgt, cookie);
    return { status: r2.status, body: r2.body, location: loc };
  }
  return { status: r.status, body: r.body, location: "" };
}

const TEST_CERT = readFileSync(
  resolve(import.meta.dirname, "fixtures", "test-cert.pem"),
  "utf-8",
);

function tmpDir(): string {
  const d = join(tmpdir(), "tlp-gui-" + randomBytes(8).toString("hex"));
  mkdirSync(d, { recursive: true });
  return d;
}

function httpGet(
  url: string,
  cookie?: string,
): Promise<{
  status: number;
  body: string;
  headers: Record<string, string>;
  cookies: string[];
}> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const http = require("node:http");
    const headers: Record<string, string> = {};
    if (cookie) headers["Cookie"] = cookie;
    http
      .get(u, { headers }, (res: IncomingMessage) => {
        let body = "";
        res.on("data", (chunk: Buffer) => (body += chunk.toString()));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body,
            headers: res.headers as Record<string, string>,
            cookies: (res.headers["set-cookie"] as string[]) ?? [],
          }),
        );
      })
      .on("error", reject);
  });
}

function httpPost(
  url: string,
  body: string,
  cookie?: string,
): Promise<{
  status: number;
  body: string;
  headers: Record<string, string>;
  cookies: string[];
}> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const http = require("node:http");
    const headers: Record<string, string> = {
      "Content-Type": "application/x-www-form-urlencoded",
      "Content-Length": String(Buffer.byteLength(body)),
    };
    if (cookie) headers["Cookie"] = cookie;
    const req = http.request(
      u,
      { method: "POST", headers },
      (res: IncomingMessage) => {
        let b = "";
        res.on("data", (chunk: Buffer) => (b += chunk.toString()));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: b,
            headers: res.headers as Record<string, string>,
            cookies: (res.headers["set-cookie"] as string[]) ?? [],
          }),
        );
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function startServer(
  config: ServerConfig,
): Promise<{ url: string; stop: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = createWebServer(config);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        stop: () =>
          new Promise((r) => {
            server.close(() => r());
          }),
      });
    });
    server.on("error", reject);
  });
}

function createSigningConfig(dir: string): string {
  const certPath = resolve(import.meta.dirname, "fixtures", "test-cert.pem");
  const keyPath = resolve(import.meta.dirname, "fixtures", "test-key.pem");
  const path = join(dir, "signing-config.json");
  writeFileSync(
    path,
    JSON.stringify({
      lists: [
        {
          listKey: "eu_test_authority",
          family: "wallet-providers",
          schemeOperatorName: "Test Authority",
          schemeOperatorStreet: "Test Street 1",
          schemeOperatorCountry: "IT",
          schemeName: "Test Wallet Providers",
          schemeTerritory: "EU",
          schemeOperatorContactUri: "https://test.example",
          distributionPointUri: "https://test.example/latest",
          keyFile: keyPath,
          certFile: certPath,
        },
      ],
    }),
  );
  return path;
}

function encodeForm(data: Record<string, string>): string {
  return Object.entries(data)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

describe("GUI disabled by default", () => {
  it("refuses to start GUI without admin token", () => {
    expect(() =>
      createWebServer({
        publicationDir: "/dev/null",
        dataCollectionGui: true,
        adminToken: "",
      }),
    ).toThrow(/TLP_ADMIN_TOKEN/);
  });

  it("exposes no admin/onboarding routes when disabled", async () => {
    const pubDir = tmpDir();
    const { url, stop } = await startServer({
      publicationDir: pubDir,
    });
    try {
      const r1 = await httpGet(`${url}/onboarding`);
      expect(r1.status).toBe(404);
      const r2 = await httpGet(`${url}/admin`);
      expect(r2.status).toBe(404);
      const r3 = await httpPost(`${url}/onboarding/wallet-provider`, "x=1");
      expect(r3.status).toBe(405);
    } finally {
      await stop();
      try {
        rmSync(pubDir, { recursive: true, force: true });
      } catch {}
    }
  });
});

describe("GUI admin authentication", () => {
  it("returns 403 when no admin token provided", async () => {
    const pubDir = tmpDir();
    const authDir = tmpDir();
    const sigConfigPath = createSigningConfig(tmpDir());
    const { url, stop } = await startServer({
      publicationDir: pubDir,
      dataCollectionGui: true,
      authoringDir: authDir,
      adminToken: "secret",
      signingConfigPath: sigConfigPath,
    });
    try {
      const r = await httpGet(`${url}/admin`);
      expect(r.status).toBe(403);
      expect(r.body).toContain("Access Denied");
    } finally {
      await stop();
      try {
        rmSync(pubDir, { recursive: true, force: true });
      } catch {}
      try {
        rmSync(authDir, { recursive: true, force: true });
      } catch {}
      try {
        rmSync(sigConfigPath, { force: true });
      } catch {}
    }
  });

  it("establishes cookie-based admin session via ?token=", async () => {
    const pubDir = tmpDir();
    const authDir = tmpDir();
    const sigConfigPath = createSigningConfig(tmpDir());
    const { url, stop } = await startServer({
      publicationDir: pubDir,
      dataCollectionGui: true,
      authoringDir: authDir,
      adminToken: "s3cret",
      signingConfigPath: sigConfigPath,
    });
    try {
      // First request with token establishes cookie
      const r1 = await httpGet(`${url}/admin?token=s3cret`);
      expect(r1.status).toBe(303);
      const cookies = r1.cookies;
      expect(cookies.length).toBeGreaterThan(0);
      const cookieStr = extractCookie(cookies);

      // Subsequent request uses cookie
      const r2 = await httpGet(`${url}/admin`, cookieStr);
      expect(r2.status).toBe(200);
      expect(r2.body).toContain("Administration");

      // Admin links work
      const r3 = await httpGet(`${url}/admin/applications`, cookieStr);
      expect(r3.status).toBe(200);
    } finally {
      await stop();
      try {
        rmSync(pubDir, { recursive: true, force: true });
      } catch {}
      try {
        rmSync(authDir, { recursive: true, force: true });
      } catch {}
      try {
        rmSync(sigConfigPath, { force: true });
      } catch {}
    }
  });

  it("POST forms work with cookie auth", async () => {
    const pubDir = tmpDir();
    const authDir = tmpDir();
    const sigConfigPath = createSigningConfig(tmpDir());
    const { url, stop } = await startServer({
      publicationDir: pubDir,
      dataCollectionGui: true,
      authoringDir: authDir,
      adminToken: "posttest",
      signingConfigPath: sigConfigPath,
    });
    try {
      const r1 = await httpGet(`${url}/admin?token=posttest`);
      const cookieStr = r1.cookies.length > 0 ? extractCookie(r1.cookies) : "";

      const r2 = await httpGet(`${url}/onboarding`, cookieStr);
      expect(r2.status).toBe(200);
      expect(r2.body).toContain("Onboarding");
    } finally {
      await stop();
      try {
        rmSync(pubDir, { recursive: true, force: true });
      } catch {}
      try {
        rmSync(authDir, { recursive: true, force: true });
      } catch {}
      try {
        rmSync(sigConfigPath, { force: true });
      } catch {}
    }
  });
});

describe("Onboarding catalogue from LIST_FAMILIES", () => {
  it("renders onboarding catalogue with all seven entries", async () => {
    const pubDir = tmpDir();
    const authDir = tmpDir();
    const sigConfigPath = createSigningConfig(tmpDir());
    const { url, stop } = await startServer({
      publicationDir: pubDir,
      dataCollectionGui: true,
      authoringDir: authDir,
      adminToken: "cat",
      signingConfigPath: sigConfigPath,
    });
    try {
      const r = await httpGet(`${url}/onboarding`);
      expect(r.status).toBe(200);
      for (const f of LIST_FAMILIES) {
        expect(r.body).toContain(f.label);
      }
      expect(r.body).toContain("Wallet Providers");
      expect(r.body).toContain("Available");
      expect(r.body).toContain("Not implemented yet");
    } finally {
      await stop();
      try {
        rmSync(pubDir, { recursive: true, force: true });
      } catch {}
      try {
        rmSync(authDir, { recursive: true, force: true });
      } catch {}
      try {
        rmSync(sigConfigPath, { force: true });
      } catch {}
    }
  });
});

describe("Form submission", () => {
  it("valid form creates a submitted application", async () => {
    const pubDir = tmpDir();
    const authDir = tmpDir();
    const sigConfigPath = createSigningConfig(tmpDir());
    const { url, stop } = await startServer({
      publicationDir: pubDir,
      dataCollectionGui: true,
      authoringDir: authDir,
      adminToken: "submit1",
      signingConfigPath: sigConfigPath,
    });
    try {
      const body = encodeForm({
        targetListKey: "eu_test_authority",
        entityName: "Test Corp",
        entityStreetAddress: "123 Main St",
        entityCountry: "IT",
        entityInformationURI: "https://example.com/test",
        "service[0].serviceType": "issuance",
        "service[0].serviceName": "Test Issuance",
        "service[0].certificatePem": TEST_CERT,
        "service[0].serviceUniqueIdentifier": "https://example.com/svc/1",
      });
      const r = await httpPost(`${url}/onboarding/wallet-provider`, body);
      expect(r.status).toBe(303);
      const location = r.headers.location;
      expect(location).toMatch(/\/onboarding\/submitted\//);

      const appId = location!.split("/").pop()!;
      const r2 = await httpGet(`${url}/onboarding/submitted/${appId}`);
      expect(r2.status).toBe(200);
      expect(r2.body).toContain("submitted");
      expect(r2.body).toContain("Test Corp");
    } finally {
      await stop();
      try {
        rmSync(pubDir, { recursive: true, force: true });
      } catch {}
      try {
        rmSync(authDir, { recursive: true, force: true });
      } catch {}
      try {
        rmSync(sigConfigPath, { force: true });
      } catch {}
    }
  });

  it("invalid form returns errors and preserves values", async () => {
    const pubDir = tmpDir();
    const authDir = tmpDir();
    const sigConfigPath = createSigningConfig(tmpDir());
    const { url, stop } = await startServer({
      publicationDir: pubDir,
      dataCollectionGui: true,
      authoringDir: authDir,
      adminToken: "err1",
      signingConfigPath: sigConfigPath,
    });
    try {
      const body = encodeForm({
        entityName: "",
        entityStreetAddress: "Saved St",
        entityCountry: "invalid123",
        entityInformationURI: "not-a-url",
        "service[0].serviceType": "",
        "service[0].serviceName": "",
        "service[0].certificatePem": "",
        "service[0].serviceUniqueIdentifier": "",
      });
      const r = await httpPost(`${url}/onboarding/wallet-provider`, body);
      expect(r.status).toBe(400);
      expect(r.body).toContain("Entity name is required");
      expect(r.body).toContain("Country must be");
      expect(r.body).toContain("field-error");
      expect(r.body).toContain("Saved St");
    } finally {
      await stop();
      try {
        rmSync(pubDir, { recursive: true, force: true });
      } catch {}
      try {
        rmSync(authDir, { recursive: true, force: true });
      } catch {}
      try {
        rmSync(sigConfigPath, { force: true });
      } catch {}
    }
  });

  it("submits two services and both are stored", async () => {
    const pubDir = tmpDir();
    const authDir = tmpDir();
    const sigConfigPath = createSigningConfig(tmpDir());
    const { url, stop } = await startServer({
      publicationDir: pubDir,
      dataCollectionGui: true,
      authoringDir: authDir,
      adminToken: "two",
      signingConfigPath: sigConfigPath,
    });
    try {
      const body = encodeForm({
        targetListKey: "eu_test_authority",
        entityName: "MultiSvc Corp",
        entityStreetAddress: "456 Ave",
        entityCountry: "IT",
        entityInformationURI: "https://multi.example",
        "service[0].serviceType": "issuance",
        "service[0].serviceName": "Issuance Svc",
        "service[0].certificatePem": TEST_CERT,
        "service[0].serviceUniqueIdentifier": "https://multi.example/iss",
        "service[1].serviceType": "revocation",
        "service[1].serviceName": "Revocation Svc",
        "service[1].certificatePem": TEST_CERT,
        "service[1].serviceUniqueIdentifier": "https://multi.example/rev",
      });
      const r = await httpPost(`${url}/onboarding/wallet-provider`, body);
      expect(r.status).toBe(303);
      const location = r.headers.location!;
      const appId = location.split("/").pop()!;

      // Load application from store to verify
      const { AuthoringStore } =
        await import("../src/core/authoring/authoring-store.js");
      const store = new AuthoringStore({ authoringDir: authDir });
      const app = store.load(appId);
      expect(app).not.toBeNull();
      expect(app!.applicantData.services).toHaveLength(2);
      expect(app!.applicantData.services[0]!.serviceType).toBe("issuance");
      expect(app!.applicantData.services[1]!.serviceType).toBe("revocation");
    } finally {
      await stop();
      try {
        rmSync(pubDir, { recursive: true, force: true });
      } catch {}
      try {
        rmSync(authDir, { recursive: true, force: true });
      } catch {}
      try {
        rmSync(sigConfigPath, { force: true });
      } catch {}
    }
  });
});

describe("Admin lifecycle", () => {
  async function setupAdminServer() {
    const pubDir = tmpDir();
    const authDir = tmpDir();
    const sigConfigPath = createSigningConfig(tmpDir());
    const { url, stop } = await startServer({
      publicationDir: pubDir,
      dataCollectionGui: true,
      authoringDir: authDir,
      adminToken: "lifecycle",
      signingConfigPath: sigConfigPath,
    });
    const r = await httpGet(`${url}/admin?token=lifecycle`);
    const cookie = r.cookies.length > 0 ? extractCookie(r.cookies) : "";
    return { url, stop, pubDir, authDir, sigConfigPath, cookie };
  }

  it("approve → reject → delete flow", async () => {
    const { url, stop, pubDir, authDir, sigConfigPath, cookie } =
      await setupAdminServer();
    try {
      // Submit application
      const body = encodeForm({
        targetListKey: "eu_test_authority",
        entityName: "ApproveMe Inc",
        entityStreetAddress: "1 Approve St",
        entityCountry: "IT",
        entityInformationURI: "https://approve.example",
        "service[0].serviceType": "issuance",
        "service[0].serviceName": "Svc",
        "service[0].certificatePem": TEST_CERT,
        "service[0].serviceUniqueIdentifier": "https://approve.example/1",
      });
      const r1 = await httpPost(`${url}/onboarding/wallet-provider`, body);
      const appId = r1.headers.location!.split("/").pop()!;

      // Inspect
      const r2 = await httpGet(`${url}/admin/applications/${appId}`, cookie);
      expect(r2.status).toBe(200);
      expect(r2.body).toContain("ApproveMe Inc");

      // Invalid transition: submit → publish (should fail)
      const rBad = await postThenFollow(
        `${url}/admin/applications/${appId}/publish`,
        "",
        cookie,
      );
      expect(rBad.status).toBe(200);
      expect(rBad.body).toContain("Cannot publish");

      // Approve
      const r3 = await httpPost(
        `${url}/admin/applications/${appId}/approve`,
        "",
        cookie,
      );
      expect(r3.status).toBe(303);

      const rCheck = await httpGet(
        `${url}/admin/applications/${appId}`,
        cookie,
      );
      expect(rCheck.body).toContain("approved");

      // Reject (approved → rejected)
      const r4 = await httpPost(
        `${url}/admin/applications/${appId}/reject`,
        "note=Not ready for publication",
        cookie,
      );
      expect(r4.status).toBe(303);

      const r4Check = await httpGet(
        `${url}/admin/applications/${appId}`,
        cookie,
      );
      expect(r4Check.body).toContain("rejected");
      expect(r4Check.body).toContain("Not ready for publication");

      // Delete rejected
      const r5 = await httpPost(
        `${url}/admin/applications/${appId}/delete`,
        "",
        cookie,
      );
      expect(r5.status).toBe(303);
    } finally {
      await stop();
      try {
        rmSync(pubDir, { recursive: true, force: true });
      } catch {}
      try {
        rmSync(authDir, { recursive: true, force: true });
      } catch {}
      try {
        rmSync(sigConfigPath, { force: true });
      } catch {}
    }
  });

  it("rejection without note fails", async () => {
    const { url, stop, pubDir, authDir, sigConfigPath, cookie } =
      await setupAdminServer();
    try {
      const body = encodeForm({
        targetListKey: "eu_test_authority",
        entityName: "NoteFail Inc",
        entityStreetAddress: "1 St",
        entityCountry: "IT",
        entityInformationURI: "https://note.example",
        "service[0].serviceType": "issuance",
        "service[0].serviceName": "Svc",
        "service[0].certificatePem": TEST_CERT,
        "service[0].serviceUniqueIdentifier": "https://note.example/1",
      });
      const r1 = await httpPost(`${url}/onboarding/wallet-provider`, body);
      const appId = r1.headers.location!.split("/").pop()!;

      // Try reject without note
      const r2 = await postThenFollow(
        `${url}/admin/applications/${appId}/reject`,
        "note=",
        cookie,
      );
      expect(r2.status).toBe(200);
      expect(r2.body).toContain("Rejection note");
    } finally {
      await stop();
      try {
        rmSync(pubDir, { recursive: true, force: true });
      } catch {}
      try {
        rmSync(authDir, { recursive: true, force: true });
      } catch {}
      try {
        rmSync(sigConfigPath, { force: true });
      } catch {}
    }
  });

  it("published application cannot be deleted", async () => {
    const { url, stop, pubDir, authDir, sigConfigPath, cookie } =
      await setupAdminServer();
    try {
      const body = encodeForm({
        targetListKey: "eu_test_authority",
        entityName: "PubDelete Inc",
        entityStreetAddress: "1 St",
        entityCountry: "IT",
        entityInformationURI: "https://pub.example",
        "service[0].serviceType": "issuance",
        "service[0].serviceName": "Svc",
        "service[0].certificatePem": TEST_CERT,
        "service[0].serviceUniqueIdentifier": "https://pub.example/1",
      });
      const r1 = await httpPost(`${url}/onboarding/wallet-provider`, body);
      const appId = r1.headers.location!.split("/").pop()!;

      await httpPost(`${url}/admin/applications/${appId}/approve`, "", cookie);
      const rPub = await postThenFollow(
        `${url}/admin/applications/${appId}/publish`,
        "",
        cookie,
      );
      // Publish should succeed
      expect(rPub.location).toContain("success=");

      // Verify published state
      const rCheckPub = await httpGet(
        `${url}/admin/applications/${appId}`,
        cookie,
      );
      expect(rCheckPub.body).toContain("published");
      expect(rCheckPub.body).toContain("Publication Record");

      // Try to delete published
      const rDel = await httpPost(
        `${url}/admin/applications/${appId}/delete`,
        "",
        cookie,
      );
      expect(rDel.status).toBe(303);
      const rCheck = await httpGet(
        `${url}/admin/applications/${appId}`,
        cookie,
      );
      expect(rCheck.body).toContain("published");
      expect(rCheck.body).toContain("Publication Record");
    } finally {
      await stop();
      try {
        rmSync(pubDir, { recursive: true, force: true });
      } catch {}
      try {
        rmSync(authDir, { recursive: true, force: true });
      } catch {}
      try {
        rmSync(sigConfigPath, { force: true });
      } catch {}
    }
  });

  it("missing signing config prevents publication cleanly", async () => {
    const pubDir = tmpDir();
    const authDir = tmpDir();
    const badSigConfigPath = join(tmpDir(), "bad-config.json");
    writeFileSync(
      badSigConfigPath,
      JSON.stringify({
        lists: [
          {
            listKey: "nonexistent",
            family: "wallet-providers",
            schemeOperatorName: "X",
            schemeOperatorStreet: "X",
            schemeOperatorCountry: "XX",
            schemeName: "X",
            schemeTerritory: "XX",
            schemeOperatorContactUri: "https://x",
            distributionPointUri: "https://x/latest",
            keyFile: "/nonexistent/key.pem",
            certFile: "/nonexistent/cert.pem",
          },
        ],
      }),
    );
    const { url, stop } = await startServer({
      publicationDir: pubDir,
      dataCollectionGui: true,
      authoringDir: authDir,
      adminToken: "nokey",
      signingConfigPath: badSigConfigPath,
    });
    try {
      const rLogin = await httpGet(`${url}/admin?token=nokey`);
      const cookie = rLogin.cookies.join("; ");

      // Submit app targeting nonexistent list
      const body = encodeForm({
        targetListKey: "nonexistent",
        entityName: "NoKey Inc",
        entityStreetAddress: "1 St",
        entityCountry: "IT",
        entityInformationURI: "https://nokey.example",
        "service[0].serviceType": "issuance",
        "service[0].serviceName": "Svc",
        "service[0].certificatePem": TEST_CERT,
        "service[0].serviceUniqueIdentifier": "https://nokey.example/1",
      });
      const r1 = await httpPost(`${url}/onboarding/wallet-provider`, body);
      const appId = r1.headers.location!.split("/").pop()!;

      await httpPost(`${url}/admin/applications/${appId}/approve`, "", cookie);

      const rPub = await postThenFollow(
        `${url}/admin/applications/${appId}/publish`,
        "",
        cookie,
      );
      expect(rPub.status).toBe(200);
      expect(rPub.body).toContain("error");
      // Still approved, not published
      const { AuthoringStore } =
        await import("../src/core/authoring/authoring-store.js");
      const st = new AuthoringStore({ authoringDir: authDir });
      const app = st.load(appId);
      expect(app!.state).toBe("approved");
    } finally {
      await stop();
      try {
        rmSync(pubDir, { recursive: true, force: true });
      } catch {}
      try {
        rmSync(authDir, { recursive: true, force: true });
      } catch {}
      try {
        rmSync(badSigConfigPath, { force: true });
      } catch {}
    }
  });

  it("full publish with correct signing config produces valid publication", async () => {
    const pubDir = tmpDir();
    const authDir = tmpDir();
    const sigConfigPath = createSigningConfig(tmpDir());
    const { url, stop } = await startServer({
      publicationDir: pubDir,
      dataCollectionGui: true,
      authoringDir: authDir,
      adminToken: "fullpub",
      signingConfigPath: sigConfigPath,
    });
    try {
      const rLogin = await httpGet(`${url}/admin?token=fullpub`);
      const cookie = rLogin.cookies.join("; ");

      const body = encodeForm({
        targetListKey: "eu_test_authority",
        entityName: "FullPub Corp",
        entityStreetAddress: "555 Final St",
        entityCountry: "IT",
        entityInformationURI: "https://fullpub.example",
        "service[0].serviceType": "issuance",
        "service[0].serviceName": "Issuance",
        "service[0].certificatePem": TEST_CERT,
        "service[0].serviceUniqueIdentifier": "https://fullpub.example/1",
      });
      const r1 = await httpPost(`${url}/onboarding/wallet-provider`, body);
      const appId = r1.headers.location!.split("/").pop()!;

      await httpPost(`${url}/admin/applications/${appId}/approve`, "", cookie);

      const rPub = await postThenFollow(
        `${url}/admin/applications/${appId}/publish`,
        "",
        cookie,
      );
      expect(rPub.location).toContain("success=");

      const rDetail = await httpGet(
        `${url}/admin/applications/${appId}`,
        cookie,
      );
      expect(rDetail.body).toContain("published");
      expect(rDetail.body).toContain("Publication Record");
      expect(rDetail.body).toContain("eu_test_authority");

      // Verify the immutable publication
      const { PublicationStore, loadVersionArtifacts } =
        await import("../src/core/publication/store.js");
      const pubStore = new PublicationStore({ publicationDir: pubDir });
      const idx = await pubStore.loadIndex("eu_test_authority");
      expect(idx).not.toBeNull();
      expect(idx!.versions.length).toBeGreaterThan(0);

      const arts = await loadVersionArtifacts(
        pubDir,
        "eu_test_authority",
        1,
        10 * 1024 * 1024,
      );
      expect(arts.artifacts).not.toBeNull();
      expect(arts.artifacts!.manifest.signatureValid).toBe(true);

      // Published app should still show the publication link
      expect(rDetail.body).toContain("View Publication");
      expect(rDetail.body).toContain("/lists/eu_test_authority/versions/1");
    } finally {
      await stop();
      try {
        rmSync(pubDir, { recursive: true, force: true });
      } catch {}
      try {
        rmSync(authDir, { recursive: true, force: true });
      } catch {}
      try {
        rmSync(sigConfigPath, { force: true });
      } catch {}
    }
  });

  it("renders cumulative preview metadata through the authenticated admin route", async () => {
    const pubDir = tmpDir();
    const authDir = tmpDir();
    const sigConfigPath = createSigningConfig(tmpDir());
    const { url, stop } = await startServer({
      publicationDir: pubDir,
      dataCollectionGui: true,
      authoringDir: authDir,
      adminToken: "cumulative-preview",
      signingConfigPath: sigConfigPath,
    });
    try {
      const login = await httpGet(`${url}/admin?token=cumulative-preview`);
      const cookie = login.cookies.join("; ");
      const submit = async (name: string, identifier: string) => {
        const body = encodeForm({
          targetListKey: "eu_test_authority",
          entityName: name,
          entityStreetAddress: "1 Preview St",
          entityCountry: "DK",
          entityInformationURI: `https://${identifier}.example`,
          "service[0].serviceType": "issuance",
          "service[0].serviceName": "Issuance",
          "service[0].certificatePem": TEST_CERT,
          "service[0].serviceUniqueIdentifier": `https://${identifier}.example/service`,
        });
        const created = await httpPost(
          `${url}/onboarding/wallet-provider`,
          body,
        );
        return created.headers.location!.split("/").pop()!;
      };
      const a = await submit("Preview A", "preview-a");
      await httpPost(`${url}/admin/applications/${a}/approve`, "", cookie);
      await postThenFollow(
        `${url}/admin/applications/${a}/publish`,
        "",
        cookie,
      );
      const b = await submit("Preview B", "preview-b");
      await httpPost(`${url}/admin/applications/${b}/approve`, "", cookie);

      const detail = await httpGet(`${url}/admin/applications/${b}`, cookie);
      expect(detail.status).toBe(200);
      expect(detail.body).toContain("Existing Entities");
      expect(detail.body).toContain("Resulting Entities");
      expect(detail.body).toContain("Current Sequence");
      expect(detail.body).toContain("Proposed Sequence");
      expect(detail.body).toMatch(/Existing Entities<\/th><td>1/);
      expect(detail.body).toMatch(/Resulting Entities<\/th><td>2/);
      expect(detail.body).toMatch(/Current Sequence<\/th><td>1/);
      expect(detail.body).toMatch(/Proposed Sequence<\/th><td>2/);
    } finally {
      await stop();
      rmSync(pubDir, { recursive: true, force: true });
      rmSync(authDir, { recursive: true, force: true });
      rmSync(sigConfigPath, { force: true });
    }
  });
});
