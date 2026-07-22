# Runbook — Synthetic user-journey monitor (V1)

**Surface:** `/admin/health?tab=journeys` · **Job:** `loom-synthetic-monitor` (Container App Job, console CAE) · **Workflow:** `.github/workflows/loom-synthetic-monitor.yml` · **Bicep:** `platform/fiab/bicep/modules/admin-plane/synthetic-monitor-job.bicep` (enable flag: `observabilityConfig.syntheticMonitorEnabled`, default **ON**)

Six real end-to-end journeys run against the LIVE deployment every 15 minutes, in-VNet, on two auth paths:

| # | Journey | Proves |
|---|---------|--------|
| J1 | **TRUE MSAL login** (`/auth/sign-in` → Entra → `/auth/callback`) | sign-in itself — the 2026-07-19 `AADSTS7000215` class minted-session monitoring misses |
| J2 | Create item | Cosmos write path |
| J3 | Editor mount + lakehouse tables | editor chunk (GuidedPickerRail-freeze class) + real ADLS |
| J4 | Warehouse query | Synapse TDS |
| J5 | Marketplace subscribe | grant persisted |
| J6 | Git/SCM binding + deployment pipelines | promotion-path reads |

Exit-code semantics: **realFails only** (honest infra gates exit 0). A `Failed` execution ⇒ a code or sign-in regression.

## Triage a red run

1. Open the **Journeys tab** — the failing journey's note names the endpoint + status.
2. **J1 red, J2–J6 green ⇒ SIGN-IN is broken while the app is healthy.** Verify/rotate the MSAL client secret first (app `5c59f3f3…` → ACA secret `loom-msal-client-secret`, then a new revision — see memory `csa_loom_msal_secret_outage_2026_07_19` / login-health preflight #2191).
3. Logs: Log Analytics `ContainerAppConsoleLogs_CL | where ContainerAppName_s == 'loom-synthetic-monitor'` — look for `UAT_RESULT` / `UAT_FAIL` / `CRASH=[…]` lines.
4. Artifacts: Blob `LOOM_UAT_RESULTS_ACCOUNT`/`LOOM_UAT_RESULTS_CONTAINER` under `uat-runs/synthetic/<runId>/` (report.json, verdicts.ndjson, screenshots/traces).
5. Alerts: failures notify the shared action group `loom-default-alerts` (email + subscription-Owner receivers) and open/update the dedup GitHub issue labeled `synthetic-monitor`.

## J1 credential (SYNTHETIC_LOGIN_UPN / SYNTHETIC_LOGIN_SECRET)

Absent ⇒ J1 records an honest **skip** (never a fail). To wire it:

1. Create a **least-privilege** Entra automation account — member of nothing beyond one Loom synthetic test workspace.
2. Store its password in Key Vault: `kv-loom-*/synthetic-login-secret`.
3. Set `observabilityConfig.syntheticLoginUpn` + `syntheticLoginSecretUri` (the KV secret URI) and redeploy the admin plane (or set the job secrets by hand).
4. Conditional Access: a **named-location exception** scoped to the monitor's egress IP — never a blanket MFA carve-out.
5. Add an Entra sign-in alert for the account authenticating from any client other than the monitor (unexpected-use detection). Secret expiry is tracked by WS-S (S1).

## Operate

- One-shot run: `az containerapp job start -n loom-synthetic-monitor -g rg-csa-loom-admin-centralus` or dispatch the `loom-synthetic-monitor` workflow.
- Pause: `az containerapp job stop …` / flip `observabilityConfig.syntheticMonitorEnabled=false` and redeploy (removes the job).
- Hide the admin tab only: runtime flag `v1-journeys-tab` on `/admin/runtime-flags`.
- Retention: `uat-runs/synthetic/*` artifacts should carry a ~30d Blob lifecycle rule on the results account (4 runs/hr accumulate fast).
- Gov: identical job in the Gov estate (`.us` endpoints, `login.microsoftonline.us` authority, its own automation account). IL5 (design): the job's own cron is the GitHub-free path; issue-dedup is replaced by the in-boundary artifacts + this tab.
