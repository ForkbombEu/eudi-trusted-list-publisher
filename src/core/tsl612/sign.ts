/**
 * Signing and verifying a TS 119 612 Trusted List.
 *
 * The XAdES machinery lives in `src/xmlsec`, which knows nothing about Trusted
 * Lists. This module is the join: it applies the Scheme Operator certificate
 * profile, signs, and then validates the *signed* document against the pinned
 * schemas — a signature is part of the document, so a list that only schema-
 * validates before signing has not been checked.
 */
import { X509Certificate } from "node:crypto";
import {
  signEnveloped,
  verifyEnveloped,
  type VerifyResult,
} from "../../xmlsec/index.js";
import { validateTslXml } from "./schema.js";
import {
  checkTrustedListSigningCertificate,
  type SigningCertificateExpectation,
} from "./signing-certificate.js";
import type { ValidationResult } from "../validate/validate.js";

export class TslSigningError extends Error {
  constructor(
    message: string,
    readonly findings: readonly string[] = [],
  ) {
    super(message);
    this.name = "TslSigningError";
  }
}

export interface SignTrustedListOptions {
  readonly privateKeyPem: string;
  readonly certificatePem: string;
  /** The list's own values, which the certificate subject has to match. */
  readonly expectation: SigningCertificateExpectation;
  readonly signingTime?: Date;
}

export interface SignedTrustedList {
  readonly xml: string;
  readonly schema: ValidationResult;
  readonly signature: VerifyResult;
  readonly signingCertificate: {
    readonly subject: string;
    readonly issuer: string;
    readonly validFrom: string;
    readonly validTo: string;
    readonly fingerprintSha256: string;
  };
}

/**
 * Signs a compiled Trusted List.
 *
 * Refuses before signing when the certificate does not meet the profile, and
 * refuses after signing when the result does not schema-validate or does not
 * verify. Nothing that fails a check is returned: the only way to get an XML
 * document out of here is for every check to have passed.
 */
export function signTrustedList(
  xml: string,
  options: SignTrustedListOptions,
): SignedTrustedList {
  let certificate: X509Certificate;
  try {
    certificate = new X509Certificate(options.certificatePem);
  } catch (error) {
    throw new TslSigningError(
      `The Trusted List signing certificate does not parse: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const profileFindings = checkTrustedListSigningCertificate(
    certificate,
    options.expectation,
  );
  if (profileFindings.length > 0)
    throw new TslSigningError(
      "The Trusted List signing certificate does not meet the TS 119 612 Scheme Operator profile.",
      profileFindings,
    );

  const signed = signEnveloped(xml, {
    privateKeyPem: options.privateKeyPem,
    certificatePem: options.certificatePem,
    ...(options.signingTime ? { signingTime: options.signingTime } : {}),
  });

  const schema = validateTslXml(signed);
  if (!schema.valid)
    throw new TslSigningError(
      "The signed Trusted List does not validate against the pinned TS 119 612 schemas.",
      schema.findings.map((finding) => `${finding.path}: ${finding.message}`),
    );

  const signature = verifyEnveloped(signed);
  if (!signature.valid)
    throw new TslSigningError(
      "The Trusted List signature does not verify locally.",
      signature.findings,
    );

  return {
    xml: signed,
    schema,
    signature,
    signingCertificate: {
      subject: certificate.subject,
      issuer: certificate.issuer,
      validFrom: certificate.validFrom,
      validTo: certificate.validTo,
      fingerprintSha256: certificate.fingerprint256
        .replace(/:/g, "")
        .toLowerCase(),
    },
  };
}

export interface TrustedListVerification {
  readonly valid: boolean;
  readonly schema: ValidationResult;
  readonly signature: VerifyResult;
}

/**
 * Verifies a published Trusted List from its bytes alone: schema first, then
 * signature. Never throws — a caller checking an artifact wants findings.
 */
export function verifyTrustedList(xml: string): TrustedListVerification {
  const schema = validateTslXml(xml);
  const signature = verifyEnveloped(xml);
  return { valid: schema.valid && signature.valid, schema, signature };
}
