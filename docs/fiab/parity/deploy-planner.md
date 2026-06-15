# deploy-planner — parity with Azure portal "Create a resource" config blades + custom-template deployment

Source UI:
- Azure portal **Create a resource** → per-service "Basics / Networking / Tags" blades (SKU, tier, version, runtime pickers): https://learn.microsoft.com/azure/azure-resource-manager/templates/deploy-portal
- Azure portal **Deploy a custom template** (edit parameters → Review + create): https://learn.microsoft.com/azure/azure-resource-manager/templates/deploy-portal
- Resource group **map / visualizer** (architecture overview): https://learn.microsoft.com/azure/azure-resource-manager/management/resource-graph-visualizer

The Loom Deployment planner is the **architecture-builder** counterpart: lay out
subscriptions → domains → services on a canvas, configure each resource's
SKU/tier/runtime, draw dependency arrows, validate, save, and export a real
`.bicepparam` that `az deployment sub create -f platform/fiab/bicep/main.bicep`
consumes. It is Azure-native end to end (no Microsoft Fabric dependency — see
`.claude/rules/no-fabric-dependency.md`).

## Azure feature inventory → Loom coverage

| Azure capability | Loom coverage | Backend |
|---|---|---|
| Browse a catalog of Azure resource types, grouped/searchable | ✅ Palette: 6 categories, search + filter chips, 81 service types | `service-catalog.ts` |
| Place resources into a scope (subscription / RG) | ✅ Canvas: subscription → domain → service containers (React Flow) | `deploy-plan-nodes.tsx`, `deploy-planner-view.tsx` |
| Pick a resource SKU / pricing tier | ✅ Per-service config panel — Dropdown bound to the module's `@allowed` set (Redis SKU, App Service plan, Postgres/MySQL version + storage) | `ConfigFieldControl`, `configFor()` |
| Pick a runtime / version / capacity | ✅ App Service + Functions runtime, Postgres/MySQL version, storage GB (SpinButton bounded by `@minValue/@maxValue`) | `ConfigFieldControl` |
| Region selection | ✅ Per-subscription region (boundary-aware default via `BOUNDARY_DEFAULT_REGION`) | `planToBicepparam` |
| Sovereign-cloud boundary | ✅ Per-subscription Commercial / GCC / GCC-High / IL5 | `PlanSubscription.boundary` |
| Deployment mode (topology) | ✅ Per-subscription **single-sub / multi-sub** Dropdown (`@allowed` on `main.bicep`); emitted as `param deploymentMode`. Unset ⇒ derived from domain count (>1 ⇒ multi-sub) | `PlanSubscription.deploymentMode`, `planToBicepparam()` |
| Express dependencies between resources | ✅ Drag from a service's right handle to another → dependency arrow (React Flow edges) | `onConnect`, `buildEdges` |
| Validate before deploy ("Review + create") | ✅ **Validate** button — flags dangling dependencies (error), plan-only/empty/cross-subscription warnings | `validatePlan()` |
| Save the design | ✅ **Save plan** → Cosmos (`deploy-plan:<tenantId>` in tenant-settings) | `app/api/admin/deploy-plan/route.ts` (PUT) |
| Export deployable **parameters** | ✅ **Export bicep → .bicepparam** tab → real `.bicepparam` with feature flags **and** per-resource SKU/tier/runtime params, drives the maintained `main.bicep` | `planToBicepparam()` |
| Export deployable **template** | ✅ **Export bicep → .bicep** tab → standalone `targetScope='subscription'` template: every module-backed selected service becomes a real `module`, **dependency arrows become module `dependsOn`**, per-resource config threaded | `planToBicep()` |
| Deploy | ⚠️ Honest gate: the planner does **not** run the deployment. The exported file is applied with `az deployment sub create` or the deploy-fiab workflow (surfaced in the info bar). | — |
| Cost estimate | ✅ **Estimate cost** prices the selected subscription against the public Azure Retail Prices API (representative SKU) | `cost-estimate.ts`, `/api/admin/deploy-plan/cost-estimate` |

## Deployment mode & DLZ-attach

The planner now emits the **`deploymentMode`** parameter that
`platform/fiab/bicep/main.bicep` requires (`@allowed(['single-sub','multi-sub'])`,
no default), so an exported `.bicepparam` is deployable as-is:

- **single-sub** — Admin Plane + exactly one DLZ in the subscription
  (`rg-csa-loom-dlz-single-<location>`). The default for a one-domain plan.
- **multi-sub** — Admin Plane here + one DLZ per domain across separate
  subscriptions. The emitter also writes a commented `dlzSubscriptionIds` TODO
  (the real sub GUIDs are an operator input, not planner state — so it is an
  honest TODO, never a fake value).

When `deploymentMode` is unset on a subscription the emitter **derives** it from
the domain count (more than one domain ⇒ multi-sub, since single-sub supports at
most one DLZ). The control is a constrained Dropdown bound to the two `@allowed`
values — no freeform.

The **first-run vs DLZ-attach** distinction is a Setup-Wizard / Console concept
layered on top of this same template: first-run provisions the Admin Plane + the
first DLZ; "Add Data Landing Zone" re-runs `main.bicep` with an expanded
`dlzSubscriptionIds` / `dlzDomainNames` (admin plane already present →
`setupOrchestratorSpokeRbac` + spoke peering add the new DLZ only). Both flows
are diagrammed in [`docs/fiab/diagrams/`](../diagrams/README.md) and taught in
[Tutorial 09 — Tenant topology](../tutorials/09-tenant-topology.md).


## Constrained-config compliance (`loom_no_freeform_config`)

Every config control is constrained, never freeform JSON:
- **select** → Fluent `Dropdown` whose options are the **exact** `@allowed` list
  on the backing bicep module param (single source of truth).
- **number** → Fluent `SpinButton` bounded by the module's `@minValue`/`@maxValue`.
- **text** → only for genuinely-freeform Azure fields (Linux runtime string),
  validated against an Azure-format regex (`NODE|20-lts` shape).

`coerceConfigValue()` is the shared gate used by **both** the UI and the server
sanitizer, so an out-of-range/disallowed value can never reach Cosmos or the
exported `.bicepparam`.

## Bicep sync (no-vaporware "Bicep sync")

Per-resource config is honest only because `main.bicep` **accepts and forwards**
each value. For the v1 configurable services the planner adds these top-level
params (each `@allowed`/`@minValue` mirrors the module decorator) and forwards
them to the deploy-planner module:

| Service | Config field(s) | main.bicep param → module |
|---|---|---|
| Cache for Redis | SKU | `redisSkuName` → `redis.bicep skuName` (family + capacity **derived** to a valid pairing) |
| App Service | plan SKU, runtime | `appServicePlanSku`, `appServiceLinuxFxVersion` → `app-service.bicep` |
| Functions | worker runtime, version | `functionsWorkerRuntime`, `functionsLinuxFxVersion` → `functions.bicep` |
| PostgreSQL Flexible | version, storage GB | `postgresVersion`, `postgresStorageSizeGB` → `postgres.bicep` |
| MySQL Flexible | version, storage GB | `mysqlVersion`, `mysqlStorageSizeGB` → `mysql.bicep` |
| Service Bus | namespace SKU | `serviceBusSkuName` → `service-bus.bicep skuName` (Basic excluded — module provisions a starter topic) |
| Azure Firewall | tier | `firewallTier` → `firewall.bicep firewallTier` (Standard / Premium) |
| Stream Analytics | streaming units | `streamAnalyticsStreamingUnits` → `stream-analytics.bicep startingStreamingUnits` |

Interdependent knobs (Redis family/capacity, which must match the SKU) are
**derived in main.bicep** from the chosen SKU so every exported combination
compiles and deploys — the planner never emits an invalid pairing. Core
(`bicepFlag:null`) and plan-only services expose **no** config knobs (a knob
there would be a fake — see `no-vaporware.md`). The `bicepparam.test.ts`
drift guards fail if any config field's `bicepParam` is missing from
`main.bicep`.

## Standalone `.bicep` template export (edges → `dependsOn`)

Alongside the primary `.bicepparam`, **Export bicep → .bicep** emits a
self-contained, subscription-scoped template straight from the graph
(`planToBicep()`):

- Every SELECTED service that has a self-contained deploy-planner module
  (`platform/fiab/bicep/modules/deploy-planner/<svc>.bicep`) becomes a real
  `module` reference inside a generated resource group, with its per-resource
  config threaded into the module's params (verified 1:1 with how `main.bicep`
  invokes each `dp*` module — cognitive-account's `kind`/`nameFragment`
  included).
- The canvas **dependency arrows become real module `dependsOn`**, so the
  visual ordering is enforced at deploy time (an arrow A→B emits
  `module svc_A { … dependsOn: [ svc_B ] }`). Edges that touch a
  non-module-backed service are dropped (no dangling `dependsOn`).
- Services WITHOUT a self-contained module (AI Search, API Management, AI
  Foundry, … which deploy via `main.bicep`'s DLZ orchestrator) are listed as
  honest comments, never faked as modules.
- Honest gate: the standalone template provisions resources only — each
  module's `consolePrincipalId` defaults to `''`, so the Loom Console UAMI role
  grants are skipped (disclosed in the generated header); run `main.bicep` (or
  grant separately) to wire the Console. Deploy with
  `az deployment sub create -l <region> -f <file>.architecture.bicep` after
  saving the file next to `main.bicep`.

The emitter is `az bicep build`-clean — verified against a representative plan
covering every module file, the cognitive-account `kind`/`nameFragment`, the
subscription-scoped Defender/Policy modules, and `dependsOn` edges
(planToBicep.test.ts asserts every mapped module file exists on disk).

## Per-cloud (no-fabric-dependency)

All configurable resources are ARM-native (`Microsoft.Cache/redis`,
`Microsoft.Web/*`, `Microsoft.DBforPostgreSQL/*`, `Microsoft.DBforMySQL/*`,
`Microsoft.ServiceBus/namespaces`, `Microsoft.Network/azureFirewalls`,
`Microsoft.StreamAnalytics/streamingjobs`) — available in Commercial and Gov.
Region defaults follow the subscription
boundary (`Commercial=eastus2`, `GCC/GCC-High=usgovvirginia`, `IL5=usgovarizona`).
`fabricCapacity` and Power BI stay plan-only (no emitted bicep) so the default
path never requires a Fabric/Power BI tenant.

## Verification

- `pnpm vitest run lib/components/deploy-planner` — catalog/coercion, emitter
  config emission, edge pruning, plan validation, the bicep-sync guard, and the
  standalone-`.bicep` module-map integrity + `dependsOn` emission
  (`planToBicep.test.ts`).
- Manual: select a Redis/App Service/Postgres/Service Bus/Firewall/Stream
  Analytics node → set SKU/tier/version → **Export bicep** → on the
  `.bicepparam` tab confirm the `param <name> = <value>` lines appear, on the
  `.bicep` tab confirm the `module svc_<key>` + `dependsOn` lines appear;
  connect two nodes → arrow renders + persists through Save; **Validate** flags a
  dangling edge after deleting a connected service.
- `az bicep build -f platform/fiab/bicep/main.bicep` compiles with the new
  `serviceBusSkuName` / `firewallTier` / `streamAnalyticsStreamingUnits` params
  (defaults preserve `params/commercial-full.bicepparam`); a representative
  `planToBicep()` output also compiles `az bicep build`-clean.

---

# deploy-planner — parity with the Azure deployment / architecture planning surface

**Surface:** `apps/fiab-console/lib/components/deploy-planner/` →
`/admin/deploy-planner`
**Source UI:** Azure portal "Deploy to Azure" / architecture planning + the
official Azure architecture icon set (`Azure_Public_Service_Icons`). This is a
Loom-native planner (subscriptions → domains → services) that emits the real
`.bicepparam` consumed by `az deployment sub create -f
platform/fiab/bicep/main.bicep`.

This doc tracks **audit-T119** (deep-dive functional gap #3): *"deploy-planner
should offer ALL Azure service types as draggable nodes and use the Atlas Diag
icon API for icons, on a bounded canvas."*

## Feature inventory → Loom coverage

| Capability | Status | Backend / mechanism |
|---|---|---|
| All Azure service types as draggable palette nodes | ✅ | `SERVICE_CATALOG` (81 services across 6 categories: 12 compute · 20 data · 14 ai · 10 integration · 11 governance · 14 networking) — drag (`application/x-loom-service` MIME) + click + keyboard add |
| Service icons from the Atlas Diag icon API | ✅ | `iconUrl(def.iconSlug ?? def.key)` — canonical kebab-case `iconSlug` per service resolves against `NEXT_PUBLIC_LOOM_ICON_BASE`; was previously keyed on the camelCase `key`, which 404'd |
| Graceful icon fallback (no broken-image boxes) | ✅ | `ServiceIconChip` 3-tier chain: remote Atlas Diag `<img>` (with `onError` → fallback) → bundled `/azure-icons/*.png` → Fluent glyph |
| Bounded canvas (doesn't grow the page) | ✅ | `body` grid `height: calc(100vh - 220px)`, palette `overflowY:auto`, `.canvas` `overflow:hidden`, React Flow `fitView` + `minZoom 0.3` / `maxZoom 2` |
| Search + category filter + collapsible groups | ✅ | `query`/`catFilter`/`collapsedCats` state; counts auto-update from `SERVICE_COUNT` |
| Subscriptions / domains / nested service nodes | ✅ | React Flow nested nodes (`subscription` → `domain` → `service`) |
| Boundary + region per subscription (sovereign clouds) | ✅ | `PlanSubscription.boundary` (Commercial/GCC/GCC-High/IL5), `BOUNDARY_TINT`, `BOUNDARY_DEFAULT_REGION` |
| Persist plan | ✅ | `GET`/`PUT /api/admin/deploy-plan` → Cosmos tenant-settings |
| Export bicepparam | ✅ | `planToBicepparam()` — unions selected services → real `*Enabled` flags |
| Honest deploy model (no fake auto-deploy) | ✅ | three states: toggleable `bicepFlag`, `core` (`null`), `planOnly` (real Azure, no toggle, never emits a param) |

## Atlas Diag icon slug fix (defect A)

Service `key`s are camelCase (`containerApps`, `aiFoundry`). `iconUrl()`
lowercases and appends `.svg`, producing `containerapps.svg` — a slug that does
not exist in the Atlas Diag / Azure-architecture-icon namespace, so the remote
`<img>` 404'd for nearly every service. Each `ServiceDef` now carries a
canonical kebab-case `iconSlug` (`container-apps`, `azure-openai`,
`databricks-sql-warehouse`, …) — mirroring the kebab-case slugs in
`item-type-visual`'s `REGISTRY` where one exists, otherwise the official Azure
architecture-icon basename. Both render call sites use `iconSlug ?? key`.

## Catalog breadth (defect B)

The catalog grew from 57 → **81** real Azure service types (44 with a real
one-button `bicepFlag` toggle, the rest `core` or `planOnly`). Of these, 25
are tagged `planOnly: true` (real Azure, no one-button bicep toggle yet) so the
plan stays honest — they never emit a bicep param. Plan-only additions span App
Configuration, Container Apps Jobs, HDInsight, Data Share, Cosmos Gremlin,
Azure Maps, Bot Service, Translator, AI Video Indexer, Azure Relay,
Notification Hubs, API Center, Application Insights, Managed Grafana, Azure
Lighthouse, Azure Bastion, NAT Gateway, Traffic Manager, ExpressRoute, and
DDoS Protection.

## Per-cloud notes (sovereign clouds)

- **Icon hosting**: `NEXT_PUBLIC_LOOM_ICON_BASE` is a single public base URL.
  In GCC-High / IL5 the Atlas Diag icon endpoint must be hosted in-boundary
  (no Commercial CDN egress). Because the remote icon is progressive-only and
  the chip falls back to bundled `/azure-icons` PNGs + Fluent glyphs (now with
  `onError`), the planner is fully functional air-gapped.
- **Service availability**: cloud-limited services keep an honest
  `description` note (e.g. Front Door "(Commercial)"). The palette is *not*
  gated by boundary (operators plan across clouds); the bicepparam export binds
  region/boundary, and an unavailable service simply should not be promoted to
  a real flag in that cloud's param file.

## No-vaporware / no-Fabric posture

- Every toggleable `bicepFlag` is a real `param <x>Enabled bool` in
  `platform/fiab/bicep/main.bicep` — guarded by a vitest drift test
  (`bicepparam.test.ts` → "bicep drift guard").
- `fabricCapacity` is `planOnly` and labeled "Loom never requires it; the
  Azure-native lake is the default" — no hard Fabric dependency.
- `purviewData` describes the Azure-native ADLS lake catalog (no OneLake/Fabric
  requirement on the default path).

## Tests

`apps/fiab-console/lib/components/deploy-planner/__tests__/bicepparam.test.ts`
(22 cases): flag mapping, bicepparam emission, catalog breadth (≥70),
plan-only honesty, per-resource config schema + coercion, `iconSlug`
kebab-case + `iconUrl` round-trip (set/unset base), and the bicep drift
guard. All 22 pass (node env).
