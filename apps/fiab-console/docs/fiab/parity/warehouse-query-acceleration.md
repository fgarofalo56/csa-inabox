# warehouse-query-acceleration — parity with Fabric Data Warehouse settings (GPU-accelerated query acceleration)

Source UI: Fabric Data Warehouse → Settings → performance / query acceleration
(Fabric Build 2026 announcement #7). Learn:
<https://learn.microsoft.com/fabric/data-warehouse/architecture#query-execution-engine>,
<https://learn.microsoft.com/fabric/fundamentals/whats-new#fabric-data-warehouse>

## Background

Fabric Build 2026 added a GPU-accelerated query-acceleration path to the Fabric
Data Warehouse distributed query-execution engine. CSA Loom's Azure-native
DEFAULT backend for the `warehouse` item is the **Synapse Dedicated SQL pool**,
which runs the SQL Server batch-mode columnar engine — fast, but **CPU-only, no
GPU**. So GPU acceleration is honestly **not available** on the default backend.

Per `no-fabric-dependency.md`, the warehouse remains 100% functional with
`LOOM_DEFAULT_FABRIC_WORKSPACE` UNSET — every other capability (query, CTAS,
model view, monitoring, security, alerts, stats, Copilot) runs against Synapse.
The GPU toggle is the one capability that requires the **opt-in** Fabric backend
(`LOOM_WAREHOUSE_BACKEND=fabric` + a bound Fabric workspace). The toggle is not
removed or faked — it is an honest infra-gate (`no-vaporware.md`).

## Fabric feature inventory

| Capability | Fabric behavior |
| --- | --- |
| Query-acceleration toggle | Settings switch to route eligible scans through GPU acceleration |
| Backend/engine disclosure | Shows the query engine powering the warehouse |
| Per-warehouse persistence | Setting saved with the warehouse item |
| Effective-state indicator | Reflects whether acceleration is actually applied |

## Loom coverage

| Capability | Status | Notes |
| --- | --- | --- |
| Query-acceleration toggle | built ✅ | `WarehouseSettingsDialog` Fluent `Switch`, reachable from the Home → Settings ribbon group |
| Backend/engine disclosure | built ✅ | `Badge` + `Caption1` from the GET `capabilities` matrix |
| Honest gate (Synapse, no GPU) | honest-gate ⚠️ | Fluent `MessageBar intent="warning"` naming `LOOM_WAREHOUSE_BACKEND=fabric` + `LOOM_DEFAULT_FABRIC_WORKSPACE` |
| Per-warehouse persistence | built ✅ | PUT writes `state.settings.queryAcceleration` to Cosmos via `updateOwnedItem` |
| Effective-state indicator | built ✅ | `effective.queryAcceleration` = intent AND backend-can-honor; never "on" against a no-GPU backend |

Zero ❌, zero stub banners.

## Backend per control

| Control | Backend |
| --- | --- |
| Load settings + capability matrix | `GET /api/items/warehouse/[id]/settings` → `loadOwnedItem` (Cosmos) + env-resolved capability matrix |
| Save toggle | `PUT /api/items/warehouse/[id]/settings` → `updateOwnedItem` (Cosmos `items` container) |
| Backend resolution | `resolveWarehouseBackend()` — Synapse default; Fabric only when `LOOM_WAREHOUSE_BACKEND=fabric` AND `LOOM_DEFAULT_FABRIC_WORKSPACE` set |

## Bicep sync

No new env var: `LOOM_WAREHOUSE_BACKEND` (default `synapse-dedicated`) and
`LOOM_DEFAULT_FABRIC_WORKSPACE` are already wired into
`platform/fiab/bicep/modules/admin-plane/main.bicep` (lines ~708, ~1782-1783).
Any non-`fabric` value resolves to the Azure-native Synapse path, so the bicep
default is already correct.

## Tests

`app/api/items/warehouse/[id]/settings/__tests__/settings-route.test.ts`
(15 tests) — backend resolution matrix, capability gate text, 401/404/409/400
guards, and the honest effective-state invariant (never reports acceleration
"on" against the no-GPU Synapse backend).
