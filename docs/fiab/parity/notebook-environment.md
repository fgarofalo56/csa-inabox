# notebook-environment — parity with the Fabric notebook Environment / Library management

Source UI: Fabric notebook ribbon **Home → Environment** selector + the **Environment**
item editor (Libraries: Public/Custom; Spark compute; Resources), and the Azure
ML Studio **Environments** page.
- https://learn.microsoft.com/fabric/data-engineering/environment-manage-library
- https://learn.microsoft.com/fabric/data-engineering/library-management
- https://learn.microsoft.com/azure/machine-learning/how-to-manage-environments-v2

Azure-native backend: **Azure ML Environment** assets (versioned image + conda
spec) via ARM REST `Microsoft.MachineLearningServices/workspaces/{ws}/environments`
(api-version 2024-10-01). Inline `%pip` / `%conda install` run through the Spark
Livy / Databricks session (Task 3 execute path). **No Microsoft Fabric workspace
required** — per `.claude/rules/no-fabric-dependency.md`.

## Fabric / Azure feature inventory

| Capability (source UI) | Notes |
|---|---|
| Attach an environment to a notebook from the ribbon selector | Fabric ribbon "Environment" dropdown |
| List the environment's installed libraries (PyPI + Conda) | Fabric Environment editor → Libraries → Public |
| Inline `%pip install` into the running session | Fabric/Jupyter session magic |
| Inline `%conda install` into the running session | Fabric/Jupyter session magic |
| Attach a custom `.jar` / `.whl` library | Fabric Environment → Custom libraries |
| Create / register a new environment (base image + packages) | AML Studio → Environments → Create; Fabric "New environment" |
| Inspect the conda specification | AML Studio environment detail → conda dependencies |
| Persist the selection on the notebook | Fabric notebook keeps its attached environment |

## Loom coverage

| Inventory row | Status | Surface |
|---|---|---|
| Ribbon environment selector + attach | ✅ built | `notebook-editor.tsx` toolbar `Select` + Home→Environment→Manage; `selectAmlEnv` → `PATCH ?action=attach` |
| List real installed libraries (pip + conda) | ✅ built | `environment-panel.tsx` Packages tab; server-extracted from `properties.condaFile` via `extractPackages()` |
| Inline `%pip install` into session | ✅ built | Packages tab "Install in session" → `onPipInstall` → new `%pip install` cell run via `/run` (forces `pyspark` stmt-kind) |
| Inline `%conda install` into session | ✅ built | Same run-route guard `isInlineInstall` matches `%conda install` too |
| Attach custom `.jar` / `.whl` | ✅ built | Custom libraries tab → `PATCH ?action=attach-jar`; persisted to `state.customLibraries` |
| Create / register new environment | ✅ built | Guided dialog (base-image `Select` + structured conda/pip lists, no freeform YAML) → `POST /api/aml/environments` |
| Inspect conda specification | ✅ built | Environments tab renders `condaFile` read-only |
| Persist attached environment on notebook | ✅ built | `state.attachedAmlEnv` round-trips through `notebook/[id]` GET/PUT |
| No AML workspace deployed | ⚠️ honest-gate | List returns 503; panel shows Fluent MessageBar naming `LOOM_AML_WORKSPACE` / `LOOM_SUBSCRIPTION_ID`; UI still renders |

Zero ❌. The only non-functional state is the honest infra-gate.

## Backend per control

| Control | Backend |
|---|---|
| Environment list / selector | `GET /api/aml/environments` → ARM `…/environments` + `/versions/{v}` (real packages) |
| Get one environment | `GET /api/aml/environments?name&version` → ARM environment version |
| Create environment | `POST /api/aml/environments` → ARM `PUT …/environments/{name}/versions/{v}` (conda YAML built from structured input) |
| Attach / detach env | `PATCH /api/aml/environments?action=attach|detach` → validates via ARM, writes Cosmos `state.attachedAmlEnv` |
| Attach / detach jar | `PATCH …?action=attach-jar|detach-jar` → Cosmos `state.customLibraries` |
| `%pip install` run | `POST /api/items/notebook/[id]/run` → Synapse Livy statement (`sessionLevelPackagesEnabled`) / Databricks PYTHON magic |

## Per-cloud

| | Commercial / GCC | GCC-High / IL5 |
|---|---|---|
| ARM environments REST | `management.azure.com` (`armBase()`) | sovereign ARM host via `armBase()` — identical path |
| Curated `AzureML-*` global-registry envs | available | not available — panel shows empty list + "Create new" CTA (no error) |
| `%pip install` in Synapse Spark | works with `sessionLevelPackagesEnabled=true` | same |
| `.jar` attach (Databricks) | works | Databricks N/A in IL5 — Synapse path only |

## Acceptance mapping

1. **Attach a curated AML Env** — selector/panel → `PATCH ?action=attach`; receipt = the ARM environment object returned in the attach response.
2. **List its real packages** — `environment.packages[]` extracted server-side from `condaFile`; rendered in the Packages tab (no mock data).
3. **`%pip install` then import** — Packages tab installs into the live session; next cell `import <pkg>` succeeds; receipt = the Livy statement `ok` output.
