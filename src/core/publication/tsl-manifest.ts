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
  readonly trustedList: TrustedListMetadata;
  readonly schemaValid: boolean;
  readonly schemaFindings: readonly string[];
  readonly signatureValid: boolean;
  readonly signatureFindings: readonly string[];
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
}

export function buildTrustedListManifest(
  input: BuildTrustedListManifestInput,
): TrustedListManifest {
  return {
    manifestVersion: TSL_MANIFEST_VERSION,
    standard: "TS 119 612",
    artifactFormat: "XML / XAdES-B-B",
    family: input.family,
    listKey: input.listKey,
    sequenceNumber: input.metadata.tslSequenceNumber,
    publicationTimestamp: input.publishedAt.toISOString(),
    trustedListXmlSha256: sha256Hex(Buffer.from(input.xml, "utf-8")),
    trustedList: input.metadata,
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
