# SSO Application Migration: Okta to Entra ID

**Status:** Authored 2026-04-30
**Audience:** Identity Architects, IAM Engineers, Application Owners
**Purpose:** Detailed guidance for migrating SSO application integrations from Okta to Entra ID

---

## Overview

SSO application migration is the most labor-intensive phase of an Okta-to-Entra ID migration. Each application integrated with Okta for single sign-on must be reconfigured to use Entra ID as the identity provider. The effort varies by protocol (SAML apps are more work than OIDC apps), by integration type (gallery apps are easier than custom apps), and by provisioning complexity.

Microsoft has published dedicated guidance: [Migrate applications from Okta to Microsoft Entra ID](https://learn.microsoft.com/entra/identity/enterprise-apps/migrate-apps-from-okta).

---

## 1. Application inventory and categorization

### Step 1: Export Okta application inventory

Use the Okta API to export all application integrations:

```bash
# Export all applications from Okta
curl -s -H "Authorization: SSWS ${OKTA_API_TOKEN}" \
  "https://${OKTA_DOMAIN}/api/v1/apps?limit=200" \
  | jq '[.[] | {
    id: .id,
    name: .name,
    label: .label,
    signOnMode: .signOnMode,
    status: .status,
    protocol: (if .signOnMode == "SAML_2_0" then "SAML"
               elif .signOnMode == "OPENID_CONNECT" then "OIDC"
               elif .signOnMode == "BROWSER_PLUGIN" then "SWA"
               elif .signOnMode == "BOOKMARK" then "Bookmark"
               elif .signOnMode == "WS_FEDERATION" then "WS-Fed"
               else .signOnMode end),
    provisioning: (.features | if . then (. | join(", ")) else "None" end)
  }]' > okta-app-inventory.json
```

### Step 2: Categorize by migration complexity

| Category                         | Protocol              | Migration effort | Approach                                                                    |
| -------------------------------- | --------------------- | ---------------- | --------------------------------------------------------------------------- |
| **Tier 1 -- Gallery match**      | SAML or OIDC          | Low              | Find equivalent in Entra app gallery; configure with gallery template       |
| **Tier 2 -- Standard protocol**  | SAML or OIDC (custom) | Medium           | Create non-gallery enterprise app; manual metadata/claims configuration     |
| **Tier 3 -- Password SSO**       | SWA                   | Medium           | Migrate to Entra password-based SSO via My Apps; consider upgrading to SAML |
| **Tier 4 -- Header-based**       | Header injection      | Medium-High      | Use Entra Application Proxy with header-based SSO                           |
| **Tier 5 -- Custom/proprietary** | Proprietary SDK       | High             | Requires application code changes to use MSAL or SAML                       |

### Step 3: Build migration spreadsheet

For each application, capture:

| Field                | Description                     | Example                           |
| -------------------- | ------------------------------- | --------------------------------- |
| App name             | Okta application label          | Salesforce                        |
| Protocol             | SAML, OIDC, SWA, WS-Fed, Header | SAML                              |
| Okta app ID          | Okta application identifier     | 0oa1234567890abcdef               |
| Gallery available    | Entra app gallery match exists  | Yes                               |
| Provisioning         | SCIM, import, none              | SCIM (create, update, deactivate) |
| User count           | Number of assigned users        | 2,500                             |
| Business criticality | Critical, High, Medium, Low     | Critical                          |
| Migration wave       | When to migrate                 | Wave 2                            |
| Owner                | Application owner contact       | jane.doe@contoso.com              |

---

## 2. SAML application migration

SAML applications are the most common SSO integration type in Okta. Each SAML app requires:

1. Creating an Enterprise Application in Entra ID
2. Configuring SAML metadata (Entity ID, ACS URL, signing certificate)
3. Mapping claims (NameID, attributes)
4. Updating the application's IdP configuration to point to Entra ID
5. Testing SSO

### Gallery SAML application

```powershell
# Step 1: Find the gallery application template
$templates = Get-MgServicePrincipal -Filter "tags/Any(t: t eq 'WindowsAzureActiveDirectoryGalleryApplicationNonOpenIdConnect')" `
  -CountVariable count -Top 50

# Search for specific app (e.g., Salesforce)
$salesforceTemplate = Get-MgApplicationTemplate -Filter "displayName eq 'Salesforce'"

# Step 2: Create enterprise application from gallery template
$app = New-MgApplicationFromTemplate -ApplicationTemplateId $salesforceTemplate.Id -DisplayName "Salesforce"

# Step 3: Configure SAML SSO
$params = @{
    preferredSingleSignOnMode = "saml"
}
Update-MgServicePrincipal -ServicePrincipalId $app.ServicePrincipal.Id -BodyParameter $params
```

### Custom SAML application

```powershell
# Step 1: Create non-gallery enterprise application
$appRegistration = New-MgApplication -DisplayName "Custom App - SAML"

# Step 2: Create service principal
$sp = New-MgServicePrincipal -AppId $appRegistration.AppId

# Step 3: Set preferred SSO mode to SAML
Update-MgServicePrincipal -ServicePrincipalId $sp.Id -PreferredSingleSignOnMode "saml"

# Step 4: Configure SAML SSO settings via Graph API
$samlConfig = @{
    "identifierUris" = @("https://custom-app.contoso.com")
    "web" = @{
        "redirectUris" = @("https://custom-app.contoso.com/saml/acs")
    }
}
Update-MgApplication -ApplicationId $appRegistration.Id -BodyParameter $samlConfig
```

### SAML claims mapping

Map Okta SAML attribute statements to Entra ID claims:

| Okta attribute statement             | Entra ID claim mapping                                                                | Configuration                                |
| ------------------------------------ | ------------------------------------------------------------------------------------- | -------------------------------------------- |
| `user.email` -> `email`              | `user.mail` -> `http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress`   | Default claim                                |
| `user.firstName` -> `firstName`      | `user.givenname` -> `http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname` | Default claim                                |
| `user.lastName` -> `lastName`        | `user.surname` -> `http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname`     | Default claim                                |
| `user.login` -> `nameID`             | `user.userprincipalname` -> NameID                                                    | Configure NameID format                      |
| Custom Okta attribute                | Extension attribute or claim transformation rule                                      | May require claims transformation            |
| `getFilteredGroups(...)` -> `groups` | Group claim (filtered by application assignment)                                      | Configure group claim in token configuration |

### SAML signing certificate

```powershell
# Generate new SAML signing certificate in Entra
$certParams = @{
    displayName = "Custom App SAML Signing Certificate"
    type = "AsymmetricX509Cert"
    usage = "Sign"
    key = @{
        usage = "Sign"
        type = "AsymmetricX509Cert"
    }
}

# Add certificate credential to service principal
Add-MgServicePrincipalTokenSigningCertificate -ServicePrincipalId $sp.Id

# Download federation metadata for the app to configure in the SP
# URL format: https://login.microsoftonline.com/{tenant-id}/federationmetadata/2007-06/federationmetadata.xml?appid={app-id}
```

---

## 3. OIDC application migration

OIDC applications are generally easier to migrate because the configuration is client-side (client ID, redirect URIs, scopes).

### Migration steps

```powershell
# Step 1: Register application in Entra ID
$app = New-MgApplication -DisplayName "My OIDC App" -SignInAudience "AzureADMyOrg" -Web @{
    RedirectUris = @(
        "https://myapp.contoso.com/auth/callback",
        "https://myapp.contoso.com/auth/silent"
    )
}

# Step 2: Create client secret (or configure certificate)
$secret = Add-MgApplicationPassword -ApplicationId $app.Id -PasswordCredential @{
    DisplayName = "Migration secret"
    EndDateTime = (Get-Date).AddYears(1)
}

# Step 3: Configure API permissions (scopes)
# Map Okta custom scopes to Entra permissions
Add-MgApplicationApiPermission -ApplicationId $app.Id -ApiId "00000003-0000-0000-c000-000000000000" -Scope @{
    Id = "e1fe6dd8-ba31-4d61-89e7-88639da4683d"  # User.Read
    Type = "Scope"
}

# Step 4: Output new configuration for application team
Write-Host "Client ID: $($app.AppId)"
Write-Host "Client Secret: $($secret.SecretText)"
Write-Host "Tenant ID: $(Get-MgContext | Select-Object -ExpandProperty TenantId)"
Write-Host "Authority: https://login.microsoftonline.com/$(Get-MgContext | Select-Object -ExpandProperty TenantId)"
Write-Host "Token Endpoint: https://login.microsoftonline.com/$(Get-MgContext | Select-Object -ExpandProperty TenantId)/oauth2/v2.0/token"
```

### Okta OIDC to Entra OIDC mapping

| Okta configuration                                | Entra ID equivalent                                         |
| ------------------------------------------------- | ----------------------------------------------------------- |
| Okta Org URL (`https://your-org.okta.com`)        | Authority (`https://login.microsoftonline.com/{tenant-id}`) |
| Client ID (Okta app ID)                           | Client ID (Entra app registration ID)                       |
| Client Secret                                     | Client Secret or Certificate                                |
| Authorization Server (`/oauth2/default`)          | `/oauth2/v2.0/authorize`                                    |
| Token Endpoint (`/oauth2/default/v1/token`)       | `/oauth2/v2.0/token`                                        |
| UserInfo Endpoint (`/oauth2/default/v1/userinfo`) | `/oidc/userinfo` or Microsoft Graph `/me`                   |
| Okta custom scopes                                | Entra API permissions (app roles + scopes)                  |
| Okta custom claims                                | Optional claims + claims mapping policies                   |

---

## 4. SWA application migration

Secure Web Authentication (SWA) apps use password vaulting -- Okta stores the user's credentials and replays them into login forms. Entra ID supports equivalent functionality through password-based SSO.

### Migration approach

1. **Preferred:** Upgrade the app to SAML or OIDC if the vendor supports it
2. **If upgrade not possible:** Configure password-based SSO in Entra My Apps

```powershell
# Create enterprise application with password-based SSO
$app = New-MgApplication -DisplayName "Legacy SWA App" -Web @{
    HomePageUrl = "https://legacy-app.contoso.com/login"
}
$sp = New-MgServicePrincipal -AppId $app.AppId
Update-MgServicePrincipal -ServicePrincipalId $sp.Id -PreferredSingleSignOnMode "password"

# Configure sign-in URL for password capture
Update-MgServicePrincipal -ServicePrincipalId $sp.Id -LoginUrl "https://legacy-app.contoso.com/login"
```

!!! tip "SWA apps are migration opportunities"
Every SWA/password-vaulted app is an opportunity to upgrade to SAML or OIDC. Contact the app vendor to check for SSO protocol support. Modern SaaS apps almost universally support SAML 2.0.

---

## 5. Migration wave planning

### Recommended wave order

| Wave       | Applications                                     | Rationale                                                                     |
| ---------- | ------------------------------------------------ | ----------------------------------------------------------------------------- |
| **Wave 0** | Test/sandbox apps                                | Low risk; validate migration process                                          |
| **Wave 1** | Microsoft apps (M365, Azure Portal)              | Handled by federation cutover; validates core identity                        |
| **Wave 2** | SAML gallery apps (Salesforce, ServiceNow, etc.) | Gallery templates simplify configuration; high user impact validates at scale |
| **Wave 3** | OIDC gallery apps                                | Client-side configuration changes; application teams must update configs      |
| **Wave 4** | Custom SAML/OIDC apps                            | Requires manual metadata configuration and claims mapping                     |
| **Wave 5** | SWA/password-based apps                          | Lowest priority; consider upgrading to SAML                                   |
| **Wave 6** | Header-based and legacy apps                     | Requires Application Proxy; most complex                                      |

### Per-application migration checklist

- [ ] Application identified in Okta inventory
- [ ] Protocol determined (SAML, OIDC, SWA, Header, WS-Fed)
- [ ] Entra gallery equivalent identified (if applicable)
- [ ] Enterprise Application created in Entra ID
- [ ] SSO configured (metadata, certificates, claims)
- [ ] Test user assigned and SSO validated
- [ ] Pilot group assigned and SSO validated
- [ ] Provisioning configured (if applicable -- see [Provisioning Migration](provisioning-migration.md))
- [ ] All users migrated from Okta assignment to Entra assignment
- [ ] Okta application integration deactivated
- [ ] Application owner sign-off

---

## 6. Okta Integration Network (OIN) to Entra app gallery mapping

Common OIN applications and their Entra gallery equivalents:

| OIN application         | Entra gallery name        | Provisioning | Notes                                       |
| ----------------------- | ------------------------- | ------------ | ------------------------------------------- |
| Salesforce              | Salesforce                | SCIM         | Full gallery support including provisioning |
| ServiceNow              | ServiceNow                | SCIM         | Full gallery support                        |
| Slack                   | Slack                     | SCIM         | Full gallery support                        |
| Zoom                    | Zoom                      | SCIM         | Full gallery support                        |
| Box                     | Box                       | SCIM         | Full gallery support                        |
| Dropbox Business        | Dropbox Business          | SCIM         | Full gallery support                        |
| GitHub Enterprise       | GitHub Enterprise Cloud   | SCIM         | Full gallery support                        |
| AWS IAM Identity Center | AWS IAM Identity Center   | SCIM         | Full gallery support                        |
| Google Workspace        | Google Workspace          | SCIM         | Full gallery support                        |
| Jira Cloud              | Atlassian Cloud           | SCIM         | Full gallery support                        |
| Confluence Cloud        | Atlassian Cloud           | SCIM         | Same as Jira (Atlassian platform)           |
| Workday                 | Workday                   | HR inbound   | HR-driven provisioning to Entra             |
| SuccessFactors          | SAP SuccessFactors        | HR inbound   | HR-driven provisioning to Entra             |
| DocuSign                | DocuSign                  | SAML only    | No provisioning in gallery                  |
| Adobe Creative Cloud    | Adobe Identity Management | SCIM         | Full gallery support                        |
| Zendesk                 | Zendesk                   | SCIM         | Full gallery support                        |

---

## 7. Claims transformation reference

Common claims transformation patterns when migrating from Okta to Entra:

### Extract email domain

Okta expression: `substringAfter(user.email, "@")`

Entra claims transformation:

```json
{
    "claimType": "emailDomain",
    "transformationId": "extractMailDomain",
    "source": {
        "type": "attribute",
        "name": "user.mail"
    },
    "transformation": {
        "type": "RegexReplace",
        "params": {
            "regex": ".*@(.*)",
            "replacement": "$1"
        }
    }
}
```

### Conditional claim value

Okta expression: `user.department == "IT" ? "admin" : "user"`

Entra: Use claims issuance rules with conditional statements in the Enterprise Application SAML claims configuration.

### Group filtering

Okta: `getFilteredGroups({"group_filter"}, "regex", limit)`

Entra: Configure group claims to emit groups assigned to the application, filtered by group type (Security, M365, etc.).

---

## 8. Validation and testing

### Per-application SSO validation

```powershell
# Generate test SAML assertion (for debugging)
# Use the Entra admin center: Enterprise Applications > {app} > Single sign-on > Test

# Validate SAML configuration
$sp = Get-MgServicePrincipal -Filter "displayName eq 'Custom App'"
$samlSettings = Get-MgServicePrincipalSamlSingleSignOnSetting -ServicePrincipalId $sp.Id

# Check sign-in logs for the application
$signInLogs = Get-MgAuditLogSignIn -Filter "appId eq '$($sp.AppId)' and status/errorCode ne 0" -Top 10

if ($signInLogs.Count -eq 0) {
    Write-Host "No authentication errors for $($sp.DisplayName)" -ForegroundColor Green
} else {
    Write-Host "Authentication errors detected:" -ForegroundColor Red
    $signInLogs | ForEach-Object {
        Write-Host "  User: $($_.UserPrincipalName), Error: $($_.Status.ErrorCode) - $($_.Status.FailureReason)"
    }
}
```

### Common SAML troubleshooting

| Error        | Cause                                 | Resolution                                     |
| ------------ | ------------------------------------- | ---------------------------------------------- |
| AADSTS50105  | User not assigned to application      | Assign user or group to enterprise application |
| AADSTS700016 | Application ID mismatch               | Verify Entity ID matches between app and Entra |
| AADSTS50011  | Reply URL mismatch                    | Update ACS URL in Entra enterprise application |
| AADSTS50107  | Requested realm object does not exist | Verify federation realm configuration          |
| AADSTS75011  | Authentication method mismatch        | Check SAML authentication context class        |

---

## Key Microsoft Learn references

- [Migrate applications from Okta to Entra ID](https://learn.microsoft.com/entra/identity/enterprise-apps/migrate-apps-from-okta)
- [Configure SAML SSO](https://learn.microsoft.com/entra/identity/enterprise-apps/configure-saml-sso)
- [Customize SAML token claims](https://learn.microsoft.com/entra/identity-platform/saml-claims-customization)
- [Entra Application Gallery](https://learn.microsoft.com/entra/identity/enterprise-apps/overview-application-gallery)
- [Application Proxy for on-premises apps](https://learn.microsoft.com/entra/identity/app-proxy/overview-what-is-app-proxy)

---

**Maintainers:** csa-inabox core team
**Last updated:** 2026-04-30
