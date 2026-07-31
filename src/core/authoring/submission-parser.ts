import {
  APPLICATION_SCHEMA_VERSION,
  type ApplicantDataByFamily,
  type ApplicationByFamily,
  type ProviderServiceInput,
  type PubEAAProviderApplicantData,
  type SupervisedApplicantData,
  type WalletProviderApplicantData,
  type WalletRelyingPartyApplicantData,
} from "./application-model.js";
import {
  getEnabledProfile,
  type EnabledProfileFamily,
} from "../profiles/registry.js";
import {
  checkCertificateSetConsistency,
  checkCertificateSubjectOrganisation,
  checkRelyingPartyCaCertificate,
  classifyCertificateInput,
  splitPemCertificates,
} from "./certificate-input.js";
import { isLegalBasisReference } from "../model/lexical.js";
import { X509Certificate } from "node:crypto";

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
 * Providers it is the Member State whose mandate the provider currently holds;
 * for Pub-EAA Providers it is the Member State that notified it.
 */
const SUPERVISED_FAMILIES: readonly EnabledProfileFamily[] = [
  "pid-providers",
  "wrpac-providers",
  "wrprc-providers",
  "pub-eaa-providers",
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
  const pubEaa = resolved === "pub-eaa-providers";

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
    ...(profile.informationUriIsPolicyUrl
      ? ["entityPolicyURI"]
      : ["entityInformationURI"]),
    ...(profile.collectsRegistrationIdentifier
      ? ["registrationIdentifier"]
      : []),
    ...(profile.collectsAdditionalInformationUri
      ? ["additionalInformationURI"]
      : []),
    ...(profile.requiresLegalBasisReference ? ["legalBasisReference"] : []),
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
  const informationFieldName = profile.informationUriIsPolicyUrl
    ? "entityPolicyURI"
    : "entityInformationURI";
  const entityInformationURI = field(informationFieldName);
  if (!entityInformationURI)
    addError(
      informationFieldName,
      profile.informationUriIsPolicyUrl
        ? "Policies and terms URL is required."
        : "Information URI is required.",
    );
  else if (!isUrl(entityInformationURI))
    addError(
      informationFieldName,
      profile.informationUriIsPolicyUrl
        ? "Policies and terms URL must be a valid URL."
        : "Information URI must be a valid URL.",
    );

  const registrationIdentifier = profile.collectsRegistrationIdentifier
    ? field("registrationIdentifier")
    : "";
  const additionalInformationURI = profile.collectsAdditionalInformationUri
    ? field("additionalInformationURI")
    : "";
  if (additionalInformationURI && !isUrl(additionalInformationURI))
    addError(
      "additionalInformationURI",
      "Additional information URL must be a valid URL.",
    );

  /*
    Annex H requires the Union or national act the notification rests on. It is
    published as an `OJ:` URI, so the reference has to be expressible as one.
  */
  const legalBasisReference = profile.requiresLegalBasisReference
    ? field("legalBasisReference")
    : "";
  if (profile.requiresLegalBasisReference) {
    if (!legalBasisReference)
      addError("legalBasisReference", "Legal basis reference is required.");
    else if (!isLegalBasisReference(legalBasisReference))
      addError(
        "legalBasisReference",
        "Legal basis reference must start with EU for Union law or an EU Member State country code for national law, followed by the law identifier (for example EU32024R1183 or ITlegge-2024-12).",
      );
  }

  /*
    Annex D–H require a contactable entity: the published list carries the email
    as a mailto URI and the telephone number as a tel URI.
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
      A self-signed or CA-issued X.509 certificate in PEM form is accepted when
      it satisfies its profile; any other PEM or container content is named in
      the error message so the applicant knows which object they supplied. The
      subject organisation must be the Trusted Entity Name, because the service
      digital identity has to identify the entity the list vouches for. Annex
      F/G additionally require the current RFC 5280 CA certificate whose public
      key verifies the certificates issued by the WRPAC or WRPRC provider.

      Annex H makes the certificate optional and lets one service publish more
      than one — the attestation-signing certificate or the CA certificate that
      issued it — so each block is classified on its own and the set must then
      represent one key and one subject.
    */
    if (!certificatePem && profile.requiresServiceCertificate)
      addError(`${prefix}certificatePem`, "Certificate is required.");
    else if (certificatePem) {
      const blocks = splitPemCertificates(certificatePem);
      const parsed: X509Certificate[] = [];
      for (const block of blocks.length > 0 ? blocks : [certificatePem]) {
        const certificate = classifyCertificateInput(block);
        if (certificate.message !== null) {
          addError(`${prefix}certificatePem`, certificate.message);
          break;
        }
        if (certificate.certificate) parsed.push(certificate.certificate);
      }
      for (const certificate of parsed) {
        const mismatch = checkCertificateSubjectOrganisation(
          certificate,
          entityName,
        );
        if (mismatch) {
          addError(`${prefix}certificatePem`, mismatch);
          break;
        }
        if (resolved === "wrpac-providers" || resolved === "wrprc-providers") {
          const unusable = checkRelyingPartyCaCertificate(
            certificate,
            resolved === "wrpac-providers" ? "WRPAC" : "WRPRC",
          );
          if (unusable) {
            addError(`${prefix}certificatePem`, unusable);
            break;
          }
        }
      }
      const inconsistent = checkCertificateSetConsistency(parsed);
      if (inconsistent) addError(`${prefix}certificatePem`, inconsistent);
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
      (certificatePem || !profile.requiresServiceCertificate) &&
      (!profile.requiresServiceUniqueIdentifier || serviceUniqueIdentifier)
    )
      services.push({
        serviceType,
        serviceName,
        ...(certificatePem ? { certificatePem } : {}),
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
  if (pubEaa) {
    const pubEaaData: PubEAAProviderApplicantData = {
      ...common,
      responsibleMemberState: responsibleMemberState ?? "",
      registrationIdentifier: registrationIdentifier || undefined,
      legalBasisReference,
    };
    return {
      valid: true,
      errors: [],
      applicantData: pubEaaData as ApplicantDataByFamily[F],
      preservedFields,
    };
  }
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
