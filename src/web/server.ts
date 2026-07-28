import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { resolve, extname } from "node:path";
import { randomUUID } from "node:crypto";
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
<footer class="site-footer">
  <div class="footer-inner">
    <p>Credimi &mdash; read-only publication viewer</p>
    <p>Signer trust status: not evaluated. This tool does not establish PKIX trust.</p>
  </div>
</footer>
</body>
</html>`;
}

export interface ServerConfig {
  publicationDir: string;
  host?: string;
  port?: number;
  assetsDir?: string;
}

function send(
  res: ServerResponse,
  status: number,
  body: string,
  contentType: string,
): void {
  const headers: Record<string, string> = {
    "Content-Type": contentType,
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
  };
  res.writeHead(status, headers);
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  send(res, status, JSON.stringify(data), "application/json");
}

function sendHtml(res: ServerResponse, status: number, body: string): void {
  send(res, status, body, "text/html; charset=utf-8");
}

function send404(res: ServerResponse, message?: string): void {
  sendHtml(
    res,
    404,
    htmlPage(
      "404 Not Found",
      `<h1>Not Found</h1><p>${escapeHtml(message ?? "The requested resource does not exist.")}</p>`,
    ),
  );
}

function send500(res: ServerResponse, requestId: string): void {
  sendHtml(
    res,
    500,
    htmlPage(
      "500 Internal Error",
      `<h1>Internal Error</h1><p>Request ID: <code>${escapeHtml(requestId)}</code></p>`,
    ),
  );
}

export function createWebServer(config: ServerConfig) {
  const assetsDir = config.assetsDir
    ? resolve(config.assetsDir)
    : resolve(process.cwd(), "src", "web", "assets");

  const store = new PublicationStore({
    publicationDir: config.publicationDir,
  });

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const requestId = randomUUID();
    try {
      const url = new URL(
        req.url ?? "/",
        `http://${req.headers.host ?? "localhost"}`,
      );
      handler(req, res, url, requestId);
    } catch (e) {
      if (!res.headersSent) {
        send500(res, requestId);
      }
    }
  });

  function handler(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    requestId: string,
  ): void {
    const path = url.pathname;

    // Health check
    if (path === "/healthz") {
      sendJson(res, 200, { status: "ok" });
      return;
    }

    // Favicon
    if (path === "/favicon.svg") {
      serveAsset(
        res,
        "credimi_logo.svg",
        "image/svg+xml",
        "public, max-age=86400, immutable",
      );
      return;
    }

    // Static assets
    if (path.startsWith("/assets/")) {
      const assetName = path.slice("/assets/".length);
      if (assetName.includes("..") || assetName.includes("/")) {
        send404(res);
        return;
      }
      const assetPath = resolve(assetsDir, assetName);
      if (!assetPath.startsWith(resolve(assetsDir))) {
        send404(res);
        return;
      }
      if (!existsSync(assetPath)) {
        send404(res);
        return;
      }
      const ext = extname(assetName).toLowerCase();
      const mimeType = MIME[ext] ?? "application/octet-stream";
      const cacheControl =
        assetName === "app.css"
          ? "no-store"
          : "public, max-age=86400, immutable";
      serveAsset(res, assetName, mimeType, cacheControl);
      return;
    }

    // OpenAPI spec
    if (path === "/openapi.yaml") {
      serveOpenApi(res, "yaml");
      return;
    }
    if (path === "/openapi.json") {
      serveOpenApi(res, "json");
      return;
    }

    // API docs
    if (path === "/docs") {
      serveDocs(res);
      return;
    }

    // JSON API routes
    if (path.startsWith("/api/v1/")) {
      handleApi(req, res, url, requestId);
      return;
    }

    // Catalogue home
    if (path === "/") {
      serveCatalogue(res, store);
      return;
    }

    // List detail: /lists/:listKey
    const listMatch = path.match(/^\/lists\/([a-z0-9_.@()-]+)$/);
    if (listMatch) {
      serveListDetail(res, store, listMatch[1]!);
      return;
    }

    // Version detail: /lists/:listKey/versions/:sequence
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
      return;
    }

    send404(res);
  }

  function serveAsset(
    res: ServerResponse,
    name: string,
    contentType: string,
    cacheControl: string,
  ): void {
    const path = resolve(assetsDir, name);
    if (!existsSync(path)) {
      res.writeHead(404);
      res.end();
      return;
    }
    const content = readFileSync(path, "utf-8");
    const headers: Record<string, string> = {
      "Content-Type": contentType,
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": cacheControl,
    };
    res.writeHead(200, headers);
    res.end(content);
  }

  function serveOpenApi(res: ServerResponse, format: "yaml" | "json"): void {
    const path = resolve(assetsDir, "openapi.yaml");
    if (!existsSync(path)) {
      send404(res, "OpenAPI spec not found");
      return;
    }
    if (format === "yaml") {
      const content = readFileSync(path, "utf-8");
      send(res, 200, content, "application/yaml");
    } else {
      const content = readFileSync(path, "utf-8");
      send(res, 200, content, "application/json");
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
  }

  function serveListDetail(
    res: ServerResponse,
    s: PublicationStore,
    listKey: string,
  ): void {
    const index = s.loadIndex(listKey);
    if (!index) {
      send404(res, `List "${listKey}" not found`);
      return;
    }

    let rows = "";
    for (const v of index.versions) {
      rows += `
      <tr>
        <td><a href="/lists/${escapeHtml(listKey)}/versions/${v.sequenceNumber}">${v.sequenceNumber}</a></td>
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
  }

  function serveVersionDetail(
    res: ServerResponse,
    s: PublicationStore,
    listKey: string,
    sequence: number,
  ): void {
    const manifest = s.loadManifest(listKey, sequence);
    if (!manifest) {
      send404(res, `Version ${sequence} not found`);
      return;
    }

    const loteJsonPath = s.loteJsonPath(listKey, sequence);
    let entityRows = "";
    if (existsSync(loteJsonPath)) {
      try {
        const doc = JSON.parse(readFileSync(loteJsonPath, "utf-8"));
        const entities = doc?.LoTE?.TrustedEntitiesList ?? [];
        for (const e of entities) {
          const names =
            e?.TrustedEntityInformation?.TEName?.map((n: { value: string }) =>
              escapeHtml(n.value),
            ).join(", ") ?? "";
          const svcs =
            e?.TrustedEntityServices?.map(
              (s: {
                ServiceInformation: { ServiceName: Array<{ value: string }> };
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
<li><a href="/api/v1/lists/${escapeHtml(listKey)}/versions/${sequence}/signature">Compact JAdES artifact (lote.jades)</a></li>
<li><a href="/api/v1/lists/${escapeHtml(listKey)}/versions/${sequence}/lote">Decoded LoTE JSON</a></li>
<li><a href="/api/v1/lists/${escapeHtml(listKey)}/versions/${sequence}/manifest">Publication manifest</a></li>
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
  }

  function apiListKeys(res: ServerResponse, _req: IncomingMessage): void {
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
    sendJson(res, 200, { lists: result });
  }

  function apiListDetail(res: ServerResponse, listKey: string): void {
    const index = store.loadIndex(listKey);
    if (!index) {
      sendJson(res, 404, {
        error: "not_found",
        message: `List "${listKey}" not found`,
      });
      return;
    }
    sendJson(res, 200, index);
  }

  function apiVersionDetail(
    res: ServerResponse,
    listKey: string,
    sequence: number,
  ): void {
    const manifest = store.loadManifest(listKey, sequence);
    if (!manifest) {
      sendJson(res, 404, {
        error: "not_found",
        message: `Version ${sequence} not found`,
      });
      return;
    }
    sendJson(res, 200, manifest);
  }

  function apiVersionFile(
    res: ServerResponse,
    listKey: string,
    sequence: number,
    fileType: "lote" | "signature" | "manifest",
  ): void {
    const filePath = (() => {
      switch (fileType) {
        case "lote":
          return store.loteJsonPath(listKey, sequence);
        case "signature":
          return store.loteJadesPath(listKey, sequence);
        case "manifest":
          return store.manifestPath(listKey, sequence);
      }
    })();

    if (!existsSync(filePath)) {
      sendJson(res, 404, { error: "not_found", message: "File not found" });
      return;
    }

    const content = readFileSync(filePath, "utf-8");
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

    res.setHeader(
      "Cache-Control",
      fileType === "manifest" ? "no-store" : "public, max-age=86400, immutable",
    );
    send(res, 200, content, contentType);
  }

  function handleApi(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    requestId: string,
  ): void {
    try {
      const path = url.pathname;

      // GET /api/v1/lists
      if (path === "/api/v1/lists") {
        apiListKeys(res, req);
        return;
      }

      // GET /api/v1/lists/:listKey
      const listKeyMatch = path.match(/^\/api\/v1\/lists\/([a-z0-9_.@()-]+)$/);
      if (listKeyMatch) {
        apiListDetail(res, listKeyMatch[1]!);
        return;
      }

      // GET /api/v1/lists/:listKey/versions/:sequence
      const versionMatch = path.match(
        /^\/api\/v1\/lists\/([a-z0-9_.@()-]+)\/versions\/(\d+)$/,
      );
      if (versionMatch) {
        apiVersionDetail(res, versionMatch[1]!, parseInt(versionMatch[2]!, 10));
        return;
      }

      // GET /api/v1/lists/:listKey/versions/:sequence/:file
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
        return;
      }

      sendJson(res, 404, {
        error: "not_found",
        message: "API route not found",
      });
    } catch (e) {
      sendJson(res, 500, {
        error: "internal_error",
        message: "Internal server error",
        requestId,
      });
    }
  }

  return server;
}
