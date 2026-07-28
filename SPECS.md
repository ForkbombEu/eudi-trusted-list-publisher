# Project Specifications

## Template status

This project has selected its backend. See below.

## Selected backend and rationale

Node.js 24 LTS with TypeScript.

The publisher is a standalone core library, CLI and later web application.
Direct import into Credimi's Go backend is not currently required.

## Approved first vertical slice

Implement a TS 119 602 JSON LoTE publisher for the Wallet Provider profile.

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
      wallet-provider/ — Wallet Provider profile types and constants
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
Stoplight Elements pinned at v7.15.0.

### Runtime asset locations

```
src/web/assets/style.css              — byte-for-byte copy of HITL/style.css
src/web/assets/credimi_logo.svg       — byte-for-byte copy of HITL/credimi_logo.svg
src/web/assets/credimi_logo_negative.svg — byte-for-byte copy of HITL/credimi_logo_negative.svg
src/web/assets/app.css                — application-specific layout
src/web/assets/openapi.yaml           — OpenAPI 3.1 specification

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
defines the seven intended families:

- PID Providers
- Non-qualified EAA Providers
- QEAA Providers
- Wallet Providers (enabled in Phase 3)
- WRPAC / Access CA Providers
- WRPRC Providers
- Registrars

Only Wallet Providers is enabled. Other six are displayed with "Not implemented yet".

### Application model

Defined in `src/core/authoring/application-model.ts`:

```
ApplicationState = "submitted" | "approved" | "rejected" | "published"
WalletProviderApplication { id, schemaVersion, family, state, submittedAt,
  applicantData { entityName, entityTradeName?, entityStreetAddress,
    entityLocality?, entityPostalCode?, entityCountry, entityInformationURI,
    services[{ serviceType, serviceName, certificatePem, serviceUniqueIdentifier }] },
  adminNote?, approvedAt?, rejectedAt?, publication? }
```

Lifecycle transitions:
- submitted → approved, rejected
- approved → published, rejected
- rejected → (terminal)
- published → (terminal)

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
- `GET /onboarding/submitted/{id}` — submission confirmation

Administration (requires admin token via `?token=` query parameter):
- `GET /admin` — dashboard
- `GET /admin/applications` — application list with state filtering
- `GET /admin/applications/{id}` — application detail
- `POST /admin/applications/{id}/approve` — approve application
- `POST /admin/applications/{id}/reject` — reject with note
- `POST /admin/applications/{id}/publish` — compile, sign, verify, store
- `POST /admin/applications/{id}/delete` — delete (unpublished only)
- `GET /admin/signing` — signing configuration status

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
```
