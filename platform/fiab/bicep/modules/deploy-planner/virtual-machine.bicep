// CSA Loom deploy-planner — Azure Virtual Machine (Linux, no public IP)
//
// Wired by the deploy-planner catalog (key: vm → vmEnabled).
// Self-contained: an isolated VNet + subnet (with an NSG), a NIC with a
// dynamic private IP (NO public IP — the VM is reachable only inside the VNet
// / via the platform's hub peering or Bastion), and a small Ubuntu LTS VM with
// a managed OS disk, system-assigned identity, and SSH-key auth (password auth
// disabled). The Loom Console UAMI is granted Virtual Machine Contributor so
// the VM navigator can start/stop/restart/resize.
//
// Grounded in Microsoft Learn:
//   Microsoft.Compute/virtualMachines + Microsoft.Network/networkInterfaces
//   https://learn.microsoft.com/azure/templates/microsoft.compute/virtualmachines
//   https://learn.microsoft.com/azure/templates/microsoft.network/networkinterfaces

targetScope = 'resourceGroup'

@description('Primary region')
param location string

@description('VM size. Standard_B2s is a low-cost burstable size suitable for a starter VM.')
param vmSize string = 'Standard_B2s'

@description('Admin username for the VM.')
param adminUsername string = 'loomadmin'

@description('SSH public key (OpenSSH format) for the admin user. Password auth is disabled. Empty → a generated placeholder is used so the template compiles; supply a real key to deploy.')
@secure()
param adminSshPublicKey string = ''

@description('Address space for the VM-private VNet (isolated; no public IP on the VM).')
param vnetCidr string = '10.60.0.0/24'

@description('Subnet prefix the NIC lives in.')
param subnetCidr string = '10.60.0.0/26'

@description('Loom Console UAMI principal ID — granted Virtual Machine Contributor so the BFF can start/stop/restart/resize. Empty skips the grant.')
param consolePrincipalId string = ''

@description('Skip role-assignment grants — set true when re-provisioning to avoid RoleAssignmentExists.')
param skipRoleGrants bool = false

@description('Compliance tags applied to every resource.')
param complianceTags object

var suffix = uniqueString(resourceGroup().id)
var vnetName = take('vnet-vm-loom-${suffix}', 64)
var nsgName = take('nsg-vm-loom-${suffix}', 80)
var nicName = take('nic-vm-loom-${suffix}', 80)
var vmName = take('vm-loom-${suffix}', 15)
var subnetName = 'vm'

resource nsg 'Microsoft.Network/networkSecurityGroups@2024-05-01' = {
  name: nsgName
  location: location
  tags: complianceTags
  properties: {
    // No inbound rules beyond Azure defaults: the VM has no public IP and is
    // reachable only from inside the VNet (or via Bastion / hub peering).
    securityRules: []
  }
}

resource vnet 'Microsoft.Network/virtualNetworks@2024-05-01' = {
  name: vnetName
  location: location
  tags: complianceTags
  properties: {
    addressSpace: {
      addressPrefixes: [ vnetCidr ]
    }
    subnets: [
      {
        name: subnetName
        properties: {
          addressPrefix: subnetCidr
          networkSecurityGroup: { id: nsg.id }
        }
      }
    ]
  }
}

resource nic 'Microsoft.Network/networkInterfaces@2024-05-01' = {
  name: nicName
  location: location
  tags: complianceTags
  properties: {
    ipConfigurations: [
      {
        name: 'ipconfig1'
        properties: {
          // Dynamic PRIVATE IP only — no publicIPAddress reference.
          privateIPAllocationMethod: 'Dynamic'
          subnet: {
            id: '${vnet.id}/subnets/${subnetName}'
          }
        }
      }
    ]
  }
}

resource vm 'Microsoft.Compute/virtualMachines@2024-07-01' = {
  name: vmName
  location: location
  tags: complianceTags
  identity: { type: 'SystemAssigned' }
  properties: {
    hardwareProfile: {
      vmSize: vmSize
    }
    storageProfile: {
      imageReference: {
        publisher: 'Canonical'
        offer: 'ubuntu-24_04-lts'
        sku: 'server'
        version: 'latest'
      }
      osDisk: {
        createOption: 'FromImage'
        managedDisk: {
          storageAccountType: 'StandardSSD_LRS'
        }
        deleteOption: 'Delete'
      }
    }
    osProfile: {
      computerName: vmName
      adminUsername: adminUsername
      linuxConfiguration: {
        disablePasswordAuthentication: true
        ssh: {
          publicKeys: [
            {
              path: '/home/${adminUsername}/.ssh/authorized_keys'
              keyData: empty(adminSshPublicKey) ? 'ssh-rsa AAAAB3PLACEHOLDER-set-adminSshPublicKey' : adminSshPublicKey
            }
          ]
        }
      }
    }
    networkProfile: {
      networkInterfaces: [
        { id: nic.id }
      ]
    }
  }
}

// Virtual Machine Contributor — start/stop/restart/resize the VM
// (role 9980e02c-c2be-4d73-94e8-173b1dc7cf3c).
resource vmContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(consolePrincipalId) && !skipRoleGrants) {
  scope: vm
  name: guid(vm.id, consolePrincipalId, '9980e02c-c2be-4d73-94e8-173b1dc7cf3c')
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '9980e02c-c2be-4d73-94e8-173b1dc7cf3c')
    principalId: consolePrincipalId
    principalType: 'ServicePrincipal'
  }
}

output vmId string = vm.id
output vmName string = vm.name
output privateIp string = nic.properties.ipConfigurations[0].properties.privateIPAddress
