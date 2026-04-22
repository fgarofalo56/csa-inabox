[Home](../../README.md) > [Docs](../) > [Runbooks](./) > **Security Incident**

# Incident Response Runbook — Security Events

> **Last Updated:** 2026-04-20 | **Last Drilled:** _not yet drilled — see Drill Log below (CSA-0085)_ | **Status:** Active | **Audience:** Operations

!!! note
    **Quick Summary**: Step-by-step incident response procedures for CSA-in-a-Box security events, including severity classification (P1-P4), containment steps, investigation KQL queries, common scenarios (exposed keys, token leaks, policy violations, pipeline tampering), evidence preservation, and communication templates.

## ✅ Before First Use — Customization Checklist (CSA-0070)

This runbook ships with **placeholder contacts**. It is not safe to invoke
in a live incident until your organisation has completed the items
below. Check each off in a PR against this file so the runbook history
reflects who customised which fields and when.

- [ ] Populate the [Contact Information](#-contact-information) table with
      your Platform Team Lead, Security Officer, Data Protection
      Officer, and Legal Counsel. Remove the `*(set via ...)*` stubs.
- [ ] Replace generic Azure Support link with your organisation's
      Azure TAM / Premier Support channel if applicable.
- [ ] Wire up an on-call rotation in PagerDuty / OpsGenie / Teams
      Shifts — paste the on-call URL into the Contact table.
- [ ] Confirm your SOC queue address (DL) for the internal notification
      template under [Communication Templates](#-communication-templates).
- [ ] Add any region-specific legal notification windows (e.g. GDPR
      72-hour DPO notification, HIPAA 60-day breach notification).
- [ ] Update the **Last Drilled** banner above and the
      [Drill Log](#️-drill-log-csa-0085) after each tabletop / live drill.

!!! warning
    **Do not remove this section** after first use. New operators need
    the same onboarding pass on every fork / airgapped deployment.

## 📑 Table of Contents

- [📋 Scope](#-scope)
- [🔒 Severity Classification](#-severity-classification)
- [🚀 Initial Response (All Severities)](#-initial-response-all-severities)
  - [Step 1: Assess](#step-1-assess)
  - [Step 2: Contain](#step-2-contain)
  - [Step 3: Investigate](#step-3-investigate)
  - [Step 4: Eradicate](#step-4-eradicate)
  - [Step 5: Recover](#step-5-recover)
  - [Step 6: Post-Incident](#step-6-post-incident)
- [💡 Common Scenarios](#-common-scenarios)
  - [Scenario A: Exposed Storage Account Key](#scenario-a-exposed-storage-account-key)
  - [Scenario B: Databricks Token Leaked](#scenario-b-databricks-token-leaked)
  - [Scenario C: Azure Policy Non-Compliance](#scenario-c-azure-policy-non-compliance)
  - [Scenario D: Cosmos DB Unauthorized Access](#scenario-d-cosmos-db-unauthorized-access)
  - [Scenario E: ADF Pipeline Tampering](#scenario-e-adf-pipeline-tampering)
  - [Scenario F: Key Vault Secret Expiry or Compromise](#scenario-f-key-vault-secret-expiry-or-compromise)
- [📋 Evidence Preservation Checklist](#-evidence-preservation-checklist)
- [📝 Communication Templates](#-communication-templates)
  - [Internal notification (P1/P2)](#internal-notification-p1p2)
  - [Stakeholder update](#stakeholder-update)
- [📎 Contact Information](#-contact-information)

---

## 📋 Scope

This runbook covers security incidents detected on the CSA-in-a-Box data platform,
including unauthorized access, data exfiltration, and configuration tampering.

---

## 🔒 Severity Classification

| Severity | Description | Response Time | Escalation |
|----------|-------------|---------------|------------|
| P1 — Critical | Active data breach, credentials exposed | 1 hour | CISO, Legal |
| P2 — High | Unauthorized access attempt, policy violation | 4 hours | Platform Team Lead |
| P3 — Medium | Configuration drift, suspicious activity | 24 hours | On-call engineer |
| P4 — Low | Informational alert, audit finding | 72 hours | Team queue |

---

## 🚀 Initial Response (All Severities)

### Step 1: Assess
```kql
// Check recent security alerts
SecurityAlert
| where TimeGenerated > ago(1h)
| project TimeGenerated, AlertName, AlertSeverity, Description, RemediationSteps
| order by TimeGenerated desc
```

### Step 2: Contain

!!! danger
    **DO NOT** delete evidence or modify logs.

- [ ] If active breach: Disable compromised identities immediately
   ```powershell
   # Disable service principal
   Update-AzADServicePrincipal -ObjectId <id> -AccountEnabled $false
   ```
- [ ] If data exfiltration: Block outbound traffic via firewall rule
- [ ] Preserve current state: Take storage account snapshots

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
- [ ] Rotate all credentials associated with the compromised identity
- [ ] Revoke Key Vault access
   ```powershell
   Remove-AzKeyVaultAccessPolicy -VaultName <vault> -ObjectId <id>
   ```
- [ ] Remove unauthorized role assignments
- [ ] Update NSG / Firewall rules if network-based attack

### Step 5: Recover
- [ ] Verify all unauthorized access is revoked
- [ ] Re-enable services with new credentials
- [ ] Monitor for 48 hours for recurrence

### Step 6: Post-Incident
- [ ] Create incident report (within 72 hours)
- [ ] Update RBAC matrix if access was overly broad
- [ ] Add detection rules for the attack vector
- [ ] Schedule review with stakeholders

---

## 💡 Common Scenarios

### Scenario A: Exposed Storage Account Key
- [ ] Rotate storage account keys immediately
- [ ] Update all Key Vault references
- [ ] Audit access logs for the exposure window
- [ ] Check for data exfiltration in firewall logs

### Scenario B: Databricks Token Leaked
- [ ] Revoke the token via Databricks admin console
- [ ] Audit Unity Catalog access logs
- [ ] Check for unauthorized data access
- [ ] Re-issue token with tighter scope

### Scenario C: Azure Policy Non-Compliance
- [ ] Run compliance scan: `Get-AzPolicyState -SubscriptionId <id>`
- [ ] Identify non-compliant resources
- [ ] Remediate or create exemptions with justification
- [ ] Update policy assignments if false positive

### Scenario D: Cosmos DB Unauthorized Access
- [ ] Check Cosmos DB diagnostic logs for unusual query patterns
   ```kql
   CDBDataPlaneRequests
   | where TimeGenerated > ago(24h)
   | where StatusCode >= 400
   | summarize count() by ClientIpAddress, OperationName, bin(TimeGenerated, 1h)
   | order by count_ desc
   ```
- [ ] Rotate Cosmos DB primary and secondary keys
- [ ] Update all Key Vault secrets referencing Cosmos DB keys
- [ ] Review firewall rules — restrict to VNet-only access
- [ ] If data was read: assess PII exposure and activate data breach protocol

### Scenario E: ADF Pipeline Tampering
- [ ] Check ADF activity runs for unauthorized modifications
   ```kql
   ADFActivityRun
   | where TimeGenerated > ago(7d)
   | where Status == "Succeeded" and ActivityType == "Copy"
   | where Sink !contains "bronze" and Sink !contains "silver" and Sink !contains "gold"
   | project TimeGenerated, PipelineName, ActivityName, Sink, Source
   ```
- [ ] Compare current pipeline definitions to Git (source of truth)
- [ ] Redeploy pipelines from Git: `./scripts/deploy/deploy-adf.sh`
- [ ] Review ADF managed identity permissions
- [ ] Check for unauthorized linked services or datasets

### Scenario F: Key Vault Secret Expiry or Compromise
- [ ] List expired or expiring secrets
   ```bash
   az keyvault secret list --vault-name <vault> \
       --query "[?attributes.expires < '$(date -u +%Y-%m-%dT%H:%M:%SZ)']"
   ```
- [ ] Rotate affected secrets using the secret rotation function
- [ ] Verify all dependent services restart with new secrets
- [ ] Check audit logs for unauthorized secret reads

---

## 📋 Evidence Preservation Checklist

!!! important
    Before any remediation, preserve evidence:

- [ ] Screenshot or export of the security alert
- [ ] Export relevant Log Analytics queries to CSV
- [ ] Take ADLS storage account snapshots (if data breach suspected)
- [ ] Export AAD sign-in logs for the affected identities
- [ ] Save NSG flow logs for the relevant time window
- [ ] Document the timeline of events in the incident ticket

---

## 📝 Communication Templates

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

---

## 📎 Contact Information

!!! warning
    **Action Required:** Update these contacts with your organization's actual
    personnel before using this runbook in production. File a PR against this
    table whenever roles change.

| Role | Contact | Phone | Escalation |
|------|---------|-------|------------|
| Platform Team Lead | *(set via your org's on-call roster)* | *(see PagerDuty / OpsGenie)* | First responder |
| Security Officer | *(set via your org's security team DL)* | *(see PagerDuty / OpsGenie)* | P1/P2 escalation |
| Data Protection Officer | *(set via your org's DPO)* | *(office hours)* | PII breach only |
| Legal Counsel | *(set via your org's legal team)* | *(office hours)* | P1 with data exposure |
| Azure Support | [Case via Portal](https://portal.azure.com/#blade/Microsoft_Azure_Support/HelpAndSupportBlade) | N/A | Platform issues |

---

## 🗓️ Drill Log (CSA-0085)

Runbook currency is measured by drill cadence. Add one row per
tabletop or live drill. Blocks should run **quarterly** at a
minimum (Jan / Apr / Jul / Oct). File a PR updating this table and the
`Last Drilled:` banner at the top of the document after every
exercise.

| Quarter | Date | Type (tabletop / live) | Scenario exercised | Lead | Gaps identified | Fixes tracked |
|---------|------|------------------------|--------------------|------|------------------|---------------|
| Q1 — Jan | _TBD_ | _TBD_ | _TBD_ | _TBD_ | _TBD_ | _TBD_ |
| Q2 — Apr | _TBD_ | _TBD_ | _TBD_ | _TBD_ | _TBD_ | _TBD_ |
| Q3 — Jul | _TBD_ | _TBD_ | _TBD_ | _TBD_ | _TBD_ | _TBD_ |
| Q4 — Oct | _TBD_ | _TBD_ | _TBD_ | _TBD_ | _TBD_ | _TBD_ |

!!! tip
    Archive historical drill log tables under a collapsed `<details>`
    block once a calendar year completes; keep the current year's rows
    visible.

---

## 🔗 Related Documentation

- [Troubleshooting](../TROUBLESHOOTING.md) — Common issues and fixes
- [Log Schema](../LOG_SCHEMA.md) — Structured logging schema reference
- [Gov Service Matrix](../GOV_SERVICE_MATRIX.md) — Azure Government service availability
