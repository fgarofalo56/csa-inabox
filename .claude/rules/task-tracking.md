# Task Tracking (native-first)

- **In-session:** the native task list — the harness manages it; keep statuses
  honest as work progresses.
- **Cross-session:** GitHub Issues (`gh issue`); PRs close them with
  "Closes #N".
- **Multi-PR programs:** a plan file (`PRPs/plans/<name>.plan.md` or
  `docs/fiab/prp/`).
- **Archon is archived (2026-04).** Never invoke it unless explicitly asked.

Close an issue only on DEPLOYED-and-verified, never on merge alone
(`deploy-integrity.md` R2). When stopping mid-stream, leave a resumable trail —
an issue comment or PR body with enough context to pick up cold.

## Knowledge lookup

- Library/framework docs: Context7 MCP; Azure/Fabric: Microsoft Learn MCP
  (`microsoft_docs_search` / `microsoft_docs_fetch`).
- Project-internal: Grep `.claude/reference/`, `docs/`, then the code itself.
