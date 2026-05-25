# Fabric feature inventory (source-of-truth for Loom Console rebuild)

Date: 2026-05-24
Branch: `access-patterns-vpn-agw-fd`
Source: Microsoft Learn (verified via `microsoft_docs_search` + `microsoft_docs_fetch`, May 2026)

This document is the canonical inventory the Console v2 rebuild works from.
Every route, editor shell, and BFF stub in `apps/fiab-console/` must trace back
to an entry here. When something is "out of scope for v2", it is still listed
so the gap is explicit.

References (anchor links — re-fetch with `microsoft_docs_fetch` if details drift):

- Item definition overview — `learn.microsoft.com/rest/api/fabric/articles/item-management/definitions/item-definition-overview`
- Item management overview (per-workload item table) — `.../item-management/item-management-overview`
- Fabric overview (workloads) — `learn.microsoft.com/fabric/fundamentals/microsoft-fabric-overview`
- Extensibility Toolkit concept-item-overview — `learn.microsoft.com/fabric/extensibility-toolkit/concept-item-overview`
- Extensibility Toolkit key concepts — `.../extensibility-toolkit/key-concepts`
- Workspaces — `learn.microsoft.com/fabric/fundamentals/workspaces`
- Workspace roles — `learn.microsoft.com/fabric/fundamentals/roles-workspaces`
- OneLake catalog explore — `learn.microsoft.com/fabric/governance/onelake-catalog-explore`
- OneLake catalog govern — `.../governance/onelake-catalog-govern`
- OneLake catalog item details — `.../governance/onelake-catalog-item-details`
- Monitoring hub — `learn.microsoft.com/fabric/admin/monitoring-hub`
- Real-Time hub overview — `learn.microsoft.com/fabric/real-time-hub/real-time-hub-overview`
- Supported sources for Real-Time hub — `.../real-time-hub/supported-sources`
- Workload hub — `learn.microsoft.com/fabric/workload-development-kit/more-workloads-add`
- Admin portal tenant settings index — `learn.microsoft.com/fabric/admin/tenant-settings-index`
- Deployment pipelines — `learn.microsoft.com/fabric/cicd/deployment-pipelines/intro-to-deployment-pipelines`
- Git integration — `learn.microsoft.com/fabric/cicd/git-integration/git-get-started`
- Fabric IQ overview — `learn.microsoft.com/fabric/iq/overview`

---

## 1. Workloads and item types

Authoritative source: Fabric REST API *item-definition-overview* (the list of
definition-based item types Microsoft ships) cross-checked against
*item-management-overview* (per-workload CRUD support table) and each
workload's product overview page.

**Verbatim from `item-definition-overview` (definition-based items, May 2026):**
CopyJob, Dataflow, Eventhouse, GraphQLApi, DataPipeline, DbtJob, EventSchemaSet,
GraphModel, KQLDatabase, KQLDashboard, KQLQueryset, Lakehouse,
MirroredAzureDatabricksCatalog, MirroredCatalog, MirroredDatabase,
MountedDataFactory, Environment, Notebook, Report, SemanticModel,
SnowflakeDatabase, Eventstream, Reflex (Activator), SparkJobDefinition,
VariableLibrary.

**Note from item-management-overview:** Scorecard and Dataflow (Gen1) are
*not* supported by any item REST API today. Reflex == Activator.

### 1.1 Data Engineering

| Item type | Route | Editor anatomy (real Fabric) | v2 scope |
|---|---|---|---|
| Lakehouse | `/items/lakehouse/[id]` | Explorer pane (Tables / Files / Shortcuts tree) + main pane (table preview / file preview / SQL endpoint) + ribbon (New schema shortcut, New table shortcut, New shortcut, Load to tables, Open in notebook, Analyze data with…) | **Phase 2.** Replace existing single-pane lakehouse stub. |
| Notebook | `/items/notebook/[id]` | Cell list (code/markdown) + per-cell Monaco + per-cell output model + kernel selector (PySpark / Spark Scala / SparkSQL / SparkR / Python 3.10 / Python 3.11) + variables explorer + session status + ribbon (Run all, Restart, Schedule, Recent runs, Open in VS Code) | **Phase 2.** Replace single-textarea stub. |
| Spark job definition | `/items/spark-job-definition/[id]` | Main pane: executable file picker, main class, command-line args, default lakehouse, additional lakehouses, environment ref. | **Phase 2.** |
| Environment | `/items/environment/[id]` | Tabs: Spark settings (driver/executor cores+memory), Public libraries (PyPI), Custom libraries (.whl upload), Resources, Publish state. | **Phase 2.** |
| GraphQL API | `/items/graphql-api/[id]` | Schema designer + connected data sources panel + query editor + auth (UDF authorizer). | **Phase 4.** |
| Snowflake database | `/items/snowflake-database/[id]` | Read-only catalog of mirrored Snowflake tables. | **Phase 2 (mirroring connector wizard).** |

### 1.2 Data Factory

| Item type | Route | Editor anatomy | v2 scope |
|---|---|---|---|
| Data pipeline | `/items/data-pipeline/[id]` | **React Flow canvas.** Activity palette (verbatim from `datapipeline-definition`): Copy, AzureHDInsight, SparkJobDefinition, InvokeCopyJob, ExecuteSSISPackage, SqlServerStoredProcedure, ExecutePipeline, Delete, KustoQueryLanguage, Lookup, WebActivity, GetMetadata, IfCondition, Switch, ForEach, AzureMLExecutePipeline, DataLakeAnalyticsScope, Wait, Fail, Until, Filter, TridentNotebook, DatabricksNotebook, SetVariable, AppendVariable, AzureFunction, Custom (Azure Batch), WebHook, RefreshDataFlow, Script, Office365Email, Email, MicrosoftTeams, Teams, PBISemanticModelRefresh. Right-pane activity config (typeProperties). Bottom-pane Output / Run history. | **Phase 2.** |
| Dataflow Gen2 | `/items/dataflow/[id]` | Power Query Online clone: Queries pane (left) + diagram view (canvas) + data preview (center) + applied steps (right) + ribbon (Home / Transform / Add column / View / Tools / Help) + global search box (Alt+Q) + destination chooser (Lakehouse / Warehouse / KQL DB / SQL DB / Azure SQL). | **Phase 2.** |
| Copy job | `/items/copy-job/[id]` | Wizard: source connector → destination connector → mapping → schedule → monitor tab. | **Phase 2.** |
| Mirrored database | `/items/mirrored-database/[id]` | Connector wizard. Source types (from `mirrored-database-definition`): Snowflake, AzureSqlDatabase, AzureSqlMI, AzurePostgreSql, CosmosDb, SqlServer2025, MSSQL (2016-2022), GenericMirror (open). Mounted tables list + replication status. | **Phase 2.** |
| Mirrored Azure Databricks catalog | `/items/mirrored-databricks/[id]` | UC catalog browser + replication state. | **Phase 2 (shell only).** |
| Mirrored catalog | `/items/mirrored-catalog/[id]` | Generic catalog mirror shell. | **Phase 2 (shell only).** |
| Mounted Data Factory | `/items/mounted-adf/[id]` | ADF factory reference + pipeline list (read-only mount). | **Phase 2 (shell only).** |
| dbt job | `/items/dbt-job/[id]` | Project ref + profiles + run config + recent runs. | **Phase 2.** |
| Apache Airflow job | `/items/airflow-job/[id]` | DAG list + Git integration panel + recent runs. | **Phase 5 (shell).** |

### 1.3 Data Warehouse

| Item type | Route | Editor anatomy | v2 scope |
|---|---|---|---|
| Warehouse | `/items/warehouse/[id]` | Explorer (schemas → tables/views/SPs/functions) + Monaco T-SQL editor + multi-tab queries + Results grid + ribbon (New query, New table, Save as table, Open in Excel, Publish, Visualize results) + Source control button. | **Phase 3.** |
| SQL analytics endpoint | (sub-route on Lakehouse/Warehouse) | Same Monaco T-SQL editor but read-only on Lakehouse. | **Phase 3.** |

### 1.4 Databases

| Item type | Route | Editor anatomy | v2 scope |
|---|---|---|---|
| SQL database | `/items/sql-database/[id]` | T-SQL editor + Backups + Restore points + Mirroring status (auto-mirrored to Fabric SQL analytics endpoint). | **Phase 3 (shell).** |

### 1.5 Real-Time Intelligence

| Item type | Route | Editor anatomy | v2 scope |
|---|---|---|---|
| Eventhouse | `/items/eventhouse/[id]` | System Overview (storage, CU usage, top queried/ingested DBs, top users, what's new) + KQL Databases list (tile/list view) + Database Activity Tracker + ribbon (New database, Get data, Query with code). | **Phase 3.** |
| KQL database | `/items/kql-database/[id]` | Explorer (Tables / Materialized views / Functions / Shortcuts) + data preview + Query Insights + ribbon (New table / materialized view / update policy / shortcut, Get data, Query with code, Data policies, OneLake availability). | **Phase 3.** |
| KQL queryset | `/items/kql-queryset/[id]` | Monaco with **KQL language service**, multi-tab, results grid + chart, "Save to dashboard" / "Set alert" buttons. | **Phase 3.** |
| KQL dashboard | `/items/kql-dashboard/[id]` | Tile grid + per-tile KQL + parameters bar + auto-refresh + "Add data source" (KQL DB / ADX). | **Phase 3.** |
| Eventstream | `/items/eventstream/[id]` | **React Flow canvas.** Sources (full list in §2.3) + transformations (Aggregate, Expand, Filter, Group by, Manage fields, Union, DeltaFlow CDC) + destinations (Lakehouse, Eventhouse, Activator, Custom endpoint, Stream/derived). Edit vs Live mode. | **Phase 3.** |
| Event schema set | `/items/event-schema-set/[id]` | Schema registry view (per-stream). | **Phase 3 (shell).** |
| Activator (Reflex) | `/items/activator/[id]` | Explorer (Objects, Events, Properties, Rules) + rule designer (Monitor → Condition → Action) + actions library (Email, Teams message/group/channel, Run pipeline/notebook/Spark job/dataflow/function, Power Automate custom, Fabric item action) + activation history. | **Phase 3.** Replace stub. |

### 1.6 Data Science

| Item type | Route | Editor anatomy | v2 scope |
|---|---|---|---|
| ML model | `/items/ml-model/[id]` | Model registry (MLflow-backed): versions list, run links, metrics, params, "Apply this model" (PREDICT), endpoints tab. | **Phase 4.** |
| ML experiment | `/items/ml-experiment/[id]` | Runs table + run details (params, metrics, artifacts, code version) + compare runs + chart tab. | **Phase 4.** |

### 1.7 Fabric IQ (preview)

| Item type | Route | Editor anatomy | v2 scope |
|---|---|---|---|
| Ontology | `/items/ontology/[id]` | Entity types, properties, relationships, condition→action rules, bind-to-data panel. | **Phase 4 (shell).** |
| Graph model | `/items/graph-model/[id]` | Graph canvas + GQL query pane. | **Phase 4.** |
| Plan | `/items/plan/[id]` | Sheets grid + dimensions/measures panel + writeback/approval. | **Phase 4 (shell).** |
| Map | `/items/map/[id]` | Map canvas + layers (KQL/Lakehouse/Eventhouse/Ontology) + sources. | **Phase 4 (shell).** |
| Data agent | `/items/data-agent/[id]` | Already exists; rework to match Fabric: data sources (Lakehouse/Warehouse/KQL DB/semantic model), AI instructions, example queries, schema selection, chat preview. | **Phase 4.** Replace stub. |
| Operations agent | `/items/operations-agent/[id]` | Same shape, Eventhouse-backed + Activator outputs. | **Phase 4 (shell).** |

### 1.8 Power BI

| Item type | Route | Editor anatomy | v2 scope |
|---|---|---|---|
| Semantic model | `/items/semantic-model/[id]` | Tables pane + relationships diagram + measures (DAX editor) + roles (RLS) + perspectives + Direct Lake/Import mode. | **Phase 3.** Replace stub. |
| Report | `/items/report/[id]` | Visual canvas (shell — iframe placeholder OK) + Visualizations / Fields / Filters panes + page tabs + ribbon. | **Phase 3 (shell).** |
| Dashboard | `/items/dashboard/[id]` | Tile grid (pinned visuals). | **Phase 3 (shell).** |
| Paginated report | `/items/paginated-report/[id]` | Renderer placeholder + parameter bar. | **Phase 3 (shell).** |
| Scorecard | `/items/scorecard/[id]` | KPI tree + targets + status. Note: no REST API → metadata-only shell. | **Phase 3 (shell).** |

### 1.9 APIs / Functions / Variables

| Item type | Route | Editor anatomy | v2 scope |
|---|---|---|---|
| GraphQL API | (see 1.1) | | |
| User data function | `/items/user-data-function/[id]` | Function list + Monaco Python editor + connections (Lakehouse, Warehouse, SQL DB, Variable library, KeyVault, CosmosDB) + libraries (public PyPI + private .whl) + invoke/test pane. | **Phase 4.** |
| Variable library | `/items/variable-library/[id]` | Variables grid (name, type, value sets per environment) + value sets tab. | **Phase 4.** |

---

## 2. Cross-cutting surfaces (not items — first-class navigation primitives)

### 2.1 Workspaces (root nav primitive)

Route: `/workspaces`, `/workspaces/[id]`.

Per Fabric overview: Fabric organizes around workspaces. Each workspace is a
container for items + roles + Git integration + deployment pipelines + folders
+ task flows + monitoring (Eventhouse-backed).

Workspace settings tabs: About, Permissions (4 roles: Admin / Member /
Contributor / Viewer), Git integration, Deployment pipelines, OneDrive,
License info, Azure connections, System storage, Workspace identity,
Workspace monitoring, Sensitivity labels.

### 2.2 OneLake catalog

Route: `/onelake-catalog`.

Two tabs: **Explore** + **Govern**.

- **Explore**: domain selector → workspace tree → items list (columns: Name, Type, Owner, Refreshed, Location, Endorsement, Sensitivity). Filters: My items / Endorsed / Shared with me / item type.
- **Item details view** (drill-in): Overview, Tables (schema with binoculars→"Explore this data"), Lineage (list + graph), Monitor (run history), Permissions (subtabs vary), Sample / Preview.
- **Govern** tab (Fabric admin / data owner): inventory overview, capacities & domains, sensitivity label coverage, DLP, endorsement / description coverage, content sharing. Recommended actions + Copilot.

### 2.3 Monitor hub

Route: `/monitor`.

Pages: **Activities** (last 100 / 30 days, columns sortable/configurable),
**Schedule failures (preview)**. Per-item Historical runs (up to 30 days).
Supported item types in Activities: Copy Job, Dataflow Gen2, Dataflow Gen2
CI/CD, Datamart, dbt Job, Digital Twin Builder Flow, Experiment, Graph
model, Lakehouse, Map, Notebook, Pipeline, Semantic model, Snowflake
database, Spark job definition, User data function. Gantt view available
for pipelines.

### 2.4 Real-Time hub

Route: `/real-time-hub`.

Sections: **All data streams**, **Microsoft sources**, **Fabric events**,
**Azure sources**, **External sources**.

Source catalog (verbatim, supported sources page):
- **Azure**: Event Hubs, Service Bus (preview), IoT Hub, SQL DB CDC, PostgreSQL CDC, MySQL CDC, Cosmos DB CDC, SQL MI CDC, SQL Server on VM CDC, Azure Data Explorer, Event Grid Namespace, Blob Storage events.
- **External**: Google Cloud Pub/Sub, Amazon Kinesis Data Streams, Confluent Cloud Kafka, Apache Kafka (preview), Amazon MSK Kafka, MQTT, Solace PubSub+, Real-time weather, Cribl (preview).
- **Fabric events (discrete)**: Workspace item events, OneLake events, Job events, Capacity overview events (preview).
- **Sample data**: Bicycles, Yellow Taxi, Stock Market, Buses, S&P 500, Semantic Model Logs.

Quick actions: Subscribe to OneLake events, Act on Job events, Visualize
data (KQL dashboard), Explore data in motion, Connect weather, Set alerts.

### 2.5 Workload hub

Route: `/workload-hub`.

Two tabs: **My workloads** (installed) + **More workloads** (Microsoft + partner catalog from Workload Hub marketplace). Per-workload card: item types, compatible-with, publisher support, screenshots, certification.

### 2.6 Admin portal

Route: `/admin`.

Subpages (mirror Fabric admin portal):
- `/admin/tenant-settings` — toggleable tenant switches grouped (Power BI, Fabric, R/Python visuals, **Audit and usage**, Help and support, Workspace settings, Information protection, Export and sharing, Discovery, Developer, Integration, Q&A, Dataflow, Data protection, Template apps, AI and Copilot, OneLake, Mirroring, Real-Time Intelligence, Workload settings, Git integration, Domain management).
- `/admin/capacity` — capacities list, Fabric Capacity Metrics app entry, throttling status, region.
- `/admin/domains` — domains and subdomains.
- `/admin/security` — workspace identity audit, sensitivity labels, DLP policies, Purview hub link.
- `/admin/audit-logs` — Microsoft 365 audit log activity export.
- `/admin/usage` — Feature usage and adoption (preview) report.
- `/admin/users` — Power BI / Fabric user list + license assignments link.
- `/admin/workspaces` — tenant-wide workspace inventory.

### 2.7 Deployment pipelines

Route: `/deployment-pipelines`, `/deployment-pipelines/[id]`.

3-stage pipeline (Dev / Test / Prod) + per-stage workspace assignment + diff
view per item + deployment rules + auto-binding for default lakehouse +
deploy/compare buttons + deployment history. New UI default; old UI toggle.

### 2.8 Git integration

Surfaced **inside workspace settings**, not standalone. Tabs: provider
(Azure DevOps / GitHub), org/project/repo/branch/folder, OAuth or Service
Principal auth, Source control panel (Changes / Updates / sync status).
Selective branching (per-workspace branch switch).

### 2.9 Per-item sharing + permissions + sensitivity

Item context menu → Manage permissions → tabs: Direct access, Pending
requests, Access links. Plus: Apply sensitivity label, Endorse (promoted /
certified).

### 2.10 + New item dialog

Modal launched from workspace `+ New item` button or workload hub. Two
panes: workload category list (Data Engineering, Data Factory, Data
Warehouse, Databases, Real-Time Intelligence, Data Science, Fabric IQ,
Power BI, APIs, More) → item type grid. Per-item card: name, description,
docs link. Bottom: name input + workspace selector + sensitivity label
selector + Create button.

---

## 3. Item-editor anatomy (from Fabric Extensibility Toolkit)

Verbatim from `extensibility-toolkit/concept-item-overview`. Every editor in
Loom Console v2 must follow this skeleton.

Five components per item:

1. **ItemModel** — TypeScript shape stored as the item definition (matches the per-item REST `definition` format).
2. **ItemEditor** — main interface, two-panel layout (resizable splitter).
3. **ItemEditorEmpty** — first-run / onboarding view.
4. **ItemEditorDetail** — drill-down for hierarchical content.
5. **ItemEditorRibbon** — toolbar (Home + per-item additional tabs).

Default panels:
- **Left**: navigation / file explorer / OneLake tree.
- **Center**: main content (auto-scroll).
- **Collapsible** with full a11y support.

Ribbon system:
- **Home** toolbar: Save, Settings, Share, Sensitivity, Endorsement, Git status.
- **Additional** toolbars per item type (e.g. Notebook "Run", Pipeline "Activities", Warehouse "Query").
- Tooltip integration.

Cross-item features expected on every editor (per Fabric design):
- Copilot side-pane (Phase 6).
- Recent runs button (opens Monitor hub filtered).
- Sharing button.
- Open in VS Code / Open in Excel (where applicable).
- Source control button (commit/update).

---

## 4. Route map (target state for Console v2)

Top-level (left nav, Fabric IA order):

```
/                       Home (recents + favorites + create card)
/workspaces             Workspace list (root primitive)
/workspaces/[id]        Workspace detail (items list + folders + task flow)
/browse                 Browse (shared with me, recent, favorites)
/onelake-catalog        OneLake catalog (Explore + Govern tabs)
/monitor                Monitor hub
/real-time-hub          Real-Time hub
/data-agent             Data agent landing (existing)
/copilot                Copilot full-screen (existing partial)
/workload-hub           My + More workloads
/deployment-pipelines   Deployment pipelines
/admin                  Admin portal (subpages as in §2.6)
/setup                  Loom-specific setup wizard (existing — keep)

/items/[type]/[id]      Per-item editor (route table in §1)
/items/new              + New item dialog (modal, but also full route)
```

Auth routes:

```
/auth/sign-in           MSAL initiate
/auth/callback          MSAL redirect target
/auth/sign-out          POST + clear session
```

API routes (BFF):

```
/api/health             (exists, do not remove)
/api/workspaces         (exists)
/api/workspaces/[id]/items
/api/items/[type]       List per type
/api/items/[type]/[id]  CRUD
/api/items/[type]/[id]/definition
/api/onelake/tree
/api/monitor/activities
/api/real-time-hub/sources
/api/admin/tenant-settings
/api/admin/capacity
/api/deployment-pipelines
/api/git/status
```

---

## 5. Authoritative quirks captured in research

- **Reflex == Activator.** Both names appear in REST; UI uses Activator.
- **Dataflow Gen1 and Scorecard have no REST API** (item-management-overview note). Stub-only in Loom; do not promise programmatic CRUD.
- **Workspace roles** are 4-tier (Admin / Member / Contributor / Viewer). Contributor can read+write items but cannot reshare. Workspace settings only Admin can edit; Git integration setup is Admin-only.
- **OneLake security** has additional default roles per item type (Lakehouse DefaultReader for ReadAll, etc.) — separate from workspace roles. Surface this in Lakehouse permissions tab.
- **Eventhouse system overview** has 9 fixed cards (storage, system resources, compute usage, top 5 users by minutes, ingestion rate, top 10 queried DBs, top 10 ingested DBs, what's new last 7 days). Mirror exactly.
- **Pipeline activities** are the *full* list in §1.2 (33 types). Categorize in the activity palette by group: General / Move & Transform / Orchestration / Iteration & Conditionals / Notifications / Custom.
- **Notebook kernels** are 4 Spark languages + 2 Python (3.10, 3.11). VFS mode for VS Code is a published feature — link out, don't reimplement.
- **DeltaFlow CDC** is the analytics-ready transform variant on Eventstream CDC sources. Tag in source picker.
- **Mirrored database source types** (8): Snowflake, AzureSqlDatabase, AzureSqlMI, AzurePostgreSql, CosmosDb, SqlServer2025, MSSQL (2016-2022), GenericMirror. Wizard picks one.

