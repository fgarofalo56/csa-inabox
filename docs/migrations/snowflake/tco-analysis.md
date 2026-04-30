# Snowflake-to-Azure TCO Analysis

**Status:** Authored 2026-04-30
**Audience:** CFO, CIO, acquisition officers, program managers evaluating total cost of ownership
**Disclaimer:** All figures are illustrative based on publicly available list pricing as of April 2026. Negotiate directly with Microsoft and Snowflake for actuals.

---

## 1. Pricing model comparison

### Snowflake credit model

Snowflake bills through a **credit** system. Credits are consumed by compute; storage is billed separately.

| Component            | Pricing unit                            | Typical Gov rate               |
| -------------------- | --------------------------------------- | ------------------------------ |
| Compute (warehouses) | Credits/hour (1 credit = XS warehouse)  | $3.50-$4.50/credit (Gov)       |
| Storage              | $/TB/month                              | $40-$46/TB/month (Gov)         |
| Snowpipe             | Credits per file notification + compute | Variable                       |
| Cortex (LLM)         | Credits per 1M tokens (varies by model) | $2-$10/credit equivalent       |
| Reader accounts      | Credits consumed by external consumers  | Same rate as warehouse credits |
| Data transfer        | $/GB egress                             | $0.08-$0.12/GB                 |

**Key characteristics:**

- Minimum 60-second billing per query (even for sub-second queries)
- Credit commits may be required for Gov pricing tiers
- Auto-suspend minimum is 60 seconds (warehouses burn credits while warming)
- Multi-cluster warehouses multiply credit consumption linearly
- Cortex credits are on top of warehouse credits

### Azure consumption model

Azure bills per-service with consumption-based pricing:

| Component                      | Pricing unit               | Typical Gov rate                      |
| ------------------------------ | -------------------------- | ------------------------------------- |
| Databricks SQL Warehouse       | DBU/hour                   | $0.22-$0.55/DBU (Gov, varies by tier) |
| Fabric capacity                | CU/hour (F2 through F2048) | $0.18-$0.36/CU/hour (Gov)             |
| Azure OpenAI (GPT-4o)          | $/1K tokens                | $0.005-$0.015/1K tokens               |
| Azure AI Search                | $/unit/hour + $/document   | $0.25-$2.50/hour per unit             |
| Storage (ADLS Gen2)            | $/GB/month                 | $0.019-$0.046/GB/month                |
| Event Hubs                     | $/throughput unit/hour     | $0.028/TU/hour                        |
| Power BI (via Fabric capacity) | Included in Fabric CU      | $0 incremental                        |

**Key characteristics:**

- Auto-stop at 1 minute (classic) or 10 minutes (serverless)
- Scale-to-zero for dev/test (Fabric capacity can be paused)
- Reserved capacity discounts: 25-40% on 1-year or 3-year commits
- No per-seat licensing when using Fabric capacity for Power BI
- `scripts/deploy/teardown-platform.sh` provides hard cost kill-switch

---

## 2. Warehouse tier mapping and cost translation

This table maps Snowflake warehouse sizes to Azure equivalents with hourly cost comparison.

| Snowflake size | Credits/hr | Snowflake $/hr (Gov) | Databricks SQL size | DBU/hr | Databricks $/hr (Gov) | Delta |
| -------------- | ---------- | -------------------- | ------------------- | ------ | --------------------- | ----- |
| X-Small        | 1          | $4.00                | 2X-Small            | 4      | $1.76                 | -56%  |
| Small          | 2          | $8.00                | X-Small             | 6      | $2.64                 | -67%  |
| Medium         | 4          | $16.00               | Small               | 12     | $5.28                 | -67%  |
| Large          | 8          | $32.00               | Medium              | 24     | $10.56                | -67%  |
| X-Large        | 16         | $64.00               | Large               | 40     | $17.60                | -73%  |
| 2X-Large       | 32         | $128.00              | X-Large             | 80     | $35.20                | -73%  |
| 3X-Large       | 64         | $256.00              | 2X-Large            | 144    | $63.36                | -75%  |
| 4X-Large       | 128        | $512.00              | 3X-Large            | 240    | $105.60               | -79%  |

**Notes:**

- Databricks serverless SQL is typically 20-30% more expensive per DBU but spins up in under 10 seconds vs 2-30 seconds for Snowflake warm-from-cold
- Reserved Databricks capacity reduces these rates by 25-40%
- The delta narrows when Snowflake credit commits are factored in, but remains 40-60% favorable to Azure at most tiers

### Multi-cluster warehouse translation

Snowflake multi-cluster warehouses multiply credits linearly:

| Snowflake config    | Credits/hr | Azure equivalent                    | Cost/hr (Azure Gov) |
| ------------------- | ---------- | ----------------------------------- | ------------------- |
| Large x 1 cluster   | 8          | Medium SQL Warehouse (auto-scale 1) | $10.56              |
| Large x 3 clusters  | 24         | Medium SQL Warehouse (auto-scale 3) | $31.68              |
| Large x 10 clusters | 80         | Large SQL Warehouse (auto-scale)    | $44.00              |

Databricks auto-scaling is more granular -- it scales by individual nodes rather than full warehouse clones, resulting in better cost efficiency under variable concurrency.

---

## 3. Snowpipe cost translation

### Snowpipe batch ingestion

| Snowflake Snowpipe                                  | Azure Autoloader                        |
| --------------------------------------------------- | --------------------------------------- |
| $0.06/1000 files (notification) + warehouse credits | Included in Databricks jobs cluster DBU |
| Separate compute for continuous loading             | Autoloader runs on existing cluster     |
| Streaming variant requires additional credits       | Structured Streaming on same cluster    |

For a typical ingestion workload (10,000 files/hour, 100 GB/day):

- **Snowflake:** ~$15/hour (Snowpipe notification + XS warehouse)
- **Azure:** ~$5/hour (Autoloader on jobs cluster)

### Snowpipe Streaming translation

| Snowflake Snowpipe Streaming           | Azure Event Hubs + Autoloader       |
| -------------------------------------- | ----------------------------------- |
| Credits per second of active streaming | Event Hubs TU/hour + Autoloader DBU |
| Limited to Snowflake-native consumers  | Event Hubs supports any consumer    |
| Gov: partial availability              | Gov: GA                             |

---

## 4. Cortex AI cost comparison

| Cortex function            | Snowflake cost            | Azure equivalent         | Azure cost            | Delta             |
| -------------------------- | ------------------------- | ------------------------ | --------------------- | ----------------- |
| `COMPLETE` (Llama 3.1 70B) | ~$3.00/credit (1M tokens) | Azure OpenAI GPT-4o-mini | $0.15/1M input tokens | -95%              |
| `COMPLETE` (Mixtral 8x7B)  | ~$2.00/credit (1M tokens) | Azure OpenAI GPT-4o-mini | $0.15/1M input tokens | -93%              |
| `SUMMARIZE`                | ~$2.50/credit             | Azure OpenAI GPT-4o      | $2.50/1M input tokens | Comparable        |
| `TRANSLATE`                | ~$2.00/credit             | Azure AI Translator      | $10/1M characters     | Varies            |
| Cortex Search (per query)  | Credits consumed          | Azure AI Search          | $0.25-$2.50/unit/hr   | Fixed vs variable |
| Cortex Fine-tuning         | Not in Gov                | Azure OpenAI fine-tuning | $0.008/1K tokens      | N/A               |

**Key insight:** Azure OpenAI provides access to GPT-4o and GPT-4.1 models that significantly outperform the models available through Cortex. The cost comparison is less meaningful than the capability comparison -- you get better models at lower cost.

---

## 5. Storage cost comparison

| Storage tier                       | Snowflake Gov                         | Azure Gov (ADLS Gen2)         | Delta      |
| ---------------------------------- | ------------------------------------- | ----------------------------- | ---------- |
| Hot storage (per TB/month)         | $40-$46                               | $19-$23                       | -50%       |
| Time Travel storage (per TB/month) | Same rate                             | Same rate (Delta versioning)  | Comparable |
| Failsafe storage (per TB/month)    | $40-$46 (7 days included)             | GRS replication: $38-$46      | Comparable |
| Long-term archive                  | Not natively supported (unload to S3) | Archive tier: $0.002/GB/month | -95%       |

For a 100 TB tenant:

- **Snowflake:** ~$4,300/month storage
- **Azure ADLS Gen2 (hot):** ~$2,100/month storage
- **Azure (80 TB hot + 20 TB archive):** ~$1,600/month

---

## 6. Three migration scenarios

### Scenario A: Small agency (50 users, 5 TB hot, 10 dbt models)

| Cost category            | Snowflake Gov (annual) | Azure Gov (annual)          | Savings |
| ------------------------ | ---------------------- | --------------------------- | ------- |
| Compute (warehouses)     | $360,000               | $144,000                    | 60%     |
| Storage                  | $26,400                | $13,200                     | 50%     |
| AI (light Cortex usage)  | $24,000                | $12,000                     | 50%     |
| BI (Snowsight + Tableau) | $120,000               | $60,000 (Fabric F64)        | 50%     |
| Governance / security    | Included               | $36,000 (Purview + Monitor) | N/A     |
| **Total**                | **$530,400**           | **$265,200**                | **50%** |

### Scenario B: Mid-sized agency (500 users, 50 TB hot, 100 dbt models)

| Cost category              | Snowflake Gov (annual) | Azure Gov (annual)           | Savings |
| -------------------------- | ---------------------- | ---------------------------- | ------- |
| Compute (warehouses)       | $1,800,000             | $720,000                     | 60%     |
| Storage                    | $264,000               | $132,000                     | 50%     |
| AI (moderate Cortex usage) | $180,000               | $120,000                     | 33%     |
| BI (Snowsight + Tableau)   | $360,000               | $240,000 (Fabric F128)       | 33%     |
| Streaming (Snowpipe)       | $120,000               | $48,000                      | 60%     |
| Governance / security      | Included               | $120,000 (Purview + Monitor) | N/A     |
| **Total**                  | **$2,724,000**         | **$1,380,000**               | **49%** |

### Scenario C: Large agency (2000 users, 200 TB hot, 500 dbt models)

| Cost category                  | Snowflake Gov (annual) | Azure Gov (annual)           | Savings |
| ------------------------------ | ---------------------- | ---------------------------- | ------- |
| Compute (warehouses)           | $7,200,000             | $2,880,000                   | 60%     |
| Storage                        | $1,056,000             | $528,000                     | 50%     |
| AI (heavy Cortex + Search)     | $720,000               | $480,000                     | 33%     |
| BI (Snowsight + Tableau)       | $960,000               | $480,000 (Fabric F256)       | 50%     |
| Streaming (Snowpipe)           | $480,000               | $192,000                     | 60%     |
| Governance / security          | Included               | $360,000 (Purview + Monitor) | N/A     |
| Data Sharing (reader accounts) | $360,000               | $0 (Delta Sharing)           | 100%    |
| **Total**                      | **$10,776,000**        | **$4,920,000**               | **54%** |

---

## 7. Five-year projection

Assuming Scenario B (mid-sized agency) with 15% annual data growth and 10% annual workload growth.

| Year             | Snowflake Gov   | Azure Gov                       | Cumulative savings   |
| ---------------- | --------------- | ------------------------------- | -------------------- |
| Year 1           | $2,724,000      | $1,380,000 + $300,000 migration | $1,044,000           |
| Year 2           | $3,097,000      | $1,545,000                      | $2,596,000           |
| Year 3           | $3,523,000      | $1,726,000                      | $4,393,000           |
| Year 4           | $4,009,000      | $1,929,000                      | $6,473,000           |
| Year 5           | $4,564,000      | $2,158,000                      | $8,879,000           |
| **5-year total** | **$17,917,000** | **$9,038,000**                  | **$8,879,000 (50%)** |

**Migration investment payback:** 4-6 months (Year 1 savings cover migration costs by month 5).

### Projection assumptions

- Snowflake annual price increase: 3% (credit rate escalation in Gov contracts)
- Azure annual price change: 0% (reserved capacity locks in rates)
- Data growth: 15% annually (compounding)
- Workload growth: 10% annually (new models, more users)
- Migration professional services: $300,000 one-time (Year 1)
- No credit for Snowflake contract early-termination costs (varies by contract)

---

## 8. Hidden cost factors

### Costs often missed in Snowflake budgets

1. **Credit overruns** -- warehouses that are not properly auto-suspended burn credits 24/7
2. **Reader account compute** -- data sharing partners consume your credits
3. **Cortex token costs** -- unpredictable and growing as AI adoption increases
4. **Multi-cluster scaling** -- linear credit multiplication under concurrency pressure
5. **Egress during migration** -- extracting data from Snowflake incurs compute + transfer costs
6. **Contract lock-in** -- credit commits may include unused capacity you cannot reclaim
7. **Snowflake-specific tooling** -- SnowSQL, Snowpark development environments, Snowflake-specific dbt adapter maintenance

### Azure cost optimization levers

1. **Reserved capacity** -- 25-40% discount on Databricks and Fabric (1-year or 3-year)
2. **Auto-stop** -- warehouses stop billing within 60 seconds of inactivity
3. **Scale-to-zero** -- Fabric capacity can be paused entirely for dev/test
4. **Teardown script** -- `scripts/deploy/teardown-platform.sh` kills all compute instantly
5. **Spot instances** -- Databricks jobs clusters can use spot VMs for 60-90% savings
6. **Shared capacity** -- Fabric capacity is workspace-level, not per-warehouse
7. **No reader account costs** -- Delta Sharing consumers do not consume your compute
8. **Azure ELA credits** -- many federal agencies have existing Azure Enterprise License Agreements

---

## 9. Cost monitoring and governance

### During migration (parallel-run phase)

Monitor both platforms simultaneously:

| Metric                | Snowflake tool               | Azure tool                               |
| --------------------- | ---------------------------- | ---------------------------------------- |
| Compute spend         | Resource Monitors            | Azure Cost Management budgets            |
| Warehouse utilization | `WAREHOUSE_METERING_HISTORY` | Databricks SQL Warehouse metrics         |
| Query costs           | `QUERY_HISTORY` view         | Databricks query profile + Log Analytics |
| Storage growth        | `STORAGE_USAGE`              | Azure Monitor storage metrics            |
| AI costs              | Cortex usage views           | Azure OpenAI usage dashboard             |

### Post-migration

csa-inabox provides built-in cost governance:

- **Azure Cost Management budgets** with alerts at 50%, 75%, 90% thresholds
- **Databricks SQL warehouse auto-stop** (1-minute default)
- **Teardown script** (`scripts/deploy/teardown-platform.sh`) for hard cost control
- **Tag-based cost allocation** per domain, environment, and data product
- See `docs/COST_MANAGEMENT.md` for the full cost governance framework

---

## 10. Procurement considerations

### Snowflake Gov procurement

- Typically procured through GSA Schedule or BPA
- Credit-commit contracts (usually annual)
- Separate line items for Gov region, Cortex, and add-ons
- Contract flexibility varies by volume

### Azure Gov procurement

- Available through GSA Schedule, BPA, or Azure Enterprise Agreement
- Consumption-based (no mandatory commits for most services)
- Reserved capacity available for predictable workloads
- Microsoft ELA may include Azure credits already allocated
- Unified billing across all Azure services (one vendor, one invoice)

**For federal acquisition officers:** Azure's consumption model aligns better with federal budgeting cycles. You can start with consumption pricing, measure actual usage for 3-6 months, then convert to reserved capacity for the workloads that are predictable.

---

## Related documents

- [Why Azure over Snowflake](why-azure-over-snowflake.md) -- executive summary and strategic rationale
- [Benchmarks](benchmarks.md) -- performance comparison to validate cost-performance ratio
- [Best Practices](best-practices.md) -- cost optimization during and after migration
- [Master playbook](../snowflake.md) -- Section 7 for the original cost comparison
- `docs/COST_MANAGEMENT.md` -- csa-inabox cost governance framework

---

**Last updated:** 2026-04-30
**Maintainers:** CSA-in-a-Box core team
