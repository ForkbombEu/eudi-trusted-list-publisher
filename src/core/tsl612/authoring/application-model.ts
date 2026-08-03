/**
 * The application a provider submits to be listed in a TS 119 612 Trusted List.
 *
 * This is deliberately parallel to `src/core/authoring/application-model.ts`
 * rather than an extension of it. That model is shaped around TS 119 602: LoTE
 * types, service unique identifiers, legal-basis URIs, entity role URIs. None
 * of those exist here, and a TSP with `TSPTradeName` and
 * `SchemeServiceDefinitionURI` has no equivalent there. Two small models that
 * each say what their standard means beat one model with two thirds of its
 * fields inapplicable at any moment.
 */
import { createHash, X509Certificate } from "node:crypto";
import { getTslProfile, isTslFamily, type TslFamily } from "../registry.js";
import { toUtcDateTime } from "../../model/lexical.js";
import type {
  TslProvider,
  TslService,
  TslServiceHistoryInstance,
} from "../model.js";
import type { TrustedListConfigEntry } from "../list-config.js";

export const TSL_APPLICATION_SCHEMA_VERSION = 1;

/**
 * `published` and `superseded` are both live states. A superseded application
 * is one whose service has been deprecated or withdrawn: the version that
 * listed it stays authentic and downloadable, which is the whole point of
 * publishing a status change as a new version rather than a rewrite.
 */
export type TslApplicationState =
  "submitted" | "approved" | "rejected" | "published" | "superseded";

export interface TslApplicantAddress {
  readonly streetAddress: string;
  readonly locality: string;
  readonly postalCode?: string;
  readonly stateOrProvince?: string;
  readonly countryName: string;
}

export interface TslApplicationRecord {
  readonly id: string;
  readonly schemaVersion: typeof TSL_APPLICATION_SCHEMA_VERSION;
  readonly standard: "TS 119 612";
  readonly family: TslFamily;
  readonly state: TslApplicationState;
  readonly submittedAt: string;
  /** The XML Trusted List this application asks to be listed in. */
  readonly listKey: string;
  readonly tspName: string;
  /**
   * The official registration identifier as the applicant typed it, before the
   * `VATCC-`/`NTRCC-` prefix is applied. Stored raw so a correction does not
   * have to unpick a formatted value.
   */
  readonly registrationIdentifier: string;
  readonly registrationIdentifierKind: "vat" | "national";
  readonly tradeName?: string;
  readonly address: TslApplicantAddress;
  readonly email: string;
  readonly website: string;
  readonly telephone?: string;
  readonly tspInformationUri: string;
  readonly serviceName: string;
  readonly certificatePem: string;
  readonly schemeServiceDefinitionUri?: string;
  readonly tspServiceDefinitionUri?: string;
  readonly serviceSupplyPoints?: readonly string[];
  /**
   * Evidence of national recognition (EAA) or of qualified status (QEAA).
   *
   * Retained for the administrator to read and **never published**: it is the
   * basis on which a decision is taken, not a component of the Trusted List.
   */
  readonly evidence: string;
  readonly adminNote?: string;
  readonly approvedAt?: string;
  readonly rejectedAt?: string;
  readonly publication?: TslPublicationRecord;
  readonly supersession?: TslPublicationRecord;
  readonly supersededAt?: string;
}

export interface TslPublicationRecord {
  readonly listKey: string;
  readonly sequenceNumber: number;
  readonly publishedAt: string;
  readonly trustedListXmlSha256: string;
  readonly serviceStatus: string;
  readonly statusStartingTime: string;
}

const TRANSITIONS: Readonly<
  Record<TslApplicationState, readonly TslApplicationState[]>
> = Object.freeze({
  submitted: Object.freeze<TslApplicationState[]>(["approved", "rejected"]),
  approved: Object.freeze<TslApplicationState[]>(["published", "rejected"]),
  rejected: Object.freeze<TslApplicationState[]>([]),
  published: Object.freeze<TslApplicationState[]>(["superseded"]),
  superseded: Object.freeze<TslApplicationState[]>([]),
});

export function canTransition(
  from: TslApplicationState,
  to: TslApplicationState,
): boolean {
  return (TRANSITIONS[from] as readonly string[]).includes(to);
}

/**
 * The registration identifier as clause 5.4.2 publishes it.
 *
 * `VATCC-` when the applicant holds a VAT identifier, `NTRCC-` otherwise,
 * where `CC` is the territory of the Trusted List. The applicant may already
 * have typed the prefix; typing it twice is a correction, not a second prefix.
 */
export function formattedRegistrationIdentifier(
  identifier: string,
  kind: "vat" | "national",
  territory: string,
): string {
  const scheme = kind === "vat" ? "VAT" : "NTR";
  const prefix = `${scheme}${territory}-`;
  const trimmed = identifier.trim();
  const bare = trimmed.toUpperCase().startsWith(prefix.toUpperCase())
    ? trimmed.slice(prefix.length)
    : trimmed;
  return `${prefix}${bare}`;
}

/** The certificate as strict Base64 DER, which is how clause 5.5.3 publishes it. */
export function certificateBase64Der(certificatePem: string): string {
  return Buffer.from(new X509Certificate(certificatePem).raw).toString(
    "base64",
  );
}

/**
 * SHA-256 of the certificate's subject public key.
 *
 * This is how a published service is identified across versions: the service
 * type says what it is, and the key fingerprint says whose it is. The
 * certificate itself may be reissued without the service changing identity.
 */
export function servicePublicKeyFingerprint(certificatePem: string): string {
  const certificate = new X509Certificate(certificatePem);
  return createHash("sha256")
    .update(certificate.publicKey.export({ format: "der", type: "spki" }))
    .digest("hex");
}

/**
 * Compiles one approved application into the provider entry the compiler
 * publishes.
 *
 * The service status and its starting time are decided by the family, never by
 * the applicant: EAA is recognised at national level, QEAA is granted, and the
 * time is the publication event.
 */
export function buildProvider(
  record: TslApplicationRecord,
  config: TrustedListConfigEntry,
  statusStartingTime: string,
): TslProvider {
  const profile = getTslProfile(record.family);
  const tradeNames: string[] = [
    formattedRegistrationIdentifier(
      record.registrationIdentifier,
      record.registrationIdentifierKind,
      config.schemeTerritory,
    ),
  ];
  if (record.tradeName && record.tradeName.trim() !== "")
    tradeNames.push(record.tradeName.trim());

  const service: TslService = {
    serviceTypeIdentifier: profile.serviceTypeIdentifier,
    serviceName: record.serviceName,
    digitalIdentity: {
      x509CertificateBase64Der: certificateBase64Der(record.certificatePem),
    },
    serviceStatus: profile.initialStatus,
    statusStartingTime,
    ...(record.schemeServiceDefinitionUri
      ? { schemeServiceDefinitionUri: record.schemeServiceDefinitionUri }
      : {}),
    ...(record.tspServiceDefinitionUri
      ? { tspServiceDefinitionUri: record.tspServiceDefinitionUri }
      : {}),
    ...(record.serviceSupplyPoints && record.serviceSupplyPoints.length > 0
      ? { serviceSupplyPoints: record.serviceSupplyPoints }
      : {}),
  };

  return {
    tspName: record.tspName,
    tspTradeNames: tradeNames,
    tspAddress: {
      streetAddress: record.address.streetAddress,
      locality: record.address.locality,
      ...(record.address.stateOrProvince
        ? { stateOrProvince: record.address.stateOrProvince }
        : {}),
      ...(record.address.postalCode
        ? { postalCode: record.address.postalCode }
        : {}),
      countryName: record.address.countryName,
    },
    tspElectronicAddress: {
      email: record.email,
      website: record.website,
      ...(record.telephone ? { telephone: record.telephone } : {}),
    },
    tspInformationUri: record.tspInformationUri,
    services: [service],
  };
}

/**
 * The superseded state of a service, for `ServiceHistory`.
 *
 * Clause 5.6.3 as this publisher applies it: the history instance identifies
 * the service by key identifier only. Republishing the certificate would
 * restate a current identity for a state that is no longer current.
 */
export function historyInstanceFor(
  service: TslService,
  subjectKeyIdentifierBase64: string,
): TslServiceHistoryInstance {
  return {
    serviceTypeIdentifier: service.serviceTypeIdentifier,
    serviceName: service.serviceName,
    digitalIdentity: { x509SkiBase64: subjectKeyIdentifierBase64 },
    serviceStatus: service.serviceStatus,
    statusStartingTime: service.statusStartingTime,
  };
}

/** Guards a family name arriving from a route or a stored record. */
export function requireTslFamily(value: string): TslFamily {
  if (!isTslFamily(value))
    throw new Error(`'${value}' is not a TS 119 612 onboarding family.`);
  return value;
}

/** The publication instant, in the lexical form clause 6.1.3 requires. */
export function publicationInstant(clock?: Date): string {
  return toUtcDateTime(clock ?? new Date());
}
