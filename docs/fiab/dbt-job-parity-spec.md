# Loom dbt Job Editor — Fabric-parity spec

> Captured 2026-05-26 by catalog agent. Source: Fabric Data Factory dbt-job docs (`learn.microsoft.com/fabric/data-factory/dbt-job-*`) + Fabric Warehouse dbt-fabric adapter tutorial + live `DbtJobEditor` in `apps/fiab-console/lib/editors/phase2-misc-editors.tsx`.

## Overview
Fabric dbt Job (Preview) brings dbt Core natively into the Fabric web experience: no local CLI, no Airflow, no external orchestrator. You author models in a Fabric-hosted dbt project, point it at a supported adapter (Fabric Warehouse, Snowflake, PostgreSQL, Azure SQL Database), and run `dbt build` / `dbt run` / `dbt test` / `dbt seed` / `dbt compile` / `dbt snapshot` directly. Runtime today is **dbtjob runtime v1.0** with dbt Core v1.9. Fits the "T" of ELT — runs after Mirroring / Copy Jobs / Dataflows have landed bronze tables.

## UI components

### Top toolbar (project workspace)
- **Build** / **Compile** / **Run** action buttons with a default mode (Build) and a Run trigger
- **Save** project changes
- **Advanced Settings** panel toggle (General + Run tabs)
- **dbt configurations** button — opens adapter / connection profile editor
- **Schedule** — bind to a Fabric pipeline trigger
- **Refresh runs** / **Open run history**

### Project tabs (left rail)
- **Explorer** — file tree showing the standard dbt project layout:
  ```
  my-dbt-project/
  ├── dbt_project.yml
  ├── models/
  │   ├── staging/
  │   ├── marts/
  │   └── analytics/
  ├── schema.yml
  ├── seeds/
  └── snapshots/
  ```
  Right-click on file: Rename / Delete / Open / Duplicate
- **Settings** — adapter config, schema, connection, concurrency, target profile
- **Output Panel** — real-time run logs, dbt output, error messages, structured per-model status

### dbt configurations / profile editor
- **Adapter picker** — Fabric Warehouse · Snowflake · PostgreSQL · Azure SQL Server
- **Connection** — server/endpoint, database/warehouse, schema, auth (Service Principal / Entra ID / Org account / basic where applicable; SQL auth disallowed on Fabric Warehouse)
- **Target name** (e.g. `prod`, `dev`, `ci`)
- **Threads** — parallel execution degree
- **profiles.yml** preview (auto-generated from form)

### Advanced Settings — General tab
- **Threads** — int (e.g. 4 for medium workloads)
- **Fail fast** — toggle; stops immediately on any resource failure
- **Full refresh** — toggle; forces rebuild of all incremental models from scratch
- **Apply** to save

### Advanced Settings — Run Settings tab
- **Run mode** radio:
  - **Run only selected models** — pick from the models tree (`orders`, `stg_customers`, etc.)
  - **Run with advanced selectors** — free-form dbt selector syntax (`tag:nightly`, `staging.*`, `+orders+`)
- **Selector builder**:
  - Selector name
  - Select (resources / tags / packages) list
  - Exclude list
  - Equivalent CLI shown live: `dbt run --select my_model`, `dbt build --exclude deprecated_models`

### Models tree / lineage view
- Hierarchical tree by directory (`staging` → `marts` → `analytics`) with per-model icons (model · seed · test · snapshot · source)
- Selectable for "Run only selected models" mode
- **Lineage / DAG view** — visual dependency graph between models with edges from `ref()` calls
- Per-node tooltip: last run status, last duration, last row count

### Run history & per-run drill-down
- Run list: timestamp · command (`dbt build` / `run` / `test`) · status (Queued · Running · Success · Failed · Cancelled) · duration · selector used · adapter
- **Per-run detail expansion**:
  - Per-model status table — model name · status · rows affected · execution time · error message
  - Per-test status — test name · status · failures count
  - Full dbt logs (`dbt.log` + structured `run_results.json`)
  - Compiled SQL viewer per model
- Cancel-running-run button
- Output size limit: 1 MB (run fails over with errorCode 2001)

### dbt docs site preview
- Generated `target/index.html` rendered inline — model descriptions, sources, columns, tests, lineage graph (the dbt-docs UI)

### Limitations surfaced in UI
- "No build caching" — every run compiles from source
- Incremental models need primary keys + unique constraints
- Some partner adapters unsupported

## What Loom has today
- **`DbtJobEditor`** (in `phase2-misc-editors.tsx`) — flat form, NOT a dbt project IDE
- Persists to Cosmos under `state.{repoUrl, branch, target, profilesYaml, models[], commands[], clusterId, databricksJobId}`
- Fields exposed:
  - Git repo URL + branch (Loom expects the dbt project to live in an external git repo)
  - Target profile name (string)
  - Model `--select` list (textarea, one per line)
  - Override commands (textarea — defaults to `dbt deps` + `dbt run --target <target> --select ...`)
  - `profiles.yml` blob (informational textarea, copied into the repo by the user)
  - Databricks cluster ID (existing all-purpose cluster)
- **Backend = Databricks Jobs API** (`/api/items/dbt-job/[id]/run`): materialises a Databricks Job with a single `dbt_task`, reuses `databricksJobId` across runs, triggers run-now
- Run history: `/runs` lists Databricks run lifecycle + result states, surfaced in a Fluent Table with Lifecycle / Result / Started / Ended / Message columns
- Ribbon shell wired through `ItemEditorChrome`
- Auth gate: requires Console SP with Databricks workspace access and an existing all-purpose cluster

**Grade today: C.** Functional end-to-end against real Databricks, but the experience is a single text-form — no dbt project IDE, no models tree, no lineage, no per-model run results.

## Gaps for parity
1. **No dbt project IDE** — no file tree, no Monaco SQL editor with Jinja highlighting, no `schema.yml` editor. Loom defers all authoring to the user's git repo + local IDE.
2. **No Fabric Warehouse adapter path** — Loom hard-runs on Databricks (`dbt-databricks` adapter implicit). Fabric dbt Job runs `dbt-fabric` against a Fabric Warehouse — Loom needs an `adapter` picker + matching execution path.
3. **No models tree** — `--select` is a free-text textarea; Fabric renders a clickable tree from the project's `manifest.json`.
4. **No lineage / DAG view** — dbt-docs lineage graph is a flagship Fabric feature; Loom has nothing.
5. **No advanced selector builder** — Loom users hand-type selector syntax; Fabric has a guided form.
6. **No per-model run results** — Loom shows Databricks lifecycle state only; needs to parse `run_results.json` from the workspace and display per-model success/failure with rows + duration.
7. **No Fail-fast / Full-refresh / Threads toggles** — must be embedded in user's override commands.
8. **No dbt docs preview** — `dbt docs generate` → `target/index.html` rendering inline.
9. **No `dbt seed` / `dbt snapshot` first-class buttons** — must use override commands.
10. **No schedule UI** — user wires their own cron in Databricks today.
11. **No output panel streaming** — Loom shows post-run lifecycle only, no live log stream during the run.

## Backend mapping
Two backends are valid:

### Option A — keep Databricks Jobs (incumbent, fastest)
- Existing: `POST /api/items/dbt-job/[id]/run` → Databricks Jobs `dbt_task` → SUCCESS/FAILED lifecycle
- Add: pull `run_results.json` + `manifest.json` from the Databricks task artifacts (DBFS / workspace files) to drive models tree + per-model results
- Add: `GET /api/items/dbt-job/[id]/manifest` — returns parsed `manifest.json` for the models tree
- Add: `GET /api/items/dbt-job/[id]/runs/{run_id}/results` — returns parsed `run_results.json` for per-model status
- Add: `GET /api/items/dbt-job/[id]/runs/{run_id}/logs?stream=true` — SSE stream of Databricks task logs

### Option B — Synapse / Azure Container Apps job runner (matches dbt-fabric adapter)
- Pre-built container image with `dbt-core` + `dbt-fabric` adapter
- ACA Job triggered per run, mounts the git repo, runs the override commands, writes `run_results.json` + `manifest.json` to a managed-identity-backed Storage container
- Profile points at the existing `synapse-dedicated-sql-pool` / `warehouse` item — closes the loop with the Fabric Warehouse parity story
- New BFF routes: `POST /api/items/dbt-job/[id]/run-aca`, `GET /api/items/dbt-job/[id]/aca-status`
- Recommended for net-new because it removes the Databricks dependency for shops that don't have a workspace

**Recommendation**: add Option B as a second adapter path (driven by the `adapter` picker), keep Option A as the default for existing users.

## Required Azure resources
**Option A (current)**:
- Databricks workspace + all-purpose or job cluster
- Service Principal with `Can Run` on the cluster
- Git repo accessible to Databricks (GitHub / ADO with PAT in Databricks secret scope)

**Option B (new, for Fabric Warehouse parity)**:
- Azure Container Apps environment (or AKS) for the dbt runner job
- ACR with the `dbt-core` + `dbt-fabric` image
- Storage Account for run artifacts (`manifest.json`, `run_results.json`, `dbt.log`, `target/index.html`)
- Managed Identity for ACA → ACR → Storage → Fabric Warehouse
- Target: existing Fabric Warehouse / Synapse Dedicated SQL Pool / Synapse Serverless / Azure SQL DB
- Git PAT / SSH key in Key Vault for repo clone

## Estimated effort
4-6 sessions:
- **Session 1**: parse `manifest.json` + `run_results.json` from Databricks artifacts → models tree + per-model results panel (closes the biggest UX gap on existing backend)
- **Session 2**: lineage / DAG view from `manifest.json` parents/children (Mermaid or React Flow)
- **Session 3**: Advanced Settings panel — Threads / Fail-fast / Full-refresh / Run-mode / selector builder
- **Session 4**: ACA-job backend (Option B) + adapter picker + `dbt-fabric` path
- **Session 5**: live log streaming (SSE from Databricks Jobs API or ACA job logs)
- **Session 6**: `dbt docs` preview iframe + `dbt seed` / `dbt snapshot` first-class buttons + schedule UI

MVP path to B: Sessions 1 + 3 + 5 — gets models tree, per-model results, advanced settings, live logs against the existing Databricks backend without infra changes.
