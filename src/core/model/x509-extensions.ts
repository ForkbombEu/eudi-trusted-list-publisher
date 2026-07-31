import { X509Certificate } from "node:crypto";

const TAG_BOOLEAN = 0x01;
const TAG_OCTET_STRING = 0x04;
const TAG_OID = 0x06;
const TAG_SEQUENCE = 0x30;
/** [3] EXPLICIT — the extensions member of TBSCertificate. */
const TAG_EXTENSIONS = 0xa3;

export interface DerElement {
  tag: number;
  contents: Buffer;
  end: number;
}

export interface CertificateExtension {
  critical: boolean;
  value: Buffer;
}

export function readDerElement(der: Buffer, offset: number): DerElement | null {
  if (offset + 2 > der.length) return null;
  const tag = der[offset]!;
  const first = der[offset + 1]!;
  let length = first;
  let contentsAt = offset + 2;
  if (first & 0x80) {
    const lengthBytes = first & 0x7f;
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

export function readDerSequence(contents: Buffer): DerElement[] {
  const elements: DerElement[] = [];
  let offset = 0;
  while (offset < contents.length) {
    const element = readDerElement(contents, offset);
    if (!element) return [];
    elements.push(element);
    offset = element.end;
  }
  return elements;
}

/** Reads one extension by its DER-encoded OID contents. */
export function readCertificateExtension(
  certificate: X509Certificate,
  oid: Buffer,
): CertificateExtension | null {
  const outer = readDerElement(Buffer.from(certificate.raw), 0);
  if (!outer || outer.tag !== TAG_SEQUENCE) return null;
  const tbs = readDerElement(outer.contents, 0);
  if (!tbs || tbs.tag !== TAG_SEQUENCE) return null;
  const extensionsMember = readDerSequence(tbs.contents).find(
    (element) => element.tag === TAG_EXTENSIONS,
  );
  if (!extensionsMember) return null;
  const extensions = readDerElement(extensionsMember.contents, 0);
  if (!extensions || extensions.tag !== TAG_SEQUENCE) return null;

  for (const encoded of readDerSequence(extensions.contents)) {
    if (encoded.tag !== TAG_SEQUENCE) continue;
    const parts = readDerSequence(encoded.contents);
    const extensionOid = parts[0];
    if (
      !extensionOid ||
      extensionOid.tag !== TAG_OID ||
      !extensionOid.contents.equals(oid)
    )
      continue;
    const criticalPart = parts[1]?.tag === TAG_BOOLEAN ? parts[1] : null;
    const value = parts[criticalPart ? 2 : 1];
    if (!value || value.tag !== TAG_OCTET_STRING) return null;
    return {
      critical:
        criticalPart !== null &&
        criticalPart.contents.length === 1 &&
        criticalPart.contents[0] !== 0,
      value: value.contents,
    };
  }
  return null;
}
