# Tutorial -- Azure Migrate for VMware to Azure IaaS

**Step-by-step tutorial: deploy the Azure Migrate appliance in a VMware environment, discover VMs, run assessment, replicate VMs to Azure IaaS, test migration, and perform cutover.**

---

## Prerequisites

Before starting this tutorial, ensure:

- [ ] Azure subscription with Contributor access
- [ ] On-premises VMware vCenter Server 5.5 or later
- [ ] On-premises ESXi 5.5 or later
- [ ] Network connectivity from on-premises to Azure (ExpressRoute or VPN recommended)
- [ ] vCenter account with read-only access (for discovery) and additional permissions for agentless replication
- [ ] Azure VNet and subnet ready for migrated VMs
- [ ] DNS configured to resolve Azure resources from on-premises

### vCenter permissions for agentless replication

The vCenter account used by Azure Migrate needs these privileges beyond read-only:

| Permission                                     | Required for                        |
| ---------------------------------------------- | ----------------------------------- |
| `VirtualMachine.Config.ChangeTracking`         | Enable Changed Block Tracking (CBT) |
| `VirtualMachine.Provisioning.DiskRandomRead`   | Read VM disk data for replication   |
| `VirtualMachine.Provisioning.DiskRandomAccess` | Access VM disk for replication      |
| `VirtualMachine.State.CreateSnapshot`          | Create snapshots for replication    |
| `VirtualMachine.State.RemoveSnapshot`          | Remove snapshots after replication  |

---

## Step 1: Create Azure Migrate project

### 1.1 Create the project

```bash
# Create resource group for migration
az group create \
  --name rg-migration \
  --location eastus2

# Create Azure Migrate project
az migrate project create \
  --name migrate-vmware-prod \
  --resource-group rg-migration \
  --location eastus2
```

### 1.2 Create target infrastructure

Prepare the Azure landing zone for migrated VMs:

```bash
# Create target VNet
az network vnet create \
  --name vnet-migrated-workloads \
  --resource-group rg-migration \
  --location eastus2 \
  --address-prefix 10.20.0.0/16

# Create subnets for different workload tiers
az network vnet subnet create \
  --vnet-name vnet-migrated-workloads \
  --resource-group rg-migration \
  --name subnet-web \
  --address-prefix 10.20.1.0/24

az network vnet subnet create \
  --vnet-name vnet-migrated-workloads \
  --resource-group rg-migration \
  --name subnet-app \
  --address-prefix 10.20.2.0/24

az network vnet subnet create \
  --vnet-name vnet-migrated-workloads \
  --resource-group rg-migration \
  --name subnet-db \
  --address-prefix 10.20.3.0/24

# Create NSG for each subnet
az network nsg create \
  --name nsg-web \
  --resource-group rg-migration \
  --location eastus2

az network nsg create \
  --name nsg-app \
  --resource-group rg-migration \
  --location eastus2

az network nsg create \
  --name nsg-db \
  --resource-group rg-migration \
  --location eastus2
```

---

## Step 2: Deploy the Azure Migrate appliance

### 2.1 Download the appliance OVA

1. Navigate to Azure Portal > Azure Migrate > Servers, databases and web apps
2. Click **Discover** under the Assessment tools section
3. Select **Yes, with VMware vSphere** for virtualization type
4. Select **Download** for the OVA appliance file

### 2.2 Deploy in VMware

1. In vSphere Client, select **File > Deploy OVF Template**
2. Select the downloaded Azure Migrate appliance OVA
3. Configure:
    - Name: `azure-migrate-appliance-01`
    - Folder: choose a management folder
    - Cluster/host: select your management cluster
    - Datastore: select a datastore with 80 GB free
    - Network: select your management network
4. Power on the appliance VM

### 2.3 Configure the appliance

1. Open a browser to `https://<appliance-ip>:44368`
2. Accept the license terms
3. Set up the appliance:
    - **Register with Azure**: sign in with Azure credentials, select subscription, select Migrate project
    - **Add vCenter Server**: enter vCenter FQDN/IP, port (443), and credentials
    - **Enable discovery of installed applications** (optional but recommended)
    - **Enable agentless dependency analysis** (optional, requires Service Map agent)
4. Click **Start Discovery**

!!! note "Discovery timing"
Initial discovery takes 15--30 minutes for metadata. Performance data collection requires a minimum of one day for accurate sizing recommendations. For best results, let discovery run for at least one week before creating assessments.

---

## Step 3: Review discovered inventory

### 3.1 View discovered VMs

After discovery completes, review the inventory in Azure Portal:

1. Navigate to Azure Migrate > Servers, databases and web apps
2. Click **Discovered servers** to see all discovered VMs
3. Review VM details: OS, CPU, memory, disks, network adapters, installed applications

### 3.2 Enable dependency analysis (recommended)

Dependency analysis shows which VMs communicate with each other, helping you plan migration groups:

**Agentless dependency analysis** (recommended):

1. In Azure Migrate > Servers > discovered servers, select VMs
2. Click **Start dependency analysis**
3. Analysis runs automatically using connection data from the VMware environment

**Agent-based dependency analysis** (for deeper visibility):

```bash
# Install Dependency Agent on Windows VM
# Download from Azure Portal > Azure Migrate > Dependency analysis
MicrosoftDependencyAgentWindows.exe /S

# Install Dependency Agent on Linux VM
sh InstallDependencyAgent-Linux64.bin -s
```

### 3.3 Group VMs by application

Create groups of related VMs for assessment and migration:

1. Navigate to Azure Migrate > Servers > Assessment tools > Groups
2. Click **Create group**
3. Add VMs to the group based on application dependencies
4. Example groups:
    - `group-webapp-prod`: web-01, web-02, app-01, app-02, db-01
    - `group-erp`: erp-web-01, erp-app-01, erp-db-01, erp-db-02
    - `group-fileservers`: fs-01, fs-02, fs-03

---

## Step 4: Run assessment

### 4.1 Create assessment

1. Navigate to Azure Migrate > Servers > Assessment tools
2. Click **Assess > Azure VM**
3. Configure assessment:
    - **Assessment name**: `assessment-prod-vms`
    - **Target location**: East US 2
    - **Pricing tier**: Standard
    - **Sizing criterion**: Performance-based (recommended)
    - **Performance history**: 1 month
    - **Percentile utilization**: 95th percentile
    - **VM series**: Dsv5, Esv5, Fsv2, Bsv2 (exclude GPU unless needed)
    - **Comfort factor**: 1.3 (30% buffer for growth)
    - **Offer/License**: EA or Pay-as-you-go
    - **Azure Hybrid Benefit**: Yes (if you have existing Windows Server/SQL licenses)
4. Select the group(s) to assess
5. Click **Create Assessment**

### 4.2 Review assessment results

The assessment provides:

| Column                   | Interpretation                                               |
| ------------------------ | ------------------------------------------------------------ |
| **Azure readiness**      | Green (ready), Yellow (conditionally ready), Red (not ready) |
| **Recommended size**     | Azure VM size based on performance data                      |
| **Monthly compute cost** | Estimated VM cost (pay-as-you-go)                            |
| **Monthly storage cost** | Estimated disk cost                                          |
| **Confidence rating**    | Data quality (1--5 stars)                                    |

### 4.3 Address readiness issues

Common readiness issues and resolutions:

| Issue                   | Resolution                                                          |
| ----------------------- | ------------------------------------------------------------------- |
| **Boot type: BIOS**     | Convert to UEFI during migration (Azure Gen2 VM) or use Gen1 VM     |
| **Unsupported OS**      | Check Azure supported OS list; consider OS upgrade before migration |
| **Disk > 32 TB**        | Split data across multiple disks, or use Ultra Disk                 |
| **> 64 disks per VM**   | Reduce disk count or use a VM size that supports more disks         |
| **NIC count**           | Azure VMs support 2--8 NICs depending on size                       |
| **Static MAC required** | Azure assigns dynamic MACs; update application configuration        |

---

## Step 5: Replicate VMs

### 5.1 Enable replication

1. Navigate to Azure Migrate > Servers > Migration tools
2. Click **Replicate**
3. Configure replication settings:
    - **Source**: VMware (agentless)
    - **Appliance**: select your Azure Migrate appliance
    - **VMs**: select VMs from your assessed groups
    - **Target subscription**: select Azure subscription
    - **Target resource group**: rg-migrated-vms
    - **Target VNet/subnet**: vnet-migrated-workloads / subnet-app
    - **Availability option**: Availability Zone or Availability Set
    - **OS disk type**: Premium SSD (production) or Standard SSD (dev/test)
    - **Azure Hybrid Benefit**: Enable if you have existing licenses

### 5.2 Monitor replication

```bash
# Check replication status via CLI
az migrate replication list \
  --project-name migrate-vmware-prod \
  --resource-group rg-migration \
  --query "[].{Name:machineName, Status:replicationStatus, Health:replicationHealth}"
```

| Replication status  | Meaning                                         |
| ------------------- | ----------------------------------------------- |
| Initial replication | First full disk copy in progress                |
| Protected           | Initial replication complete, delta sync active |
| Planned failover    | Migration in progress                           |
| Failed              | Replication error (check logs)                  |

!!! warning "Initial replication time"
Initial replication copies the entire disk. For a 500 GB disk over a 1 Gbps link, expect approximately 1 hour. For large environments, stagger initial replication to avoid saturating your WAN link.

---

## Step 6: Test migration

### 6.1 Create test network

Create an isolated VNet for test migration to avoid IP conflicts:

```bash
# Create isolated test VNet (no peering to production)
az network vnet create \
  --name vnet-migration-test \
  --resource-group rg-migration \
  --location eastus2 \
  --address-prefix 10.99.0.0/16

az network vnet subnet create \
  --vnet-name vnet-migration-test \
  --resource-group rg-migration \
  --name subnet-test \
  --address-prefix 10.99.1.0/24
```

### 6.2 Run test migration

1. Navigate to Azure Migrate > Servers > Migration tools > Replicated servers
2. Select a VM
3. Click **Test Migration**
4. Select the test VNet (vnet-migration-test)
5. Click **Test Migration**

Azure Migrate creates a test VM in Azure from the replicated data. The source VM is unaffected.

### 6.3 Validate test VM

Connect to the test VM and validate:

```bash
# Get test VM public IP (or use Azure Bastion)
az vm show \
  --name migrated-vm-01-test \
  --resource-group rg-migration \
  --show-details \
  --query "publicIps"

# Verify VM is responding
az vm run-command invoke \
  --name migrated-vm-01-test \
  --resource-group rg-migration \
  --command-id RunPowerShellScript \
  --scripts "Get-Service | Where-Object {$_.Status -eq 'Running'} | Select-Object Name, Status"
```

**Test migration validation checklist:**

- [ ] VM boots successfully
- [ ] OS login works (RDP/SSH)
- [ ] Application processes are running
- [ ] Application health check endpoint responds
- [ ] Database connectivity works (if applicable)
- [ ] File system integrity verified
- [ ] Performance is acceptable (CPU, memory, disk)

### 6.4 Clean up test migration

```bash
# Clean up test migration (removes test VM)
# Azure Portal > Azure Migrate > Replicated servers > [VM] > Clean up test migration
```

---

## Step 7: Cutover (production migration)

### 7.1 Plan the cutover window

- Coordinate with application owners for maintenance window
- Notify users of planned downtime
- Prepare rollback plan (keep source VM available for 30 days)
- Update change management records

### 7.2 Execute cutover

1. Navigate to Azure Migrate > Servers > Migration tools > Replicated servers
2. Select the VM(s) to migrate
3. Click **Migrate**
4. Configure:
    - **Shut down on-premises VM before migration**: Yes (recommended for data consistency)
    - This performs a final delta sync, then powers off the source VM
5. Click **Migrate**

### 7.3 Post-cutover configuration

```bash
# Verify VM is running
az vm show \
  --name migrated-vm-01 \
  --resource-group rg-migrated-vms \
  --query "powerState"

# Enable boot diagnostics
az vm boot-diagnostics enable \
  --name migrated-vm-01 \
  --resource-group rg-migrated-vms

# Enable Azure Backup
az backup protection enable-for-vm \
  --resource-group rg-backup \
  --vault-name rsv-prod-eastus2 \
  --vm migrated-vm-01 \
  --policy-name daily-backup

# Install Azure Monitor Agent
az vm extension set \
  --name AzureMonitorWindowsAgent \
  --publisher Microsoft.Azure.Monitor \
  --vm-name migrated-vm-01 \
  --resource-group rg-migrated-vms

# Update DNS record
az network private-dns record-set a add-record \
  --resource-group rg-dns \
  --zone-name contoso.internal \
  --record-set-name migrated-vm-01 \
  --ipv4-address 10.20.2.10
```

---

## Step 8: Post-migration optimization

### 8.1 Right-sizing

After 1--2 weeks of production operation, review Azure Advisor recommendations:

```bash
# Get VM right-sizing recommendations
az advisor recommendation list \
  --filter "Category eq 'Cost'" \
  --query "[?contains(shortDescription.problem, 'size')].{VM:resourceMetadata.resourceId, Recommendation:shortDescription.solution}"
```

### 8.2 Enable Reserved Instances

For VMs that will run long-term:

```bash
# Calculate reserved instance savings
# Azure Portal > Cost Management > Advisor recommendations > Reserved Instances
# Review 1-year and 3-year savings projections
```

### 8.3 Consider CSA-in-a-Box modernization

For database and analytics VMs migrated to Azure IaaS, evaluate modernization to PaaS:

| Migrated Azure VM | CSA-in-a-Box target             | Benefit                                       |
| ----------------- | ------------------------------- | --------------------------------------------- |
| SQL Server VM     | Fabric Warehouse / Azure SQL MI | Managed, auto-tuned, Direct Lake analytics    |
| ETL VM            | Azure Data Factory + dbt        | Version-controlled, monitored pipelines       |
| SSRS VM           | Power BI Service                | Copilot, sharing, mobile, zero infrastructure |

---

## Troubleshooting

| Issue                            | Cause                            | Resolution                                                       |
| -------------------------------- | -------------------------------- | ---------------------------------------------------------------- |
| Discovery shows 0 VMs            | vCenter credentials insufficient | Verify account has read-only access to all inventory objects     |
| Replication fails with CBT error | CBT not enabled or stale         | Reset CBT on the VM: power off, remove all snapshots, power on   |
| Initial replication very slow    | WAN bandwidth saturated          | Stagger replication start times; increase ExpressRoute bandwidth |
| Test VM boots to BSOD            | Driver incompatibility           | Convert to Gen2 VM; update SCSI/network drivers                  |
| Test VM no network               | NSG blocking traffic             | Check NSG rules on the test subnet; allow RDP/SSH                |
| Cutover fails                    | Source VM locked by snapshot     | Remove all third-party snapshots before cutover                  |

---

## Related

- [Azure IaaS Migration Guide](azure-iaas-migration.md)
- [HCX Migration Tutorial](tutorial-hcx-migration.md)
- [Networking Migration](networking-migration.md)
- [Best Practices](best-practices.md)
- [Migration Playbook](../vmware-to-azure.md)

---

**Last updated:** 2026-04-30
**Maintainers:** CSA-in-a-Box core team
