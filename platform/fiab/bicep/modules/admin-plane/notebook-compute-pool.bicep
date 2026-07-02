// CSA Loom — Per-user notebook Compute Instance policy (multi-user AML)
//
// WHY THIS MODULE EXISTS
// ----------------------
// Azure ML Compute Instances are SINGLE-USER by design: only the user a CI is
// assigned to (personalComputeInstanceSettings.assignedUser) can start / run on
// it. A single shared "default" CI therefore cannot make Loom notebooks
// multi-user. The notebook editor's per-user flow provisions a CI assigned to
// EACH signed-in user (name `ci-loom-<oid>`, assignedUser = their AAD oid), so
// everyone runs on their OWN compute. This module carries the tenant POLICY for
// that flow — default VM size, idle-shutdown TTL, and a cost-guard ceiling — as
// env config the Console reads at runtime.
//
// It provisions NO Azure resource: the AML / AI Foundry workspace the CIs live
// in is deployed by `ai-foundry.bicep` / the deploy-planner `mlWorkspace`
// module, and each per-user CI is created on demand (real ARM PUT) by the
// Console UAMI via `/api/aml/compute-instances/mine`. This module only emits the
// four `LOOM_AML_*` env values below.
//
// -------------------------------------------------------------------------
// INTEGRATION PASS (a sibling wires the root/admin-plane main.bicep — do NOT
// edit main.bicep here). To activate, the orchestrator should:
//   1. module notebookComputePool 'modules/admin-plane/notebook-compute-pool.bicep' = { ... }
//   2. Append the four outputs below to the loom-console app `env` list in
//      admin-plane/main.bicep:
//        LOOM_AML_PERUSER_ENABLED = <perUserEnabled>
//        LOOM_AML_CI_SIZE         = <perUserVmSize>
//        LOOM_AML_CI_IDLE_TTL     = <perUserIdleTtl>
//        LOOM_AML_CI_MAX          = <maxPerTenant>
//   The Console UAMI already needs the "AzureML Data Scientist" + "AzureML
//   Compute Operator" roles on the workspace to create/start CIs (granted in
//   ai-foundry.bicep) — no new role assignment is required for the per-user path
//   beyond "AzureML Compute Operator" (which authorizes create/start/stop).
// -------------------------------------------------------------------------
//
// Per no-vaporware.md / no-fabric-dependency.md: the flow is Azure-native and
// works with LOOM_DEFAULT_FABRIC_WORKSPACE unset. When the AML workspace env is
// absent the notebook editor shows the documented honest MessageBar gate; when
// present, per-user provisioning works out of the box with these defaults.

targetScope = 'resourceGroup'

@description('Master switch for the per-user Compute Instance flow. When false, the notebook editor hides "Create my compute instance" and the /mine POST is 403-gated.')
param perUserEnabled bool = true

@description('Default VM size for a per-user Compute Instance. Must be a size the notebook editor offers (DS3_v2 / DS11_v2 / DS12_v2 / E4ds_v4 / NC6s_v3).')
@allowed([
  'Standard_DS3_v2'
  'Standard_DS11_v2'
  'Standard_DS12_v2'
  'Standard_E4ds_v4'
  'Standard_NC6s_v3'
])
param perUserVmSize string = 'Standard_DS3_v2'

@description('Default idle auto-shutdown TTL (ISO-8601 duration). A per-user CI deallocates after sitting idle this long, so it stops billing. Dropdown-backed values only.')
@allowed([
  'PT15M'
  'PT30M'
  'PT1H'
  'PT2H'
  'PT3H'
  'PT4H'
])
param perUserIdleTtl string = 'PT30M'

@description('Maximum per-user Compute Instances allowed across the tenant (cost guard). When reached, the notebook editor shows an honest quota MessageBar and /mine POST returns 409.')
@minValue(1)
@maxValue(2000)
param maxPerTenant int = 50

// =====================================================================
// Outputs — env values for the loom-console app (wired by the integration
// pass into admin-plane/main.bicep's apps[] env list).
// =====================================================================

@description('LOOM_AML_PERUSER_ENABLED — master switch for the per-user CI flow.')
output perUserEnabledEnv string = perUserEnabled ? 'true' : 'false'

@description('LOOM_AML_CI_SIZE — default VM size for a per-user Compute Instance.')
output perUserVmSizeEnv string = perUserVmSize

@description('LOOM_AML_CI_IDLE_TTL — default idle-shutdown TTL for a per-user CI.')
output perUserIdleTtlEnv string = perUserIdleTtl

@description('LOOM_AML_CI_MAX — tenant ceiling on per-user Compute Instances.')
output maxPerTenantEnv string = string(maxPerTenant)
