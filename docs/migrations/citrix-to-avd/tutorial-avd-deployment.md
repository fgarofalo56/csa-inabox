# Tutorial: Deploy Azure Virtual Desktop from Scratch

**Audience:** VDI Engineers, Platform Engineers, Cloud Architects
**Duration:** 2--3 hours
**Prerequisites:** Azure subscription with Contributor role, Microsoft 365 E3/E5 license, Entra ID with at least P1
**Last updated:** 2026-04-30

---

## What you will build

This tutorial walks through deploying a complete AVD environment from scratch:

1. Networking (VNet, subnets, NSG)
2. Storage for FSLogix profiles (Azure Files Premium)
3. Host pool with scaling plan
4. Session hosts from gallery image (Windows 11 multi-session)
5. Desktop and RemoteApp application groups
6. FSLogix profile container configuration
7. User assignment and connection test

By the end, you will have a working AVD deployment that users can connect to.

---

## Step 1: Create the resource group and networking

### 1.1 Resource group

```bash
az group create \
  --name rg-avd-tutorial \
  --location eastus2
```

### 1.2 Virtual network and subnets

```bash
# Create VNet
az network vnet create \
  --name vnet-avd-tutorial \
  --resource-group rg-avd-tutorial \
  --location eastus2 \
  --address-prefix 10.100.0.0/16

# Session host subnet
az network vnet subnet create \
  --name snet-sessionhosts \
  --resource-group rg-avd-tutorial \
  --vnet-name vnet-avd-tutorial \
  --address-prefix 10.100.1.0/24

# Private endpoints subnet
az network vnet subnet create \
  --name snet-privateendpoints \
  --resource-group rg-avd-tutorial \
  --vnet-name vnet-avd-tutorial \
  --address-prefix 10.100.2.0/24 \
  --disable-private-endpoint-network-policies true
```

### 1.3 Network security group

```bash
# Create NSG for session hosts
az network nsg create \
  --name nsg-avd-sessionhosts \
  --resource-group rg-avd-tutorial \
  --location eastus2

# Allow outbound to AVD service
az network nsg rule create \
  --nsg-name nsg-avd-sessionhosts \
  --resource-group rg-avd-tutorial \
  --name AllowAVDOutbound \
  --priority 100 \
  --direction Outbound \
  --access Allow \
  --protocol Tcp \
  --destination-port-ranges 443 \
  --destination-address-prefixes WindowsVirtualDesktop AzureMonitor AzureActiveDirectory

# Allow outbound to Azure KMS
az network nsg rule create \
  --nsg-name nsg-avd-sessionhosts \
  --resource-group rg-avd-tutorial \
  --name AllowKMS \
  --priority 110 \
  --direction Outbound \
  --access Allow \
  --protocol Tcp \
  --destination-port-ranges 1688 \
  --destination-address-prefixes "20.118.99.224" "40.83.235.53"

# Associate NSG with subnet
az network vnet subnet update \
  --name snet-sessionhosts \
  --resource-group rg-avd-tutorial \
  --vnet-name vnet-avd-tutorial \
  --network-security-group nsg-avd-sessionhosts
```

---

## Step 2: Create storage for FSLogix profiles

### 2.1 Storage account

```bash
# Create Premium FileStorage account
az storage account create \
  --name stavdtutorialprofiles \
  --resource-group rg-avd-tutorial \
  --location eastus2 \
  --sku Premium_LRS \
  --kind FileStorage \
  --enable-large-file-share \
  --default-action Deny

# Create profile share
az storage share-rm create \
  --name profiles \
  --storage-account stavdtutorialprofiles \
  --enabled-protocol SMB \
  --quota 256
```

### 2.2 Enable Entra ID Kerberos authentication

```bash
# Enable Entra Kerberos for Azure Files
az storage account update \
  --name stavdtutorialprofiles \
  --resource-group rg-avd-tutorial \
  --enable-files-aadkerb true
```

### 2.3 Create private endpoint for storage

```bash
az network private-endpoint create \
  --name pe-avd-profiles \
  --resource-group rg-avd-tutorial \
  --vnet-name vnet-avd-tutorial \
  --subnet snet-privateendpoints \
  --private-connection-resource-id $(az storage account show --name stavdtutorialprofiles --resource-group rg-avd-tutorial --query id -o tsv) \
  --group-id file \
  --connection-name pec-avd-profiles

# Create private DNS zone
az network private-dns zone create \
  --name "privatelink.file.core.windows.net" \
  --resource-group rg-avd-tutorial

az network private-dns link vnet create \
  --name link-storage \
  --resource-group rg-avd-tutorial \
  --zone-name "privatelink.file.core.windows.net" \
  --virtual-network vnet-avd-tutorial \
  --registration-enabled false

# Create DNS record
az network private-endpoint dns-zone-group create \
  --endpoint-name pe-avd-profiles \
  --resource-group rg-avd-tutorial \
  --name filesZoneGroup \
  --private-dns-zone "privatelink.file.core.windows.net" \
  --zone-name "privatelink.file.core.windows.net"
```

### 2.4 Assign RBAC for profile access

```bash
# Get the user group that will use AVD
# Replace with your Entra ID group object ID
USER_GROUP_ID="<your-entra-group-object-id>"

# Storage File Data SMB Share Contributor
az role assignment create \
  --role "Storage File Data SMB Share Contributor" \
  --assignee-object-id $USER_GROUP_ID \
  --assignee-principal-type Group \
  --scope $(az storage account show --name stavdtutorialprofiles --resource-group rg-avd-tutorial --query id -o tsv)
```

---

## Step 3: Create the host pool

### 3.1 Host pool

```bash
az desktopvirtualization hostpool create \
  --name hp-tutorial \
  --resource-group rg-avd-tutorial \
  --location eastus2 \
  --host-pool-type Pooled \
  --load-balancer-type BreadthFirst \
  --max-session-limit 12 \
  --preferred-app-group-type Desktop \
  --start-vm-on-connect true \
  --validation-environment false \
  --custom-rdp-property "audiocapturemode:i:1;audiomode:i:0;camerastoredirect:s:*;devicestoredirect:s:*;drivestoredirect:s:;redirectclipboard:i:1;redirectprinters:i:1;screen mode id:i:2;use multimon:i:1;enablerdsaadauth:i:1"
```

### 3.2 Get registration token

```bash
# Generate registration token (valid 24 hours)
TOKEN=$(az desktopvirtualization hostpool retrieve-registration-token \
  --name hp-tutorial \
  --resource-group rg-avd-tutorial \
  --query token -o tsv)

echo "Registration token: $TOKEN"
# Save this token -- you need it for session host deployment
```

### 3.3 Desktop application group

```bash
# Create desktop application group
az desktopvirtualization applicationgroup create \
  --name dag-tutorial-desktop \
  --resource-group rg-avd-tutorial \
  --location eastus2 \
  --host-pool-id $(az desktopvirtualization hostpool show --name hp-tutorial --resource-group rg-avd-tutorial --query id -o tsv) \
  --application-group-type Desktop \
  --friendly-name "Tutorial Desktop"
```

### 3.4 RemoteApp application group

```bash
# Create RemoteApp application group
az desktopvirtualization applicationgroup create \
  --name ag-tutorial-apps \
  --resource-group rg-avd-tutorial \
  --location eastus2 \
  --host-pool-id $(az desktopvirtualization hostpool show --name hp-tutorial --resource-group rg-avd-tutorial --query id -o tsv) \
  --application-group-type RemoteApp \
  --friendly-name "Tutorial Apps"

# Add Notepad as a sample RemoteApp
az desktopvirtualization application create \
  --name notepad \
  --application-group-name ag-tutorial-apps \
  --resource-group rg-avd-tutorial \
  --file-path "C:\Windows\System32\notepad.exe" \
  --friendly-name "Notepad" \
  --icon-path "C:\Windows\System32\notepad.exe" \
  --icon-index 0 \
  --show-in-portal true \
  --command-line-setting DoNotAllow

# Add Calculator as a sample RemoteApp
az desktopvirtualization application create \
  --name calculator \
  --application-group-name ag-tutorial-apps \
  --resource-group rg-avd-tutorial \
  --file-path "C:\Windows\System32\calc.exe" \
  --friendly-name "Calculator" \
  --show-in-portal true \
  --command-line-setting DoNotAllow
```

### 3.5 Workspace

```bash
az desktopvirtualization workspace create \
  --name ws-tutorial \
  --resource-group rg-avd-tutorial \
  --location eastus2 \
  --friendly-name "Tutorial Workspace" \
  --application-group-references \
    $(az desktopvirtualization applicationgroup show --name dag-tutorial-desktop --resource-group rg-avd-tutorial --query id -o tsv) \
    $(az desktopvirtualization applicationgroup show --name ag-tutorial-apps --resource-group rg-avd-tutorial --query id -o tsv)
```

---

## Step 4: Deploy session hosts

### 4.1 Deploy with Bicep

Create `session-hosts.bicep`:

```bicep
param location string = resourceGroup().location
param hostPoolName string = 'hp-tutorial'
param sessionHostCount int = 2
param vmSize string = 'Standard_D4s_v5'
param subnetId string
param registrationToken string

@secure()
param adminPassword string

var vmPrefix = 'sh-tut'

resource nics 'Microsoft.Network/networkInterfaces@2024-01-01' = [for i in range(0, sessionHostCount): {
  name: '${vmPrefix}-${padLeft(i, 2, '0')}-nic'
  location: location
  properties: {
    ipConfigurations: [
      {
        name: 'ipconfig1'
        properties: {
          privateIPAllocationMethod: 'Dynamic'
          subnet: { id: subnetId }
        }
      }
    ]
  }
}]

resource vms 'Microsoft.Compute/virtualMachines@2024-03-01' = [for i in range(0, sessionHostCount): {
  name: '${vmPrefix}-${padLeft(i, 2, '0')}'
  location: location
  identity: { type: 'SystemAssigned' }
  properties: {
    hardwareProfile: { vmSize: vmSize }
    osProfile: {
      computerName: '${vmPrefix}${padLeft(i, 2, '0')}'
      adminUsername: 'localadmin'
      adminPassword: adminPassword
      windowsConfiguration: {
        provisionVMAgent: true
        enableAutomaticUpdates: false
      }
    }
    storageProfile: {
      imageReference: {
        publisher: 'MicrosoftWindowsDesktop'
        offer: 'windows-11'
        sku: 'win11-24h2-avd'
        version: 'latest'
      }
      osDisk: {
        createOption: 'FromImage'
        managedDisk: { storageAccountType: 'Premium_LRS' }
        diskSizeGB: 128
      }
    }
    networkProfile: {
      networkInterfaces: [{ id: nics[i].id }]
    }
    licenseType: 'Windows_Client'
  }
}]

// Entra ID join
resource aadJoin 'Microsoft.Compute/virtualMachines/extensions@2024-03-01' = [for i in range(0, sessionHostCount): {
  parent: vms[i]
  name: 'AADLoginForWindows'
  location: location
  properties: {
    publisher: 'Microsoft.Azure.ActiveDirectory'
    type: 'AADLoginForWindows'
    typeHandlerVersion: '2.2'
    autoUpgradeMinorVersion: true
    settings: { mdmId: '0000000a-0000-0000-c000-000000000000' }  // Intune MDM
  }
}]

// AVD agent
resource avdAgent 'Microsoft.Compute/virtualMachines/extensions@2024-03-01' = [for i in range(0, sessionHostCount): {
  parent: vms[i]
  name: 'AVDAgent'
  location: location
  dependsOn: [aadJoin[i]]
  properties: {
    publisher: 'Microsoft.Compute'
    type: 'CustomScriptExtension'
    typeHandlerVersion: '1.10'
    autoUpgradeMinorVersion: true
    settings: {
      fileUris: [
        'https://raw.githubusercontent.com/Azure/RDS-Templates/master/ARM-wvd-templates/DSC/Configuration.zip'
      ]
    }
    protectedSettings: {
      commandToExecute: 'powershell -ExecutionPolicy Bypass -Command "& {Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory(\'Configuration.zip\', \'.\'); .\\Configuration.ps1 -RegistrationToken \'${registrationToken}\' }"'
    }
  }
}]
```

Deploy:

```bash
az deployment group create \
  --resource-group rg-avd-tutorial \
  --template-file session-hosts.bicep \
  --parameters \
    subnetId=$(az network vnet subnet show --name snet-sessionhosts --vnet-name vnet-avd-tutorial --resource-group rg-avd-tutorial --query id -o tsv) \
    registrationToken=$TOKEN \
    adminPassword='<secure-password>'
```

---

## Step 5: Configure FSLogix on session hosts

### 5.1 Apply FSLogix configuration via Custom Script Extension

```powershell
# Run on each session host (via Custom Script Extension or Intune)

# FSLogix Profile Container
$profilesKey = "HKLM:\SOFTWARE\FSLogix\Profiles"
New-Item -Path $profilesKey -Force
Set-ItemProperty -Path $profilesKey -Name "Enabled" -Value 1 -Type DWord
Set-ItemProperty -Path $profilesKey -Name "VHDLocations" -Value "\\stavdtutorialprofiles.file.core.windows.net\profiles" -Type String
Set-ItemProperty -Path $profilesKey -Name "DeleteLocalProfileWhenVHDShouldApply" -Value 1 -Type DWord
Set-ItemProperty -Path $profilesKey -Name "FlipFlopProfileDirectoryName" -Value 1 -Type DWord
Set-ItemProperty -Path $profilesKey -Name "SizeInMBs" -Value 30000 -Type DWord
Set-ItemProperty -Path $profilesKey -Name "VolumeType" -Value "VHDX" -Type String
Set-ItemProperty -Path $profilesKey -Name "IsDynamic" -Value 1 -Type DWord

Write-Host "FSLogix configured successfully"
```

---

## Step 6: Assign users

```bash
# Assign users to desktop application group
az role assignment create \
  --role "Desktop Virtualization User" \
  --assignee-object-id $USER_GROUP_ID \
  --assignee-principal-type Group \
  --scope $(az desktopvirtualization applicationgroup show --name dag-tutorial-desktop --resource-group rg-avd-tutorial --query id -o tsv)

# Assign users to RemoteApp application group
az role assignment create \
  --role "Desktop Virtualization User" \
  --assignee-object-id $USER_GROUP_ID \
  --assignee-principal-type Group \
  --scope $(az desktopvirtualization applicationgroup show --name ag-tutorial-apps --resource-group rg-avd-tutorial --query id -o tsv)

# For Entra ID joined hosts, also assign Virtual Machine User Login
az role assignment create \
  --role "Virtual Machine User Login" \
  --assignee-object-id $USER_GROUP_ID \
  --assignee-principal-type Group \
  --scope $(az group show --name rg-avd-tutorial --query id -o tsv)
```

---

## Step 7: Test user connection

### 7.1 Windows client

1. Download the **Remote Desktop** client from [Microsoft](https://aka.ms/AVDclient)
2. Launch the client and click **Subscribe**
3. Sign in with an Entra ID account from the assigned group
4. The workspace "Tutorial Workspace" appears with the desktop and RemoteApp applications
5. Double-click the desktop to connect
6. Verify:
    - Desktop loads with Windows 11 interface
    - FSLogix profile mounts (check `C:\Users\<username>` exists)
    - RemoteApp applications (Notepad, Calculator) launch in seamless windows

### 7.2 Web client

1. Navigate to [https://client.wvd.microsoft.com/arm/webclient](https://client.wvd.microsoft.com/arm/webclient)
2. Sign in with Entra ID credentials
3. Click the desktop or RemoteApp icon to connect
4. Verify same functionality as Windows client

### 7.3 Verify FSLogix

In the AVD session, open PowerShell:

```powershell
# Check FSLogix status
& "C:\Program Files\FSLogix\Apps\frx.exe" list

# Check profile VHDx location
Get-ChildItem "\\stavdtutorialprofiles.file.core.windows.net\profiles"
```

---

## Step 8: Configure scaling plan

```bash
az desktopvirtualization scaling-plan create \
  --name sp-tutorial \
  --resource-group rg-avd-tutorial \
  --location eastus2 \
  --host-pool-type Pooled \
  --time-zone "Eastern Standard Time" \
  --host-pool-references '[{"hostPoolArmPath": "/subscriptions/.../hostPools/hp-tutorial", "scalingPlanEnabled": true}]' \
  --schedules '[{
    "name": "weekday",
    "daysOfWeek": ["Monday","Tuesday","Wednesday","Thursday","Friday"],
    "rampUpStartTime": {"hour": 7, "minute": 0},
    "rampUpLoadBalancingAlgorithm": "BreadthFirst",
    "rampUpMinimumHostsPct": 50,
    "rampUpCapacityThresholdPct": 60,
    "peakStartTime": {"hour": 9, "minute": 0},
    "peakLoadBalancingAlgorithm": "BreadthFirst",
    "rampDownStartTime": {"hour": 17, "minute": 0},
    "rampDownLoadBalancingAlgorithm": "DepthFirst",
    "rampDownMinimumHostsPct": 0,
    "rampDownCapacityThresholdPct": 90,
    "rampDownForceLogoffUsers": false,
    "rampDownWaitTimeMinutes": 30,
    "rampDownNotificationMessage": "Your session will end in 30 minutes.",
    "offPeakStartTime": {"hour": 19, "minute": 0},
    "offPeakLoadBalancingAlgorithm": "DepthFirst"
  }]'
```

---

## Step 9: Enable monitoring

```bash
# Create Log Analytics workspace
az monitor log-analytics workspace create \
  --workspace-name law-avd-tutorial \
  --resource-group rg-avd-tutorial \
  --location eastus2

# Enable diagnostics on host pool
az monitor diagnostic-settings create \
  --name diag-hp-tutorial \
  --resource $(az desktopvirtualization hostpool show --name hp-tutorial --resource-group rg-avd-tutorial --query id -o tsv) \
  --workspace law-avd-tutorial \
  --logs '[
    {"category": "Checkpoint", "enabled": true},
    {"category": "Error", "enabled": true},
    {"category": "Management", "enabled": true},
    {"category": "Connection", "enabled": true},
    {"category": "HostRegistration", "enabled": true},
    {"category": "AgentHealthStatus", "enabled": true}
  ]'
```

---

## Cleanup

To remove all resources created in this tutorial:

```bash
az group delete --name rg-avd-tutorial --yes --no-wait
```

---

## Next steps

- [Profile Migration Tutorial](tutorial-profile-migration.md) -- migrate Citrix UPM profiles to FSLogix
- [Session Host Migration](session-host-migration.md) -- convert Citrix golden images for AVD
- [Best Practices](best-practices.md) -- production hardening and optimization

---

**Maintainers:** CSA-in-a-Box core team
**Last updated:** 2026-04-30
