# Migration -- VMware / vSphere to Azure (AVS + Azure Migrate)

**Status:** Authored 2026-04-30
**Audience:** Federal CIO / CTO / Infrastructure Architects and their platform engineering teams
**Scope:** Full migration from on-premises VMware/vSphere environments to Azure VMware Solution (AVS) and Azure IaaS, with CSA-in-a-Box as the data and analytics landing zone.

---

!!! tip "Expanded Migration Center Available"
This playbook is the core migration reference. For the complete VMware-to-Azure migration package -- including architecture deep-dives, networking guides, tutorials, benchmarks, and federal-specific guidance -- visit the **[VMware to Azure Migration Center](vmware-to-azure/index.md)**.

    **Quick links:**

    - [Why Azure over VMware (Executive Brief)](vmware-to-azure/why-azure-over-vmware.md)
    - [Total Cost of Ownership Analysis](vmware-to-azure/tco-analysis.md)
    - [Complete Feature Mapping (50+ features)](vmware-to-azure/feature-mapping-complete.md)
    - [Federal Migration Guide](vmware-to-azure/federal-migration-guide.md)
    - [Tutorials & Walkthroughs](vmware-to-azure/index.md#tutorials)
    - [Benchmarks & Performance](vmware-to-azure/benchmarks.md)
    - [Best Practices](vmware-to-azure/best-practices.md)

    **Migration guides by domain:** [AVS Migration](vmware-to-azure/avs-migration.md) | [Azure IaaS Migration](vmware-to-azure/azure-iaas-migration.md) | [Networking](vmware-to-azure/networking-migration.md) | [Storage](vmware-to-azure/storage-migration.md) | [Security](vmware-to-azure/security-migration.md) | [Disaster Recovery](vmware-to-azure/dr-migration.md)

---

## 1. Executive summary

Broadcom's $69 billion acquisition of VMware has fundamentally altered the economics of virtualization. Perpetual licenses have been eliminated. Subscription-only pricing with mandatory bundling has resulted in documented price increases of 2x to 12x for existing customers. Product consolidation from 80+ individual SKUs to 4 bundles (VMware Cloud Foundation, vSphere Foundation, vSphere Standard, vSphere Essentials Plus) means most customers are paying for capabilities they do not use.

For organizations running VMware workloads -- and especially for federal agencies and DoD components with large vSphere estates -- this is a forcing function. The three migration paths are:

1. **Azure VMware Solution (AVS)**: Lift-and-shift VMware workloads to Azure-hosted vSphere clusters with zero application changes. HCX Enterprise is included free. Same VMware tools, Azure billing.
2. **Azure IaaS Re-Platform**: Convert VMware VMs to Azure-native IaaS VMs using Azure Migrate. Eliminate the VMware dependency entirely.
3. **Hybrid / Phased**: Migrate critical workloads to AVS for immediate license relief, then selectively re-platform to Azure IaaS over time.

CSA-in-a-Box serves as the **data and analytics landing zone** for migrated workloads. Database VMs, data warehouses, reporting servers, and ETL engines running on VMware become Fabric Lakehouses, Databricks notebooks, ADF pipelines, and Power BI semantic models on Azure. The infrastructure migration (this playbook) and the data platform modernization (CSA-in-a-Box) are complementary workstreams.

---

## 2. Decide first: migration path

| Your situation                                     | Recommended path            | Why                                                                   |
| -------------------------------------------------- | --------------------------- | --------------------------------------------------------------------- |
| Large VMware estate, need immediate license relief | **AVS**                     | Zero app changes, same VMware tooling, HCX Enterprise free            |
| Want to eliminate VMware entirely                  | **Azure IaaS re-platform**  | Azure Migrate converts VMs to native Azure VMs                        |
| Mixed workloads, some must stay VMware-compatible  | **AVS + Azure IaaS hybrid** | AVS for VMware-dependent apps, Azure IaaS for everything else         |
| Running VMware-based databases and analytics       | **AVS/IaaS + CSA-in-a-Box** | Migrate VMs first, then modernize data workloads to Fabric/Databricks |
| Federal/DoD with compliance requirements           | **AVS in Azure Government** | IL2--IL5 coverage, FedRAMP inheritance                                |
| Running Tanzu/Kubernetes on VMware                 | **AKS re-platform**         | Azure Kubernetes Service replaces Tanzu                               |

---

## 3. Phase 1 -- Discovery and assessment (weeks 1--4)

### Inventory your VMware estate

For each vCenter:

- **Hosts**: count, CPU cores, memory, utilization
- **VMs**: count, OS distribution, resource allocation, actual utilization
- **Storage**: vSAN clusters, datastores, capacity used, IOPS profiles
- **Networking**: NSX segments, distributed switches, firewall rules, load balancers
- **Dependencies**: application dependency mapping (which VMs talk to which)
- **Licensing**: current VMware licenses (vSphere, vCenter, NSX, vSAN, SRM), contract expiration dates, annual costs

### Tools that help

- **Azure Migrate**: deploy the appliance in your VMware environment for agentless discovery and assessment
- **RVTools**: quick vSphere inventory export (free)
- **VMware Aria Operations** (if licensed): utilization data, right-sizing recommendations
- **Application Dependency Mapping**: Azure Migrate dependency analysis (agentless or agent-based)

### Migration tier per workload

| Tier                      | Description                                          | Action                                                     |
| ------------------------- | ---------------------------------------------------- | ---------------------------------------------------------- |
| **A** AVS lift-and-shift  | VMware-dependent apps, licensed per-VM               | Migrate via HCX to AVS                                     |
| **B** Re-platform to IaaS | Standard Windows/Linux VMs with no VMware dependency | Convert to Azure VMs via Azure Migrate                     |
| **C** Modernize           | Database VMs, ETL servers, reporting VMs             | Migrate to PaaS (Fabric, Databricks, ADF) via CSA-in-a-Box |
| **D** Decommission        | VMs with no active consumers                         | Archive and delete                                         |

Plan for **15--30% of VMs to be Tier D** -- most VMware estates carry zombie VMs.

---

## 4. Phase 2 -- Landing zone deployment (weeks 3--6)

### AVS private cloud

```bash
# Create AVS private cloud (3-node minimum)
az vmware private-cloud create \
  --name avs-prod-eastus2 \
  --resource-group rg-avs-prod \
  --location eastus2 \
  --sku AV36P \
  --cluster-size 3 \
  --network-block 10.175.0.0/22 \
  --internet enabled
```

### Azure IaaS landing zone

Deploy hub-spoke networking, Azure Firewall, and shared services using CSA-in-a-Box Bicep modules:

```bash
# Deploy CSA-in-a-Box foundation (networking, governance, monitoring)
az deployment sub create \
  --location eastus2 \
  --template-file infra/main.bicep \
  --parameters infra/parameters/prod.bicepparam
```

### CSA-in-a-Box data platform

For Tier C workloads (database VMs, analytics servers), deploy the data landing zone:

- Fabric workspace with capacity reservation
- Databricks workspace with Unity Catalog
- Azure Data Factory for orchestration
- Purview for governance and lineage
- Power BI for reporting

---

## 5. Phase 3 -- Migration execution (weeks 5--20)

### AVS migration via HCX

1. Deploy HCX Manager in AVS private cloud (automated)
2. Create site pairing between on-prem vCenter and AVS vCenter
3. Configure network profiles, compute profiles, and service mesh
4. Choose migration method per VM:
    - **HCX vMotion**: live migration, zero downtime, one VM at a time
    - **HCX Bulk Migration**: parallel migration of many VMs, brief reboot
    - **HCX Replication Assisted vMotion (RAV)**: combines bulk parallelism with vMotion zero-downtime cutover
    - **Cold Migration**: powered-off VMs, fastest for large batches

### Azure Migrate re-platform

1. Deploy Azure Migrate appliance in VMware environment
2. Run discovery (agentless) to inventory all VMs
3. Run assessment to get Azure VM sizing recommendations and cost estimates
4. Enable replication for target VMs (agentless or agent-based)
5. Run test migration to validate
6. Perform cutover during maintenance window

### Data workload modernization (CSA-in-a-Box)

For Tier C workloads, migrate data rather than VMs:

| VMware workload                  | CSA-in-a-Box target           | Migration approach                        |
| -------------------------------- | ----------------------------- | ----------------------------------------- |
| SQL Server VM                    | Azure SQL / Fabric Warehouse  | Azure Database Migration Service          |
| Oracle VM                        | Databricks / Fabric Lakehouse | Data export + ADF ingestion               |
| ETL server (SSIS, Informatica)   | Azure Data Factory + dbt      | Pipeline-by-pipeline migration            |
| Reporting server (SSRS, Tableau) | Power BI + Direct Lake        | Report-by-report conversion               |
| Hadoop cluster VMs               | Databricks + ADLS Gen2        | HDFS data migration + notebook conversion |
| MongoDB / NoSQL VM               | Cosmos DB                     | Azure Database Migration Service          |

---

## 6. Phase 4 -- Validation and cutover (weeks 18--24)

### Validation checklist

- [ ] All Tier A VMs running on AVS with application health confirmed
- [ ] All Tier B VMs running on Azure IaaS with load testing passed
- [ ] All Tier C data workloads migrated to Fabric/Databricks with reconciliation < 0.5% variance
- [ ] Networking: DNS, firewall rules, load balancer configurations validated
- [ ] Security: NSG rules, Defender for Cloud enabled, Sentinel monitoring active
- [ ] DR: Azure Site Recovery configured for critical workloads
- [ ] Monitoring: Azure Monitor dashboards showing all migrated workloads
- [ ] Compliance: Azure Policy assignments aligned with organizational standards

### Cutover sequence

1. **Parallel run** (weeks 18--22): both environments active, production traffic on Azure
2. **DNS cutover**: update DNS records to point to Azure endpoints
3. **On-prem drain**: verify zero traffic to on-prem VMware
4. **Decommission**: power off on-prem ESXi hosts after 30-day soak period

---

## 7. Phase 5 -- Optimization (weeks 24--36)

### Right-size Azure resources

- Review Azure Advisor recommendations for VM right-sizing
- Implement auto-scaling for variable workloads
- Convert to Reserved Instances or Savings Plans for steady-state workloads
- Optimize AVS cluster sizing (scale in/out nodes based on utilization)

### CSA-in-a-Box data platform optimization

- Optimize Fabric capacity (F-SKU) based on actual workload patterns
- Enable Direct Lake for zero-copy Power BI analytics
- Configure Purview automated scanning for data governance
- Deploy dbt contracts for data quality enforcement

---

## 8. Cost comparison summary

For a typical mid-sized enterprise VMware estate (200 ESXi hosts, 3,000 VMs):

| Cost category          | On-prem VMware (post-Broadcom)   | AVS                           | Azure IaaS re-platform        |
| ---------------------- | -------------------------------- | ----------------------------- | ----------------------------- |
| **Licensing**          | $3.5M--$8M/yr (VCF subscription) | Included in AVS               | N/A (Azure VM pricing)        |
| **Hardware/hosting**   | $2M--$4M/yr (DC costs)           | Included in AVS               | Included in VM pricing        |
| **AVS/compute**        | N/A                              | $2.5M--$5M/yr                 | $1.5M--$3.5M/yr               |
| **Networking**         | $300K--$600K/yr                  | ExpressRoute: $200K--$400K/yr | ExpressRoute: $200K--$400K/yr |
| **Operations (FTE)**   | 8--12 FTEs ($1.2M--$2M/yr)       | 4--6 FTEs ($600K--$1M/yr)     | 4--6 FTEs ($600K--$1M/yr)     |
| **VMware admin tools** | $200K--$500K/yr (Aria, SRM)      | Included in AVS               | N/A                           |
| **3-year total**       | $21M--$45M                       | $10M--$19M                    | $7M--$15M                     |

!!! note "Cost model is illustrative"
Actual costs depend on VM density, storage volumes, network egress, reserved instance commitments, and Azure Government pricing (which carries a ~25% premium over commercial). Use the [detailed TCO analysis](vmware-to-azure/tco-analysis.md) for a rigorous comparison.

---

## 9. Federal considerations

- **Azure Government**: AVS is available in US Gov Arizona, US Gov Virginia, US Gov Texas, DoD Central, and DoD East
- **IL2--IL5**: AVS in Azure Government supports IL2 through IL5 workloads
- **FedRAMP**: AVS inherits Azure Government's FedRAMP High authorization
- **Broadcom impact on federal**: DoD and IC VMware estates face the same Broadcom pricing changes; enterprise agreements with Broadcom are being renegotiated across the federal landscape
- **ExpressRoute in Gov**: dedicated circuits available through approved providers

For detailed federal guidance, see the [Federal Migration Guide](vmware-to-azure/federal-migration-guide.md).

---

## 10. How CSA-in-a-Box fits

The VMware-to-Azure migration is an infrastructure migration. CSA-in-a-Box is a data platform. They are complementary:

1. **Infrastructure migration** (this playbook): moves VMs from on-prem VMware to AVS or Azure IaaS
2. **Data platform modernization** (CSA-in-a-Box): transforms database VMs, ETL servers, and reporting infrastructure into cloud-native Fabric Lakehouses, Databricks notebooks, ADF pipelines, and Power BI semantic models

The sequence is typically:

- **Week 1**: deploy CSA-in-a-Box landing zone alongside AVS/IaaS landing zone
- **Weeks 2--12**: migrate infrastructure (VMs) via AVS/Azure Migrate
- **Weeks 8--24**: modernize data workloads from VM-based to PaaS via CSA-in-a-Box
- **Weeks 20--36**: optimize, right-size, and decommission remaining VM-based data infrastructure

CSA-in-a-Box provides:

- **Microsoft Fabric** for unified data analytics (replaces SQL Server VMs, SSIS VMs, SSRS VMs)
- **Databricks** for advanced analytics and ML (replaces Hadoop/Spark cluster VMs)
- **Azure Data Factory** for orchestration (replaces ETL server VMs)
- **Purview** for governance and lineage (replaces manual data catalogs)
- **Power BI** for reporting and dashboards (replaces Tableau/SSRS server VMs)
- **Azure OpenAI + AI Foundry** for AI workloads (replaces ML server VMs)

---

## 11. Related resources

- **Migration index:** [docs/migrations/README.md](README.md)
- **VMware Migration Center:** [vmware-to-azure/index.md](vmware-to-azure/index.md)
- **AVS Documentation:** [Microsoft Learn - Azure VMware Solution](https://learn.microsoft.com/azure/azure-vmware/)
- **Azure Migrate Documentation:** [Microsoft Learn - Azure Migrate](https://learn.microsoft.com/azure/migrate/)
- **CSA-in-a-Box Architecture:** [docs/ARCHITECTURE.md](../ARCHITECTURE.md)
- **Government Service Matrix:** [docs/GOV_SERVICE_MATRIX.md](../GOV_SERVICE_MATRIX.md)
- **Cost Management:** [docs/COST_MANAGEMENT.md](../COST_MANAGEMENT.md)

---

**Maintainers:** CSA-in-a-Box core team
**Last updated:** 2026-04-30
