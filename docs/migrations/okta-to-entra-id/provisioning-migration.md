# Provisioning Migration: Okta to Entra ID

**Status:** Authored 2026-04-30
**Audience:** Identity Architects, IAM Engineers, HR Systems Administrators
**Purpose:** Detailed guidance for migrating user provisioning from Okta to Entra ID provisioning service

---

## Overview

Okta provisioning automates user lifecycle management across SaaS applications -- creating accounts when users join, updating attributes when roles change, and deactivating accounts when users leave. Entra ID provisioning service provides equivalent SCIM-based provisioning with native integration into the Microsoft ecosystem.

This guide covers migration of SCIM provisioning connectors, HR-driven inbound provisioning (Workday, SuccessFactors), attribute mapping, group synchronization, and deprovisioning policies.

Microsoft has published dedicated guidance: [Migrate Okta sync provisioning to Entra Connect-based synchronization](https://learn.microsoft.com/entra/identity/enterprise-apps/migrate-okta-sync-provisioning-to-azure-active-directory-connect-based-synchronization).

---

## 1. Provisioning inventory

### Export Okta provisioning configuration

```bash
# List all Okta applications with provisioning features
curl -s -H "Authorization: SSWS ${OKTA_API_TOKEN}" \
  "https://${OKTA_DOMAIN}/api/v1/apps?limit=200&filter=status+eq+%22ACTIVE%22" \
  | jq '[.[] | select(.features != null and (.features | length > 0)) | {
    id: .id,
    label: .label,
    signOnMode: .signOnMode,
    features: .features,
    provisioningType: (
      if (.features | contains(["PUSH_NEW_USERS"])) then "Outbound (Create)"
      elif (.features | contains(["IMPORT_NEW_USERS"])) then "Inbound (Import)"
      else "Profile sync only" end
    )
  }]' > okta-provisioning-inventory.json
```

### Categorize provisioning connectors

| Category                | Description                                                           | Migration approach                                |
| ----------------------- | --------------------------------------------------------------------- | ------------------------------------------------- |
| **SCIM outbound**       | Okta pushes users/groups to SaaS apps (Salesforce, ServiceNow, Slack) | Migrate to Entra provisioning service (SCIM)      |
| **HR inbound**          | HR system (Workday, SuccessFactors) provisions users into Okta        | Migrate to Entra HR provisioning connectors       |
| **Profile sync**        | Attribute synchronization between Okta and apps                       | Configure attribute mapping in Entra provisioning |
| **Group push**          | Group membership pushed to downstream apps                            | Configure group-based assignment in Entra         |
| **Custom provisioning** | Okta Workflows or custom API integration                              | Redesign using Logic Apps or Lifecycle Workflows  |

---

## 2. SCIM connector migration

### Migration steps for each SCIM connector

For each application with SCIM provisioning in Okta:

```powershell
# Step 1: Identify the Entra Enterprise Application
$app = Get-MgServicePrincipal -Filter "displayName eq 'Salesforce'"

# Step 2: Enable provisioning
$provisioningConfig = @{
    provisioningMode = "automatic"
}
# Note: Provisioning configuration is typically done via the Entra admin center
# The Graph API for provisioning is under the /servicePrincipals/{id}/synchronization namespace

# Step 3: Configure provisioning credentials
# Navigate to Entra admin center > Enterprise Applications > {app} > Provisioning
# Enter SCIM endpoint URL and authentication token from the target application
# These are the same credentials used in Okta provisioning configuration

# Step 4: Configure attribute mapping (see section 3)

# Step 5: Test provisioning
# Entra admin center > Provisioning > Provision on demand
# Select a test user and verify provisioning succeeds

# Step 6: Start provisioning
# Set provisioning mode from "manual" to "automatic"
# Initial cycle runs; subsequent incremental cycles run every 40 minutes
```

### Okta-to-Entra provisioning mapping

| Okta provisioning concept     | Entra provisioning equivalent                            |
| ----------------------------- | -------------------------------------------------------- |
| SCIM base URL                 | Tenant URL (same SCIM endpoint)                          |
| API token / OAuth credentials | Secret Token or OAuth (same credentials from target app) |
| Provisioning to App           | Provisioning mode: Automatic                             |
| Profile Master                | Source of authority (attribute mapping direction)        |
| Attribute mapping             | Attribute mapping (Entra expression language)            |
| Push Groups                   | Scope: Sync assigned users and groups                    |
| Import Users                  | Inbound provisioning (HR connectors)                     |
| Provisioning Rules            | Scoping filters                                          |
| Deactivate Users              | Deprovisioning action: Disable / Delete                  |

---

## 3. Attribute mapping migration

### Okta attribute mapping to Entra attribute mapping

| Okta expression                          | Entra expression                                       | Purpose                           |
| ---------------------------------------- | ------------------------------------------------------ | --------------------------------- |
| `user.firstName`                         | `[givenName]`                                          | First name                        |
| `user.lastName`                          | `[surname]`                                            | Last name                         |
| `user.email`                             | `[mail]` or `[userPrincipalName]`                      | Email address                     |
| `user.login`                             | `[userPrincipalName]`                                  | Login identifier                  |
| `user.department`                        | `[department]`                                         | Department                        |
| `user.title`                             | `[jobTitle]`                                           | Job title                         |
| `user.manager`                           | `[manager]`                                            | Manager reference                 |
| `user.employeeNumber`                    | `[employeeId]`                                         | Employee ID                       |
| `String.substringAfter(user.email, "@")` | `Split([mail], "@")[1]`                                | Extract email domain              |
| `user.status == "ACTIVE" ? true : false` | `IIF([accountEnabled] = "True", "Active", "Inactive")` | Status conversion                 |
| `String.toUpperCase(user.department)`    | `ToUpper([department])`                                | Uppercase conversion              |
| Custom Okta attribute                    | Extension attribute or custom mapping                  | Map to Entra extension attributes |

### Complex attribute mapping examples

```
# Entra provisioning expression: Generate display name
Join(" ", [givenName], [surname])

# Entra provisioning expression: Conditional department mapping
Switch([department],
    "Unknown",
    "ENG", "Engineering",
    "MKT", "Marketing",
    "FIN", "Finance",
    "HR", "Human Resources")

# Entra provisioning expression: Extract employee type
IIF(IsPresent([employeeType]),
    Switch([employeeType], "Employee", "C", "Contractor", "V", "Vendor"),
    "Employee")

# Entra provisioning expression: Generate SAMAccountName from UPN
Left(Split([userPrincipalName], "@")[0], 20)
```

---

## 4. HR-driven provisioning migration

### Workday inbound provisioning

Okta's Workday integration provisions users from Workday into Okta's Universal Directory. Entra's native Workday connector provisions users directly into Entra ID (or on-premises AD via Cloud Sync).

```powershell
# Configure Workday inbound provisioning
# This is configured via the Entra admin center:
# Enterprise Applications > Workday to Azure AD User Provisioning

# Key configuration steps:
# 1. Provide Workday API credentials (ISU account)
# 2. Map Workday worker attributes to Entra user attributes
# 3. Configure matching rules (Worker ID -> employeeId)
# 4. Set scoping filters (active workers, specific supervisory orgs)
# 5. Test with provision-on-demand
# 6. Enable automatic provisioning
```

#### Workday attribute mapping

| Workday attribute | Okta mapping                       | Entra mapping                        |
| ----------------- | ---------------------------------- | ------------------------------------ |
| Worker ID         | `profile.employeeNumber`           | `employeeId`                         |
| Legal First Name  | `profile.firstName`                | `givenName`                          |
| Legal Last Name   | `profile.lastName`                 | `surname`                            |
| Email Address     | `profile.email`                    | `mail`                               |
| Supervisory Org   | `profile.department`               | `department`                         |
| Job Title         | `profile.title`                    | `jobTitle`                           |
| Manager Worker ID | `profile.manager`                  | `manager` (via lookup)               |
| Location          | `profile.city`, `profile.state`    | `city`, `state`                      |
| Cost Center       | `profile.costCenter`               | `companyName` or extension attribute |
| Worker Status     | `profile.status` (active/inactive) | `accountEnabled` (true/false)        |

### SuccessFactors inbound provisioning

```powershell
# Configure SuccessFactors inbound provisioning
# Enterprise Applications > SAP SuccessFactors to Azure AD User Provisioning

# Similar configuration pattern to Workday:
# 1. Provide SuccessFactors API credentials
# 2. Map Employee Central attributes to Entra user attributes
# 3. Configure matching rules
# 4. Set scoping filters
# 5. Test and enable
```

---

## 5. Group provisioning

### Okta group push to Entra group-based provisioning

Okta's "Push Groups" feature pushes group membership to downstream applications. Entra's equivalent uses group-based application assignment with provisioning.

```powershell
# Step 1: Create Entra security groups matching Okta groups
$groups = @(
    @{ DisplayName = "Salesforce-Users"; Description = "Users provisioned to Salesforce" },
    @{ DisplayName = "ServiceNow-Users"; Description = "Users provisioned to ServiceNow" },
    @{ DisplayName = "Slack-Users"; Description = "Users provisioned to Slack" }
)

foreach ($group in $groups) {
    New-MgGroup -DisplayName $group.DisplayName `
                -Description $group.Description `
                -MailEnabled:$false `
                -MailNickname ($group.DisplayName -replace "[^a-zA-Z0-9]", "") `
                -SecurityEnabled:$true
}

# Step 2: Assign groups to enterprise applications
$salesforceApp = Get-MgServicePrincipal -Filter "displayName eq 'Salesforce'"
$salesforceGroup = Get-MgGroup -Filter "displayName eq 'Salesforce-Users'"

New-MgServicePrincipalAppRoleAssignment -ServicePrincipalId $salesforceApp.Id -Body @{
    principalId = $salesforceGroup.Id
    resourceId = $salesforceApp.Id
    appRoleId = "00000000-0000-0000-0000-000000000000"  # Default access role
}

# Step 3: Configure provisioning scope to "Sync assigned users and groups"
# This ensures only members of the assigned group are provisioned
```

### Dynamic groups (replacing Okta group rules)

```powershell
# Create dynamic group equivalent to Okta group rule
# Okta rule: user.department == "Engineering" AND user.status == "ACTIVE"

New-MgGroup -DisplayName "Engineering-Dynamic" `
            -Description "All active Engineering department users" `
            -MailEnabled:$false `
            -MailNickname "EngineeringDynamic" `
            -SecurityEnabled:$true `
            -GroupTypes @("DynamicMembership") `
            -MembershipRule "(user.department -eq `"Engineering`") and (user.accountEnabled -eq true)" `
            -MembershipRuleProcessingState "On"
```

---

## 6. Deprovisioning policies

### Okta deprovisioning to Entra deprovisioning

| Okta deprovisioning action | Entra provisioning equivalent     | Configuration             |
| -------------------------- | --------------------------------- | ------------------------- |
| Deactivate user in app     | Disable user in app (soft delete) | Deprovisioning: Disable   |
| Remove user from app       | Delete user in app (hard delete)  | Deprovisioning: Delete    |
| Do nothing                 | Skip deprovisioning               | No action on unassignment |
| Suspend user               | Disable user (platform-dependent) | Disable with flag         |

```powershell
# Configure deprovisioning behavior
# In Entra admin center > Enterprise Applications > {app} > Provisioning > Settings

# Options for "When a user falls out of scope":
# 1. "Disable" - Sends SCIM PATCH to set active=false (recommended)
# 2. "Delete" - Sends SCIM DELETE to remove the user (use with caution)

# Accidental deletion prevention
# Entra provisioning includes a deletion threshold (default: 500)
# If more than threshold users would be deleted in a cycle, provisioning pauses
# This prevents mass deletion from misconfigured scoping filters
```

---

## 7. Lifecycle Workflows (replacing Okta lifecycle automation)

Entra ID Governance Lifecycle Workflows replace Okta's lifecycle management automation:

```powershell
# Create a Joiner workflow (equivalent to Okta's onboarding automation)
$joinerWorkflow = @{
    displayName = "New Employee Onboarding"
    description = "Automated onboarding for new employees"
    isEnabled = $true
    isSchedulingEnabled = $true
    executionConditions = @{
        "@odata.type" = "#microsoft.graph.identityGovernance.triggerAndScopeBasedConditions"
        scope = @{
            "@odata.type" = "#microsoft.graph.identityGovernance.ruleBasedSubjectSet"
            rule = "department eq 'Engineering'"
        }
        trigger = @{
            "@odata.type" = "#microsoft.graph.identityGovernance.timeBasedAttributeTrigger"
            timeBasedAttribute = "employeeHireDate"
            offsetInDays = 0  # On hire date
        }
    }
    tasks = @(
        @{
            displayName = "Generate TAP"
            taskDefinitionId = "1b555e50-7f65-41d5-b514-5894a026d10d"
            isEnabled = $true
            arguments = @(
                @{ name = "tapLifetimeMinutes"; value = "480" }
                @{ name = "tapIsUsableOnce"; value = "true" }
            )
        },
        @{
            displayName = "Add to Engineering group"
            taskDefinitionId = "22085229-5809-45e8-97fd-270d28d66910"
            isEnabled = $true
            arguments = @(
                @{ name = "groupID"; value = "engineering-group-id" }
            )
        },
        @{
            displayName = "Enable user account"
            taskDefinitionId = "6fc52c9d-398b-4305-9763-15f42c1676fc"
            isEnabled = $true
        },
        @{
            displayName = "Send welcome email"
            taskDefinitionId = "70b29d51-b59a-4773-9280-8841dfd3f2ea"
            isEnabled = $true
        }
    )
}

New-MgIdentityGovernanceLifecycleWorkflow -BodyParameter $joinerWorkflow
```

### Leaver workflow

```powershell
# Create a Leaver workflow (equivalent to Okta's offboarding automation)
$leaverWorkflow = @{
    displayName = "Employee Offboarding"
    description = "Automated offboarding when employees leave"
    isEnabled = $true
    isSchedulingEnabled = $true
    executionConditions = @{
        "@odata.type" = "#microsoft.graph.identityGovernance.triggerAndScopeBasedConditions"
        scope = @{
            "@odata.type" = "#microsoft.graph.identityGovernance.ruleBasedSubjectSet"
            rule = "department ne null"
        }
        trigger = @{
            "@odata.type" = "#microsoft.graph.identityGovernance.timeBasedAttributeTrigger"
            timeBasedAttribute = "employeeLeaveDateTime"
            offsetInDays = 0  # On leave date
        }
    }
    tasks = @(
        @{
            displayName = "Disable user account"
            taskDefinitionId = "1dfdfcc7-52fa-4c2e-bf3a-e3919cc12950"
            isEnabled = $true
        },
        @{
            displayName = "Remove from all groups"
            taskDefinitionId = "b3a31406-2a15-4c9a-b25b-a658fa5f07fc"
            isEnabled = $true
        },
        @{
            displayName = "Revoke all sign-in sessions"
            taskDefinitionId = "8a0b7d16-3e0f-4e82-b6d0-c5bfb41e5b6b"
            isEnabled = $true
        },
        @{
            displayName = "Remove access to all applications"
            taskDefinitionId = "4a0b64f2-c7ec-46ba-b117-18f262946c50"
            isEnabled = $true
        }
    )
}

New-MgIdentityGovernanceLifecycleWorkflow -BodyParameter $leaverWorkflow
```

---

## 8. Provisioning monitoring and troubleshooting

```powershell
# Check provisioning status for an application
$sp = Get-MgServicePrincipal -Filter "displayName eq 'Salesforce'"
$provStatus = Get-MgServicePrincipalSynchronizationJob -ServicePrincipalId $sp.Id

$provStatus | ForEach-Object {
    Write-Host "Job ID: $($_.Id)"
    Write-Host "Status: $($_.Status.Code)"
    Write-Host "Last execution: $($_.Status.LastExecution.ActivityIdentifier)"
    Write-Host "Last successful: $($_.Status.LastSuccessfulExecution.TimeBegan)"
    Write-Host "Quarantine status: $($_.Status.QuarantineStatus.CurrentBegan)"
}

# View provisioning logs
$provLogs = Get-MgAuditLogProvisioning -Filter "servicePrincipal/id eq '$($sp.Id)'" -Top 50

$provLogs | ForEach-Object {
    Write-Host "$($_.ActivityDateTime): $($_.Action) - $($_.ProvisioningStatusInfo.Status) - $($_.TargetIdentity.DisplayName)"
}
```

### Common provisioning issues

| Issue                      | Cause                                               | Resolution                                                                       |
| -------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------- |
| Provisioning in quarantine | Authentication failure to target app                | Verify SCIM credentials; re-authorize if using OAuth                             |
| Attribute mapping error    | Expression syntax error or missing source attribute | Review attribute mapping expressions; test with provision-on-demand              |
| Duplicate user             | Matching rule not finding existing user             | Verify matching attribute (email, employeeId) exists in target                   |
| Group not provisioning     | Group not assigned to application                   | Assign group to enterprise application; set scope to "assigned users and groups" |
| Slow initial cycle         | Large user count (10,000+)                          | Initial cycles can take hours; incremental cycles are faster (40-min intervals)  |

---

## Key Microsoft Learn references

- [Entra ID provisioning service](https://learn.microsoft.com/entra/identity/app-provisioning/user-provisioning)
- [Attribute mapping expressions](https://learn.microsoft.com/entra/identity/app-provisioning/functions-for-customizing-application-data)
- [Workday inbound provisioning](https://learn.microsoft.com/entra/identity/saas-apps/workday-inbound-tutorial)
- [SuccessFactors inbound provisioning](https://learn.microsoft.com/entra/identity/saas-apps/sap-successfactors-inbound-provisioning-tutorial)
- [Lifecycle Workflows](https://learn.microsoft.com/entra/id-governance/what-are-lifecycle-workflows)
- [Provision on demand](https://learn.microsoft.com/entra/identity/app-provisioning/provision-on-demand)

---

**Maintainers:** csa-inabox core team
**Last updated:** 2026-04-30
