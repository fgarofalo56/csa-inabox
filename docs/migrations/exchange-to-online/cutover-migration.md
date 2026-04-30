# Cutover Migration: Exchange to Exchange Online

**Status:** Authored 2026-04-30
**Audience:** Exchange administrators migrating organizations with fewer than 2,000 mailboxes using the cutover migration method.
**Scope:** Complete cutover migration from Exchange 2007+ to Exchange Online --- planning, execution, DNS changes, and post-migration validation.

---

## Overview

Cutover migration moves **all mailboxes** from on-premises Exchange to Exchange Online in a single operation. There is no coexistence period --- all mailboxes move at once, and DNS records (MX, Autodiscover) are updated to point to Exchange Online after the migration completes.

### When to use cutover migration

- Organization has **fewer than 2,000 mailboxes** (Microsoft's stated limit; practically, fewer than 500 is ideal).
- Exchange 2007, 2010, 2013, 2016, or 2019.
- No need for prolonged coexistence between on-prem and cloud.
- Small enough to migrate over a weekend or maintenance window.
- No complex public folder hierarchy (or public folders will be migrated separately).

### When NOT to use cutover migration

- More than 2,000 mailboxes (use [hybrid migration](hybrid-migration.md)).
- Need for gradual migration over weeks or months.
- Complex coexistence requirements (shared calendars, delegate access during migration).
- Exchange 2003 (use [staged migration](staged-migration.md)).

---

## Prerequisites

- [ ] Microsoft 365 tenant provisioned with Exchange Online licenses.
- [ ] DNS records documented (MX, Autodiscover, SPF, DKIM, DMARC).
- [ ] Exchange on-premises accessible from the internet (Outlook Anywhere / EWS endpoint).
- [ ] Admin credentials with Organization Management role on-premises.
- [ ] Microsoft 365 Global Administrator or Exchange Administrator credentials.
- [ ] All users have M365 licenses assigned.
- [ ] Outlook Anywhere (RPC over HTTP) enabled on Exchange 2007/2010, or EWS available on Exchange 2013+.
- [ ] Maintenance window scheduled (plan for 1--3 days depending on mailbox count and sizes).

---

## Planning

### Mailbox inventory

```powershell
# On-premises Exchange Management Shell
# Get mailbox count and sizes
Get-Mailbox -ResultSize Unlimited | Get-MailboxStatistics |
    Select-Object DisplayName, TotalItemSize, ItemCount |
    Sort-Object TotalItemSize -Descending |
    Export-Csv C:\Migration\mailbox-inventory.csv -NoTypeInformation

# Get total size
$stats = Get-Mailbox -ResultSize Unlimited | Get-MailboxStatistics
$totalGB = ($stats | ForEach-Object {
    [math]::Round(($_.TotalItemSize.ToString().Split("(")[1].Split(" ")[0] -replace ",","") / 1GB, 2)
} | Measure-Object -Sum).Sum
Write-Host "Total mailbox data: $totalGB GB"

# Identify large mailboxes (>10 GB) that will take longer
Get-Mailbox -ResultSize Unlimited | Get-MailboxStatistics |
    Where-Object {$_.TotalItemSize -gt 10GB} |
    Select-Object DisplayName, TotalItemSize
```

### Estimate migration time

| Mailbox data | Estimated time (50 Mbps connection) | Notes                   |
| ------------ | ----------------------------------- | ----------------------- |
| 1 GB         | ~5 minutes                          | Average mailbox         |
| 5 GB         | ~25 minutes                         | Power user              |
| 10 GB        | ~50 minutes                         | Heavy user              |
| 25 GB        | ~2 hours                            | Executive / long-tenure |
| 50 GB        | ~4 hours                            | Archive-heavy           |

**Concurrent migrations:** Default is 20 concurrent mailbox moves. With 100 mailboxes averaging 2 GB each, expect 3--5 hours for the initial sync.

### Communication plan

Notify users at least one week in advance:

1. **Pre-migration notice (T-7 days):** Email explaining the migration, expected timeline, and what users should expect.
2. **Reminder (T-1 day):** Confirm maintenance window; ask users to close Outlook and log out of OWA.
3. **Migration start (T-0):** Notify that migration is in progress; users may experience intermittent access.
4. **Migration complete:** Instructions for re-opening Outlook (will auto-reconfigure), testing mobile devices, and reporting issues.

---

## Execution

### Step 1: Create the migration endpoint

```powershell
# Connect to Exchange Online PowerShell
Connect-ExchangeOnline -UserPrincipalName admin@domain.com

# Create migration endpoint (Exchange 2013+, uses EWS)
New-MigrationEndpoint -ExchangeOutlookAnywhere `
    -Name "CutoverEndpoint" `
    -ExchangeServer mail.domain.com `
    -Credentials (Get-Credential) `
    -EmailAddress admin@domain.com

# For Exchange 2013+, use EWS endpoint:
New-MigrationEndpoint -ExchangeRemoteMove `
    -Name "CutoverEndpoint" `
    -RemoteServer mail.domain.com `
    -Credentials (Get-Credential)
```

### Step 2: Create the cutover migration batch

```powershell
# Create cutover migration batch
New-MigrationBatch -Name "CutoverBatch" `
    -SourceEndpoint "CutoverEndpoint" `
    -TargetDeliveryDomain "domain.mail.onmicrosoft.com" `
    -AutoStart

# Monitor initial sync
Get-MigrationBatch "CutoverBatch" | Format-List Status, TotalCount, SyncedCount, FailedCount
Get-MigrationUser | Format-Table Identity, Status, StatusDetail
```

### Step 3: Monitor progress

```powershell
# Check overall batch status
Get-MigrationBatch "CutoverBatch" |
    Select-Object Status, TotalCount, SyncedCount, FinalizedCount, FailedCount

# Check individual mailbox status
Get-MigrationUser -BatchId "CutoverBatch" |
    Select-Object Identity, Status, ErrorSummary |
    Format-Table -AutoSize

# Get detailed statistics for a specific user
Get-MigrationUserStatistics -Identity "user@domain.com" |
    Select-Object Identity, Status, EstimatedTotalTransferSize, BytesTransferred

# Check for failures
Get-MigrationUser -BatchId "CutoverBatch" -Status Failed |
    Format-Table Identity, ErrorSummary
```

### Step 4: Complete the migration batch

```powershell
# After all mailboxes are synced, complete the batch
# This performs the final delta sync and switches mailboxes to EXO
Complete-MigrationBatch -Identity "CutoverBatch"

# Monitor completion
Get-MigrationBatch "CutoverBatch" | Format-List Status, TotalCount, FinalizedCount
```

!!! warning "Completing the batch is irreversible"
Once `Complete-MigrationBatch` finishes, mailboxes are in Exchange Online. Users must connect to Exchange Online. Plan the completion for a maintenance window when you can also update DNS records.

### Step 5: Update DNS records

After the migration batch completes, update DNS records to point to Exchange Online:

```
# MX record (route mail to Exchange Online Protection)
@ MX 0 domain-com.mail.protection.outlook.com

# Autodiscover (CNAME to Exchange Online)
autodiscover CNAME autodiscover.outlook.com

# SPF (authorize Exchange Online to send on behalf of your domain)
@ TXT "v=spf1 include:spf.protection.outlook.com -all"

# DKIM (configure in Exchange admin center, then add DNS records)
selector1._domainkey CNAME selector1-domain-com._domainkey.domain.onmicrosoft.com
selector2._domainkey CNAME selector2-domain-com._domainkey.domain.onmicrosoft.com

# DMARC
_dmarc TXT "v=DMARC1; p=quarantine; rua=mailto:dmarc@domain.com; pct=100"
```

### Step 6: Post-migration validation

```powershell
# Verify mailboxes are in Exchange Online
Get-Mailbox -ResultSize Unlimited | Format-Table DisplayName, PrimarySmtpAddress, RecipientTypeDetails

# Verify mail flow (send test email from external)
# Check message trace
Get-MessageTrace -SenderAddress external@example.com -RecipientAddress user@domain.com -StartDate (Get-Date).AddHours(-1) -EndDate (Get-Date)

# Verify Autodiscover
# Run Outlook autoconfiguration test (Ctrl+Right-click Outlook icon > Test E-mail AutoConfiguration)

# Verify mobile device connectivity
Get-MobileDeviceStatistics -Mailbox user@domain.com | Format-Table DeviceType, DeviceOS, LastSuccessSync
```

---

## Post-migration tasks

### Outlook client reconfiguration

Outlook 2016+ automatically reconfigures via Autodiscover when it detects the mailbox has moved. Users may see:

1. A brief "Outlook is reconfiguring" notification.
2. A prompt to restart Outlook.
3. Cached mode re-synchronization (download of email from Exchange Online).

For Outlook 2013 and earlier, manual profile recreation may be required.

### Shared mailbox verification

```powershell
# Verify shared mailboxes migrated
Get-Mailbox -RecipientTypeDetails SharedMailbox |
    Format-Table DisplayName, PrimarySmtpAddress

# Verify permissions on shared mailboxes
Get-MailboxPermission -Identity "shared@domain.com" |
    Where-Object {$_.User -ne "NT AUTHORITY\SELF"} |
    Format-Table User, AccessRights
```

### Distribution group verification

```powershell
# Verify distribution groups
Get-DistributionGroup -ResultSize Unlimited |
    Format-Table DisplayName, PrimarySmtpAddress, GroupType

# Verify dynamic distribution groups
Get-DynamicDistributionGroup -ResultSize Unlimited |
    Format-Table DisplayName, RecipientFilter
```

### Decommission on-premises Exchange

After DNS cutover and validation period (2--4 weeks):

1. Remove Exchange Server from the domain.
2. Clean up Exchange DNS records (internal only).
3. Remove the migration batch: `Remove-MigrationBatch "CutoverBatch"`.
4. Remove the migration endpoint: `Remove-MigrationEndpoint "CutoverEndpoint"`.

!!! info "Keep Entra Connect"
If your organization uses Entra Connect for directory synchronization beyond Exchange, keep it running. Entra Connect manages identity sync independent of Exchange.

---

## Troubleshooting

| Issue                                           | Cause                                  | Resolution                                                    |
| ----------------------------------------------- | -------------------------------------- | ------------------------------------------------------------- |
| Migration batch fails to start                  | Endpoint connectivity issue            | Verify Outlook Anywhere / EWS is accessible from the internet |
| Individual mailbox fails                        | Corrupted items, oversized items       | Increase `BadItemLimit`: `Set-MigrationUser -BadItemLimit 50` |
| Slow migration speed                            | Network bandwidth, server load         | Schedule during off-hours; increase concurrent migrations     |
| Outlook prompts for credentials after migration | Autodiscover not updated               | Update Autodiscover CNAME; clear Outlook credential cache     |
| Mobile devices stop syncing                     | ActiveSync profile pointing to on-prem | Remove and re-add Exchange account on mobile device           |
| Mail flow stops after DNS cutover               | MX record TTL not propagated           | Reduce MX TTL to 300 before migration; wait for propagation   |

---

**Maintainers:** csa-inabox core team
**Last updated:** 2026-04-30
