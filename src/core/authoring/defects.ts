/**
 * Intentionally broken TS 119 602 Trusted List generation.
 *
 * These fixtures exist so EUDI wallet, issuer and verifier implementations can
 * register against a list that is *known* to violate a specific clause and
 * confirm their runtime detects it. A failing Trust Inspector verdict on one of
 * these lists is the deliverable, not an error.
 *
 * What each defect *means*, which stage it applies at and what it is expected
 * to fail live in the canonical catalogue at `src/core/defects/registry.ts`,
 * shared with the TS 119 612 XML engine. This module is the JSON half: it knows
 * how to perform the mutations on a LoTE document and on its Compact JAdES.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as jose from "jose";
import type { AuthoringEntity, AuthoringService } from "../model/authoring.js";
import type {
  LoTEDocument,
  OtherLoTEPointer,
  ServiceInformationExtensionsItem,
} from "../model/types.js";
import {
  getEnabledProfile,
  type EnabledProfileFamily,
} from "../profiles/registry.js";
import {
  defectForStandard,
  defectsAtStageFor,
  defectsForStandard,
  expectedRuleIdsForStandard,
  type DefectSpec,
  type DefectStage,
} from "../defects/registry.js";

import {
  buildFixtureMetadata as buildSharedFixtureMetadata,
  type AppliedMutation,
  type FixtureMetadata,
} from "../defects/fixture-metadata.js";

export {
  compareFailures,
  normalizeInspectorRuleId,
} from "../defects/registry.js";
export type {
  DefectSpec,
  DefectStage,
  DefectStandard,
} from "../defects/registry.js";
export type {
  AppliedMutation,
  FixtureMetadata,
} from "../defects/fixture-metadata.js";

/** The standard this engine mutates. */
const STANDARD = "TS 119 602" as const;

/**
 * The catalogue as TS 119 602 sees it. Re-exported so the existing JSON
 * callers and views keep one import while the catalogue itself is shared.
 */
export const DEFECT_SPECS: readonly DefectSpec[] = defectsForStandard(STANDARD);

export function defectSpec(id: string): DefectSpec | undefined {
  return defectForStandard(id, STANDARD);
}

export function defectsAtStage(
  ids: readonly string[],
  stage: DefectStage,
): DefectSpec[] {
  return defectsAtStageFor(ids, STANDARD, stage);
}

/** Every rule ID the selected defects are expected to trip, deduplicated. */
export function expectedRuleIdsFor(
  ids: readonly string[],
  family?: EnabledProfileFamily,
): string[] {
  return expectedRuleIdsForStandard(ids, STANDARD, family);
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
): AuthoringEntity {
  const profile = getEnabledProfile(family);
  const roleUri = `${profile.roleUriPrefix}/${country}`;
  const legalBasis = "OJ:EU32024R1183";
  const home = `https://fixture-entity.example/${family}`;
  const service: AuthoringService = {
    serviceTypeIdentifier: profile.allowedServiceTypes[0]!,
    serviceName: [{ lang: "en", value: "Broken Fixture Issuance" }],
    serviceDigitalIdentity: {
      x509Certificates: [serviceCertificateDerBase64],
    },
    ...(profile.requiresServiceUniqueIdentifier
      ? { serviceUniqueIdentifier: `urn:fixture:${family}:issuance` }
      : {}),
    ...(profile.usesServiceStatus
      ? {
          serviceStatus: profile.serviceStatuses!.notified,
          statusStartingTime,
        }
      : {}),
  };
  return {
    teName: [{ lang: "en", value: FIXTURE_ENTITY_NAME }],
    ...(profile.requiresLegalBasisReference
      ? { teTradeName: [{ lang: "en", value: legalBasis }] }
      : {}),
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
      ...(profile.roleUriInElectronicAddress
        ? [{ lang: "en", uriValue: roleUri }]
        : []),
    ],
    teInformationURI: [
      { lang: "en", uriValue: home },
      ...(profile.roleUriInInformationUri
        ? [{ lang: "en", uriValue: roleUri }]
        : []),
    ],
    services: [service],
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
  schemeTerritory: string;
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
    const substitute = mintMismatchedSigner(
      context.schemeOperatorName,
      context.schemeTerritory,
    );
    if (substitute) {
      certificatePem = substitute.certificatePem;
      signingKey = await importPrivateKey(substitute.privateKeyPem);
      mutations.push({
        defectId: "signer_organisation_mismatch",
        stage: "post-sign",
        applied: true,
        detail: `Re-signed with a self-signed certificate whose subject organisation is "${mismatchOrganisation(context.schemeOperatorName)}" and country is "${mismatchCountry(context.schemeTerritory)}".`,
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

function mismatchCountry(territory: string): string {
  return territory === "IT" ? "DE" : "IT";
}

function mintMismatchedSigner(
  schemeOperatorName: string,
  schemeTerritory: string,
): { certificatePem: string; privateKeyPem: string } | null {
  return mintCertificate({
    commonName: "Intentionally Broken Fixture Signer",
    organisation: mismatchOrganisation(schemeOperatorName),
    country: mismatchCountry(schemeTerritory),
  });
}

/** id-tsl-kp-tslSigning; the extended key usage of a Trusted List signer. */
const TSL_SIGNING_EKU = "0.4.0.2231.3.0";

/**
 * The `-addext` arguments for the requested shape.
 *
 * A bare `openssl req -x509` emits basicConstraints CA:TRUE and no keyUsage,
 * which meets neither shape a fixture asks for. Stating the extensions
 * explicitly is what makes each shape a deliberate property of the fixture
 * rather than an OpenSSL default.
 */
function certificateExtensions(subject: {
  trustedListProfile?: boolean;
  certificateAuthority?: boolean;
}): string[] {
  if (subject.certificateAuthority)
    return [
      "-addext",
      "basicConstraints=critical,CA:TRUE",
      "-addext",
      "keyUsage=critical,keyCertSign,cRLSign",
      "-addext",
      "subjectKeyIdentifier=hash",
    ];
  if (subject.trustedListProfile)
    return [
      "-addext",
      "basicConstraints=critical,CA:FALSE",
      "-addext",
      "keyUsage=critical,digitalSignature",
      "-addext",
      "subjectKeyIdentifier=hash",
      "-addext",
      `extendedKeyUsage=critical,${TSL_SIGNING_EKU}`,
    ];
  return [];
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
  /**
   * Shape the certificate as a TS 119 612 Scheme Operator signing certificate:
   * CA:FALSE, a SubjectKeyIdentifier, keyUsage digitalSignature and the
   * tslSigning extended key usage. Used by fixtures whose defect is the
   * *subject* of the signer, not its shape — the shape has to be right for the
   * subject to be the only thing wrong.
   */
  trustedListProfile?: boolean;
  /**
   * Shape the certificate as a certification authority instead: CA:TRUE with
   * keyCertSign and cRLSign. This is itself the defect for
   * `incorrect_signing_certificate`.
   */
  certificateAuthority?: boolean;
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
        ...certificateExtensions(subject),
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
 * Assembles the metadata stored beside an intentionally broken JSON version.
 *
 * A thin wrapper over the shared builder: it fixes the standard and format and
 * carries this engine's free-text local findings across as actual local
 * failures. TS 119 602 defects declare no expected local check IDs, so the
 * local comparison is empty by construction rather than by accident.
 */
export function buildFixtureMetadata(
  selectedDefects: readonly string[],
  mutations: readonly AppliedMutation[],
  localValidationFailures: readonly string[],
  actualInspectorFailures: readonly string[],
  generatedAt: Date,
  family: EnabledProfileFamily,
): FixtureMetadata {
  return buildSharedFixtureMetadata({
    standard: STANDARD,
    artifactFormat: "JSON / JAdES",
    profile: family,
    selectedDefects,
    mutations,
    actualLocalFailures: localValidationFailures,
    actualInspectorFailures,
    generatedAt,
  });
}
