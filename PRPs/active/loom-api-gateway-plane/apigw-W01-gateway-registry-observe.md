---
name: apigw-W01-gateway-registry-observe
status: active
started: 2026-10-30
branch: feat/apigw-w01
priority: P1
order: 22
depends_on: [apigw-W00-measurement-spike]
review: none
orchestrator_model: sonnet
implementer_model: sonnet
created: 2026-10-28
---
# W1 — Gateway registry, observe mode, environments, hub shell

**Goal**: any API Management instance the Console UAMI can read becomes a
registered gateway with preflight, inventory, policy facets, telemetry
readiness and an environment, in **observe** mode; the deploy's own APIM
registers itself; the existing eight admin panes move under Gateways →
Manage; the admin hub exists. No gateway writes in this wave except the
Monitoring Reader role the deploy grants. Plane administration is scoped
from day one through the `apiplane-admin` capability (Q9, 2026-10-29).
ADR-001, ADR-003 (facets), ADR-004 (administration), ADR-008 (catalog), ADR-010.

## Items

| ID | Title | Owns | Depends on | Model | Review | Verify |
|---|---|---|---|---|---|---|
| W1-1 | Five `apiplane-*` containers (lazy `createIfNotExists` accessors + landing-zone bicep declaration), shared types, audit kinds helper, in-memory repositories for tests | `apps/fiab-console/lib/azure/cosmos-client.ts` (accessors only), `lib/api-gateway/types.ts`, `lib/api-gateway/audit.ts`, `lib/api-gateway/__tests__/repos/**`, `platform/fiab/bicep/modules/landing-zone/cosmos.bicep` (five container entries) | none | Sonnet | none | accessor test: each container resolves with PK `/tenantId`; bicep `build-params` on every boundary param |
| W1-2 | Gateway registry: `gateway` record, preflight (effective permissions at the service scope with probe fallback, `canWrite`, missing-role remediation naming role definition id, scope and the `az` command, principal from the ARM token `oid`), register/list/remove routes, auto-registration of the deploy-owned gateway from `LOOM_APIPLANE_DEPLOY_GATEWAY_ID` on first admin load; bicep: `apim.bicep` outputs `apimResourceId`, `aoaiPoolName`, `aoaiBackendNames`; Monitoring Reader for the Console UAMI at the service scope; `GatewayLlmLogs` diagnostic category behind `apiplaneLlmLogs` per boundary param (values from W0-9); env vars `LOOM_APIPLANE_ENABLED`, `LOOM_APIPLANE_DEPLOY_GATEWAY_ID` | `lib/api-gateway/registry/**`, `app/api/admin/api-gateway/gateways/**`, `platform/fiab/bicep/modules/admin-plane/apim.bicep` (outputs, role, diag category), `modules/admin-plane/main.bicep` (two env vars), `params/*.bicepparam` (one param each; **not** `dlz-attach.bicepparam`) | W1-1 | Sonnet | none (one bicep PR, queued per § 5 of `PRP.md`) | route test: register with a resource id the double reports unreadable → `{ok:false}` with the exact role and command; deploy receipt: a fresh Commercial roll lists the deploy-owned gateway with `access.canRead=true` without any manual step |
| W1-3 | Inventory sync into `apiplane-observed` (APIs, operations, products, subscriptions, APIM users/groups, backends, named-value metadata, MCP servers via `2025-09-01-preview` with `unavailable` on rejection), deterministic ids, sweep with partial-type exemption, in-flight admission set, re-read gateway before writing; policy analysis (parse → digest + redacted facets; URLs lose query/fragment; externally authored elements counted); AI-surface and MCP detection with `selection: detected|manual`; `/api/apim/*` routes gain `?gateway=<id>` via `resolve-gateway.ts` (default = deploy-owned) | `lib/api-gateway/observe/**`, `lib/api-gateway/registry/resolve-gateway.ts`, `app/api/apim/**` (parameter plumbing only), `lib/azure/apim-client.ts` (read helpers for policy fragments list and MCP APIs list only) | W1-2 | Sonnet | none | `sweep` mutation receipt (`TEST-STRATEGY.md` § 1); facets test: a policy with `set-backend-service base-url="https://h/p?code=SECRET"` yields a facet host `h` and no `code=` anywhere in the stored document (paired with the positive facet assertion); Commercial receipt: inventory counts equal `az apim api list` counts |
| W1-4 | Environment catalog (seed D9), classification on gateway records, `permits()`, compatibility matrix route, batch re-classification route with lock order and audit per resource, tag suggestions from ARM responses, advisory findings (backend/API URLs vs registered endpoints — endpoints arrive in W2, so findings cover gateways × MCP servers now and extend in W2), Settings → Environments and Findings tabs | `lib/api-gateway/environments/**`, `app/api/admin/api-gateway/environments/**`, `app/admin/api-gateway/settings/**` | W1-1 | Sonnet | none | `permits()` mutation receipt; invariant test: re-classifying a gateway that would block an applied publication is refused with the publication listed (uses an in-memory applied publication) |
| W1-5 | Admin hub shell `/admin/api-gateway` (Overview, Gateways list + detail: Overview with Telemetry card showing only the checks that run today — logger, routing, read access — APIs and endpoints, Manage hosting the eight existing panes with `gatewayId`), nav entry, `/admin/api-management` and `/admin/mcp-servers` redirects, `error.tsx` + `loading.tsx`, LearnPopovers, Copilot entry, `SplitPane` where a list pairs with a detail | `app/admin/api-gateway/**` (new), `app/admin/api-management/page.tsx` (redirect), `lib/components/admin-shell.tsx` (nav), `lib/components/admin/apim-*-pane.tsx` (accept `gatewayId`; no behaviour change) | W1-2, W1-3 | Sonnet | none | Playwright: the eight panes render for the deploy-owned gateway with identical content to the old page; narrow-width pass; first-open of a newly registered gateway shows no error banner |
| W1-6 | Gates `api-gateway.gateway-role`, `api-gateway.monitoring-reader`, `api-gateway.llm-logs-unavailable` with Fix-its; readiness rows per boundary (declared gaps from W0-9); DESIGN.md content/state rules added to `docs/fiab/ux-standards.md` § 7 checklist | `lib/gates/registry/api-gateway.ts` (new), `lib/gates/registry/index.ts` (one import), `docs/fiab/ux-standards.md` (one subsection) | W1-2 | Sonnet | none | gate test: a double reporting a missing Monitoring Reader yields the gate with a `role-grant` Fix-it; the readiness page lists the gaps with owners |
| W1-7 | Docs and receipts: rewrite `docs/fiab/admin/api-management.md`; create `docs/fiab/parity/apim-ai-gateway.md` from `AZURE-PARITY-INVENTORY.md` with W1 rows flipped; brownfield receipt (register a second, pre-existing APIM through discovery — **offered**, not adopted); G1 walk Commercial; GCC-High: register the Gov APIM through Actions and quote inventory counts | `docs/fiab/admin/api-management.md`, `docs/fiab/parity/apim-ai-gateway.md` (new), `e2e/api-gateway-registry.uat.ts` (new), `scripts/measure/apiplane/registry-probe.mjs` (new) | W1-1..W1-6 | Sonnet | none (G1 walk) | screenshots dark + light; Gov run id; parity doc shows W1 rows ✅ and every other row ❌ or → W# |
| W1-8 | Scoped administration (Q9, 2026-10-29): an `apiplane-admin` capability declared in `lib/auth/feature-catalog.ts`, enforced by `withCapability` (`lib/api/route-toolkit.ts:254`) on every plane admin route from day one, assignable to an Entra group; tenant admins remain a superset; every audited write records the capability used; Settings → Runtime shows which group holds it and the remediation when none does | `lib/auth/feature-catalog.ts` (one capability), `app/api/admin/api-gateway/**` (wrapper), `lib/api/route-toolkit.ts` (only if a tenant-admin-superset helper is needed), `docs/fiab/admin/api-management.md` (one section) | W1-2 | Sonnet | none | route enumeration: every plane admin route refuses a session holding neither tenant admin nor the capability with a 403 that names the group to join; a session holding only the capability gets 200 on a read route and its write is audited with the capability name |

Lanes: L1 = W1-1 → W1-2 → W1-3; L2 = W1-4 (after W1-1); L3 = W1-5 (after
W1-3), W1-6 and W1-8 (after W1-2); W1-7 last. Bicep: W1-2 only.

## Done receipt (per cloud)

Commercial: deploy-owned gateway auto-registered; a second APIM discovered
and registered; inventory counts match `az`; facets contain no secrets; the
eight panes work under Manage; redirect works; gates render with Fix-its;
G1 walk attached. GCC-High: the same registry probe through Actions with run
id. Reported as "merged, not deployed" until the roll is verified.

## Rollback

`LOOM_APIPLANE_ENABLED=false` hides the hub and restores the old page as the
primary surface (the redirect checks the flag); containers retained;
Monitoring Reader grant harmless.

## Cost / credit estimate

~13 Sonnet sessions; Azure: Cosmos RU for observed state (recorded).

## Execution state

| Item | Status | Branch | Model | Evidence | Updated |
|---|---|---|---|---|---|
| W1-1 | merged | feat/apigw-w01-w1-1 | sonnet | vitest lib/api-gateway 12/12; mutation RED 2/12 in sandbox; bicep build + 8 build-params rc=0; template-sync PASS; merge a69b8080c | 2026-10-30 |
| W1-2 | merged | feat/apigw-w01-w1-2 | sonnet | vitest W1-1/2/4 93/93; mutations RED (role name, --scope, auto-reg); bicep build + build-params rc=0; template-sync PASS 4005432 B; ClassificationStore wired; no Commercial roll receipt yet; merge edd7cb51e | 2026-10-30 |
| W1-3 | merged | feat/apigw-w01-w1-3 | sonnet | vitest W1-1/2/3/4/6 combined 247/247 (27 files); sweep mutation RED 5 tests; facets absence paired with host positive; observe/register.ts findings source NOT yet imported by environments routes (wire after W1-8); no live inventory-count receipt (W1-7); merge 1b9cf64e9 | 2026-10-30 |
| W1-4 | merged | feat/apigw-w01-w1-4 | sonnet | vitest 43/43 (5 files); permits() mutation RED 4 tests in sandbox; no tsc errors in owned paths; eslint not run (no flat config); route map NOT regenerated, do once before PR; merge 7221cff5a | 2026-10-30 |
| W1-5 | merged | feat/apigw-w01-w1-5 | sonnet | combined vitest 704 files / 9129 tests incl lib/auth + app/api; guards OK; 6 mutations RED; Playwright spec WRITTEN NOT RUN (W1-7 G1 walk); gap: items/apim-api,product,policy routes not scopeRoute-wrapped so those 3 tabs say not scoped yet for non-default gateways (follow-up); telemetry card read-access only; merge 875009dd1 | 2026-10-30 |
| W1-6 | merged | feat/apigw-w01-w1-6 | sonnet | vitest lib/gates 74/74; mutations RED (fixit kind 2 fail; unregistered 13/13); gates exported as API_GATEWAY_GATES, NOT yet in GATES/admin gate page nor consumed by UI (W1-5 must consume); docs 7.6 has no mkdocs-strict receipt (strict fails on base too, Material banner); merge 245c654a4 | 2026-10-30 |
| W1-7 | todo | | sonnet | | 2026-10-28 |
| W1-8 | merged | feat/apigw-w01-w1-8 | sonnet | combined vitest 826/826 (60 files) incl lib/auth; guards + toolkit OK; mutations RED (3); orchestrator fixed on top: sync route gated on apiplane-admin, apim keys handler inline (durable-access test), findings source wired + findings-wiring test RED when import removed; Runtime tab not click-walked (W1-7); merge 66efd3574 | 2026-10-30 |
