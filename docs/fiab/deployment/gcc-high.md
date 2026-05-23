# For Azure Government (GCC-High / IL4)

The full Gov boundary: Azure Government cloud + M365 GCC-High tenant.
FedRAMP High + DoD IL4 + ITAR-eligible.

## What "GCC-High" means here

| Layer | Where it lives |
|---|---|
| Microsoft 365 tenant | M365 GCC-High |
| Azure subscriptions | Azure Government (`usgovvirginia`, `usgovtexas`, `usgovarizona`) |
| Compliance | FedRAMP High + DoD IL4 + ITAR-eligible |

## Prerequisites

| Item | Notes |
|---|---|
| Azure Government subscription | `az cloud set --name AzureUSGovernment` |
| Region | `usgovvirginia` recommended (most services + AOAI chat models) + `usgovarizona` for OpenAI embeddings |
| Microsoft 365 GCC-High tenant | Identity provider |
| `az` + `azd` CLI | Same as Commercial |
| Power BI Premium F-SKU | F8 minimum |
| AOAI quota in usgovvirginia | gpt-4o + gpt-4.1 + o3-mini + gpt-5.1 |
| AOAI quota in usgovarizona | text-embedding-3-large (Standard mode is usgovarizona-only) |

## Critical GCC-High dispatch deltas (vs Commercial)

Per [Per-boundary dispatch matrix](../architecture.md):

| Component | GCC-High |
|---|---|
| Container host | **AKS** (Container Apps not at IL4+) |
| Functions host | **Premium EP1** (Flex not in Gov) |
| APIM | **Classic Premium** (v2 not confirmed in Gov) |
| Catalog primary | **Microsoft Purview** (UC managed not yet in Gov) |
| Databricks | Classic clusters + **Hive metastore** (no UC, no SQL Warehouse) |
| SQL Warehouse | **Synapse Serverless** (no Databricks SQL Warehouse in Gov) |
| Agent orchestration | **Microsoft Agent Framework + AOAI direct** (Foundry Agent Service Gov-GA unconfirmed) |
| Foundry portal | **Not available** (use classic Azure ML Hub) |
| Defender for Cloud AI Threat Protection | **Commercial-only** (use [Sentinel pipeline](../compliance/defender-ai-workaround.md)) |
| OpenAI Batch API | **Not in Gov** (use synchronous calls or provisioned throughput) |
| OpenAI Content Safety | **Not in Gov** (use self-hosted Presidio) |

## Pre-deploy: authenticate against Azure Gov

```bash
az cloud set --name AzureUSGovernment
az login
az account set --subscription <YOUR-GOV-SUB-ID>

azd auth login
azd env set AZURE_CLOUD AzureUSGovernment
```

## Deploy

Use `gcc-high.bicepparam`:

```bash
az deployment sub create \
  --name csa-loom-gcch-$(date +%s) \
  --location usgovvirginia \
  --template-file platform/fiab/bicep/main.bicep \
  --parameters platform/fiab/bicep/params/gcc-high.bicepparam \
  --parameters adminEntraGroupId=<gov-group-guid>
```

`gcc-high.bicepparam` sets:
- `environment = 'AzureUSGovernment'`
- `location = 'usgovvirginia'`
- All endpoint suffixes use `.usgovcloudapi.net` / `.us` / `.databricks.azure.us`
- `containerPlatform = 'aks'`
- `apimSku = 'Premium'` (classic)
- `functionsHostSku = 'EP1'`
- `databricksUnityCatalogEnabled = false`
- `databricksSqlWarehouseEnabled = false`
- `databricksMetastore = 'hive'`
- `catalogPrimary = 'purview'`
- `agentOrchestrator = 'maf'`
- `foundryPortalEnabled = false`
- `defenderForAIEnabled = false`
- `contentSafetyEnabled = false`
- `openaiBatchEnabled = false`
- `openaiLocation = 'usgovvirginia'`
- `openaiEmbeddingsLocation = 'usgovarizona'`
- `openaiChatModel = 'gpt-4o'`
- `powerBiSku = 'F64'`

Plus compliance tags:
```bicepparam
param complianceTags = {
  Environment: 'GCC-High'
  FedRAMP_Level: 'High'
  DISA_IL: 'IL4'
  Data_Classification: 'CUI'
  M365_Boundary: 'GCC-High'
}
```

## Deploy time

- Admin Plane: 45-65 min (AKS cluster spin-up is slower than Container
  Apps)
- First DLZ: 20-40 min
- **Total to working Console: 70-110 min**

## Validation

```bash
# Console URL from azd output
curl -i https://<your-gov-console-url>/api/health
```

Then sign in via browser using your GCC-High M365 identity.

## ITAR considerations

GCC-High supports ITAR-eligible workloads. Customer responsibility:
- Mark ITAR-restricted data with sensitivity labels
- Apply Purview ITAR classification rules
- Verify cross-cloud B2B is disabled or scoped per ITAR policy
- Configure Sentinel rules to detect ITAR-data egress

See [ITAR compliance page](../compliance/itar-fiab.md).

## Cost (F8 GCC-High baseline)

GCC-High pricing is typically **10-25% above** Azure Commercial:

| Component | Approximate $/month |
|---|---|
| Power BI Premium F8 | $1,200 |
| Databricks Premium classic | $600-3,000 |
| Synapse Serverless | $5-50 |
| ADX cluster D14_v2 | $600 |
| ADLS Gen2 (10 TB) | $250 |
| AOAI Gov (50K TPM gpt-4o) | $250-600 |
| AI Search S1 | $300 |
| Purview | $350 |
| AKS cluster + workloads | $200-500 |
| Misc (KV Premium HSM, LA, Sentinel) | $200 |
| **Total** | **~$4,000-7,000/mo** |

## Forward migration

When Fabric Gov-H reaches GA:
- F-SKU + Direct Lake natively available
- Loom and Fabric Gov run side-by-side
- Per-workload migration via [Forward to Fabric runbook](../operations/forward-to-fabric.md)

## Runbooks

- [Deploy failure](../runbooks/deploy-failure.md)
- [MCP troubleshooting](../runbooks/mcp-troubleshooting.md)
- [Boundary promotion](../runbooks/boundary-promotion.md) — promoting an existing GCC-H install to IL5 (v1.1)

## Related

- [Microsoft Fabric in Azure Government](../../fabric-in-gov-cloud.md)
- [Per-boundary dispatch](../architecture.md#per-boundary-dispatch-matrix)
- [Compliance — GCC-High](../compliance/gcc-high.md)
- [Defender AI workaround](../compliance/defender-ai-workaround.md)
