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
let _pubEaaValidate: ValidateFunction | undefined;

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

async function getPubEaaValidator(): Promise<ValidateFunction> {
  if (!_pubEaaValidate) {
    const ajv = new Ajv({ allErrors: true, strict: false });
    const schema = loadJson(
      resolve(SCHEMAS_DIR, "profiles", "pub-eaa-schema.json"),
    ) as object;
    _pubEaaValidate = ajv.compile(schema);
  }
  return _pubEaaValidate;
}

function isPubEaaDocument(document: unknown): boolean {
  if (!document || typeof document !== "object") return false;
  const lote = (document as Record<string, unknown>)["LoTE"];
  if (!lote || typeof lote !== "object") return false;
  const information = (lote as Record<string, unknown>)[
    "ListAndSchemeInformation"
  ];
  return (
    !!information &&
    typeof information === "object" &&
    (information as Record<string, unknown>)["LoTEType"] ===
      "http://uri.etsi.org/19602/LoTEType/EUPubEAAProvidersList"
  );
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
  const baseValid = validate(document);
  const findings = toFindings(validate, "etsi");
  let profileValid = true;
  if (isPubEaaDocument(document)) {
    const validateProfile = await getPubEaaValidator();
    profileValid = validateProfile(document);
    findings.push(...toFindings(validateProfile, "etsi-profile"));
  }
  return {
    valid: baseValid && profileValid,
    findings,
  };
}

export function resetValidators(): void {
  _authoringValidate = undefined;
  _etsiValidate = undefined;
  _pubEaaValidate = undefined;
}
