# Project Specifications

## Template status

This project has selected its backend. See below.

## Selected backend and rationale

Node.js 24 LTS with TypeScript.

The publisher is a standalone core library, CLI and later web application.
Direct import into Credimi's Go backend is not currently required.

## Approved first vertical slice

Historical first vertical slice: implement a TS 119 602 JSON LoTE publisher for
the Wallet Provider profile. The current implementation supports five profiles:
PID Providers (Annex D), Wallet Providers (Annex E), WRPAC Providers (Annex F),
WRPRC Providers (Annex G) and Pub-EAA Providers (Annex H).

The core must compile, schema-validate, sign and verify deterministic LoTE
artifacts. Signing keys are supplied through local files or CI secrets and
must never be committed or uploaded through a public web interface.

## Explicit non-goals for the first vertical slice

- TS 119 612 Trusted Lists
- LoTL aggregation
- XML or XAdES
- EC TS02 notification/registration API
- hosted key custody
- database and authentication
- deployment

## Language and runtime versions

- Node.js: 24 LTS
- TypeScript: ^5.8
- Package manager: npm (bundled with Node.js)

## Module or package identity

- Name: `@forkbombeu/eudi-trusted-list-publisher`
- Module type: ESM (`"type": "module"` in package.json)
- Main: `dist/src/core/index.js`
- Bin: `dist/src/cli/main.js` as `trusted-list-publisher`

## Frameworks and dependencies

### Runtime dependencies

- **ajv** (^8.x): JSON Schema validation (vendor schemas, no network fetch)
- **jose** (^5.x): JOSE/JWS signing and verification
- **commander** (^12.x): CLI argument parsing
- **ajv-formats** (^3.x): JSON Schema format validation (date-time, uri)
- **yaml** (^2.x): OpenAPI YAML → JSON parsing
- **libxml2-wasm** (^0.7.x): XML parsing, offline XML Schema validation and
  Exclusive XML Canonicalisation for TS 119 612 Trusted Lists. WebAssembly, so
  there is no native build step and no Java. Node.js ships none of these three,
  and canonicalisation in particular cannot be approximated: a signature over
  wrongly canonicalised bytes verifies locally and nowhere else. The XAdES
  structure itself is written in this repository, not taken from a library.

### Dev dependencies

- **typescript** (^5.8): TypeScript compiler
- **vitest** (^3.x): Test runner
- **@types/node** (^24.x): Node.js type definitions
- **tsx** (^4.x): TypeScript execution for development
- **prettier** (^3.x): Code formatting

## Application architecture

Three-layer architecture:

```
CLI -> exported publisher core
```

### Core library

- All compilation, validation, signing and verification logic
- Typed TypeScript APIs
- No CLI, HTTP, HTML or environment-variable concepts
- Keys and certificates accepted through explicit injected inputs
- No implicit network access
- No mutable global state
- Deterministic output when timestamps and sequence numbers are supplied
- Structured errors and findings
- Safe for concurrent use

### Directory structure

```
src/
  core/
    model/            — TypeScript types for LoTE data model
    profiles/
      wallet-provider/ — Wallet Provider Annex E profile constants
      pid-provider/    — PID Provider Annex D profile constants
      wrpac-provider/  — WRPAC Provider Annex F profile constants
      wrprc-provider/  — WRPRC Provider Annex G profile constants
      pub-eaa-provider/ — Pub-EAA Provider Annex H profile constants
    compile/          — Compile authoring input -> LoTE
    validate/         — Schema validation (authoring + ETSI)
    signing/          — JAdES Compact signing
    verification/     — JAdES Compact verification
    publication/      — Manifest generation and immutable filesystem store
  cli/                — CLI commands and entry point
  web/                — Read-only web server and HTML rendering
    assets/           — Runtime copies of HITL design assets + app.css + OpenAPI
schemas/
  etsi/               — Vendored ETSI JSON schemas
  authoring/          — Authoring input JSON schema
examples/
  wallet-provider/    — Example Wallet Provider input files
test/
  fixtures/           — Test keys, certs
```

## CLI, web, and API interfaces

### CLI commands

```
trusted-list-publisher compile  — produce unsigned deterministic LoTE
trusted-list-publisher validate — validate authoring input and ETSI structure
trusted-list-publisher sign     — sign a compiled LoTE
trusted-list-publisher verify   — verify a signed LoTE
trusted-list-publisher publish  — verify + store signed LoTE immutably
trusted-list-publisher serve    — start read-only publication web server
```

### CLI design

- stdout for program output, stderr for diagnostics
- `--json` flag for structured JSON diagnostics on stderr
- Documented exit codes
- Atomic output-file replacement
- Refusal to overwrite input files
- Private-key material never printed or logged
- No network access
- No interactive prompts (automation-friendly)

## Configuration

Signing key supplied by:
- `--key-file <path>` CLI argument
- `--cert-file <path>` CLI argument
- Environment variable: `TLP_SIGNING_KEY` and `TLP_SIGNING_CERT` (CI secret pattern)

## Build, format, lint, and test commands

```
npm run build     — TypeScript compilation
npm run format    — Prettier formatting
npm run lint      — TypeScript type-checking + lint:design
npm run lint:design — validate DESIGN.md
npm run test      — vitest test suite
```

## Production and Docker execution

Not implemented in this slice.

## Important directories

- `src/core/` — publisher core library (importable)
- `src/cli/` — CLI entry point (not importable)
- `schemas/` — vendored schema files
- `examples/` — example input files
- `test/` — all tests

## Generated files

- `dist/` — compiled TypeScript output
- `node_modules/` — npm dependencies

## Repository-specific constraints

- No network access during schema validation (vendored schemas)
- No private keys committed
- No pushing without explicit approval
- Conventional Commits with `reason` and `prompt`

## Publication store

### Architecture

Immutable filesystem store under a configurable publication root (`--publication-dir`):

```
publications/
  <safe-list-key>/
    index.json
    versions/
      <sequence-number>/
        lote.json
        lote.jades
        manifest.json
```

### Trust boundary

- `publish` requires an expected certificate (`--cert-file`)
- Cryptographic signature validity (`signatureValid`) is distinct from trust (`signerTrustStatus`)
- `signerTrustStatus` is always `"not_evaluated"`
- No `trusted: true` result is ever exposed
- Signer described by certificate subject, issuer, validity, and SHA-256 fingerprint

### Manifest

Each version includes a machine-readable `manifest.json` with:
- manifest version, list key, LoTE identifier, sequence number
- Issue/next-update dates, LoTE type, scheme operator, territory
- Publication timestamp, SHA-256 of .jades and .json artifacts
- Signing certificate SHA-256, subject, issuer, validity
- `signatureValid`, `etsiSchemaValid`, `signerTrustStatus`

## Web server

### Architecture

Read-only `node:http` server. No framework. Separated from the core library.

```
CLI -> exported publisher core
          ^
          |
       web server (read-only HTTP adapter)
```

### Security

- No signing, no private keys, no certificate uploads
- No POST/PUT/PATCH/DELETE
- No modification of the publication directory
- No network fetches
- HTML escaping, route validation, path traversal protection
- Security headers: X-Content-Type-Options, X-Frame-Options, Referrer-Policy
- Request IDs, structured logging, graceful shutdown
- No stack traces in responses

### Routes

```
GET /                                 — Catalogue
GET /lists/:listKey                   — List detail
GET /lists/:listKey/versions/:seq     — Version detail
GET /healthz                          — Health check
GET /docs                             — Stoplight Elements
GET /openapi.yaml                     — OpenAPI 3.1 source
GET /openapi.json                     — OpenAPI 3.1 derived
GET /favicon.svg                      — Credimi favicon
GET /api/v1/lists                     — List catalogue (JSON)
GET /api/v1/lists/:listKey            — List index (JSON)
GET /api/v1/lists/:listKey/versions/:seq     — Version manifest (JSON)
GET /api/v1/lists/:listKey/versions/:seq/lote       — LoTE JSON download
GET /api/v1/lists/:listKey/versions/:seq/signature   — JAdES download
GET /api/v1/lists/:listKey/versions/:seq/manifest    — Manifest download
```

### OpenAPI

One authoritative YAML document at `src/web/assets/openapi.yaml`. JSON derived.
Stoplight Elements pinned at v7.15.0 and vendored into `src/web/assets/`, so
`/docs/reference` never depends on a CDN and renders whenever the publisher
itself is reachable.

### Runtime asset locations

```
src/web/assets/style.css              — byte-for-byte copy of HITL/style.css
src/web/assets/credimi_logo.svg       — byte-for-byte copy of HITL/credimi_logo.svg
src/web/assets/credimi_logo_negative.svg — byte-for-byte copy of HITL/credimi_logo_negative.svg
src/web/assets/app.css                — application-specific layout
src/web/assets/openapi.yaml           — OpenAPI 3.1 specification
src/web/assets/stoplight-elements.min.js  — Stoplight Elements 7.15.0 bundle
src/web/assets/stoplight-elements.min.css — Stoplight Elements 7.15.0 styles
```

## Phase 3: Data collection and administration GUI

### Feature flag

The `DATA_COLLECTION_GUI` environment variable (defaults to `false`) controls
whether the authoring and administration UI is enabled. The flag is parsed once
through the `serve` CLI command as `--data-collection-gui`.

When `false` or unset: the server operates in read-only mode exactly as in
Phase 2. No authoring directories or mutable state are created.

When `true`: onboarding, administration, and POST routes are enabled. All
existing public catalogue and download functionality is retained.

### List-family catalogue

One authoritative catalogue at `src/core/authoring/list-family-catalogue.ts`
derives from `src/core/profiles/registry.ts` and defines the six TS 119 602
families, in annex order:

- PID Providers — enabled (Annex D)
- Wallet Providers — enabled (Annex E)
- WRPAC Providers — enabled (Annex F)
- WRPRC Providers — enabled (Annex G)
- Pub-EAA Providers — enabled (Annex H)
- Registrars and Registers — disabled

The one disabled family is displayed with "Not implemented yet". The
Non-qualified EAA and QEAA entries were removed: TS 119 602 does not profile
them as separate lists of trusted entities.

### Application model

Defined in `src/core/authoring/application-model.ts`:

```
ApplicationState = "submitted" | "approved" | "rejected" | "published"
                 | "withdrawn"   // Annex H only
TrustedEntityApplication { id, schemaVersion, family, state, submittedAt,
  applicantData { entityName, entityTradeName?, entityStreetAddress,
    entityLocality?, entityPostalCode?, entityCountry, entityInformationURI,
    entityEmail, entityTelephone,
    services[{ serviceType, serviceName, certificatePem, serviceUniqueIdentifier }] },
  adminNote?, approvedAt?, rejectedAt?, publication? }

PIDProviderApplication additionally requires `responsibleMemberState`.
```

Lifecycle transitions:
- submitted → approved, rejected
- approved → published, rejected
- rejected → (terminal)
- published → withdrawn (Annex H only)
- withdrawn → (terminal)

Normalization: `normalizeToAuthoringInput()` maps an application to the existing
`AuthoringInput` type. Scheme operator and scheme metadata come from trusted
server configuration (not applicant input).

Document placeholders use `{FILENAME}.md` format.

### Authoring store

Mutable filesystem-backed store at `src/core/authoring/authoring-store.ts`.
One JSON file per application in a configurable directory (`AUTHORING_DIR`,
default `./authoring`). Stable opaque UUID application IDs. Atomic record
replacement via tmp+rename. No database or external service.

Separate from the immutable publication store (`publications/`).

### Signing configuration

Defined in `src/core/authoring/signing-config.ts`. A JSON or YAML file maps
list keys to signing key/cert paths. Certificate metadata (subject,
fingerprint) is extractable for display. Private key contents are never
displayed or returned through the API.

### GUI routes (when DATA_COLLECTION_GUI=true)

Onboarding (public):
- `GET /onboarding` — list-family catalogue
- `GET /onboarding/wallet-provider` — Wallet Provider application form
- `POST /onboarding/wallet-provider` — submit application
- `GET /onboarding/pid-provider` — PID Provider application form
- `POST /onboarding/pid-provider` — submit application
- `GET /onboarding/wrpac-provider` — WRPAC Provider application form
- `POST /onboarding/wrpac-provider` — submit application
- `GET /onboarding/wrprc-provider` — WRPRC Provider application form
- `POST /onboarding/wrprc-provider` — submit application
- `GET /onboarding/pub-eaa-provider` — Pub-EAA Provider application form
- `POST /onboarding/pub-eaa-provider` — submit application
- `GET /onboarding/submitted/{id}` — submission confirmation

Administration (requires admin token via `?token=` query parameter):
- `GET /admin` — dashboard
- `GET /admin/applications` — application list with state filtering
- `GET /admin/applications/{id}` — application detail
- `POST /admin/applications/{id}/approve` — approve application
- `POST /admin/applications/{id}/reject` — reject with note
- `POST /admin/applications/{id}/publish` — compile, sign, verify, store
- `POST /admin/applications/{id}/withdraw` — Pub-EAA only: publish a new version
  with every service withdrawn
- `POST /admin/applications/{id}/delete` — delete (unpublished only)
- `GET /admin/signing` — signing configuration status
- `GET /admin/settings` — auto-approval settings
- `POST /admin/settings` — save auto-approval settings

HTML form routes are not added to OpenAPI.

### Filesystem layout

```
publications/                  — immutable publication store (Phase 2)
  <list-key>/
    index.json
    versions/<seq>/{lote.json, lote.jades, manifest.json}
authoring/                     — mutable application records (Phase 3)
  <uuid>.json
signing-config.json            — signing key/cert mappings (not committed)
```

### Application-to-publisher mapping

The publishing integration calls the existing Phase 1/2 core functions directly:
1. `normalizeToAuthoringInput()` — map application → AuthoringInput
2. `compile()` — produce `LoTEDocument`
3. `validateEtsiStruct()` — validate against ETSI schema
4. Sign with configured key/cert via `sign()`
5. `verify()` — post-sign verification
6. `publish()` — produce `PublicationResult` with manifest
7. `PublicationStore.store()` — immutable store

No CLI subprocess spawning. No duplicate compiler/signer/storage logic.

## Historical Phase 4: cumulative Wallet Provider publication

Phase 4 extends the administration service without adding another list family.
The Phase 4 implementation was Wallet-only. The current Phase 5 cumulative
publication path is profile-aware for Wallet and PID Providers.

### Per-list cumulative assembly

`ApplicationService.preparePublishInput()` loads the highest physically stored
sequence for the target list key, authenticates it, converts all existing
entities and appends the approved candidate. Sequence numbers and membership
are independent per list key.

The highest stored sequence is fail-closed authority. A corrupt highest
directory blocks preview and publication; the service never falls back to an
older authenticated sequence.

### Lossless conversion boundary

Existing authenticated entities pass through one authoritative semantic
round-trip check:

1. convert the complete ETSI `TrustedEntity` to `AuthoringEntity`;
2. compile it back to ETSI;
3. deep-compare the complete original and recompiled entities;
4. reject the first differing field path before signing or storage.

Fields supported by the authoring/compiler model are preserved. Valid ETSI
structures outside that model are rejected explicitly rather than silently
deleted.

### Concurrency and identifier scope

`ApplicationService` uses a process-local keyed promise queue. Operations for
one list key are serialized, including queue continuation after a failed store
operation. Different keys may progress concurrently. This is not a distributed
lock and does not protect multiple Node.js processes or hosts sharing the same
publication directory.

Service unique identifiers are unique within a list key across every service
of every entity. Duplicate display names are permitted. An identifier may be
reused in another list key.

### Commit boundary and reconciliation

The immutable `PublicationStore.store()` commit precedes the mutable
`AuthoringStore.save()` transition to `published`. If the immutable commit
succeeds and the mutable save fails, the public return type is:

```ts
type PublishApplicationResult =
  | ServiceResult<WalletProviderApplication>
  | PartialCommitResult;
```

`PartialCommitResult` has code
`PUBLICATION_COMMITTED_APPLICATION_STALE` and machine-readable list key,
sequence number, manifest hash, Compact JAdES hash and publication timestamp.
Reconciliation matches the application's complete service-identifier set to
one published entity and updates only mutable application metadata; it does not
create a new immutable version.

### Rendered preview

The authenticated admin detail route uses the same cumulative preparation
operation to render existing/resulting entity counts and current/proposed
sequence numbers.

## Phase 5: profile registry and PID Providers

`src/core/profiles/registry.ts` is the authoritative immutable mapping of list
families, profile URIs, service types, and update intervals. Wallet and PID
Providers are enabled; five families remain disabled. Every signing-config list
requires `family`, which is never inferred or silently changed. PID uses
`/onboarding/pid-provider` and the shared administration, cumulative
publication, and partial-commit reconciliation paths. Schema and signature
checks remain internal safety boundaries rather than external trust assessment.

## Phase 6: presentation, colour coding and auto-approval

### Product identity

The web shell is named **Credimi EUDI Trusted Lists**. The topbar nav is split
into three groups separated by `<li class="nav-sep">` hairlines — Catalogue and
Onboarding, API Docs and Open API, Repository. Administration is reached from
the footer `Settings` column rather than from the topbar. Logo boxes follow the
Credimi Capture Wallet shell: 42×42 px with 4 px padding in the topbar, 56×56 px
with 6 px padding in the footer, both `object-fit: contain`.

### Colour coding

`src/web/views/colors.ts` is the single source of the chips that name a Trusted
List Family or a Trusted List. Each of the seven families has a fixed class;
list keys are hashed to one of `LIST_SWATCH_COUNT` swatches, so a given key is
always the same colour. The colours themselves live in `app.css`; a test asserts
that every class the module can emit is declared there. Catalogue, list and
version pages, onboarding, administration and settings all render through these
chips — no page prints a bare family name or list key.

### Onboarding services

Service blocks are numbered by position, not by field index. Field names keep
the index they were created with so a rejected submission re-renders as posted,
while `renumber()` recomputes the headings and hides the remove button on
whichever block is currently first. The certificate field is labelled
`Service Digital Identity Certificate (X.509 PEM)` and links the Certificate
creation guide; the publisher stores the certificate as the service's digital
identity and never builds or verifies a certification path. WRPAC and WRPRC have
an additional submission-time rule: their identity must be a current RFC 5280
CA certificate suitable for verifying the certificates they issue.

### Certificate input

`src/core/authoring/certificate-input.ts` classifies the pasted field value
before anything else looks at it:

```ts
classifyCertificateInput(text): {
  kind: "certificate" | "private-key" | "public-key" | "certificate-request"
      | "pkcs12" | "unparseable-certificate" | "empty" | "unknown",
  message: string | null,      // null only for "certificate"
  certificate: X509Certificate | null
}
```

Recognition is by PEM label, so the message names the object the applicant
actually supplied. A private key anywhere in the input wins over a certificate in
the same input: a combined key-and-certificate file is refused rather than
silently accepted. Input with no PEM armor is base64-decoded and checked for the
PKCS#12 PFX shape (`INTEGER 3` plus the pkcs7-data OID `1.2.840.113549.1.7.1`);
anything else is reported as not being PEM. `CERTIFICATE_INPUT_MESSAGES` is the
single source of those strings — the guide page renders its rejection table from
it, so the page cannot drift from the form.

`checkCertificateSubjectOrganisation()` then requires the subject `O` to equal
the submitted entity name exactly, and names both values when it does not.
`checkRelyingPartyCaCertificate()` additionally requires critical
`basicConstraints` with `CA:TRUE`, critical `keyUsage` containing `keyCertSign`,
non-critical SKI, non-critical AKI with `keyIdentifier` for a non-self-signed
certificate, and a current validity interval. Self-signing is established by
matching subject and issuer plus verification with the certificate's own public
key. The parser applies the check only to Annex F/G and reports every failure on
`service[i].certificatePem`; it does not build a path or check revocation.

### Trust Inspector integration

`src/core/inspector/inspector.ts` submits the **Compact JAdES artifact** — never
the decoded LoTE — to `POST /api/audit/artifact` on
`https://trust-inspector.credimi.io` and derives a summary from the response:

```ts
InspectorSummary {
  status: "pass" | "fail" | "unavailable",
  error?, evaluatedAt, inspectorBaseUrl,
  profile?, profileStatus?, detectedFormat?, detectedArtifactKind?,
  conformanceLevel?, score?, counts?, locallyDecidableFailures?, mandatoryFailures?
}
```

`status` is `pass` only when no locally decidable check failed. `unavailable`
means the Inspector could not be reached; `assess()` never throws and never
reports conformance in that case, and the version page renders the level as
"not evaluated".

The complete response is stored unmodified alongside the summary as
`inspector.json` in the version directory. That file sits **outside** the
integrity-checked artifact set: it is evidence produced after publication and can
be re-run, while `lote.json`, `lote.jades` and `manifest.json` stay immutable and
hash-verified. `ApplicationService.evaluateWithInspector()` runs on every
publication, so version 2 gets its own evaluation rather than inheriting
version 1's.

`GET /api/v1/lists/{listKey}/versions/{sequence}/inspector` serves the stored
evaluation (`?view=1` renders instead of downloading); a 404 means unavailable,
which the response body states is not a conformance claim.

### Trusted List creation

`src/core/authoring/list-creation.ts` declares a Trusted List and publishes its
first version in one operation: validate, derive the list key, compile an **empty**
LoTE for the family, validate against the pinned schema, sign as Compact JAdES,
publish, assess with the Inspector, and only then append the entry to the signing
configuration — so a failed creation never leaves a list that cannot publish.
`createWebServer()` reloads the signing configuration afterwards, so the new list
appears on the onboarding forms without a restart.

The list key is `<territory>_<operator name>` lowercased, the same derivation the
manifest uses, so `deriveListKeyFromParts()` computes it up front and the creation
refuses a collision. The six scheme URIs are derived from one base URL:
`/scheme`, `/practice-statement`, `/policy`, `/latest`, plus the website itself.

When `TLP_CERTIFICATES_DIR` is configured, the administration form can generate
its signing material before creation. `generateSigningMaterial()` invokes
OpenSSL without a shell, creates an EC P-256 key and a one-year self-signed
certificate, validates that the keys match and that subject `O` equals the
entered Scheme Operator Name while subject `C` equals the entered
SchemeTerritory, then atomically installs the pair below a directory named with
the derived list key. The private key has mode `0600`; an existing directory is
never overwritten. Only the resulting paths are returned to the form.
Relative `TLP_CERTIFICATES_DIR` values are retained in those paths and are
resolved against the process working directory only for filesystem operations.

Both entry points require the administrator credential:

- `POST /admin/lists/create` — the administration form, cookie session
- `POST /api/v1/admin/lists` — JSON, `Authorization: Bearer <TLP_ADMIN_TOKEN>` or
  `?token=`

`LIST_DEFECTS` names the ten deliberate defects the form will offer, each
combinable with the others. Generation of broken lists is not implemented: the
checkboxes render disabled and the API rejects a non-empty `defects` array with a
message naming the unimplemented option.

### Certificate creation guide

`src/web/views/certificate-guide.ts` renders a static page at
`/docs/certificate-creation` (`CERTIFICATE_GUIDE_PATH`), served whether or not
the data-collection GUI is enabled and linked from the footer Resources column
and from the certificate field on both onboarding forms. It explains what
`ServiceDigitalIdentity` is for, distinguishes PEM/PKCS#8/PKCS#10/PKCS#12/DER,
and carries the OpenSSL workflows: self-signed creation, key/certificate match
verification, CSR creation, DER-to-PEM and PKCS#12 extraction. A separate
WRPAC/WRPRC section documents their RFC 5280 CA extensions and the conditional
AKI rule.

### Auto-approval settings

`src/core/authoring/settings-store.ts` persists `settings.json` in the authoring
directory (mutable state, never in the publication store):

```ts
{ schemaVersion: 1,
  autoApproveFamilies: Partial<Record<ProfileFamily, boolean>>,
  autoApproveLists: Record<string, boolean> }
```

Unknown families, unsafe list keys and non-boolean values are dropped on read so
a drifted file cannot break the administration pages. Writes are atomic
(`wx` temp file + rename), and the posted form is the complete new state: a box
that is absent from the body turns its flag off.

`ApplicationService.autoApproveIfEnabled()` applies the settings on submission.
A family opt-in and a list opt-in are equivalent — either one approves the
application and publishes it through the ordinary locked, cumulative
publication path, bypassing the manual Approve and Publish actions. A failed
automatic publication is reported on the confirmation page and leaves the
application in the manual queue; it never falls back to a plausible-looking
success.

## Phase 8: WRPAC and WRPRC Providers

`src/core/profiles/registry.ts` holds all six families and grew two members that
the rest of the code reads instead of switching on family names:

- `requiresServiceUniqueIdentifier` — true for Annex D/E, false for Annex F/G.
  `AuthoringService.serviceUniqueIdentifier` is optional, and
  `compileForProfile()` emits no `ServiceInformationExtensions` container when it
  is absent.
- `roleCountrySource` — `entity` for Annex E, `responsible-member-state` for
  Annex D, F and G.

`parseAndValidateSubmission()` and `createApplicationRecord()` are generic in the
family: the family decides which fields are allowed, and anything else in the
posted body is reported as an unknown field. The authoring store validates a
stored record against the family it claims, so a record with an identifier the
profile does not use, or without a Responsible Member State the profile
requires, is rejected rather than half-read.

For WRPAC and WRPRC submissions, `parseAndValidateSubmission()` also validates
that every service certificate is a currently valid RFC 5280 CA certificate:
critical `basicConstraints` with `CA:TRUE`, critical `keyUsage` containing
`keyCertSign`, non-critical SKI, and non-critical AKI with `keyIdentifier` when
the certificate is not cryptographically self-signed. This is deliberately not
applied to another family.

`ONBOARDING_FORMS` in `src/web/server.ts` declares one route, family, title and
view per implemented family, and both the GET and POST handlers read it, so
adding a family does not mean adding two more branches.

Reconciliation after a partial commit identifies a published entity by its
complete service-identifier set. Annex F/G services have none, so the operation
is refused with a message saying why rather than matching the first entity that
also has none.

## Phase 9: Pub-EAA Providers (Annex H)

`pub-eaa-providers` is the fifth enabled family. The registry grew the members
the rest of the code reads instead of switching on family names:
`usesServiceStatus`, `serviceStatuses`, `historicalInformationPeriod`,
`publishesSelfPointer`, `requiresServiceCertificate`,
`requiresLegalBasisReference`, `collectsRegistrationIdentifier`,
`collectsAdditionalInformationUri` and `informationUriIsPolicyUrl`. The last
three replaced the parser's `relyingParty` flag, so a fourth field layout did not
mean a fourth branch.

### Model and compiler

`AuthoringService` gained `serviceStatus`, `statusStartingTime` and
`serviceHistory`; `AuthoringScheme` gained `historicalInformationPeriod`.
`compileForProfile()` emits each of them only where the profile declares them and
refuses them elsewhere, so a stray status cannot reach an Annex D–G list.

Annex H.3 makes `TETradeName` mandatory for every Pub-EAA trusted entity. The
application-to-authoring mapping puts the official registration identifier in
that component when one exists and always puts the legal-basis URI there. The
URI is `OJ:` followed by `EU` for Union law or an EU Member State's ISO 3166-1
alpha-2 code for national law, followed by the unique law identifier. The
profile compiler and `schemas/profiles/pub-eaa-schema.json` both reject a
Pub-EAA entity whose `TETradeName` omits that formatted legal reference. The
vendored generic ETSI schema remains unchanged. The mapping does not duplicate
the legal-basis URI in `TEInformationURI` or `TEElectronicAddress`; it publishes
the Pub-EAA country role URI only in `TEElectronicAddress`, leaving
`TEInformationURI` with the provider's policies URL.

`src/core/model/x509-ski.ts` produces the `X509SKI` values a history instance
publishes. Node's `X509Certificate` exposes neither the SubjectKeyIdentifier
extension nor a derived identifier, so the module walks the certificate DER for
extension 2.5.29.14 and falls back to RFC 5280 method (1).

### Withdrawal

`ApplicationService.withdrawApplication()` runs under the same per-list lock as
publication and through the same commit path — `compileSignAndStore()` was
extracted so publication and withdrawal share it exactly. It loads the
authenticated latest version, finds the entity by Trusted Entity Name, moves each
service's current state into `ServiceHistory` by key identifier, sets the
withdrawn status, and publishes sequence + 1. The application keeps its original
`publication` record and gains `withdrawal` and `withdrawnAt`.

### Storage

`AuthoringStore` validates a stored record against the family it claims: only a
family whose profile publishes a service status may carry `withdrawn`,
`withdrawnAt` or `withdrawal`; Annex H must carry a legal basis reference and no
family that does not collect one may; and a certificate field may be absent only
where the profile allows it, while every PEM block present must still parse.
