import * as jose from "jose";
import { X509Certificate, createPublicKey } from "node:crypto";
import type { LoTEDocument } from "../model/types.js";

export interface VerificationInput {
  compactJws: string;
  certificatePem?: string;
  trustedCertificates?: string[];
  clock?: Date;
}

export interface VerificationResult {
  valid: boolean;
  findings: VerificationFinding[];
  payload?: LoTEDocument;
}

export interface VerificationFinding {
  code: string;
  message: string;
}

function pemToCert(pem: string): X509Certificate {
  return new X509Certificate(pem);
}

function pemToPublicKey(pem: string): Promise<globalThis.CryptoKey> {
  const key = createPublicKey(pem);
  return crypto.subtle.importKey(
    "spki",
    key.export({ type: "spki", format: "der" }),
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["verify"],
  ) as Promise<globalThis.CryptoKey>;
}

export async function verify(
  input: VerificationInput,
): Promise<VerificationResult> {
  const findings: VerificationFinding[] = [];

  // Parse the compact JWS
  const parts = input.compactJws.split(".");
  if (parts.length !== 3) {
    return {
      valid: false,
      findings: [
        { code: "INVALID_FORMAT", message: "Not a valid Compact JWS" },
      ],
    };
  }

  // Decode protected header
  let protectedHeader: Record<string, unknown>;
  try {
    protectedHeader = JSON.parse(
      new TextDecoder().decode(Buffer.from(parts[0]!, "base64url")),
    );
  } catch {
    return {
      valid: false,
      findings: [
        {
          code: "INVALID_HEADER",
          message: "Protected header is not valid JSON",
        },
      ],
    };
  }

  // Check algorithm
  const alg = protectedHeader["alg"];
  if (!alg) {
    findings.push({
      code: "MISSING_ALG",
      message: "Protected header must include 'alg'",
    });
  }

  const allowedAlgs = ["ES256", "ES384", "ES512"];
  if (typeof alg === "string" && !allowedAlgs.includes(alg)) {
    findings.push({
      code: "DISALLOWED_ALG",
      message: `Algorithm '${alg}' is not an allowed ECDSA algorithm. Allowed: ${allowedAlgs.join(", ")}`,
    });
  }

  // Check x5c
  if (!protectedHeader["x5c"]) {
    findings.push({
      code: "MISSING_X5C",
      message: "JAdES requires x5c certificate chain in header",
    });
  }

  // Check typ (advisory)
  if (protectedHeader["typ"] && protectedHeader["typ"] !== "JAdES") {
    findings.push({
      code: "UNEXPECTED_TYP",
      message: `typ header should be 'JAdES' for JAdES signatures, got '${String(protectedHeader["typ"])}'`,
    });
  }

  // Verify payload is valid JSON
  let payload: LoTEDocument | undefined;
  try {
    const payloadStr = new TextDecoder().decode(
      Buffer.from(parts[1]!, "base64url"),
    );
    payload = JSON.parse(payloadStr);
  } catch {
    findings.push({
      code: "INVALID_PAYLOAD",
      message: "Payload is not valid JSON",
    });
  }

  // Decode certificate from x5c
  let certPem: string | null = null;
  if (
    Array.isArray(protectedHeader["x5c"]) &&
    protectedHeader["x5c"].length > 0
  ) {
    const certB64 = protectedHeader["x5c"][0] as string;
    try {
      const derBytes = Buffer.from(certB64, "base64");
      const derB64 = derBytes.toString("base64");
      const wrapped = derB64.match(/.{1,64}/g)?.join("\n") ?? derB64;
      certPem =
        "-----BEGIN CERTIFICATE-----\n" +
        wrapped +
        "\n-----END CERTIFICATE-----";
      const testCert = new X509Certificate(certPem);
      if (!testCert) {
        certPem = null;
      }
    } catch {
      // Try as PEM directly
      if (certB64.includes("-----BEGIN CERTIFICATE-----")) {
        certPem = certB64;
      } else {
        certPem = null;
      }
    }
  }

  if (input.certificatePem && certPem) {
    try {
      const providedCert = pemToCert(input.certificatePem);
      const headerCert = pemToCert(certPem);
      if (providedCert.fingerprint256 !== headerCert.fingerprint256) {
        findings.push({
          code: "CERT_MISMATCH",
          message:
            "Certificate in x5c header does not match the provided certificate",
        });
      }
    } catch {
      findings.push({
        code: "CERT_PARSE_ERROR",
        message: "Could not parse one or both certificates",
      });
    }
  }

  // Verify signature cryptographically
  if (certPem && alg) {
    try {
      const publicKey = await pemToPublicKey(certPem);
      const { payload: verifiedPayload } = await jose.compactVerify(
        input.compactJws,
        publicKey,
      );

      const payloadStr = new TextDecoder().decode(verifiedPayload);
      try {
        payload = JSON.parse(payloadStr) as LoTEDocument;
      } catch {
        // payload already set above if valid
      }
    } catch (e) {
      findings.push({
        code: "SIGNATURE_INVALID",
        message: `Signature verification failed: ${e instanceof Error ? e.message : "unknown error"}`,
      });
    }
  } else if (!certPem) {
    findings.push({
      code: "NO_CERT",
      message: "No certificate found to verify signature",
    });
  }

  // Check certificate validity period
  if (certPem) {
    try {
      const cert = pemToCert(certPem);
      const now = input.clock ?? new Date();
      const validFrom = new Date(cert.validFrom);
      const validTo = new Date(cert.validTo);
      if (now < validFrom) {
        findings.push({
          code: "CERT_NOT_YET_VALID",
          message: `Certificate is not yet valid (valid from ${cert.validFrom})`,
        });
      }
      if (now > validTo) {
        findings.push({
          code: "CERT_EXPIRED",
          message: `Certificate expired on ${cert.validTo}`,
        });
      }
    } catch {
      findings.push({
        code: "CERT_PARSE_ERROR",
        message: "Could not parse certificate for validity check",
      });
    }
  }

  const valid = findings.length === 0;

  return { valid, findings, payload: payload };
}
