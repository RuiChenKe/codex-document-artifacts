#!/bin/zsh

set -e
cd "${0:A:h}"

if [[ ! -d node_modules || ! -d dist/web ]]; then
  echo "尚未安装。请先双击 install.command。"
  read "?按回车键关闭窗口…"
  exit 1
fi

CODEX_APP_RUNNING="$(/bin/ps -ax -o command= | /usr/bin/grep -E '^/Applications/ChatGPT\.app/Contents/MacOS/ChatGPT([[:space:]]|$)' || true)"
if [[ -n "$CODEX_APP_RUNNING" ]] && ! /usr/bin/curl --silent --fail --max-time 1 http://127.0.0.1:9232/json/version >/dev/null 2>&1; then
  echo "Codex 仍在运行，暂时无法加入侧边栏。"
  echo "请按 Command-Q 完全退出 Codex，再重新双击 start.command。"
  read "?按回车键关闭窗口…"
  exit 1
fi

echo "正在启动文档产物。使用期间请保持这个窗口打开。"
echo "需要停止时，在这里按 Control-C。"
set +e
npm run codex
documents_exit_code=$?
set -e

if [[ $documents_exit_code -ne 0 && $documents_exit_code -ne 130 && $documents_exit_code -ne 143 ]]; then
  echo "\n文档产物没有正常启动。请保留上面的提示，按 README 的常见问题处理，或到 GitHub Issues 求助。"
  read "?按回车键关闭窗口…"
fi
exit $documents_exit_code
