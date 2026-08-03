/**
 * Provenance of every XML Schema this project validates TS 119 612 Trusted
 * Lists against.
 *
 * The vendored files are byte-for-byte copies of their sources: `STANDARDS.md`
 * records the same URLs and SHA-256 hashes, and `test/tsl612-schema.test.ts`
 * recomputes the hashes so a silently edited schema fails the suite. Nothing
 * rewrites a vendored file, at build time or at run time — the absolute
 * `schemaLocation` URLs below are resolved offline by an input provider that
 * maps each URL to its local copy.
 */
export interface VendoredSchema {
  /** The `schemaLocation` URL that appears inside an importing schema. */
  readonly url: string;
  /** File name under `schemas/etsi/119612/`. */
  readonly file: string;
  /** Target namespace the file defines. */
  readonly namespace: string;
  /** SHA-256 of the vendored bytes, lowercase hex. */
  readonly sha256: string;
  readonly origin: string;
}

export const TSL_NAMESPACE = "http://uri.etsi.org/02231/v2#";
export const TSLX_NAMESPACE = "http://uri.etsi.org/02231/v2/additionaltypes#";
export const SIE_NAMESPACE =
  "http://uri.etsi.org/TrstSvc/SvcInfoExt/eSigDir-1999-93-EC-TrustedList/#";
export const XADES_NAMESPACE = "http://uri.etsi.org/01903/v1.3.2#";
export const XADES141_NAMESPACE = "http://uri.etsi.org/01903/v1.4.1#";
export const DSIG_NAMESPACE = "http://www.w3.org/2000/09/xmldsig#";
export const XML_NAMESPACE = "http://www.w3.org/XML/1998/namespace";

/** ETSI TS 119 612 V2.4.1, from the `v2.4.1` tag of the ETSI Forge repository. */
const ETSI_119612_TAG =
  "https://forge.etsi.org/rep/esi/x19_612_trusted_lists/-/raw/v2.4.1";

/** ETSI TS 119 132-1 XAdES schemas, from the `v1.3.1` tag on ETSI Forge. */
const ETSI_XADES_TAG =
  "https://forge.etsi.org/rep/esi/x19_13201_xades/-/raw/v1.3.1";

/**
 * Every schema needed to validate a TS 119 612 Trusted List offline, keyed by
 * the URL an importing schema names it with.
 *
 * The `19612_xsd.xsd` import of `xml.xsd` and `xmldsig-core-schema.xsd` uses
 * `http://` while `xmldsig-core-schema.xsd` imports `xml.xsd` from two further
 * URLs; each spelling is listed, because the resolver matches the literal
 * string libxml2 asks for.
 */
export const VENDORED_SCHEMAS: readonly VendoredSchema[] = Object.freeze([
  Object.freeze({
    url: `${ETSI_119612_TAG}/19612_xsd.xsd`,
    file: "19612_xsd.xsd",
    namespace: TSL_NAMESPACE,
    sha256: "0cb6ac0e96f9600934d216513f21e4cc5b41f8c8c28a8e42102a8135b24df3e1",
    origin: "ETSI TS 119 612 V2.4.1",
  }),
  Object.freeze({
    url: `${ETSI_119612_TAG}/19612_additionaltypes_xsd.xsd`,
    file: "19612_additionaltypes_xsd.xsd",
    namespace: TSLX_NAMESPACE,
    sha256: "25f9292d8c246cbacab9f345451d64cdb63154a12042ffc675cdf2c88896948b",
    origin: "ETSI TS 119 612 V2.4.1",
  }),
  Object.freeze({
    url: `${ETSI_119612_TAG}/19612_sie_xsd.xsd`,
    file: "19612_sie_xsd.xsd",
    namespace: SIE_NAMESPACE,
    sha256: "382fcf497770a5842ac9975db0f14020c33c936b1903e057548ad6724cf42d69",
    origin: "ETSI TS 119 612 V2.4.1",
  }),
  Object.freeze({
    url: "https://uri.etsi.org/01903/v1.3.2/XAdES01903v132-201601.xsd",
    file: "1913201-XAdES01903v132.xsd",
    namespace: XADES_NAMESPACE,
    sha256: "457745286eaa292ae1aaa6e976e0f30eeceb0a37cc2301151576175e0ae1986c",
    origin: "ETSI TS 119 132-1, ETSI Forge tag v1.3.1",
  }),
  Object.freeze({
    url: `${ETSI_XADES_TAG}/1913201-XAdES01903v141.xsd`,
    file: "1913201-XAdES01903v141.xsd",
    namespace: XADES141_NAMESPACE,
    sha256: "286bd63f122aafb907c03724c5959455d114020e523631cc22e90c5f5aa667e2",
    origin: "ETSI TS 119 132-1, ETSI Forge tag v1.3.1",
  }),
  Object.freeze({
    url: "http://www.w3.org/TR/2008/REC-xmldsig-core-20080610/xmldsig-core-schema.xsd",
    file: "xmldsig-core-schema.xsd",
    namespace: DSIG_NAMESPACE,
    sha256: "35cf8197da812c85e40d57891b35c94187569ed474a2dac813ce5090dafcd35c",
    origin: "W3C XML Signature Syntax and Processing (Second Edition)",
  }),
  Object.freeze({
    url: "http://www.w3.org/2001/xml.xsd",
    file: "xml.xsd",
    namespace: XML_NAMESPACE,
    sha256: "61960fb3131e38022caad5360e2f33a3382578ab3c80cd58bd74320ede61b20c",
    origin: "W3C, the 2001 xml: attribute schema",
  }),
  Object.freeze({
    url: "http://www.w3.org/2009/01/xml.xsd",
    file: "xml-2009.xsd",
    namespace: XML_NAMESPACE,
    sha256: "cc701736c42cc64126fad063bb95f94484b5de3b5f808a86ea098b0957aff829",
    origin: "W3C, the 2009 revision of the xml: attribute schema",
  }),
]);

/**
 * `xmldsig-core-schema.xsd` and `xml.xsd` are reachable over both `http://`
 * and `https://`; libxml2 asks for whatever the importing schema printed, so
 * both spellings resolve to the same vendored file.
 */
export function schemaFileForUrl(url: string): string | undefined {
  const direct = VENDORED_SCHEMAS.find((schema) => schema.url === url);
  if (direct) return direct.file;
  const swapped = url.startsWith("https://")
    ? `http://${url.slice("https://".length)}`
    : url.startsWith("http://")
      ? `https://${url.slice("http://".length)}`
      : undefined;
  if (!swapped) return undefined;
  return VENDORED_SCHEMAS.find((schema) => schema.url === swapped)?.file;
}
