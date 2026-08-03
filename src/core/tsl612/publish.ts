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
import { TSL_MEDIA_TYPE } from "./constants.js";
import type { TrustedListInput } from "./model.js";
import {
  buildTrustedListManifest,
  type TrustedListManifest,
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
}

export interface PublishedTrustedList {
  readonly listKey: string;
  readonly sequenceNumber: number;
  readonly xml: string;
  readonly manifest: TrustedListManifest;
}

/** Compiles, signs and stores one immutable version. */
export function publishTrustedList(
  options: PublishTrustedListOptions,
): PublishedTrustedList {
  const xml = compileTrustedList(options.input);
  const signed = signTrustedList(xml, {
    privateKeyPem: options.privateKeyPem,
    certificatePem: options.certificatePem,
    expectation: {
      schemeTerritory: options.input.schemeInformation.schemeTerritory,
      schemeOperatorName: options.input.schemeInformation.schemeOperatorName,
    },
    ...(options.signingTime ? { signingTime: options.signingTime } : {}),
  });

  const certificate = new X509Certificate(options.certificatePem);
  const manifest = buildTrustedListManifest({
    listKey: options.listKey,
    family: options.family,
    xml: signed.xml,
    /* Read back from the published bytes, not from the input that made them. */
    metadata: readTrustedListMetadata(signed.xml),
    schema: signed.schema,
    signature: signed.signature,
    signer: {
      subject: certificate.subject.replace(/\n/g, ", "),
      issuer: certificate.issuer.replace(/\n/g, ", "),
      validFrom: certificate.validFrom,
      validTo: certificate.validTo,
      fingerprint: certificate.fingerprint256.replace(/:/g, "").toLowerCase(),
    },
    publishedAt: options.publishedAt ?? new Date(),
  });

  options.store.store(signed.xml, manifest);

  return {
    listKey: options.listKey,
    sequenceNumber: manifest.sequenceNumber,
    xml: signed.xml,
    manifest,
  };
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
