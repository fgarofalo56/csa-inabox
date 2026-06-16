// CSA Loom deploy-planner — Azure Machine Learning workspace
//
// Wired by the deploy-planner catalog (key: mlWorkspace → mlWorkspaceEnabled).
// Self-contained: provisions the three required AML dependencies inline — a
// Key Vault, a Storage account, and an Application Insights component (backed by
// a Log Analytics workspace) — then an AML workspace (Microsoft.MachineLearning
// Services/workspaces) wired to them with a system-assigned identity. The Loom
// Console UAMI is granted AzureML Data Scientist so the navigator can drive the
// workspace data plane.
//
// Grounded in Microsoft Learn:
//   Microsoft.MachineLearningServices/workspaces (Bicep) + its KV/Storage/AppInsights deps
//   https://learn.microsoft.com/azure/templates/microsoft.machinelearningservices/workspaces

targetScope = 'resourceGroup'

@description('Primary region')
param location string

@description('Tenant ID for the backing Key Vault.')
param tenantId string = subscription().tenantId

@description('Loom Console UAMI principal ID — granted AzureML Data Scientist so the BFF can drive the workspace data plane. Empty skips the grant.')
param consolePrincipalId string = ''

@description('Skip role-assignment grants — set true when re-provisioning to avoid RoleAssignmentExists.')
param skipRoleGrants bool = false

@description('''Rich display() AML startup — base64-encoded shell command run at compute-instance start.
It must drop apps/fiab-console/lib/notebook/ai-display.py into the IPython startup dir
(~/.ipython/profile_default/startup/99_loom_display.py) so display(df) emits the Loom
rich-display MIME in AML Jupyter, matching the Synapse-Spark path. Empty = skip the
opt-in compute instance below (the Synapse Livy path still injects the helper at runtime,
so display() rich rendering works without this). Build it from ai-display.py — see
docs/fiab/parity/notebook-display.md.''')
param richDisplayStartupScriptBase64 string = ''

@description('Name of the opt-in AML compute instance that carries the rich-display startup script. Empty = none. Only created when richDisplayStartupScriptBase64 is also set.')
param richDisplayComputeInstanceName string = ''

@description('VM size for the rich-display compute instance.')
param richDisplayComputeVmSize string = 'Standard_DS3_v2'

// --- Default AmlCompute training cluster (AutoML / command jobs) -------------
// AutoML and every AML compute JOB need an AmlCompute cluster to run on. A fresh
// workspace ships with NONE, so the AutoML wizard honest-gates "No compute
// clusters found" and nothing can run day-one. This default cluster makes the
// AML compute path work out of the box, at zero idle cost: min_instances=0 means
// it scales to zero nodes when idle, and idleSecondsBeforeScaleDown returns
// nodes after a short idle window. (Matches the live hand-provisioned
// cpu-cluster: AmlCompute, min 0 / max 2, Standard_DS3_v2, 120s scale-down.)
@description('Default AmlCompute training cluster name (AutoML + command jobs). Empty skips creation. Live default: cpu-cluster.')
param defaultComputeClusterName string = 'cpu-cluster'

@description('Default AmlCompute cluster VM size. Standard_DS3_v2 (4 vCPU / 14 GiB) is a sensible AutoML default; override per region/quota.')
param defaultComputeClusterVmSize string = 'Standard_DS3_v2'

@description('Default AmlCompute cluster maximum node count (scale ceiling).')
@minValue(1)
@maxValue(100)
param defaultComputeClusterMaxNodes int = 2

@description('Idle seconds before the AmlCompute cluster scales nodes back down. With minNodeCount=0 this means zero idle cost when no jobs are running.')
@minValue(60)
param defaultComputeClusterIdleSeconds int = 120

@description('Compliance tags applied to every resource.')
param complianceTags object

var suffix = uniqueString(resourceGroup().id)
var kvName = take('kv-aml-${suffix}', 24)
var saName = take('saamlloom${suffix}', 24)
var lawName = take('law-aml-loom-${suffix}', 63)
var aiName = take('appi-aml-loom-${suffix}', 255)
var wsName = take('aml-loom-${suffix}', 33)

// --- AML dependency 1: Key Vault ---
resource kv 'Microsoft.KeyVault/vaults@2024-04-01-preview' = {
  name: kvName
  location: location
  tags: complianceTags
  properties: {
    tenantId: tenantId
    sku: { family: 'A', name: 'standard' }
    enableRbacAuthorization: true
    enableSoftDelete: true
    publicNetworkAccess: 'Enabled'
  }
}

// --- AML dependency 2: Storage account ---
resource sa 'Microsoft.Storage/storageAccounts@2024-01-01' = {
  name: saName
  location: location
  tags: complianceTags
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  properties: {
    allowBlobPublicAccess: false
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
  }
}

// --- AML dependency 3: Application Insights (workspace-based) ---
resource law 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: lawName
  location: location
  tags: complianceTags
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
  }
}

resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: aiName
  location: location
  tags: complianceTags
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: law.id
  }
}

// --- AML workspace wired to the three deps ---
resource workspace 'Microsoft.MachineLearningServices/workspaces@2023-04-01' = {
  name: wsName
  location: location
  tags: complianceTags
  identity: { type: 'SystemAssigned' }
  properties: {
    friendlyName: 'CSA Loom ML workspace'
    keyVault: kv.id
    storageAccount: sa.id
    applicationInsights: appInsights.id
    publicNetworkAccess: 'Enabled'
  }
}

// AzureML Data Scientist — drive the workspace data plane
// (role f6c7c914-8db3-469d-8ca1-694a8f32e121).
//
// This same role also covers notebook scheduling (Task: Notebook scheduling):
//   - Microsoft.MachineLearningServices/workspaces/schedules/write  (create/enable/disable)
//   - Microsoft.MachineLearningServices/workspaces/schedules/read   (schedule list)
//   - Microsoft.MachineLearningServices/workspaces/jobs/write       (the Command job the schedule runs)
// No additional role assignment is required for the schedule wizard / list.
resource amlDataScientist 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(consolePrincipalId) && !skipRoleGrants) {
  scope: workspace
  name: guid(workspace.id, consolePrincipalId, 'f6c7c914-8db3-469d-8ca1-694a8f32e121')
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'f6c7c914-8db3-469d-8ca1-694a8f32e121')
    principalId: consolePrincipalId
    principalType: 'ServicePrincipal'
  }
}

// Rich display() — opt-in AML compute instance whose startup script installs the
// ai-display.py helper into the IPython startup dir, so display(df) renders the
// Loom interactive grid + chart recommendations in AML Jupyter (parity with the
// Synapse Spark path). startupScript runs at every machine start (inline source,
// base64 command) — the supported AML setup-script mechanism. Gated on both the
// name and the script being supplied, so default deploys are unaffected and the
// Synapse Livy path (which injects the same helper at session start) is unchanged.
resource displayComputeInstance 'Microsoft.MachineLearningServices/workspaces/computes@2023-04-01' = if (!empty(richDisplayComputeInstanceName) && !empty(richDisplayStartupScriptBase64)) {
  parent: workspace
  name: richDisplayComputeInstanceName
  location: location
  tags: complianceTags
  properties: {
    computeType: 'ComputeInstance'
    properties: {
      vmSize: richDisplayComputeVmSize
      setupScripts: {
        scripts: {
          startupScript: {
            scriptSource: 'inline'
            scriptData: richDisplayStartupScriptBase64
          }
        }
      }
    }
  }
}

// Default AmlCompute training cluster — what AutoML and command jobs run on.
// min/max node count + idleSecondsBeforeScaleDown make it scale to zero when
// idle (no idle cost) and back up on job submission. Created by default so a
// clean deploy can run AutoML immediately instead of honest-gating on "No
// compute clusters found". Serialized after the optional display CI so the two
// computes don't write the workspace concurrently.
// Grounded in Learn: Microsoft.MachineLearningServices/workspaces/computes
// (computeType 'AmlCompute', properties.scaleSettings).
resource defaultComputeCluster 'Microsoft.MachineLearningServices/workspaces/computes@2023-04-01' = if (!empty(defaultComputeClusterName)) {
  parent: workspace
  name: defaultComputeClusterName
  location: location
  tags: complianceTags
  properties: {
    computeType: 'AmlCompute'
    properties: {
      vmSize: defaultComputeClusterVmSize
      vmPriority: 'Dedicated'
      scaleSettings: {
        minNodeCount: 0
        maxNodeCount: defaultComputeClusterMaxNodes
        nodeIdleTimeBeforeScaleDown: 'PT${defaultComputeClusterIdleSeconds}S'
      }
    }
  }
}

// AzureML Compute Operator — list / start / stop / restart Compute Instances
// on this workspace (role e503ece1-11d0-4e8e-8e2c-7a6c3bf38815). Mirrors the
// grant on the Foundry hub (ai-foundry.bicep) so the CI lifecycle routes
// (/api/foundry/computes[/{id}/start|status]) work against any AML workspace
// the Console drives. Data Scientist above lacks computes/*.
resource amlComputeOperator 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(consolePrincipalId) && !skipRoleGrants) {
  scope: workspace
  name: guid(workspace.id, consolePrincipalId, 'e503ece1-11d0-4e8e-8e2c-7a6c3bf38815')
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'e503ece1-11d0-4e8e-8e2c-7a6c3bf38815')
    principalId: consolePrincipalId
    principalType: 'ServicePrincipal'
  }
}

output workspaceId string = workspace.id
output workspaceName string = workspace.name
output richDisplayComputeInstanceName string = (!empty(richDisplayComputeInstanceName) && !empty(richDisplayStartupScriptBase64)) ? richDisplayComputeInstanceName : ''
output defaultComputeClusterName string = empty(defaultComputeClusterName) ? '' : defaultComputeCluster.name

// --- Curated AML Environment: Pylance-grade Python IntelliSense ---
// Backs the CSA Loom notebook "Open in VS Code for Web" path (AML compute
// instance) and the curated kernel image. python-lsp-server + pyright give the
// same completions/hover the Console's in-cell Monaco bridge serves, and
// jupyter-lsp wires LSP into the JupyterLab UI on the compute instance.
// Grounded in Learn: Microsoft.MachineLearningServices/workspaces/environments
// + .../environments/versions (condaFile + image).
resource loomPylspEnv 'Microsoft.MachineLearningServices/workspaces/environments@2023-04-01' = {
  parent: workspace
  name: 'loom-pylsp-env'
  properties: {
    description: 'CSA Loom curated environment — jupyter-lsp + python-lsp-server + pyright (Pylance-grade IntelliSense) over pandas/numpy/scikit-learn.'
    tags: { 'csa-loom': 'notebook-lsp' }
  }
}

resource loomPylspEnvVersion 'Microsoft.MachineLearningServices/workspaces/environments/versions@2023-04-01' = {
  parent: loomPylspEnv
  name: '1'
  properties: {
    description: 'v1 — Pylance-grade Python LSP stack on the AML openmpi CPU base image.'
    image: 'mcr.microsoft.com/azureml/openmpi4.1.0-ubuntu20.04:latest'
    condaFile: '''
name: loom-pylsp
channels:
  - conda-forge
  - defaults
dependencies:
  - python=3.10
  - pip
  - pip:
    - jupyter-lsp>=2.2.0
    - jupyterlab>=4.0.0
    - python-lsp-server[all]>=1.11.0
    - pyright>=1.1.350
    - pandas-stubs>=2.2.0
    - pandas
    - numpy
    - scikit-learn
'''
    tags: { 'csa-loom': 'notebook-lsp' }
  }
}

output pylspEnvironmentName string = loomPylspEnv.name
output pylspEnvironmentVersion string = loomPylspEnvVersion.name
