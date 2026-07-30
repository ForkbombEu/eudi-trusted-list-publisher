import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { compileForProfile } from "../src/core/compile/compile.js";
import type { AuthoringInput } from "../src/core/model/authoring.js";
import { validateEtsiStruct } from "../src/core/validate/validate.js";
import {
  getEnabledProfile,
  getProfile,
  PROFILE_REGISTRY,
} from "../src/core/profiles/registry.js";
import {
  PID_PROVIDER_LOTE_TYPE,
  PID_PROVIDER_SCHEME_RULES,
  PID_PROVIDER_STATUS_DETN,
  PID_SERVICE_TYPE_ISSUANCE,
  PID_SERVICE_TYPE_REVOCATION,
} from "../src/core/profiles/pid-provider/constants.js";
import {
  SERVICE_TYPE_ISSUANCE,
  WALLET_PROVIDER_LOTE_TYPE,
} from "../src/core/profiles/wallet-provider/constants.js";
import {
  ApplicationService,
  AuthoringStore,
  getFamilyConfigs,
  loadSigningConfig,
  parseAndValidateSubmission,
  type SigningConfig,
} from "../src/core/authoring/index.js";
import {
  PublicationStore,
  loadVersionArtifacts,
} from "../src/core/publication/store.js";
import { createWebServer } from "../src/web/server.js";
import type { ServerConfig } from "../src/web/server.js";
import type { LoTEDocument } from "../src/core/model/types.js";

const TEST_CERT = readFileSync(
  resolve(import.meta.dirname, "fixtures", "test-cert.pem"),
  "utf-8",
);
/** Subject organisation of test-cert.pem; a submission must repeat it exactly. */
const CERT_ORGANISATION = "Test";
const TEST_KEY_PATH = resolve(import.meta.dirname, "fixtures", "test-key.pem");
const TEST_CERT_PATH = resolve(
  import.meta.dirname,
  "fixtures",
  "test-cert.pem",
);
const temporaryPaths: string[] = [];

function tmpDir(): string {
  const path = join(tmpdir(), `tlp-phase5-${randomBytes(8).toString("hex")}`);
  mkdirSync(path, { recursive: true });
  temporaryPaths.push(path);
  return path;
}

afterEach(() => {
  for (const path of temporaryPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function input(entities: AuthoringInput["entities"] = []): AuthoringInput {
  return {
    schemeOperator: {
      name: [{ lang: "en", value: "PID Authority" }],
      postalAddress: [
        { lang: "en", StreetAddress: "1 PID Way", Country: "DK" },
      ],
      electronicAddress: [
        { lang: "en", uriValue: "https://pid.example/contact" },
      ],
    },
    scheme: {
      schemeName: [{ lang: "en", value: "PID Providers" }],
      schemeTerritory: "EU",
      distributionPoints: ["https://pid.example/latest"],
    },
    listIssueDateTime: "2026-01-01T00:00:00Z",
    nextUpdate: "2026-06-30T00:00:00Z",
    loTESequenceNumber: 1,
    entities,
  };
}

function pidEntity(
  name: string,
  identifier: string,
): AuthoringInput["entities"][number] {
  return {
    teName: [{ lang: "en", value: name }],
    tePostalAddress: [
      { lang: "en", StreetAddress: "1 PID Way", Country: "DK" },
    ],
    teElectronicAddress: [
      { lang: "en", uriValue: "https://pid.example/contact" },
    ],
    teInformationURI: [{ lang: "en", uriValue: "https://pid.example" }],
    services: [
      {
        serviceTypeIdentifier: PID_SERVICE_TYPE_ISSUANCE,
        serviceName: [{ lang: "en", value: "PID issuance" }],
        serviceDigitalIdentity: { x509Certificates: [TEST_CERT] },
        serviceUniqueIdentifier: `${identifier}/issuance`,
      },
      {
        serviceTypeIdentifier: PID_SERVICE_TYPE_REVOCATION,
        serviceName: [{ lang: "en", value: "PID revocation" }],
        serviceDigitalIdentity: { x509Certificates: [TEST_CERT] },
        serviceUniqueIdentifier: `${identifier}/revocation`,
      },
    ],
  };
}

function signingEntry(
  listKey: string,
  family: "wallet-providers" | "pid-providers",
) {
  return {
    listKey,
    family,
    schemeOperatorName:
      family === "pid-providers" ? "PID Authority" : "Wallet Authority",
    schemeOperatorStreet: "1 Authority Way",
    schemeOperatorCountry: "DK",
    schemeName:
      family === "pid-providers" ? "PID Providers" : "Wallet Providers",
    schemeTerritory: "EU",
    schemeOperatorContactUri: "https://authority.example/contact",
    distributionPointUri: `https://authority.example/${listKey}/latest`,
    keyFile: TEST_KEY_PATH,
    certFile: TEST_CERT_PATH,
    schemeOperatorEmail: "operator@scheme.example",
    schemeOperatorWebsite: "https://scheme.example",
    schemeInformationUris: [
      "https://scheme.example/scheme",
      "https://scheme.example/practice-statement",
    ],
    policyUri: "https://scheme.example/policy",
  };
}

function pidFields(
  identifier: string,
  memberState = "DK",
  targetListKey = "eu_pid_authority",
): Record<string, string> {
  return {
    targetListKey,
    entityName: CERT_ORGANISATION,
    entityStreetAddress: "1 PID Way",
    entityCountry: "DK",
    entityInformationURI: "https://pid.example/provider",
    entityEmail: "trust@entity.example",
    entityTelephone: "+39 02 1234567",
    responsibleMemberState: memberState,
    "service[0].serviceType": "issuance",
    "service[0].serviceName": "PID issuance",
    "service[0].certificatePem": TEST_CERT,
    "service[0].serviceUniqueIdentifier": `${identifier}/issuance`,
  };
}

function walletFields(
  identifier: string,
  targetListKey = "wallet_list",
): Record<string, string> {
  const fields = pidFields(identifier);
  delete fields.responsibleMemberState;
  fields.targetListKey = targetListKey;
  return fields;
}

function createPidApplication(
  service: ApplicationService,
  identifier: string,
  targetListKey = "eu_pid_authority",
) {
  const parsed = parseAndValidateSubmission(
    pidFields(identifier, "DK", targetListKey),
    targetListKey,
    "pid-providers",
  );
  if (!parsed.valid)
    throw new Error(parsed.errors.map((error) => error.message).join(", "));
  return service.createApp(
    targetListKey,
    parsed.applicantData,
    "pid-providers",
  );
}

async function startServer(config: ServerConfig) {
  const server = createWebServer(config);
  await new Promise<void>((resolveStart, reject) => {
    server.listen(0, "127.0.0.1", resolveStart);
    server.on("error", reject);
  });
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    stop: () =>
      new Promise<void>((resolveStop) => server.close(() => resolveStop())),
  };
}

describe("Phase 5 PID Provider acceptance", () => {
  it("uses the enabled Annex D profile for empty and populated PID LoTEs", async () => {
    expect(getEnabledProfile("wallet-providers").enabled).toBe(true);
    expect(getEnabledProfile("pid-providers").enabled).toBe(true);
    expect(
      Object.values(PROFILE_REGISTRY).filter((profile) => !profile.enabled),
    ).toHaveLength(5);

    const profile = getProfile("pid-providers");
    expect(profile).toMatchObject({
      loTEType: PID_PROVIDER_LOTE_TYPE,
      statusDeterminationApproach: PID_PROVIDER_STATUS_DETN,
      schemeRules: PID_PROVIDER_SCHEME_RULES,
      maxNextUpdateMonths: 6,
      signatureProfile: "JAdES-Compact-B",
    });
    expect(profile.allowedServiceTypes).toEqual([
      PID_SERVICE_TYPE_ISSUANCE,
      PID_SERVICE_TYPE_REVOCATION,
    ]);

    const empty = compileForProfile("pid-providers", input()).document;
    const populated = compileForProfile(
      "pid-providers",
      input([pidEntity("PID One", "https://pid.example/one")]),
    ).document;
    expect(empty.LoTE.TrustedEntitiesList).toBeUndefined();
    expect(empty.LoTE.ListAndSchemeInformation.LoTEType).toBe(
      PID_PROVIDER_LOTE_TYPE,
    );
    expect(empty.LoTE.ListAndSchemeInformation.SchemeTerritory).toBe("EU");
    expect(populated.LoTE.ListAndSchemeInformation.LoTEType).not.toBe(
      WALLET_PROVIDER_LOTE_TYPE,
    );
    expect(
      populated.LoTE.TrustedEntitiesList?.[0]?.TrustedEntityServices.map(
        (service) => service.ServiceInformation.ServiceTypeIdentifier,
      ),
    ).toEqual([PID_SERVICE_TYPE_ISSUANCE, PID_SERVICE_TYPE_REVOCATION]);
    expect((await validateEtsiStruct(empty)).valid).toBe(true);
    expect((await validateEtsiStruct(populated)).valid).toBe(true);
    await expect(async () =>
      compileForProfile(
        "pid-providers",
        input([
          {
            ...pidEntity("Wrong family", "https://pid.example/wrong"),
            services: [
              {
                ...pidEntity("Wrong family", "https://pid.example/wrong")
                  .services[0]!,
                serviceTypeIdentifier: SERVICE_TYPE_ISSUANCE,
              },
            ],
          },
        ]),
      ),
    ).rejects.toThrow(/not allowed/);
  });

  it("parses, persists, transitions, and rejects malformed PID application records", () => {
    const authoringDir = tmpDir();
    const store = new AuthoringStore({ authoringDir });
    const service = new ApplicationService(
      store,
      new PublicationStore({ publicationDir: tmpDir() }),
    );
    const valid = parseAndValidateSubmission(
      pidFields("https://pid.example/persist"),
      "eu_pid_authority",
      "pid-providers",
    );
    const missing = parseAndValidateSubmission(
      pidFields("https://pid.example/missing", ""),
      "eu_pid_authority",
      "pid-providers",
    );
    const wallet = parseAndValidateSubmission(
      walletFields("https://wallet.example/no-pid"),
      "wallet_list",
      "wallet-providers",
    );
    expect(valid.valid && valid.applicantData.responsibleMemberState).toBe(
      "DK",
    );
    expect(missing.valid).toBe(false);
    expect(
      wallet.valid && "responsibleMemberState" in wallet.applicantData,
    ).toBe(false);

    if (!valid.valid) throw new Error("expected a valid PID submission");
    const pid = service.createApp(
      "eu_pid_authority",
      valid.applicantData,
      "pid-providers",
    );
    expect(service.listApplications()).toHaveLength(1);
    expect(service.approve(pid.id).success).toBe(true);
    expect(service.reject(pid.id, "not now").success).toBe(true);
    expect(service.deleteApplication(pid.id).success).toBe(true);

    const invalidId = randomUUID();
    writeFileSync(
      join(authoringDir, `${invalidId}.json`),
      JSON.stringify({
        id: invalidId,
        schemaVersion: 1,
        family: "pid-providers",
        targetListKey: "eu_pid_authority",
        state: "submitted",
        submittedAt: "2026-01-01T00:00:00Z",
        applicantData: {
          entityName: "Impossible PID",
          entityStreetAddress: "1 Way",
          entityCountry: "DK",
          entityInformationURI: "https://pid.example",
          entityEmail: "trust@entity.example",
          entityTelephone: "+39 02 1234567",
          services: [
            {
              serviceType: "issuance",
              serviceName: "PID",
              certificatePem: TEST_CERT,
              serviceUniqueIdentifier: "https://pid.example/impossible",
            },
          ],
        },
      }),
    );
    expect(store.load(invalidId)).toBeNull();
  });

  it("enforces family-qualified signing configuration and list separation", async () => {
    const configDir = tmpDir();
    const configPath = join(configDir, "signing.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        lists: [
          signingEntry("wallet_list", "wallet-providers"),
          signingEntry("eu_pid_authority", "pid-providers"),
          signingEntry("eu_pid_authority_two", "pid-providers"),
        ],
      }),
    );
    const config = loadSigningConfig(configPath);
    expect(
      getFamilyConfigs(config, "pid-providers").map((entry) => entry.listKey),
    ).toEqual(["eu_pid_authority", "eu_pid_authority_two"]);
    expect(
      getFamilyConfigs(config, "wallet-providers").map(
        (entry) => entry.listKey,
      ),
    ).toEqual(["wallet_list"]);
    for (const family of ["unknown", "qeaa-providers"]) {
      writeFileSync(
        configPath,
        JSON.stringify({
          lists: [{ ...signingEntry("bad_list", "pid-providers"), family }],
        }),
      );
      expect(() => loadSigningConfig(configPath)).toThrow();
    }
    writeFileSync(
      configPath,
      JSON.stringify({
        lists: [
          { ...signingEntry("duplicate", "wallet-providers") },
          { ...signingEntry("duplicate", "pid-providers") },
        ],
      }),
    );
    expect(() => loadSigningConfig(configPath)).toThrow(/Duplicate/);
    writeFileSync(
      configPath,
      JSON.stringify({
        lists: [
          { ...signingEntry("missing_family", "pid-providers"), family: "" },
        ],
      }),
    );
    expect(() => loadSigningConfig(configPath)).toThrow(/family/);

    const publicationStore = new PublicationStore({ publicationDir: tmpDir() });
    const authoringStore = new AuthoringStore({ authoringDir: tmpDir() });
    const service = new ApplicationService(authoringStore, publicationStore, {
      lists: [
        signingEntry("wallet_list", "wallet-providers"),
        signingEntry("eu_pid_authority", "pid-providers"),
      ],
    });
    const pid = createPidApplication(service, "https://pid.example/mismatch");
    const walletSubmission = parseAndValidateSubmission(
      walletFields("https://wallet.example/mismatch", "eu_pid_authority"),
      "eu_pid_authority",
      "wallet-providers",
    );
    if (!walletSubmission.valid)
      throw new Error("expected a valid Wallet submission");
    const wallet = service.createApp(
      "eu_pid_authority",
      walletSubmission.applicantData,
      "wallet-providers",
    );
    expect((await service.preparePublishInput(pid)).success).toBe(true);
    expect((await service.preparePublishInput(wallet)).success).toBe(false);
  });

  it("publishes PID applications cumulatively and refuses a Wallet LoTE under the PID key", async () => {
    const publicationStore = new PublicationStore({ publicationDir: tmpDir() });
    const authoringStore = new AuthoringStore({ authoringDir: tmpDir() });
    const config: SigningConfig = {
      lists: [signingEntry("eu_pid_authority", "pid-providers")],
    };
    const service = new ApplicationService(
      authoringStore,
      publicationStore,
      config,
    );
    const first = createPidApplication(service, "https://pid.example/first");
    const second = createPidApplication(service, "https://pid.example/second");
    expect(service.approve(first.id).success).toBe(true);
    const firstResult = await service.publishApplication(
      first.id,
      new Date("2026-08-01T00:00:00Z"),
    );
    expect(firstResult.success).toBe(true);
    if (!firstResult.success) throw new Error(firstResult.error);
    expect(service.approve(second.id).success).toBe(true);
    const secondResult = await service.publishApplication(
      second.id,
      new Date("2026-08-02T00:00:00Z"),
    );
    if (!secondResult.success) throw new Error(secondResult.error);
    expect(secondResult.success).toBe(true);
    expect(secondResult.data.publication?.sequenceNumber).toBe(2);
    const publishedSecond = service.getApplication(second.id);
    expect(publishedSecond?.family).toBe("pid-providers");
    if (!publishedSecond || publishedSecond.family !== "pid-providers")
      throw new Error("expected a published PID application");
    expect(publishedSecond.applicantData.responsibleMemberState).toBe("DK");
    const stored = await loadVersionArtifacts(
      publicationStore.publicationDir,
      "eu_pid_authority",
      2,
      10 * 1024 * 1024,
    );
    expect(stored.artifacts).not.toBeNull();
    if (!stored.artifacts) throw new Error(stored.diagnostic);
    const storedDocument = JSON.parse(
      stored.artifacts.loteJsonBytes,
    ) as LoTEDocument;
    expect(storedDocument.LoTE.ListAndSchemeInformation.LoTEType).toBe(
      PID_PROVIDER_LOTE_TYPE,
    );
    expect(storedDocument.LoTE.TrustedEntitiesList).toHaveLength(2);
    expect(
      storedDocument.LoTE.TrustedEntitiesList?.flatMap((entity) =>
        entity.TrustedEntityServices.map(
          (service) => service.ServiceInformation.ServiceTypeIdentifier,
        ),
      ),
    ).toContain(PID_SERVICE_TYPE_ISSUANCE);
    expect(stored.artifacts.manifest.signatureValid).toBe(true);
    expect(stored.artifacts.manifest.etsiSchemaValid).toBe(true);

    const walletStore = new PublicationStore({ publicationDir: tmpDir() });
    const walletAuthoring = new AuthoringStore({ authoringDir: tmpDir() });
    const walletService = new ApplicationService(walletAuthoring, walletStore, {
      lists: [signingEntry("eu_wallet_authority", "wallet-providers")],
    });
    const walletSubmission = parseAndValidateSubmission(
      walletFields("https://wallet.example/stored", "eu_wallet_authority"),
      "eu_wallet_authority",
      "wallet-providers",
    );
    if (!walletSubmission.valid)
      throw new Error("expected a Wallet submission");
    const wallet = walletService.createApp(
      "eu_wallet_authority",
      walletSubmission.applicantData,
      "wallet-providers",
    );
    expect(walletService.approve(wallet.id).success).toBe(true);
    expect(
      (
        await walletService.publishApplication(
          wallet.id,
          new Date("2026-08-01T00:00:00Z"),
        )
      ).success,
    ).toBe(true);
    const pidService = new ApplicationService(
      new AuthoringStore({ authoringDir: tmpDir() }),
      walletStore,
      { lists: [signingEntry("eu_wallet_authority", "pid-providers")] },
    );
    const conflictingPid = createPidApplication(
      pidService,
      "https://pid.example/conflict",
      "eu_wallet_authority",
    );
    expect((await pidService.preparePublishInput(conflictingPid)).success).toBe(
      false,
    );
  });

  it("completes the authenticated PID HTTP flow without rendering PID data for Wallet", async () => {
    const root = tmpDir();
    const configPath = join(root, "signing.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        lists: [
          signingEntry("eu_pid_authority", "pid-providers"),
          signingEntry("wallet_list", "wallet-providers"),
        ],
      }),
    );
    const server = await startServer({
      publicationDir: join(root, "publications"),
      authoringDir: join(root, "authoring"),
      signingConfigPath: configPath,
      dataCollectionGui: true,
      adminToken: "admin",
    });
    try {
      expect(
        (await fetch(`${server.url}/onboarding/pid-provider`)).status,
      ).toBe(200);
      const missing = await fetch(`${server.url}/onboarding/pid-provider`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(
          pidFields("https://pid.example/http-missing", ""),
        ).toString(),
      });
      expect(missing.status).toBe(400);
      expect(await missing.text()).toContain("Responsible Member State");

      const submitted = await fetch(`${server.url}/onboarding/pid-provider`, {
        method: "POST",
        redirect: "manual",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(
          pidFields("https://pid.example/http"),
        ).toString(),
      });
      expect(submitted.status).toBe(303);
      const appId = submitted.headers.get("location")?.split("/").pop();
      expect(appId).toBeTruthy();
      expect((await fetch(`${server.url}/admin`)).status).toBe(403);
      const login = await fetch(`${server.url}/admin?token=admin`, {
        redirect: "manual",
      });
      const cookie = login.headers.get("set-cookie")?.split(";")[0];
      expect(cookie).toBeTruthy();
      const detail = await fetch(`${server.url}/admin/applications/${appId}`, {
        headers: { Cookie: cookie! },
      });
      expect(await detail.text()).toContain("PID Providers");
      const approve = await fetch(
        `${server.url}/admin/applications/${appId}/approve`,
        { method: "POST", redirect: "manual", headers: { Cookie: cookie! } },
      );
      expect(approve.status).toBe(303);
      const approvedDetail = await fetch(
        `${server.url}/admin/applications/${appId}`,
        { headers: { Cookie: cookie! } },
      );
      const approvedHtml = await approvedDetail.text();
      expect(approvedHtml).toContain("Responsible Member State");
      expect(approvedHtml).toContain("Preview &mdash; Cumulative Publication");
      expect(approvedHtml).toContain("Publish");
      const published = await fetch(
        `${server.url}/admin/applications/${appId}/publish`,
        { method: "POST", redirect: "manual", headers: { Cookie: cookie! } },
      );
      expect(published.status).toBe(303);
      expect(published.headers.get("location")).toContain("success=");
      const lote = await fetch(
        `${server.url}/api/v1/lists/eu_pid_authority/versions/1/lote`,
      );
      expect(lote.status).toBe(200);
      expect(await lote.text()).toContain(PID_PROVIDER_LOTE_TYPE);

      const walletSubmitted = await fetch(
        `${server.url}/onboarding/wallet-provider`,
        {
          method: "POST",
          redirect: "manual",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams(
            walletFields("https://wallet.example/http"),
          ).toString(),
        },
      );
      const walletId = walletSubmitted.headers
        .get("location")
        ?.split("/")
        .pop();
      expect(walletSubmitted.status).toBe(303);
      expect(walletId).toBeTruthy();
      const walletDetail = await fetch(
        `${server.url}/admin/applications/${walletId}`,
        { headers: { Cookie: cookie! } },
      );
      expect(await walletDetail.text()).not.toContain(
        "Responsible Member State",
      );
    } finally {
      await server.stop();
    }
  });
});
