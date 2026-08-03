/**
 * The Create XML Trusted List form.
 *
 * It reuses the onboarding form shell. The fields it adds over the TS 119 602
 * form are the ones a TS 119 612 list cannot be published without: the national
 * scheme-rules URI, the stable XML distribution URL, and the pointer material
 * for the EU LOTL — a Member State list that does not point at the LOTL is not
 * a Member State list.
 */
import { xmlStandardChips } from "./tsl612-onboarding.js";
import { familyChip } from "./colors.js";
import { TSL_PROFILE_REGISTRY } from "../../core/tsl612/registry.js";
import { xmlDefects } from "../../core/tsl612/defects.js";
import { stageLabel } from "./broken-list.js";
import { deriveListKeyFromParts } from "../../core/authoring/list-creation.js";

function escape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface CreateTrustedListFormValues {
  [field: string]: string | string[] | undefined;
}

export interface CreateTrustedListFormOptions {
  readonly error?: string;
  readonly notice?: string;
  readonly canGenerateMaterial?: boolean;
}

function field(
  name: string,
  label: string,
  values: CreateTrustedListFormValues,
  options: {
    required?: boolean;
    help?: string;
    placeholder?: string;
    rows?: number;
  } = {},
): string {
  const raw = values[name];
  const value = escape(typeof raw === "string" ? raw : "");
  const required = options.required ? " required" : "";
  const mark = options.required ? " *" : "";
  const help = options.help ? `<p class="field-help">${options.help}</p>` : "";
  const control =
    options.rows && options.rows > 1
      ? `<textarea id="${name}" name="${name}" rows="${options.rows}"${required} placeholder="${escape(options.placeholder ?? "")}">${value}</textarea>`
      : `<input type="text" id="${name}" name="${name}" value="${value}"${required} placeholder="${escape(options.placeholder ?? "")}">`;
  return `
    <div class="form-group">
      <label for="${name}">${escape(label)}${mark}</label>
      ${control}
      ${help}
    </div>`;
}

/**
 * One checkbox per TS 119 612 defect, read from the canonical catalogue. The
 * form never carries its own list of defects: a defect the XML engine cannot
 * perform must not be offerable.
 */
function defectOptions(selected: readonly string[]): string {
  return xmlDefects()
    .map(
      (defect) => `
      <label class="tl-broken-option">
        <input type="checkbox" name="defects" value="${escape(defect.id)}"${
          selected.includes(defect.id) ? " checked" : ""
        }>
        <span><strong>${escape(defect.label)}</strong>
        <span class="field-help">${escape(defect.description)}</span>
        <span class="field-help">Applied ${escape(stageLabel(defect.stage))}.
        ${escape(defect.normativeReference)}</span></span>
      </label>`,
    )
    .join("");
}

export function createTrustedListFormHtml(
  values?: CreateTrustedListFormValues,
  options: CreateTrustedListFormOptions = {},
): string {
  const v = values ?? {};
  const rawDefects = v["defects"];
  const selectedDefects = Array.isArray(rawDefects)
    ? rawDefects
    : typeof rawDefects === "string"
      ? [rawDefects]
      : [];
  const territory =
    typeof v["schemeTerritory"] === "string" ? v["schemeTerritory"] : "";
  const operator =
    typeof v["schemeOperatorName"] === "string" ? v["schemeOperatorName"] : "";
  const derivedKey =
    territory && operator ? deriveListKeyFromParts(territory, operator) : null;
  const selectedProfiles = Array.isArray(v["allowedServiceProfiles"])
    ? (v["allowedServiceProfiles"] as string[])
    : typeof v["allowedServiceProfiles"] === "string"
      ? [v["allowedServiceProfiles"]]
      : [];

  const profileChecks = Object.values(TSL_PROFILE_REGISTRY)
    .map(
      (profile) => `
      <div class="settings-row">
        <input type="checkbox" id="profile-${escape(profile.family)}" name="allowedServiceProfiles" value="${escape(profile.family)}"${selectedProfiles.includes(profile.family) ? " checked" : ""}>
        <div>
          <label for="profile-${escape(profile.family)}">${familyChip(profile.family)}</label>
          <p class="field-help">Service type <code>${escape(profile.serviceTypeIdentifier)}</code>; published as <code>${escape(profile.initialStatus.split("/").pop() ?? "")}</code> and ended as <code>${escape(profile.endStatus.split("/").pop() ?? "")}</code>.</p>
        </div>
      </div>`,
    )
    .join("");

  return `
<h1>Create XML Trusted List</h1>
<p class="lead lead-wide">Declare a national ETSI TS 119 612 Trusted List and
publish its first, empty version. The list becomes selectable on the onboarding
forms of every service profile it accepts, and version 1 is signed as XAdES-B-B
and assessed by the Trust Inspector immediately.</p>
<p>${xmlStandardChips()}</p>

${options.error ? `<div class="notice notice-error">${escape(options.error)}</div>` : ""}
${options.notice ? `<div class="notice notice-info">${escape(options.notice)}</div>` : ""}

<form method="post" action="/admin/trusted-lists/create" class="onboarding-form">

  <div class="card">
    <h2>Scheme operator</h2>
    ${field("schemeOperatorName", "Scheme operator name", v, {
      required: true,
      help: "Published as <code>SchemeOperatorName</code>. The signing certificate's subject organisation (O) must equal this exactly.",
    })}
    ${field("schemeTerritory", "Scheme territory", v, {
      required: true,
      placeholder: "IT",
      help: "The responsible EU Member State, as a 2-letter code. Not <code>EU</code>: a Member State list states its own territory. The signing certificate's subject country (C) must equal this.",
    })}
    ${field("schemeName", "Scheme name", v, {
      required: true,
      help: "Published as <code>SchemeName</code>, conventionally <code>&lt;CC&gt;:&lt;operator name&gt;</code>.",
    })}
    ${derivedKey ? `<p><strong>List key:</strong> <code>${escape(derivedKey)}</code> <span class="field-help">Derived from the territory and operator name.</span></p>` : ""}
    ${field("schemeOperatorStreet", "Street address", v, { required: true })}
    ${field("schemeOperatorLocality", "Locality", v, { required: true })}
    ${field("schemeOperatorPostalCode", "Postal code", v, {})}
    ${field("schemeOperatorCountry", "Country", v, {
      required: true,
      placeholder: "IT",
    })}
    ${field("schemeOperatorEmail", "Email", v, { required: true })}
    ${field("schemeOperatorWebsite", "Website", v, {
      required: true,
      placeholder: "https://",
    })}
    ${field("schemeOperatorTelephone", "Telephone", v, {
      help: "Optional. Published as a <code>tel:</code> URI.",
    })}
  </div>

  <div class="card">
    <h2>Scheme URIs</h2>
    ${field("schemeInformationUri", "Scheme information URL", v, {
      required: true,
      placeholder: "https://",
    })}
    ${field("nationalSchemeRulesUri", "National scheme rules URL", v, {
      required: true,
      placeholder: "https://",
      help: "Published beside the two ETSI rules URIs, which are added automatically: <code>.../schemerules/EUcommon</code> and <code>.../schemerules/&lt;CC&gt;</code>.",
    })}
    ${field("policyUri", "Policy or legal notice URL", v, {
      required: true,
      placeholder: "https://",
    })}
    ${field("distributionPointUri", "Stable XML distribution URL", v, {
      required: true,
      placeholder: "https://example.eu/tl/trusted-list.xml",
      help: "Where the signed XML is published. It is stated in <code>DistributionPoints</code>.",
    })}
  </div>

  <div class="card">
    <h2>Pointer to the EU LOTL</h2>
    <p class="field-help">Every EU Member State Trusted List points at the EU
    List of Trusted Lists. The Trust Inspector checks that the declared scheme
    operator matches the pointer certificates, so these two fields must
    describe the same list.</p>
    ${field("lotlSchemeOperatorNames", "LOTL scheme operator names", v, {
      required: true,
      rows: 2,
      help: "One name per line, as the pointed-to list states it.",
    })}
    ${field("lotlCertificatesBase64Der", "LOTL signing certificates", v, {
      required: true,
      rows: 6,
      help: "One Base64 DER certificate per line, with no PEM armour.",
    })}
  </div>

  <div class="card">
    <h2>Service profiles accepted</h2>
    <p class="field-help">One XML Trusted List may accept EAA, QEAA or both.
    Only the profiles chosen here appear on the onboarding forms for this list.</p>
    ${profileChecks}
  </div>

  <div class="card">
    <h2>Intentionally broken test fixture</h2>
    <p class="field-help">Leave every box clear for a healthy Trusted List.
    Select one defect to publish a list that is deliberately non-conformant in
    exactly one way, or several to combine them. The list is always compiled
    healthy first and then mutated, so a broken fixture is a stated delta from a
    known-good baseline. <strong>A failing Trust Inspector verdict on such a
    list is the expected outcome, not a publication error.</strong></p>
    <div class="tl-broken-options">${defectOptions(selectedDefects)}</div>
  </div>

  <div class="card">
    <h2>Signing material</h2>
    ${field("keyFile", "Private key file", v, { required: true })}
    ${field("certFile", "Certificate file", v, { required: true })}
    <p class="field-help">The certificate must meet the TS 119 612 Scheme
    Operator profile: subject C equal to the Scheme Territory, subject O equal
    to the Scheme Operator Name, <code>basicConstraints CA:FALSE</code>, a
    SubjectKeyIdentifier, and a key usage limited to
    <code>digitalSignature</code> and/or <code>contentCommitment</code>.</p>
    ${
      options.canGenerateMaterial
        ? `<div class="form-actions">
             <button type="submit" formaction="/admin/trusted-lists/generate-signing-material" class="btn btn-outline btn-md">Generate key and certificate</button>
           </div>
           <p class="field-help">Generates an EC P-256 key and a one-year
           self-signed certificate carrying the <code>tslSigning</code> extended
           key usage, and fills the paths above. No private key is shown.</p>`
        : `<p class="field-help">Server-side generation is unavailable: <code>TLP_CERTIFICATES_DIR</code> is not configured.</p>`
    }
  </div>

  <div class="form-actions">
    <button type="submit" class="btn btn-primary btn-md">Create Trusted List</button>
  </div>
</form>`;
}
