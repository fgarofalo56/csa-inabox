// CSA Loom — Admin Plane container platform dispatcher
// Container Apps Environment (Commercial / GCC) OR AKS (GCC-H / IL5)

targetScope = 'resourceGroup'

@description('Primary region')
param location string

@description('Container platform — containerApps or aks')
@allowed(['containerApps', 'aks'])
param containerPlatform string

@description('Container platform subnet ID')
param containerSubnetId string

@description('Log Analytics workspace ID')
param lawId string

@description('Log Analytics customer ID')
param lawCustomerId string

@description('Log Analytics shared key (required by Container Apps Env when destination=log-analytics; passed in from monitoring module)')
@secure()
param lawSharedKey string

@description('Compliance tags')
param complianceTags object

@description('Console UAMI principal ID — granted "Azure Kubernetes Service Cluster Admin" at the AKS cluster scope (AKS path only) so the Console BFF can scale node pools via aks-arm-client.ts (Admin → Capacity & compute → Scale & manage). Empty skips the grant.')
param consolePrincipalId string = ''

@description('When true, skip all role grants (e.g. re-deploy where RBAC already exists or the deployer lacks User Access Administrator).')
param skipRoleGrants bool = false

@description('Private DNS zone for the internal CAE default domain (privatelink.<location>.azurecontainerapps.<suffix>, created by network.bicep). When set, A records for the env label + wildcard are created pointing at the CAE static IP so IN-VNET clients resolve every hosted app. Without them the zone ships EMPTY and authoritatively shadows public DNS — every *.azurecontainerapps FQDN is ENOTFOUND in-VNet (live incident 2026-07-19: hosted Loom-app probes failed until the records were added by hand). Empty = skip.')
param acaPrivatelinkZoneName string = ''

// =====================================================================
// Container Apps Environment (Commercial / GCC)
// =====================================================================

resource cae 'Microsoft.App/managedEnvironments@2025-02-02-preview' = if (containerPlatform == 'containerApps') {
  name: 'cae-csa-loom-${location}'
  location: location
  tags: complianceTags
  properties: {
    // WORKLOAD PROFILES — the D8 profile is DECLARED but reserves NOTHING at idle.
    //
    // `minimumCount` on a Dedicated profile is a FLOOR, not a ceiling: ACA keeps
    // that many D8 nodes (8 vCPU / 32 GiB) provisioned and BILLING whether or not
    // anything is scheduled on them, and a non-Consumption profile also puts the
    // environment on the Dedicated plan's separate per-hour management charge.
    // `minimumCount: 1` therefore reserved a node unconditionally, on every
    // estate, from the moment the environment came up.
    //
    // MEASURED (2026-08-22, Commercial estate): all 29 Container Apps and all 17
    // ACA Jobs run on `Consumption`. ZERO workloads are assigned to D8. The repo
    // agrees — the ONLY consumer of a profile name is app-deployments.bicep:
    //     workloadProfileName: contains(app, 'workloadProfile') ? app.workloadProfile : 'Consumption'
    // and NO entry of the `apps[]` array in admin-plane/main.bicep sets
    // `workloadProfile`, in any params file, for any boundary. No ACA Job declares
    // `workloadProfileName` at all. So the floor was holding a node open for a
    // workload set that is, and always has been, empty. There was no comment
    // giving a rationale for the 1 — it is not honouring a documented constraint.
    //
    // WHY THE PROFILE STAYS DECLARED rather than being removed: the Console's
    // Admin -> Capacity & compute -> Scaling surface offers D8 as a live choice
    // (`ACA_WORKLOAD_PROFILES` in lib/azure/container-apps-arm-client.ts, and the
    // POST /api/admin/scaling/container-apps route validates against it). An app
    // can only be PATCHed onto a profile the ENVIRONMENT declares, so deleting
    // this entry would turn a working control into a 400 — the vaporware shape
    // no-vaporware.md forbids. `minimumCount: 0` keeps scale-out fully available
    // (ACA provisions a D8 node on demand the moment an app is assigned, up to
    // maximumCount) while reserving nothing when nothing is assigned.
    workloadProfiles: [
      {
        name: 'Consumption'
        workloadProfileType: 'Consumption'
      }
      {
        name: 'D8'
        workloadProfileType: 'D8'
        minimumCount: 0
        maximumCount: 10
      }
    ]
    vnetConfiguration: {
      internal: true
      infrastructureSubnetId: containerSubnetId
    }
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: lawCustomerId
        sharedKey: lawSharedKey
      }
    }
    zoneRedundant: true
  }
}

// =====================================================================
// AKS (GCC-H / IL5) — private cluster with API server VNet integration
// =====================================================================

resource aks 'Microsoft.ContainerService/managedClusters@2025-04-01' = if (containerPlatform == 'aks') {
  name: 'aks-csa-loom-${location}'
  location: location
  tags: complianceTags
  identity: { type: 'SystemAssigned' }
  properties: {
    dnsPrefix: 'aks-csa-loom'
    enableRBAC: true
    aadProfile: {
      managed: true
      enableAzureRBAC: true
    }
    apiServerAccessProfile: {
      enablePrivateCluster: true
      enableVnetIntegration: true
      subnetId: containerSubnetId
    }
    agentPoolProfiles: [
      {
        name: 'system'
        count: 3
        vmSize: 'Standard_D4ds_v5'
        mode: 'System'
        osType: 'Linux'
        osSKU: 'AzureLinux'
        vnetSubnetID: containerSubnetId
        availabilityZones: ['1', '2', '3']
        enableAutoScaling: true
        minCount: 3
        maxCount: 5
      }
      {
        name: 'apps'
        count: 3
        vmSize: 'Standard_D8ds_v5'
        mode: 'User'
        osType: 'Linux'
        osSKU: 'AzureLinux'
        vnetSubnetID: containerSubnetId
        availabilityZones: ['1', '2', '3']
        enableAutoScaling: true
        minCount: 3
        maxCount: 12
      }
    ]
    networkProfile: {
      networkPlugin: 'azure'
      networkPolicy: 'cilium'
      networkDataplane: 'cilium'
      loadBalancerSku: 'standard'
      outboundType: 'userDefinedRouting'
    }
    azureMonitorProfile: {
      metrics: { enabled: true }
    }
    addonProfiles: {
      omsagent: {
        enabled: true
        config: {
          logAnalyticsWorkspaceResourceID: lawId
        }
      }
    }
    securityProfile: {
      defender: {
        logAnalyticsWorkspaceResourceId: lawId
        securityMonitoring: { enabled: true }
      }
      workloadIdentity: { enabled: true }
      imageCleaner: {
        enabled: true
        intervalHours: 24
      }
    }
    oidcIssuerProfile: { enabled: true }
  }
}

// =====================================================================
// RBAC — Console UAMI → Azure Kubernetes Service Cluster Admin (AKS path)
// =====================================================================
// Required for aks-arm-client.ts:
//   • scaleAksAgentPool (PUT agentPools/{name}) — Admin → Capacity & compute scale drawer.
//   • updateAksDeploymentEnv (POST managedClusters/runCommand + commandResults/read)
//     — Admin → Runtime configuration (/admin/env-config) Save on the AKS path.
// The "Cluster Admin" role includes managedClusters/runCommand/action and
// commandResults/read, so this single grant backs both. Only created on the
// GCC-High / IL5 / DoD AKS path; Commercial / GCC run Container Apps and the
// env-config / scale surfaces honest-gate instead. Role ID is cloud-agnostic.
resource consoleAksAdmin 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (containerPlatform == 'aks' && !empty(consolePrincipalId) && !skipRoleGrants) {
  scope: aks
  name: guid(aks!.id, consolePrincipalId, '0ab0b1a8-8aac-4efd-b8c2-3ee1fb270be8')
  properties: {
    // Azure Kubernetes Service Cluster Admin Role
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '0ab0b1a8-8aac-4efd-b8c2-3ee1fb270be8')
    principalId: consolePrincipalId
    principalType: 'ServicePrincipal'
  }
}

// =====================================================================
// In-VNet DNS for the internal CAE — env-label + wildcard A records in the
// privatelink zone. Every hosted app's public FQDN CNAMEs to
// <envLabel>.privatelink.<location>.azurecontainerapps.<suffix>; the linked
// zone answers authoritatively, so with no record the whole default domain is
// dead in-VNet (empty-zone-shadows-public-DNS class).
// =====================================================================

// Child module: the record names derive from the CAE's RUNTIME defaultDomain,
// which BCP120 forbids on a resource name in this scope.
module caeDnsRecords 'cae-dns-records.bicep' = if (containerPlatform == 'containerApps' && !empty(acaPrivatelinkZoneName)) {
  name: 'cae-dns-records'
  params: {
    zoneName: acaPrivatelinkZoneName
    defaultDomain: cae!.properties.defaultDomain
    staticIp: cae!.properties.staticIp
  }
}

// =====================================================================
// Outputs (one of two; caller picks based on containerPlatform)
// =====================================================================

output caeId string = containerPlatform == 'containerApps' ? cae!.id : ''
output caeName string = containerPlatform == 'containerApps' ? cae!.name : ''
output caeDefaultDomain string = containerPlatform == 'containerApps' ? cae!.properties.defaultDomain : ''
output caeStaticIp string = containerPlatform == 'containerApps' ? cae!.properties.staticIp : ''

/**
 * The CIDR of the subnet this Container Apps environment injects into.
 *
 * WHY (#2720, and the compensating control for py/code-injection #729): two
 * DEFAULT-ON hosts execute caller-supplied code — `udf-runtime` (execs the
 * item's Python from the `X-Udf-Source-B64` header) and `script-runner`. Neither
 * can hold a credential to authenticate callers: a shared key in their
 * environment could simply be read back out by the very code they run, which
 * moves the secret INTO the blast radius. Their boundary is therefore the
 * NETWORK — internal ingress PLUS an `ipSecurityRestrictions` pin to the
 * Console's own subnet.
 *
 * Both modules already accept `consoleAllowedCidrs`, and until this output
 * existed NO orchestrator could pass it: the caller holds `containerSubnetId`
 * (a resource id), not an address prefix. So the pin was defined, documented,
 * and never applied — internal ingress alone means anything on the CAE VNet
 * reaches an RCE surface.
 *
 * An OUTPUT rather than a new param on admin-plane/main.bicep deliberately:
 * that orchestrator is at the 256-param ARM ceiling, and outputs do not count
 * against it.
 */
resource caeSubnet 'Microsoft.Network/virtualNetworks/subnets@2023-11-01' existing = if (containerPlatform == 'containerApps' && !empty(containerSubnetId)) {
  name: '${split(containerSubnetId, '/')[8]}/${split(containerSubnetId, '/')[10]}'
  scope: resourceGroup(split(containerSubnetId, '/')[2], split(containerSubnetId, '/')[4])
}

output infrastructureSubnetPrefix string = (containerPlatform == 'containerApps' && !empty(containerSubnetId))
  ? caeSubnet!.properties.addressPrefix
  : ''

output aksId string = containerPlatform == 'aks' ? aks!.id : ''
output aksName string = containerPlatform == 'aks' ? aks!.name : ''
output aksOidcIssuer string = containerPlatform == 'aks' ? aks!.properties.oidcIssuerProfile.issuerURL : ''
