# Security Migration Guide: Permissions, Identity, and Governance

**Status:** Authored 2026-04-30
**Audience:** Security administrators, identity architects, and compliance officers managing permission migration from SharePoint Server to SharePoint Online with Purview governance integration.
**Scope:** Permission migration, AD to Entra ID group mapping, sharing policies, sensitivity labels, Purview DLP for SPO, and external sharing governance.

---

## 1. Security migration overview

SharePoint security migration is more than copying permission assignments. It requires mapping on-premises Active Directory identities to Entra ID (Azure AD), translating SharePoint permission models, configuring sharing policies, and deploying information protection through Microsoft Purview. CSA-in-a-Box integrates Purview governance to ensure migrated content is properly classified and protected.

### Security migration sequence

1. **Identity synchronization** -- Entra Connect syncs AD users and groups to Entra ID
2. **Group mapping** -- Map on-premises AD security groups and SharePoint groups to Entra ID groups
3. **Permission migration** -- SPMT migrates permissions during content migration
4. **Sharing policy configuration** -- Configure SPO tenant and site-level sharing policies
5. **Sensitivity labels** -- Deploy Purview sensitivity labels for content classification
6. **DLP policies** -- Configure data loss prevention for SPO content
7. **Conditional access** -- Entra ID conditional access policies for SPO access

---

## 2. Identity synchronization with Entra Connect

### Prerequisites

Entra Connect (formerly Azure AD Connect) must be configured to synchronize on-premises AD users and groups to Entra ID before migration begins.

```powershell
# Verify Entra Connect sync status
Get-ADSyncScheduler

# Force a delta sync
Start-ADSyncSyncCycle -PolicyType Delta

# Verify synced users
Connect-MgGraph -Scopes "User.Read.All"
Get-MgUser -Filter "onPremisesSyncEnabled eq true" -CountVariable count -ConsistencyLevel eventual
Write-Host "Synced users: $count"
```

### User mapping for SPMT

Create a user mapping CSV for accounts that have different UPNs between on-premises and Entra ID:

```csv
Source,Target
CONTOSO\jsmith,john.smith@contoso.com
CONTOSO\jdoe,jane.doe@contoso.com
CONTOSO\svc-sharepoint,svc-sharepoint@contoso.com
i:0#.w|contoso\jsmith,i:0#.f|membership|john.smith@contoso.com
```

```powershell
# Generate user mapping from AD and Entra ID
$adUsers = Get-ADUser -Filter * -Properties EmailAddress, UserPrincipalName, SamAccountName |
    Where-Object { $_.Enabled }

$entraUsers = Get-MgUser -All | Select-Object UserPrincipalName, OnPremisesSecurityIdentifier

$mapping = foreach ($adUser in $adUsers) {
    $entraMatch = $entraUsers | Where-Object {
        $_.OnPremisesSecurityIdentifier -eq $adUser.SID.Value
    }
    if ($entraMatch) {
        [PSCustomObject]@{
            Source = "CONTOSO\$($adUser.SamAccountName)"
            Target = $entraMatch.UserPrincipalName
        }
    }
}

$mapping | Export-Csv -Path "C:\Migration\user-mapping.csv" -NoTypeInformation
```

---

## 3. Group mapping: AD to Entra ID

### Security group types in SPO

| On-premises group type             | SPO equivalent                        | Notes                                            |
| ---------------------------------- | ------------------------------------- | ------------------------------------------------ |
| AD Security Group (domain local)   | Entra ID Security Group               | Synced via Entra Connect                         |
| AD Security Group (global)         | Entra ID Security Group               | Synced via Entra Connect                         |
| AD Security Group (universal)      | Entra ID Security Group               | Synced via Entra Connect                         |
| AD Distribution Group              | M365 Group or Entra Security Group    | Distribution groups can be mail-enabled in Entra |
| SharePoint Group                   | SharePoint Group                      | Local to site collection; migrated with site     |
| SharePoint Group (with AD members) | SharePoint Group (with Entra members) | Members mapped via Entra Connect sync            |

### Entra ID group types for SPO

| Entra group type                | Use case                                             | SPO integration                                                              |
| ------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------- |
| **M365 Group**                  | Teams, SPO team sites, shared mailbox                | Automatic SPO team site creation; recommended for new sites                  |
| **Security Group**              | Permission assignment without collaboration features | Traditional permission assignment; recommended for permission-only scenarios |
| **Mail-enabled Security Group** | Permission + email distribution                      | Can receive email and be assigned permissions                                |
| **Dynamic Group**               | Membership based on user attributes                  | Automatic membership; useful for department/location-based permissions       |

### Group inventory and mapping

```powershell
# Export on-premises groups used in SharePoint
Add-PSSnapin Microsoft.SharePoint.PowerShell

$groupUsage = @()

Get-SPSite -Limit All | ForEach-Object {
    $site = $_
    $_.RootWeb.SiteGroups | ForEach-Object {
        $group = $_
        $groupUsage += [PSCustomObject]@{
            SiteUrl    = $site.Url
            GroupName  = $group.Name
            MemberCount = $group.Users.Count
            Members    = ($group.Users | Select-Object -First 5 -ExpandProperty LoginName) -join "; "
            Roles      = ($_.Roles | Select-Object -ExpandProperty Name) -join "; "
        }
    }
}

$groupUsage | Export-Csv -Path "C:\Migration\group-inventory.csv" -NoTypeInformation
```

---

## 4. Permission migration during content migration

### What SPMT migrates

| Permission element                    | Migrated by SPMT        | Notes                                         |
| ------------------------------------- | ----------------------- | --------------------------------------------- |
| Site collection administrators        | Yes (with user mapping) | Mapped to Entra ID users                      |
| Site owners/members/visitors          | Yes                     | SharePoint groups migrated with membership    |
| Custom permission levels              | Yes                     | Custom levels recreated in target             |
| Broken inheritance on lists/libraries | Yes                     | Unique permissions preserved                  |
| Broken inheritance on items/folders   | Yes                     | Item-level permissions preserved              |
| AD security group membership          | Via Entra Connect       | Groups must be synced before migration        |
| Claims-based permissions              | Partial                 | Windows claims mapped; custom claims may fail |
| Anonymous access                      | Not migrated            | Must be reconfigured in SPO sharing settings  |
| External user access                  | Not migrated            | Must be configured via SPO sharing policies   |

### Permission validation post-migration

```powershell
Connect-PnPOnline -Url "https://contoso.sharepoint.com/sites/finance" -Interactive

# Check site-level permissions
Get-PnPSiteGroup | ForEach-Object {
    $group = $_
    [PSCustomObject]@{
        Group   = $group.Title
        Roles   = ($group.Roles | Select-Object -ExpandProperty Name) -join "; "
        Members = ($group.Users | Select-Object -ExpandProperty Email) -join "; "
    }
} | Format-Table -AutoSize

# Check for items with unique permissions
Get-PnPList | ForEach-Object {
    $list = $_
    $items = Get-PnPListItem -List $_ -PageSize 500 |
        Where-Object { $_.HasUniqueRoleAssignments }
    if ($items.Count -gt 0) {
        Write-Host "List: $($list.Title) - Items with unique permissions: $($items.Count)"
    }
}

# Check site collection administrators
Get-PnPSiteCollectionAdmin | Select-Object Title, Email | Format-Table -AutoSize
```

---

## 5. SPO sharing policies

### Tenant-level sharing configuration

```powershell
Connect-SPOService -Url "https://contoso-admin.sharepoint.com"

# Set tenant-level sharing policy
Set-SPOTenant `
    -SharingCapability ExternalUserAndGuestSharing `  # Options: Disabled, ExistingExternalUserSharingOnly, ExternalUserSharingOnly, ExternalUserAndGuestSharing
    -DefaultSharingLinkType Internal `                 # Default sharing link = organization
    -FileAnonymousLinkType View `                      # Anonymous links = view only
    -FolderAnonymousLinkType View `
    -RequireAcceptingAccountMatchInvitedAccount $true ` # External users must use invited email
    -PreventExternalUsersFromResharing $true `          # External users cannot reshare
    -DefaultLinkPermission View `                       # Default permission = view
    -RequireAnonymousLinksExpireInDays 30 `             # Anonymous links expire in 30 days
    -EmailAttestationRequired $true `                   # Require email verification for external
    -EmailAttestationReAuthDays 30                      # Re-verify every 30 days
```

### Site-level sharing restrictions

```powershell
# Restrict sharing for sensitive sites
Set-SPOSite -Identity "https://contoso.sharepoint.com/sites/legal" `
    -SharingCapability Disabled  # No external sharing for legal site

Set-SPOSite -Identity "https://contoso.sharepoint.com/sites/marketing" `
    -SharingCapability ExternalUserSharingOnly  # Named external users only

# Restrict sharing to specific security groups
Set-SPOSite -Identity "https://contoso.sharepoint.com/sites/finance" `
    -SharingAllowedDomainList "partner.com,vendor.com" `
    -SharingDomainRestrictionMode AllowList
```

---

## 6. Sensitivity labels with Microsoft Purview

### CSA-in-a-Box Purview integration

CSA-in-a-Box deploys Microsoft Purview for enterprise-wide governance. Sensitivity labels applied to SPO content protect documents across the M365 ecosystem -- in Teams, OneDrive, email, and Copilot responses.

### Create sensitivity labels for SPO content

```powershell
Connect-IPPSSession

# Create sensitivity labels
New-Label -DisplayName "Public" `
    -Name "Public" `
    -Tooltip "Content approved for public distribution" `
    -Comment "No restrictions" `
    -ContentType "File, Email"

New-Label -DisplayName "Internal" `
    -Name "Internal" `
    -Tooltip "Content for internal use only" `
    -Comment "Do not share externally" `
    -ContentType "File, Email"

New-Label -DisplayName "Confidential" `
    -Name "Confidential" `
    -Tooltip "Sensitive business content" `
    -Comment "Restricted distribution" `
    -ContentType "File, Email" `
    -EncryptionEnabled $true `
    -EncryptionProtectionType Template `
    -EncryptionRightsDefinitions "admin@contoso.com:VIEW,VIEWRIGHTSDATA,DOCEDIT,EDIT,PRINT,EXTRACT,REPLY,REPLYALL,FORWARD,OBJMODEL"

New-Label -DisplayName "Highly Confidential" `
    -Name "HighlyConfidential" `
    -Tooltip "Top-secret business content" `
    -Comment "Executive access only" `
    -ContentType "File, Email" `
    -EncryptionEnabled $true `
    -EncryptionProtectionType Template `
    -EncryptionRightsDefinitions "executives@contoso.com:VIEW,VIEWRIGHTSDATA"

# Publish labels to users
New-LabelPolicy -Name "Corporate Labels" `
    -Labels "Public","Internal","Confidential","HighlyConfidential" `
    -ExchangeLocation All `
    -SharePointLocation All `
    -OneDriveLocation All `
    -Settings @{
        "mandatory"    = "true"
        "defaultlabel" = "Internal"
    }
```

### Auto-labeling for migrated content

```powershell
# Create auto-labeling policy for SSN detection
New-AutoSensitivityLabelPolicy -Name "Auto-Label SSN" `
    -SharePointLocation All `
    -OneDriveLocation All `
    -ApplySensitivityLabel "Confidential" `
    -Mode TestWithNotifications  # Start in simulation mode

New-AutoSensitivityLabelRule -Policy "Auto-Label SSN" `
    -Name "SSN Detection" `
    -ContentContainsSensitiveInformation @{
        Name = "U.S. Social Security Number (SSN)"
        MinCount = 1
        MaxCount = -1
        MinConfidence = 85
    }
```

---

## 7. Data Loss Prevention (DLP) for SPO

### DLP policy for migrated content

```powershell
Connect-IPPSSession

# Create DLP policy for SharePoint Online
New-DlpCompliancePolicy -Name "SPO Sensitive Content Protection" `
    -SharePointLocation All `
    -OneDriveLocation All `
    -Mode Enable

# Add rule for credit card detection
New-DlpComplianceRule -Policy "SPO Sensitive Content Protection" `
    -Name "Block Credit Card Sharing" `
    -ContentContainsSensitiveInformation @{
        Name = "Credit Card Number"
        MinCount = 1
        MinConfidence = 85
    } `
    -BlockAccess $true `
    -BlockAccessScope All `
    -NotifyUser "SiteAdmin" `
    -NotifyUserType "NotifyUser" `
    -GenerateAlert SiteAdmin

# Add rule for PII detection (warn but do not block)
New-DlpComplianceRule -Policy "SPO Sensitive Content Protection" `
    -Name "Warn on PII Sharing" `
    -ContentContainsSensitiveInformation @{
        Name = "U.S. Social Security Number (SSN)"
        MinCount = 1
        MinConfidence = 75
    } `
    -NotifyUser "SiteAdmin,LastModifier" `
    -GenerateIncidentReport SiteAdmin
```

---

## 8. Conditional Access for SPO

### Entra ID Conditional Access policies

```powershell
# Conditional Access policies are configured in Entra ID (Azure AD)
# These examples use Microsoft Graph PowerShell

Connect-MgGraph -Scopes "Policy.ReadWrite.ConditionalAccess"

# Require MFA for SPO access from unmanaged devices
$conditions = @{
    Applications = @{
        IncludeApplications = @("00000003-0000-0ff1-ce00-000000000000")  # SharePoint Online
    }
    Users = @{
        IncludeUsers = @("All")
        ExcludeGroups = @("{service-accounts-group-id}")
    }
    ClientAppTypes = @("browser", "mobileAppsAndDesktopClients")
    Devices = @{
        DeviceFilter = @{
            Mode = "include"
            Rule = 'device.isCompliant -ne True'
        }
    }
}

$grantControls = @{
    BuiltInControls = @("mfa")
    Operator = "OR"
}

# Block download from unmanaged devices
$sessionControls = @{
    ApplicationEnforcedRestrictions = @{
        IsEnabled = $true
    }
}
```

### SPO access control for unmanaged devices

```powershell
Connect-SPOService -Url "https://contoso-admin.sharepoint.com"

# Block download from unmanaged devices
Set-SPOTenant -ConditionalAccessPolicy AllowLimitedAccess

# Apply to specific sites
Set-SPOSite -Identity "https://contoso.sharepoint.com/sites/confidential" `
    -ConditionalAccessPolicy AllowLimitedAccess
```

---

## 9. External sharing governance

### External sharing decision framework

| Content sensitivity  | Sharing policy                            | Implementation                                     |
| -------------------- | ----------------------------------------- | -------------------------------------------------- |
| Public content       | Allow anyone links (with expiration)      | `SharingCapability = ExternalUserAndGuestSharing`  |
| Internal content     | Named external users only (with approval) | `SharingCapability = ExternalUserSharingOnly`      |
| Confidential content | No external sharing                       | `SharingCapability = Disabled` + sensitivity label |
| Highly confidential  | No external sharing + encryption          | `SharingCapability = Disabled` + encrypted label   |

### External sharing audit

```powershell
# Audit external sharing activity
$startDate = (Get-Date).AddDays(-30)
$endDate = Get-Date

Search-UnifiedAuditLog -StartDate $startDate -EndDate $endDate `
    -Operations "SharingSet","AnonymousLinkCreated","SecureLinkCreated","AddedToSecureLink" `
    -ResultSize 1000 |
    Select-Object CreationDate, UserIds, Operations,
        @{N="Detail"; E={$_.AuditData | ConvertFrom-Json | Select-Object -ExpandProperty ObjectId}} |
    Export-Csv -Path "C:\Migration\external-sharing-audit.csv" -NoTypeInformation
```

---

## 10. Copilot governance through security

Copilot for M365 respects SPO permissions. The security migration directly impacts Copilot behavior:

| Security control             | Copilot impact                                                          |
| ---------------------------- | ----------------------------------------------------------------------- |
| Permissions (who can access) | Copilot only surfaces content the user can access                       |
| Sensitivity labels           | Copilot respects label restrictions on content use                      |
| DLP policies                 | Copilot responses are subject to DLP policy enforcement                 |
| Sharing policies             | Copilot cannot surface externally shared content to internal-only users |
| Information barriers         | Copilot respects segment boundaries                                     |

!!! warning "Oversharing is amplified by Copilot"
If SharePoint permissions were overly permissive on-premises (which is common), migrating those permissions to SPO means Copilot will surface that overshared content to anyone with access. Review and tighten permissions during migration, not after Copilot deployment.

---

## References

- [SharePoint Online sharing settings](https://learn.microsoft.com/sharepoint/turn-external-sharing-on-or-off)
- [Sensitivity labels documentation](https://learn.microsoft.com/purview/sensitivity-labels)
- [DLP for SharePoint Online](https://learn.microsoft.com/purview/dlp-sharepoint-online)
- [Conditional Access for SharePoint](https://learn.microsoft.com/sharepoint/control-access-from-unmanaged-devices)
- [Entra Connect documentation](https://learn.microsoft.com/entra/identity/hybrid/connect/how-to-connect-install-roadmap)
- [Copilot data security](https://learn.microsoft.com/microsoft-365-copilot/microsoft-365-copilot-privacy)
- [Microsoft Purview documentation](https://learn.microsoft.com/purview/)

---

**Maintainers:** csa-inabox core team
**Last updated:** 2026-04-30
