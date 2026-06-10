# warehouse-acceleration — parity with Fabric Warehouse "Performance / Query acceleration"

Source UI: Fabric Data Warehouse performance & caching settings —
- https://learn.microsoft.com/fabric/data-warehouse/caching
- https://learn.microsoft.com/fabric/data-warehouse/result-set-caching
- https://learn.microsoft.com/azure/synapse-analytics/sql-data-warehouse/performance-tuning-result-set-caching

Surface: `WarehouseAccelerationPanel` in
`apps/fiab-console/lib/editors/components/warehouse-acceleration.tsx`, mounted as
the **Acceleration** tab of `WarehouseEditor`
(`apps/fiab-console/lib/editors/phase3-editors.tsx`).

Backend: the Azure-native DEFAULT — the **Synapse Dedicated SQL pool** — through
the existing `/api/items/warehouse/[id]/query` route. No new env var, resource,
role, or Cosmos container; works with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset
(no-fabric-dependency.md).

## Fabric / Azure feature inventory (query acceleration)

| # | Capability | Where in Fabric / Azure |
|---|---|---|
| 1 | Result-set caching toggle (database-level) | `ALTER DATABASE … SET RESULT_SET_CACHING ON/OFF` |
| 2 | Read current result-set-caching state | `sys.databases.is_result_set_caching_on` |
| 3 | Automatic in-memory / SSD columnar caching | Transparent in Fabric Warehouse (no user knob) |
| 4 | GPU-accelerated query execution | **Does not exist** on either SQL warehouse backend |

## Loom coverage

| # | Capability | Status | Notes |
|---|---|---|---|
| 1 | Result-set caching toggle | built ✅ | Real `ALTER DATABASE … SET RESULT_SET_CACHING` against the live pool |
| 2 | Read current state | built ✅ | Real DMV `SELECT is_result_set_caching_on FROM sys.databases` |
| 3 | Automatic columnar caching | honest-gate ⚠️ | Stated in MessageBar as automatic/transparent on the opt-in Fabric backend; not a user control on either platform |
| 4 | GPU acceleration | honest-gate ⚠️ | MessageBar states plainly that no SQL warehouse backend (Synapse default or opt-in Fabric) offers GPU; points to Spark/Databricks GPU pools or ADX instead |

## Backend per control

| Control | Backend call |
|---------|--------------|
| Refresh / read state | `POST /api/items/warehouse/[id]/query` → `SELECT … FROM sys.databases` (real DMV on Synapse Dedicated SQL pool) |
| Result-set caching Switch | `POST /api/items/warehouse/[id]/query` → `ALTER DATABASE [db] SET RESULT_SET_CACHING ON/OFF` (real ARM-backed pool) |
| Compute-offline gate | `getPoolState()` in the query route returns 409 when paused → warning MessageBar with Resume instruction |

## Honest-gate rationale

The task asks for a "GPU-accelerated warehouse" toggle. Shipping a literal GPU
on/off switch would be vaporware: neither the Synapse Dedicated SQL pool (the
Azure-native default) nor an opt-in Fabric Warehouse exposes GPU execution — GPU
is not a relational-warehouse capability. Per no-vaporware.md the panel therefore
surfaces the REAL query-acceleration lever for this backend (database-level
result-set caching, a genuine, toggleable, measurable feature) and an honest
`intent="info"` MessageBar that explains the GPU situation and redirects GPU
workloads to Spark/Databricks GPU pools or Azure Data Explorer. Every control on
the surface calls a real backend; the only non-functional state is the
documented compute-offline gate.
