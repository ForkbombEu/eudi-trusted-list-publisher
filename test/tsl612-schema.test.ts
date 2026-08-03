import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import {
  TSL_SCHEMA_DIR,
  readVendoredSchema,
  resetTslSchemaValidator,
  validateTslXml,
} from "../src/core/tsl612/schema.js";
import {
  VENDORED_SCHEMAS,
  schemaFileForUrl,
} from "../src/core/tsl612/schema-sources.js";

/**
 * A minimal but schema-complete TS 119 612 Trusted List: an empty first
 * version, which omits TrustServiceProviderList, plus the mandatory pointer to
 * the EU LOTL. The compiler in a later phase produces this shape; here it only
 * has to exercise the pinned schemas.
 */
const EMPTY_TSL = `<?xml version="1.0" encoding="UTF-8"?>
<TrustServiceStatusList xmlns="http://uri.etsi.org/02231/v2#" xmlns:tslx="http://uri.etsi.org/02231/v2/additionaltypes#" TSLTag="http://uri.etsi.org/19612/TSLTag">
 <SchemeInformation>
  <TSLVersionIdentifier>6</TSLVersionIdentifier>
  <TSLSequenceNumber>1</TSLSequenceNumber>
  <TSLType>http://uri.etsi.org/TrstSvc/TrustedList/TSLType/EUgeneric</TSLType>
  <SchemeOperatorName><Name xml:lang="en">Test Scheme Operator</Name></SchemeOperatorName>
  <SchemeOperatorAddress>
   <PostalAddresses><PostalAddress xml:lang="en"><StreetAddress>Via Roma 1</StreetAddress><Locality>Roma</Locality><CountryName>IT</CountryName></PostalAddress></PostalAddresses>
   <ElectronicAddress><URI xml:lang="en">mailto:operator@example.eu</URI></ElectronicAddress>
  </SchemeOperatorAddress>
  <SchemeName><Name xml:lang="en">IT:Test Scheme Operator</Name></SchemeName>
  <SchemeInformationURI><URI xml:lang="en">https://example.eu/scheme</URI></SchemeInformationURI>
  <StatusDeterminationApproach>http://uri.etsi.org/TrstSvc/TrustedList/StatusDetn/EUappropriate</StatusDeterminationApproach>
  <SchemeTypeCommunityRules><URI xml:lang="en">http://uri.etsi.org/TrstSvc/TrustedList/schemerules/EUcommon</URI></SchemeTypeCommunityRules>
  <SchemeTerritory>IT</SchemeTerritory>
  <PolicyOrLegalNotice><TSLPolicy xml:lang="en">https://example.eu/policy</TSLPolicy></PolicyOrLegalNotice>
  <HistoricalInformationPeriod>65535</HistoricalInformationPeriod>
  <PointersToOtherTSL><OtherTSLPointer>
    <TSLLocation>https://ec.europa.eu/tools/lotl/eu-lotl.xml</TSLLocation>
    <AdditionalInformation><OtherInformation><tslx:MimeType>application/vnd.etsi.tsl+xml</tslx:MimeType></OtherInformation></AdditionalInformation>
  </OtherTSLPointer></PointersToOtherTSL>
  <ListIssueDateTime>2026-08-03T00:00:00Z</ListIssueDateTime>
  <NextUpdate><dateTime>2026-12-03T00:00:00Z</dateTime></NextUpdate>
 </SchemeInformation>
</TrustServiceStatusList>`;

describe("vendored TS 119 612 schemas", () => {
  it("matches the SHA-256 hashes recorded in STANDARDS.md", () => {
    for (const schema of VENDORED_SCHEMAS) {
      const actual = createHash("sha256")
        .update(readVendoredSchema(schema.file))
        .digest("hex");
      expect(`${schema.file}:${actual}`).toBe(
        `${schema.file}:${schema.sha256}`,
      );
    }
  });

  it("vendors every file the directory holds, plus the ETSI licence", () => {
    const onDisk = readdirSync(TSL_SCHEMA_DIR).sort();
    const declared = VENDORED_SCHEMAS.map((schema) => schema.file);
    expect(onDisk).toEqual([...declared, "LICENSE"].sort());
  });

  it("resolves an import over either http or https", () => {
    expect(schemaFileForUrl("http://www.w3.org/2001/xml.xsd")).toBe("xml.xsd");
    expect(schemaFileForUrl("https://www.w3.org/2001/xml.xsd")).toBe("xml.xsd");
    expect(
      schemaFileForUrl("https://example.invalid/other.xsd"),
    ).toBeUndefined();
  });
});

describe("validateTslXml", () => {
  it("accepts an empty first version with a pointer to the EU LOTL", () => {
    expect(validateTslXml(EMPTY_TSL)).toEqual({ valid: true, findings: [] });
  });

  it("reports the element and line of a schema violation", () => {
    const broken = EMPTY_TSL.replace(
      "<TSLSequenceNumber>1</TSLSequenceNumber>",
      "<TSLSequenceNumber>0</TSLSequenceNumber>",
    );
    const result = validateTslXml(broken);
    expect(result.valid).toBe(false);
    expect(result.findings[0]?.message).toContain("TSLSequenceNumber");
  });

  it("rejects a list whose mandatory HistoricalInformationPeriod is absent", () => {
    const broken = EMPTY_TSL.replace(
      "<HistoricalInformationPeriod>65535</HistoricalInformationPeriod>",
      "",
    );
    expect(validateTslXml(broken).valid).toBe(false);
  });

  it("rejects scheme information given out of the schema's order", () => {
    const broken = EMPTY_TSL.replace(
      "<SchemeTerritory>IT</SchemeTerritory>",
      "",
    ).replace(
      "<HistoricalInformationPeriod>",
      "<SchemeTerritory>IT</SchemeTerritory><HistoricalInformationPeriod>",
    );
    expect(validateTslXml(broken).valid).toBe(false);
  });

  it("reports malformed XML as a finding rather than throwing", () => {
    const result = validateTslXml("<TrustServiceStatusList>");
    expect(result.valid).toBe(false);
    expect(result.findings.length).toBeGreaterThan(0);
  });

  it("rebuilds the validator after a reset", () => {
    resetTslSchemaValidator();
    expect(validateTslXml(EMPTY_TSL).valid).toBe(true);
  });
});
