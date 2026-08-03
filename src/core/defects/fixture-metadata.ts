/**
 * The evidence stored beside an intentionally broken version.
 *
 * It is format-independent on purpose. A TS 119 602 JSON fixture and a
 * TS 119 612 XML fixture answer the same questions — which defects were asked
 * for, which mutations landed, what was expected to fail, what actually failed
 * — so they answer them in the same document and the UI renders one panel for
 * both.
 *
 * It sits outside the integrity-checked artifact set for the same reason the
 * Inspector evaluation does: it is evidence *about* a version. The published
 * artifacts stay immutable and are hashed exactly as published, intentionally
 * broken bytes included.
 */
import {
  compareFailures,
  expectedLocalFailuresForStandard,
  expectedRuleIdsForStandard,
  type DefectArtifactFormat,
  type DefectStage,
  type DefectStandard,
} from "./registry.js";

/**
 * Version 2 adds the local-failure axis and the standard/format the fixture
 * belongs to. Version 1 files, written before TS 119 612 fixtures existed,
 * remain on disk and are still read — see `parseFixtureMetadata`.
 */
export const FIXTURE_METADATA_SCHEMA_VERSION = 2;

/** One applied mutation, recorded so the fixture can explain itself. */
export interface AppliedMutation {
  defectId: string;
  stage: DefectStage;
  /** False when the mutation found nothing to change; `detail` says why. */
  applied: boolean;
  detail: string;
}

/**
 * Failures split by who decided them. `local` is this publisher's own schema,
 * signature, certificate, freshness and digest checks; `inspector` is what the
 * Trust Inspector reported.
 */
export interface FixtureFailureSets {
  local: string[];
  inspector: string[];
}

export interface FixtureMetadata {
  schemaVersion: number;
  fixtureMode: "healthy" | "intentionally-broken";
  standard: DefectStandard;
  artifactFormat: DefectArtifactFormat;
  selectedDefects: string[];
  mutations: AppliedMutation[];
  expectedFailures: FixtureFailureSets;
  actualFailures: FixtureFailureSets;
  /** Inspector rules that were expected and did fail. */
  matchedFailures: string[];
  /** Inspector rules that were expected and did not fail. */
  missingFailures: string[];
  /** Inspector rules that failed without being expected. Cascades live here. */
  additionalFailures: string[];
  /** Local checks that were expected to fail and did. */
  matchedLocalFailures: string[];
  missingLocalFailures: string[];
  additionalLocalFailures: string[];
  /**
   * Failures caused by the seeded fixture entity rather than by any selected
   * defect. Split out so `additionalFailures` keeps meaning "this mutation
   * caused something we did not predict".
   */
  knownUnrelatedFailures: string[];
  generatedAt: string;
}

export interface BuildFixtureMetadataInput {
  readonly standard: DefectStandard;
  readonly artifactFormat: DefectArtifactFormat;
  readonly selectedDefects: readonly string[];
  readonly mutations: readonly AppliedMutation[];
  /** Stable local check IDs that failed, e.g. `local.xml.schema`. */
  readonly actualLocalFailures: readonly string[];
  /** Inspector failure lines, `${ruleId}: ${message}`. */
  readonly actualInspectorFailures: readonly string[];
  readonly generatedAt: Date;
  readonly knownUnrelatedFailures?: readonly string[];
}

/**
 * Pairs what the catalogue predicted with what actually happened, on both the
 * local and the Inspector axis. Nothing here decides whether a fixture is
 * "good": a missing expected failure and an unexpected extra one are both
 * recorded and both visible, because a defect catalogue that quietly agrees
 * with reality is a catalogue nobody can check.
 */
export function buildFixtureMetadata(
  input: BuildFixtureMetadataInput,
): FixtureMetadata {
  const expectedInspector = expectedRuleIdsForStandard(
    input.selectedDefects,
    input.standard,
  );
  const expectedLocal = expectedLocalFailuresForStandard(
    input.selectedDefects,
    input.standard,
  );
  const inspector = compareFailures(
    expectedInspector,
    input.actualInspectorFailures,
  );
  const local = compareFailures(expectedLocal, input.actualLocalFailures);
  return {
    schemaVersion: FIXTURE_METADATA_SCHEMA_VERSION,
    fixtureMode:
      input.selectedDefects.length > 0 ? "intentionally-broken" : "healthy",
    standard: input.standard,
    artifactFormat: input.artifactFormat,
    selectedDefects: [...input.selectedDefects],
    mutations: [...input.mutations],
    expectedFailures: {
      local: expectedLocal,
      inspector: expectedInspector,
    },
    actualFailures: {
      local: [...input.actualLocalFailures],
      inspector: [...input.actualInspectorFailures],
    },
    matchedFailures: inspector.matched,
    missingFailures: inspector.missing,
    additionalFailures: inspector.additional,
    matchedLocalFailures: local.matched,
    missingLocalFailures: local.missing,
    additionalLocalFailures: local.additional,
    knownUnrelatedFailures: [...(input.knownUnrelatedFailures ?? [])],
    generatedAt: input.generatedAt.toISOString(),
  };
}

/** The shape version 1 wrote, still present in publications made before v2. */
interface LegacyFixtureMetadataV1 {
  schemaVersion?: number;
  selectedDefects?: unknown;
  mutations?: unknown;
  localValidationFailures?: unknown;
  expectedInspectorFailures?: unknown;
  actualInspectorFailures?: unknown;
  matchedFailures?: unknown;
  missingFailures?: unknown;
  additionalFailures?: unknown;
  knownUnrelatedFailures?: unknown;
  generatedAt?: unknown;
}

const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];

/**
 * Reads stored fixture metadata of either version into the current shape.
 *
 * A version-1 file predates TS 119 612 fixtures, so it is by definition a
 * TS 119 602 JSON one and had no local-failure axis; its free-text local
 * findings are carried across as actual local failures with no expectation
 * against them, which is exactly what was known when it was written.
 */
export function parseFixtureMetadata(json: string): FixtureMetadata | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown> & LegacyFixtureMetadataV1;
  if (typeof record.schemaVersion !== "number") return null;

  if (record.schemaVersion >= FIXTURE_METADATA_SCHEMA_VERSION)
    return parsed as FixtureMetadata;

  const selectedDefects = strings(record.selectedDefects);
  return {
    schemaVersion: record.schemaVersion,
    fixtureMode:
      selectedDefects.length > 0 ? "intentionally-broken" : "healthy",
    standard: "TS 119 602",
    artifactFormat: "JSON / JAdES",
    selectedDefects,
    mutations: Array.isArray(record.mutations)
      ? (record.mutations as AppliedMutation[])
      : [],
    expectedFailures: {
      local: [],
      inspector: strings(record.expectedInspectorFailures),
    },
    actualFailures: {
      local: strings(record.localValidationFailures),
      inspector: strings(record.actualInspectorFailures),
    },
    matchedFailures: strings(record.matchedFailures),
    missingFailures: strings(record.missingFailures),
    additionalFailures: strings(record.additionalFailures),
    matchedLocalFailures: [],
    missingLocalFailures: [],
    additionalLocalFailures: [],
    knownUnrelatedFailures: strings(record.knownUnrelatedFailures),
    generatedAt:
      typeof record.generatedAt === "string" ? record.generatedAt : "",
  };
}
