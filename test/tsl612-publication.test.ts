import { beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TrustedListStore } from "../src/core/publication/tsl-store.js";
import { publishTrustedList } from "../src/core/tsl612/publish.js";
import { verifyTrustedList } from "../src/core/tsl612/sign.js";
import { sha2FileContent } from "../src/core/publication/tsl-manifest.js";
import type { TrustedListInput } from "../src/core/tsl612/model.js";
import {
  EU_LOTL_LOCATION,
  EU_LOTL_SCHEME_RULES,
  EU_LOTL_SCHEME_TERRITORY,
  EU_LOTL_TSL_TYPE,
  SVCSTATUS_DEPRECATED_AT_NATIONAL_LEVEL,
  SVCSTATUS_RECOGNISED_AT_NATIONAL_LEVEL,
  SVCTYPE_EAA,
  TSL_MEDIA_TYPE,
} from "../src/core/tsl612/constants.js";

const TERRITORY = "IT";
const OPERATOR = "Publication Test Operator";
const LIST_KEY = "it_publication_test_operator";

let key: string;
let certificate: string;
let certificateDer: string;
let material: string;

beforeAll(() => {
  material = mkdtempSync(join(tmpdir(), "tsl612-pub-material-"));
  const keyPath = join(material, "k.pem");
  const certPath = join(material, "c.pem");
  const configPath = join(material, "c.cnf");
  writeFileSync(
    configPath,
    `[req]\ndistinguished_name=dn\nprompt=no\n[dn]\nC=${TERRITORY}\nO=${OPERATOR}\nCN=signer\n[ext]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nsubjectKeyIdentifier=hash\n`,
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
  ]);
  key = readFileSync(keyPath, "utf-8");
  certificate = readFileSync(certPath, "utf-8");
  certificateDer = Buffer.from(
    certificate.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""),
    "base64",
  ).toString("base64");
});

function input(
  sequenceNumber: number,
  serviceStatus: string = SVCSTATUS_RECOGNISED_AT_NATIONAL_LEVEL,
): TrustedListInput {
  return {
    schemeInformation: {
      sequenceNumber,
      schemeTerritory: TERRITORY,
      schemeOperatorName: OPERATOR,
      schemeOperatorAddress: {
        streetAddress: "Via Roma 1",
        locality: "Roma",
        countryName: TERRITORY,
      },
      schemeOperatorElectronicAddress: {
        email: "op@example.it",
        website: "https://example.it",
      },
      schemeName: `${TERRITORY}:${OPERATOR}`,
      schemeInformationUri: "https://example.it/scheme",
      nationalSchemeRulesUri: "https://example.it/rules",
      policyOrLegalNoticeUri: "https://example.it/policy",
      distributionPointUri: "https://example.it/trusted-list.xml",
      listIssueDateTime: "2026-08-03T10:00:00Z",
      nextUpdate: "2026-12-03T10:00:00Z",
      lotlPointer: {
        location: EU_LOTL_LOCATION,
        certificatesBase64Der: [certificateDer],
        schemeOperatorNames: [OPERATOR],
        schemeTypeCommunityRules: EU_LOTL_SCHEME_RULES,
        schemeTerritory: EU_LOTL_SCHEME_TERRITORY,
        tslType: EU_LOTL_TSL_TYPE,
        mimeType: TSL_MEDIA_TYPE,
      },
    },
    providers: [
      {
        tspName: OPERATOR,
        tspTradeNames: ["VATIT-12345678901"],
        tspAddress: {
          streetAddress: "Via Milano 2",
          locality: "Milano",
          countryName: TERRITORY,
        },
        tspElectronicAddress: {
          email: "info@example.it",
          website: "https://provider.example.it",
        },
        tspInformationUri: "https://provider.example.it/practices",
        services: [
          {
            serviceTypeIdentifier: SVCTYPE_EAA,
            serviceName: "Publication Test EAA Issuance",
            digitalIdentity: { x509CertificateBase64Der: certificateDer },
            serviceStatus,
            statusStartingTime: "2026-08-03T10:00:00Z",
          },
        ],
      },
    ],
  };
}

function withStore<T>(body: (store: TrustedListStore, root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), "tsl612-pub-"));
  try {
    return body(new TrustedListStore({ publicationDir: root }), root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function publish(
  store: TrustedListStore,
  sequenceNumber: number,
  serviceStatus?: string,
) {
  return publishTrustedList({
    store,
    listKey: LIST_KEY,
    family: "eaa-providers",
    input: input(sequenceNumber, serviceStatus),
    privateKeyPem: key,
    certificatePem: certificate,
    publishedAt: new Date("2026-08-03T11:00:00Z"),
    signingTime: new Date("2026-08-03T11:00:00Z"),
  });
}

describe("TS 119 612 publication store", () => {
  it("stores exactly the four files a version has", () => {
    withStore((store) => {
      const published = publish(store, 1);
      const files = readdirSync(
        store.versionDir(LIST_KEY, published.sequenceNumber),
      ).sort();
      expect(files).toEqual([
        "manifest.json",
        "trusted-list.sha2",
        "trusted-list.xml",
      ]);
      store.writeInspectorEvaluation(LIST_KEY, 1, "{}\n");
      expect(readdirSync(store.versionDir(LIST_KEY, 1)).sort()).toEqual([
        "inspector.json",
        "manifest.json",
        "trusted-list.sha2",
        "trusted-list.xml",
      ]);
    });
  });

  it("writes a .sha2 that is the digest of the exact XML bytes", () => {
    withStore((store) => {
      publish(store, 1);
      const xmlBytes = readFileSync(store.xmlPath(LIST_KEY, 1));
      const sha2 = readFileSync(store.sha2Path(LIST_KEY, 1), "utf-8");
      const expected = createHash("sha256").update(xmlBytes).digest("hex");
      expect(sha2).toBe(expected);
      /* The file is the digest, with nothing around it. */
      expect(sha2).toMatch(/^[0-9a-f]{64}$/);
      expect(sha2).toBe(sha2FileContent(xmlBytes.toString("utf-8")));
    });
  });

  it("records the XML hash and TSL metadata in the manifest", () => {
    withStore((store) => {
      const published = publish(store, 1);
      const manifest = published.manifest;
      expect(manifest.standard).toBe("TS 119 612");
      expect(manifest.artifactFormat).toBe("XML / XAdES-B-B");
      expect(manifest.family).toBe("eaa-providers");
      expect(manifest.trustedListXmlSha256).toBe(
        createHash("sha256")
          .update(readFileSync(store.xmlPath(LIST_KEY, 1)))
          .digest("hex"),
      );
      expect(manifest.trustedList.tslVersionIdentifier).toBe(6);
      expect(manifest.trustedList.schemeTerritory).toBe(TERRITORY);
      expect(manifest.trustedList.serviceTypes).toEqual([SVCTYPE_EAA]);
      expect(manifest.schemaValid).toBe(true);
      expect(manifest.signatureValid).toBe(true);
      expect(manifest.signatureProfile).toBe("XAdES-B-B");
      expect(manifest.signerTrustStatus).toBe("not_evaluated");
      expect(manifest.signingCertificateSha256).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  it("publishes a version that verifies from its stored bytes alone", () => {
    withStore((store) => {
      publish(store, 1);
      const xml = readFileSync(store.xmlPath(LIST_KEY, 1), "utf-8");
      expect(verifyTrustedList(xml).valid).toBe(true);
    });
  });

  it("keeps every version immutable and independently verifiable", () => {
    withStore((store) => {
      publish(store, 1);
      publish(store, 2, SVCSTATUS_DEPRECATED_AT_NATIONAL_LEVEL);
      expect(store.sequences(LIST_KEY)).toEqual([1, 2]);
      for (const sequence of [1, 2]) {
        const outcome = store.loadVersion(LIST_KEY, sequence);
        expect(outcome.artifacts).not.toBeNull();
        expect(verifyTrustedList(outcome.artifacts!.xml).valid).toBe(true);
      }
      const first = store.loadVersion(LIST_KEY, 1).artifacts!.xml;
      expect(first).toContain(SVCSTATUS_RECOGNISED_AT_NATIONAL_LEVEL);
      expect(first).not.toContain(SVCSTATUS_DEPRECATED_AT_NATIONAL_LEVEL);
    });
  });

  it("refuses to overwrite a version with different content", () => {
    withStore((store) => {
      publish(store, 1);
      expect(() =>
        publish(store, 1, SVCSTATUS_DEPRECATED_AT_NATIONAL_LEVEL),
      ).toThrow(/already exists with different content/);
    });
  });

  /*
    ECDSA signatures are randomised, so signing the same list twice produces
    different bytes and is correctly refused. What must succeed is re-storing
    the bytes that were already stored — the retry path after an interrupted
    commit.
  */
  it("accepts re-storing the identical bytes, and refuses a re-signed version", () => {
    withStore((store) => {
      const published = publish(store, 1);
      expect(() =>
        store.store(published.xml, published.manifest),
      ).not.toThrow();
      expect(() => publish(store, 1)).toThrow(
        /already exists with different content/,
      );
    });
  });

  it("reports a version whose XML was edited on disk as unreadable", () => {
    withStore((store) => {
      publish(store, 1);
      const path = store.xmlPath(LIST_KEY, 1);
      writeFileSync(
        path,
        readFileSync(path, "utf-8").replace("Via Milano 2", "Via Milano 3"),
      );
      const outcome = store.loadVersion(LIST_KEY, 1);
      expect(outcome.artifacts).toBeNull();
      expect(outcome.diagnostic).toContain("does not match the hash");
    });
  });

  it("reports a version whose .sha2 was edited as unreadable", () => {
    withStore((store) => {
      publish(store, 1);
      writeFileSync(store.sha2Path(LIST_KEY, 1), "0".repeat(64));
      const outcome = store.loadVersion(LIST_KEY, 1);
      expect(outcome.artifacts).toBeNull();
      expect(outcome.diagnostic).toContain("trusted-list.sha2");
    });
  });

  it("recognises which lists are XML Trusted Lists", () => {
    withStore((store) => {
      publish(store, 1);
      expect(store.isTrustedList(LIST_KEY)).toBe(true);
      expect(store.isTrustedList("some_other_list")).toBe(false);
    });
  });

  it("loads the latest version of a list", () => {
    withStore((store) => {
      publish(store, 1);
      publish(store, 2, SVCSTATUS_DEPRECATED_AT_NATIONAL_LEVEL);
      const latest = store.loadLatest(LIST_KEY);
      expect(latest?.sequenceNumber).toBe(2);
      expect(latest?.artifacts.manifest.sequenceNumber).toBe(2);
    });
  });

  it("returns nothing for a list that was never published", () => {
    withStore((store) => {
      expect(store.loadLatest("absent_list")).toBeNull();
      expect(store.getHighestStoredSequence("absent_list")).toBeNull();
      expect(store.sequences("absent_list")).toEqual([]);
    });
  });

  it("refuses a list key that is not a safe path segment", () => {
    withStore((store) => {
      expect(() => store.versionDir("../escape", 1)).toThrow(/Unsafe list key/);
      expect(store.getHighestStoredSequence("../escape")).toBeNull();
    });
  });
});

process.on("exit", () => {
  if (material) rmSync(material, { recursive: true, force: true });
});
