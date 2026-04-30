# SAP on Azure: Benchmarks and Performance

**HANA performance on Azure VMs: SAPS ratings, memory throughput, IO benchmarks, HSR replication latency, and backup/restore times by database size.**

---

## Overview

SAP workload performance on Azure is measured against SAP Standard Application Benchmarks (SAPS) and validated through SAP-Microsoft co-certification. This document provides reference benchmarks for HANA database performance, application server throughput, storage IO, and high availability replication on Azure infrastructure. Use these benchmarks to size your deployment and validate performance after migration.

!!! note "Benchmark disclaimer"
Performance benchmarks are reference values measured under controlled conditions. Your actual performance depends on workload characteristics, data distribution, custom code complexity, network topology, and concurrent user load. Always validate with your specific workload in a proof-of-concept before production deployment.

---

## 1. SAPS ratings for SAP-certified Azure VMs

SAPS (SAP Application Performance Standard) measures the throughput of SAP application processing. Higher SAPS = more SAP transaction throughput.

### HANA database VMs

| VM size            | vCPUs | Memory (GiB) | SAPS (published) | HANA cert type | Benchmark source |
| ------------------ | ----- | ------------ | ---------------- | -------------- | ---------------- |
| Standard_M32ts     | 32    | 192          | 36,826           | OLTP           | SAP Note 1928533 |
| Standard_M64s      | 64    | 1,024        | 71,502           | OLTP + OLAP    | SAP Note 1928533 |
| Standard_M64ms     | 64    | 1,792        | 71,502           | OLTP + OLAP    | SAP Note 1928533 |
| Standard_M128s     | 128   | 2,048        | 143,480          | OLTP + OLAP    | SAP Note 1928533 |
| Standard_M128ms    | 128   | 3,892        | 143,480          | OLTP + OLAP    | SAP Note 1928533 |
| Standard_M208s_v2  | 208   | 2,850        | 260,000          | OLTP + OLAP    | SAP Note 1928533 |
| Standard_M208ms_v2 | 208   | 5,700        | 260,000          | OLTP + OLAP    | SAP Note 1928533 |
| Standard_M416s_v2  | 416   | 5,700        | 488,000          | OLAP           | SAP Note 1928533 |
| Standard_M416ms_v2 | 416   | 11,400       | 488,000          | OLAP           | SAP Note 1928533 |

### Application server VMs

| VM size           | vCPUs | Memory (GiB) | SAPS (published) | Use case                |
| ----------------- | ----- | ------------ | ---------------- | ----------------------- |
| Standard_E16ds_v5 | 16    | 128          | 21,350           | Small app server        |
| Standard_E32ds_v5 | 32    | 256          | 42,700           | Standard app server     |
| Standard_E48ds_v5 | 48    | 384          | 64,050           | Large app server        |
| Standard_E64ds_v5 | 64    | 512          | 85,400           | Very large app server   |
| Standard_E96ds_v5 | 96    | 672          | 128,100          | Maximum app server      |
| Standard_D32ds_v5 | 32    | 128          | 36,400           | Web Dispatcher, Gateway |
| Standard_D16ds_v5 | 16    | 64           | 18,200           | Small CI instance       |

---

## 2. HANA memory performance

### Memory throughput benchmarks

| VM size           | Memory bandwidth (GB/s) | HANA data load rate | Column scan rate | Notes               |
| ----------------- | ----------------------- | ------------------- | ---------------- | ------------------- |
| Standard_M64s     | 80+                     | 2--3 GB/min         | 15--20 GB/s      | Mid-size workloads  |
| Standard_M128s    | 160+                    | 4--6 GB/min         | 30--40 GB/s      | Standard production |
| Standard_M208s_v2 | 230+                    | 6--8 GB/min         | 45--55 GB/s      | Large production    |
| Standard_M416s_v2 | 450+                    | 10--15 GB/min       | 80--100 GB/s     | Extreme workloads   |

### HANA memory utilization guidelines

| Workload                 | Memory sizing rule | Example (2 TB data)            |
| ------------------------ | ------------------ | ------------------------------ |
| S/4HANA OLTP             | 1.2x data volume   | 2.4 TB RAM → M128s or M208s_v2 |
| BW/4HANA OLAP            | 1.5x data volume   | 3.0 TB RAM → M208ms_v2         |
| S/4HANA + BW (same host) | 1.5x combined data | 3.6 TB RAM → M208ms_v2         |
| Development/QAS          | 0.5x production    | 1.0 TB RAM → M64s              |
| Sandbox                  | 0.25x production   | 0.5 TB RAM → M32ts             |

---

## 3. Storage IO benchmarks

### Azure NetApp Files (ANF) performance for HANA

| ANF tier | IOPS (4K random read) | Throughput (sequential read) | Latency (avg) | HANA certification          |
| -------- | --------------------- | ---------------------------- | ------------- | --------------------------- |
| Ultra    | 450,000+              | 4,500 MBps                   | < 0.5 ms      | Certified for data + log    |
| Premium  | 250,000               | 2,500 MBps                   | < 1 ms        | Certified for data + shared |
| Standard | 80,000                | 800 MBps                     | < 2 ms        | Backup, archive only        |

### HANA KPI compliance on ANF

SAP defines Key Performance Indicators (KPIs) that storage must meet for HANA certification:

| KPI                        | SAP requirement | ANF Ultra (measured) | Status |
| -------------------------- | --------------- | -------------------- | ------ |
| Log write (4K, sequential) | < 1 ms          | 0.3--0.5 ms          | PASS   |
| Data read (64K, random)    | < 3 ms          | 0.5--1.0 ms          | PASS   |
| Data write (64K, random)   | < 3 ms          | 0.5--1.0 ms          | PASS   |
| Log write throughput       | > 250 MB/s      | 1,500+ MB/s          | PASS   |
| Data read throughput       | > 400 MB/s      | 4,000+ MB/s          | PASS   |
| Savepoint time (1 TB data) | < 300 seconds   | 60--120 seconds      | PASS   |

### Ultra Disk performance for HANA

| Disk configuration     | IOPS   | Throughput | Latency  | Use case                       |
| ---------------------- | ------ | ---------- | -------- | ------------------------------ |
| Ultra Disk (HANA data) | 80,000 | 2,000 MBps | < 0.5 ms | Alternative to ANF for data    |
| Ultra Disk (HANA log)  | 40,000 | 1,000 MBps | < 0.3 ms | Alternative to ANF for log     |
| Premium SSD v2 (data)  | 80,000 | 1,200 MBps | < 1 ms   | Cost-effective for non-extreme |

---

## 4. HSR replication benchmarks

### HANA System Replication latency

| Replication mode                | Same AZ latency | Cross-AZ latency | Cross-region latency | RPO                     |
| ------------------------------- | --------------- | ---------------- | -------------------- | ----------------------- |
| Synchronous (sync)              | < 1 ms          | 1--3 ms          | N/A (too high)       | 0 (zero data loss)      |
| Synchronous in-memory (syncmem) | < 1 ms          | 1--3 ms          | N/A                  | 0 (committed to memory) |
| Asynchronous (async)            | < 1 ms          | < 5 ms           | 10--50 ms            | seconds to minutes      |

### HSR initial data copy time

| HANA data size | Same region (HSR init) | Cross-region (HSR init) | Notes                                         |
| -------------- | ---------------------- | ----------------------- | --------------------------------------------- |
| 500 GB         | 30--60 min             | 2--4 hours              | Network bandwidth dependent                   |
| 1 TB           | 1--2 hours             | 4--8 hours              | Use ExpressRoute for cross-region             |
| 2 TB           | 2--4 hours             | 8--16 hours             | Consider full backup + restore as alternative |
| 4 TB           | 4--8 hours             | 16--32 hours            | Schedule during maintenance window            |

### HSR failover time

| Failover type                 | Time           | Notes                                       |
| ----------------------------- | -------------- | ------------------------------------------- |
| Automatic (Pacemaker-managed) | 30--90 seconds | Pacemaker detects failure + takeover        |
| Manual takeover               | 2--5 minutes   | Operator-initiated `hdbnsutil -sr_takeover` |
| Cross-region DR failover      | 15--30 minutes | DNS update + application restart            |

---

## 5. Backup and restore benchmarks

### Azure Backup for SAP HANA (BACKINT)

| HANA DB size | Full backup time | Incremental backup time | Restore time | Notes             |
| ------------ | ---------------- | ----------------------- | ------------ | ----------------- |
| 200 GB       | 15--25 min       | 5--10 min               | 20--30 min   | Standard M64s     |
| 500 GB       | 30--50 min       | 10--20 min              | 40--60 min   | Standard M128s    |
| 1 TB         | 1--1.5 hours     | 15--30 min              | 1.5--2 hours | Standard M128s    |
| 2 TB         | 2--3 hours       | 30--45 min              | 3--4 hours   | Standard M208s_v2 |
| 4 TB         | 4--6 hours       | 45--90 min              | 6--8 hours   | Standard M208s_v2 |
| 8 TB         | 8--12 hours      | 1.5--3 hours            | 12--16 hours | Standard M416s_v2 |

### Backup throughput

| Backup method                           | Throughput            | Notes                                  |
| --------------------------------------- | --------------------- | -------------------------------------- |
| Azure Backup (BACKINT) to Azure Storage | 400--600 MBps         | Multi-stream backup                    |
| HANA backup to ANF                      | 1,000--2,000 MBps     | Local ANF snapshot; fastest            |
| HANA backup to Azure Blob (cool)        | 200--400 MBps         | Cost-effective for long-term retention |
| ANF snapshot                            | < 1 minute (any size) | Application-consistent snapshot        |
| ANF cross-region replication            | 250--500 MBps         | DR backup to secondary region          |

---

## 6. Application performance benchmarks

### SAP dialog response time

| Metric                   | Target     | Azure (M128s + ANF)         | Notes                             |
| ------------------------ | ---------- | --------------------------- | --------------------------------- |
| Average dialog step time | < 1 second | 0.3--0.8 seconds            | Depends on custom code complexity |
| Database request time    | < 200 ms   | 50--150 ms                  | HANA in-memory advantage          |
| Roll-in/roll-out time    | < 50 ms    | 10--30 ms                   | Memory-dependent                  |
| Enqueue lock time        | < 10 ms    | 1--5 ms                     | ENSA2 on Azure LB                 |
| Batch job throughput     | Varies     | 20--40% faster than on-prem | Memory + IO advantage of Azure    |

### SAP user concurrency

| VM size (app server) | Concurrent dialog users | Concurrent batch processes | Notes                 |
| -------------------- | ----------------------- | -------------------------- | --------------------- |
| Standard_E16ds_v5    | 200--400                | 10--20                     | Small department      |
| Standard_E32ds_v5    | 400--800                | 20--40                     | Mid-size org          |
| Standard_E64ds_v5    | 800--1,500              | 40--80                     | Large enterprise      |
| Standard_E96ds_v5    | 1,500--2,500            | 80--120                    | Very large enterprise |

---

## 7. Fabric Mirroring performance

### SAP HANA to OneLake replication benchmarks

| Metric                          | Measured value             | Notes                           |
| ------------------------------- | -------------------------- | ------------------------------- |
| Initial sync throughput         | 50--200 GB/hour            | Depends on table count and size |
| CDC latency (steady state)      | 2--10 minutes              | Near-real-time; not real-time   |
| Change propagation rate         | 10,000--50,000 rows/second | Depends on change volume        |
| Power BI Direct Lake query time | < 2 seconds (typical)      | Sub-second for cached queries   |

---

## 8. Network performance

### Latency benchmarks

| Communication path              | Expected latency | Requirement                            |
| ------------------------------- | ---------------- | -------------------------------------- |
| App server → HANA (same PPG)    | < 0.3 ms         | Mandatory for SAP S/4HANA              |
| App server → HANA (cross-AZ)    | 1--3 ms          | Acceptable for HA                      |
| ASCS → ERS (cross-AZ)           | 1--3 ms          | Acceptable for enqueue replication     |
| Client → Fiori (via Front Door) | 20--50 ms        | Acceptable for interactive users       |
| HANA → HANA HSR (cross-AZ)      | 1--3 ms          | Acceptable for synchronous replication |
| HANA → HANA HSR (cross-region)  | 10--50 ms        | Asynchronous replication only          |

### Network throughput

| VM size           | Network bandwidth | Accelerated networking | Notes              |
| ----------------- | ----------------- | ---------------------- | ------------------ |
| Standard_M64s     | 8,000 Mbps        | Required               | HANA database      |
| Standard_M128s    | 16,000 Mbps       | Required               | Large HANA         |
| Standard_M208s_v2 | 16,000 Mbps       | Required               | Very large HANA    |
| Standard_E32ds_v5 | 16,000 Mbps       | Required               | Application server |

---

## 9. Sizing guidelines

### Quick sizing formula

```
HANA VM Memory = HANA data volume x multiplier
  - S/4HANA OLTP: 1.2x
  - BW/4HANA OLAP: 1.5x
  - Combined: 1.5x

App Server SAPS = (peak dialog users x 200 SAPS) + (batch SAPS)

Number of App Servers = Total SAPS / per-VM SAPS
  - Add 20% headroom for peak load
  - Minimum 2 for HA (active-active)
```

### Example sizing

| Workload                    | HANA data | HANA VM            | App SAPS needed | App VMs     | Total VMs |
| --------------------------- | --------- | ------------------ | --------------- | ----------- | --------- |
| Small S/4HANA (500 users)   | 500 GB    | M64s (1 TB)        | 100,000         | 3x E32ds_v5 | 5 (+ HA)  |
| Mid S/4HANA (2,000 users)   | 2 TB      | M128s (2 TB)       | 400,000         | 5x E64ds_v5 | 7 (+ HA)  |
| Large S/4HANA (5,000 users) | 4 TB      | M208s_v2 (2.8 TB)  | 1,000,000       | 8x E96ds_v5 | 10 (+ HA) |
| BW/4HANA (4 TB data)        | 4 TB      | M208ms_v2 (5.7 TB) | 200,000         | 3x E32ds_v5 | 5 (+ HA)  |

---

## 10. Migration performance benchmarks

### Data migration throughput (DMO with SUM)

| Source DB                    | Target (HANA on Azure) | Network              | Migration throughput       | Notes                                               |
| ---------------------------- | ---------------------- | -------------------- | -------------------------- | --------------------------------------------------- |
| Oracle → HANA                | M128s, ANF Ultra       | 10 Gbps ExpressRoute | 200--400 GB/hour           | Parallel streams (MAX_PROCESSES=20)                 |
| DB2 → HANA                   | M128s, ANF Ultra       | 10 Gbps ExpressRoute | 200--350 GB/hour           | Similar to Oracle                                   |
| SQL Server → HANA            | M128s, ANF Ultra       | 10 Gbps ExpressRoute | 250--450 GB/hour           | Slightly faster due to SQL Server export efficiency |
| HANA → HANA (HSR)            | M128s, ANF Ultra       | 10 Gbps ExpressRoute | 500--800 GB/hour (initial) | HSR full copy is faster than DMO                    |
| HANA → HANA (backup/restore) | M128s, ANF Ultra       | AzCopy to Blob       | 300--600 GB/hour           | Depends on backup compression ratio                 |

### ADF SAP connector extraction throughput

| ADF connector       | Source system               | Throughput (rows/sec) | Throughput (GB/hour) | Notes                                             |
| ------------------- | --------------------------- | --------------------- | -------------------- | ------------------------------------------------- |
| SAP Table connector | S/4HANA table (partitioned) | 50,000--200,000       | 20--80               | Use /BODS/RFC_READ_TABLE2 for large tables        |
| SAP BW Open Hub     | BW InfoProvider             | 30,000--100,000       | 15--50               | OHD extraction with delta                         |
| SAP HANA connector  | HANA view/table             | 100,000--500,000      | 40--200              | Direct JDBC; fastest option                       |
| SAP ODP connector   | S/4HANA ODP (CDS/SAPI)      | 40,000--150,000       | 20--60               | Delta-capable; recommended for ongoing extraction |
| SAP CDC connector   | S/4HANA SLT                 | 20,000--80,000        | 10--40               | Real-time CDC; lower throughput, lower latency    |

---

## 11. Performance tuning recommendations

### HANA performance tuning on Azure

| Tuning area                               | Recommendation                      | Impact                                      |
| ----------------------------------------- | ----------------------------------- | ------------------------------------------- |
| HANA parameter: `global_allocation_limit` | Set to 90% of VM memory             | Prevent OS OOM; leave 10% for OS operations |
| HANA parameter: `max_concurrency`         | Default (auto) for most workloads   | HANA auto-tunes parallelism                 |
| ANF volume: nconnect                      | Enable `nconnect=4` for NFS mounts  | 2--4x throughput improvement for NFS        |
| Kernel: `vm.swappiness`                   | Set to 10 (SUSE default for SAP)    | Minimize swap usage; HANA prefers in-memory |
| Kernel: `transparent_hugepages`           | Disable (`never`)                   | SAP recommends disabling THP                |
| Network: accelerated networking           | Mandatory for all SAP VMs           | SR-IOV for near-bare-metal network          |
| Storage: stripe across ANF volumes        | Not needed (ANF handles internally) | ANF auto-distributes IO                     |
| HANA: columnstore compression             | Default (auto compression)          | 3--7x compression typical for SAP data      |

### Application server tuning on Azure

| Tuning area                                | Recommendation                            | Impact                                       |
| ------------------------------------------ | ----------------------------------------- | -------------------------------------------- |
| Number of dialog work processes            | 2x vCPUs (e.g., 64 for E32ds_v5)          | Match dialog WPs to expected concurrency     |
| Number of batch work processes             | 0.5x vCPUs for batch servers              | Dedicated batch servers for heavy processing |
| SAP extended memory (`em/initial_size_MB`) | 80% of available RAM                      | Maximize application memory                  |
| ICM connection pool                        | Tune based on concurrent HTTP connections | Prevent connection exhaustion for Fiori      |
| Enqueue server (ENSA2)                     | Deploy on ASCS with replication to ERS    | Prevent enqueue lock loss during failover    |

---

**Last updated:** 2026-04-30
**Maintainers:** CSA-in-a-Box core team
**Related:** [Infrastructure Migration](infrastructure-migration.md) | [HANA Migration](hana-migration.md) | [Best Practices](best-practices.md)
