import { createHash, randomUUID } from "node:crypto";
import { chmodSync, createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { chmod, copyFile, mkdir, readFile, stat, unlink } from "node:fs/promises";
import path from "node:path";

import { DatabaseSync } from "node:sqlite";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_HISTORY_DAYS = null;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
const MAX_JSON_LINE_BYTES = 8 * 1024 * 1024;
const PLATFORM_TITLE_SUCCESS_TTL_MS = 24 * 60 * 60 * 1000;
const PLATFORM_TITLE_FAILURE_TTL_MS = 60 * 60 * 1000;
const PLATFORM_TITLE_RESOLVER_VERSION = 2;
const DOCUMENT_SCANNER_VERSION = 3;
const LONG_TERM_SOURCE_MAX_BYTES = 2 * 1024 * 1024;
const IMPORTANT_MEMORY_FILES = ["memory_summary.md", "MEMORY.md", "raw_memories.md"];

const OFFICE_EXTENSIONS = new Map([
  [".doc", "word"], [".docx", "word"], [".docm", "word"],
  [".xls", "excel"], [".xlsx", "excel"], [".xlsm", "excel"],
  [".ppt", "powerpoint"], [".pptx", "powerpoint"], [".pptm", "powerpoint"],
]);

const FEISHU_PATHS = new Set(["doc", "docx", "wiki", "sheets", "slides", "base", "bitable"]);
const WECOM_PATHS = new Set(["doc", "sheet", "smartpage"]);
const VERSION_SUFFIX = /(?:[\s_.\-—–]*(?:v\d+(?:\.\d+)*|版本\d+|第\d+版|修订版|修改版|更新版|最终版|终版|final|rev\d+)|[\s_.\-—–]*[（(](?:v\d+(?:\.\d+)*|版本\d+|第\d+版|修订版|修改版|更新版|最终版|终版|final|rev\d+)[）)])$/iu;
const GENERIC_DOCUMENT_TITLE = /^(?:打开|查看|链接|文档|文件|下载|这里|那里|这篇|那篇|本文|本篇|上面|下面|对应(?:的)?(?:GPT)?纪要|第[零一二两三四五六七八九十百\d]+(?:篇|份|个|版)(?:纪要)?)$/iu;
const LONG_TERM_COLLECTION_TITLE = /(?:清单|存档|合集|身份库|知识库|资料库|数据库|台账|档案库)/u;
const BUILTIN_DOCUMENT_LIBRARIES = [
  { id: "feishu", name: "飞书文档", kind: "builtin" },
  { id: "wecom", name: "企业微信文档", kind: "builtin" },
  { id: "office", name: "Office 文档", kind: "builtin" },
  { id: "markdown", name: "MD 文档", kind: "builtin" },
];
const LONG_TERM_DOCUMENT_LIBRARY = {
  id: "long_term", name: "长期文档", kind: "builtin", icon: "★",
};

function nowIso() {
  return new Date().toISOString();
}

function timeAtShanghaiDate(date, endExclusive = false) {
  if (!date) return null;
  return Date.parse(`${date}T00:00:00+08:00`) + (endExclusive ? DAY_MS : 0);
}

function fileCreatedAt(info) {
  return (info.birthtime ?? info.ctime ?? info.mtime).toISOString();
}

function safeJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizeLabel(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function localFileSize(locator) {
  if (!String(locator ?? "").startsWith("/")) return null;
  try {
    const info = statSync(locator);
    return info.isFile() ? info.size : null;
  } catch {
    return null;
  }
}

function stableLongTermId(kind, value) {
  return `long-term-${kind}-${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}

function readSmallTextFile(filename) {
  try {
    const info = statSync(filename);
    if (!info.isFile() || info.size > LONG_TERM_SOURCE_MAX_BYTES) return null;
    return { text: readFileSync(filename, "utf8"), info };
  } catch {
    return null;
  }
}

function decodeTomlString(value) {
  try {
    return JSON.parse(`"${value}"`);
  } catch {
    return value.replace(/\\n/gu, "\n").replace(/\\"/gu, "\"");
  }
}

function tomlString(source, key) {
  const match = source.match(new RegExp(`^${key}\\s*=\\s*"((?:\\\\.|[^"\\\\])*)"`, "mu"));
  return match ? decodeTomlString(match[1]) : "";
}

function locatorToken(locator) {
  try {
    const url = new URL(locator);
    return decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) ?? "");
  } catch {
    return "";
  }
}

function needsPlatformTitle(title, locator) {
  const candidate = normalizeLabel(title).replace(/[\s，,。.!！?？：:]+$/u, "");
  return !candidate || GENERIC_DOCUMENT_TITLE.test(candidate) || candidate === locatorToken(locator);
}

function distinctArtifactTaskNames(artifact) {
  return new Set(
    artifact.tags
      .map((tag) => normalizeLabel(tag.taskName))
      .filter(Boolean),
  );
}

function isSharedAcrossTasks(artifact) {
  return distinctArtifactTaskNames(artifact).size >= 2;
}

function isCollectionLocator(locator) {
  try {
    const firstPath = new URL(locator).pathname.split("/").filter(Boolean)[0]?.toLowerCase();
    return firstPath === "base" || firstPath === "bitable";
  } catch {}
  return false;
}

function isSharedLongTermArtifact(artifact) {
  return isSharedAcrossTasks(artifact)
    && (isCollectionLocator(artifact.locator) || LONG_TERM_COLLECTION_TITLE.test(artifact.title));
}

function isLongTermAutomationReference(reference) {
  if (isCollectionLocator(reference.canonical)) return true;
  return LONG_TERM_COLLECTION_TITLE.test(reference.title);
}

function displayTitle(label, locator) {
  const candidate = normalizeLabel(label)
    .replace(/^<|>$/g, "")
    .replace(/\\([\\`*_{}\[\]()#+.!-])/g, "$1");
  if (
    candidate
    && candidate !== locator
    && !needsPlatformTitle(candidate, locator)
  ) return candidate;
  if (locator.startsWith("/")) return path.basename(locator);
  try {
    const url = new URL(locator);
    return decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) ?? url.hostname);
  } catch {
    return locator;
  }
}

function deliveryContext(text, matchStart, matchEnd) {
  const beforeLimit = 440;
  const afterLimit = 140;
  const start = Math.max(0, matchStart - beforeLimit);
  const end = Math.min(text.length, matchEnd + afterLimit);
  let excerpt = text.slice(start, end)
    .replace(/\[([^\]]+)\]\((?:<[^>]+>|[^\n)]+)\)/gu, "$1")
    .replace(/```[^\n]*\n?/gu, "")
    .replace(/`([^`]+)`/gu, "$1")
    .replace(/^\s{0,3}(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)/gmu, "")
    .replace(/\s+/gu, " ")
    .trim();
  if (start > 0) excerpt = `…${excerpt}`;
  if (end < text.length) excerpt = `${excerpt}…`;
  return excerpt;
}

function userDeliveryContext(text) {
  let source = String(text ?? "");
  const requestMarker = "## My request for Codex:";
  const markerIndex = source.lastIndexOf(requestMarker);
  if (markerIndex >= 0) source = source.slice(markerIndex + requestMarker.length);
  const normalized = source
    .replace(/<image\b[^>]*>[\s\S]*?<\/image>/giu, "")
    .replace(/<in-app-browser-context\b[^>]*>[\s\S]*?<\/in-app-browser-context>/giu, "")
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/giu, "")
    .replace(/\s+/gu, " ")
    .trim();
  if (normalized.length <= 600) return normalized;
  return `${normalized.slice(0, 599).trimEnd()}…`;
}

function canonicalOnlineUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.protocol = "https:";
    url.hostname = url.hostname.toLowerCase();
    url.hash = "";
    url.search = "";
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    return url.href;
  } catch {
    return null;
  }
}

function classifyOnlineUrl(value) {
  const canonical = canonicalOnlineUrl(value);
  if (!canonical) return null;
  const url = new URL(canonical);
  const firstPath = url.pathname.split("/").filter(Boolean)[0]?.toLowerCase() ?? "";
  const hostname = url.hostname;
  if (
    (hostname === "feishu.cn" || hostname.endsWith(".feishu.cn")
      || hostname === "larksuite.com" || hostname.endsWith(".larksuite.com"))
    && FEISHU_PATHS.has(firstPath)
  ) {
    return { category: "feishu", officeType: null, canonical };
  }
  if (hostname === "doc.weixin.qq.com" && WECOM_PATHS.has(firstPath)) {
    return { category: "wecom", officeType: null, canonical };
  }
  return null;
}

function normalizeLocalPath(value) {
  let candidate = String(value ?? "").trim().replace(/^<|>$/g, "");
  if (candidate.startsWith("file://")) {
    try {
      candidate = decodeURIComponent(new URL(candidate).pathname);
    } catch {
      return null;
    }
  }
  try {
    candidate = decodeURIComponent(candidate);
  } catch {}
  candidate = candidate.replace(/\\([ ()\[\]])/g, "$1");
  if (!path.isAbsolute(candidate)) return null;
  const extension = path.extname(candidate).toLowerCase();
  if (extension === ".md" || extension === ".markdown") {
    return { category: "markdown", officeType: null, canonical: path.normalize(candidate) };
  }
  const officeType = OFFICE_EXTENSIONS.get(extension);
  if (!officeType) return null;
  return { category: "office", officeType, canonical: path.normalize(candidate) };
}

function stripVersionSuffix(stem) {
  let normalized = stem.trim();
  let previous;
  do {
    previous = normalized;
    normalized = normalized.replace(VERSION_SUFFIX, "").trim();
  } while (normalized && normalized !== previous);
  return normalized || stem.trim();
}

function logicalKey(candidate, threadId) {
  if (candidate.category !== "office") return `online:${candidate.canonical}`;
  const extension = path.extname(candidate.canonical);
  const stem = path.basename(candidate.canonical, extension);
  return [
    "office",
    threadId,
    path.dirname(candidate.canonical),
    candidate.officeType,
    stripVersionSuffix(stem).toLocaleLowerCase("zh-CN"),
  ].join(":");
}

function extractCandidates(text) {
  const candidates = [];
  const seenTargets = new Set();
  const add = (label, rawTarget, matchStart, matchLength) => {
    const target = String(rawTarget ?? "").trim().replace(/^<|>$/g, "");
    if (!target || seenTargets.has(target)) return;
    const classified = classifyOnlineUrl(target) ?? normalizeLocalPath(target);
    if (!classified) return;
    seenTargets.add(target);
    candidates.push({
      ...classified,
      locator: classified.canonical,
      title: displayTitle(label, classified.canonical),
      needsPlatformTitle: ["feishu", "wecom"].includes(classified.category),
      deliveryContext: deliveryContext(text, matchStart, matchStart + matchLength),
    });
  };

  const markdown = /\[([^\]]+)\]\((<[^>]+>|[^\n)]+)\)/gu;
  for (const match of text.matchAll(markdown)) add(match[1], match[2], match.index, match[0].length);

  const bareUrl = /https?:\/\/[^\s<>"'`\])}]+/gu;
  for (const match of text.matchAll(bareUrl)) {
    add("", match[0].replace(/[.,;:，。；：!?！？]+$/u, ""), match.index, match[0].length);
  }

  const codePath = /`(\/[^`\n]+\.(?:docx?|docm|xlsx?|xlsm|pptx?|pptm|md|markdown))`/giu;
  for (const match of text.matchAll(codePath)) add("", match[1], match.index, match[0].length);

  const plainPath = /(?:^|\s)(\/[^\n<>"']+?\.(?:docx?|docm|xlsx?|xlsm|pptx?|pptm|md|markdown))(?=$|\s|[，。；：!?！？])/giu;
  for (const match of text.matchAll(plainPath)) add("", match[1], match.index, match[0].length);
  return candidates;
}

async function fileSha256(filename) {
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filename);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", resolve);
  });
  return hash.digest("hex");
}

function projectContext(state, threadId, cwd) {
  const projects = state?.["local-projects"];
  const assignment = state?.["thread-project-assignments"]?.[threadId];
  const assignedProject = projects?.[assignment?.projectId];
  if (assignedProject?.name) {
    return { projectId: assignedProject.id, projectName: assignedProject.name };
  }
  const roots = Object.values(projects ?? {}).flatMap((project) => (
    Array.isArray(project?.rootPaths)
      ? project.rootPaths.map((root) => ({ project, root }))
      : []
  )).filter(({ root }) => typeof root === "string" && (cwd === root || cwd.startsWith(`${root}${path.sep}`)))
    .sort((left, right) => right.root.length - left.root.length);
  if (roots[0]?.project?.name) {
    return { projectId: roots[0].project.id, projectName: roots[0].project.name };
  }
  const label = state?.["electron-workspace-root-labels"]?.[cwd];
  return {
    projectId: `workspace:${createHash("sha1").update(cwd).digest("hex").slice(0, 16)}`,
    projectName: normalizeLabel(label) || path.basename(cwd) || "未归类项目",
  };
}

function rowToVersion(row, isLatest) {
  const office = row.category === "office";
  const markdown = row.category === "markdown";
  const currentExists = (office || markdown) && isLatest && existsSync(row.locator);
  return {
    id: row.id,
    threadId: row.thread_id,
    projectId: row.project_id,
    projectName: row.project_name,
    taskName: row.task_name,
    title: row.title,
    locator: row.locator,
    deliveryContext: row.delivery_context,
    deliveredAt: row.delivered_at,
    snapshotStatus: row.snapshot_status,
    openable: markdown
      ? currentExists
      : !office || Boolean(row.snapshot_path && existsSync(row.snapshot_path)) || currentExists,
    isLatest,
  };
}

export class DocumentArtifactStore {
  constructor({
    dataDirectory,
    codexStatePath,
    codexThreadsPath,
    memoryDirectory,
    automationsDirectory,
    historyDays = DEFAULT_HISTORY_DAYS,
    includeLongTerm = false,
    enableSnapshots = false,
    platformTitleResolver = null,
    onChange = () => {},
  }) {
    this.dataDirectory = dataDirectory;
    this.databasePath = path.join(dataDirectory, "document-artifacts.sqlite");
    this.blobsDirectory = path.join(dataDirectory, "document-artifact-blobs");
    this.codexStatePath = codexStatePath;
    this.codexThreadsPath = codexThreadsPath;
    const codexHome = path.dirname(codexStatePath);
    this.memoryDirectory = memoryDirectory ?? path.join(codexHome, "memories");
    this.automationsDirectory = automationsDirectory ?? path.join(codexHome, "automations");
    this.historyDays = historyDays;
    this.includeLongTerm = includeLongTerm === true;
    this.enableSnapshots = enableSnapshots === true;
    this.platformTitleResolver = platformTitleResolver;
    this.onChange = onChange;
    this.interval = null;
    this.scanPromise = null;
    this.longTermTargets = new Map();
    mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
    chmodSync(dataDirectory, 0o700);
    mkdirSync(this.blobsDirectory, { recursive: true, mode: 0o700 });
    chmodSync(this.blobsDirectory, 0o700);
    this.database = new DatabaseSync(this.databasePath);
    chmodSync(this.databasePath, 0o600);
    this.database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    for (const suffix of ["-wal", "-shm"]) {
      try {
        chmodSync(`${this.databasePath}${suffix}`, 0o600);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    this.#migrate();
  }

  #migrate() {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS document_artifacts (
        id TEXT PRIMARY KEY,
        logical_key TEXT NOT NULL UNIQUE,
        category TEXT NOT NULL CHECK (category IN ('feishu', 'wecom', 'office', 'markdown')),
        office_type TEXT CHECK (office_type IS NULL OR office_type IN ('word', 'excel', 'powerpoint')),
        title TEXT NOT NULL,
        latest_locator TEXT NOT NULL,
        latest_version_id TEXT,
        latest_delivered_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS document_artifacts_updated
        ON document_artifacts(latest_delivered_at DESC, id);

      CREATE TABLE IF NOT EXISTS document_versions (
        id TEXT PRIMARY KEY,
        artifact_id TEXT NOT NULL REFERENCES document_artifacts(id) ON DELETE CASCADE,
        thread_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        project_name TEXT NOT NULL,
        task_name TEXT NOT NULL,
        title TEXT NOT NULL,
        locator TEXT NOT NULL,
        canonical_locator TEXT NOT NULL,
        delivery_context TEXT NOT NULL DEFAULT '',
        delivered_at TEXT NOT NULL,
        snapshot_path TEXT,
        snapshot_status TEXT NOT NULL CHECK (snapshot_status IN (
          'available', 'unavailable_historical', 'missing', 'platform_history'
        )),
        created_at TEXT NOT NULL,
        UNIQUE(thread_id, delivered_at, canonical_locator)
      );
      CREATE INDEX IF NOT EXISTS document_versions_artifact_time
        ON document_versions(artifact_id, delivered_at DESC, id);
      CREATE INDEX IF NOT EXISTS document_versions_locator
        ON document_versions(canonical_locator, delivered_at DESC);

      CREATE TABLE IF NOT EXISTS document_scan_state (
        rollout_path TEXT PRIMARY KEY,
        byte_offset INTEGER NOT NULL DEFAULT 0,
        last_user_context TEXT NOT NULL DEFAULT '',
        scanner_version INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS document_platform_titles (
        canonical_locator TEXT PRIMARY KEY,
        title TEXT,
        attempted_at TEXT NOT NULL,
        resolver_version INTEGER NOT NULL DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS document_libraries (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        logo_data_url TEXT,
        match_type TEXT NOT NULL CHECK (match_type IN ('domain', 'rules')),
        domain_contains TEXT,
        match_mode TEXT NOT NULL DEFAULT 'all' CHECK (match_mode IN ('all', 'any')),
        rules_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS document_library_order (
        library_id TEXT PRIMARY KEY,
        position INTEGER NOT NULL
      );
    `);
    this.database.exec(`
      UPDATE document_artifacts
      SET created_at = COALESCE((
        SELECT MIN(delivered_at) FROM document_versions
        WHERE artifact_id = document_artifacts.id
      ), created_at);
    `);
    let needsFullRescan = false;
    const versionColumns = this.database.prepare("PRAGMA table_info(document_versions)").all();
    if (!versionColumns.some((column) => column.name === "delivery_context")) {
      this.database.exec("ALTER TABLE document_versions ADD COLUMN delivery_context TEXT NOT NULL DEFAULT '';");
      needsFullRescan = true;
    }
    const scanColumns = this.database.prepare("PRAGMA table_info(document_scan_state)").all();
    if (!scanColumns.some((column) => column.name === "last_user_context")) {
      this.database.exec("ALTER TABLE document_scan_state ADD COLUMN last_user_context TEXT NOT NULL DEFAULT '';");
      needsFullRescan = true;
    }
    if (!scanColumns.some((column) => column.name === "scanner_version")) {
      this.database.exec("ALTER TABLE document_scan_state ADD COLUMN scanner_version INTEGER NOT NULL DEFAULT 1;");
      needsFullRescan = true;
    }
    const needsVersionRescan = Boolean(this.database.prepare(`
      SELECT 1 FROM document_scan_state WHERE scanner_version < ? LIMIT 1
    `).get(DOCUMENT_SCANNER_VERSION));
    const platformTitleColumns = this.database.prepare("PRAGMA table_info(document_platform_titles)").all();
    if (!platformTitleColumns.some((column) => column.name === "resolver_version")) {
      this.database.exec("ALTER TABLE document_platform_titles ADD COLUMN resolver_version INTEGER NOT NULL DEFAULT 1;");
    }
    const artifactSchema = this.database.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'document_artifacts'
    `).get()?.sql ?? "";
    if (!artifactSchema.includes("'markdown'")) {
      this.database.exec(`
        PRAGMA foreign_keys = OFF;
        BEGIN IMMEDIATE;
        ALTER TABLE document_versions RENAME TO document_versions_before_markdown;
        ALTER TABLE document_artifacts RENAME TO document_artifacts_before_markdown;

        CREATE TABLE document_artifacts (
          id TEXT PRIMARY KEY,
          logical_key TEXT NOT NULL UNIQUE,
          category TEXT NOT NULL CHECK (category IN ('feishu', 'wecom', 'office', 'markdown')),
          office_type TEXT CHECK (office_type IS NULL OR office_type IN ('word', 'excel', 'powerpoint')),
          title TEXT NOT NULL,
          latest_locator TEXT NOT NULL,
          latest_version_id TEXT,
          latest_delivered_at TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE document_versions (
          id TEXT PRIMARY KEY,
          artifact_id TEXT NOT NULL REFERENCES document_artifacts(id) ON DELETE CASCADE,
          thread_id TEXT NOT NULL,
          project_id TEXT NOT NULL,
          project_name TEXT NOT NULL,
          task_name TEXT NOT NULL,
          title TEXT NOT NULL,
          locator TEXT NOT NULL,
          canonical_locator TEXT NOT NULL,
          delivery_context TEXT NOT NULL DEFAULT '',
          delivered_at TEXT NOT NULL,
          snapshot_path TEXT,
          snapshot_status TEXT NOT NULL CHECK (snapshot_status IN (
            'available', 'unavailable_historical', 'missing', 'platform_history'
          )),
          created_at TEXT NOT NULL,
          UNIQUE(thread_id, delivered_at, canonical_locator)
        );
        INSERT INTO document_artifacts SELECT * FROM document_artifacts_before_markdown;
        INSERT INTO document_versions (
          id, artifact_id, thread_id, project_id, project_name, task_name, title,
          locator, canonical_locator, delivery_context, delivered_at, snapshot_path,
          snapshot_status, created_at
        ) SELECT
          id, artifact_id, thread_id, project_id, project_name, task_name, title,
          locator, canonical_locator, delivery_context, delivered_at, snapshot_path,
          snapshot_status, created_at
        FROM document_versions_before_markdown;
        DROP TABLE document_versions_before_markdown;
        DROP TABLE document_artifacts_before_markdown;
        CREATE INDEX document_artifacts_updated
          ON document_artifacts(latest_delivered_at DESC, id);
        CREATE INDEX document_versions_artifact_time
          ON document_versions(artifact_id, delivered_at DESC, id);
        CREATE INDEX document_versions_locator
          ON document_versions(canonical_locator, delivered_at DESC);
        COMMIT;
        PRAGMA foreign_keys = ON;
      `);
      needsFullRescan = true;
    }
    if (needsFullRescan) {
      this.database.prepare(`
      UPDATE document_scan_state
      SET byte_offset = 0,
          last_user_context = '',
          scanner_version = MIN(scanner_version, ?)
      `).run(DOCUMENT_SCANNER_VERSION - 1);
    } else if (needsVersionRescan) {
      this.database.prepare(`
        UPDATE document_scan_state
        SET byte_offset = 0, last_user_context = ''
        WHERE scanner_version < ?
      `).run(DOCUMENT_SCANNER_VERSION);
    }
  }

  async start() {
    await this.scanNow();
    if (!this.interval) {
      this.interval = setInterval(() => void this.scanNow().catch(() => {}), 5_000);
      this.interval.unref();
    }
  }

  async stop() {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
    await this.scanPromise?.catch(() => {});
    this.database.close();
  }

  async #readCodexState() {
    try {
      return safeJson(await readFile(this.codexStatePath, "utf8"), {});
    } catch {
      return {};
    }
  }

  #recentThreads() {
    if (!existsSync(this.codexThreadsPath)) return [];
    const state = new DatabaseSync(this.codexThreadsPath, { readOnly: true });
    try {
      const cutoff = Number.isFinite(this.historyDays) && this.historyDays > 0
        ? Date.now() - this.historyDays * DAY_MS
        : 0;
      return state.prepare(`
        SELECT id, rollout_path, title, cwd,
          COALESCE(updated_at_ms, updated_at * 1000) AS updated_at_ms
        FROM threads
        WHERE rollout_path <> ''
          AND COALESCE(updated_at_ms, updated_at * 1000) >= ?
          AND (agent_role IS NULL OR agent_role = '')
        ORDER BY updated_at_ms, id
      `).all(cutoff);
    } finally {
      state.close();
    }
  }

  async #readRollout(thread) {
    const scan = this.database.prepare(`
      SELECT byte_offset, last_user_context, scanner_version
      FROM document_scan_state
      WHERE rollout_path = ?
    `).get(thread.rollout_path);
    const requiresHistoricalRescan = !scan
      || Number(scan.scanner_version ?? 1) < DOCUMENT_SCANNER_VERSION;
    const offset = Number(scan?.byte_offset ?? 0);
    let historical = requiresHistoricalRescan;
    try {
      const info = await stat(thread.rollout_path);
      const safeOffset = offset <= info.size ? offset : 0;
      const restartedAfterTruncation = safeOffset !== offset;
      historical = requiresHistoricalRescan || restartedAfterTruncation;
      if (safeOffset >= info.size) {
        return {
          candidates: [],
          offset: info.size,
          historical,
          lastUserContext: scan?.last_user_context ?? "",
        };
      }
      const candidates = [];
      const cutoff = Number.isFinite(this.historyDays) && this.historyDays > 0
        ? Date.now() - this.historyDays * DAY_MS
        : 0;
      let nextOffset = safeOffset;
      let lastUserContext = restartedAfterTruncation ? "" : (scan?.last_user_context ?? "");
      const stream = createReadStream(thread.rollout_path, {
        start: safeOffset,
      });
      const processLine = (line) => {
        if (!line.trim()) return;
        const item = safeJson(line, null);
        if (
          item?.type === "response_item"
          && item.payload?.type === "message"
          && item.payload?.role === "user"
        ) {
          const userText = (item.payload.content ?? [])
            .filter((part) => typeof part?.text === "string")
            .map((part) => part.text)
            .join("\n");
          const nextUserContext = userDeliveryContext(userText);
          if (nextUserContext) lastUserContext = nextUserContext;
          return;
        }
        if (
          item?.type !== "response_item"
          || item.payload?.type !== "message"
          || item.payload?.role !== "assistant"
          || item.payload?.phase !== "final_answer"
        ) return;
        const deliveredAt = typeof item.timestamp === "string" ? item.timestamp : null;
        if (!deliveredAt || Date.parse(deliveredAt) < cutoff) return;
        const output = (item.payload.content ?? [])
          .filter((part) => part?.type === "output_text" && typeof part.text === "string")
          .map((part) => part.text)
          .join("\n");
        for (const candidate of extractCandidates(output)) {
          candidates.push({
            ...candidate,
            deliveryContext: lastUserContext || candidate.deliveryContext,
            deliveredAt,
            thread,
          });
        }
      };
      let lineChunks = [];
      let lineBytes = 0;
      let lineOversized = false;
      for await (const chunk of stream) {
        let start = 0;
        for (let index = chunk.indexOf(0x0a, start); index >= 0; index = chunk.indexOf(0x0a, start)) {
          const segment = chunk.subarray(start, index);
          if (!lineOversized && lineBytes + segment.length <= MAX_JSON_LINE_BYTES) {
            lineChunks.push(segment);
          } else {
            lineOversized = true;
            lineChunks = [];
          }
          lineBytes += segment.length;
          nextOffset += lineBytes + 1;
          if (!lineOversized) {
            processLine(Buffer.concat(lineChunks, lineBytes).toString("utf8"));
          }
          lineChunks = [];
          lineBytes = 0;
          lineOversized = false;
          start = index + 1;
        }
        const remainder = chunk.subarray(start);
        if (!lineOversized && lineBytes + remainder.length <= MAX_JSON_LINE_BYTES) {
          lineChunks.push(remainder);
        } else {
          lineOversized = true;
          lineChunks = [];
        }
        lineBytes += remainder.length;
      }
      return { candidates, offset: nextOffset, historical, lastUserContext };
    } catch (error) {
      if (error?.code === "ENOENT") {
        return { candidates: [], offset, historical, lastUserContext: scan?.last_user_context ?? "" };
      }
      throw error;
    }
  }

  async #snapshot(candidate, allowHistoricalSnapshot) {
    if (candidate.category === "markdown") {
      return { snapshotPath: null, snapshotStatus: "unavailable_historical" };
    }
    if (candidate.category !== "office") {
      return { snapshotPath: null, snapshotStatus: "platform_history" };
    }
    if (!this.enableSnapshots) {
      return { snapshotPath: null, snapshotStatus: "unavailable_historical" };
    }
    if (!allowHistoricalSnapshot) {
      return { snapshotPath: null, snapshotStatus: "unavailable_historical" };
    }
    try {
      const info = await stat(candidate.canonical);
      if (!info.isFile()) return { snapshotPath: null, snapshotStatus: "missing" };
      const hash = await fileSha256(candidate.canonical);
      const extension = path.extname(candidate.canonical).toLowerCase();
      const snapshotPath = path.join(this.blobsDirectory, `${hash}${extension}`);
      await mkdir(this.blobsDirectory, { recursive: true, mode: 0o700 });
      await chmod(this.blobsDirectory, 0o700);
      if (!existsSync(snapshotPath)) await copyFile(candidate.canonical, snapshotPath);
      await chmod(snapshotPath, 0o600);
      return { snapshotPath, snapshotStatus: "available" };
    } catch {
      return { snapshotPath: null, snapshotStatus: "missing" };
    }
  }

  async #platformTitle(locator) {
    if (typeof this.platformTitleResolver !== "function") return null;
    const cached = this.database.prepare(`
      SELECT title, attempted_at, resolver_version
      FROM document_platform_titles WHERE canonical_locator = ?
    `).get(locator);
    if (cached?.resolver_version === PLATFORM_TITLE_RESOLVER_VERSION) {
      const age = Date.now() - Date.parse(cached.attempted_at);
      const ttl = cached.title ? PLATFORM_TITLE_SUCCESS_TTL_MS : PLATFORM_TITLE_FAILURE_TTL_MS;
      if (Number.isFinite(age) && age < ttl) return cached.title || null;
    }
    const title = normalizeLabel(await this.platformTitleResolver(locator)) || null;
    this.database.prepare(`
      INSERT INTO document_platform_titles (canonical_locator, title, attempted_at, resolver_version)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(canonical_locator) DO UPDATE SET
        title = excluded.title,
        attempted_at = excluded.attempted_at,
        resolver_version = excluded.resolver_version
    `).run(locator, title, nowIso(), PLATFORM_TITLE_RESOLVER_VERSION);
    return title;
  }

  async #withPlatformTitle(candidate) {
    if (
      typeof this.platformTitleResolver !== "function"
      || !["feishu", "wecom"].includes(candidate.category)
      || !candidate.needsPlatformTitle
    ) {
      return candidate;
    }
    const title = await this.#platformTitle(candidate.canonical);
    return title ? { ...candidate, title } : candidate;
  }

  #withMarkdownTitle(candidate) {
    if (candidate.category !== "markdown") return candidate;
    const source = readSmallTextFile(candidate.canonical);
    if (!source) return candidate;
    const heading = source.text.match(/^#\s+(.+?)\s*$/mu)?.[1]
      ?.replace(/[*_`]/gu, "")
      .trim();
    return heading ? { ...candidate, title: heading } : candidate;
  }

  async #refreshStoredPlatformTitles(limit = 8) {
    if (typeof this.platformTitleResolver !== "function") return 0;
    const artifacts = this.database.prepare(`
      SELECT id, title, latest_locator
      FROM document_artifacts
      WHERE category IN ('feishu', 'wecom')
      ORDER BY latest_delivered_at DESC, id
    `).all();
    let checked = 0;
    let updated = 0;
    for (const artifact of artifacts) {
      const cached = this.database.prepare(`
        SELECT title, attempted_at, resolver_version
        FROM document_platform_titles WHERE canonical_locator = ?
      `).get(artifact.latest_locator);
      let title = null;
      if (cached?.resolver_version === PLATFORM_TITLE_RESOLVER_VERSION) {
        const age = Date.now() - Date.parse(cached.attempted_at);
        const ttl = cached.title ? PLATFORM_TITLE_SUCCESS_TTL_MS : PLATFORM_TITLE_FAILURE_TTL_MS;
        if (Number.isFinite(age) && age < ttl) {
          if (!cached.title || cached.title === artifact.title) continue;
          title = cached.title;
        }
      }
      if (!title) {
        title = await this.#platformTitle(artifact.latest_locator);
        checked += 1;
      }
      if (title && title !== artifact.title) {
        this.database.prepare(`
          UPDATE document_artifacts SET title = ?, updated_at = ? WHERE id = ?
        `).run(title, nowIso(), artifact.id);
        const versions = this.database.prepare(`
          SELECT id, title FROM document_versions WHERE artifact_id = ?
        `).all(artifact.id);
        for (const version of versions) {
          if (version.title === title) continue;
          this.database.prepare("UPDATE document_versions SET title = ? WHERE id = ?")
            .run(title, version.id);
        }
        updated += 1;
      }
      if (checked >= limit) break;
    }
    return updated;
  }

  async #refreshAutomationPlatformTitles(limit = 4) {
    if (!this.includeLongTerm || typeof this.platformTitleResolver !== "function") return;
    let checked = 0;
    for (const reference of this.#automationDocumentReferences().values()) {
      const cached = this.database.prepare(`
        SELECT title, attempted_at, resolver_version
        FROM document_platform_titles WHERE canonical_locator = ?
      `).get(reference.canonical);
      if (cached?.resolver_version === PLATFORM_TITLE_RESOLVER_VERSION) {
        const age = Date.now() - Date.parse(cached.attempted_at);
        const ttl = cached.title ? PLATFORM_TITLE_SUCCESS_TTL_MS : PLATFORM_TITLE_FAILURE_TTL_MS;
        if (Number.isFinite(age) && age < ttl) continue;
      }
      await this.#platformTitle(reference.canonical);
      checked += 1;
      if (checked >= limit) break;
    }
  }

  #existingArtifact(candidate, threadId) {
    const byLocator = this.database.prepare(`
      SELECT a.*
      FROM document_artifacts a
      JOIN document_versions v ON v.artifact_id = a.id
      WHERE v.canonical_locator = ?
      ORDER BY v.delivered_at DESC
      LIMIT 1
    `).get(candidate.canonical);
    if (byLocator) return byLocator;
    return this.database.prepare(`
      SELECT * FROM document_artifacts WHERE logical_key = ?
    `).get(logicalKey(candidate, threadId));
  }

  async #recordCandidate(candidate, context, allowHistoricalSnapshot) {
    const recordedAt = nowIso();
    const artifact = this.#existingArtifact(candidate, candidate.thread.id);
    const artifactId = artifact?.id ?? randomUUID();
    const key = artifact?.logical_key ?? logicalKey(candidate, candidate.thread.id);
    if (!artifact) {
      this.database.prepare(`
        INSERT INTO document_artifacts (
          id, logical_key, category, office_type, title, latest_locator,
          latest_version_id, latest_delivered_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
      `).run(
        artifactId, key, candidate.category, candidate.officeType,
        candidate.title, candidate.locator, candidate.deliveredAt, candidate.deliveredAt, recordedAt,
      );
    }

    const existingVersion = this.database.prepare(`
      SELECT id, delivery_context FROM document_versions
      WHERE thread_id = ? AND delivered_at = ? AND canonical_locator = ?
    `).get(candidate.thread.id, candidate.deliveredAt, candidate.canonical);
    if (existingVersion) {
      if (candidate.deliveryContext && existingVersion.delivery_context !== candidate.deliveryContext) {
        this.database.prepare(`
          UPDATE document_versions SET delivery_context = ? WHERE id = ?
        `).run(candidate.deliveryContext, existingVersion.id);
      }
      return false;
    }

    const snapshot = await this.#snapshot(candidate, allowHistoricalSnapshot);
    const versionId = randomUUID();
    this.database.prepare(`
      INSERT INTO document_versions (
        id, artifact_id, thread_id, project_id, project_name, task_name,
        title, locator, canonical_locator, delivery_context, delivered_at,
        snapshot_path, snapshot_status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      versionId, artifactId, candidate.thread.id,
      context.projectId, context.projectName, normalizeLabel(candidate.thread.title) || "未命名任务",
      candidate.title, candidate.locator, candidate.canonical, candidate.deliveryContext, candidate.deliveredAt,
      snapshot.snapshotPath, snapshot.snapshotStatus, recordedAt,
    );

    const latest = this.database.prepare(`
      SELECT id, title, locator, delivered_at
      FROM document_versions
      WHERE artifact_id = ?
      ORDER BY delivered_at DESC, id DESC
      LIMIT 1
    `).get(artifactId);
    this.database.prepare(`
      UPDATE document_artifacts
      SET title = ?, latest_locator = ?, latest_version_id = ?,
          latest_delivered_at = ?, updated_at = ?
      WHERE id = ?
    `).run(latest.title, latest.locator, latest.id, latest.delivered_at, recordedAt, artifactId);
    return true;
  }

  async #removeRepeatedPathSnapshots() {
    const repeatedPaths = this.database.prepare(`
      SELECT canonical_locator
      FROM document_versions
      WHERE canonical_locator LIKE '/%'
      GROUP BY canonical_locator
      HAVING COUNT(*) > 1
    `).all();
    let removed = 0;
    for (const { canonical_locator: locator } of repeatedPaths) {
      const snapshots = this.database.prepare(`
        SELECT DISTINCT snapshot_path
        FROM document_versions
        WHERE canonical_locator = ? AND snapshot_path IS NOT NULL
      `).all(locator);
      this.database.prepare(`
        UPDATE document_versions
        SET snapshot_path = NULL, snapshot_status = 'unavailable_historical'
        WHERE canonical_locator = ?
      `).run(locator);
      for (const { snapshot_path: snapshotPath } of snapshots) {
        const stillReferenced = this.database.prepare(`
          SELECT 1 FROM document_versions WHERE snapshot_path = ? LIMIT 1
        `).get(snapshotPath);
        if (stillReferenced || !snapshotPath) continue;
        try {
          await unlink(snapshotPath);
          removed += 1;
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
      }
    }
    return removed;
  }

  async #scan() {
    const state = await this.#readCodexState();
    const batches = [];
    for (const thread of this.#recentThreads()) {
      const batch = await this.#readRollout(thread);
      batches.push({ thread, ...batch });
    }

    const historicalLatestByPath = new Map();
    if (this.enableSnapshots) {
      for (const batch of batches) {
        if (!batch.historical) continue;
        for (const candidate of batch.candidates) {
          if (candidate.category !== "office") continue;
          const previous = historicalLatestByPath.get(candidate.canonical);
          if (!previous || candidate.deliveredAt > previous.deliveredAt) {
            historicalLatestByPath.set(candidate.canonical, candidate);
          }
        }
      }
    }

    let created = 0;
    for (const batch of batches) {
      const context = projectContext(state, batch.thread.id, batch.thread.cwd);
      for (const candidate of batch.candidates) {
        const resolvedCandidate = await this.#withPlatformTitle(this.#withMarkdownTitle(candidate));
        const allowHistoricalSnapshot = !batch.historical
          || resolvedCandidate.category !== "office"
          || historicalLatestByPath.get(resolvedCandidate.canonical) === candidate;
        if (await this.#recordCandidate(resolvedCandidate, context, allowHistoricalSnapshot)) created += 1;
      }
      this.database.prepare(`
        INSERT INTO document_scan_state (
          rollout_path, byte_offset, last_user_context, scanner_version, updated_at
        )
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(rollout_path) DO UPDATE SET
          byte_offset = excluded.byte_offset,
          last_user_context = excluded.last_user_context,
          scanner_version = excluded.scanner_version,
          updated_at = excluded.updated_at
      `).run(
        batch.thread.rollout_path,
        batch.offset,
        batch.lastUserContext,
        DOCUMENT_SCANNER_VERSION,
        nowIso(),
      );
    }
    await this.#removeRepeatedPathSnapshots();
    const renamed = await this.#refreshStoredPlatformTitles();
    if (this.includeLongTerm) await this.#refreshAutomationPlatformTitles();
    if (created > 0 || renamed > 0) this.onChange({ created, renamed, at: nowIso() });
    return { created, renamed, scannedThreads: batches.length };
  }

  async scanNow() {
    if (this.scanPromise) return this.scanPromise;
    this.scanPromise = this.#scan().finally(() => { this.scanPromise = null; });
    return this.scanPromise;
  }

  #serializedArtifacts() {
    const artifacts = this.database.prepare(`
      SELECT * FROM document_artifacts ORDER BY latest_delivered_at DESC, id
    `).all();
    return artifacts.map((artifact) => {
      const versionRows = this.database.prepare(`
        SELECT v.*, a.category
        FROM document_versions v
        JOIN document_artifacts a ON a.id = v.artifact_id
        WHERE v.artifact_id = ?
        ORDER BY v.delivered_at DESC, v.id DESC
      `).all(artifact.id);
      const versions = versionRows.map((row) => rowToVersion(row, row.id === artifact.latest_version_id));
      const tags = [];
      const seen = new Set();
      for (const version of versions) {
        const key = `${version.projectId}\u0000${version.taskName}`;
        if (seen.has(key)) continue;
        seen.add(key);
        tags.push({
          projectId: version.projectId,
          projectName: version.projectName,
          taskName: version.taskName,
          threadId: version.threadId,
          deliveryContext: version.deliveryContext,
          deliveredAt: version.deliveredAt,
        });
      }
      return {
        id: artifact.id,
        category: artifact.category,
        officeType: artifact.office_type,
        title: artifact.title,
        locator: artifact.latest_locator,
        fileSize: localFileSize(artifact.latest_locator),
        createdAt: artifact.created_at,
        updatedAt: artifact.latest_delivered_at,
        tags,
        versions,
        versionCount: versions.length,
      };
    });
  }

  #importantMemoryDocuments() {
    if (!this.includeLongTerm) return [];
    const titles = {
      "memory_summary.md": "Codex 记忆摘要",
      "MEMORY.md": "Codex 长期记忆索引",
      "raw_memories.md": "Codex 原始记忆",
    };
    return IMPORTANT_MEMORY_FILES.flatMap((filename) => {
      const absolutePath = path.join(this.memoryDirectory, filename);
      const source = readSmallTextFile(absolutePath);
      if (!source) return [];
      const id = stableLongTermId("memory", absolutePath);
      this.longTermTargets.set(id, { kind: "memory", path: absolutePath, title: titles[filename] ?? filename });
      return [{
        id,
        category: "memory",
        officeType: null,
        title: titles[filename] ?? filename,
        locator: absolutePath,
        createdAt: fileCreatedAt(source.info),
        updatedAt: source.info.mtime.toISOString(),
        tags: [{
          projectId: "codex-memory",
          projectName: "Codex Memory",
          taskName: filename,
          threadId: "",
          deliveryContext: "",
          deliveredAt: source.info.mtime.toISOString(),
        }],
        versions: [],
        versionCount: 1,
        longTerm: { id, kind: "memory" },
      }];
    });
  }

  #automationDocumentReferences() {
    const references = new Map();
    if (!this.includeLongTerm) return references;
    let directories = [];
    try {
      directories = readdirSync(this.automationsDirectory, { withFileTypes: true })
        .filter((entry) => entry.isDirectory());
    } catch {
      return references;
    }
    for (const directory of directories) {
      const configPath = path.join(this.automationsDirectory, directory.name, "automation.toml");
      const config = readSmallTextFile(configPath);
      if (!config) continue;
      const automationName = normalizeLabel(tomlString(config.text, "name")) || directory.name;
      const targetThreadId = normalizeLabel(tomlString(config.text, "target_thread_id"));
      const sources = [{
        text: config.text,
        createdAt: fileCreatedAt(config.info),
        updatedAt: config.info.mtime.toISOString(),
      }];
      const referencedPaths = new Set();
      for (const match of config.text.matchAll(/(\/(?:Users|private|Volumes)\/[^\\\n"'`]+?\.(?:md|py|json|toml))/gu)) {
        referencedPaths.add(match[1]);
      }
      for (const filename of referencedPaths) {
        const referenced = readSmallTextFile(filename);
        if (referenced) {
          sources.push({
            text: referenced.text,
            createdAt: fileCreatedAt(referenced.info),
            updatedAt: referenced.info.mtime.toISOString(),
          });
        }
      }
      for (const source of sources) {
        for (const candidate of extractCandidates(source.text)) {
          if (candidate.category === "office") continue;
          const existing = references.get(candidate.canonical) ?? {
            canonical: candidate.canonical,
            category: candidate.category,
            title: candidate.title,
            createdAt: source.createdAt,
            updatedAt: source.updatedAt,
            automations: [],
          };
          if (needsPlatformTitle(existing.title, candidate.canonical) && !needsPlatformTitle(candidate.title, candidate.canonical)) {
            existing.title = candidate.title;
          }
          if (source.updatedAt > existing.updatedAt) existing.updatedAt = source.updatedAt;
          if (source.createdAt < existing.createdAt) existing.createdAt = source.createdAt;
          if (!existing.automations.some((item) => item.name === automationName)) {
            existing.automations.push({ name: automationName, threadId: targetThreadId });
          }
          references.set(candidate.canonical, existing);
        }
      }
    }
    for (const reference of references.values()) {
      const cached = this.database.prepare(`
        SELECT title, resolver_version FROM document_platform_titles WHERE canonical_locator = ?
      `).get(reference.canonical);
      if (cached?.resolver_version === PLATFORM_TITLE_RESOLVER_VERSION && cached.title) {
        reference.title = cached.title;
      }
    }
    return references;
  }

  #longTermDocuments(serialized) {
    this.longTermTargets.clear();
    if (!this.includeLongTerm) return [];
    const byLocator = new Map();
    for (const artifact of serialized) {
      byLocator.set(artifact.locator, artifact);
      for (const version of artifact.versions) byLocator.set(version.locator, artifact);
    }
    const documents = this.#importantMemoryDocuments();
    const includedLocators = new Set(documents.map((document) => document.locator));
    for (const artifact of serialized) {
      if (!isSharedLongTermArtifact(artifact)) continue;
      documents.push(artifact);
      includedLocators.add(artifact.locator);
      for (const version of artifact.versions) includedLocators.add(version.locator);
    }
    for (const reference of this.#automationDocumentReferences().values()) {
      const existing = byLocator.get(reference.canonical);
      if (!isLongTermAutomationReference(reference)) continue;
      if (includedLocators.has(reference.canonical)) continue;
      const id = stableLongTermId("automation", reference.canonical);
      this.longTermTargets.set(id, { kind: "automation", target: reference.canonical, title: reference.title });
      if (existing) {
        const automationTags = reference.automations.map((automation) => ({
          projectId: "codex-automations",
          projectName: "定期任务",
          taskName: automation.name,
          threadId: automation.threadId,
          deliveryContext: "",
          deliveredAt: reference.updatedAt,
        }));
        documents.push({
          ...existing,
          tags: automationTags.length > 0 ? automationTags : existing.tags,
          longTerm: {
            id,
            kind: "automation",
            automationNames: reference.automations.map((item) => item.name),
          },
        });
        continue;
      }
      const tags = reference.automations.map((automation) => ({
        projectId: "codex-automations",
        projectName: "定期任务",
        taskName: automation.name,
        threadId: automation.threadId,
        deliveryContext: "",
        deliveredAt: reference.updatedAt,
      }));
      documents.push({
        id,
        category: reference.category,
        officeType: null,
        title: reference.title,
        locator: reference.canonical,
        createdAt: reference.createdAt,
        updatedAt: reference.updatedAt,
        tags,
        versions: [],
        versionCount: 1,
        longTerm: {
          id,
          kind: "automation",
          automationNames: reference.automations.map((item) => item.name),
        },
      });
    }
    return documents.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  #refreshLongTermTargets() {
    if (!this.includeLongTerm) return;
    this.#longTermDocuments(this.#serializedArtifacts());
  }

  readLongTermDocument(id) {
    if (!this.includeLongTerm) return null;
    if (!this.longTermTargets.has(id)) this.#refreshLongTermTargets();
    const target = this.longTermTargets.get(id);
    if (!target || target.kind !== "memory") return null;
    const source = readSmallTextFile(target.path);
    if (!source) return null;
    return {
      id,
      title: target.title,
      filename: path.basename(target.path),
      updatedAt: source.info.mtime.toISOString(),
      content: source.text,
    };
  }

  readMarkdownArtifact(artifactId) {
    const artifact = this.database.prepare(`
      SELECT id, title, latest_locator, latest_delivered_at
      FROM document_artifacts
      WHERE id = ? AND category = 'markdown'
    `).get(artifactId);
    if (!artifact) return null;
    const source = readSmallTextFile(artifact.latest_locator);
    if (!source) return null;
    const id = `markdown-artifact-${artifact.id}`;
    this.longTermTargets.set(id, {
      kind: "memory",
      path: artifact.latest_locator,
      title: artifact.title,
    });
    return {
      id,
      title: artifact.title,
      filename: path.basename(artifact.latest_locator),
      updatedAt: source.info.mtime.toISOString(),
      content: source.text,
    };
  }

  resolveLongTermOpenTarget(id) {
    if (!this.includeLongTerm) return null;
    if (!this.longTermTargets.has(id)) this.#refreshLongTermTargets();
    const target = this.longTermTargets.get(id);
    return target?.kind === "automation" ? { target: target.target } : null;
  }

  listLibraries() {
    const customLibraries = this.database.prepare(`
      SELECT * FROM document_libraries ORDER BY created_at, id
    `).all().map((library) => ({
      id: library.id,
      name: library.name,
      kind: "custom",
      logoDataUrl: library.logo_data_url || null,
      matchType: library.match_type,
      domainContains: library.domain_contains || "",
      matchMode: library.match_mode,
      rules: safeJson(library.rules_json, []),
    }));
    const positions = new Map(this.database.prepare(`
      SELECT library_id, position FROM document_library_order
    `).all().map((row) => [row.library_id, Number(row.position)]));
    const builtinLibraries = this.includeLongTerm
      ? [...BUILTIN_DOCUMENT_LIBRARIES, LONG_TERM_DOCUMENT_LIBRARY]
      : BUILTIN_DOCUMENT_LIBRARIES;
    return [...builtinLibraries, ...customLibraries]
      .map((library, defaultPosition) => ({
        ...library,
        position: positions.get(library.id) ?? (10_000 + defaultPosition),
      }))
      .sort((left, right) => left.position - right.position)
      .map(({ position: _position, ...library }) => library);
  }

  createLibrary({ name, logoDataUrl = null, matchType, domainContains = "", matchMode = "all", rules = [] }) {
    const id = `custom-${randomUUID()}`;
    const timestamp = nowIso();
    this.database.prepare(`
      INSERT INTO document_libraries (
        id, name, logo_data_url, match_type, domain_contains, match_mode,
        rules_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      normalizeLabel(name),
      logoDataUrl || null,
      matchType,
      matchType === "domain" ? normalizeLabel(domainContains).toLocaleLowerCase("zh-CN") : null,
      matchMode,
      JSON.stringify(matchType === "rules" ? rules : []),
      timestamp,
      timestamp,
    );
    const order = this.listLibraries().map((library) => library.id);
    this.setLibraryOrder(order);
    return this.listLibraries().find((library) => library.id === id);
  }

  setLibraryOrder(ids) {
    const knownIds = new Set(this.listLibraries().map((library) => library.id));
    const ordered = [...new Set(ids)].filter((id) => knownIds.has(id));
    for (const id of knownIds) {
      if (!ordered.includes(id)) ordered.push(id);
    }
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare("DELETE FROM document_library_order").run();
      const insert = this.database.prepare(`
        INSERT INTO document_library_order (library_id, position) VALUES (?, ?)
      `);
      ordered.forEach((id, index) => insert.run(id, index));
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.listLibraries();
  }

  #matchesLibrary(artifact, library) {
    if (!library) return false;
    if (library.match_type === "domain") {
      try {
        return new URL(artifact.locator).hostname
          .toLocaleLowerCase("zh-CN")
          .includes(library.domain_contains);
      } catch {
        return false;
      }
    }
    const rules = safeJson(library.rules_json, []);
    if (rules.length === 0) return false;
    const source = artifact.category === "markdown" ? readSmallTextFile(artifact.locator) : null;
    const body = source?.text ?? artifact.versions
      .map((version) => version.deliveryContext)
      .filter(Boolean)
      .join("\n");
    const matches = rules.map((rule) => {
      if (rule.field === "title" || rule.field === "body") {
        const haystack = String(rule.field === "title" ? artifact.title : body).toLocaleLowerCase("zh-CN");
        const needle = String(rule.value ?? "").toLocaleLowerCase("zh-CN");
        if (rule.operator === "equals") return haystack === needle;
        if (rule.operator === "not_contains") return !haystack.includes(needle);
        return haystack.includes(needle);
      }
      if (rule.field === "createdAt" || rule.field === "updatedAt") {
        const actual = Date.parse(artifact[rule.field]);
        const expected = Date.parse(`${rule.value}T00:00:00+08:00`);
        if (!Number.isFinite(actual) || !Number.isFinite(expected)) return false;
        return rule.operator === "before" ? actual < expected : actual >= expected;
      }
      if (rule.field === "fileSize") {
        if (!Number.isFinite(artifact.fileSize)) return false;
        const expected = Number(rule.value) * 1024 * 1024;
        return rule.operator === "less_than" ? artifact.fileSize < expected : artifact.fileSize > expected;
      }
      return false;
    });
    return library.match_mode === "any" ? matches.some(Boolean) : matches.every(Boolean);
  }

  list({
    category = "all", projectId = "", query = "", task = "", title = "", timeField = "updated",
    startDate = "", endDate = "", libraryId = "", cursor = 0, limit = DEFAULT_PAGE_SIZE,
  } = {}) {
    const safeLimit = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(limit) || DEFAULT_PAGE_SIZE));
    const safeCursor = Math.max(0, Number(cursor) || 0);
    const baseArtifacts = this.#serializedArtifacts();
    const serialized = category === "long_term"
      ? (this.includeLongTerm ? this.#longTermDocuments(baseArtifacts) : [])
      : baseArtifacts;
    const customLibrary = libraryId
      ? this.database.prepare("SELECT * FROM document_libraries WHERE id = ?").get(libraryId)
      : null;

    const projectOptions = new Map();
    const taskOptions = new Set();
    for (const artifact of serialized) {
      for (const tag of artifact.tags) {
        projectOptions.set(tag.projectId, tag.projectName);
        taskOptions.add(tag.taskName);
      }
    }

    const titleNeedle = normalizeLabel(title).toLocaleLowerCase("zh-CN");
    const taskNeedle = normalizeLabel(task).toLocaleLowerCase("zh-CN");
    const queryNeedle = normalizeLabel(query).toLocaleLowerCase("zh-CN");
    const rangeStart = timeAtShanghaiDate(startDate);
    const rangeEnd = timeAtShanghaiDate(endDate, true);
    const filtered = serialized.filter((artifact) => {
      if (libraryId && !this.#matchesLibrary(artifact, customLibrary)) return false;
      if (category !== "all" && category !== "long_term" && artifact.category !== category) return false;
      if (projectId && !artifact.tags.some((tag) => tag.projectId === projectId)) return false;
      if (
        queryNeedle
        && ![
          artifact.title,
          ...artifact.versions.map((version) => version.title),
          ...artifact.tags.map((tag) => tag.taskName),
        ].some((value) => value.toLocaleLowerCase("zh-CN").includes(queryNeedle))
      ) return false;
      if (taskNeedle && !artifact.tags.some((tag) => tag.taskName.toLocaleLowerCase("zh-CN").includes(taskNeedle))) return false;
      if (
        titleNeedle
        && ![artifact.title, ...artifact.versions.map((version) => version.title)]
          .some((value) => value.toLocaleLowerCase("zh-CN").includes(titleNeedle))
      ) return false;
      const timestamp = Date.parse(timeField === "created" ? artifact.createdAt : artifact.updatedAt);
      if (rangeStart !== null && (!Number.isFinite(timestamp) || timestamp < rangeStart)) return false;
      if (rangeEnd !== null && (!Number.isFinite(timestamp) || timestamp >= rangeEnd)) return false;
      return true;
    });
    const items = filtered.slice(safeCursor, safeCursor + safeLimit);
    const nextCursor = safeCursor + items.length < filtered.length
      ? String(safeCursor + items.length)
      : null;
    return {
      items,
      nextCursor,
      total: filtered.length,
      filters: {
        projects: [...projectOptions].map(([id, name]) => ({ id, name }))
          .sort((left, right) => left.name.localeCompare(right.name, "zh-CN")),
        tasks: [...taskOptions].sort((left, right) => left.localeCompare(right, "zh-CN")),
      },
    };
  }

  resolveOpenTarget(artifactId, versionId = null) {
    const artifact = this.database.prepare(`
      SELECT * FROM document_artifacts WHERE id = ?
    `).get(artifactId);
    if (!artifact) return { error: "NOT_FOUND" };
    const version = versionId
      ? this.database.prepare(`
          SELECT * FROM document_versions WHERE id = ? AND artifact_id = ?
        `).get(versionId, artifactId)
      : this.database.prepare(`
          SELECT * FROM document_versions WHERE id = ? AND artifact_id = ?
        `).get(artifact.latest_version_id, artifactId);
    if (!version) return { error: "VERSION_NOT_FOUND" };
    if (artifact.category === "markdown") {
      if (version.id === artifact.latest_version_id && existsSync(version.locator)) {
        return { target: version.locator };
      }
      return { error: "VERSION_UNAVAILABLE" };
    }
    if (artifact.category !== "office") return { target: artifact.latest_locator };
    if (version.snapshot_path && existsSync(version.snapshot_path)) return { target: version.snapshot_path };
    if (version.id === artifact.latest_version_id && existsSync(version.locator)) return { target: version.locator };
    return { error: "VERSION_UNAVAILABLE" };
  }

  stats() {
    const artifacts = this.database.prepare("SELECT COUNT(*) AS count FROM document_artifacts").get().count;
    const versions = this.database.prepare("SELECT COUNT(*) AS count FROM document_versions").get().count;
    return { artifacts: Number(artifacts), versions: Number(versions) };
  }
}

export const documentArtifactInternals = {
  classifyOnlineUrl,
  extractCandidates,
  logicalKey,
  needsPlatformTitle,
  normalizeLocalPath,
  stripVersionSuffix,
};
