import { beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { X509Certificate } from "node:crypto";
import { compileTrustedList } from "../src/core/tsl612/compile.js";
import {
  TslSigningError,
  signTrustedList,
  verifyTrustedList,
} from "../src/core/tsl612/sign.js";
import { checkTrustedListSigningCertificate } from "../src/core/tsl612/signing-certificate.js";
import type { TrustedListInput } from "../src/core/tsl612/model.js";
import {
  EU_LOTL_LOCATION,
  EU_LOTL_SCHEME_RULES,
  EU_LOTL_SCHEME_TERRITORY,
  EU_LOTL_TSL_TYPE,
  SVCSTATUS_RECOGNISED_AT_NATIONAL_LEVEL,
  SVCTYPE_EAA,
  TSL_MEDIA_TYPE,
} from "../src/core/tsl612/constants.js";

const TERRITORY = "IT";
const OPERATOR = "Test Scheme Operator";

interface Material {
  readonly key: string;
  readonly certificate: string;
}

let directory: string;
let conforming: Material;

/**
 * Generates a key and a certificate with the extensions given, so each test can
 * name the one property it is about instead of carrying a fixture file.
 */
function generate(
  name: string,
  extensions: string,
  subject?: string,
): Material {
  const keyPath = join(directory, `${name}.key`);
  const certPath = join(directory, `${name}.crt`);
  const configPath = join(directory, `${name}.cnf`);
  writeFileSync(
    configPath,
    `[req]\ndistinguished_name=dn\nprompt=no\n[dn]\nC=${TERRITORY}\nO=${OPERATOR}\nCN=${name}\n[ext]\n${extensions}\n`,
  );
  execFileSync("openssl", [
    "genpkey",
    "-out",
    keyPath,
    "-algorithm",
    "EC",
    "-pkeyopt",
    "ec_paramgen_curve:P-256",
  ]);
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
    "-config",
    configPath,
    "-extensions",
    "ext",
    ...(subject ? ["-subj", subject] : []),
  ]);
  return {
    key: readFileSync(keyPath, "utf-8"),
    certificate: readFileSync(certPath, "utf-8"),
  };
}

/** A v1 certificate: no extensions at all, which OpenSSL will not add to one. */
function generateV1(name: string): Material {
  const keyPath = join(directory, `${name}.key`);
  const csrPath = join(directory, `${name}.csr`);
  const certPath = join(directory, `${name}.crt`);
  const configPath = join(directory, `${name}.cnf`);
  writeFileSync(
    configPath,
    `[req]\ndistinguished_name=dn\nprompt=no\n[dn]\nC=${TERRITORY}\nO=${OPERATOR}\nCN=${name}\n`,
  );
  execFileSync("openssl", [
    "genpkey",
    "-out",
    keyPath,
    "-algorithm",
    "EC",
    "-pkeyopt",
    "ec_paramgen_curve:P-256",
  ]);
  execFileSync("openssl", [
    "req",
    "-new",
    "-key",
    keyPath,
    "-out",
    csrPath,
    "-config",
    configPath,
  ]);
  execFileSync("openssl", [
    "x509",
    "-req",
    "-in",
    csrPath,
    "-signkey",
    keyPath,
    "-out",
    certPath,
    "-days",
    "365",
  ]);
  return {
    key: readFileSync(keyPath, "utf-8"),
    certificate: readFileSync(certPath, "utf-8"),
  };
}

const CONFORMING_EXTENSIONS =
  "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,nonRepudiation\nsubjectKeyIdentifier=hash\n";

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "tsl612-signing-"));
  conforming = generate("conforming", CONFORMING_EXTENSIONS);
});

function expectation() {
  return { schemeTerritory: TERRITORY, schemeOperatorName: OPERATOR };
}

function trustedList(sequenceNumber = 1): TrustedListInput {
  const certificate = Buffer.from(
    conforming.certificate.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""),
    "base64",
  ).toString("base64");
  return {
    schemeInformation: {
      sequenceNumber,
      schemeTerritory: TERRITORY,
      schemeOperatorName: OPERATOR,
      schemeOperatorAddress: {
        streetAddress: "Via Roma 1",
        locality: "Roma",
        postalCode: "00100",
        countryName: TERRITORY,
      },
      schemeOperatorElectronicAddress: {
        email: "operator@example.it",
        website: "https://example.it",
      },
      schemeName: `${TERRITORY}:${OPERATOR}`,
      schemeInformationUri: "https://example.it/scheme",
      nationalSchemeRulesUri: "https://example.it/scheme-rules",
      policyOrLegalNoticeUri: "https://example.it/policy",
      distributionPointUri: "https://example.it/tl/trusted-list.xml",
      listIssueDateTime: "2026-08-03T10:00:00Z",
      nextUpdate: "2026-12-03T10:00:00Z",
      lotlPointer: {
        location: EU_LOTL_LOCATION,
        certificatesBase64Der: [certificate],
        schemeOperatorNames: ["European Commission"],
        schemeTypeCommunityRules: EU_LOTL_SCHEME_RULES,
        schemeTerritory: EU_LOTL_SCHEME_TERRITORY,
        tslType: EU_LOTL_TSL_TYPE,
        mimeType: TSL_MEDIA_TYPE,
      },
    },
    providers: [
      {
        tspName: "Example Provider",
        tspTradeNames: ["VATIT-12345678901"],
        tspAddress: {
          streetAddress: "Via Milano 2",
          locality: "Milano",
          countryName: TERRITORY,
        },
        tspElectronicAddress: {
          email: "info@provider.example.it",
          website: "https://provider.example.it",
        },
        tspInformationUri: "https://provider.example.it/practices",
        services: [
          {
            serviceTypeIdentifier: SVCTYPE_EAA,
            serviceName: "Example EAA Issuance",
            digitalIdentity: { x509CertificateBase64Der: certificate },
            serviceStatus: SVCSTATUS_RECOGNISED_AT_NATIONAL_LEVEL,
            statusStartingTime: "2026-08-03T10:00:00Z",
          },
        ],
      },
    ],
  };
}

describe("Trusted List Scheme Operator certificate profile", () => {
  it("accepts a conforming certificate", () => {
    expect(
      checkTrustedListSigningCertificate(
        new X509Certificate(conforming.certificate),
        expectation(),
      ),
    ).toEqual([]);
  });

  it("requires subject C to equal the Scheme Territory", () => {
    const findings = checkTrustedListSigningCertificate(
      new X509Certificate(conforming.certificate),
      { schemeTerritory: "FR", schemeOperatorName: OPERATOR },
    );
    expect(findings.join(" ")).toContain("subject country (C)");
  });

  it("requires subject O to equal the Scheme Operator Name", () => {
    const findings = checkTrustedListSigningCertificate(
      new X509Certificate(conforming.certificate),
      { schemeTerritory: TERRITORY, schemeOperatorName: "Someone Else" },
    );
    expect(findings.join(" ")).toContain("subject organisation (O)");
  });

  it("rejects a CA certificate", () => {
    const ca = generate(
      "ca",
      "basicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature\nsubjectKeyIdentifier=hash\n",
    );
    const findings = checkTrustedListSigningCertificate(
      new X509Certificate(ca.certificate),
      expectation(),
    );
    expect(findings.join(" ")).toContain("CA:FALSE");
  });

  /*
    OpenSSL 3 adds a SubjectKeyIdentifier to every v3 certificate it issues, so
    a certificate without one has to be a v1 certificate — which carries no
    extensions at all, and therefore also exercises the absent-keyUsage branch.
  */
  it("requires a SubjectKeyIdentifier and a keyUsage", () => {
    const findings = checkTrustedListSigningCertificate(
      new X509Certificate(generateV1("no-extensions").certificate),
      expectation(),
    );
    expect(findings.join(" ")).toContain("SubjectKeyIdentifier");
    expect(findings.join(" ")).toContain("keyUsage");
  });

  it("rejects a key usage beyond digitalSignature and contentCommitment", () => {
    const wide = generate(
      "wide-usage",
      "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyCertSign\nsubjectKeyIdentifier=hash\n",
    );
    const findings = checkTrustedListSigningCertificate(
      new X509Certificate(wide.certificate),
      expectation(),
    );
    expect(findings.join(" ")).toContain("keyCertSign");
    expect(findings.join(" ")).toContain("only digitalSignature");
  });

  it("accepts contentCommitment on its own", () => {
    const commitment = generate(
      "commitment",
      "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,nonRepudiation\nsubjectKeyIdentifier=hash\n",
    );
    expect(
      checkTrustedListSigningCertificate(
        new X509Certificate(commitment.certificate),
        expectation(),
      ),
    ).toEqual([]);
  });

  it("requires a keyUsage extension", () => {
    const none = generate(
      "no-usage",
      "basicConstraints=critical,CA:FALSE\nsubjectKeyIdentifier=hash\n",
    );
    const findings = checkTrustedListSigningCertificate(
      new X509Certificate(none.certificate),
      expectation(),
    );
    expect(findings.join(" ")).toContain("keyUsage");
  });

  it("accepts an extended key usage that permits TSL signing", () => {
    const eku = generate(
      "eku-tsl",
      `${CONFORMING_EXTENSIONS}extendedKeyUsage=0.4.0.2231.3.0\n`,
    );
    expect(
      checkTrustedListSigningCertificate(
        new X509Certificate(eku.certificate),
        expectation(),
      ),
    ).toEqual([]);
  });

  it("rejects an extended key usage that does not permit TSL signing", () => {
    const eku = generate(
      "eku-other",
      `${CONFORMING_EXTENSIONS}extendedKeyUsage=clientAuth\n`,
    );
    const findings = checkTrustedListSigningCertificate(
      new X509Certificate(eku.certificate),
      expectation(),
    );
    expect(findings.join(" ")).toContain("tslSigning");
  });
});

describe("signTrustedList", () => {
  it("signs, schema-validates and verifies a Trusted List", () => {
    const xml = compileTrustedList(trustedList());
    const result = signTrustedList(xml, {
      privateKeyPem: conforming.key,
      certificatePem: conforming.certificate,
      expectation: expectation(),
      signingTime: new Date("2026-08-03T10:00:00Z"),
    });
    expect(result.schema.valid).toBe(true);
    expect(result.signature.valid).toBe(true);
    expect(result.signature.signingTime).toBe("2026-08-03T10:00:00Z");
    expect(result.signingCertificate.fingerprintSha256).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });

  it("produces a signed list the pinned schemas accept", () => {
    const xml = compileTrustedList(trustedList());
    const signed = signTrustedList(xml, {
      privateKeyPem: conforming.key,
      certificatePem: conforming.certificate,
      expectation: expectation(),
    }).xml;
    const verification = verifyTrustedList(signed);
    expect(verification.schema.findings).toEqual([]);
    expect(verification.signature.findings).toEqual([]);
    expect(verification.valid).toBe(true);
  });

  it("signs an empty first version", () => {
    const input = trustedList();
    const xml = compileTrustedList({
      schemeInformation: input.schemeInformation,
    });
    const signed = signTrustedList(xml, {
      privateKeyPem: conforming.key,
      certificatePem: conforming.certificate,
      expectation: expectation(),
    }).xml;
    expect(verifyTrustedList(signed).valid).toBe(true);
    expect(signed).not.toContain("<TrustServiceProviderList>");
  });

  it("refuses to sign with a certificate outside the profile", () => {
    const xml = compileTrustedList(trustedList());
    const ca = generate(
      "signing-ca",
      "basicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature\nsubjectKeyIdentifier=hash\n",
    );
    expect(() =>
      signTrustedList(xml, {
        privateKeyPem: ca.key,
        certificatePem: ca.certificate,
        expectation: expectation(),
      }),
    ).toThrow(TslSigningError);
  });

  it("names every profile failure at once", () => {
    const xml = compileTrustedList(trustedList());
    try {
      signTrustedList(xml, {
        privateKeyPem: conforming.key,
        certificatePem: conforming.certificate,
        expectation: {
          schemeTerritory: "FR",
          schemeOperatorName: "Someone Else",
        },
      });
      expect.unreachable("signing should have been refused");
    } catch (error) {
      expect(error).toBeInstanceOf(TslSigningError);
      expect((error as TslSigningError).findings).toHaveLength(2);
    }
  });

  it("detects a Trusted List that was edited after signing", () => {
    const xml = compileTrustedList(trustedList());
    const signed = signTrustedList(xml, {
      privateKeyPem: conforming.key,
      certificatePem: conforming.certificate,
      expectation: expectation(),
    }).xml;
    const tampered = signed.replace("Example Provider", "Impostor Provider");
    const verification = verifyTrustedList(tampered);
    expect(verification.valid).toBe(false);
    expect(verification.signature.findings.join(" ")).toContain(
      "document changed",
    );
  });

  it("detects a changed sequence number", () => {
    const signed = signTrustedList(compileTrustedList(trustedList()), {
      privateKeyPem: conforming.key,
      certificatePem: conforming.certificate,
      expectation: expectation(),
    }).xml;
    const tampered = signed.replace(
      "<TSLSequenceNumber>1</TSLSequenceNumber>",
      "<TSLSequenceNumber>2</TSLSequenceNumber>",
    );
    expect(verifyTrustedList(tampered).valid).toBe(false);
  });

  it("keeps every version independently verifiable", () => {
    const first = signTrustedList(compileTrustedList(trustedList(1)), {
      privateKeyPem: conforming.key,
      certificatePem: conforming.certificate,
      expectation: expectation(),
    }).xml;
    const second = signTrustedList(compileTrustedList(trustedList(2)), {
      privateKeyPem: conforming.key,
      certificatePem: conforming.certificate,
      expectation: expectation(),
    }).xml;
    expect(first).not.toBe(second);
    expect(verifyTrustedList(first).valid).toBe(true);
    expect(verifyTrustedList(second).valid).toBe(true);
  });
});

/* The generated material is private, so it never leaves the temporary tree. */
process.on("exit", () => {
  if (directory) rmSync(directory, { recursive: true, force: true });
});
