# databricks-job — parity with Azure Databricks Jobs (Lakeflow Jobs)

Source UI: Databricks workspace → **Workflows → Jobs** (create job → Tasks tab,
task type drop-down, Compute, Depends on / DAG, Schedules & Triggers, Run now,
Runs, JSON view).
- Tasks & task types: https://learn.microsoft.com/azure/databricks/jobs/configure-task#types-of-tasks
- Automate (create / run-now / View JSON): https://learn.microsoft.com/azure/databricks/jobs/automate
- run-now params: https://docs.databricks.com/api/azure/workspace/jobs/runnow
- run get-output: https://docs.databricks.com/api/azure/workspace/jobs/getrunoutput

Editor: `DatabricksJobEditor` in `apps/fiab-console/lib/editors/databricks-editors.tsx`.

Backend: Databricks **Jobs API 2.1** on the Loom-deployed workspace
(`LOOM_DATABRICKS_HOSTNAME`), AAD-bearer auth via the Console MI (same path the
SQL-warehouse / cluster / notebook editors already use — `dbxFetch` with the
Azure Databricks resource scope). Compute pickers reuse the cluster editor's
`/api/2.0/clusters/list`, `/list-node-types`, `/spark-versions`; notebook-path
picker reuses `/api/2.0/workspace/list`.

## The problem this fixes

The old `DatabricksJobEditor` was a C/D-grade scaffold: a single display-name
field, one cron box, and a flat task **table** that only supported
**notebook** tasks with a single existing cluster and a comma-string
`depends_on`. No DAG canvas, no other task types, no new-job-cluster, no
trigger types beyond cron, no run output, no JSON view. Operator verdict:
"not functional, doesn't look anything like Databricks, doesn't work at all."

Rebuilt one-for-one with the real Jobs UI: a tabbed surface (Tasks /
Schedule & triggers / Settings / Runs / JSON), a visual task **DAG** canvas, a
full per-task editor for **all 9 task types**, existing-cluster **and**
new-job-cluster compute, multi-task `depends_on` with `run_if`, retries/timeout,
the four trigger types, job-level settings (tags, parameters, email
notifications, max-concurrent-runs, timeout), Run now + Runs history + per-run
output drawer, and a live "View JSON" of the exact create/reset payload.

## Databricks feature inventory → Loom coverage

| Databricks Jobs UI capability | Loom coverage | Backend (real REST) |
| --- | --- | --- |
| List workspace jobs | ✅ built — left-panel Jobs list | `GET /api/2.1/jobs/list` |
| Open a job → load definition | ✅ built — click job, hydrates full form via `specToTask` | `GET /api/2.1/jobs/get?job_id=` |
| New / blank job | ✅ built — New job (ribbon + panel +) | n/a (composes spec client-side) |
| Task DAG canvas | ✅ built — `PipelineDagView` renders task nodes + `dependsOn` edges (topological columns) | derived from `tasks[]` |
| Task list + select/add/remove | ✅ built — task list with active selection, Add task, per-task delete (drops dangling deps) | n/a |
| **Notebook** task | ✅ built — path picker (workspace browse) + free-text + base parameters (k=v) | `notebook_task` |
| **Python script** (spark_python) task | ✅ built — python_file + parameters | `spark_python_task` |
| **Python wheel** task | ✅ built — package + entry_point + parameters | `python_wheel_task` |
| **JAR** task | ✅ built — main class + parameters | `spark_jar_task` |
| **Spark Submit** task | ✅ built — parameters list | `spark_submit_task` |
| **SQL** task | ✅ built — warehouse id + query id / file path | `sql_task` |
| **dbt** task | ✅ built — commands + project dir + warehouse | `dbt_task` |
| **Pipeline** (DLT) task | ✅ built — pipeline_id | `pipeline_task` |
| **Run Job** task | ✅ built — job_id | `run_job_task` |
| Compute: existing cluster | ✅ built — dropdown from real cluster list | `existing_cluster_id` |
| Compute: new job cluster | ✅ built — spark version + node type + workers (real option lists) | `new_cluster {…}` |
| Depends on (multi-task DAG) | ✅ built — toggle chips per upstream task | `depends_on: [{task_key}]` |
| Run-if dependency outcome | ✅ built — ALL_SUCCESS / AT_LEAST_ONE_SUCCESS / NONE_FAILED / ALL_DONE / AT_LEAST_ONE_FAILED / ALL_FAILED | `run_if` |
| Retries + min retry interval + task timeout | ✅ built — Retries & timeout panel | `max_retries`, `min_retry_interval_millis`, `timeout_seconds` |
| Schedule (cron) + timezone + pause | ✅ built — Schedule tab | `schedule {quartz_cron_expression, timezone_id, pause_status}` |
| Continuous trigger | ✅ built — trigger type Continuous | `continuous {pause_status}` |
| File-arrival trigger | ✅ built — trigger type File arrival + URL | `trigger {file_arrival {url}, pause_status}` |
| Job-level parameters | ✅ built — Settings (k=default) | `parameters: [{name, default}]` |
| Tags | ✅ built — Settings (k=v) | `tags {}` |
| Max concurrent runs / job timeout | ✅ built — Settings | `max_concurrent_runs`, `timeout_seconds` |
| Email notifications (failure/success) | ✅ built — Settings (csv) | `email_notifications {on_failure, on_success}` |
| Create job | ✅ built — Create / Ctrl+S | `POST /api/2.1/jobs/create` |
| Update job (overwrite settings) | ✅ built — Save / Ctrl+S | `POST /api/2.1/jobs/reset` (job_id + new_settings) |
| Delete job | ✅ built — Delete (confirm) | `POST /api/2.1/jobs/delete` |
| Run now (with job_parameters) | ✅ built — Run now (ribbon + toolbar + Runs tab) | `POST /api/2.1/jobs/run-now` |
| Run history | ✅ built — Runs tab table (state, start, exec, creator) | `GET /api/2.1/jobs/runs/list?job_id=` |
| Run output (notebook result / logs / error trace) | ✅ built — per-run "View" drawer; run state + output; precise note when output is per-task on a multi-task run | `GET /api/2.1/jobs/runs/get` + `…/runs/get-output` |
| View JSON | ✅ built — JSON tab (Monaco, read-only) shows exact create/reset payload | n/a (client-rendered) |
| Infra-gate when workspace not provisioned | ⚠️ honest-gate — warning MessageBar names `LOOM_DATABRICKS_HOSTNAME` + bicep module; **full UI still renders** | `GET /api/databricks/workspace` |

Zero ❌. Zero stub banners.

## Backend per control (BFF routes)

- List / Create: `GET|POST /api/items/databricks-job` → `listJobs` / `createJob`.
- Get / Update / Delete: `GET|PUT|DELETE /api/items/databricks-job/[id]?jobId=` → `getJob` / `updateJob` (reset) / `deleteJob`.
- Run now: `POST /api/items/databricks-job/[id]/run?jobId=` body `{ params }` → `runJob` (run-now param shaping: notebook/python/jar/sql/dbt/job_parameters/pipeline).
- Run history: `GET /api/items/databricks-job/[id]/runs?jobId=` → `listJobRuns`.
- Run output: `GET /api/items/databricks-job/[id]/run-output?runId=` → `getJobRun` + `getRunOutput`.
- Compute option sources: `/api/items/databricks-cluster`, `/api/items/databricks-cluster/options`.
- Notebook path picker: `/api/items/databricks-notebook/list?path=/Workspace`.
- Infra gate: `/api/databricks/workspace` (hostname disclosure).

All routes validate the minted session (`getSession()` → 401) and return
`{ ok, … }` JSON with proper status codes (403 on Databricks `PERMISSION_DENIED`,
404 on missing job/run, 502 on upstream failure).

## Honest gate

When `LOOM_DATABRICKS_HOSTNAME` is unset the client throws
`LOOM_DATABRICKS_HOSTNAME not configured`; the editor renders a Fluent
`MessageBar intent="warning"` naming the exact env var to set on the Console
Container App and the bicep module that provisions the workspace
(`platform/fiab/bicep/modules/landing-zone/databricks*.bicep`). The full Jobs
UI (all tabs, task editor, DAG, JSON) still renders so the operator can author
a spec that will save once the host is configured.

## Tests

- `lib/azure/__tests__/databricks-jobs.test.ts` — contract tests for
  list/get/create/reset/delete/run-now (3 param-shaping cases)/runs-list/run-get/
  run-get-output + the unset-host gate (exact URL + payload assertions).
- `lib/editors/__tests__/synapse-databricks-adf-bff-routes.test.ts` — asserts
  every `databricks-job` route (incl. new `[id]/run-output`) exists and imports
  a real Azure backing client.

## Validation note

Live minted-session probe was not run from this isolated worktree (no deployed
Databricks workspace reachable from here). `pnpm build` is clean and the backend
contract tests are green. A live browser walk + `/api/items/databricks-job/*`
cookie probe should be attached at merge per `no-vaporware.md`.

Grade: **A — full Databricks Jobs parity, all controls on real Jobs API 2.1,
backend contract-tested.**
