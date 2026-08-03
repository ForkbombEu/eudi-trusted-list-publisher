/**
 * The manifest of a published TS 119 612 Trusted List version.
 *
 * It is a different document from the TS 119 602 `Manifest` because it
 * describes a different artifact: one XML file rather than a JSON document and
 * a detached Compact JAdES, and a signature that is part of the file rather
 * than beside it. Both carry `manifestVersion` and a `standard`, so a reader
 * can tell which it is holding without guessing from the fields present.
 */
import { createHash } from "node:crypto";
import type { VerifyResult } from "../../xmlsec/index.js";
import type { ValidationResult } from "../validate/validate.js";

export const TSL_MANIFEST_VERSION = 1;

export interface TrustedListSignerInfo {
  readonly subject: string;
  readonly issuer: string;
  readonly validFrom: string;
  readonly validTo: string;
  /** SHA-256 of the certificate DER, lowercase hex. */
  readonly fingerprint: string;
}

/** The TS 119 612 values a reader looks for without parsing the XML. */
export interface TrustedListMetadata {
  readonly tslTag: string;
  readonly tslVersionIdentifier: number;
  readonly tslSequenceNumber: number;
  readonly tslType: string;
  readonly statusDeterminationApproach: string;
  readonly schemeOperatorName: string;
  readonly schemeName: string;
  readonly schemeTerritory: string;
  readonly historicalInformationPeriod: number;
  readonly issueDate: string;
  readonly nextUpdateDate: string;
  /** Every distinct `ServiceTypeIdentifier` in the current version. */
  readonly serviceTypes: readonly string[];
  readonly providerCount: number;
  readonly serviceCount: number;
}

export interface TrustedListManifest {
  readonly manifestVersion: number;
  readonly standard: "TS 119 612";
  readonly artifactFormat: "XML / XAdES-B-B";
  readonly family: string;
  readonly listKey: string;
  readonly sequenceNumber: number;
  readonly publicationTimestamp: string;
  /** SHA-256 of the exact published XML bytes, lowercase hex. */
  readonly trustedListXmlSha256: string;
  /**
   * The exact content published in `trusted-list.sha2`.
   *
   * It equals `trustedListXmlSha256` for every honest publication, and the two
   * are separate fields only so a fixture can publish a digest that is
   * deliberately wrong and still be read back. The manifest states what was
   * published; it never states what should have been.
   *
   * Absent in manifests written before intentionally broken XML fixtures
   * existed, where it is read as equal to `trustedListXmlSha256`.
   */
  readonly trustedListSha2Published?: string;
  readonly trustedList: TrustedListMetadata;
  /**
   * Where `trustedList` came from. `published-bytes` for every honest
   * publication. `authoring-input` only when a fixture mutation left bytes that
   * cannot be read as a Trusted List at all — the values are then what the list
   * was asked to be, and the artifact is what it actually became.
   */
  readonly trustedListMetadataSource: "published-bytes" | "authoring-input";
  readonly schemaValid: boolean;
  readonly schemaFindings: readonly string[];
  readonly signatureValid: boolean;
  readonly signatureFindings: readonly string[];
  /** Which EAA/QEAA profiles the version publishes, and which it may. */
  readonly serviceProfiles: TrustedListProfileSummary;
  /**
   * TLSO certificate-profile findings. Empty on the healthy path; a broken
   * fixture publishes them rather than being refused.
   */
  readonly signingCertificateFindings: readonly string[];
  /** Whether NextUpdate is later than the issue time and not already past. */
  readonly freshnessValid: boolean;
  readonly freshnessFindings: readonly string[];
  readonly fixture?: TrustedListFixtureSummary;
  readonly signatureProfile: "XAdES-B-B";
  readonly signatureAlgorithm: string;
  readonly signingTime: string;
  readonly signingCertificateSha256: string;
  readonly certificateSubject: string;
  readonly certificateIssuer: string;
  readonly certificateValidFrom: string;
  readonly certificateValidTo: string;
  /**
   * Cryptographic validity is not trust. This publisher builds no certification
   * path and checks no revocation, so the status is always `not_evaluated` —
   * exactly as in the TS 119 602 manifest.
   */
  readonly signerTrustStatus: "not_evaluated";
}

export function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * The content of `trusted-list.sha2`: the SHA-256 of the exact published XML
 * bytes, lowercase hex and nothing else. No trailing newline, because the file
 * *is* the digest rather than a line about it.
 */
export function sha2FileContent(xml: string): string {
  return sha256Hex(Buffer.from(xml, "utf-8"));
}

export interface BuildTrustedListManifestInput {
  readonly listKey: string;
  readonly family: string;
  readonly xml: string;
  readonly metadata: TrustedListMetadata;
  readonly schema: ValidationResult;
  readonly signature: VerifyResult;
  readonly signer: TrustedListSignerInfo;
  readonly publishedAt: Date;
  /** What the list's configuration allows, whether published or not. */
  readonly allowedServiceProfiles?: readonly string[];
  /** TLSO certificate-profile findings, empty on the healthy path. */
  readonly signingCertificateFindings?: readonly string[];
  /** Overrides the `.sha2` content. Negative fixtures only. */
  readonly sha2Override?: string;
  readonly metadataSource?: "published-bytes" | "authoring-input";
  /** Present only for an intentionally broken fixture. */
  readonly fixture?: TrustedListFixtureSummary;
}

/**
 * The fixture facts a manifest reader needs without opening `fixture.json`:
 * whether this version is a deliberate negative fixture at all, and what it was
 * asked to be. The full evidence stays in `fixture.json`.
 */
export interface TrustedListFixtureSummary {
  readonly fixtureMode: "healthy" | "intentionally-broken";
  readonly selectedDefects: readonly string[];
  readonly mutationStages: readonly string[];
}

/** Which service profiles a Trusted List publishes and which it may publish. */
export interface TrustedListProfileSummary {
  /** Read back from the published XML. */
  readonly serviceProfilesPresent: readonly string[];
  /** What the list's configuration allows, whether present or not. */
  readonly allowedServiceProfiles: readonly string[];
}

/**
 * Clause 5.3.15 freshness, decided from the published bytes: NextUpdate has to
 * be later than the issue time and must not already have passed. It is recorded
 * rather than enforced here, because an expired list is a publishable fixture.
 */
function freshness(
  metadata: TrustedListMetadata,
  publishedAt: Date,
): { valid: boolean; findings: string[] } {
  const findings: string[] = [];
  const issued = Date.parse(metadata.issueDate);
  const next = Date.parse(metadata.nextUpdateDate);
  if (Number.isNaN(issued) || Number.isNaN(next)) {
    findings.push(
      `ListIssueDateTime '${metadata.issueDate}' or NextUpdate '${metadata.nextUpdateDate}' is not a readable instant.`,
    );
    return { valid: false, findings };
  }
  if (next <= issued)
    findings.push(
      `NextUpdate ${metadata.nextUpdateDate} is not later than ListIssueDateTime ${metadata.issueDate}.`,
    );
  if (next <= publishedAt.getTime())
    findings.push(
      `NextUpdate ${metadata.nextUpdateDate} has already passed at publication time.`,
    );
  return { valid: findings.length === 0, findings };
}

export function buildTrustedListManifest(
  input: BuildTrustedListManifestInput,
): TrustedListManifest {
  const xmlSha256 = sha256Hex(Buffer.from(input.xml, "utf-8"));
  const fresh = freshness(input.metadata, input.publishedAt);
  return {
    manifestVersion: TSL_MANIFEST_VERSION,
    standard: "TS 119 612",
    artifactFormat: "XML / XAdES-B-B",
    family: input.family,
    listKey: input.listKey,
    sequenceNumber: input.metadata.tslSequenceNumber,
    publicationTimestamp: input.publishedAt.toISOString(),
    trustedListXmlSha256: xmlSha256,
    trustedListSha2Published: input.sha2Override ?? xmlSha256,
    trustedList: input.metadata,
    trustedListMetadataSource: input.metadataSource ?? "published-bytes",
    serviceProfiles: {
      serviceProfilesPresent: [...input.metadata.serviceTypes],
      allowedServiceProfiles: [...(input.allowedServiceProfiles ?? [])],
    },
    signingCertificateFindings: [...(input.signingCertificateFindings ?? [])],
    freshnessValid: fresh.valid,
    freshnessFindings: fresh.findings,
    ...(input.fixture ? { fixture: input.fixture } : {}),
    schemaValid: input.schema.valid,
    schemaFindings: input.schema.findings.map(
      (finding) => `${finding.path}: ${finding.message}`,
    ),
    signatureValid: input.signature.valid,
    signatureFindings: [...input.signature.findings],
    signatureProfile: "XAdES-B-B",
    signatureAlgorithm: input.signature.signatureAlgorithm ?? "unknown",
    signingTime: input.signature.signingTime ?? "unknown",
    signingCertificateSha256: input.signer.fingerprint,
    certificateSubject: input.signer.subject,
    certificateIssuer: input.signer.issuer,
    certificateValidFrom: input.signer.validFrom,
    certificateValidTo: input.signer.validTo,
    signerTrustStatus: "not_evaluated",
  };
}
