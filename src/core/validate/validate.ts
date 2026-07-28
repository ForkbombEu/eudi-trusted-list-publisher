import { Ajv } from "ajv";
import type { ValidateFunction } from "ajv";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

let addFormats: ((ajv: Ajv) => void) | undefined;

async function loadAddFormats(): Promise<(ajv: Ajv) => void> {
  if (!addFormats) {
    const mod = await import("ajv-formats");
    addFormats = (mod.default ?? mod) as unknown as (ajv: Ajv) => void;
  }
  return addFormats;
}

const __dirname = dirname(fileURLToPath(import.meta.url));

const SCHEMAS_DIR = resolve(__dirname, "..", "..", "..", "schemas");

let _authoringValidate: ValidateFunction | undefined;
let _etsiValidate: ValidateFunction | undefined;

function loadJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf-8"));
}

async function getAuthoringValidator(): Promise<ValidateFunction> {
  if (!_authoringValidate) {
    const af = await loadAddFormats();
    const ajv = new Ajv({ allErrors: true, strict: false });
    af(ajv);
    const schema = loadJson(
      resolve(SCHEMAS_DIR, "authoring", "authoring-schema.json"),
    ) as object;
    _authoringValidate = ajv.compile(schema);
  }
  return _authoringValidate;
}

async function getEtsiValidator(): Promise<ValidateFunction> {
  if (!_etsiValidate) {
    const af = await loadAddFormats();
    const ajv = new Ajv({ allErrors: true, strict: false });
    af(ajv);

    const mainSchema = loadJson(
      resolve(SCHEMAS_DIR, "etsi", "1960201_json_schema.json"),
    ) as object;

    const rfcSchema = loadJson(
      resolve(SCHEMAS_DIR, "etsi", "rfc7517.json"),
    ) as object;

    ajv.addSchema(rfcSchema, "rfcs/rfc7517.json");

    _etsiValidate = ajv.compile(mainSchema);
  }
  return _etsiValidate;
}

export interface ValidationFinding {
  path: string;
  message: string;
  keyword?: string;
}

export interface ValidationResult {
  valid: boolean;
  findings: ValidationFinding[];
}

function toFindings(
  validate: ValidateFunction,
  prefix: string,
): ValidationFinding[] {
  if (!validate.errors) return [];
  return validate.errors.map((e) => {
    const path = e.instancePath || "(root)";
    return {
      path: `${prefix}${path}`,
      message: e.message ?? "validation error",
      keyword: e.keyword,
    };
  });
}

export async function validateAuthoring(
  input: unknown,
): Promise<ValidationResult> {
  const validate = await getAuthoringValidator();
  const valid = validate(input);
  return {
    valid,
    findings: toFindings(validate, "authoring"),
  };
}

export async function validateEtsiStruct(
  document: unknown,
): Promise<ValidationResult> {
  const validate = await getEtsiValidator();
  const valid = validate(document);
  return {
    valid,
    findings: toFindings(validate, "etsi"),
  };
}

export function resetValidators(): void {
  _authoringValidate = undefined;
  _etsiValidate = undefined;
}
