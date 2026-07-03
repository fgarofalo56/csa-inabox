# Quick Start (~90 minutes)

The supported happy path: from `git clone` to a working CSA Loom Console URL in
Azure Commercial. The full deploy runs ~70–110 minutes depending on region and
capacity SKU.

> **Deploying to a Government boundary?** Use [GCC-High deployment](gcc-high.md)
> — it uses the same `az deployment sub create` flow with a Gov `.bicepparam`
> and covers the AKS / EP1 / Hive / no-Maps / no-AAS deltas.

## Prerequisites (5 min)

| Item | How to verify |
|---|---|
| Azure subscription with **Owner** + **User Access Administrator** (the deploy writes RBAC role assignments) | `az role assignment list --assignee <upn> --scope /subscriptions/<sub>` |
| Microsoft Entra tenant + rights to **create an Entra group** | `az ad signed-in-user show` |
| For the post-deploy bootstrap: a **Global Administrator** (or Privileged Role Admin) to consent the app registration's Graph permissions — this may be a *second* person | — |
| `az` CLI ≥ 2.60 (Bicep auto-installs via `az`) | `az --version` · `az bicep version` |
| An available `/16` IP range for the hub (default `10.0.0.0/16`) | check existing VNets |
| Quota for a **Databricks Premium** workspace in your region | `az vm list-usage --location eastus2` |

> **No Microsoft Fabric or Power BI Premium is required.** CSA Loom is
> Azure-native by default; Fabric / Power BI are strictly opt-in. Azure OpenAI
> quota is required in your region for the AI features; request it ahead of time
> if your subscription doesn't have it.

## Step 1 — Clone + authenticate (5 min)

```bash
git clone https://github.com/fgarofalo56/csa-inabox.git
cd csa-inabox

az login
az account set --subscription <YOUR-SUBSCRIPTION-ID>
```

## Step 2 — Create the Entra group for Loom Admins (5 min)

The Console grants its admin surface (`/admin/*`) to the members of one Entra
group. Create it in **your** tenant and capture its object ID.

```bash
az ad group create --display-name "Loom Admins" --mail-nickname "loom-admins"

GROUP_ID=$(az ad group show --group "Loom Admins" --query id -o tsv)
USER_ID=$(az ad signed-in-user show --query id -o tsv)
az ad group member add --group "$GROUP_ID" --member-id "$USER_ID"
echo "Loom Admins group: $GROUP_ID"
```

## Step 3 — Deploy the infrastructure (40–90 min)

The deploy is a single subscription-scoped Bicep deployment. Pick the parameter
file for your boundary (`commercial-full.bicepparam` = Commercial, single-sub,
F8 — Admin Plane + one DLZ in the same subscription) and pass **your** admin
group as the one required override.

> **Why `deployAppsEnabled=false` here.** A brand-new deploy creates an **empty**
> Azure Container Registry. The Console/MCP/Copilot Container Apps pull their
> images from that ACR, so they cannot come up until the images are built and
> pushed (Step 3b). This first pass provisions everything **except** the
> Container Apps; `deployAppsEnabled=false` overrides the param file's default so
> the deploy doesn't fail trying to pull an image that doesn't exist yet.

```bash
# Preview what will be created (optional but recommended):
az deployment sub create \
  --location eastus2 \
  --template-file platform/fiab/bicep/main.bicep \
  --parameters platform/fiab/bicep/params/commercial-full.bicepparam \
  --parameters adminEntraGroupId="$GROUP_ID" \
  --parameters deployAppsEnabled=false \
  --what-if

# Deploy the infrastructure:
az deployment sub create \
  --name "csa-loom-$(date +%Y%m%d-%H%M)" \
  --location eastus2 \
  --template-file platform/fiab/bicep/main.bicep \
  --parameters platform/fiab/bicep/params/commercial-full.bicepparam \
  --parameters adminEntraGroupId="$GROUP_ID" \
  --parameters deployAppsEnabled=false
```

This provisions the **Admin Plane** (hub VNet + Private DNS zones + ACR +
Container Apps Env + AI Foundry + AI Search + Monitoring + Key Vault) and the
first **Data Landing Zone** (spoke VNet + Databricks + Synapse Serverless + ADX +
ADLS + parity services). The application Container Apps come up in Step 3b.

> **The `.bicepparam` sets every other choice** (boundary, `deploymentMode`,
> region, capacity SKU, topology). Edit that file to change region/SKU; the only
> value you must supply on the command line is `adminEntraGroupId`.

## Step 3b — Build the app images + bring up the Container Apps (15–25 min)

The ACR created in Step 3 is empty, so the Console and its sibling apps have no
image to run yet. The supported from-scratch app path is the
**`full-app-deploy-commercial.yml`** workflow: it temporarily opens the ACR,
builds every app image **server-side** with `az acr build` (works even though the
registry is private), re-locks the ACR to its private endpoint, then rolls the
Container Apps onto the new images.

```bash
# From your fork/clone, with repo secrets set (AZURE_CLIENT_ID / _SECRET /
# _TENANT_ID / _SUBSCRIPTION_ID). Builds + pushes all app images, then enables
# the Container Apps pointing at them:
gh workflow run full-app-deploy-commercial.yml \
  -f region=eastus2 \
  -f enable_apps_after=true
```

When it finishes, the Console Container App is live and the workflow prints its
Front Door / ingress URL. (A single `deployAppsEnabled=true` deploy against a
just-created empty ACR is **not** a shortcut for this — the images must be built
first; that is expected, not a bug.)

## Step 4 — Post-deploy bootstrap (10–15 min) — **required to sign in**

The deploy provisions the infrastructure, but sign-in and the governance
surfaces need a one-time bootstrap: the **MSAL app registration** (with the
Console's Front Door redirect URI), its Graph permission grants + admin consent,
Synapse SQL admin, Purview roles, and the Spark private-endpoint fix.

Run the bootstrap workflow against your freshly deployed resource group:

```bash
# GitHub Actions (from your fork/clone, with repo secrets set). region +
# admin_subscription are REQUIRED (no estate defaults). boundary selects the
# cloud + login secret set (Commercial | GCC | GCC-High | IL5):
gh workflow run csa-loom-post-deploy-bootstrap.yml \
  -f boundary=Commercial \
  -f region=eastus2 \
  -f admin_subscription=<YOUR-SUBSCRIPTION-ID>
```

> **This bootstrap also runs automatically.** `full-app-deploy-commercial.yml`
> and the Gov deploy workflows chain it after a real, kept deploy — so on the
> workflow-driven path you don't run it by hand. The command above is for a
> local/manual deploy or a re-run.

…or run the scripts directly against your deployment (no GitHub required):

```bash
scripts/csa-loom/bootstrap-msal-app-reg.sh   # app reg + redirect URI + KV secret
scripts/csa-loom/grant-graph-approles.sh     # Graph app-role grants (needs admin consent)
```

See [v3 tenant bootstrap](../v3-tenant-bootstrap.md) for the full list of
one-time tenant actions and exactly who must perform each (some require a
Global Administrator). **Skipping this step is the most common cause of a
"deployed but can't sign in" Console.**

## Step 5 — Verify the Console (5 min)

Open the Console URL and sign in with your Entra identity (a member of the Loom
Admins group). You should see the home hub, an empty Workspaces pane, the
Catalog, and a green Monitoring hub. First-run setup lives at `/setup`.

## What's next

1. [Tutorial 01 — First workspace](../tutorials/01-first-workspace.md)
2. [Tutorial 02 — First lakehouse](../tutorials/02-first-lakehouse.md)
3. [Loom Console overview](../console/index.md)

## Cost

An F8 single-sub Commercial deployment runs ~$3–5K/month of Azure consumption
under active use. Note the **idle floor**: APIM, Container Apps, AI Search, Key
Vault, Front Door (~$330/mo base), and Purview bill continuously, so a
provisioned-but-unused deployment still floors around $1–2K/month. Pause
Databricks + ADX from **Admin → Capacity** to cut active DBU/cluster cost.

## Teardown

```bash
# Delete the deployment's resource groups:
az group delete --name <your-admin-rg> --yes --no-wait
az group delete --name <your-dlz-rg> --yes --no-wait
```

> **Before redeploying under the same names**, purge the soft-deleted
> Key Vault, Cognitive/OpenAI, and APIM resources (they block name reuse):
> `az keyvault purge --name <kv>`, `az cognitiveservices account purge …`,
> `az apim deletedservice purge …`. See the deployment runbooks for the full
> purge sequence.
