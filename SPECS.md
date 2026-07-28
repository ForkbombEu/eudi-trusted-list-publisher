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
    model/           — TypeScript types for LoTE data model
    profiles/
      wallet-provider/ — Wallet Provider profile types and constants
    compile/         — Compile authoring input -> LoTE
    validate/        — Schema validation (authoring + ETSI)
    signing/         — JAdES Compact signing
    verification/    — JAdES Compact verification
  cli/               — CLI commands and entry point
schemas/
  etsi/              — Vendored ETSI JSON schemas
  authoring/         — Authoring input JSON schema
examples/
  wallet-provider/   — Example Wallet Provider input files
test/
  fixtures/          — Test keys, certs, and WE BUILD fixtures
```

## CLI, web, and API interfaces

### CLI commands

```
trusted-list-publisher compile  — produce unsigned deterministic LoTE
trusted-list-publisher validate — validate authoring input and ETSI structure
trusted-list-publisher sign     — sign a compiled LoTE
trusted-list-publisher verify   — verify a signed LoTE
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
