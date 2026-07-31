export interface AuthoringMultiLang {
  lang: string;
  value: string;
}

export interface AuthoringPostalAddress {
  lang: string;
  StreetAddress: string;
  Locality?: string;
  StateOrProvince?: string;
  PostalCode?: string;
  Country: string;
}

export interface AuthoringElectronicAddress {
  lang: string;
  uriValue: string;
}

export interface AuthoringSchemeOperator {
  name: AuthoringMultiLang[];
  postalAddress: AuthoringPostalAddress[];
  electronicAddress: AuthoringElectronicAddress[];
}

export interface AuthoringScheme {
  schemeName: AuthoringMultiLang[];
  schemeInformationURI?: AuthoringElectronicAddress[];
  schemeTerritory: string;
  distributionPoints: string[];
  /** LoTEPolicy URI; mandatory wherever explicit scheme information is used. */
  policyUri?: string;
  /**
   * Base64 DER certificates that authenticate this list, published in the
   * self pointer so a reader learns the list's own trust anchor.
   */
  selfPointerCertificates?: string[];
  /** Media type of the artifact the self pointer addresses. */
  selfPointerMimeType?: string;
  /**
   * Months of service history the scheme keeps. Annex H fixes it at 65535; the
   * other implemented profiles omit the component entirely.
   */
  historicalInformationPeriod?: number;
}

/**
 * A superseded state of one service, kept in ServiceHistory. Annex H publishes
 * the previous state by subject key identifier only: the certificate itself
 * belongs to the current entry, and repeating it in history would suggest the
 * key is still the service's published identity.
 */
export interface AuthoringServiceHistoryInstance {
  serviceTypeIdentifier?: string;
  serviceName: AuthoringMultiLang[];
  /** Base64 subject key identifiers; never certificates. */
  x509Skis: string[];
  serviceStatus: string;
  statusStartingTime: string;
}

export interface AuthoringService {
  serviceTypeIdentifier: string;
  serviceName: AuthoringMultiLang[];
  serviceDigitalIdentity: {
    x509Certificates: string[];
  };
  /**
   * Annex D/E publish this as the ServiceUniqueIdentifier extension. Annex F/G
   * do not use the extension, so it is absent for those families and no
   * extension container is emitted.
   */
  serviceUniqueIdentifier?: string;
  serviceSupplyPoints?: { uriValue: string }[];
  /**
   * Annex H only. `serviceStatus` is one of the profile's two status URIs and
   * `statusStartingTime` is the instant that status began — the publication
   * event that notified or withdrew the service.
   */
  serviceStatus?: string;
  statusStartingTime?: string;
  /** Annex H only, most recent superseded state first. */
  serviceHistory?: AuthoringServiceHistoryInstance[];
}

export interface AuthoringEntity {
  teName: AuthoringMultiLang[];
  /**
   * Annex H.3 makes this mandatory and uses it for the official registration
   * identifier, when one exists, and the formatted `OJ:` legal-basis URI.
   * Other profiles retain the base model's optional component.
   */
  teTradeName?: AuthoringMultiLang[];
  tePostalAddress: AuthoringPostalAddress[];
  teElectronicAddress: AuthoringElectronicAddress[];
  teInformationURI: AuthoringElectronicAddress[];
  services: AuthoringService[];
}

export interface AuthoringInput {
  schemeOperator: AuthoringSchemeOperator;
  scheme: AuthoringScheme;
  listIssueDateTime: string;
  nextUpdate: string;
  loTESequenceNumber: number;
  entities: AuthoringEntity[];
}
