# MySQL / MariaDB to Azure -- Total Cost of Ownership Analysis

**A detailed financial comparison of self-hosted MySQL and MariaDB versus Azure Database for MySQL Flexible Server for federal and enterprise workloads.**

---

!!! abstract "Key finding"
Migrating self-hosted MySQL/MariaDB to Azure Database for MySQL Flexible Server typically yields **40-60% cost reduction** over a 5-year period. The savings are driven primarily by eliminating DBA operational overhead (patching, backup management, HA configuration), infrastructure costs (servers, storage, networking, data center), and MySQL Enterprise Edition licensing (if applicable). Organizations running MariaDB on bare metal see even larger savings due to full infrastructure displacement.

---

## 1. Self-hosted MySQL/MariaDB cost structure

### 1.1 Infrastructure costs

MySQL and MariaDB are often described as "free" databases, but the infrastructure and operational costs of self-hosting are substantial.

| Cost category                      | Bare-metal / colo                       | On-premises VM (VMware)                            | Cloud VM (IaaS)                               |
| ---------------------------------- | --------------------------------------- | -------------------------------------------------- | --------------------------------------------- |
| **Server hardware** (per node)     | $8,000-$25,000 (amortized over 4 years) | N/A (shared infrastructure)                        | N/A                                           |
| **VMware licensing**               | N/A                                     | $5,000-$15,000/host/year (vSphere Enterprise Plus) | N/A                                           |
| **Cloud VM cost** (16 vCPU, 64 GB) | N/A                                     | N/A                                                | $800-$1,500/month                             |
| **Storage (SAN/NAS)** per TB       | $500-$2,000/TB/year                     | $500-$2,000/TB/year                                | $100-$300/TB/month (Premium SSD)              |
| **Network infrastructure**         | $2,000-$10,000/year per rack            | Shared                                             | Included                                      |
| **Data center space/power**        | $500-$1,500/month per rack              | Shared                                             | Included                                      |
| **OS licensing** (RHEL/Windows)    | $800-$2,500/server/year                 | $800-$2,500/VM/year                                | Included (Linux) or $100-$200/month (Windows) |
| **Backup storage**                 | $200-$800/TB/year                       | $200-$800/TB/year                                  | $50-$100/TB/month                             |
| **DR site**                        | 40-60% of production costs              | 40-60% of production costs                         | VM + storage costs                            |

### 1.2 MySQL Enterprise Edition licensing (if applicable)

Organizations running MySQL Enterprise Edition face significant per-socket licensing costs:

| Component                        | Annual subscription per socket | Notes                                 |
| -------------------------------- | ------------------------------ | ------------------------------------- |
| **MySQL Enterprise Edition**     | $5,000-$10,000                 | Per-socket, includes Standard support |
| **MySQL Enterprise Monitor**     | Included with Enterprise       | Monitoring and advisors               |
| **MySQL Enterprise Backup**      | Included with Enterprise       | Hot backup for InnoDB                 |
| **MySQL Enterprise Audit**       | Included with Enterprise       | Audit logging                         |
| **MySQL Enterprise Encryption**  | Included with Enterprise       | At-rest encryption                    |
| **MySQL Enterprise Thread Pool** | Included with Enterprise       | Connection management                 |
| **MySQL Enterprise Firewall**    | Included with Enterprise       | SQL injection protection              |
| **MySQL Cluster CGE**            | $10,000/socket                 | NDB Cluster carrier grade             |
| **Premium Support**              | Additional 50%                 | 24/7 with 30-minute response          |

For a 4-server cluster (2 primary + 2 DR) with dual sockets: $40,000-$80,000/year for Enterprise Edition subscriptions alone.

### 1.3 DBA labor costs

| DBA role                                    | Annual fully loaded cost        | Coverage                                    |
| ------------------------------------------- | ------------------------------- | ------------------------------------------- |
| **Senior MySQL DBA** (US, non-cleared)      | $140,000-$180,000               | 10-25 instances                             |
| **Senior MySQL DBA** (US, Secret clearance) | $170,000-$220,000               | 10-25 instances                             |
| **Senior MySQL DBA** (US, TS/SCI clearance) | $200,000-$260,000               | 10-25 instances                             |
| **Junior/Mid MySQL DBA**                    | $90,000-$130,000                | 5-15 instances                              |
| **On-call coverage** (after-hours)          | $15,000-$30,000/year per person | Weekends, holidays, nights                  |
| **Training and certification**              | $3,000-$8,000/year per DBA      | MySQL certifications, conference attendance |

A typical mid-sized MySQL estate (15-25 instances) requires 1.5-2.5 DBA FTEs. At federal salary scales with clearance requirements, this represents $300,000-$600,000/year in labor costs before considering management overhead, benefits, and attrition costs.

### 1.4 Operational overhead costs

| Cost category                 | Annual estimate | Notes                                                   |
| ----------------------------- | --------------- | ------------------------------------------------------- |
| **Backup infrastructure**     | $10,000-$50,000 | Backup servers, tape/cloud storage, management software |
| **Monitoring infrastructure** | $5,000-$25,000  | Prometheus/Grafana or Datadog/New Relic licensing       |
| **HA proxy/load balancer**    | $3,000-$15,000  | ProxySQL, HAProxy, or MySQL Router infrastructure       |
| **Replication management**    | $5,000-$10,000  | Scripts, monitoring, failover automation tooling        |
| **Security scanning**         | $5,000-$20,000  | Vulnerability scanning, penetration testing             |
| **Compliance audit**          | $10,000-$50,000 | Annual compliance assessments, documentation            |
| **Incident response**         | $10,000-$50,000 | MTTR costs, customer impact, root cause analysis        |
| **Capacity planning tools**   | $2,000-$10,000  | Forecasting and planning tools                          |

---

## 2. Azure Database for MySQL Flexible Server pricing

### 2.1 Compute pricing by tier

Azure MySQL Flexible Server pricing is based on compute tier, vCores, and region. Prices shown are for East US (commercial) and US Gov Virginia (government) regions with pay-as-you-go pricing.

| Tier / SKU                    | vCores | RAM    | Monthly cost (East US) | Monthly cost (Gov) | Best for                    |
| ----------------------------- | ------ | ------ | ---------------------- | ------------------ | --------------------------- |
| **Burstable B1ms**            | 1      | 2 GB   | ~$15                   | ~$18               | Dev/test, low-traffic apps  |
| **Burstable B2s**             | 2      | 4 GB   | ~$30                   | ~$36               | Light dev/test              |
| **Burstable B2ms**            | 2      | 8 GB   | ~$55                   | ~$66               | Small production, WordPress |
| **Burstable B4ms**            | 4      | 16 GB  | ~$110                  | ~$132              | Small-medium production     |
| **Burstable B8ms**            | 8      | 32 GB  | ~$220                  | ~$264              | Medium production           |
| **Burstable B12ms**           | 12     | 48 GB  | ~$330                  | ~$396              | Medium production           |
| **Burstable B16ms**           | 16     | 64 GB  | ~$440                  | ~$528              | Medium-large production     |
| **Burstable B20ms**           | 20     | 80 GB  | ~$550                  | ~$660              | Large burstable             |
| **General Purpose D2ds_v4**   | 2      | 8 GB   | ~$125                  | ~$150              | Small production OLTP       |
| **General Purpose D4ds_v4**   | 4      | 16 GB  | ~$250                  | ~$300              | Standard production         |
| **General Purpose D8ds_v4**   | 8      | 32 GB  | ~$500                  | ~$600              | Standard production         |
| **General Purpose D16ds_v4**  | 16     | 64 GB  | ~$1,000                | ~$1,200            | Large production OLTP       |
| **General Purpose D32ds_v4**  | 32     | 128 GB | ~$2,000                | ~$2,400            | Enterprise OLTP             |
| **General Purpose D48ds_v4**  | 48     | 192 GB | ~$3,000                | ~$3,600            | Large enterprise            |
| **General Purpose D64ds_v4**  | 64     | 256 GB | ~$4,000                | ~$4,800            | Enterprise scale            |
| **Memory Optimized E2ds_v4**  | 2      | 16 GB  | ~$170                  | ~$204              | Small analytics/caching     |
| **Memory Optimized E4ds_v4**  | 4      | 32 GB  | ~$340                  | ~$408              | Analytics workloads         |
| **Memory Optimized E8ds_v4**  | 8      | 64 GB  | ~$680                  | ~$816              | Large buffer pool           |
| **Memory Optimized E16ds_v4** | 16     | 128 GB | ~$1,360                | ~$1,632            | Enterprise analytics        |
| **Memory Optimized E32ds_v4** | 32     | 256 GB | ~$2,720                | ~$3,264            | Large-scale analytics       |
| **Memory Optimized E48ds_v4** | 48     | 384 GB | ~$4,080                | ~$4,896            | Enterprise caching          |
| **Memory Optimized E64ds_v4** | 64     | 512 GB | ~$5,440                | ~$6,528            | Maximum memory              |

### 2.2 Storage pricing

| Storage type              | Price per GB/month                                        | IOPS                 | Notes                       |
| ------------------------- | --------------------------------------------------------- | -------------------- | --------------------------- |
| **Premium SSD (default)** | ~$0.115                                                   | 3 IOPS/GB (baseline) | Auto-grow available         |
| **Pre-provisioned IOPS**  | ~$0.05 per additional IOPS                                | Up to 80,000 IOPS    | Independent of storage size |
| **Backup storage**        | Free up to 100% of provisioned storage; ~$0.095/GB beyond | N/A                  | 1-35 day retention          |

### 2.3 High availability pricing

Zone-redundant HA doubles the compute cost (standby server in a different AZ) but does not double storage (shared storage layer). HA adds approximately:

| HA type               | Additional cost  | SLA    |
| --------------------- | ---------------- | ------ |
| **No HA**             | $0               | 99.9%  |
| **Same-zone HA**      | ~100% of compute | 99.99% |
| **Zone-redundant HA** | ~100% of compute | 99.99% |

### 2.4 Reserved capacity discounts

| Reservation term    | Discount vs pay-as-you-go |
| ------------------- | ------------------------- |
| **1-year reserved** | ~30-40%                   |
| **3-year reserved** | ~55-65%                   |

---

## 3. Side-by-side cost comparison

### 3.1 Small workload (single application, 2 databases)

| Cost item               | Self-hosted (VM)                             | Azure MySQL Flexible Server         |
| ----------------------- | -------------------------------------------- | ----------------------------------- |
| **Compute**             | 1 VM (4 vCPU, 16 GB): $300/month             | General Purpose D4ds_v4: $250/month |
| **Storage** (200 GB)    | Premium SSD: $30/month                       | Premium SSD: $23/month              |
| **HA**                  | Second VM: $300/month + ProxySQL: $100/month | Zone-redundant HA: $250/month       |
| **Backup**              | Backup VM + storage: $150/month              | Included (up to server size)        |
| **DBA labor** (0.1 FTE) | $1,500/month                                 | $0 (managed)                        |
| **Monitoring**          | Datadog/Grafana: $50/month                   | Included (Azure Monitor)            |
| **OS patching**         | Labor: $200/month                            | Included                            |
| **MySQL patching**      | Labor: $200/month                            | Included                            |
| **Total monthly**       | **$2,830/month**                             | **$523/month**                      |
| **Total annual**        | **$33,960/year**                             | **$6,276/year**                     |
| **3-year total**        | **$101,880**                                 | **$18,828**                         |
| **Savings**             | --                                           | **$83,052 (81%)**                   |

### 3.2 Medium workload (5-10 databases, production OLTP)

| Cost item                            | Self-hosted (bare metal)                          | Azure MySQL Flexible Server                |
| ------------------------------------ | ------------------------------------------------- | ------------------------------------------ |
| **Compute**                          | 2 servers (16 cores each): $1,200/month amortized | 2x GP D16ds_v4: $2,000/month               |
| **Storage** (2 TB)                   | SAN: $800/month                                   | Premium SSD: $230/month                    |
| **HA**                               | 2 replica servers: $1,200/month                   | Zone-redundant HA: $2,000/month            |
| **DR**                               | Off-site replicas: $1,500/month                   | Cross-region read replica: $1,000/month    |
| **Backup**                           | Backup infrastructure: $500/month                 | Included                                   |
| **DBA labor** (1.0 FTE)              | $15,000/month                                     | $2,000/month (optimization only, 0.15 FTE) |
| **MySQL Enterprise** (if applicable) | $3,500/month (8 sockets)                          | $0 (Community included)                    |
| **Monitoring**                       | $300/month                                        | Included                                   |
| **Data center**                      | $1,000/month                                      | Included                                   |
| **Compliance**                       | $1,000/month (audit prep)                         | Included (inherited)                       |
| **Total monthly**                    | **$26,000/month**                                 | **$7,230/month**                           |
| **Total annual**                     | **$312,000/year**                                 | **$86,760/year**                           |
| **3-year total**                     | **$936,000**                                      | **$260,280**                               |
| **Savings**                          | --                                                | **$675,720 (72%)**                         |

### 3.3 Large workload (20+ databases, enterprise)

| Cost item                            | Self-hosted (data center)                         | Azure MySQL Flexible Server                    |
| ------------------------------------ | ------------------------------------------------- | ---------------------------------------------- |
| **Compute**                          | 8 servers (32 cores each): $5,000/month amortized | 4x GP D32ds_v4 + 2x MO E16ds_v4: $10,720/month |
| **Storage** (10 TB)                  | SAN + tiered storage: $3,000/month                | Premium SSD + IOPS: $1,500/month               |
| **HA**                               | Replica fleet: $5,000/month                       | Zone-redundant HA: $10,720/month               |
| **DR**                               | DR site: $8,000/month                             | Cross-region replicas: $5,000/month            |
| **Backup**                           | Backup infrastructure: $2,000/month               | Included                                       |
| **DBA labor** (2.5 FTE, cleared)     | $45,000/month                                     | $8,000/month (0.5 FTE optimization)            |
| **MySQL Enterprise** (if applicable) | $7,000/month (16 sockets)                         | $0                                             |
| **Monitoring**                       | $1,500/month                                      | Included                                       |
| **Data center**                      | $3,000/month                                      | Included                                       |
| **Network**                          | $2,000/month                                      | VNet: $500/month                               |
| **Compliance**                       | $3,000/month                                      | Included                                       |
| **Total monthly**                    | **$85,500/month**                                 | **$36,440/month**                              |
| **Total annual**                     | **$1,026,000/year**                               | **$437,280/year**                              |
| **3-year total**                     | **$3,078,000**                                    | **$1,311,840**                                 |
| **5-year total**                     | **$5,130,000**                                    | **$2,186,400**                                 |
| **5-year savings**                   | --                                                | **$2,943,600 (57%)**                           |

### 3.4 With reserved capacity (3-year reservation)

Applying 3-year reserved capacity pricing to the large workload scenario:

| Item               | Pay-as-you-go (3 years) | 3-year reserved              | Savings             |
| ------------------ | ----------------------- | ---------------------------- | ------------------- |
| Compute + HA       | $770,880                | ~$308,352                    | 60%                 |
| Storage + IOPS     | $54,000                 | $54,000                      | 0% (no reservation) |
| Other costs        | $487,960                | $487,960                     | 0%                  |
| **3-year total**   | **$1,311,840**          | **$849,312**                 | **35% additional**  |
| **vs self-hosted** | --                      | **$2,228,688 savings (72%)** | --                  |

---

## 4. Migration cost factors

### 4.1 One-time migration costs

| Activity                                    | Estimated cost  | Notes                                           |
| ------------------------------------------- | --------------- | ----------------------------------------------- |
| **Assessment and planning**                 | $10,000-$30,000 | Discovery, complexity scoring, target selection |
| **Schema conversion** (MySQL to MySQL)      | $2,000-$10,000  | Minimal for same-engine migration               |
| **Schema conversion** (MySQL to PostgreSQL) | $20,000-$80,000 | pgloader + manual stored procedure conversion   |
| **Data migration tooling**                  | $5,000-$15,000  | Azure DMS, mydumper/myloader, testing           |
| **Application code changes**                | $5,000-$50,000  | Connection strings, query adjustments, testing  |
| **Performance testing**                     | $5,000-$15,000  | Baseline comparison, optimization               |
| **Training**                                | $3,000-$10,000  | Azure MySQL administration training             |
| **Parallel-run costs**                      | $5,000-$20,000  | Running both source and target during cutover   |

### 4.2 Total migration investment by complexity

| Complexity                                             | One-time migration cost | Payback period |
| ------------------------------------------------------ | ----------------------- | -------------- |
| **Simple** (1-5 databases, MySQL to MySQL)             | $20,000-$50,000         | 2-4 months     |
| **Moderate** (5-20 databases, some stored procedures)  | $50,000-$150,000        | 4-8 months     |
| **Complex** (20+ databases, engine switch, compliance) | $150,000-$400,000       | 6-14 months    |

---

## 5. Hidden cost savings

### 5.1 Costs eliminated by Azure managed service

| Eliminated cost                  | Annual value                   | Why                                                                |
| -------------------------------- | ------------------------------ | ------------------------------------------------------------------ |
| **Unplanned downtime**           | $50,000-$500,000               | Azure HA SLA (99.99%) vs self-managed MySQL (typically 99.5-99.9%) |
| **Security incident response**   | $25,000-$250,000               | Azure Defender, automated patching reduce attack surface           |
| **Compliance audit preparation** | $10,000-$50,000                | Inherited certifications (FedRAMP, HIPAA, SOC)                     |
| **Hardware refresh cycles**      | $50,000-$200,000 every 4 years | No hardware to refresh                                             |
| **MySQL vulnerability patching** | $5,000-$20,000 per incident    | Automated patching eliminates emergency maintenance                |
| **DBA attrition and hiring**     | $30,000-$80,000 per hire       | Reduced DBA headcount lowers hiring exposure                       |

### 5.2 Strategic value (harder to quantify)

- **Time-to-market:** New database instances in minutes vs weeks for hardware procurement
- **Innovation velocity:** DBAs focus on data modeling and optimization vs infrastructure maintenance
- **Analytics integration:** Fabric Mirroring and ADF pipelines enable analytics that self-hosted MySQL cannot natively provide
- **AI readiness:** Direct path from MySQL data to Azure OpenAI and AI Foundry through CSA-in-a-Box

---

## 6. TCO calculator inputs

Use the [Azure TCO Calculator](https://azure.microsoft.com/en-us/pricing/tco/calculator/) with these inputs for your MySQL estate:

| Input                         | Where to find it                                                        | Notes                                     |
| ----------------------------- | ----------------------------------------------------------------------- | ----------------------------------------- |
| **Number of servers**         | MySQL instance inventory                                                | Count primary + replica + DR              |
| **Cores per server**          | `SHOW VARIABLES LIKE 'thread_concurrency'` or OS `nproc`                | Physical or virtual cores                 |
| **RAM per server**            | `SHOW VARIABLES LIKE 'innodb_buffer_pool_size'`                         | Size the Azure tier to match buffer pool  |
| **Storage per server**        | `SELECT SUM(data_length + index_length) FROM information_schema.tables` | Include growth projection                 |
| **IOPS requirements**         | `iostat` or MySQL Performance Schema                                    | Peak IOPS, not average                    |
| **DBA FTE count**             | HR records                                                              | Include contractors                       |
| **DBA salary**                | HR records                                                              | Fully loaded cost with benefits           |
| **MySQL Enterprise licenses** | Oracle/MySQL contract                                                   | Annual subscription cost                  |
| **Infrastructure costs**      | Finance records                                                         | Servers, storage, networking, data center |
| **Backup costs**              | Finance records                                                         | Storage, software, testing                |
| **HA/DR costs**               | Finance records                                                         | Replica servers, DR site, network         |

---

**Next:** [Feature Mapping](feature-mapping-complete.md) | [Flexible Server Migration](flexible-server-migration.md) | [Migration Playbook](../mysql-to-azure.md)

---

**Maintainers:** csa-inabox core team
**Last updated:** 2026-04-30
