# Tutorial: Gmail to Exchange Online Migration

**Status:** Authored 2026-04-30
**Audience:** M365 administrators performing hands-on Gmail to Exchange Online migration using the Google Workspace migration feature in Exchange Admin Center.
**Duration:** 2-4 hours for setup + migration time depending on mailbox sizes.

---

## Prerequisites

Before starting this tutorial, confirm:

- [ ] Microsoft 365 tenant is provisioned with Exchange Online.
- [ ] Domain is verified in M365 (contoso.com).
- [ ] All target users are created in Entra ID with Exchange Online licenses assigned.
- [ ] You have Google Workspace super admin access.
- [ ] You have M365 Global Administrator or Exchange Administrator role.

---

## Step 1: Create a Google Cloud project

### 1.1 Navigate to Google Cloud Console

Open [console.cloud.google.com](https://console.cloud.google.com) and sign in with your Google Workspace admin account.

### 1.2 Create a new project

1. Click the project dropdown in the top navigation bar.
2. Click **New Project**.
3. Name the project: `M365-Migration`.
4. Click **Create**.
5. Select the new project from the dropdown.

### 1.3 Enable required APIs

Navigate to **APIs & Services > Library** and enable:

1. **Gmail API** --- search "Gmail API" and click **Enable**.
2. **Google Calendar API** --- search "Google Calendar API" and click **Enable**.
3. **Contacts API** --- search "Contacts API" and click **Enable**.
4. **Google Workspace Admin SDK** --- search "Admin SDK API" and click **Enable**.

_Verification:_ Navigate to **APIs & Services > Dashboard**. All four APIs should show as "Enabled."

---

## Step 2: Create a service account with domain-wide delegation

### 2.1 Create the service account

1. Navigate to **IAM & Admin > Service Accounts**.
2. Click **Create Service Account**.
3. Name: `m365-migration`.
4. Description: `Service account for M365 email migration`.
5. Click **Create and Continue**.
6. Skip role assignment (no GCP roles needed).
7. Click **Done**.

### 2.2 Enable domain-wide delegation

1. Click on the newly created service account.
2. Click **Advanced settings** (or the Details tab).
3. Under **Domain-wide delegation**, click **Enable domain-wide delegation**.
4. Note the **Client ID** (a numeric string like `123456789012345678901`).

### 2.3 Create and download a JSON key

1. On the service account page, go to the **Keys** tab.
2. Click **Add Key > Create new key**.
3. Select **JSON** format.
4. Click **Create**.
5. Save the downloaded JSON file securely (e.g., `m365-migration-key.json`).

!!! warning "Security note"
The JSON key file provides full access to user mailboxes. Store it securely and delete it after migration is complete. Never commit it to source control.

---

## Step 3: Grant domain-wide delegation in Google Admin Console

### 3.1 Open Google Admin Console

Navigate to [admin.google.com](https://admin.google.com).

### 3.2 Configure API client access

1. Navigate to **Security > Access and data control > API controls**.
2. Click **Manage Domain Wide Delegation** (at the bottom of the page).
3. Click **Add new**.
4. **Client ID:** Paste the Client ID from Step 2.2.
5. **OAuth scopes:** Enter the following scopes (comma-separated, no spaces after commas):

```
https://mail.google.com/,https://www.googleapis.com/auth/calendar,https://www.googleapis.com/auth/contacts,https://www.googleapis.com/auth/admin.directory.user.readonly,https://www.googleapis.com/auth/gmail.readonly
```

6. Click **Authorize**.

_Verification:_ The service account should appear in the domain-wide delegation list with the scopes listed.

---

## Step 4: Configure the migration endpoint in Exchange Admin Center

### 4.1 Open Exchange Admin Center

Navigate to [admin.exchange.microsoft.com](https://admin.exchange.microsoft.com) or via the M365 Admin Center > Admin centers > Exchange.

### 4.2 Create migration endpoint

1. Navigate to **Migration** in the left navigation.
2. Click **Migration endpoints** tab.
3. Click **Add migration endpoint** (+ icon).
4. Select **Google Workspace** as the migration type.
5. Enter a name: `Google Workspace Endpoint`.
6. **Email address:** Enter a Google Workspace user email for connection testing (e.g., admin@contoso.com).
7. Upload the JSON key file from Step 2.3.
8. Click **Next**.
9. The system tests the connection. Verify it shows **Connected successfully**.
10. Click **Save**.

### Alternative: Create endpoint via PowerShell

```powershell
# Connect to Exchange Online
Connect-ExchangeOnline -UserPrincipalName admin@contoso.com

# Create the Google Workspace migration endpoint
$jsonContent = Get-Content "C:\migration\m365-migration-key.json" -Raw

New-MigrationEndpoint -Name "GoogleWorkspaceEndpoint" `
    -Gmail `
    -ServiceAccountKeyFileData ([System.Text.Encoding]::UTF8.GetBytes($jsonContent)) `
    -EmailAddress "admin@contoso.com"

# Verify the endpoint
Get-MigrationEndpoint -Identity "GoogleWorkspaceEndpoint" |
    Format-List Name, RemoteServer, ConnectionSettings
```

---

## Step 5: Prepare the migration CSV file

### 5.1 Create the CSV file

Create a CSV file listing the email addresses to migrate. The email address must match both the Google Workspace email and the M365 UPN (or primary SMTP address).

```csv
EmailAddress
user1@contoso.com
user2@contoso.com
user3@contoso.com
admin@contoso.com
```

Save as: `C:\migration\batch1-it-department.csv`

### 5.2 Validate user readiness

```powershell
# Verify all users in the CSV have Exchange Online mailboxes
$csvUsers = Import-Csv "C:\migration\batch1-it-department.csv"

foreach ($user in $csvUsers) {
    $mailbox = Get-Mailbox -Identity $user.EmailAddress -ErrorAction SilentlyContinue
    if ($mailbox) {
        Write-Host "READY: $($user.EmailAddress)" -ForegroundColor Green
    } else {
        Write-Host "NOT READY: $($user.EmailAddress) - No mailbox found" -ForegroundColor Red
    }
}
```

---

## Step 6: Create and start the migration batch

### 6.1 Via Exchange Admin Center

1. Navigate to **Migration** in EAC.
2. Click **Add migration batch** (+ icon).
3. Select **Migration to Exchange Online**.
4. Select **Google Workspace migration**.
5. **Batch name:** `Batch1-IT-Department`.
6. Select the migration endpoint: `Google Workspace Endpoint`.
7. Upload the CSV file: `batch1-it-department.csv`.
8. Configure target delivery domain: `contoso.mail.onmicrosoft.com`.
9. Click **Next**.
10. Configure start options:
    - Start automatically: Yes (recommended).
    - Complete automatically: **No** (recommended --- complete manually after validation).
11. Click **Save**.

### 6.2 Via PowerShell

```powershell
# Create the migration batch
New-MigrationBatch -Name "Batch1-IT-Department" `
    -SourceEndpoint "GoogleWorkspaceEndpoint" `
    -CSVData ([System.IO.File]::ReadAllBytes("C:\migration\batch1-it-department.csv")) `
    -TargetDeliveryDomain "contoso.mail.onmicrosoft.com" `
    -NotificationEmails "admin@contoso.com"

# Start the migration batch
Start-MigrationBatch -Identity "Batch1-IT-Department"
```

---

## Step 7: Monitor migration progress

### 7.1 Exchange Admin Center dashboard

The Migration dashboard shows:

- **Total mailboxes** in the batch.
- **Synced** --- mailboxes that have completed initial sync.
- **Syncing** --- mailboxes currently syncing.
- **Failed** --- mailboxes with errors.
- **Queued** --- mailboxes waiting to start.

### 7.2 PowerShell monitoring

```powershell
# Check batch status
Get-MigrationBatch -Identity "Batch1-IT-Department" |
    Format-List Status, TotalCount, SyncedCount, FinalizedCount, FailedCount

# Check individual user status
Get-MigrationUser -BatchId "Batch1-IT-Department" |
    Select-Object Identity, Status, ItemsSynced, ItemsSkipped, BytesSynced |
    Format-Table -AutoSize

# Check for failed users
Get-MigrationUser -BatchId "Batch1-IT-Department" -Status Failed |
    Select-Object Identity, Error |
    Format-List

# Get detailed statistics for a specific user
Get-MigrationUserStatistics -Identity "user1@contoso.com" |
    Format-List Status, EstimatedTotalTransferCount, TransferredItemCount,
    BytesTransferred, PercentageComplete
```

### 7.3 Expected timelines

| Mailbox size | Estimated sync time | Notes                                                           |
| ------------ | ------------------- | --------------------------------------------------------------- |
| < 1 GB       | 2-4 hours           | Quick; most users                                               |
| 1-5 GB       | 4-12 hours          | Average                                                         |
| 5-10 GB      | 12-24 hours         | Large mailbox                                                   |
| 10-50 GB     | 1-3 days            | Very large; may need throttle management                        |
| 50+ GB       | 3-7 days            | Executive mailboxes; contact Microsoft support for optimization |

---

## Step 8: Validate migration

### 8.1 Spot-check migrated mailboxes

```powershell
# Compare item counts
# Google Workspace: Check in Admin Console > Users > [user] > Account > Mailbox size
# Exchange Online:
Get-MailboxStatistics -Identity "user1@contoso.com" |
    Select-Object ItemCount, TotalItemSize
```

### 8.2 Functional validation checklist

Log in to Outlook (web or desktop) as a migrated user and verify:

- [ ] Recent emails are present in the Inbox.
- [ ] Sent emails are in Sent Items.
- [ ] Gmail labels are mapped to folders or categories.
- [ ] Calendar events are present and correct (dates, times, attendees).
- [ ] Recurring events show the correct pattern.
- [ ] Contacts are present in People.
- [ ] Attachments on emails are accessible.
- [ ] Email search returns expected results.

### 8.3 User acceptance testing

Have 3-5 migrated users perform their daily email workflow:

- [ ] Send and receive emails (internal and external).
- [ ] Reply and forward emails.
- [ ] Search for historical emails.
- [ ] Check calendar events and schedule new meetings.
- [ ] Look up contacts.
- [ ] Access shared mailboxes (if configured).

---

## Step 9: Complete the migration batch

After validation confirms the migration is successful:

### 9.1 Via Exchange Admin Center

1. Navigate to **Migration**.
2. Select the batch: `Batch1-IT-Department`.
3. Click **Complete migration batch**.
4. Confirm the action.

### 9.2 Via PowerShell

```powershell
# Complete the migration batch
Complete-MigrationBatch -Identity "Batch1-IT-Department"

# Verify completion
Get-MigrationBatch -Identity "Batch1-IT-Department" |
    Format-List Status, FinalizedCount
```

!!! warning "Completing the batch stops incremental sync"
After completing a migration batch, incremental sync stops. New emails sent to Gmail will NOT sync to Exchange Online. Only complete the batch when you are ready for DNS cutover or when the coexistence period has ended for these users.

---

## Step 10: Update DNS (MX records)

### 10.1 Pre-cutover: Reduce TTL

48 hours before MX cutover, reduce the MX record TTL to 300 seconds (5 minutes):

```
# At your DNS provider, change the MX record TTL
# From: 3600 (1 hour) or higher
# To: 300 (5 minutes)
```

### 10.2 Update MX records

Replace Google MX records with Microsoft 365 MX records at your DNS provider:

**Remove:**

| Priority | Record                  |
| -------- | ----------------------- |
| 1        | ASPMX.L.GOOGLE.COM      |
| 5        | ALT1.ASPMX.L.GOOGLE.COM |
| 5        | ALT2.ASPMX.L.GOOGLE.COM |
| 10       | ALT3.ASPMX.L.GOOGLE.COM |
| 10       | ALT4.ASPMX.L.GOOGLE.COM |

**Add:**

| Priority | Record                                  |
| -------- | --------------------------------------- |
| 0        | contoso-com.mail.protection.outlook.com |

### 10.3 Update SPF record

```
# Replace Google SPF with Microsoft SPF
# Old: v=spf1 include:_spf.google.com ~all
# New: v=spf1 include:spf.protection.outlook.com -all
```

### 10.4 Configure DKIM

```powershell
# Enable DKIM signing in Exchange Online
New-DkimSigningConfig -DomainName "contoso.com" -Enabled $true

# Get CNAME records to add to DNS
Get-DkimSigningConfig -Identity "contoso.com" |
    Format-List Selector1CNAME, Selector2CNAME
```

Add the CNAME records to your DNS:

| Record | Name                  | Value                                                     |
| ------ | --------------------- | --------------------------------------------------------- |
| CNAME  | selector1.\_domainkey | selector1-contoso-com.\_domainkey.contoso.onmicrosoft.com |
| CNAME  | selector2.\_domainkey | selector2-contoso-com.\_domainkey.contoso.onmicrosoft.com |

### 10.5 Configure DMARC

```
# Add DMARC TXT record
# Name: _dmarc
# Value: v=DMARC1; p=none; rua=mailto:dmarc-reports@contoso.com
# Start with p=none; move to p=quarantine then p=reject after validation
```

### 10.6 Verify DNS propagation

```powershell
# Verify MX record
Resolve-DnsName -Name "contoso.com" -Type MX

# Verify SPF
Resolve-DnsName -Name "contoso.com" -Type TXT | Where-Object { $_.Strings -like "*spf*" }

# Verify DKIM
Resolve-DnsName -Name "selector1._domainkey.contoso.com" -Type CNAME

# Verify DMARC
Resolve-DnsName -Name "_dmarc.contoso.com" -Type TXT
```

---

## Step 11: Post-migration tasks

### 11.1 Verify mail flow

Send test emails:

- [ ] Internal to internal (Outlook to Outlook).
- [ ] External to internal (Gmail/Yahoo to Outlook).
- [ ] Internal to external (Outlook to Gmail/Yahoo).

### 11.2 Configure Outlook clients

- Deploy Outlook desktop via Microsoft 365 Apps or Intune.
- Configure Outlook mobile via Intune MAM policies.
- Verify autodiscover works (profiles auto-configure).

### 11.3 Clean up

```powershell
# Remove migration batch (after confirming success)
Remove-MigrationBatch -Identity "Batch1-IT-Department" -Confirm:$false

# Remove migration endpoint (after all batches complete)
Remove-MigrationEndpoint -Identity "GoogleWorkspaceEndpoint" -Confirm:$false
```

### 11.4 Delete the service account key

Delete the Google Cloud service account JSON key file after migration is complete. This key provides full access to user mailboxes and should not be retained.

---

## Repeat for additional batches

For subsequent migration batches:

1. Create a new CSV file for the next department.
2. Create a new migration batch using the same endpoint.
3. Start, monitor, validate, and complete.
4. Repeat until all users are migrated.

### Recommended batch order

| Batch | Department            | Size          | Notes                                |
| ----- | --------------------- | ------------- | ------------------------------------ |
| 1     | IT                    | 20-50 users   | Pilot; highest technical capability  |
| 2     | Executive assistants  | 10-30 users   | Validate delegation and calendar     |
| 3     | Finance               | 50-200 users  | Test shared mailboxes and compliance |
| 4     | Engineering           | 100-500 users | Largest batch; test throughput       |
| 5     | Sales                 | 100-500 users | CRM integration validation           |
| 6     | Remaining departments | Varies        | Final batches                        |

---

## Troubleshooting reference

| Symptom                                      | Diagnostic                             | Resolution                                           |
| -------------------------------------------- | -------------------------------------- | ---------------------------------------------------- |
| "Authentication failed" on endpoint creation | Service account key invalid or expired | Re-download JSON key; verify domain-wide delegation  |
| "Access denied" for specific mailboxes       | OAuth scope missing                    | Add all required scopes to domain-wide delegation    |
| Migration stuck at "Queued"                  | Migration service throttled            | Wait; check service health at status.office365.com   |
| Items skipped > 10%                          | Corrupted items or unsupported types   | Export skipped item report; investigate individually |
| "Transient error" on items                   | Google API rate limiting               | Migration will auto-retry; wait for completion       |
| Mail flow not working after MX change        | DNS propagation delay                  | Wait 2-4 hours; verify with nslookup/dig             |
| SPF failures (external senders reject)       | Old SPF record still cached            | Wait for TTL expiration; verify SPF with MXToolbox   |
