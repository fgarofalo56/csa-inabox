// CSA Loom Health Data Services (LHDS) - DoD parameters for health.bicep. SUPPORTED-IN-CODE ONLY, NEVER EXERCISED (D3):
// deploy-health.yml does not offer DoD, no DoD deploy has run, What-If was not run. health.bicep resolves DoD as IL5.
// Keys of healthConfig / controlPlaneConfig are documented in health.bicep.

using '../health.bicep'

param location = 'usgovvirginia'
param boundary = 'DoD'
param healthEnabled = false
param healthConfig = {
  stampName: 'dev01'
  profile: 'dev'
  location: 'usgovarizona'
  pairedLocation: 'usgovtexas'
  postgres: 'enabled'
}
