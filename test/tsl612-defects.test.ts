/**
 * Intentionally broken TS 119 612 fixtures.
 *
 * Every test here is offline. Nothing in this file contacts
 * trust-inspector.credimi.io, and the Inspector client is either absent or a
 * stub — uploading artifacts to a third party is something an operator does on
 * purpose, with `npm run fixtures:verify`, not a side effect of `npm test`.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import {
  DEFECT_CATALOGUE,
  compareFailures,
  defectForStandard,
  defectsForStandard,
  expectedLocalFailuresForStandard,
  expectedRuleIdsForStandard,
  normalizeInspectorRuleId,
  LOCAL_FAILURE_IDS,
} from "../src/core/defects/registry.js";
import {
  buildFixtureMetadata,
  parseFixtureMetadata,
} from "../src/core/defects/fixture-metadata.js";
import { LIST_DEFECTS } from "../src/core/authoring/list-creation.js";
import { DEFECT_SPECS } from "../src/core/authoring/defects.js";
import {
  applyXmlPostSignDefects,
  applyXmlPreSignDefects,
  isKnownXmlDefect,
  planSha2Digest,
  xmlDefects,
} from "../src/core/tsl612/defects.js";
import {
  COMBINED_DEFECTS,
  fixtureKey,
  fixtureKeys,
  generateTrustedListFixtureSuite,
} from "../src/core/tsl612/fixture-suite.js";
import { TrustedListStore } from "../src/core/publication/tsl-store.js";
import { verifyTrustedList } from "../src/core/tsl612/sign.js";
import { InspectorClient } from "../src/core/inspector/inspector.js";
import {
  SVCSTATUS_GRANTED,
  SVCSTATUS_RECOGNISED_AT_NATIONAL_LEVEL,
  SVCTYPE_EAA,
  NS_TSL,
} from "../src/core/tsl612/constants.js";

const AT = new Date("2026-08-03T12:00:00Z");

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "tlp-xml-defects-"));
}

/**
 * One EAA suite, generated once and shared by the assertions below.
 *
 * Generating it costs a few seconds of OpenSSL and XML signing, and every test
 * that inspects a published fixture is asking a question about the same run.
 */
let suiteDir: string | null = null;
let suite: Awaited<ReturnType<typeof generateTrustedListFixtureSuite>> | null =
  null;
let suiteStore: TrustedListStore | null = null;

async function eaaSuite(): Promise<{
  fixtures: NonNullable<typeof suite>;
  store: TrustedListStore;
}> {
  if (!suite || !suiteStore) {
    suiteDir = scratch();
    suiteStore = new TrustedListStore({
      publicationDir: join(suiteDir, "publications"),
    });
    suite = await generateTrustedListFixtureSuite({
      store: suiteStore,
      signingConfigPath: join(suiteDir, "signing.json"),
      certificatesDir: join(suiteDir, "certs"),
      families: ["eaa-providers"],
      inspectorClient: null,
      now: () => AT,
    });
  }
  return { fixtures: suite, store: suiteStore };
}

// ============================================================
// 1. One catalogue
// ============================================================
describe("the canonical defect catalogue", () => {
  it("is the only catalogue: LIST_DEFECTS is a view of it", () => {
    expect(LIST_DEFECTS.map((defect) => defect.id)).toEqual(
      DEFECT_SPECS.map((spec) => spec.id),
    );
    for (const defect of LIST_DEFECTS) {
      const spec = defectForStandard(defect.id, "TS 119 602");
      expect(spec).toBeDefined();
      expect(defect.label).toBe(spec!.label);
      expect(defect.description).toBe(spec!.description);
    }
  });

  it("gives every defect at least one standard binding", () => {
    for (const defect of DEFECT_CATALOGUE)
      expect(defect.bindings.length).toBeGreaterThan(0);
  });

  it("uses one id per defect across both standards", () => {
    const ids = DEFECT_CATALOGUE.map((defect) => defect.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("reuses the same id where the meaning applies to both formats", () => {
    const shared = DEFECT_CATALOGUE.filter(
      (defect) => defect.bindings.length === 2,
    ).map((defect) => defect.id);
    expect(shared).toEqual([
      "non_strict_timestamps",
      "scheme_name_without_territory",
      "missing_scheme_information_uri",
      "missing_policy_or_legal_notice",
      "missing_operator_email",
      "missing_self_pointer",
      "pem_service_certificate",
      "extension_without_criticality",
      "signer_organisation_mismatch",
    ]);
  });

  it("covers every TS 119 612 defect category the product requires", () => {
    for (const id of [
      "missing_scheme_information_uri",
      "invalid_tsl_namespace",
      "invalid_tsl_version_identifier",
      "expired_next_update",
      "incorrect_service_type",
      "incorrect_service_status",
      "invalid_service_history",
      "pem_service_certificate",
      "signer_organisation_mismatch",
      "broken_xades_signature",
      "incorrect_signing_certificate",
      "incorrect_sha2_digest",
    ])
      expect(isKnownXmlDefect(id)).toBe(true);
  });

  it("records a stage, a reference and expectations for every XML defect", () => {
    for (const spec of xmlDefects()) {
      expect(["pre-sign", "post-sign", "publication"]).toContain(spec.stage);
      expect(spec.normativeReference.length).toBeGreaterThan(0);
      expect(spec.conformantBehaviour.length).toBeGreaterThan(0);
      /* Every defect must be expected to fail *something*, locally or at the
         Inspector. A defect that predicts no failure predicts nothing. */
      expect(
        spec.expectedRuleIds.length + spec.expectedLocalFailures.length,
      ).toBeGreaterThan(0);
    }
  });

  it("keeps the JSON catalogue free of XML-only defects", () => {
    const json = defectsForStandard("TS 119 602").map((spec) => spec.id);
    expect(json).not.toContain("invalid_tsl_namespace");
    expect(json).not.toContain("incorrect_sha2_digest");
    expect(json).toContain("jades_without_signing_time");
  });

  it("never binds a defect to a stage the format cannot perform", () => {
    for (const spec of defectsForStandard("TS 119 602"))
      expect(spec.stage).not.toBe("publication");
  });
});

// ============================================================
// 2. Rule-id normalization and comparison
// ============================================================
describe("Inspector rule comparison", () => {
  it("strips the positional indices the Inspector embeds", () => {
    expect(
      normalizeInspectorRuleId("ts119612.service.1.1.history.1.status_start"),
    ).toBe("ts119612.service.history.status_start");
    expect(normalizeInspectorRuleId("schema.xsd")).toBe("schema.xsd");
  });

  it("matches an expectation against an indexed actual failure", () => {
    const result = compareFailures(
      ["ts119612.service.history.status_start"],
      ["ts119612.service.2.1.history.3.status_start: out of order"],
    );
    expect(result.matched).toEqual(["ts119612.service.history.status_start"]);
    expect(result.missing).toEqual([]);
    expect(result.additional).toEqual([]);
  });

  it("reports an unexpected failure rather than treating it as wrong", () => {
    const result = compareFailures(
      ["schema.xsd"],
      ["schema.xsd: bad", "ts119612.scheme.name: bad"],
    );
    expect(result.matched).toEqual(["schema.xsd"]);
    expect(result.additional).toEqual(["ts119612.scheme.name"]);
  });

  it("reports an expectation that did not happen", () => {
    const result = compareFailures(["schema.xsd"], []);
    expect(result.missing).toEqual(["schema.xsd"]);
  });
});

// ============================================================
// 3. Fixture metadata
// ============================================================
describe("fixture metadata", () => {
  it("records both axes and both comparisons", () => {
    const metadata = buildFixtureMetadata({
      standard: "TS 119 612",
      artifactFormat: "XML / XAdES-B-B",
      selectedDefects: ["incorrect_sha2_digest"],
      mutations: [
        {
          defectId: "incorrect_sha2_digest",
          stage: "publication",
          applied: true,
          detail: "rotated",
        },
      ],
      actualLocalFailures: [LOCAL_FAILURE_IDS.sha2Digest],
      actualInspectorFailures: [],
      generatedAt: AT,
    });
    expect(metadata.fixtureMode).toBe("intentionally-broken");
    expect(metadata.expectedFailures.local).toEqual([
      LOCAL_FAILURE_IDS.sha2Digest,
    ]);
    expect(metadata.expectedFailures.inspector).toEqual([]);
    expect(metadata.matchedLocalFailures).toEqual([
      LOCAL_FAILURE_IDS.sha2Digest,
    ]);
    expect(metadata.missingLocalFailures).toEqual([]);
  });

  it("calls a selection-free run healthy", () => {
    const metadata = buildFixtureMetadata({
      standard: "TS 119 612",
      artifactFormat: "XML / XAdES-B-B",
      selectedDefects: [],
      mutations: [],
      actualLocalFailures: [],
      actualInspectorFailures: [],
      generatedAt: AT,
    });
    expect(metadata.fixtureMode).toBe("healthy");
  });

  it("still reads a version 1 document written before XML fixtures existed", () => {
    const legacy = parseFixtureMetadata(
      JSON.stringify({
        schemaVersion: 1,
        intentionallyBroken: true,
        selectedDefects: ["non_strict_timestamps"],
        mutations: [],
        localValidationFailures: ["LoTE: bad"],
        expectedInspectorFailures: ["ts119602.scheme.name"],
        actualInspectorFailures: ["ts119602.scheme.name: bad"],
        matchedFailures: ["ts119602.scheme.name"],
        missingFailures: [],
        additionalFailures: [],
        knownUnrelatedFailures: [],
        generatedAt: AT.toISOString(),
      }),
    );
    expect(legacy).not.toBeNull();
    expect(legacy!.standard).toBe("TS 119 602");
    expect(legacy!.artifactFormat).toBe("JSON / JAdES");
    expect(legacy!.actualFailures.local).toEqual(["LoTE: bad"]);
    expect(legacy!.expectedFailures.inspector).toEqual([
      "ts119602.scheme.name",
    ]);
  });

  it("returns null rather than guessing at unreadable metadata", () => {
    expect(parseFixtureMetadata("not json")).toBeNull();
    expect(parseFixtureMetadata("{}")).toBeNull();
  });
});

// ============================================================
// 4. The XML mutations themselves
// ============================================================
describe("XML mutations", () => {
  /* A minimal but structurally faithful list: enough of the real element order
     for the mutations to find what they edit, small enough to read. */
  const healthy = `<?xml version="1.0" encoding="UTF-8"?>
<TrustServiceStatusList xmlns="${NS_TSL}" xmlns:tslx="http://uri.etsi.org/02231/v2/additionaltypes#" TSLTag="http://uri.etsi.org/19612/TSLTag" Id="TrustServiceStatusList">
  <SchemeInformation>
    <TSLVersionIdentifier>6</TSLVersionIdentifier>
    <SchemeName>
      <Name xml:lang="en">IT:Example Operator</Name>
    </SchemeName>
    <SchemeInformationURI>
      <URI xml:lang="en">https://example.eu/scheme</URI>
    </SchemeInformationURI>
    <SchemeOperatorAddress>
      <ElectronicAddress>
        <URI xml:lang="en">mailto:ops@example.eu</URI>
        <URI xml:lang="en">https://example.eu</URI>
      </ElectronicAddress>
    </SchemeOperatorAddress>
    <PolicyOrLegalNotice>
      <TSLPolicy xml:lang="en">https://example.eu/policy</TSLPolicy>
    </PolicyOrLegalNotice>
    <PointersToOtherTSL>
      <OtherTSLPointer>
        <TSLLocation>https://ec.europa.eu/tools/lotl/eu-lotl.xml</TSLLocation>
      </OtherTSLPointer>
    </PointersToOtherTSL>
    <ListIssueDateTime>2026-08-03T12:00:00Z</ListIssueDateTime>
    <NextUpdate>
      <dateTime>2026-11-03T12:00:00Z</dateTime>
    </NextUpdate>
  </SchemeInformation>
  <TrustServiceProviderList>
    <TrustServiceProvider>
      <TSPServices>
        <TSPService>
          <ServiceInformation>
            <ServiceTypeIdentifier>${SVCTYPE_EAA}</ServiceTypeIdentifier>
            <ServiceDigitalIdentity>
              <DigitalId>
                <X509Certificate>QUJD</X509Certificate>
              </DigitalId>
            </ServiceDigitalIdentity>
            <ServiceStatus>${SVCSTATUS_RECOGNISED_AT_NATIONAL_LEVEL}</ServiceStatus>
            <StatusStartingTime>2026-08-03T12:00:00Z</StatusStartingTime>
          </ServiceInformation>
          <ServiceHistory>
            <ServiceHistoryInstance>
              <StatusStartingTime>2026-08-02T12:00:00Z</StatusStartingTime>
            </ServiceHistoryInstance>
          </ServiceHistory>
        </TSPService>
      </TSPServices>
    </TrustServiceProvider>
  </TrustServiceProviderList>
</TrustServiceStatusList>
`;
  const context = {
    family: "eaa-providers" as const,
    schemeTerritory: "IT",
    schemeOperatorName: "Example Operator",
  };

  const apply = (id: string) => applyXmlPreSignDefects(healthy, [id], context);

  it("replaces the namespace without touching element names", () => {
    const { xml, mutations } = apply("invalid_tsl_namespace");
    expect(mutations[0]!.applied).toBe(true);
    expect(xml).not.toContain(`xmlns="${NS_TSL}"`);
    expect(xml).toContain("v2-invalid#");
    expect(xml).toContain("<TrustServiceStatusList");
  });

  it("publishes TSLVersionIdentifier 5", () => {
    const { xml } = apply("invalid_tsl_version_identifier");
    expect(xml).toContain("<TSLVersionIdentifier>5</TSLVersionIdentifier>");
  });

  it("moves NextUpdate before the issue time", () => {
    const { xml, mutations } = apply("expired_next_update");
    expect(mutations[0]!.applied).toBe(true);
    expect(xml).toContain("<dateTime>2026-08-02T12:00:00Z</dateTime>");
  });

  it("removes the mandatory SchemeInformationURI", () => {
    const { xml } = apply("missing_scheme_information_uri");
    expect(xml).not.toContain("<SchemeInformationURI>");
  });

  it("removes the pointer to the EU LOTL", () => {
    const { xml } = apply("missing_self_pointer");
    expect(xml).not.toContain("<PointersToOtherTSL>");
  });

  it("removes the operator's mailto without removing the website", () => {
    const { xml } = apply("missing_operator_email");
    expect(xml).not.toContain("mailto:ops@example.eu");
    expect(xml).toContain("https://example.eu</URI>");
  });

  it("swaps the service type for a real but wrong one", () => {
    const { xml } = apply("incorrect_service_type");
    expect(xml).not.toContain(SVCTYPE_EAA);
    expect(xml).toContain("Svctype/CA/QC");
  });

  it("gives an EAA service the qualified vocabulary", () => {
    const { xml } = apply("incorrect_service_status");
    expect(xml).toContain(SVCSTATUS_GRANTED);
    expect(xml).not.toContain(SVCSTATUS_RECOGNISED_AT_NATIONAL_LEVEL);
  });

  it("gives a QEAA service the non-qualified vocabulary", () => {
    const qeaa = healthy
      .split(SVCSTATUS_RECOGNISED_AT_NATIONAL_LEVEL)
      .join(SVCSTATUS_GRANTED);
    const { xml } = applyXmlPreSignDefects(qeaa, ["incorrect_service_status"], {
      ...context,
      family: "qeaa-providers",
    });
    expect(xml).toContain(SVCSTATUS_RECOGNISED_AT_NATIONAL_LEVEL);
  });

  it("moves a history status time after the state that replaced it", () => {
    const { xml, mutations } = apply("invalid_service_history");
    expect(mutations[0]!.applied).toBe(true);
    expect(xml).toContain(
      "<ServiceHistoryInstance>\n              <StatusStartingTime>2026-08-04T12:00:00Z",
    );
  });

  it("re-armours a service certificate as PEM, leaving the pointer alone", () => {
    const { xml } = apply("pem_service_certificate");
    expect(xml).toContain("-----BEGIN CERTIFICATE-----");
  });

  it("injects an Extension with no Critical attribute", () => {
    const { xml, mutations } = apply("extension_without_criticality");
    expect(mutations[0]!.applied).toBe(true);
    expect(xml).toContain("<ServiceInformationExtensions>");
    expect(xml).not.toContain("Critical=");
  });

  it("strips the territory prefix from SchemeName only", () => {
    const { xml } = apply("scheme_name_without_territory");
    expect(xml).toContain('<Name xml:lang="en">Example Operator</Name>');
  });

  it("adds a fraction to both timestamps", () => {
    const { xml } = apply("non_strict_timestamps");
    expect(xml).toContain("2026-08-03T12:00:00.000Z");
    expect(xml).toContain("2026-11-03T12:00:00.000Z");
  });

  it("edits signed content for the broken-signature defect", () => {
    const { xml, mutations } = applyXmlPostSignDefects(healthy, [
      "broken_xades_signature",
    ]);
    expect(mutations[0]!.applied).toBe(true);
    expect(xml).toContain("tampered after signing");
  });

  it("rotates one hex digit of the digest, keeping it well formed", () => {
    const honest = createHash("sha256").update("x").digest("hex");
    const { digest, mutations } = planSha2Digest(honest, [
      "incorrect_sha2_digest",
    ]);
    expect(mutations[0]!.applied).toBe(true);
    expect(digest).not.toBe(honest);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest.slice(0, 63)).toBe(honest.slice(0, 63));
  });

  it("leaves the digest alone when the defect was not selected", () => {
    const honest = createHash("sha256").update("x").digest("hex");
    expect(planSha2Digest(honest, ["expired_next_update"]).digest).toBe(honest);
  });

  it("records a mutation that found nothing rather than claiming success", () => {
    const { mutations } = applyXmlPreSignDefects(
      '<?xml version="1.0"?>\n<TrustServiceStatusList/>\n',
      ["missing_self_pointer"],
      context,
    );
    expect(mutations[0]!.applied).toBe(false);
    expect(mutations[0]!.detail).toContain("no PointersToOtherTSL");
  });
});

// ============================================================
// 5. The generated suite
// ============================================================
describe("the EAA fixture suite", () => {
  it("uses the deterministic keys the product documents", () => {
    expect(fixtureKey("eaa-providers", "healthy")).toBe("eaa-healthy");
    expect(fixtureKey("qeaa-providers", "combined")).toBe(
      "qeaa-broken-combined",
    );
    expect(fixtureKey("eaa-providers", { defect: "expired_next_update" })).toBe(
      "eaa-broken-expired_next_update",
    );
    expect(fixtureKeys("eaa-providers")).toHaveLength(xmlDefects().length + 2);
  });

  it("generates one fixture per defect, plus a baseline and a combination", async () => {
    const { fixtures } = await eaaSuite();
    expect(fixtures.map((f) => f.listKey)).toEqual(
      fixtureKeys("eaa-providers"),
    );
    for (const fixture of fixtures) expect(fixture.error).toBeUndefined();
  });

  it("applies exactly one mutation to every single-defect fixture", async () => {
    const { fixtures } = await eaaSuite();
    for (const fixture of fixtures.filter((f) => f.defects.length === 1)) {
      const applied = (fixture.fixture?.mutations ?? []).filter(
        (mutation) => mutation.applied,
      );
      expect(applied).toHaveLength(1);
      expect(applied[0]!.defectId).toBe(fixture.defects[0]);
    }
  });

  it("applies exactly two to the combined fixture", async () => {
    const { fixtures } = await eaaSuite();
    const combined = fixtures.find((f) => f.listKey === "eaa-broken-combined")!;
    expect(combined.defects).toEqual(COMBINED_DEFECTS);
    expect(
      (combined.fixture?.mutations ?? []).filter((m) => m.applied),
    ).toHaveLength(2);
  });

  it("never silently repairs a selected defect", async () => {
    const { fixtures } = await eaaSuite();
    for (const fixture of fixtures)
      for (const mutation of fixture.fixture?.mutations ?? [])
        expect(mutation.applied).toBe(true);
  });

  it("leaves the healthy baseline schema-valid and correctly signed", async () => {
    const { fixtures, store } = await eaaSuite();
    const healthy = fixtures.find((f) => f.listKey === "eaa-healthy")!;
    expect(healthy.fixture).toBeUndefined();
    const artifacts = store.loadVersion("eaa-healthy", 1).artifacts!;
    expect(artifacts).not.toBeNull();
    expect(artifacts.manifest.schemaValid).toBe(true);
    expect(artifacts.manifest.signatureValid).toBe(true);
    expect(artifacts.manifest.freshnessValid).toBe(true);
    expect(artifacts.manifest.signingCertificateFindings).toEqual([]);
    const verification = verifyTrustedList(artifacts.xml);
    expect(verification.valid).toBe(true);
  });

  it("records the EAA service profile in the manifest", async () => {
    const { store } = await eaaSuite();
    const manifest = store.loadVersion("eaa-healthy", 1).artifacts!.manifest;
    expect(manifest.serviceProfiles.serviceProfilesPresent).toEqual([
      SVCTYPE_EAA,
    ]);
    expect(manifest.serviceProfiles.allowedServiceProfiles).toEqual([
      "eaa-providers",
    ]);
  });

  it("publishes a .sha2 that is the digest of the exact XML bytes", async () => {
    const { store } = await eaaSuite();
    const artifacts = store.loadVersion("eaa-healthy", 1).artifacts!;
    expect(artifacts.sha2).toBe(
      createHash("sha256")
        .update(Buffer.from(artifacts.xml, "utf-8"))
        .digest("hex"),
    );
  });

  it("publishes a deliberately wrong .sha2 and still serves the version", async () => {
    const { store } = await eaaSuite();
    const key = "eaa-broken-incorrect_sha2_digest";
    const artifacts = store.loadVersion(key, 1).artifacts!;
    expect(artifacts).not.toBeNull();
    const honest = createHash("sha256")
      .update(Buffer.from(artifacts.xml, "utf-8"))
      .digest("hex");
    expect(artifacts.sha2).not.toBe(honest);
    expect(artifacts.manifest.trustedListXmlSha256).toBe(honest);
    expect(artifacts.manifest.trustedListSha2Published).toBe(artifacts.sha2);
  });

  it("does not overwrite the final-artifact hash with a pre-mutation one", async () => {
    const { store } = await eaaSuite();
    for (const key of [
      "eaa-broken-broken_xades_signature",
      "eaa-broken-expired_next_update",
    ]) {
      const artifacts = store.loadVersion(key, 1).artifacts!;
      expect(artifacts.manifest.trustedListXmlSha256).toBe(
        createHash("sha256")
          .update(Buffer.from(artifacts.xml, "utf-8"))
          .digest("hex"),
      );
    }
  });

  it("publishes a signature that does not verify, rather than refusing", async () => {
    const { store } = await eaaSuite();
    const artifacts = store.loadVersion(
      "eaa-broken-broken_xades_signature",
      1,
    ).artifacts!;
    expect(artifacts.manifest.signatureValid).toBe(false);
    expect(verifyTrustedList(artifacts.xml).signature.valid).toBe(false);
  });

  it("publishes a schema-invalid list, rather than refusing", async () => {
    const { store } = await eaaSuite();
    const artifacts = store.loadVersion(
      "eaa-broken-missing_scheme_information_uri",
      1,
    ).artifacts!;
    expect(artifacts.manifest.schemaValid).toBe(false);
    expect(artifacts.manifest.schemaFindings.length).toBeGreaterThan(0);
  });

  it("records the certificate-profile failure instead of refusing to sign", async () => {
    const { store } = await eaaSuite();
    const artifacts = store.loadVersion(
      "eaa-broken-signer_organisation_mismatch",
      1,
    ).artifacts!;
    expect(
      artifacts.manifest.signingCertificateFindings.length,
    ).toBeGreaterThan(0);
    /* The signature itself is sound: that is what separates this defect from
       broken_xades_signature. */
    expect(artifacts.manifest.signatureValid).toBe(true);
  });

  it("falls back to the authoring input when the bytes cannot be read", async () => {
    const { store } = await eaaSuite();
    const artifacts = store.loadVersion(
      "eaa-broken-invalid_tsl_namespace",
      1,
    ).artifacts!;
    expect(artifacts.manifest.trustedListMetadataSource).toBe(
      "authoring-input",
    );
    expect(artifacts.manifest.schemaValid).toBe(false);
  });

  it("reads back the metadata from the published bytes otherwise", async () => {
    const { store } = await eaaSuite();
    expect(
      store.loadVersion("eaa-healthy", 1).artifacts!.manifest
        .trustedListMetadataSource,
    ).toBe("published-bytes");
  });

  it("stores the fixture evidence beside every broken version", async () => {
    const { fixtures, store } = await eaaSuite();
    for (const fixture of fixtures.filter((f) => f.defects.length > 0)) {
      const stored = store.readFixtureMetadata(fixture.listKey, 1);
      expect(stored).not.toBeNull();
      const parsed = parseFixtureMetadata(stored!)!;
      expect(parsed.standard).toBe("TS 119 612");
      expect(parsed.artifactFormat).toBe("XML / XAdES-B-B");
      expect(parsed.selectedDefects).toEqual([...fixture.defects]);
    }
  });

  it("stores no fixture evidence beside a healthy version", async () => {
    const { store } = await eaaSuite();
    expect(store.readFixtureMetadata("eaa-healthy", 1)).toBeNull();
  });

  it("reports every expected local failure it predicted", async () => {
    const { fixtures } = await eaaSuite();
    for (const fixture of fixtures)
      expect(fixture.fixture?.missingLocalFailures ?? []).toEqual([]);
  });

  it("records an unreachable Inspector as missing, never as a pass", async () => {
    const { fixtures } = await eaaSuite();
    /* The suite was generated with no Inspector, so every expected rule is
       recorded as missing and nothing is reported as having passed. */
    const expired = fixtures.find(
      (f) => f.listKey === "eaa-broken-expired_next_update",
    )!;
    expect(expired.fixture!.actualFailures.inspector).toEqual([]);
    expect(expired.fixture!.missingFailures).toEqual(
      expectedRuleIdsForStandard(["expired_next_update"], "TS 119 612"),
    );
    expect(expired.inspectorStatus).toBeUndefined();
  });

  it("expects the local checks the catalogue declares", async () => {
    const { fixtures } = await eaaSuite();
    for (const fixture of fixtures.filter((f) => f.defects.length > 0))
      expect(fixture.fixture!.expectedFailures.local).toEqual(
        expectedLocalFailuresForStandard(fixture.defects, "TS 119 612"),
      );
  });
});

// ============================================================
// 6. The Inspector never turns "no verdict" into a pass
// ============================================================
describe("Trust Inspector verdicts", () => {
  const respond = (result: unknown) =>
    (() =>
      Promise.resolve(
        new Response(JSON.stringify({ result }), { status: 200 }),
      )) as unknown as typeof fetch;

  const assess = (result: unknown) =>
    new InspectorClient({
      baseUrl: "https://inspector.invalid",
      fetchImpl: respond(result),
    }).assess({
      trustedListXml: "<TrustServiceStatusList/>",
      source: "test",
    });

  it("reports not_applicable as unavailable", async () => {
    const evaluation = await assess({
      detected: { format: "xml", artifactKind: "xml_lotl_like" },
      standardApplicability: { ts119612: "not_applicable" },
      ts119612: { applicable: false, checks: [] },
    });
    expect(evaluation.summary.status).toBe("unavailable");
    expect(evaluation.summary.error).toContain("not applicable");
    expect(evaluation.summary.artifactKind).toBe("xml_lotl_like");
  });

  it("reports an unknown applicability as unavailable", async () => {
    const evaluation = await assess({
      detected: { format: "xml", artifactKind: "unknown" },
      standardApplicability: { ts119612: "unknown" },
      ts119612: { applicable: true, checks: [] },
    });
    expect(evaluation.summary.status).toBe("unavailable");
  });

  it("reports an empty check list as unavailable", async () => {
    const evaluation = await assess({
      detected: { format: "xml", artifactKind: "ts119612_xml_tsl" },
      standardApplicability: { ts119612: "applicable" },
      ts119612: { applicable: true, checks: [] },
    });
    expect(evaluation.summary.status).toBe("unavailable");
    expect(evaluation.summary.error).toContain("ran no ts119612 check");
  });

  it("reports a missing section as unavailable", async () => {
    const evaluation = await assess({
      detected: { format: "xml", artifactKind: "ts119612_xml_tsl" },
      standardApplicability: { ts119612: "applicable" },
    });
    expect(evaluation.summary.status).toBe("unavailable");
  });

  it("passes only when the standard was applied and every check held", async () => {
    const evaluation = await assess({
      detected: { format: "xml", artifactKind: "ts119612_xml_tsl" },
      standardApplicability: { ts119612: "applicable" },
      ts119612: {
        applicable: true,
        conformanceLevel: "conformant",
        checks: [
          {
            id: "schema.xsd",
            category: "schema",
            status: "pass",
            severity: "info",
            message: "ok",
          },
        ],
      },
    });
    expect(evaluation.summary.status).toBe("pass");
    expect(evaluation.summary.standardApplicability).toEqual({
      ts119612: "applicable",
    });
  });

  it("fails when a check the Inspector could decide locally failed", async () => {
    const evaluation = await assess({
      detected: { format: "xml", artifactKind: "ts119612_xml_tsl" },
      standardApplicability: { ts119612: "applicable" },
      ts119612: {
        applicable: true,
        checks: [
          {
            id: "ts119612.scheme.version",
            category: "structure",
            status: "fail",
            severity: "error",
            message: "TSLVersionIdentifier is 5",
          },
        ],
      },
    });
    expect(evaluation.summary.status).toBe("fail");
    expect(evaluation.summary.locallyDecidableFailures).toEqual([
      "ts119612.scheme.version: TSLVersionIdentifier is 5",
    ]);
  });
});

// ============================================================
// 7. Cleanup
// ============================================================
describe("suite cleanup", () => {
  it("removes the generated fixtures", () => {
    if (suiteDir) rmSync(suiteDir, { recursive: true, force: true });
    expect(true).toBe(true);
  });
});
