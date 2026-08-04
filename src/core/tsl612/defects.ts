/**
 * Intentionally broken TS 119 612 Trusted List generation.
 *
 * The XML half of the canonical defect catalogue in `src/core/defects`. What a
 * defect *means* is declared there; this module knows how to perform it on a
 * `TrustServiceStatusList`.
 *
 * Mutations are textual, not tree rewrites. The compiler emits one element per
 * line with a fixed two-space indent, so a line-oriented edit is exact,
 * reviewable and reproducible — and, more importantly, it can produce documents
 * a DOM writer would refuse to serialize, which is the entire point: a fixture
 * has to be able to publish a missing mandatory element or a wrong namespace.
 *
 * Every mutation records whether it actually changed anything. A mutation that
 * silently found nothing to alter would publish a healthy list under a broken
 * name, which is the one outcome a negative fixture must never have.
 */
import { X509Certificate } from "node:crypto";
import { mintCertificate } from "../authoring/defects.js";
import {
  defectsAtStageFor,
  defectsForStandard,
  type DefectSpec,
  type DefectStage,
} from "../defects/registry.js";
import type { AppliedMutation } from "../defects/fixture-metadata.js";
import {
  NS_TSL,
  SVCSTATUS_DEPRECATED_AT_NATIONAL_LEVEL,
  SVCSTATUS_GRANTED,
  SVCSTATUS_RECOGNISED_AT_NATIONAL_LEVEL,
  SVCSTATUS_WITHDRAWN,
} from "./constants.js";
import { getTslProfile, type TslFamily } from "./registry.js";
import type { TslProvider, TslService } from "./model.js";
import { certificateDerBase64, toUtcDateTime } from "../model/lexical.js";
import { subjectKeyIdentifierBase64 } from "../model/x509-ski.js";

const STANDARD = "TS 119 612" as const;

/** Every defect this engine can perform, in catalogue order. */
export function xmlDefects(): readonly DefectSpec[] {
  return defectsForStandard(STANDARD);
}

export function isKnownXmlDefect(id: string): boolean {
  return xmlDefects().some((spec) => spec.id === id);
}

/**
 * A wrong-but-real service type. Inventing a URI would test a reader's
 * tolerance of nonsense; a genuine TS 119 612 type that is simply not this
 * family's is the defect an implementation actually has to catch.
 */
const SVCTYPE_CA_QC = "http://uri.etsi.org/TrstSvc/Svctype/CA/QC";

const NS_TSL_INVALID = "http://uri.etsi.org/02231/v2-invalid#";

export interface XmlDefectContext {
  readonly families: readonly TslFamily[];
  readonly schemeTerritory: string;
  readonly schemeOperatorName: string;
}

export interface XmlMutationOutcome {
  readonly xml: string;
  readonly mutations: AppliedMutation[];
}

/** Records one mutation, so an unapplied one is visible rather than assumed. */
class MutationLog {
  readonly entries: AppliedMutation[] = [];

  constructor(private readonly stage: DefectStage) {}

  record(defectId: string, applied: boolean, detail: string): void {
    this.entries.push({ defectId, stage: this.stage, applied, detail });
  }
}

/**
 * The `TrustServiceProviderList` subtree, or null when the list is empty.
 * Several mutations must touch service certificates without touching the LOTL
 * pointer's certificates, which sit in SchemeInformation.
 */
function providerListRange(xml: string): { start: number; end: number } | null {
  const start = xml.indexOf("<TrustServiceProviderList>");
  if (start === -1) return null;
  const closing = "</TrustServiceProviderList>";
  const end = xml.indexOf(closing, start);
  if (end === -1) return null;
  return { start, end: end + closing.length };
}

/** Applies `edit` to the provider-list subtree alone. */
function withinProviderList(
  xml: string,
  edit: (subtree: string) => string,
): { xml: string; changed: boolean } {
  const range = providerListRange(xml);
  if (!range) return { xml, changed: false };
  const subtree = xml.slice(range.start, range.end);
  const edited = edit(subtree);
  return {
    xml: xml.slice(0, range.start) + edited + xml.slice(range.end),
    changed: edited !== subtree,
  };
}

/** Removes an element and its children, matched on the indented open tag. */
function removeElement(
  xml: string,
  name: string,
): { xml: string; changed: boolean } {
  const pattern = new RegExp(
    `^[ \\t]*<${name}(?:\\s[^>]*)?>[\\s\\S]*?</${name}>\\n`,
    "m",
  );
  const replaced = xml.replace(pattern, "");
  return { xml: replaced, changed: replaced !== xml };
}

function replaceLeafText(
  xml: string,
  name: string,
  next: (current: string) => string,
): { xml: string; changed: boolean } {
  const pattern = new RegExp(`(<${name}(?:\\s[^>]*)?>)([^<]*)(</${name}>)`);
  const match = pattern.exec(xml);
  if (!match) return { xml, changed: false };
  const replacement = `${match[1]}${next(match[2] ?? "")}${match[3]}`;
  return {
    xml:
      xml.slice(0, match.index) +
      replacement +
      xml.slice(match.index + match[0].length),
    changed: true,
  };
}

function readLeafText(xml: string, name: string): string | null {
  const match = new RegExp(`<${name}(?:\\s[^>]*)?>([^<]*)</${name}>`).exec(xml);
  return match ? (match[1] ?? null) : null;
}

/** `instant` shifted by whole days, in the strict UTC form the standard wants. */
function shiftDays(utcDateTime: string, days: number): string {
  const shifted = new Date(utcDateTime);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return toUtcDateTime(shifted);
}

/** Wraps strict Base64 DER back into PEM armour at 64 characters per line. */
function toPem(base64Der: string): string {
  const body = base64Der.replace(/\s+/g, "").match(/.{1,64}/g) ?? [];
  return [
    "-----BEGIN CERTIFICATE-----",
    ...body,
    "-----END CERTIFICATE-----",
  ].join("\n");
}

/**
 * Applies every selected pre-signing mutation to the compiled healthy XML.
 *
 * The healthy document is compiled first and never rebuilt, so a broken fixture
 * is always a stated delta from a known-good baseline rather than a separately
 * assembled document.
 */
export function applyXmlPreSignDefects(
  healthyXml: string,
  defectIds: readonly string[],
  context: XmlDefectContext,
): XmlMutationOutcome {
  const log = new MutationLog("pre-sign");
  let xml = healthyXml;

  for (const spec of defectsAtStageFor(defectIds, STANDARD, "pre-sign")) {
    switch (spec.id) {
      case "non_strict_timestamps": {
        const issue = replaceLeafText(xml, "ListIssueDateTime", (value) =>
          value.replace(/Z$/, ".000Z"),
        );
        xml = issue.xml;
        const next = replaceLeafText(xml, "dateTime", (value) =>
          value.replace(/Z$/, ".000Z"),
        );
        xml = next.xml;
        log.record(
          spec.id,
          issue.changed || next.changed,
          issue.changed || next.changed
            ? `ListIssueDateTime and NextUpdate now carry a ".000" fraction.`
            : "Neither timestamp was in the expected lexical form.",
        );
        break;
      }
      case "scheme_name_without_territory": {
        const prefix = `${context.schemeTerritory}:`;
        /* The first <Name> after <SchemeName> is the scheme's own name; the
           pointer's SchemeOperatorName names are further down the document. */
        const pattern = new RegExp(
          `(<SchemeName>\\s*<Name xml:lang="[^"]*">)${prefix}`,
        );
        const replaced = xml.replace(pattern, "$1");
        const changed = replaced !== xml;
        xml = replaced;
        log.record(
          spec.id,
          changed,
          changed
            ? `Stripped the "${prefix}" territory prefix from SchemeName.`
            : "SchemeName carried no territory prefix to strip.",
        );
        break;
      }
      case "missing_scheme_information_uri": {
        const removed = removeElement(xml, "SchemeInformationURI");
        xml = removed.xml;
        log.record(
          spec.id,
          removed.changed,
          removed.changed
            ? "Removed the mandatory SchemeInformationURI element."
            : "No SchemeInformationURI was present.",
        );
        break;
      }
      case "missing_policy_or_legal_notice": {
        const removed = removeElement(xml, "PolicyOrLegalNotice");
        xml = removed.xml;
        log.record(
          spec.id,
          removed.changed,
          removed.changed
            ? "Removed PolicyOrLegalNotice."
            : "No PolicyOrLegalNotice was present.",
        );
        break;
      }
      case "missing_operator_email": {
        /* Only the scheme operator's own address; the providers' addresses are
           inside TrustServiceProviderList and are not this defect. */
        const scheme = xml.indexOf("<SchemeOperatorAddress>");
        const schemeEnd = xml.indexOf("</SchemeOperatorAddress>", scheme);
        let changed = false;
        if (scheme !== -1 && schemeEnd !== -1) {
          const block = xml.slice(scheme, schemeEnd);
          const stripped = block.replace(
            /^[ \t]*<URI xml:lang="[^"]*">mailto:[^<]*<\/URI>\n/m,
            "",
          );
          changed = stripped !== block;
          xml = xml.slice(0, scheme) + stripped + xml.slice(schemeEnd);
        }
        log.record(
          spec.id,
          changed,
          changed
            ? "Removed the scheme operator's mailto: URI."
            : "The scheme operator published no mailto: URI.",
        );
        break;
      }
      case "missing_self_pointer": {
        const removed = removeElement(xml, "PointersToOtherTSL");
        xml = removed.xml;
        log.record(
          spec.id,
          removed.changed,
          removed.changed
            ? "Removed PointersToOtherTSL, so the list no longer points at the EU LOTL."
            : "The list carried no PointersToOtherTSL.",
        );
        break;
      }
      case "pem_service_certificate": {
        let rewritten = 0;
        const outcome = withinProviderList(xml, (subtree) =>
          subtree.replace(
            /(<X509Certificate>)([^<]+)(<\/X509Certificate>)/g,
            (_match, open: string, value: string, close: string) => {
              rewritten += 1;
              return `${open}${toPem(value)}${close}`;
            },
          ),
        );
        xml = outcome.xml;
        log.record(
          spec.id,
          rewritten > 0,
          rewritten > 0
            ? `Re-armoured ${rewritten} service certificate(s) as PEM.`
            : "The list carries no service certificate to re-armour.",
        );
        break;
      }
      case "extension_without_criticality": {
        let injected = 0;
        const outcome = withinProviderList(xml, (subtree) =>
          subtree.replace(
            /^([ \t]*)<\/ServiceInformation>\n/gm,
            (_match, indent: string) => {
              injected += 1;
              const inner = `${indent}  `;
              return (
                `${inner}<ServiceInformationExtensions>\n` +
                `${inner}  <Extension>\n` +
                `${inner}    <tslx:MimeType>application/vnd.etsi.tsl+xml</tslx:MimeType>\n` +
                `${inner}  </Extension>\n` +
                `${inner}</ServiceInformationExtensions>\n` +
                `${indent}</ServiceInformation>\n`
              );
            },
          ),
        );
        xml = outcome.xml;
        log.record(
          spec.id,
          injected > 0,
          injected > 0
            ? `Injected ${injected} Extension(s) with no Critical attribute.`
            : "The list carries no service to attach an extension to.",
        );
        break;
      }
      case "invalid_tsl_namespace": {
        const replaced = xml.replace(
          `xmlns="${NS_TSL}"`,
          `xmlns="${NS_TSL_INVALID}"`,
        );
        const changed = replaced !== xml;
        xml = replaced;
        log.record(
          spec.id,
          changed,
          changed
            ? `Root namespace replaced with ${NS_TSL_INVALID}.`
            : "The root did not declare the TS 119 612 namespace.",
        );
        break;
      }
      case "invalid_tsl_version_identifier": {
        const replaced = replaceLeafText(
          xml,
          "TSLVersionIdentifier",
          () => "5",
        );
        xml = replaced.xml;
        log.record(
          spec.id,
          replaced.changed,
          replaced.changed
            ? "TSLVersionIdentifier published as 5 instead of 6."
            : "No TSLVersionIdentifier was present.",
        );
        break;
      }
      case "expired_next_update": {
        const issue = readLeafText(xml, "ListIssueDateTime");
        if (!issue) {
          log.record(spec.id, false, "No ListIssueDateTime to work back from.");
          break;
        }
        const expired = shiftDays(issue, -1);
        const replaced = replaceLeafText(xml, "dateTime", () => expired);
        xml = replaced.xml;
        log.record(
          spec.id,
          replaced.changed,
          replaced.changed
            ? `NextUpdate set to ${expired}, one day before the issue time.`
            : "No NextUpdate to expire.",
        );
        break;
      }
      case "incorrect_service_type": {
        const serviceTypes = context.families.map(
          (family) => getTslProfile(family).serviceTypeIdentifier,
        );
        const outcome = withinProviderList(xml, (subtree) => {
          let edited = subtree;
          for (const serviceType of serviceTypes)
            edited = edited
              .split(
                `<ServiceTypeIdentifier>${serviceType}</ServiceTypeIdentifier>`,
              )
              .join(
                `<ServiceTypeIdentifier>${SVCTYPE_CA_QC}</ServiceTypeIdentifier>`,
              );
          return edited;
        });
        xml = outcome.xml;
        log.record(
          spec.id,
          outcome.changed,
          outcome.changed
            ? `Service types for ${context.families.join(", ")} republished as ${SVCTYPE_CA_QC}.`
            : "No service carried an accepted profile's service type.",
        );
        break;
      }
      case "incorrect_service_status": {
        /* Replace through placeholders so dual-profile mappings cannot undo
           each other (EAA and QEAA deliberately swap the same vocabularies). */
        const wrong = context.families.flatMap(wrongStatusesFor);
        const outcome = withinProviderList(xml, (subtree) => {
          let edited = subtree;
          const replacements = wrong.map(([correct, incorrect], index) => ({
            correct,
            incorrect,
            placeholder: `urn:tlp:fixture:status:${index}`,
          }));
          for (const replacement of replacements)
            edited = edited
              .split(replacement.correct)
              .join(replacement.placeholder);
          for (const replacement of replacements)
            edited = edited
              .split(replacement.placeholder)
              .join(replacement.incorrect);
          return edited;
        });
        xml = outcome.xml;
        log.record(
          spec.id,
          outcome.changed,
          outcome.changed
            ? `Service statuses swapped for ${context.families.join(", ")}.`
            : "No service carried an accepted profile's status.",
        );
        break;
      }
      case "invalid_service_history": {
        let moved = 0;
        const outcome = withinProviderList(xml, (subtree) =>
          subtree.replace(
            /<ServiceHistoryInstance>[\s\S]*?<\/ServiceHistoryInstance>/g,
            (instance) => {
              const current = readLeafText(instance, "StatusStartingTime");
              if (!current) return instance;
              moved += 1;
              return instance.replace(
                /(<StatusStartingTime>)[^<]*(<\/StatusStartingTime>)/,
                `$1${shiftDays(current, 2)}$2`,
              );
            },
          ),
        );
        xml = outcome.xml;
        log.record(
          spec.id,
          moved > 0,
          moved > 0
            ? `Moved ${moved} history status time(s) after the current state.`
            : "The list carries no ServiceHistoryInstance to disorder.",
        );
        break;
      }
      default:
        log.record(
          spec.id,
          false,
          "No pre-signing XML mutation is defined for this defect.",
        );
    }
  }

  return { xml, mutations: log.entries };
}

/** The other family's status vocabulary, paired with this family's. */
function wrongStatusesFor(family: TslFamily): ReadonlyArray<[string, string]> {
  return family === "qeaa-providers"
    ? [
        [SVCSTATUS_GRANTED, SVCSTATUS_RECOGNISED_AT_NATIONAL_LEVEL],
        [SVCSTATUS_WITHDRAWN, SVCSTATUS_DEPRECATED_AT_NATIONAL_LEVEL],
      ]
    : [
        [SVCSTATUS_RECOGNISED_AT_NATIONAL_LEVEL, SVCSTATUS_GRANTED],
        [SVCSTATUS_DEPRECATED_AT_NATIONAL_LEVEL, SVCSTATUS_WITHDRAWN],
      ];
}

/**
 * How the selected defects change *how* the list is signed.
 *
 * Two of the three signature defects substitute the signing material rather
 * than editing the signed bytes: a hand-edited signature fails cryptographic
 * verification first, which would mask "the signer is wrong" behind "the
 * signature is broken". Only `broken_xades_signature` edits after signing, and
 * that is exactly what it is for.
 */
export interface XmlSigningPlan {
  readonly privateKeyPem: string;
  readonly certificatePem: string;
  readonly omitSigningTime: boolean;
  readonly mutations: AppliedMutation[];
}

export function planXmlSigning(
  defectIds: readonly string[],
  healthy: { privateKeyPem: string; certificatePem: string },
  context: XmlDefectContext,
): XmlSigningPlan {
  const log = new MutationLog("post-sign");
  let privateKeyPem = healthy.privateKeyPem;
  let certificatePem = healthy.certificatePem;
  let omitSigningTime = false;
  const signingDefects = defectsAtStageFor(defectIds, STANDARD, "post-sign");
  const wantsSubjectMismatch = signingDefects.some(
    (spec) => spec.id === "signer_organisation_mismatch",
  );
  const wantsIncorrectProfile = signingDefects.some(
    (spec) => spec.id === "incorrect_signing_certificate",
  );
  const substitute =
    wantsSubjectMismatch || wantsIncorrectProfile
      ? mintCertificate({
          commonName: "Intentionally Broken Trusted List Signer",
          organisation: wantsSubjectMismatch
            ? `Not ${context.schemeOperatorName}`.slice(0, 64)
            : context.schemeOperatorName,
          country: wantsSubjectMismatch
            ? context.schemeTerritory === "IT"
              ? "DE"
              : "IT"
            : context.schemeTerritory,
          ...(wantsIncorrectProfile
            ? { certificateAuthority: true }
            : { trustedListProfile: true }),
        })
      : null;

  if (substitute) {
    privateKeyPem = substitute.privateKeyPem;
    certificatePem = substitute.certificatePem;
  }

  for (const spec of signingDefects) {
    switch (spec.id) {
      case "signer_organisation_mismatch": {
        if (substitute) {
          log.record(
            spec.id,
            true,
            `Re-signed with one certificate whose subject O is "Not ${context.schemeOperatorName}" and whose country differs from ${context.schemeTerritory}.`,
          );
        } else {
          log.record(
            spec.id,
            false,
            "openssl is unavailable, so no substitute signer could be minted; the healthy signer was kept.",
          );
        }
        break;
      }
      case "incorrect_signing_certificate": {
        if (substitute) {
          log.record(
            spec.id,
            true,
            "The substitute signer is a CA certificate: basicConstraints CA:TRUE, keyUsage keyCertSign and cRLSign.",
          );
        } else {
          log.record(
            spec.id,
            false,
            "openssl is unavailable, so no CA certificate could be minted; the healthy signer was kept.",
          );
        }
        break;
      }
      case "xades_without_signing_time": {
        omitSigningTime = true;
        log.record(
          spec.id,
          true,
          "Signed with no xades:SigningTime in SignedProperties.",
        );
        break;
      }
      case "broken_xades_signature":
        /* Applied to the signed bytes by applyXmlPostSignDefects, not here. */
        break;
      default:
        log.record(
          spec.id,
          false,
          "No signing-stage XML mutation is defined for this defect.",
        );
    }
  }

  return {
    privateKeyPem,
    certificatePem,
    omitSigningTime,
    mutations: log.entries,
  };
}

/**
 * Mutations applied to the signed bytes.
 *
 * This is the only place a fixture edits a document after it was signed, and
 * the result is meant to fail cryptographic verification.
 */
export function applyXmlPostSignDefects(
  signedXml: string,
  defectIds: readonly string[],
): XmlMutationOutcome {
  const log = new MutationLog("post-sign");
  let xml = signedXml;

  for (const spec of defectsAtStageFor(defectIds, STANDARD, "post-sign")) {
    if (spec.id !== "broken_xades_signature") continue;
    const replaced = xml.replace(
      /(<SchemeName>\s*<Name xml:lang="[^"]*">)([^<]*)(<\/Name>)/,
      (_match, open: string, value: string, close: string) =>
        `${open}${value} (tampered after signing)${close}`,
    );
    const changed = replaced !== xml;
    xml = replaced;
    log.record(
      spec.id,
      changed,
      changed
        ? "Edited the signed SchemeName text, so the document reference digest no longer matches."
        : "No SchemeName was present to tamper with.",
    );
  }

  return { xml, mutations: log.entries };
}

/**
 * The `.sha2` sidecar to publish.
 *
 * Returns the honest digest unless the digest defect was selected, in which
 * case the final hex digit is rotated: still a well-formed SHA-256, and
 * verifiably not the digest of the bytes it sits beside.
 */
export function planSha2Digest(
  honestDigest: string,
  defectIds: readonly string[],
): { digest: string; mutations: AppliedMutation[] } {
  const log = new MutationLog("publication");
  let digest = honestDigest;
  for (const spec of defectsAtStageFor(defectIds, STANDARD, "publication")) {
    if (spec.id !== "incorrect_sha2_digest") {
      log.record(
        spec.id,
        false,
        "No publication-stage XML mutation is defined for this defect.",
      );
      continue;
    }
    const last = honestDigest.slice(-1);
    const rotated = "0123456789abcdef".charAt((parseInt(last, 16) + 1) % 16);
    digest = honestDigest.slice(0, -1) + rotated;
    log.record(
      spec.id,
      digest !== honestDigest,
      `Published ${digest} beside an artifact whose digest is ${honestDigest}.`,
    );
  }
  return { digest, mutations: log.entries };
}

/**
 * The provider a fixture list carries.
 *
 * Several defects mutate service structures, and a newly created Trusted List
 * has no provider at all. Without a seed those fixtures would publish an
 * unchanged document and trip nothing. The seed carries one service that is
 * already in its second state, so `invalid_service_history` has a history
 * instance to disorder — and the healthy baseline carries exactly the same
 * provider, which is what makes every single-defect fixture a delta of one
 * mutation from it.
 */
export const FIXTURE_PROVIDER_NAME = "Broken Fixture Provider";

export interface FixtureProviderOptions {
  readonly family: TslFamily;
  readonly providerName?: string;
  readonly territory: string;
  /** PEM of the list signing certificate, used when openssl cannot mint one. */
  readonly fallbackCertificatePem: string;
  /** The publication instant; the current status starts here. */
  readonly publishedAt: Date;
}

export function fixtureSeedProvider(
  options: FixtureProviderOptions,
): TslProvider {
  const profile = getTslProfile(options.family);
  const providerName = options.providerName ?? FIXTURE_PROVIDER_NAME;
  const minted = mintCertificate({
    commonName: `${providerName} Service`,
    organisation: providerName,
    country: options.territory,
  });
  const certificatePem =
    minted?.certificatePem ?? options.fallbackCertificatePem;
  const certificateBase64Der = certificateDerBase64(certificatePem);
  const ski = subjectKeyIdentifierBase64(certificatePem);

  /*
    The seeded service has already completed one lifecycle step: it is in its
    end state, with the state it started in recorded in ServiceHistory. That is
    the smallest arrangement that carries a *real* status transition — a history
    instance repeating the current status is not a transition, and the Inspector
    says so. It is also what gives `invalid_service_history` an ordering to
    break, and it exercises the family's whole status vocabulary in one fixture.

    The superseded state starts a day before the current one, because history
    must be strictly earlier than the state that replaced it.
  */
  const currentStart = toUtcDateTime(options.publishedAt);
  const historyStart = shiftDays(currentStart, -1);

  const service: TslService = {
    serviceTypeIdentifier: profile.serviceTypeIdentifier,
    serviceName: `${providerName} Issuance`,
    digitalIdentity: { x509CertificateBase64Der: certificateBase64Der },
    serviceStatus: profile.endStatus,
    statusStartingTime: currentStart,
    serviceHistory: [
      {
        serviceTypeIdentifier: profile.serviceTypeIdentifier,
        serviceName: `${providerName} Issuance`,
        digitalIdentity: { x509SkiBase64: ski },
        serviceStatus: profile.initialStatus,
        statusStartingTime: historyStart,
      },
    ],
  };

  const home = `https://fixture-provider.example/${options.family}`;
  return {
    tspName: providerName,
    tspTradeNames: [`NTR${options.territory}-FIXTURE-0001`],
    tspAddress: {
      streetAddress: "1 Fixture Street",
      locality: "Brussels",
      postalCode: "1000",
      countryName: options.territory,
    },
    tspElectronicAddress: {
      email: "fixture@fixture-provider.example",
      website: home,
    },
    tspInformationUri: home,
    services: [service],
  };
}

/** Certificate subject of the signer actually used, for the manifest. */
export function signerSubject(certificatePem: string): string {
  return new X509Certificate(certificatePem).subject.replace(/\n/g, ", ");
}
