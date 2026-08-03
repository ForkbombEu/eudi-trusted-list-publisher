/**
 * Validates an EAA or QEAA onboarding submission.
 *
 * Every rule here is enforced in the core, not in the HTML. A form is a
 * convenience; the record that reaches the store has to be defensible whether
 * it arrived from a browser, from a script, or from a replayed request.
 *
 * The rules that matter, and why each exists:
 *
 * - the target list must exist and must allow this onboarding family, because
 *   `allowedServiceProfiles` is what makes a list an EAA list, a QEAA list or
 *   both;
 * - the Scheme Territory comes from the target list, never from the applicant,
 *   so there is no second country value to disagree with the first;
 * - the certificate must parse, and if its subject `O` differs from `TSPName`
 *   the applicant must supply that value as a trade name *and* a Scheme Service
 *   Definition URI documenting the relationship. The live Trust Inspector
 *   fails `ts119612.service.1.1.certificate_subject_tsp_name` without it.
 */
import { X509Certificate } from "node:crypto";
import { getTslProfile, type TslFamily } from "../registry.js";
import {
  allowsServiceProfile,
  type TrustedListConfigEntry,
} from "../list-config.js";
import {
  classifyCertificateInput,
  CERTIFICATE_INPUT_MESSAGES,
} from "../../authoring/certificate-input.js";
import type {
  TslApplicantAddress,
  TslApplicationRecord,
} from "./application-model.js";
import { TSL_APPLICATION_SCHEMA_VERSION } from "./application-model.js";

export interface FieldError {
  readonly field: string;
  readonly message: string;
}

export type ParseResult =
  | { readonly ok: true; readonly value: Omit<TslApplicationRecord, "id"> }
  | { readonly ok: false; readonly errors: readonly FieldError[] };

/** Every field the two onboarding forms post. Anything else is rejected. */
const ALLOWED_FIELDS: readonly string[] = Object.freeze([
  "listKey",
  "tspName",
  "registrationIdentifier",
  "registrationIdentifierKind",
  "tradeName",
  "streetAddress",
  "locality",
  "postalCode",
  "stateOrProvince",
  "countryName",
  "email",
  "website",
  "telephone",
  "tspInformationUri",
  "serviceName",
  "certificatePem",
  "schemeServiceDefinitionUri",
  "tspServiceDefinitionUri",
  "serviceSupplyPoints",
  "evidence",
]);

const MAX_TEXT = 4000;

function text(body: Record<string, string>, field: string): string {
  return (body[field] ?? "").trim();
}

function httpUri(value: string): boolean {
  return /^https?:\/\/[^\s]+$/i.test(value);
}

function rdn(subject: string, key: string): string | null {
  for (const line of subject.split("\n")) {
    const at = line.indexOf("=");
    if (at === -1) continue;
    if (line.slice(0, at).trim() === key) return line.slice(at + 1).trim();
  }
  return null;
}

export interface ParseContext {
  readonly family: TslFamily;
  /** Every XML Trusted List the deployment has configured. */
  readonly trustedLists: readonly TrustedListConfigEntry[];
  readonly submittedAt: string;
}

export function parseTslSubmission(
  body: Record<string, string>,
  context: ParseContext,
): ParseResult {
  const errors: FieldError[] = [];
  const add = (field: string, message: string): void => {
    errors.push({ field, message });
  };

  for (const key of Object.keys(body)) {
    if (!ALLOWED_FIELDS.includes(key))
      add(key, `'${key}' is not a field of this application.`);
  }

  /* The family decides the service type and the status vocabulary. Refusing an
     unknown family here keeps a crafted request from selecting neither. */
  const profile = getTslProfile(context.family);

  const listKey = text(body, "listKey");
  const config = context.trustedLists.find(
    (entry) => entry.listKey === listKey,
  );
  if (!listKey) {
    add("listKey", "Choose the Trusted List this application is for.");
  } else if (!config) {
    add(
      "listKey",
      `No XML Trusted List is configured with the key '${listKey}'.`,
    );
  } else if (!allowsServiceProfile(config, context.family)) {
    add(
      "listKey",
      `The Trusted List '${listKey}' does not accept ${profile.label}. It accepts: ${config.allowedServiceProfiles.join(", ")}.`,
    );
  }

  const tspName = text(body, "tspName");
  if (!tspName) add("tspName", "The TSP legal name is required.");
  if (tspName.length > 256)
    add("tspName", "The TSP legal name must be at most 256 characters.");

  const registrationIdentifier = text(body, "registrationIdentifier");
  if (!registrationIdentifier)
    add(
      "registrationIdentifier",
      "The official registration identifier is required; it is published as the TSP trade name.",
    );
  const kindRaw = text(body, "registrationIdentifierKind") || "national";
  if (kindRaw !== "vat" && kindRaw !== "national")
    add(
      "registrationIdentifierKind",
      "Choose whether the identifier is a VAT identifier or a national register identifier.",
    );

  const address: TslApplicantAddress = {
    streetAddress: text(body, "streetAddress"),
    locality: text(body, "locality"),
    countryName: text(body, "countryName"),
  };
  if (!address.streetAddress)
    add("streetAddress", "The street address is required.");
  if (!address.locality) add("locality", "The locality is required.");
  if (!address.countryName) add("countryName", "The country is required.");

  const email = text(body, "email");
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
    add("email", "A contact email address is required.");

  const website = text(body, "website");
  if (!website || !httpUri(website))
    add("website", "A website URL beginning http:// or https:// is required.");

  const telephone = text(body, "telephone");

  const tspInformationUri = text(body, "tspInformationUri");
  if (!tspInformationUri || !httpUri(tspInformationUri))
    add(
      "tspInformationUri",
      "The TSP policies and practices URL is required and must begin http:// or https://.",
    );

  const serviceName = text(body, "serviceName");
  if (!serviceName) add("serviceName", "The service name is required.");

  const schemeServiceDefinitionUri = text(body, "schemeServiceDefinitionUri");
  if (schemeServiceDefinitionUri && !httpUri(schemeServiceDefinitionUri))
    add(
      "schemeServiceDefinitionUri",
      "The scheme service definition URL must begin http:// or https://.",
    );
  const tspServiceDefinitionUri = text(body, "tspServiceDefinitionUri");
  if (tspServiceDefinitionUri && !httpUri(tspServiceDefinitionUri))
    add(
      "tspServiceDefinitionUri",
      "The TSP service definition URL must begin http:// or https://.",
    );

  const supplyPoints = text(body, "serviceSupplyPoints")
    .split(/[\r\n]+/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  for (const point of supplyPoints) {
    if (!httpUri(point))
      add(
        "serviceSupplyPoints",
        `Service supply point '${point}' must be a URL beginning http:// or https://.`,
      );
  }

  const evidence = text(body, "evidence");
  if (!evidence)
    add(
      "evidence",
      context.family === "qeaa-providers"
        ? "Describe the evidence of qualified status. It is kept for administrator review and is never published."
        : "Describe the evidence of national recognition. It is kept for administrator review and is never published.",
    );
  if (evidence.length > MAX_TEXT)
    add("evidence", `The evidence must be at most ${MAX_TEXT} characters.`);

  /* The service certificate. */
  const certificatePem = (body["certificatePem"] ?? "").trim();
  const tradeName = text(body, "tradeName");
  let certificate: X509Certificate | null = null;
  if (!certificatePem) {
    add(
      "certificatePem",
      "The Service Digital Identity certificate is required; it identifies the public key that verifies the attestations this service issues.",
    );
  } else {
    const classified = classifyCertificateInput(certificatePem);
    if (classified.kind !== "certificate" || !classified.certificate) {
      add(
        "certificatePem",
        classified.message ?? CERTIFICATE_INPUT_MESSAGES.unknown,
      );
    } else {
      certificate = classified.certificate;
      const organisation = rdn(certificate.subject, "O");
      if (organisation !== null && tspName && organisation !== tspName) {
        /*
          Clause 5.4.2 and the Inspector's
          ts119612.service.1.1.certificate_subject_tsp_name: a subject O that
          differs from TSPName is allowed, but only when the list says who the
          certificate belongs to and how the two are related.
        */
        if (tradeName.trim() !== organisation)
          add(
            "tradeName",
            `The certificate subject organisation is "${organisation}" but the TSP legal name is "${tspName}". Supply "${organisation}" as the TSP trade name.`,
          );
        if (!schemeServiceDefinitionUri)
          add(
            "schemeServiceDefinitionUri",
            `A Scheme Service Definition URL is required because the certificate subject organisation ("${organisation}") differs from the TSP legal name. It must document the relationship between the two.`,
          );
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  if (!config || !certificate)
    return {
      ok: false,
      errors: [
        {
          field: "listKey",
          message: "The application could not be validated.",
        },
      ],
    };

  return {
    ok: true,
    value: {
      schemaVersion: TSL_APPLICATION_SCHEMA_VERSION,
      standard: "TS 119 612",
      family: context.family,
      state: "submitted",
      submittedAt: context.submittedAt,
      listKey: config.listKey,
      tspName,
      registrationIdentifier,
      registrationIdentifierKind: kindRaw as "vat" | "national",
      ...(tradeName ? { tradeName } : {}),
      address: {
        ...address,
        ...(text(body, "postalCode")
          ? { postalCode: text(body, "postalCode") }
          : {}),
        ...(text(body, "stateOrProvince")
          ? { stateOrProvince: text(body, "stateOrProvince") }
          : {}),
      },
      email,
      website,
      ...(telephone ? { telephone } : {}),
      tspInformationUri,
      serviceName,
      certificatePem,
      ...(schemeServiceDefinitionUri ? { schemeServiceDefinitionUri } : {}),
      ...(tspServiceDefinitionUri ? { tspServiceDefinitionUri } : {}),
      ...(supplyPoints.length > 0 ? { serviceSupplyPoints: supplyPoints } : {}),
      evidence,
    },
  };
}
