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
} from "../model/types.js";
import { LOTE_VERSION_IDENTIFIER } from "../profiles/wallet-provider/constants.js";
import { getProfile, type ProfileFamily } from "../profiles/registry.js";

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
            const pkiOb: PkiOb = { val: cert };
            return pkiOb;
          },
        ),
      },
      ServiceTypeIdentifier: svc.serviceTypeIdentifier,
      ServiceInformationExtensions: [
        {
          ServiceUniqueIdentifier: svc.serviceUniqueIdentifier,
        },
      ],
    };

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
    SchemeName: toMultiLang(input.scheme.schemeName),
    StatusDeterminationApproach: profile.statusDeterminationApproach,
    SchemeTypeCommunityRules: [{ lang: "en", uriValue: profile.schemeRules }],
    SchemeTerritory: input.scheme.schemeTerritory,
    ListIssueDateTime: input.listIssueDateTime,
    NextUpdate: input.nextUpdate,
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
