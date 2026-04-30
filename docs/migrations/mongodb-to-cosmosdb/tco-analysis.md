# Total Cost of Ownership: MongoDB vs Azure Cosmos DB

**Audience:** CFO, CTO, Procurement leads, and platform architects evaluating the financial case for migrating from MongoDB (Atlas or self-hosted) to Azure Cosmos DB for MongoDB.

---

## Executive summary

This document provides a detailed total cost of ownership (TCO) analysis comparing MongoDB Atlas (M10 through M700 tiers), self-hosted MongoDB (Community and Enterprise), and Azure Cosmos DB for MongoDB (vCore and RU-based models). The analysis covers compute, storage, network egress, backup, monitoring, management overhead, and migration costs across three reference architectures: small (startup/dev), medium (departmental), and large (enterprise/federal).

**Key finding:** For Azure-committed organizations, Cosmos DB typically delivers 30--50% TCO savings compared to Atlas at equivalent workload sizes, driven primarily by the elimination of cross-platform management overhead, native backup/PITR inclusion, and the platform integration value of analytical store and Purview governance at no incremental Cosmos DB cost.

---

## 1. Pricing model comparison

### MongoDB Atlas pricing structure

Atlas uses a cluster-based pricing model. Costs are driven by:

| Cost component            | How it is billed                                                                                  |
| ------------------------- | ------------------------------------------------------------------------------------------------- |
| **Compute**               | Per instance tier (M10--M700), per hour, per node. 3-node minimum for replica sets.               |
| **Storage**               | Included storage varies by tier; additional storage billed per GB/month.                          |
| **Data transfer**         | Cross-region replication: per GB. Internet egress: per GB (cloud provider rates).                 |
| **Backup**                | Continuous backup included for dedicated clusters. Additional cost for extended retention.        |
| **Atlas Search**          | Billed per search node (separate from database nodes).                                            |
| **Atlas Data Federation** | Per GB scanned.                                                                                   |
| **Atlas App Services**    | Per request, per sync operation, per compute hour.                                                |
| **Support**               | Free (community), Developer ($29/month), Standard (included with M10+), Premium (custom pricing). |

### Cosmos DB for MongoDB (RU-based) pricing structure

| Cost component               | How it is billed                                                            |
| ---------------------------- | --------------------------------------------------------------------------- |
| **Throughput (provisioned)** | Per 100 RU/s per hour. Manual or autoscale (10x range, billed at peak).     |
| **Throughput (serverless)**  | Per million RU consumed ($0.282 per million RU).                            |
| **Storage**                  | Per GB/month ($0.25/GB transactional; $0.02/GB analytical store).           |
| **Data transfer**            | Cross-region replication: per GB. Egress to internet: per GB (Azure rates). |
| **Backup**                   | Periodic (free, 2 copies) or continuous (additional cost for PITR).         |
| **Dedicated gateway**        | Optional, per-node per-hour (for integrated cache).                         |
| **Analytical store**         | Storage: $0.02/GB/month. No additional compute for auto-sync.               |

### Cosmos DB for MongoDB vCore pricing structure

| Cost component    | How it is billed                                                               |
| ----------------- | ------------------------------------------------------------------------------ |
| **Compute**       | Per vCore per hour. Burstable, General Purpose, or Memory Optimized tiers.     |
| **Storage**       | Per GB/month (included storage varies by tier; additional at $0.115/GB/month). |
| **HA replica**    | Optional, per node (same tier pricing as primary).                             |
| **Backup**        | Included (35-day retention for free tier; configurable for paid tiers).        |
| **Data transfer** | Egress to internet: per GB (Azure rates).                                      |

### Self-hosted MongoDB pricing structure

| Cost component                 | How it is billed                                                                         |
| ------------------------------ | ---------------------------------------------------------------------------------------- |
| **Compute**                    | VM or bare-metal cost. 3 VMs minimum for replica set.                                    |
| **Storage**                    | Managed disk or SAN cost. Premium SSD recommended for production.                        |
| **MongoDB Enterprise license** | Per-server subscription (contact MongoDB for pricing; typically $10K--$30K/server/year). |
| **DBA/operations staff**       | FTE cost for patching, monitoring, backup management, scaling, incident response.        |
| **Monitoring**                 | Ops Manager license (included with Enterprise) or third-party (Datadog, Prometheus).     |
| **Backup**                     | Ops Manager backup or manual scripting (mongodump + storage).                            |
| **Networking**                 | VPN/ExpressRoute for secure connectivity. Load balancer for mongos routing.              |

---

## 2. Reference architecture sizing

### Small (startup / dev team)

| Parameter                | Value         |
| ------------------------ | ------------- |
| Collections              | 5--10         |
| Document count           | 5 million     |
| Data size                | 10 GB         |
| Peak throughput          | 1,000 ops/sec |
| Regions                  | 1             |
| Availability requirement | 99.9%         |

### Medium (departmental / line-of-business)

| Parameter                | Value            |
| ------------------------ | ---------------- |
| Collections              | 20--50           |
| Document count           | 100 million      |
| Data size                | 500 GB           |
| Peak throughput          | 10,000 ops/sec   |
| Regions                  | 2 (primary + DR) |
| Availability requirement | 99.99%           |

### Large (enterprise / federal)

| Parameter                | Value                                    |
| ------------------------ | ---------------------------------------- |
| Collections              | 100+                                     |
| Document count           | 2 billion                                |
| Data size                | 5 TB                                     |
| Peak throughput          | 100,000 ops/sec                          |
| Regions                  | 3 (primary + 2 secondaries, multi-write) |
| Availability requirement | 99.999%                                  |

---

## 3. Cost comparison: small architecture

### MongoDB Atlas (M30 cluster)

| Component                        | Monthly cost | Annual cost |
| -------------------------------- | ------------ | ----------- |
| M30 cluster (3-node replica set) | $540         | $6,480      |
| Storage (10 GB included)         | $0           | $0          |
| Continuous backup                | Included     | Included    |
| Atlas Search (1 node)            | $60          | $720        |
| Data transfer (minimal)          | $10          | $120        |
| **Total**                        | **$610**     | **$7,320**  |

### Cosmos DB for MongoDB vCore (Burstable)

| Component                           | Monthly cost | Annual cost |
| ----------------------------------- | ------------ | ----------- |
| Burstable tier (2 vCores, 8 GB RAM) | $52          | $624        |
| HA replica                          | $52          | $624        |
| Storage (32 GB included)            | $0           | $0          |
| Backup (included)                   | $0           | $0          |
| Data transfer (minimal)             | $5           | $60         |
| **Total**                           | **$109**     | **$1,308**  |

### Cosmos DB for MongoDB (RU-based, serverless)

| Component                                    | Monthly cost | Annual cost |
| -------------------------------------------- | ------------ | ----------- |
| Serverless RU consumption (~2M requests/day) | $85          | $1,020      |
| Storage (10 GB)                              | $2.50        | $30         |
| Analytical store (10 GB)                     | $0.20        | $2.40       |
| Backup (periodic, free)                      | $0           | $0          |
| Data transfer (minimal)                      | $5           | $60         |
| **Total**                                    | **$93**      | **$1,112**  |

### Small architecture summary

| Platform                    | Annual cost | vs Atlas |
| --------------------------- | ----------- | -------- |
| Atlas M30                   | $7,320      | baseline |
| Cosmos DB vCore (Burstable) | $1,308      | **-82%** |
| Cosmos DB RU (Serverless)   | $1,112      | **-85%** |

The serverless tier is particularly advantageous for small workloads with intermittent traffic. Atlas's minimum cluster tier (M10 at ~$60/month) still requires 3-node provisioning, while Cosmos DB serverless charges only for consumed operations.

---

## 4. Cost comparison: medium architecture

### MongoDB Atlas (M50 cluster, 2 regions)

| Component                                             | Monthly cost | Annual cost |
| ----------------------------------------------------- | ------------ | ----------- |
| M50 primary cluster (3-node, us-east)                 | $1,620       | $19,440     |
| M50 secondary cluster (3-node, us-west, read replica) | $1,620       | $19,440     |
| Storage (500 GB, ~$0.25/GB above included)            | $80          | $960        |
| Cross-region replication transfer                     | $150         | $1,800      |
| Continuous backup                                     | Included     | Included    |
| Atlas Search (2 nodes)                                | $240         | $2,880      |
| Atlas Data Federation (50 GB scanned/month)           | $25          | $300        |
| **Total**                                             | **$3,735**   | **$44,820** |

### Cosmos DB for MongoDB vCore (General Purpose)

| Component                             | Monthly cost | Annual cost |
| ------------------------------------- | ------------ | ----------- |
| General Purpose (8 vCores, 64 GB RAM) | $832         | $9,984      |
| HA replica                            | $832         | $9,984      |
| Storage (512 GB)                      | $59          | $708        |
| Backup (included)                     | $0           | $0          |
| Data transfer                         | $50          | $600        |
| **Total**                             | **$1,773**   | **$21,276** |

### Cosmos DB for MongoDB (RU-based, autoscale)

| Component                                      | Monthly cost | Annual cost |
| ---------------------------------------------- | ------------ | ----------- |
| Autoscale throughput (10K--100K RU/s, avg 30K) | $2,190       | $26,280     |
| Storage (500 GB, transactional)                | $125         | $1,500      |
| Analytical store (500 GB)                      | $10          | $120        |
| Second region (read, 30K RU/s avg)             | $2,190       | $26,280     |
| Cross-region replication transfer              | $100         | $1,200      |
| Continuous backup (PITR)                       | $100         | $1,200      |
| **Total**                                      | **$4,715**   | **$56,580** |

### Medium architecture summary

| Platform                            | Annual cost | vs Atlas |
| ----------------------------------- | ----------- | -------- |
| Atlas M50 (2 regions)               | $44,820     | baseline |
| Cosmos DB vCore (GP)                | $21,276     | **-53%** |
| Cosmos DB RU (autoscale, 2 regions) | $56,580     | +26%     |

At medium scale, the choice between vCore and RU-based is consequential. vCore wins on cost for workloads that do not require multi-region writes. RU-based costs more but delivers globally distributed writes, analytical store, and change feed -- capabilities that would require additional Atlas services (Data Federation, Charts, custom CDC) to approximate.

**When RU-based cost is justified:** If the organization values analytical store (eliminating a separate analytics pipeline costing $20K--$40K/year), change feed to Fabric (replacing custom CDC), and global writes, the total platform cost tilts in favor of RU-based.

---

## 5. Cost comparison: large architecture

### MongoDB Atlas (M200 cluster, 3 regions)

| Component                                  | Monthly cost | Annual cost  |
| ------------------------------------------ | ------------ | ------------ |
| M200 primary cluster (3-node, us-gov-east) | $10,800      | $129,600     |
| M200 secondary clusters (2 x 3-node)       | $21,600      | $259,200     |
| Storage (5 TB, ~$0.25/GB above included)   | $1,000       | $12,000      |
| Cross-region replication (3 regions)       | $1,200       | $14,400      |
| Continuous backup + extended retention     | $500         | $6,000       |
| Atlas Search (6 nodes)                     | $1,440       | $17,280      |
| Atlas Data Federation                      | $200         | $2,400       |
| Atlas App Services (triggers, functions)   | $300         | $3,600       |
| Premium support                            | $2,500       | $30,000      |
| **Total**                                  | **$39,540**  | **$474,480** |

### Cosmos DB for MongoDB vCore (Memory Optimized)

| Component                                                | Monthly cost | Annual cost  |
| -------------------------------------------------------- | ------------ | ------------ |
| Memory Optimized (32 vCores, 256 GB RAM, 2-node cluster) | $6,656       | $79,872      |
| HA replica (per node)                                    | $6,656       | $79,872      |
| Storage (5 TB)                                           | $575         | $6,900       |
| Backup (included)                                        | $0           | $0           |
| Data transfer                                            | $200         | $2,400       |
| **Total**                                                | **$14,087**  | **$169,044** |

### Cosmos DB for MongoDB (RU-based, autoscale, 3 regions)

| Component                                      | Monthly cost | Annual cost  |
| ---------------------------------------------- | ------------ | ------------ |
| Autoscale throughput (100K--1M RU/s, avg 300K) | $21,900      | $262,800     |
| Storage (5 TB, transactional)                  | $1,250       | $15,000      |
| Analytical store (5 TB)                        | $100         | $1,200       |
| Additional regions (2 x 300K avg RU/s)         | $43,800      | $525,600     |
| Cross-region replication transfer              | $800         | $9,600       |
| Continuous backup (PITR)                       | $500         | $6,000       |
| **Total**                                      | **$68,350**  | **$820,200** |

### Large architecture summary

| Platform                                             | Annual cost | vs Atlas |
| ---------------------------------------------------- | ----------- | -------- |
| Atlas M200 (3 regions)                               | $474,480    | baseline |
| Cosmos DB vCore (Memory Optimized)                   | $169,044    | **-64%** |
| Cosmos DB RU (autoscale, 3 regions with multi-write) | $820,200    | +73%     |

At large scale, the cost divergence between vCore and RU-based is dramatic. **vCore delivers 64% savings** over Atlas for workloads that can consolidate into a single-region primary with HA. **RU-based costs more** when provisioning multi-write across three regions at high throughput -- the premium buys 99.999% SLA, automatic failover, and analytical store at planetary scale.

**Critical consideration for federal:** If the workload does not require multi-region multi-write, vCore is the clear cost winner. Reserve RU-based multi-region for workloads that genuinely need sub-10ms latency from multiple geographies simultaneously.

---

## 6. Self-hosted MongoDB cost analysis

Self-hosted MongoDB costs are highly variable, but a representative medium-scale deployment:

| Component                                | Monthly cost | Annual cost  |
| ---------------------------------------- | ------------ | ------------ |
| Azure VMs (3 x Standard_E8s_v5)          | $1,824       | $21,888      |
| Premium SSD (3 x P40, 2 TB)              | $870         | $10,440      |
| MongoDB Enterprise license (3 servers)   | $2,500       | $30,000      |
| DBA time (0.5 FTE at $150K fully loaded) | $6,250       | $75,000      |
| Monitoring (Ops Manager or Datadog)      | $200         | $2,400       |
| Backup storage (Azure Blob)              | $50          | $600         |
| Networking (Private Link, load balancer) | $100         | $1,200       |
| **Total**                                | **$11,794**  | **$141,528** |

**Comparison:**

| Platform                        | Annual cost |
| ------------------------------- | ----------- |
| Self-hosted Enterprise (medium) | $141,528    |
| Atlas M50 (medium)              | $44,820     |
| Cosmos DB vCore GP (medium)     | $21,276     |

Self-hosted is the most expensive option once DBA labor is factored in. The 0.5 FTE estimate is conservative -- patching, upgrades, capacity planning, incident response, and backup validation consume significant operations time. For organizations already paying for DBA staff, the marginal cost is lower, but the opportunity cost of those DBAs not working on higher-value activities remains.

---

## 7. Hidden costs frequently missed

### MongoDB Atlas hidden costs

| Hidden cost                     | Impact                                                                                                             |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| **Cross-cloud egress**          | If Atlas runs on AWS but analytics are on Azure, egress charges apply to every byte transferred ($0.08--$0.12/GB). |
| **Atlas Search node sizing**    | Search nodes are billed separately. High-volume search workloads can double the Atlas bill.                        |
| **Atlas Data Federation scans** | Charged per GB scanned, not per GB returned. Inefficient queries over large datasets are expensive.                |
| **Private endpoint cost**       | AWS PrivateLink or Azure Private Link charges for Atlas endpoints.                                                 |
| **Atlas Triggers compute**      | App Services compute is billed per hour when triggers are active.                                                  |
| **Multi-cloud premium**         | Running Atlas across multiple cloud providers incurs premium pricing.                                              |

### Cosmos DB hidden costs

| Hidden cost                   | Impact                                                                                                       |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **RU underestimation**        | If autoscale peak is too low, requests get throttled (429 errors). If too high, you pay for unused capacity. |
| **Cross-region replication**  | Each additional region multiplies RU cost (write to 3 regions = 3x write RU cost).                           |
| **Indexing RU cost**          | Default "all properties" indexing consumes RUs on every write. Targeted indexing reduces cost by 20--50%.    |
| **Large document overhead**   | Documents > 100 KB consume disproportionately more RUs per operation.                                        |
| **Continuous backup premium** | PITR adds ~20--25% to storage cost. Periodic backup is free but has lower granularity.                       |

---

## 8. Five-year TCO projection (medium architecture)

| Year                     | Atlas M50    | Cosmos DB vCore | Cosmos DB RU | Self-hosted  |
| ------------------------ | ------------ | --------------- | ------------ | ------------ |
| Year 1 (incl. migration) | $59,820      | $36,276         | $71,580      | $141,528     |
| Year 2                   | $46,761      | $22,338         | $59,409      | $148,604     |
| Year 3                   | $48,864      | $23,455         | $62,279      | $156,034     |
| Year 4                   | $51,064      | $24,628         | $65,293      | $163,836     |
| Year 5                   | $53,367      | $25,859         | $68,458      | $172,028     |
| **5-year total**         | **$259,876** | **$132,556**    | **$327,019** | **$782,030** |

Assumptions: 4.5% annual growth in data volume and throughput. 5% annual price increases for self-hosted (labor + licensing). Atlas and Cosmos DB pricing assumed stable (historically, cloud database prices trend downward). Migration cost of $15,000 included in Year 1 for Cosmos DB (tooling, testing, validation). Self-hosted includes 5% annual DBA cost increase.

---

## 9. Cost optimization strategies for Cosmos DB

### RU-based optimization

1. **Right-size autoscale ranges** -- set minimum at steady-state, maximum at 10x. Monitor actual RU consumption for 2 weeks before optimizing.
2. **Targeted indexing policy** -- exclude properties that are never queried. Reduces write RU cost by 20--50%.
3. **Partition key optimization** -- even distribution across partitions prevents hot-partition throttling and wasted capacity.
4. **Materialized views via change feed** -- pre-compute expensive aggregations into a separate container, reducing read RU per query.
5. **Serverless for dev/test** -- use serverless tier for non-production environments. Zero cost when idle.
6. **Reserved capacity** -- 1-year (20% discount) or 3-year (35% discount) reserved capacity for predictable production workloads.

### vCore optimization

1. **Burstable tier for dev/test** -- $26/month vs $104/month for General Purpose.
2. **Right-size vCores** -- monitor CPU and memory utilization; downsize if consistently below 30%.
3. **Free tier** -- 32 GB storage, burstable compute, free forever. Ideal for prototyping.
4. **HA replica only for production** -- skip HA replica for dev/test to halve compute cost.

---

## 10. Migration cost estimate

| Migration activity                    | Small      | Medium      | Large        |
| ------------------------------------- | ---------- | ----------- | ------------ |
| Assessment and planning               | $2,000     | $8,000      | $25,000      |
| Schema and index redesign             | $1,000     | $5,000      | $15,000      |
| Data migration (tooling + validation) | $500       | $3,000      | $20,000      |
| Application code changes              | $2,000     | $10,000     | $40,000      |
| Testing and validation                | $1,000     | $5,000      | $20,000      |
| Dual-run period (both systems active) | $500       | $3,000      | $15,000      |
| **Total migration cost**              | **$7,000** | **$34,000** | **$135,000** |

Migration costs are one-time. Payback period for medium architecture (Atlas to vCore): approximately 8 months.

---

## Related resources

- [Why Cosmos DB over MongoDB](why-cosmosdb-over-mongodb.md)
- [Complete Feature Mapping](feature-mapping-complete.md)
- [vCore Migration Guide](vcore-migration.md)
- [RU-Based Migration Guide](ru-migration.md)
- [Best Practices (cost optimization section)](best-practices.md)
- [Migration Playbook](../mongodb-to-cosmosdb.md)

---

**Maintainers:** csa-inabox core team
**Last updated:** 2026-04-30
