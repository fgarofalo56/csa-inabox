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
| GPU-accelerated query execution toggle | honest-gate ⚠️ / built ✅ | Toggle renders always. Enabled + on only when `LOOM_WAREHOUSE_BACKEND=fabric-warehouse` + a bound Fabric workspace (`LOOM_WAREHOUSE_FABRIC_WORKSPACE`). On the Azure-native Synapse default a warning MessageBar discloses there is no GPU compute and names the exact opt-in. No fake GPU state. |
| Acceleration active indicator | built ✅ | GET reports `gpu.available/enabled` + live `resultSetCaching.enabled` from `sys.databases.is_result_set_caching_on`. |
| Result-set caching toggle | built ✅ | Switch issues a live `ALTER DATABASE … SET RESULT_SET_CACHING {ON\|OFF}` on the dedicated pool — the real Azure-native acceleration knob. |
| Backing compute / SKU / state badges | built ✅ | From `getPoolState()` (ARM) + `LOOM_SYNAPSE_DEDICATED_POOL`. |

Zero ❌. The Azure-native default (Synapse Dedicated SQL pool) is fully
functional with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset: result-set caching is the
1:1 query-acceleration parity, and GPU is an honest opt-in gate.

## Backend per control

| Control | Backend |
|---------|---------|
| GPU toggle / status | `GET/POST /api/items/warehouse/[id]/query-acceleration` → backend + Fabric-workspace env detection (no Fabric host called on the default path) |
| Result-set caching toggle | same route → `ALTER DATABASE … SET RESULT_SET_CACHING` via `synapse-sql-client.executeQuery` on the live Synapse Dedicated SQL pool |
| Status / SKU / state | `synapse-pool-arm.getPoolState()` (ARM) + `sys.databases` query |

## Bicep sync

`platform/fiab/bicep/modules/admin-plane/main.bicep`: added param
`loomWarehouseFabricWorkspace` + app env `LOOM_WAREHOUSE_FABRIC_WORKSPACE`
(empty by default → Azure-native path).
