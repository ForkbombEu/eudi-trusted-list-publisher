import { beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TrustedListStore } from "../src/core/publication/tsl-store.js";
import { PublicationStore } from "../src/core/publication/store.js";
import { PublicationReader } from "../src/core/publication/reader.js";
import { TslApplicationStore } from "../src/core/tsl612/authoring/application-store.js";
import { TslApplicationService } from "../src/core/tsl612/authoring/application-service.js";
import { parseTslSubmission } from "../src/core/tsl612/authoring/submission-parser.js";
import { formattedRegistrationIdentifier } from "../src/core/tsl612/authoring/application-model.js";
import { readTrustedList } from "../src/core/tsl612/read.js";
import { verifyTrustedList } from "../src/core/tsl612/sign.js";
import {
  defaultLotlPointer,
  type TrustedListConfigEntry,
} from "../src/core/tsl612/list-config.js";
import {
  SVCSTATUS_DEPRECATED_AT_NATIONAL_LEVEL,
  SVCSTATUS_GRANTED,
  SVCSTATUS_RECOGNISED_AT_NATIONAL_LEVEL,
  SVCSTATUS_WITHDRAWN,
  SVCTYPE_EAA,
  SVCTYPE_QEAA,
} from "../src/core/tsl612/constants.js";

const TERRITORY = "IT";
const OPERATOR = "Authoring Test Operator";
const EAA_LIST = "it_authoring_test_operator";
const QEAA_LIST = "it_authoring_test_operator_q";

let material: string;
let signerKey: string;
let signerCert: string;
/** The provider's service certificate: subject O equals the TSP legal name. */
let providerCert: string;
/** A certificate whose subject O deliberately differs from the TSP name. */
let mismatchedCert: string;

function generate(
  dir: string,
  name: string,
  organisation: string,
): {
  key: string;
  certificate: string;
} {
  const keyPath = join(dir, `${name}.key`);
  const certPath = join(dir, `${name}.crt`);
  const configPath = join(dir, `${name}.cnf`);
  writeFileSync(
    configPath,
    `[req]\ndistinguished_name=dn\nprompt=no\n[dn]\nC=${TERRITORY}\nO=${organisation}\nCN=${name}\n[ext]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nsubjectKeyIdentifier=hash\n`,
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
    key: readFileSync(keyPath, "utf-8"),
    certificate: readFileSync(certPath, "utf-8"),
  };
}

beforeAll(() => {
  material = mkdtempSync(join(tmpdir(), "tsl612-authoring-material-"));
  const signer = generate(material, "signer", OPERATOR);
  signerKey = signer.key;
  signerCert = signer.certificate;
  providerCert = generate(
    material,
    "provider",
    "Example Provider SpA",
  ).certificate;
  mismatchedCert = generate(
    material,
    "other",
    "Different Legal Entity",
  ).certificate;
});

function listConfig(
  listKey: string,
  profiles: readonly string[],
  keyFile: string,
  certFile: string,
): TrustedListConfigEntry {
  return {
    standard: "TS 119 612",
    listKey,
    schemeOperatorName: OPERATOR,
    schemeOperatorStreet: "Via Roma 1",
    schemeOperatorLocality: "Roma",
    schemeOperatorPostalCode: "00100",
    schemeOperatorCountry: TERRITORY,
    schemeOperatorEmail: "op@example.it",
    schemeOperatorWebsite: "https://example.it",
    schemeName: `${TERRITORY}:${OPERATOR}`,
    schemeTerritory: TERRITORY,
    schemeInformationUri: "https://example.it/scheme",
    nationalSchemeRulesUri: "https://example.it/rules",
    policyUri: "https://example.it/policy",
    distributionPointUri: `https://example.it/${listKey}/trusted-list.xml`,
    lotlPointer: defaultLotlPointer(
      [
        Buffer.from(
          signerCert.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""),
          "base64",
        ).toString("base64"),
      ],
      [OPERATOR],
    ),
    keyFile,
    certFile,
    allowedServiceProfiles:
      profiles as TrustedListConfigEntry["allowedServiceProfiles"],
  };
}

interface Harness {
  readonly root: string;
  readonly store: TrustedListStore;
  readonly service: TslApplicationService;
  readonly reader: PublicationReader;
  readonly configs: Map<string, TrustedListConfigEntry>;
}

function harness(): Harness {
  const root = mkdtempSync(join(tmpdir(), "tsl612-authoring-"));
  const publications = join(root, "publications");
  const applications = join(root, "applications");
  const keyFile = join(root, "signing.key");
  const certFile = join(root, "signing.crt");
  writeFileSync(keyFile, signerKey);
  writeFileSync(certFile, signerCert);

  const configs = new Map<string, TrustedListConfigEntry>([
    [EAA_LIST, listConfig(EAA_LIST, ["eaa-providers"], keyFile, certFile)],
    [QEAA_LIST, listConfig(QEAA_LIST, ["qeaa-providers"], keyFile, certFile)],
  ]);
  const store = new TrustedListStore({ publicationDir: publications });
  const service = new TslApplicationService({
    applications: new TslApplicationStore({ applicationsDir: applications }),
    store,
    trustedListConfig: (listKey) => configs.get(listKey),
  });
  const reader = new PublicationReader(
    new PublicationStore({ publicationDir: publications }),
    store,
  );
  return { root, store, service, reader, configs };
}

function body(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    listKey: EAA_LIST,
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
    serviceName: "Example EAA Issuance",
    certificatePem: providerCert,
    evidence: "Decree 123/2026 recognises this provider at national level.",
    ...overrides,
  };
}

function parse(
  overrides: Record<string, string> = {},
  family: "eaa-providers" | "qeaa-providers" = "eaa-providers",
  configs?: Map<string, TrustedListConfigEntry>,
) {
  const map =
    configs ??
    new Map<string, TrustedListConfigEntry>([
      [EAA_LIST, listConfig(EAA_LIST, ["eaa-providers"], "k", "c")],
      [QEAA_LIST, listConfig(QEAA_LIST, ["qeaa-providers"], "k", "c")],
    ]);
  return parseTslSubmission(body(overrides), {
    family,
    trustedLists: [...map.values()],
    submittedAt: "2026-08-03T10:00:00Z",
  });
}

describe("registration identifier formatting", () => {
  it("uses VATCC- for a VAT identifier and NTRCC- otherwise", () => {
    expect(formattedRegistrationIdentifier("12345678901", "vat", "IT")).toBe(
      "VATIT-12345678901",
    );
    expect(formattedRegistrationIdentifier("REA-MI-1", "national", "IT")).toBe(
      "NTRIT-REA-MI-1",
    );
  });

  it("does not double a prefix the applicant already typed", () => {
    expect(
      formattedRegistrationIdentifier("VATIT-12345678901", "vat", "IT"),
    ).toBe("VATIT-12345678901");
  });
});

describe("submission parser", () => {
  it("accepts a complete EAA submission", () => {
    const result = parse();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.family).toBe("eaa-providers");
      expect(result.value.listKey).toBe(EAA_LIST);
      expect(result.value.evidence).toContain("Decree 123/2026");
    }
  });

  it("refuses a family the target list does not accept", () => {
    const result = parse({ listKey: EAA_LIST }, "qeaa-providers");
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.errors.map((e) => e.field)).toContain("listKey");
  });

  it("refuses a list key that is not configured", () => {
    const result = parse({ listKey: "no_such_list" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.message).toContain("no_such_list");
  });

  it("never takes a country for the list from the applicant", () => {
    const result = parse({ schemeTerritory: "FR" } as Record<string, string>);
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.errors.map((e) => e.field)).toContain("schemeTerritory");
  });

  it("requires evidence, and words it for the family", () => {
    const eaa = parse({ evidence: "" });
    expect(eaa.ok).toBe(false);
    if (!eaa.ok)
      expect(eaa.errors.find((e) => e.field === "evidence")?.message).toContain(
        "national recognition",
      );
    const qeaa = parse({ listKey: QEAA_LIST, evidence: "" }, "qeaa-providers");
    expect(qeaa.ok).toBe(false);
    if (!qeaa.ok)
      expect(
        qeaa.errors.find((e) => e.field === "evidence")?.message,
      ).toContain("qualified status");
  });

  it("rejects a private key pasted into the certificate field", () => {
    const result = parse({
      certificatePem:
        "-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----",
    });
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.errors.map((e) => e.field)).toContain("certificatePem");
  });

  it("requires a trade name and a scheme service definition URI when the subject differs", () => {
    const result = parse({ certificatePem: mismatchedCert });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const fields = result.errors.map((e) => e.field);
      expect(fields).toContain("tradeName");
      expect(fields).toContain("schemeServiceDefinitionUri");
    }
  });

  it("accepts a differing subject when both are supplied", () => {
    const result = parse({
      certificatePem: mismatchedCert,
      tradeName: "Different Legal Entity",
      schemeServiceDefinitionUri: "https://example.it/relationship",
    });
    expect(result.ok).toBe(true);
  });

  it("rejects an unknown field rather than ignoring it", () => {
    const result = parse({ surprise: "value" } as Record<string, string>);
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.errors.map((e) => e.field)).toContain("surprise");
  });
});

describe("publication lifecycle", () => {
  async function publishOne(
    h: Harness,
    family: "eaa-providers" | "qeaa-providers",
    listKey: string,
  ) {
    const parsed = parseTslSubmission(body({ listKey }), {
      family,
      trustedLists: [...h.configs.values()],
      submittedAt: "2026-08-03T10:00:00Z",
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("submission rejected");
    const record = h.service.submit(parsed.value);
    expect(h.service.approve(record.id).ok).toBe(true);
    const published = await h.service.publish(record.id);
    expect(published.ok).toBe(true);
    return record;
  }

  it("publishes an EAA provider as recognised at national level", async () => {
    const h = harness();
    try {
      await publishOne(h, "eaa-providers", EAA_LIST);
      const latest = h.store.loadLatest(EAA_LIST)!;
      expect(latest.sequenceNumber).toBe(1);
      const list = readTrustedList(latest.artifacts.xml);
      const service = list.providers![0]!.services[0]!;
      expect(service.serviceTypeIdentifier).toBe(SVCTYPE_EAA);
      expect(service.serviceStatus).toBe(
        SVCSTATUS_RECOGNISED_AT_NATIONAL_LEVEL,
      );
      expect(verifyTrustedList(latest.artifacts.xml).valid).toBe(true);
    } finally {
      rmSync(h.root, { recursive: true, force: true });
    }
  });

  it("publishes a QEAA provider as granted", async () => {
    const h = harness();
    try {
      await publishOne(h, "qeaa-providers", QEAA_LIST);
      const latest = h.store.loadLatest(QEAA_LIST)!;
      const service = readTrustedList(latest.artifacts.xml).providers![0]!
        .services[0]!;
      expect(service.serviceTypeIdentifier).toBe(SVCTYPE_QEAA);
      expect(service.serviceStatus).toBe(SVCSTATUS_GRANTED);
    } finally {
      rmSync(h.root, { recursive: true, force: true });
    }
  });

  it("publishes the registration identifier as a TSP trade name", async () => {
    const h = harness();
    try {
      await publishOne(h, "eaa-providers", EAA_LIST);
      const latest = h.store.loadLatest(EAA_LIST)!;
      expect(latest.artifacts.xml).toContain("VATIT-12345678901");
    } finally {
      rmSync(h.root, { recursive: true, force: true });
    }
  });

  it("never publishes the review evidence", async () => {
    const h = harness();
    try {
      await publishOne(h, "eaa-providers", EAA_LIST);
      const latest = h.store.loadLatest(EAA_LIST)!;
      expect(latest.artifacts.xml).not.toContain("Decree 123/2026");
    } finally {
      rmSync(h.root, { recursive: true, force: true });
    }
  });

  it("previews the cumulative shape before publishing", async () => {
    const h = harness();
    try {
      const parsed = parseTslSubmission(body(), {
        family: "eaa-providers",
        trustedLists: [...h.configs.values()],
        submittedAt: "2026-08-03T10:00:00Z",
      });
      if (!parsed.ok) throw new Error("rejected");
      const record = h.service.submit(parsed.value);
      const preview = h.service.preview(record.id);
      expect(preview.value).toMatchObject({
        currentSequence: null,
        proposedSequence: 1,
        existingProviders: 0,
        resultingProviders: 1,
      });
    } finally {
      rmSync(h.root, { recursive: true, force: true });
    }
  });

  it("preserves an existing provider and its status time on republication", async () => {
    const h = harness();
    try {
      await publishOne(h, "eaa-providers", EAA_LIST);
      const first = readTrustedList(
        h.store.loadLatest(EAA_LIST)!.artifacts.xml,
      );
      const firstTime = first.providers![0]!.services[0]!.statusStartingTime;

      /* A second provider, with its own key, joins the same list. */
      const second = generate(material, "second", "Second Provider SpA");
      const parsed = parseTslSubmission(
        body({
          tspName: "Second Provider SpA",
          certificatePem: second.certificate,
          serviceName: "Second EAA Issuance",
          registrationIdentifier: "99999999999",
        }),
        {
          family: "eaa-providers",
          trustedLists: [...h.configs.values()],
          submittedAt: "2026-08-03T11:00:00Z",
        },
      );
      if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
      const record = h.service.submit(parsed.value);
      h.service.approve(record.id);
      expect((await h.service.publish(record.id)).ok).toBe(true);

      const latest = h.store.loadLatest(EAA_LIST)!;
      expect(latest.sequenceNumber).toBe(2);
      const providers = readTrustedList(latest.artifacts.xml).providers!;
      expect(providers).toHaveLength(2);
      /* Ordinary republication preserves StatusStartingTime. */
      expect(providers[0]!.services[0]!.statusStartingTime).toBe(firstTime);
      /* Version 1 is untouched. */
      const v1 = h.store.loadVersion(EAA_LIST, 1).artifacts!;
      expect(readTrustedList(v1.xml).providers).toHaveLength(1);
      expect(verifyTrustedList(v1.xml).valid).toBe(true);
    } finally {
      rmSync(h.root, { recursive: true, force: true });
    }
  });

  it("refuses to publish the same service twice", async () => {
    const h = harness();
    try {
      await publishOne(h, "eaa-providers", EAA_LIST);
      const parsed = parseTslSubmission(body(), {
        family: "eaa-providers",
        trustedLists: [...h.configs.values()],
        submittedAt: "2026-08-03T12:00:00Z",
      });
      if (!parsed.ok) throw new Error("rejected");
      const duplicate = h.service.submit(parsed.value);
      h.service.approve(duplicate.id);
      const result = await h.service.publish(duplicate.id);
      expect(result.ok).toBe(false);
      if (!result.ok && "code" in result) expect(result.code).toBe("DUPLICATE");
    } finally {
      rmSync(h.root, { recursive: true, force: true });
    }
  });

  it("deprecates an EAA service into ServiceHistory", async () => {
    const h = harness();
    try {
      const record = await publishOne(h, "eaa-providers", EAA_LIST);
      const result = await h.service.supersede(record.id);
      expect(result.ok).toBe(true);

      const latest = h.store.loadLatest(EAA_LIST)!;
      expect(latest.sequenceNumber).toBe(2);
      const service = readTrustedList(latest.artifacts.xml).providers![0]!
        .services[0]!;
      expect(service.serviceStatus).toBe(
        SVCSTATUS_DEPRECATED_AT_NATIONAL_LEVEL,
      );
      expect(service.serviceHistory).toHaveLength(1);
      const history = service.serviceHistory![0]!;
      expect(history.serviceStatus).toBe(
        SVCSTATUS_RECOGNISED_AT_NATIONAL_LEVEL,
      );
      expect(history.serviceTypeIdentifier).toBe(SVCTYPE_EAA);
      expect(history.digitalIdentity.x509SkiBase64).toBeTruthy();
      expect(history.digitalIdentity.x509CertificateBase64Der).toBeUndefined();

      /* Version 1 still lists the service as recognised. */
      const v1 = h.store.loadVersion(EAA_LIST, 1).artifacts!;
      expect(
        readTrustedList(v1.xml).providers![0]!.services[0]!.serviceStatus,
      ).toBe(SVCSTATUS_RECOGNISED_AT_NATIONAL_LEVEL);
      expect(verifyTrustedList(v1.xml).valid).toBe(true);
      expect(verifyTrustedList(latest.artifacts.xml).valid).toBe(true);
    } finally {
      rmSync(h.root, { recursive: true, force: true });
    }
  });

  it("withdraws a QEAA service into ServiceHistory", async () => {
    const h = harness();
    try {
      const record = await publishOne(h, "qeaa-providers", QEAA_LIST);
      expect((await h.service.supersede(record.id)).ok).toBe(true);
      const service = readTrustedList(
        h.store.loadLatest(QEAA_LIST)!.artifacts.xml,
      ).providers![0]!.services[0]!;
      expect(service.serviceStatus).toBe(SVCSTATUS_WITHDRAWN);
      expect(service.serviceHistory![0]!.serviceStatus).toBe(SVCSTATUS_GRANTED);
    } finally {
      rmSync(h.root, { recursive: true, force: true });
    }
  });

  it("refuses to supersede an application that was never published", async () => {
    const h = harness();
    try {
      const parsed = parseTslSubmission(body(), {
        family: "eaa-providers",
        trustedLists: [...h.configs.values()],
        submittedAt: "2026-08-03T10:00:00Z",
      });
      if (!parsed.ok) throw new Error("rejected");
      const record = h.service.submit(parsed.value);
      const result = await h.service.supersede(record.id);
      expect(result.ok).toBe(false);
    } finally {
      rmSync(h.root, { recursive: true, force: true });
    }
  });

  it("serializes concurrent publications on one list", async () => {
    const h = harness();
    try {
      const records = [];
      for (const [index, organisation] of [
        "Alpha Provider",
        "Beta Provider",
        "Gamma Provider",
      ].entries()) {
        const generated = generate(material, `conc-${index}`, organisation);
        const parsed = parseTslSubmission(
          body({
            tspName: organisation,
            certificatePem: generated.certificate,
            serviceName: `${organisation} Issuance`,
            registrationIdentifier: `1000000000${index}`,
          }),
          {
            family: "eaa-providers",
            trustedLists: [...h.configs.values()],
            submittedAt: `2026-08-03T1${index}:00:00Z`,
          },
        );
        if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
        const record = h.service.submit(parsed.value);
        h.service.approve(record.id);
        records.push(record);
      }
      const results = await Promise.all(
        records.map((record) => h.service.publish(record.id)),
      );
      expect(results.every((result) => result.ok)).toBe(true);
      /* Three publications, three distinct sequences, none lost. */
      expect(h.store.sequences(EAA_LIST)).toEqual([1, 2, 3]);
      const latest = h.store.loadLatest(EAA_LIST)!;
      expect(readTrustedList(latest.artifacts.xml).providers).toHaveLength(3);
    } finally {
      rmSync(h.root, { recursive: true, force: true });
    }
  });

  it("reconciles a stale application against a published version", async () => {
    const h = harness();
    try {
      const record = await publishOne(h, "eaa-providers", EAA_LIST);
      const reconciled = h.service.reconcile(record.id, 1);
      expect(reconciled.ok).toBe(true);
      expect(reconciled.value?.state).toBe("published");
      expect(reconciled.value?.publication?.sequenceNumber).toBe(1);
    } finally {
      rmSync(h.root, { recursive: true, force: true });
    }
  });

  it("refuses to reconcile against a version that does not list the service", async () => {
    const h = harness();
    try {
      await publishOne(h, "eaa-providers", EAA_LIST);
      const other = generate(material, "unlisted", "Unlisted Provider");
      const parsed = parseTslSubmission(
        body({
          tspName: "Unlisted Provider",
          certificatePem: other.certificate,
          registrationIdentifier: "22222222222",
        }),
        {
          family: "eaa-providers",
          trustedLists: [...h.configs.values()],
          submittedAt: "2026-08-03T13:00:00Z",
        },
      );
      if (!parsed.ok) throw new Error("rejected");
      const record = h.service.submit(parsed.value);
      const result = h.service.reconcile(record.id, 1);
      expect(result.ok).toBe(false);
      expect(result.code).toBe("NOT_LISTED");
    } finally {
      rmSync(h.root, { recursive: true, force: true });
    }
  });
});

describe("publication reader façade", () => {
  it("reports an XML list as TS 119 612 and finds its versions", async () => {
    const h = harness();
    try {
      const parsed = parseTslSubmission(body(), {
        family: "eaa-providers",
        trustedLists: [...h.configs.values()],
        submittedAt: "2026-08-03T10:00:00Z",
      });
      if (!parsed.ok) throw new Error("rejected");
      const record = h.service.submit(parsed.value);
      h.service.approve(record.id);
      await h.service.publish(record.id);

      expect(h.reader.formatOf(EAA_LIST)).toBe("xml");
      const summary = await h.reader.listSummary(EAA_LIST);
      expect(summary).toMatchObject({
        format: "xml",
        standard: "TS 119 612",
        family: "eaa-providers",
        latestSequence: 1,
        territory: "IT",
      });
      const versions = await h.reader.versions(EAA_LIST);
      expect(versions).toHaveLength(1);
      expect(versions[0]?.standard).toBe("TS 119 612");
      const detail = await h.reader.version(EAA_LIST, 1);
      expect(detail?.format).toBe("xml");
      if (detail?.format === "xml") {
        expect(detail.xml).toContain("TrustServiceStatusList");
        expect(detail.sha2).toMatch(/^[0-9a-f]{64}$/);
      }
    } finally {
      rmSync(h.root, { recursive: true, force: true });
    }
  });

  it("reports nothing for a list that was never published", async () => {
    const h = harness();
    try {
      expect(h.reader.formatOf("absent")).toBeNull();
      expect(await h.reader.listSummary("absent")).toBeNull();
      expect(await h.reader.versions("absent")).toEqual([]);
    } finally {
      rmSync(h.root, { recursive: true, force: true });
    }
  });
});

process.on("exit", () => {
  if (material) rmSync(material, { recursive: true, force: true });
});
