---
title: "Qlik to Power BI Server Migration"
description: "Migrating Qlik Sense Enterprise server infrastructure to Power BI Service — spaces to workspaces, security rules to RLS, reload tasks to scheduled refresh, QMC to admin portal."
---

# Qlik to Power BI: Server Migration

**Audience:** BI administrators, IT operations, platform engineers
**Purpose:** Infrastructure-level migration from Qlik Sense Enterprise to Power BI Service
**Reading time:** 15-20 minutes

---

## 1. Architecture comparison

### Qlik Sense Enterprise on Windows

Qlik Sense Enterprise runs as a multi-service Windows application across one or more servers:

- **Repository Service** -- metadata database (PostgreSQL), app storage, security rules
- **Engine Service** -- in-memory calculation engine, app loading
- **Proxy Service** -- authentication, session management, load balancing
- **Scheduler Service** -- reload task scheduling and execution
- **Printing Service** -- NPrinting integration (separate server)
- **Shared persistence** -- file share for QVF/QVD storage

### Power BI Service (SaaS)

Power BI Service is a fully managed SaaS platform:

- **No server infrastructure** -- Microsoft manages compute, storage, networking
- **No patching or upgrades** -- updates deploy automatically
- **No capacity planning** -- scale through license tier or Fabric SKU selection
- **No disaster recovery configuration** -- built into the service
- **Admin portal** -- web-based administration for tenant, capacities, and workspaces

The migration from Qlik Sense Enterprise to Power BI Service is also a migration from **self-managed infrastructure** to **SaaS**. This eliminates the operational burden of Windows Server management, PostgreSQL database maintenance, certificate management, and cluster scaling.

---

## 2. Concept mapping

### 2.1 Content organization

| Qlik concept                        | Power BI equivalent                           | Notes                                                                 |
| ----------------------------------- | --------------------------------------------- | --------------------------------------------------------------------- |
| **Stream** (content distribution)   | **Workspace** (content container)             | 1 stream = 1 workspace; workspaces have granular role assignments     |
| **Shared space** (Qlik Cloud)       | **Workspace** (shared)                        | Direct mapping                                                        |
| **Managed space** (Qlik Cloud)      | **Workspace** with deployment pipeline        | Managed spaces map to production workspaces with promotion controls   |
| **Personal space** (Qlik Cloud)     | **My workspace**                              | Personal development area; do not publish from here                   |
| **App** (QVF file)                  | **Report** (.pbix) + **Semantic model**       | In Power BI, report and dataset can be separated for reuse            |
| **Sheet** (within app)              | **Report page** (within report)               | Direct mapping                                                        |
| **Story** (guided narrative)        | **Report pages** with page navigator          | Use page navigator for sequential storytelling                        |
| **Bookmark** (saved selections)     | **Bookmark** (saved filter state)             | Direct mapping; Power BI bookmarks can also control visual visibility |
| **Published app** (stream content)  | **Published report** in workspace             | Publish from Desktop to workspace                                     |
| **App copy** (personal copy of app) | **Save a copy** of report to My workspace     | Similar functionality                                                 |
| **Data connection** (source config) | **Data source** in gateway or cloud connector | Centrally managed in Power BI admin settings                          |
| **Content library** (images, files) | **OneDrive / SharePoint** for shared assets   | Store images, templates in SharePoint; reference in reports           |
| **Tag** (metadata on apps)          | **Endorsement** (Certified, Promoted)         | Endorsement labels serve as governance indicators                     |

### 2.2 User and security mapping

| Qlik concept                        | Power BI equivalent                                   | Notes                                                              |
| ----------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------ |
| **User directory connector**        | **Entra ID (Azure AD) sync**                          | Power BI uses Entra ID natively; no separate user directory needed |
| **Security rule** (attribute-based) | **Workspace role** + **RLS** + **sensitivity labels** | See detailed security mapping below                                |
| **Stream access rule**              | **Workspace role assignment**                         | Admin, Member, Contributor, Viewer                                 |
| **Section Access** (data reduction) | **Row-level security (RLS)**                          | DAX-based RLS in the semantic model                                |
| **App-level access**                | **Report/dataset sharing** or **App distribution**    | Share individual items or package into apps for distribution       |
| **Login access rule**               | **Entra ID Conditional Access**                       | MFA, device compliance, location-based access                      |
| **Audit trail (Repository API)**    | **Activity Log** + **Log Analytics**                  | More detailed than Qlik; export to Azure Monitor                   |

### 2.3 Administration mapping

| Qlik concept                      | Power BI equivalent                             | Notes                                                                  |
| --------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------- |
| **QMC (Management Console)**      | **Power BI Admin Portal**                       | Web-based; accessible at app.powerbi.com/admin                         |
| **Node management**               | **N/A** (SaaS, auto-managed)                    | No servers to manage                                                   |
| **License allocation**            | **M365 Admin Center license assignment**        | Assign Pro/PPU licenses through M365 admin                             |
| **Task scheduling (reloads)**     | **Dataset refresh schedule**                    | Configure per dataset; up to 48/day on Premium                         |
| **Reload task triggers**          | **Scheduled refresh** + **Power Automate**      | Power Automate for event-driven refresh                                |
| **Engine performance monitoring** | **Premium/Fabric Capacity Metrics app**         | Monitor CPU, memory, query duration, refresh duration                  |
| **App migration (import/export)** | **Deployment pipelines** (Dev/Test/Prod)        | Native ALM without manual file import/export                           |
| **Extensions management**         | **Admin Portal > Custom visuals**               | Org-wide visual management with approved/blocked lists                 |
| **Mashup management**             | **Power BI Embedded > Embed codes**             | Manage embedded content through admin portal                           |
| **Monitoring apps**               | **Usage Metrics** + **Fabric Capacity Metrics** | Built-in usage analytics; export to Log Analytics for custom reporting |

---

## 3. Security rule migration

### 3.1 Qlik security rules to Power BI

Qlik security rules are attribute-based policies evaluated by the Proxy and Repository services. They control access to streams, apps, and data at a granular level.

Power BI uses a layered security model:

| Layer                     | What it controls                                 | Configuration location              |
| ------------------------- | ------------------------------------------------ | ----------------------------------- |
| **Tenant settings**       | Feature availability across the organization     | Admin Portal > Tenant Settings      |
| **Workspace roles**       | Who can author, publish, view in each workspace  | Workspace > Manage Access           |
| **App permissions**       | Who can view distributed apps                    | App > Manage Permissions            |
| **Row-level security**    | What data rows each user can see                 | Semantic model > Manage Roles (DAX) |
| **Object-level security** | Which tables/columns are visible per role        | Semantic model > Perspectives       |
| **Sensitivity labels**    | Information protection classification on content | Purview > Sensitivity Labels        |

### 3.2 Common Qlik security rule patterns

**Pattern: Stream access by group**

```
// Qlik security rule
Resource filter: Stream_*
Condition: user.group = "FinanceTeam"
Actions: Read
```

```
// Power BI equivalent
// 1. Create workspace "Finance Reports"
// 2. Add Entra ID group "FinanceTeam" as Viewer role
// 3. Publish reports to this workspace
```

**Pattern: App-level Section Access**

```
// Qlik data load script (Section Access)
Section Access;
LOAD * INLINE [
    ACCESS, USERID, REDUCTION
    USER, DOMAIN\john, East
    USER, DOMAIN\jane, West
    ADMIN, DOMAIN\admin,
];

Section Application;
// Data load continues...
```

```dax
// Power BI RLS equivalent
// 1. Create a SecurityMapping table with UserEmail and Region columns
// 2. Define RLS role "RegionFilter" with DAX expression:
[Region] = LOOKUPVALUE(
    SecurityMapping[Region],
    SecurityMapping[UserEmail],
    USERPRINCIPALNAME()
)
// 3. Assign users/groups to the role in the Power BI Service
```

**Pattern: Attribute-based access (dynamic)**

```
// Qlik: Dynamic security rule based on user attributes
Condition: user.department = resource.stream.customProperty("AllowedDepartment")

// Power BI: Dynamic RLS with user-group mapping table
// 1. Create a DimUserAccess table: UserEmail, Department, Region, etc.
// 2. Import into the semantic model
// 3. Create relationships from DimUserAccess to fact tables
// 4. RLS DAX expression:
CONTAINS(
    DimUserAccess,
    DimUserAccess[UserEmail], USERPRINCIPALNAME()
)
// This filters all related tables through the access table
```

---

## 4. Reload task to scheduled refresh migration

### 4.1 Mapping reload patterns

| Qlik reload pattern                                | Power BI equivalent                              | Notes                                                  |
| -------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------ |
| Scheduled reload (daily at 2 AM)                   | Scheduled refresh (configure time and frequency) | Up to 8/day on Pro, 48/day on Premium                  |
| Triggered reload (on event)                        | Power Automate triggered refresh                 | Use Power Automate to trigger refresh via REST API     |
| Chained reload (App A finishes, then App B starts) | Dataflow Gen2 dependency + refresh sequence      | Or Power Automate orchestration                        |
| Partial reload (incremental)                       | Incremental refresh policy                       | Configure in Power BI Desktop > Advanced settings      |
| Full reload                                        | Full refresh                                     | Default behavior                                       |
| Reload from QVD cache                              | Direct Lake (no refresh needed)                  | Direct Lake eliminates the need for refresh entirely   |
| ODAG (on-demand generation)                        | DirectQuery or parameterized report              | No ODAG equivalent; use DirectQuery for on-demand data |

### 4.2 Direct Lake: eliminating refresh entirely

With CSA-in-a-Box, the target architecture uses Direct Lake, which reads Delta tables directly from OneLake. This eliminates the entire concept of scheduled refresh:

- No reload tasks to manage
- No refresh failures to troubleshoot
- No stale data between refreshes
- No scheduling conflicts between multiple apps

The only "refresh" is the data pipeline that updates the Gold layer tables (ADF + dbt), which is managed by the data platform team, not the BI team.

---

## 5. Monitoring and operations

### 5.1 QMC monitoring to Power BI monitoring

| Qlik monitoring capability                 | Power BI equivalent                           |
| ------------------------------------------ | --------------------------------------------- |
| Engine performance (CPU, memory)           | Premium/Fabric Capacity Metrics app           |
| App reload status and duration             | Refresh history in dataset settings           |
| User sessions and concurrency              | Activity Log + Log Analytics                  |
| Audit log (who accessed what)              | Activity Log REST API + Log Analytics         |
| License usage                              | M365 Admin Center usage reports               |
| Error logs                                 | Azure Monitor + Log Analytics                 |
| Custom monitoring app (Operations Monitor) | Power BI Usage Metrics report (per workspace) |

### 5.2 Advanced monitoring with Log Analytics

For organizations requiring detailed monitoring (equivalent to Qlik's Operations Monitor and custom monitoring apps), export Power BI activity logs to Azure Log Analytics:

1. Enable Log Analytics integration in Power BI Admin Portal
2. Configure a Log Analytics workspace in Azure
3. Query Power BI events using KQL:

```kql
PowerBIActivity
| where ActivityName == "ViewReport"
| summarize ViewCount = count() by ReportName, UserName
| order by ViewCount desc
| take 20
```

This provides richer analytics than QMC's built-in monitoring, with the full power of KQL for custom dashboards and alerting.

---

## 6. Migration execution steps

### Step 1: Inventory (Week 1)

1. Export the Qlik Sense site inventory via QMC REST API or manual export
2. Catalog all streams, apps, data connections, security rules, reload tasks, and users
3. Map the current stream hierarchy to a target workspace hierarchy
4. Identify stale apps (last accessed > 90 days) for archival
5. Document all custom security rules for conversion

### Step 2: Workspace setup (Week 2)

1. Create Power BI workspaces matching the target hierarchy
2. Assign Entra ID groups to workspace roles (Admin, Member, Contributor, Viewer)
3. Create deployment pipelines (Dev/Test/Prod) for production workspaces
4. Configure tenant settings in the Admin Portal (org-wide policies)

### Step 3: Security configuration (Week 3)

1. Convert Qlik Section Access to Power BI RLS roles
2. Create user-access mapping tables if dynamic security is needed
3. Configure sensitivity labels for classified content
4. Test security by validating that each user sees only their authorized data

### Step 4: Data connection migration (Week 3-4)

1. Install and configure Power BI gateway for on-premises data sources
2. Configure cloud data source credentials in Power BI Service
3. Set up Direct Lake connections to CSA-in-a-Box Gold tables
4. Validate data connectivity from all target semantic models

### Step 5: Refresh schedule configuration (Week 4)

1. Map Qlik reload schedules to Power BI refresh schedules
2. Configure incremental refresh for large datasets
3. Set up Power Automate flows for event-driven refresh scenarios
4. Validate refresh success and timing

### Step 6: Validation and cutover (Week 5)

1. Verify all workspaces are accessible to the correct users
2. Confirm RLS restricts data as expected
3. Validate refresh schedules are executing correctly
4. Redirect users from Qlik Hub to Power BI workspace/app URLs
5. Archive QVF files for rollback (retain 90 days)

---

## 7. Server migration checklist

- [ ] Export Qlik site inventory (apps, streams, users, security rules, tasks)
- [ ] Design Power BI workspace hierarchy
- [ ] Create workspaces and assign Entra ID groups
- [ ] Configure deployment pipelines (Dev/Test/Prod)
- [ ] Convert Section Access to RLS roles
- [ ] Install and configure Power BI gateway (if on-prem sources exist)
- [ ] Configure cloud data source credentials
- [ ] Set up Direct Lake connections to CSA-in-a-Box Gold tables
- [ ] Configure refresh schedules (or validate Direct Lake auto-refresh)
- [ ] Set up monitoring (Usage Metrics, Log Analytics)
- [ ] Configure tenant settings (custom visuals, export controls, sharing policies)
- [ ] Apply sensitivity labels to classified content
- [ ] Create Power BI apps for end-user distribution
- [ ] Redirect Qlik Hub URLs to Power BI workspace/app URLs
- [ ] Archive QVF files
- [ ] Decommission Qlik Sense servers

---

## Cross-references

| Topic                         | Document                                              |
| ----------------------------- | ----------------------------------------------------- |
| Security and RLS details      | [Feature Mapping](feature-mapping-complete.md)        |
| NPrinting replacement         | [NPrinting Migration](nprinting-migration.md)         |
| Federal government compliance | [Federal Migration Guide](federal-migration-guide.md) |
| Full migration playbook       | [Migration Playbook](../qlik-to-powerbi.md)           |

---

**Maintainers:** CSA-in-a-Box core team
**Last updated:** 2026-04-30
