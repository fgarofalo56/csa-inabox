# SAP on Azure: Best Practices

**Landing zone design, HA/DR architecture, monitoring, backup, cost optimization, and CSA-in-a-Box integration for SAP workloads on Azure.**

---

## Overview

This document consolidates best practices for running SAP on Azure, drawn from Microsoft's SAP Center of Excellence, SAP-certified architecture patterns, and CSA-in-a-Box deployment experience. These practices apply to all SAP deployment models: SAP on Azure VMs (self-managed), RISE with SAP on Azure, and HANA Large Instances.

---

## 1. Landing zone design

### Subscription topology

Follow the Azure Landing Zone (ALZ) enterprise-scale pattern with SAP-specific subscriptions:

```
Management Group Hierarchy
├── Tenant Root Group
│   ├── Platform
│   │   ├── Management (Log Analytics, Sentinel, Monitor)
│   │   ├── Identity (Entra ID, DNS)
│   │   └── Connectivity (Hub VNet, Firewall, ExpressRoute)
│   ├── Landing Zones
│   │   ├── SAP Production (sub-sap-prd)
│   │   │   ├── rg-sap-hana-prd
│   │   │   ├── rg-sap-app-prd
│   │   │   └── rg-sap-network-prd
│   │   ├── SAP Non-Production (sub-sap-nonprod)
│   │   │   ├── rg-sap-hana-qas
│   │   │   ├── rg-sap-hana-dev
│   │   │   └── rg-sap-app-nonprod
│   │   └── CSA-in-a-Box Data (sub-csa-data)
│   │       ├── rg-fabric-workspace
│   │       ├── rg-purview-governance
│   │       └── rg-ai-integration
│   └── Sandbox (sub-sap-sandbox)
```

### Best practices

| Practice                                    | Rationale                                                          |
| ------------------------------------------- | ------------------------------------------------------------------ |
| Separate SAP PRD from non-PRD subscriptions | Cost isolation, RBAC boundary, policy enforcement                  |
| SAP-specific Azure Policy initiative        | Enforce VM sizes, encryption, NSG rules, tagging                   |
| Hub-spoke network with Azure Firewall       | Centralized egress, traffic inspection, DNS resolution             |
| Proximity placement groups for SAP          | Sub-millisecond latency between app and DB tiers                   |
| No public IPs on SAP VMs                    | Azure Bastion for management access; Private Link for services     |
| Resource naming convention                  | `{resourcetype}-{workload}-{environment}-{region}`                 |
| Tagging standard                            | `CostCenter`, `Environment`, `Application`, `Owner`, `SAPSystemID` |

---

## 2. High availability architecture

### HANA HA with availability zones

```
Zone 1                              Zone 2
┌─────────────────────┐            ┌─────────────────────┐
│ HANA Primary (M128s)│            │ HANA Secondary      │
│ ASCS                │            │ ERS                 │
│ App Server 1        │            │ App Server 2        │
│ ANF data/log (zone1)│            │ ANF data/log (zone2)│
└─────────────────────┘            └─────────────────────┘
         │                                  │
         └──────── HSR (syncmem) ───────────┘
         │                                  │
         └──── Azure Load Balancer ─────────┘
                 (Standard, zone-redundant)
```

### HA best practices

| Component                 | Best practice                                     | Rationale                                  |
| ------------------------- | ------------------------------------------------- | ------------------------------------------ |
| HANA                      | HSR with synchronous in-memory (syncmem)          | Zero data loss, read-enabled secondary     |
| ASCS/ERS                  | ENSA2 with Pacemaker (SUSE) or WSFC (Windows)     | Enqueue lock protection                    |
| Load balancer             | Standard SKU, zone-redundant, HA ports            | Health probe on custom port (e.g., 62503)  |
| Pacemaker                 | STONITH via Azure Fence Agent                     | Prevent split-brain scenarios              |
| Storage                   | ANF with zonal placement; replicate to both zones | Storage follows compute zone               |
| App servers               | Minimum 2, spread across availability zones       | Active-active for dialog processing        |
| Web Dispatcher            | 2 instances behind Azure Load Balancer            | Load distribution + failover               |
| Availability set vs zones | **Prefer availability zones**                     | 99.99% SLA vs 99.95% for availability sets |

---

## 3. Disaster recovery

### DR architecture

| Component           | HA (same region, cross-zone) | DR (cross-region)                          |
| ------------------- | ---------------------------- | ------------------------------------------ |
| HANA database       | HSR synchronous (RPO: 0)     | HSR asynchronous (RPO: < 15 min)           |
| Application servers | Availability zones           | Azure Site Recovery (RPO: < 15 min)        |
| Shared file systems | ANF zonal replication        | ANF Cross-Region Replication               |
| Configuration       | Real-time (clustered)        | Azure Backup (daily)                       |
| DNS                 | Automatic (LB health probe)  | Azure Traffic Manager or manual DNS update |

### DR best practices

| Practice                  | Details                                                               |
| ------------------------- | --------------------------------------------------------------------- |
| Define RPO/RTO per system | PRD: RPO < 15 min, RTO < 4 hours; QAS: RPO < 24 hours, RTO < 8 hours  |
| Test DR quarterly         | Full DR drill including HANA takeover, app restart, DNS cutover       |
| Automate DR failover      | Azure Automation runbooks for HANA takeover + app server start        |
| Pre-provision DR VMs      | Keep VMs deallocated in DR region; start on failover (saves cost)     |
| Document DR runbook       | Step-by-step for HANA takeover, DNS update, Fabric Mirroring redirect |
| Validate HSR lag          | Monitor `M_SYSTEM_REPLICATION` for replication delay                  |

---

## 4. Monitoring with Azure Monitor for SAP Solutions

### What to monitor

| Component        | Metric                     | Alert threshold | Action                                           |
| ---------------- | -------------------------- | --------------- | ------------------------------------------------ |
| HANA memory      | Used memory %              | > 80%           | Investigate memory consumers; consider VM resize |
| HANA CPU         | CPU utilization            | > 90% sustained | Identify expensive queries; scale up             |
| HANA disk IO     | Data volume latency        | > 3 ms          | Check ANF performance tier; review IO patterns   |
| HANA log         | Log write latency          | > 1 ms          | Check ANF Ultra tier; review log volume sizing   |
| HANA replication | HSR replication status     | != ACTIVE       | Investigate HSR break; reconnect                 |
| HANA backup      | Last successful backup age | > 24 hours      | Check Azure Backup job status                    |
| NetWeaver        | Enqueue lock count         | > 10,000        | Investigate lock contention                      |
| NetWeaver        | Dialog response time       | > 2 seconds     | Check HANA query performance; app server load    |
| NetWeaver        | Batch job failures         | > 0             | Review SM37 job log                              |
| OS               | Disk space /usr/sap        | < 20% free      | Clean log files; expand disk                     |
| OS               | Swap usage                 | > 0             | Investigate memory pressure                      |

### Configure Azure Monitor for SAP

```bash
# Create Azure Monitor for SAP Solutions resource
az workloads monitor create \
  --resource-group rg-sap-monitoring \
  --name monitor-sap-prd \
  --location eastus2 \
  --app-location eastus2 \
  --managed-rg-name rg-sap-monitor-managed \
  --routing-preference Default

# Add HANA provider
az workloads monitor provider-instance create \
  --resource-group rg-sap-monitoring \
  --monitor-name monitor-sap-prd \
  --provider-instance-name hana-prd \
  --provider-settings '{
    "providerType": "SapHana",
    "hanaHostname": "10.10.1.10",
    "hanaPort": "30015",
    "hanaDatabase": "SYSTEMDB",
    "sqlPort": "30013",
    "hanaDbUsername": "MONITOR_USER",
    "hanaDbPasswordUri": "https://kv-sap-secrets.vault.azure.net/secrets/hana-monitor-password"
  }'
```

---

## 5. Backup strategy

### Backup matrix

| Component                    | Backup method          | Frequency        | Retention | Storage tier |
| ---------------------------- | ---------------------- | ---------------- | --------- | ------------ |
| HANA database (full)         | Azure Backup (BACKINT) | Weekly (Sunday)  | 12 weeks  | Hot          |
| HANA database (differential) | Azure Backup (BACKINT) | Daily            | 2 weeks   | Hot          |
| HANA log backup              | Azure Backup (BACKINT) | Every 15 minutes | 2 weeks   | Hot          |
| HANA (long-term)             | Azure Backup           | Monthly          | 12 months | Archive      |
| SAP application config       | Azure Backup (VM)      | Daily            | 4 weeks   | Hot          |
| OS disks                     | Azure Backup (VM)      | Weekly           | 4 weeks   | Hot          |
| ANF snapshots                | ANF snapshot policy    | Every 4 hours    | 48 hours  | ANF          |
| Transport directory          | Azure Files backup     | Daily            | 4 weeks   | Cool         |

### Backup best practices

| Practice                                          | Rationale                                       |
| ------------------------------------------------- | ----------------------------------------------- |
| Use Azure Backup for SAP HANA (BACKINT-certified) | SAP-certified, no third-party needed            |
| Test restore monthly                              | Validate backup integrity; measure restore time |
| Encrypt backups                                   | Azure Backup encryption with CMK (Key Vault)    |
| Monitor backup jobs                               | Alert on failed backups within 4 hours          |
| Use ANF snapshots for rapid recovery              | Sub-second snapshot; restore in minutes         |
| Separate backup storage from production           | Prevent ransomware from encrypting backups      |

---

## 6. Cost optimization

### Reserved Instances

| Resource                 | RI term       | Savings vs PAYG | Notes                               |
| ------------------------ | ------------- | --------------- | ----------------------------------- |
| HANA VMs (PRD)           | 3-year        | 55--63%         | SAP HANA runs 24/7; always use RI   |
| HANA VMs (QAS)           | 1-year        | 35--45%         | QAS runs most business hours        |
| App server VMs (PRD)     | 3-year        | 50--60%         | Production app servers run 24/7     |
| App server VMs (non-PRD) | None (snooze) | 30--40%         | Stop DEV/SBX outside business hours |
| ANF capacity             | Reserved      | 10--15%         | Predictable capacity requirement    |

### Cost optimization best practices

| Practice                    | Savings            | Implementation                                           |
| --------------------------- | ------------------ | -------------------------------------------------------- |
| Snooze non-production VMs   | 30--40%            | Azure Automation schedule: stop at 7 PM, start at 7 AM   |
| Right-size after 90 days    | 10--20%            | Review Azure Advisor sizing recommendations              |
| Use dev/test pricing        | 40--55%            | Dev/test subscription for SAP sandbox/development        |
| Consolidate non-production  | 15--25%            | Run DEV + SBX on same VM (smaller sizes)                 |
| Azure Hybrid Benefit        | 40--50% (Windows)  | Apply existing Windows Server licenses                   |
| Spot VMs for batch/test     | 60--80%            | SAP performance testing on Spot VMs                      |
| Archive old SAP data        | 20--30% on storage | Move historical data to cool/archive; reduce HANA memory |
| Fabric capacity reservation | 10--25%            | Reserved Fabric capacity for SAP analytics               |

```bash
# Snooze non-production SAP VMs (Azure Automation)
# Schedule: Stop at 19:00, Start at 07:00 (weekdays)
az vm deallocate --resource-group rg-sap-nonprod --name vm-hana-dev --no-wait
az vm deallocate --resource-group rg-sap-nonprod --name vm-hana-sbx --no-wait
az vm deallocate --resource-group rg-sap-nonprod --name vm-app-dev --no-wait
```

---

## 7. CSA-in-a-Box integration best practices

### Data integration patterns

| Pattern                      | Use case                                         | Implementation                                          |
| ---------------------------- | ------------------------------------------------ | ------------------------------------------------------- |
| Fabric Mirroring (real-time) | Operational analytics, near-real-time dashboards | Configure mirrored database for high-change SAP tables  |
| ADF batch extraction         | Historical data migration, data warehouse loads  | SAP Table/BW/ODP connectors with partitioned extraction |
| dbt medallion architecture   | SAP data transformation (bronze/silver/gold)     | dbt models for SAP-specific business logic              |
| Event-driven integration     | SAP business events → Azure actions              | Logic Apps + Service Bus for SAP event processing       |

### Analytics best practices

| Practice                              | Details                                                                              |
| ------------------------------------- | ------------------------------------------------------------------------------------ |
| Start with Fabric Mirroring           | Configure mirroring for key SAP tables before building analytics                     |
| Use Direct Lake mode                  | Power BI Direct Lake on OneLake for near-import performance without data duplication |
| Build domain-specific semantic models | Separate Power BI semantic models for Finance, Supply Chain, HR, Procurement         |
| Implement RLS on SAP data             | Row-level security in Power BI aligned with SAP authorization objects                |
| Enable Copilot for Power BI           | Natural-language queries on SAP data for business users                              |

### Governance best practices

| Practice                     | Details                                                                      |
| ---------------------------- | ---------------------------------------------------------------------------- |
| Scan SAP HANA with Purview   | Discover and classify SAP data fields (PII, financial, HR-sensitive)         |
| Apply sensitivity labels     | Microsoft Information Protection labels on SAP data in OneLake               |
| Define data ownership        | Assign SAP domain data stewards in Purview                                   |
| Implement data quality rules | dbt tests for SAP data quality (uniqueness, referential integrity, not null) |
| Enable lineage tracking      | Purview automatic lineage from SAP HANA → Fabric → Power BI                  |

### AI best practices

| Practice                         | Details                                                             |
| -------------------------------- | ------------------------------------------------------------------- |
| Start with descriptive analytics | Build Power BI dashboards before investing in ML                    |
| Use Azure OpenAI for quick wins  | Prompt-based analytics on SAP data (summarize, detect, explain)     |
| Build ML models in Databricks    | Demand forecasting, anomaly detection, churn prediction on SAP data |
| Register models in Azure ML      | Model versioning, deployment, monitoring                            |
| Implement feedback loops         | Business user validation of AI-generated insights                   |

---

## 8. Security best practices

| Practice                 | Implementation                                                   |
| ------------------------ | ---------------------------------------------------------------- |
| No public IPs on SAP VMs | Azure Bastion for SSH/RDP; Private Link for all services         |
| Entra ID SSO for SAP     | SAML 2.0 SSO for Fiori, Web GUI, HANA Studio                     |
| MFA for SAP access       | Entra ID Conditional Access with MFA requirement                 |
| Network segmentation     | Separate subnets for DB, app, web, management tiers              |
| Encrypt everything       | HANA TDE (Key Vault), disk encryption, TLS in transit            |
| Defender for Cloud       | Enable Defender for SAP workloads; stream to Sentinel            |
| Audit logging            | SAP Security Audit Log + Azure Monitor + Sentinel                |
| Regular patching         | Azure Update Manager for OS; SAP kernel patches per SAP schedule |

---

## 9. Operations runbook checklist

### Daily operations

- [ ] Verify HANA backup completion (Azure Backup dashboard)
- [ ] Check HSR replication status (Azure Monitor for SAP)
- [ ] Review SAP system log (SM21) for errors
- [ ] Check ABAP dump log (ST22) for new dumps
- [ ] Monitor HANA memory utilization (< 80%)
- [ ] Review batch job failures (SM37)

### Weekly operations

- [ ] Review Azure Advisor recommendations
- [ ] Check HANA alert monitoring (HANA cockpit or ACSS)
- [ ] Review security audit log for suspicious activity
- [ ] Validate ANF snapshot policy execution
- [ ] Check Azure Cost Management for anomalies

### Monthly operations

- [ ] Test backup restore (select one system)
- [ ] Review VM right-sizing recommendations
- [ ] Update SAP kernel if patches available
- [ ] Review Purview data classification scan results
- [ ] Update Fabric Mirroring table selection if schema changes

### Quarterly operations

- [ ] Full DR drill (HANA takeover + app restart)
- [ ] SAP security review (user access, authorization)
- [ ] Cost optimization review (RI utilization, snooze compliance)
- [ ] Performance baseline comparison (SAPS, response times)

---

**Last updated:** 2026-04-30
**Maintainers:** CSA-in-a-Box core team
**Related:** [Infrastructure Migration](infrastructure-migration.md) | [Benchmarks](benchmarks.md) | [Federal Migration Guide](federal-migration-guide.md) | [SAP to Azure Migration Center](index.md)
