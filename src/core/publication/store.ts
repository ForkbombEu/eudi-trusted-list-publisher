import {
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  mkdirSync,
  renameSync,
  realpathSync,
  unlinkSync,
} from "node:fs";
import { resolve, join, normalize, sep } from "node:path";
import { randomBytes } from "node:crypto";
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

function assertInside(base: string, target: string): void {
  const realBase = realpathSync(base);
  try {
    const realTarget = realpathSync(target);
    if (!realTarget.startsWith(realBase + sep)) {
      throw new Error(
        `Path traversal detected: "${target}" is outside "${base}"`,
      );
    }
  } catch {
    // If target does not exist yet, check the normalized resolved path
    const resolved = resolve(base, target);
    const normTarget = normalize(target);
    if (normTarget.startsWith("..") || normTarget.includes(`..${sep}`)) {
      throw new Error(`Path traversal detected in "${target}"`);
    }
    const realParent = realpathSync(resolve(base));
    const normResolved = normalize(resolved);
    if (!normResolved.startsWith(normalize(realParent) + sep)) {
      throw new Error(
        `Path traversal: resolved "${resolved}" is outside "${base}"`,
      );
    }
  }
}

export class PublicationStore {
  readonly publicationDir: string;

  constructor(config: StoreConfig) {
    this.publicationDir = resolve(config.publicationDir);
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

  writeAtomic(filePath: string, content: string): void {
    const dir = resolve(filePath, "..");
    mkdirSync(dir, { recursive: true });
    const tmpPath = filePath + "." + randomBytes(8).toString("hex") + ".tmp";
    try {
      writeFileSync(tmpPath, content, { encoding: "utf-8", flag: "wx" });
      renameSync(tmpPath, filePath);
    } catch (e) {
      try {
        unlinkSync(tmpPath);
      } catch {
        // best effort
      }
      throw e;
    }
  }

  store(
    result: PublicationResult,
    compactJws: string,
    loteJson: string,
    manifestJson: string,
  ): void {
    const dir = this.versionDir(result.listKey, result.sequenceNumber);

    if (existsSync(dir)) {
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
          // Idempotent: same content, skip
          return;
        }
      }
      // Different content at same version — fail
      throw new Error(
        `Version ${result.sequenceNumber} for list "${result.listKey}" already exists with different content`,
      );
    }

    assertInside(this.publicationDir, dir);

    mkdirSync(dir, { recursive: true });

    const jadesPath = this.loteJadesPath(result.listKey, result.sequenceNumber);
    const jsonPath = this.loteJsonPath(result.listKey, result.sequenceNumber);
    const maniPath = this.manifestPath(result.listKey, result.sequenceNumber);

    assertInside(this.publicationDir, jadesPath);
    assertInside(this.publicationDir, jsonPath);
    assertInside(this.publicationDir, maniPath);

    this.writeAtomic(jadesPath, compactJws);
    this.writeAtomic(jsonPath, loteJson);
    this.writeAtomic(maniPath, manifestJson);

    this.updateIndex(result);
  }

  private updateIndex(result: PublicationResult): void {
    const indexPath = this.indexPath(result.listKey);
    assertInside(this.publicationDir, indexPath);

    let index: IndexEntry;
    if (existsSync(indexPath)) {
      index = JSON.parse(readFileSync(indexPath, "utf-8")) as IndexEntry;
    } else {
      index = {
        listKey: result.listKey,
        versions: [],
      };
    }

    const existing = index.versions.find(
      (v) => v.sequenceNumber === result.sequenceNumber,
    );
    if (existing) {
      existing.issueDate = result.manifest.issueDate;
      existing.nextUpdateDate = result.manifest.nextUpdateDate;
      existing.publicationTimestamp = result.manifest.publicationTimestamp;
      existing.compactJadesSha256 = result.manifest.compactJadesSha256;
      existing.loteJsonSha256 = result.manifest.loteJsonSha256;
    } else {
      index.versions.push({
        sequenceNumber: result.sequenceNumber,
        issueDate: result.manifest.issueDate,
        nextUpdateDate: result.manifest.nextUpdateDate,
        publicationTimestamp: result.manifest.publicationTimestamp,
        compactJadesSha256: result.manifest.compactJadesSha256,
        loteJsonSha256: result.manifest.loteJsonSha256,
        signatureValid: result.manifest.signatureValid,
        etsiSchemaValid: result.manifest.etsiSchemaValid,
        signerTrustStatus: result.manifest.signerTrustStatus,
      });
    }

    index.versions.sort((a, b) => a.sequenceNumber - b.sequenceNumber);

    writeFileSync(indexPath, JSON.stringify(index, null, 2), "utf-8");
  }

  loadIndex(listKey: string): IndexEntry | null {
    assertSafeSegment(listKey, SAFE_KEY_RE, "list key");
    const indexPath = this.indexPath(listKey);
    if (!existsSync(indexPath)) return null;
    return JSON.parse(readFileSync(indexPath, "utf-8")) as IndexEntry;
  }

  loadManifest(listKey: string, sequenceNumber: number): Manifest | null {
    const mp = this.manifestPath(listKey, sequenceNumber);
    if (!existsSync(mp)) return null;
    return JSON.parse(readFileSync(mp, "utf-8")) as Manifest;
  }

  listKeys(): string[] {
    if (!existsSync(this.publicationDir)) return [];
    return readdirSync(this.publicationDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
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
