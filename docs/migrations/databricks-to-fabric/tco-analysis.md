# TCO Analysis — Databricks vs Microsoft Fabric

**Status:** Authored 2026-04-30
**Audience:** Finance, platform engineering, and architecture teams building a business case for Databricks-to-Fabric migration.
**Scope:** Total Cost of Ownership comparison covering compute, storage, BI licensing, reserved capacity, and operational overhead for both platforms.

---

## 1. Overview

This document provides a structured framework for comparing Databricks and Fabric costs. It is not a pricing calculator -- Azure pricing changes frequently and varies by region, contract type (EA, CSP, pay-as-you-go), and negotiated discounts. Instead, it provides the **categories, formulas, and worked examples** you need to build your own TCO model.

> **Pricing disclaimer:** All figures are approximate, based on publicly available Azure pricing as of April 2026. Your actual costs depend on your Enterprise Agreement, region, reserved capacity commitments, and negotiated discounts. Always validate against your Azure pricing sheet.

---

## 2. Databricks cost structure

### 2.1 DBU pricing tiers

Databricks bills by **Databricks Unit (DBU)** -- a normalized unit of compute. Different workload types have different per-DBU rates:

| SKU                        | Per-DBU rate (Azure PAYG, approx.) | Typical use                     | Notes                                       |
| -------------------------- | ---------------------------------- | ------------------------------- | ------------------------------------------- |
| Jobs Compute               | $0.15                              | Scheduled ETL, batch pipelines  | Most cost-effective for production          |
| Jobs Light Compute         | $0.07                              | Lightweight orchestration       | Limited features                            |
| All-Purpose Compute        | $0.40                              | Interactive notebooks, dev/test | Expensive for production use                |
| DBSQL Classic              | $0.22                              | BI SQL queries, Power BI        | Being deprecated in favor of Pro/Serverless |
| DBSQL Pro                  | $0.55                              | Advanced BI SQL features        | Row/column-level security, tags             |
| DBSQL Serverless           | $0.70                              | Serverless SQL warehouse        | Auto-scaling, instant start                 |
| Delta Live Tables Core     | $0.20                              | Basic streaming pipelines       | No expectations/quality rules               |
| Delta Live Tables Pro      | $0.25                              | DLT with expectations           | Quality enforcement                         |
| Delta Live Tables Advanced | $0.36                              | DLT with change data capture    | CDC, enhanced monitoring                    |

### 2.2 Infrastructure costs (in addition to DBUs)

DBU charges do **not** include the underlying Azure VMs. Total Databricks cost = DBUs + VM cost + storage + networking:

| Component                | Typical cost range        | Notes                                       |
| ------------------------ | ------------------------- | ------------------------------------------- |
| Azure VMs (worker nodes) | $0.05-$4.00/hr per node   | Depends on VM family; spot saves 60-80%     |
| Azure VMs (driver node)  | Same as worker            | Always on during cluster lifetime           |
| ADLS Gen2 storage        | $0.018/GB/month (Hot)     | Delta tables, logs, checkpoints             |
| ADLS transactions        | $0.005 per 10K operations | Can be significant for small-file workloads |
| DBFS root storage        | Included in workspace     | Managed, limited size                       |
| Networking (egress)      | $0.087/GB (inter-region)  | Cross-region or cross-cloud adds up         |
| Unity Catalog            | Included                  | No separate charge                          |
| Databricks Workspace     | Included in DBU pricing   | No separate platform fee                    |

### 2.3 Power BI costs on Databricks

When Databricks powers Power BI, you pay for both:

| Component                     | Cost                            | Notes                             |
| ----------------------------- | ------------------------------- | --------------------------------- |
| DBSQL warehouse (running)     | DBU rate x cluster size x hours | Must be running for PBI queries   |
| Power BI Pro                  | $10/user/month                  | Per-user BI license               |
| Power BI Premium Per Capacity | $4,995/month (P1)               | Needed for large semantic models  |
| Power BI Premium Per User     | $20/user/month                  | Alternative to per-capacity       |
| Scheduled refresh compute     | DBU cost during refresh         | Import models refresh on schedule |

**Key insight:** On Databricks, the DBSQL warehouse must be running whenever a Power BI user opens a DirectQuery report. This creates a "BI tax" on Databricks compute that does not exist in Fabric.

### 2.4 Typical Databricks monthly cost (mid-size team)

| Line item                                | Estimate           |
| ---------------------------------------- | ------------------ |
| Jobs Compute (batch ETL, 200K DBU/month) | $30,000            |
| All-Purpose Compute (dev, 50K DBU/month) | $20,000            |
| DBSQL Pro (BI queries, 30K DBU/month)    | $16,500            |
| Azure VMs (cluster infrastructure)       | $15,000            |
| ADLS Gen2 storage (10 TB)                | $180               |
| Power BI Premium (P1)                    | $4,995             |
| Power BI Pro (50 users)                  | $500               |
| **Total**                                | **~$87,175/month** |

---

## 3. Fabric cost structure

### 3.1 Fabric Capacity Units (CU)

Fabric uses a single billing meter: **Capacity Units (CU)**. All workloads consume from the same pool:

| Fabric SKU | CUs   | Approximate monthly cost (PAYG) | Approximate monthly cost (1-yr reserved) |
| ---------- | ----- | ------------------------------- | ---------------------------------------- |
| F2         | 2     | $262                            | $188                                     |
| F4         | 4     | $524                            | $377                                     |
| F8         | 8     | $1,049                          | $755                                     |
| F16        | 16    | $2,098                          | $1,510                                   |
| F32        | 32    | $4,195                          | $3,020                                   |
| F64        | 64    | $8,390                          | $6,041                                   |
| F128       | 128   | $16,780                         | $12,082                                  |
| F256       | 256   | $33,561                         | $24,164                                  |
| F512       | 512   | $67,122                         | $48,328                                  |
| F1024      | 1,024 | $134,243                        | $96,655                                  |
| F2048      | 2,048 | $268,487                        | $193,311                                 |

### 3.2 What is included in Fabric CU

| Capability                       | Included? | Notes                                                    |
| -------------------------------- | --------- | -------------------------------------------------------- |
| Spark compute (notebooks, jobs)  | Yes       | Consumes CU                                              |
| SQL endpoint (Lakehouse)         | Yes       | Always-on within capacity                                |
| Power BI semantic models         | Yes       | No separate PBI Premium needed (F64+)                    |
| Power BI report rendering        | Yes       | Consumes CU                                              |
| Data Pipelines (ADF v2)          | Yes       | Consumes CU for activities                               |
| Real-Time Intelligence           | Yes       | Eventhouse, KQL                                          |
| OneLake storage (up to included) | Partially | Included storage varies by SKU; overage at OneLake rates |
| Dataflows Gen2                   | Yes       | Consumes CU                                              |
| Data Activator                   | Yes       | Event-driven triggers                                    |

### 3.3 Smoothing -- 24-hour capacity averaging

Fabric does not charge per-second peak. Instead, CU consumption is averaged over a **24-hour rolling window**. A workload that spikes to 64 CU for 1 hour but idles for 23 hours consumes an average of ~2.67 CU -- meaning an F4 capacity could handle it.

This is fundamentally different from Databricks, where you pay for every DBU consumed at peak. Smoothing benefits spiky workloads (batch jobs, report refreshes, ad-hoc queries) significantly.

### 3.4 OneLake storage costs

| Storage tier               | Cost per GB/month       | Notes                          |
| -------------------------- | ----------------------- | ------------------------------ |
| OneLake (active)           | $0.023                  | Comparable to ADLS Hot         |
| OneLake (shortcut to ADLS) | $0.00 (storage at ADLS) | Only ADLS storage cost applies |
| OneLake (shortcut to S3)   | $0.00 (storage at S3)   | Only S3 storage cost + egress  |

**Key insight:** OneLake shortcuts avoid data duplication. If your Delta tables already live in ADLS, shortcutting them into OneLake costs nothing for storage -- you keep paying ADLS rates.

### 3.5 Power BI on Fabric

On F64 and above, Power BI Premium features are **included** in the Fabric capacity:

| Feature                       | Fabric F64+                       | Standalone PBI Premium |
| ----------------------------- | --------------------------------- | ---------------------- |
| Unlimited PBI viewers         | Included                          | $4,995/month (P1)      |
| Large semantic models (>1 GB) | Included                          | P1 required            |
| Paginated reports             | Included                          | P1 required            |
| Deployment pipelines          | Included                          | P1 required            |
| XMLA endpoint                 | Included                          | P1 required            |
| Per-user PBI Pro license      | Still needed for content creators | $10/user/month         |

For organizations on F64+, the Power BI Premium license ($4,995/month for P1) is **eliminated** -- a direct cost saving.

---

## 4. Worked example: mid-size analytics team

### 4.1 Scenario

- 10 data engineers, 5 data analysts, 50 BI consumers
- 200K DBU/month of batch ETL
- 50K DBU/month of interactive notebook development
- 30K DBU/month of DBSQL for Power BI
- 10 TB of Delta tables in ADLS
- 8 Power BI semantic models (4 Import, 4 DirectQuery to DBSQL)
- Power BI Premium P1 for enterprise deployment

### 4.2 Current Databricks cost

| Component                        | Monthly cost      |
| -------------------------------- | ----------------- |
| Jobs Compute (200K DBU x $0.15)  | $30,000           |
| All-Purpose (50K DBU x $0.40)    | $20,000           |
| DBSQL Pro (30K DBU x $0.55)      | $16,500           |
| Azure VMs (estimated)            | $15,000           |
| ADLS storage (10 TB)             | $180              |
| Power BI Premium P1              | $4,995            |
| Power BI Pro (15 creators x $10) | $150              |
| **Total**                        | **$86,825/month** |

### 4.3 Fabric cost (full migration)

| Component                                 | Monthly cost      |
| ----------------------------------------- | ----------------- |
| Fabric F128 (1-year reserved)             | $12,082           |
| OneLake storage (10 TB, shortcut to ADLS) | $180 (ADLS cost)  |
| Power BI Pro (15 creators x $10)          | $150              |
| **Total**                                 | **$12,412/month** |

### 4.4 Fabric cost (hybrid -- Databricks keeps ML/heavy ETL)

| Component                                     | Monthly cost      |
| --------------------------------------------- | ----------------- |
| Databricks Jobs Compute (150K DBU -- reduced) | $22,500           |
| Azure VMs (reduced cluster footprint)         | $10,000           |
| Fabric F64 (1-year reserved, for BI + ad-hoc) | $6,041            |
| OneLake storage (shortcuts, no duplication)   | $180              |
| Power BI Pro (15 creators x $10)              | $150              |
| **Total**                                     | **$38,871/month** |

### 4.5 Savings summary

| Scenario                   | Monthly cost | vs current | Annual savings |
| -------------------------- | ------------ | ---------- | -------------- |
| Current (Databricks + PBI) | $86,825      | --         | --             |
| Full Fabric migration      | $12,412      | -86%       | $893,000       |
| Hybrid (DBR + Fabric)      | $38,871      | -55%       | $575,000       |

> **Caveat:** The full migration assumes all Spark workloads fit within F128 capacity with smoothing. Validate with a Fabric capacity trial before committing. Photon-dependent workloads may require larger capacity or may not perform equivalently.

---

## 5. Cost optimization strategies

### 5.1 Fabric-specific

| Strategy                        | Savings potential      | Notes                                            |
| ------------------------------- | ---------------------- | ------------------------------------------------ |
| Reserved capacity (1-year)      | 20-28%                 | Commit to a base SKU; burst with PAYG            |
| Reserved capacity (3-year)      | 30-40%                 | Best for stable workloads                        |
| Capacity pause/resume           | Variable               | Pause dev/test capacities overnight and weekends |
| Smoothing optimization          | Significant            | Schedule batch jobs to spread across 24 hours    |
| OneLake shortcuts               | Avoid duplication      | No storage cost for shortcutted data             |
| Direct Lake (no Import refresh) | Eliminate refresh cost | No scheduled refresh compute                     |

### 5.2 Databricks-specific (for hybrid)

| Strategy                      | Savings potential | Notes                                   |
| ----------------------------- | ----------------- | --------------------------------------- |
| Spot instances                | 60-80% on VMs     | Use for worker nodes (not driver)       |
| Auto-termination              | Variable          | Terminate idle clusters after 10-15 min |
| Jobs Compute over All-Purpose | 60% on DBU rate   | Convert interactive notebooks to jobs   |
| Serverless SQL (for spiky BI) | Variable          | No idle cluster cost                    |
| Photon (for eligible queries) | Fewer DBUs needed | 2-5x faster = fewer DBU consumed        |

---

## 6. Hidden costs to factor in

### 6.1 Migration costs (one-time)

| Cost category            | Estimate                    | Notes                            |
| ------------------------ | --------------------------- | -------------------------------- |
| Assessment and planning  | 2-4 weeks of architect time | Inventory, mapping, sizing       |
| Notebook conversion      | 1-5 days per notebook       | Depends on complexity            |
| Pipeline migration       | 2-10 days per DLT pipeline  | DLT to Fabric Pipelines + dbt    |
| Semantic model migration | 1-3 days per model          | Import to Direct Lake conversion |
| Testing and validation   | 2-4 weeks per wave          | Parallel run, reconciliation     |
| Training                 | 1-2 weeks per team          | Fabric Spark, SQL, Power BI      |

### 6.2 Ongoing operational costs

| Category            | Databricks               | Fabric                      | Notes                         |
| ------------------- | ------------------------ | --------------------------- | ----------------------------- |
| Platform team FTE   | 1-2 (cluster management) | 0.5-1 (capacity management) | Fabric has less knob-turning  |
| Monitoring tools    | Ganglia, Datadog, custom | Azure Monitor (included)    | Fabric monitoring is built in |
| Security tooling    | Unity Catalog + Purview  | Workspace roles + Purview   | Similar effort                |
| Upgrade maintenance | Runtime version upgrades | Microsoft-managed           | Fabric auto-updates           |

---

## 7. Building your own TCO model

### Step 1: Inventory current Databricks spend

```sql
-- Run in Databricks SQL to get DBU consumption by SKU
SELECT
    sku_name,
    usage_date,
    SUM(usage_quantity) AS total_dbus,
    SUM(usage_quantity * list_price) AS estimated_cost
FROM system.billing.usage
WHERE usage_date >= DATEADD(MONTH, -3, CURRENT_DATE())
GROUP BY sku_name, usage_date
ORDER BY usage_date, sku_name
```

### Step 2: Map to Fabric capacity

Use Microsoft's Fabric Capacity Metrics app (available in AppSource) during a trial to measure actual CU consumption for representative workloads. Key metrics:

- **CU seconds per Spark job** -- compare to DBU consumption for the same job
- **CU seconds per SQL query** -- compare to DBSQL DBU for the same query
- **Background CU** -- Power BI cache, metadata operations

### Step 3: Apply smoothing

Calculate your 24-hour average CU consumption, not peak. If your batch jobs run for 4 hours at 128 CU and idle for 20 hours, the smoothed consumption is:

```
Smoothed CU = (128 CU * 4 hours + 0 CU * 20 hours) / 24 hours = 21.3 CU
```

An F32 capacity would handle this, not F128.

### Step 4: Add Power BI savings

If you are currently paying for Power BI Premium, add that to the savings column if moving to F64+ (where Premium is included).

### Step 5: Factor in reserved capacity

Apply the reserved capacity discount to your base capacity SKU. Use PAYG for burst/overage.

---

## 8. When the math does not favor Fabric

- **GPU-heavy workloads:** Databricks GPU cluster costs are high, but Fabric has no GPU Spark option. Azure ML compute adds a separate billing line.
- **Photon-dependent queries:** If Photon makes a 4-hour job run in 1 hour, the DBU savings from Photon may be cheaper than running the same job on Fabric Spark for 3-4 hours at CU rates.
- **Very small workloads:** For teams spending <$500/month on Databricks, the minimum Fabric capacity (F2 at ~$260/month) may not save money, especially if Power BI Premium is not needed.
- **Multi-cloud:** If you need the same workloads on AWS and Azure, maintaining Fabric adds a second platform rather than consolidating.

---

## Related

- [Why Fabric over Databricks](why-fabric-over-databricks.md) -- strategic analysis
- [Benchmarks](benchmarks.md) -- performance comparisons
- [Best Practices](best-practices.md) -- capacity planning guidance
- [Feature Mapping](feature-mapping-complete.md) -- feature-by-feature equivalents
- [Parent guide: 5-phase migration](../databricks-to-fabric.md)
- Microsoft Fabric pricing: <https://azure.microsoft.com/pricing/details/microsoft-fabric/>
- Databricks pricing: <https://www.databricks.com/product/pricing>

---

**Maintainers:** csa-inabox core team
**Source finding:** CSA-0083 (HIGH, XL) -- approved via AQ-0010 ballot B6
**Last updated:** 2026-04-30
