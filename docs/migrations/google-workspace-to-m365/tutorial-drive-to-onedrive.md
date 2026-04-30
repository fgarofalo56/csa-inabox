# Tutorial: Google Drive to OneDrive Migration

**Status:** Authored 2026-04-30
**Audience:** M365 administrators performing hands-on Google Drive to OneDrive/SharePoint migration using Migration Manager.
**Duration:** 2-3 hours for setup + migration time depending on data volume.

---

## Prerequisites

Before starting this tutorial, confirm:

- [ ] Microsoft 365 tenant is provisioned with SharePoint Online and OneDrive.
- [ ] All target users are created in Entra ID with M365 licenses assigned (including SharePoint and OneDrive).
- [ ] OneDrive has been provisioned for all target users (first sign-in or bulk provisioning).
- [ ] SharePoint sites are created for shared drive destinations.
- [ ] You have Google Workspace super admin access.
- [ ] You have M365 Global Administrator or SharePoint Administrator role.
- [ ] Google Cloud project with Drive API enabled (from email migration, or new project).

---

## Step 1: Prepare Google Workspace

### 1.1 Enable Google Drive API

If not already done for email migration:

1. Navigate to [console.cloud.google.com](https://console.cloud.google.com).
2. Select or create a project.
3. Navigate to **APIs & Services > Library**.
4. Search for "Google Drive API" and click **Enable**.
5. Search for "Admin SDK API" and click **Enable**.

### 1.2 Create or reuse service account

If you created a service account for email migration, you can reuse it. Add these OAuth scopes to the domain-wide delegation:

```
https://www.googleapis.com/auth/drive.readonly
https://www.googleapis.com/auth/admin.directory.user.readonly
https://www.googleapis.com/auth/admin.directory.group.readonly
```

If creating a new service account:

1. Navigate to **IAM & Admin > Service Accounts**.
2. Click **Create Service Account**.
3. Name: `m365-drive-migration`.
4. Enable domain-wide delegation.
5. Create JSON key and download.
6. Add the scopes above in Google Admin Console > Security > API controls > Domain-wide delegation.

---

## Step 2: Provision OneDrive for all users

OneDrive personal sites must be provisioned before migration. Users get provisioned automatically on first sign-in, but for migration you need them provisioned in advance.

### 2.1 Bulk provision OneDrive

```powershell
# Connect to SharePoint Online
Connect-SPOService -Url "https://contoso-admin.sharepoint.com"

# Option 1: Request OneDrive provisioning for specific users
$users = @(
    "user1@contoso.com",
    "user2@contoso.com",
    "user3@contoso.com"
)

Request-SPOPersonalSite -UserEmails $users -NoWait

# Option 2: Provision for all licensed users
# Navigate to M365 Admin Center > SharePoint Admin Center > Settings
# Under OneDrive, ensure "Default storage" is set appropriately
```

### 2.2 Verify OneDrive provisioning

```powershell
# Check if a user's OneDrive is provisioned
Get-SPOSite -IncludePersonalSite $true `
    -Filter "Url -like '-my.sharepoint.com/personal/'" |
    Select-Object Url, Owner, StorageQuota |
    Format-Table -AutoSize

# Check specific user
$userUpn = "user1_contoso_com"  # UPN with underscores
Get-SPOSite -Identity "https://contoso-my.sharepoint.com/personal/$userUpn" -ErrorAction SilentlyContinue
```

---

## Step 3: Create SharePoint sites for shared drives

### 3.1 Map shared drives to SharePoint sites

Review your Google Workspace shared drives and map each to a SharePoint site:

| Google shared drive | SharePoint site URL                                | Site type          |
| ------------------- | -------------------------------------------------- | ------------------ |
| Finance Team        | https://contoso.sharepoint.com/sites/finance       | Team site          |
| Marketing           | https://contoso.sharepoint.com/sites/marketing     | Team site          |
| HR Policies         | https://contoso.sharepoint.com/sites/hr            | Team site          |
| Project Alpha       | https://contoso.sharepoint.com/sites/project-alpha | Team site          |
| Company Templates   | https://contoso.sharepoint.com/sites/templates     | Communication site |

### 3.2 Create SharePoint sites

```powershell
# Create team sites for shared drives
New-SPOSite -Url "https://contoso.sharepoint.com/sites/finance" `
    -Title "Finance Team" `
    -Owner "admin@contoso.com" `
    -StorageQuota 26214400 `
    -Template "STS#3"

New-SPOSite -Url "https://contoso.sharepoint.com/sites/marketing" `
    -Title "Marketing" `
    -Owner "admin@contoso.com" `
    -StorageQuota 26214400 `
    -Template "STS#3"

# Or create via Teams (creates SharePoint site automatically)
New-Team -DisplayName "Finance Team" `
    -Description "Finance team collaboration" `
    -Visibility Private
```

### 3.3 Configure external sharing (if needed)

```powershell
# Enable external sharing on sites that had external sharing in Google Drive
Set-SPOSite -Identity "https://contoso.sharepoint.com/sites/finance" `
    -SharingCapability ExternalUserAndGuestSharing

# Verify tenant-level sharing settings
Get-SPOTenant | Select-Object SharingCapability
```

---

## Step 4: Configure Migration Manager

### 4.1 Open Migration Manager

1. Navigate to [SharePoint Admin Center](https://contoso-admin.sharepoint.com).
2. In the left navigation, expand **Migration**.
3. Click **Google Workspace**.

### 4.2 Connect to Google Workspace

1. Click **Get started** (or **Connect to Google Workspace**).
2. Click **Sign in to Google Workspace**.
3. Sign in with your Google Workspace super admin account.
4. Grant Migration Manager permissions to access Drive data.
5. Upload the service account JSON key file.
6. Migration Manager tests the connection.
7. Verify: **Connected successfully**.

_If using PowerShell to configure:_

```powershell
# Migration Manager is primarily a UI tool
# PowerShell alternative uses the SharePoint Migration Tool (SPMT)

# Install SPMT
Install-Module -Name Microsoft.SharePoint.MigrationTool.PowerShell

# Configure Google Workspace connection
# SPMT requires manual configuration through the GUI for Google Workspace
# Migration Manager in SharePoint Admin Center is the recommended approach
```

---

## Step 5: Scan and assess

### 5.1 Run the scan

1. In Migration Manager, click **Scan**.
2. Migration Manager scans all user drives and shared drives.
3. Wait for the scan to complete (15-60 minutes depending on environment size).

### 5.2 Review the assessment report

The assessment report shows:

| Metric                 | What to look for                                             |
| ---------------------- | ------------------------------------------------------------ |
| **Total data size**    | Ensure OneDrive/SharePoint quotas are sufficient             |
| **File count**         | Per-user and per-shared-drive counts                         |
| **File types**         | Google-native files (Docs, Sheets, Slides) that will convert |
| **Large files**        | Files > 15 GB that may need special handling                 |
| **Long paths**         | Paths exceeding 400 characters                               |
| **Invalid characters** | File names with characters not supported in SharePoint       |
| **Scan warnings**      | Files or folders that may not migrate cleanly                |

### 5.3 Address assessment findings

For each finding:

| Finding                       | Action                                                   |
| ----------------------------- | -------------------------------------------------------- |
| Files with invalid characters | Migration Manager auto-renames; review the rename log    |
| Paths too long                | Shorten folder names in Google Drive before migration    |
| Large files (> 15 GB)         | These will migrate but may take longer; no action needed |
| Apps Script files             | Will not convert; document for manual rebuild            |
| Google Sites                  | Will not migrate; plan separate SharePoint site rebuild  |
| Google Forms                  | Will not convert; plan rebuild in Microsoft Forms        |

---

## Step 6: Configure destination mapping

### 6.1 Map personal drives

Migration Manager auto-maps personal Google Drives to OneDrive based on email address matching:

| Source (Google)              | Destination (OneDrive)       |
| ---------------------------- | ---------------------------- |
| user1@contoso.com (My Drive) | user1@contoso.com (OneDrive) |
| user2@contoso.com (My Drive) | user2@contoso.com (OneDrive) |

Review the auto-mapping and correct any mismatches.

### 6.2 Map shared drives

For each shared drive, select the destination SharePoint site and document library:

| Source shared drive | Destination site                                   | Document library |
| ------------------- | -------------------------------------------------- | ---------------- |
| Finance Team        | https://contoso.sharepoint.com/sites/finance       | Documents        |
| Marketing           | https://contoso.sharepoint.com/sites/marketing     | Documents        |
| HR Policies         | https://contoso.sharepoint.com/sites/hr            | Policies         |
| Project Alpha       | https://contoso.sharepoint.com/sites/project-alpha | Documents        |

Configure in Migration Manager:

1. Select each shared drive.
2. Click **Edit destination**.
3. Enter the SharePoint site URL and document library name.
4. Click **Save**.

---

## Step 7: Run the migration

### 7.1 Start migration

1. Select the users and shared drives to migrate (start with the pilot group).
2. Click **Migrate**.
3. Confirm the migration settings.
4. Migration begins in the background.

### 7.2 Monitor progress

The Migration Manager dashboard shows real-time progress:

| Status                      | Meaning                                               |
| --------------------------- | ----------------------------------------------------- |
| **Not started**             | Queued but not yet processing                         |
| **In progress**             | Actively copying files                                |
| **Completed**               | All files copied successfully                         |
| **Completed with warnings** | Most files copied; some warnings                      |
| **Failed**                  | Migration failed for this source; check error details |

### 7.3 Review migration logs

For each migrated source, Migration Manager provides:

- **Files migrated:** Count and size.
- **Files skipped:** Files not migrated (with reasons).
- **Files failed:** Files that encountered errors.
- **Warnings:** Non-critical issues.

Click on any source to view detailed logs and per-file status.

---

## Step 8: Validate migration

### 8.1 File count validation

Compare file counts between Google Drive and OneDrive/SharePoint:

```powershell
# Check OneDrive file count for a user
# Via SharePoint Admin Center > Active sites > user's OneDrive site

# Or via Microsoft Graph
Connect-MgGraph -Scopes "Sites.Read.All", "Files.Read.All"

# Get OneDrive site for user
$user = Get-MgUser -UserId "user1@contoso.com"
$drive = Get-MgUserDrive -UserId $user.Id
Write-Host "Drive quota used: $($drive.Quota.Used)"
Write-Host "Drive item count: Check via UI or Graph API"
```

### 8.2 File conversion validation

Verify converted files open correctly:

- [ ] Open 3 converted Word documents (from Google Docs) --- check formatting, images, tables.
- [ ] Open 3 converted Excel workbooks (from Google Sheets) --- check formulas, charts, conditional formatting.
- [ ] Open 3 converted PowerPoint files (from Google Slides) --- check layouts, animations, speaker notes.

### 8.3 Permission validation

Test access with multiple user accounts:

- [ ] Owner of a shared drive can access the SharePoint site as owner.
- [ ] Members can edit files in the document library.
- [ ] Viewers can read but not edit files.
- [ ] External sharing links work (if applicable).
- [ ] Users can access their personal OneDrive files.

### 8.4 Folder structure validation

- [ ] Top-level folder hierarchy matches Google Drive.
- [ ] Nested folders are preserved.
- [ ] No truncation of folder names.
- [ ] No orphaned files (files outside their expected folder).

---

## Step 9: Deploy OneDrive sync client

### 9.1 Deploy via Intune

```powershell
# OneDrive sync client is included with Microsoft 365 Apps
# If deploying standalone:

# Option 1: Deploy via Intune Win32 app
# Download OneDrive installer from https://go.microsoft.com/fwlink/?linkid=844652
# Package as .intunewin and deploy via Intune

# Option 2: Deploy via Microsoft 365 Apps deployment
# M365 Admin Center > Settings > Microsoft 365 Apps
# Ensure OneDrive is included in the deployment configuration
```

### 9.2 Configure Known Folder Move (KFM)

Known Folder Move redirects Desktop, Documents, and Pictures to OneDrive:

```powershell
# Configure via Intune device configuration profile
# Or via registry keys:

# HKLM\SOFTWARE\Policies\Microsoft\OneDrive
# KFMSilentOptIn (REG_SZ) = <tenant-id>
# KFMSilentOptInWithNotification (DWORD) = 1
# KFMBlockOptOut (DWORD) = 1  # Optional: prevent users from opting out
```

### 9.3 Configure Files On-Demand

Files On-Demand shows all files in File Explorer without downloading them:

```powershell
# Files On-Demand is enabled by default in OneDrive sync client
# Verify via Intune or registry:

# HKLM\SOFTWARE\Policies\Microsoft\OneDrive
# FilesOnDemandEnabled (DWORD) = 1
```

---

## Step 10: Communicate to users

### 10.1 Pre-migration communication

Send to all users before migration:

```
Subject: Your Google Drive files are moving to OneDrive/SharePoint

Your Google Drive files will be migrated to Microsoft OneDrive and SharePoint
starting [date]. Here's what you need to know:

WHAT'S HAPPENING:
- Your personal Google Drive files will move to OneDrive for Business
- Shared drives will move to SharePoint document libraries
- Google Docs will automatically convert to Word documents
- Google Sheets will convert to Excel workbooks
- Google Slides will convert to PowerPoint presentations

WHAT YOU NEED TO DO:
- Install the OneDrive sync client (IT will push this to your device)
- Sign in to OneDrive with your contoso.com credentials
- After [cutover date], use OneDrive/SharePoint for all file storage

YOUR FILES ARE SAFE:
- All files will be copied (not moved) during migration
- Google Drive will remain accessible during the transition
- After [cutover date], use OneDrive as your primary file storage

NEED HELP?
- Training: [link to training resources]
- FAQ: [link to FAQ]
- Support: [help desk contact]
```

### 10.2 Post-migration communication

```
Subject: Your files are now in OneDrive/SharePoint

Your Google Drive migration is complete. Here's where to find your files:

PERSONAL FILES:
- Open File Explorer > OneDrive - Contoso
- Or visit https://contoso-my.sharepoint.com

SHARED TEAM FILES:
- [Finance Team]: https://contoso.sharepoint.com/sites/finance
- [Marketing]: https://contoso.sharepoint.com/sites/marketing
- [Your team]: [link]

TIPS:
- Files On-Demand: Files show in Explorer without downloading.
  Right-click > "Always keep on this device" for files you need offline.
- Share files: Right-click > Share > enter email address
- Recent files: Office apps show recent OneDrive/SharePoint files

KNOWN CHANGES:
- Google Docs are now Word documents (.docx)
- Google Sheets are now Excel workbooks (.xlsx)
- Google Slides are now PowerPoint files (.pptx)
- Apps Script macros in Sheets did not migrate (IT is rebuilding critical ones)

NEED HELP?
- [help desk contact]
```

---

## Step 11: Incremental sync and cutover

### 11.1 Incremental sync

Migration Manager runs incremental sync automatically. Files created or modified in Google Drive after the initial migration are synced to OneDrive/SharePoint.

- **Sync frequency:** Automatic (every few hours).
- **Direction:** Google Drive to OneDrive/SharePoint (one-way).
- **Duration:** Until you stop the migration task.

### 11.2 Cutover

On the cutover date:

1. Verify incremental sync is complete (last sync time).
2. Communicate to users: "Use OneDrive/SharePoint starting now."
3. Optionally: Set Google Drive to read-only (Admin Console > Apps > Drive > Sharing settings > OFF for creating new files).
4. Stop the Migration Manager task.

### 11.3 Post-cutover monitoring

```powershell
# Monitor OneDrive adoption
# M365 Admin Center > Reports > Usage > OneDrive

# Check for users still accessing Google Drive
# Google Admin Console > Reporting > Apps Usage Activity
```

---

## Troubleshooting

| Issue                                  | Cause                                              | Resolution                                                         |
| -------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------ |
| Migration Manager cannot connect       | Service account or API issue                       | Verify service account, domain-wide delegation, and API enablement |
| Files skipped - "unsupported type"     | Google Sites, Forms, or other non-file types       | Expected; plan separate migration for these                        |
| Files skipped - "path too long"        | Folder nesting exceeds SharePoint 400-char limit   | Shorten folder names before migration                              |
| Permission errors                      | External users not in Entra ID                     | Create Entra ID guest accounts for external collaborators          |
| Slow migration speed                   | Google API throttling or large file count          | Expected for large environments; migration continues automatically |
| Converted files have formatting issues | Google-to-Office conversion artifacts              | Review and manually correct; most issues are cosmetic              |
| OneDrive not provisioned               | User hasn't signed in or bulk provisioning not run | Run `Request-SPOPersonalSite` for affected users                   |
| Storage quota exceeded                 | OneDrive 1 TB limit reached                        | Increase quota or move large datasets to SharePoint                |
