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

These are wired automatically by `platform/fiab/bicep/modules/admin-plane/main.bicep` — no manual step.

The manual step is: **register that SP as an Application User in each Dataverse-enabled env**, with an appropriate Security Role.

## One-time PPAC walkthrough (per env)

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
