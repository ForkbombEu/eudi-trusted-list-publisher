import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { readFileSync, existsSync, statSync, lstatSync } from "node:fs";
import { resolve, extname } from "node:path";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { parse as parseYaml } from "yaml";
import { PublicationStore } from "../core/publication/store.js";
import {
  AuthoringStore,
  SettingsStore,
  emptySettings,
  loadSigningConfig,
  findSigningConfig,
  getFamilyConfigs,
  signingConfigDisplay,
  ApplicationService,
  createTrustedList,
  deriveListKeyFromParts,
  generateSigningMaterial,
  type CreateListResult,
  type PublisherSettings,
  type SigningConfig,
} from "../core/authoring/index.js";
import {
  isEnabledProfileFamily,
  PROFILE_REGISTRY,
  type EnabledProfileFamily,
} from "../core/profiles/registry.js";
import {
  certificateGuideHtml,
  CERTIFICATE_GUIDE_PATH,
  CERTIFICATE_GUIDE_TITLE,
} from "./views/certificate-guide.js";
import {
  brokenBadge,
  brokenColumnHtml,
  brokenListSectionHtml,
  defectIdsFromFixture,
} from "./views/broken-list.js";
import {
  inspectorPanelHtml,
  fixturePanelHtml,
  parseInspectorEvaluation,
  versionDownloadsHtml,
} from "./views/inspector-panel.js";
import {
  inspectorStatusLabel,
  InspectorClient,
} from "../core/inspector/inspector.js";
import { TrustedListStore } from "../core/publication/tsl-store.js";
import { PublicationReader } from "../core/publication/reader.js";
import { TslApplicationStore } from "../core/tsl612/authoring/application-store.js";
import { TslApplicationService } from "../core/tsl612/authoring/application-service.js";
import { parseTslSubmission } from "../core/tsl612/authoring/submission-parser.js";
import { createTrustedListList } from "../core/tsl612/create-list.js";
import { TSL_MEDIA_TYPE } from "../core/tsl612/constants.js";
import { readTrustedList } from "../core/tsl612/read.js";
import type { TslProvider } from "../core/tsl612/model.js";
import { type TslFamily } from "../core/tsl612/registry.js";
import {
  getTrustedListConfigsForFamily,
  findTrustedListConfig,
} from "../core/authoring/signing-config.js";
import {
  eaaProviderFormHtml,
  qeaaProviderFormHtml,
  type TrustedListOption,
} from "./views/tsl612-onboarding.js";
import {
  tslApplicationsHtml,
  tslApplicationDetailHtml,
  trustedListVersionHtml,
} from "./views/tsl612-admin.js";
import { createTrustedListFormHtml } from "./views/tsl612-list-creation.js";
import { familyChip, listChip } from "./views/colors.js";
import { parseInspectorEvaluation as parseTslInspector } from "./views/inspector-panel.js";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".jades": "application/octet-stream",
  ".xml": TSL_MEDIA_TYPE,
  ".sha2": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;
const ADMIN_COOKIE = "tlp_admin_token";

function jsonListSubtitle(family: string | undefined): string {
  return `<div class="chip-group">${family ? familyChip(family) : ""}<span class="chip chip-standard">ETSI TS 119 602</span><span class="chip chip-format">JSON / JAdES-B-B</span></div>`;
}

function xmlListSubtitle(profiles: readonly string[]): string {
  return `<div class="chip-group">${profiles.map((profile) => familyChip(profile)).join("")}<span class="chip chip-standard">ETSI TS 119 612</span><span class="chip chip-format">XML / XAdES-B-B</span></div>`;
}

type OnboardingViews = typeof import("./views/onboarding.js");
type OnboardingFormRenderer = (
  values?: Record<string, string>,
  errors?: Record<string, string>,
  listOptions?: { key: string; label: string }[],
) => string;

/**
 * One onboarding form per implemented family. The routes are singular and the
 * registry keys plural, and each family renders its own view, so the mapping is
 * declared once here instead of being repeated in the GET and POST handlers.
 */
const ONBOARDING_FORMS: ReadonlyArray<{
  readonly path: string;
  readonly family: EnabledProfileFamily;
  readonly title: string;
  readonly render: (views: OnboardingViews) => OnboardingFormRenderer;
}> = Object.freeze([
  {
    path: "/onboarding/pid-provider",
    family: "pid-providers",
    title: "PID Provider Application",
    render: (views) => views.pidProviderFormHtml,
  },
  {
    path: "/onboarding/wallet-provider",
    family: "wallet-providers",
    title: "Wallet Provider Application",
    render: (views) => views.walletProviderFormHtml,
  },
  {
    path: "/onboarding/wrpac-provider",
    family: "wrpac-providers",
    title: "WRPAC Provider Application",
    render: (views) => views.wrpacProviderFormHtml,
  },
  {
    path: "/onboarding/wrprc-provider",
    family: "wrprc-providers",
    title: "WRPRC Provider Application",
    render: (views) => views.wrprcProviderFormHtml,
  },
  {
    path: "/onboarding/pub-eaa-provider",
    family: "pub-eaa-providers",
    title: "Pub-EAA Provider Application",
    render: (views) => views.pubEaaProviderFormHtml,
  },
]);

function onboardingFormFor(
  path: string,
): (typeof ONBOARDING_FORMS)[number] | undefined {
  return ONBOARDING_FORMS.find((form) => form.path === path);
}

function onboardingFormForFamily(
  family: EnabledProfileFamily,
): (typeof ONBOARDING_FORMS)[number] {
  const form = ONBOARDING_FORMS.find(
    (candidate) => candidate.family === family,
  );
  if (!form) throw new Error(`No onboarding form for family '${family}'.`);
  return form;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const APPLY_CSS = `
<link rel="stylesheet" href="/assets/style.css">
<link rel="stylesheet" href="/assets/app.css">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
`;

const PRODUCT_NAME = "Credimi EUDI Trusted Lists";
const REPOSITORY_URL =
  "https://github.com/ForkbombEu/eudi-trusted-list-publisher";

/** Nav entry shown on every page when the data-collection GUI is enabled. */
const GUI_NAV = `
      <li><a href="/onboarding">Onboarding</a></li>`;

/** Visual divider between the three top-nav groups. */
const NAV_SEP = `
      <li class="nav-sep" role="separator" aria-hidden="true"></li>`;

function htmlPage(title: string, body: string, guiNav?: string): string {
  const extraNav = guiNav ?? "";
  const settingsCol = guiNav
    ? `
        <div class="footer-col">
          <h5>Settings</h5>
          <a href="/admin">Admin</a>
        </div>`
    : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
${APPLY_CSS}
</head>
<body>
<nav class="topbar">
  <div class="topbar-inner">
    <a href="/" class="topbar-logo" aria-label="${escapeHtml(PRODUCT_NAME)} home">
      <img src="/assets/credimi_logo.svg" alt="Credimi">
      <span class="tlp-product-name">${escapeHtml(PRODUCT_NAME)}</span>
    </a>
    <ul class="topbar-nav">
      <li><a href="/">Catalogue</a></li>${extraNav}${NAV_SEP}
      <li><a href="/docs">API Docs</a></li>
      <li><a href="/openapi.yaml">Open API</a></li>${NAV_SEP}
      <li><a href="${REPOSITORY_URL}">Repository</a></li>
    </ul>
  </div>
</nav>
<div class="page-shell">
  <div class="page-shell-main">
    <main class="content page-content">
      <div class="container">
${body}
      </div>
    </main>
<footer class="footer">
  <div class="footer-inner">
    <div class="footer-content">
      <div class="footer-brand">
        <img class="tlp-footer-logo" src="/assets/credimi_logo_negative.svg" alt="Credimi">
        <p>${escapeHtml(PRODUCT_NAME)} &mdash; authoring, signing and publication of
        TS 119 602 Lists of Trusted Entities. For testing and debugging purposes only.</p>
      </div>
      <div class="footer-links">
        <div class="footer-col">
          <h5>Explore</h5>
          <a href="/">Catalogue</a>
          <a href="/docs">API Docs</a>
          <a href="/openapi.yaml">Open API</a>
        </div>
        <div class="footer-col">
          <h5>Resources</h5>
          <a href="${CERTIFICATE_GUIDE_PATH}">${escapeHtml(CERTIFICATE_GUIDE_TITLE)}</a>
          <a href="${REPOSITORY_URL}">Repository</a>
        </div>${settingsCol}
      </div>
    </div>
  </div>
  <div class="footer-sub-bar">
    Signer trust status: not evaluated. This tool does not establish PKIX trust.
  </div>
</footer>
  </div>
</div>
<script>
console.log(
  "%cCredimi %cEUDI Trusted Lists",
  "color: #2563eb; font-weight: bold; font-size: 1.2em;",
  "color: #1e293b;"
);
console.log("%ctesting and debugging tool", "color: #64748b;");
console.log("%csigner trust: not evaluated", "color: #d97706;");
</script>
</body>
</html>`;
}

export interface ServerConfig {
  publicationDir: string;
  host?: string;
  port?: number;
  assetsDir?: string;
  maxFileBytes?: number;
  dataCollectionGui?: boolean;
  authoringDir?: string;
  adminToken?: string;
  adminUser?: string;
  adminPassword?: string;
  signingConfigPath?: string;
  certificatesDir?: string;
  /**
   * Base URL of the Trust Inspector.
   *
   * Absent disables the integration entirely: no artifact leaves this process,
   * and every version reports its Inspector status as unavailable — which is
   * not a conformance statement. That is the default on purpose. Publishing a
   * list uploads it to a third party, and a test suite, a local experiment or
   * an air-gapped deployment must not do that as a side effect of running.
   * `serve` passes TLP_INSPECTOR_URL, defaulting to the public Inspector.
   */
  inspectorBaseUrl?: string;
}

/** Constant-time string comparison that does not leak the compared length. */
function secretEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) {
    // Still perform a comparison so the timing does not depend on the length.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

function securityHeaders(): Record<string, string> {
  return {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
  };
}

function sendResponse(
  res: ServerResponse,
  status: number,
  body: string,
  contentType: string,
  cacheControl: string,
  extraHeaders?: Record<string, string>,
): void {
  const headers: Record<string, string> = {
    ...securityHeaders(),
    "Content-Type": contentType,
    "Cache-Control": cacheControl,
    ...extraHeaders,
  };
  res.writeHead(status, headers);
  res.end(body);
}

function sendJson(
  res: ServerResponse,
  status: number,
  data: unknown,
  cacheControl = "no-store",
): void {
  sendResponse(
    res,
    status,
    JSON.stringify(data),
    "application/json",
    cacheControl,
  );
}

function sendHtml(res: ServerResponse, status: number, body: string): void {
  sendResponse(res, status, body, "text/html; charset=utf-8", "no-store");
}

function send404(res: ServerResponse, message?: string): void {
  sendResponse(
    res,
    404,
    htmlPage(
      "404 Not Found",
      `<h1>Not Found</h1><p>${escapeHtml(message ?? "The requested resource does not exist.")}</p>`,
    ),
    "text/html; charset=utf-8",
    "no-store",
  );
}

function send405(res: ServerResponse, guiEnabled?: boolean): void {
  const allow = guiEnabled ? "GET, HEAD, POST" : "GET, HEAD";
  const headers: Record<string, string> = {
    ...securityHeaders(),
    "Content-Type": "text/plain; charset=utf-8",
    Allow: allow,
    "Cache-Control": "no-store",
  };
  res.writeHead(405, headers);
  res.end("405 Method Not Allowed");
}

function send500(res: ServerResponse, requestId: string): void {
  sendResponse(
    res,
    500,
    htmlPage(
      "500 Internal Error",
      `<h1>Internal Error</h1><p>Request ID: <code>${escapeHtml(requestId)}</code></p>`,
    ),
    "text/html; charset=utf-8",
    "no-store",
  );
}

function send413(res: ServerResponse): void {
  sendResponse(
    res,
    413,
    "413 Payload Too Large",
    "text/plain; charset=utf-8",
    "no-store",
  );
}

function logRequest(
  method: string,
  pathname: string,
  status: number,
  requestId: string,
): void {
  process.stderr.write(
    JSON.stringify({
      event: "request",
      method,
      path: pathname,
      status,
      requestId,
      timestamp: new Date().toISOString(),
    }) + "\n",
  );
}

/**
 * The public origin seen by the browser. Caddy preserves Host and supplies
 * X-Forwarded-Proto when it terminates TLS, so the stable URL keeps its public
 * HTTPS scheme without teaching the publisher about a particular deployment.
 */
function requestPublicOrigin(req: IncomingMessage, url: URL): string {
  const forwarded = req.headers["x-forwarded-proto"];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)
    ?.split(",", 1)[0]
    ?.trim()
    .toLowerCase();
  const protocol = first === "http" || first === "https" ? first : url.protocol;
  return `${protocol.replace(/:$/, "")}://${url.host}`;
}

function readFileBounded(filePath: string, maxBytes: number): string | null {
  if (!existsSync(filePath)) return null;
  try {
    if (lstatSync(filePath).isSymbolicLink()) return null;
  } catch {
    return null;
  }
  const st = statSync(filePath);
  if (st.size > maxBytes) return null;
  return readFileSync(filePath, "utf-8");
}

export interface ApiRoute {
  method: "GET" | "POST";
  path: string;
  matcher: RegExp;
  handler: string;
}

const API_ROUTES: ApiRoute[] = [
  {
    method: "GET",
    path: "/api/v1/lists",
    matcher: /^\/api\/v1\/lists$/,
    handler: "listLists",
  },
  {
    method: "GET",
    path: "/api/v1/lists/{listKey}",
    matcher: /^\/api\/v1\/lists\/([a-z0-9_.@()-]+)$/,
    handler: "getList",
  },
  {
    method: "GET",
    path: "/api/v1/lists/{listKey}/versions/{sequence}",
    matcher: /^\/api\/v1\/lists\/([a-z0-9_.@()-]+)\/versions\/(\d+)$/,
    handler: "getVersion",
  },
  {
    method: "GET",
    path: "/api/v1/lists/{listKey}/versions/{sequence}/trusted-list.xml",
    matcher:
      /^\/api\/v1\/lists\/([a-z0-9_.@()-]+)\/versions\/(\d+)\/trusted-list\.xml$/,
    handler: "getTrustedListXml",
  },
  {
    method: "GET",
    path: "/api/v1/lists/{listKey}/versions/{sequence}/trusted-list.sha2",
    matcher:
      /^\/api\/v1\/lists\/([a-z0-9_.@()-]+)\/versions\/(\d+)\/trusted-list\.sha2$/,
    handler: "getTrustedListSha2",
  },
  {
    method: "GET",
    path: "/lists/{listKey}/latest/trusted-list.xml",
    matcher: /^\/lists\/([a-z0-9_.@()-]+)\/latest\/trusted-list\.xml$/,
    handler: "getLatestTrustedListXml",
  },
  {
    method: "GET",
    path: "/lists/{listKey}/latest/trusted-list.sha2",
    matcher: /^\/lists\/([a-z0-9_.@()-]+)\/latest\/trusted-list\.sha2$/,
    handler: "getLatestTrustedListSha2",
  },
  {
    method: "GET",
    path: "/api/v1/lists/{listKey}/versions/{sequence}/lote",
    matcher: /^\/api\/v1\/lists\/([a-z0-9_.@()-]+)\/versions\/(\d+)\/lote$/,
    handler: "getLoteJson",
  },
  {
    method: "GET",
    path: "/api/v1/lists/{listKey}/versions/{sequence}/signature",
    matcher:
      /^\/api\/v1\/lists\/([a-z0-9_.@()-]+)\/versions\/(\d+)\/signature$/,
    handler: "getSignature",
  },
  {
    method: "GET",
    path: "/api/v1/lists/{listKey}/versions/{sequence}/manifest",
    matcher: /^\/api\/v1\/lists\/([a-z0-9_.@()-]+)\/versions\/(\d+)\/manifest$/,
    handler: "getManifest",
  },
  {
    method: "GET",
    path: "/api/v1/lists/{listKey}/versions/{sequence}/xml",
    matcher: /^\/api\/v1\/lists\/([a-z0-9_.@()-]+)\/versions\/(\d+)\/xml$/,
    handler: "getLoteXml",
  },
  {
    method: "GET",
    path: "/api/v1/lists/{listKey}/versions/{sequence}/inspector",
    matcher:
      /^\/api\/v1\/lists\/([a-z0-9_.@()-]+)\/versions\/(\d+)\/inspector$/,
    handler: "getInspectorEvaluation",
  },
  {
    method: "GET",
    path: "/api/v1/lists/{listKey}/versions/{sequence}/fixture",
    matcher: /^\/api\/v1\/lists\/([a-z0-9_.@()-]+)\/versions\/(\d+)\/fixture$/,
    handler: "getFixtureMetadata",
  },
  {
    method: "POST",
    path: "/api/v1/admin/lists",
    matcher: /^\/api\/v1\/admin\/lists$/,
    handler: "createTrustedList",
  },
  {
    method: "POST",
    path: "/api/v1/admin/trusted-lists",
    matcher: /^\/api\/v1\/admin\/trusted-lists$/,
    handler: "createXmlTrustedList",
  },
];

export function getApiRoutes(): ReadonlyArray<ApiRoute> {
  return API_ROUTES;
}

export interface RouteParityError {
  kind: "unimplemented" | "undocumented" | "wrong_method";
  detail: string;
}

const ALL_HTTP_METHODS = new Set([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
]);

export function checkApiRouteParity(
  registry: ReadonlyArray<{ method: string; path: string }>,
  spec: { paths?: Record<string, unknown> },
): RouteParityError[] {
  const errors: RouteParityError[] = [];
  const implSet = new Set(registry.map((r) => `${r.method} ${r.path}`));
  const docPaths = spec.paths ?? {};

  for (const route of registry) {
    const opPath = route.path;
    if (!docPaths[opPath]) {
      errors.push({
        kind: "undocumented",
        detail: `implemented ${route.method} ${opPath} not found in OpenAPI`,
      });
      continue;
    }
    const docMethods = docPaths[opPath] as Record<string, unknown>;
    if (!docMethods[route.method.toLowerCase()]) {
      errors.push({
        kind: "wrong_method",
        detail: `implemented ${route.method} ${opPath} documented under different method`,
      });
    }
  }

  for (const [docPath, docMethodsObj] of Object.entries(docPaths)) {
    const docMethods = docMethodsObj as Record<string, unknown>;
    for (const m of Object.keys(docMethods)) {
      const upper = m.toUpperCase();
      if (!ALL_HTTP_METHODS.has(upper)) continue;
      const key = `${upper} ${docPath}`;
      if (!implSet.has(key)) {
        errors.push({
          kind: "unimplemented",
          detail: `documented ${upper} ${docPath} not in implemented registry`,
        });
      }
    }
  }

  return errors;
}

export function createWebServer(config: ServerConfig) {
  const assetsDir = config.assetsDir
    ? resolve(config.assetsDir)
    : resolve(process.cwd(), "src", "web", "assets");
  const maxFileBytes = config.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const guiEnabled = config.dataCollectionGui === true;
  const adminToken = config.adminToken ?? "";
  const adminUser = config.adminUser ?? "";
  const adminPassword = config.adminPassword ?? "";
  /**
   * Username/password sign-in is offered only when both ADMIN_USER and
   * ADMIN_PASSWORD are configured. Otherwise the admin area keeps its
   * token-only behaviour.
   */
  const adminLoginEnabled = adminUser !== "" && adminPassword !== "";

  if (guiEnabled && !adminToken) {
    throw new Error(
      "DATA_COLLECTION_GUI requires TLP_ADMIN_TOKEN to be set. An empty admin token is not permitted when the GUI is enabled.",
    );
  }

  const store = new PublicationStore({
    publicationDir: config.publicationDir,
  });

  /*
    The TS 119 612 side. It shares the publication root with the JSON store —
    a list key names one directory — and the reader in front of both decides
    which format a list is by what is actually on disk.
  */
  const trustedListStore = new TrustedListStore({
    publicationDir: config.publicationDir,
  });
  const publicationReader = new PublicationReader(store, trustedListStore);
  /* Null when no Inspector is configured: see ServerConfig.inspectorBaseUrl. */
  const inspectorClient =
    config.inspectorBaseUrl && config.inspectorBaseUrl.trim() !== ""
      ? new InspectorClient({ baseUrl: config.inspectorBaseUrl })
      : null;
  let tslApplicationService: TslApplicationService | null = null;

  let authoringStore: AuthoringStore | null = null;
  let settingsStore: SettingsStore | null = null;
  let signingConfig: SigningConfig | null = null;
  let appService: ApplicationService | null = null;
  /** Configured list keys per implemented family, rebuilt on every reload. */
  let familyListKeys: Record<EnabledProfileFamily, string[]> = {
    "pid-providers": [],
    "wallet-providers": [],
    "wrpac-providers": [],
    "wrprc-providers": [],
    "pub-eaa-providers": [],
  };

  if (guiEnabled && config.authoringDir) {
    authoringStore = new AuthoringStore({ authoringDir: config.authoringDir });
    /* TS 119 612 applications are stored apart from the TS 119 602 ones: the
       two record shapes share no fields beyond an id and a state. */
    tslApplicationService = new TslApplicationService({
      applications: new TslApplicationStore({
        applicationsDir: resolve(config.authoringDir, "xml-applications"),
      }),
      store: trustedListStore,
      trustedListConfig: (listKey) =>
        signingConfig
          ? findTrustedListConfig(signingConfig, listKey)
          : undefined,
      inspector: inspectorClient,
      isAutoApprove: (family, listKey) =>
        settingsStore ? settingsStore.isAutoApprove(family, listKey) : false,
    });
    // Administrator settings are mutable state, so they live beside the
    // authoring records rather than in the immutable publication store.
    settingsStore = new SettingsStore({ settingsDir: config.authoringDir });
  }
  const signingConfigPath = guiEnabled ? config.signingConfigPath : undefined;
  const configuredCertificatesDir = config.certificatesDir?.trim();
  const certificatesDir =
    guiEnabled && configuredCertificatesDir
      ? configuredCertificatesDir
      : undefined;

  /*
    Creating a Trusted List appends to the signing configuration, so the
    in-memory view is rebuilt afterwards. Without this the new list would not
    appear on the onboarding forms until the server restarted.
  */
  function reloadSigningConfig(): void {
    if (!signingConfigPath) return;
    signingConfig = loadSigningConfig(signingConfigPath);
    const loaded = signingConfig;
    familyListKeys = {
      "pid-providers": [],
      "wallet-providers": [],
      "wrpac-providers": [],
      "wrprc-providers": [],
      "pub-eaa-providers": [],
    };
    for (const family of Object.keys(
      familyListKeys,
    ) as EnabledProfileFamily[]) {
      familyListKeys[family] = getFamilyConfigs(loaded, family).map(
        (entry) => entry.listKey,
      );
    }
    if (authoringStore)
      appService = new ApplicationService(
        authoringStore,
        store,
        signingConfig,
        settingsStore,
      );
  }

  if (signingConfigPath) reloadSigningConfig();
  if (authoringStore && !appService) {
    appService = new ApplicationService(
      authoringStore,
      store,
      signingConfig,
      settingsStore,
    );
  }

  /**
   * Every shell page goes through here so the Onboarding and Admin links are
   * present on the Catalogue and API Docs pages too whenever the GUI is on.
   */
  function page(title: string, body: string): string {
    return htmlPage(title, body, guiEnabled ? GUI_NAV : undefined);
  }

  function guiPage(title: string, body: string): string {
    return page(title, body);
  }

  /** Target-list options offered on one family's onboarding form. */
  function listOptionsFor(
    family: EnabledProfileFamily,
  ): { key: string; label: string; defects?: string[] }[] {
    if (!signingConfig) return [];
    return getFamilyConfigs(signingConfig, family).map((entry) => ({
      key: entry.listKey,
      label: `${entry.schemeOperatorName} (${entry.listKey})`,
      /* Persisted on the entry, so a broken list is marked before it is chosen. */
      defects: entry.defects ?? [],
    }));
  }

  /** Configured Trusted Lists grouped by the family they belong to. */
  function settingsListsByFamily(): Record<
    string,
    Array<{ listKey: string; schemeOperatorName: string }>
  > {
    const grouped: Record<
      string,
      Array<{ listKey: string; schemeOperatorName: string }>
    > = {};
    for (const entry of signingConfig?.lists ?? []) {
      (grouped[entry.family] ??= []).push({
        listKey: entry.listKey,
        schemeOperatorName: entry.schemeOperatorName,
      });
    }
    return grouped;
  }

  /**
   * Checkboxes are absent from the body when unchecked, so the posted form is
   * the complete new state: anything not named here is turned off.
   */
  function settingsFromForm(fields: Record<string, string>): PublisherSettings {
    const settings = emptySettings();
    for (const key of Object.keys(fields)) {
      const family = key.match(/^family\[([a-z-]+)\]$/);
      if (family) {
        settings.autoApproveFamilies[
          family[1]! as keyof PublisherSettings["autoApproveFamilies"]
        ] = true;
        continue;
      }
      const list = key.match(/^list\[([a-z0-9_]+)\]$/);
      if (list) settings.autoApproveLists[list[1]!] = true;
    }
    return settings;
  }

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const requestId = randomUUID();
    res.setHeader("X-Request-ID", requestId);
    const method = req.method ?? "GET";

    try {
      if (guiEnabled) {
        if (method !== "GET" && method !== "HEAD" && method !== "POST") {
          send405(res, guiEnabled);
          logRequest(method, req.url?.split("?")[0] ?? "/", 405, requestId);
          return;
        }
      } else {
        if (method !== "GET" && method !== "HEAD") {
          send405(res);
          logRequest(method, req.url?.split("?")[0] ?? "/", 405, requestId);
          return;
        }
      }

      const url = new URL(
        req.url ?? "/",
        `http://${req.headers.host ?? "localhost"}`,
      );
      handler(req, res, url, requestId);
    } catch {
      if (!res.headersSent) {
        send500(res, requestId);
      }
      logRequest(
        req.method ?? "GET",
        req.url?.split("?")[0] ?? "/",
        500,
        requestId,
      );
    }
  });

  function handler(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    requestId: string,
  ): void {
    const path = url.pathname;

    if (path === "/healthz") {
      sendJson(res, 200, { status: "ok" }, "no-store");
      logRequest("GET", path, 200, requestId);
      return;
    }

    if (path === "/favicon.svg") {
      serveAsset(
        res,
        "credimi_logo.svg",
        "image/svg+xml",
        "public, max-age=86400, immutable",
      );
      logRequest("GET", path, res.statusCode, requestId);
      return;
    }

    if (path.startsWith("/assets/")) {
      const assetName = path.slice("/assets/".length);
      if (assetName.includes("..") || assetName.includes("/")) {
        send404(res);
        logRequest("GET", path, 404, requestId);
        return;
      }
      const assetPath = resolve(assetsDir, assetName);
      if (!assetPath.startsWith(resolve(assetsDir))) {
        send404(res);
        logRequest("GET", path, 404, requestId);
        return;
      }
      if (!existsSync(assetPath)) {
        send404(res);
        logRequest("GET", path, 404, requestId);
        return;
      }
      const ext = extname(assetName).toLowerCase();
      const mimeType = MIME[ext] ?? "application/octet-stream";
      const cacheControl =
        assetName === "app.css"
          ? "no-store"
          : "public, max-age=86400, immutable";
      serveAsset(res, assetName, mimeType, cacheControl);
      logRequest("GET", path, res.statusCode, requestId);
      return;
    }

    if (path === "/openapi.yaml") {
      serveOpenApi(res, "yaml");
      logRequest("GET", path, res.statusCode, requestId);
      return;
    }
    if (path === "/openapi.json") {
      serveOpenApi(res, "json");
      logRequest("GET", path, res.statusCode, requestId);
      return;
    }

    if (path === "/docs") {
      serveDocs(res);
      logRequest("GET", path, res.statusCode, requestId);
      return;
    }

    if (path === "/docs/reference") {
      serveDocsReference(res);
      logRequest("GET", path, res.statusCode, requestId);
      return;
    }

    if (path === CERTIFICATE_GUIDE_PATH) {
      serveCertificateGuide(res, requestId);
      return;
    }

    if (path.startsWith("/api/v1/")) {
      /*
        The two mutating API routes. They are handled here rather than in
        handleApi(), which serves the read-only published artifacts. There is
        one per standard because the two take different declarations: a
        TS 119 602 list is described by a base URL, a TS 119 612 one by the
        scheme URIs and the LOTL pointer the standard requires it to publish.
      */
      if (path === "/api/v1/admin/lists") {
        if ((req.method ?? "GET") !== "POST") {
          send405(res, guiEnabled);
          logRequest(req.method ?? "GET", path, 405, requestId);
          return;
        }
        void apiCreateTrustedList(req, res, url, requestId);
        return;
      }
      if (path === "/api/v1/admin/trusted-lists") {
        if ((req.method ?? "GET") !== "POST") {
          send405(res, guiEnabled);
          logRequest(req.method ?? "GET", path, 405, requestId);
          return;
        }
        void apiCreateXmlTrustedList(req, res, url, requestId);
        return;
      }
      handleApi(req, res, url, requestId);
      return;
    }

    if (path === "/") {
      serveCatalogue(res, store);
      logRequest("GET", path, res.statusCode, requestId);
      return;
    }

    /*
      The stable latest URLs. They end exactly in `trusted-list.xml` and
      `trusted-list.sha2`, so a consumer can hard-code one URL and always get
      the current version's bytes.
    */
    const latestMatch = path.match(
      /^\/lists\/([a-z0-9_.@()-]+)\/latest\/(trusted-list\.xml|trusted-list\.sha2)$/,
    );
    if (latestMatch) {
      serveTrustedListArtifact(
        res,
        latestMatch[1]!,
        publicationReader.latestXmlSequence(latestMatch[1]!),
        latestMatch[2]!,
      );
      logRequest("GET", path, res.statusCode, requestId);
      return;
    }

    const listMatch = path.match(/^\/lists\/([a-z0-9_.@()-]+)$/);
    if (listMatch) {
      if (publicationReader.formatOf(listMatch[1]!) === "xml") {
        void serveTrustedListDetail(res, listMatch[1]!).then(() => {
          logRequest("GET", path, res.statusCode, requestId);
        });
        return;
      }
      serveListDetail(res, store, listMatch[1]!);
      logRequest("GET", path, res.statusCode, requestId);
      return;
    }

    const xmlViewMatch = path.match(
      /^\/lists\/([a-z0-9_.@()-]+)\/versions\/(\d+)\/xml$/,
    );
    if (xmlViewMatch) {
      serveTrustedListXmlView(
        res,
        xmlViewMatch[1]!,
        parseInt(xmlViewMatch[2]!, 10),
      );
      logRequest("GET", path, res.statusCode, requestId);
      return;
    }

    const versionMatch = path.match(
      /^\/lists\/([a-z0-9_.@()-]+)\/versions\/(\d+)$/,
    );
    if (versionMatch) {
      const listKey = versionMatch[1]!;
      const sequence = parseInt(versionMatch[2]!, 10);
      if (publicationReader.formatOf(listKey) === "xml") {
        void serveTrustedListVersion(res, listKey, sequence).then(() => {
          logRequest("GET", path, res.statusCode, requestId);
        });
        return;
      }
      serveVersionDetail(res, store, listKey, sequence);
      logRequest("GET", path, res.statusCode, requestId);
      return;
    }

    if (guiEnabled) {
      const reqMethod = req.method ?? "GET";

      if (reqMethod === "POST") {
        handleGuiPost(req, res, url, requestId);
        return;
      }
      if (path.startsWith("/onboarding")) {
        handleOnboarding(req, res, url, requestId);
        return;
      }
      if (path.startsWith("/admin")) {
        handleAdmin(req, res, url, requestId);
        return;
      }
    }

    send404(res);
    logRequest("GET", path, 404, requestId);
  }

  /** Serves `trusted-list.xml` or `trusted-list.sha2` of one version. */
  function serveTrustedListArtifact(
    res: ServerResponse,
    listKey: string,
    sequenceNumber: number | null,
    file: string,
  ): void {
    if (sequenceNumber === null) {
      send404(res);
      return;
    }
    const artifacts = publicationReader.xmlVersion(listKey, sequenceNumber);
    if (!artifacts) {
      send404(res);
      return;
    }
    const isXml = file === "trusted-list.xml";
    const body = isXml ? artifacts.xml : artifacts.sha2;
    res.writeHead(200, {
      ...securityHeaders(),
      "Content-Type": isXml ? TSL_MEDIA_TYPE : "text/plain; charset=utf-8",
      "Content-Length": Buffer.byteLength(body),
      "Cache-Control": "no-store",
    });
    res.end(body);
  }

  /** Serves a published XML artifact inline for browser inspection. */
  function serveTrustedListXmlView(
    res: ServerResponse,
    listKey: string,
    sequenceNumber: number,
  ): void {
    const artifacts = publicationReader.xmlVersion(listKey, sequenceNumber);
    if (!artifacts) {
      send404(res);
      return;
    }
    res.writeHead(200, {
      ...securityHeaders(),
      "Content-Type": "application/xml; charset=utf-8",
      "Content-Disposition": "inline",
      "Content-Length": Buffer.byteLength(artifacts.xml),
      "Cache-Control": "no-store",
    });
    res.end(artifacts.xml);
  }

  async function serveTrustedListDetail(
    res: ServerResponse,
    listKey: string,
  ): Promise<void> {
    const versions = await publicationReader.versions(listKey);
    if (versions.length === 0) {
      send404(res);
      return;
    }
    const summary = await publicationReader.listSummary(listKey);
    const rows = versions
      .map(
        (version) => `
        <tr>
          <td><a href="/lists/${encodeURIComponent(listKey)}/versions/${version.sequenceNumber}">${version.sequenceNumber}</a></td>
          <td>${escapeHtml(version.issueDate)}</td>
          <td>${escapeHtml(version.nextUpdateDate)}</td>
          <td>${version.signatureValid ? "&#x2705; valid" : "&#x274C; invalid"}</td>
          <td><a class="btn btn-sm" target="_blank" rel="noopener noreferrer" href="/lists/${encodeURIComponent(listKey)}/versions/${version.sequenceNumber}/xml">XML</a></td>
        </tr>`,
      )
      .join("");
    const acceptedProfiles = summary?.allowedServiceProfiles ?? [];
    const newest = versions[versions.length - 1];
    const listDefects = newest
      ? defectIdsFromFixture(
          trustedListStore.readFixtureMetadata(listKey, newest.sequenceNumber),
        )
      : [];
    const body = `
<h1>${escapeHtml(listKey)}${listDefects.length > 0 ? ` ${brokenBadge()}` : ""}</h1>
${xmlListSubtitle(acceptedProfiles)}
${brokenListSectionHtml(listDefects, "TS 119 612")}
<div class="trust-notice"><strong>Trust not evaluated.</strong> Signatures are verified cryptographically but signer trust is not evaluated by this tool.</div>
<table class="catalogue-table">
  <thead><tr><th>Sequence</th><th>Issue Date</th><th>Next Update</th><th>Signature</th><th>Open</th></tr></thead>
  <tbody>${rows}</tbody>
</table>`;
    sendHtml(res, 200, page(listKey, body));
  }

  async function serveTrustedListVersion(
    res: ServerResponse,
    listKey: string,
    sequenceNumber: number,
  ): Promise<void> {
    const artifacts = publicationReader.xmlVersion(listKey, sequenceNumber);
    if (!artifacts) {
      send404(res);
      return;
    }
    const stored = publicationReader.inspectorEvaluation(
      listKey,
      sequenceNumber,
      "xml",
    );
    const evaluation = stored ? parseTslInspector(stored) : null;
    const latest = publicationReader.latestXmlSequence(listKey);
    let providers: readonly TslProvider[] = [];
    try {
      providers = readTrustedList(artifacts.xml).providers ?? [];
    } catch {
      // Keep the version page available when an intentionally broken XML
      // fixture cannot be parsed into provider details.
    }
    const summary = await publicationReader.listSummary(listKey);
    const acceptedProfiles =
      summary?.allowedServiceProfiles &&
      summary.allowedServiceProfiles.length > 0
        ? summary.allowedServiceProfiles
        : artifacts.manifest.serviceProfiles.allowedServiceProfiles.length
          ? artifacts.manifest.serviceProfiles.allowedServiceProfiles
          : [artifacts.manifest.family];
    sendHtml(
      res,
      200,
      page(
        `${listKey} - Version ${sequenceNumber}`,
        trustedListVersionHtml(
          listKey,
          sequenceNumber,
          artifacts.manifest,
          evaluation?.summary ?? null,
          latest === sequenceNumber,
          trustedListStore.readFixtureMetadata(listKey, sequenceNumber),
          xmlListSubtitle(acceptedProfiles),
          providers,
        ),
      ),
    );
  }

  function serveAsset(
    res: ServerResponse,
    name: string,
    contentType: string,
    cacheControl: string,
  ): void {
    const p = resolve(assetsDir, name);
    const content = readFileBounded(p, maxFileBytes);
    if (content === null) {
      if (!existsSync(p)) send404(res);
      else send413(res);
      return;
    }
    const headers: Record<string, string> = {
      ...securityHeaders(),
      "Content-Type": contentType,
      "Cache-Control": cacheControl,
    };
    res.writeHead(200, headers);
    res.end(content);
  }

  function serveOpenApi(res: ServerResponse, format: "yaml" | "json"): void {
    const p = resolve(assetsDir, "openapi.yaml");
    const content = readFileBounded(p, maxFileBytes);
    if (content === null) {
      send404(res, "OpenAPI spec not found");
      return;
    }
    if (format === "yaml") {
      sendResponse(res, 200, content, "application/yaml", "no-store");
    } else {
      try {
        const parsed = parseYaml(content);
        if (
          typeof parsed !== "object" ||
          parsed === null ||
          !("openapi" in parsed)
        ) {
          sendResponse(
            res,
            500,
            "Invalid OpenAPI document",
            "text/plain; charset=utf-8",
            "no-store",
          );
          return;
        }
        sendResponse(
          res,
          200,
          JSON.stringify(parsed),
          "application/json",
          "no-store",
        );
      } catch {
        sendResponse(
          res,
          500,
          "OpenAPI parse error",
          "text/plain; charset=utf-8",
          "no-store",
        );
      }
    }
  }

  /**
   * The Credimi shell page. The reference itself lives in an isolated document
   * at /docs/reference so Stoplight's stylesheet cannot reach this page's CSS.
   */
  function serveDocs(res: ServerResponse): void {
    const html = page(
      "API Documentation",
      `
<h1>API Documentation</h1>
<p class="lead">Wallet Provider and PID Provider LoTE API &mdash; a read-only HTTP API
over the published Lists of Trusted Entities.</p>

<div class="card api-docs">
  <iframe class="api-docs-frame" src="/docs/reference" title="API reference"
    loading="lazy"></iframe>
</div>

<p><a class="btn btn-outline btn-md" href="/openapi.yaml">Download /openapi.yaml</a>
<a class="btn btn-outline btn-md" href="/docs/reference">Open reference in a new page</a></p>
`,
    );
    sendHtml(res, 200, html);
  }

  /**
   * The Certificate creation guide. Reachable whether or not the data-collection
   * GUI is enabled, because the footer Resources column is always rendered.
   */
  function serveCertificateGuide(res: ServerResponse, requestId: string): void {
    sendHtml(res, 200, page(CERTIFICATE_GUIDE_TITLE, certificateGuideHtml()));
    logRequest("GET", CERTIFICATE_GUIDE_PATH, res.statusCode, requestId);
  }

  /**
   * Isolated Stoplight document: no Credimi stylesheet is loaded here, and the
   * page is framed only by this origin.
   *
   * Stoplight Elements is served from this origin rather than from a CDN, so
   * the reference renders whenever the publisher itself is reachable.
   */
  function serveDocsReference(res: ServerResponse): void {
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>API Reference</title>
<link rel="stylesheet" href="/assets/stoplight-elements.min.css">
<style>
  html, body { margin: 0; padding: 0; height: 100%; }
</style>
</head>
<body>
<elements-api
  apiDescriptionUrl="/openapi.yaml"
  router="hash"
  layout="sidebar">
</elements-api>
<script src="/assets/stoplight-elements.min.js"></script>
</body>
</html>`;
    const headers: Record<string, string> = {
      ...securityHeaders(),
      "X-Frame-Options": "SAMEORIGIN",
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    };
    res.writeHead(200, headers);
    res.end(html);
  }

  /**
   * Catalogue "Open" cell: the latest version's artifacts, opened in place
   * rather than downloaded. JSON and JAdES are always present — every published
   * version has both by construction. XML is listed only when the version
   * actually has an `lote.xml` beside it — this publisher does not produce one,
   * so the link appears for an externally supplied rendition and is absent
   * otherwise, never offered as a dead link.
   */
  function openLinks(
    s: PublicationStore,
    listKey: string,
    sequenceNumber: number,
  ): string {
    const base = `/api/v1/lists/${encodeURIComponent(listKey)}/versions/${sequenceNumber}`;
    const links = [
      `<a class="btn btn-sm" target="_blank" rel="noopener noreferrer" href="${base}/lote">JSON</a>`,
      `<a class="btn btn-sm" target="_blank" rel="noopener noreferrer" href="${base}/signature">JAdES</a>`,
      ...(s.hasLoteXml(listKey, sequenceNumber)
        ? [`<a class="btn btn-sm" href="${base}/xml">XML</a>`]
        : []),
    ];
    return links.join(" ");
  }

  async function serveCatalogue(
    res: ServerResponse,
    s: PublicationStore,
  ): Promise<void> {
    try {
      const { listChip, familyChip } = await import("./views/colors.js");
      const lead = `<p class="lead">Browse here EUDI Trusted lists. For testing
        and debugging purposes only.</p>`;

      const keys = s.listKeys();
      if (keys.length === 0) {
        sendHtml(
          res,
          200,
          page(
            "Catalogue",
            `<h1>Published Lists</h1>${lead}<div class="card"><p>No lists have been published yet.</p></div>`,
          ),
        );
        return;
      }

      let rows = "";
      for (const key of keys) {
        /*
          An XML Trusted List has no JSON index. It is rendered from its own
          manifest, with the Open column offering XML rather than JSON, so the
          Catalogue never promises an artifact the list does not have.
        */
        if (publicationReader.formatOf(key) === "xml") {
          const summary = await publicationReader.listSummary(key);
          const versions = await publicationReader.versions(key);
          const newest = versions[versions.length - 1];
          if (!summary || !newest) continue;
          const catalogueFamilies = [
            ...new Set(
              summary.allowedServiceProfiles?.length
                ? summary.allowedServiceProfiles
                : summary.family
                  ? [summary.family]
                  : [],
            ),
          ];
          const xmlDefectIds = defectIdsFromFixture(
            trustedListStore.readFixtureMetadata(key, newest.sequenceNumber),
          );
          rows += `
      <tr${xmlDefectIds.length > 0 ? ' class="catalogue-row-broken"' : ""}>
        <td><a href="/lists/${escapeHtml(key)}">${listChip(key)}</a>${
          xmlDefectIds.length > 0 ? ` ${brokenBadge()}` : ""
        }</td>
        <td>${catalogueFamilies.length > 0 ? `<span class="chip-group">${catalogueFamilies.map((family) => familyChip(family)).join("")}</span>` : "&mdash;"}</td>
        <td>${escapeHtml(String(newest.sequenceNumber))}</td>
        <td>${escapeHtml(newest.issueDate)}</td>
        <td>${escapeHtml(newest.nextUpdateDate)}</td>
        <td>${newest.signatureValid ? "&#x2705; valid" : "&#x274C; invalid"}</td>
        <td><strong>not evaluated</strong></td>
        <td class="catalogue-broken">${brokenColumnHtml(xmlDefectIds, "TS 119 612")}</td>
        <td class="catalogue-open"><a class="btn btn-outline btn-sm" target="_blank" rel="noopener noreferrer" href="/lists/${encodeURIComponent(key)}/versions/${newest.sequenceNumber}/xml">XML</a></td>
      </tr>`;
          continue;
        }
        const index = await s.loadIndex(key);
        if (!index) continue;
        const latest = index.versions[index.versions.length - 1];
        if (!latest) continue;
        const family = signingConfig
          ? findSigningConfig(signingConfig, key)?.family
          : undefined;
        /*
          The defect selection is read from the version's own fixture metadata
          rather than the signing configuration, so the column is correct in
          read-only mode too, where no signing configuration is loaded.
        */
        const defectIds = defectIdsFromFixture(
          s.readFixtureMetadata(key, latest.sequenceNumber),
        );
        rows += `
      <tr${defectIds.length > 0 ? ' class="catalogue-row-broken"' : ""}>
        <td><a href="/lists/${escapeHtml(key)}">${listChip(key)}</a>${
          defectIds.length > 0 ? ` ${brokenBadge()}` : ""
        }</td>
        <td>${family ? familyChip(family) : "&mdash;"}</td>
        <td>${escapeHtml(String(latest.sequenceNumber))}</td>
        <td>${escapeHtml(latest.issueDate)}</td>
        <td>${escapeHtml(latest.nextUpdateDate)}</td>
        <td>${latest.signatureValid ? "&#x2705; valid" : "&#x274C; invalid"}</td>
        <td><strong>not evaluated</strong></td>
        <td class="catalogue-broken">${brokenColumnHtml(defectIds)}</td>
        <td class="catalogue-open">${openLinks(s, key, latest.sequenceNumber)}</td>
      </tr>`;
      }

      sendHtml(
        res,
        200,
        page(
          "Catalogue",
          `<h1>Published Lists</h1>${lead}
        <div class="trust-notice"><strong>Trust not evaluated.</strong> Signatures are verified cryptographically but signer trust is not evaluated by this tool.</div>
        <table class="catalogue-table">
        <thead><tr><th>Trusted List</th><th>Trusted List Family</th><th>Latest Seq</th><th>Issue Date</th><th>Next Update</th><th>Signature</th><th>Trust</th><th>Broken</th><th>Open</th></tr></thead>
        <tbody>${rows}</tbody>
        </table>`,
        ),
      );
    } catch {
      send500(res, "catalogue-error");
    }
  }

  async function serveListDetail(
    res: ServerResponse,
    s: PublicationStore,
    listKey: string,
  ): Promise<void> {
    try {
      const index = await s.loadIndex(listKey);
      if (!index) {
        send404(res, `List "${listKey}" not found`);
        return;
      }
      let rows = "";
      for (const v of index.versions) {
        rows += `
      <tr>
        <td><a href="/lists/${escapeHtml(listKey)}/versions/${String(v.sequenceNumber)}">${String(v.sequenceNumber)}</a></td>
        <td>${escapeHtml(v.issueDate)}</td>
        <td>${escapeHtml(v.nextUpdateDate)}</td>
        <td>${v.signatureValid ? "&#x2705; valid" : "&#x274C; invalid"}</td>
        <td><a class="btn btn-sm" target="_blank" rel="noopener noreferrer" href="/api/v1/lists/${encodeURIComponent(listKey)}/versions/${String(v.sequenceNumber)}/lote">JSON</a> <a class="btn btn-sm" target="_blank" rel="noopener noreferrer" href="/api/v1/lists/${encodeURIComponent(listKey)}/versions/${String(v.sequenceNumber)}/signature">JAdES</a></td>
      </tr>`;
      }
      const family = signingConfig
        ? findSigningConfig(signingConfig, listKey)?.family
        : undefined;
      const latestVersion = index.versions[index.versions.length - 1];
      const listDefects = latestVersion
        ? defectIdsFromFixture(
            s.readFixtureMetadata(listKey, latestVersion.sequenceNumber),
          )
        : [];
      sendHtml(
        res,
        200,
        page(
          listKey,
          `<h1>${escapeHtml(listKey)}${
            listDefects.length > 0 ? ` ${brokenBadge()}` : ""
          }</h1>
        ${jsonListSubtitle(family)}
        ${brokenListSectionHtml(listDefects)}
        <div class="trust-notice"><strong>Trust not evaluated.</strong> Signatures are verified cryptographically but signer trust is not evaluated by this tool.</div>
        <table class="catalogue-table">
        <thead><tr><th>Sequence</th><th>Issue Date</th><th>Next Update</th><th>Signature</th><th>Open</th></tr></thead>
        <tbody>${rows}</tbody>
        </table>`,
        ),
      );
    } catch {
      send500(res, "list-detail-error");
    }
  }

  async function serveVersionDetail(
    res: ServerResponse,
    s: PublicationStore,
    listKey: string,
    sequence: number,
  ): Promise<void> {
    try {
      const manifest = await s.loadManifest(listKey, sequence);
      if (!manifest) {
        send404(res, `Version ${sequence} not found`);
        return;
      }
      const loteData = await s.loadVersionBytes(listKey, sequence, "lote");
      let entityRows = "";
      if (loteData) {
        try {
          const doc = JSON.parse(loteData);
          const entities = doc?.LoTE?.TrustedEntitiesList ?? [];
          for (const e of entities) {
            const names =
              e?.TrustedEntityInformation?.TEName?.map((n: { value: string }) =>
                escapeHtml(n.value),
              ).join(", ") ?? "";
            const svcs =
              e?.TrustedEntityServices?.map(
                (s: {
                  ServiceInformation: {
                    ServiceName: Array<{ value: string }>;
                    ServiceTypeIdentifier: string;
                  };
                }) =>
                  `<li><strong>${
                    s?.ServiceInformation?.ServiceName?.map(
                      (n: { value: string }) => escapeHtml(n.value),
                    ).join(", ") ?? ""
                  }</strong><br><code>${escapeHtml(s?.ServiceInformation?.ServiceTypeIdentifier ?? "")}</code></li>`,
              ).join("") ?? "";
            entityRows += `<tr><td>${names}</td><td><ul class="service-list">${svcs}</ul></td></tr>`;
          }
        } catch {
          entityRows = `<tr><td colspan="2">Could not parse LoTE</td></tr>`;
        }
      }
      const family = signingConfig
        ? findSigningConfig(signingConfig, listKey)?.family
        : undefined;
      sendHtml(
        res,
        200,
        page(
          `${listKey} - Version ${sequence}`,
          `<h1>${escapeHtml(listKey)} - Version ${sequence}</h1>
${jsonListSubtitle(family)}
${fixturePanelHtml(s.readFixtureMetadata(listKey, sequence))}
<div class="trust-notice"><strong>Trust not evaluated.</strong> Signatures are verified cryptographically but signer trust is not evaluated by this tool.</div>
<div class="card"><h2>List Information</h2>
<table class="kv-table">
<tr><th>Trusted List</th><td>${listChip(manifest.listKey)}</td></tr>
<tr><th>LoTE Identifier</th><td><code>${escapeHtml(manifest.loteIdentifier)}</code></td></tr>
<tr><th>Sequence Number</th><td>${manifest.sequenceNumber}</td></tr>
<tr><th>Issue Date</th><td>${escapeHtml(manifest.issueDate)}</td></tr>
<tr><th>Next Update</th><td>${escapeHtml(manifest.nextUpdateDate)}</td></tr>
<tr><th>Scheme Operator</th><td>${escapeHtml(manifest.schemeOperatorName)}</td></tr>
<tr><th>Territory</th><td>${escapeHtml(manifest.territory)}</td></tr>
<tr><th>Publication Timestamp</th><td>${escapeHtml(manifest.publicationTimestamp)}</td></tr>
</table></div>
<div class="card"><h2>Signature &amp; Validation</h2>
<table class="kv-table">
<tr><th>Signature Valid</th><td>${manifest.signatureValid ? "&#x2705; Yes" : "&#x274C; No"}</td></tr>
<tr><th>ETSI Schema Valid</th><td>${manifest.etsiSchemaValid ? "&#x2705; Yes" : "&#x274C; No"}</td></tr>
<tr><th>Signer Trust</th><td><strong>not evaluated</strong></td></tr>
</table></div>
<div class="card"><h2>Signing Certificate</h2>
<table class="kv-table">
<tr><th>Subject</th><td>${escapeHtml(manifest.certificateSubject)}</td></tr>
<tr><th>Issuer</th><td>${escapeHtml(manifest.certificateIssuer)}</td></tr>
<tr><th>Valid From</th><td>${escapeHtml(manifest.certificateValidFrom)}</td></tr>
<tr><th>Valid To</th><td>${escapeHtml(manifest.certificateValidTo)}</td></tr>
<tr><th>SHA-256</th><td><code>${escapeHtml(manifest.signingCertificateSha256)}</code></td></tr>
</table></div>
${inspectorPanelHtml(
  parseInspectorEvaluation(s.readInspectorEvaluation(listKey, sequence)),
  listKey,
  sequence,
)}
${entityRows ? `<div class="card"><h2>Entities &amp; Services</h2><table class="catalogue-table"><thead><tr><th>Trusted Entity Name (TEName)</th><th>Services</th></tr></thead><tbody>${entityRows}</tbody></table></div>` : ""}
${versionDownloadsHtml(listKey, sequence)}
<div class="card"><h2>Artifact Hashes</h2>
<table class="kv-table">
<tr><th>Compact JAdES SHA-256</th><td><code>${escapeHtml(manifest.compactJadesSha256)}</code></td></tr>
<tr><th>LoTE JSON SHA-256</th><td><code>${escapeHtml(manifest.loteJsonSha256)}</code></td></tr>
</table></div>
`,
        ),
      );
    } catch {
      send500(res, "version-detail-error");
    }
  }

  async function apiListKeys(
    res: ServerResponse,
    _req: IncomingMessage,
  ): Promise<void> {
    try {
      const keys = store.listKeys();
      const result = await Promise.all(
        keys.map(async (key) => {
          const index = await store.loadIndex(key);
          const latest = index?.versions.length
            ? index.versions[index.versions.length - 1]
            : null;
          return {
            listKey: key,
            versionCount: index?.versions.length ?? 0,
            latestSequenceNumber: latest?.sequenceNumber ?? null,
            latestIssueDate: latest?.issueDate ?? null,
            latestNextUpdate: latest?.nextUpdateDate ?? null,
          };
        }),
      );
      sendJson(res, 200, { lists: result }, "no-store");
    } catch {
      sendJson(res, 500, { error: "internal_error" });
    }
  }

  async function apiListDetail(
    res: ServerResponse,
    listKey: string,
  ): Promise<void> {
    try {
      if (publicationReader.formatOf(listKey) === "xml") {
        const versions = await publicationReader.versions(listKey);
        if (versions.length === 0) {
          sendJson(res, 404, {
            error: "not_found",
            message: `List "${listKey}" not found`,
          });
          return;
        }
        sendJson(
          res,
          200,
          { listKey, standard: "TS 119 612", versions },
          "no-store",
        );
        return;
      }
      const index = await store.loadIndex(listKey);
      if (!index) {
        sendJson(res, 404, {
          error: "not_found",
          message: `List "${listKey}" not found`,
        });
        return;
      }
      sendJson(res, 200, index, "no-store");
    } catch {
      sendJson(res, 500, { error: "internal_error" });
    }
  }

  async function apiVersionDetail(
    res: ServerResponse,
    listKey: string,
    sequence: number,
  ): Promise<void> {
    try {
      if (publicationReader.formatOf(listKey) === "xml") {
        const artifacts = publicationReader.xmlVersion(listKey, sequence);
        if (!artifacts) {
          sendJson(res, 404, {
            error: "not_found",
            message: `Version ${sequence} not found`,
          });
          return;
        }
        sendJson(res, 200, artifacts.manifest, "no-store");
        return;
      }
      const manifest = await store.loadManifest(listKey, sequence);
      if (!manifest) {
        sendJson(res, 404, {
          error: "not_found",
          message: `Version ${sequence} not found`,
        });
        return;
      }
      sendJson(res, 200, manifest, "no-store");
    } catch {
      sendJson(res, 500, { error: "internal_error" });
    }
  }

  async function apiVersionFile(
    res: ServerResponse,
    listKey: string,
    sequence: number,
    fileType: "lote" | "signature" | "manifest",
    download = false,
  ): Promise<void> {
    try {
      /*
        An XML Trusted List has a manifest but no `lote` or `signature`: its
        signature is inside the XML. Asking for either of those on an XML list
        is a 404, not an empty file.
      */
      if (publicationReader.formatOf(listKey) === "xml") {
        const artifacts = publicationReader.xmlVersion(listKey, sequence);
        if (fileType !== "manifest" || !artifacts) {
          sendJson(res, 404, {
            error: "not_found",
            message:
              fileType === "manifest"
                ? "File not found or corrupt"
                : "This is a TS 119 612 Trusted List: its artifacts are trusted-list.xml and trusted-list.sha2, and the signature is inside the XML.",
          });
          return;
        }
        sendResponse(
          res,
          200,
          artifacts.manifestBytes,
          "application/json",
          "public, max-age=86400, immutable",
          download
            ? {
                "Content-Disposition": `attachment; filename="${listKey}-v${sequence}-manifest.json"`,
              }
            : undefined,
        );
        return;
      }
      const content = await store.loadVersionBytes(listKey, sequence, fileType);
      if (content === null) {
        sendJson(res, 404, {
          error: "not_found",
          message: "File not found or corrupt",
        });
        return;
      }
      const contentType =
        fileType === "signature" ? "application/jose" : "application/json";
      const cacheControl = "public, max-age=86400, immutable";
      /*
        The version page links these as downloads. A filename is offered so the
        saved file is recognisable, but the bytes are exactly the published
        artifact either way.
      */
      const extra = download
        ? {
            "Content-Disposition": `attachment; filename="${listKey}-v${sequence}-${
              fileType === "signature" ? "lote.jades" : `${fileType}.json`
            }"`,
          }
        : undefined;
      sendResponse(res, 200, content, contentType, cacheControl, extra);
    } catch {
      sendJson(res, 500, { error: "internal_error" });
    }
  }

  /**
   * The stored Trust Inspector evaluation. `?view=1` renders it in the browser
   * instead of offering it as a download.
   */
  function apiInspectorEvaluation(
    res: ServerResponse,
    listKey: string,
    sequence: number,
    view: boolean,
  ): void {
    let stored: string | null = null;
    try {
      /* An XML version stores its evaluation beside its own artifacts. */
      const format = publicationReader.formatOf(listKey) ?? "json";
      stored = publicationReader.inspectorEvaluation(listKey, sequence, format);
    } catch {
      stored = null;
    }
    if (stored === null) {
      sendJson(res, 404, {
        error: "not_found",
        message:
          "No Trust Inspector evaluation is stored for this version. Inspector status is unavailable, which is not a conformance statement.",
      });
      return;
    }
    sendResponse(
      res,
      200,
      stored,
      "application/json",
      "no-store",
      view
        ? undefined
        : {
            "Content-Disposition": `attachment; filename="inspector-${listKey}-v${sequence}.json"`,
          },
    );
  }

  /**
   * The stored negative-fixture evidence of one version, for either standard.
   *
   * A version that is not a fixture has none, and says so with a 404 rather
   * than an empty document: "this version was not generated with defects" and
   * "the defects it was generated with are unknown" are different answers.
   */
  function apiFixtureMetadata(
    res: ServerResponse,
    listKey: string,
    sequence: number,
    view: boolean,
  ): void {
    let stored: string | null = null;
    try {
      stored =
        publicationReader.formatOf(listKey) === "xml"
          ? trustedListStore.readFixtureMetadata(listKey, sequence)
          : store.readFixtureMetadata(listKey, sequence);
    } catch {
      stored = null;
    }
    if (stored === null) {
      sendJson(res, 404, {
        error: "not_found",
        message:
          "This version is not an intentionally broken test fixture, so no fixture metadata is stored for it.",
      });
      return;
    }
    sendResponse(
      res,
      200,
      stored,
      "application/json",
      "no-store",
      view
        ? undefined
        : {
            "Content-Disposition": `attachment; filename="fixture-${listKey}-v${sequence}.json"`,
          },
    );
  }

  /**
   * `GET .../xml` — the version's XML rendition. A TS 119 602 list publishes
   * JSON and a detached Compact JAdES, so the usual answer is 404 saying so
   * rather than an empty document; the Catalogue only links this when the file
   * is actually there.
   */
  function apiVersionXml(
    res: ServerResponse,
    listKey: string,
    sequence: number,
    download: boolean,
  ): void {
    let stored: string | null = null;
    try {
      stored = store.readLoteXml(listKey, sequence);
    } catch {
      stored = null;
    }
    if (stored === null) {
      sendJson(res, 404, {
        error: "not_found",
        message:
          "No XML rendition is published for this version. This is an ETSI TS 119 602 list, which publishes the JSON LoTE and its Compact JAdES signature. The TS 119 612 Trusted Lists publish XML at /trusted-list.xml.",
      });
      return;
    }
    sendResponse(
      res,
      200,
      stored,
      "application/xml",
      "public, max-age=86400, immutable",
      download
        ? {
            "Content-Disposition": `attachment; filename="${listKey}-v${sequence}-lote.xml"`,
          }
        : undefined,
    );
  }

  function handleApi(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    requestId: string,
  ): void {
    const path = url.pathname;
    try {
      if (path === "/api/v1/lists") {
        apiListKeys(res, req);
        logRequest("GET", path, res.statusCode, requestId);
        return;
      }
      const listKeyMatch = path.match(/^\/api\/v1\/lists\/([a-z0-9_.@()-]+)$/);
      if (listKeyMatch) {
        apiListDetail(res, listKeyMatch[1]!);
        logRequest("GET", path, res.statusCode, requestId);
        return;
      }
      const versionMatch = path.match(
        /^\/api\/v1\/lists\/([a-z0-9_.@()-]+)\/versions\/(\d+)$/,
      );
      if (versionMatch) {
        apiVersionDetail(res, versionMatch[1]!, parseInt(versionMatch[2]!, 10));
        logRequest("GET", path, res.statusCode, requestId);
        return;
      }
      /* The XML artifacts, at immutable version URLs ending in the file name. */
      const tslFileMatch = path.match(
        /^\/api\/v1\/lists\/([a-z0-9_.@()-]+)\/versions\/(\d+)\/(trusted-list\.xml|trusted-list\.sha2)$/,
      );
      if (tslFileMatch) {
        serveTrustedListArtifact(
          res,
          tslFileMatch[1]!,
          parseInt(tslFileMatch[2]!, 10),
          tslFileMatch[3]!,
        );
        logRequest("GET", path, res.statusCode, requestId);
        return;
      }

      const fileMatch = path.match(
        /^\/api\/v1\/lists\/([a-z0-9_.@()-]+)\/versions\/(\d+)\/(lote|signature|manifest)$/,
      );
      if (fileMatch) {
        apiVersionFile(
          res,
          fileMatch[1]!,
          parseInt(fileMatch[2]!, 10),
          fileMatch[3]! as "lote" | "signature" | "manifest",
          url.searchParams.get("download") === "1",
        );
        logRequest("GET", path, res.statusCode, requestId);
        return;
      }
      const xmlMatch = path.match(
        /^\/api\/v1\/lists\/([a-z0-9_.@()-]+)\/versions\/(\d+)\/xml$/,
      );
      if (xmlMatch) {
        apiVersionXml(
          res,
          xmlMatch[1]!,
          parseInt(xmlMatch[2]!, 10),
          url.searchParams.get("download") === "1",
        );
        logRequest("GET", path, res.statusCode, requestId);
        return;
      }
      const inspectorMatch = path.match(
        /^\/api\/v1\/lists\/([a-z0-9_.@()-]+)\/versions\/(\d+)\/inspector$/,
      );
      if (inspectorMatch) {
        apiInspectorEvaluation(
          res,
          inspectorMatch[1]!,
          parseInt(inspectorMatch[2]!, 10),
          url.searchParams.get("view") === "1",
        );
        logRequest("GET", path, res.statusCode, requestId);
        return;
      }
      const fixtureMatch = path.match(
        /^\/api\/v1\/lists\/([a-z0-9_.@()-]+)\/versions\/(\d+)\/fixture$/,
      );
      if (fixtureMatch) {
        apiFixtureMetadata(
          res,
          fixtureMatch[1]!,
          parseInt(fixtureMatch[2]!, 10),
          url.searchParams.get("view") === "1",
        );
        logRequest("GET", path, res.statusCode, requestId);
        return;
      }
      sendJson(res, 404, {
        error: "not_found",
        message: "API route not found",
      });
      logRequest("GET", path, 404, requestId);
    } catch {
      sendJson(res, 500, {
        error: "internal_error",
        message: "Internal server error",
        requestId,
      });
      logRequest("GET", path, 500, requestId);
    }
  }

  // --- GUI handlers ---

  function getCookie(req: IncomingMessage, name: string): string | undefined {
    const cookieHeader = req.headers.cookie;
    if (!cookieHeader) return undefined;
    for (const part of cookieHeader.split(";")) {
      const [k, ...v] = part.trim().split("=");
      if (k === name) return decodeURIComponent(v.join("="));
    }
    return undefined;
  }

  function checkAdminAuth(req: IncomingMessage, url: URL): boolean {
    if (!adminToken) return false;
    if (getCookie(req, ADMIN_COOKIE) === adminToken) return true;
    if (url.searchParams.get("token") === adminToken) return true;
    return false;
  }

  /**
   * POST /admin/login — exchanges the configured ADMIN_USER/ADMIN_PASSWORD pair
   * for the existing admin session cookie. The token flow is left untouched.
   */

  /**
   * Shared implementation behind the administration form and the API. Both
   * require the administrator credential; the API accepts the admin token in an
   * Authorization header or the `token` query parameter.
   */
  async function createTrustedListFrom(
    fields: Record<string, string | string[]>,
  ): Promise<CreateListResult> {
    if (!signingConfigPath)
      return {
        success: false,
        error:
          "No signing configuration path is configured, so a Trusted List cannot be declared.",
      };
    const single = (name: string): string => {
      const value = fields[name];
      return (Array.isArray(value) ? value[0] : value)?.trim() ?? "";
    };
    const defectsValue = fields.defects;
    const defects = (
      Array.isArray(defectsValue)
        ? defectsValue
        : defectsValue
          ? [defectsValue]
          : []
    )
      .map((defect) => defect.trim())
      .filter(Boolean);
    const family = single("family");
    if (!isEnabledProfileFamily(family))
      return {
        success: false,
        error: `family must be one of: ${Object.values(PROFILE_REGISTRY)
          .filter((profile) => profile.enabled)
          .map((profile) => profile.family)
          .join(", ")}.`,
      };
    const result = await createTrustedList(
      {
        family,
        schemeName: single("schemeName"),
        schemeOperatorName: single("schemeOperatorName"),
        schemeTerritory: single("schemeTerritory"),
        schemeOperatorStreet: single("schemeOperatorStreet"),
        schemeOperatorCountry: single("schemeOperatorCountry"),
        schemeOperatorEmail: single("schemeOperatorEmail"),
        baseUrl: single("baseUrl"),
        keyFile: single("keyFile"),
        certFile: single("certFile"),
        defects,
      },
      { publicationStore: store, signingConfigPath },
    );
    if (result.success) reloadSigningConfig();
    return result;
  }

  async function handleCreateTrustedList(
    res: ServerResponse,
    fields: Record<string, string>,
    requestId: string,
  ): Promise<void> {
    const result = await createTrustedListFrom(fields);
    const { createListFormHtml, createdListHtml } =
      await import("../web/views/list-creation.js");
    if (!result.success) {
      sendHtml(
        res,
        400,
        guiPage(
          "Create Trusted List",
          createListFormHtml(fields, result.error, {
            canGenerateSigningMaterial: certificatesDir !== undefined,
          }),
        ),
      );
      logRequest("POST", "/admin/lists/create", 400, requestId);
      return;
    }
    sendHtml(
      res,
      200,
      guiPage(
        "Trusted List created",
        createdListHtml({
          listKey: result.listKey,
          family: result.entry.family,
          schemeName: result.entry.schemeName,
          sequenceNumber: result.sequenceNumber,
          inspectorStatus: inspectorStatusLabel(result.inspector.summary),
          inspectorProfile: result.inspector.summary.profile,
          inspectorLevel: result.inspector.summary.conformanceLevel,
          defects: result.entry.defects ?? [],
          expectedInspectorFailures: result.fixture?.expectedFailures.inspector,
          actualInspectorFailures: result.fixture?.actualFailures.inspector,
          missingFailures: result.fixture?.missingFailures,
        }),
      ),
    );
    logRequest("POST", "/admin/lists/create", 200, requestId);
  }

  async function handleGenerateSigningMaterial(
    res: ServerResponse,
    fields: Record<string, string>,
    requestId: string,
  ): Promise<void> {
    const { createListFormHtml } =
      await import("../web/views/list-creation.js");
    const render = (status: number, error?: string, notice?: string): void => {
      sendHtml(
        res,
        status,
        guiPage(
          "Create Trusted List",
          createListFormHtml(fields, error, {
            canGenerateSigningMaterial: certificatesDir !== undefined,
            signingMaterialNotice: notice,
          }),
        ),
      );
      logRequest(
        "POST",
        "/admin/lists/generate-signing-material",
        status,
        requestId,
      );
    };
    if (!certificatesDir) {
      render(400, "TLP_CERTIFICATES_DIR is not configured.");
      return;
    }

    const schemeOperatorName = fields.schemeOperatorName?.trim() ?? "";
    const schemeTerritory = fields.schemeTerritory?.trim() ?? "";
    const listKey = deriveListKeyFromParts(schemeTerritory, schemeOperatorName);
    if (signingConfig?.lists.some((entry) => entry.listKey === listKey)) {
      render(400, `A Trusted List with key "${listKey}" already exists.`);
      return;
    }
    if (store.getHighestStoredSequence(listKey) !== null) {
      render(400, `Publications already exist for list key "${listKey}".`);
      return;
    }

    try {
      const generated = generateSigningMaterial({
        certificatesDir,
        schemeOperatorName,
        schemeTerritory,
      });
      fields.keyFile = generated.keyFile;
      fields.certFile = generated.certFile;
      render(
        200,
        undefined,
        `Signing material generated for ${generated.listKey}. The paths below are ready to use.`,
      );
    } catch (error) {
      render(
        400,
        error instanceof Error
          ? error.message
          : "Signing material could not be generated.",
      );
    }
  }

  /** `POST /api/v1/admin/lists` — same operation, JSON in and JSON out. */
  async function apiCreateTrustedList(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    requestId: string,
  ): Promise<void> {
    if (!apiAdminAuthorized(req, url)) {
      sendJson(res, 403, {
        error: "forbidden",
        message:
          "A valid administrator token is required. Send it as Authorization: Bearer <TLP_ADMIN_TOKEN>.",
      });
      logRequest("POST", url.pathname, 403, requestId);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readBody(req)) as unknown;
    } catch {
      sendJson(res, 400, {
        error: "bad_request",
        message: "Request body must be JSON.",
      });
      logRequest("POST", url.pathname, 400, requestId);
      return;
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      sendJson(res, 400, {
        error: "bad_request",
        message: "Request body must be a JSON object.",
      });
      logRequest("POST", url.pathname, 400, requestId);
      return;
    }
    const record = parsed as Record<string, unknown>;
    const fields: Record<string, string | string[]> = {};
    for (const [key, value] of Object.entries(record)) {
      if (typeof value === "string") fields[key] = value;
      else if (Array.isArray(value))
        fields[key] = value.filter(
          (item): item is string => typeof item === "string",
        );
      else if (value !== undefined && value !== null)
        fields[key] = String(value);
    }
    const result = await createTrustedListFrom(fields);
    if (!result.success) {
      sendJson(res, 400, { error: "bad_request", message: result.error });
      logRequest("POST", url.pathname, 400, requestId);
      return;
    }
    sendJson(
      res,
      201,
      {
        listKey: result.listKey,
        family: result.entry.family,
        schemeName: result.entry.schemeName,
        schemeTerritory: result.entry.schemeTerritory,
        sequenceNumber: result.sequenceNumber,
        versionUrl: `/lists/${result.listKey}/versions/${result.sequenceNumber}`,
        inspector: result.inspector.summary,
        /*
          The GUI and the API create the same artifacts, so the API reports the
          same negative-fixture evidence the confirmation page shows.
        */
        intentionallyBroken: (result.entry.defects ?? []).length > 0,
        defects: result.entry.defects ?? [],
        ...(result.fixture ? { fixture: result.fixture } : {}),
      },
      "no-store",
    );
    logRequest("POST", url.pathname, 201, requestId);
  }

  /**
   * API callers authenticate with the administrator token only — the cookie
   * session belongs to the browser flow and is not accepted here.
   */
  function apiAdminAuthorized(req: IncomingMessage, url: URL): boolean {
    if (!adminToken) return false;
    const header = req.headers.authorization ?? "";
    const bearer = header.startsWith("Bearer ")
      ? header.slice("Bearer ".length).trim()
      : "";
    const supplied = bearer || (url.searchParams.get("token") ?? "");
    return supplied.length > 0 && secretEquals(supplied, adminToken);
  }

  async function handleAdminLogin(
    req: IncomingMessage,
    res: ServerResponse,
    requestId: string,
  ): Promise<void> {
    const { adminLoginHtml } = await import("../web/views/admin.js");

    if (!adminLoginEnabled) {
      sendResponse(
        res,
        403,
        "Access Denied",
        "text/plain; charset=utf-8",
        "no-store",
      );
      logRequest("POST", "/admin/login", 403, requestId);
      return;
    }

    const fields = parseFormBody(await readBody(req));
    const next =
      fields["next"] && fields["next"].startsWith("/admin")
        ? fields["next"]
        : "/admin";

    const ok =
      secretEquals(fields["username"] ?? "", adminUser) &&
      secretEquals(fields["password"] ?? "", adminPassword);

    if (!ok) {
      sendHtml(
        res,
        403,
        guiPage(
          "Sign in",
          adminLoginHtml(next, "Invalid username or password."),
        ),
      );
      logRequest("POST", "/admin/login", 403, requestId);
      return;
    }

    res.writeHead(303, {
      ...securityHeaders(),
      "Set-Cookie": `${ADMIN_COOKIE}=${encodeURIComponent(adminToken)}; Path=/; HttpOnly; SameSite=Lax`,
      "Cache-Control": "no-store",
      Location: next,
    });
    res.end();
    logRequest("POST", "/admin/login", 303, requestId);
  }

  async function handleAdmin(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    requestId: string,
  ): Promise<void> {
    const path = url.pathname;

    // Handle initial admin login via ?token= parameter
    if (url.searchParams.get("token") === adminToken) {
      if (path === "/admin" || path.startsWith("/admin/")) {
        res.writeHead(303, {
          "Set-Cookie": `${ADMIN_COOKIE}=${encodeURIComponent(adminToken)}; Path=/; HttpOnly; SameSite=Lax`,
          Location: path.split("?")[0]!,
        });
        res.end();
        logRequest("GET", path.split("?")[0]!, 303, requestId);
        return;
      }
    }

    if (!checkAdminAuth(req, url)) {
      import("../web/views/admin.js")
        .then(({ adminNoAccessHtml, adminLoginHtml }) => {
          const next = path === "/admin/login" ? "/admin" : path;
          const html = adminLoginEnabled
            ? guiPage("Sign in", adminLoginHtml(next))
            : guiPage("Access Denied", adminNoAccessHtml());
          sendHtml(res, 403, html);
          logRequest("GET", path, 403, requestId);
        })
        .catch(() => {
          sendResponse(
            res,
            403,
            "Access Denied",
            "text/plain; charset=utf-8",
            "no-store",
          );
          logRequest("GET", path, 403, requestId);
        });
      return;
    }

    // An already-signed-in visitor has no use for the sign-in form.
    if (path === "/admin/login") {
      res.writeHead(303, { ...securityHeaders(), Location: "/admin" });
      res.end();
      logRequest("GET", path, 303, requestId);
      return;
    }

    if (path === "/admin/xml-applications" && tslApplicationService) {
      sendHtml(
        res,
        200,
        guiPage(
          "XML Trusted List applications",
          tslApplicationsHtml(tslApplicationService.list()),
        ),
      );
      logRequest("GET", path, 200, requestId);
      return;
    }

    if (path.startsWith("/admin/xml-applications/") && tslApplicationService) {
      const id = path.slice("/admin/xml-applications/".length);
      sendXmlApplication(res, id, requestId, path);
      return;
    }

    if (path === "/admin/trusted-lists/create" && signingConfigPath) {
      sendHtml(
        res,
        200,
        guiPage(
          "Create XML Trusted List",
          createTrustedListFormHtml(
            {},
            { canGenerateMaterial: Boolean(certificatesDir) },
          ),
        ),
      );
      logRequest("GET", path, 200, requestId);
      return;
    }

    if (path === "/admin") {
      import("../web/views/admin.js")
        .then(({ adminIndexHtml }) => {
          sendHtml(res, 200, guiPage("Administration", adminIndexHtml()));
          logRequest("GET", path, 200, requestId);
        })
        .catch(() => {
          send500(res, requestId);
          logRequest("GET", path, 500, requestId);
        });
      return;
    }

    if (path === "/admin/applications" && appService) {
      const stateFilter = url.searchParams.get("state") ?? undefined;
      import("../web/views/admin.js")
        .then(({ adminApplicationsHtml }) => {
          const apps = appService!.listApplications();
          sendHtml(
            res,
            200,
            guiPage("Applications", adminApplicationsHtml(apps, stateFilter)),
          );
          logRequest("GET", path, 200, requestId);
        })
        .catch(() => {
          send500(res, requestId);
          logRequest("GET", path, 500, requestId);
        });
      return;
    }

    if (path === "/admin/lists/create" && signingConfigPath) {
      import("../web/views/list-creation.js")
        .then(({ createListFormHtml }) => {
          sendHtml(
            res,
            200,
            guiPage(
              "Create Trusted List",
              createListFormHtml(
                {},
                url.searchParams.get("error") ?? undefined,
                {
                  canGenerateSigningMaterial: certificatesDir !== undefined,
                },
              ),
            ),
          );
          logRequest("GET", path, 200, requestId);
        })
        .catch(() => {
          send500(res, requestId);
          logRequest("GET", path, 500, requestId);
        });
      return;
    }

    if (path === "/admin/settings" && settingsStore) {
      import("../web/views/admin.js")
        .then(({ adminSettingsHtml }) => {
          sendHtml(
            res,
            200,
            guiPage(
              "Settings",
              adminSettingsHtml(
                settingsStore!.load(),
                settingsListsByFamily(),
                url.searchParams.get("saved") === "1",
              ),
            ),
          );
          logRequest("GET", path, 200, requestId);
        })
        .catch(() => {
          send500(res, requestId);
          logRequest("GET", path, 500, requestId);
        });
      return;
    }

    if (path === "/admin/signing" && signingConfig) {
      import("../web/views/admin.js")
        .then(({ adminSigningConfigHtml }) => {
          const entries = signingConfigDisplay(signingConfig!);
          sendHtml(
            res,
            200,
            guiPage("Signing Configuration", adminSigningConfigHtml(entries)),
          );
          logRequest("GET", path, 200, requestId);
        })
        .catch(() => {
          send500(res, requestId);
          logRequest("GET", path, 500, requestId);
        });
      return;
    }

    const appDetailMatch = path.match(/^\/admin\/applications\/([a-f0-9-]+)$/);
    if (appDetailMatch && appService) {
      const app = appService.getApplication(appDetailMatch[1]!);
      if (!app) {
        send404(res, "Application not found");
        logRequest("GET", path, 404, requestId);
        return;
      }
      const detailParams = {
        error: url.searchParams.get("error") ?? undefined,
        warning: url.searchParams.get("warning") ?? undefined,
        success: url.searchParams.get("success") ?? undefined,
        published: url.searchParams.get("published") ?? undefined,
      };
      import("../web/views/admin.js")
        .then(async ({ adminApplicationDetailHtml }) => {
          let etsiStatus:
            | {
                valid: boolean;
                findings: Array<{ path: string; message: string }>;
              }
            | undefined;
          let compilerInputJson: string | undefined;
          let previewMeta:
            | {
                existingEntityCount: number;
                resultingEntityCount: number;
                currentSequence: number | null;
                proposedSequence: number | null;
              }
            | undefined;

          if (appService) {
            const previewResult = await appService.preview(app);
            if (previewResult.compilerInputJson) {
              compilerInputJson = previewResult.compilerInputJson;
            }
            if (previewResult.etsiValid !== null) {
              etsiStatus = {
                valid: previewResult.etsiValid,
                findings: previewResult.etsiFindings,
              };
            }
            // Pass preview metadata
            previewMeta = {
              existingEntityCount: previewResult.existingEntityCount,
              resultingEntityCount: previewResult.resultingEntityCount,
              currentSequence: previewResult.currentSequence,
              proposedSequence: previewResult.proposedSequence,
            };
          }

          sendHtml(
            res,
            200,
            guiPage(
              `Application ${app.id.slice(0, 8)}`,
              adminApplicationDetailHtml(
                app,
                detailParams,
                etsiStatus,
                compilerInputJson,
                previewMeta,
              ),
            ),
          );
          logRequest("GET", path, 200, requestId);
        })
        .catch(() => {
          send500(res, requestId);
          logRequest("GET", path, 500, requestId);
        });
      return;
    }

    send404(res);
    logRequest("GET", path, 404, requestId);
  }

  /** Target-list options for one XML onboarding family. */
  function trustedListOptionsFor(family: TslFamily): TrustedListOption[] {
    if (!signingConfig) return [];
    return getTrustedListConfigsForFamily(signingConfig, family).map(
      (entry) => ({
        key: entry.listKey,
        label: `${entry.schemeOperatorName} (${entry.listKey})`,
        territory: entry.schemeTerritory,
      }),
    );
  }

  /** The two XML onboarding routes, declared once for GET and POST. */
  const XML_ONBOARDING: ReadonlyArray<{
    readonly path: string;
    readonly family: TslFamily;
    readonly title: string;
    readonly render: typeof eaaProviderFormHtml;
  }> = Object.freeze([
    {
      path: "/onboarding/eaa-provider",
      family: "eaa-providers" as TslFamily,
      title: "EAA Provider Application",
      render: eaaProviderFormHtml,
    },
    {
      path: "/onboarding/qeaa-provider",
      family: "qeaa-providers" as TslFamily,
      title: "QEAA Provider Application",
      render: qeaaProviderFormHtml,
    },
  ]);

  function xmlOnboardingFor(
    path: string,
  ): (typeof XML_ONBOARDING)[number] | undefined {
    return XML_ONBOARDING.find((form) => form.path === path);
  }

  async function handleXmlSubmission(
    res: ServerResponse,
    body: string,
    requestId: string,
    form: (typeof XML_ONBOARDING)[number],
  ): Promise<void> {
    if (!tslApplicationService) {
      send404(res);
      logRequest("POST", form.path, 404, requestId);
      return;
    }
    const fields = parseFormBody(body);
    const parsed = parseTslSubmission(fields, {
      family: form.family,
      trustedLists: signingConfig?.trustedLists ?? [],
      submittedAt: new Date().toISOString(),
    });
    if (!parsed.ok) {
      const errors: Record<string, string> = {};
      for (const error of parsed.errors) errors[error.field] = error.message;
      sendHtml(
        res,
        400,
        guiPage(
          form.title,
          form.render(fields, errors, trustedListOptionsFor(form.family)),
        ),
      );
      logRequest("POST", form.path, 400, requestId);
      return;
    }
    const record = tslApplicationService.submit(parsed.value);
    const auto = await tslApplicationService.autoApproveIfEnabled(record);
    const message = auto.published
      ? "Your application was approved and published automatically."
      : (auto.message ??
        "Your application was submitted and is awaiting administrator review.");
    sendHtml(
      res,
      200,
      guiPage(
        "Application submitted",
        `<h1>Application submitted</h1>
         <p>${escapeHtml(message)}</p>
         <p>Reference: <code>${escapeHtml(record.id)}</code></p>
         <p><a class="btn btn-primary btn-md" href="/onboarding">Back to onboarding</a></p>`,
      ),
    );
    logRequest("POST", form.path, 200, requestId);
  }

  async function handleCreateXmlTrustedList(
    req: IncomingMessage,
    res: ServerResponse,
    fields: Record<string, string>,
    multi: Record<string, string[]>,
    url: URL,
    requestId: string,
  ): Promise<void> {
    if (!signingConfigPath) {
      send404(res);
      logRequest("POST", "/admin/trusted-lists/create", 404, requestId);
      return;
    }
    const lines = (value: string): string[] =>
      value
        .split(/[\r\n]+/)
        .map((line) => line.trim())
        .filter((line) => line !== "");
    const result = await createTrustedListList(
      {
        schemeOperatorName: fields["schemeOperatorName"] ?? "",
        schemeTerritory: (fields["schemeTerritory"] ?? "").toUpperCase(),
        schemeName: fields["schemeName"] ?? "",
        schemeOperatorStreet: fields["schemeOperatorStreet"] ?? "",
        schemeOperatorLocality: fields["schemeOperatorLocality"] ?? "",
        ...(fields["schemeOperatorPostalCode"]
          ? { schemeOperatorPostalCode: fields["schemeOperatorPostalCode"] }
          : {}),
        schemeOperatorCountry: (
          fields["schemeOperatorCountry"] ?? ""
        ).toUpperCase(),
        schemeOperatorEmail: fields["schemeOperatorEmail"] ?? "",
        schemeOperatorWebsite: fields["schemeOperatorWebsite"] ?? "",
        ...(fields["schemeOperatorTelephone"]
          ? { schemeOperatorTelephone: fields["schemeOperatorTelephone"] }
          : {}),
        schemeInformationUri: fields["schemeInformationUri"] ?? "",
        nationalSchemeRulesUri: fields["nationalSchemeRulesUri"] ?? "",
        policyUri: fields["policyUri"] ?? "",
        distributionPointUri: fields["distributionPointUri"] ?? "",
        lotlCertificatesBase64Der: lines(
          fields["lotlCertificatesBase64Der"] ?? "",
        ),
        lotlSchemeOperatorNames: lines(fields["lotlSchemeOperatorNames"] ?? ""),
        keyFile: fields["keyFile"] ?? "",
        certFile: fields["certFile"] ?? "",
        allowedServiceProfiles: multi["allowedServiceProfiles"] ?? [],
        defects: multi["defects"] ?? [],
      },
      {
        store: trustedListStore,
        signingConfigPath,
        inspectorClient,
        publicBaseUrl: requestPublicOrigin(req, url),
      },
    );
    if (!result.success) {
      sendHtml(
        res,
        400,
        guiPage(
          "Create XML Trusted List",
          createTrustedListFormHtml(
            {
              ...fields,
              allowedServiceProfiles: multi["allowedServiceProfiles"],
              defects: multi["defects"],
            },
            {
              error: result.error,
              canGenerateMaterial: Boolean(certificatesDir),
            },
          ),
        ),
      );
      logRequest("POST", "/admin/trusted-lists/create", 400, requestId);
      return;
    }
    reloadSigningConfig();
    /*
      A healthy list goes straight to its page. A broken one stops at a
      confirmation that states what was asked for and what actually failed:
      nobody should have to open the version page to discover that the fixture
      they generated did not produce the defect they selected.
    */
    if (result.fixture) {
      sendHtml(
        res,
        200,
        guiPage(
          "Intentionally broken Trusted List created",
          `<h1>Intentionally broken Trusted List created</h1>
<p>${listChip(result.listKey)} <span class="chip chip-standard">ETSI TS 119 612</span> <span class="chip chip-format">XML / XAdES-B-B</span></p>
${brokenListSectionHtml(result.fixture.selectedDefects, "TS 119 612")}
${fixturePanelHtml(JSON.stringify(result.fixture))}
<p><a class="btn btn-primary btn-md" href="/lists/${encodeURIComponent(result.listKey)}">Open the Trusted List</a>
<a class="btn btn-outline btn-md" href="/api/v1/lists/${encodeURIComponent(result.listKey)}/versions/${result.sequenceNumber}/trusted-list.xml">Download the XML</a></p>`,
        ),
      );
      logRequest("POST", "/admin/trusted-lists/create", 200, requestId);
      return;
    }
    res.writeHead(303, {
      ...securityHeaders(),
      "Cache-Control": "no-store",
      Location: `/lists/${encodeURIComponent(result.listKey)}`,
    });
    res.end();
    logRequest("POST", "/admin/trusted-lists/create", 303, requestId);
  }

  /**
   * The XML counterpart of `handleGenerateSigningMaterial`. It generates the
   * TS 119 612 Scheme Operator profile, whose certificate carries the
   * `tslSigning` extended key usage, and returns the same form with every
   * entered value preserved and the two paths filled in.
   */
  async function handleGenerateXmlSigningMaterial(
    res: ServerResponse,
    fields: Record<string, string>,
    multi: Record<string, string[]>,
    requestId: string,
  ): Promise<void> {
    const render = (status: number, error?: string, notice?: string): void => {
      sendHtml(
        res,
        status,
        guiPage(
          "Create XML Trusted List",
          createTrustedListFormHtml(
            {
              ...fields,
              allowedServiceProfiles: multi["allowedServiceProfiles"],
              defects: multi["defects"],
            },
            {
              ...(error ? { error } : {}),
              ...(notice ? { notice } : {}),
              canGenerateMaterial: Boolean(certificatesDir),
            },
          ),
        ),
      );
      logRequest(
        "POST",
        "/admin/trusted-lists/generate-signing-material",
        status,
        requestId,
      );
    };
    if (!certificatesDir) {
      render(400, "TLP_CERTIFICATES_DIR is not configured.");
      return;
    }

    const schemeOperatorName = fields["schemeOperatorName"]?.trim() ?? "";
    const schemeTerritory = (fields["schemeTerritory"] ?? "")
      .trim()
      .toUpperCase();
    fields["schemeTerritory"] = schemeTerritory;
    const listKey = deriveListKeyFromParts(schemeTerritory, schemeOperatorName);
    if (
      signingConfig?.lists.some((entry) => entry.listKey === listKey) ||
      signingConfig?.trustedLists?.some((entry) => entry.listKey === listKey)
    ) {
      render(400, `A Trusted List with key "${listKey}" already exists.`);
      return;
    }
    if (trustedListStore.getHighestStoredSequence(listKey) !== null) {
      render(400, `Publications already exist for list key "${listKey}".`);
      return;
    }

    try {
      const generated = generateSigningMaterial({
        certificatesDir,
        schemeOperatorName,
        schemeTerritory,
        profile: "trusted-list",
      });
      fields["keyFile"] = generated.keyFile;
      fields["certFile"] = generated.certFile;
      render(
        200,
        undefined,
        `Signing material generated for ${generated.listKey}. The paths below are ready to use.`,
      );
    } catch (error) {
      render(
        400,
        error instanceof Error
          ? error.message
          : "Signing material could not be generated.",
      );
    }
  }

  /**
   * `POST /api/v1/admin/trusted-lists` — declare a TS 119 612 XML Trusted List.
   *
   * The API counterpart of the Create XML Trusted List form, and deliberately a
   * thin one: it validates the token, forwards the same fields to the same core
   * function, and reports the same fixture evidence the confirmation page shows.
   * The GUI and the API therefore produce the same artifacts, which is a
   * property the fixture suite depends on rather than an aspiration.
   */
  async function apiCreateXmlTrustedList(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    requestId: string,
  ): Promise<void> {
    if (!apiAdminAuthorized(req, url)) {
      sendJson(res, 403, {
        error: "forbidden",
        message:
          "A valid administrator token is required. Send it as Authorization: Bearer <TLP_ADMIN_TOKEN>.",
      });
      logRequest("POST", url.pathname, 403, requestId);
      return;
    }
    if (!signingConfigPath) {
      sendJson(res, 404, {
        error: "not_found",
        message:
          "This server has no signing configuration, so it cannot declare a Trusted List.",
      });
      logRequest("POST", url.pathname, 404, requestId);
      return;
    }
    let record: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(await readBody(req));
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed)
      )
        throw new Error("not an object");
      record = parsed as Record<string, unknown>;
    } catch {
      sendJson(res, 400, {
        error: "bad_request",
        message: "Request body must be a JSON object.",
      });
      logRequest("POST", url.pathname, 400, requestId);
      return;
    }

    const text = (field: string): string =>
      typeof record[field] === "string" ? (record[field] as string) : "";
    const list = (field: string): string[] =>
      Array.isArray(record[field])
        ? (record[field] as unknown[]).filter(
            (item): item is string => typeof item === "string",
          )
        : [];

    const result = await createTrustedListList(
      {
        schemeOperatorName: text("schemeOperatorName"),
        schemeTerritory: text("schemeTerritory").toUpperCase(),
        schemeName: text("schemeName"),
        schemeOperatorStreet: text("schemeOperatorStreet"),
        schemeOperatorLocality: text("schemeOperatorLocality"),
        ...(text("schemeOperatorPostalCode")
          ? { schemeOperatorPostalCode: text("schemeOperatorPostalCode") }
          : {}),
        schemeOperatorCountry: text("schemeOperatorCountry").toUpperCase(),
        schemeOperatorEmail: text("schemeOperatorEmail"),
        schemeOperatorWebsite: text("schemeOperatorWebsite"),
        ...(text("schemeOperatorTelephone")
          ? { schemeOperatorTelephone: text("schemeOperatorTelephone") }
          : {}),
        schemeInformationUri: text("schemeInformationUri"),
        nationalSchemeRulesUri: text("nationalSchemeRulesUri"),
        policyUri: text("policyUri"),
        distributionPointUri: text("distributionPointUri"),
        lotlCertificatesBase64Der: list("lotlCertificatesBase64Der"),
        lotlSchemeOperatorNames: list("lotlSchemeOperatorNames"),
        keyFile: text("keyFile"),
        certFile: text("certFile"),
        allowedServiceProfiles: list("allowedServiceProfiles"),
        defects: list("defects"),
        ...(record["seedFixtureProvider"] === true
          ? { seedFixtureProvider: true }
          : {}),
        ...(text("listKey") ? { listKey: text("listKey") } : {}),
      },
      {
        store: trustedListStore,
        signingConfigPath,
        inspectorClient,
        publicBaseUrl: requestPublicOrigin(req, url),
      },
    );
    if (!result.success) {
      sendJson(res, 400, { error: "bad_request", message: result.error });
      logRequest("POST", url.pathname, 400, requestId);
      return;
    }
    reloadSigningConfig();
    sendJson(
      res,
      201,
      {
        listKey: result.listKey,
        standard: "TS 119 612",
        artifactFormat: "XML / XAdES-B-B",
        schemeName: result.entry.schemeName,
        schemeTerritory: result.entry.schemeTerritory,
        allowedServiceProfiles: result.entry.allowedServiceProfiles,
        sequenceNumber: result.sequenceNumber,
        versionUrl: `/lists/${result.listKey}/versions/${result.sequenceNumber}`,
        xmlUrl: `/api/v1/lists/${result.listKey}/versions/${result.sequenceNumber}/trusted-list.xml`,
        sha2Url: `/api/v1/lists/${result.listKey}/versions/${result.sequenceNumber}/trusted-list.sha2`,
        ...(result.inspector ? { inspector: result.inspector.summary } : {}),
        intentionallyBroken: Boolean(result.fixture),
        defects: result.fixture?.selectedDefects ?? [],
        ...(result.fixture ? { fixture: result.fixture } : {}),
      },
      "no-store",
    );
    logRequest("POST", url.pathname, 201, requestId);
  }

  /** Renders one XML application review page. */
  function sendXmlApplication(
    res: ServerResponse,
    id: string,
    requestId: string,
    path: string,
    extra: { message?: string; error?: string } = {},
  ): void {
    if (!tslApplicationService) {
      send404(res);
      logRequest("GET", path, 404, requestId);
      return;
    }
    const record = tslApplicationService.get(id);
    if (!record) {
      send404(res);
      logRequest("GET", path, 404, requestId);
      return;
    }
    const preview = tslApplicationService.preview(id);
    sendHtml(
      res,
      200,
      guiPage(
        record.tspName,
        tslApplicationDetailHtml({
          record,
          ...(preview.ok && preview.value ? { preview: preview.value } : {}),
          ...(preview.ok ? {} : { previewError: preview.error ?? "" }),
          ...extra,
        }),
      ),
    );
    logRequest("GET", path, 200, requestId);
  }

  async function handleXmlApplicationAction(
    res: ServerResponse,
    path: string,
    body: string,
    requestId: string,
  ): Promise<void> {
    if (!tslApplicationService) {
      send404(res);
      logRequest("POST", path, 404, requestId);
      return;
    }
    const parts = path.split("/");
    const id = parts[3] ?? "";
    const action = parts[4] ?? "";
    const fields = parseFormBody(body);

    let message: string | undefined;
    let error: string | undefined;
    switch (action) {
      case "approve": {
        const result = tslApplicationService.approve(id);
        if (result.ok) message = "Application approved.";
        else error = result.error;
        break;
      }
      case "reject": {
        const result = tslApplicationService.reject(id, fields["note"] ?? "");
        if (result.ok) message = "Application rejected.";
        else error = result.error;
        break;
      }
      case "publish": {
        const result = await tslApplicationService.publish(id);
        if (result.ok) message = "Published as a new immutable version.";
        else error = result.error;
        break;
      }
      case "supersede": {
        const result = await tslApplicationService.supersede(id);
        if (result.ok)
          message =
            "Published a new immutable version; the previous state is in ServiceHistory.";
        else error = result.error;
        break;
      }
      case "delete": {
        const result = tslApplicationService.delete(id);
        if (result.ok) {
          res.writeHead(303, {
            ...securityHeaders(),
            "Cache-Control": "no-store",
            Location: "/admin/xml-applications",
          });
          res.end();
          logRequest("POST", path, 303, requestId);
          return;
        }
        error = result.error;
        break;
      }
      default:
        send404(res);
        logRequest("POST", path, 404, requestId);
        return;
    }
    sendXmlApplication(res, id, requestId, path, {
      ...(message ? { message } : {}),
      ...(error ? { error } : {}),
    });
  }

  function handleOnboarding(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    requestId: string,
  ): void {
    const path = url.pathname;

    const xmlForm = xmlOnboardingFor(path);
    if (xmlForm) {
      sendHtml(
        res,
        200,
        guiPage(
          xmlForm.title,
          xmlForm.render({}, {}, trustedListOptionsFor(xmlForm.family)),
        ),
      );
      logRequest("GET", path, 200, requestId);
      return;
    }

    if (path === "/onboarding") {
      import("../web/views/onboarding.js")
        .then((mod) => {
          sendHtml(
            res,
            200,
            guiPage("Onboarding", mod.onboardingCatalogueHtml()),
          );
          logRequest("GET", path, 200, requestId);
        })
        .catch(() => {
          send500(res, requestId);
          logRequest("GET", path, 500, requestId);
        });
      return;
    }

    const onboardingForm = onboardingFormFor(path);
    if (onboardingForm) {
      import("../web/views/onboarding.js")
        .then((mod) => {
          sendHtml(
            res,
            200,
            guiPage(
              onboardingForm.title,
              onboardingForm.render(mod)(
                {},
                {},
                listOptionsFor(onboardingForm.family),
              ),
            ),
          );
          logRequest("GET", path, 200, requestId);
        })
        .catch(() => {
          send500(res, requestId);
          logRequest("GET", path, 500, requestId);
        });
      return;
    }

    const submittedMatch = path.match(
      /^\/onboarding\/submitted\/([a-f0-9-]+)$/,
    );
    if (submittedMatch && appService) {
      const app = appService.getApplication(submittedMatch[1]!);
      if (!app) {
        send404(res, "Application not found");
        logRequest("GET", path, 404, requestId);
        return;
      }
      const auto = url.searchParams.get("auto");
      const autoError = url.searchParams.get("error");
      const outcome =
        auto === "published"
          ? `<p>This Trusted List is set to auto-approve, so the application was
             approved and published without administrator review.</p>`
          : auto === "failed"
            ? `<div class="error-msg">Automatic publication failed:
               ${escapeHtml(autoError ?? "unknown error")}. An administrator will
               review the application.</div>`
            : `<p>An administrator will review your application. Keep this ID for reference.</p>`;
      import("../web/views/colors.js")
        .then(({ listChip, familyChip }) => {
          sendHtml(
            res,
            200,
            guiPage(
              "Application Submitted",
              `<h1>Application Submitted</h1>
<div class="card">
<h2>&#x2705; Your application has been submitted.</h2>
<table class="kv-table">
<tr><th>Application ID</th><td><code>${escapeHtml(app.id)}</code></td></tr>
<tr><th>Status</th><td><span class="badge info">${escapeHtml(app.state)}</span></td></tr>
<tr><th>Submitted</th><td>${escapeHtml(app.submittedAt)}</td></tr>
<tr><th>Entity</th><td>${escapeHtml(app.applicantData.entityName)}</td></tr>
<tr><th>Trusted List Family</th><td>${familyChip(app.family)}</td></tr>
<tr><th>Target Trusted List</th><td>${listChip(app.targetListKey)}</td></tr>
</table>
${outcome}
</div>
<p><a href="/" class="btn">Return to Catalogue</a></p>`,
            ),
          );
          logRequest("GET", path, 200, requestId);
        })
        .catch(() => {
          send500(res, requestId);
          logRequest("GET", path, 500, requestId);
        });
      return;
    }

    send404(res);
    logRequest("GET", path, 404, requestId);
  }

  async function handleGuiPost(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    requestId: string,
  ): Promise<void> {
    const path = url.pathname;

    // Sign-in is the one admin POST that is reachable without a session.
    if (path === "/admin/login") {
      await handleAdminLogin(req, res, requestId);
      return;
    }

    if (path.startsWith("/admin") && !checkAdminAuth(req, url)) {
      sendResponse(
        res,
        403,
        "Access Denied",
        "text/plain; charset=utf-8",
        "no-store",
      );
      logRequest("POST", path, 403, requestId);
      return;
    }

    try {
      const body = await readBody(req);

      if (path === "/admin/settings" && settingsStore) {
        settingsStore.save(settingsFromForm(parseFormBody(body)));
        res.writeHead(303, {
          ...securityHeaders(),
          "Cache-Control": "no-store",
          Location: "/admin/settings?saved=1",
        });
        res.end();
        logRequest("POST", path, 303, requestId);
        return;
      }

      if (path === "/admin/lists/create") {
        await handleCreateTrustedList(res, parseFormBody(body), requestId);
        return;
      }

      if (path === "/admin/lists/generate-signing-material") {
        await handleGenerateSigningMaterial(
          res,
          parseFormBody(body),
          requestId,
        );
        return;
      }

      const xmlSubmission = xmlOnboardingFor(path);
      if (xmlSubmission) {
        await handleXmlSubmission(res, body, requestId, xmlSubmission);
        return;
      }

      if (path === "/admin/trusted-lists/generate-signing-material") {
        await handleGenerateXmlSigningMaterial(
          res,
          parseFormBody(body),
          parseFormBodyMulti(body),
          requestId,
        );
        return;
      }

      if (path === "/admin/trusted-lists/create") {
        await handleCreateXmlTrustedList(
          req,
          res,
          parseFormBody(body),
          parseFormBodyMulti(body),
          url,
          requestId,
        );
        return;
      }

      if (
        path.startsWith("/admin/xml-applications/") &&
        tslApplicationService
      ) {
        await handleXmlApplicationAction(res, path, body, requestId);
        return;
      }

      const submissionForm = onboardingFormFor(path);
      if (submissionForm) {
        await handleSubmitApplication(
          res,
          body,
          requestId,
          submissionForm.family,
        );
        return;
      }

      if (path.startsWith("/admin/applications/") && appService) {
        const parts = path.split("/");
        const action = parts[4];
        const appId = parts[3];
        if (!appId || !action) {
          send404(res);
          logRequest("POST", path, 404, requestId);
          return;
        }

        switch (action) {
          case "approve": {
            const r = appService.approve(appId);
            if (r.success) {
              res.writeHead(303, {
                Location: `/admin/applications/${appId}`,
              });
              res.end();
              logRequest("POST", path, 303, requestId);
            } else {
              redirectWithParams(res, appId, { error: r.error });
              logRequest("POST", path, 400, requestId);
            }
            break;
          }
          case "reject": {
            const fields = parseFormBody(body);
            const r = appService.reject(appId, fields["note"] ?? "");
            if (r.success) {
              res.writeHead(303, {
                Location: `/admin/applications/${appId}`,
              });
              res.end();
              logRequest("POST", path, 303, requestId);
            } else {
              redirectWithParams(res, appId, { error: r.error });
              logRequest("POST", path, 400, requestId);
            }
            break;
          }
          case "publish": {
            const r = await appService.publishApplication(appId);
            if (r.success) {
              const params: Record<string, string> = {};
              if (r.message) params.success = r.message;
              if (r.warning) params.warning = r.warning;
              redirectWithParams(res, appId, params);
              logRequest("POST", path, 303, requestId);
            } else {
              redirectWithParams(res, appId, { error: r.error });
              logRequest("POST", path, 400, requestId);
            }
            break;
          }
          case "withdraw": {
            const r = await appService.withdrawApplication(appId);
            if (r.success) {
              const params: Record<string, string> = {};
              if (r.message) params.success = r.message;
              if (r.warning) params.warning = r.warning;
              redirectWithParams(res, appId, params);
              logRequest("POST", path, 303, requestId);
            } else {
              redirectWithParams(res, appId, { error: r.error });
              logRequest("POST", path, 400, requestId);
            }
            break;
          }
          case "delete": {
            const r = appService.deleteApplication(appId);
            if (r.success) {
              res.writeHead(303, {
                Location: "/admin/applications",
              });
              res.end();
              logRequest("POST", path, 303, requestId);
            } else {
              redirectWithParams(res, appId, { error: r.error });
              logRequest("POST", path, 400, requestId);
            }
            break;
          }
          default:
            send404(res);
            logRequest("POST", path, 404, requestId);
        }
        return;
      }

      send404(res);
      logRequest("POST", path, 404, requestId);
    } catch {
      send500(res, requestId);
      logRequest("POST", path, 500, requestId);
    }
  }

  async function handleSubmitApplication(
    res: ServerResponse,
    body: string,
    requestId: string,
    family: EnabledProfileFamily,
  ): Promise<void> {
    const form = onboardingFormForFamily(family);
    if (!appService) {
      send500(res, requestId);
      logRequest("POST", form.path, 500, requestId);
      return;
    }

    const fields = parseFormBody(body);

    let targetListKey = fields["targetListKey"] ?? "";
    const configuredLists = familyListKeys[family];
    if (!targetListKey && configuredLists.length === 1) {
      targetListKey = configuredLists[0]!;
    }

    const result = appService.submitApplication(fields, targetListKey, family);

    if (!result.valid) {
      const errMap: Record<string, string> = {};
      for (const fe of result.errors) {
        errMap[fe.field] = fe.message;
      }
      const formValues = result.preservedFields;
      formValues["targetListKey"] = targetListKey;
      import("../web/views/onboarding.js")
        .then((mod) => {
          sendHtml(
            res,
            400,
            guiPage(
              form.title,
              form.render(mod)(formValues, errMap, listOptionsFor(family)),
            ),
          );
          logRequest("POST", form.path, 400, requestId);
        })
        .catch(() => {
          send500(res, requestId);
          logRequest("POST", form.path, 500, requestId);
        });
      return;
    }

    const app = appService.createApp(
      targetListKey,
      result.applicantData,
      family,
    );

    const auto = await appService.autoApproveIfEnabled(app);
    const query = auto.applied
      ? auto.published
        ? "?auto=published"
        : `?auto=failed&error=${encodeURIComponent(auto.error ?? "Automatic publication failed.")}`
      : "";

    res.writeHead(303, { Location: `/onboarding/submitted/${app.id}${query}` });
    res.end();
    logRequest("POST", form.path, 303, requestId);
  }

  function redirectWithParams(
    res: ServerResponse,
    appId: string,
    params: Record<string, string>,
  ): void {
    const qs = Object.entries(params)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}=${encodeURIComponent(v!)}`)
      .join("&");
    res.writeHead(303, {
      Location: `/admin/applications/${appId}${qs ? "?" + qs : ""}`,
    });
    res.end();
  }

  function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let data = "";
      let length = 0;
      const maxBody = 2 * 1024 * 1024;
      req.on("data", (chunk: Buffer) => {
        length += chunk.length;
        if (length > maxBody) {
          req.destroy(new Error("Request body too large"));
          return;
        }
        data += chunk.toString();
      });
      req.on("end", () => resolve(data));
      req.on("error", reject);
    });
  }

  function parseFormBody(body: string): Record<string, string> {
    const fields: Record<string, string> = {};
    for (const pair of body.split("&")) {
      const [key, val] = pair.split("=");
      if (key) {
        fields[decodeURIComponent(key)] = val
          ? decodeURIComponent(val.replace(/\+/g, " "))
          : "";
      }
    }
    return fields;
  }

  /**
   * The same body, keeping every value of a repeated field.
   *
   * `parseFormBody` keeps the last value, which is right for text inputs and
   * wrong for a checkbox group: a list accepting both EAA and QEAA posts
   * `allowedServiceProfiles` twice.
   */
  function parseFormBodyMulti(body: string): Record<string, string[]> {
    const fields: Record<string, string[]> = {};
    for (const pair of body.split("&")) {
      const [key, val] = pair.split("=");
      if (!key) continue;
      const name = decodeURIComponent(key);
      const value = val ? decodeURIComponent(val.replace(/\+/g, " ")) : "";
      (fields[name] ??= []).push(value);
    }
    return fields;
  }

  return server;
}
