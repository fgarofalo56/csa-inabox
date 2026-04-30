# Tutorial: SharePoint Migration with SPMT

**Status:** Authored 2026-04-30
**Audience:** SharePoint administrators executing their first migration from SharePoint Server on-premises to SharePoint Online using the SharePoint Migration Tool (SPMT).
**Scope:** End-to-end walkthrough: download, configure, scan, migrate, validate, and remediate errors.

---

## Prerequisites

Before starting this tutorial, ensure:

- [ ] SharePoint Online tenant is provisioned and accessible
- [ ] Entra ID (Azure AD) Connect is configured and syncing users
- [ ] You have SharePoint Administrator or Global Administrator role in M365
- [ ] You have Farm Administrator access to the on-premises SharePoint farm
- [ ] Network connectivity between the SPMT workstation and both source (on-prem) and target (SPO)
- [ ] Source SharePoint Server version: 2010, 2013, 2016, or 2019
- [ ] Target site collections exist in SPO (or will be created during migration)

---

## Step 1: Download and install SPMT

### 1.1 Download SPMT

```powershell
# Download SPMT from Microsoft
# https://aka.ms/spmt-ga-page
# Or install via winget:
winget install Microsoft.SharePointMigrationTool
```

SPMT is a free desktop application that runs on Windows 10/11. It requires:

- Windows 10 (1607+) or Windows 11
- .NET Framework 4.6.2+
- 4 GB RAM minimum (8 GB recommended)
- 50 GB free disk space for temporary migration files

### 1.2 Install SPMT PowerShell module

```powershell
# Install the SPMT PowerShell module for scripted migrations
Install-Module -Name Microsoft.SharePoint.MigrationTool.PowerShell -Scope CurrentUser

# Verify installation
Get-Module -Name Microsoft.SharePoint.MigrationTool.PowerShell -ListAvailable
```

### 1.3 First launch

1. Launch SPMT from the Start menu
2. Sign in with your M365 administrator account
3. Accept the license terms
4. SPMT connects to your SPO tenant and validates permissions

---

## Step 2: Configure source and target

### 2.1 GUI-based configuration

1. Click **Start your first migration**
2. Select **SharePoint Server** as the source
3. Enter the source SharePoint site URL: `https://sp2016.contoso.com/sites/finance`
4. Enter credentials for the on-premises farm (Windows authentication or forms)
5. Select the target SPO site: `https://contoso.sharepoint.com/sites/finance`
6. Choose migration scope:
    - **Migrate all** -- migrates everything in the site (recommended for first migration)
    - **Select specific lists/libraries** -- granular selection

### 2.2 PowerShell-based configuration

```powershell
Import-Module Microsoft.SharePoint.MigrationTool.PowerShell

# Initialize SPMT session
$spoCredential = Get-Credential -Message "Enter M365 admin credentials"

Register-SPMTMigration `
    -SPOUrl "https://contoso.sharepoint.com" `
    -SPOCredential $spoCredential `
    -Force

# Configure migration settings
$globalSettings = @{
    MigrateFileVersionHistory                    = $true
    KeepAllVersions                              = $false
    NumberOfVersionToMigrate                     = 10
    EnableIncremental                            = $true
    PreserveUserPermissionsForDocumentLibrary     = $true
    PreserveUserPermissionsForLists               = $true
    MigrateHiddenItems                           = $true
    AzureActiveDirectoryLookup                   = $true
    UserMappingCSVFile                           = "C:\Migration\user-mapping.csv"
    FilterOutPathSpecialCharacters               = $true
    MigrateOneNoteNotebook                       = $true
    SkipListWithAudienceEnabled                  = $false
    CustomAzureAccessKey                         = ""  # Use default Azure storage
    CustomAzureStorageAccount                    = ""  # Use default Azure storage
}
```

---

## Step 3: Run pre-migration scan

### 3.1 SPMT pre-scan

Before migrating content, SPMT can scan the source to identify issues:

```powershell
# Add a migration task (scan only)
Add-SPMTTask `
    -SharePointSourceSiteUrl "https://sp2016.contoso.com/sites/finance" `
    -TargetSiteUrl "https://contoso.sharepoint.com/sites/finance" `
    -MigrateAll

# Review scan results before starting migration
# SPMT displays warnings and blockers in the task list
```

### 3.2 Common scan findings

| Finding                               | Severity | Resolution                                                     |
| ------------------------------------- | -------- | -------------------------------------------------------------- |
| File name contains invalid characters | Warning  | Rename files to remove `# % &` and other restricted characters |
| File path exceeds 400 characters      | Blocker  | Shorten folder names or restructure hierarchy                  |
| File size exceeds 250 GB              | Blocker  | Split file or store in Azure Blob Storage                      |
| Checked-out file                      | Warning  | Force check-in before migration                                |
| InfoPath form library                 | Warning  | Content migrates; forms will not render in SPO                 |
| Workflow associations                 | Warning  | Workflows do not migrate; plan Power Automate replacement      |
| Sandbox solution                      | Warning  | Solution does not deploy to SPO; plan SPFx replacement         |
| Custom web parts                      | Warning  | Server-side web parts will not render in SPO                   |
| List exceeds 100,000 items            | Warning  | Consider alternatives for very large lists                     |
| Managed metadata columns              | Info     | Ensure term store is migrated before content                   |

### 3.3 Run SMAT for deeper assessment

```powershell
# SMAT provides more detailed assessment than SPMT pre-scan
# Download from https://www.microsoft.com/download/details.aspx?id=53598

.\SMAT.exe -SiteURL https://sp2016.contoso.com `
    -OutputFolder C:\SMAT-Results `
    -Verbose

# Review reports in C:\SMAT-Results\
# Key reports:
# - ScanSummary.csv -- overview of all findings
# - LargeListFiles.csv -- lists exceeding thresholds
# - CheckedOutFiles.csv -- files checked out by users
# - CustomizedFiles.csv -- unghosted (customized) pages
# - WorkflowAssociations2010.csv -- SP 2010 workflow inventory
# - WorkflowAssociations2013.csv -- SP 2013 workflow inventory
# - InfoPathForms.csv -- InfoPath form inventory
# - SandboxSolutions.csv -- sandbox solution inventory
```

---

## Step 4: Execute migration

### 4.1 GUI migration

1. After scan results are reviewed, click **Migrate** in the SPMT interface
2. SPMT uploads content to a temporary Azure storage location
3. Content is then imported into SPO from Azure storage
4. Progress is displayed in real-time with item counts, errors, and warnings

### 4.2 PowerShell migration

```powershell
# Single site migration
Add-SPMTTask `
    -SharePointSourceSiteUrl "https://sp2016.contoso.com/sites/finance" `
    -TargetSiteUrl "https://contoso.sharepoint.com/sites/finance" `
    -MigrateAll

# Start migration
Start-SPMTMigration

# Monitor progress
# SPMT writes logs to %APPDATA%\Microsoft\MigrationTool\Logs\
```

### 4.3 Batch migration with multiple tasks

```powershell
# Define multiple migration tasks
$tasks = @(
    @{
        Source = "https://sp2016.contoso.com/sites/finance"
        Target = "https://contoso.sharepoint.com/sites/finance"
    },
    @{
        Source = "https://sp2016.contoso.com/sites/hr"
        Target = "https://contoso.sharepoint.com/sites/hr"
    },
    @{
        Source = "https://sp2016.contoso.com/sites/legal"
        Target = "https://contoso.sharepoint.com/sites/legal"
    },
    @{
        Source = "https://sp2016.contoso.com/sites/marketing"
        Target = "https://contoso.sharepoint.com/sites/marketing"
    }
)

foreach ($task in $tasks) {
    Add-SPMTTask `
        -SharePointSourceSiteUrl $task.Source `
        -TargetSiteUrl $task.Target `
        -MigrateAll
    Write-Host "Added task: $($task.Source) -> $($task.Target)"
}

# Start all tasks
Start-SPMTMigration
Write-Host "Migration started. Monitor progress in SPMT GUI or log files."
```

### 4.4 Selective migration (specific libraries)

```powershell
# Migrate specific document libraries only
Add-SPMTTask `
    -SharePointSourceSiteUrl "https://sp2016.contoso.com/sites/finance" `
    -SharePointSourceDocumentLibraryName "Shared Documents" `
    -TargetSiteUrl "https://contoso.sharepoint.com/sites/finance" `
    -TargetDocumentLibraryName "Shared Documents"

Add-SPMTTask `
    -SharePointSourceSiteUrl "https://sp2016.contoso.com/sites/finance" `
    -SharePointSourceDocumentLibraryName "Policies" `
    -TargetSiteUrl "https://contoso.sharepoint.com/sites/finance" `
    -TargetDocumentLibraryName "Policies"

Start-SPMTMigration
```

---

## Step 5: Validate migration results

### 5.1 Review SPMT reports

After migration completes, SPMT generates detailed reports:

```powershell
# SPMT log location
$logPath = "$env:APPDATA\Microsoft\MigrationTool\Logs"

# Key log files:
# - StatusReport.csv -- Overall migration status per task
# - ItemReport.csv -- Per-item migration status
# - ScanReport.csv -- Pre-scan findings
# - FailureReport.csv -- Failed items with error details
# - WarningReport.csv -- Items migrated with warnings

# Review failures
$failures = Import-Csv "$logPath\<session>\FailureReport.csv"
$failures | Group-Object -Property ErrorMessage | Sort-Object Count -Descending |
    Select-Object Count, Name | Format-Table -AutoSize
```

### 5.2 Content validation

```powershell
# Connect to target SPO site
Connect-PnPOnline -Url "https://contoso.sharepoint.com/sites/finance" -Interactive

# Compare document counts
$targetLibraries = Get-PnPList | Where-Object {
    $_.BaseType -eq "DocumentLibrary" -and -not $_.Hidden
}

$targetLibraries | ForEach-Object {
    [PSCustomObject]@{
        Library   = $_.Title
        ItemCount = $_.ItemCount
        SizeMB    = [math]::Round($_.ParentWeb.Usage.Storage / 1MB, 2)
    }
} | Format-Table -AutoSize

# Spot-check specific documents
$testDoc = Get-PnPFile -Url "/sites/finance/Shared Documents/Budget2026.xlsx" -AsListItem
Write-Host "Title: $($testDoc['FileLeafRef'])"
Write-Host "Created: $($testDoc['Created'])"
Write-Host "Modified: $($testDoc['Modified'])"
Write-Host "Created By: $($testDoc['Author'].Email)"
Write-Host "Modified By: $($testDoc['Editor'].Email)"
```

### 5.3 Permission validation

```powershell
# Verify site permissions
Get-PnPSiteGroup | ForEach-Object {
    [PSCustomObject]@{
        Group    = $_.Title
        Members  = $_.Users.Count
        Roles    = ($_.Roles | Select-Object -ExpandProperty Name) -join ", "
    }
} | Format-Table -AutoSize

# Verify site collection administrators
Get-PnPSiteCollectionAdmin | Select-Object Title, Email | Format-Table -AutoSize
```

---

## Step 6: Remediate errors

### 6.1 Common error remediation

| Error                               | Cause                                 | Fix                                             |
| ----------------------------------- | ------------------------------------- | ----------------------------------------------- |
| `FileNameContainsInvalidCharacters` | Characters like `# % &` in filename   | Rename source file, re-run incremental          |
| `FilePathTooLong`                   | Full URL path > 400 chars             | Shorten folder names in source                  |
| `FileSizeExceedsLimit`              | File > 250 GB                         | Cannot migrate; use Azure Blob Storage          |
| `UserNotFound`                      | On-prem user not in Entra ID          | Add user to Entra or update user mapping CSV    |
| `TargetSiteNotFound`                | Target SPO site does not exist        | Create target site before re-running            |
| `AccessDenied_Source`               | Insufficient permissions on source    | Verify farm admin access                        |
| `AccessDenied_Target`               | Insufficient permissions on target    | Verify SPO admin role                           |
| `ContentTypeMismatch`               | Content type does not exist in target | Create content type in target before re-running |
| `ManagedMetadataTermNotFound`       | Term not in SPO term store            | Migrate term store before content               |
| `Throttled`                         | SPO API throttling                    | Wait and retry; reduce parallel tasks           |

### 6.2 Incremental re-run for failed items

```powershell
# Re-run migration to capture failed items and new changes
# SPMT automatically runs incrementally -- only processes changed/failed items

Register-SPMTMigration `
    -SPOUrl "https://contoso.sharepoint.com" `
    -SPOCredential $spoCredential `
    -Force

Add-SPMTTask `
    -SharePointSourceSiteUrl "https://sp2016.contoso.com/sites/finance" `
    -TargetSiteUrl "https://contoso.sharepoint.com/sites/finance" `
    -MigrateAll

Start-SPMTMigration
# Only failed/changed items will be processed
```

---

## Step 7: Post-migration tasks

### 7.1 Convert classic pages to modern

```powershell
# Use PnP PowerShell to convert classic pages to modern
Connect-PnPOnline -Url "https://contoso.sharepoint.com/sites/finance" -Interactive

# Convert a single page
ConvertTo-PnPPage -Identity "Home.aspx" -Overwrite

# Convert all pages in a site
$pages = Get-PnPListItem -List "Site Pages" |
    Where-Object { $_["ContentType"].Name -ne "Site Page" }

foreach ($page in $pages) {
    try {
        ConvertTo-PnPPage -Identity $page["FileLeafRef"] -Overwrite
        Write-Host "Converted: $($page['FileLeafRef'])" -ForegroundColor Green
    } catch {
        Write-Warning "Failed to convert: $($page['FileLeafRef']) - $($_.Exception.Message)"
    }
}
```

### 7.2 Configure search

SharePoint Online search indexes content automatically. After migration:

1. Wait 24-48 hours for full indexing
2. Verify search returns migrated content
3. Configure managed properties for custom metadata
4. Set up result sources if needed
5. Configure Microsoft Search bookmarks for common queries

### 7.3 Redirect users

```powershell
# Add URL redirect from old site to new site
# Option 1: IIS URL Rewrite on on-premises web servers
# Option 2: DNS redirect
# Option 3: SharePoint redirect page

# Create a redirect page on the old site
$oldWeb = Get-SPWeb "https://sp2016.contoso.com/sites/finance"
$oldWeb.AllProperties["__RedirectUrl__"] = "https://contoso.sharepoint.com/sites/finance"
$oldWeb.Update()
```

### 7.4 Set source to read-only

```powershell
# Lock the source site collection after migration is validated
Set-SPSite -Identity "https://sp2016.contoso.com/sites/finance" -LockState ReadOnly
```

---

## Step 8: Migration timeline template

| Day       | Activity                                                         | Duration   |
| --------- | ---------------------------------------------------------------- | ---------- |
| Day 1     | Install SPMT, configure settings, create user mapping            | 4 hours    |
| Day 2     | Run SMAT assessment, review findings                             | 4 hours    |
| Day 3-4   | Remediate blockers (rename files, fix paths, migrate term store) | 8-16 hours |
| Day 5     | Run SPMT pre-scan, review warnings                               | 4 hours    |
| Day 6-7   | Execute initial migration (off-hours)                            | 8-48 hours |
| Day 8     | Validate migration results, check reports                        | 4 hours    |
| Day 9     | Remediate failed items, run incremental                          | 4 hours    |
| Day 10    | Convert classic pages to modern                                  | 4 hours    |
| Day 11    | Final incremental sync                                           | 4 hours    |
| Day 12    | Cutover: redirect users, set source to read-only                 | 2 hours    |
| Day 13-14 | Monitor, validate search, support users                          | 8 hours    |

---

## References

- [SPMT documentation](https://learn.microsoft.com/sharepointmigration/introducing-the-sharepoint-migration-tool)
- [SPMT prerequisites](https://learn.microsoft.com/sharepointmigration/spmt-prerequisites)
- [SPMT supported features](https://learn.microsoft.com/sharepointmigration/what-is-supported-spmt)
- [SPMT PowerShell reference](https://learn.microsoft.com/sharepointmigration/overview-spmt-ps-cmdlets)
- [SMAT documentation](https://learn.microsoft.com/sharepointmigration/overview-of-the-sharepoint-migration-assessment-tool)
- [PnP page transformation](https://learn.microsoft.com/sharepoint/dev/transform/modernize-userinterface-site-pages)

---

**Maintainers:** csa-inabox core team
**Last updated:** 2026-04-30
