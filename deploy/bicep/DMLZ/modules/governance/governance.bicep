// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

// This template is used as a module from the main.bicep template. 
// The module contains a template to create the governance services.
targetScope = 'resourceGroup'

// Parameters
param location string
param defaultTags object
param prefix string
param environment string

// param subnetId string
// param privateDnsZoneIdPurview string = ''
// param privateDnsZoneIdPurviewPortal string = ''
// param privateDnsZoneIdStorageBlob string = ''
// param privateDnsZoneIdStorageQueue string = ''
// param privateDnsZoneIdEventhubNamespace string = ''
// param privateDnsZoneIdKeyVault string = ''

param governanceResourceGroup string

//Moddules and Resources to deploy
@description('Specify the modules and resources to deploy')
param deployModules object = {}

// Governance module parameters
@sys.description('Array to hold all vaules for Governance module.')
param parGovernance object

// Variables
// Parameter to build base name for resources to include prefix and environment
@sys.description('Parameter to build base name for resources to include prefix and environment')
param parBaseName string = '${prefix}-${environment}'

var varPurview001Name = toLower(substring(
  '${parBaseName}-${parGovernance.parPurviewName}}',
  0,
  min(length('${parBaseName}-${parGovernance.parPurviewName}'), 24)
))

// var keyvault001Name = '${prefix}-vault001'

var varPurviewTags = union(defaultTags, parGovernance.tags)

// ─── Purview is ADOPT-OR-CREATE (deploy-integrity.md R5, #3577) ──────────────
//
// `deployPurview` below used to read `= if (bool(deployModules.governance))`,
// i.e. "if governance is on, make a new Purview account". Purview accounts are
// capped per TENANT per REGION at 5, and `params.USGov.dev.json` ships
// `deployModules.governance: true` against the SAME Azure Government tenant that
// refused deploy-gov.yml run 31917112453 with:
//
//   2005 - The Tenant *** with 5 resources has surpassed its resource quota 5
//          for resource type Account in usgovvirginia location.
//
// So this orchestrator carried the identical defect the Gov one did: it would
// deploy a sixth account beside the customer's five, or fail because five
// exist — both halves of what R5 forbids. It has not bitten only because
// deploy.yml has failed every run since 2026-04-25, which is luck, not cover.
//
// Same `adopt` bag, same service key, same accessor shape as
// deploy/bicep/gov/main.bicep and platform/fiab/bicep/main.bicep.
@description('Adopt-or-create plan keyed by adoption-catalog service key. Per key: { mode: "adopt"|"create"|"skip", target: { name, rg, sub } }. An absent key means create new, so a greenfield tenant is unaffected. Threaded from DMLZ/main.bicep.')
param adopt object = {}

func adoptMode(a object, k string) string => a[?k].?mode ?? 'create'
func adoptName(a object, k string) string => adoptMode(a, k) == 'adopt' ? (a[?k].?target.?name ?? '') : ''
func adoptRg(a object, k string) string => adoptMode(a, k) == 'adopt' ? (a[?k].?target.?rg ?? '') : ''
func adoptSub(a object, k string) string => adoptMode(a, k) == 'adopt' ? (a[?k].?target.?sub ?? '') : ''

var existingPurviewAccount = adoptName(adopt, 'purview')
var existingPurviewRg = adoptRg(adopt, 'purview')
var existingPurviewSub = adoptSub(adopt, 'purview')

var provisionPurview = bool(deployModules.governance) && adoptMode(adopt, 'purview') == 'create'
var adoptPurview = bool(deployModules.governance) && adoptMode(adopt, 'purview') == 'adopt' && !empty(existingPurviewAccount) && !empty(existingPurviewRg)

var existingPurviewSubEff = empty(existingPurviewSub) ? subscription().subscriptionId : existingPurviewSub

// Resources
//Deploy Purview
module deployPurview '../Purview/purview.bicep' = if (provisionPurview) {
  name: 'Deploy-${varPurview001Name}'
  scope: resourceGroup(governanceResourceGroup)
  params: {
    // purviewAcctName: '${parBaseName}-purview-${parGovernance.parLocation}'
    purviewAcctName: varPurview001Name
    sku: parGovernance.parPurviewSku
    parPurviewPublicNetworkAccess: parGovernance.parPurviewPublicNetworkAccess
    location: parGovernance.parLocation
    parTenantEndpointState: parGovernance.parTenantEndpointState
    configKafka: parGovernance.parPurviewKafkaConfig
    tags: varPurviewTags
  }
  dependsOn: [
    resourceGroup(governanceResourceGroup)
  ]
}

// BIND to the account the tenant already owns.
//
// An `existing` resource, NOT a module scoped to the customer's resource group:
// a cross-scope module compiles to a Microsoft.Resources/deployments resource
// THERE and needs `Microsoft.Resources/deployments/write`, which Reader does not
// carry. `existing` compiles to reference()/resourceId() and needs only read.
//
// Coordinates fall back to this module's own governance RG with an inert name
// when not adopting, so the id stays well-formed even though nothing reads it
// (both consumers are behind `adoptPurview`).
var adoptedPurviewName = adoptPurview ? existingPurviewAccount : 'loom-no-adopted-purview'
var adoptedPurviewRg = adoptPurview ? existingPurviewRg : governanceResourceGroup

resource purviewAdopted 'Microsoft.Purview/accounts@2021-12-01' existing = {
  name: adoptedPurviewName
  scope: resourceGroup(existingPurviewSubEff, adoptedPurviewRg)
}

@description('created | adopted | none — how Purview got bound, recorded so the mapping is inspectable rather than inferred.')
output purviewBindingMode string = provisionPurview ? 'created' : (adoptPurview ? 'adopted' : 'none')

output purviewAccountName string = provisionPurview
  ? varPurview001Name
  : (adoptPurview ? existingPurviewAccount : '')

// resourceId(), not reference() — an id needs no runtime read.
output purviewAccountId string = (provisionPurview && deployPurview != null)
  ? deployPurview!.outputs.purviewAccountId
  : (adoptPurview ? purviewAdopted.id : '')
