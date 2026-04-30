# SharePoint On-Premises to SharePoint Online: Complete Feature Mapping

**Status:** Authored 2026-04-30
**Audience:** SharePoint architects, migration leads, and platform engineers who need a comprehensive understanding of how every on-premises SharePoint feature maps to SharePoint Online.
**Scope:** 50+ features across content management, search, workflows, forms, customization, security, and administration.

---

## How to read this document

Each feature is mapped with:

- **On-premises capability** -- what the feature does in SharePoint Server.
- **SPO equivalent** -- the corresponding SharePoint Online capability.
- **Migration complexity** -- XS (trivial), S (small), M (medium), L (large), XL (redesign required).
- **Notes** -- migration considerations, blockers, and workarounds.

Complexity ratings assume experienced SharePoint administrators with M365 familiarity. Organizations without Power Platform expertise should add one complexity level for workflow and form migrations.

---

## 1. Pages and user experience

| #   | On-premises feature             | SPO equivalent                              | Complexity | Notes                                                                        |
| --- | ------------------------------- | ------------------------------------------- | ---------- | ---------------------------------------------------------------------------- |
| 1   | Classic wiki pages              | Modern pages                                | S          | SPMT migrates content; manual conversion to modern recommended               |
| 2   | Classic web part pages          | Modern pages with sections                  | M          | Web part mapping required; some classic web parts have no modern equivalent  |
| 3   | Publishing pages (page layouts) | Modern pages with sections and web parts    | L          | Page layouts do not exist in modern; content must be restructured            |
| 4   | Publishing site with variations | Communication site with multilingual pages  | L          | Variations architecture is completely different from multilingual            |
| 5   | Master pages and CSS branding   | Modern theming (site themes, header/footer) | M          | Custom master pages not supported; use JSON-based themes and SPFx extensions |
| 6   | Display templates (search)      | Search result types and adaptive cards      | M          | Custom display templates → PnP Modern Search web part or custom SPFx         |
| 7   | Wiki site template              | Modern team site or communication site      | S          | Wiki functionality replaced by modern pages                                  |
| 8   | Blog site template              | Communication site with news posts          | S          | Blog posts → news posts; comments supported natively                         |
| 9   | Project site template           | Modern team site with Planner/Project       | S          | Project functionality → Microsoft Planner or Project for the web             |
| 10  | Enterprise Wiki                 | Communication site with hub navigation      | M          | No direct equivalent; restructure as hub site with pages                     |

---

## 2. Content management

| #   | On-premises feature                   | SPO equivalent                                       | Complexity | Notes                                                                           |
| --- | ------------------------------------- | ---------------------------------------------------- | ---------- | ------------------------------------------------------------------------------- |
| 11  | Document libraries                    | SPO document libraries                               | XS         | Direct migration via SPMT/Migration Manager                                     |
| 12  | Lists (custom, tasks, calendars)      | SPO modern lists                                     | S          | SPMT migrates lists; modern list experience is different from classic           |
| 13  | Content types (site and list)         | SPO content types                                    | S          | Content types migrate; content type hub → content type gallery                  |
| 14  | Site columns                          | SPO site columns                                     | S          | Direct migration; validate column types supported in modern                     |
| 15  | Managed metadata service (term store) | SPO term store                                       | M          | Requires planning; single term store per tenant; PowerShell migration           |
| 16  | Content type hub                      | Content type gallery (tenant-level)                  | M          | Architecture change: site collection hub → tenant-level gallery                 |
| 17  | Content organizer                     | Retention labels + Power Automate rules              | M          | No direct equivalent; use retention labels for automatic classification         |
| 18  | Document sets                         | SPO document sets                                    | S          | Supported in SPO; modern experience limited                                     |
| 19  | Document ID service                   | SPO document ID                                      | S          | Available in SPO; must be enabled per site collection                           |
| 20  | Drop-off library                      | Power Automate + retention labels                    | M          | No direct equivalent; build with Power Automate file routing                    |
| 21  | In-Place Records Management           | Microsoft 365 Records Management                     | M          | Different architecture; use M365 Compliance Center records management           |
| 22  | Information management policies       | Retention policies and labels                        | M          | Replaced by M365 retention; more capable but different configuration            |
| 23  | Large list threshold (5,000 items)    | Large list threshold (5,000 items for classic views) | XS         | Same threshold exists but modern views handle it better with automatic indexing |
| 24  | Version history                       | Version history                                      | XS         | Migrates directly; SPO supports up to 50,000 major versions                     |
| 25  | Check-in / check-out                  | Check-in / check-out                                 | XS         | Direct migration; co-authoring is preferred in modern                           |

---

## 3. Search

| #   | On-premises feature                   | SPO equivalent                                  | Complexity | Notes                                                                              |
| --- | ------------------------------------- | ----------------------------------------------- | ---------- | ---------------------------------------------------------------------------------- |
| 26  | SharePoint Search Service Application | Microsoft Search                                | S          | SPO search is automatic; no service application to configure                       |
| 27  | Search topology (crawl, query, index) | Fully managed (Microsoft-operated)              | XS         | No topology management required                                                    |
| 28  | Crawl rules and content sources       | Automatic crawling                              | XS         | SPO content is crawled automatically; no content source configuration              |
| 29  | Managed properties                    | Managed properties (auto-created)               | S          | Auto-created from site columns; custom managed properties via search schema        |
| 30  | Result sources                        | Result sources and search verticals             | S          | Configurable; Microsoft Search verticals replace result sources for most scenarios |
| 31  | Query rules and promoted results      | Bookmarks and Q&A (Microsoft Search)            | M          | Different administration model; M365 admin center instead of SP search admin       |
| 32  | Display templates                     | Search result types + adaptive cards            | M          | Custom display templates → PnP Modern Search or SPFx                               |
| 33  | Custom search web parts               | PnP Modern Search or Microsoft Search web parts | M          | Classic search web parts → PnP Modern Search (community) or OOTB search            |
| 34  | Hybrid search (on-prem + cloud)       | Native search (cloud only)                      | XS         | After migration, hybrid search is no longer needed                                 |
| 35  | People search                         | Microsoft Search people results                 | S          | Powered by Entra ID profiles and Microsoft Graph                                   |

---

## 4. Workflows

!!! warning "SharePoint 2010 and 2013 Workflows are deprecated"
SharePoint 2010 Workflows and SharePoint 2013 Workflows are not supported in SharePoint Online as of November 2020 (2010) and April 2024 (2013). All workflows must be migrated to Power Automate.

| #   | On-premises feature           | SPO equivalent                      | Complexity | Notes                                                                         |
| --- | ----------------------------- | ----------------------------------- | ---------- | ----------------------------------------------------------------------------- |
| 36  | SharePoint 2010 Workflows     | Power Automate cloud flows          | L          | Complete redesign required; no migration tool exists                          |
| 37  | SharePoint 2013 Workflows     | Power Automate cloud flows          | L          | Complete redesign required; Workflow Manager not available in SPO             |
| 38  | SharePoint Designer workflows | Power Automate cloud flows          | M-L        | Complexity depends on workflow logic; simple approvals = M, complex logic = L |
| 39  | Nintex Workflow               | Power Automate or Nintex for M365   | M-L        | Nintex offers a cloud version; alternatively redesign in Power Automate       |
| 40  | K2 workflows                  | Power Automate or K2 Cloud          | L          | K2 offers cloud migration; complex workflows require redesign                 |
| 41  | Approval workflows (OOB)      | Power Automate approval flows       | S          | Pre-built approval templates available; straightforward replacement           |
| 42  | Three-state workflow          | Power Automate with status tracking | S          | Simple state machine → Power Automate with SharePoint column updates          |
| 43  | Collect feedback/signatures   | Power Automate with adaptive cards  | M          | Feedback collection → Teams adaptive cards + Power Automate                   |
| 44  | Disposition approval workflow | M365 Records Management disposition | M          | Use retention labels with disposition review                                  |

---

## 5. Forms

| #   | On-premises feature              | SPO equivalent                          | Complexity | Notes                                                                                  |
| --- | -------------------------------- | --------------------------------------- | ---------- | -------------------------------------------------------------------------------------- |
| 45  | InfoPath forms (browser-enabled) | Power Apps                              | M-L        | Complexity depends on form complexity; see [InfoPath Migration](infopath-migration.md) |
| 46  | InfoPath form libraries          | Power Apps + SPO document libraries     | L          | Form library concept → Power Apps form with document generation                        |
| 47  | SharePoint list forms (default)  | SPO modern list forms (customizable)    | XS         | Modern list forms are built-in; Power Apps customization available                     |
| 48  | InfoPath data connections        | Power Apps connectors or Power Automate | M          | Each data connection must be re-created as a connector                                 |
| 49  | InfoPath rules and validation    | Power Apps formulas and validation      | M          | InfoPath rules → Power Fx formulas; different syntax, same concepts                    |

---

## 6. Customization and development

| #   | On-premises feature                  | SPO equivalent                              | Complexity | Notes                                                                                |
| --- | ------------------------------------ | ------------------------------------------- | ---------- | ------------------------------------------------------------------------------------ |
| 50  | Farm solutions (WSP)                 | SharePoint Framework (SPFx)                 | XL         | Full redesign required; server-side code → client-side SPFx                          |
| 51  | Sandbox solutions (deprecated)       | SPFx solutions                              | L          | Sandbox solutions deprecated on-prem too; convert to SPFx                            |
| 52  | SharePoint Designer customizations   | Power Automate + SPFx + Power Apps          | M-L        | SP Designer not supported in SPO; depends on customization type                      |
| 53  | Custom web parts (server-side)       | SPFx web parts (client-side)                | L-XL       | Complete rewrite in TypeScript/React; server-side APIs → Microsoft Graph             |
| 54  | Custom timer jobs                    | Azure Functions + Power Automate            | M          | Timer jobs → Azure Functions (scheduled trigger) or Power Automate                   |
| 55  | Custom event receivers               | SPFx extensions + webhooks + Power Automate | M          | Event receivers → SPO webhooks or Power Automate triggers                            |
| 56  | Custom application pages             | SPFx full-page applications                 | L          | \_layouts pages → SPFx single-page applications                                      |
| 57  | Custom service applications          | Azure services + Microsoft Graph            | XL         | No equivalent; re-architect as standalone Azure services                             |
| 58  | JavaScript injection (Script Editor) | SPFx extensions (application customizer)    | M          | Script Editor web part removed in modern; use SPFx                                   |
| 59  | Custom master pages                  | Modern theming + SPFx header/footer         | M          | Master pages not supported in modern; use JSON themes + SPFx application customizers |
| 60  | Custom CSS/branding                  | Modern theming (JSON themes)                | S-M        | Simple branding = S; complex branding = M                                            |

---

## 7. Security and permissions

| #   | On-premises feature               | SPO equivalent                            | Complexity | Notes                                                                      |
| --- | --------------------------------- | ----------------------------------------- | ---------- | -------------------------------------------------------------------------- |
| 61  | SharePoint groups                 | SharePoint groups + M365 groups           | S          | SharePoint groups exist in SPO; M365 groups recommended for new sites      |
| 62  | AD security groups                | Entra ID security groups                  | S          | Synced via Entra Connect; verify group membership after sync               |
| 63  | Permission levels (custom)        | Permission levels (limited customization) | S          | Custom permission levels supported but some restrictions apply             |
| 64  | Permission inheritance / breaking | Permission inheritance / breaking         | XS         | Same model in SPO; broken inheritance migrates with SPMT                   |
| 65  | Claims-based authentication       | Entra ID authentication                   | M          | Windows/forms claims → Entra ID; SAML claims → Entra ID federation         |
| 66  | Secure Store Service              | Azure Key Vault + managed identities      | M          | No Secure Store in SPO; credentials → Key Vault or app-only auth           |
| 67  | User Profile Service Application  | Entra ID user profiles + Delve            | S          | User profiles synced from Entra ID; custom properties via Graph extensions |
| 68  | Audiences (user profiles)         | Audience targeting (modern)               | S          | Different mechanism; modern audience targeting uses Entra groups           |

---

## 8. Business connectivity and integration

| #   | On-premises feature                    | SPO equivalent                                | Complexity | Notes                                                                       |
| --- | -------------------------------------- | --------------------------------------------- | ---------- | --------------------------------------------------------------------------- |
| 69  | Business Connectivity Services (BCS)   | Power Apps custom connectors + Power Automate | L          | BCS is deprecated in SPO; external data → Power Apps/Power Automate         |
| 70  | External content types (BCS)           | Power Apps + Dataverse                        | L          | No direct equivalent; external data lives in Dataverse or custom connectors |
| 71  | External lists (BCS)                   | Power Apps embedded in SPO pages              | L          | External lists → Power Apps canvas app embedded in modern page              |
| 72  | Secure Store Service (BCS credentials) | Azure Key Vault + Power Automate connections  | M          | Credential management → Key Vault + Power Platform connections              |

---

## 9. My Sites and social

| #   | On-premises feature       | SPO equivalent                    | Complexity | Notes                                                                |
| --- | ------------------------- | --------------------------------- | ---------- | -------------------------------------------------------------------- |
| 73  | My Sites (personal sites) | OneDrive for Business             | S          | My Site document libraries → OneDrive; personal pages deprecated     |
| 74  | My Site host              | OneDrive admin center             | XS         | No equivalent needed; OneDrive is managed centrally                  |
| 75  | Newsfeed                  | Viva Engage (Yammer)              | S          | SharePoint newsfeed → Viva Engage for social; News for announcements |
| 76  | Community sites           | Viva Engage communities           | M          | Community features → Viva Engage; different platform                 |
| 77  | Following sites/documents | Following sites in SPO + OneDrive | XS         | Migrates naturally; different UI in modern                           |

---

## 10. Administration

| #   | On-premises feature             | SPO equivalent                       | Complexity | Notes                                                                   |
| --- | ------------------------------- | ------------------------------------ | ---------- | ----------------------------------------------------------------------- |
| 78  | Central Administration          | SharePoint admin center              | S          | Different interface; PowerShell and admin center for management         |
| 79  | Farm-level settings             | Tenant-level settings (admin center) | S          | Farm settings → tenant settings; some differences in available controls |
| 80  | Web application management      | No equivalent (single web app)       | XS         | SPO is a single multi-tenant web application; no web app management     |
| 81  | Content database management     | No equivalent (fully managed)        | XS         | No database management required; Microsoft manages storage              |
| 82  | Service applications            | No equivalent (fully managed)        | XS         | All service applications are managed by Microsoft                       |
| 83  | Health Analyzer                 | M365 Service Health + admin center   | S          | Different monitoring model; M365 Service Health dashboard               |
| 84  | Timer job management            | No equivalent (fully managed)        | XS         | Timer jobs managed by Microsoft; custom timer jobs → Azure Functions    |
| 85  | Backup and restore (farm-level) | No equivalent (fully managed)        | XS         | Microsoft handles backup; recycle bin + retention policies for recovery |
| 86  | Site collection backup/restore  | Recycle bin + site restoration       | S          | Site deletion → recycle bin (93 days); file-level restore available     |

---

## 11. Collaboration and social features

| #   | On-premises feature                      | SPO equivalent                       | Complexity | Notes                                                     |
| --- | ---------------------------------------- | ------------------------------------ | ---------- | --------------------------------------------------------- |
| 87  | Task lists                               | Microsoft Planner / To Do / SPO list | S          | Task list migrates; recommend Planner for task management |
| 88  | Calendar lists                           | SPO calendar list + Outlook          | S          | Calendar list migrates; consider M365 group calendar      |
| 89  | Discussion boards                        | Viva Engage or Teams channel         | M          | Discussion boards deprecated in modern SPO                |
| 90  | Surveys                                  | Microsoft Forms                      | M          | Surveys deprecated in modern; migrate to Forms            |
| 91  | Site mailbox                             | M365 Group mailbox                   | M          | Site mailboxes deprecated; use M365 Group                 |
| 92  | RSS feeds                                | Modern news web part                 | S          | RSS Viewer web part → News web part or third-party        |
| 93  | External sharing (on-prem with extranet) | SPO external sharing                 | M          | Extranet → SPO guest access with Entra B2B                |
| 94  | Access Services (Access web databases)   | Power Apps + Dataverse               | L          | Access Services deprecated; redesign with Power Platform  |
| 95  | Visio Services                           | Visio for the web                    | S          | Visio files render in browser natively in SPO             |
| 96  | Excel Services                           | Excel for the web + Power BI         | S          | Excel files render natively; dashboards → Power BI        |
| 97  | PerformancePoint Services                | Power BI                             | L          | PerformancePoint retired; redesign dashboards in Power BI |
| 98  | Word Automation Services                 | Power Automate + Word Online         | M          | Document generation → Power Automate with Word templates  |

---

## 12. Infrastructure and operations

| #   | On-premises feature              | SPO equivalent                    | Complexity | Notes                                         |
| --- | -------------------------------- | --------------------------------- | ---------- | --------------------------------------------- |
| 99  | SQL Server content databases     | Fully managed (Microsoft)         | XS         | No database management required               |
| 100 | IIS web server configuration     | Fully managed (Microsoft)         | XS         | No web server management                      |
| 101 | Certificate management           | Fully managed (Microsoft)         | XS         | SSL/TLS managed by Microsoft                  |
| 102 | Load balancing                   | Fully managed (Microsoft)         | XS         | Global CDN and load balancing                 |
| 103 | Distributed cache                | Fully managed (Microsoft)         | XS         | Managed caching layer                         |
| 104 | Usage and health data collection | M365 usage reports + admin center | S          | Different reporting model; richer analytics   |
| 105 | Logging database                 | Microsoft 365 audit logs          | S          | Centralized audit in M365 Compliance          |
| 106 | SharePoint logs (ULS)            | Not available (managed service)   | XS         | No server-side logging access; use audit logs |

---

## 13. Migration tool support matrix

Which features are handled by which migration tool:

| Feature                | SPMT               | Migration Manager  | Sharegate        | AvePoint             |
| ---------------------- | ------------------ | ------------------ | ---------------- | -------------------- |
| Document libraries     | Yes                | Yes                | Yes              | Yes                  |
| Lists                  | Yes                | Yes                | Yes              | Yes                  |
| Permissions            | Yes                | Yes                | Yes (granular)   | Yes (granular)       |
| Metadata/content types | Yes                | Yes                | Yes              | Yes                  |
| Managed metadata       | Yes (with mapping) | Yes (with mapping) | Yes (auto-map)   | Yes (auto-map)       |
| Version history        | Yes (configurable) | Yes (configurable) | Yes              | Yes                  |
| Created/modified dates | Yes                | Yes                | Yes              | Yes                  |
| Created/modified users | Yes (with mapping) | Yes (with mapping) | Yes              | Yes                  |
| Classic pages          | Yes (as-is)        | Yes (as-is)        | Yes + conversion | Yes + conversion     |
| Workflows              | No                 | No                 | Metadata only    | Assessment only      |
| InfoPath forms         | Content only       | Content only       | Content only     | Content + assessment |
| Farm solutions         | No                 | No                 | No               | No                   |
| Web parts              | Content only       | Content only       | Assessment       | Assessment           |
| Site structure         | Yes                | Yes                | Yes              | Yes                  |

---

## 14. PowerShell assessment script for feature usage

```powershell
# Comprehensive feature usage assessment
Add-PSSnapin Microsoft.SharePoint.PowerShell

$featureReport = @()

Get-SPSite -Limit All | ForEach-Object {
    $site = $_
    $rootWeb = $_.RootWeb

    # Check for InfoPath
    $infoPathCount = ($site.AllWebs | ForEach-Object {
        $_.Lists | Where-Object { $_.BaseTemplate -eq 115 }
    } | Measure-Object).Count

    # Check for workflows
    $workflowCount = ($site.AllWebs | ForEach-Object {
        $_.Lists | ForEach-Object { $_.WorkflowAssociations }
    } | Measure-Object).Count

    # Check for sandbox solutions
    $sandboxCount = ($site.Solutions | Measure-Object).Count

    # Check for custom content types
    $customCTCount = ($rootWeb.ContentTypes | Where-Object {
        $_.Group -ne "Document Content Types" -and
        $_.Group -ne "List Content Types" -and
        -not $_.Hidden
    } | Measure-Object).Count

    # Check for managed metadata columns
    $mmsColumns = ($rootWeb.Fields | Where-Object {
        $_.TypeAsString -eq "TaxonomyFieldType" -or
        $_.TypeAsString -eq "TaxonomyFieldTypeMulti"
    } | Measure-Object).Count

    # Check for custom master pages
    $customMaster = $rootWeb.CustomMasterUrl -ne $rootWeb.MasterUrl

    $featureReport += [PSCustomObject]@{
        SiteUrl          = $site.Url
        SizeMB           = [math]::Round($site.Usage.Storage / 1MB, 2)
        SubSiteCount     = $site.AllWebs.Count
        InfoPathForms    = $infoPathCount
        Workflows        = $workflowCount
        SandboxSolutions = $sandboxCount
        CustomContentTypes = $customCTCount
        ManagedMetadataCols = $mmsColumns
        CustomMasterPage = $customMaster
        CompatLevel      = $site.CompatibilityLevel
        LastModified     = $site.LastContentModifiedDate
    }
}

$featureReport | Export-Csv -Path "C:\Migration\feature-usage-report.csv" -NoTypeInformation

# Summary
Write-Host "Sites with InfoPath: $(($featureReport | Where-Object { $_.InfoPathForms -gt 0 }).Count)"
Write-Host "Sites with Workflows: $(($featureReport | Where-Object { $_.Workflows -gt 0 }).Count)"
Write-Host "Sites with Sandbox Solutions: $(($featureReport | Where-Object { $_.SandboxSolutions -gt 0 }).Count)"
Write-Host "Sites with Custom Master Pages: $(($featureReport | Where-Object { $_.CustomMasterPage }).Count)"
Write-Host "Sites with Managed Metadata: $(($featureReport | Where-Object { $_.ManagedMetadataCols -gt 0 }).Count)"
```

---

## 15. Migration complexity summary

| Complexity        | Count | Examples                                                                    |
| ----------------- | ----- | --------------------------------------------------------------------------- |
| **XS** (trivial)  | 18    | Document libraries, version history, search topology, farm backup           |
| **S** (small)     | 22    | Lists, content types, site columns, SharePoint groups, My Sites             |
| **M** (medium)    | 24    | Managed metadata, display templates, InfoPath simple forms, event receivers |
| **L** (large)     | 14    | SP 2010/2013 workflows, InfoPath complex forms, sandbox solutions, BCS      |
| **XL** (redesign) | 8     | Farm solutions, custom service applications, complex publishing sites       |

### Migration blockers (no direct SPO equivalent)

These features have no SPO equivalent and require architectural redesign:

1. **Farm solutions (full-trust code)** -- must be rewritten as SPFx, Azure Functions, or Power Platform
2. **Custom service applications** -- must be re-architected as Azure services
3. **Business Connectivity Services (BCS)** -- must be replaced with Power Platform custom connectors
4. **Custom timer jobs** -- must be replaced with Azure Functions or Power Automate
5. **InfoPath form libraries with code-behind** -- must be redesigned in Power Apps
6. **SharePoint Designer workflows with custom activities** -- must be redesigned in Power Automate
7. **Custom master pages** -- must be replaced with modern theming and SPFx extensions
8. **Server-side event receivers** -- must be replaced with webhooks and Power Automate

---

## 12. Feature parity assessment by SharePoint version

| Feature area       | SP 2010 → SPO gap     | SP 2013 → SPO gap     | SP 2016 → SPO gap      | SP 2019 → SPO gap       |
| ------------------ | --------------------- | --------------------- | ---------------------- | ----------------------- |
| Pages and UX       | Large                 | Large                 | Medium                 | Small                   |
| Content management | Small                 | Small                 | Small                  | XS                      |
| Search             | Medium                | Medium                | Small                  | Small                   |
| Workflows          | Large (must redesign) | Large (must redesign) | Large (must redesign)  | Large (must redesign)   |
| Forms              | Large (InfoPath)      | Large (InfoPath)      | Large (InfoPath)       | Medium (InfoPath)       |
| Customization      | XL (farm solutions)   | XL (farm solutions)   | Large (farm solutions) | Medium (SPFx available) |
| Security           | Medium                | Medium                | Small                  | Small                   |
| Administration     | Small (simplified)    | Small (simplified)    | Small (simplified)     | XS (simplified)         |

---

## References

- [SharePoint Online limits](https://learn.microsoft.com/office365/servicedescriptions/sharepoint-online-service-description/sharepoint-online-limits)
- [Deprecated features in SharePoint Online](https://learn.microsoft.com/sharepoint/what-s-new/new-and-improved-features-in-sharepoint-server-subscription-edition)
- [SharePoint 2010 workflows retirement](https://learn.microsoft.com/sharepoint/dev/transform/modernize-workflows)
- [SharePoint Framework overview](https://learn.microsoft.com/sharepoint/dev/spfx/sharepoint-framework-overview)
- [Power Automate SharePoint connector](https://learn.microsoft.com/connectors/sharepointonline/)
- [Power Apps SharePoint integration](https://learn.microsoft.com/power-apps/maker/canvas-apps/customize-list-form)
- [Microsoft Search overview](https://learn.microsoft.com/microsoftsearch/overview-microsoft-search)

---

**Maintainers:** csa-inabox core team
**Last updated:** 2026-04-30
