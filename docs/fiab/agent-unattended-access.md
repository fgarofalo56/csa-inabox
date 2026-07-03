# Agent Unattended Access — Loom Console Verification

This runbook describes how the `loom-ui-verify` workflow authenticates against
the live CSA Loom console **without MFA and without user credentials**.

---

## Security model

The Loom console session is an encrypted cookie (`loom_session`). The cookie is
AES-256-GCM encrypted using a key derived from `SESSION_SECRET` via HKDF-SHA-256.
`SESSION_SECRET` itself lives only in the loom Key Vault (`session-secret`).

The unattended harness:

1. **OIDC login** — GitHub Actions fetches a short-lived OIDC token from GitHub's
   token endpoint and presents it to Azure AD via a **federated credential** on a
   dedicated service principal. No password or client secret is ever stored on disk
   or in GitHub secrets.
2. **KV read** — The SP has **Key Vault Secrets User** on the loom KV, which grants
   the minimum privilege needed to read a single named secret. It cannot write,
   delete, or list all secrets.
3. **Cookie mint** — `e2e/auth/mint-session.ts` derives the same AES key and
   produces a valid `loom_session` cookie entirely in-process. The cookie is held
   only in memory (Playwright storageState) for the duration of the CI job.
4. **No MSAL, no browser login, no MFA** — the minted cookie is accepted by the
   BFF's `getSession()` function as a normal authenticated session.
5. **Revocation** — access is revoked instantly by either rotating `SESSION_SECRET`
   (all existing sessions and automation tokens are invalidated) or by removing the
   SP's KV role assignment. No GitHub secret rotation is needed.

---

## One-time setup

### Step 1 — Create or choose a service principal

```bash
# Create a dedicated SP (recommended — separation from the deploy SP)
az ad sp create-for-rbac \
  --name "loom-ui-verify-sp" \
  --role "Reader" \
  --scopes "/subscriptions/<LOOM_SUBSCRIPTION_ID>"
```

Note the `appId` (client ID) and `tenantId` output.

### Step 2 — Add a GitHub OIDC federated credential

Navigate to **Azure portal → App registrations → loom-ui-verify-sp →
Certificates & secrets → Federated credentials → Add credential**.

| Field | Value |
|-------|-------|
| Federated credential scenario | GitHub Actions deploying Azure resources |
| Organization | `fgarofalo56` (or your org) |
| Repository | `csa-inabox` |
| Entity type | **Branch** |
| Branch | `main` |
| Name | `loom-ui-verify-main` |

Repeat for `workflow_dispatch` if you want manual runs on other branches; you
can use **Environment** or **Pull request** entity types as needed.

CLI alternative:

```bash
az ad app federated-credential create \
  --id <APP_OBJECT_ID> \
  --parameters '{
    "name": "loom-ui-verify-main",
    "issuer": "https://token.actions.githubusercontent.com",
    "subject": "repo:fgarofalo56/csa-inabox:ref:refs/heads/main",
    "audiences": ["api://AzureADTokenExchange"]
  }'
```

### Step 3 — Grant Key Vault Secrets User on the loom KV

```bash
# Find the loom KV
KV=$(az keyvault list -g rg-csa-loom-admin-centralus \
       --query "[0].name" -o tsv)

# Grant read access to the SP
az role assignment create \
  --assignee <SP_CLIENT_ID> \
  --role "Key Vault Secrets User" \
  --scope "$(az keyvault show -n "$KV" --query id -o tsv)"
```

This is the **minimum grant** required. The SP cannot write, rotate, or list
secrets — only read the specific `session-secret` value by name.

### Step 4 — Set GitHub secrets and variables

Navigate to **GitHub → repo → Settings → Secrets and variables → Actions**.

| Type | Name | Value |
|------|------|-------|
| Secret | `AZURE_CLIENT_ID` | SP `appId` from Step 1 |
| Secret | `AZURE_TENANT_ID` | Azure tenant ID |
| Secret | `AZURE_SUBSCRIPTION_ID` | Subscription holding the loom KV |
| Variable | `LOOM_VERIFY_URL` | Console Front Door URL (e.g. `https://<your-console-hostname>`) |
| Variable | `LOOM_KV_NAME` | Key Vault name (e.g. `kv-loom-m56yejezt7bjo`) — optional; the workflow auto-discovers if absent |
| Variable | `LOOM_ADMIN_RG` | Admin-plane resource group — used for KV auto-discovery |
| Variable | `LOOM_AUTOMATION_OID` | Object ID of the SP (or any stable UUID for audit logs) |
| Variable | `LOOM_AUTOMATION_UPN` | UPN for the minted session (e.g. `loom-verify@automation.local`) |
| Variable | `LOOM_AUTOMATION_NAME` | Display name in the minted session (e.g. `Loom Verify [automation]`) |

---

## Backend SP role list for full unattended automation

The roles below go beyond the verify harness and cover the full range of
unattended console automation (service-health probes, bicep what-if, Purview
scans, etc.). Grant only the roles your automation actually needs.

| Role | Scope | Why |
|------|-------|-----|
| **Key Vault Secrets User** | loom Key Vault | Read `session-secret` to mint the session cookie |
| **Contributor** | loom admin resource group | ARM read/write for console CA, ACA secrets, identity wiring |
| **Contributor** | DLZ resource group (if topology=dlz-attach) | ARM probes for DLZ resources |
| **Cost Management Reader** | subscription | `/api/admin/cost/*` endpoints |
| **Monitoring Reader** | subscription | `/api/monitor/*` Azure Monitor data-plane probes |
| **Reader** | tenant root management group | Cross-sub resource discovery (Connections navigator) |
| **Purview Data Map Collection Administrator** | Purview account (data-plane) | `/api/admin/security/purview/*` — see `scripts/csa-loom/grant-purview-datamap-role.sh` |
| **Cognitive Services User** | AI Search / OpenAI resources | `/api/admin/search/*`, `/api/admin/ai-foundry/*` |
| **Storage Blob Data Reader** | ADLS Gen2 / storage accounts | Lakehouse browse, DSPM probes |
| **AppRoleAssignment.ReadWrite.All** (Graph app role) | Microsoft Graph | Automation bootstrap: assign Graph app roles to MI via `/api/admin/bootstrap-graph-grants` |
| **InformationProtectionPolicy.Read** (Graph app role) | Microsoft Graph | `/api/admin/security/mip/labels` — read MIP sensitivity labels |

> Note: `AppRoleAssignment.ReadWrite.All` is a high-privilege Graph role. Assign
> it only if the automation SP runs the bootstrap grant workflow, not for the
> read-only verify harness. The verify harness needs only **Key Vault Secrets
> User** plus the read roles above.

### Purview data-plane role grant (cannot be assigned via ARM)

```bash
# Grant Collection Administrator on the root collection
./scripts/csa-loom/grant-purview-datamap-role.sh \
  --purview-account <PURVIEW_ACCOUNT_NAME> \
  --principal-id   <SP_OBJECT_ID> \
  --role           "Collection Administrator"
```

---

## How to run the verify workflow

### Manual dispatch

1. Navigate to **GitHub → Actions → loom-ui-verify → Run workflow**.
2. Fill in `region` (default `centralus`) and optionally `console_url`.
3. Leave `kv_name` blank to auto-discover from `LOOM_KV_NAME` / `LOOM_ADMIN_RG`.
4. Click **Run workflow**.

### Scheduled (weekly)

The workflow runs automatically every Monday at 06:00 UTC. Disable the
`schedule` trigger in `.github/workflows/loom-ui-verify.yml` if weekly is
too frequent.

### Reading results

Each run uploads a Playwright HTML report artifact named
`loom-ui-verify-report-<run_id>`. Download it from the workflow run page and
open `playwright-report/index.html` in a browser.

Test outcomes:
- **PASS** — endpoint returned 2xx (real data flowing).
- **GATE** — endpoint returned 404/503 with a structured JSON body explaining
  what infrastructure is missing. This is an honest gate, not a bug.
- **FAIL** — endpoint returned 401 (session not accepted — misconfigured
  `SESSION_SECRET`?) or an unexpected 5xx (server crash / unhandled error).

The `/admin/health` UI test will fail if the page does not render a numeric
health score and the word "check", which catches a complete front-end crash.

---

## "No MFA / no user credentials" guarantee

- `SESSION_SECRET` never touches a GitHub secret — it is fetched at runtime
  from the loom Key Vault via an ephemeral OIDC token.
- The OIDC token is scoped to **this repository + this workflow**; it cannot
  be used by other repos.
- `SESSION_SECRET` is masked with `::add-mask::` immediately after the `az kv`
  fetch and is never echoed in logs.
- The minted cookie expires after 8 hours; the CI job completes in under
  10 minutes; the cookie is never persisted to disk in CI beyond the ephemeral
  runner filesystem.
- No browser opens, no interactive login prompt is shown, no MFA challenge is
  issued — the entire auth chain is HKDF + AES-GCM in Node.js.

---

## Unattended UI/API verification — the WORKING path (in-VNet Container App Job)

> The GitHub-Actions workflow above only works with a **self-hosted/VNet runner**:
> the loom estate is fully private (Key Vault / ACR / Purview `publicNetworkAccess=Disabled`),
> so a public GitHub-hosted runner cannot reach the KV data plane to read `SESSION_SECRET`.
> The path that works today is a **Container App Job inside the console's VNet**.

**`loom-verify`** (deployed by `scripts/csa-loom/deploy-loom-verify-job.sh`) runs in
`cae-csa-loom-centralus` using the **console image** + the **console UAMI** (already has
AcrPull + KV access). It mints a `loom_session` cookie from the console's `SESSION_SECRET`
(the app's own AES-256-GCM/HKDF scheme, `lib/auth/session.ts`) with the tenant-admin oid and
a labelled `loom-ui-verify@automation` upn, then probes the key admin/security/governance
APIs. No MFA, no user credentials, nothing exposed publicly.

**Run it (fully unattended):**
```
az containerapp job start -n loom-verify -g rg-csa-loom-admin-centralus --subscription <sub>
# read the result from Log Analytics (cae workspace):
#   ContainerAppConsoleLogs_CL | where ContainerName_s == 'verify' and Log_s has 'LOOM_VERIFY_RESULT'
# Expect: {"/api/admin/self-audit":200, ".../purview/sources":200, ".../scans":200,
#          ".../mip/labels":200, ".../dspm-ai...":200, ".../domains/purview-status":200}
```
A non-200/401 on any endpoint exits the job non-zero (Failed) — that's the alert signal.

**Secret note:** the job's `session-secret` is set from the console's **literal** value
(read via ARM), because the console's `SESSION_SECRET` is not currently KV-backed/synced —
see the tracked desync issue. Once the console secret is KV-backed + synced, switch the job
secret to a `keyvaultref`.

---

## Full visual UAT (in-VNet, unattended)

`loom-uat` is a separate Container App Job that runs the **complete
`e2e/*.uat.ts` Playwright suite** against the live console using real Chromium
— headless, no human in the loop.  The suite covers all editor types, the
catalog, admin pages, copilot, app installs, and nav pages.

### Files

| Path | Purpose |
|------|---------|
| `apps/fiab-console/Dockerfile.uat` | Playwright runner image (`mcr.microsoft.com/playwright:v1.48.0-jammy` base, full app deps, Chromium pre-installed) |
| `apps/fiab-console/e2e/run-uat-unattended.mjs` | Headless entrypoint: mint → storageState → `playwright test` → `UAT_RESULT` summary |
| `scripts/csa-loom/deploy-loom-uat-job.sh` | Build image via ACR Tasks + create/update the `loom-uat` CA Job |

### How headless auth works (UAT edition)

The entrypoint (`run-uat-unattended.mjs`) inlines the same HKDF + AES-256-GCM
derivation as `mint-session.ts` — no TypeScript import chain needed.  It:

1. Reads `SESSION_SECRET` from the job's secret ref (set from the console ARM
   literal by `deploy-loom-uat-job.sh`).
2. Derives the AES-256 key via `crypto.hkdfSync('sha256', secret, 32×0x00,
   'loom-session-v1', 32)`.
3. Encrypts the claims JSON and wraps it as `iv(12) || authTag(16) ||
   ciphertext` → base64url → `loom_session` cookie value.
4. Writes a Playwright `storageState` object to `.auth/loom-state.json`.
5. Sets `LOOM_STORAGE_STATE` so `playwright.config.ts` picks it up (`uat`
   project: `storageState: process.env.LOOM_STORAGE_STATE`).
6. Runs `pnpm exec playwright test --project=uat` with Chromium in headless
   mode (enforced by `CI=true` in the image).

### Deploy the job

```bash
export ADMIN_RG=rg-csa-loom-admin-centralus
export SUB=<admin-plane-subscription-id>
export CAE=cae-csa-loom-centralus
export CONSOLE_APP=loom-console
export CONSOLE_UAMI_ID=/subscriptions/<sub>/resourcegroups/rg-csa-loom-admin-centralus/providers/Microsoft.ManagedIdentity/userAssignedIdentities/<uami-name>
export ACR=acrloom<hash>.azurecr.io
export LOOM_URL=https://<your-console-hostname>
export LOOM_AUTOMATION_OID=<tenant-admin-object-id>

./scripts/csa-loom/deploy-loom-uat-job.sh
```

The script:

1. Temporarily enables ACR public access (both `publicNetworkAccess` and
   `networkRuleSet.defaultAction`) so `az acr build` can upload the source
   tarball from a public shell.  Sleeps 35 s for propagation.
2. Builds and pushes `loom-uat:latest` via ACR Tasks (the build runs inside
   Azure — inside the VNet — so the private ACR push succeeds).
3. Restores `publicNetworkAccess=Disabled` (always, even on build failure).
4. Creates or updates the `loom-uat` Container App Job:
   - UAMI: same console UAMI (already has AcrPull + Storage access)
   - Resources: 2 CPU / 4 GiB (Chromium is memory-heavy)
   - `replicaTimeout`: 3600 s (1 hour — sufficient for the full suite)
   - `replicaRetryLimit`: 0 (a flaky test should not silently re-run)
5. Sets the job's `session-secret` from the console's ARM literal (piped,
   never printed, unset immediately).

### Run a slice first (recommended)

Run a single spec or grep pattern to confirm connectivity and auth before
launching the full suite:

```bash
# Re-deploy targeting just the catalog specs:
UAT_GREP=catalog ./scripts/csa-loom/deploy-loom-uat-job.sh

# Trigger:
az containerapp job start -n loom-uat -g $ADMIN_RG --subscription $SUB
```

Useful `UAT_GREP` values:

| `UAT_GREP` | Specs matched |
|------------|---------------|
| `catalog`  | catalog.uat.ts, catalog-uat.uat.ts |
| `admin`    | admin-security.uat.ts, admin-scaling.uat.ts |
| `editors`  | editors.uat.ts |
| `apps`     | apps.uat.ts, use-case-apps-uat.uat.ts |
| `nav`      | nav-pages.uat.ts |
| `copilot`  | copilot.uat.ts, help-copilot.uat.ts |
| `deep`     | deep-functional-uat.uat.ts |
| `no-cuts`  | no-cuts-sweep-v3.uat.ts |

### Run the full suite

```bash
az containerapp job start -n loom-uat -g $ADMIN_RG --subscription $SUB
```

All specs matching `e2e/*.uat.ts` run serially (`workers: 1`) to avoid
workspace collisions (the suite manipulates shared console state).

### Where results land

**Container logs (always available):**

```kusto
ContainerAppConsoleLogs_CL
| where ContainerName_s == "uat"
| where Log_s contains "UAT_RESULT"
| order by TimeGenerated desc
```

The runner emits a structured one-liner at the end of every run:

```
UAT_RESULT pass=<n> fail=<n> skip=<n>
```

The job exits non-zero if any test failed, which marks the CA Job execution
as `Failed` — use Azure Monitor alerts on job execution status for proactive
notification.

**HTML report (optional):**

Set `LOOM_UAT_RESULTS_CONTAINER` to an ADLS Gen2 / Blob container URL before
deploying the job.  After the run the entrypoint uploads `playwright-report/`
and `test-results/uat/report.json` to
`<container>/uat-runs/<timestamp>/playwright-report/` using `az storage blob
upload-batch --auth-mode login` (the console UAMI already has Storage Blob
Data Contributor).

```bash
export LOOM_UAT_RESULTS_CONTAINER=https://<account>.blob.core.windows.net/<container>
./scripts/csa-loom/deploy-loom-uat-job.sh
```

Open the HTML report by downloading `playwright-report/index.html` from the
blob and opening it locally.

### Image maintenance

- **Playwright version pin**: `Dockerfile.uat` uses
  `mcr.microsoft.com/playwright:v1.48.0-jammy`.  Update the base tag whenever
  `@playwright/test` is bumped in `package.json` (they must match).
- **SESSION_SECRET rotation**: after a console secret rotation, re-run
  `deploy-loom-uat-job.sh` (step 5 re-reads the console's new literal and
  updates the job secret automatically).
- **KV-backed secret (future)**: once issue #1534 is resolved, switch the job
  secret `session-secret` to a `keyvaultref` pointing at the same KV secret
  name.
