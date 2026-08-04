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
