# databricks-notebook — parity with Azure Databricks Notebooks

Source UI: Databricks Workspace notebooks — https://learn.microsoft.com/azure/databricks/notebooks/
Editor: `DatabricksNotebookEditor` in `apps/fiab-console/lib/editors/databricks-editors.tsx`

## Feature inventory

| # | Capability |
|---|---|
| 1 | Workspace tree (folders + notebooks) |
| 2 | Open notebook source |
| 3 | Save / edit source |
| 4 | Run (one-time submit on a cluster) |
| 5 | Run history + status |
| 6 | Reload / refresh tree |

## Loom coverage

| # | Status | Notes |
|---|---|---|
| 1 | ✅ | `/databricks-notebook/list?path=` (workspace/list REST) |
| 2 | ✅ | `/databricks-notebook/[id]?path=` export source |
| 3 | ✅ | PUT `/databricks-notebook/[id]` (workspace/import REST) |
| 4 | ✅ | `/run` (jobs/runs/submit REST) |
| 5 | ✅ | `/runs` history + active run poll |
| 6 | ✅ | Reload + Refresh tree wired |

## Backend per control
- All controls → Azure Databricks Workspace + Jobs REST via Console UAMI.

Grade: **A (tree + open + save + run + history all real Databricks REST).**
