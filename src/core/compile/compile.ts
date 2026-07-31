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
  ServiceHistoryInstance,
} from "../model/types.js";
import { LOTE_VERSION_IDENTIFIER } from "../profiles/wallet-provider/constants.js";
import {
  getProfile,
  type ProfileFamily,
  type TrustedEntityProfile,
} from "../profiles/registry.js";
import {
  certificateDerBase64,
  isLegalBasisReference,
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

function compileEntity(
  entity: AuthoringEntity,
  profile: TrustedEntityProfile,
): TrustedEntity {
  if (profile.requiresLegalBasisReference) {
    if (!entity.teTradeName || entity.teTradeName.length === 0)
      throw new Error(`${profile.label} require TETradeName.`);
    if (
      !entity.teTradeName.some(
        (name) =>
          name.value.startsWith("OJ:") && isLegalBasisReference(name.value),
      )
    )
      throw new Error(
        `${profile.label} require TETradeName to include the formatted OJ: legal-basis URI.`,
      );
  }
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
    const certificates = svc.serviceDigitalIdentity.x509Certificates;
    const si: ServiceInformation = {
      ServiceName: toMultiLang(svc.serviceName),
      /*
        clause 6.6.3: identity arrays have minItems 1, so a service with no
        certificate carries an empty ServiceDigitalIdentity rather than an empty
        X509Certificates array. Only Annex H allows that: its service digital
        identity is optional.
      */
      ServiceDigitalIdentity:
        certificates.length > 0
          ? {
              X509Certificates: certificates.map((cert) => {
                /*
                  clause 6.6.3: the value is Base64 DER certificate data. The
                  authoring model already holds it in that form, so no PEM armour
                  or whitespace can reach the published list.
                */
                const pkiOb: PkiOb = { val: certificateDerBase64(cert) };
                return pkiOb;
              }),
            }
          : {},
      ServiceTypeIdentifier: svc.serviceTypeIdentifier,
    };

    /*
      Annex H publishes the current service status and the instant it began.
      Annex D–G publish neither, so a stray value on those profiles is a bug in
      the caller and is refused rather than emitted.
    */
    if (svc.serviceStatus || svc.statusStartingTime) {
      if (!profile.usesServiceStatus)
        throw new Error(
          `${profile.label} services publish no ServiceStatus or StatusStartingTime.`,
        );
      if (!svc.serviceStatus || !svc.statusStartingTime)
        throw new Error(
          "A service status and its starting time must be published together.",
        );
      si.ServiceStatus = svc.serviceStatus;
      si.StatusStartingTime = normalizeUtcDateTime(svc.statusStartingTime);
    }

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

    const service: TrustedEntityService = { ServiceInformation: si };

    /*
      Annex H keeps every superseded state. The history entry states the key that
      identified the service at the time and never the certificate itself: the
      certificate belongs to the current entry, and repeating it would suggest
      the key is still the published identity.
    */
    if (svc.serviceHistory && svc.serviceHistory.length > 0) {
      if (!profile.usesServiceStatus)
        throw new Error(`${profile.label} services publish no ServiceHistory.`);
      service.ServiceHistory = svc.serviceHistory.map((instance) => {
        if (instance.x509Skis.length === 0)
          throw new Error(
            "A ServiceHistory instance must state at least one X509SKI.",
          );
        const history: ServiceHistoryInstance = {
          ServiceName: toMultiLang(instance.serviceName),
          ServiceDigitalIdentity: { X509SKIs: [...instance.x509Skis] },
          ServiceStatus: instance.serviceStatus,
          StatusStartingTime: normalizeUtcDateTime(instance.statusStartingTime),
        };
        if (instance.serviceTypeIdentifier)
          history.ServiceTypeIdentifier = instance.serviceTypeIdentifier;
        return history;
      });
    }

    return service;
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

  /*
    Annex H fixes the historical information period; Annex D–G omit the
    component. The value comes from the authoring input so a caller cannot
    silently publish a different period than the profile states.
  */
  if (profile.historicalInformationPeriod !== undefined) {
    const period =
      input.scheme.historicalInformationPeriod ??
      profile.historicalInformationPeriod;
    if (period !== profile.historicalInformationPeriod)
      throw new Error(
        `${profile.label} fixes HistoricalInformationPeriod at ${profile.historicalInformationPeriod}, not ${period}.`,
      );
    schemeInfo.HistoricalInformationPeriod = period;
  } else if (input.scheme.historicalInformationPeriod !== undefined) {
    throw new Error(
      `${profile.label} does not publish HistoricalInformationPeriod.`,
    );
  }

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
    Annex D–G require the list to point at itself, so a reader that starts from
    the artifact can confirm where it is published and which certificates
    authenticate it. Annex H requires PointersToOtherLoTE to be absent, so the
    profile decides rather than the presence of signing certificates.
  */
  const selfPointerCertificates = profile.publishesSelfPointer
    ? (input.scheme.selfPointerCertificates ?? [])
    : [];
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
    lote.TrustedEntitiesList = input.entities.map((entity) =>
      compileEntity(entity, profile),
    );
  }

  const document: LoTEDocument = { LoTE: lote };

  return { document };
}

/** Backward-compatible Wallet Provider compiler entry point. */
export function compile(input: AuthoringInput): CompileResult {
  return compileForProfile("wallet-providers", input);
}
