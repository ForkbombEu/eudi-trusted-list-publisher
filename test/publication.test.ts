import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import {
  readFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { randomUUID, createHash } from "node:crypto";
import * as crypto from "node:crypto";
import {
  compile,
  sign,
  publish,
  PublicationError,
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
});

afterEach(() => {
  try {
    rmSync(pubDir, { recursive: true, force: true });
  } catch {
    // ok
  }
});

function sha256(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

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

  it("returns loteJson bytes for exact hashing", async () => {
    const result = await publish({
      compactJws: signedCompact,
      certificatePem: testCertPem,
    });
    expect(result.loteJson).toBeDefined();
    expect(result.manifest.loteJsonSha256).toBe(sha256(result.loteJson));
  });

  it("includes certificate metadata", async () => {
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
    const clock = new Date("2026-12-15T12:00:00Z");
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
      "2026-12-15T12:00:00.000Z",
    );
    expect(result1.manifest.compactJadesSha256).toBe(
      result2.manifest.compactJadesSha256,
    );
  });

  it("rejects tampered signature", async () => {
    const parts = signedCompact.split(".");
    const tampered = `${parts[0]}.${parts[1]}.${"AAAA" + parts[2]!.slice(4)}`;
    await expect(
      publish({
        compactJws: tampered,
        certificatePem: testCertPem,
      }),
    ).rejects.toThrow(PublicationError);
  });

  it("rejects tampered payload", async () => {
    const parts = signedCompact.split(".");
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString());
    payload.LoTE.ListAndSchemeInformation.LoTESequenceNumber = 999;
    const tamperedPayload = Buffer.from(JSON.stringify(payload)).toString(
      "base64url",
    );
    const tampered = `${parts[0]}.${tamperedPayload}.${parts[2]}`;
    await expect(
      publish({
        compactJws: tampered,
        certificatePem: testCertPem,
      }),
    ).rejects.toThrow(PublicationError);
  });

  it("rejects invalid compact JWS", async () => {
    await expect(
      publish({
        compactJws: "not-a-valid-jws",
        certificatePem: testCertPem,
      }),
    ).rejects.toThrow(PublicationError);
  });

  it("rejects WE BUILD detached format", async () => {
    await expect(
      publish({
        compactJws: '{"signature":{"protected":"eyJ","signature":"abc"}}',
        certificatePem: testCertPem,
      }),
    ).rejects.toThrow(PublicationError);
  });

  it("rejects wrong certificate key", async () => {
    const { privateKey } = crypto.generateKeyPairSync("ec", {
      namedCurve: "P-256",
    });
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

    await expect(
      publish({
        compactJws: wrongSign.compact,
        certificatePem: testCertPem,
      }),
    ).rejects.toThrow(PublicationError);
  });

  it("rejects expired certificate", async () => {
    // The test cert was generated at test time, so it's valid now.
    // We can't easily make it expired, but we can test the clock injection
    // This test cert is valid for 365 days from 2026-07-28
    const clock = new Date("2030-01-01T00:00:00Z"); // After cert expiry
    await expect(
      publish({
        compactJws: signedCompact,
        certificatePem: testCertPem,
        clock,
      }),
    ).rejects.toThrow(PublicationError);
  });

  it("rejects not-yet-valid certificate", async () => {
    const clock = new Date("2020-01-01T00:00:00Z"); // Before cert validity
    await expect(
      publish({
        compactJws: signedCompact,
        certificatePem: testCertPem,
        clock,
      }),
    ).rejects.toThrow(PublicationError);
  });
});

describe("PublicationStore", () => {
  it("does not create publication directory on construction", () => {
    const freshDir = resolve(tmpdir(), `fresh-${randomUUID()}`);
    try {
      new PublicationStore({ publicationDir: freshDir });
      // Constructor should NOT auto-create the directory
      expect(existsSync(freshDir)).toBe(false);
    } finally {
      try {
        rmSync(freshDir, { recursive: true, force: true });
      } catch {}
    }
  });

  it("stores and loads a publication", async () => {
    const result = await publish({
      compactJws: signedCompact,
      certificatePem: testCertPem,
    });
    const store = new PublicationStore({ publicationDir: pubDir });
    store.store(
      result,
      signedCompact,
      result.loteJson,
      JSON.stringify(result.manifest, null, 2),
    );

    const keys = store.listKeys();
    expect(keys.length).toBe(1);
    expect(keys[0]).toBe(result.listKey);

    const index = store.loadIndex(result.listKey);
    expect(index).not.toBeNull();
    expect(index!.versions.length).toBe(1);
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
    const store = new PublicationStore({ publicationDir: pubDir });
    store.store(
      result,
      signedCompact,
      result.loteJson,
      JSON.stringify(result.manifest, null, 2),
    );
    // Second store with identical content should not throw
    store.store(
      result,
      signedCompact,
      result.loteJson,
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
    const store = new PublicationStore({ publicationDir: pubDir });
    store.store(
      result1,
      signedCompact,
      result1.loteJson,
      JSON.stringify(result1.manifest, null, 2),
    );

    const modified = { ...AUTHORING };
    modified.scheme.schemeName = [{ lang: "en", value: "Different" }];
    const doc2 = compile(modified).document;
    const signed2 = await sign({
      document: doc2,
      key: testKey,
      certificatePem: testCertPem,
    });
    const result2 = await publish({
      compactJws: signed2.compact,
      certificatePem: testCertPem,
    });

    if (result2.listKey === result1.listKey) {
      expect(() =>
        store.store(
          result2,
          signed2.compact,
          result2.loteJson,
          JSON.stringify(result2.manifest, null, 2),
        ),
      ).toThrow(/corrupt|already exists/);
    }
  });

  it("rejects unsafe list key", () => {
    const store = new PublicationStore({ publicationDir: pubDir });
    expect(() => {
      store.loadIndex("../../../etc/passwd");
    }).toThrow();
  });

  it("exact artifact hashes match stored files", async () => {
    const result = await publish({
      compactJws: signedCompact,
      certificatePem: testCertPem,
    });
    const store = new PublicationStore({ publicationDir: pubDir });
    store.store(
      result,
      signedCompact,
      result.loteJson,
      JSON.stringify(result.manifest, null, 2),
    );

    const storedJades = readFileSync(
      store.loteJadesPath(result.listKey, 1),
      "utf-8",
    );
    const storedJson = readFileSync(
      store.loteJsonPath(result.listKey, 1),
      "utf-8",
    );

    expect(sha256(storedJades)).toBe(result.manifest.compactJadesSha256);
    expect(sha256(storedJson)).toBe(result.manifest.loteJsonSha256);
    expect(result.manifest.signingCertificateSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects symlink escape directories", async () => {
    mkdirSync(pubDir, { recursive: true });
    const store = new PublicationStore({ publicationDir: pubDir });
    const outsideDir = resolve(tmpdir(), `outside-${randomUUID()}`);
    mkdirSync(outsideDir, { recursive: true });

    const result = await publish({
      compactJws: signedCompact,
      certificatePem: testCertPem,
    });

    // Create a symlink inside the publication dir at the versions path
    const listDir = resolve(pubDir, result.listKey);
    mkdirSync(listDir, { recursive: true });
    const versionsDir = resolve(listDir, "versions");
    symlinkSync(outsideDir, versionsDir, "dir");

    try {
      expect(() => {
        store.store(
          result,
          signedCompact,
          result.loteJson,
          JSON.stringify(result.manifest, null, 2),
        );
      }).toThrow();
    } finally {
      try {
        rmSync(outsideDir, { recursive: true, force: true });
      } catch {}
    }
  });

  it("regenerates corrupt index from manifests", async () => {
    const result = await publish({
      compactJws: signedCompact,
      certificatePem: testCertPem,
    });
    const store = new PublicationStore({ publicationDir: pubDir });
    store.store(
      result,
      signedCompact,
      result.loteJson,
      JSON.stringify(result.manifest, null, 2),
    );

    // Corrupt the index file
    const indexPath = store.indexPath(result.listKey);
    writeFileSync(indexPath, "not valid json {{{", "utf-8");

    // loadIndex should still work by deriving from manifests
    const index = store.loadIndex(result.listKey);
    expect(index).not.toBeNull();
    expect(index!.versions.length).toBe(1);
  });

  it("lists only version directories, ignores staging dirs", async () => {
    const result = await publish({
      compactJws: signedCompact,
      certificatePem: testCertPem,
    });
    const store = new PublicationStore({ publicationDir: pubDir });
    store.store(
      result,
      signedCompact,
      result.loteJson,
      JSON.stringify(result.manifest, null, 2),
    );

    // Create a fake staging directory
    mkdirSync(resolve(pubDir, ".staging_deadbeef"), { recursive: true });

    const keys = store.listKeys();
    expect(keys.length).toBe(1);
    expect(keys[0]).toBe(result.listKey);
  });

  it("handles missing index by deriving from manifests", async () => {
    const result = await publish({
      compactJws: signedCompact,
      certificatePem: testCertPem,
    });
    const store = new PublicationStore({ publicationDir: pubDir });
    store.store(
      result,
      signedCompact,
      result.loteJson,
      JSON.stringify(result.manifest, null, 2),
    );

    // Delete the index
    const indexPath = store.indexPath(result.listKey);
    rmSync(indexPath);

    // loadIndex should derive from manifests
    const index = store.loadIndex(result.listKey);
    expect(index).not.toBeNull();
    expect(index!.versions.length).toBe(1);
  });

  it("idempotent republish fails on corrupt stored lote.json", async () => {
    const result = await publish({
      compactJws: signedCompact,
      certificatePem: testCertPem,
    });
    const store = new PublicationStore({ publicationDir: pubDir });
    store.store(
      result,
      signedCompact,
      result.loteJson,
      JSON.stringify(result.manifest, null, 2),
    );

    // Corrupt lote.json
    writeFileSync(store.loteJsonPath(result.listKey, 1), "corrupted", "utf-8");

    // Republishing identical input should fail with corruption diagnostic
    expect(() =>
      store.store(
        result,
        signedCompact,
        result.loteJson,
        JSON.stringify(result.manifest, null, 2),
      ),
    ).toThrow(/corrupt/);
  });

  it("idempotent republish fails on corrupt manifest.json", async () => {
    const result = await publish({
      compactJws: signedCompact,
      certificatePem: testCertPem,
    });
    const store = new PublicationStore({ publicationDir: pubDir });
    store.store(
      result,
      signedCompact,
      result.loteJson,
      JSON.stringify(result.manifest, null, 2),
    );

    // Corrupt manifest.json
    writeFileSync(
      store.manifestPath(result.listKey, 1),
      "not json {{{{",
      "utf-8",
    );

    expect(() =>
      store.store(
        result,
        signedCompact,
        result.loteJson,
        JSON.stringify(result.manifest, null, 2),
      ),
    ).toThrow(/corrupt/);
  });
});

describe("publication gate tests", () => {
  it("rejects a malformed certificate", async () => {
    await expect(
      publish({
        compactJws: signedCompact,
        certificatePem: "not-a-certificate",
      }),
    ).rejects.toThrow();
  });

  it("rejects a correctly signed but ETSI-invalid payload", async () => {
    // Create a valid JWS but with a payload that passes crypto but fails ETSI schema
    const { document } = compile(AUTHORING);
    // @ts-expect-error intentionally invalid
    document.LoTE.ListAndSchemeInformation.LoTEVersionIdentifier =
      "not-a-number";
    const signed = await sign({
      document,
      key: testKey,
      certificatePem: testCertPem,
    });

    await expect(
      publish({
        compactJws: signed.compact,
        certificatePem: testCertPem,
      }),
    ).rejects.toThrow("ETSI schema validation failed");
  });

  it("uses injected verification clock deterministically", async () => {
    const clock = new Date("2026-12-15T12:00:00Z");
    const result = await publish({
      compactJws: signedCompact,
      certificatePem: testCertPem,
      clock,
    });
    expect(result.manifest.publicationTimestamp).toBe(
      "2026-12-15T12:00:00.000Z",
    );
  });
});
