---
name: apigw-W07-model-pools-deployments
status: backlog
priority: P1
order: 28
depends_on: [apigw-W02-publishing-plan-apply]
review: required
orchestrator_model: sonnet
implementer_model: sonnet
created: 2026-10-28
---
# W7 — Model pools, reviewed model deployment, adoption of the day-one gateway

**Goal**: one governed URL per vendor and shape serves a model from many
deployments across regions with PTU-first or balanced routing and health;
administrators create Azure model deployments through a reviewed, quota-checked
flow; the bicep-authored day-one gateway (#4442) is adopted into the plane and
Loom's own Copilot traffic becomes a governed principal. ADR-002, ADR-005,
ADR-007. `review: required` (gateway writes, Azure deployment writes).
**W7-5 depends on #4442 Waves A and B1 being merged** (external edge).

## Items

| ID | Title | Owns | Depends on | Model | Review | Verify |
|---|---|---|---|---|---|---|
| W7-1 | Pools: `modelPool`, pool models (public name immutable once published), members (same model and format; version mismatch acknowledged; readiness gate; same auth per backend pool; ≤ 30 per backend pool; drain), pool types breaker / preferential / linear with presets (throttling: trip on one 429, open `Retry-After` or 10 s; throttling and errors: three 429/5xx per minute, 30 s), cascading statuses, retries (`first-fast-retry`, buffered request, unbuffered response, ≤ 3 or once-per-member; ≤ 10 attempts), capacity types from SKU (provisioned / pay-as-you-go / batch excluded / unknown), processing-scope warnings, stateless-only operations, Consumption tier linear only; plan/apply writes (member backends, backend pools, `loom-pool-<slug>` fragment, API with retry/outbound sections, product, link, bootstrap subscription; deletes reverse); `apim-client.ts` pool and circuit-breaker bodies; Pools workbench (Overview, Models and deployments, Access and connection) | `lib/api-gateway/pools/**`, `lib/api-gateway/policy/pool.ts`, `lib/api-gateway/plan/pool.ts`, `app/api/admin/api-gateway/pools/**`, `app/admin/api-gateway/pools/**`, `lib/azure/apim-client.ts` (pool bodies) | none | Sonnet | **required** | renderer test: outbound strips member-identifying headers and keeps `Retry-After`; a linear pool with 11 members is refused; a batch deployment cannot be a member; live Commercial: a two-member preferential pool with the primary forced to 429 serves from the secondary (`pool-probe.mjs`) |
| W7-2 | Health, drift, suggestions: `loom-attempt v=1` traces per attempt (no bodies, headers or query strings), health endpoint 1–168 h with per-model and per-member outcomes and breaker-trip estimates, statuses `notConfigured`/`notPublished`/`noData`/`accessDenied`/`error`; drift digests of API policy and fragment; offered-twice warning; suggested pools (same model on ≥ 2 usable endpoints per gateway, vendor, shape) with **Create pool**; Dashboard Pools panel; `pool-probe.mjs` | `lib/api-gateway/pools/{health,suggest}.ts`, `lib/api-gateway/telemetry/attempts.ts`, Pools **Health** and **Suggestions** tabs, `app/admin/api-gateway/page.tsx` (panel), `scripts/measure/apiplane/pool-probe.mjs` (new) | W7-1 | Sonnet | none | health test: no traces → `noData`, never zeros; a suggestion requires two endpoints (one endpoint → none); probe shows two attempts and the final 429 keeps `Retry-After` and names no member |
| W7-3 | Access per pool model: grants on `poolModel` resources under a cost center; one key per subject × pool × cost center serving every held model; apply suspends/reactivates/deletes keys per grant state; authorization order (authenticate → cost-center header → resolve model → choose grant → budget → trace and limits → strip and route); refusals `model` and `no-grant` identical 403; per-member pricing in the rollup (backend id → host+path → host → deployment; shared host never by deployment alone; unplaceable stays unpriced); marketplace rows show display name, environment, API style, capacity badge (admin may hide) | `lib/api-gateway/entitlements/{grants,keys}.ts` (pool branches), `lib/api-gateway/policy/pool.ts` (access section), `lib/api-gateway/telemetry/rollup.ts` (member placement), `app/marketplace/**` (badge) | W7-1, W3 | Sonnet | **required** | placement test: a host shared by two members is never matched by deployment alone (unpriced, reported); key test: revoking one model's grant keeps the key until every grant it serves is revoked |
| W7-4 | Reviewed Azure model deployment (Mosaic ADR 0028): per-endpoint `managementMode: manage` opt-in requiring account-scoped deployment permissions; live catalogue (format, name, version, publisher, SKUs Azure returns); quota by `usageName` (never guessed or ×1,000); provisioned SKUs need verified capacity; validations (capacity bounds, lifecycle, RAI policy list or Azure default with warning, version upgrade option, name availability); **Deploy model** workspace with explicit opt-in, configuration, review, **Deploy to Azure**, persisted result; re-check before PUT; attempt recorded before PUT; durable account-and-cloud lock; 201 without polling headers is not success; read until terminal and matching; never replay an uncertain PUT; never delete as rollback; reconciliation and inventory-refresh retry; deployment never publishes, grants or adds a pool member | `lib/api-gateway/deployments/**`, `app/api/admin/api-gateway/endpoints/[id]/deployments/**`, Endpoints → **Deploy model** flow, `lib/azure/foundry-client.ts` (accounts/deployments PUT `2024-10-01`, usages read) | W2-3 | Sonnet | **required** (Azure writes) | tests: an uncertain PUT outcome keeps the lock and refuses a second PUT; a terminal resource differing from the plan → failed, lock released, Azure untouched; quota `usageName` mismatch blocks apply; live Commercial deployment of a small model on the estate's Foundry account, then its removal by the operator (the plane never deletes) |
| W7-5 | Adopt the day-one gateway (D14, Q10, Q16): a reviewed "adopt into plane" apply that takes ownership of the bicep-authored `aoaiPool` / `aoaiBackends` / policy as a plane pool publication (ownership recorded from `apim.bicep` outputs, digest compared first), bicep flips `loomBackends.aoaiGateway` to `'plane'` so bicep stops authoring those resources (one bicep PR; `LOOM_AOAI_VIA_APIM` / `LOOM_AOAI_APIM_URL` untouched); console identity registered as a `managedIdentity` principal with an application grant on the pool model under the `platform` cost center; `aoai-apim-gateway.ts` attaches nothing new (managed identity already) — attribution appears in Analytics | `lib/api-gateway/pools/adopt-deploy-owned.ts`, `app/api/admin/api-gateway/pools/adopt/**`, `platform/fiab/bicep/modules/admin-plane/{apim,main}.bicep` (`'plane'` mode branch), `params/*.bicepparam` (none unless a boundary opts out), `docs/fiab/model-strategy.md` | W7-1, W7-3, #4442 Waves A + B1 merged | Sonnet | **required** | adopt refuses when the live digest differs from the bicep-authored expectation; after adoption a bicep what-if shows no change to the pool resources; Loom Copilot turns appear under `platform` within one interval on the Commercial estate |
| W7-6 | Docs, parity (row 134 pools/circuit breaker; `apim-ai-gateway.md` § 5 and § 8 pools), G1 walk, receipts (Commercial pool probe; GCC-High pool on the Gov gateway through Actions, or the measured limitation) | docs listed, `e2e/api-gateway-pools.uat.ts` (new) | W7-1..W7-5 | Sonnet | none (G1 walk) | run ids; screenshots; `model-strategy.md` names the plane as the owner of model access |

Lanes: L1 = W7-1 → W7-2 → W7-3; L2 = W7-4 (after W2-3); W7-5 after W7-3
and #4442 A/B1; W7-6 last. Bicep: W7-5 only.

## Done receipt (per cloud)

Commercial: pool failover observed; health and suggestions populated; a
reviewed deployment created; day-one gateway adopted with bicep what-if clean;
platform usage attributed. GCC-High: pool probe run id or the measured
limitation.

## Rollback

Pools unpublished through reviewed plans; `loomBackends.aoaiGateway` set back
to `'apim'` re-enables bicep authoring (the plane then shows the resources as
deploy-owned again); deployments created by the flow are left for the
operator (the plane never deletes).

## Cost / credit estimate

~12 Sonnet sessions; Azure: one small model deployment during the receipt
(removed by the operator), scratch pool resources.

## Execution state

| Item | Status | Branch | Model | Evidence | Updated |
|---|---|---|---|---|---|
| W7-1 | todo | | sonnet | | 2026-10-28 |
| W7-2 | todo | | sonnet | | 2026-10-28 |
| W7-3 | todo | | sonnet | | 2026-10-28 |
| W7-4 | todo | | sonnet | | 2026-10-28 |
| W7-5 | todo | | sonnet | | 2026-10-28 |
| W7-6 | todo | | sonnet | | 2026-10-28 |
