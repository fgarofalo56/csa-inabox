---
title: "Qlik to Power BI Total Cost of Ownership Analysis"
description: "Comprehensive TCO comparison of Qlik Sense Enterprise/Cloud versus Power BI Pro, Premium, and Microsoft Fabric across multiple organization sizes and deployment scenarios."
---

# Qlik to Power BI: Total Cost of Ownership Analysis

**Audience:** CFO, CIO, Procurement, CDO
**Purpose:** Data-driven cost comparison to support migration business case
**Reading time:** 15-20 minutes

---

## Executive summary

This analysis compares the total cost of ownership for Qlik Sense (Enterprise on Windows and Qlik Cloud) versus Power BI (Pro, Premium Per User, Premium Capacity) and Microsoft Fabric across three organization sizes over a 5-year horizon. The analysis includes licensing, infrastructure, tooling adjacencies (NPrinting, data integration), training, and migration costs.

**Key findings:**

- Power BI is **60-85% cheaper** on per-user licensing alone
- When NPrinting replacement and data integration consolidation are factored in, **total platform savings reach 50-75%**
- Microsoft 365 E5 customers face **$0 incremental cost** for Power BI Pro -- the most decisive factor in the TCO analysis
- Migration costs (one-time) are typically recovered within **6-12 months** of licensing savings
- 5-year TCO savings range from **$400K (small org) to $8M+ (large org)**

---

## 1. Qlik pricing model

### 1.1 Qlik Sense per-user licensing

Qlik uses a tiered per-user model with significant price variation depending on contract terms, volume, and negotiation.

| License type          | Target user          | List price/user/mo | Typical negotiated    | Capabilities                                       |
| --------------------- | -------------------- | ------------------ | --------------------- | -------------------------------------------------- |
| **Professional**      | Content creator      | $70                | $40-55                | Full app development, data load scripting, mashups |
| **Analyzer**          | Interactive consumer | $25                | $15-20                | View, filter, export. Cannot create apps.          |
| **Analyzer Capacity** | High-user-count orgs | Per-minute billing | ~$2,500-4,000/mo/core | Based on consumption minutes, pooled across users  |

### 1.2 Qlik Cloud pricing

Qlik Cloud uses a capacity-based model with Data Integration Credits (DICs) and Analytics Capacity Units (ACUs):

| Component                | Unit           | Approximate cost        | Notes                                        |
| ------------------------ | -------------- | ----------------------- | -------------------------------------------- |
| Standard user            | Per user/month | $20-40                  | Consumer access to Qlik Cloud                |
| Full user                | Per user/month | $50-80                  | Creator access on Qlik Cloud                 |
| Analytics capacity       | Per ACU/month  | Varies ($500-2,000/ACU) | Pooled compute for app evaluations           |
| Data Integration credits | Per DIC        | $0.01-0.03/DIC          | For Qlik Data Integration / Talend pipelines |

### 1.3 Qlik add-on costs

| Product                   | Pricing model             | Typical annual cost | Power BI equivalent (included)     |
| ------------------------- | ------------------------- | ------------------- | ---------------------------------- |
| **Qlik NPrinting**        | Named user + server       | $18,000-50,000/yr   | Paginated Reports (Premium/Fabric) |
| **Qlik Alerting**         | Per-user add-on           | $5,000-15,000/yr    | Data alerts + subscriptions        |
| **Qlik Data Integration** | Per-connector or capacity | $30,000-100,000+/yr | ADF + Dataflows (Fabric)           |
| **Qlik GeoAnalytics**     | Per-user add-on           | $3,000-10,000/yr    | Azure Maps + ArcGIS (Power BI)     |
| **Qlik Catalog**          | Platform fee              | $20,000-50,000/yr   | Purview (included in Azure)        |
| **Qlik AutoML**           | Capacity-based            | $10,000-30,000/yr   | Fabric ML (included in Fabric)     |

---

## 2. Power BI pricing model

### 2.1 Per-user licensing

| License type               | Target user        | Cost/user/mo   | Key features                                               |
| -------------------------- | ------------------ | -------------- | ---------------------------------------------------------- |
| **Power BI Free**          | Personal analytics | $0             | Desktop authoring, no sharing via service                  |
| **Power BI Pro**           | All business users | $10            | Full sharing, collaboration, 1 GB model, 8 refreshes/day   |
| **Premium Per User (PPU)** | Power users        | $20            | Pro + 100 GB models, 48 refreshes/day, paginated, AI, XMLA |
| **Pro (in M365 E5)**       | E5 subscribers     | $0 incremental | All Pro features at no additional cost                     |

### 2.2 Capacity-based licensing

| SKU             | Monthly cost | v-cores | Memory | Key features                                                 |
| --------------- | ------------ | ------- | ------ | ------------------------------------------------------------ |
| **P1**          | $4,995       | 8       | 25 GB  | Unlimited viewers, paginated, XMLA, deployment pipelines, AI |
| **P2**          | $9,995       | 16      | 50 GB  | All P1 + more capacity                                       |
| **P3**          | $19,990      | 32      | 100 GB | All P2 + more capacity                                       |
| **EM1/EM2/EM3** | $746-$4,995  | 1-8     | varies | Embedding-only scenarios                                     |

### 2.3 Microsoft Fabric capacity

| SKU      | Monthly cost | CUs | Includes                                              |
| -------- | ------------ | --- | ----------------------------------------------------- |
| **F2**   | $262         | 2   | Lakehouse, notebooks, Power BI, dataflows (trial/dev) |
| **F4**   | $525         | 4   | Same (small workgroup)                                |
| **F8**   | $1,050       | 8   | Same (department)                                     |
| **F16**  | $2,099       | 16  | Same                                                  |
| **F32**  | $4,198       | 32  | Same                                                  |
| **F64**  | $8,396       | 64  | All above + Power BI Premium equivalent features      |
| **F128** | $16,384      | 128 | Full enterprise capacity                              |

!!! tip "Fabric F64+ = Power BI Premium"
Any Fabric SKU at F64 or above includes the full Power BI Premium feature set: paginated reports, XMLA endpoints, deployment pipelines, unlimited viewer distribution, and larger semantic model sizes. This means the Fabric capacity covers both the data platform and BI workloads -- a single line item replacing Qlik + ETL + data warehouse + NPrinting.

---

## 3. TCO scenarios

### 3.1 Scenario A: Small organization (50 users)

**Profile:** 10 creators (Qlik Professional / Power BI Pro), 40 consumers (Qlik Analyzer / Power BI Pro), NPrinting for 5 operational reports.

| Cost category                   | Qlik (annual)         | Power BI (annual)            | Savings                  |
| ------------------------------- | --------------------- | ---------------------------- | ------------------------ |
| Creator licenses                | $52,800-$84,000       | $1,200                       | $51,600-$82,800          |
| Consumer licenses               | $72,000-$120,000      | $4,800                       | $67,200-$115,200         |
| NPrinting                       | $18,000               | $0 (PPU for creators)        | $18,000                  |
| Server infrastructure (on-prem) | $15,000-$25,000       | $0 (SaaS)                    | $15,000-$25,000          |
| Qlik Alerting                   | $5,000                | $0 (included)                | $5,000                   |
| **Total annual**                | **$162,800-$254,000** | **$6,000**                   | **$156,800-$248K**       |
| **5-year TCO**                  | **$814,000-$1.27M**   | **$30,000 + $50K migration** | **$734K-$1.19M savings** |

!!! note "E5 scenario"
If this organization is on M365 E5, Power BI Pro is included. Annual Power BI cost drops to $0 for licensing. 5-year savings exceed $764K.

### 3.2 Scenario B: Mid-size organization (200 users)

**Profile:** 30 creators, 170 consumers, NPrinting for 20 reports, Qlik Data Integration for 3 source systems, dedicated Qlik Sense server cluster.

| Cost category                 | Qlik (annual)         | Power BI (annual)           | Savings                 |
| ----------------------------- | --------------------- | --------------------------- | ----------------------- |
| Creator licenses              | $144,000-$198,000     | $3,600                      | $140,400-$194,400       |
| Consumer licenses             | $306,000-$408,000     | $20,400                     | $285,600-$387,600       |
| NPrinting                     | $35,000               | $0 (PPU or Premium)         | $35,000                 |
| Data Integration / Talend     | $50,000               | $0 (ADF + dbt in Fabric)    | $50,000                 |
| Server infra (3-node cluster) | $45,000-$60,000       | $0 (SaaS)                   | $45,000-$60,000         |
| Qlik Catalog                  | $25,000               | $0 (Purview)                | $25,000                 |
| Qlik Alerting                 | $10,000               | $0 (included)               | $10,000                 |
| Admin / DBA headcount         | $80,000 (0.5 FTE)     | $40,000 (0.25 FTE)          | $40,000                 |
| **Total annual**              | **$695,000-$866,000** | **$64,000**                 | **$631,000-$802K**      |
| **5-year TCO**                | **$3.5M-$4.3M**       | **$320K + $150K migration** | **$3.0M-$3.8M savings** |

### 3.3 Scenario C: Large organization (1,000 users)

**Profile:** 80 creators, 920 consumers, NPrinting for 50+ report templates, Qlik Data Integration across 10 source systems, multi-node Qlik Sense cluster, Qlik Catalog, Qlik AutoML, dedicated admin team.

| Cost category             | Qlik (annual)         | Power BI + Fabric (annual)   | Savings                  |
| ------------------------- | --------------------- | ---------------------------- | ------------------------ |
| Creator licenses          | $384,000-$528,000     | $9,600 (Pro)                 | $374,400-$518,400        |
| Consumer licenses         | $1,104,000-$1,380,000 | $0 (Premium capacity)        | $1,104,000-$1,380,000    |
| Premium / Fabric capacity | N/A                   | $100,800 (F64)               | net additional           |
| NPrinting                 | $50,000-$80,000       | $0 (included in F64)         | $50,000-$80,000          |
| Data Integration / Talend | $100,000              | $0 (ADF + dbt in Fabric)     | $100,000                 |
| Server infrastructure     | $120,000-$180,000     | $0 (SaaS)                    | $120,000-$180,000        |
| Qlik Catalog              | $40,000               | $0 (Purview)                 | $40,000                  |
| Qlik AutoML               | $25,000               | $0 (Fabric ML)               | $25,000                  |
| Qlik Alerting             | $15,000               | $0 (included)                | $15,000                  |
| Admin team (2 FTE)        | $200,000              | $100,000 (1 FTE)             | $100,000                 |
| **Total annual**          | **$2.04M-$2.55M**     | **$210,400**                 | **$1.8M-$2.3M**          |
| **5-year TCO**            | **$10.2M-$12.7M**     | **$1.05M + $400K migration** | **$8.7M-$11.3M savings** |

---

## 4. Hidden cost analysis

### 4.1 Costs often missed in Qlik TCO

| Hidden cost                           | Description                                                                       | Typical annual impact  |
| ------------------------------------- | --------------------------------------------------------------------------------- | ---------------------- |
| **QVD storage growth**                | QVD files accumulate over time; storage costs grow linearly with app count        | $5,000-$20,000         |
| **Reload compute waste**              | Reload tasks run on schedule even when data has not changed                       | $10,000-$30,000        |
| **NPrinting server maintenance**      | Separate Windows server, IIS, .NET runtime, SQL database for NPrinting scheduler  | $8,000-$15,000         |
| **Extension maintenance**             | Qlik extensions (Nebula.js, legacy mashups) require maintenance with each upgrade | $5,000-$15,000         |
| **Training on Qlik-specific skills**  | Qlik expression syntax and data load script are not transferable skills           | $10,000-$20,000        |
| **Vendor lock-in premium at renewal** | PE-owned vendor leverages switching costs to increase prices                      | 15-30% of license cost |
| **Consultant/contractor premium**     | Qlik developers command a premium due to smaller talent pool                      | 20-40% above market    |

### 4.2 Costs often missed in Power BI TCO

| Hidden cost                         | Description                                                             | Typical annual impact |
| ----------------------------------- | ----------------------------------------------------------------------- | --------------------- |
| **Fabric capacity right-sizing**    | Over-provisioning Fabric capacity is easy; monitor and resize quarterly | $5,000-$20,000        |
| **DAX learning curve**              | DAX is more verbose than Qlik expressions; creators need training       | $5,000-$15,000 (Y1)   |
| **Gateway for on-premises sources** | Power BI gateway required for on-prem data; needs a VM                  | $3,000-$8,000         |
| **Custom visual licensing**         | Some AppSource visuals are paid (though most are free)                  | $0-$5,000             |
| **Premium Per User (PPU) creep**    | PPU at $20/user seems cheap but can exceed P1 at scale                  | Monitor break-even    |

---

## 5. Migration cost estimation

### 5.1 One-time migration costs

| Migration activity                        | Small (50 users) | Mid (200 users) | Large (1,000 users) |
| ----------------------------------------- | ---------------- | --------------- | ------------------- |
| Discovery and inventory                   | $10,000          | $25,000         | $50,000             |
| Data model redesign (associative to star) | $15,000          | $40,000         | $100,000            |
| Expression conversion (Set Analysis→DAX)  | $10,000          | $40,000         | $120,000            |
| Visualization rebuild                     | $5,000           | $20,000         | $60,000             |
| NPrinting to paginated reports            | $3,000           | $10,000         | $30,000             |
| Server migration (permissions, schedules) | $2,000           | $5,000          | $15,000             |
| Testing and validation                    | $3,000           | $8,000          | $20,000             |
| Training                                  | $2,000           | $5,000          | $15,000             |
| **Total migration cost**                  | **$50,000**      | **$153,000**    | **$410,000**        |

### 5.2 Payback period

| Scenario         | Annual savings | Migration cost | Payback period |
| ---------------- | -------------- | -------------- | -------------- |
| Small (50 users) | $157K-$248K    | $50K           | 2-4 months     |
| Mid (200 users)  | $631K-$802K    | $153K          | 2-3 months     |
| Large (1,000)    | $1.8M-$2.3M    | $410K          | 2-3 months     |

---

## 6. 5-year total cost projection

### Assumptions

- Qlik price increases: 20% per year (conservative PE-driven estimate)
- Power BI Pro pricing: stable at $10/user/month (historically flat since 2015)
- Fabric capacity: 5% annual increase (Microsoft historical pattern)
- User growth: 10% per year
- Migration costs: Year 1 only

### 5-year projection: Mid-size organization (200 users)

| Year | Qlik annual cost | Power BI + Fabric annual  | Cumulative savings |
| ---- | ---------------- | ------------------------- | ------------------ |
| Y1   | $780,000         | $214,000 (incl migration) | $566,000           |
| Y2   | $936,000         | $67,200                   | $1,434,800         |
| Y3   | $1,123,200       | $70,560                   | $2,487,440         |
| Y4   | $1,347,840       | $74,088                   | $3,761,192         |
| Y5   | $1,617,408       | $77,792                   | $5,300,808         |

!!! warning "Qlik compounding effect"
The 20% annual increase assumption is conservative based on reported renewal data. Some organizations report 25-30% increases, particularly when negotiating leverage is weak (single-vendor BI, no credible alternative evaluated). The compounding effect means the 5-year Qlik cost is dramatically higher than a simple 5x multiplication of Year 1 cost.

---

## 7. Cost optimization strategies for Power BI

### 7.1 License tier optimization

| Strategy                                         | Savings impact              | Implementation                                              |
| ------------------------------------------------ | --------------------------- | ----------------------------------------------------------- |
| Leverage M365 E5 for Pro licenses                | 100% of Pro cost            | Verify E5 entitlement, no additional procurement            |
| Use Free tier for view-only consumers            | Up to 50% of user licensing | Requires Premium/Fabric capacity for distribution           |
| PPU for 10-50 power users instead of P1 capacity | $2K-$4K/month               | PPU at $20/user is cheaper than P1 until ~250 PPU users     |
| Right-size Fabric capacity (auto-scale)          | 20-40% of capacity cost     | Enable Fabric capacity pause/resume for dev/test workspaces |
| Use DirectQuery or Direct Lake instead of Import | Reduces storage             | Eliminates dataset refresh failures and storage costs       |

### 7.2 Break-even analysis: PPU vs Premium Capacity

| Number of PPU users | PPU monthly cost | P1 monthly cost | Recommendation |
| ------------------- | ---------------- | --------------- | -------------- |
| 10                  | $200             | $4,995          | PPU            |
| 50                  | $1,000           | $4,995          | PPU            |
| 100                 | $2,000           | $4,995          | PPU            |
| 200                 | $4,000           | $4,995          | PPU            |
| 250                 | $5,000           | $4,995          | P1             |
| 500                 | $10,000          | $4,995          | P1             |

The break-even point is approximately 250 PPU users. Above this threshold, Premium Capacity (P1) is more cost-effective and provides unlimited viewer distribution.

---

## 8. Procurement guidance

### 8.1 Federal procurement vehicles

| Vehicle                          | Power BI availability | Notes                                           |
| -------------------------------- | --------------------- | ----------------------------------------------- |
| Microsoft EA / EAS               | Yes                   | Best pricing for large organizations            |
| CSP (Cloud Solution Provider)    | Yes                   | Monthly billing, flexibility                    |
| SEWP V                           | Yes                   | NASA-managed; available to all federal agencies |
| GSA Schedule 70                  | Yes                   | Via Microsoft LSPs                              |
| CIO-SP3                          | Yes                   | NITAAC-managed                                  |
| BPA (Blanket Purchase Agreement) | Yes                   | Agency-specific; negotiate multi-year terms     |

### 8.2 Negotiation strategies

1. **Time the migration to Qlik renewal.** The strongest negotiating position is 60-90 days before Qlik contract expiration with a validated Power BI migration plan.
2. **Request Qlik exit pricing.** Some organizations have negotiated Qlik license buyout or reduced-term contracts to fund the migration.
3. **Bundle Fabric with M365 E5.** Microsoft offers discounted Fabric capacity when bundled with E5 renewals.
4. **Negotiate migration credits.** Microsoft and partners occasionally offer migration credits for competitive displacements.
5. **Parallel run budget.** Budget for 3-6 months of overlapping Qlik and Power BI licensing during migration.

---

## 9. ROI summary

| Metric                            | Small org (50) | Mid org (200) | Large org (1,000) |
| --------------------------------- | -------------- | ------------- | ----------------- |
| Year 1 savings (net of migration) | $107K-$198K    | $478K-$649K   | $1.4M-$1.9M       |
| 5-year cumulative savings         | $734K-$1.19M   | $3.0M-$3.8M   | $8.7M-$11.3M      |
| Payback period                    | 2-4 months     | 2-3 months    | 2-3 months        |
| Annual licensing reduction        | 60-85%         | 65-90%        | 75-92%            |
| Platforms consolidated            | 2-3 → 1        | 4-5 → 1       | 5-7 → 1           |

---

## Cross-references

| Topic                              | Document                                              |
| ---------------------------------- | ----------------------------------------------------- |
| Strategic case for migration       | [Why Power BI over Qlik](why-powerbi-over-qlik.md)    |
| Feature comparison                 | [Feature Mapping](feature-mapping-complete.md)        |
| Federal procurement and compliance | [Federal Migration Guide](federal-migration-guide.md) |
| Cost management on Azure           | `docs/COST_MANAGEMENT.md`                             |
| Fabric capacity sizing             | `docs/patterns/power-bi-fabric-roadmap.md`            |

---

**Maintainers:** CSA-in-a-Box core team
**Last updated:** 2026-04-30
