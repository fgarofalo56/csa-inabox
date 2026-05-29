# databricks-job — parity with Azure Databricks Jobs (Lakeflow)

Source UI: Databricks Jobs — https://learn.microsoft.com/azure/databricks/jobs/
Editor: `DatabricksJobEditor` in `apps/fiab-console/lib/editors/databricks-editors.tsx`

## Feature inventory

| # | Capability |
|---|---|
| 1 | Job list |
| 2 | Job detail (tasks, cluster, schedule) |
| 3 | Run now |
| 4 | Run history + run status |

## Loom coverage

| # | Status | Notes |
|---|---|---|
| 1 | ✅ | `/api/items/databricks-job` list |
| 2 | ✅ | `/databricks-job/[id]?jobId=` detail (jobs/get REST) |
| 3 | ✅ | `Run` → `/run` (jobs/run-now REST) |
| 4 | ✅ | `/runs?jobId=` history (jobs/runs/list REST) |

## Backend per control
- All controls → Azure Databricks Jobs REST 2.1 via Console UAMI.

Grade: **A (list + detail + run + run-history all real Databricks REST).**
