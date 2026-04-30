# Tutorial: Deploy SAP S/4HANA on Azure

**Step-by-step: deploy a complete SAP S/4HANA system on Azure using Azure Center for SAP Solutions, including VNet setup, VM deployment, HANA installation, and high availability configuration.**

---

!!! info "Prerequisites" - Azure subscription with Owner or Contributor role - SAP software download access (SAP S-user with software download authorization) - SAP HANA installation media and S/4HANA installation media - Familiarity with SAP Basis administration - Azure CLI 2.50+ installed - Estimated time: 4--6 hours

!!! warning "This tutorial deploys billable Azure resources"
The M-series VMs used for SAP HANA are premium-priced. A single M128s VM costs approximately $10,000/month. Use this tutorial for production planning or proof-of-concept; shut down VMs when not in use to minimize costs.

---

## Architecture overview

This tutorial deploys a three-tier SAP S/4HANA system with high availability:

```
                        Azure Load Balancer
                              │
                   ┌──────────┴──────────┐
                   │                     │
            ┌──────▼──────┐       ┌──────▼──────┐
            │ ASCS (Zone1)│       │ ERS (Zone 2)│
            │ E32ds_v5    │       │ E32ds_v5    │
            └─────────────┘       └─────────────┘
                   │
            ┌──────▼──────┐       ┌─────────────┐
            │ App Server 1│       │ App Server 2│
            │ E32ds_v5    │       │ E32ds_v5    │
            └─────────────┘       └─────────────┘
                   │
            Azure Load Balancer (HANA)
                   │
            ┌──────▼──────┐       ┌─────────────┐
            │ HANA Primary│       │ HANA Second.│
            │ M64s (Z1)   │       │ M64s (Z2)   │
            │ ANF storage │       │ ANF storage │
            └─────────────┘       └─────────────┘
                    HSR (synchronous)
```

---

## Step 1: Prepare the Azure environment

### 1.1 Create resource groups

```bash
# Set variables
export LOCATION="eastus2"
export RG_SAP="rg-sap-s4h-tutorial"
export RG_NETWORK="rg-sap-network-tutorial"

# Create resource groups
az group create --name $RG_NETWORK --location $LOCATION
az group create --name $RG_SAP --location $LOCATION
```

### 1.2 Create the Virtual Network

```bash
# Create VNet with SAP-specific subnets
az network vnet create \
  --resource-group $RG_NETWORK \
  --name vnet-sap-tutorial \
  --address-prefixes 10.10.0.0/16 \
  --location $LOCATION

# Database subnet
az network vnet subnet create \
  --resource-group $RG_NETWORK \
  --vnet-name vnet-sap-tutorial \
  --name sap-db-subnet \
  --address-prefixes 10.10.1.0/24

# Application subnet
az network vnet subnet create \
  --resource-group $RG_NETWORK \
  --vnet-name vnet-sap-tutorial \
  --name sap-app-subnet \
  --address-prefixes 10.10.2.0/24

# ANF delegated subnet
az network vnet subnet create \
  --resource-group $RG_NETWORK \
  --vnet-name vnet-sap-tutorial \
  --name anf-subnet \
  --address-prefixes 10.10.3.0/24 \
  --delegations Microsoft.NetApp/volumes

# Management subnet (Azure Bastion)
az network vnet subnet create \
  --resource-group $RG_NETWORK \
  --vnet-name vnet-sap-tutorial \
  --name AzureBastionSubnet \
  --address-prefixes 10.10.4.0/26
```

### 1.3 Create Network Security Groups

```bash
# NSG for database subnet
az network nsg create \
  --resource-group $RG_NETWORK \
  --name nsg-sap-db \
  --location $LOCATION

# Allow HANA SQL from app subnet
az network nsg rule create \
  --resource-group $RG_NETWORK \
  --nsg-name nsg-sap-db \
  --name Allow-HANA-SQL \
  --priority 100 \
  --source-address-prefixes 10.10.2.0/24 \
  --destination-port-ranges 30013 30015 30017 \
  --protocol TCP \
  --access Allow

# Allow HSR between HANA nodes
az network nsg rule create \
  --resource-group $RG_NETWORK \
  --nsg-name nsg-sap-db \
  --name Allow-HSR \
  --priority 110 \
  --source-address-prefixes 10.10.1.0/24 \
  --destination-port-ranges 40002-40005 \
  --protocol TCP \
  --access Allow

# Associate NSG with database subnet
az network vnet subnet update \
  --resource-group $RG_NETWORK \
  --vnet-name vnet-sap-tutorial \
  --name sap-db-subnet \
  --network-security-group nsg-sap-db
```

### 1.4 Create Azure Bastion for secure access

```bash
# Create Bastion for SSH access (no public IPs on SAP VMs)
az network public-ip create \
  --resource-group $RG_NETWORK \
  --name pip-bastion-sap \
  --sku Standard \
  --location $LOCATION

az network bastion create \
  --resource-group $RG_NETWORK \
  --name bastion-sap-tutorial \
  --public-ip-address pip-bastion-sap \
  --vnet-name vnet-sap-tutorial \
  --location $LOCATION \
  --sku Standard \
  --enable-tunneling true
```

---

## Step 2: Create Azure NetApp Files for HANA storage

```bash
# Create ANF account
az netappfiles account create \
  --resource-group $RG_SAP \
  --name anf-sap-tutorial \
  --location $LOCATION

# Create capacity pool (Ultra tier for HANA)
az netappfiles pool create \
  --resource-group $RG_SAP \
  --account-name anf-sap-tutorial \
  --name pool-hana-ultra \
  --size 4 \
  --service-level Ultra \
  --location $LOCATION

# Create HANA data volume
az netappfiles volume create \
  --resource-group $RG_SAP \
  --account-name anf-sap-tutorial \
  --pool-name pool-hana-ultra \
  --name vol-hana-data \
  --location $LOCATION \
  --file-path hana-data \
  --usage-threshold 1536 \
  --vnet vnet-sap-tutorial \
  --subnet anf-subnet \
  --protocol-types NFSv4.1 \
  --rule-index 1 \
  --allowed-clients 10.10.1.0/24 \
  --unix-read-write true

# Create HANA log volume
az netappfiles volume create \
  --resource-group $RG_SAP \
  --account-name anf-sap-tutorial \
  --pool-name pool-hana-ultra \
  --name vol-hana-log \
  --location $LOCATION \
  --file-path hana-log \
  --usage-threshold 512 \
  --vnet vnet-sap-tutorial \
  --subnet anf-subnet \
  --protocol-types NFSv4.1 \
  --rule-index 1 \
  --allowed-clients 10.10.1.0/24 \
  --unix-read-write true

# Create HANA shared volume (Premium tier)
az netappfiles pool create \
  --resource-group $RG_SAP \
  --account-name anf-sap-tutorial \
  --name pool-hana-premium \
  --size 4 \
  --service-level Premium \
  --location $LOCATION

az netappfiles volume create \
  --resource-group $RG_SAP \
  --account-name anf-sap-tutorial \
  --pool-name pool-hana-premium \
  --name vol-hana-shared \
  --location $LOCATION \
  --file-path hana-shared \
  --usage-threshold 1024 \
  --vnet vnet-sap-tutorial \
  --subnet anf-subnet \
  --protocol-types NFSv4.1 \
  --rule-index 1 \
  --allowed-clients 10.10.1.0/24 \
  --unix-read-write true
```

---

## Step 3: Deploy SAP VMs using Azure Center for SAP Solutions

### 3.1 Register the provider

```bash
# Register Azure Center for SAP Solutions provider
az provider register --namespace Microsoft.Workloads
az provider show --namespace Microsoft.Workloads --query "registrationState"
```

### 3.2 Deploy SAP Virtual Instance

```bash
# Deploy three-tier SAP S/4HANA system
az workloads sap-virtual-instance create \
  --resource-group $RG_SAP \
  --name S4H-TUT \
  --environment NonProduction \
  --sap-product S4HANA \
  --location $LOCATION \
  --configuration '{
    "configurationType": "DeploymentWithOSConfig",
    "appLocation": "'$LOCATION'",
    "infrastructureConfiguration": {
      "appResourceGroup": "'$RG_SAP'-infra",
      "deploymentType": "ThreeTier",
      "centralServer": {
        "subnetId": "/subscriptions/'$SUB_ID'/resourceGroups/'$RG_NETWORK'/providers/Microsoft.Network/virtualNetworks/vnet-sap-tutorial/subnets/sap-app-subnet",
        "virtualMachineConfiguration": {
          "vmSize": "Standard_E32ds_v5",
          "imageReference": {
            "publisher": "SUSE",
            "offer": "sles-sap-15-sp5",
            "sku": "gen2",
            "version": "latest"
          },
          "osProfile": {
            "adminUsername": "sapadmin",
            "osConfiguration": {
              "disablePasswordAuthentication": true,
              "sshKeyPair": {
                "publicKey": "'$(cat ~/.ssh/id_rsa.pub)'"
              }
            }
          }
        },
        "instanceCount": 1
      },
      "applicationServer": {
        "subnetId": "/subscriptions/'$SUB_ID'/resourceGroups/'$RG_NETWORK'/providers/Microsoft.Network/virtualNetworks/vnet-sap-tutorial/subnets/sap-app-subnet",
        "virtualMachineConfiguration": {
          "vmSize": "Standard_E32ds_v5",
          "imageReference": {
            "publisher": "SUSE",
            "offer": "sles-sap-15-sp5",
            "sku": "gen2",
            "version": "latest"
          },
          "osProfile": {
            "adminUsername": "sapadmin"
          }
        },
        "instanceCount": 2
      },
      "databaseServer": {
        "subnetId": "/subscriptions/'$SUB_ID'/resourceGroups/'$RG_NETWORK'/providers/Microsoft.Network/virtualNetworks/vnet-sap-tutorial/subnets/sap-db-subnet",
        "databaseType": "HANA",
        "virtualMachineConfiguration": {
          "vmSize": "Standard_M64s",
          "imageReference": {
            "publisher": "SUSE",
            "offer": "sles-sap-15-sp5",
            "sku": "gen2",
            "version": "latest"
          },
          "osProfile": {
            "adminUsername": "sapadmin"
          }
        },
        "instanceCount": 1
      }
    }
  }'
```

### 3.3 Monitor deployment progress

```bash
# Check deployment status
az workloads sap-virtual-instance show \
  --resource-group $RG_SAP \
  --name S4H-TUT \
  --query "{status: status, provisioningState: provisioningState, health: health}"
```

---

## Step 4: Install SAP HANA

### 4.1 Prepare HANA installation media

```bash
# Connect to HANA VM via Azure Bastion
az network bastion ssh \
  --resource-group $RG_NETWORK \
  --name bastion-sap-tutorial \
  --target-resource-id /subscriptions/$SUB_ID/resourceGroups/$RG_SAP-infra/providers/Microsoft.Compute/virtualMachines/vm-hana-01 \
  --auth-type ssh-key \
  --username sapadmin \
  --ssh-key ~/.ssh/id_rsa

# Mount ANF volumes
sudo mkdir -p /hana/data /hana/log /hana/shared
sudo mount -t nfs -o rw,vers=4,minorversion=1,hard,timeo=600,rsize=262144,wsize=262144 \
  10.10.3.4:/hana-data /hana/data
sudo mount -t nfs -o rw,vers=4,minorversion=1,hard,timeo=600,rsize=262144,wsize=262144 \
  10.10.3.5:/hana-log /hana/log
sudo mount -t nfs -o rw,vers=4,minorversion=1,hard,timeo=600,rsize=262144,wsize=262144 \
  10.10.3.6:/hana-shared /hana/shared

# Add to /etc/fstab for persistence
echo "10.10.3.4:/hana-data /hana/data nfs rw,vers=4.1,hard,timeo=600,rsize=262144,wsize=262144 0 0" | sudo tee -a /etc/fstab
echo "10.10.3.5:/hana-log  /hana/log  nfs rw,vers=4.1,hard,timeo=600,rsize=262144,wsize=262144 0 0" | sudo tee -a /etc/fstab
echo "10.10.3.6:/hana-shared /hana/shared nfs rw,vers=4.1,hard,timeo=600,rsize=262144,wsize=262144 0 0" | sudo tee -a /etc/fstab
```

### 4.2 Run HANA installation

```bash
# Extract HANA installation media
cd /hana/shared/install
tar -xvf IMDB_SERVER*.SAR

# Run hdblcm (HANA lifecycle manager)
sudo ./hdblcm \
  --action=install \
  --sid=S4H \
  --number=00 \
  --sapadm_password=<secure-password> \
  --system_user_password=<secure-password> \
  --datapath=/hana/data/S4H \
  --logpath=/hana/log/S4H \
  --components=server,client \
  --batch
```

### 4.3 Validate HANA installation

```sql
-- Connect to HANA and verify
-- hdbsql -U SYSTEM -d SYSTEMDB
SELECT VERSION, BUILD FROM M_DATABASE;
SELECT * FROM M_SERVICES;
SELECT HOST,
       ROUND(INSTANCE_TOTAL_MEMORY_USED_SIZE/1024/1024/1024, 2) AS USED_GB
FROM M_HOST_RESOURCE_UTILIZATION;
```

---

## Step 5: Configure high availability

### 5.1 Configure HANA System Replication

```bash
# On primary HANA node
hdbnsutil -sr_enable --name=site1

# On secondary HANA node (after HANA installation)
hdbnsutil -sr_register \
  --remoteHost=vm-hana-01 \
  --remoteInstance=00 \
  --replicationMode=syncmem \
  --operationMode=logreplay_readaccess \
  --name=site2

# Verify replication status
python /usr/sap/S4H/HDB00/exe/python_support/systemReplicationStatus.py
```

### 5.2 Configure Azure Load Balancer for HANA

```bash
# Create internal load balancer for HANA
az network lb create \
  --resource-group $RG_SAP \
  --name lb-hana-s4h \
  --sku Standard \
  --frontend-ip-name fe-hana \
  --vnet-name vnet-sap-tutorial \
  --subnet sap-db-subnet \
  --private-ip-address 10.10.1.10 \
  --backend-pool-name bp-hana

# Create health probe
az network lb probe create \
  --resource-group $RG_SAP \
  --lb-name lb-hana-s4h \
  --name probe-hana-62503 \
  --protocol TCP \
  --port 62503

# Create load balancing rule (HA ports)
az network lb rule create \
  --resource-group $RG_SAP \
  --lb-name lb-hana-s4h \
  --name rule-hana-ha \
  --frontend-ip-name fe-hana \
  --backend-pool-name bp-hana \
  --probe-name probe-hana-62503 \
  --protocol All \
  --frontend-port 0 \
  --backend-port 0 \
  --enable-floating-ip true \
  --idle-timeout 30
```

---

## Step 6: Install SAP S/4HANA

```bash
# Run SWPM (SAP Software Provisioning Manager)
cd /sapmnt/install/SWPM
./sapinst \
  SAPINST_USE_HOSTNAME=vm-app-01 \
  SAPINST_EXECUTE_PRODUCT_ID=NW_ABAP_OneHost:S4HANA2023.CORE.HDB.ABAP \
  SAPINST_INPUT_PARAMETERS_URL=inifile.params
```

---

## Step 7: Connect to CSA-in-a-Box

After S/4HANA is running, configure CSA-in-a-Box integration:

1. **Peer VNets** --- Peer the SAP VNet with the CSA-in-a-Box data landing zone VNet
2. **Configure Fabric Mirroring** --- See [Tutorial: SAP Data to Fabric](tutorial-sap-data-to-fabric.md)
3. **Set up Azure Monitor for SAP** --- Enable ACSS monitoring for HANA and NetWeaver metrics
4. **Configure Purview scanning** --- Scan SAP HANA metadata for data governance

```bash
# Peer SAP VNet with CSA-in-a-Box VNet
az network vnet peering create \
  --resource-group $RG_NETWORK \
  --name sap-to-csa \
  --vnet-name vnet-sap-tutorial \
  --remote-vnet /subscriptions/$SUB_ID/resourceGroups/rg-csa-inabox/providers/Microsoft.Network/virtualNetworks/vnet-csa-data \
  --allow-vnet-access true \
  --allow-forwarded-traffic true
```

---

## Cleanup

```bash
# Delete all tutorial resources when done
az group delete --name $RG_SAP --yes --no-wait
az group delete --name $RG_NETWORK --yes --no-wait
```

---

**Last updated:** 2026-04-30
**Maintainers:** CSA-in-a-Box core team
**Related:** [Infrastructure Migration](infrastructure-migration.md) | [HANA Migration](hana-migration.md) | [Tutorial: SAP Data to Fabric](tutorial-sap-data-to-fabric.md)
