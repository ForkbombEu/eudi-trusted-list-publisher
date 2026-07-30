/**
 * ETSI TS 119 602 V1.1.1, Annex G — EU list of Wallet-Relying-Party
 * Registration Certificate (WRPRC) Providers.
 */
export const WRPRC_PROVIDER_LOTE_TYPE =
  "http://uri.etsi.org/19602/LoTEType/EUWRPRCProvidersList";

/**
 * Annex G spells the status-determination URI `WRPRCrovidersList`, without the
 * `P` of `Providers`. The literal is reproduced exactly as the standard prints
 * it: a reader matches this URI verbatim, so silently "correcting" it would
 * produce a list nothing recognises.
 */
export const WRPRC_PROVIDER_STATUS_DETN =
  "http://uri.etsi.org/19602/WRPRCrovidersList/StatusDetn/EU";
export const WRPRC_PROVIDER_SCHEME_RULES =
  "http://uri.etsi.org/19602/WRPRCProvidersList/schemerules/EU";
export const WRPRC_SERVICE_TYPE_ISSUANCE =
  "http://uri.etsi.org/19602/SvcType/WRPRC/Issuance";
export const WRPRC_SERVICE_TYPE_REVOCATION =
  "http://uri.etsi.org/19602/SvcType/WRPRC/Revocation";

/** Annex G entity role URI; see the Annex F counterpart. */
export const WRPRC_PROVIDER_ROLE_URI_PREFIX =
  "http://uri.etsi.org/19602/ListOfTrustedEntities/WRPRCProvider";
