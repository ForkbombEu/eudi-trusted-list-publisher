import { LIST_FAMILIES } from "../../core/authoring/list-family-catalogue.js";
import type { ProfileFamily } from "../../core/profiles/registry.js";
import { familyChip, listChip } from "./colors.js";
import {
  CERTIFICATE_FIELD_LABEL,
  CERTIFICATE_GUIDE_PATH,
} from "./certificate-guide.js";

/**
 * Implemented onboarding routes are singular; the profile registry keys are
 * plural. Only families listed here are linkable.
 */
const ONBOARDING_ROUTES: Partial<Record<ProfileFamily, string>> = {
  "wallet-providers": "/onboarding/wallet-provider",
  "pid-providers": "/onboarding/pid-provider",
  "wrpac-providers": "/onboarding/wrpac-provider",
  "wrprc-providers": "/onboarding/wrprc-provider",
  "pub-eaa-providers": "/onboarding/pub-eaa-provider",
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
      <p class="onboarding-card-key">${familyChip(f.key, f.key)}</p>
      <div class="onboarding-card-action">${action}</div>
    </div>`;
  }

  return `
<h1>Trusted List onboarding</h1>
<p class="lead lead-wide">Apply to be listed as a trusted entity in a TS 119 602
List of Trusted Entities. Describe your entity and its services, and the scheme
operator reviews the application. Once approved, it is compiled into the target
Trusted List, signed as Compact JAdES and published as a new immutable
version.</p>

<div class="section-header"><h2>Trusted List Families</h2></div>
<div class="onboarding-grid">${cards}
</div>
`;
}

export interface ListOption {
  key: string;
  label: string;
  /**
   * Defect IDs the list is deliberately generated with, empty for an ordinary
   * list. An applicant choosing a target list must be able to see that it is an
   * intentionally broken test fixture before onboarding to it.
   */
  defects?: string[];
}

/**
 * Shown once under the Services card, in both profiles. What the certificate is
 * *for* differs per profile and is said on the field itself.
 */
const CERTIFICATE_EXPLANATION =
  "The certificate is published as the service ServiceDigitalIdentity, so its " +
  "subject must identify the provider: set the organisation (O) to exactly the " +
  "Entity Name entered above. It may be self-signed or issued by a CA — this " +
  "publisher does not build or verify a certification path, so a self-signed " +
  "certificate is accepted.";

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
  /**
   * The entity's public HTTP(S) URI. Annex D/E collect an information page;
   * Annex F/G collect the provider's policies and terms URL.
   */
  informationField: { name: string; label: string; help: string };
  /** Rendered directly after the information field. */
  extraUriFields: string;
  /** Annex D/E only; Annex F/G/H services carry no unique identifier. */
  requiresServiceUniqueIdentifier: boolean;
  /** Annex H makes the service digital identity optional. */
  requiresServiceCertificate: boolean;
  /** What this profile's service certificate is used for. */
  certificatePurpose: string;
  /**
   * Shown in a closing card: what being listed means in this profile, said in
   * words because the artifact cannot say it in every family.
   */
  mandateNote: string;
  /** Heading of that closing card. */
  mandateTitle: string;
}

/** The Responsible Member State field, shared by Annex D, F and G. */
function memberStateField(
  v: Record<string, string>,
  errors: Record<string, string> | undefined,
  help: string,
  placeholder: string,
): string {
  return `
    <div class="form-group">
      <label for="responsibleMemberState">Responsible Member State <span class="required">*</span></label>
      <input type="text" id="responsibleMemberState" name="responsibleMemberState" required
        maxlength="2" pattern="[A-Z]{2}" placeholder="e.g. ${escape(placeholder)}"
        value="${escape(v.responsibleMemberState ?? "")}">
      <span class="field-help">${escape(help)}</span>
      ${
        errors?.responsibleMemberState
          ? `<span class="field-error">${escape(errors.responsibleMemberState)}</span>`
          : ""
      }
    </div>`;
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
  informationField: {
    name: "entityInformationURI",
    label: "Information URI",
    help: "Public URI with information about the entity.",
  },
  extraUriFields: "",
  requiresServiceUniqueIdentifier: true,
  certificatePurpose:
    "The certificate used to authenticate and validate components of the " +
    "wallet unit supplied under the wallet solution.",
  requiresServiceCertificate: true,
  mandateNote: "",
  mandateTitle: "",
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
  informationField: {
    name: "entityInformationURI",
    label: "Information URI",
    help: "Public URI with information about the entity.",
  },
  extraUriFields: "",
  requiresServiceUniqueIdentifier: true,
  certificatePurpose:
    "The certificate used to verify signatures or seals created by the PID " +
    "Provider on issued PID.",
  requiresServiceCertificate: true,
  mandateNote: "",
  mandateTitle: "",
  extraEntityFields: memberStateField(
    v,
    errors,
    "ISO 3166-1 alpha-2 code of the Member State responsible for this PID provider.",
    "DK",
  ),
});

/**
 * Annex F (WRPAC) and Annex G (WRPRC) share their whole form: only the wording,
 * the route and the certificate purpose differ. Both collect the mandating
 * Member State, an optional official registration identifier, the policies and
 * terms URL and an optional further information page, and neither collects a
 * service unique identifier.
 */
function relyingPartyProfile(
  options: {
    title: string;
    action: string;
    certificateKind: string;
    serviceKindLabel: string;
    entityHelp: string;
    listLabel: string;
  },
  v: Record<string, string>,
  errors?: Record<string, string>,
): FormProfile {
  const fieldError = (name: string): string =>
    errors?.[name]
      ? `<span class="field-error">${escape(errors[name] ?? "")}</span>`
      : "";
  return {
    title: options.title,
    action: options.action,
    entityHelp: options.entityHelp,
    listHelp: `Choose the ${options.listLabel} list of the Member State that mandates this provider.`,
    noListsMessage: `No ${options.listLabel} lists are configured. Add entries to your signing-config.`,
    serviceTypeHelp: `Select the ${options.serviceKindLabel} service type. Register issuance, revocation, or both.`,
    issuanceLabel: `${options.serviceKindLabel} Issuance`,
    revocationLabel: `${options.serviceKindLabel} Revocation`,
    requiresServiceUniqueIdentifier: false,
    requiresServiceCertificate: true,
    certificatePurpose: `The certificate used to verify signatures or seals created by the ${options.serviceKindLabel} Provider on issued ${options.certificateKind}.`,
    informationField: {
      name: "entityPolicyURI",
      label: "Policies and Terms URL",
      help:
        "Public URL of the policies and terms under which the provider issues " +
        "certificates. Published as the entity's information URI.",
    },
    extraUriFields: `
    <div class="form-group">
      <label for="additionalInformationURI">Additional Information URL</label>
      <input type="url" id="additionalInformationURI" name="additionalInformationURI"
        value="${escape(v.additionalInformationURI ?? "")}" maxlength="500">
      <span class="field-help">Optional. Published beside the policies URL when supplied.</span>
      ${fieldError("additionalInformationURI")}
    </div>`,
    mandateTitle: "Mandate",
    mandateNote:
      "Being listed states that this provider is currently mandated by the " +
      "Responsible Member State. These profiles publish no service status and " +
      "no status starting time: a provider that loses its mandate is removed " +
      "from the next version of the list rather than marked withdrawn.",
    extraEntityFields: `${memberStateField(
      v,
      errors,
      "ISO 3166-1 alpha-2 code of the Member State that mandates this provider. It is published in the entity role URI.",
      "PL",
    )}
    <div class="form-group">
      <label for="registrationIdentifier">Official Registration Identifier</label>
      <input type="text" id="registrationIdentifier" name="registrationIdentifier"
        value="${escape(v.registrationIdentifier ?? "")}" maxlength="120">
      <span class="field-help">Where available: the identifier under which the
        entity is registered in an official register. Recorded with the
        application for review.</span>
      ${fieldError("registrationIdentifier")}
    </div>`,
  };
}

/**
 * Annex H (Pub-EAA). Two fields exist only here: the legal basis the
 * notification rests on, which is published as an `OJ:` URI, and an optional
 * certificate — Annex H is the only implemented profile whose service digital
 * identity may be absent, and the only one that publishes a service status.
 */
function pubEaaProfile(
  v: Record<string, string>,
  errors?: Record<string, string>,
): FormProfile {
  const fieldError = (name: string): string =>
    errors?.[name]
      ? `<span class="field-error">${escape(errors[name] ?? "")}</span>`
      : "";
  return {
    title: "Pub-EAA Provider Application",
    action: "/onboarding/pub-eaa-provider",
    entityHelp:
      "The legal entity applying to be listed as a provider of publicly " +
      "issued electronic attestations of attributes (Pub-EAA). Enter the " +
      "exact registered provider name.",
    listHelp:
      "Choose the Pub-EAA Providers list of the Member State that notified this provider.",
    noListsMessage:
      "No Pub-EAA Provider lists are configured. Add entries to your signing-config.",
    serviceTypeHelp:
      "Select the Pub-EAA service type. Register issuance, revocation, or both.",
    issuanceLabel: "Pub-EAA Issuance",
    revocationLabel: "Pub-EAA Revocation",
    requiresServiceUniqueIdentifier: false,
    requiresServiceCertificate: false,
    certificatePurpose:
      "Optional. The certificate used to verify signatures or seals created " +
      "by the Pub-EAA Provider on issued attestations, or the certificate of " +
      "the CA that issues those attestation-signing certificates. More than " +
      "one may be supplied, provided they carry the same public key and an " +
      "identical subject.",
    informationField: {
      name: "entityPolicyURI",
      label: "Policies and Terms URL",
      help:
        "Public URL of the policies and terms under which the provider issues " +
        "attestations. Published as the entity's information URI.",
    },
    extraUriFields: "",
    mandateTitle: "Notification",
    mandateNote:
      "Being listed states that this provider is currently notified by the " +
      "Responsible Member State. Every service is published with the status " +
      "notified and a status starting time taken from the publication event. " +
      "If the notification is withdrawn, a new immutable list version is " +
      "published in which every service reads withdrawn and the previous " +
      "notified state is kept in the service history.",
    extraEntityFields: `${memberStateField(
      v,
      errors,
      "ISO 3166-1 alpha-2 code of the Member State that notified this provider. It is published in the entity role URI.",
      "IT",
    )}
    <div class="form-group">
      <label for="registrationIdentifier">Official Registration Identifier</label>
      <input type="text" id="registrationIdentifier" name="registrationIdentifier"
        value="${escape(v.registrationIdentifier ?? "")}" maxlength="120">
      <span class="field-help">When available: the identifier under which the
        entity is registered in an official register. Recorded with the
        application for review.</span>
      ${fieldError("registrationIdentifier")}
    </div>
    <div class="form-group">
      <label for="legalBasisReference">Legal Basis Reference <span class="required">*</span></label>
      <input type="text" id="legalBasisReference" name="legalBasisReference" required
        value="${escape(v.legalBasisReference ?? "")}" maxlength="200"
        placeholder="e.g. OJ:L_202401183">
      <span class="field-help">The Union or national act under which the
        attestations are issued, as an Official Journal reference. Published as
        an <code>OJ:</code> URI; the prefix is added for you.</span>
      ${fieldError("legalBasisReference")}
    </div>`,
  };
}

export function pubEaaProviderFormHtml(
  values?: Record<string, string>,
  errors?: Record<string, string>,
  listOptions?: ListOption[],
): string {
  return providerFormHtml(
    pubEaaProfile(values ?? {}, errors),
    values,
    errors,
    listOptions,
  );
}

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

export function wrpacProviderFormHtml(
  values?: Record<string, string>,
  errors?: Record<string, string>,
  listOptions?: ListOption[],
): string {
  return providerFormHtml(
    relyingPartyProfile(
      {
        title: "WRPAC Provider Application",
        action: "/onboarding/wrpac-provider",
        certificateKind: "wallet-relying-party access certificates",
        serviceKindLabel: "WRPAC",
        entityHelp:
          "The legal entity applying to be listed as a provider of " +
          "Wallet-Relying-Party Access Certificates (WRPAC).",
        listLabel: "WRPAC Providers",
      },
      values ?? {},
      errors,
    ),
    values,
    errors,
    listOptions,
  );
}

export function wrprcProviderFormHtml(
  values?: Record<string, string>,
  errors?: Record<string, string>,
  listOptions?: ListOption[],
): string {
  return providerFormHtml(
    relyingPartyProfile(
      {
        title: "WRPRC Provider Application",
        action: "/onboarding/wrprc-provider",
        certificateKind: "wallet-relying-party registration certificates",
        serviceKindLabel: "WRPRC",
        entityHelp:
          "The legal entity applying to be listed as a provider of " +
          "Wallet-Relying-Party Registration Certificates (WRPRC).",
        listLabel: "WRPRC Providers",
      },
      values ?? {},
      errors,
    ),
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
      <p><strong>Target List:</strong> ${listChip(opts[0]!.key)} &mdash; ${escape(opts[0]!.label)}${brokenMarker(opts[0]!)}</p>
      ${brokenListWarning(opts.filter(isBroken))}
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
                `<option value="${escape(o.key)}" ${v.targetListKey === o.key ? "selected" : ""}>${escape(
                  isBroken(o) ? `\u26A0 BROKEN \u2014 ${o.label}` : o.label,
                )}</option>`,
            )
            .join("")}
        </select>
        ${brokenListWarning(opts.filter(isBroken))}
        <span class="field-help">${escape(profile.listHelp)}</span>
        ${fieldError("targetListKey")}
      </div>`;
  }

  return `
<h1>${escape(profile.title)}</h1>

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
      <label for="${escape(profile.informationField.name)}">${escape(profile.informationField.label)} <span class="required">*</span></label>
      <input type="url" id="${escape(profile.informationField.name)}" name="${escape(profile.informationField.name)}" required
        value="${escape(v[profile.informationField.name] ?? "")}" maxlength="500">
      <span class="field-help">${escape(profile.informationField.help)}</span>
      ${fieldError(profile.informationField.name)}
    </div>
${profile.extraUriFields}

    <div class="form-group">
      <label for="entityEmail">Email Address <span class="required">*</span></label>
      <input type="email" id="entityEmail" name="entityEmail" required
        value="${escape(v.entityEmail ?? "")}" maxlength="200">
      <span class="field-help">Published as a <code>mailto:</code> URI; the profile
        requires the entity to be contactable by email.</span>
      ${fieldError("entityEmail")}
    </div>

    <div class="form-group">
      <label for="entityTelephone">Telephone <span class="required">*</span></label>
      <input type="tel" id="entityTelephone" name="entityTelephone" required
        value="${escape(v.entityTelephone ?? "")}" maxlength="40"
        placeholder="+39 02 1234567">
      <span class="field-help">International form. Published as a
        <code>tel:</code> URI.</span>
      ${fieldError("entityTelephone")}
    </div>
  </div>

  <div class="card">
    <h2>Services</h2>
    <p class="field-help">At least one service must be registered.</p>

    <div id="services-container">
      ${renderAllServices(profile, v, errors)}
    </div>
    <button type="button" class="btn btn-outline btn-sm" id="add-service-btn" style="margin-top:1rem;">+ Add Service</button>
    <p class="field-help">${CERTIFICATE_EXPLANATION}</p>
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

  ${
    profile.mandateNote
      ? `<div class="card">
    <h2>${escape(profile.mandateTitle)}</h2>
    <p class="field-help">${escape(profile.mandateNote)}</p>
  </div>`
      : ""
  }

  <div class="form-actions">
    <button type="submit" class="btn btn-primary btn-md">Submit Application</button>
    <a href="/onboarding" class="btn btn-outline btn-md">Cancel</a>
  </div>
</form>

<script>
(function() {
  var container = document.getElementById("services-container");
  var nextIdx = ${computeNextServiceIndex(v, errors)};

  /*
    Field names keep the index they were created with so a rejected submission
    can be re-rendered as it was posted. Only the visible numbering is
    recomputed, so the blocks always read Service 1, 2, 3 … in page order, and
    only the first block is non-removable.
  */
  function renumber() {
    var blocks = container.querySelectorAll(".service-block");
    for (var i = 0; i < blocks.length; i++) {
      var title = blocks[i].querySelector(".service-block-title");
      if (title) title.textContent = "Service " + (i + 1);
      var remove = blocks[i].querySelector(".service-remove");
      if (remove) remove.hidden = i === 0;
    }
  }

  container.addEventListener("click", function(event) {
    var button = event.target.closest(".service-remove");
    if (!button) return;
    var block = button.closest(".service-block");
    if (!block || container.querySelectorAll(".service-block").length < 2) return;
    block.remove();
    renumber();
  });

  document.getElementById("add-service-btn").onclick = function() {
    var template = document.createElement("template");
    template.innerHTML = ${JSON.stringify(serviceBlockHtml(profile, -1, {}, {}))};
    var html = template.innerHTML.replace(/\\.service_marker\\./g, "[" + nextIdx + "]");
    var div = document.createElement("div");
    div.innerHTML = html;
    container.appendChild(div.firstElementChild);
    nextIdx++;
    renumber();
  };

  renumber();
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

  /*
    The block rendered for the "+ Add Service" template (i < 0) is renumbered
    by the client once it is appended, so it never shows a placeholder heading
    and its remove button is always usable — it can never become the first
    block on the page.
  */
  const position = i >= 0 ? i + 1 : 1;
  const hidden = i === 0 ? " hidden" : "";

  return `
<div class="service-block card">
  <div class="service-block-head">
    <h3 class="service-block-title">Service ${position}</h3>
    <button type="button" class="btn btn-outline btn-sm service-remove"${hidden}>Remove service</button>
  </div>
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
    <label>${escape(CERTIFICATE_FIELD_LABEL)}${
      profile.requiresServiceCertificate
        ? ' <span class="required">*</span>'
        : ""
    }</label>
    <textarea name="${escape(f("certificatePem"))}"${
      profile.requiresServiceCertificate ? " required" : ""
    } rows="8"
      placeholder="-----BEGIN CERTIFICATE-----&#10;...&#10;-----END CERTIFICATE-----">${escape(v[f("certificatePem")] ?? "")}</textarea>
    <span class="field-help">${escape(profile.certificatePurpose)}
      Upload an X.509 certificate beginning with
      <code>-----BEGIN CERTIFICATE-----</code>. For testing, you can generate a
      self-signed certificate using our
      <a href="${CERTIFICATE_GUIDE_PATH}">Certificate creation guide</a>.
      Never upload the private key.</span>
    ${e("certificatePem")}
  </div>
  ${
    profile.requiresServiceUniqueIdentifier
      ? `<div class="form-group">
    <label>Service Unique Identifier (URI) <span class="required">*</span></label>
    <input type="url" name="${escape(f("serviceUniqueIdentifier"))}" required
      value="${escape(v[f("serviceUniqueIdentifier")] ?? "")}" maxlength="500">
    <span class="field-help">Unique URI identifying this service instance.</span>
    ${e("serviceUniqueIdentifier")}
  </div>`
      : ""
  }
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

/** True when a target list was generated as an intentionally broken fixture. */
function isBroken(option: ListOption): boolean {
  return (option.defects ?? []).length > 0;
}

function brokenMarker(option: ListOption): string {
  return isBroken(option)
    ? ` <span class="badge badge-warning" title="Intentionally broken test fixture">&#9888; Broken</span>`
    : "";
}

/**
 * Names the broken lists on offer. Onboarding to one is legitimate — it is how a
 * developer tests that their runtime rejects a bad list — so this explains
 * rather than blocks.
 */
function brokenListWarning(broken: readonly ListOption[]): string {
  if (broken.length === 0) return "";
  const names = broken
    .map((option) => `<code>${escape(option.key)}</code>`)
    .join(", ");
  return `<p class="notice notice-warning"><strong>&#9888; Intentionally broken
  test fixture${broken.length === 1 ? "" : "s"} in this list:</strong> ${names}.
  ${broken.length === 1 ? "This list is" : "These lists are"} deliberately
  non-conformant and exist${broken.length === 1 ? "s" : ""} so an implementation
  can be tested against a list that is known to be bad. Anything registered into
  ${broken.length === 1 ? "it" : "them"} is published through the same defects.
  Do not onboard here for production use.</p>`;
}
