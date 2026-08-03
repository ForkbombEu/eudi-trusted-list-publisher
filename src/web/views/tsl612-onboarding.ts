/**
 * The EAA and QEAA onboarding forms.
 *
 * They use the same shell, cards and field styles as the TS 119 602 forms and
 * introduce no new CSS. What differs is what the two standards actually
 * collect: a TSP with a trade name, a registration identifier published as
 * `TSPTradeName`, and service definition URIs — none of which the TS 119 602
 * forms have a place for.
 *
 * The Scheme Territory is never asked for. It belongs to the target list, so
 * the form shows it read-only once a list is chosen; asking again would invite
 * two country values that disagree.
 */
import { familyChip, listChip } from "./colors.js";
import {
  CERTIFICATE_FIELD_LABEL,
  CERTIFICATE_GUIDE_PATH,
} from "./certificate-guide.js";
import { getTslProfile, type TslFamily } from "../../core/tsl612/registry.js";

export interface TrustedListOption {
  readonly key: string;
  readonly label: string;
  readonly territory: string;
}

function escape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

interface Copy {
  readonly title: string;
  readonly action: string;
  readonly family: TslFamily;
  readonly lead: string;
  readonly evidenceLabel: string;
  readonly evidenceHelp: string;
  readonly statusCard: string;
  readonly certificatePurpose: string;
}

const EAA_COPY: Copy = {
  title: "EAA Provider Application",
  action: "/onboarding/eaa-provider",
  family: "eaa-providers",
  lead: "Apply to be listed as a provider of non-qualified electronic attestations of attributes in a national ETSI TS 119 612 Trusted List. The list is published as signed XML.",
  evidenceLabel: "Evidence of national recognition",
  evidenceHelp:
    "Describe the decision, decree or register entry by which the Member State recognises this provider at national level. It is kept for administrator review and is never published in the Trusted List.",
  statusCard:
    "Approval publishes the service as <strong>recognised at national level</strong>, with a status starting time taken from the publication event. Deprecating the recognition later publishes a new version and moves the recognised state into ServiceHistory; the version that listed it stays authentic and downloadable.",
  certificatePurpose:
    "the public key that verifies the electronic attestations of attributes this service issues",
};

const QEAA_COPY: Copy = {
  title: "QEAA Provider Application",
  action: "/onboarding/qeaa-provider",
  family: "qeaa-providers",
  lead: "Apply to be listed as a qualified provider of electronic attestations of attributes in a national ETSI TS 119 612 Trusted List. The list is published as signed XML.",
  evidenceLabel: "Evidence of qualified status",
  evidenceHelp:
    "Describe the supervisory decision granting qualified status to this service. It is kept for administrator review and is never published in the Trusted List.",
  statusCard:
    "Approval publishes the service as <strong>granted</strong>, with a status starting time taken from the publication event. Withdrawing qualified status later publishes a new version and moves the granted state into ServiceHistory; the version that listed it stays authentic and downloadable.",
  certificatePurpose:
    "the public key that verifies the qualified electronic attestations of attributes this service issues",
};

function field(
  name: string,
  label: string,
  values: Record<string, string>,
  errors: Record<string, string> | undefined,
  options: {
    required?: boolean;
    help?: string;
    type?: string;
    rows?: number;
    placeholder?: string;
  } = {},
): string {
  const error = errors?.[name]
    ? `<span class="field-error">${escape(errors[name] ?? "")}</span>`
    : "";
  const value = escape(values[name] ?? "");
  const required = options.required ? " required" : "";
  const mark = options.required ? " *" : "";
  const help = options.help ? `<p class="field-help">${options.help}</p>` : "";
  const control =
    options.rows && options.rows > 1
      ? `<textarea id="${name}" name="${name}" rows="${options.rows}"${required} placeholder="${escape(options.placeholder ?? "")}">${value}</textarea>`
      : `<input type="${options.type ?? "text"}" id="${name}" name="${name}" value="${value}"${required} placeholder="${escape(options.placeholder ?? "")}">`;
  return `
    <div class="form-group">
      <label for="${name}">${escape(label)}${mark}</label>
      ${control}
      ${help}
      ${error}
    </div>`;
}

function trustedListForm(
  copy: Copy,
  values?: Record<string, string>,
  errors?: Record<string, string>,
  lists?: readonly TrustedListOption[],
): string {
  const v = values ?? {};
  const options = lists ?? [];
  const profile = getTslProfile(copy.family);
  const fieldError = (name: string): string =>
    errors?.[name]
      ? `<span class="field-error">${escape(errors[name] ?? "")}</span>`
      : "";

  const selected =
    options.find((option) => option.key === v["listKey"]) ??
    (options.length === 1 ? options[0] : undefined);

  let listSelect: string;
  if (options.length === 0) {
    listSelect = `<p class="field-error">No XML Trusted List is configured that accepts ${escape(profile.label)}. An administrator creates one from Administration &rarr; Create Trusted List.</p>`;
  } else if (options.length === 1) {
    listSelect = `
      <input type="hidden" name="listKey" value="${escape(options[0]!.key)}">
      <p><strong>Target Trusted List:</strong> ${listChip(options[0]!.key)} &mdash; ${escape(options[0]!.label)}</p>`;
  } else {
    listSelect = `
      <div class="form-group">
        <label for="listKey">Target Trusted List *</label>
        <select id="listKey" name="listKey" required>
          <option value="">Choose a Trusted List</option>
          ${options
            .map(
              (option) =>
                `<option value="${escape(option.key)}"${option.key === v["listKey"] ? " selected" : ""}>${escape(option.label)}</option>`,
            )
            .join("")}
        </select>
        <p class="field-help">The list decides the Scheme Territory and which service profiles it accepts.</p>
        ${fieldError("listKey")}
      </div>`;
  }

  /* Read-only, and taken from the list: the applicant states no second country. */
  const territory = selected
    ? `<p><strong>Scheme Territory:</strong> <code>${escape(selected.territory)}</code>
         <span class="field-help">Taken from the selected Trusted List. The registration identifier is published with this country code.</span></p>`
    : `<p class="field-help">The Scheme Territory is taken from the Trusted List you select.</p>`;

  const kind = v["registrationIdentifierKind"] ?? "national";

  return `
<h1>${escape(copy.title)}</h1>
<p class="lead lead-wide">${escape(copy.lead)}</p>
<p>${familyChip(copy.family)} <span class="chip chip-standard">ETSI TS 119 612</span> <span class="chip chip-format">XML / XAdES-B-B</span></p>

<form method="post" action="${escape(copy.action)}" class="onboarding-form">

  <div class="card">
    <h2>Trusted List</h2>
    ${listSelect}
    ${territory}
    ${fieldError("listKey")}
  </div>

  <div class="card">
    <h2>Trust Service Provider</h2>
    ${field("tspName", "TSP legal name", v, errors, {
      required: true,
      help: "The exact registered legal name. It is published as <code>TSPName</code>.",
    })}
    <div class="form-group">
      <label for="registrationIdentifierKind">Registration identifier type *</label>
      <select id="registrationIdentifierKind" name="registrationIdentifierKind" required>
        <option value="vat"${kind === "vat" ? " selected" : ""}>VAT identifier</option>
        <option value="national"${kind === "national" ? " selected" : ""}>National register identifier</option>
      </select>
      <p class="field-help">A VAT identifier is published as <code>VAT&lt;CC&gt;-</code>; anything else as <code>NTR&lt;CC&gt;-</code>.</p>
      ${fieldError("registrationIdentifierKind")}
    </div>
    ${field(
      "registrationIdentifier",
      "Official registration identifier",
      v,
      errors,
      {
        required: true,
        help: "Published in <code>TSPTradeName</code> with the prefix above. Enter the identifier only; the prefix is added for you.",
      },
    )}
    ${field("tradeName", "TSP trade name", v, errors, {
      help: "Optional. Required only when the service certificate's subject organisation differs from the legal name above, in which case it must be exactly that organisation.",
    })}
  </div>

  <div class="card">
    <h2>Address and contact</h2>
    ${field("streetAddress", "Street address", v, errors, { required: true })}
    ${field("locality", "Locality", v, errors, { required: true })}
    ${field("stateOrProvince", "State or province", v, errors, {})}
    ${field("postalCode", "Postal code", v, errors, {})}
    ${field("countryName", "Country", v, errors, {
      required: true,
      help: "The country of the provider's registered address.",
    })}
    ${field("email", "Email", v, errors, { required: true, type: "email" })}
    ${field("website", "Website", v, errors, {
      required: true,
      placeholder: "https://",
    })}
    ${field("telephone", "Telephone", v, errors, {
      help: "Optional. Published as a <code>tel:</code> URI.",
    })}
    ${field("tspInformationUri", "TSP policies and practices URL", v, errors, {
      required: true,
      placeholder: "https://",
      help: "Published as <code>TSPInformationURI</code>.",
    })}
  </div>

  <div class="card">
    <h2>Service</h2>
    <p class="field-help">The service is published with type <code>${escape(profile.serviceTypeIdentifier)}</code>.</p>
    ${field("serviceName", "Service name", v, errors, { required: true })}
    <div class="form-group">
      <label for="certificatePem">${escape(CERTIFICATE_FIELD_LABEL)} *</label>
      <textarea id="certificatePem" name="certificatePem" rows="10" required placeholder="-----BEGIN CERTIFICATE-----">${escape(v["certificatePem"] ?? "")}</textarea>
      <p class="field-help">
        This certificate identifies ${escape(copy.certificatePurpose)}.
        It is published as <code>ServiceDigitalIdentity</code> in Base64 DER.
        Set the subject organisation (O) to exactly the TSP legal name; if it
        differs, supply that organisation as the TSP trade name and a Scheme
        Service Definition URL documenting the relationship.
        The private key is never uploaded.
        See the <a href="${escape(CERTIFICATE_GUIDE_PATH)}">Certificate creation guide</a>.
      </p>
      ${fieldError("certificatePem")}
    </div>
    ${field(
      "schemeServiceDefinitionUri",
      "Scheme service definition URL",
      v,
      errors,
      {
        placeholder: "https://",
        help: "Optional, unless the certificate subject organisation differs from the TSP legal name.",
      },
    )}
    ${field(
      "tspServiceDefinitionUri",
      "TSP service definition URL",
      v,
      errors,
      {
        placeholder: "https://",
        help: "Optional.",
      },
    )}
    ${field("serviceSupplyPoints", "Service supply points", v, errors, {
      rows: 3,
      help: "Optional. One URL per line.",
    })}
  </div>

  <div class="card">
    <h2>${escape(copy.evidenceLabel)}</h2>
    ${field("evidence", copy.evidenceLabel, v, errors, {
      required: true,
      rows: 5,
      help: copy.evidenceHelp,
    })}
  </div>

  <div class="card">
    <h2>Status and lifecycle</h2>
    <p>${copy.statusCard}</p>
  </div>

  <div class="form-actions">
    <button type="submit" class="btn btn-primary btn-md">Submit application</button>
  </div>
</form>`;
}

export function eaaProviderFormHtml(
  values?: Record<string, string>,
  errors?: Record<string, string>,
  lists?: readonly TrustedListOption[],
): string {
  return trustedListForm(EAA_COPY, values, errors, lists);
}

export function qeaaProviderFormHtml(
  values?: Record<string, string>,
  errors?: Record<string, string>,
  lists?: readonly TrustedListOption[],
): string {
  return trustedListForm(QEAA_COPY, values, errors, lists);
}

/** The standard and format chips every XML page carries. */
export function xmlStandardChips(): string {
  return `<span class="chip chip-standard">ETSI TS 119 612</span> <span class="chip chip-format">XML / XAdES-B-B</span>`;
}
