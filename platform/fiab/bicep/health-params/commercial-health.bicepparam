// CSA Loom Health Data Services (LHDS) - Commercial parameters for health.bicep.
// healthEnabled is false here and stays false in the file: deploy-health.yml passes
// healthEnabled=true on the command line, so merging this file deploys nothing.
// Keys of healthConfig / controlPlaneConfig are documented in health.bicep.
// Supported-in-code; no Commercial receipt exists until deploy-health.yml has run.

using '../health.bicep'

param location = 'eastus2'
param boundary = 'Commercial'
param healthEnabled = false
param healthConfig = {
  stampName: 'dev01'
  profile: 'dev'
}
