import {
  APPLICATION_SCHEMA_VERSION,
  type ApplicantDataByFamily,
  type ApplicationByFamily,
  type ProviderServiceInput,
  type SupervisedApplicantData,
  type WalletProviderApplicantData,
  type WalletRelyingPartyApplicantData,
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
export interface SubmissionSuccess<F extends EnabledProfileFamily> {
  valid: true;
  errors: [];
  applicantData: ApplicantDataByFamily[F];
  preservedFields: SubmissionFields;
}
export type WalletSubmissionSuccess = SubmissionSuccess<"wallet-providers">;
export type PIDSubmissionSuccess = SubmissionSuccess<"pid-providers">;
export type SubmissionParseResult =
  SubmissionFailure | SubmissionSuccess<EnabledProfileFamily>;

/**
 * Families whose applicant declares the Member State responsible for it. For
 * PID Providers that Member State supervises the provider; for WRPAC and WRPRC
 * Providers it is the Member State whose mandate the provider currently holds.
 */
const SUPERVISED_FAMILIES: readonly EnabledProfileFamily[] = [
  "pid-providers",
  "wrpac-providers",
  "wrprc-providers",
];

/**
 * Annex F/G collect the provider's policies and terms URL, its optional
 * official registration identifier and an optional further information page,
 * in place of the single information URI Annex D/E collect.
 */
const WALLET_RELYING_PARTY_FAMILIES: readonly EnabledProfileFamily[] = [
  "wrpac-providers",
  "wrprc-providers",
];

function isUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Parses and validates one posted onboarding form. The family decides which
 * fields exist: anything else in the body is reported as an unknown field
 * rather than ignored, so a form and a parser that have drifted apart are
 * visible immediately.
 */
export function parseAndValidateSubmission<
  F extends EnabledProfileFamily = "wallet-providers",
>(
  fields: SubmissionFields,
  targetListKey: string,
  family?: F,
): SubmissionSuccess<F> | SubmissionFailure {
  const resolved = (family ?? "wallet-providers") as EnabledProfileFamily;
  const profile = getEnabledProfile(resolved);
  const supervised = SUPERVISED_FAMILIES.includes(resolved);
  const relyingParty = WALLET_RELYING_PARTY_FAMILIES.includes(resolved);

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
    "entityEmail",
    "entityTelephone",
    ...(supervised ? ["responsibleMemberState"] : []),
    ...(relyingParty
      ? [
          "registrationIdentifier",
          "entityPolicyURI",
          "additionalInformationURI",
        ]
      : ["entityInformationURI"]),
  ]);
  const serviceSubfields = [
    "serviceType",
    "serviceName",
    "certificatePem",
    ...(profile.requiresServiceUniqueIdentifier
      ? ["serviceUniqueIdentifier"]
      : []),
  ];
  const serviceField = new RegExp(
    `^service\\[(\\d+)\\]\\.(${serviceSubfields.join("|")})$`,
  );

  const addError = (field: string, message: string): void => {
    errors.push({ field, message });
  };
  const field = (name: string): string => {
    const value = (fields[name] ?? "").trim();
    preservedFields[name] = value;
    return value;
  };
  for (const key of Object.keys(fields))
    if (!allowed.has(key) && !serviceField.test(key))
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

  /*
    One field carries the entity's public HTTP(S) URI in every family. Annex D/E
    call it the information URI; Annex F/G collect the policies and terms URL,
    which the published list uses in the same place.
  */
  const informationFieldName = relyingParty
    ? "entityPolicyURI"
    : "entityInformationURI";
  const entityInformationURI = field(informationFieldName);
  if (!entityInformationURI)
    addError(
      informationFieldName,
      relyingParty
        ? "Policies and terms URL is required."
        : "Information URI is required.",
    );
  else if (!isUrl(entityInformationURI))
    addError(
      informationFieldName,
      relyingParty
        ? "Policies and terms URL must be a valid URL."
        : "Information URI must be a valid URL.",
    );

  const registrationIdentifier = relyingParty
    ? field("registrationIdentifier")
    : "";
  const additionalInformationURI = relyingParty
    ? field("additionalInformationURI")
    : "";
  if (additionalInformationURI && !isUrl(additionalInformationURI))
    addError(
      "additionalInformationURI",
      "Additional information URL must be a valid URL.",
    );

  /*
    Annex D/E/F/G require a contactable entity: the published list carries the
    email as a mailto URI and the telephone number as a tel URI.
  */
  const entityEmail = field("entityEmail");
  if (!entityEmail) addError("entityEmail", "Email address is required.");
  else if (!/^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(entityEmail))
    addError("entityEmail", "Email address must be a valid address.");
  const entityTelephone = field("entityTelephone");
  if (!entityTelephone)
    addError("entityTelephone", "Telephone number is required.");
  else if (!/^\+?[0-9][0-9\s()-]{5,}$/.test(entityTelephone))
    addError(
      "entityTelephone",
      "Telephone number must be in international form, e.g. +39 02 1234567.",
    );

  const serviceIndices = new Set<number>();
  for (const key of Object.keys(fields)) {
    const match = serviceField.exec(key);
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
    let serviceUniqueIdentifier: string | undefined;
    if (profile.requiresServiceUniqueIdentifier) {
      serviceUniqueIdentifier = field(`${prefix}serviceUniqueIdentifier`);
      if (!serviceUniqueIdentifier)
        addError(
          `${prefix}serviceUniqueIdentifier`,
          "Service unique identifier is required.",
        );
      else if (!isUrl(serviceUniqueIdentifier))
        addError(
          `${prefix}serviceUniqueIdentifier`,
          "Service unique identifier must be a valid URL/URI.",
        );
    }
    if (
      (serviceType === "issuance" || serviceType === "revocation") &&
      serviceName &&
      certificatePem &&
      (!profile.requiresServiceUniqueIdentifier || serviceUniqueIdentifier)
    )
      services.push({
        serviceType,
        serviceName,
        certificatePem,
        ...(profile.requiresServiceUniqueIdentifier
          ? { serviceUniqueIdentifier }
          : {}),
      });
  }

  const responsibleMemberState = supervised
    ? field("responsibleMemberState")
    : undefined;
  if (supervised && !/^[A-Z]{2}$/.test(responsibleMemberState ?? ""))
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
    entityEmail,
    entityTelephone,
    services,
  };
  if (relyingParty) {
    const relyingPartyData: WalletRelyingPartyApplicantData = {
      ...common,
      responsibleMemberState: responsibleMemberState ?? "",
      registrationIdentifier: registrationIdentifier || undefined,
      additionalInformationURI: additionalInformationURI || undefined,
    };
    return {
      valid: true,
      errors: [],
      applicantData: relyingPartyData as ApplicantDataByFamily[F],
      preservedFields,
    };
  }
  if (supervised) {
    const supervisedData: SupervisedApplicantData = {
      ...common,
      responsibleMemberState: responsibleMemberState ?? "",
    };
    return {
      valid: true,
      errors: [],
      applicantData: supervisedData as ApplicantDataByFamily[F],
      preservedFields,
    };
  }
  return {
    valid: true,
    errors: [],
    applicantData: common as ApplicantDataByFamily[F],
    preservedFields,
  };
}

export function createApplicationRecord<
  F extends EnabledProfileFamily = "wallet-providers",
>(
  id: string,
  targetListKey: string,
  applicantData: ApplicantDataByFamily[F],
  family?: F,
): ApplicationByFamily[F] {
  const resolved = (family ?? "wallet-providers") as EnabledProfileFamily;
  getEnabledProfile(resolved);
  if (
    SUPERVISED_FAMILIES.includes(resolved) &&
    !("responsibleMemberState" in applicantData)
  )
    throw new Error(`${resolved} applications require responsibleMemberState.`);
  return {
    id,
    schemaVersion: APPLICATION_SCHEMA_VERSION,
    family: resolved,
    targetListKey,
    state: "submitted",
    submittedAt: new Date().toISOString(),
    applicantData,
  } as ApplicationByFamily[F];
}
