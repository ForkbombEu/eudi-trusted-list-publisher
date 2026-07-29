import { LIST_FAMILIES } from "../../core/authoring/list-family-catalogue.js";
import type { ProfileFamily } from "../../core/profiles/registry.js";

/**
 * Colour coding for Trusted List Families and for individual Trusted Lists.
 *
 * A family always renders in the same colour because the seven families are a
 * closed set. Individual list keys come from the deployment's signing
 * configuration, so their colour is derived deterministically from the key:
 * the same list key always maps to the same swatch on every page.
 *
 * The colours themselves live in `app.css`; this module only decides which
 * class name a family or list key gets.
 */

/** Number of list swatches defined in app.css as `.chip-list--0 … --7`. */
export const LIST_SWATCH_COUNT = 8;

const FAMILY_SLUGS: Readonly<Record<ProfileFamily, string>> = Object.freeze({
  "wallet-providers": "wallet",
  "pid-providers": "pid",
  "non-qualified-eaa-providers": "eaa",
  "qeaa-providers": "qeaa",
  "wrpac-providers": "wrpac",
  "wrprc-providers": "wrprc",
  registrars: "registrar",
});

function escape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Stable, non-cryptographic hash. Only used to pick a swatch. */
function listSwatchIndex(listKey: string): number {
  let hash = 0;
  for (let i = 0; i < listKey.length; i++) {
    hash = (hash * 31 + listKey.charCodeAt(i)) >>> 0;
  }
  return hash % LIST_SWATCH_COUNT;
}

export function familyColorClass(family: string): string {
  const slug = FAMILY_SLUGS[family as ProfileFamily];
  return slug ? `chip-family--${slug}` : "chip-family--unknown";
}

export function listColorClass(listKey: string): string {
  return `chip-list--${listSwatchIndex(listKey)}`;
}

export function familyLabel(family: string): string {
  return (
    LIST_FAMILIES.find((candidate) => candidate.key === family)?.label ?? family
  );
}

/** Colour-coded chip naming a Trusted List Family. */
export function familyChip(family: string, label?: string): string {
  return `<span class="chip chip-family ${familyColorClass(family)}">${escape(
    label ?? familyLabel(family),
  )}</span>`;
}

/** Colour-coded chip naming a single Trusted List, shown by its list key. */
export function listChip(listKey: string): string {
  return `<span class="chip chip-list ${listColorClass(
    listKey,
  )}"><code>${escape(listKey)}</code></span>`;
}
