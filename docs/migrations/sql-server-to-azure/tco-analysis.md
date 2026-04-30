# Total Cost of Ownership Analysis -- SQL Server On-Premises vs Azure SQL

**Audience:** CFO, CIO, IT Finance, Procurement, Cloud Architects
**Reading time:** 20 minutes

---

## Executive summary

This analysis compares the total cost of ownership for running SQL Server workloads on-premises versus the three Azure SQL deployment options over 3-year and 5-year horizons. The analysis accounts for licensing, hardware, administration, networking, storage, HA/DR infrastructure, facility costs, and hidden costs that are frequently underestimated in on-premises TCO calculations.

Key findings for a reference workload (16-core, 256 GB RAM, 2 TB database):

| Metric                 | On-premises (Enterprise) | Azure SQL Database  | Azure SQL Managed Instance | SQL Server on Azure VM |
| ---------------------- | ------------------------ | ------------------- | -------------------------- | ---------------------- |
| **3-year TCO**         | $780,000 - $1,100,000    | $280,000 - $420,000 | $350,000 - $520,000        | $380,000 - $560,000    |
| **5-year TCO**         | $1,200,000 - $1,700,000  | $440,000 - $680,000 | $560,000 - $840,000        | $600,000 - $880,000    |
| **Savings vs on-prem** | Baseline                 | 55-65%              | 45-55%                     | 40-50%                 |

!!! tip "Use the Azure TCO Calculator"
These are reference estimates. For organization-specific projections, use the [Azure TCO Calculator](https://azure.microsoft.com/pricing/tco/calculator/) with your actual workload parameters.

---

## On-premises SQL Server cost model

### Hardware costs

Server hardware for an enterprise SQL Server deployment typically requires:

| Component             | Specification                 | 3-year cost             | Notes                          |
| --------------------- | ----------------------------- | ----------------------- | ------------------------------ |
| Production server     | 2-socket, 16-core, 256 GB RAM | $25,000 - $40,000       | Dell PowerEdge or HPE ProLiant |
| DR server (standby)   | Identical to production       | $25,000 - $40,000       | Required for HA/DR             |
| SAN/NAS storage       | 10 TB usable, all-flash       | $50,000 - $120,000      | NetApp, Pure Storage, Dell EMC |
| Network switches      | 10/25 GbE, redundant          | $8,000 - $15,000        | Top-of-rack switches           |
| Backup storage        | Disk-based, 30 TB             | $15,000 - $30,000       | Backup appliance or NAS        |
| **Hardware subtotal** |                               | **$123,000 - $245,000** | Refresh every 3-5 years        |

### SQL Server licensing

SQL Server Enterprise Edition licensing is the dominant cost for most on-premises deployments:

| License model           | Per-core cost      | 16-core server | With Software Assurance |
| ----------------------- | ------------------ | -------------- | ----------------------- |
| Enterprise (per core)   | $15,123            | $241,968       | $302,460 (SA adds ~25%) |
| Standard (per core)     | $3,945             | $63,120        | $78,900                 |
| Enterprise (server+CAL) | $14,256 + $230/CAL | Varies         | Add 25% for SA          |

!!! warning "Common licensing mistake"
SQL Server licensing requires covering ALL physical cores in the host. A 2-socket server with 16 cores per socket requires 32 core licenses, not 16. With Enterprise Edition, this is $484,000 in license costs alone before Software Assurance.

### Administration costs

| Role                  | FTE allocation             | Annual cost       | 3-year cost             |
| --------------------- | -------------------------- | ----------------- | ----------------------- |
| DBA (infrastructure)  | 0.5 FTE per 5-10 instances | $70,000 - $90,000 | $210,000 - $270,000     |
| Systems administrator | 0.25 FTE                   | $35,000 - $45,000 | $105,000 - $135,000     |
| Network administrator | 0.1 FTE                    | $12,000 - $18,000 | $36,000 - $54,000       |
| Security/compliance   | 0.1 FTE                    | $14,000 - $20,000 | $42,000 - $60,000       |
| **Admin subtotal**    |                            |                   | **$393,000 - $519,000** |

### Facility and power costs

| Component                                      | Monthly cost                  | 3-year cost            |
| ---------------------------------------------- | ----------------------------- | ---------------------- |
| Data center rack space (2U production + 2U DR) | $500 - $1,500                 | $18,000 - $54,000      |
| Power and cooling                              | $300 - $800                   | $10,800 - $28,800      |
| Physical security                              | Included in colo or $200-$500 | $7,200 - $18,000       |
| **Facility subtotal**                          |                               | **$36,000 - $100,800** |

### Hidden costs frequently underestimated

| Cost category              | Description                              | 3-year estimate        |
| -------------------------- | ---------------------------------------- | ---------------------- |
| Downtime                   | Unplanned outages at $5,000-$50,000/hour | $15,000 - $150,000     |
| Patching windows           | After-hours maintenance labor            | $12,000 - $24,000      |
| Capacity over-provisioning | Hardware sized for peak (80% idle)       | $20,000 - $50,000      |
| DR testing                 | Semi-annual DR drills                    | $6,000 - $12,000       |
| Audit and compliance       | Manual compliance documentation          | $15,000 - $30,000      |
| End-of-support ESU         | For SQL 2012/2014/2016                   | $15,000 - $100,000     |
| **Hidden cost subtotal**   |                                          | **$83,000 - $366,000** |

### Total on-premises 3-year TCO (single 16-core Enterprise instance)

| Category                               | Low estimate | High estimate  |
| -------------------------------------- | ------------ | -------------- |
| Hardware                               | $123,000     | $245,000       |
| SQL Server licensing (Enterprise + SA) | $302,460     | $302,460       |
| Administration                         | $393,000     | $519,000       |
| Facility                               | $36,000      | $100,800       |
| Hidden costs                           | $83,000      | $366,000       |
| **Total**                              | **$937,460** | **$1,533,260** |

---

## Azure SQL Database cost model

### vCore pricing (General Purpose, 8 vCores)

| Component                       | Monthly cost | With AHB     | With AHB + 3-year RI |
| ------------------------------- | ------------ | ------------ | -------------------- |
| Compute (GP Gen5, 8 vCores)     | $2,920       | $1,314       | $591                 |
| Storage (2 TB)                  | $460         | $460         | $460                 |
| Backup storage (PITR, 2 TB LTR) | $100         | $100         | $100                 |
| Geo-replication (secondary)     | $2,920       | $1,314       | $591                 |
| **Monthly total**               | **$6,400**   | **$3,188**   | **$1,742**           |
| **3-year total**                | **$230,400** | **$114,768** | **$62,712**          |

### DTU pricing (Premium P6, 1000 DTUs)

| Component              | Monthly cost | 3-year cost  |
| ---------------------- | ------------ | ------------ |
| Premium P6 (1000 DTUs) | $7,500       | $270,000     |
| Active geo-replication | $7,500       | $270,000     |
| **Monthly total**      | **$15,000**  | **$540,000** |

!!! info "DTU vs vCore"
DTU pricing bundles compute, storage, and I/O into a single metric. vCore pricing separates compute from storage, providing more flexibility and enabling Azure Hybrid Benefit. For migrations, **vCore is almost always more cost-effective** due to AHB eligibility.

### Additional Azure SQL Database costs

| Service                     | Monthly cost                  | 3-year cost          |
| --------------------------- | ----------------------------- | -------------------- |
| Microsoft Defender for SQL  | $15/server/month              | $540                 |
| Azure Monitor (diagnostics) | $50 - $200                    | $1,800 - $7,200      |
| Private endpoint            | $8/endpoint + data processing | $288 - $2,000        |
| Long-term backup retention  | $0.05/GB/month                | $3,600               |
| **Additional subtotal**     |                               | **$6,228 - $13,340** |

### Azure SQL Database 3-year TCO (with AHB + 3-year RI)

| Category                   | Cost                               |
| -------------------------- | ---------------------------------- |
| Compute + storage          | $62,712                            |
| Geo-replication            | $62,712                            |
| Additional services        | $10,000                            |
| Migration (DMS, one-time)  | $5,000                             |
| Training and enablement    | $15,000                            |
| **Total**                  | **$155,424**                       |
| **Savings vs on-premises** | **$782,036 - $1,377,836 (83-90%)** |

---

## Azure SQL Managed Instance cost model

### vCore pricing (General Purpose, 16 vCores)

| Component                          | Monthly cost | With AHB     | With AHB + 3-year RI |
| ---------------------------------- | ------------ | ------------ | -------------------- |
| Compute (GP Gen5, 16 vCores)       | $5,840       | $2,628       | $1,183               |
| Storage (2 TB)                     | $230         | $230         | $230                 |
| Backup storage (2 TB)              | $100         | $100         | $100                 |
| Auto-failover group (secondary MI) | $5,840       | $2,628       | $1,183               |
| **Monthly total**                  | **$12,010**  | **$5,586**   | **$2,696**           |
| **3-year total**                   | **$432,360** | **$201,096** | **$97,056**          |

### Azure SQL MI 3-year TCO (with AHB + 3-year RI)

| Category                       | Cost                               |
| ------------------------------ | ---------------------------------- |
| Primary MI (compute + storage) | $54,468                            |
| Failover group (secondary MI)  | $54,468                            |
| Additional services            | $12,000                            |
| VNet infrastructure            | $5,000                             |
| Migration (DMS, one-time)      | $8,000                             |
| Training and enablement        | $15,000                            |
| **Total**                      | **$148,936**                       |
| **Savings vs on-premises**     | **$788,524 - $1,384,324 (84-90%)** |

---

## SQL Server on Azure VM cost model

### VM pricing (E16ds_v5, 16 vCores, 128 GB RAM)

| Component                     | Monthly cost | With AHB     | With AHB + 3-year RI |
| ----------------------------- | ------------ | ------------ | -------------------- |
| VM compute (E16ds_v5)         | $1,752       | $1,752       | $788                 |
| SQL Server Enterprise license | $4,376       | $0 (AHB)     | $0 (AHB)             |
| Premium SSD (P30 x4, 4 TB)    | $582         | $582         | $582                 |
| Ultra Disk (TempDB, 512 GB)   | $280         | $280         | $280                 |
| Backup (Azure Backup)         | $100         | $100         | $100                 |
| DR VM (standby)               | $6,128       | $1,752       | $788                 |
| **Monthly total**             | **$13,218**  | **$4,466**   | **$2,538**           |
| **3-year total**              | **$475,848** | **$160,776** | **$91,368**          |

### SQL on VM 3-year TCO (with AHB + 3-year RI)

| Category                        | Cost                               |
| ------------------------------- | ---------------------------------- |
| Primary VM (compute + storage)  | $62,916                            |
| DR VM                           | $28,368                            |
| Azure Backup                    | $3,600                             |
| Networking (VPN/ER)             | $5,000                             |
| SQL IaaS extension (free)       | $0                                 |
| Migration (one-time)            | $5,000                             |
| Training                        | $10,000                            |
| Admin (reduced, not eliminated) | $90,000                            |
| **Total**                       | **$204,884**                       |
| **Savings vs on-premises**      | **$732,576 - $1,328,376 (78-87%)** |

---

## 3-year and 5-year comparison summary

### 3-year TCO comparison

| Cost category  | On-premises Enterprise | Azure SQL DB | Azure SQL MI | SQL on VM    |
| -------------- | ---------------------- | ------------ | ------------ | ------------ |
| Infrastructure | $159,000               | $0           | $0           | $0           |
| Licensing      | $302,460               | $62,712      | $54,468      | $0 (AHB)     |
| Compute        | Included in hardware   | Included     | Included     | $62,916      |
| Storage        | Included in SAN        | Included     | Included     | $31,032      |
| DR/HA          | $65,000                | $62,712      | $54,468      | $28,368      |
| Administration | $393,000               | $60,000      | $75,000      | $90,000      |
| Facility       | $36,000                | $0           | $0           | $0           |
| Migration      | $0                     | $5,000       | $8,000       | $5,000       |
| Training       | $0                     | $15,000      | $15,000      | $10,000      |
| Other          | $83,000                | $10,000      | $12,000      | $8,600       |
| **Total**      | **$1,038,460**         | **$215,424** | **$218,936** | **$235,916** |

### 5-year TCO comparison

| Target                     | 5-year TCO | Savings vs on-prem | Annualized savings |
| -------------------------- | ---------- | ------------------ | ------------------ |
| On-premises Enterprise     | $1,650,000 | Baseline           | Baseline           |
| Azure SQL Database         | $340,000   | $1,310,000 (79%)   | $262,000/year      |
| Azure SQL Managed Instance | $365,000   | $1,285,000 (78%)   | $257,000/year      |
| SQL Server on Azure VM     | $390,000   | $1,260,000 (76%)   | $252,000/year      |

!!! success "Key insight"
The largest savings come from **eliminating SQL Server Enterprise licensing** (via Azure Hybrid Benefit), **eliminating hardware refresh** (no 3-5 year cycle), and **reducing DBA overhead** (40-60% reduction with managed services). Administration savings grow each year as the team shifts to higher-value work.

---

## Cost optimization strategies

### Strategy 1: Azure Hybrid Benefit

If you have SQL Server licenses with active Software Assurance, apply them to Azure SQL for savings of 40-55% on compute costs. AHB applies to:

- Azure SQL Database (vCore model only)
- Azure SQL Managed Instance
- SQL Server on Azure VMs

```bash
# Verify AHB eligibility
az sql db show --resource-group myRG --server myServer --name myDB \
  --query "licenseType"

# Apply AHB to an existing database
az sql db update --resource-group myRG --server myServer --name myDB \
  --license-type BasePrice
```

### Strategy 2: Reserved instances

Commit to 1-year or 3-year reservations for predictable workloads:

| Reservation term | Savings over pay-as-you-go | Combined with AHB |
| ---------------- | -------------------------- | ----------------- |
| 1-year           | 33%                        | Up to 72%         |
| 3-year           | 55%                        | Up to 83%         |

### Strategy 3: Right-size with Azure Advisor

Azure Advisor analyzes database utilization and recommends right-sizing opportunities:

- Databases consistently using < 25% of provisioned compute can scale down
- Databases with intermittent usage patterns can move to serverless
- Multiple small databases on the same server can consolidate into elastic pools

### Strategy 4: Serverless for dev/test

Move development and testing databases to serverless tier where compute scales to zero during idle periods. Typical savings: 60-80% versus provisioned compute for dev/test workloads.

### Strategy 5: Consolidate with elastic pools

If migrating multiple databases (10+), elastic pools share compute resources across databases. A single S3 elastic pool (100 eDTUs) can support 10-20 small databases that would individually require S2 or S3 pricing.

### Strategy 6: Free ESU on Azure

SQL Server 2012, 2014, and 2016 instances migrated to Azure VMs receive free Extended Security Updates, saving:

| SQL Server version | ESU cost (on-prem, per core) | 16-core savings (annual) |
| ------------------ | ---------------------------- | ------------------------ |
| SQL Server 2014    | $1,069/core                  | $17,104                  |
| SQL Server 2016    | $1,069/core                  | $17,104                  |

---

## Federal-specific cost considerations

### Azure Government pricing

Azure Government regions carry a 20-30% price premium over commercial Azure for most services. Factor this into TCO calculations for federal workloads:

| Service                  | Commercial price | Gov price    | Premium |
| ------------------------ | ---------------- | ------------ | ------- |
| Azure SQL DB GP 8 vCore  | $2,920/month     | $3,504/month | 20%     |
| Azure SQL MI GP 16 vCore | $5,840/month     | $7,008/month | 20%     |
| SQL VM E16ds_v5          | $1,752/month     | $2,190/month | 25%     |

### Government discount programs

- **Enterprise Agreement (EA):** Volume discounts of 10-30% on Azure Government
- **CSP Government:** Negotiated pricing through Cloud Solution Providers
- **Dev/Test pricing:** Government dev/test subscriptions at commercial rates

Even with the Government premium, Azure SQL remains significantly less expensive than on-premises due to eliminated hardware, reduced administration, and AHB/RI savings.

---

## Related

- [Why Azure SQL](why-azure-sql.md)
- [Migration Playbook](../sql-server-to-azure.md)
- [Benchmarks](benchmarks.md)
- [Best Practices](best-practices.md)
- [Federal Migration Guide](federal-migration-guide.md)

---

## References

- [Azure SQL pricing](https://azure.microsoft.com/pricing/details/azure-sql-database/)
- [Azure SQL Managed Instance pricing](https://azure.microsoft.com/pricing/details/azure-sql-managed-instance/)
- [Azure TCO Calculator](https://azure.microsoft.com/pricing/tco/calculator/)
- [Azure Hybrid Benefit](https://learn.microsoft.com/azure/azure-sql/azure-hybrid-benefit)
- [Azure Reserved Instances](https://learn.microsoft.com/azure/cost-management-billing/reservations/reserved-instance-purchase-recommendations)
- [Azure Government pricing](https://azure.microsoft.com/pricing/government/)
- [SQL Server licensing guide](https://www.microsoft.com/licensing/docs/view/SQL-Server)
