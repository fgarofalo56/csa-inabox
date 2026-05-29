# synapse-spark-pool — parity with Synapse Apache Spark pool

Source UI: Synapse Studio Spark pool — https://learn.microsoft.com/azure/synapse-analytics/spark/apache-spark-pool-configurations
Editor: `SynapseSparkPoolEditor` in `apps/fiab-console/lib/editors/azure-services-editors.tsx`

## Feature inventory

| # | Capability | Source UI |
|---|---|---|
| 1 | Pool list + provisioning state | Manage hub |
| 2 | Scale (node count / size) | Manage |
| 3 | Auto-pause config | Manage |
| 4 | Force pause / resume | Manage |
| 5 | Submit Spark job / batch | Develop |
| 6 | Run history | Monitor |
| 7 | Author notebook / Spark code against pool | Develop |

## Loom coverage

| # | Status | Notes |
|---|---|---|
| 1 | ✅ | `/list` pools tree + state badge (ARM) |
| 2 | ✅ | `Scale` dialog → `/scale` (ARM) |
| 3 | ✅ | `Auto-pause` dialog → `/auto-pause` (ARM) |
| 4 | ✅ | `Pause` ribbon now wired → `setAutoPause('pause')` (`/state`); Force pause/Reset buttons too |
| 5 | ✅ | `Submit Spark job` → `/submit` (Livy batch REST) |
| 6 | ✅ | `/runs` history |
| 7 | ✅ | `Open notebook` now opens the submit tab (author + submit code to this pool) |

## Backend per control
- State/scale/auto-pause → ARM Microsoft.Synapse bigDataPools. Submit/runs → Synapse dev Livy endpoint.

Grade: **A — every inventory row built; the two former "deferred" ribbon buttons (Pause, Open notebook) are now wired to real handlers.**
