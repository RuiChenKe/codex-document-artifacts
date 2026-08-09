import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const injectionSource = await readFile(
  new URL("../inject/codex-documents.user.js", import.meta.url),
  "utf8",
);
const launcherSource = await readFile(
  new URL("../scripts/launcher.mjs", import.meta.url),
  "utf8",
);
const restoreSource = await readFile(
  new URL("../skills/restore-document-sidebar/scripts/restore.mjs", import.meta.url),
  "utf8",
);

test("the standalone injection exposes only the Document Artifacts entry", () => {
  assert.match(injectionSource, /const ENTRY_ID = "codex-documents-entry"/);
  assert.match(injectionSource, /label\.textContent = "文档产物"/);
  assert.match(injectionSource, /button\.setAttribute\("aria-label", "打开文档产物"\)/);
  assert.doesNotMatch(injectionSource, /taskboard/i);
  assert.doesNotMatch(injectionSource, /automation/i);
  assert.doesNotMatch(injectionSource, /artificial intelligence|\bAI\b/i);
});

test("the embedded page uses the fixed local URL and clipboard permission", () => {
  assert.match(injectionSource, /http:\/\/127\.0\.0\.1:47824\/\?host=codex/);
  assert.match(launcherSource, /http:\/\/127\.0\.0\.1:47824\/\?host=codex/);
  assert.match(injectionSource, /nextFrame\.setAttribute\("allow", "clipboard-write"\)/);
  assert.match(injectionSource, /nextFrame\.referrerPolicy = "no-referrer"/);
  assert.match(injectionSource, /url\.hostname !== "127\.0\.0\.1"/);
});

test("the page fills the Codex main area and restores native navigation", () => {
  assert.match(injectionSource, /#\$\{PAGE_ID\} \{[\s\S]*?position: absolute;[\s\S]*?inset: 0;/);
  assert.match(injectionSource, /document\.querySelector\("\.app-shell-main-content-frame"\)/);
  assert.match(injectionSource, /surface\.appendChild\(page\)/);
  assert.match(injectionSource, /function restoreNativeContent/);
  assert.match(injectionSource, /if \(active && isNativePageNavigation\(event\.target\)\) closeDocuments\(false\)/);
  assert.match(injectionSource, /window\.addEventListener\("popstate", onNativeRouteChange\)/);
  assert.match(injectionSource, /window\.addEventListener\("hashchange", onNativeRouteChange\)/);
});

test("the iframe contract handles readiness, drag, thread opening, and sidebar expansion", () => {
  for (const message of [
    "documents:ready",
    "documents:drag-region",
    "documents:open-thread",
    "documents:expand-sidebar",
  ]) {
    assert.match(injectionSource, new RegExp(message.replace(":", "\\:")));
  }
  assert.match(
    injectionSource,
    /event\.source !== frame\.contentWindow \|\| event\.origin !== frameOrigin/,
  );
  assert.match(injectionSource, /row\.click\(\)/);
  assert.match(injectionSource, /trigger\.click\(\)/);
});

test("theme and macOS sidebar inset are synchronized to the iframe", () => {
  assert.match(injectionSource, /function currentTheme\(\)/);
  assert.match(injectionSource, /const MACOS_TITLEBAR_SAFE_LEFT = 80/);
  assert.match(injectionSource, /sidebarCollapsed: nativeSidebarCollapsed\(\)/);
  assert.match(injectionSource, /titlebarLeftInset: titlebarLeftInset\(\)/);
  assert.match(injectionSource, /type: "documents:host-context"/);
  assert.match(injectionSource, /type: "documents:theme"/);
});

test("the launcher supervises the server and uses CDP port 9232", () => {
  assert.match(launcherSource, /const DEFAULT_CDP_PORT = 9232/);
  assert.match(launcherSource, /process\.env\.DOCUMENT_ARTIFACTS_PORT/);
  assert.match(launcherSource, /serverPath, "--port", String\(documentsPort\)/);
  assert.match(launcherSource, /path\.join\(projectRoot, "server", "index\.mjs"\)/);
  assert.match(launcherSource, /function createServiceSupervisor\(\)/);
  assert.match(launcherSource, /await supervisor\.ensure\(\)/);
  assert.match(launcherSource, /payload\?\.service === "codex-document-artifacts"/);
  assert.match(launcherSource, /isLocalPortOpen\(documentsPort\)/);
  assert.match(launcherSource, /--remote-debugging-port=\$\{port\}/);
  assert.match(launcherSource, /--remote-debugging-address=127\.0\.0\.1/);
  assert.match(launcherSource, /Page\.addScriptToEvaluateOnNewDocument/);
  assert.match(launcherSource, /Runtime\.evaluate/);
  assert.match(launcherSource, /async function injectNewTargets/);
  assert.match(launcherSource, /targetUrl\.hostname === "-"/);
  assert.match(launcherSource, /targetUrl\.pathname === "\/index\.html"/);
  assert.match(launcherSource, /Page\.reload/);
  assert.ok(
    launcherSource.indexOf('Page.setBypassCSP", { enabled: true }')
      < launcherSource.indexOf('cdp.send("Page.reload")'),
  );
  assert.match(launcherSource, /state\.entrySelected/);
  assert.match(launcherSource, /state\.frameVisible/);
  assert.match(launcherSource, /state\.statusHidden/);
  assert.match(launcherSource, /ChatGPT\\\.app\\\/Contents\\\/MacOS\\\/ChatGPT/);
  assert.match(launcherSource, /launchedProcess\.kill\("SIGTERM"\)/);
  assert.match(launcherSource, /async function cleanupTarget\(cdp\)/);
  assert.match(launcherSource, /cdp\.injectionIdentifier = registration\.identifier/);
  assert.match(launcherSource, /cdp\.injectionIdentifier \|\| await evaluate/);
  assert.match(launcherSource, /__codexDocumentsInjection__\?\.destroy/);
  assert.match(launcherSource, /Page\.setBypassCSP", \{ enabled: false \}/);
  assert.doesNotMatch(launcherSource, /taskboard/i);
  assert.doesNotMatch(launcherSource, /automation/i);
});

test("the recovery skill verifies the exact main renderer and real iframe readiness", () => {
  assert.match(restoreSource, /url\.hostname === "-"/);
  assert.match(restoreSource, /url\.pathname === "\/index\.html"/);
  assert.match(restoreSource, /frameVisible/);
  assert.match(restoreSource, /statusHidden/);
  assert.match(restoreSource, /entrySelected/);
});

test("runtime paths are repository-relative rather than user-specific", () => {
  assert.match(launcherSource, /fileURLToPath\(import\.meta\.url\)/);
  assert.match(launcherSource, /const projectRoot = path\.resolve/);
  assert.doesNotMatch(injectionSource, /\/Users\//);
  assert.doesNotMatch(launcherSource, /\/Users\//);
});
