// CSA Loom — UAT jumpbox VM
// Ubuntu 24.04 LTS in the workloads subnet with Playwright + Chromium
// pre-installed. Bastion-accessible. Used for end-to-end UI testing
// of the VNet-internal Loom Console.
//
// Tear down with: az group delete -n rg-csa-loom-jumpbox-eastus2 --yes

targetScope = 'resourceGroup'

@description('Location')
param location string = 'eastus2'

@description('VNet name that the jumpbox subnet lives in')
param vnetName string

@description('VNet RG name (typically DLZ RG)')
param vnetRgName string

@description('Subnet name (snet-workloads in DLZ spoke)')
param subnetName string = 'snet-workloads'

@description('Admin Entra group object ID for jumpbox AAD SSH login')
param adminEntraGroupId string

@description('Compliance tags')
param complianceTags object = {
  'csa-loom': 'uat-jumpbox'
  'lifecycle': 'ephemeral'
}

var vmName = 'loom-uat-jumpbox'

resource nic 'Microsoft.Network/networkInterfaces@2024-05-01' = {
  name: 'nic-${vmName}'
  location: location
  tags: complianceTags
  properties: {
    ipConfigurations: [
      {
        name: 'ipconfig'
        properties: {
          subnet: {
            id: resourceId(vnetRgName, 'Microsoft.Network/virtualNetworks/subnets', vnetName, subnetName)
          }
          privateIPAllocationMethod: 'Dynamic'
        }
      }
    ]
  }
}

resource vm 'Microsoft.Compute/virtualMachines@2024-11-01' = {
  name: vmName
  location: location
  tags: complianceTags
  identity: { type: 'SystemAssigned' }
  properties: {
    hardwareProfile: { vmSize: 'Standard_D2ads_v5' }
    storageProfile: {
      osDisk: {
        createOption: 'FromImage'
        managedDisk: { storageAccountType: 'StandardSSD_LRS' }
        diskSizeGB: 64
      }
      imageReference: {
        publisher: 'Canonical'
        offer: 'ubuntu-24_04-lts'
        sku: 'server'
        version: 'latest'
      }
    }
    osProfile: {
      computerName: vmName
      adminUsername: 'loomops'
      // Random unused password — AAD-SSH extension is the real auth path
      adminPassword: 'P@ssw0rd-${uniqueString(resourceGroup().id, deployment().name)}!aA1'
      linuxConfiguration: {
        disablePasswordAuthentication: false
      }
    }
    networkProfile: {
      networkInterfaces: [
        { id: nic.id }
      ]
    }
    securityProfile: {
      securityType: 'TrustedLaunch'
      uefiSettings: {
        secureBootEnabled: true
        vTpmEnabled: true
      }
    }
  }
}

// Install Playwright + Chromium via custom-script extension
resource cse 'Microsoft.Compute/virtualMachines/extensions@2024-11-01' = {
  parent: vm
  name: 'install-playwright'
  location: location
  properties: {
    publisher: 'Microsoft.Azure.Extensions'
    type: 'CustomScript'
    typeHandlerVersion: '2.1'
    autoUpgradeMinorVersion: true
    settings: {
      // Install Node 20 + pnpm + Playwright + Chromium deps
      // (commandToExecute runs as root)
      commandToExecute: 'apt-get update && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt-get install -y nodejs && npm install -g pnpm@9 playwright && npx playwright install --with-deps chromium && echo "PLAYWRIGHT_READY=$(date -u +%Y%m%dT%H%M%S)" >> /etc/loom-uat.env'
    }
  }
}

// AAD SSH extension — enables `az ssh vm` with Entra creds
resource aadssh 'Microsoft.Compute/virtualMachines/extensions@2024-11-01' = {
  parent: vm
  name: 'AADSSHLoginForLinux'
  location: location
  properties: {
    publisher: 'Microsoft.Azure.ActiveDirectory'
    type: 'AADSSHLoginForLinux'
    typeHandlerVersion: '1.0'
    autoUpgradeMinorVersion: true
  }
}

// Grant admin group VM Administrator Login role
var vmAdminLoginRoleId = '1c0163c0-47e6-4577-8991-ea5c82e286e4'

resource aadRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(adminEntraGroupId)) {
  scope: vm
  name: guid(vm.id, adminEntraGroupId, vmAdminLoginRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', vmAdminLoginRoleId)
    principalId: adminEntraGroupId
    principalType: 'Group'
  }
}

output vmId string = vm.id
output vmName string = vm.name
output privateIp string = nic.properties.ipConfigurations[0].properties.privateIPAddress
output ssh string = 'az network bastion ssh --name bastion-csa-loom-${location} --resource-group rg-csa-loom-admin-${location} --target-resource-id ${vm.id} --auth-type AAD'
