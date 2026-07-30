import { compileForProfile } from "../compile/compile.js";
import type {
  AuthoringEntity,
  AuthoringInput,
  AuthoringService,
} from "../model/authoring.js";
import type { LoTEDocument, TrustedEntity } from "../model/types.js";
import {
  loadVersionArtifacts,
  type PublicationStore,
} from "../publication/store.js";
import {
  getEnabledProfile,
  type EnabledProfileFamily,
} from "../profiles/registry.js";
import {
  normalizeToAuthoringInput,
  type SchemeDescriptor,
  type TrustedEntityApplication,
} from "./application-model.js";
import type { SigningConfigEntry } from "./signing-config.js";
import { certificateDerBase64 } from "../model/lexical.js";
import { readFileSync } from "node:fs";

const MAX_BYTES = 10 * 1024 * 1024;
type RecordValue = Record<string, unknown>;
export type LatestPublication =
  | { exists: false }
  | {
      exists: true;
      sequenceNumber: number;
      loteDocument: LoTEDocument;
      entities: AuthoringEntity[];
    };
export type PreservationResult = { ok: true } | { ok: false; path: string };
export type UniquenessResult = { ok: true } | { ok: false; duplicate: string };

const isRecord = (value: unknown): value is RecordValue =>
  typeof value === "object" && value !== null && !Array.isArray(value);
function isLoTEDocument(value: unknown): value is LoTEDocument {
  return (
    isRecord(value) &&
    isRecord(value.LoTE) &&
    isRecord(value.LoTE.ListAndSchemeInformation)
  );
}

function parseLoTEDocument(value: unknown): LoTEDocument {
  if (!isLoTEDocument(value))
    throw new Error(
      "Cannot parse latest publication LoTE JSON: required LoTE structure is missing.",
    );
  return value;
}

export async function loadLatestPublication(
  store: PublicationStore,
  listKey: string,
  family: EnabledProfileFamily = "wallet-providers",
): Promise<LatestPublication> {
  getEnabledProfile(family);
  const highest = store.getHighestStoredSequence(listKey);
  if (highest === null) return { exists: false };
  const outcome = await loadVersionArtifacts(
    store.publicationDir,
    listKey,
    highest,
    MAX_BYTES,
  );
  if (!outcome.artifacts)
    throw new Error(
      `Latest publication for "${listKey}" at sequence ${highest} is corrupt or unauthenticated: ${outcome.diagnostic}`,
    );
  let loteDocument: LoTEDocument;
  try {
    loteDocument = parseLoTEDocument(
      JSON.parse(outcome.artifacts.loteJsonBytes) as unknown,
    );
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("Cannot parse latest publication")
    )
      throw error;
    throw new Error(
      `Cannot parse latest publication LoTE JSON for "${listKey}" sequence ${highest}`,
    );
  }
  const entities = convertLoTEToAuthoringEntities(loteDocument);
  const preservation = checkLosslessPreservation(
    loteDocument.LoTE.TrustedEntitiesList ?? [],
    entities,
    family,
  );
  if (!preservation.ok)
    throw new Error(
      `Cannot load latest publication for "${listKey}" at sequence ${highest}: existing entity fields cannot be preserved losslessly. First difference: ${preservation.path}`,
    );
  return { exists: true, sequenceNumber: highest, loteDocument, entities };
}

export function convertLoTEToAuthoringEntities(
  document: LoTEDocument,
): AuthoringEntity[] {
  const entities = document.LoTE.TrustedEntitiesList ?? [];
  return entities.map((entity) => convertEntity(entity));
}

function convertEntity(entity: TrustedEntity): AuthoringEntity {
  const information = entity.TrustedEntityInformation;
  const services = entity.TrustedEntityServices.map((trustedService) => {
    const service = trustedService.ServiceInformation;
    if (service.ServiceStatus)
      throw new Error(
        "Cannot convert existing entity: ServiceStatus is present but not supported in the current profile. The existing LoTE contains data that cannot be preserved losslessly.",
      );
    if (service.StatusStartingTime)
      throw new Error(
        "Cannot convert existing entity: StatusStartingTime is present but not supported in the current profile.",
      );
    if (
      trustedService.ServiceHistory &&
      trustedService.ServiceHistory.length > 0
    )
      throw new Error(
        "Cannot convert existing entity: ServiceHistory is present but not supported in the current profile.",
      );
    if (service.SchemeServiceDefinitionURI)
      throw new Error(
        "Cannot convert existing entity: SchemeServiceDefinitionURI is present but not supported in the current authoring model.",
      );
    if (service.ServiceDefinitionURI)
      throw new Error(
        "Cannot convert existing entity: ServiceDefinitionURI is present but not supported in the current authoring model.",
      );
    if (service.ServiceDigitalIdentity.X509SubjectNames?.length)
      throw new Error(
        "Cannot convert existing entity: X509SubjectNames are present but not supported in the current authoring model.",
      );
    if (service.ServiceDigitalIdentity.X509SKIs?.length)
      throw new Error(
        "Cannot convert existing entity: X509SKIs are present but not supported in the current authoring model.",
      );
    const certificates = (
      service.ServiceDigitalIdentity.X509Certificates ?? []
    ).map((certificate) => {
      if (certificate.encoding || certificate.specRef)
        throw new Error(
          "Cannot convert existing entity: X509Certificate has encoding/specRef fields not supported in the authoring model.",
        );
      /*
        Lists published before the Base64 DER rule was enforced carry PEM here.
        Normalising on read upgrades them on their next version; the
        preservation check normalises the original the same way so the upgrade
        is not mistaken for data loss.
      */
      return certificateDerBase64(certificate.val);
    });
    let serviceUniqueIdentifier = "";
    for (const extension of service.ServiceInformationExtensions ?? []) {
      for (const key of Object.keys(extension)) {
        if (key !== "ServiceUniqueIdentifier" && key !== "Critical")
          throw new Error(
            `Cannot convert existing entity: unsupported extension "${key}" in ServiceInformationExtensions.`,
          );
      }
      const identifier = extension.ServiceUniqueIdentifier;
      if (typeof identifier !== "string")
        throw new Error(
          "Cannot convert existing entity: ServiceUniqueIdentifier is malformed.",
        );
      serviceUniqueIdentifier = identifier;
    }
    const serviceSupplyPoints = (service.ServiceSupplyPoints ?? []).map(
      (supplyPoint) => {
        if (supplyPoint.ServiceType)
          throw new Error(
            "Cannot convert existing entity: ServiceSupplyPointURI has ServiceType not supported in the current authoring model.",
          );
        return { uriValue: supplyPoint.uriValue };
      },
    );
    const converted: AuthoringService = {
      serviceTypeIdentifier: service.ServiceTypeIdentifier ?? "",
      serviceName: service.ServiceName.map((name) => ({
        lang: name.lang,
        value: name.value,
      })),
      serviceDigitalIdentity: { x509Certificates: certificates },
      serviceUniqueIdentifier,
      serviceSupplyPoints,
    };
    return converted;
  });
  return {
    teName: information.TEName.map((name) => ({
      lang: name.lang,
      value: name.value,
    })),
    teTradeName: information.TETradeName?.map((name) => ({
      lang: name.lang,
      value: name.value,
    })),
    tePostalAddress: information.TEAddress.TEPostalAddress.map((address) => ({
      lang: address.lang,
      StreetAddress: address.StreetAddress,
      Locality: address.Locality,
      StateOrProvince: address.StateOrProvince,
      PostalCode: address.PostalCode,
      Country: address.Country,
    })),
    teElectronicAddress: information.TEAddress.TEElectronicAddress.map(
      (address) => ({ lang: address.lang, uriValue: address.uriValue }),
    ),
    teInformationURI: information.TEInformationURI.map((uri) => ({
      lang: uri.lang,
      uriValue: uri.uriValue,
    })),
    services,
  };
}

/**
 * Restates a stored entity in the form the current compiler emits, so the
 * preservation check compares meaning rather than encoding. Only the two
 * representations this project has ever produced are adjusted: PEM certificate
 * values and extension containers without criticality.
 */
function normalizePublishedEntity(
  entity: TrustedEntity | undefined,
): TrustedEntity | undefined {
  if (!entity) return entity;
  return {
    ...entity,
    TrustedEntityServices: entity.TrustedEntityServices.map((service) => {
      const information = service.ServiceInformation;
      const certificates = information.ServiceDigitalIdentity.X509Certificates;
      return {
        ...service,
        ServiceInformation: {
          ...information,
          ServiceDigitalIdentity: {
            ...information.ServiceDigitalIdentity,
            ...(certificates
              ? {
                  X509Certificates: certificates.map((certificate) => ({
                    ...certificate,
                    val: certificateDerBase64(certificate.val),
                  })),
                }
              : {}),
          },
          ...(information.ServiceInformationExtensions
            ? {
                ServiceInformationExtensions:
                  information.ServiceInformationExtensions.map((extension) => ({
                    Critical: false,
                    ...extension,
                  })),
              }
            : {}),
        },
      };
    }),
  };
}

export function checkLosslessPreservation(
  originalEntities: readonly TrustedEntity[],
  convertedEntities: readonly AuthoringEntity[],
  family: EnabledProfileFamily = "wallet-providers",
): PreservationResult {
  getEnabledProfile(family);
  if (originalEntities.length !== convertedEntities.length)
    return { ok: false, path: "TrustedEntitiesList.length" };
  for (let index = 0; index < originalEntities.length; index += 1) {
    const entity = convertedEntities[index];
    if (!entity) return { ok: false, path: `TrustedEntitiesList[${index}]` };
    const input: AuthoringInput = {
      schemeOperator: {
        name: [{ lang: "en", value: "Test" }],
        postalAddress: [{ lang: "en", StreetAddress: "1 St", Country: "EU" }],
        electronicAddress: [{ lang: "en", uriValue: "mailto:t@t.org" }],
      },
      scheme: {
        schemeName: [{ lang: "en", value: "Test" }],
        schemeTerritory: "EU",
        distributionPoints: ["https://t.org"],
      },
      listIssueDateTime: "2026-01-01T00:00:00Z",
      nextUpdate: "2026-07-01T00:00:00Z",
      loTESequenceNumber: 1,
      entities: [entity],
    };
    const recompiled = compileForProfile(family, input).document.LoTE
      .TrustedEntitiesList?.[0];
    const difference = deepDiff(
      `TrustedEntitiesList[${index}]`,
      normalizePublishedEntity(originalEntities[index]),
      recompiled,
    );
    if (difference) return { ok: false, path: difference };
  }
  return { ok: true };
}

function deepDiff(
  prefix: string,
  left: unknown,
  right: unknown,
): string | null {
  if (left === right) return null;
  if (left === null || right === null)
    return `${prefix}: ${String(left)} !== ${String(right)}`;
  if (typeof left !== typeof right)
    return `${prefix}: type ${typeof left} !== ${typeof right}`;
  if (typeof left !== "object")
    return `${prefix}: ${JSON.stringify(left)} !== ${JSON.stringify(right)}`;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right))
      return `${prefix}: array mismatch`;
    if (left.length !== right.length)
      return `${prefix}.length: ${left.length} !== ${right.length}`;
    for (let index = 0; index < left.length; index += 1) {
      const difference = deepDiff(
        `${prefix}[${index}]`,
        left[index],
        right[index],
      );
      if (difference) return difference;
    }
    return null;
  }
  if (!isRecord(left) || !isRecord(right)) return `${prefix}: object mismatch`;
  const keys = new Set([
    ...Object.keys(left).filter((key) => left[key] !== undefined),
    ...Object.keys(right).filter((key) => right[key] !== undefined),
  ]);
  for (const key of keys) {
    if (!(key in left)) return `${prefix}.${key}: missing from original`;
    if (!(key in right)) return `${prefix}.${key}: missing from recompiled`;
    const difference = deepDiff(`${prefix}.${key}`, left[key], right[key]);
    if (difference) return difference;
  }
  return null;
}

export function checkServiceIdentifierUniqueness(
  existingEntities: readonly AuthoringEntity[],
  candidateEntity: AuthoringEntity,
): UniquenessResult {
  const existing = new Set<string>();
  for (const entity of existingEntities)
    for (const service of entity.services)
      existing.add(service.serviceUniqueIdentifier);
  const candidates = new Set<string>();
  for (const service of candidateEntity.services) {
    if (
      candidates.has(service.serviceUniqueIdentifier) ||
      existing.has(service.serviceUniqueIdentifier)
    )
      return { ok: false, duplicate: service.serviceUniqueIdentifier };
    candidates.add(service.serviceUniqueIdentifier);
  }
  return { ok: true };
}

/**
 * Turns a signing-configuration entry into the scheme description the compiler
 * needs. `signerCertificates` is read from the configured certificate file so
 * the self pointer publishes the list's own trust anchor.
 */
export function schemeDescriptorFor(
  entry: SigningConfigEntry,
): SchemeDescriptor {
  let signerCertificates: string[] = [];
  try {
    signerCertificates = [
      certificateDerBase64(readFileSync(entry.certFile, "utf-8")),
    ];
  } catch {
    // Without a readable certificate the self pointer is omitted; publication
    // fails later on the missing signing material with a clearer message.
  }
  return {
    schemeOperatorName: entry.schemeOperatorName,
    schemeOperatorStreet: entry.schemeOperatorStreet,
    schemeOperatorCountry: entry.schemeOperatorCountry,
    schemeOperatorEmail: entry.schemeOperatorEmail,
    schemeOperatorWebsite: entry.schemeOperatorWebsite,
    schemeName: entry.schemeName,
    schemeTerritory: entry.schemeTerritory,
    schemeInformationUris: entry.schemeInformationUris,
    policyUri: entry.policyUri,
    distributionPointUri: entry.distributionPointUri,
    signerCertificates,
  };
}

export function assembleNextList(
  existingEntities: readonly AuthoringEntity[],
  candidateEntity: AuthoringEntity,
  application: TrustedEntityApplication,
  entry: SigningConfigEntry,
  listIssueDateTime: string,
  nextUpdate: string,
  nextSequence: number,
): AuthoringInput {
  if (entry.family !== application.family)
    throw new Error(
      `Configured family '${entry.family}' does not match application family '${application.family}'.`,
    );
  return normalizeToAuthoringInput(
    application,
    schemeDescriptorFor(entry),
    listIssueDateTime,
    nextUpdate,
    nextSequence,
    [...existingEntities, candidateEntity],
  );
}
