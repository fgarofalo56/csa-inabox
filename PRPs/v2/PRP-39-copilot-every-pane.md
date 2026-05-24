# PRP-39 — Loom Copilot in every Console pane

> **Status: v2 backlog (stub).** No code work until v1 complete + v2 walkthrough.

## Context

v1 ships a "Data Agent" pane with chat-style NL2SQL/DAX/KQL (PRP-09).
The user 2026-05-23 walkthrough requires **Copilot embedded in EVERY
pane** so users can ask "create a workspace for finance," "build a
shortcut from S3," "publish this notebook as an API," etc. — and the
agent **actually executes** scoped to the user's RBAC.

PRD ref: `docs/fiab/v2-scope-expansion.md` §14.

## Goal

A persistent Copilot side-panel in `apps/fiab-console/` that:
1. Sees the active pane + selected item context
2. Suggests pane-relevant prompts
3. Executes any operation the user can perform (CRUD on workspaces,
   items, RBAC grants, deploy ops, dbt runs, refresh ops, etc.)
4. Streams progress for long-running tasks
5. Requests confirmation for destructive ops
6. Identity passthrough throughout (OBO)

## Acceptance criteria

- [ ] Persistent Copilot panel component (collapsible, right-side, 320px)
  added to `app-shell.tsx` (visible across all 9 panes including Marketplace)
- [ ] Per-pane context injection: active pane name, current selection
  (e.g., selected lakehouse table), recent action history
- [ ] Tool catalog dynamically gated by caller's RBAC (no UI hint that
  unavailable tools exist)
- [ ] New tools added to `apps/copilot/tools/loom_action_tools.py`:
  - `create_workspace`, `delete_workspace` (destructive — confirm)
  - `create_dlz` (destructive)
  - `grant_workspace_role`, `revoke_workspace_role`
  - `refresh_semantic_model_partition`
  - `trigger_pipeline`, `trigger_dbt_run`
  - `create_shortcut`
  - `publish_api`
  - `run_kql`, `run_sql`, `run_dax` (already exist)
- [ ] Progress streaming via SSE from copilot Function backend → Console
- [ ] Destructive-op confirmation modal (matches Fabric's "Are you sure?"
  UX for delete operations)
- [ ] Audit trail: every action logged to LAW with caller + action +
  result + before/after state
- [ ] PydanticAI agent loop wraps action selection with reasoning trace
  (visible in panel "Thinking..." indicator)

## Per-boundary behavior

| Boundary | Notes |
|---|---|
| Commercial / GCC | Foundry Agent Service backend |
| GCC-High / IL5 | MAF + AOAI direct (Foundry not GA) |

## Risks

- **Tool sprawl** — adding 20+ action tools makes the agent slow and
  prone to wrong-tool selection. Mitigation: cluster tools into
  routing-stage that picks the right tool family first
- **Permissions inference** — RBAC at the Console layer must mirror
  the backing engine layer EXACTLY or users will be confused.
  Mitigation: every tool re-validates at execution time; UI only does
  best-effort hiding
- **Destructive-op safety** — undo/redo for "delete workspace" is
  hard (workspace contents are scattered across many resources).
  Mitigation: soft-delete + 24h cooling-off for terminal operations
- **Cost** — every pane-load fires a small agent call for "suggested
  prompts". Could 10x AOAI bill. Mitigation: cache suggestions per
  pane+selection; refresh only on explicit user request

## Sizing: XL (12 weeks; 2-3 engineers)

## Related

- v1 PRP-09 (Data Agents) is the existing chat-style baseline
- v1 PRP-05 (Self-hosted Azure MCP) provides the tool execution layer
- v2 PRP-31 (developer portal) adds API playground tools the Copilot
  can also drive
- v1 audit: [PRP Delivery Audit](../../docs/fiab/prp-audit.md)
