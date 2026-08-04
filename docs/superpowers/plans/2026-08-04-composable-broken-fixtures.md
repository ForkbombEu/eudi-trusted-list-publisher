# Composable Broken Fixtures Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an administrator select any one-through-all subset of supported defects for every JSON and XML Trusted List family, with every selected defect present in the one published artifact.

**Architecture:** Keep the canonical defect catalogue and both mutation engines. Normalize selections into catalogue order, build healthy family/profile-aware seeds, compose signer requirements into one certificate, and reject any fixture with an unapplied selected mutation before immutable storage.

**Tech Stack:** Node.js 24 LTS, TypeScript 5.8, Vitest 3, `jose`, `node:crypto`, OpenSSL fixture certificates, `libxml2-wasm`.

## Global Constraints

- Follow `directives/BARIO.md`, `STANDARDS.md`, `SPECS.md`, and `DESIGN.md`.
- Use strict TDD: write one behavior test, run it and observe the expected failure, then add minimum production code.
- Selection is conjunctive. Support every selection size from one through all, without bundles or disabled combinations.
- Cover PID, Wallet, WRPAC, WRPRC, Pub-EAA, EAA-only, QEAA-only, and EAA-plus-QEAA.
- Preserve healthy-list behavior and immutable-store commit boundaries.
- Run `task format` and `task lint` before every commit, inspect staged files for secrets, and refresh `handoffs/20260804T144146Z_multi-select-broken-fixtures.md`.
- Do not push.

## File Structure

- `src/core/defects/registry.ts` — canonical selection ordering.
- `src/core/defects/fixture-metadata.ts` — selected-versus-applied evidence comparison.
- `src/core/authoring/defects.ts` — family-aware JSON seeds and composed JSON signer defects.
- `src/core/authoring/list-creation.ts` — JSON preparation and pre-storage mutation gate.
- `src/core/tsl612/defects.ts` — multi-profile XML mutations and composed signer plan.
- `src/core/tsl612/create-list.ts` — seed every accepted XML profile.
- `src/core/tsl612/publish.ts` — XML pre-storage mutation gate.
- `src/web/views/list-creation.ts` — preserve JSON defect selections after errors.
- `test/broken-generation.test.ts`, `test/annexde-generation.test.ts`,
  `test/annexfg-wrpac-wrprc.test.ts`, `test/tsl612-defects.test.ts`,
  `test/tsl612-publication.test.ts`, and `test/tsl612-web.test.ts` — behavioral
  regression coverage.
- `README.md`, `SPECS.md`, `DESIGN.md`, `STANDARDS.md` — implemented contract.

---

### Task 1: Canonical Selection and Mutation-Evidence Gate

**Files:**

- Modify: `src/core/defects/registry.ts:751-810`
- Modify: `src/core/defects/fixture-metadata.ts:24-45`
- Test: `test/broken-generation.test.ts:77-126`
- Test: `test/tsl612-defects.test.ts:100-170`

**Interfaces:**

- Produces: `normalizeDefectSelectionForStandard(ids, standard): string[]`
- Produces: `unappliedSelectedDefects(selectedDefects, mutations): string[]`

- [ ] **Step 1: Add failing canonical-order tests**

```ts
expect(
  normalizeDefectSelectionForStandard(
    [
      "missing_operator_email",
      "scheme_name_without_territory",
      "missing_operator_email",
    ],
    "TS 119 602",
  ),
).toEqual(["scheme_name_without_territory", "missing_operator_email"]);
```

Add the XML equivalent with `expired_next_update` submitted before
`invalid_tsl_version_identifier`, expecting canonical catalogue order.

- [ ] **Step 2: Verify RED**

Run:

```bash
npx vitest run test/broken-generation.test.ts test/tsl612-defects.test.ts -t "normalizes selected defects"
```

Expected: FAIL because the function is not exported.

- [ ] **Step 3: Implement canonical normalization**

```ts
export function normalizeDefectSelectionForStandard(
  ids: readonly string[],
  standard: DefectStandard,
): string[] {
  const selected = new Set(ids);
  return defectsForStandard(standard)
    .filter((spec) => selected.has(spec.id))
    .map((spec) => spec.id);
}
```

Existing request validators continue rejecting unknown IDs before this helper
runs.

- [ ] **Step 4: Add a failing evidence-gate test**

```ts
const mutations: AppliedMutation[] = [
  {
    defectId: "scheme_name_without_territory",
    stage: "pre-sign",
    applied: true,
    detail: "changed",
  },
  {
    defectId: "missing_operator_email",
    stage: "pre-sign",
    applied: false,
    detail: "no mailto URI",
  },
];
expect(
  unappliedSelectedDefects(
    [
      "scheme_name_without_territory",
      "missing_operator_email",
      "jades_without_signing_time",
    ],
    mutations,
  ),
).toEqual(["missing_operator_email", "jades_without_signing_time"]);
```

- [ ] **Step 5: Verify RED, implement, and verify GREEN**

Run the named test, then add:

```ts
export function unappliedSelectedDefects(
  selectedDefects: readonly string[],
  mutations: readonly AppliedMutation[],
): string[] {
  const applied = new Set(
    mutations
      .filter((mutation) => mutation.applied)
      .map((mutation) => mutation.defectId),
  );
  return selectedDefects.filter((defectId) => !applied.has(defectId));
}
```

Rerun both test files. Expected: PASS.

- [ ] **Step 6: Verify and commit Task 1**

Run `task format`, `task lint`, refresh the handoff, inspect staged content, and
commit:

```bash
git commit -m "feat(fixtures): enforce selected mutation evidence" -m "reason:
prevent fixture metadata from claiming unapplied defects

prompt:
compose any selected defect subset"
```

---

### Task 2: Family-Aware TS 119 602 Seed

**Files:**

- Modify: `src/core/authoring/defects.ts:24-31,310-390`
- Test: `test/broken-generation.test.ts:20-76,250-286`

**Interfaces:**

- Consumes: `getEnabledProfile(family)`.
- Produces: existing `fixtureSeedEntity(...)` with family-correct fields.

- [ ] **Step 1: Write a failing five-family table test**

Use these literal service-type expectations:

```ts
[
  [
    "pid-providers",
    "http://uri.etsi.org/19602/SvcType/PID/Issuance",
    true,
    false,
  ],
  [
    "wallet-providers",
    "http://uri.etsi.org/19602/SvcType/WalletSolution/Issuance",
    true,
    false,
  ],
  [
    "wrpac-providers",
    "http://uri.etsi.org/19602/SvcType/WRPAC/Issuance",
    false,
    false,
  ],
  [
    "wrprc-providers",
    "http://uri.etsi.org/19602/SvcType/WRPRC/Issuance",
    false,
    false,
  ],
  [
    "pub-eaa-providers",
    "http://uri.etsi.org/19602/SvcType/PubEAA/Issuance",
    false,
    true,
  ],
];
```

For each seed assert the service type, identifier presence, status presence,
role-URI placement, and successful `compileForProfile()`. Assert only Pub-EAA
has `OJ:EU32024R1183`.

- [ ] **Step 2: Verify RED**

Run:

```bash
npx vitest run test/broken-generation.test.ts -t "builds a compilable healthy fixture seed"
```

Expected: non-Pub-EAA rows fail because the seed contains Pub-EAA issuance.

- [ ] **Step 3: Implement profile-derived seed fields**

Type the return as `AuthoringEntity` and construct the service from the profile:

```ts
const profile = getEnabledProfile(family);
const roleUri = `${profile.roleUriPrefix}/${country}`;
const service: AuthoringService = {
  serviceTypeIdentifier: profile.allowedServiceTypes[0]!,
  serviceName: [{ lang: "en", value: "Broken Fixture Issuance" }],
  serviceDigitalIdentity: {
    x509Certificates: [serviceCertificateDerBase64],
  },
  ...(profile.requiresServiceUniqueIdentifier
    ? { serviceUniqueIdentifier: `urn:fixture:${family}:issuance` }
    : {}),
  ...(profile.usesServiceStatus
    ? {
        serviceStatus: profile.serviceStatuses!.notified,
        statusStartingTime,
      }
    : {}),
};
```

Place the role URI according to `roleUriInElectronicAddress` and
`roleUriInInformationUri`; include legal basis only when required.

- [ ] **Step 4: Verify GREEN and commit Task 2**

Run `npx vitest run test/broken-generation.test.ts`, `task format`, and
`task lint`. Refresh the handoff, inspect staged content, and commit:

```bash
git commit -m "fix(fixtures): seed the selected JSON family" -m "reason:
avoid injecting Pub-EAA services into every broken JSON list

prompt:
support broken fixtures for every list family"
```

---

### Task 3: End-to-End JSON Composition and Form Retention

**Files:**

- Modify: `src/core/authoring/defects.ts:402-520,560-650`
- Modify: `src/core/authoring/list-creation.ts:160-180,240-500`
- Modify: `src/web/views/list-creation.ts:17-48`
- Test: `test/annexde-generation.test.ts:700-900`
- Test: `test/annexfg-wrpac-wrprc.test.ts:1080-1140`
- Test: `test/broken-generation.test.ts:90-250`

**Interfaces:**

- Consumes: both Task 1 helpers and the Task 2 seed.
- Extends: `PostSignContext` with `schemeTerritory: string`.
- Guarantees: JSON mutation evidence is complete before
  `PublicationStore.store()`.

- [ ] **Step 1: Add a failing creation matrix**

Using real temporary stores and signing material, and stubbing only the external
Inspector HTTP boundary, create one fixture for each enabled family:

```ts
it.each([
  "pid-providers",
  "wallet-providers",
  "wrpac-providers",
  "wrprc-providers",
  "pub-eaa-providers",
] as const)("%s creates a broken fixture", async (family) => {
  const result = await createTrustedList(
    {
      ...baseRequest,
      family,
      schemeOperatorName: `Broken ${family}`,
      defects: ["scheme_name_without_territory", "missing_operator_email"],
    },
    deps,
  );
  expect(result.success, result.success ? "" : result.error).toBe(true);
  if (!result.success) return;
  expect(result.fixture?.selectedDefects).toEqual([
    "scheme_name_without_territory",
    "missing_operator_email",
  ]);
  expect(result.fixture?.mutations.every((mutation) => mutation.applied)).toBe(
    true,
  );
});
```

Use a fresh temporary dependency set per row to avoid list-key collisions.

- [ ] **Step 2: Verify RED**

Run:

```bash
npx vitest run test/annexde-generation.test.ts -t "creates a broken fixture"
```

Expected before integration: non-Pub-EAA creation fails at seeded compilation.

- [ ] **Step 3: Prepare family-appropriate service certificates**

Mint the seed certificate once before constructing `AuthoringInput`:

```ts
const needsCaServiceCertificate =
  request.family === "wrpac-providers" || request.family === "wrprc-providers";
const fixtureCertificatePem = broken
  ? (mintCertificate({
      commonName: `${FIXTURE_ENTITY_NAME} Issuance`,
      organisation: FIXTURE_ENTITY_NAME,
      country: entry.schemeOperatorCountry,
      ...(needsCaServiceCertificate ? { certificateAuthority: true } : {}),
    })?.certificatePem ?? certPem)
  : certPem;
```

Pass its DER into `fixtureSeedEntity()`. Add WRPAC/WRPRC assertions through
`checkRelyingPartyCaCertificate()` so removing `certificateAuthority: true`
breaks the test.

- [ ] **Step 4: Normalize selections and complete JSON subject mismatch**

After unknown-ID validation, derive `defects` with
`normalizeDefectSelectionForStandard(request.defects, "TS 119 602")`. Use it
for `broken`, config persistence, both mutation stages, and metadata.

Pass `schemeTerritory` into `applyPostSignDefects()`. Change the mismatched
certificate to use both wrong `O` and wrong `C`:

```ts
const mismatchCountry = (territory: string): string =>
  territory === "IT" ? "DE" : "IT";
```

Keep missing `iat` in the same re-sign operation so it composes with the subject
defect.

- [ ] **Step 5: Enforce the JSON gate before publication**

Immediately after post-sign mutation:

```ts
const mutations = [...preSign.mutations, ...postSign.mutations];
const unapplied = unappliedSelectedDefects(defects, mutations);
if (unapplied.length > 0)
  return {
    success: false,
    error: `Selected defects were not applied: ${unapplied.join(", ")}.`,
  };
```

This must precede both `publish()` and `PublicationStore.store()`. Pass the same
`mutations` array to metadata. Add a sequential test that temporarily sets
`process.env.PATH = ""`, selects `signer_organisation_mismatch`, and restores
the original PATH in `finally`. The substitute signer cannot be minted, so the
test asserts the result names that unapplied defect, the store has no sequence,
and the signing-config file has no new list. Do not add a production method used
only by tests.

- [ ] **Step 6: Add individual and complete JSON selection tests**

First add `it.each(LIST_DEFECTS)` coverage that creates one Wallet fixture per
defect and asserts that exact defect has an `applied: true` mutation. This
catches any independently unselectable checkbox.

Then create one fixture for each of the five enabled families using every
`LIST_DEFECTS` ID. Assert the following literal canonical sequence for every
row:

```ts
[
  "non_strict_timestamps",
  "scheme_name_without_territory",
  "missing_scheme_information_uri",
  "missing_policy_or_legal_notice",
  "missing_operator_email",
  "missing_self_pointer",
  "pem_service_certificate",
  "extension_without_criticality",
  "signer_organisation_mismatch",
  "jades_without_signing_time",
];
```

Assert each ID has `applied: true`. Decode the Compact JAdES and independently
assert: no `iat`, no territory prefix, no operator mailto, no self pointer, and
the signer certificate has wrong `O` and `C`. This prevents metadata alone from
satisfying the test.

- [ ] **Step 7: Preserve multiple JSON checkboxes on errors**

Extend `CreateListFormValues` with `defects?: string | string[]`; pass selected
IDs into `defectOptions(selected)` and add `checked` as the XML form does.

```ts
const html = createListFormHtml({
  defects: ["missing_operator_email", "jades_without_signing_time"],
});
expect(html).toMatch(/value="missing_operator_email" checked/);
expect(html).toMatch(/value="jades_without_signing_time" checked/);
```

- [ ] **Step 8: Verify and commit Task 3**

Run:

```bash
npx vitest run test/broken-generation.test.ts test/annexde-generation.test.ts test/annexfg-wrpac-wrprc.test.ts
task format
task lint
```

Refresh the handoff, inspect staged content, and commit:

```bash
git commit -m "feat(fixtures): compose JSON defects" -m "reason:
publish every selected defect across all TS 119 602 families

prompt:
allow selecting one through all broken fixtures"
```

---

### Task 4: Seed and Mutate Every Accepted TS 119 612 Profile

**Files:**

- Modify: `src/core/tsl612/defects.ts:40-50,180-390,665-760`
- Modify: `src/core/tsl612/create-list.ts:300-385`
- Modify: `src/core/tsl612/fixture-suite.ts:80-190`
- Modify: `src/core/tsl612/publish.ts:35-65`
- Test: `test/tsl612-defects.test.ts:280-470`
- Test: `test/tsl612-web.test.ts:680-810`

**Interfaces:**

- Changes: `XmlDefectContext.family` to
  `families: readonly TslFamily[]`.
- Extends: `FixtureProviderOptions` with optional `providerName`.
- Produces: one healthy seed per accepted profile and family-specific mutations
  across all seeds.

- [ ] **Step 1: Add a failing dual-profile test**

Create an XML list with:

```ts
allowedServiceProfiles: ["eaa-providers", "qeaa-providers"],
defects: ["incorrect_service_type", "incorrect_service_status"],
```

Read stored XML and assert two distinct provider names, two `SvcType/CA/QC`
values, neither EAA service type remains, and both status vocabularies changed.

- [ ] **Step 2: Verify RED**

Run:

```bash
npx vitest run test/tsl612-web.test.ts -t "mutates both accepted service profiles"
```

Expected: FAIL because only the first accepted profile is seeded.

- [ ] **Step 3: Pass all accepted families through mutation context**

```ts
export interface XmlDefectContext {
  readonly families: readonly TslFamily[];
  readonly schemeTerritory: string;
  readonly schemeOperatorName: string;
}
```

Update create-list, fixture-suite, publish, and tests. Keep the first family only
for legacy manifest `family`; mutation logic must use all `families`.

- [ ] **Step 4: Seed one provider per accepted profile**

```ts
providers: entry.allowedServiceProfiles.map((profileFamily) =>
  fixtureSeedProvider({
    family: profileFamily,
    territory: entry.schemeTerritory,
    fallbackCertificatePem: certificatePem,
    publishedAt: issue,
    providerName:
      entry.allowedServiceProfiles.length === 1
        ? FIXTURE_PROVIDER_NAME
        : `${FIXTURE_PROVIDER_NAME} (${profileFamily})`,
  }),
),
```

Use `providerName` consistently for TSP name, service name, and certificate
organisation.

- [ ] **Step 5: Mutate every accepted profile**

For `incorrect_service_type`, replace every accepted profile's service type.
For `incorrect_service_status`, apply `wrongStatusesFor(family)` for every
accepted family. Record one mutation per selected defect, with `applied: true`
when at least one targeted service changed and details naming the change count.

- [ ] **Step 6: Verify GREEN and commit Task 4**

Run `npx vitest run test/tsl612-defects.test.ts test/tsl612-web.test.ts`, then
`task format` and `task lint`. Refresh the handoff, inspect staged content, and
commit:

```bash
git commit -m "fix(xml): seed every accepted fixture profile" -m "reason:
exercise EAA and QEAA defects in dual-profile Trusted Lists

prompt:
make broken fixtures work for EAA and QEAA"
```

---

### Task 5: Compose XML Signer Defects and Gate Storage

**Files:**

- Modify: `src/core/tsl612/defects.ts:473-568`
- Modify: `src/core/tsl612/publish.ts:100-240`
- Modify: `src/core/tsl612/create-list.ts:175-430`
- Test: `test/tsl612-defects.test.ts:470-680`
- Test: `test/tsl612-publication.test.ts`
- Test: `test/tsl612-web.test.ts:720-810`

**Interfaces:**

- Consumes: Task 1 helpers and Task 4 context.
- Produces: one `XmlSigningPlan` certificate satisfying the union of signer
  defects.
- Guarantees: mutation gate precedes `TrustedListStore.store()`.

- [ ] **Step 1: Write a failing combined-signer test**

```ts
const plan = planXmlSigning(
  ["signer_organisation_mismatch", "incorrect_signing_certificate"],
  healthySigner,
  {
    families: ["eaa-providers"],
    schemeTerritory: "IT",
    schemeOperatorName: "Expected Operator",
  },
);
const certificate = new X509Certificate(plan.certificatePem);
expect(certificate.subject).toContain("O=Not Expected Operator");
expect(certificate.subject).not.toContain("C=IT");
expect(
  plan.mutations
    .filter((mutation) => mutation.applied)
    .map((mutation) => mutation.defectId),
).toEqual(["signer_organisation_mismatch", "incorrect_signing_certificate"]);
expect(
  checkTrustedListSigningCertificate(certificate, {
    schemeTerritory: "IT",
    schemeOperatorName: "Expected Operator",
  }),
).toEqual(
  expect.arrayContaining([
    expect.stringMatching(/organisation/i),
    expect.stringMatching(/country/i),
    expect.stringMatching(/CA:FALSE|end.entity/i),
    expect.stringMatching(/key usage/i),
  ]),
);
```

- [ ] **Step 2: Verify RED**

Run:

```bash
npx vitest run test/tsl612-defects.test.ts -t "combines signer subject and certificate profile defects"
```

Expected: FAIL because the later CA substitution restores the correct subject.

- [ ] **Step 3: Synthesize one signer from accumulated requirements**

Compute:

```ts
const wantsSubjectMismatch = defectIds.includes("signer_organisation_mismatch");
const wantsIncorrectProfile = defectIds.includes(
  "incorrect_signing_certificate",
);
const wantsNoSigningTime = defectIds.includes("xades_without_signing_time");
```

Mint at most once:

```ts
const substitute = mintCertificate({
  commonName: "Intentionally Broken Trusted List Signer",
  organisation: wantsSubjectMismatch
    ? `Not ${context.schemeOperatorName}`.slice(0, 64)
    : context.schemeOperatorName,
  country: wantsSubjectMismatch
    ? context.schemeTerritory === "IT"
      ? "DE"
      : "IT"
    : context.schemeTerritory,
  ...(wantsIncorrectProfile
    ? { certificateAuthority: true }
    : { trustedListProfile: true }),
});
```

Record one applied/unapplied mutation per selected certificate defect from the
one synthesis result. Missing signing time and post-sign tampering remain
independent.

- [ ] **Step 4: Add a failing pre-storage gate test**

Call `publishTrustedList()` with a valid input whose `providers` is absent and
select only `pem_service_certificate`. The real mutation engine records it as
unapplied because no service certificate exists. Assert rejection and an empty
temporary store:

```ts
expect(() => publishTrustedList(options)).toThrow(
  /Selected defects were not applied:/,
);
expect(store.getHighestStoredSequence(listKey)).toBeNull();
```

- [ ] **Step 5: Enforce the XML gate before storage**

After publication-stage digest planning and before manifest/store:

```ts
if (fixture) {
  const unapplied = unappliedSelectedDefects(fixture.defectIds, mutations);
  if (unapplied.length > 0)
    throw new Error(
      `Selected defects were not applied: ${unapplied.join(", ")}.`,
    );
}
```

Normalize XML defects after validation in `createTrustedListList()` and use the
normalized IDs for publishing and fixture metadata.

- [ ] **Step 6: Add the complete XML selection test**

Retain the fixture-suite assertion that generates every XML defect individually
for both EAA and QEAA and checks its mutation is applied. Then create three
lists with every `xmlDefects()` ID: EAA-only, QEAA-only, and EAA-plus-QEAA.
For each, assert every selected ID has `applied: true`, the expected provider
profiles exist, the signer has wrong `C`, wrong `O`, CA constraints and CA key
usage, `xades:SigningTime` is absent, the post-signature tamper invalidates the
signature, and `.sha2` differs from the actual XML digest. Assert immutable
artifacts and fixture metadata exist.

- [ ] **Step 7: Verify and commit Task 5**

Run:

```bash
npx vitest run test/tsl612-defects.test.ts test/tsl612-publication.test.ts test/tsl612-web.test.ts
task format
task lint
```

Refresh the handoff, inspect staged content, and commit:

```bash
git commit -m "feat(xml): compose every selected defect" -m "reason:
ensure signer and publication defects coexist in one XML fixture

prompt:
apply one through all selected broken fixtures"
```

---

### Task 6: Interface Coverage, Documentation, and Final Verification

**Files:**

- Modify: `test/annexde-generation.test.ts:900-1100`
- Modify: `test/tsl612-web.test.ts`
- Modify: `README.md:96-123,384-395`
- Modify: `SPECS.md` under intentionally broken fixture sections
- Modify: `DESIGN.md` under creation/negative fixture sections
- Modify: `STANDARDS.md` under fixture evidence

**Interfaces:**

- Consumes: Tasks 1-5.
- Produces: HTTP-tested and documented one-through-all contract.

- [ ] **Step 1: Add missing GUI/API multiple-selection tests**

For JSON and XML, submit three repeated HTML `defects` fields and a three-item
JSON API array. Assert the response and stored `fixture.json` contain all three
IDs in canonical order. On rejected GUI input, assert every selected checkbox
remains checked. Inspect real responses and storage; do not assert mock calls.

- [ ] **Step 2: Verify RED where behavior is missing**

Run:

```bash
npx vitest run test/annexde-generation.test.ts test/web-gui.test.ts test/tsl612-web.test.ts -t "multiple selected defects"
```

Expected: JSON failed-form retention fails before its view change. If existing
transport behavior already passes, retain it as characterization coverage and
do not manufacture a production edit.

- [ ] **Step 3: Make minimum interface adjustments**

Use normalized core results in responses. Preserve existing repeated-field and
JSON-array parsing; do not duplicate normalization in `src/web/server.ts`.

- [ ] **Step 4: Update documentation**

Document these exact invariants:

- any one-through-all subset can be selected;
- selection is conjunctive and no bundles exist;
- JSON seeds match PID/Wallet/WRPAC/WRPRC/Pub-EAA;
- dual-profile XML fixtures seed EAA and QEAA;
- combined signer defects produce one certificate with all selected wrong
  properties; and
- an unapplied selection fails before publication.

Replace README wording that treats published `applied: false` as acceptable.
Keep deterministic fixture-suite naming separate from interactive arbitrary
selection behavior.

- [ ] **Step 5: Run focused and full verification**

Run:

```bash
npx vitest run test/broken-generation.test.ts test/annexde-generation.test.ts test/annexfg-wrpac-wrprc.test.ts test/tsl612-defects.test.ts test/tsl612-publication.test.ts test/tsl612-web.test.ts test/web-gui.test.ts
task format
task lint
task build
task test
git diff --check
git status --short
```

Record exact counts. If the known missing `HITL/WP4-LoTE_evaluation.json` or
timing-sensitive concurrency tests fail, separate them from fixture-related
results and rerun affected fixture suites independently.

- [ ] **Step 6: Commit final tracked changes**

Refresh the handoff with exact commands, counts, file inventory, branch, HEAD,
diff stat, failures, and next action. Inspect staged files for secrets and
commit:

```bash
git commit -m "docs(fixtures): describe composable selections" -m "reason:
make the one-through-all fixture contract explicit and testable

prompt:
align administration behavior for every list family"
```

- [ ] **Step 7: Perform fresh completion verification**

Freshly run the decisive focused suite, `task lint`, `task build`, and
`git status --short`. Set the handoff to `complete` only when behavior is
implemented, verified, committed, and the tracked worktree is clean.
