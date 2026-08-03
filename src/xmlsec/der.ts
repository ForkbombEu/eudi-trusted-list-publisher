/**
 * The small amount of DER this package needs, kept local so `xmlsec` depends
 * on nothing but `node:crypto` and `libxml2-wasm`.
 *
 * EN 319 132-1 clause 5.2.2.3 identifies the signing certificate by digest and,
 * where present, by `IssuerSerialV2` — the Base64 of a DER `IssuerSerial` as
 * RFC 5035 defines it. Node's `X509Certificate` exposes the issuer as a
 * formatted string, not as the original DER `Name`, and re-encoding a parsed
 * string would not reproduce the issuer's own encoding. So the value is lifted
 * verbatim out of the certificate's TBSCertificate instead.
 */
import { X509Certificate } from "node:crypto";

const TAG_INTEGER = 0x02;
const TAG_SEQUENCE = 0x30;
/** [0] EXPLICIT — the optional version member of TBSCertificate. */
const TAG_VERSION = 0xa0;
/** [4] — directoryName inside a GeneralName. */
const TAG_DIRECTORY_NAME = 0xa4;

interface DerElement {
  readonly tag: number;
  /** The element including its tag and length octets. */
  readonly raw: Buffer;
  readonly contents: Buffer;
  readonly end: number;
}

function readElement(der: Buffer, offset: number): DerElement | null {
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
  return {
    tag,
    raw: der.subarray(offset, end),
    contents: der.subarray(contentsAt, end),
    end,
  };
}

function readSequence(contents: Buffer): DerElement[] {
  const elements: DerElement[] = [];
  let offset = 0;
  while (offset < contents.length) {
    const element = readElement(contents, offset);
    if (!element) return [];
    elements.push(element);
    offset = element.end;
  }
  return elements;
}

/** DER `TLV` for a given tag and contents, with definite length. */
function encode(tag: number, contents: Buffer): Buffer {
  if (contents.length < 0x80)
    return Buffer.concat([Buffer.from([tag, contents.length]), contents]);
  const lengthBytes: number[] = [];
  let remaining = contents.length;
  while (remaining > 0) {
    lengthBytes.unshift(remaining & 0xff);
    remaining = Math.floor(remaining / 256);
  }
  return Buffer.concat([
    Buffer.from([tag, 0x80 | lengthBytes.length, ...lengthBytes]),
    contents,
  ]);
}

/**
 * The certificate's issuer `Name` and `serialNumber`, both exactly as the
 * certificate encodes them. Returns null when the certificate does not have
 * the structure RFC 5280 requires, so the caller omits `IssuerSerialV2` rather
 * than publishing an identifier it invented.
 */
function issuerAndSerial(
  certificate: X509Certificate,
): { issuer: Buffer; serial: Buffer } | null {
  const outer = readElement(Buffer.from(certificate.raw), 0);
  if (!outer || outer.tag !== TAG_SEQUENCE) return null;
  const tbs = readElement(outer.contents, 0);
  if (!tbs || tbs.tag !== TAG_SEQUENCE) return null;
  const members = readSequence(tbs.contents);
  /*
    TBSCertificate is version?, serialNumber, signature, issuer, ... The
    version member is optional, so the serial number is the first INTEGER and
    the issuer is the second SEQUENCE after it.
  */
  let index = 0;
  if (members[index]?.tag === TAG_VERSION) index += 1;
  const serial = members[index];
  if (!serial || serial.tag !== TAG_INTEGER) return null;
  const signatureAlgorithm = members[index + 1];
  if (!signatureAlgorithm || signatureAlgorithm.tag !== TAG_SEQUENCE)
    return null;
  const issuer = members[index + 2];
  if (!issuer || issuer.tag !== TAG_SEQUENCE) return null;
  return { issuer: issuer.raw, serial: serial.raw };
}

/**
 * Base64 of the DER `IssuerSerial` of RFC 5035:
 *
 * ```asn1
 * IssuerSerial ::= SEQUENCE { issuer GeneralNames, serial CertificateSerialNumber }
 * GeneralNames ::= SEQUENCE SIZE (1..MAX) OF GeneralName
 * GeneralName  ::= CHOICE { ... directoryName [4] Name ... }
 * ```
 *
 * Returns null when the issuer and serial cannot be read, which the caller
 * treats as "omit the optional element".
 */
export function issuerSerialV2Base64(
  certificate: X509Certificate,
): string | null {
  const parts = issuerAndSerial(certificate);
  if (!parts) return null;
  /* directoryName is [4] EXPLICIT, so the Name SEQUENCE is wrapped, not retagged. */
  const generalName = encode(TAG_DIRECTORY_NAME, parts.issuer);
  const generalNames = encode(TAG_SEQUENCE, generalName);
  const issuerSerial = encode(
    TAG_SEQUENCE,
    Buffer.concat([generalNames, parts.serial]),
  );
  return issuerSerial.toString("base64");
}

/** The certificate as strict Base64 DER, with no PEM armour and no whitespace. */
export function certificateBase64Der(certificate: X509Certificate): string {
  return Buffer.from(certificate.raw).toString("base64");
}
