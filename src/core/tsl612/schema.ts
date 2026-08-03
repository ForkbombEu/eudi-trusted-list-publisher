/**
 * Offline XML Schema validation of TS 119 612 Trusted Lists.
 *
 * libxml2 resolves an `xsd:import` by asking for its `schemaLocation`, which in
 * the ETSI and W3C schemas is an absolute `http(s)` URL. Rewriting those URLs
 * inside the vendored files would break the byte-for-byte provenance recorded
 * in `STANDARDS.md`, so instead an input provider answers those exact URLs from
 * `schemas/etsi/119612/`. Nothing here opens a socket: a URL this project has
 * not vendored is simply not matched, and validation fails rather than
 * silently degrading to a partial schema.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  XmlDocument,
  XsdValidator,
  XmlValidateError,
  xmlRegisterInputProvider,
} from "libxml2-wasm";
import type {
  ValidationFinding,
  ValidationResult,
} from "../validate/validate.js";
import {
  SIE_NAMESPACE,
  TSLX_NAMESPACE,
  TSL_NAMESPACE,
  VENDORED_SCHEMAS,
  schemaFileForUrl,
} from "./schema-sources.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Mirrors the resolution in `src/core/validate/validate.ts`. */
export const TSL_SCHEMA_DIR = resolve(
  __dirname,
  "..",
  "..",
  "..",
  "schemas",
  "etsi",
  "119612",
);

export function readVendoredSchema(file: string): Buffer {
  return readFileSync(resolve(TSL_SCHEMA_DIR, file));
}

/**
 * The composite schema. It has no target namespace of its own: it exists only
 * to pull the three ETSI namespaces into one validator, because a Trusted List
 * carries `tsl:` elements, `tslx:` elements inside the pointer to the EU LOTL,
 * and `ds:`/`xades:` elements inside its signature.
 */
const COMPOSITE_SCHEMA = `<?xml version="1.0" encoding="UTF-8"?>
<xsd:schema xmlns:xsd="http://www.w3.org/2001/XMLSchema">
  <xsd:import namespace="${TSL_NAMESPACE}" schemaLocation="${
    VENDORED_SCHEMAS[0]!.url
  }"/>
  <xsd:import namespace="${TSLX_NAMESPACE}" schemaLocation="${
    VENDORED_SCHEMAS[1]!.url
  }"/>
  <xsd:import namespace="${SIE_NAMESPACE}" schemaLocation="${
    VENDORED_SCHEMAS[2]!.url
  }"/>
</xsd:schema>
`;

interface OpenHandle {
  readonly bytes: Buffer;
  offset: number;
}

let nextHandle = 1;
const openHandles = new Map<number, OpenHandle>();
let providerRegistered = false;

/**
 * Serves the vendored schemas to libxml2 under the URLs the ETSI and W3C
 * schemas import them by. Registered once per process.
 */
function registerVendoredSchemaProvider(): void {
  if (providerRegistered) return;
  xmlRegisterInputProvider({
    match(filename: string): boolean {
      return schemaFileForUrl(filename) !== undefined;
    },
    open(filename: string): number | undefined {
      const file = schemaFileForUrl(filename);
      if (!file) return undefined;
      try {
        const handle = nextHandle++;
        openHandles.set(handle, { bytes: readVendoredSchema(file), offset: 0 });
        return handle;
      } catch {
        return undefined;
      }
    },
    read(fd: number, buf: Uint8Array): number {
      const open = openHandles.get(fd);
      if (!open) return -1;
      const end = Math.min(open.bytes.length, open.offset + buf.byteLength);
      const read = end - open.offset;
      if (read <= 0) return 0;
      buf.set(open.bytes.subarray(open.offset, end));
      open.offset = end;
      return read;
    },
    close(fd: number): boolean {
      openHandles.delete(fd);
      return true;
    },
  });
  providerRegistered = true;
}

let validator: XsdValidator | undefined;

function getValidator(): XsdValidator {
  if (!validator) {
    registerVendoredSchemaProvider();
    using schemaDocument = XmlDocument.fromString(COMPOSITE_SCHEMA);
    validator = XsdValidator.fromDoc(schemaDocument);
  }
  return validator;
}

function toFindings(error: unknown): ValidationFinding[] {
  if (error instanceof XmlValidateError) {
    const details = error.details ?? [];
    if (details.length > 0) {
      return details.map((detail) => ({
        path: detail.line ? `tsl612:line ${detail.line}` : "tsl612",
        message: detail.message.trim(),
      }));
    }
    return [{ path: "tsl612", message: error.message.trim() }];
  }
  return [
    {
      path: "tsl612",
      message: error instanceof Error ? error.message : String(error),
    },
  ];
}

/**
 * Validate a serialized Trusted List against the pinned TS 119 612 V2.4.1
 * schemas. Parse failures are reported as findings, not thrown, so a caller
 * treats a malformed document and an invalid document the same way.
 */
export function validateTslXml(xml: string): ValidationResult {
  let document: XmlDocument;
  try {
    document = XmlDocument.fromString(xml);
  } catch (error) {
    return { valid: false, findings: toFindings(error) };
  }
  try {
    getValidator().validate(document);
    return { valid: true, findings: [] };
  } catch (error) {
    return { valid: false, findings: toFindings(error) };
  } finally {
    document.dispose();
  }
}

/** Releases the cached validator; used by tests. */
export function resetTslSchemaValidator(): void {
  validator?.dispose();
  validator = undefined;
}
