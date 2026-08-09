#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createConnection } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const launcherPath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(launcherPath), "..");
const serverPath = path.join(projectRoot, "server", "index.mjs");
const injectionPath = path.join(projectRoot, "inject", "codex-documents.user.js");
const DEFAULT_CDP_PORT = 9232;
const DEFAULT_DOCUMENTS_PORT = 47_824;
const DEFAULT_DOCUMENTS_URL = "http://127.0.0.1:47824/?host=codex";
const SOURCE_HASH_KEY = "__CODEX_DOCUMENTS_SOURCE_HASH__";
const SCRIPT_IDENTIFIER_KEY = "__CODEX_DOCUMENTS_SCRIPT_IDENTIFIER__";

function resolveDocumentsPort() {
  const configured = process.env.DOCUMENT_ARTIFACTS_PORT
    || process.env.CODEX_DOCUMENT_ARTIFACTS_PORT
    || process.env.CODEX_DOCUMENTS_PORT
    || String(DEFAULT_DOCUMENTS_PORT);
  const port = Number(configured);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("DOCUMENT_ARTIFACTS_PORT must be an integer between 1 and 65535");
  }
  return port;
}

const documentsPort = resolveDocumentsPort();
const documentsOrigin = `http://127.0.0.1:${documentsPort}`;
const DOCUMENTS_URL = documentsPort === DEFAULT_DOCUMENTS_PORT
  ? DEFAULT_DOCUMENTS_URL
  : `${documentsOrigin}/?host=codex`;
const DOCUMENTS_HEALTH_URL = `${documentsOrigin}/health`;

function parseArgs(argv) {
  const options = {
    port: DEFAULT_CDP_PORT,
    launch: true,
    open: false,
    app: process.env.CODEX_APP_NAME || "ChatGPT",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--open") options.open = true;
    else if (argument === "--no-launch") options.launch = false;
    else if (argument === "--port") {
      const value = argv[++index];
      if (!value) throw new Error("--port requires a value");
      options.port = Number(value);
    } else if (argument === "--app-path") {
      const value = argv[++index];
      if (!value) throw new Error("--app-path requires a value");
      options.app = path.resolve(value);
    }
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`Unknown option: ${argument}`);
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65_535) {
    throw new Error("--port must be an integer between 1 and 65535");
  }
  return options;
}

function printHelp() {
  console.log(`Codex Document Artifacts launcher

Usage: node scripts/launcher.mjs [options]

Options:
  --open             Open Document Artifacts after injection
  --no-launch        Attach only; do not start ChatGPT.app
  --port <number>    CDP port (default: ${DEFAULT_CDP_PORT})
  --app-path <path>  Override the ChatGPT application
  -h, --help         Show this help`);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function isReachable(url, timeoutMs = 1_500) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return response.ok;
  } catch (_) {
    return false;
  }
}

async function isDocumentServiceHealthy(timeoutMs = 1_500) {
  try {
    const response = await fetch(DOCUMENTS_HEALTH_URL, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return false;
    const payload = await response.json();
    return payload?.ok === true && payload?.service === "codex-document-artifacts";
  } catch (_) {
    return false;
  }
}

async function isLocalPortOpen(port, timeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(timeoutMs, () => finish(false));
  });
}

async function waitUntilReachable(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isReachable(url)) return;
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function waitUntilDocumentServiceHealthy(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isDocumentServiceHealthy()) return;
    await delay(250);
  }
  throw new Error(`等待文档产物本机服务超时：${DOCUMENTS_HEALTH_URL}`);
}

function createServiceSupervisor() {
  let child = null;
  let starting = null;
  let stopping = false;
  let retryAfter = 0;

  async function ensure() {
    if (await isDocumentServiceHealthy()) return { restarted: false };
    if (starting) return starting;
    if (Date.now() < retryAfter) throw new Error("The document service is waiting to restart");

    starting = (async () => {
      if (child?.exitCode === null && !child.killed) {
        try {
          await waitUntilDocumentServiceHealthy(3_000);
          return { restarted: false };
        } catch (error) {
          if (child?.exitCode === null && !child.killed) throw error;
        }
      }

      if (await isLocalPortOpen(documentsPort)) {
        throw new Error(
          `本机端口 ${documentsPort} 已被其他程序占用。请关闭占用该端口的程序，或设置 DOCUMENT_ARTIFACTS_PORT 后重试。`,
        );
      }

      const started = spawn(process.execPath, [serverPath, "--port", String(documentsPort)], {
        cwd: projectRoot,
        stdio: "inherit",
      });
      child = started;
      started.once("error", (error) => {
        if (!stopping) console.error(`Document service error: ${error.message}`);
      });
      started.once("exit", (code, signal) => {
        if (child === started) child = null;
        if (!stopping && code !== 0) {
          console.error(`Document service stopped (${signal || code}); it will be restarted.`);
        }
      });

      try {
        await waitUntilDocumentServiceHealthy(15_000);
        retryAfter = 0;
        return { restarted: true };
      } catch (error) {
        retryAfter = Date.now() + 2_000;
        throw error;
      }
    })();

    try {
      return await starting;
    } finally {
      starting = null;
    }
  }

  function stop() {
    stopping = true;
    if (child?.exitCode === null && !child.killed) child.kill("SIGTERM");
  }

  return { ensure, stop };
}

function chatGptIsRunning() {
  if (process.platform !== "darwin") return false;
  const processList = spawnSync("/bin/ps", ["-ax", "-o", "command="], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return /^\/Applications\/ChatGPT\.app\/Contents\/MacOS\/ChatGPT(?:\s|$)/m.test(
    processList.stdout || "",
  );
}

function launchChatGpt(application, port) {
  if (process.platform !== "darwin") {
    throw new Error("Automatic ChatGPT launch is currently available on macOS only; use --no-launch to attach.");
  }
  return spawn(
    "/usr/bin/open",
    [
      "-W",
      "-a",
      application,
      "--args",
      `--remote-debugging-port=${port}`,
      "--remote-debugging-address=127.0.0.1",
      `--remote-allow-origins=http://127.0.0.1:${port}`,
    ],
    { stdio: "ignore" },
  );
}

class CdpConnection {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.sequence = 0;
    this.pending = new Map();
    this.handlers = new Map();
    this.closed = false;
    this.injectionIdentifier = null;
  }

  async open() {
    await new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener(
        "error",
        () => reject(new Error("CDP WebSocket connection failed")),
        { once: true },
      );
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (!message.id) {
        for (const handler of this.handlers.get(message.method) || []) {
          try {
            Promise.resolve(handler(message.params)).catch(() => {});
          } catch (_) {}
        }
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
    this.socket.addEventListener("close", () => {
      this.closed = true;
      const error = new Error("CDP WebSocket closed");
      this.pending.forEach(({ reject }) => reject(error));
      this.pending.clear();
      this.handlers.clear();
    });
  }

  send(method, params = {}) {
    if (this.closed) return Promise.reject(new Error("CDP WebSocket is closed"));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, handler) {
    const handlers = this.handlers.get(method) || [];
    handlers.push(handler);
    this.handlers.set(method, handlers);
    return () => {
      const current = this.handlers.get(method) || [];
      const next = current.filter((candidate) => candidate !== handler);
      if (next.length > 0) this.handlers.set(method, next);
      else this.handlers.delete(method);
    };
  }

  waitFor(method, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        unsubscribe();
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeoutMs);
      const unsubscribe = this.on(method, (params) => {
        clearTimeout(timer);
        unsubscribe();
        resolve(params);
      });
    });
  }

  close() {
    if (!this.closed) this.socket.close();
  }
}

async function fetchJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
}

async function codexTargets(port) {
  const targets = await fetchJson(`http://127.0.0.1:${port}/json/list`);
  return targets.filter((target) => {
    if (target.type !== "page" || !target.webSocketDebuggerUrl) return false;
    try {
      const targetUrl = new URL(target.url);
      return targetUrl.protocol === "app:"
        && targetUrl.hostname === "-"
        && targetUrl.pathname === "/index.html"
        && !targetUrl.searchParams.has("initialRoute");
    } catch {
      return false;
    }
  });
}

async function waitForCodexTargets(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const targets = await codexTargets(port);
      if (targets.length > 0) return targets;
    } catch (_) {}
    await delay(250);
  }
  throw new Error("No Codex renderer appeared before the startup timeout");
}

async function currentInjectionSource() {
  const userScript = await readFile(injectionPath, "utf8");
  const configuredSource = `
window.__CODEX_DOCUMENTS_URL__ = ${JSON.stringify(DOCUMENTS_URL)};
${userScript}`;
  const sourceHash = createHash("sha256").update(configuredSource).digest("hex");
  return {
    sourceHash,
    source: `window[${JSON.stringify(SOURCE_HASH_KEY)}] = ${JSON.stringify(sourceHash)};\n${configuredSource}`,
  };
}

async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || "Document injection failed");
  }
  return result.result?.value;
}

async function publishScriptIdentifier(cdp, identifier) {
  await evaluate(
    cdp,
    `window[${JSON.stringify(SCRIPT_IDENTIFIER_KEY)}] = ${JSON.stringify(identifier)}`,
  );
}

async function waitForInjection(cdp, sourceHash, shouldOpen, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let state = null;
  while (Date.now() < deadline) {
    state = await evaluate(cdp, `({
      sourceHash: window.__codexDocumentsInjection__?.sourceHash || null,
      entryMounted: Boolean(document.getElementById("codex-documents-entry")),
      entrySelected: document.getElementById("codex-documents-entry")?.getAttribute("aria-current") === "page",
      pageVisible: document.getElementById("codex-documents-page")?.hidden === false,
      frameUrl: document.getElementById("codex-documents-frame")?.src || null,
      frameVisible: document.getElementById("codex-documents-frame")?.hidden === false,
      statusHidden: document.getElementById("codex-documents-status")?.hidden === true
    })`);
    if (
      state?.sourceHash === sourceHash
      && state.entryMounted
      && (!shouldOpen || (
        state.entrySelected
        && state.pageVisible
        && state.frameUrl
        && state.frameVisible
        && state.statusHidden
      ))
    ) return state;
    await delay(200);
  }
  return state;
}

async function injectTarget(target, source, sourceHash, shouldOpen) {
  const cdp = new CdpConnection(target.webSocketDebuggerUrl);
  await cdp.open();
  try {
    await Promise.all([
      cdp.send("Page.enable"),
      cdp.send("Runtime.enable"),
    ]);
    await cdp.send("Page.setBypassCSP", { enabled: true });

    const previousIdentifier = await evaluate(
      cdp,
      `window[${JSON.stringify(SCRIPT_IDENTIFIER_KEY)}] || null`,
    );
    if (previousIdentifier) {
      try {
        await cdp.send("Page.removeScriptToEvaluateOnNewDocument", {
          identifier: previousIdentifier,
        });
      } catch (_) {}
    }

    const registration = await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `${source}\n//# sourceURL=codex-documents.user.js`,
    });
    cdp.injectionIdentifier = registration.identifier;
    cdp.on("Page.loadEventFired", () => publishScriptIdentifier(cdp, registration.identifier));

    // CSP is initialized during navigation. Reload once after enabling the CDP
    // bypass so current ChatGPT builds can embed the local document service.
    const pageLoaded = cdp.waitFor("Page.loadEventFired", 15_000);
    await cdp.send("Page.reload");
    await pageLoaded;
    await evaluate(cdp, source);
    await publishScriptIdentifier(cdp, registration.identifier);
    if (shouldOpen) await evaluate(cdp, "window.__codexDocumentsInjection__?.open()");
    const state = await waitForInjection(cdp, sourceHash, shouldOpen, 15_000);
    if (!state?.entryMounted) throw new Error("The Document Artifacts sidebar entry did not mount");
    if (shouldOpen && !(state?.frameVisible && state?.statusHidden && state?.entrySelected)) {
      throw new Error("The Document Artifacts page did not finish loading");
    }
    return { cdp, state };
  } catch (error) {
    await cleanupTarget(cdp);
    cdp.close();
    throw error;
  }
}

async function injectNewTargets(port, source, sourceHash, connections, openFirst) {
  const targets = await codexTargets(port);
  const activeIds = new Set(targets.map((target) => target.id));
  for (const [targetId, cdp] of connections) {
    if (!activeIds.has(targetId) || cdp.closed) {
      cdp.close();
      connections.delete(targetId);
    }
  }

  const injected = [];
  for (const target of targets) {
    if (connections.has(target.id)) continue;
    try {
      const { cdp, state } = await injectTarget(
        target,
        source,
        sourceHash,
        openFirst && connections.size === 0 && injected.length === 0,
      );
      connections.set(target.id, cdp);
      injected.push({ id: target.id, title: target.title, ...state });
    } catch (error) {
      console.error(`Could not inject renderer ${target.id}: ${error.message}`);
    }
  }
  return injected;
}

async function cleanupTarget(cdp) {
  try {
    const identifier = cdp.injectionIdentifier || await evaluate(
      cdp,
      `window[${JSON.stringify(SCRIPT_IDENTIFIER_KEY)}] || null`,
    );
    if (identifier) {
      await cdp.send("Page.removeScriptToEvaluateOnNewDocument", { identifier });
      cdp.injectionIdentifier = null;
    }
  } catch (_) {}
  try {
    await evaluate(cdp, "window.__codexDocumentsInjection__?.destroy?.()");
  } catch (_) {}
  try {
    await cdp.send("Page.setBypassCSP", { enabled: false });
  } catch (_) {}
}

async function main() {
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (nodeMajor < 22) throw new Error("Node.js 22 or newer is required");

  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const cdpVersionUrl = `http://127.0.0.1:${options.port}/json/version`;
  const supervisor = createServiceSupervisor();
  const connections = new Map();
  let launchedProcess = null;
  let stopping = false;
  let lastServiceError = "";
  let lastCdpError = "";

  const stop = () => {
    stopping = true;
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  process.once("SIGHUP", stop);

  try {
    await supervisor.ensure();
    if (!(await isReachable(cdpVersionUrl))) {
      if (!options.launch) {
        throw new Error(`Codex CDP is not listening on 127.0.0.1:${options.port}`);
      }
      if (chatGptIsRunning()) {
        throw new Error(
          "Codex 已经在运行，但没有开启文档产物需要的本机调试端口。请按 Command-Q 完全退出 Codex，再重新启动文档产物。",
        );
      }
      launchedProcess = launchChatGpt(options.app, options.port);
      await waitUntilReachable(cdpVersionUrl, 30_000);
    }

    await waitForCodexTargets(options.port, 30_000);
    const { source, sourceHash } = await currentInjectionSource();
    const first = await injectNewTargets(
      options.port,
      source,
      sourceHash,
      connections,
      options.open,
    );
    if (first.length === 0) throw new Error("No Codex renderer could be injected");
    console.log(`Document Artifacts is ready in ${first.length} Codex window(s).`);

    while (!stopping) {
      await delay(1_000);
      if (stopping) break;
      try {
        await supervisor.ensure();
        lastServiceError = "";
      } catch (error) {
        if (error.message !== lastServiceError) {
          console.error(`Waiting for the document service: ${error.message}`);
          lastServiceError = error.message;
        }
      }

      if (stopping) break;
      try {
        const injected = await injectNewTargets(
          options.port,
          source,
          sourceHash,
          connections,
          false,
        );
        if (injected.length > 0) {
          console.log(`Document Artifacts was added to ${injected.length} new Codex window(s).`);
        }
        lastCdpError = "";
      } catch (error) {
        if (error.message !== lastCdpError) {
          console.error(`Waiting for Codex: ${error.message}`);
          lastCdpError = error.message;
        }
      }

      if (launchedProcess && launchedProcess.exitCode !== null && !(await isReachable(cdpVersionUrl))) {
        launchedProcess = null;
      }
    }
  } finally {
    await Promise.allSettled([...connections.values()].map((cdp) => cleanupTarget(cdp)));
    connections.forEach((cdp) => cdp.close());
    if (launchedProcess?.exitCode === null && !launchedProcess.killed) {
      launchedProcess.kill("SIGTERM");
    }
    supervisor.stop();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
