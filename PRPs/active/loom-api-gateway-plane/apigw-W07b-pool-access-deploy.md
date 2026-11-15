---
name: apigw-W07b-pool-access-deploy
status: backlog
priority: P1
order: 44
depends_on: [apigw-W07a-pools-health, apigw-W02b-endpoints, apigw-W03b-governed-renderer-keys, apigw-W03c-requests-marketplace, apigw-W04b-diagnostics-rollup-job]
review: required
orchestrator_model: sonnet
implementer_model: sonnet
created: 2026-10-28
---
# W7b - Access per pool model and reviewed Azure model deployment (W7-3, W7-4)

Hub: `PRPs/active/loom-api-gateway-plane/PRP.md` (wave table and bicep rules). Shared context is linked, not repeated:
`ARCHITECTURE.md`, `TEST-STRATEGY.md`, `LOOM-INTEGRATION.md`, `W0-RECEIPT.md` in the same folder. Program rules: `.claude/rules/`.

## Goal
Grants and keys per pool model under a cost center, per-member pricing placement, and an operator-reviewed, quota-checked Azure model deployment flow (Mosaic ADR 0028).

## Why
Makes pools consumable and governable; W7-4 lets administrators add capacity without leaving Loom (it never deletes).

## Scope / Non-goals
**Scope:** work items W7-3, W7-4 below.

**Non-goals:** Adoption of the day-one gateway (W07c); pool creation (W07a).

## Acceptance criteria
Each names the value or output that would make it fail (the per-item Verify column below is part of this list).
- W7-3: a host shared by two members is never matched by deployment alone (unpriced, reported); breaks if priced.
- W7-3: revoking one model grant keeps the key until every grant it serves is revoked.
- W7-4: an uncertain PUT outcome keeps the lock and refuses a second PUT; a terminal resource differing from the plan is failed with Azure untouched; a quota `usageName` mismatch blocks apply.
- W7-4: live Commercial deployment of a small model, removed by the operator (the plane never deletes).

## Read first
- `apigw-W07a-pools-health.md`.
- `apps/fiab-console/lib/azure/foundry-client.ts`.
- `ARCHITECTURE.md` ADR-005, ADR-007.

## Owns
- `apps/fiab-console/lib/api-gateway/deployments/**`
- `apps/fiab-console/app/api/admin/api-gateway/endpoints/[id]/deployments/**`
- `apps/fiab-console/lib/azure/foundry-client.ts` (accounts/deployments PUT 2024-10-01 and usages read functions only)

## Must NOT touch
- `lib/api-gateway/pools/**` (W07a) except through its integration step.
- Bicep.

## Consumes
- W07a pools; W02b endpoints (W2-3); W03b grants/keys; W03c marketplace; W04b rollup.

## Provides
- Pool grants/keys, member-placement pricing, Deploy model flow consumed by W07c and W09.

## Steps
Ordered; W7-3 and W7-4 are independent after W07a/W02b; either order. Review required (Azure writes, key handling).

| ID | Title | Owns | Depends on | Model | Review | Verify |
|---|---|---|---|---|---|---|
| W7-3 | todo | | sonnet | | 2026-10-28 |
| W7-4 | todo | | sonnet | | 2026-10-28 |

#### Integration step (serialized)

- `lib/api-gateway/entitlements/{grants,keys}.ts` (pool branches): owned by W03b.
- `lib/api-gateway/policy/pool.ts` (access section): owned by W07a.
- `lib/api-gateway/telemetry/rollup.ts` (member placement): owned by W04b.
- `app/marketplace/**` (capacity badge): owned by W03c.
- Endpoints Deploy model UI under `app/admin/api-gateway/endpoints/**`: owned by W02b.

## Validation
```bash
pnpm --dir apps/fiab-console vitest run lib/api-gateway/deployments lib/api-gateway/entitlements lib/api-gateway/telemetry
python -S -E ~/.claude/kits/orchestrated-prp/prp_index.py check --root .
```
Per-cloud receipts: Commercial: reviewed deployment of a small model on the estate Foundry account (response body first 300 chars), then removed by the operator. GCC-High: Actions run id or stated limitation. GCC/IL5 not exercised.
Merged is not done (`deploy-integrity.md` R2): until the deploy rolled and `/build-marker.txt` matches, report "merged, not deployed". A boundary without a receipt is named unexercised; GCC is supported-in-code, never exercised.

Done receipt: Commercial: reviewed deployment created; pool access verified.

## Rollback
Grants revoked via the entitlement flow; deployments left for the operator; flag off hides routes.

## Docs to update
`docs/fiab/parity/apim-ai-gateway.md` and `docs/fiab/admin/api-management.md` (section-scoped rows only; no PRP owns these files, so they are edited last in the PR and rebased on conflict; ASSUMPTION: orchestrator assigns the docs slot in `PRPs/reference/GLOBAL-SCHEDULE.md`).

## Wave / Blocked-by / Branch / Worktree
Wave: 6 · Blocked-by: apigw-W07a-pools-health, apigw-W02b-endpoints, apigw-W03b-governed-renderer-keys, apigw-W03c-requests-marketplace, apigw-W04b-diagnostics-rollup-job · Branch: feat/apigw-w07b · Worktree: E:/Repos/_apigw-w07b

> ASSUMPTION: The brief listed W07a/W07b as needing W02 only. W7-3 edits files W03b/W03c own (grants.ts, keys.ts, marketplace), so W03b/W03c are declared in depends_on here; if lane 1 splits these files differently, drop the extra edges.

## Hot files
`foundry-client.ts`, plus integration files owned upstream.
`touches_bicep: no`

## Kickoff prompt
```
Read PRPs/active/loom-api-gateway-plane/apigw-W07b-pool-access-deploy.md, W07a, W03b/W03c Provides.
Goal: W7-3 pool access + member pricing; W7-4 reviewed model deployment.
Edit Owns paths; shared files only per Integration step after owners merged.
Branch feat/apigw-w07b in E:/Repos/_apigw-w07b.
Proof: vitest run lib/api-gateway/deployments lib/api-gateway/entitlements.
"merged, not deployed" until rolled.
```

## Execution state
| Item | Status | Branch | Model | Evidence | Updated |
|---|---|---|---|---|---|
| W7-3 | todo | | sonnet | | 2026-11-14 |
| W7-4 | todo | | sonnet | | 2026-11-14 |

Cost / credit estimate: ~5 Sonnet sessions.
