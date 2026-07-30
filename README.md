# Credimi EUDI Trusted Lists

A TS 119 602 JSON List of Trusted Entities (LoTE) publisher for the Wallet
Provider (Annex E) and PID Provider (Annex D) profiles. Compiles, validates, signs (JAdES Compact Baseline B),
verifies, stores, and publishes LoTE artefacts. Signing keys are supplied through
local files or CI secrets and are never uploaded through a public web interface.

Includes an immutable filesystem publication store and a read-only Credimi-branded
web UI for browsing published LoTEs. Does not implement TS 119 612 Trusted Lists,
LoTL aggregation, XML/XAdES, or the EC TS02 notification API.

**Historical Phase 3** added an opt-in data-collection and administration GUI for authoring
and publishing Wallet Provider LoTEs. The current Phase 5 GUI also supports PID Providers. When enabled, it provides applicant
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
- **API reference**: Stoplight Elements 7.15.0, vendored into `src/web/assets/`
  and served from the same origin, so `/docs` renders without a CDN

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
cp examples/signing/signing-config.example.json signing-config.json
# Edit signing-config.json with paths to your actual signing key/cert

npm run build
node dist/src/cli/main.js serve --data-collection-gui
```

When enabled:
- `/onboarding` — applicant onboarding and Trusted List Family catalogue
- `/onboarding/wallet-provider` — Wallet Provider application form
- `/onboarding/pid-provider` — PID Provider application form
- `/admin` — administration backoffice (requires `TLP_ADMIN_TOKEN`)
- `/admin/applications` — manage submitted applications
- `/admin/signing` — view signing configuration status
- `/admin/settings` — auto-approval settings per family and per list

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

## Quick GUI guide

### Catalogue (`/`)

The home page lists every published Trusted List with its family, latest
sequence, issue and next-update dates and cryptographic signature status. Signer
trust is always reported as *not evaluated*. Each Trusted List and each Trusted
List Family is shown as a colour-coded chip, and the same colour is used for that
family or list on every other page. Click a list to see its version history, and
a version to see its manifest, entities, certificate details and downloads.

### Onboarding (`/onboarding`)

Pick the Trusted List Family your organisation belongs to and start an
application. The form collects the entity's legal name, postal address and
information URI, plus one or more services. Each service needs a type, a name, a
**Service Digital Identity Certificate (X.509 PEM)** and a unique service URI.
The certificate may be self-signed or CA-issued; its subject organisation (`O`)
must be exactly the entity name entered on the form, and the private key is never
uploaded. Anything that is not an X.509 PEM certificate — a private key, a public
key, a signing request, a PKCS#12 bundle — is rejected with a message naming what
was supplied. Use **+ Add Service** to add more services; blocks are renumbered
automatically and every block after the first has an **×** button to remove it.
Submitting returns an application ID to quote when following up.

### Certificate creation (`/docs/certificate-creation`)

A one-page guide, linked from the footer **Resources** column and from the
certificate field on both onboarding forms. It explains what
`ServiceDigitalIdentity` means for Wallet and PID services, distinguishes PEM,
PKCS#8, PKCS#10, PKCS#12/PFX and DER, and gives the OpenSSL commands to create a
self-signed test certificate, to check that a certificate matches its private
key, to create a CSR for a CA, and to convert or extract a certificate to PEM.

### Administration (`/admin`)

Sign in with `ADMIN_USER`/`ADMIN_PASSWORD`, or with `/admin?token=…`. From the
dashboard:

- **Manage Applications** — filter by state, open an application to review the
  entity, its services, the ETSI validation result, the normalized compiler
  input and the cumulative publication preview, then Approve, Reject, Publish or
  Delete it.
- **Signing Configuration** — per-list signing status, certificate subject and
  fingerprint. Private key contents are never displayed.
- **Settings** — auto-approval. Tick a Trusted List Family, or a single Trusted
  List nested under it, to approve and publish every future application for it
  immediately on submission, bypassing the manual Approve and Publish actions.
  Either level is sufficient. Families with no implemented profile cannot be
  enabled. If an automatic publication fails, the applicant is told and the
  application stays in the manual review queue.

### API documentation (`/docs`)

The full API reference renders in an embedded Stoplight Elements frame. The raw
specification is available at `/openapi.yaml` and `/openapi.json`.

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

## API Examples

| API | Example |
|-----|---------|
| List published lists | `curl http://localhost:8080/api/v1/lists` |
| Get list index | `curl http://localhost:8080/api/v1/lists/eu_credimi` |
| Get version manifest | `curl http://localhost:8080/api/v1/lists/eu_credimi/versions/1` |
| Download decoded LoTE JSON | `curl http://localhost:8080/api/v1/lists/eu_credimi/versions/1/lote` |
| Download Compact JAdES | `curl -o lote.jades http://localhost:8080/api/v1/lists/eu_credimi/versions/1/signature` |
| Download publication manifest | `curl http://localhost:8080/api/v1/lists/eu_credimi/versions/1/manifest` |
| Health check | `curl http://localhost:8080/healthz` |
| OpenAPI specification | `curl http://localhost:8080/openapi.yaml` |

## Authoring workflow (Phase 3)

1. Applicant navigates to `/onboarding` and selects Wallet Providers or PID Providers
2. Applicant submits entity details, addresses, and one X.509 PEM certificate per
   service (self-signed or CA-issued; see `/docs/certificate-creation`)
3. Applicant receives a confirmed application ID
4. Administrator reviews at `/admin/applications`
5. Administrator approves, then publishes
6. Published LoTE appears in the public catalogue at `/`

Steps 4 and 5 are skipped for a Trusted List Family or Trusted List that is set
to auto-approve in `/admin/settings`: those applications are approved and
published as soon as they are submitted.

The mutable application/draft layer (`AUTHORING_DIR`) is separate from the
immutable publication store (`PUBLICATION_DIR`). Applications track their
lifecycle state (`submitted` → `approved` → `published`) and record the
resulting publication metadata.

## Cumulative publication semantics

Phase 4 introduced cumulative membership independently for each configured list
key. The current profile-aware path adds one approved Wallet Provider or PID Provider entity to the
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

Wallet Providers and PID Providers are implemented list families. The other five
catalogue families are visible in the GUI but are not accepted for authoring or
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

## Auto-approval settings

`/admin/settings` stores its state in `settings.json` inside `AUTHORING_DIR`,
beside the mutable application records and never in the publication store:

```json
{
  "schemaVersion": 1,
  "autoApproveFamilies": { "wallet-providers": true },
  "autoApproveLists": { "eu_credimi": true }
}
```

A family opt-in and a list opt-in are equivalent — either one is enough. An
auto-approved application still goes through the ordinary locked, cumulative
publication path, so uniqueness, round-trip and ETSI checks all still apply. On
read, unknown families, unsafe list keys and non-boolean values are dropped so a
hand-edited file cannot break the administration pages. Writes are atomic, and
the posted form is the complete new state: a box left unticked turns its flag off.

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
