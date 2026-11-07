// CSA Loom Health Data Services (LHDS) - GCC-High parameters for health.bicep.
// healthEnabled is false here and stays false in the file: deploy-health.yml passes
// healthEnabled=true on the command line, so merging this file deploys nothing.
// Keys of healthConfig / controlPlaneConfig are documented in health.bicep.
// Gov defaults: usgovarizona primary (zone-redundant PostgreSQL HA) paired with
// usgovtexas; usgovvirginia is offer-restricted for PostgreSQL on the measured
// subscription. PostgreSQL resolves to the v4 SKU generation (Gov has no v5 E-series).
// Supported-in-code; no GCC-High receipt exists until deploy-health.yml has run.

using '../health.bicep'

param location = 'usgovvirginia'
param boundary = 'GCC-High'
param healthEnabled = false
param healthConfig = {
  stampName: 'dev01'
  profile: 'dev'
  location: 'usgovarizona'
  pairedLocation: 'usgovtexas'
  // PostgreSQL Flexible measured available in usgovarizona (W0-RECEIPT s4.1b); the Gov
  // main.bicep param files hold postgresQuotaAvailable=false as an Airflow posture hold.
  postgres: 'enabled'
}
