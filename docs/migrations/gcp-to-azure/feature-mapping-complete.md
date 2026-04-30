# Complete Feature Mapping: GCP to Azure

**The definitive feature-by-feature reference for mapping every GCP analytics and data service to its Microsoft Azure equivalent.**

**Audience:** Platform architects, migration leads, and technical evaluators
**Last updated:** 2026-04-30

---

## Summary

This reference maps **55+ GCP services** across 8 capability domains to their Azure equivalents. Each mapping includes migration complexity, the CSA-in-a-Box evidence path (where the pattern exists in the repository), and notes on gaps or limitations.

| Metric | Count |
|---|---|
| Total features mapped | 55 |
| Full parity (XS-M effort) | 42 |
| Partial parity (L effort) | 10 |
| Known gaps (XL or roadmap) | 3 |

### Migration complexity key

| Rating | Description | Typical effort |
|---|---|---|
| XS | Drop-in replacement or native Azure capability | < 1 day |
| S | Minor configuration or adaptation required | 1-3 days |
| M | Moderate development; requires design decisions | 1-3 weeks |
| L | Significant development; architectural changes | 1-3 months |
| XL | Major initiative; phased delivery | 3+ months |

---

## 1. Storage

| # | GCP service | Description | Azure equivalent | Complexity | CSA-in-a-Box evidence | Notes |
|---|---|---|---|---|---|---|
| 1 | **GCS buckets** | Object storage with lifecycle policies | ADLS Gen2 containers + OneLake | S | `csa_platform/unity_catalog_pattern/onelake_config.yaml` | Hierarchical namespace on ADLS replaces flat GCS bucket model |
| 2 | **GCS object lifecycle** | Automatic tier transition (Standard/Nearline/Coldline/Archive) | ADLS Gen2 lifecycle management (Hot/Cool/Archive) | XS | Azure Storage policy via Bicep | 1:1 mapping of tier transitions |
| 3 | **GCS object versioning** | Version history for objects | ADLS Gen2 soft delete + versioning | XS | Azure Storage versioning | 1:1 for audit/recovery |
| 4 | **GCS retention policy (WORM)** | Immutable storage for compliance | ADLS Gen2 immutable storage (time-based) | XS | Azure Storage immutability | 1:1 compliance mapping |
| 5 | **GCS signed URLs** | Temporary authenticated access to objects | Azure Storage SAS tokens | XS | Azure Storage SAS patterns in Bicep | Direct analog |
| 6 | **GCS dual/multi-region** | Geo-redundant storage | ADLS Gen2 geo-replication + object replication | S | `docs/DR.md`, `docs/MULTI_REGION.md` | For DR and multi-region patterns |
| 7 | **BigQuery managed storage** | Proprietary Capacitor columnar format | Delta Lake on ADLS Gen2 | M | ADR-0003 `docs/adr/0003-delta-lake-over-iceberg-and-parquet.md` | Open format; requires export from BigQuery |
| 8 | **Bigtable** | Wide-column NoSQL (HBase-compatible) | Azure Cosmos DB (Table API) / Azure Data Explorer | M | N/A -- use Azure native | Cosmos DB Table API for HBase compatibility |
| 9 | **Cloud Firestore** | Document database (serverless) | Azure Cosmos DB (NoSQL API) | M | N/A -- use Azure native | Cosmos DB is the closest analog |
| 10 | **Cloud Spanner** | Globally distributed relational database | Azure Cosmos DB (PostgreSQL) / Azure SQL Hyperscale | L | N/A -- use Azure native | No exact analog; Cosmos DB PostgreSQL covers most patterns |
| 11 | **Memorystore (Redis)** | Managed Redis/Memcached | Azure Cache for Redis | XS | N/A -- use Azure native | Direct drop-in replacement |
| 12 | **Cloud SQL** | Managed MySQL/PostgreSQL/SQL Server | Azure Database for MySQL/PostgreSQL / Azure SQL | XS | N/A -- use Azure native | 1:1 managed database replacement |

---

## 2. Compute and warehouse

| # | GCP service | Description | Azure equivalent | Complexity | CSA-in-a-Box evidence | Notes |
|---|---|---|---|---|---|---|
| 13 | **BigQuery SQL (warehouse)** | Serverless SQL analytics | Databricks SQL Warehouses / Fabric Warehouse | M | `csa_platform/unity_catalog_pattern/`, ADR-0002 | Dialect differences documented in playbook Section 4.3 |
| 14 | **BigQuery slots (autoscaling)** | Compute unit allocation | Databricks DBUs / Fabric CUs | M | ADR-0010 `docs/adr/0010-fabric-strategic-target.md` | Slots map to DBUs; edition commitments map to reserved capacity |
| 15 | **BigQuery partitioned tables** | Date/integer/ingestion-time partitioning | Delta Lake partitioning | S | ADR-0003 | Partition column translates directly |
| 16 | **BigQuery clustered tables** | Automatic block co-location by column | Delta Lake Z-ordering | S | ADR-0003 | Cluster keys become ZORDER columns in `OPTIMIZE` |
| 17 | **BigQuery materialized views** | Auto-refreshing precomputed views | dbt incremental models + Delta Live Tables | M | `domains/shared/dbt/dbt_project.yml` | DLT for streaming refresh; dbt incremental for batch |
| 18 | **BigQuery scheduled queries** | Cron-based query execution | dbt jobs + ADF triggers + Databricks Workflows | S | ADR-0001 `docs/adr/0001-adf-dbt-over-airflow.md` | Simple schedules map to Workflows; cross-system to ADF |
| 19 | **BigQuery BI Engine** | In-memory acceleration for BI queries | Power BI Direct Lake mode | M | `csa_platform/semantic_model/` | Direct Lake eliminates import; equivalent acceleration |
| 20 | **BigQuery ML** | `CREATE MODEL` + `ML.PREDICT` inline SQL | Databricks MLflow + `ai_query()` | L | `csa_platform/ai_integration/model_serving/` | MLflow training notebooks replace `CREATE MODEL`; `ai_query()` replaces `ML.PREDICT` |
| 21 | **BigQuery Omni** | Cross-cloud query (S3, Azure Storage) | OneLake shortcuts + Lakehouse Federation | M | `csa_platform/unity_catalog_pattern/onelake_config.yaml` | Covers Azure-side read; true multi-cloud UX not fully matched |
| 22 | **BigQuery INFORMATION_SCHEMA** | Catalog metadata queries | Databricks `information_schema` + Unity Catalog system tables | XS | `csa_platform/unity_catalog_pattern/` | Direct feature parity |
| 23 | **BigQuery authorized views** | Secure row-level filtered views | Unity Catalog row filters + fine-grained GRANTs | M | `csa_platform/unity_catalog_pattern/unity_catalog/` | Row filters + column masks replace authorized view model |
| 24 | **BigQuery table-valued functions** | Parameterized SQL functions | dbt macros + Databricks SQL UDFs | M | `domains/shared/dbt/macros/` | SQL TVFs map to dbt macros or UDFs |
| 25 | **BigQuery stored procedures** | Imperative SQL procedures | Databricks SQL UDFs + notebook jobs | M | `domains/shared/notebooks/` | Imperative logic moves to notebooks |
| 26 | **BigQuery search indexes** | Full-text search on tables | Azure AI Search + Databricks Vector Search | M | `csa_platform/ai_integration/rag/pipeline.py` | AI Search provides richer search capabilities |
| 27 | **BigQuery vector search** | Embedding similarity search | Databricks Vector Search + Azure AI Search | M | `csa_platform/ai_integration/rag/` | Vector search capabilities available in both Databricks and AI Search |
| 28 | **BigQuery row-level security** | Row-level access policies | Unity Catalog row filters | M | `csa_platform/unity_catalog_pattern/unity_catalog/` | Policy functions translate to UC row filter functions |
| 29 | **BigQuery column-level security** | Policy tags on columns | Unity Catalog column masks + Purview classifications | M | `csa_platform/csa_platform/governance/purview/classifications/` | Policy tags map to Purview classifications |
| 30 | **BigQuery Analytics Hub** | Dataset exchange / sharing | Delta Sharing + Purview data products | L | `csa_platform/data_marketplace/` | Outbound via Delta Sharing; inbound via OneLake shortcuts |
| 31 | **BigQuery streaming inserts** | Real-time row ingestion | Event Hubs + Databricks Structured Streaming | M | ADR-0005 `docs/adr/0005-event-hubs-over-kafka.md` | Streaming insert becomes Event Hub producer |
| 32 | **BigQuery Data Transfer Service** | Scheduled data imports | ADF Copy Activity + schedule triggers | S | `domains/shared/pipelines/adf/` | ADF supports all DTS source types |
| 33 | **Dataproc (managed Spark)** | Spark/Hive/Presto on managed VMs | Azure Databricks | M | ADR-0002 `docs/adr/0002-databricks-over-oss-spark.md` | Photon runtime provides better performance |
| 34 | **Dataproc Serverless** | Serverless Spark jobs | Databricks Serverless SQL + Jobs | S | ADR-0010 | Job-shaped serverless mapping |
| 35 | **Dataproc Presto/Trino** | Federated SQL query engine | Databricks SQL (Lakehouse Federation) | M | `csa_platform/unity_catalog_pattern/` | Query federation via Lakehouse Federation |
| 36 | **Dataproc Flink** | Stateful stream processing | Azure Stream Analytics + Databricks Structured Streaming | M | ADR-0005, `examples/iot-streaming/stream-analytics/` | ASA for SQL-first; Databricks for code-first |
| 37 | **Dataproc Hive metastore** | Catalog for Spark tables | Unity Catalog (primary) + external Hive MS | M | `csa_platform/unity_catalog_pattern/unity_catalog/` | Bridge via external metastore; target is Unity Catalog |
| 38 | **Dataproc autoscaling** | Worker node auto-scaling | Databricks cluster autoscaling + serverless | XS | ADR-0002 | Serverless removes tuning burden |

---

## 3. ETL and orchestration

| # | GCP service | Description | Azure equivalent | Complexity | CSA-in-a-Box evidence | Notes |
|---|---|---|---|---|---|---|
| 39 | **Cloud Composer (Airflow)** | Managed Apache Airflow | ADF pipelines + Databricks Workflows | M | ADR-0001 `docs/adr/0001-adf-dbt-over-airflow.md` | GCP operators become ADF activities; Python operators become notebooks |
| 40 | **Dataflow (Apache Beam)** | Managed Beam runner (batch + streaming) | ADF + Databricks / Stream Analytics | L | `domains/shared/pipelines/adf/` | Batch Beam pipelines map to ADF; streaming to ASA or Structured Streaming |
| 41 | **Dataform** | SQL transformation with dependencies | dbt | S | `domains/shared/dbt/` | Very close conceptual mapping; Dataform SQLX to dbt SQL models |
| 42 | **Pub/Sub** | Managed message queue / event streaming | Event Hubs (Kafka protocol) / Event Grid | M | ADR-0005, `docs/guides/event-hubs.md` | Event Hubs Kafka endpoint for existing Kafka clients |
| 43 | **Cloud Functions** | Serverless event-driven compute | Azure Functions | S | `csa_platform/functions/` | Direct replacement with same trigger model |
| 44 | **Cloud Run** | Serverless container execution | Azure Container Apps | S | N/A -- use Azure native | Container Apps provides similar auto-scaling model |
| 45 | **Cloud Scheduler** | Managed cron service | ADF schedule triggers / Azure Logic Apps | XS | `domains/shared/pipelines/adf/` | ADF schedules or Logic Apps for cron-style triggers |

---

## 4. Business intelligence

| # | GCP service | Description | Azure equivalent | Complexity | CSA-in-a-Box evidence | Notes |
|---|---|---|---|---|---|---|
| 46 | **Looker** | Enterprise BI + semantic layer (LookML) | Power BI + dbt semantic layer | L | `csa_platform/semantic_model/` | LookML views become Power BI tables; measures become DAX; see playbook Section 4.7 |
| 47 | **Looker Studio** | Self-service dashboards | Power BI Desktop / Service | S | `examples/commerce/reports/` | Simpler migration than full Looker |
| 48 | **Looker Explores** | Ad-hoc data exploration UI | Power BI Explore + Q&A + Copilot | S | `csa_platform/semantic_model/` | Copilot adds NL query capability |
| 49 | **Looker embedding** | Embedded analytics in custom apps | Power BI Embedded / Fabric Embedded | S | `portal/react-webapp/src/` | Direct analog; license model differs |
| 50 | **Looker Action Hub** | Triggered actions from BI events | Data Activator + Event Grid + Power Automate | M | `csa_platform/data_activator/` | Actions fire into Azure Functions / Logic Apps |
| 51 | **Looker scheduled deliveries** | Email/Slack report distribution | Power BI subscriptions + Power Automate | XS | `portal/powerapps/` | 1:1 feature mapping |

---

## 5. AI and ML

| # | GCP service | Description | Azure equivalent | Complexity | CSA-in-a-Box evidence | Notes |
|---|---|---|---|---|---|---|
| 52 | **Vertex AI Training** | Custom model training | Azure ML / Databricks ML | M | `csa_platform/ai_integration/` | Standard ML workflow; SKLearn/PyTorch/TF all supported |
| 53 | **Vertex AI AutoML** | Automated ML training | Azure AutoML / Databricks AutoML | M | N/A -- use Azure native | Comparable automated ML capabilities |
| 54 | **Vertex AI Pipelines** | ML pipeline orchestration | Azure ML Pipelines / Databricks Workflows | M | N/A -- use Azure native | Pipeline definitions require rewrite |
| 55 | **Vertex AI Endpoints** | Model serving (online prediction) | Azure ML Managed Endpoints / Databricks Model Serving | M | `csa_platform/ai_integration/model_serving/` | Managed endpoint deployment pattern |
| 56 | **Vertex AI Search** | Enterprise search with RAG | Azure AI Search | M | `csa_platform/ai_integration/rag/` | AI Search provides enterprise RAG |
| 57 | **Vertex AI Agents** | LLM-powered agents | Azure AI Agents / Copilot Studio | L | N/A -- use Azure AI Foundry | Agent framework is evolving rapidly |
| 58 | **Gemini** | Google's LLM family | Azure OpenAI (GPT-4o, o3, o4-mini) | M | ADR-0007 `docs/adr/0007-azure-openai-over-self-hosted-llm.md` | Model capability parity; different API surface |
| 59 | **BigQuery ML** | Inline SQL ML training + prediction | Databricks MLflow + `ai_query()` | L | `csa_platform/ai_integration/model_serving/` | Loss of `CREATE MODEL` simplicity; gain of MLflow lifecycle |
| 60 | **AI Platform Notebooks** | Managed Jupyter notebooks | Databricks Notebooks / Azure ML Notebooks | S | `domains/shared/notebooks/` | Direct replacement with richer collaboration |

---

## 6. Data governance

| # | GCP service | Description | Azure equivalent | Complexity | CSA-in-a-Box evidence | Notes |
|---|---|---|---|---|---|---|
| 61 | **Data Catalog** | Metadata catalog and search | Microsoft Purview Unified Catalog | M | `csa_platform/csa_platform/governance/purview/purview_automation.py` | Purview is significantly richer (classifications, lineage, glossary) |
| 62 | **Cloud DLP** | Sensitive data detection and masking | Purview sensitivity labels + UC column masks | M | `csa_platform/csa_platform/governance/purview/classifications/` | Four classification taxonomies shipped (PII, PHI, Gov, Financial) |
| 63 | **Cloud IAM** | Identity and access management | Entra ID + Azure RBAC + Unity Catalog | M | `csa_platform/multi_synapse/rbac_templates/` | See security migration guide for detailed mapping |
| 64 | **Service accounts** | Non-human identity | Managed Identities (user-assigned) | S | Azure RBAC patterns in Bicep | Managed identities eliminate credential management |
| 65 | **Cloud KMS** | Key management service | Azure Key Vault | S | Azure Key Vault in Bicep modules | Direct analog with HSM-backed options |
| 66 | **VPC Service Controls** | Network-level data exfiltration protection | Private Endpoints + NSGs + service firewalls | M | Bicep networking modules | Different model but equivalent protection |
| 67 | **Cloud Audit Logs** | Admin Activity and Data Access logging | Azure Monitor + diagnostic settings | M | Audit logger (CSA-0016 implementation) | Tamper-evident chain provides stronger AU-family evidence |
| 68 | **Organization Policy Service** | Org-wide policy constraints | Azure Policy + Management Groups | M | Bicep policy modules | Azure Policy is more granular |

---

## 7. Monitoring and operations

| # | GCP service | Description | Azure equivalent | Complexity | CSA-in-a-Box evidence | Notes |
|---|---|---|---|---|---|---|
| 69 | **Cloud Monitoring** | Metrics collection and alerting | Azure Monitor + Metrics | S | N/A -- use Azure native | Broader alerting (email, PagerDuty, Slack, Teams) |
| 70 | **Cloud Logging** | Centralized log aggregation | Azure Log Analytics | S | N/A -- use Azure native | KQL query language; richer analytics |
| 71 | **Cloud Trace** | Distributed tracing | Application Insights | S | N/A -- use Azure native | Part of Azure Monitor; OpenTelemetry support |
| 72 | **Error Reporting** | Application error tracking | Application Insights | XS | N/A -- use Azure native | Included in Application Insights |
| 73 | **Security Command Center** | Cloud security posture management | Microsoft Defender for Cloud | M | N/A -- use Azure native | Defender covers multi-cloud including GCP |

---

## 8. DevOps and CI/CD

| # | GCP service | Description | Azure equivalent | Complexity | CSA-in-a-Box evidence | Notes |
|---|---|---|---|---|---|---|
| 74 | **Cloud Build** | CI/CD build service | GitHub Actions / Azure DevOps Pipelines | S | `.github/workflows/deploy.yml` | Standard CI/CD; broader ecosystem |
| 75 | **Cloud Deploy** | Continuous delivery to GKE/Cloud Run | GitHub Actions + Azure DevOps Release | S | `.github/workflows/` | Deployment pipeline patterns |
| 76 | **Artifact Registry** | Container/package registry | Azure Container Registry / GitHub Packages | XS | N/A -- use Azure native | Direct replacement |
| 77 | **Cloud Source Repositories** | Git hosting | GitHub / Azure Repos | XS | N/A -- use Azure native | GitHub is the standard |

---

## Migration complexity summary

| Domain | XS | S | M | L | XL | Total |
|---|---|---|---|---|---|---|
| Storage | 5 | 2 | 3 | 1 | 0 | 11 |
| Compute and warehouse | 2 | 4 | 13 | 3 | 0 | 22 |
| ETL and orchestration | 1 | 3 | 2 | 1 | 0 | 7 |
| Business intelligence | 1 | 3 | 1 | 1 | 0 | 6 |
| AI and ML | 0 | 1 | 5 | 2 | 0 | 8 |
| Data governance | 0 | 2 | 5 | 0 | 0 | 7 |
| Monitoring and operations | 1 | 3 | 1 | 0 | 0 | 5 |
| DevOps and CI/CD | 2 | 2 | 0 | 0 | 0 | 4 |
| **Total** | **12** | **20** | **30** | **8** | **0** | **70** |

---

## Known gaps

| Gap | Description | Mitigation |
|---|---|---|
| **BigQuery ML inline simplicity** | `CREATE MODEL` + `ML.PREDICT` in a SELECT is simpler than MLflow | Databricks AI Functions + `ai_query()` closes most gaps |
| **BigQuery Omni cross-cloud UX** | Unified query console across clouds | OneLake shortcuts + Lakehouse Federation covers reads; not fully unified |
| **LookML-as-code maturity** | LookML version control more mature than Power BI TMDL | Gap narrowing with Power BI Git integration + Tabular Editor |

---

**Last updated:** 2026-04-30
**Maintainers:** CSA-in-a-Box core team
**Related:** [Why Azure over GCP](why-azure-over-gcp.md) | [TCO Analysis](tco-analysis.md) | [Migration Playbook](../gcp-to-azure.md)
