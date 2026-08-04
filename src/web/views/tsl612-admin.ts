/**
 * Administration and public pages for TS 119 612 Trusted Lists.
 *
 * Same shell, cards, chips and buttons as the TS 119 602 pages. What differs is
 * only what the standard actually has: one XML artifact instead of a JSON
 * document and a detached signature, a service status vocabulary, and a
 * lifecycle action whose wording depends on whether the status was granted or
 * recognised.
 */
import { familyChip, listChip } from "./colors.js";
import { brokenBadge } from "./broken-list.js";
import { fixturePanelHtml } from "./inspector-panel.js";
import { xmlStandardChips } from "./tsl612-onboarding.js";
import { getTslProfile } from "../../core/tsl612/registry.js";
import type { TslApplicationRecord } from "../../core/tsl612/authoring/application-model.js";
import type { PublishPreview } from "../../core/tsl612/authoring/application-service.js";
import type { TrustedListManifest } from "../../core/publication/tsl-manifest.js";
import type { InspectorSummary } from "../../core/inspector/inspector.js";

function escape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function row(label: string, value: string): string {
  return `<tr><th>${escape(label)}</th><td>${value}</td></tr>`;
}

const STATE_BADGE: Readonly<Record<string, string>> = Object.freeze({
  submitted: "badge-neutral",
  approved: "badge-assurance",
  rejected: "badge-danger",
  published: "badge-assurance",
  /* A superseded service is a normal end state, not a failure. */
  superseded: "badge-neutral",
});

export function tslStateBadge(state: string): string {
  const cls = STATE_BADGE[state] ?? "badge-neutral";
  return `<span class="badge ${cls}">${escape(state)}</span>`;
}

/** One row of the administration application list. */
export function tslApplicationRow(record: TslApplicationRecord): string {
  return `
    <tr>
      <td><a href="/admin/xml-applications/${escape(record.id)}"><code>${escape(record.id.slice(0, 8))}</code></a></td>
      <td>${familyChip(record.family)}</td>
      <td>${listChip(record.listKey)}</td>
      <td>${escape(record.tspName)}</td>
      <td>${tslStateBadge(record.state)}</td>
      <td>${escape(record.submittedAt)}</td>
    </tr>`;
}

export function tslApplicationsHtml(
  records: readonly TslApplicationRecord[],
): string {
  if (records.length === 0)
    return `<h1>XML Trusted List applications</h1>
      <p>${xmlStandardChips()}</p>
      <p>No EAA or QEAA application has been submitted yet.</p>`;
  return `
<h1>XML Trusted List applications</h1>
<p>${xmlStandardChips()}</p>
<table class="catalogue-table">
  <thead><tr><th>Id</th><th>Family</th><th>Trusted List</th><th>TSP</th><th>State</th><th>Submitted</th></tr></thead>
  <tbody>${records.map(tslApplicationRow).join("")}</tbody>
</table>`;
}

export interface TslApplicationDetailInput {
  readonly record: TslApplicationRecord;
  readonly preview?: PublishPreview;
  readonly previewError?: string;
  readonly message?: string;
  readonly error?: string;
}

/** The administration review page for one EAA or QEAA application. */
export function tslApplicationDetailHtml(
  input: TslApplicationDetailInput,
): string {
  const record = input.record;
  const profile = getTslProfile(record.family);
  const notice = input.message
    ? `<div class="notice notice-info">${escape(input.message)}</div>`
    : "";
  const failure = input.error
    ? `<div class="notice notice-warning">${escape(input.error)}</div>`
    : "";

  const previewCard = input.previewError
    ? `<div class="card"><h2>Cumulative publication</h2>
         <div class="notice notice-warning">${escape(input.previewError)}</div></div>`
    : input.preview
      ? `<div class="card"><h2>Cumulative publication</h2>
          <table class="kv-table"><tbody>
            ${row("Existing providers", String(input.preview.existingProviders))}
            ${row("Resulting providers", String(input.preview.resultingProviders))}
            ${row("Existing services", String(input.preview.existingServices))}
            ${row("Resulting services", String(input.preview.resultingServices))}
            ${row("Current sequence", input.preview.currentSequence === null ? "none published" : String(input.preview.currentSequence))}
            ${row("Proposed sequence", String(input.preview.proposedSequence))}
          </tbody></table></div>`
      : "";

  const actions: string[] = [];
  if (record.state === "submitted") {
    actions.push(
      `<form method="post" action="/admin/xml-applications/${escape(record.id)}/approve"><button type="submit" class="btn btn-primary btn-md">Approve</button></form>`,
    );
    actions.push(
      `<form method="post" action="/admin/xml-applications/${escape(record.id)}/reject">
         <input type="text" name="note" placeholder="Reason" required>
         <button type="submit" class="btn btn-secondary btn-md">Reject</button>
       </form>`,
    );
  }
  if (record.state === "approved") {
    actions.push(
      `<form method="post" action="/admin/xml-applications/${escape(record.id)}/publish"><button type="submit" class="btn btn-primary btn-md">Publish</button></form>`,
    );
  }
  if (record.state === "published") {
    /* Destructive and behind a confirmation: it publishes an immutable version. */
    actions.push(
      `<form method="post" action="/admin/xml-applications/${escape(record.id)}/supersede"
             onsubmit="return confirm('${escape(profile.lifecycleActionLabel)} — this publishes a new immutable version and cannot be undone. Continue?')">
         <button type="submit" class="btn btn-danger btn-md">${escape(profile.lifecycleActionLabel)}</button>
       </form>`,
    );
  }
  if (record.state === "submitted" || record.state === "approved") {
    actions.push(
      `<form method="post" action="/admin/xml-applications/${escape(record.id)}/delete"><button type="submit" class="btn btn-secondary btn-md">Delete</button></form>`,
    );
  }

  const publicationCard = record.publication
    ? `<div class="card"><h2>Publication record</h2>
        <table class="kv-table"><tbody>
          ${row("Trusted List", listChip(record.publication.listKey))}
          ${row("Sequence", `<a href="/lists/${escape(record.publication.listKey)}/versions/${record.publication.sequenceNumber}">${record.publication.sequenceNumber}</a>`)}
          ${row("Published", escape(record.publication.publishedAt))}
          ${row("Service status", `<code>${escape(record.publication.serviceStatus)}</code>`)}
          ${row("Status starting time", escape(record.publication.statusStartingTime))}
          ${row("XML SHA-256", `<code>${escape(record.publication.trustedListXmlSha256)}</code>`)}
        </tbody></table></div>`
    : "";

  const supersessionCard = record.supersession
    ? `<div class="card"><h2>${escape(profile.lifecycleActionLabel)} record</h2>
        <table class="kv-table"><tbody>
          ${row("Sequence", `<a href="/lists/${escape(record.supersession.listKey)}/versions/${record.supersession.sequenceNumber}">${record.supersession.sequenceNumber}</a>`)}
          ${row("Published", escape(record.supersession.publishedAt))}
          ${row("Service status", `<code>${escape(record.supersession.serviceStatus)}</code>`)}
          ${row("Status starting time", escape(record.supersession.statusStartingTime))}
          ${row("XML SHA-256", `<code>${escape(record.supersession.trustedListXmlSha256)}</code>`)}
        </tbody></table></div>`
    : "";

  return `
<h1>${escape(record.tspName)}</h1>
<p>${familyChip(record.family)} ${listChip(record.listKey)} ${tslStateBadge(record.state)} ${xmlStandardChips()}</p>
${notice}
${failure}

<div class="card">
  <h2>Application</h2>
  <table class="kv-table"><tbody>
    ${row("Application id", `<code>${escape(record.id)}</code>`)}
    ${row("Submitted", escape(record.submittedAt))}
    ${row("TSP legal name", escape(record.tspName))}
    ${row("Registration identifier", `${escape(record.registrationIdentifier)} <span class="field-help">(${escape(record.registrationIdentifierKind === "vat" ? "VAT" : "national register")})</span>`)}
    ${record.tradeName ? row("Trade name", escape(record.tradeName)) : ""}
    ${row("Address", escape([record.address.streetAddress, record.address.postalCode ?? "", record.address.locality, record.address.stateOrProvince ?? "", record.address.countryName].filter(Boolean).join(", ")))}
    ${row("Email", escape(record.email))}
    ${row("Website", escape(record.website))}
    ${record.telephone ? row("Telephone", escape(record.telephone)) : ""}
    ${row("Policies and practices", escape(record.tspInformationUri))}
  </tbody></table>
</div>

<div class="card">
  <h2>Service</h2>
  <table class="kv-table"><tbody>
    ${row("Service name", escape(record.serviceName))}
    ${row("Service type", `<code>${escape(profile.serviceTypeIdentifier)}</code>`)}
    ${row("Status on approval", `<code>${escape(profile.initialStatus)}</code>`)}
    ${record.schemeServiceDefinitionUri ? row("Scheme service definition", escape(record.schemeServiceDefinitionUri)) : ""}
    ${record.tspServiceDefinitionUri ? row("TSP service definition", escape(record.tspServiceDefinitionUri)) : ""}
    ${record.serviceSupplyPoints && record.serviceSupplyPoints.length > 0 ? row("Service supply points", record.serviceSupplyPoints.map((point) => escape(point)).join("<br>")) : ""}
  </tbody></table>
</div>

<div class="card">
  <h2>Review evidence</h2>
  <p class="field-help">Kept for review only. This is never published in the Trusted List.</p>
  <pre>${escape(record.evidence)}</pre>
  ${record.adminNote ? `<p><strong>Administrator note:</strong> ${escape(record.adminNote)}</p>` : ""}
</div>

${previewCard}
${publicationCard}
${supersessionCard}

<div class="card">
  <h2>Actions</h2>
  <div class="form-actions">${actions.join("")}</div>
</div>`;
}

/** The Downloads row and metadata of an XML version page. */
export function trustedListVersionHtml(
  listKey: string,
  sequenceNumber: number,
  manifest: TrustedListManifest,
  inspector: InspectorSummary | null,
  isLatest: boolean,
  fixtureMetadataJson: string | null = null,
  subtitleHtml: string,
): string {
  const base = `/api/v1/lists/${encodeURIComponent(listKey)}/versions/${sequenceNumber}`;
  const tsl = manifest.trustedList;
  const inspectorCard = inspector
    ? `<div class="card"><h2>Trust Inspector</h2>
        <p><span class="badge ${inspector.status === "pass" ? "badge-assurance" : inspector.status === "fail" ? "badge-danger" : "badge-neutral"}">${escape(inspector.status === "pass" ? "Pass" : inspector.status === "fail" ? "Fail" : "Unavailable")}</span></p>
        <table class="kv-table"><tbody>
          ${row("Standard assessed", escape(inspector.standard ?? "not stated"))}
          ${row("Detected artifact", escape(inspector.detectedArtifactKind ?? "not stated"))}
          ${row("TS 119 612 applicability", escape(inspector.standardApplicability?.["ts119612"] ?? "not stated"))}
          ${row("Conformance level", escape(inspector.status === "unavailable" ? "not evaluated" : (inspector.conformanceLevel ?? "not stated")))}
          ${inspector.serviceTypes && inspector.serviceTypes.length > 0 ? row("Service types", inspector.serviceTypes.map((type) => `<code>${escape(type)}</code>`).join("<br>")) : ""}
          ${inspector.counts ? row("Checks", `${inspector.counts.pass} pass, ${inspector.counts.fail} fail, ${inspector.counts.warn} warn, ${inspector.counts.notApplicable} n/a, ${inspector.counts.notChecked} not checked`) : ""}
          ${row("Evaluated", escape(inspector.evaluatedAt))}
          ${row("Inspector", escape(inspector.inspectorBaseUrl))}
        </tbody></table>
        ${inspector.locallyDecidableFailures && inspector.locallyDecidableFailures.length > 0 ? `<ul>${inspector.locallyDecidableFailures.map((f) => `<li>${escape(f)}</li>`).join("")}</ul>` : ""}
        ${inspector.status === "unavailable" && inspector.error ? `<p class="field-help">${escape(inspector.error)}</p>` : ""}
        </div>`
    : `<div class="card"><h2>Trust Inspector</h2>
        <p><span class="badge badge-neutral">Unavailable</span></p>
        <p>No evaluation is stored for this version. That is not a conformance claim.</p></div>`;

  const latestNote = isLatest
    ? `<p class="field-help">This is the latest version. It is also served at the stable URLs
        <code>/lists/${escape(listKey)}/latest/trusted-list.xml</code> and
        <code>/lists/${escape(listKey)}/latest/trusted-list.sha2</code>.</p>`
    : "";

  return `
<h1>${escape(listKey)} - Version ${sequenceNumber}${manifest.fixture?.fixtureMode === "intentionally-broken" ? ` ${brokenBadge()}` : ""}</h1>
${subtitleHtml}
${latestNote}
${fixturePanelHtml(fixtureMetadataJson)}

<div class="card">
  <h2>List Information</h2>
  <table class="kv-table"><tbody>
    ${row("Trusted List", listChip(listKey))}
    ${row("TSL sequence number", String(tsl.tslSequenceNumber))}
    ${row("TSL version identifier", String(tsl.tslVersionIdentifier))}
    ${row("TSL type", `<code>${escape(tsl.tslType)}</code>`)}
    ${row("Status determination", `<code>${escape(tsl.statusDeterminationApproach)}</code>`)}
    ${row("Scheme operator", escape(tsl.schemeOperatorName))}
    ${row("Scheme name", escape(tsl.schemeName))}
    ${row("Scheme territory", `<code>${escape(tsl.schemeTerritory)}</code>`)}
    ${row("Historical information period", String(tsl.historicalInformationPeriod))}
    ${row("Issued", escape(tsl.issueDate))}
    ${row("Next update", escape(tsl.nextUpdateDate))}
  </tbody></table>
</div>

<div class="card">
  <h2>Signature &amp; Validation</h2>
  <table class="kv-table"><tbody>
    ${row("Signature valid", manifest.signatureValid ? "&#x2705; Yes" : "&#x274C; No")}
    ${row("ETSI schema valid", manifest.schemaValid ? "&#x2705; Yes" : "&#x274C; No")}
    ${row("Signer trust", `${escape(manifest.signerTrustStatus)} — this publisher builds no certification path and makes no trust decision`)}
    ${row("Signature", manifest.signatureValid ? `${escape(manifest.signatureProfile)}, verified locally` : `invalid: ${escape(manifest.signatureFindings.join("; "))}`)}
    ${row("Signature algorithm", `<code>${escape(manifest.signatureAlgorithm)}</code>`)}
    ${row("Signing time", escape(manifest.signingTime))}
    ${row("Freshness", manifest.freshnessValid ? "NextUpdate is later than the issue time and has not passed" : `<strong>stale:</strong> ${escape(manifest.freshnessFindings.join(" "))}`)}
  </tbody></table>
</div>

<div class="card">
  <h2>Signing Certificate</h2>
  <table class="kv-table"><tbody>
    ${row("Subject", escape(manifest.certificateSubject))}
    ${row("Issuer", escape(manifest.certificateIssuer))}
    ${row("Valid from", escape(manifest.certificateValidFrom))}
    ${row("Valid to", escape(manifest.certificateValidTo))}
    ${row("Certificate SHA-256", `<code>${escape(manifest.signingCertificateSha256)}</code>`)}
    ${row("Certificate profile", manifest.signingCertificateFindings.length === 0 ? "meets the TS 119 612 Scheme Operator profile" : `<strong>does not meet the profile:</strong> ${escape(manifest.signingCertificateFindings.join(" "))}`)}
  </tbody></table>
</div>

${inspectorCard}

<div class="card">
  <h2>Entities &amp; Services</h2>
  <table class="kv-table"><tbody>
    ${row("Providers", String(tsl.providerCount))}
    ${row("Services", String(tsl.serviceCount))}
    ${row("Service types", tsl.serviceTypes.length > 0 ? tsl.serviceTypes.map((type) => `<code>${escape(type)}</code>`).join("<br>") : "none — this version lists no provider")}
    ${row("Allowed service profiles", manifest.serviceProfiles.allowedServiceProfiles.length > 0 ? manifest.serviceProfiles.allowedServiceProfiles.map((profile) => `<code>${escape(profile)}</code>`).join("<br>") : "not recorded")}
  </tbody></table>
</div>

<div class="card">
  <h2>Downloads</h2>
  <p class="version-downloads">
    <a class="btn btn-primary btn-md" href="${base}/trusted-list.xml">XML</a>
    <a class="btn btn-primary btn-md" href="${base}/trusted-list.sha2">SHA-256 digest</a>
    <a class="btn btn-primary btn-md" href="${base}/inspector?view=1">Inspector report</a>
  </p>
  <p class="field-help">
    The XML is served as <code>application/vnd.etsi.tsl+xml</code>; its XAdES-B-B
    signature is inside the document. The <code>.sha2</code> file is the SHA-256
    of the exact published XML bytes. Publication
    <a href="${base}/manifest">manifest</a>.
  </p>
</div>

<div class="card">
  <h2>Artifact Hashes</h2>
  <table class="kv-table"><tbody>
    ${row("XML SHA-256", `<code>${escape(manifest.trustedListXmlSha256)}</code>`)}
    ${row(".sha2 published", manifest.trustedListSha2Published === undefined || manifest.trustedListSha2Published === manifest.trustedListXmlSha256 ? `<code>${escape(manifest.trustedListXmlSha256)}</code> — matches the XML` : `<code>${escape(manifest.trustedListSha2Published)}</code> — <strong>deliberately not the digest of this XML</strong>`)}
  </tbody></table>
</div>`;
}
