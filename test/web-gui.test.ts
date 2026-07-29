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
import type {
  PIDProviderApplication,
  WalletProviderApplication,
} from "../src/core/authoring/application-model.js";
import {
  adminApplicationDetailHtml,
  adminApplicationsHtml,
} from "../src/web/views/admin.js";

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

const walletAdminApplication: WalletProviderApplication = {
  id: "wallet-admin-application",
  schemaVersion: 1,
  family: "wallet-providers",
  targetListKey: "wallet-list",
  state: "approved",
  submittedAt: "2026-07-29T12:00:00Z",
  applicantData: {
    entityName: "Wallet Admin Ltd",
    entityStreetAddress: "1 Wallet Way",
    entityCountry: "DK",
    entityInformationURI: "https://wallet.example",
    services: [
      {
        serviceType: "issuance",
        serviceName: "Wallet issuance",
        certificatePem: TEST_CERT,
        serviceUniqueIdentifier: "https://wallet.example/services/issuance",
      },
    ],
  },
};

const pidAdminApplication: PIDProviderApplication = {
  id: "pid-admin-application",
  schemaVersion: 1,
  family: "pid-providers",
  targetListKey: "pid-list",
  state: "approved",
  submittedAt: "2026-07-29T12:00:00Z",
  applicantData: {
    entityName: "PID Admin Ltd",
    entityStreetAddress: "2 PID Place",
    entityCountry: "DK",
    entityInformationURI: "https://pid.example",
    responsibleMemberState: "<DK & Co",
    services: [
      {
        serviceType: "issuance",
        serviceName: "PID issuance",
        certificatePem: TEST_CERT,
        serviceUniqueIdentifier: "https://pid.example/services/issuance",
      },
    ],
  },
};

describe("profile-aware admin rendering", () => {
  it("renders Wallet and PID applications through the shared list and detail views", () => {
    const list = adminApplicationsHtml([
      walletAdminApplication,
      pidAdminApplication,
    ]);
    const walletDetail = adminApplicationDetailHtml(walletAdminApplication);
    const pidDetail = adminApplicationDetailHtml(
      pidAdminApplication,
      undefined,
      undefined,
      undefined,
      {
        existingEntityCount: 1,
        resultingEntityCount: 2,
        currentSequence: 3,
        proposedSequence: 4,
      },
    );

    expect(list).toContain("Wallet Providers");
    expect(list).toContain("PID Providers");
    expect(walletDetail).toContain("Wallet Providers");
    expect(pidDetail).toContain("PID Providers");
    expect(pidDetail).toContain("Responsible Member State");
    expect(pidDetail).toContain("&lt;DK &amp; Co");
    expect(walletDetail).not.toContain("Responsible Member State");
    expect(pidDetail).toContain("Preview &mdash; Cumulative Publication");
    expect(pidDetail).toContain("Publish");
    expect(pidDetail).toContain("Reject");
  });
});

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

describe("Phase 5.1 GUI shell", () => {
  async function guiServer() {
    const pubDir = tmpDir();
    const authDir = tmpDir();
    const sigConfigPath = createSigningConfig(tmpDir());
    const started = await startServer({
      publicationDir: pubDir,
      dataCollectionGui: true,
      authoringDir: authDir,
      adminToken: "shell",
      signingConfigPath: sigConfigPath,
    });
    return {
      ...started,
      cleanup: async () => {
        await started.stop();
        for (const p of [pubDir, authDir, sigConfigPath]) {
          try {
            rmSync(p, { recursive: true, force: true });
          } catch {}
        }
      },
    };
  }

  it("shows the full GUI navigation on catalogue and API docs", async () => {
    const { url, cleanup } = await guiServer();
    try {
      for (const path of ["/", "/docs"]) {
        const r = await httpGet(`${url}${path}`);
        expect(r.status).toBe(200);
        for (const label of [
          "Catalogue",
          "Onboarding",
          "API Docs",
          "Open API",
          "Repository",
          // Admin now lives in the footer Settings column, not in the topbar.
          "Admin",
        ]) {
          expect(r.body).toContain(`>${label}</a>`);
        }
        // Three top-nav groups: site, API surface, source.
        expect(r.body.match(/class="nav-sep"/g)).toHaveLength(2);
        expect(r.body).toContain("<h5>Settings</h5>");
      }
    } finally {
      await cleanup();
    }
  });

  it("links enabled onboarding families to the implemented singular routes", async () => {
    const { url, cleanup } = await guiServer();
    try {
      const r = await httpGet(`${url}/onboarding`);
      expect(r.status).toBe(200);
      expect(r.body).toContain(
        "Welcome to Credimi Trusted List onboarding tool",
      );
      expect(r.body).toContain('href="/onboarding/wallet-provider"');
      expect(r.body).toContain('href="/onboarding/pid-provider"');
      expect(r.body).toContain("card-disabled");

      for (const path of [
        "/onboarding/wallet-provider",
        "/onboarding/pid-provider",
      ]) {
        expect((await httpGet(`${url}${path}`)).status).toBe(200);
      }
    } finally {
      await cleanup();
    }
  });

  it("renders a PID-specific form with no Wallet wording", async () => {
    const { url, cleanup } = await guiServer();
    try {
      const r = await httpGet(`${url}/onboarding/pid-provider`);
      expect(r.status).toBe(200);
      expect(r.body).toContain("PID Provider Application");
      expect(r.body).toContain("Responsible Member State");
      expect(r.body).toContain("PID Issuance");
      expect(r.body).toContain("PID Revocation");
      expect(r.body).toContain("PID Providers list");
      expect(r.body).not.toMatch(/Wallet/);

      // Backend field names are unchanged.
      expect(r.body).toContain('name="entityName"');
      expect(r.body).toContain('name="service[0].serviceType"');
      expect(r.body).toContain('value="issuance"');
      expect(r.body).toContain('action="/onboarding/pid-provider"');
    } finally {
      await cleanup();
    }
  });

  it("isolates the Stoplight reference from the Credimi shell", async () => {
    const { url, cleanup } = await guiServer();
    try {
      const docs = await httpGet(`${url}/docs`);
      expect(docs.status).toBe(200);
      expect(docs.body).toContain("API Documentation");
      expect(docs.body).toContain("Wallet Provider and PID Provider LoTE API");
      expect(docs.body).toContain('src="/docs/reference"');
      expect(docs.body).toContain('href="/openapi.yaml"');
      // The embedded-reference caveat is gone: the reference always loads.
      expect(docs.body).not.toContain("If Stoplight cannot load");
      // The shell must not pull in any Stoplight asset.
      expect(docs.body).not.toContain("@stoplight/elements");

      const ref = await httpGet(`${url}/docs/reference`);
      expect(ref.status).toBe(200);
      expect(ref.body).toContain("<elements-api");
      expect(ref.body).toContain('apiDescriptionUrl="/openapi.yaml"');
      expect(ref.body).toContain('router="hash"');
      expect(ref.body).toContain('layout="sidebar"');
      // Stoplight is served from this origin, never from a CDN.
      expect(ref.body).toContain('src="/assets/stoplight-elements.min.js"');
      expect(ref.body).toContain('href="/assets/stoplight-elements.min.css"');
      expect(ref.body).not.toContain("unpkg.com");
      for (const asset of [
        "/assets/stoplight-elements.min.js",
        "/assets/stoplight-elements.min.css",
      ]) {
        const served = await httpGet(`${url}${asset}`);
        expect(served.status).toBe(200);
        expect(served.body.length).toBeGreaterThan(1000);
      }
      // Isolated document: no Credimi stylesheet, framed by this origin only.
      expect(ref.body).not.toContain("/assets/style.css");
      expect(ref.body).not.toContain("/assets/app.css");
      expect(ref.headers["x-frame-options"]).toBe("SAMEORIGIN");
    } finally {
      await cleanup();
    }
  });
});

describe("Admin username/password sign-in", () => {
  async function credentialServer() {
    const pubDir = tmpDir();
    const authDir = tmpDir();
    const sigConfigPath = createSigningConfig(tmpDir());
    const started = await startServer({
      publicationDir: pubDir,
      dataCollectionGui: true,
      authoringDir: authDir,
      adminToken: "shell",
      adminUser: "user_user",
      adminPassword: "admin_admin",
      signingConfigPath: sigConfigPath,
    });
    return {
      ...started,
      cleanup: async () => {
        await started.stop();
        for (const p of [pubDir, authDir, sigConfigPath]) {
          try {
            rmSync(p, { recursive: true, force: true });
          } catch {}
        }
      },
    };
  }

  it("asks for a username and password on /admin", async () => {
    const { url, cleanup } = await credentialServer();
    try {
      const r = await httpGet(`${url}/admin`);
      expect(r.status).toBe(403);
      expect(r.body).toContain("Username");
      expect(r.body).toContain("Password");
      expect(r.body).toContain('action="/admin/login"');
      expect(r.body).toContain('name="username"');
      expect(r.body).toContain('type="password"');
      // The admin content itself must not leak into the sign-in page.
      expect(r.body).not.toContain("Manage Applications");
    } finally {
      await cleanup();
    }
  });

  it("rejects wrong credentials and accepts the configured pair", async () => {
    const { url, cleanup } = await credentialServer();
    try {
      const bad = await httpPost(
        `${url}/admin/login`,
        new URLSearchParams({
          username: "user_user",
          password: "wrong",
        }).toString(),
      );
      expect(bad.status).toBe(403);
      expect(bad.body).toContain("Invalid username or password.");
      expect(bad.cookies.length).toBe(0);

      const good = await httpPost(
        `${url}/admin/login`,
        new URLSearchParams({
          username: "user_user",
          password: "admin_admin",
        }).toString(),
      );
      expect(good.status).toBe(303);
      expect(good.headers.location).toBe("/admin");
      const cookie = extractCookie(good.cookies);
      expect(cookie).toContain("tlp_admin_token=");

      const admin = await httpGet(`${url}/admin`, cookie);
      expect(admin.status).toBe(200);
      expect(admin.body).toContain("Manage Applications");
    } finally {
      await cleanup();
    }
  });

  it("returns to the originally requested admin page after sign-in", async () => {
    const { url, cleanup } = await credentialServer();
    try {
      const form = await httpGet(`${url}/admin/signing`);
      expect(form.body).toContain('value="/admin/signing"');

      const good = await httpPost(
        `${url}/admin/login`,
        new URLSearchParams({
          username: "user_user",
          password: "admin_admin",
          next: "/admin/signing",
        }).toString(),
      );
      expect(good.status).toBe(303);
      expect(good.headers.location).toBe("/admin/signing");
    } finally {
      await cleanup();
    }
  });

  it("does not honour an off-site next target", async () => {
    const { url, cleanup } = await credentialServer();
    try {
      const good = await httpPost(
        `${url}/admin/login`,
        new URLSearchParams({
          username: "user_user",
          password: "admin_admin",
          next: "https://evil.example/",
        }).toString(),
      );
      expect(good.status).toBe(303);
      expect(good.headers.location).toBe("/admin");
    } finally {
      await cleanup();
    }
  });

  it("keeps the token-only behaviour when no credentials are configured", async () => {
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
      expect(r.body).not.toContain('action="/admin/login"');

      const login = await httpPost(
        `${url}/admin/login`,
        new URLSearchParams({ username: "x", password: "y" }).toString(),
      );
      expect(login.status).toBe(403);
      expect(login.cookies.length).toBe(0);
    } finally {
      await stop();
      for (const p of [pubDir, authDir, sigConfigPath]) {
        try {
          rmSync(p, { recursive: true, force: true });
        } catch {}
      }
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
});
