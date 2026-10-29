---
name: apigw-W05-budgets-notifications
status: backlog
priority: P1
order: 26
depends_on: [apigw-W04-cost-centers-usage-pricing]
review: required
orchestrator_model: sonnet
implementer_model: sonnet
created: 2026-10-28
---
# W5 — Budgets with gateway enforcement; notification engine

**Goal**: a cost center's monthly budget warns at 80 % and 100 % and may block
calls at every managed gateway through one named value; the organization
budget warns; people and administrators receive in-app, email (Graph) and
Teams notifications according to separate preferences, with delivery
evidence. ADR-006 (budgets). `review: required` (the named-value gateway
write and the mail/Teams credentials).

## Items

| ID | Title | Owns | Depends on | Model | Review | Verify |
|---|---|---|---|---|---|---|
| W5-1 | Budget entity (cost center: amount, thresholds 1–1,000 default 80/100, email owners toggle, ≤ 20 addresses, action continue/block; organization: warn only, `block` → 422), spend from current-month grant summaries matching cost-center spend exactly, unattributed and idle PTU to the organization only, unpriced tokens reported not counted, forecast; `evaluate()` pure function (once per month per threshold; re-arm only on raise; new month resets); `budgetState` etag writes; schedule (each cycle after rollup, month start, after save, 5-min fast path ≥ 90 %); budget UI on the cost center page and FinOps listing beside Consumption budgets | `lib/api-gateway/budgets/{entity,evaluate,state,spend}.ts`, `app/api/admin/api-gateway/cost-centers/[id]/budget/**`, `app/api/admin/api-gateway/budget/**` (org), UI under `app/admin/api-gateway/cost-centers/**`, `app/admin/finops/page.tsx` (one list) | none | Sonnet | **required** | `evaluate()` mutation receipt (`TEST-STRATEGY.md` § 1); spend test: budget spend equals `costCenterSpend` for the same month on a fixture; an all-unpriced month changes nothing |
| W5-2 | Gateway enforcement: `blockListValue()` (12-hex SHA-256 prefixes, `-`, 4,096 cap dropping the newest with a reported count), named-value writer (read, write only if different, audited `blockedCostCentersUpdated`, retry failed gateways), plan step "ensure `loom-blocked-cost-centers`" (create if missing, never overwrite; unpublish/rollback/recovery never delete), worker budgets phase; the fragment check already rendered in W3-4 is exercised live; `budget-probe.mjs` | `lib/api-gateway/budgets/{block-list,named-value}.ts`, `lib/api-gateway/plan/steps/ensure-block-list.ts`, `apps/fiab-console/e2e/run-apiplane-worker.mjs` (budgets phase), `scripts/measure/apiplane/budget-probe.mjs` (new) | W5-1 | Sonnet | **required** (gateway write) | `blockListValue` receipt; writer test: identical value → no write recorded; live Commercial: forced block → 403 `r=budget` within 30 min, trace `loom-deny v=1 r=budget`, named value equals the computed list; a hand-edited value → 503 `r=budget-list`; raise → unblock |
| W5-3 | Notification engine: source events committed with their mutation (threshold, block/unblock after a gateway write attempt, capability failure/recovery, environment finding/recovery, access request submitted/decided), routing (tenant channel constraints → audience eligibility → personal opt-in), in-app via the existing `notificationsContainer` shape, deliveries/attempts/digests/checkpoints in `apiplane-notify`, retries with bounded backoff, `unknownOutcome` kept visible, partial-audience handling, dead letters, admin delivery router (history, audited retries, channel health), administrator preferences (channels, cadence, digests) and user preferences (per-category channels, daily/weekly/monthly schedules, quiet hours, threshold reminders) with separate stores; worker notifications phase | `lib/api-gateway/notify/**`, `app/api/admin/api-gateway/notifications/**`, `app/api/me/api-gateway/{notifications,preferences}/**`, `app/notifications/preferences/page.tsx` (new), `app/admin/api-gateway/settings/notifications/**`, `apps/fiab-console/e2e/run-apiplane-worker.mjs` (notify phase) | W5-1 | Sonnet | none | replay test: reprocessing a source creates no second logical event (deterministic ids); a partial-audience failure commits safe targets and checkpoints the rest; preferences test: admin and user writes do not overwrite each other |
| W5-4 | Channels: Graph email through the Console UAMI with mailbox-scoped Exchange Application RBAC (gate `api-gateway.mailbox` naming the tenant step, Q11), **Send test email** (≤ 1/30 s, works while disabled), budget emails naming cost center, month, spend, budget, next step and gateway counts, never who spent; Teams Workflows (shared destinations; webhook URL in the env vault; deployment-controlled host allowlist, Q12); readiness views for health, email, shared Teams; personal Teams bot **deferred** (D12) and stated in the UI | `lib/api-gateway/notify/{graph-mail,teams-workflows}.ts`, `lib/gates/registry/api-gateway.ts` (one gate), settings UI, `docs/fiab/v3-tenant-bootstrap.md` (mailbox section) | W5-3 | Sonnet | **required** (credentials) | mail test: the Graph request body never contains a caller identity for budget emails (paired with: cost center and amounts present); a webhook host outside the allowlist is refused; readiness distinguishes saved, checked, accepted, delivered, read |
| W5-5 | Docs, G1 walk, receipts: budget set → threshold email → block → unblock on Commercial; GCC-High: budget probe through Actions on the Gov gateway (named-value write + 403); Graph mail in Government recorded as measured | `docs/fiab/admin/api-management.md` (budgets + notifications), `docs/fiab/parity/apim-ai-gateway.md`, `e2e/api-gateway-budgets.uat.ts` (new) | W5-1..W5-4 | Sonnet | none (G1 walk) | run ids; screenshots; every email/Teams claim backed by a provider acceptance id in the receipt |

Lanes: L1 = W5-1 → W5-2; L2 = W5-3 → W5-4; W5-5 last. No bicep.

## Done receipt (per cloud)

Commercial: block and unblock observed with latency recorded; emails
accepted by Graph; Teams Workflows accepted; preferences honoured. GCC-High:
budget probe run id; Graph mail measured (accepted, or the gate with reason).

## Rollback

Budgets disabled (`planeSettings.budgetsEnabled=false`): stored but not
judged, on-demand checks refused, stale lists block nothing after the next
cycle rewrites `-`; notification worker phase disabled; named values retained.

## Cost / credit estimate

~10 Sonnet sessions.

## Execution state

| Item | Status | Branch | Model | Evidence | Updated |
|---|---|---|---|---|---|
| W5-1 | todo | | sonnet | | 2026-10-28 |
| W5-2 | todo | | sonnet | | 2026-10-28 |
| W5-3 | todo | | sonnet | | 2026-10-28 |
| W5-4 | todo | | sonnet | | 2026-10-28 |
| W5-5 | todo | | sonnet | | 2026-10-28 |
