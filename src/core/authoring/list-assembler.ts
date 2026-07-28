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
  const index = await store.loadIndex(listKey);
  if (!index || index.versions.length === 0) {
    return { exists: false };
  }

  const latest = index.versions[index.versions.length - 1]!;
  const seq = latest.sequenceNumber;

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
        let certList: string[] = [];
        if (si.ServiceDigitalIdentity?.X509Certificates) {
          certList = si.ServiceDigitalIdentity.X509Certificates.map(
            (c) => c.val,
          );
        }
        let svcId = "";
        if (
          si.ServiceInformationExtensions &&
          si.ServiceInformationExtensions.length > 0
        ) {
          const ext = si.ServiceInformationExtensions[0] as Record<
            string,
            unknown
          >;
          svcId = (ext["ServiceUniqueIdentifier"] as string) ?? "";
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
            si.ServiceSupplyPoints?.map((sp) => ({
              uriValue: sp.uriValue,
            })) ?? [],
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
