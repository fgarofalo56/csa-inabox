# Complete Snowflake-to-Azure Feature Mapping

**Status:** Authored 2026-04-30
**Audience:** Data architects, platform engineers, migration leads
**Scope:** 50+ Snowflake features mapped to Azure equivalents with effort estimates and evidence

---

## How to read this document

Each feature is mapped with:

- **Snowflake feature** -- the capability as Snowflake names it
- **Azure equivalent** -- the csa-inabox / Azure service(s) that replace it
- **Mapping notes** -- what changes, what stays the same, what to watch out for
- **Effort** -- XS (hours), S (days), M (1-2 weeks), L (2-4 weeks), XL (4+ weeks)
- **Gov parity** -- whether the Azure equivalent is available in Azure Government
- **Evidence** -- repo paths in csa-inabox that implement or document the pattern

---

## 1. Compute and warehousing (8 features)

| #   | Snowflake feature                               | Azure equivalent                                           | Mapping notes                                                                                           | Effort | Gov parity |
| --- | ----------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------ | ---------- |
| 1   | Virtual warehouses (XS-6XL)                     | Databricks SQL Warehouses (2XS-4XL)                        | Size mapping in warehouse-migration.md; auto-stop replaces auto-suspend                                 | M      | GA         |
| 2   | Multi-cluster warehouses                        | Databricks SQL auto-scaling                                | Auto-scale clusters per warehouse; scaling is per-node rather than per-clone                            | M      | GA         |
| 3   | Resource monitors                               | Azure Cost Management budgets + Databricks budget alerts   | Budgets trigger alerts and optional actions; `scripts/deploy/teardown-platform.sh` as hard kill         | S      | GA         |
| 4   | Warehouse auto-suspend / auto-resume            | SQL Warehouse auto-stop (1 min classic, 10 min serverless) | Functionally equivalent; serverless has faster spin-up                                                  | XS     | GA         |
| 5   | Query acceleration service                      | Databricks Photon engine                                   | Photon accelerates scan-heavy queries automatically; no separate activation                             | XS     | GA         |
| 6   | Search Optimization Service                     | Delta Lake Z-ordering + liquid clustering                  | Z-ORDER on high-cardinality columns; liquid clustering (Databricks Runtime 13.3+) for auto-optimization | S      | GA         |
| 7   | Result caching                                  | Databricks SQL result cache + Delta cache                  | Automatic result caching at SQL Warehouse level; Delta cache for SSD-accelerated reads                  | XS     | GA         |
| 8   | Warehouse scheduling (min/max clusters by time) | Databricks SQL Warehouse scaling policies + ADF triggers   | Schedule warehouse size changes via ADF or Databricks API; less native than Snowflake scheduler         | S      | GA         |

**Evidence:** `csa_platform/unity_catalog_pattern/README.md`, `docs/adr/0002-databricks-over-oss-spark.md`

---

## 2. Storage and data formats (7 features)

| #   | Snowflake feature                 | Azure equivalent                                             | Mapping notes                                                                    | Effort | Gov parity |
| --- | --------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------- | ------ | ---------- |
| 9   | Micro-partitions (proprietary)    | Delta Lake on Parquet (open)                                 | Open format; no vendor lock-in; exit cost is weeks not years                     | M      | GA         |
| 10  | Time Travel                       | Delta Lake Time Travel (`VERSION AS OF` / `TIMESTAMP AS OF`) | Semantics equivalent; retention via `delta.deletedFileRetentionDuration`         | XS     | GA         |
| 11  | Zero-copy cloning                 | Delta SHALLOW CLONE / DEEP CLONE                             | SHALLOW CLONE is metadata-only (equivalent); DEEP CLONE copies data              | XS     | GA         |
| 12  | Fail-safe (7-day recovery)        | ADLS Gen2 soft delete + GRS replication                      | Soft delete provides recovery window; GRS for cross-region durability            | S      | GA         |
| 13  | External tables (on S3/GCS/Azure) | OneLake shortcuts + Lakehouse Federation                     | Shortcuts preserve remote as source of truth; Federation queries remote directly | S      | GA         |
| 14  | Iceberg tables                    | Delta Lake (preferred) or Databricks Iceberg support         | csa-inabox standardizes on Delta; ADR-0003 documents the decision                | XS     | GA         |
| 15  | Directory tables                  | Unity Catalog volumes                                        | Volumes provide file-level management; directory tables not needed               | S      | GA         |

**Evidence:** `docs/adr/0003-delta-lake-over-iceberg-and-parquet.md`, `csa_platform/unity_catalog_pattern/onelake_config.yaml`

---

## 3. Data ingestion (6 features)

| #   | Snowflake feature                                   | Azure equivalent                                  | Mapping notes                                                                     | Effort | Gov parity |
| --- | --------------------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------- | ------ | ---------- |
| 16  | Snowpipe (batch auto-ingest)                        | Databricks Autoloader                             | Autoloader monitors cloud storage for new files; incremental, exactly-once        | M      | GA         |
| 17  | Snowpipe Streaming                                  | Event Hubs + Databricks Structured Streaming      | Event Hubs for ingestion; Structured Streaming for processing; sub-second latency | M      | GA         |
| 18  | COPY INTO (bulk load)                               | COPY INTO (Databricks SQL) / ADF Copy Activity    | Nearly identical syntax on Databricks; ADF for orchestrated bulk loads            | S      | GA         |
| 19  | PUT/GET (file staging)                              | AZ CLI upload / ADF / Databricks DBFS             | Stage files to ADLS Gen2 or OneLake; no proprietary staging area needed           | S      | GA         |
| 20  | External stages (S3/GCS/Azure)                      | ADLS Gen2 containers + OneLake shortcuts          | Mount or shortcut external storage; no intermediate staging needed                | S      | GA         |
| 21  | Data loading transformations (COPY INTO ... SELECT) | Autoloader with schema hints + dbt staging models | Inline transformations move to dbt staging layer for better testability           | M      | GA         |

**Evidence:** `docs/adr/0005-event-hubs-over-kafka.md`, `examples/iot-streaming/`, `domains/shared/pipelines/adf/`

---

## 4. Data transformation and modeling (6 features)

| #   | Snowflake feature                              | Azure equivalent                                                | Mapping notes                                                                           | Effort | Gov parity |
| --- | ---------------------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------ | ---------- |
| 22  | Dynamic Tables                                 | dbt incremental models + Databricks DLT                         | Lag-based refresh becomes dbt incremental with merge strategy; heavy CDC uses DLT       | M      | GA         |
| 23  | Materialized views                             | Databricks materialized views (GA) + dbt table materializations | Direct equivalent in Databricks Runtime 13+; dbt `table` materialization as alternative | S      | GA         |
| 24  | Stored procedures (JavaScript/SQL)             | Databricks SQL stored procedures + notebooks                    | SQL procedures translate directly; JavaScript procedures rewrite to Python              | M      | GA         |
| 25  | User-defined functions (SQL/JavaScript/Python) | Databricks SQL UDFs + PySpark UDFs                              | SQL UDFs: near-identical syntax; JavaScript: rewrite; Python: Snowpark to PySpark       | M      | GA         |
| 26  | User-defined table functions (UDTFs)           | Databricks SQL UDTFs + PySpark UDTFs                            | Supported in Databricks Runtime 13+; syntax differs slightly                            | M      | GA         |
| 27  | External functions                             | Azure Functions + Databricks SQL external models                | HTTP endpoints callable from SQL; external models for AI/ML inference                   | M      | GA         |

**Evidence:** `domains/shared/dbt/dbt_project.yml`, `domains/finance/dbt/`, `domains/sales/dbt/`

---

## 5. Snowpark ecosystem (5 features)

| #   | Snowflake feature           | Azure equivalent                                | Mapping notes                                                       | Effort | Gov parity |
| --- | --------------------------- | ----------------------------------------------- | ------------------------------------------------------------------- | ------ | ---------- |
| 28  | Snowpark Python             | PySpark + pandas-on-Spark (Koalas)              | DataFrame API translates; Snowpark-specific functions need rewrite  | M      | GA         |
| 29  | Snowpark Java/Scala         | Spark Java/Scala API                            | Direct translation; Spark API is the original                       | M      | GA         |
| 30  | Snowpark ML                 | MLflow on Databricks                            | Model training, tracking, registry all in MLflow; richer ecosystem  | M      | GA         |
| 31  | Snowpark Container Services | Azure Container Apps + Databricks Model Serving | General compute: Container Apps; inference: Model Serving           | L      | GA         |
| 32  | Snowflake Notebooks         | Fabric Notebooks + Databricks Notebooks         | Richer notebook experience with better collaboration and versioning | S      | GA         |

**Evidence:** `csa_platform/ai_integration/model_serving/`, `domains/shared/notebooks/`

---

## 6. Cortex AI services (8 features)

| #   | Snowflake feature                 | Azure equivalent                          | Mapping notes                                                          | Effort | Gov parity |
| --- | --------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------- | ------ | ---------- |
| 33  | Cortex COMPLETE (text generation) | Azure OpenAI (GPT-4o, GPT-4.1)            | Better models; invoked via `ai_query()` or dbt macros                  | M      | GA in Gov  |
| 34  | Cortex SUMMARIZE                  | Azure OpenAI with summarization prompt    | Prompt-based; more flexible than Cortex's fixed function               | S      | GA in Gov  |
| 35  | Cortex TRANSLATE                  | Azure AI Translator / Azure OpenAI        | Dedicated translation service or GPT-4o for context-aware translation  | S      | GA in Gov  |
| 36  | Cortex EXTRACT_ANSWER             | Azure OpenAI with RAG pattern             | AI Search + OpenAI for extractive QA; richer than single-function call | M      | GA in Gov  |
| 37  | Cortex SENTIMENT                  | Azure AI Language / Azure OpenAI          | Dedicated sentiment API or prompt-based via GPT-4o                     | S      | GA in Gov  |
| 38  | Cortex Search                     | Azure AI Search (hybrid vector + keyword) | Full hybrid search with vector embeddings; richer relevance tuning     | M      | GA in Gov  |
| 39  | Cortex Analyst                    | Power BI Copilot                          | Natural-language analytics over semantic models                        | M      | GA in Gov  |
| 40  | Cortex Guard                      | Azure AI Content Safety                   | Content filtering, prompt shields, groundedness detection              | M      | GA in Gov  |

**Evidence:** `csa_platform/ai_integration/README.md`, `csa_platform/ai_integration/rag/pipeline.py`, `docs/adr/0007-azure-openai-over-self-hosted-llm.md`

---

## 7. Security and governance (9 features)

| #   | Snowflake feature                 | Azure equivalent                                          | Mapping notes                                                                         | Effort | Gov parity |
| --- | --------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------ | ---------- |
| 41  | Network policies (IP allowlists)  | Azure Private Endpoints + NSGs + Firewall                 | Stronger isolation via Private Endpoints; NSGs for fine-grained control               | M      | GA         |
| 42  | Dynamic data masking              | Purview sensitivity labels + Unity Catalog MASK functions | Column-level masking via UC; classification-driven via Purview                        | M      | GA         |
| 43  | Row access policies               | Unity Catalog row filters                                 | Rewrite policy body as UC row filter; map CURRENT_ROLE() to Entra groups              | M      | GA         |
| 44  | Object tagging (governance tags)  | Purview classifications + Unity Catalog tags              | Tags flow across catalog; Purview scans auto-classify PII/PHI                         | S      | GA         |
| 45  | Access history / query history    | Purview audit + Azure Monitor + tamper-evident audit      | Query audit to Log Analytics; tamper-evident chain (CSA-0016) exceeds Snowflake audit | M      | GA         |
| 46  | Account/Database/Schema hierarchy | Entra tenant / Workspace / UC Catalog / Schema            | 1:1 mapping; more layers but more granular control                                    | S      | GA         |
| 47  | RBAC (roles + grants)             | Entra ID groups + Unity Catalog grants                    | Roles become Entra groups; GRANT syntax nearly identical in UC                        | M      | GA         |
| 48  | Data classification               | Purview auto-classification (PII, PHI, CUI, financial)    | Automated scanning with 200+ built-in classifiers; custom classifiers supported       | M      | GA         |
| 49  | Key pair authentication           | Entra ID service principals + managed identities          | Stronger identity model; no key rotation burden with managed identities               | M      | GA         |

**Evidence:** `csa_platform/csa_platform/governance/purview/`, `csa_platform/unity_catalog_pattern/unity_catalog/`, `csa_platform/multi_synapse/rbac_templates/`

---

## 8. Data sharing and collaboration (5 features)

| #   | Snowflake feature                     | Azure equivalent                                       | Mapping notes                                                      | Effort | Gov parity |
| --- | ------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------ | ------ | ---------- |
| 50  | Secure Data Sharing (intra-Snowflake) | Delta Sharing (open protocol) + OneLake shortcuts      | More setup than Snowflake; open protocol works across platforms    | L      | GA         |
| 51  | Reader accounts                       | Delta Sharing recipients (no compute cost to provider) | Recipients bring their own compute; no provider credit consumption | M      | GA         |
| 52  | Data Marketplace                      | Fabric Data Marketplace + Purview data products        | Data product registry with contracts; marketplace discovery        | L      | GA         |
| 53  | Data Clean Rooms                      | Delta Sharing + Purview + Azure Confidential Computing | More stitching than Snowflake; purpose-built UX is a gap           | L      | Partial    |
| 54  | Listings (provider/consumer model)    | Purview data products + contract.yaml                  | Data product contracts with SLA, schema, classification metadata   | M      | GA         |

**Evidence:** `csa_platform/data_marketplace/`, `csa_platform/data_marketplace/api/`

---

## 9. Orchestration and scheduling (4 features)

| #   | Snowflake feature                      | Azure equivalent                              | Mapping notes                                                                 | Effort | Gov parity |
| --- | -------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------- | ------ | ---------- |
| 55  | Tasks (scheduled SQL)                  | ADF triggers + Databricks Jobs                | Schedule triggers for time-based; event triggers for data-arrival             | M      | GA         |
| 56  | Task DAGs (dependencies)               | dbt ref() DAG + ADF pipeline dependencies     | dbt handles model dependencies; ADF for cross-pipeline orchestration          | M      | GA         |
| 57  | Streams (CDC)                          | Delta change-data-feed (CDF) + Databricks DLT | Enable CDF on Delta tables; DLT for streaming CDC pipelines                   | M      | GA         |
| 58  | Alerts (condition-based notifications) | Azure Monitor alerts + Logic Apps             | Monitor metrics trigger alerts; Logic Apps for complex notification workflows | S      | GA         |

**Evidence:** `domains/shared/pipelines/adf/`, `docs/adr/0001-adf-dbt-over-airflow.md`

---

## 10. Developer tools and interfaces (5 features)

| #   | Snowflake feature              | Azure equivalent                      | Mapping notes                                                                 | Effort | Gov parity |
| --- | ------------------------------ | ------------------------------------- | ----------------------------------------------------------------------------- | ------ | ---------- |
| 59  | SnowSQL CLI                    | Databricks CLI + Azure CLI + dbt CLI  | Three CLIs replace one; each is purpose-built for its domain                  | S      | GA         |
| 60  | Snowsight (web UI)             | Databricks SQL Editor + Fabric portal | SQL editing, visualization, dashboards in browser                             | XS     | GA         |
| 61  | Snowflake Connector for Python | Databricks SDK for Python + ODBC/JDBC | `databricks-sdk` package; ODBC/JDBC for legacy tools                          | S      | GA         |
| 62  | Snowflake Connector for Spark  | Native (Databricks IS Spark)          | No connector needed; Spark is the compute engine                              | XS     | GA         |
| 63  | Snowflake REST API             | Databricks REST API + Azure REST APIs | Databricks API for workspace/warehouse/jobs; Azure APIs for platform services | S      | GA         |

---

## 11. Miscellaneous features (3 features)

| #   | Snowflake feature                        | Azure equivalent                        | Mapping notes                                                            | Effort | Gov parity |
| --- | ---------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------ | ------ | ---------- |
| 64  | Replication (cross-region / cross-cloud) | ADLS GRS + Databricks disaster recovery | GRS for storage; Databricks workspace DR for compute metadata            | M      | GA         |
| 65  | Data Exchange (private marketplace)      | Purview data products + Delta Sharing   | Private exchanges via Purview-managed data products with access controls | L      | GA         |
| 66  | Snowflake Horizon (governance suite)     | Purview + Unity Catalog + dbt contracts | Federated governance: each piece is best-in-class and swappable          | M      | GA         |

---

## Summary statistics

| Category                 | Features mapped | Avg effort | Gov parity                   |
| ------------------------ | --------------- | ---------- | ---------------------------- |
| Compute and warehousing  | 8               | S-M        | 100% GA                      |
| Storage and data formats | 7               | XS-M       | 100% GA                      |
| Data ingestion           | 6               | S-M        | 100% GA                      |
| Data transformation      | 6               | S-M        | 100% GA                      |
| Snowpark ecosystem       | 5               | S-L        | 100% GA                      |
| Cortex AI services       | 8               | S-M        | 100% GA in Gov               |
| Security and governance  | 9               | S-M        | 100% GA                      |
| Data sharing             | 5               | M-L        | 80% GA (Clean Rooms partial) |
| Orchestration            | 4               | S-M        | 100% GA                      |
| Developer tools          | 5               | XS-S       | 100% GA                      |
| Miscellaneous            | 3               | M-L        | 100% GA                      |
| **Total**                | **66**          |            | **98% GA in Gov**            |

### Gaps summary

Only one feature has incomplete Gov parity:

1. **Data Clean Rooms** -- Snowflake's purpose-built clean-room UX is more turnkey. Azure's stitch (Delta Sharing + Purview + Confidential Computing) works but requires more configuration. For most federal data-sharing scenarios, this is acceptable.

---

## Related documents

- [Warehouse Migration](warehouse-migration.md) -- deep dive on compute translation
- [Cortex Migration](cortex-migration.md) -- deep dive on AI feature migration
- [Security Migration](security-migration.md) -- deep dive on governance and access control
- [Master playbook](../snowflake.md) -- Section 2 for the original capability mapping

---

**Last updated:** 2026-04-30
**Maintainers:** CSA-in-a-Box core team
