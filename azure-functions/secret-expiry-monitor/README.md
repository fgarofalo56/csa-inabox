# secret-expiry-monitor (S1)

> **B-FN migration (2026-07-27): this is an in-VNet scheduled Container App
> Job — `loom-secret-expiry-monitor` — NOT an Azure Function.** Y1 Linux
> Consumption Functions are structurally broken on this estate (Azure Policy
> seals the storage data-plane: `publicNetworkAccess=Disabled`, AAD-only, no
> private endpoint, and the multitenant Y1 runtime is not a trusted service, so
> host keys / timer leases fail). The folder keeps its historical
> `azure-functions/` path; the runtime is a one-shot Node entrypoint
> (`src/main.ts`) in a container. Full rationale + fleet status:
> [`docs/fiab/functions-to-aca-jobs.md`](../../docs/fiab/functions-to-aca-jobs.md).

A scheduled job that turns "when does each standing Loom credential die" into
monitored data — prevention for the 2026-07-19
expired/drifted-MSAL-secret sign-in outage class, which recurs on a 2-year
clock (`entra-app-registration.bicep` mints the Console client secret with
`az ad app credential reset --years 2`).

## What it does (per `SECRET_EXPIRY_CRON` tick, default daily 06:00 UTC)

1. **Graph** — reads the Console MSAL app registration's
   `passwordCredentials[].endDateTime` via
   `GET /v1.0/applications(appId='{LOOM_MSAL_CLIENT_ID}')`.
2. **Key Vault** — reads `attributes.exp` / `attributes.updated` for every
   tracked secret (`LOOM_SECRET_EXPIRY_KV_SECRETS`, default
   `loom-msal-client-secret,synthetic-login-secret`).
3. **Compute** — days-to-expiry + band per credential
   (`expired | critical(≤7d) | warn30(≤30d) | warn60(≤LOOM_SECRET_EXPIRY_WARN_DAYS)`),
   plus **drift detection**: the app registration holding a NEWER credential
   than the KV copy is flagged `critical` (the exact 07-19 failure mode).
4. **Alert on band escalation** — fires the shared `loom-default-alerts`
   action group (`LOOM_ALERT_ACTION_GROUP_ID`, the O1 alert convention) via
   the Action Groups `createNotifications` API, and opens/updates a **dedup
   GitHub issue** per credential (optional, `LOOM_SECRET_EXPIRY_GITHUB_TOKEN`).
   Last-alerted band persists in a blob (`secret-expiry-state.json` in the
   `ops-state` container on the Loom lake storage account —
   `LOOM_OPS_STATE_ACCOUNT` / `LOOM_OPS_STATE_CONTAINER`) so a daily cron alerts
   once per escalation, not once per day. Unset account ⇒ an honest warning and
   a dedup-less pass, never a crash.

Pure core (threshold math, merge, drift, transitions): `src/expiry-core.ts`,
unit-tested in `src/expiry-core.test.ts`. Thin wrappers: `src/azure-clients.ts`
(real Graph/KV/ARM/Blob/GitHub calls) + `src/run-monitor.ts` (one pass) +
`src/main.ts` (the one-shot job entrypoint).

## Infrastructure

`platform/fiab/bicep/modules/admin-plane/secret-expiry-monitor-job.bicep`
(`Microsoft.App/jobs`, Schedule trigger, in the console's VNet-integrated
Container Apps Environment, running as the **console UAMI** — no host storage
account, no keys), wired into `admin-plane/main.bicep` via the
`functionAppsConfig` R0 bag (`secretExpiryEnabled` default ON,
`secretExpiryCron` — now a **standard 5-field cron**, `secretExpiryWarnDays`).

Roles declared in bicep (`skipRoleGrants`-aware, `guid()` names):

| Role | Scope | Why |
|---|---|---|
| Storage Blob Data Owner | the Function's storage account | identity-based host storage + the state blob |
| Storage Queue Data Contributor | the Function's storage account | host coordination |
| Key Vault Secrets User | the hub Key Vault | read tracked secret attributes |
| Monitoring Contributor | the admin RG | action-group read + `createNotifications` |

**One-time admin consent (cannot be ARM-granted):** the Graph app role
`Application.Read.All` on the **console UAMI** (the identity the job runs as) —
which is the same grant `scripts/csa-loom/grant-identity-graph-approles.sh`
already performs for the Identity Picker; exact script in
`docs/fiab/runbooks/secret-rotation.md`. Until granted, the Graph half
honest-gates (logged) while the Key Vault half still works.

## Deploy the code

Build the image and create/refresh the job:

```bash
ADMIN_RG=rg-csa-loom-admin-centralus SUB=<sub> CAE=cae-csa-loom-centralus CONSOLE_UAMI_ID=<uami-resource-id> CONSOLE_UAMI_CLIENT_ID=<uami-client-id> ACR=<acr>.azurecr.io ./scripts/csa-loom/deploy-secret-expiry-job.sh
```

One-shot run: `az containerapp job start -n loom-secret-expiry-monitor -g $ADMIN_RG`.

## Rollback

- **Disable alerting only:** clear `LOOM_ALERT_ACTION_GROUP_ID` on the job
  (`az containerapp job update … --set-env-vars LOOM_ALERT_ACTION_GROUP_ID=""`)
  — the inventory keeps running, alerts stop.
- **Stop the job:** `az containerapp job stop -n loom-secret-expiry-monitor -g <admin-rg>`
  (or set `functionAppsConfig.secretExpiryEnabled=false` and redeploy
  admin-plane — removes the job cleanly; it owns nothing else).
- **Roll back code:** `az containerapp job update --image <prev-tag>` — the job
  is stateless apart from the state blob, which is forward/backward compatible
  JSON (unknown keys ignored).
- **Console surface:** the `/admin/health` Secret-health section and
  `/api/admin/secret-health` read Graph + KV live and do NOT depend on this
  job — they keep working during any rollback.

## Per-cloud

Commercial: defaults. Gov (GCC-High/IL5): bicep injects
`LOOM_GRAPH_BASE=https://graph.microsoft.us` (DoD: `dod-graph.microsoft.us`),
`LOOM_ARM_ENDPOINT=https://management.usgovcloudapi.net`, and the
`core.usgovcloudapi.net` storage suffix; the KV scope derives from the vault
URI host. IL5 (design): in-boundary Graph + in-tenant action-group sink only;
the GitHub dedup issue is disabled by leaving the token unset (the alert path
stays fully in-boundary).
