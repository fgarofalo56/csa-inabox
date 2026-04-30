# Oracle to Azure -- Total Cost of Ownership Analysis

**A detailed financial comparison of Oracle Database licensing versus Azure-native managed database services for federal and enterprise workloads.**

---

!!! abstract "Key finding"
Displacing Oracle Database Enterprise Edition with Azure SQL Managed Instance or Azure Database for PostgreSQL typically yields **40-70% cost reduction** over a 5-year period. The savings are driven primarily by eliminating Oracle processor licensing, the 22% annual support fee, and Oracle-specific infrastructure costs. Oracle Database@Azure reduces infrastructure costs but retains Oracle licensing, yielding **20-35% savings** through infrastructure consolidation and MACC credit application.

---

## 1. Oracle licensing cost structure

### 1.1 License and support pricing

Oracle Database pricing is processor-based with a 0.5 core factor for x86 processors. The following table shows list prices (actual negotiated prices vary by 10-30% for large accounts).

| Component                       | List price per processor license | Annual support (22%) | Notes                            |
| ------------------------------- | -------------------------------- | -------------------- | -------------------------------- |
| **Database Enterprise Edition** | $47,500                          | $10,450              | Base database engine             |
| **Database Standard Edition 2** | $17,500                          | $3,850               | Limited to 2 sockets, 16 threads |
| Real Application Clusters (RAC) | $23,000                          | $5,060               | Active-active clustering         |
| Partitioning                    | $11,500                          | $2,530               | Table/index partitioning         |
| Active Data Guard               | $11,500                          | $2,530               | Readable standby, DR             |
| Diagnostics Pack                | $7,500                           | $1,650               | AWR, ASH, ADDM                   |
| Tuning Pack                     | $5,000                           | $1,100               | SQL Tuning Advisor               |
| Advanced Security               | $15,000                          | $3,300               | TDE, data redaction              |
| Label Security / OLS            | $11,500                          | $2,530               | Row-level classification         |
| Advanced Compression            | $11,500                          | $2,530               | Table compression                |
| Spatial and Graph               | $17,500                          | $3,850               | SDO_GEOMETRY, graph analytics    |
| In-Memory                       | $23,000                          | $5,060               | Columnar in-memory               |

### 1.2 Hidden cost multipliers

| Cost category                  | Description                                                                                 | Typical annual impact               |
| ------------------------------ | ------------------------------------------------------------------------------------------- | ----------------------------------- |
| **Virtualization licensing**   | VMware/Hyper-V requires licensing entire physical host cluster, not just VMs running Oracle | 2-5x license cost increase          |
| **Audit remediation**          | Average Oracle LMS audit finding for federal agencies                                       | $500K-$5M per audit cycle           |
| **DBA labor**                  | Oracle DBA FTE cost (with clearance) for patching, RAC management, Data Guard, backups      | $180K-$250K per DBA FTE             |
| **Infrastructure**             | Physical servers, storage (Exadata or SAN), networking, data center space                   | $200K-$500K per production cluster  |
| **Oracle Enterprise Manager**  | Monitoring and management tool licensing                                                    | $5,000-$15,000 per monitored target |
| **Java SE subscription**       | Employee-based Java licensing (January 2023 change)                                         | $15/employee/month x headcount      |
| **Training and certification** | Oracle certifications, training courses                                                     | $5K-$15K per DBA per year           |
| **Disaster recovery**          | Standby hardware, Active Data Guard licensing, network connectivity                         | 40-60% of production costs          |

---

## 2. Azure target cost modeling

### 2.1 Azure SQL Managed Instance pricing

Azure SQL MI is priced by vCores, storage, and service tier. No separate database licensing -- SQL Server license is included.

| Configuration                             | vCores        | Storage       | Monthly cost   | Annual cost    | Notes                                         |
| ----------------------------------------- | ------------- | ------------- | -------------- | -------------- | --------------------------------------------- |
| **Dev/Test** (General Purpose)            | 8 vCores      | 500 GB        | $1,200         | $14,400        | Non-production                                |
| **Standard Production** (General Purpose) | 16 vCores     | 2 TB          | $3,800         | $45,600        | Standard OLTP                                 |
| **High Performance** (Business Critical)  | 32 vCores     | 4 TB          | $12,500        | $150,000       | Mission-critical OLTP, built-in read replicas |
| **Enterprise Scale** (Business Critical)  | 64 vCores     | 8 TB          | $24,000        | $288,000       | Large-scale, in-memory OLTP                   |
| **Disaster Recovery** (Geo-replication)   | Match primary | Match primary | 50% of primary | 50% of primary | Included in service                           |

**Included at no additional cost:**

- High availability (99.99% SLA)
- Automated backups (up to 35-day retention)
- Encryption at rest and in transit (TDE, TLS)
- Performance insights and query store
- Automated patching and version upgrades
- Azure Monitor integration

### 2.2 Azure Database for PostgreSQL Flexible Server pricing

| Configuration                             | vCores                              | Storage       | Monthly cost | Annual cost | Notes                           |
| ----------------------------------------- | ----------------------------------- | ------------- | ------------ | ----------- | ------------------------------- |
| **Dev/Test** (Burstable)                  | 4 vCores                            | 256 GB        | $350         | $4,200      | Non-production                  |
| **Standard Production** (General Purpose) | 16 vCores                           | 2 TB          | $2,200       | $26,400     | Standard OLTP                   |
| **High Performance** (Memory Optimized)   | 32 vCores                           | 4 TB          | $5,500       | $66,000     | Analytics-heavy, large datasets |
| **Scale-Out** (Citus)                     | 32 vCores coordinator + 4x16 worker | 8 TB total    | $9,000       | $108,000    | Multi-tenant, high concurrency  |
| **HA** (Zone-redundant)                   | Match primary                       | Match primary | 2x compute   | 2x compute  | Standby in different AZ         |

**Included at no additional cost:**

- PostgreSQL engine (open source, no license)
- Automated backups (up to 35-day retention)
- Encryption at rest and in transit
- Intelligent performance recommendations
- Extensions (PostGIS, pgvector, pg_cron, etc.)

### 2.3 Oracle Database@Azure pricing

Oracle DB@Azure combines Oracle licensing with Azure infrastructure. Pricing has two components:

| Component                   | Configuration                           | Monthly cost                | Annual cost    | Notes                                     |
| --------------------------- | --------------------------------------- | --------------------------- | -------------- | ----------------------------------------- |
| **Exadata Infrastructure**  | Quarter rack (2 DB servers + 3 storage) | $18,000                     | $216,000       | Azure infrastructure, Oracle managed      |
| **Oracle Database License** | BYOL or subscription                    | Varies (BYOL) / $8-12K/OCPU | Varies         | License cost is Oracle's, not Microsoft's |
| **Networking**              | FastConnect/ExpressRoute                | $500-$2,000                 | $6,000-$24,000 | Cross-connect between Oracle and Azure    |

**MACC credit applicability:** Oracle DB@Azure infrastructure charges count toward Microsoft Azure Consumption Commitment (MACC). Oracle license charges do _not_ count toward MACC.

---

## 3. TCO comparison scenarios

### 3.1 Scenario A: Small federal agency (5 Oracle databases)

**Current Oracle estate:**

- 5 production databases, Oracle Enterprise Edition
- 2 servers, 16 cores each (32 cores total)
- Options: Partitioning, Diagnostics Pack
- 2 Oracle DBAs (0.5 FTE each dedicated to Oracle)
- VMware virtualization (full cluster licensed)

| Cost category                         | Oracle (annual)    | Azure SQL MI (annual)      | Azure PostgreSQL (annual) |
| ------------------------------------- | ------------------ | -------------------------- | ------------------------- |
| Database licensing                    | $528,000 amortized | Included                   | Included (open source)    |
| Annual support (22%)                  | $116,160           | N/A                        | N/A                       |
| Infrastructure (servers, storage, DC) | $120,000           | Included                   | Included                  |
| DBA labor (Oracle-specific tasks)     | $100,000           | $30,000 (reduced scope)    | $30,000 (reduced scope)   |
| Monitoring tools                      | $25,000            | Included                   | Included                  |
| DR infrastructure                     | $60,000            | Included (geo-replication) | $26,400 (zone-redundant)  |
| Azure compute                         | N/A                | $228,000 (5x GP-16)        | $132,000 (5x GP-16)       |
| Azure storage (incremental)           | N/A                | Included                   | Included                  |
| **Annual total**                      | **$949,160**       | **$258,000**               | **$188,400**              |

| Metric                        | Azure SQL MI      | Azure PostgreSQL  |
| ----------------------------- | ----------------- | ----------------- |
| **Year-1 savings**            | $691,160 (73%)    | $760,760 (80%)    |
| **3-year savings**            | $2,073,480        | $2,282,280        |
| **5-year savings**            | $3,455,800        | $3,803,800        |
| **Migration cost (one-time)** | $150,000-$300,000 | $200,000-$400,000 |
| **Break-even**                | Month 3-5         | Month 4-6         |

### 3.2 Scenario B: Mid-sized federal agency (20 Oracle databases)

**Current Oracle estate:**

- 20 production databases, Enterprise Edition
- 8 servers, 32 cores each (256 cores total)
- Options: RAC, Partitioning, Active Data Guard, Diagnostics Pack, Advanced Security
- 5 Oracle DBAs (3 FTE dedicated to Oracle)
- Exadata quarter rack for top-tier databases

| Cost category               | Oracle (annual)      | Azure SQL MI (annual)    | Hybrid (SQL MI + ORA@Azure)    |
| --------------------------- | -------------------- | ------------------------ | ------------------------------ |
| Database licensing          | $4,224,000 amortized | Included                 | $1,200,000 (ORA@Azure portion) |
| Annual support (22%)        | $929,280             | N/A                      | $264,000 (ORA@Azure portion)   |
| Infrastructure              | $650,000             | Included                 | $216,000 (Exadata infra)       |
| DBA labor (Oracle-specific) | $540,000             | $180,000                 | $300,000                       |
| Monitoring / EM             | $100,000             | Included                 | $25,000                        |
| DR infrastructure           | $350,000             | Included                 | $108,000                       |
| Azure compute               | N/A                  | $1,440,000 (mixed tiers) | $960,000                       |
| **Annual total**            | **$6,793,280**       | **$1,620,000**           | **$3,073,000**                 |

| Metric                        | Full displacement (SQL MI) | Hybrid (SQL MI + ORA@Azure) |
| ----------------------------- | -------------------------- | --------------------------- |
| **Year-1 savings**            | $5,173,280 (76%)           | $3,720,280 (55%)            |
| **3-year savings**            | $15,519,840                | $11,160,840                 |
| **5-year savings**            | $25,866,400                | $18,601,400                 |
| **Migration cost (one-time)** | $800,000-$1,500,000        | $500,000-$1,000,000         |

### 3.3 Scenario C: Large federal agency (100+ Oracle databases)

**Current Oracle estate:**

- 120 production databases across 4 data centers
- 40 servers, average 48 cores each (1,920 cores total)
- Full option stack on tier-1 databases
- 15 Oracle DBAs
- Multiple Exadata racks
- Oracle GoldenGate for replication

| Cost category                | Oracle (annual)       | Hybrid displacement (annual)           |
| ---------------------------- | --------------------- | -------------------------------------- |
| Database + options licensing | $18,000,000 amortized | $4,500,000 (25% retained on ORA@Azure) |
| Annual support (22%)         | $3,960,000            | $990,000                               |
| Infrastructure               | $3,200,000            | $800,000 (Exadata infra for retained)  |
| DBA labor                    | $2,700,000            | $1,200,000                             |
| Monitoring / tooling         | $500,000              | $100,000                               |
| DR                           | $1,800,000            | $400,000                               |
| Azure compute (displaced)    | N/A                   | $4,800,000                             |
| **Annual total**             | **$30,160,000**       | **$12,790,000**                        |

| Metric                        | Hybrid displacement   |
| ----------------------------- | --------------------- |
| **Year-1 savings**            | $17,370,000 (58%)     |
| **5-year savings**            | $86,850,000           |
| **Migration cost (one-time)** | $3,000,000-$6,000,000 |

---

## 4. Audit risk quantification

Oracle licensing audits represent a material financial risk that traditional TCO analyses undercount.

### 4.1 Audit probability and impact

| Factor                        | Federal context                                                                 |
| ----------------------------- | ------------------------------------------------------------------------------- |
| Audit frequency               | Every 18-36 months for large federal accounts                                   |
| Average finding               | $500K-$5M for mid-sized agencies                                                |
| Virtualization audit findings | 60% of audits identify virtualization licensing gaps                            |
| Remediation options           | Pay back-license + support, or "upgrade" to ULA (Unlimited License Agreement)   |
| ULA exit risk                 | ULA certification process frequently results in disputes over deployment counts |

### 4.2 Risk-adjusted cost

Adding audit risk to the TCO model:

| Scenario                        | Annual audit risk (expected value) | 5-year cumulative risk |
| ------------------------------- | ---------------------------------- | ---------------------- |
| Small agency (5 databases)      | $100,000                           | $500,000               |
| Mid-sized agency (20 databases) | $400,000                           | $2,000,000             |
| Large agency (100+ databases)   | $1,500,000                         | $7,500,000             |

**Migrating off Oracle eliminates this risk entirely for displaced databases.**

---

## 5. CSA-in-a-Box cost integration

The analytics layer cost is additive regardless of database target, but displacing Oracle frees budget for analytics investment.

| CSA-in-a-Box component                | Annual cost (mid-sized agency) | What it provides                          |
| ------------------------------------- | ------------------------------ | ----------------------------------------- |
| Microsoft Fabric (F64 capacity)       | $350,000                       | OneLake, Spark, Data Warehouse, pipelines |
| Power BI Premium per user (200 users) | $240,000                       | Reports, dashboards, Copilot, Direct Lake |
| Azure Data Factory                    | $60,000                        | Orchestration, data movement              |
| Microsoft Purview                     | $80,000                        | Catalog, classifications, lineage         |
| Azure Monitor + Log Analytics         | $40,000                        | Observability, audit logging              |
| Azure AI Foundry + OpenAI             | $120,000                       | AI/ML integration                         |
| **Total CSA-in-a-Box analytics**      | **$890,000**                   | Unified analytics, governance, AI         |

For a mid-sized agency saving $5.1M/year by displacing Oracle, the CSA-in-a-Box analytics platform ($890K/year) is funded by 17% of the Oracle savings.

---

## 6. Migration cost factors

### 6.1 One-time migration costs

| Cost category                   | Small (5 DBs)    | Medium (20 DBs)   | Large (100+ DBs)    |
| ------------------------------- | ---------------- | ----------------- | ------------------- |
| Assessment and planning         | $30,000-$60,000  | $100,000-$200,000 | $300,000-$500,000   |
| Schema conversion (SSMA/ora2pg) | $50,000-$100,000 | $200,000-$400,000 | $800,000-$1,500,000 |
| Data migration                  | $20,000-$40,000  | $100,000-$200,000 | $500,000-$1,000,000 |
| Application testing             | $30,000-$60,000  | $200,000-$400,000 | $800,000-$1,500,000 |
| Performance tuning              | $10,000-$20,000  | $50,000-$100,000  | $200,000-$500,000   |
| Training and reskilling         | $10,000-$20,000  | $50,000-$100,000  | $200,000-$500,000   |
| **Total one-time**              | **$150K-$300K**  | **$700K-$1.4M**   | **$2.8M-$5.5M**     |

### 6.2 Payback period

| Scenario                   | One-time migration cost (midpoint) | Annual savings | Payback period |
| -------------------------- | ---------------------------------- | -------------- | -------------- |
| Small (to SQL MI)          | $225,000                           | $691,000       | 4 months       |
| Small (to PostgreSQL)      | $300,000                           | $761,000       | 5 months       |
| Medium (full displacement) | $1,050,000                         | $5,173,000     | 2.5 months     |
| Medium (hybrid)            | $750,000                           | $3,720,000     | 2.5 months     |
| Large (hybrid)             | $4,150,000                         | $17,370,000    | 3 months       |

---

## 7. FinOps best practices for migrated workloads

### 7.1 Azure cost optimization

- **Reserved Instances:** 1-year (30% savings) or 3-year (55% savings) reservations for steady-state databases
- **Azure Hybrid Benefit:** Apply existing SQL Server licenses to Azure SQL MI for additional savings
- **Auto-pause:** Configure dev/test databases to auto-pause during non-business hours
- **Elastic pools:** Consolidate small databases into elastic pools for shared compute
- **Storage tiering:** Use standard storage for dev/test, premium for production

### 7.2 CSA-in-a-Box cost controls

- **Fabric capacity auto-scale:** Scale Fabric capacity based on workload patterns
- **OneLake lifecycle policies:** Tier cold data to archive storage
- **Power BI per-user vs. capacity:** Use per-user licensing for < 500 users, capacity for larger deployments
- **See `docs/COST_MANAGEMENT.md`** for the full CSA-in-a-Box FinOps framework

---

## 8. Summary

| Metric                           | Oracle status quo       | Azure displacement          | Oracle DB@Azure             |
| -------------------------------- | ----------------------- | --------------------------- | --------------------------- |
| 5-year database cost (mid-sized) | $33.9M                  | $8.1M                       | $15.4M                      |
| 5-year savings                   | Baseline                | $25.8M (76%)                | $18.5M (55%)                |
| Audit risk                       | $2M (5-year expected)   | Eliminated                  | Retained (Oracle licensing) |
| DBA FTE requirement              | 5 FTE                   | 2 FTE                       | 3 FTE                       |
| HA/DR included                   | No (additional options) | Yes                         | Partial (Oracle options)    |
| Encryption included              | No ($15K/processor)     | Yes                         | No (Oracle option)          |
| Analytics integration            | Additional licensing    | Fabric Mirroring (included) | Fabric Mirroring (preview)  |

---

**Maintainers:** csa-inabox core team
**Last updated:** 2026-04-30
