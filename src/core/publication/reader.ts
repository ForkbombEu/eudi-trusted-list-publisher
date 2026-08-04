/**
 * One reader over both publication formats.
 *
 * The Catalogue, the list pages, the version pages and the API all need the
 * same three questions answered — which lists exist, which versions each has,
 * and what one version is — without caring whether the answer comes from a
 * TS 119 602 JSON publication or a TS 119 612 XML Trusted List. This façade
 * detects the format from what is actually on disk and dispatches.
 *
 * Detection is by artifact, not by configuration: a directory holding
 * `trusted-list.xml` is an XML Trusted List even if no configuration mentions
 * it, because the published bytes are the authority. A directory that somehow
 * holds both is refused rather than resolved by preference — a list key names
 * one list, and a collision means something is wrong that a guess would hide.
 */
import { existsSync } from "node:fs";
import { PublicationStore } from "./store.js";
import type { Manifest } from "./manifest.js";
import {
  TrustedListStore,
  type TrustedListVersionArtifacts,
} from "./tsl-store.js";
import type { TrustedListManifest } from "./tsl-manifest.js";
import type { ListStandard } from "../authoring/list-family-catalogue.js";

export type PublicationFormat = "json" | "xml";

export interface VersionSummary {
  readonly sequenceNumber: number;
  readonly format: PublicationFormat;
  readonly standard: ListStandard;
  readonly issueDate: string;
  readonly nextUpdateDate: string;
  readonly publicationTimestamp: string;
  readonly signatureValid: boolean;
  readonly schemaValid: boolean;
  readonly signerTrustStatus: "not_evaluated";
}

export interface ListSummary {
  readonly listKey: string;
  readonly format: PublicationFormat;
  readonly standard: ListStandard;
  readonly latestSequence: number | null;
  readonly versionCount: number;
  /** Family from the manifest, where the format records one. */
  readonly family?: string;
  /** XML service profiles accepted by the list, where recorded. */
  readonly allowedServiceProfiles?: readonly string[];
  readonly schemeOperatorName?: string;
  readonly territory?: string;
}

export interface XmlVersionDetail {
  readonly format: "xml";
  readonly standard: "TS 119 612";
  readonly sequenceNumber: number;
  readonly manifest: TrustedListManifest;
  readonly manifestBytes: string;
  readonly xml: string;
  readonly sha2: string;
}

export interface JsonVersionDetail {
  readonly format: "json";
  readonly standard: "TS 119 602";
  readonly sequenceNumber: number;
  readonly manifest: Manifest;
}

export type VersionDetail = XmlVersionDetail | JsonVersionDetail;

export class ListKeyCollisionError extends Error {
  constructor(listKey: string) {
    super(
      `List key '${listKey}' holds both a TS 119 602 publication and a TS 119 612 Trusted List. A list key names one list; resolve the collision before serving it.`,
    );
    this.name = "ListKeyCollisionError";
  }
}

export class PublicationReader {
  constructor(
    private readonly json: PublicationStore,
    private readonly xml: TrustedListStore,
  ) {}

  /** Every list key under the publication root, sorted. */
  listKeys(): string[] {
    return this.json.listKeys();
  }

  /**
   * Which format a list is published in, or null when it has no readable
   * version. Throws on a collision rather than picking one.
   */
  formatOf(listKey: string): PublicationFormat | null {
    let highest: number | null;
    try {
      highest = this.xml.getHighestStoredSequence(listKey);
    } catch {
      return null;
    }
    if (highest === null) return null;
    const hasXml = this.xml.isTrustedListVersion(listKey, highest);
    const hasJson = existsSync(this.json.loteJsonPath(listKey, highest));
    if (hasXml && hasJson) throw new ListKeyCollisionError(listKey);
    if (hasXml) return "xml";
    return hasJson ? "json" : null;
  }

  async listSummaries(): Promise<ListSummary[]> {
    const summaries: ListSummary[] = [];
    for (const listKey of this.listKeys()) {
      const summary = await this.listSummary(listKey);
      if (summary) summaries.push(summary);
    }
    return summaries;
  }

  async listSummary(listKey: string): Promise<ListSummary | null> {
    let format: PublicationFormat | null;
    try {
      format = this.formatOf(listKey);
    } catch {
      /* A collision must not take the Catalogue down; the list is omitted and
         the version page reports the collision when it is opened. */
      return null;
    }
    if (format === null) return null;

    if (format === "xml") {
      const latest = this.xml.loadLatest(listKey);
      if (!latest) return null;
      let allowedServiceProfiles: readonly string[] = [];
      const sequences = this.xml.sequences(listKey);
      for (let index = sequences.length - 1; index >= 0; index--) {
        const outcome = this.xml.loadVersion(listKey, sequences[index]!);
        const recorded =
          outcome.artifacts?.manifest.serviceProfiles.allowedServiceProfiles ??
          [];
        if (recorded.length > 0) {
          allowedServiceProfiles = [...new Set(recorded)];
          break;
        }
      }
      return {
        listKey,
        format: "xml",
        standard: "TS 119 612",
        latestSequence: latest.sequenceNumber,
        versionCount: this.xml.sequences(listKey).length,
        family: latest.artifacts.manifest.family,
        allowedServiceProfiles:
          allowedServiceProfiles.length > 0
            ? allowedServiceProfiles
            : [latest.artifacts.manifest.family],
        schemeOperatorName:
          latest.artifacts.manifest.trustedList.schemeOperatorName,
        territory: latest.artifacts.manifest.trustedList.schemeTerritory,
      };
    }

    const index = await this.json.loadIndex(listKey);
    if (!index || index.versions.length === 0) return null;
    const latest = index.versions[index.versions.length - 1]!;
    const manifest = await this.json.loadManifest(
      listKey,
      latest.sequenceNumber,
    );
    return {
      listKey,
      format: "json",
      standard: "TS 119 602",
      latestSequence: latest.sequenceNumber,
      versionCount: index.versions.length,
      ...(manifest
        ? {
            schemeOperatorName: manifest.schemeOperatorName,
            territory: manifest.territory,
          }
        : {}),
    };
  }

  /** Every readable version of a list, ascending. */
  async versions(listKey: string): Promise<VersionSummary[]> {
    const format = this.formatOf(listKey);
    if (format === null) return [];
    if (format === "xml") {
      const summaries: VersionSummary[] = [];
      for (const sequence of this.xml.sequences(listKey)) {
        const outcome = this.xml.loadVersion(listKey, sequence);
        if (!outcome.artifacts) continue;
        const manifest = outcome.artifacts.manifest;
        summaries.push({
          sequenceNumber: sequence,
          format: "xml",
          standard: "TS 119 612",
          issueDate: manifest.trustedList.issueDate,
          nextUpdateDate: manifest.trustedList.nextUpdateDate,
          publicationTimestamp: manifest.publicationTimestamp,
          signatureValid: manifest.signatureValid,
          schemaValid: manifest.schemaValid,
          signerTrustStatus: manifest.signerTrustStatus,
        });
      }
      return summaries;
    }
    const index = await this.json.loadIndex(listKey);
    if (!index) return [];
    return index.versions.map((version) => ({
      sequenceNumber: version.sequenceNumber,
      format: "json" as const,
      standard: "TS 119 602" as const,
      issueDate: version.issueDate,
      nextUpdateDate: version.nextUpdateDate,
      publicationTimestamp: version.publicationTimestamp,
      signatureValid: version.signatureValid,
      schemaValid: version.etsiSchemaValid,
      /* The index records it as a string; the store only ever writes the one
         value, and a manifest stating anything else is rejected on load. */
      signerTrustStatus: "not_evaluated" as const,
    }));
  }

  async version(
    listKey: string,
    sequenceNumber: number,
  ): Promise<VersionDetail | null> {
    const format = this.formatOf(listKey);
    if (format === "xml") {
      const outcome = this.xml.loadVersion(listKey, sequenceNumber);
      if (!outcome.artifacts) return null;
      return {
        format: "xml",
        standard: "TS 119 612",
        sequenceNumber,
        manifest: outcome.artifacts.manifest,
        manifestBytes: outcome.artifacts.manifestBytes,
        xml: outcome.artifacts.xml,
        sha2: outcome.artifacts.sha2,
      };
    }
    const manifest = await this.json.loadManifest(listKey, sequenceNumber);
    if (!manifest) return null;
    return {
      format: "json",
      standard: "TS 119 602",
      sequenceNumber,
      manifest,
    };
  }

  /** The XML artifacts of one version, or null when it is not an XML list. */
  xmlVersion(
    listKey: string,
    sequenceNumber: number,
  ): TrustedListVersionArtifacts | null {
    if (!this.xml.isTrustedListVersion(listKey, sequenceNumber)) return null;
    return this.xml.loadVersion(listKey, sequenceNumber).artifacts;
  }

  /** The latest sequence of an XML list, for the stable `latest` routes. */
  latestXmlSequence(listKey: string): number | null {
    const latest = this.xml.loadLatest(listKey);
    return latest ? latest.sequenceNumber : null;
  }

  inspectorEvaluation(
    listKey: string,
    sequenceNumber: number,
    format: PublicationFormat,
  ): string | null {
    return format === "xml"
      ? this.xml.readInspectorEvaluation(listKey, sequenceNumber)
      : this.json.readInspectorEvaluation(listKey, sequenceNumber);
  }
}
