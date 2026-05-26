# Loom Synapse Spark Pool — Azure-Studio-parity spec

> Captured 2026-05-26. Source: Synapse Studio Manage hub (Apache Spark pools blade), Monitor hub (Apache Spark applications + Spark pools), and `apps/fiab-console/lib/editors/azure-services-editors.tsx` (`SynapseSparkPoolEditor`).

## Overview
Synapse Spark Pool is the workspace-attached Apache Spark compute (Big Data Pool resource type) that backs notebooks, Spark job definitions, and pipeline Spark activities. It auto-scales between min/max node counts (or fixed), auto-pauses after N idle minutes, and exposes PySpark / Scala / Spark SQL / .NET kernels through Livy. In the Azure-native data stack it pairs with Dedicated SQL (warehouse), Serverless SQL (lake queries), and ADLS Gen2 (storage) — and is the lift-equivalent of Fabric's Spark compute / Databricks job clusters.

## Synapse Studio UX

### Manage hub — Apache Spark pools blade
- **List** of Spark pools with status badge (Succeeded / Provisioning / Failed)
- **New** button: pool name, **node size** (Small 4vC/32GB → XXLarge 64vC/432GB, XXXLarge isolated 80vC/504GB), **Spark version** (currently 3.4 / 3.3), **autoscale on/off** with min/max nodes
- **Edit** pool: same fields + **Auto-pause** (toggle + minutes), **Dynamic executor allocation** (min/max executors), **Session-level packages** toggle, **Isolated compute** toggle, **Allow Spark applications to use library requirements files**
- **Packages** sub-blade: **workspace packages** (whl/jar uploads), **requirements.txt** upload, **Apply** button (forces session restart if Force-apply enabled)
- **Tags** + **Properties** (creation date, resource ID)
- Delete button

### Develop hub — Notebook tab (attached to a Spark pool)
- Pool picker + language picker (PySpark / Scala / Spark SQL / .NET Spark)
- **Attach / Detach** session, **Configure session** (driver/executor cores+memory, num executors, conf overrides)
- Run cell / Run all / Cancel; status badge per cell

### Monitor hub — Apache Spark pools
- **vCore usage** chart per pool over time
- **Active applications** per pool

### Monitor hub — Apache Spark applications
- Table of all submitted applications (notebook sessions, batch jobs, pipeline-triggered)
- Per-application detail: **state**, **submitter**, **app id**, **livy id**, **duration**, **driver/executor logs**, **Spark UI link**, **diagnostic events**

## What Loom has today (`SynapseSparkPoolEditor` in `azure-services-editors.tsx`)
- Fluent UI `ItemEditorChrome` with `SYN_SPARK_RIBBON` and three primary tabs: **Configuration** · **Submit batch job** · **Recent batches**
- **Pool list tree** on the left, real ARM data via GET `/api/items/synapse-spark-pool/list` → `listSparkPools()` (`Microsoft.Synapse/workspaces/{ws}/bigDataPools` api-version 2021-06-01)
- **Selected pool header**: provisioningState badge (Succeeded/Provisioning/...), node size, Spark version, autoscale badge (`min-max nodes` or fixed `N nodes`), **Force pause** + **Reset auto-pause** + **Refresh** buttons
- **Force pause / Reset auto-pause** → POST `/api/items/synapse-spark-pool/[id]/state` with `{action: 'pause'|'resume'}`. Honest: there is no ARM start/stop verb for Spark pools, so "pause" sets `autoPause.delayInMinutes = 1` and "resume" restores to 15. The route is documented inline and the UI labels are accurate
- **Configuration tab**: read-only fields (pool name, node size, Spark version, auto-pause delay, autoscale min, autoscale max) populated from `getSparkPool()`. Caption notes "Edit via Synapse Studio for now; v2.2 wires inline PUT"
- **Submit batch job tab**: form for `name`, `file` (abfss:// or wasbs:// URI), main class (JAR only), space-separated args. POSTs to `/api/items/synapse-spark-pool/[id]/submit` → `submitSparkBatchJob()` against Livy at `{ws}.dev.azuresynapse.net/livyApi/versions/2019-11-01-preview/sparkPools/{pool}/batches?detailed=true`
- **Recent batches tab**: GET `/api/items/synapse-spark-pool/[id]/runs?size=20` → `listSparkBatchJobs()`; table with id, name, state, result (Succeeded/Failed/Cancelled colored badge), appId, submitter
- Notebook integration: the `submitLivyBatch` / `createLivySessionAsync` / `submitLivyStatement` helpers in `synapse-dev-client.ts` are wired up to the notebook editor's "Run notebook" path, so the Spark pool is the actual execution target for Loom's PySpark notebook runs

## Gaps for parity (numbered)
1. **Editable Configuration tab** — fields are read-only with a Caption telling the user to edit in Studio. PUT route + `upsertSparkPool()` already exist (`/api/items/synapse-spark-pool/[id]` PUT in `route.ts`); UI just needs to flip inputs to editable + an explicit Save button
2. **New pool / Delete pool** — `upsertSparkPool` (PUT to a new name) and `deleteSparkPool` ARM helpers exist; not surfaced in UI
3. **Library requirements / workspace packages** — partial via the Environment editor in `phase2-misc-editors.tsx` (which PUTs `libraryRequirements.content` onto the pool); not exposed directly from the Spark Pool editor itself
4. **Dynamic executor allocation toggle + min/max executors** — present in `SparkPool.properties.dynamicExecutorAllocation` shape but not in the form
5. **Session-level packages / Isolated compute** toggles
6. **Batch job — full submission shape** — Studio's Livy submission supports `pyFiles`, `files`, `archives`, `conf`, `driverMemory`, `driverCores`, `executorMemory`, `executorCores`, `numExecutors`, `jars`, `tags`. Loom form only collects `name`, `file`, `className`, `args` (the rest flow through `SparkBatchRequest` but aren't form fields)
7. **Cancel running batch** — `cancelSparkBatchJob()` helper exists; no Cancel button on the runs table rows
8. **Batch detail drill-down** — Studio shows driver/executor logs, Spark UI link, diagnostic events per app. Loom shows row summary only
9. **Apache Spark applications view** (Monitor hub) — Loom Recent batches list is per-pool, not workspace-wide
10. **Pool vCore usage chart** — Monitor hub timeline not surfaced
11. **Session config UI for notebooks** — driver/executor cores+memory currently hard-coded to `4g`/`4 cores`/`2 executors` in `createLivySessionAsync`; no per-run override surface

## Backend mapping
| Capability | Backend module | Notes |
|---|---|---|
| List / get / upsert / delete pool | `lib/azure/synapse-dev-client.ts` (`listSparkPools`, `getSparkPool`, `upsertSparkPool`, `deleteSparkPool`) | ARM REST `Microsoft.Synapse/workspaces/{ws}/bigDataPools` api-version 2021-06-01 |
| Submit / list / get / cancel batch | Same module (`submitSparkBatchJob`, `listSparkBatchJobs`, `getSparkBatchJob`, `cancelSparkBatchJob`) | Livy at `{ws}.dev.azuresynapse.net/livyApi/versions/2019-11-01-preview/sparkPools/{pool}/batches`, scope `https://dev.azuresynapse.net/.default` |
| Interactive sessions (notebooks) | `createLivySessionAsync` / `getLivySession` / `submitLivyStatement` / `getLivyStatement` | Used by notebook editor's run path; polls session until `idle` with 60s × 3s back-off |
| Pause/resume state route | `app/api/items/synapse-spark-pool/[id]/state/route.ts` | Mutates `autoPause.delayInMinutes` (no ARM start/stop verb on Spark pools — Loom's choice is correct and documented inline) |
| Library requirements PUT | Indirect via Environment editor in `phase2-misc-editors.tsx` → PUT `/api/items/synapse-spark-pool/[id]` with `libraryRequirements` in properties |

## Required Azure resources
- Azure Synapse Analytics workspace
- Spark Big Data Pool (`Microsoft.Synapse/workspaces/bigDataPools`)
- Workspace UAMI with **Synapse Administrator** at the workspace (for ARM bigDataPools/* + Livy)
- Private endpoint to `{ws}.dev.azuresynapse.net` on the spoke VNet
- ADLS Gen2 with `Storage Blob Data Contributor` for the UAMI (Spark reads/writes lake data)
- Env: `LOOM_SYNAPSE_WORKSPACE`, `LOOM_DLZ_RG`, `LOOM_SUBSCRIPTION_ID`, `LOOM_UAMI_CLIENT_ID`
- Bicep wires pool + role assignments + dev-endpoint PE in `platform/fiab/bicep/modules/synapse/*.bicep`

## Estimated effort to close remaining gaps
- Items 1, 4, 5 (editable Configuration with all autoscale/exec-allocation/isolated toggles + Save): **0.5 session** — PUT route + ARM helper already exist
- Items 2 (New / Delete pool): **0.25 session** — same PUT/DELETE; needs a small "New pool" dialog
- Item 6 (full batch submission form): **0.25 session** — fields exist in `SparkBatchRequest`, form just needs expansion + advanced-collapsible section
- Item 7 (Cancel batch on row): **0.1 session** — wire `cancelSparkBatchJob` to a trash icon column
- Items 8, 9, 10 (per-app drill-down + workspace-wide app list + vCore chart): **1 session** — needs new Livy `apps` listing across pools + Monitor-equivalent BFF route + recharts wrapper
- Item 11 (session config override for notebook runs): **0.25 session** — already plumbed in `SparkBatchRequest`; surface in notebook editor

**Total to A+**: ~2.5 sessions. Today's grade is honest A — Spark pool listing, pause/resume (semantic), batch submission, batch history, and notebook execution all work end-to-end against real ARM + real Livy. Gaps are all on the management/observability surface, not the primary "run a Spark job" action.
