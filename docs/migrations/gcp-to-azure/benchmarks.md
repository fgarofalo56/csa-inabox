# Benchmarks and Performance Comparison: GCP Analytics vs Azure (csa-inabox)

**A data-driven comparison for CTOs, CDOs, and platform architects evaluating query performance, storage cost, ETL throughput, streaming latency, AI inference, BI delivery, ecosystem breadth, compliance coverage, and innovation velocity across GCP and Azure analytics stacks.**

---

## Methodology and transparency

Independent head-to-head benchmarks comparing GCP analytics services and Azure services under identical conditions are rare. Both vendors publish performance data for their own platforms, and independent organizations (TPC, Databricks, academic researchers) publish standardized benchmarks for specific engines.

This document uses the following approach:

1. **Published vendor data.** Performance figures from Google Cloud documentation, Microsoft Azure benchmark publications, Databricks benchmark reports, and TPC results.
2. **Standardized benchmarks.** TPC-DS and TPC-H results where available, comparing BigQuery and Databricks SQL at equivalent scale factors.
3. **Architectural analysis.** Where direct numbers are unavailable, we compare the underlying engine architectures using independently published benchmarks.
4. **Ecosystem metrics.** Service counts, connector counts, certification counts, and developer ecosystem sizes from public registries.
5. **Practitioner observations.** Published case studies and practitioner reports from organizations operating both platforms.

**Where GCP holds advantages, we say so.** This is an evidence-based comparison, not a marketing document.

---

## Summary comparison

| Dimension | GCP analytics stack | Azure (csa-inabox) | Edge |
|---|---|---|---|
| Analytic query performance | BigQuery (Dremel engine, BI Engine cache) | Databricks SQL (Photon), Direct Lake, Kusto | Comparable; Azure edge at large scale |
| Storage cost | GCS (multi-tier) | ADLS Gen2 + OneLake (multi-tier, Delta open format) | Azure (open format + comparable pricing) |
| ETL throughput | Dataflow (Beam) + Dataproc (Spark) | ADF + Databricks (Photon Spark) + dbt | Comparable; Databricks Photon faster at scale |
| Streaming latency | Pub/Sub + Dataflow streaming | Event Hubs + Stream Analytics / Databricks Streaming | Comparable; Event Hubs higher throughput ceiling |
| AI inference | Vertex AI (Gemini, PaLM) | Azure OpenAI (GPT-4o, o1) + AI Foundry | Azure (model breadth, published throughput) |
| BI performance | Looker (Explore + BI Engine) | Power BI (Direct Lake + Copilot) | Context-dependent; Direct Lake faster for large models |
| Ecosystem breadth | ~70 analytics/data services | 200+ services, 1,000+ connectors | Azure |
| Compliance coverage | Assured Workloads (~20 services at FedRAMP High) | Azure Gov (100+ services at FedRAMP High) | Azure (federal breadth) |
| Innovation velocity | Monthly releases, annual Next conference | Weekly service updates, monthly Fabric releases | Azure |

---

## 1. Query performance: BigQuery vs Databricks SQL vs Fabric

### BigQuery (Dremel engine)

BigQuery uses Google's Dremel columnar execution engine with automatic slot-based parallelism. Key characteristics:

- **Cold query latency:** 2-8 seconds for ad-hoc queries (slot acquisition + scheduling overhead)
- **Warm query latency:** Sub-second when BI Engine cache is hit (up to 200 GB reservation)
- **Concurrency:** Automatic multi-tenant slot scheduling; Enterprise Plus edition supports up to 2,000 concurrent slots per reservation
- **TPC-DS (SF-1000):** Google has not published official TPC-DS results, but independent testing places BigQuery in the 2-5x range vs. single-cluster Spark

**Strengths:** Zero-tuning auto-scaling; BI Engine provides genuine in-memory acceleration for repeated queries.

### Databricks SQL (Photon engine)

Databricks SQL uses the Photon C++ vectorized engine on Delta Lake:

- **Cold query latency:** 1-5 seconds (serverless warehouse startup is sub-second for warm pools)
- **Warm query latency:** Sub-second for cached queries; Photon provides 2-8x speedup over standard Spark SQL
- **Concurrency:** Configurable; serverless SQL warehouses auto-scale to handle hundreds of concurrent queries
- **TPC-DS (SF-100000):** Databricks holds the TPC-DS world record at 100TB scale (published 2023)

**Strengths:** Photon's native C++ execution outperforms JVM-based Spark at scale; Delta table statistics enable aggressive pruning.

### Fabric Direct Lake

Microsoft Fabric's Direct Lake mode reads Delta/Parquet files directly from OneLake into the VertiPaq in-memory engine:

- **Dashboard load latency:** Sub-second for models up to 500 GB (warm cache)
- **Query mode:** Automatic fallback to DirectQuery for unsupported patterns
- **Concurrency:** Scales with Fabric capacity (F-SKU); F64 supports ~200 concurrent report viewers

**Strengths:** Eliminates data import for BI; reads open Delta format with VertiPaq performance.

### Head-to-head: TPC-DS at various scale factors

| Scale factor | BigQuery (est.) | Databricks SQL (Photon) | Notes |
|---|---|---|---|
| SF-100 (100 GB) | ~45 min total runtime | ~25 min total runtime | Photon advantage at mid-scale |
| SF-1000 (1 TB) | ~90 min total runtime | ~55 min total runtime | Photon 1.5-2x faster |
| SF-10000 (10 TB) | ~6 hours | ~3.5 hours | Photon advantage widens at scale |
| SF-100000 (100 TB) | Not published | **World record holder** | Databricks published result |

*Note: BigQuery estimates are based on independent benchmarking reports, not official Google TPC submissions. Direct comparison should be validated in your own environment.*

---

## 2. Storage cost: GCS vs ADLS Gen2 vs OneLake

### Per-TB/month pricing comparison (US regions, list price)

| Tier | GCS | ADLS Gen2 | OneLake | Notes |
|---|---|---|---|---|
| Hot / Standard | $20/TB | $18.40/TB | $23/TB (included in Fabric CU) | OneLake pricing is Fabric-capacity-based |
| Cool / Nearline | $10/TB | $10/TB | N/A (use ADLS tiering) | Direct parity |
| Cold / Coldline | $4/TB | $3.60/TB | N/A | ADLS slightly cheaper |
| Archive | $1.20/TB | $1.80/TB | N/A | GCS cheaper at archive tier |
| Retrieval (per-GB read from archive) | $0.05 | $0.02 | N/A | ADLS cheaper retrieval |

### Storage format considerations

| Factor | GCP (BigQuery) | Azure (csa-inabox) |
|---|---|---|
| Native format | Capacitor (proprietary columnar) | Delta Lake (open Parquet-based) |
| Export cost to portable format | Egress + export compute | Zero (already in open format) |
| Multi-engine access | BigQuery only (or export to GCS) | Databricks, Fabric, Synapse, any Parquet reader |
| Vendor lock-in risk | High (Capacitor is not portable) | Low (Delta/Parquet is portable) |

> **Key insight:** BigQuery's storage cost looks competitive in isolation, but the exit cost is material. Data stored in BigQuery's Capacitor format must be exported (incurring compute and egress) before it can be used elsewhere. Delta Lake on ADLS Gen2 is natively portable.

---

## 3. ETL throughput: Dataflow vs ADF + Databricks

### Batch ingestion throughput

| Scenario | Dataflow (Beam on Managed VMs) | ADF Copy Activity | Databricks Auto Loader |
|---|---|---|---|
| 100 GB CSV → Parquet | ~12 min (n1-standard-4 x 10 workers) | ~8 min (32 DIU) | ~6 min (auto-scaling cluster) |
| 1 TB Parquet → Parquet (transform) | ~25 min (20 workers) | ~18 min (64 DIU) | ~12 min (Photon cluster) |
| 10 TB incremental load | ~45 min (auto-scale) | ~30 min (128 DIU) | ~20 min (Photon + auto-scale) |

*Estimates based on published throughput benchmarks and practitioner reports. Actual performance depends on source/sink network proximity, data shape, and transform complexity.*

### Transform throughput (complex SQL)

| Transform type | Dataflow (Beam) | dbt + Databricks (Photon) | Notes |
|---|---|---|---|
| Simple join + aggregate (10 GB) | ~3 min | ~1 min | Photon vectorized execution advantage |
| Multi-join star schema (100 GB) | ~15 min | ~5 min | 3x advantage for SQL-heavy patterns |
| Incremental merge (1 GB delta into 1 TB) | ~8 min | ~2 min | Delta Lake MERGE is optimized for incremental |

### Cost efficiency

| Metric | Dataflow | ADF + Databricks |
|---|---|---|
| Pricing model | Per-vCPU-hour + per-GB shuffle | ADF: per-activity-run + DIU-hours; Databricks: per-DBU |
| Spot / preemptible | Preemptible workers (Dataflow) | Spot instances (Databricks) |
| Serverless option | Dataflow Prime (preview) | Databricks Serverless SQL + Jobs |
| Reserved capacity discount | N/A (no commitments for Dataflow) | 25-40% reserved DBU discount |

---

## 4. Streaming latency: Pub/Sub vs Event Hubs

### Message broker comparison

| Metric | Pub/Sub | Event Hubs (Standard) | Event Hubs (Premium) |
|---|---|---|---|
| Publish latency (p50) | ~10 ms | ~8 ms | ~5 ms |
| Publish latency (p99) | ~50 ms | ~25 ms | ~15 ms |
| Max throughput per topic/hub | Unlimited (auto-scales) | 1 MB/s per TU (up to 40 TU) | 100 MB/s per PU |
| Max message size | 10 MB | 1 MB (Standard) / 1 MB (Premium) | 1 MB |
| Retention | 7 days (configurable to 31) | 1-90 days | 1-90 days |
| Kafka protocol support | No | Yes (Standard and above) | Yes |
| Ordering guarantee | Per-key (with ordering key) | Per-partition | Per-partition |

### End-to-end streaming latency

| Pipeline | GCP (Pub/Sub + Dataflow) | Azure (Event Hubs + Stream Analytics) | Azure (Event Hubs + Databricks Streaming) |
|---|---|---|---|
| Simple aggregate (5-min window) | ~15 sec end-to-end | ~10 sec end-to-end | ~8 sec end-to-end |
| Complex windowed join | ~30 sec end-to-end | ~25 sec (ASA) | ~15 sec (Structured Streaming) |
| Throughput ceiling | ~500K events/sec per job | ~1M events/sec (ASA) | ~2M events/sec (Databricks) |

> **GCP advantage:** Pub/Sub's unlimited auto-scaling is genuinely simpler for burst workloads. Event Hubs requires capacity planning (TU/PU sizing), though auto-inflate reduces the operational burden.

---

## 5. AI inference: Vertex AI vs Azure ML / Azure OpenAI

### LLM inference comparison

| Metric | Vertex AI (Gemini 1.5 Pro) | Azure OpenAI (GPT-4o) | Notes |
|---|---|---|---|
| Max context window | 2M tokens | 128K tokens | Gemini larger context |
| Throughput (tokens/min) | ~100K TPM (standard tier) | ~150K+ TPM (provisioned) | Azure higher throughput at scale |
| Latency (first token, p50) | ~400 ms | ~300 ms | Comparable |
| Model variety | Gemini, PaLM 2 | GPT-4o, GPT-4, o1, o3, Phi, Llama, Mistral | Azure broader model catalog |
| Fine-tuning | Gemini fine-tuning (preview) | GPT-4o fine-tuning (GA) | Both available |
| Batch inference | Vertex AI Batch Prediction | Azure OpenAI Batch API | Both available |

### ML training and serving

| Capability | Vertex AI | Azure ML + Databricks MLflow | Notes |
|---|---|---|---|
| AutoML | Vertex AutoML (tabular, vision, NLP) | Azure AutoML (tabular, vision, NLP) | Feature parity |
| Custom training | Vertex Training (custom containers) | Azure ML Compute + Databricks Jobs | Both support custom containers |
| Model registry | Vertex Model Registry | MLflow Model Registry + Azure ML | MLflow is open-source |
| Serving | Vertex Endpoints | Databricks Model Serving + Azure ML Endpoints | Both support auto-scaling |
| Feature store | Vertex Feature Store | Databricks Feature Store + Feast | Open-source option on Azure |

### BigQuery ML vs Databricks AI Functions

| Capability | BigQuery ML | Databricks AI Functions |
|---|---|---|
| Inline SQL training | `CREATE MODEL` (elegant, simple) | MLflow notebooks (more flexible, steeper curve) |
| SQL inference | `ML.PREDICT()` | `ai_query()` (for hosted models) |
| Supported algorithms | ~15 built-in (linear, boosted trees, K-means, etc.) | Any MLflow model + hosted LLMs |
| Custom models | Import TensorFlow/ONNX | Import any MLflow model |
| Simplicity | **GCP advantage** -- genuinely easier for simple models | More powerful but more setup |

---

## 6. BI performance: Looker vs Power BI

### Dashboard load time comparison

| Scenario | Looker (with BI Engine) | Power BI (Direct Lake) | Notes |
|---|---|---|---|
| Simple dashboard (5 visuals, 1M rows) | ~1.5 sec | ~0.8 sec | Direct Lake's in-memory advantage |
| Complex dashboard (20 visuals, 100M rows) | ~4 sec | ~2.5 sec | Photon + VertiPaq combined |
| Large model (1B+ rows) | ~8 sec (BI Engine miss) | ~3 sec (Direct Lake hit) | Direct Lake scales better for large models |
| Concurrent users (50 users, same dashboard) | ~2 sec (Looker node scaling) | ~1.5 sec (Fabric capacity) | Both handle concurrency well |
| Mobile rendering | ~3 sec | ~2 sec | Power BI has native mobile app |

### Feature comparison

| BI capability | Looker | Power BI | Edge |
|---|---|---|---|
| Semantic model (as code) | LookML (mature, Git-native) | TMDL + Git integration (newer) | Looker (maturity) |
| Ad-hoc exploration | Explore UI (powerful, learning curve) | Power BI Explore + Q&A + Copilot | Power BI (AI-assisted) |
| Natural language query | Looker natural language (limited) | Copilot for Power BI (GPT-backed) | Power BI |
| Embedded analytics | Looker Embedded (per-user licensing) | Power BI Embedded (capacity-based) | Power BI (cost model) |
| Version control | LookML in Git (first-class) | TMDL in Git (newer, improving) | Looker (maturity) |
| Scheduled delivery | Email/Slack/webhook | Subscriptions + Power Automate | Comparable |
| Licensing cost (500 users) | ~$1.5M/year (Looker Platform) | ~$500K/year (Fabric F64 capacity) | Power BI |

> **GCP advantage:** LookML's version-control discipline and modeling-as-code approach is more mature than Power BI's Git integration. For teams that value strict code-reviewed semantic models, LookML is a genuine strength. Power BI is closing this gap with TMDL and Fabric deployment pipelines.

---

## 7. Ecosystem breadth comparison

| Dimension | GCP | Azure | Notes |
|---|---|---|---|
| Total cloud services | ~100 | 200+ | Azure broader service catalog |
| Data & analytics services | ~25 | ~50 | Azure has more purpose-built engines |
| Native connectors (data integration) | 200+ (Dataflow + Data Fusion) | 1,000+ (ADF + Fabric connectors) | Azure 5x connector count |
| ISV marketplace listings | ~3,000 | ~18,000 | Azure Marketplace significantly larger |
| BI tool integrations | Looker, Data Studio | Power BI, Excel, Teams, SharePoint, Copilot | Azure deeper Office integration |
| Developer ecosystem | ~500K GCP-certified professionals | 10M+ Azure-certified professionals | Azure 20x developer pool |
| Open-source contributions | TensorFlow, Kubernetes (origin), Beam | VS Code, TypeScript, .NET, Playwright | Both strong OSS contributors |
| AI model catalog | Gemini, PaLM 2, Imagen | GPT-4o, o1, Phi, Llama, Mistral, Cohere, etc. | Azure broader model variety |

---

## 8. Compliance coverage: Assured Workloads vs Azure Government

### FedRAMP High service coverage

| Category | GCP Assured Workloads (FedRAMP High) | Azure Government (FedRAMP High) | Delta |
|---|---|---|---|
| Compute | Compute Engine, GKE, Cloud Run | VMs, AKS, Container Apps, Functions, App Service, Batch | Azure broader |
| Storage | GCS, Persistent Disk | Blob, ADLS Gen2, Files, Disks, Managed Disks | Comparable |
| Database | Cloud SQL, Spanner, Firestore, Bigtable | SQL Database, Cosmos DB, PostgreSQL, MySQL, Redis | Azure broader |
| Analytics | BigQuery (limited), Dataproc | Databricks, Fabric, Synapse, Data Explorer, ADF | Azure significantly broader |
| AI/ML | Vertex AI (limited) | Azure ML, Azure OpenAI, AI Services, AI Foundry | Azure significantly broader |
| Networking | VPC, Cloud DNS, Cloud Load Balancing | VNet, DNS, Application Gateway, Front Door, Firewall | Comparable |
| Identity | Cloud IAM | Entra ID, Managed Identity, Conditional Access | Azure deeper |
| Total services at FedRAMP High | ~20 | 100+ | Azure 5x coverage |

### Impact level coverage

| Impact level | GCP Assured Workloads | Azure Government |
|---|---|---|
| FedRAMP High | ~20 services | 100+ services |
| DoD IL2 | Covered | Covered |
| DoD IL4 | Partial (~10 services) | Broad (80+ services) |
| DoD IL5 | Limited (~5 services) | Broad (70+ services) |
| DoD IL6 | Not available | Azure Government Secret |
| ITAR | Assured Workloads ITAR | Azure Government (tenant-bound) |

> **Key federal differentiator:** For agencies requiring FedRAMP High or DoD IL4/IL5 across the full analytics stack (warehouse + ETL + BI + AI), Azure Government provides significantly broader coverage. This is the primary driver for GCP-to-Azure migrations in the federal space.

---

## 9. Innovation velocity metrics

| Metric | GCP | Azure | Source |
|---|---|---|---|
| Annual service updates | ~300 | 1,000+ | Public changelogs |
| New service launches (2024) | ~15 | ~40 | Ignite / Next announcements |
| Fabric release cadence | N/A | Monthly | Microsoft Fabric release notes |
| Databricks runtime releases | N/A (Dataproc uses OSS Spark) | Quarterly (DBR versions) | Databricks release notes |
| Public preview programs | Limited | Extensive (Azure Preview) | Azure Preview portal |
| Documentation update frequency | Weekly | Daily | Docs changelogs |

---

## Where GCP holds advantages

This comparison would be incomplete without acknowledging areas where GCP's analytics stack provides genuine benefits:

1. **BigQuery slot-based auto-scaling.** BigQuery's separation of storage and slot-based compute is elegant. There is no cluster to size, no warehouse to configure. Databricks Serverless SQL is approaching this simplicity but is not yet identical.

2. **BigQuery ML inline SQL simplicity.** `CREATE MODEL` and `ML.PREDICT` inside a SQL query is genuinely simpler than the MLflow workflow for straightforward models (linear regression, boosted trees, K-means). Databricks AI Functions and `ai_query()` are closing this gap.

3. **Pub/Sub unlimited auto-scaling.** Pub/Sub requires zero capacity planning. Event Hubs requires TU/PU sizing (though auto-inflate helps). For unpredictable burst workloads, Pub/Sub's model is simpler.

4. **Looker LookML modeling discipline.** LookML's Git-native, code-reviewed semantic modeling is more mature than Power BI's TMDL/Git integration. Teams with strong software engineering culture may prefer LookML's approach.

5. **Gemini 2M-token context window.** For AI use cases requiring very large context (full-document analysis, long conversations), Gemini's 2M-token window exceeds GPT-4o's 128K window.

---

## Recommendations

| If your priority is... | Recommended platform | Rationale |
|---|---|---|
| FedRAMP High coverage across analytics | Azure (csa-inabox) | 5x service coverage at FedRAMP High |
| DoD IL4/IL5 breadth | Azure (csa-inabox) | GCP IL5 coverage is very narrow |
| Maximum query performance at scale | Azure (Databricks SQL Photon) | TPC-DS world record holder |
| Simplest zero-config analytics | GCP (BigQuery) | Slot-based auto-scaling is genuinely simpler |
| BI cost optimization (large user base) | Azure (Power BI / Fabric) | Capacity-based vs. per-user licensing |
| Open storage format / low exit cost | Azure (Delta Lake on ADLS Gen2) | Open format vs. BigQuery Capacitor |
| AI model variety | Azure (Azure OpenAI + AI Foundry) | Broader model catalog |
| Streaming at very high throughput | Azure (Event Hubs Premium) | Higher throughput ceiling |
| Ecosystem integration (Office 365, Teams) | Azure | Native M365 integration |
| Minimal vendor lock-in | Azure (csa-inabox) | Delta/Parquet open format, MLflow open-source |

---

## Related resources

- [GCP to Azure Migration Playbook](../gcp-to-azure.md) -- End-to-end migration guide
- [BigQuery to Fabric Tutorial](tutorial-bigquery-to-fabric.md) -- Hands-on table migration
- [Looker to Power BI Tutorial](tutorial-looker-to-powerbi.md) -- Semantic model conversion
- [Dataflow to ADF Tutorial](tutorial-dataflow-to-adf.md) -- Pipeline migration
- [Best Practices](best-practices.md) -- Migration lessons learned and pitfalls

---

**Methodology version:** 1.0
**Last updated:** 2026-04-30
**Maintainers:** CSA-in-a-Box core team
