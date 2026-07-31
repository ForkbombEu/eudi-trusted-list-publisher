/**
 * Lexical forms that ETSI TS 119 602 fixes exactly, collected in one place so
 * every producer emits the same thing.
 */

/** clause 6.1.3: YYYY-MM-DDThh:mm:ssZ — seconds, no fraction, UTC designator. */
export const UTC_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/**
 * Formats an instant in the strict TS 119 602 UTC form. `Date.toISOString()`
 * always emits milliseconds, which the standard's lexical rule forbids.
 */
export function toUtcDateTime(instant: Date): string {
  return `${instant.toISOString().slice(0, 19)}Z`;
}

/** True when the value already uses the strict lexical form. */
export function isUtcDateTime(value: string): boolean {
  return UTC_DATE_TIME.test(value);
}

/**
 * Coerces any parseable date-time to the strict form. Values that are already
 * strict are returned unchanged; unparseable values are rejected rather than
 * silently replaced, because a wrong list issue time is not a cosmetic defect.
 */
export function normalizeUtcDateTime(value: string): string {
  if (isUtcDateTime(value)) return value;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()))
    throw new Error(
      `Value "${value}" is not a date-time and cannot be expressed in the TS 119 602 UTC form.`,
    );
  return toUtcDateTime(parsed);
}

/**
 * clause 6.3.6: SchemeName values carry the scheme territory, then a colon,
 * then the name. Applying it here keeps the operator's configured name readable
 * and makes the prefix idempotent.
 */
export function schemeNameWithTerritory(
  name: string,
  territory: string,
): string {
  const prefix = `${territory}:`;
  return name.startsWith(prefix) ? name : `${prefix}${name}`;
}

/** Strips PEM armour and whitespace, leaving strict Base64 DER. */
export function certificateDerBase64(certificate: string): string {
  const body = certificate.replace(/-----[^-]*-----/g, "").replace(/\s+/g, "");
  if (!body) throw new Error("Certificate value is empty.");
  const der = Buffer.from(body, "base64");
  if (der.length === 0)
    throw new Error("Certificate value is not Base64-encoded data.");
  return der.toString("base64");
}

/** True when the value is strict Base64 with no whitespace or PEM armour. */
export function isStrictBase64(value: string): boolean {
  return value.length > 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}

/** `mailto:` URI for an email address. */
export function mailtoUri(email: string): string {
  return email.startsWith("mailto:") ? email : `mailto:${email}`;
}

/** `tel:` URI for a telephone number, with spaces removed. */
export function telUri(telephone: string): string {
  const compact = telephone.replace(/\s+/g, "");
  return compact.startsWith("tel:") ? compact : `tel:${compact}`;
}

/** ISO 3166-1 alpha-2 codes of the 27 EU Member States. */
export const EU_MEMBER_STATE_CODES: readonly string[] = Object.freeze([
  "AT",
  "BE",
  "BG",
  "HR",
  "CY",
  "CZ",
  "DK",
  "EE",
  "FI",
  "FR",
  "DE",
  "GR",
  "HU",
  "IE",
  "IT",
  "LV",
  "LT",
  "LU",
  "MT",
  "NL",
  "PL",
  "PT",
  "RO",
  "SK",
  "SI",
  "ES",
  "SE",
]);

const LEGAL_BASIS_IDENTIFIER = /^[A-Za-z0-9._~!$&'()*+,;=:@/%-]+$/;

/**
 * Annex H.3 expresses the legal basis of a Pub-EAA provider as `OJ:`, followed
 * by `EU` for Union law or an EU Member State's ISO 3166-1 alpha-2 code for
 * national law, followed by a non-empty identifier for the act.
 */
export function isLegalBasisReference(reference: string): boolean {
  if (!reference || reference !== reference.trim() || /\s/.test(reference))
    return false;
  const body = reference.startsWith("OJ:") ? reference.slice(3) : reference;
  const jurisdiction = body.slice(0, 2);
  const identifier = body.slice(2);
  return (
    (jurisdiction === "EU" || EU_MEMBER_STATE_CODES.includes(jurisdiction)) &&
    LEGAL_BASIS_IDENTIFIER.test(identifier)
  );
}

/** Adds the `OJ:` scheme after validating the complete Annex H.3 reference. */
export function legalBasisUri(reference: string): string {
  const trimmed = reference.trim();
  if (!trimmed) throw new Error("Legal basis reference is empty.");
  if (!isLegalBasisReference(trimmed))
    throw new Error(
      "Legal basis reference must start with EU or an EU Member State country code and include a law identifier.",
    );
  return trimmed.startsWith("OJ:") ? trimmed : `OJ:${trimmed}`;
}

/** `<prefix>/<country code>` role URI for a trusted entity. */
export function roleUri(prefix: string, countryCode: string): string {
  return `${prefix}/${countryCode}`;
}
