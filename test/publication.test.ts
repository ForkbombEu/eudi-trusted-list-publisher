import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { readFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import * as crypto from "node:crypto";
import {
  compile,
  sign,
  publish,
  PublicationStore,
  resetValidators,
} from "../src/core/index.js";
import type { AuthoringInput } from "../src/core/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const AUTHORING: AuthoringInput = {
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
let signedCompact: string;
let pubDir: string;

async function importTestKey(): Promise<globalThis.CryptoKey> {
  const pem = readFileSync(
    resolve(__dirname, "fixtures", "test-key.pem"),
    "utf-8",
  );
  const pk = crypto.createPrivateKey(pem);
  const jwk = pk.export({ format: "jwk" });
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

  const document = compile(AUTHORING).document;
  const signed = await sign({
    document,
    key: testKey,
    certificatePem: testCertPem,
  });
  signedCompact = signed.compact;
});

beforeEach(() => {
  pubDir = resolve(tmpdir(), `test-pub-${randomUUID()}`);
  mkdirSync(pubDir, { recursive: true });
});

afterEach(() => {
  try {
    rmSync(pubDir, { recursive: true, force: true });
  } catch {
    // ok
  }
});

describe("publish", () => {
  it("publishes a valid signed LoTE", async () => {
    const result = await publish({
      compactJws: signedCompact,
      certificatePem: testCertPem,
    });
    expect(result.listKey.length).toBeGreaterThan(0);
    expect(result.sequenceNumber).toBe(1);
    expect(result.manifest.signatureValid).toBe(true);
    expect(result.manifest.etsiSchemaValid).toBe(true);
    expect(result.manifest.signerTrustStatus).toBe("not_evaluated");
  });

  it("sets signerTrustStatus to not_evaluated", async () => {
    const result = await publish({
      compactJws: signedCompact,
      certificatePem: testCertPem,
    });
    expect(result.manifest.signerTrustStatus).toBe("not_evaluated");
  });

  it("computes artifact hashes", async () => {
    const result = await publish({
      compactJws: signedCompact,
      certificatePem: testCertPem,
    });
    expect(result.manifest.compactJadesSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.manifest.loteJsonSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.manifest.signingCertificateSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects tampered signature", async () => {
    const parts = signedCompact.split(".");
    const tampered = `${parts[0]}.${parts[1]}.${"AAAA" + parts[2]!.slice(4)}`;
    const result = await publish({
      compactJws: tampered,
      certificatePem: testCertPem,
    });
    expect(result.manifest.signatureValid).toBe(false);
  });

  it("rejects tampered payload", async () => {
    const parts = signedCompact.split(".");
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString());
    payload.LoTE.ListAndSchemeInformation.LoTESequenceNumber = 999;
    const tamperedPayload = Buffer.from(JSON.stringify(payload)).toString(
      "base64url",
    );
    const tampered = `${parts[0]}.${tamperedPayload}.${parts[2]}`;
    const result = await publish({
      compactJws: tampered,
      certificatePem: testCertPem,
    });
    expect(result.manifest.signatureValid).toBe(false);
  });

  it("rejects invalid compact JWS", async () => {
    await expect(
      publish({
        compactJws: "not-a-valid-jws",
        certificatePem: testCertPem,
      }),
    ).rejects.toThrow();
  });

  it("rejects WE BUILD detached format", async () => {
    await expect(
      publish({
        compactJws: '{"signature":{"protected":"eyJ","signature":"abc"}}',
        certificatePem: testCertPem,
      }),
    ).rejects.toThrow();
  });

  it("rejects wrong expected certificate", async () => {
    const { privateKey } = crypto.generateKeyPairSync("ec", {
      namedCurve: "P-256",
    });
    // The certificate fingerprint won't match, causing verification to note a mismatch
    // but the cryptographic verification will fail since the key is different
    const wrongKeyJwk = privateKey.export({ format: "jwk" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wrongKey = (await crypto.subtle.importKey(
      "jwk",
      wrongKeyJwk as any,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    )) as globalThis.CryptoKey;

    const doc = compile(AUTHORING).document;
    const wrongSign = await sign({
      document: doc,
      key: wrongKey,
      certificatePem: testCertPem,
    });

    const result = await publish({
      compactJws: wrongSign.compact,
      certificatePem: testCertPem,
    });
    expect(result.manifest.signatureValid).toBe(false);
  });

  it("records certificate metadata", async () => {
    const result = await publish({
      compactJws: signedCompact,
      certificatePem: testCertPem,
    });
    expect(result.manifest.certificateSubject).toBeTruthy();
    expect(result.manifest.certificateIssuer).toBeTruthy();
    expect(result.manifest.certificateValidFrom).toBeTruthy();
    expect(result.manifest.certificateValidTo).toBeTruthy();
  });

  it("produces deterministic manifest with injected clock", async () => {
    const clock = new Date("2026-06-15T12:00:00Z");
    const result1 = await publish({
      compactJws: signedCompact,
      certificatePem: testCertPem,
      clock,
    });
    const result2 = await publish({
      compactJws: signedCompact,
      certificatePem: testCertPem,
      clock,
    });
    expect(result1.manifest.publicationTimestamp).toBe(
      "2026-06-15T12:00:00.000Z",
    );
    expect(result1.manifest.compactJadesSha256).toBe(
      result2.manifest.compactJadesSha256,
    );
  });
});

describe("PublicationStore", () => {
  let store: PublicationStore;

  beforeEach(() => {
    store = new PublicationStore({ publicationDir: pubDir });
  });

  it("stores and loads a publication", async () => {
    const result = await publish({
      compactJws: signedCompact,
      certificatePem: testCertPem,
    });

    const loteJson = JSON.stringify(
      JSON.parse(
        Buffer.from(signedCompact.split(".")[1]!, "base64url").toString(),
      ),
      null,
      2,
    );
    store.store(
      result,
      signedCompact,
      loteJson,
      JSON.stringify(result.manifest, null, 2),
    );

    const keys = store.listKeys();
    expect(keys.length).toBe(1);
    expect(keys[0]).toBe(result.listKey);

    const index = store.loadIndex(result.listKey);
    expect(index).not.toBeNull();
    expect(index!.versions.length).toBe(1);
    expect(index!.versions[0]!.sequenceNumber).toBe(1);
    expect(index!.versions[0]!.signerTrustStatus).toBe("not_evaluated");

    const manifest = store.loadManifest(result.listKey, 1);
    expect(manifest).not.toBeNull();
    expect(manifest!.sequenceNumber).toBe(1);
  });

  it("supports idempotent republishing", async () => {
    const result = await publish({
      compactJws: signedCompact,
      certificatePem: testCertPem,
    });

    const loteJson = JSON.stringify(
      JSON.parse(
        Buffer.from(signedCompact.split(".")[1]!, "base64url").toString(),
      ),
      null,
      2,
    );

    store.store(
      result,
      signedCompact,
      loteJson,
      JSON.stringify(result.manifest, null, 2),
    );
    // Second store with identical content should not throw
    store.store(
      result,
      signedCompact,
      loteJson,
      JSON.stringify(result.manifest, null, 2),
    );

    const index = store.loadIndex(result.listKey);
    expect(index!.versions.length).toBe(1);
  });

  it("rejects conflicting sequence number reuse", async () => {
    const result1 = await publish({
      compactJws: signedCompact,
      certificatePem: testCertPem,
    });
    const loteJson1 = JSON.stringify(
      JSON.parse(
        Buffer.from(signedCompact.split(".")[1]!, "base64url").toString(),
      ),
      null,
      2,
    );
    store.store(
      result1,
      signedCompact,
      loteJson1,
      JSON.stringify(result1.manifest, null, 2),
    );

    // Create a different signed LoTE with the same sequence number
    const modified = { ...AUTHORING };
    modified.loTESequenceNumber = 1; // same seq
    modified.scheme.schemeName = [{ lang: "en", value: "Different" }];
    const doc2 = compile(modified).document;
    const signed2 = await sign({
      document: doc2,
      key: testKey,
      certificatePem: testCertPem,
    });
    const loteJson2 = JSON.stringify(
      JSON.parse(
        Buffer.from(signed2.compact.split(".")[1]!, "base64url").toString(),
      ),
      null,
      2,
    );

    const result2 = await publish({
      compactJws: signed2.compact,
      certificatePem: testCertPem,
    });

    // Same list key, different content - should fail
    if (result2.listKey === result1.listKey) {
      expect(() =>
        store.store(
          result2,
          signed2.compact,
          loteJson2,
          JSON.stringify(result2.manifest, null, 2),
        ),
      ).toThrow(/already exists with different content/);
    }
  });

  it("rejects unsafe list key characters", () => {
    expect(() => {
      store.loadIndex("../../../etc/passwd");
    }).toThrow();
  });

  it("writes exact artifact hashes to disk", async () => {
    const result = await publish({
      compactJws: signedCompact,
      certificatePem: testCertPem,
    });
    const loteJson = JSON.stringify(
      JSON.parse(
        Buffer.from(signedCompact.split(".")[1]!, "base64url").toString(),
      ),
      null,
      2,
    );
    store.store(
      result,
      signedCompact,
      loteJson,
      JSON.stringify(result.manifest, null, 2),
    );

    const jadesPath = store.loteJadesPath(result.listKey, 1);
    expect(existsSync(jadesPath)).toBe(true);
    const storedJades = readFileSync(jadesPath, "utf-8");
    expect(storedJades).toBe(signedCompact);

    const jsonPath = store.loteJsonPath(result.listKey, 1);
    expect(existsSync(jsonPath)).toBe(true);
  });
});
