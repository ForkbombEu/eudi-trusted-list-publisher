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
import { isTslFamily, type TslFamily } from "./registry.js";
import { MAX_NEXT_UPDATE_MONTHS, TSL_MEDIA_TYPE } from "./constants.js";
import { toUtcDateTime, EU_MEMBER_STATE_CODES } from "../model/lexical.js";
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
  /** The stable URL the signed XML is published at. */
  readonly distributionPointUri: string;
  /** Base64 DER of the EU LOTL signing certificates. */
  readonly lotlCertificatesBase64Der: readonly string[];
  readonly lotlSchemeOperatorNames: readonly string[];
  readonly keyFile: string;
  readonly certFile: string;
  /** Which onboarding families the list accepts. At least one. */
  readonly allowedServiceProfiles: readonly string[];
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
    }
  | { readonly success: false; readonly error: string };

function validate(request: CreateTrustedListRequest): string | null {
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
  return null;
}

export async function createTrustedListList(
  request: CreateTrustedListRequest,
  deps: CreateTrustedListDeps,
): Promise<CreateTrustedListResult> {
  const invalid = validate(request);
  if (invalid) return { success: false, error: invalid };

  const listKey = deriveListKeyFromParts(
    request.schemeTerritory,
    request.schemeOperatorName,
  );

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
  if (findings.length > 0) return { success: false, error: findings.join(" ") };

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

  /* An empty first version: no TrustServiceProviderList at all. */
  const input: TrustedListInput = {
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
      family: entry.allowedServiceProfiles[0]!,
      input,
      privateKeyPem,
      certificatePem,
      publishedAt: issue,
      signingTime: issue,
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

  return {
    success: true,
    listKey,
    entry,
    sequenceNumber: published.sequenceNumber,
    ...(inspector ? { inspector } : {}),
  };
}

/** The media type an XML Trusted List is served under. */
export const TRUSTED_LIST_MEDIA_TYPE = TSL_MEDIA_TYPE;
