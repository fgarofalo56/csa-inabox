# Tutorial -- HCX Migration to Azure VMware Solution

**Step-by-step tutorial: configure HCX site pairing, network profiles, compute profiles, service mesh, and perform live vMotion migration of VMs from on-premises VMware to AVS.**

---

## Prerequisites

Before starting this tutorial, ensure:

- [ ] AVS private cloud deployed and running (minimum 3 hosts)
- [ ] ExpressRoute or VPN connectivity between on-premises and Azure established
- [ ] On-premises vCenter Server 6.5 or later
- [ ] On-premises ESXi hosts 6.5 or later
- [ ] Network connectivity: TCP 443, 8443, 9443 between HCX appliances
- [ ] DNS resolution working between on-premises and AVS
- [ ] Azure CLI installed and authenticated
- [ ] Sufficient IP addresses for HCX appliances (management, uplink, vMotion networks)

### Network port requirements

| Port | Protocol | Source        | Destination       | Purpose               |
| ---- | -------- | ------------- | ----------------- | --------------------- |
| 443  | TCP      | HCX Connector | HCX Manager (AVS) | Management, API       |
| 8443 | TCP      | HCX Connector | HCX Manager (AVS) | Bulk migration        |
| 4500 | UDP      | HCX Connector | HCX Manager (AVS) | IPsec tunnel (IKE)    |
| 500  | UDP      | HCX Connector | HCX Manager (AVS) | IPsec tunnel (ISAKMP) |
| 9443 | TCP      | HCX Connector | HCX Manager (AVS) | Appliance management  |

---

## Step 1: Enable HCX on AVS

### 1.1 Enable HCX add-on

```bash
# Enable HCX Enterprise on your AVS private cloud
az vmware addon hcx create \
  --private-cloud avs-prod-eastus2 \
  --resource-group rg-avs-prod \
  --offer VMware-MaaS-Cloud

# Verify HCX status
az vmware addon hcx show \
  --private-cloud avs-prod-eastus2 \
  --resource-group rg-avs-prod \
  --query "provisioningState"
```

### 1.2 Get HCX Manager URL and activation key

```bash
# Get HCX Cloud Manager URL
az vmware private-cloud show \
  --name avs-prod-eastus2 \
  --resource-group rg-avs-prod \
  --query "endpoints.hcxCloudManager"

# Generate activation key for on-premises connector
az vmware hcx-enterprise-site create \
  --name onprem-datacenter-1 \
  --private-cloud avs-prod-eastus2 \
  --resource-group rg-avs-prod
```

Save the HCX Manager URL and activation key for use in Step 2.

---

## Step 2: Deploy HCX Connector on-premises

### 2.1 Download the HCX Connector OVA

1. Navigate to the Azure Portal > AVS private cloud > Manage > Add-ons > HCX
2. Copy the HCX Cloud Manager URL
3. Open the HCX Cloud Manager URL in a browser
4. Log in with the cloudadmin credentials
5. Navigate to System Updates > Download the HCX Connector OVA

### 2.2 Deploy the OVA in on-premises vCenter

1. In vSphere Client, select **File > Deploy OVF Template**
2. Select the downloaded HCX Connector OVA
3. Configure deployment settings:
    - Name: `hcx-connector-01`
    - Folder: choose an appropriate folder
    - Cluster/host: select a cluster with sufficient resources
    - Datastore: select a datastore with at least 35 GB free
4. Configure network settings:
    - Management network: your management VLAN/port group
    - IP address: assign a static IP from your management subnet
    - Subnet mask, gateway, DNS: configure per your environment

### 2.3 Activate the HCX Connector

1. Open the HCX Connector management interface: `https://<hcx-connector-ip>:9443`
2. Enter the activation key from Step 1.2
3. Enter the HCX Cloud Manager URL
4. Wait for activation to complete (2--5 minutes)

### 2.4 Configure HCX Connector

1. Connect to vCenter: enter your on-premises vCenter URL and credentials
2. Configure SSO: connect to your identity source (AD/LDAP or vSphere SSO)
3. Configure location: set the geographic location for the connector

---

## Step 3: Create site pairing

### 3.1 Initiate site pairing

1. In the HCX Connector UI, navigate to **Infrastructure > Interconnect > Site Pairing**
2. Click **Add Site Pairing**
3. Enter the AVS HCX Cloud Manager URL
4. Enter credentials: `cloudadmin@vsphere.local` and the AVS cloudadmin password
5. Accept the remote site certificate
6. Click **Connect**

### 3.2 Verify site pairing

After pairing, verify the connection status shows **Connected**. The site pairing establishes the management plane connection between your on-premises HCX and AVS HCX.

---

## Step 4: Create network profiles

Network profiles define the IP pools that HCX appliances use for communication.

### 4.1 Management network profile

```
Profile name: management-profile
Network: Management port group / VLAN
IP Pool: 10.10.1.100 -- 10.10.1.110 (10 IPs)
Subnet: 255.255.255.0
Gateway: 10.10.1.1
DNS: 10.10.1.5
```

### 4.2 Uplink network profile

```
Profile name: uplink-profile
Network: Uplink port group (routable to Azure)
IP Pool: 10.10.2.100 -- 10.10.2.110 (10 IPs)
Subnet: 255.255.255.0
Gateway: 10.10.2.1
```

### 4.3 vMotion network profile

```
Profile name: vmotion-profile
Network: vMotion port group
IP Pool: 10.10.3.100 -- 10.10.3.110 (10 IPs)
Subnet: 255.255.255.0
Gateway: 10.10.3.1 (or no gateway if vMotion is non-routed)
```

### 4.4 Replication network profile (optional)

```
Profile name: replication-profile
Network: Replication port group (can share with vMotion)
IP Pool: 10.10.4.100 -- 10.10.4.110 (10 IPs)
Subnet: 255.255.255.0
Gateway: 10.10.4.1
```

!!! note "IP pool sizing"
Each HCX service mesh deployment consumes 4--6 IPs from each network profile. If you plan to create multiple service meshes, size your IP pools accordingly.

---

## Step 5: Create compute profile

The compute profile defines which on-premises resources HCX can use for migration.

1. Navigate to **Infrastructure > Interconnect > Compute Profiles**
2. Click **Create Compute Profile**
3. Configure:
    - Name: `compute-profile-prod`
    - Select services: **Migration** and **Network Extension** (and optionally DR, WANopt)
    - Select resources: choose on-premises cluster(s) and datastore(s)
    - Select network profiles: assign the profiles created in Step 4
    - Management: management-profile
    - Uplink: uplink-profile
    - vMotion: vmotion-profile
    - Replication: replication-profile (or vmotion-profile)

---

## Step 6: Create service mesh

The service mesh deploys HCX appliances (IX, NE, WAN optimization) that create the connectivity infrastructure between sites.

1. Navigate to **Infrastructure > Interconnect > Service Mesh**
2. Click **Create Service Mesh**
3. Select the source site (on-premises) and destination site (AVS)
4. Select the source compute profile (from Step 5)
5. Select the destination compute profile (auto-configured by AVS)
6. Select services to deploy:
    - **Interconnect** (required): secure tunnel between sites
    - **Network Extension** (recommended): L2 stretch for same-subnet migration
    - **WAN Optimization** (optional): acceleration for high-latency links
7. Review and deploy

!!! warning "Service mesh deployment time"
Service mesh deployment takes 15--30 minutes. The IX and NE appliances are deployed as VMs on both the source and destination clusters. Do not interrupt the deployment.

### Verify service mesh health

After deployment, verify all appliances show green status:

- **Tunnel Status**: Up
- **IX Appliance**: Connected
- **NE Appliance**: Connected (if deployed)

---

## Step 7: Extend networks (optional but recommended)

Network extension allows you to stretch Layer 2 networks from on-premises to AVS, so VMs keep their IP addresses during migration.

1. Navigate to **Network Extension**
2. Select the service mesh created in Step 6
3. Select the on-premises port group(s) to extend
4. Assign the destination gateway (AVS Tier-1 gateway)
5. Click **Extend**

!!! tip "When to skip network extension"
If you plan to re-IP VMs after migration (change their IP addresses), you can skip network extension and perform a standard L3 migration. This is cleaner for long-term operations but requires DNS and application configuration updates.

---

## Step 8: Migrate VMs

### 8.1 vMotion migration (zero downtime)

1. Navigate to **Migration > Migrate**
2. Select source vCenter and VMs to migrate
3. Select migration type: **vMotion**
4. Select destination:
    - Cluster: AVS cluster
    - Datastore: vSAN datastore
    - Folder: target folder
    - Resource pool: target resource pool
5. Configure network mapping (source port group to destination segment)
6. Click **Validate** to check prerequisites
7. Click **Go** to start migration

Monitor progress in the HCX dashboard. vMotion migration typically takes 5--30 minutes per VM depending on memory size and change rate.

### 8.2 Bulk migration (parallel with reboot)

1. Navigate to **Migration > Migrate**
2. Select VMs to migrate (select multiple)
3. Select migration type: **Bulk Migration**
4. Configure:
    - Schedule: immediate or scheduled date/time
    - Switchover window: when to perform the final reboot
    - Retain MAC: keep or change MAC addresses
5. Click **Go** to start replication

Bulk migration replicates VMs in the background. At the scheduled switchover time, VMs are rebooted on the destination.

### 8.3 RAV migration (bulk replication + vMotion cutover)

1. Navigate to **Migration > Migrate**
2. Select VMs to migrate
3. Select migration type: **Replication Assisted vMotion (RAV)**
4. Configure destination and network mapping
5. Click **Go** to start replication phase
6. When replication is complete, trigger vMotion cutover

RAV is the recommended method for large-scale migrations requiring zero downtime at cutover.

---

## Step 9: Validate migrated VMs

After migration, validate each VM on AVS:

```bash
# Verify VM is running on AVS (via PowerCLI)
Connect-VIServer -Server avs-vcenter-url -User cloudadmin@vsphere.local

Get-VM -Name "migrated-vm-01" | Select-Object Name, PowerState, VMHost, NumCpu, MemoryGB

# Check VM network connectivity
Test-Connection -ComputerName migrated-vm-01 -Count 4

# Verify DNS resolution
Resolve-DnsName migrated-vm-01.contoso.com
```

### Post-migration checklist

- [ ] VM powered on and responsive
- [ ] Application health checks pass
- [ ] Network connectivity to dependent services verified
- [ ] Storage performance meets expectations
- [ ] Monitoring (Azure Monitor) receiving data
- [ ] Backup (Azure Backup) configured
- [ ] DNS records updated (if IP changed)

---

## Step 10: Cleanup

After all VMs are migrated and validated:

1. **Un-extend networks**: remove L2 extensions (HCX > Network Extension > Un-extend)
2. **Remove service mesh**: decommission HCX appliances
3. **Remove site pairing**: disconnect on-premises from AVS
4. **Decommission on-prem HCX Connector**: power off and delete the VM
5. **Decommission on-prem VMware**: after the soak period, power off ESXi hosts

!!! warning "Wait for soak period"
Maintain the on-premises environment for 30--60 days after migration as a rollback option. Only decommission after confirming all applications are stable on AVS.

---

## Troubleshooting

| Issue                           | Cause                                      | Resolution                                               |
| ------------------------------- | ------------------------------------------ | -------------------------------------------------------- |
| Site pairing fails              | Network connectivity / firewall            | Verify ports 443, 8443, 9443 are open between sites      |
| Service mesh deployment hangs   | Resource constraints on source/destination | Verify sufficient CPU/memory/storage for HCX appliances  |
| vMotion migration slow          | WAN bandwidth limitation                   | Consider RAV for bulk replication + vMotion cutover      |
| L2 extension fails              | MTU mismatch or VLAN trunking              | Verify MTU >= 1500 and VLAN is trunked to HCX appliances |
| Bulk migration reboot times out | VM guest OS slow to boot                   | Increase the switchover timeout or check guest OS health |

---

## Related

- [AVS Migration Guide](avs-migration.md)
- [Azure Migrate Tutorial](tutorial-azure-migrate.md)
- [Networking Migration](networking-migration.md)
- [Feature Mapping](feature-mapping-complete.md)
- [Migration Playbook](../vmware-to-azure.md)

---

**Last updated:** 2026-04-30
**Maintainers:** CSA-in-a-Box core team
