import { describe, expect, it } from "vitest";
import {
  TslCompileError,
  compileTrustedList,
} from "../src/core/tsl612/compile.js";
import { validateTslXml } from "../src/core/tsl612/schema.js";
import type {
  TrustedListInput,
  TslProvider,
} from "../src/core/tsl612/model.js";
import {
  EU_LOTL_LOCATION,
  EU_LOTL_SCHEME_RULES,
  EU_LOTL_SCHEME_TERRITORY,
  EU_LOTL_TSL_TYPE,
  SVCSTATUS_GRANTED,
  SVCSTATUS_RECOGNISED_AT_NATIONAL_LEVEL,
  SVCSTATUS_WITHDRAWN,
  SVCTYPE_EAA,
  SVCTYPE_QEAA,
  TSL_MEDIA_TYPE,
} from "../src/core/tsl612/constants.js";

/** A syntactically valid Base64 DER stand-in; the compiler only checks the encoding. */
const CERT = Buffer.from("certificate-der-bytes").toString("base64");
const SKI = Buffer.from("0123456789abcdef0123").toString("base64");

function schemeInformation(): TrustedListInput["schemeInformation"] {
  return {
    sequenceNumber: 1,
    schemeTerritory: "IT",
    schemeOperatorName: "Agenzia per l'Italia Digitale",
    schemeOperatorAddress: {
      streetAddress: "Via Liszt 21",
      locality: "Roma",
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
      certificatesBase64Der: [CERT],
      schemeOperatorNames: ["European Commission"],
      schemeTypeCommunityRules: EU_LOTL_SCHEME_RULES,
      schemeTerritory: EU_LOTL_SCHEME_TERRITORY,
      tslType: EU_LOTL_TSL_TYPE,
      mimeType: TSL_MEDIA_TYPE,
    },
  };
}

function provider(overrides: Partial<TslProvider> = {}): TslProvider {
  return {
    tspName: "Example Attestation Provider S.p.A.",
    tspTradeNames: ["VATIT-12345678901"],
    tspAddress: {
      streetAddress: "Via Roma 1",
      locality: "Milano",
      postalCode: "20121",
      countryName: "IT",
    },
    tspElectronicAddress: {
      email: "info@example.it",
      website: "https://provider.example.it",
    },
    tspInformationUri: "https://provider.example.it/practices",
    services: [
      {
        serviceTypeIdentifier: SVCTYPE_EAA,
        serviceName: "Example EAA Issuance",
        digitalIdentity: { x509CertificateBase64Der: CERT },
        serviceStatus: SVCSTATUS_RECOGNISED_AT_NATIONAL_LEVEL,
        statusStartingTime: "2026-08-03T10:00:00Z",
      },
    ],
    ...overrides,
  };
}

describe("compileTrustedList", () => {
  it("compiles an empty first version that the pinned schemas accept", () => {
    const xml = compileTrustedList({ schemeInformation: schemeInformation() });
    expect(validateTslXml(xml)).toEqual({ valid: true, findings: [] });
  });

  it("omits TrustServiceProviderList entirely when there is no provider", () => {
    const xml = compileTrustedList({ schemeInformation: schemeInformation() });
    expect(xml).not.toContain("TrustServiceProviderList");
    const empty = compileTrustedList({
      schemeInformation: schemeInformation(),
      providers: [],
    });
    expect(empty).toBe(xml);
  });

  it("publishes the fixed TS 119 612 values", () => {
    const xml = compileTrustedList({ schemeInformation: schemeInformation() });
    expect(xml).toContain('TSLTag="http://uri.etsi.org/19612/TSLTag"');
    expect(xml).toContain("<TSLVersionIdentifier>6</TSLVersionIdentifier>");
    expect(xml).toContain("<TSLSequenceNumber>1</TSLSequenceNumber>");
    expect(xml).toContain(
      "<TSLType>http://uri.etsi.org/TrstSvc/TrustedList/TSLType/EUgeneric</TSLType>",
    );
    expect(xml).toContain(
      "<StatusDeterminationApproach>http://uri.etsi.org/TrstSvc/TrustedList/StatusDetn/EUappropriate</StatusDeterminationApproach>",
    );
    expect(xml).toContain(
      "<HistoricalInformationPeriod>65535</HistoricalInformationPeriod>",
    );
  });

  it("publishes both the EU common and the per-country scheme rules", () => {
    const xml = compileTrustedList({ schemeInformation: schemeInformation() });
    expect(xml).toContain(
      "http://uri.etsi.org/TrstSvc/TrustedList/schemerules/EUcommon",
    );
    expect(xml).toContain(
      "http://uri.etsi.org/TrstSvc/TrustedList/schemerules/IT",
    );
  });

  it("sets the scheme territory to the Member State, never EU", () => {
    const xml = compileTrustedList({ schemeInformation: schemeInformation() });
    expect(xml).toContain("<SchemeTerritory>IT</SchemeTerritory>");
    expect(() =>
      compileTrustedList({
        schemeInformation: { ...schemeInformation(), schemeTerritory: "EU" },
      }),
    ).toThrow(TslCompileError);
  });

  it("publishes no Scheme Extensions", () => {
    const xml = compileTrustedList({ schemeInformation: schemeInformation() });
    expect(xml).not.toContain("SchemeExtensions");
  });

  it("carries the pointer to the EU LOTL with its identity and qualifiers", () => {
    const xml = compileTrustedList({ schemeInformation: schemeInformation() });
    expect(xml).toContain(`<TSLLocation>${EU_LOTL_LOCATION}</TSLLocation>`);
    expect(xml).toContain(`<X509Certificate>${CERT}</X509Certificate>`);
    expect(xml).toContain(`<tslx:MimeType>${TSL_MEDIA_TYPE}</tslx:MimeType>`);
    expect(xml).toContain(`<TSLType>${EU_LOTL_TSL_TYPE}</TSLType>`);
    expect(xml).toContain("<SchemeTerritory>EU</SchemeTerritory>");
  });

  it("refuses a LOTL pointer with no digital identity", () => {
    const scheme = schemeInformation();
    expect(() =>
      compileTrustedList({
        schemeInformation: {
          ...scheme,
          lotlPointer: { ...scheme.lotlPointer, certificatesBase64Der: [] },
        },
      }),
    ).toThrow(/at least one digital identity/);
  });

  it("compiles an EAA provider that the pinned schemas accept", () => {
    const xml = compileTrustedList({
      schemeInformation: schemeInformation(),
      providers: [provider()],
    });
    expect(validateTslXml(xml)).toEqual({ valid: true, findings: [] });
    expect(xml).toContain(
      `<ServiceTypeIdentifier>${SVCTYPE_EAA}</ServiceTypeIdentifier>`,
    );
    expect(xml).toContain(
      `<ServiceStatus>${SVCSTATUS_RECOGNISED_AT_NATIONAL_LEVEL}</ServiceStatus>`,
    );
  });

  it("compiles a QEAA provider with the qualified status vocabulary", () => {
    const xml = compileTrustedList({
      schemeInformation: schemeInformation(),
      providers: [
        provider({
          services: [
            {
              serviceTypeIdentifier: SVCTYPE_QEAA,
              serviceName: "Example QEAA Issuance",
              digitalIdentity: { x509CertificateBase64Der: CERT },
              serviceStatus: SVCSTATUS_GRANTED,
              statusStartingTime: "2026-08-03T10:00:00Z",
            },
          ],
        }),
      ],
    });
    expect(validateTslXml(xml)).toEqual({ valid: true, findings: [] });
    expect(xml).toContain(
      `<ServiceTypeIdentifier>${SVCTYPE_QEAA}</ServiceTypeIdentifier>`,
    );
    expect(xml).toContain(
      `<ServiceStatus>${SVCSTATUS_GRANTED}</ServiceStatus>`,
    );
  });

  it("publishes the registration identifier as a TSP trade name", () => {
    const xml = compileTrustedList({
      schemeInformation: schemeInformation(),
      providers: [provider({ tspTradeNames: ["NTRIT-REA-MI-1234567"] })],
    });
    expect(xml).toContain('<Name xml:lang="en">NTRIT-REA-MI-1234567</Name>');
  });

  it("compiles service history with an SKI and no certificate", () => {
    const xml = compileTrustedList({
      schemeInformation: schemeInformation(),
      providers: [
        provider({
          services: [
            {
              serviceTypeIdentifier: SVCTYPE_QEAA,
              serviceName: "Example QEAA Issuance",
              digitalIdentity: { x509CertificateBase64Der: CERT },
              serviceStatus: SVCSTATUS_WITHDRAWN,
              statusStartingTime: "2026-09-01T09:00:00Z",
              serviceHistory: [
                {
                  serviceTypeIdentifier: SVCTYPE_QEAA,
                  serviceName: "Example QEAA Issuance",
                  digitalIdentity: { x509SkiBase64: SKI },
                  serviceStatus: SVCSTATUS_GRANTED,
                  statusStartingTime: "2026-08-03T10:00:00Z",
                },
              ],
            },
          ],
        }),
      ],
    });
    expect(validateTslXml(xml)).toEqual({ valid: true, findings: [] });
    const history = xml.slice(xml.indexOf("<ServiceHistory>"));
    expect(history).toContain(`<X509SKI>${SKI}</X509SKI>`);
    expect(history).not.toContain("X509Certificate");
  });

  it("refuses a history instance that republishes the certificate", () => {
    expect(() =>
      compileTrustedList({
        schemeInformation: schemeInformation(),
        providers: [
          provider({
            services: [
              {
                serviceTypeIdentifier: SVCTYPE_EAA,
                serviceName: "Example EAA Issuance",
                digitalIdentity: { x509CertificateBase64Der: CERT },
                serviceStatus: SVCSTATUS_RECOGNISED_AT_NATIONAL_LEVEL,
                statusStartingTime: "2026-08-03T10:00:00Z",
                serviceHistory: [
                  {
                    serviceTypeIdentifier: SVCTYPE_EAA,
                    serviceName: "Example EAA Issuance",
                    digitalIdentity: { x509CertificateBase64Der: CERT },
                    serviceStatus: SVCSTATUS_RECOGNISED_AT_NATIONAL_LEVEL,
                    statusStartingTime: "2026-07-01T10:00:00Z",
                  },
                ],
              },
            ],
          }),
        ],
      }),
    ).toThrow(/must not carry an X509Certificate/);
  });

  it("caps the update period at six months", () => {
    expect(() =>
      compileTrustedList({
        schemeInformation: {
          ...schemeInformation(),
          nextUpdate: "2027-03-03T10:00:00Z",
        },
      }),
    ).toThrow(/at most 6 months/);
  });

  it("refuses a next update that is not after the issue time", () => {
    expect(() =>
      compileTrustedList({
        schemeInformation: {
          ...schemeInformation(),
          nextUpdate: "2026-08-03T10:00:00Z",
        },
      }),
    ).toThrow(/later than ListIssueDateTime/);
  });

  it("refuses a non-UTC instant", () => {
    expect(() =>
      compileTrustedList({
        schemeInformation: {
          ...schemeInformation(),
          listIssueDateTime: "2026-08-03T10:00:00.000Z",
        },
      }),
    ).toThrow(/YYYY-MM-DDThh:mm:ssZ/);
  });

  it("refuses a sequence number below 1", () => {
    expect(() =>
      compileTrustedList({
        schemeInformation: { ...schemeInformation(), sequenceNumber: 0 },
      }),
    ).toThrow(/positive integer/);
  });

  it("refuses a certificate that is not strict Base64 DER", () => {
    expect(() =>
      compileTrustedList({
        schemeInformation: schemeInformation(),
        providers: [
          provider({
            services: [
              {
                serviceTypeIdentifier: SVCTYPE_EAA,
                serviceName: "Example EAA Issuance",
                digitalIdentity: {
                  x509CertificateBase64Der:
                    "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----",
                },
                serviceStatus: SVCSTATUS_RECOGNISED_AT_NATIONAL_LEVEL,
                statusStartingTime: "2026-08-03T10:00:00Z",
              },
            ],
          }),
        ],
      }),
    ).toThrow(/strict Base64 DER/);
  });

  it("escapes markup in collected text", () => {
    const xml = compileTrustedList({
      schemeInformation: {
        ...schemeInformation(),
        schemeOperatorName: 'Ministry of <Trust> & "Lists"',
      },
    });
    expect(xml).toContain('Ministry of &lt;Trust&gt; &amp; "Lists"');
    expect(validateTslXml(xml).valid).toBe(true);
  });

  it("is deterministic", () => {
    const input = {
      schemeInformation: schemeInformation(),
      providers: [provider()],
    };
    expect(compileTrustedList(input)).toBe(compileTrustedList(input));
  });

  it("increments only the sequence number between versions", () => {
    const first = compileTrustedList({
      schemeInformation: schemeInformation(),
    });
    const second = compileTrustedList({
      schemeInformation: { ...schemeInformation(), sequenceNumber: 2 },
    });
    expect(second).toBe(
      first.replace(
        "<TSLSequenceNumber>1</TSLSequenceNumber>",
        "<TSLSequenceNumber>2</TSLSequenceNumber>",
      ),
    );
  });
});
