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

## Per-service reference

| Service | Reuse env var(s) | `*Enabled` flag (new) | UAMI role granted on reuse |
|---|---|---|---|
| AI Search | `EXISTING_AI_SEARCH_SERVICE` (+`_RG`) | `aiSearchEnabled` | Search Service + Index Data Contributor (+ enables AAD auth) |
| API Management | `EXISTING_APIM` (+`_RG`) | `apimEnabled` | API Management Service Contributor |
| ADX / Kusto | `EXISTING_KUSTO_CLUSTER` (+`_RG`) | `adxEnabled` | AllDatabasesAdmin principal assignment |
| AI Foundry / AOAI | `EXISTING_AOAI` (+`_RG`) | `aiFoundryEnabled` | Cognitive Services Contributor |
| Purview | `LOOM_PURVIEW_ACCOUNT` | `purviewEnabled` | (Graph app-roles via bootstrap) |
| Cosmos (navigator) | `EXISTING_COSMOS_ACCOUNT` (+`_RG`) | DLZ-provisioned | DocumentDB Account Contributor |
| Event Hubs | `EXISTING_EVENTHUB_NAMESPACE` (+`_RG`) | DLZ-provisioned | Event Hubs Data Owner + Contributor |
| Databricks | `EXISTING_DATABRICKS_HOSTNAME` | DLZ-provisioned | SCIM workspace SP (bootstrap) |
| Synapse / ADF | DLZ-provisioned (always) | — | Synapse Admin / ADF Contributor (bootstrap) |
| Azure SQL | bound per-item in the editor (any server) | — | per-server Entra admin |

> The four admin-plane services (AI Search, APIM, ADX, Foundry) gate their
> *provisioning module* on `empty(existing<Svc>)`, so naming an existing one
> never deploys a duplicate. DLZ services always provision a per-domain
> instance; to reuse instead, set the `EXISTING_*` override (the env-patch +
> RBAC scripts wire/grant the existing one).

## Examples

Reuse an existing AI Search service in another resource group, provision
everything else new:

```bash
export EXISTING_AI_SEARCH_SERVICE=my-shared-search
export EXISTING_AI_SEARCH_RG=rg-shared-ai
az deployment sub create -f platform/fiab/bicep/main.bicep \
  -p platform/fiab/bicep/params/commercial-full.bicepparam
# then, post-deploy:
EXISTING_AI_SEARCH_SERVICE=my-shared-search EXISTING_AI_SEARCH_RG=rg-shared-ai \
  bash scripts/csa-loom/grant-navigator-rbac.sh
```

Reuse the tenant Purview (only one Enterprise Purview is allowed per tenant, so
this is almost always a reuse):

```bash
export LOOM_PURVIEW_ACCOUNT=my-tenant-purview
```

Point the live console at an existing APIM without redeploying bicep:

```bash
EXISTING_APIM=my-apim EXISTING_APIM_RG=rg-apim \
  bash scripts/csa-loom/patch-navigator-env.sh
```
