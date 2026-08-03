/**
 * Produces an enveloped XAdES-B-B signature over a whole XML document.
 *
 * The assembly runs three times. Each pass serializes the complete document,
 * re-parses it and canonicalises from that text, so every digest in the result
 * is one a verifier can recompute from the published bytes alone:
 *
 *   1. digest the document as it stands, with no signature in it yet;
 *   2. insert the signature with the SignedProperties in place, and digest
 *      those properties as they now sit in the document;
 *   3. insert the signature again with that digest filled in, canonicalise
 *      SignedInfo and sign it.
 *
 * A placeholder digest is the same length as a real one, so pass 2 and pass 3
 * canonicalise a structurally identical SignedProperties.
 */
import { createHash, createSign, X509Certificate } from "node:crypto";
import {
  C14N_EXCLUSIVE,
  DIGEST_SHA256,
  NS_DSIG,
  NS_XADES,
  REFERENCE_TYPE_SIGNED_PROPERTIES,
  TRANSFORM_ENVELOPED_SIGNATURE,
  algorithmForKeyType,
} from "./algorithms.js";
import { certificateBase64Der, issuerSerialV2Base64 } from "./der.js";
import {
  XmlSecError,
  appendToRoot,
  canonicalizeElementExclusive,
  canonicalizeWithoutSignature,
  elementById,
  parseXml,
  rootElementName,
} from "./xml.js";
import { NO_SIGNING_TIME_FINDING, verifyEnveloped } from "./verify.js";

export interface SignOptions {
  readonly privateKeyPem: string;
  readonly certificatePem: string;
  /** Clause 5.2.1 SigningTime. Defaults to now, truncated to the second. */
  readonly signingTime?: Date;
  /**
   * Base for the generated `Id` attributes. One document may only carry one
   * signature from this package, which is all TS 119 612 asks for.
   */
  readonly signatureId?: string;
  /**
   * The media type of the document being signed, published in the XAdES
   * `DataObjectFormat`. EN 319 132-1 requires one such property per signed data
   * object other than the SignedProperties themselves.
   */
  readonly dataObjectMimeType?: string;
  /**
   * Omit `xades:SigningTime` from SignedProperties.
   *
   * The result is a cryptographically sound signature that is not XAdES
   * Baseline B, which is exactly what the `xades_without_signing_time` negative
   * fixture needs. It has no legitimate use in a healthy publication, so it
   * defaults to false and every caller that sets it says why.
   */
  readonly omitSigningTime?: boolean;
}

const PLACEHOLDER_DIGEST = "A".repeat(44);

function base64Sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("base64");
}

function toUtcSeconds(instant: Date): string {
  return `${instant.toISOString().slice(0, 19)}Z`;
}

interface Ids {
  readonly signature: string;
  readonly signedProperties: string;
  readonly signedPropertiesReference: string;
  readonly documentReference: string;
  readonly object: string;
}

function buildQualifyingProperties(
  ids: Ids,
  certificate: X509Certificate,
  signingTime: Date | null,
  dataObjectMimeType: string,
): string {
  const digest = createHash("sha256")
    .update(Buffer.from(certificate.raw))
    .digest("base64");
  const issuerSerial = issuerSerialV2Base64(certificate);
  const issuerSerialElement = issuerSerial
    ? `\n            <xades:IssuerSerialV2>${issuerSerial}</xades:IssuerSerialV2>`
    : "";
  const signingTimeElement =
    signingTime === null
      ? ""
      : `\n      <xades:SigningTime>${toUtcSeconds(signingTime)}</xades:SigningTime>`;
  return `<xades:QualifyingProperties xmlns:xades="${NS_XADES}" Target="#${ids.signature}">
  <xades:SignedProperties Id="${ids.signedProperties}">
    <xades:SignedSignatureProperties>${signingTimeElement}
      <xades:SigningCertificateV2>
        <xades:Cert>
          <xades:CertDigest>
            <ds:DigestMethod Algorithm="${DIGEST_SHA256}"/>
            <ds:DigestValue>${digest}</ds:DigestValue>
          </xades:CertDigest>${issuerSerialElement}
        </xades:Cert>
      </xades:SigningCertificateV2>
    </xades:SignedSignatureProperties>
    <xades:SignedDataObjectProperties>
      <xades:DataObjectFormat ObjectReference="#${ids.documentReference}">
        <xades:MimeType>${dataObjectMimeType}</xades:MimeType>
      </xades:DataObjectFormat>
    </xades:SignedDataObjectProperties>
  </xades:SignedProperties>
</xades:QualifyingProperties>`;
}

function buildSignature(
  ids: Ids,
  signatureAlgorithmUri: string,
  documentDigest: string,
  signedPropertiesDigest: string,
  signatureValue: string,
  certificateBase64: string,
  qualifyingProperties: string,
): string {
  const indented = qualifyingProperties.replace(/\n/g, "\n      ");
  return `<ds:Signature xmlns:ds="${NS_DSIG}" Id="${ids.signature}">
  <ds:SignedInfo>
    <ds:CanonicalizationMethod Algorithm="${C14N_EXCLUSIVE}"/>
    <ds:SignatureMethod Algorithm="${signatureAlgorithmUri}"/>
    <ds:Reference Id="${ids.documentReference}" URI="">
      <ds:Transforms>
        <ds:Transform Algorithm="${TRANSFORM_ENVELOPED_SIGNATURE}"/>
        <ds:Transform Algorithm="${C14N_EXCLUSIVE}"/>
      </ds:Transforms>
      <ds:DigestMethod Algorithm="${DIGEST_SHA256}"/>
      <ds:DigestValue>${documentDigest}</ds:DigestValue>
    </ds:Reference>
    <ds:Reference Id="${ids.signedPropertiesReference}" Type="${REFERENCE_TYPE_SIGNED_PROPERTIES}" URI="#${ids.signedProperties}">
      <ds:Transforms>
        <ds:Transform Algorithm="${C14N_EXCLUSIVE}"/>
      </ds:Transforms>
      <ds:DigestMethod Algorithm="${DIGEST_SHA256}"/>
      <ds:DigestValue>${signedPropertiesDigest}</ds:DigestValue>
    </ds:Reference>
  </ds:SignedInfo>
  <ds:SignatureValue>${signatureValue}</ds:SignatureValue>
  <ds:KeyInfo>
    <ds:X509Data>
      <ds:X509Certificate>${certificateBase64}</ds:X509Certificate>
    </ds:X509Data>
  </ds:KeyInfo>
  <ds:Object Id="${ids.object}">
      ${indented}
  </ds:Object>
</ds:Signature>`;
}

/**
 * Signs `xml` and returns the complete signed document.
 *
 * Throws rather than returning an unverifiable result: the signature is
 * verified locally before it is handed back, so a caller never publishes a
 * document this package could not itself check.
 */
export function signEnveloped(xml: string, options: SignOptions): string {
  const certificate = new X509Certificate(options.certificatePem);
  const algorithm = algorithmForKeyType(
    certificate.publicKey.asymmetricKeyType ?? "",
  );
  if (!algorithm)
    throw new XmlSecError(
      `Unsupported signing key type '${certificate.publicKey.asymmetricKeyType}'. This package signs with ECDSA or RSA and SHA-256.`,
    );

  const base = options.signatureId ?? "signature";
  /* The base is written into Id attributes and into an XPath, so it is
     constrained rather than escaped: an Id is an XML Name to begin with. */
  if (!/^[A-Za-z_][\w.-]*$/.test(base))
    throw new XmlSecError(
      `'${base}' is not a usable signature Id; an Id must be an XML Name.`,
    );
  const ids: Ids = {
    signature: base,
    signedProperties: `${base}-signed-properties`,
    signedPropertiesReference: `${base}-ref-signed-properties`,
    documentReference: `${base}-ref-document`,
    object: `${base}-object`,
  };

  const signingTime = options.signingTime ?? new Date();
  const certificateBase64 = certificateBase64Der(certificate);
  const qualifyingProperties = buildQualifyingProperties(
    ids,
    certificate,
    options.omitSigningTime ? null : signingTime,
    options.dataObjectMimeType ?? "text/xml",
  );

  let rootName: string;
  {
    using document = parseXml(xml);
    rootName = rootElementName(document);
  }

  const assemble = (
    documentDigest: string,
    signedPropertiesDigest: string,
    signatureValue: string,
  ): string =>
    appendToRoot(
      xml,
      rootName,
      buildSignature(
        ids,
        algorithm.uri,
        documentDigest,
        signedPropertiesDigest,
        signatureValue,
        certificateBase64,
        qualifyingProperties,
      ),
    );

  /*
    Pass 1: both reference digests, taken from a draft that already contains
    the signature.

    The enveloped-signature transform is defined over the document *with* the
    signature in it — it removes the ds:Signature element, and nothing else.
    Digesting the document before the signature was inserted would leave out
    the whitespace the insertion adds around it, and the resulting signature
    would fail to verify everywhere, including here. Neither digest covers
    itself: both sit inside the subtree the transform removes.
  */
  let documentDigest: string;
  let signedPropertiesDigest: string;
  {
    using document = parseXml(
      assemble(PLACEHOLDER_DIGEST, PLACEHOLDER_DIGEST, ""),
    );
    const signature = elementById(document, ids.signature);
    if (!signature)
      throw new XmlSecError(
        "The assembled signature has no Signature element.",
      );
    documentDigest = base64Sha256(canonicalizeWithoutSignature(document));
    const signedProperties = elementById(document, ids.signedProperties);
    if (!signedProperties)
      throw new XmlSecError(
        "The assembled signature has no SignedProperties element.",
      );
    signedPropertiesDigest = base64Sha256(
      canonicalizeElementExclusive(signedProperties),
    );
  }

  /* Pass 2: canonicalise the now-complete SignedInfo and sign it. */
  let signatureValue: string;
  {
    using document = parseXml(
      assemble(documentDigest, signedPropertiesDigest, ""),
    );
    const signature = elementById(document, ids.signature);
    if (!signature)
      throw new XmlSecError(
        "The assembled signature has no Signature element.",
      );
    const signedInfo = signature.get("ds:SignedInfo", { ds: NS_DSIG });
    if (!signedInfo)
      throw new XmlSecError("The assembled signature has no SignedInfo.");
    const signedInfoBytes = canonicalizeElementExclusive(
      signedInfo as unknown as Parameters<
        typeof canonicalizeElementExclusive
      >[0],
    );
    const signer = createSign("sha256");
    signer.update(signedInfoBytes);
    signer.end();
    signatureValue = signer
      .sign({
        key: options.privateKeyPem,
        ...(algorithm.dsaEncoding
          ? { dsaEncoding: algorithm.dsaEncoding }
          : {}),
      })
      .toString("base64");
  }

  const signed = assemble(
    documentDigest,
    signedPropertiesDigest,
    signatureValue,
  );

  /*
    The signature is verified before it is handed back, so a caller never
    publishes a document this package could not itself check. When the caller
    asked for no signing time, the resulting Baseline-B finding is the thing it
    asked for and is not a reason to refuse — every other finding still is.
  */
  const verification = verifyEnveloped(signed);
  const unexpected = options.omitSigningTime
    ? verification.findings.filter(
        (finding) => finding !== NO_SIGNING_TIME_FINDING,
      )
    : verification.findings;
  if (unexpected.length > 0)
    throw new XmlSecError(
      `The signature this package just produced does not verify: ${unexpected.join(
        "; ",
      )}`,
    );

  return signed;
}

/** The enveloped-signature transform, exposed for tests and verification. */
export function canonicalDocumentWithoutSignature(
  xml: string,
  signatureId: string,
): Buffer {
  using document = parseXml(xml);
  const signature = elementById(document, signatureId);
  if (!signature)
    throw new XmlSecError(`No element carries Id '${signatureId}'.`);
  return canonicalizeWithoutSignature(document);
}
