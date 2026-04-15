# Incident Response Runbook — Security Events

> **Last Updated:** 2026-04-14 | **Status:** Active | **Audience:** Operations

## Table of Contents

- [Scope](#scope)
- [Severity Classification](#severity-classification)
- [Initial Response (All Severities)](#initial-response-all-severities)
  - [Step 1: Assess](#step-1-assess)
  - [Step 2: Contain](#step-2-contain)
  - [Step 3: Investigate](#step-3-investigate)
  - [Step 4: Eradicate](#step-4-eradicate)
  - [Step 5: Recover](#step-5-recover)
  - [Step 6: Post-Incident](#step-6-post-incident)
- [Common Scenarios](#common-scenarios)
  - [Scenario A: Exposed Storage Account Key](#scenario-a-exposed-storage-account-key)
  - [Scenario B: Databricks Token Leaked](#scenario-b-databricks-token-leaked)
  - [Scenario C: Azure Policy Non-Compliance](#scenario-c-azure-policy-non-compliance)
  - [Scenario D: Cosmos DB Unauthorized Access](#scenario-d-cosmos-db-unauthorized-access)
  - [Scenario E: ADF Pipeline Tampering](#scenario-e-adf-pipeline-tampering)
  - [Scenario F: Key Vault Secret Expiry or Compromise](#scenario-f-key-vault-secret-expiry-or-compromise)
- [Evidence Preservation Checklist](#evidence-preservation-checklist)
- [Communication Templates](#communication-templates)
  - [Internal notification (P1/P2)](#internal-notification-p1p2)
  - [Stakeholder update](#stakeholder-update)
- [Contact Information](#contact-information)

## Scope
This runbook covers security incidents detected on the CSA-in-a-Box data platform,
including unauthorized access, data exfiltration, and configuration tampering.

## Severity Classification

| Severity | Description | Response Time | Escalation |
|----------|-------------|---------------|------------|
| P1 — Critical | Active data breach, credentials exposed | 1 hour | CISO, Legal |
| P2 — High | Unauthorized access attempt, policy violation | 4 hours | Platform Team Lead |
| P3 — Medium | Configuration drift, suspicious activity | 24 hours | On-call engineer |
| P4 — Low | Informational alert, audit finding | 72 hours | Team queue |

## Initial Response (All Severities)

### Step 1: Assess
```kql
// Check recent security alerts
SecurityAlert
| where TimeGenerated > ago(1h)
| project TimeGenerated, AlertName, AlertSeverity, Description, RemediationSteps
| order by TimeGenerated desc
```

### Step 2: Contain
1. **DO NOT** delete evidence or modify logs
2. If active breach: Disable compromised identities immediately
   ```powershell
   # Disable service principal
   Update-AzADServicePrincipal -ObjectId <id> -AccountEnabled $false
   ```
3. If data exfiltration: Block outbound traffic via firewall rule
4. Preserve current state: Take storage account snapshots

### Step 3: Investigate
```kql
// Track activity of compromised identity
AzureActivity
| where Caller == "<compromised-identity>"
| where TimeGenerated > ago(24h)
| project TimeGenerated, OperationNameValue, ResourceGroup, _ResourceId
| order by TimeGenerated desc
```

### Step 4: Eradicate
1. Rotate all credentials associated with the compromised identity
2. Revoke Key Vault access
   ```powershell
   Remove-AzKeyVaultAccessPolicy -VaultName <vault> -ObjectId <id>
   ```
3. Remove unauthorized role assignments
4. Update NSG / Firewall rules if network-based attack

### Step 5: Recover
1. Verify all unauthorized access is revoked
2. Re-enable services with new credentials
3. Monitor for 48 hours for recurrence

### Step 6: Post-Incident
1. Create incident report (within 72 hours)
2. Update RBAC matrix if access was overly broad
3. Add detection rules for the attack vector
4. Schedule review with stakeholders

## Common Scenarios

### Scenario A: Exposed Storage Account Key
1. Rotate storage account keys immediately
2. Update all Key Vault references
3. Audit access logs for the exposure window
4. Check for data exfiltration in firewall logs

### Scenario B: Databricks Token Leaked
1. Revoke the token via Databricks admin console
2. Audit Unity Catalog access logs
3. Check for unauthorized data access
4. Re-issue token with tighter scope

### Scenario C: Azure Policy Non-Compliance
1. Run compliance scan: `Get-AzPolicyState -SubscriptionId <id>`
2. Identify non-compliant resources
3. Remediate or create exemptions with justification
4. Update policy assignments if false positive

### Scenario D: Cosmos DB Unauthorized Access
1. Check Cosmos DB diagnostic logs for unusual query patterns
   ```kql
   CDBDataPlaneRequests
   | where TimeGenerated > ago(24h)
   | where StatusCode >= 400
   | summarize count() by ClientIpAddress, OperationName, bin(TimeGenerated, 1h)
   | order by count_ desc
   ```
2. Rotate Cosmos DB primary and secondary keys
3. Update all Key Vault secrets referencing Cosmos DB keys
4. Review firewall rules — restrict to VNet-only access
5. If data was read: assess PII exposure and activate data breach protocol

### Scenario E: ADF Pipeline Tampering
1. Check ADF activity runs for unauthorized modifications
   ```kql
   ADFActivityRun
   | where TimeGenerated > ago(7d)
   | where Status == "Succeeded" and ActivityType == "Copy"
   | where Sink !contains "bronze" and Sink !contains "silver" and Sink !contains "gold"
   | project TimeGenerated, PipelineName, ActivityName, Sink, Source
   ```
2. Compare current pipeline definitions to Git (source of truth)
3. Redeploy pipelines from Git: `./scripts/deploy/deploy-adf.sh`
4. Review ADF managed identity permissions
5. Check for unauthorized linked services or datasets

### Scenario F: Key Vault Secret Expiry or Compromise
1. List expired or expiring secrets
   ```bash
   az keyvault secret list --vault-name <vault> \
       --query "[?attributes.expires < '$(date -u +%Y-%m-%dT%H:%M:%SZ)']"
   ```
2. Rotate affected secrets using the secret rotation function
3. Verify all dependent services restart with new secrets
4. Check audit logs for unauthorized secret reads

## Evidence Preservation Checklist

Before any remediation, preserve evidence:

- [ ] Screenshot or export of the security alert
- [ ] Export relevant Log Analytics queries to CSV
- [ ] Take ADLS storage account snapshots (if data breach suspected)
- [ ] Export AAD sign-in logs for the affected identities
- [ ] Save NSG flow logs for the relevant time window
- [ ] Document the timeline of events in the incident ticket

## Communication Templates

### Internal notification (P1/P2)

> **Subject:** [P1/P2] Security Incident — CSA Data Platform
>
> **Summary:** [Brief description of the incident]
> **Detected:** [Timestamp UTC]
> **Impact:** [What data/services are affected]
> **Status:** [Investigating / Contained / Remediated]
> **Next update:** [Time]
>
> **Actions taken:**
> 1. [Action 1]
> 2. [Action 2]

### Stakeholder update

> **Subject:** Security Incident Update #[N]
>
> **Current status:** [Contained / Under investigation]
> **Root cause:** [Known / Under investigation]
> **Data impact:** [No PII exposed / Assessing / Confirmed exposure]
> **Remediation ETA:** [Time]

## Contact Information

> **Action Required:** Update these contacts with your organization's actual
> personnel before using this runbook in production.  File a PR against this
> table whenever roles change.

| Role | Contact | Phone | Escalation |
|------|---------|-------|------------|
| Platform Team Lead | *(set via your org's on-call roster)* | *(see PagerDuty / OpsGenie)* | First responder |
| Security Officer | *(set via your org's security team DL)* | *(see PagerDuty / OpsGenie)* | P1/P2 escalation |
| Data Protection Officer | *(set via your org's DPO)* | *(office hours)* | PII breach only |
| Legal Counsel | *(set via your org's legal team)* | *(office hours)* | P1 with data exposure |
| Azure Support | [Case via Portal](https://portal.azure.com/#blade/Microsoft_Azure_Support/HelpAndSupportBlade) | N/A | Platform issues |

---

*Last Updated: 2026-04-13*

---

## Related Documentation

- [Troubleshooting](../TROUBLESHOOTING.md) - Common issues and fixes
- [Log Schema](../LOG_SCHEMA.md) - Structured logging schema reference
- [Gov Service Matrix](../GOV_SERVICE_MATRIX.md) - Azure Government service availability
