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
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { resolve, join, normalize, sep } from "node:path";
import type { Manifest, PublicationResult } from "./manifest.js";

export interface StoreConfig {
  publicationDir: string;
}

const SAFE_KEY_RE = /^[a-z0-9][a-z0-9_.@()-]{0,99}$/;
const SAFE_SEQ_RE = /^[1-9][0-9]{0,9}$/;

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
  const realBase = realpathSync(base);
  const parts = normalize(resolve(base, target))
    .slice(realBase.length)
    .split(sep)
    .filter(Boolean);
  let current = realBase;
  for (const part of parts) {
    current = join(current, part);
    if (existsSync(current)) {
      try {
        if (lstatSync(current).isSymbolicLink()) {
          const linkTarget = realpathSync(current);
          if (
            !linkTarget.startsWith(realBase + sep) &&
            linkTarget !== realBase
          ) {
            throw new Error(
              `Symlink escape detected: "${current}" points outside publication root`,
            );
          }
        }
      } catch (e) {
        if (e instanceof Error && e.message.includes("Symlink escape")) throw e;
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

export class PublicationStore {
  readonly publicationDir: string;

  constructor(config: StoreConfig) {
    this.publicationDir = resolve(config.publicationDir);
    if (!existsSync(this.publicationDir)) {
      mkdirSync(this.publicationDir, { recursive: true });
    }
  }

  versionDir(listKey: string, sequenceNumber: number): string {
    const seqStr = String(sequenceNumber);
    assertSafeSegment(listKey, SAFE_KEY_RE, "list key");
    assertSafeSegment(seqStr, SAFE_SEQ_RE, "sequence number");
    return resolve(this.publicationDir, listKey, "versions", seqStr);
  }

  indexPath(listKey: string): string {
    assertSafeSegment(listKey, SAFE_KEY_RE, "list key");
    return resolve(this.publicationDir, listKey, "index.json");
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
  ): void {
    const finalDir = this.versionDir(result.listKey, result.sequenceNumber);

    // Check for existing version
    if (existsSync(finalDir)) {
      const existingManifestPath = this.manifestPath(
        result.listKey,
        result.sequenceNumber,
      );
      if (existsSync(existingManifestPath)) {
        const existing = JSON.parse(
          readFileSync(existingManifestPath, "utf-8"),
        ) as Manifest;
        if (
          existing.compactJadesSha256 === result.manifest.compactJadesSha256 &&
          existing.loteJsonSha256 === result.manifest.loteJsonSha256
        ) {
          return; // Idempotent
        }
      }
      throw new Error(
        `Version ${result.sequenceNumber} for list "${result.listKey}" already exists with different content`,
      );
    }

    // Verify no symlink escapes in the target path
    rejectSymlinksInPath(this.publicationDir, finalDir);

    // Stage: create private temp directory under publication root
    const stageDir = resolve(
      this.publicationDir,
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

      // Verify staged content matches manifesto
      const writtenJades = readFileSync(stageJades, "utf-8");
      const writtenJson = readFileSync(stageJson, "utf-8");

      const jadesHash = createHash("sha256").update(writtenJades).digest("hex");
      const jsonHash = createHash("sha256").update(writtenJson).digest("hex");

      if (jadesHash !== result.manifest.compactJadesSha256) {
        throw new Error(
          `Staged Compact JAdES hash mismatch: expected ${result.manifest.compactJadesSha256}, got ${jadesHash}`,
        );
      }
      if (jsonHash !== result.manifest.loteJsonSha256) {
        throw new Error(
          `Staged LoTE JSON hash mismatch: expected ${result.manifest.loteJsonSha256}, got ${jsonHash}`,
        );
      }

      // Create parent dirs for final location
      const listDir = resolve(this.publicationDir, result.listKey);
      const versionsDir = resolve(listDir, "versions");
      mkdirSync(versionsDir, { recursive: true });

      // Atomic rename from stage to final
      renameSync(stageDir, finalDir);

      // Derive index from version manifests
      this.deriveIndex(result.listKey);
    } catch (e) {
      removeDir(stageDir);
      throw e;
    }
  }

  private deriveIndex(listKey: string): void {
    assertSafeSegment(listKey, SAFE_KEY_RE, "list key");
    const indexPath = this.indexPath(listKey);
    const versionsDir = resolve(this.publicationDir, listKey, "versions");

    if (!existsSync(versionsDir)) return;

    const entries = readdirSync(versionsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => {
        const seq = parseInt(d.name, 10);
        if (!SAFE_SEQ_RE.test(d.name)) return null;
        const maniPath = resolve(versionsDir, d.name, "manifest.json");
        if (!existsSync(maniPath)) return null;
        try {
          const m = JSON.parse(readFileSync(maniPath, "utf-8")) as Manifest;
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
        } catch {
          return null;
        }
      })
      .filter((e): e is NonNullable<typeof e> => e !== null)
      .sort((a, b) => a.sequenceNumber - b.sequenceNumber);

    const index: IndexEntry = {
      listKey,
      versions: entries,
    };

    writeFileSync(indexPath, JSON.stringify(index, null, 2), "utf-8");
  }

  loadIndex(listKey: string): IndexEntry | null {
    assertSafeSegment(listKey, SAFE_KEY_RE, "list key");
    return this.deriveOrLoadIndex(listKey);
  }

  private deriveOrLoadIndex(listKey: string): IndexEntry | null {
    const indexPath = this.indexPath(listKey);
    if (!existsSync(indexPath)) {
      // Try to derive from version manifests
      const versionsDir = resolve(this.publicationDir, listKey, "versions");
      if (existsSync(versionsDir)) {
        this.deriveIndex(listKey);
        if (existsSync(indexPath)) {
          return JSON.parse(readFileSync(indexPath, "utf-8")) as IndexEntry;
        }
      }
      return null;
    }
    try {
      return JSON.parse(readFileSync(indexPath, "utf-8")) as IndexEntry;
    } catch {
      // Corrupt index — derive from manifests
      this.deriveIndex(listKey);
      if (existsSync(indexPath)) {
        try {
          return JSON.parse(readFileSync(indexPath, "utf-8")) as IndexEntry;
        } catch {
          return null;
        }
      }
      return null;
    }
  }

  loadManifest(listKey: string, sequenceNumber: number): Manifest | null {
    assertSafeSegment(listKey, SAFE_KEY_RE, "list key");
    assertSafeSegment(String(sequenceNumber), SAFE_SEQ_RE, "sequence number");
    const mp = this.manifestPath(listKey, sequenceNumber);
    if (!existsSync(mp)) return null;
    try {
      return JSON.parse(readFileSync(mp, "utf-8")) as Manifest;
    } catch {
      return null;
    }
  }

  listKeys(): string[] {
    if (!existsSync(this.publicationDir)) return [];
    return readdirSync(this.publicationDir, { withFileTypes: true })
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
