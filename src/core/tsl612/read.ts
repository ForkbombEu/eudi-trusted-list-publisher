/**
 * Reads a published Trusted List back into the authoring model.
 *
 * Publishing a new version means starting from the version that is already out
 * there, so the XML has to survive a round trip: `compileTrustedList(
 * readTrustedList(compileTrustedList(input)))` must produce the same bytes.
 * `test/tsl612-read.test.ts` asserts exactly that over a list carrying every
 * optional component the model has.
 *
 * Anything the model cannot express is reported rather than silently dropped —
 * a cumulative publication must not quietly delete a component it did not
 * understand — which is why Scheme Extensions and an unexpected version
 * identifier are refused outright instead of being ignored.
 */
import { XmlDocument, type XmlElement } from "libxml2-wasm";
import {
  DEFAULT_LANGUAGE,
  HISTORICAL_INFORMATION_PERIOD,
  NS_TSL,
  NS_TSLX,
  TSL_TAG,
  TSL_VERSION_IDENTIFIER,
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
import type { TrustedListMetadata } from "../publication/tsl-manifest.js";

const NS = { tsl: NS_TSL, tslx: NS_TSLX } as const;

export class TslReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TslReadError";
  }
}

function element(node: unknown): XmlElement | null {
  return typeof node === "object" && node !== null && "attrs" in node
    ? (node as XmlElement)
    : null;
}

function textOf(scope: XmlElement, xpath: string): string | null {
  const node = scope.get(xpath, NS);
  return node ? node.content.trim() : null;
}

function requiredText(scope: XmlElement, xpath: string, what: string): string {
  const value = textOf(scope, xpath);
  if (value === null || value === "")
    throw new TslReadError(`The Trusted List has no ${what}.`);
  return value;
}

function allText(scope: XmlElement, xpath: string): string[] {
  return scope.find(xpath, NS).map((node) => node.content.trim());
}

function readPostalAddress(scope: XmlElement, what: string): TslPostalAddress {
  const address = element(
    scope.get("tsl:PostalAddresses/tsl:PostalAddress", NS),
  );
  if (!address) throw new TslReadError(`The ${what} has no postal address.`);
  const stateOrProvince = textOf(address, "tsl:StateOrProvince");
  const postalCode = textOf(address, "tsl:PostalCode");
  return {
    streetAddress: requiredText(
      address,
      "tsl:StreetAddress",
      `${what} street address`,
    ),
    locality: requiredText(address, "tsl:Locality", `${what} locality`),
    ...(stateOrProvince ? { stateOrProvince } : {}),
    ...(postalCode ? { postalCode } : {}),
    countryName: requiredText(address, "tsl:CountryName", `${what} country`),
  };
}

/**
 * The compiler writes the electronic address as mailto, then the website, then
 * an optional tel. Reading it back applies the same order, and refuses a shape
 * it did not write rather than guessing which URI is which.
 */
function readElectronicAddress(
  scope: XmlElement,
  what: string,
): TslElectronicAddress {
  const uris = allText(scope, "tsl:ElectronicAddress/tsl:URI");
  const email = uris.find((uri) => uri.startsWith("mailto:"));
  const telephone = uris.find((uri) => uri.startsWith("tel:"));
  const website = uris.find(
    (uri) => !uri.startsWith("mailto:") && !uri.startsWith("tel:"),
  );
  if (!email)
    throw new TslReadError(
      `The ${what} electronic address has no mailto: URI.`,
    );
  if (!website)
    throw new TslReadError(
      `The ${what} electronic address has no HTTP(S) URI.`,
    );
  return {
    email: email.slice("mailto:".length),
    website,
    ...(telephone ? { telephone: telephone.slice("tel:".length) } : {}),
  };
}

function readDigitalIdentity(
  scope: XmlElement,
  what: string,
): TslDigitalIdentity {
  const certificate = textOf(
    scope,
    "tsl:ServiceDigitalIdentity/tsl:DigitalId/tsl:X509Certificate",
  );
  const ski = textOf(
    scope,
    "tsl:ServiceDigitalIdentity/tsl:DigitalId/tsl:X509SKI",
  );
  if (!certificate && !ski)
    throw new TslReadError(
      `The ${what} service digital identity carries neither an X509Certificate nor an X509SKI.`,
    );
  return {
    ...(certificate ? { x509CertificateBase64Der: certificate } : {}),
    ...(ski ? { x509SkiBase64: ski } : {}),
  };
}

function readHistoryInstance(node: XmlElement): TslServiceHistoryInstance {
  return {
    serviceTypeIdentifier: requiredText(
      node,
      "tsl:ServiceTypeIdentifier",
      "service history type identifier",
    ),
    serviceName: requiredText(
      node,
      "tsl:ServiceName/tsl:Name",
      "service history name",
    ),
    digitalIdentity: readDigitalIdentity(node, "service history"),
    serviceStatus: requiredText(
      node,
      "tsl:ServiceStatus",
      "service history status",
    ),
    statusStartingTime: requiredText(
      node,
      "tsl:StatusStartingTime",
      "service history status starting time",
    ),
  };
}

function readService(node: XmlElement): TslService {
  const information = element(node.get("tsl:ServiceInformation", NS));
  if (!information)
    throw new TslReadError("A TSPService has no ServiceInformation.");
  const schemeServiceDefinitionUri = textOf(
    information,
    "tsl:SchemeServiceDefinitionURI/tsl:URI",
  );
  const tspServiceDefinitionUri = textOf(
    information,
    "tsl:TSPServiceDefinitionURI/tsl:URI",
  );
  const supplyPoints = allText(
    information,
    "tsl:ServiceSupplyPoints/tsl:ServiceSupplyPoint",
  );
  const history = node
    .find("tsl:ServiceHistory/tsl:ServiceHistoryInstance", NS)
    .map((instance) => {
      const historyElement = element(instance);
      if (!historyElement)
        throw new TslReadError("A ServiceHistoryInstance is not an element.");
      return readHistoryInstance(historyElement);
    });
  return {
    serviceTypeIdentifier: requiredText(
      information,
      "tsl:ServiceTypeIdentifier",
      "service type identifier",
    ),
    serviceName: requiredText(
      information,
      "tsl:ServiceName/tsl:Name",
      "service name",
    ),
    digitalIdentity: readDigitalIdentity(information, "service"),
    serviceStatus: requiredText(
      information,
      "tsl:ServiceStatus",
      "service status",
    ),
    statusStartingTime: requiredText(
      information,
      "tsl:StatusStartingTime",
      "service status starting time",
    ),
    ...(schemeServiceDefinitionUri ? { schemeServiceDefinitionUri } : {}),
    ...(tspServiceDefinitionUri ? { tspServiceDefinitionUri } : {}),
    ...(supplyPoints.length > 0 ? { serviceSupplyPoints: supplyPoints } : {}),
    ...(history.length > 0 ? { serviceHistory: history } : {}),
  };
}

function readProvider(node: XmlElement): TslProvider {
  const information = element(node.get("tsl:TSPInformation", NS));
  if (!information)
    throw new TslReadError("A TrustServiceProvider has no TSPInformation.");
  const address = element(information.get("tsl:TSPAddress", NS));
  if (!address)
    throw new TslReadError("A TrustServiceProvider has no TSPAddress.");
  const services = node
    .find("tsl:TSPServices/tsl:TSPService", NS)
    .map((service) => {
      const serviceElement = element(service);
      if (!serviceElement)
        throw new TslReadError("A TSPService is not an element.");
      return readService(serviceElement);
    });
  if (services.length === 0)
    throw new TslReadError("A TrustServiceProvider lists no service.");
  return {
    tspName: requiredText(information, "tsl:TSPName/tsl:Name", "TSP name"),
    tspTradeNames: allText(information, "tsl:TSPTradeName/tsl:Name"),
    tspAddress: readPostalAddress(address, "TSP"),
    tspElectronicAddress: readElectronicAddress(address, "TSP"),
    tspInformationUri: requiredText(
      information,
      "tsl:TSPInformationURI/tsl:URI",
      "TSP information URI",
    ),
    services,
  };
}

/** Parses a Trusted List, signed or not, into the authoring model. */
export function readTrustedList(xml: string): TrustedListInput {
  using document = parse(xml);
  const root = document.root;
  const scheme = element(root.get("tsl:SchemeInformation", NS));
  if (!scheme)
    throw new TslReadError("The Trusted List has no SchemeInformation.");

  const version = Number(
    requiredText(scheme, "tsl:TSLVersionIdentifier", "TSLVersionIdentifier"),
  );
  if (version !== TSL_VERSION_IDENTIFIER)
    throw new TslReadError(
      `This publisher reads TSLVersionIdentifier ${TSL_VERSION_IDENTIFIER}, but the list states ${version}.`,
    );
  const period = Number(
    requiredText(
      scheme,
      "tsl:HistoricalInformationPeriod",
      "HistoricalInformationPeriod",
    ),
  );
  if (period !== HISTORICAL_INFORMATION_PERIOD)
    throw new TslReadError(
      `This publisher reads HistoricalInformationPeriod ${HISTORICAL_INFORMATION_PERIOD}, but the list states ${period}.`,
    );
  if (scheme.get("tsl:SchemeExtensions", NS))
    throw new TslReadError(
      "The Trusted List carries SchemeExtensions, which an EU Member State list does not use and this publisher cannot reproduce.",
    );

  const address = element(scheme.get("tsl:SchemeOperatorAddress", NS));
  if (!address)
    throw new TslReadError("The Trusted List has no SchemeOperatorAddress.");

  const pointer = element(
    scheme.get("tsl:PointersToOtherTSL/tsl:OtherTSLPointer", NS),
  );
  if (!pointer)
    throw new TslReadError(
      "The Trusted List has no pointer to another Trusted List; an EU Member State list must point at the EU LOTL.",
    );
  const additional = element(pointer.get("tsl:AdditionalInformation", NS));
  if (!additional)
    throw new TslReadError("The LOTL pointer has no AdditionalInformation.");

  /*
    The national scheme rules are the third SchemeTypeCommunityRules URI: the
    compiler writes the EU common rules and the per-country rules ahead of it.
  */
  const rules = allText(scheme, "tsl:SchemeTypeCommunityRules/tsl:URI");
  const nationalSchemeRulesUri = rules[2];
  if (!nationalSchemeRulesUri)
    throw new TslReadError(
      "The Trusted List does not carry a national scheme-rules URI beside the two ETSI rules URIs.",
    );

  const providers = root
    .find("tsl:TrustServiceProviderList/tsl:TrustServiceProvider", NS)
    .map((provider) => {
      const providerElement = element(provider);
      if (!providerElement)
        throw new TslReadError("A TrustServiceProvider is not an element.");
      return readProvider(providerElement);
    });

  return {
    schemeInformation: {
      sequenceNumber: Number(
        requiredText(scheme, "tsl:TSLSequenceNumber", "TSLSequenceNumber"),
      ),
      schemeTerritory: requiredText(
        scheme,
        "tsl:SchemeTerritory",
        "SchemeTerritory",
      ),
      schemeOperatorName: requiredText(
        scheme,
        "tsl:SchemeOperatorName/tsl:Name",
        "SchemeOperatorName",
      ),
      schemeOperatorAddress: readPostalAddress(address, "scheme operator"),
      schemeOperatorElectronicAddress: readElectronicAddress(
        address,
        "scheme operator",
      ),
      schemeName: requiredText(scheme, "tsl:SchemeName/tsl:Name", "SchemeName"),
      schemeInformationUri: requiredText(
        scheme,
        "tsl:SchemeInformationURI/tsl:URI",
        "SchemeInformationURI",
      ),
      nationalSchemeRulesUri,
      policyOrLegalNoticeUri: requiredText(
        scheme,
        "tsl:PolicyOrLegalNotice/tsl:TSLPolicy",
        "PolicyOrLegalNotice",
      ),
      distributionPointUri: requiredText(
        scheme,
        "tsl:DistributionPoints/tsl:URI",
        "DistributionPoints",
      ),
      listIssueDateTime: requiredText(
        scheme,
        "tsl:ListIssueDateTime",
        "ListIssueDateTime",
      ),
      nextUpdate: requiredText(
        scheme,
        "tsl:NextUpdate/tsl:dateTime",
        "NextUpdate",
      ),
      lotlPointer: {
        location: requiredText(pointer, "tsl:TSLLocation", "TSLLocation"),
        certificatesBase64Der: allText(
          pointer,
          "tsl:ServiceDigitalIdentities/tsl:ServiceDigitalIdentity/tsl:DigitalId/tsl:X509Certificate",
        ),
        schemeOperatorNames: allText(
          additional,
          "tsl:OtherInformation/tsl:SchemeOperatorName/tsl:Name",
        ),
        schemeTypeCommunityRules: requiredText(
          additional,
          "tsl:OtherInformation/tsl:SchemeTypeCommunityRules/tsl:URI",
          "LOTL pointer scheme rules",
        ),
        schemeTerritory: requiredText(
          additional,
          "tsl:OtherInformation/tsl:SchemeTerritory",
          "LOTL pointer scheme territory",
        ),
        tslType: requiredText(
          additional,
          "tsl:OtherInformation/tsl:TSLType",
          "LOTL pointer TSL type",
        ),
        mimeType: requiredText(
          additional,
          "tsl:OtherInformation/tslx:MimeType",
          "LOTL pointer MIME type",
        ),
      },
    },
    ...(providers.length > 0 ? { providers } : {}),
  };
}

/** The manifest metadata, read from the published bytes rather than the input. */
export function readTrustedListMetadata(xml: string): TrustedListMetadata {
  using document = parse(xml);
  const root = document.root;
  const scheme = element(root.get("tsl:SchemeInformation", NS));
  if (!scheme)
    throw new TslReadError("The Trusted List has no SchemeInformation.");
  const tslTag = root.attr("TSLTag")?.value ?? "";
  if (tslTag !== TSL_TAG)
    throw new TslReadError(
      `The document is not tagged as a TS 119 612 Trusted List: TSLTag is '${tslTag}'.`,
    );
  const serviceTypes = [
    ...new Set(
      allText(
        root,
        "tsl:TrustServiceProviderList/tsl:TrustServiceProvider/tsl:TSPServices/tsl:TSPService/tsl:ServiceInformation/tsl:ServiceTypeIdentifier",
      ),
    ),
  ].sort();
  return {
    tslTag,
    tslVersionIdentifier: Number(
      requiredText(scheme, "tsl:TSLVersionIdentifier", "TSLVersionIdentifier"),
    ),
    tslSequenceNumber: Number(
      requiredText(scheme, "tsl:TSLSequenceNumber", "TSLSequenceNumber"),
    ),
    tslType: requiredText(scheme, "tsl:TSLType", "TSLType"),
    statusDeterminationApproach: requiredText(
      scheme,
      "tsl:StatusDeterminationApproach",
      "StatusDeterminationApproach",
    ),
    schemeOperatorName: requiredText(
      scheme,
      "tsl:SchemeOperatorName/tsl:Name",
      "SchemeOperatorName",
    ),
    schemeName: requiredText(scheme, "tsl:SchemeName/tsl:Name", "SchemeName"),
    schemeTerritory: requiredText(
      scheme,
      "tsl:SchemeTerritory",
      "SchemeTerritory",
    ),
    historicalInformationPeriod: Number(
      requiredText(
        scheme,
        "tsl:HistoricalInformationPeriod",
        "HistoricalInformationPeriod",
      ),
    ),
    issueDate: requiredText(
      scheme,
      "tsl:ListIssueDateTime",
      "ListIssueDateTime",
    ),
    nextUpdateDate: requiredText(
      scheme,
      "tsl:NextUpdate/tsl:dateTime",
      "NextUpdate",
    ),
    serviceTypes,
    providerCount: root.find(
      "tsl:TrustServiceProviderList/tsl:TrustServiceProvider",
      NS,
    ).length,
    serviceCount: root.find(
      "tsl:TrustServiceProviderList/tsl:TrustServiceProvider/tsl:TSPServices/tsl:TSPService",
      NS,
    ).length,
  };
}

function parse(xml: string): XmlDocument {
  try {
    return XmlDocument.fromString(xml);
  } catch (error) {
    throw new TslReadError(
      `The Trusted List is not well-formed XML: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/** The language every name and URI this publisher writes carries. */
export const READ_LANGUAGE = DEFAULT_LANGUAGE;
