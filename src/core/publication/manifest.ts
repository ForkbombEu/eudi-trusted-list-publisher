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

export async function publish(
  input: PublicationInput,
): Promise<PublicationResult> {
  const now = input.clock ?? new Date();

  const compactJadesSha256 = sha256(input.compactJws);

  const verifyResult = await verifyJades({
    compactJws: input.compactJws,
    certificatePem: input.certificatePem,
  });

  if (!verifyResult.payload) {
    throw new Error("Failed to parse signed payload");
  }

  const document = verifyResult.payload;
  const loteJson = JSON.stringify(document);
  const loteJsonSha256 = sha256(loteJson);

  const etsiResult = await validateEtsiStruct(document);

  const signer = getSignerInfo(input.certificatePem);

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
    signatureValid: verifyResult.valid,
    etsiSchemaValid: etsiResult.valid,
    signerTrustStatus: "not_evaluated",
  };

  return {
    listKey,
    sequenceNumber: info.LoTESequenceNumber,
    manifest,
  };
}
