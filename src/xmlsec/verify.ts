/**
 * Local verification of an enveloped XAdES-B-B signature.
 *
 * Everything is recomputed from the serialized document: the references are
 * re-canonicalised and re-digested, and the signature is checked against the
 * certificate the document itself carries. That establishes that the document
 * has not changed since it was signed and that the key in that certificate
 * signed it. It establishes nothing about whether the certificate is
 * trustworthy — no path is built and no revocation is checked.
 */
import { createHash, createVerify, X509Certificate } from "node:crypto";
import {
  C14N_EXCLUSIVE,
  DIGEST_SHA256,
  NS_DSIG,
  NS_XADES,
  REFERENCE_TYPE_SIGNED_PROPERTIES,
  TRANSFORM_ENVELOPED_SIGNATURE,
  algorithmForUri,
} from "./algorithms.js";
import {
  XmlSecError,
  canonicalizeElementExclusive,
  canonicalizeWithoutSignature,
  elementById,
  parseXml,
} from "./xml.js";

const NAMESPACES = { ds: NS_DSIG, xades: NS_XADES } as const;

/**
 * The Baseline-B finding a signature produced with `omitSigningTime` carries by
 * construction. Named rather than repeated, so the signer can recognise the one
 * failure it was asked to cause without pattern-matching a message.
 */
export const NO_SIGNING_TIME_FINDING =
  "SignedProperties carries no xades:SigningTime.";

export interface VerifyResult {
  /** True only when every check below passed. */
  readonly valid: boolean;
  readonly findings: readonly string[];
  readonly signingTime?: string;
  /** The signing certificate as strict Base64 DER, as the document carries it. */
  readonly certificateBase64Der?: string;
  readonly signatureAlgorithm?: string;
  /** SHA-256 of the signing certificate, lowercase hex. */
  readonly certificateFingerprint?: string;
}

function text(node: { content: string } | null): string | null {
  return node ? node.content.trim() : null;
}

function base64Sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("base64");
}

export function verifyEnveloped(xml: string): VerifyResult {
  const findings: string[] = [];
  let document;
  try {
    document = parseXml(xml);
  } catch (error) {
    return {
      valid: false,
      findings: [error instanceof XmlSecError ? error.message : String(error)],
    };
  }

  try {
    const signatureNode = document.get("//ds:Signature", NAMESPACES);
    if (!signatureNode)
      return {
        valid: false,
        findings: ["The document carries no ds:Signature."],
      };
    const signature = signatureNode as unknown as Parameters<
      typeof canonicalizeElementExclusive
    >[0];

    const signedInfo = signature.get("ds:SignedInfo", NAMESPACES);
    if (!signedInfo)
      return {
        valid: false,
        findings: ["The signature has no ds:SignedInfo."],
      };

    const c14nMethod = signature.get(
      "ds:SignedInfo/ds:CanonicalizationMethod/@Algorithm",
      NAMESPACES,
    );
    if (text(c14nMethod) !== C14N_EXCLUSIVE)
      findings.push(
        `SignedInfo must be canonicalised with ${C14N_EXCLUSIVE}, found '${text(c14nMethod)}'.`,
      );

    const signatureMethod = text(
      signature.get("ds:SignedInfo/ds:SignatureMethod/@Algorithm", NAMESPACES),
    );
    const algorithm = signatureMethod
      ? algorithmForUri(signatureMethod)
      : undefined;
    if (!algorithm)
      return {
        valid: false,
        findings: [
          ...findings,
          `Unsupported signature algorithm '${signatureMethod}'.`,
        ],
      };

    const certificateBase64 = text(
      signature.get("ds:KeyInfo/ds:X509Data/ds:X509Certificate", NAMESPACES),
    );
    if (!certificateBase64)
      return {
        valid: false,
        findings: [
          ...findings,
          "The signature has no ds:KeyInfo/ds:X509Data/ds:X509Certificate.",
        ],
      };
    const certificates = signature.find(
      "ds:KeyInfo/ds:X509Data/ds:X509Certificate",
      NAMESPACES,
    );
    if (certificates.length !== 1)
      findings.push(
        `ds:KeyInfo must carry exactly the signing certificate, found ${certificates.length}.`,
      );

    let certificate: X509Certificate;
    try {
      certificate = new X509Certificate(
        Buffer.from(certificateBase64.replace(/\s+/g, ""), "base64"),
      );
    } catch (error) {
      return {
        valid: false,
        findings: [
          ...findings,
          `The certificate in ds:KeyInfo does not parse: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ],
      };
    }

    /* Reference 1: the whole document, minus the signature. */
    const documentReference = signature.get(
      "ds:SignedInfo/ds:Reference[not(@Type)]",
      NAMESPACES,
    );
    if (!documentReference) {
      findings.push(
        "The signature has no ds:Reference covering the document itself.",
      );
    } else {
      const uri = text(documentReference.get("@URI", NAMESPACES));
      if (uri !== "")
        findings.push(
          `The document reference must use URI="" to cover the whole document, found '${uri}'.`,
        );
      const transforms = signature
        .find(
          "ds:SignedInfo/ds:Reference[not(@Type)]/ds:Transforms/ds:Transform/@Algorithm",
          NAMESPACES,
        )
        .map((node) => (node as unknown as { content: string }).content.trim());
      if (
        transforms[0] !== TRANSFORM_ENVELOPED_SIGNATURE ||
        transforms[1] !== C14N_EXCLUSIVE ||
        transforms.length !== 2
      )
        findings.push(
          `The document reference must apply the enveloped-signature transform then exclusive canonicalisation, found [${transforms.join(", ")}].`,
        );
      const digestMethod = text(
        documentReference.get("ds:DigestMethod/@Algorithm", NAMESPACES),
      );
      if (digestMethod !== DIGEST_SHA256)
        findings.push(`The document reference must use SHA-256 digests.`);
      const stated = text(documentReference.get("ds:DigestValue", NAMESPACES));
      const actual = base64Sha256(canonicalizeWithoutSignature(document));
      if (stated !== actual)
        findings.push(
          "The document digest does not match: the document changed after it was signed.",
        );
    }

    /* Reference 2: the XAdES SignedProperties. */
    const propertiesReference = signature.get(
      `ds:SignedInfo/ds:Reference[@Type='${REFERENCE_TYPE_SIGNED_PROPERTIES}']`,
      NAMESPACES,
    );
    let signingTime: string | undefined;
    if (!propertiesReference) {
      findings.push(
        "The signature has no ds:Reference covering the XAdES SignedProperties, so it is not XAdES-B-B.",
      );
    } else {
      const uri = text(propertiesReference.get("@URI", NAMESPACES)) ?? "";
      const id = uri.startsWith("#") ? uri.slice(1) : "";
      const signedProperties = id ? elementById(document, id) : null;
      if (!signedProperties) {
        findings.push(
          `The SignedProperties reference points at '${uri}', which is not in the document.`,
        );
      } else {
        const stated = text(
          propertiesReference.get("ds:DigestValue", NAMESPACES),
        );
        const actual = base64Sha256(
          canonicalizeElementExclusive(signedProperties),
        );
        if (stated !== actual)
          findings.push(
            "The SignedProperties digest does not match: the signed properties changed after signing.",
          );
        signingTime =
          text(
            signedProperties.get(
              "xades:SignedSignatureProperties/xades:SigningTime",
              NAMESPACES,
            ),
          ) ?? undefined;
        if (!signingTime) findings.push(NO_SIGNING_TIME_FINDING);
        const certDigest = text(
          signedProperties.get(
            "xades:SignedSignatureProperties/xades:SigningCertificateV2/xades:Cert/xades:CertDigest/ds:DigestValue",
            NAMESPACES,
          ),
        );
        if (!certDigest) {
          findings.push(
            "SignedProperties carries no xades:SigningCertificateV2 digest.",
          );
        } else if (
          certDigest !==
          createHash("sha256")
            .update(Buffer.from(certificate.raw))
            .digest("base64")
        ) {
          findings.push(
            "SigningCertificateV2 does not identify the certificate in ds:KeyInfo.",
          );
        }
      }
    }

    /* The signature itself, over the canonical SignedInfo. */
    const signatureValue = text(signature.get("ds:SignatureValue", NAMESPACES));
    if (!signatureValue) {
      findings.push("The signature has no ds:SignatureValue.");
    } else {
      const verifier = createVerify("sha256");
      verifier.update(
        canonicalizeElementExclusive(
          signedInfo as unknown as Parameters<
            typeof canonicalizeElementExclusive
          >[0],
        ),
      );
      verifier.end();
      /*
        A signature value of the wrong length makes Node throw rather than
        return false — for ECDSA it cannot even be split into r and s. That is
        still a failed verification, so it is reported as one.
      */
      let ok = false;
      try {
        ok = verifier.verify(
          {
            key: certificate.publicKey,
            ...(algorithm.dsaEncoding
              ? { dsaEncoding: algorithm.dsaEncoding }
              : {}),
          },
          Buffer.from(signatureValue.replace(/\s+/g, ""), "base64"),
        );
      } catch {
        ok = false;
      }
      if (!ok)
        findings.push(
          "The signature does not verify with the public key in ds:KeyInfo.",
        );
    }

    return {
      valid: findings.length === 0,
      findings,
      ...(signingTime ? { signingTime } : {}),
      certificateBase64Der: Buffer.from(certificate.raw).toString("base64"),
      signatureAlgorithm: algorithm.uri,
      certificateFingerprint: createHash("sha256")
        .update(Buffer.from(certificate.raw))
        .digest("hex"),
    };
  } finally {
    document.dispose();
  }
}
