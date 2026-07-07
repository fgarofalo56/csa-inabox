# Item catalog

CSA Loom ships **118 item types** across **22 workload categories**. Every item is **Azure-native by default** — none requires a Microsoft Fabric capacity, a Fabric workspace, or a Power BI workspace to function (see [Fabric → Azure-native mapping](fabric-to-azure-mapping.md) and the die-hard rule in `.claude/rules/no-fabric-dependency.md`). A Fabric or Power BI backend, where one exists, is strictly **opt-in** via an `LOOM_<ITEM>_BACKEND=fabric` environment flag plus a bound workspace.

This list is generated from `apps/fiab-console/lib/catalog/item-types/*.ts` — the same catalog the console's New-item gallery reads. Each row shows the item, its route slug (`/items/<slug>/<id>`), and the Azure-native backend it runs on.

!!! tip "Badges"
    **Preview** — surfaced in the gallery with a Preview badge. **Labs** — hidden behind the gallery's *Show Labs items* toggle. **Deprecated** — no create path; the editor offers a migration action. **Alias** — a preset that resolves to a unified sibling editor; already-created instances keep working.

## Data Engineering

| Item | Slug | What it is / Azure-native backend |
|------|------|-----------------------------------|
| Environment | `environment` | Reusable Spark settings and library bundle for notebooks and jobs. |
| Lakehouse | `lakehouse` | A unified store for files, folders, and Delta tables in ADLS Gen2 (Delta) — Azure-native, no Fabric required. |
| Lakehouse shortcut | `lakehouse-shortcut` | An ADLS external-location pointer (abfss shortcut) — read external Delta/Parquet in place without copying. Azure-native OneLake-shortcut equivalent. |
| Materialized lake view <br/>**Preview** | `materialized-lake-view` | A persisted, auto-refreshed Delta view defined in Spark SQL or PySpark over your lakehouse. |
| Notebook | `notebook` | Interactive Spark / Python authoring with cells and outputs. |
| Spark environment | `spark-environment` | Full lifecycle Spark environment: runtime version, compute config, public libraries (pip/conda), custom libraries (whl/jar), and Spark properties. Publish bakes the spec into a Synapse Spark pool; attach to notebooks and Spark job definitions. |
| Spark job definition | `spark-job-definition` | Run a compiled Spark application (JAR / .py) against your lakehouse. |

## Synapse Analytics

| Item | Slug | What it is / Azure-native backend |
|------|------|-----------------------------------|
| Synapse dedicated SQL pool | `synapse-dedicated-sql-pool` | Provisioned, MPP T-SQL warehouse. Query editor, monitoring, scaling — native in Loom. |
| Synapse notebook | `synapse-notebook` | Spark notebook designer — multi-cell PySpark/Scala/SQL on a Synapse Big Data pool. |
| Synapse pipeline <br/>**Alias** | `synapse-pipeline` | Synapse Integrate canvas — pipelines, dataflows, triggers native to Synapse. |
| Synapse serverless SQL pool | `synapse-serverless-sql-pool` | Pay-per-query T-SQL over ADLS. OPENROWSET, external tables, ad-hoc analytics. |
| Synapse Spark pool | `synapse-spark-pool` | Apache Spark notebooks + job definitions on Synapse-managed clusters. |

## Azure Databricks

| Item | Slug | What it is / Azure-native backend |
|------|------|-----------------------------------|
| Databricks cluster | `databricks-cluster` | All-purpose or job cluster — node types, autoscale, init scripts, libraries. |
| Databricks job | `databricks-job` | Multi-task Databricks job — notebooks, JARs, Python wheels, dbt, SQL. |
| Databricks notebook | `databricks-notebook` | Databricks notebook cells (PySpark / SQL / R / Scala) with cluster attach. |
| Databricks SQL warehouse | `databricks-sql-warehouse` | Serverless / classic SQL warehouse with Unity Catalog and Photon. |

## Data Factory

| Item | Slug | What it is / Azure-native backend |
|------|------|-----------------------------------|
| Apache Airflow job <br/>**Preview** | `airflow-job` | Managed Airflow DAGs synced from a Git repo (preview). |
| Copy job | `copy-job` | Wizard-driven bulk ingestion from any supported connector. |
| Data pipeline | `data-pipeline` | Orchestrate Copy, Lookup, ForEach, Notebook, Stored procedure, Web, and more. |
| Dataflow Gen2 | `dataflow` | Low-code Power Query data prep with visual + M code authoring. |
| dbt job | `dbt-job` | Visually build a dbt project (sources, models, tests, materializations), generate real project files, and run them against Databricks or Synapse. |
| Integration runtime | `integration-runtime` | Azure, Self-Hosted, or Azure-SSIS compute that powers activity dispatch, data movement, and data-flow execution for pipelines. |
| Linked service | `linked-service` | A reusable connection definition — the bind target for pipelines, datasets, and data flows. 31-connector gallery over Azure Data Factory (default) or a Synapse workspace. |
| Logic App | `logic-app` | Azure Logic Apps (Consumption) workflow: triggers + actions in the WDL designer, run via the manual trigger. |
| Mapping data flow | `mapping-dataflow` | Visually design a Spark-executed data flow — Source, schema/row transformations, and Sink — that runs on an integration runtime. |
| Mirrored database | `mirrored-database` | Near-real-time replica of Snowflake / SQL DB / Postgres / Cosmos / MSSQL into ADLS Bronze (Delta) — Azure-native CDC, no Fabric required. |
| Mirrored Databricks catalog | `mirrored-databricks` | Mount a Databricks Unity Catalog as a read-only mirror to ADLS Gen2 Delta — Azure-native, no Fabric required. |
| Mounted Data Factory | `mounted-adf` | Reference an existing Azure Data Factory and run its pipelines from Loom — Azure-native, no Fabric required. |

## Azure Data Factory

| Item | Slug | What it is / Azure-native backend |
|------|------|-----------------------------------|
| ADF dataset | `adf-dataset` | Typed dataset over linked services — JSON, Parquet, Delimited, SQL, REST, etc. |
| ADF pipeline <br/>**Alias** | `adf-pipeline` | The ADF-runtime preset of the Data pipeline — classic Azure Data Factory: 90+ activities, IR-aware, on-prem via Self-hosted IR. |
| ADF trigger | `adf-trigger` | Schedule, tumbling window, storage event, or custom event trigger. |

## Streaming analytics

| Item | Slug | What it is / Azure-native backend |
|------|------|-----------------------------------|
| Stream Analytics job | `stream-analytics-job` | Continuous SQL-style queries over real-time streams (Event Hubs / IoT Hub / Blob) writing to Blob / SQL / Power BI / Event Hub / ADX / Cosmos. |

## Data Warehouse

| Item | Slug | What it is / Azure-native backend |
|------|------|-----------------------------------|
| Datamart (deprecated) <br/>**Deprecated** | `datamart` | DEPRECATED — migration template. Power BI datamarts migrate to a Synapse Serverless warehouse + Azure Analysis Services semantic model. No new datamarts can be created; use the Migrate action on existing ones. |
| SQL analytics endpoint | `sql-analytics-endpoint` | Read-only T-SQL analyst surface auto-attachable to a lakehouse / warehouse / mirror — Synapse serverless SQL over the Delta in ADLS. SELECT, CREATE VIEW / PROC, and object / row-level grants. |
| Warehouse | `warehouse` | Lakehouse-native T-SQL warehouse with separated compute and storage. |

## Databases

| Item | Slug | What it is / Azure-native backend |
|------|------|-----------------------------------|
| Azure Cosmos DB account | `azure-cosmos-account` | Cosmos DB for NoSQL — a live Data Explorer over databases, containers, throughput, and server-side scripts. |
| PostgreSQL Flexible Server | `postgres-flexible-server` | Azure Database for PostgreSQL Flexible Server — list/provision via ARM, databases + firewall, schema browser, catalog registration. |
| SQL database | `sql-database` | Unified Azure database surface — Azure SQL DB, SQL Managed Instance, or PostgreSQL Flexible Server. Tenant inventory, provision, query, schema, and OneLake/Purview catalog. |

## Azure SQL Database

| Item | Slug | What it is / Azure-native backend |
|------|------|-----------------------------------|
| Azure SQL database | `azure-sql-database` | Per-database T-SQL editor (TDS + AAD), mirroring config, geo-replication, vector index. |
| Azure SQL server | `azure-sql-server` | Microsoft.Sql/servers — server-level admin, firewall, AAD admin, list of databases. |
| SQL Managed Instance | `azure-sql-managed-instance` | Microsoft.Sql/managedInstances — list + state, live sys.* schema navigator, and T-SQL query execution over TDS (via the private endpoint). |
| SQL Server 2025 vector index | `sql-server-2025-vector-index` | SQL Server 2025 native vector index — CREATE VECTOR INDEX, JSON_AGG, regex, similarity search. |

## Real-Time Intelligence

| Item | Slug | What it is / Azure-native backend |
|------|------|-----------------------------------|
| Activator | `activator` | Detect conditions and trigger actions (Teams, email, pipeline, notebook, Power Automate). |
| Event Grid topic | `event-grid-topic` | Azure Event Grid custom topic + event subscriptions — reactive event routing with CloudEvents schema. Real ARM. |
| Event Hubs namespace | `event-hubs-namespace` | Azure Event Hubs namespace + event hubs — the Kafka-compatible messaging backbone behind Eventstreams. Real ARM. |
| Event schema set | `event-schema-set` | Schema registry for event streams powering DeltaFlow CDC. |
| Eventhouse | `eventhouse` | Compute + storage container for one or more KQL databases. |
| Eventstream | `eventstream` | Visual canvas to ingest, transform, and route real-time event streams. |
| KQL database | `kql-database` | Kusto database (Azure Data Explorer) for high-volume, low-latency analytics with ADLS Delta export — Azure-native, no Fabric required. |
| KQL queryset | `kql-queryset` | Persisted set of KQL queries with charts and saved views. |
| Real-Time dashboard | `kql-dashboard` | Tile grid powered by KQL queries with parameters and auto-refresh. |
| Service Bus namespace | `service-bus-namespace` | Azure Service Bus namespace + queues/topics — enterprise message broker with FIFO, sessions, and pub/sub. Real ARM. |
| Workspace monitoring | `workspace-monitor` | Read-only ADX database of platform usage/performance telemetry, fed by Azure Monitor diagnostic settings. |

## Data Science

| Item | Slug | What it is / Azure-native backend |
|------|------|-----------------------------------|
| AutoML | `automl` | Low-code Automated ML wizard — pick a task, dataset, and compute; AutoML finds the best model. |
| ML experiment | `ml-experiment` | Track runs, parameters, metrics, and artifacts for a model family. |
| ML model | `ml-model` | MLflow-backed registered model with versions and PREDICT endpoint. |

## Azure AI Foundry

| Item | Slug | What it is / Azure-native backend |
|------|------|-----------------------------------|
| AI Foundry hub | `ai-foundry-hub` | Azure AI Foundry hub workspace — connections, models, online endpoints, computes, datastores, and jobs. Native in Loom. |
| AI Foundry project | `ai-foundry-project` | Child workspace under the Foundry hub. Inherits connections/models/datastores; scopes prompt flows, evaluations, and data assets. |
| AI Search index | `ai-search-index` | Azure AI Search index — fields, scoring profiles, vector + hybrid query. Backs RAG grounding for Foundry agents. |
| Content Safety | `content-safety` | Azure AI Content Safety: text + image moderation across hate/violence/sexual/self-harm with severity thresholds. |
| Foundry compute | `compute` | AML compute instances + clusters. Create, start, stop, scale, delete. Used by prompt flows, evaluations, training jobs. |
| Foundry dataset | `dataset` | AML data asset — URI file, URI folder, or MLTable. Versioned, used by prompt flows + evaluations + training runs. |
| Foundry evaluation | `evaluation` | Run quality / safety / accuracy evaluators against a dataset + model deployment. Surfaces metric tables and pass/fail signals. |
| Foundry tracing | `tracing` | Operation traces (App Insights) for prompt flow runs, evaluator runs, and endpoint calls. Filter by operation + window. |
| Prompt flow | `prompt-flow` | LangChain-style flow graph of LLM + tool nodes. Author the YAML/JSON definition, run with inputs, view run history. |

## AI & Agents

| Item | Slug | What it is / Azure-native backend |
|------|------|-----------------------------------|
| Cross-item Copilot | `cross-item-copilot` | Natural-language orchestrator across every wired Loom service: Synapse, Lakehouse, Databricks, APIM, ADX, ADF, Power BI, Fabric, Foundry. 25+ tools. |

## Copilot Studio

| Item | Slug | What it is / Azure-native backend |
|------|------|-----------------------------------|
| Copilot action | `copilot-studio-action` | Power Automate flow, custom connector, or prebuilt action bound to a Copilot Studio agent. |
| Copilot analytics | `copilot-studio-analytics` | Sessions, resolution rate, escalation rate, and CSAT for a Copilot Studio agent (last 30 days by default). |
| Copilot channel | `copilot-studio-channel` | Publish an agent to Teams, Web chat, Direct Line, Slack, or a custom channel. |
| Copilot knowledge source | `copilot-studio-knowledge` | Grounding source for an agent — URL, file, SharePoint site, or Dataverse table. |
| Copilot Studio agent | `copilot-studio-agent` | Conversational agent stored in Power Platform Dataverse. Instructions, knowledge, topics, actions, channels — native in Loom. |
| Copilot template library | `copilot-template-library` | CSA-curated agent templates: data steward, contract analyzer, RFP responder, etc. |
| Copilot topic | `copilot-studio-topic` | Trigger-phrase-driven dialog flow authored in Copilot Studio YAML. |

## Fabric IQ

| Item | Slug | What it is / Azure-native backend |
|------|------|-----------------------------------|
| Data agent | `data-agent` | Conversational Q&A grounded in your data sources and semantic model. |
| Graph model <br/>**Preview** | `graph-model` | Native graph storage + GQL queries for connected data. |
| Health check <br/>**Preview** | `health-check` | Data-freshness / SLA monitoring with real Azure Monitor scheduled-query alert rules. |
| Map <br/>**Preview** | `map` | Geospatial visualization layered over Lakehouse, KQL, and Ontology data. |
| Ontology <br/>**Preview** | `ontology` | Define business entities, relationships, and condition-action rules. |
| Ontology SDK <br/>**Preview** | `ontology-sdk` | Typed TypeScript / Python SDK + REST Data API generated over an Ontology’s object, link, and action types. |
| Operations agent <br/>**Preview** | `operations-agent` | Monitor real-time data and recommend actions via Activator + Power Automate. |
| Plan <br/>**Preview** | `plan` | Collaborative planning sheets with writeback and approvals. |
| Release environment <br/>**Preview** | `release-environment` | Promotion / release orchestration across workspaces — Azure Deployment Environments + ARM deployment history. |
| Spindle (AIP Logic & agents) <br/>**Preview** | `aip-logic` | Spindle Studio — author typed AI logic AND tool-calling agents over the Weave ontology: typed input → ordered steps → typed output, grounded on the ontology, runnable on Azure OpenAI / Foundry. |

## Azure Graph + Vector

| Item | Slug | What it is / Azure-native backend |
|------|------|-----------------------------------|
| Cosmos Gremlin graph | `cosmos-gremlin-graph` | Cosmos DB for Apache Gremlin — graph traversal queries over property graphs. |
| Cypher graph | `cypher-graph` | openCypher dialect over Cosmos / Neptune-compatible / ADX graph plugin. |
| GQL graph | `gql-graph` | ISO GQL standard graph query language against the graph backend of record. |
| Tapestry (investigative graph) <br/>**Preview** · **Labs** | `tapestry` | Investigative link-analysis + geospatial + timeline workspace over the ADX graph (make-graph / graph-match) and Azure Maps. The Azure-native equivalent of a Gotham-class investigation surface — no Microsoft Fabric required. |
| Vector store | `vector-store` | Vector index — Cosmos vCore, AI Search, or PostgreSQL pgvector. Similarity search + RAG grounding. |

## Azure Geoanalytics

| Item | Slug | What it is / Azure-native backend |
|------|------|-----------------------------------|
| Geo dataset | `geo-dataset` | GeoJSON / Parquet+geometry dataset in ADLS Gen2. Geometry-column inspector + sample preview. |
| Geo map | `geo-map` | Azure Maps account + style + tile layer config. OSM fallback when no Maps account is deployed. |
| Geo pipeline | `geo-pipeline` | A Data-pipeline template that builds a real geo-enrichment pipeline (H3 index, reverse geocode, buffer) pre-wired against Azure Maps + ADF. |
| Geo query | `geo-query` | Spatial query against Synapse Serverless / Kusto — H3, S2, ST_DISTANCE, ST_WITHIN. |

## Power BI

| Item | Slug | What it is / Azure-native backend |
|------|------|-----------------------------------|
| Dashboard | `dashboard` | Tile canvas for at-a-glance KPIs — Loom-native streaming (ADX) and Q&A (DAX) tiles. |
| Paginated report | `paginated-report` | Pixel-perfect RDL report for printable, parameterized output — Loom-native designer and export. |
| Report | `report` | Interactive report with pages, visuals, and filters — Loom-native designer and renderer. |
| Scorecard | `scorecard` | KPI/OKR tree with targets, check-ins, and status rollups — Loom-native goal store. |
| Semantic model | `semantic-model` | Tables, relationships, measures, and roles — Loom-native tabular layer over your warehouse or lakehouse. |

## CSA Data Products

| Item | Slug | What it is / Azure-native backend |
|------|------|-----------------------------------|
| Data marketplace | `data-marketplace` | Consumer discovery hub for Published data products — faceted search, governance-domain card grid, and access requests. Backed by Azure AI Search. Now a core surface under the unified Loom Marketplace (/marketplace). |
| Data product | `data-product` | Data-mesh-aligned package: dataset + semantic contract + APIM API + access policy + owner. Listed in the marketplace. |
| Data product instance | `data-product-instance` | Instantiated data product in a workspace — composed of underlying items (pipelines, lakehouses, indexes). |
| Data product template | `data-product-template` | CSA-curated push-button template: medallion lakehouse, IoT analytics, federated mesh, RAG agent, geospatial. |

## APIs and functions

| Item | Slug | What it is / Azure-native backend |
|------|------|-----------------------------------|
| API for GraphQL | `graphql-api` | Single GraphQL endpoint over Warehouse / Lakehouse / SQL DB / mirrored DBs. |
| APIM API | `apim-api` | A versioned API on Azure API Management. Auto-imports OpenAPI / GraphQL / WSDL; ties to Loom items as backends. |
| APIM policy | `apim-policy` | Inbound / backend / outbound / on-error XML policy: JWT validation, rate-limit, cache, transform, mock. |
| APIM product | `apim-product` | Bundles APIs into a subscribable offering: rate limits, quotas, terms, publisher portal landing. |
| Data API | `data-api-builder` | Data API builder — expose Azure SQL / PostgreSQL / Cosmos tables as secured REST + GraphQL. |
| User data function | `user-data-function` | Python functions (Azure Functions) with bindings to Azure data sources and external connections. |
| Variable library | `variable-library` | Centralized variables with value sets per environment (dev / test / prod). |

## Power Platform

| Item | Slug | What it is / Azure-native backend |
|------|------|-----------------------------------|
| AI Builder model | `ai-builder-model` | AI Builder model (msdyn_aimodel) — prediction / extraction / classification / form-processing. State + status from Dataverse. |
| Dataverse table | `dataverse-table` | Dataverse EntityDefinition — schema, attributes, primary keys, custom vs system. Sourced from Dataverse Web API v9.2. |
| Power App | `power-app` | Canvas or model-driven Power App in an environment — owner, last modified, play link. Sourced from the PowerApps admin API. |
| Power Automate flow | `power-automate-flow` | Cloud flow in Power Automate — state, trigger, run history, manual run. Sourced from the Flow admin API. |
| Power Pages site | `power-page` | Power Pages website (mspp_website / adx_website) — domain, status, type. Sourced from Dataverse Web API. |
| Power Platform environment | `powerplatform-environment` | Power Platform environment surfaced via the BAP admin API — SKU, region, Dataverse domain, security group, DLP summary. |

## Loom Apps

| Item | Slug | What it is / Azure-native backend |
|------|------|-----------------------------------|
| Data app <br/>**Preview** | `rayfin-app` | Backed template — scaffolds a runnable Azure-native data-app stack: Azure Functions (API tier) + Cosmos DB (data store) + a Static Web App (web tier), wired together. No Fabric. |
| Loom app | `loom-app` | Bundle workspace items — reports, dashboards, notebooks and more — into a distributable app with navigation and audiences. Azure-native; no Power BI or Fabric workspace. |
| Slate app <br/>**Preview** | `slate-app` | Backed template — scaffolds a real Workshop app + Data API (data-api-builder) stack over a query surface. Azure-native; deploys to Azure Static Web Apps. No Fabric. |
| Workshop app <br/>**Preview** | `workshop-app` | Operational low-code app bound to an Ontology — object views, link traversal, and write-back actions. |

