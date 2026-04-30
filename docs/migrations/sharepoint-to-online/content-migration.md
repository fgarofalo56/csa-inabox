# Content Migration Guide

**Status:** Authored 2026-04-30
**Audience:** SharePoint administrators, content architects, and migration engineers managing document library, list, metadata, and content type migration from SharePoint Server to SharePoint Online.
**Scope:** Document libraries, lists, managed metadata service, content types, taxonomy planning, and large file handling.

---

## 1. Content migration overview

Content migration encompasses everything stored in SharePoint: documents in libraries, items in lists, metadata attached to both, content types that define structure, and the managed metadata service (term store) that provides controlled vocabularies. A successful content migration preserves not just files, but the relationships, classifications, and governance structures built around them.

### Content migration sequence

The order of migration matters. Dependencies must be resolved before dependent content is migrated:

1. **Managed metadata (term store)** -- terms must exist in SPO before content referencing them is migrated
2. **Content types** -- content types must be published to SPO before lists/libraries using them are migrated
3. **Site columns** -- custom columns must be created or migrated before lists using them are migrated
4. **Document libraries and lists** -- content migration after metadata infrastructure is in place
5. **Permissions** -- migrated with content or applied post-migration

---

## 2. Document library migration

### Pre-migration library assessment

```powershell
# Assess document libraries across a site collection
Add-PSSnapin Microsoft.SharePoint.PowerShell

$site = Get-SPSite "https://sp2016.contoso.com/sites/finance"

$site.AllWebs | ForEach-Object {
    $web = $_
    $_.Lists | Where-Object { $_.BaseType -eq "DocumentLibrary" -and -not $_.Hidden } | ForEach-Object {
        [PSCustomObject]@{
            WebUrl           = $web.Url
            LibraryTitle     = $_.Title
            ItemCount        = $_.ItemCount
            SizeMB           = [math]::Round(($_.Items | ForEach-Object { $_.File.Length } |
                                Measure-Object -Sum).Sum / 1MB, 2)
            ContentTypes     = ($_.ContentTypes | Select-Object -ExpandProperty Name) -join "; "
            VersioningEnabled = $_.EnableVersioning
            MajorVersions    = $_.MajorVersionLimit
            MinorVersions    = $_.MajorWithMinorVersionsLimit
            CheckoutRequired = $_.ForceCheckout
            HasFolders       = ($_.Folders.Count -gt 1)
            LastModified     = $_.LastItemModifiedDate
        }
    }
} | Export-Csv -Path "C:\Migration\library-inventory.csv" -NoTypeInformation
```

### File-level considerations

| Consideration               | On-premises               | SPO limit                                                                                                | Action                                                 |
| --------------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ------------- | ------------------------------------------------------ |
| **File size**               | Limited by IIS/SQL config | 250 GB per file                                                                                          | Files > 250 GB cannot migrate; split or use Azure Blob |
| **File name length**        | 128 characters (filename) | 400 characters (full path)                                                                               | Verify full path length including site URL             |
| **Invalid characters**      | `\* : < > ? / \           | ` restricted                                                                                             | `" # % \* : < > ? / \                                  | ~` restricted | Additional characters blocked; rename before migration |
| **File types blocked**      | Configurable per farm     | [Blocked file types list](https://learn.microsoft.com/sharepoint/technical-reference/blocked-file-types) | Review and rename extensions                           |
| **Total items per library** | Practical limit ~10M      | 30 million items                                                                                         | Supported but performance considerations at scale      |
| **File path length**        | ~260 characters (NTFS)    | 400 characters (URL encoded)                                                                             | SPO is more permissive; rarely an issue                |

### Large file handling

For document libraries containing files larger than 15 GB:

```powershell
# Find files larger than 15 GB across the farm
Get-SPSite -Limit All | ForEach-Object {
    $_.AllWebs | ForEach-Object {
        $web = $_
        $_.Lists | Where-Object { $_.BaseType -eq "DocumentLibrary" } | ForEach-Object {
            $_.Items | Where-Object { $_.File.Length -gt 15GB } | ForEach-Object {
                [PSCustomObject]@{
                    WebUrl    = $web.Url
                    Library   = $_.ParentList.Title
                    FileName  = $_.File.Name
                    SizeGB    = [math]::Round($_.File.Length / 1GB, 2)
                }
            }
        }
    }
} | Export-Csv -Path "C:\Migration\large-files.csv" -NoTypeInformation
```

!!! tip "Azure Blob Storage for large media files"
Video files, CAD drawings, and other large binary files exceeding 100 GB should be evaluated for Azure Blob Storage rather than SPO document libraries. Use Azure CDN for streaming and link from SharePoint pages.

---

## 3. List migration

### List type mapping

| On-premises list type | SPO equivalent                      | Migration notes                                                    |
| --------------------- | ----------------------------------- | ------------------------------------------------------------------ |
| Custom list           | Modern list                         | Direct migration; modern experience applies automatically          |
| Announcements         | News web part or modern list        | Consider converting announcements to SPO news posts                |
| Calendar              | Modern events list or Outlook       | SPO calendar list available; consider Microsoft 365 group calendar |
| Contacts              | Modern list or Outlook contacts     | Direct migration; consider Microsoft 365 contacts                  |
| Tasks                 | Modern list or Planner              | Direct migration; consider Microsoft Planner for task management   |
| Discussion board      | Viva Engage or Teams channel        | Discussion boards deprecated in modern; redirect to Viva Engage    |
| Survey                | Microsoft Forms                     | Surveys deprecated in modern SPO; use Microsoft Forms              |
| Issue tracking        | Modern list with status column      | Direct migration; modern list with column formatting               |
| Links                 | Modern list or quick links web part | Direct migration or convert to quick links web part                |
| External list (BCS)   | Power Apps + custom connector       | BCS deprecated; redesign with Power Platform                       |

### List data migration with PnP

```powershell
# Migrate list items with metadata using PnP PowerShell
# Source connection
Connect-PnPOnline -Url "https://sp2016.contoso.com/sites/finance" -Credentials $onPremCreds

$sourceItems = Get-PnPListItem -List "Project Tracker" -PageSize 500

# Target connection
Connect-PnPOnline -Url "https://contoso.sharepoint.com/sites/finance" -Interactive

foreach ($item in $sourceItems) {
    $values = @{
        "Title"           = $item["Title"]
        "ProjectStatus"   = $item["ProjectStatus"]
        "ProjectManager"  = $item["ProjectManager"].Email  # User field
        "Budget"          = $item["Budget"]
        "StartDate"       = $item["StartDate"]
        "DueDate"         = $item["DueDate"]
        "Department"      = $item["Department"].Label       # Managed metadata
    }

    Add-PnPListItem -List "Project Tracker" -Values $values
}
```

---

## 4. Managed metadata service migration

The managed metadata service (MMS) provides the term store for managed metadata columns, enterprise keywords, and content type syndication. SPO has a single term store per tenant.

### Term store architecture differences

| Aspect                    | On-premises       | SPO                             |
| ------------------------- | ----------------- | ------------------------------- |
| Term stores               | Multiple per farm | One per tenant                  |
| Term store administrators | Farm-level        | Tenant-level (SharePoint admin) |
| Term groups               | Unlimited         | Unlimited                       |
| Term sets                 | Unlimited         | Unlimited                       |
| Terms per term set        | 30,000            | 30,000                          |
| Total terms               | 1,000,000         | 1,000,000                       |
| Nesting depth             | 7 levels          | 7 levels                        |
| Custom properties         | Supported         | Supported                       |
| Translations              | Supported         | Supported                       |

### Export term store from on-premises

```powershell
# Export term store to CSV for migration
Add-PSSnapin Microsoft.SharePoint.PowerShell

$site = Get-SPSite "https://sp2016.contoso.com"
$session = Get-SPTaxonomySession -Site $site
$termStore = $session.TermStores[0]

$termData = @()

foreach ($group in $termStore.Groups) {
    foreach ($termSet in $group.TermSets) {
        foreach ($term in $termSet.GetAllTerms()) {
            $termData += [PSCustomObject]@{
                GroupName     = $group.Name
                GroupId       = $group.Id
                TermSetName   = $termSet.Name
                TermSetId     = $termSet.Id
                TermName      = $term.Name
                TermId        = $term.Id
                ParentTermId  = if ($term.Parent) { $term.Parent.Id } else { "" }
                IsAvailable   = $term.IsAvailableForTagging
                CustomProps   = ($term.CustomProperties.GetEnumerator() |
                                ForEach-Object { "$($_.Key)=$($_.Value)" }) -join "; "
            }
        }
    }
}

$termData | Export-Csv -Path "C:\Migration\term-store-export.csv" -NoTypeInformation
```

### Import term store to SPO

```powershell
# Import terms to SPO using PnP PowerShell
Connect-PnPOnline -Url "https://contoso-admin.sharepoint.com" -Interactive

# Import from CSV (PnP format)
# CSV columns: TermSetName, TermSetDescription, LCID, AvailableForTagging, TermDescription, Level1, Level2, Level3...
Import-PnPTermGroupFromXml -Path "C:\Migration\term-store.xml"

# Or create terms programmatically
$termGroup = New-PnPTermGroup -GroupName "Corporate Taxonomy"

$termSet = New-PnPTermSet -TermGroup "Corporate Taxonomy" `
    -TermSet "Departments" `
    -Lcid 1033

New-PnPTerm -TermGroup "Corporate Taxonomy" `
    -TermSet "Departments" `
    -Term "Finance" `
    -Lcid 1033

New-PnPTerm -TermGroup "Corporate Taxonomy" `
    -TermSet "Departments" `
    -Term "Human Resources" `
    -Lcid 1033
```

---

## 5. Content type migration

### Content type hub migration

On-premises SharePoint uses a content type hub (a dedicated site collection) to syndicate content types across web applications. SPO uses the **Content Type Gallery** at the tenant level.

```powershell
# Export content types from on-premises content type hub
$hubSite = Get-SPSite "https://sp2016.contoso.com/sites/contenttypehub"
$rootWeb = $hubSite.RootWeb

$contentTypes = $rootWeb.ContentTypes | Where-Object { -not $_.Hidden } | ForEach-Object {
    [PSCustomObject]@{
        Name          = $_.Name
        Id            = $_.Id
        Group         = $_.Group
        Description   = $_.Description
        Parent        = $_.Parent.Name
        FieldCount    = $_.Fields.Count
        Fields        = ($_.Fields | Where-Object { -not $_.Hidden } |
                        Select-Object -ExpandProperty InternalName) -join "; "
    }
}

$contentTypes | Export-Csv -Path "C:\Migration\content-types.csv" -NoTypeInformation
```

### Recreate content types in SPO

```powershell
Connect-PnPOnline -Url "https://contoso.sharepoint.com/sites/finance" -Interactive

# Create a content type
Add-PnPContentType -Name "Project Document" `
    -Description "Document associated with a project" `
    -Group "Custom Content Types" `
    -ParentContentType "Document"

# Add site columns to the content type
Add-PnPFieldToContentType -Field "ProjectName" -ContentType "Project Document"
Add-PnPFieldToContentType -Field "ProjectStatus" -ContentType "Project Document"
Add-PnPFieldToContentType -Field "Department" -ContentType "Project Document"

# Publish content type to the content type gallery (tenant-level)
# Use the SharePoint admin center or PnP provisioning templates
```

---

## 6. Taxonomy planning for SPO

### Design principles for SPO taxonomy

1. **Consolidate term stores** -- if multiple farms had separate term stores, merge into one SPO term store
2. **Clean up before migration** -- remove deprecated terms, orphaned term sets, and unused groups
3. **Plan for M365-wide usage** -- SPO term store is used by Purview, Teams, and other M365 services
4. **Map managed metadata columns** -- ensure every managed metadata column in source maps to the correct term set in SPO

### Term set ID mapping

When source and target term sets have different GUIDs (which they will unless you explicitly set GUIDs during import), you must provide a mapping file for SPMT:

```csv
SourceTermSetId,TargetTermSetId,SourceTermId,TargetTermId
{source-guid-1},{target-guid-1},{source-term-guid-1},{target-term-guid-1}
{source-guid-2},{target-guid-2},{source-term-guid-2},{target-term-guid-2}
```

!!! tip "Preserve term GUIDs during import"
If you use PnP PowerShell to import terms with the same GUIDs as the source, managed metadata columns will resolve automatically during content migration. This is the recommended approach.

---

## 7. Metadata preservation during migration

### What SPMT preserves

| Metadata                    | Preserved by SPMT       | Notes                                      |
| --------------------------- | ----------------------- | ------------------------------------------ |
| Created date/time           | Yes                     | Original creation timestamp                |
| Modified date/time          | Yes                     | Original modification timestamp            |
| Created by                  | Yes (with user mapping) | Requires Entra ID sync or user mapping CSV |
| Modified by                 | Yes (with user mapping) | Requires Entra ID sync or user mapping CSV |
| File version history        | Yes (configurable)      | Number of versions configurable            |
| Content type                | Yes                     | Content type must exist in target          |
| Site columns / list columns | Yes                     | Columns must exist in target               |
| Managed metadata values     | Yes (with term mapping) | Term store must be migrated first          |
| Choice column values        | Yes                     | Direct mapping                             |
| Lookup column values        | Yes (with list mapping) | Lookup list must be migrated first         |
| Person/group column values  | Yes (with user mapping) | Users must exist in Entra ID               |
| Calculated columns          | Yes                     | Formula preserved; validate post-migration |
| Default column values       | Yes                     | Validated post-migration                   |
| Column validation rules     | Partial                 | Some rules may not translate               |

### User mapping

Create a user mapping CSV to map on-premises AD accounts to Entra ID accounts:

```csv
Source,Target
CONTOSO\jsmith,john.smith@contoso.com
CONTOSO\jdoe,jane.doe@contoso.com
CONTOSO\svc-sharepoint,svc-sharepoint@contoso.com
```

```powershell
# Generate user mapping CSV from AD and Entra ID
$adUsers = Get-ADUser -Filter * -Properties EmailAddress, SamAccountName |
    Where-Object { $_.Enabled -eq $true }

$mapping = $adUsers | ForEach-Object {
    [PSCustomObject]@{
        Source = "CONTOSO\$($_.SamAccountName)"
        Target = $_.EmailAddress
    }
} | Where-Object { $_.Target -ne $null }

$mapping | Export-Csv -Path "C:\Migration\user-mapping.csv" -NoTypeInformation
```

---

## 8. Post-migration content validation

### Validation script

```powershell
# Compare source and target content counts
Connect-PnPOnline -Url "https://contoso.sharepoint.com/sites/finance" -Interactive

$targetLists = Get-PnPList | Where-Object { -not $_.Hidden }

$validation = $targetLists | ForEach-Object {
    [PSCustomObject]@{
        ListTitle     = $_.Title
        TargetCount   = $_.ItemCount
        ListType      = $_.BaseType
        LastModified  = $_.LastItemModifiedDate
    }
}

$validation | Format-Table -AutoSize

# Compare against source inventory CSV
$sourceInventory = Import-Csv "C:\Migration\library-inventory.csv"

foreach ($target in $validation) {
    $source = $sourceInventory | Where-Object { $_.LibraryTitle -eq $target.ListTitle }
    if ($source) {
        $diff = $target.TargetCount - [int]$source.ItemCount
        if ($diff -ne 0) {
            Write-Warning "Mismatch: $($target.ListTitle) - Source: $($source.ItemCount), Target: $($target.TargetCount), Diff: $diff"
        }
    }
}
```

---

## 9. Content cleanup before migration

### Recommended pre-migration cleanup

1. **Delete orphaned files** -- files in recycle bin, files with no parent folder
2. **Remove old versions** -- trim version history to last 10-20 versions for non-regulated content
3. **Archive inactive libraries** -- libraries not modified in 2+ years; migrate to archive site or skip
4. **Fix broken metadata** -- content types with missing fields, managed metadata with orphaned terms
5. **Resolve checked-out files** -- force check-in or notify users to check in before migration
6. **Remove duplicate files** -- use SMAT or third-party tools to identify duplicates

```powershell
# Find checked-out files across a site collection
$site = Get-SPSite "https://sp2016.contoso.com/sites/finance"
$site.AllWebs | ForEach-Object {
    $_.Lists | Where-Object { $_.BaseType -eq "DocumentLibrary" } | ForEach-Object {
        $_.CheckedOutFiles | ForEach-Object {
            [PSCustomObject]@{
                Url           = $_.Url
                CheckedOutBy  = $_.CheckedOutByName
                CheckedOutDate = $_.TimeLastModified
            }
        }
    }
} | Export-Csv -Path "C:\Migration\checked-out-files.csv" -NoTypeInformation
```

---

## References

- [SPMT supported content](https://learn.microsoft.com/sharepointmigration/what-is-supported-spmt)
- [SharePoint Online content limits](https://learn.microsoft.com/office365/servicedescriptions/sharepoint-online-service-description/sharepoint-online-limits)
- [Managed metadata migration](https://learn.microsoft.com/sharepointmigration/managed-metadata-migration)
- [PnP provisioning for content types](https://learn.microsoft.com/sharepoint/dev/solution-guidance/pnp-provisioning-framework)
- [Content type gallery in SPO](https://learn.microsoft.com/sharepoint/manage-content-type-publishing)

---

**Maintainers:** csa-inabox core team
**Last updated:** 2026-04-30
