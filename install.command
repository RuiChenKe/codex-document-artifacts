#!/bin/zsh

set -e
cd "${0:A:h}"

echo "文档产物安装向导"
echo "================"

installation_failed() {
  echo "\n安装没有完成。请保留上面的提示，按 README 的常见问题处理，或到 GitHub Issues 求助。"
  read "?按回车键关闭窗口…"
  exit 1
}

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "没有找到 Node.js。浏览器将打开官方下载页，请安装 LTS 版本后重新双击本文件。"
  open "https://nodejs.org/zh-cn/download"
  read "?按回车键关闭窗口…"
  exit 1
fi

node -e 'const [a,b]=process.versions.node.split(".").map(Number); if(a<22 || (a===22 && b<5)){console.error(`Node.js ${process.versions.node} 太旧，需要 22.5 或更高。`);process.exit(1)}' || installation_failed

echo "\n1/3 安装所需组件…"
npm ci || installation_failed

echo "\n2/3 生成可运行页面…"
npm run build || installation_failed

echo "\n3/3 检查本机 Codex 环境…"
npm run doctor || true

codex_skills_dir="${CODEX_HOME:-${HOME}/.codex}/skills"
document_skill_dir="${codex_skills_dir}/restore-document-sidebar"
/bin/mkdir -p "${document_skill_dir}"
/usr/bin/ditto "skills/restore-document-sidebar" "${document_skill_dir}"
/usr/bin/printf '%s\n' "${PWD}" > "${document_skill_dir}/project-root.txt"

echo "\n安装完成。回到 Codex 说“激活文档产物侧边栏”即可；start.command 作为手动备用启动方式。"
if [[ "${CODEX_DOCUMENT_ARTIFACTS_NONINTERACTIVE:-0}" != "1" ]]; then
  read "?按回车键关闭窗口…"
fi
