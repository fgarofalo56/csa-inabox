# Tutorial: Mailbox Move to Exchange Online

**Status:** Authored 2026-04-30
**Audience:** Exchange administrators executing production mailbox migrations to Exchange Online.
**Time to complete:** 4--8 hours (depending on mailbox count and sizes)
**Prerequisites:** Hybrid Exchange configured (see [Tutorial: Hybrid Setup](tutorial-hybrid-setup.md)), pilot migration validated.

---

## What you will build

By the end of this tutorial, you will have:

1. Created production migration batches by department.
2. Moved mailboxes to Exchange Online with near-zero downtime.
3. Monitored migration progress and resolved failures.
4. Completed migration batches and validated user connectivity.
5. Updated DNS records (MX, Autodiscover, SPF, DKIM, DMARC).
6. Planned on-premises Exchange decommission.

---

## Step 1: Plan migration batches

### Batch strategy

| Batch             | Users                     | Schedule   | Notes                                 |
| ----------------- | ------------------------- | ---------- | ------------------------------------- |
| Pilot (completed) | 5--10 IT staff            | Week 1     | Validates hybrid; already done        |
| Wave 1            | 50--100 early adopters    | Week 2     | Power users who can report issues     |
| Wave 2            | Department A              | Week 3--4  | First full department                 |
| Wave 3            | Department B              | Week 5--6  | Second department                     |
| Wave 4            | VIPs and executives       | Week 7     | Separate wave for sensitive mailboxes |
| Wave 5            | Shared/resource mailboxes | Week 7--8  | Migrate with or after user mailboxes  |
| Wave 6            | Remaining users           | Week 8--10 | Final cleanup                         |

### Prepare CSV files

```powershell
# On-premises Exchange Management Shell
# Generate CSV for a department (e.g., Finance)
Get-Mailbox -Filter "Department -eq 'Finance'" |
    Select-Object @{N='EmailAddress';E={$_.PrimarySmtpAddress}} |
    Export-Csv C:\Migration\wave2-finance.csv -NoTypeInformation

# Generate CSV for a specific OU
Get-Mailbox -OrganizationalUnit "OU=Marketing,DC=domain,DC=com" |
    Select-Object @{N='EmailAddress';E={$_.PrimarySmtpAddress}} |
    Export-Csv C:\Migration\wave3-marketing.csv -NoTypeInformation

# Generate CSV for shared mailboxes
Get-Mailbox -RecipientTypeDetails SharedMailbox |
    Select-Object @{N='EmailAddress';E={$_.PrimarySmtpAddress}} |
    Export-Csv C:\Migration\wave5-shared.csv -NoTypeInformation

# Generate CSV for room/equipment mailboxes
Get-Mailbox -RecipientTypeDetails RoomMailbox, EquipmentMailbox |
    Select-Object @{N='EmailAddress';E={$_.PrimarySmtpAddress}} |
    Export-Csv C:\Migration\wave5-resources.csv -NoTypeInformation
```

---

## Step 2: Create migration batch

```powershell
# Connect to Exchange Online PowerShell
Connect-ExchangeOnline -UserPrincipalName admin@domain.com

# Create migration batch for Wave 2 (Finance)
New-MigrationBatch -Name "Wave2-Finance" `
    -SourceEndpoint "Hybrid Migration Endpoint - EWS (Default Web Site)" `
    -TargetDeliveryDomain "domain.mail.onmicrosoft.com" `
    -CSVData ([System.IO.File]::ReadAllBytes("C:\Migration\wave2-finance.csv")) `
    -NotificationEmails "exchangeadmin@domain.com" `
    -AutoStart

# The batch starts initial sync automatically (-AutoStart)
# Do NOT use -AutoComplete if you want to control completion timing
```

### Batch creation options

```powershell
# Option A: Auto-start, manual complete (recommended for production)
New-MigrationBatch -Name "Wave2-Finance" `
    -SourceEndpoint "Hybrid Migration Endpoint - EWS (Default Web Site)" `
    -TargetDeliveryDomain "domain.mail.onmicrosoft.com" `
    -CSVData ([System.IO.File]::ReadAllBytes("C:\Migration\wave2-finance.csv")) `
    -AutoStart `
    -NotificationEmails "exchangeadmin@domain.com"

# Option B: Auto-start and auto-complete (hands-off, for off-hours)
New-MigrationBatch -Name "Wave2-Finance" `
    -SourceEndpoint "Hybrid Migration Endpoint - EWS (Default Web Site)" `
    -TargetDeliveryDomain "domain.mail.onmicrosoft.com" `
    -CSVData ([System.IO.File]::ReadAllBytes("C:\Migration\wave2-finance.csv")) `
    -AutoStart -AutoComplete `
    -CompleteAfter "04/30/2026 11:00:00 PM" `
    -NotificationEmails "exchangeadmin@domain.com"

# Option C: Manual start and complete (full control)
New-MigrationBatch -Name "Wave2-Finance" `
    -SourceEndpoint "Hybrid Migration Endpoint - EWS (Default Web Site)" `
    -TargetDeliveryDomain "domain.mail.onmicrosoft.com" `
    -CSVData ([System.IO.File]::ReadAllBytes("C:\Migration\wave2-finance.csv"))

# Start manually when ready
Start-MigrationBatch -Identity "Wave2-Finance"
```

---

## Step 3: Monitor migration progress

### Batch-level monitoring

```powershell
# Check batch status
Get-MigrationBatch "Wave2-Finance" |
    Select-Object Identity, Status, TotalCount, SyncedCount, FinalizedCount, FailedCount

# Status meanings:
# Syncing      - Initial data copy in progress
# Synced       - Initial sync complete, waiting for completion
# Completing   - Final delta sync and switchover in progress
# Completed    - All mailboxes migrated successfully
# CompletedWithErrors - Some mailboxes failed

# Detailed batch statistics
Get-MigrationBatch "Wave2-Finance" | Format-List *
```

### User-level monitoring

```powershell
# List all users in batch with status
Get-MigrationUser -BatchId "Wave2-Finance" |
    Format-Table Identity, Status, StatusDetail -AutoSize

# Get detailed statistics for a specific user
Get-MigrationUserStatistics -Identity "user@domain.com" |
    Select-Object Identity, Status, EstimatedTotalTransferSize, BytesTransferred, PercentComplete, Error

# Get detailed move request report
Get-MoveRequest -Identity "user@domain.com" |
    Get-MoveRequestStatistics -IncludeReport |
    Select-Object DisplayName, StatusDetail, PercentComplete, TotalMailboxSize, BadItemsEncountered

# List failed users
Get-MigrationUser -BatchId "Wave2-Finance" -Status Failed |
    Select-Object Identity, ErrorSummary |
    Format-Table -AutoSize -Wrap
```

### Monitoring script (run periodically)

```powershell
# Monitoring script - run every 15 minutes
$batch = Get-MigrationBatch "Wave2-Finance"
$users = Get-MigrationUser -BatchId "Wave2-Finance"

Write-Host "=== Migration Batch Status ===" -ForegroundColor Cyan
Write-Host "Batch: $($batch.Identity)"
Write-Host "Status: $($batch.Status)"
Write-Host "Total: $($batch.TotalCount)"
Write-Host "Synced: $($batch.SyncedCount)"
Write-Host "Finalized: $($batch.FinalizedCount)"
Write-Host "Failed: $($batch.FailedCount)"
Write-Host ""

$syncing = ($users | Where-Object Status -eq "Syncing").Count
$synced = ($users | Where-Object Status -eq "Synced").Count
$completed = ($users | Where-Object Status -eq "Completed").Count
$failed = ($users | Where-Object Status -eq "Failed").Count

Write-Host "Syncing: $syncing | Synced: $synced | Completed: $completed | Failed: $failed"

if ($failed -gt 0) {
    Write-Host "`nFailed users:" -ForegroundColor Red
    Get-MigrationUser -BatchId "Wave2-Finance" -Status Failed |
        Format-Table Identity, ErrorSummary -AutoSize -Wrap
}
```

---

## Step 4: Handle failures

### Common failure scenarios

```powershell
# Scenario 1: Bad items (corrupted items that cannot be migrated)
# Increase the bad item limit
Set-MigrationUser -Identity "user@domain.com" -BadItemLimit 100

# Resume the failed migration
Set-MoveRequest -Identity "user@domain.com" -BadItemLimit 100 -AcceptLargeDataLoss

# Scenario 2: Large item limit exceeded
Set-MoveRequest -Identity "user@domain.com" -LargeItemLimit 100 -AcceptLargeDataLoss

# Scenario 3: Target mailbox already exists
# Check if a cloud mailbox already exists
Get-Mailbox -Identity "user@domain.com" | Format-List RecipientTypeDetails

# Scenario 4: Migration stalled
# Remove and recreate the move request
Remove-MoveRequest -Identity "user@domain.com" -Confirm:$false
# Re-add user to a new batch or individual move request

# Scenario 5: Connectivity issue
# Test migration endpoint
Test-MigrationServerAvailability -ExchangeRemoteMove `
    -RemoteServer mail.domain.com `
    -Credentials (Get-Credential)
```

### Remove and retry failed users

```powershell
# Get list of failed users
$failedUsers = Get-MigrationUser -BatchId "Wave2-Finance" -Status Failed

# Export failed users for investigation
$failedUsers | Select-Object Identity, ErrorSummary |
    Export-Csv C:\Migration\wave2-failures.csv -NoTypeInformation

# Remove failed users from batch
foreach ($user in $failedUsers) {
    Remove-MoveRequest -Identity $user.Identity -Confirm:$false
}

# Create a retry batch with increased limits
New-MigrationBatch -Name "Wave2-Finance-Retry" `
    -SourceEndpoint "Hybrid Migration Endpoint - EWS (Default Web Site)" `
    -TargetDeliveryDomain "domain.mail.onmicrosoft.com" `
    -CSVData ([System.IO.File]::ReadAllBytes("C:\Migration\wave2-failures.csv")) `
    -BadItemLimit 100 `
    -LargeItemLimit 100 `
    -AutoStart
```

---

## Step 5: Complete the migration batch

```powershell
# Verify all users are synced (Status: Synced)
Get-MigrationBatch "Wave2-Finance" | Format-List Status, SyncedCount, TotalCount

# Complete the batch (performs final delta sync and switchover)
Complete-MigrationBatch -Identity "Wave2-Finance"

# Monitor completion progress
Get-MigrationBatch "Wave2-Finance" | Format-List Status, FinalizedCount

# Wait for status to change to "Completed"
# Users will experience a brief Outlook reconnection (< 30 seconds)
```

!!! info "Completion timing"
Complete batches during off-hours or low-usage periods. The completion step performs a final delta sync (catching up any changes since the initial sync) and then switches the mailbox to Exchange Online. Users experience a brief Outlook restart --- typically under 30 seconds.

---

## Step 6: Post-batch validation

```powershell
# Verify migrated mailboxes
Get-MigrationBatch "Wave2-Finance" | Format-List Status, TotalCount, FinalizedCount

# Verify individual mailbox location
Get-Mailbox -Identity "user@domain.com" | Select-Object PrimarySmtpAddress, RecipientTypeDetails, Database

# Test mail flow
Send-MailMessage -To "user@domain.com" -From "admin@domain.com" `
    -Subject "Post-migration test" -Body "This is a test." `
    -SmtpServer "domain-com.mail.protection.outlook.com"

# Check message trace
Get-MessageTrace -RecipientAddress "user@domain.com" `
    -StartDate (Get-Date).AddHours(-1) -EndDate (Get-Date) |
    Format-Table Received, SenderAddress, Subject, Status

# Verify mobile devices reconnected
Get-MobileDeviceStatistics -Mailbox "user@domain.com" |
    Format-Table DeviceType, DeviceOS, LastSuccessSync
```

---

## Step 7: Update DNS records

After all mailboxes are migrated (or when using decentralized routing, after enough mailboxes justify the switch):

### MX record

```
# Point MX to Exchange Online Protection
# Before: @ MX 10 mail.domain.com
# After:
@ MX 0 domain-com.mail.protection.outlook.com
```

### Autodiscover

```
# Point Autodiscover to Exchange Online
autodiscover CNAME autodiscover.outlook.com
```

### SPF

```
# Update SPF to authorize Exchange Online
@ TXT "v=spf1 include:spf.protection.outlook.com -all"

# If on-prem still sends mail during transition:
@ TXT "v=spf1 ip4:203.0.113.10 include:spf.protection.outlook.com -all"
```

### DKIM

```powershell
# Enable DKIM in Exchange Online
New-DkimSigningConfig -DomainName "domain.com" -Enabled $true
Get-DkimSigningConfig -Identity "domain.com" | Format-List Selector1CNAME, Selector2CNAME

# Add DNS records returned by the cmdlet above
```

### DMARC

```
# Deploy DMARC (start with monitoring)
_dmarc TXT "v=DMARC1; p=none; rua=mailto:dmarc@domain.com; pct=100"
```

!!! tip "DNS TTL strategy"
Reduce MX and Autodiscover TTL to 300 seconds (5 minutes) at least 48 hours before DNS cutover. After cutover, monitor for 48 hours, then restore TTL to 3600 seconds (1 hour).

---

## Step 8: Plan decommission

### Immediate post-migration

1. Verify all mail flows through Exchange Online for 2--4 weeks.
2. Monitor message traces for any mail still hitting on-premises.
3. Identify any applications still using on-premises SMTP relay.

### Decommission steps

```powershell
# Step 1: Remove migration batches
Get-MigrationBatch | Remove-MigrationBatch -Confirm:$false

# Step 2: Remove hybrid configuration (optional)
# Only if fully decommissioning Exchange on-prem
# WARNING: Keep one Exchange server for recipient management unless
# you have moved to cloud-only management

# Step 3: Uninstall Exchange Server
# Run Exchange Setup /mode:Uninstall on each server
# Start with Mailbox servers, then Edge Transport

# Step 4: Clean up AD
# Exchange schema extensions remain (harmless)
# Remove Exchange-related DNS records (internal)
# Remove Exchange SCP records from AD
```

### What to keep

| Component                        | Keep?                   | Why                                           |
| -------------------------------- | ----------------------- | --------------------------------------------- |
| Entra Connect                    | Yes                     | Directory synchronization for hybrid identity |
| One Exchange server (2019 or SE) | Recommended             | Recipient management, SMTP relay for apps     |
| Exchange schema in AD            | Cannot remove           | Harmless; part of AD schema                   |
| SSL certificates                 | No (if decommissioning) | Remove from load balancer and servers         |
| Load balancer VIPs               | No (if decommissioning) | Remove after DNS cutover confirmed            |

---

## Migration batch quick reference

```powershell
# === Quick reference: migration batch lifecycle ===

# Create batch
New-MigrationBatch -Name "BatchName" `
    -SourceEndpoint "Hybrid Migration Endpoint - EWS (Default Web Site)" `
    -TargetDeliveryDomain "domain.mail.onmicrosoft.com" `
    -CSVData ([System.IO.File]::ReadAllBytes("path\to\users.csv")) `
    -AutoStart

# Check status
Get-MigrationBatch "BatchName" | FL Status, TotalCount, SyncedCount, FailedCount

# Check users
Get-MigrationUser -BatchId "BatchName" | FT Identity, Status

# Complete batch
Complete-MigrationBatch "BatchName"

# Remove batch (after completion)
Remove-MigrationBatch "BatchName"
```

---

**Maintainers:** csa-inabox core team
**Last updated:** 2026-04-30
