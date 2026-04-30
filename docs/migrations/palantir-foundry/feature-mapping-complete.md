# Complete Feature Mapping: Palantir Foundry to Azure

**The definitive feature-by-feature reference for mapping every Palantir Foundry capability to its Microsoft Azure equivalent.**

**Audience:** Platform architects, migration leads, and technical evaluators
**Last updated:** 2026-04-30

---

## Summary

This reference maps **65 Palantir Foundry features** across 10 capability domains to their Azure equivalents. Each mapping includes migration complexity, the CSA-in-a-Box evidence path (where the pattern exists in the repository), and notes on gaps or limitations.

| Metric                     | Count |
| -------------------------- | ----- |
| Total features mapped      | 65    |
| Full parity (XS–M effort)  | 48    |
| Partial parity (L effort)  | 12    |
| Known gaps (XL or roadmap) | 5     |

### Migration complexity key

| Rating | Description                                        | Typical effort |
| ------ | -------------------------------------------------- | -------------- |
| XS     | Drop-in replacement or native Microsoft capability | < 1 day        |
| S      | Minor configuration or adaptation required         | 1–3 days       |
| M      | Moderate development; requires design decisions    | 1–3 weeks      |
| L      | Significant development; architectural changes     | 1–3 months     |
| XL     | Major initiative; phased delivery                  | 3+ months      |

---

## 1. Data layer

| #   | Foundry feature                  | Description                                                                 | Azure equivalent                                               | Complexity | CSA-in-a-Box evidence                     | Notes                                                                      |
| --- | -------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------- | ---------- | ----------------------------------------- | -------------------------------------------------------------------------- |
| 1   | **Datasets**                     | Versioned, transactional file storage for structured/unstructured data      | Delta Lake on ADLS Gen2 / OneLake                              | S          | `domains/shared/dbt/models/`              | Delta provides ACID transactions, versioning, and time travel              |
| 2   | **Multimodal Data Plane (MMDP)** | Open data architecture with Iceberg, virtual catalogs, multi-engine compute | OneLake + Fabric multi-engine (Spark, SQL, KQL, Python)        | M          | `csa_platform/unity_catalog_pattern/`     | OneLake is the unified storage layer; Fabric provides multi-engine compute |
| 3   | **Virtual Tables**               | Zero-copy access to external data without ingestion                         | OneLake shortcuts + Fabric mirroring + Synapse serverless      | S          | N/A — use Azure native                    | OneLake shortcuts provide zero-copy access to S3, ADLS, GCS                |
| 4   | **Data Connection app**          | Central management of all data source connections                           | Azure Data Factory (ADF) management hub                        | S          | `domains/shared/pipelines/adf/`           | ADF provides central linked service and integration runtime management     |
| 5   | **Magritte connectors**          | 200+ pre-built connectors (databases, APIs, cloud, SaaS)                    | ADF 100+ built-in connectors + Logic Apps 600+ connectors      | S          | `docs/ADF_SETUP.md`                       | Combined ADF + Logic Apps exceeds Foundry connector count                  |
| 6   | **Agent worker/proxy**           | On-premises data access via installed agent software                        | Self-hosted Integration Runtime (SHIR)                         | S          | `docs/SELF_HOSTED_IR.md`                  | SHIR provides same on-prem connectivity with Windows/Linux support         |
| 7   | **Batch syncs**                  | Scheduled full or incremental data pulls                                    | ADF Copy Activity with schedule triggers                       | S          | `domains/shared/pipelines/adf/`           | ADF supports full and incremental copy with watermark patterns             |
| 8   | **CDC syncs**                    | Change data capture from databases                                          | ADF CDC connector / Fabric mirroring / Debezium + Event Hubs   | M          | `docs/patterns/streaming-cdc.md`          | Fabric mirroring is the simplest path for supported sources                |
| 9   | **Streaming syncs**              | Real-time data ingestion                                                    | Event Hubs + Stream Analytics / Fabric Real-Time Intelligence  | M          | `docs/guides/event-hubs.md`               | Event Hubs handles millions of events/second                               |
| 10  | **Media syncs**                  | File, image, and document ingestion                                         | Azure Blob Storage + Azure AI Document Intelligence            | S          | N/A — use Azure native                    | AI Document Intelligence extracts structure from documents                 |
| 11  | **Listeners**                    | HTTPS, WebSocket, Email push-based ingestion                                | Event Grid + Azure Functions (HTTP trigger) + Logic Apps       | M          | `csa_platform/functions/eventProcessing/` | Event Grid is the native Azure event routing service                       |
| 12  | **REST API plugins**             | Custom connector framework for REST sources                                 | ADF REST connector + custom ADF activities                     | S          | N/A — use Azure native                    | ADF REST connector supports auth, pagination, and transformation           |
| 13  | **S3-compatible access**         | S3 API access to Foundry data (via Iceberg)                                 | ADLS Gen2 REST API + OneLake REST API + Azure Storage S3 proxy | S          | N/A — use Azure native                    | OneLake provides native REST and S3-compatible access                      |
| 14  | **JDBC access**                  | JDBC connectivity to Foundry data                                           | Fabric SQL endpoint / Azure SQL / Synapse serverless SQL       | XS         | N/A — use Azure native                    | Standard JDBC/ODBC drivers available for all Azure SQL services            |

---

## 2. Transform and compute

| #   | Foundry feature             | Description                                           | Azure equivalent                                            | Complexity | CSA-in-a-Box evidence                                     | Notes                                                                   |
| --- | --------------------------- | ----------------------------------------------------- | ----------------------------------------------------------- | ---------- | --------------------------------------------------------- | ----------------------------------------------------------------------- |
| 15  | **Pipeline Builder**        | Visual ETL designer with drag-and-drop transforms     | ADF visual pipeline designer / Fabric Data Factory          | M          | `domains/shared/pipelines/adf/`                           | ADF provides visual design; dbt handles transformation logic            |
| 16  | **Code Repositories**       | Web IDE with Git, branching, PRs, CI/CD               | GitHub + VS Code + GitHub Actions                           | S          | `.github/workflows/deploy.yml`                            | Standard Git workflow with richer ecosystem                             |
| 17  | **Python transforms**       | PySpark with @transform decorators                    | dbt Python models / Fabric notebooks / Databricks notebooks | M          | `domains/shared/dbt/models/`, `domains/shared/notebooks/` | Remove Foundry decorators; use standard PySpark                         |
| 18  | **SQL transforms**          | Declarative SQL transforms                            | dbt SQL models                                              | S          | `domains/shared/dbt/models/`                              | dbt is a direct replacement with better testing and documentation       |
| 19  | **Java transforms**         | Spark Java API transforms                             | Databricks Spark jobs (Java)                                | M          | N/A — use Databricks native                               | Standard Spark Java; less common in modern stacks                       |
| 20  | **Incremental computation** | Process only changed rows/files since last run        | dbt incremental models / ADF incremental copy               | S          | `domains/shared/dbt/models/`                              | dbt incremental materialization with merge strategy                     |
| 21  | **Streaming (Flink)**       | Low-latency Flink-based streaming                     | Spark Structured Streaming / Stream Analytics / Fabric RTI  | M          | `docs/patterns/streaming-cdc.md`                          | Multiple options depending on latency requirements                      |
| 22  | **Single-node engines**     | DataFusion, Polars, DuckDB for small datasets         | Fabric notebooks (Polars, DuckDB) / Azure Functions         | S          | N/A — use Azure native                                    | Same open-source engines available in Fabric notebooks                  |
| 23  | **Compute Modules**         | Containerized BYO compute                             | AKS / Azure Container Apps / Azure Container Instances      | M          | N/A — use Azure native                                    | Full container orchestration with more flexibility                      |
| 24  | **External Transforms**     | Pipeline connectivity to external systems             | ADF custom activities + Azure Functions                     | M          | `csa_platform/functions/`                                 | Azure Functions provide serverless external compute                     |
| 25  | **Data Expectations**       | Assertion-based data quality checks                   | dbt tests + Great Expectations + dbt contracts              | S          | `domains/finance/data-products/invoices/contract.yaml`    | dbt tests are more expressive; contracts enforce at build time          |
| 26  | **Health Checks**           | Monitoring views with alerts                          | Azure Monitor + dbt source freshness + Data Activator       | M          | N/A — use Azure native                                    | Azure Monitor provides richer alerting (email, PagerDuty, Slack, Teams) |
| 27  | **LLM pipeline transforms** | Classification, sentiment, entity extraction via LLMs | Azure OpenAI in ADF custom activities / Fabric notebooks    | M          | `csa_platform/ai_integration/enrichment/`                 | Azure OpenAI provides the same LLM capabilities via API                 |

---

## 3. Ontology and semantic layer

| #   | Foundry feature     | Description                                     | Azure equivalent                                              | Complexity | CSA-in-a-Box evidence                                                | Notes                                                             |
| --- | ------------------- | ----------------------------------------------- | ------------------------------------------------------------- | ---------- | -------------------------------------------------------------------- | ----------------------------------------------------------------- |
| 28  | **Object Types**    | Schema definitions for real-world entities      | Purview glossary terms + dbt models (gold layer)              | L          | `csa_platform/csa_platform/governance/purview/purview_automation.py` | Requires mapping each object type to glossary term + dbt model    |
| 29  | **Link Types**      | Relationship definitions with cardinality       | Foreign keys in dbt + Power BI model relationships            | M          | `domains/shared/dbt/models/`                                         | Standard relational modeling patterns                             |
| 30  | **Properties**      | Typed attributes with classifications           | Column definitions + Purview classifications                  | M          | `csa_platform/csa_platform/governance/purview/classifications/`      | Four classification taxonomies shipped (PII, PHI, Gov, Financial) |
| 31  | **Interfaces**      | Abstract type definitions enabling polymorphism | dbt abstract/base models + Purview classification hierarchies | L          | N/A — use dbt patterns                                               | Polymorphism modeled through dbt macros and base models           |
| 32  | **Materialization** | Datasets merging input data with user edits     | dbt incremental models + SCD Type 2 snapshots                 | M          | `domains/shared/dbt/models/`                                         | Standard dimensional modeling patterns                            |
| 33  | **Scenarios**       | What-if branching of the ontology               | Git branches + dbt environments + Fabric workspaces           | M          | N/A — use Git native                                                 | Git branching provides isolation; dbt targets switch environments |
| 34  | **Ontology SQL**    | Read-only parameterized queries over objects    | Fabric SQL endpoint / Azure SQL views / Power BI DAX          | S          | N/A — use Azure native                                               | Standard SQL views provide equivalent read-only access            |
| 35  | **Object Views**    | UI components for embedding ontology objects    | Power BI visuals + Power Apps components + PCF                | M          | `portal/react-webapp/src/pages/`                                     | Multiple embedding options depending on use case                  |

---

## 4. Functions and actions

| #   | Foundry feature             | Description                                           | Azure equivalent                                          | Complexity | CSA-in-a-Box evidence                     | Notes                                                                |
| --- | --------------------------- | ----------------------------------------------------- | --------------------------------------------------------- | ---------- | ----------------------------------------- | -------------------------------------------------------------------- |
| 36  | **TypeScript functions**    | Server-side TypeScript with Ontology access           | Azure Functions (Node.js) + Fabric user data functions    | M          | `csa_platform/functions/`                 | Remove Foundry decorators; use standard Azure SDK                    |
| 37  | **Python functions**        | Server-side Python with Ontology edits                | Azure Functions (Python) + Fabric notebooks               | M          | `csa_platform/functions/`                 | Remove Foundry decorators; use standard Azure SDK                    |
| 38  | **Function-backed columns** | Computed properties evaluated at runtime              | Power BI DAX measures / Fabric computed columns           | M          | `csa_platform/semantic_model/`            | DAX measures provide same runtime computation                        |
| 39  | **Function-backed actions** | Ontology-editing functions for action logic           | Event-driven Azure Functions + Power Automate             | M          | `csa_platform/data_activator/functions/`  | Event Grid triggers Azure Functions for complex logic                |
| 40  | **Actions**                 | State-changing operations with rules and side effects | Data Activator rules + Event Grid + Power Automate        | L          | `csa_platform/data_activator/rules/`      | Data Activator handles rules; Event Grid fans out to compute         |
| 41  | **External Functions**      | Call external REST APIs from Foundry                  | Azure API Management + Azure Functions (HTTP trigger)     | S          | N/A — use Azure native                    | APIM provides governance; Functions provide compute                  |
| 42  | **Webhooks**                | Receive inbound HTTP calls from external systems      | Event Grid + Azure Functions (HTTP trigger) + Logic Apps  | S          | `csa_platform/functions/eventProcessing/` | Event Grid is the native inbound event service                       |
| 43  | **Automate**                | Trigger-based automation (time, data, combined)       | Power Automate + Data Activator + Azure Functions (timer) | M          | `csa_platform/data_activator/`            | Power Automate for workflow; Data Activator for data-driven triggers |

---

## 5. Applications

| #   | Foundry feature              | Description                                      | Azure equivalent                                           | Complexity | CSA-in-a-Box evidence            | Notes                                                                    |
| --- | ---------------------------- | ------------------------------------------------ | ---------------------------------------------------------- | ---------- | -------------------------------- | ------------------------------------------------------------------------ |
| 44  | **Workshop**                 | Low-code operational app builder (60+ widgets)   | Power Apps canvas apps + Power BI Embedded                 | L          | `portal/powerapps/`              | Widget-by-widget mapping required; see [App Migration](app-migration.md) |
| 45  | **Slate**                    | Custom HTML/CSS/JS application framework         | Power Pages + custom React (Azure Static Web Apps)         | M          | `portal/react-webapp/src/`       | Standard web development; more flexibility than Slate                    |
| 46  | **Object Explorer**          | Ontology search, browse, drill-down              | Purview Data Catalog + CSA-in-a-Box portal marketplace     | M          | `csa_platform/data_marketplace/` | Purview provides catalog; portal provides data product browse            |
| 47  | **Contour**                  | Point-and-click dataset analysis tool            | Power BI reports with Direct Lake semantic models          | M          | `csa_platform/semantic_model/`   | Power BI is the industry standard; Copilot adds NL capability            |
| 48  | **Quiver**                   | Ontology-aware object analysis with charts       | Power BI + Fabric Copilot + Fabric Data Agent              | M          | `csa_platform/semantic_model/`   | Power BI + Copilot provides NL querying over semantic models             |
| 49  | **Insight**                  | Point-and-click analysis for modeled data        | Power BI with relationships + Fabric SQL endpoint          | M          | N/A — use Azure native           | Power BI relationships enable same drill-through patterns                |
| 50  | **Fusion**                   | Spreadsheet with dataset writeback               | Excel + Analyze in Excel (Power BI live connection)        | XS         | N/A — native Microsoft           | Zero new work — native Microsoft capability                              |
| 51  | **Notepad**                  | Collaborative rich text with embedded charts     | Microsoft Loop + OneNote with embedded Power BI visuals    | S          | N/A — native Microsoft           | Loop is the modern equivalent with real-time collaboration               |
| 52  | **Code Workbook/Workspaces** | Notebooks (JupyterLab, RStudio)                  | Fabric notebooks + Databricks notebooks                    | S          | `domains/shared/notebooks/`      | Standard Jupyter/VS Code notebooks with richer ecosystem                 |
| 53  | **Vertex**                   | System graphs, process visualization, simulation | Azure Digital Twins + Power BI custom visuals              | L          | N/A — use Azure native           | ADT for complex system-of-systems; Power BI for simpler cases            |
| 54  | **Pilot**                    | AI app generator from natural language           | Copilot Studio + Power Apps AI Builder + GitHub Copilot    | M          | N/A — use Azure native           | Multiple AI-assisted app building tools available                        |
| 55  | **Marketplace**              | Product discovery, installation, management      | Power Platform Environment + AppSource + managed solutions | M          | N/A — use Azure native           | AppSource provides similar discovery and distribution                    |

---

## 6. AI and AIP

| #   | Foundry feature                  | Description                                    | Azure equivalent                                      | Complexity | CSA-in-a-Box evidence                        | Notes                                                            |
| --- | -------------------------------- | ---------------------------------------------- | ----------------------------------------------------- | ---------- | -------------------------------------------- | ---------------------------------------------------------------- |
| 56  | **AIP (Language Model Service)** | Multi-provider LLM access with governance      | Azure OpenAI Service + Azure AI Foundry model catalog | M          | `csa_platform/ai_integration/`               | Azure OpenAI provides GPT-4o, GPT-4.1, o3, o4-mini + open models |
| 57  | **AIP Chatbot Studio**           | Agent builder with retrieval context and tools | Copilot Studio + Microsoft 365 Agents SDK             | L          | Gap — see CSA-0008                           | Copilot Studio provides agent building; CSA Copilot on roadmap   |
| 58  | **AIP Logic**                    | No-code visual LLM function builder            | Power Automate + Azure Functions + Semantic Kernel    | M          | `csa_platform/ai_integration/`               | Semantic Kernel provides flexible agent orchestration            |
| 59  | **AIP Assist**                   | In-platform AI assistant                       | Microsoft 365 Copilot + GitHub Copilot                | XS         | N/A — native Microsoft                       | Available across all Microsoft apps; no migration needed         |
| 60  | **AIP Evals**                    | LLM evaluation, benchmarking, test generation  | Azure AI Studio evaluations + Prompt Flow eval        | M          | N/A — use Azure native                       | Prompt Flow provides evaluation pipelines with custom metrics    |
| 61  | **BYOM**                         | Bring your own model (registered models)       | Azure ML model registry + AI Foundry model catalog    | S          | `csa_platform/ai_integration/model_serving/` | Standard MLflow-compatible model registry                        |
| 62  | **Model lifecycle**              | Training, deployment, serving, monitoring      | Azure ML pipelines + MLflow on Databricks             | M          | `csa_platform/ai_integration/model_serving/` | Full MLOps lifecycle with experiment tracking                    |

---

## 7. Developer tools

| #   | Foundry feature         | Description                                | Azure equivalent                                          | Complexity | CSA-in-a-Box evidence                 | Notes                                                       |
| --- | ----------------------- | ------------------------------------------ | --------------------------------------------------------- | ---------- | ------------------------------------- | ----------------------------------------------------------- |
| 63  | **OSDK**                | Auto-generated TypeScript/Python/Java SDKs | Microsoft Graph API + Fabric REST APIs + Data API Builder | M          | `docs/tutorials/11-data-api-builder/` | Data API Builder auto-generates REST/GraphQL from databases |
| 64  | **Developer Console**   | SDK generation, OAuth, app sharing         | Azure Portal + Entra ID app registrations                 | S          | N/A — use Azure native                | Standard Azure identity and app management                  |
| 65  | **REST APIs**           | Programmatic access to platform resources  | Azure REST APIs + Fabric REST APIs + Power BI REST APIs   | S          | N/A — use Azure native                | Comprehensive public REST APIs with OpenAPI specs           |
| 66  | **VS Code Integration** | Palantir VS Code extension for local dev   | VS Code + Azure extensions + GitHub Copilot               | S          | N/A — use VS Code native              | Richer extension ecosystem with AI assistance               |
| 67  | **Continue**            | AI coding assistant in Code Repositories   | GitHub Copilot + GitHub Copilot Workspace                 | XS         | N/A — native GitHub                   | Industry-leading AI coding assistant                        |
| 68  | **Palantir MCP**        | Model Context Protocol for builder access  | GitHub Copilot + Azure DevOps extensions                  | M          | N/A — emerging capability             | MCP adoption growing across Azure and Fabric                |
| 69  | **Ontology MCP**        | MCP for consumer access to ontology data   | Fabric MCP server + custom MCP implementations            | M          | N/A — emerging capability             | Fabric MCP announced; see Agentic Fabric blog               |
| 70  | **Global Branching**    | Coordinated branching across resources     | Git feature branches + GitHub Environments + PR workflows | M          | `.github/workflows/`                  | Standard Git workflow with environment-based deployment     |

---

## 8. DevOps and deployment

| #   | Foundry feature            | Description                                 | Azure equivalent                                         | Complexity | CSA-in-a-Box evidence                 | Notes                                                    |
| --- | -------------------------- | ------------------------------------------- | -------------------------------------------------------- | ---------- | ------------------------------------- | -------------------------------------------------------- |
| 71  | **Apollo**                 | Continuous delivery, zero-downtime upgrades | Azure DevOps + GitHub Actions + Bicep IaC                | M          | `deploy/bicep/`, `.github/workflows/` | Standard CI/CD with deployment slots for zero-downtime   |
| 72  | **Product packaging**      | Bundle resources into installable products  | Bicep modules + Helm charts + Azure Artifacts            | M          | `deploy/bicep/`                       | Bicep modules provide composable infrastructure packages |
| 73  | **Upgrade Assistant**      | Platform upgrade management                 | Azure Advisor + Azure Resource Graph + Dependabot        | S          | N/A — use Azure native                | Azure Advisor provides proactive recommendations         |
| 74  | **Environment management** | Dev, staging, production environments       | Azure subscriptions + resource groups + deployment slots | S          | `deploy/bicep/`                       | Standard Azure environment isolation patterns            |

---

## 9. Security and governance

| #   | Foundry feature               | Description                                     | Azure equivalent                                                | Complexity | CSA-in-a-Box evidence                                                | Notes                                               |
| --- | ----------------------------- | ----------------------------------------------- | --------------------------------------------------------------- | ---------- | -------------------------------------------------------------------- | --------------------------------------------------- |
| 75  | **Projects**                  | Primary security boundary                       | Azure resource groups + Purview collections + Fabric workspaces | S          | `deploy/bicep/`                                                      | Standard Azure RBAC boundaries                      |
| 76  | **Organizations**             | User silos for multi-tenant separation          | Entra ID tenants / management groups                            | S          | N/A — use Azure native                                               | Standard Azure multi-tenant patterns                |
| 77  | **Markings**                  | Mandatory access controls (PII, PHI)            | Purview classifications + Microsoft Information Protection      | M          | `csa_platform/csa_platform/governance/purview/classifications/`      | Four classification taxonomies shipped              |
| 78  | **Encryption**                | In-transit (TLS) and at-rest (AES-256)          | Azure encryption (platform-managed or CMK) + TLS 1.3            | XS         | N/A — Azure default                                                  | Encryption is default on all Azure services         |
| 79  | **Audit logging**             | Comprehensive audit trail                       | Azure Monitor + Log Analytics + tamper-evident audit (CSA-0016) | M          | Audit logger module (CSA-0016)                                       | CSA-in-a-Box adds tamper-evident hash-chained audit |
| 80  | **Data lineage**              | End-to-end lineage tracking                     | Purview lineage + dbt DAG + ADF lineage                         | M          | `csa_platform/csa_platform/governance/purview/purview_automation.py` | Auto-capture from ADF, Fabric, and dbt              |
| 81  | **Sensitive data scanning**   | Automated PII/PHI detection                     | Purview automated scanning + sensitivity label auto-labeling    | S          | `csa_platform/csa_platform/governance/purview/classifications/`      | Purview provides same automated scanning capability |
| 82  | **Retention policies**        | Configurable data retention                     | Azure Storage lifecycle management + Purview retention          | S          | N/A — use Azure native                                               | Standard storage lifecycle policies                 |
| 83  | **Row/column security**       | Fine-grained data access                        | Fabric RLS + Power BI RLS + dynamic data masking                | M          | N/A — use Azure native                                               | RLS in Power BI; column masking in Fabric/SQL       |
| 84  | **SSO/SAML**                  | Identity federation                             | Entra ID (SAML, OIDC, WS-Fed)                                   | XS         | N/A — use Azure native                                               | Standard federation; likely already in place        |
| 85  | **Checkpoint justifications** | Require justification for sensitive data access | Entra Privileged Identity Management (PIM) + access reviews     | M          | N/A — use Azure native                                               | PIM provides just-in-time access with justification |

---

## 10. Monitoring and observability

| #   | Foundry feature      | Description                                    | Azure equivalent                                                    | Complexity | CSA-in-a-Box evidence                 | Notes                                             |
| --- | -------------------- | ---------------------------------------------- | ------------------------------------------------------------------- | ---------- | ------------------------------------- | ------------------------------------------------- |
| 86  | **Data Health**      | Monitoring app for resource health/freshness   | Azure Monitor + dbt source freshness + Data Activator               | M          | N/A — use Azure native                | Richer alerting and dashboard capabilities        |
| 87  | **Metrics**          | Near-real-time metrics for functions/actions   | Azure Monitor metrics + Application Insights                        | S          | N/A — use Azure native                | Standard APM with distributed tracing             |
| 88  | **Workflow Lineage** | Execution history and filtering                | ADF Monitor + Azure Monitor activity logs                           | S          | N/A — use Azure native                | ADF provides visual pipeline monitoring           |
| 89  | **Trace views**      | End-to-end tracing of functions/LLM calls      | Application Insights distributed tracing + OpenTelemetry            | M          | `docs/patterns/observability-otel.md` | OpenTelemetry standard with Azure Monitor backend |
| 90  | **Log export**       | Export logs for custom dashboards              | Azure Monitor diagnostic settings + Log Analytics export            | S          | N/A — use Azure native                | Export to storage, Event Hubs, or partner tools   |
| 91  | **Alerts**           | Email, PagerDuty, Slack, Foundry notifications | Azure Monitor alerts (email, SMS, Teams, PagerDuty, Slack, webhook) | S          | N/A — use Azure native                | Broader notification channel support              |

---

## 11. Interoperability

| #   | Foundry feature        | Description                                   | Azure equivalent                                     | Complexity | CSA-in-a-Box evidence          | Notes                                                 |
| --- | ---------------------- | --------------------------------------------- | ---------------------------------------------------- | ---------- | ------------------------------ | ----------------------------------------------------- |
| 92  | **Power BI connector** | Connect Power BI to Foundry data              | Direct Lake / DirectQuery / Import (native)          | XS         | `csa_platform/semantic_model/` | Power BI connects natively to Azure data sources      |
| 93  | **Tableau connector**  | Connect Tableau to Foundry data               | Tableau connector to Azure SQL / Fabric SQL endpoint | XS         | N/A — use Azure native         | Standard JDBC/ODBC connection                         |
| 94  | **Jupyter/RStudio**    | Notebook integration                          | Fabric notebooks / Databricks notebooks (native)     | XS         | `domains/shared/notebooks/`    | Native notebook support in both Fabric and Databricks |
| 95  | **Consumer mode**      | External-facing apps with limited permissions | Power Pages + Azure AD B2C                           | M          | N/A — use Azure native         | Power Pages is purpose-built for external-facing apps |

---

## Gap summary

| Gap                      | Foundry feature                      | Status             | Resolution                                                 |
| ------------------------ | ------------------------------------ | ------------------ | ---------------------------------------------------------- |
| **CSA Copilot**          | AIP Agents / Quiver deeper NL        | CSA-0008 (roadmap) | Copilot Studio provides partial coverage today             |
| **Object Explorer UX**   | Pixel-perfect ontology drill UX      | CSA-0129 (partial) | Purview Data Catalog + portal marketplace                  |
| **IL6 coverage**         | Classified SCI workloads             | Out of scope       | Recommend Foundry or bespoke Azure Top-Secret tenant       |
| **Vertex full fidelity** | Complex system-of-systems simulation | N/A                | Azure Digital Twins for complex cases; Power BI for simple |
| **MCP ecosystem**        | Palantir MCP / Ontology MCP maturity | Emerging           | Fabric MCP announced; ecosystem maturing rapidly           |

---

## Related resources

- [Migration Playbook](../palantir-foundry.md) — Phased project plan and worked example
- [Ontology Migration](ontology-migration.md) — Deep dive on migrating the Ontology
- [AI Migration](ai-migration.md) — Deep dive on migrating AIP
- [App Migration](app-migration.md) — Widget-by-widget Workshop mapping
- [Benchmarks](benchmarks.md) — Performance comparisons
- [TCO Analysis](tco-analysis.md) — Cost comparisons

---

**Last updated:** 2026-04-30
**Maintainers:** CSA-in-a-Box core team
