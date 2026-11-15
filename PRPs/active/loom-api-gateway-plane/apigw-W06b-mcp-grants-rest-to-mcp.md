---
name: apigw-W06b-mcp-grants-rest-to-mcp
status: backlog
priority: P1
order: 41
depends_on: [apigw-W06a-mcp-registry-publish, apigw-W03b-governed-renderer-keys, apigw-W03c-requests-marketplace]
review: required
orchestrator_model: sonnet
implementer_model: sonnet
created: 2026-10-28
---
# W6b - MCP grants, marketplace offering, Loom agents and REST-to-MCP (W6-3, W6-5)

Hub: `PRPs/active/loom-api-gateway-plane/PRP.md` (wave table and bicep rules). Shared context is linked, not repeated:
`ARCHITECTURE.md`, `TEST-STRATEGY.md`, `LOOM-INTEGRATION.md`, `W0-RECEIPT.md` in the same folder. Program rules: `.claude/rules/`.

## Goal
Users, agents and groups obtain call-limited access to a published MCP server through the approval engine and the marketplace; Loom own agents publish through the gateway; a managed REST API can be exposed as an MCP server.

## Why
Completes the consumer side of MCP publishing on the W06a base; W6-5 needs only W6-2 but is bundled to stay inside one session.

## Scope / Non-goals
**Scope:** work items W6-3, W6-5 below.

**Non-goals:** Model caller / on-behalf (W06c); docs and receipts (W06c); token limits on MCP grants (refused by design).

## Acceptance criteria
Each names the value or output that would make it fail (the per-item Verify column below is part of this list).
- W6-3: a token-limited MCP grant is refused at save; breaks if it is stored.
- W6-3: anonymous call returns 401 with the challenge; metadata returns 200; `invalid_token` on a bad bearer; a metadata document that only works at another URL fails `verify-mcp-access.mjs`.
- W6-3: unpublished server returns `409 notPublished` on connection details.
- W6-5: publishing a data agent registers exactly one endpoint (idempotent on re-publish); breaks if re-publish adds a second record.
- W6-5: an exposed REST API lists only the selected operations as tools; breaks if an unselected operation appears.

## Read first
- `apigw-W06a-mcp-registry-publish.md` (what it provides).
- `apps/fiab-console/app/api/items/data-agent/[id]/publish-mcp/route.ts` (and the agent-flow, loom-app-runtime siblings).
- `ARCHITECTURE.md` ADR-007 and the F16 approval engine reference in `LOOM-INTEGRATION.md`.

## Owns
- `apps/fiab-console/app/api/items/data-agent/[id]/publish-mcp/route.ts`
- `apps/fiab-console/app/api/items/agent-flow/[id]/publish-mcp/route.ts`
- `apps/fiab-console/app/api/items/loom-app-runtime/[id]/publish-mcp/route.ts`
- `apps/fiab-console/lib/api-gateway/mcp/from-rest-api.ts`
- `apps/fiab-console/scripts/measure/apiplane/verify-mcp-access.mjs`

## Must NOT touch
- `lib/api-gateway/mcp/{client,registry,discovery,publication}.ts` (W06a).
- `lib/api-gateway/telemetry/**`.

## Consumes
- W06a `mcpEndpoint` and `mcpPublication`.
- W03b grants/keys, W03c requests and marketplace offering kinds.

## Provides
- MCP grants resource kind, marketplace "MCP servers" offering, My access connection details, `verify-mcp-access.mjs` (consumed by W06c and W09).

## Steps
Ordered; W6-3 then W6-5 (independent after W06a; either order).

| ID | Title | Owns | Depends on | Model | Review | Verify |
|---|---|---|---|---|---|---|
| W6-3 | todo | | sonnet | | 2026-10-28 |
| W6-5 | todo | | sonnet | | 2026-10-28 |

#### Integration step (serialized)

- `apps/fiab-console/lib/api-gateway/entitlements/grants.ts` (mcpServer resource kind): owned by W03b; edit after it merges.
- `apps/fiab-console/app/marketplace/**` (MCP servers offering kind): owned by W03c.
- `apps/fiab-console/app/api/me/api-gateway/connection/**` (MCP branch): owned by W03c (ASSUMPTION; confirm in its Owns list).
- `apps/fiab-console/app/admin/api-gateway/mcp-servers/**` (Publish through gateway link, Expose REST API action): owned by W06a.
- Item publish dialogs for the three item types: file locations not yet identified; locate in step 1 and add here before editing (ASSUMPTION; if any is a hot file, name its owner first).

## Validation
```bash
pnpm --dir apps/fiab-console vitest run lib/api-gateway/mcp lib/api-gateway/entitlements
node apps/fiab-console/scripts/measure/apiplane/verify-mcp-access.mjs --help
python -S -E ~/.claude/kits/orchestrated-prp/prp_index.py check --root .
```
Per-cloud receipts: Commercial: verify-mcp-access run (anonymous 401, metadata 200, bad bearer, good token). GCC-High: Actions run id or the measured MCP-type limitation. GCC: never exercised.
Merged is not done (`deploy-integrity.md` R2): until the deploy rolled and `/build-marker.txt` matches, report "merged, not deployed". A boundary without a receipt is named unexercised; GCC is supported-in-code, never exercised.

Done receipt: Commercial: a Loom data agent published through the gateway and called from VS Code with a token. GCC-High: run id or limitation.

## Rollback
`publish-mcp` routes keep their original behaviour when `LOOM_APIPLANE_ENABLED` is false; grants revoked by the entitlement flow; endpoints retained.

## Docs to update
Section-scoped MCP rows: `docs/fiab/parity/apim-ai-gateway.md` and `docs/fiab/admin/api-management.md` (section-scoped rows only; no PRP owns these files, so they are edited last in the PR and rebased on conflict; ASSUMPTION: orchestrator assigns the docs slot in `PRPs/reference/GLOBAL-SCHEDULE.md`).

## Wave / Blocked-by / Branch / Worktree
Wave: 6 · Blocked-by: apigw-W06a-mcp-registry-publish, apigw-W03b-governed-renderer-keys, apigw-W03c-requests-marketplace · Branch: feat/apigw-w06b · Worktree: E:/Repos/_apigw-w06b

> ASSUMPTION: W6-3 is review required; W6-5 alone would be none, the PRP-level review stays required.

## Hot files
`lib/api-gateway/entitlements/grants.ts`, `app/marketplace/**` (integration steps, owned upstream).
`touches_bicep: no`

## Kickoff prompt
```
Read PRPs/active/loom-api-gateway-plane/apigw-W06b-mcp-grants-rest-to-mcp.md and apigw-W06a (Provides).
Goal: W6-3 MCP grants + marketplace + verify-mcp-access.mjs; W6-5 Loom agents publish-mcp + REST-to-MCP.
Edit Owns paths; grants.ts and app/marketplace only after W03b/W03c merged.
Branch feat/apigw-w06b in E:/Repos/_apigw-w06b.
Proof: pnpm --dir apps/fiab-console vitest run lib/api-gateway/mcp lib/api-gateway/entitlements.
Report "merged, not deployed" until rolled.
```

## Execution state
| Item | Status | Branch | Model | Evidence | Updated |
|---|---|---|---|---|---|
| W6-3 | todo | | sonnet | | 2026-11-14 |
| W6-5 | todo | | sonnet | | 2026-11-14 |

Cost / credit estimate: ~4 Sonnet sessions.
