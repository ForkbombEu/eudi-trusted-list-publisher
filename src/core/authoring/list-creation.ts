import { createPrivateKey } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { stringify as stringifyYaml } from "yaml";
import { compileForProfile } from "../compile/compile.js";
import { validateEtsiStruct } from "../validate/validate.js";
import { sign as signLote } from "../signing/signing.js";
import { verify } from "../verification/verification.js";
import { publish } from "../publication/manifest.js";
import type { PublicationStore } from "../publication/store.js";
import {
  getEnabledProfile,
  type EnabledProfileFamily,
} from "../profiles/registry.js";
import { MAX_NEXT_UPDATE_MONTHS } from "../profiles/wallet-provider/constants.js";
import { certificateDerBase64, toUtcDateTime } from "../model/lexical.js";
import type { AuthoringInput } from "../model/authoring.js";
import {
  loadSigningConfig,
  type SigningConfig,
  type SigningConfigEntry,
} from "./signing-config.js";
import {
  InspectorClient,
  type InspectorEvaluation,
} from "../inspector/inspector.js";

/**
 * Creation of a Trusted List: the operator declares the list, and the publisher
 * immediately produces its first, empty version so the list is visible in the
 * Catalogue and can be assessed before any entity applies to it.
 */

/**
 * A deliberately broken list is a separate deliverable. Each defect is named
 * here so the administration form can offer them, and so the API can refuse
 * them with a message that says which one is not implemented rather than
 * silently producing a healthy list.
 */
export const LIST_DEFECTS: ReadonlyArray<{
  readonly id: string;
  readonly label: string;
  readonly description: string;
}> = Object.freeze([
  {
    id: "non_strict_timestamps",
    label: "Non-strict timestamps",
    description:
      "Emit ListIssueDateTime and NextUpdate with fractional seconds, violating the clause 6.1.3 lexical form.",
  },
  {
    id: "scheme_name_without_territory",
    label: "Scheme name without territory",
    description:
      "Emit SchemeName without the SchemeTerritory prefix required by clause 6.3.6.",
  },
  {
    id: "missing_scheme_information_uri",
    label: "Missing scheme information URI",
    description:
      "Omit SchemeInformationURI, which the Table 1 presence matrix makes mandatory for explicit scheme information.",
  },
  {
    id: "missing_policy_or_legal_notice",
    label: "Missing policy or legal notice",
    description: "Omit PolicyOrLegalNotice.",
  },
  {
    id: "missing_operator_email",
    label: "Operator without email",
    description:
      "Publish only a website URI for the scheme operator, with no mailto URI.",
  },
  {
    id: "missing_self_pointer",
    label: "Missing self pointer",
    description:
      "Omit PointersToOtherLoTE, so the list does not point at itself.",
  },
  {
    id: "pem_service_certificate",
    label: "PEM service certificate",
    description:
      "Publish the service certificate as PEM text instead of the Base64 DER required by clause 6.6.3.",
  },
  {
    id: "extension_without_criticality",
    label: "Extension without criticality",
    description:
      "Emit ServiceInformationExtensions containers with no criticality flag.",
  },
  {
    id: "signer_organisation_mismatch",
    label: "Signer organisation mismatch",
    description:
      "Sign with a certificate whose subject organisation is not the scheme operator name.",
  },
  {
    id: "jades_without_signing_time",
    label: "JAdES without signing time",
    description:
      "Omit the iat protected header, so the signature is not JAdES Baseline B.",
  },
]);

export function isKnownDefect(id: string): boolean {
  return LIST_DEFECTS.some((defect) => defect.id === id);
}

export interface CreateListRequest {
  family: EnabledProfileFamily;
  /** Name of the Trusted List, e.g. "EU Wallet Providers List". */
  schemeName: string;
  schemeOperatorName: string;
  schemeTerritory: string;
  schemeOperatorStreet: string;
  schemeOperatorCountry: string;
  schemeOperatorEmail: string;
  /**
   * Public base URL of the list. The website, scheme information, policy and
   * distribution URIs are derived from it so the operator supplies one value
   * instead of six.
   */
  baseUrl: string;
  keyFile: string;
  certFile: string;
  /** Empty for a healthy list. */
  defects: string[];
}

export interface CreateListSuccess {
  success: true;
  listKey: string;
  entry: SigningConfigEntry;
  sequenceNumber: number;
  inspector: InspectorEvaluation;
}
export type CreateListResult =
  CreateListSuccess | { success: false; error: string };

/**
 * The publication list key is derived from the territory and the scheme
 * operator name — the same derivation the manifest uses. Two lists cannot share
 * one operator name within a territory, so the creation flow computes the key
 * up front and refuses a collision instead of discovering it at publish time.
 */
export function deriveListKeyFromParts(
  schemeTerritory: string,
  schemeOperatorName: string,
): string {
  const operator = schemeOperatorName
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, 40);
  return `${schemeTerritory}_${operator}`.toLowerCase();
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/** Derives the six scheme URIs from the operator's single base URL. */
export function schemeUrisFor(baseUrl: string): {
  website: string;
  schemeInformationUris: string[];
  policyUri: string;
  distributionPointUri: string;
} {
  const base = trimTrailingSlash(baseUrl);
  return {
    website: base,
    schemeInformationUris: [`${base}/scheme`, `${base}/practice-statement`],
    policyUri: `${base}/policy`,
    distributionPointUri: `${base}/latest`,
  };
}

export interface ListCreationDeps {
  publicationStore: PublicationStore;
  signingConfigPath: string;
  inspectorClient?: InspectorClient | null;
  now?: () => Date;
}

function validateRequest(request: CreateListRequest): string | null {
  try {
    getEnabledProfile(request.family);
  } catch {
    return `Trusted List creation is not available for family '${request.family}'.`;
  }
  for (const [field, value] of [
    ["schemeName", request.schemeName],
    ["schemeOperatorName", request.schemeOperatorName],
    ["schemeTerritory", request.schemeTerritory],
    ["schemeOperatorStreet", request.schemeOperatorStreet],
    ["schemeOperatorCountry", request.schemeOperatorCountry],
    ["schemeOperatorEmail", request.schemeOperatorEmail],
    ["baseUrl", request.baseUrl],
    ["keyFile", request.keyFile],
    ["certFile", request.certFile],
  ] as const) {
    if (!value.trim()) return `${field} is required.`;
  }
  if (!/^[A-Z]{2}$/.test(request.schemeOperatorCountry))
    return "schemeOperatorCountry must be a 2-letter ISO code.";
  if (!/^[A-Z]{2}$/.test(request.schemeTerritory))
    return "schemeTerritory must be a 2-letter code, e.g. EU.";
  try {
    const parsed = new URL(request.baseUrl);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
      return "baseUrl must be an HTTP(S) URL.";
  } catch {
    return "baseUrl must be a valid URL.";
  }
  if (!/^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(request.schemeOperatorEmail))
    return "schemeOperatorEmail must be a valid email address.";
  const unknown = request.defects.filter((defect) => !isKnownDefect(defect));
  if (unknown.length > 0)
    return `Unknown defect${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}.`;
  if (request.defects.length > 0)
    return (
      "Broken Trusted List generation is not implemented yet. Create the list " +
      "without defects, or wait for the broken-profile generator."
    );
  if (!existsSync(request.keyFile))
    return `Signing key file not found: ${request.keyFile}`;
  if (!existsSync(request.certFile))
    return `Signing certificate file not found: ${request.certFile}`;
  return null;
}

/** Rewrites the signing configuration file with one more list. */
function appendSigningConfigEntry(
  path: string,
  entry: SigningConfigEntry,
): void {
  const existing: SigningConfig = existsSync(path)
    ? loadSigningConfig(path)
    : { lists: [] };
  const lists = [...existing.lists, entry];
  const serialized =
    path.endsWith(".yaml") || path.endsWith(".yml")
      ? stringifyYaml({ lists })
      : `${JSON.stringify({ lists }, null, 2)}\n`;
  const tmpPath = `${path}.tmp_${randomBytes(6).toString("hex")}`;
  writeFileSync(tmpPath, serialized, { encoding: "utf-8" });
  renameSync(tmpPath, path);
}

/**
 * Creates the list, publishes its first empty version and assesses it. The
 * signing configuration is only updated once the version is stored, so a failed
 * creation does not leave a list that cannot publish.
 */
export async function createTrustedList(
  request: CreateListRequest,
  deps: ListCreationDeps,
): Promise<CreateListResult> {
  const invalid = validateRequest(request);
  if (invalid) return { success: false, error: invalid };

  const listKey = deriveListKeyFromParts(
    request.schemeTerritory,
    request.schemeOperatorName,
  );
  const config = existsSync(deps.signingConfigPath)
    ? loadSigningConfig(deps.signingConfigPath)
    : { lists: [] };
  if (config.lists.some((candidate) => candidate.listKey === listKey))
    return {
      success: false,
      error: `A Trusted List with key "${listKey}" already exists. Scheme operator names must be unique within a territory.`,
    };
  if (deps.publicationStore.getHighestStoredSequence(listKey) !== null)
    return {
      success: false,
      error: `Publications already exist for list key "${listKey}".`,
    };

  const uris = schemeUrisFor(request.baseUrl);
  const entry: SigningConfigEntry = {
    listKey,
    family: request.family,
    schemeOperatorName: request.schemeOperatorName,
    schemeOperatorStreet: request.schemeOperatorStreet,
    schemeOperatorCountry: request.schemeOperatorCountry,
    schemeName: request.schemeName,
    schemeTerritory: request.schemeTerritory,
    schemeOperatorContactUri: uris.website,
    distributionPointUri: uris.distributionPointUri,
    keyFile: request.keyFile,
    certFile: request.certFile,
    schemeOperatorEmail: request.schemeOperatorEmail,
    schemeOperatorWebsite: uris.website,
    schemeInformationUris: uris.schemeInformationUris,
    policyUri: uris.policyUri,
  };

  const now = (deps.now ?? (() => new Date()))();
  /*
    Annex D/E cap NextUpdate at six months after the issue time. The arithmetic
    is done in UTC: setMonth() works in local time, so crossing a daylight-saving
    boundary would push the value an hour past the maximum and make the list
    non-conformant.
  */
  const nextUpdate = new Date(now);
  nextUpdate.setUTCMonth(nextUpdate.getUTCMonth() + MAX_NEXT_UPDATE_MONTHS);

  let certPem: string;
  let keyPem: string;
  try {
    certPem = readFileSync(entry.certFile, "utf-8");
    keyPem = readFileSync(entry.keyFile, "utf-8");
  } catch (error) {
    return {
      success: false,
      error: `Signing material could not be read: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    };
  }

  /*
    The first version carries no entities. TrustedEntitiesList is optional, so an
    empty list is a valid, signable, assessable LoTE — which is what makes the
    new list inspectable before anyone applies to it.
  */
  const input: AuthoringInput = {
    schemeOperator: {
      name: [{ lang: "en", value: entry.schemeOperatorName }],
      postalAddress: [
        {
          lang: "en",
          StreetAddress: entry.schemeOperatorStreet,
          Country: entry.schemeOperatorCountry,
        },
      ],
      electronicAddress: [
        { lang: "en", uriValue: `mailto:${entry.schemeOperatorEmail}` },
        { lang: "en", uriValue: entry.schemeOperatorWebsite },
      ],
    },
    scheme: {
      schemeName: [{ lang: "en", value: entry.schemeName }],
      schemeTerritory: entry.schemeTerritory,
      schemeInformationURI: entry.schemeInformationUris.map((uriValue) => ({
        lang: "en",
        uriValue,
      })),
      distributionPoints: [entry.distributionPointUri],
      policyUri: entry.policyUri,
      selfPointerCertificates: [certificateDerBase64(certPem)],
    },
    listIssueDateTime: toUtcDateTime(now),
    nextUpdate: toUtcDateTime(nextUpdate),
    loTESequenceNumber: 1,
    entities: [],
  };

  try {
    const compiled = compileForProfile(request.family, input);
    const etsi = await validateEtsiStruct(compiled.document);
    if (!etsi.valid)
      return {
        success: false,
        error: `ETSI validation failed: ${etsi.findings
          .map((finding) => `${finding.path}: ${finding.message}`)
          .join("; ")}`,
      };
    const privateKey = createPrivateKey(keyPem);
    const signingKey = await crypto.subtle.importKey(
      "jwk",
      privateKey.export({ format: "jwk" }),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    );
    const signed = await signLote({
      document: compiled.document,
      key: signingKey,
      certificatePem: certPem,
      signingTime: now,
    });
    const verified = await verify({
      compactJws: signed.compact,
      certificatePem: certPem,
    });
    if (!verified.valid)
      return { success: false, error: "Post-sign verification failed." };
    const published = await publish({
      compactJws: signed.compact,
      certificatePem: certPem,
    });
    if (published.listKey !== listKey)
      return {
        success: false,
        error: `Derived list key "${published.listKey}" does not match "${listKey}".`,
      };
    await deps.publicationStore.store(
      published,
      signed.compact,
      published.loteJson,
      JSON.stringify(published.manifest, null, 2),
    );
    const client = deps.inspectorClient ?? new InspectorClient();
    const inspector = await client.assess({
      compactJades: signed.compact,
      source: `${listKey}/versions/1/lote.jades`,
      declared: {
        mimeType: "application/jose",
        loteType: compiled.document.LoTE.ListAndSchemeInformation.LoTEType,
        schemeOperatorName: entry.schemeOperatorName,
        schemeTerritory: entry.schemeTerritory,
      },
    });
    try {
      deps.publicationStore.writeInspectorEvaluation(
        listKey,
        1,
        JSON.stringify(inspector, null, 2),
      );
    } catch {
      /* evidence only; the published version is already committed */
    }
    appendSigningConfigEntry(deps.signingConfigPath, entry);
    return {
      success: true,
      listKey,
      entry,
      sequenceNumber: 1,
      inspector,
    };
  } catch (error) {
    return {
      success: false,
      error: `Trusted List creation failed: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    };
  }
}
