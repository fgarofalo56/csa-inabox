[Home](../../README.md) > [Docs](../) > [Runbooks](./) > **Key Rotation**

# Key Rotation Runbook (CSA-0059)


!!! note
    **Quick Summary**: Scheduled + emergency rotation procedures for every credential class in CSA-in-a-Box — Key Vault secrets, Storage account access keys, MSAL / Entra ID token-signing keys, SQL and Cosmos master keys, Databricks PATs, and ADF linked-service credentials. Covers cadence, automation (secret rotation Function), manual steps for each class, and verification queries.

## Before First Use — Customization Checklist

- [ ] Populate the [Contact Information](#-contact-information) table.
- [ ] Confirm the Key Vault names per environment (dev / staging / prod /
      gov-dev / gov-prod) in [§3](#-3-inventory).
- [ ] Confirm the secret-rotation Function app name and identity under
      [§4.1](#41-automated-rotation-via-secret-rotation-function).
- [ ] Confirm your organization's compliance cadence (NIST 800-53 SC-12
      typically requires 90-day rotation on high-impact systems).

## 📑 Table of Contents

- [📋 1. Scope](#-1-scope)
- [📅 2. Cadence](#-2-cadence)
- [📦 3. Inventory](#-3-inventory)
- [🔒 4. Rotation Procedures](#-4-rotation-procedures)
  - [4.1 Automated rotation via secret-rotation Function](#41-automated-rotation-via-secret-rotation-function)
  - [4.2 Key Vault secret (manual)](#42-key-vault-secret-manual)
  - [4.3 Storage account access keys](#43-storage-account-access-keys)
  - [4.4 MSAL / Entra ID token-signing keys](#44-msal--entra-id-token-signing-keys)
  - [4.5 Cosmos DB primary / secondary keys](#45-cosmos-db-primary--secondary-keys)
  - [4.6 Azure SQL master / SA keys](#46-azure-sql-master--sa-keys)
  - [4.7 Databricks personal access tokens](#47-databricks-personal-access-tokens)
  - [4.8 ADF linked-service credentials](#48-adf-linked-service-credentials)
- [🚨 5. Emergency Rotation (Compromise)](#-5-emergency-rotation-compromise)
- [✅ 6. Verification](#-6-verification)
- [📋 7. Evidence Preservation](#-7-evidence-preservation)
- [📎 8. Contact Information](#-8-contact-information)
- [🗓️ 9. Drill Log](#️-9-drill-log)
- [🔗 10. Related Documentation](#-10-related-documentation)

---

## 📋 1. Scope

Covers scheduled and emergency rotation for every credential surface on
the platform. For *compromise response*, start in §5 and return to the
per-credential procedure. For *ATO / compliance* rotation schedules,
see [`docs/COMPLIANCE.md`](../COMPLIANCE.md).

Out of scope: user AAD passwords (governed by Entra ID policy), FIDO2 /
certificate re-enrollment (owned by IT endpoint management).

---

## 📅 2. Cadence

| Credential class                        | Scheduled rotation | Automation                                      |
| --------------------------------------- | ------------------ | ----------------------------------------------- |
| Key Vault secrets (generic)             | 90 days            | Secret-rotation Function (event-driven)         |
| Storage account access keys             | 90 days            | Key Vault rotation policy + Function            |
| MSAL token-signing keys                 | 180 days           | App reg rollover — see §4.4                     |
| Cosmos DB primary key                   | 90 days            | Manual + Function syncs Key Vault               |
| SQL admin password / DB master key      | 90 days            | Manual (high risk — run during maintenance)     |
| Databricks PATs                         | 60 days            | Manual; migrate to managed identity where possible |
| ADF linked-service creds                | 90 days            | Automatic via Key Vault reference (no rotation at ADF layer) |
| Service principal client secrets        | Migrate to OIDC FedCred | N/A once migrated                          |

!!! important
    Scheduled rotations run at 02:00 UTC Sunday in the rotation window
    defined in `.github/workflows/deploy.yml` environment guards. Any
    manual rotation during business hours **must** be P2-approved.

---

## 📦 3. Inventory

Every rotatable credential has an entry in Key Vault + an owner tag.
Audit monthly:

```bash
az keyvault secret list --vault-name <vault> \
  --query '[].{name:name,enabled:attributes.enabled,expires:attributes.expires,updated:attributes.updated}' \
  -o table
```

```kql
// Upcoming expirations in the next 30 days
AzureDiagnostics
| where ResourceType == "VAULTS"
| where OperationName == "SecretNearExpiry"
| where TimeGenerated > ago(1d)
| project ResourceId, secretName = tostring(Properties.id), expiryEta = tostring(Properties.expiryTime)
```

---

## 🔒 4. Rotation Procedures

### 4.1 Automated rotation via secret-rotation Function

The `csa_platform/functions/secretRotation/` Function subscribes to Key
Vault `Microsoft.KeyVault.SecretNearExpiry` events and rotates on your
behalf. Happy path requires nothing from the operator.

- [ ] Confirm the function is healthy:
      ```bash
      az monitor app-insights events show \
        --app <ai-resource> --type requests \
        --query "[?customDimensions.function=='rotateSecret']|[0:10]"
      ```
- [ ] On failure, the Function publishes to the `rotation-failed` dead-letter queue. See `docs/runbooks/dead-letter.md`.

### 4.2 Key Vault secret (manual)

1. Create the new version under the **same** secret name (do not create a
   new name — downstream references will not follow you):
   ```bash
   az keyvault secret set --vault-name <vault> --name <secret> --value <new-value>
   ```
2. Give the old version a 24-hour grace window (do not disable immediately):
   ```bash
   az keyvault secret set-attributes --vault-name <vault> --name <secret> \
     --version <old-version> --expires "$(date -u -d '+1 day' +%Y-%m-%dT%H:%M:%SZ)"
   ```
3. Confirm consumers have picked up the new version (restart Key Vault-refreshing pods if they pin the version).
4. After 24 hours, disable the old version.

### 4.3 Storage account access keys

Storage accounts expose keys `key1` and `key2`. Rotate one at a time so
no consumer ever sees an invalid key.

1. Regenerate `key2`:
   ```bash
   az storage account keys renew --account-name <sa> --resource-group <rg> --key key2
   ```
2. Update Key Vault reference to point at the new `key2`.
3. Wait 1 hour for all consumers to pick up (or force-cycle AKS pods / Function apps).
4. Regenerate `key1`:
   ```bash
   az storage account keys renew --account-name <sa> --resource-group <rg> --key key1
   ```
5. Flip Key Vault back to `key1` on the next scheduled rotation.

!!! tip
    Prefer Microsoft Entra ID / managed-identity RBAC over access keys
    wherever possible. Every rotation is a chance to retire one more key.

### 4.4 MSAL / Entra ID token-signing keys

For the portal's BFF and MCP surfaces (see CSA-0020 Phase 3), the app
registration's client credential is either a secret *or* a signing
certificate. The HMAC-sealed MSAL token cache adds a separate per-node
seal key (see `portal/shared/api/` docs — treat the seal key like any
other KV secret, §4.2).

1. Add a new client credential (certificate preferred) without deleting the old one:
   ```bash
   az ad app credential reset --id <app-id> --display-name "rotated-$(date +%Y%m%d)" --years 1
   ```
2. Deploy the new credential to the portal (via Key Vault).
3. Confirm token issuance works against the new credential.
4. Remove the old credential:
   ```bash
   az ad app credential delete --id <app-id> --key-id <old-key-id>
   ```

### 4.5 Cosmos DB primary / secondary keys

Cosmos DB follows the same two-key pattern as Storage.

```bash
az cosmosdb keys regenerate --name <account> --resource-group <rg> --key-kind secondary
# update Key Vault to use the freshly-rotated secondary
az cosmosdb keys regenerate --name <account> --resource-group <rg> --key-kind primary
# flip Key Vault back to primary next rotation
```

### 4.6 Azure SQL master / SA keys

- [ ] Rotate the SQL admin password via portal / CLI. Update the KV entry
      consumed by `portal.shared.api.persistence_factory`.
- [ ] If the database uses a **database master key** (DEK rotation),
      coordinate with the app owner — rotating the master key requires
      re-encrypting column-level encrypted data and may require a
      maintenance window.

### 4.7 Databricks personal access tokens

- [ ] Prefer service-principal OAuth over PATs. PAT rotation = revoke old,
      mint new, update Key Vault.
- [ ] Every PAT must have an expiry < 90 days at creation. Audit via
      Databricks workspace → User Settings → Access Tokens.

### 4.8 ADF linked-service credentials

ADF pulls credentials from Key Vault by reference. Rotating the KV secret
(§4.2) is sufficient — **no redeploy of ADF required**. Validate one
pipeline run after each rotation.

---

## 🚨 5. Emergency Rotation (Compromise)

!!! danger
    Start here if a key is suspected to be compromised. Do **not** wait
    for the scheduled rotation window.

Run the procedures below in parallel where possible.

1. **Contain.** Rotate the compromised credential **immediately** using §4.
   Do not preserve the old version — disable it the moment the new one is in Key Vault.
2. **Audit.** Pull the last 30 days of access logs for every resource the key touched:
   ```kql
   AzureDiagnostics
   | where TimeGenerated > ago(30d)
   | where _ResourceId has "<compromised-resource>"
   | project TimeGenerated, OperationName, CallerIpAddress, ResultType, identity_claim_email_s
   | order by TimeGenerated desc
   ```
3. **Escalate.** Invoke `security-incident.md` — this is a P1/P2 security event, not just an ops event.
4. **Rotate adjacent credentials.** Any credential that shared the same host / identity / storage path should also be rotated (credential theft rarely stays scoped).
5. **Document.** Add a row to the Drill Log in §9 + file a post-incident review task.

---

## ✅ 6. Verification

After every rotation (scheduled or emergency):

- [ ] Every consumer of the rotated credential has issued a successful request
      within the last hour:
      ```kql
      AzureDiagnostics
      | where TimeGenerated > ago(1h)
      | where ResultType == "Success"
      | where _ResourceId has "<resource>"
      | summarize successCount = count() by _ResourceId
      ```
- [ ] No 401 / 403 spike post-rotation:
      ```kql
      AzureDiagnostics
      | where TimeGenerated > ago(1h)
      | where ResultType in ("Unauthorized", "Forbidden")
      | summarize c = count() by bin(TimeGenerated, 5m), ResultType
      ```
- [ ] Key Vault audit shows the rotation event:
      ```kql
      AzureDiagnostics
      | where ResourceType == "VAULTS"
      | where OperationName in ("SecretSet", "KeyUpdate")
      | where TimeGenerated > ago(1h)
      ```

---

## 📋 7. Evidence Preservation

For emergency rotations, preserve:

- [ ] The pre-rotation access log for the compromised resource (export to CSV).
- [ ] The Key Vault audit event for the old version being disabled.
- [ ] The incident ticket + rotation timestamp.
- [ ] The list of adjacent credentials that were rotated as a precaution.

---

## 📎 8. Contact Information

!!! warning
    **Action Required:** Populate these before first production use.

| Role                 | Contact                                       | Phone                         | Escalation                   |
| -------------------- | --------------------------------------------- | ----------------------------- | ---------------------------- |
| Security On-Call     | *(set via your org's security team)*          | *(see PagerDuty / OpsGenie)*  | Compromise events            |
| Platform Team Lead   | *(set via your org's platform team)*          | *(see PagerDuty / OpsGenie)*  | Scheduled rotation issues    |
| Data Eng Lead        | *(set via your org's data eng DL)*            | *(office hours)*              | ADF / Databricks creds       |
| App Reg Owner        | *(per-app registration — see governance RBAC)* | *(DL)*                        | MSAL / Entra ID key rollover |
| Azure Support        | [Case via Portal](https://portal.azure.com/#blade/Microsoft_Azure_Support/HelpAndSupportBlade) | N/A | Platform issues |

---

## 🗓️ 9. Drill Log

| Quarter   | Date  | Type (tabletop / live) | Scenario exercised | Lead  | Gaps identified | Fixes tracked |
| --------- | ----- | ---------------------- | ------------------ | ----- | --------------- | ------------- |
| Q1 — Jan  | _TBD_ | _TBD_                  | _TBD_              | _TBD_ | _TBD_           | _TBD_         |
| Q2 — Apr  | _TBD_ | _TBD_                  | _TBD_              | _TBD_ | _TBD_           | _TBD_         |
| Q3 — Jul  | _TBD_ | _TBD_                  | _TBD_              | _TBD_ | _TBD_           | _TBD_         |
| Q4 — Oct  | _TBD_ | _TBD_                  | _TBD_              | _TBD_ | _TBD_           | _TBD_         |

---

## 🔗 10. Related Documentation

- [Security Incident](./security-incident.md) — Compromise response
- [Tenant Onboarding](./tenant-onboarding.md) — New-tenant key setup
- [Break-Glass Access](./break-glass-access.md) — Emergency admin flow
- [DR Drill](./dr-drill.md) — Key Vault restore scenario
- [COMPLIANCE](../COMPLIANCE.md) — Rotation cadence & regulatory requirements
