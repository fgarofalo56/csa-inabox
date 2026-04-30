# Why Microsoft Fabric over Databricks

**Status:** Authored 2026-04-30
**Audience:** CIO, CDO, Chief Data Architect, and platform teams evaluating whether Fabric is the right strategic consolidation target for their current Databricks estate.
**Scope:** Strategic analysis comparing Databricks and Microsoft Fabric across platform architecture, cost model, BI integration, AI capabilities, governance, and ecosystem. This is an honest assessment -- not a vendor takedown.

---

## 1. Executive summary

Microsoft Fabric is a unified analytics platform that collapses data engineering, data warehousing, real-time analytics, data science, and business intelligence into a single SaaS experience backed by a single capacity billing model and a single data lake (OneLake). For organizations whose primary analytics output is **Power BI dashboards, governed BI semantic models, and analyst self-service**, Fabric is often a better fit than maintaining a separate Databricks workspace alongside a separate Power BI tenant.

This document is **not** a recommendation to rip out Databricks. Databricks remains best-in-class for heavy ML/DL training, multi-cloud data mesh architectures, Photon-accelerated query workloads, and organizations with deep investments in Unity Catalog and MLflow. The decision framework at the end of this document helps you determine which workloads benefit from migration and which should stay.

---

## 2. The case for Fabric

### 2.1 Unified platform -- one SKU, one experience

Databricks is an excellent lakehouse engine. But to build a production analytics stack you also need:

- A BI tool (Power BI, Tableau, Looker)
- A data catalog (Unity Catalog, Purview, Collibra)
- A real-time ingestion layer (Kafka, Event Hubs, Kinesis)
- An orchestration layer (Airflow, Databricks Workflows, ADF)
- A storage layer (ADLS, S3, GCS)

Each of these is a separate service, a separate billing line, and a separate team to operate.

Fabric bundles all of them:

| Capability | Databricks stack | Fabric equivalent |
| --- | --- | --- |
| Lakehouse engine | Databricks Runtime + Photon | Fabric Spark + Lakehouse |
| SQL analytics | Databricks SQL (DBSQL) | Fabric SQL endpoint |
| BI tool | Power BI (separate license) | Power BI (native in Fabric) |
| Real-time analytics | Structured Streaming + Delta Live Tables | Real-Time Intelligence + Eventhouse |
| Data integration | ADF / Fivetran / Airbyte | Fabric Data Pipelines (ADF v2 native) |
| Data catalog | Unity Catalog + Purview (separate) | OneLake metadata + Purview (integrated) |
| ML experiments | MLflow (native) | Fabric ML experiments |
| Capacity billing | DBU tiers (Jobs, SQL, All-Purpose, Serverless) | Fabric CU (single SKU, 24h smoothing) |

The operational simplification is real. One capacity, one billing meter, one admin portal, one set of workspace permissions.

### 2.2 Direct Lake -- zero-copy BI

Direct Lake is the single strongest technical reason to move BI workloads to Fabric.

**How it works:** Power BI reads Delta/Parquet files directly from OneLake without importing them into an in-memory model and without running live queries against a SQL endpoint. The VertiPaq engine loads column segments on demand from the lake.

**Why this matters:**

| Approach | Data freshness | Query speed | Storage cost | Compute cost |
| --- | --- | --- | --- | --- |
| Power BI Import | Stale (scheduled refresh) | Fast (in-memory) | Double (lake + PBI) | Refresh compute |
| DirectQuery to DBSQL | Real-time | Slower (round-trip) | Single | DBSQL warehouse running | 
| **Direct Lake** | Near-real-time | Fast (VertiPaq on-demand) | Single | Fabric CU only |

With Databricks, the typical pattern is: Databricks writes Delta tables, Power BI Import refreshes every N hours, consuming both DBSQL compute and Power BI Premium capacity. Direct Lake eliminates the refresh step entirely. Analysts see fresh data as soon as the pipeline writes it.

For semantic models over 100 MB with regular refresh, Direct Lake typically reduces total cost by 30-50% compared to the Databricks + Power BI Import pattern.

### 2.3 Power BI native -- no second BI tool

On Databricks, Power BI is a bolt-on. Semantic models point to DBSQL endpoints. DBSQL must be running (and billing DBUs) for any Power BI report to function. Row-level security requires maintaining both Unity Catalog permissions and Power BI RLS rules.

In Fabric, Power BI is a first-class citizen. Semantic models, reports, and dashboards live in the same workspace as lakehouses and notebooks. Workspace roles (Admin, Member, Contributor, Viewer) propagate from data to reports. There is no DBSQL endpoint to keep running -- the Lakehouse SQL endpoint is always available within your capacity.

### 2.4 Copilot integration across workloads

Microsoft Copilot is embedded across every Fabric experience:

- **Data engineering:** Copilot in Fabric notebooks generates PySpark / SQL code from natural language
- **Power BI:** Copilot creates report pages, writes DAX measures, summarizes data
- **Data Factory:** Copilot assists with pipeline design and dataflow expressions
- **Real-Time Intelligence:** Copilot generates KQL queries

Databricks has Databricks Assistant (notebook-focused) and is building out LLM features in the DBSQL editor, but the breadth of Copilot integration across BI, data engineering, and governance is wider in Fabric.

### 2.5 Single capacity billing vs complex DBU tiers

Databricks billing is per-DBU with different rates per SKU:

| Databricks SKU | Typical rate (Azure, pay-as-you-go) | Use case |
| --- | --- | --- |
| Jobs Compute | ~$0.15/DBU | Scheduled batch jobs |
| Jobs Light Compute | ~$0.07/DBU | Lightweight jobs |
| All-Purpose Compute | ~$0.40/DBU | Interactive notebooks |
| DBSQL Classic | ~$0.22/DBU | BI SQL queries |
| DBSQL Pro | ~$0.55/DBU | Advanced DBSQL features |
| DBSQL Serverless | ~$0.70/DBU | Serverless SQL |
| Delta Live Tables | Varies by tier | Streaming pipelines |

Each SKU has different rates. Cluster autoscaling, spot instances, Photon surcharges, and VM types add further complexity. A mid-size Databricks bill often has 6-8 line items.

Fabric has one meter: **Fabric Capacity Units (CU)**. You buy a capacity SKU (F2, F4, F8 ... F2048). All workloads -- Spark, SQL, Power BI, pipelines, real-time -- consume from the same pool. Unused capacity is averaged over 24 hours (smoothing), so spiky workloads do not require over-provisioning.

| Fabric SKU | CUs | Approximate monthly cost (pay-as-you-go) |
| --- | --- | --- |
| F2 | 2 | ~$260 |
| F8 | 8 | ~$1,040 |
| F16 | 16 | ~$2,080 |
| F32 | 32 | ~$4,160 |
| F64 | 64 | ~$8,320 |
| F128 | 128 | ~$16,640 |
| F256 | 256 | ~$33,280 |
| F512 | 512 | ~$66,560 |
| F1024 | 1,024 | ~$133,120 |

Reserved capacity (1-year or 3-year) reduces cost by 20-40%. See [tco-analysis.md](tco-analysis.md) for detailed worked examples.

### 2.6 OneLake -- one data lake, no data silos

Databricks storage historically meant DBFS (Databricks File System), a managed abstraction over cloud blob storage. With Unity Catalog, external locations point to ADLS/S3/GCS paths. Each workspace may have its own external locations, and cross-workspace data access requires careful metastore federation.

OneLake is a single, tenant-wide data lake backed by ADLS Gen2. Every Fabric workspace automatically writes to OneLake. Shortcuts allow OneLake to present external data (ADLS, S3, GCS, Dataverse) without copying it. There is one namespace, one set of permissions, one storage endpoint.

For organizations with 5+ Databricks workspaces, each with their own external locations, OneLake significantly simplifies the storage topology.

### 2.7 Microsoft 365 ecosystem integration

Fabric data surfaces natively in the Microsoft 365 ecosystem:

- **Teams:** Embed Power BI reports in Teams channels; receive pipeline alerts as Teams notifications
- **SharePoint:** Power BI reports auto-embed in SharePoint pages
- **Excel:** Connect Excel directly to Fabric Lakehouse SQL endpoints or semantic models
- **Outlook:** Schedule report delivery to email
- **Copilot for Microsoft 365:** Copilot can ground answers in Fabric semantic models ("What were last quarter's sales?" answered from your Fabric data)

Databricks has no native integration with the Microsoft 365 suite. Analysts who live in Excel, Teams, and SharePoint benefit from Fabric's first-party integration.

---

## 3. Where Databricks is still stronger -- be honest

This section exists because a credible migration guide must acknowledge trade-offs. Pretending Fabric is universally better would undermine trust.

### 3.1 Photon runtime performance

Photon is Databricks' C++ vectorized query engine. For CPU-bound Spark workloads -- especially wide joins, heavy aggregations, and complex UDFs -- Photon is 2-5x faster than open-source Spark. Fabric Spark is a managed fork of open-source Apache Spark. It does not include Photon or an equivalent vectorized engine.

**Implication:** Workloads that rely on Photon for acceptable performance should benchmark on Fabric Spark before committing to migration. See [benchmarks.md](benchmarks.md).

### 3.2 MLflow and ML ecosystem maturity

Databricks MLflow is the industry-standard ML experiment tracking system. It is deeply integrated with Unity Catalog for model lineage, with Databricks Model Serving for inference, and with Feature Store for feature management.

Fabric ML experiments exist, but the ecosystem is less mature:

- No native model serving (use Azure ML managed endpoints)
- Feature engineering is preview, not GA
- No equivalent to Databricks Vector Search
- No equivalent to Databricks Model Serving with GPU endpoints

For teams with heavy ML/DL training workloads, Databricks remains the stronger platform.

### 3.3 Multi-cloud

Databricks runs on AWS, Azure, and GCP. Fabric is Azure-only. Organizations with a multi-cloud data strategy or regulatory requirements to operate in non-Azure regions cannot consolidate onto Fabric.

### 3.4 Unity Catalog maturity

Unity Catalog provides a three-level namespace (catalog.schema.table), fine-grained access control (column-level, row-level), data lineage, and data sharing (Delta Sharing). It is battle-tested at scale.

Fabric's governance model uses workspace roles + OneLake permissions + Purview for classification and lineage. It works, but:

- No column-level security on Lakehouse tables (use Warehouse for column/row-level)
- Lineage depends on Purview integration, which requires separate setup
- Cross-workspace sharing is via shortcuts, not a unified catalog namespace

See [unity-catalog-migration.md](unity-catalog-migration.md) for the detailed mapping.

### 3.5 Ecosystem and community

Databricks has a large open-source ecosystem: Delta Lake, MLflow, Spark Connect, Koalas/pandas-on-Spark. The Databricks community (forums, conferences, partner integrations) is extensive. Many data engineering teams have deep Databricks expertise.

Fabric is newer (GA November 2023). The ecosystem is growing rapidly but is not yet as broad.

### 3.6 Spark version and library support

Databricks Runtime ships newer Spark versions faster and includes Photon-specific optimizations. Custom cluster libraries are installed per-cluster. Fabric environments support custom libraries but with more constraints (public PyPI only without workarounds, no custom Docker images on Spark, no GPU-attached Spark clusters as of April 2026).

---

## 4. Decision framework: when to migrate, when to stay, when to go hybrid

### 4.1 Migrate to Fabric when

- **Primary output is Power BI dashboards.** Direct Lake alone justifies the move.
- **Cost simplification is a priority.** One capacity SKU vs 6-8 Databricks billing lines.
- **Analysts live in Microsoft 365.** Excel, Teams, SharePoint integration is a force multiplier.
- **Data engineering is SQL-first or dbt-native.** Fabric Lakehouse SQL + dbt-fabric is mature.
- **Real-time BI is needed.** Eventhouse + KQL + Real-Time dashboards beat DLT for sub-second BI.
- **Governance needs to span BI and data.** Workspace roles propagate from data to reports.

### 4.2 Stay on Databricks when

- **Heavy ML/DL training is the primary workload.** Photon, MLflow, GPU clusters, Model Serving.
- **Multi-cloud is required.** Fabric is Azure-only.
- **Photon performance is critical.** Benchmark before assuming Fabric Spark is equivalent.
- **Unity Catalog is deeply adopted.** Column-level security, row-level, data sharing at scale.
- **Spark version cutting-edge matters.** Databricks ships newer Spark faster.

### 4.3 Hybrid: Databricks + Fabric (most common outcome)

For most enterprises, the right answer is hybrid:

| Layer | Stays on Databricks | Moves to Fabric |
| --- | --- | --- |
| Storage | ADLS Gen2 (Delta tables) | OneLake shortcuts to same ADLS |
| Compute -- heavy transforms | Databricks Jobs + Photon | -- |
| Compute -- ad-hoc SQL | -- | Fabric Lakehouse SQL endpoint |
| Compute -- ML training | Databricks + MLflow | -- |
| BI | -- | Power BI + Direct Lake |
| Real-time | -- | Fabric RTI / Eventhouse |
| Governance | Unity Catalog (data layer) | Purview + workspace roles (BI layer) |

Both engines read the same Delta tables via OneLake shortcuts. No data duplication. Each platform does what it does best.

---

## 5. Federal considerations

| Consideration | Databricks on Azure Gov | Fabric |
| --- | --- | --- |
| FedRAMP High | Authorized (Databricks on Azure Gov) | Inherited via Azure (Fabric Gov availability varies) |
| DoD IL4 / IL5 | Covered on Azure Gov | Check `docs/GOV_SERVICE_MATRIX.md` for Fabric parity |
| CMMC 2.0 Level 2 | Customer-managed + Databricks controls | Controls mapped in csa-inabox compliance YAML |
| HIPAA | Covered with BAA | Covered with BAA |
| Data residency | Azure Gov region-locked | Azure Gov region-locked (when available) |

> **Important:** Fabric is pre-GA or limited in Azure Government for some workloads as of April 2026. Federal customers should verify current Gov availability in `docs/GOV_SERVICE_MATRIX.md` before committing. Hybrid (Databricks on Azure Gov + Fabric commercial for non-sensitive BI) is a valid interim pattern.

---

## 6. Summary

Fabric is the right move for teams whose analytics value chain ends in Power BI, whose data engineering is SQL-first, and whose operational priority is simplifying the platform bill. It is not the right move for teams whose primary workload is ML training, whose Spark jobs depend on Photon performance, or who require multi-cloud.

Most enterprises will land on a hybrid: Databricks for heavy compute and ML, Fabric for BI and real-time. OneLake shortcuts make this hybrid seamless. The rest of this migration package provides the feature mapping, migration playbooks, tutorials, and benchmarks to execute whichever path you choose.

---

## Related

- [TCO Analysis](tco-analysis.md)
- [Feature Mapping (complete)](feature-mapping-complete.md)
- [Benchmarks](benchmarks.md)
- [Best Practices (hybrid strategy)](best-practices.md)
- [Parent guide: 5-phase migration](../databricks-to-fabric.md)
- [Reference Architecture: Fabric vs Synapse vs Databricks](../../reference-architecture/fabric-vs-synapse-vs-databricks.md)
- [ADR 0010: Fabric Strategic Target](../../adr/0010-fabric-strategic-target.md)

---

**Maintainers:** csa-inabox core team
**Source finding:** CSA-0083 (HIGH, XL) -- approved via AQ-0010 ballot B6
**Last updated:** 2026-04-30
