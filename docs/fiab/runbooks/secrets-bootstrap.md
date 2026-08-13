# Secrets bootstrap — per boundary

> **Start with [Prerequisites and first deploy](../deployment/prerequisites.md).**
> That is the authoritative page — prerequisites → deploy → verify, with every
> secret and variable, how to obtain it, and how to confirm it took. This runbook
> is the per-boundary credential detail it links to.

The 4 boundary deploy workflows
(`deploy-fiab-{commercial,gcc,gcch,il5}.yml`) each authenticate to a
different Azure subscription. Each requires its own SP credentials.
Without these secrets, the workflow precheck skips with a clear
warning rather than failing — except `deploy-fiab-gcc.yml`, whose
**scheduled** runs fail rather than report a green no-op.

## Required secrets per boundary

### Commercial (already configured)

| Secret | Purpose |
|---|---|
| `AZURE_CLIENT_ID` | SP application (client) ID |
| `AZURE_CLIENT_SECRET` | SP secret |
| `AZURE_TENANT_ID` | Entra tenant ID |
| `AZURE_SUBSCRIPTION_ID` | Target subscription |
| `FIAB_ADMIN_GROUP_ID` | Entra group object ID for CSA Loom Admins. Read as `secrets.FIAB_ADMIN_GROUP_ID \|\| vars.FIAB_ADMIN_GROUP_ID` — a repo **variable** of the same name works too |

Plus one repo **variable**, which is not a secret and is easy to miss:

| Variable | Purpose |
|---|---|
| `FIAB_TENANT_ADMIN_OID` | Your Entra **user** object id. Bootstrap admin who bypasses the feature-permission gate. The deploy **refuses to render the Container Apps** when neither this nor `FIAB_ADMIN_GROUP_ID` resolves, because a Console with both empty has an admin gate nobody can pass. Set it: `gh variable set FIAB_TENANT_ADMIN_OID` |

### GCC

| Secret | Purpose |
|---|---|
| `AZURE_GCC_CLIENT_ID` | SP application ID (Azure Public AAD; M365 GCC identity) |
| `AZURE_GCC_CLIENT_SECRET` | SP secret |
| `AZURE_GCC_TENANT_ID` | GCC tenant ID |
| `AZURE_GCC_SUBSCRIPTION_ID` | Target GCC sub |
| `FIAB_GCC_ADMIN_GROUP_ID` | Entra group object ID for CSA Loom Admins (GCC) |

### GCC-High / IL5 (Azure Government)

Both Gov boundaries share one secret set. `deploy-fiab-gcch.yml` and
`deploy-fiab-il5.yml` read the same names.

| Secret | Purpose |
|---|---|
| `AZURE_GOV_CLIENT_ID` | SP application ID (Azure Government AAD) |
| `AZURE_GOV_CLIENT_SECRET` | SP secret |
| `AZURE_GOV_TENANT_ID` | Azure Government tenant ID |
| `AZURE_GOV_SUBSCRIPTION_ID` | Target Gov sub |
| `FIAB_GOV_ADMIN_GROUP_ID` | Entra group object ID for CSA Loom Admins (Gov) |

## Bootstrap procedure (Commercial template — adapt per boundary)

```bash
# 1. Create the deploy SP (one-time per tenant)
TENANT_ID=$(az account show --query tenantId -o tsv)
SUB_ID=$(az account show --query id -o tsv)
SP_NAME="limitlessdata_deploy"

az ad sp create-for-rbac \
  --name "$SP_NAME" \
  --role Contributor \
  --scopes "/subscriptions/$SUB_ID" \
  --output json
# Capture appId (== client-id) and password (== client-secret) from output.

# 2. Add User Access Administrator role for role-assignment ops
SP_OBJECT_ID=$(az ad sp list --display-name "$SP_NAME" --query "[0].id" -o tsv)
az role assignment create \
  --assignee-object-id "$SP_OBJECT_ID" \
  --assignee-principal-type ServicePrincipal \
  --role "User Access Administrator" \
  --scope "/subscriptions/$SUB_ID"

# 3. Create the Loom Admin group
ADMIN_GROUP=$(az ad group create \
  --display-name "CSA Loom Admins" \
  --mail-nickname "csa-loom-admins" \
  --query id -o tsv)
echo "Add operators to this group: $ADMIN_GROUP"

# 4. Populate GitHub secrets.
#    Omit --body: `gh` then prompts and reads from stdin, so the value never
#    lands in your shell history or a process listing.
gh secret set AZURE_CLIENT_ID
gh secret set AZURE_CLIENT_SECRET
gh secret set AZURE_TENANT_ID
gh secret set AZURE_SUBSCRIPTION_ID
gh secret set FIAB_ADMIN_GROUP_ID

# 5. And the bootstrap-admin variable (a repo variable, not a secret).
gh variable set FIAB_TENANT_ADMIN_OID   # az ad signed-in-user show --query id -o tsv
```

Verify presence — `gh secret list` prints names and timestamps, never values:

```bash
gh secret list | grep -E 'AZURE_|FIAB_'
gh variable list | grep -E 'FIAB_'
```

## GCC-specific notes

The same Azure Public AAD endpoints work, but the subscription lives
under a GCC M365 identity. The deploy SP must be created in the GCC
tenant — not the Commercial one.

## Gov (GCC-High / IL5) notes

The SP must be created in the **Azure Government** AAD endpoint:

```bash
az cloud set --name AzureUSGovernment
az login   # interactive Gov login
# Then steps 1-4 above using the Gov sub
```

The deploy workflow's `Azure/login@v2` step uses the Gov endpoint
overrides (already in `deploy-fiab-gcch.yml`):

```yaml
"activeDirectoryEndpointUrl": "https://login.microsoftonline.us",
"resourceManagerEndpointUrl": "https://management.usgovcloudapi.net/",
...
```

## Federated credential migration (future)

To switch any workflow from client-secret to OIDC (no secret on disk):

```bash
# Configure federated credential on the SP for the workflow subject.
# Subject format: "repo:<owner>/<repo>:<scope>"

az ad app federated-credential create --id $SP_APP_ID --parameters '{
  "name": "github-main-branch",
  "issuer": "https://token.actions.githubusercontent.com",
  "subject": "repo:fgarofalo56/csa-inabox:ref:refs/heads/main",
  "audiences": ["api://AzureADTokenExchange"]
}'

# For workflow_dispatch on any branch:
az ad app federated-credential create --id $SP_APP_ID --parameters '{
  "name": "github-workflow-dispatch",
  "issuer": "https://token.actions.githubusercontent.com",
  "subject": "repo:fgarofalo56/csa-inabox:environment:production",
  "audiences": ["api://AzureADTokenExchange"]
}'

# For environment-protected runs (GCC-High uses `gcc-high-deploy`):
az ad app federated-credential create --id $SP_APP_ID --parameters '{
  "name": "github-gcc-high-env",
  "issuer": "https://token.actions.githubusercontent.com",
  "subject": "repo:fgarofalo56/csa-inabox:environment:gcc-high-deploy",
  "audiences": ["api://AzureADTokenExchange"]
}'
```

Then in the workflow:
- Restore `id-token: write` in permissions
- Drop `clientSecret` from the creds JSON
- Drop the `AZURE_*_CLIENT_SECRET` GitHub secrets

## Verification

After secrets are in place, dispatch the corresponding workflow in
`whatif-only` mode:

```bash
# `region` is REQUIRED on the Commercial lane and has no default — GitHub
# REJECTS a dispatch that omits it. The region IS the identity of the estate
# (rg-csa-loom-admin-<region>, vnet-csa-loom-hub-<region>,
# uami-loom-console-<region> all derive from it), so a wrong value does not
# fail — it succeeds against a different, empty estate (#3029).
gh workflow run deploy-fiab-commercial.yml -f run_mode=whatif-only -f region=<region>

# The Gov/GCC lanes pin AZURE_LOCATION in the workflow env, so they take no
# region input.
gh workflow run deploy-fiab-gcc.yml   -f run_mode=whatif-only
gh workflow run deploy-fiab-gcch.yml  -f run_mode=whatif-only   # requires environment approval
gh workflow run deploy-fiab-il5.yml   -f run_mode=whatif-only
```

A green run with the "Note dry-run completion" step proves:
- Auth works
- Bicep template parses + validates against the real Azure tenant
- No real resources were spun up

## Related

- [Loom LAW monitoring + alert pack](loom-law-monitoring.md)
- [Deploy failure runbook](deploy-failure.md)
- Memory pointer: `azure-deployment-principal` (the `limitlessdata_deploy` SP convention)
