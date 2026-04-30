# Identity Migration: Google Cloud Identity to Microsoft Entra ID

**Status:** Authored 2026-04-30
**Audience:** Identity architects, M365 administrators, and security engineers managing the transition from Google Cloud Identity to Microsoft Entra ID.
**Scope:** SAML SSO migration, SCIM provisioning migration, MFA migration, directory sync, Conditional Access migration, and coexistence patterns.

---

## Overview

Identity migration is the foundation of the Google Workspace to M365 transition. Every other workload --- email, Drive, collaboration --- depends on users being properly provisioned in Entra ID with correct authentication, authorization, and MFA configuration. This migration should be planned first and executed early, even before email migration begins.

**Key principle:** Entra ID becomes the primary identity provider. Google Cloud Identity becomes secondary during coexistence and is decommissioned after all workloads are migrated.

---

## Migration approaches

### Approach 1: Direct provisioning (recommended for most organizations)

Provision users directly in Entra ID (or sync from on-premises Active Directory via Entra Connect). No federation with Google.

**When to use:**

- Organizations without existing on-premises Active Directory.
- Organizations already using Entra Connect for AD sync.
- Simple migrations where all users can be provisioned before email migration starts.

**Steps:**

1. Provision all users in Entra ID with UPN matching Google Workspace email.
2. Set temporary passwords.
3. Enroll users in Microsoft Authenticator for MFA.
4. Assign M365 licenses.
5. Begin email/Drive migration.

### Approach 2: Coexistence with SAML federation

Configure SAML federation so users can authenticate to both Google Workspace and M365 during the migration period.

**When to use:**

- Large organizations (5,000+ users) requiring extended coexistence.
- Organizations with third-party apps authenticated via Google as IdP.
- Phased migrations where some departments stay on Google Workspace for months.

**Steps:**

1. Configure Entra ID as the primary IdP.
2. Configure Google Workspace as a SAML SP (service provider) in Entra ID.
3. Users authenticate via Entra ID and get SSO to both M365 and Google Workspace.
4. Migrate workloads department by department.
5. Remove Google Workspace SAML configuration after full migration.

### Approach 3: Google as interim IdP

Keep Google Cloud Identity as the primary IdP during migration. Configure M365 as a SAML SP.

**When to use:**

- Short migration windows where Google Workspace remains primary for weeks, not months.
- Organizations with heavy Google Cloud Identity integrations that cannot be migrated quickly.

**Steps:**

1. Configure M365 as SAML SP with Google Cloud Identity as IdP.
2. Begin migration.
3. Transition to Entra ID as primary IdP after workloads are migrated.
4. Re-configure all SAML integrations to point to Entra ID.

**Not recommended for most organizations** because it requires two IdP transitions instead of one.

---

## User provisioning

### Bulk user creation in Entra ID

```powershell
# Connect to Microsoft Graph
Connect-MgGraph -Scopes "User.ReadWrite.All", "Directory.ReadWrite.All"

# Create a single user
$passwordProfile = @{
    Password = "TempP@ssw0rd!"
    ForceChangePasswordNextSignIn = $true
}

New-MgUser -DisplayName "Jane Smith" `
    -UserPrincipalName "jsmith@contoso.com" `
    -MailNickname "jsmith" `
    -AccountEnabled `
    -PasswordProfile $passwordProfile `
    -UsageLocation "US"
```

### Bulk creation via CSV

```powershell
# Prepare CSV with columns: DisplayName, UserPrincipalName, MailNickname, Department, JobTitle
$users = Import-Csv "C:\migration\users.csv"

foreach ($user in $users) {
    $passwordProfile = @{
        Password = "TempP@ssw0rd!"
        ForceChangePasswordNextSignIn = $true
    }

    New-MgUser -DisplayName $user.DisplayName `
        -UserPrincipalName $user.UserPrincipalName `
        -MailNickname $user.MailNickname `
        -AccountEnabled `
        -PasswordProfile $passwordProfile `
        -UsageLocation "US" `
        -Department $user.Department `
        -JobTitle $user.JobTitle

    Write-Host "Created: $($user.UserPrincipalName)"
}
```

### Sync from on-premises Active Directory

If the organization has on-premises Active Directory, use Entra Connect to sync users:

```powershell
# Entra Connect is a separate installer
# Download from: https://www.microsoft.com/en-us/download/details.aspx?id=47594

# After installation, configure sync:
# 1. Select sync method: Password Hash Sync (recommended), Pass-through Auth, or Federation
# 2. Select OUs to sync
# 3. Configure filtering (by OU or group)
# 4. Enable password writeback if needed
# 5. Run initial sync

# Verify sync status
Get-MgOrganization | Select-Object OnPremisesSyncEnabled
```

---

## SAML SSO migration

### Inventory Google SAML integrations

Before migrating, inventory all third-party applications using Google Cloud Identity as the SAML IdP:

| Application     | SAML status   | Action                                   |
| --------------- | ------------- | ---------------------------------------- |
| Salesforce      | Google as IdP | Re-configure SAML to use Entra ID        |
| Slack           | Google as IdP | Re-configure SAML to use Entra ID        |
| Jira/Confluence | Google as IdP | Re-configure SAML to use Entra ID        |
| Custom app 1    | Google as IdP | Re-configure SAML to use Entra ID        |
| AWS Console     | Google as IdP | Re-configure SAML to use Entra ID        |
| GCP Console     | Google as IdP | Re-configure or keep if GCP still in use |

### Configure Entra ID as SAML IdP

For each third-party application:

1. **Check Entra ID gallery:** Entra ID has 3,000+ pre-integrated applications. Most common SaaS apps have gallery entries with pre-configured SAML settings.

2. **Gallery app configuration:**

```
Entra Admin Center > Enterprise applications > New application > Search gallery
```

3. **Custom SAML app (non-gallery):**

```
Entra Admin Center > Enterprise applications > New application >
Create your own application > Non-gallery application
```

4. **Configure SAML settings:**
    - **Identifier (Entity ID):** From the application's SAML configuration.
    - **Reply URL (ACS URL):** From the application's SAML configuration.
    - **Sign-on URL:** Application login URL.
    - **User attributes and claims:** Map Entra ID attributes to application requirements.

5. **Download SAML metadata** from Entra ID and upload to the application.

6. **Test SSO** with a pilot user before rolling out.

### Configure Google Workspace as SAML SP in Entra ID (coexistence)

During coexistence, configure Google Workspace to accept authentication from Entra ID:

1. In Entra Admin Center, add Google Workspace as an enterprise application.
2. Configure SAML SSO with Google Workspace's ACS URL.
3. In Google Admin Console, configure third-party SSO with Entra ID's SAML metadata.

---

## SCIM provisioning migration

### Inventory Google SCIM integrations

Google Cloud Identity may be the SCIM provisioning source for third-party applications. These must be migrated to Entra ID SCIM:

| Application | Current SCIM source   | Action                        |
| ----------- | --------------------- | ----------------------------- |
| Slack       | Google Cloud Identity | Re-configure SCIM to Entra ID |
| Salesforce  | Google Cloud Identity | Re-configure SCIM to Entra ID |
| Box         | Google Cloud Identity | Re-configure SCIM to Entra ID |
| Custom app  | Google Cloud Identity | Re-configure SCIM to Entra ID |

### Configure Entra ID SCIM provisioning

```
Entra Admin Center > Enterprise applications > [App] > Provisioning
```

1. Set provisioning mode to **Automatic**.
2. Enter the application's SCIM endpoint URL and authentication token.
3. Map Entra ID attributes to application attributes.
4. Set provisioning scope (all users or assigned users).
5. Start provisioning.

```powershell
# Verify provisioning status
Get-MgServicePrincipalSynchronizationJob -ServicePrincipalId $spId |
    Select-Object Status, LastSuccessfulExecution
```

---

## MFA migration

### Google MFA to Microsoft Authenticator

Google Workspace supports several MFA methods. Each maps to an Entra ID equivalent:

| Google MFA method               | Entra ID equivalent                        | Migration path                          |
| ------------------------------- | ------------------------------------------ | --------------------------------------- |
| **Google Authenticator (TOTP)** | Microsoft Authenticator (TOTP or push)     | Re-enroll; no data migration            |
| **Google Prompt (push)**        | Microsoft Authenticator (push)             | Re-enroll; no data migration            |
| **Security key (FIDO2)**        | FIDO2 security key in Entra ID             | Re-register same key                    |
| **SMS verification**            | SMS verification in Entra ID               | Configure phone number in Entra ID      |
| **Backup codes**                | Not directly equivalent                    | Users generate new recovery methods     |
| **Google Titan Security Key**   | FIDO2 key (Titan keys are FIDO2 compliant) | Re-register; keys are platform-agnostic |

### MFA enrollment strategy

```powershell
# Configure Entra ID MFA registration policy
# Entra Admin Center > Protection > Authentication methods

# Recommended: Require Microsoft Authenticator
# Step 1: Enable Microsoft Authenticator as authentication method
# Step 2: Create Conditional Access policy requiring MFA registration

# Example: Conditional Access policy requiring MFA for all users
# Entra Admin Center > Protection > Conditional Access > New policy
# Assignments: All users
# Conditions: None (always)
# Grant: Require multifactor authentication
```

### MFA migration timeline

| Week     | Action                                                                          | Scope              |
| -------- | ------------------------------------------------------------------------------- | ------------------ |
| Week 1-2 | Deploy Microsoft Authenticator app to all users (Intune push or company portal) | All users          |
| Week 2-3 | Enable MFA registration campaign (Entra nudge)                                  | All users          |
| Week 3-4 | Enroll pilot group in Microsoft Authenticator                                   | IT + pilot group   |
| Week 4-6 | Roll out MFA enrollment to all users by department                              | Department batches |
| Week 7   | Enforce MFA for all users via Conditional Access                                | All users          |
| Week 8+  | Disable Google MFA after confirming all users enrolled                          | After validation   |

---

## Conditional Access migration

### Google Context-Aware Access to Entra Conditional Access

Google Context-Aware Access provides basic conditional policies. Entra Conditional Access provides granular, risk-based policies:

| Google Context-Aware Access policy       | Entra Conditional Access equivalent     | Notes                                   |
| ---------------------------------------- | --------------------------------------- | --------------------------------------- |
| **Require managed device**               | Require device compliance (Intune)      | Entra CA checks Intune compliance state |
| **IP-based access (corporate network)**  | Named locations (IP ranges)             | Define trusted locations by IP          |
| **Block access from specific countries** | Named locations (country/region)        | Block sign-ins from countries           |
| **Require Chrome Enterprise**            | Require app protection policy           | Intune MAM policy for app protection    |
| **Device encryption required**           | Compliance policy (BitLocker/FileVault) | Intune compliance checks encryption     |

### Common Conditional Access policies

```
# Policy 1: Require MFA for all users
Name: "Require MFA - All Users"
Assignments: All users (exclude break-glass accounts)
Conditions: All cloud apps
Grant: Require multifactor authentication

# Policy 2: Block legacy authentication
Name: "Block Legacy Auth"
Assignments: All users
Conditions: Client apps = Exchange ActiveSync clients, Other clients
Grant: Block access

# Policy 3: Require compliant device for Office apps
Name: "Require Compliant Device"
Assignments: All users
Conditions: Office 365 apps
Grant: Require device to be marked as compliant

# Policy 4: Block access from untrusted locations
Name: "Block Untrusted Countries"
Assignments: All users
Conditions: Locations = All locations EXCEPT trusted
Grant: Block access (or require MFA)
```

---

## Directory structure migration

### Google OUs to Entra ID groups

Google Workspace uses Organizational Units (OUs) for policy assignment. Entra ID uses groups for most policy assignments (Conditional Access, Intune, licensing, etc.):

| Google OU    | Entra ID equivalent                   | Purpose                                |
| ------------ | ------------------------------------- | -------------------------------------- |
| /Executives  | Security group "Executives"           | License assignment, Conditional Access |
| /Engineering | Security group "Engineering"          | License assignment, app access         |
| /Sales       | Security group "Sales"                | License assignment, CRM access         |
| /Frontline   | Security group "Frontline Workers"    | F1/F3 license assignment               |
| /Contractors | Security group "External Contractors" | Restricted access policies             |

```powershell
# Create security groups matching Google OUs
New-MgGroup -DisplayName "Engineering" `
    -MailEnabled:$false `
    -MailNickname "engineering" `
    -SecurityEnabled `
    -Description "Engineering department - maps to Google OU /Engineering"

# Add members
New-MgGroupMember -GroupId $groupId -DirectoryObjectId $userId

# Create dynamic group (auto-membership based on attributes)
New-MgGroup -DisplayName "US Users" `
    -MailEnabled:$false `
    -MailNickname "ususers" `
    -SecurityEnabled `
    -GroupTypes "DynamicMembership" `
    -MembershipRule "(user.usageLocation -eq \"US\")" `
    -MembershipRuleProcessingState "On"
```

---

## Post-migration validation

### Identity validation checklist

- [ ] All users can sign in to Entra ID with correct credentials.
- [ ] MFA is enrolled and functional for all users.
- [ ] Conditional Access policies are enforced correctly.
- [ ] SSO to third-party apps works via Entra ID.
- [ ] SCIM provisioning creates/updates/deactivates users in third-party apps.
- [ ] License assignments are correct (E3, E5, F1, Copilot).
- [ ] Admin roles are assigned correctly (Global Admin, Exchange Admin, etc.).
- [ ] Self-service password reset (SSPR) is configured and functional.
- [ ] Entra ID Protection risk policies are active.

### Decommission Google Cloud Identity

After all workloads are migrated and validated:

1. **Wait 30 days** after last workload migration.
2. **Verify** no applications still authenticate via Google Cloud Identity.
3. **Disable** Google Cloud Identity accounts (do not delete immediately).
4. **Wait 30 additional days** to confirm no issues.
5. **Delete** Google Cloud Identity accounts.
6. **Cancel** Google Workspace licenses.

---

## Troubleshooting

| Issue                                        | Cause                               | Resolution                                                 |
| -------------------------------------------- | ----------------------------------- | ---------------------------------------------------------- |
| Users cannot sign in to Entra ID             | Account not provisioned or disabled | Verify user account in Entra Admin Center                  |
| SAML SSO to third-party app fails            | Certificate or claim mismatch       | Verify SAML configuration; check token signing certificate |
| MFA enrollment not prompting                 | Registration campaign not enabled   | Enable MFA registration policy in Entra Admin Center       |
| Conditional Access blocking legitimate users | Policy too restrictive              | Add exclusion group for troubleshooting; refine policy     |
| SCIM provisioning errors                     | Attribute mapping mismatch          | Check provisioning logs in Entra Admin Center              |
| Users prompted for MFA on every sign-in      | Trusted location not configured     | Add corporate IP ranges to named locations                 |
| Legacy apps cannot authenticate              | Legacy auth blocked by policy       | Use app passwords or modernize app authentication          |
