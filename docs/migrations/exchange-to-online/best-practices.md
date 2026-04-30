# Exchange-to-Online Migration Best Practices

**Status:** Authored 2026-04-30
**Audience:** Migration leads, Exchange administrators, solution architects, and program managers planning or executing an Exchange Online migration.
**Scope:** Covers the organizational, technical, and operational practices that distinguish successful migrations from failed ones.

---

## Overview

Migrating Exchange on-premises to Exchange Online is a 4--20 week program depending on organization size and complexity. The technical steps are documented in the companion guides and tutorials. This document covers the practices that make or break the migration: pilot planning, DNS cutover strategy, user communication, Outlook profile management, distribution group migration, and CSA-in-a-Box Purview integration for email governance.

---

## 1. Pilot migration best practices

### Pilot user selection

Select 10--50 pilot users who represent the full range of your user population:

| Category                      | Include    | Why                                   |
| ----------------------------- | ---------- | ------------------------------------- |
| IT staff                      | 3--5 users | Can troubleshoot issues independently |
| Power users (large mailboxes) | 3--5 users | Tests migration of 10+ GB mailboxes   |
| Mobile-heavy users            | 3--5 users | Tests ActiveSync, Outlook Mobile      |
| Delegates and executives      | 2--3 pairs | Tests cross-premises delegate access  |
| Shared mailbox owners         | 2--3 users | Tests shared mailbox migration        |
| Remote/VPN users              | 2--3 users | Tests connectivity outside the office |
| Mac users                     | 1--2 users | Tests Outlook for Mac                 |
| Third-party app users         | 1--2 users | Tests EWS/Graph API integration       |

### Pilot success criteria

- [ ] Outlook auto-reconfigures without manual intervention.
- [ ] Email send/receive works (internal, external, distribution groups).
- [ ] Calendar shows correctly (own calendar, shared calendars, room bookings).
- [ ] Free/busy sharing works with on-premises users.
- [ ] Mobile devices reconnect within 24 hours.
- [ ] Outlook on the web (outlook.office365.com) accessible.
- [ ] Search returns results (local cache and server-side).
- [ ] Offline mode functions correctly.
- [ ] Delegate access works across premises.
- [ ] No user-reported issues after 5 business days.

### Pilot feedback collection

Send a structured survey after 3 and 7 days:

1. **Email delivery:** Are you receiving and sending email normally?
2. **Calendar:** Can you see your calendar and shared calendars?
3. **Outlook performance:** Is Outlook as fast as before the migration?
4. **Mobile devices:** Is your phone receiving email?
5. **Search:** Can you find old emails?
6. **Issues:** Describe any problems.

---

## 2. DNS cutover planning

### Pre-cutover DNS preparation

```
# 48 hours before DNS cutover:
# Reduce TTL on MX, Autodiscover, and SPF records

# MX record: reduce TTL from 3600 to 300
@ MX 0 mail.domain.com  TTL 300

# Autodiscover CNAME: reduce TTL from 3600 to 300
autodiscover CNAME mail.domain.com  TTL 300

# SPF: reduce TTL from 3600 to 300
@ TXT "v=spf1 ip4:203.0.113.10 include:spf.protection.outlook.com -all"  TTL 300
```

### Cutover sequence

Execute DNS changes in this order during the maintenance window:

1. **MX record** --- Point to Exchange Online Protection.
2. **Autodiscover** --- Point to Exchange Online.
3. **SPF** --- Remove on-premises IP; keep `include:spf.protection.outlook.com`.
4. **DKIM** --- Enable DKIM signing and add CNAME records.
5. **DMARC** --- Deploy `p=none` (monitoring mode).

```
# Post-cutover DNS records

# MX
@ MX 0 domain-com.mail.protection.outlook.com  TTL 300

# Autodiscover
autodiscover CNAME autodiscover.outlook.com  TTL 300

# SPF
@ TXT "v=spf1 include:spf.protection.outlook.com -all"  TTL 300

# DKIM
selector1._domainkey CNAME selector1-domain-com._domainkey.domain.onmicrosoft.com
selector2._domainkey CNAME selector2-domain-com._domainkey.domain.onmicrosoft.com

# DMARC (monitoring mode first)
_dmarc TXT "v=DMARC1; p=none; rua=mailto:dmarc@domain.com; pct=100"
```

### Post-cutover monitoring

```powershell
# Monitor mail flow after DNS cutover
# Run every 30 minutes for the first 24 hours

# Check message trace for delivery issues
Get-MessageTrace -StartDate (Get-Date).AddHours(-1) -EndDate (Get-Date) |
    Where-Object {$_.Status -ne "Delivered"} |
    Format-Table Received, SenderAddress, RecipientAddress, Subject, Status

# Check for NDRs (non-delivery reports)
Get-MessageTrace -StartDate (Get-Date).AddHours(-1) -EndDate (Get-Date) |
    Where-Object {$_.Status -eq "Failed"} |
    Format-Table SenderAddress, RecipientAddress, Subject

# Verify MX resolution
Resolve-DnsName -Name domain.com -Type MX
# Expected: domain-com.mail.protection.outlook.com

# Verify Autodiscover
Resolve-DnsName -Name autodiscover.domain.com -Type CNAME
# Expected: autodiscover.outlook.com
```

### Rollback plan

If critical issues arise after DNS cutover:

1. **Revert MX** to on-premises Exchange (if servers are still running).
2. **Revert Autodiscover** to on-premises endpoint.
3. **Revert SPF** to include on-premises IP.
4. **Investigate** the issue before re-attempting cutover.

!!! warning "DNS cutover is not easily reversible after decommission"
DNS cutover can be reversed only if on-premises Exchange servers are still running and accepting mail. Once Exchange servers are decommissioned, rollback is not possible. Plan a 2--4 week validation period between DNS cutover and server decommission.

---

## 3. User communication templates

### Pre-migration announcement (T-7 days)

```
Subject: Email Migration to Microsoft 365 - Action Required

Dear [Department/All Staff],

On [date], your email will be migrated to Microsoft 365 Exchange Online.
This migration improves email security, reliability, and gives you access
to new features including Copilot for Outlook and enhanced mobile access.

What to expect:
- The migration happens in the background while you work.
- You may experience a brief Outlook restart (< 30 seconds) when the
  migration completes.
- Your email, calendar, contacts, and folders will all transfer.
- No action is required from you before the migration.

After migration:
- Outlook will reconnect automatically.
- Your mobile device may require you to re-enter your password.
- Access Outlook on the web at https://outlook.office365.com.

Questions? Contact the IT Help Desk at [phone/email].
```

### Migration day notification (T-0)

```
Subject: Email Migration In Progress

Your email migration to Microsoft 365 is now in progress.
You can continue working normally during the migration.

When your migration completes, Outlook will briefly restart.
This is normal and should take less than 30 seconds.

If you experience any issues, contact IT Help Desk: [phone/email].
```

### Post-migration confirmation (T+1)

```
Subject: Email Migration Complete - Welcome to Microsoft 365

Your email migration is complete. You are now using Microsoft 365
Exchange Online.

New features available to you:
- Outlook on the web: https://outlook.office365.com
- Enhanced mobile email (download Outlook mobile app)
- Larger attachments (up to 150 MB)
- Improved search

If your mobile device is not receiving email:
1. Open Settings > Mail (or Accounts).
2. Remove your work email account.
3. Re-add it using your email address and password.

Questions? Contact IT Help Desk: [phone/email].
```

---

## 4. Outlook profile management

### Automatic profile update (hybrid migration)

In hybrid migration, Outlook profiles update automatically when a mailbox moves to Exchange Online:

1. Outlook detects the mailbox location change via Autodiscover.
2. Outlook prompts the user to restart.
3. After restart, Outlook connects to Exchange Online.
4. Cached Exchange Mode re-synchronizes the local OST file.

### Manual profile creation (if auto-update fails)

```
# If Outlook fails to auto-reconfigure:

# Option 1: Reset Outlook profile
1. Close Outlook.
2. Open Control Panel > Mail > Show Profiles.
3. Remove the existing profile.
4. Create a new profile with the user's email address.
5. Outlook auto-configures via Autodiscover.

# Option 2: Clear Autodiscover cache
1. Close Outlook.
2. Delete: %LOCALAPPDATA%\Microsoft\Outlook\*.xml (Autodiscover cache)
3. Restart Outlook.

# Option 3: Force Autodiscover to Exchange Online
# Registry key (troubleshooting only):
# HKCU\Software\Microsoft\Office\16.0\Outlook\AutoDiscover
# ExcludeScpLookup = 1 (DWORD)
# ExcludeHttpsRootDomain = 1 (DWORD)
```

### Cached Exchange Mode settings

```powershell
# Configure via Group Policy or Intune:
# Cached Exchange Mode: Enabled
# Sync slider: 12 months (default) or 3 months (for mailboxes > 10 GB)
# Download shared folders: Off (reduces sync time)
# Download public folders: Off
```

---

## 5. Distribution group migration

Distribution groups synchronize via Entra Connect and typically require no migration action. However, review and clean up groups before and after migration:

### Pre-migration cleanup

```powershell
# Identify empty distribution groups
Get-DistributionGroup -ResultSize Unlimited |
    Where-Object {(Get-DistributionGroupMember -Identity $_.Identity).Count -eq 0} |
    Format-Table DisplayName, PrimarySmtpAddress

# Identify groups with no owner
Get-DistributionGroup -ResultSize Unlimited |
    Where-Object {$_.ManagedBy.Count -eq 0} |
    Format-Table DisplayName, PrimarySmtpAddress

# Identify groups not used in 90 days (requires message tracking)
# Run message tracking analysis for each group address
```

### Post-migration: consider M365 Groups

Convert distribution groups to M365 Groups where appropriate:

```powershell
# Upgrade eligible distribution groups to M365 Groups
# Check eligibility
Get-DistributionGroup -ResultSize Unlimited |
    Where-Object {$_.RecipientTypeDetails -eq "MailUniversalDistributionGroup"} |
    ForEach-Object {
        $eligible = Get-EligibleDistributionGroupForMigration -Identity $_.Identity
        [PSCustomObject]@{
            Name = $_.DisplayName
            Eligible = ($eligible -ne $null)
        }
    } | Format-Table

# Upgrade a specific group
Upgrade-DistributionGroup -DlIdentities "marketing@domain.com"
```

### Dynamic distribution groups

Dynamic distribution groups require special attention:

```powershell
# Export dynamic distribution group filters
Get-DynamicDistributionGroup -ResultSize Unlimited |
    Select-Object DisplayName, PrimarySmtpAddress, RecipientFilter |
    Export-Csv C:\Migration\dynamic-dgs.csv -NoTypeInformation

# Verify filters work with cloud attributes
# Some filters may reference on-premises AD attributes not synced to Entra ID
Get-DynamicDistributionGroup -Identity "allusers@domain.com" |
    Format-List RecipientFilter

# Preview membership (validate filter returns correct users)
$ddg = Get-DynamicDistributionGroup "allusers@domain.com"
Get-Recipient -RecipientPreviewFilter $ddg.RecipientFilter -ResultSize 10 |
    Format-Table DisplayName
```

---

## 6. CSA-in-a-Box Purview integration for email governance

### Unified compliance across email and data platform

After migrating to Exchange Online, integrate email compliance with CSA-in-a-Box Purview governance:

#### Step 1: Extend sensitivity labels to data assets

```powershell
# Sensitivity labels created for email (e.g., "Confidential", "Internal Only")
# extend to SharePoint, OneDrive, and data lake assets

# Verify label policies include all workloads
Connect-IPPSSession -UserPrincipalName admin@domain.com
Get-LabelPolicy | Format-List Name, ExchangeLocation, SharePointLocation, OneDriveLocation
```

#### Step 2: Configure DLP across email and data platform

```powershell
# Single DLP policy covers email AND data platform content
New-DlpCompliancePolicy -Name "PII-Protection-AllWorkloads" `
    -ExchangeLocation "All" `
    -SharePointLocation "All" `
    -OneDriveLocation "All" `
    -Mode Enable

# Same DLP rule detects PII in email and in data lake files
New-DlpComplianceRule -Policy "PII-Protection-AllWorkloads" `
    -Name "Detect-SSN-AllWorkloads" `
    -ContentContainsSensitiveInformation @{Name="U.S. Social Security Number (SSN)"; minCount="1"} `
    -NotifyUser "SiteAdmin" `
    -GenerateIncidentReport "SiteAdmin"
```

#### Step 3: Email audit logs to CSA-in-a-Box analytics

```powershell
# Export Exchange Online audit logs to Azure Monitor
# Configure in Microsoft 365 compliance portal:
# 1. Audit > Audit log search > Enable (if not already)
# 2. Configure audit log retention (E5: up to 10 years)

# For CSA-in-a-Box integration:
# - Route audit logs to Azure Event Hubs via Diagnostic Settings
# - Ingest into CSA-in-a-Box analytics estate (ADLS Gen2 / Delta Lake)
# - Build Power BI dashboards for email compliance monitoring
```

#### Step 4: Purview Data Map for email content

CSA-in-a-Box Purview automation (`csa_platform/csa_platform/governance/purview/`) can be extended to catalog email compliance metadata alongside data asset metadata:

- **Sensitivity label coverage:** Track which mailboxes have labels applied vs. unlabeled.
- **DLP match analytics:** Monitor DLP policy matches across email and data lake.
- **Retention compliance:** Verify retention policies are enforced across all workloads.
- **eDiscovery readiness:** Ensure cross-workload search covers email + data platform.

---

## 7. Migration anti-patterns

### What NOT to do

| Anti-pattern                          | Why it fails                                          | Better approach                                                |
| ------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------- |
| Big-bang cutover for 5,000+ mailboxes | Too much risk; too many users affected simultaneously | Hybrid migration with batches of 200--500                      |
| Migrating without pilot               | Issues discovered at scale are harder to fix          | Pilot with 10--50 users for 1 week minimum                     |
| DNS cutover before all mailboxes move | Mixed routing creates mail flow complexity            | Complete all mailbox moves, then DNS cutover                   |
| Skipping compliance migration         | Retention policies, DLP, holds not enforced           | Migrate compliance policies before or during mailbox migration |
| Ignoring third-party integrations     | Apps break when SMTP relay disappears                 | Inventory all apps; reconfigure for EXO relay                  |
| Not communicating to users            | Help desk flooded with "is my email broken?" calls    | Communicate 7 days before, day of, and day after               |
| Migrating public folders last         | Users lose access to shared content during transition | Use hybrid PF coexistence during migration                     |
| Ignoring Outlook version requirements | Old Outlook cannot connect to EXO with modern auth    | Upgrade Outlook to 2016+ before migration                      |
| Not testing mobile devices            | ActiveSync breaks for some devices                    | Include mobile users in pilot; document re-add steps           |
| Decommissioning on-prem too fast      | No rollback if issues arise                           | Wait 2--4 weeks after DNS cutover before decommission          |

---

## 8. Post-migration optimization

### Week 1: Stabilization

- [ ] Monitor message trace for delivery failures.
- [ ] Monitor help desk tickets for user-reported issues.
- [ ] Verify all shared mailboxes, room mailboxes, and resource mailboxes.
- [ ] Verify all distribution groups and dynamic distribution groups.
- [ ] Verify mobile device connectivity.

### Week 2--4: Optimization

- [ ] Enable DKIM signing.
- [ ] Progress DMARC from `p=none` to `p=quarantine`.
- [ ] Review and optimize EOP anti-spam settings.
- [ ] Configure Defender for Office 365 (Safe Attachments, Safe Links, Anti-phishing).
- [ ] Disable legacy authentication.
- [ ] Configure Conditional Access policies.

### Month 2--3: Modernization

- [ ] Migrate MRM retention to Purview retention policies.
- [ ] Migrate transport rule DLP to Purview DLP.
- [ ] Configure communication compliance (if required).
- [ ] Deploy sensitivity labels.
- [ ] Evaluate M365 Groups / Teams for distribution group modernization.
- [ ] Configure CSA-in-a-Box Purview integration.

### Month 3--6: Decommission

- [ ] Progress DMARC to `p=reject`.
- [ ] Decommission third-party anti-spam gateway (if replaced by EOP).
- [ ] Decommission on-premises Exchange servers (keep one for hybrid management if needed).
- [ ] Remove Exchange-specific firewall rules.
- [ ] Archive Exchange infrastructure documentation.
- [ ] Update ATO/SSP documentation (for federal organizations).

---

## 9. Key reference documentation

| Resource                            | URL                                                                                                                                                                    |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exchange Online migration methods   | [Microsoft Learn](https://learn.microsoft.com/exchange/mailbox-migration/mailbox-migration)                                                                            |
| Hybrid Configuration Wizard         | [Microsoft Learn](https://learn.microsoft.com/exchange/hybrid-deployment/hybrid-configuration-wizard)                                                                  |
| FastTrack for Microsoft 365         | [FastTrack portal](https://www.microsoft.com/fasttrack/microsoft-365)                                                                                                  |
| Exchange Online service description | [Microsoft Learn](https://learn.microsoft.com/office365/servicedescriptions/exchange-online-service-description/exchange-online-service-description)                   |
| Exchange Online limits              | [Microsoft Learn](https://learn.microsoft.com/office365/servicedescriptions/exchange-online-service-description/exchange-online-limits)                                |
| Microsoft 365 Government            | [Microsoft Learn](https://learn.microsoft.com/office365/servicedescriptions/office-365-platform-service-description/office-365-us-government/office-365-us-government) |
| Exchange Online PowerShell          | [Microsoft Learn](https://learn.microsoft.com/powershell/exchange/connect-to-exchange-online-powershell)                                                               |
| Microsoft Purview compliance        | [Microsoft Learn](https://learn.microsoft.com/purview/purview)                                                                                                         |
| CSA-in-a-Box Purview modules        | `csa_platform/csa_platform/governance/purview/`                                                                                                                        |
| CSA-in-a-Box compliance matrices    | `docs/compliance/nist-800-53-rev5.md`, `docs/compliance/cmmc-2.0-l2.md`                                                                                                |

---

**Maintainers:** csa-inabox core team
**Last updated:** 2026-04-30
