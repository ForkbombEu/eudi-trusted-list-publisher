/**
 * The immutable publication store for TS 119 612 Trusted Lists.
 *
 * It shares the publication root, the version layout and the path-safety rules
 * of the TS 119 602 store, and reuses that module's guards rather than
 * restating them. What differs is the artifact set: one signed XML file, its
 * digest, and a format-aware manifest — there is no detached signature to
 * store, because a XAdES signature is inside the document it signs.
 *
 * `trusted-list.xml`, `trusted-list.sha2` and `manifest.json` are the
 * integrity-checked set. `inspector.json` sits beside them and deliberately
 * outside it: it is evidence produced after publication and can be re-run,
 * while the three published files never change.
 */
import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import {
  SAFE_KEY_RE,
  SAFE_SEQ_RE,
  assertSafeSegment,
  defaultFsOps,
  rejectSymlinksInPath,
  removeDir,
  resolveCanonicalRoot,
  type FsOps,
  type StoreConfig,
} from "./store.js";
import {
  sha256Hex,
  sha2FileContent,
  type TrustedListManifest,
} from "./tsl-manifest.js";

export const TRUSTED_LIST_XML_FILE = "trusted-list.xml";
export const TRUSTED_LIST_SHA2_FILE = "trusted-list.sha2";
export const TRUSTED_LIST_MANIFEST_FILE = "manifest.json";
export const TRUSTED_LIST_INSPECTOR_FILE = "inspector.json";
export const TRUSTED_LIST_FIXTURE_FILE = "fixture.json";

const MAX_FILE_BYTES = 10 * 1024 * 1024;

export interface TrustedListVersionArtifacts {
  readonly xml: string;
  readonly sha2: string;
  readonly manifest: TrustedListManifest;
  readonly manifestBytes: string;
}

export interface TrustedListVersionReadResult {
  readonly artifacts: TrustedListVersionArtifacts | null;
  readonly diagnostic: string;
}

function isTrustedListManifest(value: unknown): value is TrustedListManifest {
  if (typeof value !== "object" || value === null) return false;
  const manifest = value as Record<string, unknown>;
  return (
    manifest.standard === "TS 119 612" &&
    typeof manifest.listKey === "string" &&
    typeof manifest.sequenceNumber === "number" &&
    typeof manifest.trustedListXmlSha256 === "string"
  );
}

export class TrustedListStore {
  readonly publicationDir: string;
  private readonly canonicalRoot: string;
  private readonly fs: FsOps;

  constructor(config: StoreConfig, fs?: FsOps) {
    this.fs = fs ?? defaultFsOps;
    this.canonicalRoot = resolveCanonicalRoot(
      this.fs,
      resolve(config.publicationDir),
    );
    this.publicationDir = this.canonicalRoot;
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

  xmlPath(listKey: string, sequenceNumber: number): string {
    return join(
      this.versionDir(listKey, sequenceNumber),
      TRUSTED_LIST_XML_FILE,
    );
  }

  sha2Path(listKey: string, sequenceNumber: number): string {
    return join(
      this.versionDir(listKey, sequenceNumber),
      TRUSTED_LIST_SHA2_FILE,
    );
  }

  manifestPath(listKey: string, sequenceNumber: number): string {
    return join(
      this.versionDir(listKey, sequenceNumber),
      TRUSTED_LIST_MANIFEST_FILE,
    );
  }

  inspectorPath(listKey: string, sequenceNumber: number): string {
    return join(
      this.versionDir(listKey, sequenceNumber),
      TRUSTED_LIST_INSPECTOR_FILE,
    );
  }

  /** True when this version was published as an XML Trusted List. */
  isTrustedListVersion(listKey: string, sequenceNumber: number): boolean {
    try {
      return this.fs.existsSync(this.xmlPath(listKey, sequenceNumber));
    } catch {
      return false;
    }
  }

  /** True when the list's stored versions are XML Trusted Lists. */
  isTrustedList(listKey: string): boolean {
    const highest = this.getHighestStoredSequence(listKey);
    return highest !== null && this.isTrustedListVersion(listKey, highest);
  }

  private readBounded(path: string): string {
    const size = this.fs.statSync(path).size;
    if (size > MAX_FILE_BYTES)
      throw new Error(
        `${path} is larger than the ${MAX_FILE_BYTES} byte limit.`,
      );
    return this.fs.readFileSync(path, "utf-8");
  }

  /**
   * Reads one version and re-checks its integrity from the bytes on disk: the
   * XML must hash to what both the manifest and the `.sha2` file state, and the
   * manifest must be about this list and this sequence. A version that fails
   * any of those is reported as unreadable rather than returned with a note.
   */
  loadVersion(
    listKey: string,
    sequenceNumber: number,
  ): TrustedListVersionReadResult {
    let xmlPath: string;
    let sha2Path: string;
    let manifestPath: string;
    try {
      xmlPath = this.xmlPath(listKey, sequenceNumber);
      sha2Path = this.sha2Path(listKey, sequenceNumber);
      manifestPath = this.manifestPath(listKey, sequenceNumber);
    } catch (error) {
      return {
        artifacts: null,
        diagnostic: error instanceof Error ? error.message : String(error),
      };
    }

    try {
      const versionDir = this.versionDir(listKey, sequenceNumber);
      if (!this.fs.existsSync(versionDir))
        return { artifacts: null, diagnostic: "version directory is absent" };
      rejectSymlinksInPath(this.fs, this.canonicalRoot, versionDir);
      for (const path of [xmlPath, sha2Path, manifestPath]) {
        if (!this.fs.existsSync(path))
          return { artifacts: null, diagnostic: `${path} is absent` };
        rejectSymlinksInPath(this.fs, this.canonicalRoot, path);
      }

      const xml = this.readBounded(xmlPath);
      const sha2 = this.readBounded(sha2Path);
      const manifestBytes = this.readBounded(manifestPath);

      const parsed: unknown = JSON.parse(manifestBytes);
      if (!isTrustedListManifest(parsed))
        return {
          artifacts: null,
          diagnostic: "manifest.json is not a TS 119 612 manifest",
        };

      const actual = sha256Hex(Buffer.from(xml, "utf-8"));
      if (parsed.trustedListXmlSha256 !== actual)
        return {
          artifacts: null,
          diagnostic:
            "trusted-list.xml does not match the hash in manifest.json",
        };
      /*
        The `.sha2` file is checked against what the manifest says was
        published, not against the XML. For every honest publication those are
        the same value. They differ only for the `incorrect_sha2_digest`
        fixture, whose whole point is a sidecar digest that does not describe
        its artifact — and that fixture still has to be readable and servable,
        so the integrity check here is "the bytes are the ones we published",
        not "the bytes are correct".
      */
      const publishedSha2 = parsed.trustedListSha2Published ?? actual;
      if (sha2.trim() !== publishedSha2)
        return {
          artifacts: null,
          diagnostic:
            "trusted-list.sha2 is not the digest recorded in manifest.json",
        };
      if (
        parsed.listKey !== listKey ||
        parsed.sequenceNumber !== sequenceNumber
      )
        return {
          artifacts: null,
          diagnostic: "manifest.json describes a different list or sequence",
        };

      return {
        artifacts: { xml, sha2, manifest: parsed, manifestBytes },
        diagnostic: "",
      };
    } catch (error) {
      return {
        artifacts: null,
        diagnostic: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Writes one version atomically. The bytes are staged, read back and
   * re-hashed before the directory is renamed into place, so a version that
   * exists is a version that was verified after it was written.
   *
   * Re-storing byte-identical content succeeds; storing different content for
   * an existing sequence is refused, because a published version is immutable.
   */
  store(xml: string, manifest: TrustedListManifest): void {
    const listKey = manifest.listKey;
    const sequenceNumber = manifest.sequenceNumber;
    const finalDir = this.versionDir(listKey, sequenceNumber);
    const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;
    const sha2 = manifest.trustedListSha2Published ?? sha2FileContent(xml);

    if (sha256Hex(Buffer.from(xml, "utf-8")) !== manifest.trustedListXmlSha256)
      throw new Error(
        "Refusing to store: the manifest hash does not describe the XML being stored.",
      );

    if (this.fs.existsSync(finalDir)) {
      const existing = this.loadVersion(listKey, sequenceNumber);
      if (!existing.artifacts)
        throw new Error(
          `Existing publication is corrupt: ${existing.diagnostic}`,
        );
      if (existing.artifacts.xml === xml) return;
      throw new Error(
        `Version ${sequenceNumber} for list "${listKey}" already exists with different content`,
      );
    }

    rejectSymlinksInPath(this.fs, this.canonicalRoot, finalDir);
    if (!this.fs.existsSync(this.canonicalRoot))
      this.fs.mkdirSync(this.canonicalRoot, { recursive: true });

    const stageDir = resolve(
      this.canonicalRoot,
      `.staging_${randomBytes(8).toString("hex")}`,
    );
    this.fs.mkdirSync(stageDir, { recursive: true });
    try {
      this.fs.writeFileSync(join(stageDir, TRUSTED_LIST_XML_FILE), xml, {
        encoding: "utf-8",
      });
      this.fs.writeFileSync(join(stageDir, TRUSTED_LIST_SHA2_FILE), sha2, {
        encoding: "utf-8",
      });
      this.fs.writeFileSync(
        join(stageDir, TRUSTED_LIST_MANIFEST_FILE),
        manifestJson,
        { encoding: "utf-8" },
      );

      const writtenXml = this.fs.readFileSync(
        join(stageDir, TRUSTED_LIST_XML_FILE),
        "utf-8",
      );
      if (
        sha256Hex(Buffer.from(writtenXml, "utf-8")) !==
        manifest.trustedListXmlSha256
      )
        throw new Error("Staged Trusted List XML hash mismatch");
      const writtenSha2 = this.fs.readFileSync(
        join(stageDir, TRUSTED_LIST_SHA2_FILE),
        "utf-8",
      );
      if (writtenSha2 !== sha2)
        throw new Error(
          "Staged trusted-list.sha2 is not the digest that was meant to be published",
        );

      this.fs.mkdirSync(resolve(this.canonicalRoot, listKey, "versions"), {
        recursive: true,
      });
      this.fs.renameSync(stageDir, finalDir);
    } catch (error) {
      removeDir(this.fs, stageDir);
      throw error;
    }
  }

  /** Writes, or replaces, the Trust Inspector evaluation of one version. */
  writeInspectorEvaluation(
    listKey: string,
    sequenceNumber: number,
    evaluationJson: string,
  ): void {
    const path = this.inspectorPath(listKey, sequenceNumber);
    if (!this.fs.existsSync(this.versionDir(listKey, sequenceNumber)))
      throw new Error(
        `Cannot store an evaluation for "${listKey}" sequence ${sequenceNumber}: the version does not exist.`,
      );
    const temporary = `${path}.tmp_${randomBytes(6).toString("hex")}`;
    this.fs.writeFileSync(temporary, evaluationJson, { encoding: "utf-8" });
    this.fs.renameSync(temporary, path);
  }

  readInspectorEvaluation(
    listKey: string,
    sequenceNumber: number,
  ): string | null {
    try {
      const path = this.inspectorPath(listKey, sequenceNumber);
      if (!this.fs.existsSync(path)) return null;
      return this.readBounded(path);
    } catch {
      return null;
    }
  }

  fixturePath(listKey: string, sequenceNumber: number): string {
    return join(
      this.versionDir(listKey, sequenceNumber),
      TRUSTED_LIST_FIXTURE_FILE,
    );
  }

  /**
   * Writes the negative-fixture evidence of one version. Like the Inspector
   * evaluation it sits outside the integrity-checked set: it describes the
   * version, and the three published files never change.
   */
  writeFixtureMetadata(
    listKey: string,
    sequenceNumber: number,
    metadataJson: string,
  ): void {
    const path = this.fixturePath(listKey, sequenceNumber);
    if (!this.fs.existsSync(this.versionDir(listKey, sequenceNumber)))
      throw new Error(
        `Cannot store fixture metadata for "${listKey}" sequence ${sequenceNumber}: the version does not exist.`,
      );
    const temporary = `${path}.tmp_${randomBytes(6).toString("hex")}`;
    this.fs.writeFileSync(temporary, metadataJson, { encoding: "utf-8" });
    this.fs.renameSync(temporary, path);
  }

  readFixtureMetadata(listKey: string, sequenceNumber: number): string | null {
    try {
      const path = this.fixturePath(listKey, sequenceNumber);
      if (!this.fs.existsSync(path)) return null;
      return this.readBounded(path);
    } catch {
      return null;
    }
  }

  getHighestStoredSequence(listKey: string): number | null {
    try {
      assertSafeSegment(listKey, SAFE_KEY_RE, "list key");
    } catch {
      return null;
    }
    const versionsDir = resolve(this.canonicalRoot, listKey, "versions");
    if (!this.fs.existsSync(versionsDir)) return null;
    const sequences = this.fs
      .readdirSync(versionsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && SAFE_SEQ_RE.test(entry.name))
      .map((entry) => parseInt(entry.name, 10));
    return sequences.length === 0 ? null : Math.max(...sequences);
  }

  /** Every stored sequence of a list, ascending. */
  sequences(listKey: string): number[] {
    try {
      assertSafeSegment(listKey, SAFE_KEY_RE, "list key");
    } catch {
      return [];
    }
    const versionsDir = resolve(this.canonicalRoot, listKey, "versions");
    if (!this.fs.existsSync(versionsDir)) return [];
    return this.fs
      .readdirSync(versionsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && SAFE_SEQ_RE.test(entry.name))
      .map((entry) => parseInt(entry.name, 10))
      .sort((a, b) => a - b);
  }

  /** The latest readable version of a list, or null when it has none. */
  loadLatest(listKey: string): {
    sequenceNumber: number;
    artifacts: TrustedListVersionArtifacts;
  } | null {
    const highest = this.getHighestStoredSequence(listKey);
    if (highest === null) return null;
    const outcome = this.loadVersion(listKey, highest);
    if (!outcome.artifacts) return null;
    return { sequenceNumber: highest, artifacts: outcome.artifacts };
  }
}
