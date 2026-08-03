/**
 * The administration operations on TS 119 612 applications.
 *
 * Publication is cumulative: a new version is the version that is already
 * published, read back, plus or minus one provider. It is never rebuilt from
 * the application records, because the published list is the authority and a
 * component this publisher did not collect must survive anyway.
 *
 * Two invariants shape everything here:
 *
 * - **Ordinary republication preserves `StatusStartingTime`.** A provider
 *   carried into a new version keeps the instant its status actually began.
 *   This is the opposite of the Annex H rule in the TS 119 602 service, which
 *   restates the time on every version; TS 119 612 keeps permanent history, so
 *   the original instant stays meaningful.
 * - **A status change publishes a new version.** Deprecating or withdrawing
 *   moves the previous state into `ServiceHistory` by `X509SKI`, without the
 *   certificate, and publishes sequence + 1. The version that listed the
 *   service as current is never rewritten.
 */
import { subjectKeyIdentifierBase64 } from "../../model/x509-ski.js";
import { readTrustedList } from "../read.js";
import {
  publishTrustedList,
  evaluatePublishedTrustedList,
} from "../publish.js";
import { getTslProfile } from "../registry.js";
import { MAX_NEXT_UPDATE_MONTHS } from "../constants.js";
import type { TrustedListConfigEntry } from "../list-config.js";
import type { TrustedListStore } from "../../publication/tsl-store.js";
import type { InspectorClient } from "../../inspector/inspector.js";
import type { TrustedListInput, TslProvider, TslService } from "../model.js";
import {
  buildProvider,
  canTransition,
  certificateBase64Der,
  historyInstanceFor,
  publicationInstant,
  servicePublicKeyFingerprint,
  type TslApplicationRecord,
  type TslApplicationState,
} from "./application-model.js";
import type { TslApplicationStore } from "./application-store.js";
import { readFileSync } from "node:fs";

export interface TslServiceResult<T> {
  readonly ok: boolean;
  readonly value?: T;
  readonly error?: string;
  readonly code?: string;
}

function fail<T>(error: string, code = "REFUSED"): TslServiceResult<T> {
  return { ok: false, error, code };
}

function succeed<T>(value: T): TslServiceResult<T> {
  return { ok: true, value };
}

/**
 * The first UTC second at or after `instant` that is strictly later than every
 * time in `earlier`. Used so a status change never shares a second with the
 * state it supersedes.
 */
function strictlyAfter(instant: Date, earlier: readonly string[]): string {
  let candidate = Math.floor(instant.getTime() / 1000) * 1000;
  for (const time of earlier) {
    const parsed = Date.parse(time);
    if (Number.isNaN(parsed)) continue;
    if (candidate <= parsed) candidate = parsed + 1000;
  }
  return publicationInstant(new Date(candidate));
}

/**
 * The result when the immutable version committed but the mutable application
 * record could not be updated. The version exists and is authentic; the
 * application is stale and must be reconciled, never republished.
 */
export interface TslPartialCommit {
  readonly ok: false;
  readonly code: "PUBLICATION_COMMITTED_APPLICATION_STALE";
  readonly error: string;
  readonly listKey: string;
  readonly sequenceNumber: number;
  readonly trustedListXmlSha256: string;
}

export type PublishResult =
  TslServiceResult<TslApplicationRecord> | TslPartialCommit;

export interface TslApplicationServiceConfig {
  readonly applications: TslApplicationStore;
  readonly store: TrustedListStore;
  /** Resolves the configuration of one XML Trusted List by key. */
  readonly trustedListConfig: (
    listKey: string,
  ) => TrustedListConfigEntry | undefined;
  readonly inspector?: InspectorClient;
  /** Base URL recorded as the Inspector's `source`. */
  readonly publicBaseUrl?: string;
  /** Whether this list, or this family, is approved automatically. */
  readonly isAutoApprove?: (family: string, listKey: string) => boolean;
  readonly clock?: () => Date;
}

/** Existing and resulting shape of a cumulative publication, for the preview. */
export interface PublishPreview {
  readonly listKey: string;
  readonly currentSequence: number | null;
  readonly proposedSequence: number;
  readonly existingProviders: number;
  readonly resultingProviders: number;
  readonly existingServices: number;
  readonly resultingServices: number;
}

export class TslApplicationService {
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(private readonly config: TslApplicationServiceConfig) {}

  private now(): Date {
    return this.config.clock ? this.config.clock() : new Date();
  }

  /**
   * Serializes every operation on one list key. Different keys proceed
   * concurrently. This is process-local: it does not protect several Node
   * processes sharing one publication directory.
   */
  private async withListLock<T>(
    listKey: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.locks.get(listKey) ?? Promise.resolve();
    /* The queue continues even when an operation fails, so one failure does
       not wedge the list forever. */
    const next = previous.then(operation, operation);
    this.locks.set(
      listKey,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  submit(record: Omit<TslApplicationRecord, "id">): TslApplicationRecord {
    return this.config.applications.create(record);
  }

  get(id: string): TslApplicationRecord | null {
    return this.config.applications.load(id);
  }

  list(): TslApplicationRecord[] {
    return this.config.applications.list();
  }

  private transition(
    record: TslApplicationRecord,
    to: TslApplicationState,
  ): TslServiceResult<TslApplicationRecord> {
    if (!canTransition(record.state, to))
      return fail(
        `An application in state '${record.state}' cannot move to '${to}'.`,
        "INVALID_TRANSITION",
      );
    return succeed(record);
  }

  approve(id: string, note?: string): TslServiceResult<TslApplicationRecord> {
    const record = this.get(id);
    if (!record) return fail("No such application.", "NOT_FOUND");
    const guard = this.transition(record, "approved");
    if (!guard.ok) return guard;
    const updated: TslApplicationRecord = {
      ...record,
      state: "approved",
      approvedAt: this.now().toISOString(),
      ...(note ? { adminNote: note } : {}),
    };
    this.config.applications.write(updated);
    return succeed(updated);
  }

  reject(id: string, note: string): TslServiceResult<TslApplicationRecord> {
    const record = this.get(id);
    if (!record) return fail("No such application.", "NOT_FOUND");
    const guard = this.transition(record, "rejected");
    if (!guard.ok) return guard;
    const updated: TslApplicationRecord = {
      ...record,
      state: "rejected",
      rejectedAt: this.now().toISOString(),
      adminNote: note,
    };
    this.config.applications.write(updated);
    return succeed(updated);
  }

  delete(id: string): TslServiceResult<true> {
    const record = this.get(id);
    if (!record) return fail("No such application.", "NOT_FOUND");
    if (record.state === "published" || record.state === "superseded")
      return fail(
        "A published application cannot be deleted; its version is immutable.",
        "PUBLISHED",
      );
    this.config.applications.delete(id);
    return succeed(true as const);
  }

  /**
   * The version currently published for a list, read back into the model.
   *
   * Fail-closed: a corrupt highest version blocks preview and publication
   * rather than falling back to an older one, because publishing on top of a
   * version nobody can authenticate would silently drop whatever it held.
   */
  private currentInput(
    listKey: string,
  ): { sequence: number; input: TrustedListInput } | null | { error: string } {
    const highest = this.config.store.getHighestStoredSequence(listKey);
    if (highest === null) return null;
    const outcome = this.config.store.loadVersion(listKey, highest);
    if (!outcome.artifacts)
      return {
        error: `The latest published version (${highest}) of '${listKey}' cannot be authenticated: ${outcome.diagnostic}`,
      };
    try {
      return {
        sequence: highest,
        input: readTrustedList(outcome.artifacts.xml),
      };
    } catch (error) {
      return {
        error: `The latest published version (${highest}) of '${listKey}' could not be read: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  }

  /** Six months after the issue time, the cap clause 5.3.15 sets. */
  private nextUpdateFor(issue: Date): Date {
    const next = new Date(issue);
    next.setUTCMonth(next.getUTCMonth() + MAX_NEXT_UPDATE_MONTHS);
    return next;
  }

  /**
   * Builds the input for the next version: the published one, with every
   * existing provider preserved exactly, plus the candidate.
   */
  private nextInput(
    config: TrustedListConfigEntry,
    current: { sequence: number; input: TrustedListInput } | null,
    issue: Date,
    mutate: (providers: TslProvider[]) => TslProvider[] | { error: string },
  ): { input: TrustedListInput; sequence: number } | { error: string } {
    const issueTime = publicationInstant(issue);
    const nextUpdate = publicationInstant(this.nextUpdateFor(issue));
    const sequence = current ? current.sequence + 1 : 1;

    const existing = current ? [...(current.input.providers ?? [])] : [];
    const mutated = mutate(existing);
    if (!Array.isArray(mutated)) return mutated;

    /*
      Scheme information is restated from the configuration on every version so
      an operator's corrected address or URL reaches the next version. The
      providers, by contrast, are carried through untouched.
    */
    const input: TrustedListInput = {
      schemeInformation: {
        sequenceNumber: sequence,
        schemeTerritory: config.schemeTerritory,
        schemeOperatorName: config.schemeOperatorName,
        schemeOperatorAddress: {
          streetAddress: config.schemeOperatorStreet,
          locality: config.schemeOperatorLocality,
          ...(config.schemeOperatorStateOrProvince
            ? { stateOrProvince: config.schemeOperatorStateOrProvince }
            : {}),
          ...(config.schemeOperatorPostalCode
            ? { postalCode: config.schemeOperatorPostalCode }
            : {}),
          countryName: config.schemeOperatorCountry,
        },
        schemeOperatorElectronicAddress: {
          email: config.schemeOperatorEmail,
          website: config.schemeOperatorWebsite,
          ...(config.schemeOperatorTelephone
            ? { telephone: config.schemeOperatorTelephone }
            : {}),
        },
        schemeName: config.schemeName,
        schemeInformationUri: config.schemeInformationUri,
        nationalSchemeRulesUri: config.nationalSchemeRulesUri,
        policyOrLegalNoticeUri: config.policyUri,
        distributionPointUri: config.distributionPointUri,
        listIssueDateTime: issueTime,
        nextUpdate,
        lotlPointer: {
          location: config.lotlPointer.location,
          certificatesBase64Der: config.lotlPointer.certificatesBase64Der,
          schemeOperatorNames: config.lotlPointer.schemeOperatorNames,
          schemeTypeCommunityRules: config.lotlPointer.schemeTypeCommunityRules,
          schemeTerritory: config.lotlPointer.schemeTerritory,
          tslType: config.lotlPointer.tslType,
          mimeType: config.lotlPointer.mimeType,
        },
      },
      ...(mutated.length > 0 ? { providers: mutated } : {}),
    };
    return { input, sequence };
  }

  /** What the administration shows before an administrator publishes. */
  preview(id: string): TslServiceResult<PublishPreview> {
    const record = this.get(id);
    if (!record) return fail("No such application.", "NOT_FOUND");
    const config = this.config.trustedListConfig(record.listKey);
    if (!config)
      return fail(
        `No XML Trusted List is configured with the key '${record.listKey}'.`,
        "NO_LIST",
      );
    const current = this.currentInput(record.listKey);
    if (current && "error" in current) return fail(current.error, "CORRUPT");

    const existingProviders = current ? (current.input.providers ?? []) : [];
    const existingServices = existingProviders.reduce(
      (total, provider) => total + provider.services.length,
      0,
    );
    const alreadyListed =
      this.findServiceIndex(existingProviders, record) !== null;
    return succeed({
      listKey: record.listKey,
      currentSequence: current ? current.sequence : null,
      proposedSequence: current ? current.sequence + 1 : 1,
      existingProviders: existingProviders.length,
      resultingProviders: alreadyListed
        ? existingProviders.length
        : existingProviders.length + 1,
      existingServices,
      resultingServices: alreadyListed
        ? existingServices
        : existingServices + 1,
    });
  }

  /**
   * Locates a published service by service type and the SHA-256 of its
   * certificate's public key.
   *
   * The name is not the identity: two providers may publish the same service
   * name, and a provider may rename a service. The key is what a relying party
   * actually verifies against.
   */
  private findServiceIndex(
    providers: readonly TslProvider[],
    record: TslApplicationRecord,
  ): { provider: number; service: number } | null {
    const profile = getTslProfile(record.family);
    let fingerprint: string;
    try {
      fingerprint = servicePublicKeyFingerprint(record.certificatePem);
    } catch {
      return null;
    }
    for (const [providerIndex, provider] of providers.entries()) {
      for (const [serviceIndex, service] of provider.services.entries()) {
        if (service.serviceTypeIdentifier !== profile.serviceTypeIdentifier)
          continue;
        const certificate = service.digitalIdentity.x509CertificateBase64Der;
        if (!certificate) continue;
        try {
          const pem = `-----BEGIN CERTIFICATE-----\n${certificate}\n-----END CERTIFICATE-----\n`;
          if (servicePublicKeyFingerprint(pem) === fingerprint)
            return { provider: providerIndex, service: serviceIndex };
        } catch {
          continue;
        }
      }
    }
    return null;
  }

  private signingMaterial(
    config: TrustedListConfigEntry,
  ): { key: string; certificate: string } | { error: string } {
    try {
      return {
        key: readFileSync(config.keyFile, "utf-8"),
        certificate: readFileSync(config.certFile, "utf-8"),
      };
    } catch (error) {
      return {
        error: `The signing material for '${config.listKey}' could not be read: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  }

  /** Publishes an approved application into its Trusted List. */
  async publish(id: string): Promise<PublishResult> {
    const record = this.get(id);
    if (!record) return fail("No such application.", "NOT_FOUND");
    return this.withListLock(record.listKey, async () => {
      const fresh = this.get(id);
      if (!fresh)
        return fail<TslApplicationRecord>("No such application.", "NOT_FOUND");
      const guard = this.transition(fresh, "published");
      if (!guard.ok) return guard;

      const config = this.config.trustedListConfig(fresh.listKey);
      if (!config)
        return fail<TslApplicationRecord>(
          `No XML Trusted List is configured with the key '${fresh.listKey}'.`,
          "NO_LIST",
        );
      const material = this.signingMaterial(config);
      if ("error" in material)
        return fail<TslApplicationRecord>(
          material.error,
          "NO_SIGNING_MATERIAL",
        );

      const current = this.currentInput(fresh.listKey);
      if (current && "error" in current)
        return fail<TslApplicationRecord>(current.error, "CORRUPT");

      const issue = this.now();
      const statusStartingTime = publicationInstant(issue);
      const built = this.nextInput(config, current, issue, (providers) => {
        if (this.findServiceIndex(providers, fresh) !== null)
          return {
            error:
              "This service is already published in the current version: the same service type and the same certificate public key.",
          };
        return [...providers, buildProvider(fresh, config, statusStartingTime)];
      });
      if ("error" in built)
        return fail<TslApplicationRecord>(built.error, "DUPLICATE");

      let published;
      try {
        published = publishTrustedList({
          store: this.config.store,
          listKey: fresh.listKey,
          family: fresh.family,
          input: built.input,
          privateKeyPem: material.key,
          certificatePem: material.certificate,
          publishedAt: issue,
          signingTime: issue,
        });
      } catch (error) {
        return fail<TslApplicationRecord>(
          error instanceof Error ? error.message : String(error),
          "PUBLICATION_FAILED",
        );
      }

      /* The immutable commit has happened. Everything after this point is
         mutable bookkeeping, and a failure there must not be reported as a
         failure to publish. */
      const updated: TslApplicationRecord = {
        ...fresh,
        state: "published",
        publication: {
          listKey: fresh.listKey,
          sequenceNumber: published.sequenceNumber,
          publishedAt: published.manifest.publicationTimestamp,
          trustedListXmlSha256: published.manifest.trustedListXmlSha256,
          serviceStatus: getTslProfile(fresh.family).initialStatus,
          statusStartingTime,
        },
      };
      try {
        this.config.applications.write(updated);
      } catch (error) {
        return {
          ok: false,
          code: "PUBLICATION_COMMITTED_APPLICATION_STALE",
          error: `Version ${published.sequenceNumber} of '${fresh.listKey}' is published and authentic, but the application record could not be updated: ${
            error instanceof Error ? error.message : String(error)
          }`,
          listKey: fresh.listKey,
          sequenceNumber: published.sequenceNumber,
          trustedListXmlSha256: published.manifest.trustedListXmlSha256,
        } satisfies TslPartialCommit;
      }

      await this.evaluate(published);
      return succeed(updated);
    });
  }

  /**
   * Deprecates an EAA service or withdraws a QEAA service.
   *
   * Publishes sequence + 1 with the family's end status; the previous state
   * moves into `ServiceHistory` identified by `X509SKI`, with no
   * `X509Certificate`. The version that listed the service as current stays
   * exactly as published.
   */
  async supersede(id: string): Promise<PublishResult> {
    const record = this.get(id);
    if (!record) return fail("No such application.", "NOT_FOUND");
    return this.withListLock(record.listKey, async () => {
      const fresh = this.get(id);
      if (!fresh)
        return fail<TslApplicationRecord>("No such application.", "NOT_FOUND");
      const guard = this.transition(fresh, "superseded");
      if (!guard.ok) return guard;

      const config = this.config.trustedListConfig(fresh.listKey);
      if (!config)
        return fail<TslApplicationRecord>(
          `No XML Trusted List is configured with the key '${fresh.listKey}'.`,
          "NO_LIST",
        );
      const material = this.signingMaterial(config);
      if ("error" in material)
        return fail<TslApplicationRecord>(
          material.error,
          "NO_SIGNING_MATERIAL",
        );

      const current = this.currentInput(fresh.listKey);
      if (!current)
        return fail<TslApplicationRecord>(
          `'${fresh.listKey}' has no published version to supersede.`,
          "NOT_PUBLISHED",
        );
      if ("error" in current)
        return fail<TslApplicationRecord>(current.error, "CORRUPT");

      const profile = getTslProfile(fresh.family);
      const issue = this.now();

      let skiError: string | null = null;
      let statusStartingTime: string | undefined;
      const built = this.nextInput(config, current, issue, (providers) => {
        const found = this.findServiceIndex(providers, fresh);
        if (found === null)
          return {
            error:
              "This service is not in the current version: no service of this type carries this certificate's public key.",
          };
        const provider = providers[found.provider]!;
        const service = provider.services[found.service]!;

        /*
          Clause 5.6.5, as the Inspector enforces it
          (`ts119612.service.N.history.N.status_start`): the superseded state's
          time must come strictly before the new current one. A list published
          and then ended inside the same second would otherwise state the two
          as equal, which is not an order.

          The lexical form has one-second resolution, so representing "after"
          costs at least a second. The instant is moved forward rather than the
          history moved back: the status change really did happen at or after
          this moment, and the moment the previous status began is a fact that
          must not be rewritten.
        */
        const supersededTimes = [
          service.statusStartingTime,
          ...(service.serviceHistory ?? []).map(
            (instance) => instance.statusStartingTime,
          ),
        ];
        statusStartingTime = strictlyAfter(issue, supersededTimes);

        let ski: string;
        try {
          ski = subjectKeyIdentifierBase64(
            service.digitalIdentity.x509CertificateBase64Der ??
              certificateBase64Der(fresh.certificatePem),
          );
        } catch (error) {
          skiError = error instanceof Error ? error.message : String(error);
          return { error: skiError };
        }

        const superseded: TslService = {
          ...service,
          serviceStatus: profile.endStatus,
          statusStartingTime: statusStartingTime!,
          serviceHistory: [
            /* Most recent superseded state first. */
            historyInstanceFor(service, ski),
            ...(service.serviceHistory ?? []),
          ],
        };
        const services = [...provider.services];
        services[found.service] = superseded;
        const updatedProviders = [...providers];
        updatedProviders[found.provider] = { ...provider, services };
        return updatedProviders;
      });
      if ("error" in built)
        return fail<TslApplicationRecord>(built.error, "NOT_LISTED");

      let published;
      try {
        published = publishTrustedList({
          store: this.config.store,
          listKey: fresh.listKey,
          family: fresh.family,
          input: built.input,
          privateKeyPem: material.key,
          certificatePem: material.certificate,
          publishedAt: issue,
          signingTime: issue,
        });
      } catch (error) {
        return fail<TslApplicationRecord>(
          error instanceof Error ? error.message : String(error),
          "PUBLICATION_FAILED",
        );
      }

      const updated: TslApplicationRecord = {
        ...fresh,
        state: "superseded",
        supersededAt: this.now().toISOString(),
        supersession: {
          listKey: fresh.listKey,
          sequenceNumber: published.sequenceNumber,
          publishedAt: published.manifest.publicationTimestamp,
          trustedListXmlSha256: published.manifest.trustedListXmlSha256,
          serviceStatus: profile.endStatus,
          statusStartingTime: statusStartingTime ?? publicationInstant(issue),
        },
      };
      try {
        this.config.applications.write(updated);
      } catch (error) {
        return {
          ok: false,
          code: "PUBLICATION_COMMITTED_APPLICATION_STALE",
          error: `Version ${published.sequenceNumber} of '${fresh.listKey}' is published and authentic, but the application record could not be updated: ${
            error instanceof Error ? error.message : String(error)
          }`,
          listKey: fresh.listKey,
          sequenceNumber: published.sequenceNumber,
          trustedListXmlSha256: published.manifest.trustedListXmlSha256,
        } satisfies TslPartialCommit;
      }

      await this.evaluate(published);
      return succeed(updated);
    });
  }

  /**
   * Reconciles an application left stale by a partial commit.
   *
   * It updates mutable application metadata to match a version that already
   * exists; it never creates a version. The service must be findable in that
   * version by service type and key fingerprint, or the operation is refused
   * rather than matched by position.
   */
  reconcile(
    id: string,
    sequenceNumber: number,
  ): TslServiceResult<TslApplicationRecord> {
    const record = this.get(id);
    if (!record) return fail("No such application.", "NOT_FOUND");
    const outcome = this.config.store.loadVersion(
      record.listKey,
      sequenceNumber,
    );
    if (!outcome.artifacts)
      return fail(
        `Version ${sequenceNumber} of '${record.listKey}' cannot be authenticated: ${outcome.diagnostic}`,
        "CORRUPT",
      );
    let providers: readonly TslProvider[];
    try {
      providers = readTrustedList(outcome.artifacts.xml).providers ?? [];
    } catch (error) {
      return fail(
        error instanceof Error ? error.message : String(error),
        "CORRUPT",
      );
    }
    const found = this.findServiceIndex(providers, record);
    if (found === null)
      return fail(
        `Version ${sequenceNumber} of '${record.listKey}' carries no service of this type with this certificate's public key, so this application is not the one it published.`,
        "NOT_LISTED",
      );
    const service = providers[found.provider]!.services[found.service]!;
    const profile = getTslProfile(record.family);
    const isEnd = service.serviceStatus === profile.endStatus;
    const publication = {
      listKey: record.listKey,
      sequenceNumber,
      publishedAt: outcome.artifacts.manifest.publicationTimestamp,
      trustedListXmlSha256: outcome.artifacts.manifest.trustedListXmlSha256,
      serviceStatus: service.serviceStatus,
      statusStartingTime: service.statusStartingTime,
    };
    const updated: TslApplicationRecord = isEnd
      ? {
          ...record,
          state: "superseded",
          supersededAt: outcome.artifacts.manifest.publicationTimestamp,
          supersession: publication,
        }
      : { ...record, state: "published", publication };
    this.config.applications.write(updated);
    return succeed(updated);
  }

  /**
   * Applies the auto-approval settings on submission. A failed automatic
   * publication leaves the application in the manual queue and says so; it
   * never reports a plausible-looking success.
   */
  async autoApproveIfEnabled(
    record: TslApplicationRecord,
  ): Promise<{ published: boolean; message?: string }> {
    if (!this.config.isAutoApprove) return { published: false };
    if (!this.config.isAutoApprove(record.family, record.listKey))
      return { published: false };
    const approved = this.approve(record.id, "Approved automatically.");
    if (!approved.ok)
      return {
        published: false,
        message: approved.error ?? "Approval failed.",
      };
    const result = await this.publish(record.id);
    if (result.ok) return { published: true };
    return {
      published: false,
      message:
        "error" in result
          ? result.error
          : "Automatic publication failed; the application is in the manual queue.",
    };
  }

  private async evaluate(
    published: Awaited<ReturnType<typeof publishTrustedList>>,
  ): Promise<void> {
    if (!this.config.inspector) return;
    const base = this.config.publicBaseUrl ?? "";
    const source = `${base}/lists/${published.listKey}/versions/${published.sequenceNumber}`;
    await evaluatePublishedTrustedList(
      this.config.store,
      this.config.inspector,
      published,
      source,
    );
  }
}
