# unified-lineage — end-to-end lineage across Purview + Unity Catalog + Weave

**Audit:** audit-t138
**Surface:** Unified Catalog → asset **Lineage** tab (`/catalog/[source]/[id]`,
`LineagePanel`) + the item **Lineage drawer** (`LineageDrawer`, opened from any
item editor). Both render the shared React-Flow `LineageCanvas`.

**Source UIs (parity targets):**
- Databricks **Catalog Explorer → Lineage** graph (table/notebook/job/pipeline/
  dashboard nodes, upstream/downstream, column-level): https://learn.microsoft.com/azure/databricks/data-governance/unity-catalog/data-lineage
- Microsoft **Purview portal → Lineage** tab (Atlas v2 lineage subgraph): https://learn.microsoft.com/purview/concept-data-lineage
- Databricks **system tables** lineage (durable, entity-aware): https://learn.microsoft.com/azure/databricks/admin/system-tables/lineage

## The problem this solves

Loom previously had **five disconnected, single-source** lineage surfaces — each
showed Purview *or* Unity Catalog *or* Weave, never merged. The catalog's own
`item/route.ts` header even promised a `?merge=true` that collapsed nodes
sharing `qualifiedName/storageLocation` — never implemented. This task builds
the merge: **one graph keyed by a common asset identity**, so a report →
semantic model → warehouse/lakehouse → pipeline/notebook → source chain reads
end-to-end regardless of which catalog recorded each hop.

## Architecture

```
                       lib/azure/unified-lineage.ts  (merge engine)
                        ├─ purviewGraph()    → getLineageSubgraph (Atlas v2)   [Purview / Atlas-on-AKS]
                        ├─ unityGraph()      → getTableLineageSystemTables      [system.access.table_lineage]
                        │                       └ fallback getTableLineage      [REST lineage-tracking preview]
                        └─ weaveGraph()      → listThreadEdges (Cosmos)         [Weave / Thread mesh]
                       mergeGraphs()         → union-find over asset identities → collapse + rewrite edges
```

### Common asset identity (the join key)

`normalizeIdentity()` reduces every node id / qualifiedName / storage path to a
canonical key, and `mergeGraphs()` collapses nodes whose identity sets connect
(union-find), de-duping and rewriting edges onto the survivor:

| Asset surfaced by | Raw value | Canonical identity |
|---|---|---|
| Unity Catalog table | `main.bronze.customers` | `uc:main.bronze.customers` |
| Atlas entity registered by Loom (`/api/catalog/register`) | `https://{host}/api/2.1/unity-catalog/tables/main.bronze.customers` | `uc:main.bronze.customers` ✅ joins UC |
| ADLS path (UC `storage_location` ⇄ Atlas ADLS qualifiedName) | `abfss://c@a.dfs.core.windows.net/bronze` | `path:abfss://c@a.dfs.core.windows.net/bronze` |
| Loom item (Weave endpoint) | item id | `item:<id>` |
| **Focus asset** | — | carries **all** of its known identities (`uc:`, `guid:`, `item:`) so the focus node from every source collapses into one |

## Per-cloud backend matrix (matches `detectLoomCloud()`, Azure-native default)

| Cloud | Primary (badge) | Overlays merged | Identity join |
|---|---|---|---|
| **Commercial / GCC** | Unity Catalog (system tables when `LOOM_DATABRICKS_LINEAGE_WAREHOUSE_ID` set, else REST preview) | Purview Atlas (when `LOOM_PURVIEW_ACCOUNT` set) + Weave (always) | abfss path / UC `full_name` ⇄ registered Atlas qualifiedName |
| **GCC-High** | Purview Atlas (`*.purview.azure.us`) | Weave (always); UC if a workspace key resolves | Atlas qualifiedName ⇄ UC full_name |
| **IL5 / DoD** | Apache Atlas-on-AKS (`LOOM_ATLAS_ENDPOINT`, injected as the `purview` source via `atlasFetcher`) | Weave (always) | same Atlas qualifiedName join |
| any | **Weave** (`thread-edges` Cosmos) — never gated, no Fabric/Azure dependency | — | `ThreadEdge.from/toItemId` = Loom item ids |

OneLake / Fabric admin-scan lineage (`getWorkspaceLineage`) is **NOT** merged —
it hits `api.fabric.microsoft.com` and is opt-in only (per
`.claude/rules/no-fabric-dependency.md`). The unified path is 100% Azure-native
and works with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset.

## Loom coverage

| Capability | Status | Backend |
|---|---|---|
| Merge Purview + UC + Weave into one graph | ✅ built | `unified-lineage.ts` `getUnifiedLineage` |
| Collapse same asset across sources (`merged` badge) | ✅ built | `mergeGraphs` union-find + `LineageCanvas` multiSource badge |
| Entity-aware UC lineage (notebook/job/pipeline → table) | ✅ built | `getTableLineageSystemTables` (`system.access.table_lineage`) |
| REST preview fallback when no system-table warehouse | ✅ built | `getTableLineage` |
| Catalog Lineage tab unified toggle + per-source gate badges | ✅ built | `LineagePanel` (`?merge=true`) |
| Item Lineage drawer overlay + per-source gates | ✅ built | `LineageDrawer` + `/api/items/[type]/[id]/lineage` |
| Weave mesh on the graph canvas (table ↔ graph toggle) | ✅ built | `app/thread/page.tsx` |
| Upstream/downstream layered layout, focus-chain, click-to-open | ✅ built (pre-existing) | `LineageCanvas` |
| Honest per-source gate (UC system tables / Purview / Atlas-on-AKS) | ⚠️ honest-gate | `sources[]` + Fluent MessageBar; `grant-databricks-system-tables-role.sh` |
| Column-level lineage (`system.access.column_lineage`) | ❌ follow-up | not yet surfaced (canvas already supports `columns`) |

## Backend per control

| Control | Calls |
|---|---|
| Lineage tab "Unified" toggle ON | `GET /api/catalog/lineage/item?merge=true` → `getUnifiedLineage` |
| Item lineage drawer (auto) | `GET /api/items/[type]/[id]/lineage` → `getUnifiedLineage` (cloud-dispatched primary + overlays) |
| Per-source gate badge | `sources[]` from the unified result |
| Node "Open item" | `openHref` → `/items/{type}/{id}` (internal) or `toLink` (external) |
| Thread page Graph view | client projection of `/api/thread/edges` onto `LineageCanvas` |

## Env / infra (bicep-synced)

- `LOOM_DATABRICKS_LINEAGE_WAREHOUSE_ID` (optional) — bicep param
  `loomDatabricksLineageWarehouseId` in `platform/fiab/bicep/modules/admin-plane/main.bicep`.
  Empty ⇒ REST preview fallback (still functional).
- Metastore grant: `scripts/csa-loom/grant-databricks-system-tables-role.sh`
  enables `system.access` + grants the Loom UAMI `USE SCHEMA + SELECT`.
- Reuses existing `LOOM_PURVIEW_ACCOUNT`, `LOOM_DATABRICKS_HOSTNAMES`,
  `LOOM_ATLAS_ENDPOINT` — no other new vars.

## Tests

`lib/azure/__tests__/unified-lineage.test.ts` — `normalizeIdentity` across all
formats; `mergeGraphs` collapse + multiSource + edge rewrite + self-loop drop;
`getUnifiedLineage` 3-source fan-out, per-source gate degradation, system-table
entity path, Weave subgraph BFS. Route contract in
`app/api/items/[type]/[id]/lineage/__tests__/route.test.ts`.
