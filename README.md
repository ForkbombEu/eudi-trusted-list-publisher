# EUDI Trusted List Publisher

A TS 119 602 JSON List of Trusted Entities (LoTE) publisher for the Wallet
Provider profile (Annex E). Compiles, validates, signs (JAdES Compact Baseline B),
verifies, stores, and publishes LoTE artefacts. Signing keys are supplied through
local files or CI secrets and are never uploaded through a public web interface.

Includes an immutable filesystem publication store and a read-only Credimi-branded
web UI for browsing published LoTEs. Does not implement TS 119 612 Trusted Lists,
LoTL aggregation, XML/XAdES, or the EC TS02 notification API.

**Phase 3** adds an opt-in data-collection and administration GUI for authoring
and publishing Wallet Provider LoTEs. When enabled, it provides applicant
onboarding and an administration backoffice.

## Important: signature valid vs signer trusted

This tool **cryptographically verifies** signatures but does **not evaluate signer trust**.
The signature validity (`signatureValid`) is distinct from trust (`signerTrustStatus`),
which is always `"not_evaluated"`. No PKIX trust chain validation is performed.

## Technical specs

- **Runtime**: Node.js 24 LTS
- **Language**: TypeScript 5.8
- **Module system**: ESM (`"type": "module"`)
- **Web server**: `node:http` (no framework)
- **Libraries**: `jose` (JOSE/JWS), `ajv` + `ajv-formats` (JSON Schema), `commander` (CLI)

## How to run

```bash
npm install
npm run build
node dist/src/cli/main.js --help
```

### GUI mode (Phase 3)

Enable with `DATA_COLLECTION_GUI=true`:

```bash
cp .env.example .env
# Edit .env: set DATA_COLLECTION_GUI=true, configure signing config path

# Create signing configuration
cp signing-config.example.json signing-config.json
# Edit signing-config.json with paths to your actual signing key/cert

npm run build
node dist/src/cli/main.js serve --data-collection-gui
```

When enabled:
- `/onboarding` — applicant onboarding and list-family catalogue
- `/onboarding/wallet-provider` — Wallet Provider application form
- `/admin` — administration backoffice (requires `TLP_ADMIN_TOKEN`)
- `/admin/applications` — manage submitted applications
- `/admin/signing` — view signing configuration status

When `DATA_COLLECTION_GUI` is `false` or unset, the server operates in read-only
mode exactly as before — no onboarding, no admin routes, no authoring state.

**Example signing configuration** (`signing-config.json`):

```json
{
  "lists": [
    {
      "listKey": "eu_credimi",
      "family": "wallet-providers",
      "keyFile": "./keys/signing-key.pem",
      "certFile": "./keys/signing-cert.pem"
    }
  ]
}
```

**Testing-tool limitation**: This is a test/debug fixture publisher, not an
official or production Trusted List Provider. Document uploads are not
implemented; required documents use placeholder `{FILENAME}.md` references.

## CLI Examples

| Command | Example |
|---------|---------|
| `compile` | `trusted-list-publisher compile -i scheme.json -o lote.json` |
| `validate` | `trusted-list-publisher validate -i lote.json --etsi` |
| `sign` | `trusted-list-publisher sign -i lote.json -k key.pem -c cert.pem -o signed.jades` |
| `verify` | `trusted-list-publisher verify -i signed.jades -c cert.pem` |
| `publish` | `trusted-list-publisher publish -i signed.jades -c cert.pem --publication-dir ./publications` |
| `serve` | `trusted-list-publisher serve --publication-dir ./publications --port 8080` |
| `serve (GUI)` | `DATA_COLLECTION_GUI=true trusted-list-publisher serve --data-collection-gui` |

**Exit codes**:
- 0: success
- 1: general error (invalid JSON, file not found)
- 2: authoring schema validation failure
- 3: ETSI schema validation failure
- 4: missing key or certificate
- 5: signature verification failure
- 6: publication error (invalid signature, expired cert, ETSI schema failure)

## Authoring workflow (Phase 3)

1. Applicant navigates to `/onboarding` and selects Wallet Providers
2. Applicant submits entity details, addresses, and X.509 certificate(s)
3. Applicant receives a confirmed application ID
4. Administrator reviews at `/admin/applications`
5. Administrator approves, then publishes
6. Published LoTE appears in the public catalogue at `/`

The mutable application/draft layer (`AUTHORING_DIR`) is separate from the
immutable publication store (`PUBLICATION_DIR`). Applications track their
lifecycle state (`submitted` → `approved` → `published`) and record the
resulting publication metadata.

## Cumulative publication semantics

Phase 4 publishes cumulative membership independently for each configured list
key. A successful publication adds one approved Wallet Provider entity to the
latest authenticated list and creates the next immutable sequence; it does not
replace earlier entities.

- The highest physically stored sequence directory is authoritative. If that
  sequence is corrupt or unauthenticated, preview and publication fail closed
  instead of falling back to an older version.
- Every existing authenticated entity is converted to the authoring model and
  compiled back before reuse. The complete entity must survive that semantic
  round trip, otherwise preview and publication reject the first differing
  field path before signing or filesystem writes.
- Service unique identifiers must be unique within one list key, across all
  services and entities. The same identifier may be used in a different list
  key, and display names are not uniqueness keys.
- Publication is serialized by a process-local keyed lock. Different list keys
  remain independent, but this lock does not coordinate multiple Node.js
  processes or hosts sharing one publication directory.
- Immutable publication commit and mutable application-state update are
  separate boundaries. If the immutable commit succeeds but the application
  save fails, `publishApplication()` returns the typed
  `PUBLICATION_COMMITTED_APPLICATION_STALE` result with hashes, sequence and
  timestamp. `reconcileApplication()` repairs the application record without
  creating another list version.
- The authenticated admin application-detail route renders existing/resulting
  entity counts and current/proposed sequences before publication.

Wallet Providers remain the only implemented list family. The other catalogue
families are visible in the GUI but are not accepted for authoring or
publication.

## Phase 5 profiles

The immutable profile registry explicitly selects profiles at compile,
configuration, publication, and reconciliation boundaries. Wallet Providers and
PID Providers are enabled; Non-qualified EAA, QEAA, WRPAC, WRPRC, and Registrars
remain disabled. PID onboarding is available at `/onboarding/pid-provider`.
Every configured list key declares `family`, and cumulative publication rejects
an authenticated existing LoTE whose type conflicts with that family. Internal
schema/signature checks are publication safety boundaries, not external trust
or regulatory-conformance evaluation.

## Environment variables

| Variable | Used by | Default |
|----------|---------|---------|
| `TLP_SIGNING_KEY` | `sign` | — |
| `TLP_SIGNING_CERT` | `sign`, `verify`, `publish` | — |
| `TLP_PUBLICATION_DIR` | `publish`, `serve` | `./publications` |
| `TLP_HOST` | `serve` | `127.0.0.1` |
| `TLP_PORT` | `serve` | `8080` |
| `DATA_COLLECTION_GUI` | `serve` (Phase 3) | `false` |
| `AUTHORING_DIR` | `serve` (Phase 3) | `./authoring` |
| `TLP_ADMIN_TOKEN` | `serve` (Phase 3) | — |
| `TLP_SIGNING_CONFIG` | `serve` (Phase 3) | — |
| `TLP_SCHEME_OPERATOR_NAME` | `serve` (Phase 3) | `Credimi` |
| `TLP_SCHEME_NAME` | `serve` (Phase 3) | `EU Wallet Providers List` |
| `TLP_SCHEME_TERRITORY` | `serve` (Phase 3) | `EU` |
