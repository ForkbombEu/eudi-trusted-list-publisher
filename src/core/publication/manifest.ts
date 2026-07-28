import { createHash, X509Certificate } from "node:crypto";
import { verify as verifyJades } from "../verification/verification.js";
import { validateEtsiStruct } from "../validate/validate.js";
import type { LoTEDocument } from "../model/types.js";

export interface PublicationInput {
  compactJws: string;
  certificatePem: string;
  clock?: Date;
}

export interface SignerInfo {
  subject: string;
  issuer: string;
  validFrom: string;
  validTo: string;
  fingerprint: string;
}

export interface Manifest {
  manifestVersion: number;
  listKey: string;
  loteIdentifier: string;
  sequenceNumber: number;
  issueDate: string;
  nextUpdateDate: string;
  loteType: string;
  schemeOperatorName: string;
  territory: string;
  publicationTimestamp: string;
  compactJadesSha256: string;
  loteJsonSha256: string;
  signingCertificateSha256: string;
  certificateSubject: string;
  certificateIssuer: string;
  certificateValidFrom: string;
  certificateValidTo: string;
  signatureValid: boolean;
  etsiSchemaValid: boolean;
  signerTrustStatus: "not_evaluated";
}

export interface PublicationResult {
  listKey: string;
  sequenceNumber: number;
  manifest: Manifest;
  loteJson: string;
}

function deriveListKey(document: LoTEDocument): string {
  const info = document.LoTE.ListAndSchemeInformation;
  const territory = info.SchemeTerritory ?? "XX";
  const opName =
    info.SchemeOperatorName[0]?.value?.replace(/[^a-zA-Z0-9_-]/g, "_") ??
    "unknown";
  const safeOpName = opName.slice(0, 40);
  return `${territory}_${safeOpName}`.toLowerCase();
}

function getSignerInfo(certPem: string): SignerInfo {
  const cert = new X509Certificate(certPem);
  return {
    subject: cert.subject.replace(/\n/g, ", "),
    issuer: cert.issuer.replace(/\n/g, ", "),
    validFrom: cert.validFrom,
    validTo: cert.validTo,
    fingerprint: cert.fingerprint256.replace(/:/g, "").toLowerCase(),
  };
}

function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export class PublicationError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "PublicationError";
  }
}

export async function publish(
  input: PublicationInput,
): Promise<PublicationResult> {
  const now = input.clock ?? new Date();

  // Reject WE BUILD detached format
  const trimmed = input.compactJws.trim();
  if (trimmed.startsWith("{")) {
    throw new PublicationError(
      "WE BUILD detached format is not supported. Use Compact JAdES serialization.",
      "DETACHED_FORMAT",
    );
  }

  // Must be compact JWS (exactly 3 base64url segments separated by dots)
  const parts = trimmed.split(".");
  if (parts.length !== 3) {
    throw new PublicationError(
      "Input is not a valid Compact JAdES serialization",
      "INVALID_FORMAT",
    );
  }

  const compactJadesSha256 = sha256(trimmed);

  const verifyResult = await verifyJades({
    compactJws: trimmed,
    certificatePem: input.certificatePem,
    clock: input.clock,
  });

  if (!verifyResult.payload) {
    throw new PublicationError(
      "Failed to parse signed payload as valid JSON",
      "INVALID_PAYLOAD",
    );
  }

  if (!verifyResult.valid) {
    const reasons = verifyResult.findings
      .map((f) => `${f.code}: ${f.message}`)
      .join("; ");
    throw new PublicationError(
      `Signature verification failed: ${reasons}`,
      "SIGNATURE_INVALID",
    );
  }

  const signer = getSignerInfo(input.certificatePem);

  const certValidFrom = new Date(signer.validFrom);
  const certValidTo = new Date(signer.validTo);

  if (now < certValidFrom) {
    throw new PublicationError(
      `Certificate is not yet valid (valid from ${signer.validFrom})`,
      "CERT_NOT_YET_VALID",
    );
  }

  if (now > certValidTo) {
    throw new PublicationError(
      `Certificate has expired (valid to ${signer.validTo})`,
      "CERT_EXPIRED",
    );
  }

  const document = verifyResult.payload;
  const loteJson = JSON.stringify(document);
  const loteJsonSha256 = sha256(loteJson);

  const etsiResult = await validateEtsiStruct(document);

  if (!etsiResult.valid) {
    const reasons = etsiResult.findings
      .map((f) => `${f.path}: ${f.message}`)
      .join("; ");
    throw new PublicationError(
      `ETSI schema validation failed: ${reasons}`,
      "ETSI_SCHEMA_INVALID",
    );
  }

  const info = document.LoTE.ListAndSchemeInformation;
  const listKey = deriveListKey(document);

  const schemeOpName = info.SchemeOperatorName.map(
    (n) => `${n.lang}:${n.value}`,
  ).join("; ");

  const manifest: Manifest = {
    manifestVersion: 1,
    listKey,
    loteIdentifier: info.LoTEType ?? "unknown",
    sequenceNumber: info.LoTESequenceNumber,
    issueDate: info.ListIssueDateTime,
    nextUpdateDate: info.NextUpdate,
    loteType: info.LoTEType ?? "unknown",
    schemeOperatorName: schemeOpName,
    territory: info.SchemeTerritory ?? "unknown",
    publicationTimestamp: now.toISOString(),
    compactJadesSha256,
    loteJsonSha256,
    signingCertificateSha256: signer.fingerprint,
    certificateSubject: signer.subject,
    certificateIssuer: signer.issuer,
    certificateValidFrom: signer.validFrom,
    certificateValidTo: signer.validTo,
    signatureValid: true,
    etsiSchemaValid: true,
    signerTrustStatus: "not_evaluated",
  };

  return {
    listKey,
    sequenceNumber: info.LoTESequenceNumber,
    manifest,
    loteJson,
  };
}
