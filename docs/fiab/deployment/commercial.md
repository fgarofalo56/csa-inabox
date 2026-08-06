# For Azure Commercial

The baseline deployment. Full feature set; UC managed catalog; Foundry
Agent Service; Container Apps everywhere. Semantic models + reports run
on the **Azure-native tabular layer (Azure Analysis Services)** by
default — **no Power BI Premium is required**; Power BI is strictly
opt-in for Direct Lake parity (see below).

## Prerequisites

| Item | Notes |
|---|---|
| Azure Commercial subscription | Not GCC tenant (Azure Commercial under M365 GCC) |
| Region | Any Azure Commercial region with Databricks Premium + ADX + AOAI quota (recommended: eastus2, westus2, eastus, westeurope) |
| Quota for Databricks Premium workspace | `az vm list-usage --location eastus2` |
| Quota for ADX cluster (D14_v2 min recommended) | |
| Quota for AOAI (gpt-4o + text-embedding-3-large) | 50K TPM minimum |
| Compliance tags | Customer-supplied (CostCenter, Owner, etc.) |

> **Optional — only with `LOOM_SEMANTIC_MODEL_BACKEND=powerbi`.** A Power BI
> Premium F-SKU capacity (F8 minimum for production) is required **only** if you
> opt into the Power BI / Direct-Lake-Shim backend for sub-30-second semantic-model
> freshness. On the default Azure-native path (Azure Analysis Services), no Power
> BI Premium capacity is provisioned or billed.

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

## Loom Unity (OSS Unity Catalog) on Commercial

`loom-unity` — the Unity-Catalog-compatible OSS metastore — is **default-ON on
Commercial** (not Gov-only) and is produced by the normal three-step path, with
no opt-in and no manual binding:

1. **Infra + app**: `admin-plane/main.bicep` invokes
   `data-plane/loom-unity-postgres.bicep` (Entra-only, private-endpoint-only
   PostgreSQL flexible server; skipped only where `postgresQuotaAvailable=false`,
   in which case the catalog runs an EmptyDir H2 store) and
   `compute/loom-unity-app.bicep` (`authMode=entra` hard-wired, ingress IP-pinned
   to the Container Apps infrastructure subnet), and emits `LOOM_UNITY_URL` /
   `LOOM_UNITY_CLIENT_ID` / `LOOM_UNITY_AUDIENCE` / `LOOM_UNITY_AUTH_MODE` onto
   the Console app. Toggle (opt-OUT): `loomBackends.unity='disabled'`.
2. **Image**: `full-app-deploy-commercial.yml` builds `loom-unity:v0.1` into the
   estate ACR (build matrix, `apps/loom-unity`) — required in ACR before the
   app phase, like every other app image.
3. **Unseal**: on a genuinely fresh estate the Entra app registration does not
   exist at ARM time, so the catalog deploys SEALED (up, authorization ON,
   sentinel audience, scaled to zero). `csa-loom-post-deploy-bootstrap.yml`
   ("Unseal Loom Unity + wire the Console") pins the real client id the moment
   the MSAL registration exists — an env update, deliberately NOT a module
   redeploy (a partial-param redeploy would silently migrate persistence off
   Postgres).

**Private DNS note:** the Postgres store resolves through
`privatelink.postgres.database.azure.com` on Commercial (Gov:
`privatelink.postgres.database.usgovcloudapi.net`). Estates deployed before
2026-08-06 may carry an empty, stale `privatelink.postgres.database.windows.net`
zone from the earlier (wrong) suffix derivation — it is inert for resolution;
`scripts/csa-loom/migrate-private-dns-zone-owner.mjs` is the cleanup path
(#3039).

**Out-of-band repair** (estate has no `loom-unity` app but the orchestrator
deploy is not runnable right now): deploy the two modules targeted, in order —
`loom-unity-postgres.bicep` first (pass the hub `snet-private-endpoints` subnet
id and the loom-unity UAMI principal), then `loom-unity-app.bicep` with the
Postgres `fqdn`/`aadUser` outputs, the Console's `LOOM_MSAL_CLIENT_ID` as
`entraClientId`, the Console UAMI's **principalId** as `consolePrincipalId`, and
`consoleAllowedCidrs=[<CAE infrastructure subnet CIDR>]`. Both module headers
carry the exact `az deployment group create` invocation. What-if first; grant
the loom-unity UAMI AcrPull before the app deploy or the first revision fails
its image pull. The Console's `LOOM_UNITY_*` env still arrives only via the
admin-plane deploy.

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

## Cost (Azure-native Commercial baseline)

| Component | Approximate $/month |
|---|---|
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
| **Total** | **~$2,050-4,550/mo** |

**Optional add-on — only with `LOOM_SEMANTIC_MODEL_BACKEND=powerbi`:** a Power
BI Premium F8 capacity for the Direct-Lake-Shim path adds **~$1,049/mo**. This is
**not** part of the Azure-native baseline above — the default Azure Analysis
Services tabular layer carries no separate capacity charge.

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
