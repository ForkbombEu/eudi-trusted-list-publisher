/**
 * ETSI TS 119 602 V1.1.1, Annex H — EU list of providers of publicly issued
 * electronic attestations of attributes (Pub-EAA Providers).
 *
 * Annex H differs from Annex D–G in four visible ways, and every one of them is
 * reproduced here rather than inferred: the list carries a historical
 * information period, it carries no pointer to itself, its services publish a
 * service status with a status starting time, and a withdrawn service keeps its
 * previous state in ServiceHistory.
 */
export const PUB_EAA_PROVIDER_LOTE_TYPE =
  "http://uri.etsi.org/19602/LoTEType/EUPubEAAProvidersList";
export const PUB_EAA_PROVIDER_STATUS_DETN =
  "http://uri.etsi.org/19602/PubEAAProvidersList/StatusDetn/EU";
export const PUB_EAA_PROVIDER_SCHEME_RULES =
  "http://uri.etsi.org/19602/PubEAAProvidersList/schemerules/EU";
export const PUB_EAA_SERVICE_TYPE_ISSUANCE =
  "http://uri.etsi.org/19602/SvcType/PubEAA/Issuance";
export const PUB_EAA_SERVICE_TYPE_REVOCATION =
  "http://uri.etsi.org/19602/SvcType/PubEAA/Revocation";

/**
 * The two service statuses Annex H defines. A service is `notified` from the
 * moment the Member State's notification is published, and `withdrawn` from the
 * moment the notification is withdrawn; there is no third value.
 */
export const PUB_EAA_SVC_STATUS_NOTIFIED =
  "http://uri.etsi.org/19602/PubEAAProvidersList/SvcStatus/notified";
export const PUB_EAA_SVC_STATUS_WITHDRAWN =
  "http://uri.etsi.org/19602/PubEAAProvidersList/SvcStatus/withdrawn";

/**
 * Annex H entity role URI. `<prefix>/<CC>` names the Member State responsible
 * for the notification, not the provider's own country.
 */
export const PUB_EAA_PROVIDER_ROLE_URI_PREFIX =
  "http://uri.etsi.org/19602/ListOfTrustedEntities/PubEAAProvider";

/**
 * Annex H fixes the historical information period at 65535 months: the list
 * keeps every service's history for practical purposes indefinitely, which is
 * what makes the withdrawn/notified history meaningful to a reader.
 */
export const PUB_EAA_HISTORICAL_INFORMATION_PERIOD = 65535;

/**
 * The legal-basis reference names the Union or national act under which the
 * attestations are issued. Annex H expresses it as an `OJ:` URI, so the
 * authoring boundary normalises whatever the applicant types to that form.
 */
export const PUB_EAA_LEGAL_BASIS_URI_SCHEME = "OJ";
