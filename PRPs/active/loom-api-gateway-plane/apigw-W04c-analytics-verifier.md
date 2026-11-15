---
name: apigw-W04c-analytics-verifier
status: backlog
priority: P1
order: 31
depends_on: [apigw-W04b-diagnostics-rollup-job, apigw-W04a-cost-centers-pricing, apigw-W03c-requests-marketplace]
review: none
orchestrator_model: sonnet
implementer_model: sonnet
created: 2026-10-28
---

# PRP: W4c - Analytics, chargeback and the telemetry verifier

Hub: `PRPs/active/loom-api-gateway-plane/PRP.md`. Shared context (read only the cited part): `PRPs/active/loom-api-gateway-plane/ARCHITECTURE.md`, `TEST-STRATEGY.md`, and the ADRs named below. Rules: no-vaporware, no-fabric-dependency, cloud-parity, auto-bind-by-default, deploy-integrity, ux-baseline (G1/G2/G3), assertion-design (`.claude/rules/`).

## Goal
Usage is visible by caller, application, grant, model, deployment, API and cost center in Analytics; chargeback joins the FinOps pages; each user sees only their own Usage & cost; a telemetry probe and G1 walk produce the per-cloud receipts.

## Why
Surfaces the rollups from apigw-W04b priced by apigw-W04a. Depends on apigw-W03c only to continue the shared docs chain (`api-management.md` and parity docs are edited W02c -> W03c -> W04c -> W05), not for code.

## Scope / Non-goals
**Scope:** items W4-5 (analytics + chargeback) and W4-6 (verifier, docs, receipts).

**Non-goals:**
- No rollup/worker changes (apigw-W04b).
- No budgets (apigw-W05); on-behalf analytics section arrives with apigw-W06c.

## Acceptance criteria
Each criterion names the value or output that would make it fail.
- [ ] Without rollups every analytics route returns `notConfigured` with empty reports, never samples; value that breaks it: any non-empty fixture data returned.
- [ ] The cost column is hidden when no row has a cost; value that breaks it: a column of zeros shown.
- [ ] A user's usage route never returns another caller's identity, paired with their own rows present; value that breaks it: a foreign identity in the response.
- [ ] CSV: 10,000-row cap, BOM, formula guard (a cell starting with `=` is prefixed), filename `loom-<view>-<from>-<to>.csv`; value that breaks it: a raw `=cmd` cell or an 10,001st row.
- [ ] Commercial: one governed call appears in Analytics within one interval with caller, grant, model, cost center and price; freshness reads "Current"; value that breaks it: the call absent after 30 minutes.
- [ ] GCC-High: telemetry probe run id from Actions, or the declared gap with substitute; parity rows 86, 163, 164 in `apim-service.md` flipped with the backend named.

## Read first
- `adr/ADR-007-usage-from-gateway-logs.md`; `TEST-STRATEGY.md` sections 3 and 4.
- `apps/fiab-console/lib/api-gateway/telemetry/` (apigw-W04b) and `lib/api-gateway/pricing/` (apigw-W04a).
- `apps/fiab-console/app/admin/chargeback/page.tsx`, `app/admin/finops/page.tsx`, `lib/components/finops/` (siblings to match).
- `apps/fiab-console/app/admin/api-gateway/page.tsx` (Dashboard cards) and `app/marketplace/` (user usage page sibling).
- `scripts/measure/apiplane/registry-probe.mjs` (probe pattern).

## Owns
Exact repo-relative paths:
- `apps/fiab-console/app/api/admin/api-gateway/analytics/**`
- `apps/fiab-console/app/admin/api-gateway/analytics/**`
- `apps/fiab-console/app/admin/api-gateway/page.tsx`
- `apps/fiab-console/app/admin/chargeback/page.tsx`
- `apps/fiab-console/app/admin/finops/page.tsx`
- `apps/fiab-console/app/api/me/api-gateway/usage/**`
- `apps/fiab-console/app/marketplace/usage/page.tsx`
- `apps/fiab-console/lib/components/finops/**`
- `scripts/measure/apiplane/telemetry-probe.mjs`
- `apps/fiab-console/e2e/api-gateway-analytics.uat.ts`
- `docs/fiab/admin/api-management.md`
- `docs/fiab/parity/apim-ai-gateway.md`
- `docs/fiab/parity/apim-service.md`

## Must NOT touch
- `lib/api-gateway/telemetry/**` (apigw-W04b).
- `app/marketplace/page.tsx` and other marketplace files (apigw-W03c).
- Any `platform/fiab/bicep/**` file.
- Anything owned by another PRP in this program, including the lane files `apigw-W06*`, `apigw-W07*`, `apigw-W08*`, `apigw-W09*` and the hub `PRP.md`.

## Consumes
- apigw-W04b-diagnostics-rollup-job (rollups, freshness).
- apigw-W04a-cost-centers-pricing (cost centers, prices).
- apigw-W03c-requests-marketplace (docs chain only).

## Provides
- Analytics routes/pages and the `/admin/chargeback` + `/admin/finops` model-usage sections; apigw-W05 adds its budget list to `app/admin/finops/page.tsx` after this PRP.
- Docs chain position 3.

## Steps
1. Analytics (W4-5): Overview (gateway health, cost-center ranking), Cost (total, trend, by model/deployment/caller/API/cost center, month spend, forecast), Consumers, Limits (near/reached/unknown, partial window), Reliability (outcomes, deployments, gateway-throttled vs backend 429), Unattributed, Access hygiene (fixed 30 days); Filters with Apply/Cancel; Graph name lookups <= 200 cached 1 h; CSV; Dashboard cards; Admin Chargeback and FinOps **Model usage** sections; chargeback CSV columns; user **Usage & cost** page.
2. Verifier (W4-6): `telemetry-probe.mjs`; docs (`api-management.md` analytics section; `apim-service.md` rows 86, 163, 164; `apim-ai-gateway.md` W4 rows).
3. G1 walk Commercial with screenshots (dark and light, narrow width); GCC-High probe through Actions.

### Integration step (serialized)
- Hub navigation: Analytics link in `app/admin/api-gateway/_lib/hub-model.ts` (owner: apigw-W01, shipped), one additive line.

## Validation
```bash
pnpm --dir apps/fiab-console vitest run app/api/admin/api-gateway/analytics app/api/me/api-gateway/usage lib/components/finops
make validate-typescript
node scripts/measure/apiplane/telemetry-probe.mjs   # Commercial; Gov via Actions
pnpm --dir apps/fiab-console exec playwright test e2e/api-gateway-analytics.uat.ts
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
Pages hidden by feature flag; FinOps/chargeback sections are additive and removable; no data changes, no bicep.

## Docs to update
`docs/fiab/admin/api-management.md` (analytics), `docs/fiab/parity/apim-ai-gateway.md` (W4 rows), `docs/fiab/parity/apim-service.md` (rows 86, 163, 164).

## Wave / Blocked-by / Branch / Worktree
Wave: 6 · Blocked-by: apigw-W04b-diagnostics-rollup-job, apigw-W04a-cost-centers-pricing, apigw-W03c-requests-marketplace · Branch: feat/apigw-w04c · Worktree: E:/Repos/_apigw-w04c

## Hot files
`app/admin/finops/page.tsx` (apigw-W05 adds one list after this), `app/admin/chargeback/page.tsx`, the three chained docs.
`touches_bicep: no`

## Kickoff prompt
```
Read PRPs/active/loom-api-gateway-plane/apigw-W04c-analytics-verifier.md, ADR-007, TEST-STRATEGY.md sections 3-4.
Goal: Analytics, chargeback sections, user Usage & cost, telemetry probe + docs (W4-5, W4-6). apigw-W04b, W04a, W03c merged first.
Edit only files under Owns. Worktree E:/Repos/_apigw-w04c, branch feat/apigw-w04c.
Proof: vitest on analytics + usage routes; make validate-typescript; telemetry-probe.mjs Commercial + Gov via Actions; Playwright api-gateway-analytics.uat.ts.
Report merged-not-deployed.
```

## Execution state
| Item | Status | Branch | Model | Evidence | Updated |
|---|---|---|---|---|---|
| W4-5 analytics + chargeback | todo | | sonnet | | 2026-11-14 |
| W4-6 verifier, docs, receipts | todo | | sonnet | | 2026-11-14 |
