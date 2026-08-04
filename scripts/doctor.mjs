#!/usr/bin/env node

import { existsSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const port = Number(process.env.DOCUMENT_ARTIFACTS_PORT || 47824);
const checks = [];

function record(ok, label, detail) {
  checks.push({ ok, label, detail });
}

const [major, minor] = process.versions.node.split(".").map(Number);
record(major > 22 || (major === 22 && minor >= 5), "Node.js 版本", `当前 ${process.versions.node}，需要 22.5 或更高`);
record(process.platform === "darwin", "macOS", process.platform === "darwin" ? "可使用 Codex 侧边栏嵌入" : "可使用网页模式；侧边栏嵌入目前仅支持 macOS");
record(existsSync(path.join(codexHome, "state_5.sqlite")), "Codex 任务索引", path.join(codexHome, "state_5.sqlite"));
record(existsSync(path.join(codexHome, ".codex-global-state.json")), "Codex 项目状态", path.join(codexHome, ".codex-global-state.json"));
record(existsSync("/Applications/ChatGPT.app"), "Codex 桌面版", "/Applications/ChatGPT.app");

const portFree = await new Promise((resolve) => {
  const server = net.createServer();
  server.once("error", (error) => resolve(error?.code === "EADDRINUSE" ? false : null));
  server.once("listening", () => server.close(() => resolve(true)));
  server.listen(port, "127.0.0.1");
});
record(portFree !== null, `本机端口 ${port}`, portFree ? "可用" : "已有服务占用；若文档产物已经启动，这是正常的");

for (const check of checks) {
  const mark = check.ok ? "✓" : "✗";
  console.log(`${mark} ${check.label}：${check.detail}`);
}

const requiredFailures = checks.slice(0, 3).filter((check) => !check.ok);
if (requiredFailures.length > 0) {
  console.error("\n有必需条件未满足，请按 README 的“遇到问题怎么办”处理。");
  process.exitCode = 1;
} else {
  console.log("\n基础环境已就绪。");
}
