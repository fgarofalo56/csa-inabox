# Fabric → Loom Parity Appendix — Developer Platform & APIs

Domain: **developer-platform** (Fabric REST APIs, API for GraphQL, User Data
Functions, the `fab` CLI, Terraform/bicep + SDKs, CI/CD + deployment APIs,
workspace monitoring, webhooks/Fabric events → Event Grid).

Author: Fabric→Loom Parity Architect. Date: 2026-06-26. Grounding: Microsoft
Learn (URLs inline). Loom code read at `apps/fiab-console` on branch
`feat/loom-marketplace`.

Cross-cutting rules honored throughout: `no-fabric-dependency.md` (Azure-native
default, Fabric/Power BI opt-in only), dual-cloud Commercial + Government (GCC /
GCC-High / DoD IL5), **day-one ON** (provisioned + enabled at deploy, user can
disable), Web-5.0 UX (wizards/dropdowns/canvas/Copilot — no freeform config),
real backend per control (`no-vaporware.md`, `ui-parity.md`).

---

## 1. Fabric capability inventory (grounded in Learn)

### 1.1 Fabric REST API — core + workload + the LRO pattern

- **Structure**: Core APIs (item CRUD across all item types: Create/Read/Update/
  Delete Item, Update Item Definition, List Items, batch ops) + Workload APIs
  (item-type-specific endpoints + Actions + Models). Ref:
  https://learn.microsoft.com/rest/api/fabric/articles/api-structure
- **Item model**: every item lives under `workspaces/{wsId}/items/{itemId}`,
  carries `id`, `type`, `displayName`, `description`, `workspaceId`, and an
  optional **definition** (base64 InlineBase64 parts; e.g. notebook
  `notebook-content.py`, semantic model `model.bim`, UDF `functionsMetadata`).
- **Long Running Operations (LRO)**: async pattern — initial call returns `202
  Accepted` + headers `Location`, `x-ms-operation-id`, `Retry-After`; poll **Get
  Operation State** (`/operations/{id}`) → `status: Running|Succeeded|Failed`,
  `percentComplete`; then **Get Operation Result** (`/operations/{id}/result`).
  Ref: https://learn.microsoft.com/rest/api/fabric/articles/long-running-operation
- **Identity / scopes**: delegated generic scopes `Item.Read.All`,
  `Item.ReadWrite.All`, `Item.Execute.All`, `Item.Reshare.All`; SP + MI direct
  access governed by admin controls. Item-associated identity (beta): assign a
  managed identity / SP to an item via `…/items/{id}/identities/default/assign`.
  Refs: https://learn.microsoft.com/rest/api/fabric/articles/scopes ,
  https://learn.microsoft.com/rest/api/fabric/articles/item-management/associate-item-identity
- **Bulk Import Item Definitions API (beta)**: create+update many items at once,
  Fabric resolves dependency order. Ref:
  https://learn.microsoft.com/rest/api/fabric/core/items (bulk-import-item-definitions).

### 1.2 Fabric Job Scheduler

- **Run On Demand Item Job** (`POST …/items/{id}/jobs/{jobType}/instances`,
  parameterized, returns `202` + Location to the job instance), **Get/Cancel/
  List Item Job Instance**, and **Create/Get/List/Update/Delete Item Schedule**
  (CRON / interval / daily, time zone aware). Exit values returnable for
  conditional orchestration. **Scheduler auto-disable** after ~10 consecutive
  failures. Schedules participate in CI/CD (stored as `.schedules` in the item
  def; included in deployment). Refs:
  https://learn.microsoft.com/rest/api/fabric/core/job-scheduler ,
  https://learn.microsoft.com/fabric/fundamentals/job-scheduler ,
  https://learn.microsoft.com/fabric/data-engineering/notebook-public-api
- **Monitoring Hub**: centralized UI listing item background jobs (status,
  duration, history) with per-item "Schedule" context action + "View all runs".
  Ref: https://learn.microsoft.com/fabric/admin/monitoring-hub

### 1.3 Fabric API for GraphQL (`API for GraphQL` item)

- Create a GraphQL item → **Get data** picks lakehouse / warehouse / SQL DB /
  mirrored DB objects (tables, views, stored procs) → Fabric **auto-generates
  SDL + resolvers** → endpoint URL ready in minutes. Schema explorer (types,
  queries, mutations). **Mutations only for Warehouse / SQL DB**; SQL analytics
  endpoints (lakehouse, mirrored) are read-only. Connectivity: **SSO** (caller
  needs data access) or **Saved credentials** (shared). **Generate code**
  (client snippets). **RBAC (preview)**: roles → users → per type / operation
  grants. **Aggregations** (`groupBy`, count/sum/avg). Limits: page 100 /
  max 100k, 64 MB response, 100 s timeout, depth 10, 1000 attached objects.
  Refs: https://learn.microsoft.com/fabric/data-engineering/api-graphql-overview ,
  …/get-started-api-graphql , …/graphql-schema-view , …/api-graphql-rbac ,
  …/api-graphql-aggregations , …/api-graphql-limits ,
  https://learn.microsoft.com/fabric/database/sql/graphql-api
- CI/CD: GraphQL item supports Git integration + deployment pipelines.

### 1.4 Fabric User Data Functions (UDF)

- Serverless **Python 3.11.9** functions; SDK `fabric-user-data-functions`
  (PyPI, pre-installed). `fn.UserDataFunctions()` context + `@udf.function()`
  decorator; helper fns without decorator. **Each function exposes its own REST
  endpoint** (Entra-auth). Invoke from Pipelines, Notebooks (`notebookutils.udf`),
  Activator rules, Power BI translytical task flows, or external HTTP. **PyPI
  libraries** + **Fabric data connections** (SQL DB, Warehouse, Lakehouse files,
  mirrored DB). Bindings: `HttpTrigger`, `FabricItem`, `UserDataFunctionContext`.
  Develop→Publish workflow (test in Develop mode, then publish). VS Code
  extension (local run/debug with breakpoints, Git-enabled). Refs:
  https://learn.microsoft.com/fabric/data-engineering/user-data-functions/user-data-functions-overview ,
  …/python-programming-model ,
  https://learn.microsoft.com/rest/api/fabric/articles/item-management/definitions/user-data-function-definition

### 1.5 `fab` CLI (`ms-fabric-cli`)

- File-system-inspired CLI: `fab auth login` (interactive / SP-secret / SP-cert /
  managed-identity), `fab ls / create / get / set / rm` over
  `<ws>.Workspace/<name>.<ItemType>`, `fab api …` raw REST passthrough,
  `fab deploy` (wraps `fabric-cicd`), `-o json`, `fab config set`. Refs:
  https://learn.microsoft.com/rest/api/fabric/articles/fabric-command-line-interface ,
  https://microsoft.github.io/fabric-cli/

### 1.6 SDKs + IaC providers

- **fabric-cicd** Python library (publish item defs programmatically; used by
  `fab deploy`). **azure-mgmt-fabric** ARM SDK (capacity mgmt). Community/HashiCorp
  **Terraform provider for Fabric** (workspaces, items, capacity assignment).
  Refs: https://learn.microsoft.com/fabric/cicd/tutorial-fabric-cicd-local ,
  https://learn.microsoft.com/python/api/overview/azure/mgmt-fabric-readme

### 1.7 CI/CD — Git integration + deployment pipelines

- **Git integration (CI)**: connect workspace ↔ Azure DevOps / GitHub branch +
  folder; commit / update-from-git; items stored as IaC (TMSL/PBIR/JSON folders).
  **Deployment pipelines (CD)**: 2–10 stages (Dev/Test/Prod), each bound to a
  distinct workspace; **Compare** (per-item sync state), **Deployment rules**
  (data-source / parameter overrides + autobinding), **Deploy all / selective**,
  history. Four release-process options (Git APIs / Items APIs / deployment-
  pipeline APIs / per-customer ISV). Refs:
  https://learn.microsoft.com/fabric/cicd/cicd-overview ,
  …/manage-deployment , …/deployment-pipelines/intro-to-deployment-pipelines ,
  https://learn.microsoft.com/rest/api/fabric/core/git ,
  https://learn.microsoft.com/rest/api/fabric/core/deployment-pipelines

### 1.8 Workspace monitoring (Eventhouse-backed)

- Workspace setting → creates a **monitoring Eventhouse** (read-only KQL DB)
  collecting diagnostic logs + metrics from items (Eventhouse, semantic models,
  GraphQL, mirrored DBs, pipelines, copy jobs, eventstreams). Tables incl.
  `ItemJobEventLogs`, `FabricDataPipelineActivityRunsLogs`,
  `EventStreamMetrics`, etc. Query via KQL/SQL; built-in dashboard templates;
  export to Azure Monitor / Log Analytics. Refs:
  https://learn.microsoft.com/fabric/fundamentals/workspace-monitoring-overview ,
  …/item-job-event-logs , https://learn.microsoft.com/fabric/data-factory/workspace-monitoring

### 1.9 Webhooks / Fabric events → Event Grid

- **Fabric Workspace Item events** + **Fabric Job events** surface in **Real-Time
  hub** and can be routed to **Azure Event Grid** (system topics) → subscriptions
  → webhooks / Functions / Event Hubs / Service Bus, with Event Grid's
  validation handshake. Item **CRUD notification API** (workload extensibility,
  preview) lets a workload participate in create/update/delete events. Refs:
  https://learn.microsoft.com/fabric/real-time-hub/create-streams-fabric-workspace-item-events ,
  https://learn.microsoft.com/azure/event-grid/handler-webhooks ,
  https://learn.microsoft.com/fabric/extensibility-toolkit/key-concepts

**featureCount ≈ 38 discrete capabilities across the nine groups above.**

---

## 2. Loom coverage map (built / stubbed / missing)

| # | Fabric capability | Loom surface | Status |
|---|---|---|---|
| 1 | REST item CRUD + LRO | `/api/items/<type>`, `/api/cosmos-items/<type>/<id>`, `/api/workspaces/*` (Cosmos-backed; ~120 item-type routes) | **built** (Azure-native; the BFF IS the REST API) |
| 2 | Item identity assignment | Console UAMI per call; per-item identity binding | partial |
| 3 | Bulk import item defs | git-integration `serializeLoomItem` + deployment-pipelines re-provision | partial (no single bulk API) |
| 4 | Job scheduler: run-on-demand | per-item runs (`/api/items/adf-pipeline/[id]/runs`, activator history, etc.) | partial (per-item, not unified) |
| 5 | Job scheduler: CRON schedules | activator uses `scheduledQueryRules`; **no generic per-item schedule store** | **missing** (unified) |
| 6 | Monitoring Hub (all jobs) | scattered run-history panels; `/monitor`, `/api/admin/refresh-summary` | **stubbed/partial** (no cross-item hub) |
| 7 | API for GraphQL (auto-schema) | `data-api-builder` editor + ACA DAB runtime (`dab-runtime.bicep`); `graphql-api` (APIM synthetic) | **built but gated** (not day-one ON) |
| 8 | GraphQL RBAC / aggregations / saved-creds vs SSO | DAB roles + REST/GraphQL; APIM products | partial |
| 9 | User Data Functions editor | `phase4-editors → UserDataFunctionEditor` (Monaco py, fn explorer, test panel, libraries, connections, gen-code) | **built (editor)** |
| 10 | UDF **execution backend** | `/api/items/user-data-function/[id]/invoke` → Azure Functions base URL **but no provisioner deploys one, no day-one host** | **BROKEN / stubbed** |
| 11 | `fab` CLI parity | `apps/loom-cli` (`loom`) → Loom BFF REST | **built** (strong) |
| 12 | SDK (Python / TS) | none published | **missing** (P2) |
| 13 | Terraform / IaC provider for items | bicep deploys infra; no Terraform provider for Loom items | **missing** (P2) |
| 14 | Git integration (CI) | `/api/git-integration/*` real ADO/GitHub REST | **built** (strong) |
| 15 | Deployment pipelines (CD) | `/api/deployment-pipelines/loom/*` Cosmos + real provisioners + rules + compare | **built** (strong) |
| 16 | Workspace monitoring (Eventhouse) | `workspace-monitor.ts` provisioner (ADX + Azure Monitor) + `app-workspace-monitoring` | **built but opt-in** (not day-one ON) |
| 17 | Webhooks / events → Event Grid | `/api/business-events/*` + `event-grid-topic` editor | partial (verify real EG system topic + subs day-one) |

**loomStatus for the domain: `partial`** — the management/CLI/CI-CD/GraphQL
surface is strong, but the **UDF execution backend is broken** and the **job
scheduler + monitoring hub** is not a unified product, and several real backends
(DAB runtime, workspace-monitor) ship gated rather than day-one ON.

---

## 3. Broken found (present-but-broken)

### B1. User Data Functions never execute Azure-native by default (P0)

- **Symptom**: The UDF editor saves Python + parses functions, and `invoke`
  prefers an Azure Functions base URL — but **no provisioner deploys a Function
  App**, and nothing sets `state.azureFunctionUrl` or a day-one
  `LOOM_UDF_FUNCTION_BASE`. So the default `Test/Run` path returns the 409 honest
  gate (`app/api/items/user-data-function/[id]/invoke/route.ts`, branch 3). The
  user can author a function but cannot run it — a `no-vaporware` + day-one-ON
  violation. (The parity doc `docs/fiab/parity/user-data-function.md` calls #3 an
  "honest-gate", masking that there is no backend at all.)
- **Fix**: ship a `user-data-function` provisioner (§4 G1) that deploys/links a
  **shared Azure Functions (Flex Consumption, Python 3.11)** or **ACA** UDF host
  day-one, materializes the saved Python into a function, and writes
  `state.azureFunctionUrl` + `state.functionKeySecret`. Default `LOOM_UDF_FUNCTION_BASE`
  to the shared host so invoke works the moment an item is created.

### B2. DAB GraphQL runtime ships dark (P1)

- **Symptom**: `data-api-builder` preview/publish gate on `LOOM_DAB_PREVIEW_URL`
  (`app/api/dab/_lib/dab-runtime.ts`); the ACA runtime exists in
  `dab-runtime.bicep` but is not wired ON by default → the GraphQL/REST endpoint
  the editor advertises returns a 503 gate. Violates day-one-ON.
- **Fix**: deploy `dab-runtime.bicep` in the default orchestration and set
  `LOOM_DAB_PREVIEW_URL` day-one (§4 G2).

### B3. Workspace monitoring is opt-in, not day-one (P1)

- **Symptom**: `workspace-monitor.ts` is a real provisioner but only runs when an
  operator installs `app-workspace-monitoring` and `LOOM_KUSTO_CLUSTER_URI` is
  set. Fabric turns workspace monitoring on from a single toggle; Loom should
  provision the monitoring ADX DB + diagnostic settings day-one.
- **Fix**: include in day-one orchestration; expose a disable toggle (§4 G5).

---

## 4. Gap build specs

Each gap: architecture-in-words, Web-5.0 UI, BFF APIs, Azure services, deploy
(bicep/scripts), Commercial vs Government, day-one config, acceptance.

### G1 — User Data Functions execution backend (P0, BROKEN)

**Architecture**: A **shared multi-function Python host** is deployed day-one:
**Azure Functions Flex Consumption (Python 3.11)** in Commercial; **ACA
container** (the same `fabric-user-data-functions`-shaped runner image) where
Flex Consumption is unavailable. On Publish, the editor serializes the item's
`function_app.py` + `requirements.txt` + the UDF `functionsMetadata`
(name/bindings/params/returnType) and the provisioner deploys it as a function
(zip-deploy to the shared Flex host **or** a per-tenant ACA revision for
isolation), wiring the item's **Fabric data connections** to Loom connections
(SQL DB / Synapse / ADLS) via the connection store + Key Vault. `invoke`'s
existing Azure-native branch then hits `{base}/api/{functionName}`.

**Web-5.0 UI** (extend `UserDataFunctionEditor`): keep Monaco py + functions
explorer; make **Test/Run** real (typed param inputs → output + captured
`logging` stream); a **Publish wizard** (dropdowns: runtime = Python 3.11 / 3.12;
host = Shared (Flex) / Isolated (ACA); auth = Anonymous / Function key; data
connections = multiselect of Loom connections); **Generate invocation code**
(Notebook / Python client / OpenAPI / cURL) from parsed signatures; an honest
gate only if the shared host genuinely cannot be reached.

**BFF APIs**: `POST /api/items/user-data-function/[id]/publish` (serialize →
provisioner → write `state.azureFunctionUrl`+`functionKeySecret`); existing
`…/invoke` (already Azure-native default); `GET …/runs` (run history from App
Insights / ACA logs); `POST …/[id]/schedule` (reuses G3 scheduler).

**Azure services**: Azure Functions Flex Consumption (or ACA) + Storage (host) +
App Insights + Key Vault (function key) + Console UAMI (`Website Contributor` /
`ACA Contributor` + `Key Vault Secrets User`).

**Deploy**: new `platform/fiab/bicep/modules/admin-plane/udf-runtime.bicep`
(Flex Consumption plan + function app + storage + diagnostic settings); ACA
variant in the same module guarded by `udfHostKind` param. Env
`LOOM_UDF_FUNCTION_BASE`, `LOOM_UDF_HOST_KIND`, `LOOM_UDF_KEY_KV_PREFIX` added to
`admin-plane/main.bicep` `apps[]` env. Day-one ON (`udfEnabled=true`).

**Commercial vs Government**: Flex Consumption Python is GA in Commercial + most
Gov regions; where absent in Gov, set `udfHostKind=aca` (ACA is broadly
available in GCC-High/IL5). Gov endpoints: `*.azurewebsites.us`,
`vault.usgovcloudapi.net`, App Insights Gov; private-only (VNet integration +
private endpoints) for IL5. No Fabric path on default.

**Acceptance** (`LOOM_DEFAULT_FABRIC_WORKSPACE` unset): create a UDF item → write
`hello_fabric(name)` → Publish → Test with `{name:"loom"}` → real 200 + greeting
+ logs from the Azure Function; `invoke` receipt `backend:"azure-functions"`.

### G2 — Day-one DAB GraphQL + auto-schema-from-data parity (P1)

**Architecture**: Deploy the DAB ACA runtime day-one; the `data-api-builder`
item's `dab-config.json` (entities from SQL DB / Synapse serverless / Cosmos)
drives auto-generated **GraphQL + REST** endpoints — the 1:1 for Fabric "API for
GraphQL auto-schema". Add an **auto-import** step: point at a Loom lakehouse SQL
analytics endpoint (Synapse serverless over ADLS Delta) or warehouse, enumerate
tables/views, and generate DAB entities (read-only for lakehouse, read+write/
mutations for warehouse/SQL DB — mirroring Fabric's mutation rule). GraphQL
**RBAC** maps to DAB entity `permissions` (roles → actions); **aggregations**
via DAB's `groupBy`/relationship features or a thin resolver.

**Web-5.0 UI** (`data-api-builder-editor`): a **Get-data wizard** (pick
connection → checkbox tables/views/sprocs → relationships canvas) like Fabric's
Choose-data; **Schema explorer** (types/queries/mutations tree); **API
playground** (GraphiQL + REST tester) backed by the live runtime; **Roles** panel
(role → per-entity read/create/update/delete toggles); connectivity selector
(SSO vs saved credential). No JSON hand-editing as the primary path (the raw
`dabConfigJson` remains a 1:1 advanced view only).

**BFF APIs**: existing `/api/dab/*` (create, sources, deploy-source, preview,
publish) + new `POST /api/dab/[id]/import-schema` (introspect connection →
entities) and `GET /api/dab/[id]/roles` / `PUT …/roles`.

**Azure services**: ACA (DAB image `mcr.microsoft.com/azure-databases/data-api-builder`)
+ the source DB (Fabric-free: Azure SQL / Synapse serverless / Cosmos) + Key
Vault (connection strings) + APIM (optional front door for keys/quotas).

**Deploy**: wire `dab-runtime.bicep` into the default admin-plane orchestration;
set `LOOM_DAB_PREVIEW_URL` day-one; `dabEnabled=true`.

**Commercial vs Gov**: DAB image + ACA available both clouds; Synapse serverless
+ Azure SQL available in Gov; Cosmos GA in Gov. Private-only networking for IL5.

**Acceptance**: create DAB item → import from a Loom warehouse → playground runs
`query { customers { id name } }` and a `createCustomer` mutation → real rows;
role "reader" denied the mutation.

### G3 — Unified Job Scheduler + schedule store (P1, missing)

**Architecture**: A generic **schedule store** (Cosmos `item-schedules`, PK
`/tenantId`) holding CRON / interval / daily + timezone + enabled per
(itemType,itemId,jobType), exactly mirroring Fabric's Item Schedule model. A
**single timer** (ACA Job on a KEDA cron, or a Logic App recurrence, or Azure
Functions timer in the UDF host) wakes, finds due schedules, and calls the item's
existing run-on-demand route (`/api/items/<type>/<id>/run` style). Includes
**auto-disable** after N consecutive failures (Fabric parity).

**Web-5.0 UI**: a reusable **Schedule** dialog (Fluent) attached to every
runnable item's ribbon — dropdowns for cadence (Once / Minute / Hour / Day /
Week / Cron), timezone picker, start/end, enable toggle. Surfaced from the item
editor and from the Monitoring Hub (G4).

**BFF APIs**: `GET/POST/PUT/DELETE /api/schedules` (+ `/api/items/<type>/<id>/
schedule`); `POST …/instances` (run on demand); `GET …/instances` (history);
`POST …/instances/<id>/cancel`.

**Azure services**: Cosmos + one of {ACA Job (KEDA cron), Functions timer, Logic
App}. Default = ACA Job (already used for the GH runner pattern — same `cae-csa-loom`
environment). Console UAMI already Cosmos Data Contributor.

**Deploy**: `admin-plane/scheduler-job.bicep` (ACA Job, cron `*/5 * * * *`,
calls an internal `/api/schedules/tick` with a shared secret). Day-one ON.

**Gov**: ACA Jobs GA in GCC-High/IL5; all private. No Fabric.

**Acceptance**: schedule a notebook every 5 min → tick fires → run instance
recorded → appears in Monitoring Hub → cancel works → 10 failures auto-disables.

### G4 — Monitoring Hub (cross-item run history) (P1, stubbed)

**Architecture**: A single **/admin/monitoring-hub** page aggregating run
instances across all item types from (a) the G3 schedule store instances, (b)
Log Analytics KQL (ADF/Synapse/Spark/Functions), (c) the workspace-monitoring
ADX `ItemJobEventLogs`-shaped tables (G5). One normalized "job run" shape:
item, type, jobType, status, start/end, duration, submitter, link.

**Web-5.0 UI**: Fluent DataGrid with facet filters (status / item type /
workspace / time range), status pills, sparkline of success/fail trend, drill-in
drawer (logs + cancel + re-run), saved views. Matches Fabric Monitoring Hub
layout with Loom theme.

**BFF APIs**: `GET /api/monitor/runs?…filters` (fan-out + merge across sources);
`POST /api/monitor/runs/<id>/cancel`, `/rerun`.

**Azure services**: Log Analytics (KQL), the monitoring ADX DB (G5), Cosmos
(G3). UAMI: `Log Analytics Reader` + ADX DB Viewer (already granted in
workspace-monitor).

**Deploy**: page + route only (no new infra). Day-one visible.

**Gov**: LAW + ADX both clouds. No Fabric.

**Acceptance**: a scheduled notebook, an ADF pipeline run, and a UDF invoke all
appear in one grid within minutes; filter to Failed shows only failures; cancel
a running ADF pipeline from the drawer.

### G5 — Workspace monitoring day-one ON (P1)

**Architecture**: Run `workspace-monitor.ts` (monitoring ADX DB + Azure Monitor
diagnostic-settings auto-enable + seeded tables + optional Event Hub live feed)
as part of the **default deploy**, not an opt-in app. Add a **disable** toggle in
admin settings (turn off the diagnostic export + leave the DB read-only).

**Web-5.0 UI**: an admin **Monitoring** settings card (Enabled toggle, retention
slider, "Open monitoring dashboard" CTA → the pre-built Real-Time dashboard).

**BFF APIs**: existing provisioner + `GET/PUT /api/admin/monitoring/settings`.

**Azure services**: ADX cluster (shared), Azure Monitor, Log Analytics, optional
Event Hubs. UAMI roles already provisioned.

**Deploy**: call the provisioner in the day-one orchestrator; require
`LOOM_KUSTO_CLUSTER_URI` (deployed by the ADX bicep module day-one) so the gate
never shows by default. `workspaceMonitoringEnabled=true`.

**Gov**: ADX + Azure Monitor GA both clouds; private-link ingestion for IL5.

**Acceptance**: fresh deploy → monitoring ADX DB exists, diagnostic settings
cover all Loom resources, dashboard tiles render real telemetry — no install
step, no env gate.

### G6 — Fabric events → Event Grid webhooks (P1, partial)

**Architecture**: Loom item lifecycle (create/update/delete/job-complete) already
flows through `/api/business-events`. Wire it to a **real Azure Event Grid
namespace + custom topic** day-one: BFF publishes CloudEvents on item/job
events; users create **subscriptions** (webhook / Event Hubs / Service Bus /
Functions) via a UI that performs Event Grid's validation handshake. This is the
Azure-native parity for "Fabric Workspace Item events in Real-Time hub → Event
Grid".

**Web-5.0 UI**: a **Subscriptions** page — event-type multiselect (ItemCreated /
ItemUpdated / ItemDeleted / JobSucceeded / JobFailed), endpoint type dropdown,
endpoint URL, filters; a live **event viewer** (last N events). Wizard-driven, no
raw JSON.

**BFF APIs**: `/api/business-events/topics`, `…/subscriptions` (CRUD →
Microsoft.EventGrid ARM), `…/publish` (emit CloudEvent), `…/validate` (handshake
helper).

**Azure services**: Event Grid namespace + custom topic + subscriptions; Console
UAMI `EventGrid Contributor` + `EventGrid Data Sender`.

**Deploy**: `admin-plane/eventgrid.bicep` (already present per git status —
extend with a custom topic + role) wired day-one; `eventsEnabled=true`.

**Gov**: Event Grid GA in GCC/GCC-High/IL5 (`*.eventgrid.azure.us`); private
topics for IL5. No Fabric.

**Acceptance**: subscribe a webhook → create an item → Event Grid delivers
`ItemCreated` CloudEvent to the endpoint (validation handshake passes); JobFailed
fires on a failed run.

### G7 — Loom SDK package (P2)

**Architecture**: Publish `@csa-loom/sdk` (TS) + `csa-loom` (PyPI) thin clients
over the BFF REST surface (auth via the same `cli-session` flow as loom-cli),
mirroring `fabric-cicd` + the Fabric SDK ergonomics (workspaces, items, jobs,
schedules, git, deployment pipelines). Reuses loom-cli's `client.ts`.

**UI**: docs page + `Generate code` in editors emits SDK snippets.

**Deploy**: npm + PyPI publish workflow; no Azure infra. **Gov**: artifact is
cloud-agnostic; base URL per deployment.

**Acceptance**: `pip install csa-loom`; `LoomClient().items.create(...)` round-trips
against a Gov deployment.

### G8 — Terraform provider for Loom items (P2)

**Architecture**: a `terraform-provider-loom` (Go) wrapping the BFF REST surface
(resources: `loom_workspace`, `loom_item`, `loom_schedule`, `loom_deployment_pipeline`),
the IaC parity for the Fabric Terraform provider — Azure-native, no Fabric.

**Deploy**: registry publish; no infra. **Gov**: provider talks to the
per-deployment base URL + the same session auth.

**Acceptance**: `terraform apply` creates a workspace + lakehouse item in a Gov
deployment; `plan` shows drift after an out-of-band edit.

---

## 5. Day-one configuration summary (all ON, user-disable)

| Feature | Env / param (day-one) | Disable knob |
|---|---|---|
| UDF runtime (G1) | `udfEnabled=true`, `LOOM_UDF_FUNCTION_BASE`, `LOOM_UDF_HOST_KIND` | admin toggle |
| DAB GraphQL (G2) | `dabEnabled=true`, `LOOM_DAB_PREVIEW_URL` | admin toggle |
| Scheduler (G3) | `schedulerEnabled=true` (ACA Job cron) | per-schedule + global |
| Monitoring Hub (G4) | always-on page | n/a |
| Workspace monitoring (G5) | `workspaceMonitoringEnabled=true`, `LOOM_KUSTO_CLUSTER_URI` | admin toggle |
| Events → Event Grid (G6) | `eventsEnabled=true` | per-subscription + global |

---

## 6. Commercial vs Government quick matrix

| Capability | Commercial | Government (GCC / GCC-High / IL5) |
|---|---|---|
| UDF host | Functions Flex Consumption (Python) | Flex where available, else ACA (`udfHostKind=aca`); `*.azurewebsites.us`, private VNet |
| DAB runtime | ACA + Azure SQL/Synapse/Cosmos | same; all GA in Gov; private endpoints IL5 |
| Scheduler | ACA Job (KEDA cron) | ACA Jobs GA in Gov; private |
| Monitoring | ADX + Azure Monitor + LAW | GA both; private-link ingestion IL5 |
| Git provider | dev.azure.com / api.github.com | ADO Services SaaS or on-prem `LOOM_ADO_HOST`; GHES `LOOM_GITHUB_HOST` |
| Events | Event Grid `*.eventgrid.azure.net` | `*.eventgrid.azure.us`; private topics IL5 |
| Secrets | `vault.azure.net` | `vault.usgovcloudapi.net` |
| Fabric path | opt-in only | opt-in only (Fabric often absent in Gov — Azure-native is the only path) |

No managed service in this domain is Gov-absent in a way that needs an OSS
substitute (UDF→Functions/ACA, GraphQL→DAB/ACA, scheduler→ACA Job, monitoring→
ADX all run in Gov). The OSS posture is inherent: DAB, the DAB image, and the
Python runner are open-source and self-hostable on ACA/AKS in any sovereign cloud.

---

## 7. Verification per gap (receipts required at PR per no-vaporware.md)

Each gap PR attaches: endpoint hit + real response (first 300 chars), a browser
screenshot of the Web-5.0 surface, and the bicep diff. Acceptance criteria per
gap are in §4. Domain-level gate: with `LOOM_DEFAULT_FABRIC_WORKSPACE` UNSET, a
fresh `az deployment sub create -f platform/fiab/bicep/main.bicep` must yield a
deployment where: a UDF runs, a DAB GraphQL query returns rows, a schedule fires
into the Monitoring Hub, workspace monitoring tiles render, and an Event Grid
subscription delivers an ItemCreated event — all without any Fabric/Power BI
host being contacted.
