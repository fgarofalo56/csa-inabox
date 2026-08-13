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
#
#    identityref MUST be the user-assigned Console UAMI — the same identity
#    that already resolves `session-secret` on the live Healthy revision, and
#    the one bicep + bootstrap-msal-app-reg.sh wire (#3025). It is NOT
#    `system`: pointing the reference at a system-assigned identity the app
#    does not use leaves it permanently unresolvable.
#
#    If the secret set FAILS, stop and fix that before rolling — do not
#    proceed with a stale secret. (An earlier revision of this step ended in
#    `2>/dev/null || true`, which swallowed exactly that failure — in a
#    recovery procedure. Per deploy-integrity.md R7, never again.)
UAMI_ID=$(az containerapp show -n loom-console -g "$RG" \
  --query "keys(identity.userAssignedIdentities)[0]" -o tsv)
az containerapp secret set -n loom-console -g "$RG" \
  --secrets "loom-msal-client-secret=keyvaultref:https://$KV.vault.azure.net/secrets/loom-msal-client-secret,identityref:$UAMI_ID"
#    Roll the revision. `--revision-suffix` is a revision-scope change, so this
#    creates and activates a NEW revision that re-resolves the Key Vault
#    reference — and it writes no env-var state, so nothing here is lost on the
#    next deploy. The suffix also names the rotation in `revision list`.
az containerapp update -n loom-console -g "$RG" \
  --revision-suffix "rotated-$(date -u +%Y%m%d-%H%M)"
#
#    THERE IS DELIBERATELY NO ROTATION-MARKER ENV VAR (#3025). This step used
#    to also stamp `LOOM_MSAL_SECRET_ROTATED`. On 2026-08-10 that marker was
#    measured ABSENT from all 425 env vars on the live loom-console: this
#    runbook and bootstrap-msal-app-reg.sh were its ONLY writers, it was never
#    declared in platform/fiab/bicep/modules/admin-plane/main.bicep, and the
#    next `az deployment sub create` re-renders the container template without
#    it — the same class that dropped the admin OID, LOOM_ADLS_ACCOUNT and the
#    Front Door vanity binding. A marker that vanishes on the next deploy is
#    read during AADSTS7000215 triage as "never rotated", which is worse than
#    no marker at all. Use §2.1 instead: the Entra credential list is the
#    record, and no redeploy can drop it.

# 4. VERIFY sign-in before removing the old credential:
#    - interactive browser login on the live URL,
#    - the loom-ui-verify login-health job (catches AADSTS7000215),
#    - /admin/health Secret & credential health → the DRIFT flag clears.
#
#    NOTE (#2837): before 2026-08 that login-health step could not fail — it
#    carried continue-on-error AND a trailing `exit 0`, so it printed
#    "::error::LOGIN BROKEN" and still concluded success. A green run of it
#    was NOT evidence that sign-in worked. It now exits non-zero on evidence
#    of a broken sign-in path (invalid_client hits / an expired credential)
#    and stays green only on "healthy" or "could not check" — so from that
#    version on, a green conclusion is meaningful. If you are verifying a
#    rotation against an older run, do not trust its green.

# 5. AFTER verification, delete the OLD expiring credential:
az ad app credential list --id "$APP_ID" --query "[].{keyId:keyId,end:endDateTime,name:displayName}" -o table
az ad app credential delete --id "$APP_ID" --key-id "<old-keyId>"
```

Rollback: the old credential still works until step 5 — if sign-in breaks after
the roll, `az containerapp revision activate` the previous revision (it still
references the prior secret value) and re-run from step 1.

### 2.1 "Which credential is the app actually using?" — the authoritative check

This is the question `AADSTS7000215` triage asks first, and the only sources
that answer it survive a redeploy. **Do not look for a rotation marker env var
on the Container App — there isn't one, on purpose (#3025, see step 3).**

```bash
# AUTHORITATIVE — the Entra app registration's credential list. This is the
# record: every mint appears here with its start/end, and no `az deployment sub
# create` can drop it. Two live credentials = a rotation whose step 5 never ran.
az ad app credential list --id "$APP_ID" \
  --query "[].{keyId:keyId,start:startDateTime,end:endDateTime,name:displayName}" -o table

# What the CONSOLE reads. A keyVaultUrl here means the value is resolved from
# Key Vault at revision activation, so the vault version timeline below is the
# vintage; an inline secret means the value was baked at wiring time.
# (Values are projected away on purpose — never print a secret.)
az containerapp secret list -n loom-console -g "$RG" \
  --query "[].{name:name,keyVaultUrl:keyVaultUrl,identity:identity}" -o table

# The Key Vault copy's own timeline — when the current version was written.
az keyvault secret list-versions --vault-name "$KV" --name loom-msal-client-secret \
  --query "[].{created:attributes.created,enabled:attributes.enabled}" -o table

# WHEN the running revision last re-resolved that reference. A revision created
# BEFORE the newest KV version is still serving the older secret: roll it.
az containerapp revision list -n loom-console -g "$RG" \
  --query "[?properties.active].{revision:name,created:properties.createdTime,state:properties.runningState}" -o table
```

Read them together: newest Entra credential ↔ newest Key Vault version ↔ a
revision created after both. Any gap in that chain is the rotation that did not
finish, and the fix is to re-run step 3 (secret set + roll), not to re-mint.

**Every boundary, same procedure.** These commands are identical in Commercial,
GCC, GCC-High, IL5 and DoD — only the cloud endpoint differs (`az cloud set
--name AzureUSGovernment` per the §2 prereq; Graph is `graph.microsoft.us` /
`dod-graph.microsoft.us`). The post-deploy bootstrap that performs the same
wiring, `.github/workflows/csa-loom-post-deploy-bootstrap.yml`, is one
cloud-agnostic workflow selected by its `boundary` input, so there is no
per-cloud variant of this runbook to keep in sync.

### 2.2 Credential sprawl — reuse, prune, and the ceiling (#3335)

**The defect.** Until #3335 the bootstrap minted a credential on EVERY
invocation and nothing removed one. Measured 2026-08-13 on the live Commercial
registration: **9 live password credentials, five minted that day** (05:26,
07:06, 08:27, 09:44, 12:50Z), each `--years 2`. The mint rate follows the
*deploy* rate — `deploy-fiab-commercial` ran 11 times that day and reaches
`bootstrap-msal-app-reg.sh` through this workflow's `workflow_call`. Sign-in
worked throughout; the defect was posture, not availability.

**What the bootstrap does now**, in order:

1. **Reuse.** The Key Vault secret carries an `msalKeyId` **tag** naming the
   credential the estate presents. (A tag, because the ARM secrets API never
   returns `properties.value` — provenance is readable without ever reading the
   secret.) If that credential is still on the app and has more than
   `LOOM_MSAL_SECRET_MIN_REMAINING_DAYS` (default 90) left, **nothing is
   minted and Key Vault is not touched.**
2. **Mint** only otherwise, always `--append`, always validated against Entra
   *before* Key Vault is written, and labelled `loom-console-<UTC timestamp>`
   so its key id can be resolved without racing a concurrent deploy.
3. **Prune** — see below. **Dry run by default.**
4. **Ceiling** — the live credential count is asserted against
   `LOOM_MSAL_CREDENTIAL_CEILING` (default 12, interim) and the run **fails**
   above it. That failure is hygiene, not availability: it runs after sign-in
   is wired, so it never means "login is broken".

**Reviewing what a prune would delete** (safe, deletes nothing):

```bash
# The default. Prints one line per credential with a keep/PRUNE verdict and the
# reason. Key ids and dates only — no value is read or printed at any point.
KEYVAULT_NAME="$KV" EXISTING_CLIENT_ID="$APP_ID" \
CONSOLE_APP_NAME=loom-console CONSOLE_RG="$RG" \
  bash scripts/csa-loom/bootstrap-msal-app-reg.sh
```

**Authorizing the prune** — only after reading the dry-run list:

```bash
LOOM_MSAL_PRUNE=1 KEYVAULT_NAME="$KV" EXISTING_CLIENT_ID="$APP_ID" \
CONSOLE_APP_NAME=loom-console CONSOLE_RG="$RG" \
  bash scripts/csa-loom/bootstrap-msal-app-reg.sh
```

**Why this cannot strand the running app.** A credential is deleted only when
ALL of the following hold, and each is printed in the dry run when it does not:

| # | Precondition |
|---|---|
| P1 | The prune runs LAST — after the mint was validated, Key Vault written, the Container App wired, and the revision rolled. Any of those failing exits the script first. |
| P2 | The in-use credential is **known** from the Key Vault tag, not guessed. No tag, an unreadable vault, or an unresolvable key id → the prune is **disarmed**. |
| P3 | The console's `loom-msal-client-secret` is provably an **unversioned** `keyvaultref` to that same secret. A versioned reference, an inline literal, or an unreadable binding degrades the prune to **already-expired credentials only**, which can strand nobody. |
| P3b | Every **active** revision was created at or after the Key Vault secret's last write. A KV reference is resolved at revision creation and then pinned, so an older active revision is still serving the previous version. |
| P4 | The candidate is not the in-use one, not among the newest `LOOM_MSAL_PRUNE_KEEP` (default 2), older than `LOOM_MSAL_PRUNE_MIN_AGE_DAYS` (default 7), and minted **strictly before** the in-use credential. |
| P5 | The keep set is computed before the first delete, so an interrupted run leaves a *superset* of it. There is no ordering that reaches zero. |

Residual risk, stated rather than implied: a consumer that captured a raw
credential value **out of band** — not through Key Vault — is invisible to this
script. P4's age and keep windows cover recent ones; the dry-run list is how you
check the rest. Commercial's Dataverse S2S reuses this credential but reads it
from the *same* Key Vault secret, so P3 covers it.

**Clearing an existing backlog — expect the first prune to be a no-op.** The 9
credentials measured on 2026-08-13 were minted within four days of each other,
so on a first cleanup **every one is inside the default 7-day grace** and
nothing is deleted. The run says so explicitly and names the knob. After reading
the dry run, narrow the window:

```bash
# 1. dry run with the narrowed window — still deletes nothing
LOOM_MSAL_PRUNE_MIN_AGE_DAYS=1 KEYVAULT_NAME="$KV" EXISTING_CLIENT_ID="$APP_ID" \
CONSOLE_APP_NAME=loom-console CONSOLE_RG="$RG" \
  bash scripts/csa-loom/bootstrap-msal-app-reg.sh

# 2. authorize it
LOOM_MSAL_PRUNE_MIN_AGE_DAYS=1 LOOM_MSAL_PRUNE=1 KEYVAULT_NAME="$KV" \
EXISTING_CLIENT_ID="$APP_ID" CONSOLE_APP_NAME=loom-console CONSOLE_RG="$RG" \
  bash scripts/csa-loom/bootstrap-msal-app-reg.sh

# 3. confirm the count and that sign-in still works
az ad app credential list --id "$APP_ID" --query "length(@)" -o tsv
```

The grace guards consumers this script cannot see; the console's own binding is
already proven independently by P3/P3b, so narrowing it for a reviewed one-off
cleanup is safe. Do not make the narrow value the default.

Once the count is down, lower `LOOM_MSAL_CREDENTIAL_CEILING` from its interim
**12** to **3** (`LOOM_MSAL_PRUNE_KEEP` + 1) so the alarm sits just above the
steady state instead of well above it.

**One-time migration.** An estate provisioned before #3335 has an untagged
secret, so the next run mints once more purely to establish provenance. To avoid
that, `--adopt-inferred` correlates the Key Vault secret's `updated` timestamp
with the credential start times and records the tag when **exactly one**
credential matches inside a 15-minute window. A tie or a miss adopts nothing and
falls back to minting — an inferred provenance that is merely plausible must
never authorize a delete.

**Why 1 year rather than 2.** The 2-year default existed because nothing renewed
automatically, so a long clock was the only protection against the 2026-07-19
expiry outage. Rule 1 above changes that: renewal now happens on the first
bootstrap run inside the 90-day window, and the measured gap between bootstrap
runs is at most ~31 days — roughly 3x of headroom — with the S1 expiry monitor
alerting at 60/30/7 days as a backstop. A shorter clock halves the exposure of
any single standing credential. The end state remains **no standing secret at
all** (the FIC migration in
[msal-credential-strategy.md](msal-credential-strategy.md)); this is the interim
posture, and `LOOM_MSAL_SECRET_YEARS=2` restores the old lifetime for an estate
that deploys less often than the renewal window.

**Verification:** `node --test scripts/ci/__tests__/msal-credential-lifecycle.test.mjs`
drives the real script against a stub `az` and pins every rule above;
`scripts/ci/check-msal-credential-hygiene.mjs` is the merge-blocking static half.

## 3. Rotate the synthetic-login secret (V1 automation account)

```bash
# Reset the automation account's password (least-privilege account, V1):
NEW=$(openssl rand -base64 24)
az ad user update --id "<SYNTHETIC_LOGIN_UPN>" --password "$NEW" --force-change-password-next-sign-in false
az keyvault secret set --vault-name "$KV" --name synthetic-login-secret --value "$NEW" -o none
# The synthetic-monitor job reads the secretRef at next run — verify J1 goes green.
```

## 4. One-time setup — Graph consent for the S1 monitor

> **B-FN (2026-07-27):** S1 is now the in-VNet `loom-secret-expiry-monitor`
> **Container App Job**, not a Y1 Function (Y1 is structurally broken on this
> estate — see [`docs/fiab/functions-to-aca-jobs.md`](../functions-to-aca-jobs.md)).
> It runs as the **Console UAMI**, so the consent below is the *same* grant the
> Identity Picker already needs. Estates that ran
> `scripts/csa-loom/grant-identity-graph-approles.sh` have **nothing to do
> here** — the separate Function-identity consent this section used to require
> no longer exists.

The monitor reads the app registration via Graph. `Application.Read.All` is a
Graph **app role** (not ARM) — grant it ONCE per estate to the Console UAMI
(`uamiConsolePrincipalId` output of `admin-plane/main.bicep`). The supported
path is the script:

```bash
./scripts/csa-loom/grant-identity-graph-approles.sh
```

Equivalent manual call, if you are granting only this one role:

```bash
CONSOLE_MI="<uamiConsolePrincipalId>"
GRAPH_SP=$(az ad sp show --id 00000003-0000-0000-c000-000000000000 --query id -o tsv)
APP_ROLE="9a5d68dd-52b0-4cc2-bd40-abcf44ac3a30"   # Application.Read.All
az rest --method POST \
  --url "https://graph.microsoft.com/v1.0/servicePrincipals/$CONSOLE_MI/appRoleAssignments" \
  --body "{\"principalId\":\"$CONSOLE_MI\",\"resourceId\":\"$GRAPH_SP\",\"appRoleId\":\"$APP_ROLE\"}"
# Gov: --url https://graph.microsoft.us/... (DoD: dod-graph.microsoft.us)
```

Until granted, the job logs an honest gate and still monitors the Key Vault
half; the `/admin/health` section works regardless.

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
