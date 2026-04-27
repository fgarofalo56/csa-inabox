# Shared Bicep Modules — AI/ML

Two production-shaped modules for AI workloads. Use either or both.

## When to use which

| Module | Best for | Includes |
|--------|----------|----------|
| [`aifoundry.bicep`](aifoundry.bicep) | **GenAI** — agents, prompt flow, RAG, foundation-model fine-tuning, Foundry Agent Service hosting | Hub + Project + AOAI/Search/ACR/KV/AI/Storage connections + Capability Host |
| [`azureml.bicep`](azureml.bicep) | **Classical ML** — training pipelines, AutoML, batch inference, online endpoints, MLflow tracking | Workspace + serverless CPU compute + UAMI + role assignments |

You can deploy **both** in the same resource group — they share Storage / KV / ACR / App Insights cleanly.

## Prerequisites

Before calling either module, you need:

| Resource | Required by | Provisioned by |
|----------|-------------|----------------|
| Storage account (HNS-disabled, GRS in prod) | both | `shared/modules/storage.bicep` (or your existing) |
| Key Vault (RBAC mode, purge protection) | both | `shared/modules/keyVault.bicep` |
| Application Insights | both | `shared/modules/observability/appInsights.bicep` |
| Container Registry (Premium for prod private endpoints) | both | `shared/modules/acr.bicep` |
| Azure OpenAI account | aifoundry | `shared/modules/aoai.bicep` (or new) |
| AI Search service | aifoundry (optional) | `shared/modules/aiSearch.bicep` |

## Example — both modules together

```bicep
// main.bicep — AI/ML platform RG

@allowed(['dev','test','prod'])
param env string = 'dev'
param location string = resourceGroup().location

// 1. Foundation resources (storage, kv, ai, acr, aoai, search)
module storage '../shared/modules/storage.bicep' = {
  name: 'st-${env}'
  params: { env: env, location: location }
}
module kv '../shared/modules/keyVault.bicep' = {
  name: 'kv-${env}'
  params: { env: env, location: location }
}
module appInsights '../shared/modules/observability/appInsights.bicep' = {
  name: 'ai-${env}'
  params: { env: env, location: location }
}
module acr '../shared/modules/acr.bicep' = {
  name: 'acr-${env}'
  params: { env: env, location: location }
}
module aoai '../shared/modules/aoai.bicep' = {
  name: 'aoai-${env}'
  params: { env: env, location: location }
}
module search '../shared/modules/aiSearch.bicep' = {
  name: 'srch-${env}'
  params: { env: env, location: location }
}

// 2. AI Foundry (GenAI surface)
module foundry '../shared/modules/aifoundry.bicep' = {
  name: 'foundry-${env}'
  params: {
    env: env
    location: location
    storageAccountResourceId: storage.outputs.id
    keyVaultResourceId: kv.outputs.id
    applicationInsightsResourceId: appInsights.outputs.id
    containerRegistryResourceId: acr.outputs.id
    aoaiResourceId: aoai.outputs.id
    aoaiName: aoai.outputs.name
    aiSearchResourceId: search.outputs.id
    aiSearchName: search.outputs.name
  }
}

// 3. Azure ML (classical ML surface) — same dependencies
module aml '../shared/modules/azureml.bicep' = {
  name: 'aml-${env}'
  params: {
    env: env
    location: location
    storageAccountResourceId: storage.outputs.id
    keyVaultResourceId: kv.outputs.id
    applicationInsightsResourceId: appInsights.outputs.id
    containerRegistryResourceId: acr.outputs.id
  }
}

output foundryProjectName string = foundry.outputs.projectName
output amlWorkspaceName string = aml.outputs.workspaceName
output mlflowTrackingUri string = aml.outputs.mlflowTrackingUri
```

## Identity model

Both modules use **system-assigned managed identities**. The modules create role assignments in the resource group scope so the identities can:

| Identity | Permissions granted |
|----------|---------------------|
| Foundry Hub | Storage Blob Data Contributor, KV Secrets Officer, AcrPull, AOAI User |
| AML workspace | Storage Blob Data Contributor, KV Secrets Officer, AcrPull |
| AML compute UAMI (optional) | Storage Blob Data Contributor (so jobs can read training data) |

No role IDs are hardcoded as secrets — they're public Azure built-in role definition GUIDs (allow-listed in `.gitleaks.toml`).

## Network isolation defaults by environment

| Setting | dev/test | prod |
|---------|---------|------|
| `publicNetworkAccess` | Enabled (convenience) | **Disabled** (private endpoints required) |
| `managedNetworkIsolation` | AllowInternetOutbound | **AllowOnlyApprovedOutbound** |
| `hbiWorkspace` (AML only) | false | **true** |
| Compute VM priority | LowPriority (cheap) | **Dedicated** |

## What's NOT in these modules (deliberate)

- **No private endpoints** — these are environment-conditional and depend on your hub/spoke topology. Compose them in your top-level `main.bicep` using `shared/modules/privateEndpoint.bicep`.
- **No GPU compute** — add separately when needed (different SKUs, quota, region availability).
- **No model deployments** — Foundry deployments and AML online endpoints are environment-specific. Manage via `az ml` CLI or a separate Bicep that consumes `foundry.outputs.hubResourceId` / `aml.outputs.workspaceId`.
- **No specific Foundry connections beyond AOAI + Search** — extend with Bing, Cosmos, etc. via additional `Microsoft.MachineLearningServices/workspaces/connections` resources.

## Verifying after deploy

```bash
# Foundry
az ml workspace show -g <rg> -n csa-foundry-dev
az ml connection list -g <rg> --workspace-name csa-foundry-dev

# Capability host (Agent Service backing)
az rest --method GET \
  --url "https://management.azure.com/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.MachineLearningServices/workspaces/csa-foundry-dev/capabilityHosts?api-version=2024-10-01-preview"

# Azure ML
az ml workspace show -g <rg> -n csa-aml-dev
az ml compute list -g <rg> --workspace-name csa-aml-dev
```

## Related

- [`examples/ai-agents/deploy/bicep/main.bicep`](../../../../examples/ai-agents/deploy/bicep/main.bicep) — example using AOAI + ACA without Foundry (single-agent / hosted-agent)
- [`docs/reference-architecture/identity-secrets-flow.md`](../../../../docs/reference-architecture/identity-secrets-flow.md) — broader identity story
- [`docs/patterns/llmops-evaluation.md`](../../../../docs/patterns/llmops-evaluation.md) — eval framework that runs against Foundry/AML
- [ADR 0007 — Azure OpenAI over self-hosted LLM](../../../../docs/adr/0007-azure-openai-over-self-hosted-llm.md)
