# Credimi EUDI Trusted Lists

A TS 119 602 JSON List of Trusted Entities (LoTE) publisher for four profiles:
PID Providers (Annex D), Wallet Providers (Annex E), WRPAC Providers (Annex F)
and WRPRC Providers (Annex G). Compiles, validates, signs (JAdES Compact Baseline B),
verifies, stores, and publishes LoTE artefacts. Signing keys are supplied through
local files or CI secrets and are never uploaded through a public web interface.

Includes an immutable filesystem publication store and a read-only Credimi-branded
web UI for browsing published LoTEs. Does not implement TS 119 612 Trusted Lists,
LoTL aggregation, XML/XAdES, or the EC TS02 notification API.

**Historical Phase 3** added an opt-in data-collection and administration GUI for authoring
and publishing Wallet Provider LoTEs. The current GUI supports all four
implemented families. When enabled, it provides applicant onboarding and an
administration backoffice, and every version it publishes is signed and assessed
by the Trust Inspector.

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
- `/onboarding/pid-provider` — PID Provider application form
- `/onboarding/wallet-provider` — Wallet Provider application form
- `/onboarding/wrpac-provider` — WRPAC Provider application form
- `/onboarding/wrprc-provider` — WRPRC Provider application form
- `/admin` — administration backoffice (requires `TLP_ADMIN_TOKEN`)
- `/admin/applications` — manage submitted applications
- `/admin/signing` — view signing configuration status
- `/admin/settings` — auto-approval settings per family and per list
- `/admin/lists/create` — declare a Trusted List and publish its first version

When `DATA_COLLECTION_GUI` is `false` or unset, the server operates in read-only
mode exactly as before — no onboarding, no admin routes, no authoring state.

**Example signing configuration** (`signing-config.json`):

```json
{
  "lists": [
    {
      "listKey": "eu_credimi",
      "family": "wallet-providers",
      "schemeOperatorName": "Credimi",
      "schemeOperatorStreet": "Via Roma 1",
      "schemeOperatorCountry": "IT",
      "schemeName": "EU Wallet Providers List",
      "schemeTerritory": "EU",
      "schemeOperatorContactUri": "https://credimi.eu",
      "distributionPointUri": "https://credimi.eu/wallet-providers/latest",
      "keyFile": "./keys/signing-key.pem",
      "certFile": "./keys/signing-cert.pem",
      "schemeOperatorEmail": "trustedlists@credimi.eu",
      "schemeOperatorWebsite": "https://credimi.eu/wallet-providers",
      "schemeInformationUris": [
        "https://credimi.eu/wallet-providers/scheme",
        "https://credimi.eu/wallet-providers/practice-statement"
      ],
      "policyUri": "https://credimi.eu/wallet-providers/policy"
    }
  ]
}
```

The last four fields carry Annex D/E scheme information and are required: a list
cannot be conformant without a policy, an operator email and at least two scheme
information URIs. `/admin/lists/create` writes complete entries for you.

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
a version to see its manifest, entities, certificate details, its Trust Inspector
result and its downloads.

### Version pages and the Trust Inspector

Every published version is submitted to the
[Trust Inspector](https://trust-inspector.credimi.io) as its **Compact JAdES**
artifact — the signed form, because half of the Annex D/E requirements are
signature requirements. The complete evaluation is stored beside the version, and
the page shows the Inspector status (Pass, Fail or Unavailable), the detected
family/profile, the TS 119 602 conformance level, pass/fail counts and the
evaluation timestamp, with **View Inspector report** and **Download Inspector
JSON**. An Inspector that could not be reached is reported as *Unavailable* and is
never presented as conformance.

Three download buttons appear on every version page: **JSON** (the decoded LoTE),
**Compact JAdES** (the signed artifact) and **Inspector report**. XML is not
published yet.

### Creating a Trusted List

From **Admin → Create Trusted List**, or over the API. Choose the family, name the
list, give the scheme operator details and a public base URL, and point at the
signing key and certificate. The list is declared, its first empty version is
signed and published, and the Inspector assesses it immediately. Deliberately
broken lists are listed on the form, one checkbox per defect, but generation of
them is not implemented yet and the options are disabled.

The signing certificate must have subject `O` equal to the scheme operator name
and subject `C` equal to the scheme territory (`EU` for Annex D and Annex E), or
the Inspector reports a signer subject mismatch.

### Onboarding (`/onboarding`)

Pick the Trusted List Family your organisation belongs to and start an
application. The form collects the entity's legal name, postal address and
information URI, plus one or more services. Each service needs a type, a name, an email address, a telephone number, a
**Service Digital Identity Certificate (PEM)** and a unique service URI.
The certificate may be self-signed or CA-issued; its subject organisation (`O`)
must be exactly the entity name entered on the form, and the private key is never
uploaded. Anything that is not an X.509 PEM certificate — a private key, a public
key, a signing request, a PKCS#12 bundle — is rejected with a message naming what
was supplied. Use **+ Add Service** to add more services; blocks are renumbered
automatically and every block after the first has a **Remove service** button.
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
| Download the Trust Inspector evaluation | `curl http://localhost:8080/api/v1/lists/eu_credimi/versions/1/inspector` |
| Create a Trusted List (admin token) | `curl -X POST http://localhost:8080/api/v1/admin/lists -H "Authorization: Bearer $TLP_ADMIN_TOKEN" -H 'Content-Type: application/json' -d '{"family":"wrpac-providers","schemeName":"EU WRPAC Providers List","schemeOperatorName":"Example Scheme","schemeTerritory":"EU","schemeOperatorStreet":"1 Example St","schemeOperatorCountry":"IT","schemeOperatorEmail":"trustedlists@example.eu","baseUrl":"https://example.eu/wrpac-providers","keyFile":"/etc/tlp/signer-key.pem","certFile":"/etc/tlp/signer-cert.pem"}'` — `family` is one of `pid-providers`, `wallet-providers`, `wrpac-providers`, `wrprc-providers` |
| Health check | `curl http://localhost:8080/healthz` |
| OpenAPI specification | `curl http://localhost:8080/openapi.yaml` |

## Authoring workflow (Phase 3)

1. Applicant navigates to `/onboarding` and selects one of the four available
   families: PID, Wallet, WRPAC or WRPRC Providers
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

PID, Wallet, WRPAC and WRPRC Providers are implemented list families. Pub-EAA
Providers and Registrars and Registers are visible in the GUI but are not
accepted for authoring or publication.

## Trusted List families

The immutable profile registry (`src/core/profiles/registry.ts`) explicitly
selects profiles at compile, configuration, publication, and reconciliation
boundaries. It holds the six TS 119 602 families, in annex order:

| Family | Annex | State | Onboarding |
|--------|-------|-------|------------|
| PID Providers | D | enabled | `/onboarding/pid-provider` |
| Wallet Providers | E | enabled | `/onboarding/wallet-provider` |
| WRPAC Providers | F | enabled | `/onboarding/wrpac-provider` |
| WRPRC Providers | G | enabled | `/onboarding/wrprc-provider` |
| Pub-EAA Providers | — | disabled | — |
| Registrars and Registers | — | disabled | — |

Annex F and Annex G differ from Annex D/E in three ways that the registry states
rather than the call sites guessing: they use no `ServiceUniqueIdentifier`
extension, their entity role URI names the Responsible Member State that mandates
the provider, and their onboarding collects a policies and terms URL, an optional
official registration identifier and an optional additional-information URL.
Neither profile publishes `ServiceStatus` or `StatusStartingTime`: presence in the
current list version is the statement that the provider is mandated, and losing
the mandate removes the entity from the next version.

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
