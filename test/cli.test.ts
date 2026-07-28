import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  unlinkSync,
  existsSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));

const SCHEME_PATH = resolve(
  __dirname,
  "..",
  "examples",
  "wallet-provider",
  "scheme.json",
);

const CERT_PATH = resolve(__dirname, "fixtures", "test-cert.pem");
const KEY_PATH = resolve(__dirname, "fixtures", "test-key.pem");

function runCli(args: string[]): {
  stdout: string;
  stderr: string;
  status: number;
} {
  const result = spawnSync(
    "node",
    [resolve(__dirname, "..", "dist", "src", "cli", "main.js"), ...args],
    {
      encoding: "utf-8",
      timeout: 30000,
    },
  );
  return {
    stdout: result.stdout?.trim() ?? "",
    stderr: result.stderr?.trim() ?? "",
    status: result.status ?? 1,
  };
}

describe("CLI", () => {
  describe("compile", () => {
    it("compiles valid input to stdout", () => {
      const result = runCli(["compile", "-i", SCHEME_PATH]);
      expect(result.status).toBe(0);
      const output = JSON.parse(result.stdout);
      expect(output.LoTE).toBeDefined();
    });

    it("writes output to file", () => {
      const outPath = resolve(tmpdir(), `test-lote-${randomUUID()}.json`);
      try {
        const result = runCli(["compile", "-i", SCHEME_PATH, "-o", outPath]);
        expect(result.status).toBe(0);
        expect(existsSync(outPath)).toBe(true);
        const content = JSON.parse(readFileSync(outPath, "utf-8"));
        expect(content.LoTE).toBeDefined();
      } finally {
        if (existsSync(outPath)) unlinkSync(outPath);
      }
    });

    it("rejects invalid input with exit code 2", () => {
      const result = runCli([
        "compile",
        "-i",
        resolve(__dirname, "fixtures", "test-cert.pem"),
      ]);
      expect(result.status).toBe(1); // parse error
    });
  });

  describe("validate", () => {
    it("validates authoring input", () => {
      const result = runCli(["validate", "-i", SCHEME_PATH, "--authoring"]);
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout).valid).toBe(true);
    });

    it("validates compiled ETSI structure", () => {
      // First compile to get valid LoTE
      const compileResult = runCli(["compile", "-i", SCHEME_PATH]);
      expect(compileResult.status).toBe(0);
      const tmpPath = resolve(tmpdir(), `test-validate-${randomUUID()}.json`);
      try {
        writeFileSync(tmpPath, compileResult.stdout, "utf-8");
        const result = runCli(["validate", "-i", tmpPath, "--etsi"]);
        expect(result.status).toBe(0);
        expect(JSON.parse(result.stdout).valid).toBe(true);
      } finally {
        if (existsSync(tmpPath)) unlinkSync(tmpPath);
      }
    });

    it("fails on invalid ETSI structure", () => {
      const tmpPath = resolve(tmpdir(), `test-invalid-${randomUUID()}.json`);
      try {
        writeFileSync(tmpPath, JSON.stringify({ not: "valid" }), "utf-8");
        const result = runCli(["validate", "-i", tmpPath, "--etsi"]);
        expect(result.status).toBe(3);
      } finally {
        if (existsSync(tmpPath)) unlinkSync(tmpPath);
      }
    });
  });

  describe("sign", () => {
    it("signs a compiled LoTE", () => {
      // Compile first
      const compileResult = runCli(["compile", "-i", SCHEME_PATH]);
      expect(compileResult.status).toBe(0);
      const tmpPath = resolve(tmpdir(), `test-sign-in-${randomUUID()}.json`);
      const outPath = resolve(tmpdir(), `test-sign-out-${randomUUID()}.txt`);
      try {
        writeFileSync(tmpPath, compileResult.stdout, "utf-8");
        const signResult = runCli([
          "sign",
          "-i",
          tmpPath,
          "-k",
          KEY_PATH,
          "-c",
          CERT_PATH,
          "-o",
          outPath,
        ]);
        expect(signResult.status).toBe(0);
        expect(existsSync(outPath)).toBe(true);
        const content = readFileSync(outPath, "utf-8").trim();
        // Should be a compact JWS
        expect(content.split(".").length).toBe(3);
      } finally {
        if (existsSync(tmpPath)) unlinkSync(tmpPath);
        if (existsSync(outPath)) unlinkSync(outPath);
      }
    });

    it("signs with detached format", () => {
      const compileResult = runCli(["compile", "-i", SCHEME_PATH]);
      expect(compileResult.status).toBe(0);
      const tmpPath = resolve(tmpdir(), `test-sign-det-${randomUUID()}.json`);
      const outPath = resolve(
        tmpdir(),
        `test-sign-det-out-${randomUUID()}.json`,
      );
      try {
        writeFileSync(tmpPath, compileResult.stdout, "utf-8");
        const result = runCli([
          "sign",
          "-i",
          tmpPath,
          "-k",
          KEY_PATH,
          "-c",
          CERT_PATH,
          "-o",
          outPath,
          "--format",
          "detached",
        ]);
        expect(result.status).toBe(0);
        const content = JSON.parse(readFileSync(outPath, "utf-8"));
        expect(content.signature).toBeDefined();
        expect(content.signature.protected).toBeDefined();
        expect(content.signature.signature).toBeDefined();
        expect(content.LoTE).toBeDefined();
      } finally {
        if (existsSync(tmpPath)) unlinkSync(tmpPath);
        if (existsSync(outPath)) unlinkSync(outPath);
      }
    });

    it("fails without key", () => {
      const compileResult = runCli(["compile", "-i", SCHEME_PATH]);
      expect(compileResult.status).toBe(0);
      const tmpPath = resolve(tmpdir(), `test-nokey-${randomUUID()}.json`);
      try {
        writeFileSync(tmpPath, compileResult.stdout, "utf-8");
        const result = runCli(["sign", "-i", tmpPath, "-c", CERT_PATH]);
        expect(result.status).toBe(4);
      } finally {
        if (existsSync(tmpPath)) unlinkSync(tmpPath);
      }
    });

    it("fails without cert", () => {
      const compileResult = runCli(["compile", "-i", SCHEME_PATH]);
      expect(compileResult.status).toBe(0);
      const tmpPath = resolve(tmpdir(), `test-nocert-${randomUUID()}.json`);
      try {
        writeFileSync(tmpPath, compileResult.stdout, "utf-8");
        const result = runCli(["sign", "-i", tmpPath, "-k", KEY_PATH]);
        expect(result.status).toBe(4);
      } finally {
        if (existsSync(tmpPath)) unlinkSync(tmpPath);
      }
    });
  });

  describe("verify", () => {
    it("verifies a compact JAdES signature", () => {
      // Compile and sign first
      const compileResult = runCli(["compile", "-i", SCHEME_PATH]);
      expect(compileResult.status).toBe(0);
      const compiledPath = resolve(tmpdir(), `test-vfy-c-${randomUUID()}.json`);
      const signedPath = resolve(tmpdir(), `test-vfy-s-${randomUUID()}.txt`);
      try {
        writeFileSync(compiledPath, compileResult.stdout, "utf-8");
        const signResult = runCli([
          "sign",
          "-i",
          compiledPath,
          "-k",
          KEY_PATH,
          "-c",
          CERT_PATH,
          "-o",
          signedPath,
        ]);
        expect(signResult.status).toBe(0);

        const verifyResult = runCli([
          "verify",
          "-i",
          signedPath,
          "-c",
          CERT_PATH,
        ]);
        expect(verifyResult.status).toBe(0);
        const output = JSON.parse(verifyResult.stdout);
        expect(output.valid).toBe(true);
      } finally {
        if (existsSync(compiledPath)) unlinkSync(compiledPath);
        if (existsSync(signedPath)) unlinkSync(signedPath);
      }
    });

    it("fails on tampered signature", () => {
      const compileResult = runCli(["compile", "-i", SCHEME_PATH]);
      expect(compileResult.status).toBe(0);
      const compiledPath = resolve(
        tmpdir(),
        `test-tamp-c-${randomUUID()}.json`,
      );
      const signedPath = resolve(tmpdir(), `test-tamp-s-${randomUUID()}.txt`);
      try {
        writeFileSync(compiledPath, compileResult.stdout, "utf-8");
        const signResult = runCli([
          "sign",
          "-i",
          compiledPath,
          "-k",
          KEY_PATH,
          "-c",
          CERT_PATH,
          "-o",
          signedPath,
        ]);
        expect(signResult.status).toBe(0);

        // Tamper the payload
        const parts = readFileSync(signedPath, "utf-8").trim().split(".");
        const payload = JSON.parse(
          Buffer.from(parts[1]!, "base64url").toString(),
        );
        payload["evil"] = "tampered";
        const tamperedPayload = Buffer.from(JSON.stringify(payload)).toString(
          "base64url",
        );
        const tamperedContent = `${parts[0]}.${tamperedPayload}.${parts[2]}`;
        const tamperedPath = resolve(
          tmpdir(),
          `test-tamp-t-${randomUUID()}.txt`,
        );
        writeFileSync(tamperedPath, tamperedContent, "utf-8");

        const verifyResult = runCli([
          "verify",
          "-i",
          tamperedPath,
          "-c",
          CERT_PATH,
        ]);
        expect(verifyResult.status).toBe(5);
        expect(JSON.parse(verifyResult.stdout).valid).toBe(false);
      } finally {
        if (existsSync(compiledPath)) unlinkSync(compiledPath);
        if (existsSync(signedPath)) unlinkSync(signedPath);
      }
    });

    it("rejects invalid format with exit code 1", () => {
      const badPath = resolve(tmpdir(), `test-bad-${randomUUID()}.txt`);
      try {
        writeFileSync(badPath, "{not valid json", "utf-8");
        const result = runCli(["verify", "-i", badPath]);
        expect(result.status).toBe(1);
      } finally {
        if (existsSync(badPath)) unlinkSync(badPath);
      }
    });

    it("verifies detached format", () => {
      const compileResult = runCli(["compile", "-i", SCHEME_PATH]);
      expect(compileResult.status).toBe(0);
      const compiledPath = resolve(tmpdir(), `test-det-c-${randomUUID()}.json`);
      const detachedPath = resolve(tmpdir(), `test-det-d-${randomUUID()}.json`);
      try {
        writeFileSync(compiledPath, compileResult.stdout, "utf-8");
        const signResult = runCli([
          "sign",
          "-i",
          compiledPath,
          "-k",
          KEY_PATH,
          "-c",
          CERT_PATH,
          "-o",
          detachedPath,
          "--format",
          "detached",
        ]);
        expect(signResult.status).toBe(0);

        const verifyResult = runCli([
          "verify",
          "-i",
          detachedPath,
          "-c",
          CERT_PATH,
        ]);
        expect(verifyResult.status).toBe(0);
        expect(JSON.parse(verifyResult.stdout).valid).toBe(true);
      } finally {
        if (existsSync(compiledPath)) unlinkSync(compiledPath);
        if (existsSync(detachedPath)) unlinkSync(detachedPath);
      }
    });
  });

  describe("publish", () => {
    it("publishes a valid signed LoTE and exits 0", () => {
      const compileResult = runCli(["compile", "-i", SCHEME_PATH]);
      expect(compileResult.status).toBe(0);
      const signedPath = resolve(tmpdir(), `test-pub-cli-${randomUUID()}.txt`);
      const pubDir = resolve(tmpdir(), `test-pubdir-${randomUUID()}`);
      try {
        const compiledPath = resolve(
          tmpdir(),
          `test-comp-${randomUUID()}.json`,
        );
        writeFileSync(compiledPath, compileResult.stdout, "utf-8");
        const signResult = runCli([
          "sign",
          "-i",
          compiledPath,
          "-k",
          KEY_PATH,
          "-c",
          CERT_PATH,
          "-o",
          signedPath,
        ]);
        expect(signResult.status).toBe(0);

        const pubResult = runCli([
          "publish",
          "-i",
          signedPath,
          "-c",
          CERT_PATH,
          "--publication-dir",
          pubDir,
        ]);
        expect(pubResult.status).toBe(0);
        expect(JSON.parse(pubResult.stdout).status).toBe("ok");
        expect(existsSync(pubDir)).toBe(true);
      } finally {
        if (existsSync(signedPath)) unlinkSync(signedPath);
        try {
          rmSync(pubDir, { recursive: true, force: true });
        } catch {
          /* ok */
        }
      }
    });

    it("fails with non-zero exit on invalid signature", () => {
      const compiledPath = resolve(
        tmpdir(),
        `test-badsig-${randomUUID()}.json`,
      );
      const outPath = resolve(tmpdir(), `test-badsig-out-${randomUUID()}.txt`);
      const pubDir = resolve(tmpdir(), `test-badsig-pub-${randomUUID()}`);
      try {
        const compileResult = runCli(["compile", "-i", SCHEME_PATH]);
        writeFileSync(compiledPath, compileResult.stdout, "utf-8");
        const signResult = runCli([
          "sign",
          "-i",
          compiledPath,
          "-k",
          KEY_PATH,
          "-c",
          CERT_PATH,
          "-o",
          outPath,
        ]);
        expect(signResult.status).toBe(0);

        // Tamper the signature
        const signed = readFileSync(outPath, "utf-8").trim();
        const parts = signed.split(".");
        const tampered = `${parts[0]}.${parts[1]}.AAAA${parts[2]!.slice(4)}`;
        const tamperedPath = resolve(tmpdir(), `test-tamp-${randomUUID()}.txt`);
        writeFileSync(tamperedPath, tampered, "utf-8");

        const pubResult = runCli([
          "publish",
          "-i",
          tamperedPath,
          "-c",
          CERT_PATH,
          "--publication-dir",
          pubDir,
        ]);
        expect(pubResult.status).not.toBe(0);

        // Publication dir should be empty or contain no actual publications
        if (existsSync(pubDir)) {
          const entries = readdirSync(pubDir).filter(
            (e: string) => !e.startsWith(".staging_"),
          );
          expect(entries.length).toBe(0);
        }
      } finally {
        if (existsSync(compiledPath)) unlinkSync(compiledPath);
        if (existsSync(outPath)) unlinkSync(outPath);
        try {
          rmSync(pubDir, { recursive: true, force: true });
        } catch {
          /* ok */
        }
      }
    });
  });
});
