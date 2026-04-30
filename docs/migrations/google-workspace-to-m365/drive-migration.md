# Drive Migration: Google Drive to OneDrive and SharePoint

**Status:** Authored 2026-04-30
**Audience:** M365 administrators, migration engineers, and IT leads executing Google Drive to OneDrive/SharePoint migration.
**Scope:** Personal Google Drive to OneDrive, shared Google Drives to SharePoint, file conversion, permission mapping, and Migration Manager configuration.

---

## Overview

Google Drive migration is typically the second-highest-visibility workload after email. Users store critical documents, project files, and collaboration content in Drive, and any data loss or permission breakage is immediately impactful. Microsoft Migration Manager for Google Workspace is the recommended tool, providing automated scanning, migration, and permission mapping.

**FastTrack recommendation:** For organizations with 150+ seats, FastTrack includes Google Drive migration at no additional cost. Engage FastTrack before purchasing third-party migration tools.

---

## Migration method selection

| Method                                          | Use when                                   | Capabilities                                                         | Cost                    |
| ----------------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------- | ----------------------- |
| **Migration Manager (SharePoint Admin Center)** | Standard migrations, any size              | Scan, migrate, permission mapping, file conversion, incremental sync | Free (built into M365)  |
| **FastTrack**                                   | 150+ seats, qualifying licenses            | Full migration service managed by Microsoft                          | Free                    |
| **Mover (legacy, now Migration Manager)**       | N/A (merged into Migration Manager)        | Redirects to Migration Manager                                       | Free                    |
| **BitTitan MigrationWiz**                       | Complex scenarios, fine-grained scheduling | Advanced reporting, per-item retry, scheduling                       | $12-15/user             |
| **AvePoint FLY**                                | Enterprise with AvePoint ecosystem         | Advanced mapping, reporting, compliance                              | Enterprise licensing    |
| **ShareGate**                                   | SharePoint-focused migrations              | Document library migration with metadata mapping                     | Per-migration licensing |

### Recommendation

**Migration Manager** is the right choice for most organizations. It is free, Microsoft-supported, handles file conversion automatically, and provides incremental sync during coexistence. Third-party tools add value when:

- Organizations need fine-grained scheduling (migrate specific shared drives on specific dates).
- Complex permission structures require pre-migration analysis tools.
- Regulatory requirements mandate detailed per-item audit trails.

---

## Pre-migration preparation

### 1. Google Workspace configuration

#### Create a Google Cloud project and service account

If not already done for email migration, create the Google Cloud project:

1. Navigate to [Google Cloud Console](https://console.cloud.google.com).
2. Create or select the migration project.
3. Enable the following APIs:
    - Google Drive API
    - Google Workspace Admin SDK
4. Create a service account (or use the same one from email migration).
5. Grant domain-wide delegation with the following scopes:

```
https://www.googleapis.com/auth/drive.readonly
https://www.googleapis.com/auth/admin.directory.user.readonly
https://www.googleapis.com/auth/admin.directory.group.readonly
```

### 2. Assess the Google Drive environment

#### Inventory shared drives

```
Google Admin Console > Apps > Google Workspace > Drive and Docs > Manage shared drives
```

Document:

- [ ] Total number of shared drives.
- [ ] Size of each shared drive.
- [ ] Owner and membership of each shared drive.
- [ ] External sharing status of each shared drive.
- [ ] File count per shared drive.

#### Identify large files and quota usage

- Files exceeding 15 GB may require special handling (SharePoint file size limit is 250 GB; OneDrive sync client handles files up to 250 GB).
- Google Workspace storage is pooled in Enterprise plans; document per-user actual usage.

#### Identify Apps Script files

Apps Script files (.gs) attached to Google Sheets or Docs do not convert to M365 formats. Inventory these separately:

- [ ] List all Sheets with bound Apps Script.
- [ ] List all standalone Apps Script projects.
- [ ] Categorize by complexity: simple (< 100 lines), moderate (100-500 lines), complex (500+ lines).
- [ ] Plan conversion to Office Scripts, VBA, or Power Automate.

### 3. Microsoft 365 preparation

#### Configure OneDrive storage

```powershell
# Connect to SharePoint Online
Connect-SPOService -Url "https://contoso-admin.sharepoint.com"

# Set default OneDrive storage quota (default is 1 TB)
Set-SPOTenant -OneDriveStorageQuota 1048576  # 1 TB in MB

# Verify OneDrive is provisioned for all users
Get-SPOSite -IncludePersonalSite $true -Filter "Url -like '-my.sharepoint.com/personal/'" |
    Select-Object Url, StorageQuota, StorageUsageCurrent
```

#### Create SharePoint sites for shared drives

Map each Google shared drive to a SharePoint site:

| Google shared drive | SharePoint site     | Document library | Site URL                                           |
| ------------------- | ------------------- | ---------------- | -------------------------------------------------- |
| Finance Team        | Finance Team site   | Documents        | https://contoso.sharepoint.com/sites/finance       |
| Marketing           | Marketing Team site | Documents        | https://contoso.sharepoint.com/sites/marketing     |
| Project Alpha       | Project Alpha team  | Documents        | https://contoso.sharepoint.com/sites/project-alpha |
| HR Policies         | HR site             | Policies library | https://contoso.sharepoint.com/sites/hr            |

```powershell
# Create SharePoint sites for shared drives
New-SPOSite -Url "https://contoso.sharepoint.com/sites/finance" `
    -Title "Finance Team" `
    -Owner admin@contoso.com `
    -StorageQuota 26214400 `
    -Template "STS#3"
```

---

## File conversion during migration

### Automatic conversion matrix

Migration Manager automatically converts Google-native file formats to Microsoft Office formats:

| Google format            | Converted to       | Conversion fidelity | Notes                                                                |
| ------------------------ | ------------------ | ------------------- | -------------------------------------------------------------------- |
| Google Docs (.gdoc)      | Word (.docx)       | High                | Most formatting preserved; some advanced features may shift          |
| Google Sheets (.gsheet)  | Excel (.xlsx)      | High                | Formulas, charts, formatting preserved; Apps Script does NOT convert |
| Google Slides (.gslides) | PowerPoint (.pptx) | High                | Layouts, animations preserved; some transitions may differ           |
| Google Drawings (.gdraw) | Not converted      | N/A                 | Exported as PNG during migration; lossy                              |
| Google Forms (.gform)    | Not converted      | N/A                 | Must be rebuilt in Microsoft Forms                                   |
| Google Sites             | Not migrated       | N/A                 | Must be rebuilt in SharePoint                                        |
| Google Jamboard          | Not migrated       | N/A                 | Workflow migrates to Microsoft Whiteboard                            |

### Files that migrate without conversion

| File type                          | Migration behavior          |
| ---------------------------------- | --------------------------- |
| PDF                                | Direct copy (no conversion) |
| Office files (.docx, .xlsx, .pptx) | Direct copy                 |
| Images (.png, .jpg, .gif, .svg)    | Direct copy                 |
| Videos (.mp4, .mov)                | Direct copy                 |
| Archives (.zip, .tar, .gz)         | Direct copy                 |
| Code files (.py, .js, .html, .css) | Direct copy                 |
| CSV/TSV                            | Direct copy                 |

### Conversion edge cases

| Scenario                                  | Impact                                                | Mitigation                                                      |
| ----------------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------- |
| Google Sheets with Apps Script macros     | Apps Script is lost during conversion                 | Inventory and rebuild in VBA, Office Scripts, or Power Automate |
| Google Docs with embedded Drawings        | Drawings convert to static images                     | Accept static images or rebuild in PowerPoint/Visio             |
| Google Sheets with IMPORTDATA/IMPORTRANGE | External data functions may not convert               | Rebuild using Power Query or Excel data connections             |
| Google Docs with add-on formatting        | Add-on-specific formatting may be lost                | Review post-migration and reformat                              |
| Google Slides with YouTube embeds         | YouTube links preserved but embed behavior may change | Re-embed videos in PowerPoint                                   |
| Files with Google Drive comments          | Comments migrate to Word/Excel/PowerPoint comments    | Verify comment thread continuity                                |

---

## Permission mapping

### How permissions map

| Google Drive permission           | OneDrive/SharePoint equivalent                 | Notes                                                                               |
| --------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------- |
| **Owner**                         | Site owner / Full control                      | Owners in SharePoint have full control                                              |
| **Editor**                        | Edit permission (Contribute)                   | Can edit and delete files                                                           |
| **Commenter**                     | Edit permission with comment-only (not native) | SharePoint does not have a native commenter role; approximated with restricted edit |
| **Viewer**                        | Read permission                                | View-only access                                                                    |
| **Anyone with the link (editor)** | Anyone link (edit)                             | Must enable anonymous links in SharePoint admin                                     |
| **Anyone with the link (viewer)** | Anyone link (view)                             | Must enable anonymous links in SharePoint admin                                     |
| **Domain-wide sharing**           | Organization link                              | People in the organization                                                          |
| **Specific people**               | Specific people link                           | Direct share to named users                                                         |
| **External sharing**              | External sharing (guest access)                | Requires external sharing enabled on site                                           |

### Permission considerations

1. **Google Workspace allows multi-level sharing per file.** A single file can be shared with specific people, via a link, and with the entire domain simultaneously. SharePoint supports similar patterns but the admin configuration differs.

2. **External sharing policies must be configured** before migration. If the Google Workspace environment allows external sharing, ensure SharePoint external sharing is enabled at the tenant and site level.

3. **Shared drive membership** maps to SharePoint site permissions. Shared drive managers become site owners; members become site members.

```powershell
# Enable external sharing on a SharePoint site
Set-SPOSite -Identity "https://contoso.sharepoint.com/sites/finance" `
    -SharingCapability ExternalUserAndGuestSharing

# Verify sharing settings
Get-SPOSite -Identity "https://contoso.sharepoint.com/sites/finance" |
    Select-Object SharingCapability
```

---

## Configuring Migration Manager

### Step 1: Connect Google Workspace

1. Navigate to **SharePoint Admin Center > Migration > Google Workspace**.
2. Click **Get started**.
3. Sign in with your Google Workspace admin account.
4. Authorize Migration Manager to access Google Workspace (uses the service account configured earlier).
5. Verify the connection shows "Connected."

### Step 2: Scan and assess

Migration Manager scans the Google Workspace environment and reports:

- Total data size per user.
- File count per user and shared drive.
- File types and conversion requirements.
- Permission structure.
- Potential issues (unsupported file types, large files, naming conflicts).

**Review the assessment report** before proceeding. Key items to validate:

- [ ] Total data volume fits within OneDrive/SharePoint quotas.
- [ ] No files exceed the 250 GB SharePoint file size limit.
- [ ] File names do not contain characters invalid in SharePoint (`" * : < > ? / \ |`).
- [ ] Path lengths do not exceed 400 characters (SharePoint limit).

### Step 3: Map destinations

Configure the mapping between Google sources and M365 destinations:

| Source type    | Source           | Destination type | Destination                                    |
| -------------- | ---------------- | ---------------- | ---------------------------------------------- |
| Personal Drive | user@contoso.com | OneDrive         | user@contoso.com                               |
| Shared Drive   | Finance Team     | SharePoint site  | https://contoso.sharepoint.com/sites/finance   |
| Shared Drive   | Marketing        | SharePoint site  | https://contoso.sharepoint.com/sites/marketing |

### Step 4: Run migration

1. Select the migration batch.
2. Click **Migrate**.
3. Migration runs in the background with incremental sync.
4. Monitor progress in the Migration Manager dashboard.

### Step 5: Validate

Post-migration validation checklist:

- [ ] File counts match between Google Drive and OneDrive/SharePoint.
- [ ] Converted files (Docs, Sheets, Slides) open correctly in Office.
- [ ] Permissions are correctly applied (test with multiple user accounts).
- [ ] External sharing links are functional.
- [ ] Folder hierarchy is preserved.
- [ ] File version history is preserved (last 100 versions).
- [ ] Comments on documents are preserved.

---

## Incremental sync and coexistence

Migration Manager supports incremental sync, meaning changes in Google Drive are synced to OneDrive/SharePoint until migration is finalized:

- **Sync frequency:** Every 24 hours (automatic).
- **Direction:** Google Drive to OneDrive/SharePoint (one-way).
- **New files:** Automatically copied.
- **Modified files:** Updated version copied.
- **Deleted files:** Not deleted in destination (safety measure).

### Coexistence best practices

1. **Communicate the cutover date clearly.** Tell users which date they should start using OneDrive/SharePoint as primary.
2. **Keep incremental sync running** until the cutover date.
3. **Do not modify files in both locations simultaneously** --- incremental sync is one-way and does not merge conflicts.
4. **Deploy OneDrive sync client** before cutover so users have seamless desktop access.

```powershell
# Deploy OneDrive sync client via Intune
# Use the Microsoft 365 Apps deployment to include OneDrive
# Or deploy standalone OneDrive via Intune Win32 app
```

---

## SharePoint file naming and path considerations

Google Drive allows characters and path lengths that SharePoint does not. Migration Manager reports these issues during the assessment phase.

### Invalid characters in SharePoint

| Character                | Handling              |
| ------------------------ | --------------------- | ---------------------------------------------- |
| `" \* : < > ? / \        | `                     | Migration Manager replaces with underscore `_` |
| Leading/trailing spaces  | Trimmed automatically |
| Leading/trailing periods | Trimmed automatically |
| File names ending in `.` | Trimmed automatically |

### Path length limits

| Platform             | Maximum path length                                |
| -------------------- | -------------------------------------------------- |
| Google Drive         | No practical limit                                 |
| SharePoint Online    | 400 characters (URL path)                          |
| OneDrive sync client | 400 characters (total path including local folder) |

**Mitigation for long paths:**

1. Review assessment report for long paths.
2. Shorten folder names before migration.
3. Restructure deeply nested folders.

---

## Post-migration tasks

### Deploy OneDrive sync client

```powershell
# Configure OneDrive Known Folder Move (redirect Desktop, Documents, Pictures)
# Via Intune or Group Policy
# Registry key:
# HKLM\SOFTWARE\Policies\Microsoft\OneDrive
# KFMSilentOptIn = <tenant-id>
```

### Communicate to users

Send migration completion communication:

- Confirm files are available in OneDrive/SharePoint.
- Provide links to training resources.
- Share the OneDrive quick-start guide.
- Explain the folder structure mapping (shared drives to SharePoint sites).
- Set expectations for file format changes (Google Docs are now Word documents).

### Monitor adoption

```powershell
# Check OneDrive usage via Microsoft Graph
Connect-MgGraph -Scopes "Reports.Read.All"
Get-MgReportOneDriveUsageAccountDetail -Period "D30" -OutFile "onedrive-usage.csv"
```

---

## Troubleshooting common issues

| Issue                               | Cause                                         | Resolution                                                           |
| ----------------------------------- | --------------------------------------------- | -------------------------------------------------------------------- |
| Service account authorization fails | OAuth scopes not granted or expired           | Re-authorize in Google Admin Console                                 |
| Large file migration timeout        | Files > 15 GB                                 | Retry with increased timeout; contact Microsoft support for guidance |
| Permission mapping errors           | External users not in Entra ID                | Create guest accounts in Entra ID for external users                 |
| File name conflicts                 | Invalid characters in Google Drive file names | Migration Manager auto-renames; review renamed files                 |
| Path too long                       | Deeply nested folder structures               | Shorten folder names or restructure before migration                 |
| Apps Script lost                    | Google-specific scripting                     | Expected behavior; rebuild in Office Scripts or Power Automate       |
| Google Forms not migrated           | Not a file type that converts                 | Rebuild in Microsoft Forms                                           |
| Version history incomplete          | Only last 100 versions migrate                | Expected limitation; archive older versions before migration         |
