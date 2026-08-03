#!/usr/bin/env node
/**
 * Publishes the demonstration EAA and QEAA Trusted Lists into the local
 * publication store, so the Catalogue shows the TS 119 612 families the way it
 * already shows the TS 119 602 ones.
 *
 * Six lists: one healthy baseline and two intentionally broken lists per
 * family. The two defects are chosen to fail in visibly different ways —
 * `expired_next_update` breaks the dates and is caught by the Inspector, while
 * `broken_xades_signature` breaks the cryptography and is caught before it ever
 * gets there — so the Catalogue demonstrates both kinds of failure rather than
 * two shades of one.
 *
 *   node scripts/generate-tsl612-demo-lists.mjs           publish
 *   node scripts/generate-tsl612-demo-lists.mjs --dry-run list what it would do
 *
 * Contacting the Trust Inspector is opt-in, because publishing a list to it
 * uploads that list to a third party:
 *
 *   TLP_INSPECTOR_URL=https://trust-inspector.credimi.io node scripts/...
 *
 * Re-running regenerates each list from scratch, so the script is idempotent.
 *
 * Every artifact location comes from the environment. The literals below are
 * the documented defaults for an absent variable, never a path this script
 * imposes — see "Artifact Location And Repository Hygiene" in
 * directives/BARIO.md.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { TrustedListStore } from "../dist/src/core/publication/tsl-store.js";
import { createTrustedListList } from "../dist/src/core/tsl612/create-list.js";
import { mintCertificate } from "../dist/src/core/authoring/defects.js";
import { InspectorClient } from "../dist/src/core/inspector/inspector.js";

const ROOT = resolve(import.meta.dirname, "..");
const fromEnv = (name, fallback) => resolve(ROOT, process.env[name] ?? fallback);

const SIGNING_CONFIG = fromEnv(
  "TLP_SIGNING_CONFIG",
  "./.local-signing/signing-config.json",
);
const PUBLICATION_DIR = fromEnv("TLP_PUBLICATION_DIR", "./publications");
const DEMO_KEY_DIR = fromEnv("TLP_DEMO_KEY_DIR", "./.local-signing/demo-keys");
const INSPECTOR_URL = process.env.TLP_INSPECTOR_URL ?? "";

/** The responsible Member State. A TS 119 612 list is never published for `EU`. */
const TERRITORY = "IT";

/** The two defects each family demonstrates, and why each one is here. */
const DEMO_DEFECTS = [
  {
    id: "expired_next_update",
    note: "stale on the day it was issued; the Inspector reports it",
  },
  {
    id: "broken_xades_signature",
    note: "edited after signing; the signature no longer verifies",
  },
];

const families = [
  { family: "eaa-providers", slug: "eaa", label: "EAA Providers" },
  { family: "qeaa-providers", slug: "qeaa", label: "QEAA Providers" },
];

const lists = families.flatMap(({ family, slug, label }) => [
  {
    family,
    label,
    name: `${slug}-demo-healthy`,
    defects: [],
    note: "conformant baseline",
  },
  ...DEMO_DEFECTS.map((defect) => ({
    family,
    label,
    name: `${slug}-demo-broken-${defect.id.replace(/_/g, "-")}`,
    defects: [defect.id],
    note: defect.note,
  })),
]);

if (process.argv.includes("--dry-run")) {
  for (const list of lists)
    console.log(
      `${list.name}\t[${list.defects.join(", ") || "healthy"}]\t${list.note}`,
    );
  process.exit(0);
}

mkdirSync(DEMO_KEY_DIR, { recursive: true, mode: 0o700 });

/*
  One LOTL pointer identity for every demo list: the pointer is context, not
  the thing being demonstrated, so it must not vary between lists.
*/
const lotl = mintCertificate({
  commonName: "EU LOTL Demo Signer",
  organisation: "European Commission Demo",
  country: "BE",
});
if (!lotl)
  throw new Error("openssl is required to mint the LOTL pointer certificate.");
const lotlBase64Der = lotl.certificatePem
  .replace(/-----[^-]+-----/g, "")
  .replace(/\s+/g, "");

/*
  Each list is signed by its own certificate, whose subject O equals that list's
  scheme operator name and whose subject C equals the Scheme Territory. Sharing
  one certificate would make every list fail the TLSO subject rules, drowning
  the defect being demonstrated — and would make the healthy baselines fail too.
*/
function signingMaterialFor(name) {
  const minted = mintCertificate({
    commonName: `${name} signer`.slice(0, 64),
    organisation: name,
    country: TERRITORY,
    trustedListProfile: true,
  });
  if (!minted)
    throw new Error(`openssl is required to mint the ${name} certificate.`);
  const keyFile = resolve(DEMO_KEY_DIR, `${name}-key.pem`);
  const certFile = resolve(DEMO_KEY_DIR, `${name}-cert.pem`);
  writeFileSync(keyFile, minted.privateKeyPem, { encoding: "utf-8", mode: 0o600 });
  writeFileSync(certFile, minted.certificatePem, "utf-8");
  return { keyFile, certFile };
}

/**
 * Removes a list from the signing configuration and from the publication store.
 *
 * A list key names one published list, and both `createTrustedListList` and the
 * store refuse to overwrite one. Regenerating therefore means removing the
 * previous run's list first — which is safe here and nowhere else, because
 * these keys belong to this script.
 */
function forget(listKey) {
  rmSync(resolve(PUBLICATION_DIR, listKey), { recursive: true, force: true });
  if (!existsSync(SIGNING_CONFIG)) return;
  const config = JSON.parse(readFileSync(SIGNING_CONFIG, "utf-8"));
  if (!Array.isArray(config.lists)) return;
  const kept = config.lists.filter((entry) => entry?.listKey !== listKey);
  if (kept.length === config.lists.length) return;
  writeFileSync(
    SIGNING_CONFIG,
    `${JSON.stringify({ ...config, lists: kept }, null, 2)}\n`,
    "utf-8",
  );
}

const store = new TrustedListStore({ publicationDir: PUBLICATION_DIR });
const inspectorClient = INSPECTOR_URL
  ? new InspectorClient({ baseUrl: INSPECTOR_URL })
  : null;

console.log(
  `\nPublishing ${lists.length} demonstration Trusted Lists into ${PUBLICATION_DIR}` +
    (inspectorClient
      ? `, assessed by ${INSPECTOR_URL}`
      : ". The Trust Inspector is not contacted; set TLP_INSPECTOR_URL to assess them."),
);

const results = [];
for (const list of lists) {
  const listKey = `${TERRITORY}_${list.name}`.toLowerCase();
  forget(listKey);
  const { keyFile, certFile } = signingMaterialFor(list.name);

  process.stdout.write(`${list.name.padEnd(38)} `);
  const result = await createTrustedListList(
    {
      listKey,
      schemeOperatorName: list.name,
      schemeTerritory: TERRITORY,
      schemeName: `${TERRITORY}:${list.name}`,
      schemeOperatorStreet: "Via della Conciliazione 1",
      schemeOperatorLocality: "Roma",
      schemeOperatorPostalCode: "00193",
      schemeOperatorCountry: TERRITORY,
      schemeOperatorEmail: `demo@${list.name}.example`,
      schemeOperatorWebsite: `https://tsl.credimi.io/demo/${list.name}`,
      schemeInformationUri: `https://tsl.credimi.io/demo/${list.name}/scheme`,
      nationalSchemeRulesUri: `https://tsl.credimi.io/demo/${list.name}/rules`,
      policyUri: `https://tsl.credimi.io/demo/${list.name}/policy`,
      distributionPointUri: `https://tsl.credimi.io/demo/${list.name}/trusted-list.xml`,
      lotlCertificatesBase64Der: [lotlBase64Der],
      lotlSchemeOperatorNames: ["European Commission Demo"],
      keyFile,
      certFile,
      allowedServiceProfiles: [list.family],
      defects: list.defects,
      /*
        Every demo list carries one provider, including the healthy baselines.
        An empty list is what a *newly created* list looks like; a demonstration
        list should show a published service, and it is also what makes the
        healthy and broken lists comparable.
      */
      seedFixtureProvider: true,
    },
    {
      store,
      signingConfigPath: SIGNING_CONFIG,
      inspectorClient,
    },
  );

  if (!result.success) {
    console.log(`FAILED: ${result.error}`);
    results.push({ name: list.name, ok: false, error: result.error });
    continue;
  }

  const status = result.inspector?.summary.status ?? "not assessed";
  const local = result.fixture?.actualFailures.local ?? [];
  console.log(
    `${result.listKey.padEnd(34)} inspector=${status.padEnd(11)} local=[${local.join(" ")}]`,
  );
  results.push({
    name: list.name,
    ok: true,
    listKey: result.listKey,
    family: list.family,
    defects: list.defects,
    note: list.note,
    inspectorStatus: result.inspector?.summary.status ?? null,
    inspectorArtifactKind: result.inspector?.summary.artifactKind ?? null,
    localFailures: local,
    expectedInspectorFailures: result.fixture?.expectedFailures.inspector ?? [],
    matchedFailures: result.fixture?.matchedFailures ?? [],
    missingFailures: result.fixture?.missingFailures ?? [],
    additionalFailures: result.fixture?.additionalFailures ?? [],
  });
}

console.log("\n=== SUMMARY ===");
for (const entry of results) {
  if (!entry.ok) {
    console.log(`${entry.name}: FAILED — ${entry.error}`);
    continue;
  }
  console.log(
    `${entry.listKey.padEnd(34)} ${(entry.defects.join(", ") || "healthy").padEnd(24)} ${entry.note}`,
  );
}

const failed = results.filter((entry) => !entry.ok).length;
console.log(
  `\n${results.length - failed}/${results.length} lists published.` +
    (inspectorClient
      ? ""
      : " Set TLP_INSPECTOR_URL to have them assessed on publication."),
);
process.exit(failed === 0 ? 0 : 1);
