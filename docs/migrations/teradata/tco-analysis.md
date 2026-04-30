# TCO Analysis — Teradata vs Azure

> **Audience:** Finance leads, CIOs, and enterprise architects building the business case for Teradata-to-Azure migration. All numbers are representative ranges based on typical enterprise deployments; adjust to your actual contracts and environment.

---

## 1. Executive summary

A typical medium-size Teradata deployment (10-20 nodes, 100-300 TB) costs **$3M-$7M/year** fully loaded (license, hardware, datacenter, DBA team, tools). The equivalent Azure deployment at steady state costs **$1.2M-$2.5M/year** — a **50-65% reduction**.

The migration itself costs **$3M-$10M** over 18-24 months (tooling, migration team, dual-run period). At steady state, the investment pays back in **2-3 years** and delivers **$8M-$20M cumulative savings** over five years.

VantageCloud (Teradata's cloud offering) reduces hardware/DC costs but retains Teradata license premiums, landing at **$2.5M-$5M/year** — better than on-prem but still 2-3x Azure steady-state costs.

---

## 2. On-premises Teradata cost model

### 2.1 Hardware and datacenter

| Cost category | Small (1-5 nodes) | Medium (10-20 nodes) | Large (30-50+ nodes) |
| --- | --- | --- | --- |
| Appliance purchase (amortized/yr) | $200K-$400K | $500K-$1.2M | $1.5M-$4M |
| Datacenter rack space | $30K-$60K | $80K-$200K | $250K-$600K |
| Power and cooling | $25K-$50K | $60K-$150K | $200K-$500K |
| Network (dedicated switches) | $15K-$30K | $40K-$100K | $100K-$250K |
| Storage (SAN/DAS expansion) | $50K-$150K | $200K-$500K | $500K-$1.5M |
| **Hardware subtotal** | **$320K-$690K** | **$880K-$2.15M** | **$2.55M-$6.85M** |

### 2.2 Teradata software license

Teradata licenses are typically priced per node or per TB of managed storage. Enterprise agreements include:

| License component | Small | Medium | Large |
| --- | --- | --- | --- |
| Teradata Database license | $400K-$800K | $1.5M-$4M | $5M-$12M |
| Teradata Tools & Utilities | $50K-$100K | $150K-$400K | $400K-$1M |
| TASM / TIWM license | Included or $30K | $50K-$150K | $150K-$400K |
| QueryGrid license | $0-$50K | $50K-$200K | $200K-$500K |
| Unity / security add-ons | $0-$30K | $30K-$100K | $100K-$300K |
| Annual maintenance (20-22%) | $100K-$200K | $350K-$950K | $1.1M-$2.8M |
| **License subtotal** | **$580K-$1.21M** | **$2.13M-$5.8M** | **$6.95M-$17M** |

### 2.3 Operations team

| Role | Small | Medium | Large |
| --- | --- | --- | --- |
| Teradata DBA (FTE) | 1-2 | 2-4 | 4-8 |
| DBA cost ($130K-$180K fully loaded) | $180K-$360K | $360K-$720K | $720K-$1.44M |
| ETL developer (BTEQ/TPT) | 1-2 | 3-6 | 6-12 |
| ETL cost ($120K-$160K fully loaded) | $160K-$320K | $480K-$960K | $960K-$1.92M |
| Teradata admin/support | 0.5-1 | 1-2 | 2-4 |
| Admin cost | $80K-$150K | $150K-$300K | $300K-$600K |
| **People subtotal** | **$420K-$830K** | **$990K-$1.98M** | **$1.98M-$3.96M** |

### 2.4 Total on-prem Teradata (annual)

| Size | Hardware + DC | License + maintenance | People | **Total** |
| --- | --- | --- | --- | --- |
| Small | $320K-$690K | $580K-$1.21M | $420K-$830K | **$1.32M-$2.73M** |
| Medium | $880K-$2.15M | $2.13M-$5.8M | $990K-$1.98M | **$4M-$9.93M** |
| Large | $2.55M-$6.85M | $6.95M-$17M | $1.98M-$3.96M | **$11.48M-$27.81M** |

---

## 3. VantageCloud cost model

Teradata's cloud offering (VantageCloud Lake or VantageCloud Enterprise) moves hardware costs to Teradata/cloud provider but retains license premiums.

### 3.1 VantageCloud pricing

| Component | Small | Medium | Large |
| --- | --- | --- | --- |
| Compute units (annual commit) | $400K-$800K | $1.2M-$3M | $3.5M-$8M |
| Storage (managed, per TB) | $50K-$150K | $200K-$600K | $600K-$1.5M |
| Blended platform fee | $100K-$250K | $300K-$800K | $800K-$2M |
| **VantageCloud subtotal** | **$550K-$1.2M** | **$1.7M-$4.4M** | **$4.9M-$11.5M** |

### 3.2 Operational cost remains

Even on VantageCloud, you still need:
- Teradata-skilled DBAs (same headcount, same rates)
- Teradata-specific ETL tooling knowledge
- Teradata SQL dialect expertise

VantageCloud reduces hardware/DC costs by 100% but reduces total TCO by only **25-40%** because the license and people costs remain.

---

## 4. Azure target-state cost model

### 4.1 Compute

| Azure service | Small | Medium | Large |
| --- | --- | --- | --- |
| Synapse Dedicated SQL Pool (DW1000c-DW6000c) | $150K-$350K | $350K-$800K | $800K-$2M |
| Databricks SQL Warehouse (2-16 DBU) | $100K-$250K | $250K-$600K | $600K-$1.5M |
| Fabric Warehouse (F16-F128) | $120K-$300K | $300K-$700K | $700K-$1.8M |
| ADF / orchestration | $20K-$50K | $50K-$120K | $120K-$300K |
| **Compute subtotal** | **$100K-$350K** | **$350K-$800K** | **$800K-$2M** |

> Note: Choose **one** primary compute engine (Synapse, Databricks, or Fabric). The table shows ranges per engine. Most organizations also use a secondary engine for specific workloads.

### 4.2 Storage

| Component | Small (<50 TB) | Medium (50-300 TB) | Large (300 TB-1 PB) |
| --- | --- | --- | --- |
| ADLS Gen2 Hot tier | $10K-$30K | $30K-$100K | $100K-$400K |
| ADLS Gen2 Cool tier (archive) | $2K-$8K | $8K-$30K | $30K-$100K |
| Transaction costs | $5K-$15K | $15K-$40K | $40K-$120K |
| **Storage subtotal** | **$17K-$53K** | **$53K-$170K** | **$170K-$620K** |

### 4.3 Supporting services

| Service | Small | Medium | Large |
| --- | --- | --- | --- |
| Azure Monitor / Log Analytics | $10K-$25K | $25K-$60K | $60K-$150K |
| Microsoft Purview | $15K-$40K | $40K-$100K | $100K-$250K |
| Power BI Premium / Fabric capacity | $60K-$150K | $150K-$400K | $400K-$800K |
| Key Vault, Entra ID (incremental) | $5K-$15K | $15K-$30K | $30K-$60K |
| ExpressRoute (if on-prem hybrid) | $20K-$50K | $50K-$100K | $100K-$200K |
| **Services subtotal** | **$110K-$280K** | **$280K-$690K** | **$690K-$1.46M** |

### 4.4 Operations team (Azure)

| Role | Small | Medium | Large |
| --- | --- | --- | --- |
| Cloud data engineer (Spark/SQL/dbt) | 1-2 | 2-4 | 4-8 |
| Engineer cost ($120K-$160K loaded) | $160K-$320K | $320K-$640K | $640K-$1.28M |
| Cloud platform engineer | 0.5-1 | 1-2 | 2-3 |
| Platform cost ($130K-$170K loaded) | $65K-$170K | $130K-$340K | $260K-$510K |
| **People subtotal** | **$225K-$490K** | **$450K-$980K** | **$900K-$1.79M** |

### 4.5 Total Azure steady-state (annual)

| Size | Compute | Storage | Services | People | **Total** |
| --- | --- | --- | --- | --- | --- |
| Small | $100K-$350K | $17K-$53K | $110K-$280K | $225K-$490K | **$452K-$1.17M** |
| Medium | $350K-$800K | $53K-$170K | $280K-$690K | $450K-$980K | **$1.13M-$2.64M** |
| Large | $800K-$2M | $170K-$620K | $690K-$1.46M | $900K-$1.79M | **$2.56M-$5.87M** |

---

## 5. Migration cost (one-time)

### 5.1 Migration program costs

| Category | Small | Medium | Large |
| --- | --- | --- | --- |
| Migration tooling (SAMA, sqlglot, Qlik) | $50K-$150K | $150K-$400K | $400K-$800K |
| Migration team (FTE x months) | $300K-$800K | $1M-$3M | $3M-$8M |
| Dual-run period (Teradata + Azure) | $200K-$500K | $600K-$1.5M | $1.5M-$4M |
| Training and change management | $50K-$100K | $100K-$300K | $300K-$600K |
| Testing and validation | $100K-$200K | $200K-$500K | $500K-$1.2M |
| **Migration subtotal** | **$700K-$1.75M** | **$2.05M-$5.7M** | **$5.7M-$14.6M** |

### 5.2 Dual-run detail

During migration (typically 12-24 months), both Teradata and Azure run simultaneously:

| Month | Teradata cost | Azure cost | Explanation |
| --- | --- | --- | --- |
| 1-6 | 100% | 20-30% | Azure landing zone, early migrations |
| 7-12 | 100% | 50-70% | Active migration, growing Azure workloads |
| 13-18 | 80-100% | 80-100% | Parallel run, cutover in progress |
| 19-24 | 50-80% | 100% | Teradata winding down |
| 25+ | 0% | 100% | Teradata decommissioned |

Plan for **3-5x steady-state cost** at the peak of dual-run (months 13-18).

---

## 6. Five-year TCO projection (medium estate)

Using the midpoint of medium ranges:

| Year | On-prem Teradata | VantageCloud | Azure (with migration) |
| --- | --- | --- | --- |
| Year 1 | $6.5M | $4.5M | $8M (migration + dual-run) |
| Year 2 | $6.5M | $4.5M | $5M (migration completing) |
| Year 3 | $7M (hardware refresh) | $4.5M | $1.9M (steady state) |
| Year 4 | $6.5M | $4.5M | $1.9M |
| Year 5 | $6.5M | $4.5M | $2M (slight growth) |
| **5-year total** | **$33M** | **$22.5M** | **$18.8M** |
| **5-year savings vs on-prem** | — | $10.5M (32%) | **$14.2M (43%)** |
| **Payback period** | — | Immediate | **Month 30-36** |

### Key assumptions

- Medium estate: 15 nodes, 150 TB, 3,000 tables
- 18-month migration timeline
- Azure steady state includes Databricks SQL + ADLS + Power BI + ADF
- Teradata includes one hardware refresh in year 3
- VantageCloud annual price escalator: 3%
- Azure consumption growth: 5%/year (workload growth)
- No reserved capacity discounts applied (would improve Azure case)

---

## 7. Sensitivity analysis

### What changes the math

| Variable | Impact on Azure TCO | Impact on payback |
| --- | --- | --- |
| Databricks reserved capacity (1-year) | -15 to -25% | 6-12 months earlier |
| Fabric capacity commitment (1-year) | -20 to -30% | 6-12 months earlier |
| Scale-to-zero discipline (auto-pause) | -10 to -20% | 3-6 months earlier |
| Migration takes 30+ months | +$1-3M migration cost | 6-12 months later |
| Teradata discount on renewal | Reduces savings delta | Later payback |
| Higher Azure consumption growth | +5-10%/year | Marginal impact |
| Additional AI/ML workloads on Azure | +10-20% but offsets other tools | Enables new value |

### Break-even scenarios

Azure migration does **not** make financial sense if:
- Teradata estate is very small (<$1M/year total cost) — migration cost exceeds 5-year savings
- Teradata license was just renewed at a significant discount with 4+ years remaining
- Organization cannot fund 18-24 months of dual-run costs
- Teradata contract includes punitive early termination fees exceeding $2M

---

## 8. Hidden costs often missed

### Teradata hidden costs (frequently underestimated)

| Hidden cost | Typical range | Notes |
| --- | --- | --- |
| Hardware refresh (every 5-7 years) | $3M-$10M | Often forgotten in annual budgets |
| Teradata version upgrades | $200K-$500K per event | DBA time + regression testing |
| DR environment | 50-100% of primary | Second appliance or VantageCloud DR |
| TASM tuning (ongoing) | 0.5-1 FTE | Continuous workload management |
| Teradata education/certification | $50K-$100K/year | Required to maintain skills |
| Contractor premium | $150-$250/hr | Teradata specialists are scarce |

### Azure hidden costs (frequently underestimated)

| Hidden cost | Typical range | Notes |
| --- | --- | --- |
| Data egress (if multi-cloud) | $20K-$100K/year | Significant for hybrid architectures |
| Power BI Premium licensing | $60K-$400K/year | Often overlooked in compute estimates |
| Log Analytics ingestion | $20K-$100K/year | Can grow quickly with verbose logging |
| Reserved capacity management | 0.25 FTE | Someone must manage commitments |
| Cloud FinOps tooling | $20K-$50K/year | Cost management tools and practices |
| Learning curve productivity loss | $200K-$500K | First 6 months of reduced velocity |

---

## 9. Cost optimization strategies for Azure

### Immediate wins (day 1)

| Strategy | Savings | Effort |
| --- | --- | --- |
| Auto-pause SQL warehouses (nights/weekends) | 30-50% of compute | Low — configuration only |
| Use Serverless SQL for ad-hoc queries | 50-70% vs dedicated | Low — query routing |
| ADLS lifecycle policies (hot → cool → archive) | 30-60% of storage | Low — policy configuration |

### Medium-term (months 3-6)

| Strategy | Savings | Effort |
| --- | --- | --- |
| Reserved capacity (1-year Databricks/Fabric) | 20-35% of compute | Medium — commitment analysis |
| Query optimization (reduce scans) | 15-30% of compute | Medium — ongoing tuning |
| Delta OPTIMIZE + Z-ORDER | 10-20% of query cost | Medium — data engineering |

### Long-term (months 6-12)

| Strategy | Savings | Effort |
| --- | --- | --- |
| Materialized views for repeated queries | 20-40% for specific workloads | High — requires design |
| Workload isolation (right-size warehouses) | 15-25% of compute | High — architecture |
| Dev/test environment teardown automation | 40-60% of non-prod | Medium — scripting |

See `docs/COST_MANAGEMENT.md` for platform-wide cost optimization guidance.

---

## 10. Building the business case

### Required inputs from your environment

To build an accurate TCO, gather:

1. **Current Teradata contract** — Annual license, maintenance, expiration date, renewal terms
2. **Hardware inventory** — Model, node count, age, next refresh date
3. **Datacenter costs** — Rack space, power, cooling allocated to Teradata
4. **Staff allocation** — FTEs dedicated to Teradata admin, ETL, support
5. **Workload profile** — Peak vs average utilization, seasonal patterns
6. **Data volumes** — Current size, growth rate, retention requirements
7. **Tool licenses** — BTEQ, TPT, third-party ETL, BI tools connecting to Teradata

### Business case template

```
CURRENT STATE (Annual)
  Teradata license + maintenance:    $________
  Hardware / datacenter:             $________
  Operations team:                   $________
  Tools and training:                $________
  TOTAL CURRENT:                     $________

MIGRATION (One-time, 18-24 months)
  Migration tooling:                 $________
  Migration team:                    $________
  Dual-run costs:                    $________
  Training:                          $________
  TOTAL MIGRATION:                   $________

FUTURE STATE (Annual, steady state)
  Azure compute:                     $________
  Azure storage:                     $________
  Azure services:                    $________
  Operations team:                   $________
  TOTAL FUTURE:                      $________

SAVINGS
  Annual savings:                    $________
  Payback period:                    ________ months
  5-year cumulative savings:         $________
```

---

## 11. Related resources

- [Why Azure over Teradata](why-azure-over-teradata.md) — Strategic rationale
- [Benchmarks](benchmarks.md) — Performance comparison data
- [Best Practices](best-practices.md) — Migration planning guidance
- [Teradata Migration Overview](../teradata.md) — Original cost section
- `docs/COST_MANAGEMENT.md` — Platform-wide Azure cost optimization
- Azure Pricing Calculator: <https://azure.microsoft.com/pricing/calculator>
- Databricks Pricing: <https://www.databricks.com/product/pricing>
- Fabric Pricing: <https://azure.microsoft.com/pricing/details/microsoft-fabric>

---

**Maintainers:** csa-inabox core team
**Last updated:** 2026-04-30
