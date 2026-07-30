import type {
  InspectorEvaluation,
  InspectorSummary,
} from "../../core/inspector/inspector.js";

/**
 * The Trust Inspector card on a version page, and the three download buttons
 * that belong beside it.
 *
 * The card never claims conformance the Inspector did not establish: when the
 * assessment is unavailable it says so and shows why, and it reports the
 * Inspector's own conformance level rather than deriving one.
 */

/** Reads a stored evaluation. Returns null when the file is absent or unusable. */
export function parseInspectorEvaluation(
  json: string | null,
): InspectorEvaluation | null {
  if (!json) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("summary" in parsed) ||
      typeof (parsed as { summary: unknown }).summary !== "object"
    )
      return null;
    return parsed as InspectorEvaluation;
  } catch {
    return null;
  }
}

const STATUS_BADGE: Record<InspectorSummary["status"], string> = {
  pass: '<span class="badge badge-assurance inspector-status">Pass</span>',
  fail: '<span class="badge badge-danger inspector-status">Fail</span>',
  unavailable:
    '<span class="badge badge-neutral inspector-status">Unavailable</span>',
};

/**
 * `wallet_providers` reads better as `Wallet Providers`. Acronyms are kept
 * upper-case rather than title-cased into `Pid`.
 */
const PROFILE_ACRONYMS = new Set(["pid", "eaa", "qeaa", "wrpac", "wrprc"]);

function profileLabel(profile: string | undefined): string {
  if (!profile || profile === "unknown") return "not detected";
  return profile
    .split("_")
    .map((part) =>
      PROFILE_ACRONYMS.has(part)
        ? part.toUpperCase()
        : part.charAt(0).toUpperCase() + part.slice(1),
    )
    .join(" ");
}

function levelLabel(level: string | undefined): string {
  if (!level) return "not reported";
  return level.replace(/_/g, " ");
}

export function inspectorPanelHtml(
  evaluation: InspectorEvaluation | null,
  listKey: string,
  sequence: number,
): string {
  const reportHref = `/api/v1/lists/${encodeURIComponent(listKey)}/versions/${sequence}/inspector`;
  const buttons = `
<p class="inspector-actions">
  <a class="btn btn-outline btn-md" href="${reportHref}?view=1">View Inspector report</a>
  <a class="btn btn-outline btn-md" href="${reportHref}" download="inspector-${escapeHtml(listKey)}-v${sequence}.json">Download Inspector JSON</a>
</p>`;

  if (!evaluation) {
    return `
<div class="card">
  <h2>Trust Inspector</h2>
  <table class="kv-table">
    <tr><th>Inspector status</th><td>${STATUS_BADGE.unavailable}</td></tr>
    <tr><th>Reason</th><td>No evaluation is stored for this version. It was
    published before external assessment was recorded, or the assessment could
    not be stored.</td></tr>
  </table>
  <p class="field-help">No conformance is claimed for this version: the
  Inspector result is unknown, not clean.</p>
</div>`;
  }

  const summary = evaluation.summary;
  const counts = summary.counts;
  const failures = summary.locallyDecidableFailures ?? [];
  const rows = [
    `<tr><th>Inspector status</th><td>${STATUS_BADGE[summary.status]}</td></tr>`,
    summary.status === "unavailable"
      ? `<tr><th>Reason</th><td>${escapeHtml(summary.error ?? "The Inspector did not answer.")}</td></tr>`
      : "",
    `<tr><th>Detected family / profile</th><td>${escapeHtml(profileLabel(summary.profile))}${
      summary.detectedArtifactKind
        ? ` <span class="field-help">(${escapeHtml(summary.detectedArtifactKind)}, ${escapeHtml(summary.detectedFormat ?? "unknown")})</span>`
        : ""
    }</td></tr>`,
    `<tr><th>TS 119 602 conformance level</th><td>${
      summary.status === "unavailable"
        ? "not evaluated"
        : escapeHtml(levelLabel(summary.conformanceLevel))
    }</td></tr>`,
    counts
      ? `<tr><th>Checks</th><td>${counts.pass} passed, ${counts.fail} failed, ${counts.warn} warned, ${counts.notApplicable} not applicable, ${counts.notChecked} not checked</td></tr>`
      : "",
    `<tr><th>Evaluated</th><td>${escapeHtml(summary.evaluatedAt)}</td></tr>`,
    `<tr><th>Inspector</th><td><code>${escapeHtml(summary.inspectorBaseUrl)}</code></td></tr>`,
  ]
    .filter(Boolean)
    .join("\n");

  const failureList =
    failures.length > 0
      ? `<h3>Locally decidable failures</h3><ul class="inspector-failures">${failures
          .map((failure) => `<li>${escapeHtml(failure)}</li>`)
          .join("")}</ul>`
      : summary.status === "pass"
        ? `<p class="field-help">No locally decidable failure. External trust
        decisions remain <code>not_checked</code>: this tool does not establish
        PKIX trust.</p>`
        : "";

  return `
<div class="card">
  <h2>Trust Inspector</h2>
  <table class="kv-table">
${rows}
  </table>
  ${failureList}
  ${buttons}
</div>`;
}

/** The three download buttons required on every version page. */
export function versionDownloadsHtml(
  listKey: string,
  sequence: number,
): string {
  const base = `/api/v1/lists/${encodeURIComponent(listKey)}/versions/${sequence}`;
  const key = escapeHtml(listKey);
  return `
<div class="card">
  <h2>Downloads</h2>
  <p class="version-downloads">
    <a class="btn btn-primary btn-md" href="${base}/lote?download=1"
      download="${key}-v${sequence}-lote.json">JSON</a>
    <a class="btn btn-primary btn-md" href="${base}/signature?download=1"
      download="${key}-v${sequence}.jades">Compact JAdES</a>
    <a class="btn btn-primary btn-md" href="${base}/inspector"
      download="inspector-${key}-v${sequence}.json">Inspector report</a>
  </p>
  <p class="field-help">JSON is the decoded LoTE. Compact JAdES is the signed
  artifact used for full Inspector validation. The Inspector report is the
  complete stored evaluation. XML is not published yet.</p>
  <p class="field-help"><a href="${base}/manifest">Publication manifest</a></p>
</div>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
