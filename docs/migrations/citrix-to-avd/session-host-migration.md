# Session Host Migration: Citrix VDA to AVD

**Audience:** VDI Engineers, Desktop Administrators, Platform Engineers
**Scope:** Converting Citrix VDA-based session hosts to AVD session hosts, including image preparation, host pool configuration, scaling plans, and deployment automation.
**Last updated:** 2026-04-30

---

## Overview

The session host is the core compute unit in both Citrix and AVD. In Citrix, session hosts run the Virtual Delivery Agent (VDA) and are organized into Machine Catalogs and Delivery Groups. In AVD, session hosts run the AVD agent and boot loader, and are organized into host pools and application groups.

The migration requires:

1. Building a new golden image (remove VDA, install AVD agent)
2. Creating AVD host pools with appropriate configuration
3. Deploying session hosts from the new image
4. Configuring scaling plans for cost optimization
5. Assigning users through application groups

---

## 1. Image preparation

### 1.1 Start from your existing Citrix golden image

Your current Citrix golden image already has the applications, configurations, and optimizations your users need. The migration process modifies this image rather than building from scratch.

**Prerequisites:**

- A copy of your current Citrix golden image (MCS master image or PVS vDisk)
- If using PVS, convert the vDisk to a VHDx and create a VM from it in Azure
- If using MCS, create a snapshot of the master image VM

### 1.2 Remove Citrix components

Boot the image VM and remove Citrix software in this order:

```powershell
# 1. Stop Citrix services
Stop-Service -Name "BrokerAgent" -Force -ErrorAction SilentlyContinue
Stop-Service -Name "CdfSvc" -Force -ErrorAction SilentlyContinue
Stop-Service -Name "CtxProfile" -Force -ErrorAction SilentlyContinue
Stop-Service -Name "Citrix*" -Force -ErrorAction SilentlyContinue

# 2. Uninstall Citrix VDA
# Use the VDA installer in remove mode
$vdaInstaller = "C:\Temp\VDAServerSetup_2402.exe"  # adjust version
Start-Process -FilePath $vdaInstaller -ArgumentList "/remove /quiet /noreboot" -Wait

# 3. Remove Citrix UPM if installed separately
$upm = Get-WmiObject -Class Win32_Product | Where-Object { $_.Name -like "*Citrix Profile*" }
if ($upm) { $upm.Uninstall() }

# 4. Remove Citrix Workspace Environment Management agent
$wem = Get-WmiObject -Class Win32_Product | Where-Object { $_.Name -like "*Citrix WEM*" }
if ($wem) { $wem.Uninstall() }

# 5. Clean up Citrix registry keys
Remove-Item -Path "HKLM:\SOFTWARE\Citrix" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -Path "HKLM:\SOFTWARE\WOW6432Node\Citrix" -Recurse -Force -ErrorAction SilentlyContinue

# 6. Remove Citrix directories
Remove-Item -Path "C:\Program Files\Citrix" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -Path "C:\Program Files (x86)\Citrix" -Recurse -Force -ErrorAction SilentlyContinue

# 7. Reboot
Restart-Computer -Force
```

### 1.3 Install AVD agent and boot loader

After removing Citrix components:

```powershell
# Download AVD agent and boot loader
$agentUrl = "https://query.prod.cms.rt.microsoft.com/cms/api/am/binary/RWrmXv"
$bootLoaderUrl = "https://query.prod.cms.rt.microsoft.com/cms/api/am/binary/RWrxrH"

Invoke-WebRequest -Uri $agentUrl -OutFile "C:\Temp\Microsoft.RDInfra.RDAgent.Installer-x64.msi"
Invoke-WebRequest -Uri $bootLoaderUrl -OutFile "C:\Temp\Microsoft.RDInfra.RDAgentBootLoader.Installer-x64.msi"

# Install boot loader first
msiexec /i "C:\Temp\Microsoft.RDInfra.RDAgentBootLoader.Installer-x64.msi" /quiet /norestart

# Install AVD agent with registration token
# Get token from: az desktopvirtualization hostpool retrieve-registration-token
$token = "eyJ0eXAiOi..."  # registration token from host pool
msiexec /i "C:\Temp\Microsoft.RDInfra.RDAgent.Installer-x64.msi" REGISTRATIONTOKEN=$token /quiet /norestart
```

### 1.4 Install FSLogix

```powershell
# Download FSLogix
$fslogixUrl = "https://aka.ms/fslogix_download"
Invoke-WebRequest -Uri $fslogixUrl -OutFile "C:\Temp\FSLogix.zip"
Expand-Archive -Path "C:\Temp\FSLogix.zip" -DestinationPath "C:\Temp\FSLogix"

# Install FSLogix Apps
Start-Process -FilePath "C:\Temp\FSLogix\x64\Release\FSLogixAppsSetup.exe" `
  -ArgumentList "/install /quiet /norestart" -Wait
```

### 1.5 Configure FSLogix via registry

```powershell
# FSLogix Profile Container settings
$fslogixKey = "HKLM:\SOFTWARE\FSLogix\Profiles"
New-Item -Path $fslogixKey -Force
Set-ItemProperty -Path $fslogixKey -Name "Enabled" -Value 1 -Type DWord
Set-ItemProperty -Path $fslogixKey -Name "VHDLocations" -Value "\\storageaccount.file.core.windows.net\profiles" -Type String
Set-ItemProperty -Path $fslogixKey -Name "DeleteLocalProfileWhenVHDShouldApply" -Value 1 -Type DWord
Set-ItemProperty -Path $fslogixKey -Name "FlipFlopProfileDirectoryName" -Value 1 -Type DWord
Set-ItemProperty -Path $fslogixKey -Name "SizeInMBs" -Value 30000 -Type DWord
Set-ItemProperty -Path $fslogixKey -Name "VolumeType" -Value "VHDX" -Type String
Set-ItemProperty -Path $fslogixKey -Name "IsDynamic" -Value 1 -Type DWord

# FSLogix Office Container (recommended for Outlook/Teams/OneDrive)
$officeKey = "HKLM:\SOFTWARE\Policies\FSLogix\ODFC"
New-Item -Path $officeKey -Force
Set-ItemProperty -Path $officeKey -Name "Enabled" -Value 1 -Type DWord
Set-ItemProperty -Path $officeKey -Name "VHDLocations" -Value "\\storageaccount.file.core.windows.net\odfc" -Type String
Set-ItemProperty -Path $officeKey -Name "VolumeType" -Value "VHDX" -Type String
Set-ItemProperty -Path $officeKey -Name "IsDynamic" -Value 1 -Type DWord
```

### 1.6 OS optimization

Apply the Virtual Desktop Optimization Tool (VDOT) for multi-session performance:

```powershell
# Download and run VDOT
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope Process -Force
$vdotUrl = "https://github.com/The-Virtual-Desktop-Team/Virtual-Desktop-Optimization-Tool/archive/refs/heads/main.zip"
Invoke-WebRequest -Uri $vdotUrl -OutFile "C:\Temp\VDOT.zip"
Expand-Archive -Path "C:\Temp\VDOT.zip" -DestinationPath "C:\Temp\VDOT"
Set-Location "C:\Temp\VDOT\Virtual-Desktop-Optimization-Tool-main"

# Run optimization for multi-session
.\Windows_VDOT.ps1 -Optimizations All -AcceptEULA
```

### 1.7 CSA-in-a-Box data analyst image additions

For data analyst session hosts accessing CSA-in-a-Box services, add:

```powershell
# Install Power BI Desktop (per-machine)
winget install --id Microsoft.PowerBI --scope machine --silent

# Install Azure Data Studio
winget install --id Microsoft.AzureDataStudio --scope machine --silent

# Install VS Code with data extensions
winget install --id Microsoft.VisualStudioCode --scope machine --silent

# Install Azure CLI
winget install --id Microsoft.AzureCLI --scope machine --silent

# Install Python (for data science)
winget install --id Python.Python.3.12 --scope machine --silent

# Install Azure Storage Explorer
winget install --id Microsoft.AzureStorageExplorer --scope machine --silent
```

### 1.8 Sysprep and capture

```powershell
# Generalize the image
C:\Windows\System32\Sysprep\sysprep.exe /generalize /oobe /shutdown /mode:vm
```

After shutdown, capture the image to Azure Compute Gallery:

```bash
# Create gallery image definition
az sig image-definition create \
  --gallery-name galAVDImages \
  --resource-group rg-avd-images \
  --gallery-image-definition win11-multisession-analytics \
  --publisher CSAInABox \
  --offer Windows11-AVD \
  --sku win11-24h2-avd-analytics \
  --os-type Windows \
  --os-state Generalized \
  --hyper-v-generation V2

# Create image version from VM disk
az sig image-version create \
  --gallery-name galAVDImages \
  --resource-group rg-avd-images \
  --gallery-image-definition win11-multisession-analytics \
  --gallery-image-version 1.0.0 \
  --managed-image /subscriptions/.../resourceGroups/.../providers/Microsoft.Compute/virtualMachines/vm-golden
```

---

## 2. Host pool configuration

### 2.1 Host pool types

| Citrix equivalent                              | AVD host pool type                             | Use case                                 |
| ---------------------------------------------- | ---------------------------------------------- | ---------------------------------------- |
| Pooled random Machine Catalog + Delivery Group | Pooled host pool (BreadthFirst or DepthFirst)  | Standard multi-session desktops          |
| Static persistent Machine Catalog              | Personal host pool                             | Persistent desktops with user assignment |
| Published app Delivery Group                   | Pooled host pool + RemoteApp application group | Application publishing                   |

### 2.2 Load balancing

| Algorithm         | Behavior                                  | When to use                               |
| ----------------- | ----------------------------------------- | ----------------------------------------- |
| **Breadth-first** | Distributes users evenly across all hosts | Default; best for predictable performance |
| **Depth-first**   | Fills each host before moving to the next | Best for cost optimization with autoscale |

### 2.3 Session limits

Configure maximum sessions per host based on VM size and workload:

| VM size               | vCPUs | RAM   | Recommended max sessions (knowledge worker) | Recommended max sessions (data analyst) |
| --------------------- | ----- | ----- | ------------------------------------------- | --------------------------------------- |
| D4s_v5                | 4     | 16 GB | 6--8                                        | 4--6                                    |
| D8s_v5                | 8     | 32 GB | 12--16                                      | 8--12                                   |
| D16s_v5               | 16    | 64 GB | 24--32                                      | 16--20                                  |
| D8s_v5 + ephemeral OS | 8     | 32 GB | 14--18                                      | 10--14                                  |

Data analyst workloads (Power BI, Python, Azure Data Studio) consume more memory per session.

### 2.4 Host pool deployment with Bicep

```bicep
// host-pool.bicep
param location string = resourceGroup().location
param hostPoolName string
param workspaceName string
param appGroupName string

resource hostPool 'Microsoft.DesktopVirtualization/hostPools@2024-04-08-preview' = {
  name: hostPoolName
  location: location
  properties: {
    hostPoolType: 'Pooled'
    loadBalancerType: 'BreadthFirst'
    maxSessionLimit: 14
    preferredAppGroupType: 'Desktop'
    startVMOnConnect: true
    validationEnvironment: false
    registrationInfo: {
      registrationTokenOperation: 'Update'
      expirationTime: dateTimeAdd(utcNow(), 'PT24H')
    }
  }
}

resource appGroup 'Microsoft.DesktopVirtualization/applicationGroups@2024-04-08-preview' = {
  name: appGroupName
  location: location
  properties: {
    hostPoolArmPath: hostPool.id
    applicationGroupType: 'Desktop'
    friendlyName: 'Analytics Desktop'
  }
}

resource workspace 'Microsoft.DesktopVirtualization/workspaces@2024-04-08-preview' = {
  name: workspaceName
  location: location
  properties: {
    applicationGroupReferences: [
      appGroup.id
    ]
    friendlyName: 'CSA-in-a-Box Analytics'
  }
}
```

---

## 3. Scaling plans

### 3.1 Mapping Citrix power management to AVD scaling plans

| Citrix concept                       | AVD equivalent                                             |
| ------------------------------------ | ---------------------------------------------------------- |
| Power management policy (peak hours) | Scaling plan schedule (ramp-up, peak, ramp-down, off-peak) |
| Peak hours buffer                    | Ramp-up minimum percentage of hosts                        |
| Off-hours disconnect/logoff          | Off-peak disconnect and log-off timers                     |
| Power-on delay                       | Ramp-up start time and capacity threshold                  |

### 3.2 Scaling plan configuration

```bash
az desktopvirtualization scaling-plan create \
  --name sp-analytics-weekday \
  --resource-group rg-avd-prod \
  --location eastus2 \
  --host-pool-type Pooled \
  --time-zone "Eastern Standard Time" \
  --schedules '[{
    "name": "weekday",
    "daysOfWeek": ["Monday","Tuesday","Wednesday","Thursday","Friday"],
    "rampUpStartTime": {"hour": 7, "minute": 0},
    "rampUpLoadBalancingAlgorithm": "BreadthFirst",
    "rampUpMinimumHostsPct": 25,
    "rampUpCapacityThresholdPct": 60,
    "peakStartTime": {"hour": 9, "minute": 0},
    "peakLoadBalancingAlgorithm": "BreadthFirst",
    "rampDownStartTime": {"hour": 17, "minute": 0},
    "rampDownLoadBalancingAlgorithm": "DepthFirst",
    "rampDownMinimumHostsPct": 10,
    "rampDownCapacityThresholdPct": 90,
    "rampDownForceLogoffUsers": false,
    "rampDownWaitTimeMinutes": 30,
    "rampDownNotificationMessage": "Your session will end in 30 minutes. Please save your work.",
    "offPeakStartTime": {"hour": 19, "minute": 0},
    "offPeakLoadBalancingAlgorithm": "DepthFirst"
  }]'
```

### 3.3 Scaling plan cost impact

| Scenario                | Always-on monthly cost | With scaling plan | Savings |
| ----------------------- | ---------------------- | ----------------- | ------- |
| 100 D8s_v5 VMs (1yr RI) | $28,000                | $16,800           | 40%     |
| 100 D8s_v5 VMs (PAYG)   | $46,000                | $27,600           | 40%     |

---

## 4. Multi-session vs personal desktops

### 4.1 When to use multi-session (pooled)

- Standard knowledge worker desktops
- Data analyst desktops (CSA-in-a-Box pattern)
- Task worker desktops
- Published applications (RemoteApp)
- Any workload where users do not need persistent VM assignment

### 4.2 When to use personal (persistent)

- Developer desktops with local Docker/WSL2
- Users who install custom software not in the golden image
- GPU workstations where users have persistent local state
- Compliance requirements mandating dedicated compute per user

### 4.3 Mapping from Citrix

| Citrix config                       | AVD config                                         |
| ----------------------------------- | -------------------------------------------------- |
| Pooled random, MCS, non-persistent  | Pooled host pool, multi-session, ephemeral OS disk |
| Pooled static, MCS, persistent disk | Personal host pool, auto-assignment                |
| Dedicated, PVS, persistent          | Personal host pool, direct-assignment              |

---

## 5. Session host deployment automation

### 5.1 Deploy session hosts with Bicep

```bicep
// session-hosts.bicep
param hostPoolName string
param sessionHostCount int = 10
param vmSize string = 'Standard_D8s_v5'
param imageReference object = {
  id: '/subscriptions/.../galleries/galAVDImages/images/win11-multisession-analytics/versions/1.0.0'
}

resource sessionHosts 'Microsoft.Compute/virtualMachines@2024-03-01' = [for i in range(0, sessionHostCount): {
  name: 'sh-analytics-${padLeft(i, 3, '0')}'
  location: resourceGroup().location
  properties: {
    hardwareProfile: { vmSize: vmSize }
    osProfile: {
      computerName: 'sh-ana-${padLeft(i, 3, '0')}'
      adminUsername: 'localadmin'
      adminPassword: 'USE-KEYVAULT-REFERENCE'  // use Key Vault reference in production
      windowsConfiguration: {
        provisionVMAgent: true
        enableAutomaticUpdates: false
        patchSettings: { patchMode: 'Manual' }
      }
    }
    storageProfile: {
      imageReference: imageReference
      osDisk: {
        createOption: 'FromImage'
        diffDiskSettings: { option: 'Local' }  // ephemeral OS disk
        caching: 'ReadOnly'
        managedDisk: { storageAccountType: 'Standard_LRS' }
      }
    }
    networkProfile: {
      networkInterfaces: [{ id: nic[i].id }]
    }
  }
}]
```

### 5.2 Domain join options

| Citrix approach              | AVD options                                           |
| ---------------------------- | ----------------------------------------------------- |
| Active Directory domain join | AD DS join (traditional -- same as Citrix)            |
| Active Directory domain join | Entra ID join (cloud-native, recommended)             |
| N/A                          | Entra ID join + Intune enrollment (modern management) |

For Entra ID join (recommended for new deployments):

```bicep
resource aadJoinExtension 'Microsoft.Compute/virtualMachines/extensions@2024-03-01' = [for i in range(0, sessionHostCount): {
  parent: sessionHosts[i]
  name: 'AADLoginForWindows'
  location: resourceGroup().location
  properties: {
    publisher: 'Microsoft.Azure.ActiveDirectory'
    type: 'AADLoginForWindows'
    typeHandlerVersion: '2.2'
    autoUpgradeMinorVersion: true
  }
}]
```

---

## 6. Validation checklist

After deploying session hosts:

- [ ] Session hosts appear as "Available" in the host pool
- [ ] Users can connect via Windows client, web client, and mobile client
- [ ] FSLogix profiles mount correctly (check Event Viewer: Applications and Services Logs > FSLogix)
- [ ] Applications launch correctly within sessions
- [ ] Multi-monitor and display scaling work as expected
- [ ] Printing (Universal Print or redirected printers) functional
- [ ] Teams media optimization active (check Teams > Settings > About > "AVD Media Optimized")
- [ ] Scaling plan activates on schedule (VMs power on/off correctly)
- [ ] Azure Monitor diagnostics flowing to Log Analytics
- [ ] Conditional Access policies enforcing (MFA, device compliance)

---

## 7. Rollback plan

If issues are discovered post-migration:

1. **Keep Citrix infrastructure running** during pilot and wave migration (parallel operation)
2. **Citrix VDA image remains available** in the image gallery for quick redeployment
3. **User assignments** can be reverted by removing users from AVD application groups and re-enabling Citrix Delivery Group access
4. **FSLogix profiles** are additive; Citrix UPM profiles remain on the original file shares
5. **DNS/access** can be switched back to StoreFront within minutes

Plan for a minimum 30-day parallel operation period before decommissioning any Citrix infrastructure.

---

**Maintainers:** CSA-in-a-Box core team
**Last updated:** 2026-04-30
