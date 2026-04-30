# Tutorial: Deploy Entra Cloud Sync

**Step-by-step tutorial for deploying Microsoft Entra Cloud Sync as the hybrid identity bridge between on-premises Active Directory and Microsoft Entra ID.**

**Duration:** 2--3 hours
**Prerequisites:** On-premises AD forest, Entra ID tenant (P1 or P2), domain-joined server for agent installation, Global Administrator credentials

---

## What you will accomplish

By the end of this tutorial, you will have:

1. Deployed an Entra Cloud Sync agent on a domain-joined server
2. Configured attribute mapping between AD and Entra ID
3. Enabled password hash synchronization
4. Validated sync for a pilot OU
5. Configured Source of Authority switching for a pilot group

---

## Step 1: Prepare the environment

### 1.1 Verify prerequisites

```powershell
# Run on the server designated for the Cloud Sync agent

# Check Windows version (Server 2016+ required)
[System.Environment]::OSVersion.Version

# Check .NET Framework version (4.7.2+ required)
(Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full").Release
# 461808 = .NET 4.7.2; 528040 = .NET 4.8

# Verify domain join
(Get-WmiObject Win32_ComputerSystem).Domain

# Verify connectivity to Entra ID endpoints
$endpoints = @(
    "login.microsoftonline.com",
    "provisioning.microsoftonline.com",
    "aadconnectapi.msappproxy.net",
    "msappproxy.net",
    "servicebus.windows.net"
)

foreach ($endpoint in $endpoints) {
    $result = Test-NetConnection -ComputerName $endpoint -Port 443
    Write-Host "$endpoint : $($result.TcpTestSucceeded)" -ForegroundColor $(
        if ($result.TcpTestSucceeded) { "Green" } else { "Red" }
    )
}
```

### 1.2 Create a pilot OU

```powershell
# Create a pilot OU for testing Cloud Sync
# Run on a domain controller or machine with RSAT
New-ADOrganizationalUnit -Name "CloudSync-Pilot" `
    -Path "OU=Users,DC=contoso,DC=com" `
    -Description "Users for Cloud Sync pilot testing"

# Move 10-20 test users to the pilot OU
$pilotUsers = @("testuser1", "testuser2", "testuser3")
foreach ($user in $pilotUsers) {
    Get-ADUser -Identity $user |
        Move-ADObject -TargetPath "OU=CloudSync-Pilot,OU=Users,DC=contoso,DC=com"
}

# Verify users are in the pilot OU
Get-ADUser -SearchBase "OU=CloudSync-Pilot,OU=Users,DC=contoso,DC=com" -Filter * |
    Select-Object SamAccountName, UserPrincipalName, DistinguishedName
```

### 1.3 Verify UPN suffixes

```powershell
# Ensure UPN suffixes match your verified domain in Entra ID
$forest = [System.DirectoryServices.ActiveDirectory.Forest]::GetCurrentForest()
$forest.Domains | ForEach-Object {
    $domain = $_
    $domain.Name
}

# Add custom UPN suffix if needed
# Active Directory Domains and Trusts > Properties > UPN Suffixes
# Or via PowerShell:
Set-ADForest -Identity (Get-ADForest) `
    -UPNSuffixes @{Add="contoso.com"}

# Verify all pilot users have the correct UPN suffix
Get-ADUser -SearchBase "OU=CloudSync-Pilot,OU=Users,DC=contoso,DC=com" -Filter * `
    -Properties UserPrincipalName |
    Select-Object SamAccountName, UserPrincipalName
```

---

## Step 2: Install the Cloud Sync agent

### 2.1 Download the agent

1. Sign in to the **Entra admin center** (https://entra.microsoft.com)
2. Navigate to **Identity** > **Hybrid management** > **Entra Connect** > **Cloud Sync**
3. Click **Download agent**
4. Copy the installer to the target server

### 2.2 Install the agent

```powershell
# Run the installer (interactive or silent)
# Interactive:
.\AADConnectProvisioningAgentSetup.exe

# Silent installation:
.\AADConnectProvisioningAgentSetup.exe /quiet

# During installation, you will be prompted to:
# 1. Accept the license agreement
# 2. Sign in with Global Administrator or Hybrid Identity Administrator credentials
# 3. Sign in with AD Domain Administrator credentials (or use gMSA)
```

### 2.3 Verify agent installation

```powershell
# Verify the agent service is running
Get-Service "AADConnectProvisioningAgent" | Select-Object Status, StartType

# Output should show:
# Status    StartType
# ------    ---------
# Running   Automatic

# Verify agent registration in Entra admin center
# Entra admin center > Identity > Hybrid management > Entra Connect > Cloud Sync
# The agent should appear with status "Active"

# Check agent logs
Get-WinEvent -LogName "AAD Connect Provisioning Agent" -MaxEvents 20 |
    Format-Table TimeCreated, Message -AutoSize
```

### 2.4 Install a second agent for HA (recommended)

```powershell
# Install on a DIFFERENT domain-joined server for high availability
# Same installation process as above
# Both agents will appear in the Entra admin center
# Cloud Sync automatically distributes load and fails over between agents
```

---

## Step 3: Configure Cloud Sync

### 3.1 Create a new configuration

1. In the **Entra admin center**, navigate to **Cloud Sync**
2. Click **New configuration**
3. Select the domain: `contoso.com`
4. Set the scope:
    - **All users and groups** (for full sync later)
    - Or **Selected OUs** (for pilot --- recommended)

### 3.2 Configure scoping filter for pilot

```
# In the Cloud Sync configuration:
# Scoping filters > Add filter

# Filter 1: Scope to pilot OU
Attribute: dn
Operator: CONTAINS
Value: OU=CloudSync-Pilot
```

### 3.3 Configure attribute mapping

Default attribute mappings cover most scenarios. Review and customize if needed:

| AD attribute               | Entra ID attribute    | Default mapping | Customization                             |
| -------------------------- | --------------------- | --------------- | ----------------------------------------- |
| userPrincipalName          | userPrincipalName     | Direct          | Verify UPN suffix matches verified domain |
| mail                       | mail                  | Direct          | None needed                               |
| displayName                | displayName           | Direct          | None needed                               |
| givenName                  | givenName             | Direct          | None needed                               |
| sn                         | surname               | Direct          | None needed                               |
| department                 | department            | Direct          | None needed                               |
| title                      | jobTitle              | Direct          | None needed                               |
| telephoneNumber            | businessPhones        | Direct          | None needed                               |
| physicalDeliveryOfficeName | officeLocation        | Direct          | None needed                               |
| objectGUID                 | onPremisesImmutableId | Base64 encoded  | Do not modify                             |

### 3.4 Enable password hash synchronization

Password hash sync is enabled by default in Cloud Sync. Verify:

1. In the Cloud Sync configuration, check **Password hash synchronization**
2. Ensure it shows **Enabled**

```powershell
# Verify PHS is working after initial sync
# Check Entra audit logs for password sync events
Get-MgAuditLogDirectoryAudit -Filter "activityDisplayName eq 'Change user password'" `
    -Top 10 |
    Select-Object ActivityDisplayName, ActivityDateTime, InitiatedBy, Result
```

---

## Step 4: Run initial sync

### 4.1 Enable the configuration

1. In the Cloud Sync configuration, click **Enable**
2. The initial sync will begin within 2 minutes

### 4.2 Monitor sync progress

```powershell
# Check provisioning logs in Entra admin center
# Entra admin center > Identity > Hybrid management > Cloud Sync > Provisioning logs

# Or via Graph API:
$provLogs = Get-MgAuditLogProvisioning -Top 50 |
    Where-Object { $_.ServicePrincipal.DisplayName -eq "Azure AD Cloud Sync" }

$provLogs | Select-Object ActivityDateTime, Action,
    @{N="Source"; E={$_.SourceIdentity.DisplayName}},
    @{N="Target"; E={$_.TargetIdentity.DisplayName}},
    StatusInfo | Format-Table -AutoSize
```

### 4.3 Validate synced users

```powershell
# Verify pilot users appear in Entra ID
$pilotUsers = @("testuser1@contoso.com", "testuser2@contoso.com", "testuser3@contoso.com")

foreach ($upn in $pilotUsers) {
    $user = Get-MgUser -UserId $upn -Property `
        DisplayName, OnPremisesSyncEnabled, OnPremisesImmutableId,
        OnPremisesLastSyncDateTime -ErrorAction SilentlyContinue

    if ($user) {
        [PSCustomObject]@{
            UPN = $upn
            DisplayName = $user.DisplayName
            Synced = $user.OnPremisesSyncEnabled
            ImmutableId = if ($user.OnPremisesImmutableId) { "Set" } else { "Missing" }
            LastSync = $user.OnPremisesLastSyncDateTime
        }
    } else {
        [PSCustomObject]@{
            UPN = $upn
            DisplayName = "NOT FOUND"
            Synced = $false
            ImmutableId = "N/A"
            LastSync = $null
        }
    }
} | Format-Table -AutoSize
```

---

## Step 5: Test authentication

### 5.1 Test password authentication

```powershell
# Test sign-in for a pilot user
# Use a browser InPrivate/Incognito session:
# 1. Navigate to https://myapps.microsoft.com
# 2. Sign in with the pilot user's UPN and on-prem AD password
# 3. Verify successful sign-in
# 4. Check the sign-in logs for the authentication method

# Verify in sign-in logs:
$signIn = Get-MgAuditLogSignIn -Filter `
    "userPrincipalName eq 'testuser1@contoso.com'" -Top 1

$signIn | Select-Object UserPrincipalName, AppDisplayName,
    @{N="AuthMethod"; E={$_.AuthenticationDetails[0].AuthenticationMethod}},
    Status, ConditionalAccessStatus
```

### 5.2 Test password sync latency

```powershell
# Change password on-premises
Set-ADAccountPassword -Identity "testuser1" `
    -NewPassword (ConvertTo-SecureString "NewP@ssw0rd!2026" -AsPlainText -Force) `
    -Reset

$startTime = Get-Date
Write-Host "Password changed at: $startTime"
Write-Host "Waiting for sync (typically < 2 minutes)..."

# Poll until the new password works in Entra ID
# (Manual test: try signing in with new password every 30 seconds)
```

---

## Step 6: Configure Source of Authority switching for pilot

### 6.1 Understand SOA switching

Source of Authority switching allows you to manage selected user attributes in the cloud instead of on-premises. This is a prerequisite for eventual cloud-only migration.

### 6.2 Test SOA switching

```powershell
# Identify a test user for SOA switching
$testUser = "testuser1@contoso.com"

# Step 1: Remove user from Cloud Sync scope
# Move user to an OU not in the sync scope filter
Get-ADUser -Identity "testuser1" |
    Move-ADObject -TargetPath "OU=CloudManaged,OU=Users,DC=contoso,DC=com"

# Step 2: Wait for sync cycle (2 minutes)
Start-Sleep -Seconds 120

# Step 3: Verify user is now cloud-managed
$user = Get-MgUser -UserId $testUser -Property OnPremisesSyncEnabled
Write-Host "Sync enabled: $($user.OnPremisesSyncEnabled)"
# Should be: $false or $null

# Step 4: Test cloud-managed attribute update
Update-MgUser -UserId $testUser -Department "Cloud Managed - Test"

# Step 5: Verify the update persists
$user = Get-MgUser -UserId $testUser -Property Department
Write-Host "Department: $($user.Department)"
# Should be: "Cloud Managed - Test"
```

### 6.3 Rollback SOA switching

```powershell
# If issues are detected, move user back to sync scope
Get-ADUser -Identity "testuser1" |
    Move-ADObject -TargetPath "OU=CloudSync-Pilot,OU=Users,DC=contoso,DC=com"

# Wait for sync cycle
Start-Sleep -Seconds 120

# Verify user is synced again
$user = Get-MgUser -UserId "testuser1@contoso.com" -Property OnPremisesSyncEnabled
Write-Host "Sync enabled: $($user.OnPremisesSyncEnabled)"
# Should be: $true
```

---

## Step 7: Expand scope

### 7.1 Expand to additional OUs

After successful pilot validation (minimum 2 weeks), expand the sync scope:

1. In the Cloud Sync configuration, update the **Scoping filter**
2. Add additional OUs or remove the filter for full-forest sync
3. Monitor provisioning logs for the expanded scope

### 7.2 Monitor ongoing sync health

```powershell
# Create a monitoring script for ongoing sync health
# Run as a scheduled task or Azure Automation runbook

$healthCheck = @{
    AgentStatus = (Get-Service "AADConnectProvisioningAgent").Status
    SyncErrors = (Get-MgAuditLogProvisioning -Filter "statusInfo/status eq 'failure'" `
        -Top 100).Count
    LastSync = (Get-MgAuditLogProvisioning -Top 1).ActivityDateTime
    TotalSyncedUsers = (Get-MgUser -All -Property OnPremisesSyncEnabled |
        Where-Object { $_.OnPremisesSyncEnabled -eq $true }).Count
}

$healthCheck | ConvertTo-Json
```

---

## Troubleshooting

### Common issues

| Issue                 | Symptom                                  | Resolution                                                |
| --------------------- | ---------------------------------------- | --------------------------------------------------------- |
| Agent not registering | Agent appears offline in portal          | Check firewall for HTTPS 443 to \*.microsoftonline.com    |
| Users not syncing     | Users missing from Entra ID              | Verify OU is in scope; check provisioning logs for errors |
| Password not syncing  | User can't sign in with on-prem password | Restart agent; verify PHS enabled; check DC connectivity  |
| Attribute mismatch    | Wrong department/title in Entra          | Review attribute mapping; check source AD attributes      |
| Duplicate users       | Two objects for same user                | Check ImmutableId; may need hard-match remediation        |

### Diagnostic commands

```powershell
# Agent-side diagnostics
Get-WinEvent -LogName "AAD Connect Provisioning Agent" -MaxEvents 50 |
    Where-Object { $_.Level -le 2 } |  # Errors and warnings
    Format-Table TimeCreated, Level, Message -AutoSize

# Network connectivity test
Invoke-WebRequest -Uri "https://login.microsoftonline.com" -UseBasicParsing |
    Select-Object StatusCode
```

---

## Next steps

After completing this tutorial:

1. **Expand scope** to include all production OUs (see Step 7)
2. **Configure Conditional Access** baseline policies (see [Security Migration](security-migration.md))
3. **Begin application migration** from AD FS to Entra SSO (see [Application Migration](application-migration.md))
4. **Plan device migration** to Entra Join (see [Tutorial: Device Join](tutorial-device-join.md))

---

**Maintainers:** csa-inabox core team
**Last updated:** 2026-04-30
