# secret-expiry-monitor (S1)

Timer-triggered Azure Function that turns "when does each standing Loom
credential die" into monitored data — prevention for the 2026-07-19
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
   Last-alerted band persists in a blob (`secret-expiry-state` container on the
   Function's own storage account) so a daily cron alerts once per escalation,
   not once per day.

Pure core (threshold math, merge, drift, transitions): `src/expiry-core.ts`,
unit-tested in `src/expiry-core.test.ts`. Thin wrappers: `src/azure-clients.ts`
(real Graph/KV/ARM/Blob/GitHub calls) + `src/functions/secretExpiryMonitor.ts`.
Shape mirrors `azure-functions/ops-agent-evaluator`.

## Infrastructure

`platform/fiab/bicep/modules/admin-plane/secret-expiry-monitor-function.bicep`
(Linux Y1 Consumption, system-assigned identity, **identity-based
`AzureWebJobsStorage__accountName` — no storage keys**), wired into
`admin-plane/main.bicep` via the `functionAppsConfig` R0 bag
(`secretExpiryEnabled` default ON, `secretExpiryCron`, `secretExpiryWarnDays`).

Roles declared in bicep (`skipRoleGrants`-aware, `guid()` names):

| Role | Scope | Why |
|---|---|---|
| Storage Blob Data Owner | the Function's storage account | identity-based host storage + the state blob |
| Storage Queue Data Contributor | the Function's storage account | host coordination |
| Key Vault Secrets User | the hub Key Vault | read tracked secret attributes |
| Monitoring Contributor | the admin RG | action-group read + `createNotifications` |

**One-time admin consent (cannot be ARM-granted):** the Graph app role
`Application.Read.All` on the Function's system identity — exact script in
`docs/fiab/runbooks/secret-rotation.md`. Until granted, the Graph half
honest-gates (logged) while the Key Vault half still works.

## Deploy the code

Same path as the sibling Functions (`func azure functionapp publish`):

```bash
cd azure-functions/secret-expiry-monitor
npm install && npm run build
func azure functionapp publish <secretExpiryFunctionName output> --typescript
```

## Rollback

- **Disable alerting only:** clear `LOOM_ALERT_ACTION_GROUP_ID` on the
  Function app (`az functionapp config appsettings set … LOOM_ALERT_ACTION_GROUP_ID=""`)
  — the inventory keeps running, alerts stop.
- **Stop the Function:** `az functionapp stop -n <name> -g <admin-rg>` (or set
  `functionAppsConfig.secretExpiryEnabled=false` and redeploy admin-plane —
  removes the module cleanly; it owns only its own SA/plan/site + role grants).
- **Roll back code:** re-publish the previous commit of this folder with
  `func azure functionapp publish` — the Function is stateless apart from the
  state blob, which is forward/backward compatible JSON (unknown keys ignored).
- **Console surface:** the `/admin/health` Secret-health section and
  `/api/admin/secret-health` read Graph + KV live and do NOT depend on this
  Function — they keep working during any rollback.

## Per-cloud

Commercial: defaults. Gov (GCC-High/IL5): bicep injects
`LOOM_GRAPH_BASE=https://graph.microsoft.us` (DoD: `dod-graph.microsoft.us`),
`LOOM_ARM_ENDPOINT=https://management.usgovcloudapi.net`, and the
`core.usgovcloudapi.net` storage suffix; the KV scope derives from the vault
URI host. IL5 (design): in-boundary Graph + in-tenant action-group sink only;
the GitHub dedup issue is disabled by leaving the token unset (the alert path
stays fully in-boundary).
