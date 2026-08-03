/** Algorithm identifiers and namespaces used by an XAdES-B-B signature. */

export const NS_DSIG = "http://www.w3.org/2000/09/xmldsig#";
export const NS_XADES = "http://uri.etsi.org/01903/v1.3.2#";

export const C14N_EXCLUSIVE = "http://www.w3.org/2001/10/xml-exc-c14n#";
export const TRANSFORM_ENVELOPED_SIGNATURE =
  "http://www.w3.org/2000/09/xmldsig#enveloped-signature";

export const DIGEST_SHA256 = "http://www.w3.org/2001/04/xmlenc#sha256";
export const SIGNATURE_ECDSA_SHA256 =
  "http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha256";
export const SIGNATURE_RSA_SHA256 =
  "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256";

/** The `Type` a `ds:Reference` to XAdES SignedProperties carries. */
export const REFERENCE_TYPE_SIGNED_PROPERTIES =
  "http://uri.etsi.org/01903#SignedProperties";

export type SupportedKeyType = "ec" | "rsa";

export interface SignatureAlgorithm {
  readonly uri: string;
  readonly nodeDigest: "sha256";
  /**
   * ECDSA in XMLDSig is the raw `r || s` pair of IEEE P1363, not the DER
   * SEQUENCE Node produces by default. Getting this wrong yields a signature
   * that Node verifies and no XMLDSig implementation does.
   */
  readonly dsaEncoding?: "ieee-p1363";
}

export function algorithmForKeyType(
  keyType: string,
): SignatureAlgorithm | undefined {
  if (keyType === "ec")
    return {
      uri: SIGNATURE_ECDSA_SHA256,
      nodeDigest: "sha256",
      dsaEncoding: "ieee-p1363",
    };
  if (keyType === "rsa")
    return { uri: SIGNATURE_RSA_SHA256, nodeDigest: "sha256" };
  return undefined;
}

export function algorithmForUri(uri: string): SignatureAlgorithm | undefined {
  if (uri === SIGNATURE_ECDSA_SHA256)
    return {
      uri,
      nodeDigest: "sha256",
      dsaEncoding: "ieee-p1363",
    };
  if (uri === SIGNATURE_RSA_SHA256) return { uri, nodeDigest: "sha256" };
  return undefined;
}
