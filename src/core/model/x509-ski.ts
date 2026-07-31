import { createHash, X509Certificate } from "node:crypto";
import {
  readCertificateExtension,
  readDerElement,
  readDerSequence,
} from "./x509-extensions.js";

/**
 * Subject key identifiers for the Annex H ServiceHistory, where the superseded
 * state is published by key identifier rather than by certificate.
 *
 * Node's X509Certificate does not expose the SubjectKeyIdentifier extension, so
 * the certificate is read here. The extension is preferred when present, because
 * a reader that already holds the certificate matches the value it carries; when
 * it is absent the identifier is derived by RFC 5280 clause 4.2.1.2 method (1),
 * the SHA-1 of the subject public key BIT STRING contents.
 *
 * The DER walk is deliberately minimal: it only descends the path a certificate
 * always has, and any structure it does not recognise makes it fall back rather
 * than guess.
 */

/** DER tags this reader distinguishes. */
const TAG_BIT_STRING = 0x03;
const TAG_OCTET_STRING = 0x04;
const TAG_SEQUENCE = 0x30;

/** id-ce-subjectKeyIdentifier, 2.5.29.14. */
const OID_SUBJECT_KEY_IDENTIFIER = Buffer.from([0x55, 0x1d, 0x0e]);

/**
 * Returns the contents of the SubjectKeyIdentifier extension, or null when the
 * certificate does not carry one.
 */
function subjectKeyIdentifierExtension(
  certificate: X509Certificate,
): Buffer | null {
  const extension = readCertificateExtension(
    certificate,
    OID_SUBJECT_KEY_IDENTIFIER,
  );
  if (!extension) return null;
  const identifier = readDerElement(extension.value, 0);
  if (!identifier || identifier.tag !== TAG_OCTET_STRING) return null;
  return identifier.contents;
}

/** SHA-1 of the subject public key BIT STRING contents (RFC 5280 method 1). */
function derivedKeyIdentifier(certificate: X509Certificate): Buffer | null {
  const spki = certificate.publicKey.export({ format: "der", type: "spki" });
  const sequence = readDerElement(spki, 0);
  if (!sequence || sequence.tag !== TAG_SEQUENCE) return null;
  const bitString = readDerSequence(sequence.contents).find(
    (element) => element.tag === TAG_BIT_STRING,
  );
  if (!bitString || bitString.contents.length < 2) return null;
  /* The first contents octet counts unused bits; a public key never has any. */
  return createHash("sha1").update(bitString.contents.subarray(1)).digest();
}

/**
 * The certificate's subject key identifier, base64-encoded, as the pinned schema
 * declares `X509SKI`. Throws when neither source yields one, because publishing
 * a history entry with no key identifier would breach the Annex H rule that the
 * history states at least the key.
 */
export function subjectKeyIdentifierBase64(certificate: string): string {
  /*
    The authoring model holds certificates as Base64 DER (clause 6.6.3), and
    Node's X509Certificate reads PEM text or DER bytes, so bare Base64 is
    decoded here rather than re-armoured.
  */
  const parsed = new X509Certificate(
    certificate.includes("-----BEGIN")
      ? certificate
      : Buffer.from(certificate, "base64"),
  );
  const fromExtension = subjectKeyIdentifierExtension(parsed);
  const identifier = fromExtension ?? derivedKeyIdentifier(parsed);
  if (!identifier || identifier.length === 0)
    throw new Error(
      "Certificate has no SubjectKeyIdentifier extension and no key identifier could be derived from its public key.",
    );
  return identifier.toString("base64");
}

/** SHA-256 of the subject public key, used to compare two certificates' keys. */
export function publicKeyFingerprint(certificate: X509Certificate): string {
  return createHash("sha256")
    .update(certificate.publicKey.export({ format: "der", type: "spki" }))
    .digest("hex");
}
