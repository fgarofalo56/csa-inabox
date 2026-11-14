// CSA Loom Health Data Services (LHDS) - Commercial parameters for health.bicep.
// healthEnabled is false here and stays false in the file: deploy-health.yml passes
// healthEnabled=true on the command line, so merging this file deploys nothing.
// Keys of healthConfig / controlPlaneConfig are documented in health.bicep.
// Supported-in-code; no Commercial receipt exists until deploy-health.yml has run.

using '../health.bicep'

// centralus, not eastus2: in this subscription eastus2 is Postgres Flexible offer-restricted
// (list-skus returns no editions) and AKS rejects zone 1 there (run 43067631148). centralus is
// also where the hub rg-csa-loom-admin-centralus lives.
param location = 'centralus'
param boundary = 'Commercial'
param healthEnabled = false
param healthConfig = {
  stampName: 'dev01'
  profile: 'dev'
}
