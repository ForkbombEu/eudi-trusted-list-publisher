#!/usr/bin/env node
import { Command } from "commander";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import * as crypto from "node:crypto";
import {
  compile,
  validateAuthoring,
  validateEtsiStruct,
  sign,
  serializeCompactJAdES,
  serializeSignedLoTE,
  verify,
  publish,
  PublicationStore,
  PublicationError,
} from "../core/index.js";
import type { AuthoringInput, LoTEDocument } from "../core/index.js";

const ASCII_ART = `
╔══════════════════════════════════════════╗
║     EUDI Trusted List Publisher          ║
║     TS 119 602 LoTE — Wallet Provider    ║
╚══════════════════════════════════════════╝
`;

const program = new Command();

program
  .name("trusted-list-publisher")
  .description("TS 119 602 JSON LoTE publisher for the Wallet Provider profile")
  .version("0.1.0")
  .addHelpText("before", ASCII_ART);

function readJsonFile(path: string): unknown {
  const content = readFileSync(path, "utf-8");
  return JSON.parse(content);
}

function writeOutput(
  data: string,
  outputPath: string | undefined,
  stdout: NodeJS.WriteStream,
): void {
  if (outputPath) {
    const absPath = resolve(outputPath);
    // Ensure parent directory exists
    const parent = dirname(absPath);
    if (!existsSync(parent)) {
      process.stderr.write(
        JSON.stringify({
          status: "error",
          message: `Output directory does not exist: ${parent}`,
        }) + "\n",
      );
      process.exit(1);
    }
    writeFileSync(absPath, data, "utf-8");
  } else {
    stdout.write(data);
    if (!data.endsWith("\n")) stdout.write("\n");
  }
}

function exitWithDiagnostic(
  code: number,
  diagnostic: Record<string, unknown>,
): never {
  process.stderr.write(JSON.stringify(diagnostic) + "\n");
  process.exit(code);
}

async function importSigningKey(keyPem: string): Promise<globalThis.CryptoKey> {
  if (keyPem.includes("-----BEGIN")) {
    const privateKey = crypto.createPrivateKey(keyPem);
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
  const jwk = JSON.parse(keyPem);
  return crypto.subtle.importKey(
    "jwk",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    jwk as any,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  ) as Promise<globalThis.CryptoKey>;
}

program
  .command("compile")
  .description("Compile authoring input into an unsigned deterministic LoTE")
  .requiredOption("-i, --input <path>", "Authoring input JSON file")
  .option("-o, --output <path>", "Output file (default: stdout)")
  .action(async (options) => {
    try {
      const input = readJsonFile(options.input) as AuthoringInput;
      const authoringResult = await validateAuthoring(input);
      if (!authoringResult.valid) {
        exitWithDiagnostic(2, {
          status: "error",
          phase: "authoring-validation",
          findings: authoringResult.findings,
        });
      }

      const result = compile(input);
      const etsiResult = await validateEtsiStruct(result.document);
      if (!etsiResult.valid) {
        exitWithDiagnostic(3, {
          status: "error",
          phase: "etsi-validation",
          findings: etsiResult.findings,
        });
      }

      const output = JSON.stringify(result.document, null, 2);
      writeOutput(output, options.output, process.stdout);
    } catch (e) {
      exitWithDiagnostic(1, {
        status: "error",
        message: e instanceof Error ? e.message : "Unknown error",
      });
    }
  });

program
  .command("validate")
  .description("Validate authoring input or ETSI LoTE structure")
  .requiredOption("-i, --input <path>", "Input JSON file to validate")
  .option("--authoring", "Validate as authoring input (default)")
  .option("--etsi", "Validate as ETSI LoTE structure")
  .action(async (options) => {
    try {
      const data = readJsonFile(options.input);

      if (options.etsi) {
        const result = await validateEtsiStruct(data);
        const diag = {
          status: result.valid ? "ok" : "error",
          phase: "etsi-validation",
          findings: result.findings,
        };
        process.stderr.write(JSON.stringify(diag) + "\n");
        if (!result.valid) process.exit(3);
        process.stdout.write(JSON.stringify({ valid: true }) + "\n");
      } else {
        const result = await validateAuthoring(data);
        const diag = {
          status: result.valid ? "ok" : "error",
          phase: "authoring-validation",
          findings: result.findings,
        };
        process.stderr.write(JSON.stringify(diag) + "\n");
        if (!result.valid) process.exit(2);
        process.stdout.write(JSON.stringify({ valid: true }) + "\n");
      }
    } catch (e) {
      exitWithDiagnostic(1, {
        status: "error",
        message: e instanceof Error ? e.message : "Unknown error",
      });
    }
  });

program
  .command("sign")
  .description("Sign a compiled LoTE with JAdES Compact Baseline B")
  .requiredOption("-i, --input <path>", "Compiled LoTE JSON file")
  .option("-k, --key-file <path>", "Private key file (PEM JWK or PKCS#8)")
  .option("-c, --cert-file <path>", "Signing certificate PEM file")
  .option("-o, --output <path>", "Output file (default: stdout)")
  .option(
    "--format <format>",
    "Output format: compact (default) or detached",
    "compact",
  )
  .action(async (options) => {
    try {
      const document = readJsonFile(options.input) as LoTEDocument;

      let keyPem: string;
      if (options.keyFile) {
        keyPem = readFileSync(options.keyFile, "utf-8");
      } else if (process.env["TLP_SIGNING_KEY"]) {
        keyPem = process.env["TLP_SIGNING_KEY"];
      } else {
        exitWithDiagnostic(4, {
          status: "error",
          message:
            "No signing key provided. Use --key-file or TLP_SIGNING_KEY env var.",
        });
      }

      let certPem: string;
      if (options.certFile) {
        certPem = readFileSync(options.certFile, "utf-8");
      } else if (process.env["TLP_SIGNING_CERT"]) {
        certPem = process.env["TLP_SIGNING_CERT"];
      } else {
        exitWithDiagnostic(4, {
          status: "error",
          message:
            "No certificate provided. Use --cert-file or TLP_SIGNING_CERT env var.",
        });
      }

      const key = await importSigningKey(keyPem);
      const signed = await sign({ document, key, certificatePem: certPem });

      let output: string;
      if (options.format === "detached") {
        output = await serializeSignedLoTE(signed);
      } else {
        output = serializeCompactJAdES(signed);
      }

      writeOutput(output, options.output, process.stdout);
    } catch (e) {
      exitWithDiagnostic(1, {
        status: "error",
        message: e instanceof Error ? e.message : "Unknown error",
      });
    }
  });

program
  .command("verify")
  .description("Verify a signed LoTE")
  .requiredOption(
    "-i, --input <path>",
    "Signed LoTE file (compact JWS or detached format)",
  )
  .option("-c, --cert-file <path>", "Trusted certificate PEM file")
  .action(async (options) => {
    try {
      const content = readFileSync(options.input, "utf-8").trim();
      let compactJws: string;

      if (content.startsWith("{")) {
        const obj = JSON.parse(content);
        if (obj.signature?.protected && obj.signature?.signature) {
          const payloadB64 = Buffer.from(
            JSON.stringify({ LoTE: obj.LoTE }),
          ).toString("base64url");
          compactJws = `${obj.signature.protected}.${payloadB64}.${obj.signature.signature}`;
        } else {
          exitWithDiagnostic(1, {
            status: "error",
            message: "Unrecognized JSON format for signed LoTE",
          });
        }
      } else {
        compactJws = content;
      }

      let certPem: string | undefined;
      if (options.certFile) {
        certPem = readFileSync(options.certFile, "utf-8");
      } else if (process.env["TLP_SIGNING_CERT"]) {
        certPem = process.env["TLP_SIGNING_CERT"];
      }

      const result = await verify({ compactJws, certificatePem: certPem });

      process.stderr.write(
        JSON.stringify({
          status: result.valid ? "ok" : "error",
          findings: result.findings,
        }) + "\n",
      );

      const output = {
        valid: result.valid,
        findings: result.findings,
      };
      process.stdout.write(JSON.stringify(output, null, 2) + "\n");

      if (!result.valid) process.exit(5);
    } catch (e) {
      exitWithDiagnostic(1, {
        status: "error",
        message: e instanceof Error ? e.message : "Unknown error",
      });
    }
  });

program
  .command("publish")
  .description("Publish a signed LoTE to the immutable publication store")
  .requiredOption("-i, --input <path>", "Compact JAdES signed LoTE file")
  .requiredOption("-c, --cert-file <path>", "Expected signer certificate PEM")
  .option(
    "--publication-dir <path>",
    "Publication root directory",
    process.env["TLP_PUBLICATION_DIR"] ?? "./publications",
  )
  .action(async (options) => {
    try {
      const content = readFileSync(options.input, "utf-8").trim();
      const certPem = readFileSync(options.certFile, "utf-8");

      const result = await publish({
        compactJws: content,
        certificatePem: certPem,
      });

      const store = new PublicationStore({
        publicationDir: options.publicationDir,
      });

      const manifestJson = JSON.stringify(result.manifest, null, 2);

      const storeResult = await store.store(
        result,
        content,
        result.loteJson,
        manifestJson,
      );

      if (storeResult.indexWarning) {
        process.stderr.write(
          JSON.stringify({
            status: "published",
            listKey: result.listKey,
            sequenceNumber: result.sequenceNumber,
            signatureValid: result.manifest.signatureValid,
            etsiSchemaValid: result.manifest.etsiSchemaValid,
            signerTrustStatus: result.manifest.signerTrustStatus,
            compactJadesSha256: result.manifest.compactJadesSha256,
            signingCertificateSha256: result.manifest.signingCertificateSha256,
            indexWarning: storeResult.indexWarning,
          }) + "\n",
        );
      } else {
        process.stderr.write(
          JSON.stringify({
            status: "published",
            listKey: result.listKey,
            sequenceNumber: result.sequenceNumber,
            signatureValid: result.manifest.signatureValid,
            etsiSchemaValid: result.manifest.etsiSchemaValid,
            signerTrustStatus: result.manifest.signerTrustStatus,
            compactJadesSha256: result.manifest.compactJadesSha256,
            signingCertificateSha256: result.manifest.signingCertificateSha256,
          }) + "\n",
        );
      }
      process.stdout.write(
        JSON.stringify(
          {
            status: "ok",
            listKey: result.listKey,
            sequenceNumber: result.sequenceNumber,
            signatureValid: result.manifest.signatureValid,
            etsiSchemaValid: result.manifest.etsiSchemaValid,
            signerTrustStatus: result.manifest.signerTrustStatus,
          },
          null,
          2,
        ) + "\n",
      );
    } catch (e) {
      if (e instanceof PublicationError) {
        exitWithDiagnostic(6, {
          status: "error",
          code: e.code,
          message: e.message,
        });
      }
      exitWithDiagnostic(1, {
        status: "error",
        message: e instanceof Error ? e.message : "Unknown error",
      });
    }
  });

program
  .command("serve")
  .description("Start the read-only publication web server")
  .option(
    "--publication-dir <path>",
    "Publication root directory",
    process.env["TLP_PUBLICATION_DIR"] ?? "./publications",
  )
  .option(
    "--host <host>",
    "Bind address",
    process.env["TLP_HOST"] ?? "127.0.0.1",
  )
  .option("--port <port>", "Bind port", process.env["TLP_PORT"] ?? "8080")
  .option(
    "--data-collection-gui",
    "Enable the data-collection/administration GUI",
    process.env["DATA_COLLECTION_GUI"] === "true",
  )
  .option(
    "--authoring-dir <path>",
    "Authoring store directory",
    process.env["AUTHORING_DIR"] ?? "./authoring",
  )
  .option(
    "--admin-token <token>",
    "Administrator access token",
    process.env["TLP_ADMIN_TOKEN"] ?? "",
  )
  .option(
    "--admin-user <user>",
    "Administrator sign-in username (enables the /admin login form)",
    process.env["ADMIN_USER"] ?? "",
  )
  .option(
    "--admin-password <password>",
    "Administrator sign-in password (enables the /admin login form)",
    process.env["ADMIN_PASSWORD"] ?? "",
  )
  .option(
    "--signing-config <path>",
    "Signing configuration file",
    process.env["TLP_SIGNING_CONFIG"] ?? "",
  )
  .option(
    "--certificates-dir <path>",
    "Directory for signing material generated by the administration UI",
    process.env["TLP_CERTIFICATES_DIR"] ?? "",
  )
  .action(async (options) => {
    const { createWebServer } = await import("../web/server.js");

    const host = String(options.host);
    const port = parseInt(String(options.port), 10);

    if (host.includes("://") || host.includes("/")) {
      exitWithDiagnostic(1, {
        status: "error",
        message: `Invalid host: "${host}". Must be an IP or hostname without protocol/path.`,
      });
    }
    if (isNaN(port) || port < 1 || port > 65535) {
      exitWithDiagnostic(1, {
        status: "error",
        message: `Invalid port: "${options.port}". Must be a number between 1 and 65535.`,
      });
    }

    const guiEnabled = options.dataCollectionGui === true;

    const server = createWebServer({
      publicationDir: options.publicationDir,
      host,
      port,
      dataCollectionGui: guiEnabled,
      authoringDir: guiEnabled ? options.authoringDir : undefined,
      adminToken: guiEnabled ? options.adminToken : undefined,
      adminUser: guiEnabled ? options.adminUser : undefined,
      adminPassword: guiEnabled ? options.adminPassword : undefined,
      signingConfigPath: guiEnabled ? options.signingConfig : undefined,
      certificatesDir: guiEnabled ? options.certificatesDir : undefined,
    });

    server.listen(port, host, () => {
      const addr = server.address();
      const bindAddr =
        typeof addr === "object" && addr
          ? `${addr.address}:${addr.port}`
          : `${host}:${port}`;
      process.stderr.write(
        JSON.stringify({ status: "listening", address: bindAddr }) + "\n",
      );
    });

    const shutdown = () => {
      process.stderr.write(JSON.stringify({ status: "shutting_down" }) + "\n");
      server.close(() => {
        process.exit(0);
      });
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });

program.parse();
