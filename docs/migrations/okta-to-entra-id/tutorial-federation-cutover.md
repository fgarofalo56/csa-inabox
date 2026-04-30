# Tutorial: Federation Cutover from Okta to Entra ID

**Status:** Authored 2026-04-30
**Audience:** Identity Engineers, IAM Administrators
**Duration:** 2-4 hours
**Prerequisites:** Entra ID tenant with verified domains, Entra Connect Sync (if hybrid), all SSO applications migrated, MFA enrolled

---

## What you will build

In this tutorial, you will execute a complete federation cutover from Okta to Entra ID managed authentication. You will:

1. Validate pre-migration readiness
2. Configure password hash synchronization (if not already enabled)
3. Execute staged rollover for a pilot group
4. Validate authentication for pilot users across all applications
5. Expand staged rollover to the full organization
6. Convert the domain from federated to managed
7. Validate post-cutover authentication
8. Document rollback procedures

!!! warning "Production impact"
Federation cutover directly affects user authentication. Execute this tutorial in a test environment first. For production, schedule during a maintenance window with help desk staffing.

---

## Step 1: Validate pre-migration readiness

### 1.1 Verify domain federation status

```powershell
# Connect to Microsoft Graph
Connect-MgGraph -Scopes "Domain.ReadWrite.All", "Policy.ReadWrite.AuthenticationMethod", "User.Read.All", "Group.ReadWrite.All"

# Check domain authentication type
$domains = Get-MgDomain
$domains | Format-Table Id, AuthenticationType, IsVerified, IsDefault

# Expected output for a domain federated to Okta:
# Id              AuthenticationType  IsVerified  IsDefault
# --              ------------------  ----------  ---------
# contoso.com     Federated          True        True
```

### 1.2 Verify federation configuration

```powershell
# Get federation configuration details
$federationConfig = Get-MgDomainFederationConfiguration -DomainId "contoso.com"
$federationConfig | Format-List

# Capture for rollback documentation:
# IssuerUri:              https://your-org.okta.com
# PassiveSignInUri:       https://your-org.okta.com/app/office365/{app-id}/sso/saml
# SignOutUri:             https://your-org.okta.com/login/signout
# MetadataExchangeUri:    https://your-org.okta.com/app/{app-id}/sso/saml/metadata
# ActiveSignInUri:        (WS-Trust endpoint if configured)

# Save federation configuration for rollback
$federationConfig | ConvertTo-Json -Depth 10 | Out-File "okta-federation-backup.json"
Write-Host "Federation configuration saved to okta-federation-backup.json"
```

### 1.3 Verify password hash synchronization

```powershell
# If using Entra Connect Sync (hybrid AD):
# Check PHS status on the Entra Connect server
Import-Module ADSync
$syncConfig = Get-ADSyncAADCompanyFeature
Write-Host "Password Hash Sync enabled: $($syncConfig.PasswordHashSync)"

# If PHS is not enabled:
if (-not $syncConfig.PasswordHashSync) {
    Write-Host "WARNING: PHS is not enabled. Enable PHS before federation cutover." -ForegroundColor Red
    Write-Host "Run: Set-ADSyncAADCompanyFeature -PasswordHashSync `$true"
    Write-Host "Then run: Start-ADSyncSyncCycle -PolicyType Initial"
    Write-Host "Wait for initial sync to complete before proceeding."
    return
}
```

### 1.4 Verify MFA enrollment

```powershell
# Check MFA enrollment rates
$registrationDetails = Get-MgReportAuthenticationMethodUserRegistrationDetail -All

$total = $registrationDetails.Count
$mfaRegistered = ($registrationDetails | Where-Object { $_.IsMfaRegistered -eq $true }).Count
$authenticatorRegistered = ($registrationDetails | Where-Object {
    $_.MethodsRegistered -contains "microsoftAuthenticator"
}).Count

$mfaPercentage = [math]::Round($mfaRegistered / $total * 100, 1)
$authPercentage = [math]::Round($authenticatorRegistered / $total * 100, 1)

Write-Host "MFA Readiness Report:"
Write-Host "  Total users: $total"
Write-Host "  MFA registered: $mfaRegistered ($mfaPercentage%)"
Write-Host "  Authenticator registered: $authenticatorRegistered ($authPercentage%)"

if ($mfaPercentage -lt 95) {
    Write-Host "WARNING: MFA enrollment below 95%. Address before cutover." -ForegroundColor Yellow
}
```

### 1.5 Verify SSO application migration

```powershell
# List all enterprise applications with SSO configured
$ssoApps = Get-MgServicePrincipal -Filter "preferredSingleSignOnMode eq 'saml' or preferredSingleSignOnMode eq 'oidc'" -All

Write-Host "Enterprise Applications with SSO configured: $($ssoApps.Count)"
$ssoApps | Format-Table DisplayName, PreferredSingleSignOnMode, AppId -AutoSize

# Cross-reference with Okta application inventory
# Ensure every Okta SSO app has an Entra equivalent
```

### 1.6 Verify break-glass accounts

```powershell
# Verify emergency access accounts exist and are not federated
$breakGlassUsers = @("emergency-admin@contoso.onmicrosoft.com", "break-glass@contoso.onmicrosoft.com")

foreach ($bg in $breakGlassUsers) {
    $user = Get-MgUser -Filter "userPrincipalName eq '$bg'" -ErrorAction SilentlyContinue
    if ($user) {
        Write-Host "Break-glass account found: $bg" -ForegroundColor Green
        # Verify the account uses .onmicrosoft.com domain (not federated)
        if ($bg -like "*.onmicrosoft.com") {
            Write-Host "  Domain: .onmicrosoft.com (not federated) - OK" -ForegroundColor Green
        }
    } else {
        Write-Host "WARNING: Break-glass account not found: $bg" -ForegroundColor Red
    }
}
```

---

## Step 2: Create pilot group

```powershell
# Create pilot group for staged rollover
$pilotGroup = New-MgGroup -DisplayName "Okta-Migration-Pilot" `
    -Description "Pilot group for Okta to Entra ID federation cutover" `
    -MailEnabled:$false `
    -MailNickname "OktaMigrationPilot" `
    -SecurityEnabled:$true

Write-Host "Pilot group created: $($pilotGroup.Id)"

# Add IT staff and identity team to pilot group
$pilotUsers = @(
    "admin1@contoso.com",
    "admin2@contoso.com",
    "identity-engineer@contoso.com"
    # Add 10-50 IT staff members
)

foreach ($upn in $pilotUsers) {
    $user = Get-MgUser -Filter "userPrincipalName eq '$upn'"
    if ($user) {
        New-MgGroupMember -GroupId $pilotGroup.Id -DirectoryObjectId $user.Id
        Write-Host "Added $upn to pilot group"
    }
}

Write-Host "Pilot group membership: $(($pilotUsers).Count) users"
```

---

## Step 3: Execute staged rollover for pilot group

```powershell
# Enable staged rollover for password hash sync
# This allows pilot group users to authenticate directly with Entra ID
# while the domain remains technically federated

# Create staged rollover policy via Graph API
$stagedRolloutBody = @{
    feature = "passwordHashSync"
    isEnabled = $true
    isAppliedToOrganization = $false
}

$rolloutPolicy = Invoke-MgGraphRequest -Method POST `
    -Uri "https://graph.microsoft.com/v1.0/policies/featureRolloutPolicies" `
    -Body ($stagedRolloutBody | ConvertTo-Json) `
    -ContentType "application/json"

Write-Host "Staged rollout policy created: $($rolloutPolicy.id)"

# Add pilot group to staged rollout
Invoke-MgGraphRequest -Method POST `
    -Uri "https://graph.microsoft.com/v1.0/policies/featureRolloutPolicies/$($rolloutPolicy.id)/appliesTo/`$ref" `
    -Body (@{ "@odata.id" = "https://graph.microsoft.com/v1.0/groups/$($pilotGroup.Id)" } | ConvertTo-Json) `
    -ContentType "application/json"

Write-Host "Pilot group added to staged rollout. Pilot users will now authenticate directly with Entra ID."
```

---

## Step 4: Validate pilot group authentication

### 4.1 Test sign-in for pilot users

```powershell
# Monitor sign-in logs for pilot users
$pilotGroupId = $pilotGroup.Id

# Wait 15 minutes for staged rollout to take effect
Write-Host "Staged rollout configured. Wait 15 minutes, then ask pilot users to sign in."
Write-Host "Monitor sign-in logs for the pilot group..."

# After pilot users sign in, check logs
$recentSignIns = Get-MgAuditLogSignIn `
    -Filter "createdDateTime ge $(Get-Date (Get-Date).AddHours(-1) -Format 'yyyy-MM-ddTHH:mm:ssZ')" `
    -Top 100

$pilotMembers = Get-MgGroupMember -GroupId $pilotGroupId -All | Select-Object -ExpandProperty Id

$pilotSignIns = $recentSignIns | Where-Object {
    $_.UserId -in $pilotMembers
}

Write-Host "`nPilot user sign-in results:"
$pilotSignIns | ForEach-Object {
    $status = if ($_.Status.ErrorCode -eq 0) { "SUCCESS" } else { "FAILED ($($_.Status.ErrorCode))" }
    Write-Host "  $($_.UserPrincipalName): $status"
    if ($_.Status.ErrorCode -ne 0) {
        Write-Host "    Failure reason: $($_.Status.FailureReason)" -ForegroundColor Red
    }
}
```

### 4.2 Validation checklist for pilot

Ask each pilot user to verify:

- [ ] Sign in to Microsoft 365 (outlook.office.com)
- [ ] Sign in to Azure portal (portal.azure.com)
- [ ] Access each migrated SSO application
- [ ] MFA prompt uses Microsoft Authenticator (not Okta Verify)
- [ ] Self-service password reset works (if applicable)
- [ ] No unexpected MFA prompts or access blocks
- [ ] Teams, OneDrive, SharePoint accessible on desktop and mobile

---

## Step 5: Expand staged rollover

After successful pilot validation (minimum 5 business days):

```powershell
# Create wave groups and add to staged rollout
$waves = @(
    @{ Name = "Okta-Migration-Wave2"; Description = "Early adopter department (200-500 users)" },
    @{ Name = "Okta-Migration-Wave3"; Description = "25% of organization" },
    @{ Name = "Okta-Migration-Wave4"; Description = "50% of organization" },
    @{ Name = "Okta-Migration-Wave5"; Description = "Remaining users" }
)

foreach ($wave in $waves) {
    $group = New-MgGroup -DisplayName $wave.Name `
        -Description $wave.Description `
        -MailEnabled:$false `
        -MailNickname ($wave.Name -replace "[^a-zA-Z0-9]", "") `
        -SecurityEnabled:$true

    Write-Host "Created group: $($wave.Name) ($($group.Id))"
    # Populate groups with appropriate users before adding to staged rollout
}

# Add wave groups to staged rollout one at a time
# Wait minimum 5 business days between waves
# Monitor sign-in logs and help desk tickets between each wave

# Example: Add Wave 2
$wave2Group = Get-MgGroup -Filter "displayName eq 'Okta-Migration-Wave2'"
Invoke-MgGraphRequest -Method POST `
    -Uri "https://graph.microsoft.com/v1.0/policies/featureRolloutPolicies/$($rolloutPolicy.id)/appliesTo/`$ref" `
    -Body (@{ "@odata.id" = "https://graph.microsoft.com/v1.0/groups/$($wave2Group.Id)" } | ConvertTo-Json) `
    -ContentType "application/json"

Write-Host "Wave 2 added to staged rollout."
```

---

## Step 6: Final federation cutover

After all waves complete staged rollover successfully:

```powershell
# Final step: Convert domain from federated to managed
Write-Host "=== FEDERATION CUTOVER ==="
Write-Host "This will convert contoso.com from federated (Okta) to managed (Entra ID)."
Write-Host "All users will authenticate directly with Entra ID after this change."
$confirm = Read-Host "Type 'CUTOVER' to proceed"

if ($confirm -eq "CUTOVER") {
    # Convert domain
    Update-MgDomain -DomainId "contoso.com" -AuthenticationType "Managed"

    # Verify
    $domain = Get-MgDomain -DomainId "contoso.com"
    Write-Host "Domain: $($domain.Id)"
    Write-Host "Authentication Type: $($domain.AuthenticationType)"

    if ($domain.AuthenticationType -eq "Managed") {
        Write-Host "FEDERATION CUTOVER COMPLETE" -ForegroundColor Green

        # Clean up staged rollout policies (no longer needed)
        $rolloutPolicies = Invoke-MgGraphRequest -Method GET `
            -Uri "https://graph.microsoft.com/v1.0/policies/featureRolloutPolicies"

        foreach ($policy in $rolloutPolicies.value) {
            Invoke-MgGraphRequest -Method DELETE `
                -Uri "https://graph.microsoft.com/v1.0/policies/featureRolloutPolicies/$($policy.id)"
            Write-Host "Deleted staged rollout policy: $($policy.feature)"
        }
    } else {
        Write-Host "WARNING: Domain did not convert. Check for errors." -ForegroundColor Red
    }
} else {
    Write-Host "Cutover cancelled."
}
```

---

## Step 7: Post-cutover validation

```powershell
# Monitor sign-in logs for errors in the first 24 hours
$cutoverTime = Get-Date -Format "yyyy-MM-ddTHH:mm:ssZ"

# Wait, then check for errors
Write-Host "Monitor sign-in logs for the next 24 hours."
Write-Host "Check for authentication failures related to federation..."

$errors = Get-MgAuditLogSignIn `
    -Filter "createdDateTime ge $cutoverTime and status/errorCode ne 0" `
    -Top 100

$federationErrors = $errors | Where-Object {
    $_.Status.ErrorCode -in @(50107, 50144, 50072, 50076)
}

if ($federationErrors.Count -eq 0) {
    Write-Host "No federation-related authentication errors detected." -ForegroundColor Green
} else {
    Write-Host "Federation-related errors detected:" -ForegroundColor Yellow
    $federationErrors | ForEach-Object {
        Write-Host "  User: $($_.UserPrincipalName), Error: $($_.Status.ErrorCode) - $($_.Status.FailureReason)"
    }
}
```

---

## Step 8: Rollback procedure (if needed)

```powershell
# EMERGENCY ROLLBACK: Re-enable Okta federation
# Only use if critical authentication issues arise post-cutover

Write-Host "=== EMERGENCY ROLLBACK ==="
Write-Host "This will re-enable Okta federation for contoso.com."

# Read saved federation configuration
$savedConfig = Get-Content "okta-federation-backup.json" | ConvertFrom-Json

# Re-create federation configuration
$federationParams = @{
    issuerUri = $savedConfig.IssuerUri
    passiveSignInUri = $savedConfig.PassiveSignInUri
    signOutUri = $savedConfig.SignOutUri
    preferredAuthenticationProtocol = "samlP"
    signingCertificate = $savedConfig.SigningCertificate
}

# Step 1: Convert domain back to federated
Update-MgDomain -DomainId "contoso.com" -AuthenticationType "Federated"

# Step 2: Re-apply federation configuration
New-MgDomainFederationConfiguration -DomainId "contoso.com" -BodyParameter $federationParams

# Verify rollback
$domain = Get-MgDomain -DomainId "contoso.com"
Write-Host "Domain: $($domain.Id) - Auth Type: $($domain.AuthenticationType)"

if ($domain.AuthenticationType -eq "Federated") {
    Write-Host "ROLLBACK COMPLETE - Okta federation re-enabled" -ForegroundColor Yellow
} else {
    Write-Host "ROLLBACK FAILED - Contact Microsoft support immediately" -ForegroundColor Red
}
```

---

## Step 9: Post-cutover cleanup (30-90 days after cutover)

```powershell
# After 30-90 days of stable operation on Entra managed authentication:

# 1. Remove migration wave groups
$migrationGroups = Get-MgGroup -Filter "startswith(displayName, 'Okta-Migration')"
foreach ($group in $migrationGroups) {
    Remove-MgGroup -GroupId $group.Id
    Write-Host "Removed group: $($group.DisplayName)"
}

# 2. Document completion
Write-Host "`n=== FEDERATION MIGRATION COMPLETE ==="
Write-Host "Domain: contoso.com"
Write-Host "Previous IdP: Okta"
Write-Host "Current IdP: Microsoft Entra ID (managed authentication)"
Write-Host "Cutover date: $cutoverTime"
Write-Host "Validation period: 90 days"
Write-Host "Status: Complete"

# 3. Okta tenant decommission (coordinate with Okta admin)
Write-Host "`nNext steps:"
Write-Host "  1. Deactivate Okta applications"
Write-Host "  2. Remove Okta Verify from user devices"
Write-Host "  3. Cancel Okta subscription"
Write-Host "  4. Export Okta System Log for compliance retention"
Write-Host "  5. Delete okta-federation-backup.json from secure storage"
```

---

## Troubleshooting

| Issue                                    | Cause                                                   | Resolution                                                              |
| ---------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------- |
| Users cannot sign in after cutover       | PHS not synced; no password hash in Entra               | Issue Temporary Access Pass (TAP) for affected users; verify PHS sync   |
| MFA not working after cutover            | Users still using Okta Verify                           | Direct users to https://aka.ms/mysecurityinfo to register Authenticator |
| SSO app fails after cutover              | App still pointing to Okta IdP                          | Update app's IdP configuration to Entra SAML/OIDC endpoints             |
| "AADSTS50107" error                      | Federated realm not found                               | Domain may not have fully converted; verify with `Get-MgDomain`         |
| Conditional Access blocking unexpectedly | New policies enforcing that were previously report-only | Review CA insights; adjust policies if needed                           |

---

## Key Microsoft Learn references

- [Migrate Okta federation to Entra managed authentication](https://learn.microsoft.com/entra/identity/enterprise-apps/migrate-okta-federation-to-azure-active-directory)
- [Staged rollover for cloud authentication](https://learn.microsoft.com/entra/identity/hybrid/connect/how-to-connect-staged-rollover)
- [Password hash synchronization](https://learn.microsoft.com/entra/identity/hybrid/connect/how-to-connect-password-hash-synchronization)
- [Temporary Access Pass](https://learn.microsoft.com/entra/identity/authentication/howto-authentication-temporary-access-pass)
- [Microsoft Graph PowerShell SDK](https://learn.microsoft.com/powershell/microsoftgraph/)

---

**Maintainers:** csa-inabox core team
**Last updated:** 2026-04-30
