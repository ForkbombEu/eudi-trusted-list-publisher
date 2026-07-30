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

/**
 * Annex H expresses the Union or national legal basis of a Pub-EAA provider as
 * an `OJ:` URI. The applicant supplies the Official Journal reference; the
 * scheme prefix is added here so the published value is always a URI, and
 * whitespace is removed because a URI cannot carry any.
 */
export function legalBasisUri(reference: string): string {
  const compact = reference.trim().replace(/\s+/g, "");
  if (!compact) throw new Error("Legal basis reference is empty.");
  return compact.startsWith("OJ:") ? compact : `OJ:${compact}`;
}

/**
 * True when the value is an Official Journal reference this project accepts.
 * Whitespace inside the reference is rejected rather than glued together: a
 * value with spaces in it is prose, not a citation.
 */
export function isLegalBasisReference(reference: string): boolean {
  const trimmed = reference.trim();
  const body = trimmed.startsWith("OJ:") ? trimmed.slice(3) : trimmed;
  /* Path characters only: the reference becomes the path of an OJ: URI. */
  return body.length > 0 && /^[A-Za-z0-9._~!$&'()*+,;=:@/%-]+$/.test(body);
}

/** `<prefix>/<country code>` role URI for a trusted entity. */
export function roleUri(prefix: string, countryCode: string): string {
  return `${prefix}/${countryCode}`;
}
