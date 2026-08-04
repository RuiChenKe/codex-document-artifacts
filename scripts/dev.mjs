#!/usr/bin/env node

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const children = [
  spawn(process.execPath, ["--watch", "server/index.mjs", "--dev"], { cwd: root, stdio: "inherit" }),
  spawn(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "dev:web"], { cwd: root, stdio: "inherit" }),
];

let closing = false;
function close(signal = "SIGTERM") {
  if (closing) return;
  closing = true;
  for (const child of children) {
    if (child.exitCode === null && !child.killed) child.kill(signal);
  }
}

for (const child of children) {
  child.once("exit", (code) => {
    if (!closing && code !== 0) process.exitCode = code || 1;
    close();
  });
}
process.once("SIGINT", () => close("SIGINT"));
process.once("SIGTERM", () => close("SIGTERM"));
