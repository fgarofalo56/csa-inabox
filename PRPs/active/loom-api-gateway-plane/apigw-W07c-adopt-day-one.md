---
name: apigw-W07c-adopt-day-one
status: backlog
priority: P1
order: 45
depends_on: [apigw-W07a-pools-health, apigw-W07b-pool-access-deploy]
review: required
orchestrator_model: sonnet
implementer_model: sonnet
created: 2026-10-28
---
# W7c - Adopt the day-one gateway and close W7 (W7-5, W7-6)

Hub: `PRPs/active/loom-api-gateway-plane/PRP.md` (wave table and bicep rules). Shared context is linked, not repeated:
`ARCHITECTURE.md`, `TEST-STRATEGY.md`, `LOOM-INTEGRATION.md`, `W0-RECEIPT.md` in the same folder. Program rules: `.claude/rules/`.

## Goal
The bicep-authored day-one gateway (#4442) is adopted into the plane as a pool publication; Loom own Copilot traffic becomes a governed principal under `platform`; W7 closes with docs and receipts (D14, Q10, Q16).

## Why
Brings Loom own AI traffic under the same governance as customer traffic. This is the only item in the program blocked on another program.

## Scope / Non-goals
**Scope:** work items W7-5, W7-6 below.

**Non-goals:** Changing `LOOM_AOAI_VIA_APIM` / `LOOM_AOAI_APIM_URL`; deleting deployments.

## Acceptance criteria
Each names the value or output that would make it fail (the per-item Verify column below is part of this list).
- W7-5: adopt refuses when the live digest differs from the bicep-authored expectation; breaks if it adopts on mismatch.
- W7-5: after adoption a bicep what-if shows no change to the pool resources.
- W7-5: Loom Copilot turns appear under `platform` in Analytics within one interval on the Commercial estate.
- W7-6: `model-strategy.md` names the plane as owner of model access; every `apim-ai-gateway.md` row it claims is flipped.

## Read first
- `PRPs/active/apim-ai-gateway/apim-WA-multi-endpoint-pool.md` and `apim-WB1-default-on-commercial-gcc.md` (what they provide).
- `platform/fiab/bicep/modules/admin-plane/apim.bicep` (`aoaiPool`, `aoaiBackends` outputs), `apps/fiab-console/lib/azure/aoai-apim-gateway.ts`.
- `OPERATOR-DECISIONS-2026-10-29.md` (Q10, Q16).

## Owns
- `apps/fiab-console/lib/api-gateway/pools/adopt-deploy-owned.ts`
- `apps/fiab-console/app/api/admin/api-gateway/pools/adopt/**`
- `platform/fiab/bicep/modules/admin-plane/apim.bicep` (plane-mode branch only)
- `platform/fiab/bicep/modules/admin-plane/main.bicep` (loomBackends.aoaiGateway plane mode only)
- `platform/fiab/bicep/params/*.bicepparam` (only a boundary that opts out)
- `docs/fiab/model-strategy.md`
- `apps/fiab-console/e2e/api-gateway-pools.uat.ts`

## Must NOT touch
- Anything under `PRPs/active/apim-ai-gateway/`.
- `LOOM_AOAI_VIA_APIM` and `LOOM_AOAI_APIM_URL` values.

## Consumes
- W07a pools, W07b grants/keys; apim WA N-endpoint pool contract and WB1 default-on (other program).

## Provides
- Plane ownership of the deploy-owned pool; `platform` principal grant.

## Steps
Ordered; W7-5 (bicep, takes the bicep slot) then W7-6.

| ID | Title | Owns | Depends on | Model | Review | Verify |
|---|---|---|---|---|---|---|
| W7-5 | todo | | sonnet | | 2026-10-28 |
| W7-6 | todo | | sonnet | | 2026-10-28 |

#### Integration step (serialized)

- `docs/fiab/parity/apim-ai-gateway.md` rows (134, sections 5 and 8): `docs/fiab/parity/apim-ai-gateway.md` and `docs/fiab/admin/api-management.md` (section-scoped rows only; no PRP owns these files, so they are edited last in the PR and rebased on conflict; ASSUMPTION: orchestrator assigns the docs slot in `PRPs/reference/GLOBAL-SCHEDULE.md`).

## Validation
```bash
az bicep build --file platform/fiab/bicep/modules/admin-plane/main.bicep --stdout > /dev/null
for p in commercial commercial-full gcc gcc-high il5 dod tenant-dmlz; do az bicep build-params --file platform/fiab/bicep/params/$p.bicepparam --stdout > /dev/null && echo "$p: OK"; done
node scripts/ci/check-bicepparam-compiled.mjs
node scripts/ci/check-bicep-param-cap.mjs
node scripts/ci/check-bicep-sync.mjs
make validate-bicep
pnpm --dir apps/fiab-console vitest run lib/api-gateway/pools
python -S -E ~/.claude/kits/orchestrated-prp/prp_index.py check --root .
```
Per-cloud receipts: Commercial: what-if clean after adoption plus Copilot traffic under `platform`. GCC-High: adoption on the Gov gateway through Actions, or the measured limitation. IL5/GCC/DoD: `build-params` only, never exercised.
Merged is not done (`deploy-integrity.md` R2): until the deploy rolled and `/build-marker.txt` matches, report "merged, not deployed". A boundary without a receipt is named unexercised; GCC is supported-in-code, never exercised.

Done receipt: Commercial: day-one gateway adopted with bicep what-if clean; platform usage attributed. GCC-High: run id or limitation.

## Rollback
Set `loomBackends.aoaiGateway` back to `apim` (bicep re-authors the resources; the plane shows them deploy-owned again).

## Docs to update
`docs/fiab/model-strategy.md` (plane owns model access); `docs/fiab/parity/apim-ai-gateway.md` and `docs/fiab/admin/api-management.md` (section-scoped rows only; no PRP owns these files, so they are edited last in the PR and rebased on conflict; ASSUMPTION: orchestrator assigns the docs slot in `PRPs/reference/GLOBAL-SCHEDULE.md`).

## Wave / Blocked-by / Branch / Worktree
Wave: 7 · Blocked-by: apigw-W07a-pools-health, apigw-W07b-pool-access-deploy · Branch: feat/apigw-w07c · Worktree: E:/Repos/_apigw-w07c

Cross-program order: W7-5 starts only after apim-WA-multi-endpoint-pool and apim-WB1-default-on-commercial-gcc (PRPs/active/apim-ai-gateway) have merged; another program, so not a depends_on edge.

## Hot files
`platform/fiab/bicep/modules/admin-plane/apim.bicep`, `platform/fiab/bicep/modules/admin-plane/main.bicep`, `platform/fiab/bicep/params/*.bicepparam`.
Bicep queue: see PRPs/reference/GLOBAL-SCHEDULE.md
`touches_bicep: yes`

## Kickoff prompt
```
Read PRPs/active/loom-api-gateway-plane/apigw-W07c-adopt-day-one.md and apim-WA / apim-WB1 in PRPs/active/apim-ai-gateway.
Goal: W7-5 reviewed adoption + bicep plane mode (one bicep PR); W7-6 docs and receipts.
You take the bicep slot: check PRPs/reference/GLOBAL-SCHEDULE.md and open bicep PRs first.
Branch feat/apigw-w07c in E:/Repos/_apigw-w07c.
Proof: build-params on all 7 boundaries + check-bicepparam-compiled.mjs; adopt refuses on digest mismatch.
"merged, not deployed" until rolled.
```

## Execution state
| Item | Status | Branch | Model | Evidence | Updated |
|---|---|---|---|---|---|
| W7-5 | todo | | sonnet | | 2026-11-14 |
| W7-6 | todo | | sonnet | | 2026-11-14 |

Cost / credit estimate: ~3 Sonnet sessions; no new Azure resources.
