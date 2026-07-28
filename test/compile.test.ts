import { describe, it, expect, beforeEach } from "vitest";
import {
  compile,
  validateAuthoring,
  validateEtsiStruct,
  resetValidators,
  WALLET_PROVIDER_LOTE_TYPE,
  WALLET_PROVIDER_STATUS_DETN,
  WALLET_PROVIDER_SCHEME_RULES,
  SERVICE_TYPE_ISSUANCE,
  LOTE_VERSION_IDENTIFIER,
} from "../src/core/index.js";
import type { AuthoringInput } from "../src/core/index.js";

const validAuthoringInput: AuthoringInput = {
  schemeOperator: {
    name: [{ lang: "en", value: "Test Authority" }],
    postalAddress: [
      {
        lang: "en",
        StreetAddress: "1 Test St",
        Country: "EU",
      },
    ],
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
        {
          lang: "en",
          StreetAddress: "2 Wallet St",
          Country: "NL",
        },
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
          serviceTypeIdentifier: SERVICE_TYPE_ISSUANCE,
          serviceName: [
            {
              lang: "en",
              value: "Wallet Issuance Service",
            },
          ],
          serviceDigitalIdentity: {
            x509Certificates: ["MIIDfakecertvalue=="],
          },
          serviceUniqueIdentifier: "http://test.nl/service/unique-id-001",
        },
      ],
    },
  ],
};

describe("compile", () => {
  beforeEach(() => {
    resetValidators();
  });

  it("produces a valid ETSI LoTE document", async () => {
    const result = compile(validAuthoringInput);
    expect(result.document).toBeDefined();
    expect(result.document.LoTE).toBeDefined();
    expect(result.document.LoTE.ListAndSchemeInformation).toBeDefined();

    const etsiResult = await validateEtsiStruct(result.document);
    expect(etsiResult.valid).toBe(true);
  });

  it("sets correct LoTE type for Wallet Provider profile", () => {
    const result = compile(validAuthoringInput);
    expect(result.document.LoTE.ListAndSchemeInformation.LoTEType).toBe(
      WALLET_PROVIDER_LOTE_TYPE,
    );
  });

  it("sets correct status determination approach", () => {
    const result = compile(validAuthoringInput);
    expect(
      result.document.LoTE.ListAndSchemeInformation.StatusDeterminationApproach,
    ).toBe(WALLET_PROVIDER_STATUS_DETN);
  });

  it("sets correct scheme type community rules", () => {
    const result = compile(validAuthoringInput);
    const rules =
      result.document.LoTE.ListAndSchemeInformation.SchemeTypeCommunityRules;
    expect(rules).toBeDefined();
    expect(rules![0]!.uriValue).toBe(WALLET_PROVIDER_SCHEME_RULES);
  });

  it("uses correct version identifier", () => {
    const result = compile(validAuthoringInput);
    expect(
      result.document.LoTE.ListAndSchemeInformation.LoTEVersionIdentifier,
    ).toBe(LOTE_VERSION_IDENTIFIER);
  });

  it("preserves sequence number from input", () => {
    const input = { ...validAuthoringInput, loTESequenceNumber: 42 };
    const result = compile(input);
    expect(
      result.document.LoTE.ListAndSchemeInformation.LoTESequenceNumber,
    ).toBe(42);
  });

  it("includes scheme operator name", () => {
    const result = compile(validAuthoringInput);
    const names =
      result.document.LoTE.ListAndSchemeInformation.SchemeOperatorName;
    expect(names).toHaveLength(1);
    expect(names[0]!.lang).toBe("en");
    expect(names[0]!.value).toBe("Test Authority");
  });

  it("includes scheme name", () => {
    const result = compile(validAuthoringInput);
    const names = result.document.LoTE.ListAndSchemeInformation.SchemeName;
    expect(names).toBeDefined();
    expect(names![0]!.value).toBe("Test Wallet Providers");
  });

  it("sets scheme territory", () => {
    const result = compile(validAuthoringInput);
    expect(result.document.LoTE.ListAndSchemeInformation.SchemeTerritory).toBe(
      "EU",
    );
  });

  it("sets issue and next update times", () => {
    const result = compile(validAuthoringInput);
    expect(
      result.document.LoTE.ListAndSchemeInformation.ListIssueDateTime,
    ).toBe("2026-01-01T00:00:00Z");
    expect(result.document.LoTE.ListAndSchemeInformation.NextUpdate).toBe(
      "2026-07-01T00:00:00Z",
    );
  });

  it("sets distribution points", () => {
    const result = compile(validAuthoringInput);
    const dp = result.document.LoTE.ListAndSchemeInformation.DistributionPoints;
    expect(dp).toBeDefined();
    expect(dp![0]).toBe("https://test.org/lote.json");
  });

  it("includes trusted entities", () => {
    const result = compile(validAuthoringInput);
    const entities = result.document.LoTE.TrustedEntitiesList;
    expect(entities).toBeDefined();
    expect(entities).toHaveLength(1);
    expect(entities![0]!.TrustedEntityInformation.TEName[0]!.value).toBe(
      "Test Wallet Provider",
    );
  });

  it("includes service information for each entity", () => {
    const result = compile(validAuthoringInput);
    const services =
      result.document.LoTE.TrustedEntitiesList![0]!.TrustedEntityServices;
    expect(services).toHaveLength(1);
    expect(services[0]!.ServiceInformation.ServiceTypeIdentifier).toBe(
      SERVICE_TYPE_ISSUANCE,
    );
  });

  it("sets ServiceUniqueIdentifier in ServiceInformationExtensions", () => {
    const result = compile(validAuthoringInput);
    const si =
      result.document.LoTE.TrustedEntitiesList![0]!.TrustedEntityServices[0]!
        .ServiceInformation;
    expect(si.ServiceInformationExtensions).toBeDefined();
    const ext = si.ServiceInformationExtensions! as Array<
      Record<string, unknown>
    >;
    expect(ext[0]!["ServiceUniqueIdentifier"]).toBe(
      "http://test.nl/service/unique-id-001",
    );
  });

  it("handles entity with trade name", () => {
    const input: AuthoringInput = {
      ...validAuthoringInput,
      entities: [
        {
          ...validAuthoringInput.entities[0]!,
          teTradeName: [{ lang: "en", value: "TRADE-NAME" }],
        },
      ],
    };
    const result = compile(input);
    const tradeName =
      result.document.LoTE.TrustedEntitiesList![0]!.TrustedEntityInformation
        .TETradeName;
    expect(tradeName).toBeDefined();
    expect(tradeName![0]!.value).toBe("TRADE-NAME");
  });

  it("handles entity with service supply points", () => {
    const input: AuthoringInput = {
      ...validAuthoringInput,
      entities: [
        {
          ...validAuthoringInput.entities[0]!,
          services: [
            {
              ...validAuthoringInput.entities[0]!.services[0]!,
              serviceSupplyPoints: [{ uriValue: "https://api.test.nl/wallet" }],
            },
          ],
        },
      ],
    };
    const result = compile(input);
    const sp =
      result.document.LoTE.TrustedEntitiesList![0]!.TrustedEntityServices[0]!
        .ServiceInformation.ServiceSupplyPoints;
    expect(sp).toBeDefined();
    expect(sp![0]!.uriValue).toBe("https://api.test.nl/wallet");
  });

  it("handles scheme information URI", () => {
    const input: AuthoringInput = {
      ...validAuthoringInput,
      scheme: {
        ...validAuthoringInput.scheme,
        schemeInformationURI: [
          { lang: "en", uriValue: "https://test.org/scheme-info" },
        ],
      },
    };
    const result = compile(input);
    const info =
      result.document.LoTE.ListAndSchemeInformation.SchemeInformationURI;
    expect(info).toBeDefined();
    expect(info![0]!.uriValue).toBe("https://test.org/scheme-info");
  });

  it("handles multiple entities", () => {
    const input: AuthoringInput = {
      ...validAuthoringInput,
      entities: [
        validAuthoringInput.entities[0]!,
        {
          ...validAuthoringInput.entities[0]!,
          teName: [{ lang: "en", value: "Second Provider" }],
          services: [
            {
              ...validAuthoringInput.entities[0]!.services[0]!,
              serviceUniqueIdentifier: "http://test2.nl/service/unique-id-002",
            },
          ],
        },
      ],
    };
    const result = compile(input);
    expect(result.document.LoTE.TrustedEntitiesList).toHaveLength(2);
    expect(
      result.document.LoTE.TrustedEntitiesList![1]!.TrustedEntityInformation
        .TEName[0]!.value,
    ).toBe("Second Provider");
  });
});

describe("validateAuthoring", () => {
  beforeEach(() => {
    resetValidators();
  });

  it("accepts valid authoring input", async () => {
    const result = await validateAuthoring(validAuthoringInput);
    expect(result.valid).toBe(true);
  });

  it("rejects missing schemeOperator", async () => {
    const input = { ...validAuthoringInput } as Partial<AuthoringInput>;
    delete input.schemeOperator;
    const result = await validateAuthoring(input);
    expect(result.valid).toBe(false);
  });

  it("rejects missing entities", async () => {
    const input = { ...validAuthoringInput } as Partial<AuthoringInput>;
    delete input.entities;
    const result = await validateAuthoring(input);
    expect(result.valid).toBe(false);
  });

  it("rejects missing listIssueDateTime", async () => {
    const input = { ...validAuthoringInput } as Partial<AuthoringInput>;
    delete input.listIssueDateTime;
    const result = await validateAuthoring(input);
    expect(result.valid).toBe(false);
  });

  it("rejects missing serviceUniqueIdentifier in service", async () => {
    const input = structuredClone(validAuthoringInput);
    const svc = input.entities[0]!.services[0]! as unknown as Record<
      string,
      unknown
    >;
    delete svc.serviceUniqueIdentifier;
    const result = await validateAuthoring(input);
    expect(result.valid).toBe(false);
  });
});

describe("validateEtsiStruct", () => {
  beforeEach(() => {
    resetValidators();
  });

  it("accepts a valid compiled LoTE", async () => {
    const compiled = compile(validAuthoringInput);
    const result = await validateEtsiStruct(compiled.document);
    expect(result.valid).toBe(true);
  });

  it("rejects missing LoTE root", async () => {
    const result = await validateEtsiStruct({});
    expect(result.valid).toBe(false);
  });

  it("rejects missing ListAndSchemeInformation", async () => {
    const result = await validateEtsiStruct({ LoTE: {} });
    expect(result.valid).toBe(false);
  });

  it("rejects invalid LoTEVersionIdentifier type", async () => {
    const invalid = compile(validAuthoringInput).document;
    // @ts-expect-error testing validation
    invalid.LoTE.ListAndSchemeInformation.LoTEVersionIdentifier =
      "not-a-number";
    const result = await validateEtsiStruct(invalid);
    expect(result.valid).toBe(false);
  });

  it("rejects empty SchemeOperatorName", async () => {
    const invalid = compile(validAuthoringInput).document;
    invalid.LoTE.ListAndSchemeInformation.SchemeOperatorName = [];
    const result = await validateEtsiStruct(invalid);
    expect(result.valid).toBe(false);
  });
});
