/**
 * Compiles the authoring model into a namespace-correct TS 119 612
 * `TrustServiceStatusList`.
 *
 * The output is deterministic: the same input always produces the same bytes,
 * because the signature is computed over those bytes and a publication that
 * cannot be reproduced cannot be checked. Element order follows the schema
 * sequence exactly — the schema is a sequence, not a set, so a reordered list
 * is an invalid list.
 */
import {
  DEFAULT_LANGUAGE,
  EU_LOTL_SCHEME_RULES,
  HISTORICAL_INFORMATION_PERIOD,
  MAX_NEXT_UPDATE_MONTHS,
  NS_TSL,
  NS_TSLX,
  SCHEME_RULES_EU_COMMON,
  STATUS_DETERMINATION_EU_APPROPRIATE,
  TSL_TAG,
  TSL_TYPE_EU_GENERIC,
  TSL_VERSION_IDENTIFIER,
  schemeRulesForTerritory,
} from "./constants.js";
import type {
  TrustedListInput,
  TslDigitalIdentity,
  TslElectronicAddress,
  TslPostalAddress,
  TslProvider,
  TslService,
  TslServiceHistoryInstance,
} from "./model.js";
import {
  EU_MEMBER_STATE_CODES,
  isStrictBase64,
  isUtcDateTime,
  mailtoUri,
  telUri,
} from "../model/lexical.js";

export class TslCompileError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(message);
    this.name = "TslCompileError";
  }
}

function fail(path: string, message: string): never {
  throw new TslCompileError(message, path);
}

const INDENT = "  ";

function escapeText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttribute(value: string): string {
  return escapeText(value).replace(/"/g, "&quot;");
}

/**
 * A minimal XML writer. It emits one element per line with two-space indents,
 * which keeps a published list readable and diffable; the signature is
 * computed over the canonical form, so the layout is a presentation choice and
 * not a security-relevant one.
 */
class XmlWriter {
  private readonly lines: string[] = [];
  private depth = 0;

  open(name: string, attributes: Record<string, string> = {}): this {
    const rendered = Object.entries(attributes)
      .map(([key, value]) => ` ${key}="${escapeAttribute(value)}"`)
      .join("");
    this.lines.push(`${INDENT.repeat(this.depth)}<${name}${rendered}>`);
    this.depth += 1;
    return this;
  }

  close(name: string): this {
    this.depth -= 1;
    this.lines.push(`${INDENT.repeat(this.depth)}</${name}>`);
    return this;
  }

  leaf(
    name: string,
    text: string,
    attributes: Record<string, string> = {},
  ): this {
    const rendered = Object.entries(attributes)
      .map(([key, value]) => ` ${key}="${escapeAttribute(value)}"`)
      .join("");
    this.lines.push(
      `${INDENT.repeat(this.depth)}<${name}${rendered}>${escapeText(
        text,
      )}</${name}>`,
    );
    return this;
  }

  /** A name or URI carrying the mandatory `xml:lang` of clause 5.1.4. */
  localized(name: string, text: string): this {
    return this.leaf(name, text, { "xml:lang": DEFAULT_LANGUAGE });
  }

  toString(): string {
    return this.lines.join("\n");
  }
}

function requireText(value: string | undefined, path: string): string {
  if (typeof value !== "string" || value.trim() === "")
    fail(path, `${path} is required and must not be empty.`);
  return value;
}

function requireUtc(value: string, path: string): string {
  if (!isUtcDateTime(value))
    fail(
      path,
      `${path} must be a UTC instant of the form YYYY-MM-DDThh:mm:ssZ, got '${value}'.`,
    );
  return value;
}

/**
 * Clause 5.3.15 caps the update period at six months. The comparison is
 * calendar-based, matching how the interval is written down, rather than a
 * fixed number of days.
 */
function checkNextUpdate(issue: string, nextUpdate: string): void {
  const issued = new Date(issue);
  const next = new Date(nextUpdate);
  if (next.getTime() <= issued.getTime())
    fail(
      "schemeInformation.nextUpdate",
      "NextUpdate must be later than ListIssueDateTime.",
    );
  const limit = new Date(issued);
  limit.setUTCMonth(limit.getUTCMonth() + MAX_NEXT_UPDATE_MONTHS);
  if (next.getTime() > limit.getTime())
    fail(
      "schemeInformation.nextUpdate",
      `NextUpdate must be at most ${MAX_NEXT_UPDATE_MONTHS} months after ListIssueDateTime.`,
    );
}

function writePostalAddress(
  writer: XmlWriter,
  address: TslPostalAddress,
  path: string,
): void {
  writer.open("PostalAddresses");
  writer.open("PostalAddress", { "xml:lang": DEFAULT_LANGUAGE });
  writer.leaf(
    "StreetAddress",
    requireText(address.streetAddress, `${path}.streetAddress`),
  );
  writer.leaf("Locality", requireText(address.locality, `${path}.locality`));
  if (address.stateOrProvince)
    writer.leaf("StateOrProvince", address.stateOrProvince);
  if (address.postalCode) writer.leaf("PostalCode", address.postalCode);
  writer.leaf(
    "CountryName",
    requireText(address.countryName, `${path}.countryName`),
  );
  writer.close("PostalAddress");
  writer.close("PostalAddresses");
}

function writeElectronicAddress(
  writer: XmlWriter,
  address: TslElectronicAddress,
  path: string,
): void {
  writer.open("ElectronicAddress");
  writer.localized(
    "URI",
    mailtoUri(requireText(address.email, `${path}.email`)),
  );
  writer.localized("URI", requireText(address.website, `${path}.website`));
  if (address.telephone) writer.localized("URI", telUri(address.telephone));
  writer.close("ElectronicAddress");
}

function writeDigitalIdentity(
  writer: XmlWriter,
  identity: TslDigitalIdentity,
  path: string,
): void {
  const hasCertificate = typeof identity.x509CertificateBase64Der === "string";
  const hasSki = typeof identity.x509SkiBase64 === "string";
  if (!hasCertificate && !hasSki)
    fail(path, `${path} must carry an X509Certificate or an X509SKI.`);
  writer.open("ServiceDigitalIdentity");
  if (hasCertificate) {
    const value = identity.x509CertificateBase64Der!;
    if (!isStrictBase64(value))
      fail(
        `${path}.x509CertificateBase64Der`,
        "The service certificate must be strict Base64 DER, with no PEM armour and no whitespace.",
      );
    writer.open("DigitalId");
    writer.leaf("X509Certificate", value);
    writer.close("DigitalId");
  }
  if (hasSki) {
    const value = identity.x509SkiBase64!;
    if (!isStrictBase64(value))
      fail(
        `${path}.x509SkiBase64`,
        "The subject key identifier must be strict Base64.",
      );
    writer.open("DigitalId");
    writer.leaf("X509SKI", value);
    writer.close("DigitalId");
  }
  writer.close("ServiceDigitalIdentity");
}

/**
 * Clause 5.6.3, as this publisher applies it: a history instance identifies
 * the superseded service by key identifier alone. Republishing the certificate
 * would restate a current identity for a state that is no longer current.
 */
function writeHistoryInstance(
  writer: XmlWriter,
  instance: TslServiceHistoryInstance,
  path: string,
): void {
  if (instance.digitalIdentity.x509CertificateBase64Der !== undefined)
    fail(
      `${path}.digitalIdentity`,
      "A ServiceHistoryInstance must not carry an X509Certificate; it identifies the superseded service by X509SKI.",
    );
  if (instance.digitalIdentity.x509SkiBase64 === undefined)
    fail(
      `${path}.digitalIdentity`,
      "A ServiceHistoryInstance must carry at least one X509SKI.",
    );
  writer.open("ServiceHistoryInstance");
  writer.leaf(
    "ServiceTypeIdentifier",
    requireText(
      instance.serviceTypeIdentifier,
      `${path}.serviceTypeIdentifier`,
    ),
  );
  writer.open("ServiceName");
  writer.localized(
    "Name",
    requireText(instance.serviceName, `${path}.serviceName`),
  );
  writer.close("ServiceName");
  writeDigitalIdentity(
    writer,
    instance.digitalIdentity,
    `${path}.digitalIdentity`,
  );
  writer.leaf(
    "ServiceStatus",
    requireText(instance.serviceStatus, `${path}.serviceStatus`),
  );
  writer.leaf(
    "StatusStartingTime",
    requireUtc(instance.statusStartingTime, `${path}.statusStartingTime`),
  );
  writer.close("ServiceHistoryInstance");
}

function writeService(
  writer: XmlWriter,
  service: TslService,
  path: string,
): void {
  writer.open("TSPService");
  writer.open("ServiceInformation");
  writer.leaf(
    "ServiceTypeIdentifier",
    requireText(service.serviceTypeIdentifier, `${path}.serviceTypeIdentifier`),
  );
  writer.open("ServiceName");
  writer.localized(
    "Name",
    requireText(service.serviceName, `${path}.serviceName`),
  );
  writer.close("ServiceName");
  writeDigitalIdentity(
    writer,
    service.digitalIdentity,
    `${path}.digitalIdentity`,
  );
  writer.leaf(
    "ServiceStatus",
    requireText(service.serviceStatus, `${path}.serviceStatus`),
  );
  writer.leaf(
    "StatusStartingTime",
    requireUtc(service.statusStartingTime, `${path}.statusStartingTime`),
  );
  if (service.schemeServiceDefinitionUri) {
    writer.open("SchemeServiceDefinitionURI");
    writer.localized("URI", service.schemeServiceDefinitionUri);
    writer.close("SchemeServiceDefinitionURI");
  }
  if (service.serviceSupplyPoints && service.serviceSupplyPoints.length > 0) {
    writer.open("ServiceSupplyPoints");
    for (const point of service.serviceSupplyPoints)
      writer.leaf("ServiceSupplyPoint", point);
    writer.close("ServiceSupplyPoints");
  }
  if (service.tspServiceDefinitionUri) {
    writer.open("TSPServiceDefinitionURI");
    writer.localized("URI", service.tspServiceDefinitionUri);
    writer.close("TSPServiceDefinitionURI");
  }
  writer.close("ServiceInformation");
  if (service.serviceHistory && service.serviceHistory.length > 0) {
    writer.open("ServiceHistory");
    service.serviceHistory.forEach((instance, index) =>
      writeHistoryInstance(
        writer,
        instance,
        `${path}.serviceHistory[${index}]`,
      ),
    );
    writer.close("ServiceHistory");
  }
  writer.close("TSPService");
}

function writeProvider(
  writer: XmlWriter,
  provider: TslProvider,
  path: string,
): void {
  if (provider.services.length === 0)
    fail(`${path}.services`, "A Trust Service Provider must list a service.");
  writer.open("TrustServiceProvider");
  writer.open("TSPInformation");
  writer.open("TSPName");
  writer.localized("Name", requireText(provider.tspName, `${path}.tspName`));
  writer.close("TSPName");
  if (provider.tspTradeNames.length > 0) {
    writer.open("TSPTradeName");
    for (const tradeName of provider.tspTradeNames)
      writer.localized("Name", tradeName);
    writer.close("TSPTradeName");
  }
  writer.open("TSPAddress");
  writePostalAddress(writer, provider.tspAddress, `${path}.tspAddress`);
  writeElectronicAddress(
    writer,
    provider.tspElectronicAddress,
    `${path}.tspElectronicAddress`,
  );
  writer.close("TSPAddress");
  writer.open("TSPInformationURI");
  writer.localized(
    "URI",
    requireText(provider.tspInformationUri, `${path}.tspInformationUri`),
  );
  writer.close("TSPInformationURI");
  writer.close("TSPInformation");
  writer.open("TSPServices");
  provider.services.forEach((service, index) =>
    writeService(writer, service, `${path}.services[${index}]`),
  );
  writer.close("TSPServices");
  writer.close("TrustServiceProvider");
}

/**
 * Compiles a Trusted List to XML. The result is unsigned: `ds:Signature` is
 * the last child of `TrustServiceStatusList` and is added by the signer.
 */
export function compileTrustedList(input: TrustedListInput): string {
  const scheme = input.schemeInformation;
  const territory = requireText(
    scheme.schemeTerritory,
    "schemeInformation.schemeTerritory",
  );
  if (!EU_MEMBER_STATE_CODES.includes(territory))
    fail(
      "schemeInformation.schemeTerritory",
      `SchemeTerritory must be the responsible EU Member State, not '${territory}'. An EU Member State list is not published for the Union as a whole.`,
    );
  if (!Number.isInteger(scheme.sequenceNumber) || scheme.sequenceNumber < 1)
    fail(
      "schemeInformation.sequenceNumber",
      "TSLSequenceNumber must be a positive integer, starting at 1.",
    );
  const issue = requireUtc(
    scheme.listIssueDateTime,
    "schemeInformation.listIssueDateTime",
  );
  const nextUpdate = requireUtc(
    scheme.nextUpdate,
    "schemeInformation.nextUpdate",
  );
  checkNextUpdate(issue, nextUpdate);

  const pointer = scheme.lotlPointer;
  if (pointer.certificatesBase64Der.length === 0)
    fail(
      "schemeInformation.lotlPointer.certificatesBase64Der",
      "The pointer to the EU LOTL must carry at least one digital identity.",
    );
  for (const [index, certificate] of pointer.certificatesBase64Der.entries()) {
    if (!isStrictBase64(certificate))
      fail(
        `schemeInformation.lotlPointer.certificatesBase64Der[${index}]`,
        "A LOTL pointer certificate must be strict Base64 DER.",
      );
  }

  const writer = new XmlWriter();
  writer.open("TrustServiceStatusList", {
    xmlns: NS_TSL,
    "xmlns:tslx": NS_TSLX,
    TSLTag: TSL_TAG,
    Id: "TrustServiceStatusList",
  });

  writer.open("SchemeInformation");
  writer.leaf("TSLVersionIdentifier", String(TSL_VERSION_IDENTIFIER));
  writer.leaf("TSLSequenceNumber", String(scheme.sequenceNumber));
  writer.leaf("TSLType", TSL_TYPE_EU_GENERIC);
  writer.open("SchemeOperatorName");
  writer.localized(
    "Name",
    requireText(
      scheme.schemeOperatorName,
      "schemeInformation.schemeOperatorName",
    ),
  );
  writer.close("SchemeOperatorName");
  writer.open("SchemeOperatorAddress");
  writePostalAddress(
    writer,
    scheme.schemeOperatorAddress,
    "schemeInformation.schemeOperatorAddress",
  );
  writeElectronicAddress(
    writer,
    scheme.schemeOperatorElectronicAddress,
    "schemeInformation.schemeOperatorElectronicAddress",
  );
  writer.close("SchemeOperatorAddress");
  writer.open("SchemeName");
  writer.localized(
    "Name",
    requireText(scheme.schemeName, "schemeInformation.schemeName"),
  );
  writer.close("SchemeName");
  writer.open("SchemeInformationURI");
  writer.localized(
    "URI",
    requireText(
      scheme.schemeInformationUri,
      "schemeInformation.schemeInformationUri",
    ),
  );
  writer.close("SchemeInformationURI");
  writer.leaf(
    "StatusDeterminationApproach",
    STATUS_DETERMINATION_EU_APPROPRIATE,
  );
  writer.open("SchemeTypeCommunityRules");
  writer.localized("URI", SCHEME_RULES_EU_COMMON);
  writer.localized("URI", schemeRulesForTerritory(territory));
  writer.localized(
    "URI",
    requireText(
      scheme.nationalSchemeRulesUri,
      "schemeInformation.nationalSchemeRulesUri",
    ),
  );
  writer.close("SchemeTypeCommunityRules");
  writer.leaf("SchemeTerritory", territory);
  writer.open("PolicyOrLegalNotice");
  writer.localized(
    "TSLPolicy",
    requireText(
      scheme.policyOrLegalNoticeUri,
      "schemeInformation.policyOrLegalNoticeUri",
    ),
  );
  writer.close("PolicyOrLegalNotice");
  writer.leaf(
    "HistoricalInformationPeriod",
    String(HISTORICAL_INFORMATION_PERIOD),
  );

  writer.open("PointersToOtherTSL");
  writer.open("OtherTSLPointer");
  writer.open("ServiceDigitalIdentities");
  for (const certificate of pointer.certificatesBase64Der) {
    writer.open("ServiceDigitalIdentity");
    writer.open("DigitalId");
    writer.leaf("X509Certificate", certificate);
    writer.close("DigitalId");
    writer.close("ServiceDigitalIdentity");
  }
  writer.close("ServiceDigitalIdentities");
  writer.leaf(
    "TSLLocation",
    requireText(pointer.location, "schemeInformation.lotlPointer.location"),
  );
  /*
    Clause 5.3.13 item c). The qualifiers are the globally declared `tsl:`
    elements, which the schema validates laxly inside OtherInformation, so each
    one has to use its declared type: SchemeOperatorName and
    SchemeTypeCommunityRules are lists with language-tagged children, while
    SchemeTerritory and TSLType are plain text. `MimeType` is the one qualifier
    that lives in the additionaltypes namespace.
  */
  writer.open("AdditionalInformation");
  writer.open("OtherInformation");
  writer.open("SchemeOperatorName");
  for (const name of pointer.schemeOperatorNames)
    writer.localized("Name", name);
  writer.close("SchemeOperatorName");
  writer.close("OtherInformation");
  writer.open("OtherInformation");
  writer.open("SchemeTypeCommunityRules");
  writer.localized("URI", pointer.schemeTypeCommunityRules);
  writer.close("SchemeTypeCommunityRules");
  writer.close("OtherInformation");
  writer.open("OtherInformation");
  writer.leaf("SchemeTerritory", pointer.schemeTerritory);
  writer.close("OtherInformation");
  writer.open("OtherInformation");
  writer.leaf("tslx:MimeType", pointer.mimeType);
  writer.close("OtherInformation");
  writer.open("OtherInformation");
  writer.leaf("TSLType", pointer.tslType);
  writer.close("OtherInformation");
  writer.close("AdditionalInformation");
  writer.close("OtherTSLPointer");
  writer.close("PointersToOtherTSL");

  writer.leaf("ListIssueDateTime", issue);
  writer.open("NextUpdate");
  writer.leaf("dateTime", nextUpdate);
  writer.close("NextUpdate");
  writer.open("DistributionPoints");
  writer.leaf(
    "URI",
    requireText(
      scheme.distributionPointUri,
      "schemeInformation.distributionPointUri",
    ),
  );
  writer.close("DistributionPoints");
  // Clause 5.3.17: an EU Member State list publishes no Scheme Extensions.
  writer.close("SchemeInformation");

  const providers = input.providers ?? [];
  if (providers.length > 0) {
    writer.open("TrustServiceProviderList");
    providers.forEach((provider, index) =>
      writeProvider(writer, provider, `providers[${index}]`),
    );
    writer.close("TrustServiceProviderList");
  }

  writer.close("TrustServiceStatusList");
  return `<?xml version="1.0" encoding="UTF-8"?>\n${writer.toString()}\n`;
}

/** The default LOTL pointer qualifiers, for the list-creation form's defaults. */
export const DEFAULT_LOTL_SCHEME_RULES = EU_LOTL_SCHEME_RULES;
