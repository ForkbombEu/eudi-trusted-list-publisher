import { describe, it, expect } from "vitest";
import { readFileSync, mkdirSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { createPublicKey, randomBytes, X509Certificate } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { IncomingMessage } from "node:http";
import { get as httpGetRaw } from "node:http";
import {
  CERTIFICATE_INPUT_MESSAGES,
  checkCertificateSubjectOrganisation,
  classifyCertificateInput,
  parseAndValidateSubmission,
} from "../src/core/authoring/index.js";
import {
  certificateGuideHtml,
  CERTIFICATE_FIELD_LABEL,
  CERTIFICATE_GUIDE_PATH,
  CERTIFICATE_GUIDE_TITLE,
} from "../src/web/views/certificate-guide.js";
import {
  pidProviderFormHtml,
  walletProviderFormHtml,
} from "../src/web/views/onboarding.js";
import { createWebServer } from "../src/web/server.js";
import type { ServerConfig } from "../src/web/server.js";

const fixture = (name: string): string =>
  readFileSync(resolve(import.meta.dirname, "fixtures", name), "utf-8");

const TEST_CERT = fixture("test-cert.pem");
const TEST_KEY = fixture("test-key.pem");
const TEST_CSR = fixture("test-csr.pem");
const TEST_PUBLIC_KEY = createPublicKey(TEST_KEY)
  .export({ type: "spki", format: "pem" })
  .toString();

/** The organisation in test-cert.pem, which submissions must match. */
const CERT_ORGANISATION = "Test";

/*
  A PKCS#12 PFX is SEQUENCE { version INTEGER 3, authSafe ContentInfo, ... } and
  its authSafe carries the pkcs7-data OID 1.2.840.113549.1.7.1. Those are the
  bytes the detector looks for, and they are reproduced here rather than shipped
  as a .p12 fixture: the repository must not carry certificate/key bundles.
  Verified against a real `openssl pkcs12 -export` output during development.
*/
function syntheticPkcs12Base64(): string {
  const pkcs7Data = Buffer.from([
    0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x01,
  ]);
  const contents = Buffer.concat([
    Buffer.from([0x02, 0x01, 0x03]), // version 3
    Buffer.from([0x30, 0x28]), // authSafe ContentInfo SEQUENCE
    pkcs7Data,
    Buffer.alloc(0x28 - pkcs7Data.length, 0),
  ]);
  const der = Buffer.concat([
    Buffer.from([0x30, 0x82]),
    Buffer.from([contents.length >> 8, contents.length & 0xff]),
    contents,
  ]);
  return der.toString("base64");
}

function walletFields(
  entityName: string,
  certificatePem: string,
): Record<string, string> {
  return {
    targetListKey: "eu_test",
    entityName,
    entityStreetAddress: "1 Test Street",
    entityCountry: "IT",
    entityInformationURI: "https://provider.example/info",
    entityEmail: "trust@entity.example",
    entityTelephone: "+39 02 1234567",
    "service[0].serviceType": "issuance",
    "service[0].serviceName": "Issuance",
    "service[0].certificatePem": certificatePem,
    "service[0].serviceUniqueIdentifier": "https://provider.example/svc/1",
  };
}

function certificateError(
  entityName: string,
  certificatePem: string,
): string | undefined {
  const parsed = parseAndValidateSubmission(
    walletFields(entityName, certificatePem),
    "eu_test",
  );
  if (parsed.valid) return undefined;
  return parsed.errors.find((e) => e.field === "service[0].certificatePem")
    ?.message;
}

function httpGet(
  url: string,
): Promise<{ status: number; body: string; headers: Record<string, string> }> {
  return new Promise((res, reject) => {
    httpGetRaw(new URL(url), (response: IncomingMessage) => {
      let body = "";
      response.on("data", (chunk: Buffer) => (body += chunk.toString()));
      response.on("end", () =>
        res({
          status: response.statusCode ?? 0,
          body,
          headers: response.headers as Record<string, string>,
        }),
      );
    }).on("error", reject);
  });
}

function startServer(
  config: ServerConfig,
): Promise<{ url: string; stop: () => Promise<void> }> {
  return new Promise((res, reject) => {
    const server = createWebServer(config);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      res({
        url: `http://127.0.0.1:${address.port}`,
        stop: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
    server.on("error", reject);
  });
}

function tmpDir(): string {
  const path = join(tmpdir(), `tlp-cert-${randomBytes(8).toString("hex")}`);
  mkdirSync(path, { recursive: true });
  return path;
}

// ============================================================
// 1. Input classification
// ============================================================
describe("classifyCertificateInput", () => {
  it("accepts a self-signed X.509 PEM certificate", () => {
    const result = classifyCertificateInput(TEST_CERT);
    expect(result.kind).toBe("certificate");
    expect(result.message).toBeNull();
    expect(result.certificate).toBeInstanceOf(X509Certificate);
  });

  it("accepts a certificate with surrounding whitespace", () => {
    expect(classifyCertificateInput(`\n\n  ${TEST_CERT}\n\n`).kind).toBe(
      "certificate",
    );
  });

  it("names a private key", () => {
    const result = classifyCertificateInput(TEST_KEY);
    expect(result.kind).toBe("private-key");
    expect(result.message).toBe(
      "This is a private key. Upload the X.509 certificate instead.",
    );
  });

  it("names an RSA private key", () => {
    const result = classifyCertificateInput(
      "-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----",
    );
    expect(result.kind).toBe("private-key");
  });

  it("names an encrypted private key", () => {
    expect(
      classifyCertificateInput(
        "-----BEGIN ENCRYPTED PRIVATE KEY-----\nAAAA\n-----END ENCRYPTED PRIVATE KEY-----",
      ).kind,
    ).toBe("private-key");
  });

  it("rejects a combined key-and-certificate file as a private key", () => {
    const result = classifyCertificateInput(`${TEST_KEY}\n${TEST_CERT}`);
    expect(result.kind).toBe("private-key");
    expect(result.certificate).toBeNull();
  });

  it("names a public key", () => {
    const result = classifyCertificateInput(TEST_PUBLIC_KEY);
    expect(result.kind).toBe("public-key");
    expect(result.message).toBe(
      "This is a public key, not an X.509 certificate.",
    );
  });

  it("names a certificate-signing request", () => {
    const result = classifyCertificateInput(TEST_CSR);
    expect(result.kind).toBe("certificate-request");
    expect(result.message).toBe(
      "This is a certificate-signing request, not a certificate.",
    );
  });

  it("names a PEM-labelled PKCS#12 bundle", () => {
    const result = classifyCertificateInput(
      "-----BEGIN PKCS12-----\nAAAA\n-----END PKCS12-----",
    );
    expect(result.kind).toBe("pkcs12");
    expect(result.message).toBe(
      "Convert or extract the certificate to PEM before uploading.",
    );
  });

  it("names a base64 PKCS#12 bundle with no PEM armor", () => {
    expect(classifyCertificateInput(syntheticPkcs12Base64()).kind).toBe(
      "pkcs12",
    );
  });

  it("names a base64 PKCS#12 bundle wrapped over several lines", () => {
    const wrapped = syntheticPkcs12Base64().replace(/(.{64})/g, "$1\n");
    expect(classifyCertificateInput(wrapped).kind).toBe("pkcs12");
  });

  it("reports an empty field", () => {
    expect(classifyCertificateInput("   ").kind).toBe("empty");
    expect(classifyCertificateInput("").message).toBe(
      "Certificate is required.",
    );
  });

  it("reports a PEM certificate block that cannot be parsed", () => {
    const result = classifyCertificateInput(
      "-----BEGIN CERTIFICATE-----\nA\n-----END CERTIFICATE-----",
    );
    expect(result.kind).toBe("unparseable-certificate");
    expect(result.certificate).toBeNull();
  });

  it("reports bare DER base64 as not PEM", () => {
    const der = Buffer.from(
      TEST_CERT.replace(/-----[^-]+-----/g, "").replace(/\s/g, ""),
      "base64",
    ).toString("base64");
    const result = classifyCertificateInput(der);
    expect(result.kind).toBe("unknown");
    expect(result.message).toContain("-----BEGIN CERTIFICATE-----");
  });

  it("reports arbitrary text as not PEM", () => {
    expect(classifyCertificateInput("my certificate").kind).toBe("unknown");
  });

  it("does not guess at an unrecognised PEM label", () => {
    expect(
      classifyCertificateInput(
        "-----BEGIN SOMETHING ELSE-----\nAAAA\n-----END SOMETHING ELSE-----",
      ).kind,
    ).toBe("unknown");
  });

  it("exposes one message per rejected kind", () => {
    expect(Object.keys(CERTIFICATE_INPUT_MESSAGES).sort()).toEqual([
      "certificate-request",
      "empty",
      "pkcs12",
      "private-key",
      "public-key",
      "unknown",
      "unparseable-certificate",
    ]);
  });
});

// ============================================================
// 2. Subject organisation
// ============================================================
describe("checkCertificateSubjectOrganisation", () => {
  const certificate = new X509Certificate(TEST_CERT);

  it("accepts an organisation equal to the Trusted Entity Name", () => {
    expect(
      checkCertificateSubjectOrganisation(certificate, CERT_ORGANISATION),
    ).toBeNull();
  });

  it("names both values on a mismatch", () => {
    const message = checkCertificateSubjectOrganisation(
      certificate,
      "Other Provider",
    );
    expect(message).toContain(`"${CERT_ORGANISATION}"`);
    expect(message).toContain('"Other Provider"');
  });

  it("is case sensitive and does not tolerate padding", () => {
    expect(
      checkCertificateSubjectOrganisation(certificate, "test"),
    ).not.toBeNull();
    expect(
      checkCertificateSubjectOrganisation(
        certificate,
        ` ${CERT_ORGANISATION} `,
      ),
    ).toBeNull();
  });

  it("reports a subject that carries no organisation at all", () => {
    const message = checkCertificateSubjectOrganisation(
      new X509Certificate(fixture("test-cert-no-organisation.pem")),
      "Some Provider",
    );
    expect(message).toContain("has no organisation (O)");
    expect(message).toContain("No Organisation Service");
    expect(message).toContain('"Some Provider"');
  });

  it("matches an organisation that is not the first subject attribute", () => {
    // test-cert2.pem subject is CN, O, OU.
    expect(
      checkCertificateSubjectOrganisation(
        new X509Certificate(fixture("test-cert2.pem")),
        "Test",
      ),
    ).toBeNull();
  });

  it("skips the check when no entity name was supplied", () => {
    expect(checkCertificateSubjectOrganisation(certificate, "  ")).toBeNull();
  });
});

// ============================================================
// 3. Submission parser
// ============================================================
describe("submission parser certificate validation", () => {
  it("accepts a self-signed certificate whose O is the Trusted Entity Name", () => {
    const parsed = parseAndValidateSubmission(
      walletFields(CERT_ORGANISATION, TEST_CERT),
      "eu_test",
    );
    expect(parsed.valid).toBe(true);
  });

  it("rejects a private key with the private-key message", () => {
    expect(certificateError(CERT_ORGANISATION, TEST_KEY)).toBe(
      "This is a private key. Upload the X.509 certificate instead.",
    );
  });

  it("rejects a public key with the public-key message", () => {
    expect(certificateError(CERT_ORGANISATION, TEST_PUBLIC_KEY)).toBe(
      "This is a public key, not an X.509 certificate.",
    );
  });

  it("rejects a signing request with the CSR message", () => {
    expect(certificateError(CERT_ORGANISATION, TEST_CSR)).toBe(
      "This is a certificate-signing request, not a certificate.",
    );
  });

  it("rejects a PKCS#12 bundle with the conversion message", () => {
    expect(certificateError(CERT_ORGANISATION, syntheticPkcs12Base64())).toBe(
      "Convert or extract the certificate to PEM before uploading.",
    );
  });

  it("still requires a certificate", () => {
    expect(certificateError(CERT_ORGANISATION, "")).toBe(
      "Certificate is required.",
    );
  });

  it("rejects a certificate whose subject does not identify the provider", () => {
    const message = certificateError("Example Wallet Provider", TEST_CERT);
    expect(message).toContain(`"${CERT_ORGANISATION}"`);
    expect(message).toContain('"Example Wallet Provider"');
  });

  it("applies the same rules to PID Provider submissions", () => {
    const fields = walletFields("Example PID Provider", TEST_KEY);
    fields.responsibleMemberState = "DK";
    const parsed = parseAndValidateSubmission(
      fields,
      "eu_test",
      "pid-providers",
    );
    expect(parsed.valid).toBe(false);
    if (parsed.valid) return;
    expect(
      parsed.errors.find((e) => e.field === "service[0].certificatePem")
        ?.message,
    ).toBe("This is a private key. Upload the X.509 certificate instead.");
  });

  it("reports the failing service index when several are submitted", () => {
    const fields = walletFields(CERT_ORGANISATION, TEST_CERT);
    fields["service[1].serviceType"] = "revocation";
    fields["service[1].serviceName"] = "Revocation";
    fields["service[1].certificatePem"] = TEST_KEY;
    fields["service[1].serviceUniqueIdentifier"] =
      "https://provider.example/svc/2";
    const parsed = parseAndValidateSubmission(fields, "eu_test");
    expect(parsed.valid).toBe(false);
    if (parsed.valid) return;
    expect(parsed.errors.map((e) => e.field)).toEqual([
      "service[1].certificatePem",
    ]);
  });
});

// ============================================================
// 4. Onboarding forms
// ============================================================
describe("certificate field on the onboarding forms", () => {
  for (const [name, html] of [
    ["Wallet Provider", walletProviderFormHtml({}, {}, [])],
    ["PID Provider", pidProviderFormHtml({}, {}, [])],
  ] as const) {
    it(`${name} form uses the Service Digital Identity label`, () => {
      expect(html).toContain(CERTIFICATE_FIELD_LABEL);
      expect(html).not.toContain("Self-Signed Certificate (PEM)");
    });

    it(`${name} form keeps the certificatePem field name`, () => {
      expect(html).toContain('name="service[0].certificatePem"');
    });

    it(`${name} form shows the help text next to the field`, () => {
      expect(html).toContain("Upload an X.509 certificate beginning with");
      expect(html).toContain("Never upload the private key.");
    });

    it(`${name} form links the Certificate creation guide`, () => {
      expect(html).toContain(
        `<a href="${CERTIFICATE_GUIDE_PATH}">Certificate creation guide</a>`,
      );
    });

    it(`${name} form places the guide link inside the certificate field group`, () => {
      const field = html.slice(
        html.indexOf('name="service[0].certificatePem"'),
      );
      const group = field.slice(0, field.indexOf("</div>"));
      expect(group).toContain(CERTIFICATE_GUIDE_PATH);
    });
  }
});

// ============================================================
// 5. Certificate creation guide page
// ============================================================
describe("certificate creation guide", () => {
  const html = certificateGuideHtml();

  it("explains ServiceDigitalIdentity and why the list needs the certificate", () => {
    expect(html).toContain("ServiceDigitalIdentity");
    expect(html).toContain("Wallet Solution Issuance");
    expect(html).toContain("PID Issuance");
  });

  it("distinguishes the container formats", () => {
    expect(html).toContain("PKCS#8");
    expect(html).toContain("PKCS#10");
    expect(html).toContain("PKCS#12");
    expect(html).toContain("An <em>encoding</em>, not a type of certificate");
  });

  it("covers self-signed and CA-issued certificates", () => {
    expect(html).toContain("self-signed");
    expect(html).toContain("CA-issued");
  });

  it("documents the RFC 5280 WRPAC CA certificate requirements", () => {
    for (const requirement of [
      "basicConstraints=critical,CA:TRUE",
      "keyUsage=critical,keyCertSign",
      "SubjectKeyIdentifier",
      "AuthorityKeyIdentifier",
      "non-self-signed",
    ])
      expect(html).toContain(requirement);
  });

  it("keeps the OpenSSL workflow central", () => {
    for (const command of [
      "openssl genpkey",
      "ec_paramgen_curve:P-256",
      "openssl pkey",
      "openssl req",
      "openssl x509",
      "openssl pkcs12",
      "openssl sha256",
      "-inform DER",
      "basicConstraints=critical,CA:FALSE",
      "keyUsage=critical,digitalSignature",
      "subjectKeyIdentifier=hash",
    ])
      expect(html).toContain(command);
  });

  it("names exactly which file to upload", () => {
    expect(html).toContain("Upload <code>service-certificate.pem</code>");
    expect(html).toContain("service-private-key.pem");
    expect(html).toContain("service-public-key.pem");
  });

  it("requires O to be the Trusted Entity Name", () => {
    expect(html).toContain("Trusted Entity Name");
    expect(html).toContain("<code>O</code>");
  });

  it("lists the rejection messages the parser produces", () => {
    for (const message of [
      CERTIFICATE_INPUT_MESSAGES["private-key"],
      CERTIFICATE_INPUT_MESSAGES["public-key"],
      CERTIFICATE_INPUT_MESSAGES["certificate-request"],
      CERTIFICATE_INPUT_MESSAGES.pkcs12,
    ])
      expect(html).toContain(message);
  });

  it("escapes the shell variables in the OpenSSL commands", () => {
    expect(html).toContain("${ORGANISATION_NAME}");
    expect(html).toContain("${COUNTRY_CODE}");
    expect(html).not.toContain("undefined");
  });
});

// ============================================================
// 6. Routing and the footer Resources column
// ============================================================
describe("certificate guide routing", () => {
  it("serves the guide and links it under Resources with the GUI enabled", async () => {
    const publicationDir = tmpDir();
    const authoringDir = tmpDir();
    const { url, stop } = await startServer({
      publicationDir,
      authoringDir,
      dataCollectionGui: true,
      adminToken: "guide",
    });
    try {
      const guide = await httpGet(`${url}${CERTIFICATE_GUIDE_PATH}`);
      expect(guide.status).toBe(200);
      expect(guide.headers["content-type"]).toContain("text/html");
      expect(guide.body).toContain(`<title>${CERTIFICATE_GUIDE_TITLE}`);
      expect(guide.body).toContain(CERTIFICATE_FIELD_LABEL);
      expect(guide.body).toContain("openssl genpkey");

      const home = await httpGet(`${url}/`);
      const resources = home.body.slice(
        home.body.indexOf("<h5>Resources</h5>"),
      );
      expect(resources.slice(0, resources.indexOf("</div>"))).toContain(
        `<a href="${CERTIFICATE_GUIDE_PATH}">${CERTIFICATE_GUIDE_TITLE}</a>`,
      );
    } finally {
      await stop();
      rmSync(publicationDir, { recursive: true, force: true });
      rmSync(authoringDir, { recursive: true, force: true });
    }
  });

  it("serves the guide with the GUI disabled", async () => {
    const publicationDir = tmpDir();
    const { url, stop } = await startServer({ publicationDir });
    try {
      const guide = await httpGet(`${url}${CERTIFICATE_GUIDE_PATH}`);
      expect(guide.status).toBe(200);
      const home = await httpGet(`${url}/`);
      expect(home.body).toContain(`<a href="${CERTIFICATE_GUIDE_PATH}">`);
    } finally {
      await stop();
      rmSync(publicationDir, { recursive: true, force: true });
    }
  });

  it("does not shadow the API reference routes", async () => {
    const publicationDir = tmpDir();
    const { url, stop } = await startServer({ publicationDir });
    try {
      expect((await httpGet(`${url}/docs`)).status).toBe(200);
      expect((await httpGet(`${url}/docs/reference`)).status).toBe(200);
      expect((await httpGet(`${url}/docs/nothing-here`)).status).toBe(404);
    } finally {
      await stop();
      rmSync(publicationDir, { recursive: true, force: true });
    }
  });
});
