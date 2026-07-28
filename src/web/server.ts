import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve, extname } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";
import { PublicationStore } from "../core/publication/store.js";
import { compile } from "../core/compile/compile.js";
import { validateEtsiStruct } from "../core/validate/validate.js";
import { sign as signLote } from "../core/signing/signing.js";
import { verify } from "../core/verification/verification.js";
import { publish, PublicationError } from "../core/publication/manifest.js";
import {
  AuthoringStore,
  canTransition,
  normalizeToAuthoringInput,
  loadSigningConfig,
  findSigningConfig,
  signingConfigDisplay,
  loadSigningKey,
  type WalletProviderApplication,
  type SigningConfig,
  type WalletProviderApplicantData,
} from "../core/authoring/index.js";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".jades": "application/octet-stream",
  ".txt": "text/plain; charset=utf-8",
};

const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;

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

function htmlPage(title: string, body: string, guiNav?: string): string {
  const extraNav = guiNav ?? "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
${APPLY_CSS}
</head>
<body>
<header class="topbar">
  <div class="topbar-inner">
    <a href="/" class="logo-link">
      <img src="/assets/credimi_logo.svg" alt="Credimi" class="logo" height="32">
      <span class="product-title">Trusted List Publisher</span>
    </a>
    <nav class="topbar-nav">
      <a href="/">Catalogue</a>
${extraNav}
      <a href="/docs">API Docs</a>
      <a href="/openapi.yaml">OpenAPI</a>
      <a href="https://github.com/ForkbombEu/eudi-trusted-list-publisher">Repository</a>
    </nav>
  </div>
</header>
<main class="content">
${body}
</main>
<footer class="site-footer dark">
  <div class="footer-inner">
    <img src="/assets/credimi_logo_negative.svg" alt="Credimi" class="footer-logo" height="24">
    <p>Credimi &mdash; read-only publication viewer</p>
    <p>Signer trust status: not evaluated. This tool does not establish PKIX trust.</p>
  </div>
</footer>
<script>
console.log(
  "%cCredimi %cTrusted List Publisher",
  "color: #2563eb; font-weight: bold; font-size: 1.2em;",
  "color: #1e293b;"
);
console.log("%cread-only publication viewer", "color: #64748b;");
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
  signingConfigPath?: string;
  schemeOperatorName?: string;
  schemeName?: string;
  schemeTerritory?: string;
  schemeOperatorStreet?: string;
  schemeOperatorCountry?: string;
  schemeOperatorContactUri?: string;
  distributionPointUri?: string;
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
): void {
  const headers: Record<string, string> = {
    ...securityHeaders(),
    "Content-Type": contentType,
    "Cache-Control": cacheControl,
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
  const st = statSync(filePath);
  if (st.size > maxBytes) return null;
  return readFileSync(filePath, "utf-8");
}

export interface ApiRoute {
  method: "GET";
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
];

export function getApiRoutes(): ReadonlyArray<ApiRoute> {
  return API_ROUTES;
}

export function createWebServer(config: ServerConfig) {
  const assetsDir = config.assetsDir
    ? resolve(config.assetsDir)
    : resolve(process.cwd(), "src", "web", "assets");
  const maxFileBytes = config.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const guiEnabled = config.dataCollectionGui === true;
  const adminToken = config.adminToken ?? "";

  const store = new PublicationStore({
    publicationDir: config.publicationDir,
  });

  let authoringStore: AuthoringStore | null = null;
  let signingConfig: SigningConfig | null = null;

  if (guiEnabled && config.authoringDir) {
    authoringStore = new AuthoringStore({ authoringDir: config.authoringDir });
  }
  if (guiEnabled && config.signingConfigPath) {
    try {
      signingConfig = loadSigningConfig(config.signingConfigPath);
    } catch {
      signingConfig = { lists: [] };
    }
  }

  const schemeDefaults = {
    operatorName: config.schemeOperatorName ?? "Credimi",
    schemeName: config.schemeName ?? "EU Wallet Providers List",
    schemeTerritory: config.schemeTerritory ?? "EU",
    operatorStreet: config.schemeOperatorStreet ?? "Via Roma 1",
    operatorCountry: config.schemeOperatorCountry ?? "IT",
    operatorContactUri: config.schemeOperatorContactUri ?? "https://credimi.eu",
    distributionPointUri:
      config.distributionPointUri ??
      "https://credimi.eu/wallet-providers/latest",
  };

  function guiPage(title: string, body: string): string {
    const guiNav = `
      <a href="/onboarding">Onboarding</a>
      <a href="/admin">Admin</a>`;
    return htmlPage(title, body, guiNav);
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

    if (path.startsWith("/api/v1/")) {
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
    const path = resolve(assetsDir, name);
    const content = readFileBounded(path, maxFileBytes);
    if (content === null) {
      if (!existsSync(path)) {
        send404(res);
      } else {
        send413(res);
      }
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
    const path = resolve(assetsDir, "openapi.yaml");
    const content = readFileBounded(path, maxFileBytes);
    if (content === null) {
      send404(res, "OpenAPI spec not found");
      return;
    }
    if (format === "yaml") {
      sendResponse(res, 200, content, "application/yaml", "no-store");
    } else {
      try {
        const parsed = parseYaml(content);
        // Validate basic OpenAPI structure
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

  function serveDocs(res: ServerResponse): void {
    const html = htmlPage(
      "API Documentation",
      `
<div class="api-docs">
  <h1>API Documentation</h1>
  <p>This is a read-only API for published Wallet Provider LoTEs.</p>
  <div id="stoplight-elements" style="min-height: 600px;"></div>
  <script src="https://unpkg.com/@stoplight/elements@7.15.0/web-components.min.js"></script>
  <link rel="stylesheet" href="https://unpkg.com/@stoplight/elements@7.15.0/styles.min.css">
  <script>
    StoplightElements.createElement("elements-api", {
      apiDescriptionUrl: "/openapi.yaml",
      router: "hash",
      layout: "sidebar",
    }, document.getElementById("stoplight-elements"));
  </script>
</div>
`,
    );
    sendHtml(res, 200, html);
  }

  async function serveCatalogue(
    res: ServerResponse,
    s: PublicationStore,
  ): Promise<void> {
    try {
      const keys = s.listKeys();
      if (keys.length === 0) {
        sendHtml(
          res,
          200,
          htmlPage(
            "Catalogue",
            `<h1>Published Lists</h1><div class="card"><p>No lists have been published yet.</p><p>Use <code>trusted-list-publisher publish</code> to publish a LoTE.</p></div>`,
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
        rows += `
      <tr>
        <td><a href="/lists/${escapeHtml(key)}"><code>${escapeHtml(key)}</code></a></td>
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
        htmlPage(
          "Catalogue",
          `<h1>Published Lists</h1>
        <div class="trust-notice"><strong>&#x26A0; Trust not evaluated.</strong> Signatures are verified cryptographically but signer trust is not evaluated by this tool.</div>
        <table class="catalogue-table">
        <thead><tr><th>List Key</th><th>Latest Seq</th><th>Issue Date</th><th>Next Update</th><th>Signature</th><th>Trust</th></tr></thead>
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

      sendHtml(
        res,
        200,
        htmlPage(
          `List: ${listKey}`,
          `<h1>List: <code>${escapeHtml(listKey)}</code></h1>
        <div class="trust-notice"><strong>&#x26A0; Trust not evaluated.</strong></div>
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

      sendHtml(
        res,
        200,
        htmlPage(
          `Version ${sequence} — ${listKey}`,
          `<h1>Version ${sequence} — <code>${escapeHtml(listKey)}</code></h1>

<div class="trust-notice"><strong>&#x26A0; Signer trust: not evaluated.</strong> Cryptographic signature is ${manifest.signatureValid ? "valid" : "INVALID"}.</div>

<div class="card">
<h2>List Information</h2>
<table class="kv-table">
<tr><th>List Key</th><td><code>${escapeHtml(manifest.listKey)}</code></td></tr>
<tr><th>LoTE Identifier</th><td><code>${escapeHtml(manifest.loteIdentifier)}</code></td></tr>
<tr><th>Sequence Number</th><td>${manifest.sequenceNumber}</td></tr>
<tr><th>Issue Date</th><td>${escapeHtml(manifest.issueDate)}</td></tr>
<tr><th>Next Update</th><td>${escapeHtml(manifest.nextUpdateDate)}</td></tr>
<tr><th>Scheme Operator</th><td>${escapeHtml(manifest.schemeOperatorName)}</td></tr>
<tr><th>Territory</th><td>${escapeHtml(manifest.territory)}</td></tr>
<tr><th>Publication Timestamp</th><td>${escapeHtml(manifest.publicationTimestamp)}</td></tr>
</table>
</div>

<div class="card">
<h2>Signature &amp; Validation</h2>
<table class="kv-table">
<tr><th>Signature Valid</th><td>${manifest.signatureValid ? "&#x2705; Yes" : "&#x274C; No"}</td></tr>
<tr><th>ETSI Schema Valid</th><td>${manifest.etsiSchemaValid ? "&#x2705; Yes" : "&#x274C; No"}</td></tr>
<tr><th>Signer Trust</th><td><strong>not evaluated</strong></td></tr>
</table>
</div>

<div class="card">
<h2>Signing Certificate</h2>
<table class="kv-table">
<tr><th>Subject</th><td>${escapeHtml(manifest.certificateSubject)}</td></tr>
<tr><th>Issuer</th><td>${escapeHtml(manifest.certificateIssuer)}</td></tr>
<tr><th>Valid From</th><td>${escapeHtml(manifest.certificateValidFrom)}</td></tr>
<tr><th>Valid To</th><td>${escapeHtml(manifest.certificateValidTo)}</td></tr>
<tr><th>SHA-256</th><td><code>${escapeHtml(manifest.signingCertificateSha256)}</code></td></tr>
</table>
</div>

${
  entityRows
    ? `
<div class="card">
<h2>Entities &amp; Services</h2>
<table class="catalogue-table">
<thead><tr><th>Entity</th><th>Services</th></tr></thead>
<tbody>${entityRows}</tbody>
</table>
</div>`
    : ""
}

<div class="card">
<h2>Downloads</h2>
<ul>
<li><a href="/api/v1/lists/${escapeHtml(listKey)}/versions/${String(sequence)}/signature">Compact JAdES artifact (lote.jades)</a></li>
<li><a href="/api/v1/lists/${escapeHtml(listKey)}/versions/${String(sequence)}/lote">Decoded LoTE JSON</a></li>
<li><a href="/api/v1/lists/${escapeHtml(listKey)}/versions/${String(sequence)}/manifest">Publication manifest</a></li>
</ul>
</div>

<div class="card">
<h2>Artifact Hashes</h2>
<table class="kv-table">
<tr><th>Compact JAdES SHA-256</th><td><code>${escapeHtml(manifest.compactJadesSha256)}</code></td></tr>
<tr><th>LoTE JSON SHA-256</th><td><code>${escapeHtml(manifest.loteJsonSha256)}</code></td></tr>
</table>
</div>
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

      const contentType = (() => {
        switch (fileType) {
          case "lote":
            return "application/json";
          case "signature":
            return "application/octet-stream";
          case "manifest":
            return "application/json";
        }
      })();

      const cacheControl =
        fileType === "manifest"
          ? "public, max-age=86400, immutable"
          : "public, max-age=86400, immutable";

      sendResponse(res, 200, content, contentType, cacheControl);
    } catch {
      sendJson(res, 500, { error: "internal_error" });
    }
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

  function handleOnboarding(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    requestId: string,
  ): void {
    const path = url.pathname;

    if (path === "/onboarding") {
      import("../web/views/onboarding.js")
        .then(({ onboardingCatalogueHtml }) => {
          sendHtml(res, 200, guiPage("Onboarding", onboardingCatalogueHtml()));
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
        .then(({ walletProviderFormHtml }) => {
          sendHtml(
            res,
            200,
            guiPage("Wallet Provider Application", walletProviderFormHtml()),
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
    if (submittedMatch && authoringStore) {
      const appId = submittedMatch[1]!;
      const app = authoringStore.load(appId);
      if (!app) {
        send404(res, "Application not found");
        logRequest("GET", path, 404, requestId);
        return;
      }
      sendHtml(
        res,
        200,
        guiPage(
          "Application Submitted",
          `<h1>Application Submitted</h1>
<div class="test-notice"><strong>&#x26A0; Testing tool.</strong></div>
<div class="card">
<h2>&#x2705; Your application has been submitted.</h2>
<table class="kv-table">
<tr><th>Application ID</th><td><code>${escapeHtml(app.id)}</code></td></tr>
<tr><th>Status</th><td><span class="badge info">${escapeHtml(app.state)}</span></td></tr>
<tr><th>Submitted</th><td>${escapeHtml(app.submittedAt)}</td></tr>
<tr><th>Entity</th><td>${escapeHtml(app.applicantData.entityName)}</td></tr>
</table>
<p>An administrator will review your application. Keep this ID for reference.</p>
</div>
<p><a href="/" class="btn">Return to Catalogue</a></p>`,
        ),
      );
      logRequest("GET", path, 200, requestId);
      return;
    }

    send404(res);
    logRequest("GET", path, 404, requestId);
  }

  function handleAdmin(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    requestId: string,
  ): void {
    const path = url.pathname;

    if (adminToken && !checkAdminAuth(url)) {
      import("../web/views/admin.js")
        .then(({ adminNoAccessHtml }) => {
          sendHtml(res, 403, guiPage("Access Denied", adminNoAccessHtml()));
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

    if (path === "/admin/applications" && authoringStore) {
      const stateFilter = url.searchParams.get("state") ?? undefined;
      import("../web/views/admin.js")
        .then(({ adminApplicationsHtml }) => {
          const apps = authoringStore!.list();
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
    if (appDetailMatch && authoringStore) {
      const app = authoringStore.load(appDetailMatch[1]!);
      if (!app) {
        send404(res, "Application not found");
        logRequest("GET", path, 404, requestId);
        return;
      }
      import("../web/views/admin.js")
        .then(({ adminApplicationDetailHtml }) => {
          sendHtml(
            res,
            200,
            guiPage(
              `Application ${app.id.slice(0, 8)}`,
              adminApplicationDetailHtml(app),
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

    if (path.startsWith("/admin") && adminToken && !checkAdminAuth(url)) {
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

      if (path === "/onboarding/wallet-provider") {
        handleSubmitApplication(res, body, requestId);
        return;
      }

      if (path.startsWith("/admin/applications/") && authoringStore) {
        const parts = path.split("/");
        const action = parts[4];
        const appId = parts[3];
        if (!appId || !action) {
          send404(res);
          logRequest("POST", path, 404, requestId);
          return;
        }

        switch (action) {
          case "approve":
            await handleApprove(res, appId, requestId);
            break;
          case "reject":
            await handleReject(res, appId, body, requestId);
            break;
          case "publish":
            await handlePublish(res, appId, requestId);
            break;
          case "delete":
            await handleDelete(res, appId, requestId);
            break;
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

  function handleSubmitApplication(
    res: ServerResponse,
    body: string,
    requestId: string,
  ): void {
    if (!authoringStore) {
      send500(res, requestId);
      logRequest("POST", "/onboarding/wallet-provider", 500, requestId);
      return;
    }

    const fields = parseFormBody(body);
    const errors = validateApplicationForm(fields);

    if (Object.keys(errors).length > 0) {
      import("../web/views/onboarding.js")
        .then(({ walletProviderFormHtml }) => {
          sendHtml(
            res,
            400,
            guiPage(
              "Wallet Provider Application",
              walletProviderFormHtml(fields, errors),
            ),
          );
          logRequest("POST", "/onboarding/wallet-provider", 400, requestId);
        })
        .catch(() => {
          send500(res, requestId);
          logRequest("POST", "/onboarding/wallet-provider", 500, requestId);
        });
      return;
    }

    const services = parseServicesFromForm(fields);
    const applicantData: WalletProviderApplicantData = {
      entityName: fields["entityName"] ?? "",
      entityTradeName: fields["entityTradeName"] || undefined,
      entityStreetAddress: fields["entityStreetAddress"] ?? "",
      entityLocality: fields["entityLocality"] || undefined,
      entityPostalCode: fields["entityPostalCode"] || undefined,
      entityCountry: fields["entityCountry"] ?? "",
      entityInformationURI: fields["entityInformationURI"] ?? "",
      services,
    };

    const app: WalletProviderApplication = {
      id: authoringStore.createId(),
      schemaVersion: 1,
      family: "wallet-providers",
      state: "submitted",
      submittedAt: new Date().toISOString(),
      applicantData,
    };

    authoringStore.save(app);

    res.writeHead(303, { Location: `/onboarding/submitted/${app.id}` });
    res.end();
    logRequest("POST", "/onboarding/wallet-provider", 303, requestId);
  }

  async function handleApprove(
    res: ServerResponse,
    appId: string,
    requestId: string,
  ): Promise<void> {
    if (!authoringStore) return;
    const app = authoringStore.load(appId);
    if (!app) {
      send404(res, "Application not found");
      logRequest(
        "POST",
        `/admin/applications/${appId}/approve`,
        404,
        requestId,
      );
      return;
    }
    if (!canTransition(app.state, "approved")) {
      redirectWithError(
        res,
        appId,
        "Cannot approve application in state: " + app.state,
      );
      logRequest(
        "POST",
        `/admin/applications/${appId}/approve`,
        400,
        requestId,
      );
      return;
    }

    app.state = "approved";
    app.approvedAt = new Date().toISOString();
    authoringStore.save(app);

    res.writeHead(303, { Location: `/admin/applications/${appId}` });
    res.end();
    logRequest("POST", `/admin/applications/${appId}/approve`, 303, requestId);
  }

  async function handleReject(
    res: ServerResponse,
    appId: string,
    body: string,
    requestId: string,
  ): Promise<void> {
    if (!authoringStore) return;
    const app = authoringStore.load(appId);
    if (!app) {
      send404(res, "Application not found");
      logRequest("POST", `/admin/applications/${appId}/reject`, 404, requestId);
      return;
    }
    if (!canTransition(app.state, "rejected")) {
      redirectWithError(
        res,
        appId,
        "Cannot reject application in state: " + app.state,
      );
      logRequest("POST", `/admin/applications/${appId}/reject`, 400, requestId);
      return;
    }

    const fields = parseFormBody(body);
    const note = (fields["note"] ?? "").trim();
    if (!note) {
      redirectWithError(res, appId, "Rejection note is required");
      logRequest("POST", `/admin/applications/${appId}/reject`, 400, requestId);
      return;
    }

    app.state = "rejected";
    app.rejectedAt = new Date().toISOString();
    app.adminNote = note;
    authoringStore.save(app);

    res.writeHead(303, { Location: `/admin/applications/${appId}` });
    res.end();
    logRequest("POST", `/admin/applications/${appId}/reject`, 303, requestId);
  }

  async function handlePublish(
    res: ServerResponse,
    appId: string,
    requestId: string,
  ): Promise<void> {
    if (!authoringStore) return;
    const app = authoringStore.load(appId);
    if (!app) {
      send404(res, "Application not found");
      logRequest(
        "POST",
        `/admin/applications/${appId}/publish`,
        404,
        requestId,
      );
      return;
    }
    if (!canTransition(app.state, "published")) {
      redirectWithError(
        res,
        appId,
        "Cannot publish application in state: " + app.state,
      );
      logRequest(
        "POST",
        `/admin/applications/${appId}/publish`,
        400,
        requestId,
      );
      return;
    }

    const now = new Date();
    const listIssueDateTime = now.toISOString();
    const nextUpdate = new Date(
      now.getTime() + 180 * 24 * 60 * 60 * 1000,
    ).toISOString();

    let nextSeq = 1;
    const existingIndex = await store.loadIndex("eu_credimi");
    if (existingIndex && existingIndex.versions.length > 0) {
      nextSeq =
        existingIndex.versions[existingIndex.versions.length - 1]!
          .sequenceNumber + 1;
    }

    const input = normalizeToAuthoringInput(
      app,
      schemeDefaults.operatorName,
      schemeDefaults.schemeName,
      schemeDefaults.schemeTerritory,
      {
        streetAddress: schemeDefaults.operatorStreet,
        country: schemeDefaults.operatorCountry,
      },
      schemeDefaults.operatorContactUri,
      schemeDefaults.distributionPointUri,
      listIssueDateTime,
      nextUpdate,
      nextSeq,
    );

    try {
      const compileResult = compile(input);
      const etsiResult = await validateEtsiStruct(compileResult.document);
      if (!etsiResult.valid) {
        const reasons = etsiResult.findings
          .map(
            (f: { path: string; message: string }) => f.path + ": " + f.message,
          )
          .join("; ");
        redirectWithError(res, appId, "ETSI validation failed: " + reasons);
        logRequest(
          "POST",
          `/admin/applications/${appId}/publish`,
          400,
          requestId,
        );
        return;
      }

      if (!signingConfig) {
        redirectWithError(
          res,
          appId,
          "No signing configuration available. Configure TLP_SIGNING_CONFIG.",
        );
        logRequest(
          "POST",
          `/admin/applications/${appId}/publish`,
          400,
          requestId,
        );
        return;
      }

      const listEntry = findSigningConfig(signingConfig, "eu_credimi");
      if (!listEntry) {
        redirectWithError(
          res,
          appId,
          "No signing configuration found for list key 'eu_credimi'. Check signing-config.",
        );
        logRequest(
          "POST",
          `/admin/applications/${appId}/publish`,
          400,
          requestId,
        );
        return;
      }

      const keyPem = loadSigningKey(listEntry.keyFile);
      const certPem = loadSigningKey(listEntry.certFile);

      const privateKey = (await import("node:crypto")).createPrivateKey(keyPem);
      const jwk = privateKey.export({ format: "jwk" });
      const signingKey = await crypto.subtle.importKey(
        "jwk",
        jwk as JsonWebKey,
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["sign"],
      );

      const signed = await signLote({
        document: compileResult.document,
        key: signingKey,
        certificatePem: certPem,
      });

      const verifyResult = await verify({
        compactJws: signed.compact,
        certificatePem: certPem,
      });
      if (!verifyResult.valid) {
        redirectWithError(res, appId, "Post-sign verification failed");
        logRequest(
          "POST",
          `/admin/applications/${appId}/publish`,
          400,
          requestId,
        );
        return;
      }

      const pubResult = await publish({
        compactJws: signed.compact,
        certificatePem: certPem,
      });
      const manifestJson = JSON.stringify(pubResult.manifest, null, 2);

      const storeResult = await store.store(
        pubResult,
        signed.compact,
        pubResult.loteJson,
        manifestJson,
      );

      const manifestHash = createHash("sha256")
        .update(manifestJson)
        .digest("hex");

      app.state = "published";
      app.publication = {
        listKey: pubResult.listKey,
        sequenceNumber: pubResult.sequenceNumber,
        manifestSha256: manifestHash,
        compactJadesSha256: pubResult.manifest.compactJadesSha256,
        publicationTimestamp: pubResult.manifest.publicationTimestamp,
      };
      authoringStore.save(app);

      let successMsg = "Application published successfully.";
      if (storeResult.indexWarning) {
        successMsg += " Warning: " + storeResult.indexWarning;
      }

      res.writeHead(303, {
        Location: `/admin/applications/${appId}?published=1`,
      });
      res.end();
      logRequest(
        "POST",
        `/admin/applications/${appId}/publish`,
        303,
        requestId,
      );
    } catch (e) {
      const msg =
        e instanceof PublicationError
          ? e.message
          : e instanceof Error
            ? e.message
            : "Publication failed";
      redirectWithError(res, appId, msg);
      logRequest(
        "POST",
        `/admin/applications/${appId}/publish`,
        400,
        requestId,
      );
    }
  }

  async function handleDelete(
    res: ServerResponse,
    appId: string,
    requestId: string,
  ): Promise<void> {
    if (!authoringStore) return;
    const app = authoringStore.load(appId);
    if (!app) {
      send404(res, "Application not found");
      logRequest("POST", `/admin/applications/${appId}/delete`, 404, requestId);
      return;
    }
    if (app.state === "published") {
      redirectWithError(res, appId, "Cannot delete published application");
      logRequest("POST", `/admin/applications/${appId}/delete`, 400, requestId);
      return;
    }

    authoringStore.delete(appId);
    res.writeHead(303, { Location: "/admin/applications" });
    res.end();
    logRequest("POST", `/admin/applications/${appId}/delete`, 303, requestId);
  }

  function checkAdminAuth(url: URL): boolean {
    if (!adminToken) return true;
    const token = url.searchParams.get("token");
    if (token === adminToken) return true;
    return false;
  }

  function redirectWithError(
    res: ServerResponse,
    appId: string,
    error: string,
  ): void {
    const encoded = encodeURIComponent(error);
    res.writeHead(303, {
      Location: `/admin/applications/${appId}?error=${encoded}`,
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

  function validateApplicationForm(
    fields: Record<string, string>,
  ): Record<string, string> {
    const errors: Record<string, string> = {};

    if (!fields["entityName"]?.trim()) {
      errors["entityName"] = "Entity name is required.";
    }
    if (!fields["entityStreetAddress"]?.trim()) {
      errors["entityStreetAddress"] = "Street address is required.";
    }
    if (!fields["entityCountry"]?.trim()) {
      errors["entityCountry"] = "Country is required.";
    } else if (!/^[A-Z]{2}$/.test(fields["entityCountry"]?.trim() ?? "")) {
      errors["entityCountry"] =
        "Country must be a 2-letter ISO code (e.g. IT).";
    }
    if (!fields["entityInformationURI"]?.trim()) {
      errors["entityInformationURI"] = "Information URI is required.";
    } else {
      try {
        new URL(fields["entityInformationURI"]?.trim() ?? "");
      } catch {
        errors["entityInformationURI"] = "Information URI must be a valid URL.";
      }
    }

    const serviceFields = Object.keys(fields).filter((k) =>
      k.startsWith("service["),
    );
    const serviceIndices = new Set<number>();
    for (const kf of serviceFields) {
      const m = kf.match(/^service\[(\d+)\]\./);
      if (m) serviceIndices.add(parseInt(m[1]!, 10));
    }

    if (serviceIndices.size === 0) {
      errors["services"] = "At least one service is required.";
    }

    for (const idx of serviceIndices) {
      const prefix = `service[${idx}].`;

      if (!fields[`${prefix}serviceType`]?.trim()) {
        errors[`${prefix}serviceType`] = "Service type is required.";
      } else if (
        !["issuance", "revocation"].includes(
          fields[`${prefix}serviceType`]!.trim(),
        )
      ) {
        errors[`${prefix}serviceType`] = "Invalid service type.";
      }

      if (!fields[`${prefix}serviceName`]?.trim()) {
        errors[`${prefix}serviceName`] = "Service name is required.";
      }

      if (!fields[`${prefix}certificatePem`]?.trim()) {
        errors[`${prefix}certificatePem`] = "Certificate is required.";
      } else {
        const certVal = fields[`${prefix}certificatePem`]!.trim();
        if (
          !certVal.includes("-----BEGIN CERTIFICATE-----") ||
          !certVal.includes("-----END CERTIFICATE-----")
        ) {
          errors[`${prefix}certificatePem`] =
            "Certificate must be in PEM format.";
        }
      }

      if (!fields[`${prefix}serviceUniqueIdentifier`]?.trim()) {
        errors[`${prefix}serviceUniqueIdentifier`] =
          "Service unique identifier is required.";
      } else {
        try {
          new URL(fields[`${prefix}serviceUniqueIdentifier`]!.trim());
        } catch {
          errors[`${prefix}serviceUniqueIdentifier`] =
            "Service unique identifier must be a valid URL/URI.";
        }
      }
    }

    return errors;
  }

  function parseServicesFromForm(fields: Record<string, string>): Array<{
    serviceType: "issuance" | "revocation";
    serviceName: string;
    certificatePem: string;
    serviceUniqueIdentifier: string;
  }> {
    const serviceFields = Object.keys(fields).filter((k) =>
      k.startsWith("service["),
    );
    const serviceIndices = new Set<number>();
    for (const kf of serviceFields) {
      const m = kf.match(/^service\[(\d+)\]\./);
      if (m) serviceIndices.add(parseInt(m[1]!, 10));
    }

    const sorted = Array.from(serviceIndices).sort((a, b) => a - b);
    return sorted.map((idx) => {
      const prefix = `service[${idx}].`;
      return {
        serviceType: fields[`${prefix}serviceType`]!.trim() as
          "issuance" | "revocation",
        serviceName: fields[`${prefix}serviceName`]!.trim(),
        certificatePem: fields[`${prefix}certificatePem`]!.trim(),
        serviceUniqueIdentifier:
          fields[`${prefix}serviceUniqueIdentifier`]!.trim(),
      };
    });
  }

  return server;
}
