# Standards

## Project scope

This project implements a **TS 119 602 JSON List of Trusted Entities (LoTE) publisher**
for four profiles: PID Providers (Annex D), Wallet Providers (Annex E), WRPAC
Providers (Annex F) and WRPRC Providers (Annex G).

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
- Profile-based approach for six entity families: PID Providers (Annex D),
  Wallet Providers (Annex E), WRPAC Providers (Annex F), WRPRC Providers
  (Annex G), Pub-EAA Providers and Registrars and Registers. The last two are
  catalogued and disabled.
- References ETSI TS 119 182-1 (JAdES) for JSON signatures

### ETSI TS 119 182-1 (JAdES)

- Defines Compact JAdES Baseline B profile for JSON Advanced Electronic Signatures
- All four implemented profiles require Compact JAdES Baseline B
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

## Service digital identity (clause 6.6.3)

Confirmed against `schemas/etsi/1960201_json_schema.json` (the vendored ETSI
schema listed above), the two profile constant modules and a published artefact.

`ServiceDigitalIdentity` is a set of optional identity arrays —
`X509Certificates`, `X509SubjectNames`, `PublicKeyValues`, `X509SKIs`,
`OtherIds` — each with `minItems: 1`. This publisher populates
`X509Certificates` only, from the single `certificatePem` field per service.

- **Annex E (Wallet Provider)**, **Annex D (PID Provider), Table D.3**, and the
  Annex F/G profiles all require an X.509 service digital identity. Neither requires the certificate to be
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
does not enforce. Except where a row says otherwise, each rule applies to all
four implemented profiles.

| Rule | Where it is applied |
|------|--------------------|
| clause 6.1.3 UTC form `YYYY-MM-DDThh:mm:ssZ`, no fractional seconds | `src/core/model/lexical.ts`, applied in `compileForProfile()` |
| clause 6.3.6 `SchemeName` = `<territory>:<name>` | `compileForProfile()`, idempotent |
| Table 1 presence matrix: `SchemeInformationURI` mandatory; Annex D/E minimum two | `SigningConfigEntry.schemeInformationUris` |
| clauses 6.3.5.1/6.3.5.2 operator reachable by `mailto:` and HTTP(S) | `normalizeToAuthoringInput()` |
| clause 6.3.11 `PolicyOrLegalNotice` mandatory for explicit scheme information | `SigningConfigEntry.policyUri` |
| Annex D/E self pointer in `PointersToOtherLoTE`, carrying the signing certificate and `MimeType: application/jose` | `compileForProfile()` |
| clause 6.5.3 entity reachable by `mailto:`, HTTP(S) and `tel:` | `buildAuthoringEntity()` from the `entityEmail`/`entityTelephone` form fields |
| Entity country-role URI `http://uri.etsi.org/19602/ListOfTrustedEntities/{PIDProvider,WalletProvider,WRPACProvider,WRPRCProvider}/<CC>` | `buildAuthoringEntity()`; every profile except Annex E uses the responsible Member State |
| Annex F/G omit the ServiceUniqueIdentifier extension entirely | `requiresServiceUniqueIdentifier` in `src/core/profiles/registry.ts`, applied in `buildAuthoringEntity()` and `compileForProfile()` |
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

For Annex F/G, `ts119602.service.extensions` reports `not_applicable` rather
than `pass`, because those profiles emit no extension container. A clean Annex
F/G list therefore reaches 69 passed / 0 failed where a clean Annex D/E list
reaches 70 passed / 0 failed.

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
