# EUDI Trusted List Publisher

## Introduction

This is a tool for **testing and debugging how EUDI components behave against
Trusted Lists** — healthy ones and intentionally broken ones.

It publishes controlled fixtures for interoperability, integration and negative
testing. You point a wallet, an issuer, a verifier or a relying-party runtime at
a list this publisher serves, and you find out what that runtime does: with a
conformant list, and with a list that violates one specific clause and nothing
else.

It supports the Trusted List families and artifact formats the repository
actually implements, across two ETSI standards:

| Family | Standard | Artifact | Signature |
| --- | --- | --- | --- |
| PID Providers | ETSI TS 119 602, Annex D | JSON LoTE | JAdES Baseline B, Compact |
| Wallet Providers | ETSI TS 119 602, Annex E | JSON LoTE | JAdES Baseline B, Compact |
| WRPAC Providers | ETSI TS 119 602, Annex F | JSON LoTE | JAdES Baseline B, Compact |
| WRPRC Providers | ETSI TS 119 602, Annex G | JSON LoTE | JAdES Baseline B, Compact |
| Pub-EAA Providers | ETSI TS 119 602, Annex H | JSON LoTE | JAdES Baseline B, Compact |
| EAA Providers | ETSI TS 119 612 | XML Trusted List | XAdES-B-B, enveloped |
| QEAA Providers | ETSI TS 119 612 | XML Trusted List | XAdES-B-B, enveloped |

Every family in that table has a working onboarding form, publication path and
artifact download. Nothing else is listed. "Registrars and Registers" appears in
the GUI as a known family but is not accepted for authoring or publication.

**JAdES signs the JSON artifacts. XAdES signs the XML artifacts.** The two are
not interchangeable, and the tool never mixes them.

EAA and QEAA are TS 119 612 *service profiles*, not lists of their own: one XML
Trusted List may accept EAA services, QEAA services, or both. Pub-EAA (Annex H)
is a different thing again — a TS 119 602 JSON list of *publicly issued*
attestation providers.

### What this is not

- **Not a production-ready trust infrastructure.**
- **Not an accredited or legally authoritative Trusted List publisher.** Nothing
  it publishes has legal effect.
- **Not a production-grade certification authority.** Its certificate generator
  produces self-signed test material.
- **Not a replacement** for a Member State supervisory body, a conformity
  assessment body, or qualified trust-service infrastructure.
- Generated Trusted Lists, certificates and signatures are **testing material**
  unless independently configured and governed otherwise.

It also does not aggregate a List of Trusted Lists — only the mandatory pointer
to the EU LOTL is published — and does not implement the EC TS02 notification
API. It verifies signatures cryptographically but **evaluates no signer trust**:
`signerTrustStatus` is always `not_evaluated`, and no PKIX path is built.

## Main functionalities

- **Onboard and register components** into healthy and intentionally broken
  Trusted Lists, through one onboarding form per implemented family.
- **Catalogue and inspect** every published list, its current version and its
  immutable earlier versions.
- **View and download artifacts**: JSON and Compact JAdES for TS 119 602 lists,
  signed XML and its `.sha2` digest for TS 119 612 lists.
- **Inspect manifests, hashes and Trust Inspector evaluations** per version.
- **Use documented OpenAPI endpoints**, browsable at `/docs`.
- **Create healthy and intentionally broken lists** from the administration
  interface, for either standard.
- **Review, approve or reject** onboarding applications.
- **Configure automatic acceptance and publication**, globally or per list.
- **Perform lifecycle actions**: EAA deprecation of national recognition, QEAA
  withdrawal of qualified status, and TS 119 602 withdrawal of a notification.
- **Generate deterministic negative fixtures** and compare, per version, what
  the defect catalogue expected to fail against what actually failed — both
  locally and at the Trust Inspector.

### Quick GUI guide

Open `/` for the public catalogue, `/onboarding` to submit a provider to a
compatible list, and `/admin` for authenticated review, publication, settings
and list creation. In the Catalogue's **Trusted List Family** column, an XML
list accepting both EAA and QEAA displays both family chips with a small gap.
The **Trusted List** column names the list as plain monospace text in its
family's colour, so only the family column carries a filled chip.
List pages use the list key as their title and show only tags beneath it: family
or accepted-profile tags, the ETSI standard and the artifact format. Version
pages use `<list-key> - Version <n>` and keep the same tags; XML histories run
from sequence 1 upward.

For a TS 119 612 XML list, choose **Create XML Trusted List** in administration.
The first **List** panel selects EAA, QEAA or both and asks for the Trusted List
Name and Scheme Territory. Enter the name without the country prefix; the
publisher writes `SchemeName` as `<SchemeTerritory>:<Trusted List Name>`. The
**Stable XML distribution URL** in the Scheme URIs panel is optional. Leaving it
blank publishes the deployed site's stable
`/lists/<list-key>/latest/trusted-list.xml` URL; enter a URL only when the XML is
distributed from a different public address.

### Intentionally broken fixtures

A broken list is a deliverable, not a failure mode. Each fixture is compiled
healthy, cloned, and mutated by exactly the defects that were selected:

```text
healthy typed model
  → healthy artifact
  → pre-signing mutations
  → signing (JAdES or XAdES)
  → post-signing mutations
  → final bytes
  → digest, or an intentionally wrong digest
  → immutable storage
  → local validation, recorded
  → Trust Inspector, recorded
```

A selected defect is never silently repaired: a mutation that found nothing to
change is stored as `applied: false` with the reason. **A failing Trust
Inspector verdict on such a list is the expected outcome, not a publication
error**, and every page that shows one says so.

The deterministic TS 119 612 suites are published at stable keys —
`eaa-healthy`, `eaa-broken-<defect-id>`, `eaa-broken-combined`, and the QEAA
equivalents — one healthy baseline, one list per defect, and one list carrying
exactly two compatible defects.

### Demonstration lists

Six ready-made TS 119 612 lists can be published into the local publication
store, so the Catalogue shows the EAA and QEAA families the way it already shows
the TS 119 602 ones:

```bash
npm run build
node scripts/generate-tsl612-demo-lists.mjs --dry-run   # list what it will do
node scripts/generate-tsl612-demo-lists.mjs             # publish
```

| List key | Family | State |
| --- | --- | --- |
| `it_eaa-demo-healthy` | EAA Providers | conformant |
| `it_eaa-demo-broken-expired-next-update` | EAA Providers | stale on the day it was issued |
| `it_eaa-demo-broken-broken-xades-signature` | EAA Providers | edited after signing; the signature does not verify |
| `it_qeaa-demo-healthy` | QEAA Providers | conformant |
| `it_qeaa-demo-broken-expired-next-update` | QEAA Providers | stale on the day it was issued |
| `it_qeaa-demo-broken-broken-xades-signature` | QEAA Providers | edited after signing; the signature does not verify |

The two defects fail in visibly different ways on purpose: one breaks the dates
and is caught by the Trust Inspector, the other breaks the cryptography and is
caught before it gets there. Re-running regenerates all six, so the script is
idempotent. It contacts the Trust Inspector only when `TLP_INSPECTOR_URL` is
set, because publishing a list to it uploads that list to a third party.

The equivalent generator for the TS 119 602 Pub-EAA family is
`scripts/generate-pub-eaa-fixtures.mjs`.

## Installation

### Requirements

From `mise.toml` and `package.json`:

- **Node.js 24** (`"engines": { "node": ">=24.0.0" }`)
- **npm 11.19.0**
- **Task 3.52.0** — optional; a thin wrapper over the npm scripts
- **OpenSSL** on `PATH` — used to generate signing material and fixture
  certificates. Without it those features report that they are unavailable
  rather than failing silently.

With [mise](https://mise.jdx.dev):

```bash
mise install
```

### Install and build

```bash
npm install
npm run build
node dist/src/cli/main.js --help
```

### Configuration

```bash
cp .env.example .env
```

**Required when the administration GUI is enabled**

| Variable | Meaning |
| --- | --- |
| `DATA_COLLECTION_GUI` | `true` enables onboarding and the administration backoffice. Default `false`. |
| `TLP_ADMIN_TOKEN` | Administrator token. Must not be empty when the GUI is on; the server refuses to start otherwise. **Secret.** |
| `TLP_SIGNING_CONFIG` | Path to the signing configuration, JSON or YAML. Maps list keys to key/certificate paths and scheme operator details. |

**Optional**

| Variable | Meaning |
| --- | --- |
| `ADMIN_USER`, `ADMIN_PASSWORD` | When **both** are set, `/admin` asks for a username and password instead of a token. **Secrets.** |
| `TLP_CERTIFICATES_DIR` | Root for key/certificate pairs generated from the administration UI. Without it, server-side generation is disabled and the form says so. |
| `TLP_INSPECTOR_URL` | Trust Inspector base URL. `serve` defaults to `https://trust-inspector.credimi.io`. Set it to an empty string to disable the integration, so no published artifact leaves the process. |
| `TLP_PUBLICATION_DIR` | Publication root. Default `./publications`. |
| `AUTHORING_DIR` | Mutable application records. Default `./authoring`. |
| `TLP_HOST`, `TLP_PORT` | Bind address and port. Defaults `127.0.0.1` and `8080`. |

**Development and fixture generation only**

| Variable | Meaning |
| --- | --- |
| `TLP_FIXTURE_KEY_DIR`, `TLP_FIXTURE_REPORT` | Signing material and report for `scripts/generate-pub-eaa-fixtures.mjs`. |
| `TLP_TSL_FIXTURE_DIR` | Where the TS 119 612 EAA and QEAA fixture suites are written. |
| `TLP_DEMO_KEY_DIR` | Signing material for the demonstration EAA/QEAA lists. |

**Secrets that must never be committed**: `.env`, `TLP_ADMIN_TOKEN`,
`ADMIN_PASSWORD`, and every private key and certificate. The root `.gitignore`
excludes `.env`, `*.pem`, `*.key`, `*.crt`, `*.p12`, `*.pfx` and the whole
`.local-signing/` tree.

### Directories

| Path | Access | Contents |
| --- | --- | --- |
| `.local-signing/` | read-write, **private** | Signing keys, certificates and the signing configuration that points at them. Never served. |
| `publications/` | read-write, immutable per version | Published artifacts. A stored version is never rewritten. |
| `authoring/` | read-write | Onboarding applications and administrator settings. Mutable by design. |
| `schemas/` | **read-only** | Pinned ETSI schemas, vendored byte-exact. |

The key and certificate files are **read-only inputs**: the publisher reads them
and never writes to them.

### Run

Development, with reload:

```bash
npm run dev:serve
```

Production:

```bash
npm run build
npm run serve
```

Both read `.env` when it exists. `serve` accepts the same settings as flags —
`--host`, `--port`, `--publication-dir`, `--data-collection-gui`,
`--inspector-url` — and a flag wins over the environment.

### Initial administrator access

There is no bootstrap user and no first-run wizard: access is whatever `.env`
declares.

- With `TLP_ADMIN_TOKEN` only — open `/admin?token=<TLP_ADMIN_TOKEN>` once; the
  token is then held in a cookie.
- With `ADMIN_USER` **and** `ADMIN_PASSWORD` also set — open `/admin` and sign
  in.

### Health check

```bash
curl -fsS http://127.0.0.1:8080/healthz
```

It returns `200` with a JSON body and touches no publication.

### Deployment

There is no Dockerfile in this repository. `deploy/Caddyfile.example` shows a
reverse-proxy configuration and `docs/DEPLOYMENT.md` documents an in-house
deployment. Run the built server behind a TLS-terminating proxy under a process
supervisor; it is a plain Node HTTP server with no clustering.

### Backups

In order of importance:

1. **`.local-signing/`** — the private keys and the signing configuration.
   Without them no existing list can ever publish another version.
2. **`publications/`** — the immutable published versions. They are the record;
   a lost version cannot be regenerated byte-for-byte.
3. **`authoring/`** and `.env` — applications, settings and configuration.

## Development

### Components

| Component | Responsibility |
| --- | --- |
| `src/web/server.ts` | HTTP server, routing, catalogue, administration, API |
| `src/web/views/` | Server-rendered HTML |
| `src/core/authoring/list-family-catalogue.ts` | The one catalogue of user-facing families |
| `src/core/profiles/` | TS 119 602 profile registry, one directory per annex |
| `src/core/compile/`, `src/core/model/` | TS 119 602 authoring model and compiler |
| `src/core/signing/`, `src/core/verification/` | JAdES signing and verification |
| `src/core/validate/` | JSON Schema and ETSI structural validation |
| `src/core/tsl612/registry.ts` | TS 119 612 service profiles: EAA and QEAA |
| `src/core/tsl612/compile.ts`, `read.ts` | XML `TrustServiceStatusList` writer and reader |
| `src/xmlsec/` | Self-contained enveloped XAdES-B-B signer and verifier |
| `src/core/tsl612/schema.ts`, `schemas/etsi/` | Offline validation against the pinned ETSI schemas |
| `src/core/tsl612/signing-certificate.ts` | The TLSO signing-certificate profile |
| `src/core/authoring/signing-config.ts` | Signing configuration for both standards |
| `src/core/authoring/application-service.ts` | TS 119 602 onboarding, review and publication |
| `src/core/tsl612/authoring/application-service.ts` | TS 119 612 onboarding, review and publication |
| `src/core/authoring/settings-store.ts` | Auto-approval settings |
| `src/core/publication/store.ts`, `tsl-store.ts` | The immutable publication stores |
| `src/core/publication/reader.ts` | One reader across both formats |
| `src/core/publication/manifest.ts`, `tsl-manifest.ts` | Per-version manifests |
| `src/core/inspector/inspector.ts` | Trust Inspector client and result normalization |
| `src/core/defects/` | The canonical defect catalogue and the fixture evidence document |
| `src/core/authoring/defects.ts` | JSON mutation engine |
| `src/core/tsl612/defects.ts` | XML mutation engine |
| `src/core/tsl612/fixture-suite.ts` | The deterministic EAA and QEAA fixture suites |
| `src/web/assets/openapi.yaml` | The published API description |
| `test/` | Acceptance and regression suites |

### Custom components

#### Custom JAdES for the TS 119 602 JSON artifacts

`src/core/signing/`, `src/core/verification/`. `jose` produces and verifies the
JWS; the JAdES Baseline B profile on top of it is this repository's. The
available JAdES libraries target the full ETSI TS 119 182-1 profile set, and
these annexes need a narrow one: `x5c` carrying the signer certificate, `typ:
"JAdES"`, and `iat` as the claimed signing time. **Implements** TS 119 182-1
Baseline B for a Compact detached signature. **Limitations**: Baseline B only —
no timestamps, no revocation values, no long-term validation. Tests:
`test/signing.test.ts`.

#### Custom XAdES-B-B and XMLDSig for TS 119 612 XML

`src/xmlsec/`, a self-contained package that knows nothing about Trusted Lists.
Written rather than adopted because the available Node XMLDSig libraries do not
produce an EN 319 132-1 Baseline B structure — `SignedProperties`,
`SigningCertificateV2`, `DataObjectFormat` — and adopting a large signature
framework to reach a profile this specific was the greater risk. **Implements**
XMLDSig with the enveloped-signature transform and exclusive canonicalisation,
and XAdES-B-B per TS 119 612 Annex B and EN 319 132-1. **Limitations**: one
signature per document, ECDSA and RSA with SHA-256, no counter-signatures, no
timestamps. Tests: `test/xmlsec-xades.test.ts`.

#### XML canonicalisation and reference handling

The enveloped transform is computed over the document that *already contains the
signature*: the transform removes `ds:Signature` and nothing else, so digesting
the document beforehand omits the whitespace the insertion adds and yields a
signature that verifies nowhere. The signature is therefore assembled three
times — to digest the document, to digest the signed properties in place, and to
sign — with each pass re-serializing and re-parsing, so every digest is one a
verifier can recompute from the published bytes alone.

#### Offline-pinned ETSI schemas

`schemas/etsi/`, with source URLs, retrieval dates and SHA-256 hashes recorded in
`STANDARDS.md`. Validation has to work with no network, and a schema fetched at
validation time is a schema that can change underneath you. A libxml2 input
provider answers the schemas' own absolute `schemaLocation` URLs from disk, so
the vendored bytes are never rewritten and their hashes stay checkable. Tests:
`test/tsl612-schema.test.ts`.

#### Signing-certificate profile checks

`src/core/tsl612/signing-certificate.ts` applies TS 119 612 clause 5.7 and
Annex B: subject `C` equal to the Scheme Territory, subject `O` equal to the
Scheme Operator Name, `basicConstraints CA:FALSE`, a SubjectKeyIdentifier, a key
usage limited to `digitalSignature` and/or `contentCommitment`, and an extended
key usage that permits TSL signing when one is present. **Limitation, and the
point of the module**: it asks whether a certificate is *shaped* like a Trusted
List signing certificate, not whether anyone trusts it. No path is built and no
revocation is checked. Tests: `test/tsl612-signing.test.ts`.

#### Immutable publication and manifest model

`src/core/publication/`. A version is staged, read back, re-hashed and only then
renamed into place, so a version that exists is one that was verified after it
was written. Re-storing byte-identical content succeeds; storing different
content for an existing sequence is refused. `manifest.json` describes the
published bytes. `inspector.json` and `fixture.json` sit deliberately *outside*
the integrity-checked set: they are evidence about a version and can be re-run,
while the published files never change. Tests: `test/publication.test.ts`,
`test/tsl612-publication.test.ts`.

#### Deterministic defect mutation pipeline

`src/core/defects/registry.ts` holds one catalogue for both standards. Each
defect states its intent once and binds it to a concrete mutation per standard,
with the stage it applies at, the clause it violates, what a conformant list does
instead, and what it is expected to fail — locally and at the Inspector. The UI,
the API, the stored metadata and the tests all read that one catalogue.
**Limitation**: the expected Inspector rule IDs are *expectations*, calibrated
against a live run and always recorded against actuals, never asserted. Tests:
`test/tsl612-defects.test.ts`, `test/broken-generation.test.ts`.

#### Trust Inspector normalization and fail-closed behaviour

`src/core/inspector/inspector.ts` submits the *signed* artifact — never a decoded
one, because half the requirements are signature requirements — and reduces the
response to a summary while storing the complete report. It reports `pass` only
when the Inspector actually applied the submitted standard **and** every check it
could decide locally held. A missing section, a standard reported
`not_applicable`, an unknown applicability and an empty check list are all
`unavailable`: no verdict was reached, and a standard that was not applied cannot
have been passed. **No unsupported conformance claim is made anywhere**: a
`pass` means "this Inspector found no applicable failure", not "this artifact
conforms".

### Other information for developers

#### Technology stack

TypeScript 5.8 on Node.js 24, ESM throughout. The web server is `node:http` with
no framework, and the HTML comes from plain template functions rather than a view
library. Runtime dependencies are deliberately few: `jose` (JOSE/JWS),
`libxml2-wasm` (offline XSD validation and Exclusive XML Canonicalisation), `ajv`
and `ajv-formats` (JSON Schema), `commander` (CLI) and `yaml`. Stoplight Elements
7.15.0 is vendored into `src/web/assets/` and served same-origin, so `/docs`
renders with no CDN.

#### Why two publication engines

TS 119 602 and TS 119 612 describe different documents. A LoTE is a JSON object
with a *detached* Compact JAdES beside it; a Trust Service Status List is an XML
document whose XAdES signature is *inside* it. Their element vocabularies,
presence rules, status vocabularies and integrity artifacts all differ. Merging
the engines would produce a compiler that constantly asks which standard it is
serving.

They are therefore parallel and share only what genuinely is shared. The
implementation began as TS 119 602 JSON/JAdES support for the five LoTE annexes;
TS 119 612 XML/XAdES national Trusted Lists were added afterwards for EAA and
QEAA. That is why the shared abstractions are where they are:

- `src/core/authoring/list-family-catalogue.ts` — every user-facing family with
  its standard, artifact format, statuses, onboarding route and lifecycle
  actions. Views read this instead of testing family names.
- `src/core/publication/reader.ts` — one reader in front of both stores, which
  decides a list's format from what is actually on disk.
- `src/core/defects/` — one defect catalogue and one evidence document for both
  formats.

#### Repository layout

```text
src/cli/          command-line entry point
src/core/         the engines: authoring, compiling, signing, publication
src/core/defects/ the canonical defect catalogue and fixture evidence
src/core/tsl612/  everything specific to TS 119 612 XML
src/web/          HTTP server, views, assets, OpenAPI
src/xmlsec/       standalone XAdES-B-B signer and verifier
schemas/etsi/     pinned ETSI schemas
scripts/          generators and explicit live verification runs
test/             offline test suites
examples/         example configuration and submissions
```

#### Configuration model

One signing-configuration file holds a single `lists:` array for both standards,
discriminated by `standard`. An entry with no `standard` field reads as
TS 119 602, so every configuration written before XML support loads unchanged.
Artifact locations are read from the environment with documented defaults and are
never hardcoded — see `directives/BARIO.md`.

#### Artifact lifecycle

A list is declared, its first version is published, and every later publication
appends an immutable version. A status change publishes sequence + 1 and moves
the previous state into history. For TS 119 612 that history is permanent,
ordinary republication preserves `StatusStartingTime`, and a superseded status is
always strictly earlier than the status that replaced it. Every XML version's
manifest also preserves the list's complete allowed-service-profile selection.

Each TS 119 612 version publishes:

```text
trusted-list.xml    the signed XML — the artifact
trusted-list.sha2   SHA-256 of the exact XML bytes, bare lowercase hex
manifest.json       format-aware manifest
inspector.json      Trust Inspector evidence, re-runnable
fixture.json        negative-fixture evidence, broken versions only
```

The first three are integrity-checked. XML is served as
`application/vnd.etsi.tsl+xml`, at immutable version URLs and at stable latest
URLs ending exactly in `trusted-list.xml` and `trusted-list.sha2`.

#### Commands

```bash
npm run format          # Prettier, writes
npm run format:check    # Prettier, checks
npm run lint            # tsc --noEmit, then the DESIGN.md linter
npm run build           # tsc, then copy the pinned XML schemas into dist/
npm test                # the whole offline suite; contacts no external service
npm run fixtures:generate   # generate both TS 119 612 fixture suites, offline
npm run fixtures:verify     # generate them and validate them live
```

`task build`, `task test`, `task lint`, `task format` and `task run` wrap the
same scripts.

#### Adding a new TS 119 602 family

1. Add a directory under `src/core/profiles/` with the annex's constants.
2. Register it in `src/core/profiles/registry.ts`.
3. Add it to `LIST_FAMILIES` in `list-family-catalogue.ts` with an onboarding
   route.
4. Extend the submission parser, the application model and the list assembler.
5. Add an acceptance test modelled on `test/annexh-pub-eaa.test.ts`.

#### Adding a new TS 119 612 service profile

1. Add the service type and status URIs to `src/core/tsl612/constants.ts`.
2. Add the profile to `TSL_PROFILE_REGISTRY` in `src/core/tsl612/registry.ts` —
   service type, initial and end status, lifecycle wording.
3. Add it to `LIST_FAMILIES` with an onboarding route.
4. Nothing in the compiler, signer, store or Inspector should need to change: a
   profile is data, not a code path.

#### Adding a new deterministic defect

1. Add it to `DEFECT_CATALOGUE` in `src/core/defects/registry.ts`, with one
   binding per standard that can express it. State the stage, the mutation, the
   clause, the conformant behaviour, and the expected local and Inspector
   failures.
2. Implement the mutation in `src/core/authoring/defects.ts` (JSON) and/or
   `src/core/tsl612/defects.ts` (XML), recording whether it applied.
3. Nothing else: the form, the API, the stored metadata, the fixture suite and
   the tests all read the catalogue.
4. Run `npm run fixtures:verify` and calibrate the expected Inspector rules
   against what actually fires. Leave the honest gaps in place.

#### Testing rules

- **Ordinary tests must not contact an external service.** Use a stub `fetch`,
  or no Inspector client at all. A server created without `inspectorBaseUrl` has
  no Inspector client, so no test can upload an artifact even by accident.
- A test that publishes uses a temporary directory.
- Assert the recorded evidence rather than the wording of a message, wherever
  the evidence exists.

#### Trust Inspector integration

The publisher submits the signed artifact inline to the Inspector's
`POST /api/audit/artifact`, as JSON, with the artifact in `content` and its media
type in `contentType` — `application/jose` for a Compact JAdES, and
`application/vnd.etsi.tsl+xml` for a signed XML Trusted List. Nothing is
uploaded by URL and nothing is multipart-encoded.

Calls are **automatic** at exactly one point: publishing a version, when
`TLP_INSPECTOR_URL` is configured. The complete response is stored as
`inspector.json` beside the version and the derived summary drives the version
page. There is no background re-evaluation.

An **explicit** live validation of the fixture suites is:

```bash
npm run build
npm run fixtures:verify                      # both TS 119 612 fixture suites
node scripts/verify-tsl612-acceptance.mjs    # the healthy TS 119 612 flow
```

Both fail closed. An Inspector that cannot be reached, or that returns a result
it did not actually assess, is an unsuccessful run.

Three Inspector answers are represented as `status: "unavailable"` with the
reason in `error`: the Inspector could not be reached; it reported the submitted
standard as `not_applicable` or of unknown applicability; or it ran no check at
all. **None of them may ever be presented as a pass** — a standard that was not
applied cannot have been passed, and an artifact that was never assessed has not
been found conformant. A fixture whose mutation prevents classification (the
invalid-namespace one does) therefore records `unavailable`, not `pass`, and its
`standardApplicability` and `artifactKind` are kept so a reader can see why.

#### Data migration and backward compatibility

- Signing-configuration entries with no `standard` field read as TS 119 602.
- Fixture metadata is at schema version 2; version 1 files are still read and
  are treated as TS 119 602 JSON with no local-failure axis.
- Manifests written before XML fixtures have no `trustedListSha2Published`; it
  is read as equal to `trustedListXmlSha256`.
- Published versions are never rewritten by any of the above.

#### Security considerations

- Private keys are read from local files and are **never** uploaded, echoed or
  rendered. The administration UI shows paths and fingerprints only.
- The admin token is compared in constant time, and enabling the GUI without one
  is refused at startup.
- Publication paths are validated against a strict key pattern, symlinks in a
  publication path are rejected, and reads are size-bounded.
- Publishing to the Trust Inspector **uploads the artifact to a third party**.
  That is why the integration is opt-in and off unless configured.
- Generated certificates are self-signed test material. Treat every artifact
  this tool produces as untrusted input.

#### Known limitations

- No PKIX path building, no revocation checking, no trust establishment.
- No LoTL aggregation; only the mandatory pointer to the EU LOTL.
- No EC TS02 notification API.
- One signature per XML document; no timestamps, no long-term validation.
- One locally decidable Annex H sub-rule (`pubEaaLawReferencePresent`) is not
  satisfied — `STANDARDS.md` records what was probed and why it is reported
  rather than hidden.
- Expected Inspector rule IDs drift as the Inspector changes. That is recorded
  per version as missing or additional failures rather than hidden.
- Two Inspector observations on healthy XML lists are understood and expected:
  `parse.schema_location` warns, and `ts119612.pointer.rollover` wants two key
  pairs with shifted validity — an operational property of key management, not
  something a generator produces.

#### Contribution and handoff

`directives/BARIO.md` governs how work is done here: Conventional Commits
carrying a `reason` and a `prompt`, formatting and linting before every commit,
no pushing, no secrets, no artifacts in the repository root, and a rolling
handoff under `./handoffs/` for every task. `CONTRIBUTING.md` and `AGENTS.md`
point at it. `DESIGN.md`, `STANDARDS.md` and `SPECS.md` carry the design
decisions, the standards provenance and the detailed specifications.

## Disclaimer

This project is **non-normative** and currently **Beta**.

No guarantee is given of standards conformance, legal validity, availability or
fitness for production use.

The Trusted Lists, certificates and signatures it generates are **test
fixtures**, unless explicitly replaced with properly governed production
material.

Trust Inspector results are **technical evidence — not accreditation and not
legal qualification**. A passing evaluation is one tool's opinion of one artifact
at one moment.

Users remain responsible for independent standards, security and legal review of
anything they do with this software.
