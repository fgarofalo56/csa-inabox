# Parity gap — `databricks-job`

> v2 fabric-parity-loop validator, run 2026-05-26.
> Reference target: Databricks Workspace → Workflows → Jobs.
> Loom route: `https://<your-console-hostname>/items/databricks-job/new`.
> Editor source: `apps/fiab-console/lib/editors/databricks-editors.tsx` (lines 958-1269).

## Phase 3 — gap matrix vs Databricks Jobs UI

| # | Databricks Workflows element | Loom present? | Severity |
|---|---|---|---|
| 1 | Job list with name / id / task count | Present (lines 1129-1141) — real `/api/items/databricks-job` listing | OK |
| 2 | Schedule editor (Quartz cron + timezone + paused toggle) | Present (lines 1177-1182) — real, persisted | OK |
| 3 | Tasks table (task_key / notebook path / cluster / depends_on) | Present (lines 1184-1225) — editable rows with Add / Delete | OK |
| 4 | Per-task type selector (Notebook / Python wheel / dbt / SQL / JAR / Run pipeline / Spark Submit) | **MISSING** — Loom only supports `notebook_task` type (line 1034). Fabric / Databricks jobs support 10+ task types. | MAJOR |
| 5 | Task-level cluster selector (existing cluster vs new job cluster) | Partial — only `existing_cluster_id` (line 1033). No new-job-cluster definition path. | MAJOR |
| 6 | Visual DAG view of task dependencies | **MISSING** — Loom shows tasks as a flat editable table only. Databricks has a real DAG canvas with arrows for `depends_on`. | MAJOR |
| 7 | Run history with status + start + duration + creator | Present (lines 1233-1262) | OK |
| 8 | Drill-into-task run details (per-task duration + output) | MISSING | MAJOR |
| 9 | Retry policy / max concurrent runs / notifications / webhooks | MISSING — only `max_concurrent_runs: 1` hardcoded (line 1039) | MAJOR |
| 10 | Run now / Cancel run | Present (Run now line 1089-1108); Cancel not visible | MINOR |
| 11 | Delete job | Present (lines 1079-1087) with `confirm()` dialog | OK |
| 12 | Status bar | MISSING | MINOR |
| 13 | Permissions / Email + Slack notifications / Git source | MISSING | MAJOR |

## Phase 4 — functional click probe (source-trace)

| Control | Source impl | Live behavior |
|---|---|---|
| Job list selection | `selectJob(jid)` (line 999-1026) — real GET, populates form, loads runs | Real |
| **Save / Create** | `save()` (line 1047-1077) — real `POST` on create, `PUT` on update | Real |
| **Delete** | `del()` (line 1079-1087) — real `DELETE` with confirm dialog | Real |
| **Run now** | `runNow()` (line 1089-1108) — real `POST .../run`, refreshes runs table | Real |
| Add task | `setTasks([...arr, ...])` (line 1226-1229) — local state | Real |
| Delete task | `setTasks((arr) => arr.filter(...))` (line 1218-1219) — local state | Real |
| Field edits (name / cron / tz / task fields) | Local state | Real |
| Ribbon "Save" / "Delete" / "Run now" / "View runs" | No handlers | **DEAD** — 4 ribbon vapor |

## Grade

**B** — Save / Create / Delete / Run-now / Edit-tasks are all real-REST against Databricks Jobs 2.1 API. Schedule + dependencies are correctly persisted. No code editor needed in this surface, so the Monaco gap doesn't apply.

What keeps this from A: notebook-only task type (real Databricks jobs support 10+), no DAG view (flat table only — for a workflow editor that's a MAJOR), no retry/notification/source-control, 4 dead ribbon buttons.

Honestly the strongest of the 14 editors validated in this run — primary backend lifecycle is genuinely Fabric-parity. The missing pieces are scope expansions, not "lies in chrome."

