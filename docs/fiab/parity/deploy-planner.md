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
| Browse a catalog of Azure resource types, grouped/searchable | ✅ Palette: 6 categories, search + filter chips, ~50 service types | `service-catalog.ts` |
| Place resources into a scope (subscription / RG) | ✅ Canvas: subscription → domain → service containers (React Flow) | `deploy-plan-nodes.tsx`, `deploy-planner-view.tsx` |
| Pick a resource SKU / pricing tier | ✅ Per-service config panel — Dropdown bound to the module's `@allowed` set (Redis SKU, App Service plan, Postgres/MySQL version + storage) | `ConfigFieldControl`, `configFor()` |
| Pick a runtime / version / capacity | ✅ App Service + Functions runtime, Postgres/MySQL version, storage GB (SpinButton bounded by `@minValue/@maxValue`) | `ConfigFieldControl` |
| Region selection | ✅ Per-subscription region (boundary-aware default via `BOUNDARY_DEFAULT_REGION`) | `planToBicepparam` |
| Sovereign-cloud boundary | ✅ Per-subscription Commercial / GCC / GCC-High / IL5 | `PlanSubscription.boundary` |
| Express dependencies between resources | ✅ Drag from a service's right handle to another → dependency arrow (React Flow edges) | `onConnect`, `buildEdges` |
| Validate before deploy ("Review + create") | ✅ **Validate** button — flags dangling dependencies (error), plan-only/empty/cross-subscription warnings | `validatePlan()` |
| Save the design | ✅ **Save plan** → Cosmos (`deploy-plan:<tenantId>` in tenant-settings) | `app/api/admin/deploy-plan/route.ts` (PUT) |
| Export deployable template / parameters | ✅ **Export bicepparam** → real `.bicepparam` with feature flags **and** per-resource SKU/tier/runtime params | `planToBicepparam()` |
| Deploy | ⚠️ Honest gate: the planner does **not** run the deployment. The exported file is applied with `az deployment sub create` or the deploy-fiab workflow (surfaced in the info bar). | — |
| Cost estimate | ❌ Tracked separately (deploy-planner cost-estimate task) — out of scope here. |

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

Interdependent knobs (Redis family/capacity, which must match the SKU) are
**derived in main.bicep** from the chosen SKU so every exported combination
compiles and deploys — the planner never emits an invalid pairing. Core
(`bicepFlag:null`) and plan-only services expose **no** config knobs (a knob
there would be a fake — see `no-vaporware.md`). The
`bicep-sync` vitest (`__tests__/plan-validation.test.ts`) fails if any config
field's `bicepParam` is missing from `main.bicep` or not forwarded to its module.

## Per-cloud (no-fabric-dependency)

All configurable resources are ARM-native (`Microsoft.Cache/redis`,
`Microsoft.Web/*`, `Microsoft.DBforPostgreSQL/*`, `Microsoft.DBforMySQL/*`) —
available in Commercial and Gov. Region defaults follow the subscription
boundary (`Commercial=eastus2`, `GCC/GCC-High=usgovvirginia`, `IL5=usgovarizona`).
`fabricCapacity` and Power BI stay plan-only (no emitted bicep) so the default
path never requires a Fabric/Power BI tenant.

## Verification

- `pnpm vitest run lib/components/deploy-planner` — catalog/coercion, emitter
  config emission, edge pruning, plan validation, and the bicep-sync guard.
- Manual: select a Redis/App Service/Postgres node → set SKU/version → **Export
  bicepparam** → confirm the `param <name> = <value>` lines appear; connect two
  nodes → arrow renders + persists through Save; **Validate** flags a dangling
  edge after deleting a connected service.
- `az bicep build -f platform/fiab/bicep/main.bicep` compiles with the new
  params (defaults preserve `params/commercial-full.bicepparam`).
