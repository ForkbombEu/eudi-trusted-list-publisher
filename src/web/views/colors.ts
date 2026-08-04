import {
  LIST_FAMILIES,
  type FamilyKey,
} from "../../core/authoring/list-family-catalogue.js";

/**
 * Colour coding for Trusted List Families and for individual Trusted Lists.
 *
 * A family always renders in the same colour because the families of both
 * standards are a closed set. Individual list keys come from the deployment's signing
 * configuration, so their colour is derived deterministically from the key:
 * the same list key always maps to the same swatch on every page.
 *
 * The colours themselves live in `app.css`; this module only decides which
 * class name a family or list key gets.
 */

/** Number of list swatches defined in app.css as `.chip-list--0 … --7`. */
export const LIST_SWATCH_COUNT = 8;

const FAMILY_SLUGS: Readonly<Record<FamilyKey, string>> = Object.freeze({
  "pid-providers": "pid",
  "wallet-providers": "wallet",
  "wrpac-providers": "wrpac",
  "wrprc-providers": "wrprc",
  "pub-eaa-providers": "pubeaa",
  "eaa-providers": "eaa",
  "qeaa-providers": "qeaa",
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
  const slug = FAMILY_SLUGS[family as FamilyKey];
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

/** Family slug used by the plain list-name colour, or `unknown` when absent. */
export function listNameColorClass(
  family: string | readonly string[] | undefined,
): string {
  /*
    An XML list can accept more than one profile. Its first family gives the
    plain name its colour; the row keeps showing every family chip.
  */
  const first = typeof family === "string" ? family : family?.[0];
  const slug = first ? FAMILY_SLUGS[first as FamilyKey] : undefined;
  return slug ? `list-name--${slug}` : "list-name--unknown";
}

/**
 * A single Trusted List named as plain monospace text in its family's colour.
 *
 * The Catalogue already shows the family as a filled chip on the same row, so
 * a second filled chip for the list key would read as a badge inside a badge.
 */
export function listPlainName(
  listKey: string,
  family?: string | readonly string[],
): string {
  return `<code class="list-name ${listNameColorClass(family)}">${escape(
    listKey,
  )}</code>`;
}

/** Colour-coded chip naming a single Trusted List, shown by its list key. */
export function listChip(listKey: string): string {
  return `<span class="chip chip-list ${listColorClass(
    listKey,
  )}"><code>${escape(listKey)}</code></span>`;
}
