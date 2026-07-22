# Secret rotation — MSAL + tracked standing credentials (S1)

**When to use:** the `/admin/health` **Secret & credential health** section (or
the secret-expiry alert from the `loom-default-alerts` action group / a
`secret-expiry:` GitHub issue) shows a credential **red (<7 days / expired /
DRIFT)** or **amber (<30 / <60 days)**.

**Why this matters:** the Console MSAL app is a confidential client with a
**2-year client secret**. On **2026-07-19** an expired/drifted secret broke
**all** production sign-in (`AADSTS7000215`) while every non-auth probe stayed
green. The S1 monitor (this runbook's alert source) exists so that never
happens silently again.

**Strategic context (S2 decision):** per
[msal-credential-strategy.md](msal-credential-strategy.md) the DECIDED long-term
fix is migrating the Console to a **federated identity credential (FIC —
managed identity as the client credential)**, which retires the 2-year secret
entirely. Until that migration completes (and for the OTHER tracked
credentials, which stay secret-based), THIS runbook is the rotation procedure.
Rotation here is the interim/rollback path, not the end state.

---

## 1. Identify the credential

The alert / health row names the source:

| Row | What it is | Rotation section |
|---|---|---|
| `<app> — client secret <name>` (Entra app) | The Console MSAL app registration's password credential (2-year clock) | §2 |
| `Key Vault secret loom-msal-client-secret` | The KV copy of the MSAL secret the Container App reads via secretRef | §2 (rotated together) |
| `Key Vault secret loom-msal-client-secret` marked **DRIFT** | The app registration has a NEWER credential than the vault copy — the running app may hold a stale secret (the 07-19 mode) | §2 (run it now) |
| `Key Vault secret synthetic-login-secret` | The V1 synthetic-monitor automation-account credential | §3 |
| Dataverse S2S secret | Commercial reuses the MSAL secret (`LOOM_DATAVERSE_CLIENT_SECRET` → secretRef `loom-msal-client-secret`, so §2 covers it); Gov has its own app — rotate per `docs/fiab/dataverse-app-user.md` | §2 / doc |

## 2. Rotate the MSAL client secret (the 07-19 fix, made routine)

Prereq: an identity with **Application Administrator** (or ownership of the
Console app) + **Key Vault Secrets Officer** on the hub vault. Gov: use the
`.us` portals/CLI cloud (`az cloud set --name AzureUSGovernment`).

```bash
APP_ID="<LOOM_MSAL_CLIENT_ID>"                  # /admin/env-config or az containerapp show
KV="<hub-key-vault-name>"                        # kv-loom-*
RG="<admin-resource-group>"                      # rg-csa-loom-admin*

# 1. Mint a NEW secret WITHOUT dropping the old one (zero-downtime overlap).
NEW_SECRET=$(az ad app credential reset --id "$APP_ID" --append --years 2 \
  --display-name "rotation-$(date +%Y%m%d)" --query password -o tsv)

# 2. Write it to Key Vault (the Container App secretRef source of truth).
az keyvault secret set --vault-name "$KV" --name loom-msal-client-secret --value "$NEW_SECRET" -o none

# 3. Refresh the Container App secret + roll a revision (KV secretRefs are
#    resolved at revision activation — a roll is REQUIRED for pickup).
az containerapp secret set -n loom-console -g "$RG" \
  --secrets "loom-msal-client-secret=keyvaultref:https://$KV.vault.azure.net/secrets/loom-msal-client-secret,identityref:system" 2>/dev/null || true
az containerapp update -n loom-console -g "$RG" \
  --set-env-vars "LOOM_ROTATION_STAMP=$(date +%s)"   # forces a new revision

# 4. VERIFY sign-in before removing the old credential:
#    - interactive browser login on the live URL,
#    - the loom-ui-verify login-health job (catches AADSTS7000215),
#    - /admin/health Secret & credential health → the DRIFT flag clears.

# 5. AFTER verification, delete the OLD expiring credential:
az ad app credential list --id "$APP_ID" --query "[].{keyId:keyId,end:endDateTime,name:displayName}" -o table
az ad app credential delete --id "$APP_ID" --key-id "<old-keyId>"
```

Rollback: the old credential still works until step 5 — if sign-in breaks after
the roll, `az containerapp revision activate` the previous revision (it still
references the prior secret value) and re-run from step 1.

## 3. Rotate the synthetic-login secret (V1 automation account)

```bash
# Reset the automation account's password (least-privilege account, V1):
NEW=$(openssl rand -base64 24)
az ad user update --id "<SYNTHETIC_LOGIN_UPN>" --password "$NEW" --force-change-password-next-sign-in false
az keyvault secret set --vault-name "$KV" --name synthetic-login-secret --value "$NEW" -o none
# The synthetic-monitor job reads the secretRef at next run — verify J1 goes green.
```

## 4. One-time setup — Graph consent for the S1 monitor Function

The `secret-expiry-monitor` Function reads the app registration via Graph.
`Application.Read.All` is a Graph **app role** (not ARM) — grant it ONCE per
estate to the Function's system identity (`secretExpiryPrincipalId` output of
`admin-plane/main.bicep`):

```bash
FUNC_MI="<secretExpiryPrincipalId>"
GRAPH_SP=$(az ad sp show --id 00000003-0000-0000-c000-000000000000 --query id -o tsv)
APP_ROLE="9a5d68dd-52b0-4cc2-bd40-abcf44ac3a30"   # Application.Read.All
az rest --method POST \
  --url "https://graph.microsoft.com/v1.0/servicePrincipals/$FUNC_MI/appRoleAssignments" \
  --body "{\"principalId\":\"$FUNC_MI\",\"resourceId\":\"$GRAPH_SP\",\"appRoleId\":\"$APP_ROLE\"}"
# Gov: --url https://graph.microsoft.us/... (DoD: dod-graph.microsoft.us)
```

Until granted, the Function logs an honest gate and still monitors the Key
Vault half; the `/admin/health` section works regardless (the Console UAMI
already holds Application.Read.All from post-deploy bootstrap).

## 5. Verify the monitoring loop end-to-end (acceptance drill)

Seed a 5-day expiry and watch the alert fire:

```bash
az keyvault secret set --vault-name "$KV" --name secret-expiry-drill \
  --value drill --expires "$(date -u -d '+5 days' +%Y-%m-%dT%H:%M:%SZ)" -o none
az functionapp config appsettings set -n <func-secexp-*> -g "$RG" --settings \
  "LOOM_SECRET_EXPIRY_KV_SECRETS=loom-msal-client-secret,synthetic-login-secret,secret-expiry-drill" -o none
# Trigger a tick (or wait for the daily cron), then:
#  - the loom-default-alerts action group delivers (email / ARM-role receivers),
#  - /admin/health shows the drill row RED (critical, 5d left),
#  - a dedup GitHub issue "secret-expiry: Key Vault secret secret-expiry-drill — critical" opens.
# Clean up: remove the drill secret + restore the app setting.
```

## Related

- [msal-credential-strategy.md](msal-credential-strategy.md) — S2: the decided
  FIC migration that retires the MSAL secret (rotation becomes unnecessary for
  the MSAL app at its Phase 4 end state; S3's auto-rotation workflow is the
  documented fallback).
- `azure-functions/secret-expiry-monitor/README.md` — monitor internals +
  rollback.
- [secrets-bootstrap.md](secrets-bootstrap.md) — first-deploy secret
  provisioning per boundary.
