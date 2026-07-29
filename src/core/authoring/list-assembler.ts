import type {
  AuthoringInput,
  AuthoringEntity,
  AuthoringService,
} from "../model/authoring.js";
import type { LoTEDocument, ServiceInformation } from "../model/types.js";
import {
  PublicationStore,
  loadVersionArtifacts,
} from "../publication/store.js";
import type { SigningConfigEntry } from "./signing-config.js";
import {
  normalizeToAuthoringInput,
  type WalletProviderApplication,
} from "./application-model.js";

export interface LatestPublication {
  exists: true;
  sequenceNumber: number;
  loteDocument: LoTEDocument;
  entities: AuthoringEntity[];
}

export interface NoPublication {
  exists: false;
}

export type LatestResult = LatestPublication | NoPublication;

const MAX_BYTES = 10 * 1024 * 1024;

export async function loadLatestPublication(
  store: PublicationStore,
  listKey: string,
): Promise<LatestResult> {
  const highest = store.getHighestStoredSequence(listKey);
  if (highest === null) {
    return { exists: false };
  }

  const seq = highest;

  const outcome = await loadVersionArtifacts(
    store.publicationDir,
    listKey,
    seq,
    MAX_BYTES,
  );
  if (!outcome.artifacts) {
    throw new Error(
      `Latest publication for "${listKey}" at sequence ${seq} is corrupt or unauthenticated: ${outcome.diagnostic}`,
    );
  }

  let loteDocument: LoTEDocument;
  try {
    loteDocument = JSON.parse(outcome.artifacts.loteJsonBytes) as LoTEDocument;
  } catch {
    throw new Error(
      `Cannot parse latest publication LoTE JSON for "${listKey}" sequence ${seq}`,
    );
  }

  const entities = convertLoTEToAuthoringEntities(loteDocument);

  return {
    exists: true,
    sequenceNumber: seq,
    loteDocument,
    entities,
  };
}

export function convertLoTEToAuthoringEntities(
  doc: LoTEDocument,
): AuthoringEntity[] {
  const trustedEntities = doc?.LoTE?.TrustedEntitiesList ?? [];
  const result: AuthoringEntity[] = [];

  for (const te of trustedEntities) {
    const info = te.TrustedEntityInformation;
    const services = (te.TrustedEntityServices ?? []).map(
      (tes): AuthoringService => {
        const si: ServiceInformation = tes.ServiceInformation;

        // Reject unsupported structures
        if (si.ServiceStatus) {
          throw new Error(
            "Cannot convert existing entity: ServiceStatus is present but not supported in the current profile. The existing LoTE contains data that cannot be preserved losslessly.",
          );
        }
        if (si.StatusStartingTime) {
          throw new Error(
            "Cannot convert existing entity: StatusStartingTime is present but not supported in the current profile.",
          );
        }
        if (tes.ServiceHistory && tes.ServiceHistory.length > 0) {
          throw new Error(
            "Cannot convert existing entity: ServiceHistory is present but not supported in the current profile.",
          );
        }
        if (si.SchemeServiceDefinitionURI) {
          throw new Error(
            "Cannot convert existing entity: SchemeServiceDefinitionURI is present but not supported in the current authoring model.",
          );
        }
        if (si.ServiceDefinitionURI) {
          throw new Error(
            "Cannot convert existing entity: ServiceDefinitionURI is present but not supported in the current authoring model.",
          );
        }
        if (
          si.ServiceDigitalIdentity?.X509SubjectNames &&
          si.ServiceDigitalIdentity.X509SubjectNames.length > 0
        ) {
          throw new Error(
            "Cannot convert existing entity: X509SubjectNames are present but not supported in the current authoring model.",
          );
        }
        if (
          si.ServiceDigitalIdentity?.X509SKIs &&
          si.ServiceDigitalIdentity.X509SKIs.length > 0
        ) {
          throw new Error(
            "Cannot convert existing entity: X509SKIs are present but not supported in the current authoring model.",
          );
        }

        let certList: string[] = [];
        if (si.ServiceDigitalIdentity?.X509Certificates) {
          certList = si.ServiceDigitalIdentity.X509Certificates.map((c) => {
            if (c.encoding || c.specRef) {
              throw new Error(
                "Cannot convert existing entity: X509Certificate has encoding/specRef fields not supported in the authoring model.",
              );
            }
            return c.val;
          });
        }

        let svcId = "";
        if (
          si.ServiceInformationExtensions &&
          si.ServiceInformationExtensions.length > 0
        ) {
          // Only ServiceUniqueIdentifier is supported
          for (const ext of si.ServiceInformationExtensions) {
            const e = ext as Record<string, unknown>;
            const keys = Object.keys(e);
            for (const k of keys) {
              if (k !== "ServiceUniqueIdentifier") {
                throw new Error(
                  `Cannot convert existing entity: unsupported extension "${k}" in ServiceInformationExtensions.`,
                );
              }
            }
            svcId = (e["ServiceUniqueIdentifier"] as string) ?? "";
          }
        }

        return {
          serviceTypeIdentifier: si.ServiceTypeIdentifier ?? "",
          serviceName:
            si.ServiceName?.map((n) => ({
              lang: n.lang,
              value: n.value,
            })) ?? [],
          serviceDigitalIdentity: {
            x509Certificates: certList,
          },
          serviceUniqueIdentifier: svcId,
          serviceSupplyPoints:
            si.ServiceSupplyPoints?.map((sp) => {
              if (sp.ServiceType) {
                throw new Error(
                  "Cannot convert existing entity: ServiceSupplyPointURI has ServiceType not supported in the authoring model.",
                );
              }
              return { uriValue: sp.uriValue };
            }) ?? [],
        };
      },
    );

    result.push({
      teName: info.TEName?.map((n) => ({ lang: n.lang, value: n.value })) ?? [],
      teTradeName:
        info.TETradeName?.map((n) => ({ lang: n.lang, value: n.value })) ??
        undefined,
      tePostalAddress:
        info.TEAddress?.TEPostalAddress?.map((a) => ({
          lang: a.lang,
          StreetAddress: a.StreetAddress,
          Locality: a.Locality,
          StateOrProvince: a.StateOrProvince,
          PostalCode: a.PostalCode,
          Country: a.Country,
        })) ?? [],
      teElectronicAddress:
        info.TEAddress?.TEElectronicAddress?.map((e) => ({
          lang: e.lang,
          uriValue: e.uriValue,
        })) ?? [],
      teInformationURI:
        info.TEInformationURI?.map((u) => ({
          lang: u.lang,
          uriValue: u.uriValue,
        })) ?? [],
      services,
    });
  }

  return result;
}

export function checkServiceIdentifierUniqueness(
  existingEntities: AuthoringEntity[],
  candidateEntity: AuthoringEntity,
): { ok: true } | { ok: false; duplicate: string } {
  const existingIds = new Set<string>();
  for (const ent of existingEntities) {
    for (const svc of ent.services) {
      existingIds.add(svc.serviceUniqueIdentifier);
    }
  }

  // Check candidate's own services for duplicates
  const candidateIds = new Set<string>();
  for (const svc of candidateEntity.services) {
    if (candidateIds.has(svc.serviceUniqueIdentifier)) {
      return { ok: false, duplicate: svc.serviceUniqueIdentifier };
    }
    candidateIds.add(svc.serviceUniqueIdentifier);
    if (existingIds.has(svc.serviceUniqueIdentifier)) {
      return { ok: false, duplicate: svc.serviceUniqueIdentifier };
    }
  }

  return { ok: true };
}

export function assembleNextList(
  existingEntities: AuthoringEntity[],
  candidateEntity: AuthoringEntity,
  app: WalletProviderApplication,
  entry: SigningConfigEntry,
  listIssueDateTime: string,
  nextUpdate: string,
  nextSeq: number,
): AuthoringInput {
  const authInput = normalizeToAuthoringInput(
    app,
    entry.schemeOperatorName,
    entry.schemeName,
    entry.schemeTerritory,
    {
      streetAddress: entry.schemeOperatorStreet,
      country: entry.schemeOperatorCountry,
    },
    entry.schemeOperatorContactUri,
    entry.distributionPointUri,
    listIssueDateTime,
    nextUpdate,
    nextSeq,
    [...existingEntities, candidateEntity],
  );

  return authInput;
}
