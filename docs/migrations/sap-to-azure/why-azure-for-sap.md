# Why Azure for SAP

**An executive brief for CIOs, CDOs, and enterprise architects evaluating Azure as the cloud platform for SAP workloads.**

---

## Executive summary

SAP is the transactional backbone of global enterprise. 98 of the Fortune 100 run SAP. SAP SE generates EUR 36.8 billion in annual revenue from a customer base of 437,000 organizations in 180 countries. SAP ECC (Enterprise Central Component) manages the finance, supply chain, manufacturing, HR, and procurement processes that keep these organizations running. The 2027 end-of-mainstream-maintenance deadline for ECC 6.0 and Business Suite 7 is the largest enterprise software migration event in history.

Microsoft Azure is SAP's preferred cloud platform. This is not marketing language --- it is a structural relationship formalized through a 30-year partnership, co-engineered infrastructure, joint go-to-market investment, and the deepest integration of any hyperscaler with SAP's product roadmap. This document presents six strategic advantages of running SAP on Azure, an honest assessment of considerations, and a decision framework for enterprise and federal organizations.

!!! warning "The 2027 Clock Is Running"
SAP will end mainstream maintenance for SAP ECC 6.0 (EHP 8) and SAP Business Suite 7 on **December 31, 2027**. Extended maintenance through 2030 carries a 2% annual premium surcharge and delivers no new functionality, no regulatory updates beyond critical, and limited security patching. Every month of delay compresses the migration window and increases organizational risk.

---

## 1. The Microsoft-SAP strategic partnership

Microsoft and SAP have the deepest partnership of any cloud-ERP combination. This partnership is structural, not tactical --- it spans three decades and has been continuously expanded.

### Partnership timeline

| Year | Milestone                                                                            |
| ---- | ------------------------------------------------------------------------------------ |
| 1993 | SAP R/3 first certified on Windows NT                                                |
| 2010 | SAP HANA certified on Windows Server / SQL Server                                    |
| 2017 | **Embrace partnership** announced: joint engineering, joint sales, shared roadmap    |
| 2019 | RISE with SAP on Azure announced; Azure becomes SAP's preferred cloud                |
| 2020 | Azure Center for SAP Solutions enters preview                                        |
| 2021 | SAP HANA Large Instances (HLI) Type II/III/IV on Azure GA                            |
| 2022 | Fabric Mirroring for SAP announced at Microsoft Ignite                               |
| 2023 | Microsoft Copilot integration with SAP announced; Azure Center for SAP Solutions GA  |
| 2024 | Joule (SAP AI) + Copilot bi-directional integration; RISE with SAP on Azure expanded |
| 2025 | Fabric Mirroring for SAP HANA GA; Copilot for SAP Fiori scenarios                    |
| 2026 | Azure Center for SAP Solutions enhancements; expanded Gov region support             |

### What the partnership means in practice

- **Co-engineered VM certification** --- SAP and Microsoft jointly certify Azure VM families (M-series, Mv2, E-series) for HANA and NetWeaver workloads. No other hyperscaler has this level of co-engineering.
- **Azure Center for SAP Solutions** --- A first-party Azure service for deploying, managing, and monitoring SAP workloads. Not available on AWS or GCP.
- **RISE with SAP on Azure** --- SAP's managed cloud offering runs on Azure infrastructure. SAP chose Azure as the preferred platform for RISE deployments.
- **Copilot + Joule integration** --- Bi-directional AI assistant integration between Microsoft 365 Copilot and SAP Joule. Users access SAP data and processes through the Microsoft 365 surface they already use daily.
- **Fabric Mirroring for SAP** --- Near-real-time replication of SAP HANA data to Microsoft Fabric OneLake. No ETL development. SAP data appears as Delta tables in the same lakehouse as all other organizational data.

---

## 2. Certified Azure infrastructure for SAP

Azure provides the broadest range of SAP-certified virtual machine families of any hyperscaler. SAP certification means that SAP has validated the VM configuration (CPU, memory, storage throughput, network bandwidth) against SAP Standard Application Benchmarks (SAPS) and certified it for production HANA workloads.

### SAP-certified Azure VM families

| VM family                 | vCPUs  | Memory (GiB) | SAPS (approx.) | Certified for              | Use case                                |
| ------------------------- | ------ | ------------ | -------------- | -------------------------- | --------------------------------------- |
| **Mv2** (208 vCPU)        | 208    | 5,700        | 475,000        | HANA OLAP + OLTP, scale-up | Large S/4HANA, BW/4HANA                 |
| **Mv2** (416 vCPU)        | 416    | 11,400       | 850,000        | HANA OLAP, scale-up        | Enterprise BW/4HANA, very large S/4HANA |
| **M-series** (128 vCPU)   | 128    | 3,892        | 350,000        | HANA OLAP + OLTP           | Mid-size S/4HANA, BW/4HANA              |
| **M-series** (64 vCPU)    | 64     | 2,048        | 175,000        | HANA OLTP                  | S/4HANA production (typical enterprise) |
| **E-series v5** (96 vCPU) | 96     | 672          | 120,000+       | NetWeaver, non-HANA        | SAP application servers, Java stack     |
| **D-series v5** (96 vCPU) | 96     | 384          | 80,000+        | NetWeaver                  | SAP web dispatcher, CI instances        |
| **HANA Large Instances**  | Custom | Up to 24 TB  | 1,000,000+     | HANA scale-up, bare-metal  | Extreme-scale HANA workloads            |

### Storage certification

| Storage type             | IOPS     | Throughput | Certified for                           | Notes                                    |
| ------------------------ | -------- | ---------- | --------------------------------------- | ---------------------------------------- |
| Azure NetApp Files (ANF) | 450,000+ | 4,500 MBps | HANA data + log volumes                 | Recommended for production HANA          |
| Ultra Disk               | 160,000  | 4,000 MBps | HANA data + log volumes                 | Alternative to ANF                       |
| Premium SSD v2           | 80,000   | 1,200 MBps | HANA data, application servers          | Cost-effective for non-extreme workloads |
| Premium SSD              | 20,000   | 900 MBps   | SAP application servers, shared volumes | Standard for app tier                    |

---

## 3. Azure Center for SAP Solutions

Azure Center for SAP Solutions (ACSS) is a first-party Azure service --- not a marketplace offering, not a partner tool --- built by Microsoft specifically for SAP workloads. No equivalent exists on AWS or GCP.

### What ACSS provides

| Capability                 | Description                                                                                                                   |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **Automated deployment**   | Deploy SAP HANA, S/4HANA, NetWeaver with Azure Resource Manager templates; includes VNet, NSG, VM, disk, and OS configuration |
| **Quality checks**         | Pre-deployment validation against SAP and Azure best practices (VM sizing, storage layout, networking, HA configuration)      |
| **Monitoring integration** | Azure Monitor for SAP Solutions: HANA metrics (memory, CPU, disk), NetWeaver metrics (enqueue, dispatcher, batch), OS metrics |
| **Health monitoring**      | Continuous health assessment with alerts for SAP-specific issues (HANA memory allocation, lock escalation, backup failures)   |
| **Cost management**        | SAP workload cost visibility integrated with Azure Cost Management                                                            |
| **Move to Azure**          | Guided migration workflow from on-premises to Azure (assessment, infrastructure provisioning, migration execution)            |

### ACSS deployment example

```bash
# Register SAP system with Azure Center for SAP Solutions
az workloads sap-virtual-instance create \
  --resource-group rg-sap-prod \
  --name S4H-PRD \
  --environment Production \
  --sap-product S4HANA \
  --configuration '{
    "configurationType": "DeploymentWithOSConfig",
    "appLocation": "eastus2",
    "infrastructureConfiguration": {
      "appResourceGroup": "rg-sap-prod-app",
      "deploymentType": "ThreeTier",
      "centralServer": {
        "subnetId": "/subscriptions/.../subnets/sap-app",
        "virtualMachineConfiguration": {
          "vmSize": "Standard_E32ds_v5",
          "imageReference": {
            "publisher": "SUSE",
            "offer": "sles-sap-15-sp5",
            "sku": "gen2",
            "version": "latest"
          }
        }
      },
      "databaseServer": {
        "subnetId": "/subscriptions/.../subnets/sap-db",
        "databaseType": "HANA",
        "virtualMachineConfiguration": {
          "vmSize": "Standard_M128s",
          "imageReference": {
            "publisher": "SUSE",
            "offer": "sles-sap-15-sp5",
            "sku": "gen2",
            "version": "latest"
          }
        }
      }
    }
  }'
```

---

## 4. RISE with SAP on Azure

RISE with SAP is SAP's subscription-based offering that bundles S/4HANA Cloud (Private Edition), SAP Business Technology Platform (BTP), SAP Business Network, and managed infrastructure. Azure is the preferred infrastructure provider for RISE deployments.

### What RISE on Azure means

- **SAP manages the infrastructure** --- VMs, HANA database, OS patching, Basis operations, backup, and HA/DR
- **Customer focuses on business** --- Configuration, extensions, integrations, and business process optimization
- **Azure infrastructure underneath** --- RISE VMs run on Azure, in Azure regions, with Azure networking
- **CSA-in-a-Box integrates alongside** --- Deploy CSA-in-a-Box in an adjacent subscription for analytics, governance, and AI on SAP data

### RISE vs self-managed comparison

| Dimension                       | RISE with SAP on Azure           | Self-managed SAP on Azure VMs        |
| ------------------------------- | -------------------------------- | ------------------------------------ |
| Infrastructure management       | SAP                              | Customer                             |
| HANA administration             | SAP                              | Customer                             |
| OS patching                     | SAP                              | Customer                             |
| Backup management               | SAP                              | Customer                             |
| HA/DR configuration             | SAP                              | Customer                             |
| S/4HANA upgrades                | SAP (scheduled)                  | Customer (self-scheduled)            |
| Custom ABAP development         | Limited (clean core)             | Unlimited                            |
| SAP kernel modifications        | Not allowed                      | Allowed                              |
| Third-party add-on support      | SAP approval required            | Customer decision                    |
| Pricing model                   | Per-user subscription            | VM-based (pay-as-you-go or reserved) |
| Contract term                   | 3--5 year commitment             | Month-to-month or reserved           |
| Total cost (typical enterprise) | Higher per-user, lower admin FTE | Lower compute cost, higher admin FTE |

---

## 5. Copilot for SAP

The Microsoft-SAP AI integration is a differentiator that no other hyperscaler offers. Copilot and SAP Joule provide bi-directional AI assistance across Microsoft 365 and SAP applications.

### Integration scenarios

| Scenario                      | How it works                                                                                                                       |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **Purchase order processing** | User in Microsoft Teams asks Copilot to check SAP purchase order status; Copilot retrieves data from S/4HANA via SAP BTP connector |
| **Leave request approval**    | Manager in Outlook receives SAP SuccessFactors leave request; Copilot summarizes team availability from SAP HR data                |
| **Invoice processing**        | Accounts payable scans invoice in Microsoft 365; Copilot matches to SAP purchase order, flags discrepancies, routes for approval   |
| **Supply chain alerts**       | SAP Integrated Business Planning detects demand spike; Joule pushes alert to Microsoft Teams with recommended actions              |
| **Financial reporting**       | CFO asks Copilot in Excel for quarterly revenue by business unit; Copilot queries SAP S/4HANA financial data via Fabric Mirroring  |

---

## 6. Fabric Mirroring for SAP

Fabric Mirroring is the integration pattern that makes CSA-in-a-Box transformative for SAP customers. It provides near-real-time replication of SAP HANA data into Microsoft Fabric OneLake without ETL development.

### How Fabric Mirroring works

1. **Connect** --- Configure a mirrored database in Microsoft Fabric pointing to SAP HANA
2. **Replicate** --- Initial full snapshot of selected SAP HANA tables to OneLake as Delta tables
3. **Sync** --- Change data capture (CDC) continuously replicates inserts, updates, and deletes from SAP HANA to OneLake
4. **Consume** --- SAP data is immediately available in Fabric for Power BI, Spark notebooks, SQL analytics, and AI workloads

### What this enables

| Before (on-premises SAP)                                    | After (SAP on Azure + Fabric Mirroring)                                   |
| ----------------------------------------------------------- | ------------------------------------------------------------------------- |
| SAP BW extracts run overnight; reports are 24 hours stale   | SAP data in OneLake within minutes; near-real-time dashboards             |
| SAP Analytics Cloud requires separate licensing             | Power BI Premium included in Microsoft 365 E5; Direct Lake on OneLake     |
| SAP data is siloed from non-SAP data                        | SAP data in the same OneLake as Azure SQL, Cosmos DB, and file-based data |
| AI on SAP data requires custom extraction and ML pipeline   | Azure OpenAI queries Delta tables directly; prompt-based analytics        |
| Cross-system reporting requires SAP BW or third-party tools | Power BI semantic models span SAP and non-SAP data natively               |

---

## 7. Honest assessment --- where to be careful

This document is a case for Azure, but it would be dishonest not to acknowledge areas where organizations should plan carefully:

| Consideration                         | Details                                                                                                                                                                     |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **HANA Large Instance availability**  | HLI is available in specific Azure regions; check regional availability for your deployment geography                                                                       |
| **Fabric Mirroring maturity**         | Fabric Mirroring for SAP HANA is GA but feature coverage continues to expand; validate your specific table/schema requirements in a proof-of-concept                        |
| **RISE with SAP on Azure Government** | RISE availability in Azure Government regions is limited; verify with SAP for federal deployments                                                                           |
| **Custom ABAP on RISE**               | RISE with SAP enforces a clean-core model; organizations with heavy custom ABAP may find self-managed VMs more appropriate                                                  |
| **SAP BW migration complexity**       | Large BW systems (10+ TB, 500+ InfoProviders) are complex multi-year migrations regardless of target platform                                                               |
| **Licensing complexity**              | SAP licensing (named users, digital access, indirect use) interacts with Azure licensing (BYOL, PAYG, Hybrid Benefit); engage SAP and Microsoft licensing specialists early |

---

## 8. Decision framework

### Choose RISE with SAP on Azure when

- You want SAP to manage infrastructure, Basis, and upgrades
- You are deploying a new S/4HANA instance (greenfield)
- Your customization footprint is moderate and compatible with clean core
- You want subscription-based pricing aligned with cloud economics
- You are willing to accept SAP's upgrade schedule and release cadence

### Choose SAP on Azure VMs (self-managed) when

- You need full control over infrastructure, HANA, and kernel
- You have heavy custom ABAP or third-party add-ons
- You are performing a brownfield system conversion from ECC
- You need Azure Government deployment for federal workloads
- You want to optimize costs with Reserved Instances and Hybrid Benefit

### Choose HANA Large Instances when

- Your HANA database exceeds 12 TB in production
- You require bare-metal performance for extreme-scale BW/4HANA
- Your workload demands memory bandwidth that VM-based solutions cannot deliver

### In all cases, deploy CSA-in-a-Box alongside

- **Fabric Mirroring** for near-real-time SAP data in OneLake
- **Purview** for unified governance across SAP and non-SAP data
- **Power BI** for SAP analytics replacing SAP Analytics Cloud
- **Azure AI** for process intelligence on SAP operational data
- **dbt** for SAP data transformation through the medallion architecture

---

## 9. Next steps

1. **Run SAP Readiness Check** on your current ECC system
2. **Estimate TCO** using the [Total Cost of Ownership Analysis](tco-analysis.md)
3. **Deploy a proof-of-concept** using [Tutorial: Deploy SAP S/4HANA on Azure](tutorial-sap-azure-deployment.md)
4. **Configure Fabric Mirroring** using [Tutorial: SAP Data to Fabric](tutorial-sap-data-to-fabric.md)
5. **Engage Microsoft FastTrack for SAP** for a migration assessment
6. **Review the full Migration Center** at [SAP to Azure Migration Center](index.md)

---

## 10. Microsoft-SAP ecosystem: partners, certifications, and resources

### Certified SAP on Azure partners

Microsoft maintains a curated ecosystem of partners with deep SAP on Azure expertise. These partners hold the SAP on Microsoft Azure Advanced Specialization and have demonstrated successful SAP migrations.

| Partner category           | Examples                                                                | Service scope                                                   |
| -------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------- |
| Global Systems Integrators | Accenture, Deloitte, EY, KPMG, PwC, IBM, Capgemini, Infosys, Wipro, TCS | End-to-end SAP migration, system integration, change management |
| SAP-focused specialists    | SNP, Syntax, Applexus, Scheer, Atos                                     | SAP migration tooling, Basis operations, managed services       |
| Azure-focused MSPs         | Rackspace, Ensono, HCLTech                                              | Azure infrastructure managed services for SAP                   |
| Federal specialists        | Leidos, Booz Allen Hamilton, SAIC, ManTech                              | DoD and civilian SAP migration with security clearance          |

### Certification and training paths

| Certification                                                        | Audience                    | Description                                     |
| -------------------------------------------------------------------- | --------------------------- | ----------------------------------------------- |
| AZ-120: Planning and Administering Microsoft Azure for SAP Workloads | SAP Basis, cloud architects | Azure-specific SAP deployment, sizing, HA/DR    |
| AZ-104: Azure Administrator                                          | Infrastructure team         | Azure compute, networking, storage fundamentals |
| AZ-305: Azure Solutions Architect Expert                             | Enterprise architects       | Azure architecture design patterns              |
| DP-600: Microsoft Fabric Analytics Engineer                          | Data engineers, analysts    | Fabric, OneLake, Power BI, data engineering     |
| AI-102: Azure AI Engineer                                            | AI developers               | Azure AI services, OpenAI integration           |
| SAP Certified Technology Associate: SAP HANA 2.0                     | SAP Basis                   | HANA administration on any platform             |

### Key Microsoft resources

| Resource                             | URL                                          | Description                                       |
| ------------------------------------ | -------------------------------------------- | ------------------------------------------------- |
| Azure Center for SAP Solutions docs  | learn.microsoft.com/azure/sap                | Official ACSS documentation                       |
| SAP on Azure blog                    | techcommunity.microsoft.com/sap-on-microsoft | Latest announcements and best practices           |
| SAP on Azure reference architectures | learn.microsoft.com/azure/architecture/sap   | Validated architecture patterns                   |
| SAP Note 1928533                     | launchpad.support.sap.com                    | Supported SAP products and Azure VM types         |
| SAP Note 2015553                     | launchpad.support.sap.com                    | SAP support prerequisites for Azure               |
| SAP Note 2205917                     | launchpad.support.sap.com                    | Recommended OS settings for SUSE on Azure         |
| SAP Note 1999351                     | launchpad.support.sap.com                    | Enhanced monitoring for SAP on Azure              |
| Microsoft FastTrack for SAP          | microsoft.com/fasttrack                      | Free migration assessment and planning assistance |

### SAP and Microsoft joint innovation roadmap

| Innovation area                | 2025--2026 focus                                             | Impact for customers                                    |
| ------------------------------ | ------------------------------------------------------------ | ------------------------------------------------------- |
| Copilot + Joule                | Bi-directional AI assistant integration                      | SAP data accessible from Microsoft 365 Copilot          |
| Fabric Mirroring               | GA for SAP HANA, expanded table support                      | Near-real-time SAP data in OneLake without ETL          |
| Azure Center for SAP Solutions | Enhanced deployment, monitoring, migration tooling           | Simplified SAP lifecycle management                     |
| Clean core + extensibility     | SAP BTP + Azure services for side-by-side extensions         | Modern extensions without modifying SAP core            |
| Sustainability                 | Microsoft Sustainability Manager + SAP sustainability        | Unified carbon footprint reporting across SAP and Azure |
| Industry clouds                | Joint industry solutions (manufacturing, retail, healthcare) | Pre-built industry accelerators on SAP + Azure          |

---

**Last updated:** 2026-04-30
**Maintainers:** CSA-in-a-Box core team
**Related:** [SAP to Azure Migration Center](index.md) | [Migration Playbook](../sap-to-azure.md) | [TCO Analysis](tco-analysis.md)
