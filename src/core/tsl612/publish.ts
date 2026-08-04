/**
 * Publishing one version of a TS 119 612 Trusted List.
 *
 * The order is fixed and each step gates the next: compile, sign (which
 * schema-validates and verifies), build the manifest from the *published*
 * bytes, store immutably, and only then ask the Trust Inspector. The Inspector
 * runs last and cannot fail a publication — it is evidence about a version that
 * already exists, which is why `inspector.json` sits outside the
 * integrity-checked set.
 */
import { X509Certificate } from "node:crypto";
import { compileTrustedList } from "./compile.js";
import { readTrustedListMetadata } from "./read.js";
import { signTrustedList } from "./sign.js";
import { validateTslXml } from "./schema.js";
import {
  HISTORICAL_INFORMATION_PERIOD,
  STATUS_DETERMINATION_EU_APPROPRIATE,
  TSL_MEDIA_TYPE,
  TSL_TAG,
  TSL_TYPE_EU_GENERIC,
  TSL_VERSION_IDENTIFIER,
} from "./constants.js";
import {
  applyXmlPostSignDefects,
  applyXmlPreSignDefects,
  planSha2Digest,
  planXmlSigning,
  type XmlDefectContext,
} from "./defects.js";
import { verifyEnveloped } from "../../xmlsec/index.js";
import { LOCAL_FAILURE_IDS } from "../defects/registry.js";
import {
  unappliedSelectedDefects,
  type AppliedMutation,
} from "../defects/fixture-metadata.js";
import type { TrustedListInput } from "./model.js";
import {
  buildTrustedListManifest,
  sha256Hex,
  type TrustedListManifest,
  type TrustedListMetadata,
} from "../publication/tsl-manifest.js";
import type { TrustedListStore } from "../publication/tsl-store.js";
import type {
  InspectorClient,
  InspectorEvaluation,
} from "../inspector/inspector.js";

export interface PublishTrustedListOptions {
  readonly store: TrustedListStore;
  readonly listKey: string;
  readonly family: string;
  readonly input: TrustedListInput;
  readonly privateKeyPem: string;
  readonly certificatePem: string;
  readonly publishedAt?: Date;
  readonly signingTime?: Date;
  readonly allowedServiceProfiles?: readonly string[];
  /**
   * Turns this publication into an intentionally broken fixture. Absent for
   * every ordinary publication, which is what keeps the healthy path unable to
   * emit a document that failed a check.
   */
  readonly fixture?: FixturePublicationOptions;
}

/** What an intentionally broken publication asks the pipeline to do. */
export interface FixturePublicationOptions {
  readonly defectIds: readonly string[];
  readonly context: XmlDefectContext;
}

export interface PublishedTrustedList {
  readonly listKey: string;
  readonly sequenceNumber: number;
  readonly xml: string;
  readonly manifest: TrustedListManifest;
  /** Present only for an intentionally broken publication. */
  readonly fixture?: FixturePublicationResult;
}

export interface FixturePublicationResult {
  readonly mutations: AppliedMutation[];
  /** Stable local check IDs that failed. See `LOCAL_FAILURE_IDS`. */
  readonly localFailures: string[];
  /** The findings behind those IDs, for the evidence panel. */
  readonly localFindings: string[];
}

/**
 * Compiles, signs and stores one immutable version.
 *
 * The healthy path is unchanged: every check gates the next and nothing that
 * fails one is stored. A fixture publication runs the same pipeline with the
 * mutation stages interleaved, and records each failure instead of stopping —
 * for a negative fixture the failure is the deliverable, and a defect that got
 * silently repaired would be worse than no fixture at all.
 *
 *   healthy XML → pre-sign mutations → signing plan → sign
 *   → post-sign mutations → final bytes → .sha2 → store
 */
export function publishTrustedList(
  options: PublishTrustedListOptions,
): PublishedTrustedList {
  const healthyXml = compileTrustedList(options.input);
  const fixture = options.fixture;
  const mutations: AppliedMutation[] = [];

  const preSign = fixture
    ? applyXmlPreSignDefects(healthyXml, fixture.defectIds, fixture.context)
    : { xml: healthyXml, mutations: [] as AppliedMutation[] };
  mutations.push(...preSign.mutations);

  const plan = fixture
    ? planXmlSigning(
        fixture.defectIds,
        {
          privateKeyPem: options.privateKeyPem,
          certificatePem: options.certificatePem,
        },
        fixture.context,
      )
    : {
        privateKeyPem: options.privateKeyPem,
        certificatePem: options.certificatePem,
        omitSigningTime: false,
        mutations: [] as AppliedMutation[],
      };
  mutations.push(...plan.mutations);

  const signed = signTrustedList(preSign.xml, {
    privateKeyPem: plan.privateKeyPem,
    certificatePem: plan.certificatePem,
    expectation: {
      schemeTerritory: options.input.schemeInformation.schemeTerritory,
      schemeOperatorName: options.input.schemeInformation.schemeOperatorName,
    },
    ...(options.signingTime ? { signingTime: options.signingTime } : {}),
    ...(plan.omitSigningTime ? { omitSigningTime: true } : {}),
    ...(fixture ? { recordFailuresInsteadOfThrowing: true } : {}),
  });

  const postSign = fixture
    ? applyXmlPostSignDefects(signed.xml, fixture.defectIds)
    : { xml: signed.xml, mutations: [] as AppliedMutation[] };
  mutations.push(...postSign.mutations);

  const finalXml = postSign.xml;
  const honestDigest = sha256Hex(Buffer.from(finalXml, "utf-8"));
  const digest = fixture
    ? planSha2Digest(honestDigest, fixture.defectIds)
    : { digest: honestDigest, mutations: [] as AppliedMutation[] };
  mutations.push(...digest.mutations);

  if (fixture) {
    const unapplied = unappliedSelectedDefects(fixture.defectIds, mutations);
    if (unapplied.length > 0)
      throw new Error(
        `Selected defects were not applied: ${unapplied.join(", ")}.`,
      );
  }

  const certificate = new X509Certificate(plan.certificatePem);
  /*
    The manifest describes the published bytes, so the metadata is read back
    from them rather than taken from the input that made them. A mutation can
    make those bytes unreadable as a Trusted List — `invalid_tsl_namespace` is
    precisely that — and a fixture must still publish. In that case the manifest
    falls back to what the list was *asked* to be and says so, so a reader is
    never told that unreadable bytes were read.
  */
  let metadata: TrustedListMetadata;
  let metadataSource: TrustedListManifest["trustedListMetadataSource"] =
    "published-bytes";
  try {
    metadata = readTrustedListMetadata(finalXml);
  } catch (error) {
    if (!fixture) throw error;
    metadata = metadataFromInput(options.input);
    metadataSource = "authoring-input";
  }
  /*
    The signature is re-verified over the bytes actually being published. The
    result of signing says the signature was sound when it was made; a
    post-signing mutation is exactly the case where those two differ.
  */
  const signature =
    postSign.xml === signed.xml ? signed.signature : verifyEnveloped(finalXml);
  const schema =
    postSign.xml === signed.xml ? signed.schema : validateTslXml(finalXml);

  const manifest = buildTrustedListManifest({
    listKey: options.listKey,
    family: options.family,
    xml: finalXml,
    /* Read back from the published bytes, not from the input that made them. */
    metadata,
    schema,
    signature,
    signer: {
      subject: certificate.subject.replace(/\n/g, ", "),
      issuer: certificate.issuer.replace(/\n/g, ", "),
      validFrom: certificate.validFrom,
      validTo: certificate.validTo,
      fingerprint: certificate.fingerprint256.replace(/:/g, "").toLowerCase(),
    },
    publishedAt: options.publishedAt ?? new Date(),
    metadataSource,
    ...(options.allowedServiceProfiles
      ? { allowedServiceProfiles: options.allowedServiceProfiles }
      : {}),
    signingCertificateFindings: signed.certificateProfileFindings,
    ...(digest.digest === honestDigest ? {} : { sha2Override: digest.digest }),
    ...(fixture
      ? {
          fixture: {
            fixtureMode:
              fixture.defectIds.length > 0
                ? ("intentionally-broken" as const)
                : ("healthy" as const),
            selectedDefects: [...fixture.defectIds],
            mutationStages: [
              ...new Set(
                mutations
                  .filter((mutation) => mutation.applied)
                  .map((mutation) => mutation.stage),
              ),
            ],
          },
        }
      : {}),
  });

  options.store.store(finalXml, manifest);

  return {
    listKey: options.listKey,
    sequenceNumber: manifest.sequenceNumber,
    xml: finalXml,
    manifest,
    ...(fixture
      ? {
          fixture: {
            mutations,
            ...localFailuresOf(manifest, digest.digest, honestDigest),
          },
        }
      : {}),
  };
}

/**
 * What the list was asked to be, when the bytes it became cannot be read.
 *
 * Every value here is a fact about the authoring input or a constant of the
 * standard. Nothing is inferred from the published bytes, which is the point:
 * the manifest records `trustedListMetadataSource: "authoring-input"` beside
 * it so the distinction is never lost.
 */
function metadataFromInput(input: TrustedListInput): TrustedListMetadata {
  const scheme = input.schemeInformation;
  const services = (input.providers ?? []).flatMap(
    (provider) => provider.services,
  );
  return {
    tslTag: TSL_TAG,
    tslVersionIdentifier: TSL_VERSION_IDENTIFIER,
    tslSequenceNumber: scheme.sequenceNumber,
    tslType: TSL_TYPE_EU_GENERIC,
    statusDeterminationApproach: STATUS_DETERMINATION_EU_APPROPRIATE,
    schemeOperatorName: scheme.schemeOperatorName,
    schemeName: scheme.schemeName,
    schemeTerritory: scheme.schemeTerritory,
    historicalInformationPeriod: HISTORICAL_INFORMATION_PERIOD,
    issueDate: scheme.listIssueDateTime,
    nextUpdateDate: scheme.nextUpdate,
    serviceTypes: [
      ...new Set(services.map((service) => service.serviceTypeIdentifier)),
    ],
    providerCount: (input.providers ?? []).length,
    serviceCount: services.length,
  };
}

/**
 * The local checks a published fixture failed, as stable IDs plus the findings
 * behind them. Reading them off the manifest rather than re-deriving them keeps
 * the evidence and the published record describing the same artifact.
 */
function localFailuresOf(
  manifest: TrustedListManifest,
  publishedDigest: string,
  honestDigest: string,
): { localFailures: string[]; localFindings: string[] } {
  const failures: string[] = [];
  const findings: string[] = [];
  if (!manifest.schemaValid) {
    failures.push(LOCAL_FAILURE_IDS.xmlSchema);
    findings.push(...manifest.schemaFindings);
  }
  if (!manifest.signatureValid) {
    failures.push(LOCAL_FAILURE_IDS.xadesSignature);
    findings.push(...manifest.signatureFindings);
  }
  if (manifest.signingCertificateFindings.length > 0) {
    failures.push(LOCAL_FAILURE_IDS.signingCertificateProfile);
    findings.push(...manifest.signingCertificateFindings);
  }
  if (!manifest.freshnessValid) {
    failures.push(LOCAL_FAILURE_IDS.freshness);
    findings.push(...manifest.freshnessFindings);
  }
  if (publishedDigest !== honestDigest) {
    failures.push(LOCAL_FAILURE_IDS.sha2Digest);
    findings.push(
      `trusted-list.sha2 publishes ${publishedDigest}, but the XML digests to ${honestDigest}.`,
    );
  }
  return { localFailures: failures, localFindings: findings };
}

/**
 * Submits a published version to the Trust Inspector and stores the complete
 * response beside it. Never throws: an Inspector that cannot be reached is a
 * fact about the evaluation, not a reason to undo a publication.
 */
export async function evaluatePublishedTrustedList(
  store: TrustedListStore,
  client: InspectorClient,
  published: PublishedTrustedList,
  source: string,
): Promise<InspectorEvaluation> {
  const evaluation = await client.assess({
    trustedListXml: published.xml,
    source,
    serviceTypes: published.manifest.trustedList.serviceTypes,
    declared: {
      mimeType: TSL_MEDIA_TYPE,
      schemeOperatorName: published.manifest.trustedList.schemeOperatorName,
      schemeTerritory: published.manifest.trustedList.schemeTerritory,
    },
  });
  try {
    store.writeInspectorEvaluation(
      published.listKey,
      published.sequenceNumber,
      `${JSON.stringify(evaluation, null, 2)}\n`,
    );
  } catch {
    /* The evaluation is evidence, not an artifact: failing to file it must not
       undo a version that is already published and verified. */
  }
  return evaluation;
}
