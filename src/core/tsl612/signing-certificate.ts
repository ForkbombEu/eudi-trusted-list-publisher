/**
 * The certificate profile a Trusted List Scheme Operator's signing certificate
 * has to meet, per TS 119 612 clause 5.7 and Annex B.
 *
 * These are properties of the operator's own signing material, not of the
 * generated document, so they are checked where the material is configured and
 * again before a list is signed with it. Nothing here builds a certification
 * path or checks revocation: the question is whether this certificate is
 * *shaped* like a Trusted List signing certificate, not whether anyone trusts
 * it.
 */
import { X509Certificate } from "node:crypto";
import {
  readCertificateExtension,
  readDerElement,
  readDerSequence,
} from "../model/x509-extensions.js";

const TAG_BIT_STRING = 0x03;
const TAG_BOOLEAN = 0x01;
const TAG_OCTET_STRING = 0x04;
const TAG_OID = 0x06;
const TAG_SEQUENCE = 0x30;

const OID_BASIC_CONSTRAINTS = Buffer.from([0x55, 0x1d, 0x13]);
const OID_KEY_USAGE = Buffer.from([0x55, 0x1d, 0x0f]);
const OID_SUBJECT_KEY_IDENTIFIER = Buffer.from([0x55, 0x1d, 0x0e]);
const OID_EXTENDED_KEY_USAGE = Buffer.from([0x55, 0x1d, 0x25]);

/** id-tsl-kp-tslSigning, 0.4.0.2231.3.0 — the EKU for signing a Trusted List. */
const OID_TSL_SIGNING = Buffer.from([0x04, 0x00, 0x91, 0x37, 0x03, 0x00]);
/** anyExtendedKeyUsage, 2.5.29.37.0. */
const OID_ANY_EXTENDED_KEY_USAGE = Buffer.from([0x55, 0x1d, 0x25, 0x00]);

/** KeyUsage bit 0 and bit 1 of RFC 5280 clause 4.2.1.3. */
const KEY_USAGE_DIGITAL_SIGNATURE = 0x80;
const KEY_USAGE_CONTENT_COMMITMENT = 0x40;

const KEY_USAGE_NAMES: readonly string[] = [
  "digitalSignature",
  "contentCommitment",
  "keyEncipherment",
  "dataEncipherment",
  "keyAgreement",
  "keyCertSign",
  "cRLSign",
  "encipherOnly",
];

export interface SigningCertificateExpectation {
  /** The list's SchemeTerritory; the subject `C` must equal it. */
  readonly schemeTerritory: string;
  /** The list's SchemeOperatorName; the subject `O` must equal it. */
  readonly schemeOperatorName: string;
}

/** One relative distinguished name of a subject, or null when absent. */
function rdn(subject: string, key: string): string | null {
  for (const line of subject.split("\n")) {
    const at = line.indexOf("=");
    if (at === -1) continue;
    if (line.slice(0, at).trim() === key) return line.slice(at + 1).trim();
  }
  return null;
}

function keyUsageNames(bits: Buffer): string[] {
  const names: string[] = [];
  for (let index = 0; index < KEY_USAGE_NAMES.length; index += 1) {
    const byte = bits[Math.floor(index / 8)];
    if (byte === undefined) break;
    if (byte & (0x80 >> (index % 8))) names.push(KEY_USAGE_NAMES[index]!);
  }
  return names;
}

/**
 * Every way the certificate fails the profile, in the order the clauses are
 * written. All of them are reported at once: an operator fixing signing
 * material wants the whole list, not one failure per attempt.
 */
export function checkTrustedListSigningCertificate(
  certificate: X509Certificate,
  expectation: SigningCertificateExpectation,
): string[] {
  const findings: string[] = [];

  const country = rdn(certificate.subject, "C");
  if (country !== expectation.schemeTerritory)
    findings.push(
      `The signing certificate subject country (C) is ${
        country === null ? "absent" : `"${country}"`
      }, but the Scheme Territory is "${expectation.schemeTerritory}". They must be equal.`,
    );

  const organisation = rdn(certificate.subject, "O");
  if (organisation !== expectation.schemeOperatorName)
    findings.push(
      `The signing certificate subject organisation (O) is ${
        organisation === null ? "absent" : `"${organisation}"`
      }, but the Scheme Operator Name is "${expectation.schemeOperatorName}". They must be equal.`,
    );

  /*
    basicConstraints must state CA:FALSE. A Trusted List is signed by an end
    entity: a CA certificate here would mean the scheme operator signs lists
    with the same key it certifies others with.
  */
  const basicConstraints = readCertificateExtension(
    certificate,
    OID_BASIC_CONSTRAINTS,
  );
  if (basicConstraints) {
    const encoded = readDerElement(basicConstraints.value, 0);
    const ca =
      encoded?.tag === TAG_SEQUENCE
        ? readDerSequence(encoded.contents)[0]
        : null;
    /* An absent CA member defaults to FALSE, which is what the profile wants. */
    if (
      ca &&
      ca.tag === TAG_BOOLEAN &&
      ca.contents.length === 1 &&
      ca.contents[0] !== 0
    )
      findings.push(
        "The signing certificate asserts basicConstraints CA:TRUE. A Trusted List signing certificate must state CA:FALSE.",
      );
  }

  const subjectKeyIdentifier = readCertificateExtension(
    certificate,
    OID_SUBJECT_KEY_IDENTIFIER,
  );
  const identifier = subjectKeyIdentifier
    ? readDerElement(subjectKeyIdentifier.value, 0)
    : null;
  if (
    !identifier ||
    identifier.tag !== TAG_OCTET_STRING ||
    identifier.contents.length === 0
  )
    findings.push(
      "The signing certificate must carry a SubjectKeyIdentifier, so a reader can match it to the key that signed the list.",
    );

  const keyUsage = readCertificateExtension(certificate, OID_KEY_USAGE);
  if (!keyUsage) {
    findings.push(
      "The signing certificate must carry a keyUsage extension asserting digitalSignature and/or contentCommitment.",
    );
  } else {
    const bits = readDerElement(keyUsage.value, 0);
    if (!bits || bits.tag !== TAG_BIT_STRING || bits.contents.length < 2) {
      findings.push("The signing certificate keyUsage extension is malformed.");
    } else {
      /* The first contents octet counts unused bits in the final octet. */
      const usage = bits.contents.subarray(1);
      const asserted = keyUsageNames(usage);
      const permitted =
        (usage[0]! &
          ~(KEY_USAGE_DIGITAL_SIGNATURE | KEY_USAGE_CONTENT_COMMITMENT)) ===
          0 && usage.subarray(1).every((byte) => byte === 0);
      if (asserted.length === 0)
        findings.push(
          "The signing certificate keyUsage asserts nothing. It must assert digitalSignature and/or contentCommitment.",
        );
      else if (!permitted)
        findings.push(
          `The signing certificate keyUsage asserts ${asserted.join(
            ", ",
          )}. A Trusted List signing certificate may assert only digitalSignature and/or contentCommitment.`,
        );
    }
  }

  /*
    Extended key usage is optional. When it is present it has to permit signing
    a Trusted List, otherwise the certificate contradicts the use it is being
    put to.
  */
  const extendedKeyUsage = readCertificateExtension(
    certificate,
    OID_EXTENDED_KEY_USAGE,
  );
  if (extendedKeyUsage) {
    const sequence = readDerElement(extendedKeyUsage.value, 0);
    const purposes =
      sequence?.tag === TAG_SEQUENCE ? readDerSequence(sequence.contents) : [];
    const supportsTslSigning = purposes.some(
      (purpose) =>
        purpose.tag === TAG_OID &&
        (purpose.contents.equals(OID_TSL_SIGNING) ||
          purpose.contents.equals(OID_ANY_EXTENDED_KEY_USAGE)),
    );
    if (!supportsTslSigning)
      findings.push(
        "The signing certificate has an extendedKeyUsage that does not include tslSigning (0.4.0.2231.3.0) or anyExtendedKeyUsage, so it is not usable for signing a Trusted List.",
      );
  }

  return findings;
}

/** Parses a PEM certificate and applies the profile. */
export function checkTrustedListSigningCertificatePem(
  certificatePem: string,
  expectation: SigningCertificateExpectation,
): string[] {
  let certificate: X509Certificate;
  try {
    certificate = new X509Certificate(certificatePem);
  } catch (error) {
    return [
      `The signing certificate does not parse: ${
        error instanceof Error ? error.message : String(error)
      }`,
    ];
  }
  return checkTrustedListSigningCertificate(certificate, expectation);
}
