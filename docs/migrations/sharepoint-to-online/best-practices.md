# SharePoint Migration Best Practices

**Status:** Authored 2026-04-30
**Audience:** Migration leads, solution architects, and program managers planning or executing a SharePoint on-premises to SharePoint Online migration.
**Scope:** Assessment-first approach, SMAT scanning, pilot site selection, user adoption, modern page conversion, governance planning, and CSA-in-a-Box Purview integration.

---

## Overview

Migrating SharePoint on-premises to SharePoint Online is a 12-24 week program for mid-to-large organizations. The technical steps are documented in the companion tutorials and migration guides. This document covers the practices that make or break the migration: thorough assessment, architecture planning, pilot validation, user adoption, and governance deployment. Organizations that skip assessment or user adoption planning experience 3-5x more remediation effort post-migration.

---

## 1. Assessment-first approach

### Never migrate without assessing first

The single most important practice is running a comprehensive assessment before writing a single migration script. Assessment reveals:

- Content that should be retired (not migrated)
- Customizations that will break in SPO
- Workflows that require Power Automate redesign
- InfoPath forms that require Power Apps conversion
- Large lists that need restructuring
- Permission models that need simplification

### SMAT assessment checklist

Run the SharePoint Migration Assessment Tool (SMAT) across every farm:

```powershell
# Run SMAT with all assessments
.\SMAT.exe -SiteURL https://sharepoint.contoso.com `
    -OutputFolder C:\SMAT-Results `
    -Verbose

# Review these critical reports:
# 1. ScanSummary.csv -- top-level overview
# 2. LargeListFiles.csv -- lists exceeding thresholds
# 3. CheckedOutFiles.csv -- checked-out files (cannot be migrated as-is)
# 4. CustomizedFiles.csv -- unghosted pages (modified from template)
# 5. WorkflowAssociations2010.csv -- SP 2010 workflows to redesign
# 6. WorkflowAssociations2013.csv -- SP 2013 workflows to redesign
# 7. InfoPathForms.csv -- InfoPath forms to convert
# 8. SandboxSolutions.csv -- sandbox solutions to convert
# 9. BrowserFileHandling.csv -- file handling settings
# 10. SiteTemplateUsage.csv -- templates in use
```

### Content audit: keep, migrate, or retire

| Content category                               | Action                        | Criteria                                       |
| ---------------------------------------------- | ----------------------------- | ---------------------------------------------- |
| **Active content** (modified within 12 months) | Migrate                       | Current, actively used                         |
| **Warm content** (modified 1-3 years ago)      | Migrate with reduced versions | Occasionally referenced                        |
| **Cold content** (modified 3+ years ago)       | Evaluate: archive or retire   | May not warrant migration cost                 |
| **Orphaned sites** (no active owner)           | Retire                        | No business owner = no migration justification |
| **Duplicate content**                          | Consolidate then migrate      | Reduce storage and confusion                   |
| **Personal content in team sites**             | Move to OneDrive              | Personal files belong in OneDrive              |
| **Test/dev sites**                             | Do not migrate                | Recreate in SPO if needed                      |

```powershell
# Identify sites by last modification date
Add-PSSnapin Microsoft.SharePoint.PowerShell

Get-SPSite -Limit All | ForEach-Object {
    $daysSinceModified = (New-TimeSpan -Start $_.LastContentModifiedDate -End (Get-Date)).Days
    [PSCustomObject]@{
        Url              = $_.Url
        SizeMB           = [math]::Round($_.Usage.Storage / 1MB, 2)
        LastModified     = $_.LastContentModifiedDate
        DaysSinceModified = $daysSinceModified
        Category         = switch {
            ($daysSinceModified -le 365)  { "Active" }
            ($daysSinceModified -le 1095) { "Warm" }
            default                        { "Cold" }
        }
    }
} | Export-Csv -Path "C:\Migration\site-age-analysis.csv" -NoTypeInformation
```

---

## 2. Architecture planning

### Design the target before migrating

Do not mirror on-premises architecture in SPO. On-premises SharePoint typically has deep subsite hierarchies, multiple web applications, and sprawling content databases. SPO best practice is flat architecture with hub sites.

### Site architecture design principles

1. **Flat hierarchy:** No subsites deeper than one level; use separate site collections associated to hub sites
2. **Hub sites for navigation:** Replace deep navigation with hub site associations
3. **One team = one site:** Each M365 Group/Team gets its own SPO site
4. **Communication sites for publishing:** Replace publishing sites with communication sites
5. **Consistent naming convention:** `/sites/dept-function` (e.g., `/sites/finance-ap`)
6. **Site lifecycle management:** Plan for site creation, review, and archival

### Hub site architecture template

```
Corporate Hub (communication site)
    HR Hub (communication site)
        /sites/hr-policies (team site)
        /sites/hr-recruiting (team site)
        /sites/hr-benefits (team site)
        /sites/hr-training (team site)
    Finance Hub (communication site)
        /sites/finance-ap (team site)
        /sites/finance-ar (team site)
        /sites/finance-budget (team site)
        /sites/finance-reporting (team site)
    IT Hub (communication site)
        /sites/it-helpdesk (team site)
        /sites/it-infrastructure (team site)
        /sites/it-security (team site)
    Projects Hub (communication site)
        /sites/project-alpha (team site)
        /sites/project-beta (team site)
```

---

## 3. Pilot site selection

### Choose pilot sites carefully

The pilot migration validates tooling, processes, and timeline estimates. Choose 3-5 sites that represent common patterns:

| Pilot site                                            | Purpose                  | What it validates                                   |
| ----------------------------------------------------- | ------------------------ | --------------------------------------------------- |
| Small team site (< 1 GB, standard docs)               | Baseline migration       | SPMT configuration, user mapping, basic permissions |
| Medium site with metadata (1-10 GB, managed metadata) | Content type migration   | Term store mapping, content type syndication        |
| Site with custom views and forms                      | UI migration             | Modern page conversion, list form customization     |
| Large document library (> 100 GB)                     | Scale testing            | Throughput, version handling, large file support    |
| Site with known customizations                        | Customization assessment | SPFx readiness, workflow identification             |

### Pilot success criteria

- [ ] All documents migrated with correct metadata
- [ ] Permissions match source (validated by security team)
- [ ] Created/modified dates and users are preserved
- [ ] Managed metadata columns display correct terms
- [ ] Search returns results from migrated content
- [ ] Modern page experience is acceptable to users
- [ ] Migration throughput meets timeline requirements
- [ ] User mapping works correctly for all account types

---

## 4. User adoption and training

### Communication plan

| Timing        | Communication                                          | Audience       | Channel               |
| ------------- | ------------------------------------------------------ | -------------- | --------------------- |
| T-8 weeks     | Migration announcement                                 | All users      | Email + intranet      |
| T-4 weeks     | What's changing (modern experience)                    | All users      | Video + FAQ page      |
| T-2 weeks     | Site-specific migration schedule                       | Affected users | Email to site owners  |
| T-1 week      | Pre-migration instructions (save work, check in files) | Affected users | Email + Teams         |
| T-0 (cutover) | Migration complete notification with new URLs          | Affected users | Email + Teams         |
| T+1 week      | Tips for modern SharePoint                             | All users      | Email + training site |
| T+2 weeks     | Feedback survey                                        | Migrated users | Microsoft Forms       |

### Training content

| Topic                             | Format            | Duration   | Audience        |
| --------------------------------- | ----------------- | ---------- | --------------- |
| Modern SharePoint overview        | Video             | 15 minutes | All users       |
| Navigating modern sites and hubs  | Interactive guide | 20 minutes | All users       |
| Modern document library features  | Hands-on lab      | 30 minutes | Power users     |
| OneDrive sync and Files On-Demand | Video + guide     | 15 minutes | All users       |
| Power Automate for approvals      | Workshop          | 1 hour     | Workflow owners |
| Power Apps list forms             | Workshop          | 1 hour     | Form owners     |
| SPFx development intro            | Workshop          | 2 hours    | Developers      |
| SharePoint admin center           | Training session  | 1 hour     | IT admins       |

### Champion network

1. Identify 1-2 champions per department (power users who advocate for the new platform)
2. Train champions 2-4 weeks before migration
3. Champions provide first-line support during and after migration
4. Champions gather feedback and report issues through a dedicated Teams channel

---

## 5. Modern page conversion

### Convert classic pages to modern

After content migration, classic pages render in SPO but do not provide the modern experience. Convert pages to modern using PnP PowerShell:

```powershell
Connect-PnPOnline -Url "https://contoso.sharepoint.com/sites/finance" -Interactive

# Convert all classic pages to modern
$pages = Get-PnPListItem -List "Site Pages"

foreach ($page in $pages) {
    $fileName = $page["FileLeafRef"]
    if ($fileName -like "*.aspx" -and $page["ContentType"].Name -ne "Site Page") {
        try {
            ConvertTo-PnPPage -Identity $fileName -Overwrite -TakeSourcePageName
            Write-Host "Converted: $fileName" -ForegroundColor Green
        }
        catch {
            Write-Warning "Skipped: $fileName - $($_.Exception.Message)"
        }
    }
}
```

### Web part mapping during conversion

| Classic web part      | Modern equivalent    | Conversion quality              |
| --------------------- | -------------------- | ------------------------------- |
| Content Editor (CEWP) | Text web part        | Good (HTML preserved)           |
| Script Editor         | No direct equivalent | Manual (use SPFx)               |
| Image Viewer          | Image web part       | Good                            |
| List View             | List web part        | Good                            |
| Content Query (CQWP)  | Highlighted Content  | Good (different configuration)  |
| Page Viewer / iFrame  | Embed web part       | Good                            |
| Chart                 | Quick Chart          | Manual reconfiguration          |
| XML Viewer            | No equivalent        | Manual (use SPFx)               |
| DataForm (DVWP)       | No equivalent        | Manual (use SPFx or Power Apps) |
| Calendar              | Events web part      | Partial                         |

---

## 6. Governance planning

### Site lifecycle governance

```powershell
# Configure site lifecycle policies using SharePoint Advanced Management
Connect-SPOService -Url "https://contoso-admin.sharepoint.com"

# Set inactive site policy (notify owners after 180 days of inactivity)
# Configured in SharePoint admin center > Policies > Site lifecycle management

# Set storage quotas
Set-SPOSite -Identity "https://contoso.sharepoint.com/sites/finance" `
    -StorageQuota 10240 `     # 10 GB quota
    -StorageQuotaWarningLevel 8192  # Warning at 8 GB
```

### Information architecture governance

1. **Site creation policy:** Define who can create sites and what templates are available
2. **Naming convention:** Enforce consistent site URLs and display names
3. **Classification:** Apply sensitivity labels to sites based on content type
4. **External sharing:** Set default sharing policies per site classification
5. **Retention:** Apply retention policies based on content type and classification

### Governance documentation

Create and maintain these governance artifacts in SPO:

- [ ] Site request process and approval workflow
- [ ] Site naming convention guide
- [ ] Content type catalog (approved content types and site columns)
- [ ] Term store management guide (who manages which term sets)
- [ ] External sharing policy by content classification
- [ ] Records retention schedule
- [ ] Power Platform governance (who can create flows/apps)

---

## 7. CSA-in-a-Box Purview integration

### Why Purview governance matters for SPO migration

Migrating content to SPO without governance is a risk amplification exercise. Content that was implicitly protected by network boundaries on-premises becomes explicitly accessible through the internet in SPO. Without governance:

- Sensitive content may be shared externally through SPO sharing features
- Copilot for M365 may surface sensitive content to users with overly broad access
- Retention policies from on-premises (information management policies) are not automatically migrated
- Compliance officers lose visibility into content classification

### Deploy Purview governance during migration

| Phase                  | Purview action                             | Timing                        |
| ---------------------- | ------------------------------------------ | ----------------------------- |
| **Preparation**        | Deploy sensitivity labels                  | Before first migration wave   |
| **Preparation**        | Configure DLP policies                     | Before first migration wave   |
| **Preparation**        | Configure retention policies               | Before first migration wave   |
| **Migration Wave 1**   | Apply labels to pilot sites                | During/after pilot migration  |
| **Migration Wave 2-3** | Enable auto-labeling for sensitive content | After pilot validation        |
| **Post-migration**     | Run compliance assessment                  | After all content migrated    |
| **Post-migration**     | Enable Copilot with governance             | After labels and DLP verified |

### Purview configuration for migrated SPO content

```powershell
Connect-IPPSSession

# 1. Create sensitivity labels (see security-migration.md for full configuration)

# 2. Create DLP policies for migrated content
New-DlpCompliancePolicy -Name "Migrated Content Protection" `
    -SharePointLocation All `
    -OneDriveLocation All `
    -Mode Enable

# 3. Create retention policies for migrated content
New-RetentionCompliancePolicy -Name "Default Retention" `
    -SharePointLocation All `
    -OneDriveLocation All `
    -RetentionDuration 2555 `  # 7 years
    -RetentionComplianceAction KeepAndDelete

# 4. Run Purview scan on migrated sites
# Configure in Purview portal > Data Map > Sources > SharePoint Online
```

### Content governance dashboard

After migration, use Power BI to create a governance dashboard that reports on:

- Sensitivity label coverage (% of sites/documents labeled)
- DLP policy matches (content flagged by DLP rules)
- External sharing activity (who shared what externally)
- Inactive sites (sites not modified in 90+ days)
- Storage consumption by department/site
- Version history storage impact
- Copilot interaction audit (what content Copilot surfaced)

---

## 8. Post-migration optimization

### Performance optimization

- [ ] Enable modern experience on all migrated sites
- [ ] Configure column indexing on large lists (> 5,000 items)
- [ ] Set appropriate version limits (default 500 is often excessive)
- [ ] Configure content delivery network (CDN) for site assets
- [ ] Enable M365 CDN for improved page load performance

```powershell
# Enable M365 CDN
Set-SPOTenantCdnEnabled -CdnType Both -Enable $true
Add-SPOTenantCdnOrigin -CdnType Public -OriginUrl "*/MASTERPAGE"
Add-SPOTenantCdnOrigin -CdnType Public -OriginUrl "*/STYLE LIBRARY"
Add-SPOTenantCdnOrigin -CdnType Private -OriginUrl "*/SITEASSETS"
```

### Cleanup and optimization

- [ ] Delete test sites created during pilot
- [ ] Remove old term store groups that were consolidated
- [ ] Clean up unused content types
- [ ] Archive sites that are no longer active
- [ ] Review and simplify permissions (remove broken inheritance where possible)
- [ ] Set up site lifecycle policies for ongoing governance

---

## 9. Risk mitigation

### Top 10 migration risks and mitigations

| #   | Risk                                       | Likelihood | Impact      | Mitigation                                                                          |
| --- | ------------------------------------------ | ---------- | ----------- | ----------------------------------------------------------------------------------- |
| 1   | Workflow breakage (SP 2010/2013 workflows) | Certain    | High        | Assess all workflows; build Power Automate replacements before cutover              |
| 2   | InfoPath forms not rendering               | Certain    | High        | Build Power Apps replacements before cutover                                        |
| 3   | User resistance to modern experience       | High       | Medium      | Training, champion network, phased rollout                                          |
| 4   | Data loss during migration                 | Low        | Critical    | Incremental migration + validation scripts + do not decommission source immediately |
| 5   | Permission mapping failures                | Medium     | High        | Verify Entra Connect sync; test with pilot users                                    |
| 6   | Managed metadata not resolving             | Medium     | Medium      | Migrate term store first; validate term GUIDs                                       |
| 7   | SPO throttling slowing migration           | High       | Medium      | Schedule off-hours; add agents gradually                                            |
| 8   | Custom solution incompatibility            | Certain    | Medium-High | Assess all WSPs; plan SPFx development timeline                                     |
| 9   | External sharing of sensitive content      | Medium     | High        | Deploy sensitivity labels and DLP before migration                                  |
| 10  | Copilot surfacing overshared content       | Medium     | High        | Review and tighten permissions; apply sensitivity labels                            |

---

## 10. Success metrics

Track these metrics throughout the migration program:

| Metric                                    | Target                                   | Measurement                            |
| ----------------------------------------- | ---------------------------------------- | -------------------------------------- |
| Content migrated (GB)                     | 100% of in-scope content                 | SPMT/Migration Manager reports         |
| Migration success rate                    | > 99% of items                           | Items migrated / items attempted       |
| Cutover downtime per site                 | < 4 hours                                | Time from source read-only to SPO live |
| User satisfaction (post-migration survey) | > 80% positive                           | Microsoft Forms survey                 |
| Help desk tickets (migration-related)     | < 5% of user base                        | Help desk tracking system              |
| Sensitivity label coverage                | > 90% of sites labeled                   | Purview compliance reports             |
| DLP policy coverage                       | 100% of SPO sites                        | Purview DLP dashboard                  |
| Search result accuracy                    | > 95% of queries return relevant results | Spot-check validation                  |

---

## References

- [SharePoint migration best practices](https://learn.microsoft.com/sharepointmigration/sharepoint-online-and-onedrive-migration-speed)
- [SharePoint Migration Assessment Tool](https://learn.microsoft.com/sharepointmigration/overview-of-the-sharepoint-migration-assessment-tool)
- [Modern SharePoint experience guidance](https://learn.microsoft.com/sharepoint/guide-to-sharepoint-modern-experience)
- [Hub sites planning](https://learn.microsoft.com/sharepoint/planning-hub-sites)
- [SharePoint governance overview](https://learn.microsoft.com/sharepoint/governance-overview)
- [Microsoft Purview documentation](https://learn.microsoft.com/purview/)
- [PnP page transformation](https://learn.microsoft.com/sharepoint/dev/transform/modernize-userinterface-site-pages)
- [SharePoint adoption resources](https://adoption.microsoft.com/sharepoint/)

---

**Maintainers:** csa-inabox core team
**Last updated:** 2026-04-30
