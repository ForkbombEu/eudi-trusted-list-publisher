import {
  APPLICATION_SCHEMA_VERSION,
  type WalletProviderApplicantData,
  type WalletProviderApplication,
  type WalletProviderServiceInput,
} from "./application-model.js";

export interface SubmissionFieldError {
  field: string;
  message: string;
}

export interface SubmissionParseResult {
  valid: boolean;
  errors: SubmissionFieldError[];
  applicantData: WalletProviderApplicantData | null;
  preservedFields: Record<string, string>;
}

export function parseAndValidateSubmission(
  fields: Record<string, string>,
  targetListKey: string,
): SubmissionParseResult {
  const errors: SubmissionFieldError[] = [];
  const preserved: Record<string, string> = {};

  function addError(field: string, msg: string): void {
    errors.push({ field, message: msg });
  }

  function get(field: string): string {
    const val = (fields[field] ?? "").trim();
    preserved[field] = val;
    return val;
  }

  if (!targetListKey) {
    addError("targetListKey", "Target list key is required.");
  }

  const entityName = get("entityName");
  if (!entityName) {
    addError("entityName", "Entity name is required.");
  }

  const entityTradeName = get("entityTradeName");
  preserved["entityTradeName"] = fields["entityTradeName"] ?? "";

  const entityStreetAddress = get("entityStreetAddress");
  if (!entityStreetAddress) {
    addError("entityStreetAddress", "Street address is required.");
  }

  const entityLocality = get("entityLocality");
  preserved["entityLocality"] = fields["entityLocality"] ?? "";

  const entityPostalCode = get("entityPostalCode");
  preserved["entityPostalCode"] = fields["entityPostalCode"] ?? "";

  const entityCountry = get("entityCountry");
  if (!entityCountry) {
    addError("entityCountry", "Country is required.");
  } else if (!/^[A-Z]{2}$/.test(entityCountry)) {
    addError("entityCountry", "Country must be a 2-letter ISO code (e.g. IT).");
  }

  const entityInformationURI = get("entityInformationURI");
  if (!entityInformationURI) {
    addError("entityInformationURI", "Information URI is required.");
  } else {
    try {
      new URL(entityInformationURI);
    } catch {
      addError("entityInformationURI", "Information URI must be a valid URL.");
    }
  }

  const serviceFields = Object.keys(fields).filter((k) =>
    k.startsWith("service["),
  );
  const serviceIndices = new Set<number>();
  for (const kf of serviceFields) {
    const m = kf.match(/^service\[(\d+)\]\./);
    if (m) serviceIndices.add(parseInt(m[1]!, 10));
  }

  if (serviceIndices.size === 0) {
    addError("services", "At least one service is required.");
  }

  const services: WalletProviderServiceInput[] = [];
  for (const idx of Array.from(serviceIndices).sort((a, b) => a - b)) {
    const prefix = `service[${idx}].`;

    const svcType = get(`${prefix}serviceType`);
    if (!svcType) {
      addError(`${prefix}serviceType`, "Service type is required.");
    } else if (!["issuance", "revocation"].includes(svcType)) {
      addError(`${prefix}serviceType`, "Invalid service type.");
    }

    const svcName = get(`${prefix}serviceName`);
    if (!svcName) {
      addError(`${prefix}serviceName`, "Service name is required.");
    }

    const cert = get(`${prefix}certificatePem`);
    if (!cert) {
      addError(`${prefix}certificatePem`, "Certificate is required.");
    } else if (
      !cert.includes("-----BEGIN CERTIFICATE-----") ||
      !cert.includes("-----END CERTIFICATE-----")
    ) {
      addError(`${prefix}certificatePem`, "Certificate must be in PEM format.");
    }

    const svcId = get(`${prefix}serviceUniqueIdentifier`);
    if (!svcId) {
      addError(
        `${prefix}serviceUniqueIdentifier`,
        "Service unique identifier is required.",
      );
    } else {
      try {
        new URL(svcId);
      } catch {
        addError(
          `${prefix}serviceUniqueIdentifier`,
          "Service unique identifier must be a valid URL/URI.",
        );
      }
    }

    services.push({
      serviceType: svcType as "issuance" | "revocation",
      serviceName: svcName,
      certificatePem: cert,
      serviceUniqueIdentifier: svcId,
    });
  }

  if (errors.length > 0) {
    return {
      valid: false,
      errors,
      applicantData: null,
      preservedFields: preserved,
    };
  }

  const applicantData: WalletProviderApplicantData = {
    entityName,
    entityTradeName: entityTradeName || undefined,
    entityStreetAddress,
    entityLocality: entityLocality || undefined,
    entityPostalCode: entityPostalCode || undefined,
    entityCountry,
    entityInformationURI,
    services,
  };

  return { valid: true, errors: [], applicantData, preservedFields: preserved };
}

export function createApplicationRecord(
  id: string,
  targetListKey: string,
  applicantData: WalletProviderApplicantData,
): WalletProviderApplication {
  return {
    id,
    schemaVersion: APPLICATION_SCHEMA_VERSION,
    family: "wallet-providers",
    targetListKey,
    state: "submitted",
    submittedAt: new Date().toISOString(),
    applicantData,
  };
}
