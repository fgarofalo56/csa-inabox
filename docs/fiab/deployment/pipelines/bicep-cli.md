# Deploy CSA Loom via Bicep CLI (no `azd`)

The minimum-toolchain path: `az` CLI + Bash. Skip `azd`, skip GitHub
Actions, skip pipelines. Use when you want full visibility into the
deployment command line and don't want any tooling between you and ARM.

## Prerequisites

| Item | Notes |
|---|---|
| `az` CLI 2.64+ | `az upgrade` first |
| Logged in to Azure | `az login` (interactive) or `az login --service-principal` |
| Sub set | `az account set -s <sub-id>` |
| Contributor + UAA on the target sub | Required for both the platform resources and the role assignments Loom creates |

## Deploy Admin Plane + first DLZ (single command)

```bash
SUB_ID=$(az account show --query id -o tsv)
LOCATION=eastus2                                  # or usgovvirginia for Gov
BOUNDARY=commercial                                # commercial | gcc | gcc-high
ADMIN_GROUP=$(az ad group show --group "CSA Loom Admins" --query id -o tsv)

# Dry-run first so the deployment errors don't burn 30 minutes
az deployment sub validate \
  --location "$LOCATION" \
  --template-file platform/fiab/bicep/main.bicep \
  --parameters platform/fiab/bicep/params/${BOUNDARY}.bicepparam \
  --parameters loomAdminGroupObjectId="$ADMIN_GROUP"

# Real deploy
az deployment sub create \
  --name loom-$(date +%Y%m%d-%H%M%S) \
  --location "$LOCATION" \
  --template-file platform/fiab/bicep/main.bicep \
  --parameters platform/fiab/bicep/params/${BOUNDARY}.bicepparam \
  --parameters loomAdminGroupObjectId="$ADMIN_GROUP"
```

Run time: **~35-55 min** Admin Plane + **~15-40 min** first DLZ. Most of
the wall-clock is Synapse + Databricks + ADX provisioning.

## Per-boundary parameter files

| Boundary | Parameter file | Region defaults |
|---|---|---|
| Commercial | `params/commercial.bicepparam` | `eastus2` |
| GCC | `params/gcc.bicepparam` | `usgovvirginia` (M365 GCC identity) |
| GCC-High / IL4 | `params/gcc-high.bicepparam` | `usgovvirginia` |
| IL5 (v1.1) | `params/il5.bicepparam` | `usgovvirginia` |
| Full feature set | `params/commercial-full.bicepparam` | `eastus2` + every optional flag flipped on |

## Multi-sub mode

Repeat the `az deployment sub create` against each target subscription
with a DLZ-only bicepparam (Admin Plane only deploys once). See the
[multi-sub / multi-tenant page](../multi-sub-multi-tenant.md) for the
full sequence + VNet peering.

## Post-deploy bootstrap

After Bicep finishes, run the post-deploy bootstrap (Power BI tenant SP
grant, Databricks SCIM with allow-cluster-create, Dataverse AppUser):

```bash
bash scripts/csa-loom/bootstrap-all.sh \
  --boundary "$BOUNDARY" \
  --environment prod
```

## Validation

```bash
# Confirm the Loom Console is reachable + serving the latest build
LOOM_FQDN=$(az containerapp show -n loom-console -g rg-csa-loom-admin-${LOCATION} \
  --query 'properties.configuration.ingress.fqdn' -o tsv)
curl -fs "https://${LOOM_FQDN}/build-marker.txt"
```

Expected: `loom-build-marker sha=<commit> stamp=<iso> token=LOOM_LIVE_BUILD`.

## Teardown

```bash
# Lists every Loom RG and deletes them in parallel. Destructive.
az group list --query "[?starts_with(name, 'rg-csa-loom-')].name" -o tsv \
  | xargs -I {} az group delete --name {} --yes --no-wait
```

## Related

- [`azd up` flow](../azd-cli.md) — same Bicep with `azd`'s environment management
- [GitHub Actions](github-actions.md) — same commands wrapped in OIDC workflow
- [Azure DevOps](azure-devops.md) — same commands under ADO YAML pipelines
