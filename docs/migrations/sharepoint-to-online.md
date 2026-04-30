# Migrating SharePoint On-Premises to SharePoint Online

**Status:** Authored 2026-04-30
**Audience:** SharePoint administrators, M365 architects, governance specialists, IT leadership
**Scope:** Full migration from SharePoint Server 2010/2013/2016/2019 to SharePoint Online, with CSA-in-a-Box integration for governance, analytics, and AI.

---

!!! tip "Expanded Migration Center Available"
This playbook is the core migration reference. For the complete SharePoint-to-Online migration package -- including tool-specific tutorials, feature mapping, federal guidance, and benchmarks -- visit the **[SharePoint Migration Center](sharepoint-to-online/index.md)**.

    **Quick links:**

    - [Why SharePoint Online (Executive Brief)](sharepoint-to-online/why-sharepoint-online.md)
    - [Total Cost of Ownership Analysis](sharepoint-to-online/tco-analysis.md)
    - [Complete Feature Mapping (50+ features)](sharepoint-to-online/feature-mapping-complete.md)
    - [Federal Migration Guide](sharepoint-to-online/federal-migration-guide.md)
    - [Benchmarks & Performance](sharepoint-to-online/benchmarks.md)
    - [Best Practices](sharepoint-to-online/best-practices.md)

    **Migration guides by domain:** [Site Migration](sharepoint-to-online/site-migration.md) | [Content Migration](sharepoint-to-online/content-migration.md) | [Workflow Migration](sharepoint-to-online/workflow-migration.md) | [InfoPath Migration](sharepoint-to-online/infopath-migration.md) | [Customization Migration](sharepoint-to-online/customization-migration.md) | [Security Migration](sharepoint-to-online/security-migration.md)

    **Tutorials:** [SPMT Step-by-Step](sharepoint-to-online/tutorial-spmt-migration.md) | [Migration Manager at Scale](sharepoint-to-online/tutorial-migration-manager.md)

---

## 1. Executive summary

SharePoint Server is the most widely deployed collaboration and content management platform in enterprise and government, with installations spanning SharePoint 2010 through 2019. Microsoft's end-of-support timelines for older versions, combined with the rapid evolution of the Microsoft 365 ecosystem (Teams, Copilot for M365, Power Platform, OneDrive), make migration to SharePoint Online both a risk-mitigation imperative and a modernization opportunity.

CSA-in-a-Box provides the governance and analytics layer for SharePoint Online content. Once sites and content move to SPO, Microsoft Purview governs the content through sensitivity labels, DLP policies, and compliance boundaries. Power BI can report on SharePoint list data and document metadata. Copilot for Microsoft 365 surfaces SharePoint content through natural language, but only when that content is properly governed -- making Purview integration essential.

This playbook addresses organizations running SharePoint 2010, 2013, 2016, or 2019 on-premises, with a mix of team sites, publishing sites, document libraries, custom workflows (SharePoint 2010/2013 Workflows and Nintex), InfoPath forms, farm solutions, and sandbox solutions. It provides honest guidance on what migrates cleanly, what requires redesign, and what should be retired.

---

## 2. Decision matrix -- choose your migration tool

| Criteria               | SPMT                                  | Migration Manager                             | FastTrack                                  | Third-party (Sharegate, AvePoint)      |
| ---------------------- | ------------------------------------- | --------------------------------------------- | ------------------------------------------ | -------------------------------------- |
| **Best for**           | Small-to-mid migrations, admin-driven | Large-scale, multi-farm migrations            | Free Microsoft-led assistance (500+ seats) | Complex environments, granular control |
| **Scale**              | Single workstation                    | Multi-agent, centralized dashboard            | Microsoft-led engagement                   | Unlimited                              |
| **Content types**      | Sites, lists, document libraries      | Sites, lists, document libraries, file shares | Guided planning + tooling                  | Full content + permissions + metadata  |
| **Workflow migration** | Not supported                         | Not supported                                 | Assessment only                            | Partial (Sharegate maps metadata)      |
| **Permission mapping** | Basic (AD to Entra)                   | Basic (AD to Entra)                           | Guidance only                              | Advanced (granular remapping)          |
| **Scheduling**         | Manual or script-based                | Built-in scheduling and batching              | Scheduled waves                            | Built-in scheduling                    |
| **Reporting**          | CSV export                            | Admin center dashboard                        | FastTrack portal                           | Rich reporting and analytics           |
| **Cost**               | Free                                  | Free                                          | Free (500+ seats)                          | Licensed per user or per GB            |
| **Federal support**    | GCC / GCC-High                        | GCC / GCC-High                                | GCC / GCC-High                             | Varies by vendor                       |

---

## 3. Migration approach by source version

### SharePoint 2010

SharePoint 2010 reached end of extended support on **October 13, 2020**. This is a security-critical migration. Key challenges include SharePoint 2010 Workflows (must be redesigned in Power Automate), InfoPath forms, sandbox solutions, and classic web parts. SPMT supports direct migration from SharePoint 2010 to SPO; no intermediate upgrade is required.

### SharePoint 2013

SharePoint 2013 reached end of extended support on **April 11, 2023**. Similar challenges to 2010, plus SharePoint 2013 Workflows (also deprecated, must move to Power Automate). SPMT and Migration Manager both support direct migration from 2013.

### SharePoint 2016

SharePoint 2016 reaches end of extended support on **July 14, 2026**. Organizations should begin migration planning immediately. Modern page experience is partially available, easing the transition. MinRole topology simplifies farm assessment.

### SharePoint 2019

SharePoint 2019 is the closest to SharePoint Online in feature set. Modern pages, modern lists, and the SharePoint Framework (SPFx) are available on-premises. Migration is the smoothest from 2019, with the fewest compatibility gaps.

---

## 4. Phased migration plan

### Phase 1: Assess (weeks 1-4)

1. Run the **SharePoint Migration Assessment Tool (SMAT)** across all farms
2. Run **SPMT pre-scan** to identify blocked and warning items
3. Inventory all site collections: size, last modified, content type usage, custom solutions
4. Map workflow dependencies: SharePoint 2010/2013 Workflows, Nintex, K2
5. Map InfoPath forms: complexity, data connections, submission targets
6. Inventory farm solutions and sandbox solutions for SPFx conversion assessment
7. Document managed metadata service terms, content types, site columns
8. Map Active Directory security groups to Entra ID groups

### Phase 2: Prepare (weeks 5-8)

1. Provision SharePoint Online tenant (or GCC/GCC-High for federal)
2. Configure Entra ID (Azure AD) Connect for identity synchronization
3. Set up Microsoft Purview for sensitivity labels and DLP policies
4. Plan managed metadata migration (term store, content types)
5. Design modern site architecture (hub sites, associated sites, navigation)
6. Remediate SMAT findings (large lists, unsupported features, broken sites)
7. Pilot Power Automate flows for critical workflows
8. Pilot Power Apps forms for critical InfoPath forms

### Phase 3: Migrate (weeks 9-20)

Execute migration waves, starting with low-risk content:

1. **Wave 0 -- Pilot:** 3-5 representative sites covering different content types
2. **Wave 1 -- Team sites:** Standard document libraries and lists
3. **Wave 2 -- Project sites:** Sites with metadata, content types, managed metadata
4. **Wave 3 -- Publishing sites:** Intranet pages, navigation, branding
5. **Wave 4 -- Complex sites:** Custom solutions, workflows, InfoPath

For each wave:

- Run pre-migration scan with SPMT or Migration Manager
- Execute content migration during off-hours
- Validate content, permissions, and metadata post-migration
- Convert classic pages to modern pages
- Redirect users and update bookmarks
- Monitor for 1-2 weeks before decommissioning source

### Phase 4: Optimize (weeks 21-24)

1. Deploy SPFx solutions to replace farm solutions
2. Complete Power Automate flow deployment for all migrated workflows
3. Complete Power Apps form deployment for all InfoPath forms
4. Configure CSA-in-a-Box integration:
    - Register SPO sites in Microsoft Purview for governance and classification
    - Apply sensitivity labels to document libraries
    - Configure DLP policies for sensitive content
    - Connect SharePoint list data to Power BI for reporting
    - Enable Copilot for M365 on governed content
5. Decommission on-premises SharePoint farms

---

## 5. CSA-in-a-Box integration

Once SharePoint content moves to SharePoint Online, CSA-in-a-Box unlocks governance, analytics, and AI:

| CSA-in-a-Box component | Integration with SPO                                               | Value                                              |
| ---------------------- | ------------------------------------------------------------------ | -------------------------------------------------- |
| **Microsoft Purview**  | Auto-scan SPO sites for classification, sensitivity labels, DLP    | Content governance and compliance visibility       |
| **Sensitivity labels** | Apply labels to SPO document libraries and files                   | Information protection for CUI, PII, PHI           |
| **DLP policies**       | Enforce data loss prevention on SPO content                        | Prevent sensitive data leakage via sharing         |
| **Power BI**           | Report on SharePoint list data, document metadata, usage analytics | Self-service BI on collaboration data              |
| **Copilot for M365**   | Surface SPO content through natural language queries               | AI-powered content discovery (requires governance) |
| **Azure Monitor**      | Centralized monitoring of M365 tenant health                       | Unified observability                              |

---

## 6. End-of-support timeline

| SharePoint version              | Mainstream support ended | Extended support ends | Status                                 |
| ------------------------------- | ------------------------ | --------------------- | -------------------------------------- |
| SharePoint 2010                 | 2015-10-13               | 2020-10-13            | **Unsupported -- migrate immediately** |
| SharePoint 2013                 | 2018-04-10               | 2023-04-11            | **Unsupported -- migrate immediately** |
| SharePoint 2016                 | 2021-07-13               | 2026-07-14            | **Migrate before July 2026**           |
| SharePoint 2019                 | 2024-01-09               | 2029-04-10            | In extended support                    |
| SharePoint Subscription Edition | Ongoing                  | Ongoing               | Current on-premises option             |

!!! warning "SharePoint 2016 extended support ends July 2026"
Organizations running SharePoint 2016 should prioritize migration planning. After July 2026, no security patches will be provided. SharePoint Online receives continuous updates and is always current.

---

## 7. Quick-start commands

### Assess with SMAT

```powershell
# Download and run SharePoint Migration Assessment Tool
# https://www.microsoft.com/download/details.aspx?id=53598
.\SMAT.exe -SiteURL https://sharepoint.contoso.com
```

### Install PnP PowerShell for assessment

```powershell
Install-Module -Name PnP.PowerShell -Scope CurrentUser
Connect-PnPOnline -Url https://contoso.sharepoint.com -Interactive

# Get site inventory
Get-PnPTenantSite | Select-Object Url, Template, StorageUsageCurrent, LastContentModifiedDate |
    Export-Csv -Path ".\spo-site-inventory.csv" -NoTypeInformation
```

### SPMT PowerShell migration

```powershell
Import-Module Microsoft.SharePoint.MigrationTool.PowerShell

# Register SPMT migration session
Register-SPMTMigration -SPOUrl "https://contoso.sharepoint.com" `
    -SPOCredential (Get-Credential)

# Add a site migration task
Add-SPMTTask -SharePointSourceSiteUrl "https://sp2016.contoso.com/sites/finance" `
    -TargetSiteUrl "https://contoso.sharepoint.com/sites/finance" `
    -MigrateAll

# Start migration
Start-SPMTMigration
```

---

## 8. Related resources

- [SharePoint Migration Center (expanded)](sharepoint-to-online/index.md)
- [Microsoft Purview Guide](../guides/purview.md)
- [Power BI Guide](../guides/power-bi.md)
- [Federal Migration Guide](sharepoint-to-online/federal-migration-guide.md)

---

## 9. References

- [SharePoint Migration Tool documentation](https://learn.microsoft.com/sharepointmigration/introducing-the-sharepoint-migration-tool)
- [Migration Manager overview](https://learn.microsoft.com/sharepointmigration/mm-get-started)
- [SharePoint Migration Assessment Tool (SMAT)](https://learn.microsoft.com/sharepointmigration/overview-of-the-sharepoint-migration-assessment-tool)
- [FastTrack for Microsoft 365](https://learn.microsoft.com/fasttrack/introduction)
- [PnP PowerShell](https://pnp.github.io/powershell/)
- [SharePoint end-of-support resources](https://learn.microsoft.com/lifecycle/products/?terms=sharepoint)
- [Copilot for Microsoft 365 requirements](https://learn.microsoft.com/microsoft-365-copilot/microsoft-365-copilot-requirements)

---

**Maintainers:** csa-inabox core team
**Last updated:** 2026-04-30
