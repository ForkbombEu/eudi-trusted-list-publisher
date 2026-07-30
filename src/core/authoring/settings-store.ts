import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { PROFILE_REGISTRY, type ProfileFamily } from "../profiles/registry.js";

export const SETTINGS_SCHEMA_VERSION = 1;
export const SETTINGS_FILE_NAME = "settings.json";

/**
 * Administrator settings for onboarding automation.
 *
 * `families` is keyed by profile family, `lists` by signing-configuration list
 * key. A `true` entry means every application targeting that family, or that
 * list, is approved and published without administrator intervention.
 */
export interface PublisherSettings {
  schemaVersion: typeof SETTINGS_SCHEMA_VERSION;
  autoApproveFamilies: Partial<Record<ProfileFamily, boolean>>;
  autoApproveLists: Record<string, boolean>;
}

/*
  The same character set the publication store derives keys with
  (`SAFE_KEY_RE` in src/core/publication/store.ts). A narrower set here would
  reject a list key the publisher itself can create — an operator name with a
  hyphen in it, for instance.
*/
const SAFE_LIST_KEY = /^[a-z0-9][a-z0-9_.@()-]{0,99}$/;

export function emptySettings(): PublisherSettings {
  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    autoApproveFamilies: {},
    autoApproveLists: {},
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Unknown families, unsafe list keys and non-boolean values are dropped rather
 * than rejected: a settings file that has drifted must never keep the
 * administration pages from loading.
 */
function parseSettings(value: unknown): PublisherSettings {
  if (!isRecord(value) || value.schemaVersion !== SETTINGS_SCHEMA_VERSION) {
    return emptySettings();
  }
  const settings = emptySettings();
  if (isRecord(value.autoApproveFamilies)) {
    for (const [family, enabled] of Object.entries(value.autoApproveFamilies)) {
      if (enabled === true && family in PROFILE_REGISTRY) {
        settings.autoApproveFamilies[family as ProfileFamily] = true;
      }
    }
  }
  if (isRecord(value.autoApproveLists)) {
    for (const [listKey, enabled] of Object.entries(value.autoApproveLists)) {
      if (enabled === true && SAFE_LIST_KEY.test(listKey)) {
        settings.autoApproveLists[listKey] = true;
      }
    }
  }
  return settings;
}

export interface SettingsStoreConfig {
  settingsDir: string;
}

export class SettingsStore {
  private readonly canonicalRoot: string;

  constructor(config: SettingsStoreConfig) {
    const root = resolve(config.settingsDir);
    if (!existsSync(root)) mkdirSync(root, { recursive: true });
    if (lstatSync(root).isSymbolicLink())
      throw new Error("Settings root is a symlink — rejected for security");
    this.canonicalRoot = realpathSync(root);
  }

  get path(): string {
    return resolve(this.canonicalRoot, SETTINGS_FILE_NAME);
  }

  load(): PublisherSettings {
    const path = this.path;
    if (!existsSync(path) || lstatSync(path).isSymbolicLink())
      return emptySettings();
    try {
      return parseSettings(JSON.parse(readFileSync(path, "utf-8")) as unknown);
    } catch {
      return emptySettings();
    }
  }

  save(settings: PublisherSettings): void {
    const normalized = parseSettings(settings);
    const path = this.path;
    const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(normalized, null, 2), {
        encoding: "utf-8",
        flag: "wx",
      });
      renameSync(temporary, path);
    } catch (error: unknown) {
      try {
        if (existsSync(temporary)) unlinkSync(temporary);
      } catch {
        // Preserve the original write or rename failure.
      }
      throw error;
    }
  }

  /**
   * A list-level opt-in and a family-level opt-in are equivalent: either one
   * on its own is enough to approve and publish an application automatically.
   */
  isAutoApprove(family: string, listKey: string): boolean {
    const settings = this.load();
    return (
      settings.autoApproveFamilies[family as ProfileFamily] === true ||
      settings.autoApproveLists[listKey] === true
    );
  }
}
