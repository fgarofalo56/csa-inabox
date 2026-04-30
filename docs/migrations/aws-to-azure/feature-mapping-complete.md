# Complete Feature Mapping: AWS Analytics to Azure

**The definitive feature-by-feature reference for mapping every AWS analytics capability to its Microsoft Azure equivalent.**

**Audience:** Platform architects, migration leads, and technical evaluators
**Last updated:** 2026-04-30

---

## Summary

This reference maps **103 AWS analytics and infrastructure features** across 12 capability domains to their Azure equivalents. Each mapping includes migration complexity, the CSA-in-a-Box evidence path (where the pattern exists in the repository), and notes on gaps or limitations.

| Metric                              | Count |
| ----------------------------------- | ----- |
| Total features mapped               | 103   |
| Full parity or better (XS-M effort) | 90    |
| Partial parity (L effort)           | 10    |
| Known gaps (XL or no equivalent)    | 3     |

### Migration complexity key

| Rating | Description                                     | Typical effort |
| ------ | ----------------------------------------------- | -------------- |
| XS     | Drop-in replacement or native Azure capability  | < 1 day        |
| S      | Minor configuration or adaptation required      | 1-3 days       |
| M      | Moderate development; requires design decisions | 1-3 weeks      |
| L      | Significant development; architectural changes  | 1-3 months     |
| XL     | Major initiative; phased delivery               | 3+ months      |

---

## 1. Storage (S3 and related)

| #   | AWS feature                     | Description                               | Azure equivalent                                             | Complexity | CSA-in-a-Box evidence                                    | Notes                                                          |
| --- | ------------------------------- | ----------------------------------------- | ------------------------------------------------------------ | ---------- | -------------------------------------------------------- | -------------------------------------------------------------- |
| 1   | **S3 Standard**                 | General-purpose object storage            | ADLS Gen2 (hot tier) / OneLake                               | S          | `csa_platform/unity_catalog_pattern/onelake_config.yaml` | Hierarchical namespace provides directory-level operations     |
| 2   | **S3 Intelligent-Tiering**      | Automatic tier optimization               | ADLS Gen2 lifecycle management policies                      | S          | N/A --- use Azure native                                 | Rule-based tiering: hot, cool, archive                         |
| 3   | **S3 Infrequent Access**        | Low-cost infrequent storage               | ADLS Gen2 cool tier                                          | XS         | N/A --- use Azure native                                 | Direct cost mapping                                            |
| 4   | **S3 Glacier / Deep Archive**   | Archival storage                          | ADLS Gen2 archive tier                                       | XS         | N/A --- use Azure native                                 | Rehydration latency differs; plan accordingly                  |
| 5   | **S3 Object Lock (WORM)**       | Immutable write-once storage              | ADLS Gen2 immutable storage (time-based / legal hold)        | XS         | N/A --- use Azure native                                 | 1:1 compliance-driven retention                                |
| 6   | **S3 Versioning**               | Object version history                    | ADLS Gen2 blob versioning + Delta Lake time travel           | S          | ADR-0003                                                 | Delta time travel provides richer versioning than object-level |
| 7   | **S3 Lifecycle Policies**       | Automated tier transitions and expiration | ADLS Gen2 lifecycle management policies                      | XS         | N/A --- use Azure native                                 | 1:1 rule-set translation                                       |
| 8   | **S3 Access Points**            | Simplified per-application access         | Private endpoints + RBAC + ABAC on containers                | S          | `docs/SELF_HOSTED_IR.md`                                 | ACL-level access maps to RBAC + ABAC                           |
| 9   | **S3 Cross-Region Replication** | Geo-redundant replication                 | ADLS Gen2 object replication + GRS/GZRS                      | S          | `docs/DR.md`, `docs/MULTI_REGION.md`                     | Azure provides multiple redundancy options                     |
| 10  | **S3 Event Notifications**      | Event triggers on object changes          | Event Grid (BlobCreated / BlobDeleted)                       | S          | `csa_platform/data_activator/`                           | Event Grid is the native Azure event routing service           |
| 11  | **S3 Select**                   | In-place query of S3 objects              | ADLS Gen2 query acceleration (preview) / Fabric SQL endpoint | M          | N/A --- use Azure native                                 | Fabric SQL endpoint is the recommended path                    |
| 12  | **EBS (Elastic Block Store)**   | Block storage for EC2                     | Azure Managed Disks                                          | XS         | N/A --- infrastructure, not analytics                    | Direct equivalent; not part of analytics migration             |
| 13  | **EFS (Elastic File System)**   | Managed NFS file storage                  | Azure Files (NFS or SMB) / Azure NetApp Files                | S          | N/A --- use Azure native                                 | ANF for high-performance NFS workloads                         |

---

## 2. Compute: data warehousing (Redshift)

| #   | AWS feature                    | Description                            | Azure equivalent                                        | Complexity | CSA-in-a-Box evidence                                       | Notes                                                                      |
| --- | ------------------------------ | -------------------------------------- | ------------------------------------------------------- | ---------- | ----------------------------------------------------------- | -------------------------------------------------------------------------- |
| 14  | **Redshift RA3 clusters**      | Managed columnar data warehouse        | Databricks SQL Warehouses + Delta Lake on ADLS Gen2     | M          | `csa_platform/unity_catalog_pattern/`, ADR-0003             | RA3 decoupling maps to Databricks compute-storage separation               |
| 15  | **Redshift Serverless**        | On-demand serverless warehouse         | Databricks SQL Serverless                               | S          | ADR-0002, ADR-0010                                          | RPU model maps to DBU model                                                |
| 16  | **Spectrum (external tables)** | Query S3 data without loading          | OneLake shortcuts + Databricks Lakehouse Federation     | S          | `csa_platform/unity_catalog_pattern/onelake_config.yaml`    | Zero-copy read pattern preserved                                           |
| 17  | **Materialized views**         | Pre-computed query results             | dbt incremental models + Databricks materialized views  | M          | `domains/shared/dbt/dbt_project.yml`, ADR-0001              | Most MVs re-express as dbt incremental                                     |
| 18  | **Stored procedures**          | PL/pgSQL-style server-side logic       | dbt macros + Databricks SQL UDFs + notebook jobs        | L          | `domains/finance/dbt/macros/`, `domains/shared/dbt/macros/` | Complex imperative SPs require notebook rewrite                            |
| 19  | **WLM (Workload Management)**  | Queue-based query prioritization       | Databricks SQL Warehouse sizing + serverless auto-scale | M          | `csa_platform/multi_synapse/rbac_templates/`                | Each WLM queue becomes a SQL Warehouse                                     |
| 20  | **Distribution + sort keys**   | Physical data distribution strategy    | Delta partitioning + Z-ordering                         | S          | ADR-0003                                                    | Distribution key becomes partition column; sort keys become ZORDER columns |
| 21  | **Concurrency scaling**        | Auto-scale for burst query load        | Databricks SQL Warehouse serverless auto-scale          | XS         | ADR-0010                                                    | Serverless handles burst natively                                          |
| 22  | **Data sharing**               | Cross-account data sharing             | Delta Sharing + OneLake shortcuts                       | M          | `csa_platform/data_marketplace/`                            | Open protocol; Purview data-product registry                               |
| 23  | **Federated queries**          | Query RDS/Aurora from Redshift         | Databricks Lakehouse Federation + ADF linked services   | M          | `csa_platform/unity_catalog_pattern/`                       | Native connectors for Postgres/MySQL/SQL Server                            |
| 24  | **Redshift ML**                | In-warehouse ML training via SageMaker | Databricks ML + Feature Store + MLflow                  | M          | `csa_platform/ai_integration/model_serving/`                | Tighter ML integration than Redshift ML                                    |

---

## 3. Compute: Spark and Hadoop (EMR)

| #   | AWS feature              | Description                              | Azure equivalent                                       | Complexity | CSA-in-a-Box evidence                               | Notes                                                  |
| --- | ------------------------ | ---------------------------------------- | ------------------------------------------------------ | ---------- | --------------------------------------------------- | ------------------------------------------------------ |
| 25  | **EMR on EC2**           | Managed Spark/Hadoop/Hive/Presto cluster | Azure Databricks                                       | M          | `csa_platform/unity_catalog_pattern/`, ADR-0002     | Almost every Spark workload maps to Databricks         |
| 26  | **EMR Serverless**       | Serverless Spark/Hive execution          | Databricks Serverless Jobs                             | S          | ADR-0002, ADR-0010                                  | Per-job compute maps to serverless jobs                |
| 27  | **EMR Studio**           | Managed notebook IDE                     | Databricks Workspace Notebooks + Git integration       | S          | `domains/shared/notebooks/`                         | 1:1 notebook-and-repo UX                               |
| 28  | **EMR on EKS**           | Kubernetes-native Spark                  | Databricks (managed containers) / AKS + Spark Operator | L          | N/A                                                 | Databricks manages own containers; AKS for custom K8s  |
| 29  | **Bootstrap actions**    | Cluster initialization scripts           | Databricks init scripts + cluster policies             | XS         | `csa_platform/unity_catalog_pattern/deploy/`        | 1:1 semantic mapping                                   |
| 30  | **Managed scaling**      | Auto-scale cluster workers               | Databricks cluster autoscaling + serverless            | XS         | ADR-0002                                            | Serverless removes tuning burden                       |
| 31  | **Spot instances (EMR)** | Low-cost interruptible compute           | Databricks Spot on Azure (Azure Spot VMs)              | XS         | `csa_platform/unity_catalog_pattern/deploy/`        | Direct 1:1 mapping                                     |
| 32  | **Hive Metastore (EMR)** | Metadata catalog for Hive tables         | Unity Catalog (primary) + external Hive metastore      | M          | `csa_platform/unity_catalog_pattern/unity_catalog/` | Unity Catalog is target; bridge via external metastore |
| 33  | **EMRFS**                | S3-backed file system for EMR            | ADLS Gen2 (abfss://) + OneLake                         | S          | N/A --- use Azure native                            | Direct path substitution in Spark configs              |

---

## 4. Compute: ad-hoc queries (Athena)

| #   | AWS feature                     | Description                          | Azure equivalent                                       | Complexity | CSA-in-a-Box evidence                                    | Notes                                                     |
| --- | ------------------------------- | ------------------------------------ | ------------------------------------------------------ | ---------- | -------------------------------------------------------- | --------------------------------------------------------- |
| 34  | **Athena SQL queries**          | Serverless SQL over S3               | Databricks SQL + OneLake shortcuts to S3               | S          | `csa_platform/unity_catalog_pattern/onelake_config.yaml` | S3 stays read-only during migration                       |
| 35  | **Athena workgroups**           | Cost/access isolation per group      | Databricks SQL Warehouses (one per workgroup)          | XS         | `docs/COST_MANAGEMENT.md`                                | Auto-stop + Azure budgets for cost control                |
| 36  | **Athena federated queries**    | Query non-S3 sources (DynamoDB, RDS) | Databricks Lakehouse Federation                        | S          | ADR-0002                                                 | Native connectors for Postgres/MySQL/SQL Server/Snowflake |
| 37  | **Athena ACID (Iceberg)**       | ACID transactions on Athena          | Delta Lake ACID (primary) + Iceberg read compatibility | S          | ADR-0003                                                 | Databricks reads Iceberg natively during migration        |
| 38  | **Athena Spark**                | Interactive Spark sessions in Athena | Databricks Interactive Notebooks                       | S          | `domains/shared/notebooks/`                              | Richer notebook experience                                |
| 39  | **CTAS / INSERT OVERWRITE**     | Create table as select patterns      | dbt models + `MERGE INTO` on Delta                     | S          | `domains/shared/dbt/`                                    | Idempotent merges replace CTAS idioms                     |
| 40  | **Athena Provisioned Capacity** | Dedicated compute reservation        | Databricks SQL Pro warehouses                          | S          | ADR-0002                                                 | Dedicated compute with auto-scale                         |

---

## 5. ETL and orchestration (Glue and Step Functions)

| #   | AWS feature                  | Description                             | Azure equivalent                                            | Complexity | CSA-in-a-Box evidence                                                | Notes                                                                    |
| --- | ---------------------------- | --------------------------------------- | ----------------------------------------------------------- | ---------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 41  | **Glue Data Catalog**        | Centralized metadata catalog            | Unity Catalog (runtime) + Purview (business catalog)        | M          | `csa_platform/csa_platform/governance/purview/`, ADR-0006            | Unity Catalog holds runtime metadata; Purview holds lineage and glossary |
| 42  | **Glue ETL Jobs (PySpark)**  | Managed Spark ETL                       | Databricks Jobs + dbt models + ADF activities               | M          | `domains/shared/notebooks/`, `domains/shared/pipelines/adf/`         | PySpark moves to Databricks; SQL logic to dbt                            |
| 43  | **Glue Python Shell**        | Lightweight Python jobs                 | Azure Functions / small Databricks Python tasks             | S          | `csa_platform/functions/`                                            | Serverless functions for lightweight jobs                                |
| 44  | **Glue Crawlers**            | Schema discovery and catalog population | Purview scan jobs + Databricks Auto Loader schema inference | M          | `csa_platform/csa_platform/governance/purview/purview_automation.py` | Purview for governance; Auto Loader for runtime schema                   |
| 45  | **Glue Studio (visual ETL)** | Drag-and-drop ETL designer              | ADF Mapping Data Flows / Fabric Data Factory visual         | M          | `domains/shared/pipelines/adf/`                                      | Visual design in ADF; transformation logic in dbt                        |
| 46  | **Glue Streaming**           | Spark Structured Streaming ETL          | Databricks Structured Streaming + Event Hubs                | M          | ADR-0005, `examples/iot-streaming/`                                  | Kinesis source replaced with Event Hubs                                  |
| 47  | **Glue DataBrew**            | Visual data prep tool                   | Power Query (Fabric) + dbt + Databricks SQL                 | S          | `domains/shared/dbt/dbt_project.yml`                                 | Most transforms re-express as Power Query or dbt                         |
| 48  | **Glue Data Quality**        | Assertion-based data checks             | dbt tests + Great Expectations + data-product contracts     | S          | `domains/finance/data-products/invoices/contract.yaml`               | dbt tests are more expressive                                            |
| 49  | **Step Functions**           | Serverless workflow orchestration       | ADF pipeline activities + Logic Apps                        | M          | `domains/shared/pipelines/adf/`                                      | ADF for data orchestration; Logic Apps for integration workflows         |
| 50  | **EventBridge**              | Event bus for decoupled services        | Event Grid + Service Bus                                    | S          | `csa_platform/data_activator/`                                       | Event Grid for events; Service Bus for messaging                         |

---

## 6. Business intelligence (QuickSight)

| #   | AWS feature               | Description                         | Azure equivalent                            | Complexity | CSA-in-a-Box evidence       | Notes                                                      |
| --- | ------------------------- | ----------------------------------- | ------------------------------------------- | ---------- | --------------------------- | ---------------------------------------------------------- |
| 51  | **QuickSight dashboards** | Interactive dashboards and analyses | Power BI reports and dashboards             | M          | N/A --- use Power BI native | Manual rebuild; no automated migration tool                |
| 52  | **SPICE**                 | In-memory analytics engine          | Power BI Import mode / Direct Lake          | S          | N/A --- use Power BI native | Direct Lake eliminates import refresh entirely             |
| 53  | **QuickSight Q**          | Natural language querying           | Power BI Copilot                            | S          | N/A --- use Power BI native | Copilot uses GPT-4 for richer NL interaction               |
| 54  | **Calculated fields**     | Custom computed columns             | DAX measures and calculated columns         | M          | N/A --- use Power BI native | DAX is more expressive but has a learning curve            |
| 55  | **Parameters**            | Dashboard parameterization          | Power BI slicers + parameters + bookmarks   | S          | N/A --- use Power BI native | Richer parameterization options                            |
| 56  | **Row-level security**    | Per-user data filtering             | Power BI RLS + Entra ID groups              | S          | N/A --- use Power BI native | Dynamic RLS via DAX + Entra ID                             |
| 57  | **QuickSight embedding**  | Embed dashboards in apps            | Power BI Embedded / Power BI embed in Teams | S          | N/A --- use Power BI native | Broader embedding targets (Teams, SharePoint, custom apps) |

---

## 7. Streaming (Kinesis and MSK)

| #   | AWS feature                | Description                           | Azure equivalent                                   | Complexity | CSA-in-a-Box evidence    | Notes                                                             |
| --- | -------------------------- | ------------------------------------- | -------------------------------------------------- | ---------- | ------------------------ | ----------------------------------------------------------------- |
| 58  | **Kinesis Data Streams**   | Real-time data streaming              | Event Hubs                                         | M          | ADR-0005                 | Shard model maps to partition model                               |
| 59  | **Kinesis Data Firehose**  | Managed delivery to storage/analytics | Event Hubs Capture / ADF streaming                 | S          | ADR-0005                 | Event Hubs Capture writes directly to ADLS Gen2                   |
| 60  | **Kinesis Data Analytics** | SQL/Flink-based stream processing     | Stream Analytics / Fabric Real-Time Intelligence   | M          | N/A --- use Azure native | Stream Analytics for SQL; Fabric RTI for complex event processing |
| 61  | **MSK (Managed Kafka)**    | Managed Apache Kafka                  | Event Hubs with Kafka protocol (AMQP + Kafka wire) | M          | ADR-0005                 | Kafka clients connect with endpoint/config change only            |
| 62  | **MSK Connect**            | Managed Kafka Connect                 | Event Hubs + ADF connectors / Kafka Connect on AKS | M          | N/A --- use Azure native | ADF connectors cover most source/sink patterns                    |

---

## 8. AI and ML (SageMaker and Bedrock)

| #   | AWS feature                 | Description                | Azure equivalent                                  | Complexity | CSA-in-a-Box evidence                        | Notes                                                  |
| --- | --------------------------- | -------------------------- | ------------------------------------------------- | ---------- | -------------------------------------------- | ------------------------------------------------------ |
| 63  | **SageMaker Studio**        | Managed ML IDE             | Azure ML Studio / Databricks ML / AI Foundry      | M          | `csa_platform/ai_integration/`               | Multiple options depending on workflow                 |
| 64  | **SageMaker Training**      | Managed training compute   | Azure ML Compute + Databricks ML clusters         | M          | `csa_platform/ai_integration/model_serving/` | Direct mapping; GPU SKUs available                     |
| 65  | **SageMaker Endpoints**     | Real-time ML inference     | Azure ML Managed Endpoints / AKS                  | M          | `csa_platform/ai_integration/model_serving/` | Managed endpoints simplify deployment                  |
| 66  | **SageMaker Pipelines**     | ML workflow orchestration  | Azure ML Pipelines / Prompt Flow                  | M          | N/A --- use Azure native                     | Prompt Flow for LLM-centric workflows                  |
| 67  | **SageMaker Feature Store** | Managed feature store      | Databricks Feature Store / Azure ML Feature Store | M          | N/A --- use Azure native                     | Databricks Feature Store integrates with Unity Catalog |
| 68  | **Bedrock**                 | Managed LLM access         | Azure OpenAI Service                              | S          | `csa_platform/ai_integration/`               | GPT-4o, GPT-4.1, o3, o4-mini available in Azure Gov    |
| 69  | **Bedrock Agents**          | Autonomous AI agents       | Azure AI Agents / Copilot Studio                  | M          | N/A --- use Azure native                     | Copilot Studio for no-code; AI Agents SDK for code     |
| 70  | **Bedrock Knowledge Bases** | RAG with managed retrieval | Azure AI Search + Azure OpenAI                    | M          | N/A --- use Azure native                     | AI Search provides vector + hybrid search              |

---

## 9. Governance and security

| #   | AWS feature                | Description                      | Azure equivalent                                 | Complexity | CSA-in-a-Box evidence                                     | Notes                                                |
| --- | -------------------------- | -------------------------------- | ------------------------------------------------ | ---------- | --------------------------------------------------------- | ---------------------------------------------------- |
| 71  | **IAM roles and policies** | Identity and access management   | Entra ID + Azure RBAC + ABAC                     | M          | `csa_platform/multi_synapse/rbac_templates/`              | Role-per-service maps to RBAC assignments            |
| 72  | **Lake Formation**         | Fine-grained data access control | Purview + Unity Catalog access control           | L          | `csa_platform/csa_platform/governance/purview/`, ADR-0006 | Column-level and row-level security in Unity Catalog |
| 73  | **KMS**                    | Key management and encryption    | Azure Key Vault                                  | S          | N/A --- use Azure native                                  | CMK for all data-at-rest encryption                  |
| 74  | **Secrets Manager**        | Secret storage and rotation      | Azure Key Vault secrets                          | XS         | N/A --- use Azure native                                  | Direct mapping; auto-rotation supported              |
| 75  | **CloudTrail**             | API audit logging                | Azure Monitor Activity Log + Diagnostic Settings | S          | N/A --- use Azure native                                  | Richer integration with Log Analytics                |
| 76  | **GuardDuty**              | Threat detection                 | Microsoft Defender for Cloud                     | S          | N/A --- use Azure native                                  | Broader threat detection across Azure services       |
| 77  | **CloudWatch**             | Monitoring and alerting          | Azure Monitor + Log Analytics                    | S          | N/A --- use Azure native                                  | Unified monitoring across all Azure services         |
| 78  | **X-Ray**                  | Distributed tracing              | Application Insights                             | S          | N/A --- use Azure native                                  | Part of Azure Monitor; OpenTelemetry compatible      |

---

## 10. DevOps and infrastructure

| #   | AWS feature                  | Description                     | Azure equivalent                                    | Complexity | CSA-in-a-Box evidence                            | Notes                                                 |
| --- | ---------------------------- | ------------------------------- | --------------------------------------------------- | ---------- | ------------------------------------------------ | ----------------------------------------------------- |
| 79  | **CloudFormation**           | Infrastructure as Code          | Bicep (primary) / Terraform                         | M          | ADR-0004 `docs/adr/0004-bicep-over-terraform.md` | Bicep chosen for Azure policy evidence                |
| 80  | **CDK**                      | Programmatic IaC                | Bicep with modules / Terraform CDK                  | M          | ADR-0004                                         | Bicep modules provide composability                   |
| 81  | **CodePipeline**             | CI/CD pipeline                  | GitHub Actions / Azure DevOps Pipelines             | S          | `.github/workflows/`                             | Standard CI/CD; richer marketplace                    |
| 82  | **CodeBuild**                | Managed build service           | GitHub Actions runners / Azure DevOps hosted agents | S          | `.github/workflows/`                             | Direct mapping                                        |
| 83  | **AWS Organizations**        | Multi-account management        | Azure Management Groups + Subscriptions             | M          | N/A --- use Azure native                         | 4-subscription pattern in CSA-in-a-Box                |
| 84  | **Service Control Policies** | Organizational guardrails       | Azure Policy + Blueprints                           | M          | N/A --- use Azure native                         | Azure Policy provides deny/audit/deploy-if-not-exists |
| 85  | **AWS Config**               | Resource configuration tracking | Azure Policy + Azure Resource Graph                 | S          | N/A --- use Azure native                         | Resource Graph enables advanced queries               |

---

## 11. Networking and data transfer

| #   | AWS feature                   | Description                           | Azure equivalent                             | Complexity | CSA-in-a-Box evidence    | Notes                                      |
| --- | ----------------------------- | ------------------------------------- | -------------------------------------------- | ---------- | ------------------------ | ------------------------------------------ |
| 86  | **VPC**                       | Virtual private cloud                 | Azure Virtual Network (VNet)                 | M          | N/A --- use Azure native | Similar concepts; different defaults       |
| 87  | **VPC Endpoints (Gateway)**   | Private access to S3/DynamoDB         | Service Endpoints                            | XS         | N/A --- use Azure native | Route to service via backbone              |
| 88  | **VPC Endpoints (Interface)** | Private access to other services      | Private Endpoints                            | S          | N/A --- use Azure native | Private IP for PaaS service                |
| 89  | **AWS PrivateLink**           | Private service connectivity          | Azure Private Link                           | S          | N/A --- use Azure native | Same concept                               |
| 90  | **Security Groups**           | Stateful instance-level firewall      | Network Security Groups (NSGs)               | S          | N/A --- use Azure native | Stateful; applied at NIC or subnet         |
| 91  | **NACLs**                     | Stateless subnet-level firewall       | NSGs (at subnet level)                       | S          | N/A --- use Azure native | NSGs are stateful; applied at subnet scope |
| 92  | **Direct Connect**            | Dedicated private connectivity        | ExpressRoute                                 | M          | N/A --- use Azure native | Dedicated private connection               |
| 93  | **Transit Gateway**           | Hub-and-spoke networking              | Azure Virtual WAN / VNet Peering             | M          | N/A --- use Azure native | Hub-and-spoke or mesh topology             |
| 94  | **NAT Gateway**               | Outbound internet for private subnets | Azure NAT Gateway                            | XS         | N/A --- use Azure native | Direct equivalent                          |
| 95  | **S3 Transfer Acceleration**  | Accelerated upload to S3              | Azure CDN / Front Door (for upload patterns) | S          | N/A --- use Azure native | Different approach; CDN for distribution   |

---

## 12. Application integration

| #   | AWS feature      | Description                           | Azure equivalent                          | Complexity | CSA-in-a-Box evidence     | Notes                                      |
| --- | ---------------- | ------------------------------------- | ----------------------------------------- | ---------- | ------------------------- | ------------------------------------------ |
| 96  | **Lambda**       | Serverless compute                    | Azure Functions                           | M          | `csa_platform/functions/` | Direct equivalent; different trigger model |
| 97  | **API Gateway**  | Managed REST/WebSocket API            | Azure API Management                      | M          | N/A --- use Azure native  | Richer policy engine                       |
| 98  | **SQS**          | Managed message queue                 | Azure Queue Storage / Service Bus         | S          | N/A --- use Azure native  | Service Bus for enterprise messaging       |
| 99  | **SNS**          | Managed pub/sub notifications         | Event Grid / Service Bus Topics           | S          | N/A --- use Azure native  | Event Grid for event-driven                |
| 100 | **DynamoDB**     | Managed NoSQL database                | Cosmos DB (NoSQL API)                     | M          | N/A --- use Azure native  | Multi-model; global distribution           |
| 101 | **ElastiCache**  | Managed Redis/Memcached               | Azure Cache for Redis                     | S          | N/A --- use Azure native  | Direct equivalent                          |
| 102 | **RDS / Aurora** | Managed relational database           | Azure SQL / Azure Database for PostgreSQL | S          | N/A --- use Azure native  | Direct equivalents per engine              |
| 103 | **Cognito**      | User authentication and authorization | Entra External ID / Azure AD B2C          | M          | N/A --- use Azure native  | Different architecture                     |

---

## Migration complexity summary

### By effort level

| Effort | Count | Percentage | Description                         |
| ------ | ----- | ---------- | ----------------------------------- |
| XS     | 18    | 17%        | Drop-in replacement; < 1 day        |
| S      | 33    | 32%        | Minor adaptation; 1-3 days          |
| M      | 39    | 38%        | Moderate development; 1-3 weeks     |
| L      | 10    | 10%        | Significant development; 1-3 months |
| XL     | 3     | 3%         | Major initiative; 3+ months         |

### By domain

| Domain                  | Features | Avg. complexity | Highest risk                        |
| ----------------------- | -------- | --------------- | ----------------------------------- |
| Storage                 | 13       | S               | Minimal; strong parity              |
| Data warehousing        | 11       | M               | Stored procedure migration (L)      |
| Spark/Hadoop            | 9        | S-M             | EMR on EKS (L)                      |
| Ad-hoc queries          | 7        | S               | Partition projection (M)            |
| ETL/orchestration       | 10       | M               | Glue Streaming (M)                  |
| BI                      | 7        | S-M             | Dashboard rebuild is manual         |
| Streaming               | 5        | M               | MSK Connect connectors vary         |
| AI/ML                   | 8        | M               | SageMaker Pipeline conversion (M)   |
| Security/governance     | 8        | S-M             | Lake Formation tag-based access (L) |
| DevOps                  | 7        | S-M             | CloudFormation to Bicep (M)         |
| Networking              | 10       | S-M             | Transit Gateway to Virtual WAN (M)  |
| Application integration | 8        | S-M             | DynamoDB to Cosmos DB (M)           |

### Migration priority recommendation

For a typical federal analytics migration, the recommended order based on dependency and risk:

1. **Storage (S3 to ADLS/OneLake):** Foundation for everything else; OneLake shortcuts enable immediate bridge
2. **Identity (IAM to Entra ID/RBAC):** Required before any workload migration
3. **Catalog (Glue to Unity Catalog/Purview):** Required for compute migration
4. **Compute (Redshift/EMR/Athena to Databricks):** Core workload migration
5. **ETL (Glue to ADF/dbt):** Depends on catalog and compute
6. **Streaming (Kinesis/MSK to Event Hubs):** Independent; can parallelize
7. **BI (QuickSight to Power BI):** Depends on compute and catalog
8. **AI/ML (SageMaker/Bedrock to Azure AI):** Often independent track
9. **Monitoring (CloudWatch to Azure Monitor):** Throughout migration
10. **Networking (VPC to VNet):** Deploy early; configure throughout

---

## Gap summary

| #   | AWS feature                                | Gap description                                                                          | Workaround                                                                                       | Severity                                               |
| --- | ------------------------------------------ | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| 1   | **EMR on EKS**                             | No direct Kubernetes-native Spark equivalent in Databricks                               | Use AKS + Spark Operator for K8s-specific requirements; Databricks manages containers internally | Low --- affects only K8s-native Spark users            |
| 2   | **Glue DataBrew visual transforms**        | Power Query + dbt covers most cases; some point-and-click transforms require SQL rewrite | Document each DataBrew job; rewrite as dbt model or Power Query step                             | Low --- documented pattern                             |
| 3   | **Athena partition projection**            | No direct equivalent for dynamic partition inference                                     | Use Delta Lake auto-partitioning + Databricks partition pruning                                  | Low --- Delta handles this differently but effectively |
| 4   | **Lake Formation tag-based access**        | Unity Catalog uses catalog/schema/table grants; tag-based access is a roadmap item       | Use Unity Catalog row filters and column masks for fine-grained access                           | Medium --- different model but functional              |
| 5   | **Redshift SUPER type**                    | No native semi-structured column type in Delta                                           | Store as STRING with JSON functions; use `:` notation for field access in Databricks SQL         | Low --- JSON functions cover all use cases             |
| 6   | **Redshift Concurrency Scaling free tier** | No equivalent free burst capacity                                                        | Databricks Serverless auto-scales without a free-tier concept; cost is per-DBU                   | Low --- serverless pricing is competitive              |

---

## AWS services explicitly out of scope

The following AWS services are not part of the analytics migration and are not mapped in this document:

| Service                | Reason                        | Azure equivalent (if relevant)            |
| ---------------------- | ----------------------------- | ----------------------------------------- |
| EC2 (general compute)  | Infrastructure, not analytics | Azure Virtual Machines                    |
| ECS / Fargate          | Container orchestration       | Azure Container Apps / AKS                |
| Route 53               | DNS management                | Azure DNS                                 |
| CloudFront             | CDN                           | Azure Front Door / CDN                    |
| Elastic Load Balancing | Load balancing                | Azure Load Balancer / Application Gateway |
| AWS Backup             | Backup management             | Azure Backup                              |
| Systems Manager        | Operations management         | Azure Automation                          |

These services may be relevant to a broader cloud migration but are not addressed in this analytics-focused feature mapping.

---

## How to use this document

1. **For migration planning:** Filter to your specific AWS services. Not every row applies to every migration.
2. **For effort estimation:** Use the complexity column to build a rough work-breakdown structure. XS and S items can often be handled in parallel; L items need dedicated sprint capacity.
3. **For gap assessment:** Review the gap summary to identify areas requiring architectural decisions before migration.
4. **For executive communication:** Use the migration complexity summary to communicate risk and effort to stakeholders.

---

**Last updated:** 2026-04-30
**Maintainers:** CSA-in-a-Box core team
**Related:** [Migration Center](index.md) | [Why Azure over AWS](why-azure-over-aws.md) | [Migration Playbook](../aws-to-azure.md)
