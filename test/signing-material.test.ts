import { describe, expect, it } from "vitest";
import {
  X509Certificate,
  createPrivateKey,
  createPublicKey,
  randomBytes,
} from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  generateSigningMaterial,
  type GeneratedSigningMaterial,
} from "../src/core/authoring/index.js";
import { createWebServer, type ServerConfig } from "../src/web/server.js";
import { createListFormHtml } from "../src/web/views/list-creation.js";
import { createTrustedListFormHtml } from "../src/web/views/tsl612-list-creation.js";
import { checkTrustedListSigningCertificate } from "../src/core/tsl612/signing-certificate.js";

function temporaryDirectory(): string {
  const path = join(
    tmpdir(),
    `tlp-signing-material-${randomBytes(8).toString("hex")}`,
  );
  mkdirSync(path, { recursive: true });
  return path;
}

function subject(certificate: X509Certificate): Record<string, string> {
  return certificate.toLegacyObject().subject as Record<string, string>;
}

function publicKeyDer(key: ReturnType<typeof createPublicKey>): Buffer {
  return key.export({ format: "der", type: "spki" });
}

function httpPost(
  url: string,
  body: URLSearchParams,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const encoded = body.toString();
    const http = require("node:http");
    const request = http.request(
      target,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": String(Buffer.byteLength(encoded)),
        },
      },
      (response: IncomingMessage) => {
        let responseBody = "";
        response.on(
          "data",
          (chunk: Buffer) => (responseBody += chunk.toString()),
        );
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            body: responseBody,
          }),
        );
      },
    );
    request.on("error", reject);
    request.write(encoded);
    request.end();
  });
}

function startServer(
  config: ServerConfig,
): Promise<{ url: string; stop: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = createWebServer(config);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        stop: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
    server.on("error", reject);
  });
}

describe("generated Trusted List signing material", () => {
  it("creates a matching P-256 key and certificate under the list key", () => {
    const root = temporaryDirectory();
    try {
      const generated: GeneratedSigningMaterial = generateSigningMaterial({
        certificatesDir: root,
        schemeOperatorName: "Example Operator",
        schemeTerritory: "EU",
      });

      expect(generated.listKey).toBe("eu_example_operator");
      expect(generated.keyFile).toBe(
        join(root, "eu_example_operator", "signing-key.pem"),
      );
      expect(generated.certFile).toBe(
        join(root, "eu_example_operator", "signing-cert.pem"),
      );
      expect(statSync(generated.keyFile).mode & 0o777).toBe(0o600);

      const privateKey = createPrivateKey(
        readFileSync(generated.keyFile, "utf-8"),
      );
      const certificate = new X509Certificate(
        readFileSync(generated.certFile, "utf-8"),
      );
      expect(certificate.publicKey.asymmetricKeyType).toBe("ec");
      expect(certificate.publicKey.asymmetricKeyDetails?.namedCurve).toBe(
        "prime256v1",
      );
      expect(subject(certificate)).toMatchObject({
        O: "Example Operator",
        C: "EU",
      });
      expect(publicKeyDer(createPublicKey(privateKey))).toEqual(
        publicKeyDer(certificate.publicKey),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not overwrite signing material for an existing list key", () => {
    const root = temporaryDirectory();
    try {
      const request = {
        certificatesDir: root,
        schemeOperatorName: "Example Operator",
        schemeTerritory: "EU",
      };
      generateSigningMaterial(request);
      expect(() => generateSigningMaterial(request)).toThrow(/already exists/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves subject punctuation without treating it as DN syntax", () => {
    const root = temporaryDirectory();
    try {
      const generated = generateSigningMaterial({
        certificatesDir: root,
        schemeOperatorName: "Example / Operator, S.p.A.",
        schemeTerritory: "EU",
      });
      const certificate = new X509Certificate(
        readFileSync(generated.certFile, "utf-8"),
      );
      expect(subject(certificate).O).toBe("Example / Operator, S.p.A.");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects missing operator data and a non-uppercase territory", () => {
    const root = temporaryDirectory();
    try {
      expect(() =>
        generateSigningMaterial({
          certificatesDir: root,
          schemeOperatorName: "",
          schemeTerritory: "EU",
        }),
      ).toThrow(/operator name/i);
      expect(() =>
        generateSigningMaterial({
          certificatesDir: root,
          schemeOperatorName: "Example Operator",
          schemeTerritory: "eu",
        }),
      ).toThrow(/territory/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("Signing Material administration action", () => {
  it("renders the generation button only when generation is configured", () => {
    expect(createListFormHtml()).not.toContain(
      "/admin/lists/generate-signing-material",
    );
    const enabled = createListFormHtml(undefined, undefined, {
      canGenerateSigningMaterial: true,
    });
    expect(enabled).toContain(
      'formaction="/admin/lists/generate-signing-material"',
    );
    expect(enabled).toContain("Generate key and certificate");
    expect(enabled).toContain("formnovalidate");
  });

  it("uses the entered operator and territory, then prefills both paths", async () => {
    const root = temporaryDirectory();
    const publicationDir = join(root, "publications");
    const authoringDir = join(root, "authoring");
    const certificatesDir = join(root, "certificates");
    const configuredCertificatesDir = `./${relative(
      process.cwd(),
      certificatesDir,
    )}`;
    const signingConfigPath = join(root, "signing-config.json");
    writeFileSync(signingConfigPath, JSON.stringify({ lists: [] }), "utf-8");
    const started = await startServer({
      publicationDir,
      authoringDir,
      certificatesDir: configuredCertificatesDir,
      signingConfigPath,
      dataCollectionGui: true,
      adminToken: "material-token",
    });
    try {
      const response = await httpPost(
        `${started.url}/admin/lists/generate-signing-material?token=material-token`,
        new URLSearchParams({
          family: "wallet-providers",
          schemeName: "Example Wallet List",
          schemeOperatorName: "Generated Operator",
          schemeTerritory: "EU",
          schemeOperatorStreet: "Saved Street 1",
          schemeOperatorCountry: "IT",
          schemeOperatorEmail: "operator@example.eu",
          baseUrl: "https://example.eu/wallet",
        }),
      );
      expect(response.status).toBe(200);
      expect(response.body).toContain("Signing material generated");
      expect(response.body).toContain('value="Saved Street 1"');
      expect(response.body).toContain(
        'value="' +
          `${configuredCertificatesDir}/eu_generated_operator/signing-key.pem` +
          '"',
      );
      expect(response.body).not.toContain(["BEGIN", "PRIVATE KEY"].join(" "));

      const certificate = new X509Certificate(
        readFileSync(
          join(certificatesDir, "eu_generated_operator", "signing-cert.pem"),
          "utf-8",
        ),
      );
      expect(subject(certificate)).toMatchObject({
        O: "Generated Operator",
        C: "EU",
      });
    } finally {
      await started.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("requires administrator authentication", async () => {
    const root = temporaryDirectory();
    const signingConfigPath = join(root, "signing-config.json");
    writeFileSync(signingConfigPath, JSON.stringify({ lists: [] }), "utf-8");
    const started = await startServer({
      publicationDir: join(root, "publications"),
      authoringDir: join(root, "authoring"),
      certificatesDir: join(root, "certificates"),
      signingConfigPath,
      dataCollectionGui: true,
      adminToken: "material-token",
    });
    try {
      const response = await httpPost(
        `${started.url}/admin/lists/generate-signing-material`,
        new URLSearchParams({
          schemeOperatorName: "Generated Operator",
          schemeTerritory: "EU",
        }),
      );
      expect(response.status).toBe(403);
    } finally {
      await started.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("generates a TS 119 612 signer that meets the Scheme Operator profile", () => {
    const root = temporaryDirectory();
    try {
      const material = generateSigningMaterial({
        certificatesDir: root,
        schemeOperatorName: "Trusted List Operator",
        schemeTerritory: "IT",
        profile: "trusted-list",
      });
      expect(material.profile).toBe("trusted-list");
      const certificate = new X509Certificate(
        readFileSync(join(root, material.listKey, "signing-cert.pem"), "utf-8"),
      );
      expect(
        checkTrustedListSigningCertificate(certificate, {
          schemeTerritory: "IT",
          schemeOperatorName: "Trusted List Operator",
        }),
      ).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("leaves the TS 119 602 certificate profile unchanged by default", () => {
    const root = temporaryDirectory();
    try {
      const material = generateSigningMaterial({
        certificatesDir: root,
        schemeOperatorName: "LoTE Operator",
        schemeTerritory: "EU",
      });
      expect(material.profile).toBe("lote");
      const text = readFileSync(
        join(root, material.listKey, "signing-cert.pem"),
        "utf-8",
      );
      const certificate = new X509Certificate(text);
      /* No extended key usage: an EU LoTE signer asserts no signing purpose. */
      expect(certificate.toString()).not.toContain("0.4.0.2231.3.0");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("Signing Material on the Create XML Trusted List form", () => {
  it("starts with a List panel matching the JSON creation form", () => {
    const form = createTrustedListFormHtml();
    const listStart = form.indexOf("<h2>List</h2>");
    const operatorStart = form.indexOf("<h2>Scheme operator</h2>");
    const urisStart = form.indexOf("<h2>Scheme URIs</h2>");

    expect(listStart).toBeGreaterThan(-1);
    expect(listStart).toBeLessThan(operatorStart);
    expect(operatorStart).toBeLessThan(urisStart);

    const listPanel = form.slice(listStart, operatorStart);
    expect(listPanel).toContain("Service profiles accepted");
    expect(listPanel).toContain('name="allowedServiceProfiles"');
    expect(listPanel).toContain(">Trusted List Name");
    expect(listPanel).toContain(">Scheme Territory");
    expect(listPanel).toContain("prefixed with the Scheme Territory");

    const operatorPanel = form.slice(operatorStart, urisStart);
    expect(operatorPanel).not.toContain('id="schemeName"');
    expect(operatorPanel).not.toContain('id="schemeTerritory"');

    const distributionInput = form.match(
      /<input[^>]+id="distributionPointUri"[^>]*>/,
    )?.[0];
    expect(distributionInput).toBeDefined();
    expect(distributionInput).not.toContain(" required");
    expect(form).toContain("/lists/&lt;list-key&gt;/latest/trusted-list.xml");
  });

  it("offers the same box the TS 119 602 form offers, in the same place", () => {
    const jsonForm = createListFormHtml(undefined, undefined, {
      canGenerateSigningMaterial: true,
    });
    const xmlForm = createTrustedListFormHtml(
      {},
      { canGenerateMaterial: true },
    );
    for (const form of [jsonForm, xmlForm]) {
      expect(form).toContain("<h2>Signing Material</h2>");
      expect(form).toContain("Generate key and certificate");
      expect(form).toContain("formnovalidate");
      expect(form).toContain(">Private Key File");
      expect(form).toContain(">Certificate File");
      /* The box sits immediately before the health / broken-fixture card. */
      expect(form.indexOf("<h2>Signing Material</h2>")).toBeLessThan(
        form.search(/<h2>(Health|Intentionally broken test fixture)<\/h2>/),
      );
    }
    expect(xmlForm).toContain(
      'formaction="/admin/trusted-lists/generate-signing-material"',
    );
    expect(
      createTrustedListFormHtml({}, { canGenerateMaterial: false }),
    ).toContain("TLP_CERTIFICATES_DIR");
  });

  it("generates a TS 119 612 signer and prefills both paths", async () => {
    const root = temporaryDirectory();
    const certificatesDir = join(root, "certificates");
    const signingConfigPath = join(root, "signing-config.json");
    writeFileSync(signingConfigPath, JSON.stringify({ lists: [] }), "utf-8");
    const started = await startServer({
      publicationDir: join(root, "publications"),
      authoringDir: join(root, "authoring"),
      certificatesDir,
      signingConfigPath,
      dataCollectionGui: true,
      adminToken: "material-token",
    });
    try {
      const response = await httpPost(
        `${started.url}/admin/trusted-lists/generate-signing-material?token=material-token`,
        new URLSearchParams({
          schemeOperatorName: "XML Operator",
          schemeTerritory: "it",
          schemeName: "IT:XML Operator",
          schemeOperatorStreet: "Saved Street 1",
          allowedServiceProfiles: "eaa",
        }),
      );
      expect(response.status).toBe(200);
      expect(response.body).toContain("Signing material generated");
      /* Every entered value survives the round trip. */
      expect(response.body).toContain('value="Saved Street 1"');
      expect(response.body).toContain(
        `value="${join(certificatesDir, "it_xml_operator", "signing-key.pem")}"`,
      );
      expect(response.body).not.toContain(["BEGIN", "PRIVATE KEY"].join(" "));

      const certificate = new X509Certificate(
        readFileSync(
          join(certificatesDir, "it_xml_operator", "signing-cert.pem"),
          "utf-8",
        ),
      );
      expect(
        checkTrustedListSigningCertificate(certificate, {
          schemeTerritory: "IT",
          schemeOperatorName: "XML Operator",
        }),
      ).toEqual([]);
    } finally {
      await started.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("requires administrator authentication", async () => {
    const root = temporaryDirectory();
    const signingConfigPath = join(root, "signing-config.json");
    writeFileSync(signingConfigPath, JSON.stringify({ lists: [] }), "utf-8");
    const started = await startServer({
      publicationDir: join(root, "publications"),
      authoringDir: join(root, "authoring"),
      certificatesDir: join(root, "certificates"),
      signingConfigPath,
      dataCollectionGui: true,
      adminToken: "material-token",
    });
    try {
      const response = await httpPost(
        `${started.url}/admin/trusted-lists/generate-signing-material`,
        new URLSearchParams({
          schemeOperatorName: "XML Operator",
          schemeTerritory: "IT",
        }),
      );
      expect(response.status).toBe(403);
    } finally {
      await started.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
