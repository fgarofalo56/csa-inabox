---
name: apigw-W07a-pools-health
status: backlog
priority: P1
order: 43
depends_on: [apigw-W02a-plan-engine, apigw-W02b-endpoints]
review: required
orchestrator_model: sonnet
implementer_model: sonnet
created: 2026-10-28
---
# W7a - Model pools, health and suggestions (W7-1, W7-2)

Hub: `PRPs/active/loom-api-gateway-plane/PRP.md` (wave table and bicep rules). Shared context is linked, not repeated:
`ARCHITECTURE.md`, `TEST-STRATEGY.md`, `LOOM-INTEGRATION.md`, `W0-RECEIPT.md` in the same folder. Program rules: `.claude/rules/`.

## Goal
One governed URL per vendor and shape serves a model from many deployments with PTU-first or balanced routing, per-attempt traces, health and suggested pools (ADR-002, ADR-005).

## Why
Pools are the substance of W7; access (W07b) and adoption (W07c) stand on them. Needs W02 only (plan engine, endpoints).

## Scope / Non-goals
**Scope:** work items W7-1, W7-2 below.

**Non-goals:** Per-pool grants and keys, reviewed model deployment (W07b); adoption of the day-one gateway (W07c).

## Acceptance criteria
Each names the value or output that would make it fail (the per-item Verify column below is part of this list).
- W7-1: outbound strips member-identifying headers and keeps `Retry-After`; breaks if a member header survives.
- W7-1: a linear pool with 11 members is refused; a batch deployment cannot be a member.
- W7-1: live Commercial two-member preferential pool with the primary forced to 429 serves from the secondary (`pool-probe.mjs`).
- W7-2: no traces gives `noData`, never zeros; one endpoint yields no suggestion (two endpoints do).
- W7-2: probe shows two attempts, the final 429 keeps `Retry-After` and names no member.

## Read first
- `apigw-W02a-plan-engine.md` and `apigw-W02b-endpoints.md` (Provides).
- `ARCHITECTURE.md` ADR-005; `AZURE-PARITY-INVENTORY.md` (pools / circuit breaker row).
- `PRPs/completed/model-strategy/PRP.md` (existing M4 pool/circuit-breaker).

## Owns
- `apps/fiab-console/lib/api-gateway/pools/**` (except pools/adopt-deploy-owned.ts, owned by W07c)
- `apps/fiab-console/lib/api-gateway/policy/pool.ts`
- `apps/fiab-console/lib/api-gateway/plan/pool.ts`
- `apps/fiab-console/lib/api-gateway/telemetry/attempts.ts`
- `apps/fiab-console/app/api/admin/api-gateway/pools/**` (except pools/adopt/**, owned by W07c)
- `apps/fiab-console/app/admin/api-gateway/pools/**`
- `apps/fiab-console/scripts/measure/apiplane/pool-probe.mjs`

## Must NOT touch
- `lib/azure/apim-client.ts` outside the integration step.
- Entitlement files (W07b).
- Any bicep.

## Consumes
- W02a plan/apply engine; W02b endpoint registry and readiness.

## Provides
- `modelPool` entity, pool renderer and plan, health/suggest functions consumed by W07b, W07c.

## Steps
Ordered; W7-1 then W7-2.

| ID | Title | Owns | Depends on | Model | Review | Verify |
|---|---|---|---|---|---|---|
| W7-1 | todo | | sonnet | | 2026-10-28 |
| W7-2 | todo | | sonnet | | 2026-10-28 |

#### Integration step (serialized)

- `apps/fiab-console/lib/azure/apim-client.ts` (pool and circuit-breaker bodies): owned by W02a; edit after merge.
- `apps/fiab-console/app/admin/api-gateway/page.tsx` (Dashboard Pools panel): hub page, owner not in this PRP set (ASSUMPTION: W02c or W01b; confirm); one panel import only.

## Validation
```bash
pnpm --dir apps/fiab-console vitest run lib/api-gateway/pools lib/api-gateway/policy
node apps/fiab-console/scripts/measure/apiplane/pool-probe.mjs --help
python -S -E ~/.claude/kits/orchestrated-prp/prp_index.py check --root .
```
Per-cloud receipts: Commercial: pool-probe run (failover observed). GCC-High: pool on the Gov gateway through Actions, or the measured limitation (gateway unreachable from Actions per W0). GCC/IL5: not exercised.
Merged is not done (`deploy-integrity.md` R2): until the deploy rolled and `/build-marker.txt` matches, report "merged, not deployed". A boundary without a receipt is named unexercised; GCC is supported-in-code, never exercised.

Done receipt: Commercial: pool failover observed; health and suggestions populated.

## Rollback
Pools unpublished through reviewed plans; pools code behind `LOOM_APIPLANE_ENABLED`.

## Docs to update
`docs/fiab/parity/apim-ai-gateway.md` and `docs/fiab/admin/api-management.md` (section-scoped rows only; no PRP owns these files, so they are edited last in the PR and rebased on conflict; ASSUMPTION: orchestrator assigns the docs slot in `PRPs/reference/GLOBAL-SCHEDULE.md`) (row 134 pools/circuit breaker; `apim-ai-gateway.md` sections 5 and 8).

## Wave / Blocked-by / Branch / Worktree
Wave: 4 · Blocked-by: apigw-W02a-plan-engine, apigw-W02b-endpoints · Branch: feat/apigw-w07a · Worktree: E:/Repos/_apigw-w07a

## Hot files
`lib/azure/apim-client.ts`, hub `page.tsx` (integration steps).
`touches_bicep: no`

## Kickoff prompt
```
Read PRPs/active/loom-api-gateway-plane/apigw-W07a-pools-health.md, apigw-W02a/W02b Provides.
Goal: W7-1 pools (renderer, plan/apply, workbench) then W7-2 health/suggestions + pool-probe.mjs.
Edit Owns paths only; apim-client.ts after W02a merged.
Branch feat/apigw-w07a in E:/Repos/_apigw-w07a.
Proof: vitest run lib/api-gateway/pools; mutation: drop the Retry-After keep in a sandbox copy, test RED.
"merged, not deployed" until rolled.
```

## Execution state
| Item | Status | Branch | Model | Evidence | Updated |
|---|---|---|---|---|---|
| W7-1 | todo | | sonnet | | 2026-11-14 |
| W7-2 | todo | | sonnet | | 2026-11-14 |

Cost / credit estimate: ~5 Sonnet sessions.
