# For Azure Commercial

The baseline deployment. Full feature set; UC managed catalog; Foundry
Agent Service; Container Apps everywhere; Power BI Premium F-SKU.

## Prerequisites

| Item | Notes |
|---|---|
| Azure Commercial subscription | Not GCC tenant (Azure Commercial under M365 GCC) |
| Region | Any Azure Commercial region with Databricks Premium + ADX + AOAI quota (recommended: eastus2, westus2, eastus, westeurope) |
| Power BI Premium F-SKU capacity | F8 minimum for production |
| Quota for Databricks Premium workspace | `az vm list-usage --location eastus2` |
| Quota for ADX cluster (D14_v2 min recommended) | |
| Quota for AOAI (gpt-4o + text-embedding-3-large) | 50K TPM minimum |
| Compliance tags | Customer-supplied (CostCenter, Owner, etc.) |

## Deploy

Use `commercial.bicepparam`:

```bash
az deployment sub create \
  --name csa-loom-commercial-$(date +%s) \
  --location eastus2 \
  --template-file platform/fiab/bicep/main.bicep \
  --parameters platform/fiab/bicep/params/commercial.bicepparam \
  --parameters adminEntraGroupId=<group-guid>
```

## What's deployed differently from Gov

| Component | Commercial | Gov delta |
|---|---|---|
| Container host | Azure Container Apps | (Gov uses AKS at IL4+) |
| Catalog primary | Databricks Unity Catalog managed | (Gov-IL4 uses Purview; IL5 uses Atlas-on-AKS) |
| SQL Warehouse | Databricks SQL Warehouse | (Gov uses Synapse Serverless) |
| Agent orchestration | Foundry Agent Service | (Gov uses MAF + AOAI direct) |
| APIM | Premium v2 | (Gov uses classic Premium) |
| Functions host | Flex Consumption | (Gov uses Premium EP1) |
| OpenAI models | Full catalog | (Gov restricted to gpt-4o, gpt-4.1, o3-mini, gpt-5.1) |
| Direct Lake parity | Full warm-cache materializer; native Direct Lake when forward-migrating to Fabric | (same warm-cache; native Direct Lake not yet in Gov) |
| Defender for Cloud AI Threat Protection | ✅ enabled | (Gov: manual Sentinel pipeline) |

## Validation

After deploy:
```bash
# Console URL from azd output
curl -i https://<your-console-url>/api/health
# Expected: {"status":"healthy"}
```

Then sign in via browser, verify:
- Workspaces pane shows the auto-created `default-workspace`
- Catalog shows the canary dataset
- Monitoring Hub health green across all pillars

## Cost (F8 Commercial baseline)

| Component | Approximate $/month |
|---|---|
| Power BI Premium F8 | $1,049 |
| Databricks Premium (1 workspace, 10-50 DBU/day) | $500-2,500 |
| Synapse Serverless (light usage) | $5-50 |
| ADX cluster (D14_v2 base) | $500 |
| ADLS Gen2 (10 TB) | $200 |
| AOAI (50K TPM gpt-4o) | $200-500 |
| AI Search (S1) | $250 |
| Purview (1 vCore) | $300 |
| Container Apps Env + workloads | $50-200 |
| AI Foundry Hub | $0 base + AOAI consumption |
| Misc (KV, LA, App Insights) | $50 |
| **Total** | **~$3,100-5,600/mo** |

CSA Loom IP itself is free in v1.

## Forward migration to Fabric Commercial

When Microsoft Fabric is available in your Commercial tenant (already
GA today):
- Loom and Fabric can run side-by-side
- Migrate per-workload via [Forward to Fabric runbook](../operations/forward-to-fabric.md)

## Related

- [Quick Start](quickstart.md)
- [azd CLI](azd-cli.md)
- [Per-boundary dispatch matrix](../architecture.md#per-boundary-dispatch-matrix)
- [Compliance — Commercial baseline](../compliance/commercial.md)
