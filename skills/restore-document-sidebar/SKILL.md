---
name: restore-document-sidebar
description: Activate, restore, and verify the custom “文档产物” entry in the Codex desktop sidebar. Use for first-time activation, when the user says “激活文档产物侧边栏”, when the entry disappears or stops opening, when the local document service is unavailable, after Codex or the computer restarts, or when the resident injector has stopped.
---

# Activate or Restore Document Sidebar

Restore the sidebar from the installed `codex-document-artifacts` folder without replacing its local index.

## Workflow

1. Run the bundled recovery script from this Skill directory:

   ```bash
   node scripts/restore.mjs
   ```

2. Read the final JSON. Treat recovery as successful only when all are `true`:
   - `serviceHealthy`
   - `documentsEntry`
   - `documentsClickLoaded`

3. Leave the returned `residentPid` running. It keeps the service and sidebar injection alive.

4. If visual confirmation matters, inspect the Codex window after the real click check. Do not claim visual QA from health or process checks alone.

## Safety

- Preserve `.data/document-artifacts.sqlite`; never recreate, overwrite, or delete it to fix a missing sidebar.
- Keep the service on `127.0.0.1`.
- Use the separate CDP-enabled Codex instance created by the script when the current window has no debug port. It reuses the user's existing Codex login state without quitting or relaunching the main window.
- Set `DOCUMENT_ARTIFACTS_DIR` only when the repository or installed release folder moved.
