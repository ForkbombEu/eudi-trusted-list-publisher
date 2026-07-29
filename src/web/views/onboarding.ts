import { LIST_FAMILIES } from "../../core/authoring/list-family-catalogue.js";
import type { ProfileFamily } from "../../core/profiles/registry.js";

/**
 * Implemented onboarding routes are singular; the profile registry keys are
 * plural. Only families listed here are linkable.
 */
const ONBOARDING_ROUTES: Partial<Record<ProfileFamily, string>> = {
  "wallet-providers": "/onboarding/wallet-provider",
  "pid-providers": "/onboarding/pid-provider",
};

export function onboardingCatalogueHtml(): string {
  let cards = "";
  for (const f of LIST_FAMILIES) {
    const route = ONBOARDING_ROUTES[f.key];
    const enabled = f.enabled && route !== undefined;
    const status = enabled
      ? '<span class="badge badge-assurance">Available</span>'
      : `<span class="badge badge-neutral">${escape(f.notImplementedNote)}</span>`;
    const action = enabled
      ? `<a href="${escape(route!)}" class="btn btn-primary btn-md">Start Application</a>`
      : `<span class="onboarding-card-note">Onboarding for this family is not available yet.</span>`;
    cards += `
    <div class="card onboarding-card${enabled ? "" : " card-disabled"}">
      <div class="onboarding-card-head">
        <h3>${escape(f.label)}</h3>
        ${status}
      </div>
      <p class="onboarding-card-key"><code>${escape(f.key)}</code></p>
      <div class="onboarding-card-action">${action}</div>
    </div>`;
  }

  return `
<h1>Welcome to Credimi Trusted List onboarding tool</h1>
<p class="lead">Apply to be listed as a trusted entity in a TS 119 602 List of
Trusted Entities. Wallet Provider and PID Provider onboarding are implemented;
the remaining families are planned.</p>

<div class="notice notice-warning">
  <strong>&#x26A0; Testing tool.</strong>
  This is a test/debug fixture publisher, not an official or production Trusted List Provider.
</div>

<div class="section-header"><h2>List Families</h2></div>
<div class="onboarding-grid">${cards}
</div>
`;
}

export interface ListOption {
  key: string;
  label: string;
}

/** Per-family wording. Field names and the POST contract are identical. */
interface FormProfile {
  title: string;
  action: string;
  entityHelp: string;
  listHelp: string;
  noListsMessage: string;
  serviceTypeHelp: string;
  issuanceLabel: string;
  revocationLabel: string;
  extraEntityFields: string;
}

const WALLET_PROFILE: FormProfile = {
  title: "Wallet Provider Application",
  action: "/onboarding/wallet-provider",
  entityHelp: "The legal entity applying for Wallet Provider status.",
  listHelp:
    "Choose the Wallet Providers list this application should be added to.",
  noListsMessage:
    "No Wallet Provider lists are configured. Add entries to your signing-config.",
  serviceTypeHelp: "Select the Wallet Provider service type.",
  issuanceLabel: "Wallet Solution Issuance",
  revocationLabel: "Wallet Solution Revocation",
  extraEntityFields: "",
};

const PID_PROFILE = (
  v: Record<string, string>,
  errors?: Record<string, string>,
): FormProfile => ({
  title: "PID Provider Application",
  action: "/onboarding/pid-provider",
  entityHelp:
    "The legal entity applying to be listed as a Person Identification Data (PID) Provider.",
  listHelp:
    "Choose the PID Providers list of the Member State that supervises this provider.",
  noListsMessage:
    "No PID Provider lists are configured. Add entries to your signing-config.",
  serviceTypeHelp: "Select the PID service type.",
  issuanceLabel: "PID Issuance",
  revocationLabel: "PID Revocation",
  extraEntityFields: `
    <div class="form-group">
      <label for="responsibleMemberState">Responsible Member State <span class="required">*</span></label>
      <input type="text" id="responsibleMemberState" name="responsibleMemberState" required
        maxlength="2" pattern="[A-Z]{2}" placeholder="e.g. DK"
        value="${escape(v.responsibleMemberState ?? "")}">
      <span class="field-help">ISO 3166-1 alpha-2 code of the Member State responsible for this PID provider.</span>
      ${
        errors?.responsibleMemberState
          ? `<span class="field-error">${escape(errors.responsibleMemberState)}</span>`
          : ""
      }
    </div>`,
});

export function walletProviderFormHtml(
  values?: Record<string, string>,
  errors?: Record<string, string>,
  listOptions?: ListOption[],
): string {
  return providerFormHtml(WALLET_PROFILE, values, errors, listOptions);
}

export function pidProviderFormHtml(
  values?: Record<string, string>,
  errors?: Record<string, string>,
  listOptions?: ListOption[],
): string {
  return providerFormHtml(
    PID_PROFILE(values ?? {}, errors),
    values,
    errors,
    listOptions,
  );
}

function providerFormHtml(
  profile: FormProfile,
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
    listSelect = `
      <p class="field-help">${escape(profile.listHelp)}</p>
      <p class="field-error">${escape(profile.noListsMessage)}</p>`;
  } else if (opts.length === 1) {
    listSelect = `
      <input type="hidden" name="targetListKey" value="${escape(opts[0]!.key)}">
      <p><strong>Target List:</strong> <code>${escape(opts[0]!.key)}</code> &mdash; ${escape(opts[0]!.label)}</p>
      <p class="field-help">${escape(profile.listHelp)}</p>`;
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
        <span class="field-help">${escape(profile.listHelp)}</span>
        ${fieldError("targetListKey")}
      </div>`;
  }

  return `
<h1>${escape(profile.title)}</h1>
<div class="notice notice-warning">
  <strong>&#x26A0; Testing tool.</strong> This is a test/debug fixture publisher.
</div>

<form method="post" action="${escape(profile.action)}" class="onboarding-form">
  <div class="card">
    <h2>List Selection</h2>
    ${listSelect}
  </div>

  <div class="card">
    <h2>Entity Information</h2>
    <p class="field-help">${escape(profile.entityHelp)}</p>
${profile.extraEntityFields}
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
      ${renderAllServices(profile, v, errors)}
    </div>
    <button type="button" class="btn btn-outline btn-sm" id="add-service-btn" style="margin-top:1rem;">+ Add Service</button>
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
    <button type="submit" class="btn btn-primary btn-md">Submit Application</button>
    <a href="/onboarding" class="btn btn-outline btn-md">Cancel</a>
  </div>
</form>

<script>
(function() {
  var initialNext = ${computeNextServiceIndex(v, errors)};
  var nextIdx = initialNext;
  document.getElementById("add-service-btn").onclick = function() {
    var template = document.createElement("template");
    template.innerHTML = ${JSON.stringify(serviceBlockHtml(profile, -1, {}, {}))};
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
  profile: FormProfile,
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
    return serviceBlockHtml(profile, 0, v, errs);
  }
  const sorted = Array.from(indices).sort((a, b) => a - b);
  return sorted.map((i) => serviceBlockHtml(profile, i, v, errs)).join("");
}

function serviceBlockHtml(
  profile: FormProfile,
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
<div class="service-block card">
  <h3>Service ${i >= 0 ? i + 1 : "N"}</h3>
  <div class="form-group">
    <label>Service Type <span class="required">*</span></label>
    <select name="${escape(f("serviceType"))}" required>
      <option value="">-- Select --</option>
      <option value="issuance" ${
        v[f("serviceType")] === "issuance" ? "selected" : ""
      }>${escape(profile.issuanceLabel)}</option>
      <option value="revocation" ${
        v[f("serviceType")] === "revocation" ? "selected" : ""
      }>${escape(profile.revocationLabel)}</option>
    </select>
    <span class="field-help">${escape(profile.serviceTypeHelp)}</span>
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

function computeNextServiceIndex(
  v: Record<string, string>,
  errs?: Record<string, string>,
): number {
  let max = -1;
  for (const key of Object.keys(v)) {
    const m = key.match(/^service\[(\d+)\]\./);
    if (m) max = Math.max(max, parseInt(m[1]!, 10));
  }
  for (const key of Object.keys(errs ?? {})) {
    const m = key.match(/^service\[(\d+)\]\./);
    if (m) max = Math.max(max, parseInt(m[1]!, 10));
  }
  return Math.max(1, max + 1);
}

export { computeNextServiceIndex };
