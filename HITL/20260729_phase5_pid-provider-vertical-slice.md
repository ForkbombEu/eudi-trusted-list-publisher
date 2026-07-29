# Phase 5 — Multi-profile foundation and PID Provider vertical slice

Continue work in `eudi-trusted-list-publisher`.

Phase 4 is complete: cumulative Wallet Provider publication, authenticated
highest-sequence loading, lossless round-trip preservation, per-list locking,
typed partial-commit reconciliation, cumulative preview, and the final
acceptance suites are implemented.

Start from the current `origin/main`. Do not assume a commit hash from this
prompt. Before changing anything, record:

```bash
git status --short
git branch --show-current
git rev-parse HEAD
git rev-parse origin/main
git log -5 --oneline
```

The working tree must be clean and local `HEAD` must match `origin/main`. Verify
that the Phase 4 acceptance test exists and that the complete baseline suite
passes. The expected accepted baseline was 328 tests; if the count differs,
explain the exact reason in the handoff before proceeding.

Read, in the order required by the repository:

- `AGENTS.md`;
- every file it requires under `directives/`;
- the newest relevant file under `handoffs/`;
- `STANDARDS.md`;
- `SPECS.md`;
- `DESIGN.md`.

Create the ignored rolling BARIO handoff near the start of the task, set it to
`in_progress`, and include this entire initiating prompt verbatim. Update it
throughout the work.

## Objective

Turn the Wallet-specific implementation into a real multi-profile publisher
and add **PID Providers** as the second complete end-to-end list family.

At completion:

- Wallet Provider behavior and fixed-input output remain unchanged;
- Wallet Providers and PID Providers are both enabled in the catalogue;
- a PID Provider can submit an application, be reviewed, approved, previewed
  and cumulatively published;
- each list key has one explicit family/profile that cannot silently change;
- compilation, conversion, cumulative assembly, validation, signing,
  publication and reconciliation select the correct profile explicitly;
- PID profile constants and constraints are traceable to normative ETSI
  evidence;
- every other family remains visibly disabled.

This is not a bulk implementation of every remaining profile.

## Explicit non-goals

Do not implement:

- non-qualified EAA Providers;
- QEAA Providers;
- WRPAC / Access CA Providers;
- WRPRC Providers;
- Registrars;
- TS 119 612 Trusted Service Lists;
- LoTL aggregation, LoTL joining or LoTL publication;
- EC TS02 notification or registration;
- key or certificate generation;
- empty-list bootstrap/setup;
- calls to `trust-inspector.credimi.io`;
- external trust-chain evaluation;
- database storage, new authentication, deployment or Docker work;
- XML, XMLDSig or XAdES;
- unrelated UI redesign or dependency upgrades.

Do not modify canonical files under `HITL/`.

Internal ETSI schema validation and signature authentication remain mandatory
publication safety boundaries. Do not present them as external trust-chain or
regulatory-conformance evaluation.

## 1. Establish normative PID profile evidence before coding

The existing Wallet Provider constants are not a template from which PID
values may be guessed.

Use ETSI TS 119 602 V1.1.1 and the project's vendored schemas as normative
sources. WE BUILD material may be used only as compatibility evidence; its
published detached JSON must not become a signing oracle.

Before production changes, add a compact PID Provider profile table to the
rolling handoff and then to `STANDARDS.md`, recording:

- exact ETSI clause or annex;
- LoTE type URI;
- status-determination URI;
- scheme type/community/rules URI;
- permitted and required service-type identifiers;
- required service-information extensions;
- whether `ServiceStatus`, `StatusStartingTime`,
  `HistoricalInformationPeriod` and service history are permitted or required;
- maximum `NextUpdate`, if the profile defines one;
- required signature serialization/profile;
- required identity material and service supply-point semantics;
- whether the profile permits an empty list.

For every item, distinguish:

- normative ETSI requirement;
- compatibility observation from WE BUILD;
- project-local authoring choice.

If the authoritative text is unavailable or two sources conflict on a value
needed for implementation, stop. Mark the handoff `needs_human_review`, quote
the conflicting citations compactly, and do not invent a URI or profile rule.

Do not copy large sections of the standard into the repository. Record only the
derived implementation facts and precise citations.

## 2. Introduce an explicit profile registry

Replace hard-coded Wallet-only compilation decisions with a small, typed,
immutable profile registry.

The registry must define, at minimum:

- family key;
- human label;
- enabled state;
- LoTE type;
- status-determination approach;
- scheme rules;
- allowed service types;
- profile validation function;
- conversion/round-trip policy where profile rules differ;
- maximum next-update interval where applicable.

Requirements:

- Wallet Providers and PID Providers are enabled.
- The other five catalogue families remain disabled with
  `Not implemented yet`.
- There is one authoritative mapping; do not maintain separate profile tables
  in the compiler, views, service and signing configuration.
- Registry lookups fail explicitly for unknown or disabled profiles.
- Registry objects are immutable.
- No mutable global state or implicit environment lookup enters the core.
- Profile selection is explicit at every compile/publish boundary.

Preserve the existing public `compile(input)` function as a backwards-compatible
Wallet Provider wrapper if it is already part of the package API. Add a clearly
named profile-aware API rather than silently changing existing callers. New
application/publication code must use the profile-aware API.

Add public exports through the existing core barrels without exporting web,
filesystem or environment concerns.

## 3. Prove Wallet Provider compatibility before adding PID behavior

Create a fixed-clock, fixed-sequence Wallet Provider fixture that covers:

- multiple names and trade names;
- complete postal addresses;
- multiple electronic/information addresses;
- multiple certificates;
- issuance and revocation services;
- multiple supply points.

Compile it through:

1. the pre-Phase-5 compatibility entry point;
2. the new explicit Wallet profile entry point.

Assert complete deep equality of the resulting ETSI documents. Where a stable
serialized fixture already exists, assert byte equality as well.

All existing Phase 4 round-trip, cumulative, concurrency, failure and
reconciliation tests must remain unchanged and green. Do not weaken, rename or
replace them to accommodate the new architecture.

## 4. Add a typed PID Provider application

Refactor the application domain into an explicit discriminated union:

```ts
type TrustedEntityApplication =
  | WalletProviderApplication
  | PIDProviderApplication;
```

The exact `PIDProviderApplicantData` and service fields must follow the
normative findings from Section 1. Do not reuse Wallet-specific
`issuance | revocation` fields if the PID profile defines different service
semantics.

Requirements:

- `family` is the discriminant and is persisted.
- Existing schema-version-1 Wallet application files remain readable.
- Do not silently reinterpret or rewrite existing stored Wallet applications.
- New malformed or unknown application variants fail with field-specific
  validation errors.
- Application lifecycle rules remain shared where they are genuinely common.
- Family-specific input validation is delegated through the profile/application
  definition, not spread through route conditionals.
- Server-controlled scheme/operator metadata remains outside applicant control.
- PEM certificate contents are validated using the existing certificate
  boundary before approval/publication.
- Required identifiers are normalized and checked according to the PID profile,
  without weakening Wallet identifier uniqueness.

If persistence needs a schema-version increment, implement an explicit
read-compatible migration boundary and test both versions. Do not perform
opportunistic on-disk rewrites during GET requests.

## 5. Make cumulative publication profile-aware

Generalize `ApplicationService`, list assembly and conversion so the profile is
derived from trusted list-key configuration and checked against the
application family.

The following invariants are mandatory:

1. Every configured list key declares exactly one family.
2. An application may publish only to a list key of the same family.
3. Once a list key has a stored sequence, its authenticated LoTE type must
   match the configured family.
4. A list key cannot change family because configuration changed.
5. Highest physically stored sequence remains the fail-closed source.
6. Existing authenticated entities must survive the complete semantic
   round-trip for their own profile.
7. The first unrepresentable field path rejects preview and publication before
   signing or filesystem writes.
8. Sequence and membership remain independent per list key.
9. Same-key operations remain serialized; different keys may progress
   independently.
10. Immutable-commit/mutable-save partial failure remains typed and
    reconcilable without another version.

Do not duplicate the Phase 4 assembly algorithm for PID. Use one shared
algorithm parameterized by the selected profile.

Do not introduce a default profile when reading a configured list key. Missing
or mismatched family data is a configuration error.

## 6. Extend signing configuration safely

Make `family` authoritative for every signing configuration entry.

Validate on load:

- known and enabled family;
- unique list key;
- required key and certificate paths;
- family/profile consistency;
- distribution point and scheme metadata required by that family.

Never return, render or log private-key contents.

Backward compatibility:

- Existing valid Wallet configuration already declares
  `family: "wallet-providers"` and must continue to work unchanged.
- Do not guess the family from a display name, LoTE name, list-key name or
  distribution-point URI.
- A missing `family` is an explicit configuration error; do not add a legacy
  default.

Update `signing-config.example.json` with separate non-secret Wallet and PID
entries using placeholder paths and distinct list keys.

## 7. Add the PID onboarding and administration flow

When `DATA_COLLECTION_GUI=true`, implement:

- `GET /onboarding/pid-provider`;
- `POST /onboarding/pid-provider`;
- the existing submission confirmation route;
- shared admin list/detail/approve/reject/delete behavior for PID applications;
- PID cumulative preview;
- PID publication;
- PID partial-commit reconciliation.

Requirements:

- The catalogue shows Wallet Providers and PID Providers as enabled.
- The other five families remain disabled and have no accepted POST route.
- Forms show only applicant-controlled fields.
- Profile constants, scheme metadata, list key and signing paths cannot be
  overridden by hidden form fields.
- Unknown fields are rejected rather than silently discarded.
- Validation errors are field-specific, escaped and preserve safe entered
  values.
- CSRF/admin-token behavior must remain at least as strict as the existing
  Wallet flow.
- Query strings and admin tokens must not appear in logs.
- Read-only mode remains byte-for-byte non-mutating and exposes no POST routes.
- All pages use the existing shell and unchanged canonical runtime assets.

HTML form routes remain outside OpenAPI unless the repository already models
HTML forms there. Do not invent JSON APIs merely for symmetry.

## 8. Required end-to-end positive tests

Use real core/service/server paths, fixed clocks and independent fixtures.

Add tests proving:

1. PID profile constants exactly match the normative table.
2. A rich PID authoring input compiles to an ETSI-schema-valid document.
3. The compiled PID document uses the exact PID LoTE/profile/service URIs.
4. Compact JAdES signing and authenticated verification succeed for PID.
5. A real HTTP PID submission creates a typed persisted PID application.
6. Admin approve and actual detail-page preview report:
   - existing entity count;
   - resulting entity count;
   - current sequence;
   - proposed sequence.
7. Two PID applications publish cumulatively at sequences 1 and 2.
8. Sequence 2 preserves the complete first PID entity by deep equality and
   appends the second in exact order.
9. Wallet and PID applications publish independently to distinct list keys.
10. Blocking one family/list key does not block the other.
11. Identical identifiers are allowed across distinct list keys where each
    profile permits them.
12. Typed post-commit reconciliation works for PID and creates no extra
    immutable version.
13. The existing Wallet compatibility fixture is completely unchanged.

Do not satisfy HTTP requirements by calling view functions directly.

## 9. Required negative and adversarial tests

Use precise errors and prove no unintended immutable version is created.

Add tests for:

- PID application targeting a Wallet list key;
- Wallet application targeting a PID list key;
- configured family disagreeing with the highest authenticated LoTE type;
- missing family in newly written signing configuration;
- unknown family;
- disabled family;
- PID service type not allowed by the profile;
- missing PID-required field or extension;
- Wallet-only service type used in PID input;
- PID-only service type used in Wallet input;
- invalid/expired certificate behavior through the existing policy;
- duplicate PID identifiers within a candidate;
- conflict with an identifier in an existing PID entity;
- corrupt highest PID sequence;
- lossy PID entity conversion, with the first differing path;
- injected PID pre-commit store failure;
- injected PID post-commit application-save failure;
- PID reconciliation mismatch;
- disabled-family form POST;
- attacker-supplied family/list/profile metadata in form data;
- read-only mode receiving every new mutable route.

For every rejected preview or publication:

- assert the intended field-specific or configuration-specific reason;
- assert no signing/store call occurred where rejection is pre-signing;
- assert previous publication bytes and index remain identical;
- assert no new sequence exists.

## 10. Documentation

Update `README.md`, `DESIGN.md`, `SPECS.md`, `STANDARDS.md`,
`.env.example` and example signing configuration where relevant.

Document:

- the profile registry and explicit selection boundary;
- enabled Wallet and PID families;
- the five still-disabled families;
- PID onboarding/admin workflow;
- per-list family immutability;
- cumulative semantics for both enabled profiles;
- internal schema/signature safety versus external trust/conformance
  evaluation;
- compatibility of existing explicit Wallet configuration;
- every new route and configuration field;
- the process-local lock limitation.

Do not claim implementation of LoTL, TS 119 612, EC TS02, Trust Inspector
integration, certificate issuance or regulatory trust assessment.

## 11. Implementation and repair loop

Work in explicit stages without committing:

### Stage A — Baseline and normative gate

Run the current full suite and record the exact count. Complete the normative
PID table. Stop on unresolved normative ambiguity.

### Stage B — Profile foundation

Add failing Wallet-compatibility and profile-registry tests first. Implement
the registry and profile-aware compiler. Rerun all affected existing tests.

### Stage C — PID core and persistence

Add failing PID compile/application/store tests first. Implement the typed PID
model, persistence and signing configuration changes. Rerun the complete
focused set.

### Stage D — GUI and service integration

Add failing real-HTTP and cumulative-publication tests first. Implement routes,
views and service wiring. Rerun the complete focused set.

### Stage E — Adversarial matrix

Add the complete negative suite. Build a requirement matrix containing:

- requirement;
- normative/project source;
- production location;
- focused test;
- HTTP/end-to-end test;
- negative/adversarial test;
- result.

Reject matrix rows supported only by a test name, comment, helper-only test or
selected-field assertion.

### Stage F — Stability

Run deterministic same-key/different-key concurrency tests for 20 iterations.
Then run the complete repository suite three consecutive times. If any run
fails, identify and repair the cause, rerun the complete focused set, and
restart the three-run sequence from run 1.

Do not commit until every required test passes together.

## 12. Sequential final validation

Run sequentially:

```bash
npm ci
npm run format
npm run format:check
npm run build
npm run lint
npm test
npm test
npm test
git diff --check
```

Use a writable isolated npm cache if the environment cannot write its default
cache. Record that as an environment workaround, not a repository defect.

Run `./run.sh`, verify `/healthz` returns HTTP 200, exercise one real PID
onboarding/admin preview flow, and stop the server cleanly.

Inspect the complete diff. Confirm:

- canonical HITL assets are untouched;
- no private keys, certificates, `.env`, signing configuration, runtime
  applications or publications are staged;
- no `node_modules/`, `dist/`, logs, caches or handoffs are staged;
- the working implementation contains no guessed profile constants.

## 13. Handoff

Complete the ignored rolling BARIO handoff before the final response.

It must contain:

- this initiating prompt verbatim;
- baseline and final commits;
- normative PID profile table with citations;
- scope and explicit non-goals;
- architecture decisions and compatibility decisions;
- requirement matrix;
- every changed file grouped by purpose;
- exact fixtures and event sequences;
- chronological failures and repairs;
- focused and full-suite counts/results;
- format, build, lint, diff and smoke results;
- anything incomplete or requiring human review;
- final Git state and push evidence.

Prove it is ignored:

```bash
git check-ignore -v <handoff-path>
```

If nothing remains incomplete, state exactly:

```text
Nothing from the initiating prompt was intentionally left out.
```

Do not mark the handoff complete while listing unmet requirements.

## 14. Commit and push

Only after all acceptance requirements pass:

1. update `README.md` as required by BARIO;
2. run the repository-defined formatter and `task lint` if the declared
   toolchain is available;
3. stage only intended source, test, schema/config-example and documentation
   files;
4. inspect the staged diff for secrets and generated material;
5. create one Conventional Commit with the BARIO-required `reason:` and
   `prompt:` body;
6. push normally to `origin/main`;
7. never force-push or rewrite history;
8. fetch `origin/main`;
9. prove local and remote hashes match.

Finish with:

```bash
git status --short
git log -3 --oneline
git rev-parse HEAD
git rev-parse origin/main
```

Do not claim completion unless:

- normative PID values are evidenced rather than inferred;
- Wallet fixed-input behavior is unchanged;
- both Wallet and PID flows work end-to-end;
- all negative requirements assert precise reasons and immutability;
- three complete suite runs pass consecutively;
- the handoff contains this full prompt and is ignored;
- the working tree is clean;
- local `HEAD` equals `origin/main`.
