/**
 * The authoring model for a TS 119 612 Trusted List.
 *
 * This is the shape the administration collects and the compiler consumes. It
 * is deliberately flatter than the XML: the compiler owns element order,
 * language attributes and the fixed URIs, so no caller can get those wrong.
 */

export interface TslPostalAddress {
  readonly streetAddress: string;
  readonly locality: string;
  readonly stateOrProvince?: string;
  readonly postalCode?: string;
  /** Clause 5.3.5.1 / 5.4.3.1: the country of the address, as printed. */
  readonly countryName: string;
}

/**
 * Clause 5.3.5.2 and 5.4.3.2. An electronic address is a list of URIs; the
 * standard expects at least a `mailto:` and an HTTP(S) one. A telephone number
 * is published as a `tel:` URI when supplied.
 */
export interface TslElectronicAddress {
  readonly email: string;
  readonly website: string;
  readonly telephone?: string;
}

/**
 * Clause 5.3.13. The pointer every EU Member State list carries to the EU List
 * of Trusted Lists: where it is, which keys authenticate it, and the
 * qualifiers that say what kind of list it is.
 */
export interface TslLotlPointer {
  readonly location: string;
  /**
   * The LOTL signing certificates, Base64 DER. Empty is refused by the
   * compiler: a pointer with no digital identity tells a reader where to look
   * and nothing about what to trust there.
   */
  readonly certificatesBase64Der: readonly string[];
  readonly schemeOperatorNames: readonly string[];
  readonly schemeTypeCommunityRules: string;
  readonly schemeTerritory: string;
  readonly tslType: string;
  readonly mimeType: string;
}

/** Clause 5.3: everything above the list of providers. */
export interface TslSchemeInformation {
  /** Clause 5.3.2. 1 for the first version, incremented on every publication. */
  readonly sequenceNumber: number;
  /** Clause 5.3.10. The responsible Member State, never `EU`. */
  readonly schemeTerritory: string;
  readonly schemeOperatorName: string;
  readonly schemeOperatorAddress: TslPostalAddress;
  readonly schemeOperatorElectronicAddress: TslElectronicAddress;
  /** Clause 5.3.6, in the `<CC>:<operator name>` form. */
  readonly schemeName: string;
  readonly schemeInformationUri: string;
  /** Clause 5.3.9, the national rules URI published beside the EU common one. */
  readonly nationalSchemeRulesUri: string;
  /** Clause 5.3.11. */
  readonly policyOrLegalNoticeUri: string;
  /** Clause 5.3.16, the stable URL the signed XML is published at. */
  readonly distributionPointUri: string;
  /** Clause 5.3.14, UTC, no fractional seconds. */
  readonly listIssueDateTime: string;
  /** Clause 5.3.15, at most six months after the issue time. */
  readonly nextUpdate: string;
  readonly lotlPointer: TslLotlPointer;
}

/**
 * Clause 5.5.3 / 5.6.3. A current service publishes its certificate; a history
 * instance publishes the key identifier and no certificate, so the superseded
 * state stays attributable without republishing the certificate.
 */
export interface TslDigitalIdentity {
  readonly x509CertificateBase64Der?: string;
  readonly x509SkiBase64?: string;
}

/** Clause 5.6. A superseded state of one service. */
export interface TslServiceHistoryInstance {
  readonly serviceTypeIdentifier: string;
  readonly serviceName: string;
  readonly digitalIdentity: TslDigitalIdentity;
  readonly serviceStatus: string;
  readonly statusStartingTime: string;
}

/** Clause 5.5. One service of one provider. */
export interface TslService {
  readonly serviceTypeIdentifier: string;
  readonly serviceName: string;
  readonly digitalIdentity: TslDigitalIdentity;
  readonly serviceStatus: string;
  readonly statusStartingTime: string;
  readonly schemeServiceDefinitionUri?: string;
  readonly tspServiceDefinitionUri?: string;
  readonly serviceSupplyPoints?: readonly string[];
  /** Most recent superseded state first. */
  readonly serviceHistory?: readonly TslServiceHistoryInstance[];
}

/** Clause 5.4. One Trust Service Provider. */
export interface TslProvider {
  readonly tspName: string;
  /**
   * Clause 5.4.2. Carries the official registration identifier in the
   * `VATCC-`/`NTRCC-` form, and the certificate subject organisation when it
   * differs from the TSP name.
   */
  readonly tspTradeNames: readonly string[];
  readonly tspAddress: TslPostalAddress;
  readonly tspElectronicAddress: TslElectronicAddress;
  readonly tspInformationUri: string;
  readonly services: readonly TslService[];
}

/** A complete Trusted List, before it is signed. */
export interface TrustedListInput {
  readonly schemeInformation: TslSchemeInformation;
  /** Absent or empty omits `TrustServiceProviderList` entirely. */
  readonly providers?: readonly TslProvider[];
}
