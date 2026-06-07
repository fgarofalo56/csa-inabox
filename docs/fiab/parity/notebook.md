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
| 4 | ✅ | Submits via `/api/items/notebook/[id]/run`, polls `/runs/[runId]` for Spark status + output. Compute target is an enumerated picker bound to `/api/loom/compute-targets`; an honest `MessageBar` surfaces compute-discovery errors or names `LOOM_SYNAPSE_WORKSPACE` / `LOOM_DATABRICKS_HOSTNAME` when no notebook compute is deployed. **A terminated Databricks cluster / paused Synapse dedicated pool now shows a "Start compute" button** (→ `POST /api/loom/compute-targets/{id}/start`, polls state to RUNNING) so it's usable without leaving the notebook and runs warm. **Result polling is now adaptive** — ~600ms while a statement executes on a warm session (matching native cadence), backing off to 2s only while a cold session/cluster is still starting; the old flat 2s floor made every fast cell feel ~2s slow. |
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

## Azure ML path (Azure-native default — no Fabric/Power BI dependency)

The editor has a **Compute backend** toggle: *Loom (Spark)* (above) and *Azure ML*.
The Azure ML path is parity with Azure ML studio's notebook experience and runs
entirely on ARM control-plane calls against a dedicated AML workspace
(`lib/azure/aml-client.ts`). The notebook record still lives in Cosmos (the Loom
workspace), so CRUD / import are unchanged.

Source UI: Azure ML studio Notebooks — https://learn.microsoft.com/azure/machine-learning/how-to-run-jupyter-notebooks

| # | Capability (AML studio) | Status | Loom implementation |
|---|---|---|---|
| A1 | Workspace-type switch (Azure ML \| Fabric) | ✅ | `workspaceType` toggle in toolbar |
| A2 | Compute Instance selector + state | ✅ | CI picker filtered to `kind==='aml-ci'` (`/api/aml/compute-instances` → `/api/loom/compute-targets`), state badge |
| A3 | Start a stopped CI | ✅ | `Start compute` button → `POST /api/aml/compute-instances/{name}/start` |
| A4 | Auto-start a stopped CI on select | ✅ | Debounced effect kicks `startCI` when a Stopped CI is selected; run-route also auto-starts before submit |
| A5 | New-notebook wizard (name + kernel Python 3.10 / R) | ✅ | New dialog `Kernel` select; kernel drives starter code + `defaultLang` |
| A6 | Datastore explorer + insert path | ✅ | `DatastoreExplorer` sidebar (`/api/aml/datastores`), click **or drag** an `abfss://` / `wasbs://` path into a code cell |
| A7 | `.ipynb` upload | ✅ | Existing `/api/items/notebook/import` (workspace-agnostic) — works on both paths |
| A8 | Run a cell on the CI | ✅ | Run-route submits an AML Command job (`PUT .../jobs/{name}`, `computeId` → the CI); poll-route maps job status to the cell-output contract |
| A9 | Delta schema via delta-rs | ⚠️ honest-gate | Starter cell documents `deltalake.DeltaTable(path).schema()`; `deltalake` is `pip install`-able on the CI (no sidecar) |
| A10 | Honest infra gate | ⚠️ | When `LOOM_AML_WORKSPACE` is unset, the CI picker + Datastore sidebar show a Fluent `MessageBar` naming `LOOM_AML_WORKSPACE` + `LOOM_AML_REGION` and the AzureML Data Scientist grant. Full surface still renders. |

### Backend per control (AML path)
- CI list → ARM `GET .../workspaces/{ws}/computes?api-version=2024-10-01` (filter `computeType==='ComputeInstance'`).
- CI start → ARM `POST .../computes/{name}/start?api-version=2024-10-01` (202).
- Datastores → ARM `GET .../datastores?api-version=2024-10-01`; abfss/wasbs path built from `accountName`/`filesystem`/`containerName`/`endpoint` (sovereign-cloud-aware via `cloud-endpoints`).
- Cell run → ARM `PUT .../jobs/{name}?api-version=2024-10-01` Command job onto the CI; poll `GET .../jobs/{name}`.
- Auth → Console UAMI ChainedTokenCredential on the ARM `.default` scope; UAMI granted **AzureML Data Scientist** by `platform/fiab/bicep/modules/deploy-planner/ml-workspace.bicep`.
- Bicep sync → `mlWorkspaceEnabled=true` (commercial-full) provisions the AML workspace; `admin-plane/main.bicep` injects `LOOM_AML_WORKSPACE`/`LOOM_AML_RG`/`LOOM_AML_REGION`.

Sovereign clouds: Commercial / GCC use `management.azure.com` + `dfs.core.windows.net`; GCC-High / IL5 use the USGov suffixes automatically (`cloud-endpoints.armBase()` / `dfsSuffix()`). AML isn't offered in DoD/IL6 — `amlIsConfigured()` returns false there and the toggle simply gates.

Grade: **A (Azure-native default, real ARM backend, contract-tested in `__tests__/aml-client.test.ts`).**

