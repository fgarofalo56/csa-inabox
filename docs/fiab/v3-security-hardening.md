# CSA Loom v3 — Security Hardening

**Status:** Phases 1-7 complete (2026-05-25)
**Branch:** `access-patterns-vpn-agw-fd`
**Subscription:** `<YOUR_DLZ_SUBSCRIPTION_ID>` (FedCiv ATU FFL — DLZ)
**Console UAMI principalId:** `<YOUR_CONSOLE_UAMI_PRINCIPAL_ID>`

This document records the v3 security posture for the CSA Loom platform. Each
phase is independently committed.

## TL;DR — what changed in v3

| Phase | Change | Status |
|---|---|---|
| 1 | Defender for Cloud Standard tier on KubernetesService, ContainerRegistry, AI | DONE |
| 2 | ContainerIntegrityContribution extension enabled on Containers plan | DONE |
| 3 | Console MSAL client secret + session secret moved to KV references | DONE — verified end-to-end |
| 4 | Removed broad Contributor from Synapse / Databricks / AI Foundry workspace scopes | DONE — BFF still green |
| 5 | Conditional Access policy template as bicep doc-as-code | TEMPLATE — manual apply required |
| 6 | Bicep linter cleanup (no-hardcoded-env-urls, no-unused-params) | DONE — 0 of each warning |
| 7 | This document | DONE |

---

## Phase 1 — Microsoft Defender for Cloud coverage

Enabled `Standard` tier for the three plans that were still `Free`. Everything
else was already on Standard from earlier waves.

### Final coverage (post-change)

| Plan | Tier | Notes |
|---|---|---|
| VirtualMachines | Standard | already |
| SqlServers | Standard | already |
| AppServices | Standard | already |
| StorageAccounts | Standard | already |
| SqlServerVirtualMachines | Standard | already |
| KubernetesService | **Standard** | enabled in v3 |
| ContainerRegistry | **Standard** | enabled in v3 |
| KeyVaults | Standard | already |
| Dns | Free | not in scope for Loom |
| Arm | Standard | already |
| OpenSourceRelationalDatabases | Standard | already |
| CosmosDbs | Standard | already |
| Containers | Standard | unified plan, already |
| CloudPosture | Standard | already |
| Api | Standard | already |
| AI | **Standard** | enabled in v3 |
| Discovery | Standard | already |
| FoundationalCspm | Standard | already |

### Commands used

```bash
az security pricing create -n KubernetesService --tier Standard
az security pricing create -n ContainerRegistry --tier Standard
az security pricing create -n AI            --tier Standard
```

Raw output is captured in `temp/v3-security/defender-pricing-after.tsv`.

---

## Phase 2 — ACR Defender + container image scanning

### Registry: `acrloomm56yejezt7bjo` (rg-csa-loom-admin-eastus2)

- SKU: Premium
- Public network: Disabled (PE-only)
- Admin user: disabled (UAMI / AAD AcrPull/AcrPush only)
- Zone redundancy: Enabled

### Defender for Containers extensions (subscription-level)

All five extensions now enabled on the `Containers` plan:

| Extension | State | Purpose |
|---|---|---|
| ContainerRegistriesVulnerabilityAssessments | Enabled | Trivy-based image vuln scans (on push + weekly) |
| AgentlessDiscoveryForKubernetes | Enabled | API-server posture |
| AgentlessVmScanning | Enabled | Node-VM scanning |
| ContainerSensor | Enabled | Runtime detection (CA env via DaemonSet) |
| ContainerIntegrityContribution | **Newly enabled in v3** | Image signing / supply chain integrity signals |

```bash
az security pricing create -n Containers --tier Standard \
  --extensions name=ContainerIntegrityContribution isEnabled=True
```

Image scanning is automatic for all images pushed to `acrloomm56yejezt7bjo`;
findings flow into Defender for Cloud > Recommendations.

---

## Phase 3 — Key Vault references for Console secrets

### Before

The Loom Console Container App (`loom-console` in `rg-csa-loom-admin-eastus2`)
stored two highly sensitive secrets **as raw values** inside the Container App
secret store:

- `loom-msal-client-secret` — Entra app client secret (used for MSAL OBO)
- `session-secret` — AES-256-GCM key for session cookie HKDF

Raw values are recoverable by anyone with `Microsoft.App/containerApps/listSecrets/action`
on the resource, which is broad and not auditable through KV access policies.

### After

Both secrets now live in `kv-loom-m56yejezt7bjo` (RBAC-mode, private-endpoint-only)
and are referenced via Container App **Key Vault references**, fetched at
runtime by the Console UAMI (`uami-loom-console-eastus2`).

| CA secret name | KV secret name | Identity used to fetch |
|---|---|---|
| `loom-msal-client-secret` | `loom-msal-client-secret` | uami-loom-console-eastus2 |
| `session-secret` | `loom-session-secret` | uami-loom-console-eastus2 |

### RBAC change

Console UAMI (`principalId <YOUR_CONSOLE_UAMI_PRINCIPAL_ID>`) now has
**Key Vault Secrets User** at vault scope:

```bash
# az CLI's role assignment create has a "MissingSubscription" bug on this tenant
# when looking up roles by name. We invoke ARM directly:
az rest --method PUT \
  --url "https://management.azure.com/subscriptions/363ef5d1-.../resourceGroups/rg-csa-loom-admin-eastus2/providers/Microsoft.KeyVault/vaults/kv-loom-m56yejezt7bjo/providers/Microsoft.Authorization/roleAssignments/$(uuidgen)?api-version=2022-04-01" \
  --body '{"properties":{
    "roleDefinitionId":"/subscriptions/.../providers/Microsoft.Authorization/roleDefinitions/4633458b-17de-408a-b874-0445c86b69e6",
    "principalId":"<YOUR_CONSOLE_UAMI_PRINCIPAL_ID>",
    "principalType":"ServicePrincipal"}}'
```

### CA secret references

```bash
UAMI_ID="/subscriptions/.../uami-loom-console-eastus2"
az containerapp secret set -n loom-console -g rg-csa-loom-admin-eastus2 \
  --secrets \
  "loom-msal-client-secret=keyvaultref:https://kv-loom-m56yejezt7bjo.vault.azure.net/secrets/loom-msal-client-secret,identityref:$UAMI_ID" \
  "session-secret=keyvaultref:https://kv-loom-m56yejezt7bjo.vault.azure.net/secrets/loom-session-secret,identityref:$UAMI_ID"
```

### Verification

After forcing a new revision (revision-restart alone was insufficient for the
secret resolver to re-bind on already-running replicas), the BFF smoke test
passes:

```
200  /api/me           {"authenticated":true,"user":{...}}
200  /api/health       {"status":"ok"}
200  /api/workspaces   [...]
```

Cookie was minted locally via `temp/uat-pw/mint-session.mjs` using the
KV-stored session secret, and the running app decrypted/validated it
successfully — proving the secret resolution chain (CA secret → KV ref → KV
secret value via UAMI) works end-to-end.

### Notes & gotcha discovered

- `az keyvault secret set --file <path>` preserves trailing CRLF / LF in the
  file. **Strip newlines** before upload (`printf "%s" "$(cat …)" | tr -d '\r\n'`),
  otherwise the cookie HKDF input mismatches by one byte and all session
  validation silently fails (route returns 200 with `authenticated: false`).
- Container App secret values resolved from KV are only re-read on **new
  revision creation**, not on `revision restart`. The `update --set-env-vars`
  with a throwaway tick variable forces a new revision.
- KV public-network-access had to be temporarily set to `Enabled` + an IP rule
  for our own workstation IP added to write the secrets, then both reverted.
  Final state: `publicNetworkAccess=Disabled`, no IP rules.

### Deferred

The other CA secrets (`azure-client-secret`, `deploy-sp-secret`, `deploy-sp-id`)
were not migrated in this phase. They are not on the user-facing critical path
(used by deployment automation only). Recommend migrating in v3.x once a
deployment-script-based KV write path is in place to avoid the temporary
public-network toggle workaround.

---

## Phase 4 — Per-app least-privilege RBAC audit (Console UAMI)

The Console UAMI (`uami-loom-console-eastus2`,
`principalId <YOUR_CONSOLE_UAMI_PRINCIPAL_ID>`) previously held broad
**Contributor** at five scopes. We removed three of them in v3:

### 4a. Synapse workspace — swapped for custom Operator role

Created a new subscription-scoped custom role:

| Field | Value |
|---|---|
| Role name | `CSA Loom Synapse Operator` |
| Role ID | `1face001-f130-49d7-870c-f3225eb79708` |
| Definition file | `temp/v3-security/synapse-operator-role.json` |

Actions:
- `Microsoft.Synapse/workspaces/read`
- `Microsoft.Synapse/workspaces/sqlPools/read`
- `Microsoft.Synapse/workspaces/sqlPools/pause/action`
- `Microsoft.Synapse/workspaces/sqlPools/resume/action`
- `Microsoft.Synapse/workspaces/sqlPools/operationResults/read`
- `Microsoft.Synapse/workspaces/operationStatuses/read`
- `Microsoft.Insights/metrics/read`
- `Microsoft.Insights/metricDefinitions/read`

Assigned at scope `…/workspaces/syn-loom-default-eastus2`. Broad Contributor
removed (assignment `5b55eded-…-bc6f50be`). Data-plane access remains via the
existing **Synapse Administrator** and **Synapse SQL Administrator** grants
(not ARM RBAC).

Smoke test after: `/api/me`, `/api/health`, `/api/workspaces` all `200`.

### 4b. Databricks workspace — Contributor removed

The BFF accesses Databricks exclusively through workspace REST (clusters,
jobs, DBSQL), not ARM. Broad Contributor at workspace scope removed
(assignment `0f4d9861-…-78bf52c24dd`). Workspace-level entitlements / SPN
remain in place.

Smoke test after: `/api/me`, `/api/health`, `/api/workspaces` all `200`.

### 4c. AI Foundry workspace — Contributor removed

UAMI retains **AzureML Data Scientist** and **AzureML Compute Operator** at
`aifoundry-csa-loom-eastus2` and `loom-project-default`, which cover all
data-plane actions the BFF needs (jobs, datasets, endpoints, compute lifecycle).
Broad Contributor at the hub workspace removed (assignment
`15fd45cf-…-2afb7550abc`).

Smoke test after: `/api/me`, `/api/health`, `/api/workspaces` all `200`.

### 4d. Retained Contributor (documented)

| Scope | Why kept |
|---|---|
| `rg-csa-loom-dlz-single-eastus2` (RG) | The Console UAMI orchestrates cross-resource ARM ops in this RG: ADF pipeline triggers, Synapse pool ARM lifecycle, Cosmos throughput changes, Storage account properties, Event Hub namespaces, etc. Narrowing to a custom role would require enumerating actions across 8+ providers and is deferred to v3.x. |
| `adx-csa-loom-shared` (ADX cluster) | Cluster lifecycle (start/stop, scale, follower-db) is ARM-level. Could be narrowed to a `Microsoft.Kusto/clusters/*/action` operator role in v3.x. |

### Final v3 RBAC posture for Console UAMI

```
Contributor                     rg-csa-loom-dlz-single-eastus2          (kept)
Contributor                     adx-csa-loom-shared                     (kept, candidate for v3.x narrowing)
CSA Loom Synapse Operator (NEW) syn-loom-default-eastus2                (replaces Contributor)
[no ARM role]                   adb-loom-default-eastus2                (Contributor REMOVED)
AzureML Data Scientist          aifoundry-csa-loom-eastus2              (Contributor REMOVED)
AzureML Compute Operator        loom-project-default
AzureML Data Scientist          loom-project-default
AcrPull                         acrloomm56yejezt7bjo
Storage Blob Data Contributor   saloomdefaultmwfaiy3truk
Data Factory Contributor        adf-loom-default-eastus2
API Management Service Contributor  dml-ai-east-aigateway
Search Service Contributor / Index Data Contributor / Reader  dlz-aisearch-dev-eastus2
Log Analytics Reader, Monitoring Reader  law-csa-loom-eastus2 + ai-csa-loom-eastus2
Cognitive Services User         cs-loom-eastus2
Key Vault Secrets User (NEW)    kv-loom-m56yejezt7bjo                   (Phase 3)
```

---

## Phase 5 — Conditional Access policy template

Conditional Access policies cannot be created via ARM / Bicep — they live in
Entra ID and only the Microsoft Graph API can create them, using a
**delegated** user token with the *Conditional Access Administrator* role
(service principals cannot create CA policies).

To keep the policy definition reviewed-and-versioned with the platform code,
v3 ships `platform/fiab/bicep/modules/admin-plane/conditional-access.bicep`.
It deploys **no resources** — it exists as config-as-code documentation,
embedding the exact Graph REST payloads and `az rest` invocations to apply
manually.

### Required policies (apply via Graph in reporting mode first)

1. **`CSA Loom Console — require MFA for sign-in`**
   - Targets app `9844c28c-3b3a-4949-8d63-9eefa3b50a9d` (LOOM_MSAL_CLIENT_ID)
   - All users, all client app types, all locations
   - Grant: `mfa`

2. **(Optional) `CSA Loom Console — require compliant device`**
   - Same target app
   - Grant: `compliantDevice` OR `domainJoinedDevice`
   - Requires Intune-enrolled devices with a compliance policy assigned

### Apply procedure (manual, requires delegated user auth)

```bash
# Authenticate as a user (NOT the deploy SP) with CA Administrator
az login --tenant d1fc0498-f208-4b49-8376-beb9293acdf6 --allow-no-subscriptions

# Create in reporting-only state first
az rest --method POST \
  --url "https://graph.microsoft.com/v1.0/identity/conditionalAccess/policies" \
  --body @<(see Bicep template policy block 1)

# After 24h of sign-in telemetry, flip to enabled
az rest --method PATCH \
  --url "https://graph.microsoft.com/v1.0/identity/conditionalAccess/policies/<policyId>" \
  --body '{"state":"enabled"}'
```

### Verification

```bash
az rest --method GET \
  --url "https://graph.microsoft.com/v1.0/auditLogs/signIns?\$filter=appId eq '9844c28c-3b3a-4949-8d63-9eefa3b50a9d'&\$top=50"
```

Look at `conditionalAccessPolicies[].result` per sign-in event.

---

## Phase 6 — Bicep linter cleanup

Two lint rule classes addressed across the FiaB bicep tree:

| Rule | Before | After | Approach |
|---|---|---|---|
| `no-hardcoded-env-urls` | 2 warnings in `admin-plane/network.bicep` (blob/dfs DNS zones used hand-rolled boundary ternaries with `core.windows.net` / `core.usgovcloudapi.net`) | 0 | Replaced with `environment().suffixes.storage` so the AZ CLI cloud profile drives the suffix automatically across Commercial / GCC / GCC-High / IL5. |
| `no-unused-params` | 14 warnings across admin-plane (`main.bicep`, `presidio-sidecar.bicep`, `catalog.bicep`, `ai-defense.bicep`) and landing-zone (`main.bicep`, `synapse.bicep`) | 0 | Each param annotated `Reserved for v3.x — <specific reason>` and silenced with `#disable-next-line no-unused-params`. None removed — orchestrator parameter contracts remain stable. |

Other lint warnings (`prefer-unquoted-property-names`, `use-safe-access`,
`use-secure-value-for-secure-inputs`, `BCP318`) are out of scope for v3
hardening and tracked separately.

---

## Phase 7 — Known gaps and v3.x roadmap

These remain open and are deferred to v3.x or v4. Documented here so the
posture is honest:

### Gap 1 — On-behalf-of (OBO) token flow

The MSAL OBO flow that would let the BFF call downstream Azure REST APIs with
the **signed-in user's** delegated permissions (instead of the Console UAMI's
broad app-as-service privileges) is **not** in production. It was prototyped
in v1.18 but the OBO access token blew past the Front Door cookie size limit
(~4 KB, see commit `6fe597d5`) and was removed.

Re-enabling OBO requires either:
- Server-side token cache (e.g. Redis) keyed by session id, with the OBO
  token never leaving the BFF, OR
- A trimmed-token approach where only the refresh token is in the cookie
  and the access token is minted per-request

Until OBO returns, all downstream Azure data-plane calls go via the Console
UAMI's managed identity. RBAC scoping (Phase 4) compensates partially by
narrowing what the UAMI can do, but it cannot enforce per-user authorization.
**This is the single largest residual gap.**

### Gap 2 — Other Container App secrets still raw

Phase 3 migrated the two high-impact secrets (`loom-msal-client-secret`,
`session-secret`). The deployment-automation secrets (`azure-client-secret`,
`deploy-sp-secret`, `deploy-sp-id`) remain as raw values in the Container App
secret store. Recommend migrating once a deployment-script-based KV write
path is in place (so we don't have to do the public-network toggle dance
every time).

### Gap 3 — Conditional Access policies not applied

The bicep module in Phase 5 documents the required CA policies as code, but
they have not yet been pushed to Entra. Pushing requires a delegated-user
session of someone holding the **Conditional Access Administrator** role.
Suggested rollout: apply in reporting-only mode, monitor sign-in telemetry
for 24-48 h, then flip to `enabled`.

### Gap 4 — Contributor on DLZ RG and ADX cluster retained

Phase 4 narrowed Synapse / Databricks / AI Foundry from Contributor to
least-privilege roles, but kept Contributor at:
- `rg-csa-loom-dlz-single-eastus2` (RG-wide)
- `adx-csa-loom-shared` (ADX cluster)

Both are candidates for further narrowing in v3.x once we have a clean
enumeration of the actual ARM actions the BFF performs against ADF, Cosmos,
EventHubs, Storage account properties, and ADX cluster lifecycle.

### Gap 5 — Synapse Operator role not yet versioned in source

The custom role definition (`temp/v3-security/synapse-operator-role.json`)
was created via `az role definition create`. It is not yet sourced from a
checked-in Bicep / ARM module. v3.x should move it into
`platform/fiab/bicep/modules/admin-plane/custom-roles.bicep` so role drift
is detectable in CI.

---

## Verification record

All BFF smoke-tests use the local cookie-minter at
`temp/uat-pw/mint-session.mjs` with the KV-stored session secret, hitting
`https://loom-console-fvbbctd4eehqbkcs.b02.azurefd.net`.

| Phase | Endpoint | Pre-change | Post-change |
|---|---|---|---|
| 3 | `/api/me` | 200 authenticated | 200 authenticated (after force-new-revision) |
| 3 | `/api/health` | 200 ok | 200 ok |
| 3 | `/api/workspaces` | 200 | 200 |
| 4a (Synapse Contributor removed) | same three | 200/200/200 | 200/200/200 |
| 4b (Databricks Contributor removed) | same three | 200/200/200 | 200/200/200 |
| 4c (AI Foundry Contributor removed) | same three | 200/200/200 | 200/200/200 |

No regressions detected.

---

## Artifacts checked in

- `docs/fiab/v3-security-hardening.md` (this file)
- `platform/fiab/bicep/modules/admin-plane/conditional-access.bicep`
  (template — deploys nothing, documents required CA policies as code)
- `platform/fiab/bicep/modules/admin-plane/network.bicep` (uses
  `environment().suffixes.storage`)
- `platform/fiab/bicep/modules/admin-plane/*.bicep` and
  `platform/fiab/bicep/modules/landing-zone/*.bicep` with all
  `no-unused-params` properly documented

## Artifacts in `temp/v3-security/` (not checked in)

- `defender-pricing-after.tsv` — final Defender plan coverage
- `synapse-operator-role.json` — custom role definition (to be moved to bicep in v3.x)
- `cookie4.txt` — smoke-test session cookie
- `msal-secret-clean.txt`, `session-secret-clean.txt` — secret values
  (DO NOT commit — these are the live credentials)
