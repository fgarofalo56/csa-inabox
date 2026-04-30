# Site Collection Migration Guide

**Status:** Authored 2026-04-30
**Audience:** SharePoint administrators and migration engineers executing site-level migrations from SharePoint Server to SharePoint Online.
**Scope:** Site collection migration using SPMT and Migration Manager, including batching strategies, large list handling, site assessment, and versioning considerations.

---

## 1. Site migration overview

Site collection migration is the core activity of any SharePoint on-premises to SPO migration. Every site collection contains document libraries, lists, pages, web parts, permissions, content types, and potentially workflows and customizations. The migration strategy must account for site size, complexity, last activity date, and business criticality.

### Migration tool selection by scenario

| Scenario                        | Recommended tool              | Rationale                                 |
| ------------------------------- | ----------------------------- | ----------------------------------------- |
| Single site < 100 GB            | SPMT (desktop)                | Simple, fast, admin-controlled            |
| 5-50 sites, < 500 GB total      | SPMT (PowerShell batch)       | Scriptable, sequential or parallel        |
| 50+ sites, multi-farm           | Migration Manager             | Centralized dashboard, multi-agent        |
| Complex permissions, metadata   | Third-party (Sharegate)       | Granular control, pre-migration reporting |
| 10,000+ sites, enterprise scale | Migration Manager + FastTrack | Microsoft-led engagement with tooling     |

---

## 2. Pre-migration site assessment

### Run SMAT for site-level inventory

```powershell
# Run SMAT against the entire farm
.\SMAT.exe -SiteURL https://sharepoint.contoso.com -OutputFolder C:\SMAT-Results

# SMAT generates reports for:
# - Checked-out files
# - Customized pages (unghosted)
# - Large lists (> 5,000 items)
# - External BCS connections
# - InfoPath forms
# - Sandbox solutions
# - Custom web parts
# - Locked sites
# - Workflow associations
```

### Site collection inventory with PowerShell

```powershell
# On-premises: Get all site collections with key metrics
Add-PSSnapin Microsoft.SharePoint.PowerShell

Get-SPSite -Limit All | ForEach-Object {
    [PSCustomObject]@{
        Url                = $_.Url
        ContentDatabase    = $_.ContentDatabase.Name
        StorageMB          = [math]::Round($_.Usage.Storage / 1MB, 2)
        SiteCount          = $_.AllWebs.Count
        LastModified       = $_.LastContentModifiedDate
        Owner              = $_.Owner.LoginName
        Template           = $_.RootWeb.WebTemplate + "#" + $_.RootWeb.Configuration
        LockState          = $_.WriteLocked
        CompatibilityLevel = $_.CompatibilityLevel
        CustomSolutions    = ($_.Solutions | Measure-Object).Count
    }
} | Export-Csv -Path "C:\Migration\site-inventory.csv" -NoTypeInformation
```

### Site classification for migration waves

Classify each site collection into migration waves based on complexity:

| Wave                    | Criteria                                                  | Examples                                        |
| ----------------------- | --------------------------------------------------------- | ----------------------------------------------- |
| **Wave 0 -- Pilot**     | Small, low-risk, representative of common patterns        | Team site < 10 GB, standard document libraries  |
| **Wave 1 -- Simple**    | Standard team sites, no customizations, no workflows      | Project sites, department sites, archive sites  |
| **Wave 2 -- Medium**    | Sites with managed metadata, content types, moderate size | Document centers, records repositories          |
| **Wave 3 -- Complex**   | Publishing sites, custom solutions, workflows             | Intranet, department portals, process sites     |
| **Wave 4 -- High-risk** | Large sites (> 100 GB), farm solutions, InfoPath, BCS     | Enterprise search center, LOB integration sites |

### Site assessment checklist

For each site collection in scope, document:

- [ ] Total size (GB) including all subsites and versions
- [ ] Number of subsites (webs)
- [ ] Number of lists and libraries
- [ ] Largest list/library (item count and size)
- [ ] Content types in use (site and list-level)
- [ ] Managed metadata columns (term set references)
- [ ] Custom solutions deployed (sandbox or farm)
- [ ] Workflows (SP 2010, SP 2013, Nintex, K2)
- [ ] InfoPath forms
- [ ] Custom master pages or page layouts
- [ ] Broken permission inheritance (count and depth)
- [ ] External data connections (BCS, web services)
- [ ] Last content modification date
- [ ] Active users (from audit logs or usage analytics)

---

## 3. Target site architecture in SPO

### Flat architecture vs subsites

SharePoint Online best practice is a **flat site architecture** using hub sites rather than deep subsite hierarchies:

| On-premises pattern                                      | SPO target pattern                                        |
| -------------------------------------------------------- | --------------------------------------------------------- |
| Site collection with 5+ levels of subsites               | Multiple site collections associated to a hub site        |
| Department site collection /sites/HR/Benefits/Enrollment | /sites/hr-benefits, /sites/hr-enrollment (hub-associated) |
| Publishing site collection with subsite hierarchy        | Communication site with hub navigation                    |
| Project site /sites/projects/project-alpha               | /sites/project-alpha (associated to projects hub)         |

### Create target sites with PnP PowerShell

```powershell
# Connect to SPO tenant
Connect-PnPOnline -Url https://contoso-admin.sharepoint.com -Interactive

# Create a hub site
$hubSite = New-PnPSite -Type CommunicationSite `
    -Title "Finance Department" `
    -Url "https://contoso.sharepoint.com/sites/finance" `
    -Description "Finance department hub"

Register-PnPHubSite -Site "https://contoso.sharepoint.com/sites/finance"

# Create team sites and associate to hub
$teamSites = @(
    @{ Title = "Finance - Accounts Payable"; Url = "finance-ap" },
    @{ Title = "Finance - Accounts Receivable"; Url = "finance-ar" },
    @{ Title = "Finance - Budget Planning"; Url = "finance-budget" }
)

foreach ($site in $teamSites) {
    New-PnPSite -Type TeamSite `
        -Title $site.Title `
        -Alias $site.Url

    Add-PnPHubSiteAssociation `
        -Site "https://contoso.sharepoint.com/sites/$($site.Url)" `
        -HubSite "https://contoso.sharepoint.com/sites/finance"
}
```

---

## 4. Site migration with SPMT

### Single site migration

```powershell
Import-Module Microsoft.SharePoint.MigrationTool.PowerShell

# Initialize SPMT session
Register-SPMTMigration -SPOUrl "https://contoso.sharepoint.com" `
    -SPOCredential (Get-Credential) `
    -Force

# Add migration task
Add-SPMTTask `
    -SharePointSourceSiteUrl "https://sp2016.contoso.com/sites/finance" `
    -TargetSiteUrl "https://contoso.sharepoint.com/sites/finance" `
    -MigrateAll

# Start migration
Start-SPMTMigration
```

### Batch migration with CSV

Create a CSV file defining multiple migration tasks:

```csv
Source,SourceDocLib,SourceSubFolder,TargetWeb,TargetDocLib,TargetSubFolder
https://sp2016.contoso.com/sites/finance,,/,https://contoso.sharepoint.com/sites/finance,,/
https://sp2016.contoso.com/sites/hr,,/,https://contoso.sharepoint.com/sites/hr,,/
https://sp2016.contoso.com/sites/legal,,/,https://contoso.sharepoint.com/sites/legal,,/
https://sp2016.contoso.com/sites/marketing,,/,https://contoso.sharepoint.com/sites/marketing,,/
```

```powershell
# Register and run batch migration
Register-SPMTMigration -SPOUrl "https://contoso.sharepoint.com" `
    -SPOCredential (Get-Credential) -Force

Add-SPMTTask -SharePointMigrationSourceCSV "C:\Migration\batch-sites.csv"

Start-SPMTMigration
```

### SPMT migration settings

```powershell
# Configure SPMT settings before adding tasks
$settings = @{
    MigrateFileVersionHistory    = $true
    KeepAllVersions              = $false
    NumberOfVersionToMigrate     = 10       # Last 10 versions per file
    EnableIncremental            = $true     # Support incremental runs
    PreserveUserPermissionsForDocumentLibrary = $true
    PreserveUserPermissionsForLists = $true
    MigrateHiddenItems           = $true
    MigrateItemsCreatedAfter     = "2020-01-01" # Optional: filter by date
    MigrateItemsModifiedAfter    = "2020-01-01" # Optional: filter by date
    SkipListWithAudienceEnabled  = $false
    FilterOutPathSpecialCharacters = $true
    AzureActiveDirectoryLookup   = $true     # Map on-prem users to Entra
    UserMappingCSVFile           = "C:\Migration\user-mapping.csv"
}
```

---

## 5. Large list handling

SharePoint Online has a list view threshold of 5,000 items for classic views (modern views handle large lists better through automatic indexing). Lists with more than 20,000 items require special consideration during migration.

### Pre-migration list assessment

```powershell
# Find large lists across all site collections
Get-SPSite -Limit All | ForEach-Object {
    $site = $_
    $_.AllWebs | ForEach-Object {
        $web = $_
        $_.Lists | Where-Object { $_.ItemCount -gt 5000 } | ForEach-Object {
            [PSCustomObject]@{
                SiteUrl   = $site.Url
                WebUrl    = $web.Url
                ListTitle = $_.Title
                ItemCount = $_.ItemCount
                SizeMB    = [math]::Round(($_.Items | Measure-Object -Property File.Length -Sum).Sum / 1MB, 2)
                Template  = $_.BaseTemplate
            }
        }
    }
} | Export-Csv -Path "C:\Migration\large-lists.csv" -NoTypeInformation
```

### Large list migration strategies

| List size                 | Strategy                           | Notes                                                           |
| ------------------------- | ---------------------------------- | --------------------------------------------------------------- |
| 5,000 - 20,000 items      | Migrate as-is                      | SPO handles well with modern views and automatic indexing       |
| 20,000 - 100,000 items    | Migrate as-is with indexed columns | Ensure critical filter/sort columns are indexed in SPO          |
| 100,000 - 1,000,000 items | Evaluate alternatives              | Consider Dataverse, Azure SQL, or splitting into multiple lists |
| > 1,000,000 items         | Do not migrate to SPO list         | Move to Dataverse, Azure SQL, or Power BI dataset               |

!!! warning "SPO list limit"
SharePoint Online supports up to 30 million items per list, but performance degrades significantly above 100,000 items without proper indexing. Lists with complex views, calculated columns, or lookup columns perform worse at scale.

---

## 6. Version history management

Version history is frequently the largest contributor to migration size and duration. A 1 GB document library with 500 versions per file can consume 50+ GB when fully versioned.

### Version migration strategies

| Strategy                     | SPMT setting                    | Use when                                    |
| ---------------------------- | ------------------------------- | ------------------------------------------- |
| Migrate all versions         | `KeepAllVersions = $true`       | Regulatory requirement, legal hold          |
| Migrate last N versions      | `NumberOfVersionToMigrate = 10` | Balance between history and speed           |
| Migrate current version only | `NumberOfVersionToMigrate = 1`  | Maximum speed, acceptable for archive sites |
| Migrate versions after date  | `MigrateItemsModifiedAfter`     | Only recent activity matters                |

### Calculate version impact

```powershell
# Estimate version storage impact for a document library
$web = Get-SPWeb "https://sp2016.contoso.com/sites/finance"
$list = $web.Lists["Shared Documents"]

$versionStats = $list.Items | ForEach-Object {
    $item = $_
    [PSCustomObject]@{
        FileName      = $item.File.Name
        CurrentSizeMB = [math]::Round($item.File.Length / 1MB, 2)
        VersionCount  = $item.File.Versions.Count
        TotalSizeMB   = [math]::Round(
            ($item.File.Length + ($item.File.Versions | Measure-Object -Property Size -Sum).Sum) / 1MB, 2
        )
    }
}

$totalCurrentMB = ($versionStats | Measure-Object -Property CurrentSizeMB -Sum).Sum
$totalWithVersionsMB = ($versionStats | Measure-Object -Property TotalSizeMB -Sum).Sum
$versionOverhead = [math]::Round(($totalWithVersionsMB - $totalCurrentMB) / $totalCurrentMB * 100, 1)

Write-Host "Current size: $totalCurrentMB MB"
Write-Host "With versions: $totalWithVersionsMB MB"
Write-Host "Version overhead: $versionOverhead%"
```

---

## 7. Subsite to site collection conversion

For sites with deep subsite hierarchies, convert subsites to standalone site collections before or during migration:

### Option 1: Migrate subsites as-is, then restructure

1. Migrate the entire site collection including subsites to SPO
2. Use the **SharePoint Admin Center** or PnP PowerShell to create new site collections
3. Move content from subsites to new site collections using **Move-PnPFile** and **Copy-PnPFile**
4. Associate new site collections to a hub site

### Option 2: Selective migration (subsites to individual site collections)

```powershell
# Migrate each subsite to a separate SPO site collection
$subsites = @(
    @{
        Source = "https://sp2016.contoso.com/sites/finance/ap"
        Target = "https://contoso.sharepoint.com/sites/finance-ap"
    },
    @{
        Source = "https://sp2016.contoso.com/sites/finance/ar"
        Target = "https://contoso.sharepoint.com/sites/finance-ar"
    }
)

foreach ($subsite in $subsites) {
    Add-SPMTTask `
        -SharePointSourceSiteUrl $subsite.Source `
        -TargetSiteUrl $subsite.Target `
        -MigrateAll
}
```

---

## 8. Incremental migration

SPMT and Migration Manager support incremental migration, allowing you to run the initial migration and then re-run to capture changes made during the migration window.

### Incremental migration workflow

1. **Initial migration** (T-14 days): Run full migration during off-hours
2. **Incremental sync** (T-7 days): Re-run migration to capture changes since initial run
3. **Final sync** (T-0, cutover): Run final incremental sync, then switch users to SPO
4. **Set source to read-only** after final sync to prevent further changes

```powershell
# Enable incremental migration in SPMT
Register-SPMTMigration -SPOUrl "https://contoso.sharepoint.com" `
    -SPOCredential (Get-Credential) -Force

# Same task definition as initial run -- SPMT detects incremental
Add-SPMTTask `
    -SharePointSourceSiteUrl "https://sp2016.contoso.com/sites/finance" `
    -TargetSiteUrl "https://contoso.sharepoint.com/sites/finance" `
    -MigrateAll

Start-SPMTMigration
# SPMT will only migrate items changed since the last successful run
```

---

## 9. Post-migration validation

### Content validation checklist

- [ ] Total item count matches source (within tolerance for filtered/excluded items)
- [ ] Document library file counts match
- [ ] List item counts match
- [ ] Managed metadata columns display correct terms
- [ ] Content types are associated correctly
- [ ] Version history is present (per migration settings)
- [ ] Check-in/check-out status is correct
- [ ] Created/modified dates and users are preserved
- [ ] Folder structure is intact

### Permission validation

```powershell
# Validate permissions on target site
Connect-PnPOnline -Url "https://contoso.sharepoint.com/sites/finance" -Interactive

# Get site permissions
Get-PnPSiteGroup | ForEach-Object {
    [PSCustomObject]@{
        GroupName = $_.Title
        Users     = ($_.Users | Select-Object -ExpandProperty Email) -join "; "
        Roles     = ($_.Roles | Select-Object -ExpandProperty Name) -join "; "
    }
} | Format-Table -AutoSize

# Check for broken inheritance
Get-PnPList | ForEach-Object {
    [PSCustomObject]@{
        ListTitle          = $_.Title
        HasUniquePerms     = $_.HasUniqueRoleAssignments
        ItemCount          = $_.ItemCount
    }
} | Where-Object { $_.HasUniquePerms } | Format-Table -AutoSize
```

### Search validation

After migration, SPO search indexes content automatically. Allow 24-48 hours for full indexing, then validate:

- [ ] Search returns results from migrated content
- [ ] Managed properties are populated correctly
- [ ] Content types appear in search refiners
- [ ] People search returns correct profile information

---

## 10. Troubleshooting common issues

| Issue                               | Cause                                                 | Resolution                                                            |
| ----------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------- |
| Files skipped -- invalid characters | On-prem allows characters that SPO does not (#, %, &) | Rename files pre-migration or enable `FilterOutPathSpecialCharacters` |
| Files skipped -- path too long      | SPO path limit is 400 characters                      | Shorten folder names or restructure hierarchy                         |
| Files skipped -- file size > 250 GB | SPO file size limit is 250 GB                         | Split files or use Azure Blob Storage                                 |
| Slow migration speed                | Network bandwidth, throttling, large versions         | Reduce version count, increase agents, use off-hours                  |
| Permission mapping failures         | AD users not synced to Entra ID                       | Verify Entra Connect sync; use user mapping CSV                       |
| Managed metadata not mapping        | Term store not migrated                               | Migrate term store before content; map term set IDs                   |
| Modern pages not rendering          | Classic web parts not supported in modern             | Convert pages post-migration; use PnP page transformation             |

---

## References

- [SPMT documentation](https://learn.microsoft.com/sharepointmigration/introducing-the-sharepoint-migration-tool)
- [Migration Manager documentation](https://learn.microsoft.com/sharepointmigration/mm-get-started)
- [SharePoint Online limits](https://learn.microsoft.com/office365/servicedescriptions/sharepoint-online-service-description/sharepoint-online-limits)
- [PnP PowerShell](https://pnp.github.io/powershell/)
- [Site collection to hub site planning](https://learn.microsoft.com/sharepoint/planning-hub-sites)

---

**Maintainers:** csa-inabox core team
**Last updated:** 2026-04-30
