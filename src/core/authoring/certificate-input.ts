import { X509Certificate } from "node:crypto";
import { publicKeyFingerprint } from "../model/x509-ski.js";

/**
 * Classification of whatever the applicant pasted into the Service Digital
 * Identity certificate field.
 *
 * ETSI TS 119 602 clause 6.6.3 lets a ServiceDigitalIdentity carry an X.509
 * certificate, a subject name, a public key value, a subject key identifier or
 * another identifier. This publisher only ever populates X509Certificates, so
 * the onboarding form accepts exactly one thing: an X.509 certificate encoded
 * as PEM. Everything else — the private key, a bare public key, a PKCS#10
 * request, a PKCS#12 bundle — is a different object and is rejected with a
 * message that names what was actually supplied.
 */
export type CertificateInputKind =
  | "certificate"
  | "private-key"
  | "public-key"
  | "certificate-request"
  | "pkcs12"
  | "unparseable-certificate"
  | "empty"
  | "unknown";

export interface CertificateInputClassification {
  kind: CertificateInputKind;
  /** Null only for `certificate`. */
  message: string | null;
  /** Present only for `certificate`. */
  certificate: X509Certificate | null;
}

const PEM_LABEL = /-----BEGIN ([A-Za-z0-9 #.-]+)-----/g;

/**
 * PEM labels this project recognises. A label not listed here is reported as
 * unknown content rather than guessed at.
 */
const LABEL_KINDS: ReadonlyArray<readonly [RegExp, CertificateInputKind]> = [
  // Covers PRIVATE KEY, RSA/EC/DSA PRIVATE KEY, ENCRYPTED PRIVATE KEY and
  // OPENSSH PRIVATE KEY.
  [/^(?:[A-Z0-9]+ )?PRIVATE KEY$/, "private-key"],
  [/^PGP PRIVATE KEY BLOCK$/, "private-key"],
  [/^(?:[A-Z0-9]+ )?PUBLIC KEY$/, "public-key"],
  [/^(?:NEW )?CERTIFICATE REQUEST$/, "certificate-request"],
  [/^PKCS ?#?12$/, "pkcs12"],
  [/^CERTIFICATE$/, "certificate"],
];

export const CERTIFICATE_INPUT_MESSAGES: Readonly<
  Record<Exclude<CertificateInputKind, "certificate">, string>
> = Object.freeze({
  empty: "Certificate is required.",
  "private-key": "This is a private key. Upload the X.509 certificate instead.",
  "public-key": "This is a public key, not an X.509 certificate.",
  "certificate-request":
    "This is a certificate-signing request, not a certificate.",
  pkcs12: "Convert or extract the certificate to PEM before uploading.",
  "unparseable-certificate":
    "This PEM block could not be parsed as an X.509 certificate.",
  unknown:
    "This is not an X.509 certificate in PEM form. Upload a certificate " +
    "beginning with -----BEGIN CERTIFICATE-----.",
});

/** DER object identifier 1.2.840.113549.1.7.1 (pkcs7-data), as it appears in a PFX. */
const PKCS7_DATA_OID = Buffer.from([
  0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x01,
]);

/**
 * A PKCS#12 PFX is SEQUENCE { version INTEGER (3), authSafe ContentInfo, ... }
 * and its authSafe always carries the pkcs7-data OID. Both are checked so a
 * plain DER certificate is not mistaken for a bundle.
 */
function looksLikePkcs12(der: Buffer): boolean {
  if (der.length < 32 || der[0] !== 0x30) return false;
  const versionAt = der.indexOf(Buffer.from([0x02, 0x01, 0x03]));
  if (versionAt < 0 || versionAt > 8) return false;
  return der.includes(PKCS7_DATA_OID);
}

/** Decodes base64 only when the text is base64 and nothing else. */
function decodeBase64(text: string): Buffer | null {
  const compact = text.replace(/\s+/g, "");
  if (compact.length < 32 || compact.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) return null;
  const decoded = Buffer.from(compact, "base64");
  return decoded.length > 0 ? decoded : null;
}

function labelKind(label: string): CertificateInputKind | null {
  const normalised = label.trim().toUpperCase();
  for (const [pattern, kind] of LABEL_KINDS)
    if (pattern.test(normalised)) return kind;
  return null;
}

/**
 * Classifies the pasted text. A private key anywhere in the input wins over a
 * certificate in the same input: a combined key-and-certificate file must be
 * refused outright rather than silently accepted, because the applicant is
 * never meant to send the private key.
 */
export function classifyCertificateInput(
  text: string,
): CertificateInputClassification {
  const value = text.trim();
  if (!value)
    return {
      kind: "empty",
      message: CERTIFICATE_INPUT_MESSAGES.empty,
      certificate: null,
    };

  const kinds: CertificateInputKind[] = [];
  const unrecognisedLabels: string[] = [];
  for (const match of value.matchAll(PEM_LABEL)) {
    const kind = labelKind(match[1] ?? "");
    if (kind) kinds.push(kind);
    else unrecognisedLabels.push(match[1] ?? "");
  }

  for (const kind of [
    "private-key",
    "certificate-request",
    "pkcs12",
  ] as const) {
    if (kinds.includes(kind))
      return {
        kind,
        message: CERTIFICATE_INPUT_MESSAGES[kind],
        certificate: null,
      };
  }

  if (kinds.includes("certificate")) {
    try {
      return {
        kind: "certificate",
        message: null,
        certificate: new X509Certificate(value),
      };
    } catch {
      return {
        kind: "unparseable-certificate",
        message: CERTIFICATE_INPUT_MESSAGES["unparseable-certificate"],
        certificate: null,
      };
    }
  }

  if (kinds.includes("public-key"))
    return {
      kind: "public-key",
      message: CERTIFICATE_INPUT_MESSAGES["public-key"],
      certificate: null,
    };

  if (unrecognisedLabels.length === 0) {
    const der = decodeBase64(value);
    if (der && looksLikePkcs12(der))
      return {
        kind: "pkcs12",
        message: CERTIFICATE_INPUT_MESSAGES.pkcs12,
        certificate: null,
      };
  }

  return {
    kind: "unknown",
    message: CERTIFICATE_INPUT_MESSAGES.unknown,
    certificate: null,
  };
}

const PEM_CERTIFICATE_BLOCK =
  /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;

/**
 * Splits the field value into its PEM certificate blocks. Annex H lets one
 * service publish more than one certificate — typically the attestation-signing
 * certificate and the CA certificate that issued it — so the field accepts
 * several concatenated blocks and each is validated on its own.
 */
export function splitPemCertificates(text: string): string[] {
  return [...text.matchAll(PEM_CERTIFICATE_BLOCK)].map((match) => match[0]);
}

/**
 * Annex H requires every certificate published for one service to represent the
 * same key and the same subject: they are renditions of one identity, not a
 * certification path. Returns null when the set is consistent, otherwise a
 * message naming what differs.
 */
export function checkCertificateSetConsistency(
  certificates: readonly X509Certificate[],
): string | null {
  const [first, ...rest] = certificates;
  if (!first) return null;
  const key = publicKeyFingerprint(first);
  const subject = first.subject;
  for (const certificate of rest) {
    if (publicKeyFingerprint(certificate) !== key)
      return (
        "All certificates supplied for one service must represent the same " +
        "public key. Supply the attestation-signing certificate, or the CA " +
        "certificate that issued it, but not two different keys."
      );
    if (certificate.subject !== subject)
      return (
        "All certificates supplied for one service must have an identical " +
        `subject. Found "${subject.split("\n").join(", ")}" and ` +
        `"${certificate.subject.split("\n").join(", ")}".`
      );
  }
  return null;
}

/** Reads one relative distinguished name from a Node subject/issuer string. */
function rdn(distinguishedName: string, attribute: string): string | null {
  for (const line of distinguishedName.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.toUpperCase().startsWith(`${attribute}=`))
      return trimmed.slice(attribute.length + 1).trim();
  }
  return null;
}

/**
 * The certificate subject has to identify the provider, so its organisation
 * must be the Trusted Entity Name (TEName, clause 6.4.1) the applicant entered.
 * Returns null when it matches, otherwise a message naming both values.
 */
export function checkCertificateSubjectOrganisation(
  certificate: X509Certificate,
  trustedEntityName: string,
): string | null {
  const expected = trustedEntityName.trim();
  if (!expected) return null;
  const organisation = rdn(certificate.subject, "O");
  if (organisation === null)
    return (
      `The certificate subject (${certificate.subject.split("\n").join(", ")}) ` +
      `has no organisation (O). Set O to exactly the Trusted Entity Name ` +
      `"${expected}".`
    );
  if (organisation !== expected)
    return (
      `The certificate subject organisation (O) is "${organisation}", but the ` +
      `Trusted Entity Name is "${expected}". Set O to exactly the Trusted ` +
      `Entity Name.`
    );
  return null;
}
