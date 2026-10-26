// CSA Loom Health Data Services (LHDS) - IL5 parameters for health.bicep.
// Supported-in-code only: deploy-health.yml does NOT offer IL5, and no IL5 deploy
// has ever run. healthEnabled stays false here. The control plane defaults to the
// stamp AKS cluster at IL5 (controlPlane=aks), independent of containerPlatform,
// which is containerApps in il5.bicepparam.
// Keys of healthConfig / controlPlaneConfig are documented in health.bicep.

using '../health.bicep'

param location = 'usgovvirginia'
param boundary = 'IL5'
param healthEnabled = false
param healthConfig = {
  stampName: 'dev01'
  profile: 'dev'
  location: 'usgovarizona'
  pairedLocation: 'usgovtexas'
  postgres: 'enabled'
}
