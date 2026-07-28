import { LIST_FAMILIES } from "../../core/authoring/list-family-catalogue.js";

export function onboardingCatalogueHtml(): string {
  let rows = "";
  for (const f of LIST_FAMILIES) {
    const status = f.enabled
      ? '<span class="badge ok">Available</span>'
      : `<span class="badge muted">${escape(f.notImplementedNote)}</span>`;
    const action = f.enabled
      ? `<a href="/onboarding/${f.key}" class="btn">Start Application</a>`
      : "&mdash;";
    rows += `
      <tr>
        <td>${escape(f.label)}</td>
        <td>${status}</td>
        <td>${action}</td>
      </tr>`;
  }

  return `
<h1>Onboarding &mdash; EUDI Trusted List Publisher</h1>
<div class="test-notice">
  <strong>&#x26A0; Testing tool.</strong>
  This is a test/debug fixture publisher, not an official or production Trusted List Provider.
</div>

<div class="card">
  <h2>Planned List Families</h2>
  <table class="catalogue-table">
    <thead>
      <tr><th>Family</th><th>Status</th><th>Action</th></tr>
    </thead>
    <tbody>
      ${rows}
    </tbody>
  </table>
</div>
`;
}

export interface ListOption {
  key: string;
  label: string;
}

export function walletProviderFormHtml(
  values?: Record<string, string>,
  errors?: Record<string, string>,
  listOptions?: ListOption[],
): string {
  const v = values ?? {};
  const opts = listOptions ?? [];
  const fieldError = (name: string): string =>
    errors?.[name]
      ? `<span class="field-error">${escape(errors[name] ?? "")}</span>`
      : "";

  let listSelect = "";
  if (opts.length === 0) {
    listSelect = `<p class="field-error">No Wallet Provider lists are configured. Add entries to your signing-config.</p>`;
  } else if (opts.length === 1) {
    listSelect = `
      <input type="hidden" name="targetListKey" value="${escape(opts[0]!.key)}">
      <p><strong>Target List:</strong> <code>${escape(opts[0]!.key)}</code> &mdash; ${escape(opts[0]!.label)}</p>`;
  } else {
    listSelect = `
      <div class="form-group">
        <label for="targetListKey">Target List <span class="required">*</span></label>
        <select name="targetListKey" id="targetListKey" required>
          <option value="">-- Select a list --</option>
          ${opts
            .map(
              (o) =>
                `<option value="${escape(o.key)}" ${v.targetListKey === o.key ? "selected" : ""}>${escape(o.label)}</option>`,
            )
            .join("")}
        </select>
        ${fieldError("targetListKey")}
      </div>`;
  }

  return `
<h1>Wallet Provider Application</h1>
<div class="test-notice">
  <strong>&#x26A0; Testing tool.</strong> This is a test/debug fixture publisher.
</div>

<form method="post" action="/onboarding/wallet-provider" class="onboarding-form">
  <div class="card">
    <h2>List Selection</h2>
    ${listSelect}
  </div>

  <div class="card">
    <h2>Entity Information</h2>
    <p class="field-help">The legal entity applying for Wallet Provider status.</p>

    <div class="form-group">
      <label for="entityName">Entity Name <span class="required">*</span></label>
      <input type="text" id="entityName" name="entityName" required
        value="${escape(v.entityName ?? "")}" maxlength="200">
      <span class="field-help">Legal name of the organisation (English).</span>
      ${fieldError("entityName")}
    </div>

    <div class="form-group">
      <label for="entityTradeName">Trade Name</label>
      <input type="text" id="entityTradeName" name="entityTradeName"
        value="${escape(v.entityTradeName ?? "")}" maxlength="200">
      <span class="field-help">Optional trading name if different from legal name.</span>
      ${fieldError("entityTradeName")}
    </div>

    <fieldset>
      <legend>Postal Address</legend>
      <div class="form-group">
        <label for="entityStreetAddress">Street Address <span class="required">*</span></label>
        <input type="text" id="entityStreetAddress" name="entityStreetAddress" required
          value="${escape(v.entityStreetAddress ?? "")}" maxlength="300">
        ${fieldError("entityStreetAddress")}
      </div>
      <div class="form-group">
        <label for="entityLocality">Locality / City</label>
        <input type="text" id="entityLocality" name="entityLocality"
          value="${escape(v.entityLocality ?? "")}" maxlength="100">
        ${fieldError("entityLocality")}
      </div>
      <div class="form-group">
        <label for="entityPostalCode">Postal Code</label>
        <input type="text" id="entityPostalCode" name="entityPostalCode"
          value="${escape(v.entityPostalCode ?? "")}" maxlength="20">
        ${fieldError("entityPostalCode")}
      </div>
      <div class="form-group">
        <label for="entityCountry">Country (ISO 3166-1 alpha-2) <span class="required">*</span></label>
        <input type="text" id="entityCountry" name="entityCountry" required
          value="${escape(v.entityCountry ?? "")}" maxlength="2" pattern="[A-Z]{2}"
          placeholder="e.g. IT">
        <span class="field-help">Two-letter country code, e.g. IT for Italy.</span>
        ${fieldError("entityCountry")}
      </div>
    </fieldset>

    <div class="form-group">
      <label for="entityInformationURI">Information URI <span class="required">*</span></label>
      <input type="url" id="entityInformationURI" name="entityInformationURI" required
        value="${escape(v.entityInformationURI ?? "")}" maxlength="500">
      <span class="field-help">Public URI with information about the entity.</span>
      ${fieldError("entityInformationURI")}
    </div>
  </div>

  <div class="card">
    <h2>Services</h2>
    <p class="field-help">At least one service must be registered.</p>

    <div id="services-container">
      ${renderAllServices(v, errors)}
    </div>
    <button type="button" class="btn btn-sm" id="add-service-btn" style="margin-top:1rem;">+ Add Service</button>
  </div>

  <div class="card">
    <h2>Required Documents</h2>
    <p class="field-help">The following documents are required for a real application.
    For this testing tool, document upload is not implemented.</p>
    <ul>
      <li><code>{ONBOARDING_AUTHORIZATION}.md</code></li>
      <li><code>{SERVICE_PROVIDER_AGREEMENT}.md</code></li>
    </ul>
  </div>

  <div class="form-actions">
    <button type="submit" class="btn btn-primary">Submit Application</button>
    <a href="/onboarding" class="btn">Cancel</a>
  </div>
</form>

<script>
(function() {
  var existing = document.querySelectorAll("#services-container .service-block").length;
  var nextIdx = existing > 0 ? existing : 1;
  document.getElementById("add-service-btn").onclick = function() {
    var template = document.createElement("template");
    template.innerHTML = ${JSON.stringify(serviceBlockHtml(-1, {}, {}))};
    var html = template.innerHTML.replace(/\\.service_marker\\./g, "[" + nextIdx + "]");
    var div = document.createElement("div");
    div.innerHTML = html;
    document.getElementById("services-container").appendChild(div.firstElementChild);
    nextIdx++;
  };
})();
</script>
`;
}

function renderAllServices(
  v: Record<string, string>,
  errs?: Record<string, string>,
): string {
  const indices = new Set<number>();
  for (const key of Object.keys(v)) {
    const m = key.match(/^service\[(\d+)\]\./);
    if (m) indices.add(parseInt(m[1]!, 10));
  }
  for (const key of Object.keys(errs ?? {})) {
    const m = key.match(/^service\[(\d+)\]\./);
    if (m) indices.add(parseInt(m[1]!, 10));
  }
  if (indices.size === 0) {
    return serviceBlockHtml(0, v, errs);
  }
  const sorted = Array.from(indices).sort((a, b) => a - b);
  return sorted.map((i) => serviceBlockHtml(i, v, errs)).join("");
}

function serviceBlockHtml(
  i: number,
  v: Record<string, string>,
  errs?: Record<string, string>,
): string {
  const suffix = i >= 0 ? `[${i}]` : ".service_marker.";
  const f = (n: string) => `service${suffix}.${n}`;
  const e = (n: string): string =>
    errs?.[f(n)]
      ? `<span class="field-error">${escape(errs?.[f(n)] ?? "")}</span>`
      : "";

  return `
<div class="service-block card" style="border:1px solid #e2e8f0;">
  <h3>Service ${i >= 0 ? i + 1 : "N"}</h3>
  <div class="form-group">
    <label>Service Type <span class="required">*</span></label>
    <select name="${escape(f("serviceType"))}" required>
      <option value="">-- Select --</option>
      <option value="issuance" ${
        v[f("serviceType")] === "issuance" ? "selected" : ""
      }>Wallet Solution Issuance</option>
      <option value="revocation" ${
        v[f("serviceType")] === "revocation" ? "selected" : ""
      }>Wallet Solution Revocation</option>
    </select>
    <span class="field-help">Select the Wallet Provider service type.</span>
    ${e("serviceType")}
  </div>
  <div class="form-group">
    <label>Service Name <span class="required">*</span></label>
    <input type="text" name="${escape(f("serviceName"))}" required
      value="${escape(v[f("serviceName")] ?? "")}" maxlength="200">
    <span class="field-help">Human-readable service name (English).</span>
    ${e("serviceName")}
  </div>
  <div class="form-group">
    <label>X.509 Certificate (PEM) <span class="required">*</span></label>
    <textarea name="${escape(f("certificatePem"))}" required rows="4"
      placeholder="-----BEGIN CERTIFICATE-----&#10;...&#10;-----END CERTIFICATE-----">${escape(v[f("certificatePem")] ?? "")}</textarea>
    <span class="field-help">The service's X.509 certificate in PEM format.</span>
    ${e("certificatePem")}
  </div>
  <div class="form-group">
    <label>Service Unique Identifier (URI) <span class="required">*</span></label>
    <input type="url" name="${escape(f("serviceUniqueIdentifier"))}" required
      value="${escape(v[f("serviceUniqueIdentifier")] ?? "")}" maxlength="500">
    <span class="field-help">Unique URI identifying this service instance.</span>
    ${e("serviceUniqueIdentifier")}
  </div>
</div>
`;
}

function escape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
