# Bring-your-own services — reuse existing Azure resources or provision new

CSA Loom is **reuse-first**: every backing Azure service can either be **reused**
from a resource that already exists in *any* subscription/resource group, or
**provisioned new** by the deploy. You control this per-service via parameters,
environment variables, or (at runtime) the live-wiring scripts — so the same
template fits any enterprise scenario without edits.

## The model

For each service there are three states:

| State | How | Result |
|---|---|---|
| **Reuse existing** | set `EXISTING_<SVC>` (name) [+ `_RG` / `_SUB`] | the module is **skipped**; the Console wires to the existing resource |
| **Provision new** | leave `EXISTING_<SVC>` empty + the `*Enabled` flag `true` | a new resource is deployed and wired |
| **Honest gate** | leave both empty / flag `false` | the navigator renders a Fluent MessageBar naming the missing config — never a fake |

Reuse is resolved at three layers, all idempotent:

1. **Deploy time (fresh env)** — `params/<boundary>.bicepparam` reads
   `readEnvironmentVariable('EXISTING_*', '')`; when set, `main.bicep` skips the
   matching admin-plane module and wires the Console env to the existing resource.
2. **Post-deploy RBAC** — `scripts/csa-loom/grant-navigator-rbac.sh` grants the
   Console UAMI the per-resource roles on whatever resource was resolved
   (provisioned or reused), discovering names when not passed.
3. **Live env (already-running)** — `scripts/csa-loom/patch-navigator-env.sh`
   honors the same `EXISTING_*` overrides, else discovers in the Loom RGs, and
   patches the live `loom-console` container app (the live env can't re-run
   `main.bicep`). This is what reconciles non-deterministic values (Databricks
   workspace URL, cross-region ADX cluster URI) that bicep can't synthesize.

## Discover what already exists

```bash
# Read-only inventory across every subscription the signed-in principal sees,
# with ready-to-source EXISTING_* exports for each reusable resource.
bash scripts/csa-loom/discover-services.sh
```

### In-console: the Setup Wizard "Shared services" step (D6)

The Setup Wizard (`/setup`) has a dedicated **Shared services** step between
*Subscription & region* and *Domain name*. On entry it calls
`GET /api/setup/discover-services`, which runs a **single** Azure Resource Graph
query over the shared-service ARM types (Purview, Log Analytics, Key Vault,
AOAI/AI Services, Application Gateway / Front Door, AI Search, APIM, ADX) — one
query, not N, to respect ARG's 15-query / 5-second throttle. Resource Graph
honours RBAC, so only resources the Console identity can read are offered (no
mock data). For each service the operator picks **Reuse** / **Deploy new** /
**Gate** from a dropdown; a reuse pick is validated by
`POST /api/setup/validate-service` for region co-location, the Console UAMI's
read permission (real ARM GET), and SKU/model compatibility (AOAI: a chat +
embeddings deployment must exist in-region). Purview is detected as
one-per-tenant and **pinned to reuse** (deploy-new is blocked —
`EnterpriseTenantAlreadyExists`). The reuse selections flow into the deploy as
the matching `existing<Svc>` bicep parameters, generalising the
`loomPurviewAccount`-already-exists pattern. No Fabric type is ever scanned or
offered (Azure-native only).

## Generate a BYO bicepparam (the wizard)

`scripts/csa-loom/byo-wizard.sh` is a **bicepparam generator**: it scans every
subscription you can see, prompts **reuse / new / honest-gate** per service, and
writes a ready `params/<name>.generated.bicepparam` (drop-in for
`az deployment sub create -p`) plus a matching `temp/<name>.byo-exports.sh` with
the canonical `EXISTING_*` exports for the post-deploy scripts.

```bash
# Interactive (default boundary commercial-full):
bash scripts/csa-loom/byo-wizard.sh --boundary commercial-full

# Non-interactive (CI / 1-button) — drive each choice via env:
BYO_NONINTERACTIVE=1 \
  BYO_PURVIEW='reuse:dmlz-dev-purview-eastus:rg-dmlz-dev-governance-eastus:<sub>' \
  BYO_APIM='reuse:dml-ai-east-aigateway:rg-dlz-aiml-stack-dev:<sub>' \
  BYO_AISEARCH=new BYO_ADX=gate \
  bash scripts/csa-loom/byo-wizard.sh --boundary commercial-full --non-interactive
# → az deployment sub create -f platform/fiab/bicep/main.bicep \
#     -p platform/fiab/bicep/params/commercial-full.generated.bicepparam -l <region>
# → source temp/commercial-full.generated.byo-exports.sh && bash scripts/csa-loom/grant-navigator-rbac.sh
```

Each `BYO_<KEY>` = `reuse:<name>[:<rg>[:<sub>]]` | `new` | `gate`. Gov boundaries
(`gcc`, `gcc-high`, `il5`) force `fabricEnabled=false` (no Microsoft Fabric).

## Per-service reference

Every reuse pair captures **name + RG + subscription** (`…_SUB`) so cross-sub
reuse (e.g. a shared-governance-sub Purview) is a first-class deploy-time input.
The `…_SUB` value flows into the `LOOM_<SVC>_SUB` Console env var, which the
matching navigator client reads (`apim-client` → `LOOM_APIM_SUB`,
`synapse-dev-client`/`synapse-pool-arm` → `LOOM_SYNAPSE_SUB`,
`cosmos-account-client` → `LOOM_COSMOS_ACCOUNT_SUB`, `foundry-client` →
`LOOM_FOUNDRY_SUB`, `foundry-cs-client` → `LOOM_AOAI_SUB`, `adf-client` →
`LOOM_ADF_SUB`), falling back to `LOOM_SUBSCRIPTION_ID` when empty. The matching
management-plane RBAC role is granted on the reused resource in **its**
subscription by `grant-navigator-rbac.sh`. **Purview is the exception:** its
catalog data-plane is reached by account host (`{account}.purview.azure.com`) +
a portal-granted role, so it is subscription-agnostic — `EXISTING_PURVIEW_RG`/
`_SUB` are captured for discovery only and there is no `LOOM_PURVIEW_SUB`/`_RG`
runtime env wire.

| Service | Reuse env var(s) | `*Enabled` flag (new) | UAMI role granted on reuse |
|---|---|---|---|
| AI Search | `EXISTING_AI_SEARCH_SERVICE` (+`_RG` +`_SUB`) | `aiSearchEnabled` | Search Service + Index Data Contributor (+ enables AAD auth) |
| API Management | `EXISTING_APIM` (+`_RG` +`_SUB`) | `apimEnabled` | API Management Service Contributor |
| ADX / Kusto | `EXISTING_KUSTO_CLUSTER` (+`_RG` +`_SUB`) | `adxEnabled` | AllDatabasesAdmin principal assignment |
| AI Foundry / AOAI | `EXISTING_AOAI` (+`_RG` +`_SUB`) | `aiFoundryEnabled` | Cognitive Services Contributor |
| Purview | `EXISTING_PURVIEW` (+`_RG` +`_SUB`, discovery only) → sets `existingPurviewAccount` (overrides `loomPurviewAccount`) | `purviewEnabled` | Data Curator + Data Product Owner (Purview portal, data-plane) |
| Cosmos (navigator) | `EXISTING_COSMOS_ACCOUNT` (+`_RG` +`_SUB`) | DLZ-provisioned | DocumentDB Account Contributor + Built-in Data Contributor |
| Event Hubs | `EXISTING_EVENTHUB_NAMESPACE` (+`_RG` +`_SUB`) | DLZ-provisioned | Event Hubs Data Owner + Contributor |
| Synapse | `EXISTING_SYNAPSE` (+`_RG` +`_SUB`) | DLZ-provisioned | Synapse Admin (bootstrap) |
| Databricks | `EXISTING_DATABRICKS` (+`_RG` +`_SUB`) + `EXISTING_DATABRICKS_HOSTNAME` | DLZ-provisioned | SCIM workspace SP (bootstrap) |
| Data Factory | `EXISTING_ADF` (+`_RG` +`_SUB`) → `LOOM_ADF_NAME`/`_RG`/`_SUB` | DLZ-provisioned | Data Factory Contributor |
| Log Analytics | `EXISTING_LAW` (+`_RG` +`_SUB`) → `LOOM_BYO_LAW_WORKSPACE`/`_RG`/`_SUB` | DLZ-provisioned | Log Analytics Reader |
| Key Vault | `EXISTING_KEYVAULT` (+`_RG` +`_SUB`) → `LOOM_BYO_KEYVAULT`/`_RG`/`_SUB` | always-provisioned | Key Vault Secrets User |
| App Gateway / Front Door | `EXISTING_GATEWAY` (+`_RG` +`_SUB`) → `LOOM_BYO_GATEWAY`/`_RG`/`_SUB` | `appGatewayEnabled` | Contributor on the gateway |
| Azure SQL | bound per-item in the editor (any server) | — | per-server Entra admin |
| Microsoft Fabric | `fabricEnabled` (default **false** — Azure-native, no Fabric dependency) | — | n/a (opt-in only) |

> The four admin-plane services (AI Search, APIM, ADX, Foundry) gate their
> *provisioning module* on `empty(existing<Svc>)`, so naming an existing one
> never deploys a duplicate. DLZ services always provision a per-domain
> instance; to reuse instead, set the `EXISTING_*` override (the bicep wires the
> Console env to the reused resource; the RBAC + env-patch scripts grant/wire it).
> `…_SUB` values are pure string pass-throughs (NOT Bicep `existing` cross-sub
> references); post-deploy RBAC targets the resolved subscription.

## Examples

Reuse an existing AI Search service in another resource group, provision
everything else new:

```bash
export EXISTING_AI_SEARCH_SERVICE=my-shared-search
export EXISTING_AI_SEARCH_RG=rg-shared-ai
export EXISTING_AI_SEARCH_SUB=<sub-id>   # only when cross-subscription
az deployment sub create -f platform/fiab/bicep/main.bicep \
  -p platform/fiab/bicep/params/commercial-full.bicepparam
# then, post-deploy:
EXISTING_AI_SEARCH_SERVICE=my-shared-search EXISTING_AI_SEARCH_RG=rg-shared-ai \
  bash scripts/csa-loom/grant-navigator-rbac.sh
```

Reuse the tenant Purview (only one Enterprise Purview is allowed per tenant, so
this is almost always a reuse — often cross-subscription):

```bash
export EXISTING_PURVIEW=my-tenant-purview
export EXISTING_PURVIEW_SUB=<governance-sub-id>
```

Point the live console at an existing APIM without redeploying bicep:

```bash
EXISTING_APIM=my-apim EXISTING_APIM_RG=rg-apim \
  bash scripts/csa-loom/patch-navigator-env.sh
```

