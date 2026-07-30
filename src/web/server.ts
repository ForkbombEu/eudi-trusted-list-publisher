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
  getWalletProviderConfigs,
  getFamilyConfigs,
  signingConfigDisplay,
  ApplicationService,
  createTrustedList,
  type CreateListResult,
  type PublisherSettings,
  type SigningConfig,
  type PIDProviderApplicantData,
  type WalletProviderApplicantData,
} from "../core/authoring/index.js";
import {
  certificateGuideHtml,
  CERTIFICATE_GUIDE_PATH,
  CERTIFICATE_GUIDE_TITLE,
} from "./views/certificate-guide.js";
import {
  inspectorPanelHtml,
  parseInspectorEvaluation,
  versionDownloadsHtml,
} from "./views/inspector-panel.js";
import { inspectorStatusLabel } from "../core/inspector/inspector.js";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".jades": "application/octet-stream",
  ".txt": "text/plain; charset=utf-8",
};

const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;
const ADMIN_COOKIE = "tlp_admin_token";

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
    path: "/api/v1/lists/{listKey}/versions/{sequence}/inspector",
    matcher:
      /^\/api\/v1\/lists\/([a-z0-9_.@()-]+)\/versions\/(\d+)\/inspector$/,
    handler: "getInspectorEvaluation",
  },
  {
    method: "POST",
    path: "/api/v1/admin/lists",
    matcher: /^\/api\/v1\/admin\/lists$/,
    handler: "createTrustedList",
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

  let authoringStore: AuthoringStore | null = null;
  let settingsStore: SettingsStore | null = null;
  let signingConfig: SigningConfig | null = null;
  let appService: ApplicationService | null = null;
  let walletProviderLists: string[] = [];
  let pidProviderLists: string[] = [];

  if (guiEnabled && config.authoringDir) {
    authoringStore = new AuthoringStore({ authoringDir: config.authoringDir });
    // Administrator settings are mutable state, so they live beside the
    // authoring records rather than in the immutable publication store.
    settingsStore = new SettingsStore({ settingsDir: config.authoringDir });
  }
  const signingConfigPath = guiEnabled ? config.signingConfigPath : undefined;

  /*
    Creating a Trusted List appends to the signing configuration, so the
    in-memory view is rebuilt afterwards. Without this the new list would not
    appear on the onboarding forms until the server restarted.
  */
  function reloadSigningConfig(): void {
    if (!signingConfigPath) return;
    signingConfig = loadSigningConfig(signingConfigPath);
    walletProviderLists = getWalletProviderConfigs(signingConfig).map(
      (entry) => entry.listKey,
    );
    pidProviderLists = getFamilyConfigs(signingConfig, "pid-providers").map(
      (entry) => entry.listKey,
    );
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
        The only mutating API route. It is handled here rather than in
        handleApi(), which serves the read-only published artifacts.
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
      handleApi(req, res, url, requestId);
      return;
    }

    if (path === "/") {
      serveCatalogue(res, store);
      logRequest("GET", path, res.statusCode, requestId);
      return;
    }

    const listMatch = path.match(/^\/lists\/([a-z0-9_.@()-]+)$/);
    if (listMatch) {
      serveListDetail(res, store, listMatch[1]!);
      logRequest("GET", path, res.statusCode, requestId);
      return;
    }

    const versionMatch = path.match(
      /^\/lists\/([a-z0-9_.@()-]+)\/versions\/(\d+)$/,
    );
    if (versionMatch) {
      serveVersionDetail(
        res,
        store,
        versionMatch[1]!,
        parseInt(versionMatch[2]!, 10),
      );
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
        const index = await s.loadIndex(key);
        if (!index) continue;
        const latest = index.versions[index.versions.length - 1];
        if (!latest) continue;
        const family = signingConfig
          ? findSigningConfig(signingConfig, key)?.family
          : undefined;
        rows += `
      <tr>
        <td><a href="/lists/${escapeHtml(key)}">${listChip(key)}</a></td>
        <td>${family ? familyChip(family) : "&mdash;"}</td>
        <td>${escapeHtml(String(latest.sequenceNumber))}</td>
        <td>${escapeHtml(latest.issueDate)}</td>
        <td>${escapeHtml(latest.nextUpdateDate)}</td>
        <td>${latest.signatureValid ? "&#x2705; valid" : "&#x274C; invalid"}</td>
        <td><strong>not evaluated</strong></td>
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
        <thead><tr><th>Trusted List</th><th>Trusted List Family</th><th>Latest Seq</th><th>Issue Date</th><th>Next Update</th><th>Signature</th><th>Trust</th></tr></thead>
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
        <td>${escapeHtml(v.publicationTimestamp)}</td>
        <td>${v.signatureValid ? "&#x2705; valid" : "&#x274C; invalid"}</td>
      </tr>`;
      }
      const { listChip, familyChip } = await import("./views/colors.js");
      const family = signingConfig
        ? findSigningConfig(signingConfig, listKey)?.family
        : undefined;
      sendHtml(
        res,
        200,
        page(
          `List: ${listKey}`,
          `<h1>Trusted List: ${listChip(listKey)}</h1>
        ${family ? `<p>Trusted List Family: ${familyChip(family)}</p>` : ""}
        <div class="trust-notice"><strong>Trust not evaluated.</strong></div>
        <table class="catalogue-table">
        <thead><tr><th>Sequence</th><th>Issue Date</th><th>Next Update</th><th>Published</th><th>Signature</th></tr></thead>
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
                  };
                }) =>
                  s?.ServiceInformation?.ServiceName?.map(
                    (n: { value: string }) => escapeHtml(n.value),
                  ).join(", ") ?? "",
              ).join("; ") ?? "";
            entityRows += `<tr><td>${names}</td><td>${svcs}</td></tr>`;
          }
        } catch {
          entityRows = `<tr><td colspan="2">Could not parse LoTE</td></tr>`;
        }
      }
      const { listChip } = await import("./views/colors.js");
      sendHtml(
        res,
        200,
        page(
          `Version ${sequence} — ${listKey}`,
          `<h1>Version ${sequence} — ${listChip(listKey)}</h1>
<div class="trust-notice"><strong>Signer trust: not evaluated.</strong> Cryptographic signature is ${manifest.signatureValid ? "valid" : "INVALID"}.</div>
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
${entityRows ? `<div class="card"><h2>Entities &amp; Services</h2><table class="catalogue-table"><thead><tr><th>Entity</th><th>Services</th></tr></thead><tbody>${entityRows}</tbody></table></div>` : ""}
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
      stored = store.readInspectorEvaluation(listKey, sequence);
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
    if (family !== "wallet-providers" && family !== "pid-providers")
      return {
        success: false,
        error: "family must be wallet-providers or pid-providers.",
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
          createListFormHtml(fields, result.error),
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
        }),
      ),
    );
    logRequest("POST", "/admin/lists/create", 200, requestId);
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

  function handleOnboarding(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    requestId: string,
  ): void {
    const path = url.pathname;

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

    if (path === "/onboarding/wallet-provider") {
      import("../web/views/onboarding.js")
        .then((mod) => {
          sendHtml(
            res,
            200,
            guiPage(
              "Wallet Provider Application",
              mod.walletProviderFormHtml(
                {},
                {},
                signingConfig
                  ? getWalletProviderConfigs(signingConfig).map((e) => ({
                      key: e.listKey,
                      label: `${e.schemeOperatorName} (${e.listKey})`,
                    }))
                  : [],
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

    if (path === "/onboarding/pid-provider") {
      import("../web/views/onboarding.js")
        .then((mod) => {
          sendHtml(
            res,
            200,
            guiPage(
              "PID Provider Application",
              mod.pidProviderFormHtml(
                {},
                {},
                signingConfig
                  ? getFamilyConfigs(signingConfig, "pid-providers").map(
                      (entry) => ({
                        key: entry.listKey,
                        label: `${entry.schemeOperatorName} (${entry.listKey})`,
                      }),
                    )
                  : [],
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

      if (path === "/onboarding/wallet-provider") {
        await handleSubmitApplication(res, body, requestId, "wallet-providers");
        return;
      }
      if (path === "/onboarding/pid-provider") {
        await handleSubmitApplication(res, body, requestId, "pid-providers");
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
    family: "wallet-providers" | "pid-providers",
  ): Promise<void> {
    if (!appService) {
      send500(res, requestId);
      logRequest(
        "POST",
        `/onboarding/${family === "pid-providers" ? "pid-provider" : "wallet-provider"}`,
        500,
        requestId,
      );
      return;
    }

    const fields = parseFormBody(body);

    let targetListKey = fields["targetListKey"] ?? "";
    const configuredLists =
      family === "pid-providers" ? pidProviderLists : walletProviderLists;
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
              family === "pid-providers"
                ? "PID Provider Application"
                : "Wallet Provider Application",
              (family === "pid-providers"
                ? mod.pidProviderFormHtml
                : mod.walletProviderFormHtml)(
                formValues,
                errMap,
                signingConfig
                  ? getFamilyConfigs(signingConfig, family).map((e) => ({
                      key: e.listKey,
                      label: `${e.schemeOperatorName} (${e.listKey})`,
                    }))
                  : [],
              ),
            ),
          );
          logRequest(
            "POST",
            `/onboarding/${family === "pid-providers" ? "pid-provider" : "wallet-provider"}`,
            400,
            requestId,
          );
        })
        .catch(() => {
          send500(res, requestId);
          logRequest(
            "POST",
            `/onboarding/${family === "pid-providers" ? "pid-provider" : "wallet-provider"}`,
            500,
            requestId,
          );
        });
      return;
    }

    const applicantData = result.applicantData;
    const app =
      family === "pid-providers"
        ? isPidApplicantData(applicantData)
          ? appService.createApp(targetListKey, applicantData, "pid-providers")
          : (() => {
              throw new Error(
                "PID Provider submission did not produce PID applicant data.",
              );
            })()
        : isWalletApplicantData(applicantData)
          ? appService.createApp(
              targetListKey,
              applicantData,
              "wallet-providers",
            )
          : (() => {
              throw new Error(
                "Wallet Provider submission did not produce Wallet applicant data.",
              );
            })();

    const auto = await appService.autoApproveIfEnabled(app);
    const query = auto.applied
      ? auto.published
        ? "?auto=published"
        : `?auto=failed&error=${encodeURIComponent(auto.error ?? "Automatic publication failed.")}`
      : "";

    res.writeHead(303, { Location: `/onboarding/submitted/${app.id}${query}` });
    res.end();
    logRequest(
      "POST",
      `/onboarding/${family === "pid-providers" ? "pid-provider" : "wallet-provider"}`,
      303,
      requestId,
    );
  }

  function isPidApplicantData(
    applicantData: WalletProviderApplicantData | PIDProviderApplicantData,
  ): applicantData is PIDProviderApplicantData {
    return "responsibleMemberState" in applicantData;
  }

  function isWalletApplicantData(
    applicantData: WalletProviderApplicantData | PIDProviderApplicantData,
  ): applicantData is WalletProviderApplicantData {
    return !("responsibleMemberState" in applicantData);
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

  return server;
}
