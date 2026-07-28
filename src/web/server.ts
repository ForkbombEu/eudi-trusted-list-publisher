import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve, extname } from "node:path";
import { randomUUID } from "node:crypto";
import { parse as parseYaml } from "yaml";
import { PublicationStore } from "../core/publication/store.js";

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

function htmlPage(title: string, body: string): string {
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

function send405(res: ServerResponse): void {
  const headers: Record<string, string> = {
    ...securityHeaders(),
    "Content-Type": "text/plain; charset=utf-8",
    Allow: "GET, HEAD",
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

const API_ROUTES: Array<{ path: string; description: string }> = [
  { path: "/api/v1/lists", description: "List all published lists" },
  { path: "/api/v1/lists/{listKey}", description: "Get list index" },
  {
    path: "/api/v1/lists/{listKey}/versions/{sequence}",
    description: "Get version manifest",
  },
  {
    path: "/api/v1/lists/{listKey}/versions/{sequence}/lote",
    description: "Download LoTE JSON",
  },
  {
    path: "/api/v1/lists/{listKey}/versions/{sequence}/signature",
    description: "Download Compact JAdES artifact",
  },
  {
    path: "/api/v1/lists/{listKey}/versions/{sequence}/manifest",
    description: "Download publication manifest",
  },
];

export function getApiRoutes(): ReadonlyArray<{
  path: string;
  description: string;
}> {
  return API_ROUTES;
}

export function createWebServer(config: ServerConfig) {
  const assetsDir = config.assetsDir
    ? resolve(config.assetsDir)
    : resolve(process.cwd(), "src", "web", "assets");
  const maxFileBytes = config.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;

  const store = new PublicationStore({
    publicationDir: config.publicationDir,
  });

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const requestId = randomUUID();
    res.setHeader("X-Request-ID", requestId);

    try {
      const method = req.method ?? "GET";

      if (method !== "GET" && method !== "HEAD") {
        send405(res);
        logRequest(method, req.url?.split("?")[0] ?? "/", 405, requestId);
        return;
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

  function serveCatalogue(res: ServerResponse, s: PublicationStore): void {
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
        const index = s.loadIndex(key);
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

  function serveListDetail(
    res: ServerResponse,
    s: PublicationStore,
    listKey: string,
  ): void {
    try {
      const index = s.loadIndex(listKey);
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

  function serveVersionDetail(
    res: ServerResponse,
    s: PublicationStore,
    listKey: string,
    sequence: number,
  ): void {
    try {
      const manifest = s.loadManifest(listKey, sequence);
      if (!manifest) {
        send404(res, `Version ${sequence} not found`);
        return;
      }

      const loteData = s.loadVersionBytes(listKey, sequence, "lote");
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

  function apiListKeys(res: ServerResponse, _req: IncomingMessage): void {
    try {
      const keys = store.listKeys();
      const result = keys.map((key) => {
        const index = store.loadIndex(key);
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
      });
      sendJson(res, 200, { lists: result }, "no-store");
    } catch {
      sendJson(res, 500, { error: "internal_error" });
    }
  }

  function apiListDetail(res: ServerResponse, listKey: string): void {
    try {
      const index = store.loadIndex(listKey);
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

  function apiVersionDetail(
    res: ServerResponse,
    listKey: string,
    sequence: number,
  ): void {
    try {
      const manifest = store.loadManifest(listKey, sequence);
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

  function apiVersionFile(
    res: ServerResponse,
    listKey: string,
    sequence: number,
    fileType: "lote" | "signature" | "manifest",
  ): void {
    try {
      const content = store.loadVersionBytes(listKey, sequence, fileType);
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

  return server;
}
