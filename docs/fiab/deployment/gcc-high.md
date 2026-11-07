# For Azure Government (GCC-High / IL4)

!!! info "Comparative positioning note"
    This document is written from the
    perspective of Microsoft Azure, Cloud Scale Analytics, and CSA Loom. Any
    description of third-party or competing products, services, pricing, or
    capabilities is derived from **publicly available documentation and sources**
    believed accurate at the time of writing, and is provided for **general
    comparison only**. We do not claim expertise in, or authority over, any
    non-Microsoft product or service; the respective vendor's official
    documentation is the authoritative source for their offerings, which may
    change over time. Nothing here is intended to disparage any vendor — where a
    competing product has genuine advantages, we aim to note them honestly.
    Verify all third-party details against the vendor's current official
    documentation before making decisions.


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
| Azure Government subscription | Deployed to via GitHub Actions only — see [Deploy](#deploy--actions-only) |
| Region | `usgovvirginia` recommended (most services + AOAI chat models) + `usgovarizona` for OpenAI embeddings |
| Microsoft 365 GCC-High tenant | Identity provider |
| `AZURE_GOV_*` repository secrets | The deploy identity. **Missing secrets do not fail the workflow — they make it skip and report success** |
| AOAI quota in usgovvirginia | gpt-4o + gpt-4.1 + o3-mini + gpt-5.1 |
| AOAI quota in usgovarizona | text-embedding-3-large (Standard mode is usgovarizona-only) |

> **Optional — only with `LOOM_SEMANTIC_MODEL_BACKEND=powerbi`.** Azure Analysis
> Services is not offered in Azure Government, so the default GCC-High semantic-model
> path is the **Loom-native tabular layer** (definition persisted with the item,
> emitted as TMSL, queried via **Synapse Serverless `OPENROWSET(... FORMAT='DELTA')`**)
> — **no Power BI capacity is required**. If you opt into the Power BI backend,
> GCC-High supports **F-SKU (F8 minimum)**.

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

## Deploy — Actions only

**There is no local-CLI deployment path for GCC-High.** All Azure Government
deployment and verification runs through GitHub Actions; running Azure
Government `az` commands from a workstation is prohibited. The workflows carry
the Gov login endpoints and the `AzureUSGovernment` cloud switch internally.

> **An earlier version of this page published `az cloud set --name AzureUSGovernment`
> + `az login` + a single `az deployment sub create` as the GCC-High procedure.**
> That contradicted the Actions-only rule stated in
> [Greenfield](greenfield.md#azure-government-gcc-high--il4-and-dod-il5), and it
> also omitted `deployAppsEnabled=false`, the image phase and the bootstrap
> phase — so even setting the boundary rule aside, it could not have produced a
> working Console on a fresh subscription. It is corrected here rather than
> quietly removed.

The full walkthrough, including the three ways a green Gov run can mean nothing,
is in [**Greenfield → Azure Government**](greenfield.md#azure-government-gcc-high--il4-and-dod-il5).
Brownfield adoption on this boundary is in
[**Brownfield → Azure Government**](brownfield.md#azure-government-brownfield).

```bash
# 1. Build the app images into the sovereign ACR.
gh workflow run gov-build-images.yml -f boundary=GCC-High

# 2. Provision + bootstrap. All three inputs differ from the defaults, and all
#    three matter: whatif-only provisions nothing, and keep_resources=false
#    tears the estate down and skips the post-deploy bootstrap.
gh workflow run deploy-fiab-gcch.yml \
  -f run_mode=full \
  -f topology=tenant \
  -f keep_resources=true
```

The deploy requires manual approval on the `gcc-high-deploy` environment
protection rule before it touches the Gov subscription.

**Verification is also Actions-only:**

```bash
gh workflow run gov-verify-facts.yml
gh workflow run gov-gates.yml
```

Prerequisite: the `AZURE_GOV_CLIENT_ID` / `_SECRET` / `_TENANT_ID` /
`_SUBSCRIPTION_ID` repository secrets. **If any is missing, the workflow warns,
skips every downstream job, and still concludes `success`** — see
[when a green Gov run means nothing](greenfield.md#when-a-green-gov-run-means-nothing).

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

## Bootstrap with an existing console app registration

The post-deploy bootstrap (`csa-loom-post-deploy-bootstrap.yml`) normally
discovers the console app registration by **listing** app registrations. Listing
is tenant-wide, so it needs the Graph permission `Application.Read.All` or a
directory role; a deploy service principal with neither fails there with
`Insufficient privileges to complete the operation` (GCC-High run 39319044221),
which skips the `Estate.Power` role step and the repo-variables step after it.

If the console app registration already exists (operator-owned), supply it
instead. Brownfield rule R5: an existing value is a first-class input.

| Input (dispatch / `workflow_call`) | Repo variable fallback | Meaning |
|---|---|---|
| `console_app_client_id` | `LOOM_CONSOLE_APP_CLIENT_ID` | Client (app) id of the existing console app. Not a secret. |
| `console_app_object_id` (optional) | `LOOM_CONSOLE_APP_OBJECT_ID` | Object id; read by object id and cross-checked against the client id. |
| none | `LOOM_CONSOLE_APP_NAME` (optional) | Display name the app must carry. |

When the client id is supplied:

- The MSAL step reads that one app by id, validates it (app id, object id,
  `signInAudience = AzureADMyOrg`, optional display name) and changes nothing
  if it is not the expected app. It never lists app registrations and never
  creates one. A refusal is reported as *could not read, existence unknown*
  (naming `Application.Read.All`), a 404 as *not found*; the two are not mixed up.
  Not covered: the later `az ad app ... --id` calls in that script resolve the id
  with the Azure CLI's own filtered lookup, so the deploy identity still needs
  to be able to read that one app.
- The `Estate.Power` step reads the app and the two service principals by id (no
  listing). If the role and its assignment already exist it makes **zero
  writes**. It runs even when the MSAL step failed, and the repo-variables step
  runs whenever the `Estate.Power` step succeeded.
- The audience written to `CSA_LOOM_GCCH_CONSOLE_AUDIENCE` is derived from the
  app's live identifier URIs: `api://<appId>` when that URI is set, the bare
  app id when the app exposes none.

Without the input or variable nothing changes: discover-or-create, as before.

**What needs an admin and what does not**

| Action | Needs |
|---|---|
| List app registrations tenant-wide (discovery) | `Application.Read.All` or a directory role |
| Read one named app by id | `Application.Read.All`, or `Application.ReadWrite.OwnedBy` with the deploy SP as an owner of the app, or a directory role |
| Edit the app's `appRoles` (create `Estate.Power`) | `Application.ReadWrite.OwnedBy` + ownership of the app, or `Application.ReadWrite.All`, or Application Administrator |
| Assign the role to the deploy SP (appRoleAssignment) | `AppRoleAssignment.ReadWrite.All` or a directory role; app ownership does not cover it |
| Everything above, once the role and assignment exist | Reads only; no admin action per run |

The permission names in this table come from the Microsoft Graph permission
reference and were **not** exercised against a live Gov tenant; whether adding
the deploy SP as an owner of the app, with no Graph permission, is enough for an
app-only token has not been verified, and the step's error text says so. If the
`Estate.Power` step is refused (exit 3) the log names the exact change that was
missing and the fix. Once the operator has created the role and the assignment,
re-runs need no admin.

## Deploy time

- Admin Plane: 45-65 min (AKS cluster spin-up is slower than Container
  Apps)
- First DLZ: 20-40 min
- **Total to working Console: 70-110 min**

## Validation

Gov verification is Actions-only (`gov-verify-facts.yml` / `gov-gates.yml`,
above). A health probe from a machine that can reach the Gov console:

```bash
curl -i https://<your-gov-console-hostname>/api/health
```

Then sign in via browser using your GCC-High M365 identity. A `curl` 200 is not
a verification receipt — a deploy is verified by a live in-browser walk.

Compare the result against the recorded **Gov readiness ceiling**, not against
Commercial: the Gov ceiling is infrastructure-bound and legitimately lower, so a
Gov estate reporting fewer green capabilities than Commercial is not necessarily
broken.

## ITAR considerations

GCC-High supports ITAR-eligible workloads. Customer responsibility:
- Mark ITAR-restricted data with sensitivity labels
- Apply Purview ITAR classification rules
- Verify cross-cloud B2B is disabled or scoped per ITAR policy
- Configure Sentinel rules to detect ITAR-data egress

See [ITAR compliance page](../compliance/itar-fiab.md).

## Cost (Azure-native GCC-High baseline)

GCC-High pricing is typically **10-25% above** Azure Commercial:

| Component | Approximate $/month |
|---|---|
| Databricks Premium classic | $600-3,000 |
| Synapse Serverless | $5-50 |
| ADX cluster D14_v2 | $600 |
| ADLS Gen2 (10 TB) | $250 |
| AOAI Gov (50K TPM gpt-4o) | $250-600 |
| AI Search S1 | $300 |
| Purview | $350 |
| AKS cluster + workloads | $200-500 |
| Misc (KV Premium HSM, LA, Sentinel) | $200 |
| **Total** | **~$2,800-5,800/mo** |

**Optional add-on — only with `LOOM_SEMANTIC_MODEL_BACKEND=powerbi`:** a Power BI
Premium F8 capacity for the opt-in Power BI backend adds **~$1,200/mo**. It is
**not** part of the Azure-native baseline above — the default Loom-native /
Synapse Serverless semantic-model path carries no separate capacity charge.

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
