# Runbook — Databricks cluster create returns PERMISSION_DENIED

## Symptom

In the **Databricks Cluster** editor (Loom Console), clicking **Save**
or **Create** fails with a MessageBar that contains:

```text
Save failed
createCluster failed 403: {"error_code":"PERMISSION_DENIED",
"message":"You are not authorized to create clusters. Please contact
your administrator.", ...}
```

Or, on older builds, the editor surfaces the raw 403 JSON without the
friendly hint.

## Why this happens

CSA Loom's **Cluster** editor calls the Databricks REST API
(`POST /api/2.1/clusters/create`) using the Console User-Assigned
Managed Identity as an authenticated Databricks workspace service
principal. The Databricks **SCIM ServicePrincipal** for that UAMI must
have the **`allow-cluster-create`** entitlement.

Loom deployments shipped before **2026-05-27** only granted two
entitlements during the post-deploy SCIM bootstrap:

- `workspace-access`
- `databricks-sql-access`

The two cluster-related entitlements were missing:

- `allow-cluster-create` ← required for `clusters/create`
- `allow-instance-pool-create` ← required if the spec references a
  Loom-managed pool

`platform/fiab/bicep/modules/landing-zone/databricks-scim-bootstrap.bicep`
has been patched to include all four entitlements, **and** to
**`PATCH`** the existing SP rather than no-op on the 409 if it already
exists. Existing deployments still need to re-run the script once to
inherit the new entitlements.

## Remediation (two options)

### Option A — Re-run the SCIM bootstrap via `azd up` (recommended)

```bash
cd platform/fiab
azd up --no-prompt
```

`azd up` re-evaluates the bicep, sees the `Microsoft.Resources/deploymentScripts`
resource, and re-runs the SCIM bootstrap. Because the script now detects
the 409 and `PATCH`es the SP's entitlements list, every existing
deployment lands the missing `allow-cluster-create` +
`allow-instance-pool-create` in one shot. Run time: ~2 minutes.

After the deployment finishes, retry **Save** in the Cluster editor —
the 403 should be gone.

### Option B — Manual SCIM PATCH (if you can't redeploy)

Run from any workstation that can reach the Databricks workspace API
(or use the spoke-VNet Bastion jumpbox):

```bash
# 1. Get an AAD token for Databricks
TENANT="<your-tenant-id>"
SP_ID="<deploy-sp-client-id>"
SP_SECRET="<deploy-sp-secret>"
DBX_HOST="<workspace-id>.<region>.azuredatabricks.net"
DBX_SCOPE="2ff814a6-3304-4ab8-85cb-cd0e6f879c1d"

TOKEN=$(curl -sS -X POST \
  "https://login.microsoftonline.com/$TENANT/oauth2/v2.0/token" \
  -d "client_id=$SP_ID&client_secret=$SP_SECRET&scope=$DBX_SCOPE/.default&grant_type=client_credentials" \
  | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p')

# 2. Find the SCIM ServicePrincipal id for the Console UAMI
UAMI_APP="<console-uami-client-id>"
SP=$(curl -sS \
  "https://$DBX_HOST/api/2.0/preview/scim/v2/ServicePrincipals?filter=applicationId%20eq%20%22$UAMI_APP%22" \
  -H "Authorization: Bearer $TOKEN")
SP_ID=$(echo "$SP" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -n1)
echo "SP id: $SP_ID"

# 3. PATCH the entitlements list to the full four
curl -sS -X PATCH \
  "https://$DBX_HOST/api/2.0/preview/scim/v2/ServicePrincipals/$SP_ID" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/scim+json" \
  -d '{"schemas":["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
       "Operations":[{"op":"replace","path":"entitlements","value":[
         {"value":"workspace-access"},
         {"value":"databricks-sql-access"},
         {"value":"allow-cluster-create"},
         {"value":"allow-instance-pool-create"}
       ]}]}'
```

Expected response: HTTP 200 or 204 with the updated SP body.

## Verification

After remediation, in the Loom Console:

1. Open **Databricks Cluster** editor (any workspace).
2. Click **+** (new cluster), pick a node type + workers, give it a
   name.
3. Click **Save** / **Create**.
4. Expected: success toast `Created cluster <id> at HH:MM:SS`, the new
   cluster appears in the left rail with state `PENDING` → `RUNNING`.

If you still see PERMISSION_DENIED:

- Re-check the SCIM SP id and confirm the entitlements list on it
  contains all four values (use Option B step 1+2 with a `GET` instead
  of `PATCH`).
- Check whether the workspace has the **"Cluster create permission"**
  workspace-setting set to **No one** — if so, an admin needs to flip
  it back to **Allow all users** or grant the SP via the workspace
  permissions UI directly.
- Confirm the workspace isn't in **Premium SKU restricted mode** for
  cluster create.

## Related

- `platform/fiab/bicep/modules/landing-zone/databricks-scim-bootstrap.bicep`
- `apps/fiab-console/lib/editors/databricks-editors.tsx` — surfaces this
  remediation message inline on 403
- `apps/fiab-console/lib/azure/databricks-client.ts` — `createCluster()`
  helper
- [Databricks SCIM ServicePrincipals API](https://docs.databricks.com/api/workspace/serviceprincipals)
- [Databricks Clusters API 2.1 — create](https://docs.databricks.com/api/workspace/clusters/create)
