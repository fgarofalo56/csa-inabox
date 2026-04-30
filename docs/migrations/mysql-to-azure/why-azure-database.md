# Why Azure Database for MySQL / MariaDB Workloads

**Executive brief: the strategic, operational, and technical case for migrating self-hosted MySQL and MariaDB to Azure Database for MySQL Flexible Server, Azure Database for PostgreSQL Flexible Server, or Azure SQL Database.**

---

!!! abstract "Executive summary"
MySQL is the world's most popular open-source database, with over 10 million active deployments. But self-hosting MySQL -- whether on bare metal, VMs, or containers -- carries operational costs that are invisible on the invoice: DBA labor, patching risk, backup management, disaster recovery testing, capacity planning, and security hardening. Azure Database for MySQL Flexible Server eliminates these burdens while adding enterprise capabilities that MySQL Community Edition does not include: zone-redundant high availability, Entra ID authentication, Private Link networking, intelligent performance recommendations, and native integration with the Microsoft analytics and AI ecosystem. For organizations reassessing Oracle's stewardship of MySQL, Azure provides a managed service free from single-vendor commercial risk.

---

## 1. The MySQL/MariaDB operational burden

### 1.1 What self-hosting really costs

Every self-hosted MySQL instance requires ongoing investment in areas that produce no direct business value:

| Operational area       | Self-hosted responsibility                                                                                           | Azure Flexible Server                                                              |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| **OS patching**        | Schedule maintenance windows, test patches, apply to every server, handle reboots                                    | Automated, zero-downtime minor version updates                                     |
| **MySQL patching**     | Download releases, test in staging, apply to each instance, manage rollback                                          | Automated minor version updates, customer-controlled major version upgrades        |
| **High availability**  | Design, deploy, and test MySQL replication (async/semi-sync/group), manage failover scripts, monitor replication lag | Built-in zone-redundant HA with automatic failover (99.99% SLA)                    |
| **Backups**            | Configure mysqldump/xtrabackup cron jobs, manage backup storage, test restores quarterly                             | Automated daily snapshots, 1-35 day retention, point-in-time restore to any second |
| **Disaster recovery**  | Maintain standby in separate data center, replicate data, test failover annually                                     | Geo-redundant backup storage, cross-region read replicas                           |
| **Capacity planning**  | Monitor disk, CPU, memory, forecast growth, procure hardware 3-6 months ahead                                        | Elastic compute scaling (scale up/down in minutes), storage auto-grow              |
| **Security hardening** | Configure TLS, manage certificates, enforce password policies, audit access                                          | TLS 1.2/1.3 enforced by default, Entra ID authentication, Azure Defender           |
| **Performance tuning** | Analyze slow query logs, tune buffer pool, optimize queries manually                                                 | Intelligent Performance Insights, automated index recommendations, Query Store     |
| **Monitoring**         | Deploy and maintain Prometheus/Grafana, Zabbix, or Nagios stacks                                                     | Built-in Azure Monitor metrics, diagnostic logs, alert rules                       |
| **Compliance**         | Self-assess, document controls, hire auditors                                                                        | Inherits Azure FedRAMP High, HIPAA, SOC 2, ISO 27001 certifications                |

### 1.2 The DBA labor equation

A single MySQL DBA managing 10-20 production instances spends their time roughly as follows:

| Activity                              | Percentage of time | Value to business                |
| ------------------------------------- | ------------------ | -------------------------------- |
| Patching and upgrades                 | 20%                | None (maintenance)               |
| Backup management and testing         | 15%                | Risk mitigation only             |
| Monitoring and alerting               | 15%                | Operational awareness            |
| Incident response                     | 10%                | Reactive                         |
| Capacity planning and hardware        | 10%                | Infrastructure overhead          |
| Security and compliance               | 10%                | Required but non-differentiating |
| Performance tuning and optimization   | 10%                | Direct value                     |
| Schema design and application support | 10%                | Direct value                     |

Only 20% of DBA time produces direct business value. Azure Flexible Server automates or eliminates the other 80%, allowing DBAs to focus on schema optimization, query performance, data modeling, and application architecture -- the work that actually differentiates the organization.

---

## 2. Oracle's ownership of MySQL -- a strategic concern

### 2.1 The acquisition history

Oracle acquired MySQL through its 2010 purchase of Sun Microsystems. The open-source community's concerns have proven partially justified over the past 16 years:

| Concern                    | What happened                                                                                                   | Impact                                                                               |
| -------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| **Feature gating**         | Thread Pool, Enterprise Audit, Enterprise Encryption, Enterprise Backup, Enterprise Monitor are Enterprise-only | Organizations needing these features must pay Oracle or use third-party alternatives |
| **Development pace**       | MySQL 8.0 was a strong release, but the Community Edition development pace has been criticized                  | MariaDB, Percona, and community patches sometimes move faster                        |
| **Commercial licensing**   | MySQL Enterprise Edition pricing has increased; per-socket licensing introduced                                 | Cost pressure similar to Oracle Database                                             |
| **Java SE licensing**      | Oracle changed Java SE licensing to employee-based ($15/employee/month) in 2023                                 | Affects organizations running Java applications with MySQL                           |
| **Open-source governance** | MySQL's development is Oracle-controlled; community influence is limited                                        | Contrast with PostgreSQL's community-governed model                                  |
| **Audit risk**             | Oracle LMS audits can include MySQL Enterprise Edition compliance                                               | Federal agencies face audit exposure                                                 |

### 2.2 MariaDB's commercial shift

MariaDB Corporation has introduced its own commercial concerns:

- **MariaDB BSL (Business Source License)** applied to MaxScale and other components -- not fully open source
- **SkySQL** cloud service pricing is not competitive with Azure managed services
- **MariaDB Corporation financial challenges** have raised questions about long-term investment in the open-source engine
- **Feature divergence** from MySQL makes MariaDB increasingly a separate product rather than a drop-in replacement

### 2.3 Azure as the neutral ground

Azure Database for MySQL Flexible Server runs MySQL Community Edition -- the fully open-source, GPL-licensed engine. It does not require any commercial relationship with Oracle. Microsoft's investment in the managed service provides enterprise capabilities that Oracle gates behind Enterprise Edition:

| MySQL Enterprise Edition feature | Azure MySQL Flexible Server equivalent          | Cost                |
| -------------------------------- | ----------------------------------------------- | ------------------- |
| Enterprise Monitor               | Azure Monitor + Performance Insights            | Included            |
| Enterprise Audit                 | Audit log plugin (enabled via server parameter) | Included            |
| Enterprise Backup                | Automated backups with PITR                     | Included            |
| Enterprise Encryption            | TLS 1.2/1.3, CMK encryption at rest             | Included            |
| Thread Pool                      | Built-in connection management                  | Included            |
| Enterprise Firewall              | Azure Firewall + Private Link                   | Included            |
| Enterprise Authentication        | Entra ID authentication                         | Included            |
| Enterprise High Availability     | Zone-redundant HA                               | Included in HA tier |

---

## 3. Azure Flexible Server capabilities

### 3.1 Managed service fundamentals

Azure Database for MySQL Flexible Server is a fully managed database service built on MySQL Community Edition. It provides:

**Compute flexibility:**

- **Burstable tier** (B-series): 1-20 vCores, ideal for dev/test and intermittent workloads. Burstable instances accumulate CPU credits during idle periods and burst above baseline when needed.
- **General Purpose tier** (D-series): 2-96 vCores, balanced compute-to-memory ratio for production OLTP workloads.
- **Memory Optimized tier** (E-series): 2-96 vCores, high memory-to-compute ratio for caching-intensive and analytics workloads.
- **Compute auto-scale** allows scaling vCores without data movement (brief reconnection during scale operation).

**Storage:**

- Premium SSD storage from 20 GB to 16 TB
- Storage auto-grow prevents out-of-space failures
- IOPS scale with storage size (3 IOPS/GB baseline, up to 80,000 IOPS with pre-provisioned IOPS)
- Pre-provisioned IOPS available independently of storage size for I/O-intensive workloads

**High availability:**

- **Zone-redundant HA:** Standby server in a different availability zone, automatic failover in 60-120 seconds, 99.99% SLA
- **Same-zone HA:** Standby in the same zone, lower latency failover, 99.99% SLA
- **No HA:** Single server, 99.9% SLA, suitable for dev/test

### 3.2 Security and compliance

| Security capability            | Details                                                                                                                   |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| **Entra ID authentication**    | Authenticate using Azure AD tokens instead of MySQL passwords; supports managed identities for application authentication |
| **TLS enforcement**            | TLS 1.2 and 1.3 enforced for all connections; configurable minimum TLS version                                            |
| **Private Link**               | Connect to MySQL over a private endpoint in your VNet; no public internet exposure                                        |
| **VNet integration**           | Deploy Flexible Server directly into a VNet subnet for network-level isolation                                            |
| **Data encryption at rest**    | AES-256 encryption using service-managed keys or customer-managed keys (CMK) in Azure Key Vault                           |
| **Data encryption in transit** | TLS 1.2/1.3 with certificate verification                                                                                 |
| **Azure Defender for MySQL**   | Threat detection for anomalous database activities (brute force, SQL injection, unusual access patterns)                  |
| **Audit logging**              | MySQL audit log plugin captures connections, queries, table access; logs stream to Azure Monitor or Log Analytics         |
| **FedRAMP High**               | Authorized in Azure Government regions                                                                                    |
| **DoD IL4/IL5**                | Authorized in Azure Government regions                                                                                    |
| **HIPAA**                      | BAA-covered service                                                                                                       |
| **SOC 1/2/3**                  | Certified                                                                                                                 |
| **ISO 27001/27017/27018**      | Certified                                                                                                                 |

### 3.3 Intelligent performance

| Feature                         | Description                                                                                                  |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **Query Performance Insights**  | Identify top resource-consuming queries, view query execution statistics, track performance trends over time |
| **Slow query log**              | Configurable threshold (default 10 seconds, adjustable to sub-second); logs to Azure Monitor                 |
| **Performance recommendations** | Automated index recommendations based on query patterns                                                      |
| **Query Store**                 | Tracks query execution plans and runtime statistics; helps identify plan regressions                         |
| **InnoDB buffer pool metrics**  | Monitor buffer pool hit ratio, pages read/written, adaptive hash index usage                                 |
| **Connection metrics**          | Active connections, failed connections, connection pooling statistics                                        |
| **Replication metrics**         | Replica lag, I/O thread status, SQL thread status for read replicas                                          |

### 3.4 Read replicas

- Up to 10 read replicas per primary server
- Cross-region read replicas for global read distribution
- Automatic replication from primary to replicas
- Promote replica to standalone server for DR or region migration
- Read replicas share the same server parameters as primary

### 3.5 Maintenance and updates

- **Minor version updates:** Automated, applied during customer-defined maintenance windows
- **Major version upgrades:** Customer-initiated, in-place upgrade with rollback capability
- **Custom maintenance window:** Schedule maintenance during low-traffic periods
- **Planned maintenance notifications:** Azure Service Health alerts before maintenance events

---

## 4. Comparison with alternatives

### 4.1 Azure MySQL Flexible Server vs self-hosted MySQL on Azure VMs

| Aspect                 | Azure MySQL Flexible Server   | MySQL on Azure VM                          |
| ---------------------- | ----------------------------- | ------------------------------------------ |
| **Management**         | Fully managed                 | Customer manages OS, MySQL, patching       |
| **HA**                 | Built-in zone-redundant       | Customer deploys replication + ProxySQL    |
| **Backups**            | Automated with PITR           | Customer configures xtrabackup/mysqldump   |
| **Scaling**            | Portal/CLI/API (minutes)      | Manual VM resize, potential data migration |
| **Cost**               | Compute + storage + backup    | VM + disks + DBA labor + backup storage    |
| **Security**           | Entra ID, Private Link, CMK   | Customer configures everything             |
| **Compliance**         | Inherits Azure certifications | Customer must demonstrate controls         |
| **Performance tuning** | Intelligent recommendations   | Manual analysis                            |
| **Best for**           | Production workloads          | Custom MySQL builds, unsupported versions  |

### 4.2 Azure MySQL Flexible Server vs Amazon RDS for MySQL

| Aspect                    | Azure MySQL Flexible Server           | Amazon RDS for MySQL         |
| ------------------------- | ------------------------------------- | ---------------------------- |
| **Engine versions**       | MySQL 8.0, 8.4                        | MySQL 8.0, 8.4               |
| **HA**                    | Zone-redundant (99.99%)               | Multi-AZ (99.95%)            |
| **Read replicas**         | Up to 10, cross-region                | Up to 15, cross-region       |
| **Storage**               | Up to 16 TB, auto-grow                | Up to 64 TB (gp3/io1)        |
| **Identity integration**  | Entra ID (Azure AD)                   | IAM database authentication  |
| **Analytics integration** | Fabric Mirroring, ADF                 | Redshift, Glue               |
| **Federal regions**       | Azure Government (FedRAMP High, IL5)  | GovCloud (FedRAMP High, IL5) |
| **Pricing**               | Competitive with Azure Hybrid Benefit | Standard RDS pricing         |
| **Governance**            | Microsoft Purview integration         | AWS Glue Data Catalog        |

### 4.3 Azure MySQL Flexible Server vs Google Cloud SQL for MySQL

| Aspect              | Azure MySQL Flexible Server          | Cloud SQL for MySQL              |
| ------------------- | ------------------------------------ | -------------------------------- |
| **Engine versions** | MySQL 8.0, 8.4                       | MySQL 8.0, 8.4                   |
| **HA**              | Zone-redundant (99.99%)              | Regional (99.95%)                |
| **Storage**         | Up to 16 TB                          | Up to 64 TB                      |
| **Identity**        | Entra ID                             | IAM                              |
| **Federal**         | Azure Government (FedRAMP High, IL5) | Assured Workloads (FedRAMP High) |
| **Analytics**       | Fabric Mirroring, Purview            | BigQuery, Dataplex               |

---

## 5. Innovation velocity

### 5.1 Features available on Azure MySQL Flexible Server today

These capabilities are available without additional licensing, configuration complexity, or third-party tooling:

- **Zone-redundant high availability** with automatic failover
- **Point-in-time restore** to any second within the retention window
- **Cross-region read replicas** for disaster recovery and global reads
- **Entra ID authentication** with managed identity support
- **Private Link** for zero-trust network architecture
- **Customer-managed encryption keys** via Azure Key Vault
- **Intelligent Performance Insights** with query-level analytics
- **Azure Monitor integration** for unified observability
- **Fabric Mirroring** for near-real-time analytics without ETL
- **Microsoft Purview** for data governance, classification, and lineage
- **Azure AI integration** for intelligent applications powered by MySQL data

### 5.2 Microsoft's investment trajectory

Microsoft continues to invest heavily in Azure Database for MySQL:

- **MySQL 8.4 support** with long-term support (LTS) version
- **Improved IOPS performance** with pre-provisioned IOPS
- **Enhanced HA** with faster failover times
- **Fabric Mirroring for MySQL** enabling real-time analytics
- **Azure AI integration** connecting MySQL data to Azure OpenAI and AI Foundry
- **Cost optimization** with reserved capacity (up to 65% savings) and burstable tier

---

## 6. When to stay on MySQL vs switch engines

| Stay on Azure MySQL Flexible Server when                | Switch to PostgreSQL when                            | Switch to Azure SQL when                         |
| ------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------ |
| Application is certified for MySQL                      | Organization has PostgreSQL expertise                | Consolidating onto Microsoft stack               |
| Stored procedures use MySQL-specific syntax extensively | Need advanced JSON (JSONB), CTE, window functions    | Need Fabric Mirroring GA for real-time analytics |
| Team has deep MySQL expertise                           | Need PostGIS for geospatial workloads                | T-SQL ecosystem alignment                        |
| Minimal migration risk is priority                      | Want access to PostgreSQL extension ecosystem        | Need features like temporal tables, graph        |
| WordPress, Drupal, Magento, or MySQL-certified SaaS     | Scaling with Citus (horizontal sharding)             | Azure SQL Hyperscale (100 TB)                    |
| MariaDB migration with minimal changes                  | Long-term open-source community governance preferred | Enterprise reporting with SSRS/SSAS              |

---

## 7. Call to action

For organizations running self-hosted MySQL or MariaDB, the migration to Azure Database for MySQL Flexible Server delivers measurable returns:

1. **Immediate:** Eliminate patching, backup management, and HA configuration overhead
2. **Short-term (3-6 months):** Reduce DBA operational burden by 60-80%, enabling focus on value-adding work
3. **Medium-term (1 year):** Integrate with CSA-in-a-Box analytics platform for enterprise data strategy
4. **Long-term (3-5 years):** 40-60% total cost reduction versus self-hosted infrastructure

Start with a pilot workload -- a non-critical application or read replica -- to validate the migration path and build organizational confidence. The [TCO Analysis](tco-analysis.md) provides the financial case, and the [Tutorial: DMS Online Migration](tutorial-dms-migration.md) provides hands-on experience.

---

**Next:** [Total Cost of Ownership Analysis](tco-analysis.md) | [Feature Mapping](feature-mapping-complete.md) | [Migration Playbook](../mysql-to-azure.md)

---

**Maintainers:** csa-inabox core team
**Last updated:** 2026-04-30
