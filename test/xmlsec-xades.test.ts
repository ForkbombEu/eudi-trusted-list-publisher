import { beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  C14N_EXCLUSIVE,
  DIGEST_SHA256,
  REFERENCE_TYPE_SIGNED_PROPERTIES,
  SIGNATURE_ECDSA_SHA256,
  TRANSFORM_ENVELOPED_SIGNATURE,
  XmlSecError,
  signEnveloped,
  verifyEnveloped,
} from "../src/xmlsec/index.js";

const DOCUMENT = `<?xml version="1.0" encoding="UTF-8"?>
<Root xmlns="urn:example:root" Id="Root">
  <Item xml:lang="en">first</Item>
  <Item xml:lang="en">second &amp; last</Item>
</Root>
`;

/** One EC and one RSA key pair, generated once for the whole file. */
let ecKey: string;
let ecCert: string;
let rsaKey: string;
let rsaCert: string;
let otherCert: string;

function generate(
  directory: string,
  name: string,
  algorithm: readonly string[],
): { key: string; certificate: string } {
  const keyPath = join(directory, `${name}.key`);
  const certPath = join(directory, `${name}.crt`);
  execFileSync("openssl", ["genpkey", "-out", keyPath, ...algorithm]);
  execFileSync("openssl", [
    "req",
    "-new",
    "-x509",
    "-key",
    keyPath,
    "-out",
    certPath,
    "-days",
    "365",
    "-subj",
    `/C=IT/O=Test Scheme Operator/CN=${name}`,
  ]);
  return {
    key: readFileSync(keyPath, "utf-8"),
    certificate: readFileSync(certPath, "utf-8"),
  };
}

beforeAll(() => {
  const directory = mkdtempSync(join(tmpdir(), "xmlsec-test-"));
  try {
    const ec = generate(directory, "ec", [
      "-algorithm",
      "EC",
      "-pkeyopt",
      "ec_paramgen_curve:P-256",
    ]);
    ecKey = ec.key;
    ecCert = ec.certificate;
    const rsa = generate(directory, "rsa", [
      "-algorithm",
      "RSA",
      "-pkeyopt",
      "rsa_keygen_bits:2048",
    ]);
    rsaKey = rsa.key;
    rsaCert = rsa.certificate;
    otherCert = generate(directory, "other", [
      "-algorithm",
      "EC",
      "-pkeyopt",
      "ec_paramgen_curve:P-256",
    ]).certificate;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("signEnveloped", () => {
  it("produces a signature it can verify itself", () => {
    const signed = signEnveloped(DOCUMENT, {
      privateKeyPem: ecKey,
      certificatePem: ecCert,
      signingTime: new Date("2026-08-03T10:00:00Z"),
    });
    const result = verifyEnveloped(signed);
    expect(result.findings).toEqual([]);
    expect(result.valid).toBe(true);
    expect(result.signingTime).toBe("2026-08-03T10:00:00Z");
    expect(result.signatureAlgorithm).toBe(SIGNATURE_ECDSA_SHA256);
  });

  it("signs with RSA as well as ECDSA", () => {
    const signed = signEnveloped(DOCUMENT, {
      privateKeyPem: rsaKey,
      certificatePem: rsaCert,
    });
    expect(verifyEnveloped(signed).valid).toBe(true);
  });

  it("leaves the original document bytes untouched", () => {
    const signed = signEnveloped(DOCUMENT, {
      privateKeyPem: ecKey,
      certificatePem: ecCert,
    });
    const before = signed.slice(0, signed.indexOf("<ds:Signature"));
    expect(DOCUMENT.startsWith(before.trimEnd())).toBe(true);
  });

  it("appends the signature inside the document element", () => {
    const signed = signEnveloped(DOCUMENT, {
      privateKeyPem: ecKey,
      certificatePem: ecCert,
    });
    expect(signed.indexOf("<ds:Signature")).toBeLessThan(
      signed.lastIndexOf("</Root>"),
    );
    expect(signed.trimEnd().endsWith("</Root>")).toBe(true);
  });

  it("uses the transforms and algorithms TS 119 612 Annex B requires", () => {
    const signed = signEnveloped(DOCUMENT, {
      privateKeyPem: ecKey,
      certificatePem: ecCert,
    });
    expect(signed).toContain(
      `<ds:CanonicalizationMethod Algorithm="${C14N_EXCLUSIVE}"/>`,
    );
    const documentReference = signed.slice(
      signed.indexOf("<ds:Reference"),
      signed.indexOf("</ds:Reference>"),
    );
    expect(documentReference).toContain('URI=""');
    expect(
      documentReference.indexOf(TRANSFORM_ENVELOPED_SIGNATURE),
    ).toBeLessThan(documentReference.indexOf(C14N_EXCLUSIVE));
    expect(signed).toContain(`Type="${REFERENCE_TYPE_SIGNED_PROPERTIES}"`);
    expect(signed).toContain(`<ds:DigestMethod Algorithm="${DIGEST_SHA256}"/>`);
  });

  it("carries SigningTime and SigningCertificateV2 in SignedProperties", () => {
    const signed = signEnveloped(DOCUMENT, {
      privateKeyPem: ecKey,
      certificatePem: ecCert,
      signingTime: new Date("2026-08-03T10:00:00Z"),
    });
    expect(signed).toContain(
      "<xades:SigningTime>2026-08-03T10:00:00Z</xades:SigningTime>",
    );
    expect(signed).toContain("<xades:SigningCertificateV2>");
    expect(signed).toContain("<xades:IssuerSerialV2>");
  });

  it("puts exactly one certificate in ds:KeyInfo", () => {
    const signed = signEnveloped(DOCUMENT, {
      privateKeyPem: ecKey,
      certificatePem: ecCert,
    });
    expect(signed.match(/<ds:X509Certificate>/g)).toHaveLength(1);
  });

  it("refuses a signature Id that is not an XML Name", () => {
    expect(() =>
      signEnveloped(DOCUMENT, {
        privateKeyPem: ecKey,
        certificatePem: ecCert,
        signatureId: "not a name' or '1'='1",
      }),
    ).toThrow(XmlSecError);
  });

  it("refuses a document that is not well-formed", () => {
    expect(() =>
      signEnveloped("<Root>", {
        privateKeyPem: ecKey,
        certificatePem: ecCert,
      }),
    ).toThrow(XmlSecError);
  });

  it("is deterministic in everything but the signature value", () => {
    const options = {
      privateKeyPem: ecKey,
      certificatePem: ecCert,
      signingTime: new Date("2026-08-03T10:00:00Z"),
    };
    const strip = (xml: string) =>
      xml.replace(/<ds:SignatureValue>[^<]*<\/ds:SignatureValue>/, "");
    expect(strip(signEnveloped(DOCUMENT, options))).toBe(
      strip(signEnveloped(DOCUMENT, options)),
    );
  });
});

describe("verifyEnveloped", () => {
  function signed(): string {
    return signEnveloped(DOCUMENT, {
      privateKeyPem: ecKey,
      certificatePem: ecCert,
      signingTime: new Date("2026-08-03T10:00:00Z"),
    });
  }

  it("detects a changed document", () => {
    const tampered = signed().replace("first", "tampered");
    const result = verifyEnveloped(tampered);
    expect(result.valid).toBe(false);
    expect(result.findings.join(" ")).toContain("document changed");
  });

  it("detects a changed signing time", () => {
    const tampered = signed().replace(
      "2026-08-03T10:00:00Z",
      "2020-01-01T00:00:00Z",
    );
    const result = verifyEnveloped(tampered);
    expect(result.valid).toBe(false);
    expect(result.findings.join(" ")).toContain("signed properties changed");
  });

  it("detects a substituted signing certificate", () => {
    const original = signed();
    const certificateBase64 = Buffer.from(
      otherCert.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""),
      "base64",
    ).toString("base64");
    const tampered = original.replace(
      /<ds:X509Certificate>[^<]*<\/ds:X509Certificate>/,
      `<ds:X509Certificate>${certificateBase64}</ds:X509Certificate>`,
    );
    const result = verifyEnveloped(tampered);
    expect(result.valid).toBe(false);
    expect(result.findings.join(" ")).toContain("SigningCertificateV2");
  });

  it("detects a truncated signature value", () => {
    const tampered = signed().replace(
      /<ds:SignatureValue>[^<]*<\/ds:SignatureValue>/,
      "<ds:SignatureValue>AAAA</ds:SignatureValue>",
    );
    expect(verifyEnveloped(tampered).valid).toBe(false);
  });

  it("rejects a document with no signature", () => {
    const result = verifyEnveloped(DOCUMENT);
    expect(result.valid).toBe(false);
    expect(result.findings).toEqual(["The document carries no ds:Signature."]);
  });

  it("rejects a plain XMLDSig signature with no SignedProperties", () => {
    const withoutXades = signed().replace(
      /<ds:Reference Id="[^"]*-ref-signed-properties"[\s\S]*?<\/ds:Reference>/,
      "",
    );
    const result = verifyEnveloped(withoutXades);
    expect(result.valid).toBe(false);
    expect(result.findings.join(" ")).toContain("not XAdES-B-B");
  });

  it("rejects inclusive canonicalisation of SignedInfo", () => {
    const inclusive = signed().replace(
      `<ds:CanonicalizationMethod Algorithm="${C14N_EXCLUSIVE}"/>`,
      '<ds:CanonicalizationMethod Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"/>',
    );
    const result = verifyEnveloped(inclusive);
    expect(result.valid).toBe(false);
    expect(result.findings.join(" ")).toContain("exc-c14n");
  });

  it("reports malformed XML rather than throwing", () => {
    const result = verifyEnveloped("<Root>");
    expect(result.valid).toBe(false);
    expect(result.findings.length).toBe(1);
  });

  it("reports the signer's certificate and fingerprint", () => {
    const result = verifyEnveloped(signed());
    expect(result.certificateFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(result.certificateBase64Der).toBe(
      ecCert.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""),
    );
  });
});
