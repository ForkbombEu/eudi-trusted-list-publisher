import {
  LIST_DEFECTS,
  deriveListKeyFromParts,
} from "../../core/authoring/list-creation.js";
import { PROFILE_REGISTRY } from "../../core/profiles/registry.js";
import { familyChip, listChip } from "./colors.js";

/**
 * The administration form that creates a Trusted List, and the confirmation
 * shown after one is created.
 *
 * The broken-list options generate an intentionally broken test fixture: the
 * list is compiled healthy, cloned, mutated by the selected defects, signed and
 * published. A failing Trust Inspector verdict on such a list is the expected
 * outcome, so the confirmation states plainly which defects were applied rather
 * than presenting the failure as an error.
 */

export interface CreateListFormValues {
  family?: string;
  schemeName?: string;
  schemeOperatorName?: string;
  schemeTerritory?: string;
  schemeOperatorStreet?: string;
  schemeOperatorCountry?: string;
  schemeOperatorEmail?: string;
  baseUrl?: string;
  keyFile?: string;
  certFile?: string;
}

function defectOptions(): string {
  return LIST_DEFECTS.map(
    (defect) => `
      <label class="tl-broken-option">
        <input type="checkbox" name="defects" value="${escape(defect.id)}">
        <span><strong>${escape(defect.label)}</strong>
        <span class="field-help">${escape(defect.description)}</span></span>
      </label>`,
  ).join("");
}

export function createListFormHtml(
  values?: CreateListFormValues,
  error?: string,
): string {
  const v = values ?? {};
  const families = Object.values(PROFILE_REGISTRY).filter(
    (profile) => profile.enabled,
  );
  const derivedKey =
    v.schemeTerritory && v.schemeOperatorName
      ? deriveListKeyFromParts(v.schemeTerritory, v.schemeOperatorName)
      : null;

  return `
<h1>Create Trusted List</h1>
<p class="lead lead-wide">Declare a Trusted List and publish its first, empty
version. The list becomes selectable on the onboarding forms of its family, and
its version 1 is signed and assessed by the Trust Inspector immediately.</p>

${error ? `<div class="notice notice-error">${escape(error)}</div>` : ""}

<form method="post" action="/admin/lists/create" class="onboarding-form tl-create-form">
  <div class="card">
    <h2>List</h2>
    <div class="form-group">
      <label for="family">Trusted List Family <span class="required">*</span></label>
      <select id="family" name="family" required>
        <option value="">-- Select --</option>
        ${families
          .map(
            (profile) =>
              `<option value="${escape(profile.family)}"${
                v.family === profile.family ? " selected" : ""
              }>${escape(profile.label)}</option>`,
          )
          .join("")}
      </select>
      <span class="field-help">Only the implemented families are offered.</span>
    </div>
    <div class="form-group">
      <label for="schemeName">Trusted List Name <span class="required">*</span></label>
      <input type="text" id="schemeName" name="schemeName" required maxlength="200"
        value="${escape(v.schemeName ?? "")}" placeholder="EU Wallet Providers List">
      <span class="field-help">Published as SchemeName, prefixed with the
        territory as clause 6.3.6 requires.</span>
    </div>
    <div class="form-group">
      <label for="schemeTerritory">Scheme Territory <span class="required">*</span></label>
      <input type="text" id="schemeTerritory" name="schemeTerritory" required
        maxlength="2" pattern="[A-Z]{2}" value="${escape(v.schemeTerritory ?? "EU")}">
      <span class="field-help">Two-letter code. The Annex D to H profiles
        use <code>EU</code>.</span>
    </div>
  </div>

  <div class="card">
    <h2>Scheme Operator</h2>
    <div class="form-group">
      <label for="schemeOperatorName">Operator Name <span class="required">*</span></label>
      <input type="text" id="schemeOperatorName" name="schemeOperatorName" required
        maxlength="120" value="${escape(v.schemeOperatorName ?? "")}">
      <span class="field-help">The publication list key is derived from the
        territory and this name, so it must be unique within the territory.${
          derivedKey
            ? ` Current value derives <code>${escape(derivedKey)}</code>.`
            : ""
        } The signing certificate's subject organisation must equal it.</span>
    </div>
    <div class="form-group">
      <label for="schemeOperatorStreet">Street Address <span class="required">*</span></label>
      <input type="text" id="schemeOperatorStreet" name="schemeOperatorStreet" required
        maxlength="300" value="${escape(v.schemeOperatorStreet ?? "")}">
    </div>
    <div class="form-group">
      <label for="schemeOperatorCountry">Country <span class="required">*</span></label>
      <input type="text" id="schemeOperatorCountry" name="schemeOperatorCountry" required
        maxlength="2" pattern="[A-Z]{2}" value="${escape(v.schemeOperatorCountry ?? "")}"
        placeholder="IT">
    </div>
    <div class="form-group">
      <label for="schemeOperatorEmail">Email <span class="required">*</span></label>
      <input type="email" id="schemeOperatorEmail" name="schemeOperatorEmail" required
        maxlength="200" value="${escape(v.schemeOperatorEmail ?? "")}">
      <span class="field-help">Published as a <code>mailto:</code> URI beside the
        website; both are required by clauses 6.3.5.1 and 6.3.5.2.</span>
    </div>
    <div class="form-group">
      <label for="baseUrl">Public Base URL <span class="required">*</span></label>
      <input type="url" id="baseUrl" name="baseUrl" required maxlength="400"
        value="${escape(v.baseUrl ?? "")}" placeholder="https://example.eu/wallet-providers">
      <span class="field-help">The website, the two scheme information URIs, the
        policy URI and the distribution point are derived from it:
        <code>/scheme</code>, <code>/practice-statement</code>,
        <code>/policy</code>, <code>/latest</code>.</span>
    </div>
  </div>

  <div class="card">
    <h2>Signing Material</h2>
    <p class="field-help">Server-side paths to the list's signing key and
    certificate. The private key is read by the publisher and never uploaded
    through this form.</p>
    <div class="form-group">
      <label for="keyFile">Private Key File <span class="required">*</span></label>
      <input type="text" id="keyFile" name="keyFile" required maxlength="500"
        value="${escape(v.keyFile ?? "")}" placeholder="/etc/credimi/wallet-signer-key.pem">
    </div>
    <div class="form-group">
      <label for="certFile">Certificate File <span class="required">*</span></label>
      <input type="text" id="certFile" name="certFile" required maxlength="500"
        value="${escape(v.certFile ?? "")}" placeholder="/etc/credimi/wallet-signer-cert.pem">
      <span class="field-help">Its subject must match the scheme metadata, or the
        Inspector reports a signer subject mismatch: organisation
        (<code>O</code>) exactly the operator name above, and country
        (<code>C</code>) the scheme territory — <code>EU</code> for the
        Annex D to H profiles.</span>
    </div>
  </div>

  <div class="card">
    <h2>Health</h2>
    <div class="form-group">
      <label class="tl-broken-option">
        <input type="radio" name="health" value="healthy" checked>
        <span><strong>Healthy</strong>
        <span class="field-help">Conformant with the Annex D to H rules this
        publisher implements.</span></span>
      </label>
    </div>
    <fieldset>
      <legend>Broken <span class="badge badge-warning">Intentionally broken test fixture</span></legend>
      <p class="field-help">Select one defect, or several to combine them. The
      list is generated healthy first, then mutated, signed and published, and
      the Trust Inspector verdict is stored beside it. A failing verdict is the
      expected outcome for these lists, not a publication error &mdash; they
      exist so an implementation can be tested against a list that is known to
      be bad. The selection is remembered, so every later version of the list,
      including one published when an entity is registered, is mutated the same
      way.</p>
      <div class="tl-broken-options">${defectOptions()}
      </div>
    </fieldset>
  </div>

  <div class="form-actions">
    <button type="submit" class="btn btn-primary btn-md">Create Trusted List</button>
    <a href="/admin" class="btn btn-outline btn-md">Cancel</a>
  </div>
</form>
`;
}

export interface CreatedListSummary {
  listKey: string;
  family: string;
  schemeName: string;
  sequenceNumber: number;
  inspectorStatus: string;
  inspectorProfile?: string;
  inspectorLevel?: string;
  /** Defect IDs applied, empty for a healthy list. */
  defects?: string[];
  expectedInspectorFailures?: string[];
  actualInspectorFailures?: string[];
  missingFailures?: string[];
}

export function createdListHtml(summary: CreatedListSummary): string {
  const defects = summary.defects ?? [];
  const broken = defects.length > 0;
  return `
<h1>Trusted List created</h1>
${
  broken
    ? `<div class="notice notice-warning"><strong>Intentionally broken test
fixture.</strong> This list was generated with ${defects.length} selected
defect${defects.length > 1 ? "s" : ""}. A failing Trust Inspector verdict is the
expected outcome, not a publication error.</div>`
    : ""
}
<div class="card">
  <table class="kv-table">
    <tr><th>Trusted List</th><td>${listChip(summary.listKey)}</td></tr>
    <tr><th>Trusted List Family</th><td>${familyChip(summary.family, summary.family)}</td></tr>
    <tr><th>Name</th><td>${escape(summary.schemeName)}</td></tr>
    <tr><th>First version</th><td>${summary.sequenceNumber}</td></tr>
    <tr><th>Inspector status</th><td>${escape(summary.inspectorStatus)}</td></tr>
    ${
      summary.inspectorProfile
        ? `<tr><th>Detected profile</th><td>${escape(summary.inspectorProfile)}</td></tr>`
        : ""
    }
    ${
      summary.inspectorLevel
        ? `<tr><th>Conformance level</th><td>${escape(summary.inspectorLevel)}</td></tr>`
        : ""
    }
    ${
      broken
        ? `<tr><th>Selected defects</th><td>${defectLabels(defects)}</td></tr>
    <tr><th>Expected failures</th><td>${ruleList(summary.expectedInspectorFailures)}</td></tr>
    <tr><th>Actual failures</th><td>${ruleList(summary.actualInspectorFailures)}</td></tr>
    ${
      (summary.missingFailures ?? []).length > 0
        ? `<tr><th>Expected but not reported</th><td>${ruleList(summary.missingFailures)}</td></tr>`
        : ""
    }`
        : ""
    }
  </table>
  <p class="version-downloads">
    <a class="btn btn-primary btn-md" href="/lists/${encodeURIComponent(summary.listKey)}/versions/${summary.sequenceNumber}">Open version page</a>
    <a class="btn btn-outline btn-md" href="/admin/lists/create">Create another</a>
    <a class="btn btn-outline btn-md" href="/admin">Back to Administration</a>
  </p>
</div>
`;
}

/** Defect IDs rendered with their catalogue labels. */
function defectLabels(ids: readonly string[]): string {
  return ids
    .map((id) => {
      const defect = LIST_DEFECTS.find((candidate) => candidate.id === id);
      return `<code>${escape(id)}</code>${defect ? ` &mdash; ${escape(defect.label)}` : ""}`;
    })
    .join("<br>");
}

function ruleList(rules: readonly string[] | undefined): string {
  if (!rules || rules.length === 0) return "<em>none</em>";
  return rules.map((rule) => `<code>${escape(rule)}</code>`).join("<br>");
}

function escape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
