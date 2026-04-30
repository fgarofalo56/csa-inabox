# Azure IaaS Migration Guide -- Re-Platform VMware VMs

**Complete guide to migrating VMware VMs to Azure-native IaaS virtual machines using Azure Migrate, eliminating the VMware dependency entirely.**

---

## When to choose re-platform over AVS

Re-platforming converts VMware VMs into Azure-native VMs. This eliminates the VMware layer, VMware licensing, and VMware operational overhead. Choose re-platform when:

| Scenario                          | Why re-platform wins                                                     |
| --------------------------------- | ------------------------------------------------------------------------ |
| Standard Windows/Linux workloads  | No VMware-specific dependencies, lower cost than AVS                     |
| Eliminating all VMware licensing  | AVS includes VMware licensing in its price; IaaS eliminates it           |
| Auto-scaling required             | Azure VM Scale Sets provide native auto-scaling; AVS does not            |
| Azure-native services integration | Direct integration with Azure PaaS without VMware overlay                |
| Cost optimization priority        | Azure IaaS with Reserved Instances is typically 40--60% cheaper than AVS |
| Small VM footprint (< 50 VMs)     | AVS minimum is 3 hosts (~$18K/month); IaaS scales to individual VMs      |

### When to choose AVS instead

- VMs depend on VMware-specific features (vSphere APIs, NSX rules, vSAN policies)
- ISV applications certified only on VMware
- Zero application changes required (true lift-and-shift)
- Need to migrate fast with minimal re-engineering

---

## Azure Migrate overview

Azure Migrate is Microsoft's free migration platform for discovering, assessing, and migrating VMware workloads to Azure. It provides:

- **Discovery**: agentless VMware discovery via a lightweight appliance
- **Assessment**: right-sizing recommendations, cost estimates, readiness analysis
- **Replication**: continuous replication of VMware VMs to Azure managed disks
- **Test migration**: non-disruptive migration testing before cutover
- **Cutover**: final migration with configurable downtime window

### Azure Migrate components

| Component                   | Purpose                             | Deployment                         |
| --------------------------- | ----------------------------------- | ---------------------------------- |
| **Azure Migrate project**   | Central hub in Azure Portal         | Azure resource                     |
| **Azure Migrate appliance** | Discovery and assessment agent      | OVA deployed in VMware environment |
| **Replication appliance**   | Agent-based replication (if needed) | OVA deployed in VMware environment |
| **Dependency analysis**     | Application dependency mapping      | Agent-based or agentless           |

---

## Phase 1 -- Discovery

### Deploy the Azure Migrate appliance

The Azure Migrate appliance is a lightweight OVA (Open Virtual Appliance) deployed in your VMware environment. It discovers VMs, collects performance data, and enables agentless replication.

```bash
# Create Azure Migrate project
az migrate project create \
  --name migrate-vmware-prod \
  --resource-group rg-migration \
  --location eastus2

# Download the appliance OVA from Azure Portal
# Portal > Azure Migrate > Servers, databases and web apps > Discover
```

**Appliance deployment steps:**

1. Download the OVA from the Azure Migrate portal
2. Deploy the OVA in your on-premises vCenter
3. Configure the appliance with Azure credentials (register with the Migrate project)
4. Add vCenter Server credentials for discovery
5. Start discovery (scans every 15 minutes)

### Appliance resource requirements

| Resource | Requirement                                                    |
| -------- | -------------------------------------------------------------- |
| vCPU     | 8                                                              |
| RAM      | 16 GB                                                          |
| Disk     | 80 GB                                                          |
| Network  | Access to vCenter (443), Azure (443), discovered VMs (WMI/SSH) |

### What discovery collects

- VM inventory (name, OS, CPU, memory, disks, network adapters)
- Performance data (CPU utilization, memory utilization, disk IOPS, network throughput)
- Installed applications (Windows: registry-based; Linux: package manager-based)
- SQL Server instances and databases (if present)
- Web applications (IIS, Tomcat, if present)
- Dependencies (agentless via connection data, or agent-based via Dependency Agent)

---

## Phase 2 -- Assessment

### Create assessment

```bash
# Create an Azure VM assessment
az migrate assessment create \
  --project-name migrate-vmware-prod \
  --resource-group rg-migration \
  --assessment-name assessment-prod-vms \
  --sizing-criterion "PerformanceBased" \
  --percentile "Percentile95" \
  --time-range "Month" \
  --target-location "eastus2" \
  --offer "MS-AZR-0017P"
```

### Assessment output

The assessment provides:

| Output                     | Description                                                        |
| -------------------------- | ------------------------------------------------------------------ |
| **Azure readiness**        | Ready, conditionally ready, not ready, or unknown for each VM      |
| **VM size recommendation** | Recommended Azure VM size based on performance data                |
| **Monthly cost estimate**  | Estimated Azure cost (pay-as-you-go and reserved pricing)          |
| **Storage recommendation** | Disk type (Standard HDD, Standard SSD, Premium SSD, Ultra)         |
| **Confidence rating**      | Data quality indicator (1--5 stars based on data points available) |

### Assessment recommendations

| vSphere VM config                       | Recommended Azure VM | Series                   | Rationale                                      |
| --------------------------------------- | -------------------- | ------------------------ | ---------------------------------------------- |
| 2 vCPU, 4 GB RAM, low utilization       | B2s                  | B-series (burstable)     | Low-utilization workloads save with burstable  |
| 4 vCPU, 16 GB RAM, moderate utilization | D4s_v5               | Dsv5 (general purpose)   | Balanced compute for standard workloads        |
| 8 vCPU, 32 GB RAM, compute-intensive    | D8s_v5               | Dsv5 (general purpose)   | CPU-optimized for application servers          |
| 4 vCPU, 32 GB RAM, memory-intensive     | E4s_v5               | Esv5 (memory-optimized)  | Database servers, caching, in-memory analytics |
| 8 vCPU, 64 GB RAM, SQL Server           | E8s_v5               | Esv5 (memory-optimized)  | SQL Server, Oracle, SAP                        |
| 16 vCPU, 64 GB RAM, high performance    | F16s_v2              | Fsv2 (compute-optimized) | Batch processing, gaming, analytics            |
| GPU workload                            | NC/ND series         | N-series                 | ML training, rendering, HPC                    |

### Right-sizing and decommission analysis

!!! tip "Identify zombie VMs"
Azure Migrate assessment data frequently reveals that 15--30% of VMs have near-zero CPU/memory utilization. These are candidates for decommission rather than migration. Decommissioning zombie VMs before migration saves significant Azure spend.

---

## Phase 3 -- Replication

### Agentless replication (recommended)

Agentless replication uses the Azure Migrate appliance and VMware vSphere APIs to replicate VMs without installing agents inside the guest OS.

```bash
# Enable replication for a discovered VM
# (Typically done via Azure Portal for VM selection)
# Portal > Azure Migrate > Servers > Replicate
```

**How agentless replication works:**

1. Initial replication: full disk copy via VMware Changed Block Tracking (CBT)
2. Delta replication: periodic sync of changed blocks (every 5--15 minutes)
3. Sync continues until you trigger cutover
4. At cutover: final sync, VM powered off on-prem, Azure VM powered on

| Parameter               | Agentless replication                               |
| ----------------------- | --------------------------------------------------- |
| Agent required          | No                                                  |
| VMware dependency       | vSphere 6.5+ with CBT enabled                       |
| Concurrent replications | Up to 500 VMs per appliance                         |
| Replication frequency   | Every 5--15 minutes (configurable)                  |
| Network bandwidth       | ~100 Mbps per VM (initial), ~10 Mbps per VM (delta) |
| Supported OS            | Windows Server 2008 R2+, most Linux distributions   |
| Disk limit              | Up to 60 disks per VM, up to 32 TB per disk         |

### Agent-based replication

For VMs that do not support agentless replication (older OS, non-VMware hypervisors), agent-based replication installs the Mobility Service agent inside the guest OS.

| Parameter               | Agent-based replication                                 |
| ----------------------- | ------------------------------------------------------- |
| Agent required          | Yes (Mobility Service inside guest OS)                  |
| VMware dependency       | None (works with any hypervisor or physical)            |
| Concurrent replications | Up to 400 VMs per replication appliance                 |
| Replication frequency   | Continuous (near-real-time)                             |
| RPO                     | As low as 5 minutes                                     |
| Supported OS            | Windows Server 2008 R2+, RHEL/CentOS/Ubuntu/Debian/SLES |

---

## Phase 4 -- Test migration

Before cutover, run a test migration to validate that the VM works correctly on Azure:

```bash
# Test migration creates a test VM in Azure without affecting the source
# Portal > Azure Migrate > Replicated servers > [VM] > Test migration
```

**Test migration checklist:**

- [ ] VM boots successfully on Azure
- [ ] OS and applications start correctly
- [ ] Network connectivity to dependent services works
- [ ] Storage performance meets requirements (check IOPS/throughput)
- [ ] Authentication (AD/LDAP join, Entra ID) works
- [ ] Application-level health checks pass
- [ ] Monitoring agents (Azure Monitor, Defender) report correctly

!!! warning "Test migration networking"
Test migrations should use an isolated test VNet to avoid IP conflicts with the production environment. Do not connect the test VNet to production networks.

---

## Phase 5 -- Cutover

### Cutover process

1. **Schedule maintenance window**: coordinate with application owners
2. **Final sync**: Azure Migrate performs a final delta replication
3. **Power off source VM**: stop the on-prem VM to ensure data consistency
4. **Complete migration**: Azure Migrate finalizes the Azure VM
5. **Verify Azure VM**: boot, test application health, verify connectivity
6. **Update DNS/load balancer**: point traffic to the new Azure VM IP
7. **Monitor**: watch for 24--48 hours before decommissioning on-prem VM

### Cutover timing

| VM size (disk) | Final sync time | Total cutover window |
| -------------- | --------------- | -------------------- |
| < 100 GB       | 5--10 minutes   | 15--30 minutes       |
| 100--500 GB    | 10--30 minutes  | 30--60 minutes       |
| 500 GB -- 2 TB | 30--120 minutes | 1--3 hours           |
| > 2 TB         | 2--8 hours      | 3--10 hours          |

### Post-cutover tasks

```bash
# Verify VM is running
az vm show \
  --name migrated-vm-01 \
  --resource-group rg-migrated-vms \
  --query "powerState"

# Enable Azure Backup
az backup protection enable-for-vm \
  --resource-group rg-backup \
  --vault-name rsv-prod \
  --vm migrated-vm-01 \
  --policy-name daily-backup-policy

# Enable Defender for Cloud
# (Automatic if subscription-level Defender is enabled)

# Install Azure Monitor agent
az vm extension set \
  --name AzureMonitorLinuxAgent \
  --publisher Microsoft.Azure.Monitor \
  --vm-name migrated-vm-01 \
  --resource-group rg-migrated-vms
```

---

## VM conversion details

### What changes during migration

| Component        | VMware (source)                | Azure (target)                          |
| ---------------- | ------------------------------ | --------------------------------------- |
| Virtual hardware | VMware virtual hardware v13+   | Azure Generation 2 VM                   |
| Disk format      | VMDK                           | VHD (Azure Managed Disk)                |
| Network adapter  | VMXNET3 / E1000                | Azure accelerated networking (Mellanox) |
| Boot firmware    | BIOS or UEFI                   | UEFI (Gen2 VMs)                         |
| VMware Tools     | Installed                      | Replaced by Azure VM Agent              |
| SCSI controller  | VMware Paravirtual / LSI Logic | Azure SCSI / NVMe                       |
| Time sync        | VMware Tools time sync         | Azure time sync service                 |

### Driver and agent changes

After migration, Azure Migrate automatically:

1. Removes VMware Tools (or marks for removal)
2. Installs the Azure VM Agent (waagent for Linux, WindowsAzureGuestAgent for Windows)
3. Configures Azure accelerated networking drivers
4. Updates SCSI/NVMe drivers for Azure storage

---

## Networking considerations

### IP address management

| Strategy                                 | Description                                   | When to use                                                   |
| ---------------------------------------- | --------------------------------------------- | ------------------------------------------------------------- |
| **Retain IP addresses**                  | Azure VNet subnet matches on-prem subnet      | Same IP required by applications, DNS/certificate constraints |
| **New IP addresses**                     | Azure assigns new IPs, update DNS/LB          | Flexible, avoids subnet conflicts, cleanest approach          |
| **Hybrid (L2 stretch during migration)** | Use VPN/ExpressRoute with overlapping subnets | Complex, requires careful routing, avoid if possible          |

### DNS cutover

```bash
# Update DNS A record to point to Azure VM private IP
az network private-dns record-set a update \
  --resource-group rg-dns \
  --zone-name contoso.internal \
  --name app-server-01 \
  --set "aRecords[0].ipv4Address=10.20.1.50"
```

---

## CSA-in-a-Box integration

For database and analytics VMs migrated to Azure IaaS, the next step is modernization to PaaS via CSA-in-a-Box:

### Migration from Azure IaaS VM to PaaS

| Azure IaaS VM        | CSA-in-a-Box PaaS target        | Migration tool          |
| -------------------- | ------------------------------- | ----------------------- |
| SQL Server Azure VM  | Fabric Warehouse / Azure SQL MI | Azure DMS               |
| PostgreSQL Azure VM  | Azure Database for PostgreSQL   | Azure DMS / pg_dump     |
| MySQL Azure VM       | Azure Database for MySQL        | Azure DMS / mysqldump   |
| ETL scripts Azure VM | Azure Data Factory + dbt        | Pipeline-by-pipeline    |
| SSRS Azure VM        | Power BI Service                | Report conversion       |
| Custom app Azure VM  | Azure App Service / AKS         | Application re-platform |

This two-step approach (VMware to Azure IaaS to PaaS) is often the most practical path for data workloads: get off VMware quickly with Azure Migrate, then modernize to PaaS on Azure timelines.

---

## Related

- [AVS Migration Guide](avs-migration.md)
- [Azure Migrate Tutorial](tutorial-azure-migrate.md)
- [Networking Migration](networking-migration.md)
- [Storage Migration](storage-migration.md)
- [Feature Mapping](feature-mapping-complete.md)
- [Migration Playbook](../vmware-to-azure.md)
- [Microsoft Learn: Azure Migrate](https://learn.microsoft.com/azure/migrate/)

---

**Last updated:** 2026-04-30
**Maintainers:** CSA-in-a-Box core team
