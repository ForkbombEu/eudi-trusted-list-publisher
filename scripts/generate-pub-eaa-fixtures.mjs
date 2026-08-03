/**
 * Generates the Pub-EAA negative-fixture suite: one healthy baseline, one list
 * per defect in the catalogue, and one list combining two defects.
 *
 * Each fixture is a real publication produced by the real generator and
 * assessed by the live Trust Inspector — not a hand-written artifact. Run with:
 *
 *   node scripts/generate-pub-eaa-fixtures.mjs [--dry-run]
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PublicationStore } from "../dist/src/core/publication/store.js";
import { createTrustedList } from "../dist/src/core/authoring/list-creation.js";
import {
  DEFECT_SPECS,
  mintCertificate,
} from "../dist/src/core/authoring/defects.js";

const ROOT = resolve(import.meta.dirname, "..");

/*
  Every artifact location comes from the environment. The literals below are the
  documented defaults for an absent variable, never a path this script imposes —
  see "Artifact Location And Repository Hygiene" in directives/BARIO.md.
*/
const fromEnv = (name, fallback) => resolve(ROOT, process.env[name] ?? fallback);

const SIGNING_CONFIG = fromEnv(
  "TLP_SIGNING_CONFIG",
  "./.local-signing/signing-config.json",
);
const FIXTURE_KEYS = fromEnv(
  "TLP_FIXTURE_KEY_DIR",
  "./.local-signing/fixtures",
);
const PUBLICATION_DIR = fromEnv("TLP_PUBLICATION_DIR", "./publications");
const REPORT_PATH = fromEnv(
  "TLP_FIXTURE_REPORT",
  "./.local-signing/fixture-report.json",
);

/** Two defects that touch different stages, so the combination is observable. */
const COMBINED = ["missing_policy_or_legal_notice", "jades_without_signing_time"];

const fixtures = [
  { name: "pub-eaa-healthy", defects: [] },
  ...DEFECT_SPECS.map((spec) => ({
    name: `pub-eaa-broken-${spec.id}`,
    defects: [spec.id],
  })),
  { name: "pub-eaa-broken-combined", defects: COMBINED },
];

const dryRun = process.argv.includes("--dry-run");

if (dryRun) {
  for (const fixture of fixtures)
    console.log(`${fixture.name}\t[${fixture.defects.join(", ") || "healthy"}]`);
  process.exit(0);
}

const store = new PublicationStore({ publicationDir: PUBLICATION_DIR });
const results = [];
mkdirSync(FIXTURE_KEYS, { recursive: true });

/*
  Every fixture is signed by its own certificate, whose subject organisation
  equals the fixture's scheme operator name. Sharing one certificate across
  fixtures would make every list fail the signer-organisation rule, drowning the
  defect under test — and would make the healthy baseline fail too.
*/
function signingMaterialFor(name) {
  const minted = mintCertificate({
    commonName: `${name} signer`,
    organisation: name,
    country: "EU",
  });
  if (!minted)
    throw new Error("openssl is required to mint fixture signing certificates.");
  const keyFile = resolve(FIXTURE_KEYS, `${name}-key.pem`);
  const certFile = resolve(FIXTURE_KEYS, `${name}-cert.pem`);
  writeFileSync(keyFile, minted.privateKeyPem, "utf-8");
  writeFileSync(certFile, minted.certificatePem, "utf-8");
  return { keyFile, certFile };
}

for (const fixture of fixtures) {
  /* A fixture is regenerated from scratch so reruns are idempotent. */
  rmSync(resolve(PUBLICATION_DIR, `eu_${fixture.name}`.slice(0, 43)), {
    recursive: true,
    force: true,
  });
  const { keyFile, certFile } = signingMaterialFor(fixture.name);
  const request = {
    family: "pub-eaa-providers",
    schemeName: `Pub-EAA Fixture ${fixture.name}`,
    schemeOperatorName: fixture.name,
    schemeTerritory: "EU",
    schemeOperatorStreet: "1 Fixture Street",
    schemeOperatorCountry: "EU",
    schemeOperatorEmail: `fixtures@${fixture.name}.example`,
    baseUrl: `https://lote.credimi.io/fixtures/${fixture.name}`,
    keyFile,
    certFile,
    defects: fixture.defects,
  };

  process.stdout.write(`Generating ${fixture.name} ... `);
  const result = await createTrustedList(request, {
    publicationStore: store,
    signingConfigPath: SIGNING_CONFIG,
  });

  if (!result.success) {
    console.log(`FAILED: ${result.error}`);
    results.push({ name: fixture.name, ok: false, error: result.error });
    continue;
  }

  const summary = result.inspector.summary;
  const actual = summary.locallyDecidableFailures ?? [];
  console.log(
    `${result.listKey} | inspector=${summary.status} | profile=${summary.profile ?? "-"} | failures=${actual.length}`,
  );
  results.push({
    name: fixture.name,
    ok: true,
    listKey: result.listKey,
    defects: fixture.defects,
    inspectorStatus: summary.status,
    profile: summary.profile,
    conformanceLevel: summary.conformanceLevel,
    expected: result.fixture?.expectedFailures.inspector ?? [],
    actual: actual.map((line) => line.split(":")[0]),
    matched: result.fixture?.matchedFailures ?? [],
    missing: result.fixture?.missingFailures ?? [],
    additional: result.fixture?.additionalFailures ?? [],
    knownUnrelated: result.fixture?.knownUnrelatedFailures ?? [],
    mutations: result.fixture?.mutations ?? [],
  });
}

console.log("\n=== SUMMARY ===");
for (const entry of results) {
  if (!entry.ok) {
    console.log(`${entry.name}: FAILED — ${entry.error}`);
    continue;
  }
  console.log(
    [
      entry.name,
      `key=${entry.listKey}`,
      `inspector=${entry.inspectorStatus}`,
      `profile=${entry.profile ?? "-"}`,
      `matched=[${entry.matched.join(" ")}]`,
      `missing=[${entry.missing.join(" ")}]`,
      `additional=[${entry.additional.join(" ")}]`,
    ].join(" | "),
  );
}

writeFileSync(REPORT_PATH, `${JSON.stringify(results, null, 2)}\n`, "utf-8");
console.log(`\nReport written to ${REPORT_PATH}`);
