import {
  APPLICATION_SCHEMA_VERSION,
  type PIDProviderApplicantData,
  type PIDProviderApplication,
  type ProviderServiceInput,
  type WalletProviderApplicantData,
  type WalletProviderApplication,
} from "./application-model.js";
import {
  getEnabledProfile,
  type EnabledProfileFamily,
} from "../profiles/registry.js";
import {
  checkCertificateSubjectOrganisation,
  classifyCertificateInput,
} from "./certificate-input.js";

export type SubmissionFields = Record<string, string>;
export interface SubmissionFieldError {
  field: string;
  message: string;
}
export interface SubmissionFailure {
  valid: false;
  errors: SubmissionFieldError[];
  applicantData: null;
  preservedFields: SubmissionFields;
}
export interface WalletSubmissionSuccess {
  valid: true;
  errors: [];
  applicantData: WalletProviderApplicantData;
  preservedFields: SubmissionFields;
}
export interface PIDSubmissionSuccess {
  valid: true;
  errors: [];
  applicantData: PIDProviderApplicantData;
  preservedFields: SubmissionFields;
}
export type SubmissionParseResult =
  SubmissionFailure | WalletSubmissionSuccess | PIDSubmissionSuccess;

const SERVICE_FIELD =
  /^service\[(\d+)\]\.(serviceType|serviceName|certificatePem|serviceUniqueIdentifier)$/;

function parseForFamily(
  fields: SubmissionFields,
  targetListKey: string,
  family: "wallet-providers",
): WalletSubmissionSuccess | SubmissionFailure;
function parseForFamily(
  fields: SubmissionFields,
  targetListKey: string,
  family: "pid-providers",
): PIDSubmissionSuccess | SubmissionFailure;
function parseForFamily(
  fields: SubmissionFields,
  targetListKey: string,
  family: EnabledProfileFamily,
): SubmissionParseResult {
  getEnabledProfile(family);
  const errors: SubmissionFieldError[] = [];
  const preservedFields: SubmissionFields = {};
  const allowed = new Set<string>([
    "targetListKey",
    "entityName",
    "entityTradeName",
    "entityStreetAddress",
    "entityLocality",
    "entityPostalCode",
    "entityCountry",
    "entityInformationURI",
    ...(family === "pid-providers" ? ["responsibleMemberState"] : []),
  ]);
  const addError = (field: string, message: string): void => {
    errors.push({ field, message });
  };
  const field = (name: string): string => {
    const value = (fields[name] ?? "").trim();
    preservedFields[name] = value;
    return value;
  };
  for (const key of Object.keys(fields))
    if (!allowed.has(key) && !SERVICE_FIELD.test(key))
      addError(key, "Unknown form field.");
  if (!targetListKey) addError("targetListKey", "Target list key is required.");
  const entityName = field("entityName");
  if (!entityName) addError("entityName", "Entity name is required.");
  const entityTradeName = field("entityTradeName");
  const entityStreetAddress = field("entityStreetAddress");
  if (!entityStreetAddress)
    addError("entityStreetAddress", "Street address is required.");
  const entityLocality = field("entityLocality");
  const entityPostalCode = field("entityPostalCode");
  const entityCountry = field("entityCountry");
  if (!entityCountry) addError("entityCountry", "Country is required.");
  else if (!/^[A-Z]{2}$/.test(entityCountry))
    addError("entityCountry", "Country must be a 2-letter ISO code (e.g. IT).");
  const entityInformationURI = field("entityInformationURI");
  if (!entityInformationURI)
    addError("entityInformationURI", "Information URI is required.");
  else {
    try {
      new URL(entityInformationURI);
    } catch {
      addError("entityInformationURI", "Information URI must be a valid URL.");
    }
  }
  const serviceIndices = new Set<number>();
  for (const key of Object.keys(fields)) {
    const match = SERVICE_FIELD.exec(key);
    if (match) serviceIndices.add(Number(match[1]));
  }
  if (serviceIndices.size === 0)
    addError("services", "At least one service is required.");
  const services: ProviderServiceInput[] = [];
  for (const index of [...serviceIndices].sort((left, right) => left - right)) {
    const prefix = `service[${index}].`;
    const serviceType = field(`${prefix}serviceType`);
    if (!serviceType)
      addError(`${prefix}serviceType`, "Service type is required.");
    else if (serviceType !== "issuance" && serviceType !== "revocation")
      addError(`${prefix}serviceType`, "Invalid service type.");
    const serviceName = field(`${prefix}serviceName`);
    if (!serviceName)
      addError(`${prefix}serviceName`, "Service name is required.");
    const certificatePem = field(`${prefix}certificatePem`);
    /*
      A self-signed or CA-issued X.509 certificate in PEM form is accepted; any
      other PEM or container content is named in the error message so the
      applicant knows which object they supplied. The subject organisation must
      be the Trusted Entity Name, because the service digital identity has to
      identify the entity the list vouches for.
    */
    const certificate = classifyCertificateInput(certificatePem);
    if (certificate.message !== null)
      addError(`${prefix}certificatePem`, certificate.message);
    else if (certificate.certificate) {
      const mismatch = checkCertificateSubjectOrganisation(
        certificate.certificate,
        entityName,
      );
      if (mismatch) addError(`${prefix}certificatePem`, mismatch);
    }
    const serviceUniqueIdentifier = field(`${prefix}serviceUniqueIdentifier`);
    if (!serviceUniqueIdentifier)
      addError(
        `${prefix}serviceUniqueIdentifier`,
        "Service unique identifier is required.",
      );
    else {
      try {
        new URL(serviceUniqueIdentifier);
      } catch {
        addError(
          `${prefix}serviceUniqueIdentifier`,
          "Service unique identifier must be a valid URL/URI.",
        );
      }
    }
    if (
      (serviceType === "issuance" || serviceType === "revocation") &&
      serviceName &&
      certificatePem &&
      serviceUniqueIdentifier
    )
      services.push({
        serviceType,
        serviceName,
        certificatePem,
        serviceUniqueIdentifier,
      });
  }
  const responsibleMemberState =
    family === "pid-providers" ? field("responsibleMemberState") : undefined;
  if (
    family === "pid-providers" &&
    !/^[A-Z]{2}$/.test(responsibleMemberState ?? "")
  )
    addError(
      "responsibleMemberState",
      "Responsible Member State must be a 2-letter ISO code.",
    );
  if (errors.length > 0)
    return { valid: false, errors, applicantData: null, preservedFields };
  const common: WalletProviderApplicantData = {
    entityName,
    entityTradeName: entityTradeName || undefined,
    entityStreetAddress,
    entityLocality: entityLocality || undefined,
    entityPostalCode: entityPostalCode || undefined,
    entityCountry,
    entityInformationURI,
    services,
  };
  return family === "pid-providers"
    ? {
        valid: true,
        errors: [],
        applicantData: {
          ...common,
          responsibleMemberState: responsibleMemberState ?? "",
        },
        preservedFields,
      }
    : { valid: true, errors: [], applicantData: common, preservedFields };
}

export function parseAndValidateSubmission(
  fields: SubmissionFields,
  targetListKey: string,
  family?: "wallet-providers",
): WalletSubmissionSuccess | SubmissionFailure;
export function parseAndValidateSubmission(
  fields: SubmissionFields,
  targetListKey: string,
  family: "pid-providers",
): PIDSubmissionSuccess | SubmissionFailure;
export function parseAndValidateSubmission(
  fields: SubmissionFields,
  targetListKey: string,
  family: EnabledProfileFamily,
): SubmissionParseResult;
export function parseAndValidateSubmission(
  fields: SubmissionFields,
  targetListKey: string,
  family: EnabledProfileFamily = "wallet-providers",
): SubmissionParseResult {
  return family === "pid-providers"
    ? parseForFamily(fields, targetListKey, family)
    : parseForFamily(fields, targetListKey, family);
}

export function createApplicationRecord(
  id: string,
  targetListKey: string,
  applicantData: WalletProviderApplicantData,
  family?: "wallet-providers",
): WalletProviderApplication;
export function createApplicationRecord(
  id: string,
  targetListKey: string,
  applicantData: PIDProviderApplicantData,
  family: "pid-providers",
): PIDProviderApplication;
export function createApplicationRecord(
  id: string,
  targetListKey: string,
  applicantData: WalletProviderApplicantData | PIDProviderApplicantData,
  family: EnabledProfileFamily = "wallet-providers",
): WalletProviderApplication | PIDProviderApplication {
  getEnabledProfile(family);
  const submittedAt = new Date().toISOString();
  if (family === "pid-providers") {
    if (!("responsibleMemberState" in applicantData))
      throw new Error(
        "PID Provider applications require responsibleMemberState.",
      );
    return {
      id,
      schemaVersion: APPLICATION_SCHEMA_VERSION,
      family,
      targetListKey,
      state: "submitted",
      submittedAt,
      applicantData,
    };
  }
  return {
    id,
    schemaVersion: APPLICATION_SCHEMA_VERSION,
    family,
    targetListKey,
    state: "submitted",
    submittedAt,
    applicantData,
  };
}
