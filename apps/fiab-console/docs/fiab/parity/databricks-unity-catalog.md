# databricks-unity-catalog — parity with Azure Databricks Unity Catalog + Workspace

**Source UI:** Azure Databricks workspace → Catalog Explorer (catalogs / schemas /
tables / volumes / functions, grants, lineage) + the left sidebar (Jobs, Compute,
SQL Warehouses, Repos, **Delta Live Tables**, **Experiments**, **Models**,
**Serving**).
**Learn grounding:**
- Unity Catalog REST (api 2.1): catalogs/schemas/tables/volumes/functions, permissions — https://learn.microsoft.com/azure/databricks/data-governance/unity-catalog/
- Volumes — https://learn.microsoft.com/azure/databricks/volumes/
- Data lineage (preview) — https://learn.microsoft.com/azure/databricks/data-governance/unity-catalog/data-lineage
- Delta Live Tables (Lakeflow Declarative Pipelines) API — https://learn.microsoft.com/azure/databricks/delta-live-tables/api-guide
- MLflow model registry / experiments — https://learn.microsoft.com/azure/databricks/mlflow/
- Model serving — https://learn.microsoft.com/azure/databricks/machine-learning/model-serving/

**Auth:** Loom UAMI AAD token for resource `2ff814a6-3304-4ab8-85cb-cd0e6f879c1d`
(Azure Databricks), via `ChainedTokenCredential(ManagedIdentityCredential{LOOM_UAMI_CLIENT_ID}, DefaultAzureCredential)`. The UAMI is registered as a workspace
ServicePrincipal with `workspace-access`, `databricks-sql-access`,
`allow-cluster-create`, `allow-instance-pool-create`, **`databricks-jobs-api-access`**
(SCIM bootstrap — `databricks-scim-bootstrap.bicep`). UC write also requires the
relevant UC privileges (CREATE CATALOG/SCHEMA/TABLE/VOLUME, MANAGE) on the parents.
**Honest infra-gate:** `databricksConfigGate()` 503s naming `LOOM_DATABRICKS_HOSTNAME`;
the navigator + editor still render the gate MessageBar.

## Azure / Databricks feature inventory → Loom coverage → backend per control

| Databricks capability | Loom coverage | Backend per control |
| --- | --- | --- |
| **Unity Catalog browse** — catalogs / schemas / tables / volumes / functions | ✅ built | `GET /api/databricks/catalogs`, `/unity-catalog/tables?catalog=&schema=` → `listUcCatalogs/Schemas/Tables/Volumes/Functions` → UC REST 2.1 GETs |
| Create catalog (name + comment + managed storage root) | ✅ built (dialog) | `POST /api/databricks/unity-catalog/catalogs` → `createUcCatalog()` → `POST /api/2.1/unity-catalog/catalogs` |
| Create schema (catalog + name + comment) | ✅ built (dialog) | `POST …/schemas` → `createUcSchema()` → `POST /api/2.1/unity-catalog/schemas` |
| Create table (MANAGED/EXTERNAL + column editor + format) | ✅ built (dialog) | `POST …/tables` → `createUcTable()` → `POST /api/2.1/unity-catalog/tables` |
| Create volume (MANAGED/EXTERNAL + storage location) | ✅ built (dialog) | `POST …/volumes` → `createUcVolume()` → `POST /api/2.1/unity-catalog/volumes` |
| Drop catalog / schema (force/cascade) | ✅ built (Drop dialog) | `DELETE …/catalogs?name=&force=`, `…/schemas?full_name=&force=` → `deleteUcCatalog/Schema()` → UC REST DELETE |
| Drop table / volume | ✅ built (Drop dialog) | `DELETE …/tables?full_name=`, `…/volumes?full_name=` → `deleteUcTable/Volume()` → UC REST DELETE |
| GRANT / REVOKE on securable (CATALOG/SCHEMA/TABLE/VOLUME/FUNCTION/**METASTORE**) | ✅ built (Manage grants dialog) | `GET/PATCH …/grants` → `getUcPermissions/updateUcPermissions()` → `GET/PATCH /api/2.1/unity-catalog/permissions/{type}/{full_name}` |
| Effective (inherited) permissions view | ✅ built (effective toggle) | `getUcEffectivePermissions()` → `GET /api/2.1/unity-catalog/effective-permissions/{type}/{full_name}` |
| Column masks / row filters | ✅ built (Column & row security panel) | `uc-security-builders.ts` → SQL exec on the warehouse (Commercial/GCC) |
| Clone table (SHALLOW/DEEP) | ✅ built | warehouse SQL `CREATE TABLE … {SHALLOW\|DEEP} CLONE` |
| **Table lineage** graph (upstream + downstream) | ✅ built (Lineage tab + per-table button) | `GET /api/databricks/unity-catalog/lineage?full_name=` → `getTableLineage()` → `POST /api/2.0/lineage-tracking/table-lineage`; rendered on the shared React Flow `LineageCanvas` |
| **DLT pipelines** — list | ✅ built (tree group) | `GET /api/databricks/pipelines` → `listDltPipelines()` → `GET /api/2.0/pipelines` |
| DLT create | ✅ built (＋New dialog) | `POST /api/databricks/pipelines` → `createDltPipeline()` → `POST /api/2.0/pipelines` |
| DLT start / stop update | ✅ built (inline) | `POST …/pipelines {pipelineId,action}` → `startDltUpdate/stopDltUpdate()` → `POST /api/2.0/pipelines/{id}/updates`\|`/stop` |
| DLT delete | ✅ built (inline) | `DELETE …/pipelines?pipelineId=` → `deleteDltPipeline()` → `DELETE /api/2.0/pipelines/{id}` |
| **MLflow experiments** — list | ✅ built (tree group) | `GET /api/databricks/mlflow/experiments` → `listMlflowExperiments()` → `POST /api/2.0/mlflow/experiments/search` |
| MLflow experiment create | ✅ built (＋New dialog) | `POST …/mlflow/experiments` → `createMlflowExperiment()` → `POST /api/2.0/mlflow/experiments/create` |
| **MLflow registered models** — list | ✅ built (tree group) | `GET …/mlflow/models` → `listRegisteredModels()` → `GET /api/2.0/mlflow/registered-models/list` |
| Register model | ✅ built (＋New dialog) | `POST …/mlflow/models` → `createRegisteredModel()` → `POST /api/2.0/mlflow/registered-models/create` |
| Delete registered model | ✅ built (inline) | `DELETE …/mlflow/models?name=` → `deleteRegisteredModel()` → `DELETE /api/2.0/mlflow/registered-models/delete` |
| **Model serving endpoints** — list | ✅ built (tree group) / ⚠️ honest gov note | `GET /api/databricks/serving-endpoints` → `listServingEndpoints()` → `GET /api/2.0/serving-endpoints` |
| Serving endpoint create (model + version + scale-to-zero) | ✅ built (＋New dialog) | `POST …/serving-endpoints` → `createServingEndpoint()` → `POST /api/2.0/serving-endpoints` |
| Serving endpoint delete | ✅ built (inline) | `DELETE …/serving-endpoints?name=` → `deleteServingEndpoint()` → `DELETE /api/2.0/serving-endpoints/{name}` |
| External locations / storage credentials | ⚠️ deferred | created via bicep Access Connector + managed identity today; in-UI authoring deferred (separate task) |
| Lakeview dashboards / queries / alerts authoring | ⚠️ honest "coming" row | SQL alerts/queries client exists (`createDbxQuery/createDbxAlert`); the rich Lakeview authoring surface is tracked separately |

## Per-cloud matrix

| Feature | Commercial | GCC | GCC-High | DoD (IL5) |
| --- | --- | --- | --- | --- |
| Unity Catalog (catalogs/schemas/tables/volumes/grants) | Full (`ucSupported`) | Full (`ucSupported`) | Hive-only — honest gate (`ucSupported=false` in bicep) | Hive-only — honest gate |
| UC table lineage (preview) | Available | Available | Not enabled (preview off on gov) — honest MessageBar | Not enabled — honest MessageBar |
| DLT pipelines | Full | Full | Available (Premium) | Available |
| MLflow experiments / models | Full | Full | Available | Available |
| Model serving | Available | Available | Not GA — honest serving-unavailable note | Not GA — honest note |

The `databricksConfigGate()` (env) and the per-route error pass-through carry the
honest gating; the serving tree row and Lineage tab both render an honest Fluent
MessageBar quoting the service error when the surface is unavailable (gov / preview /
not provisioned) — never a fabricated list.

## Validation

- Vitest REST-contract suite: `lib/azure/__tests__/databricks-client-uc-write.test.ts`
  (14 tests) proves volume/DLT/MLflow/serving fns issue the exact method+URL+body.
- `tsc` clean on all touched files (filtered of makeStyles px-literal noise).
- E2E (operator, `LOOM_DEFAULT_FABRIC_WORKSPACE` unset): create catalog→schema→table,
  create volume, GRANT SELECT to a principal, create a DLT pipeline + start an update,
  register a model, open the Lineage tab on a table → verify the receipt in the BFF
  response and the object in the Databricks workspace.
