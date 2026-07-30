import type { LoTEDocument } from "../model/types.js";
import * as jose from "jose";
import { createHash, X509Certificate } from "node:crypto";

export interface SignInput {
  document: LoTEDocument;
  key: globalThis.CryptoKey;
  certificatePem: string;
  /** Claimed signing time; defaults to now. */
  signingTime?: Date;
}

export interface SignedLoTE {
  compact: string;
  document: LoTEDocument;
  certificateChain: string[];
}

function validateX5cParams(certPem: string): {
  certB64: string;
  certChain: string[];
} {
  const cert = new X509Certificate(certPem);
  if (!cert.publicKey) {
    throw new Error("Certificate has no extractable public key");
  }

  // Convert PEM to DER, then base64 encode (RFC 7515 §4.1.11)
  const derPem = certPem.replace(/-----[^-]+-----/g, "").replace(/\s/g, "");
  const derBytes = Buffer.from(derPem, "base64");
  const certB64 = derBytes.toString("base64");
  const certChain = [certB64];

  return { certB64, certChain };
}

export async function sign(input: SignInput): Promise<SignedLoTE> {
  const payload = new TextEncoder().encode(JSON.stringify(input.document));
  const { certChain } = validateX5cParams(input.certificatePem);

  /*
    JAdES Baseline B requires the claimed signing time in the protected header
    as an integer NumericDate (TS 119 182-1 clause 5.2.1). Without `iat` the
    signature does not satisfy the profile, whatever else is present.
  */
  const iat = Math.floor((input.signingTime ?? new Date()).getTime() / 1000);

  const jws = await new jose.CompactSign(payload)
    .setProtectedHeader({
      alg: "ES256",
      x5c: certChain,
      typ: "JAdES",
      iat,
    })
    .sign(input.key);

  return {
    compact: jws,
    document: input.document,
    certificateChain: certChain,
  };
}

export async function serializeSignedLoTE(signed: SignedLoTE): Promise<string> {
  const parts = signed.compact.split(".");
  if (parts.length !== 3) {
    throw new Error("Invalid JWS compact serialization");
  }
  return JSON.stringify(
    {
      LoTE: signed.document.LoTE,
      signature: {
        protected: parts[0],
        signature: parts[2],
      },
    },
    null,
    2,
  );
}

export function serializeCompactJAdES(signed: SignedLoTE): string {
  return signed.compact;
}

export function certificateFingerprint(certPem: string): string {
  return createHash("sha256").update(Buffer.from(certPem)).digest("hex");
}
