/**
 * Visual markers for intentionally broken Trusted Lists.
 *
 * A broken list looks, at a glance, exactly like a healthy one that happens to
 * be failing — same table row, same failing Inspector verdict. Everywhere a list
 * can be chosen or inspected, it therefore carries an explicit marker, so nobody
 * onboards to a deliberately bad list by accident and nobody reports its failing
 * verdict as a bug.
 */

import {
  defectForStandard,
  type DefectStage,
  type DefectStandard,
} from "../../core/defects/registry.js";

/** When a mutation ran, in words a reader does not have to decode. */
export function stageLabel(stage: DefectStage): string {
  if (stage === "post-sign") return "after signing";
  if (stage === "publication") return "when the artifact was published";
  return "before signing";
}

/** Sticker placed next to a list name wherever the list is named. */
export function brokenBadge(): string {
  return `<span class="badge badge-warning" title="Intentionally broken test fixture">&#9888; Broken</span>`;
}

/**
 * The defect IDs a version was generated with, read from the negative-fixture
 * metadata stored beside it. Returns an empty array for a healthy version, so
 * callers can treat "not broken" and "no metadata" identically.
 */
export function defectIdsFromFixture(metadataJson: string | null): string[] {
  if (!metadataJson) return [];
  try {
    const parsed = JSON.parse(metadataJson) as { selectedDefects?: unknown };
    if (!Array.isArray(parsed.selectedDefects)) return [];
    return parsed.selectedDefects.filter(
      (id): id is string => typeof id === "string",
    );
  } catch {
    return [];
  }
}

/** Compact one-line-per-defect summary for the catalogue's Broken column. */
export function brokenColumnHtml(
  defectIds: readonly string[],
  standard: DefectStandard = "TS 119 602",
): string {
  if (defectIds.length === 0) return "&mdash;";
  const items = defectIds
    .map((id) => {
      const spec = defectForStandard(id, standard);
      const label = spec ? spec.label : id;
      return `<li title="${escapeHtml(spec?.normativeReference ?? id)}">${escapeHtml(label)}</li>`;
    })
    .join("");
  return `${brokenBadge()}<ul class="broken-defect-list">${items}</ul>`;
}

/**
 * The explanatory section placed at the top of a broken list's page: what is
 * wrong, what a conformant list would do instead, and the clause each mutation
 * violates.
 */
export function brokenListSectionHtml(
  defectIds: readonly string[],
  standard: DefectStandard = "TS 119 602",
): string {
  if (defectIds.length === 0) return "";
  const rows = defectIds
    .map((id) => {
      const spec = defectForStandard(id, standard);
      if (!spec)
        return `<tr><td colspan="4"><code>${escapeHtml(id)}</code> &mdash; unknown defect</td></tr>`;
      return `
      <tr>
        <td><strong>${escapeHtml(spec.label)}</strong><br><code>${escapeHtml(spec.id)}</code></td>
        <td>${escapeHtml(spec.description)}${
          spec.familyNote
            ? `<br><em class="field-help">${escapeHtml(spec.familyNote)}</em>`
            : ""
        }</td>
        <td>${escapeHtml(spec.conformantBehaviour)}</td>
        <td>${escapeHtml(spec.normativeReference)}<br><span class="field-help">Applied ${escapeHtml(stageLabel(spec.stage))}. Expected Inspector rule${spec.expectedRuleIds.length === 1 ? "" : "s"}: ${spec.expectedRuleIds
          .map((rule) => `<code>${escapeHtml(rule)}</code>`)
          .join(", ")}</span></td>
      </tr>`;
    })
    .join("");
  return `
<div class="notice notice-warning">
  <strong>&#9888; Intentionally broken test fixture.</strong>
  This Trusted List was generated deliberately non-conformant, with
  ${defectIds.length} defect${defectIds.length === 1 ? "" : "s"} listed below. It
  exists so an EUDI implementation can register against a list that is known to
  be bad and confirm its runtime detects the problem. <strong>A failing Trust
  Inspector verdict on this list is the expected outcome, not a publication
  error.</strong> Do not use it as a source of trust.
</div>
<div class="card">
  <h2>What is broken in this list</h2>
  <table class="catalogue-table">
    <thead><tr><th>Defect</th><th>What this list does</th><th>What a conformant list does</th><th>Normative reference</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <p class="field-help">Each defect cites the clause it violates. The artifact
  format is ${standard === "TS 119 612" ? "XML / XAdES-B-B" : "JSON / Compact JAdES"}. Cascading failures are expected: one mutation can trip
  several Inspector rules. Each version page records the expected failures
  against the ones actually reported.</p>
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
