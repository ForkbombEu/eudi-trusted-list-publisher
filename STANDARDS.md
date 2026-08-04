# Standards

## Project scope

This project publishes Trusted Lists under **two standards**:

1. **ETSI TS 119 602** — JSON Lists of Trusted Entities, signed as Compact
   JAdES, for five profiles: PID Providers (Annex D), Wallet Providers
   (Annex E), WRPAC Providers (Annex F), WRPRC Providers (Annex G) and Pub-EAA
   Providers (Annex H).
2. **ETSI TS 119 612** — XML national Trusted Lists, signed as enveloped
   XAdES-B-B, carrying two onboarding service profiles: **EAA Providers**
   (non-qualified) and **QEAA Providers** (qualified).

The two are kept apart everywhere they differ. `src/core/profiles/registry.ts`
describes TS 119 602 and nothing else; `src/core/tsl612/registry.ts` describes
TS 119 612. One format-aware catalogue names both, so a page states which
standard and which artifact format a list uses rather than inferring it.

### Normative definitions

1. **TS 119 602 List of Trusted Entities (LoTE)** — implemented, JSON/JAdES.
2. **TS 119 612 national Trusted List (TSL)** — implemented, XML/XAdES-B-B.
3. **List of Trusted Lists (LoTL)** — not aggregated. Only the mandatory
   *pointer* to the EU LOTL is published, as clause 5.3.13 requires.
4. **EC TS02 provider notification/publication API** — out of scope.

## Primary standards

### ETSI TS 119 602 V1.1.1 (2025-11)

- Title: Electronic Signatures and Infrastructures (ESI); Lists of trusted entities; Data model
- URL: https://www.etsi.org/deliver/etsi_ts/119600_119699/119602/01.01.01_60/ts_119602v010101p.pdf
- Date retrieved: 2026-07-28
- Defines the abstract data model for LoTE with JSON and XML bindings
- Profile-based approach for six entity families: PID Providers (Annex D),
  Wallet Providers (Annex E), WRPAC Providers (Annex F), WRPRC Providers
  (Annex G), Pub-EAA Providers (Annex H) and Registrars and Registers. The last
  is catalogued and disabled.
- References ETSI TS 119 182-1 (JAdES) for JSON signatures

### ETSI TS 119 182-1 (JAdES)

- Defines Compact JAdES Baseline B profile for JSON Advanced Electronic Signatures
- All five implemented profiles require Compact JAdES Baseline B
- JAdES Compact Serialization: BASE64URL(UTF8(JWS Protected Header)).BASE64URL(JWS Payload).BASE64URL(JWS Signature)
- Required header parameters: `alg`, `x5c` (certificate chain), `typ` (optional, value "JAdES")

### ETSI TS 119 612 V2.4.1 (2025-11)

- Title: Electronic Signatures and Infrastructures (ESI); Trusted Lists
- URL: https://www.etsi.org/deliver/etsi_ts/119600_119699/119612/02.04.01_60/ts_119612v020401p.pdf
- Defines XML `TrustServiceStatusList` Trusted Lists and their XAdES signature
- The second standard this project publishes, and the standard behind the EAA
  Providers and QEAA Providers families. Its artifact is XML signed with an
  enveloped XAdES-B-B signature, not JSON signed with Compact JAdES.

## ETSI XML Schemas (TS 119 612)

Vendored under `schemas/etsi/119612/`, byte-for-byte, from the ETSI Forge
`v2.4.1` tag and the schemas that tag imports. Retrieval date: 2026-08-03.

| File | Source URL | SHA-256 | Licence |
|------|-----------|---------|---------|
| `19612_xsd.xsd` | https://forge.etsi.org/rep/esi/x19_612_trusted_lists/-/raw/v2.4.1/19612_xsd.xsd | `0cb6ac0e96f9600934d216513f21e4cc5b41f8c8c28a8e42102a8135b24df3e1` | BSD 3-Clause |
| `19612_additionaltypes_xsd.xsd` | https://forge.etsi.org/rep/esi/x19_612_trusted_lists/-/raw/v2.4.1/19612_additionaltypes_xsd.xsd | `25f9292d8c246cbacab9f345451d64cdb63154a12042ffc675cdf2c88896948b` | BSD 3-Clause |
| `19612_sie_xsd.xsd` | https://forge.etsi.org/rep/esi/x19_612_trusted_lists/-/raw/v2.4.1/19612_sie_xsd.xsd | `382fcf497770a5842ac9975db0f14020c33c936b1903e057548ad6724cf42d69` | BSD 3-Clause |
| `1913201-XAdES01903v132.xsd` | https://forge.etsi.org/rep/esi/x19_13201_xades/-/raw/v1.3.1/1913201-XAdES01903v132.xsd | `457745286eaa292ae1aaa6e976e0f30eeceb0a37cc2301151576175e0ae1986c` | BSD 3-Clause |
| `1913201-XAdES01903v141.xsd` | https://forge.etsi.org/rep/esi/x19_13201_xades/-/raw/v1.3.1/1913201-XAdES01903v141.xsd | `286bd63f122aafb907c03724c5959455d114020e523631cc22e90c5f5aa667e2` | BSD 3-Clause |
| `xmldsig-core-schema.xsd` | http://www.w3.org/TR/2008/REC-xmldsig-core-20080610/xmldsig-core-schema.xsd | `35cf8197da812c85e40d57891b35c94187569ed474a2dac813ce5090dafcd35c` | W3C Document Licence |
| `xml.xsd` | http://www.w3.org/2001/xml.xsd | `61960fb3131e38022caad5360e2f33a3382578ab3c80cd58bd74320ede61b20c` | W3C Document Licence |
| `xml-2009.xsd` | http://www.w3.org/2009/01/xml.xsd | `cc701736c42cc64126fad063bb95f94484b5de3b5f808a86ea098b0957aff829` | W3C Document Licence |

`LICENSE` beside them is the ETSI Forge licence file, copied from the same two
tags — the two repositories publish identical text.

### Where the XAdES schema came from

`19612_sie_xsd.xsd` and `19612_additionaltypes_xsd.xsd` import the XAdES 1.3.2
schema from `https://uri.etsi.org/01903/v1.3.2/XAdES01903v132-201601.xsd`. That
host returns HTTP 403 to this project, the same refusal `etsi.org` gives the
PDFs. The identical schema is published on ETSI Forge as
`esi/x19_13201_xades`, whose newest tag is `v1.3.1`, and the vendored file is
taken from there. Its `targetNamespace` is
`http://uri.etsi.org/01903/v1.3.2#`, which is what the importing schemas ask
for; the tag names the ETSI *deliverable* version, not the namespace version.

### Offline resolution without rewriting

Every `schemaLocation` in these files is an absolute URL. Rewriting them to
relative paths would make the vendored bytes differ from the published bytes
and void the hashes above, so this project does not rewrite them. Instead
`src/core/tsl612/schema.ts` registers a libxml2 input provider that answers
those exact URLs from `schemas/etsi/119612/`, and
`src/core/tsl612/schema-sources.ts` is the single URL-to-file mapping. A URL
this project has not vendored is not matched, so a missing import fails
validation rather than reaching the network. Both `http://` and `https://`
spellings of the W3C schemas resolve to the same file, because the importing
schemas do not agree on which to print.

Tests must never fetch schemas from the network.

## EAA and QEAA service profiles (TS 119 612)

One XML Trusted List is a **national** list; EAA and QEAA are **service
profiles inside it**, not lists of their own. A list declares which it accepts
through `allowedServiceProfiles`, so one list may take EAA, QEAA or both. The
onboarding family the applicant uses decides the service type and the status
vocabulary; `src/core/tsl612/registry.ts` holds both, and the submission parser
refuses a family the target list does not accept.

| | EAA Providers | QEAA Providers |
|---|---|---|
| Service type | `http://uri.etsi.org/TrstSvc/Svctype/EAA` | `http://uri.etsi.org/TrstSvc/Svctype/EAA/Q` |
| Initial status | `.../Svcstatus/recognisedatnationallevel` | `.../Svcstatus/granted` |
| End status | `.../Svcstatus/deprecatedatnationallevel` | `.../Svcstatus/withdrawn` |
| Administration action | Deprecate national recognition | Withdraw qualified status |
| Qualified | no | yes |

The two vocabularies never mix: a test asserts that no status URI appears in
both families.

### List-level values

Every list this publisher produces states:

- `TSLTag` `http://uri.etsi.org/19612/TSLTag`, `TSLVersionIdentifier` 6
- `TSLType` `.../TSLType/EUgeneric`, status determination
  `.../StatusDetn/EUappropriate`
- three `SchemeTypeCommunityRules` URIs: `.../schemerules/EUcommon`,
  `.../schemerules/<CC>` and the operator's national rules URI
- `SchemeName` = `<SchemeTerritory>:<Trusted List Name>`; creation adds the
  prefix idempotently so an already-prefixed API value is not doubled
- `SchemeTerritory` = the responsible **Member State**. `EU` is refused: a
  Member State list is not published for the Union as a whole
- `DistributionPoints` names the stable XML publication URL. When the operator
  does not override it, this publisher uses the deployed public origin and
  `/lists/<listKey>/latest/trusted-list.xml`, never a fixed sequence URL
- `HistoricalInformationPeriod` 65535 — permanent history, which is what makes
  a superseded state meaningful
- `NextUpdate` at most six months after `ListIssueDateTime`
- **no** `SchemeExtensions`
- a `PointersToOtherTSL` entry for the EU LOTL, with its location, digital
  identity and qualifiers

An empty first version omits `TrustServiceProviderList` entirely rather than
emitting an empty one.

### Status times, history and immutability

- The **initial status time is the publication event** — the same instant the
  version is issued with, not a separate clock reading.
- **Ordinary republication preserves `StatusStartingTime`.** A provider carried
  into a new version keeps the instant its status actually began. This is the
  opposite of the Annex H rule in TS 119 602, which restates the time on every
  version; TS 119 612 keeps permanent history, so the original instant stays
  meaningful.
- A **status change publishes a new version**. The previous state moves into
  `ServiceHistory`, most recent first, and the version that listed the service
  as current is never rewritten.
- A history instance carries **at least one `X509SKI` and no
  `X509Certificate`**. Republishing the certificate would restate a current
  identity for a state that is no longer current.

### Identifying a published service

By **service type plus the SHA-256 of the certificate's subject public key**.
The name is not the identity: two providers may publish the same service name,
and a provider may rename a service. The key is what a relying party verifies
against. Publication, supersession and reconciliation all use this, and refuse
rather than match by position.

### The registration identifier

Published in `TSPTradeName` as `VAT<CC>-<identifier>` when the applicant holds a
VAT identifier and `NTR<CC>-<identifier>` otherwise, where `<CC>` is the
territory of the **target list**, never a value the applicant supplies. A
prefix the applicant already typed is not doubled.

### The service certificate

Published as Base64 DER in `ServiceDigitalIdentity`. The subject organisation
(`O`) should equal `TSPName`. Where it differs, the applicant must supply that
organisation as a TSP trade name **and** a `SchemeServiceDefinitionURI`
documenting the relationship — the live Trust Inspector fails
`ts119612.service.1.1.certificate_subject_tsp_name` without it.

### Review evidence is never published

EAA onboarding collects evidence of national recognition, QEAA evidence of
qualified status. Both are retained for administrator review and appear in no
artifact: they are the basis on which a decision is taken, not a component of
the Trusted List. A test asserts the evidence text is absent from the published
XML.

## The XAdES-B-B signature (TS 119 612 Annex B, EN 319 132-1)

Implemented in `src/xmlsec/`, which depends only on `node:crypto` and
`libxml2-wasm` and knows nothing about Trusted Lists.

- enveloped signature over the whole document, `ds:Reference URI=""`
- enveloped-signature transform **then** Exclusive XML Canonicalisation
- Exclusive canonicalisation for `SignedInfo`
- XAdES `SignedProperties` under its own reference, with `SigningTime` and
  `SigningCertificateV2` (including `IssuerSerialV2`, lifted verbatim from the
  certificate DER rather than re-encoded from a parsed string)
- `SignedDataObjectProperties/DataObjectFormat` naming the document reference
  and the TSL media type
- `ds:KeyInfo/X509Data` carrying exactly one certificate
- ECDSA-SHA256 or RSA-SHA256; ECDSA signature values are IEEE P1363 `r || s`,
  not the DER SEQUENCE Node produces by default
- the signature is verified locally before it is returned

### The enveloped transform is computed over the signed document

The transform is defined over the document *containing* the signature: it
removes the `ds:Signature` element and nothing else. Digesting the document
before the signature was inserted omits the whitespace the insertion adds, and
the first implementation here did exactly that and failed its own verification.
This is recorded because it produces a signature that looks correct and
verifies nowhere.

The transform excludes `ds:Signature` **structurally**, not by node identity:
libxml2-wasm builds a fresh JavaScript wrapper per visit, so a `Set` of nodes
matches nothing.

### The Scheme Operator signing certificate

Checked where the material is configured, again when a list is created, and
again before every signature:

- subject `C` equals the Scheme Territory
- subject `O` equals the Scheme Operator Name
- `basicConstraints` states `CA:FALSE` — a Trusted List is signed by an end
  entity
- a `SubjectKeyIdentifier` is present
- key usage asserts only `digitalSignature` and/or `contentCommitment`
- where `extendedKeyUsage` is present it permits `tslSigning`
  (`0.4.0.2231.3.0`) or `anyExtendedKeyUsage`

`generateSigningMaterial({ profile: "trusted-list" })` produces material that
meets this and asserts the `tslSigning` purpose. The default profile stays
`lote`, so the five TS 119 602 families are unaffected.

## Trust Inspector evidence for TS 119 612

Established empirically against the live Inspector
(`https://trust-inspector.credimi.io`, `POST /api/audit/artifact`) with
`contentType: application/vnd.etsi.tsl+xml`. It reports
`detected.artifactKind = ts119612_xml_tsl` and answers under a `ts119612`
section, which is the section this publisher's summary reads — reading the
TS 119 602 section for an XML artifact would report zero checks and call that a
pass.

A conforming EAA list produced by this publisher scores **121 pass, 11
not_applicable, 7 not_checked, 2 warn, 2 inconclusive, 0 fail** (re-measured
2026-08-03).

Three findings shaped the implementation:

- `signature.xades_baseline_b.data_object_formats` **failed** on the first
  attempt. EN 319 132-1 requires a `DataObjectFormat` per signed data object
  other than the SignedProperties, and the signer emitted none. This was a real
  conformance gap, not a data problem.
- `ts119612.pointer.1.signing_certificates` fails when the LOTL pointer's
  declared scheme operator does not match the pointer certificates. The
  list-creation form states that the two must describe the same list.
- `ts119612.service.1.1.certificate_subject_tsp_name` fails when a service
  certificate's subject `O` differs from `TSPName` with no
  `SchemeServiceDefinitionURI`. The submission parser enforces the rule.

Remaining warnings are understood and not defects of the artifact:
`parse.schema_location`;
`ts119612.signature.certificate.extended_key_usage`, absent unless the signer
carries the `tslSigning` EKU; and `ts119612.pointer.1.rollover`, which wants two
key pairs with shifted validity — an operational property of key management,
not something a generator produces.

## ETSI JSON Schemas

Vendored from: https://forge.etsi.org/rep/esi/x19_60201_lists_of_ordered_entities

| File | Source URL | SHA-256 | Licence |
|------|-----------|---------|---------|
| `schemas/etsi/1960201_json_schema.json` | https://forge.etsi.org/rep/esi/x19_60201_lists_of_trusted_entities/-/raw/main/1960201_json_schema/1960201_json_schema.json | `37c0f82711f7cdeb2680fc64674735d8e5a632561bd40ddf962059ae9ffd1d5c` | BSD 3-Clause |
| `schemas/etsi/1960201_json_schema_sie.json` | https://forge.etsi.org/rep/esi/x19_60201_lists_of_trusted_entities/-/raw/main/1960201_json_schema/1960201_json_schema_sie.json | `49319d1aa5553c085b6aea11fad736b57f9a2b6d63a3cfebce16b3c27b05e019` | BSD 3-Clause |
| `schemas/etsi/1960201_json_schema_tie.json` | https://forge.etsi.org/rep/esi/x19_60201_lists_of_trusted_entities/-/raw/main/1960201_json_schema/1960201_json_schema_tie.json | `3848bee86fe67bf2bb1f753ee072c5e9cc79533b4e78fd410ff49a0053740919` | BSD 3-Clause |
| `schemas/etsi/rfc7517.json` | https://forge.etsi.org/rep/esi/x19_60201_lists_of_trusted_entities/-/raw/main/1960201_json_schema/rfcs/rfc7517.json | `2f959c526ac073952ffff7a3944164a20b12897b0aa1a7b61e79511fafa863c6` | BSD 3-Clause |

Retrieval date: 2026-07-28. Tests must never fetch schemas from the network.

### Schema notes

- The TIE extension (`1960201_json_schema_tie.json`) references the main schema as
  `1960201-jsonSchema.json` but the actual filename is `1960201_json_schema.json`.
  This is a minor naming inconsistency in the upstream repository. Our validation
  resolves this by loading all schema files into a single Ajv instance.
- The vendored schema describes the generic LoTE structure, where `TETradeName`
  is optional. `schemas/profiles/pub-eaa-schema.json` is the local Annex H.3
  overlay: validation applies it only to the Pub-EAA LoTE type and requires each
  entity's `TETradeName` to contain the formatted legal-basis URI.

## Wallet Provider Profile (Annex E)

### Required URIs

- LoTE Type: `http://uri.etsi.org/19602/LoTEType/EUWalletProvidersList`
- Status Determination Approach: `http://uri.etsi.org/19602/WalletProvidersList/StatusDetn/EU`
- Scheme Type/Community/Rules: `http://uri.etsi.org/19602/WalletProvidersList/schemerules/EU`
- Service Types:
  - `http://uri.etsi.org/19602/SvcType/WalletSolution/Issuance`
  - `http://uri.etsi.org/19602/SvcType/WalletSolution/Revocation`

### Profile constraints

- ServiceStatus component **shall not** be used
- StatusStartingTime component **shall not** be used
- HistoricalInformationPeriod **shall not** be present
- ServiceUniqueIdentifier extension **shall** be used
- Next update maximum: 6 months from issue time
- Signature: Compact JAdES Baseline B

## PID Provider Profile (Annex D)

ETSI TS 119 602 V1.1.1 Annex D is the normative PID source. Table D.1 fixes
the LoTE type to `http://uri.etsi.org/19602/LoTEType/EUPIDProvidersList`, the
status-determination URI to
`http://uri.etsi.org/19602/PIDProvidersList/StatusDetn/EU`, and the scheme
rules URI to `http://uri.etsi.org/19602/PIDProviders/schemerules/EU`; it also
sets EU territory, omits historical information, and limits NextUpdate to six
months. Table D.3 exclusively permits `SvcType/PID/Issuance` and
`SvcType/PID/Revocation`, requires X.509 service identity, and prohibits
ServiceStatus and StatusStartingTime. Annex D.4 requires Compact JAdES Baseline
B. This implementation uses the existing explicit authoring fields for the
Annex D service semantics and requires a responsible Member State on PID
applications; that latter form field is a project-local authoring choice.

## WRPAC Provider Profile (Annex F)

Wallet-Relying-Party Access Certificate Providers. Constants in
`src/core/profiles/wrpac-provider/constants.ts`:

- LoTE Type: `http://uri.etsi.org/19602/LoTEType/EUWRPACProvidersList`
- Status Determination Approach: `http://uri.etsi.org/19602/WRPACProvidersList/StatusDetn/EU`
- Scheme Type/Community/Rules: `http://uri.etsi.org/19602/WRPACProvidersList/schemerules/EU`
- Entity role URI prefix: `http://uri.etsi.org/19602/ListOfTrustedEntities/WRPACProvider`
- Service Types:
  - `http://uri.etsi.org/19602/SvcType/WRPAC/Issuance`
  - `http://uri.etsi.org/19602/SvcType/WRPAC/Revocation`

## WRPAC and WRPRC service CA certificates

The WRPAC and WRPRC service digital identities are the CA certificates whose
public keys are used to verify the signatures or seals on certificates issued
by those providers. At submission time the publisher applies the RFC 5280
CA-certificate rules that are locally decidable from each certificate:

- `basicConstraints` is critical and asserts `CA:TRUE` (clause 4.2.1.9);
- `keyUsage` is critical and contains `keyCertSign` (clause 4.2.1.3). Requiring
  criticality is the project's stricter WRPAC/WRPRC rule; RFC 5280 says it
  SHOULD be critical. Compatible additional usages such as `cRLSign` remain
  permitted;
- a non-critical, non-empty `SubjectKeyIdentifier` is present (clause 4.2.1.2).
  Its value is not required to use one fixed hash construction because RFC 5280
  permits other unique identifier methods;
- a non-self-signed certificate has a non-critical `AuthorityKeyIdentifier`
  containing `keyIdentifier` (clause 4.2.1.1). Subject/issuer equality alone is
  not enough: the self-signed exception applies only when the signature also
  verifies with the certificate's own public key; and
- the current time is within the certificate's validity interval.

These checks establish that the submitted key is declared usable for certificate
signature verification. The publisher does not build a certification path,
check revocation or prove possession of the corresponding private key. A
self-signed CA certificate is acceptable when it meets the checks above.

## WRPRC Provider Profile (Annex G)

Wallet-Relying-Party Registration Certificate Providers. Constants in
`src/core/profiles/wrprc-provider/constants.ts`:

- LoTE Type: `http://uri.etsi.org/19602/LoTEType/EUWRPRCProvidersList`
- Status Determination Approach: `http://uri.etsi.org/19602/WRPRCrovidersList/StatusDetn/EU`
- Scheme Type/Community/Rules: `http://uri.etsi.org/19602/WRPRCProvidersList/schemerules/EU`
- Entity role URI prefix: `http://uri.etsi.org/19602/ListOfTrustedEntities/WRPRCProvider`
- Service Types:
  - `http://uri.etsi.org/19602/SvcType/WRPRC/Issuance`
  - `http://uri.etsi.org/19602/SvcType/WRPRC/Revocation`

### The `WRPRCrovidersList` literal

Annex G prints the status-determination URI as `WRPRCrovidersList`, without the
`P` of `Providers`, while the scheme-rules URI on the same page reads
`WRPRCProvidersList`. The publisher reproduces both exactly as printed. A status
determination approach is matched literally by a reader, so silently
"correcting" the token would produce a URI that nothing recognises. A test
asserts the literal, and the live Trust Inspector classifies the resulting
artifact as `wrprc_providers`, which is the empirical confirmation that the
printed form is the expected one.

### Annex F/G profile constraints

Both profiles, as implemented:

- JSON LoTE, `LoTEVersionIdentifier: 1`, `SchemeTerritory: EU`
- `HistoricalInformationPeriod` **shall not** be present
- `ServiceStatus` and `StatusStartingTime` **shall not** be used
- The **ServiceUniqueIdentifier extension is not used**, unlike Annex D/E, so no
  `ServiceInformationExtensions` container is emitted at all — an empty
  container would breach clause 6.6.9, which requires every container to state
  its criticality
- Self pointer in `PointersToOtherLoTE`, `MimeType: application/jose`
- `NextUpdate` at most six months after the issue time
- Signature: Compact JAdES Baseline B
- Entity role URI `<prefix>/<CC>`, where `<CC>` is the **Responsible Member
  State** that mandates the provider — not the provider's own country

### What listing means, and what it does not

Neither profile publishes a service status, so the list carries no way to say
"this provider was withdrawn". Presence of an entity in the current version is
itself the statement that the provider is currently mandated by the Responsible
Member State; a provider that loses its mandate is removed from the next version.
The onboarding form and the administration review page both state this in words,
because the artifact cannot.

### Collected but not published: the registration identifier

The Annex F/G onboarding forms collect the official registration identifier
"where available". It is stored with the application and shown on the
administration review page, and it is **not** published in the LoTE. The
authoring model has no field for it: `TrustedEntityInformation` offers `TEName`,
`TETradeName`, `TEAddress`, `TEInformationURI` and `TEInformationExtensions`, and
placing a registration identifier in any of them would be an inference this
project cannot check — the ETSI PDF is unreachable (etsi.org returns HTTP 403)
and the live Inspector reports no check about it. If a future Inspector check
asks for one, the field is already collected.

## Pub-EAA Provider Profile (Annex H)

Providers of publicly issued electronic attestations of attributes. Constants in
`src/core/profiles/pub-eaa-provider/constants.ts`:

- LoTE Type: `http://uri.etsi.org/19602/LoTEType/EUPubEAAProvidersList`
- Status Determination Approach: `http://uri.etsi.org/19602/PubEAAProvidersList/StatusDetn/EU`
- Scheme Type/Community Rules: `http://uri.etsi.org/19602/PubEAAProvidersList/schemerules/EU`
- Entity role URI prefix: `http://uri.etsi.org/19602/ListOfTrustedEntities/PubEAAProvider`
- Service Types:
  - `http://uri.etsi.org/19602/SvcType/PubEAA/Issuance`
  - `http://uri.etsi.org/19602/SvcType/PubEAA/Revocation`
- Service Statuses:
  - `http://uri.etsi.org/19602/PubEAAProvidersList/SvcStatus/notified`
  - `http://uri.etsi.org/19602/PubEAAProvidersList/SvcStatus/withdrawn`

### How Annex H was established

The locally decidable Annex H rules were initially read from Trust Inspector
evidence and confirmed empirically against the live Inspector. The Annex H.3
`TETradeName` rule and its legal-reference syntax were subsequently supplied
directly from the standard: that normative text takes precedence over the
earlier placement probes.

### Annex H profile constraints

- JSON LoTE, `LoTEVersionIdentifier: 1`, `SchemeTerritory: EU`
- `HistoricalInformationPeriod` **shall** be present and equal **65535** — the
  only implemented profile that publishes the component at all
- `PointersToOtherLoTE` **shall be absent** — the only implemented profile with
  no self pointer. `publishesSelfPointer` in the registry decides this, so the
  component is not emitted merely because signing certificates are available
- `ServiceStatus` and `StatusStartingTime` **shall** be published for every
  service — again the only implemented profile that does
- The **ServiceUniqueIdentifier extension is not used**, as in Annex F/G, so no
  `ServiceInformationExtensions` container is emitted
- The service digital identity is **optional** (`optional_pub_eaa` in the
  Inspector's evidence)
- `NextUpdate` at most six months after the issue time
- Signature: Compact JAdES Baseline B
- Entity role URI `<prefix>/<CC>`, where `<CC>` is the **Responsible Member
  State** that notified the provider

### The legal-basis reference

Annex H.3 requires `TETradeName` on every Pub-EAA trusted entity. The component
contains:

- the official registration identifier, where one exists, with
  `organizationIdentifier` semantics for a legal entity or `serialNumber`
  semantics for a natural person; and
- the Union or national act under which the responsible public sector body is
  established or designated.

The act is formatted as an `OJ:` URI followed by exactly two jurisdiction
characters — `EU` for Union law or the ISO 3166-1 alpha-2 code of an EU Member
State for national law — and then a non-empty identifier that uniquely
represents the act. `legalBasisUri()` adds the `OJ:` scheme when the applicant
omits it, while `isLegalBasisReference()` rejects missing identifiers,
non-Member-State jurisdiction codes and whitespace.

The legal-basis URI is published only in `TETradeName`; it is not duplicated in
`TEInformationURI` or `TEElectronicAddress`.

### Certificates

Annex H makes the certificate optional and permits more than one for a single
service — the attestation-signing certificate or the CA certificate that issues
those certificates (`certificatePurpose.purpose` reads
`attestation_signature_or_issuing_ca_verification`). This publisher therefore:

- publishes each supplied certificate as Base64 DER, as in every other profile;
- keeps the project-local rule that the subject `O` equals `TEName`;
- requires every certificate supplied for one service to carry the **same public
  key** and an **identical subject** (`pubEaaCertificateConstraints`), because
  they are renditions of one identity rather than a certification path;
- emits `ServiceDigitalIdentity: {}` when no certificate is supplied. The
  identity arrays have `minItems: 1`, so an empty `X509Certificates` array would
  be invalid; an absent identity is the honest encoding of an absent certificate.

### Notification, withdrawal and service history

Initial approval publishes every service as `notified`, with a
`StatusStartingTime` taken from the publication event — the same instant the list
is issued with, not a separate clock reading.

The administration Withdraw action publishes a **new immutable version**: every
service of that provider reads `withdrawn` from the withdrawal instant, and the
previous state is moved into `ServiceHistory`, most recent superseded state
first. The already-published version is never rewritten, so both remain
authentic and downloadable.

A history instance carries **at least one `X509SKI` and no `X509Certificate`**
(`pubEaaSkiOnlyRule`). The identifier is read from the certificate's
SubjectKeyIdentifier extension where it has one, and otherwise derived by
RFC 5280 clause 4.2.1.2 method (1) — SHA-1 of the subject public key.
`src/core/model/x509-ski.ts` does both, because Node's `X509Certificate` exposes
neither.

Two Annex H rules meet where a service carries no certificate: there is no key to
identify, and a history instance stating no `X509SKI` is not allowed. Such a
service changes status **without** a history instance, and the administrator is
told so in the result message. Publishing an invented identity, or refusing the
withdrawal outright, would both be worse than saying what happened.

### Where Annex H entity URIs are published

The Pub-EAA country role URI is published only in
**`TEAddress.TEElectronicAddress`**. `TEInformationURI` contains only the
provider's policies and terms URL. The Annex H legal-basis reference is not an
entity-address URI; Annex H.3 places it only in `TETradeName`.

### Status starting times are restated on every version

clause 6.6.5, as the Inspector enforces it (`ts119602.service.status_start`),
requires a current service's `StatusStartingTime` not to precede the list's
`ListIssueDateTime`. An entity carried into a new version therefore cannot keep
the timestamp of the version that first listed it:
`restateServiceStatusTimes()` restamps every current Annex H service with the
issue time of the version being published. The status itself does not change, and
the instant a status actually began is what `ServiceHistory` records once that
status is superseded.

### Identifying the entity to withdraw

Annex H services carry no unique identifier, so the entity is matched by its
Trusted Entity Name — the published identity the certificate subject rule already
ties the certificates to. A name that matches no entity, or more than one, is
refused with a message saying which, rather than resolved by position.

## Service digital identity (clause 6.6.3)

Confirmed against `schemas/etsi/1960201_json_schema.json` (the vendored ETSI
schema listed above), the two profile constant modules and a published artefact.

`ServiceDigitalIdentity` is a set of optional identity arrays —
`X509Certificates`, `X509SubjectNames`, `PublicKeyValues`, `X509SKIs`,
`OtherIds` — each with `minItems: 1`. This publisher populates
`X509Certificates` in the current service entry, and `X509SKIs` — and only
`X509SKIs` — in an Annex H `ServiceHistory` instance.

- **Annex E (Wallet Provider)**, **Annex D (PID Provider), Table D.3**, and the
  Annex F/G profiles all require an X.509 service digital identity; Annex H
  makes it optional. Annex D/E and Annex H do not require the submitted
  certificate to be a CA certificate. Annex F/G apply the WRPAC/WRPRC
  CA-certificate checks above. The publisher does not build or verify a
  certification path; where a profile permits self-signing, a self-signed
  certificate remains acceptable.
- No clause fixes the certificate subject. Requiring the subject `O` to equal the
  Trusted Entity Name (`TEName`) is a **project-local authoring rule** that keeps
  the published identity attributable to the listed entity; it is not an ETSI
  requirement.

### Resolved: certificate values are Base64 DER

`pkiOb.val` is declared `"contentEncoding": "base64"`, i.e. the base64 encoding of
the DER certificate. This was previously the submitted PEM verbatim. The
conversion now happens once, at the authoring boundary
(`buildAuthoringEntity()`), so the authoring model and every published list carry
strict Base64 DER with no armour and no whitespace. `convertLoTEToAuthoringEntities()`
normalises legacy PEM values on read, which upgrades an older list on its next
version; `checkLosslessPreservation()` normalises the stored original the same
way so the upgrade is not mistaken for data loss.

## Locally decidable rules implemented

Established empirically against the Trust Inspector
(`https://trust-inspector.credimi.io`, `POST /api/audit/artifact`) and recorded
here because several are lexical or structural rules that the pinned JSON schema
does not enforce. Except where a row says otherwise, each rule applies to all
five implemented profiles.

| Rule | Where it is applied |
|------|--------------------|
| clause 6.1.3 UTC form `YYYY-MM-DDThh:mm:ssZ`, no fractional seconds | `src/core/model/lexical.ts`, applied in `compileForProfile()` |
| clause 6.3.6 `SchemeName` = `<territory>:<name>` | `compileForProfile()`, idempotent |
| Table 1 presence matrix: `SchemeInformationURI` mandatory; Annex D/E minimum two | `SigningConfigEntry.schemeInformationUris` |
| clauses 6.3.5.1/6.3.5.2 operator reachable by `mailto:` and HTTP(S) | `normalizeToAuthoringInput()` |
| clause 6.3.11 `PolicyOrLegalNotice` mandatory for explicit scheme information | `SigningConfigEntry.policyUri` |
| Annex D–G self pointer in `PointersToOtherLoTE`, carrying the signing certificate and `MimeType: application/jose`; Annex H omits it | `publishesSelfPointer` in `src/core/profiles/registry.ts`, applied in `compileForProfile()` |
| Annex H `HistoricalInformationPeriod` = 65535 | `historicalInformationPeriod` in the registry, applied in `compileForProfile()` |
| Annex H `ServiceStatus` and `StatusStartingTime` on every service; `ServiceHistory` by `X509SKI` only | `usesServiceStatus` in the registry, applied in `buildAuthoringEntity()`, `compileForProfile()` and `ApplicationService.withdrawApplication()` |
| Annex H.3 mandatory `TETradeName` containing the official registration identifier where one exists and the formatted `OJ:` legal-basis URI | `buildAuthoringEntity()`, `compileForProfile()` and `schemas/profiles/pub-eaa-schema.json` |
| Annex H certificates for one service share a public key and a subject | `checkCertificateSetConsistency()` in the submission parser |
| clause 6.5.3 entity reachable by `mailto:`, HTTP(S) and `tel:` | `buildAuthoringEntity()` from the `entityEmail`/`entityTelephone` form fields |
| Entity country-role URI `http://uri.etsi.org/19602/ListOfTrustedEntities/{PIDProvider,WalletProvider,WRPACProvider,WRPRCProvider,PubEAAProvider}/<CC>` | `buildAuthoringEntity()`; every profile except Annex E uses the responsible Member State |
| Annex F/G/H omit the ServiceUniqueIdentifier extension entirely | `requiresServiceUniqueIdentifier` in `src/core/profiles/registry.ts`, applied in `buildAuthoringEntity()` and `compileForProfile()` |
| clause 6.6.3 `X509Certificates[].val` strict Base64 DER | `buildAuthoringEntity()` |
| clause 6.6.9 extension containers state criticality (`Critical`) | `compileForProfile()` |
| Service certificate subject `O` = Trusted Entity Name, wherever a certificate is supplied | `checkCertificateSubjectOrganisation()` in the submission parser |
| JAdES Baseline B `iat` integer NumericDate in the protected header | `src/core/signing/signing.ts` |
| `NextUpdate` at most six months after the issue time | UTC month arithmetic in `createTrustedList()`; the application path uses 180 days |

Two rules constrain the **signing certificate** rather than the generated
document, so they are properties of the operator's signing material:

- subject organisation (`O`) must equal `SchemeOperatorName`
- subject country (`C`) must equal `SchemeTerritory` — `EU` for Annex D to H

Both are stated on the Create Trusted List form.

### What stays unchecked

For Annex F/G, `ts119602.service.extensions` reports `not_applicable` rather
than `pass`, because those profiles emit no extension container. A clean Annex
F/G list therefore has one fewer applicable check than a clean Annex D/E list.
The former Annex H `pubEaaLawReferencePresent` failure is no longer treated as a
known unrelated failure: Annex H.3 identifies `TETradeName` as its required
location, and the local profile schema now checks that placement.

`ts119602.scheme.pointers.authentication`,
`ts119602.scheme.distribution_consistency`,
`json_lote.signature.jades_signer_trust`, `ts119602.language.annex_b` and
`json_lote.dates.update_period_days` need dereferencing or an external trust
decision. They report `not_checked`, and this project does not establish PKIX
trust. A clean generated list therefore reaches zero `fail` findings while the
Inspector's overall conformance level stays below `conformant`; that is expected
and is never reported as conformance.

## WE BUILD Compatibility Findings

### Divergence from claimed profile

**WE BUILD implementation profile** (task3-x509-pki-etsi/etsi_trusted_lists_implementation_profile.md)
claims:
- JSON: Compact JAdES Baseline B
- XML: XAdES Baseline B

**WE BUILD published JSON** (list_of_trusted_lists.json, retrieved 2026-07-28):
- NOT Compact JAdES serialization.
- Top-level structure is: `{LoTE: {...}, signature: {protected: "...", signature: "..."}}`
- This is a detached JSON object containing base64url-encoded JWS parts,
  not the Compact JAdES serialization of `header.payload.signature`.
- The `x5c` certificate chain is placed inside the `protected` header (base64url-encoded),
  which is non-standard — `x5c` belongs in the unprotected JWS header per RFC 7515 §4.1.11.
- No `typ` header with value "JAdES".
- No `crit` header.

**WE BUILD published XML** (list_of_trusted_lists.xml, retrieved 2026-07-28):
- Contains XMLDSig `<ds:Signature>` with `<ds:KeyInfo><ds:X509Data><ds:X509Certificate>`
- No `xades:QualifyingProperties` element — required for XAdES Baseline B.
- Effectively plain XMLDSig, not XAdES Baseline B.

### Project treatment of WE BUILD artefacts

WE BUILD JSON/XML artefacts are used ONLY as compatibility fixtures in dedicated test
files (`test/fixtures/we-build/`). They are NOT used as normative signing oracles.

`HITL/WP4-LoTE_evaluation.json` — the Inspector's report on the WE BUILD WP4
LoTL — is used the same way, as a **negative fixture**. `test/annexh-pub-eaa.test.ts`
asserts that the Annex H rules it records as failing there (absent
`HistoricalInformationPeriod`, absent telephone, absent country role URI, absent
law reference) are exactly the rules a list produced by this publisher satisfies.
Its three `EUPubEAAProvidersList` entries are evidence of what Annex H requires,
never an example to copy.

### Other WE BUILD findings

- WE BUILD LoTL automation spec (lotl-automation-and-tl-integration.md) describes a
  LoTL aggregation workflow. This project's first slice does NOT implement LoTL
  aggregation. The spec's TL entry format (JSON with `tl_url`, `trust_anchor`) and
  LoTL output descriptions are informative for a future LoTL phase only.
- WE BUILD's `referencedListTypeUri` table confirms the ETSI profile URIs listed above.

## EC TS02

EC TS02 v1.0.1 defines the provider notification/publication API for the EC to
publish trusted lists. The documentation URL returned 404. This is a deferred
concern for a future notification/registration API slice.

## Trust Inspector integration, as this publisher uses it

Re-established against the live OpenAPI document on **2026-08-03**
(`GET https://trust-inspector.credimi.io/openapi.json`, "WE BUILD Trusted List
Audit API" 0.1.0), rather than carried over from older code.

| Question | Answer |
| --- | --- |
| XML Trusted List analysis endpoint | `POST /api/audit/artifact` |
| Request media type | `application/json` |
| How the XML is supplied | **Inline**, as the `content` string. Not multipart, and not by URL. |
| Body | `{ content, source, contentType, declared?, options? }`, `additionalProperties: false` |
| `contentType` for XML | `application/vnd.etsi.tsl+xml` |
| `contentType` for a Compact JAdES | `application/jose` |
| `declared` | Optional; when present, `pointerCertificateFingerprintsSha256` is required |
| Response | `{ result: TrustedListAuditResult }` |
| Artifact classification | `result.detected.artifactKind` ∈ `ts119612_xml_tsl`, `ts119612_xml_lotl`, `xml_lotl_like`, `xml_lote`, `json_lote`, `json_lotl`, `html_error`, `unknown` |
| Standard applicability | `result.standardApplicability.ts119612` ∈ `applicable`, `not_applicable`, `unknown` |
| Per-standard assessment | `result.ts119612` / `result.ts119602`: `applicable`, `conformanceLevel`, `score`, `checks[]`, `mandatoryFailures[]`, `warnings[]` |
| Rule identifiers | `checks[].id`, with positional integers embedded for per-item checks |
| Malformed XML | HTTP 200 with a `parse_failed` conformance level. HTTP 400 means the *request body* was invalid, not the artifact. |

### What this publisher submits, and when

Always the **signed** artifact, never a decoded one: half the requirements are
signature requirements and a decoded document carries no signature evidence.
For TS 119 602 that is the Compact JAdES serialization; for TS 119 612 it is the
signed XML, whose XAdES signature is inside the file.

There is exactly one **automatic** call: publishing a version, and only when
`TLP_INSPECTOR_URL` is configured. The complete response is stored as
`inspector.json` beside the version. There is no background re-evaluation, and a
server started with no Inspector URL contacts nobody at all.

**Explicit** live validation:

```sh
npm run build
npm run fixtures:verify                      # both TS 119 612 fixture suites
node scripts/verify-tsl612-acceptance.mjs    # the healthy TS 119 612 flow
```

### Unavailable, not applicable and empty responses

Three answers are all represented as `summary.status: "unavailable"`, with the
reason in `summary.error`:

1. the Inspector could not be reached, or did not return a result;
2. it reported the submitted standard as `not_applicable`, or its applicability
   as `unknown`;
3. it ran no check at all against the submitted standard.

**None of them may ever be presented as a pass.** A standard that was not applied
cannot have been passed, and an artifact that was never assessed has not been
found conformant. The summary type has only `pass`, `fail` and `unavailable`, so
there is nowhere for "assessed nothing, looked fine" to be recorded. The
`standardApplicability` block and the detected `artifactKind` are stored beside
the status so a reader can see why there is no verdict.

## Fixture evidence against the conformance source of truth

The TS 119 612 fixtures map onto the Credimi conformance objectives as follows.
The source of truth defines **evidence objectives**; it does not define a defect
catalogue. The concrete deterministic mutations belong to this publisher, and the
mapping below is a claim about which objective each fixture exercises, not a
claim that the objectives enumerate these defects.

| Test | Objective | Fixtures that exercise it |
| --- | --- | --- |
| 139 | Trusted List schema is valid | `*-healthy` (passes); `*-broken-missing_scheme_information_uri`, `*-broken-pem_service_certificate`, `*-broken-extension_without_criticality`, `*-broken-invalid_tsl_namespace` (fail `schema.xsd` and `local.xml.schema`) |
| 140 | Trusted List signature or seal validates | `*-healthy`; `*-broken-broken_xades_signature` (fails `signature.cryptographic_verification_result`), `*-broken-xades_without_signing_time` (valid signature, not Baseline B) |
| 141 | Trusted List freshness is acceptable | `*-healthy`; `*-broken-expired_next_update` (fails `dates.next_after_issue` and `local.freshness`), `*-broken-non_strict_timestamps` (fails the lexical-form rules) |
| 142 | Actor can be resolved | `*-healthy` (one seeded provider and service); `*-broken-incorrect_service_type` (the service is published under a type that is not the family's) |
| 143 | Actor status is resolved correctly | `*-broken-incorrect_service_status` (the other family's vocabulary), `*-broken-invalid_service_history` (a superseded state that postdates the state replacing it) |
| 144 | Trust anchor can be resolved | `*-broken-missing_self_pointer` (no pointer to the EU LOTL), `*-broken-pem_service_certificate` (a digital identity that does not decode) |
| 145 | Certificate chain validates to the configured trust anchor | `*-broken-signer_organisation_mismatch` (signer subject is not the scheme operator), `*-broken-incorrect_signing_certificate` (a CA certificate signing a Trusted List) |

`*-broken-incorrect_sha2_digest` maps to none of the seven: the Inspector
assesses the artifact it is given and never sees the sidecar digest. It declares
an empty Inspector expectation and is verified locally, through
`local.sha2.digest`.

### Calibration, and what the Inspector does not report

The expected rule IDs in the catalogue were calibrated against a live run on
**2026-08-03**, not guessed. Three expectations survive that the Inspector does
not currently report; they are kept, and recorded per version as missing
failures, because they are the correct expectation and a silent expectation is
worse than a visible gap:

- `ts119612.service.history.status_transition` for `invalid_service_history`.
  The Inspector reports `status_start` for that mutation and not the transition
  rule.
- `ts119612.service.status` for `incorrect_service_type`, which fires for EAA
  but not for QEAA: `granted` is a valid status for the substituted CA/QC type,
  so the QEAA fixture trips the certificate-role rule alone.
- Nothing at all for `invalid_tsl_namespace`, which the Inspector classifies as
  `xml_lotl_like` and does not assess against TS 119 612. Recorded as
  `unavailable`.
