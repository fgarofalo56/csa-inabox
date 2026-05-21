[Home](../../README.md) > [Docs](../index.md) > [Runbooks](index.md) > **Azure Deployment Service Principal**

# Azure Deployment Service Principal Runbook

!!! note
    **Quick Summary**: Authoritative reference for the service principal that GitHub Actions uses to deploy infrastructure into Azure subscriptions. Captures identity, scope, rotation cadence, recovery procedure, audit trail location, and the "who do I call when the SP loses access" escalation. Replaces the previously tribal knowledge of "who knows the SP name and which subs it touches."

## 📋 Table of Contents

- [1. Scope](#1-scope)
- [2. Identity inventory](#2-identity-inventory)
- [3. Subscription scope and role assignments](#3-subscription-scope-and-role-assignments)
- [4. Secret storage and rotation](#4-secret-storage-and-rotation)
- [5. Rotation procedure](#5-rotation-procedure)
- [6. Recovery — SP credentials lost or compromised](#6-recovery-sp-credentials-lost-or-compromised)
- [7. Audit and observability](#7-audit-and-observability)
- [8. Escalation contacts](#8-escalation-contacts)

---

## 1. Scope

This runbook covers the **deployment service principal** used by GitHub Actions workflows under `.github/workflows/` to deploy Bicep templates, configure Azure resources, and run smoke tests against Azure subscriptions. It is **not** the runtime identity for any deployed workload — those use **managed identity** (see [ADR-0014](../adr/0014-msal-bff-auth-pattern.md) and the platform code under `csa_platform/`).

The principal is authorized for **infrastructure deployment only**. It should not have data-plane access (data-plane operations use managed identity assigned to the deployed resources).

## 2. Identity inventory

| Field | Value |
|---|---|
| Display name | `<your-deploy-principal>` (e.g., `csa-inabox-deploy`) |
| Application (client) ID | Stored in GitHub secret `AZURE_CLIENT_ID` |
| Tenant ID | Stored in GitHub secret `AZURE_TENANT_ID` |
| Auth method | OIDC federation (preferred) or client secret (legacy) |
| Federated credentials | Configured on the App Registration for each repo / branch / environment that needs to deploy |
| Key Vault holding standby secret | (Optional) `kv-deploy-creds-<env>` — only if client-secret auth is still in use |

> [!IMPORTANT]
> **Before first use of this runbook**: populate the display name and confirm the GitHub secret names in the table above. The defaults match the patterns in `.github/workflows/deploy*.yml` but your fork may differ.

### Looking up the application ID

```bash
# Via Azure CLI (must be authenticated as a tenant admin)
az ad app list --display-name "<your-deploy-principal>" --query "[].{name:displayName, appId:appId, id:id}" -o table

# Verify federated credentials
az ad app federated-credential list --id <appId> -o table
```

## 3. Subscription scope and role assignments

The deploy principal is authorized across the subscriptions listed below with the minimum-necessary role at each scope.

| Subscription | Role | Why |
|---|---|---|
| `<sub-id-1>` | Contributor | Primary dev / non-prod deployment target |
| `<sub-id-2>` | Contributor | Staging / pre-prod |
| `<sub-id-3>` | Contributor | Production (gated by branch-protection + manual approval) |
| `<sub-id-4>` | Contributor (Azure Gov) | FedRAMP-High / GCC High deployments |
| Tenant root (optional) | User Access Administrator on specific RGs | Required only when the deployment creates role assignments |

> [!CAUTION]
> The principal should **never** be granted Owner or User Access Administrator at the subscription scope. Bicep templates that need to create role assignments do so through `Microsoft.Authorization/roleAssignments` resources, which require User Access Administrator only at the **resource group** scope where the assignment lives.

### Verifying current assignments

```bash
APP_ID=$(az ad app list --display-name "<your-deploy-principal>" --query "[0].appId" -o tsv)
SP_ID=$(az ad sp show --id $APP_ID --query id -o tsv)

# Across all subscriptions the principal can see
az role assignment list --assignee $SP_ID --all -o table
```

## 4. Secret storage and rotation

| Secret | Storage | Rotation cadence |
|---|---|---|
| OIDC federated credential | GitHub repo settings → Actions → Variables/Secrets | No expiration — federation is preferred over client secrets |
| Client secret (if used) | GitHub secret `AZURE_CLIENT_SECRET` + Key Vault backup | 90 days (NIST 800-53 SC-12) |

> [!CAUTION]
> **Never commit the client secret to the repo.** The `.gitleaks.toml` config will flag any leak; the `gitleaks` pre-commit hook will block the commit; CI's Secret Scan workflow will fail the build. If a secret is accidentally committed, follow [§6](#6-recovery-sp-credentials-lost-or-compromised) immediately.

The repository's preferred posture is **OIDC federation** — no client secret on disk, GitHub Actions exchanges a short-lived OIDC token for an Azure access token at run time. Client-secret auth is supported as a fallback for legacy workflows.

## 5. Rotation procedure

### 5.1 OIDC federation (preferred — no secret rotation needed)

OIDC federated credentials do not need rotation. The trust relationship is verified by GitHub's OIDC issuer (`https://token.actions.githubusercontent.com`) at every run. Maintenance only required if:

- Repository moves to a different org or is renamed → re-create the federated credential
- A new branch or environment needs to deploy → add a new federated credential covering it

```bash
az ad app federated-credential create \
  --id <appId> \
  --parameters '{
    "name": "github-actions-main",
    "issuer": "https://token.actions.githubusercontent.com",
    "subject": "repo:<org>/<repo>:ref:refs/heads/main",
    "audiences": ["api://AzureADTokenExchange"]
  }'
```

### 5.2 Client-secret rotation (90-day cadence)

```bash
# 1. Create a new secret on the App Registration
APP_ID=$(az ad app list --display-name "<your-deploy-principal>" --query "[0].appId" -o tsv)
NEW_SECRET=$(az ad app credential reset --id $APP_ID --years 1 --query password -o tsv)

# 2. Update the GitHub secret (use the gh CLI or repo settings UI)
echo $NEW_SECRET | gh secret set AZURE_CLIENT_SECRET -R <org>/<repo>

# 3. Trigger a no-op CI run to confirm the new secret works
gh workflow run validate.yml

# 4. Wait for that run to complete green
gh run watch

# 5. ONLY THEN, remove the old credential. Find it by description or kid:
az ad app credential list --id $APP_ID -o table
az ad app credential delete --id $APP_ID --key-id <old-kid>

# 6. Record the rotation in the runbook log (CONTROL_PROCESS table below)
```

## 6. Recovery — SP credentials lost or compromised

If the client secret is leaked, the federated credential trust is broken, or the principal is otherwise compromised:

1. **Immediately revoke** the credential at the source:
   ```bash
   # Revoke all credentials on the app
   APP_ID=$(az ad app list --display-name "<your-deploy-principal>" --query "[0].appId" -o tsv)
   for KID in $(az ad app credential list --id $APP_ID --query "[].keyId" -o tsv); do
       az ad app credential delete --id $APP_ID --key-id $KID
   done
   # Remove all federated credentials
   for FID in $(az ad app federated-credential list --id $APP_ID --query "[].id" -o tsv); do
       az ad app federated-credential delete --id $APP_ID --federated-credential-id $FID
   done
   ```
2. **Pause deployments** by disabling deploy workflows: `gh workflow disable deploy.yml deploy-gov.yml deploy-portal.yml`.
3. **Audit the principal's recent activity** — see [§7](#7-audit-and-observability). If anything unauthorized happened, treat as a security incident and follow [`security-incident.md`](security-incident.md).
4. **Create new credentials** (prefer OIDC federation; client secret only if required).
5. **Update GitHub secrets** and re-enable deploys via a smoke-test workflow first.
6. **File a post-incident report** if the leak had real exposure window.

## 7. Audit and observability

| What | Where | Retention |
|---|---|---|
| All RBAC operations by the SP | Azure Activity Log on each subscription | 90 days hot in Activity Log; archived to Log Analytics workspace `law-security-<env>` for long-term |
| GitHub Actions runs using the SP | GitHub Actions logs on the repo | 90 days per GitHub's default retention |
| Failed sign-ins / token issuance | Entra ID Sign-in logs for the App Registration | 30 days hot; archived to Log Analytics |
| App Registration changes (credentials, federated creds) | Entra ID Audit logs | 30 days hot; archived |

### KQL queries that earn their keep

```kql
// All deployments the SP has done in the last 7 days, across all subs
AzureActivity
| where TimeGenerated > ago(7d)
| where Caller == "<spClientId>"
| where OperationName has "Microsoft.Resources/deployments"
| project TimeGenerated, SubscriptionId, ResourceGroup, OperationName, ActivityStatusValue
| order by TimeGenerated desc

// Any role assignment the SP has created or changed (high-sensitivity)
AzureActivity
| where TimeGenerated > ago(30d)
| where Caller == "<spClientId>"
| where OperationName has "Microsoft.Authorization/roleAssignments"
| project TimeGenerated, SubscriptionId, ResourceGroup, OperationName, Properties
```

## 8. Escalation contacts

| Scenario | Contact |
|---|---|
| SP credentials leaked / compromised | Security Operations on-call + repo owner |
| SP lost access to a subscription | Subscription owner + tenant admin |
| Need to add a new subscription scope | Tenant admin (governance review required) |
| Renewing OIDC federation after repo rename | Tenant admin |

> [!IMPORTANT]
> Populate this table with the actual contact roles / channels for your environment before depending on it in an incident. The intent is that anyone who finds this runbook in the middle of an incident knows who to call without needing to ask.

---

## Control process

| Date | Action | Performed by |
|---|---|---|
| _yyyy-mm-dd_ | Initial runbook published | _<author>_ |

Append rotation events, recovery incidents, and scope changes here.

---

## Related material

- [`SECURITY.md`](../../SECURITY.md) — repo-wide security policy
- [`security-incident.md`](security-incident.md) — incident response runbook
- [`key-rotation.md`](key-rotation.md) — full credential-class rotation runbook
- [`break-glass-access.md`](break-glass-access.md) — emergency-access procedure
- [ADR-0014 — MSAL BFF Auth Pattern](../adr/0014-msal-bff-auth-pattern.md) — distinguishes workforce / app identity flows
- [Microsoft Learn — Configure OpenID Connect in Azure for GitHub Actions](https://learn.microsoft.com/azure/developer/github/connect-from-azure-openid-connect)
