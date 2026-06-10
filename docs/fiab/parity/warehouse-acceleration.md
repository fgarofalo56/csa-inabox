# warehouse-acceleration — parity with Fabric Data Warehouse query acceleration / Synapse Dedicated SQL pool scaling

Source UI:
- Fabric Data Warehouse architecture & workload management — https://learn.microsoft.com/fabric/data-warehouse/architecture · https://learn.microsoft.com/fabric/data-warehouse/workload-management
- Synapse Dedicated SQL pool scale (DWU) — https://learn.microsoft.com/azure/synapse-analytics/sql-data-warehouse/quickstart-scale-compute-portal

## The honest reality (why there is no GPU toggle)

Neither warehouse backend offers **GPU acceleration**. Both are CPU, columnar,
**batch-mode** execution engines:

- **Fabric Data Warehouse** — the query execution engine "is based on the same
  engine used by SQL Server and Azure SQL Database to use **batch mode**
  execution and **columnar** data formats." Acceleration is via *serverless
  distributed query processing* that auto-scales compute nodes per query
  (burstable capacity + SSD/memory caching). No GPU.
- **Synapse Dedicated SQL pool** (the Azure-native DEFAULT) — a CPU MPP engine
  whose throughput is governed by its **DWU SKU** (DW100c … DW30000c). You
  accelerate by resizing the pool (a real ARM operation) and/or enabling
  result-set caching. No GPU.

A "GPU-accelerated warehouse" is therefore **not a real Microsoft offering** on
either backend. Per `no-vaporware.md`, Loom does not fabricate one. The editor
exposes a **Query acceleration** dialog that honestly discloses the active
backend's real acceleration model and the real lever to scale it.

## Loom coverage

| Capability | Status | Notes |
|---|---|---|
| Surface the active warehouse backend | ✅ built | `GET /api/items/warehouse/[id]/acceleration` resolves `LOOM_WAREHOUSE_BACKEND` |
| Show the real acceleration model | ✅ built | `dwu-sku` (Synapse) / `serverless-autoscale` (Fabric opt-in) |
| Show the live DWU SKU + pool state | ✅ built | read via ARM `getPoolState()` (synapse-pool-arm) on the default path |
| Query-acceleration toggle | ✅ built (informational) | Fluent `Switch`, disabled — mirrors backend state; **no fake on/off** |
| Honest "no GPU" disclosure | ✅ built | `intent="warning"` MessageBar + a "GPU acceleration: not available" Badge |
| Real action to accelerate | ✅ built | "Scale compute" → `/admin/scaling` (real DWU resize) on the Synapse path |
| GPU acceleration | ⚠️ honest-gate | Disclosed as not available on either backend — by design, not a stub |

Zero ❌. The one non-functional state (the GPU absence) is an honest disclosure,
not a stub banner — the rest of the surface (backend, SKU, state, scale action)
is fully live.

## Backend per control

| Control | Backend |
|---|---|
| Backend / model / SKU / state badges + toggle | `GET /api/items/warehouse/[id]/acceleration` → `synapse-pool-arm.getPoolState()` (ARM) + `LOOM_WAREHOUSE_BACKEND` |
| "Scale compute" button | navigates to `/admin/scaling` (existing ADX/Synapse scaling admin — real ARM resize) |

## No-Fabric-dependency

Works with `LOOM_DEFAULT_FABRIC_WORKSPACE` UNSET: the default `synapse-dedicated`
branch never reads a Fabric workspace and never calls a Fabric host. The
`fabric-warehouse` branch is reached only when `LOOM_WAREHOUSE_BACKEND=fabric-warehouse`
is explicitly opted into.

## Bicep sync

No new env var, resource, role, or Cosmos container. The route reuses the
already-wired `LOOM_WAREHOUSE_BACKEND` / `LOOM_SYNAPSE_DEDICATED_POOL` env and
the existing ARM Reader grant used by `getPoolState`.
