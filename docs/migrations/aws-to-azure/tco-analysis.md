# Total Cost of Ownership: AWS Analytics vs Azure

**A detailed financial analysis for federal CFOs, CIOs, and procurement officers evaluating the cost implications of migrating from AWS analytics services to Microsoft Azure.**

---

## Executive summary

AWS analytics pricing requires managing five independent cost models across Redshift, EMR, Glue, Athena, and S3. Each service has its own reserved pricing, on-demand rates, and capacity management dimensions. Azure consolidates analytics billing into fewer, simpler dimensions: Databricks DBUs, Fabric Capacity Units, ADF pipeline runs, and ADLS storage. For comparable workloads across three federal tenant sizes, Azure produces 25-50% cost reductions with significantly simpler FinOps operations.

This analysis is honest. AWS reserved pricing, Savings Plans, and Redshift Serverless can narrow the gap significantly when optimized. The savings delta is largest for organizations that are not aggressively optimizing their AWS spend today --- which describes most federal tenants.

---

## AWS analytics pricing model

### Redshift pricing

| Component | Pricing model | Typical cost range |
|---|---|---|
| RA3 nodes (on-demand) | Per-node-hour; ra3.xlplus $1.086/hr, ra3.4xlarge $3.26/hr, ra3.16xlarge $13.04/hr | $9.5K-$114K/node/year |
| RA3 Reserved (1-year) | ~40% discount on on-demand | $5.7K-$68K/node/year |
| RA3 Reserved (3-year) | ~60% discount on on-demand | $3.8K-$46K/node/year |
| Managed storage | $0.024/GB/month | $288/TB/year |
| Redshift Serverless | $0.375/RPU-hour; 8 RPU minimum | Variable; ~$26K/year at 8 RPU sustained |
| Spectrum queries | $5/TB scanned | Variable |
| Concurrency scaling | Free 1hr/day per cluster; $0.25/credit after | Variable |
| Data sharing | Free for producer; consumer pays compute | N/A |

### EMR pricing

| Component | Pricing model | Typical cost range |
|---|---|---|
| EMR on EC2 | EC2 instance cost + EMR surcharge (15-25%) | Varies by instance family |
| EMR Serverless | Per-vCPU-hour ($0.052) + per-GB-memory-hour ($0.0057) + per-GB-storage-hour ($0.000111) | Variable |
| EMR on EKS | EKS cluster cost + EMR per-vCPU-hour | Variable |
| Spot instances | Up to 90% discount on EC2 on-demand | Variable; interruption risk |

### Glue pricing

| Component | Pricing model | Typical cost range |
|---|---|---|
| Glue ETL jobs | $0.44/DPU-hour; 2 DPU minimum for Spark, 0.0625 DPU minimum for Python Shell | Variable |
| Glue Data Catalog | Free for first 1M objects; $1/100K objects/month after | Minimal |
| Glue Crawlers | $0.44/DPU-hour | Variable |
| Glue DataBrew | $1/node-hour | Variable |
| Glue Data Quality | $0.10/evaluation | Variable |

### Athena pricing

| Component | Pricing model | Typical cost range |
|---|---|---|
| SQL queries | $5/TB data scanned | Variable; partition pruning critical |
| Provisioned capacity | $0.50/DPU-hour; 24 DPU minimum | $105K/year at 24 DPU sustained |
| Federated queries | Same per-scan pricing | Variable |

### S3 pricing

| Component | Pricing model | Typical cost range |
|---|---|---|
| Standard storage | $0.023/GB/month | $276/TB/year |
| Infrequent Access | $0.0125/GB/month | $150/TB/year |
| Glacier Instant Retrieval | $0.004/GB/month | $48/TB/year |
| Glacier Deep Archive | $0.00099/GB/month | $12/TB/year |
| PUT/COPY/POST requests | $0.005/1,000 requests | Variable |
| GET requests | $0.0004/1,000 requests | Variable |
| Data transfer out | $0.09/GB (first 10TB), decreasing tiers | $92/TB |
| S3 Select | $0.002/GB scanned, $0.0007/GB returned | Variable |

### QuickSight pricing

| Component | Pricing model | Typical cost range |
|---|---|---|
| Author (annual) | $24/user/month ($18/user/month annual) | $216/user/year |
| Reader (annual) | $5/user/month (max $5/session) | Up to $60/user/year |
| Reader (capacity) | $250/session-pack/month (500 sessions) | Variable |
| SPICE capacity | $0.25/GB/month beyond included | $3/GB/year |
| Q (NL query) | $28/user/month | $336/user/year |

---

## Azure analytics pricing model

### Databricks pricing

| Component | Pricing model | Typical cost range |
|---|---|---|
| SQL Serverless | $0.70/DBU for Azure Gov | Variable; auto-scales to zero |
| SQL Pro | $0.55/DBU for Azure Gov | Sustained warehouse workloads |
| Jobs Compute | $0.40/DBU for Azure Gov | Batch and ETL workloads |
| All Purpose Compute | $0.55/DBU for Azure Gov | Interactive notebooks |
| Photon acceleration | Included in above pricing | 2-8x query speed improvement |
| Unity Catalog | Included | Governance at no additional cost |

### Fabric pricing

| Component | Pricing model | Typical cost range |
|---|---|---|
| F2 capacity | ~$262/month | Dev/test |
| F32 capacity | ~$4,200/month ($50K/year) | Small production |
| F64 capacity | ~$8,400/month ($100K/year) | Medium production |
| F128 capacity | ~$16,800/month ($200K/year) | Large production |
| F256 capacity | ~$33,600/month ($400K/year) | Enterprise production |
| OneLake storage | $0.023/GB/month (hot) | Same as S3 Standard |
| Fabric trial | Free 60-day trial | Evaluation |

### ADF pricing

| Component | Pricing model | Typical cost range |
|---|---|---|
| Orchestration (activity runs) | $1/1,000 runs (cloud) | Minimal for most workloads |
| Data movement | $0.25/DIU-hour | Variable |
| Pipeline execution (SSIS) | $0.84/vCore-hour | Variable |
| Data flows | $0.268/vCore-hour (general), $0.352/vCore-hour (memory-optimized) | Variable |
| Self-hosted IR | Free (software); infrastructure cost only | Variable |

### ADLS Gen2 pricing

| Component | Pricing model | Typical cost range |
|---|---|---|
| Hot storage | $0.0208/GB/month | $250/TB/year |
| Cool storage | $0.01/GB/month | $120/TB/year |
| Archive storage | $0.002/GB/month | $24/TB/year |
| Read operations (hot) | $0.0044/10,000 | Minimal |
| Write operations (hot) | $0.0066/10,000 | Minimal |
| Data transfer out | Varies by region; egress within region free | Variable |

### Power BI pricing

| Component | Pricing model | Typical cost range |
|---|---|---|
| Power BI Pro | $10/user/month | $120/user/year |
| Power BI Premium Per User | $20/user/month | $240/user/year |
| Power BI Embedded (A1-A6) | $735-$47K/month | Variable |
| Included in Fabric | F64+ includes Power BI capacity | $0 incremental |
| Direct Lake | No import cost; reads Delta directly | Eliminates SPICE-equivalent cost |

---

## Scenario-based cost comparison

### Scenario 1: Small federal tenant

**Profile:** 10 analytic users, 1 TB hot data, 5 TB warm/archive, minimal AI, single domain, light ETL.

| Component | AWS cost/year | Azure cost/year |
|---|---|---|
| Warehouse compute | Redshift Serverless (8 RPU avg) = **$26K** | Databricks SQL Serverless = **$18K** |
| ETL compute | Glue (200 DPU-hours/mo) = **$10.6K** | ADF + dbt on Databricks = **$8K** |
| Ad-hoc queries | Athena (500GB/mo scanned) = **$3K** | Included in Databricks SQL | 
| Storage | S3 Standard (1TB) + IA (5TB) = **$1.2K** | ADLS Hot (1TB) + Cool (5TB) = **$0.9K** |
| BI tool | QuickSight (5 authors + 5 readers) = **$2.4K** | Power BI Pro (10 users) = **$1.2K** |
| Catalog/governance | Glue Catalog = **$0.1K** | Purview = **$3K** |
| Monitoring | CloudWatch = **$2K** | Azure Monitor = **$2K** |
| Networking | VPC + NAT Gateway = **$4K** | VNet + Private Endpoints = **$3K** |
| **Annual total** | **$49.3K** | **$36.1K** |
| **3-year total** | **$148K** | **$108K** |
| **5-year total** | **$247K** | **$181K** |
| **Savings** | --- | **27% reduction** |

**Notes:** At small scale, the savings are modest because both platforms have minimum viable costs. The primary benefit at this scale is operational simplicity rather than raw cost savings.

### Scenario 2: Medium federal tenant

**Profile:** 50 analytic users, 10 TB hot data, 50 TB warm/archive, moderate AI usage, 3 domains, daily ETL.

| Component | AWS cost/year | Azure cost/year |
|---|---|---|
| Warehouse compute | Redshift RA3.4xl x2 (reserved 1yr) = **$114K** | Databricks SQL Pro = **$95K** |
| Spark/ETL compute | EMR (m5.2xl x4 cluster, 12hr/day) = **$85K** | Databricks Jobs = **$60K** |
| ETL orchestration | Glue Jobs (2,000 DPU-hours/mo) = **$106K** | ADF orchestration = **$15K** |
| Ad-hoc queries | Athena (5TB/mo scanned) = **$30K** | Included in Databricks SQL |
| Storage | S3 Std (10TB) + IA (50TB) = **$10.3K** | ADLS Hot (10TB) + Cool (50TB) = **$8.5K** |
| BI tool | QuickSight (20 authors + 30 readers at capacity) = **$14K** | Power BI Pro (50 users) = **$6K** |
| AI/ML | SageMaker (training + inference) = **$50K** | Azure OpenAI + ML = **$40K** |
| Catalog/governance | Glue Catalog + Lake Formation = **$5K** | Purview + Unity Catalog = **$25K** |
| Monitoring | CloudWatch + X-Ray = **$15K** | Azure Monitor + Log Analytics = **$12K** |
| Networking | VPC + NAT + PrivateLink = **$18K** | VNet + Private Endpoints = **$12K** |
| Data transfer | Cross-service transfer = **$8K** | Within-region = **$2K** |
| **Annual total** | **$455K** | **$276K** |
| **3-year total** | **$1.37M** | **$827K** |
| **5-year total** | **$2.28M** | **$1.38M** |
| **Savings** | --- | **39% reduction** |

**Notes:** The medium tenant is where consolidation savings become material. Eliminating separate Athena costs, reducing Glue DPU spend, and consolidating monitoring produces consistent savings.

### Scenario 3: Large federal tenant

**Profile:** 200 analytic users, 100 TB hot data, 500 TB warm/archive, heavy AI usage, 8+ domains, complex ETL, real-time streaming.

| Component | AWS cost/year | Azure cost/year |
|---|---|---|
| Warehouse compute | Redshift RA3.16xl x3 (reserved 1yr) = **$612K** | Databricks SQL Pro + Serverless = **$450K** |
| Spark compute | EMR (mixed fleet, 8 clusters) = **$480K** | Databricks Jobs + All Purpose = **$350K** |
| ETL orchestration | Glue Jobs (20K DPU-hours/mo) = **$1.06M** | ADF + dbt orchestration = **$120K** |
| Ad-hoc queries | Athena provisioned (48 DPU) = **$210K** | Included in Databricks SQL |
| Streaming | Kinesis Data Streams + Analytics = **$180K** | Event Hubs + Stream Analytics = **$140K** |
| Storage | S3 multi-tier (100TB hot, 500TB IA/Glacier) = **$60K** | ADLS multi-tier = **$52K** |
| BI tool | QuickSight (50 authors + 150 readers + Q) = **$58K** | Fabric F128 (includes Power BI) = **$200K** |
| AI/ML | SageMaker (large-scale training + Bedrock) = **$500K** | Azure OpenAI + AI Foundry + ML = **$400K** |
| Catalog/governance | Glue Catalog + Lake Formation + CloudTrail = **$35K** | Purview + Unity Catalog = **$80K** |
| Monitoring | CloudWatch + X-Ray + GuardDuty = **$65K** | Azure Monitor + Defender = **$55K** |
| Networking | VPC + NAT + PrivateLink + Transit Gateway = **$95K** | VNet + Private Endpoints + Firewall = **$70K** |
| Data transfer | Cross-service + cross-region = **$45K** | Within-region + cross-region = **$15K** |
| **Annual total** | **$3.41M** | **$1.93M** |
| **3-year total** | **$10.2M** | **$5.79M** |
| **5-year total** | **$17.0M** | **$9.65M** |
| **Savings** | --- | **43% reduction** |

**Notes:** The large tenant shows the largest absolute savings. Glue DPU costs at scale are the single biggest cost driver on AWS; replacing Glue with ADF orchestration + dbt on Databricks produces the largest line-item savings. Fabric capacity at F128 is more expensive than QuickSight at this user count, but includes compute, storage, and BI in a single SKU.

---

## Hidden costs frequently missed

### AWS hidden costs

| Hidden cost | Description | Typical impact |
|---|---|---|
| Multi-service IAM management | Five services with five IAM integration patterns require dedicated security engineering | $50K-$150K/year in labor |
| Cross-service data transfer | Moving data between Redshift, EMR, S3, and Athena incurs transfer costs within region for some patterns | $10K-$50K/year |
| NAT Gateway costs | EMR and Glue in private subnets route through NAT Gateways at $0.045/GB | $20K-$100K/year for data-heavy workloads |
| Glue DPU over-provisioning | Glue jobs default to 10 DPUs; most jobs need 2-4 | 2-5x overspend until optimized |
| Redshift snapshot costs | Automated snapshots beyond retention period and manual snapshots | $5K-$30K/year |
| CloudWatch Logs ingestion | High-volume Spark/EMR logging generates significant log volume | $10K-$50K/year |
| Reserved Instance management | Tracking RI utilization across Redshift + EMR + EC2 requires FinOps tooling | $20K-$50K/year in tooling + labor |
| Athena partition mismanagement | Queries without proper partition pruning scan full datasets | 10-100x cost overrun on individual queries |
| Multi-account governance | Lake Formation + Glue Catalog sharing across AWS accounts requires cross-account IAM | $30K-$80K/year in engineering |

### Azure hidden costs

| Hidden cost | Description | Typical impact |
|---|---|---|
| Fabric capacity right-sizing | Over-provisioned F-SKU wastes capacity; under-provisioned throttles workloads | Requires monitoring first 60 days |
| Databricks DBU spikes | Interactive clusters left running during off-hours | Configure auto-termination; $10K-$50K/year if unmanaged |
| Purview scanning frequency | Frequent full scans on large estates generate cost | Schedule incremental scans; $5K-$20K/year |
| Private Endpoint proliferation | Each private endpoint has a per-hour cost | $3K-$15K/year for large deployments |
| Log Analytics retention | Default 90-day retention; compliance may require longer | $5K-$30K/year for extended retention |
| Egress during migration | Cross-cloud data transfer from S3 to ADLS Gen2 | One-time $50K-$200K depending on volume |

---

## 5-year TCO projection

### Medium tenant (50 users, 10TB) 5-year trajectory

| Year | AWS cumulative | Azure cumulative | Annual delta |
|---|---|---|---|
| Year 0 (migration) | $455K | $376K (includes $100K migration cost) | $79K saved |
| Year 1 | $910K | $652K | $258K saved |
| Year 2 | $1.37M | $927K | $439K saved |
| Year 3 | $1.82M | $1.20M | $617K saved |
| Year 4 | $2.28M | $1.48M | $797K saved |
| Year 5 | $2.73M | $1.76M | **$975K saved** |

**Assumptions:** 10% annual data growth, 5% annual compute growth, AWS pricing held constant (conservative), Azure pricing held constant, migration investment of $100K in Year 0.

**Break-even point:** Month 4-5 after migration completion.

---

## Cost optimization strategies

### On Azure (post-migration)

1. **Right-size Fabric capacity.** Start at F32, monitor CU utilization for 30 days, scale to F64 only if sustained utilization exceeds 70%.
2. **Use Databricks Serverless SQL.** For intermittent query workloads, serverless eliminates idle cluster cost entirely.
3. **Configure auto-termination.** Set 15-minute auto-termination on all interactive Databricks clusters.
4. **Leverage ADLS lifecycle policies.** Move data older than 90 days to cool tier, older than 1 year to archive.
5. **Use Azure Reservations.** 1-year or 3-year reservations for Databricks and Fabric capacity provide 20-40% savings.
6. **Schedule Purview scans.** Use incremental scans rather than full scans for ongoing governance.
7. **Monitor with Cost Management.** Set budget alerts at 80% and 100% of projected monthly spend.
8. **Use teardown scripts.** `scripts/deploy/teardown-platform.sh` (CSA-0011) for dev/workshop environments.

### Optimizing AWS before migration (reduces urgency)

1. **Convert Redshift to Reserved Nodes.** 1-year reserved pricing cuts Redshift cost by 40%.
2. **Right-size Glue DPUs.** Audit every Glue job; most can run at 2-4 DPUs instead of the default 10.
3. **Enable Athena query result reuse.** Reduces per-scan charges for repeated queries.
4. **Evaluate Redshift Serverless.** For intermittent workloads, Serverless may be cheaper than dedicated RA3 nodes.
5. **Audit EMR cluster utilization.** Terminate persistent clusters running below 30% utilization; convert to EMR Serverless.

---

## Procurement considerations for federal

| Factor | AWS | Azure |
|---|---|---|
| Contract vehicle | AWS GovCloud via SEWP, 2GIT, GSA MAS | Azure Government via SEWP, 2GIT, GSA MAS, EA |
| Enterprise Agreement | No AWS EA equivalent; volume discounts via EDP | Microsoft EA provides predictable pricing with annual true-up |
| CSP model | AWS Marketplace resellers | Azure CSP provides managed billing through partners |
| FITARA alignment | Shared services model | Shared services model |
| Spend commitment flexibility | AWS EDP requires upfront commitment | Azure EA allows consumption with commitment discounts |
| FinOps tooling | AWS Cost Explorer, Budgets | Azure Cost Management, Advisor (included) |

---

## Migration cost investment

| Migration phase | Duration | Estimated cost | Notes |
|---|---|---|---|
| Discovery and planning | 3 weeks | $30K-$50K | Inventory, wave plan, architecture decisions |
| Landing zone deployment | 5 weeks | $25K-$50K | CSA-in-a-Box DMLZ/DLZ, bridge configuration |
| Pilot domain migration | 8 weeks | $50K-$100K | First end-to-end domain ported |
| Full migration execution | 20-30 weeks | $150K-$400K | Remaining domains, Redshift, EMR, streaming |
| Decommission and validation | 4 weeks | $20K-$40K | Reconciliation, runbooks, cost baseline |
| **Total migration investment** | **30-40 weeks** | **$275K-$640K** | Recoverable within 6-12 months from run-rate savings |

---

**Last updated:** 2026-04-30
**Maintainers:** CSA-in-a-Box core team
**Related:** [Why Azure over AWS](why-azure-over-aws.md) | [Feature Mapping](feature-mapping-complete.md) | [Migration Playbook](../aws-to-azure.md) | [Cost Management Guide](../../COST_MANAGEMENT.md)
