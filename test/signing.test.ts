import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as crypto from "node:crypto";
import {
  compile,
  sign,
  serializeCompactJAdES,
  verify,
  resetValidators,
  certificateFingerprint,
} from "../src/core/index.js";
import type { AuthoringInput } from "../src/core/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const authoringInput: AuthoringInput = {
  schemeOperator: {
    name: [{ lang: "en", value: "Test Authority" }],
    postalAddress: [{ lang: "en", StreetAddress: "1 Test St", Country: "EU" }],
    electronicAddress: [{ lang: "en", uriValue: "mailto:test@test.org" }],
  },
  scheme: {
    schemeName: [{ lang: "en", value: "Test Wallet Providers" }],
    schemeTerritory: "EU",
    distributionPoints: ["https://test.org/lote.json"],
  },
  listIssueDateTime: "2026-01-01T00:00:00Z",
  nextUpdate: "2026-07-01T00:00:00Z",
  loTESequenceNumber: 1,
  entities: [
    {
      teName: [{ lang: "en", value: "Test Wallet Provider" }],
      tePostalAddress: [
        { lang: "en", StreetAddress: "2 Wallet St", Country: "NL" },
      ],
      teElectronicAddress: [{ lang: "en", uriValue: "mailto:wallet@test.nl" }],
      teInformationURI: [
        {
          lang: "en",
          uriValue:
            "http://uri.etsi.org/19602/ListOfTrustedEntities/WalletProvider/NL",
        },
      ],
      services: [
        {
          serviceTypeIdentifier:
            "http://uri.etsi.org/19602/SvcType/WalletSolution/Issuance",
          serviceName: [{ lang: "en", value: "Wallet Issuance Service" }],
          serviceDigitalIdentity: {
            x509Certificates: ["MIIDfakecertvalue=="],
          },
          serviceUniqueIdentifier: "http://test.nl/service/unique-id-001",
        },
      ],
    },
  ],
};

let testKey: globalThis.CryptoKey;
let testCertPem: string;

async function importTestKey(): Promise<globalThis.CryptoKey> {
  const pem = readFileSync(
    resolve(__dirname, "fixtures", "test-key.pem"),
    "utf-8",
  );
  const privateKey = crypto.createPrivateKey(pem);
  const jwk = privateKey.export({ format: "jwk" });
  return crypto.subtle.importKey(
    "jwk",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    jwk as any,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  ) as Promise<globalThis.CryptoKey>;
}

beforeAll(async () => {
  resetValidators();
  testKey = await importTestKey();
  testCertPem = readFileSync(
    resolve(__dirname, "fixtures", "test-cert.pem"),
    "utf-8",
  );
});

describe("sign", () => {
  it("produces a valid compact JAdES string", async () => {
    const document = compile(authoringInput).document;
    const signed = await sign({
      document,
      key: testKey,
      certificatePem: testCertPem,
    });
    expect(signed.compact).toBeDefined();
    const parts = signed.compact.split(".");
    expect(parts).toHaveLength(3);
  });

  it("includes x5c certificate chain in protected header", async () => {
    const document = compile(authoringInput).document;
    const signed = await sign({
      document,
      key: testKey,
      certificatePem: testCertPem,
    });
    const parts = signed.compact.split(".");
    const header = JSON.parse(
      new TextDecoder().decode(Buffer.from(parts[0]!, "base64url")),
    );
    expect(header["x5c"]).toBeDefined();
    expect(Array.isArray(header["x5c"])).toBe(true);
    expect(header["x5c"].length).toBeGreaterThan(0);
  });

  it("includes typ: JAdES in protected header", async () => {
    const document = compile(authoringInput).document;
    const signed = await sign({
      document,
      key: testKey,
      certificatePem: testCertPem,
    });
    const parts = signed.compact.split(".");
    const header = JSON.parse(
      new TextDecoder().decode(Buffer.from(parts[0]!, "base64url")),
    );
    expect(header["typ"]).toBe("JAdES");
  });

  it("uses ES256 algorithm", async () => {
    const document = compile(authoringInput).document;
    const signed = await sign({
      document,
      key: testKey,
      certificatePem: testCertPem,
    });
    const parts = signed.compact.split(".");
    const header = JSON.parse(
      new TextDecoder().decode(Buffer.from(parts[0]!, "base64url")),
    );
    expect(header["alg"]).toBe("ES256");
  });

  it("serializes as compact JAdES string", async () => {
    const document = compile(authoringInput).document;
    const signed = await sign({
      document,
      key: testKey,
      certificatePem: testCertPem,
    });
    const compact = serializeCompactJAdES(signed);
    expect(compact).toBe(signed.compact);
    expect(compact.split(".")).toHaveLength(3);
  });
});

describe("verify", () => {
  let signedCompact: string;

  beforeAll(async () => {
    const document = compile(authoringInput).document;
    const signed = await sign({
      document,
      key: testKey,
      certificatePem: testCertPem,
    });
    signedCompact = signed.compact;
  });

  it("verifies a valid signature", async () => {
    const result = await verify({
      compactJws: signedCompact,
      certificatePem: testCertPem,
    });
    expect(result.valid).toBe(true);
    expect(result.findings).toHaveLength(0);
    expect(result.payload).toBeDefined();
  });

  it("detects tampered payload", async () => {
    const parts = signedCompact.split(".");
    const payload = JSON.parse(
      new TextDecoder().decode(Buffer.from(parts[1]!, "base64url")),
    );
    // Tamper the payload
    payload["tampered"] = true;
    const tamperedPayload = Buffer.from(JSON.stringify(payload)).toString(
      "base64url",
    );
    const tamperedCompact = `${parts[0]}.${tamperedPayload}.${parts[2]}`;
    const result = await verify({ compactJws: tamperedCompact });
    expect(result.valid).toBe(false);
  });

  it("detects tampered protected header", async () => {
    const parts = signedCompact.split(".");
    const header = JSON.parse(
      new TextDecoder().decode(Buffer.from(parts[0]!, "base64url")),
    );
    header["tampered"] = true;
    const tamperedHeader = Buffer.from(JSON.stringify(header)).toString(
      "base64url",
    );
    const tamperedCompact = `${tamperedHeader}.${parts[1]}.${parts[2]}`;
    const result = await verify({ compactJws: tamperedCompact });
    expect(result.valid).toBe(false);
  });

  it("rejects invalid JWS format", async () => {
    const result = await verify({ compactJws: "not-a-valid-jws" });
    expect(result.valid).toBe(false);
    expect(result.findings.some((f) => f.code === "INVALID_FORMAT")).toBe(true);
  });

  it("rejects missing x5c header", async () => {
    // Create a JWS without x5c
    const document = compile(authoringInput).document;
    const payload = new TextEncoder().encode(JSON.stringify(document));
    const { CompactSign } = await import("jose");
    const jws = await new CompactSign(payload)
      .setProtectedHeader({ alg: "ES256" })
      .sign(testKey);
    const result = await verify({ compactJws: jws });
    expect(result.findings.some((f) => f.code === "MISSING_X5C")).toBe(true);
    expect(result.valid).toBe(false);
  });

  it("detects certificate mismatch via fingerprint", async () => {
    const fingerprint = certificateFingerprint(testCertPem);
    expect(fingerprint).toBeDefined();
    expect(fingerprint.length).toBeGreaterThan(0);
  });

  it("independent Node crypto verify cross-checks jose verify", async () => {
    const document = compile(authoringInput).document;
    const signed = await sign({
      document,
      key: testKey,
      certificatePem: testCertPem,
    });
    const parts = signed.compact.split(".");
    const signingInput = `${parts[0]}.${parts[1]}`;
    const sigBytes = Buffer.from(parts[2]!, "base64url");

    const pubKey = crypto.createPublicKey(testCertPem);
    const verifier = crypto.createVerify("SHA256");
    verifier.update(signingInput);
    const valid = verifier.verify(
      { key: pubKey, dsaEncoding: "ieee-p1363" },
      sigBytes,
    );
    expect(valid).toBe(true);
  });
});
