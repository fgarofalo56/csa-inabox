[Home](../../README.md) > [Docs](../) > [Runbooks](./) > **Certificate Expiration**

# Runbook — Certificate Expiration & Rotation

> **Scope:** Certificates and secrets for managed identities, Key Vault,
> Application Gateway, API Management, custom domains, and Entra ID App
> Registrations across the CSA-in-a-Box platform. Covers proactive
> monitoring, manual and automated rotation, and preventive controls.

## Before First Use — Customization Checklist

- [ ] Populate the [Contact Information](#-contact-information) table.
- [ ] Confirm Key Vault names per environment (dev / staging / prod).
- [ ] Confirm App Gateway resource names and listener bindings.
- [ ] Confirm APIM instance names and custom domain mappings.
- [ ] Wire Event Grid subscriptions for `SecretNearExpiry` and
      `CertificateNearExpiry` events to your alerting pipeline.

## 📑 Table of Contents

- [📋 1. Symptoms](#-1-symptoms)
- [🔍 2. Triage](#-2-triage)
- [📦 3. Certificate Inventory](#-3-certificate-inventory)
- [🔒 4. Rotation Procedures](#-4-rotation-procedures)
- [⚙️ 5. Automation](#️-5-automation)
- [🛡️ 6. Preventive Controls](#️-6-preventive-controls)
- [📎 7. Contact Information](#-7-contact-information)
- [🗓️ 8. Drill Log](#️-8-drill-log)
- [🔗 9. Related Documentation](#-9-related-documentation)

---

## 📋 1. Symptoms

| Symptom                                                       | Typical Source                                               | Severity |
| ------------------------------------------------------------- | ------------------------------------------------------------ | -------- |
| TLS handshake errors (`ERR_CERT_DATE_INVALID`)                | App Gateway listener cert or APIM custom domain cert expired | P1       |
| Service auth failures (401 / 403 on internal API calls)       | Entra ID App Registration secret/certificate expired         | P1       |
| Key Vault `GET secret` returns `Forbidden` / `SecretDisabled` | Key Vault secret expired or access policy revoked            | P2       |
| App Gateway returning 502 Bad Gateway                         | Backend TLS cert expired; gateway cannot complete handshake  | P1       |
| Event Hub / Service Bus `401 Unauthorized` on send/receive    | SAS key expired or rotated without consumer update           | P2       |
| Certificate warning emails from CA (DigiCert / GlobalSign)    | Automated CA notification — cert nearing expiry              | P3       |

---

## 🔍 2. Triage

### Step 1: Identify which certificate expired

- [ ] **Key Vault:** Portal → Key Vault → Certificates. Check the `Expiry Date` column.
- [ ] **App Gateway:** Portal → Application Gateway → Listeners. Each HTTPS listener shows cert status.
- [ ] **APIM:** Portal → API Management → Custom domains. Check thumbprint and expiry.
- [ ] **Entra ID:** Portal → App registrations → select app → Certificates & secrets.

### Step 2: Check Key Vault certificate expiry dashboard

```kql
AzureDiagnostics
| where ResourceType == "VAULTS"
| where OperationName in ("CertificateNearExpiry", "SecretNearExpiry")
| where TimeGenerated > ago(7d)
| project TimeGenerated, vaultName = Resource,
          objectName = tostring(properties_s),
          expiryDate = tostring(parse_json(properties_s).exp)
| order by expiryDate asc
```

### Step 3: Verify managed identity credential status

Managed identities do not have user-rotatable credentials. If a managed
identity is failing, check role assignments and firewall rules — not certs.

```bash
az role assignment list --assignee <mi-object-id> -o table
```

### Step 4: Check App Registration secret/certificate expiry

```bash
az ad app credential list --id <app-id> \
  --query '[].{keyId:keyId,displayName:displayName,endDateTime:endDateTime}' -o table
```

!!! danger
If a credential is already expired and causing production failures,
skip to [§4 Rotation Procedures](#-4-rotation-procedures) immediately.

---

## 📦 3. Certificate Inventory

| Certificate Type                 | Location                             | Rotation Method                                    | Cadence                  |
| -------------------------------- | ------------------------------------ | -------------------------------------------------- | ------------------------ |
| Key Vault TLS certs              | Key Vault → Certificates             | Auto-renew via DigiCert / GlobalSign               | Auto (30d before expiry) |
| App Gateway listener certs       | App Gateway → Listeners (from KV)    | Update KV cert → App Gw picks up via MI            | Follows KV lifecycle     |
| APIM custom domain certs         | APIM → Custom domains (from KV)      | Update KV cert → re-bind in APIM                   | Follows KV lifecycle     |
| Entra ID App Reg secrets         | Entra ID → App Reg → Certs & secrets | Manual: create new → update consumers → delete old | 90 days max              |
| Entra ID App Reg certificates    | Entra ID → App Reg → Certs & secrets | Manual: upload new → update consumers → remove old | 12 months                |
| Managed identity credentials     | Azure-managed                        | No manual rotation needed                          | N/A                      |
| Service Bus / Event Hub SAS keys | Namespace → Shared access policies   | Regenerate primary → update → regenerate secondary | 90 days                  |

---

## 🔒 4. Rotation Procedures

### 4.1 Key Vault auto-rotation setup

- [ ] Navigate to Key Vault → Certificates → select cert → Issuance Policy.
- [ ] Set **Lifetime Action Type** to `AutoRenew`, **Days Before Expiry** to `30`.
- [ ] Confirm CA integration is healthy:
    ```bash
    az keyvault certificate issuer show --vault-name <vault> --issuer-name <issuer>
    ```

!!! tip
For certs not issued by an integrated CA, use the Event Grid
`CertificateNearExpiry` event to trigger an Azure Function for renewal.

### 4.2 Manual certificate rotation (Key Vault → App Gateway)

- [ ] Import the new certificate (PFX with private key) into Key Vault:
    ```bash
    az keyvault certificate import \
      --vault-name <vault> --name <cert-name> --file <path-to-pfx> --password <pfx-password>
    ```
- [ ] App Gateway picks up the new version automatically within 4 hours.
      To force an immediate refresh:
    ```bash
    az network application-gateway ssl-cert update \
      --gateway-name <appgw> --resource-group <rg> --name <ssl-cert-name> \
      --key-vault-secret-id "$(az keyvault certificate show \
        --vault-name <vault> --name <cert-name> --query id -o tsv)"
    ```
- [ ] Validate the listener is serving the new certificate:
    ```bash
    echo | openssl s_client -connect <fqdn>:443 -servername <fqdn> 2>/dev/null \
      | openssl x509 -noout -dates -subject
    ```
- [ ] Monitor for 502 errors in the 30 minutes post-rotation:
    ```kql
    AzureDiagnostics
    | where ResourceType == "APPLICATIONGATEWAYS"
    | where TimeGenerated > ago(30m)
    | where httpStatusCode_d == 502
    | summarize count() by bin(TimeGenerated, 5m)
    ```

### 4.3 App Registration secret rotation

!!! warning
Never delete the old secret before all consumers are updated. The
overlap window prevents downtime.

- [ ] Create a new client secret (do not touch the old one yet):
    ```bash
    az ad app credential reset --id <app-id> --display-name "rotated-$(date +%Y%m%d)" --years 1 --append
    ```
- [ ] Store the new value in Key Vault:
    ```bash
    az keyvault secret set --vault-name <vault> --name <app-secret-name> --value "<new-secret-value>"
    ```
- [ ] Update all consumers (restart pods / Function apps that cache the value).
- [ ] Verify authentication succeeds with the new secret:
    ```kql
    AADServicePrincipalSignInLogs
    | where TimeGenerated > ago(1h)
    | where ServicePrincipalId == "<sp-object-id>"
    | summarize successCount = countif(ResultType == 0),
                failCount = countif(ResultType != 0) by bin(TimeGenerated, 5m)
    ```
- [ ] After 24 hours of confirmed success, delete the old secret:
    ```bash
    az ad app credential delete --id <app-id> --key-id <old-key-id>
    ```

### 4.4 APIM custom domain certificate rotation

- [ ] Import the new certificate into Key Vault (see §4.2).
- [ ] Re-bind in APIM (APIM binds by thumbprint, so a new version requires re-binding):
    ```bash
    az apim update --name <apim-name> --resource-group <rg> \
      --set hostnameConfigurations[0].keyVaultId="<new-secret-id>"
    ```
- [ ] Validate the new cert is served:
    ```bash
    echo | openssl s_client -connect <apim-fqdn>:443 -servername <apim-fqdn> 2>/dev/null \
      | openssl x509 -noout -dates -subject
    ```

### 4.5 SAS key rotation (Service Bus / Event Hub)

- [ ] Regenerate the **secondary** key:
    ```bash
    az servicebus namespace authorization-rule keys renew \
      --namespace-name <ns> --resource-group <rg> --name <rule-name> --key SecondaryKey
    ```
- [ ] Update Key Vault with the new secondary key. Update consumers; wait 1 hour.
- [ ] Regenerate the **primary** key:
    ```bash
    az servicebus namespace authorization-rule keys renew \
      --namespace-name <ns> --resource-group <rg> --name <rule-name> --key PrimaryKey
    ```
- [ ] Next rotation cycle, swap direction (consumers → primary, regenerate secondary).

---

## ⚙️ 5. Automation

### 5.1 Event Grid notifications for near-expiry

```bash
az eventgrid event-subscription create \
  --name cert-expiry-alert \
  --source-resource-id "/subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.KeyVault/vaults/<vault>" \
  --included-event-types Microsoft.KeyVault.CertificateNearExpiry Microsoft.KeyVault.SecretNearExpiry \
  --endpoint-type azurefunction \
  --endpoint "/subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.Web/sites/<func-app>/functions/<func-name>"
```

### 5.2 Automation runbook for non-integrated CA certs

```powershell
$vaultName = "<vault>"
$thresholdDays = 30
$certs = Get-AzKeyVaultCertificate -VaultName $vaultName
foreach ($cert in $certs) {
    $detail = Get-AzKeyVaultCertificate -VaultName $vaultName -Name $cert.Name
    $daysLeft = ($detail.Certificate.NotAfter - (Get-Date)).Days
    if ($daysLeft -le $thresholdDays) {
        Write-Output "EXPIRING: $($cert.Name) expires in $daysLeft days"
        # Trigger renewal logic here
    }
}
```

### 5.3 Azure Policy for certificate lifetime enforcement

```bash
az policy assignment create \
  --name "cert-max-validity" \
  --policy "0a075868-4c26-42ef-914c-5bc007359560" \
  --params '{"maximumValidityInMonths":{"value":12}}' \
  --scope "/subscriptions/<sub>"
```

---

## 🛡️ 6. Preventive Controls

### 6.1 Certificate lifecycle policy

| Control                               | Setting               | Rationale                            |
| ------------------------------------- | --------------------- | ------------------------------------ |
| App Registration secrets max lifetime | 90 days               | NIST 800-53 SC-12 compliance         |
| Key Vault TLS certificates auto-renew | 30 days before expiry | Prevents manual renewal gaps         |
| Key Vault certificate max validity    | 12 months             | Policy-enforced via Azure Policy     |
| SAS keys rotation cadence             | 90 days               | Aligns with secret rotation schedule |

### 6.2 Alert rules for certificates expiring within 30 / 14 / 7 days

| Alert                          | Threshold         | Severity | Action                       |
| ------------------------------ | ----------------- | -------- | ---------------------------- |
| Certificate expiring — 30 days | 30 days to expiry | Sev 3    | Email platform team          |
| Certificate expiring — 14 days | 14 days to expiry | Sev 2    | Email + Teams channel        |
| Certificate expiring — 7 days  | 7 days to expiry  | Sev 1    | PagerDuty / OpsGenie page    |
| Certificate expired            | 0 days            | Sev 0    | Page on-call + auto-incident |

```kql
let threshold = 14d;
AzureDiagnostics
| where ResourceType == "VAULTS"
| where OperationName == "CertificateNearExpiry"
| where TimeGenerated > ago(1d)
| extend certName = tostring(parse_json(properties_s).objectName)
| extend expiryTime = todatetime(parse_json(properties_s).exp)
| where expiryTime - now() < threshold
| project certName, expiryTime, daysRemaining = datetime_diff("day", expiryTime, now()), vaultName = Resource
```

### 6.3 Monitoring setup

Enable Key Vault diagnostics and route to Log Analytics:

```bash
az monitor diagnostic-settings create \
  --name kv-diagnostics \
  --resource "/subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.KeyVault/vaults/<vault>" \
  --workspace "<log-analytics-workspace-id>" \
  --logs '[{"category":"AuditEvent","enabled":true,"retentionPolicy":{"enabled":true,"days":90}}]'
```

---

## 📎 7. Contact Information

!!! warning
**Action Required:** Populate these before first production use.

| Role               | Contact                                                                                        | Phone                        | Escalation                   |
| ------------------ | ---------------------------------------------------------------------------------------------- | ---------------------------- | ---------------------------- |
| Platform On-Call   | _(set via your org's on-call roster)_                                                          | _(see PagerDuty / OpsGenie)_ | First responder              |
| Platform Team Lead | _(set via your org's platform team)_                                                           | _(see PagerDuty / OpsGenie)_ | P1/P2 escalation             |
| Security On-Call   | _(set via your org's security team)_                                                           | _(see PagerDuty / OpsGenie)_ | Compromised certs            |
| App Reg Owner      | _(per-app registration — see governance RBAC)_                                                 | _(DL)_                       | Entra ID credential rotation |
| Azure Support      | [Case via Portal](https://portal.azure.com/#blade/Microsoft_Azure_Support/HelpAndSupportBlade) | N/A                          | Platform issues              |

---

## 🗓️ 8. Drill Log

Run this runbook in tabletop form quarterly. Add one row per drill.

| Quarter  | Date  | Type (tabletop / live) | Scenario exercised | Lead  | Gaps identified | Fixes tracked |
| -------- | ----- | ---------------------- | ------------------ | ----- | --------------- | ------------- |
| Q1 — Jan | _TBD_ | _TBD_                  | _TBD_              | _TBD_ | _TBD_           | _TBD_         |
| Q2 — Apr | _TBD_ | _TBD_                  | _TBD_              | _TBD_ | _TBD_           | _TBD_         |
| Q3 — Jul | _TBD_ | _TBD_                  | _TBD_              | _TBD_ | _TBD_           | _TBD_         |
| Q4 — Oct | _TBD_ | _TBD_                  | _TBD_              | _TBD_ | _TBD_           | _TBD_         |

---

## 🔗 9. Related Documentation

- [Key Rotation](./key-rotation.md) — Secret and access key rotation procedures
- [Security Incident](./security-incident.md) — Compromise response
- [Break-Glass Access](./break-glass-access.md) — Emergency admin flow
- [DR Drill](./dr-drill.md) — Key Vault restore scenario
- [Dead Letter](./dead-letter.md) — Rotation failure dead-letter recovery
