# Best Practices: AD to Entra ID Migration

**Operational best practices for executing the Active Directory to Microsoft Entra ID migration --- covering staged migration waves, pilot group strategy, rollback planning, application inventory methodology, GPO audit, and CSA-in-a-Box identity integration.**

---

## Overview

AD-to-Entra-ID migration is a program, not a project. It touches every user, device, application, and infrastructure component in the enterprise. The best practices in this guide are drawn from real-world federal and commercial migrations and are designed to minimize risk, maintain user productivity, and ensure a clean path to cloud-only identity.

---

## 1. Staged migration waves

### Wave design principles

1. **Start with the least dependent, most cloud-ready users** --- remote workers, SaaS-heavy teams, new hires
2. **End with the most dependent, least cloud-ready users** --- users with legacy Kerberos apps, on-prem-only workflows
3. **Each wave validates assumptions** for the next wave --- never scale to production without pilot validation
4. **Rollback capability must exist** for every wave --- if a wave fails, roll it back without impacting other waves

### Recommended wave structure

| Wave                                | Size         | Duration   | Criteria                                         | Rollback plan                |
| ----------------------------------- | ------------ | ---------- | ------------------------------------------------ | ---------------------------- |
| **Wave 0: IT/Identity Team**        | 20--50       | 2 weeks    | Identity administrators, IT staff                | Re-join domain; re-sync user |
| **Wave 1: Early Adopters**          | 100--200     | 2 weeks    | Cloud-first users, remote workers                | Re-join domain; re-sync user |
| **Wave 2: Cloud-Ready Departments** | 500--1,000   | 4 weeks    | Departments with no on-prem app dependency       | Re-join domain; re-sync user |
| **Wave 3: General Population**      | 1,000--5,000 | 6--8 weeks | Standard knowledge workers                       | Re-join domain; re-sync user |
| **Wave 4: Specialized Users**       | 500--2,000   | 4 weeks    | Developers, power users, specialized devices     | Per-user rollback            |
| **Wave 5: Legacy Holdouts**         | Remaining    | 4 weeks    | Users with on-prem app dependencies (remediated) | Hybrid join as fallback      |

### Wave exit criteria

Each wave must meet these criteria before proceeding to the next:

- [ ] 95%+ of users in the wave can sign in without issues
- [ ] SSO works for all assigned applications
- [ ] Help desk ticket volume increase < 10% over baseline
- [ ] No critical application functionality lost
- [ ] User satisfaction survey > 4.0/5.0
- [ ] All compliance controls pass validation

---

## 2. Pilot group strategy

### Pilot group composition

The pilot group must represent the diversity of your user population:

| Category               | Pilot members | Why                                                    |
| ---------------------- | ------------- | ------------------------------------------------------ |
| IT/Identity team       | 10--20        | They understand the system; can self-troubleshoot      |
| Remote workers         | 10--15        | Test no-VPN access, Conditional Access, SSO            |
| Office workers         | 5--10         | Test on-premises resource access via cloud trust       |
| Executives             | 2--3          | Test VIP experience; surface priority issues early     |
| Help desk staff        | 3--5          | They need to support the migration; must experience it |
| Application owners     | 5--10         | Validate specific application SSO and functionality    |
| Different device types | 5--10         | Laptops, desktops, tablets; different OS versions      |
| Different locations    | 5--10         | Multiple offices, remote locations, international      |

### Pilot success metrics

```powershell
# Pilot health dashboard query
# Run weekly during pilot phase

# Metric 1: Authentication success rate
$signIns = Get-MgAuditLogSignIn -Filter `
    "createdDateTime ge 2026-07-01 and createdDateTime le 2026-07-14" -All

$pilotGroupId = "pilot-group-object-id"
$pilotMembers = Get-MgGroupMember -GroupId $pilotGroupId -All |
    Select-Object -ExpandProperty Id

$pilotSignIns = $signIns | Where-Object {
    $_.UserId -in $pilotMembers
}

$successRate = ($pilotSignIns | Where-Object { $_.Status.ErrorCode -eq 0 }).Count /
    $pilotSignIns.Count * 100

Write-Host "Pilot auth success rate: $([math]::Round($successRate, 2))%"

# Metric 2: MFA registration completeness
$authMethods = Get-MgReportAuthenticationMethodUserRegistrationDetail -All |
    Where-Object { $_.Id -in $pilotMembers }

$mfaRegistered = ($authMethods | Where-Object { $_.IsMfaRegistered }).Count /
    $authMethods.Count * 100

Write-Host "MFA registration: $([math]::Round($mfaRegistered, 2))%"
```

---

## 3. Rollback planning

### Rollback levels

| Level                   | Scope                         | Trigger                                          | Action                                                         | Duration     |
| ----------------------- | ----------------------------- | ------------------------------------------------ | -------------------------------------------------------------- | ------------ |
| **Level 1: Per-user**   | Single user                   | User cannot access critical application          | Re-sync user from AD; hybrid join device                       | 30 minutes   |
| **Level 2: Per-wave**   | All users in a migration wave | > 5% of wave experiencing issues                 | Move all wave users back to sync scope; re-hybrid-join devices | 4--8 hours   |
| **Level 3: Per-domain** | Entire domain                 | Fundamental issue with Entra ID configuration    | Re-federate domain to AD FS (if still running)                 | 1--2 hours   |
| **Level 4: Full**       | Entire migration              | Critical security incident or compliance failure | Halt migration; revert to AD-primary                           | 24--48 hours |

### Rollback prerequisites

!!! warning "Keep AD FS running during migration"
Do not decommission AD FS until the last wave is completed and validated. AD FS is the Level 3 rollback path. Keep it operational (but unused) throughout the migration.

```powershell
# Rollback script: Move user back to AD sync scope
param(
    [string]$UserPrincipalName,
    [string]$OriginalOU
)

# Step 1: Move user back to synced OU in AD
$adUser = Get-ADUser -Filter "UserPrincipalName -eq '$UserPrincipalName'"
Move-ADObject -Identity $adUser.DistinguishedName -TargetPath $OriginalOU

# Step 2: Force sync cycle
# Cloud Sync: automatic within 2 minutes
# Entra Connect: Start-ADSyncSyncCycle -PolicyType Delta

# Step 3: Verify user is re-synced
Start-Sleep -Seconds 180
$mgUser = Get-MgUser -UserId $UserPrincipalName -Property OnPremisesSyncEnabled
Write-Host "Sync re-enabled: $($mgUser.OnPremisesSyncEnabled)"

# Step 4: If device was Entra-joined, re-hybrid-join
# User may need to disconnect from Entra and rejoin domain
```

---

## 4. Application inventory methodology

### Three-pass inventory approach

**Pass 1: Automated discovery (Week 1--2)**

```powershell
# Tools for automated application discovery:

# 1. AD FS relying party audit
Get-AdfsRelyingPartyTrust | Select-Object Name, Identifier, Enabled,
    TokenLifetime, IssuanceTransformRules |
    Export-Csv ".\pass1-adfs-apps.csv" -NoTypeInformation

# 2. LDAP query analysis (enable on DCs for 2 weeks)
# Event ID 2889: unsigned LDAP binds
# Event ID 1644: LDAP search operations (requires diagnostic logging)

# 3. Kerberos ticket analysis
# Event ID 4769: service ticket operations
# Collect for 2+ weeks to capture all services

# 4. Entra ID sign-in logs (for apps already using Entra)
Get-MgAuditLogSignIn -All |
    Group-Object AppDisplayName |
    Sort-Object Count -Descending |
    Select-Object Count, Name |
    Export-Csv ".\pass1-entra-apps.csv" -NoTypeInformation

# 5. Network scanning for LDAP/Kerberos traffic
# Use network monitoring tools to identify undocumented LDAP binds
```

**Pass 2: Owner validation (Week 2--3)**

- Send inventory to application owners for validation
- Confirm: application name, business criticality, auth protocol, user population
- Identify: source code availability, vendor support status, planned retirement

**Pass 3: Migration readiness assessment (Week 3--4)**

- Categorize each application (A through F, per [Application Migration](application-migration.md))
- Assign migration path and complexity rating
- Prioritize by business criticality and migration effort
- Identify applications that block device migration or user conversion

---

## 5. GPO audit before migration

### GPO rationalization

Before migrating GPOs to Intune, audit and rationalize the existing GPO estate.

```powershell
# GPO audit script
$allGPOs = Get-GPO -All

$audit = $allGPOs | ForEach-Object {
    $gpo = $_
    $report = Get-GPOReport -Guid $gpo.Id -ReportType Xml
    $xml = [xml]$report

    # Count settings
    $computerSettings = ($xml.GPO.Computer.ExtensionData | Measure-Object).Count
    $userSettings = ($xml.GPO.User.ExtensionData | Measure-Object).Count

    # Check if GPO is linked
    $links = $gpo.GpoStatus

    [PSCustomObject]@{
        Name = $gpo.DisplayName
        Id = $gpo.Id
        Status = $gpo.GpoStatus
        Created = $gpo.CreationTime
        Modified = $gpo.ModificationTime
        ComputerSettingCount = $computerSettings
        UserSettingCount = $userSettings
        DaysSinceModified = (New-TimeSpan -Start $gpo.ModificationTime -End (Get-Date)).Days
    }
}

# Identify candidates for retirement
$audit | Where-Object {
    $_.DaysSinceModified -gt 365 -or
    ($_.ComputerSettingCount -eq 0 -and $_.UserSettingCount -eq 0) -or
    $_.Status -eq "AllSettingsDisabled"
} | Format-Table Name, DaysSinceModified, Status -AutoSize

# Export full audit
$audit | Export-Csv ".\gpo-audit.csv" -NoTypeInformation
```

### GPO retirement criteria

| Criteria                      | Action                                                |
| ----------------------------- | ----------------------------------------------------- |
| Not modified in 12+ months    | Candidate for retirement --- verify with stakeholders |
| Zero settings configured      | Retire immediately                                    |
| All settings disabled         | Retire immediately                                    |
| Linked to empty OU            | Candidate for retirement                              |
| Duplicate of another GPO      | Merge and retire duplicate                            |
| Superseded by Intune baseline | Retire after Intune baseline deployed                 |

---

## 6. Communication plan

### Stakeholder communication

| Audience              | Message                                     | Timing                    | Channel                      |
| --------------------- | ------------------------------------------- | ------------------------- | ---------------------------- |
| Executive leadership  | Business case, timeline, risk mitigation    | Pre-migration             | Briefing                     |
| IT staff              | Technical plan, training schedule, roles    | 4 weeks before            | Team meeting + documentation |
| Help desk             | Support procedures, escalation paths, FAQ   | 2 weeks before each wave  | Training session             |
| End users (each wave) | What's changing, when, what they need to do | 2 weeks before their wave | Email + intranet             |
| Application owners    | App-specific migration plan and timeline    | 4 weeks before            | Direct meeting               |

### End user communication template

```markdown
Subject: Your Windows sign-in is upgrading to [Organization] cloud identity

Starting [date], your sign-in experience will be upgraded to use
[Organization]'s cloud identity service (Microsoft Entra ID). This change:

- Makes sign-in faster and more secure
- Eliminates VPN requirements for most applications
- Enables passwordless sign-in (Windows Hello)
- Protects your account with advanced threat detection

**What you need to do:**

1. Register for MFA at https://aka.ms/mfasetup (if not already done)
2. On [date], follow the instructions sent to your email
3. Contact the help desk at [number] if you experience any issues

**What stays the same:**

- Your username (email address) does not change
- Your current password works during the transition
- All your files and applications remain accessible

**Training resources:** [link to training site]
```

---

## 7. CSA-in-a-Box identity integration patterns

### Identity integration checklist

When deploying CSA-in-a-Box with Entra ID, follow these patterns:

#### Fabric workspace RBAC

```powershell
# Create Entra security groups that map to Fabric roles
$groups = @(
    @{ Name = "CSA-Fabric-Admins";        Role = "Admin" }
    @{ Name = "CSA-Fabric-Contributors";  Role = "Contributor" }
    @{ Name = "CSA-Fabric-Members";       Role = "Member" }
    @{ Name = "CSA-Fabric-Viewers";       Role = "Viewer" }
)

foreach ($group in $groups) {
    New-MgGroup -DisplayName $group.Name `
        -SecurityEnabled $true `
        -MailEnabled $false `
        -MailNickname ($group.Name.ToLower() -replace '-', '') `
        -Description "CSA-in-a-Box Fabric $($group.Role) role"
}
```

#### Databricks SCIM provisioning

```powershell
# Configure SCIM provisioning from Entra ID to Databricks
# 1. Register Databricks enterprise application in Entra
# 2. Configure provisioning with Databricks SCIM API endpoint
# 3. Map Entra groups to Databricks groups

# Verify SCIM sync status
$provisioningLogs = Get-MgAuditLogProvisioning -Filter `
    "servicePrincipal/displayName eq 'Azure Databricks'" -Top 20

$provisioningLogs | Select-Object ActivityDateTime, Action,
    @{N="Status"; E={$_.StatusInfo.Status}},
    @{N="User"; E={$_.SourceIdentity.DisplayName}} |
    Format-Table -AutoSize
```

#### Purview data access policies

```powershell
# Bind Purview roles to Entra security groups
# Purview portal > Data map > Collections > Role assignments

# Recommended role structure:
# Collection: CSA-Platform
#   Data Source Admins:   CSA-Purview-Admins (Entra group)
#   Data Curators:        CSA-Purview-DataStewards (Entra group)
#   Data Readers:         CSA-Purview-DataConsumers (Entra group)
#   Data Share Contributors: CSA-Purview-DataSharers (Entra group)
```

#### Managed identity for services

```bicep
// CSA-in-a-Box Bicep: Managed identity pattern
// No service account passwords; no credential rotation

resource csaIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'umi-csa-platform'
  location: location
}

// Assign to ADLS Gen2 for data access
resource storageRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storageAccount.id, csaIdentity.id, storageBlobDataContributorRole)
  scope: storageAccount
  properties: {
    roleDefinitionId: storageBlobDataContributorRole
    principalId: csaIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

// Assign to Key Vault for secrets
resource kvRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, csaIdentity.id, keyVaultSecretsUserRole)
  scope: keyVault
  properties: {
    roleDefinitionId: keyVaultSecretsUserRole
    principalId: csaIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}
```

---

## 8. Monitoring and health checks

### Ongoing migration health dashboard

```powershell
# Weekly migration health report
function Get-MigrationHealth {
    $report = @{}

    # Sync health
    $syncErrors = (Get-MgAuditLogProvisioning -Filter `
        "statusInfo/status eq 'failure' and activityDateTime ge $(
            (Get-Date).AddDays(-7).ToString('yyyy-MM-ddTHH:mm:ssZ')
        )" -All).Count
    $report["SyncErrors7Days"] = $syncErrors

    # Authentication health
    $authFailures = (Get-MgAuditLogSignIn -Filter `
        "status/errorCode ne 0 and createdDateTime ge $(
            (Get-Date).AddDays(-7).ToString('yyyy-MM-ddTHH:mm:ssZ')
        )" -All).Count
    $report["AuthFailures7Days"] = $authFailures

    # MFA registration
    $mfaStats = Get-MgReportAuthenticationMethodUserRegistrationDetail -All
    $report["MFARegistered"] = ($mfaStats | Where-Object { $_.IsMfaRegistered }).Count
    $report["MFANotRegistered"] = ($mfaStats | Where-Object { -not $_.IsMfaRegistered }).Count
    $report["PasswordlessCapable"] = ($mfaStats |
        Where-Object { $_.IsPasswordlessCapable }).Count

    # Device migration
    $devices = Get-MgDevice -All -Property TrustType
    $report["EntraJoined"] = ($devices | Where-Object { $_.TrustType -eq "AzureAd" }).Count
    $report["HybridJoined"] = ($devices |
        Where-Object { $_.TrustType -eq "ServerAd" }).Count
    $report["Registered"] = ($devices |
        Where-Object { $_.TrustType -eq "Workplace" }).Count

    return $report
}

$health = Get-MigrationHealth
$health | Format-Table @{N="Metric"; E={$_.Key}}, @{N="Value"; E={$_.Value}}
```

---

## 9. Post-migration governance

### Ongoing identity governance tasks

| Task                               | Frequency | Owner         | Tool                          |
| ---------------------------------- | --------- | ------------- | ----------------------------- |
| Access reviews for admin roles     | Monthly   | CISO          | Entra ID Access Reviews       |
| Access reviews for platform groups | Quarterly | Data Stewards | Entra ID Access Reviews       |
| Conditional Access policy review   | Quarterly | Identity Team | Entra admin center            |
| Orphaned account cleanup           | Monthly   | Identity Team | Entra ID Lifecycle Workflows  |
| Service principal audit            | Quarterly | Security Team | Graph API report              |
| Sign-in risk trend analysis        | Weekly    | SOC           | Identity Protection dashboard |
| MFA registration audit             | Monthly   | Identity Team | Authentication methods report |
| License utilization review         | Quarterly | IT Finance    | M365 admin center             |

---

## 10. Lessons learned from real migrations

### What works

1. **Start with Cloud Sync, not Entra Connect** --- simpler, more resilient, Microsoft-recommended
2. **Migrate AD FS apps first** --- highest ROI; immediate infrastructure savings
3. **Use Autopilot for device migration** --- cleaner than in-place domain unjoin
4. **Deploy Conditional Access in report-only mode first** --- find problems before enforcement
5. **Invest in application inventory** --- the most underestimated effort in every migration
6. **Communicate early and often** --- user resistance drops with clear, honest communication

### What fails

1. **Big-bang migration** --- never works; always use waves
2. **Skipping the pilot** --- issues found at scale are 10x more expensive to fix
3. **Underestimating GPO complexity** --- 500+ GPOs require a dedicated workstream
4. **Ignoring service accounts** --- they are the last blocker and always take longer than expected
5. **Decommissioning AD FS too early** --- keep it as rollback until the last wave completes
6. **Not testing rollback** --- if you haven't tested rollback, you don't have rollback

---

**Maintainers:** csa-inabox core team
**Last updated:** 2026-04-30
