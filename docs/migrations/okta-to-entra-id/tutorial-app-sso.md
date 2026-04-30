# Tutorial: Migrate SSO Applications from Okta to Entra ID

**Status:** Authored 2026-04-30
**Audience:** Identity Engineers, IAM Administrators, Application Owners
**Duration:** 2-3 hours (per application batch)
**Prerequisites:** Entra ID tenant configured, admin access to both Okta and Entra admin centers

---

## What you will build

In this tutorial, you will execute an end-to-end SSO application migration from Okta to Entra ID. You will:

1. Export and inventory all Okta SSO applications
2. Categorize applications by protocol (SAML, OIDC, SWA)
3. Configure a SAML gallery application in Entra ID (Salesforce example)
4. Configure a custom SAML application in Entra ID
5. Configure an OIDC application in Entra ID
6. Test SSO with pilot users
7. Migrate application assignments
8. Validate claims and attributes

---

## Step 1: Export Okta application inventory

### 1.1 Export via Okta API

```bash
# Set environment variables
export OKTA_DOMAIN="your-org.okta.com"
export OKTA_API_TOKEN="your-api-token"

# Export all active applications
curl -s -H "Authorization: SSWS ${OKTA_API_TOKEN}" \
  "https://${OKTA_DOMAIN}/api/v1/apps?limit=200&filter=status+eq+%22ACTIVE%22" \
  | jq '[.[] | {
    id: .id,
    label: .label,
    name: .name,
    signOnMode: .signOnMode,
    status: .status,
    features: .features,
    visibility: .visibility.autoSubmitToolbar,
    credentials: {
      scheme: .credentials.scheme,
      signingAlgorithm: .settings.signOn.digestAlgorithm
    },
    saml: (if .signOnMode == "SAML_2_0" then {
      ssoUrl: .settings.signOn.ssoAcsUrl,
      audience: .settings.signOn.audience,
      nameIdFormat: .settings.signOn.subjectNameIdFormat,
      attributeStatements: .settings.signOn.attributeStatements
    } else null end)
  }]' > okta-apps-export.json

echo "Exported $(jq '. | length' okta-apps-export.json) applications"
```

### 1.2 Export user assignments per application

```bash
# For each application, export user assignments
for app_id in $(jq -r '.[].id' okta-apps-export.json); do
  app_label=$(jq -r ".[] | select(.id == \"$app_id\") | .label" okta-apps-export.json)
  echo "Exporting assignments for: $app_label"

  curl -s -H "Authorization: SSWS ${OKTA_API_TOKEN}" \
    "https://${OKTA_DOMAIN}/api/v1/apps/${app_id}/users?limit=200" \
    | jq '[.[] | { userId: .id, scope: .scope, status: .status }]' \
    > "assignments-${app_id}.json"

  count=$(jq '. | length' "assignments-${app_id}.json")
  echo "  Users assigned: $count"
done
```

### 1.3 Categorize applications

```bash
# Generate category summary
jq -r '
  group_by(.signOnMode) |
  .[] |
  "\(.[0].signOnMode): \(. | length) apps"
' okta-apps-export.json

# Expected output:
# SAML_2_0: 25 apps
# OPENID_CONNECT: 12 apps
# BROWSER_PLUGIN: 8 apps
# BOOKMARK: 5 apps
# WS_FEDERATION: 2 apps
```

---

## Step 2: Migrate a SAML gallery application (Salesforce example)

### 2.1 Create Enterprise Application from gallery

```powershell
# Connect to Microsoft Graph
Connect-MgGraph -Scopes "Application.ReadWrite.All", "AppRoleAssignment.ReadWrite.All"

# Find Salesforce in the gallery
$templates = Get-MgApplicationTemplate -Filter "displayName eq 'Salesforce'"
$salesforceTemplate = $templates | Select-Object -First 1

Write-Host "Gallery template found: $($salesforceTemplate.DisplayName) ($($salesforceTemplate.Id))"

# Instantiate the gallery application
$result = Invoke-MgInstantiateApplicationTemplate -ApplicationTemplateId $salesforceTemplate.Id `
    -Body @{ displayName = "Salesforce" }

$appId = $result.Application.AppId
$spId = $result.ServicePrincipal.Id
Write-Host "Enterprise Application created:"
Write-Host "  App ID: $appId"
Write-Host "  Service Principal ID: $spId"
```

### 2.2 Configure SAML SSO

```powershell
# Set preferred SSO mode to SAML
Update-MgServicePrincipal -ServicePrincipalId $spId -PreferredSingleSignOnMode "saml"

# Configure SAML URLs (from Okta application settings)
# Get these values from Okta admin console > Applications > Salesforce > Sign On tab
$samlConfig = @{
    web = @{
        redirectUris = @(
            "https://contoso.my.salesforce.com?so=00D000000000001"
        )
    }
    identifierUris = @(
        "https://contoso.my.salesforce.com"
    )
}

Update-MgApplication -ApplicationId $result.Application.Id -BodyParameter $samlConfig

Write-Host "SAML SSO configured for Salesforce"
```

### 2.3 Configure SAML claims

```powershell
# Map Okta SAML attribute statements to Entra claims
# Okta attribute statements (from export):
#   user.email -> emailAddress
#   user.firstName -> firstName
#   user.lastName -> lastName
#   user.login -> federationIdentifier

# In Entra, configure claims via the admin center:
# Enterprise Applications > Salesforce > Single sign-on > Attributes & Claims

# Or via Graph API:
$claimsMapping = @{
    claimsMappingPolicies = @(
        @{
            displayName = "Salesforce Claims Policy"
            definition = @(
                '{"ClaimsMappingPolicy":{"Version":1,"IncludeBasicClaimSet":"true","ClaimsSchema":[{"Source":"user","ID":"mail","SamlClaimType":"http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress"},{"Source":"user","ID":"givenname","SamlClaimType":"http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname"},{"Source":"user","ID":"surname","SamlClaimType":"http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname"},{"Source":"user","ID":"userprincipalname","SamlClaimType":"http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier"}]}}'
            )
        }
    )
}

# Apply claims mapping policy to service principal
# This is typically done via the Entra admin center for gallery apps
Write-Host "Configure claims via: Entra admin center > Enterprise Applications > Salesforce > Single sign-on > Attributes & Claims"
```

### 2.4 Download Entra federation metadata

```powershell
# Get the SAML metadata URL for Salesforce
$tenantId = (Get-MgContext).TenantId
$metadataUrl = "https://login.microsoftonline.com/$tenantId/federationmetadata/2007-06/federationmetadata.xml?appid=$appId"

Write-Host "SAML Metadata URL: $metadataUrl"
Write-Host ""
Write-Host "Configure this in Salesforce:"
Write-Host "  1. Go to Salesforce Setup > Identity > Single Sign-On Settings"
Write-Host "  2. Upload metadata from: $metadataUrl"
Write-Host "  3. Or manually configure:"

# Get signing certificate
$loginUrl = "https://login.microsoftonline.com/$tenantId/saml2"
$logoutUrl = "https://login.microsoftonline.com/$tenantId/saml2"
$entityId = "https://sts.windows.net/$tenantId/"

Write-Host "  Entity ID: $entityId"
Write-Host "  SSO URL: $loginUrl"
Write-Host "  SLO URL: $logoutUrl"
```

---

## Step 3: Migrate a custom SAML application

For applications not in the Entra gallery:

### 3.1 Create non-gallery enterprise application

```powershell
# Create a new application registration
$customApp = New-MgApplication -DisplayName "Internal HR Portal" `
    -SignInAudience "AzureADMyOrg" `
    -IdentifierUris @("https://hr-portal.contoso.com") `
    -Web @{
        RedirectUris = @("https://hr-portal.contoso.com/saml/acs")
    }

# Create service principal
$customSp = New-MgServicePrincipal -AppId $customApp.AppId

# Set SSO mode to SAML
Update-MgServicePrincipal -ServicePrincipalId $customSp.Id -PreferredSingleSignOnMode "saml"

Write-Host "Custom SAML app created:"
Write-Host "  Display Name: Internal HR Portal"
Write-Host "  App ID: $($customApp.AppId)"
Write-Host "  SP ID: $($customSp.Id)"
```

### 3.2 Configure claims from Okta attribute statements

```powershell
# Map Okta attribute statements to Entra claims
# Okta had these custom attribute statements:
#   user.employeeNumber -> employeeId
#   user.department -> department
#   user.title -> jobTitle
#   appuser.role -> customRole (app-specific attribute)

Write-Host "Configure custom claims in Entra admin center:"
Write-Host "  Enterprise Applications > Internal HR Portal > Single sign-on > Attributes & Claims"
Write-Host ""
Write-Host "  Add the following claims:"
Write-Host "  1. employeeId -> Source: user.employeeid"
Write-Host "  2. department -> Source: user.department"
Write-Host "  3. jobTitle -> Source: user.jobtitle"
Write-Host "  4. customRole -> Source: user.assignedroles (or app role)"
```

---

## Step 4: Migrate an OIDC application

### 4.1 Create app registration for OIDC

```powershell
# Create OIDC application registration
$oidcApp = New-MgApplication -DisplayName "Internal Dashboard (OIDC)" `
    -SignInAudience "AzureADMyOrg" `
    -Web @{
        RedirectUris = @(
            "https://dashboard.contoso.com/auth/callback",
            "https://dashboard.contoso.com/auth/silent-renew"
        )
        ImplicitGrantSettings = @{
            EnableIdTokenIssuance = $true
            EnableAccessTokenIssuance = $false
        }
    }

# Create client secret
$secret = Add-MgApplicationPassword -ApplicationId $oidcApp.Id -PasswordCredential @{
    DisplayName = "Dashboard client secret"
    EndDateTime = (Get-Date).AddYears(2)
}

# Output configuration for application team
$tenantId = (Get-MgContext).TenantId

Write-Host "`n=== OIDC Application Configuration ==="
Write-Host "Update your application's OIDC configuration:"
Write-Host ""
Write-Host "  # Old Okta configuration (replace these):"
Write-Host "  # OIDC_ISSUER=https://your-org.okta.com/oauth2/default"
Write-Host "  # OIDC_CLIENT_ID=okta-client-id"
Write-Host "  # OIDC_CLIENT_SECRET=okta-client-secret"
Write-Host ""
Write-Host "  # New Entra ID configuration:"
Write-Host "  OIDC_ISSUER=https://login.microsoftonline.com/$tenantId/v2.0"
Write-Host "  OIDC_CLIENT_ID=$($oidcApp.AppId)"
Write-Host "  OIDC_CLIENT_SECRET=$($secret.SecretText)"
Write-Host "  OIDC_AUTHORITY=https://login.microsoftonline.com/$tenantId"
Write-Host "  OIDC_TOKEN_ENDPOINT=https://login.microsoftonline.com/$tenantId/oauth2/v2.0/token"
Write-Host "  OIDC_AUTHORIZE_ENDPOINT=https://login.microsoftonline.com/$tenantId/oauth2/v2.0/authorize"
Write-Host ""
Write-Host "  IMPORTANT: Save the client secret securely. It will not be shown again."
```

---

## Step 5: Assign pilot users and test SSO

### 5.1 Create test assignment group

```powershell
# Create a group for SSO testing
$testGroup = New-MgGroup -DisplayName "SSO-Migration-Test" `
    -Description "Test group for SSO migration validation" `
    -MailEnabled:$false `
    -MailNickname "SSOMigrationTest" `
    -SecurityEnabled:$true

# Add test users
$testUsers = @("test-user1@contoso.com", "test-user2@contoso.com", "test-user3@contoso.com")
foreach ($upn in $testUsers) {
    $user = Get-MgUser -Filter "userPrincipalName eq '$upn'"
    New-MgGroupMember -GroupId $testGroup.Id -DirectoryObjectId $user.Id
}

# Assign group to each migrated application
$apps = @("Salesforce", "Internal HR Portal", "Internal Dashboard (OIDC)")
foreach ($appName in $apps) {
    $sp = Get-MgServicePrincipal -Filter "displayName eq '$appName'"
    if ($sp) {
        New-MgServicePrincipalAppRoleAssignment -ServicePrincipalId $sp.Id -Body @{
            principalId = $testGroup.Id
            resourceId = $sp.Id
            appRoleId = "00000000-0000-0000-0000-000000000000"  # Default access
        }
        Write-Host "Assigned $appName to test group"
    }
}
```

### 5.2 Test SSO for each application

```powershell
# Generate test URLs
$tenantId = (Get-MgContext).TenantId

foreach ($appName in $apps) {
    $sp = Get-MgServicePrincipal -Filter "displayName eq '$appName'"
    if ($sp) {
        Write-Host "`nTest SSO for: $appName"
        Write-Host "  My Apps URL: https://myapps.microsoft.com"
        Write-Host "  Direct SSO test: https://login.microsoftonline.com/$tenantId/saml2?SAMLRequest=..."
        Write-Host "  Admin test: Entra admin center > Enterprise Applications > $appName > Single sign-on > Test"
    }
}
```

### 5.3 Validate SSO sign-in logs

```powershell
# Check sign-in logs for test applications
foreach ($appName in $apps) {
    $sp = Get-MgServicePrincipal -Filter "displayName eq '$appName'"
    if ($sp) {
        $signIns = Get-MgAuditLogSignIn `
            -Filter "appId eq '$($sp.AppId)' and createdDateTime ge $(Get-Date (Get-Date).AddHours(-24) -Format 'yyyy-MM-ddTHH:mm:ssZ')" `
            -Top 20

        Write-Host "`n$appName sign-in results (last 24 hours):"
        if ($signIns.Count -eq 0) {
            Write-Host "  No sign-in attempts recorded" -ForegroundColor Yellow
        } else {
            $signIns | ForEach-Object {
                $status = if ($_.Status.ErrorCode -eq 0) { "OK" } else { "FAIL ($($_.Status.ErrorCode))" }
                Write-Host "  $($_.UserPrincipalName): $status at $($_.CreatedDateTime)"
            }
        }
    }
}
```

---

## Step 6: Migrate all user assignments

After testing succeeds with the pilot group:

```powershell
# For each application, migrate assignments from Okta groups to Entra groups
# This example migrates the full user base for Salesforce

$salesforceSp = Get-MgServicePrincipal -Filter "displayName eq 'Salesforce'"

# Option A: Assign an existing Entra security group
$salesforceGroup = Get-MgGroup -Filter "displayName eq 'Salesforce-Users'"
New-MgServicePrincipalAppRoleAssignment -ServicePrincipalId $salesforceSp.Id -Body @{
    principalId = $salesforceGroup.Id
    resourceId = $salesforceSp.Id
    appRoleId = "00000000-0000-0000-0000-000000000000"
}

# Option B: Assign individual users (for apps with specific role mappings)
# Export Okta assignments and recreate in Entra
$oktaAssignments = Get-Content "assignments-okta-app-id.json" | ConvertFrom-Json

foreach ($assignment in $oktaAssignments) {
    # Map Okta user ID to Entra user
    # This requires a mapping table or matching by email/UPN
    $user = Get-MgUser -Filter "userPrincipalName eq '$($assignment.email)'"
    if ($user) {
        New-MgServicePrincipalAppRoleAssignment -ServicePrincipalId $salesforceSp.Id -Body @{
            principalId = $user.Id
            resourceId = $salesforceSp.Id
            appRoleId = "00000000-0000-0000-0000-000000000000"
        }
    }
}

Write-Host "User assignments migrated for Salesforce"
```

---

## Step 7: Deactivate Okta application integration

After all users are migrated and SSO is validated through Entra:

```bash
# Deactivate the Okta application (do not delete yet -- keep for rollback)
curl -s -X POST -H "Authorization: SSWS ${OKTA_API_TOKEN}" \
  "https://${OKTA_DOMAIN}/api/v1/apps/${OKTA_APP_ID}/lifecycle/deactivate"

echo "Okta application deactivated (can be reactivated for rollback)"
```

---

## Summary checklist

- [ ] Okta application inventory exported
- [ ] Applications categorized by protocol and complexity
- [ ] Gallery SAML apps configured in Entra
- [ ] Custom SAML apps configured in Entra
- [ ] OIDC apps configured in Entra (application teams updated config)
- [ ] SWA apps migrated to password-based SSO or upgraded to SAML
- [ ] Pilot group assigned and SSO tested for all apps
- [ ] Claims validated (NameID, attributes, groups)
- [ ] Full user assignments migrated from Okta to Entra
- [ ] Sign-in logs monitored for errors
- [ ] Okta application integrations deactivated (not deleted)
- [ ] Application owners provided sign-off

---

## Key Microsoft Learn references

- [Migrate applications from Okta to Entra ID](https://learn.microsoft.com/entra/identity/enterprise-apps/migrate-apps-from-okta)
- [Configure SAML SSO](https://learn.microsoft.com/entra/identity/enterprise-apps/configure-saml-sso)
- [OIDC/OAuth app registration](https://learn.microsoft.com/entra/identity-platform/quickstart-register-app)
- [Customize SAML token claims](https://learn.microsoft.com/entra/identity-platform/saml-claims-customization)
- [My Apps portal](https://learn.microsoft.com/entra/identity/enterprise-apps/myapps-overview)

---

**Maintainers:** csa-inabox core team
**Last updated:** 2026-04-30
