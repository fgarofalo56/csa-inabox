# SAP HANA Database Migration to Azure

**Migrating SAP HANA databases from on-premises to Azure VMs or HANA Large Instances, including database migration from Oracle, DB2, SQL Server, and MaxDB to HANA.**

---

!!! warning "Database migration is the critical path"
HANA database migration determines the downtime window for your SAP system. Plan for 2--4 dress rehearsals before the production cutover. Each rehearsal reduces the final downtime window and builds team confidence.

## Overview

This guide covers three HANA migration scenarios:

1. **HANA-to-HANA migration** --- Moving an existing SAP HANA database from on-premises to Azure (same database engine)
2. **Non-HANA to HANA migration** --- Migrating from Oracle, DB2, SQL Server, or MaxDB to SAP HANA on Azure (database conversion)
3. **DMO (Database Migration Option)** --- Combined database migration and S/4HANA conversion using the SUM tool

---

## 1. HANA-to-HANA migration

When the source system already runs on SAP HANA, migration to Azure preserves the database engine and focuses on data movement.

### Option A: Backup and restore

The simplest approach. Take a full HANA backup on-premises, transfer to Azure, and restore.

**When to use:** Source and target HANA versions are compatible; HANA database < 4 TB; network bandwidth allows file transfer within the maintenance window.

```bash
# Step 1: Create full HANA backup (on-premises)
hdbsql -U SYSTEM -d SYSTEMDB \
  "BACKUP DATA USING FILE ('/hana/backup/COMPLETE_DATA_BACKUP')"

hdbsql -U SYSTEM -d S4H \
  "BACKUP DATA USING FILE ('/hana/backup/S4H_COMPLETE_DATA_BACKUP')"

# Step 2: Transfer backup to Azure (via AzCopy or ExpressRoute)
azcopy copy \
  "/hana/backup/" \
  "https://stsapbackup.blob.core.windows.net/hana-migration/" \
  --recursive

# Step 3: Download backup to Azure HANA VM
azcopy copy \
  "https://stsapbackup.blob.core.windows.net/hana-migration/" \
  "/hana/backup/" \
  --recursive

# Step 4: Restore on Azure HANA VM
hdbsql -U SYSTEM -d SYSTEMDB \
  "RECOVER DATA USING FILE ('/hana/backup/COMPLETE_DATA_BACKUP') CLEAR LOG"

hdbsql -U SYSTEM -d S4H \
  "RECOVER DATA USING FILE ('/hana/backup/S4H_COMPLETE_DATA_BACKUP') CLEAR LOG"
```

**Downtime estimate:**

| HANA size | Backup time | Transfer time (1 Gbps) | Restore time | Total downtime |
| --------- | ----------- | ---------------------- | ------------ | -------------- |
| 500 GB    | 30 min      | 1.5 hours              | 45 min       | ~3 hours       |
| 1 TB      | 1 hour      | 3 hours                | 1.5 hours    | ~6 hours       |
| 2 TB      | 2 hours     | 6 hours                | 3 hours      | ~11 hours      |
| 4 TB      | 4 hours     | 12 hours               | 6 hours      | ~22 hours      |

!!! tip "Reduce transfer time with ExpressRoute"
ExpressRoute (10 Gbps) reduces the transfer time by 10x. For a 2 TB database, transfer drops from 6 hours to ~40 minutes, reducing total downtime from 11 hours to ~4 hours.

### Option B: SAP HANA System Replication (HSR)

HSR provides near-zero-downtime migration by continuously replicating data from the on-premises HANA to the Azure HANA VM.

**When to use:** Minimal downtime requirement (< 30 minutes); source and target HANA versions are compatible; network connectivity (ExpressRoute or VPN) between on-premises and Azure.

```bash
# Step 1: Enable HSR on source (on-premises HANA)
hdbnsutil -sr_enable --name=onprem

# Step 2: Register Azure HANA as secondary
# (run on Azure HANA VM)
hdbnsutil -sr_register \
  --remoteHost=hana-onprem \
  --remoteInstance=00 \
  --replicationMode=async \
  --operationMode=logreplay \
  --name=azure

# Step 3: Monitor replication status
python /usr/sap/<SID>/HDB00/exe/python_support/systemReplicationStatus.py

# Step 4: Takeover (during maintenance window)
# Stop SAP application on-premises
sapcontrol -nr 00 -function StopSystem

# Takeover on Azure
hdbnsutil -sr_takeover

# Start SAP application on Azure
sapcontrol -nr 00 -function StartSystem
```

**HSR migration timeline:**

| Phase                     | Duration                        | Notes                                  |
| ------------------------- | ------------------------------- | -------------------------------------- |
| Initial HSR setup         | 1--2 hours                      | Enable HSR, register secondary         |
| Initial data replication  | 2--8 hours (depends on DB size) | Full copy via HSR                      |
| Continuous replication    | Days to weeks                   | Delta sync; validate data consistency  |
| Takeover (cutover window) | 15--30 minutes                  | Stop app, takeover, start app on Azure |

### Option C: HANA Large Instances

For HANA databases exceeding VM memory limits or requiring bare-metal performance.

| HLI type | Memory | Max HANA data | Use case            |
| -------- | ------ | ------------- | ------------------- |
| S192     | 2 TB   | 2 TB          | Large S/4HANA       |
| S384     | 4 TB   | 4 TB          | Enterprise BW/4HANA |
| S576     | 6 TB   | 6 TB          | Very large HANA     |
| S896     | 12 TB  | 12 TB         | Extreme-scale       |
| S960m    | 20 TB  | 20 TB         | Maximum scale       |

```bash
# HLI provisioning is through Azure portal or Azure CLI
# HLI connects to Azure VNet via ExpressRoute circuit
az network express-route peering create \
  --resource-group rg-sap-hli \
  --circuit-name hli-expressroute \
  --peering-type AzurePrivatePeering \
  --peer-asn 65000 \
  --primary-peer-subnet 10.100.0.0/30 \
  --secondary-peer-subnet 10.100.0.4/30
```

---

## 2. Non-HANA to HANA migration (database conversion)

When the source SAP system runs on Oracle, DB2, SQL Server, or MaxDB, the database must be converted to HANA during migration.

### DMO (Database Migration Option) with SUM

DMO is SAP's recommended tool for combined database migration and Unicode conversion. When used with SUM (Software Update Manager), DMO can simultaneously migrate the database to HANA and convert the system to S/4HANA.

**When to use:** Source database is Oracle, DB2, SQL Server, or MaxDB; target is S/4HANA on HANA on Azure.

```
DMO Process Flow
┌────────────────────┐
│  Source System      │
│  (Oracle/DB2/MSSQL) │
│  On-Premises        │
└────────┬───────────┘
         │ SUM/DMO
         │ (reads source, writes to target)
         ▼
┌────────────────────┐
│  Target System      │
│  (SAP HANA)         │
│  Azure VM           │
└────────────────────┘
```

### DMO process steps

1. **Download SUM and DMO tools** from SAP Software Download Center
2. **Prepare the target HANA system** on Azure VM (empty HANA database installed)
3. **Run SUM with DMO option** on the source system:

```bash
# Run SUM with DMO (simplified)
cd /usr/sap/<SID>/SUM
./STARTUP confighostagent

# SUM phases:
# 1. DETECT    - Detect source system configuration
# 2. CHECK     - Validate prerequisites
# 3. SHADOW    - Create shadow repository on target HANA
# 4. MIGRATE   - Data migration (source DB → HANA)
# 5. SWITCH    - Cut over to HANA
# 6. CLEANUP   - Remove shadow structures
```

### DMO migration time estimates

| Source DB size | DMO migration time | Notes                                |
| -------------- | ------------------ | ------------------------------------ |
| 200 GB         | 4--8 hours         | Small ECC system                     |
| 500 GB         | 8--16 hours        | Mid-size ECC                         |
| 1 TB           | 16--32 hours       | Large ECC with history               |
| 2 TB           | 32--48 hours       | Enterprise ECC                       |
| 5 TB+          | 48--96+ hours      | Very large; consider phased approach |

!!! warning "DMO downtime"
DMO requires system downtime for the migration phase. For large databases, downtime can exceed 48 hours. Plan for downtime reduction techniques: pre-copy of time-independent tables, parallel migration streams, and optimized network throughput between source and target.

### DMO optimization techniques

| Technique                          | Downtime reduction | Description                                           |
| ---------------------------------- | ------------------ | ----------------------------------------------------- |
| Pre-copy (time-independent tables) | 30--50%            | Migrate static tables before the maintenance window   |
| Parallel migration streams         | 20--40%            | Increase R3load parallelism (MAX_PROCESSES parameter) |
| Network optimization               | 10--30%            | ExpressRoute + compression between source and Azure   |
| Table splitting                    | 10--20%            | Split large tables across multiple migration streams  |
| Near-Zero Downtime (NZDT)          | 80--95%            | SAP NZDT Maintenance Planner; requires S/4HANA 2020+  |

---

## 3. Source database specific considerations

### Oracle to HANA

| Consideration       | Approach                                                                             |
| ------------------- | ------------------------------------------------------------------------------------ |
| Oracle-specific SQL | DMO automatically converts; review custom programs with ABAP Test Cockpit            |
| Oracle hints        | HANA optimizer does not use hints; remove Oracle-specific hints from custom SQL      |
| Oracle sequences    | Converted to HANA sequences automatically                                            |
| Oracle tablespaces  | Not applicable to HANA; columnar storage manages layout                              |
| Oracle RAC          | No HANA equivalent; HANA uses scale-up architecture (single node for most workloads) |
| Oracle Data Guard   | Replace with HANA System Replication (HSR)                                           |

### DB2 to HANA

| Consideration         | Approach                                            |
| --------------------- | --------------------------------------------------- |
| DB2 specific SQL      | DMO converts; validate custom programs              |
| DB2 HADR              | Replace with HANA System Replication                |
| DB2 buffer pools      | Not applicable; HANA in-memory architecture         |
| DB2 table compression | HANA columnar compression is typically 3--5x better |

### SQL Server to HANA

| Consideration            | Approach                                                                           |
| ------------------------ | ---------------------------------------------------------------------------------- |
| T-SQL in custom programs | Rare in SAP systems; validate with ABAP Test Cockpit                               |
| SQL Server Always On AG  | Replace with HANA System Replication                                               |
| SQL Server TDE           | Replace with HANA TDE + Azure Key Vault                                            |
| Windows-based SAP        | Consider migration to Linux (SUSE/RHEL) for HANA; Windows for app servers optional |

---

## 4. Post-migration validation

### HANA health checks

```sql
-- Check HANA version and patch level
SELECT VERSION, BUILD, REVISION FROM M_DATABASE;

-- Check memory allocation
SELECT HOST,
       ROUND(INSTANCE_TOTAL_MEMORY_USED_SIZE/1024/1024/1024, 2) AS USED_GB,
       ROUND(INSTANCE_TOTAL_MEMORY_ALLOCATED_SIZE/1024/1024/1024, 2) AS ALLOC_GB,
       ROUND(ALLOCATION_LIMIT/1024/1024/1024, 2) AS LIMIT_GB
FROM M_HOST_RESOURCE_UTILIZATION;

-- Check table distribution (column vs row store)
SELECT STORE_TYPE, COUNT(*) AS TABLE_COUNT,
       ROUND(SUM(TABLE_SIZE)/1024/1024/1024, 2) AS SIZE_GB
FROM M_TABLE_PERSISTENCE_STATISTICS
GROUP BY STORE_TYPE;

-- Check backup status
SELECT BACKUP_ID, ENTRY_TYPE_NAME, STATE_NAME,
       UTC_START_TIME, UTC_END_TIME,
       ROUND(BACKUP_SIZE/1024/1024/1024, 2) AS SIZE_GB
FROM M_BACKUP_CATALOG
ORDER BY UTC_START_TIME DESC
LIMIT 10;

-- Check HSR status
SELECT * FROM M_SYSTEM_REPLICATION;
```

### SAP application validation

```bash
# Run SAP HANA consistency check
hdbcons 'check table all'

# Verify SAP application connectivity
sapcontrol -nr 00 -function GetProcessList

# Run ABAP smoke tests
# Transaction SE38: Run test programs
# Transaction SM21: Check system log
# Transaction ST22: Check for ABAP dumps
```

---

## 5. CSA-in-a-Box integration after HANA migration

Once HANA is running on Azure, configure CSA-in-a-Box data integration:

1. **Configure Fabric Mirroring** for near-real-time HANA data in OneLake (see [Tutorial: SAP Data to Fabric](tutorial-sap-data-to-fabric.md))
2. **Configure ADF SAP HANA connector** for batch data extraction
3. **Configure Purview** to scan HANA metadata and classify SAP data
4. **Set up Azure Monitor for SAP** to monitor HANA health alongside CSA-in-a-Box workloads

---

## 6. HANA version and patch considerations

### Supported HANA versions on Azure

| HANA version    | Support status            | S/4HANA compatibility | Azure certification | Notes                                     |
| --------------- | ------------------------- | --------------------- | ------------------- | ----------------------------------------- |
| HANA 2.0 SPS 05 | Active support            | S/4HANA 2020+         | Certified           | Minimum recommended for new deployments   |
| HANA 2.0 SPS 06 | Active support            | S/4HANA 2021+         | Certified           | Enhanced performance optimizations        |
| HANA 2.0 SPS 07 | Active support            | S/4HANA 2023+         | Certified           | Latest features including improved CDC    |
| HANA 1.0        | End of maintenance (2022) | ECC only              | Legacy              | Must upgrade to HANA 2.0 during migration |

### HANA revision upgrade during migration

When migrating HANA to Azure, upgrade to the latest supported HANA revision. The recommended approach:

1. **Migrate first, upgrade second** --- Migrate HANA to Azure on the current revision
2. **Validate** --- Confirm system stability on Azure
3. **Apply latest HANA revision** --- Upgrade to latest SPS/Rev using `hdblcm --update`
4. **Validate again** --- Run regression tests after HANA upgrade

```bash
# Check current HANA revision
hdbsql -U SYSTEM -d SYSTEMDB "SELECT VERSION FROM M_DATABASE"

# Update HANA to latest revision
cd /hana/shared/S4H/hdblcm
./hdblcm --action=update \
  --component_medium=/hana/shared/install/HANA_SPS07_REV72 \
  --batch
```

---

## 7. Multi-tenant HANA considerations

SAP HANA supports Multi-Tenant Database Containers (MDC). When migrating MDC systems to Azure:

| Consideration                    | Approach                                                          |
| -------------------------------- | ----------------------------------------------------------------- |
| Multiple tenant databases        | Each tenant migrates independently; stagger for risk reduction    |
| Tenant-specific Fabric Mirroring | Configure separate mirrored databases per tenant in Fabric        |
| Tenant isolation                 | Same HANA host on Azure; tenants isolated by database container   |
| Backup per tenant                | Azure Backup supports per-tenant HANA backup                      |
| HSR with tenants                 | HSR replicates all tenants together; cannot selectively replicate |

---

## 8. Common HANA migration failures and resolution

| Failure                                  | Cause                                         | Resolution                                                       |
| ---------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------- |
| HSR sync breaks during initial copy      | Network instability between on-prem and Azure | Use ExpressRoute (not VPN) for HSR; increase timeout values      |
| Backup restore fails: checksum error     | File corruption during transfer               | Re-transfer backup using AzCopy with `--check-md5` validation    |
| DMO fails: target HANA out of memory     | HANA memory allocation limit too low          | Set `global_allocation_limit` to 90% of VM memory                |
| HSR takeover fails: primary still active | Split-brain scenario; fencing not configured  | Configure STONITH via Azure Fence Agent before HSR               |
| Post-migration: slow query performance   | Missing statistics after HANA data load       | Run `ANALYZE TABLE <table>` or `UPDATE STATISTICS` on key tables |
| Restore fails: incompatible HANA version | Target HANA revision lower than source        | Upgrade target HANA to match or exceed source revision           |

---

**Last updated:** 2026-04-30
**Maintainers:** CSA-in-a-Box core team
**Related:** [Infrastructure Migration](infrastructure-migration.md) | [S/4HANA Conversion](s4hana-conversion.md) | [Benchmarks](benchmarks.md) | [Tutorial: Deploy SAP on Azure](tutorial-sap-azure-deployment.md)
