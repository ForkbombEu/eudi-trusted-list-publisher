import { execFileSync } from "node:child_process";
import {
  X509Certificate,
  createPrivateKey,
  createPublicKey,
} from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { deriveListKeyFromParts } from "./list-creation.js";

export interface GenerateSigningMaterialRequest {
  certificatesDir: string;
  schemeOperatorName: string;
  schemeTerritory: string;
}

export interface GeneratedSigningMaterial {
  listKey: string;
  keyFile: string;
  certFile: string;
  certificateSubject: string;
  certificateFingerprint: string;
}

/** Escapes one value in OpenSSL's slash-separated `-subj` form. */
function subjectValue(value: string): string {
  if (/\0|\r|\n/.test(value))
    throw new Error("Certificate subject values must fit on one line.");
  return value.replace(/([\\/+={},;<>#"])/g, "\\$1");
}

function subjectFields(certificate: X509Certificate): Record<string, string> {
  return certificate.toLegacyObject().subject as Record<string, string>;
}

function publicKeyDer(key: ReturnType<typeof createPublicKey>): Buffer {
  return key.export({ format: "der", type: "spki" });
}

/**
 * Generates one persistent P-256 key/certificate pair for a new Trusted List.
 *
 * The configured root is trusted operator configuration. All derived path
 * segments come from the same safe list-key function used by publication, and
 * the final directory is installed atomically without overwriting an existing
 * list's material.
 */
export function generateSigningMaterial(
  request: GenerateSigningMaterialRequest,
): GeneratedSigningMaterial {
  const operator = request.schemeOperatorName.trim();
  const territory = request.schemeTerritory.trim();
  if (!operator) throw new Error("Scheme operator name is required.");
  if (operator.length > 64)
    throw new Error(
      "Scheme operator name must be at most 64 characters for certificate subject O.",
    );
  if (!/^[A-Z]{2}$/.test(territory))
    throw new Error("Scheme territory must be a 2-letter uppercase code.");
  if (!request.certificatesDir.trim())
    throw new Error("TLP_CERTIFICATES_DIR is not configured.");

  const listKey = deriveListKeyFromParts(territory, operator);
  const commonName = `${operator} Trusted List Signer`.slice(0, 64);
  const root = resolve(request.certificatesDir);
  const finalDirectory = join(root, listKey);
  const keyFile = join(finalDirectory, "signing-key.pem");
  const certFile = join(finalDirectory, "signing-cert.pem");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if (existsSync(finalDirectory))
    throw new Error(`Signing material already exists for list "${listKey}".`);

  let temporaryDirectory: string | null = mkdtempSync(
    join(root, `.tmp-${listKey}-`),
  );
  const temporaryKey = join(temporaryDirectory, "signing-key.pem");
  const temporaryCertificate = join(temporaryDirectory, "signing-cert.pem");
  try {
    execFileSync(
      "openssl",
      [
        "genpkey",
        "-algorithm",
        "EC",
        "-pkeyopt",
        "ec_paramgen_curve:P-256",
        "-out",
        temporaryKey,
      ],
      { stdio: "ignore" },
    );
    execFileSync(
      "openssl",
      [
        "req",
        "-new",
        "-x509",
        "-key",
        temporaryKey,
        "-out",
        temporaryCertificate,
        "-days",
        "365",
        "-sha256",
        "-subj",
        `/C=${subjectValue(territory)}/O=${subjectValue(operator)}/CN=${subjectValue(commonName)}`,
        "-addext",
        "basicConstraints=critical,CA:FALSE",
        "-addext",
        "keyUsage=critical,digitalSignature",
        "-addext",
        "subjectKeyIdentifier=hash",
      ],
      { stdio: "ignore" },
    );

    const privateKey = createPrivateKey(readFileSync(temporaryKey, "utf-8"));
    const certificate = new X509Certificate(
      readFileSync(temporaryCertificate, "utf-8"),
    );
    const certificateSubject = subjectFields(certificate);
    if (certificateSubject.O !== operator)
      throw new Error(
        "Generated certificate subject O does not match the operator name.",
      );
    if (certificateSubject.C !== territory)
      throw new Error(
        "Generated certificate subject C does not match SchemeTerritory.",
      );
    if (
      certificate.publicKey.asymmetricKeyType !== "ec" ||
      certificate.publicKey.asymmetricKeyDetails?.namedCurve !== "prime256v1"
    )
      throw new Error("Generated certificate does not use the P-256 curve.");
    if (
      !publicKeyDer(createPublicKey(privateKey)).equals(
        publicKeyDer(certificate.publicKey),
      )
    )
      throw new Error("Generated certificate does not match the private key.");

    chmodSync(temporaryKey, 0o600);
    chmodSync(temporaryCertificate, 0o644);
    try {
      renameSync(temporaryDirectory, finalDirectory);
    } catch (error) {
      if (existsSync(finalDirectory))
        throw new Error(
          `Signing material already exists for list "${listKey}".`,
        );
      throw error;
    }
    temporaryDirectory = null;
    return {
      listKey,
      keyFile,
      certFile,
      certificateSubject: certificate.subject.replace(/\n/g, ", "),
      certificateFingerprint: certificate.fingerprint256
        .replace(/:/g, "")
        .toLowerCase(),
    };
  } catch (error) {
    if (error instanceof Error && error.message.includes("Signing material"))
      throw error;
    throw new Error(
      `OpenSSL could not generate signing material: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    );
  } finally {
    if (temporaryDirectory)
      rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}
