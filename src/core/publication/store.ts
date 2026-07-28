import {
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  mkdirSync,
  renameSync,
  realpathSync,
  unlinkSync,
  lstatSync,
  rmdirSync,
  statSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { resolve, join, normalize, sep, dirname } from "node:path";
import type { Manifest, PublicationResult } from "./manifest.js";

export interface StoreConfig {
  publicationDir: string;
}

const SAFE_KEY_RE = /^[a-z0-9][a-z0-9_.@()-]{0,99}$/;
const SAFE_SEQ_RE = /^[1-9][0-9]{0,9}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const ISO8601_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;

function assertSafeSegment(
  value: string,
  pattern: RegExp,
  label: string,
): void {
  if (!pattern.test(value)) {
    throw new Error(`Unsafe ${label}: "${value}"`);
  }
}

function rejectSymlinksInPath(base: string, target: string): void {
  const parts = normalize(resolve(base, target))
    .slice(base.length)
    .split(sep)
    .filter(Boolean);
  let current = base;
  for (const part of parts) {
    current = join(current, part);
    if (existsSync(current)) {
      if (lstatSync(current).isSymbolicLink()) {
        throw new Error(`Symlink rejected: "${current}"`);
      }
    }
  }
}

function removeDir(dir: string): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      removeDir(p);
    } else {
      unlinkSync(p);
    }
  }
  rmdirSync(dir);
}

function readFileBounded(filePath: string, maxBytes: number): string | null {
  if (!existsSync(filePath)) return null;
  if (lstatSync(filePath).isSymbolicLink()) return null;
  const st = statSync(filePath);
  if (st.size > maxBytes) return null;
  return readFileSync(filePath, "utf-8");
}

function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function resolveCanonicalRoot(rawPath: string): string {
  const target = resolve(rawPath);

  // If the configured path itself exists, reject symlink and return realpath
  if (existsSync(target)) {
    if (lstatSync(target).isSymbolicLink()) {
      throw new Error("Publication root is a symlink — rejected for security");
    }
    return realpathSync(target);
  }

  // Walk up parents to find the nearest existing ancestor
  let current = target;
  while (!existsSync(current) && current !== dirname(current)) {
    current = dirname(current);
  }

  if (!existsSync(current)) {
    // Root filesystem reached — use configured path as-is
    return target;
  }

  // Resolve the nearest existing ancestor
  const realAncestor = realpathSync(current);

  // Reconstruct the canonical path from real ancestor + remaining components
  const remaining = target.slice(current.length);
  return (realAncestor + remaining).split(sep).join(sep);
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

  // No unexpected properties
  const keys = Object.keys(m);
  if (keys.some((k) => !(MANIFEST_KEYS as string[]).includes(k))) return null;

  // manifestVersion exactly 1
  if (m.manifestVersion !== 1) return null;

  // listKey safe and matches
  if (typeof m.listKey !== "string" || !SAFE_KEY_RE.test(m.listKey))
    return null;
  if (m.listKey !== listKey) return null;

  // sequenceNumber positive integer and matches
  if (
    typeof m.sequenceNumber !== "number" ||
    !Number.isInteger(m.sequenceNumber) ||
    m.sequenceNumber < 1
  )
    return null;
  if (m.sequenceNumber !== sequence) return null;

  // string fields
  const stringFields = [
    "loteIdentifier",
    "loteType",
    "schemeOperatorName",
    "territory",
    "certificateSubject",
    "certificateIssuer",
    "certificateValidFrom",
    "certificateValidTo",
  ];
  for (const f of stringFields) {
    if (typeof m[f] !== "string") return null;
  }

  // date-time fields
  const dateFields = ["issueDate", "nextUpdateDate", "publicationTimestamp"];
  for (const f of dateFields) {
    if (typeof m[f] !== "string" || !ISO8601_RE.test(m[f] as string))
      return null;
  }

  // SHA-256 fields: exactly 64 lowercase hex
  const hashFields = [
    "compactJadesSha256",
    "loteJsonSha256",
    "signingCertificateSha256",
  ];
  for (const f of hashFields) {
    if (typeof m[f] !== "string" || !SHA256_RE.test(m[f] as string))
      return null;
  }

  // signatureValid exactly true
  if (m.signatureValid !== true) return null;

  // etsiSchemaValid exactly true
  if (m.etsiSchemaValid !== true) return null;

  // signerTrustStatus exactly "not_evaluated"
  if (m.signerTrustStatus !== "not_evaluated") return null;

  return m as unknown as Manifest;
}

export function loadVersionArtifacts(
  baseDir: string,
  listKey: string,
  sequenceNumber: number,
  maxBytes: number,
): VersionReadResult {
  if (!existsSync(baseDir)) {
    return { artifacts: null, diagnostic: "publication root does not exist" };
  }

  try {
    if (lstatSync(baseDir).isSymbolicLink()) {
      return { artifacts: null, diagnostic: "publication root is a symlink" };
    }
  } catch {
    return { artifacts: null, diagnostic: "cannot stat publication root" };
  }

  const verDir = resolve(baseDir, listKey, "versions", String(sequenceNumber));
  if (!existsSync(verDir)) {
    return { artifacts: null, diagnostic: "version directory missing" };
  }

  const jadesPath = resolve(verDir, "lote.jades");
  const jsonPath = resolve(verDir, "lote.json");
  const maniPath = resolve(verDir, "manifest.json");

  try {
    rejectSymlinksInPath(baseDir, verDir);
    rejectSymlinksInPath(baseDir, jadesPath);
    rejectSymlinksInPath(baseDir, jsonPath);
    rejectSymlinksInPath(baseDir, maniPath);
  } catch {
    return { artifacts: null, diagnostic: "symlink rejected in version path" };
  }

  const jadesContent = readFileBounded(jadesPath, maxBytes);
  const jsonContent = readFileBounded(jsonPath, maxBytes);
  const maniContent = readFileBounded(maniPath, maxBytes);

  if (jadesContent === null || jsonContent === null || maniContent === null) {
    return {
      artifacts: null,
      diagnostic: "one or more artifact files missing, too large, or symlinked",
    };
  }

  let manifest: Manifest | null;
  try {
    const parsed = JSON.parse(maniContent);
    manifest = validateManifestComplete(parsed, listKey, sequenceNumber);
  } catch {
    return { artifacts: null, diagnostic: "manifest is not valid JSON" };
  }

  if (!manifest) {
    return {
      artifacts: null,
      diagnostic: "manifest validation failed",
    };
  }

  const actualJadesHash = sha256(jadesContent);
  const actualJsonHash = sha256(jsonContent);

  if (manifest.compactJadesSha256 !== actualJadesHash) {
    return { artifacts: null, diagnostic: "Compact JAdES hash mismatch" };
  }
  if (manifest.loteJsonSha256 !== actualJsonHash) {
    return { artifacts: null, diagnostic: "LoTE JSON hash mismatch" };
  }

  return {
    artifacts: {
      manifest,
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

  constructor(config: StoreConfig) {
    const raw = resolve(config.publicationDir);
    this.canonicalRoot = resolveCanonicalRoot(raw);
    this.publicationDir = this.canonicalRoot;
  }

  getCanonicalRoot(): string {
    return this.canonicalRoot;
  }

  versionDir(listKey: string, sequenceNumber: number): string {
    const seqStr = String(sequenceNumber);
    assertSafeSegment(listKey, SAFE_KEY_RE, "list key");
    assertSafeSegment(seqStr, SAFE_SEQ_RE, "sequence number");
    return resolve(this.canonicalRoot, listKey, "versions", seqStr);
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

  store(
    result: PublicationResult,
    compactJws: string,
    loteJson: string,
    manifestJson: string,
  ): { indexWarning?: string } {
    // Re-verify canonical root hasn't been symlinked since construction
    if (existsSync(this.canonicalRoot)) {
      if (lstatSync(this.canonicalRoot).isSymbolicLink()) {
        throw new Error(
          "Publication root became a symlink — rejected for security",
        );
      }
    }

    const finalDir = this.versionDir(result.listKey, result.sequenceNumber);

    if (existsSync(finalDir)) {
      rejectSymlinksInPath(this.canonicalRoot, finalDir);

      const outcome = loadVersionArtifacts(
        this.canonicalRoot,
        result.listKey,
        result.sequenceNumber,
        DEFAULT_MAX_FILE_BYTES,
      );

      if (!outcome.artifacts) {
        throw new Error(
          `Existing publication is corrupt: ${outcome.diagnostic}`,
        );
      }

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
        return {}; // Idempotent
      }

      throw new Error(
        `Version ${result.sequenceNumber} for list "${result.listKey}" already exists with different content`,
      );
    }

    rejectSymlinksInPath(this.canonicalRoot, finalDir);

    // Ensure publication root exists under canonical root
    if (!existsSync(this.canonicalRoot)) {
      mkdirSync(this.canonicalRoot, { recursive: true });
      const real = realpathSync(this.canonicalRoot);
      if (real !== this.canonicalRoot) {
        throw new Error(
          `Canonical root mismatch after creation: expected ${this.canonicalRoot}, got ${real}`,
        );
      }
    }

    const stageDir = resolve(
      this.canonicalRoot,
      ".staging_" + randomBytes(8).toString("hex"),
    );
    mkdirSync(stageDir, { recursive: true });

    try {
      const stageJades = join(stageDir, "lote.jades");
      const stageJson = join(stageDir, "lote.json");
      const stageMani = join(stageDir, "manifest.json");

      writeFileSync(stageJades, compactJws, { encoding: "utf-8" });
      writeFileSync(stageJson, loteJson, { encoding: "utf-8" });
      writeFileSync(stageMani, manifestJson, { encoding: "utf-8" });

      const writtenJades = readFileSync(stageJades, "utf-8");
      const writtenJson = readFileSync(stageJson, "utf-8");

      const jadesHash = sha256(writtenJades);
      const jsonHash = sha256(writtenJson);

      if (jadesHash !== result.manifest.compactJadesSha256) {
        throw new Error(`Staged Compact JAdES hash mismatch`);
      }
      if (jsonHash !== result.manifest.loteJsonSha256) {
        throw new Error(`Staged LoTE JSON hash mismatch`);
      }

      const listDir = resolve(this.canonicalRoot, result.listKey);
      const versionsDir = resolve(listDir, "versions");
      mkdirSync(versionsDir, { recursive: true });

      renameSync(stageDir, finalDir);

      // Index refresh is best-effort after successful version installation
      try {
        this.deriveIndex(result.listKey);
      } catch (indexErr) {
        return {
          indexWarning: `Index refresh failed for "${result.listKey}": ${indexErr instanceof Error ? indexErr.message : "unknown error"}. Catalogue will be derived in memory.`,
        };
      }
    } catch (e) {
      removeDir(stageDir);
      throw e;
    }

    return {};
  }

  private deriveIndex(listKey: string): void {
    assertSafeSegment(listKey, SAFE_KEY_RE, "list key");
    const indexPath = this.indexPath(listKey);
    const versionsDir = resolve(this.canonicalRoot, listKey, "versions");

    if (!existsSync(versionsDir)) return;

    const entries = readdirSync(versionsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => {
        const seq = parseInt(d.name, 10);
        if (!SAFE_SEQ_RE.test(d.name)) return null;
        const outcome = loadVersionArtifacts(
          this.canonicalRoot,
          listKey,
          seq,
          DEFAULT_MAX_FILE_BYTES,
        );
        if (!outcome.artifacts) return null;
        const m = outcome.artifacts.manifest;
        return {
          sequenceNumber: seq,
          issueDate: m.issueDate,
          nextUpdateDate: m.nextUpdateDate,
          publicationTimestamp: m.publicationTimestamp,
          compactJadesSha256: m.compactJadesSha256,
          loteJsonSha256: m.loteJsonSha256,
          signatureValid: m.signatureValid,
          etsiSchemaValid: m.etsiSchemaValid,
          signerTrustStatus: m.signerTrustStatus,
        };
      })
      .filter((e): e is NonNullable<typeof e> => e !== null)
      .sort((a, b) => a.sequenceNumber - b.sequenceNumber);

    const index: IndexEntry = { listKey, versions: entries };

    const tmpPath = indexPath + "." + randomBytes(8).toString("hex") + ".tmp";
    try {
      writeFileSync(tmpPath, JSON.stringify(index, null, 2), {
        encoding: "utf-8",
        flag: "wx",
      });
      renameSync(tmpPath, indexPath);
    } catch (e) {
      try {
        unlinkSync(tmpPath);
      } catch {
        /* best-effort */
      }
      throw e;
    }
  }

  private deriveIndexInMemory(listKey: string): IndexEntry | null {
    assertSafeSegment(listKey, SAFE_KEY_RE, "list key");
    const versionsDir = resolve(this.canonicalRoot, listKey, "versions");
    if (!existsSync(versionsDir)) return null;

    const entries = readdirSync(versionsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => {
        const seq = parseInt(d.name, 10);
        if (!SAFE_SEQ_RE.test(d.name)) return null;
        const outcome = loadVersionArtifacts(
          this.canonicalRoot,
          listKey,
          seq,
          DEFAULT_MAX_FILE_BYTES,
        );
        if (!outcome.artifacts) return null;
        const m = outcome.artifacts.manifest;
        return {
          sequenceNumber: seq,
          issueDate: m.issueDate,
          nextUpdateDate: m.nextUpdateDate,
          publicationTimestamp: m.publicationTimestamp,
          compactJadesSha256: m.compactJadesSha256,
          loteJsonSha256: m.loteJsonSha256,
          signatureValid: m.signatureValid,
          etsiSchemaValid: m.etsiSchemaValid,
          signerTrustStatus: m.signerTrustStatus,
        };
      })
      .filter((e): e is NonNullable<typeof e> => e !== null)
      .sort((a, b) => a.sequenceNumber - b.sequenceNumber);

    if (entries.length === 0) return null;
    return { listKey, versions: entries };
  }

  loadIndex(listKey: string): IndexEntry | null {
    assertSafeSegment(listKey, SAFE_KEY_RE, "list key");
    return this.deriveIndexInMemory(listKey);
  }

  loadManifest(listKey: string, sequenceNumber: number): Manifest | null {
    assertSafeSegment(listKey, SAFE_KEY_RE, "list key");
    assertSafeSegment(String(sequenceNumber), SAFE_SEQ_RE, "sequence number");
    const outcome = loadVersionArtifacts(
      this.canonicalRoot,
      listKey,
      sequenceNumber,
      DEFAULT_MAX_FILE_BYTES,
    );
    if (!outcome.artifacts) return null;
    return outcome.artifacts.manifest;
  }

  loadVersionBytes(
    listKey: string,
    sequenceNumber: number,
    fileType: "lote" | "signature" | "manifest",
  ): string | null {
    assertSafeSegment(listKey, SAFE_KEY_RE, "list key");
    assertSafeSegment(String(sequenceNumber), SAFE_SEQ_RE, "sequence number");
    const outcome = loadVersionArtifacts(
      this.canonicalRoot,
      listKey,
      sequenceNumber,
      DEFAULT_MAX_FILE_BYTES,
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
    if (!existsSync(this.canonicalRoot)) return [];
    try {
      if (lstatSync(this.canonicalRoot).isSymbolicLink()) return [];
    } catch {
      return [];
    }
    return readdirSync(this.canonicalRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith(".staging_"))
      .map((d) => d.name)
      .filter((n) => SAFE_KEY_RE.test(n))
      .sort();
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
