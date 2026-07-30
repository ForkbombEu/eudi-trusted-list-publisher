/**
 * Trust Inspector client.
 *
 * The Inspector (WE BUILD Trusted List Audit API) assesses a TS 119 602
 * artifact and reports which requirements it satisfies. The Compact JAdES
 * artifact is what gets submitted, never the decoded LoTE: half the Annex D/E
 * requirements are signature requirements, and a decoded LoTE carries no
 * signature evidence at all.
 */

export const DEFAULT_INSPECTOR_BASE_URL = "https://trust-inspector.credimi.io";
const ARTIFACT_PATH = "/api/audit/artifact";
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
export interface InspectorSummary {
  /**
   * `pass` and `fail` are Inspector verdicts; `unavailable` means the Inspector
   * could not be reached or did not answer, and must never be reported as
   * conformance either way.
   */
  status: "pass" | "fail" | "unavailable";
  /** Reason the assessment is unavailable. */
  error?: string;
  evaluatedAt: string;
  inspectorBaseUrl: string;
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
  /** Compact JAdES serialization. */
  compactJades: string;
  /** Free-text origin recorded in the report, e.g. the version URL. */
  source: string;
  /** Declared metadata that helps the Inspector classify the artifact. */
  declared?: {
    mimeType?: string;
    loteType?: string;
    schemeOperatorName?: string;
    schemeTerritory?: string;
  };
}

export interface InspectorClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

interface RawResult {
  detected?: { format?: string; artifactKind?: string };
  ts119602Classification?: { profile?: string; profileStatus?: string };
  ts119602?: {
    applicable?: boolean;
    conformanceLevel?: InspectorConformanceLevel;
    score?: number | null;
    checks?: InspectorCheck[];
    mandatoryFailures?: string[];
  };
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
              content: request.compactJades,
              source: request.source,
              contentType: "application/jose",
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
    const checks = Array.isArray(result.ts119602?.checks)
      ? result.ts119602.checks
      : [];
    const failures = checks.filter(locallyDecidable);
    const summary: InspectorSummary = {
      status: failures.length === 0 ? "pass" : "fail",
      evaluatedAt,
      inspectorBaseUrl: this.baseUrl,
      profile: result.ts119602Classification?.profile,
      profileStatus: result.ts119602Classification?.profileStatus,
      detectedFormat: result.detected?.format,
      detectedArtifactKind: result.detected?.artifactKind,
      conformanceLevel: result.ts119602?.conformanceLevel,
      score: result.ts119602?.score ?? null,
      counts: countChecks(checks),
      locallyDecidableFailures: failures.map(
        (check) => `${check.id}: ${check.message}`,
      ),
      mandatoryFailures: result.ts119602?.mandatoryFailures ?? [],
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
