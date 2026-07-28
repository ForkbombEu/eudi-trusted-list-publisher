import {
  readFileSync,
  writeFileSync,
  readdirSync,
  existsSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  lstatSync,
  realpathSync,
} from "node:fs";
import { resolve, sep } from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import type { WalletProviderApplication } from "./application-model.js";
import { APPLICATION_SCHEMA_VERSION } from "./application-model.js";

export interface AuthoringStoreConfig {
  authoringDir: string;
}

const SAFE_ID_RE = /^[a-f0-9-]{32,128}$/;

export class AuthoringStore {
  readonly authoringDir: string;
  private canonicalRoot: string;

  constructor(config: AuthoringStoreConfig) {
    const raw = resolve(config.authoringDir);
    if (!existsSync(raw)) {
      mkdirSync(raw, { recursive: true });
    }
    if (lstatSync(raw).isSymbolicLink()) {
      throw new Error("Authoring root is a symlink — rejected for security");
    }
    const real = realpathSync(raw);
    if (real !== resolve(raw) && !isSubpath(resolve(raw), real)) {
      throw new Error("Authoring root canonical path mismatch");
    }
    this.authoringDir = raw;
    this.canonicalRoot = real;
  }

  private appPath(id: string): string {
    if (!SAFE_ID_RE.test(id)) {
      throw new Error(`Unsafe application ID: "${id}"`);
    }
    return resolve(this.canonicalRoot, `${id}.json`);
  }

  private assertCanonicalRoot(): void {
    if (existsSync(this.canonicalRoot)) {
      const real = realpathSync(this.canonicalRoot);
      if (real !== this.canonicalRoot) {
        throw new Error(
          "Authoring root was redirected — canonical root changed",
        );
      }
    }
  }

  save(app: WalletProviderApplication): void {
    this.assertCanonicalRoot();
    const path = this.appPath(app.id);
    const tmpPath = `${path}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      writeFileSync(tmpPath, JSON.stringify(app, null, 2), {
        encoding: "utf-8",
        flag: "wx",
      });
      renameSync(tmpPath, path);
    } catch (e) {
      try {
        unlinkSync(tmpPath);
      } catch {
        /* ignore */
      }
      throw e;
    }
  }

  load(id: string): WalletProviderApplication | null {
    this.assertCanonicalRoot();
    const path = this.appPath(id);
    if (!existsSync(path)) return null;
    if (lstatSync(path).isSymbolicLink()) return null;
    try {
      const raw = readFileSync(path, "utf-8");
      const parsed = JSON.parse(raw);
      if (!isApplication(parsed)) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  delete(id: string): boolean {
    this.assertCanonicalRoot();
    const app = this.load(id);
    if (!app) return false;
    const path = this.appPath(id);
    unlinkSync(path);
    return true;
  }

  list(): WalletProviderApplication[] {
    this.assertCanonicalRoot();
    if (!existsSync(this.canonicalRoot)) return [];
    const entries = readdirSync(this.canonicalRoot, {
      withFileTypes: true,
    });
    const apps: WalletProviderApplication[] = [];
    for (const e of entries) {
      if (!e.isFile()) continue;
      if (!e.name.endsWith(".json")) continue;
      const id = e.name.slice(0, -5);
      if (!SAFE_ID_RE.test(id)) continue;
      const app = this.load(id);
      if (app) apps.push(app);
    }
    apps.sort(
      (a, b) =>
        new Date(a.submittedAt).getTime() - new Date(b.submittedAt).getTime(),
    );
    return apps;
  }

  createId(): string {
    return randomUUID();
  }
}

function isApplication(obj: unknown): obj is WalletProviderApplication {
  if (typeof obj !== "object" || obj === null) return false;
  const a = obj as Record<string, unknown>;
  if (typeof a.id !== "string" || !SAFE_ID_RE.test(a.id)) return false;
  if (a.schemaVersion !== APPLICATION_SCHEMA_VERSION) return false;
  if (a.family !== "wallet-providers") return false;
  if (typeof a.targetListKey !== "string" || a.targetListKey.length === 0)
    return false;
  if (typeof a.state !== "string") return false;
  if (typeof a.submittedAt !== "string") return false;
  if (typeof a.applicantData !== "object" || a.applicantData === null)
    return false;
  return true;
}

function isSubpath(parent: string, child: string): boolean {
  const rel = child.slice(parent.length);
  return rel.startsWith(sep) || rel === "";
}
