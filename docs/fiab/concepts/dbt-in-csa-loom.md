# dbt in CSA Loom

dbt (data build tool) is an open-source transformation framework that
applies software-engineering practices — version control, testing,
documentation, modular SQL models — to the "T" of ELT pipelines. In
CSA Loom, dbt is a first-class item type called **dbt job** that runs
dbt Core against your lakehouse or warehouse backend.

## How dbt fits in the Loom data flow

Loom follows a medallion architecture: raw data lands in the Bronze
layer (via Mirroring Engine or data pipelines), gets cleaned into the
Silver layer, and business-ready aggregates are produced in the Gold
layer. dbt owns the Silver → Gold transformation step: you write SQL
`ref()` models, Loom runs them on your chosen compute backend, and the
output Delta tables feed your semantic models and reports.

```
Bronze (raw)  →  dbt models  →  Gold (business semantics)
                  (Silver + Gold
                   transformations)
```

## The dbt job item type

In the Loom Console, a **dbt job** (`/items/dbt-job/<id>`) is a
workspace item that stores a dbt project configuration in Cosmos DB and
triggers runs via the backend compute layer. Fields the editor captures:

- **Git repo URL + branch** — the dbt project lives in your own git
  repository; Loom clones it at run time.
- **Target profile** — the `profiles.yml` target (e.g. `prod`, `dev`).
- **Model select filter** — `--select` arguments (e.g. `staging.*`,
  `tag:nightly`).
- **Override commands** — defaults to `dbt deps` then `dbt run
  --target <target> --select <filter>`; supports `build`, `test`,
  `seed`, `compile`.
- **Cluster / job ID** — the Databricks cluster or job used to execute
  the run.

Run history surfaces Databricks run lifecycle states (Queued / Running
/ Succeeded / Failed / Cancelled) in a Fluent UI table with start/end
time and a link to the Databricks run page.

## Backends

**Default — Databricks Jobs API.** Loom materializes a Databricks Job
with a `dbt_task`, reuses the job ID across runs, and triggers
`run-now`. The `dbt-databricks` adapter runs the models against the
workspace's Delta tables. Required env vars:

| Var | Purpose |
|---|---|
| `LOOM_DATABRICKS_HOST` | Databricks workspace URL |
| `LOOM_DATABRICKS_TOKEN_SECRET` | Key Vault ref to the service-principal PAT |
| `LOOM_UAMI_CLIENT_ID` | Console UAMI used for auth |

**Option B (roadmap) — ACA Job runner + dbt-fabric adapter.** An Azure
Container Apps job runs `dbt-core` + `dbt-fabric` against a Synapse
Dedicated SQL pool, removing the Databricks dependency for shops that
don't have a Databricks workspace. This path is tracked in the
[dbt parity spec](../dbt-job-parity-spec.md) as Option B.

## Gov compatibility

The Databricks-backed path runs in all Loom boundaries where Databricks
is available (Commercial, GCC, GCC-H / IL4). The ACA runner path
extends coverage to IL5 once v1.1 ships, because ACS jobs are available
on AKS in DoD IL5 where Container Apps are not.

The dbt project itself is boundary-agnostic: the same SQL models and
`profiles.yml` that run in Commercial run in Gov — the adapter target
changes, the model code does not.

## Parity notes

The current dbt job editor is a functional flat form; it is not a
full dbt project IDE. The
[dbt parity spec](../dbt-job-parity-spec.md) documents the full gap
list (no models tree, no lineage DAG view, no per-model run results,
no live log streaming). Those gaps are on the backlog; the core
run/schedule/history loop is working today.

## Get started

1. Push your dbt project to a git repository accessible from your
   Loom workspace (GitHub, Azure DevOps).
2. In the Loom Console, open a workspace and create a new **dbt job**
   item.
3. Set the repo URL, branch, target, and select filter.
4. Click **Save**, then **Run**.
5. The run history table shows Databricks run status; follow the run
   page link for full dbt logs.

Reference: [dbt job workload page](../workloads/dbt-job.md) and the
[dbt parity spec](../dbt-job-parity-spec.md).
