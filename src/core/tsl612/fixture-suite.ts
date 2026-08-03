/**
 * The deterministic EAA and QEAA fixture suites.
 *
 * One healthy baseline, one list per supported defect, and one combined list
 * carrying exactly two compatible defects — per family, at stable keys:
 *
 *   eaa-healthy    eaa-broken-<defect-id>    eaa-broken-combined
 *   qeaa-healthy   qeaa-broken-<defect-id>   qeaa-broken-combined
 *
 * Every fixture is produced by the same `createTrustedListList` the
 * administration form calls, with the same signing material and the same
 * publication instant. A single-defect fixture is therefore a delta of exactly
 * one mutation from the healthy baseline, and the suite as a whole is
 * reproducible: run it twice with the same clock and the same key and the same
 * bytes come out.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mintCertificate } from "../authoring/defects.js";
import { createTrustedListList } from "./create-list.js";
import { xmlDefects } from "./defects.js";
import { TSL_PROFILE_REGISTRY, type TslFamily } from "./registry.js";
import type { TrustedListStore } from "../publication/tsl-store.js";
import type { InspectorClient } from "../inspector/inspector.js";
import type { FixtureMetadata } from "../defects/fixture-metadata.js";

/**
 * The two defects the combined fixture carries.
 *
 * They are compatible in the strict sense the prompt asks for: they touch
 * different elements, neither prevents the other from being observed, and
 * neither stops the artifact being parsed and classified. Pairing a
 * parse-breaking defect with anything else would produce a fixture that only
 * ever demonstrates the first failure.
 */
export const COMBINED_DEFECTS: readonly string[] = Object.freeze([
  "invalid_tsl_version_identifier",
  "expired_next_update",
]);

/** The stable key of one fixture. */
export function fixtureKey(
  family: TslFamily,
  fixture: "healthy" | "combined" | { defect: string },
): string {
  const prefix = family === "qeaa-providers" ? "qeaa" : "eaa";
  if (fixture === "healthy") return `${prefix}-healthy`;
  if (fixture === "combined") return `${prefix}-broken-combined`;
  return `${prefix}-broken-${fixture.defect}`;
}

/** Every key the suite publishes for one family, in generation order. */
export function fixtureKeys(family: TslFamily): string[] {
  return [
    fixtureKey(family, "healthy"),
    ...xmlDefects().map((defect) => fixtureKey(family, { defect: defect.id })),
    fixtureKey(family, "combined"),
  ];
}

export interface FixtureSuiteOptions {
  readonly store: TrustedListStore;
  readonly signingConfigPath: string;
  /** Where the suite's signing material is written. */
  readonly certificatesDir: string;
  readonly families?: readonly TslFamily[];
  /**
   * Supplied only for an explicitly authorized live run. Absent means the suite
   * is generated entirely offline and every fixture's actual Inspector failure
   * set is empty, which is recorded as such and never as a pass.
   */
  readonly inspectorClient?: InspectorClient | null;
  readonly publicBaseUrl?: string;
  readonly now?: () => Date;
}

export interface GeneratedFixture {
  readonly listKey: string;
  readonly family: TslFamily;
  readonly defects: readonly string[];
  readonly sequenceNumber: number;
  readonly fixture?: FixtureMetadata;
  readonly inspectorStatus?: string;
  readonly inspectorArtifactKind?: string;
  readonly error?: string;
}

/** The LOTL pointer material every fixture publishes. */
const LOTL_FIXTURE_CERTIFICATE_SUBJECT = {
  commonName: "EU LOTL Fixture Signer",
  organisation: "European Commission Fixture",
  country: "BE",
};

const TERRITORY = "IT";

function operatorNameFor(family: TslFamily): string {
  return `${TSL_PROFILE_REGISTRY[family].label} Fixture Scheme Operator`;
}

/**
 * Generates every fixture of every requested family.
 *
 * A failing fixture is recorded and the run continues: one defect that cannot
 * be produced must not hide the twenty that can, and the caller decides what a
 * missing fixture means.
 */
export async function generateTrustedListFixtureSuite(
  options: FixtureSuiteOptions,
): Promise<GeneratedFixture[]> {
  const families = options.families ?? [
    "eaa-providers" as const,
    "qeaa-providers" as const,
  ];
  const now = options.now ?? (() => new Date());
  mkdirSync(options.certificatesDir, { recursive: true, mode: 0o700 });

  /* One LOTL pointer identity for the whole suite: the pointer is context, not
     the thing under test, so it must not vary between fixtures. */
  const lotl = mintCertificate(LOTL_FIXTURE_CERTIFICATE_SUBJECT);
  if (!lotl)
    throw new Error(
      "The fixture suite needs openssl to mint the LOTL pointer certificate.",
    );
  const lotlBase64Der = lotl.certificatePem
    .replace(/-----[^-]+-----/g, "")
    .replace(/\s+/g, "");

  const generated: GeneratedFixture[] = [];
  for (const family of families) {
    const operator = operatorNameFor(family);
    const signer = mintCertificate({
      commonName: `${operator} Signer`.slice(0, 64),
      organisation: operator,
      country: TERRITORY,
      trustedListProfile: true,
    });
    if (!signer)
      throw new Error(
        `The fixture suite needs openssl to mint the ${family} signing certificate.`,
      );
    const familyDir = join(options.certificatesDir, family);
    mkdirSync(familyDir, { recursive: true, mode: 0o700 });
    const keyFile = join(familyDir, "signing-key.pem");
    const certFile = join(familyDir, "signing-cert.pem");
    writeFileSync(keyFile, signer.privateKeyPem, {
      encoding: "utf-8",
      mode: 0o600,
    });
    writeFileSync(certFile, signer.certificatePem, { encoding: "utf-8" });

    const selections: { key: string; defects: readonly string[] }[] = [
      { key: fixtureKey(family, "healthy"), defects: [] },
      ...xmlDefects().map((defect) => ({
        key: fixtureKey(family, { defect: defect.id }),
        defects: [defect.id],
      })),
      { key: fixtureKey(family, "combined"), defects: COMBINED_DEFECTS },
    ];

    for (const selection of selections) {
      const result = await createTrustedListList(
        {
          listKey: selection.key,
          schemeOperatorName: operator,
          schemeTerritory: TERRITORY,
          schemeName: `${TERRITORY}:${operator}`,
          schemeOperatorStreet: "1 Fixture Street",
          schemeOperatorLocality: "Rome",
          schemeOperatorPostalCode: "00100",
          schemeOperatorCountry: TERRITORY,
          schemeOperatorEmail: "fixtures@trusted-list.example",
          schemeOperatorWebsite: "https://trusted-list.example",
          schemeInformationUri: "https://trusted-list.example/scheme",
          nationalSchemeRulesUri: "https://trusted-list.example/rules",
          policyUri: "https://trusted-list.example/policy",
          distributionPointUri: `https://trusted-list.example/${selection.key}/trusted-list.xml`,
          lotlCertificatesBase64Der: [lotlBase64Der],
          lotlSchemeOperatorNames: ["European Commission Fixture"],
          keyFile,
          certFile,
          allowedServiceProfiles: [family],
          defects: selection.defects,
          /* The healthy baseline seeds the same provider the broken fixtures
             mutate, so a single-defect fixture differs from it by one mutation
             and nothing else. */
          seedFixtureProvider: true,
        },
        {
          store: options.store,
          signingConfigPath: options.signingConfigPath,
          ...(options.inspectorClient
            ? { inspectorClient: options.inspectorClient }
            : { inspectorClient: null }),
          ...(options.publicBaseUrl
            ? { publicBaseUrl: options.publicBaseUrl }
            : {}),
          now,
        },
      );
      generated.push(
        result.success
          ? {
              listKey: selection.key,
              family,
              defects: selection.defects,
              sequenceNumber: result.sequenceNumber,
              ...(result.fixture ? { fixture: result.fixture } : {}),
              ...(result.inspector
                ? {
                    inspectorStatus: result.inspector.summary.status,
                    ...(result.inspector.summary.artifactKind
                      ? {
                          inspectorArtifactKind:
                            result.inspector.summary.artifactKind,
                        }
                      : {}),
                  }
                : {}),
            }
          : {
              listKey: selection.key,
              family,
              defects: selection.defects,
              sequenceNumber: 0,
              error: result.error,
            },
      );
    }
  }
  return generated;
}
