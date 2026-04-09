# Incident Response Runbook — Security Events

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

## Contact Information

| Role | Contact | Phone |
|------|---------|-------|
| Platform Team Lead | [PLACEHOLDER] | [PLACEHOLDER] |
| Security Officer | [PLACEHOLDER] | [PLACEHOLDER] |
| Azure Support | [Case via Portal] | N/A |

---

*Last Updated: 2026-04-09*
