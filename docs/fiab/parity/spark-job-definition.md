# spark-job-definition — parity with Fabric Spark Job Definition

Source UI: https://learn.microsoft.com/fabric/data-engineering/spark-job-definition
Editor: `SparkJobDefinitionEditor` in `apps/fiab-console/lib/editors/phase2-misc-editors.tsx`

## Feature inventory

| # | Capability |
|---|---|
| 1 | Definition editor (main file, args, lakehouse refs) |
| 2 | Submit / Run |
| 3 | Run history + status |
| 4 | Edit metadata |

## Loom coverage

| # | Status | Notes |
|---|---|---|
| 1 | ✅ | Definition form (Edit group) |
| 2 | ✅ | `Submit` → `/spark-job-definition/[id]/submit` (Fabric Livy/job REST) |
| 3 | ✅ | `Refresh runs` → `/runs?size=20` |
| 4 | ✅ | Edit group wired |

## Backend per control
- Submit/runs → Fabric REST Spark job-definition APIs.

Grade: **A (definition + submit + run-history all real Fabric REST).**
