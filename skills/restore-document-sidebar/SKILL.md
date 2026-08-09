---
name: restore-document-sidebar
description: Restore and verify the custom “文档产物” entry in the Codex desktop sidebar. Use when the entry disappears, stops opening, the local document service is unavailable, Codex has restarted, or the resident injector has stopped.
---

# Restore Document Sidebar

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
- Use the dedicated CDP window created by the script when the current Codex window has no debug port. Never quit or relaunch the user's main Codex window implicitly.
- Set `DOCUMENT_ARTIFACTS_DIR` only when the repository or installed release folder moved.
