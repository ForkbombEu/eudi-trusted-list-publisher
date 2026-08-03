/**
 * Trust Inspector client.
 *
 * The Inspector (WE BUILD Trusted List Audit API) assesses a Trusted List
 * artifact and reports which requirements it satisfies.
 *
 * What gets submitted is always the *signed* artifact, never a decoded one:
 * half the requirements are signature requirements, and a decoded document
 * carries no signature evidence at all. For TS 119 602 that is the Compact
 * JAdES serialization; for TS 119 612 it is the signed XML Trusted List, whose
 * XAdES signature is inside the file.
 *
 * The Inspector answers under `ts119602` or `ts119612` depending on which
 * standard it decided applies, so the summary records which section it read.
 */

export const DEFAULT_INSPECTOR_BASE_URL = "https://trust-inspector.credimi.io";
const ARTIFACT_PATH = "/api/audit/artifact";
/** The media type a TS 119 612 Trusted List is submitted and served under. */
const TSL_XML_CONTENT_TYPE = "application/vnd.etsi.tsl+xml";
export const INSPECTOR_EVALUATION_SCHEMA_VERSION = 1;

/** Statuses a single Inspector check can carry. */
export type InspectorCheckStatus =
  | "pass"
  | "fail"
  | "warn"
  | "not_applicable"
  | "not_checked"
  | "unsupported"
  | "inconclusive";

export type InspectorConformanceLevel =
  | "conformant"
  | "partially_conformant"
  | "non_conformant"
  | "not_applicable"
  | "not_checked"
  | "unsupported"
  | "inconclusive"
  | "fetch_failed"
  | "parse_failed";

export interface InspectorCheck {
  id: string;
  category: string;
  status: InspectorCheckStatus;
  severity: string;
  message: string;
  evidence?: unknown;
}

/**
 * What the version page shows. It is derived once, when the evaluation is
 * stored, so the page never has to re-interpret the raw report.
 */
export type InspectorStandard = "TS 119 602" | "TS 119 612";

export interface InspectorSummary {
  /**
   * `pass` and `fail` are Inspector verdicts. `unavailable` means no verdict
   * was obtained — the Inspector could not be reached, or it answered without
   * assessing the artifact against the standard that was submitted.
   *
   * There is deliberately no fourth value. A `not_applicable` standard, an
   * unclassified artifact and a section with no checks in it are all "no
   * verdict", and reporting any of them as `pass` would let a fixture that the
   * Inspector never looked at be presented as conformant.
   */
  status: "pass" | "fail" | "unavailable";
  /** Reason the assessment is unavailable. */
  error?: string;
  /**
   * The Inspector's `standardApplicability` block, recorded verbatim. It is
   * what says whether the artifact was assessed against TS 119 612 at all.
   */
  standardApplicability?: Record<string, string>;
  /** How the Inspector classified the artifact, e.g. `ts119612_xml_tsl`. */
  artifactKind?: string;
  evaluatedAt: string;
  inspectorBaseUrl: string;
  /** Which standard's check section the verdict was read from. */
  standard?: InspectorStandard;
  /**
   * The service type identifiers the submitted artifact publishes.
   *
   * The Inspector's `extracted` block does not return them, so they are read
   * from the artifact by this publisher and recorded here. They are stated as
   * what was submitted, not as something the Inspector detected on its own.
   */
  serviceTypes?: string[];
  /** Detected family/profile, e.g. `wallet_providers`. */
  profile?: string;
  profileStatus?: string;
  detectedFormat?: string;
  detectedArtifactKind?: string;
  conformanceLevel?: InspectorConformanceLevel;
  score?: number | null;
  counts?: {
    pass: number;
    fail: number;
    warn: number;
    notApplicable: number;
    notChecked: number;
    other: number;
  };
  /**
   * Failures the Inspector could decide from the artifact alone. External trust
   * decisions stay out of this list, so a clean list can be recognised without
   * a network trust evaluation.
   */
  locallyDecidableFailures?: string[];
  mandatoryFailures?: string[];
}

/** The stored artifact: the complete Inspector response plus the summary. */
export interface InspectorEvaluation {
  schemaVersion: typeof INSPECTOR_EVALUATION_SCHEMA_VERSION;
  summary: InspectorSummary;
  /** Complete, unmodified Inspector response body. Absent when unavailable. */
  report?: unknown;
}

export interface InspectorRequest {
  /** Compact JAdES serialization — the TS 119 602 artifact. */
  compactJades?: string;
  /** Signed XML Trusted List — the TS 119 612 artifact. */
  trustedListXml?: string;
  /** Free-text origin recorded in the report, e.g. the version URL. */
  source: string;
  /** Declared metadata that helps the Inspector classify the artifact. */
  declared?: {
    mimeType?: string;
    loteType?: string;
    schemeOperatorName?: string;
    schemeTerritory?: string;
  };
  /** Service types read from the artifact, recorded in the summary. */
  serviceTypes?: readonly string[];
}

export interface InspectorClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

interface RawSection {
  applicable?: boolean;
  conformanceLevel?: InspectorConformanceLevel;
  score?: number | null;
  checks?: InspectorCheck[];
  mandatoryFailures?: string[];
}

interface RawResult {
  detected?: { format?: string; artifactKind?: string };
  ts119602Classification?: { profile?: string; profileStatus?: string };
  ts119602?: RawSection;
  ts119612?: RawSection;
  standardApplicability?: Record<string, string>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A check the Inspector decided from the artifact itself. Everything the
 * Inspector could only decide by dereferencing or by evaluating external trust
 * reports a non-`fail` status, so a `fail` here is always locally decidable —
 * but the category is recorded so the distinction stays visible.
 */
function locallyDecidable(check: InspectorCheck): boolean {
  return check.status === "fail" && check.category !== "fetch";
}

function countChecks(checks: InspectorCheck[]): InspectorSummary["counts"] {
  const counts = {
    pass: 0,
    fail: 0,
    warn: 0,
    notApplicable: 0,
    notChecked: 0,
    other: 0,
  };
  for (const check of checks) {
    if (check.status === "pass") counts.pass += 1;
    else if (check.status === "fail") counts.fail += 1;
    else if (check.status === "warn") counts.warn += 1;
    else if (check.status === "not_applicable") counts.notApplicable += 1;
    else if (check.status === "not_checked") counts.notChecked += 1;
    else counts.other += 1;
  }
  return counts;
}

export class InspectorClient {
  readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;

  constructor(options: InspectorClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_INSPECTOR_BASE_URL).replace(
      /\/+$/,
      "",
    );
    this.timeoutMs = options.timeoutMs ?? 30000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Submits the artifact and returns the evaluation. It never throws: an
   * Inspector that cannot be reached is a fact about the evaluation, not a
   * reason to fail a publication that is otherwise complete.
   */
  async assess(request: InspectorRequest): Promise<InspectorEvaluation> {
    const evaluatedAt = this.now().toISOString();
    const unavailable = (error: string): InspectorEvaluation => ({
      schemaVersion: INSPECTOR_EVALUATION_SCHEMA_VERSION,
      summary: {
        status: "unavailable",
        error,
        evaluatedAt,
        inspectorBaseUrl: this.baseUrl,
      },
    });

    const isXml = typeof request.trustedListXml === "string";
    const content = isXml ? request.trustedListXml! : request.compactJades;
    if (typeof content !== "string" || content === "")
      return unavailable(
        "No artifact was supplied to assess: pass either compactJades or trustedListXml.",
      );
    if (isXml && typeof request.compactJades === "string")
      return unavailable(
        "Both a Compact JAdES and an XML Trusted List were supplied; exactly one artifact is assessed at a time.",
      );
    const contentType = isXml ? TSL_XML_CONTENT_TYPE : "application/jose";

    let body: unknown;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetchImpl(
          `${this.baseUrl}${ARTIFACT_PATH}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              content,
              source: request.source,
              contentType,
              ...(request.declared
                ? {
                    declared: {
                      ...request.declared,
                      pointerCertificateFingerprintsSha256: [],
                    },
                  }
                : {}),
              options: { timeoutMs: this.timeoutMs },
            }),
            signal: controller.signal,
          },
        );
        if (!response.ok)
          return unavailable(
            `Trust Inspector returned HTTP ${response.status} ${response.statusText}.`,
          );
        body = (await response.json()) as unknown;
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      return unavailable(
        `Trust Inspector could not be reached: ${
          error instanceof Error ? error.message : "unknown error"
        }.`,
      );
    }

    if (!isRecord(body) || !isRecord(body.result))
      return unavailable("Trust Inspector response contained no result.");

    const result = body.result as RawResult;
    /*
      The verdict comes from the section for the standard that was submitted.
      Reading the TS 119 602 section for an XML Trusted List would report zero
      checks and call that a pass.
    */
    const section: RawSection | undefined = isXml
      ? result.ts119612
      : result.ts119602;
    const checks = Array.isArray(section?.checks) ? section.checks : [];
    const failures = checks.filter(locallyDecidable);
    const applicabilityKey = isXml ? "ts119612" : "ts119602";
    const applicability = result.standardApplicability?.[applicabilityKey];

    /*
      Everything that means "the Inspector produced no verdict about this
      artifact". Each of these would otherwise reach the zero-failures branch
      below and be reported as a pass, which is the one thing an assessment of
      an unassessed artifact must never say.
    */
    const noVerdict =
      section === undefined
        ? `Trust Inspector returned no ${applicabilityKey} section, so the artifact was not assessed against the standard it was submitted under.`
        : section.applicable === false || applicability === "not_applicable"
          ? `Trust Inspector reported ${applicabilityKey} as not applicable to this artifact${
              result.detected?.artifactKind
                ? `, which it classified as '${result.detected.artifactKind}'`
                : ""
            }. A standard that was not applied cannot have been passed.`
          : applicability === "unknown"
            ? `Trust Inspector could not decide whether ${applicabilityKey} applies to this artifact.`
            : checks.length === 0
              ? `Trust Inspector ran no ${applicabilityKey} check against this artifact.`
              : null;

    if (noVerdict)
      return {
        schemaVersion: INSPECTOR_EVALUATION_SCHEMA_VERSION,
        summary: {
          status: "unavailable",
          error: noVerdict,
          evaluatedAt,
          inspectorBaseUrl: this.baseUrl,
          standard: isXml ? "TS 119 612" : "TS 119 602",
          ...(request.serviceTypes
            ? { serviceTypes: [...request.serviceTypes] }
            : {}),
          ...(result.standardApplicability
            ? { standardApplicability: result.standardApplicability }
            : {}),
          ...(result.detected?.artifactKind
            ? { artifactKind: result.detected.artifactKind }
            : {}),
          detectedFormat: result.detected?.format,
          detectedArtifactKind: result.detected?.artifactKind,
          conformanceLevel: section?.conformanceLevel,
          counts: countChecks(checks),
          locallyDecidableFailures: failures.map(
            (check) => `${check.id}: ${check.message}`,
          ),
        },
        report: body,
      };

    const summary: InspectorSummary = {
      status: failures.length === 0 ? "pass" : "fail",
      evaluatedAt,
      inspectorBaseUrl: this.baseUrl,
      standard: isXml ? "TS 119 612" : "TS 119 602",
      ...(result.standardApplicability
        ? { standardApplicability: result.standardApplicability }
        : {}),
      ...(result.detected?.artifactKind
        ? { artifactKind: result.detected.artifactKind }
        : {}),
      ...(request.serviceTypes
        ? { serviceTypes: [...request.serviceTypes] }
        : {}),
      profile: result.ts119602Classification?.profile,
      profileStatus: result.ts119602Classification?.profileStatus,
      detectedFormat: result.detected?.format,
      detectedArtifactKind: result.detected?.artifactKind,
      conformanceLevel: section?.conformanceLevel,
      score: section?.score ?? null,
      counts: countChecks(checks),
      locallyDecidableFailures: failures.map(
        (check) => `${check.id}: ${check.message}`,
      ),
      mandatoryFailures: section?.mandatoryFailures ?? [],
    };
    return {
      schemaVersion: INSPECTOR_EVALUATION_SCHEMA_VERSION,
      summary,
      report: body,
    };
  }
}

/** Human-readable label for the version page. */
export function inspectorStatusLabel(summary: InspectorSummary): string {
  if (summary.status === "pass") return "Pass";
  if (summary.status === "fail") return "Fail";
  return "Unavailable";
}
