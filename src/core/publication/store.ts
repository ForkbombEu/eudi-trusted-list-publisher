import {
  writeFileSync as fsWriteFileSync,
  readFileSync as fsReadFileSync,
  readdirSync as fsReaddirSync,
  existsSync as fsExistsSync,
  mkdirSync as fsMkdirSync,
  renameSync as fsRenameSync,
  realpathSync as fsRealpathSync,
  unlinkSync as fsUnlinkSync,
  lstatSync as fsLstatSync,
  rmdirSync as fsRmdirSync,
  statSync as fsStatSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { resolve, join, normalize, sep, dirname } from "node:path";
import { X509Certificate } from "node:crypto";
import type { Manifest, PublicationResult } from "./manifest.js";
import { verify as verifyJades } from "../verification/verification.js";
import { validateEtsiStruct } from "../validate/validate.js";

export interface StoreConfig {
  publicationDir: string;
}

const SAFE_KEY_RE = /^[a-z0-9][a-z0-9_.@()-]{0,99}$/;
const SAFE_SEQ_RE = /^[1-9][0-9]{0,9}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const ISO8601_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;

export interface FsOps {
  existsSync: typeof fsExistsSync;
  lstatSync: typeof fsLstatSync;
  statSync: typeof fsStatSync;
  readFileSync: typeof fsReadFileSync;
  writeFileSync: typeof fsWriteFileSync;
  mkdirSync: typeof fsMkdirSync;
  readdirSync: typeof fsReaddirSync;
  renameSync: typeof fsRenameSync;
  realpathSync: typeof fsRealpathSync;
  unlinkSync: typeof fsUnlinkSync;
  rmdirSync: typeof fsRmdirSync;
}

const defaultFsOps: FsOps = {
  existsSync: fsExistsSync,
  lstatSync: fsLstatSync,
  statSync: fsStatSync,
  readFileSync: fsReadFileSync,
  writeFileSync: fsWriteFileSync,
  mkdirSync: fsMkdirSync,
  readdirSync: fsReaddirSync,
  renameSync: fsRenameSync,
  realpathSync: fsRealpathSync,
  unlinkSync: fsUnlinkSync,
  rmdirSync: fsRmdirSync,
};

function assertSafeSegment(v: string, p: RegExp, label: string): void {
  if (!p.test(v)) throw new Error(`Unsafe ${label}: "${v}"`);
}

function rejectSymlinksInPath(fs: FsOps, base: string, target: string): void {
  const parts = normalize(resolve(base, target))
    .slice(base.length)
    .split(sep)
    .filter(Boolean);
  let current = base;
  for (const part of parts) {
    current = join(current, part);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) {
      throw new Error(`Symlink rejected: "${current}"`);
    }
  }
}

function removeDir(fs: FsOps, dir: string): void {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) removeDir(fs, p);
    else fs.unlinkSync(p);
  }
  fs.rmdirSync(dir);
}

function readFileBounded(
  fs: FsOps,
  path: string,
  maxBytes: number,
): string | null {
  if (!fs.existsSync(path)) return null;
  if (fs.lstatSync(path).isSymbolicLink()) return null;
  const st = fs.statSync(path);
  if (st.size > maxBytes) return null;
  return fs.readFileSync(path, "utf-8");
}

function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function resolveCanonicalRoot(fs: FsOps, rawPath: string): string {
  const target = resolve(rawPath);
  if (fs.existsSync(target)) {
    if (fs.lstatSync(target).isSymbolicLink()) {
      throw new Error("Publication root is a symlink — rejected for security");
    }
    return fs.realpathSync(target);
  }
  let current = target;
  while (!fs.existsSync(current) && current !== dirname(current)) {
    current = dirname(current);
  }
  if (!fs.existsSync(current)) return target;
  const realAncestor = fs.realpathSync(current);
  const remaining = target.slice(current.length);
  return (realAncestor + remaining).split(sep).join(sep);
}

function deriveListKey(doc: unknown): string {
  const d = doc as {
    LoTE?: {
      ListAndSchemeInformation?: {
        SchemeTerritory?: string;
        SchemeOperatorName?: Array<{ value?: string }>;
      };
    };
  };
  const info = d?.LoTE?.ListAndSchemeInformation;
  const territory = info?.SchemeTerritory ?? "XX";
  const opName =
    info?.SchemeOperatorName?.[0]?.value?.replace(/[^a-zA-Z0-9_-]/g, "_") ??
    "unknown";
  return `${territory}_${opName.slice(0, 40)}`.toLowerCase();
}

function extractCertFromX5c(x5c: unknown): string | null {
  if (!Array.isArray(x5c) || x5c.length === 0) return null;
  const certB64 = x5c[0] as string;
  try {
    const derBytes = Buffer.from(certB64, "base64");
    const derB64 = derBytes.toString("base64");
    const wrapped = derB64.match(/.{1,64}/g)?.join("\n") ?? derB64;
    const pem =
      "-----BEGIN CERTIFICATE-----\n" + wrapped + "\n-----END CERTIFICATE-----";
    new X509Certificate(pem);
    return pem;
  } catch {
    return null;
  }
}

function getSignerInfo(certPem: string): {
  subject: string;
  issuer: string;
  validFrom: string;
  validTo: string;
  fingerprint: string;
} {
  const cert = new X509Certificate(certPem);
  return {
    subject: cert.subject.replace(/\n/g, ", "),
    issuer: cert.issuer.replace(/\n/g, ", "),
    validFrom: cert.validFrom,
    validTo: cert.validTo,
    fingerprint: cert.fingerprint256.replace(/:/g, "").toLowerCase(),
  };
}

export interface VersionArtifacts {
  manifest: Manifest;
  loteJsonBytes: string;
  jadesBytes: string;
  manifestBytes: string;
}

export interface VersionReadResult {
  artifacts: VersionArtifacts | null;
  diagnostic: string;
}

const MANIFEST_KEYS: Array<keyof Manifest> = [
  "manifestVersion",
  "listKey",
  "loteIdentifier",
  "sequenceNumber",
  "issueDate",
  "nextUpdateDate",
  "loteType",
  "schemeOperatorName",
  "territory",
  "publicationTimestamp",
  "compactJadesSha256",
  "loteJsonSha256",
  "signingCertificateSha256",
  "certificateSubject",
  "certificateIssuer",
  "certificateValidFrom",
  "certificateValidTo",
  "signatureValid",
  "etsiSchemaValid",
  "signerTrustStatus",
];

function validateManifestComplete(
  obj: unknown,
  listKey: string,
  sequence: number,
): Manifest | null {
  if (typeof obj !== "object" || obj === null) return null;
  const m = obj as Record<string, unknown>;
  const keys = Object.keys(m);
  if (keys.some((k) => !(MANIFEST_KEYS as string[]).includes(k))) return null;
  if (m.manifestVersion !== 1) return null;
  if (
    typeof m.listKey !== "string" ||
    !SAFE_KEY_RE.test(m.listKey) ||
    m.listKey !== listKey
  )
    return null;
  if (
    typeof m.sequenceNumber !== "number" ||
    !Number.isInteger(m.sequenceNumber) ||
    m.sequenceNumber < 1 ||
    m.sequenceNumber !== sequence
  )
    return null;
  for (const f of [
    "loteIdentifier",
    "loteType",
    "schemeOperatorName",
    "territory",
    "certificateSubject",
    "certificateIssuer",
    "certificateValidFrom",
    "certificateValidTo",
  ]) {
    if (typeof m[f] !== "string") return null;
  }
  for (const f of ["issueDate", "nextUpdateDate", "publicationTimestamp"]) {
    if (typeof m[f] !== "string" || !ISO8601_RE.test(m[f] as string))
      return null;
  }
  for (const f of [
    "compactJadesSha256",
    "loteJsonSha256",
    "signingCertificateSha256",
  ]) {
    if (typeof m[f] !== "string" || !SHA256_RE.test(m[f] as string))
      return null;
  }
  if (m.signatureValid !== true) return null;
  if (m.etsiSchemaValid !== true) return null;
  if (m.signerTrustStatus !== "not_evaluated") return null;
  return m as unknown as Manifest;
}

export async function loadVersionArtifacts(
  baseDir: string,
  listKey: string,
  sequenceNumber: number,
  maxBytes: number,
  fs: FsOps = defaultFsOps,
): Promise<VersionReadResult> {
  if (!fs.existsSync(baseDir)) {
    return { artifacts: null, diagnostic: "publication root does not exist" };
  }
  try {
    if (fs.lstatSync(baseDir).isSymbolicLink()) {
      return { artifacts: null, diagnostic: "publication root is a symlink" };
    }
  } catch {
    return { artifacts: null, diagnostic: "cannot stat publication root" };
  }

  const verDir = resolve(baseDir, listKey, "versions", String(sequenceNumber));
  if (!fs.existsSync(verDir))
    return { artifacts: null, diagnostic: "version directory missing" };

  const jadesPath = resolve(verDir, "lote.jades");
  const jsonPath = resolve(verDir, "lote.json");
  const maniPath = resolve(verDir, "manifest.json");

  try {
    rejectSymlinksInPath(fs, baseDir, verDir);
    rejectSymlinksInPath(fs, baseDir, jadesPath);
    rejectSymlinksInPath(fs, baseDir, jsonPath);
    rejectSymlinksInPath(fs, baseDir, maniPath);
  } catch {
    return { artifacts: null, diagnostic: "symlink rejected in version path" };
  }

  const jadesContent = readFileBounded(fs, jadesPath, maxBytes);
  const jsonContent = readFileBounded(fs, jsonPath, maxBytes);
  const maniContent = readFileBounded(fs, maniPath, maxBytes);

  if (jadesContent === null || jsonContent === null || maniContent === null) {
    return {
      artifacts: null,
      diagnostic: "one or more artifact files missing, too large, or symlinked",
    };
  }

  // Parse stored manifest
  let storedManifest: Manifest | null;
  try {
    storedManifest = validateManifestComplete(
      JSON.parse(maniContent),
      listKey,
      sequenceNumber,
    );
  } catch {
    return { artifacts: null, diagnostic: "manifest is not valid JSON" };
  }
  if (!storedManifest)
    return { artifacts: null, diagnostic: "manifest validation failed" };

  // Extract x5c from JAdES header — mandatory for authentication
  let embeddedCertPem: string | null = null;
  try {
    const parts = jadesContent.split(".");
    if (parts.length !== 3 || !parts[0]) {
      return {
        artifacts: null,
        diagnostic: "Compact JAdES is not a valid three-part serialization",
      };
    }
    let header: unknown;
    try {
      header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString());
    } catch {
      return { artifacts: null, diagnostic: "malformed protected header" };
    }
    if (
      typeof header !== "object" ||
      header === null ||
      !Array.isArray((header as Record<string, unknown>)["x5c"]) ||
      ((header as Record<string, unknown>)["x5c"] as unknown[]).length === 0
    ) {
      return {
        artifacts: null,
        diagnostic:
          "Compact JAdES header is missing a valid x5c certificate chain",
      };
    }
    embeddedCertPem = extractCertFromX5c(
      (header as Record<string, unknown>)["x5c"],
    );
    if (!embeddedCertPem) {
      return {
        artifacts: null,
        diagnostic: "x5c contains an unusable leaf certificate",
      };
    }
  } catch {
    return { artifacts: null, diagnostic: "malformed protected header" };
  }

  // Parse the signed payload
  let signedDocument: unknown = null;
  try {
    const parts = jadesContent.split(".");
    if (parts.length === 3 && parts[1]) {
      signedDocument = JSON.parse(
        Buffer.from(parts[1], "base64url").toString(),
      );
    }
  } catch {
    /* continue */
  }

  // Derive canonical LoTE JSON from signed payload
  let derivedLoteJson: string | null = null;
  if (
    signedDocument &&
    typeof signedDocument === "object" &&
    signedDocument !== null
  ) {
    derivedLoteJson = JSON.stringify(signedDocument);
  }

  // Verify stored lote.json matches signed payload exactly
  if (derivedLoteJson === null || jsonContent !== derivedLoteJson) {
    return {
      artifacts: null,
      diagnostic: "stored lote.json does not match signed payload",
    };
  }

  // Cryptographically verify the JAdES — mandatory, must have x5c by now
  {
    const verifyResult = await verifyJades({
      compactJws: jadesContent,
      certificatePem: embeddedCertPem,
      clock: storedManifest.publicationTimestamp
        ? new Date(storedManifest.publicationTimestamp)
        : undefined,
    });
    if (!verifyResult.valid || !verifyResult.payload) {
      return {
        artifacts: null,
        diagnostic: "JAdES signature verification failed",
      };
    }
  }

  // Validate signed payload against ETSI schema
  if (signedDocument && typeof signedDocument === "object") {
    const etsiResult = await validateEtsiStruct(signedDocument);
    if (!etsiResult.valid) {
      return {
        artifacts: null,
        diagnostic: "signed payload fails ETSI schema validation",
      };
    }
  }

  // Derive expected manifest values from signed payload and embedded cert
  if (
    signedDocument &&
    typeof signedDocument === "object" &&
    (signedDocument as Record<string, unknown>).LoTE
  ) {
    const doc = signedDocument as {
      LoTE: {
        ListAndSchemeInformation: Record<string, unknown>;
        TrustedEntitiesList?: unknown[];
      };
    };
    const info = doc.LoTE.ListAndSchemeInformation;
    const derivedKey = deriveListKey(doc);
    const derivedSeq = Number(info.LoTESequenceNumber);
    const derivedLoteType = String(info.LoTEType ?? "");
    const derivedIssueDate = String(info.ListIssueDateTime ?? "");
    const derivedNextUpdate = String(info.NextUpdate ?? "");
    const derivedTerritory = String(info.SchemeTerritory ?? "");
    const derivedOpName =
      (info.SchemeOperatorName as Array<{ lang: string; value: string }>)
        ?.map((n) => `${n.lang}:${n.value}`)
        .join("; ") ?? "";
    const derivedJadesHash = sha256(jadesContent);
    const derivedJsonHash = sha256(jsonContent);

    // Cross-check stored manifest against derived values
    if (storedManifest.listKey !== derivedKey)
      return { artifacts: null, diagnostic: "manifest listKey mismatch" };
    if (storedManifest.sequenceNumber !== derivedSeq)
      return {
        artifacts: null,
        diagnostic: "manifest sequenceNumber mismatch",
      };
    if (storedManifest.loteIdentifier !== derivedLoteType)
      return {
        artifacts: null,
        diagnostic: "manifest loteIdentifier mismatch",
      };
    if (storedManifest.issueDate !== derivedIssueDate)
      return { artifacts: null, diagnostic: "manifest issueDate mismatch" };
    if (storedManifest.nextUpdateDate !== derivedNextUpdate)
      return {
        artifacts: null,
        diagnostic: "manifest nextUpdateDate mismatch",
      };
    if (storedManifest.loteType !== derivedLoteType)
      return { artifacts: null, diagnostic: "manifest loteType mismatch" };
    if (storedManifest.schemeOperatorName !== derivedOpName)
      return {
        artifacts: null,
        diagnostic: "manifest schemeOperatorName mismatch",
      };
    if (storedManifest.territory !== derivedTerritory)
      return { artifacts: null, diagnostic: "manifest territory mismatch" };
    if (storedManifest.compactJadesSha256 !== derivedJadesHash)
      return {
        artifacts: null,
        diagnostic: "manifest compactJadesSha256 mismatch",
      };
    if (storedManifest.loteJsonSha256 !== derivedJsonHash)
      return {
        artifacts: null,
        diagnostic: "manifest loteJsonSha256 mismatch",
      };

    // Cross-check certificate metadata
    {
      const signer = getSignerInfo(embeddedCertPem);
      if (storedManifest.signingCertificateSha256 !== signer.fingerprint)
        return {
          artifacts: null,
          diagnostic: "manifest signingCertificateSha256 mismatch",
        };
      if (storedManifest.certificateSubject !== signer.subject)
        return {
          artifacts: null,
          diagnostic: "manifest certificateSubject mismatch",
        };
      if (storedManifest.certificateIssuer !== signer.issuer)
        return {
          artifacts: null,
          diagnostic: "manifest certificateIssuer mismatch",
        };
      if (storedManifest.certificateValidFrom !== signer.validFrom)
        return {
          artifacts: null,
          diagnostic: "manifest certificateValidFrom mismatch",
        };
      if (storedManifest.certificateValidTo !== signer.validTo)
        return {
          artifacts: null,
          diagnostic: "manifest certificateValidTo mismatch",
        };
    }

    // publicationTimestamp is local metadata — validate format only
  }

  const actualJadesHash = sha256(jadesContent);
  const actualJsonHash = sha256(jsonContent);
  if (storedManifest.compactJadesSha256 !== actualJadesHash)
    return { artifacts: null, diagnostic: "Compact JAdES hash mismatch" };
  if (storedManifest.loteJsonSha256 !== actualJsonHash)
    return { artifacts: null, diagnostic: "LoTE JSON hash mismatch" };

  return {
    artifacts: {
      manifest: storedManifest,
      loteJsonBytes: jsonContent,
      jadesBytes: jadesContent,
      manifestBytes: maniContent,
    },
    diagnostic: "",
  };
}

export class PublicationStore {
  readonly publicationDir: string;
  private canonicalRoot: string;
  private fs: FsOps;

  constructor(config: StoreConfig, fs?: FsOps) {
    this.fs = fs ?? defaultFsOps;
    const raw = resolve(config.publicationDir);
    this.canonicalRoot = resolveCanonicalRoot(this.fs, raw);
    this.publicationDir = this.canonicalRoot;
  }

  getCanonicalRoot(): string {
    return this.canonicalRoot;
  }

  private canonicalRootGuard(): void {
    if (this.fs.existsSync(this.canonicalRoot)) {
      const real = this.fs.realpathSync(this.canonicalRoot);
      if (real !== this.canonicalRoot) {
        throw new Error(
          "Publication root was redirected — canonical root changed",
        );
      }
    }
  }

  versionDir(listKey: string, sequenceNumber: number): string {
    assertSafeSegment(listKey, SAFE_KEY_RE, "list key");
    assertSafeSegment(String(sequenceNumber), SAFE_SEQ_RE, "sequence number");
    return resolve(
      this.canonicalRoot,
      listKey,
      "versions",
      String(sequenceNumber),
    );
  }

  indexPath(listKey: string): string {
    assertSafeSegment(listKey, SAFE_KEY_RE, "list key");
    return resolve(this.canonicalRoot, listKey, "index.json");
  }

  loteJsonPath(listKey: string, sequenceNumber: number): string {
    return join(this.versionDir(listKey, sequenceNumber), "lote.json");
  }
  loteJadesPath(listKey: string, sequenceNumber: number): string {
    return join(this.versionDir(listKey, sequenceNumber), "lote.jades");
  }
  manifestPath(listKey: string, sequenceNumber: number): string {
    return join(this.versionDir(listKey, sequenceNumber), "manifest.json");
  }
  /**
   * XML rendition of a published version, if one exists.
   *
   * This publisher does not produce XML — TS 119 612 and XAdES are out of scope —
   * so the file is normally absent. It is read, never written, and sits outside
   * the integrity-checked set: the manifest hashes cover `lote.json` and
   * `lote.jades` only, so an XML rendition placed here is an additional artifact
   * and never evidence about the signed ones.
   */
  loteXmlPath(listKey: string, sequenceNumber: number): string {
    return join(this.versionDir(listKey, sequenceNumber), "lote.xml");
  }

  /** True when a version has an XML rendition beside its JSON artifacts. */
  hasLoteXml(listKey: string, sequenceNumber: number): boolean {
    try {
      return this.fs.existsSync(this.loteXmlPath(listKey, sequenceNumber));
    } catch {
      return false;
    }
  }

  /** Returns the XML rendition, or null when the version has none. */
  readLoteXml(listKey: string, sequenceNumber: number): string | null {
    if (!this.hasLoteXml(listKey, sequenceNumber)) return null;
    try {
      return this.fs.readFileSync(
        this.loteXmlPath(listKey, sequenceNumber),
        "utf-8",
      );
    } catch {
      return null;
    }
  }

  /**
   * External assessment of a published version. It sits beside the version's
   * artifacts but is deliberately outside the integrity-checked set: it is
   * evidence *about* the version, produced after publication and re-runnable,
   * while the three signed artifacts stay immutable.
   */
  inspectorEvaluationPath(listKey: string, sequenceNumber: number): string {
    return join(this.versionDir(listKey, sequenceNumber), "inspector.json");
  }

  /** Writes (or replaces) the evaluation for one published version. */
  writeInspectorEvaluation(
    listKey: string,
    sequenceNumber: number,
    evaluationJson: string,
  ): void {
    const path = this.inspectorEvaluationPath(listKey, sequenceNumber);
    if (!this.fs.existsSync(this.versionDir(listKey, sequenceNumber)))
      throw new Error(
        `Cannot store an evaluation for "${listKey}" sequence ${sequenceNumber}: the version does not exist.`,
      );
    const tmpPath = `${path}.tmp_${randomBytes(6).toString("hex")}`;
    this.fs.writeFileSync(tmpPath, evaluationJson, { encoding: "utf-8" });
    this.fs.renameSync(tmpPath, path);
  }

  /**
   * Negative-fixture metadata for an intentionally broken version: which
   * defects were selected, which mutations landed, and expected against actual
   * Inspector failures.
   *
   * Like the Inspector evaluation it is deliberately outside the
   * integrity-checked set. The manifest hashes still cover `lote.json` and
   * `lote.jades` exactly as published — intentionally broken bytes included —
   * so a fixture is tamper-evident in the same way a healthy version is.
   */
  fixtureMetadataPath(listKey: string, sequenceNumber: number): string {
    return join(this.versionDir(listKey, sequenceNumber), "fixture.json");
  }

  /** True when a version was generated as an intentionally broken fixture. */
  hasFixtureMetadata(listKey: string, sequenceNumber: number): boolean {
    try {
      return this.fs.existsSync(this.fixtureMetadataPath(listKey, sequenceNumber));
    } catch {
      return false;
    }
  }

  writeFixtureMetadata(
    listKey: string,
    sequenceNumber: number,
    metadataJson: string,
  ): void {
    const path = this.fixtureMetadataPath(listKey, sequenceNumber);
    if (!this.fs.existsSync(this.versionDir(listKey, sequenceNumber)))
      throw new Error(
        `Cannot store fixture metadata for "${listKey}" sequence ${sequenceNumber}: the version does not exist.`,
      );
    const tmpPath = `${path}.tmp_${randomBytes(6).toString("hex")}`;
    this.fs.writeFileSync(tmpPath, metadataJson, { encoding: "utf-8" });
    this.fs.renameSync(tmpPath, path);
  }

  /** Returns the stored fixture metadata, or null when the version is healthy. */
  readFixtureMetadata(
    listKey: string,
    sequenceNumber: number,
  ): string | null {
    const path = this.fixtureMetadataPath(listKey, sequenceNumber);
    if (!this.fs.existsSync(path)) return null;
    try {
      return this.fs.readFileSync(path, "utf-8");
    } catch {
      return null;
    }
  }

  /** Returns the stored evaluation, or null when none was ever stored. */
  readInspectorEvaluation(
    listKey: string,
    sequenceNumber: number,
  ): string | null {
    const path = this.inspectorEvaluationPath(listKey, sequenceNumber);
    if (!this.fs.existsSync(path)) return null;
    try {
      return this.fs.readFileSync(path, "utf-8");
    } catch {
      return null;
    }
  }

  async store(
    result: PublicationResult,
    compactJws: string,
    loteJson: string,
    manifestJson: string,
  ): Promise<{ indexWarning?: string }> {
    this.canonicalRootGuard();

    if (
      this.fs.existsSync(this.canonicalRoot) &&
      this.fs.lstatSync(this.canonicalRoot).isSymbolicLink()
    ) {
      throw new Error(
        "Publication root became a symlink — rejected for security",
      );
    }

    const finalDir = this.versionDir(result.listKey, result.sequenceNumber);

    if (this.fs.existsSync(finalDir)) {
      rejectSymlinksInPath(this.fs, this.canonicalRoot, finalDir);
      const outcome = await loadVersionArtifacts(
        this.canonicalRoot,
        result.listKey,
        result.sequenceNumber,
        DEFAULT_MAX_FILE_BYTES,
        this.fs,
      );
      if (!outcome.artifacts)
        throw new Error(
          `Existing publication is corrupt: ${outcome.diagnostic}`,
        );
      const m = outcome.artifacts.manifest;
      if (
        m.compactJadesSha256 === result.manifest.compactJadesSha256 &&
        m.loteJsonSha256 === result.manifest.loteJsonSha256 &&
        m.listKey === result.manifest.listKey &&
        m.sequenceNumber === result.manifest.sequenceNumber &&
        m.schemeOperatorName === result.manifest.schemeOperatorName &&
        m.territory === result.manifest.territory &&
        m.signingCertificateSha256 === result.manifest.signingCertificateSha256
      ) {
        return {};
      }
      throw new Error(
        `Version ${result.sequenceNumber} for list "${result.listKey}" already exists with different content`,
      );
    }

    rejectSymlinksInPath(this.fs, this.canonicalRoot, finalDir);

    if (!this.fs.existsSync(this.canonicalRoot)) {
      this.fs.mkdirSync(this.canonicalRoot, { recursive: true });
      const real = this.fs.realpathSync(this.canonicalRoot);
      if (real !== this.canonicalRoot)
        throw new Error(
          `Canonical root mismatch after creation: expected ${this.canonicalRoot}, got ${real}`,
        );
    }

    const stageDir = resolve(
      this.canonicalRoot,
      ".staging_" + randomBytes(8).toString("hex"),
    );
    this.fs.mkdirSync(stageDir, { recursive: true });

    try {
      const stageJades = join(stageDir, "lote.jades");
      const stageJson = join(stageDir, "lote.json");
      const stageMani = join(stageDir, "manifest.json");

      this.fs.writeFileSync(stageJades, compactJws, { encoding: "utf-8" });
      this.fs.writeFileSync(stageJson, loteJson, { encoding: "utf-8" });
      this.fs.writeFileSync(stageMani, manifestJson, { encoding: "utf-8" });

      const writtenJades = this.fs.readFileSync(stageJades, "utf-8");
      const writtenJson = this.fs.readFileSync(stageJson, "utf-8");
      if (sha256(writtenJades) !== result.manifest.compactJadesSha256)
        throw new Error("Staged Compact JAdES hash mismatch");
      if (sha256(writtenJson) !== result.manifest.loteJsonSha256)
        throw new Error("Staged LoTE JSON hash mismatch");

      const listDir = resolve(this.canonicalRoot, result.listKey);
      this.fs.mkdirSync(resolve(listDir, "versions"), { recursive: true });
      this.fs.renameSync(stageDir, finalDir);

      try {
        await this.deriveIndex(result.listKey);
      } catch (indexErr) {
        return {
          indexWarning: `Index refresh failed for "${result.listKey}": ${indexErr instanceof Error ? indexErr.message : "unknown error"}. Catalogue will be derived in memory.`,
        };
      }
    } catch (e) {
      removeDir(this.fs, stageDir);
      throw e;
    }
    return {};
  }

  private async deriveIndex(listKey: string): Promise<void> {
    assertSafeSegment(listKey, SAFE_KEY_RE, "list key");
    const indexPath = this.indexPath(listKey);
    const versionsDir = resolve(this.canonicalRoot, listKey, "versions");
    if (!this.fs.existsSync(versionsDir)) return;

    if (this.fs.lstatSync(versionsDir).isSymbolicLink()) {
      throw new Error("versions directory is a symlink");
    }

    const entries: Array<IndexVersionEntry | null> = [];
    for (const d of this.fs
      .readdirSync(versionsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())) {
      if (d.isSymbolicLink?.() ?? false) continue;
      const seq = parseInt(d.name, 10);
      if (!SAFE_SEQ_RE.test(d.name)) continue;
      const outcome = await loadVersionArtifacts(
        this.canonicalRoot,
        listKey,
        seq,
        DEFAULT_MAX_FILE_BYTES,
        this.fs,
      );
      if (!outcome.artifacts) continue;
      const m = outcome.artifacts.manifest;
      entries.push({
        sequenceNumber: seq,
        issueDate: m.issueDate,
        nextUpdateDate: m.nextUpdateDate,
        publicationTimestamp: m.publicationTimestamp,
        compactJadesSha256: m.compactJadesSha256,
        loteJsonSha256: m.loteJsonSha256,
        signatureValid: m.signatureValid,
        etsiSchemaValid: m.etsiSchemaValid,
        signerTrustStatus: m.signerTrustStatus,
      });
    }

    const versions = entries
      .filter((e): e is NonNullable<typeof e> => e !== null)
      .sort((a, b) => a.sequenceNumber - b.sequenceNumber);
    const index: IndexEntry = { listKey, versions };
    const tmpPath = indexPath + "." + randomBytes(8).toString("hex") + ".tmp";
    try {
      this.fs.writeFileSync(tmpPath, JSON.stringify(index, null, 2), {
        encoding: "utf-8",
        flag: "wx",
      });
      this.fs.renameSync(tmpPath, indexPath);
    } catch (e) {
      try {
        this.fs.unlinkSync(tmpPath);
      } catch {}
      throw e;
    }
  }

  private async deriveIndexInMemory(
    listKey: string,
  ): Promise<IndexEntry | null> {
    assertSafeSegment(listKey, SAFE_KEY_RE, "list key");
    const versionsDir = resolve(this.canonicalRoot, listKey, "versions");
    if (!this.fs.existsSync(versionsDir)) return null;

    if (this.fs.lstatSync(versionsDir).isSymbolicLink()) return null;

    const entries: Array<IndexVersionEntry | null> = [];
    for (const d of this.fs
      .readdirSync(versionsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())) {
      if (d.isSymbolicLink?.() ?? false) continue;
      const seq = parseInt(d.name, 10);
      if (!SAFE_SEQ_RE.test(d.name)) continue;
      const outcome = await loadVersionArtifacts(
        this.canonicalRoot,
        listKey,
        seq,
        DEFAULT_MAX_FILE_BYTES,
        this.fs,
      );
      if (!outcome.artifacts) continue;
      const m = outcome.artifacts.manifest;
      entries.push({
        sequenceNumber: seq,
        issueDate: m.issueDate,
        nextUpdateDate: m.nextUpdateDate,
        publicationTimestamp: m.publicationTimestamp,
        compactJadesSha256: m.compactJadesSha256,
        loteJsonSha256: m.loteJsonSha256,
        signatureValid: m.signatureValid,
        etsiSchemaValid: m.etsiSchemaValid,
        signerTrustStatus: m.signerTrustStatus,
      });
    }
    const versions = entries
      .filter((e): e is NonNullable<typeof e> => e !== null)
      .sort((a, b) => a.sequenceNumber - b.sequenceNumber);
    if (versions.length === 0) return null;
    return { listKey, versions };
  }

  async loadIndex(listKey: string): Promise<IndexEntry | null> {
    assertSafeSegment(listKey, SAFE_KEY_RE, "list key");
    this.canonicalRootGuard();
    return await this.deriveIndexInMemory(listKey);
  }

  async loadManifest(
    listKey: string,
    sequenceNumber: number,
  ): Promise<Manifest | null> {
    assertSafeSegment(listKey, SAFE_KEY_RE, "list key");
    assertSafeSegment(String(sequenceNumber), SAFE_SEQ_RE, "sequence number");
    this.canonicalRootGuard();
    const outcome = await loadVersionArtifacts(
      this.canonicalRoot,
      listKey,
      sequenceNumber,
      DEFAULT_MAX_FILE_BYTES,
      this.fs,
    );
    if (!outcome.artifacts) return null;
    return outcome.artifacts.manifest;
  }

  async loadVersionBytes(
    listKey: string,
    sequenceNumber: number,
    fileType: "lote" | "signature" | "manifest",
  ): Promise<string | null> {
    assertSafeSegment(listKey, SAFE_KEY_RE, "list key");
    assertSafeSegment(String(sequenceNumber), SAFE_SEQ_RE, "sequence number");
    this.canonicalRootGuard();
    const outcome = await loadVersionArtifacts(
      this.canonicalRoot,
      listKey,
      sequenceNumber,
      DEFAULT_MAX_FILE_BYTES,
      this.fs,
    );
    if (!outcome.artifacts) return null;
    switch (fileType) {
      case "lote":
        return outcome.artifacts.loteJsonBytes;
      case "signature":
        return outcome.artifacts.jadesBytes;
      case "manifest":
        return outcome.artifacts.manifestBytes;
    }
  }

  listKeys(): string[] {
    this.canonicalRootGuard();
    if (!this.fs.existsSync(this.canonicalRoot)) return [];
    try {
      if (this.fs.lstatSync(this.canonicalRoot).isSymbolicLink()) return [];
    } catch {
      return [];
    }
    return this.fs
      .readdirSync(this.canonicalRoot, { withFileTypes: true })
      .filter(
        (d) =>
          d.isDirectory() &&
          !d.name.startsWith(".staging_") &&
          !(d.isSymbolicLink?.() ?? false),
      )
      .map((d) => d.name)
      .filter((n) => SAFE_KEY_RE.test(n))
      .sort();
  }

  getHighestStoredSequence(listKey: string): number | null {
    assertSafeSegment(listKey, SAFE_KEY_RE, "list key");
    const versionsDir = resolve(this.canonicalRoot, listKey, "versions");
    if (!this.fs.existsSync(versionsDir)) return null;
    const entries = this.fs
      .readdirSync(versionsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && SAFE_SEQ_RE.test(d.name))
      .map((d) => parseInt(d.name, 10));
    if (entries.length === 0) return null;
    return Math.max(...entries);
  }
}

export interface IndexVersionEntry {
  sequenceNumber: number;
  issueDate: string;
  nextUpdateDate: string;
  publicationTimestamp: string;
  compactJadesSha256: string;
  loteJsonSha256: string;
  signatureValid: boolean;
  etsiSchemaValid: boolean;
  signerTrustStatus: string;
}
export interface IndexEntry {
  listKey: string;
  versions: IndexVersionEntry[];
}
