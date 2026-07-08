# airflow-job — parity with the Fabric **Apache Airflow job** (Azure-native managed Airflow)

> **Standalone editor.** `slug: airflow-job`, category **Azure Data Factory** /
> Data-workflows. Editor: `AirflowJobEditor` in
> `apps/fiab-console/lib/editors/airflow-job-editor.tsx`. This is Loom's parity
> for **Microsoft Fabric → Apache Airflow job** and **Azure Data Factory →
> Workflow Orchestration Manager (Managed Airflow)** — both are managed upstream
> Apache Airflow.

**Catalog description:** an Apache Airflow orchestration job — author/schedule
DAGs against an Airflow webserver.

**No-Fabric note (canonical Azure-native backend).** Loom delivers the *same*
managed-Airflow experience **without** a Fabric capacity or an ADF WOM
environment by running the OSS `apache/airflow` image on **Azure Container Apps**
(`platform/fiab/bicep/modules/admin-plane/airflow.bicep`, rel-T86): a webserver +
scheduler pair, an **Azure Database for PostgreSQL Flexible Server** metadata DB,
and **Azure Files** DAG + logs shares. The Console reaches the webserver over the
CAE VNet (internal ingress only) and speaks the stable Airflow REST API
(`/api/v1/dags`, `/dagRuns`, `/taskInstances`). BYO webserver stays an opt-in
per-item override. There is **no** Fabric/Power BI call on any path.

Source UI: **Fabric Apache Airflow job** + **ADF Managed Airflow (WOM)** + the OSS Airflow UI
- Fabric Apache Airflow jobs: <https://learn.microsoft.com/fabric/data-factory/apache-airflow-jobs-concepts>
- ADF Managed Airflow (Workflow Orchestration Manager): <https://learn.microsoft.com/azure/data-factory/concept-managed-airflow>
- Apache Airflow stable REST API: <https://airflow.apache.org/docs/apache-airflow/stable/stable-rest-api-ref.html>

## Managed-Airflow — feature inventory

| # | Capability | Notes |
|---|-----------|-------|
| 1 | **DAGs list** — id, schedule, paused/active, owners, tags, last run | main grid |
| 2 | **Pause / unpause** a DAG | is_paused toggle |
| 3 | **Trigger DAG run** (manual, optional conf/params) | trigger |
| 4 | **DAG runs** — history per DAG: run id, state, logical/queued/start/end times | runs list |
| 5 | **Task instances + logs** — per-run task states, try number, log tail | task logs |
| 6 | **Connections** — Airflow connections (conn_id, type, host, login) for DAGs | admin |
| 7 | **Variables / Pools / Config** — Airflow admin objects | admin |
| 8 | **DAG source** — provide DAG `.py` in Blob/Files share (or Git-sync) | dags share |
| 9 | **Environment settings** — webserver URL, auth, plugins/requirements, scale | manage |
| 10 | **Open the Airflow UI** directly | deep-link |

## Loom coverage

Tabs: **DAGs · Runs · Connections · Settings**. Job metadata (name, webserver
URL, git repo) persists in Cosmos (`itemsContainer`); DAG/run/log data is live
from the Airflow REST API through the BFF. Managed host = `LOOM_AIRFLOW_ENDPOINT`
(+ `LOOM_AIRFLOW_USERNAME`/`_PASSWORD` Basic auth); BYO host = per-item
`webserverUrl` (+ `LOOM_AIRFLOW_BEARER` or Basic). When neither is set the editor
renders its full surface plus an honest MessageBar naming
`airflow.bicep`/`LOOM_AIRFLOW_ENDPOINT`.

| # | Capability | Status | Detail |
|---|-----------|--------|--------|
| 1 | DAGs list | built ✅ | **DAGs** tab lists live DAGs (id, schedule, paused) via `/dags` route |
| 2 | Pause / unpause | built ✅ | per-DAG toggle → `PATCH …/dags` (is_paused) |
| 3 | Trigger DAG run | built ✅ | **Trigger** → `POST …/dag-runs` |
| 4 | DAG runs | built ✅ | **Runs** tab: DAG picker + run history (state/times) via `…/dag-runs` |
| 5 | Task instances + logs | built ✅ | expand a run → task list + **task-logs** (`…/task-logs?dagId&runId&taskId&tryNumber`) |
| 6 | Connections | built ✅ | **Connections** tab → `…/connection` (create/test against the live webserver) |
| 7 | Variables / Pools / Config | MISSING ❌ | not surfaced (DAGs/Runs/Connections/Settings only) |
| 8 | DAG source / Git repo | built ✅ (config) ⚠️ | job stores an optional **Git repo** URL; actual DAG `.py` delivery is the Azure Files `dags` share (WOM-equivalent) — no in-UI file upload |
| 9 | Environment / Settings | built ✅ | **Settings** tab: point the job at a webserver URL (BYO) or use the managed host; honest gate when unset |
| 10 | Open Airflow UI | built ✅ | link to the webserver URL |

## Backend per control

| Loom control | Route | Backend |
|--------------|-------|---------|
| Job list / create / detail | `GET`/`POST /api/items/airflow-job`, `…/{id}` | Cosmos `itemsContainer` (job metadata) |
| DAGs list / pause | `…/{id}/dags` GET/PATCH | Airflow REST `GET`/`PATCH /api/v1/dags` |
| DAG runs / trigger | `…/{id}/dag-runs` GET/POST | Airflow REST `/api/v1/dags/{id}/dagRuns` |
| Task logs | `…/{id}/task-logs` | Airflow REST `/api/v1/…/taskInstances/{task}/logs/{try}` |
| Connection test | `…/{id}/connection` POST | live `GET /api/v1/dags` probe against the webserver |
| Host resolution / honest gate | `lib/airflow/endpoint.ts` | `LOOM_AIRFLOW_ENDPOINT` (ACA host from `airflow.bicep`) or BYO `webserverUrl` |

**Grade: B.** Full managed-Airflow operator experience — DAGs, pause/unpause,
trigger, run history, task logs, and connections — running one-for-one against a
real Azure-native OSS-Airflow host (ACA + PostgreSQL + Files), with an honest
config gate and BYO override, and **zero** Fabric dependency. Gaps: Airflow admin
objects (**Variables / Pools / Config**) and an in-UI **DAG file upload** (DAGs
are delivered via the Files share / Git repo, matching WOM's model).
