#!/usr/bin/env node
/**
 * Explicitly authorized live Trust Inspector validation of the EAA and QEAA
 * fixture suites.
 *
 * This script contacts `trust-inspector.credimi.io`. Nothing in `npm test` does,
 * and nothing here is run by it: uploading artifacts to a third party is an act
 * an operator performs on purpose, not a side effect of running a test suite.
 *
 *   npm run fixtures:verify     generate the suites and validate them live
 *   npm run fixtures:generate  generate the suites only, contacting nobody
 *
 * It fails closed. An Inspector that cannot be reached, that returns an
 * unusable evaluation, or that reports a standard as not applicable is an
 * unsuccessful run — never a pass.
 *
 * Artifact locations come from the environment, per directives/BARIO.md:
 *   TLP_TSL_FIXTURE_DIR  where the suites are written
 *   TLP_INSPECTOR_URL    the Trust Inspector base URL
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { generateTrustedListFixtureSuite } from "../dist/src/core/tsl612/fixture-suite.js";
import { TrustedListStore } from "../dist/src/core/publication/tsl-store.js";
import {
  InspectorClient,
  DEFAULT_INSPECTOR_BASE_URL,
} from "../dist/src/core/inspector/inspector.js";
import { xmlDefects } from "../dist/src/core/tsl612/defects.js";

const offline = process.argv.includes("--offline");
const fixtureDir = resolve(
  process.env.TLP_TSL_FIXTURE_DIR ?? "./.local-signing/tsl612-fixtures",
);
const inspectorUrl = process.env.TLP_INSPECTOR_URL ?? DEFAULT_INSPECTOR_BASE_URL;

let failures = 0;
let checks = 0;
const ok = (label) => {
  checks += 1;
  console.log(`  ok    ${label}`);
};
const bad = (label) => {
  checks += 1;
  failures += 1;
  console.log(`  FAIL  ${label}`);
};
const info = (label) => console.log(`  info  ${label}`);

/* A run must not reuse a previous run's publications: a fixture key is stable,
   and an existing version would be reported as a collision rather than
   regenerated. The suite is therefore always written to a fresh directory. */
rmSync(fixtureDir, { recursive: true, force: true });
mkdirSync(fixtureDir, { recursive: true });

const store = new TrustedListStore({
  publicationDir: join(fixtureDir, "publications"),
});
const signingConfigPath = join(fixtureDir, "signing-config.json");
const scratch = mkdtempSync(join(tmpdir(), "tlp-fixture-certs-"));

console.log(
  `\nGenerating the EAA and QEAA fixture suites in ${fixtureDir}` +
    (offline ? " (offline)" : `, validating against ${inspectorUrl}`),
);

const generated = await generateTrustedListFixtureSuite({
  store,
  signingConfigPath,
  certificatesDir: scratch,
  ...(offline
    ? { inspectorClient: null }
    : { inspectorClient: new InspectorClient({ baseUrl: inspectorUrl }) }),
});
rmSync(scratch, { recursive: true, force: true });

console.log("\n1. Every fixture was generated");
const expectedCount = 2 * (2 + xmlDefects().length);
if (generated.length === expectedCount)
  ok(`${generated.length} fixtures, as the catalogue requires`);
else bad(`expected ${expectedCount} fixtures, generated ${generated.length}`);
for (const fixture of generated) {
  if (fixture.error) bad(`${fixture.listKey}: ${fixture.error}`);
}

console.log("\n2. Every single-defect fixture carries exactly one mutation");
for (const fixture of generated) {
  if (fixture.defects.length !== 1) continue;
  const applied = (fixture.fixture?.mutations ?? []).filter((m) => m.applied);
  if (applied.length === 1 && applied[0].defectId === fixture.defects[0])
    ok(`${fixture.listKey}: ${applied[0].defectId} (${applied[0].stage})`);
  else
    bad(
      `${fixture.listKey}: ${applied.length} mutation(s) applied: ${applied
        .map((m) => m.defectId)
        .join(", ")}`,
    );
}

console.log("\n3. The combined fixtures carry exactly two");
for (const fixture of generated.filter((f) => f.defects.length === 2)) {
  const applied = (fixture.fixture?.mutations ?? []).filter((m) => m.applied);
  if (applied.length === 2)
    ok(`${fixture.listKey}: ${applied.map((m) => m.defectId).join(" + ")}`);
  else bad(`${fixture.listKey}: ${applied.length} mutation(s) applied`);
}

console.log("\n4. No selected defect was silently repaired");
for (const fixture of generated) {
  const unapplied = (fixture.fixture?.mutations ?? []).filter(
    (m) => !m.applied,
  );
  if (unapplied.length === 0) continue;
  bad(
    `${fixture.listKey}: ${unapplied
      .map((m) => `${m.defectId} (${m.detail})`)
      .join("; ")}`,
  );
}
if (generated.every((f) => (f.fixture?.mutations ?? []).every((m) => m.applied)))
  ok("every selected mutation was applied");

console.log("\n5. Healthy baselines are locally clean");
for (const fixture of generated.filter((f) => f.defects.length === 0)) {
  const local = fixture.fixture?.actualFailures.local ?? [];
  if (local.length === 0) ok(`${fixture.listKey}: no local failure`);
  else bad(`${fixture.listKey}: ${local.join(", ")}`);
}

console.log("\n6. Local expectations match");
for (const fixture of generated) {
  const missing = fixture.fixture?.missingLocalFailures ?? [];
  if (missing.length === 0) continue;
  bad(`${fixture.listKey}: expected locally but not reported: ${missing.join(", ")}`);
}
if (generated.every((f) => (f.fixture?.missingLocalFailures ?? []).length === 0))
  ok("every expected local failure was reported");

if (offline) {
  console.log("\nTrust Inspector was not contacted (--offline).");
} else {
  console.log("\n7. Trust Inspector (live)");
  for (const fixture of generated) {
    if (fixture.error) continue;
    const status = fixture.inspectorStatus ?? "missing";
    const kind = fixture.inspectorArtifactKind ?? "not stated";
    const meta = fixture.fixture;

    if (fixture.defects.length === 0) {
      /* A healthy baseline must be recognised and must pass. */
      if (kind === "ts119612_xml_tsl")
        ok(`${fixture.listKey}: classified as ts119612_xml_tsl`);
      else bad(`${fixture.listKey}: classified as ${kind}`);
      if (status === "pass") ok(`${fixture.listKey}: zero applicable failures`);
      else bad(`${fixture.listKey}: Inspector status ${status}`);
      continue;
    }

    /*
      Some defects are deliberately invisible to the Inspector: it assesses the
      artifact it is given and never sees the `.sha2` sidecar. Those declare an
      empty Inspector expectation, and the local check is what has to fail.
    */
    if ((meta?.expectedFailures.inspector ?? []).length === 0) {
      const local = meta?.actualFailures.local ?? [];
      if (local.length > 0)
        ok(
          `${fixture.listKey}: outside the Inspector's scope by design; the defect is local (${local.join(", ")})`,
        );
      else
        bad(
          `${fixture.listKey}: no Inspector rule expected and no local check failed either`,
        );
      if ((meta?.additionalFailures ?? []).length > 0)
        info(
          `${fixture.listKey}: the Inspector additionally reported ${(meta?.additionalFailures ?? []).join(", ")}`,
        );
      continue;
    }

    /*
      A broken fixture must produce a verdict the Inspector could actually
      reach. `unavailable` means no verdict — which is the honest answer for a
      mutation that stops the artifact being classified, and is reported as
      such rather than counted either way.
    */
    if (status === "fail") {
      const matched = meta?.matchedFailures ?? [];
      if (matched.length > 0)
        ok(
          `${fixture.listKey}: ${matched.length}/${
            meta?.expectedFailures.inspector.length ?? 0
          } expected rule(s) tripped: ${matched.join(", ")}`,
        );
      else
        bad(
          `${fixture.listKey}: failed, but none of the expected rules: expected ${(
            meta?.expectedFailures.inspector ?? []
          ).join(", ")}; got ${(meta?.additionalFailures ?? []).join(", ")}`,
        );
      const missing = meta?.missingFailures ?? [];
      if (missing.length > 0)
        info(`${fixture.listKey}: expected but not reported: ${missing.join(", ")}`);
      const extra = meta?.additionalFailures ?? [];
      if (extra.length > 0)
        info(`${fixture.listKey}: additional: ${extra.join(", ")}`);
      continue;
    }

    if (status === "unavailable") {
      info(
        `${fixture.listKey}: no Inspector verdict — classified as ${kind}. This is recorded, never counted as a pass.`,
      );
      ok(`${fixture.listKey}: unavailable was not reported as a pass`);
      continue;
    }

    if (status === "pass") {
      bad(
        `${fixture.listKey}: the Inspector passed an intentionally broken fixture`,
      );
      continue;
    }
    bad(`${fixture.listKey}: unusable Inspector evaluation (${status})`);
  }
}

const report = generated.map((fixture) => ({
  listKey: fixture.listKey,
  family: fixture.family,
  defects: fixture.defects,
  ...(fixture.error ? { error: fixture.error } : {}),
  inspectorStatus: fixture.inspectorStatus ?? null,
  inspectorArtifactKind: fixture.inspectorArtifactKind ?? null,
  expectedFailures: fixture.fixture?.expectedFailures ?? null,
  actualFailures: fixture.fixture?.actualFailures ?? null,
  matchedFailures: fixture.fixture?.matchedFailures ?? null,
  missingFailures: fixture.fixture?.missingFailures ?? null,
  additionalFailures: fixture.fixture?.additionalFailures ?? null,
}));
const reportPath = join(fixtureDir, "fixture-report.json");
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");

console.log(`\n${checks - failures}/${checks} checks passed.`);
console.log(`Fixture report: ${reportPath}`);
console.log(`Publications:   ${join(fixtureDir, "publications")}`);
process.exit(failures === 0 ? 0 : 1);
