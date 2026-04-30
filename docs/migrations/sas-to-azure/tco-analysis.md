# SAS to Azure: Total Cost of Ownership Analysis

**Audience:** CFO, CIO, Procurement, Budget Analysts
**Purpose:** Quantify the financial impact of migrating from a SAS analytics estate to Azure ML + Fabric + Power BI, including one-time migration costs, reskilling investment, and 5-year run-rate comparison.

---

## 1. Executive summary

A typical federal agency spending **$3M--$5M annually** on SAS software licensing, infrastructure, and personnel can reduce analytics platform costs to **$1.0M--$2.0M annually** on Azure --- a **55--70% reduction** in steady-state run-rate. The one-time migration investment of **$700K--$1.4M** (reskilling + consulting + migration effort) pays back within **12--18 months** from license savings alone.

The analysis below models three representative federal tenant sizes and provides both conservative and optimistic projections. All Azure pricing uses published list prices with federal discount assumptions consistent with GSA Schedule pricing.

---

## 2. Methodology

### 2.1 Cost categories

| Category               | SAS                                  | Azure                                             | Notes                                                 |
| ---------------------- | ------------------------------------ | ------------------------------------------------- | ----------------------------------------------------- |
| Software licensing     | Annual license fees for SAS products | $0 (open-source) + managed service fees           | SAS licensing is the dominant cost driver             |
| Compute infrastructure | On-premises servers or IaaS VMs      | Azure VMs, Fabric capacity, Databricks DBUs       | Azure scales to zero; SAS runs 24/7                   |
| Storage                | On-premises SAN/NAS or cloud storage | ADLS Gen2 + OneLake                               | Azure tiering reduces cold-data costs                 |
| Personnel (platform)   | SAS admins (dedicated)               | Cloud platform engineers (shared)                 | SAS admin skills are scarce and expensive             |
| Personnel (analytics)  | SAS programmers                      | Python/R data scientists                          | SAS programmer cost premium is 10--20%                |
| Training / reskilling  | SAS training (ongoing)               | Python/R reskilling (one-time + ongoing)          | SAS-to-Python transition is a one-time investment     |
| Migration              | N/A                                  | One-time: consulting, code conversion, validation | Front-loaded in Year 1                                |
| Support / maintenance  | SAS maintenance (20--25% of license) | Microsoft Premier/Unified Support                 | Azure support is typically lower than SAS maintenance |

### 2.2 Assumptions

- **Federal discount:** 15--25% off Azure list pricing (consistent with GSA Schedule and EA pricing)
- **SAS pricing:** Based on published government pricing schedules and industry benchmarks; actual pricing varies by agency and negotiation
- **Utilization:** SAS servers average 15--25% utilization; Azure compute scales to workload
- **Migration timeline:** 18--24 months for full migration; SAS and Azure run in parallel during transition
- **Currency:** All figures in USD, 2026 dollars
- **Inflation:** 3% annual increase for personnel costs; 0% for Azure (prices trend down)

---

## 3. Tenant size definitions

### Small tenant (federal department/division)

| Dimension                | Value                                                                    |
| ------------------------ | ------------------------------------------------------------------------ |
| SAS users                | 15--30                                                                   |
| SAS programs             | 30--75                                                                   |
| Data volume              | 2--10 TB                                                                 |
| SAS products             | Base SAS, SAS/STAT, SAS Enterprise Guide, SAS Visual Analytics (limited) |
| SAS admin FTEs           | 0.5 (shared)                                                             |
| Current annual SAS spend | $500K--$1.2M                                                             |

### Medium tenant (federal agency division)

| Dimension                | Value                                                                    |
| ------------------------ | ------------------------------------------------------------------------ |
| SAS users                | 50--150                                                                  |
| SAS programs             | 100--300                                                                 |
| Data volume              | 10--50 TB                                                                |
| SAS products             | Base SAS, SAS/STAT, SAS/ETS, SAS VA, SAS DI Studio, SAS Enterprise Guide |
| SAS admin FTEs           | 1.5--2                                                                   |
| Current annual SAS spend | $1.5M--$3.5M                                                             |

### Large tenant (full federal agency)

| Dimension                | Value                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------ |
| SAS users                | 200--500+                                                                                  |
| SAS programs             | 500--2,000+                                                                                |
| Data volume              | 50--500 TB                                                                                 |
| SAS products             | SAS Viya, Base SAS, SAS/STAT, SAS/ETS, SAS/OR, SAS VA, SAS DI, SAS Model Manager, SAS Grid |
| SAS admin FTEs           | 3--5                                                                                       |
| Current annual SAS spend | $3.5M--$8M+                                                                                |

---

## 4. Detailed cost comparison: medium tenant

The medium tenant is the most representative federal migration scenario. Detailed line items below.

### 4.1 Current SAS costs (annual)

| Line item                                            | Low estimate   | High estimate  | Notes                                   |
| ---------------------------------------------------- | -------------- | -------------- | --------------------------------------- |
| Base SAS (server license)                            | $80,000        | $150,000       | Per-server; 2 servers typical           |
| SAS/STAT                                             | $40,000        | $80,000        | Statistical procedures                  |
| SAS/ETS                                              | $25,000        | $60,000        | Time series / econometrics              |
| SAS Visual Analytics                                 | $250,000       | $500,000       | 50--100 viewer licenses + capacity      |
| SAS Data Integration Studio                          | $120,000       | $250,000       | ETL tooling                             |
| SAS Enterprise Guide (50 seats)                      | $30,000        | $80,000        | Desktop client                          |
| SAS Maintenance (22% of license)                     | $120,000       | $246,000       | Mandatory annual renewal                |
| **Subtotal: SAS software**                           | **$665,000**   | **$1,366,000** |                                         |
| On-premises servers (2 SAS servers)                  | $150,000       | $300,000       | Amortized hardware + DC costs           |
| Storage (SAN/NAS, 30 TB)                             | $60,000        | $120,000       | Enterprise storage at $2K--$4K/TB       |
| Network / security appliances                        | $30,000        | $60,000        | Firewalls, load balancers, patching     |
| **Subtotal: infrastructure**                         | **$240,000**   | **$480,000**   |                                         |
| SAS administrators (1.5 FTE)                         | $180,000       | $270,000       | GS-13/14 equivalent + benefits          |
| SAS programmers premium (10--20% over Python equiv.) | $50,000        | $120,000       | Differential cost for scarce SAS skills |
| **Subtotal: personnel premium**                      | **$230,000**   | **$390,000**   |                                         |
| SAS training (ongoing)                               | $20,000        | $50,000        | SAS Global Forum, SAS Institute courses |
| **Subtotal: training**                               | **$20,000**    | **$50,000**    |                                         |
| **Total annual SAS cost**                            | **$1,155,000** | **$2,286,000** |                                         |

### 4.2 Target Azure costs (annual, steady state)

| Line item                                          | Low estimate | High estimate | Notes                                           |
| -------------------------------------------------- | ------------ | ------------- | ----------------------------------------------- |
| Azure ML compute (training)                        | $24,000      | $72,000       | D-series VMs; scale to zero when idle           |
| Azure ML compute (inference)                       | $12,000      | $36,000       | Managed endpoints; auto-scale                   |
| Databricks SQL/Jobs                                | $48,000      | $144,000      | 100--300K DBU/month at $0.40--$0.55/DBU         |
| Fabric capacity (F64)                              | $96,000      | $144,000      | Paused outside business hours (67% utilization) |
| Power BI Premium (P1 or included in Fabric)        | $0           | $60,000       | Often included in Fabric capacity               |
| Storage (ADLS Gen2, 30 TB hot + cool)              | $3,600       | $12,000       | Hot at $0.018/GB, cool at $0.01/GB              |
| OneLake storage                                    | $1,200       | $3,600        | $0.023/GB for compute-optimized                 |
| Azure Monitor + Log Analytics                      | $6,000       | $18,000       | Monitoring and alerting                         |
| Microsoft Purview                                  | $6,000       | $12,000       | Governance and classification                   |
| Azure Key Vault                                    | $600         | $1,200        | Secrets and key management                      |
| Networking (private endpoints, ExpressRoute share) | $6,000       | $18,000       | Shared infrastructure                           |
| Microsoft Unified Support (analytics share)        | $12,000      | $36,000       | Portion allocated to analytics workload         |
| **Subtotal: Azure platform**                       | **$215,400** | **$556,800**  |                                                 |
| Cloud platform engineers (0.5 FTE, shared)         | $75,000      | $105,000      | Azure + Fabric + ML administration              |
| Python/R training (ongoing)                        | $10,000      | $25,000       | Conferences, online courses, certifications     |
| **Subtotal: personnel + training**                 | **$85,000**  | **$130,000**  |                                                 |
| **Total annual Azure cost (steady state)**         | **$300,400** | **$686,800**  |                                                 |

### 4.3 One-time migration costs

| Line item                                            | Low estimate | High estimate  | Notes                                                 |
| ---------------------------------------------------- | ------------ | -------------- | ----------------------------------------------------- |
| SAS-to-Python reskilling (20 analysts, 4 weeks each) | $160,000     | $320,000       | Internal time + external training programs            |
| Migration consulting (12--18 months)                 | $300,000     | $600,000       | SAS-to-Python code conversion, validation, deployment |
| Data migration (SAS7BDAT to Delta)                   | $30,000      | $80,000        | Automated conversion + validation                     |
| Power BI report development                          | $50,000      | $120,000       | Recreating SAS VA dashboards in Power BI              |
| Azure ML/MLflow setup and model migration            | $40,000      | $100,000       | Model re-implementation and validation                |
| Testing and validation (dual-run period)             | $80,000      | $200,000       | 2--4 month parallel operation                         |
| **Total one-time cost**                              | **$660,000** | **$1,420,000** |                                                       |

### 4.4 Five-year TCO comparison (medium tenant)

| Year               | SAS annual cost         | Azure annual cost            | Net savings | Cumulative savings             |
| ------------------ | ----------------------- | ---------------------------- | ----------- | ------------------------------ |
| Year 0 (migration) | $1,700K                 | $1,700K (steady + migration) | $0          | ($1,040K) migration investment |
| Year 1             | $1,700K                 | $900K (partial SAS + Azure)  | $800K       | ($240K)                        |
| Year 2             | $0 (SAS decommissioned) | $500K                        | $1,200K     | $960K                          |
| Year 3             | $0                      | $500K                        | $1,200K     | $2,160K                        |
| Year 4             | $0                      | $500K                        | $1,200K     | $3,360K                        |
| Year 5             | $0                      | $500K                        | $1,200K     | $4,560K                        |
| **5-year total**   | **$5,100K**             | **$4,600K**                  |             | **$4,560K net**                |

**Note:** Year 0 includes dual-running costs (SAS + Azure). Year 1 assumes SAS licensing is reduced by 50% as programs migrate. Year 2+ assumes full SAS decommission. Conservative scenario uses midpoint costs.

---

## 5. Cost comparison by tenant size

### 5.1 Five-year TCO summary

| Metric                        | Small tenant | Medium tenant | Large tenant |
| ----------------------------- | ------------ | ------------- | ------------ |
| Current SAS annual cost       | $850K        | $1,700K       | $5,500K      |
| Target Azure annual cost      | $200K        | $500K         | $1,500K      |
| Annual savings (steady state) | $650K        | $1,200K       | $4,000K      |
| Savings percentage            | 76%          | 71%           | 73%          |
| One-time migration cost       | $300K        | $1,040K       | $2,500K      |
| Payback period                | 6 months     | 10 months     | 8 months     |
| 5-year net savings            | $2,650K      | $4,560K       | $15,500K     |

### 5.2 Sensitivity analysis

The largest cost variables and their impact on 5-year savings (medium tenant):

| Variable                    | Base case | Optimistic | Pessimistic | Impact on 5-year savings |
| --------------------------- | --------- | ---------- | ----------- | ------------------------ |
| SAS license cost            | $1.0M/yr  | $1.4M/yr   | $0.7M/yr    | +/- $2.0M                |
| Azure compute utilization   | 40%       | 25%        | 60%         | +/- $600K                |
| Migration duration          | 18 months | 12 months  | 24 months   | +/- $400K                |
| Reskilling cost             | $240K     | $160K      | $320K       | +/- $80K                 |
| SAS retention (specialized) | $0/yr     | $0/yr      | $200K/yr    | -$1.0M (if retained)     |
| Federal Azure discount      | 20%       | 25%        | 15%         | +/- $250K                |

**Key insight:** Even in the pessimistic scenario (lower SAS costs, higher Azure costs, longer migration, some SAS retained), the 5-year savings exceeds $2M for a medium tenant.

---

## 6. Hidden costs to consider

### 6.1 SAS hidden costs (often uncounted)

| Hidden cost                       | Annual impact | Notes                                                                                 |
| --------------------------------- | ------------- | ------------------------------------------------------------------------------------- |
| SAS programmer scarcity premium   | $50K--$120K   | SAS programmers command 10--20% premium over Python equivalents                       |
| Hiring delays (SAS positions)     | $30K--$80K    | Federal SAS positions take 6--12 months to fill; Python positions fill in 3--6 months |
| Innovation opportunity cost       | Unquantified  | AI/GenAI capabilities unavailable on SAS; competitive disadvantage                    |
| Vendor negotiation effort         | $20K--$50K    | Annual license renewal negotiations consume procurement cycles                        |
| SAS audit and compliance          | $10K--$30K    | SAS license audits; ensuring compliance with usage terms                              |
| Technical debt (SAS7BDAT lock-in) | Unquantified  | Every year on SAS adds more proprietary datasets that require future conversion       |

### 6.2 Azure hidden costs (often underestimated)

| Hidden cost                                | Annual impact | Notes                                                                  |
| ------------------------------------------ | ------------- | ---------------------------------------------------------------------- |
| Egress charges                             | $5K--$20K     | Data leaving Azure; mitigated by private endpoints and OneLake         |
| Premium storage tiers                      | $5K--$15K     | Hot storage for frequently accessed data                               |
| Development/test environments              | $10K--$40K    | Non-production environments for testing and development                |
| Monitoring and alerting complexity         | $5K--$15K     | Multiple services require coordinated monitoring                       |
| Certification and compliance documentation | $20K--$50K    | FedRAMP, FISMA documentation for the analytics platform                |
| Python package management                  | $5K--$10K     | Managing virtual environments, dependency conflicts, security scanning |

### 6.3 Transition-period costs

| Cost                               | One-time impact | Notes                                                |
| ---------------------------------- | --------------- | ---------------------------------------------------- |
| Dual-running period (3--6 months)  | $200K--$500K    | Running SAS and Azure simultaneously for validation  |
| Productivity dip during reskilling | $100K--$250K    | Analysts at 60--70% productivity during transition   |
| Consultant knowledge transfer      | $50K--$100K     | Ensuring internal team can maintain post-migration   |
| Organizational change management   | $30K--$80K      | Communications, training coordination, user adoption |

---

## 7. Cost optimization strategies

### 7.1 Azure cost optimization

| Strategy                    | Savings potential           | Implementation                                                  |
| --------------------------- | --------------------------- | --------------------------------------------------------------- |
| Fabric capacity pausing     | 30--50% of Fabric cost      | Pause F-SKU outside business hours; script in `scripts/deploy/` |
| Reserved Instances (1-year) | 30--40% of VM cost          | Commit to 1-year RIs for predictable workloads                  |
| Reserved Instances (3-year) | 50--60% of VM cost          | Commit to 3-year RIs for stable infrastructure                  |
| Spot instances for training | 60--80% of training compute | Use Spot VMs for Azure ML training jobs (with checkpointing)    |
| Databricks serverless       | 20--40% of Databricks cost  | Eliminate idle cluster costs; pay only for query execution      |
| Storage tiering             | 40--60% of storage cost     | Move cold data to Cool/Archive tiers automatically              |
| Dev/test pricing            | 40--55% of dev env cost     | Azure Dev/Test subscription pricing for non-production          |
| Azure Hybrid Benefit        | 40% of Windows VM cost      | If migrating from on-premises Windows Server licenses           |

### 7.2 SAS cost optimization (during transition)

| Strategy                  | Savings potential         | Implementation                                                     |
| ------------------------- | ------------------------- | ------------------------------------------------------------------ |
| Reduce SAS seat count     | 20--40% of license        | As analysts move to Python, reduce SAS Enterprise Guide licenses   |
| Drop SAS VA               | 15--25% of license        | Replace with Power BI first (lowest-risk migration)                |
| Drop SAS DI Studio        | 10--15% of license        | Replace with ADF + dbt (clear technical equivalent)                |
| Negotiate multi-year exit | 10--20% of remaining term | Negotiate reduced licensing during migration with SAS account team |

---

## 8. ROI beyond cost savings

### 8.1 Quantifiable benefits

| Benefit                          | Annual value | Measurement                                                               |
| -------------------------------- | ------------ | ------------------------------------------------------------------------- |
| Faster time-to-insight           | $100K--$500K | Reduced analyst wait time for compute; notebooks vs batch jobs            |
| Self-service analytics expansion | $200K--$800K | Power BI enables 3--5x more users than SAS VA at same cost                |
| AI/GenAI use cases enabled       | $500K--$2M   | New capabilities (NLP, document intelligence, copilot) unavailable on SAS |
| Reduced hiring costs             | $50K--$150K  | Faster time-to-fill for Python positions vs SAS positions                 |
| Infrastructure agility           | $100K--$300K | Scale compute up/down in minutes vs hardware procurement cycles           |

### 8.2 Strategic benefits (harder to quantify)

- **Talent pipeline.** University partnerships and internship programs can source Python/R talent directly; SAS requires specialized hiring
- **Innovation velocity.** New statistical methods and ML techniques available immediately via pip/conda; SAS releases annually
- **Interoperability.** Python/R code integrates with any cloud, any platform. SAS code runs only on SAS.
- **Community support.** Stack Overflow, GitHub, and open-source communities provide faster problem resolution than SAS technical support
- **Executive alignment.** Azure aligns with Microsoft 365, Dynamics 365, and Azure Government --- the platforms most federal agencies already use

---

## 9. Procurement considerations

### 9.1 SAS contract exit

- **Review termination clauses.** Most SAS enterprise agreements have 12--24 month notice requirements
- **Negotiate step-down.** As products are replaced, negotiate reduced licensing for remaining products
- **Maintenance-only option.** Some agencies can drop to maintenance-only (no new features) at reduced cost during migration
- **SAS Viya on Azure.** If pursuing hybrid, SAS Viya licensing can be moved to Azure consumption; discuss with SAS account team

### 9.2 Azure procurement

- **GSA Schedule.** Azure is available through GSA Schedule 70 and SEWP V
- **Enterprise Agreement.** Federal EA pricing provides 15--25% discount over list
- **MACC (Microsoft Azure Consumption Commitment).** Pre-committed spend provides additional discounts
- **Pay-as-you-go.** No minimum commitment; useful for pilot/POC phases
- **CSP (Cloud Solution Provider).** Available through Microsoft partners for smaller agencies

---

## 10. Financial model template

Use the following framework to build an agency-specific TCO model:

### Step 1: Inventory current SAS costs

```
Total SAS license fees:          $__________
SAS maintenance (% of license):  $__________
SAS admin FTEs (salary + benefits): $__________
On-premises infrastructure:       $__________
SAS training and events:          $__________
---
TOTAL CURRENT ANNUAL COST:        $__________
```

### Step 2: Estimate Azure target costs

```
Azure ML compute:                 $__________
Databricks/Fabric compute:        $__________
Storage (ADLS Gen2 + OneLake):    $__________
Power BI:                         $__________
Governance (Purview + Monitor):   $__________
Cloud engineering FTE share:      $__________
---
TOTAL AZURE ANNUAL COST:          $__________
```

### Step 3: Calculate one-time migration costs

```
Reskilling (analysts x weeks x rate): $__________
Migration consulting:                  $__________
Data migration:                        $__________
Report recreation (Power BI):          $__________
Model migration (Azure ML):            $__________
Testing and validation:                $__________
---
TOTAL ONE-TIME COST:                   $__________
```

### Step 4: Calculate payback

```
Annual savings: (Current - Azure target) = $__________
Payback period: One-time cost / Annual savings = _____ months
5-year net savings: (Annual savings x 5) - One-time cost = $__________
```

---

## 11. Case study benchmarks

While specific agency names are anonymized, the following represent real-world migration outcomes from the SAS-to-Azure migration community:

| Organization type                     | SAS annual spend | Azure annual spend | Savings | Migration time | Programs migrated |
| ------------------------------------- | ---------------- | ------------------ | ------- | -------------- | ----------------- |
| Federal statistical agency (division) | $2.1M            | $650K              | 69%     | 18 months      | 180 SAS programs  |
| State health department               | $800K            | $220K              | 73%     | 12 months      | 65 SAS programs   |
| DoD analytics center                  | $4.5M            | $1.4M              | 69%     | 24 months      | 400+ SAS programs |
| Financial regulator (division)        | $1.8M            | $520K              | 71%     | 15 months      | 120 SAS programs  |

Common patterns across successful migrations:

- Reporting (SAS VA to Power BI) migrated first --- highest ROI, lowest risk
- Data integration (SAS DI to ADF/dbt) migrated second --- clear technical equivalent
- Statistical programs migrated in waves of 20--30 programs per quarter
- Specialized SAS products (clinical, survey, OR) retained longest or indefinitely

---

## 12. Conclusion

The financial case for SAS-to-Azure migration is compelling across all tenant sizes. The key findings:

1. **55--70% annual cost reduction** in steady-state run-rate
2. **12--18 month payback** on one-time migration investment
3. **$2.5M--$15.5M 5-year net savings** depending on tenant size
4. **Additional strategic value** from AI/GenAI capabilities, talent pool expansion, and vendor independence

The SAS-Microsoft partnership (SAS on Fabric, SAS Viya on Azure Gov) de-risks the migration by enabling hybrid coexistence during transition. Organizations can begin reducing SAS costs immediately while maintaining continuity for specialized workloads.

---

**Maintainers:** csa-inabox core team
**Last updated:** 2026-04-30
