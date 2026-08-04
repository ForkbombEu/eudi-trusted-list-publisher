import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createWebServer } from "../src/web/server.js";
import { verifyTrustedList } from "../src/core/tsl612/sign.js";
import { readTrustedList } from "../src/core/tsl612/read.js";
import {
  SVCSTATUS_DEPRECATED_AT_NATIONAL_LEVEL,
  SVCSTATUS_GRANTED,
  SVCSTATUS_RECOGNISED_AT_NATIONAL_LEVEL,
  SVCSTATUS_WITHDRAWN,
  SVCTYPE_EAA,
  SVCTYPE_QEAA,
  TSL_MEDIA_TYPE,
} from "../src/core/tsl612/constants.js";

const TOKEN = "xml-web-test-token";
const TERRITORY = "IT";

let root: string;
let baseUrl: string;
let stop: () => Promise<void>;
let signerCertDer: string;
let providerPem: string;

function generate(
  dir: string,
  name: string,
  organisation: string,
  extras = "",
): { keyFile: string; certFile: string; pem: string } {
  const keyPath = join(dir, `${name}.key`);
  const certPath = join(dir, `${name}.crt`);
  const configPath = join(dir, `${name}.cnf`);
  writeFileSync(
    configPath,
    `[req]\ndistinguished_name=dn\nprompt=no\n[dn]\nC=${TERRITORY}\nO=${organisation}\nCN=${name}\n[ext]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nsubjectKeyIdentifier=hash\n${extras}`,
  );
  execFileSync("openssl", [
    "genpkey",
    "-out",
    keyPath,
    "-algorithm",
    "EC",
    "-pkeyopt",
    "ec_paramgen_curve:P-256",
  ]);
  execFileSync("openssl", [
    "req",
    "-new",
    "-x509",
    "-key",
    keyPath,
    "-out",
    certPath,
    "-days",
    "365",
    "-config",
    configPath,
    "-extensions",
    "ext",
  ]);
  return {
    keyFile: keyPath,
    certFile: certPath,
    pem: readFileSync(certPath, "utf-8"),
  };
}

function derOf(pem: string): string {
  return Buffer.from(
    pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""),
    "base64",
  ).toString("base64");
}

async function get(path: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    headers: { Cookie: `tlp_admin_token=${TOKEN}` },
    redirect: "manual",
  });
}

async function post(
  path: string,
  fields: Record<string, string | string[]>,
  headers: Record<string, string> = {},
): Promise<Response> {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (Array.isArray(value)) for (const v of value) body.append(key, v);
    else body.append(key, value);
  }
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: `tlp_admin_token=${TOKEN}`,
      ...headers,
    },
    body: body.toString(),
    redirect: "manual",
  });
}

/** Creates one XML Trusted List through the real admin form. */
async function createList(
  operator: string,
  profiles: string[],
  material: { keyFile: string; certFile: string },
  distributionPointUri?: string,
  forwardedProto?: string,
): Promise<string> {
  const response = await post(
    "/admin/trusted-lists/create",
    {
      schemeOperatorName: operator,
      schemeTerritory: TERRITORY,
      schemeName: `${operator} Trusted List`,
      schemeOperatorStreet: "Via Roma 1",
      schemeOperatorLocality: "Roma",
      schemeOperatorPostalCode: "00100",
      schemeOperatorCountry: TERRITORY,
      schemeOperatorEmail: "op@example.it",
      schemeOperatorWebsite: "https://example.it",
      schemeInformationUri: "https://example.it/scheme",
      nationalSchemeRulesUri: "https://example.it/rules",
      policyUri: "https://example.it/policy",
      ...(distributionPointUri ? { distributionPointUri } : {}),
      lotlSchemeOperatorNames: operator,
      lotlCertificatesBase64Der: signerCertDer,
      keyFile: material.keyFile,
      certFile: material.certFile,
      allowedServiceProfiles: profiles,
    },
    forwardedProto ? { "X-Forwarded-Proto": forwardedProto } : {},
  );
  expect(response.status).toBe(303);
  const location = response.headers.get("location") ?? "";
  return location.replace("/lists/", "");
}

async function submit(
  route: string,
  listKey: string,
  overrides: Record<string, string> = {},
): Promise<void> {
  const response = await post(route, {
    listKey,
    tspName: "Example Provider SpA",
    registrationIdentifier: "12345678901",
    registrationIdentifierKind: "vat",
    streetAddress: "Via Milano 2",
    locality: "Milano",
    postalCode: "20121",
    countryName: "IT",
    email: "info@example.it",
    website: "https://provider.example.it",
    tspInformationUri: "https://provider.example.it/practices",
    serviceName: "Example Issuance",
    certificatePem: providerPem,
    evidence: "Decree 123/2026.",
    ...overrides,
  });
  expect(response.status).toBe(200);
}

/** The id of the single application the administration lists. */
async function applicationId(): Promise<string> {
  const html = await (await get("/admin/xml-applications")).text();
  const match = html.match(/\/admin\/xml-applications\/([0-9a-f-]{36})/);
  expect(match).not.toBeNull();
  return match![1]!;
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "tsl612-web-"));
  const materialDir = join(root, "material");
  writeFileSync(
    join(root, "signing-config.json"),
    JSON.stringify({ lists: [] }),
  );
  execFileSync("mkdir", ["-p", materialDir]);

  const eaaSigner = generate(materialDir, "eaa-signer", "EAA Scheme Operator");
  const qeaaSigner = generate(
    materialDir,
    "qeaa-signer",
    "QEAA Scheme Operator",
  );
  const combinedSigner = generate(
    materialDir,
    "combined-signer",
    "Combined Scheme Operator",
  );
  signerCertDer = derOf(eaaSigner.pem);
  providerPem = generate(materialDir, "provider", "Example Provider SpA").pem;

  const server = createWebServer({
    publicationDir: join(root, "publications"),
    authoringDir: join(root, "authoring"),
    signingConfigPath: join(root, "signing-config.json"),
    dataCollectionGui: true,
    adminToken: TOKEN,
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
  stop = () =>
    new Promise<void>((done) => {
      server.close(() => done());
    });

  /* Two lists: one accepting EAA only, one accepting QEAA only. */
  (globalThis as Record<string, unknown>).__eaaList = await createList(
    "EAA Scheme Operator",
    ["eaa-providers"],
    eaaSigner,
    undefined,
    "https",
  );
  (globalThis as Record<string, unknown>).__qeaaList = await createList(
    "QEAA Scheme Operator",
    ["qeaa-providers"],
    qeaaSigner,
    "https://explicit.example.it/qeaa/latest/trusted-list.xml",
  );
  (globalThis as Record<string, unknown>).__combinedList = await createList(
    "Combined Scheme Operator",
    ["eaa-providers", "qeaa-providers"],
    combinedSigner,
  );
}, 60000);

afterAll(async () => {
  if (stop) await stop();
  if (root) rmSync(root, { recursive: true, force: true });
});

const eaaList = (): string =>
  (globalThis as Record<string, unknown>).__eaaList as string;
const qeaaList = (): string =>
  (globalThis as Record<string, unknown>).__qeaaList as string;
const combinedList = (): string =>
  (globalThis as Record<string, unknown>).__combinedList as string;

describe("XML Trusted List creation and publication visibility", () => {
  it("prefixes the Trusted List Name and derives a stable latest URL", async () => {
    const xml = await (
      await get(`/lists/${eaaList()}/latest/trusted-list.xml`)
    ).text();
    const trustedList = readTrustedList(xml);

    expect(trustedList.schemeInformation.schemeName).toBe(
      `${TERRITORY}:EAA Scheme Operator Trusted List`,
    );
    expect(trustedList.schemeInformation.distributionPointUri).toBe(
      `${baseUrl.replace(/^http:/, "https:")}/lists/${eaaList()}/latest/trusted-list.xml`,
    );
  });

  it("preserves an explicitly entered stable XML distribution URL", async () => {
    const xml = await (
      await get(`/lists/${qeaaList()}/latest/trusted-list.xml`)
    ).text();
    expect(readTrustedList(xml).schemeInformation.distributionPointUri).toBe(
      "https://explicit.example.it/qeaa/latest/trusted-list.xml",
    );
  });

  it("creates a list whose version 1 is empty and signed", async () => {
    const response = await get(
      `/api/v1/lists/${eaaList()}/versions/1/trusted-list.xml`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(TSL_MEDIA_TYPE);
    const xml = await response.text();
    expect(xml).not.toContain("<TrustServiceProviderList>");
    expect(verifyTrustedList(xml).valid).toBe(true);
  });

  it("serves the .sha2 as the digest of the exact XML bytes", async () => {
    const xml = await (
      await get(`/api/v1/lists/${eaaList()}/versions/1/trusted-list.xml`)
    ).text();
    const sha2 = await (
      await get(`/api/v1/lists/${eaaList()}/versions/1/trusted-list.sha2`)
    ).text();
    expect(sha2).toBe(
      createHash("sha256").update(Buffer.from(xml, "utf-8")).digest("hex"),
    );
  });

  it("serves the stable latest URLs", async () => {
    const xml = await get(`/lists/${eaaList()}/latest/trusted-list.xml`);
    expect(xml.status).toBe(200);
    expect(xml.headers.get("content-type")).toBe(TSL_MEDIA_TYPE);
    const sha2 = await get(`/lists/${eaaList()}/latest/trusted-list.sha2`);
    expect(sha2.status).toBe(200);
    expect((await sha2.text()).trim()).toMatch(/^[0-9a-f]{64}$/);
  });

  it("shows the XML list in the Catalogue with an XML button", async () => {
    const html = await (await get("/")).text();
    expect(html).toContain(eaaList());
    expect(html).toContain(`/lists/${eaaList()}/versions/1/xml`);
    const view = await get(`/lists/${eaaList()}/versions/1/xml`);
    expect(view.status).toBe(200);
    expect(view.headers.get("content-type")).toContain("application/xml");
    expect(view.headers.get("content-disposition")).toBe("inline");
    expect(await view.text()).toContain("<TrustServiceStatusList");
  });

  it("shows every accepted profile on a combined XML Catalogue row", async () => {
    const html = await (await get("/")).text();
    const row = [...html.matchAll(/<tr(?: [^>]*)?>[\s\S]*?<\/tr>/g)]
      .map((match) => match[0])
      .find((candidate) => candidate.includes(`/lists/${combinedList()}`));

    expect(row).toBeDefined();
    /* The name is plain text in the colour of the first family it accepts. */
    expect(row).toContain(
      `<code class="list-name list-name--eaa">${combinedList()}</code>`,
    );
    expect(row).not.toContain("chip-list--");
    expect(row).toContain("chip-family--eaa");
    expect(row).toContain(">EAA Providers</span>");
    expect(row).toContain("chip-family--qeaa");
    expect(row).toContain(">QEAA Providers</span>");
    expect(row).toContain('class="chip-group"');
  });

  it("renders accepted profiles without repeating the list key as a chip", async () => {
    const html = await (await get(`/lists/${combinedList()}`)).text();
    expect(html).toContain("chip-family--eaa");
    expect(html).toContain("chip-family--qeaa");
    expect(html).not.toContain("chip-list--");
    expect(html).not.toContain("Allowed service profiles:");
    expect(html).toContain("ETSI TS 119 612");
    expect(html).toContain("XML / XAdES-B-B");
    expect(html).toContain("<th>Issue Date</th>");
    expect(html).toContain("<th>Next Update</th>");
    expect(html).toContain("<th>Signature</th>");
    expect(html).toContain("<th>Open</th>");
    expect(html).toContain(">XML</a>");
    expect(html).toContain(
      `target="_blank" rel="noopener noreferrer" href="/lists/${combinedList()}/versions/1/xml"`,
    );
    expect(html).toContain(
      "Trust not evaluated.</strong> Signatures are verified cryptographically but signer trust is not evaluated by this tool.",
    );
    expect(html).toContain('class="catalogue-table"');
    expect(html).not.toContain("<h2>Trusted List</h2>");
    expect(html).not.toContain("<h2>Versions</h2>");
  });

  it("aligns the XML version page with the shared heading and sections", async () => {
    const html = await (await get(`/lists/${eaaList()}/versions/1`)).text();
    expect(html).toContain(`<h1>${eaaList()} - Version 1</h1>`);
    expect(html).toContain("chip-family--eaa");
    expect(html).toContain("ETSI TS 119 612");
    expect(html).toContain("XML / XAdES-B-B");
    expect(html).toContain(
      "Trust not evaluated.</strong> Signatures are verified cryptographically but signer trust is not evaluated by this tool.",
    );
    expect(html).not.toContain("Allowed service profiles:");
    expect(html).toContain("List Information");
    expect(html).toContain("Signature &amp; Validation");
    expect(html).toContain("Signing Certificate");
    expect(html).toContain("Entities &amp; Services");
    expect(html).toContain("Artifact Hashes");
    expect(html).toContain("trusted-list.xml");
    expect(html).toContain("SHA-256 digest");
    expect(html).toContain("XAdES-B-B");
    expect(html).not.toContain("Compact JAdES");
  });

  it("serves the manifest and refuses the JSON-only artifacts", async () => {
    const manifest = await get(
      `/api/v1/lists/${eaaList()}/versions/1/manifest`,
    );
    expect(manifest.status).toBe(200);
    expect((await manifest.json()).standard).toBe("TS 119 612");
    expect(
      (await get(`/api/v1/lists/${eaaList()}/versions/1/lote`)).status,
    ).toBe(404);
    expect(
      (await get(`/api/v1/lists/${eaaList()}/versions/1/signature`)).status,
    ).toBe(404);
  });

  it("reports the list over the API as TS 119 612", async () => {
    const body = await (await get(`/api/v1/lists/${eaaList()}`)).json();
    expect(body.standard).toBe("TS 119 612");
    expect(body.versions[0].standard).toBe("TS 119 612");
  });

  it("refuses a list key that already exists", async () => {
    const response = await post("/admin/trusted-lists/create", {
      schemeOperatorName: "EAA Scheme Operator",
      schemeTerritory: TERRITORY,
      schemeName: "IT:EAA Scheme Operator",
      schemeOperatorStreet: "Via Roma 1",
      schemeOperatorLocality: "Roma",
      schemeOperatorCountry: TERRITORY,
      schemeOperatorEmail: "op@example.it",
      schemeOperatorWebsite: "https://example.it",
      schemeInformationUri: "https://example.it/scheme",
      nationalSchemeRulesUri: "https://example.it/rules",
      policyUri: "https://example.it/policy",
      distributionPointUri: "https://example.it/trusted-list.xml",
      lotlSchemeOperatorNames: "EAA Scheme Operator",
      lotlCertificatesBase64Der: signerCertDer,
      keyFile: "/nonexistent",
      certFile: "/nonexistent",
      allowedServiceProfiles: ["eaa-providers"],
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("already exists");
  });
});

describe("EAA and QEAA onboarding routes", () => {
  it("serves both onboarding forms", async () => {
    for (const route of [
      "/onboarding/eaa-provider",
      "/onboarding/qeaa-provider",
    ]) {
      const response = await get(route);
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("ETSI TS 119 612");
      expect(html).toContain("Scheme Territory");
    }
  });

  it("offers no onboarding card that leads to a 404", async () => {
    const html = await (await get("/onboarding")).text();
    const routes = [...html.matchAll(/href="(\/onboarding\/[a-z-]+)"/g)].map(
      (match) => match[1]!,
    );
    expect(routes.length).toBeGreaterThanOrEqual(7);
    for (const route of new Set(routes)) {
      expect((await get(route)).status).toBe(200);
    }
  });

  it("shows only the lists that accept the family", async () => {
    const eaaHtml = await (await get("/onboarding/eaa-provider")).text();
    expect(eaaHtml).toContain(eaaList());
    expect(eaaHtml).not.toContain(qeaaList());
    const qeaaHtml = await (await get("/onboarding/qeaa-provider")).text();
    expect(qeaaHtml).toContain(qeaaList());
    expect(qeaaHtml).not.toContain(eaaList());
  });

  it("rejects a QEAA submission aimed at an EAA-only list", async () => {
    const response = await post("/onboarding/qeaa-provider", {
      listKey: eaaList(),
      tspName: "Example Provider SpA",
      registrationIdentifier: "12345678901",
      registrationIdentifierKind: "vat",
      streetAddress: "Via Milano 2",
      locality: "Milano",
      countryName: "IT",
      email: "info@example.it",
      website: "https://provider.example.it",
      tspInformationUri: "https://provider.example.it/practices",
      serviceName: "Example Issuance",
      certificatePem: providerPem,
      evidence: "Decision 1/2026.",
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("does not accept");
  });
});

describe("a combined-profile XML list after onboarding", () => {
  it("preserves both allowed profiles and lists versions oldest first", async () => {
    await submit("/onboarding/eaa-provider", combinedList(), {
      serviceName: "Combined List EAA Issuance",
    });
    const id = await applicationId();
    expect(
      (await post(`/admin/xml-applications/${id}/approve`, {})).status,
    ).toBe(200);
    expect(
      (await post(`/admin/xml-applications/${id}/publish`, {})).status,
    ).toBe(200);

    const manifest = await (
      await get(`/api/v1/lists/${combinedList()}/versions/2/manifest`)
    ).json();
    expect(manifest.serviceProfiles.allowedServiceProfiles).toEqual([
      "eaa-providers",
      "qeaa-providers",
    ]);

    /* Simulate a version published before later publications preserved this
       list-level metadata. The UI must recover it from the immutable history. */
    const manifestPath = join(
      root,
      "publications",
      combinedList(),
      "versions",
      "2",
      "manifest.json",
    );
    const legacyManifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    legacyManifest.serviceProfiles.allowedServiceProfiles = [];
    writeFileSync(manifestPath, `${JSON.stringify(legacyManifest, null, 2)}\n`);

    const listHtml = await (await get(`/lists/${combinedList()}`)).text();
    expect(listHtml).toContain("chip-family--eaa");
    expect(listHtml).toContain("chip-family--qeaa");
    expect(listHtml).not.toContain("chip-list--");
    expect(listHtml).not.toContain("Allowed service profiles:");
    expect(listHtml.indexOf(`/versions/1`)).toBeLessThan(
      listHtml.indexOf(`/versions/2`),
    );

    const versionHtml = await (
      await get(`/lists/${combinedList()}/versions/2`)
    ).text();
    expect(versionHtml).toContain("Trust Service Provider Name (TSPName)");
    expect(versionHtml).toContain("Example Provider SpA");
    expect(versionHtml).toContain("Combined List EAA Issuance");
    expect(versionHtml).toContain(SVCTYPE_EAA);

    const catalogue = await (await get("/")).text();
    const row = [...catalogue.matchAll(/<tr(?: [^>]*)?>[\s\S]*?<\/tr>/g)]
      .map((match) => match[0])
      .find((candidate) => candidate.includes(`/lists/${combinedList()}`));
    expect(row).toContain("chip-family--eaa");
    expect(row).toContain("chip-family--qeaa");
  }, 60000);
});

describe("the full EAA lifecycle through the GUI", () => {
  it("submits, approves, publishes and then deprecates", async () => {
    await submit("/onboarding/eaa-provider", eaaList());
    const id = await applicationId();

    expect(
      (await post(`/admin/xml-applications/${id}/approve`, {})).status,
    ).toBe(200);
    const published = await post(`/admin/xml-applications/${id}/publish`, {});
    expect(published.status).toBe(200);

    const v2 = await (
      await get(`/api/v1/lists/${eaaList()}/versions/2/trusted-list.xml`)
    ).text();
    const service = readTrustedList(v2).providers![0]!.services[0]!;
    expect(service.serviceTypeIdentifier).toBe(SVCTYPE_EAA);
    expect(service.serviceStatus).toBe(SVCSTATUS_RECOGNISED_AT_NATIONAL_LEVEL);
    expect(verifyTrustedList(v2).valid).toBe(true);

    /* Deprecate: a new version, with the previous state in ServiceHistory. */
    const superseded = await post(
      `/admin/xml-applications/${id}/supersede`,
      {},
    );
    expect(superseded.status).toBe(200);

    const v3 = await (
      await get(`/api/v1/lists/${eaaList()}/versions/3/trusted-list.xml`)
    ).text();
    const v3Manifest = await (
      await get(`/api/v1/lists/${eaaList()}/versions/3/manifest`)
    ).json();
    expect(v3Manifest.serviceProfiles.allowedServiceProfiles).toEqual([
      "eaa-providers",
    ]);
    const deprecated = readTrustedList(v3).providers![0]!.services[0]!;
    expect(deprecated.serviceStatus).toBe(
      SVCSTATUS_DEPRECATED_AT_NATIONAL_LEVEL,
    );
    expect(deprecated.serviceHistory).toHaveLength(1);
    expect(deprecated.serviceHistory![0]!.serviceStatus).toBe(
      SVCSTATUS_RECOGNISED_AT_NATIONAL_LEVEL,
    );
    expect(
      deprecated.serviceHistory![0]!.digitalIdentity.x509SkiBase64,
    ).toBeTruthy();
    expect(
      deprecated.serviceHistory![0]!.digitalIdentity.x509CertificateBase64Der,
    ).toBeUndefined();
    expect(verifyTrustedList(v3).valid).toBe(true);

    /* Every earlier version is untouched and still verifies. */
    for (const sequence of [1, 2]) {
      const xml = await (
        await get(
          `/api/v1/lists/${eaaList()}/versions/${sequence}/trusted-list.xml`,
        )
      ).text();
      expect(verifyTrustedList(xml).valid).toBe(true);
    }
    const stillRecognised = readTrustedList(
      await (
        await get(`/api/v1/lists/${eaaList()}/versions/2/trusted-list.xml`)
      ).text(),
    ).providers![0]!.services[0]!;
    expect(stillRecognised.serviceStatus).toBe(
      SVCSTATUS_RECOGNISED_AT_NATIONAL_LEVEL,
    );
  }, 60000);
});

describe("the full QEAA lifecycle through the GUI", () => {
  it("submits, approves, publishes and then withdraws", async () => {
    await submit("/onboarding/qeaa-provider", qeaaList(), {
      serviceName: "Example QEAA Issuance",
    });
    const html = await (await get("/admin/xml-applications")).text();
    const ids = [
      ...html.matchAll(/\/admin\/xml-applications\/([0-9a-f-]{36})/g),
    ].map((match) => match[1]!);
    /* The newest application is the QEAA one; the store lists newest first. */
    const id = ids[0]!;

    expect(
      (await post(`/admin/xml-applications/${id}/approve`, {})).status,
    ).toBe(200);
    expect(
      (await post(`/admin/xml-applications/${id}/publish`, {})).status,
    ).toBe(200);

    const v2 = await (
      await get(`/api/v1/lists/${qeaaList()}/versions/2/trusted-list.xml`)
    ).text();
    const service = readTrustedList(v2).providers![0]!.services[0]!;
    expect(service.serviceTypeIdentifier).toBe(SVCTYPE_QEAA);
    expect(service.serviceStatus).toBe(SVCSTATUS_GRANTED);

    expect(
      (await post(`/admin/xml-applications/${id}/supersede`, {})).status,
    ).toBe(200);
    const v3 = await (
      await get(`/api/v1/lists/${qeaaList()}/versions/3/trusted-list.xml`)
    ).text();
    const withdrawn = readTrustedList(v3).providers![0]!.services[0]!;
    expect(withdrawn.serviceStatus).toBe(SVCSTATUS_WITHDRAWN);
    expect(withdrawn.serviceHistory![0]!.serviceStatus).toBe(SVCSTATUS_GRANTED);
    expect(verifyTrustedList(v3).valid).toBe(true);
  }, 60000);
});

describe("existing TS 119 602 routes are unaffected", () => {
  it("keeps serving the health check and the onboarding catalogue", async () => {
    expect((await get("/healthz")).status).toBe(200);
    const onboarding = await get("/onboarding");
    expect(onboarding.status).toBe(200);
    const html = await onboarding.text();
    expect(html).toContain("PID Providers");
    expect(html).toContain("EAA Providers");
    expect(html).toContain("QEAA Providers");
  });

  it("serves the administration dashboard with both standards", async () => {
    const html = await (await get("/admin")).text();
    expect(html).toContain("/admin/lists/create");
    expect(html).toContain("/admin/trusted-lists/create");
    expect(html).toContain("/admin/xml-applications");
  });
});

// ============================================================
// Intentionally broken XML fixtures, over real HTTP
// ============================================================
describe("intentionally broken XML Trusted Lists", () => {
  /**
   * The same declaration, sent twice: once as the administration form posts it
   * and once as the API takes it. Acceptance requires the GUI and the API to
   * produce equivalent fixtures, so they are compared rather than assumed
   * equal — they are two code paths into one core function, and only a test
   * keeps them one.
   */
  const declaration = (
    operator: string,
    material: { keyFile: string; certFile: string },
  ) => ({
    schemeOperatorName: operator,
    schemeTerritory: TERRITORY,
    schemeName: `${TERRITORY}:${operator}`,
    schemeOperatorStreet: "Via Roma 1",
    schemeOperatorLocality: "Roma",
    schemeOperatorPostalCode: "00100",
    schemeOperatorCountry: TERRITORY,
    schemeOperatorEmail: "op@example.it",
    schemeOperatorWebsite: "https://example.it",
    schemeInformationUri: "https://example.it/scheme",
    nationalSchemeRulesUri: "https://example.it/rules",
    policyUri: "https://example.it/policy",
    distributionPointUri: "https://example.it/trusted-list.xml",
    lotlSchemeOperatorNames: operator,
    lotlCertificatesBase64Der: signerCertDer,
    keyFile: material.keyFile,
    certFile: material.certFile,
    allowedServiceProfiles: ["eaa-providers"],
  });

  let guiKey: string;
  let apiKey: string;

  it("offers every catalogue defect on the creation form", async () => {
    const html = await (await get("/admin/trusted-lists/create")).text();
    expect(html).toContain("Intentionally broken test fixture");
    for (const id of [
      "invalid_tsl_namespace",
      "invalid_tsl_version_identifier",
      "expired_next_update",
      "incorrect_service_type",
      "incorrect_service_status",
      "invalid_service_history",
      "broken_xades_signature",
      "incorrect_signing_certificate",
      "incorrect_sha2_digest",
    ])
      expect(html).toContain(`value="${id}"`);
  });

  it("creates a broken list from the form and confirms what broke", async () => {
    const material = generate(
      join(root, "material"),
      "broken-gui",
      "Broken GUI Operator",
    );
    const response = await post("/admin/trusted-lists/create", {
      ...declaration("Broken GUI Operator", material),
      defects: ["expired_next_update"],
    });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Intentionally broken Trusted List created");
    expect(html).toContain("expired_next_update");
    expect(html).toContain("local.freshness");
    guiKey = "it_broken_gui_operator";
  }, 60000);

  it("creates the same list from the API", async () => {
    const material = generate(
      join(root, "material"),
      "broken-api",
      "Broken API Operator",
    );
    const response = await fetch(`${baseUrl}/api/v1/admin/trusted-lists`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({
        ...declaration("Broken API Operator", material),
        allowedServiceProfiles: ["eaa-providers"],
        lotlCertificatesBase64Der: [signerCertDer],
        lotlSchemeOperatorNames: ["Broken API Operator"],
        defects: ["expired_next_update"],
      }),
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      listKey: string;
      standard: string;
      artifactFormat: string;
      intentionallyBroken: boolean;
      fixture: { selectedDefects: string[] };
    };
    expect(body.standard).toBe("TS 119 612");
    expect(body.artifactFormat).toBe("XML / XAdES-B-B");
    expect(body.intentionallyBroken).toBe(true);
    expect(body.fixture.selectedDefects).toEqual(["expired_next_update"]);
    apiKey = body.listKey;
  }, 60000);

  it("produces equivalent fixture metadata from the GUI and the API", async () => {
    const read = async (key: string) => {
      const response = await get(
        `/api/v1/lists/${key}/versions/1/fixture?view=1`,
      );
      expect(response.status).toBe(200);
      return (await response.json()) as Record<string, unknown>;
    };
    const gui = await read(guiKey);
    const api = await read(apiKey);
    for (const field of [
      "fixtureMode",
      "standard",
      "artifactFormat",
      "selectedDefects",
      "expectedFailures",
      "matchedLocalFailures",
      "missingLocalFailures",
    ])
      expect(api[field]).toEqual(gui[field]);
  });

  it("refuses a defect the XML engine cannot perform", async () => {
    const material = generate(
      join(root, "material"),
      "broken-unknown",
      "Broken Unknown Operator",
    );
    const response = await post("/admin/trusted-lists/create", {
      ...declaration("Broken Unknown Operator", material),
      defects: ["jades_without_signing_time"],
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Unknown TS 119 612 defect");
  });

  it("marks the broken list in the catalogue and on its pages", async () => {
    const catalogue = await (await get("/")).text();
    expect(catalogue).toContain("catalogue-row-broken");
    expect(catalogue).toContain("Expired NextUpdate");

    const list = await (await get(`/lists/${guiKey}`)).text();
    expect(list).toContain("Intentionally broken test fixture");
    expect(list).toContain("Expired NextUpdate");

    const version = await (await get(`/lists/${guiKey}/versions/1`)).text();
    expect(version).toContain("Negative fixture");
    expect(version).toContain("Expected local failures");
    expect(version).toContain("local.freshness");
    expect(version).toContain("before signing");
    expect(version).toContain("ETSI TS 119 612");
    expect(version).toContain("XML / XAdES-B-B");
  });

  it("still serves the broken artifact and its digest", async () => {
    const xml = await get(
      `/api/v1/lists/${guiKey}/versions/1/trusted-list.xml`,
    );
    expect(xml.status).toBe(200);
    expect(xml.headers.get("content-type")).toBe(TSL_MEDIA_TYPE);
    const sha2 = await get(
      `/api/v1/lists/${guiKey}/versions/1/trusted-list.sha2`,
    );
    expect(sha2.status).toBe(200);
    expect((await sha2.text()).trim()).toBe(
      createHash("sha256")
        .update(await xml.text(), "utf-8")
        .digest("hex"),
    );
  });

  it("has no fixture metadata for a healthy list", async () => {
    const response = await get(`/api/v1/lists/${eaaList()}/versions/1/fixture`);
    expect(response.status).toBe(404);
  });
});
