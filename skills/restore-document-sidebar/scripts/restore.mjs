#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { access, mkdir, open, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const skillDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configuredProjectRoot = await readFile(path.join(skillDirectory, "project-root.txt"), "utf8")
  .then((value) => value.trim())
  .catch(() => "");
const projectRoot = process.env.DOCUMENT_ARTIFACTS_DIR
  ? path.resolve(process.env.DOCUMENT_ARTIFACTS_DIR)
  : configuredProjectRoot
    ? path.resolve(configuredProjectRoot)
    : path.resolve(skillDirectory, "../..");
const launcherPath = path.join(projectRoot, "scripts", "launcher.mjs");
const dataDirectory = path.join(projectRoot, ".data");
const outputDirectory = path.join(projectRoot, "output");
const pidPath = path.join(dataDirectory, "restore-document-sidebar.pid");
const logPath = path.join(outputDirectory, "restore-document-sidebar.log");
const portArgument = process.argv.indexOf("--port");
const port = Number(portArgument >= 0 ? process.argv[portArgument + 1] : 9232);
const documentsPort = Number(process.env.DOCUMENT_ARTIFACTS_PORT || 47_824);
const cdpOrigin = `http://127.0.0.1:${port}`;
const healthUrl = `http://127.0.0.1:${documentsPort}/health`;

if (!Number.isInteger(port) || port < 1024 || port > 65_535) throw new Error("Invalid --port");
if (!Number.isInteger(documentsPort) || documentsPort < 1 || documentsPort > 65_535) {
  throw new Error("Invalid DOCUMENT_ARTIFACTS_PORT");
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function reachable(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitFor(check, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) return result;
    } catch {}
    await delay(250);
  }
  throw new Error(message);
}

async function mainTarget() {
  const response = await fetch(`${cdpOrigin}/json/list`, { signal: AbortSignal.timeout(1_000) });
  const targets = await response.json();
  return targets.find((target) => {
    if (target.type !== "page" || !target.webSocketDebuggerUrl) return false;
    try {
      const url = new URL(target.url);
      return url.protocol === "app:"
        && url.hostname === "-"
        && url.pathname === "/index.html"
        && !url.searchParams.has("initialRoute");
    } catch {
      return false;
    }
  });
}

async function evaluate(target, expression) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  try {
    const id = 1;
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("CDP evaluation timed out")), 5_000);
      socket.addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data));
        if (message.id !== id) return;
        clearTimeout(timer);
        if (message.error || message.result?.exceptionDetails) reject(new Error("CDP evaluation failed"));
        else resolve(message.result?.result?.value);
      });
    });
    socket.send(JSON.stringify({
      id,
      method: "Runtime.evaluate",
      params: { expression, awaitPromise: true, returnByValue: true },
    }));
    return await response;
  } finally {
    socket.close();
  }
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function currentResidentPid() {
  try {
    const pid = Number((await readFile(pidPath, "utf8")).trim());
    return processIsAlive(pid) ? pid : null;
  } catch {
    return null;
  }
}

async function ensureCdpWindow() {
  let launchedDedicatedWindow = false;
  if (process.platform !== "darwin") {
    throw new Error("Codex sidebar recovery currently requires macOS");
  }
  const appPath = "/Applications/ChatGPT.app";
  await access(appPath);
  const deadline = Date.now() + 90_000;
  let launchAttempts = 0;
  let lastLaunchAt = 0;
  while (Date.now() < deadline) {
    if (!(await reachable(`${cdpOrigin}/json/version`))) {
      if (launchAttempts >= 3) break;
      const sinceLastLaunch = Date.now() - lastLaunchAt;
      if (sinceLastLaunch < 2_000) await delay(2_000 - sinceLastLaunch);
      launchAttempts += 1;
      lastLaunchAt = Date.now();
      const launched = spawnSync("/usr/bin/open", [
        "-n", "-a", appPath, "--args",
        `--remote-debugging-port=${port}`,
        "--remote-debugging-address=127.0.0.1",
        `--remote-allow-origins=${cdpOrigin}`,
      ], { encoding: "utf8" });
      if (launched.status !== 0) throw new Error(launched.stderr || "Could not open Codex");
      launchedDedicatedWindow = true;
      await delay(1_000);
      continue;
    }
    try {
      const target = await mainTarget();
      if (
        target
        && await evaluate(target, `Boolean(document.querySelector("[data-app-action-sidebar-scroll]"))`)
      ) return launchedDedicatedWindow;
    } catch {}
    await delay(500);
  }
  if (!(await reachable(`${cdpOrigin}/json/version`))) {
    throw new Error("Codex recovery window did not expose a stable local debug port");
  }
  throw new Error("Codex recovery window did not finish loading its sidebar");
}

async function startResident() {
  const existing = await currentResidentPid();
  if (existing) return existing;
  await mkdir(dataDirectory, { recursive: true });
  await mkdir(outputDirectory, { recursive: true });
  const log = await open(logPath, "a", 0o600);
  const child = spawn(process.execPath, [launcherPath, "--no-launch", "--open", "--port", String(port)], {
    cwd: projectRoot,
    detached: true,
    env: { ...process.env, DOCUMENT_ARTIFACTS_PORT: String(documentsPort) },
    stdio: ["ignore", log.fd, log.fd],
  });
  child.unref();
  await writeFile(pidPath, `${child.pid}\n`, { mode: 0o600 });
  await log.close();
  return child.pid;
}

await access(launcherPath);
const launchedDedicatedWindow = await ensureCdpWindow();
const residentPid = await startResident();

const restored = await waitFor(async () => {
  if (!(await reachable(healthUrl))) return null;
  const target = await mainTarget();
  if (!target) return null;
  const state = await evaluate(target, `({
    documentsEntry: Boolean(document.getElementById("codex-documents-entry")),
    frameUrl: document.getElementById("codex-documents-frame")?.src || null,
    frameVisible: document.getElementById("codex-documents-frame")?.hidden === false,
    statusHidden: document.getElementById("codex-documents-status")?.hidden === true,
    entrySelected: document.getElementById("codex-documents-entry")?.getAttribute("aria-current") === "page"
  })`);
  if (!state?.documentsEntry) return null;
  await evaluate(target, `document.getElementById("codex-documents-entry")?.click()`);
  if (!(state.frameVisible && state.statusHidden && state.entrySelected)) return null;
  return state.frameUrl ? { target, frameUrl: state.frameUrl } : null;
}, 45_000, "Document sidebar recovery did not become healthy").catch(async (error) => {
  const log = await readFile(logPath, "utf8").catch(() => "");
  const tail = log.trim().split("\n").slice(-8).join("\n");
  throw new Error(`${error.message}${tail ? `\n${tail}` : ""}`);
});

const result = {
  ok: true,
  launchedDedicatedWindow,
  serviceHealthy: await reachable(healthUrl),
  documentsEntry: true,
  documentsClickLoaded: new URL(restored.frameUrl).origin === `http://127.0.0.1:${documentsPort}`,
  residentPid,
  logPath,
};
console.log(JSON.stringify(result, null, 2));
if (!result.serviceHealthy || !result.documentsClickLoaded) process.exitCode = 1;
