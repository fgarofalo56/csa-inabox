---
name: apigw-W05-budgets-notifications
status: backlog
priority: P1
order: 32
depends_on: [apigw-W01b-close-gaps, apigw-W04b-diagnostics-rollup-job, apigw-W04c-analytics-verifier, apigw-W03b-governed-renderer-keys]
review: required
orchestrator_model: sonnet
implementer_model: sonnet
created: 2026-10-28
---

# PRP: W5 - Budgets with gateway enforcement; notification engine

Hub: `PRPs/active/loom-api-gateway-plane/PRP.md`. Shared context (read only the cited part): `PRPs/active/loom-api-gateway-plane/ARCHITECTURE.md`, `TEST-STRATEGY.md`, and the ADRs named below. Rules: no-vaporware, no-fabric-dependency, cloud-parity, auto-bind-by-default, deploy-integrity, ux-baseline (G1/G2/G3), assertion-design (`.claude/rules/`).

## Goal
A cost center monthly budget warns at 80 % and 100 % and may block calls at every managed gateway through one named value; the organization budget warns; people and administrators receive in-app, email (Graph) and Teams notifications according to separate preferences, with delivery evidence. ADR-006 (budgets).

## Why
Closes the cost-control loop on top of rollups (apigw-W04b), analytics pages (apigw-W04c) and the governed fragment's budget list check (apigw-W03b W3-4). `review: required` for the named-value gateway write and the mail/Teams credentials. Five items is the session ceiling; this PRP was already five items and is kept whole.

## Scope / Non-goals
**Scope:** items W5-1 (budget entity + evaluate), W5-2 (gateway enforcement), W5-3 (notification engine), W5-4 (channels), W5-5 (docs, G1, receipts).

**Non-goals:**
- No personal Teams bot (deferred, D12; stated in the UI).
- No rollup or diagnostics changes (apigw-W04b).
- Org budget never blocks: `block` returns 422.
- No bicep.

## Acceptance criteria
Each criterion names the value or output that would make it fail.
- [ ] `evaluate()` mutation receipt (`TEST-STRATEGY.md` section 1) goes RED in a sandbox copy; each threshold fires once per month, re-arms only on raise, resets on a new month.
- [ ] Budget spend equals `costCenterSpend` for the same month on a fixture; an all-unpriced month changes nothing; value that breaks it: a differing amount, or unpriced tokens counted.
- [ ] `blockListValue` receipt: 12-hex SHA-256 prefixes, 4,096 cap dropping the newest with a reported count; value that breaks it: a 4,097th entry or a silent drop.
- [ ] The named-value writer writes only if the value differs; value that breaks it: a recorded write for an identical value.
- [ ] Live Commercial: a forced block returns 403 `r=budget` within 30 minutes with trace `loom-deny v=1 r=budget` and the named value equals the computed list; a hand-edited value returns 503 `r=budget-list`; a raised budget unblocks; value that breaks it: any other status or an unchanged block list.
- [ ] Replaying a notification source creates no second logical event (deterministic ids); a partial-audience failure commits safe targets and checkpoints the rest; admin and user preference writes do not overwrite each other.
- [ ] The Graph mail request for a budget email never contains a caller identity, paired with cost center and amounts present; value that breaks it: a user principal in the body.
- [ ] A Teams webhook host outside the allowlist is refused; readiness distinguishes saved, checked, accepted, delivered, read.
- [ ] GCC-High: budget probe run id through Actions (named-value write + 403), Graph mail in Government recorded as measured (accepted, or the gate with reason). Every email/Teams claim has a provider acceptance id in the receipt.

## Read first
- `adr/ADR-006-cost-centers-per-workspace-and-budgets.md`; `OPERATOR-DECISIONS-2026-10-28.md` and `-29.md` (Q11 mailbox, Q12 Teams allowlist, D12); `TEST-STRATEGY.md` sections 1 and 3.
- `apps/fiab-console/lib/api-gateway/policy/access.ts` (apigw-W03b budget list check and `loom-blocked-cost-centers` named value) and `lib/api-gateway/plan/registry.ts` (apigw-W02a step registry).
- `apps/fiab-console/lib/api-gateway/telemetry/` (apigw-W04b) and `e2e/run-apiplane-worker.mjs`.
- `apps/fiab-console/lib/api-gateway/cost-centers/` (apigw-W04a), `app/admin/finops/page.tsx` (apigw-W04c section just added) and the existing `notificationsContainer` accessor in `lib/azure/cosmos-client.ts`.
- `lib/gates/registry/api-gateway.ts` (apigw-W03a gate pattern), `docs/fiab/v3-tenant-bootstrap.md`.

## Owns
Exact repo-relative paths:
- `apps/fiab-console/lib/api-gateway/budgets/**`
- `apps/fiab-console/app/api/admin/api-gateway/cost-centers/[id]/budget/**`
- `apps/fiab-console/app/api/admin/api-gateway/budget/**`
- `apps/fiab-console/app/admin/api-gateway/cost-centers/[id]/budget/**`
- `apps/fiab-console/app/admin/finops/page.tsx`
- `apps/fiab-console/lib/api-gateway/plan/steps/ensure-block-list.ts`
- `apps/fiab-console/e2e/run-apiplane-worker.mjs`
- `apps/fiab-console/app/api/internal/api-gateway/budgets/route.ts`
- `apps/fiab-console/app/api/internal/api-gateway/notify/route.ts`
- `scripts/measure/apiplane/budget-probe.mjs`
- `apps/fiab-console/lib/api-gateway/notify/**`
- `apps/fiab-console/app/api/admin/api-gateway/notifications/**`
- `apps/fiab-console/app/api/me/api-gateway/notifications/**`
- `apps/fiab-console/app/api/me/api-gateway/preferences/**`
- `apps/fiab-console/app/notifications/preferences/page.tsx`
- `apps/fiab-console/app/admin/api-gateway/settings/notifications/**`
- `apps/fiab-console/lib/gates/registry/api-gateway.ts`
- `docs/fiab/v3-tenant-bootstrap.md`
- `apps/fiab-console/e2e/api-gateway-budgets.uat.ts`
- `docs/fiab/admin/api-management.md`
- `docs/fiab/parity/apim-ai-gateway.md`

## Must NOT touch
- `lib/api-gateway/policy/access.ts` and `plan/governed-access.ts` (apigw-W03b): the fragment check is already rendered; only exercise it.
- `lib/api-gateway/plan/{plan,digest,apply,rollback,lease,recovery,registry}.ts` (apigw-W02a): register the ensure-block-list step through the registry.
- `lib/api-gateway/telemetry/**` (apigw-W04b).
- Any `platform/fiab/bicep/**` file.
- Anything owned by another PRP in this program, including the lane files `apigw-W06*`, `apigw-W07*`, `apigw-W08*`, `apigw-W09*` and the hub `PRP.md`.

## Consumes
- apigw-W04b-diagnostics-rollup-job (rollups, worker entry).
- apigw-W04c-analytics-verifier (FinOps page, docs chain).
- apigw-W03b-governed-renderer-keys (budget list check in the fragment, snapshot).
- Transitively apigw-W03a (gate file) and apigw-W04a (cost centers).

## Provides
- Budget entity, `evaluate()`, block-list writer and notification engine consumed by apigw-W09 approvals and by later notification categories.
- Gates `api-gateway.mailbox`.

## Steps
1. W5-1: budget entity (cost center: amount, thresholds 1-1,000 default 80/100, email owners toggle, <= 20 addresses, action continue/block; organization: warn only, `block` -> 422), spend from current-month grant summaries matching cost-center spend exactly, unattributed and idle PTU to the organization only, unpriced tokens reported not counted, forecast; pure `evaluate()`; `budgetState` etag writes; schedule (each cycle after rollup, month start, after save, 5-minute fast path at >= 90 %); budget UI on the cost-center page and a FinOps list beside Consumption budgets.
2. W5-2: `blockListValue()`; named-value writer (read, write only if different, audited `blockedCostCentersUpdated`, retry failed gateways); plan step ensure `loom-blocked-cost-centers` (create if missing, never overwrite; unpublish/rollback/recovery never delete); worker budgets phase and internal `budgets` route; `budget-probe.mjs`.
3. W5-3: notification engine: source events committed with their mutation, routing (tenant channel constraints -> audience eligibility -> personal opt-in), in-app via the `notificationsContainer` shape, deliveries/attempts/digests/checkpoints in `apiplane-notify`, bounded retries, `unknownOutcome` visible, partial-audience handling, dead letters, admin delivery router, separate admin and user preference stores; worker notify phase and internal `notify` route.
4. W5-4: Graph email through the Console UAMI with mailbox-scoped Exchange Application RBAC (gate `api-gateway.mailbox` naming the tenant step, Q11) with Send test email (<= 1/30 s); budget emails naming cost center, month, spend, budget, next step, gateway counts, never who spent; Teams Workflows (webhook URL in the env vault; deployment-controlled host allowlist, Q12); readiness views; personal Teams bot deferred (D12) and stated in the UI.
5. W5-5: docs, G1 walk (budget set -> threshold email -> block -> unblock on Commercial), GCC-High budget probe through Actions, parity rows.
6. Mutation arms for `evaluate` and `blockListValue` in a sandbox copy.

## Validation
```bash
pnpm --dir apps/fiab-console vitest run lib/api-gateway/budgets lib/api-gateway/notify app/api/admin/api-gateway app/api/me/api-gateway
make validate-typescript
node scripts/measure/apiplane/budget-probe.mjs   # Commercial; Gov via Actions
pnpm --dir apps/fiab-console exec playwright test e2e/api-gateway-budgets.uat.ts
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
`planeSettings.budgetsEnabled=false`: budgets stored but not judged, on-demand checks refused, stale lists block nothing after the next cycle rewrites `-`; notification worker phase disabled; named values retained. No bicep to revert.

## Docs to update
`docs/fiab/admin/api-management.md` (budgets and notifications), `docs/fiab/parity/apim-ai-gateway.md`, `docs/fiab/v3-tenant-bootstrap.md` (mailbox section).

## Wave / Blocked-by / Branch / Worktree
Wave: 7 · Blocked-by: apigw-W01b-close-gaps, apigw-W04b-diagnostics-rollup-job, apigw-W04c-analytics-verifier, apigw-W03b-governed-renderer-keys · Branch: feat/apigw-w05 · Worktree: E:/Repos/_apigw-w05

## Hot files
`lib/gates/registry/api-gateway.ts` (one gate; earlier edited by apigw-W03a), `e2e/run-apiplane-worker.mjs` (created by apigw-W04b), `app/admin/finops/page.tsx` (after apigw-W04c), the chained docs and `docs/fiab/v3-tenant-bootstrap.md` (after apigw-W03a).
`touches_bicep: no`

## Kickoff prompt
```
Read PRPs/active/loom-api-gateway-plane/apigw-W05-budgets-notifications.md, ADR-006, OPERATOR-DECISIONS-2026-10-28.md (Q11, Q12, D12), TEST-STRATEGY.md section 1.
Goal: budgets with gateway block-list enforcement, notification engine, email/Teams channels (W5-1..W5-5). apigw-W04b, W04c, W03b merged first.
Edit only files under Owns. Worktree E:/Repos/_apigw-w05, branch feat/apigw-w05.
Proof: vitest on budgets + notify + routes; make validate-typescript; budget-probe.mjs Commercial (403 r=budget) + Gov via Actions; Playwright api-gateway-budgets.uat.ts.
Report merged-not-deployed; every email/Teams claim needs a provider acceptance id.
```

## Execution state
| Item | Status | Branch | Model | Evidence | Updated |
|---|---|---|---|---|---|
| W5-1 budget entity + evaluate | todo | | sonnet | | 2026-11-14 |
| W5-2 gateway enforcement | todo | | sonnet | | 2026-11-14 |
| W5-3 notification engine | todo | | sonnet | | 2026-11-14 |
| W5-4 channels | todo | | sonnet | | 2026-11-14 |
| W5-5 docs, G1, receipts | todo | | sonnet | | 2026-11-14 |
