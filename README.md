# Credimi EUDI Trusted Lists

A TS 119 602 JSON List of Trusted Entities (LoTE) publisher for five profiles:
PID Providers (Annex D), Wallet Providers (Annex E), WRPAC Providers (Annex F)
WRPRC Providers (Annex G) and Pub-EAA Providers (Annex H). Compiles, validates,
signs (JAdES Compact Baseline B),
verifies, stores, and publishes LoTE artefacts. Signing keys are supplied through
local files or CI secrets and are never uploaded through a public web interface.

Includes an immutable filesystem publication store and a read-only Credimi-branded
web UI for browsing published LoTEs. Does not implement TS 119 612 Trusted Lists,
LoTL aggregation, XML/XAdES, or the EC TS02 notification API.

**Historical** added an opt-in data-collection and administration GUI for authoring
and publishing Wallet Provider LoTEs. The current GUI supports all five
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

### GUI mode 

Enable with `DATA_COLLECTION_GUI=true`:

```bash
cp .env.example .env
# Edit .env: set DATA_COLLECTION_GUI=true, configure signing config path

# Create signing configuration
mkdir -p .local-signing
cp examples/signing/signing-config.example.json .local-signing/signing-config.json
# Edit it with paths to your actual signing key/cert

npm run build
npm run serve
```

When enabled:
- `/onboarding` — applicant onboarding and Trusted List Family catalogue
- `/onboarding/pid-provider` — PID Provider application form
- `/onboarding/wallet-provider` — Wallet Provider application form
- `/onboarding/wrpac-provider` — WRPAC Provider application form
- `/onboarding/wrprc-provider` — WRPRC Provider application form
- `/onboarding/pub-eaa-provider` — Pub-EAA Provider application form
- `/admin` — administration backoffice (requires `TLP_ADMIN_TOKEN`)
- `/admin/applications` — manage submitted applications
- `/admin/signing` — view signing configuration status
- `/admin/settings` — auto-approval settings per family and per list
- `/admin/lists/create` — declare a Trusted List and publish its first version

When `DATA_COLLECTION_GUI` is `false` or unset, the server operates in read-only
mode exactly as before — no onboarding, no admin routes, no authoring state.
### Signing configuration (`./.local-signing/signing-config.json`)

`TLP_SIGNING_CONFIG` points at a JSON or YAML file that answers one question per
Trusted List: **who signs it, with which key, and under what scheme identity.**
It is the bridge between a `listKey` used throughout the application and the
concrete key pair and Annex D/E scheme metadata that a conformant list requires.
Without an entry for a given list key, that list cannot be published or signed.

The file lives under `./.local-signing/` together with the PEM key and
certificate files it references. **That whole directory is gitignored and must
never be committed** — it holds private signing keys. Only
`examples/signing/signing-config.example.json` is in the repository, as a
template to copy.

```
.local-signing/            # gitignored
├── signing-config.json    # the file TLP_SIGNING_CONFIG points at
└── certificates/          # TLP_CERTIFICATES_DIR
    └── eu_example_operator/
        ├── signing-key.pem  # mode 0600, referenced by keyFile
        └── signing-cert.pem # referenced by certFile
```

The path is not special — it is simply whatever `TLP_SIGNING_CONFIG` is set to
in `.env`. Relative paths inside the file, including `keyFile` and `certFile`,
resolve against the process working directory, not against the config file.

Every field below is required. Missing ones raise a startup error rather than
being defaulted, because a list signed with guessed scheme metadata would be
silently non-conformant.

| Field | Meaning |
|-------|---------|
| `listKey` | Unique identifier for the list; must be unique across the file |
| `family` | One of `wallet-providers`, `pid-providers`, `wrpac-providers`, `wrprc-providers`, `pub-eaa-providers` |
| `keyFile` / `certFile` | Paths to the PEM private key and certificate used to sign |
| `schemeOperatorName` / `schemeOperatorStreet` / `schemeOperatorCountry` | Identity of the scheme operator |
| `schemeName` / `schemeTerritory` | Name and territory of the scheme |
| `schemeOperatorContactUri` / `schemeOperatorEmail` / `schemeOperatorWebsite` | Operator contact points |
| `distributionPointUri` | Where the published list is served from |
| `schemeInformationUris` | Annex D/E scheme information; **at least two URIs** |
| `policyUri` | The scheme policy document |

`/admin/signing` shows, per list key, whether both files exist and the subject
and SHA-256 fingerprint of the loaded certificate — the quickest way to confirm
the configuration resolves. A duplicate `listKey` or an unknown `family` is a
hard error at load time.

**Example signing configuration** (`./.local-signing/signing-config.json`):

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
      "keyFile": "./.local-signing/wallet-signer-key.pem",
      "certFile": "./.local-signing/wallet-signer-cert.pem",
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

The last column, **Open**, opens the latest version's artifacts directly: a
**JSON** button for the LoTE, a **JAdES** button for the Compact JAdES signed
artifact, and an **XML** button only for versions that actually have an
`lote.xml` beside them. JSON and JAdES are always present, because every
published version has both by construction. This publisher does not produce
XML — TS 119 612 and XAdES are out of scope — so the XML button is normally
absent rather than dead.

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

When `TLP_CERTIFICATES_DIR` is configured, the Signing Material card also offers
**Generate key and certificate**. It takes `O` from the Operator Name and `C`
from Scheme Territory, creates a self-signed EC P-256 certificate through
OpenSSL, and prefills the generated server-side paths. Material is stored under
`<TLP_CERTIFICATES_DIR>/<listKey>/`; existing files are never overwritten and
the private key is created with mode `0600`. The configured directory must be a
persistent volume when the server runs in a container. Relative configured
paths are preserved in the signing configuration and resolve from the server's
working directory; for example, `./.local-signing` remains relative.

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
uploaded. WRPAC submissions must use a currently valid RFC 5280 CA certificate
with critical `basicConstraints`/`CA:TRUE`, critical `keyUsage` containing
`keyCertSign`, an SKI, and an AKI key identifier when it is not self-signed.
Anything that is not an X.509 PEM certificate — a private key, a public key, a
signing request, a PKCS#12 bundle — is rejected with a message naming what was
supplied. Use **+ Add Service** to add more services; blocks are renumbered
automatically and every block after the first has a **Remove service** button.
Submitting returns an application ID to quote when following up.

### Certificate creation (`/docs/certificate-creation`)

A one-page guide, linked from the footer **Resources** column and from the
certificate field on both onboarding forms. It explains what
`ServiceDigitalIdentity` means for Wallet and PID services, distinguishes PEM,
PKCS#8, PKCS#10, PKCS#12/PFX and DER, and gives the OpenSSL commands to create a
self-signed test certificate, to check that a certificate matches its private
key, to create a CSR for a CA, and to convert or extract a certificate to PEM.
It also gives the RFC 5280 extension requirements for a WRPAC CA certificate.

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
| Open the XML rendition, when a version has one | `curl http://localhost:8080/api/v1/lists/eu_credimi/versions/1/xml` — 404 unless an `lote.xml` was placed beside the version; this publisher does not produce XML |
| Download the Trust Inspector evaluation | `curl http://localhost:8080/api/v1/lists/eu_credimi/versions/1/inspector` |
| Create a Trusted List (admin token) | `curl -X POST http://localhost:8080/api/v1/admin/lists -H "Authorization: Bearer $TLP_ADMIN_TOKEN" -H 'Content-Type: application/json' -d '{"family":"wrpac-providers","schemeName":"EU WRPAC Providers List","schemeOperatorName":"Example Scheme","schemeTerritory":"EU","schemeOperatorStreet":"1 Example St","schemeOperatorCountry":"IT","schemeOperatorEmail":"trustedlists@example.eu","baseUrl":"https://example.eu/wrpac-providers","keyFile":"/etc/tlp/signer-key.pem","certFile":"/etc/tlp/signer-cert.pem"}'` — `family` is one of `pid-providers`, `wallet-providers`, `wrpac-providers`, `wrprc-providers` |
| Health check | `curl http://localhost:8080/healthz` |
| OpenAPI specification | `curl http://localhost:8080/openapi.yaml` |

## Authoring workflow 

1. Applicant navigates to `/onboarding` and selects one of the five available
   families: PID, Wallet, WRPAC, WRPRC or Pub-EAA Providers
2. Applicant submits entity details, addresses, and one X.509 PEM certificate per
   service (self-signed or CA-issued; see `/docs/certificate-creation`). WRPAC
   certificates must satisfy the RFC 5280 CA checks described above. The
   certificate is optional for Pub-EAA Providers, which may supply more than one
   provided they share a public key and a subject
3. Applicant receives a confirmed application ID
4. Administrator reviews at `/admin/applications`
5. Administrator approves, then publishes
6. Published LoTE appears in the public catalogue at `/`
7. For Pub-EAA Providers only, the administrator may later **withdraw** the
   notification, which publishes a further immutable version

Steps 4 and 5 are skipped for a Trusted List Family or Trusted List that is set
to auto-approve in `/admin/settings`: those applications are approved and
published as soon as they are submitted.

The mutable application/draft layer (`AUTHORING_DIR`) is separate from the
immutable publication store (`PUBLICATION_DIR`). Applications track their
lifecycle state (`submitted` → `approved` → `published`) and record the
resulting publication metadata.

## Cumulative publication semantics

We introduced cumulative membership independently for each configured list
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

PID, Wallet, WRPAC, WRPRC and Pub-EAA Providers are implemented list families.
Registrars and Registers is visible in the GUI but is not accepted for authoring
or publication.

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
| Pub-EAA Providers | H | enabled | `/onboarding/pub-eaa-provider` |
| Registrars and Registers | — | disabled | — |

Annex H (Pub-EAA Providers) is the only implemented profile that publishes a
service status. Every service of a notified provider carries
`SvcStatus/notified` and a `StatusStartingTime` taken from the publication event;
the administration **Withdraw notification** action publishes a new immutable
version in which every service reads `SvcStatus/withdrawn` and the previous state
is kept in `ServiceHistory` by subject key identifier only. Annex H also fixes
`HistoricalInformationPeriod` at 65535, publishes **no** `PointersToOtherLoTE`,
makes the service certificate optional, and requires the Union or national legal
basis as an `OJ:` URI. One locally decidable Annex H sub-rule
(`pubEaaLawReferencePresent`) is not yet satisfied — see `STANDARDS.md` for what
was probed and why it is reported rather than hidden.

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

## Intentionally broken Trusted Lists

Broken lists exist so EUDI implementations — wallets, Issuers, Verifiers — can
register against a list that is *known* to violate a specific clause and confirm
their runtime detects it. **A failing Trust Inspector verdict on one of these
lists is the deliverable, not an error.**

Currently implemented for the **Pub-EAA (Annex H)** family.

### How a broken list is generated

The list is compiled **healthy first**, then cloned and mutated, so every broken
fixture is a stated delta from a known-good baseline:

1. Compile the healthy document.
2. Apply the selected **pre-sign** mutations to a clone (schema, profile,
   lifecycle, certificate and content defects).
3. Sign it.
4. Apply the selected **post-sign** mutations (signature defects), which re-sign
   rather than edit the serialization — a hand-edited JWS fails cryptographic
   verification first and would mask the defect under test.
5. Publish, submit the final Compact JAdES to the Trust Inspector, and store the
   complete evaluation.

Local schema and profile validation failures are **recorded, not fatal**: for a
broken fixture a schema violation is the point. The signature must still verify
and the certificate must still be current, so a broken fixture is never also an
unauthenticated one, and the manifest hashes still cover the artifacts exactly
as published.

### The defect catalogue

| Defect ID | Stage | Primary expected Inspector rule |
|-----------|-------|--------------------------------|
| `non_strict_timestamps` | pre-sign | `ts119602.syntax.date_time` |
| `scheme_name_without_territory` | pre-sign | `ts119602.scheme.name` |
| `missing_scheme_information_uri` | pre-sign | `ts119602.structure.scheme_information_presence` |
| `missing_policy_or_legal_notice` | pre-sign | `ts119602.scheme.policy_or_legal_notice` |
| `missing_operator_email` | pre-sign | `ts119602.scheme.operator_address` |
| `missing_self_pointer` | pre-sign | `ts119602.profile.pub_eaa_providers.scheme_information` |
| `pem_service_certificate` | pre-sign | `ts119602.service.digital_identity` |
| `extension_without_criticality` | pre-sign | `ts119602.service.extensions` |
| `signer_organisation_mismatch` | post-sign | `json_lote.signature.jades_signer_subject.organization` |
| `jades_without_signing_time` | post-sign | `json_lote.signature.jades_signing_time` |

Expected rule IDs were taken from live Inspector evaluations, not guessed. They
remain an *expectation*: the stored metadata always reports expected against
actual, so a drifting Inspector rule set is visible rather than hidden.

**Annex H note.** Annex H forbids `PointersToOtherLoTE`, so a healthy Pub-EAA
list already omits it and "omit the self pointer" would change nothing. For this
family the defect is inverted — it *injects* the prohibited pointer. The runtime
consequence a developer tests for is the same.

### Defects persist on the list

The selection is stored on the signing-configuration entry, not applied once at
creation. **Every later version of the list is mutated the same way**, including
the version published when a developer's Issuer or Verifier is approved into it.
A list declared broken stays broken. Without this, a developer registering into
a broken list would get a clean entry back and the service-level defects would
never reach them.

Because a newly created list is empty, broken fixtures are seeded with one
deterministic synthetic entity so the service-level defects have something to
mutate. The healthy baseline stays empty, which is what keeps its verdict clean.

### Evidence stored beside each version

`fixture.json` sits next to `inspector.json`, outside the integrity-checked set
for the same reason: it is evidence *about* the version. It records the selected
defects, every mutation and whether it landed, local validation failures, and
expected against actual Inspector failures split into matched, missing,
additional and known-unrelated. Cascading failures are expected — one mutation
can trip several rules — so an additional failure is reported, not treated as
wrong.

### Generating the fixture suite

```sh
npm run build
node scripts/generate-pub-eaa-fixtures.mjs           # real generator, live Inspector
node scripts/generate-pub-eaa-fixtures.mjs --dry-run # list what would be created
```

This produces `pub-eaa-healthy`, one `pub-eaa-broken-<defect-id>` per defect and
`pub-eaa-broken-combined`. Each fixture is signed by its own certificate whose
subject organisation equals its scheme operator name — sharing one would make
every list fail the signer-organisation rule and drown the defect under test.

All paths come from the environment; none are hardcoded:

| Variable | Default | Holds |
|----------|---------|-------|
| `TLP_SIGNING_CONFIG` | `./.local-signing/signing-config.json` | the signing configuration the fixtures are appended to |
| `TLP_FIXTURE_KEY_DIR` | `./.local-signing/fixtures` | per-fixture signing key and certificate pairs |
| `TLP_FIXTURE_REPORT` | `./.local-signing/fixture-report.json` | the run report |
| `TLP_PUBLICATION_DIR` | `./publications` | the published fixtures |

The run report is a human-readable summary of the generation: derived list keys,
Inspector verdicts, and expected against actual failures per fixture. **Nothing
in the application reads it** — it is an operator-facing record of one run, and
deleting it affects nothing.

Reruns are idempotent: a fixture is deleted and regenerated from scratch.

## Deployment

Reference deployment: the Node app under pm2 listening on `TLP_PORT`, behind
Caddy as a reverse proxy, with DNS at Cloudflare. See
[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) for the full debugging guide and
[`deploy/Caddyfile.example`](deploy/Caddyfile.example) for a ready site config.

```caddy
lote.credimi.io {
    reverse_proxy 127.0.0.1:23100
}
```

The app exposes `GET /healthz`, which returns `{"status":"ok"}` uncached, and
writes one JSON line per request to stderr (`pm2 logs`). Probe the app, then
Caddy, then Cloudflare — the first probe that fails identifies the broken layer.

### Cloudflare: the proxied-record redirect loop

If the site answers `ERR_TOO_MANY_REDIRECTS` in the browser, and `curl -I` shows
a chain of `308 Permanent Redirect` responses whose `Location` equals the URL
that was requested, the cause is the Cloudflare DNS record for the subdomain
being set to **Proxied** (orange cloud) while the zone's SSL/TLS mode is
**Flexible**.

In that combination Cloudflare fetches the origin over plain HTTP on port 80.
Caddy's automatic HTTPS answers every path with its standard `308` redirect to
`https://`. Cloudflare relays that redirect to the browser, which is already on
HTTPS, so it requests the same URL again — indefinitely.

Two details make this easy to recognise:

- **The status code is the fingerprint.** `308` is Caddy's automatic-HTTPS
  redirect. Cloudflare's own "Always Use HTTPS" feature emits `301` instead.
- **`pm2 logs` stays completely empty.** The loop resolves at the edge, so no
  request ever reaches the app. An empty app log during a failing request is
  itself a diagnosis: look at Caddy and Cloudflare, not at the application.

The fix is to set the DNS record for the subdomain to **DNS only** (grey cloud),
so Caddy terminates TLS end-to-end with its own Let's Encrypt certificate. If
the record must stay proxied, set the Cloudflare SSL/TLS encryption mode to
**Full (strict)** instead.

Verify with `curl` before trusting a browser — browsers cache `308` responses
aggressively and keep looping after the server is already fixed:

```sh
curl -sSI https://lote.credimi.io/healthz   # expect 200, not 308
```

## Environment variables

| Variable | Used by | Default |
|----------|---------|---------|
| `TLP_SIGNING_KEY` | `sign` | — |
| `TLP_SIGNING_CERT` | `sign`, `verify`, `publish` | — |
| `TLP_PUBLICATION_DIR` | `publish`, `serve` | `./publications` |
| `TLP_HOST` | `serve` | `127.0.0.1` |
| `TLP_PORT` | `serve` | `8080` |
| `DATA_COLLECTION_GUI` | `serve`  | `false` |
| `AUTHORING_DIR` | `serve`  | `./authoring` |
| `TLP_ADMIN_TOKEN` | `serve`  | — |
| `TLP_SIGNING_CONFIG` | `serve`  | — |
| `TLP_CERTIFICATES_DIR` | `serve` | — |
| `TLP_SCHEME_OPERATOR_NAME` | `serve`  | `Credimi` |
| `TLP_SCHEME_NAME` | `serve`  | `EU Wallet Providers List` |
| `TLP_SCHEME_TERRITORY` | `serve`  | `EU` |
