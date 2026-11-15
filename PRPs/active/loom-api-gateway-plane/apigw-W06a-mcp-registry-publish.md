---
name: apigw-W06a-mcp-registry-publish
status: backlog
priority: P1
order: 40
depends_on: [apigw-W02a-plan-engine, apigw-W02c-workbench-adopt, apigw-W03a-bootstrap-principals-grants, apigw-W03b-governed-renderer-keys]
review: required
orchestrator_model: sonnet
implementer_model: sonnet
created: 2026-10-28
---
# W6a - MCP registry, discovery and gateway publication (W6-1, W6-2)

Hub: `PRPs/active/loom-api-gateway-plane/PRP.md` (wave table and bicep rules). Shared context is linked, not repeated:
`ARCHITECTURE.md`, `TEST-STRATEGY.md`, `LOOM-INTEGRATION.md`, `W0-RECEIPT.md` in the same folder. Program rules: `.claude/rules/`.

## Goal
An MCP server registered by URL is discovered read-only and published through a managed gateway as a passthrough MCP API with RFC 9728 discovery, `Mcp.Invoke` enforcement and fail-closed apply (ADR-002, ADR-004).

## Why
Mosaic parity for MCP (`MOSAIC-CAPABILITY-MAP.md`) and the base the grants (W06b) and on-behalf (W06c) slices stand on. W6-2 reuses the plan/apply engine from W02a; the access policy comes from W03.

## Scope / Non-goals
**Scope:** work items W6-1, W6-2 below.

**Non-goals:** Grants, marketplace, My access and Loom-agent publishing (W06b); model caller and on-behalf attribution (W06c); no `tools/call` anywhere.

## Acceptance criteria
Each names the value or output that would make it fail (the per-item Verify column below is part of this list).
- W6-1: a cap hit with a cursor remaining raises and exempts `observedMcpTool` from the sweep; value that breaks it: a swept tool after a capped list.
- W6-1: no code path calls `tools/call` (static assertion over exported methods, paired with a positive `tools/list` call); breaks if a `tools/call` method is exported.
- W6-1: `ssrfGuard` mutation receipt (RED when the guard is removed, sandbox copy, tracked tree untouched).
- W6-2: the deny policy is written before a backend URL change; breaks if the order test sees the backend PUT first.
- W6-2: planning is refused when another API occupies the blank path; breaks if a plan is produced.
- W6-2: live Commercial publish of `https://learn.microsoft.com/api/mcp` then `verify-mcp-access.mjs` is green (script lands in W06b; until then run a manual probe and say so). GCC-High: W0-3 found the `2025-09-01-preview` MCP type unregistered, so the receipt is the measured limitation or an Actions run id, never assumed.

## Read first
- `W0-RECEIPT.md` section 3 (MCP API type: Commercial measured, GCC-High not).
- `ARCHITECTURE.md` ADR-002 (fail-closed), ADR-004, ADR-007.
- `apps/fiab-console/lib/azure/apim-client.ts` (MCP API create/update/delete), `apps/fiab-console/lib/api-gateway/registry/resolve-gateway.ts`.
- `TEST-STRATEGY.md` section 1 mutation table; `.claude/rules/assertion-design.md`.

## Owns
- `apps/fiab-console/lib/api-gateway/mcp/client.ts`
- `apps/fiab-console/lib/api-gateway/mcp/ssrf.ts`
- `apps/fiab-console/lib/api-gateway/mcp/registry.ts`
- `apps/fiab-console/lib/api-gateway/mcp/discovery.ts`
- `apps/fiab-console/lib/api-gateway/mcp/publication.ts`
- `apps/fiab-console/lib/api-gateway/policy/mcp.ts`
- `apps/fiab-console/lib/api-gateway/policy/prm.ts`
- `apps/fiab-console/lib/api-gateway/plan/mcp.ts`
- `apps/fiab-console/app/api/admin/api-gateway/mcp-servers/**`
- `apps/fiab-console/app/api/admin/api-gateway/mcp-publications/**`
- `apps/fiab-console/app/admin/api-gateway/mcp-servers/**`
- `apps/fiab-console/app/api/admin/mcp-servers/route.ts`
- `apps/fiab-console/lib/components/admin/mcp-servers-panel.tsx`

## Must NOT touch
- `lib/api-gateway/entitlements/**`, `app/marketplace/**` (W06b / W03).
- `lib/api-gateway/telemetry/**` (W04b).
- Any bicep.

## Consumes
- W02a plan/apply engine (`lib/api-gateway/plan/**`), W03a principals/grants, W03b governed access renderer.

## Provides
- `mcpEndpoint` registry, discovery sync and `mcpPublication` plan/apply consumed by W06b, W06c.
- Migrated `mcpServersContainer` records to `mcpEndpoint`.

## Steps
Ordered; W6-1 then W6-2. W6-1 requires `review: required` (outbound calls to operator hosts).

| ID | Title | Owns | Depends on | Model | Review | Verify |
|---|---|---|---|---|---|---|
| W6-1 | todo | | sonnet | | 2026-10-28 |
| W6-2 | todo | | sonnet | | 2026-10-28 |

#### Integration step (serialized)

- `apps/fiab-console/lib/azure/apim-client.ts` (MCP API create/update/delete with LRO): owned by W02a; add the MCP functions after W02a merges.

## Validation
```bash
pnpm --dir apps/fiab-console vitest run lib/api-gateway/mcp lib/api-gateway/plan lib/api-gateway/policy
pnpm --dir apps/fiab-console exec tsc --noEmit
python -S -E ~/.claude/kits/orchestrated-prp/prp_index.py check --root .
```
Per-cloud receipts: Commercial: publish receipt (run id / response body first 300 chars). GCC-High: Actions run id or the W0-3 limitation quoted. IL5: supported-in-code via params only. GCC: supported-in-code, never exercised.
Merged is not done (`deploy-integrity.md` R2): until the deploy rolled and `/build-marker.txt` matches, report "merged, not deployed". A boundary without a receipt is named unexercised; GCC is supported-in-code, never exercised.

Done receipt: Commercial: external MCP server registered, discovered and published; GCC-High: run id or the W0-3 limitation.

## Rollback
Unpublish plans (deny before delete); endpoints retained; `LOOM_APIPLANE_ENABLED=false` hides the surface; `/api/admin/mcp-servers` keeps its original behaviour.

## Docs to update
Section-scoped MCP rows: `docs/fiab/parity/apim-ai-gateway.md` and `docs/fiab/admin/api-management.md` (section-scoped rows only; no PRP owns these files, so they are edited last in the PR and rebased on conflict; ASSUMPTION: orchestrator assigns the docs slot in `PRPs/reference/GLOBAL-SCHEDULE.md`).

## Wave / Blocked-by / Branch / Worktree
Wave: 5 · Blocked-by: apigw-W02a-plan-engine, apigw-W02c-workbench-adopt, apigw-W03a-bootstrap-principals-grants, apigw-W03b-governed-renderer-keys · Branch: feat/apigw-w06a · Worktree: E:/Repos/_apigw-w06a

> ASSUMPTION: W6-2 needs a gateway-scoped durable write lock; if W02a already provides one, reuse it instead of adding a second.

## Hot files
`apps/fiab-console/lib/azure/apim-client.ts` (integration step), `lib/api-gateway/policy/mcp.ts` (W06c edits it later, ordered by depends_on).
`touches_bicep: no`

## Kickoff prompt
```
Read PRPs/active/loom-api-gateway-plane/apigw-W06a-mcp-registry-publish.md, PRP.md wave table, W0-RECEIPT.md section 3.
Goal: W6-1 MCP endpoint registry + discovery, then W6-2 MCP publication plan/apply (fail-closed, RFC 9728 PRM).
Edit only the Owns paths; apim-client.ts only after W02a has merged.
Branch feat/apigw-w06a in E:/Repos/_apigw-w06a (from origin/main).
Proof: pnpm --dir apps/fiab-console vitest run lib/api-gateway/mcp; the ssrf mutation goes RED in a sandbox copy.
Report "merged, not deployed" until the roll is verified.
```

## Execution state
| Item | Status | Branch | Model | Evidence | Updated |
|---|---|---|---|---|---|
| W6-1 | todo | | sonnet | | 2026-11-14 |
| W6-2 | todo | | sonnet | | 2026-11-14 |

Cost / credit estimate: ~6 Sonnet sessions (half of the former W6).
