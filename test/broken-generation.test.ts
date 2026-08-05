import { describe, expect, it } from "vitest";
import {
  DEFECT_SPECS,
  applyPreSignDefects,
  compareFailures,
  defectsAtStage,
  expectedRuleIdsFor,
  fixtureSeedEntity,
} from "../src/core/authoring/defects.js";
import { LIST_DEFECTS } from "../src/core/authoring/list-creation.js";
import {
  brokenColumnHtml,
  brokenListSectionHtml,
  defectIdsFromFixture,
} from "../src/web/views/broken-list.js";
import { compileForProfile } from "../src/core/compile/compile.js";
import type { AuthoringInput } from "../src/core/model/authoring.js";
import type { LoTEDocument } from "../src/core/model/types.js";
import { normalizeDefectSelectionForStandard } from "../src/core/defects/registry.js";

const CERT_DER = "MIIBdummyBase64DerValue";

function pubEaaInput(
  entities: AuthoringInput["entities"] = [],
): AuthoringInput {
  return {
    schemeOperator: {
      name: [{ lang: "en", value: "Fixture Operator" }],
      postalAddress: [
        { lang: "en", StreetAddress: "1 Fixture Street", Country: "EU" },
      ],
      electronicAddress: [
        { lang: "en", uriValue: "mailto:ops@fixture.example" },
        { lang: "en", uriValue: "https://fixture.example" },
      ],
    },
    scheme: {
      schemeName: [{ lang: "en", value: "Fixture List" }],
      schemeTerritory: "EU",
      schemeInformationURI: [
        { lang: "en", uriValue: "https://fixture.example/scheme" },
        { lang: "en", uriValue: "https://fixture.example/practice" },
      ],
      distributionPoints: ["https://fixture.example/latest"],
      policyUri: "https://fixture.example/policy",
      historicalInformationPeriod: 65535,
    },
    listIssueDateTime: "2026-01-01T00:00:00Z",
    nextUpdate: "2026-07-01T00:00:00Z",
    loTESequenceNumber: 1,
    entities,
  };
}

const context = {
  family: "pub-eaa-providers" as const,
  schemeTerritory: "EU",
  distributionPointUri: "https://fixture.example/latest",
  loTEType: "http://uri.etsi.org/19602/LoTEType/EUPubEAAProvidersList",
  schemeOperatorName: "Fixture Operator",
  signingCertificateDer: CERT_DER,
};

function healthyPubEaa(withEntity = false): LoTEDocument {
  const entities = withEntity
    ? [
        fixtureSeedEntity(
          "pub-eaa-providers",
          CERT_DER,
          "2026-01-01T00:00:00Z",
          "EU",
        ),
      ]
    : [];
  return compileForProfile("pub-eaa-providers", pubEaaInput(entities)).document;
}

describe("defect catalogue", () => {
  it("normalizes selected defects to canonical JSON catalogue order", () => {
    expect(
      normalizeDefectSelectionForStandard(
        [
          "missing_operator_email",
          "scheme_name_without_territory",
          "missing_operator_email",
        ],
        "TS 119 602",
      ),
    ).toEqual(["scheme_name_without_territory", "missing_operator_email"]);
  });

  it("defines a spec for every advertised defect", () => {
    expect(DEFECT_SPECS).toHaveLength(LIST_DEFECTS.length);
    for (const defect of LIST_DEFECTS) {
      const spec = DEFECT_SPECS.find((candidate) => candidate.id === defect.id);
      expect(spec, `no spec for ${defect.id}`).toBeDefined();
      expect(spec?.stage === "pre-sign" || spec?.stage === "post-sign").toBe(
        true,
      );
      expect(spec?.expectedRuleIds.length).toBeGreaterThan(0);
    }
  });

  it("classifies the two signature defects as post-sign and the rest as pre-sign", () => {
    const ids = LIST_DEFECTS.map((defect) => defect.id);
    expect(defectsAtStage(ids, "post-sign").map((spec) => spec.id)).toEqual([
      "signer_organisation_mismatch",
      "jades_without_signing_time",
    ]);
    expect(defectsAtStage(ids, "pre-sign")).toHaveLength(8);
  });

  it("deduplicates and sorts expected rule IDs across combined defects", () => {
    const combined = expectedRuleIdsFor([
      "missing_policy_or_legal_notice",
      "missing_scheme_information_uri",
    ]);
    expect(combined).toEqual([...combined].sort());
    expect(new Set(combined).size).toBe(combined.length);
    /* Both defects trip the presence rule; it must appear once. */
    expect(
      combined.filter(
        (rule) => rule === "ts119602.structure.scheme_information_presence",
      ),
    ).toHaveLength(1);
  });
});

describe("pre-sign mutations", () => {
  /*
    The healthy document is the baseline every fixture is a delta from. If a
    mutation edited it in place, the "generate healthy first" guarantee would be
    quietly untrue.
  */
  it("never mutates the healthy document in place", () => {
    const healthy = healthyPubEaa();
    const before = JSON.stringify(healthy);
    applyPreSignDefects(healthy, ["missing_policy_or_legal_notice"], context);
    expect(JSON.stringify(healthy)).toBe(before);
  });

  it("returns the document unchanged when no defect is selected", () => {
    const healthy = healthyPubEaa();
    const { document, mutations } = applyPreSignDefects(healthy, [], context);
    expect(JSON.stringify(document)).toBe(JSON.stringify(healthy));
    expect(mutations).toHaveLength(0);
  });

  it("emits fractional seconds for non-strict timestamps", () => {
    const { document } = applyPreSignDefects(
      healthyPubEaa(),
      ["non_strict_timestamps"],
      context,
    );
    const info = document.LoTE.ListAndSchemeInformation;
    expect(info.ListIssueDateTime).toBe("2026-01-01T00:00:00.000Z");
    expect(info.NextUpdate).toBe("2026-07-01T00:00:00.000Z");
  });

  it("strips the territory prefix from SchemeName", () => {
    const healthy = healthyPubEaa();
    expect(healthy.LoTE.ListAndSchemeInformation.SchemeName?.[0]?.value).toBe(
      "EU:Fixture List",
    );
    const { document } = applyPreSignDefects(
      healthy,
      ["scheme_name_without_territory"],
      context,
    );
    expect(document.LoTE.ListAndSchemeInformation.SchemeName?.[0]?.value).toBe(
      "Fixture List",
    );
  });

  it("keeps one operator electronic address when the mailto is removed", () => {
    const { document, mutations } = applyPreSignDefects(
      healthyPubEaa(),
      ["missing_operator_email"],
      context,
    );
    const addresses =
      document.LoTE.ListAndSchemeInformation.SchemeOperatorAddress
        .SchemeOperatorElectronicAddress;
    expect(addresses.some((a) => a.uriValue.startsWith("mailto:"))).toBe(false);
    /* An empty array would fail the binding's minItems rule instead. */
    expect(addresses.length).toBeGreaterThan(0);
    expect(mutations[0]?.applied).toBe(true);
  });

  /*
    Annex H forbids PointersToOtherLoTE, so a healthy Pub-EAA list already omits
    it and "omit the pointer" would be a no-op. The defect is inverted for this
    family: it injects the prohibited structure.
  */
  it("injects a prohibited pointer for Annex H instead of omitting one", () => {
    const healthy = healthyPubEaa();
    expect(
      healthy.LoTE.ListAndSchemeInformation.PointersToOtherLoTE,
    ).toBeUndefined();
    const { document, mutations } = applyPreSignDefects(
      healthy,
      ["missing_self_pointer"],
      context,
    );
    const pointers = document.LoTE.ListAndSchemeInformation.PointersToOtherLoTE;
    expect(pointers).toHaveLength(1);
    /* Carrying a certificate keeps it a pointer defect, not a schema defect. */
    expect(
      pointers?.[0]?.ServiceDigitalIdentities[0]?.X509Certificates?.[0]?.val,
    ).toBe(CERT_DER);
    expect(mutations[0]?.applied).toBe(true);
  });

  it("re-armours a seeded service certificate as PEM", () => {
    const { document, mutations } = applyPreSignDefects(
      healthyPubEaa(true),
      ["pem_service_certificate"],
      context,
    );
    const value =
      document.LoTE.TrustedEntitiesList?.[0]?.TrustedEntityServices[0]
        ?.ServiceInformation.ServiceDigitalIdentity.X509Certificates?.[0]?.val;
    expect(value).toContain("-----BEGIN CERTIFICATE-----");
    expect(mutations[0]?.applied).toBe(true);
  });

  it("records a service defect as dormant when the list carries no entity", () => {
    const { mutations } = applyPreSignDefects(
      healthyPubEaa(),
      ["pem_service_certificate"],
      context,
    );
    expect(mutations[0]?.applied).toBe(false);
    expect(mutations[0]?.detail).toContain("dormant");
  });

  it("attaches an extension with no criticality flag", () => {
    const { document } = applyPreSignDefects(
      healthyPubEaa(true),
      ["extension_without_criticality"],
      context,
    );
    const extensions =
      document.LoTE.TrustedEntitiesList?.[0]?.TrustedEntityServices[0]
        ?.ServiceInformation.ServiceInformationExtensions;
    expect(extensions).toHaveLength(1);
    expect(extensions?.[0] && "Critical" in extensions[0]).toBe(false);
  });

  it("applies both mutations when two defects are combined", () => {
    const { document, mutations } = applyPreSignDefects(
      healthyPubEaa(),
      ["missing_policy_or_legal_notice", "missing_scheme_information_uri"],
      context,
    );
    const info = document.LoTE.ListAndSchemeInformation;
    expect(info.PolicyOrLegalNotice).toBeUndefined();
    expect(info.SchemeInformationURI).toBeUndefined();
    expect(mutations.filter((mutation) => mutation.applied)).toHaveLength(2);
  });
});

describe("expected against actual failure comparison", () => {
  it("separates matched, missing and additional rules", () => {
    const comparison = compareFailures(
      ["rule.a", "rule.b"],
      ["rule.a: something went wrong", "rule.c: cascading consequence"],
    );
    expect(comparison.matched).toEqual(["rule.a"]);
    expect(comparison.missing).toEqual(["rule.b"]);
    expect(comparison.additional).toEqual(["rule.c"]);
  });

  it("treats a failure line without a message as a bare rule ID", () => {
    expect(compareFailures(["rule.a"], ["rule.a"]).matched).toEqual(["rule.a"]);
  });
});

describe("other families stay healthy", () => {
  it.each([
    [
      "pid-providers",
      "http://uri.etsi.org/19602/SvcType/PID/Issuance",
      "http://uri.etsi.org/19602/ListOfTrustedEntities/PIDProvider/EU",
      true,
      false,
    ],
    [
      "wallet-providers",
      "http://uri.etsi.org/19602/SvcType/WalletSolution/Issuance",
      "http://uri.etsi.org/19602/ListOfTrustedEntities/WalletProvider/EU",
      true,
      false,
    ],
    [
      "wrpac-providers",
      "http://uri.etsi.org/19602/SvcType/WRPAC/Issuance",
      "http://uri.etsi.org/19602/ListOfTrustedEntities/WRPACProvider/EU",
      false,
      false,
    ],
    [
      "wrprc-providers",
      "http://uri.etsi.org/19602/SvcType/WRPRC/Issuance",
      "http://uri.etsi.org/19602/ListOfTrustedEntities/WRPRCProvider/EU",
      false,
      false,
    ],
    [
      "pub-eaa-providers",
      "http://uri.etsi.org/19602/SvcType/PubEAA/Issuance",
      "http://uri.etsi.org/19602/ListOfTrustedEntities/PubEAAProvider/EU",
      false,
      true,
    ],
  ] as const)(
    "%s builds a compilable healthy fixture seed",
    (family, serviceType, roleUri, hasUniqueIdentifier, hasStatus) => {
      const seed = fixtureSeedEntity(
        family,
        CERT_DER,
        "2026-01-01T00:00:00Z",
        "EU",
      );
      const service = seed.services[0]!;

      expect(service.serviceTypeIdentifier).toBe(serviceType);
      expect("serviceUniqueIdentifier" in service).toBe(hasUniqueIdentifier);
      expect("serviceStatus" in service).toBe(hasStatus);
      expect(
        seed.teElectronicAddress.some(
          (address) => address.uriValue === roleUri,
        ),
      ).toBe(family === "pub-eaa-providers");
      expect(
        seed.teInformationURI.some((address) => address.uriValue === roleUri),
      ).toBe(family !== "pub-eaa-providers");
      expect(
        seed.teTradeName?.some((name) => name.value === "OJ:EU32024R1183") ??
          false,
      ).toBe(family === "pub-eaa-providers");

      const input = pubEaaInput([seed]);
      if (family !== "pub-eaa-providers")
        delete input.scheme.historicalInformationPeriod;
      expect(() => compileForProfile(family, input)).not.toThrow();
    },
  );

  /*
    Broken generation is opt-in per list. A family that was never asked for a
    defect must compile exactly as before.
  */
  it.each([
    "wallet-providers",
    "pid-providers",
    "wrpac-providers",
    "wrprc-providers",
  ] as const)("%s compiles unchanged with no defects selected", (family) => {
    const input = pubEaaInput();
    delete input.scheme.historicalInformationPeriod;
    const healthy = compileForProfile(family, input).document;
    const { document, mutations } = applyPreSignDefects(healthy, [], {
      ...context,
      family,
    });
    expect(JSON.stringify(document)).toBe(JSON.stringify(healthy));
    expect(mutations).toHaveLength(0);
  });
});

describe("broken list markers", () => {
  it("reads defect IDs from fixture metadata and ignores anything else", () => {
    expect(defectIdsFromFixture(null)).toEqual([]);
    expect(defectIdsFromFixture("not json")).toEqual([]);
    expect(defectIdsFromFixture(JSON.stringify({}))).toEqual([]);
    expect(
      defectIdsFromFixture(
        JSON.stringify({ selectedDefects: ["missing_operator_email", 7] }),
      ),
    ).toEqual(["missing_operator_email"]);
  });

  it("renders an em-dash for a healthy list and an anchored disclosure for a broken one", () => {
    expect(brokenColumnHtml([])).toBe("&mdash;");
    const html = brokenColumnHtml(["extension_without_criticality"]);
    expect(html).toContain("Extension without criticality");
    expect(html).toContain("&#9888; Broken &middot; 1");
    expect(html).toContain('<details class="broken-fixture-popover">');
    expect(html).toContain("Broken fixture");
    /* The normative reference is the tooltip, so it must reach the markup. */
    expect(html).toContain("clause 6.6.9");
  });

  it("uses the selected list family for profile-specific Inspector rules", () => {
    expect(
      expectedRuleIdsFor(["missing_scheme_information_uri"], "pid-providers"),
    ).toContain("ts119602.profile.pid_providers.scheme_information");
    expect(
      expectedRuleIdsFor(["missing_scheme_information_uri"], "pid-providers"),
    ).not.toContain("ts119602.profile.pub_eaa_providers.scheme_information");
    expect(
      expectedRuleIdsFor(["jades_without_signing_time"], "pid-providers"),
    ).toContain("ts119602.profile.pid_providers.signature");
  });

  it("explains every selected defect with its normative reference", () => {
    const html = brokenListSectionHtml([
      "missing_policy_or_legal_notice",
      "jades_without_signing_time",
    ]);
    expect(html).toContain("Intentionally broken test fixture");
    expect(html).toContain("What is broken in this list");
    expect(html).toContain("clause 6.3.11");
    expect(html).toContain("ETSI TS 119 182-1");
    /* Both the violation and the conformant behaviour are stated. */
    expect(html).toContain("never both");
    expect(html).toContain("after signing");
    expect(html).toContain("before signing");
  });

  it("renders nothing for a healthy list", () => {
    expect(brokenListSectionHtml([])).toBe("");
  });

  it("surfaces the Annex H inversion note where it applies", () => {
    expect(brokenListSectionHtml(["missing_self_pointer"])).toContain(
      "injects a prohibited pointer",
    );
  });

  it("gives every defect a normative reference and conformant behaviour", () => {
    for (const spec of DEFECT_SPECS) {
      expect(spec.normativeReference, spec.id).toMatch(/ETSI TS 119/);
      expect(spec.conformantBehaviour.length, spec.id).toBeGreaterThan(20);
    }
  });
});
