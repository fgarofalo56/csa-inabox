# Loom Databricks Job Editor — Parity build spec

> Reference: Azure Databricks **Workflows / Lakeflow Jobs** UI (`adb-<id>.azuredatabricks.net/jobs`). Jobs are the orchestration primitive: one or more tasks arranged as a DAG, triggered on a schedule, on continuous, on file arrival, or manually.

## Why this exists

Loom ships `DatabricksJobEditor` in `lib/editors/databricks-editors.tsx` plus API routes at `/api/items/databricks-job/**`. Today it lists jobs (`listJobs`), reads job spec (`getJob`), creates / updates / deletes (`createJob` / `updateJob` / `deleteJob`), runs now (`runJob` → `runNow`), and lists run history (`listJobRuns`). DAG editing is a flat task table with `task_key`, notebook path, cluster, and CSV `depends_on`. That's **A-grade** — real Lakeflow Jobs API, real DAG persistence, real runs. Polish gaps are about visual DAG, broader task types, and notification config.

## Databricks Workflows UX inventory (Workflows / Jobs UI)

### Jobs list page (`/jobs`)

| Region | Elements |
|---|---|
| **Header** | "Jobs" title · Create job button · Filter (owner / tag / status) · Search |
| **Table** | Name · Tasks count · Last run time · Last run status · Triggered by · Created by · Tags |
| **Row action** | Pause/unpause schedule · Run now · Edit · Delete · Permissions |

### Job detail / editor page

| Tab | Contents |
|---|---|
| **Tasks** | Visual DAG canvas — nodes are tasks, edges are `depends_on`. Click a node → right panel: Task name · Task type · Source · Path · Cluster · Parameters · Retries · Timeout · Email/webhook notifications · Run if dependencies |
| **Runs** | Run history table (run_id, state, duration, trigger, parameters); click a run → per-task timeline, output, logs, Spark UI link |
| **Job details** | Tags · Permissions (ACL) · Notifications (job-level) · Maximum concurrent runs · Run as (user / SP) · Git source · Job parameters · Queue · Health rules |
| **Schedules & triggers** | None / Scheduled (cron + timezone, pause/unpause) / Continuous / File arrival / Table update |

### Task types supported by Lakeflow Jobs

- **Notebook** (most common) — path + base_parameters
- **Python script** — workspace path / DBFS / Git
- **Python wheel** — package + entry_point
- **JAR** — main_class + parameters
- **SQL** — File / Query / Alert / Dashboard / Legacy dashboard
- **Pipeline** — Lakeflow Spark Declarative Pipeline
- **Run Job** — chain another job (max nesting 3)
- **If/else condition** — branching with boolean expression
- **For each** — looping over an input array
- **dbt** — dbt project run
- **Spark Submit** — legacy

### Compute per task

- **Job cluster** (preferred, cheaper) — spec defined in the job, ephemeral per run
- **Existing all-purpose cluster** — `existing_cluster_id` (what Loom uses today)
- **Serverless** — no cluster spec needed; managed compute

### Notifications

- **Email**: on_start / on_success / on_failure / on_duration_warning_threshold_exceeded / on_streaming_backlog_exceeded
- **Webhook**: integrate with PagerDuty, Slack, Teams
- **System destinations**: notification destinations configured by admin

### Retries / timeouts

- Per-task: `max_retries`, `min_retry_interval_millis`, `retry_on_timeout`, `timeout_seconds`
- Per-job: `timeout_seconds`, `max_concurrent_runs`

### Parameters

- **Job parameters** — defined once at job level, accessible as `{{job.parameters.<key>}}`
- **Task parameters** — task-specific overrides
- **Dynamic value references** — `{{job.id}}`, `{{job.run_id}}`, `{{job.start_time.[iso_date]}}`, `{{tasks.<task_key>.values.<key>}}`

---

## What Loom has today (wired)

| Capability | Backend | UI |
|---|---|---|
| List jobs | `GET /api/items/databricks-job` → `listJobs()` → `/api/2.1/jobs/list` | Left panel |
| Read job spec | `GET /api/items/databricks-job/[id]?jobId=` → `getJob()` → `/api/2.1/jobs/get` | Form populates name/cron/tz/tasks |
| Create job | `POST /api/items/databricks-job` → `createJob()` → `/api/2.1/jobs/create` | Save (when no jobId) |
| Update job | `PUT /api/items/databricks-job/[id]?jobId=` → `updateJob()` → `/api/2.1/jobs/reset` | Save (when jobId) |
| Delete job | `DELETE …?jobId=` → `deleteJob()` → `/api/2.1/jobs/delete` | Delete button |
| Run now | `POST …/run?jobId=` → `runJob()` → `/api/2.1/jobs/run-now` | Run now button |
| Run history | `GET …/runs?jobId=` → `listJobRuns()` → `/api/2.1/jobs/runs/list` | Runs table |
| Schedule | UI checkbox + cron + timezone → persists as `schedule.quartz_cron_expression` | Switch + 2 inputs |
| Tasks DAG | CSV `depends_on` text field per task row | Table with rows |

Status: **A-grade**. Real Lakeflow Jobs end-to-end. No mocks. Limitation: only `notebook_task` with `existing_cluster_id` is exposed in the form (other fields round-trip in the spec but aren't editable).

## Gaps for parity (polish)

1. **Visual DAG canvas** — current "depends_on csv" works but isn't visual. Add a React-Flow / dagre canvas showing tasks as nodes, dependencies as edges; drag-to-connect. The job spec already has full DAG info from `getJob()`.
2. **More task types** — add type picker per task: `notebook`, `python_wheel`, `sql_file`, `pipeline`, `run_job`, `if_else_condition`, `for_each_task`. Each renders a different sub-form. Backend already passes full spec through.
3. **Job-cluster (new_cluster)** option — currently only `existing_cluster_id`. Add radio "Existing cluster | New job cluster | Serverless"; for "new job cluster", reuse the cluster spec form (node type, spark version, autoscale).
4. **Retry / timeout per task** — surface `max_retries`, `min_retry_interval_millis`, `timeout_seconds`, `retry_on_timeout`.
5. **Run if dependencies** — `ALL_SUCCESS` (default) · `AT_LEAST_ONE_SUCCESS` · `NONE_FAILED` · `ALL_DONE` · `AT_LEAST_ONE_FAILED` · `ALL_FAILED`.
6. **Notifications** — `email_notifications` + `webhook_notifications` editor (job-level and per-task).
7. **Job parameters** — top-level `parameters: [{name, default}]` editor; passed in run-now dialog as overrides.
8. **Triggers beyond cron** — File arrival trigger (`file_arrival_trigger`), Continuous, Table update. Each is a discriminated union in the spec.
9. **Run detail drilldown** — click a run → side drawer with per-task timeline, output, logs link, Spark UI link. Backend: `GET /api/2.1/jobs/runs/get?run_id=&include_history=true` + `get-output`.
10. **Permissions** — `/api/2.0/permissions/jobs/<job_id>` GET + PATCH (Owner / Can Manage / Can Manage Run / Can View).
11. **Pause/unpause schedule** — quick toggle from list, not just from edit form. Wire `pause_status: PAUSED|UNPAUSED` via `updateJob`.
12. **Tags** — `tags: { key: value }` editor for cost-allocation.

## Backend mapping

- List: `GET /api/2.1/jobs/list?limit=50&expand_tasks=false` (wired)
- Get: `GET /api/2.1/jobs/get?job_id=` (wired)
- Create: `POST /api/2.1/jobs/create` (wired)
- Update: `POST /api/2.1/jobs/reset` (wired)
- Update partial: `POST /api/2.1/jobs/update` (not yet used; useful for pause toggle)
- Delete: `POST /api/2.1/jobs/delete` (wired)
- Run now: `POST /api/2.1/jobs/run-now` (wired)
- Cancel run: `POST /api/2.1/jobs/runs/cancel` (not yet exposed)
- Repair run: `POST /api/2.1/jobs/runs/repair` (not yet exposed)
- Runs list: `GET /api/2.1/jobs/runs/list?job_id=` (wired)
- Run get: `GET /api/2.1/jobs/runs/get?run_id=` (wired)
- Run output: `GET /api/2.1/jobs/runs/get-output?run_id=` (wired)
- **NEW for ACL**: `GET /api/2.0/permissions/jobs/<id>` · `PATCH` same path

## Required Azure resources

- **Azure Databricks workspace** (existing — same as notebook editor)
- **UAMI as workspace user with Workflow create permission** (already granted via SCIM bootstrap)
- **Clusters** to attach tasks to (reuses cluster editor's list)
- No new Bicep needed.

## Estimated effort

| Gap | Hours |
|---|---|
| Visual DAG canvas (React Flow + dagre layout) | 5 |
| Multi-task-type form (notebook / python / sql / pipeline / run_job / if_else / for_each) | 4 |
| New-cluster + serverless compute options per task | 2 |
| Retry / timeout / run-if-dependencies fields | 1.5 |
| Notifications editor (email + webhook) | 2 |
| Job parameters + run-now-with-params dialog | 1.5 |
| Triggers beyond cron (file arrival, continuous) | 2 |
| Run detail drawer (per-task timeline + logs) | 2 |
| Permissions panel | 1.5 |
| Pause toggle + tags | 1 |
| **Total** | **~22.5 hrs** (3-4 focused sessions) |
