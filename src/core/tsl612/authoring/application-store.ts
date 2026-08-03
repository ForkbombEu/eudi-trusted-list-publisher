/**
 * The mutable store of TS 119 612 applications.
 *
 * One JSON file per application, in its own directory, separate from both the
 * TS 119 602 authoring store and the immutable publication store. Records are
 * replaced atomically through tmp+rename, and a stored record is validated
 * against what a TS 119 612 application must be before it is handed back — a
 * drifted file is refused rather than half-read.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomBytes, randomUUID, X509Certificate } from "node:crypto";
import { join, resolve } from "node:path";
import { isTslFamily } from "../registry.js";
import {
  TSL_APPLICATION_SCHEMA_VERSION,
  type TslApplicationRecord,
  type TslApplicationState,
} from "./application-model.js";

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const STATES: readonly TslApplicationState[] = Object.freeze([
  "submitted",
  "approved",
  "rejected",
  "published",
  "superseded",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A stored record must be a TS 119 612 application in every respect it claims.
 * The certificate is re-parsed because a record whose PEM no longer parses
 * cannot be published, and finding that out at publication time would be late.
 */
function validate(value: unknown, id: string): TslApplicationRecord {
  if (!isRecord(value)) throw new Error(`Application ${id} is not an object.`);
  if (value.standard !== "TS 119 612")
    throw new Error(
      `Application ${id} is not a TS 119 612 application; this store holds only those.`,
    );
  if (value.schemaVersion !== TSL_APPLICATION_SCHEMA_VERSION)
    throw new Error(
      `Application ${id} has schema version ${String(value.schemaVersion)}; this build reads ${TSL_APPLICATION_SCHEMA_VERSION}.`,
    );
  if (typeof value.family !== "string" || !isTslFamily(value.family))
    throw new Error(`Application ${id} names no TS 119 612 family.`);
  if (
    typeof value.state !== "string" ||
    !(STATES as readonly string[]).includes(value.state)
  )
    throw new Error(`Application ${id} has an unknown state.`);
  if (typeof value.listKey !== "string" || value.listKey === "")
    throw new Error(`Application ${id} names no Trusted List.`);
  if (typeof value.certificatePem !== "string" || value.certificatePem === "")
    throw new Error(`Application ${id} carries no service certificate.`);
  try {
    new X509Certificate(value.certificatePem);
  } catch {
    throw new Error(
      `Application ${id} carries a certificate that does not parse.`,
    );
  }
  if (value.id !== id)
    throw new Error(`Application ${id} states a different id.`);
  return value as unknown as TslApplicationRecord;
}

export interface TslApplicationStoreConfig {
  readonly applicationsDir: string;
}

export class TslApplicationStore {
  private readonly root: string;

  constructor(config: TslApplicationStoreConfig) {
    const root = resolve(config.applicationsDir);
    if (!existsSync(root)) mkdirSync(root, { recursive: true });
    if (lstatSync(root).isSymbolicLink())
      throw new Error(
        "TS 119 612 application root is a symlink — rejected for security",
      );
    this.root = realpathSync(root);
  }

  private pathFor(id: string): string {
    if (!ID_RE.test(id))
      throw new Error(`'${id}' is not a valid application id.`);
    return join(this.root, `${id}.json`);
  }

  create(record: Omit<TslApplicationRecord, "id">): TslApplicationRecord {
    const id = randomUUID();
    const full = { ...record, id } as TslApplicationRecord;
    this.write(full);
    return full;
  }

  /** Atomic replacement: a reader never observes a half-written record. */
  write(record: TslApplicationRecord): void {
    validate(record, record.id);
    const path = this.pathFor(record.id);
    const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, {
        encoding: "utf-8",
        flag: "wx",
      });
      renameSync(temporary, path);
    } catch (error) {
      try {
        if (existsSync(temporary)) unlinkSync(temporary);
      } catch {
        /* preserve the original failure */
      }
      throw error;
    }
  }

  load(id: string): TslApplicationRecord | null {
    const path = this.pathFor(id);
    if (!existsSync(path) || lstatSync(path).isSymbolicLink()) return null;
    return validate(JSON.parse(readFileSync(path, "utf-8")) as unknown, id);
  }

  /** Every readable application, newest submission first. */
  list(): TslApplicationRecord[] {
    if (!existsSync(this.root)) return [];
    const records: TslApplicationRecord[] = [];
    for (const name of readdirSync(this.root)) {
      if (!name.endsWith(".json")) continue;
      const id = name.slice(0, -".json".length);
      if (!ID_RE.test(id)) continue;
      try {
        const record = this.load(id);
        if (record) records.push(record);
      } catch {
        /* A drifted record must not stop the administration pages loading. */
      }
    }
    return records.sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));
  }

  /** Applications targeting one Trusted List. */
  listForListKey(listKey: string): TslApplicationRecord[] {
    return this.list().filter((record) => record.listKey === listKey);
  }

  delete(id: string): boolean {
    const path = this.pathFor(id);
    if (!existsSync(path)) return false;
    unlinkSync(path);
    return true;
  }
}
