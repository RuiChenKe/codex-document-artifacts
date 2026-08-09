#!/usr/bin/env node

import path from "node:path";
import { pathToFileURL } from "node:url";

import { createDocumentArtifactsServer, resolvePort } from "./app.mjs";

function usage() {
  return [
    "Codex 文档产物",
    "",
    "用法：node server/index.mjs [选项]",
    "",
    "选项：",
    "  --port <端口>           本机端口（默认 47824）",
    "  --codex-home <目录>     Codex 数据目录（默认 ~/.codex）",
    "  --data-dir <目录>       本模块的数据目录",
    "  --enable-snapshots      保存 Office 文件快照（默认关闭）",
    "  --dev                   开发模式（由 npm run dev 使用）",
    "  -h, --help              显示帮助",
  ].join("\n");
}

function parseArguments(argv) {
  const result = {
    port: resolvePort(),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "-h" || argument === "--help") {
      result.help = true;
      continue;
    }
    if (argument === "--enable-snapshots") {
      result.enableSnapshots = true;
      continue;
    }
    if (argument === "--dev") {
      result.dev = true;
      continue;
    }
    if (argument === "--port" || argument === "--codex-home" || argument === "--data-dir") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${argument} 缺少参数`);
      index += 1;
      if (argument === "--port") result.port = resolvePort(value);
      if (argument === "--codex-home") result.codexHome = path.resolve(value);
      if (argument === "--data-dir") result.dataDirectory = path.resolve(value);
      continue;
    }
    throw new Error(`未知参数：${argument}`);
  }
  return result;
}

export async function main(argv = process.argv.slice(2)) {
  const parsed = parseArguments(argv);
  if (parsed.help) {
    process.stdout.write(`${usage()}\n`);
    return null;
  }
  const app = createDocumentArtifactsServer(parsed);
  const address = await app.listen({ host: "127.0.0.1", port: parsed.port });
  const port = typeof address === "object" && address ? address.port : parsed.port;
  process.stdout.write(`Codex 文档产物已启动：http://127.0.0.1:${port}\n`);

  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await app.close();
  };
  process.once("SIGINT", () => void close().then(() => process.exit(0)));
  process.once("SIGTERM", () => void close().then(() => process.exit(0)));
  return app;
}

const entrypoint = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (entrypoint === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`启动失败：${error.message}\n`);
    process.exitCode = 1;
  });
}
