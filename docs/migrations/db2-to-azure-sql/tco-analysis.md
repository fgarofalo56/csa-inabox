# Total Cost of Ownership -- IBM Db2 vs Azure SQL

**Audience:** CFO, CIO, Procurement, Financial Analysts
**Reading time:** 25 minutes
**Purpose:** Detailed financial comparison of IBM Db2 (z/OS and LUW) versus Azure SQL, covering licensing models, infrastructure costs, operational staffing, and 5-year projections for three federal tenant sizes.

---

## IBM Db2 licensing models explained

Understanding IBM's licensing models is essential to building an accurate TCO. Db2 licensing varies dramatically by platform, and the models are deliberately complex.

### Db2 for z/OS -- MIPS-based licensing

Db2 for z/OS is licensed based on the **MSU** (Million Service Units) rating of the LPAR (Logical Partition) where it runs. IBM markets this as MIPS-based pricing, though the technical metric is MSUs. The key characteristics:

- **Sub-capacity pricing:** Available through IBM's Sub-Capacity Reporting Tool (SCRT), which measures peak rolling 4-hour average utilization. This is the most common model for federal agencies.
- **Full-capacity pricing:** Charged on the rated capacity of the entire CPC (Central Processor Complex), regardless of utilization. Rare in federal due to extreme cost.
- **Monthly License Charge (MLC):** Recurring monthly charges based on MSU consumption. This is the dominant cost model.
- **IPLA (International Program License Agreement):** One-time license + annual S&S. Less common for z/OS Db2.

**Critical cost dynamic:** When an agency refreshes mainframe hardware (typically every 4-5 years), the new hardware has a higher MSU rating. Even if the workload is identical, IBM MLC charges increase because the software is priced on capacity, not utilization.

### Db2 for LUW -- PVU-based licensing

Db2 for LUW (Linux/UNIX/Windows) uses **Processor Value Unit (PVU)** licensing:

- Each physical processor core is assigned a PVU value based on chip architecture.
- Intel Xeon: 70 PVUs per core.
- IBM POWER9/POWER10: 100-120 PVUs per core.
- Db2 Advanced Enterprise Server Edition: ~$110 per PVU.
- Db2 Standard Edition: ~$55 per PVU.

**Example:** An 8-core Intel Xeon server running Db2 Advanced Enterprise: 8 cores x 70 PVUs x $110 = $61,600 license + $13,552/year support (22%).

### IBM annual support -- the 22% tax

IBM Software Subscription and Support (S&S) is mandatory at 22% of the license value, billed annually. Discontinuing S&S means losing the right to install updates and the right to use the software (for MLC-licensed products). This creates a compounding cost that grows every year as the license base expands through hardware refreshes or additional deployments.

---

## Azure SQL pricing models

### Azure SQL Managed Instance

Azure SQL MI pricing is straightforward:

- **vCore-based:** Select General Purpose or Business Critical tier, choose the number of vCores (4, 8, 16, 24, 32, 40, 64, 80), and pay per hour.
- **Storage:** Charged per GB per month (General Purpose uses remote storage; Business Critical uses local SSD).
- **Backup storage:** Included for retention up to 35 days; additional retention charged per GB.
- **Reserved instances:** 1-year (30% discount) or 3-year (55% discount) commitments.
- **Azure Hybrid Benefit:** Existing SQL Server licenses with Software Assurance reduce the vCore cost by approximately 55%.

### Azure SQL Database

Azure SQL Database offers additional flexibility:

- **Serverless compute:** Auto-scale between min and max vCores; pay only for compute used. Ideal for variable workloads.
- **DTU-based:** Simplified model bundling compute, memory, and IO. Useful for predictable workloads.
- **Hyperscale:** Up to 100 TB databases with near-instant backups and fast scaling.

---

## TCO model -- three federal tenant sizes

### Assumptions

- 5-year analysis period (aligns with federal budget cycles)
- Azure Government pricing (typically 15-25% premium over commercial Azure)
- IBM pricing based on publicly available list prices with typical federal discount (30-40%)
- FTE costs at loaded federal contractor rates
- One-time migration costs amortized over Year 1
- IBM hardware refresh assumed in Year 3

---

### Scenario 1: Small federal agency -- departmental Db2 LUW

**Profile:** Single Db2 11.5 for LUW instance on a 2-socket Intel Xeon server (16 cores), hosting 3 databases, 200 tables, 30 stored procedures, 150 GB total data. Departmental loan-processing application.

#### Current IBM costs (annual)

| Cost element                                       | Annual cost  |
| -------------------------------------------------- | ------------ |
| Db2 Advanced Enterprise (16 cores x 70 PVU x $110) | $123,200     |
| IBM S&S (22% of license)                           | $27,104      |
| Server hardware depreciation (4-year cycle)        | $12,000      |
| RHEL OS licensing                                  | $6,000       |
| Db2 DBA (0.5 FTE at $160K loaded)                  | $80,000      |
| Storage (SAN allocation, 500 GB)                   | $8,000       |
| Backup infrastructure                              | $5,000       |
| **Total annual IBM cost**                          | **$261,304** |

#### Target Azure SQL costs (annual)

| Cost element                                        | Annual cost |
| --------------------------------------------------- | ----------- |
| Azure SQL MI (General Purpose, 8 vCores, 3-year RI) | $28,800     |
| Storage (150 GB + backups)                          | $1,200      |
| Azure Monitor + diagnostics                         | $1,500      |
| Cloud DBA (0.25 FTE at $160K loaded)                | $40,000     |
| Networking (private endpoint, VPN)                  | $3,600      |
| **Total annual Azure cost**                         | **$75,100** |

#### One-time migration costs

| Cost element                              | One-time cost |
| ----------------------------------------- | ------------- |
| SSMA licensing + tooling                  | $0 (free)     |
| Migration engineering (2 FTEs x 3 months) | $80,000       |
| Application testing + cutover             | $40,000       |
| Training (DBA team on Azure SQL)          | $10,000       |
| **Total migration cost**                  | **$130,000**  |

#### 5-year TCO comparison

| Year   | IBM Db2 (cumulative) | Azure SQL (cumulative)     |
| ------ | -------------------- | -------------------------- |
| Year 1 | $261,304             | $205,100 (incl. migration) |
| Year 2 | $522,608             | $280,200                   |
| Year 3 | $783,912             | $355,300                   |
| Year 4 | $1,045,216           | $430,400                   |
| Year 5 | $1,306,520           | $505,500                   |

**5-year savings: $801,020 (61%)**

---

### Scenario 2: Mid-size federal agency -- enterprise Db2 LUW + z/OS

**Profile:** Db2 for z/OS on a z15 mainframe at 2,500 MSU (sub-capacity, 4-hour rolling average of 1,800 MSU), plus 2 Db2 LUW instances (32 cores total). z/OS hosts core financial processing (800 tables, 250 stored procedures, 2 TB data). LUW hosts reporting and departmental databases (400 tables, 80 stored procedures, 500 GB data).

#### Current IBM costs (annual)

| Cost element                                 | Annual cost    |
| -------------------------------------------- | -------------- |
| Db2 for z/OS MLC (1,800 MSU sub-capacity)    | $1,620,000     |
| Db2 for LUW (32 cores x 70 PVU x $110)       | $246,400       |
| IBM S&S on LUW licenses (22%)                | $54,208        |
| z/OS operating system MLC                    | $540,000       |
| CICS MLC (transaction processing)            | $432,000       |
| Mainframe hardware lease (z15)               | $960,000       |
| Mainframe FTEs (3 system programmers)        | $480,000       |
| Db2 DBAs (3 FTEs, z/OS + LUW)                | $480,000       |
| Storage (mainframe DASD + SAN)               | $180,000       |
| Facilities, power, cooling (mainframe share) | $120,000       |
| **Total annual IBM cost**                    | **$5,112,608** |

#### Target Azure SQL costs (annual)

| Cost element                                          | Annual cost  |
| ----------------------------------------------------- | ------------ |
| Azure SQL MI Business Critical (32 vCores, 3-year RI) | $192,000     |
| Azure SQL MI General Purpose (16 vCores, 3-year RI)   | $57,600      |
| Storage (2.5 TB + backups)                            | $15,000      |
| Azure Data Factory (pipeline execution)               | $24,000      |
| Fabric capacity (F64) for analytics                   | $180,000     |
| Azure Monitor + Defender for SQL                      | $12,000      |
| Cloud DBAs (2 FTEs at $160K loaded)                   | $320,000     |
| Networking (ExpressRoute + private endpoints)         | $36,000      |
| Power BI Premium Per User (50 users)                  | $60,000      |
| **Total annual Azure cost**                           | **$896,600** |

#### One-time migration costs

| Cost element                                 | One-time cost  |
| -------------------------------------------- | -------------- |
| SSMA licensing + tooling                     | $0 (free)      |
| Migration engineering (6 FTEs x 9 months)    | $720,000       |
| Application modernization (CICS replacement) | $480,000       |
| EBCDIC conversion + data validation          | $120,000       |
| Testing + parallel operation (6 months)      | $360,000       |
| Training (DBA + dev teams)                   | $60,000        |
| **Total migration cost**                     | **$1,740,000** |

#### 5-year TCO comparison

| Year   | IBM Db2 (cumulative)                    | Azure SQL (cumulative)       |
| ------ | --------------------------------------- | ---------------------------- |
| Year 1 | $5,112,608                              | $2,636,600 (incl. migration) |
| Year 2 | $10,225,216                             | $3,533,200                   |
| Year 3 | $15,337,824 + $8M refresh = $23,337,824 | $4,429,800                   |
| Year 4 | $28,450,432                             | $5,326,400                   |
| Year 5 | $33,563,040                             | $6,223,000                   |

**5-year savings: $27,340,040 (81%)** -- driven by mainframe hardware refresh avoidance in Year 3 and elimination of z/OS MLC charges.

---

### Scenario 3: Large federal agency -- multi-LPAR mainframe Db2 estate

**Profile:** Db2 for z/OS across 3 LPARs (production, QA, DR) on a z16 at 8,000 MSU total capacity (sub-capacity average: 5,500 MSU). 4,000+ tables, 1,200 stored procedures, 15 TB data. Mission-critical systems: payment processing, benefits administration, case management. Plus 5 Db2 LUW instances (80 cores total) for departmental workloads.

#### Current IBM costs (annual)

| Cost element                                      | Annual cost     |
| ------------------------------------------------- | --------------- |
| Db2 for z/OS MLC (5,500 MSU sub-capacity)         | $4,950,000      |
| Db2 for LUW (80 cores x 70 PVU x $110)            | $616,000        |
| IBM S&S on LUW licenses (22%)                     | $135,520        |
| z/OS MLC (operating system)                       | $1,650,000      |
| CICS + IMS MLC                                    | $1,320,000      |
| MQ Series MLC                                     | $440,000        |
| Mainframe hardware lease (z16)                    | $2,400,000      |
| Mainframe FTEs (6 system programmers + 2 storage) | $1,280,000      |
| Db2 DBAs (6 FTEs, z/OS + LUW)                     | $960,000        |
| Storage (mainframe DASD + SAN, 30 TB)             | $480,000        |
| DR site (secondary mainframe)                     | $1,200,000      |
| Facilities, power, cooling                        | $360,000        |
| IBM consulting and support contracts              | $400,000        |
| **Total annual IBM cost**                         | **$16,191,520** |

#### Target Azure SQL costs (annual)

| Cost element                                                | Annual cost    |
| ----------------------------------------------------------- | -------------- |
| Azure SQL MI Business Critical (64 vCores, 3-year RI, prod) | $384,000       |
| Azure SQL MI Business Critical (32 vCores, 3-year RI, QA)   | $192,000       |
| Azure SQL MI geo-replicated DR                              | $192,000       |
| Azure SQL MI General Purpose (24 vCores x 5 instances, LUW) | $216,000       |
| Storage (15 TB + backups)                                   | $90,000        |
| Azure Data Factory                                          | $60,000        |
| Fabric capacity (F128)                                      | $360,000       |
| Azure Batch (batch job replacement)                         | $48,000        |
| Azure Monitor + Defender + Purview                          | $72,000        |
| Cloud DBAs (4 FTEs at $160K loaded)                         | $640,000       |
| Cloud architects / app modernization (2 FTEs)               | $320,000       |
| Networking (ExpressRoute x2 + private endpoints)            | $84,000        |
| Power BI Premium capacity (P1)                              | $120,000       |
| Azure OpenAI (AI integration)                               | $60,000        |
| **Total annual Azure cost**                                 | **$2,838,000** |

#### One-time migration costs

| Cost element                                     | One-time cost  |
| ------------------------------------------------ | -------------- |
| SSMA licensing + tooling                         | $0 (free)      |
| Migration engineering (12 FTEs x 18 months)      | $2,880,000     |
| Application modernization (CICS/IMS replacement) | $2,400,000     |
| COBOL code conversion / API creation             | $1,600,000     |
| EBCDIC conversion + data validation              | $400,000       |
| Testing + parallel operation (12 months)         | $1,200,000     |
| JCL batch modernization                          | $480,000       |
| Training (all teams)                             | $200,000       |
| **Total migration cost**                         | **$9,160,000** |

#### 5-year TCO comparison

| Year   | IBM Db2 (cumulative)                     | Azure SQL (cumulative)        |
| ------ | ---------------------------------------- | ----------------------------- |
| Year 1 | $16,191,520                              | $11,998,000 (incl. migration) |
| Year 2 | $32,383,040                              | $14,836,000                   |
| Year 3 | $48,574,560 + $15M refresh = $63,574,560 | $17,674,000                   |
| Year 4 | $79,766,080                              | $20,512,000                   |
| Year 5 | $95,957,600                              | $23,350,000                   |

**5-year savings: $72,607,600 (76%)** -- the mainframe hardware refresh avoidance in Year 3 ($15M) is the largest single contributor.

---

## Hidden costs in the IBM model

### Cost escalation factors

1. **Hardware refresh trap:** New z-series hardware increases MSU ratings, automatically increasing MLC software charges even with identical workloads.
2. **Software bundle lock-in:** IBM ELAs bundle Db2 with CICS, MQ, IMS, and z/OS. Removing one product often increases the per-product price of the remaining products.
3. **Audit exposure:** IBM LMS audits of sub-capacity and distributed licensing regularly produce findings of $500K-$2M+ in back-licensing charges.
4. **Passport Advantage complexity:** IBM's Passport Advantage licensing for LUW products has complex rules around virtualization, sub-capacity, and cloud deployment that create compliance risk.
5. **Java SE licensing:** IBM's recent changes to Java SE licensing (moving from bundled to separately priced) add cost for Db2-connected applications using Java.

### Cost factors Azure avoids

- No audit risk (consumption-based, fully metered)
- No hardware refresh trap (Microsoft manages infrastructure)
- No annual support adder (included in service price)
- No virtualization licensing complexity (vCores are vCores)
- Predictable pricing with reserved instances

---

## Cost optimization strategies on Azure

### Reserved instances

- 1-year reserved instances: 30% savings over pay-as-you-go
- 3-year reserved instances: 55% savings over pay-as-you-go
- Combine with Azure Hybrid Benefit for additional 55% savings on vCore costs

### Right-sizing

- Use Azure SQL MI Insights to monitor actual vCore utilization
- Many migrated Db2 workloads are over-provisioned on mainframe; right-size on Azure
- Consider General Purpose tier where Business Critical is not required

### Serverless for variable workloads

- Azure SQL Database serverless auto-pauses during idle periods
- Ideal for batch-oriented Db2 workloads that process during specific windows

### Dev/test pricing

- Azure Dev/Test pricing for non-production environments (50%+ discount)
- Use elastic pools to share resources across multiple test databases

---

## Migration cost factors

### One-time migration costs by complexity

| Database complexity            | SSMA conversion | Manual remediation | Application updates | Testing   | Total per database |
| ------------------------------ | --------------- | ------------------ | ------------------- | --------- | ------------------ |
| **Tier 1 (simple)**            | $5,000          | $5,000             | $10,000             | $10,000   | $30,000            |
| **Tier 2 (moderate)**          | $5,000          | $20,000            | $30,000             | $25,000   | $80,000            |
| **Tier 3 (complex)**           | $5,000          | $60,000            | $80,000             | $50,000   | $195,000           |
| **Tier 4 (z/OS coupled)**      | $10,000         | $150,000           | $200,000            | $120,000  | $480,000           |
| **Tier 5 (mainframe program)** | $10,000         | $300,000+          | $500,000+           | $250,000+ | $1,060,000+        |

### ROI acceleration strategies

1. **Start with Db2 LUW (Tier 1-2):** Fastest ROI, lowest risk, team ramp-up. Each LUW database that migrates immediately stops generating PVU-based IBM licensing costs.

2. **Replicate z/OS data to Azure (before migrating the database):** Use ADF's Db2 connector to replicate z/OS data into Azure SQL or Fabric for analytics. This provides immediate ROI from Fabric/Power BI/Azure OpenAI while the full mainframe migration program is planned.

3. **Reduce mainframe MIPS as workloads shift:** As Db2 workloads move off z/OS, reduce the LPAR capacity allocation. This lowers MLC charges for all z/OS software products, not just Db2.

4. **Negotiate IBM ELA exit terms proactively:** Engage IBM licensing before starting migration to negotiate favorable wind-down terms. Avoid triggering repricing on remaining IBM products.

### Payback period analysis

| Scenario                         | Annual IBM cost | Annual Azure cost | One-time migration cost | Payback period |
| -------------------------------- | --------------- | ----------------- | ----------------------- | -------------- |
| Small (Db2 LUW, departmental)    | $261,000        | $75,000           | $130,000                | 8 months       |
| Mid-size (z/OS + LUW enterprise) | $5,113,000      | $897,000          | $1,740,000              | 5 months       |
| Large (multi-LPAR mainframe)     | $16,192,000     | $2,838,000        | $9,160,000              | 8 months       |

Even the largest migration scenario pays back within the first year due to the dramatic cost differential between IBM mainframe licensing and Azure consumption pricing.

### Sensitivity analysis

The TCO model is most sensitive to these variables:

| Variable                              | Impact on savings                                  | Risk mitigation                                                     |
| ------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------- |
| **IBM MIPS/MSU pricing**              | +/- 20% on z/OS costs                              | Use actual SCRT reports for precise MSU pricing                     |
| **Azure vCore sizing**                | +/- 15% on Azure costs                             | Right-size based on performance testing, not mainframe capacity     |
| **Migration duration**                | +/- 25% on migration costs                         | Use complexity tiers for realistic estimation; pad 20% for unknowns |
| **Mainframe hardware refresh timing** | $8-15M swing if refresh is avoided                 | Align migration timeline to avoid the next hardware refresh cycle   |
| **IBM ELA repricing**                 | Potential $200K-$1M increase on remaining products | Negotiate exit terms before starting migration                      |
| **Staff transition**                  | +/- 10% on operational costs                       | Budget for training existing Db2 DBAs on Azure SQL                  |

---

## Conclusion

The TCO case for migrating from IBM Db2 to Azure SQL is compelling across all three federal tenant sizes. The primary cost driver is not the Azure SQL service itself -- it is the elimination of IBM's MIPS-based licensing model, the avoidance of mainframe hardware refresh cycles, and the reduction in specialist staffing. Even accounting for significant one-time migration costs, payback periods range from 8-18 months depending on the size and complexity of the Db2 estate.

---

**Maintainers:** csa-inabox core team
**Last updated:** 2026-04-30
