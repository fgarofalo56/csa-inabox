# MSAL sign-in handoff (Loom Console v2)

Date: 2026-05-24
Owner: csa-loom rebuild

## UPDATE 2026-06-15 — now AUTOMATED by default (GH #1383)

The manual `az ad app create` + `az containerapp secret set` steps below are no
longer the primary path. The push-button deploy now PROVISIONS the Entra app
registration by default (`loomMsalAppReg.enabled = true`, opt-out):

- **Bicep**: `platform/fiab/bicep/modules/admin-plane/entra-app-registration.bicep`
  runs an `azCLI` deploymentScript that creates/reconciles the app registration,
  reconciles its redirect URIs to the console host(s), enables public-client
  (device-code CLI) flows, ensures the delegated Graph `User.Read` scope, resets
  the client secret, and writes the secret + a stable `SESSION_SECRET` to Key
  Vault. It runs when a script identity with Graph app-admin is supplied
  (`loomMsalAppReg.scriptIdentityId`); otherwise the bootstrap below is the home.
- **Bootstrap workflow**: `.github/workflows/csa-loom-post-deploy-bootstrap.yml`
  → step "Provision MSAL app registration" runs the SAME logic via
  `scripts/csa-loom/bootstrap-msal-app-reg.sh` (so bicep + bootstrap never
  drift), then wires `LOOM_MSAL_CLIENT_ID` + the KV-backed secretRefs onto the
  Console Container App. This is the default push-button path.
- **`SESSION_SECRET`** is now set on the Console UNCONDITIONALLY (no longer gated
  behind a non-empty `loomMsalClientId`), and is KV-backed when the script
  provisioned it — so sign-ins survive redeploys (PRP deploy-readiness gap #3).
- **Bootstrap admin** is never blank: `loomTenantAdminOid` defaults to the
  deploying principal (`deployer().objectId`) when no oid/group is supplied, so
  `/admin/*` is reachable on first login (gap #4). Set the `tenant_admin_oid`
  deploy input (or `FIAB_ADMIN_GROUP_ID`) to name a human / group admin.
- **No hardcoded shared app id**: the `9844c28c-...` default was removed from
  `commercial-full.bicepparam` and the bootstrap workflow.
- **Honest gate**: `app/auth/sign-in/route.ts` now 503s on missing
  `LOOM_MSAL_CLIENT_ID` / `LOOM_MSAL_CLIENT_SECRET` / `AZURE_TENANT_ID` (not on
  the UAMI's `AZURE_CLIENT_ID`), so a missing credential is honest, not a 500.

**Still requires** a human Global/Application Administrator to grant admin
consent for the app's Graph permissions in Entra ID (the deploy SP can create
the app + reset the secret when it holds the Application Administrator directory
role, but tenant-wide consent is a one-time admin click). The
`scan-and-deploy.sh` CLI + the Setup Wizard "Identity & Admin" step
(`/api/setup/identity`) offer the same existing/new/disable choice with the
signed-in user recommended as bootstrap admin.

The original manual handoff (still valid as the BYO / Gov-sovereign fallback)
follows.

---

## Context (original, manual fallback)

The Loom Console BFF already has the MSAL plumbing (`lib/auth/msal.ts`,
`lib/auth/session.ts`, `app/auth/sign-in/route.ts`,
`app/auth/callback/route.ts`, `app/auth/sign-out/route.ts`,
`app/api/me/route.ts`). What it does NOT have yet is an Entra app
registration to point at.

The Console session running this rebuild is signed in as the
`limitlessdata_deploy` service principal (client `95ca491e-...`). That
SP intentionally does not have Microsoft Graph
`Application.ReadWrite.All`, so `az ad app create` returned
`ERROR: Insufficient privileges to complete the operation.`

That privilege belongs with a human Global Admin / Application Admin /
Cloud Application Admin, not the deploy SP. Below is the one-time
unblock you (Frank) need to do from your own account.

## One-time unblock (5 min)

```bash
# Sign in as yourself (not the SP) and pick the right tenant
az login --tenant <tenant-id>
az account set --subscription <YOUR_DLZ_SUBSCRIPTION_ID>   # DLZ

# Create the app reg with all three redirect URIs
APP=$(az ad app create \
  --display-name "Loom Console (UAT)" \
  --sign-in-audience AzureADMyOrg \
  --web-redirect-uris \
    "https://<your-console-hostname>/auth/callback" \
    "http://loom-m56yejezt7bjo.eastus2.cloudapp.azure.com/auth/callback" \
    "http://localhost:3000/auth/callback" \
  --query '{appId:appId, objectId:id}' -o json)

APP_ID=$(echo $APP | jq -r .appId)
OBJ_ID=$(echo $APP | jq -r .objectId)

echo "APP_ID=$APP_ID"

# Add a client secret (2-year)
SECRET=$(az ad app credential reset --id $APP_ID --years 2 --query password -o tsv)

# Grant the delegated User.Read scope (Microsoft Graph)
az ad app permission add --id $APP_ID \
  --api 00000003-0000-0000-c000-000000000000 \
  --api-permissions e1fe6dd8-ba31-4d61-89e7-88639da4683d=Scope

# Push the values onto the Container App
az containerapp secret set -g rg-csa-loom-admin-eastus2 -n loom-console \
  --secrets azure-client-secret=$SECRET session-secret=$(openssl rand -hex 32)

az containerapp update -g rg-csa-loom-admin-eastus2 -n loom-console \
  --set-env-vars \
    AZURE_TENANT_ID=<tenant-id> \
    AZURE_CLIENT_ID=$APP_ID \
    AZURE_CLIENT_SECRET=secretref:azure-client-secret \
    SESSION_SECRET=secretref:session-secret \
    AZURE_CLOUD=AzureCloud
```

Then verify in a private browser tab:

```
https://<your-console-hostname>/auth/sign-in
```

You should be redirected to `login.microsoftonline.com`, complete the
flow, and land back on `/` with the topbar showing your name +
avatar.

## What's already wired (no work needed)

| Component | File | Behavior |
|---|---|---|
| Confidential client | `apps/fiab-console/lib/auth/msal.ts` | Reads `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_CLOUD`. Picks commercial vs `login.microsoftonline.us` per `AZURE_CLOUD`. |
| Session cookie | `apps/fiab-console/lib/auth/session.ts` | AES-256-GCM, HttpOnly, Secure, SameSite=Strict, 8-hour TTL. Key derived via HKDF from `SESSION_SECRET`. |
| Sign-in initiator | `apps/fiab-console/app/auth/sign-in/route.ts` | 302 to AAD authorize URL. Returns 503 with a clear unblock message when MSAL env vars are missing. |
| Callback handler | `apps/fiab-console/app/auth/callback/route.ts` | Exchanges code for tokens, decodes claims, sets session cookie, redirects `/`. On error, redirects `/?auth_error=<reason>`. |
| Sign-out | `apps/fiab-console/app/auth/sign-out/route.ts` | Clears cookie + AAD federated sign-out. |
| Current-user endpoint | `apps/fiab-console/app/api/me/route.ts` | `{authenticated, user}` for the topbar. |
| Topbar avatar + menu | `apps/fiab-console/lib/components/app-shell.tsx` | Polls `/api/me`, renders Sign-in button (unauthenticated) or Avatar + dropdown with Sign out (authenticated). |

## Verification checklist

- [ ] `https://<console>/auth/sign-in` redirects to AAD (not 503).
- [ ] After login, `/api/me` returns `{authenticated: true, user: {...}}`.
- [ ] Topbar shows your name + avatar; clicking → Sign out clears the session.
- [ ] `/auth/sign-out` round-trips through `login.microsoftonline.com/logout`
      and lands back on `/` with the Sign-in button visible again.

## Gov cloud variant

For an IL5 / GCC-High deploy, set `AZURE_CLOUD=AzureUSGovernment`. The
MSAL authority and the sign-out URL both flip to
`login.microsoftonline.us` automatically. Redirect URIs in the app reg
must use the Gov cloud hostnames.

## CLI sign-in (`loom` CLI — device code)

The `loom` CLI (`@csa-loom/cli`) signs in via `POST /api/auth/cli-session`,
which runs the OAuth 2.0 **device-authorization grant** (RFC 8628) server-side
using the SAME Entra app registration as the browser flow (no new app, no new
secret, no new Azure resource). It mints the identical encrypted `loom_session`
cookie and returns the value to the CLI, which stores it `0600` and replays it
as the `Cookie` header — the same contract the browser uses.

One-time app-registration change (device code requires a public-client flow to
be allowed on the SAME `AZURE_CLIENT_ID`):

```bash
# Enable public client flows (idempotent) on the existing Loom app reg.
az ad app update --id "$APP_ID" --set isFallbackPublicClient=true
```

No env-var or Container App change is needed — the route reuses
`LOOM_MSAL_CLIENT_ID`/`AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `SESSION_SECRET`,
and `AZURE_CLOUD` that the browser sign-in already requires. The Gov-cloud
authority switch is inherited verbatim from `lib/auth/msal.ts`.

For non-interactive / CI use, the CLI also supports
`loom auth login --service-principal` which calls the same route with a
client-credentials grant (the SP's `oid` becomes the tenant partition). That
path needs no app-registration change.

Verify after enabling:

```bash
loom auth login --api-url https://<console-host>
#   prints a code + https://microsoft.com/devicelogin ; sign in, then:
loom auth status        # verifiedLive: true
loom workspace list
```


