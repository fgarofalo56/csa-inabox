# lineage-drawer — parity with OneLake / Fabric item lineage

Source UI:
- Microsoft Fabric — OneLake data hub / item **Lineage view** (workspace lineage
  + item-to-item upstream/downstream graph, hop expansion, open node).
  https://learn.microsoft.com/fabric/governance/lineage
- Azure Databricks Unity Catalog — **Lineage** tab (table-to-table upstream /
  downstream). https://learn.microsoft.com/azure/databricks/data-governance/unity-catalog/data-lineage
- Microsoft Purview — **Lineage** tab (Atlas relationship graph).
  https://learn.microsoft.com/purview/concept-data-lineage

The lineage drawer is the Azure-native, **no-Fabric-dependency** realization of
Fabric's item lineage view. The backend is selected automatically per cloud
boundary; a real Microsoft Fabric / OneLake / Power BI tenant is never required.

## Source UI feature inventory

| # | Capability (Fabric / UC / Purview lineage UI) | Notes |
|---|-----------------------------------------------|-------|
| 1 | Open lineage from item overflow / details pane | Entry point |
| 2 | Directed upstream → downstream graph, left-to-right | Core canvas |
| 3 | Node = asset (table/view/notebook/pipeline/report…) with type icon | |
| 4 | Edge = lineage relationship (process / dataflow / derived) | |
| 5 | Focus node highlighted; the asset you opened from | |
| 6 | Hop expansion — expand upstream/downstream from a node | Focus-chain |
| 7 | Click a node to open the underlying item | Deep-link |
| 8 | Pan / zoom / fit-to-screen / minimap | Canvas controls |
| 9 | Honest empty / not-configured state (never a blank canvas) | |

## Loom coverage

| # | Status | Where |
|---|--------|-------|
| 1 | ✅ built | `LineageDrawer` trigger button (overflow/detail pane) + controlled mode for the details pane; wired into `item-editor-chrome.tsx` actions |
| 2 | ✅ built | `LineageCanvas` (React-Flow) layered left→right layout |
| 3 | ✅ built | `LineageCanvas` type→icon styling (`styleForType`) |
| 4 | ✅ built | `CanvasLineageEdge` Bezier edges |
| 5 | ✅ built | `focusId` passed from the route's resolved lineage key |
| 6 | ✅ built | `LineageCanvas` focus-chain mode (node click + Focus toggle) |
| 7 | ✅ built | route sets `openHref` on the focus node → canvas "Open item" button |
| 8 | ✅ built | `LineageCanvas` fit-view, minimap, dot-grid, pan/zoom |
| 9 | ✅ built | route returns structured 501 gate → named Fluent `MessageBar`; zero-edge state shows an info bar + the single node, not a blank canvas |

Zero ❌. Zero stub banners.

## Backend per control (auto-selected by `detectLoomCloud()`)

| Cloud | Backend | REST / data-plane | Env gate |
|-------|---------|-------------------|----------|
| Commercial / GCC | Unity Catalog | `getTableLineage` → `POST /api/2.0/lineage-tracking/table-lineage` | `LOOM_DATABRICKS_HOSTNAMES` / `LOOM_DATABRICKS_HOSTNAME` |
| GCC-High | Purview Atlas | `getLineageSubgraph` → `GET /datamap/api/atlas/v2/lineage/{guid}` (`*.purview.azure.us`) | `LOOM_PURVIEW_ACCOUNT` |
| DoD / IL5 | Apache Atlas-on-AKS | `GET {LOOM_ATLAS_ENDPOINT}/api/atlas/v2/lineage/{guid}?direction=BOTH&depth=N` (Entra-token) | `LOOM_ATLAS_ENDPOINT` |

Route: `app/api/items/[type]/[id]/lineage/route.ts`. When the selected backend's
env var is unset the route returns `{ ok:false, gate:'lineage-backend-not-configured', hint }`
(HTTP 501) and the drawer renders a MessageBar naming the missing env var + the
bicep module that deploys it. `LOOM_ATLAS_ENDPOINT` is wired into the console
Container App env in `platform/fiab/bicep/modules/admin-plane/main.bicep`
(conditional on `atlasOnAksEnabled`, value `catalog.outputs.atlasEndpoint`).

## Verification

- `vitest` unit suite (`__tests__/route.test.ts`): 401, Commercial→UC real edge,
  UC-not-configured→501 named gate (not an empty graph), GCC-High→Purview Atlas.
- tsc clean on all touched files.
