/**
 * The canonical defect catalogue.
 *
 * There is exactly one catalogue of intentional defects in this repository, and
 * this is it. A defect is a *product-level* idea — "the list points nowhere",
 * "the signature does not verify" — that both published formats can express.
 * Each defect therefore states its intent once and then binds that intent to a
 * concrete, deterministic mutation per standard:
 *
 *   TS 119 602  JSON LoTE, Compact JAdES  (src/core/authoring/defects.ts)
 *   TS 119 612  XML Trusted List, XAdES   (src/core/tsl612/defects.ts)
 *
 * A defect that only one format can express carries only that binding. Nothing
 * here knows how to perform a mutation: the registry says what must happen and
 * what is expected to fail, the per-format engines say how.
 *
 * The UI, the API, the stored fixture metadata and the tests all read this
 * catalogue. Adding a defect means adding it here first; a format that has no
 * binding for it will not offer it.
 */

/** When a mutation is applied relative to signing and publication. */
export type DefectStage = "pre-sign" | "post-sign" | "publication";

export type DefectStandard = "TS 119 602" | "TS 119 612";

export type DefectArtifactFormat = "JSON / JAdES" | "XML / XAdES-B-B";

/**
 * Local validation failures a fixture can be expected to produce.
 *
 * These are stable identifiers rather than free text, so an expected failure
 * can be compared against an actual one. They name the check, not the message:
 * the message says what went wrong, the identifier says which check said so.
 */
export const LOCAL_FAILURE_IDS = Object.freeze({
  /** The artifact does not validate against the pinned ETSI XML schemas. */
  xmlSchema: "local.xml.schema",
  /** The enveloped XAdES signature does not verify cryptographically. */
  xadesSignature: "local.xades.signature",
  /** The signing certificate does not meet the TLSO certificate profile. */
  signingCertificateProfile: "local.signing_certificate.profile",
  /** NextUpdate is absent, not later than the issue time, or already past. */
  freshness: "local.freshness",
  /** `trusted-list.sha2` is not the SHA-256 of the published XML bytes. */
  sha2Digest: "local.sha2.digest",
} as const);

export interface DefectBinding {
  readonly standard: DefectStandard;
  readonly artifactFormat: DefectArtifactFormat;
  readonly stage: DefectStage;
  /** What the mutation does to this format, in one sentence. */
  readonly mutation: string;
  /** The clause the mutation violates, cited so a reader can look it up. */
  readonly normativeReference: string;
  /** What a conformant list does instead, in one sentence. */
  readonly conformantBehaviour: string;
  /**
   * Trust Inspector rule IDs this mutation is expected to trip, in normalized
   * form — see `normalizeInspectorRuleId`. The first is the primary rule; the
   * rest are the cascading failures the same mutation legitimately provokes.
   *
   * These are expectations, never assertions. The stored fixture metadata
   * always reports expected against actual, so a drifting Inspector rule set
   * shows up as a missing or additional failure instead of being hidden.
   */
  readonly expectedRuleIds: readonly string[];
  /** Local check IDs this mutation is expected to fail. */
  readonly expectedLocalFailures: readonly string[];
  /** Families where the literal mutation is a no-op and is realised otherwise. */
  readonly familyNote?: string;
}

export interface CanonicalDefect {
  readonly id: string;
  readonly label: string;
  /** The format-independent idea, stated once. */
  readonly intent: string;
  readonly bindings: readonly DefectBinding[];
}

/**
 * Annex H (Pub-EAA) sets `publishesSelfPointer: false`, so a healthy Pub-EAA
 * list already omits PointersToOtherLoTE and "omit the pointer" changes
 * nothing. For that family the defect is inverted: it *injects* a pointer the
 * annex prohibits. The runtime consequence a developer tests for is the same —
 * the list carries a pointer structure that must be rejected.
 */
const SELF_POINTER_ANNEX_H_NOTE =
  "Annex H forbids PointersToOtherLoTE, so for pub-eaa-providers this defect " +
  "injects a prohibited pointer instead of omitting a required one.";

const TS119602 = "ETSI TS 119 602 V1.1.1";
const TS119612 = "ETSI TS 119 612 V2.4.1";

export const DEFECT_CATALOGUE: ReadonlyArray<CanonicalDefect> = Object.freeze<
  CanonicalDefect[]
>([
  {
    id: "non_strict_timestamps",
    label: "Non-strict timestamps",
    intent:
      "The list's issue and next-update instants are not written in the strict UTC lexical form the standard requires.",
    bindings: Object.freeze([
      {
        standard: "TS 119 602",
        artifactFormat: "JSON / JAdES",
        stage: "pre-sign",
        mutation:
          "Emit ListIssueDateTime and NextUpdate with fractional seconds, violating the clause 6.1.3 lexical form.",
        normativeReference: `${TS119602}, clause 6.1.3 (date-time lexical form)`,
        conformantBehaviour:
          "ListIssueDateTime and NextUpdate are written as YYYY-MM-DDThh:mm:ssZ, with whole seconds and no fractional part.",
        expectedRuleIds: Object.freeze([
          "ts119602.syntax.date_time",
          "ts119602.scheme.issue_time",
          "ts119602.scheme.next_update",
          "json_lote.dates.issue_valid",
          "json_lote.dates.next_update_valid",
        ]),
        expectedLocalFailures: Object.freeze([]),
      },
      {
        standard: "TS 119 612",
        artifactFormat: "XML / XAdES-B-B",
        stage: "pre-sign",
        mutation:
          "Emit ListIssueDateTime and NextUpdate with fractional seconds. xs:dateTime permits a fraction, so the XML still schema-validates and the violation is of the profile alone.",
        normativeReference: `${TS119612}, clauses 5.3.14 and 5.3.15 (ListIssueDateTime, NextUpdate)`,
        conformantBehaviour:
          "ListIssueDateTime and NextUpdate are written as YYYY-MM-DDThh:mm:ssZ, in UTC, with whole seconds.",
        expectedRuleIds: Object.freeze([
          "dates.issue_valid",
          "dates.next_update_valid",
          "ts119612.scheme.issue_time",
          "ts119612.scheme.next_update",
        ]),
        expectedLocalFailures: Object.freeze([]),
      },
    ]),
  },
  {
    id: "scheme_name_without_territory",
    label: "Scheme name without territory",
    intent:
      "The scheme name does not carry the territory prefix that says which scheme published the list.",
    bindings: Object.freeze([
      {
        standard: "TS 119 602",
        artifactFormat: "JSON / JAdES",
        stage: "pre-sign",
        mutation:
          "Emit SchemeName without the SchemeTerritory prefix required by clause 6.3.6.",
        normativeReference: `${TS119602}, clause 6.3.6 (SchemeName)`,
        conformantBehaviour:
          "Each SchemeName value is prefixed with the scheme territory and a colon, for example EU:My List.",
        expectedRuleIds: Object.freeze(["ts119602.scheme.name"]),
        expectedLocalFailures: Object.freeze([]),
      },
      {
        standard: "TS 119 612",
        artifactFormat: "XML / XAdES-B-B",
        stage: "pre-sign",
        mutation:
          "Emit SchemeName without the `<CC>:` prefix, so the name does not state the scheme territory it belongs to.",
        normativeReference: `${TS119612}, clause 5.3.6 (SchemeName)`,
        conformantBehaviour:
          "SchemeName is written as `<CC>:<scheme operator name>`, with CC equal to the Scheme Territory.",
        expectedRuleIds: Object.freeze(["ts119612.scheme.name"]),
        expectedLocalFailures: Object.freeze([]),
      },
    ]),
  },
  {
    id: "missing_scheme_information_uri",
    label: "Missing scheme information URI",
    intent:
      "The list omits the mandatory pointer to the scheme information its operator publishes.",
    bindings: Object.freeze([
      {
        standard: "TS 119 602",
        artifactFormat: "JSON / JAdES",
        stage: "pre-sign",
        mutation:
          "Omit SchemeInformationURI, which the Table 1 presence matrix makes mandatory for explicit scheme information.",
        normativeReference: `${TS119602}, clause 6.3.7 and Table 1 (presence matrix)`,
        conformantBehaviour:
          "SchemeInformationURI is present and points at the scheme information the operator publishes.",
        expectedRuleIds: Object.freeze([
          "ts119602.structure.scheme_information_presence",
          "ts119602.profile.pub_eaa_providers.scheme_information",
        ]),
        expectedLocalFailures: Object.freeze([]),
      },
      {
        standard: "TS 119 612",
        artifactFormat: "XML / XAdES-B-B",
        stage: "pre-sign",
        mutation:
          "Delete the whole SchemeInformationURI element. It is a mandatory member of the SchemeInformation sequence, so the document no longer validates against the pinned XSD.",
        normativeReference: `${TS119612}, clause 5.3.7 (SchemeInformationURI)`,
        conformantBehaviour:
          "SchemeInformationURI is present, in sequence order, and carries a language-tagged URI.",
        expectedRuleIds: Object.freeze([
          "schema.xsd",
          "structure.scheme_information_uri",
          "ts119612.scheme.information_uri",
        ]),
        expectedLocalFailures: Object.freeze([LOCAL_FAILURE_IDS.xmlSchema]),
      },
    ]),
  },
  {
    id: "missing_policy_or_legal_notice",
    label: "Missing policy or legal notice",
    intent:
      "The list states no policy and no legal notice, so a reader cannot learn the terms it is published under.",
    bindings: Object.freeze([
      {
        standard: "TS 119 602",
        artifactFormat: "JSON / JAdES",
        stage: "pre-sign",
        mutation: "Omit PolicyOrLegalNotice.",
        normativeReference: `${TS119602}, clause 6.3.11 (PolicyOrLegalNotice)`,
        conformantBehaviour:
          "PolicyOrLegalNotice carries either a LoTEPolicy URI or a LoTELegalNotice, never both.",
        expectedRuleIds: Object.freeze([
          "ts119602.scheme.policy_or_legal_notice",
          "ts119602.structure.scheme_information_presence",
        ]),
        expectedLocalFailures: Object.freeze([]),
      },
      {
        standard: "TS 119 612",
        artifactFormat: "XML / XAdES-B-B",
        stage: "pre-sign",
        mutation: "Delete the whole PolicyOrLegalNotice element.",
        normativeReference: `${TS119612}, clause 5.3.11 (PolicyOrLegalNotice)`,
        conformantBehaviour:
          "PolicyOrLegalNotice carries a TSLPolicy URI or a TSLLegalNotice for the scheme.",
        expectedRuleIds: Object.freeze([
          "ts119612.scheme.policy_or_legal_notice",
        ]),
        expectedLocalFailures: Object.freeze([]),
      },
    ]),
  },
  {
    id: "missing_operator_email",
    label: "Operator without email",
    intent:
      "The scheme operator publishes no electronic mail address, so it cannot be contacted about the list.",
    bindings: Object.freeze([
      {
        standard: "TS 119 602",
        artifactFormat: "JSON / JAdES",
        stage: "pre-sign",
        mutation:
          "Publish only a website URI for the scheme operator, with no mailto URI.",
        normativeReference: `${TS119602}, clause 6.3.4 (SchemeOperatorAddress)`,
        conformantBehaviour:
          "The scheme operator's electronic address includes a mailto: URI alongside any website URI.",
        expectedRuleIds: Object.freeze(["ts119602.scheme.operator_address"]),
        expectedLocalFailures: Object.freeze([]),
      },
      {
        standard: "TS 119 612",
        artifactFormat: "XML / XAdES-B-B",
        stage: "pre-sign",
        mutation:
          "Remove the mailto: URI from the scheme operator's ElectronicAddress, leaving only the website URI.",
        normativeReference: `${TS119612}, clause 5.3.5.2 (ElectronicAddress)`,
        conformantBehaviour:
          "The scheme operator's ElectronicAddress carries a mailto: URI alongside its website URI.",
        expectedRuleIds: Object.freeze(["ts119612.scheme.operator_address"]),
        expectedLocalFailures: Object.freeze([]),
      },
    ]),
  },
  {
    id: "missing_self_pointer",
    label: "Missing pointer",
    intent:
      "The list omits the pointer structure that places it in the wider trust infrastructure.",
    bindings: Object.freeze([
      {
        standard: "TS 119 602",
        artifactFormat: "JSON / JAdES",
        stage: "pre-sign",
        mutation:
          "Omit PointersToOtherLoTE, so the list does not point at itself.",
        normativeReference: `${TS119602}, clause 6.3.13 (PointersToOtherLoTE); Annex H for Pub-EAA`,
        conformantBehaviour:
          "Annex D to G require the list to point at itself so a reader can confirm where it is published. Annex H requires PointersToOtherLoTE to be absent entirely.",
        expectedRuleIds: Object.freeze([
          "ts119602.profile.pub_eaa_providers.scheme_information",
        ]),
        expectedLocalFailures: Object.freeze([]),
        familyNote: SELF_POINTER_ANNEX_H_NOTE,
      },
      {
        standard: "TS 119 612",
        artifactFormat: "XML / XAdES-B-B",
        stage: "pre-sign",
        mutation:
          "Delete PointersToOtherTSL, so the Member State list no longer points at the EU List of Trusted Lists.",
        normativeReference: `${TS119612}, clause 5.3.13 (PointersToOtherTSL)`,
        conformantBehaviour:
          "Every EU Member State list carries an OtherTSLPointer to the EU LOTL, with its location, digital identities and qualifiers.",
        /* The per-pointer rules are indexed per OtherTSLPointer, so removing
           the only pointer removes them rather than failing them. */
        expectedRuleIds: Object.freeze(["ts119612.scheme.pointers.structure"]),
        expectedLocalFailures: Object.freeze([]),
      },
    ]),
  },
  {
    id: "pem_service_certificate",
    label: "PEM service certificate",
    intent:
      "A service's digital identity carries PEM armour where strict Base64 DER is required, so the identity does not decode.",
    bindings: Object.freeze([
      {
        standard: "TS 119 602",
        artifactFormat: "JSON / JAdES",
        stage: "pre-sign",
        mutation:
          "Publish the service certificate as PEM text instead of the Base64 DER required by clause 6.6.3.",
        normativeReference: `${TS119602}, clause 6.6.3 (ServiceDigitalIdentity)`,
        conformantBehaviour:
          "A service certificate is published as Base64-encoded DER, with no PEM armour and no whitespace.",
        expectedRuleIds: Object.freeze(["ts119602.service.digital_identity"]),
        expectedLocalFailures: Object.freeze([]),
      },
      {
        standard: "TS 119 612",
        artifactFormat: "XML / XAdES-B-B",
        stage: "pre-sign",
        mutation:
          "Re-armour every X509Certificate in a ServiceDigitalIdentity as PEM, including the BEGIN/END lines, so the base64Binary content no longer decodes to a certificate.",
        normativeReference: `${TS119612}, clause 5.5.3 (ServiceDigitalIdentity)`,
        conformantBehaviour:
          "X509Certificate carries the Base64 DER encoding of the certificate, with no PEM armour.",
        /* PEM armour is not base64Binary, so the XSD rejects the element and
           the certificate is never reached by the certificate checks. */
        expectedRuleIds: Object.freeze(["schema.xsd"]),
        expectedLocalFailures: Object.freeze([LOCAL_FAILURE_IDS.xmlSchema]),
      },
    ]),
  },
  {
    id: "extension_without_criticality",
    label: "Extension without criticality",
    intent:
      "A service extension does not say whether a reader that cannot understand it may ignore it.",
    bindings: Object.freeze([
      {
        standard: "TS 119 602",
        artifactFormat: "JSON / JAdES",
        stage: "pre-sign",
        mutation:
          "Emit ServiceInformationExtensions containers with no criticality flag.",
        normativeReference: `${TS119602}, clause 6.6.9 (ServiceInformationExtensions)`,
        conformantBehaviour:
          "Every extension container states its criticality, so a reader that does not understand it knows whether it may be ignored.",
        expectedRuleIds: Object.freeze(["ts119602.service.extensions"]),
        expectedLocalFailures: Object.freeze([]),
      },
      {
        standard: "TS 119 612",
        artifactFormat: "XML / XAdES-B-B",
        stage: "pre-sign",
        mutation:
          "Add a ServiceInformationExtensions containing an Extension with no Critical attribute. The attribute is required by the pinned XSD, so the document also stops schema-validating.",
        normativeReference: `${TS119612}, clause 5.5.9 (ServiceInformationExtensions)`,
        conformantBehaviour:
          'Every Extension carries Critical="true" or Critical="false", so a reader knows whether it may ignore what it cannot parse.',
        expectedRuleIds: Object.freeze([
          "schema.xsd",
          "ts119612.service.extensions",
        ]),
        expectedLocalFailures: Object.freeze([LOCAL_FAILURE_IDS.xmlSchema]),
      },
    ]),
  },
  {
    id: "signer_organisation_mismatch",
    label: "Signer organisation mismatch",
    intent:
      "The list is signed by a certificate whose subject does not identify the scheme operator that published it.",
    bindings: Object.freeze([
      {
        standard: "TS 119 602",
        artifactFormat: "JSON / JAdES",
        stage: "post-sign",
        mutation:
          "Sign with a certificate whose subject organisation is not the scheme operator name.",
        normativeReference: `${TS119602}, Annex D to H signature requirements`,
        conformantBehaviour:
          "The signing certificate's subject organisation equals the scheme operator name published in the list.",
        expectedRuleIds: Object.freeze([
          "json_lote.signature.jades_signer_subject.organization",
        ]),
        expectedLocalFailures: Object.freeze([]),
      },
      {
        standard: "TS 119 612",
        artifactFormat: "XML / XAdES-B-B",
        stage: "post-sign",
        mutation:
          "Re-sign the list with a freshly minted TLSO-shaped certificate whose subject O and C are deliberately not the Scheme Operator Name and Scheme Territory. The signature still verifies; the signer does not match the list.",
        normativeReference: `${TS119612}, clause 5.7 and Annex B (TLSO signing certificate)`,
        conformantBehaviour:
          "The signing certificate's subject O equals SchemeOperatorName and its subject C equals SchemeTerritory.",
        expectedRuleIds: Object.freeze([
          "signature.signer_subject.organization",
          "signature.signer_subject.country",
        ]),
        expectedLocalFailures: Object.freeze([
          LOCAL_FAILURE_IDS.signingCertificateProfile,
        ]),
      },
    ]),
  },
  {
    id: "jades_without_signing_time",
    label: "JAdES without signing time",
    intent:
      "The signature claims no signing time, so it is not a Baseline-B signature.",
    bindings: Object.freeze([
      {
        standard: "TS 119 602",
        artifactFormat: "JSON / JAdES",
        stage: "post-sign",
        mutation:
          "Omit the iat protected header, so the signature is not JAdES Baseline B.",
        normativeReference:
          "ETSI TS 119 182-1, clause 5.2.1 (JAdES Baseline B signing time)",
        conformantBehaviour:
          "The claimed signing time is carried in the iat protected header as an integer NumericDate.",
        expectedRuleIds: Object.freeze([
          "json_lote.signature.jades_signing_time",
          "json_lote.signature.jades_baseline_b",
          "ts119602.profile.pub_eaa_providers.signature",
        ]),
        expectedLocalFailures: Object.freeze([]),
      },
    ]),
  },
  {
    id: "xades_without_signing_time",
    label: "XAdES without signing time",
    intent:
      "The signature claims no signing time, so it is not a Baseline-B signature. The XML counterpart of jades_without_signing_time, which cannot reuse that identifier because it names the JSON signature format.",
    bindings: Object.freeze([
      {
        standard: "TS 119 612",
        artifactFormat: "XML / XAdES-B-B",
        stage: "post-sign",
        mutation:
          "Delete xades:SigningTime from the signed SignedProperties and re-compute the SignedProperties reference digest and the signature, so the result is a cryptographically valid signature that is not Baseline B.",
        normativeReference:
          "ETSI EN 319 132-1, clause 5.2.1 (XAdES Baseline B signing time); TS 119 612 Annex B",
        conformantBehaviour:
          "SignedProperties carries exactly one xades:SigningTime, in UTC.",
        expectedRuleIds: Object.freeze([
          "signature.xades_baseline_b.signing_time",
        ]),
        /*
          Locally this surfaces as a signature finding: this publisher's
          verifier reports Baseline-B structure alongside cryptographic
          validity, and a signature with no signing time fails the former while
          passing the latter.
        */
        expectedLocalFailures: Object.freeze([
          LOCAL_FAILURE_IDS.xadesSignature,
        ]),
      },
    ]),
  },
  {
    id: "invalid_tsl_namespace",
    label: "Invalid TS 119 612 namespace",
    intent:
      "The document is published under a namespace that is not the Trusted List namespace, so it is not a Trusted List at all.",
    bindings: Object.freeze([
      {
        standard: "TS 119 612",
        artifactFormat: "XML / XAdES-B-B",
        stage: "pre-sign",
        mutation:
          "Replace the root default namespace http://uri.etsi.org/02231/v2# with http://uri.etsi.org/02231/v2-invalid#, leaving every element name unchanged.",
        normativeReference: `${TS119612}, clause 5.1 and Annex C (XML namespace)`,
        conformantBehaviour:
          "TrustServiceStatusList and its children are in the http://uri.etsi.org/02231/v2# namespace.",
        expectedRuleIds: Object.freeze(["parse.root_namespace", "schema.xsd"]),
        expectedLocalFailures: Object.freeze([LOCAL_FAILURE_IDS.xmlSchema]),
        familyNote:
          "This mutation can prevent the Inspector classifying the artifact as a TS 119 612 Trusted List at all. An artifact the Inspector cannot classify is recorded as such and is never reported as a pass.",
      },
    ]),
  },
  {
    id: "invalid_tsl_version_identifier",
    label: "Invalid TSLVersionIdentifier",
    intent:
      "The list declares a format version that is not the one this edition of the standard defines.",
    bindings: Object.freeze([
      {
        standard: "TS 119 612",
        artifactFormat: "XML / XAdES-B-B",
        stage: "pre-sign",
        mutation:
          "Publish TSLVersionIdentifier 5 instead of 6. It stays an integer, so the XSD is satisfied and only the profile rule fails.",
        normativeReference: `${TS119612}, clause 5.3.1 (TSLVersionIdentifier)`,
        conformantBehaviour:
          "TSLVersionIdentifier is 6, the version TS 119 612 V2.4.1 defines.",
        expectedRuleIds: Object.freeze(["ts119612.scheme.version"]),
        expectedLocalFailures: Object.freeze([]),
      },
    ]),
  },
  {
    id: "expired_next_update",
    label: "Expired NextUpdate",
    intent:
      "The list has passed the update it promised, so nothing in it can be relied on as current.",
    bindings: Object.freeze([
      {
        standard: "TS 119 612",
        artifactFormat: "XML / XAdES-B-B",
        stage: "pre-sign",
        mutation:
          "Rewrite NextUpdate to one day before ListIssueDateTime, so the list is stale at the moment it is issued.",
        normativeReference: `${TS119612}, clause 5.3.15 (NextUpdate)`,
        conformantBehaviour:
          "NextUpdate is later than ListIssueDateTime and at most six months after it.",
        /* A NextUpdate *before* the issue time fails the ordering rule; the
           expiry rule is about a list that has merely gone stale. */
        expectedRuleIds: Object.freeze([
          "dates.next_after_issue",
          "ts119612.scheme.next_update",
        ]),
        expectedLocalFailures: Object.freeze([LOCAL_FAILURE_IDS.freshness]),
      },
    ]),
  },
  {
    id: "incorrect_service_type",
    label: "Incorrect service type",
    intent:
      "A service is published under a service type that is not the one its family means.",
    bindings: Object.freeze([
      {
        standard: "TS 119 612",
        artifactFormat: "XML / XAdES-B-B",
        stage: "pre-sign",
        mutation:
          "Replace the family's ServiceTypeIdentifier with the certificate-authority type http://uri.etsi.org/TrstSvc/Svctype/CA/QC, a real TS 119 612 service type that is not the EAA or QEAA one.",
        normativeReference: `${TS119612}, clause 5.5.1 (ServiceTypeIdentifier)`,
        conformantBehaviour:
          "An EAA service is published as .../Svctype/EAA and a QEAA service as .../Svctype/EAA/Q.",
        /* A real but wrong type is structurally valid, so what fails is the
           relationship between the type and everything bound to it: the
           certificate's role, and — where the two vocabularies differ — the
           status the service carries. */
        expectedRuleIds: Object.freeze([
          "ts119612.service.certificate_role",
          "ts119612.service.status",
        ]),
        expectedLocalFailures: Object.freeze([]),
      },
    ]),
  },
  {
    id: "incorrect_service_status",
    label: "Incorrect service status",
    intent:
      "A service carries a status from the wrong vocabulary: a qualified status on a non-qualified service, or the reverse.",
    bindings: Object.freeze([
      {
        standard: "TS 119 612",
        artifactFormat: "XML / XAdES-B-B",
        stage: "pre-sign",
        mutation:
          "Swap the family's ServiceStatus for the other family's: an EAA service is published as granted, a QEAA service as recognisedatnationallevel.",
        normativeReference: `${TS119612}, clause 5.5.4 (ServiceStatus)`,
        conformantBehaviour:
          "A qualified service is granted or withdrawn; a nationally recognised service is recognisedatnationallevel or deprecatedatnationallevel. The vocabularies do not mix.",
        expectedRuleIds: Object.freeze(["ts119612.service.status"]),
        expectedLocalFailures: Object.freeze([]),
      },
    ]),
  },
  {
    id: "invalid_service_history",
    label: "Invalid service history",
    intent:
      "The service's history is not an order: a superseded state claims to have started at or after the state that replaced it.",
    bindings: Object.freeze([
      {
        standard: "TS 119 612",
        artifactFormat: "XML / XAdES-B-B",
        stage: "pre-sign",
        mutation:
          "Move every ServiceHistoryInstance StatusStartingTime one day *after* the current service's StatusStartingTime, so the superseded state postdates the state that replaced it.",
        normativeReference: `${TS119612}, clause 5.6 (ServiceHistory) and clause 5.6.5 (StatusStartingTime)`,
        conformantBehaviour:
          "Historical status times are strict UTC and strictly ordered newest-to-oldest before the current state.",
        expectedRuleIds: Object.freeze([
          "ts119612.service.history.status_start",
          "ts119612.service.history.status_transition",
        ]),
        expectedLocalFailures: Object.freeze([]),
        familyNote:
          "The fixture seeds a service that already carries one superseded history instance, so the ordering can be broken deterministically.",
      },
    ]),
  },
  {
    id: "broken_xades_signature",
    label: "Broken XAdES signature",
    intent:
      "The bytes were changed after they were signed, so the signature no longer verifies.",
    bindings: Object.freeze([
      {
        standard: "TS 119 612",
        artifactFormat: "XML / XAdES-B-B",
        stage: "post-sign",
        mutation:
          "After signing, edit the signed SchemeName text. The signature is left untouched, so it is a well-formed XAdES signature over content that no longer matches its digest.",
        normativeReference:
          "W3C XML Signature Syntax and Processing, clause 3.2 (core validation)",
        conformantBehaviour:
          "The published bytes are exactly the bytes that were signed, so the reference digests and the signature value both verify.",
        expectedRuleIds: Object.freeze([
          "signature.cryptographic_verification_result",
        ]),
        expectedLocalFailures: Object.freeze([
          LOCAL_FAILURE_IDS.xadesSignature,
        ]),
      },
    ]),
  },
  {
    id: "incorrect_signing_certificate",
    label: "Incorrect signing certificate",
    intent:
      "The list is signed by a certificate that is not a Trusted List signing certificate, even though the signature itself is sound.",
    bindings: Object.freeze([
      {
        standard: "TS 119 612",
        artifactFormat: "XML / XAdES-B-B",
        stage: "post-sign",
        mutation:
          "Re-sign with a CA certificate: basicConstraints CA:TRUE and a key usage of keyCertSign and cRLSign, with the correct subject. The signature verifies cryptographically, which is what separates this defect from broken_xades_signature.",
        normativeReference: `${TS119612}, clause 5.7 and Annex B (TLSO signing certificate)`,
        conformantBehaviour:
          "The Trusted List is signed by an end-entity certificate stating basicConstraints CA:FALSE and a key usage limited to digitalSignature and/or contentCommitment.",
        expectedRuleIds: Object.freeze([
          "ts119612.signature.certificate.basic_constraints",
          "ts119612.signature.certificate.key_usage",
        ]),
        expectedLocalFailures: Object.freeze([
          LOCAL_FAILURE_IDS.signingCertificateProfile,
        ]),
      },
    ]),
  },
  {
    id: "incorrect_sha2_digest",
    label: "Incorrect .sha2 digest",
    intent:
      "The digest published beside the list does not describe the list, so an integrity check against it fails.",
    bindings: Object.freeze([
      {
        standard: "TS 119 612",
        artifactFormat: "XML / XAdES-B-B",
        stage: "publication",
        mutation:
          "Publish a trusted-list.sha2 whose final hex digit is rotated, so the sidecar digest is a well-formed SHA-256 that is not the digest of the published XML.",
        normativeReference: `${TS119612}, clause 6.1 (distribution of the Trusted List and its digest)`,
        conformantBehaviour:
          "trusted-list.sha2 contains the SHA-256 of the exact published XML bytes, lowercase hex and nothing else.",
        /*
          The Inspector assesses the artifact it is given and never sees the
          sidecar file, so this defect is expected to trip no Inspector rule at
          all. That is recorded here rather than left implicit, because an empty
          expectation is a claim about the Inspector's scope.
        */
        expectedRuleIds: Object.freeze([]),
        expectedLocalFailures: Object.freeze([LOCAL_FAILURE_IDS.sha2Digest]),
      },
    ]),
  },
]);

/**
 * A defect as one standard sees it: the canonical identity flattened together
 * with that standard's binding. This is the shape every consumer works with —
 * a form rendering checkboxes, a mutation engine, a fixture report.
 */
export interface DefectSpec {
  readonly id: string;
  readonly label: string;
  readonly intent: string;
  /** The binding's mutation, which is what this format actually does. */
  readonly description: string;
  readonly standard: DefectStandard;
  readonly artifactFormat: DefectArtifactFormat;
  readonly stage: DefectStage;
  readonly normativeReference: string;
  readonly conformantBehaviour: string;
  readonly expectedRuleIds: readonly string[];
  readonly expectedLocalFailures: readonly string[];
  readonly familyNote?: string;
}

function flatten(defect: CanonicalDefect, binding: DefectBinding): DefectSpec {
  return {
    id: defect.id,
    label: defect.label,
    intent: defect.intent,
    description: binding.mutation,
    standard: binding.standard,
    artifactFormat: binding.artifactFormat,
    stage: binding.stage,
    normativeReference: binding.normativeReference,
    conformantBehaviour: binding.conformantBehaviour,
    expectedRuleIds: binding.expectedRuleIds,
    expectedLocalFailures: binding.expectedLocalFailures,
    ...(binding.familyNote ? { familyNote: binding.familyNote } : {}),
  };
}

const BY_STANDARD = new Map<DefectStandard, readonly DefectSpec[]>(
  (["TS 119 602", "TS 119 612"] as const).map((standard) => [
    standard,
    Object.freeze(
      DEFECT_CATALOGUE.flatMap((defect) => {
        const binding = defect.bindings.find(
          (candidate) => candidate.standard === standard,
        );
        return binding ? [flatten(defect, binding)] : [];
      }),
    ),
  ]),
);

/** Every defect this standard can express, in catalogue order. */
export function defectsForStandard(
  standard: DefectStandard,
): readonly DefectSpec[] {
  return BY_STANDARD.get(standard) ?? [];
}

/** Deduplicates a selection and returns it in canonical catalogue order. */
export function normalizeDefectSelectionForStandard(
  ids: readonly string[],
  standard: DefectStandard,
): string[] {
  const selected = new Set(ids);
  return defectsForStandard(standard)
    .filter((spec) => selected.has(spec.id))
    .map((spec) => spec.id);
}

export function defectForStandard(
  id: string,
  standard: DefectStandard,
): DefectSpec | undefined {
  return defectsForStandard(standard).find((spec) => spec.id === id);
}

/** True when this standard has a mutation for this defect. */
export function isKnownDefectFor(
  id: string,
  standard: DefectStandard,
): boolean {
  return defectForStandard(id, standard) !== undefined;
}

/** The selected defects this standard applies at one stage, in catalogue order. */
export function defectsAtStageFor(
  ids: readonly string[],
  standard: DefectStandard,
  stage: DefectStage,
): DefectSpec[] {
  return defectsForStandard(standard).filter(
    (spec) => ids.includes(spec.id) && spec.stage === stage,
  );
}

/** Every Inspector rule ID the selected defects are expected to trip. */
export function expectedRuleIdsForStandard(
  ids: readonly string[],
  standard: DefectStandard,
): string[] {
  const rules = new Set<string>();
  for (const id of ids)
    for (const rule of defectForStandard(id, standard)?.expectedRuleIds ?? [])
      rules.add(rule);
  return [...rules].sort();
}

/** Every local check ID the selected defects are expected to fail. */
export function expectedLocalFailuresForStandard(
  ids: readonly string[],
  standard: DefectStandard,
): string[] {
  const failures = new Set<string>();
  for (const id of ids)
    for (const failure of defectForStandard(id, standard)
      ?.expectedLocalFailures ?? [])
      failures.add(failure);
  return [...failures].sort();
}

/**
 * Strips the positional indices the Trust Inspector embeds in a rule ID.
 *
 * The Inspector names a per-item check by its position, so the same rule about
 * the same kind of thing arrives as `ts119612.service.1.1.history.1.status_start`
 * for one list and `ts119612.service.2.1.history.3.status_start` for another. An
 * expectation cannot be written against a position that depends on how many
 * providers a fixture happens to carry, so both sides are compared with the
 * integer segments removed.
 */
export function normalizeInspectorRuleId(ruleId: string): string {
  return ruleId
    .split(".")
    .filter((segment) => !/^\d+$/.test(segment))
    .join(".");
}

/** Rule ID part of a `${id}: ${message}` failure line, normalized. */
export function normalizedRuleIdOf(failure: string): string {
  const separator = failure.indexOf(":");
  return normalizeInspectorRuleId(
    separator === -1 ? failure : failure.slice(0, separator),
  );
}

/**
 * Compares expectation against what actually failed.
 *
 * Cascading failures are expected — one mutation can trip several rules — so an
 * unexpected failure is *reported* rather than treated as wrong. Both sides are
 * normalized first, so a rule that moved position still matches.
 */
export function compareFailures(
  expected: readonly string[],
  actualFailureLines: readonly string[],
): { matched: string[]; missing: string[]; additional: string[] } {
  const actualIds = new Set(actualFailureLines.map(normalizedRuleIdOf));
  const expectedSet = new Set(expected.map(normalizeInspectorRuleId));
  return {
    matched: expected
      .filter((rule) => actualIds.has(normalizeInspectorRuleId(rule)))
      .sort(),
    missing: expected
      .filter((rule) => !actualIds.has(normalizeInspectorRuleId(rule)))
      .sort(),
    additional: [...actualIds].filter((rule) => !expectedSet.has(rule)).sort(),
  };
}
