# Email Migration: Gmail to Exchange Online

**Status:** Authored 2026-04-30
**Audience:** M365 administrators, migration engineers, and IT leads executing Gmail to Exchange Online migration.
**Scope:** All email migration methods, label mapping, filter conversion, delegation, and DNS cutover for Gmail to Exchange Online.

---

## Overview

Gmail to Exchange Online migration is the highest-visibility workload in a Google Workspace to M365 migration. Users interact with email dozens of times daily, and any disruption is immediately noticed. Microsoft provides multiple migration methods, with the Google Workspace migration feature in Exchange Admin Center (EAC) being the recommended approach for full-fidelity migration of email, calendar, and contacts.

**FastTrack recommendation:** For organizations with 150+ seats, engage Microsoft FastTrack before starting. FastTrack engineers will configure and execute the migration at no additional cost. The information below is for organizations running migration independently or supplementing FastTrack.

---

## Migration method selection

### Decision matrix

| Method                               | Use when                                   | Migrates                           | Throughput          | Cost                         |
| ------------------------------------ | ------------------------------------------ | ---------------------------------- | ------------------- | ---------------------------- |
| **Google Workspace migration (EAC)** | Full migration with calendar + contacts    | Email, calendar, contacts          | 2-10 GB/mailbox/day | Free (built into EAC)        |
| **IMAP migration**                   | Email-only migration or legacy Google Apps | Email only (no calendar, contacts) | 1-5 GB/mailbox/day  | Free (built into EAC)        |
| **FastTrack**                        | 150+ seats, qualifying licenses            | Email, calendar, contacts, Drive   | Microsoft-managed   | Free (included with license) |
| **BitTitan MigrationWiz**            | Complex scenarios, fine-grained scheduling | Email, calendar, contacts          | 5-15 GB/mailbox/day | $12-15/mailbox               |
| **Quest On Demand Migration**        | Enterprise with Quest ecosystem            | Email, calendar, contacts          | Variable            | Enterprise licensing         |
| **AvePoint FLY**                     | Large-scale with advanced reporting        | Email, calendar, contacts          | Variable            | Enterprise licensing         |

### Recommendation

For most organizations, the **Google Workspace migration in EAC** is the right choice. It is free, supports email + calendar + contacts, provides incremental sync, and is supported by Microsoft. Third-party tools add value for:

- Organizations needing fine-grained scheduling (migrate by department on specific dates).
- Environments with complex delegation and shared mailbox configurations.
- Migrations requiring detailed per-item error reporting.

---

## Pre-migration preparation

### 1. Google Workspace configuration

Before migration can begin, configure Google Workspace to allow M365 to access mailbox data.

#### Create a Google Cloud project and enable APIs

1. Navigate to [Google Cloud Console](https://console.cloud.google.com).
2. Create a new project (e.g., "M365 Migration").
3. Enable the following APIs:
    - Gmail API
    - Google Calendar API
    - Contacts API
    - Google Workspace Admin SDK
4. Create a service account with domain-wide delegation.
5. Download the service account JSON key file.

#### Grant domain-wide delegation

In Google Workspace Admin Console:

1. Navigate to **Security > API Controls > Domain-wide Delegation**.
2. Add the service account client ID.
3. Grant the following OAuth scopes:

```
https://mail.google.com/
https://www.googleapis.com/auth/calendar
https://www.googleapis.com/auth/contacts
https://www.googleapis.com/auth/admin.directory.user.readonly
https://www.googleapis.com/auth/gmail.readonly
```

### 2. Microsoft 365 preparation

#### Verify domain in M365

```powershell
# Connect to Exchange Online
Connect-ExchangeOnline -UserPrincipalName admin@contoso.com

# Verify domain is added and verified
Get-AcceptedDomain | Format-Table DomainName, DomainType, Default
```

#### Create user accounts

Provision all users in Entra ID before starting migration. Users must have Exchange Online licenses assigned.

```powershell
# Connect to Microsoft Graph
Connect-MgGraph -Scopes "User.ReadWrite.All"

# Verify users have Exchange Online licenses
Get-MgUser -All | Select-Object DisplayName, UserPrincipalName, AssignedLicenses |
    Format-Table -AutoSize
```

#### Configure migration endpoint

In Exchange Admin Center:

1. Navigate to **Migration > Migration endpoints**.
2. Click **New migration endpoint**.
3. Select **Google Workspace**.
4. Provide the service account email and JSON key file.
5. Test the endpoint connection.

---

## Gmail label mapping strategy

Gmail labels are conceptually different from Outlook folders. Gmail allows multiple labels on a single message (like tags); Outlook uses a folder hierarchy where each message lives in exactly one folder.

### Mapping rules

| Gmail label type                   | Outlook mapping             | Notes                                                               |
| ---------------------------------- | --------------------------- | ------------------------------------------------------------------- |
| **Inbox**                          | Inbox folder                | Direct mapping                                                      |
| **Sent Mail**                      | Sent Items folder           | Direct mapping                                                      |
| **Drafts**                         | Drafts folder               | Direct mapping                                                      |
| **Starred**                        | Flagged (follow-up flag)    | Stars become flags                                                  |
| **Important**                      | No direct equivalent        | Consider Focused Inbox                                              |
| **Trash**                          | Deleted Items folder        | Direct mapping                                                      |
| **Spam**                           | Junk Email folder           | Direct mapping                                                      |
| **Custom label (used as folder)**  | Outlook folder              | Labels used for filing map to folders                               |
| **Custom label (used as tag)**     | Outlook category            | Labels used as tags map to categories                               |
| **Nested labels**                  | Nested Outlook folders      | Hierarchy preserved                                                 |
| **Multiple labels on one message** | Primary folder + categories | Message goes to primary folder; additional labels become categories |

### Handling multi-label messages

When a Gmail message has multiple labels (e.g., "Project-Alpha" and "Finance"), the migration tool places the message in the primary folder and applies additional labels as categories. The primary folder is determined by label priority (most specific label wins).

**Recommendation:** Before migration, audit heavy multi-label users and communicate the folder vs. category mapping. Most users adapt quickly, but power users with complex label taxonomies may need individual guidance.

---

## Gmail filter to Exchange rule mapping

### Per-user filters to Outlook rules

Gmail filters map to Outlook Inbox rules. Common mappings:

| Gmail filter action      | Outlook rule action        |
| ------------------------ | -------------------------- |
| Apply label              | Move to folder             |
| Star it                  | Flag message               |
| Mark as important        | Set importance to High     |
| Skip the Inbox (archive) | Move to folder (not Inbox) |
| Mark as read             | Mark as read               |
| Delete it                | Delete                     |
| Forward to               | Forward to                 |
| Never send to spam       | Never move to Junk         |

**Migration approach:** Gmail filters do not automatically migrate. Export filters per-user (Gmail Settings > Filters > Export) and recreate as Outlook rules manually or via PowerShell.

```powershell
# Example: Create an Outlook rule via PowerShell
# (Exchange Online Management module)
New-InboxRule -Mailbox user@contoso.com `
    -Name "Project Alpha to Folder" `
    -From "pm@partner.com" `
    -MoveToFolder "Project-Alpha" `
    -StopProcessingRules $false
```

### Organization-wide filters to Exchange transport rules

Gmail admin filters that apply to all users map to Exchange transport rules (mail flow rules).

```powershell
# Example: Create an Exchange transport rule
New-TransportRule -Name "External Email Disclaimer" `
    -FromScope "NotInOrganization" `
    -ApplyHtmlDisclaimerText "<p>This email originated from outside the organization.</p>" `
    -ApplyHtmlDisclaimerLocation "Prepend"
```

---

## Delegation and shared mailbox migration

### Gmail delegation types

| Gmail delegation type                                  | Exchange Online equivalent                | Migration steps                          |
| ------------------------------------------------------ | ----------------------------------------- | ---------------------------------------- |
| **Individual mailbox delegation**                      | Full Access permission + Send on Behalf   | Grant permissions in EAC or PowerShell   |
| **Shared mailbox (Google Groups collaborative inbox)** | Exchange shared mailbox                   | Create shared mailbox; grant permissions |
| **Send-as alias**                                      | Send As permission                        | Configure in EAC or PowerShell           |
| **Distribution list**                                  | Exchange distribution group or M365 Group | Recreate in Exchange admin               |

### Configure delegation in Exchange Online

```powershell
# Grant full access to a shared mailbox
Add-MailboxPermission -Identity "shared@contoso.com" `
    -User "user@contoso.com" `
    -AccessRights FullAccess `
    -InheritanceType All

# Grant send-as permission
Add-RecipientPermission -Identity "shared@contoso.com" `
    -Trustee "user@contoso.com" `
    -AccessRights SendAs

# Grant send on behalf
Set-Mailbox -Identity "shared@contoso.com" `
    -GrantSendOnBehalfTo "user@contoso.com"
```

---

## Creating and running migration batches

### Step 1: Prepare the CSV file

Create a CSV file with the mapping of Google Workspace mailboxes to Exchange Online mailboxes:

```csv
EmailAddress
user1@contoso.com
user2@contoso.com
user3@contoso.com
```

### Step 2: Create the migration batch

In Exchange Admin Center:

1. Navigate to **Migration**.
2. Click **Add migration batch**.
3. Select **Migration to Exchange Online**.
4. Select **Google Workspace migration**.
5. Select the migration endpoint created earlier.
6. Upload the CSV file.
7. Configure start and completion options:
    - **Start automatically** or **Start manually**.
    - **Complete automatically** or **Complete manually** (recommended: complete manually after validation).

```powershell
# Alternative: Create migration batch via PowerShell
New-MigrationBatch -Name "Batch1-IT-Department" `
    -SourceEndpoint "GoogleWorkspaceEndpoint" `
    -CSVData ([System.IO.File]::ReadAllBytes("C:\migration\batch1.csv")) `
    -TargetDeliveryDomain "contoso.mail.onmicrosoft.com" `
    -AutoStart
```

### Step 3: Monitor migration progress

```powershell
# Check migration batch status
Get-MigrationBatch -Identity "Batch1-IT-Department" |
    Format-List Status, TotalCount, SyncedCount, FailedCount

# Check individual user migration status
Get-MigrationUser -BatchId "Batch1-IT-Department" |
    Format-Table Identity, Status, ItemsSynced, ItemsSkipped -AutoSize

# Check for errors
Get-MigrationUser -BatchId "Batch1-IT-Department" -Status Failed |
    Format-List Identity, Error
```

### Step 4: Complete the migration batch

After validating that all items have synced:

```powershell
# Complete the migration batch (finalizes the migration)
Complete-MigrationBatch -Identity "Batch1-IT-Department"
```

!!! warning "Incremental sync during coexistence"
Until the migration batch is completed, the migration tool performs incremental sync every 24 hours. New emails arriving in Gmail will sync to Exchange Online. **Do not complete the batch until you are ready for DNS cutover.** Completing the batch stops incremental sync.

---

## DNS cutover: MX record migration

### Pre-cutover preparation

1. **Reduce MX record TTL** to 300 seconds (5 minutes) at least 48 hours before cutover.
2. **Communicate cutover window** to all users.
3. **Verify all migration batches** show "Synced" status.
4. **Test mail flow** by sending test messages to the Exchange Online mailbox directly (bypass DNS).

### MX record change

Replace Google MX records with Microsoft 365 MX records:

| Priority | Old record (Google)     | New record (Microsoft 365)              |
| -------- | ----------------------- | --------------------------------------- |
| 0        | ASPMX.L.GOOGLE.COM      | contoso-com.mail.protection.outlook.com |
| 5        | ALT1.ASPMX.L.GOOGLE.COM | (remove)                                |
| 5        | ALT2.ASPMX.L.GOOGLE.COM | (remove)                                |
| 10       | ALT3.ASPMX.L.GOOGLE.COM | (remove)                                |
| 10       | ALT4.ASPMX.L.GOOGLE.COM | (remove)                                |

### Additional DNS records

| Record type | Name                  | Value                                                     | Purpose                    |
| ----------- | --------------------- | --------------------------------------------------------- | -------------------------- |
| TXT         | @                     | v=spf1 include:spf.protection.outlook.com -all            | SPF authentication         |
| CNAME       | autodiscover          | autodiscover.outlook.com                                  | Outlook auto-configuration |
| CNAME       | selector1.\_domainkey | selector1-contoso-com.\_domainkey.contoso.onmicrosoft.com | DKIM signing               |
| CNAME       | selector2.\_domainkey | selector2-contoso-com.\_domainkey.contoso.onmicrosoft.com | DKIM signing               |
| TXT         | \_dmarc               | v=DMARC1; p=reject; rua=mailto:dmarc@contoso.com          | DMARC policy               |

### Post-cutover validation

```powershell
# Verify MX record propagation
Resolve-DnsName -Name contoso.com -Type MX

# Verify SPF record
Resolve-DnsName -Name contoso.com -Type TXT

# Verify mail flow by sending test emails
# Internal to internal
# External to internal
# Internal to external
```

---

## Post-migration tasks

### Verify migration completeness

```powershell
# Check item counts match between Gmail and Exchange
Get-MailboxStatistics -Identity user@contoso.com |
    Format-List ItemCount, TotalItemSize

# Compare with Gmail mailbox size (Google Admin Console > Users > user)
```

### Configure Outlook clients

- Deploy Outlook desktop via Intune or Microsoft 365 Apps deployment.
- Configure Outlook profiles (auto-discovered via DNS autodiscover record).
- Deploy Outlook mobile app via Intune MAM policies.
- Train users on Outlook features: Focused Inbox, @mentions, My Day calendar view.

### Clean up Google Workspace

1. Wait 30 days after cutover before decommissioning Google Workspace.
2. Export any remaining data via Google Takeout (admin export).
3. Disable Gmail in Google Workspace Admin Console (keeps accounts for Drive migration if still in progress).
4. Cancel Google Workspace licenses after all workloads are migrated.

---

## Troubleshooting common issues

| Issue                         | Cause                                              | Resolution                                                               |
| ----------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------ |
| Migration endpoint test fails | Service account lacks domain-wide delegation       | Re-verify OAuth scopes in Google Admin Console                           |
| Items not syncing             | API rate limiting by Google                        | Reduce concurrent connections; contact Google support for quota increase |
| Large mailbox timeout         | Mailbox exceeds 50 GB                              | Split migration into date ranges using `-StartAfter` parameter           |
| Calendar events missing       | Calendar API not enabled                           | Enable Google Calendar API in Google Cloud Console                       |
| Contacts not migrating        | Contacts API not in scope                          | Add Contacts API scope to service account delegation                     |
| Confidential mode messages    | Gmail confidential mode messages are DRM-protected | Cannot migrate; export content manually before migration                 |
| Failed items > 5%             | Various per-item errors                            | Export failed item list; investigate individually                        |

---

## Capacity planning

| Organization size  | Recommended batch size | Estimated migration duration | Concurrent batches     |
| ------------------ | ---------------------- | ---------------------------- | ---------------------- |
| < 500 users        | 100-200 per batch      | 3-5 days per batch           | 1-2                    |
| 500-2,000 users    | 200-500 per batch      | 5-10 days per batch          | 2-3                    |
| 2,000-10,000 users | 500-1,000 per batch    | 7-14 days per batch          | 3-5                    |
| 10,000+ users      | 1,000 per batch        | 10-21 days per batch         | 5+ (consult FastTrack) |

_Duration depends on average mailbox size. Assume 2-10 GB/mailbox/day throughput for Google Workspace migration in EAC._
