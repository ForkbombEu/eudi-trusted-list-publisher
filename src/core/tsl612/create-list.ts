/**
 * Declaring a TS 119 612 Trusted List and publishing its first, empty version.
 *
 * The order matters: the empty version 1 is compiled, signed, schema-validated,
 * verified and stored *before* the list is appended to the signing
 * configuration. A creation that fails therefore never leaves behind a list
 * that appears on the onboarding forms but cannot publish.
 */
import { X509Certificate } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { deriveListKeyFromParts } from "../authoring/list-creation.js";
import { writeSigningConfigWithEntry } from "../authoring/list-creation.js";
import { loadSigningConfig } from "../authoring/signing-config.js";
import { checkTrustedListSigningCertificate } from "./signing-certificate.js";
import { evaluatePublishedTrustedList, publishTrustedList } from "./publish.js";
import {
  defaultLotlPointer,
  type TrustedListConfigEntry,
} from "./list-config.js";
import {
  FIXTURE_PROVIDER_NAME,
  fixtureSeedProvider,
  isKnownXmlDefect,
} from "./defects.js";
import {
  buildFixtureMetadata,
  type FixtureMetadata,
} from "../defects/fixture-metadata.js";
import { SAFE_KEY_RE } from "../publication/store.js";
import { isTslFamily, type TslFamily } from "./registry.js";
import { MAX_NEXT_UPDATE_MONTHS, TSL_MEDIA_TYPE } from "./constants.js";
import {
  toUtcDateTime,
  EU_MEMBER_STATE_CODES,
  schemeNameWithTerritory,
} from "../model/lexical.js";
import type { TrustedListStore } from "../publication/tsl-store.js";
import type {
  InspectorClient,
  InspectorEvaluation,
} from "../inspector/inspector.js";
import type { TrustedListInput } from "./model.js";

export interface CreateTrustedListRequest {
  readonly schemeOperatorName: string;
  /** The responsible Member State. Never `EU`. */
  readonly schemeTerritory: string;
  readonly schemeName: string;
  readonly schemeOperatorStreet: string;
  readonly schemeOperatorLocality: string;
  readonly schemeOperatorPostalCode?: string;
  readonly schemeOperatorCountry: string;
  readonly schemeOperatorEmail: string;
  readonly schemeOperatorWebsite: string;
  readonly schemeOperatorTelephone?: string;
  readonly schemeInformationUri: string;
  readonly nationalSchemeRulesUri: string;
  readonly policyUri: string;
  /**
   * The stable URL the signed XML is published at. When absent or blank,
   * `publicBaseUrl` is combined with the list's stable latest route.
   */
  readonly distributionPointUri?: string;
  /** Base64 DER of the EU LOTL signing certificates. */
  readonly lotlCertificatesBase64Der: readonly string[];
  readonly lotlSchemeOperatorNames: readonly string[];
  readonly keyFile: string;
  readonly certFile: string;
  /** Which onboarding families the list accepts. At least one. */
  readonly allowedServiceProfiles: readonly string[];
  /**
   * Deliberate defects. Empty for a healthy list. Every entry must be a defect
   * the canonical catalogue binds to TS 119 612; an unknown one is refused by
   * name rather than silently producing a healthy list.
   */
  readonly defects?: readonly string[];
  /**
   * Seed the list with one deterministic provider so the service-level defects
   * have something to mutate.
   *
   * A broken list always seeds. A healthy list normally does not — an empty
   * first version is what lets a real list be assessed before anyone applies to
   * it — but the fixture suite's healthy *baseline* sets this, so that every
   * single-defect fixture is a delta of exactly one mutation from it.
   */
  readonly seedFixtureProvider?: boolean;
  /**
   * The publication key, overriding the derivation from territory and operator
   * name. Only the deterministic fixture generator sets it, so a fixture can be
   * published at `eaa-broken-<defect-id>` and cited by that name.
   */
  readonly listKey?: string;
}

export interface CreateTrustedListDeps {
  readonly store: TrustedListStore;
  readonly signingConfigPath: string;
  readonly inspectorClient?: InspectorClient | null;
  readonly publicBaseUrl?: string;
  readonly now?: () => Date;
}

export type CreateTrustedListResult =
  | {
      readonly success: true;
      readonly listKey: string;
      readonly entry: TrustedListConfigEntry;
      readonly sequenceNumber: number;
      readonly inspector?: InspectorEvaluation;
      /** Present only for an intentionally broken list. */
      readonly fixture?: FixtureMetadata;
    }
  | { readonly success: false; readonly error: string };

type ResolvedCreateTrustedListRequest = Omit<
  CreateTrustedListRequest,
  "distributionPointUri"
> & {
  readonly distributionPointUri: string;
};

function validate(request: ResolvedCreateTrustedListRequest): string | null {
  const required: ReadonlyArray<readonly [string, string]> = [
    ["schemeOperatorName", request.schemeOperatorName],
    ["schemeTerritory", request.schemeTerritory],
    ["schemeName", request.schemeName],
    ["schemeOperatorStreet", request.schemeOperatorStreet],
    ["schemeOperatorLocality", request.schemeOperatorLocality],
    ["schemeOperatorCountry", request.schemeOperatorCountry],
    ["schemeOperatorEmail", request.schemeOperatorEmail],
    ["schemeOperatorWebsite", request.schemeOperatorWebsite],
    ["schemeInformationUri", request.schemeInformationUri],
    ["nationalSchemeRulesUri", request.nationalSchemeRulesUri],
    ["policyUri", request.policyUri],
    ["distributionPointUri", request.distributionPointUri],
    ["keyFile", request.keyFile],
    ["certFile", request.certFile],
  ];
  for (const [field, value] of required) {
    if (!value || value.trim() === "") return `${field} is required.`;
  }
  if (!/^[A-Z]{2}$/.test(request.schemeTerritory))
    return "schemeTerritory must be a 2-letter ISO 3166-1 alpha-2 code.";
  if (!EU_MEMBER_STATE_CODES.includes(request.schemeTerritory))
    return `schemeTerritory must be an EU Member State; '${request.schemeTerritory}' is not one. A TS 119 612 Member State list is not published for the Union as a whole.`;
  if (!/^[A-Z]{2}$/.test(request.schemeOperatorCountry))
    return "schemeOperatorCountry must be a 2-letter ISO code.";
  if (request.allowedServiceProfiles.length === 0)
    return "Choose at least one service profile the list accepts: EAA Providers, QEAA Providers, or both.";
  for (const profile of request.allowedServiceProfiles) {
    if (!isTslFamily(profile))
      return `'${profile}' is not a TS 119 612 service profile.`;
  }
  if (request.lotlCertificatesBase64Der.length === 0)
    return "The pointer to the EU LOTL must carry at least one signing certificate.";
  if (request.lotlSchemeOperatorNames.length === 0)
    return "The pointer to the EU LOTL must name the scheme operator of the pointed-to list.";
  for (const value of request.lotlCertificatesBase64Der) {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value))
      return "Each LOTL pointer certificate must be strict Base64 DER, with no PEM armour and no whitespace.";
  }
  for (const [field, value] of [
    ["schemeOperatorWebsite", request.schemeOperatorWebsite],
    ["schemeInformationUri", request.schemeInformationUri],
    ["nationalSchemeRulesUri", request.nationalSchemeRulesUri],
    ["policyUri", request.policyUri],
    ["distributionPointUri", request.distributionPointUri],
  ] as const) {
    if (!/^https?:\/\//i.test(value)) return `${field} must be an HTTP(S) URL.`;
  }
  const unknown = (request.defects ?? []).filter(
    (defect) => !isKnownXmlDefect(defect),
  );
  if (unknown.length > 0)
    return `Unknown TS 119 612 defect${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}.`;
  if (request.listKey !== undefined && !SAFE_KEY_RE.test(request.listKey))
    return `'${request.listKey}' is not a usable list key.`;
  return null;
}

export async function createTrustedListList(
  submitted: CreateTrustedListRequest,
  deps: CreateTrustedListDeps,
): Promise<CreateTrustedListResult> {
  if (submitted.schemeName.trim() === "")
    return { success: false, error: "schemeName is required." };
  const listKey =
    submitted.listKey ??
    deriveListKeyFromParts(
      submitted.schemeTerritory,
      submitted.schemeOperatorName,
    );
  let distributionPointUri = submitted.distributionPointUri?.trim() ?? "";
  if (!distributionPointUri && deps.publicBaseUrl?.trim()) {
    try {
      distributionPointUri = new URL(
        `/lists/${encodeURIComponent(listKey)}/latest/trusted-list.xml`,
        deps.publicBaseUrl,
      ).toString();
    } catch {
      return {
        success: false,
        error:
          "distributionPointUri could not be derived because publicBaseUrl is not a valid URL.",
      };
    }
  }
  const request: ResolvedCreateTrustedListRequest = {
    ...submitted,
    schemeName: schemeNameWithTerritory(
      submitted.schemeName.trim(),
      submitted.schemeTerritory,
    ),
    distributionPointUri,
  };
  const invalid = validate(request);
  if (invalid) return { success: false, error: invalid };

  const defects = request.defects ?? [];
  const broken = defects.length > 0;

  /* One list key names one list, across both standards. */
  if (existsSync(deps.signingConfigPath)) {
    const config = loadSigningConfig(deps.signingConfigPath);
    const clash = [...config.lists, ...(config.trustedLists ?? [])].some(
      (entry) => entry.listKey === listKey,
    );
    if (clash)
      return {
        success: false,
        error: `A Trusted List with the key '${listKey}' already exists. Choose a different scheme operator name or territory.`,
      };
  }
  if (deps.store.getHighestStoredSequence(listKey) !== null)
    return {
      success: false,
      error: `The publication store already holds versions for '${listKey}'.`,
    };

  let privateKeyPem: string;
  let certificatePem: string;
  try {
    privateKeyPem = readFileSync(request.keyFile, "utf-8");
    certificatePem = readFileSync(request.certFile, "utf-8");
  } catch (error) {
    return {
      success: false,
      error: `The signing material could not be read: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  /* The certificate profile is checked here as well as at signing time, so a
     list is never declared with material that cannot sign it. */
  let findings: string[];
  try {
    findings = checkTrustedListSigningCertificate(
      new X509Certificate(certificatePem),
      {
        schemeTerritory: request.schemeTerritory,
        schemeOperatorName: request.schemeOperatorName,
      },
    );
  } catch (error) {
    return {
      success: false,
      error: `The signing certificate does not parse: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  /*
    A broken fixture may deliberately sign with material that fails the profile,
    so the profile is recorded rather than enforced. It is still enforced for
    every ordinary list: material that could never sign a healthy list must not
    be usable to declare one.
  */
  if (findings.length > 0 && !broken)
    return { success: false, error: findings.join(" ") };

  const entry: TrustedListConfigEntry = {
    standard: "TS 119 612",
    listKey,
    schemeOperatorName: request.schemeOperatorName,
    schemeOperatorStreet: request.schemeOperatorStreet,
    schemeOperatorLocality: request.schemeOperatorLocality,
    ...(request.schemeOperatorPostalCode
      ? { schemeOperatorPostalCode: request.schemeOperatorPostalCode }
      : {}),
    schemeOperatorCountry: request.schemeOperatorCountry,
    schemeOperatorEmail: request.schemeOperatorEmail,
    schemeOperatorWebsite: request.schemeOperatorWebsite,
    ...(request.schemeOperatorTelephone
      ? { schemeOperatorTelephone: request.schemeOperatorTelephone }
      : {}),
    schemeName: request.schemeName,
    schemeTerritory: request.schemeTerritory,
    schemeInformationUri: request.schemeInformationUri,
    nationalSchemeRulesUri: request.nationalSchemeRulesUri,
    policyUri: request.policyUri,
    distributionPointUri: request.distributionPointUri,
    lotlPointer: defaultLotlPointer(
      request.lotlCertificatesBase64Der,
      request.lotlSchemeOperatorNames,
    ),
    keyFile: request.keyFile,
    certFile: request.certFile,
    allowedServiceProfiles: request.allowedServiceProfiles as TslFamily[],
  };

  const issue = deps.now ? deps.now() : new Date();
  const nextUpdate = new Date(issue);
  nextUpdate.setUTCMonth(nextUpdate.getUTCMonth() + MAX_NEXT_UPDATE_MONTHS);

  const family = entry.allowedServiceProfiles[0]!;
  /*
    An ordinary first version is empty: no TrustServiceProviderList at all,
    which is what lets a new list be assessed before anyone applies to it. A
    fixture list seeds one deterministic provider instead, because the
    service-level defects have nothing to mutate otherwise.
  */
  const seedProvider = broken || request.seedFixtureProvider === true;
  const input: TrustedListInput = {
    ...(seedProvider
      ? {
          providers: entry.allowedServiceProfiles.map((profileFamily) =>
            fixtureSeedProvider({
              family: profileFamily,
              ...(entry.allowedServiceProfiles.length > 1
                ? {
                    providerName: `${FIXTURE_PROVIDER_NAME} (${profileFamily})`,
                  }
                : {}),
              territory: entry.schemeTerritory,
              fallbackCertificatePem: certificatePem,
              publishedAt: issue,
            }),
          ),
        }
      : {}),
    schemeInformation: {
      sequenceNumber: 1,
      schemeTerritory: entry.schemeTerritory,
      schemeOperatorName: entry.schemeOperatorName,
      schemeOperatorAddress: {
        streetAddress: entry.schemeOperatorStreet,
        locality: entry.schemeOperatorLocality,
        ...(entry.schemeOperatorPostalCode
          ? { postalCode: entry.schemeOperatorPostalCode }
          : {}),
        countryName: entry.schemeOperatorCountry,
      },
      schemeOperatorElectronicAddress: {
        email: entry.schemeOperatorEmail,
        website: entry.schemeOperatorWebsite,
        ...(entry.schemeOperatorTelephone
          ? { telephone: entry.schemeOperatorTelephone }
          : {}),
      },
      schemeName: entry.schemeName,
      schemeInformationUri: entry.schemeInformationUri,
      nationalSchemeRulesUri: entry.nationalSchemeRulesUri,
      policyOrLegalNoticeUri: entry.policyUri,
      distributionPointUri: entry.distributionPointUri,
      listIssueDateTime: toUtcDateTime(issue),
      nextUpdate: toUtcDateTime(nextUpdate),
      lotlPointer: entry.lotlPointer,
    },
  };

  let published;
  try {
    published = publishTrustedList({
      store: deps.store,
      listKey,
      family,
      input,
      privateKeyPem,
      certificatePem,
      publishedAt: issue,
      signingTime: issue,
      allowedServiceProfiles: entry.allowedServiceProfiles,
      ...(broken
        ? {
            fixture: {
              defectIds: defects,
              context: {
                families: entry.allowedServiceProfiles,
                schemeTerritory: entry.schemeTerritory,
                schemeOperatorName: entry.schemeOperatorName,
              },
            },
          }
        : {}),
    });
  } catch (error) {
    return {
      success: false,
      error: `The first version could not be published: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  /* Only now is the list declared: the version it will publish onto exists. */
  try {
    writeSigningConfigWithEntry(deps.signingConfigPath, entry);
  } catch (error) {
    return {
      success: false,
      error: `Version 1 of '${listKey}' is published and authentic, but the signing configuration could not be updated: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  let inspector: InspectorEvaluation | undefined;
  if (deps.inspectorClient) {
    inspector = await evaluatePublishedTrustedList(
      deps.store,
      deps.inspectorClient,
      published,
      `${deps.publicBaseUrl ?? ""}/lists/${listKey}/versions/1`,
    );
  }

  /*
    A broken publication is not finished until it has said what it expected and
    what actually happened. The Inspector may be unavailable, in which case the
    actual Inspector failures are empty and every expectation is recorded as
    missing — which is the honest reading, and never a pass.
  */
  let fixture: FixtureMetadata | undefined;
  if (published.fixture) {
    fixture = buildFixtureMetadata({
      standard: "TS 119 612",
      artifactFormat: "XML / XAdES-B-B",
      selectedDefects: defects,
      mutations: published.fixture.mutations,
      actualLocalFailures: published.fixture.localFailures,
      actualInspectorFailures:
        inspector?.summary.locallyDecidableFailures ?? [],
      generatedAt: issue,
    });
    try {
      deps.store.writeFixtureMetadata(
        listKey,
        published.sequenceNumber,
        `${JSON.stringify(fixture, null, 2)}\n`,
      );
    } catch {
      /* evidence only; the published version is already committed */
    }
  }

  return {
    success: true,
    listKey,
    entry,
    sequenceNumber: published.sequenceNumber,
    ...(inspector ? { inspector } : {}),
    ...(fixture ? { fixture } : {}),
  };
}

/** The media type an XML Trusted List is served under. */
export const TRUSTED_LIST_MEDIA_TYPE = TSL_MEDIA_TYPE;
