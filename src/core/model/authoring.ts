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
}

export interface AuthoringService {
  serviceTypeIdentifier: string;
  serviceName: AuthoringMultiLang[];
  serviceDigitalIdentity: {
    x509Certificates: string[];
  };
  serviceUniqueIdentifier: string;
  serviceSupplyPoints?: { uriValue: string }[];
}

export interface AuthoringEntity {
  teName: AuthoringMultiLang[];
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
