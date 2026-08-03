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
): Promise<string> {
  const response = await post("/admin/trusted-lists/create", {
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
    allowedServiceProfiles: profiles,
  });
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
  );
  (globalThis as Record<string, unknown>).__qeaaList = await createList(
    "QEAA Scheme Operator",
    ["qeaa-providers"],
    qeaaSigner,
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

describe("XML Trusted List creation and publication visibility", () => {
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
    expect(html).toContain(
      `/api/v1/lists/${eaaList()}/versions/1/trusted-list.xml`,
    );
  });

  it("renders the list page with the standard and format labels", async () => {
    const html = await (await get(`/lists/${eaaList()}`)).text();
    expect(html).toContain("ETSI TS 119 612");
    expect(html).toContain("XML / XAdES-B-B");
    expect(html).toContain("latest/trusted-list.xml");
  });

  it("renders the version page with XML downloads and no JSON promise", async () => {
    const html = await (await get(`/lists/${eaaList()}/versions/1`)).text();
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
