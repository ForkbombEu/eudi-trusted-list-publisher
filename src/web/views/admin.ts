// @ts-nocheck
import type { WalletProviderApplication } from "../../core/authoring/application-model.js";
import type { SigningConfigEntryDisplay } from "../../core/authoring/signing-config.js";
import { LIST_FAMILIES } from "../../core/authoring/list-family-catalogue.js";

function escape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function adminIndexHtml(): string {
  return `
<h1>Administration</h1>
<div class="test-notice">
  <strong>&#x26A0; Testing tool.</strong> This is a test/debug fixture publisher.
</div>
<div class="card">
  <p><a href="/admin/applications" class="btn">Manage Applications</a></p>
  <p><a href="/admin/signing" class="btn">Signing Configuration</a></p>
</div>
`;
}

export function adminApplicationsHtml(
  apps: WalletProviderApplication[],
  stateFilter?: string,
): string {
  const states = ["submitted", "approved", "rejected", "published"] as const;

  let filterHtml = "";
  for (const s of states) {
    filterHtml += ` <a href="/admin/applications?state=${s}" class="${stateFilter === s ? "btn btn-primary" : "btn"} btn-sm">${s}</a>`;
  }

  if (stateFilter) {
    filterHtml += ` <a href="/admin/applications" class="btn btn-sm">clear filter</a>`;
  }

  const filtered = stateFilter
    ? apps.filter((a) => a.state === stateFilter)
    : apps;

  if (filtered.length === 0) {
    return `
<h1>Applications</h1>
<div class="test-notice"><strong>&#x26A0; Testing tool.</strong></div>
<p>Filter:${filterHtml}</p>
<div class="card"><p>No applications found.</p></div>
<a href="/admin" class="btn">Back to Admin</a>
`;
  }

  let rows = "";
  for (const a of filtered) {
    const familyLabel =
      LIST_FAMILIES.find((f) => f.key === a.family)?.label ?? a.family;
    rows += `
  <tr>
    <td>${escape(a.id.slice(0, 8))}...</td>
    <td>${escape(familyLabel)}</td>
    <td>${escape(a.targetListKey)}</td>
    <td><span class="badge ${stateBadge(a.state)}">${escape(a.state)}</span></td>
    <td>${escape(a.submittedAt)}</td>
    <td><a href="/admin/applications/${escape(a.id)}" class="btn btn-sm">View</a></td>
  </tr>`;
  }

  return `
<h1>Applications</h1>
<div class="test-notice"><strong>&#x26A0; Testing tool.</strong></div>
<p>Filter:${filterHtml}</p>
<table class="catalogue-table">
<thead><tr><th>ID</th><th>Family</th><th>List</th><th>State</th><th>Submitted</th><th></th></tr></thead>
<tbody>${rows}</tbody>
</table>
<p><a href="/admin" class="btn">Back to Admin</a></p>
`;
}

export interface DetailParams {
  error?: string;
  warning?: string;
  success?: string;
  published?: string;
}

export interface EtsiStatus {
  valid: boolean;
  findings: Array<{ path: string; message: string }>;
}

export function adminApplicationDetailHtml(
  app: WalletProviderApplication,
  params?: DetailParams,
  etsiStatus?: EtsiStatus,
  compilerInputJson?: string,
  previewMeta?: {
    existingEntityCount: number;
    resultingEntityCount: number;
    currentSequence: number | null;
    proposedSequence: number | null;
  },
): string {
  const data = app.applicantData;
  const p = params ?? {};

  let messages = "";
  if (p.error) messages += `<div class="error-msg">${escape(p.error)}</div>`;
  if (p.warning) messages += `<div class="warn-msg">${escape(p.warning)}</div>`;
  if (p.success)
    messages += `<div class="success-msg">${escape(p.success)}</div>`;
  if (p.published)
    messages += `<div class="success-msg">&#x2705; ${escape(p.published)}</div>`;

  const servicesHtml = data.services
    .map(
      (svc, i) => `
  <div class="card">
    <h3>Service ${i + 1}</h3>
    <table class="kv-table">
      <tr><th>Type</th><td>${escape(svc.serviceType)}</td></tr>
      <tr><th>Name</th><td>${escape(svc.serviceName)}</td></tr>
      <tr><th>Unique Identifier</th><td><code>${escape(svc.serviceUniqueIdentifier)}</code></td></tr>
      <tr><th>Certificate</th><td><pre class="cert-preview">${escape(svc.certificatePem)}</pre></td></tr>
    </table>
  </div>`,
    )
    .join("");

  const actions = actionsHtml(app);
  const pubInfo = publicationInfoHtml(app);

  let etsiSection = "";
  if (etsiStatus) {
    etsiSection = `
<div class="card">
  <h2>ETSI Schema Validation</h2>
  <p>Status: <span class="badge ${etsiStatus.valid ? "ok" : "error"}">${etsiStatus.valid ? "Valid" : "Invalid"}</span></p>
  ${etsiStatus.findings.length > 0 ? `<pre class="cert-preview">${escape(JSON.stringify(etsiStatus.findings, null, 2))}</pre>` : ""}
</div>`;
  }

  let compilerSection = "";
  if (compilerInputJson) {
    compilerSection = `
<div class="card">
  <h2>Compiler Input (Normalized AuthoringInput)</h2>
  <pre class="cert-preview">${escape(compilerInputJson)}</pre>
</div>`;
  }

  return `
<h1>Application: <code>${escape(app.id)}</code></h1>
<div class="test-notice"><strong>&#x26A0; Testing tool.</strong></div>
${messages}

<div class="card">
  <h2>Status</h2>
  <table class="kv-table">
    <tr><th>ID</th><td><code>${escape(app.id)}</code></td></tr>
    <tr><th>Family</th><td>Wallet Providers</td></tr>
    <tr><th>Target List Key</th><td><code>${escape(app.targetListKey)}</code></td></tr>
    <tr><th>State</th><td><span class="badge ${stateBadge(app.state)}">${escape(app.state)}</span></td></tr>
    <tr><th>Schema Version</th><td>${app.schemaVersion}</td></tr>
    <tr><th>Submitted</th><td>${escape(app.submittedAt)}</td></tr>
    ${app.approvedAt ? `<tr><th>Approved</th><td>${escape(app.approvedAt)}</td></tr>` : ""}
    ${app.rejectedAt ? `<tr><th>Rejected</th><td>${escape(app.rejectedAt)}</td></tr>` : ""}
    ${app.adminNote ? `<tr><th>Admin Note</th><td>${escape(app.adminNote)}</td></tr>` : ""}
  </table>
</div>

${pubInfo}

<div class="card">
  <h2>Entity Information</h2>
  <table class="kv-table">
    <tr><th>Name</th><td>${escape(data.entityName)}</td></tr>
    ${data.entityTradeName ? `<tr><th>Trade Name</th><td>${escape(data.entityTradeName)}</td></tr>` : ""}
    <tr><th>Street Address</th><td>${escape(data.entityStreetAddress)}</td></tr>
    ${data.entityLocality ? `<tr><th>Locality</th><td>${escape(data.entityLocality)}</td></tr>` : ""}
    ${data.entityPostalCode ? `<tr><th>Postal Code</th><td>${escape(data.entityPostalCode)}</td></tr>` : ""}
    <tr><th>Country</th><td>${escape(data.entityCountry)}</td></tr>
    <tr><th>Information URI</th><td><code>${escape(data.entityInformationURI)}</code></td></tr>
  </table>
</div>

<div class="card">
  <h2>Services (${data.services.length})</h2>
  ${servicesHtml}
</div>

${etsiSection}
${compilerSection}

${
  previewMeta
    ? `
<div class="card">
  <h2>Preview &mdash; Cumulative Publication</h2>
  <table class="kv-table">
    <tr><th>Existing Entities</th><td>${previewMeta.existingEntityCount}</td></tr>
    <tr><th>Resulting Entities</th><td>${previewMeta.resultingEntityCount}</td></tr>
    <tr><th>Current Sequence</th><td>${escape(String(previewMeta.currentSequence ?? "none"))}</td></tr>
    <tr><th>Proposed Sequence</th><td>${escape(String(previewMeta.proposedSequence ?? "—"))}</td></tr>
  </table>
</div>`
    : ""
}

<div class="card">
  <h2>Required Documents</h2>
  <ul>
    <li><code>{ONBOARDING_AUTHORIZATION}.md</code></li>
    <li><code>{SERVICE_PROVIDER_AGREEMENT}.md</code></li>
  </ul>
</div>

<div class="card">
  <h2>Actions</h2>
  ${actions}
</div>

<p><a href="/admin/applications" class="btn">Back to Applications</a></p>
`;
}

function actionsHtml(app: WalletProviderApplication): string {
  const id = escape(app.id);

  switch (app.state) {
    case "submitted":
      return `
<form method="post" action="/admin/applications/${id}/approve" style="display:inline;">
  <button type="submit" class="btn btn-primary">Approve</button>
</form>
<form method="post" action="/admin/applications/${id}/reject" style="display:inline;">
  <input type="text" name="note" placeholder="Rejection reason" required minlength="1" maxlength="500" style="width:300px;">
  <button type="submit" class="btn btn-danger">Reject</button>
</form>
<form method="post" action="/admin/applications/${id}/delete" style="display:inline;" onsubmit="return confirm('Delete this application? This cannot be undone.');">
  <button type="submit" class="btn btn-danger">Delete</button>
</form>`;
    case "approved":
      return `
<form method="post" action="/admin/applications/${id}/publish" style="display:inline;">
  <button type="submit" class="btn btn-primary">Publish</button>
</form>
<form method="post" action="/admin/applications/${id}/reject" style="display:inline;">
  <input type="text" name="note" placeholder="Rejection reason" required minlength="1" maxlength="500" style="width:300px;">
  <button type="submit" class="btn btn-danger">Reject</button>
</form>`;
    case "rejected":
      return `
<form method="post" action="/admin/applications/${id}/delete" style="display:inline;" onsubmit="return confirm('Delete this application? This cannot be undone.');">
  <button type="submit" class="btn btn-danger">Delete</button>
</form>`;
    case "published":
      return `<p>&#x2705; This application has been published and cannot be modified or deleted.</p>`;
  }
}

function publicationInfoHtml(app: WalletProviderApplication): string {
  if (!app.publication) return "";
  const p = app.publication;
  return `
<div class="card">
  <h2>Publication Record</h2>
  <table class="kv-table">
    <tr><th>List Key</th><td><code>${escape(p.listKey)}</code></td></tr>
    <tr><th>Sequence Number</th><td>${p.sequenceNumber}</td></tr>
    <tr><th>Publication Timestamp</th><td>${escape(p.publicationTimestamp)}</td></tr>
    <tr><th>Compact JAdES SHA-256</th><td><code>${escape(p.compactJadesSha256)}</code></td></tr>
    <tr><th>Manifest SHA-256</th><td><code>${escape(p.manifestSha256)}</code></td></tr>
    <tr><th>Version Page</th><td><a href="/lists/${escape(p.listKey)}/versions/${p.sequenceNumber}">View Publication</a></td></tr>
  </table>
</div>`;
}

function stateBadge(state: string): string {
  switch (state) {
    case "submitted":
      return "info";
    case "approved":
      return "ok";
    case "rejected":
      return "error";
    case "published":
      return "ok";
    default:
      return "muted";
  }
}

export function adminNoAccessHtml(): string {
  return `
<h1>Access Denied</h1>
<div class="card">
  <p>Administrator access is required to view this page.</p>
  <p>Use <code>/admin?token=YOUR_TOKEN</code> to sign in, or set a token in the configuration.</p>
</div>
`;
}

export function adminSigningConfigHtml(
  entries: SigningConfigEntryDisplay[],
): string {
  if (entries.length === 0) {
    return `
<h1>Signing Configuration</h1>
<div class="test-notice"><strong>&#x26A0; Testing tool.</strong></div>
<div class="card">
  <p>No signing configuration found.</p>
  <p>Create a <code>signing-config.json</code> file with list entries referencing your signing keys.</p>
</div>
<p><a href="/admin" class="btn">Back to Admin</a></p>
`;
  }

  let rows = "";
  for (const e of entries) {
    const familyLabel =
      LIST_FAMILIES.find((f) => f.key === e.family)?.label ?? e.family;
    rows += `
  <tr>
    <td><code>${escape(e.listKey)}</code></td>
    <td>${escape(familyLabel)}</td>
    <td>${e.configured ? '<span class="badge ok">configured</span>' : '<span class="badge error">not configured</span>'}</td>
    <td>${escape(e.certificateSubject ?? "—")}</td>
    <td>${e.certificateFingerprint ? `<code>${escape(e.certificateFingerprint.slice(0, 16))}...</code>` : "—"}</td>
  </tr>`;
  }

  return `
<h1>Signing Configuration</h1>
<div class="test-notice"><strong>&#x26A0; Testing tool.</strong> Private key contents are never displayed.</div>
<table class="catalogue-table">
<thead><tr><th>List Key</th><th>Family</th><th>Status</th><th>Cert Subject</th><th>Cert Fingerprint</th></tr></thead>
<tbody>${rows}</tbody>
</table>
<p><a href="/admin" class="btn">Back to Admin</a></p>
`;
}
