import type {
  PublicationRecord,
  TrustedEntityApplication,
} from "../../core/authoring/application-model.js";
import type { SigningConfigEntryDisplay } from "../../core/authoring/signing-config.js";
import type { PublisherSettings } from "../../core/authoring/settings-store.js";
import { LIST_FAMILIES } from "../../core/authoring/list-family-catalogue.js";
import { familyChip, listChip } from "./colors.js";

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
<div class="card">
  <p><a href="/admin/lists/create" class="btn">Create Trusted List</a></p>
  <p><a href="/admin/applications" class="btn">Manage Applications</a></p>
  <p><a href="/admin/signing" class="btn">Signing Configuration</a></p>
  <p><a href="/admin/settings" class="btn">Settings</a></p>
</div>
`;
}

export function adminApplicationsHtml(
  apps: TrustedEntityApplication[],
  stateFilter?: string,
): string {
  const states = [
    "submitted",
    "approved",
    "rejected",
    "published",
    "withdrawn",
  ] as const;

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
<p>Filter:${filterHtml}</p>
<div class="card"><p>No applications found.</p></div>
<a href="/admin" class="btn">Back to Admin</a>
`;
  }

  let rows = "";
  for (const a of filtered) {
    rows += `
  <tr>
    <td>${escape(a.id.slice(0, 8))}...</td>
    <td>${familyChip(a.family, familyLabelFor(a))}</td>
    <td>${listChip(a.targetListKey)}</td>
    <td><span class="badge ${stateBadge(a.state)}">${escape(a.state)}</span></td>
    <td>${escape(a.submittedAt)}</td>
    <td><a href="/admin/applications/${escape(a.id)}" class="btn btn-sm">View</a></td>
  </tr>`;
  }

  return `
<h1>Applications</h1>
<p>Filter:${filterHtml}</p>
<table class="catalogue-table">
<thead><tr><th>ID</th><th>Trusted List Family</th><th>Trusted List</th><th>State</th><th>Submitted</th><th></th></tr></thead>
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
  app: TrustedEntityApplication,
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
  /*
    Annex F/G applications carry three fields the other families do not, and
    their public URI is a policies and terms URL rather than an information
    page, so the label differs too.
  */
  const relyingPartyData =
    app.family === "wrpac-providers" || app.family === "wrprc-providers"
      ? app.applicantData
      : null;
  const relyingParty = relyingPartyData !== null;
  /*
    Annex H carries a legal basis and an optional registration identifier, and
    its public URI is the policies and terms URL, like Annex F/G.
  */
  const pubEaaData =
    app.family === "pub-eaa-providers" ? app.applicantData : null;
  const policyUrl = relyingParty || pubEaaData !== null;
  const registrationIdentifier =
    relyingPartyData?.registrationIdentifier ??
    pubEaaData?.registrationIdentifier ??
    null;
  const responsibleMemberState =
    "responsibleMemberState" in data ? data.responsibleMemberState : null;

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
      ${
        svc.serviceUniqueIdentifier
          ? `<tr><th>Unique Identifier</th><td><code>${escape(svc.serviceUniqueIdentifier)}</code></td></tr>`
          : ""
      }
      <tr><th>Certificate</th><td>${
        svc.certificatePem
          ? `<pre class="cert-preview">${escape(svc.certificatePem)}</pre>`
          : '<span class="badge muted">none supplied</span>'
      }</td></tr>
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
${messages}

<div class="card">
  <h2>Status</h2>
  <table class="kv-table">
    <tr><th>ID</th><td><code>${escape(app.id)}</code></td></tr>
    <tr><th>Trusted List Family</th><td>${familyChip(app.family, familyLabelFor(app))}</td></tr>
    <tr><th>Target Trusted List</th><td>${listChip(app.targetListKey)}</td></tr>
    <tr><th>State</th><td><span class="badge ${stateBadge(app.state)}">${escape(app.state)}</span></td></tr>
    <tr><th>Schema Version</th><td>${app.schemaVersion}</td></tr>
    <tr><th>Submitted</th><td>${escape(app.submittedAt)}</td></tr>
    ${app.approvedAt ? `<tr><th>Approved</th><td>${escape(app.approvedAt)}</td></tr>` : ""}
    ${app.rejectedAt ? `<tr><th>Rejected</th><td>${escape(app.rejectedAt)}</td></tr>` : ""}
    ${app.withdrawnAt ? `<tr><th>Withdrawn</th><td>${escape(app.withdrawnAt)}</td></tr>` : ""}
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
    <tr><th>${policyUrl ? "Policies and Terms URL" : "Information URI"}</th><td><code>${escape(data.entityInformationURI)}</code></td></tr>
    ${
      relyingPartyData?.additionalInformationURI
        ? `<tr><th>Additional Information URL</th><td><code>${escape(relyingPartyData.additionalInformationURI)}</code></td></tr>`
        : ""
    }
    <tr><th>Email</th><td><code>${escape(data.entityEmail)}</code></td></tr>
    <tr><th>Telephone</th><td><code>${escape(data.entityTelephone)}</code></td></tr>
    ${
      registrationIdentifier
        ? `<tr><th>Official Registration Identifier</th><td><code>${escape(registrationIdentifier)}</code></td></tr>`
        : ""
    }
    ${
      pubEaaData
        ? `<tr><th>Legal Basis Reference</th><td><code>${escape(pubEaaData.legalBasisReference)}</code></td></tr>`
        : ""
    }
    ${
      responsibleMemberState
        ? `<tr><th>Responsible Member State</th><td>${escape(responsibleMemberState)}</td></tr>`
        : ""
    }
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
  ${
    pubEaaData
      ? `<p class="field-help">Approving this application publishes every service
         as <strong>notified</strong> by the Responsible Member State
         (${escape(responsibleMemberState ?? "—")}), with a StatusStartingTime
         taken from the publication event. Withdrawing the notification later
         publishes a new immutable version in which every service reads
         <strong>withdrawn</strong> and the previous notified state is kept in
         ServiceHistory.</p>`
      : ""
  }
  ${
    relyingParty
      ? `<p class="field-help">Approving this application states that the provider
         is <strong>currently mandated</strong> by the Responsible Member State
         (${escape(responsibleMemberState ?? "—")}). These profiles publish no
         ServiceStatus and no StatusStartingTime: presence in the current list
         version is the statement, and a provider that loses its mandate is
         removed from the next version rather than marked withdrawn.</p>`
      : ""
  }
  ${actions}
</div>

<p><a href="/admin/applications" class="btn">Back to Applications</a></p>
`;
}

function actionsHtml(app: TrustedEntityApplication): string {
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
      /*
        Annex H is the only profile that can say a provider is no longer listed,
        because it is the only one that publishes a service status.
      */
      return app.family === "pub-eaa-providers"
        ? `<p>&#x2705; This application has been published and cannot be modified or deleted.</p>
<form method="post" action="/admin/applications/${id}/withdraw" style="display:inline;"
  onsubmit="return confirm('Withdraw this Pub-EAA notification? A new immutable list version will be published with every service withdrawn.');">
  <button type="submit" class="btn btn-danger">Withdraw notification</button>
</form>`
        : `<p>&#x2705; This application has been published and cannot be modified or deleted.</p>`;
    case "withdrawn":
      return `<p>This Pub-EAA notification has been withdrawn. Both the notified
        and the withdrawn versions remain published and downloadable.</p>`;
  }
}

function publicationInfoHtml(app: TrustedEntityApplication): string {
  return `${publicationRecordCard(app.publication, "Publication Record")}${publicationRecordCard(app.withdrawal, "Withdrawal Record")}`;
}

function publicationRecordCard(
  record: PublicationRecord | undefined,
  title: string,
): string {
  if (!record) return "";
  const p = record;
  return `
<div class="card">
  <h2>${title}</h2>
  <table class="kv-table">
    <tr><th>Trusted List</th><td>${listChip(p.listKey)}</td></tr>
    <tr><th>Sequence Number</th><td>${p.sequenceNumber}</td></tr>
    <tr><th>Publication Timestamp</th><td>${escape(p.publicationTimestamp)}</td></tr>
    <tr><th>Compact JAdES SHA-256</th><td><code>${escape(p.compactJadesSha256)}</code></td></tr>
    <tr><th>Manifest SHA-256</th><td><code>${escape(p.manifestSha256)}</code></td></tr>
    <tr><th>Version Page</th><td><a href="/lists/${escape(p.listKey)}/versions/${p.sequenceNumber}">View Publication</a></td></tr>
  </table>
</div>`;
}

function familyLabelFor(app: TrustedEntityApplication): string {
  const family = LIST_FAMILIES.find(
    (candidate) => candidate.key === app.family,
  );
  if (!family) {
    throw new Error(`Missing list-family catalogue entry for '${app.family}'.`);
  }
  return family.label;
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
    case "withdrawn":
      return "muted";
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

/**
 * Sign-in form shown instead of the plain "Access Denied" page whenever
 * ADMIN_USER and ADMIN_PASSWORD are configured. The credentials are checked
 * against the .env values; a successful POST sets the existing admin cookie.
 */
export function adminLoginHtml(next?: string, error?: string): string {
  const target = next && next.startsWith("/admin") ? next : "/admin";
  return `
<h1>Administration</h1>
<p class="lead">Sign in with the administrator credentials configured for this
instance to review and publish onboarding applications.</p>

<div class="card admin-login-card">
  <h2>Sign in</h2>
  ${error ? `<div class="notice notice-error">${escape(error)}</div>` : ""}
  <form method="post" action="/admin/login" class="onboarding-form admin-login-form">
    <input type="hidden" name="next" value="${escape(target)}">
    <div class="form-group">
      <label for="admin-username">Username <span class="required">*</span></label>
      <input type="text" id="admin-username" name="username" required
        autocomplete="username" autocapitalize="none" spellcheck="false">
      <span class="field-help">The <code>ADMIN_USER</code> value from the root <code>.env</code>.</span>
    </div>
    <div class="form-group">
      <label for="admin-password">Password <span class="required">*</span></label>
      <input type="password" id="admin-password" name="password" required
        autocomplete="current-password">
      <span class="field-help">The <code>ADMIN_PASSWORD</code> value from the root <code>.env</code>.</span>
    </div>
    <div class="form-actions">
      <button type="submit" class="btn btn-primary btn-md">Sign in</button>
      <a href="/" class="btn btn-outline btn-md">Back to Catalogue</a>
    </div>
  </form>
</div>
`;
}

export function adminSigningConfigHtml(
  entries: SigningConfigEntryDisplay[],
): string {
  if (entries.length === 0) {
    return `
<h1>Signing Configuration</h1>
<div class="card">
  <p>No signing configuration found.</p>
  <p>Create a <code>signing-config.json</code> file with list entries referencing your signing keys.</p>
</div>
<p><a href="/admin" class="btn">Back to Admin</a></p>
`;
  }

  let rows = "";
  for (const e of entries) {
    rows += `
  <tr>
    <td>${listChip(e.listKey)}</td>
    <td>${familyChip(e.family)}</td>
    <td>${e.configured ? '<span class="badge ok">configured</span>' : '<span class="badge error">not configured</span>'}</td>
    <td>${escape(e.certificateSubject ?? "—")}</td>
    <td>${e.certificateFingerprint ? `<code>${escape(e.certificateFingerprint.slice(0, 16))}...</code>` : "—"}</td>
  </tr>`;
  }

  return `
<h1>Signing Configuration</h1>
<p class="lead">Private key contents are never displayed.</p>
<table class="catalogue-table">
<thead><tr><th>Trusted List</th><th>Trusted List Family</th><th>Status</th><th>Cert Subject</th><th>Cert Fingerprint</th></tr></thead>
<tbody>${rows}</tbody>
</table>
<p><a href="/admin" class="btn">Back to Admin</a></p>
`;
}

export interface SettingsListRow {
  listKey: string;
  schemeOperatorName: string;
}

/**
 * Administration settings: one auto-approve switch per Trusted List Family and
 * one per configured Trusted List, the lists nested under their family.
 *
 * Families with no implemented profile cannot receive applications, so their
 * switch is rendered read-only rather than silently accepted.
 */
export function adminSettingsHtml(
  settings: PublisherSettings,
  listsByFamily: Record<string, SettingsListRow[]>,
  saved?: boolean,
): string {
  const sections = LIST_FAMILIES.map((family) => {
    const lists = listsByFamily[family.key] ?? [];
    const familyChecked =
      settings.autoApproveFamilies[family.key] === true ? " checked" : "";
    const familyDisabled = family.enabled ? "" : " disabled";

    const listRows =
      lists.length === 0
        ? `<p class="field-help">No Trusted List is configured for this family in
           <code>signing-config</code>.</p>`
        : lists
            .map((list) => {
              const checked =
                settings.autoApproveLists[list.listKey] === true
                  ? " checked"
                  : "";
              const id = `list-${list.listKey}`;
              return `
      <div class="settings-row">
        <input type="checkbox" id="${escape(id)}" name="list[${escape(list.listKey)}]" value="on"${checked}>
        <div>
          <label for="${escape(id)}">Auto-approve all the applications for ${listChip(list.listKey)}</label>
          <span class="field-help">${escape(list.schemeOperatorName)}</span>
        </div>
      </div>`;
            })
            .join("");

    return `
<div class="card settings-family">
  <div class="settings-family-head">
    <h2>${familyChip(family.key, family.label)}</h2>
    ${family.enabled ? '<span class="badge badge-assurance">Available</span>' : `<span class="badge badge-neutral">${escape(family.notImplementedNote)}</span>`}
  </div>
  <div class="settings-row">
    <input type="checkbox" id="family-${escape(family.key)}" name="family[${escape(family.key)}]" value="on"${familyChecked}${familyDisabled}>
    <div>
      <label for="family-${escape(family.key)}">Auto-approve all the applications for this Trusted List Family</label>
      <span class="field-help">Applies to every Trusted List in the family, including lists added later.</span>
    </div>
  </div>
  <div class="settings-lists">${listRows}
  </div>
</div>`;
  }).join("");

  return `
<h1>Settings</h1>
<p class="lead">Auto-approval settings for onboarding applications. When a
Trusted List Family or a single Trusted List is set to auto-approve, every
application targeting it is approved and published immediately on submission,
bypassing the Approve and Publish actions on the application detail page.</p>

${saved ? '<div class="success-msg">Settings saved.</div>' : ""}

<form method="post" action="/admin/settings" class="onboarding-form">
${sections}
  <div class="form-actions">
    <button type="submit" class="btn btn-primary btn-md">Save Settings</button>
    <a href="/admin" class="btn btn-outline btn-md">Back to Admin</a>
  </div>
</form>
`;
}
