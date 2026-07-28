# Standards

## Project scope

This project implements a **TS 119 602 JSON List of Trusted Entities (LoTE) publisher**
for the Wallet Provider profile (Annex E).

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
- Wallet Provider profile requires Compact JAdES Baseline B
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
