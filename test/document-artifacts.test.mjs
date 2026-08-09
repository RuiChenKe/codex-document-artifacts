import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DatabaseSync } from "node:sqlite";

import { createDocumentArtifactsServer, resolvePort, resolveServerOptions } from "../server/app.mjs";
import { DocumentArtifactStore } from "../server/document-artifacts.mjs";

function rolloutMessage(timestamp, role, text, phase) {
  return JSON.stringify({
    timestamp,
    type: "response_item",
    payload: {
      type: "message",
      role,
      ...(phase ? { phase } : {}),
      content: [{ type: role === "assistant" ? "output_text" : "input_text", text }],
    },
  });
}

async function createCodexFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-document-artifacts-"));
  const codexHome = path.join(root, ".codex");
  const dataDirectory = path.join(root, "module-data");
  const workspace = path.join(root, "workspace");
  const staticDirectory = path.join(root, "web-dist");
  const memoryDirectory = path.join(codexHome, "memories");
  const automationsDirectory = path.join(codexHome, "automations");
  await Promise.all([
    mkdir(codexHome, { recursive: true }),
    mkdir(workspace, { recursive: true }),
    mkdir(staticDirectory, { recursive: true }),
    mkdir(memoryDirectory, { recursive: true }),
    mkdir(automationsDirectory, { recursive: true }),
  ]);

  const markdownPath = path.join(workspace, "local-guide.md");
  const laterMarkdownPath = path.join(workspace, "later-guide.md");
  const ignoredMarkdownPath = path.join(workspace, "ignored.md");
  const officePath = path.join(workspace, "roadmap.pptx");
  const imagePath = path.join(workspace, "preview.png");
  await Promise.all([
    writeFile(markdownPath, "# 本地使用指南\n\n正文\n"),
    writeFile(laterMarkdownPath, "# 后续补充\n"),
    writeFile(ignoredMarkdownPath, "# 不应出现\n"),
    writeFile(officePath, "fake office fixture"),
    writeFile(imagePath, "fake image fixture"),
    writeFile(path.join(memoryDirectory, "memory_summary.md"), "# Memory\n"),
    writeFile(path.join(staticDirectory, "index.html"), "<!doctype html><title>Document artifacts fixture</title>"),
  ]);

  const rolloutPath = path.join(codexHome, "old-rollout.jsonl");
  const oldTimestamp = "2020-01-02T03:04:05.000Z";
  const lines = [
    rolloutMessage(oldTimestamp, "user", "请整理并交付这些文档"),
    rolloutMessage(oldTimestamp, "assistant", `[不应扫描](${ignoredMarkdownPath})`, "commentary"),
    rolloutMessage(oldTimestamp, "assistant", `[也不应扫描](${ignoredMarkdownPath})`),
    rolloutMessage(oldTimestamp, "assistant", [
      "已完成：",
      "[季度复盘](https://example.feishu.cn/docx/old-token)",
      "[知了方案](https://aistudio.bilibili.co/doc/zhiliao-token)",
      "[企微方案](https://doc.weixin.qq.com/doc/wecom-token)",
      "[无关网页](https://internal.example/doc/internal-token)",
      `[本地说明](${markdownPath})`,
      `[演示文稿](${officePath})`,
      `[预览图片](${imagePath})`,
    ].join("\n"), "final_answer"),
  ];
  await writeFile(rolloutPath, `${lines.join("\n")}\n`);

  const codexStatePath = path.join(codexHome, ".codex-global-state.json");
  await writeFile(codexStatePath, JSON.stringify({
    "local-projects": {
      fixture: { id: "fixture", name: "测试项目", rootPaths: [workspace] },
    },
    "thread-project-assignments": {
      "old-thread": { projectId: "fixture" },
    },
  }));

  const codexThreadsPath = path.join(codexHome, "state_5.sqlite");
  const threads = new DatabaseSync(codexThreadsPath);
  threads.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      rollout_path TEXT NOT NULL,
      title TEXT NOT NULL,
      cwd TEXT NOT NULL,
      updated_at INTEGER,
      updated_at_ms INTEGER,
      agent_role TEXT
    );
  `);
  threads.prepare(`
    INSERT INTO threads (
      id, rollout_path, title, cwd, updated_at, updated_at_ms, agent_role
    ) VALUES (?, ?, ?, ?, ?, ?, NULL)
  `).run(
    "old-thread",
    rolloutPath,
    "很久以前的文档任务",
    workspace,
    Math.floor(Date.parse(oldTimestamp) / 1000),
    Date.parse(oldTimestamp),
  );
  threads.close();

  return {
    root,
    codexHome,
    codexStatePath,
    codexThreadsPath,
    dataDirectory,
    workspace,
    staticDirectory,
    memoryDirectory,
    automationsDirectory,
    rolloutPath,
    markdownPath,
    laterMarkdownPath,
    ignoredMarkdownPath,
    officePath,
    imagePath,
  };
}

function storeOptions(fixture, overrides = {}) {
  return {
    dataDirectory: fixture.dataDirectory,
    codexStatePath: fixture.codexStatePath,
    codexThreadsPath: fixture.codexThreadsPath,
    memoryDirectory: fixture.memoryDirectory,
    automationsDirectory: fixture.automationsDirectory,
    ...overrides,
  };
}

function rawRequest({ port, path: requestPath, headers = {} }) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: "127.0.0.1",
      port,
      path: requestPath,
      method: "GET",
      headers,
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.once("end", () => resolve({
        status: response.statusCode,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.once("error", reject);
    request.end();
  });
}

test("扫描全部历史，只提取 final_answer，并保留复制链接所需 locator", async (t) => {
  const fixture = await createCodexFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  let store = new DocumentArtifactStore(storeOptions(fixture));
  const firstScan = await store.scanNow();
  assert.equal(firstScan.scannedThreads, 1, "默认应扫描本机仍保留的全部历史任务");
  assert.equal((await stat(fixture.dataDirectory)).mode & 0o777, 0o700);
  assert.equal(
    (await stat(path.join(fixture.dataDirectory, "document-artifact-blobs"))).mode & 0o777,
    0o700,
  );
  assert.equal(
    (await stat(path.join(fixture.dataDirectory, "document-artifacts.sqlite"))).mode & 0o777,
    0o600,
  );
  for (const suffix of ["-wal", "-shm"]) {
    assert.equal(
      (await stat(path.join(fixture.dataDirectory, `document-artifacts.sqlite${suffix}`))).mode & 0o777,
      0o600,
    );
  }

  const firstPage = store.list({ limit: 200 });
  assert.equal(firstPage.total, 6);
  const locators = new Set(firstPage.items.map((item) => item.locator));
  assert.deepEqual(locators, new Set([
    "https://example.feishu.cn/docx/old-token",
    "https://aistudio.bilibili.co/doc/zhiliao-token",
    "https://doc.weixin.qq.com/doc/wecom-token",
    fixture.markdownPath,
    fixture.officePath,
    fixture.imagePath,
  ]));
  assert.ok(!locators.has(fixture.ignoredMarkdownPath), "commentary 和无 phase 的消息不能成为产物");
  assert.ok(![...locators].some((locator) => locator.includes("internal.example")));
  assert.ok(firstPage.items.every((item) => item.versions.every((version) => version.locator)));
  assert.ok(firstPage.items.every((item) => item.tags[0].deliveryContext === "请整理并交付这些文档"));
  assert.equal(firstPage.items.find((item) => item.locator === fixture.markdownPath)?.title, "本地使用指南");

  const office = firstPage.items.find((item) => item.locator === fixture.officePath);
  assert.equal(office?.versions[0].snapshotStatus, "unavailable_historical");
  assert.equal(office?.versions[0].openable, true);
  assert.deepEqual(
    store.listLibraries().map((library) => library.id),
    ["feishu", "zhiliao", "wecom", "office", "markdown"],
  );
  assert.equal(store.list({ category: "long_term" }).total, 0);
  await store.stop();

  const moduleDatabasePath = path.join(fixture.dataDirectory, "document-artifacts.sqlite");
  const moduleDatabase = new DatabaseSync(moduleDatabasePath);
  moduleDatabase.prepare(`
    UPDATE document_scan_state SET scanner_version = 2
  `).run();
  moduleDatabase.close();
  await appendFile(fixture.rolloutPath, `${rolloutMessage(
    "2020-01-03T03:04:05.000Z",
    "assistant",
    `[第二次交付](${fixture.laterMarkdownPath})`,
    "final_answer",
  )}\n`);

  store = new DocumentArtifactStore(storeOptions(fixture));
  const pendingUpgradeState = store.database.prepare(`
    SELECT scanner_version, byte_offset FROM document_scan_state
  `).get();
  assert.equal(pendingUpgradeState.scanner_version, 2, "完成回扫前不能提前标记为新版扫描器");
  assert.equal(pendingUpgradeState.byte_offset, 0);
  const upgradeScan = await store.scanNow();
  assert.equal(upgradeScan.scannedThreads, 1);
  assert.equal(store.list({ limit: 200 }).total, 7, "scanner v5 升级应重置旧 offset 并完整重扫");
  assert.equal(store.list({ query: "后续补充" }).items[0]?.locator, fixture.laterMarkdownPath);
  const scanState = store.database.prepare(`
    SELECT scanner_version, byte_offset FROM document_scan_state
  `).get();
  assert.equal(scanState.scanner_version, 5);
  assert.ok(scanState.byte_offset > 0);
  await store.stop();

  store = new DocumentArtifactStore(storeOptions(fixture, {
    includeLongTerm: true,
  }));
  await store.start();
  assert.ok(!store.listLibraries().some((library) => library.id === "long_term"));
  await store.stop();
});

test("独立 HTTP 服务提供健康检查、列表和静态页面，并拒绝非回环 Host/Origin", async (t) => {
  const fixture = await createCodexFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const app = createDocumentArtifactsServer({
    ...storeOptions(fixture),
    staticDirectory: fixture.staticDirectory,
  });
  t.after(() => app.close());
  const address = await app.listen({ port: 0 });
  const port = address.port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const healthResponse = await fetch(`${baseUrl}/health`);
  assert.equal(healthResponse.status, 200);
  const health = await healthResponse.json();
  assert.equal(health.ok, true);
  assert.equal(health.stats.artifacts, 6);

  const listResponse = await fetch(`${baseUrl}/api/local/document-artifacts?limit=200`);
  assert.equal(listResponse.status, 200);
  const page = await listResponse.json();
  assert.equal(page.total, 6);
  assert.ok(page.items.every((item) => typeof item.locator === "string" && item.locator.length > 0));

  const createLibraryResponse = await fetch(`${baseUrl}/api/local/document-libraries`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "团队文档",
      logoDataUrl: null,
      matchType: "domain",
      domainContains: "example.com",
      matchMode: "all",
      rules: [],
    }),
  });
  assert.equal(createLibraryResponse.status, 201);
  const createdLibrary = (await createLibraryResponse.json()).library;

  const extensionLibraryResponse = await fetch(
    `${baseUrl}/api/local/document-libraries/${encodeURIComponent(createdLibrary.id)}`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "图片文件",
        logoDataUrl: null,
        matchType: "extension",
        domainContains: "",
        extensions: [".PNG", "png"],
        matchMode: "all",
        rules: [],
      }),
    },
  );
  assert.equal(extensionLibraryResponse.status, 200);
  assert.deepEqual((await extensionLibraryResponse.json()).library.extensions, ["png"]);
  const extensionPage = await fetch(
    `${baseUrl}/api/local/document-artifacts?libraryId=${encodeURIComponent(createdLibrary.id)}&limit=200`,
  ).then((response) => response.json());
  assert.deepEqual(extensionPage.items.map((item) => item.locator), [fixture.imagePath]);

  const updateLibraryResponse = await fetch(
    `${baseUrl}/api/local/document-libraries/${encodeURIComponent(createdLibrary.id)}`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "团队知识库",
        logoDataUrl: null,
        matchType: "rules",
        domainContains: "",
        extensions: [],
        matchMode: "all",
        rules: [{ field: "title", operator: "contains", value: "手册" }],
      }),
    },
  );
  assert.equal(updateLibraryResponse.status, 200);
  assert.equal((await updateLibraryResponse.json()).library.name, "团队知识库");

  const deleteLibraryResponse = await fetch(
    `${baseUrl}/api/local/document-libraries/${encodeURIComponent(createdLibrary.id)}`,
    {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: "{}",
    },
  );
  assert.equal(deleteLibraryResponse.status, 204);
  assert.ok(!app.documentArtifacts.listLibraries().some((library) => library.id === createdLibrary.id));

  const rootResponse = await fetch(`${baseUrl}/`);
  assert.equal(rootResponse.status, 200);
  assert.match(rootResponse.headers.get("content-security-policy"), /frame-ancestors 'self' app:\/\/-/u);
  assert.equal(rootResponse.headers.get("x-frame-options"), null);
  assert.match(await rootResponse.text(), /Document artifacts fixture/u);

  const badHost = await rawRequest({ port, path: "/health", headers: { Host: "attacker.example" } });
  assert.equal(badHost.status, 403);
  assert.equal(JSON.parse(badHost.body).error.code, "INVALID_HOST");

  const badOrigin = await rawRequest({
    port,
    path: "/health",
    headers: { Host: `127.0.0.1:${port}`, Origin: "https://attacker.example" },
  });
  assert.equal(badOrigin.status, 403);
  assert.equal(JSON.parse(badOrigin.body).error.code, "INVALID_ORIGIN");

  const embedOrigin = await rawRequest({
    port,
    path: "/health",
    headers: { Host: `127.0.0.1:${port}`, Origin: "app://-" },
  });
  assert.equal(embedOrigin.status, 200);

  const retiredTranslation = await fetch(`${baseUrl}/api/local/long-term-documents/anything/translate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(retiredTranslation.status, 404);
  assert.equal((await retiredTranslation.json()).error.code, "NOT_FOUND");

  const retiredCategory = await fetch(`${baseUrl}/api/local/document-artifacts?category=internal`);
  assert.equal(retiredCategory.status, 400);
});

test("HTTP 服务完全停止接收请求后才关闭文档索引", async (t) => {
  const fixture = await createCodexFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const app = createDocumentArtifactsServer({
    ...storeOptions(fixture),
    staticDirectory: fixture.staticDirectory,
  });
  await app.listen({ port: 0 });

  const lifecycle = [];
  const closeServer = app.server.close.bind(app.server);
  app.server.close = (callback) => closeServer((error) => {
    lifecycle.push("http-closed");
    callback(error);
  });
  const stopStore = app.documentArtifacts.stop.bind(app.documentArtifacts);
  app.documentArtifacts.stop = async () => {
    lifecycle.push("store-stopped");
    await stopStore();
  };

  await Promise.all([app.close(), app.close()]);
  assert.deepEqual(lifecycle, ["http-closed", "store-stopped"]);
});

test("Office 快照只有显式启用后才会创建", async (t) => {
  const fixture = await createCodexFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const store = new DocumentArtifactStore(storeOptions(fixture, { enableSnapshots: true }));
  t.after(() => store.stop());
  await store.scanNow();

  const office = store.list({ category: "office" }).items[0];
  assert.equal(office.versions[0].snapshotStatus, "available");
  assert.equal(office.versions[0].openable, true);
  const openTarget = store.resolveOpenTarget(office.id);
  assert.ok(openTarget.target);
  assert.notEqual(openTarget.target, fixture.officePath);
  assert.equal((await stat(openTarget.target)).mode & 0o777, 0o600);
});

test("公司专供版永久关闭长期文档，快照仍需显式开启", async (t) => {
  const fixture = await createCodexFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const names = [
    "DOCUMENT_ARTIFACTS_PORT",
    "DOCUMENT_ARTIFACTS_DATA_DIR",
    "DOCUMENT_ARTIFACTS_INCLUDE_LONG_TERM",
    "DOCUMENT_ARTIFACTS_ENABLE_SNAPSHOTS",
  ];
  const previous = new Map(names.map((name) => [name, process.env[name]]));
  t.after(() => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  process.env.DOCUMENT_ARTIFACTS_PORT = "48123";
  process.env.DOCUMENT_ARTIFACTS_DATA_DIR = path.join(fixture.root, "configured-data");
  process.env.DOCUMENT_ARTIFACTS_INCLUDE_LONG_TERM = "1";
  process.env.DOCUMENT_ARTIFACTS_ENABLE_SNAPSHOTS = "true";

  const resolved = resolveServerOptions({ codexHome: fixture.codexHome });
  assert.equal(resolvePort(), 48_123);
  assert.equal(resolved.dataDirectory, path.join(fixture.root, "configured-data"));
  assert.equal(resolved.includeLongTerm, false);
  assert.equal(resolved.enableSnapshots, true);

  const explicitlyDisabled = resolveServerOptions({
    codexHome: fixture.codexHome,
    includeLongTerm: false,
    enableSnapshots: false,
  });
  assert.equal(explicitlyDisabled.includeLongTerm, false);
  assert.equal(explicitlyDisabled.enableSnapshots, false);
});
