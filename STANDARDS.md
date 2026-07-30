# Standards

## Project scope

This project implements a **TS 119 602 JSON List of Trusted Entities (LoTE) publisher**
for the Wallet Provider profile (Annex E) and PID Provider profile (Annex D).

### Normative definitions

1. **TS 119 602 List of Trusted Entities (LoTE)** — this project's current scope.
2. **TS 119 612 national Trusted List (TSL)** — out of scope for this slice.
3. **List of Trusted Lists (LoTL)** — out of scope for this slice.
4. **EC TS02 provider notification/publication API** — out of scope for this slice.

## Primary standards

### ETSI TS 119 602 V1.1.1 (2025-11)

- Title: Electronic Signatures and Infrastructures (ESI); Lists of trusted entities; Data model
- URL: https://www.etsi.org/deliver/etsi_ts/119600_119699/119602/01.01.01_60/ts_119602v010101p.pdf
- Date retrieved: 2026-07-28
- Defines the abstract data model for LoTE with JSON and XML bindings
- Profile-based approach for different entity types (PID, Wallet, WRPAC, WRPRC, Pub-EAA, Registrars)
- References ETSI TS 119 182-1 (JAdES) for JSON signatures

### ETSI TS 119 182-1 (JAdES)

- Defines Compact JAdES Baseline B profile for JSON Advanced Electronic Signatures
- Wallet Provider and PID Provider profiles require Compact JAdES Baseline B
- JAdES Compact Serialization: BASE64URL(UTF8(JWS Protected Header)).BASE64URL(JWS Payload).BASE64URL(JWS Signature)
- Required header parameters: `alg`, `x5c` (certificate chain), `typ` (optional, value "JAdES")

### ETSI TS 119 612 V2.4.1 (2025-11)

- Out of scope for this slice. Defines XML-based Trusted Service Lists and XAdES signatures.

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

## Service digital identity (clause 6.6.3)

Confirmed against `schemas/etsi/1960201_json_schema.json` (the vendored ETSI
schema listed above), the two profile constant modules and a published artefact.

`ServiceDigitalIdentity` is a set of optional identity arrays —
`X509Certificates`, `X509SubjectNames`, `PublicKeyValues`, `X509SKIs`,
`OtherIds` — each with `minItems: 1`. This publisher populates
`X509Certificates` only, from the single `certificatePem` field per service.

- **Annex E (Wallet Provider)** and **Annex D (PID Provider), Table D.3** require
  an X.509 service digital identity. Neither requires the certificate to be
  issued by a CA, and neither requires a verifiable certification path. The
  publisher never builds or verifies one, so a **self-signed** certificate is
  conformant input and is supported as the simplest testing option; a CA-issued
  certificate is equally acceptable.
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

## Locally decidable Annex D/E rules implemented

Established empirically against the Trust Inspector
(`https://trust-inspector.credimi.io`, `POST /api/audit/artifact`) and recorded
here because several are lexical or structural rules that the pinned JSON schema
does not enforce.

| Rule | Where it is applied |
|------|--------------------|
| clause 6.1.3 UTC form `YYYY-MM-DDThh:mm:ssZ`, no fractional seconds | `src/core/model/lexical.ts`, applied in `compileForProfile()` |
| clause 6.3.6 `SchemeName` = `<territory>:<name>` | `compileForProfile()`, idempotent |
| Table 1 presence matrix: `SchemeInformationURI` mandatory; Annex D/E minimum two | `SigningConfigEntry.schemeInformationUris` |
| clauses 6.3.5.1/6.3.5.2 operator reachable by `mailto:` and HTTP(S) | `normalizeToAuthoringInput()` |
| clause 6.3.11 `PolicyOrLegalNotice` mandatory for explicit scheme information | `SigningConfigEntry.policyUri` |
| Annex D/E self pointer in `PointersToOtherLoTE`, carrying the signing certificate and `MimeType: application/jose` | `compileForProfile()` |
| clause 6.5.3 entity reachable by `mailto:`, HTTP(S) and `tel:` | `buildAuthoringEntity()` from the `entityEmail`/`entityTelephone` form fields |
| Annex D/E entity country-role URI `http://uri.etsi.org/19602/ListOfTrustedEntities/{WalletProvider,PIDProvider}/<CC>` | `buildAuthoringEntity()`; PID uses the responsible Member State |
| clause 6.6.3 `X509Certificates[].val` strict Base64 DER | `buildAuthoringEntity()` |
| clause 6.6.9 extension containers state criticality (`Critical`) | `compileForProfile()` |
| Annex D/E service certificate subject `O` = Trusted Entity Name | `checkCertificateSubjectOrganisation()` in the submission parser |
| JAdES Baseline B `iat` integer NumericDate in the protected header | `src/core/signing/signing.ts` |
| `NextUpdate` at most six months after the issue time | UTC month arithmetic in `createTrustedList()`; the application path uses 180 days |

Two rules constrain the **signing certificate** rather than the generated
document, so they are properties of the operator's signing material:

- subject organisation (`O`) must equal `SchemeOperatorName`
- subject country (`C`) must equal `SchemeTerritory` — `EU` for Annex D and
  Annex E

Both are stated on the Create Trusted List form.

### What stays unchecked

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
