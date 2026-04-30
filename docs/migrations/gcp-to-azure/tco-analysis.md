# Total Cost of Ownership: GCP Analytics vs Azure

**A detailed financial analysis for federal CFOs, CIOs, and procurement officers evaluating the cost implications of migrating from GCP analytics to Microsoft Azure.**

---

## Executive summary

GCP analytics pricing is built around two anchors: BigQuery's slot-based compute model (with Edition commitments) and Looker's per-seat licensing. For federal tenants, these combine to create cost structures that penalize data democratization and scale linearly with headcount and query volume. Azure's consumption-based model -- anchored by Fabric capacity SKUs and Power BI's inclusive licensing -- scales with workload intensity, not user count, producing 20-50% cost reductions at comparable scale for most federal deployments.

This analysis covers three federal scenarios (small, medium, large), a detailed hidden-cost analysis including GCP-to-Azure egress during migration, and a 5-year projection.

---

## GCP analytics pricing structure

### BigQuery pricing

BigQuery offers three pricing tracks:

| Pricing model | Cost | Best for | Commitment |
|---|---|---|---|
| **On-demand** | $6.25/TB scanned | Exploratory, low-volume | None |
| **Standard Edition** | ~$0.04/slot-hour | Small teams, variable workloads | 1-year auto-renew |
| **Enterprise Edition** | ~$0.06/slot-hour | Mid-size, with governance features | 1-year or 3-year |
| **Enterprise Plus** | ~$0.10/slot-hour | Large, with advanced security | 1-year or 3-year |

**Storage:**

| Tier | Cost | Notes |
|---|---|---|
| Active storage | $0.02/GB/month | Tables queried in last 90 days |
| Long-term storage | $0.01/GB/month | Tables not queried in 90+ days |
| Streaming inserts | $0.05/GB | Real-time ingestion surcharge |
| Storage Write API | $0.025/GB | Batch ingestion via API |

**Key complexity:** Slot commitments require capacity planning. Under-commit and on-demand overflow is expensive. Over-commit and you pay for idle slots. The flex-slots model (short-term commitments) has been deprecated in favor of Editions.

### Dataproc pricing

| Component | Cost | Notes |
|---|---|---|
| Cluster management | $0.01/vCPU/hour | On top of compute VM costs |
| Compute VMs | Standard GCE pricing | n1-standard-4: ~$0.19/hour |
| Persistent disk | $0.04/GB/month (SSD) | Per worker node |
| Serverless Spark | $0.065/DCU-hour | Data Compute Units |

**Key complexity:** Dataproc clusters incur cost even when idle unless explicitly stopped. Autoscaling helps but does not eliminate idle cost during low-activity periods.

### GCS pricing

| Tier | Cost | Notes |
|---|---|---|
| Standard | $0.020/GB/month | Hot access |
| Nearline | $0.010/GB/month | 30-day minimum |
| Coldline | $0.004/GB/month | 90-day minimum |
| Archive | $0.0012/GB/month | 365-day minimum |
| Egress (internet) | $0.08-$0.12/GB | Material for migration |
| Egress (cross-cloud) | $0.08-$0.12/GB | GCP-to-Azure transfer |

### Looker pricing

Looker pricing is per-seat and negotiated per-contract:

| Component | Typical cost | Notes |
|---|---|---|
| Viewer seats | $3,000-$5,000/seat/year | Read-only dashboard access |
| Developer seats | $5,000-$10,000/seat/year | LookML development, Explore access |
| Platform fee | $100K-$300K/year | Base platform + hosting |
| Embedding add-on | $50K-$200K/year | If embedding Looker in custom apps |
| Looker Studio | Free (basic) | Limited compared to full Looker |

**Key cost driver:** Every new analyst who needs more than Looker Studio requires a seat license. At 500 users, Looker licensing alone reaches $1.5M-$3.0M/year.

### Vertex AI pricing

| Component | Cost | Notes |
|---|---|---|
| Training (custom) | $0.49-$3.52/node-hour | Depends on accelerator |
| AutoML training | $3.15/node-hour (tabular) | Higher for image/video |
| Prediction (online) | $0.0416-$0.3680/node-hour | Depends on machine type |
| Gemini API | $0.10-$0.30/1M input tokens | Model-dependent |
| AI Search | $2.50/1,000 queries | Enterprise tier |

### Other GCP costs

| Service | Typical cost | Notes |
|---|---|---|
| Cloud Composer (Airflow) | $300-$500/environment/month | Small environment |
| Dataflow (Beam) | $0.056/vCPU-hour + $0.003/GB-hour | Streaming adds ~20% |
| Pub/Sub | $40/TB ingested | Plus delivery and storage |
| Cloud Functions | $0.40/million invocations | Plus compute time |
| Data Catalog | Free (basic) | Policy tags are separate |
| Cloud KMS | $0.06/10,000 operations | Plus key storage |

---

## Azure pricing structure

| Component | Typical cost | Notes |
|---|---|---|
| Fabric capacity (F32-F256) | $200K-$2.4M/year | Unlimited users within capacity |
| Databricks SQL + Jobs | $200K-$1.3M/year | DBU-based with auto-scaling |
| ADLS Gen2 storage (hot) | $0.018/GB/month | Open Delta Lake format |
| ADLS Gen2 storage (cool) | $0.01/GB/month | 30-day minimum |
| ADLS Gen2 storage (archive) | $0.002/GB/month | Offline retrieval |
| Power BI Pro | $10/user/month | Or included in Fabric capacity |
| Power BI PPU | $20/user/month | For premium features per-user |
| Azure OpenAI | Per-token | GPT-4o, GPT-4.1, o3, o4-mini |
| Azure ML | $0.10-$3.00/node-hour | Depends on compute SKU |
| Purview | $0.25/asset-scan | Classification and governance |
| Azure Monitor | $2.76/GB ingested | Log Analytics |
| Event Hubs | $0.028/throughput-unit/hour | Standard tier |
| ADF pipeline runs | $1.00/1,000 runs | Plus integration runtime hours |
| Key Vault | $0.03/10,000 operations | Secret management |
| Private Endpoints | $0.01/hour per endpoint | Plus data processing |

---

## Scenario-based cost comparison

### Scenario 1: Small federal tenant

**Profile:** 50 analytic users, 5 TB hot data, 20 TB warm data, 20 BigQuery scheduled queries, 1 Dataproc cluster, 1 Looker instance, minimal AI.

| Component | GCP annual | Azure annual |
|---|---|---|
| BigQuery compute | Standard Edition 100 slots = **$350K** | Fabric F32 = **$200K** |
| BigQuery storage | 25 TB = **$6K** | ADLS Gen2 25 TB = **$5K** |
| Dataproc | 1 cluster (4 workers) = **$80K** | Databricks (included in above or small cluster) = **$50K** |
| GCS / ADLS | 20 TB warm = **$2K** | 20 TB cool = **$2K** |
| Looker / Power BI | 30 viewers + 20 devs @ avg $5K = **$250K** | 50 Power BI Pro = **$6K** |
| Orchestration | Cloud Composer small = **$5K** | ADF = **$10K** |
| AI/ML | Vertex AI minimal = **$25K** | Azure OpenAI = **$15K** |
| Governance | Data Catalog = **$5K** | Purview = **$20K** |
| Monitoring | Cloud Monitoring = **$10K** | Azure Monitor = **$25K** |
| **Annual total** | **$733K** | **$333K** |
| **3-year total** | **$2.2M** | **$1.0M** |
| **Savings** | -- | **55% reduction** |

### Scenario 2: Mid-sized federal tenant

**Profile:** 500 analytic users, 50 TB hot data, 200 TB warm data, 200 scheduled queries, 5 Dataproc clusters, 3 Looker instances, moderate AI.

| Component | GCP annual | Azure annual |
|---|---|---|
| BigQuery compute | Enterprise 500 slots = **$1.3M** | Databricks SQL + Jobs = **$900K** |
| BigQuery storage | 250 TB = **$48K** | ADLS Gen2 = **$40K** |
| Dataproc | 5 clusters = **$400K** | Databricks (included above) | 
| GCS / ADLS | 200 TB mixed = **$15K** | 200 TB mixed = **$12K** |
| Looker / Power BI | 400 viewers + 100 devs = **$2.0M** | Fabric F64 (includes PBI) = **$500K** |
| Orchestration | 3 Composer envs = **$15K** | ADF + dbt = **$50K** |
| AI/ML | Vertex AI moderate = **$200K** | Azure OpenAI + AI Foundry = **$150K** |
| Governance | Data Catalog + DLP = **$30K** | Purview = **$75K** |
| Monitoring | Cloud Monitoring = **$40K** | Azure Monitor = **$100K** |
| Networking | VPC SC + Private Google Access = **$30K** | Private Endpoints + NSGs = **$50K** |
| **Annual total** | **$4.1M** | **$1.9M** |
| **3-year total** | **$12.3M** | **$5.7M** |
| **Savings** | -- | **54% reduction** |

!!! note
    GCP costs assume negotiated volume discounts on Looker seats (20-30% discount). Without discounts, Looker costs would be 25-40% higher. Azure Databricks costs assume 30% reserved-capacity discount.

### Scenario 3: Large federal tenant

**Profile:** 2,000 analytic users, 200 TB hot data, 1 PB warm data, 1,000+ scheduled queries, 15 Dataproc clusters, 5 Looker instances, heavy AI, multi-region.

| Component | GCP annual | Azure annual |
|---|---|---|
| BigQuery compute | Enterprise Plus 2,000 slots = **$3.5M** | Databricks SQL + Jobs = **$1.3M** |
| BigQuery storage | 1.2 PB = **$180K** | ADLS Gen2 = **$150K** |
| Dataproc | 15 clusters = **$1.2M** | Databricks (included above) |
| GCS / ADLS | 1 PB mixed = **$60K** | 1 PB mixed = **$50K** |
| Looker / Power BI | 1,500 viewers + 500 devs = **$5.5M** | Fabric F128 x2 = **$2.4M** |
| Orchestration | 10 Composer envs = **$50K** | ADF + dbt = **$100K** |
| AI/ML | Vertex AI heavy = **$600K** | Azure OpenAI + AI Foundry + ML = **$500K** |
| Governance | Data Catalog + DLP = **$80K** | Purview = **$150K** |
| Monitoring | Cloud Monitoring = **$80K** | Azure Monitor = **$200K** |
| Networking | VPC SC + multi-region = **$100K** | Private Endpoints + multi-region = **$150K** |
| **Annual total** | **$11.4M** | **$5.0M** |
| **5-year total** | **$57.0M** | **$25.0M** |
| **Savings** | -- | **56% reduction** |

---

## BigQuery slot commitments vs Fabric capacity reservations

Both platforms offer committed pricing for better unit economics. The structures differ in important ways:

| Dimension | BigQuery Editions | Fabric capacity |
|---|---|---|
| Unit | Slots (concurrent query processing units) | Capacity Units (CUs) |
| Commitment | 1-year or 3-year auto-renew | 1-year reservation (30-50% savings) |
| Scope | Query compute only | Warehouse + lakehouse + notebooks + pipelines + Power BI |
| Burst | On-demand overflow at higher rate | Smoothing over time; burst within capacity |
| Scaling | Must purchase more slot commitments | Scale up/down capacity SKU |
| Users included | N/A (storage + query; BI is separate Looker cost) | Unlimited users within the capacity |
| Power BI / BI | Separate Looker license | Included in Fabric capacity |

**Key insight:** Fabric capacity is a **superset** -- it covers compute, storage interface, and BI in a single SKU. BigQuery slots cover only query compute; you still need separate Looker licenses, Dataproc costs, and Composer costs.

---

## Hidden cost analysis

### Costs often underestimated in GCP analytics

#### 1. Looker licensing at scale

Looker's per-seat model is the single largest hidden cost for organizations that want to democratize analytics. A mid-sized federal tenant with 500 users easily spends $2M-$3M/year on Looker alone. Adding 200 casual viewers adds $600K-$1M/year. Power BI on a Fabric capacity serves those 200 viewers for **$0 additional**.

#### 2. BigQuery data scanning costs (on-demand)

On-demand pricing ($6.25/TB) is simple but dangerous at scale. A poorly written query scanning 10 TB costs $62.50. Run that query 100 times during development and the cost is $6,250 for a single query during a single sprint. Editions mitigate this but require commitment.

#### 3. GCP-to-Azure egress during migration

Transferring data from GCS or BigQuery to Azure incurs GCP egress charges. At $0.08-$0.12/GB:

- 50 TB migration = $4,000-$6,000
- 200 TB migration = $16,000-$24,000
- 1 PB migration = $80,000-$120,000

**Mitigation:** OneLake shortcuts to GCS avoid egress during the bridge phase by reading in place. Budget final-move egress separately.

#### 4. BigQuery export costs

`EXPORT DATA` from BigQuery to GCS is free for the export itself, but the subsequent transfer from GCS to Azure incurs egress. BigQuery-to-BigQuery cross-region also incurs costs.

#### 5. Dataproc idle cluster costs

Dataproc clusters bill for VMs even when idle. Without aggressive auto-scaling policies and stop/start automation, idle clusters accumulate cost. Databricks Serverless SQL and auto-terminating clusters eliminate this class of waste.

#### 6. Cloud Composer overhead

Cloud Composer environments have a base cost regardless of DAG activity. Small environments cost $300-$500/month. Organizations often run multiple environments (dev, staging, prod) at $1,000-$1,500/month combined before running a single pipeline.

### Costs often underestimated in Azure migrations

#### 1. Migration professional services

The initial migration from GCP to Azure requires professional services for SQL dialect conversion, pipeline re-creation, LookML-to-DAX translation, and IAM mapping. Budget **$300K-$1.5M** depending on estate size over a 26-34 week timeline.

#### 2. Azure Government pricing premium

Azure Government pricing is typically 30-40% higher than commercial Azure. All Azure costs in this analysis reflect Government pricing where applicable.

#### 3. Log Analytics ingestion costs

Azure Monitor Log Analytics charges per GB ingested. Verbose diagnostic logging across Databricks, ADF, and Fabric can generate significant volume. Tune retention and sampling per compliance requirement, not defaults.

#### 4. Fabric capacity right-sizing

Under-sizing Fabric capacity creates throttling. Over-sizing wastes budget. Start conservative and right-size quarterly using `docs/COST_MANAGEMENT.md` guidance.

---

## 5-year TCO projection (mid-sized federal tenant)

```mermaid
xychart-beta
    title "5-Year Cumulative TCO (Mid-Sized Federal Tenant, 500 Users)"
    x-axis ["Year 1", "Year 2", "Year 3", "Year 4", "Year 5"]
    y-axis "Cumulative Cost ($M)" 0 --> 25
    bar [4.1, 8.2, 12.3, 16.4, 20.5] "GCP"
    bar [2.9, 4.8, 6.7, 8.6, 10.5] "Azure (incl. migration)"
```

| Year | GCP cumulative | Azure cumulative | Azure includes |
|---|---|---|---|
| Year 1 | $4.1M | $2.9M | Migration services ($1.0M) + Azure run ($1.9M) |
| Year 2 | $8.2M | $4.8M | Azure run ($1.9M) -- costs stabilize |
| Year 3 | $12.3M | $6.7M | Azure run ($1.9M) |
| Year 4 | $16.4M | $8.6M | Azure run ($1.9M) |
| Year 5 | $20.5M | $10.5M | Azure run ($1.9M) |
| **5-year savings** | -- | **$10.0M (49%)** | Includes full migration cost in Year 1 |

**Key insight:** Even including the migration cost in Year 1, Azure breaks even by month 7 and delivers compounding savings thereafter. By Year 5, cumulative savings exceed two full years of GCP spend.

---

## Cost optimization strategies for Azure

### Immediate savings

1. **Use Fabric capacity instead of separate Power BI Premium** -- Fabric F64 includes Power BI capacity for unlimited users
2. **Implement auto-pause on Databricks clusters** -- Clusters should spin down after 15 minutes of inactivity
3. **Use ADLS lifecycle management** -- Move cold data to cool/archive tiers automatically
4. **Right-size Fabric capacity** -- Start with F32, scale up based on measured demand
5. **Use Azure Reserved Instances** -- 1-year or 3-year reservations save 30-50% on committed compute

### Medium-term optimization

1. **Implement Direct Lake semantic models** -- Eliminates data-copy costs from import mode
2. **Use dbt incremental models** -- Process only changed data instead of full refresh
3. **Tune Log Analytics retention** -- Retain only what compliance requires
4. **Implement the CSA-in-a-Box teardown scripts** -- Kill dev/test environments overnight and weekends
5. **Use Azure Spot instances for batch** -- Save up to 90% on non-critical workloads

### Long-term strategy

1. **Consolidate on Fabric** -- As Government region availability expands, reduce Databricks footprint
2. **Implement FinOps** -- Regular cost reviews, tagging, budgets, and alerts
3. **Leverage Azure Hybrid Benefit** -- Apply existing Windows Server / SQL Server licenses
4. **Track cost-per-data-product** -- Identify optimization targets per domain

---

## Federal procurement considerations

### GCP procurement path

- Direct contract with Google Cloud or through reseller
- Available on GSA Schedule and some agency vehicles
- Looker licensing adds a separate line item (or bundled)
- Multi-year Edition commitments lock in pricing but reduce flexibility

### Azure procurement path

- Microsoft Enterprise Agreement (EA), CSP, or GSA Schedule
- Azure Government through separate enrollment
- Partner ecosystem enables competitive system integrator selection
- CSA-in-a-Box is open-source (MIT license) -- no additional software cost

### Budget structure impact

- GCP: Mix of fixed (Edition commitments, Looker seats) and variable (on-demand, storage)
- Azure: Predominantly consumption-based with optional reservations for better economics
- Migration: One-time cost, CapEx or OpEx depending on funding source
- Partner services: Competitive bidding reduces cost vs single-vendor lock-in

---

## Summary

| Metric | GCP analytics | Azure |
|---|---|---|
| Pricing model | Slots + per-seat BI + per-service compute | Capacity-based (Fabric) + consumption |
| Primary cost driver | User count (Looker) + query volume (BigQuery) | Workload intensity |
| Typical annual (500 users) | $3.5M-$5.0M | $1.7M-$3.0M |
| 5-year TCO (500 users) | $17.5M-$25.0M | $10M-$16M |
| Cost to add 100 BI viewers | $300K-$500K/year (Looker) | $0 (within existing Fabric capacity) |
| Cost to exit | Egress + format conversion + weeks-months | Minimal (open Delta Lake format) |
| BI licensing model | Per-seat (Looker) | Per-capacity (Power BI in Fabric) or $10/user/mo |

---

**Last updated:** 2026-04-30
**Maintainers:** CSA-in-a-Box core team
**Related:** [Why Azure over GCP](why-azure-over-gcp.md) | [Complete Feature Mapping](feature-mapping-complete.md) | [Migration Playbook](../gcp-to-azure.md)
