import { describe, expect, it } from "vitest";
import { compileTrustedList } from "../src/core/tsl612/compile.js";
import {
  TslReadError,
  readTrustedList,
  readTrustedListMetadata,
} from "../src/core/tsl612/read.js";
import type { TrustedListInput } from "../src/core/tsl612/model.js";
import {
  EU_LOTL_LOCATION,
  EU_LOTL_SCHEME_RULES,
  EU_LOTL_SCHEME_TERRITORY,
  EU_LOTL_TSL_TYPE,
  SVCSTATUS_DEPRECATED_AT_NATIONAL_LEVEL,
  SVCSTATUS_GRANTED,
  SVCSTATUS_RECOGNISED_AT_NATIONAL_LEVEL,
  SVCTYPE_EAA,
  SVCTYPE_QEAA,
  TSL_MEDIA_TYPE,
} from "../src/core/tsl612/constants.js";

const CERT = Buffer.from("certificate-der-bytes").toString("base64");
const SKI = Buffer.from("0123456789abcdef0123").toString("base64");

/** Every optional component the model has, so the round trip covers them all. */
function fullList(): TrustedListInput {
  return {
    schemeInformation: {
      sequenceNumber: 3,
      schemeTerritory: "IT",
      schemeOperatorName: "Agenzia per l'Italia Digitale",
      schemeOperatorAddress: {
        streetAddress: "Via Liszt 21",
        locality: "Roma",
        stateOrProvince: "RM",
        postalCode: "00144",
        countryName: "IT",
      },
      schemeOperatorElectronicAddress: {
        email: "trustedlist@example.it",
        website: "https://example.it",
        telephone: "+390612345678",
      },
      schemeName: "IT:Agenzia per l'Italia Digitale",
      schemeInformationUri: "https://example.it/scheme",
      nationalSchemeRulesUri: "https://example.it/scheme-rules",
      policyOrLegalNoticeUri: "https://example.it/policy",
      distributionPointUri: "https://example.it/tl/trusted-list.xml",
      listIssueDateTime: "2026-08-03T10:00:00Z",
      nextUpdate: "2026-12-03T10:00:00Z",
      lotlPointer: {
        location: EU_LOTL_LOCATION,
        certificatesBase64Der: [CERT, CERT],
        schemeOperatorNames: ["European Commission"],
        schemeTypeCommunityRules: EU_LOTL_SCHEME_RULES,
        schemeTerritory: EU_LOTL_SCHEME_TERRITORY,
        tslType: EU_LOTL_TSL_TYPE,
        mimeType: TSL_MEDIA_TYPE,
      },
    },
    providers: [
      {
        tspName: "Example EAA Provider",
        tspTradeNames: ["VATIT-12345678901", "Trading As Example"],
        tspAddress: {
          streetAddress: "Via Roma 1",
          locality: "Milano",
          postalCode: "20121",
          countryName: "IT",
        },
        tspElectronicAddress: {
          email: "info@example.it",
          website: "https://provider.example.it",
          telephone: "+390212345678",
        },
        tspInformationUri: "https://provider.example.it/practices",
        services: [
          {
            serviceTypeIdentifier: SVCTYPE_EAA,
            serviceName: "Example EAA Issuance",
            digitalIdentity: { x509CertificateBase64Der: CERT },
            serviceStatus: SVCSTATUS_DEPRECATED_AT_NATIONAL_LEVEL,
            statusStartingTime: "2026-09-01T09:00:00Z",
            schemeServiceDefinitionUri: "https://example.it/service-definition",
            tspServiceDefinitionUri: "https://provider.example.it/service",
            serviceSupplyPoints: [
              "https://provider.example.it/supply",
              "https://provider.example.it/status",
            ],
            serviceHistory: [
              {
                serviceTypeIdentifier: SVCTYPE_EAA,
                serviceName: "Example EAA Issuance",
                digitalIdentity: { x509SkiBase64: SKI },
                serviceStatus: SVCSTATUS_RECOGNISED_AT_NATIONAL_LEVEL,
                statusStartingTime: "2026-08-03T10:00:00Z",
              },
            ],
          },
        ],
      },
      {
        tspName: "Example QEAA Provider",
        tspTradeNames: ["NTRIT-REA-MI-7654321"],
        tspAddress: {
          streetAddress: "Corso Buenos Aires 9",
          locality: "Milano",
          countryName: "IT",
        },
        tspElectronicAddress: {
          email: "qeaa@example.it",
          website: "https://qeaa.example.it",
        },
        tspInformationUri: "https://qeaa.example.it/practices",
        services: [
          {
            serviceTypeIdentifier: SVCTYPE_QEAA,
            serviceName: "Example QEAA Issuance",
            digitalIdentity: { x509CertificateBase64Der: CERT },
            serviceStatus: SVCSTATUS_GRANTED,
            statusStartingTime: "2026-08-03T10:00:00Z",
          },
        ],
      },
    ],
  };
}

describe("readTrustedList", () => {
  it("round-trips every component the model can express", () => {
    const xml = compileTrustedList(fullList());
    expect(compileTrustedList(readTrustedList(xml))).toBe(xml);
  });

  it("round-trips an empty first version", () => {
    const xml = compileTrustedList({
      schemeInformation: fullList().schemeInformation,
    });
    expect(compileTrustedList(readTrustedList(xml))).toBe(xml);
  });

  it("recovers the model values, not just the bytes", () => {
    const original = fullList();
    const read = readTrustedList(compileTrustedList(original));
    expect(read).toEqual(original);
  });

  it("reads a signed list, ignoring the signature", () => {
    const xml = compileTrustedList(fullList());
    const signed = xml.replace(
      "</TrustServiceStatusList>",
      '  <ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:SignatureValue>AAAA</ds:SignatureValue></ds:Signature>\n</TrustServiceStatusList>',
    );
    expect(readTrustedList(signed)).toEqual(readTrustedList(xml));
  });

  it("refuses a list whose version identifier is not 6", () => {
    const xml = compileTrustedList(fullList()).replace(
      "<TSLVersionIdentifier>6</TSLVersionIdentifier>",
      "<TSLVersionIdentifier>5</TSLVersionIdentifier>",
    );
    expect(() => readTrustedList(xml)).toThrow(/TSLVersionIdentifier/);
  });

  it("refuses a list with Scheme Extensions it could not reproduce", () => {
    const xml = compileTrustedList(fullList()).replace(
      "  </SchemeInformation>",
      '    <SchemeExtensions><Extension Critical="false">x</Extension></SchemeExtensions>\n  </SchemeInformation>',
    );
    expect(() => readTrustedList(xml)).toThrow(TslReadError);
  });

  it("refuses a list with no pointer to the EU LOTL", () => {
    const full = compileTrustedList(fullList());
    const start = full.indexOf("    <PointersToOtherTSL>");
    const end =
      full.indexOf("</PointersToOtherTSL>") + "</PointersToOtherTSL>\n".length;
    expect(() =>
      readTrustedList(full.slice(0, start) + full.slice(end)),
    ).toThrow(/EU LOTL/);
  });

  it("refuses malformed XML", () => {
    expect(() => readTrustedList("<TrustServiceStatusList>")).toThrow(
      TslReadError,
    );
  });
});

describe("readTrustedListMetadata", () => {
  it("reports the TS 119 612 values a manifest publishes", () => {
    const metadata = readTrustedListMetadata(compileTrustedList(fullList()));
    expect(metadata).toMatchObject({
      tslTag: "http://uri.etsi.org/19612/TSLTag",
      tslVersionIdentifier: 6,
      tslSequenceNumber: 3,
      schemeTerritory: "IT",
      historicalInformationPeriod: 65535,
      providerCount: 2,
      serviceCount: 2,
    });
  });

  it("reports the distinct service types the version publishes", () => {
    const metadata = readTrustedListMetadata(compileTrustedList(fullList()));
    expect(metadata.serviceTypes).toEqual([SVCTYPE_EAA, SVCTYPE_QEAA]);
  });

  it("reports no service type for an empty first version", () => {
    const xml = compileTrustedList({
      schemeInformation: fullList().schemeInformation,
    });
    const metadata = readTrustedListMetadata(xml);
    expect(metadata.serviceTypes).toEqual([]);
    expect(metadata.providerCount).toBe(0);
  });

  it("refuses a document that is not tagged as a Trusted List", () => {
    const xml = compileTrustedList(fullList()).replace(
      'TSLTag="http://uri.etsi.org/19612/TSLTag"',
      'TSLTag="http://example.invalid/tag"',
    );
    expect(() => readTrustedListMetadata(xml)).toThrow(/not tagged/);
  });
});
