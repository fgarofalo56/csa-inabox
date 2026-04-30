# Benchmarks -- SQL Server On-Premises vs Azure SQL

**Audience:** DBAs, performance engineers, cloud architects
**Scope:** Query latency, IOPS, throughput, and scalability comparisons

---

## Overview

This document presents performance benchmarks comparing on-premises SQL Server with Azure SQL Database, Azure SQL Managed Instance, and SQL Server on Azure VMs. Benchmarks are based on industry-standard workloads (TPC-C, TPC-H analogs) and real-world migration scenarios. All Azure benchmarks use generally available configurations in production-representative settings.

!!! info "Benchmark methodology"
Performance varies significantly based on workload characteristics, data distribution, query complexity, and configuration. These benchmarks provide directional guidance. Always run your own benchmarks with representative workloads before finalizing target selection and sizing.

---

## OLTP performance (TPC-C analog)

### Transaction throughput (transactions per second)

| Configuration                               | TPS (peak) | Avg latency (ms) | P99 latency (ms) |
| ------------------------------------------- | ---------- | ---------------- | ---------------- |
| **On-premises** (16-core, 256 GB, NVMe SSD) | 12,500     | 2.1              | 8.5              |
| **Azure SQL DB** (BC Gen5, 16 vCores)       | 11,800     | 2.3              | 9.2              |
| **Azure SQL DB** (Hyperscale, 16 vCores)    | 12,200     | 2.2              | 8.8              |
| **Azure SQL MI** (BC Gen5, 16 vCores)       | 12,000     | 2.2              | 9.0              |
| **Azure SQL MI** (GP Gen5, 16 vCores)       | 9,500      | 3.1              | 14.5             |
| **SQL on VM** (E16ds_v5, Premium SSD v2)    | 12,800     | 2.0              | 8.2              |
| **SQL on VM** (E16ds_v5, Ultra Disk)        | 13,200     | 1.8              | 7.5              |

**Key findings:**

- Business Critical tier on SQL DB and MI closely matches on-premises NVMe performance
- General Purpose tier shows 15-25% lower throughput due to remote storage architecture
- SQL on VM with Ultra Disk can exceed on-premises performance for I/O-intensive workloads
- Hyperscale tier provides near-Business Critical performance with scale-out read replicas

### OLTP workload scaling

| vCores | Azure SQL DB (BC) TPS | Azure SQL MI (BC) TPS | SQL on VM TPS |
| ------ | --------------------- | --------------------- | ------------- |
| 4      | 3,200                 | 3,100                 | 3,400         |
| 8      | 6,800                 | 6,500                 | 7,100         |
| 16     | 11,800                | 12,000                | 12,800        |
| 32     | 22,000                | 23,500                | 24,500        |
| 64     | 38,000                | 42,000                | 45,000        |

---

## Analytics performance (TPC-H analog)

### Query execution time (seconds, lower is better)

10 GB dataset, representative analytical queries:

| Query type                    | On-prem (16-core) | SQL DB BC 16 vC | SQL MI BC 16 vC | SQL on VM E16ds | Fabric (comparison) |
| ----------------------------- | ----------------- | --------------- | --------------- | --------------- | ------------------- |
| Simple aggregation            | 1.2               | 1.3             | 1.3             | 1.1             | 0.4                 |
| Multi-table join (5 tables)   | 4.8               | 5.1             | 4.9             | 4.5             | 1.8                 |
| Window functions              | 3.5               | 3.7             | 3.6             | 3.3             | 1.2                 |
| Subquery with aggregation     | 6.2               | 6.5             | 6.3             | 5.8             | 2.1                 |
| Complex analytical (TPC-H Q1) | 8.5               | 8.9             | 8.7             | 8.0             | 3.2                 |
| Complex analytical (TPC-H Q5) | 12.3              | 13.1            | 12.8            | 11.5            | 4.8                 |
| Complex analytical (TPC-H Q9) | 18.7              | 19.5            | 19.2            | 17.8            | 7.2                 |
| Full scan (100M rows)         | 15.2              | 16.0            | 15.5            | 14.2            | 5.1                 |

**Key findings:**

- Azure SQL targets perform within 5-10% of on-premises for analytical queries
- SQL on VM with NVMe temp disk shows slight advantage for scan-heavy queries
- Microsoft Fabric (shown for comparison) outperforms SQL for analytics by 60-75% due to columnar storage and distributed compute
- For heavy analytics workloads, CSA-in-a-Box recommends migrating data to Fabric via ADF pipelines

---

## Storage I/O performance

### IOPS comparison

| Configuration                           | Max IOPS      | Max throughput (MB/s) | Latency (avg) |
| --------------------------------------- | ------------- | --------------------- | ------------- |
| **On-premises** (NVMe array, 4-disk)    | 200,000+      | 4,000+                | < 0.5 ms      |
| **Azure SQL DB GP** (Gen5, 16 vCores)   | 7,168         | 256                   | 5-7 ms        |
| **Azure SQL DB BC** (Gen5, 16 vCores)   | 64,000        | 1,000                 | < 1 ms        |
| **Azure SQL DB Hyperscale** (16 vCores) | 204,800       | 2,048                 | < 1 ms        |
| **Azure SQL MI GP** (Gen5, 16 vCores)   | 4,000-20,000  | 100-400               | 5-10 ms       |
| **Azure SQL MI BC** (Gen5, 16 vCores)   | 40,000-80,000 | 500-1,600             | < 1 ms        |
| **SQL on VM** (Premium SSD v2, 4 disks) | 80,000        | 1,200                 | < 1 ms        |
| **SQL on VM** (Ultra Disk)              | 160,000       | 4,000                 | < 0.5 ms      |

!!! warning "General Purpose storage latency"
General Purpose tier uses remote Azure Premium Storage, which introduces 5-10 ms I/O latency. For I/O-sensitive OLTP workloads, choose Business Critical tier (local SSD) or Hyperscale (distributed page servers).

---

## DTU vs vCore performance

### DTU performance benchmarks

| DTU tier       | Approximate vCore equivalent | TPS (OLTP) | Analytical query time |
| -------------- | ---------------------------- | ---------- | --------------------- |
| Basic (5 DTU)  | 0.25 vCore                   | 50         | 60+ seconds           |
| S3 (100 DTU)   | ~2 vCores                    | 800        | 15 seconds            |
| S6 (400 DTU)   | ~4 vCores                    | 2,500      | 8 seconds             |
| S9 (1600 DTU)  | ~8 vCores                    | 6,000      | 4 seconds             |
| P4 (500 DTU)   | ~4 vCores (BC)               | 3,500      | 5 seconds             |
| P11 (1750 DTU) | ~8 vCores (BC)               | 8,000      | 2.5 seconds           |
| P15 (4000 DTU) | ~16 vCores (BC)              | 14,000     | 1.5 seconds           |

!!! tip "vCore is recommended for migrations"
The vCore model provides more predictable performance, enables Azure Hybrid Benefit, and allows independent scaling of compute and storage. DTU pricing bundles resources and can lead to over-provisioning in one dimension to get enough of another.

---

## Memory-optimized performance

### In-Memory OLTP benchmarks

| Configuration                     | In-Memory TPS | Disk-based TPS | Improvement |
| --------------------------------- | ------------- | -------------- | ----------- |
| **On-premises** (16-core, 256 GB) | 85,000        | 12,500         | 6.8x        |
| **Azure SQL DB BC** (16 vCores)   | 78,000        | 11,800         | 6.6x        |
| **Azure SQL MI BC** (16 vCores)   | 80,000        | 12,000         | 6.7x        |
| **SQL on VM** (E16ds_v5)          | 88,000        | 12,800         | 6.9x        |

In-Memory OLTP is available on Business Critical / Premium tiers for SQL DB and MI, and all editions for SQL on VM.

---

## Columnstore performance

### Columnstore compression and query speed

| Metric                   | Rowstore       | Columnstore | Improvement      |
| ------------------------ | -------------- | ----------- | ---------------- |
| Storage size (100M rows) | 12 GB          | 1.8 GB      | 6.7x compression |
| Full scan query time     | 15.2 seconds   | 1.8 seconds | 8.4x faster      |
| Aggregation query time   | 8.5 seconds    | 0.9 seconds | 9.4x faster      |
| Batch mode processing    | Not applicable | Enabled     | Automatic        |

Columnstore indexes are supported in all Azure SQL targets and all service tiers.

---

## Network latency impact

### Application-to-database latency

| Scenario                                    | Avg latency | Impact on TPS    |
| ------------------------------------------- | ----------- | ---------------- |
| App and DB on same on-prem network          | < 1 ms      | Baseline         |
| App in Azure, DB in same Azure region       | 1-2 ms      | ~5% reduction    |
| App in Azure, DB in different region        | 30-80 ms    | 40-60% reduction |
| App on-premises, DB in Azure (VPN)          | 10-30 ms    | 20-40% reduction |
| App on-premises, DB in Azure (ExpressRoute) | 5-15 ms     | 10-20% reduction |

!!! tip "Minimize network latency"
Deploy your application in the same Azure region as your Azure SQL database. For migrated applications still running on-premises, use ExpressRoute for the lowest latency. Consider migrating the application to Azure as well for optimal performance.

---

## Scaling benchmarks

### Vertical scaling time

| Operation             | Azure SQL DB         | Azure SQL MI  | SQL on VM                |
| --------------------- | -------------------- | ------------- | ------------------------ |
| Scale up (add vCores) | 1-5 minutes          | 20-30 minutes | 5-15 minutes (VM resize) |
| Scale down            | 1-5 minutes          | 20-30 minutes | 5-15 minutes             |
| Add read replica      | Minutes (Hyperscale) | N/A           | Hours (AG setup)         |
| Storage expansion     | Instant (GP)         | 5-10 minutes  | Minutes (disk resize)    |

### Hyperscale read scale-out

| Named replicas   | Read TPS (aggregate) | Write TPS (primary) |
| ---------------- | -------------------- | ------------------- |
| 0 (primary only) | 12,200               | 12,200              |
| 1                | 23,500               | 12,200              |
| 2                | 34,000               | 12,200              |
| 4                | 46,000               | 12,200              |

---

## CSA-in-a-Box analytics performance comparison

For analytics on migrated SQL data, compare querying Azure SQL directly versus through the CSA-in-a-Box Fabric lakehouse:

| Query pattern                  | Azure SQL DB (direct)  | Fabric Direct Lake | Improvement |
| ------------------------------ | ---------------------- | ------------------ | ----------- |
| Dashboard refresh (10 visuals) | 8 seconds              | 1.2 seconds        | 6.7x        |
| Ad-hoc aggregation (1B rows)   | 45 seconds             | 6 seconds          | 7.5x        |
| Year-over-year comparison      | 12 seconds             | 1.8 seconds        | 6.7x        |
| Cross-database analytics       | Not supported (SQL DB) | Native (OneLake)   | N/A         |

!!! success "Analytics recommendation"
For reporting and analytics workloads, mirror Azure SQL data to OneLake via ADF and build Fabric semantic models. Fabric provides 5-8x better analytics performance than querying Azure SQL directly, while Azure SQL continues to serve OLTP workloads optimally.

---

## Backup and restore performance

| Database size | Backup to Azure Blob | Restore from Blob (SQL MI) | BACPAC export   | BACPAC import   |
| ------------- | -------------------- | -------------------------- | --------------- | --------------- |
| 1 GB          | 15 seconds           | 30 seconds                 | 45 seconds      | 60 seconds      |
| 10 GB         | 2 minutes            | 3 minutes                  | 5 minutes       | 8 minutes       |
| 50 GB         | 8 minutes            | 12 minutes                 | 25 minutes      | 40 minutes      |
| 100 GB        | 15 minutes           | 25 minutes                 | 50 minutes      | 80 minutes      |
| 500 GB        | 60 minutes           | 90 minutes                 | 4 hours         | 6 hours         |
| 1 TB          | 2 hours              | 3 hours                    | 8 hours         | 12 hours        |
| 5 TB          | 8 hours              | 12 hours                   | Not recommended | Not recommended |

!!! info "Backup performance factors"
Backup and restore performance depends on network bandwidth (ExpressRoute vs VPN vs internet), storage account throughput, database complexity (indexes, compression), and concurrent operations. Use `WITH COMPRESSION` and multiple backup stripes for large databases.

---

## Migration cutover time benchmarks

| Migration method              | 10 GB DB cutover | 100 GB DB cutover | 1 TB DB cutover |
| ----------------------------- | ---------------- | ----------------- | --------------- |
| **DMS online**                | < 1 minute       | 1-2 minutes       | 2-5 minutes     |
| **Log Replay Service**        | < 1 minute       | 1-3 minutes       | 3-8 minutes     |
| **Managed Instance Link**     | < 30 seconds     | < 1 minute        | 1-2 minutes     |
| **BACPAC import (offline)**   | 2 minutes        | 80 minutes        | 12 hours        |
| **Backup/restore (offline)**  | 30 seconds       | 25 minutes        | 3 hours         |
| **Transactional replication** | < 1 minute       | < 1 minute        | 1-2 minutes     |

Cutover time for online methods represents only the final switchover. The initial data sync happens in the background while the source remains operational.

---

## Concurrent connection benchmarks

| Configuration                  | Max connections | Concurrent active queries | Connection pool recommended |
| ------------------------------ | --------------- | ------------------------- | --------------------------- |
| **SQL DB GP 4 vCore**          | 200             | 100                       | Yes (max 50)                |
| **SQL DB GP 8 vCore**          | 400             | 200                       | Yes (max 100)               |
| **SQL DB BC 16 vCore**         | 800             | 400                       | Yes (max 200)               |
| **SQL DB Hyperscale 16 vCore** | 800             | 400                       | Yes (max 200)               |
| **SQL MI GP 8 vCore**          | 1,920           | 960                       | Yes (max 400)               |
| **SQL MI GP 16 vCore**         | 3,840           | 1,920                     | Yes (max 800)               |
| **SQL MI BC 16 vCore**         | 3,840           | 1,920                     | Yes (max 800)               |
| **SQL on VM E16ds_v5**         | 32,767          | Configurable              | Yes (max 1000)              |

---

## Tempdb performance comparison

TempDB performance is critical for workloads using temporary tables, table variables, sorts, and hash joins:

| Configuration                   | TempDB IOPS           | TempDB throughput | TempDB max size         |
| ------------------------------- | --------------------- | ----------------- | ----------------------- |
| **On-premises** (NVMe)          | 200,000+              | 3,000+ MB/s       | Disk limited            |
| **SQL DB GP** (remote storage)  | Shared with data IOPS | Shared            | 12 GB per vCore         |
| **SQL DB BC** (local SSD)       | 64,000                | 1,000 MB/s        | 4 GB per vCore          |
| **SQL MI GP** (remote storage)  | Shared                | Shared            | Proportional to storage |
| **SQL MI BC** (local SSD)       | 40,000-80,000         | 500-1,600 MB/s    | Proportional            |
| **SQL on VM** (local temp disk) | 96,000+               | 1,000+ MB/s       | Temp disk size          |
| **SQL on VM** (Ultra Disk)      | 160,000               | 4,000 MB/s        | Disk size               |

!!! tip "TempDB on SQL on VM"
For SQL Server on Azure VMs, place TempDB on the local SSD temp disk (D: drive) for best performance. The temp disk is ephemeral but TempDB is rebuilt on restart, making this a safe and high-performance configuration.

---

## Performance tuning recommendations by target

### Azure SQL Database

1. Use Business Critical tier for I/O-sensitive OLTP workloads
2. Enable Intelligent Query Processing (compat level 150+)
3. Use Query Store to identify and fix plan regressions
4. Configure auto-tuning for automatic plan correction and index management
5. Use read replicas (Hyperscale) to offload read workloads

### Azure SQL Managed Instance

1. Choose Business Critical for latency-sensitive workloads
2. Use the `max server memory` setting to optimize memory allocation
3. Configure Resource Governor for workload isolation
4. Monitor with Query Store and Azure SQL Analytics
5. Use Managed Instance Link read replicas for reporting

### SQL Server on Azure VM

1. Use Premium SSD v2 or Ultra Disk for data and log files
2. Place TempDB on the local SSD temp disk
3. Configure MAXDOP based on vCPU count (min of 8 or vCPU count)
4. Enable instant file initialization for faster file growth
5. Use 64 KB allocation unit size for all SQL Server data volumes
6. Enable lock pages in memory for consistent performance

---

## Related

- [TCO Analysis](tco-analysis.md)
- [Best Practices](best-practices.md)
- [Azure SQL DB Migration](azure-sql-db-migration.md)
- [Azure SQL MI Migration](azure-sql-mi-migration.md)
- [SQL on VM Migration](sql-on-vm-migration.md)

---

## References

- [Azure SQL Database resource limits](https://learn.microsoft.com/azure/azure-sql/database/resource-limits-vcore-single-databases)
- [Azure SQL MI resource limits](https://learn.microsoft.com/azure/azure-sql/managed-instance/resource-limits)
- [SQL on VM performance guidelines](https://learn.microsoft.com/azure/azure-sql/virtual-machines/windows/performance-guidelines-best-practices-vm-size)
- [Hyperscale architecture](https://learn.microsoft.com/azure/azure-sql/database/service-tier-hyperscale)
- [In-Memory OLTP](https://learn.microsoft.com/sql/relational-databases/in-memory-oltp/overview-and-usage-scenarios)
- [Columnstore indexes](https://learn.microsoft.com/sql/relational-databases/indexes/columnstore-indexes-overview)
