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
| 10 | Copilot chat pane (context-aware, slash commands, apply-to-notebook) | Copilot sidebar |
| 11 | Variable explorer (Name/Type/Length/Value, sortable, Python-only) | View ribbon → Variables |

## Loom coverage

| # | Status | Notes |
|---|---|---|
| 1 | ✅ | Cell list rendered (code + markdown) |
| 2 | ✅ | `+ Code cell` / `+ Markdown cell` (Insert ribbon) |
| 3 | ✅ | `Run all` + per-cell run, both gated on a real compute target (Synapse Spark / Databricks); Run button carries a why-disabled tooltip and the ribbon Run mirrors the same gate |
| 4 | ✅ | Submits via `/api/items/notebook/[id]/run`, polls `/runs/[runId]` for Spark status + output. Compute target is an enumerated picker bound to `/api/loom/compute-targets`; an honest `MessageBar` surfaces compute-discovery errors or names `LOOM_SYNAPSE_WORKSPACE` / `LOOM_DATABRICKS_HOSTNAME` when no notebook compute is deployed. **A terminated Databricks cluster / paused Synapse dedicated pool now shows a "Start compute" button** (→ `POST /api/loom/compute-targets/{id}/start`, polls state to RUNNING) so it's usable without leaving the notebook and runs warm. **Result polling is now adaptive** — ~600ms while a statement executes on a warm session (matching native cadence), backing off to 2s only while a cold session/cluster is still starting; the old flat 2s floor made every fast cell feel ~2s slow. |
| 5 | ✅ | `Attach Lakehouse` (`openAttach`) → `/api/items/lakehouse` list |
| 6 | ✅ | `Run history` pane (`historyOpen`) via `/jobs` + `/runs` |
| 7 | ✅ | New (`createOpen`), Delete (`del`) |
| 8 | ✅ | `/api/items/notebook?workspaceId=` list + Refresh |
| 9 | ✅ | `Notebook docs` opens Learn |
| 10 | ✅ | **Copilot chat pane** — docked `InlineDrawer` (~25% width) opened from the toolbar or View → Panes → Copilot. Streams a real Azure OpenAI answer via SSE from `POST /api/copilot/notebook-assist`. Context builder sends the current cell + prior 5 cells; the server appends the lakehouse datastore schema (Delta column names + types read from each table's `_delta_log/0.json` — Azure-native, no Fabric). Slash menu `/fix /explain /comments /optimize` (fixed allowlist). Multi-block answers render as a diff with **Apply to notebook** (writes cells back). Honest `no_aoai` MessageBar gate when no chat deployment is wired. History reuses `GET /api/copilot/sessions`. |
| 11 | ✅ | `VariablesPane` (`variablesOpen`, toolbar + View ribbon → Variables) — right OverlayDrawer with a sortable Name/Type/Length/Value table, `repr()` tooltip on Value, and a **Python** badge. `onInspect` submits a `globals()` introspection snippet to the **live Livy session** (the same warm session as cell runs) through the real run/poll path — `POST /api/items/notebook/[id]/run` (sentinel `cellId:'__loom_inspect__'`) then `GET /runs/[runId]`, parsing the `__LOOM_VARS__:` JSON line from stdout. Honest errors surface in a MessageBar when no Spark compute is selected; an info bar gates non-Python kernels. Sort logic unit-tested (`variables-sort.test.ts`). |

## Backend per control
- Run / status → Fabric REST notebook job APIs (`/run`, `/runs/[runId]`, `/jobs`).
- Lakehouse attach → Fabric REST lakehouse list.
- CRUD → Fabric REST `/v1/workspaces/{ws}/notebooks`.
- Copilot pane → `POST /api/copilot/notebook-assist` (Azure OpenAI chat-completions `stream:true`, AAD `cogScope()` token); schema grounding → ADLS `_delta_log` via `synapse-catalog-client` + `adls-client`; sessions → `copilot-sessions` Cosmos container (shared with the cross-item Copilot).
- Variable explorer → real Synapse **Livy** statement on the active session via
  `POST /api/items/notebook/[id]/run` + `GET /runs/[runId]` (Azure-native default;
  no Fabric/Power BI dependency). Uses `globals()` introspection, not the IPython
  `%whos` magic, because Synapse Spark runs plain PySpark over Livy.

Grade: **A (all inventory rows built + real Azure/Fabric REST backend; variable explorer sort unit-tested).**
