# databricks-cluster — parity with Azure Databricks Compute

Source UI: Databricks compute config — https://learn.microsoft.com/azure/databricks/compute/configure · https://learn.microsoft.com/azure/databricks/init-scripts/ · https://learn.microsoft.com/azure/databricks/compute/clusters-manage
Editor: `DatabricksClusterEditor` in `apps/fiab-console/lib/editors/databricks-editors.tsx`

## Feature inventory

| # | Capability | Source UI |
|---|---|---|
| 1 | Cluster list | Compute page |
| 2 | Create cluster (node type, runtime, autoscale) | Create button |
| 3 | Config tab (spark_conf, env vars) | Cluster detail → Advanced |
| 4 | Libraries tab | Cluster detail → Libraries |
| 5 | Init scripts tab | Cluster detail → Advanced → Init scripts |
| 6 | Event log tab | Cluster detail → Event log |
| 7 | Start / Stop / Restart | State controls |
| 8 | Delete | Cluster detail |

## Loom coverage

| # | Status | Notes |
|---|---|---|
| 1 | ✅ | `/api/items/databricks-cluster` list |
| 2 | ✅ | Create via POST `/databricks-cluster` with `/options` for node types/runtimes |
| 3 | ✅ | `config` tab shows spark_conf + env from `/clusters/get` |
| 4 | ✅ | `libraries` tab → `/libraries?clusterId=` (libraries/cluster-status REST) |
| 5 | ✅ | `init` tab shows init_scripts inline from cluster object |
| 6 | ✅ | `events` tab → `/events?clusterId=` (clusters/events REST) |
| 7 | ✅ | Start/Stop/Restart → `/state` (clusters/start|delete|restart REST) |
| 8 | ✅ | Delete wired |

Note: cluster spec *edit* surfaces an honest info message ("recreate to change spec") — Databricks edit API not exposed at this path; create + delete cover the lifecycle.

## Backend per control
- All controls → Azure Databricks REST 2.0/2.1 (clusters, libraries, events) via the Console UAMI token.

Grade: **A − (full lifecycle + config/libraries/init/events all real Databricks REST; spec-edit is an honest info message).**
