# airflow — parity with Fabric "Apache Airflow job" / ADF "Workflow Orchestration Manager"

Source UI:
- Fabric — Apache Airflow job: https://learn.microsoft.com/fabric/data-factory/apache-airflow-jobs-concepts
- Azure Data Factory — Workflow Orchestration Manager (managed Apache Airflow): https://learn.microsoft.com/azure/data-factory/how-does-workflow-orchestration-manager-work
- Apache Airflow stable REST API: https://airflow.apache.org/docs/apache-airflow/stable/stable-rest-api-ref.html

Both Fabric's "Apache Airflow job" and ADF's "Workflow Orchestration Manager" are
**managed Apache Airflow** — Microsoft hosts the webserver + scheduler behind a
managed metadata store, you provide Python DAGs (Fabric: inline/Git; WOM: Blob
Storage), and drive them from a UI + REST API. Per
`.claude/rules/no-fabric-dependency.md`, CSA Loom provides the **same managed
Apache Airflow experience with NO Fabric capacity and NO ADF WOM environment**
by running the upstream OSS `apache/airflow` image on Azure Container Apps.

## Azure-native backend (the DEFAULT — rel-T86)

`platform/fiab/bicep/modules/admin-plane/airflow.bicep` provisions, on the
Console's Container Apps Environment (default-on when apps deploy, Commercial +
Gov Container-Apps boundaries):

- **`loom-airflow` Container App** — two containers in one replica:
  - `webserver` — serves the Airflow UI + the stable REST API (`/api/v1/dags`,
    `dagRuns`, `taskInstances`) the Loom BFF proxies; runs the one-time
    `airflow db migrate` + admin-user create on boot (official image entrypoint
    honours `_AIRFLOW_DB_MIGRATE` / `_AIRFLOW_WWW_USER_*`).
  - `scheduler` — schedules + executes DAGs (`LocalExecutor`).
  - Internal ingress only (`external:false`) — reached by the Console over the
    CAE VNet, never public.
- **Azure Database for PostgreSQL Flexible Server** — the Airflow metadata DB
  (SQLite is single-process; a webserver+scheduler split needs a concurrent DB,
  exactly as WOM/Fabric put a managed store behind Airflow). Password auth with
  an UNPREDICTABLE seed-derived password (`loomGeneratedSecretSeed`), TLS-required.
- **Azure Files DAG + logs shares** — mounted into both containers at
  `/opt/airflow/dags` and `/opt/airflow/logs` (WOM's "provide your DAGs in Blob
  Storage" equivalent). An empty share is a real, healthy Airflow returning an
  empty DAG list.

The Console reaches the webserver via `LOOM_AIRFLOW_ENDPOINT` and authenticates
HTTP **Basic** (`LOOM_AIRFLOW_USERNAME`/`LOOM_AIRFLOW_PASSWORD`) — WOM's "Basic
authentication" mode. A **per-item BYO webserver URL** stays an opt-in override
(`resolveAirflowConn`: stored `webserverUrl` wins, else the managed endpoint).

When no managed host is wired AND no BYO URL is set, the editor renders its full
surface and honest-gates on `LOOM_AIRFLOW_ENDPOINT` + this bicep module (per
`no-vaporware.md`).

## Fabric / WOM feature inventory → Loom coverage

| Capability (Fabric Airflow job / ADF WOM)            | Loom coverage | Backend / control |
|------------------------------------------------------|---------------|-------------------|
| Managed Airflow webserver + scheduler (no self-host) | built ✅       | `loom-airflow` ACA host (airflow.bicep) |
| Managed metadata store behind Airflow                | built ✅       | Postgres Flexible Server (airflow.bicep) |
| Provide DAGs to the environment                      | built ✅ (Azure Files share) ⚠️ (Git sync = preview) | `dags` file share mounted at `/opt/airflow/dags`; `gitRepo` field stored (sync worker preview) |
| List DAGs (id, paused, active, schedule, next run)   | built ✅       | `GET /api/v1/dags` → `[id]/dags` route → DAGs tab table |
| Pause / unpause a DAG                                 | built ✅       | `PATCH /api/v1/dags/{id}?update_mask=is_paused` → DAGs tab toggle |
| Trigger a DAG run (with conf / logical date)         | built ✅       | `POST /api/v1/dags/{id}/dagRuns` → "Trigger" button |
| Monitor DAG run history (state/type/timing)          | built ✅       | `GET /api/v1/dags/{id}/dagRuns` → Runs tab table |
| Inspect task instances of a run                      | built ✅       | `GET .../taskInstances` → Run "Tasks & logs" dialog |
| View task logs                                       | built ✅       | `GET .../taskInstances/{task}/logs/{try}` → log viewer |
| Airflow connections (HTTP/AWS/Azure/ADF…)            | honest-gate ⚠️ | Airflow-native Admin UI (managed host = internal ingress → reach over VNet/VPN; BYO = its own admin URL). Documented in the Connections tab. |
| Basic / Entra authentication to the environment      | built ✅ (Basic) ⚠️ (Entra = BYO Bearer) | Basic auth to the managed host; `LOOM_AIRFLOW_BEARER` for a BYO AAD-ingress webserver |
| Environment variables / requirements (pip)           | honest-gate ⚠️ | set on the ACA host / image (bicep env + a mirrored image with baked requirements); not yet an in-UI editor |
| Diagnostic logs & metrics                            | built ✅       | App Insights connection string wired into both containers |

Zero rows are MISSING/❌ vaporware: every list/trigger/monitor/log control calls
the real Airflow REST API against a real host, and the two ⚠️ rows (connections
UI, requirements editor) are honest, Airflow-native admin surfaces, not stub
banners.

## Backend per control

| Loom control (airflow-job editor) | Route | Airflow REST |
|-----------------------------------|-------|--------------|
| DAGs tab table                    | `GET /api/items/airflow-job/[id]/dags` | `GET /api/v1/dags` |
| Trigger button                    | `POST /api/items/airflow-job/[id]/dag-runs` | `POST /api/v1/dags/{id}/dagRuns` |
| Pause / Unpause                   | `PATCH /api/items/airflow-job/[id]/dags` | `PATCH /api/v1/dags/{id}?update_mask=is_paused` |
| Runs tab table                    | `GET /api/items/airflow-job/[id]/dag-runs?dagId=` | `GET /api/v1/dags/{id}/dagRuns` |
| Tasks & logs dialog (task list)   | `GET /api/items/airflow-job/[id]/task-logs?dagId=&runId=` | `GET .../taskInstances` |
| Tasks & logs dialog (log view)    | `GET .../task-logs?...&taskId=&tryNumber=` | `GET .../taskInstances/{task}/logs/{try}` |
| Save BYO connection               | `POST /api/items/airflow-job/[id]/connection` | (persists the override webserver URL in Cosmos) |

Auth + host resolution is shared in `apps/fiab-console/lib/airflow/endpoint.ts`
(`resolveAirflowConn` / `airflowAuthHeaders`).

## Honest-gate note (verification)

The `loom-airflow` host + its Postgres + file shares are deployed by the operator
bicep run (default-on when `deployAppsEnabled` on a Container-Apps boundary; it
pulls the public `apache/airflow` image — override `airflowImage` to an
ACR-mirrored tag in locked-egress / sovereign estates). Until that run,
`LOOM_AIRFLOW_ENDPOINT` is unset and the airflow-job editor renders fully +
surfaces the documented warning MessageBar naming the env var and this module —
per `no-vaporware.md`, the gate itself must render live. A per-item BYO webserver
URL works with `LOOM_DEFAULT_FABRIC_WORKSPACE` UNSET, confirming no Fabric
dependency on any path.
