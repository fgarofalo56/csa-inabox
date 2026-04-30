# SAP Migration: Total Cost of Ownership Analysis

**A detailed cost comparison for CFOs, CIOs, and procurement teams evaluating the financial case for migrating SAP workloads from on-premises to Azure.**

---

!!! warning "2027 Deadline Cost Impact"
Delaying SAP migration past the December 2027 ECC end-of-mainstream-maintenance deadline triggers a 2% annual premium for extended maintenance. For a typical enterprise paying EUR 5M/year in SAP maintenance, this adds EUR 100K/year with no new features, no regulatory updates, and diminishing security patch coverage. The cost of delay is real and compounding.

## Overview

This analysis compares four SAP deployment scenarios across 3-year and 5-year horizons:

1. **On-premises SAP** (current state baseline)
2. **SAP on Azure VMs** (self-managed, IaaS)
3. **RISE with SAP on Azure** (SAP-managed, subscription)
4. **HANA Large Instances** (bare-metal, for extreme scale)

Cost categories include: compute, storage, database licensing, operating system, SAP application licensing, administration FTE, networking, disaster recovery, and the CSA-in-a-Box analytics layer that extends SAP data into Fabric, Power BI, and Azure AI.

---

## 1. Reference architecture --- typical enterprise SAP landscape

The following reference landscape is used throughout this analysis. Adjust for your environment.

| System           | Purpose                       | HANA size | Application servers | Environments       |
| ---------------- | ----------------------------- | --------- | ------------------- | ------------------ |
| S/4HANA (ECC)    | Core ERP: FI/CO, MM, SD, PP   | 2 TB      | 3 app servers       | PRD, QAS, DEV, SBX |
| BW/4HANA         | Business warehouse, reporting | 4 TB      | 2 app servers       | PRD, QAS, DEV      |
| Solution Manager | SAP monitoring, ChaRM         | 500 GB    | 1 app server        | PRD                |
| SAP PI/PO        | Integration platform          | 250 GB    | 1 app server        | PRD, QAS           |
| SAP Fiori        | UX front-end server           | N/A       | 1 app server        | PRD                |

**Total HANA memory requirement (production):** ~7 TB
**Total environments:** 12 SAP instances across PRD, QAS, DEV, SBX

---

## 2. On-premises SAP baseline (current state)

### Capital expenditure (hardware refresh cycle: 5 years)

| Cost category                   | Annual cost (USD) | Notes                                                        |
| ------------------------------- | ----------------- | ------------------------------------------------------------ |
| HANA appliance (production)     | $180,000          | 8 TB HANA appliance, amortized over 5 years ($900K purchase) |
| HANA appliance (non-production) | $90,000           | Scaled-down QAS/DEV/SBX appliances, amortized                |
| Application server hardware     | $60,000           | x86 servers for NetWeaver, amortized                         |
| SAN storage                     | $50,000           | Enterprise SAN for SAP data, backups                         |
| Network infrastructure          | $25,000           | Switches, load balancers, firewalls (SAP share)              |
| DR hardware (secondary site)    | $120,000          | Replicated HANA + app servers at DR site, amortized          |
| **Hardware subtotal**           | **$525,000**      |                                                              |

### Operating expenditure

| Cost category                             | Annual cost (USD) | Notes                                             |
| ----------------------------------------- | ----------------- | ------------------------------------------------- |
| SAP maintenance fees                      | $2,500,000        | 22% of license value; typical enterprise          |
| SUSE/RHEL subscriptions                   | $80,000           | OS licensing for all SAP servers                  |
| Oracle/DB2 licensing (if non-HANA)        | $400,000          | Database licensing; eliminated if already on HANA |
| VMware licensing                          | $60,000           | Virtualization layer for non-HANA systems         |
| SAP Basis administrators (3 FTE)          | $450,000          | $150K loaded cost per Basis admin                 |
| Infrastructure administrators (2 FTE)     | $260,000          | $130K loaded cost per infra admin                 |
| Data center costs (power, cooling, space) | $150,000          | SAP share of data center OPEX                     |
| Backup infrastructure + media             | $40,000           | Tape/disk backup for SAP                          |
| DR testing + network (WAN)                | $35,000           | Annual DR drill, WAN connectivity                 |
| **OPEX subtotal**                         | **$3,975,000**    |                                                   |

### Total on-premises annual cost

|                       | Annual         | 3-year          | 5-year          |
| --------------------- | -------------- | --------------- | --------------- |
| **On-premises total** | **$4,500,000** | **$13,500,000** | **$22,500,000** |

---

## 3. SAP on Azure VMs (self-managed)

### Compute costs

| System                    | VM size           | Monthly cost (PAYG) | Monthly cost (3-yr RI) | Qty | Annual (RI)  |
| ------------------------- | ----------------- | ------------------- | ---------------------- | --- | ------------ |
| S/4HANA HANA DB (PRD)     | Standard_M128s    | $21,837             | $9,627                 | 1   | $115,524     |
| S/4HANA HANA DB (QAS)     | Standard_M64s     | $10,918             | $4,814                 | 1   | $57,768      |
| S/4HANA HANA DB (DEV)     | Standard_M32ts    | $3,656              | $1,612                 | 1   | $19,344      |
| BW/4HANA HANA DB (PRD)    | Standard_M208s_v2 | $36,395             | $16,051                | 1   | $192,612     |
| BW/4HANA HANA DB (QAS)    | Standard_M128s    | $21,837             | $9,627                 | 1   | $115,524     |
| BW/4HANA HANA DB (DEV)    | Standard_M64s     | $10,918             | $4,814                 | 1   | $57,768      |
| App servers (PRD, 3x)     | Standard_E32ds_v5 | $2,214              | $977                   | 3   | $35,172      |
| App servers (non-PRD, 5x) | Standard_E16ds_v5 | $1,107              | $488                   | 5   | $29,280      |
| SolMan + PI/PO + Fiori    | Standard_E16ds_v5 | $1,107              | $488                   | 4   | $23,424      |
| **Compute subtotal**      |                   |                     |                        |     | **$646,416** |

!!! tip "Azure Hybrid Benefit"
Organizations with existing Windows Server or SQL Server licenses with Software Assurance can apply Azure Hybrid Benefit, reducing Windows VM costs by up to 40%. For Linux-based SAP (SUSE/RHEL), check for BYOS (Bring Your Own Subscription) options.

### Storage costs

| Storage type                  | Size  | Monthly cost | Annual cost | Purpose              |
| ----------------------------- | ----- | ------------ | ----------- | -------------------- |
| ANF (HANA data, PRD)          | 8 TB  | $3,200       | $38,400     | HANA data volumes    |
| ANF (HANA log, PRD)           | 2 TB  | $800         | $9,600      | HANA log volumes     |
| Premium SSD v2 (non-PRD HANA) | 12 TB | $1,200       | $14,400     | QAS/DEV HANA         |
| Premium SSD (app servers)     | 4 TB  | $600         | $7,200      | SAP application data |
| Standard SSD (backups)        | 20 TB | $600         | $7,200      | SAP backup storage   |
| **Storage subtotal**          |       |              | **$76,800** |                      |

### Additional Azure costs

| Cost category                   | Annual cost (USD) | Notes                                 |
| ------------------------------- | ----------------- | ------------------------------------- |
| Azure Monitor for SAP Solutions | $12,000           | HANA + NetWeaver monitoring           |
| Azure Backup (SAP HANA)         | $24,000           | HANA streaming backup to Azure        |
| Azure Site Recovery (DR)        | $18,000           | App server DR replication             |
| ExpressRoute (or VPN)           | $36,000           | Hybrid connectivity to on-premises    |
| Azure Firewall                  | $15,600           | Network security for SAP VNet         |
| SUSE/RHEL PAYG                  | $48,000           | OS licensing (included in VM if PAYG) |
| **Additional Azure subtotal**   | **$153,600**      |                                       |

### Administration costs (reduced)

| Cost category                      | Annual cost (USD) | Notes                                                    |
| ---------------------------------- | ----------------- | -------------------------------------------------------- |
| SAP Basis administrators (2.5 FTE) | $375,000          | Reduced from 3 FTE; ACSS automates deployment/monitoring |
| Cloud infrastructure (1 FTE)       | $150,000          | Replaces 2 on-prem infra FTE                             |
| **Admin subtotal**                 | **$525,000**      |                                                          |

### SAP licensing (unchanged)

| Cost category        | Annual cost (USD) | Notes                                      |
| -------------------- | ----------------- | ------------------------------------------ |
| SAP maintenance fees | $2,500,000        | Unchanged; SAP licensing is cloud-agnostic |

### Total SAP on Azure VMs (self-managed)

|                    | Annual         | 3-year          | 5-year          |
| ------------------ | -------------- | --------------- | --------------- |
| Compute (3-yr RI)  | $646,416       | $1,939,248      | $3,232,080      |
| Storage            | $76,800        | $230,400        | $384,000        |
| Additional Azure   | $153,600       | $460,800        | $768,000        |
| Administration     | $525,000       | $1,575,000      | $2,625,000      |
| SAP maintenance    | $2,500,000     | $7,500,000      | $12,500,000     |
| **Azure VM total** | **$3,901,816** | **$11,705,448** | **$19,509,080** |

### Savings vs on-premises

| Horizon | On-premises | Azure VMs   | Savings        | Savings % |
| ------- | ----------- | ----------- | -------------- | --------- |
| 3-year  | $13,500,000 | $11,705,448 | **$1,794,552** | **13.3%** |
| 5-year  | $22,500,000 | $19,509,080 | **$2,990,920** | **13.3%** |

---

## 4. RISE with SAP on Azure (SAP-managed)

RISE pricing is per-user subscription. The following estimates use publicly available guidance; actual RISE pricing varies by negotiation.

### RISE subscription costs (estimated)

| Cost category                          | Annual cost (USD) | Notes                                                                   |
| -------------------------------------- | ----------------- | ----------------------------------------------------------------------- |
| RISE subscription (2,000 named users)  | $3,600,000        | ~$150/user/month; includes S/4HANA license, HANA, infrastructure, Basis |
| SAP BTP (business technology platform) | $200,000          | Integration, extension, analytics platform                              |
| SAP Business Network                   | $50,000           | Supply chain collaboration                                              |
| **RISE subtotal**                      | **$3,850,000**    |                                                                         |

### Customer-side costs

| Cost category                         | Annual cost (USD) | Notes                                          |
| ------------------------------------- | ----------------- | ---------------------------------------------- |
| SAP functional consultants (2 FTE)    | $300,000          | Configuration, testing (no Basis needed)       |
| Azure infrastructure for CSA-in-a-Box | $120,000          | Fabric, Power BI, Azure AI alongside RISE      |
| Integration development               | $80,000           | Azure Integration Services for non-SAP systems |
| **Customer subtotal**                 | **$500,000**      |                                                |

### Total RISE with SAP on Azure

|                     | Annual         | 3-year          | 5-year          |
| ------------------- | -------------- | --------------- | --------------- |
| RISE subscription   | $3,850,000     | $11,550,000     | $19,250,000     |
| Customer-side costs | $500,000       | $1,500,000      | $2,500,000      |
| **RISE total**      | **$4,350,000** | **$13,050,000** | **$21,750,000** |

### RISE vs alternatives

| Horizon | On-premises | Azure VMs   | RISE        | RISE vs on-prem  |
| ------- | ----------- | ----------- | ----------- | ---------------- |
| 3-year  | $13,500,000 | $11,705,448 | $13,050,000 | **3.3% savings** |
| 5-year  | $22,500,000 | $19,509,080 | $21,750,000 | **3.3% savings** |

!!! note "RISE value proposition"
RISE savings appear modest in pure cost terms. The value proposition is operational: SAP manages infrastructure, Basis, patching, backups, and upgrades. For organizations that struggle to hire and retain SAP Basis administrators, RISE eliminates the operational burden. The "savings" are measured in reduced operational risk and staff redeployment, not just dollars.

---

## 5. HANA Large Instances (bare-metal)

HANA Large Instances (HLI) are reserved bare-metal servers in Azure-adjacent data centers. They are designed for extreme-scale HANA workloads that exceed the memory capacity of Azure VMs.

### HLI costs (estimated)

| HLI type        | Memory | Monthly cost (3-yr) | Annual cost | Use case            |
| --------------- | ------ | ------------------- | ----------- | ------------------- |
| Type I (S192)   | 2 TB   | $18,000             | $216,000    | Large S/4HANA       |
| Type II (S384)  | 4 TB   | $32,000             | $384,000    | Enterprise BW/4HANA |
| Type III (S576) | 6 TB   | $45,000             | $540,000    | Very large HANA     |
| Type IV (S896)  | 12 TB  | $72,000             | $864,000    | Extreme-scale HANA  |

### Total HLI deployment (reference architecture)

|                                  | Annual         | 3-year          | 5-year          |
| -------------------------------- | -------------- | --------------- | --------------- |
| HLI (PRD S/4 + BW)               | $600,000       | $1,800,000      | $3,000,000      |
| Azure VMs (app servers, non-PRD) | $350,000       | $1,050,000      | $1,750,000      |
| Storage + networking             | $80,000        | $240,000        | $400,000        |
| Administration (3 FTE)           | $450,000       | $1,350,000      | $2,250,000      |
| SAP maintenance                  | $2,500,000     | $7,500,000      | $12,500,000     |
| **HLI total**                    | **$3,980,000** | **$11,940,000** | **$19,900,000** |

---

## 6. CSA-in-a-Box analytics layer (incremental cost)

CSA-in-a-Box adds the data, analytics, governance, and AI capabilities that transform SAP from a transactional system into an insight platform. This cost is incremental to any deployment model.

| Component                           | Annual cost (USD) | Notes                                             |
| ----------------------------------- | ----------------- | ------------------------------------------------- |
| Microsoft Fabric capacity (F64)     | $72,000           | OneLake, Fabric Mirroring, Spark, SQL endpoint    |
| Power BI Premium Per Capacity (P1)  | $60,000           | Or included in Fabric capacity                    |
| Azure AI Foundry (OpenAI)           | $36,000           | Process intelligence on SAP data                  |
| Microsoft Purview                   | $24,000           | SAP metadata scanning, classification, governance |
| Azure Data Factory (SAP connectors) | $18,000           | Batch extraction from SAP                         |
| Databricks (optional, for ML)       | $48,000           | ML workloads on SAP data                          |
| **CSA-in-a-Box subtotal**           | **$258,000**      |                                                   |

### ROI justification for CSA-in-a-Box layer

| Value driver                             | Estimated annual value   | Basis                                         |
| ---------------------------------------- | ------------------------ | --------------------------------------------- |
| Eliminate SAP Analytics Cloud license    | $300,000--$500,000       | SAC licensing for 200+ users                  |
| Reduce SAP BW operational cost           | $150,000--$250,000       | Migrate InfoProviders to Fabric               |
| AI-driven process optimization           | $200,000--$400,000       | Invoice anomaly detection, demand forecasting |
| Unified governance (replace GRC partial) | $100,000--$200,000       | Purview replaces manual compliance processes  |
| **Total estimated value**                | **$750,000--$1,350,000** |                                               |

---

## 7. Cost optimization strategies

| Strategy                        | Savings                | Applicability                                                  |
| ------------------------------- | ---------------------- | -------------------------------------------------------------- |
| **3-year Reserved Instances**   | 40--60% on compute     | All Azure VM deployments; SAP VMs run 24/7                     |
| **Azure Hybrid Benefit**        | 40--50% on Windows/SQL | Organizations with existing Windows Server/SQL Server SA       |
| **Dev/test pricing**            | 40--55%                | SAP sandbox and development systems                            |
| **Snooze non-production**       | 30--40% additional     | Stop SAP DEV/SBX VMs outside business hours                    |
| **Right-size after migration**  | 10--20%                | Monitor HANA memory utilization; downsize over-provisioned VMs |
| **Fabric capacity reservation** | 10--25%                | Reserved Fabric capacity for predictable analytics workloads   |
| **Azure Spot VMs**              | 60--80%                | SAP performance testing, batch processing                      |
| **ANF capacity pooling**        | 10--15%                | Share ANF capacity across SAP and non-SAP workloads            |

---

## 8. Summary comparison

| Deployment model       | 3-year TCO      | 5-year TCO      | vs On-Prem (5-yr)     | Best for                                   |
| ---------------------- | --------------- | --------------- | --------------------- | ------------------------------------------ |
| On-premises            | $13,500,000     | $22,500,000     | Baseline              | Status quo (2027 deadline forces action)   |
| **SAP on Azure VMs**   | **$11,705,448** | **$19,509,080** | **-13.3%**            | Full control, federal, heavy customization |
| RISE with SAP on Azure | $13,050,000     | $21,750,000     | -3.3%                 | Managed infrastructure, new deployments    |
| HANA Large Instances   | $11,940,000     | $19,900,000     | -11.6%                | Extreme-scale HANA (6+ TB)                 |
| + CSA-in-a-Box layer   | +$258,000/yr    | +$1,290,000     | ROI: $750K--$1.35M/yr | Analytics, governance, AI for all models   |

!!! success "Bottom line"
SAP on Azure VMs with 3-year Reserved Instances delivers the strongest cost reduction (13.3% over 5 years) while providing full control. Adding CSA-in-a-Box at $258K/year generates $750K--$1.35M in annual value through analytics consolidation, AI-driven process optimization, and governance automation. The combined migration pays for itself within the first year.

---

## 9. Migration cost (one-time)

Migration itself carries a one-time cost that should be factored into the business case. These costs are incurred during the migration project and are not part of the ongoing operational TCO.

### Migration project costs by approach

| Cost category                                 | Brownfield (system conversion) | Greenfield (new implementation) | RISE with SAP            |
| --------------------------------------------- | ------------------------------ | ------------------------------- | ------------------------ |
| SAP migration tooling (SUM/DMO licenses)      | $50,000--$100,000              | $0 (Activate included)          | Included in RISE         |
| System integrator (SI) services               | $1,500,000--$4,000,000         | $2,000,000--$5,000,000          | $500,000--$1,500,000     |
| Custom code remediation                       | $200,000--$1,000,000           | $0 (no custom code)             | N/A (clean core)         |
| Data migration and validation                 | $100,000--$300,000             | $200,000--$500,000              | $100,000--$200,000       |
| Integration rewiring (PI/PO)                  | $200,000--$800,000             | $200,000--$600,000              | $100,000--$300,000       |
| Testing (functional, performance, regression) | $200,000--$500,000             | $200,000--$400,000              | $100,000--$200,000       |
| Change management and training                | $100,000--$300,000             | $200,000--$500,000              | $100,000--$200,000       |
| Azure infrastructure during migration         | $50,000--$150,000              | $50,000--$100,000               | $0 (SAP manages)         |
| CSA-in-a-Box analytics setup                  | $50,000--$100,000              | $50,000--$100,000               | $50,000--$100,000        |
| **Total migration cost**                      | **$2,450,000--$7,250,000**     | **$2,900,000--$7,200,000**      | **$950,000--$2,500,000** |

### Migration cost amortized over 5 years

| Approach   | Migration cost (mid) | Amortized annual | Impact on 5-yr TCO                  |
| ---------- | -------------------- | ---------------- | ----------------------------------- |
| Brownfield | $4,850,000           | $970,000         | Adds ~5% to annual cost for 5 years |
| Greenfield | $5,050,000           | $1,010,000       | Adds ~5% to annual cost for 5 years |
| RISE       | $1,725,000           | $345,000         | Adds ~2% to annual cost for 5 years |

---

## 10. Hidden costs of staying on-premises

Organizations evaluating SAP migration must also consider the hidden costs of **not** migrating:

| Hidden cost                                    | Annual impact                       | Notes                                                    |
| ---------------------------------------------- | ----------------------------------- | -------------------------------------------------------- |
| Extended maintenance premium (post-2027)       | 2% of license value (~$50,000/yr)   | Escalates annually; no new features                      |
| Hardware refresh cycle (every 5 years)         | $180,000--$400,000/year amortized   | On-prem hardware depreciates; requires periodic refresh  |
| Opportunity cost of IT staff on infrastructure | $200,000--$400,000/year             | Basis/infra admins could work on business value projects |
| Compliance burden (manual controls)            | $100,000--$200,000/year             | Manual audit evidence collection; manual control testing |
| DR facility costs                              | $120,000--$250,000/year             | Secondary data center for SAP DR                         |
| Security patching delays                       | Risk-based (unquantified)           | On-prem patching is slower; exposure window is longer    |
| Talent risk (SAP Basis hiring)                 | $50,000--$100,000/year premium      | Scarce SAP Basis talent commands premium compensation    |
| Energy and cooling costs                       | $50,000--$150,000/year (increasing) | Energy costs trend upward; Azure absorbs this            |

**Total hidden cost of staying on-premises: $750,000--$1,500,000/year** beyond the baseline TCO.

---

## 11. Sensitivity analysis

### Impact of key variables on 5-year TCO

| Variable                         | Low case            | Base case               | High case            | Impact on Azure VM TCO                   |
| -------------------------------- | ------------------- | ----------------------- | -------------------- | ---------------------------------------- |
| Reserved Instance discount       | 40%                 | 55%                     | 63%                  | +/- $500K over 5 years                   |
| Azure Hybrid Benefit adoption    | 0% (no licenses)    | Partial (Windows only)  | Full (Windows + SQL) | +/- $300K over 5 years                   |
| Non-production snooze compliance | 50% (half the time) | 70%                     | 90%                  | +/- $200K over 5 years                   |
| Fabric Mirroring replacing SAC   | No SAC elimination  | Partial SAC replacement | Full SAC elimination | +/- $1.5M over 5 years                   |
| Basis FTE reduction              | 0 FTE saved         | 0.5 FTE saved           | 1.0 FTE saved        | +/- $375K over 5 years                   |
| HANA memory growth               | 0% annual           | 10% annual              | 20% annual           | +/- $400K over 5 years (VM right-sizing) |

---

**Last updated:** 2026-04-30
**Maintainers:** CSA-in-a-Box core team
**Related:** [Why Azure for SAP](why-azure-for-sap.md) | [Infrastructure Migration](infrastructure-migration.md) | [Benchmarks](benchmarks.md)
