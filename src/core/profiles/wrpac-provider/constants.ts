/**
 * ETSI TS 119 602 V1.1.1, Annex F — EU list of Wallet-Relying-Party Access
 * Certificate (WRPAC) Providers.
 */
export const WRPAC_PROVIDER_LOTE_TYPE =
  "http://uri.etsi.org/19602/LoTEType/EUWRPACProvidersList";
export const WRPAC_PROVIDER_STATUS_DETN =
  "http://uri.etsi.org/19602/WRPACProvidersList/StatusDetn/EU";
export const WRPAC_PROVIDER_SCHEME_RULES =
  "http://uri.etsi.org/19602/WRPACProvidersList/schemerules/EU";
export const WRPAC_SERVICE_TYPE_ISSUANCE =
  "http://uri.etsi.org/19602/SvcType/WRPAC/Issuance";
export const WRPAC_SERVICE_TYPE_REVOCATION =
  "http://uri.etsi.org/19602/SvcType/WRPAC/Revocation";

/**
 * Annex F entity role URI. `<prefix>/<CC>` states which Member State the
 * provider is listed for and in which role; for WRPAC that is the Member State
 * whose mandate the provider holds, not the provider's own country.
 */
export const WRPAC_PROVIDER_ROLE_URI_PREFIX =
  "http://uri.etsi.org/19602/ListOfTrustedEntities/WRPACProvider";
