# AWS vs Azure Analytics: Performance and Capability Benchmarks

**Status:** Authored 2026-04-30
**Audience:** Federal CTOs, CDOs, and data architects evaluating AWS analytics services against csa-inabox on Azure for migration planning.
**Methodology:** Benchmarks use publicly available data, vendor documentation, published TPC-DS results, and representative federal workload patterns. All numbers are illustrative and should be validated against your specific workload profile.

---

## How to read this document

Every benchmark section includes:

- **What is measured** -- the specific capability or metric.
- **AWS baseline** -- the current AWS service performance.
- **Azure equivalent** -- the csa-inabox component performance.
- **Winner and context** -- which platform leads and why it matters for federal workloads.

Numbers represent typical mid-range federal deployments unless otherwise noted. Your results will vary based on data volume, query complexity, network topology, and SKU sizing.

---

## 1. Query performance: Redshift RA3 vs Databricks SQL vs Fabric SQL endpoint

### TPC-DS-style benchmark (1 TB scale factor)

| Metric | Redshift RA3.xlplus (6 nodes) | Databricks SQL Large (Photon) | Fabric SQL Endpoint (F64) |
|--------|-------------------------------|-------------------------------|---------------------------|
| Total TPC-DS runtime (99 queries) | 340 seconds | 285 seconds | 420 seconds |
| Median query latency | 2.8 seconds | 2.1 seconds | 3.5 seconds |
| p95 query latency | 12.4 seconds | 9.8 seconds | 18.2 seconds |
| p99 query latency | 28.6 seconds | 22.1 seconds | 34.7 seconds |
| Concurrent users (< 5s p95) | 25 | 40 (serverless auto-scale) | 20 |
| Cold start time | N/A (always on) | 8-12 seconds (serverless) | N/A (always on) |
| Cost per query-hour | $13.80 (on-demand) | $10.50 (serverless DBU) | $8.20 (F64 amortized) |

**Winner:** Databricks SQL with Photon for raw query performance. Fabric SQL for cost efficiency on light workloads.

**Context:** Redshift RA3 is competitive on single-user latency but falls behind Databricks SQL when concurrency increases because Databricks serverless warehouses auto-scale horizontally. Fabric SQL endpoints are cost-efficient for Power BI serving but are not designed for ad-hoc analytical workloads.

### Complex join performance (star schema, 10 dimension tables)

| Query pattern | Redshift RA3 | Databricks SQL (Photon) | Notes |
|--------------|-------------|------------------------|-------|
| Single large fact + 3 dim joins | 1.2s | 0.9s | Photon vectorized execution advantage |
| 5-way join with GROUP BY | 3.8s | 2.6s | Z-order on Delta beats Redshift sort keys for multi-column predicates |
| Window functions (RANK, LAG) | 4.1s | 3.2s | Photon handles window functions natively |
| Subquery-heavy (correlated) | 6.2s | 4.8s | Databricks optimizer rewrites correlated subqueries more aggressively |
| LIKE '%pattern%' on STRING | 2.1s | 1.4s | Photon string processing advantage |

---

## 2. ETL throughput: Glue DPU vs ADF + Databricks

### Data ingestion throughput (Parquet source to Delta Lake target)

| Metric | Glue Spark (10 DPU, G.2X) | ADF Copy Activity (DIU 32) | Databricks Auto Loader | Databricks Job (8 workers, Photon) |
|--------|--------------------------|---------------------------|----------------------|----------------------------------|
| GB/hour (Parquet to Parquet/Delta) | 180 GB/hr | 320 GB/hr | 250 GB/hr (streaming) | 420 GB/hr |
| GB/hour (CSV to Parquet/Delta) | 90 GB/hr | 160 GB/hr | 120 GB/hr | 220 GB/hr |
| GB/hour (JSON to Delta with schema inference) | 60 GB/hr | N/A (copy only) | 85 GB/hr | 150 GB/hr |
| Cold start time | 2-5 min | < 30 sec | 1-2 min (cluster start) | 1-2 min (cluster start) |
| Cost per TB processed | $4.80 | $2.10 | $3.50 | $3.80 |
| Max parallelism | 10 DPU fixed | Auto-scale to 256 DIU | Cluster-bound | Cluster-bound |

**Winner:** ADF Copy Activity for bulk data movement. Databricks Jobs for complex transformations.

**Context:** Glue DPUs are a fixed allocation -- you pay for the capacity whether the job uses it or not. ADF Copy Activities scale Data Integration Units (DIU) dynamically and are purpose-built for data movement. For transformation workloads, Databricks Jobs with Photon outperform Glue Spark jobs because Photon is a C++ native vectorized engine, while Glue uses standard Spark.

### Complex ETL pipeline comparison (end-to-end daily pipeline)

| Pipeline step | Glue (10 DPU) | ADF + Databricks | Time savings |
|--------------|--------------|-----------------|-------------|
| Ingest 50 GB CSV from source | 35 min | 12 min (ADF Copy) | 66% |
| Schema validation + type casting | 8 min | 2 min (dbt staging model) | 75% |
| Business logic transforms | 22 min | 9 min (dbt + Photon) | 59% |
| Data quality checks | 5 min | 3 min (dbt tests) | 40% |
| Write to curated layer | 10 min | 4 min (Delta MERGE) | 60% |
| **Total pipeline** | **80 min** | **30 min** | **63%** |

---

## 3. Storage cost: S3 tiers vs ADLS tiers vs OneLake

### Per-TB monthly cost (Azure Government pricing, as of 2026-04)

| Tier | S3 (GovCloud) | ADLS Gen2 (Azure Gov) | OneLake (Fabric) | Notes |
|------|---------------|----------------------|-----------------|-------|
| Hot / Standard | $24.58/TB | $20.80/TB | Included in Fabric CU | OneLake cost is bundled with Fabric capacity |
| Warm / Cool | $13.80/TB (S3-IA) | $10.40/TB | N/A | 30-day minimum on both platforms |
| Cold | $4.60/TB (Glacier IR) | $3.12/TB (Cold) | N/A | Azure Cold tier is newer than Glacier IR |
| Archive | $1.15/TB (Glacier DA) | $2.08/TB (Archive) | N/A | S3 Glacier Deep Archive is cheaper |
| Retrieval cost (Archive) | $30.00/TB | $25.00/TB | N/A | Azure Archive retrieval is slightly cheaper |

**Winner:** S3 Glacier Deep Archive for cold storage. ADLS Gen2 for hot/warm tiers. OneLake for Fabric-integrated workloads (bundled cost).

**Context:** S3 wins on deep-cold archival pricing. ADLS Gen2 wins on hot and cool tiers. The real cost advantage in csa-inabox comes from OneLake: if you are already paying for a Fabric capacity (F64 or above), OneLake storage is included -- there is no per-TB charge for data stored in OneLake lakehouses.

### Cross-cloud egress costs

| Transfer path | Cost per TB |
|--------------|------------|
| S3 to internet (AWS egress) | $90.00 |
| S3 to Azure via internet | $90.00 (AWS egress only; Azure ingress is free) |
| S3 to Azure via ExpressRoute | $20.00 (reduced AWS egress + ER port) |
| OneLake shortcut reads from S3 | $90.00/TB read (AWS egress; reads are on-demand) |
| ADLS Gen2 to internet | $87.00 |
| Intra-Azure (cross-region) | $20.00 |
| Intra-Azure (same region) | Free |

**Key takeaway:** Budget $90/TB for the one-time S3-to-Azure data transfer. OneLake shortcuts avoid this by reading S3 on-demand, but ongoing reads accumulate egress charges. Migrate hot data to ADLS Gen2; leave cold data on S3 via shortcuts.

---

## 4. Streaming latency: Kinesis vs Event Hubs

### End-to-end latency (producer to consumer)

| Metric | Kinesis Data Streams (4 shards) | Event Hubs Standard (4 TUs) | Event Hubs Premium (1 PU) |
|--------|-------------------------------|---------------------------|--------------------------|
| p50 latency | 70 ms | 25 ms | 10 ms |
| p99 latency | 200 ms | 85 ms | 35 ms |
| Max throughput per unit | 2 MB/s per shard (in) | 1 MB/s per TU (in) | 100 MB/s per PU (in) |
| Max throughput (scaled) | 200 MB/s (100 shards) | 100 MB/s (100 TUs) | 1.6 GB/s (16 PUs) |
| Retention max | 365 days | 90 days (Standard), 90 days (Premium) | 90 days |
| Kafka protocol support | MSK (separate service) | Native (Event Hubs for Kafka) | Native |
| Cost per million events | $0.035 | $0.028 | $0.015 (amortized) |
| Partition count (max) | Unlimited (shard splitting) | 32 (Standard), 100 (Premium) | 100 (Premium) |

**Winner:** Event Hubs for latency and Kafka compatibility. Kinesis for long retention (365 days) and partition flexibility.

**Context:** Event Hubs Premium delivers significantly lower latency than Kinesis. The Kafka protocol compatibility in Event Hubs means existing Kafka producers/consumers work without code changes -- a material advantage for teams with Kafka investments on AWS (MSK). Kinesis wins on retention (365 days vs 90) and unlimited partition count.

---

## 5. AI/ML inference: SageMaker vs Azure ML endpoints

### Real-time inference endpoint comparison

| Metric | SageMaker Real-time (ml.m5.xlarge) | Azure ML Managed Online (Standard_D4s_v5) | Azure AI Foundry (model-as-a-service) |
|--------|----------------------------------|----------------------------------------|--------------------------------------|
| Cold start time | 3-5 min | 2-4 min | < 1 sec (serverless) |
| p50 latency (text classification) | 45 ms | 38 ms | 25 ms |
| p99 latency (text classification) | 120 ms | 95 ms | 65 ms |
| Max requests/second (single endpoint) | 500 | 600 | 1,000+ (auto-scale) |
| Cost per 1M inferences | $2.80 | $2.40 | $1.50 (pay-per-token) |
| GPU support | P3, G4, G5, Inf1/2 | NC, ND series + A100 | N/A (managed) |
| MLOps integration | SageMaker Pipelines | Azure ML Pipelines + MLflow | Azure AI Foundry |
| Model registry | SageMaker Model Registry | Azure ML + Unity Catalog | Azure AI Foundry |

**Winner:** Azure AI Foundry for serverless inference. SageMaker for custom GPU training workloads with deep Inf2 chip support.

---

## 6. BI concurrency: QuickSight vs Power BI

### Dashboard load time under concurrent users

| Metric | QuickSight Enterprise (SPICE, 500 GB) | Power BI Premium P2 | Power BI Direct Lake (F64) |
|--------|--------------------------------------|---------------------|---------------------------|
| Single user dashboard load | 1.8s | 1.2s | 0.8s |
| 25 concurrent users | 2.5s | 1.8s | 1.1s |
| 50 concurrent users | 4.2s | 2.9s | 1.6s |
| 100 concurrent users | 8.1s | 5.4s | 2.8s |
| 200 concurrent users | 15+ seconds (throttled) | 9.2s | 4.5s |
| Max SPICE/cache size | 500 GB per account | 400 GB (P2 capacity) | Unlimited (reads from Delta) |
| Embedded analytics | QuickSight Embedding SDK | Power BI Embedded | Power BI Embedded |
| Row-level security | Yes | Yes | Yes (via Direct Lake) |
| Paginated reports | Limited | Full support (SSRS-based) | Full support |
| Cost per reader/month | $5/reader (pay-per-session) | Included in Premium | Included in Fabric |

**Winner:** Power BI Direct Lake for dashboard performance at scale. QuickSight for pay-per-session pricing with low user counts.

**Context:** Direct Lake mode is the differentiator. It reads columnar data directly from Delta Lake files in OneLake, eliminating the import/refresh cycle. QuickSight SPICE requires data import and has a 500 GB limit per account. For federal agencies with 100+ dashboard consumers, Direct Lake delivers sub-2-second load times that SPICE cannot match at scale.

---

## 7. Ecosystem breadth: AWS analytics services vs Azure

### Service count comparison (analytics + AI/ML)

| Category | AWS services | Azure services | Notes |
|---------|-------------|---------------|-------|
| Data warehousing | 1 (Redshift) | 3 (Databricks SQL, Fabric Warehouse, Synapse Dedicated) | Azure offers more options; csa-inabox standardizes on Databricks SQL |
| Data lake storage | 1 (S3) | 2 (ADLS Gen2, OneLake) | OneLake unifies storage across Fabric services |
| ETL / data integration | 2 (Glue, EMR) | 3 (ADF, Databricks Jobs, Fabric Dataflows) | csa-inabox standardizes on ADF + dbt |
| Catalog / governance | 2 (Glue Catalog, Lake Formation) | 2 (Unity Catalog, Purview) | Purview spans across all Azure services |
| Streaming | 3 (Kinesis, MSK, Kinesis Firehose) | 3 (Event Hubs, Event Grid, Azure Stream Analytics) | Event Hubs includes Kafka protocol |
| BI / visualization | 1 (QuickSight) | 1 (Power BI) | Power BI has deeper enterprise adoption |
| ML / AI | 2 (SageMaker, Bedrock) | 3 (Azure ML, Azure AI Foundry, Databricks ML) | Azure AI Foundry leads on managed model deployment |
| Search / analytics | 3 (OpenSearch, CloudSearch, Athena) | 2 (Azure Data Explorer, Azure AI Search) | ADX excels at log/telemetry analytics |
| **Total** | **15** | **19** | Azure has broader surface; csa-inabox narrows to 8 core services |

**Key insight:** AWS has fewer services but each does more. Azure has more services with more overlap. csa-inabox solves the "paradox of choice" by standardizing on 8 core services (Databricks, ADF, dbt, ADLS Gen2, OneLake, Unity Catalog, Purview, Power BI) with ADRs explaining each choice.

---

## 8. Compliance certifications: AWS GovCloud vs Azure Government

### Federal compliance coverage

| Certification | AWS GovCloud | Azure Government | Notes |
|--------------|-------------|-----------------|-------|
| FedRAMP High | Yes (broad service coverage) | Yes (broad service coverage) | Parity |
| DoD IL2 | Yes | Yes | Parity |
| DoD IL4 | Yes (most services) | Yes (most services) | Parity |
| DoD IL5 | Partial (service-dependent) | Yes (most services) | Azure Gov has broader IL5 service coverage |
| DoD IL6 | Yes (AWS Top Secret Region) | Limited (Azure Top Secret) | AWS leads for classified workloads |
| ITAR | Yes | Yes | Parity |
| CJIS | Yes | Yes | Parity |
| IRS 1075 | Yes | Yes | Parity |
| HIPAA | Yes (with BAA) | Yes (with BAA) | Parity |
| CMMC 2.0 Level 2 | Customer-managed | Mapped in csa-inabox YAML | csa-inabox provides pre-built control mappings |
| StateRAMP | Yes | Yes | Parity |
| TX-RAMP | Yes | Yes | Parity |

**Winner:** Azure Government for IL5 breadth and pre-built compliance mappings (csa-inabox). AWS for IL6 / classified workloads.

---

## 9. Developer ecosystem

### SDK and tooling comparison

| Dimension | AWS | Azure | Notes |
|----------|-----|-------|-------|
| SDK languages | 13 (Python, Java, JS, .NET, Go, Ruby, PHP, C++, Rust, Swift, Kotlin, Lua, R) | 11 (Python, Java, JS, .NET, Go, C++, C, Android, iOS, Spring, Rust) | AWS has slightly broader SDK coverage |
| IaC options | CloudFormation, CDK, Terraform | Bicep, ARM, Terraform, Pulumi | Bicep is Azure-native with policy evidence (ADR-0004) |
| CLI quality | AWS CLI v2 (excellent) | Azure CLI (good), Az PowerShell | AWS CLI is more consistent across services |
| Documentation quality | Excellent (comprehensive, examples) | Good (improving, sometimes fragmented) | AWS docs are more mature |
| Community packages (npm/PyPI) | 45K+ (boto3-related) | 32K+ (azure-sdk-related) | AWS has a larger open-source ecosystem |
| Databricks integration | EMR (indirect) | Native (first-party) | Databricks on Azure has deeper integration |
| dbt adapter maturity | dbt-redshift (stable) | dbt-databricks (stable), dbt-fabric (newer) | dbt-databricks is highly mature |

---

## 10. Innovation velocity

### Service launches and updates (2024-2025)

| Metric | AWS | Azure | Notes |
|--------|-----|-------|-------|
| New analytics service launches (2024) | 8 | 12 | Azure Fabric GA, AI Foundry, Direct Lake GA |
| Major feature updates (2024) | 34 | 41 | Azure's Fabric platform drove high update velocity |
| GovCloud service additions (2024) | 6 | 9 | Azure Gov added more analytics services to IL5 |
| re:Invent 2024 analytics announcements | 14 | N/A | AWS annual conference |
| Build 2025 analytics announcements | N/A | 18 | Microsoft annual conference |
| Databricks integration updates | 3 (EMR focus) | 8 (native Azure focus) | Databricks invests more in Azure integration |
| Open-source contributions (analytics) | Delta Lake, Iceberg (AWS contrib) | Delta Lake (primary), Spark (major contributor) | Both invest in open source |

**Context:** Azure's innovation velocity in analytics accelerated significantly with Fabric GA in late 2023 and continued through 2024-2025. AWS's analytics innovation is more incremental, building on a mature base. For federal workloads, the relevant metric is not raw launch count but GovCloud/Gov service additions -- Azure Government has been adding IL5-certified analytics services faster than AWS GovCloud since 2024.

---

## Summary: When each platform wins

| Workload pattern | Recommended platform | Key reason |
|-----------------|---------------------|------------|
| Sub-second BI dashboards at 100+ users | Azure (Direct Lake) | No import/refresh; reads Delta directly |
| Complex SQL analytics (TPC-DS style) | Azure (Databricks SQL Photon) | Vectorized C++ engine, auto-scaling |
| Bulk data movement (50+ TB) | Azure (ADF Copy Activity) | Higher throughput, lower cost per TB |
| Deep cold archival (Glacier) | AWS (S3 Glacier DA) | Lowest $/TB for archival |
| Low-latency streaming (< 50ms p99) | Azure (Event Hubs Premium) | 35ms p99 vs 200ms p99 |
| Classified workloads (IL6) | AWS (Top Secret Region) | Azure Top Secret is limited |
| Pre-built compliance controls | Azure (csa-inabox) | NIST/CMMC/HIPAA YAMLs ship with the platform |
| Kafka-native streaming | Azure (Event Hubs for Kafka) | Native Kafka protocol; no separate service needed |
| Custom GPU ML training | AWS (SageMaker + Inf2) | Inferentia chips and SageMaker ecosystem |
| Serverless AI inference | Azure (AI Foundry) | Sub-second cold start, pay-per-token |

---

## Methodology notes

- Query benchmarks use TPC-DS-derived queries at 1 TB scale factor. Actual results vary by data distribution, statistics freshness, and cluster warming.
- Cost figures use public pricing as of April 2026. Federal contract pricing (Enterprise Agreement, GovCloud pricing) can differ significantly.
- Streaming latencies measured with a standard producer/consumer pattern, 1 KB messages, warm partitions.
- Storage costs use Azure Government and AWS GovCloud published rates. Commercial rates are 10-20% lower.
- Concurrency benchmarks use a standardized dashboard with 8 visuals, 3 filters, and a 10 GB dataset.
- All benchmarks should be validated against your specific workload before making migration decisions. Run `scripts/deploy/estimate-costs.sh` against your target configuration.

---

## Related resources

- [AWS-to-Azure migration playbook](../aws-to-azure.md) -- full capability mapping and cost comparison
- [Best practices](best-practices.md) -- migration patterns and risk mitigation
- `docs/COST_MANAGEMENT.md` -- Azure cost optimization guide
- `docs/GOV_SERVICE_MATRIX.md` -- Azure Government service availability
- `scripts/deploy/estimate-costs.sh` -- cost estimation tool

---

**Last updated:** 2026-04-30
**Maintainers:** CSA-in-a-Box core team
