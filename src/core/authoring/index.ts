// @ts-nocheck
export { LIST_FAMILIES, getEnabledFamilies, findFamily, } from "./list-family-catalogue.js";
export { APPLICATION_SCHEMA_VERSION, canTransition, normalizeToAuthoringInput, documentPlaceholder, } from "./application-model.js";
export { AuthoringStore, } from "./authoring-store.js";
export { loadSigningConfig, findSigningConfig, getWalletProviderConfigs, getFamilyConfigs, signingConfigDisplay, loadSigningKey, } from "./signing-config.js";
export { parseAndValidateSubmission, createApplicationRecord, } from "./submission-parser.js";
export { ApplicationService, } from "./application-service.js";
export { loadLatestPublication, convertLoTEToAuthoringEntities, checkServiceIdentifierUniqueness, assembleNextList, } from "./list-assembler.js";
export type { ApplicationState, WalletProviderServiceInput, WalletProviderApplicantData, WalletProviderApplication, PIDProviderApplicantData, PIDProviderApplication, TrustedEntityApplication, PublicationRecord } from "./application-model.js";
export type { SigningConfig, SigningConfigEntry, SigningConfigEntryDisplay } from "./signing-config.js";
export type AuthoringStoreConfig = { authoringDir: string };
export type ListFamily = import("../profiles/registry.js").ProfileFamily;
export type SubmissionFieldError = { field: string; message: string };
export type SubmissionParseResult = { valid: boolean; errors: SubmissionFieldError[]; applicantData: unknown; preservedFields: Record<string, string> };
export type ServiceResult<T> = { success: true; data: T; message?: string; warning?: string } | { success: false; error: string };
export type PublishApplicationResult = ServiceResult<import("./application-model.js").WalletProviderApplication> | PartialCommitResult;
export type PublishResult = { listKey: string; sequenceNumber: number; manifestSha256: string; compactJadesSha256: string; publicationTimestamp: string };
export type PartialCommitResult = { success: false; code: "PUBLICATION_COMMITTED_APPLICATION_STALE"; error: string; publication: PublishResult };
//# sourceMappingURL=index.js.map
