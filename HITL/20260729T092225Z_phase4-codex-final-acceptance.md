# Phase 4 Codex final acceptance repair

Status: `complete`

## Initiating prompt (verbatim)

Finish the remaining Phase 4 acceptance work in `eudi-trusted-list-publisher`.

Start from:

`4a6ffbdd20b25d1eaf02e78a9b536290c95e4705`

The existing semantic round-trip losslessness implementation successfully rejects an authenticated `TEInformationExtensions` fixture. Preserve it unless new tests expose a production defect.

Do not begin Phase 5, change profiles, weaken existing tests, rename shallow tests as acceptance evidence, or perform unrelated refactoring.

## 1. Correct the public partial-commit type

Export:

```ts
export type PublishApplicationResult =
  | ServiceResult<WalletProviderApplication>
  | PartialCommitResult;
```

Use `Promise<PublishApplicationResult>` as the return type of:

- `publishApplication()`;
- `doPublish()`.

Export both result types through the authoring and core barrels.

Add a compile-time consumer test proving this works without `as any`:

```ts
const result = await service.publishApplication(id);

if (!result.success && "code" in result) {
  const code: "PUBLICATION_COMMITTED_APPLICATION_STALE" = result.code;
  expect(code).toBe("PUBLICATION_COMMITTED_APPLICATION_STALE");
  expect(result.publication.sequenceNumber).toBe(1);
}
```

The current code fails this check because `result.code` narrows to `unknown`.

The runtime test must also compare every structured hash and timestamp with the authenticated stored publication and prove reconciliation creates no new version.

## 2. Replace LOCK-1 with the actual controlled race

Use a controlled `PublicationStore` subclass whose `store()` method can block before calling `super.store()`.

Required deterministic sequence:

1. Start A and block it before immutable commit.
2. Start B; prove B has not entered `store()`.
3. Release and complete A.
4. Allow B to enter `store()` and block it.
5. Start C only after A completes while B remains blocked.
6. Prove C has not entered `store()` and sequence 3 does not exist.
7. Release B.
8. Complete B and C.
9. Assert sequences exactly `1`, `2`, `3`.
10. Assert entity counts exactly `1`, `2`, `3`.
11. Assert final entity order exactly A, B, C.

Use deferred promises/events. No arbitrary sleeps.

Run the scenario for 20 iterations.

## 3. Replace LOCK-2 with a real failed middle store operation

Required deterministic sequence:

1. Publish A at sequence 1.
2. Start B and block it inside controlled `store()`.
3. Start C and prove it remains queued.
4. Reject B’s store operation before `super.store()`.
5. Assert B fails, remains approved and creates no sequence 2.
6. Assert C enters only after B settles.
7. Complete C at sequence 2.
8. Assert the final list contains exactly A and C.
9. Capture `unhandledRejection` and assert none occurred.

Run for 20 iterations.

Retain a different-list test that blocks list 1 and proves list 2 completes independently.

## 4. Replace FAILURE-1 with an actual injected pre-commit failure

The current test is not an FsOps/store failure. It uses a duplicate identifier.

Start with healthy sequence 1 and snapshot byte-for-byte:

- `lote.json`;
- `lote.jades`;
- `manifest.json`;
- `index.json`.

Inject a failure from `PublicationStore.store()` before immutable commit while publishing B.

Assert:

- B fails and remains approved;
- no sequence 2 directory or index entry exists;
- every sequence-1 and index byte remains identical;
- after removing the failure, C publishes at sequence 2;
- the list lock was released.

Do not use duplicate detection or another preparation error.

## 5. Add the authenticated unsupported-field matrix

Create a reusable helper that:

1. compiles a valid sequence-1 document;
2. injects one schema-valid unsupported structure;
3. validates the modified ETSI document successfully;
4. signs it;
5. stores and authenticates it;
6. snapshots all publication bytes.

Run it independently for:

- `ServiceStatus`;
- `StatusStartingTime`;
- non-empty `ServiceHistory`;
- `X509SubjectNames`;
- `X509SKIs`;
- `PublicKeyValues`;
- `OtherIds`;
- certificate `encoding`;
- certificate `specRef`;
- `SchemeServiceDefinitionURI`;
- `ServiceDefinitionURI`;
- supply-point `ServiceType`;
- unsupported `ServiceInformationExtensions` entry;
- `TEInformationExtensions`;
- multiple unsupported entity-extension entries.

For every case:

- ETSI validation and authentication must succeed before preview;
- preview must reject the intended field path;
- publication must reject the same field path;
- no sequence 2 may exist;
- all sequence-1 and index bytes must remain identical.

A schema, signature, manifest or authentication failure does not count.

## 6. Add the real HTTP preview test

Use the actual server and authenticated admin route:

1. publish A;
2. create and approve B;
3. request B’s application-detail page;
4. assert HTTP 200;
5. assert the rendered response contains:

```text
Existing Entities
1
Resulting Entities
2
Current Sequence
1
Proposed Sequence
2
```

Do not call only the view function.

## 7. Complete the independent suites

Replace the misleading partial suite names.

The alternate-positive suite must use different fixtures, list keys, clocks and identifiers and prove:

- four cumulative publications with exact sequence and order;
- complete rich-entity deep equality across publication;
- controlled three-publication serialization;
- independent different-list progress;
- identical identifiers allowed across list keys;
- identical names allowed with different identifiers;
- alternate fixed-clock preview compilation deeply equals the stored document;
- typed partial-commit reconciliation creates no additional version.

The negative suite must use different parameters and prove:

- controlled three-way lock interleaving;
- failed middle store operation;
- every unsupported-field case;
- duplicate within one candidate;
- conflict with an existing entity’s second service;
- partial reconciliation mismatch;
- identifiers split across entities;
- corrupt highest sequence;
- injected pre-commit failure;
- post-commit application-save failure;
- no new version after every rejection.

Assert precise failure reasons.

## 8. Update documentation

Update `README.md`, `DESIGN.md`, `SPECS.md` and example configuration where relevant.

Document:

- cumulative membership per list key;
- highest physically stored sequence as the fail-closed source;
- semantic round-trip preservation or rejection;
- process-local locking and its single-process limitation;
- identifier uniqueness scope;
- typed partial-commit reconciliation;
- cumulative preview metadata;
- Wallet Providers as the only implemented family.

Do not modify HITL assets.

## 9. Mandatory loop

Before committing:

1. Add failing focused tests.
2. Run the focused set.
3. Repair production or fixtures based on the exact failure.
4. Rerun the entire focused set after every change.
5. Run LOCK-1 and LOCK-2 for 20 iterations.
6. Run the complete suite three consecutive times.
7. If any run fails, fix the cause and restart the three-run sequence from run 1.

Do not accept a test merely because its name contains a requirement ID.

## 10. Final validation

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

Run `./run.sh`, verify `/healthz` returns HTTP 200, then stop it cleanly.

## 11. Replace the handoff

Write a new ignored BARIO handoff containing this entire prompt verbatim. No ellipsis or conversation reference.

Include:

- baseline and final commits;
- requirement-to-production-and-test matrix;
- every fixture and controlled event sequence;
- every failure and repair chronologically;
- all three full-suite results and counts;
- build, format, lint, smoke and diff-check results;
- anything left incomplete;
- final Git and push evidence.

If nothing remains incomplete, state exactly:

```text
Nothing from the initiating prompt was intentionally left out.
```

Do not mark the handoff complete while listing omissions.

## 12. Commit and push

Only after every requirement passes:

1. create one Conventional Commit above `4a6ffbdd`;
2. push normally to `origin/main`;
3. fetch the remote;
4. prove local and remote hashes match.

Finish with:

```bash
git status --short
git log -3 --oneline
git rev-parse HEAD
git rev-parse origin/main
```

Do not claim completion unless the tree is clean, every required runtime test exists, three complete suite runs pass consecutively, the handoff contains this full prompt, and both hashes match.

## Material follow-up instruction

The user explicitly passed this repair from DeepSeek to Codex on 2026-07-29. The uploaded
`credimi-conformance-source-of-truth-v1.1.zip` was confirmed to be unrelated and must not
be modified. Work from the clean Git checkout of
`ForkbombEu/eudi-trusted-list-publisher` at `4a6ffbdd20b25d1eaf02e78a9b536290c95e4705`.

The user later supplied `eudi-trusted-list-publisher-main (1).zip`, identified by its
GitHub archive comment as snapshot `49c06bb54277b9f85196051bbf5932efba2068bc`,
and explicitly instructed Codex to use the uploaded snapshot locally without GitHub.
The snapshot and the completed Codex tree were byte-identical outside the nine intended
Phase 4 paths. Local ZIP delivery therefore supersedes the earlier remote-push requirement.

## Objective, scope, and outcome

- Closed only the remaining Phase 4 acceptance gaps from baseline
  `4a6ffbdd20b25d1eaf02e78a9b536290c95e4705`.
- Preserved the existing keyed-lock and semantic round-trip implementations because
  controlled runtime tests found no remaining production defect in either.
- Corrected the public TypeScript publication-result contract.
- Replaced labels masquerading as acceptance evidence with deterministic public-runtime
  tests, authenticated fixtures, independent positive/adversarial suites, and an HTTP test.
- Did not begin Phase 5, add another profile, modify `HITL/`, or modify the unrelated
  `credimi-conformance-source-of-truth-v1.1.zip`.

Status: `complete`

## Baseline and final commit

- Baseline: `4a6ffbdd20b25d1eaf02e78a9b536290c95e4705`
- Final local commit: `34e56c53347f3a4ebe70115182439cee5aa7cd84`
- Target branch: `origin/main`

## Requirement matrix

| Requirement | Production location | Primary evidence | Alternate-positive evidence | Negative/adversarial evidence | Result |
| --- | --- | --- | --- | --- | --- |
| Public typed partial commit | `src/core/authoring/application-service.ts`; authoring/core barrels | `exposes a typed partial-commit result and reconciles exact metadata` narrows without `as any`, verifies hashes/timestamp, authenticates storage, and reconciles without another version | `reconciles a second typed partial commit without creating a version` | `returns and reconciles a second post-commit application-save failure` checks the stable exact error and stale approved state | Pass |
| LOCK-1 three-operation race | Existing `ApplicationService.withListLock()` conditional-tail cleanup | `LOCK-1 runs the A-cleanup/B-blocked/C-arrives race 20 times` controls A and B store gates, then proves exact 1/2/3 counts/order | `serializes a different controlled three-publication queue` | `repeats the controlled A-cleanup/B-blocked/C-arrives interleaving with adversarial fixtures` | Pass |
| LOCK-2 failed middle releases queue | Existing `ApplicationService.withListLock()` rejection continuation | — | — | `LOCK-2 fails a blocked middle store operation and runs C next (20 iterations)` injects before `super.store()`, proves A/C only and no unhandled rejection | Pass |
| Different lists stay concurrent | Existing per-list promise tails in `ApplicationService` | `different lists progress independently while one store call is blocked` | `lets a different alternate list finish while the first list is blocked` | Uses distinct blocked/free list keys and exact physical-version assertions | Pass |
| Genuine pre-commit failure semantics | Existing immutable `PublicationStore.store()` boundary plus list lock | `FAILURE-1 injects a pre-commit store failure and releases the lock` snapshots all four artifacts and publishes C at sequence 2 | — | `injects a second pre-commit store failure without changing the existing publication` uses different operator, clock, identifiers and failure text | Pass |
| Authoritative losslessness boundary | Existing `loadLatestPublication()` plus `checkLosslessPreservation()` in `src/core/authoring/list-assembler.ts` | `LOSSLESS-POS-1 preserves the complete authenticated rich entity` uses whole-object equality | Alternate rich Swedish/English entity remains whole-object equal through sequence 4 | Fifteen independently signed, ETSI-valid and authenticated unsupported structures reject at their intended path with byte-identical sequence 1 | Pass |
| `StateOrProvince` regression | Existing authoring model/compiler/converter mapping | Primary rich entity contains `Capital Region` and survives whole-object equality | Alternate entity contains `Skåne` and `Skåne County` in two addresses | Unsupported-field preparation tests ensure rejection occurs after authenticated sequence loading, not schema/signature failure | Pass |
| Identifier uniqueness scope | Existing `checkServiceIdentifierUniqueness()` | Candidate duplicate and existing second-service conflict use public `publishApplication()` and exact identifier errors | Same identifier across two list keys and same display name with distinct identifiers both publish | Duplicate candidate, conflict with existing second service, partial and cross-entity reconciliation all assert exact reasons and unchanged version counts | Pass |
| Corrupt highest sequence | Existing `getHighestStoredSequence()` and authenticated `loadVersionArtifacts()` | — | — | `fails closed on a corrupt highest sequence and preserves the healthy version` rejects preview/publish, creates no sequence 3, preserves sequence 1 bytes, and leaves index at `[1]` | Pass |
| Preview/stored equality | Existing shared `preparePublishInput()`/compiler path | Existing regression coverage retained | `alternate fixed-clock preview deep-equals the stored publication` uses `2026-09-02T17:25:30.000Z` | Lossy authenticated preview cases return the same field-specific error as publication | Pass |
| Real rendered admin preview | Existing `createWebServer()` authenticated admin route | `renders cumulative counts and sequences through the authenticated HTTP route` asserts HTTP 200 and all four rendered table cells | Uses a dedicated `Rendered Preview Authority` list and authenticated session cookie | Route is exercised with a published A and approved B; this is not a direct view-helper test | Pass |
| Independent positive suite | Existing public service/compiler/store APIs | Primary rich/lock/partial tests | Eight alternate behaviors use different authorities, list keys, clocks, identifiers, 3 services, 2 addresses, and sequence progression through 4 | — | Pass |
| Independent adversarial suite | Existing public service/authentication/store APIs | Primary boundary tests retained | — | Includes controlled three-way race, failed middle store, all unsupported fields, duplicate cases, reconciliation mismatches, corrupt highest, second pre/post-commit failures, and no-version assertions | Pass |
| Documentation and scope | `README.md`, `DESIGN.md`, `SPECS.md` | Documents cumulative membership, fail-closed highest sequence, round-trip preservation, lock limitation, uniqueness, typed reconciliation, preview, Wallet Providers only | Existing `signing-config.example.json` already matches Wallet Provider/list-key semantics, so no irrelevant edit was made | `HITL/` stayed byte-untouched | Pass |
| Stability, smoke, and Git hygiene | Repository scripts and ignored handoff | Focused final set 131/131 | Complete suite 328/328 three consecutive times | Real `./run.sh` returned `/healthz` HTTP 200; `git diff --check` passed | Pass |

## Production changes

1. Added exported `PublishApplicationResult` as the union of
   `ServiceResult<WalletProviderApplication>` and `PartialCommitResult`.
2. Changed both `publishApplication()` and `doPublish()` to return
   `Promise<PublishApplicationResult>`.
3. Exported `PublishApplicationResult` and `PartialCommitResult` through
   `src/core/authoring/index.ts` and `src/core/index.ts`.
4. Kept the existing conditional-tail list lock. The real A/B/C test proves why the
   conditional identity check matters: after A releases its own deferred tail, B may already
   have installed the next tail; A must delete only its own tail, never B's.
5. Kept the existing semantic round-trip check. Every authenticated entity is converted,
   recompiled, and deeply compared. The first differing complete-field path rejects
   preparation before signing or immutable writes.

## Files changed

- `src/core/authoring/application-service.ts`
- `src/core/authoring/index.ts`
- `src/core/index.ts`
- `test/phase4-final-acceptance.test.ts`
- `test/regression.test.ts`
- `README.md`
- `DESIGN.md`
- `SPECS.md`

This handoff is ignored operational state and is not part of the commit.

## New primary tests

1. `exposes a typed partial-commit result and reconciles exact metadata`
2. `LOCK-1 runs the A-cleanup/B-blocked/C-arrives race 20 times`
3. `LOSSLESS-POS-1 preserves the complete authenticated rich entity`
4. `FAILURE-1 injects a pre-commit store failure and releases the lock`
5. `renders cumulative counts and sequences through the authenticated HTTP route`

## New alternate-positive tests

1. `preserves a different rich entity and progresses to four cumulative entities`
2. `serializes a different controlled three-publication queue`
3. `lets a different alternate list finish while the first list is blocked`
4. `allows one identifier across list keys and one display name within a list`
5. `alternate fixed-clock preview deep-equals the stored publication`
6. `reconciles a second typed partial commit without creating a version`

## New negative/adversarial tests

1. `LOCK-2 fails a blocked middle store operation and runs C next (20 iterations)`
2. `different lists progress independently while one store call is blocked`
3. `repeats the controlled A-cleanup/B-blocked/C-arrives interleaving with adversarial fixtures`
4. `injects a second pre-commit store failure without changing the existing publication`
5. `returns and reconciles a second post-commit application-save failure`
6. Fifteen parameterized `rejects authenticated unsupported field` cases
7. `rejects duplicate candidate identifiers with the exact identifier`
8. `rejects a conflict with an existing entity's second service without writes`
9. `rejects partial and cross-entity reconciliation matches precisely`
10. `fails closed on a corrupt highest sequence and preserves the healthy version`

## Authenticated unsupported-field fixtures

Each case starts from a compiled sequence-1 LoTE, mutates exactly one schema-valid
structure, passes `validateEtsiStruct()`, is signed, stored, and re-authenticated with
`loadVersionArtifacts()` before preview:

1. `ServiceStatus`
2. `StatusStartingTime`
3. non-empty `ServiceHistory`
4. `X509SubjectNames`
5. `X509SKIs`
6. `PublicKeyValues`
7. `OtherIds`
8. certificate `encoding`
9. certificate `specRef`
10. `SchemeServiceDefinitionURI`
11. `ServiceDefinitionURI`
12. supply-point `ServiceType`
13. extra `ServiceInformationExtensions` key
14. `TEInformationExtensions`
15. multiple `TEInformationExtensions`

Every case independently asserts valid ETSI structure, successful authentication,
matching field-specific preview/publication failures, no sequence 2, and byte equality for
`lote.json`, `lote.jades`, `manifest.json`, and `index.json`.

## Fixture independence

- Primary rich fixture: `Rich Primary Authority`; English/Danish names; one complete
  Capital Region address; two electronic addresses; two information URIs; two services;
  certificate counts 2 and 1; supply-point counts 2 and 1.
- Alternate rich fixture: `Alternate Rich Authority`; English/Swedish names; two Malmö
  addresses with `Skåne` and `Skåne County`; three services; certificate counts 1, 2 and 1;
  supply-point counts 1, 2 and 0; initial issue clock
  `2026-08-05T06:30:00.000Z`; cumulative clocks differ for sequences 2–4.
- Primary queue URLs use `https://lock-primary.example.test/{a,b,c}/{iteration}`.
- Failed-middle URLs use `https://failed-middle.example.test/{a,b,c}/{iteration}`.
- Alternate queue uses `delta`, `epsilon`, and `zeta` under
  `https://alternate-queue.example.test/`.
- Adversarial three-way uses `north`, `middle`, and `south` and clocks beginning
  `2026-12-01T10:00:00.000Z`.
- Alternate independent lists are `eu_alternate_independent_north` and
  `eu_alternate_independent_south`.
- Alternate preview clock is `2026-09-02T17:25:30.000Z`.
- Primary and alternate partial-commit authorities, identifiers, clocks and injected
  application-save errors are distinct.

## Original three-operation lock race and final solution

The original risk was unconditional lock-map cleanup. A installs tail A, B queues behind it
and installs tail B, then A completes. If A unconditionally deletes the list-key entry,
C arriving while B is blocked sees no tail and can start concurrently with B. The final
implementation retains each operation's own `tail` promise and deletes the map entry only
when `listLocks.get(listKey) === tail`. Rejections release the deferred tail in `finally`,
and the next operation ignores only the predecessor's rejection before running.

The controlled test proves the dangerous instant directly: A is blocked inside
`PublicationStore.store()`, B queues; A completes; B enters and is blocked; only then C
starts. C has not entered the store and sequence 3 does not exist until B is released.
LOCK-1 repeats this 20 times. LOCK-2 repeats a pre-commit B failure 20 times and proves C
then publishes A+C at sequence 2 without an unhandled rejection. No test uses sleeps.

## Lossless-conversion defects and final boundary

The earlier converter copied `StateOrProvince` only into an intermediate object and the
compiler omitted it. It also ignored valid ETSI structures such as service-definition URIs,
entity extensions, public-key values, and other IDs. That allowed a later cumulative
publication to authenticate sequence 1 and silently remove fields in sequence 2.

The final implementation represents `StateOrProvince` end-to-end. For every existing
authenticated entity it now converts and recompiles the complete entity, deeply compares
the entire result, and reports the first differing path. Field-specific guards give stable
messages for known unsupported structures, while the semantic deep comparison is the
authoritative fallback for unknown/unmodeled content. The 15-case matrix proves the input
is valid and authenticated before the intended conversion rejection.

## Chronological failure and repair record

1. The supplied ZIP contained Credimi conformance documents, not this publisher repository.
   It was left untouched; a clean clone of the named GitHub repository was used.
2. The first `npm ci` failed before tests because npm attempted to create `/root/.npm`,
   which is denied in this execution sandbox. It also emitted misleading tarball warnings.
   Moving the incomplete generated `node_modules` aside and setting
   `NPM_CONFIG_CACHE=/tmp/eudi-tlp-npm-cache-20260729T0924` fixed the environment issue.
3. Delivered baseline validation then passed: 8 files, 293/293 tests, 5.45 seconds.
4. The first new acceptance file passed 32/32; acceptance plus regression passed 128/128.
5. An adversarial matrix review found three requested independent negative cases were covered
   in primary/alternate suites but not repeated with negative parameters. Added dedicated
   three-way, pre-commit, and post-commit tests, raising the file to 35 tests.
6. The first post-change lint attempt again omitted the writable cache. `lint:design`
   failed with `ENOENT ... /root/.npm`; rerunning with the isolated cache passed.
7. Focused run after the three added tests: one failure in
   `Phase 4 adversarial acceptance suite > returns and reconciles a second post-commit application-save failure`.
   Failing assertion: expected the public `error` to contain
   `ADVERSARIAL_POST_COMMIT_APPLICATION_SAVE_FAILURE`; received the stable
   `Immutable publication succeeded ... Run reconciliation to repair.` message.
   Failure count: one. The incorrect fixture assumption was that internal mutable-store
   exception text is part of the public contract. The repair changed only the assertion to
   the exact stable list-key/sequence-specific error. This is correct because callers rely on
   the stable code/message and structured publication data, not storage exception strings.
8. The complete focused set was rerun from the beginning and passed 131/131.
9. A first smoke attempt started `./run.sh` in one command session and curled from another;
   session network isolation caused `curl: (7)` although the server reported listening.
   The server was stopped with SIGINT. Running server and curl in one controlled shell passed
   HTTP 200 and logged clean `shutting_down`.
10. `gh`, `task`, and `mise` are not installed in the environment. `gh` is unnecessary for
    the explicitly requested direct `origin/main` push (no PR) if Git credentials exist.
    The repository's actual `npm run lint` command passed; the unavailable `task lint`
    wrapper could not be invoked.
11. Created the single governed commit
    `34e56c53347f3a4ebe70115182439cee5aa7cd84`.
12. Normal `git push origin main` failed with
    `fatal: could not read Username for 'https://github.com': No such device or address`.
    Fetch remains available, but the checkout has no HTTPS credentials or credential helper.
13. The connected GitHub app could read the baseline, but its atomic Git-data write path
    failed with HTTP 403 `Resource not accessible by integration`. No remote ref was changed.
14. SSH fallback was unavailable in the execution network and no token/authentication
    environment variable was present. This is an authorization stop, not a repository or
    test failure.

No concurrency or full-suite test failed during the final stability loop.

## Test counts before and after

- Baseline: 8 files, 293 tests.
- Final: 9 files, 328 tests.
- Added acceptance coverage: 35 tests, including two independent 20-iteration lock tests
  and a 15-row authenticated unsupported-field matrix.

## Final validation results

The required chain used the writable npm cache and completed with exit code 0:

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

- `npm ci`: passed, 75 packages installed.
- `npm run format`: passed.
- `npm run format:check`: passed.
- `npm run build`: passed.
- `npm run lint`: passed with 0 errors and the repository's existing `design.md`
  no-YAML warning.
- Focused acceptance plus regression: 2 files, 131/131 tests.
- Stability run 1: 9 files, 328/328, 5.51 seconds.
- Stability run 2: 9 files, 328/328, 5.54 seconds.
- Stability run 3: 9 files, 328/328, 5.97 seconds.
- `git diff --check`: passed.
- `./run.sh`: built and listened on `0.0.0.0:8080`.
- `curl -f http://127.0.0.1:8080/healthz`: HTTP 200, body `{"status":"ok"}`.
- Shutdown: clean SIGINT; server logged `{"status":"shutting_down"}`.

## Known limitations

- The keyed publication lock is deliberately process-local. It does not coordinate separate
  Node.js processes or hosts sharing the same publication directory.
- Wallet Providers remain the only implemented list family.
- The design linter emits one non-failing warning because `DESIGN.md` contains no YAML.
- The execution image does not contain `gh`, `task`, or `mise`; direct authenticated Git
  operations and the repository's npm scripts provide the required commit/push and lint paths.

## Incomplete or intentionally unchanged

Nothing from the initiating prompt was intentionally left out.

No implementation, runtime-test, documentation, validation, smoke, handoff, or local commit
requirement remains incomplete. The user explicitly removed GitHub from the delivery path
after supplying the latest repository snapshot, so remote push and remote-hash proof are no
longer acceptance requirements for this local artifact.

The example signing configuration was intentionally unchanged because it already declares
the Wallet Provider family, per-list key, certificate/key paths, scheme metadata and
distribution point required by the documented Phase 4 behavior. Canonical HITL assets were
preserved as required.

## Git state and push evidence

- Branch: `main`
- Pre-commit HEAD: `4a6ffbdd20b25d1eaf02e78a9b536290c95e4705`
- Final local commit: `34e56c53347f3a4ebe70115182439cee5aa7cd84`
- Push result: blocked; normal HTTPS push lacked credentials and GitHub app writes returned 403
- Final `git status --short`: empty
- Final `git log -3 --oneline`:
  - `34e56c5 test(phase4): prove final cumulative acceptance`
  - `4a6ffbd fix: replace FAILURE-1 with real FsOps-based test, add comprehensive handoff`
  - `f8b5867 fix: round-trip losslessness check, export PartialCommitResult, fix LOCK identifiers`
- Final `git rev-parse HEAD`: `34e56c53347f3a4ebe70115182439cee5aa7cd84`
- Final `git rev-parse origin/main`: `4a6ffbdd20b25d1eaf02e78a9b536290c95e4705`
- Handoff ignore proof:
  `.gitignore:23:handoffs/ handoffs/20260729T092225Z_phase4-codex-final-acceptance.md`

## Safest next action

Copy the delivered ZIP into the repository workspace, run the documented validation commands
if desired, then commit or push it using the user's normal local Git workflow.

## Final local-snapshot verification

- Input snapshot: `eudi-trusted-list-publisher-main (1).zip`
  (`49c06bb54277b9f85196051bbf5932efba2068bc`).
- Reconciled implementation tree: local commit
  `34e56c53347f3a4ebe70115182439cee5aa7cd84`.
- Delivered archive:
  `/workspace/scratch/388133837d43/eudi-trusted-list-publisher-phase4-final.zip`.
- Archive SHA-256:
  `c0d6e220fb198307738870a5bbbbea630eccda8f1625c81e8dc47ad559eef597`.
- Archive integrity: 90 entries tested successfully; `.git`, `node_modules`, `dist`,
  handoffs, and runtime data are excluded.
- Tree comparison: only the eight modified Phase 4 files and the new
  `test/phase4-final-acceptance.test.ts` differed from the uploaded snapshot.
- Fresh validation on 2026-07-29:
  - `npm ci`: pass;
  - format and format check: pass;
  - build: pass;
  - lint: pass with the existing non-failing DESIGN.md YAML warning;
  - complete suite: 328/328, three consecutive runs;
  - `git diff --check`: pass;
  - `./run.sh` smoke: `/healthz` HTTP 200 with `{"status":"ok"}`;
  - server shutdown: clean;
  - `git status --short`: empty.
