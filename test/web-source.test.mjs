import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("document cards expose a clear copy-link action", async () => {
  const source = await readFile(path.join(root, "web/src/DocumentArtifactsApp.tsx"), "utf8");
  assert.match(source, /navigator\.clipboard\.writeText\(artifact\.locator\)/);
  assert.match(source, /复制链接🔗/u);
  assert.match(source, /已复制 ✓/u);
});

test("the standalone UI scans all retained history and uses its own host protocol", async () => {
  const source = await readFile(path.join(root, "web/src/DocumentArtifactsApp.tsx"), "utf8");
  assert.match(source, /扫描本机保留的全部 Codex 历史最终交付/u);
  assert.match(source, /documents:ready/);
  assert.doesNotMatch(source, /taskboard:/);
  assert.doesNotMatch(source, /internal-only|private-company\.example/u);
});

test("read-only API calls retry transient restart responses", async () => {
  const source = await readFile(path.join(root, "web/src/documentArtifactsApi.ts"), "utf8");
  assert.match(source, /TRANSIENT_HTTP_STATUS_CODES = new Set\(\[500, 502, 503, 504\]\)/);
  assert.match(source, /TRANSIENT_HTTP_STATUS_CODES\.has\(response\.status\)/);
});

test("custom document libraries expose edit and delete controls", async () => {
  const appSource = await readFile(path.join(root, "web/src/DocumentArtifactsApp.tsx"), "utf8");
  const dialogSource = await readFile(path.join(root, "web/src/components/CustomDocumentLibraryDialog.tsx"), "utf8");
  const apiSource = await readFile(path.join(root, "web/src/documentArtifactsApi.ts"), "utf8");
  assert.match(appSource, /编辑模块与规则/u);
  assert.match(appSource, /删除模块/u);
  assert.match(dialogSource, /编辑自定义文档库/u);
  assert.match(dialogSource, /按文件格式/u);
  assert.match(dialogSource, /extensionsText/u);
  assert.match(apiSource, /method: "PUT"/u);
  assert.match(apiSource, /method: "DELETE"/u);
});

test("the Bilibili edition includes company platforms and removes the long-term module", async () => {
  const appSource = await readFile(path.join(root, "web/src/DocumentArtifactsApp.tsx"), "utf8");
  const apiSource = await readFile(path.join(root, "web/src/documentArtifactsApi.ts"), "utf8");
  const serverSource = await readFile(path.join(root, "server/app.mjs"), "utf8");
  const cliSource = await readFile(path.join(root, "server/index.mjs"), "utf8");
  assert.match(appSource, /id: "zhiliao", name: "知了文档"/u);
  assert.doesNotMatch(appSource, /long_term|getLongTermMarkdownDocument|openLongTermDocument/u);
  assert.doesNotMatch(apiSource, /long-term-documents|long_term/u);
  assert.doesNotMatch(serverSource, /api\/local\/long-term-documents/u);
  assert.doesNotMatch(cliSource, /include-long-term/u);
});
