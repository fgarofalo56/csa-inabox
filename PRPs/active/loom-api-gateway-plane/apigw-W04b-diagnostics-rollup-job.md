---
name: apigw-W04b-diagnostics-rollup-job
status: backlog
priority: P1
order: 30
depends_on: [apigw-W01-gateway-registry-observe, apigw-W04a-cost-centers-pricing, apigw-W03b-governed-renderer-keys]
review: none
orchestrator_model: sonnet
implementer_model: sonnet
created: 2026-10-28
---

# PRP: W4b - Diagnostics writer, telemetry card and the rollup worker job

Hub: `PRPs/active/loom-api-gateway-plane/PRP.md`. Shared context (read only the cited part): `PRPs/active/loom-api-gateway-plane/ARCHITECTURE.md`, `TEST-STRATEGY.md`, and the ADRs named below. Rules: no-vaporware, no-fabric-dependency, cloud-parity, auto-bind-by-default, deploy-integrity, ux-baseline (G1/G2/G3), assertion-design (`.claude/rules/`).

## Goal
Diagnostics are enabled on plane-published APIs with the Telemetry card, and a 15-minute worker job folds gateway logs into attributed rollups (facts, summaries, freshness, backfill).

## Why
Usage, analytics and budgets all read these rollups. Governed-call attribution needs the traces from apigw-W03b (W4-3 depends on W3-4); adopted APIs attribute by subscription before that. Contains the only bicep in W4 (new job module).

## Scope / Non-goals
**Scope:** items W4-2 (diagnostics writer + Telemetry card) and W4-3 (rollup + worker job).

**Non-goals:**
- No analytics UI (apigw-W04c).
- No budgets or notifications phases in the worker (apigw-W05 adds them; the internal budgets/notify routes are created there).
- No diagnostic settings writes, ever; no diagnostics on adopted APIs.

## Acceptance criteria
Each criterion names the value or output that would make it fail.
- [ ] The written API diagnostic has `sampling.percentage=100`, zero body bytes and no headers, paired with LLM logs enabled; value that breaks it: a body or header logged, or sampling under 100.
- [ ] An adopted API is never written; value that breaks it: a recorded write call for it.
- [ ] `parseAttributionTrace` and a `sweep`-style "never lower a day" receipt are RED under mutation (sandbox copy); a re-read returning fewer calls leaves stored figures unchanged; value that breaks it: a lowered day.
- [ ] The job run on the Commercial estate advances `rollupState.lastSuccessAt`; value that breaks it: an unchanged timestamp after a scheduled run. RU/day recorded in the receipt.
- [ ] Rollup inputs are validated and the sovereign Log Analytics endpoint comes from `cloud-endpoints.ts`; value that breaks it: a hard-coded commercial host.
- [ ] Telemetry card refuses `AzureDiagnostics` routing and **Refresh now** more than once per minute; value that breaks it: a second refresh within 60 s accepted.
- [ ] Bicep: `az bicep build` of the new module and `make validate-bicep` pass for every boundary param.

## Read first
- `adr/ADR-007-usage-from-gateway-logs.md`; `W0-RECEIPT.md` (which log tables exist per cloud; GCC-High has no GatewayLlmLogs).
- `apps/fiab-console/lib/api-gateway/observe/` and `registry/` (W1 patterns); `lib/azure/cloud-endpoints.ts`.
- `apps/fiab-console/e2e/run-cost-anomaly.mjs` and `e2e/run-access-sweep.mjs` (existing worker-job entry patterns) and an existing Container Apps Job module under `platform/fiab/bicep/modules/admin-plane/` (find with `grep -l 'Microsoft.App/jobs'`).
- `apps/fiab-console/lib/api-gateway/policy/access.ts` (apigw-W03b trace format `loom-deny v=1`, attribution trace).
- `apps/fiab-console/lib/api-gateway/cost-centers/` and `pricing/` (apigw-W04a).

## Owns
Exact repo-relative paths:
- `apps/fiab-console/lib/api-gateway/telemetry/diagnostics-writer.ts`
- `apps/fiab-console/lib/api-gateway/telemetry/readiness.ts`
- `apps/fiab-console/lib/api-gateway/telemetry/kql.ts`
- `apps/fiab-console/lib/api-gateway/telemetry/parser.ts`
- `apps/fiab-console/lib/api-gateway/telemetry/rollup.ts`
- `apps/fiab-console/lib/api-gateway/telemetry/freshness.ts`
- `apps/fiab-console/lib/api-gateway/telemetry/__tests__/**`
- `apps/fiab-console/app/api/admin/api-gateway/gateways/[id]/telemetry/**`
- `apps/fiab-console/app/admin/api-gateway/telemetry-card.tsx`
- `apps/fiab-console/e2e/run-apiplane-worker.mjs`
- `apps/fiab-console/app/api/internal/api-gateway/sync/route.ts`
- `apps/fiab-console/app/api/internal/api-gateway/rollup/route.ts`
- `platform/fiab/bicep/modules/admin-plane/apiplane-worker-job.bicep`
- `platform/fiab/bicep/modules/admin-plane/main.bicep`

## Must NOT touch
- `app/api/internal/api-gateway/{budgets,notify}/route.ts` (created by apigw-W05).
- In `main.bicep`: only the one module call for the job and env vars `LOOM_APIPLANE_USAGE_RETENTION_DAYS`, `LOOM_APIPLANE_ROLLUP_BACKFILL_MAX_DAYS`. Original plan said orchestrator wiring or a sibling deployment per the ARM 4 MiB headroom rule (`csa_loom_main_json_arm_4mib_headroom`): measure `main.json` with `git cat-file -s` at the ref and, if headroom is short, deploy the job as its own unit.
- `app/admin/api-gateway/gateway-detail.tsx` beyond mounting the card (W1 file; one additive mount line).
- `lib/gates/registry/api-gateway.ts` (apigw-W03a / apigw-W05 chain).
- Anything owned by another PRP in this program, including the lane files `apigw-W06*`, `apigw-W07*`, `apigw-W08*`, `apigw-W09*` and the hub `PRP.md`.

## Consumes
- apigw-W04a-cost-centers-pricing (cost-center resolution, `matchPrice`).
- apigw-W03b-governed-renderer-keys (attribution and deny traces).
- apigw-W01-gateway-registry-observe (registry, observed inventory, Monitoring Reader role granted by W1-2).

## Provides
- Rollup facts/summaries/registry/state consumed by apigw-W04c, apigw-W05.
- `e2e/run-apiplane-worker.mjs` job entry that apigw-W05 extends with budgets and notify phases.
- Internal token-guarded routes `sync` and `rollup`.

## Steps
1. Diagnostics (W4-2): `azuremonitor` logger ensure; per-API diagnostic on plane-published APIs (100 %, Information, no client IP/headers/bodies, LLM logs on with 0 prompt/completion bytes; on 400 for LLM logging apply without and report); never on adopted APIs; Telemetry card five checks (logger, routing incl. `AzureDiagnostics` rejection, read access last 24 h, API diagnostics readiness, rollups) with Enable API diagnostics (manage only, audited), Refresh now (<= 1/min), Backfill (audited); `az` command for routing fixes.
2. Rollup (W4-3): KQL (`GatewayLogs` joined to `GatewayLlmLog` on `CorrelationId`; `TraceRecords` parse; validated inputs), `parseAttributionTrace`, facts/summaries/registry/state writes (never lower a day; versioned state; sharding), window halving, leases, freshness, backfill 1-730 days in 7-day slices.
3. Worker: `apiplane-worker-job.bicep` (own deploy unit; cron `*/15`; Console UAMI; image `loom-uat`, `command: ['node','e2e/run-apiplane-worker.mjs']` calling the internal routes, internal-token guarded); job entry runs rollup now. Take the bicep slot before the first bicep commit.
4. Mutation arms in a sandbox copy; deploy, then Commercial receipt: `rollupState.lastSuccessAt` advancing, RU/day recorded. GCC-High: run the telemetry read through Actions per the W0-1 outcome or state the gap.

## Validation
```bash
pnpm --dir apps/fiab-console vitest run lib/api-gateway/telemetry app/api/internal/api-gateway app/api/admin/api-gateway/gateways
make validate-typescript
make validate-bicep
node scripts/ci/check-bicep-sync.mjs
node scripts/ci/check-bicep-param-cap.mjs
# live (after roll): read rollupState.lastSuccessAt twice 15+ minutes apart on the Commercial estate
```
Per-cloud receipts (cloud-parity; a boundary is claimed only with its own receipt):

| Boundary | Receipt required | State |
|---|---|---|
| Commercial | live run against the estate gateway, ids quoted | to be produced by this PRP |
| GCC-High | Actions run in-boundary (never local `az`); or the declared gap with its W0 measurement (`W0-RECEIPT.md`) | to be produced by this PRP; if the Gov estate is stood down, lifting the pause-declaration file is the operator's step |
| GCC | vitest / `az bicep build` parity only | supported-in-code, never exercised (no GCC tenant); not claimed |
| IL5 / DoD | vitest / `az bicep build` parity only | supported-in-code, never exercised; not claimed |

Merged is not done (`deploy-integrity.md` R2): until the change is rolled and the receipt observed on the estate, report it as "merged, not deployed".

## Rollback
`LOOM_APIPLANE_ENABLED=false` short-circuits the job entry; containers retained; revert the bicep PR to remove the job; diagnostics left in place on published APIs (harmless; removed by unpublish).

## Docs to update
Chained to apigw-W04c (analytics section of `api-management.md`). Put the worker-job and env-var deploy facts in the PR body for apigw-W04c to document.

## Wave / Blocked-by / Branch / Worktree
Wave: 5 · Blocked-by: apigw-W01-gateway-registry-observe, apigw-W04a-cost-centers-pricing, apigw-W03b-governed-renderer-keys · Branch: feat/apigw-w04b · Worktree: E:/Repos/_apigw-w04b

## Hot files
`platform/fiab/bicep/modules/admin-plane/main.bicep` (module call + two env vars) and new `apiplane-worker-job.bicep`; `main.json` ARM headroom (measure at the ref); `e2e/run-apiplane-worker.mjs` (apigw-W05 edits it after this PRP).
`touches_bicep: yes`
Bicep queue: see PRPs/reference/GLOBAL-SCHEDULE.md (one bicep-touching PR in flight; ledger `PRPs/reference/INTERLOCK.md`).

## Kickoff prompt
```
Read PRPs/active/loom-api-gateway-plane/apigw-W04b-diagnostics-rollup-job.md, ADR-007, W0-RECEIPT.md.
Goal: diagnostics writer + Telemetry card + 15-minute rollup worker job (W4-2, W4-3). apigw-W04a and apigw-W03b must be merged; take the bicep slot before bicep commits.
Edit only files under Owns. Worktree E:/Repos/_apigw-w04b, branch feat/apigw-w04b.
Proof: vitest on lib/api-gateway/telemetry + internal routes; make validate-typescript; make validate-bicep; after roll, rollupState.lastSuccessAt advances on Commercial.
Report merged-not-deployed.
```

## Execution state
| Item | Status | Branch | Model | Evidence | Updated |
|---|---|---|---|---|---|
| W4-2 diagnostics + Telemetry card | todo | | sonnet | | 2026-11-14 |
| W4-3 rollup + worker job | todo | | sonnet | | 2026-11-14 |
