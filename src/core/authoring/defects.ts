/**
 * Intentionally broken Trusted List generation.
 *
 * These fixtures exist so EUDI wallet, issuer and verifier implementations can
 * register against a list that is *known* to violate a specific clause and
 * confirm their runtime detects it. A failing Trust Inspector verdict on one of
 * these lists is the deliverable, not an error.
 *
 * Each defect states the stage it applies at, a deterministic mutation, and the
 * Inspector rule IDs it is expected to trip. The expected IDs were taken from a
 * live Inspector evaluation of a real Pub-EAA artifact rather than guessed, but
 * they remain an *expectation*: the recorded fixture metadata always reports
 * expected against actual so a drifting rule set is visible rather than hidden.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as jose from "jose";
import type {
  LoTEDocument,
  OtherLoTEPointer,
  ServiceInformationExtensionsItem,
} from "../model/types.js";
import type { EnabledProfileFamily } from "../profiles/registry.js";
import {
  PUB_EAA_PROVIDER_ROLE_URI_PREFIX,
  PUB_EAA_SERVICE_TYPE_ISSUANCE,
  PUB_EAA_SVC_STATUS_NOTIFIED,
} from "../profiles/pub-eaa-provider/constants.js";

/** When a mutation is applied relative to signing. */
export type DefectStage = "pre-sign" | "post-sign";

export interface DefectSpec {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly stage: DefectStage;
  /**
   * Inspector rule IDs this defect is expected to fail. The first is the
   * primary rule; the rest are the cascading failures the same mutation
   * legitimately provokes.
   */
  readonly expectedRuleIds: readonly string[];
  /**
   * Families where the literal mutation would be a no-op and the defect is
   * realised differently. Documented per defect below.
   */
  readonly familyNote?: string;
  /** The clause the mutation violates, cited so a reader can look it up. */
  readonly normativeReference: string;
  /** What a conformant list does instead, in one sentence. */
  readonly conformantBehaviour: string;
}

/**
 * Annex H (Pub-EAA) sets `publishesSelfPointer: false`, so a healthy Pub-EAA
 * list already omits PointersToOtherLoTE and "omit the pointer" changes
 * nothing. For that family the defect is inverted: it *injects* a pointer the
 * annex prohibits. The runtime consequence a developer tests for is the same —
 * the list carries a pointer structure that must be rejected.
 */
const SELF_POINTER_ANNEX_H_NOTE =
  "Annex H forbids PointersToOtherLoTE, so for pub-eaa-providers this defect " +
  "injects a prohibited pointer instead of omitting a required one.";

export const DEFECT_SPECS: ReadonlyArray<DefectSpec> = Object.freeze([
  {
    id: "non_strict_timestamps",
    normativeReference:
      "ETSI TS 119 602 V1.1.1, clause 6.1.3 (date-time lexical form)",
    conformantBehaviour:
      "ListIssueDateTime and NextUpdate are written as YYYY-MM-DDThh:mm:ssZ, with whole seconds and no fractional part.",
    label: "Non-strict timestamps",
    description:
      "Emit ListIssueDateTime and NextUpdate with fractional seconds, violating the clause 6.1.3 lexical form.",
    stage: "pre-sign",
    expectedRuleIds: Object.freeze([
      "ts119602.syntax.date_time",
      "ts119602.scheme.issue_time",
      "ts119602.scheme.next_update",
      "json_lote.dates.issue_valid",
      "json_lote.dates.next_update_valid",
    ]),
  },
  {
    id: "scheme_name_without_territory",
    normativeReference: "ETSI TS 119 602 V1.1.1, clause 6.3.6 (SchemeName)",
    conformantBehaviour:
      "Each SchemeName value is prefixed with the scheme territory and a colon, for example EU:My List.",
    label: "Scheme name without territory",
    description:
      "Emit SchemeName without the SchemeTerritory prefix required by clause 6.3.6.",
    stage: "pre-sign",
    expectedRuleIds: Object.freeze(["ts119602.scheme.name"]),
  },
  {
    id: "missing_scheme_information_uri",
    normativeReference:
      "ETSI TS 119 602 V1.1.1, clause 6.3.7 and Table 1 (presence matrix)",
    conformantBehaviour:
      "SchemeInformationURI is present and points at the scheme information the operator publishes.",
    label: "Missing scheme information URI",
    description:
      "Omit SchemeInformationURI, which the Table 1 presence matrix makes mandatory for explicit scheme information.",
    stage: "pre-sign",
    expectedRuleIds: Object.freeze([
      "ts119602.structure.scheme_information_presence",
      "ts119602.profile.pub_eaa_providers.scheme_information",
    ]),
  },
  {
    id: "missing_policy_or_legal_notice",
    normativeReference:
      "ETSI TS 119 602 V1.1.1, clause 6.3.11 (PolicyOrLegalNotice)",
    conformantBehaviour:
      "PolicyOrLegalNotice carries either a LoTEPolicy URI or a LoTELegalNotice, never both.",
    label: "Missing policy or legal notice",
    description: "Omit PolicyOrLegalNotice.",
    stage: "pre-sign",
    expectedRuleIds: Object.freeze([
      "ts119602.scheme.policy_or_legal_notice",
      "ts119602.structure.scheme_information_presence",
    ]),
  },
  {
    id: "missing_operator_email",
    normativeReference:
      "ETSI TS 119 602 V1.1.1, clause 6.3.4 (SchemeOperatorAddress)",
    conformantBehaviour:
      "The scheme operator's electronic address includes a mailto: URI alongside any website URI.",
    label: "Operator without email",
    description:
      "Publish only a website URI for the scheme operator, with no mailto URI.",
    stage: "pre-sign",
    expectedRuleIds: Object.freeze(["ts119602.scheme.operator_address"]),
  },
  {
    id: "missing_self_pointer",
    normativeReference:
      "ETSI TS 119 602 V1.1.1, clause 6.3.13 (PointersToOtherLoTE); Annex H for Pub-EAA",
    conformantBehaviour:
      "Annex D to G require the list to point at itself so a reader can confirm where it is published. Annex H requires PointersToOtherLoTE to be absent entirely.",
    label: "Missing self pointer",
    description:
      "Omit PointersToOtherLoTE, so the list does not point at itself.",
    stage: "pre-sign",
    expectedRuleIds: Object.freeze([
      "ts119602.profile.pub_eaa_providers.scheme_information",
    ]),
    familyNote: SELF_POINTER_ANNEX_H_NOTE,
  },
  {
    id: "pem_service_certificate",
    normativeReference:
      "ETSI TS 119 602 V1.1.1, clause 6.6.3 (ServiceDigitalIdentity)",
    conformantBehaviour:
      "A service certificate is published as Base64-encoded DER, with no PEM armour and no whitespace.",
    label: "PEM service certificate",
    description:
      "Publish the service certificate as PEM text instead of the Base64 DER required by clause 6.6.3.",
    stage: "pre-sign",
    expectedRuleIds: Object.freeze(["ts119602.service.digital_identity"]),
  },
  {
    id: "extension_without_criticality",
    normativeReference:
      "ETSI TS 119 602 V1.1.1, clause 6.6.9 (ServiceInformationExtensions)",
    conformantBehaviour:
      "Every extension container states its criticality, so a reader that does not understand it knows whether it may be ignored.",
    label: "Extension without criticality",
    description:
      "Emit ServiceInformationExtensions containers with no criticality flag.",
    stage: "pre-sign",
    expectedRuleIds: Object.freeze(["ts119602.service.extensions"]),
  },
  {
    id: "signer_organisation_mismatch",
    normativeReference:
      "ETSI TS 119 602 V1.1.1, Annex D to H signature requirements",
    conformantBehaviour:
      "The signing certificate's subject organisation equals the scheme operator name published in the list.",
    label: "Signer organisation mismatch",
    description:
      "Sign with a certificate whose subject organisation is not the scheme operator name.",
    stage: "post-sign",
    expectedRuleIds: Object.freeze([
      "json_lote.signature.jades_signer_subject.organization",
    ]),
  },
  {
    id: "jades_without_signing_time",
    normativeReference:
      "ETSI TS 119 182-1, clause 5.2.1 (JAdES Baseline B signing time)",
    conformantBehaviour:
      "The claimed signing time is carried in the iat protected header as an integer NumericDate.",
    label: "JAdES without signing time",
    description:
      "Omit the iat protected header, so the signature is not JAdES Baseline B.",
    stage: "post-sign",
    expectedRuleIds: Object.freeze([
      "json_lote.signature.jades_signing_time",
      "json_lote.signature.jades_baseline_b",
      "ts119602.profile.pub_eaa_providers.signature",
    ]),
  },
]);

const SPEC_BY_ID = new Map(DEFECT_SPECS.map((spec) => [spec.id, spec]));

export function defectSpec(id: string): DefectSpec | undefined {
  return SPEC_BY_ID.get(id);
}

export function defectsAtStage(
  ids: readonly string[],
  stage: DefectStage,
): DefectSpec[] {
  return ids
    .map((id) => SPEC_BY_ID.get(id))
    .filter(
      (spec): spec is DefectSpec => spec !== undefined && spec.stage === stage,
    );
}

/** Every rule ID the selected defects are expected to trip, deduplicated. */
export function expectedRuleIdsFor(ids: readonly string[]): string[] {
  const rules = new Set<string>();
  for (const id of ids)
    for (const rule of SPEC_BY_ID.get(id)?.expectedRuleIds ?? [])
      rules.add(rule);
  return [...rules].sort();
}

/** One applied mutation, recorded so the fixture can explain itself. */
export interface AppliedMutation {
  defectId: string;
  stage: DefectStage;
  /** False when the mutation found nothing to change; `detail` says why. */
  applied: boolean;
  detail: string;
}

export interface PreSignContext {
  family: EnabledProfileFamily;
  schemeTerritory: string;
  /** Where the list publishes itself, used by the injected Annex H pointer. */
  distributionPointUri: string;
  loTEType: string;
  schemeOperatorName: string;
  /** Base64 DER of the list's signing certificate. */
  signingCertificateDer: string;
}

const clone = (document: LoTEDocument): LoTEDocument =>
  JSON.parse(JSON.stringify(document)) as LoTEDocument;

/**
 * Applies every selected pre-sign mutation to a clone of the healthy document.
 * The healthy document is generated first and never modified in place, so a
 * broken fixture is always a deliberate delta from a known-good baseline.
 */
export function applyPreSignDefects(
  healthy: LoTEDocument,
  defectIds: readonly string[],
  context: PreSignContext,
): { document: LoTEDocument; mutations: AppliedMutation[] } {
  const document = clone(healthy);
  const info = document.LoTE.ListAndSchemeInformation;
  const mutations: AppliedMutation[] = [];
  const record = (defectId: string, applied: boolean, detail: string): void => {
    mutations.push({ defectId, stage: "pre-sign", applied, detail });
  };

  for (const spec of defectsAtStage(defectIds, "pre-sign")) {
    switch (spec.id) {
      case "non_strict_timestamps": {
        /* clause 6.1.3 forbids a fraction; ".000" is the minimal violation. */
        info.ListIssueDateTime = info.ListIssueDateTime.replace(/Z$/, ".000Z");
        info.NextUpdate = info.NextUpdate.replace(/Z$/, ".000Z");
        record(
          spec.id,
          true,
          `ListIssueDateTime=${info.ListIssueDateTime}, NextUpdate=${info.NextUpdate}`,
        );
        break;
      }
      case "scheme_name_without_territory": {
        const prefix = `${context.schemeTerritory}:`;
        const original = info.SchemeName ?? [];
        const stripped = original.map((name) => ({
          ...name,
          value: name.value.startsWith(prefix)
            ? name.value.slice(prefix.length)
            : name.value,
        }));
        const changed = stripped.some(
          (name, index) => name.value !== original[index]?.value,
        );
        info.SchemeName = stripped;
        record(
          spec.id,
          changed,
          changed
            ? `SchemeName=${stripped.map((n) => n.value).join(", ")}`
            : "SchemeName carried no territory prefix to strip.",
        );
        break;
      }
      case "missing_scheme_information_uri": {
        const had = info.SchemeInformationURI !== undefined;
        delete info.SchemeInformationURI;
        record(
          spec.id,
          had,
          had
            ? "SchemeInformationURI removed."
            : "No SchemeInformationURI was present.",
        );
        break;
      }
      case "missing_policy_or_legal_notice": {
        const had = info.PolicyOrLegalNotice !== undefined;
        delete info.PolicyOrLegalNotice;
        record(
          spec.id,
          had,
          had
            ? "PolicyOrLegalNotice removed."
            : "No PolicyOrLegalNotice was present.",
        );
        break;
      }
      case "missing_operator_email": {
        const addresses =
          info.SchemeOperatorAddress.SchemeOperatorElectronicAddress;
        const kept = addresses.filter(
          (address) => !address.uriValue.startsWith("mailto:"),
        );
        const removed = addresses.length - kept.length;
        /*
          The array has minItems 1 in the binding. Dropping the only entry would
          fail schema parsing before the operator-address rule is ever reached,
          which is a different defect than the one selected, so a website URI is
          substituted when the mailto was the sole address.
        */
        info.SchemeOperatorAddress.SchemeOperatorElectronicAddress =
          kept.length > 0
            ? kept
            : [{ lang: "en", uriValue: context.distributionPointUri }];
        record(
          spec.id,
          removed > 0,
          removed > 0
            ? `Removed ${removed} mailto URI(s).`
            : "No mailto URI was present.",
        );
        break;
      }
      case "missing_self_pointer": {
        if (context.family === "pub-eaa-providers") {
          /* See SELF_POINTER_ANNEX_H_NOTE. */
          /*
            The pointer carries the list's own certificate. An empty identity
            array would fail the binding's minItems rule first, which is a
            schema defect rather than the Annex H pointer prohibition under
            test.
          */
          const pointer: OtherLoTEPointer = {
            LoTELocation: context.distributionPointUri,
            ServiceDigitalIdentities: [
              { X509Certificates: [{ val: context.signingCertificateDer }] },
            ],
            LoTEQualifiers: [
              {
                LoTEType: context.loTEType,
                SchemeOperatorName: [
                  { lang: "en", value: context.schemeOperatorName },
                ],
                SchemeTerritory: context.schemeTerritory,
                MimeType: "application/jose",
              },
            ],
          };
          info.PointersToOtherLoTE = [pointer];
          record(
            spec.id,
            true,
            "Injected a PointersToOtherLoTE that Annex H prohibits.",
          );
        } else {
          const had = info.PointersToOtherLoTE !== undefined;
          delete info.PointersToOtherLoTE;
          record(
            spec.id,
            had,
            had
              ? "PointersToOtherLoTE removed."
              : "No self pointer was present.",
          );
        }
        break;
      }
      case "pem_service_certificate": {
        let rewritten = 0;
        for (const entity of document.LoTE.TrustedEntitiesList ?? [])
          for (const service of entity.TrustedEntityServices)
            for (const certificate of service.ServiceInformation
              .ServiceDigitalIdentity.X509Certificates ?? []) {
              certificate.val = toPem(certificate.val);
              rewritten += 1;
            }
        record(
          spec.id,
          rewritten > 0,
          rewritten > 0
            ? `Re-armoured ${rewritten} service certificate(s) as PEM.`
            : "The list carries no service certificate to re-armour. The defect is dormant until an entity is registered.",
        );
        break;
      }
      case "extension_without_criticality": {
        let stripped = 0;
        let injected = 0;
        for (const entity of document.LoTE.TrustedEntitiesList ?? [])
          for (const service of entity.TrustedEntityServices) {
            const information = service.ServiceInformation;
            if (information.ServiceInformationExtensions?.length) {
              for (const extension of information.ServiceInformationExtensions) {
                if ("Critical" in extension) {
                  delete extension.Critical;
                  stripped += 1;
                }
              }
            } else {
              /*
                A profile that publishes no extension has no container to strip.
                One is injected so the defect is observable: an extension with no
                criticality flag is exactly what clause 6.6.9 rejects.
              */
              const extension: ServiceInformationExtensionsItem = {
                ServiceUniqueIdentifier: `urn:fixture:extension-without-criticality:${injected}`,
              };
              information.ServiceInformationExtensions = [extension];
              injected += 1;
            }
          }
        record(
          spec.id,
          stripped + injected > 0,
          stripped + injected > 0
            ? `Stripped criticality from ${stripped} extension(s), injected ${injected} without it.`
            : "The list carries no service to attach an extension to. The defect is dormant until an entity is registered.",
        );
        break;
      }
      default:
        record(
          spec.id,
          false,
          "No pre-sign mutation is defined for this defect.",
        );
    }
  }

  return { document, mutations };
}

/**
 * A deterministic trusted entity seeded into broken fixtures.
 *
 * Two defects — `pem_service_certificate` and `extension_without_criticality` —
 * mutate service structures, and a newly created list carries no entities at
 * all. Without a seed those fixtures would publish an unchanged document and
 * trip no rule, so a broken fixture gets one synthetic entity to mutate. The
 * healthy baseline is left empty, which is what keeps its Inspector verdict
 * clean.
 *
 * The list's own signing certificate doubles as the service certificate: it is
 * always present, already in Base64 DER, and makes the fixture reproducible
 * without shipping extra key material.
 */
export const FIXTURE_ENTITY_NAME = "Broken Fixture Entity";

export function fixtureSeedEntity(
  family: EnabledProfileFamily,
  serviceCertificateDerBase64: string,
  statusStartingTime: string,
  country: string,
): {
  teName: { lang: string; value: string }[];
  teTradeName?: { lang: string; value: string }[];
  tePostalAddress: {
    lang: string;
    StreetAddress: string;
    Locality?: string;
    PostalCode?: string;
    Country: string;
  }[];
  teElectronicAddress: { lang: string; uriValue: string }[];
  teInformationURI: { lang: string; uriValue: string }[];
  services: {
    serviceTypeIdentifier: string;
    serviceName: { lang: string; value: string }[];
    serviceDigitalIdentity: { x509Certificates: string[] };
    serviceStatus?: string;
    statusStartingTime?: string;
  }[];
} {
  const roleUri = `${PUB_EAA_PROVIDER_ROLE_URI_PREFIX}/${country}`;
  const legalBasis = "OJ:EU32024R1183";
  const home = "https://fixture-entity.example/pub-eaa";
  const annexH = family === "pub-eaa-providers";
  return {
    teName: [{ lang: "en", value: FIXTURE_ENTITY_NAME }],
    ...(annexH ? { teTradeName: [{ lang: "en", value: legalBasis }] } : {}),
    tePostalAddress: [
      {
        lang: "en",
        StreetAddress: "1 Fixture Street",
        Locality: "Brussels",
        PostalCode: "1000",
        Country: country,
      },
    ],
    teElectronicAddress: [
      { lang: "en", uriValue: "mailto:fixture@fixture-entity.example" },
      { lang: "en", uriValue: home },
      { lang: "en", uriValue: "tel:+3220000000" },
      ...(annexH ? [{ lang: "en", uriValue: roleUri }] : []),
    ],
    teInformationURI: [{ lang: "en", uriValue: home }],
    services: [
      {
        serviceTypeIdentifier: PUB_EAA_SERVICE_TYPE_ISSUANCE,
        serviceName: [{ lang: "en", value: "Broken Fixture Issuance" }],
        serviceDigitalIdentity: {
          x509Certificates: [serviceCertificateDerBase64],
        },
        ...(annexH
          ? {
              serviceStatus: PUB_EAA_SVC_STATUS_NOTIFIED,
              statusStartingTime,
            }
          : {}),
      },
    ],
  };
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

export interface PostSignContext {
  /** PEM of the healthy signing certificate. */
  certificatePem: string;
  /** The key the healthy signature was produced with. */
  signingKey: globalThis.CryptoKey;
  document: LoTEDocument;
  signingTime: Date;
  schemeOperatorName: string;
}

export interface PostSignOutcome {
  /** Compact JAdES to publish. Identical to the input when nothing applied. */
  compact: string;
  /** PEM actually used, which differs when the signer was substituted. */
  certificatePem: string;
  mutations: AppliedMutation[];
}

/**
 * Applies signature-stage defects. These re-sign the payload rather than edit
 * the compact serialization: a hand-edited JWS fails cryptographic verification
 * first, which would mask the specific signature defect being tested behind a
 * generic "signature does not verify".
 */
export async function applyPostSignDefects(
  healthyCompact: string,
  defectIds: readonly string[],
  context: PostSignContext,
): Promise<PostSignOutcome> {
  const specs = defectsAtStage(defectIds, "post-sign");
  const mutations: AppliedMutation[] = [];
  if (specs.length === 0)
    return {
      compact: healthyCompact,
      certificatePem: context.certificatePem,
      mutations,
    };

  const wantsMismatch = specs.some(
    (spec) => spec.id === "signer_organisation_mismatch",
  );
  const wantsNoSigningTime = specs.some(
    (spec) => spec.id === "jades_without_signing_time",
  );

  let certificatePem = context.certificatePem;
  let signingKey = context.signingKey;

  if (wantsMismatch) {
    const substitute = mintMismatchedSigner(context.schemeOperatorName);
    if (substitute) {
      certificatePem = substitute.certificatePem;
      signingKey = await importPrivateKey(substitute.privateKeyPem);
      mutations.push({
        defectId: "signer_organisation_mismatch",
        stage: "post-sign",
        applied: true,
        detail: `Re-signed with a self-signed certificate whose subject organisation is "${mismatchOrganisation(context.schemeOperatorName)}".`,
      });
    } else {
      mutations.push({
        defectId: "signer_organisation_mismatch",
        stage: "post-sign",
        applied: false,
        detail:
          "A substitute signing certificate could not be generated (openssl unavailable); the healthy signer was kept.",
      });
    }
  }

  const protectedHeader: jose.CompactJWSHeaderParameters = {
    alg: "ES256",
    x5c: [derBase64(certificatePem)],
    typ: "JAdES",
  };
  if (wantsNoSigningTime) {
    mutations.push({
      defectId: "jades_without_signing_time",
      stage: "post-sign",
      applied: true,
      detail: "Re-signed with no iat protected header.",
    });
  } else {
    protectedHeader.iat = Math.floor(context.signingTime.getTime() / 1000);
  }

  const payload = new TextEncoder().encode(JSON.stringify(context.document));
  const compact = await new jose.CompactSign(payload)
    .setProtectedHeader(protectedHeader)
    .sign(signingKey);

  return { compact, certificatePem, mutations };
}

function derBase64(certPem: string): string {
  const body = certPem.replace(/-----[^-]+-----/g, "").replace(/\s/g, "");
  return Buffer.from(body, "base64").toString("base64");
}

async function importPrivateKey(pem: string): Promise<globalThis.CryptoKey> {
  const { createPrivateKey } = await import("node:crypto");
  return crypto.subtle.importKey(
    "jwk",
    createPrivateKey(pem).export({ format: "jwk" }),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
}

function mismatchOrganisation(schemeOperatorName: string): string {
  return `Not ${schemeOperatorName}`.slice(0, 64);
}

function mintMismatchedSigner(
  schemeOperatorName: string,
): { certificatePem: string; privateKeyPem: string } | null {
  return mintCertificate({
    commonName: "Intentionally Broken Fixture Signer",
    organisation: mismatchOrganisation(schemeOperatorName),
    country: "EU",
  });
}

/**
 * Mints a throwaway P-256 self-signed certificate.
 *
 * Fixtures need certificates whose subject says something specific — a signer
 * organisation that deliberately mismatches, or a service certificate whose
 * organisation must match the entity name for Annex H. Minting one is cheaper
 * and more reproducible than shipping key material per fixture.
 *
 * Rewriting SchemeOperatorName in the document was considered for the mismatch
 * case and rejected: the publication list key is derived from that field, so
 * mutating it would rename the list rather than break its signature.
 *
 * Returns null when openssl is unavailable, so the caller can degrade to a
 * recorded "not applied" rather than failing the publication.
 */
export function mintCertificate(subject: {
  commonName: string;
  organisation: string;
  country: string;
}): { certificatePem: string; privateKeyPem: string } | null {
  let dir: string | null = null;
  const sanitise = (value: string): string =>
    value.replace(/[/\\\n\r]/g, " ").slice(0, 64);
  try {
    dir = mkdtempSync(join(tmpdir(), "tlp-fixture-cert-"));
    const keyPath = join(dir, "signer.key");
    const certPath = join(dir, "signer.crt");
    execFileSync(
      "openssl",
      [
        "genpkey",
        "-algorithm",
        "EC",
        "-pkeyopt",
        "ec_paramgen_curve:P-256",
        "-out",
        keyPath,
      ],
      { stdio: "ignore" },
    );
    execFileSync(
      "openssl",
      [
        "req",
        "-new",
        "-x509",
        "-key",
        keyPath,
        "-out",
        certPath,
        "-days",
        "365",
        "-subj",
        `/CN=${sanitise(subject.commonName)}/C=${sanitise(subject.country)}/O=${sanitise(subject.organisation)}`,
      ],
      { stdio: "ignore" },
    );
    return {
      certificatePem: readFileSync(certPath, "utf-8"),
      privateKeyPem: readFileSync(keyPath, "utf-8"),
    };
  } catch {
    return null;
  } finally {
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  }
}

/**
 * Negative-fixture metadata stored beside a version. It sits outside the
 * integrity-checked set for the same reason the Inspector evaluation does: it
 * is evidence *about* the version, and the three signed artifacts stay
 * immutable and are hashed as published — intentionally broken bytes included.
 */
export interface FixtureMetadata {
  schemaVersion: 1;
  intentionallyBroken: boolean;
  selectedDefects: string[];
  mutations: AppliedMutation[];
  /** Local schema/profile validation findings, recorded rather than fatal. */
  localValidationFailures: string[];
  expectedInspectorFailures: string[];
  actualInspectorFailures: string[];
  matchedFailures: string[];
  missingFailures: string[];
  additionalFailures: string[];
  /**
   * Failures caused by the seeded entity rather than by any selected defect.
   * Split out so `additionalFailures` keeps meaning "this mutation caused
   * something we did not predict".
   */
  knownUnrelatedFailures: string[];
  generatedAt: string;
}

/**
 * Assembles the metadata stored beside an intentionally broken version, pairing
 * what the defect catalogue predicted with what the Inspector actually said.
 */
export function buildFixtureMetadata(
  selectedDefects: readonly string[],
  mutations: readonly AppliedMutation[],
  localValidationFailures: readonly string[],
  actualInspectorFailures: readonly string[],
  generatedAt: Date,
): FixtureMetadata {
  const expected = expectedRuleIdsFor(selectedDefects);
  const comparison = compareFailures(expected, actualInspectorFailures);
  return {
    schemaVersion: 1,
    intentionallyBroken: true,
    selectedDefects: [...selectedDefects],
    mutations: [...mutations],
    localValidationFailures: [...localValidationFailures],
    expectedInspectorFailures: expected,
    actualInspectorFailures: [...actualInspectorFailures],
    matchedFailures: comparison.matched,
    missingFailures: comparison.missing,
    additionalFailures: comparison.additional,
    knownUnrelatedFailures: [],
    generatedAt: generatedAt.toISOString(),
  };
}

/** Rule ID part of a `${id}: ${message}` failure line. */
function ruleIdOf(failure: string): string {
  const separator = failure.indexOf(":");
  return separator === -1 ? failure : failure.slice(0, separator);
}

/**
 * Compares expectation against the Inspector's verdict. Cascading failures are
 * expected — one mutation can trip several rules — so an additional failure is
 * reported rather than treated as wrong.
 */
export function compareFailures(
  expected: readonly string[],
  actualFailureLines: readonly string[],
): { matched: string[]; missing: string[]; additional: string[] } {
  const actualIds = new Set(actualFailureLines.map(ruleIdOf));
  const expectedSet = new Set(expected);
  return {
    matched: expected.filter((rule) => actualIds.has(rule)).sort(),
    missing: expected.filter((rule) => !actualIds.has(rule)).sort(),
    additional: [...actualIds].filter((rule) => !expectedSet.has(rule)).sort(),
  };
}
