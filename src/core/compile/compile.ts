import type {
  AuthoringInput,
  AuthoringEntity,
  AuthoringService,
} from "../model/authoring.js";
import type {
  LoTEDocument,
  LoTE,
  ListAndSchemeInformation,
  TrustedEntity,
  TrustedEntityInformation,
  TrustedEntityService,
  ServiceInformation,
  MultiLangString,
  NonEmptyMultiLangURI,
  PostalAddress,
  PkiOb,
  OtherLoTEPointer,
} from "../model/types.js";
import { LOTE_VERSION_IDENTIFIER } from "../profiles/wallet-provider/constants.js";
import { getProfile, type ProfileFamily } from "../profiles/registry.js";
import {
  certificateDerBase64,
  normalizeUtcDateTime,
  schemeNameWithTerritory,
} from "../model/lexical.js";

export interface CompileResult {
  document: LoTEDocument;
}

function toMultiLang(
  arr: { lang: string; value: string }[],
): MultiLangString[] {
  return arr.map(({ lang, value }) => ({ lang, value }));
}

function toMultiLangURI(
  arr: { lang: string; uriValue: string }[],
): NonEmptyMultiLangURI[] {
  return arr.map(({ lang, uriValue }) => ({ lang, uriValue }));
}

function toPostalAddress(
  arr: {
    lang: string;
    StreetAddress: string;
    Locality?: string;
    StateOrProvince?: string;
    PostalCode?: string;
    Country: string;
  }[],
): PostalAddress[] {
  return arr.map(
    ({
      lang,
      StreetAddress,
      Locality,
      StateOrProvince,
      PostalCode,
      Country,
    }) => ({
      lang,
      StreetAddress,
      Locality,
      StateOrProvince,
      PostalCode,
      Country,
    }),
  );
}

function compileEntity(entity: AuthoringEntity): TrustedEntity {
  const teInfo: TrustedEntityInformation = {
    TEName: toMultiLang(entity.teName),
    TEAddress: {
      TEPostalAddress: toPostalAddress(entity.tePostalAddress),
      TEElectronicAddress: toMultiLangURI(entity.teElectronicAddress),
    },
    TEInformationURI: toMultiLangURI(entity.teInformationURI),
  };

  if (entity.teTradeName && entity.teTradeName.length > 0) {
    teInfo.TETradeName = toMultiLang(entity.teTradeName);
  }

  const compileService = (svc: AuthoringService): TrustedEntityService => {
    const si: ServiceInformation = {
      ServiceName: toMultiLang(svc.serviceName),
      ServiceDigitalIdentity: {
        X509Certificates: svc.serviceDigitalIdentity.x509Certificates.map(
          (cert) => {
            /*
              clause 6.6.3: the value is Base64 DER certificate data. The
              authoring model already holds it in that form, so no PEM armour
              or whitespace can reach the published list.
            */
            const pkiOb: PkiOb = { val: certificateDerBase64(cert) };
            return pkiOb;
          },
        ),
      },
      ServiceTypeIdentifier: svc.serviceTypeIdentifier,
    };

    /*
      clause 6.6.9: ServiceUniqueIdentifier is a recognised extension, and every
      extension container must state its criticality. It is not critical: a
      reader that does not understand it can still use the entry. Annex F and
      Annex G do not use the extension, so no empty container is emitted for
      them.
    */
    if (svc.serviceUniqueIdentifier) {
      si.ServiceInformationExtensions = [
        {
          Critical: false,
          ServiceUniqueIdentifier: svc.serviceUniqueIdentifier,
        },
      ];
    }

    if (svc.serviceSupplyPoints && svc.serviceSupplyPoints.length > 0) {
      si.ServiceSupplyPoints = svc.serviceSupplyPoints.map((sp) => ({
        uriValue: sp.uriValue,
      }));
    }

    return { ServiceInformation: si };
  };

  return {
    TrustedEntityInformation: teInfo,
    TrustedEntityServices: entity.services.map(compileService),
  };
}

export function compileForProfile(
  family: ProfileFamily,
  input: AuthoringInput,
): CompileResult {
  const profile = getProfile(family);
  if (
    !profile.loTEType ||
    !profile.statusDeterminationApproach ||
    !profile.schemeRules
  ) {
    throw new Error(`Profile ${family} has incomplete compilation metadata.`);
  }
  for (const entity of input.entities) {
    for (const service of entity.services) {
      if (
        !profile.allowedServiceTypes.includes(service.serviceTypeIdentifier)
      ) {
        throw new Error(
          `Service type '${service.serviceTypeIdentifier}' is not allowed for ${profile.label}.`,
        );
      }
    }
  }
  const schemeInfo: ListAndSchemeInformation = {
    LoTEVersionIdentifier: LOTE_VERSION_IDENTIFIER,
    LoTESequenceNumber: input.loTESequenceNumber,
    LoTEType: profile.loTEType,
    SchemeOperatorName: toMultiLang(input.schemeOperator.name),
    SchemeOperatorAddress: {
      SchemeOperatorPostalAddress: toPostalAddress(
        input.schemeOperator.postalAddress,
      ),
      SchemeOperatorElectronicAddress: toMultiLangURI(
        input.schemeOperator.electronicAddress,
      ),
    },
    SchemeName: input.scheme.schemeName.map(({ lang, value }) => ({
      lang,
      value: schemeNameWithTerritory(value, input.scheme.schemeTerritory),
    })),
    StatusDeterminationApproach: profile.statusDeterminationApproach,
    SchemeTypeCommunityRules: [{ lang: "en", uriValue: profile.schemeRules }],
    SchemeTerritory: input.scheme.schemeTerritory,
    ListIssueDateTime: normalizeUtcDateTime(input.listIssueDateTime),
    NextUpdate: normalizeUtcDateTime(input.nextUpdate),
    DistributionPoints: input.scheme.distributionPoints,
  };

  if (
    input.scheme.schemeInformationURI &&
    input.scheme.schemeInformationURI.length > 0
  ) {
    schemeInfo.SchemeInformationURI = toMultiLangURI(
      input.scheme.schemeInformationURI,
    );
  }

  if (input.scheme.policyUri) {
    schemeInfo.PolicyOrLegalNotice = [
      { LoTEPolicy: { lang: "en", uriValue: input.scheme.policyUri } },
    ];
  }

  /*
    Annex D/E require the list to point at itself, so a reader that starts from
    the artifact can confirm where it is published and which certificates
    authenticate it.
  */
  const selfPointerCertificates = input.scheme.selfPointerCertificates ?? [];
  const selfPointerLocation = input.scheme.distributionPoints[0];
  if (selfPointerCertificates.length > 0 && selfPointerLocation) {
    const pointer: OtherLoTEPointer = {
      LoTELocation: selfPointerLocation,
      ServiceDigitalIdentities: [
        {
          X509Certificates: selfPointerCertificates.map((cert) => ({
            val: certificateDerBase64(cert),
          })),
        },
      ],
      LoTEQualifiers: [
        {
          LoTEType: profile.loTEType,
          SchemeOperatorName: toMultiLang(input.schemeOperator.name),
          SchemeTypeCommunityRules: [
            { lang: "en", uriValue: profile.schemeRules },
          ],
          SchemeTerritory: input.scheme.schemeTerritory,
          MimeType: input.scheme.selfPointerMimeType ?? "application/jose",
        },
      ],
    };
    schemeInfo.PointersToOtherLoTE = [pointer];
  }

  const lote: LoTE = {
    ListAndSchemeInformation: schemeInfo,
  };

  if (input.entities.length > 0) {
    lote.TrustedEntitiesList = input.entities.map(compileEntity);
  }

  const document: LoTEDocument = { LoTE: lote };

  return { document };
}

/** Backward-compatible Wallet Provider compiler entry point. */
export function compile(input: AuthoringInput): CompileResult {
  return compileForProfile("wallet-providers", input);
}
