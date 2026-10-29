---
name: apigw-W04-cost-centers-usage-pricing
status: backlog
priority: P1
order: 25
depends_on: [apigw-W01-gateway-registry-observe]
review: none
orchestrator_model: sonnet
implementer_model: sonnet
created: 2026-10-28
---
# W4 — Cost centers, measured usage, pricing, chargeback

**Goal**: every workspace has a cost center on day one; the worker folds
gateway logs into rollups every 15 minutes; usage is attributed, priced from a
dated price list and shown by caller, application, grant, model, deployment,
API and cost center; chargeback joins the FinOps pages; each person sees only
their own usage. ADR-006 (cost centers), ADR-007. No reviewed gateway writes
here beyond diagnostics enablement (disclosed). Items from W4-3 onward need
W3-4's traces to attribute governed calls; adopted APIs attribute by
subscription before that.

## Items

| ID | Title | Owns | Depends on | Model | Review | Verify |
|---|---|---|---|---|---|---|
| W4-1 | Cost centers: entity (`code` rules, `general` built-in, owners, members, keys-allowed, per-person defaults, pooled quotas), tenant default setting, membership rules and revocation on removal with **Recheck pending**, deletion blockers (409 reasons), resolution function shared with W3-4; **auto-bind**: workspace provisioner creates the center (`code` = slug, deterministic dedupe, owners = workspace admins), backfill job for existing workspaces; Cost centers pages (list, detail with Members, New) | `lib/api-gateway/cost-centers/**`, `app/api/admin/api-gateway/cost-centers/**`, `app/admin/api-gateway/cost-centers/**`, `lib/install/provisioners/workspace*.ts` (one hook call), `apps/fiab-console/e2e/run-apiplane-backfill-cost-centers.mjs` (new, one-shot) | none | Sonnet | none | create a workspace → its cost center exists with the matching code and no user step (auto-bind receipt); `resolveCostCenter` mutation receipt; deleting `general` → 409 `builtIn` |
| W4-2 | Diagnostics writer and Telemetry card: `azuremonitor` logger ensure; per-API diagnostic on plane-published APIs (100 %, Information, no client IP/headers/bodies, LLM logs on with 0 prompt/completion bytes, 400 on LLM logging → apply without and report), never on adopted APIs, never diagnostic settings; Telemetry card five checks (logger, routing incl. `AzureDiagnostics` rejection, read access last 24 h, API diagnostics readiness list, rollups) with **Enable API diagnostics** (manage only, audited), **Refresh now** (≤ 1/min), **Backfill** (audited); `az` command for routing fixes | `lib/api-gateway/telemetry/diagnostics-writer.ts`, `lib/api-gateway/telemetry/readiness.ts`, `app/api/admin/api-gateway/gateways/[id]/telemetry/**`, Telemetry card component | W1 | Sonnet | none | diagnostics test: the written body has `sampling.percentage=100`, zero body bytes, no headers (paired with LLM logs enabled); an adopted API is never written (call recorder empty for it) |
| W4-3 | Rollup: KQL (`GatewayLogs ⋈ GatewayLlmLog` on `CorrelationId`; `TraceRecords` parse; validated inputs; sovereign endpoint from `cloud-endpoints.ts`), `parseAttributionTrace`, facts/summaries/registry/state writes (never lower a day; versioned state; sharding), windows halving, leases, freshness, backfill 1–730 days in 7-day slices; worker job: `apiplane-worker-job.bicep` (own deploy unit; cron `*/15`; Console UAMI; image `loom-uat`, `command: ['node','e2e/run-apiplane-worker.mjs']` calling `app/api/internal/api-gateway/{sync,rollup}` (new, internal-token guarded)) and the job entry running rollup now (budgets and notifications phases added in W5); env `LOOM_APIPLANE_USAGE_RETENTION_DAYS`, `LOOM_APIPLANE_ROLLUP_BACKFILL_MAX_DAYS` | `lib/api-gateway/telemetry/{kql,parser,rollup,freshness}.ts`, `apps/fiab-console/e2e/run-apiplane-worker.mjs` (new), `app/api/internal/api-gateway/{sync,rollup,budgets,notify}/route.ts` (new, internal-token guarded), `platform/fiab/bicep/modules/admin-plane/apiplane-worker-job.bicep` (new), orchestrator wiring (one module call or a sibling deployment per the headroom rule), `main.bicep` (two env vars) | W4-1, W3-4 (attribution of governed calls) | Sonnet | none (one bicep PR, queued) | `parseAttributionTrace` and `sweep`-style "never lower a day" receipts; a re-read that returns fewer calls leaves stored figures; job run on the Commercial estate shows `rollupState.lastSuccessAt` advancing; RU/day recorded in the receipt |
| W4-4 | Pricing: ported `model-prices.json` + schema with attribution header, `priceVersion` docs (never edited; effective dates; author; audit `pricing.priceRecorded`), `matchPrice` (precedence, ties, token vs PTU applicability), cost at read time (whole days; cached tokens at input rate; provisioned split by token share; idle months separate), cloud inference from host + admin override, Pricing page (Prices with date filter, Sources, Unpriced deployments with reasons, Clouds and endpoints), `scripts/csa-loom/price-seed.py` (`--check`, `--cache`, `--date`) | `lib/api-gateway/pricing/**`, `app/api/admin/api-gateway/pricing/**`, `app/admin/api-gateway/pricing/**`, `scripts/csa-loom/price-seed.py` (new), third-party notices (MIT) | none | Sonnet | none | `matchPrice` mutation receipt; schema test: every seed price cites a listed source; "No price" rendered for an unknown deployment type (paired with a priced row) |
| W4-5 | Analytics and chargeback: Overview (gateway health table, cost-center ranking), Cost (total, trend, by model/deployment/caller/API/cost center, month spend, forecast), Consumers (people, applications, groups, cost centers; on-behalf section arrives in W6), Limits (near/reached/unknown, partial window), Reliability (outcomes, deployments, gateway-throttled vs backend 429), Unattributed (reasons), Access hygiene (unused grants/keys, untracked grants, fixed 30 days); Filters with Apply/Cancel; Graph name lookups ≤ 200 cached 1 h; CSV (10,000 rows, BOM, formula guard, `loom-<view>-<from>-<to>.csv`); Dashboard cards; Admin → Chargeback and FinOps **Model usage** sections; chargeback CSV columns; user **Usage & cost** page (Overview, Resources, Breakdowns with cost centers and pooled quotas) | `app/api/admin/api-gateway/analytics/**`, `app/admin/api-gateway/analytics/**`, `app/admin/api-gateway/page.tsx` (cards), `app/admin/chargeback/page.tsx` and `app/admin/finops/page.tsx` (one section each), `app/api/me/api-gateway/usage/**`, `app/marketplace/usage/page.tsx` (new), `lib/components/finops/**` (new components only) | W4-3, W4-4 | Sonnet | none (G1 walk) | route tests: without rollups → `notConfigured` with empty reports, never samples; cost column hidden when no row has a cost; a user's usage route never returns another caller's identity (paired with their own rows present); Playwright walk with screenshots |
| W4-6 | Verifier, docs and receipts: `telemetry-probe.mjs`; docs (`api-management.md` analytics section; `apim-service.md` rows 86, 163, 164 flipped; `apim-ai-gateway.md` W4 rows); Commercial: one governed call attributed within one interval; GCC-High: probe through Actions per W0-1's outcome, or the declared gap | `scripts/measure/apiplane/telemetry-probe.mjs` (new), docs listed, `e2e/api-gateway-analytics.uat.ts` (new) | W4-1..W4-5 | Sonnet | none | run ids; freshness "Current" on the estate; parity rows flipped |

Lanes: L1 = W4-1; L2 = W4-2 → W4-3; L3 = W4-4; W4-5 after W4-3, W4-4;
W4-6 last. Bicep: W4-3 only.

## Done receipt (per cloud)

Commercial: cost center auto-created for a new workspace; a governed call
appears in Analytics with caller, grant, model, cost center and a price within
one interval; CSV exported; chargeback section shows the month's model cost;
RU/day recorded. GCC-High: telemetry probe run id (tables present or the
declared gap with substitute).

## Rollback

Job disabled (`LOOM_APIPLANE_ENABLED=false` short-circuits the entry);
containers retained; diagnostics on published APIs left in place (harmless;
removed by unpublish).

## Cost / credit estimate

~14 Sonnet sessions; Azure: Log Analytics queries per cycle, Cosmos RU
(measured), Container Apps Job minutes.

## Execution state

| Item | Status | Branch | Model | Evidence | Updated |
|---|---|---|---|---|---|
| W4-1 | todo | | sonnet | | 2026-10-28 |
| W4-2 | todo | | sonnet | | 2026-10-28 |
| W4-3 | todo | | sonnet | | 2026-10-28 |
| W4-4 | todo | | sonnet | | 2026-10-28 |
| W4-5 | todo | | sonnet | | 2026-10-28 |
| W4-6 | todo | | sonnet | | 2026-10-28 |
