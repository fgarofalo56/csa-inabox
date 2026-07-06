# warehouse-query-acceleration — parity with Fabric GPU-accelerated warehouse

Source UI: Fabric Build 2026 "GPU-accelerated warehouse" (#7) — Fabric Data
Warehouse query-acceleration settings. Learn:
https://learn.microsoft.com/fabric/data-warehouse/architecture (query
execution engine) and
https://learn.microsoft.com/fabric/data-warehouse/result-set-caching.

## Azure/Fabric feature inventory

| Capability | Source |
|------------|--------|
| Toggle GPU-accelerated query execution | Fabric warehouse engine (capacity GPU compute) |
| See whether acceleration is active for the warehouse | Fabric settings |
| Result-set caching (cache repeat query results) | Fabric + Azure Synapse Dedicated SQL |
| See backing compute / SKU / state | Fabric settings + Synapse pool |

## Loom coverage

| Inventory row | Status | Notes |
|---------------|--------|-------|
| GPU-accelerated query execution toggle | honest-gate ⚠️ | Toggle renders always but is non-actionable: the Synapse Dedicated SQL pool (the only warehouse backend — no Fabric) has no GPU. An info MessageBar discloses this and names Loom's Azure-native GPU-class answer — Databricks Photon / a Databricks SQL warehouse. No fake GPU state, and no dead `fabric-warehouse` env knob is advertised. |
| Acceleration active indicator | built ✅ | GET reports `gpu.available/enabled` + live `resultSetCaching.enabled` from `sys.databases.is_result_set_caching_on`. |
| Result-set caching toggle | built ✅ | Switch issues a live `ALTER DATABASE … SET RESULT_SET_CACHING {ON\|OFF}` on the dedicated pool — the real Azure-native acceleration knob. |
| Backing compute / SKU / state badges | built ✅ | From `getPoolState()` (ARM) + `LOOM_SYNAPSE_DEDICATED_POOL`. |

Zero ❌. The Azure-native warehouse (Synapse Dedicated SQL pool) is fully
functional with no Fabric dependency: result-set caching is the 1:1
query-acceleration parity, and GPU is honestly disclosed as a Fabric-only engine
capability whose Azure-native equivalent is Databricks Photon / SQL warehouse.

## Backend per control

| Control | Backend |
|---------|---------|
| GPU toggle / status | `GET/POST /api/items/warehouse/[id]/query-acceleration` → always-honest disclosure (no Fabric host called) |
| Result-set caching toggle | same route → `ALTER DATABASE … SET RESULT_SET_CACHING` via `synapse-sql-client.executeQuery` on the live Synapse Dedicated SQL pool |
| Status / SKU / state | `synapse-pool-arm.getPoolState()` (ARM) + `sys.databases` query |

## Bicep sync

`platform/fiab/bicep/modules/admin-plane/main.bicep`: `LOOM_WAREHOUSE_BACKEND`
env (`loomBackends.warehouse`, default `synapse-dedicated` — the only backend).
The former `loomWarehouseFabricWorkspace` param + `LOOM_WAREHOUSE_FABRIC_WORKSPACE`
env were removed (rel-T94) — the Fabric Warehouse backend is not built, so the
knob is no longer advertised.
