# Best Practices: Okta to Entra ID Migration

**Status:** Authored 2026-04-30
**Audience:** Identity Architects, Project Managers, IT Directors
**Purpose:** Proven practices for successful Okta-to-Entra ID migration based on enterprise and federal implementations

---

## Overview

This document captures best practices for planning and executing an Okta-to-Entra ID migration. These practices are drawn from Microsoft's published migration guidance, enterprise migration patterns, and federal identity consolidation projects. Following these practices reduces risk, minimizes user disruption, and accelerates time to value.

---

## 1. Migration planning best practices

### Align with Okta contract timeline

- **Start planning 12-18 months before Okta contract renewal.** This provides adequate time for discovery, migration execution, and validation before the renewal decision date.
- **Issue non-renewal notice early.** Most Okta contracts include 30-90 day non-renewal notice requirements. Missing the notice window triggers auto-renewal (typically 1-3 years).
- **Negotiate short-term extensions if needed.** If migration will extend past the renewal date, negotiate a 6-month or month-to-month extension rather than a multi-year renewal.
- **Budget for overlap.** Plan for 3-6 months of dual-IdP operation (paying for both Okta and using Entra ID) during the transition period.

### Build the migration team

| Role                   | Responsibility                                                            | Allocation                                       |
| ---------------------- | ------------------------------------------------------------------------- | ------------------------------------------------ |
| **Migration lead**     | Overall project ownership, timeline management, stakeholder communication | Full-time during migration                       |
| **Identity architect** | Technical design, policy mapping, federation configuration                | Full-time during migration                       |
| **IAM engineer(s)**    | Application SSO migration, provisioning migration, testing                | Full-time (1-3 engineers depending on app count) |
| **Security engineer**  | Conditional Access design, MFA configuration, risk assessment             | Part-time (50%)                                  |
| **Help desk lead**     | User communication, MFA enrollment support, escalation management         | Part-time (25%), full-time during MFA rollout    |
| **Application owners** | Per-app SSO validation, OIDC configuration updates                        | Part-time (per app)                              |
| **Compliance officer** | ATO impact assessment, SSP updates, 3PAO coordination (federal)           | Part-time (25%)                                  |

### Create a migration playbook

Before executing, document:

- [ ] Complete Okta application inventory with protocol, provisioning, and user count
- [ ] Per-application migration plan (wave assignment, owner, testing criteria)
- [ ] MFA enrollment strategy and timeline
- [ ] Conditional Access policy mapping (Okta sign-on policy -> Entra CA policy)
- [ ] Federation cutover plan with rollback procedures
- [ ] User communication templates (email, intranet, FAQs)
- [ ] Help desk escalation procedures
- [ ] Success criteria and go/no-go decision matrix

---

## 2. Application migration order

### Recommended wave sequence

The order of application migration matters. Migrate in this sequence to minimize risk and build confidence:

| Wave       | Priority | Applications                                            | Rationale                                                                                  |
| ---------- | -------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| **Wave 0** | Highest  | Test/sandbox/dev applications                           | Zero production risk; validates migration procedures                                       |
| **Wave 1** | High     | Microsoft-native apps (already Entra-integrated)        | M365, Azure Portal, Teams -- these are already Entra-native; validates federation cutover  |
| **Wave 2** | High     | Tier 1 gallery SAML apps (Salesforce, ServiceNow, etc.) | Gallery templates provide fast, reliable configuration; high user impact builds confidence |
| **Wave 3** | Medium   | Tier 1 gallery OIDC apps                                | Application teams must update client configuration; requires coordination                  |
| **Wave 4** | Medium   | Tier 2 custom SAML/OIDC apps                            | Manual metadata and claims configuration; more testing required                            |
| **Wave 5** | Medium   | Apps with SCIM provisioning                             | Migrate provisioning connectors after SSO is stable                                        |
| **Wave 6** | Lower    | SWA/password-based apps                                 | Consider upgrading to SAML; lowest security priority                                       |
| **Wave 7** | Lower    | Header-based and legacy apps                            | Requires Application Proxy; most complex configuration                                     |

### Migration anti-patterns

- **DO NOT** migrate all applications at once ("big bang"). This maximizes risk and makes troubleshooting impossible.
- **DO NOT** migrate provisioning before SSO. SSO must be stable before provisioning connectors are switched.
- **DO NOT** migrate MFA before applications. Users need applications working before MFA is enforced.
- **DO NOT** cut federation before all applications are migrated. Federation cutover is the final step.

---

## 3. MFA re-enrollment communication

### Communication timeline

| Timing        | Channel                                    | Message                                                           |
| ------------- | ------------------------------------------ | ----------------------------------------------------------------- |
| **T-30 days** | All-hands meeting + email                  | Announce MFA change; explain why; provide timeline                |
| **T-21 days** | Email + intranet article                   | Detailed enrollment instructions with screenshots                 |
| **T-14 days** | Email + Slack/Teams                        | Reminder with enrollment link (https://aka.ms/mysecurityinfo)     |
| **T-7 days**  | Email + manager notification               | "Final week" reminder; manager asked to encourage team enrollment |
| **T-0**       | System nudge (Entra registration campaign) | Automated nudge at next sign-in                                   |
| **T+7 days**  | Email to unenrolled users                  | Direct outreach to remaining unenrolled users                     |
| **T+14 days** | Email + phone call for stragglers          | IT help desk contacts remaining unenrolled users                  |
| **T+21 days** | Conditional Access enforcement             | Policy enforces Authenticator; Okta Verify no longer accepted     |

### Key messages for users

1. **Why:** "We are consolidating to one sign-in system to improve security and simplify your experience."
2. **What changes:** "You will use Microsoft Authenticator instead of Okta Verify for sign-in verification."
3. **When:** "Complete enrollment by [date]. After this date, Okta Verify will no longer work."
4. **How:** "Install Microsoft Authenticator, then visit https://aka.ms/mysecurityinfo to set up."
5. **Help:** "Contact IT help desk at [number/email] for assistance."

### MFA enrollment success targets

| Milestone     | Target        | Remediation if missed                                      |
| ------------- | ------------- | ---------------------------------------------------------- |
| T+7 (week 1)  | 60% enrolled  | Increase communication frequency                           |
| T+14 (week 2) | 80% enrolled  | Manager escalation for unenrolled team members             |
| T+21 (week 3) | 95% enrolled  | IT-assisted enrollment sessions                            |
| T+28 (week 4) | 98% enrolled  | Individual outreach to remaining users; TAP for enrollment |
| Pre-cutover   | 100% enrolled | Block cutover until 100% (or issue TAPs for remaining)     |

---

## 4. Rollback planning

### Rollback requirements

Every migration phase should have a documented rollback procedure. For the Okta-to-Entra ID migration, the critical rollback scenarios are:

| Scenario                               | Rollback procedure                                              | Time to rollback      |
| -------------------------------------- | --------------------------------------------------------------- | --------------------- |
| **SSO app migration failure**          | Revert application IdP configuration to Okta                    | 15-30 minutes per app |
| **MFA enrollment issues**              | Re-enable Okta Verify as accepted MFA method in CA policies     | 5 minutes             |
| **Conditional Access too restrictive** | Switch policies to report-only mode                             | 5 minutes             |
| **Provisioning failure**               | Re-enable Okta provisioning connector; pause Entra provisioning | 15 minutes            |
| **Federation cutover failure**         | Re-federate domain to Okta (see tutorial)                       | 15-30 minutes         |

### Rollback prerequisites (maintain throughout migration)

- [ ] **Okta tenant remains active** until 90 days post-federation cutover
- [ ] **Okta signing certificate** is not expired
- [ ] **Okta application configurations** are not deleted (deactivated only)
- [ ] **Federation configuration backup** saved (okta-federation-backup.json)
- [ ] **Rollback runbook** reviewed and tested in non-production environment
- [ ] **Rollback team contacts** documented and available 24/7 during cutover

---

## 5. CSA-in-a-Box RBAC integration

### Design Entra groups for CSA-in-a-Box platform access

When migrating from Okta groups to Entra groups, design the group structure to align with CSA-in-a-Box platform roles:

```
CSA-in-a-Box RBAC Group Structure:

    csa-platform-admins          -> Platform administrators (Fabric, ADF, Purview)
    csa-data-engineers           -> Data engineers (Fabric, Databricks, ADF)
    csa-data-analysts            -> Data analysts (Fabric, Power BI, SQL)
    csa-data-scientists          -> Data scientists (Databricks, Azure AI, Fabric)
    csa-governance-admins        -> Governance administrators (Purview, compliance)
    csa-security-admins          -> Security administrators (Sentinel, Defender)

    Per-workspace groups:
    csa-ws-{domain}-contributors -> Workspace contributors for specific domains
    csa-ws-{domain}-viewers      -> Workspace viewers for specific domains

    Per-environment groups:
    csa-env-dev                  -> Development environment access
    csa-env-staging              -> Staging environment access
    csa-env-production           -> Production environment access
```

```powershell
# Create CSA-in-a-Box platform groups
$csaGroups = @(
    @{ Name = "csa-platform-admins"; Desc = "CSA-in-a-Box platform administrators" },
    @{ Name = "csa-data-engineers"; Desc = "CSA-in-a-Box data engineers" },
    @{ Name = "csa-data-analysts"; Desc = "CSA-in-a-Box data analysts" },
    @{ Name = "csa-data-scientists"; Desc = "CSA-in-a-Box data scientists" },
    @{ Name = "csa-governance-admins"; Desc = "CSA-in-a-Box governance administrators" },
    @{ Name = "csa-security-admins"; Desc = "CSA-in-a-Box security administrators" }
)

foreach ($group in $csaGroups) {
    New-MgGroup -DisplayName $group.Name `
                -Description $group.Desc `
                -MailEnabled:$false `
                -MailNickname ($group.Name -replace "-", "") `
                -SecurityEnabled:$true
    Write-Host "Created: $($group.Name)"
}
```

### Map Okta groups to CSA-in-a-Box Entra groups

| Okta group            | Entra group             | CSA-in-a-Box role                   |
| --------------------- | ----------------------- | ----------------------------------- |
| `okta-fabric-admins`  | `csa-platform-admins`   | Fabric workspace admin              |
| `okta-data-engineers` | `csa-data-engineers`    | Fabric contributor, ADF contributor |
| `okta-analysts`       | `csa-data-analysts`     | Fabric viewer, Power BI viewer      |
| `okta-purview-admins` | `csa-governance-admins` | Purview data curator                |
| `okta-security-team`  | `csa-security-admins`   | Sentinel contributor                |

---

## 6. Identity governance consolidation

### Deploy Entra ID Governance alongside migration

The migration is an opportunity to deploy identity governance capabilities that may not have been available in your Okta deployment:

#### Access reviews

```powershell
# Create recurring access review for CSA-in-a-Box platform groups
$accessReview = @{
    displayName = "CSA-in-a-Box Platform Access Review"
    descriptionForAdmins = "Quarterly review of CSA-in-a-Box platform group memberships"
    scope = @{
        query = "/groups?$filter=startswith(displayName, 'csa-')"
        queryType = "MicrosoftGraph"
    }
    reviewers = @(
        @{
            query = "./manager"
            queryType = "MicrosoftGraph"
        }
    )
    settings = @{
        mailNotificationsEnabled = $true
        reminderNotificationsEnabled = $true
        justificationRequiredOnApproval = $true
        defaultDecisionEnabled = $true
        defaultDecision = "Deny"
        instanceDurationInDays = 14
        autoApplyDecisionsEnabled = $true
        recommendationsEnabled = $true
        recurrence = @{
            pattern = @{ type = "absoluteMonthly"; interval = 3 }
            range = @{ type = "noEnd"; startDate = "2026-07-01" }
        }
    }
}
```

#### Privileged Identity Management (PIM)

```powershell
# Configure PIM for CSA-in-a-Box admin roles
# Enable just-in-time activation for platform admin group
# This replaces any Okta Privileged Access configurations

Write-Host "Configure PIM via Entra admin center:"
Write-Host "  1. Navigate to Identity Governance > Privileged Identity Management"
Write-Host "  2. Select 'Groups' under 'Manage'"
Write-Host "  3. Add 'csa-platform-admins' group"
Write-Host "  4. Configure activation settings:"
Write-Host "     - Maximum activation duration: 8 hours"
Write-Host "     - Require justification: Yes"
Write-Host "     - Require approval: Yes (for production)"
Write-Host "     - Require MFA: Yes (phishing-resistant)"
```

---

## 7. Testing and validation

### Pre-migration testing checklist

- [ ] SSO tested for each application with at least 3 users
- [ ] MFA tested for each authentication method (Authenticator push, FIDO2, passwordless)
- [ ] Conditional Access policies validated in report-only mode for 14+ days
- [ ] Provisioning tested for each SCIM connector (create, update, deactivate)
- [ ] Self-service password reset tested
- [ ] Emergency access (break-glass) accounts validated
- [ ] Rollback procedures tested in non-production environment

### Post-migration monitoring (first 30 days)

| Metric                            | Monitoring method           | Alert threshold                   |
| --------------------------------- | --------------------------- | --------------------------------- |
| Authentication failure rate       | Entra sign-in logs          | > 1% failure rate                 |
| MFA success rate                  | Conditional Access insights | < 97% success rate                |
| Help desk ticket volume           | ITSM system                 | > 150% of baseline                |
| Provisioning errors               | Entra provisioning logs     | Any quarantine status             |
| User-reported issues              | Help desk tracking          | > 10 identity-related tickets/day |
| Application-specific SSO failures | Per-app sign-in logs        | Any failure for critical apps     |

```powershell
# Daily monitoring script (run first 30 days post-migration)
$yesterday = (Get-Date).AddDays(-1).ToString("yyyy-MM-ddT00:00:00Z")

# Authentication failures
$failures = Get-MgAuditLogSignIn -Filter "createdDateTime ge $yesterday and status/errorCode ne 0" -All
$total = (Get-MgAuditLogSignIn -Filter "createdDateTime ge $yesterday" -All).Count
$failureRate = [math]::Round($failures.Count / $total * 100, 2)

Write-Host "=== Daily Migration Health Report ==="
Write-Host "Date: $(Get-Date -Format 'yyyy-MM-dd')"
Write-Host "Total sign-ins: $total"
Write-Host "Failures: $($failures.Count) ($failureRate%)"

if ($failureRate -gt 1) {
    Write-Host "WARNING: Failure rate exceeds 1% threshold" -ForegroundColor Red

    # Top failure reasons
    $failures | Group-Object { $_.Status.ErrorCode } | Sort-Object Count -Descending | Select-Object -First 5 | ForEach-Object {
        $errorCode = $_.Name
        $count = $_.Count
        $reason = ($_.Group | Select-Object -First 1).Status.FailureReason
        Write-Host "  Error $errorCode ($count occurrences): $reason"
    }
}

# MFA registration status
$unregistered = Get-MgReportAuthenticationMethodUserRegistrationDetail -Filter "isMfaRegistered eq false" -All
Write-Host "Users without MFA: $($unregistered.Count)"

# Provisioning health
$provisioningIssues = Get-MgAuditLogProvisioning -Filter "createdDateTime ge $yesterday and provisioningStatusInfo/status ne 'success'" -Top 100
Write-Host "Provisioning issues: $($provisioningIssues.Count)"
```

---

## 8. Post-migration optimization

After migration is stable (30-90 days post-cutover):

1. **Enable Security Copilot integration** -- Leverage AI-assisted identity investigation and policy recommendations
2. **Deploy authentication context** -- Add step-up MFA for sensitive actions within CSA-in-a-Box applications
3. **Enable Continuous Access Evaluation (CAE)** -- Near-real-time policy enforcement for supported applications
4. **Implement token protection** -- Prevent token theft and replay attacks
5. **Review Secure Score** -- Address identity security recommendations
6. **Archive Okta audit logs** -- Export Okta System Log for compliance retention requirements before decommissioning tenant
7. **Decommission Okta tenant** -- After 90-day validation period, cancel Okta subscription

---

## 9. Lessons learned (common pitfalls)

| Pitfall                                          | Impact                                               | Prevention                                                                |
| ------------------------------------------------ | ---------------------------------------------------- | ------------------------------------------------------------------------- |
| **Migrating all apps simultaneously**            | Mass SSO failures; impossible to troubleshoot        | Use wave-based migration; 5-10 apps per wave                              |
| **Skipping report-only mode for CA**             | Unexpected access blocks for users                   | Always deploy CA policies in report-only for 14+ days                     |
| **Not validating PHS before federation cutover** | Users unable to sign in after cutover                | Verify PHS sync completes; test pilot users before full cutover           |
| **Insufficient MFA enrollment time**             | Low enrollment at cutover date; forced extensions    | Start enrollment 30 days before enforcement; use nudge campaigns          |
| **Not preserving Okta config for rollback**      | Unable to rollback if issues arise                   | Save federation config, app configs, and certificates before cutover      |
| **Ignoring SWA app upgrade opportunity**         | Maintaining password-vaulted SSO (security weakness) | Contact vendors to upgrade SWA apps to SAML during migration              |
| **Underestimating claims mapping complexity**    | App-specific SSO failures post-migration             | Test claims for each app; validate NameID format and attribute assertions |

---

## Key Microsoft Learn references

- [Migrate applications from Okta to Entra ID](https://learn.microsoft.com/entra/identity/enterprise-apps/migrate-apps-from-okta)
- [Conditional Access best practices](https://learn.microsoft.com/entra/identity/conditional-access/plan-conditional-access)
- [Entra ID deployment checklist](https://learn.microsoft.com/entra/identity/fundamentals/deployment-plans)
- [Access reviews](https://learn.microsoft.com/entra/id-governance/access-reviews-overview)
- [Privileged Identity Management](https://learn.microsoft.com/entra/id-governance/privileged-identity-management/)
- [Microsoft FastTrack](https://learn.microsoft.com/fasttrack/)

---

**Maintainers:** csa-inabox core team
**Last updated:** 2026-04-30
