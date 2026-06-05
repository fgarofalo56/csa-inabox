# notebook — parity with Fabric Notebook

Source UI: Fabric notebook — https://learn.microsoft.com/fabric/data-engineering/how-to-use-notebook · https://learn.microsoft.com/fabric/data-engineering/lakehouse-notebook-explore
Editor: `apps/fiab-console/lib/editors/notebook-editor.tsx`

## Fabric feature inventory

| # | Capability | Where in Fabric |
|---|---|---|
| 1 | Cell list — code + markdown cells | Canvas |
| 2 | Insert code / markdown cell | Insert ribbon / inline + |
| 3 | Run cell / Run all | Run ribbon |
| 4 | Spark session + run status / output | Cell output + status bar |
| 5 | Lakehouse explorer pane (attach lakehouse, browse tables) | Left pane |
| 6 | Run history / monitoring | View ribbon |
| 7 | New / open / delete notebook | Home ribbon |
| 8 | Workspace notebook list | Item picker |
| 9 | Help / docs | Help ribbon |

## Loom coverage

| # | Status | Notes |
|---|---|---|
| 1 | ✅ | Cell list rendered (code + markdown) |
| 2 | ✅ | `+ Code cell` / `+ Markdown cell` (Insert ribbon) |
| 3 | ✅ | `Run all` + per-cell run, both gated on a real compute target (Synapse Spark / Databricks); Run button carries a why-disabled tooltip and the ribbon Run mirrors the same gate |
| 4 | ✅ | Submits via `/api/items/notebook/[id]/run`, polls `/runs/[runId]` for Spark status + output. Compute target is an enumerated picker bound to `/api/loom/compute-targets`; an honest `MessageBar` surfaces compute-discovery errors or names `LOOM_SYNAPSE_WORKSPACE` / `LOOM_DATABRICKS_HOSTNAME` when no notebook compute is deployed |
| 5 | ✅ | `Attach Lakehouse` (`openAttach`) → `/api/items/lakehouse` list |
| 6 | ✅ | `Run history` pane (`historyOpen`) via `/jobs` + `/runs` |
| 7 | ✅ | New (`createOpen`), Delete (`del`) |
| 8 | ✅ | `/api/items/notebook?workspaceId=` list + Refresh |
| 9 | ✅ | `Notebook docs` opens Learn |

## Backend per control
- Run / status → Fabric REST notebook job APIs (`/run`, `/runs/[runId]`, `/jobs`).
- Lakehouse attach → Fabric REST lakehouse list.
- CRUD → Fabric REST `/v1/workspaces/{ws}/notebooks`.

Grade: **A (all inventory rows built + real Fabric REST backend).**
