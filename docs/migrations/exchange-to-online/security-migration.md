# Security Migration: Exchange On-Premises to Exchange Online

**Status:** Authored 2026-04-30
**Audience:** Exchange administrators, security engineers, and M365 architects migrating transport rules, mail flow security, anti-spam, anti-malware, and email authentication configurations.
**Scope:** Transport rules, connectors, mail flow, anti-spam (EOP), anti-malware, Safe Attachments, Safe Links, DKIM/DMARC/SPF configuration.

---

## Overview

Security migration encompasses every component that protects mail flow: transport rules that enforce policy, connectors that route mail securely, anti-spam and anti-malware engines that filter threats, and email authentication records (SPF, DKIM, DMARC) that prevent spoofing. This document covers the migration of each component from on-premises Exchange to Exchange Online and Exchange Online Protection (EOP) / Microsoft Defender for Office 365.

---

## 1. Transport rules migration

### Export on-premises transport rules

```powershell
# On-premises Exchange Management Shell
# Export all transport rules
Get-TransportRule | Select-Object Name, Priority, State, Conditions, Actions, Exceptions |
    Export-Csv C:\Migration\transport-rules.csv -NoTypeInformation

# Export detailed rule configuration
$rules = Get-TransportRule
foreach ($rule in $rules) {
    $rule | Format-List Name, Priority, State, *Condition*, *Action*, *Exception* |
        Out-File "C:\Migration\rules\$($rule.Name -replace '[^a-zA-Z0-9]', '_').txt"
}

# Count rules by category
Write-Host "Total rules: $($rules.Count)"
Write-Host "Enabled: $(($rules | Where-Object State -eq 'Enabled').Count)"
Write-Host "Disabled: $(($rules | Where-Object State -eq 'Disabled').Count)"
```

### Create equivalent rules in Exchange Online

```powershell
# Connect to Exchange Online PowerShell
Connect-ExchangeOnline -UserPrincipalName admin@domain.com

# Example: Disclaimer rule
New-TransportRule -Name "External Email Disclaimer" `
    -FromScope InOrganization `
    -SentToScope NotInOrganization `
    -ApplyHtmlDisclaimerText "<p style='color:gray;font-size:10px;'>This email is confidential...</p>" `
    -ApplyHtmlDisclaimerLocation Append `
    -ApplyHtmlDisclaimerFallbackAction Wrap

# Example: Block specific attachment types
New-TransportRule -Name "Block Executable Attachments" `
    -AttachmentExtensionMatchesWords @("exe","bat","cmd","vbs","js","ps1","scr","com") `
    -RejectMessageReasonText "Executable attachments are blocked by policy."

# Example: Require TLS for partner domain
New-TransportRule -Name "Require TLS to Partner" `
    -SentToScope NotInOrganization `
    -RecipientDomainIs "partner.com" `
    -RouteMessageOutboundRequireTls $true

# Example: BCC compliance copy
New-TransportRule -Name "BCC Compliance Officer" `
    -FromScope InOrganization `
    -SentToScope NotInOrganization `
    -BlindCopyTo "compliance@domain.com"
```

### Transport rule migration mapping

| On-prem predicate/action             | EXO equivalent                       | Notes                                                       |
| ------------------------------------ | ------------------------------------ | ----------------------------------------------------------- |
| `From` (sender)                      | `From`                               | 1:1 mapping                                                 |
| `SentTo` (recipient)                 | `SentTo`                             | 1:1 mapping                                                 |
| `SubjectContainsWords`               | `SubjectContainsWords`               | 1:1 mapping                                                 |
| `AttachmentSizeOver`                 | `AttachmentSizeOver`                 | 1:1 mapping                                                 |
| `HeaderContainsMessageHeader`        | `HeaderContainsMessageHeader`        | 1:1 mapping                                                 |
| `MessageContainsDataClassifications` | `MessageContainsDataClassifications` | DLP-related; consider Purview DLP instead                   |
| `ModerateMessageByUser`              | `ModerateMessageByUser`              | 1:1 mapping                                                 |
| `PrependSubject`                     | `PrependSubject`                     | 1:1 mapping                                                 |
| `SetHeaderName`/`SetHeaderValue`     | `SetHeaderName`/`SetHeaderValue`     | 1:1 mapping                                                 |
| `RouteMessageOutboundConnector`      | `RouteMessageOutboundConnector`      | Must reference an EXO outbound connector                    |
| Custom transport agent actions       | Not available                        | Must be re-implemented as mail flow rules or Power Automate |

---

## 2. Connectors migration

### Send connectors to outbound connectors

```powershell
# Export on-premises send connectors
Get-SendConnector | Select-Object Name, AddressSpaces, SmartHosts, TlsAuthLevel, RequireTLS |
    Export-Csv C:\Migration\send-connectors.csv -NoTypeInformation

# Create outbound connectors in Exchange Online
New-OutboundConnector -Name "Partner Connector - Acme Corp" `
    -RecipientDomains "acme.com" `
    -SmartHosts "mail.acme.com" `
    -TlsSettings DomainValidation `
    -TlsDomain "mail.acme.com" `
    -UseMXRecord $false `
    -Enabled $true

# Create outbound connector for on-premises smart host relay
New-OutboundConnector -Name "On-Premises SmartHost" `
    -RecipientDomains "*" `
    -SmartHosts "mail.domain.com" `
    -TlsSettings EncryptionOnly `
    -UseMXRecord $false `
    -RouteAllMessagesViaOnPremises $true `
    -Enabled $true
```

### Receive connectors to inbound connectors

```powershell
# Export on-premises receive connectors
Get-ReceiveConnector | Select-Object Name, RemoteIPRanges, AuthMechanism, PermissionGroups |
    Export-Csv C:\Migration\receive-connectors.csv -NoTypeInformation

# Create inbound connector for partner TLS
New-InboundConnector -Name "Partner Connector - Acme Corp" `
    -SenderDomains "acme.com" `
    -RequireTls $true `
    -TlsSenderCertificateName "*.acme.com" `
    -RestrictDomainsToCertificate $true `
    -Enabled $true

# Create inbound connector for on-premises relay
New-InboundConnector -Name "On-Premises Relay" `
    -SenderDomains "*" `
    -ConnectorType OnPremises `
    -RequireTls $true `
    -Enabled $true
```

### Application SMTP relay

Applications that send email through on-premises Exchange relay connectors must be reconfigured for Exchange Online:

| Method                   | Authentication                                | Limits                | Best for                                     |
| ------------------------ | --------------------------------------------- | --------------------- | -------------------------------------------- |
| **SMTP AUTH submission** | Username/password (modern auth or basic auth) | 10,000 recipients/day | Low-volume apps with auth capability         |
| **Direct Send**          | None (uses MX)                                | No throttle (your MX) | Internal apps sending to internal recipients |
| **SMTP relay connector** | IP-based or certificate-based                 | 10,000 recipients/day | Multi-function devices, legacy apps          |

```powershell
# Option 1: SMTP AUTH submission
# App sends to smtp.office365.com:587
# Requires: licensed mailbox, modern auth or app password

# Option 2: Direct Send (internal only)
# App sends to domain-com.mail.protection.outlook.com:25
# No auth required; only works for internal recipients

# Option 3: SMTP relay connector
# Create inbound connector with IP allow list
New-InboundConnector -Name "Application Relay" `
    -SenderDomains "domain.com" `
    -ConnectorType OnPremises `
    -SenderIPAddresses "10.0.1.100","10.0.1.101" `
    -RestrictDomainsToIPAddresses $true `
    -Enabled $true
```

---

## 3. Anti-spam configuration: EOP

Exchange Online Protection (EOP) replaces all on-premises anti-spam components.

### EOP policy configuration

```powershell
# Connect to Exchange Online PowerShell
Connect-ExchangeOnline -UserPrincipalName admin@domain.com

# Configure anti-spam policy
Set-HostedContentFilterPolicy -Identity Default `
    -SpamAction MoveToJmf `
    -HighConfidenceSpamAction Quarantine `
    -PhishSpamAction Quarantine `
    -HighConfidencePhishAction Quarantine `
    -BulkSpamAction MoveToJmf `
    -BulkThreshold 6 `
    -QuarantineRetentionPeriod 30

# Configure connection filter (IP allow/block)
Set-HostedConnectionFilterPolicy -Identity Default `
    -IPAllowList @{Add="203.0.113.10","198.51.100.0/24"} `
    -IPBlockList @{Add="192.0.2.50"}

# Configure outbound spam policy
Set-HostedOutboundSpamFilterPolicy -Identity Default `
    -RecipientLimitExternalPerHour 500 `
    -RecipientLimitInternalPerHour 1000 `
    -ActionWhenThresholdReached BlockUser
```

### Tenant Allow/Block List

```powershell
# Block specific senders
New-TenantAllowBlockListItems -ListType Sender `
    -Entries "spam@bad-domain.com","*@malicious-domain.com" `
    -Block

# Allow specific senders (override false positives)
New-TenantAllowBlockListItems -ListType Sender `
    -Entries "newsletter@trusted-partner.com" `
    -Allow `
    -ExpirationDate (Get-Date).AddDays(30)

# Block specific file types
New-TenantAllowBlockListItems -ListType FileHash `
    -Entries "SHA256HashHere" `
    -Block
```

---

## 4. Microsoft Defender for Office 365

Defender for Office 365 (Plan 1/Plan 2, included in E5) provides advanced threat protection beyond EOP.

### Safe Attachments

```powershell
# Create Safe Attachments policy
New-SafeAttachmentPolicy -Name "Standard Protection" `
    -Action DynamicDelivery `
    -Enable $true `
    -Redirect $true `
    -RedirectAddress "secops@domain.com"

New-SafeAttachmentRule -Name "Standard Protection Rule" `
    -SafeAttachmentPolicy "Standard Protection" `
    -RecipientDomainIs "domain.com" `
    -Enabled $true
```

### Safe Links

```powershell
# Create Safe Links policy
New-SafeLinksPolicy -Name "Standard Protection" `
    -IsEnabled $true `
    -ScanUrls $true `
    -EnableForInternalSenders $true `
    -DeliverMessageAfterScan $true `
    -TrackClicks $true `
    -AllowClickThrough $false

New-SafeLinksRule -Name "Standard Protection Rule" `
    -SafeLinksPolicy "Standard Protection" `
    -RecipientDomainIs "domain.com" `
    -Enabled $true
```

### Anti-phishing

```powershell
# Create anti-phishing policy
New-AntiPhishPolicy -Name "Executive Protection" `
    -Enabled $true `
    -EnableMailboxIntelligence $true `
    -EnableMailboxIntelligenceProtection $true `
    -EnableOrganizationDomainsProtection $true `
    -EnableTargetedDomainsProtection $true `
    -TargetedDomainsToProtect "partner.com","vendor.com" `
    -EnableTargetedUserProtection $true `
    -TargetedUsersToProtect "CEO;ceo@domain.com","CFO;cfo@domain.com" `
    -TargetedUserProtectionAction Quarantine `
    -EnableSpoofIntelligence $true

New-AntiPhishRule -Name "Executive Protection Rule" `
    -AntiPhishPolicy "Executive Protection" `
    -RecipientDomainIs "domain.com" `
    -Enabled $true
```

---

## 5. Email authentication: SPF, DKIM, DMARC

### SPF (Sender Policy Framework)

```
# DNS TXT record for SPF
# Include Exchange Online as authorized sender
@ TXT "v=spf1 include:spf.protection.outlook.com -all"

# If keeping on-premises relay during transition:
@ TXT "v=spf1 ip4:203.0.113.10 include:spf.protection.outlook.com -all"

# For GCC-High:
@ TXT "v=spf1 include:spf.protection.office365.us -all"
```

### DKIM (DomainKeys Identified Mail)

```powershell
# Enable DKIM signing in Exchange Online
Connect-ExchangeOnline -UserPrincipalName admin@domain.com

# Enable DKIM for domain
New-DkimSigningConfig -DomainName "domain.com" -Enabled $true

# Get CNAME records to add to DNS
Get-DkimSigningConfig -Identity "domain.com" | Format-List Selector1CNAME, Selector2CNAME
```

Add DNS CNAME records:

```
selector1._domainkey CNAME selector1-domain-com._domainkey.domain.onmicrosoft.com
selector2._domainkey CNAME selector2-domain-com._domainkey.domain.onmicrosoft.com
```

### DMARC (Domain-based Message Authentication, Reporting, and Conformance)

```
# Start with monitoring mode (p=none) to collect data
_dmarc TXT "v=DMARC1; p=none; rua=mailto:dmarc-reports@domain.com; ruf=mailto:dmarc-forensic@domain.com; pct=100"

# After validating SPF/DKIM alignment, move to quarantine
_dmarc TXT "v=DMARC1; p=quarantine; rua=mailto:dmarc-reports@domain.com; pct=100"

# Final: reject unauthenticated mail
_dmarc TXT "v=DMARC1; p=reject; rua=mailto:dmarc-reports@domain.com; pct=100"
```

!!! tip "DMARC rollout strategy"
Deploy DMARC in phases: `p=none` (monitor) for 4--8 weeks, then `p=quarantine` for 4 weeks, then `p=reject`. Monitor DMARC aggregate reports to identify legitimate senders that fail SPF/DKIM alignment before enforcing rejection.

---

## 6. Security migration checklist

- [ ] **Transport rules:** Export all rules; create equivalents in EXO; test in audit mode first.
- [ ] **Send connectors:** Export; create outbound connectors in EXO.
- [ ] **Receive connectors:** Export; create inbound connectors in EXO.
- [ ] **Application relay:** Reconfigure apps for SMTP AUTH, Direct Send, or relay connector.
- [ ] **Anti-spam:** Configure EOP policies (content filter, connection filter, outbound filter).
- [ ] **Anti-malware:** EOP anti-malware enabled by default; review policy settings.
- [ ] **Safe Attachments:** Configure Defender for Office 365 Safe Attachments policies.
- [ ] **Safe Links:** Configure Defender for Office 365 Safe Links policies.
- [ ] **Anti-phishing:** Configure impersonation protection for executives and partners.
- [ ] **SPF:** Update DNS TXT record to include `spf.protection.outlook.com`.
- [ ] **DKIM:** Enable DKIM signing; add CNAME records to DNS.
- [ ] **DMARC:** Deploy `p=none` initially; progress to `p=reject` after validation.
- [ ] **Third-party anti-spam gateway:** Decide: retain (MX to gateway) or decommission (MX to EOP).
- [ ] **Conditional Access:** Configure Entra Conditional Access for Outlook/Exchange access.
- [ ] **Modern auth:** Disable legacy auth protocols (POP, IMAP basic auth, SMTP basic auth).

---

## 7. Post-migration security hardening

### Disable legacy authentication

```powershell
# Create authentication policy to block legacy auth
New-AuthenticationPolicy -Name "Block Legacy Auth" `
    -AllowBasicAuthActiveSync:$false `
    -AllowBasicAuthAutodiscover:$false `
    -AllowBasicAuthImap:$false `
    -AllowBasicAuthMapi:$false `
    -AllowBasicAuthOfflineAddressBook:$false `
    -AllowBasicAuthOutlookService:$false `
    -AllowBasicAuthPop:$false `
    -AllowBasicAuthReportingWebServices:$false `
    -AllowBasicAuthRest:$false `
    -AllowBasicAuthRpc:$false `
    -AllowBasicAuthSmtp:$false `
    -AllowBasicAuthWebServices:$false `
    -AllowBasicAuthPowershell:$false

# Set as org default
Set-OrganizationConfig -DefaultAuthenticationPolicy "Block Legacy Auth"
```

### Enable security defaults or Conditional Access

```powershell
# Option 1: Security defaults (small orgs without Entra ID P1)
# Enable in Entra ID portal > Properties > Security defaults

# Option 2: Conditional Access (orgs with Entra ID P1/P2)
# Create policies in Entra ID > Security > Conditional Access:
# - Require MFA for all users
# - Block legacy authentication
# - Require compliant devices for email access
# - Block access from risky sign-in locations
```

---

**Maintainers:** csa-inabox core team
**Last updated:** 2026-04-30
