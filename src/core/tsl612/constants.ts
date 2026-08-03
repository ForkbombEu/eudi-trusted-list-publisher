/**
 * The fixed URIs and values ETSI TS 119 612 V2.4.1 gives an EU Member State
 * Trusted List. Everything here is a literal a reader matches exactly, so it
 * is declared once and never rebuilt from parts at a call site.
 */

/** Clause 5.2. The tag identifying the document as a TS 119 612 Trusted List. */
export const TSL_TAG = "http://uri.etsi.org/19612/TSLTag";

/** Clause 5.3.1. Version 6 is the version this edition of the standard defines. */
export const TSL_VERSION_IDENTIFIER = 6;

/** Clause 5.3.3. An EU Member State list is a generic EU list. */
export const TSL_TYPE_EU_GENERIC =
  "http://uri.etsi.org/TrstSvc/TrustedList/TSLType/EUgeneric";

/** Clause 5.3.8. */
export const STATUS_DETERMINATION_EU_APPROPRIATE =
  "http://uri.etsi.org/TrstSvc/TrustedList/StatusDetn/EUappropriate";

/**
 * Clause 5.3.9. A Member State list carries both rules URIs: the common EU
 * rule set, and the per-country rule set whose last segment is the territory.
 */
export const SCHEME_RULES_EU_COMMON =
  "http://uri.etsi.org/TrstSvc/TrustedList/schemerules/EUcommon";
export const SCHEME_RULES_CC_PREFIX =
  "http://uri.etsi.org/TrstSvc/TrustedList/schemerules";

/** `.../schemerules/<CC>` for the responsible Member State. */
export function schemeRulesForTerritory(territory: string): string {
  return `${SCHEME_RULES_CC_PREFIX}/${territory}`;
}

/**
 * Clause 5.3.12. The standard's value for a list that keeps history
 * permanently, which is what a status change relies on: a superseded state
 * stays readable in ServiceHistory rather than expiring.
 */
export const HISTORICAL_INFORMATION_PERIOD = 65535;

/** Clause 5.3.15. */
export const MAX_NEXT_UPDATE_MONTHS = 6;

/** The media type a Trusted List is published and served under. */
export const TSL_MEDIA_TYPE = "application/vnd.etsi.tsl+xml";

/**
 * Clause 5.3.13. Every EU Member State list points at the EU List of Trusted
 * Lists. The location is the European Commission's published LOTL.
 */
export const EU_LOTL_LOCATION = "https://ec.europa.eu/tools/lotl/eu-lotl.xml";
export const EU_LOTL_TSL_TYPE =
  "http://uri.etsi.org/TrstSvc/TrustedList/TSLType/EUlistofthelists";
export const EU_LOTL_SCHEME_TERRITORY = "EU";
export const EU_LOTL_SCHEME_RULES =
  "http://uri.etsi.org/TrstSvc/TrustedList/schemerules/EUlistofthelists";

/** Clause 5.5.1: the two service types this publisher lists. */
export const SVCTYPE_EAA = "http://uri.etsi.org/TrstSvc/Svctype/EAA";
export const SVCTYPE_QEAA = "http://uri.etsi.org/TrstSvc/Svctype/EAA/Q";

/**
 * Clause 5.5.4. The status vocabularies differ between a qualified and a
 * non-qualified service: a national recognition is recognised and then
 * deprecated, while qualified status is granted and then withdrawn.
 */
export const SVCSTATUS_RECOGNISED_AT_NATIONAL_LEVEL =
  "http://uri.etsi.org/TrstSvc/TrustedList/Svcstatus/recognisedatnationallevel";
export const SVCSTATUS_DEPRECATED_AT_NATIONAL_LEVEL =
  "http://uri.etsi.org/TrstSvc/TrustedList/Svcstatus/deprecatedatnationallevel";
export const SVCSTATUS_GRANTED =
  "http://uri.etsi.org/TrstSvc/TrustedList/Svcstatus/granted";
export const SVCSTATUS_WITHDRAWN =
  "http://uri.etsi.org/TrstSvc/TrustedList/Svcstatus/withdrawn";

/** XML namespaces used when writing a Trusted List. */
export const NS_TSL = "http://uri.etsi.org/02231/v2#";
export const NS_TSLX = "http://uri.etsi.org/02231/v2/additionaltypes#";
export const NS_DSIG = "http://www.w3.org/2000/09/xmldsig#";
export const NS_XADES = "http://uri.etsi.org/01903/v1.3.2#";

/**
 * Clause 5.1.4 requires a language on every name and URI. This publisher
 * writes English, which is the language the collected form fields are in.
 */
export const DEFAULT_LANGUAGE = "en";
