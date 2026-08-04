import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { isIP } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { DocumentArtifactStore } from "./document-artifacts.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const execFileAsync = promisify(execFile);
const JSON_BODY_LIMIT = 1024 * 1024;
const DEFAULT_PORT = 47_824;
const TRUSTED_EMBED_ORIGIN = "app://-";
const CONTENT_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".gif", "image/gif"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function securityHeaders() {
  return {
    "content-security-policy": "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self' app://-",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  };
}

function sendJson(response, status, value, headers = {}) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    ...securityHeaders(),
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    "content-type": "application/json; charset=utf-8",
    ...headers,
  });
  response.end(body);
}

function methodNotAllowed(response, methods) {
  sendJson(response, 405, {
    error: { code: "METHOD_NOT_ALLOWED", message: "Method not allowed" },
  }, { allow: methods.join(", ") });
}

function normalizedHostname(value) {
  return String(value ?? "").toLowerCase().replace(/^\[|\]$/gu, "");
}

function isLoopbackHostname(value) {
  const hostname = normalizedHostname(value);
  if (hostname === "localhost" || hostname === "::1") return true;
  if (isIP(hostname) === 4) return hostname.split(".")[0] === "127";
  return false;
}

function isLoopbackAddress(value) {
  const address = normalizedHostname(value);
  return isLoopbackHostname(address)
    || (address.startsWith("::ffff:") && isLoopbackHostname(address.slice("::ffff:".length)));
}

function booleanEnvironmentValue(name, fallbackName) {
  const value = process.env[name] ?? process.env[fallbackName];
  if (value === undefined || value === "") return false;
  if (/^(?:1|true|yes|on)$/iu.test(value)) return true;
  if (/^(?:0|false|no|off)$/iu.test(value)) return false;
  throw new Error(`${name} must be true or false`);
}

function assertLoopbackRequest(request) {
  if (!isLoopbackAddress(request.socket.remoteAddress)) {
    throw new ApiError(403, "LOCAL_ONLY", "This service is only available on this device");
  }
  let requestHost;
  try {
    requestHost = new URL(`http://${request.headers.host ?? ""}`).hostname;
  } catch {
    throw new ApiError(403, "INVALID_HOST", "Request Host must be a loopback address");
  }
  if (!isLoopbackHostname(requestHost)) {
    throw new ApiError(403, "INVALID_HOST", "Request Host must be a loopback address");
  }
  const origin = request.headers.origin;
  if (!origin) return;
  if (origin === TRUSTED_EMBED_ORIGIN) return;
  let parsedOrigin;
  try {
    parsedOrigin = new URL(origin);
  } catch {
    throw new ApiError(403, "INVALID_ORIGIN", "Request Origin must be a loopback address");
  }
  if (
    !["http:", "https:"].includes(parsedOrigin.protocol)
    || !isLoopbackHostname(parsedOrigin.hostname)
    || parsedOrigin.username
    || parsedOrigin.password
  ) {
    throw new ApiError(403, "INVALID_ORIGIN", "Request Origin must be a loopback address");
  }
}

function assertNoQuery(searchParams, routeLabel) {
  if ([...searchParams.keys()].length > 0) {
    throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", `${routeLabel} does not accept query parameters`);
  }
}

function assertAllowedQuery(searchParams, allowed, routeLabel) {
  for (const key of searchParams.keys()) {
    if (!allowed.has(key)) {
      throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", `${routeLabel} does not accept query parameter '${key}'`);
    }
    if (searchParams.getAll(key).length !== 1) {
      throw new ApiError(400, "INVALID_QUERY_PARAMETER", `Query parameter '${key}' cannot be repeated`);
    }
  }
}

function assertPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "INVALID_BODY", "Request body must be a JSON object");
  }
}

function assertAllowedKeys(value, allowed) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new ApiError(400, "UNKNOWN_FIELD", `Unknown field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`);
  }
}

async function readJson(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > JSON_BODY_LIMIT) throw new ApiError(413, "BODY_TOO_LARGE", "Request body is too large");
    chunks.push(chunk);
  }
  if (length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks, length).toString("utf8"));
  } catch {
    throw new ApiError(400, "INVALID_JSON", "Request body must be valid JSON");
  }
}

function boundedString(value, field, { maximum = 500, required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new ApiError(400, "INVALID_FIELD", `'${field}' is required`);
    return "";
  }
  if (typeof value !== "string" || value.length > maximum || (required && !value.trim())) {
    throw new ApiError(400, "INVALID_FIELD", `'${field}' is invalid`);
  }
  return value;
}

function decodeId(value, label) {
  let decoded;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new ApiError(400, "INVALID_PATH", `${label} contains invalid encoding`);
  }
  if (!decoded || decoded.length > 256 || decoded.includes("/")) {
    throw new ApiError(400, "INVALID_PATH", `${label} is invalid`);
  }
  return decoded;
}

function parseDate(value, field) {
  if (!value) return "";
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value) || !Number.isFinite(Date.parse(`${value}T00:00:00Z`))) {
    throw new ApiError(400, "INVALID_QUERY_PARAMETER", `'${field}' must use YYYY-MM-DD`);
  }
  return value;
}

function parseLibrary(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set([
    "name", "logoDataUrl", "matchType", "domainContains", "matchMode", "rules",
  ]));
  const name = boundedString(body.name, "name", { maximum: 80, required: true }).trim();
  const logoDataUrl = body.logoDataUrl === null || body.logoDataUrl === undefined
    ? null
    : boundedString(body.logoDataUrl, "logoDataUrl", { maximum: 750_000 });
  if (logoDataUrl && !/^data:image\/(?:png|jpeg|webp|svg\+xml);base64,/iu.test(logoDataUrl)) {
    throw new ApiError(400, "INVALID_FIELD", "'logoDataUrl' must be a supported image data URL");
  }
  if (!new Set(["domain", "rules"]).has(body.matchType)) {
    throw new ApiError(400, "INVALID_FIELD", "'matchType' must be 'domain' or 'rules'");
  }
  const matchMode = body.matchMode ?? "all";
  if (!new Set(["all", "any"]).has(matchMode)) {
    throw new ApiError(400, "INVALID_FIELD", "'matchMode' must be 'all' or 'any'");
  }
  const domainContains = boundedString(body.domainContains ?? "", "domainContains", { maximum: 253 }).trim();
  if (body.matchType === "domain" && !domainContains) {
    throw new ApiError(400, "INVALID_FIELD", "'domainContains' is required for a domain library");
  }
  const rules = body.rules ?? [];
  if (!Array.isArray(rules) || rules.length > 20) {
    throw new ApiError(400, "INVALID_FIELD", "'rules' must be a list with at most 20 entries");
  }
  const fields = new Set(["title", "body", "updatedAt", "createdAt", "fileSize"]);
  const operators = new Set([
    "contains", "not_contains", "equals", "after", "before", "greater_than", "less_than",
  ]);
  const normalizedRules = rules.map((rule) => {
    assertPlainObject(rule);
    assertAllowedKeys(rule, new Set(["field", "operator", "value"]));
    if (!fields.has(rule.field) || !operators.has(rule.operator)) {
      throw new ApiError(400, "INVALID_FIELD", "A document library rule is invalid");
    }
    return {
      field: rule.field,
      operator: rule.operator,
      value: boundedString(rule.value, "rule.value", { maximum: 500, required: true }),
    };
  });
  return {
    name,
    logoDataUrl,
    matchType: body.matchType,
    domainContains,
    matchMode,
    rules: body.matchType === "rules" ? normalizedRules : [],
  };
}

async function defaultOpenTarget(target) {
  const command = process.platform === "darwin"
    ? { executable: "open", args: [target] }
    : process.platform === "win32"
      ? { executable: "explorer.exe", args: [target] }
      : { executable: "xdg-open", args: [target] };
  await execFileAsync(command.executable, command.args, { timeout: 5_000, windowsHide: true });
}

async function serveStatic(request, response, pathname, staticDirectory) {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    throw new ApiError(400, "INVALID_PATH", "Path contains invalid encoding");
  }
  if (decoded.includes("\0")) throw new ApiError(400, "INVALID_PATH", "Path is invalid");
  const root = path.resolve(staticDirectory);
  const requested = decoded === "/" ? "/index.html" : decoded;
  let filename = path.resolve(root, `.${requested}`);
  if (filename !== root && !filename.startsWith(`${root}${path.sep}`)) {
    throw new ApiError(403, "INVALID_PATH", "Path escapes the static directory");
  }
  let info;
  try {
    info = await stat(filename);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (!info?.isFile() && !path.extname(requested)) {
    filename = path.join(root, "index.html");
    try {
      info = await stat(filename);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  if (!info?.isFile()) return false;
  const body = request.method === "HEAD" ? null : await readFile(filename);
  response.writeHead(200, {
    ...securityHeaders(),
    "cache-control": path.basename(filename) === "index.html" ? "no-cache" : "public, max-age=3600",
    "content-length": info.size,
    "content-type": CONTENT_TYPES.get(path.extname(filename).toLowerCase()) ?? "application/octet-stream",
  });
  response.end(body ?? undefined);
  return true;
}

export function resolvePort(value = process.env.DOCUMENT_ARTIFACTS_PORT ?? process.env.CODEX_DOCUMENT_ARTIFACTS_PORT ?? DEFAULT_PORT) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("Document artifacts port must be an integer from 0 to 65535");
  }
  return port;
}

export function resolveServerOptions(options = {}) {
  const codexHome = path.resolve(options.codexHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"));
  const includeLongTerm = options.includeLongTerm === undefined
    ? booleanEnvironmentValue("DOCUMENT_ARTIFACTS_INCLUDE_LONG_TERM", "CODEX_DOCUMENT_ARTIFACTS_INCLUDE_LONG_TERM")
    : options.includeLongTerm === true;
  const enableSnapshots = options.enableSnapshots === undefined
    ? booleanEnvironmentValue("DOCUMENT_ARTIFACTS_ENABLE_SNAPSHOTS", "CODEX_DOCUMENT_ARTIFACTS_ENABLE_SNAPSHOTS")
    : options.enableSnapshots === true;
  return {
    codexHome,
    codexStatePath: path.resolve(options.codexStatePath ?? path.join(codexHome, ".codex-global-state.json")),
    codexThreadsPath: path.resolve(options.codexThreadsPath ?? path.join(codexHome, "state_5.sqlite")),
    dataDirectory: path.resolve(
      options.dataDirectory
      ?? process.env.DOCUMENT_ARTIFACTS_DATA_DIR
      ?? process.env.CODEX_DOCUMENT_ARTIFACTS_DATA_DIR
      ?? path.join(codexHome, "document-artifacts"),
    ),
    memoryDirectory: path.resolve(options.memoryDirectory ?? path.join(codexHome, "memories")),
    automationsDirectory: path.resolve(options.automationsDirectory ?? path.join(codexHome, "automations")),
    staticDirectory: path.resolve(options.staticDirectory ?? path.join(PROJECT_ROOT, "dist", "web")),
    historyDays: options.historyDays ?? null,
    includeLongTerm,
    enableSnapshots,
    platformTitleResolver: options.platformTitleResolver ?? null,
    openTarget: options.openTarget ?? defaultOpenTarget,
  };
}

export function createDocumentArtifactsServer(options = {}) {
  const resolved = resolveServerOptions(options);
  const eventResponses = new Set();
  const emit = (event, payload) => {
    const encoded = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const response of eventResponses) response.write(encoded);
  };
  const documentArtifacts = new DocumentArtifactStore({
    dataDirectory: resolved.dataDirectory,
    codexStatePath: resolved.codexStatePath,
    codexThreadsPath: resolved.codexThreadsPath,
    memoryDirectory: resolved.memoryDirectory,
    automationsDirectory: resolved.automationsDirectory,
    historyDays: resolved.historyDays,
    includeLongTerm: resolved.includeLongTerm,
    enableSnapshots: resolved.enableSnapshots,
    platformTitleResolver: resolved.platformTitleResolver,
    onChange: (payload) => emit("document.updated", payload),
  });

  const server = createServer(async (request, response) => {
    try {
      assertLoopbackRequest(request);
      const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
      const pathname = url.pathname;

      if (pathname === "/health") {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        assertNoQuery(url.searchParams, "GET /health");
        return sendJson(response, 200, {
          ok: true,
          service: "codex-document-artifacts",
          stats: documentArtifacts.stats(),
        });
      }

      if (pathname === "/api/events") {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        assertNoQuery(url.searchParams, "GET /api/events");
        response.writeHead(200, {
          ...securityHeaders(),
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "content-type": "text/event-stream; charset=utf-8",
        });
        response.write(": connected\n\n");
        eventResponses.add(response);
        request.once("close", () => eventResponses.delete(response));
        return;
      }

      if (pathname === "/api/local/document-libraries") {
        assertNoQuery(url.searchParams, `${request.method} /api/local/document-libraries`);
        if (request.method === "GET") {
          return sendJson(response, 200, { libraries: documentArtifacts.listLibraries() });
        }
        if (request.method === "POST") {
          const library = documentArtifacts.createLibrary(parseLibrary(await readJson(request)));
          emit("document.updated", { reason: "library.created", libraryId: library.id });
          return sendJson(response, 201, { library });
        }
        return methodNotAllowed(response, ["GET", "POST"]);
      }

      if (pathname === "/api/local/document-libraries/order") {
        if (request.method !== "PUT") return methodNotAllowed(response, ["PUT"]);
        assertNoQuery(url.searchParams, "PUT /api/local/document-libraries/order");
        const body = await readJson(request);
        assertPlainObject(body);
        assertAllowedKeys(body, new Set(["ids"]));
        if (
          !Array.isArray(body.ids)
          || body.ids.length > 100
          || body.ids.some((id) => typeof id !== "string" || !id || id.length > 256)
          || new Set(body.ids).size !== body.ids.length
        ) {
          throw new ApiError(400, "INVALID_FIELD", "'ids' must be a unique list of document library ids");
        }
        const known = new Set(documentArtifacts.listLibraries().map((library) => library.id));
        if (body.ids.some((id) => !known.has(id))) {
          throw new ApiError(400, "INVALID_FIELD", "'ids' contains an unknown document library");
        }
        const libraries = documentArtifacts.setLibraryOrder(body.ids);
        emit("document.updated", { reason: "libraries.reordered" });
        return sendJson(response, 200, { libraries });
      }

      if (pathname === "/api/local/document-artifacts") {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        assertAllowedQuery(url.searchParams, new Set([
          "category", "libraryId", "projectId", "query", "task", "title", "timeField",
          "startDate", "endDate", "cursor", "limit",
        ]), "GET /api/local/document-artifacts");
        const allowedCategories = new Set([
          "all", "feishu", "wecom", "office", "markdown",
          ...(resolved.includeLongTerm ? ["long_term"] : []),
        ]);
        const category = url.searchParams.get("category") ?? "all";
        if (!allowedCategories.has(category)) {
          throw new ApiError(400, "INVALID_QUERY_PARAMETER", "Unsupported document category");
        }
        const cursor = Number(url.searchParams.get("cursor") ?? 0);
        const limit = Number(url.searchParams.get("limit") ?? 50);
        if (!Number.isInteger(cursor) || cursor < 0 || !Number.isInteger(limit) || limit < 1 || limit > 200) {
          throw new ApiError(400, "INVALID_QUERY_PARAMETER", "Document pagination is invalid");
        }
        const timeField = url.searchParams.get("timeField") ?? "updated";
        if (timeField !== "created" && timeField !== "updated") {
          throw new ApiError(400, "INVALID_QUERY_PARAMETER", "Unsupported document time field");
        }
        return sendJson(response, 200, documentArtifacts.list({
          category,
          libraryId: boundedString(url.searchParams.get("libraryId") ?? "", "libraryId", { maximum: 256 }),
          projectId: boundedString(url.searchParams.get("projectId") ?? "", "projectId", { maximum: 256 }),
          query: boundedString(url.searchParams.get("query") ?? "", "query", { maximum: 500 }),
          task: boundedString(url.searchParams.get("task") ?? "", "task", { maximum: 240 }),
          title: boundedString(url.searchParams.get("title") ?? "", "title", { maximum: 500 }),
          timeField,
          startDate: parseDate(url.searchParams.get("startDate"), "startDate"),
          endDate: parseDate(url.searchParams.get("endDate"), "endDate"),
          cursor,
          limit,
        }));
      }

      if (pathname === "/api/local/document-artifacts/rescan") {
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        assertNoQuery(url.searchParams, "POST /api/local/document-artifacts/rescan");
        const body = await readJson(request);
        assertPlainObject(body);
        assertAllowedKeys(body, new Set());
        return sendJson(response, 200, await documentArtifacts.scanNow());
      }

      const markdownRoute = pathname.match(/^\/api\/local\/document-artifacts\/([^/]+)\/content$/u);
      if (markdownRoute) {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        assertNoQuery(url.searchParams, "GET /api/local/document-artifacts/:id/content");
        const document = documentArtifacts.readMarkdownArtifact(decodeId(markdownRoute[1], "Document artifact id"));
        if (!document) throw new ApiError(404, "MARKDOWN_DOCUMENT_NOT_FOUND", "Markdown document was not found");
        return sendJson(response, 200, { document });
      }

      const documentOpenRoute = pathname.match(/^\/api\/local\/document-artifacts\/([^/]+)\/open$/u);
      if (documentOpenRoute) {
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        assertNoQuery(url.searchParams, "POST /api/local/document-artifacts/:id/open");
        const artifactId = decodeId(documentOpenRoute[1], "Document artifact id");
        const body = await readJson(request);
        assertPlainObject(body);
        assertAllowedKeys(body, new Set(["versionId"]));
        const versionId = body.versionId === undefined
          ? null
          : boundedString(body.versionId, "versionId", { maximum: 256, required: true });
        const target = documentArtifacts.resolveOpenTarget(artifactId, versionId);
        if (target.error === "NOT_FOUND" || target.error === "VERSION_NOT_FOUND") {
          throw new ApiError(404, target.error, "Document artifact or version was not found");
        }
        if (target.error) {
          throw new ApiError(409, target.error, "This historical version is unavailable");
        }
        await resolved.openTarget(target.target);
        return sendJson(response, 200, { opened: true });
      }

      const longTermRoute = pathname.match(/^\/api\/local\/long-term-documents\/([^/]+)$/u);
      if (longTermRoute) {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        assertNoQuery(url.searchParams, "GET /api/local/long-term-documents/:id");
        const document = documentArtifacts.readLongTermDocument(decodeId(longTermRoute[1], "Long-term document id"));
        if (!document) throw new ApiError(404, "LONG_TERM_DOCUMENT_NOT_FOUND", "Long-term document was not found");
        return sendJson(response, 200, { document });
      }

      const longTermOpenRoute = pathname.match(/^\/api\/local\/long-term-documents\/([^/]+)\/open$/u);
      if (longTermOpenRoute) {
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        assertNoQuery(url.searchParams, "POST /api/local/long-term-documents/:id/open");
        const body = await readJson(request);
        assertPlainObject(body);
        assertAllowedKeys(body, new Set());
        const target = documentArtifacts.resolveLongTermOpenTarget(decodeId(longTermOpenRoute[1], "Long-term document id"));
        if (!target) throw new ApiError(404, "LONG_TERM_DOCUMENT_NOT_FOUND", "Long-term document was not found");
        await resolved.openTarget(target.target);
        return sendJson(response, 200, { opened: true });
      }

      if (pathname.startsWith("/api/")) {
        throw new ApiError(404, "NOT_FOUND", "API route not found");
      }
      if (await serveStatic(request, response, pathname, resolved.staticDirectory)) return;
      throw new ApiError(404, "NOT_FOUND", "Resource not found");
    } catch (error) {
      if (response.headersSent) {
        response.destroy(error);
        return;
      }
      if (error instanceof ApiError) {
        sendJson(response, error.status, { error: { code: error.code, message: error.message } });
        return;
      }
      console.error(error);
      sendJson(response, 500, { error: { code: "INTERNAL_ERROR", message: "Internal server error" } });
    }
  });

  let listening = false;
  let storeClosed = false;
  const heartbeat = setInterval(() => {
    for (const response of eventResponses) response.write(": heartbeat\n\n");
  }, 20_000);
  heartbeat.unref();

  return {
    server,
    documentArtifacts,
    options: resolved,
    async listen({ host = "127.0.0.1", port = resolvePort() } = {}) {
      if (host !== "127.0.0.1" && host !== "::1") {
        throw new Error("Document artifacts server only binds to a loopback address");
      }
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, host);
      });
      listening = true;
      try {
        await documentArtifacts.start();
      } catch (error) {
        await new Promise((resolve) => server.close(() => resolve()));
        listening = false;
        throw error;
      }
      return server.address();
    },
    async close() {
      clearInterval(heartbeat);
      for (const response of eventResponses) response.end();
      eventResponses.clear();
      const closing = listening
        ? new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
        : Promise.resolve();
      listening = false;
      if (!storeClosed) {
        await documentArtifacts.stop();
        storeClosed = true;
      }
      await closing;
    },
  };
}

export const createDocumentArtifactServer = createDocumentArtifactsServer;
