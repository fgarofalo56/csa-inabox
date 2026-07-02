# Dataverse Application User setup for Loom

> One-time per-environment step. Required so Loom can read Dataverse tables, Power Apps, Power Pages, AI Builder models, and Copilot Studio agents/knowledge in that env.

## Why this is needed

Loom's runtime authenticates to Azure services using a **User-Assigned Managed Identity** (UAMI) — `LOOM_UAMI_CLIENT_ID`. The UAMI works fine for Synapse, Cosmos, ADF, Kusto, AI Search, ARM, Power BI, and the **control-plane** Power Platform APIs (BAP, PowerApps API, Flow API).

Dataverse is the exception. Dataverse's **Application User** feature only accepts **Entra App Registrations** — Managed Identities aren't valid. This is a Microsoft platform restriction documented at https://learn.microsoft.com/power-platform/admin/manage-application-users.

So for any `*.crm.dynamics.com` scope, Loom routes the token request through a **ClientSecretCredential** against the existing MSAL Web App SP (the same SP that handles user sign-in), via env vars:

| Env var | Source |
|---|---|
| `LOOM_DATAVERSE_CLIENT_ID` | Same value as `LOOM_MSAL_CLIENT_ID` (e.g. `9844c28c-3b3a-4949-8d63-9eefa3b50a9d`) |
| `LOOM_DATAVERSE_CLIENT_SECRET` | KV secret `loom-msal-client-secret` (same as `LOOM_MSAL_CLIENT_SECRET`) |
| `LOOM_DATAVERSE_TENANT_ID` | `tenant().tenantId` from bicep |
| `LOOM_COPILOT_STUDIO_ENVIRONMENT_ID` | Power Platform environment GUID for the data-agent **Publish to Microsoft 365 Copilot** action (bicep param `loomCopilotStudioEnvironmentId`; empty = the editor lists discoverable envs + honest-gates) |

These are wired automatically by `platform/fiab/bicep/modules/admin-plane/main.bicep` — no manual step.

> **Day-one resilience (2026-06-23):** the console no longer *requires* the explicit
> `LOOM_DATAVERSE_CLIENT_ID` / `LOOM_DATAVERSE_CLIENT_SECRET` vars. If they're unset,
> `powerplatform-client.ts` falls back to `LOOM_MSAL_CLIENT_ID` / `LOOM_MSAL_CLIENT_SECRET`
> automatically — i.e. the SAME MSAL Web App SP that the post-deploy bootstrap
> (`scripts/csa-loom/dataverse-add-appuser.sh`) registers as the Dataverse Application
> User. So Dataverse-scoped features work even on deployments where the explicit bicep
> wiring didn't land. Setting a dedicated Dataverse app via the `LOOM_DATAVERSE_*` vars
> still takes precedence. The only remaining one-time action is the **Promote To Admin**
> click on the Default env (Step 1 below) so the bootstrap caller can register the App User.

## Publish a data agent to Microsoft 365 Copilot

Once the App User above exists in a **Copilot Studio-enabled** environment, the
data-agent editor's **Publish → Publish to Microsoft 365 Copilot** button does the
end-to-end publish via the Dataverse Web API:

1. Upserts a Copilot Studio agent (`msdyn_copilot`) seeded from the data agent's
   instructions + typed sources (idempotent by name).
2. Publishes it (`msdyn_PublishCopilot`).
3. Enables the **Teams and Microsoft 365 Copilot** channel (`msdyn_botchannels`,
   type `msteams`) with *Make agent available in Microsoft 365 Copilot* set.

Set `LOOM_COPILOT_STUDIO_ENVIRONMENT_ID` (bicep param `loomCopilotStudioEnvironmentId`)
to pin the target environment; otherwise the editor lists every Dataverse-enabled
environment the App User can see and lets the author pick one.

**Tenant admin approval (one-time per agent):** after publish, the agent appears as
a request in the [Microsoft 365 admin center](https://admin.microsoft.com/) →
**Agents → All agents → Requests**. An admin approves it to make it discoverable in
the M365 Copilot Agent Store (**Agents → Built by your org**). This approval is a
tenant action outside Loom's RBAC and cannot be automated by the console.

The manual step is: **register that SP as an Application User in each Dataverse-enabled env**, with an appropriate Security Role.

## One-time per-env setup

The naive "use PPAC's New app user button" path runs into the **stub user gotcha** on the Default env — adding Dataverse to a Default env doesn't auto-promote the operator to Dataverse System Administrator. Without SA, PPAC's role picker won't render the SA option, and the AppUser create API returns 403 `prvCreateUser missing`.

The reliable end-to-end recipe (verified working on Limitless Data tenant, 2026-05-26):

### Step 1 — Promote yourself to Dataverse System Administrator

Required because adding Dataverse to a Default env makes you only `Environment Maker + Basic User`, not SA.

1. Open `https://<org>.crm.dynamics.com/main.aspx?settingsonly=true&pagetype=entitylist&etn=systemuser` (replace `<org>` with the env's Dataverse host, e.g. `orgd9f634de`).
2. Tick the checkbox next to your name in the user grid.
3. Click **Promote To Admin** in the top command bar → **OK** in the confirmation dialog.
4. Verify: `az rest --method get --url "https://<org>.crm.dynamics.com/api/data/v9.2/systemusers(<your-systemuserid>)/systemuserroles_association?\$select=name" --resource "https://<org>.crm.dynamics.com"` should list **System Administrator**.

### Step 2 — Create the AppUser + assign SA role via Dataverse Web API

Bypasses PPAC entirely. Pure REST:

```bash
DV_URL="https://<org>.crm.dynamics.com"
TOKEN=$(az account get-access-token --resource "$DV_URL" --query accessToken -o tsv)
APP_CLIENT_ID="<LOOM_MSAL_CLIENT_ID>"   # e.g. 9844c28c-3b3a-4949-8d63-9eefa3b50a9d
BU_ID=$(curl -s -H "Authorization: Bearer $TOKEN" \
  "$DV_URL/api/data/v9.2/businessunits?\$select=businessunitid&\$filter=parentbusinessunitid%20eq%20null" \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['value'][0]['businessunitid'])")
ROLE_ID=$(curl -s -H "Authorization: Bearer $TOKEN" \
  "$DV_URL/api/data/v9.2/roles?\$select=roleid&\$filter=name%20eq%20'System%20Administrator'%20and%20_businessunitid_value%20eq%20$BU_ID" \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['value'][0]['roleid'])")

# Create the AppUser
NEW=$(curl -s -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "OData-Version: 4.0" -H "Content-Type: application/json" -H "Prefer: return=representation" \
  -d "{\"applicationid\":\"$APP_CLIENT_ID\",\"businessunitid@odata.bind\":\"/businessunits($BU_ID)\",\"firstname\":\"CSA Loom\",\"lastname\":\"Console (UAT)\"}" \
  "$DV_URL/api/data/v9.2/systemusers")
NEW_USER_ID=$(echo "$NEW" | python3 -c "import json,sys; print(json.load(sys.stdin)['systemuserid'])")

# Assign System Administrator
curl -s -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "OData-Version: 4.0" -H "Content-Type: application/json" \
  -d "{\"@odata.id\": \"$DV_URL/api/data/v9.2/roles($ROLE_ID)\"}" \
  "$DV_URL/api/data/v9.2/systemusers($NEW_USER_ID)/systemuserroles_association/\$ref"
```

### Why we can't fully automate Step 1

`Promote To Admin` requires the **legacy Dynamics 365 UI** (`main.aspx` settings page) which uses a different auth flow than PPAC and has no REST equivalent for this exact action. A tenant admin must click it once per env at first provisioning. Once Step 1 is done, Step 2 is fully scriptable and can be added to the post-deploy bootstrap workflow.

## Legacy PPAC walkthrough (if you prefer the UI for Step 2)

1. Open https://admin.powerplatform.microsoft.com/manage/environments and select the target env (must have a Dataverse database — see [v3-tenant-bootstrap.md](./v3-tenant-bootstrap.md) §"Add Dataverse").
2. Sidebar **Settings** → **Users + permissions** → **Application users**, or directly: `https://admin.powerplatform.microsoft.com/manage/environments/<orgId>/appusers`
3. Click **+ New app user** in the top command bar.
4. **+ Add an app** → search for and select **CSA Loom Console (UAT)** (or whatever your `LOOM_MSAL_CLIENT_ID` SP is named) → **Add**.
5. **Business unit**: pick the default org BU (matches the env's org name, e.g. `orgd9f634de`).
6. **Security roles** → click the pencil ✎ → check **System Administrator** → **Save**.
   - System Administrator lets Loom read every table + every Power App + every Page in the env. If you want least-privilege:
     - **Basic User** = read-only over standard tables only — too restrictive for Loom (it can't list custom tables or apps).
     - **System Customizer** = good middle ground but can't read Application User records, breaks Loom's self-discovery.
     - **Custom role** = ideal long-term: grant only `prvReadEntityXxx` on the entities Loom needs to surface. Listed in `lib/azure/powerplatform-client.ts`. Out of scope for first-deploy.
7. **Create**.

## Verify

After ~30 seconds (Dataverse role cache), run:

```bash
SESSION_SECRET=<from-KV> pnpm exec playwright test --project=uat e2e/editors.uat.ts -g "dataverse-table|power-app|power-page|copilot-studio"
```

All four should flip from `B` (env doesn't have Dataverse / 403 not a member) to `A` (renders cleanly, real backend responded).

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| `403 The user is not a member of the organization` | This setup wasn't done in the target env | Re-run the walkthrough above for that env |
| `403 missing privilege prvReadEntityXxx` | Loom is hitting a table the assigned role doesn't cover | Either upgrade the SP to System Administrator, or add the missing entity perm to the custom role |
| `404 environment .. has no Dataverse` | Env doesn't have a Dataverse DB | Add database via PPAC env detail → **+ Add Dataverse** (separate step, see v3-tenant-bootstrap.md) |
| Loom returns 401 on calls that worked before | Client secret rotated or expired | Rotate KV `loom-msal-client-secret`; the Container App reads it via secretRef so a restart pulls the new value |

## Why this can't be fully automated yet

The PPAC App User creation API exists at `https://api.powerapps.com/providers/Microsoft.PowerApps/scopes/admin/environments/{envId}/applicationUsers` — but **only the env's own existing System Administrators can call it**. There's no bootstrap path: the first SA on a fresh Dataverse DB has to be added by a Global Admin via PPAC. After that, Loom could be granted permissions to add additional SPs to other envs — but the v3 release doesn't include that flow. Tracked for a later release.
