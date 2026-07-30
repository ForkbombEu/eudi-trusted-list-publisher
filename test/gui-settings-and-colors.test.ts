import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { createWebServer, type ServerConfig } from "../src/web/server.js";
import {
  familyChip,
  familyColorClass,
  listChip,
  listColorClass,
  LIST_SWATCH_COUNT,
} from "../src/web/views/colors.js";
import { adminSettingsHtml, adminIndexHtml } from "../src/web/views/admin.js";
import {
  SettingsStore,
  emptySettings,
} from "../src/core/authoring/settings-store.js";
import { walletProviderFormHtml } from "../src/web/views/onboarding.js";
import { LIST_FAMILIES } from "../src/core/authoring/list-family-catalogue.js";

const TEST_CERT = readFileSync(
  resolve(import.meta.dirname, "fixtures", "test-cert.pem"),
  "utf-8",
);

/** Subject organisation of test-cert.pem; a submission must repeat it exactly. */
const CERT_ORGANISATION = "Test";

function tmpDir(): string {
  const d = join(tmpdir(), "tlp-settings-" + randomBytes(8).toString("hex"));
  mkdirSync(d, { recursive: true });
  return d;
}

function request(
  url: string,
  options: { method?: string; body?: string; cookie?: string } = {},
): Promise<{
  status: number;
  body: string;
  headers: Record<string, string>;
}> {
  return new Promise((resolvePromise, reject) => {
    const u = new URL(url);
    const headers: Record<string, string> = {};
    if (options.cookie) headers["Cookie"] = options.cookie;
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      headers["Content-Length"] = String(Buffer.byteLength(options.body));
    }
    const http = require("node:http") as typeof import("node:http");
    const req = http.request(
      u,
      { method: options.method ?? "GET", headers },
      (res: IncomingMessage) => {
        let body = "";
        res.on("data", (chunk: Buffer) => (body += chunk.toString()));
        res.on("end", () =>
          resolvePromise({
            status: res.statusCode ?? 0,
            body,
            headers: res.headers as Record<string, string>,
          }),
        );
      },
    );
    req.on("error", reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

function startServer(
  config: ServerConfig,
): Promise<{ url: string; stop: () => Promise<void> }> {
  return new Promise((resolvePromise, reject) => {
    const server = createWebServer(config);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolvePromise({
        url: `http://127.0.0.1:${addr.port}`,
        stop: () => new Promise((r) => server.close(() => r())),
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
          schemeOperatorEmail: "operator@scheme.example",
          schemeOperatorWebsite: "https://scheme.example",
          schemeInformationUris: [
            "https://scheme.example/scheme",
            "https://scheme.example/practice-statement",
          ],
          policyUri: "https://scheme.example/policy",
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

function walletSubmission(uniqueId: string): string {
  return encodeForm({
    targetListKey: "eu_test_authority",
    entityName: CERT_ORGANISATION,
    entityStreetAddress: "1 Auto Street",
    entityCountry: "IT",
    entityInformationURI: "https://auto.example/info",
    entityEmail: "trust@entity.example",
    entityTelephone: "+39 02 1234567",
    "service[0].serviceType": "issuance",
    "service[0].serviceName": "Auto Issuance",
    "service[0].certificatePem": TEST_CERT,
    "service[0].serviceUniqueIdentifier": uniqueId,
  });
}

async function guiServer(adminToken: string) {
  const pubDir = tmpDir();
  const authDir = tmpDir();
  const sigDir = tmpDir();
  const started = await startServer({
    publicationDir: pubDir,
    dataCollectionGui: true,
    authoringDir: authDir,
    adminToken,
    signingConfigPath: createSigningConfig(sigDir),
  });
  return {
    ...started,
    authDir,
    cleanup: async () => {
      await started.stop();
      for (const p of [pubDir, authDir, sigDir]) {
        try {
          rmSync(p, { recursive: true, force: true });
        } catch {
          /* temporary directory already gone */
        }
      }
    },
  };
}

describe("Trusted List colour coding", () => {
  it("gives every family its own predefined colour class", () => {
    const classes = LIST_FAMILIES.map((f) => familyColorClass(f.key));
    expect(new Set(classes).size).toBe(LIST_FAMILIES.length);
    expect(classes).not.toContain("chip-family--unknown");
  });

  it("keeps a list key on the same swatch on every page", () => {
    expect(listColorClass("eu_credimi")).toBe(listColorClass("eu_credimi"));
    const index = Number(
      listColorClass("eu_credimi").replace("chip-list--", ""),
    );
    expect(index).toBeGreaterThanOrEqual(0);
    expect(index).toBeLessThan(LIST_SWATCH_COUNT);
  });

  it("escapes untrusted text inside chips", () => {
    expect(familyChip("wallet-providers", "<b>x</b>")).toContain("&lt;b&gt;x");
    expect(listChip('a"b')).toContain("a&quot;b");
  });

  it("declares every chip class it can emit in app.css", () => {
    const css = readFileSync(
      resolve(import.meta.dirname, "..", "src", "web", "assets", "app.css"),
      "utf-8",
    );
    for (const family of LIST_FAMILIES) {
      expect(css).toContain(`.${familyColorClass(family.key)} {`);
    }
    for (let i = 0; i < LIST_SWATCH_COUNT; i++) {
      expect(css).toContain(`.chip-list--${i} {`);
    }
  });
});

describe("Publisher settings store", () => {
  it("round-trips family and list auto-approve flags", () => {
    const dir = tmpDir();
    try {
      const store = new SettingsStore({ settingsDir: dir });
      expect(store.load()).toEqual(emptySettings());

      const settings = emptySettings();
      settings.autoApproveFamilies["wallet-providers"] = true;
      settings.autoApproveLists["eu_test_authority"] = true;
      store.save(settings);

      const loaded = new SettingsStore({ settingsDir: dir }).load();
      expect(loaded.autoApproveFamilies["wallet-providers"]).toBe(true);
      expect(loaded.autoApproveLists["eu_test_authority"]).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("drops unknown families and unsafe list keys instead of failing", () => {
    const dir = tmpDir();
    try {
      writeFileSync(
        join(dir, "settings.json"),
        JSON.stringify({
          schemaVersion: 1,
          autoApproveFamilies: { "not-a-family": true, "pid-providers": true },
          autoApproveLists: { "../escape": true, ok_list: true },
        }),
      );
      const loaded = new SettingsStore({ settingsDir: dir }).load();
      expect(loaded.autoApproveFamilies).toEqual({ "pid-providers": true });
      expect(loaded.autoApproveLists).toEqual({ ok_list: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("treats a family opt-in and a list opt-in as equivalent", () => {
    const dir = tmpDir();
    try {
      const store = new SettingsStore({ settingsDir: dir });
      const familyOnly = emptySettings();
      familyOnly.autoApproveFamilies["wallet-providers"] = true;
      store.save(familyOnly);
      expect(store.isAutoApprove("wallet-providers", "any_list")).toBe(true);
      expect(store.isAutoApprove("pid-providers", "any_list")).toBe(false);

      const listOnly = emptySettings();
      listOnly.autoApproveLists["one_list"] = true;
      store.save(listOnly);
      expect(store.isAutoApprove("pid-providers", "one_list")).toBe(true);
      expect(store.isAutoApprove("pid-providers", "other_list")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Administration settings page", () => {
  it("is reachable from the administration index", () => {
    expect(adminIndexHtml()).toContain('href="/admin/settings"');
    expect(adminIndexHtml()).toContain(">Settings</a>");
  });

  it("nests every configured list under its Trusted List Family", () => {
    const html = adminSettingsHtml(
      emptySettings(),
      {
        "wallet-providers": [
          {
            listKey: "eu_test_authority",
            schemeOperatorName: "Test Authority",
          },
        ],
      },
      false,
    );
    for (const family of LIST_FAMILIES) {
      expect(html).toContain(`name="family[${family.key}]"`);
    }
    expect(html).toContain('name="list[eu_test_authority]"');
    // Families with no implemented profile cannot receive applications.
    expect(html).toContain('name="family[registrars]" value="on" disabled');
  });

  it("reflects saved settings as checked boxes", () => {
    const settings = emptySettings();
    settings.autoApproveFamilies["wallet-providers"] = true;
    settings.autoApproveLists["eu_test_authority"] = true;
    const html = adminSettingsHtml(settings, {
      "wallet-providers": [
        { listKey: "eu_test_authority", schemeOperatorName: "Test Authority" },
      ],
    });
    expect(html).toContain(
      'name="family[wallet-providers]" value="on" checked',
    );
    expect(html).toContain('name="list[eu_test_authority]" value="on" checked');
  });

  it("saves the posted form and shows the stored state again", async () => {
    const gui = await guiServer("settings-token");
    const cookie = "tlp_admin_token=settings-token";
    try {
      const before = await request(`${gui.url}/admin/settings`, { cookie });
      expect(before.status).toBe(200);
      expect(before.body).toContain("Auto-approve all the applications");

      const saved = await request(`${gui.url}/admin/settings`, {
        method: "POST",
        cookie,
        body: encodeForm({ "list[eu_test_authority]": "on" }),
      });
      expect(saved.status).toBe(303);
      expect(saved.headers.location).toBe("/admin/settings?saved=1");

      const after = await request(`${gui.url}/admin/settings?saved=1`, {
        cookie,
      });
      expect(after.body).toContain("Settings saved.");
      expect(after.body).toContain(
        'name="list[eu_test_authority]" value="on" checked',
      );

      // An unchecked box is absent from the body and must turn the flag off.
      await request(`${gui.url}/admin/settings`, {
        method: "POST",
        cookie,
        body: "",
      });
      const cleared = await request(`${gui.url}/admin/settings`, { cookie });
      expect(cleared.body).not.toContain('value="on" checked');
    } finally {
      await gui.cleanup();
    }
  });

  it("refuses the settings pages without an admin session", async () => {
    const gui = await guiServer("settings-guard");
    try {
      expect((await request(`${gui.url}/admin/settings`)).status).toBe(403);
      expect(
        (
          await request(`${gui.url}/admin/settings`, {
            method: "POST",
            body: encodeForm({ "family[wallet-providers]": "on" }),
          })
        ).status,
      ).toBe(403);
    } finally {
      await gui.cleanup();
    }
  });
});

describe("Auto-approval of onboarding applications", () => {
  it("leaves applications in manual review when nothing is auto-approved", async () => {
    const gui = await guiServer("manual-token");
    try {
      const r = await request(`${gui.url}/onboarding/wallet-provider`, {
        method: "POST",
        body: walletSubmission("https://auto.example/svc/manual"),
      });
      expect(r.status).toBe(303);
      expect(r.headers.location).not.toContain("auto=");

      const page = await request(`${gui.url}${r.headers.location}`);
      expect(page.body).toContain("submitted");
      expect(page.body).toContain("An administrator will review");
    } finally {
      await gui.cleanup();
    }
  });

  it("approves and publishes immediately when the list is auto-approved", async () => {
    const gui = await guiServer("auto-token");
    const cookie = "tlp_admin_token=auto-token";
    try {
      const saved = await request(`${gui.url}/admin/settings`, {
        method: "POST",
        cookie,
        body: encodeForm({ "list[eu_test_authority]": "on" }),
      });
      expect(saved.status).toBe(303);

      const r = await request(`${gui.url}/onboarding/wallet-provider`, {
        method: "POST",
        body: walletSubmission("https://auto.example/svc/auto"),
      });
      expect(r.status).toBe(303);
      expect(r.headers.location).toContain("auto=published");

      const page = await request(`${gui.url}${r.headers.location}`);
      expect(page.body).toContain("published");
      expect(page.body).toContain("without administrator review");

      // The publication really happened: it is visible in the catalogue.
      const catalogue = await request(`${gui.url}/`);
      expect(catalogue.body).toContain("eu_test_authority");
    } finally {
      await gui.cleanup();
    }
  });

  it("publishes automatically when the whole family is auto-approved", async () => {
    const gui = await guiServer("auto-family");
    const cookie = "tlp_admin_token=auto-family";
    try {
      await request(`${gui.url}/admin/settings`, {
        method: "POST",
        cookie,
        body: encodeForm({ "family[wallet-providers]": "on" }),
      });
      const r = await request(`${gui.url}/onboarding/wallet-provider`, {
        method: "POST",
        body: walletSubmission("https://auto.example/svc/family"),
      });
      expect(r.headers.location).toContain("auto=published");
    } finally {
      await gui.cleanup();
    }
  });
});

describe("Onboarding service blocks", () => {
  it("numbers the first service and hides its remove button", () => {
    const html = walletProviderFormHtml({}, {}, []);
    expect(html).toContain(">Service 1</h3>");
    expect(html).toContain('class="btn btn-outline btn-sm service-remove"');
    expect(html).toMatch(/service-remove[\s\S]{0,140}hidden>/);
  });

  it("gives the second and later services a visible remove button", () => {
    const html = walletProviderFormHtml(
      {
        "service[0].serviceName": "first",
        "service[1].serviceName": "second",
      },
      {},
      [],
    );
    expect(html).toContain(">Service 1</h3>");
    expect(html).toContain(">Service 2</h3>");
    // Exactly one of the two remove buttons is hidden — the first block's.
    expect(html.match(/class="service-block card"/g)).toHaveLength(2);
    expect(html.match(/service-remove/g)?.length).toBeGreaterThanOrEqual(2);
    // Only the first block hides its remover; the button is a named action now.
    expect(html.match(/hidden>Remove service/g)).toHaveLength(1);
  });

  it("renumbers the blocks client-side after an add or a remove", () => {
    const html = walletProviderFormHtml({}, {}, []);
    expect(html).toContain("function renumber()");
    expect(html).toContain('"Service " + (i + 1)');
    expect(html).toContain("remove.hidden = i === 0");
  });

  it("labels the certificate as the service digital identity and explains it", () => {
    const html = walletProviderFormHtml({}, {}, []);
    expect(html).toContain("Service Digital Identity Certificate (PEM)");
    expect(html).not.toContain("Self-Signed Certificate (PEM)");
    expect(html).toContain("does not build or verify");
    expect(html).toContain("Never upload the private key.");
  });
});

describe("Catalogue copy", () => {
  it("invites browsing and drops the CLI publish hint", async () => {
    const pubDir = tmpDir();
    const started = await startServer({ publicationDir: pubDir });
    try {
      const r = await request(`${started.url}/`);
      expect(r.status).toBe(200);
      expect(r.body).toContain("Browse here EUDI Trusted lists");
      expect(r.body).toContain(
        "For testing\n        and debugging purposes only",
      );
      expect(r.body).not.toContain("trusted-list-publisher publish");
    } finally {
      await started.stop();
      rmSync(pubDir, { recursive: true, force: true });
    }
  });
});

describe("No testing-tool notices remain", () => {
  it("keeps the warning off every rendered GUI page", async () => {
    const gui = await guiServer("notice-token");
    const cookie = "tlp_admin_token=notice-token";
    try {
      for (const path of [
        "/",
        "/docs",
        "/onboarding",
        "/onboarding/wallet-provider",
        "/onboarding/pid-provider",
        "/admin",
        "/admin/applications",
        "/admin/signing",
        "/admin/settings",
      ]) {
        const r = await request(`${gui.url}${path}`, { cookie });
        expect(r.status).toBe(200);
        expect(r.body).not.toContain("Testing tool");
        expect(r.body).not.toContain("test-notice");
      }
    } finally {
      await gui.cleanup();
    }
  });
});
