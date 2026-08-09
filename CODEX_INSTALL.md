# Codex 自动安装协议

这份说明供 Codex 在用户要求“安装并激活文档产物侧边栏”时执行。普通用户不需要手动运行这里的命令。

## 目标

在 macOS 上从正式 GitHub Release 安装用户指定版本，安装恢复 Skill，并完成侧边栏真实点击验证。不要把 GitHub 自动生成的 Source code 压缩包当作安装包。

## 版本选择

- 非哔哩哔哩员工：`v0.2.1`，附件 `codex-document-artifacts-v0.2.1-macos.zip`。
- 哔哩哔哩员工且需要公司文档平台模块：`bilibili-v1.0.1`，附件 `codex-document-artifacts-bilibili-v1-macos.zip`。
- 用户没有说明身份或版本时，先问清楚，不要根据 GitHub 的 `Latest` 标记猜测。

## 执行要求

1. 确认操作系统是 macOS，且 `/Applications/ChatGPT.app` 存在。侧边栏模式不支持 Windows 或 Linux。激活脚本会打开一个带本机调试端口的独立 Codex 窗口，并复用用户现有登录状态；不要退出用户原来的主窗口。
2. 从 `https://github.com/RuiChenKe/codex-document-artifacts/releases/tag/<tag>` 下载上面指定的 macOS ZIP 和同名 `.sha256` 文件。
3. 计算 ZIP 的 SHA-256，并与 `.sha256` 文件的第一列严格比较；不一致时停止。
4. 解压到用户可长期保留的位置。默认使用：
   - 公开版：`~/Applications/Codex Document Artifacts/public-v0.2.1`
   - 公司版：`~/Applications/Codex Document Artifacts/bilibili-v1`
5. 在解压后的项目根目录运行：

   ```bash
   CODEX_DOCUMENT_ARTIFACTS_NONINTERACTIVE=1 ./install.command
   ```

6. 安装成功后运行已安装 Skill 的恢复脚本：

   ```bash
   DOCUMENT_ARTIFACTS_DIR="<解压后的项目根目录>" \
     node "${CODEX_HOME:-${HOME}/.codex}/skills/restore-document-sidebar/scripts/restore.mjs"
   ```

7. 必须读取恢复脚本的最终 JSON。只有以下三项均为 `true` 才能报告完成：
   - `serviceHealthy`
   - `documentsEntry`
   - `documentsClickLoaded`

8. 保留返回的 `residentPid` 运行，不要删除或重建现有的文档索引。

如果恢复脚本明确报告当前 Codex 窗口无法注入，告知用户完全退出 Codex 后双击安装目录里的 `start.command`。这是备用路径，不要在自动恢复仍可继续时提前要求用户手动操作。

## 对用户的完成汇报

简要说明安装的版本、安装位置，以及侧边栏入口和本机服务均已验证。不要要求用户再手动运行 `start.command`；它只作为自动恢复失败时的备用方式。
