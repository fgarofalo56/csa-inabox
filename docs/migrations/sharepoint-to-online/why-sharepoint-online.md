# Why SharePoint Online: Executive Brief

**Status:** Authored 2026-04-30
**Audience:** CIOs, IT directors, collaboration platform owners, and executive sponsors evaluating the move from SharePoint Server on-premises to SharePoint Online.
**Purpose:** Provide the strategic case for migration, an honest assessment of trade-offs, and context for how CSA-in-a-Box extends the value of SharePoint Online through governance and AI.

---

## The case in one paragraph

SharePoint Server on-premises requires organizations to manage physical or virtual server infrastructure, SQL Server databases, patching cycles, disaster recovery, capacity planning, and security hardening -- all for a collaboration platform that Microsoft is investing in exclusively through SharePoint Online. Every major innovation since 2017 -- modern pages, hub sites, Teams integration, OneDrive sync, SharePoint Embedded, Copilot for Microsoft 365, and the Microsoft Graph -- has been built for the cloud. Organizations running SharePoint 2010 or 2013 are on unsupported software. Organizations running SharePoint 2016 will lose extended support in July 2026. The question is no longer whether to migrate, but how to migrate safely and extract maximum value from the modern platform.

---

## 1. Modern experience and continuous innovation

### Classic vs modern: a platform generation gap

SharePoint Server on-premises is frozen at the feature set of its release version. SharePoint 2016's "modern experience" is a partial implementation. SharePoint 2019 improved it but still lacks feature parity with SharePoint Online's modern experience, which receives updates monthly.

| Capability                    | SharePoint On-Premises | SharePoint Online                                                     |
| ----------------------------- | ---------------------- | --------------------------------------------------------------------- |
| Modern pages                  | 2019 only (limited)    | Full modern pages with web parts, sections, vertical sections         |
| Modern lists and libraries    | 2019 only (limited)    | Full modern experience with column formatting, conditional formatting |
| Hub sites                     | Not available          | Full hub site architecture with associated sites                      |
| Site designs and site scripts | Not available          | Automated site provisioning with JSON-based templates                 |
| Communication sites           | 2019 only (basic)      | Full communication sites with news, events, pages                     |
| SharePoint home site          | Not available          | Organization-wide home site with Viva Connections                     |
| News digest                   | Not available          | Automatic news aggregation and email digest                           |
| Audience targeting            | Basic (classic)        | Modern audience targeting for navigation, news, web parts             |
| Multilingual sites            | Not available          | Built-in multilingual page translation                                |
| SharePoint Spaces (3D)        | Not available          | Immersive 3D spaces (deprecated, transitioning to Mesh)               |

### Continuous updates vs patch cycles

SharePoint Online receives feature updates weekly, with major features announced at Ignite and Build. Organizations do not manage patches, cumulative updates, or service packs. The platform is always current, always secure, and always compliant.

SharePoint Server requires monthly cumulative updates, quarterly security patches, and periodic service packs. Each update requires testing in a staging environment, scheduling a maintenance window, and accepting the risk of patch-related issues. Most on-premises farms run 6-12 months behind the current patch level.

---

## 2. Microsoft Teams integration

Teams is now the primary collaboration interface for most organizations. SharePoint Online is the storage and content management backbone for Teams:

- **Every Teams channel** has a SharePoint document library as its backing store
- **Files shared in Teams chats** are stored in the sender's OneDrive for Business (which is built on SPO)
- **Teams wiki** pages are SharePoint pages (and wiki is being replaced by Loop and OneNote)
- **Teams meeting recordings** are stored in OneDrive or SharePoint
- **Teams channel sites** appear as SharePoint team sites with full SPO functionality

SharePoint Server on-premises has no native Teams integration. Organizations that maintain on-premises SharePoint alongside Teams create a bifurcated content landscape where users must search two platforms, manage two sets of permissions, and navigate two different experiences. This bifurcation worsens with Copilot for M365, which indexes SPO content but not on-premises SharePoint.

---

## 3. Copilot for Microsoft 365

Copilot for Microsoft 365 is the most significant platform evolution since the introduction of SharePoint Online itself. Copilot uses the Microsoft Graph to index and reason over content across the M365 ecosystem -- including SharePoint Online document libraries, lists, and pages.

**What Copilot does with SharePoint Online content:**

- Summarizes documents, pages, and list items through natural language
- Answers questions by drawing on content across SPO sites the user has access to
- Generates drafts based on existing SPO content (policies, templates, procedures)
- Surfaces relevant documents during Teams meetings based on meeting context
- Creates Power Automate flows from natural language descriptions

**What Copilot cannot do with on-premises SharePoint:**

- On-premises SharePoint content is not indexed by the Microsoft Graph
- Copilot cannot search, summarize, or reason over on-premises content
- Hybrid search can surface on-premises results in SPO search, but Copilot does not use hybrid search results as context

!!! warning "Copilot governance requires Purview"
Copilot respects SharePoint Online permissions -- it will not surface content a user cannot access. However, organizations must ensure that permissions are correctly set and that sensitive content is properly labeled with sensitivity labels through Microsoft Purview. Overshared content in SPO becomes overshared content in Copilot responses. CSA-in-a-Box's Purview integration addresses this directly.

---

## 4. OneDrive sync and offline access

OneDrive sync client (Files On-Demand) provides seamless synchronization between SharePoint Online document libraries and the local file system:

- **Files On-Demand** shows all files in File Explorer without downloading them; files download on first access
- **Known Folder Move** redirects Desktop, Documents, and Pictures to OneDrive
- **Multi-library sync** allows users to sync any SPO document library to their local machine
- **Offline access** enables work without internet connectivity; changes sync when reconnected
- **Co-authoring** allows multiple users to edit Office documents simultaneously with real-time presence

SharePoint Server on-premises supports the legacy OneDrive sync client (groove.exe) for My Site document libraries only. Document library sync from team sites requires the newer sync client with on-premises configuration, and the experience is significantly limited compared to SPO.

---

## 5. SharePoint Embedded

SharePoint Embedded (formerly SharePoint Syntex repository services) enables ISVs and enterprise developers to embed SharePoint's content management capabilities into custom applications:

- Line-of-business applications use SharePoint storage without exposing the SharePoint UI
- Content inherits SPO governance, compliance, and security policies
- Microsoft Graph APIs provide programmatic access to embedded content
- No additional SharePoint licensing required for embedded scenarios

This capability is exclusive to SharePoint Online and has no on-premises equivalent. Organizations building custom applications on SharePoint Server must either maintain the full SharePoint farm or re-architect for SPO.

---

## 6. End-of-support reality

### SharePoint 2010 -- unsupported since October 2020

Extended support ended over five years ago. No security patches, no bug fixes, no Microsoft support. Organizations running SharePoint 2010 are accepting unpatched security vulnerabilities and compliance risk. SPMT supports direct migration from 2010 to SPO -- no intermediate upgrade required.

### SharePoint 2013 -- unsupported since April 2023

Extended support ended in April 2023. Like 2010, no security patches are provided. SharePoint 2013 workflows and InfoPath forms are the primary migration challenges. SPMT and Migration Manager both support direct migration.

### SharePoint 2016 -- extended support ends July 2026

!!! danger "Action required: 3 months remaining"
SharePoint 2016 extended support ends **July 14, 2026**. Organizations must begin migration planning immediately to avoid running unsupported software. There are no Extended Security Updates (ESU) planned for SharePoint 2016.

### SharePoint 2019 -- extended support ends April 2029

SharePoint 2019 is in extended support until April 2029. This provides a longer migration runway, but the feature gap with SharePoint Online grows with every monthly SPO release. Organizations should plan migration within 1-2 years to avoid accumulating technical debt.

### SharePoint Subscription Edition (SE)

SharePoint SE is the current on-premises offering, receiving feature updates through the Feature Update channel. It is the only on-premises version with ongoing feature investment. However, feature parity with SPO is not a goal -- SE receives a subset of SPO innovations with significant delay. SE is appropriate for organizations with regulatory or sovereignty requirements that prevent cloud adoption.

---

## 7. Hybrid search and coexistence

For organizations that cannot migrate all content simultaneously, SharePoint hybrid provides a coexistence path:

- **Hybrid search** surfaces on-premises results in SPO search (and vice versa)
- **Hybrid sites** redirect on-premises My Sites to OneDrive for Business
- **Hybrid app launcher** provides a unified app launcher across environments
- **Hybrid taxonomy** shares managed metadata between on-premises and SPO

Hybrid is a transition architecture, not an end state. The administration overhead of maintaining both environments, the bifurcated user experience, and the inability to use Copilot on hybrid content all argue for completing the migration.

---

## 8. Security and compliance advantages

### Always-current security

SharePoint Online runs on Microsoft's hyperscale infrastructure with:

- **Automatic patching** -- no maintenance windows, no patch testing
- **Zero-day protection** -- Microsoft patches vulnerabilities before public disclosure
- **Microsoft Defender for Office 365** -- built-in threat protection for SPO content
- **Safe Attachments** -- detonation sandbox for uploaded files
- **Safe Links** -- URL rewriting and time-of-click verification

### Compliance features exclusive to SPO

| Feature                  | Description                                                      | On-premises equivalent                                                 |
| ------------------------ | ---------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Sensitivity labels       | Persistent labels that protect content across M365               | None (requires Azure Information Protection client for basic labeling) |
| DLP policies             | Content-aware data loss prevention across SPO, Teams, OneDrive   | None (requires third-party DLP)                                        |
| Retention policies       | Automated retention and deletion based on content age and labels | Information management policies (limited)                              |
| eDiscovery (Premium)     | Advanced search, review, and export for legal holds              | eDiscovery Center (basic)                                              |
| Communication compliance | Monitor content for policy violations                            | None                                                                   |
| Records management       | Declare records, disposition review, regulatory records          | Records Center (basic)                                                 |
| Audit (Premium)          | Detailed audit logs with 10-year retention                       | SharePoint audit logs (limited)                                        |
| Information barriers     | Prevent communication between user segments                      | None                                                                   |

---

## 9. Power Platform integration

SharePoint Online is deeply integrated with the Power Platform:

### Power Automate

- Trigger flows on SPO events (item created, item modified, file uploaded)
- Hundreds of pre-built SPO connectors and templates
- Approval workflows with rich adaptive cards in Teams
- Replaces SharePoint 2010/2013 Workflows and Nintex for most scenarios

### Power Apps

- Custom forms for SharePoint lists (replaces InfoPath)
- Canvas apps connected to SPO data sources
- Model-driven apps for complex business processes
- SharePoint as a data source for citizen developer apps

### Power BI

- Connect to SharePoint Online lists as data sources
- Embed Power BI reports in SharePoint pages
- Usage analytics dashboards for SharePoint content
- Document metadata reporting for governance visibility

---

## 10. What SharePoint Online does not do

An honest assessment of capabilities that remain on-premises advantages:

| Capability                                    | On-premises         | SPO                                    | Notes                                                         |
| --------------------------------------------- | ------------------- | -------------------------------------- | ------------------------------------------------------------- |
| **Full-trust code (farm solutions)**          | Full support        | Not supported                          | Must convert to SPFx; some scenarios have no cloud equivalent |
| **Custom timer jobs**                         | Full support        | Not supported                          | Use Azure Functions or Power Automate scheduled flows         |
| **Custom service applications**               | Full support        | Not supported                          | Re-architect as Azure services or SPFx extensions             |
| **BCS (Business Connectivity Services)**      | Full support        | Limited (deprecated)                   | Use Power Automate or Power Apps custom connectors            |
| **SQL Server Reporting Services integration** | Full support        | Not supported                          | Use Power BI                                                  |
| **Custom IIS configuration**                  | Full support        | Not supported                          | SaaS -- no IIS access                                         |
| **Data sovereignty (specific country)**       | Customer-controlled | Microsoft-controlled (select geo)      | Multi-geo available for specific scenarios                    |
| **Air-gapped environments**                   | Full support        | Not supported                          | SharePoint SE for disconnected environments                   |
| **Unlimited storage**                         | Customer-determined | 25 TB per site + pooled tenant storage | Sufficient for most; large media archives may need Azure Blob |

---

## 11. CSA-in-a-Box value-add for SharePoint Online

Moving to SharePoint Online is step one. CSA-in-a-Box extends the value through governance and analytics:

### Purview governance for SPO content

CSA-in-a-Box deploys Microsoft Purview with automated scanning of SharePoint Online sites. Sensitivity labels classify documents containing CUI, PII, PHI, and other regulated content. DLP policies prevent sensitive content from being shared externally. The Purview data catalog provides a single pane of glass for governance across SPO, OneLake, Azure SQL, and all other data assets in the CSA-in-a-Box estate.

### Copilot readiness through governance

Copilot for M365 surfaces SPO content to users based on their permissions. Without proper governance, Copilot amplifies oversharing risks. CSA-in-a-Box's Purview integration ensures:

1. Sensitivity labels are applied consistently across SPO sites
2. DLP policies prevent sensitive content from appearing in Copilot responses to unauthorized users
3. Access reviews validate that SPO permissions match organizational intent
4. Audit logs track Copilot interactions with SPO content

### Power BI analytics on SPO data

SharePoint lists often contain operational data (project trackers, issue logs, asset inventories) that benefits from Power BI visualization. CSA-in-a-Box provides the semantic model layer and governance framework for building governed reports on SPO list data.

---

## 12. Microsoft Graph and developer ecosystem

SharePoint Online is fully integrated with the Microsoft Graph API, providing a unified REST endpoint for accessing content across the M365 ecosystem:

### Microsoft Graph advantages for developers

| Capability                | On-premises API                   | Microsoft Graph                                     |
| ------------------------- | --------------------------------- | --------------------------------------------------- |
| **API surface**           | SharePoint REST API + CSOM + SOAP | Unified Graph API for all M365 services             |
| **Authentication**        | NTLM, Kerberos, claims            | OAuth 2.0 with Entra ID                             |
| **Webhooks**              | Event receivers (server-side)     | Graph subscriptions (push notifications)            |
| **Change tracking**       | Change log API (per list)         | Delta query API (any resource)                      |
| **Batch operations**      | Limited                           | JSON batching (up to 20 requests)                   |
| **Cross-service queries** | Not possible                      | Query SPO + Teams + OneDrive + Exchange in one call |
| **SDK support**           | .NET CSOM only                    | .NET, JavaScript, Python, Java, Go, PHP             |
| **AI integration**        | None                              | Semantic index, Copilot plugins, AI Builder         |

### Custom development acceleration

```powershell
# Microsoft Graph PowerShell: query SPO sites
Connect-MgGraph -Scopes "Sites.Read.All"

# List all sites
Get-MgSite -Search "finance" | Select-Object DisplayName, WebUrl

# Get items from a list
$siteId = (Get-MgSite -Search "finance")[0].Id
$lists = Get-MgSiteList -SiteId $siteId
$items = Get-MgSiteListItem -SiteId $siteId -ListId $lists[0].Id
```

SPFx developers building solutions for SPO have access to pre-built components, community packages (PnP), and direct integration with the M365 ecosystem that is not available on-premises.

---

## 13. Storage and scalability advantages

### SPO vs on-premises storage

| Metric                           | On-premises                                  | SharePoint Online                     |
| -------------------------------- | -------------------------------------------- | ------------------------------------- |
| **Storage management**           | SQL Server content databases, SAN/NAS        | Fully managed by Microsoft            |
| **Maximum file size**            | 2 GB (default, configurable)                 | 250 GB                                |
| **Maximum site collection size** | Content database limit (~200 GB recommended) | 25 TB                                 |
| **Tenant storage pool**          | Customer-provisioned                         | 1 TB + 10 GB per user                 |
| **Storage scaling**              | Requires new hardware, new content databases | Purchase additional storage on demand |
| **Backup management**            | Customer-managed (SQL backup, farm backup)   | Fully managed by Microsoft            |
| **Disaster recovery**            | Customer-built DR farm                       | Built-in geo-redundancy               |
| **Point-in-time restore**        | SQL database restore (complex)               | File-level restore (simple)           |

### Scalability without infrastructure

On-premises SharePoint scaling requires:

1. Purchasing new servers (4-8 weeks lead time for procurement)
2. Provisioning new SQL Server databases
3. Rebalancing content across databases
4. Adding search index partitions
5. Scaling distributed cache
6. Updating load balancer configuration
7. Testing the expanded topology

SPO scaling requires:

1. Nothing (for most scenarios -- Microsoft scales automatically)
2. Purchasing additional storage if tenant pool is exceeded ($0.20/GB/month)

---

## 14. Migration readiness assessment

Before committing to migration, answer these questions:

| Question                                       | If yes                                                          | If no                      |
| ---------------------------------------------- | --------------------------------------------------------------- | -------------------------- |
| Are you running SharePoint 2010 or 2013?       | Migrate immediately -- unsupported software                     | Continue assessment        |
| Are you running SharePoint 2016?               | Begin migration planning -- support ends July 2026              | Continue assessment        |
| Do you need Copilot for M365?                  | SPO is required -- Copilot cannot index on-premises content     | Evaluate timeline          |
| Do you have farm solutions?                    | Assess SPFx conversion complexity before committing to timeline | Straightforward migration  |
| Do you have SharePoint workflows?              | Plan Power Automate conversion as a parallel workstream         | Standard content migration |
| Do you have InfoPath forms?                    | Plan Power Apps conversion as a parallel workstream             | Standard content migration |
| Do you have air-gapped requirements?           | SharePoint SE is your only option                               | Proceed with SPO migration |
| Are you in a federal GCC/GCC-High environment? | See [Federal Migration Guide](federal-migration-guide.md)       | Standard commercial SPO    |

---

## 13. Next steps

1. **Read the [TCO Analysis](tco-analysis.md)** to quantify the cost case
2. **Review the [Feature Mapping](feature-mapping-complete.md)** to identify migration complexity
3. **Run SMAT** against your on-premises farms to generate a migration assessment
4. **Engage FastTrack** if you have 500+ M365 seats (free Microsoft-led assistance)
5. **Start with the [SPMT Tutorial](tutorial-spmt-migration.md)** for a hands-on pilot

---

## References

- [SharePoint Online service description](https://learn.microsoft.com/office365/servicedescriptions/sharepoint-online-service-description/sharepoint-online-service-description)
- [What's new in SharePoint Online](https://learn.microsoft.com/sharepoint/what-s-new-in-sharepoint-online)
- [SharePoint Server end-of-support roadmap](https://learn.microsoft.com/sharepoint/product-servicing-policy/updated-product-servicing-policy-for-sharepoint-server)
- [Copilot for Microsoft 365 documentation](https://learn.microsoft.com/microsoft-365-copilot/)
- [SharePoint Embedded documentation](https://learn.microsoft.com/sharepoint/dev/embedded/overview)
- [Microsoft 365 roadmap](https://www.microsoft.com/microsoft-365/roadmap)
- [SharePoint hybrid documentation](https://learn.microsoft.com/sharepoint/hybrid/hybrid)

---

**Maintainers:** csa-inabox core team
**Last updated:** 2026-04-30
