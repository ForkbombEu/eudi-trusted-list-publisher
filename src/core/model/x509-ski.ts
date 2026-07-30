import { createHash, X509Certificate } from "node:crypto";

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
const TAG_OID = 0x06;
const TAG_SEQUENCE = 0x30;
/** [3] EXPLICIT — the extensions member of TBSCertificate. */
const TAG_EXTENSIONS = 0xa3;

/** id-ce-subjectKeyIdentifier, 2.5.29.14. */
const OID_SUBJECT_KEY_IDENTIFIER = Buffer.from([0x55, 0x1d, 0x0e]);

interface DerElement {
  tag: number;
  /** Contents, excluding tag and length. */
  contents: Buffer;
  /** Offset just past this element in its parent. */
  end: number;
}

/** Reads one DER element at `offset`, or null when the encoding is unusable. */
function readElement(der: Buffer, offset: number): DerElement | null {
  if (offset + 2 > der.length) return null;
  const tag = der[offset]!;
  const first = der[offset + 1]!;
  let length = first;
  let contentsAt = offset + 2;
  if (first & 0x80) {
    const lengthBytes = first & 0x7f;
    // Indefinite length and lengths beyond four bytes never occur in DER certificates.
    if (lengthBytes === 0 || lengthBytes > 4) return null;
    if (offset + 2 + lengthBytes > der.length) return null;
    length = 0;
    for (let index = 0; index < lengthBytes; index += 1)
      length = length * 256 + der[offset + 2 + index]!;
    contentsAt = offset + 2 + lengthBytes;
  }
  const end = contentsAt + length;
  if (end > der.length) return null;
  return { tag, contents: der.subarray(contentsAt, end), end };
}

/** Reads the elements of a constructed element's contents, in order. */
function readSequence(contents: Buffer): DerElement[] {
  const elements: DerElement[] = [];
  let offset = 0;
  while (offset < contents.length) {
    const element = readElement(contents, offset);
    if (!element) break;
    elements.push(element);
    offset = element.end;
  }
  return elements;
}

/**
 * Returns the contents of the SubjectKeyIdentifier extension, or null when the
 * certificate does not carry one.
 */
function subjectKeyIdentifierExtension(der: Buffer): Buffer | null {
  const certificate = readElement(der, 0);
  if (!certificate || certificate.tag !== TAG_SEQUENCE) return null;
  const tbs = readElement(certificate.contents, 0);
  if (!tbs || tbs.tag !== TAG_SEQUENCE) return null;
  const extensionsMember = readSequence(tbs.contents).find(
    (element) => element.tag === TAG_EXTENSIONS,
  );
  if (!extensionsMember) return null;
  const extensions = readElement(extensionsMember.contents, 0);
  if (!extensions || extensions.tag !== TAG_SEQUENCE) return null;
  for (const extension of readSequence(extensions.contents)) {
    if (extension.tag !== TAG_SEQUENCE) continue;
    const parts = readSequence(extension.contents);
    const oid = parts[0];
    if (!oid || oid.tag !== TAG_OID) continue;
    if (!oid.contents.equals(OID_SUBJECT_KEY_IDENTIFIER)) continue;
    /*
      Extension ::= SEQUENCE { extnID, critical BOOLEAN DEFAULT FALSE,
      extnValue OCTET STRING }, so extnValue is always the last member whether
      or not the optional criticality flag is encoded.
    */
    const value = parts[parts.length - 1];
    if (!value || value.tag !== TAG_OCTET_STRING) return null;
    /* extnValue wraps the KeyIdentifier, itself an OCTET STRING. */
    const identifier = readElement(value.contents, 0);
    if (!identifier || identifier.tag !== TAG_OCTET_STRING) return null;
    return identifier.contents;
  }
  return null;
}

/** SHA-1 of the subject public key BIT STRING contents (RFC 5280 method 1). */
function derivedKeyIdentifier(certificate: X509Certificate): Buffer | null {
  const spki = certificate.publicKey.export({ format: "der", type: "spki" });
  const sequence = readElement(spki, 0);
  if (!sequence || sequence.tag !== TAG_SEQUENCE) return null;
  const bitString = readSequence(sequence.contents).find(
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
  const fromExtension = subjectKeyIdentifierExtension(Buffer.from(parsed.raw));
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
