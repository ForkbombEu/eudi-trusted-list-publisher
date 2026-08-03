/**
 * xmlsec — an enveloped XAdES-B-B signer and verifier.
 *
 * Self-contained by design: nothing here imports from the publisher, and the
 * only dependencies are `node:crypto` and `libxml2-wasm`. See `README.md` in
 * this directory for what the package does and deliberately does not do.
 */
export {
  C14N_EXCLUSIVE,
  DIGEST_SHA256,
  NS_DSIG,
  NS_XADES,
  REFERENCE_TYPE_SIGNED_PROPERTIES,
  SIGNATURE_ECDSA_SHA256,
  SIGNATURE_RSA_SHA256,
  TRANSFORM_ENVELOPED_SIGNATURE,
} from "./algorithms.js";
export { signEnveloped, type SignOptions } from "./sign.js";
export { verifyEnveloped, type VerifyResult } from "./verify.js";
export { XmlSecError } from "./xml.js";
