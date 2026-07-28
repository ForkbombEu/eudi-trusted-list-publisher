export interface MultiLangString {
  lang: string;
  value: string;
}

export interface NonEmptyMultiLangURI {
  lang: string;
  uriValue: string;
}

export interface PostalAddress {
  lang: string;
  StreetAddress: string;
  Locality?: string;
  StateOrProvince?: string;
  PostalCode?: string;
  Country: string;
}

export interface PkiOb {
  encoding?: string;
  specRef?: string;
  val: string;
}

export interface ServiceDigitalIdentity {
  X509Certificates?: PkiOb[];
  X509SubjectNames?: string[];
  X509SKIs?: string[];
}

export interface ServiceSupplyPointURI {
  ServiceType?: string;
  uriValue: string;
}

export interface ServiceInformationExtensionsItem {
  [key: string]: unknown;
}

export interface ServiceInformation {
  ServiceName: MultiLangString[];
  ServiceDigitalIdentity: ServiceDigitalIdentity;
  ServiceTypeIdentifier?: string;
  ServiceStatus?: string;
  StatusStartingTime?: string;
  SchemeServiceDefinitionURI?: NonEmptyMultiLangURI[];
  ServiceSupplyPoints?: ServiceSupplyPointURI[];
  ServiceDefinitionURI?: NonEmptyMultiLangURI[];
  ServiceInformationExtensions?: ServiceInformationExtensionsItem[];
}

export interface ServiceHistoryInstance {
  ServiceName: MultiLangString[];
  ServiceDigitalIdentity: ServiceDigitalIdentity;
  ServiceStatus: string;
  StatusStartingTime: string;
  ServiceTypeIdentifier?: string;
}

export interface TrustedEntityService {
  ServiceInformation: ServiceInformation;
  ServiceHistory?: ServiceHistoryInstance[];
}

export interface TrustedEntityInformation {
  TEName: MultiLangString[];
  TETradeName?: MultiLangString[];
  TEAddress: {
    TEPostalAddress: PostalAddress[];
    TEElectronicAddress: NonEmptyMultiLangURI[];
  };
  TEInformationURI: NonEmptyMultiLangURI[];
}

export interface TrustedEntity {
  TrustedEntityInformation: TrustedEntityInformation;
  TrustedEntityServices: TrustedEntityService[];
}

export interface SchemeOperatorAddress {
  SchemeOperatorPostalAddress: PostalAddress[];
  SchemeOperatorElectronicAddress: NonEmptyMultiLangURI[];
}

export interface ListAndSchemeInformation {
  LoTEVersionIdentifier: number;
  LoTESequenceNumber: number;
  LoTEType?: string;
  SchemeOperatorName: MultiLangString[];
  SchemeOperatorAddress: SchemeOperatorAddress;
  SchemeName?: MultiLangString[];
  SchemeInformationURI?: NonEmptyMultiLangURI[];
  StatusDeterminationApproach?: string;
  SchemeTypeCommunityRules?: NonEmptyMultiLangURI[];
  SchemeTerritory?: string;
  PolicyOrLegalNotice?: unknown[];
  HistoricalInformationPeriod?: number;
  PointersToOtherLoTE?: unknown[];
  ListIssueDateTime: string;
  NextUpdate: string;
  DistributionPoints?: string[];
  SchemeExtensions?: unknown[];
}

export interface LoTE {
  ListAndSchemeInformation: ListAndSchemeInformation;
  TrustedEntitiesList?: TrustedEntity[];
}

export interface LoTEDocument {
  LoTE: LoTE;
}
