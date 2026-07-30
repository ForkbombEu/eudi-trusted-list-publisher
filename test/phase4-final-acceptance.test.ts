import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash, createPrivateKey, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  ApplicationService,
  AuthoringStore,
  PublicationStore,
  compile,
  loadVersionArtifacts,
  publish,
  resetValidators,
  sign,
  validateEtsiStruct,
  type AuthoringInput,
  type PublishApplicationResult,
  type SigningConfig,
  type SigningConfigEntry,
  type WalletProviderApplication,
} from "../src/core/index.js";
import { createWebServer } from "../src/web/server.js";

const TEST_CLOCK = new Date("2026-08-10T12:00:00.000Z");
const TEST_KEY_PATH = resolve(import.meta.dirname, "fixtures", "test-key.pem");
const TEST_CERT_PATH = resolve(
  import.meta.dirname,
  "fixtures",
  "test-cert.pem",
);
const TEST_CERT_2_PATH = resolve(
  import.meta.dirname,
  "fixtures",
  "test-cert2.pem",
);
const TEST_CERT = readFileSync(TEST_CERT_PATH, "utf-8");
const TEST_CERT_2 = readFileSync(TEST_CERT_2_PATH, "utf-8");

let signingKey: CryptoKey;
const cleanupDirectories = new Set<string>();
const openServers = new Set<Server>();

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: resolvePromise,
    reject: rejectPromise,
  };
}

interface StoreEntry {
  listKey: string;
  sequenceNumber: number;
  priorInjectedFailures: number;
}

interface StoreGate {
  predicate: (listKey: string, sequenceNumber: number) => boolean;
  entered: Deferred<void>;
  release: Deferred<void>;
  failure?: Error;
  used: boolean;
}

class ControlledPublicationStore extends PublicationStore {
  readonly entries: StoreEntry[] = [];
  injectedFailures = 0;
  private readonly gates: StoreGate[] = [];

  blockNext(
    predicate: (listKey: string, sequenceNumber: number) => boolean,
    failure?: Error,
  ): StoreGate {
    const gate: StoreGate = {
      predicate,
      entered: deferred<void>(),
      release: deferred<void>(),
      failure,
      used: false,
    };
    this.gates.push(gate);
    return gate;
  }

  failNext(
    predicate: (listKey: string, sequenceNumber: number) => boolean,
    failure: Error,
  ): void {
    const gate = this.blockNext(predicate, failure);
    gate.release.resolve();
  }

  override async store(
    ...args: Parameters<PublicationStore["store"]>
  ): Promise<{ indexWarning?: string }> {
    const result = args[0];
    this.entries.push({
      listKey: result.listKey,
      sequenceNumber: result.sequenceNumber,
      priorInjectedFailures: this.injectedFailures,
    });

    const gate = this.gates.find(
      (candidate) =>
        !candidate.used &&
        candidate.predicate(result.listKey, result.sequenceNumber),
    );
    if (gate) {
      gate.used = true;
      gate.entered.resolve();
      await gate.release.promise;
      if (gate.failure) {
        this.injectedFailures += 1;
        throw gate.failure;
      }
    }

    return super.store(...args);
  }
}

interface Harness {
  authoringDir: string;
  publicationDir: string;
  authoringStore: AuthoringStore;
  publicationStore: PublicationStore;
  service: ApplicationService;
  signingConfig: SigningConfig;
}

interface ArtifactSnapshot {
  lote: Buffer;
  jades: Buffer;
  manifest: Buffer;
  index: Buffer;
}

interface UnsupportedCase {
  name: string;
  field: string;
  mutate: (document: Record<string, unknown>) => void;
}

beforeAll(async () => {
  resetValidators();
  const privateKey = createPrivateKey(readFileSync(TEST_KEY_PATH, "utf-8"));
  signingKey = (await crypto.subtle.importKey(
    "jwk",
    privateKey.export({ format: "jwk" }) as JsonWebKey,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  )) as CryptoKey;
});

afterEach(async () => {
  for (const server of openServers) {
    await new Promise<void>((resolveClose) => {
      server.close(() => resolveClose());
    });
  }
  openServers.clear();
  for (const directory of cleanupDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  cleanupDirectories.clear();
});

afterAll(() => {
  resetValidators();
});

function temporaryDirectory(prefix: string): string {
  const directory = join(tmpdir(), `${prefix}-${randomUUID()}`);
  mkdirSync(directory, { recursive: true });
  cleanupDirectories.add(directory);
  return directory;
}

function safeName(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, 40)
    .toLowerCase();
}

function listKeyFor(operatorName: string): string {
  return `eu_${safeName(operatorName)}`;
}

function signingEntry(operatorName: string): SigningConfigEntry {
  const listKey = listKeyFor(operatorName);
  return {
    listKey,
    family: "wallet-providers",
    schemeOperatorName: operatorName,
    schemeOperatorStreet: "41 Boundary Street",
    schemeOperatorCountry: "EU",
    schemeName: `${operatorName} Wallet Providers`,
    schemeTerritory: "EU",
    schemeOperatorContactUri: `mailto:${safeName(operatorName)}@example.test`,
    distributionPointUri: `https://${safeName(operatorName)}.example.test/lote.json`,
    keyFile: TEST_KEY_PATH,
    certFile: TEST_CERT_PATH,
    schemeOperatorEmail: "operator@scheme.example",
    schemeOperatorWebsite: "https://scheme.example",
    schemeInformationUris: [
      "https://scheme.example/scheme",
      "https://scheme.example/practice-statement",
    ],
    policyUri: "https://scheme.example/policy",
  };
}

function createHarness(
  operatorNames: string[],
  storeFactory?: (publicationDir: string) => PublicationStore,
): Harness {
  const authoringDir = temporaryDirectory("tlp-phase4-authoring");
  const publicationDir = temporaryDirectory("tlp-phase4-publication");
  const authoringStore = new AuthoringStore({ authoringDir });
  const publicationStore = storeFactory
    ? storeFactory(publicationDir)
    : new PublicationStore({ publicationDir });
  const signingConfig: SigningConfig = {
    lists: operatorNames.map(signingEntry),
  };
  const service = new ApplicationService(
    authoringStore,
    publicationStore,
    signingConfig,
  );
  return {
    authoringDir,
    publicationDir,
    authoringStore,
    publicationStore,
    service,
    signingConfig,
  };
}

function createApprovedApplication(
  store: AuthoringStore,
  listKey: string,
  label: string,
  serviceIdentifiers: string[],
  displayName = `Entity ${label}`,
): WalletProviderApplication {
  const slug = safeName(label);
  const application: WalletProviderApplication = {
    id: store.createId(),
    schemaVersion: 1,
    family: "wallet-providers",
    targetListKey: listKey,
    state: "approved",
    submittedAt: TEST_CLOCK.toISOString(),
    approvedAt: TEST_CLOCK.toISOString(),
    applicantData: {
      entityName: displayName,
      entityTradeName: `${displayName} Trade`,
      entityStreetAddress: `${serviceIdentifiers.length + 10} Test Avenue`,
      entityLocality: "Copenhagen",
      entityPostalCode: "2100",
      entityCountry: "DK",
      entityInformationURI: `https://${slug}.example.test/information`,
      entityEmail: "trust@entity.example",
      entityTelephone: "+39 02 1234567",
      services: serviceIdentifiers.map((identifier, index) => ({
        serviceType: index % 2 === 0 ? "issuance" : "revocation",
        serviceName: `${displayName} Shared Service`,
        certificatePem: TEST_CERT,
        serviceUniqueIdentifier: identifier,
      })),
    },
  };
  store.save(application);
  return application;
}

function expectPublished(
  result: PublishApplicationResult,
): WalletProviderApplication {
  expect(result.success).toBe(true);
  if (!result.success) {
    throw new Error(result.error);
  }
  return result.data;
}

function baseAuthoringInput(
  entry: SigningConfigEntry,
  entity?: AuthoringInput["entities"][number],
): AuthoringInput {
  return {
    schemeOperator: {
      name: [
        { lang: "en", value: entry.schemeOperatorName },
        { lang: "da", value: `${entry.schemeOperatorName} DK` },
      ],
      postalAddress: [
        {
          lang: "en",
          StreetAddress: entry.schemeOperatorStreet,
          Locality: "Brussels",
          StateOrProvince: "Brussels-Capital",
          PostalCode: "1000",
          Country: entry.schemeOperatorCountry,
        },
      ],
      electronicAddress: [
        { lang: "en", uriValue: entry.schemeOperatorContactUri },
      ],
    },
    scheme: {
      schemeName: [
        { lang: "en", value: entry.schemeName },
        { lang: "da", value: `${entry.schemeName} DK` },
      ],
      schemeInformationURI: [
        {
          lang: "en",
          uriValue: `https://${safeName(entry.schemeOperatorName)}.example.test/scheme`,
        },
      ],
      schemeTerritory: entry.schemeTerritory,
      distributionPoints: [entry.distributionPointUri],
    },
    listIssueDateTime: "2026-08-01T09:00:00.000Z",
    nextUpdate: "2027-01-01T09:00:00.000Z",
    loTESequenceNumber: 1,
    entities: [
      entity ?? {
        teName: [
          { lang: "en", value: "Authenticated Matrix Entity" },
          { lang: "da", value: "Autentificeret Matrix Enhed" },
        ],
        teTradeName: [{ lang: "en", value: "Matrix Trade" }],
        tePostalAddress: [
          {
            lang: "en",
            StreetAddress: "77 Matrix Road",
            Locality: "Copenhagen",
            StateOrProvince: "Capital Region",
            PostalCode: "2100",
            Country: "DK",
          },
        ],
        teElectronicAddress: [
          { lang: "en", uriValue: "mailto:matrix@example.test" },
          { lang: "da", uriValue: "https://matrix.example.test/contact" },
        ],
        teInformationURI: [
          { lang: "en", uriValue: "https://matrix.example.test/info/en" },
          { lang: "da", uriValue: "https://matrix.example.test/info/da" },
        ],
        services: [
          {
            serviceTypeIdentifier:
              "http://uri.etsi.org/19602/SvcType/WalletSolution/Issuance",
            serviceName: [
              { lang: "en", value: "Matrix Issuance" },
              { lang: "da", value: "Matrix Udstedelse" },
            ],
            serviceDigitalIdentity: {
              x509Certificates: [TEST_CERT, TEST_CERT_2],
            },
            serviceUniqueIdentifier:
              "https://matrix.example.test/services/issuance",
            serviceSupplyPoints: [
              { uriValue: "https://matrix.example.test/supply/a" },
              { uriValue: "https://matrix.example.test/supply/b" },
            ],
          },
          {
            serviceTypeIdentifier:
              "http://uri.etsi.org/19602/SvcType/WalletSolution/Revocation",
            serviceName: [{ lang: "en", value: "Matrix Revocation" }],
            serviceDigitalIdentity: {
              x509Certificates: [TEST_CERT_2],
            },
            serviceUniqueIdentifier:
              "https://matrix.example.test/services/revocation",
            serviceSupplyPoints: [
              { uriValue: "https://matrix.example.test/supply/revocation" },
            ],
          },
        ],
      },
    ],
  };
}

function firstEntity(
  document: Record<string, unknown>,
): Record<string, unknown> {
  const lote = document["LoTE"] as Record<string, unknown>;
  return (lote["TrustedEntitiesList"] as Record<string, unknown>[])[0]!;
}

function firstService(
  document: Record<string, unknown>,
): Record<string, unknown> {
  const entity = firstEntity(document);
  return (entity["TrustedEntityServices"] as Record<string, unknown>[])[0]!;
}

function firstServiceInformation(
  document: Record<string, unknown>,
): Record<string, unknown> {
  return firstService(document)["ServiceInformation"] as Record<
    string,
    unknown
  >;
}

function firstDigitalIdentity(
  document: Record<string, unknown>,
): Record<string, unknown> {
  return firstServiceInformation(document)["ServiceDigitalIdentity"] as Record<
    string,
    unknown
  >;
}

async function storeAuthenticatedSequenceOne(
  store: PublicationStore,
  entry: SigningConfigEntry,
  mutate?: (document: Record<string, unknown>) => void,
  authoringInput?: AuthoringInput,
): Promise<Record<string, unknown>> {
  const document = compile(authoringInput ?? baseAuthoringInput(entry))
    .document as unknown as Record<string, unknown>;
  mutate?.(document);

  const validation = await validateEtsiStruct(document);
  expect(validation.valid, JSON.stringify(validation.findings)).toBe(true);

  const signed = await sign({
    document: document as never,
    key: signingKey,
    certificatePem: TEST_CERT,
  });
  const publication = await publish({
    compactJws: signed.compact,
    certificatePem: TEST_CERT,
    clock: TEST_CLOCK,
  });
  expect(publication.listKey).toBe(entry.listKey);
  await store.store(
    publication,
    signed.compact,
    publication.loteJson,
    JSON.stringify(publication.manifest, null, 2),
  );

  const authenticated = await loadVersionArtifacts(
    store.publicationDir,
    entry.listKey,
    1,
    10 * 1024 * 1024,
  );
  expect(authenticated.artifacts, authenticated.diagnostic).not.toBeNull();
  return document;
}

function snapshotSequenceOne(
  store: PublicationStore,
  listKey: string,
): ArtifactSnapshot {
  return {
    lote: readFileSync(store.loteJsonPath(listKey, 1)),
    jades: readFileSync(store.loteJadesPath(listKey, 1)),
    manifest: readFileSync(store.manifestPath(listKey, 1)),
    index: readFileSync(store.indexPath(listKey)),
  };
}

function expectSequenceOneUnchanged(
  store: PublicationStore,
  listKey: string,
  snapshot: ArtifactSnapshot,
): void {
  expect(readFileSync(store.loteJsonPath(listKey, 1))).toEqual(snapshot.lote);
  expect(readFileSync(store.loteJadesPath(listKey, 1))).toEqual(snapshot.jades);
  expect(readFileSync(store.manifestPath(listKey, 1))).toEqual(
    snapshot.manifest,
  );
  expect(readFileSync(store.indexPath(listKey))).toEqual(snapshot.index);
}

async function startServer(config: Parameters<typeof createWebServer>[0]) {
  const server = createWebServer(config);
  openServers.add(server);
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = server.address() as AddressInfo;
  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
  };
}

const unsupportedCases: UnsupportedCase[] = [
  {
    name: "ServiceStatus",
    field: "ServiceStatus",
    mutate: (document) => {
      firstServiceInformation(document)["ServiceStatus"] =
        "https://status.example.test/granted";
    },
  },
  {
    name: "StatusStartingTime",
    field: "StatusStartingTime",
    mutate: (document) => {
      firstServiceInformation(document)["StatusStartingTime"] =
        "2026-08-01T00:00:00.000Z";
    },
  },
  {
    name: "ServiceHistory",
    field: "ServiceHistory",
    mutate: (document) => {
      const information = firstServiceInformation(document);
      firstService(document)["ServiceHistory"] = [
        {
          ServiceName: information["ServiceName"],
          ServiceDigitalIdentity: information["ServiceDigitalIdentity"],
          ServiceStatus: "https://status.example.test/withdrawn",
          StatusStartingTime: "2026-07-01T00:00:00.000Z",
          ServiceTypeIdentifier: information["ServiceTypeIdentifier"],
        },
      ];
    },
  },
  {
    name: "X509SubjectNames",
    field: "X509SubjectNames",
    mutate: (document) => {
      firstDigitalIdentity(document)["X509SubjectNames"] = [
        "CN=Unsupported Subject",
      ];
    },
  },
  {
    name: "X509SKIs",
    field: "X509SKIs",
    mutate: (document) => {
      firstDigitalIdentity(document)["X509SKIs"] = ["AQIDBA=="];
    },
  },
  {
    name: "PublicKeyValues",
    field: "PublicKeyValues",
    mutate: (document) => {
      firstDigitalIdentity(document)["PublicKeyValues"] = [
        { kty: "EC", use: "sig", kid: "matrix-key" },
      ];
    },
  },
  {
    name: "OtherIds",
    field: "OtherIds",
    mutate: (document) => {
      firstDigitalIdentity(document)["OtherIds"] = ["matrix-other-id"];
    },
  },
  {
    name: "certificate encoding",
    field: "encoding",
    mutate: (document) => {
      const certificates = firstDigitalIdentity(document)[
        "X509Certificates"
      ] as Record<string, unknown>[];
      certificates[0]!["encoding"] = "https://encoding.example.test/der";
    },
  },
  {
    name: "certificate specRef",
    field: "specRef",
    mutate: (document) => {
      const certificates = firstDigitalIdentity(document)[
        "X509Certificates"
      ] as Record<string, unknown>[];
      certificates[0]!["specRef"] = "matrix-profile-v1";
    },
  },
  {
    name: "SchemeServiceDefinitionURI",
    field: "SchemeServiceDefinitionURI",
    mutate: (document) => {
      firstServiceInformation(document)["SchemeServiceDefinitionURI"] = [
        {
          lang: "en",
          uriValue: "https://matrix.example.test/scheme-definition",
        },
      ];
    },
  },
  {
    name: "ServiceDefinitionURI",
    field: "ServiceDefinitionURI",
    mutate: (document) => {
      firstServiceInformation(document)["ServiceDefinitionURI"] = [
        {
          lang: "en",
          uriValue: "https://matrix.example.test/service-definition",
        },
      ];
    },
  },
  {
    name: "supply-point ServiceType",
    field: "ServiceType",
    mutate: (document) => {
      const information = firstServiceInformation(document);
      const supplyPoints = information["ServiceSupplyPoints"] as Record<
        string,
        unknown
      >[];
      supplyPoints[0]!["ServiceType"] =
        "https://matrix.example.test/supply-type";
    },
  },
  {
    name: "unsupported ServiceInformationExtensions key",
    field: "UnsupportedServiceMarker",
    mutate: (document) => {
      const extensions = firstServiceInformation(document)[
        "ServiceInformationExtensions"
      ] as Record<string, unknown>[];
      extensions[0]!["UnsupportedServiceMarker"] = "must-reject";
    },
  },
  {
    name: "TEInformationExtensions",
    field: "TEInformationExtensions",
    mutate: (document) => {
      const information = firstEntity(document)[
        "TrustedEntityInformation"
      ] as Record<string, unknown>;
      information["TEInformationExtensions"] = [{ AuditMarker: "must-reject" }];
    },
  },
  {
    name: "multiple TEInformationExtensions",
    field: "TEInformationExtensions",
    mutate: (document) => {
      const information = firstEntity(document)[
        "TrustedEntityInformation"
      ] as Record<string, unknown>;
      information["TEInformationExtensions"] = [
        { AuditMarker: "first" },
        { SecondaryMarker: "second" },
      ];
    },
  },
];

describe("Phase 4 primary runtime acceptance", () => {
  it("exposes a typed partial-commit result and reconciles exact metadata", async () => {
    const operator = "Typed Partial Authority";
    const harness = createHarness([operator]);
    const listKey = listKeyFor(operator);
    const application = createApprovedApplication(
      harness.authoringStore,
      listKey,
      "typed-partial",
      ["https://typed-partial.example.test/issuance"],
    );
    const originalSave = harness.authoringStore.save.bind(
      harness.authoringStore,
    );
    harness.authoringStore.save = (candidate) => {
      if (candidate.state === "published") {
        throw new Error("injected published-state save failure");
      }
      originalSave(candidate);
    };

    const result = await harness.service.publishApplication(
      application.id,
      TEST_CLOCK,
    );
    harness.authoringStore.save = originalSave;

    expect(result.success).toBe(false);
    if (result.success || !("code" in result)) {
      throw new Error("Expected a typed partial-commit result");
    }
    const code: "PUBLICATION_COMMITTED_APPLICATION_STALE" = result.code;
    expect(code).toBe("PUBLICATION_COMMITTED_APPLICATION_STALE");
    expect(result.publication.sequenceNumber).toBe(1);

    const authenticated = await loadVersionArtifacts(
      harness.publicationDir,
      listKey,
      1,
      10 * 1024 * 1024,
    );
    expect(authenticated.artifacts, authenticated.diagnostic).not.toBeNull();
    const artifacts = authenticated.artifacts!;
    expect(result.publication).toEqual({
      listKey,
      sequenceNumber: 1,
      manifestSha256: createHash("sha256")
        .update(artifacts.manifestBytes)
        .digest("hex"),
      compactJadesSha256: createHash("sha256")
        .update(artifacts.jadesBytes)
        .digest("hex"),
      publicationTimestamp: artifacts.manifest.publicationTimestamp,
    });
    expect(harness.authoringStore.load(application.id)!.state).toBe("approved");

    const reconciled = await harness.service.reconcileApplication(
      application.id,
    );
    expect(reconciled.success).toBe(true);
    if (!reconciled.success) throw new Error(reconciled.error);
    expect(reconciled.data.publication).toEqual(result.publication);
    expect(
      (await harness.publicationStore.loadIndex(listKey))!.versions.map(
        (version) => version.sequenceNumber,
      ),
    ).toEqual([1]);
  });

  it("LOCK-1 runs the A-cleanup/B-blocked/C-arrives race 20 times", async () => {
    for (let iteration = 0; iteration < 20; iteration += 1) {
      const operator = `Lock Primary ${iteration}`;
      let controlledStore!: ControlledPublicationStore;
      const harness = createHarness([operator], (publicationDir) => {
        controlledStore = new ControlledPublicationStore({ publicationDir });
        return controlledStore;
      });
      const listKey = listKeyFor(operator);
      const gateA = controlledStore.blockNext(
        (key, sequence) => key === listKey && sequence === 1,
      );
      const gateB = controlledStore.blockNext(
        (key, sequence) => key === listKey && sequence === 2,
      );
      const appA = createApprovedApplication(
        harness.authoringStore,
        listKey,
        `lock-a-${iteration}`,
        [`https://lock-primary.example.test/a/${iteration}`],
      );
      const appB = createApprovedApplication(
        harness.authoringStore,
        listKey,
        `lock-b-${iteration}`,
        [`https://lock-primary.example.test/b/${iteration}`],
      );
      const appC = createApprovedApplication(
        harness.authoringStore,
        listKey,
        `lock-c-${iteration}`,
        [`https://lock-primary.example.test/c/${iteration}`],
      );

      const promiseA = harness.service.publishApplication(appA.id, TEST_CLOCK);
      await gateA.entered.promise;
      const promiseB = harness.service.publishApplication(appB.id, TEST_CLOCK);
      expect(controlledStore.entries).toHaveLength(1);

      gateA.release.resolve();
      const resultA = await promiseA;
      expectPublished(resultA);
      await gateB.entered.promise;

      const promiseC = harness.service.publishApplication(appC.id, TEST_CLOCK);
      expect(controlledStore.entries).toHaveLength(2);
      expect(existsSync(controlledStore.versionDir(listKey, 3))).toBe(false);

      gateB.release.resolve();
      const [resultB, resultC] = await Promise.all([promiseB, promiseC]);
      const publishedB = expectPublished(resultB);
      const publishedC = expectPublished(resultC);
      expect(publishedB.publication!.sequenceNumber).toBe(2);
      expect(publishedC.publication!.sequenceNumber).toBe(3);

      const entityCounts: number[] = [];
      for (const sequence of [1, 2, 3]) {
        const document = JSON.parse(
          (await controlledStore.loadVersionBytes(listKey, sequence, "lote"))!,
        );
        entityCounts.push(document.LoTE.TrustedEntitiesList.length);
      }
      expect(entityCounts).toEqual([1, 2, 3]);
      const finalDocument = JSON.parse(
        (await controlledStore.loadVersionBytes(listKey, 3, "lote"))!,
      );
      expect(
        finalDocument.LoTE.TrustedEntitiesList.map(
          (entity: {
            TrustedEntityInformation: {
              TEName: Array<{ value: string }>;
            };
          }) => entity.TrustedEntityInformation.TEName[0]!.value,
        ),
      ).toEqual([
        `Entity lock-a-${iteration}`,
        `Entity lock-b-${iteration}`,
        `Entity lock-c-${iteration}`,
      ]);
    }
  });

  it("LOSSLESS-POS-1 preserves the complete authenticated rich entity", async () => {
    const operator = "Rich Primary Authority";
    const harness = createHarness([operator]);
    const entry = harness.signingConfig.lists[0]!;
    await storeAuthenticatedSequenceOne(harness.publicationStore, entry);
    const entityAtSequenceOne = JSON.parse(
      (await harness.publicationStore.loadVersionBytes(
        entry.listKey,
        1,
        "lote",
      ))!,
    ).LoTE.TrustedEntitiesList[0];

    const candidate = createApprovedApplication(
      harness.authoringStore,
      entry.listKey,
      "rich-primary-b",
      ["https://rich-primary.example.test/b"],
    );
    expectPublished(
      await harness.service.publishApplication(candidate.id, TEST_CLOCK),
    );
    const entityAtSequenceTwo = JSON.parse(
      (await harness.publicationStore.loadVersionBytes(
        entry.listKey,
        2,
        "lote",
      ))!,
    ).LoTE.TrustedEntitiesList[0];
    expect(entityAtSequenceTwo).toEqual(entityAtSequenceOne);
  });

  it("FAILURE-1 injects a pre-commit store failure and releases the lock", async () => {
    const operator = "Failure Boundary Authority";
    let controlledStore!: ControlledPublicationStore;
    const harness = createHarness([operator], (publicationDir) => {
      controlledStore = new ControlledPublicationStore({ publicationDir });
      return controlledStore;
    });
    const listKey = listKeyFor(operator);
    const applicationA = createApprovedApplication(
      harness.authoringStore,
      listKey,
      "failure-a",
      ["https://failure-boundary.example.test/a"],
    );
    expectPublished(
      await harness.service.publishApplication(applicationA.id, TEST_CLOCK),
    );
    const snapshot = snapshotSequenceOne(controlledStore, listKey);

    controlledStore.failNext(
      (key, sequence) => key === listKey && sequence === 2,
      new Error("INJECTED_PRE_COMMIT_STORE_FAILURE"),
    );
    const applicationB = createApprovedApplication(
      harness.authoringStore,
      listKey,
      "failure-b",
      ["https://failure-boundary.example.test/b"],
    );
    const failed = await harness.service.publishApplication(
      applicationB.id,
      TEST_CLOCK,
    );
    expect(failed.success).toBe(false);
    if (!failed.success) {
      expect(failed.error).toContain("INJECTED_PRE_COMMIT_STORE_FAILURE");
    }
    expect(harness.authoringStore.load(applicationB.id)!.state).toBe(
      "approved",
    );
    expect(existsSync(controlledStore.versionDir(listKey, 2))).toBe(false);
    expectSequenceOneUnchanged(controlledStore, listKey, snapshot);

    const applicationC = createApprovedApplication(
      harness.authoringStore,
      listKey,
      "failure-c",
      ["https://failure-boundary.example.test/c"],
    );
    const publishedC = expectPublished(
      await harness.service.publishApplication(applicationC.id, TEST_CLOCK),
    );
    expect(publishedC.publication!.sequenceNumber).toBe(2);
  });
});

describe("Phase 4 adversarial acceptance suite", () => {
  it("LOCK-2 fails a blocked middle store operation and runs C next (20 iterations)", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      for (let iteration = 0; iteration < 20; iteration += 1) {
        const operator = `Lock Adversarial ${iteration}`;
        let controlledStore!: ControlledPublicationStore;
        const harness = createHarness([operator], (publicationDir) => {
          controlledStore = new ControlledPublicationStore({ publicationDir });
          return controlledStore;
        });
        const listKey = listKeyFor(operator);
        const appA = createApprovedApplication(
          harness.authoringStore,
          listKey,
          `failed-middle-a-${iteration}`,
          [`https://failed-middle.example.test/a/${iteration}`],
        );
        expectPublished(
          await harness.service.publishApplication(appA.id, TEST_CLOCK),
        );

        const gateB = controlledStore.blockNext(
          (key, sequence) => key === listKey && sequence === 2,
          new Error(`INJECTED_MIDDLE_STORE_FAILURE_${iteration}`),
        );
        const appB = createApprovedApplication(
          harness.authoringStore,
          listKey,
          `failed-middle-b-${iteration}`,
          [`https://failed-middle.example.test/b/${iteration}`],
        );
        const appC = createApprovedApplication(
          harness.authoringStore,
          listKey,
          `failed-middle-c-${iteration}`,
          [`https://failed-middle.example.test/c/${iteration}`],
        );
        const promiseB = harness.service.publishApplication(
          appB.id,
          TEST_CLOCK,
        );
        await gateB.entered.promise;
        const promiseC = harness.service.publishApplication(
          appC.id,
          TEST_CLOCK,
        );
        expect(controlledStore.entries).toHaveLength(2);

        gateB.release.resolve();
        const resultB = await promiseB;
        expect(resultB.success).toBe(false);
        if (!resultB.success) {
          expect(resultB.error).toContain(
            `INJECTED_MIDDLE_STORE_FAILURE_${iteration}`,
          );
        }
        expect(harness.authoringStore.load(appB.id)!.state).toBe("approved");
        expect(existsSync(controlledStore.versionDir(listKey, 2))).toBe(false);

        const resultC = await promiseC;
        const publishedC = expectPublished(resultC);
        expect(publishedC.publication!.sequenceNumber).toBe(2);
        expect(
          controlledStore.entries[2]!.priorInjectedFailures,
        ).toBeGreaterThanOrEqual(1);
        const document = JSON.parse(
          (await controlledStore.loadVersionBytes(listKey, 2, "lote"))!,
        );
        expect(
          document.LoTE.TrustedEntitiesList.map(
            (entity: {
              TrustedEntityInformation: {
                TEName: Array<{ value: string }>;
              };
            }) => entity.TrustedEntityInformation.TEName[0]!.value,
          ),
        ).toEqual([
          `Entity failed-middle-a-${iteration}`,
          `Entity failed-middle-c-${iteration}`,
        ]);
      }
      await Promise.resolve();
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("different lists progress independently while one store call is blocked", async () => {
    const operatorA = "Independent Blocked Authority";
    const operatorB = "Independent Free Authority";
    let controlledStore!: ControlledPublicationStore;
    const harness = createHarness(
      [operatorA, operatorB],
      (publicationDirectory) => {
        controlledStore = new ControlledPublicationStore({
          publicationDir: publicationDirectory,
        });
        return controlledStore;
      },
    );
    const listA = listKeyFor(operatorA);
    const listB = listKeyFor(operatorB);
    const gateA = controlledStore.blockNext(
      (key, sequence) => key === listA && sequence === 1,
    );
    const appA = createApprovedApplication(
      harness.authoringStore,
      listA,
      "independent-blocked",
      ["https://independent.example.test/blocked"],
    );
    const appB = createApprovedApplication(
      harness.authoringStore,
      listB,
      "independent-free",
      ["https://independent.example.test/free"],
    );

    const promiseA = harness.service.publishApplication(appA.id, TEST_CLOCK);
    await gateA.entered.promise;
    const resultB = await harness.service.publishApplication(
      appB.id,
      TEST_CLOCK,
    );
    const publishedB = expectPublished(resultB);
    expect(publishedB.publication!.sequenceNumber).toBe(1);
    expect(existsSync(controlledStore.versionDir(listA, 1))).toBe(false);
    expect(existsSync(controlledStore.versionDir(listB, 1))).toBe(true);

    gateA.release.resolve();
    const publishedA = expectPublished(await promiseA);
    expect(publishedA.publication!.sequenceNumber).toBe(1);
  });

  it("repeats the controlled A-cleanup/B-blocked/C-arrives interleaving with adversarial fixtures", async () => {
    const operator = "Adversarial Three Way Authority";
    let controlledStore!: ControlledPublicationStore;
    const harness = createHarness([operator], (publicationDirectory) => {
      controlledStore = new ControlledPublicationStore({
        publicationDir: publicationDirectory,
      });
      return controlledStore;
    });
    const listKey = listKeyFor(operator);
    const gateA = controlledStore.blockNext(
      (key, sequence) => key === listKey && sequence === 1,
    );
    const gateB = controlledStore.blockNext(
      (key, sequence) => key === listKey && sequence === 2,
    );
    const applications = ["north", "middle", "south"].map((label) =>
      createApprovedApplication(
        harness.authoringStore,
        listKey,
        `adversarial-three-way-${label}`,
        [`https://adversarial-three-way.example.test/${label}`],
      ),
    );

    const promiseA = harness.service.publishApplication(
      applications[0]!.id,
      new Date("2026-12-01T10:00:00.000Z"),
    );
    await gateA.entered.promise;
    const promiseB = harness.service.publishApplication(
      applications[1]!.id,
      new Date("2026-12-01T10:00:01.000Z"),
    );
    expect(controlledStore.entries).toHaveLength(1);

    gateA.release.resolve();
    expect(expectPublished(await promiseA).publication!.sequenceNumber).toBe(1);
    await gateB.entered.promise;
    const promiseC = harness.service.publishApplication(
      applications[2]!.id,
      new Date("2026-12-01T10:00:02.000Z"),
    );
    expect(controlledStore.entries).toHaveLength(2);
    expect(existsSync(controlledStore.versionDir(listKey, 3))).toBe(false);

    gateB.release.resolve();
    const [publishedB, publishedC] = (
      await Promise.all([promiseB, promiseC])
    ).map(expectPublished);
    expect(publishedB!.publication!.sequenceNumber).toBe(2);
    expect(publishedC!.publication!.sequenceNumber).toBe(3);
    const finalDocument = JSON.parse(
      (await controlledStore.loadVersionBytes(listKey, 3, "lote"))!,
    );
    expect(
      finalDocument.LoTE.TrustedEntitiesList.map(
        (entity: {
          TrustedEntityInformation: { TEName: Array<{ value: string }> };
        }) => entity.TrustedEntityInformation.TEName[0]!.value,
      ),
    ).toEqual([
      "Entity adversarial-three-way-north",
      "Entity adversarial-three-way-middle",
      "Entity adversarial-three-way-south",
    ]);
  });

  it("injects a second pre-commit store failure without changing the existing publication", async () => {
    const operator = "Adversarial Precommit Authority";
    let controlledStore!: ControlledPublicationStore;
    const harness = createHarness([operator], (publicationDirectory) => {
      controlledStore = new ControlledPublicationStore({
        publicationDir: publicationDirectory,
      });
      return controlledStore;
    });
    const listKey = listKeyFor(operator);
    const existing = createApprovedApplication(
      harness.authoringStore,
      listKey,
      "adversarial-precommit-existing",
      ["https://adversarial-precommit.example.test/existing"],
    );
    expectPublished(
      await harness.service.publishApplication(
        existing.id,
        new Date("2026-12-02T11:00:00.000Z"),
      ),
    );
    const snapshot = snapshotSequenceOne(controlledStore, listKey);
    controlledStore.failNext(
      (key, sequence) => key === listKey && sequence === 2,
      new Error("ADVERSARIAL_PRE_COMMIT_BOUNDARY_FAILURE"),
    );
    const rejected = createApprovedApplication(
      harness.authoringStore,
      listKey,
      "adversarial-precommit-rejected",
      ["https://adversarial-precommit.example.test/rejected"],
    );
    const failed = await harness.service.publishApplication(
      rejected.id,
      new Date("2026-12-02T11:00:01.000Z"),
    );
    expect(failed.success).toBe(false);
    if (!failed.success) {
      expect(failed.error).toContain("ADVERSARIAL_PRE_COMMIT_BOUNDARY_FAILURE");
    }
    expect(harness.authoringStore.load(rejected.id)!.state).toBe("approved");
    expect(existsSync(controlledStore.versionDir(listKey, 2))).toBe(false);
    expectSequenceOneUnchanged(controlledStore, listKey, snapshot);

    const successor = createApprovedApplication(
      harness.authoringStore,
      listKey,
      "adversarial-precommit-successor",
      ["https://adversarial-precommit.example.test/successor"],
    );
    expect(
      expectPublished(
        await harness.service.publishApplication(
          successor.id,
          new Date("2026-12-02T11:00:02.000Z"),
        ),
      ).publication!.sequenceNumber,
    ).toBe(2);
  });

  it("returns and reconciles a second post-commit application-save failure", async () => {
    const operator = "Adversarial Postcommit Authority";
    const harness = createHarness([operator]);
    const listKey = listKeyFor(operator);
    const application = createApprovedApplication(
      harness.authoringStore,
      listKey,
      "adversarial-postcommit",
      ["https://adversarial-postcommit.example.test/service"],
    );
    const originalSave = harness.authoringStore.save.bind(
      harness.authoringStore,
    );
    harness.authoringStore.save = (candidate) => {
      if (candidate.state === "published") {
        throw new Error("ADVERSARIAL_POST_COMMIT_APPLICATION_SAVE_FAILURE");
      }
      originalSave(candidate);
    };

    const result = await harness.service.publishApplication(
      application.id,
      new Date("2026-12-03T12:13:14.000Z"),
    );
    harness.authoringStore.save = originalSave;
    expect(result.success).toBe(false);
    if (result.success || !("code" in result)) {
      throw new Error("Expected adversarial partial-commit result");
    }
    expect(result.code).toBe("PUBLICATION_COMMITTED_APPLICATION_STALE");
    expect(result.error).toBe(
      `Immutable publication succeeded for list key "${listKey}" sequence 1 but the application record could not be updated. Run reconciliation to repair.`,
    );
    expect(result.publication.sequenceNumber).toBe(1);
    expect(harness.authoringStore.load(application.id)!.state).toBe("approved");
    expect(
      (await harness.publicationStore.loadIndex(listKey))!.versions,
    ).toHaveLength(1);

    const reconciliation = await harness.service.reconcileApplication(
      application.id,
    );
    expect(reconciliation.success).toBe(true);
    if (!reconciliation.success) throw new Error(reconciliation.error);
    expect(reconciliation.data.publication).toEqual(result.publication);
    expect(
      (await harness.publicationStore.loadIndex(listKey))!.versions,
    ).toHaveLength(1);
  });

  it.each(unsupportedCases)(
    "rejects authenticated unsupported field: $name",
    async ({ field, mutate }) => {
      const operator = `Unsupported ${safeName(field)} ${randomUUID().slice(0, 8)}`;
      const harness = createHarness([operator]);
      const entry = harness.signingConfig.lists[0]!;
      await storeAuthenticatedSequenceOne(
        harness.publicationStore,
        entry,
        mutate,
      );
      const snapshot = snapshotSequenceOne(
        harness.publicationStore,
        entry.listKey,
      );
      const candidate = createApprovedApplication(
        harness.authoringStore,
        entry.listKey,
        `unsupported-${safeName(field)}`,
        [`https://unsupported.example.test/${safeName(field)}/${randomUUID()}`],
      );

      const preview = await harness.service.preview(candidate, TEST_CLOCK);
      expect(preview.error).toContain(field);
      const result = await harness.service.publishApplication(
        candidate.id,
        TEST_CLOCK,
      );
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain(field);
        expect(result.error).toBe(preview.error);
      }
      expect(
        existsSync(harness.publicationStore.versionDir(entry.listKey, 2)),
      ).toBe(false);
      expectSequenceOneUnchanged(
        harness.publicationStore,
        entry.listKey,
        snapshot,
      );
    },
  );

  it("rejects duplicate candidate identifiers with the exact identifier", async () => {
    const operator = "Adversarial Duplicate Candidate";
    const harness = createHarness([operator]);
    const listKey = listKeyFor(operator);
    const duplicate =
      "https://adversarial-duplicate.example.test/services/shared";
    const candidate = createApprovedApplication(
      harness.authoringStore,
      listKey,
      "adversarial-duplicate",
      [duplicate, duplicate],
    );
    const result = await harness.service.publishApplication(
      candidate.id,
      TEST_CLOCK,
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe(`DUPLICATE_IDENTIFIER: ${duplicate}`);
    }
    expect(existsSync(harness.publicationStore.versionDir(listKey, 1))).toBe(
      false,
    );
  });

  it("rejects a conflict with an existing entity's second service without writes", async () => {
    const operator = "Adversarial Existing Second Service";
    const harness = createHarness([operator]);
    const listKey = listKeyFor(operator);
    const shared = "https://adversarial-existing.example.test/services/second";
    const existing = createApprovedApplication(
      harness.authoringStore,
      listKey,
      "existing-two-services",
      ["https://adversarial-existing.example.test/services/first", shared],
    );
    expectPublished(
      await harness.service.publishApplication(existing.id, TEST_CLOCK),
    );
    const snapshot = snapshotSequenceOne(harness.publicationStore, listKey);
    const candidate = createApprovedApplication(
      harness.authoringStore,
      listKey,
      "candidate-conflict-second",
      ["https://adversarial-existing.example.test/services/new", shared],
    );
    const result = await harness.service.publishApplication(
      candidate.id,
      TEST_CLOCK,
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe(`DUPLICATE_IDENTIFIER: ${shared}`);
    }
    expect(existsSync(harness.publicationStore.versionDir(listKey, 2))).toBe(
      false,
    );
    expectSequenceOneUnchanged(harness.publicationStore, listKey, snapshot);
  });

  it("rejects partial and cross-entity reconciliation matches precisely", async () => {
    const operator = "Adversarial Reconciliation Authority";
    const harness = createHarness([operator]);
    const listKey = listKeyFor(operator);
    const first = createApprovedApplication(
      harness.authoringStore,
      listKey,
      "reconcile-first",
      [
        "https://adversarial-reconcile.example.test/a",
        "https://adversarial-reconcile.example.test/b",
      ],
    );
    const second = createApprovedApplication(
      harness.authoringStore,
      listKey,
      "reconcile-second",
      ["https://adversarial-reconcile.example.test/c"],
    );
    expectPublished(
      await harness.service.publishApplication(first.id, TEST_CLOCK),
    );
    expectPublished(
      await harness.service.publishApplication(second.id, TEST_CLOCK),
    );

    for (const identifiers of [
      ["https://adversarial-reconcile.example.test/a"],
      [
        "https://adversarial-reconcile.example.test/a",
        "https://adversarial-reconcile.example.test/c",
      ],
    ]) {
      const candidate = createApprovedApplication(
        harness.authoringStore,
        listKey,
        `reconcile-rejected-${identifiers.length}-${randomUUID()}`,
        identifiers,
      );
      const result = await harness.service.reconcileApplication(candidate.id);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe(
          "Reconciliation failed: no published entity exactly matches all candidate service identifiers.",
        );
      }
      expect(
        (await harness.publicationStore.loadIndex(listKey))!.versions.map(
          (version) => version.sequenceNumber,
        ),
      ).toEqual([1, 2]);
    }
  });

  it("fails closed on a corrupt highest sequence and preserves the healthy version", async () => {
    const operator = "Adversarial Corrupt Highest";
    const harness = createHarness([operator]);
    const listKey = listKeyFor(operator);
    const first = createApprovedApplication(
      harness.authoringStore,
      listKey,
      "corrupt-highest-a",
      ["https://corrupt-highest.example.test/a"],
    );
    expectPublished(
      await harness.service.publishApplication(first.id, TEST_CLOCK),
    );
    const snapshot = snapshotSequenceOne(harness.publicationStore, listKey);
    const corruptDirectory = harness.publicationStore.versionDir(listKey, 2);
    mkdirSync(corruptDirectory, { recursive: true });
    writeFileSync(join(corruptDirectory, "lote.json"), '{"corrupt":true}');
    writeFileSync(join(corruptDirectory, "lote.jades"), "corrupt.jades.value");
    writeFileSync(join(corruptDirectory, "manifest.json"), '{"corrupt":true}');

    const candidate = createApprovedApplication(
      harness.authoringStore,
      listKey,
      "corrupt-highest-b",
      ["https://corrupt-highest.example.test/b"],
    );
    const preview = await harness.service.preview(candidate, TEST_CLOCK);
    expect(preview.error).toContain("sequence 2");
    expect(preview.error).toContain("corrupt or unauthenticated");
    const result = await harness.service.publishApplication(
      candidate.id,
      TEST_CLOCK,
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe(preview.error);
    }
    expect(existsSync(harness.publicationStore.versionDir(listKey, 3))).toBe(
      false,
    );
    expectSequenceOneUnchanged(harness.publicationStore, listKey, snapshot);
    expect(
      (await harness.publicationStore.loadIndex(listKey))!.versions.map(
        (version) => version.sequenceNumber,
      ),
    ).toEqual([1]);
  });
});

describe("Phase 4 alternate positive acceptance suite", () => {
  it("preserves a different rich entity and progresses to four cumulative entities", async () => {
    const operator = "Alternate Rich Authority";
    const harness = createHarness([operator]);
    const entry = harness.signingConfig.lists[0]!;
    const alternateRichEntity: AuthoringInput["entities"][number] = {
      teName: [
        { lang: "en", value: "Alternate Northern Wallet" },
        { lang: "sv", value: "Alternativ Nordlig Plånbok" },
      ],
      teTradeName: [{ lang: "sv", value: "Nord Wallet" }],
      tePostalAddress: [
        {
          lang: "sv",
          StreetAddress: "8 Hamngatan",
          Locality: "Malmö",
          StateOrProvince: "Skåne",
          PostalCode: "21120",
          Country: "SE",
        },
        {
          lang: "en",
          StreetAddress: "9 Harbour Lane",
          Locality: "Malmö",
          StateOrProvince: "Skåne County",
          PostalCode: "21121",
          Country: "SE",
        },
      ],
      teElectronicAddress: [
        { lang: "sv", uriValue: "mailto:nord@example.test" },
        { lang: "en", uriValue: "https://nord.example.test/contact" },
      ],
      teInformationURI: [
        { lang: "sv", uriValue: "https://nord.example.test/sv" },
        { lang: "en", uriValue: "https://nord.example.test/en" },
      ],
      services: [
        {
          serviceTypeIdentifier:
            "http://uri.etsi.org/19602/SvcType/WalletSolution/Issuance",
          serviceName: [{ lang: "sv", value: "Nord Utdelning" }],
          serviceDigitalIdentity: { x509Certificates: [TEST_CERT] },
          serviceUniqueIdentifier:
            "https://nord.example.test/services/issuance",
          serviceSupplyPoints: [
            { uriValue: "https://nord.example.test/supply/issuance" },
          ],
        },
        {
          serviceTypeIdentifier:
            "http://uri.etsi.org/19602/SvcType/WalletSolution/Revocation",
          serviceName: [{ lang: "sv", value: "Nord Återkallelse" }],
          serviceDigitalIdentity: {
            x509Certificates: [TEST_CERT, TEST_CERT_2],
          },
          serviceUniqueIdentifier:
            "https://nord.example.test/services/revocation",
          serviceSupplyPoints: [
            { uriValue: "https://nord.example.test/supply/revocation/a" },
            { uriValue: "https://nord.example.test/supply/revocation/b" },
          ],
        },
        {
          serviceTypeIdentifier:
            "http://uri.etsi.org/19602/SvcType/WalletSolution/Issuance",
          serviceName: [{ lang: "en", value: "Nord Backup Issuance" }],
          serviceDigitalIdentity: { x509Certificates: [TEST_CERT_2] },
          serviceUniqueIdentifier: "https://nord.example.test/services/backup",
        },
      ],
    };
    const alternateInput = baseAuthoringInput(entry, alternateRichEntity);
    alternateInput.listIssueDateTime = "2026-08-05T06:30:00.000Z";
    alternateInput.nextUpdate = "2027-01-15T06:30:00.000Z";
    await storeAuthenticatedSequenceOne(
      harness.publicationStore,
      entry,
      undefined,
      alternateInput,
    );
    const richAtOne = JSON.parse(
      (await harness.publicationStore.loadVersionBytes(
        entry.listKey,
        1,
        "lote",
      ))!,
    ).LoTE.TrustedEntitiesList[0];

    for (let sequence = 2; sequence <= 4; sequence += 1) {
      const candidate = createApprovedApplication(
        harness.authoringStore,
        entry.listKey,
        `alternate-sequence-${sequence}`,
        [`https://alternate-sequence.example.test/${sequence}`],
      );
      const published = expectPublished(
        await harness.service.publishApplication(
          candidate.id,
          new Date(`2026-08-${10 + sequence}T07:00:00.000Z`),
        ),
      );
      expect(published.publication!.sequenceNumber).toBe(sequence);
      const document = JSON.parse(
        (await harness.publicationStore.loadVersionBytes(
          entry.listKey,
          sequence,
          "lote",
        ))!,
      );
      expect(document.LoTE.TrustedEntitiesList).toHaveLength(sequence);
      expect(document.LoTE.TrustedEntitiesList[0]).toEqual(richAtOne);
    }
  });

  it("serializes a different controlled three-publication queue", async () => {
    const operator = "Alternate Queue Authority";
    let controlledStore!: ControlledPublicationStore;
    const harness = createHarness([operator], (publicationDirectory) => {
      controlledStore = new ControlledPublicationStore({
        publicationDir: publicationDirectory,
      });
      return controlledStore;
    });
    const listKey = listKeyFor(operator);
    const firstGate = controlledStore.blockNext(
      (key, sequence) => key === listKey && sequence === 1,
    );
    const applications = ["delta", "epsilon", "zeta"].map((label) =>
      createApprovedApplication(
        harness.authoringStore,
        listKey,
        `alternate-${label}`,
        [`https://alternate-queue.example.test/${label}`],
      ),
    );
    const promises = [
      harness.service.publishApplication(applications[0]!.id, TEST_CLOCK),
    ];
    await firstGate.entered.promise;
    promises.push(
      harness.service.publishApplication(applications[1]!.id, TEST_CLOCK),
      harness.service.publishApplication(applications[2]!.id, TEST_CLOCK),
    );
    expect(controlledStore.entries).toHaveLength(1);
    firstGate.release.resolve();
    const results = await Promise.all(promises);
    expect(
      results.map(
        (result) => expectPublished(result).publication!.sequenceNumber,
      ),
    ).toEqual([1, 2, 3]);
  });

  it("lets a different alternate list finish while the first list is blocked", async () => {
    const blockedOperator = "Alternate Independent North";
    const freeOperator = "Alternate Independent South";
    let controlledStore!: ControlledPublicationStore;
    const harness = createHarness(
      [blockedOperator, freeOperator],
      (publicationDirectory) => {
        controlledStore = new ControlledPublicationStore({
          publicationDir: publicationDirectory,
        });
        return controlledStore;
      },
    );
    const blockedList = listKeyFor(blockedOperator);
    const freeList = listKeyFor(freeOperator);
    const blockedGate = controlledStore.blockNext(
      (key, sequence) => key === blockedList && sequence === 1,
    );
    const blockedApplication = createApprovedApplication(
      harness.authoringStore,
      blockedList,
      "alternate-independent-north",
      ["https://alternate-independent.example.test/north"],
    );
    const freeApplication = createApprovedApplication(
      harness.authoringStore,
      freeList,
      "alternate-independent-south",
      ["https://alternate-independent.example.test/south"],
    );

    const blockedPromise = harness.service.publishApplication(
      blockedApplication.id,
      new Date("2026-11-01T08:00:00.000Z"),
    );
    await blockedGate.entered.promise;
    const freePublished = expectPublished(
      await harness.service.publishApplication(
        freeApplication.id,
        new Date("2026-11-01T08:00:01.000Z"),
      ),
    );
    expect(freePublished.publication!.sequenceNumber).toBe(1);
    expect(existsSync(controlledStore.versionDir(blockedList, 1))).toBe(false);
    expect(existsSync(controlledStore.versionDir(freeList, 1))).toBe(true);

    blockedGate.release.resolve();
    const blockedPublished = expectPublished(await blockedPromise);
    expect(blockedPublished.publication!.sequenceNumber).toBe(1);
  });

  it("allows one identifier across list keys and one display name within a list", async () => {
    const operatorA = "Alternate Scope Alpha";
    const operatorB = "Alternate Scope Beta";
    const harness = createHarness([operatorA, operatorB]);
    const listA = listKeyFor(operatorA);
    const listB = listKeyFor(operatorB);
    const sharedIdentifier =
      "https://alternate-scope.example.test/shared-identifier";
    const sharedName = "Alternate Shared Display Name";
    const applications = [
      createApprovedApplication(
        harness.authoringStore,
        listA,
        "scope-alpha-shared",
        [sharedIdentifier],
        sharedName,
      ),
      createApprovedApplication(
        harness.authoringStore,
        listB,
        "scope-beta-shared",
        [sharedIdentifier],
        sharedName,
      ),
      createApprovedApplication(
        harness.authoringStore,
        listA,
        "scope-alpha-distinct",
        ["https://alternate-scope.example.test/distinct"],
        sharedName,
      ),
    ];
    for (const application of applications) {
      expectPublished(
        await harness.service.publishApplication(application.id, TEST_CLOCK),
      );
    }
    expect(
      JSON.parse(
        (await harness.publicationStore.loadVersionBytes(listA, 2, "lote"))!,
      ).LoTE.TrustedEntitiesList,
    ).toHaveLength(2);
    expect(
      JSON.parse(
        (await harness.publicationStore.loadVersionBytes(listB, 1, "lote"))!,
      ).LoTE.TrustedEntitiesList,
    ).toHaveLength(1);
  });

  it("alternate fixed-clock preview deep-equals the stored publication", async () => {
    const operator = "Alternate Preview Authority";
    const harness = createHarness([operator]);
    const listKey = listKeyFor(operator);
    const first = createApprovedApplication(
      harness.authoringStore,
      listKey,
      "alternate-preview-a",
      ["https://alternate-preview.example.test/a"],
    );
    expectPublished(
      await harness.service.publishApplication(
        first.id,
        new Date("2026-09-01T05:45:00.000Z"),
      ),
    );
    const second = createApprovedApplication(
      harness.authoringStore,
      listKey,
      "alternate-preview-b",
      ["https://alternate-preview.example.test/b"],
    );
    const alternateClock = new Date("2026-09-02T17:25:30.000Z");
    const preview = await harness.service.preview(second, alternateClock);
    expect(preview.compilerInput).not.toBeNull();
    const published = expectPublished(
      await harness.service.publishApplication(second.id, alternateClock),
    );
    const stored = JSON.parse(
      (await harness.publicationStore.loadVersionBytes(
        listKey,
        published.publication!.sequenceNumber,
        "lote",
      ))!,
    );
    expect(stored).toEqual(compile(preview.compilerInput!).document);
  });

  it("reconciles a second typed partial commit without creating a version", async () => {
    const operator = "Alternate Partial Authority";
    const harness = createHarness([operator]);
    const listKey = listKeyFor(operator);
    const application = createApprovedApplication(
      harness.authoringStore,
      listKey,
      "alternate-partial",
      ["https://alternate-partial.example.test/service"],
    );
    const originalSave = harness.authoringStore.save.bind(
      harness.authoringStore,
    );
    harness.authoringStore.save = (candidate) => {
      if (candidate.state === "published") {
        throw new Error("alternate injected authoring failure");
      }
      originalSave(candidate);
    };
    const result = await harness.service.publishApplication(
      application.id,
      new Date("2026-10-03T03:04:05.000Z"),
    );
    harness.authoringStore.save = originalSave;
    if (result.success || !("code" in result)) {
      throw new Error("Expected alternate partial commit");
    }
    expect(result.code).toBe("PUBLICATION_COMMITTED_APPLICATION_STALE");
    const reconciliation = await harness.service.reconcileApplication(
      application.id,
    );
    expect(reconciliation.success).toBe(true);
    if (!reconciliation.success) throw new Error(reconciliation.error);
    expect(reconciliation.data.publication).toEqual(result.publication);
    expect(
      (await harness.publicationStore.loadIndex(listKey))!.versions,
    ).toHaveLength(1);
  });
});

describe("Phase 4 rendered cumulative preview", () => {
  it("renders cumulative counts and sequences through the authenticated HTTP route", async () => {
    const operator = "Rendered Preview Authority";
    const harness = createHarness([operator]);
    const entry = harness.signingConfig.lists[0]!;
    const first = createApprovedApplication(
      harness.authoringStore,
      entry.listKey,
      "rendered-preview-a",
      ["https://rendered-preview.example.test/a"],
    );
    expectPublished(
      await harness.service.publishApplication(first.id, TEST_CLOCK),
    );
    const second = createApprovedApplication(
      harness.authoringStore,
      entry.listKey,
      "rendered-preview-b",
      ["https://rendered-preview.example.test/b"],
    );

    const configDirectory = temporaryDirectory("tlp-phase4-web-config");
    const signingConfigPath = join(configDirectory, "signing-config.json");
    writeFileSync(
      signingConfigPath,
      JSON.stringify(harness.signingConfig, null, 2),
    );
    const { url } = await startServer({
      publicationDir: harness.publicationDir,
      dataCollectionGui: true,
      authoringDir: harness.authoringDir,
      adminToken: "phase4-http-preview-token",
      signingConfigPath,
    });
    const login = await fetch(`${url}/admin?token=phase4-http-preview-token`, {
      redirect: "manual",
    });
    expect(login.status).toBe(303);
    const cookie = login.headers.get("set-cookie");
    expect(cookie).not.toBeNull();
    const detail = await fetch(`${url}/admin/applications/${second.id}`, {
      headers: { Cookie: cookie!.split(";")[0]! },
    });
    expect(detail.status).toBe(200);
    const html = await detail.text();
    expect(html).toMatch(/<th>Existing Entities<\/th><td>1<\/td>/);
    expect(html).toMatch(/<th>Resulting Entities<\/th><td>2<\/td>/);
    expect(html).toMatch(/<th>Current Sequence<\/th><td>1<\/td>/);
    expect(html).toMatch(/<th>Proposed Sequence<\/th><td>2<\/td>/);
  });
});
