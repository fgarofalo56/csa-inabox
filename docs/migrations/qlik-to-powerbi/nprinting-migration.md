---
title: "Qlik NPrinting to Power BI Paginated Reports Migration"
description: "Migrating Qlik NPrinting report templates, email distribution, and parameter-driven reports to Power BI paginated reports and subscriptions."
---

# Qlik NPrinting to Power BI Paginated Reports

**Audience:** Report administrators, BI developers, operations teams
**Purpose:** Replace Qlik NPrinting with Power BI paginated reports -- templates, distribution, parameters
**Reading time:** 12-15 minutes

---

## Executive summary

Qlik NPrinting is a separate product with separate licensing, separate server infrastructure, and separate administration. It provides pixel-perfect reporting, scheduled PDF/Excel distribution, and parameterized report generation for operational reporting needs.

Power BI paginated reports provide the same capabilities -- pixel-perfect layout, scheduled distribution, parameterized reports -- **included in Power BI Premium, Premium Per User, and Fabric capacity at no additional cost**. NPrinting elimination is often the second-largest cost savings in a Qlik-to-Power BI migration (after per-user license reduction).

---

## 1. Architecture comparison

### Qlik NPrinting architecture

```
Qlik Sense App → NPrinting Connection → NPrinting Engine Server
                                              ↓
                                        NPrinting Scheduler
                                              ↓
                                        NPrinting Web Console
                                              ↓
                                    Report Template (Pixel-Perfect)
                                              ↓
                                    Distribution: Email / Folder / Hub
```

Components:

- **NPrinting Server** -- Windows Server with IIS, .NET, PostgreSQL
- **NPrinting Engine** -- separate service for report rendering
- **NPrinting Web Console** -- administration and template design
- **NPrinting Designer** -- Windows desktop application for template creation
- **Connection to Qlik Sense** -- WebSocket connection to Qlik Engine API

### Power BI paginated reports architecture

```
Semantic Model (Power BI) → Paginated Report (.rdl)
                                    ↓
                            Power BI Service (Premium/Fabric)
                                    ↓
                            Subscription (Email / Teams / SharePoint)
```

Components:

- **Power BI Report Builder** -- free desktop application for template creation (or web-based authoring)
- **Power BI Service** -- renders and distributes reports (no separate server)
- **Subscriptions** -- built-in email distribution with PDF/Excel/Word attachment

**Key difference:** NPrinting requires a dedicated server and separate licensing. Paginated reports are a feature of Power BI Premium/Fabric with no additional infrastructure.

---

## 2. Feature mapping

| NPrinting feature                             | Power BI paginated reports                           | Notes                                                    |
| --------------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------- |
| **Pixel-perfect layout**                      | Yes (SSRS-based RDL format)                          | Full control over page layout, margins, headers, footers |
| **Report templates**                          | Report Builder templates (.rdl)                      | Design in Report Builder or web-based editor             |
| **Excel report generation**                   | Export to Excel (formatted)                          | Native Excel export with formatting preserved            |
| **Word report generation**                    | Export to Word                                       | Native Word export                                       |
| **PDF report generation**                     | Export to PDF                                        | Native PDF export (default for subscriptions)            |
| **PowerPoint report generation**              | Export to PowerPoint                                 | Native PowerPoint export                                 |
| **HTML report generation**                    | Export to MHTML / web rendering                      | Reports render as web pages natively                     |
| **Email distribution**                        | Power BI subscriptions (email with attachment)       | Schedule email delivery with PDF/Excel attachment        |
| **Folder output (file share)**                | Power Automate export to SharePoint/OneDrive         | Use Power Automate for file share scenarios              |
| **Hub publishing (Qlik Hub)**                 | Publish to Power BI workspace                        | Reports accessible in Power BI Service                   |
| **Parameters (report-level filtering)**       | Report parameters (dropdown, multi-value, cascading) | Full parameter support including cascading parameters    |
| **Filters (data-level filtering)**            | Query parameters and data source filters             | Filter data at the query level for performance           |
| **Conditions (show/hide sections)**           | Visibility expressions on report items               | Show/hide rows, columns, sections based on data          |
| **Dynamic images**                            | Image expressions (URL-based or embedded)            | Reference images dynamically from data                   |
| **Barcodes/QR codes**                         | Barcode custom visual or external barcode font       | Available through custom approaches                      |
| **Subreports**                                | Subreports (native .rdl feature)                     | Embed one paginated report within another                |
| **Table of contents**                         | Document map (native .rdl feature)                   | Auto-generated navigation from report groups             |
| **Task scheduling (complex chains)**          | Power Automate orchestration                         | Chain subscriptions and exports through Power Automate   |
| **Cycle (burst by dimension)**                | Data-driven subscriptions                            | Generate one report per value (e.g., one per region)     |
| **NPrinting conditions (recipient-specific)** | Data-driven subscriptions + RLS                      | Row-level security filters data per recipient            |
| **Admin console (NPrinting Web Console)**     | Power BI Admin Portal                                | Centralized administration                               |

---

## 3. Template conversion guide

### 3.1 NPrinting template types to paginated report patterns

| NPrinting template type       | Paginated report pattern                                      |
| ----------------------------- | ------------------------------------------------------------- |
| **Qlik Entity (basic table)** | Tablix (table) with dataset from semantic model               |
| **Excel template**            | Tablix exported as Excel; or Excel-formatted paginated report |
| **Word template**             | Free-form layout with text boxes, images, tables              |
| **PowerPoint template**       | Not direct; use Power BI PowerPoint integration instead       |
| **HTML template**             | Paginated report with web rendering                           |
| **PixelPerfect report**       | Paginated report with precise layout control                  |

### 3.2 Converting an NPrinting template step by step

**Step 1: Analyze the NPrinting template**

Document:

- Report layout (page size, orientation, margins)
- Data tables and their columns
- Parameters and filters
- Grouping and subtotals
- Headers, footers, page numbers
- Images and logos
- Conditional formatting rules
- Distribution settings (recipients, schedule, format)

**Step 2: Create the paginated report in Report Builder**

1. Open Power BI Report Builder (free download)
2. Create a new blank report
3. Set page size and margins to match the NPrinting template
4. Add a data source pointing to the Power BI semantic model
5. Create datasets (queries against the semantic model)
6. Add report items (tables, matrices, text boxes, images)
7. Configure grouping, subtotals, and page breaks
8. Add parameters for user-selectable filters
9. Add headers, footers, and page numbers
10. Apply conditional formatting (background color, font rules)

**Step 3: Publish and configure distribution**

1. Publish the .rdl file to a Power BI workspace (Premium or Fabric)
2. Create a subscription for email distribution
3. Configure schedule (daily, weekly, monthly)
4. Set output format (PDF, Excel, Word)
5. Add recipients (individual or group)
6. Configure data-driven subscription for burst/cycle scenarios

---

## 4. Parameter migration

### NPrinting parameters to paginated report parameters

| NPrinting parameter type         | Paginated report parameter                                |
| -------------------------------- | --------------------------------------------------------- |
| **Single select dropdown**       | Single-value parameter with available values from dataset |
| **Multi-select**                 | Multi-value parameter (checkbox list)                     |
| **Date range**                   | Date/DateTime parameter with calendar picker              |
| **Text input**                   | String parameter with text box input                      |
| **Cascading (dependent values)** | Cascading parameters (child depends on parent selection)  |
| **Hidden parameter**             | Hidden parameter with default value                       |

### Example: cascading parameters

```xml
<!-- Paginated report parameter definition -->
<!-- Parent parameter: Region -->
<ReportParameter Name="Region">
  <DataType>String</DataType>
  <Prompt>Select Region</Prompt>
  <ValidValues>
    <DataSetReference>
      <DataSetName>Regions</DataSetName>
      <ValueField>Region</ValueField>
      <LabelField>Region</LabelField>
    </DataSetReference>
  </ValidValues>
</ReportParameter>

<!-- Child parameter: City (filtered by Region) -->
<ReportParameter Name="City">
  <DataType>String</DataType>
  <Prompt>Select City</Prompt>
  <ValidValues>
    <DataSetReference>
      <DataSetName>CitiesByRegion</DataSetName>
      <ValueField>City</ValueField>
      <LabelField>City</LabelField>
    </DataSetReference>
  </ValidValues>
</ReportParameter>
```

The `CitiesByRegion` dataset query includes a `WHERE Region = @Region` filter, creating the cascading dependency.

---

## 5. Distribution migration

### 5.1 Email distribution

| NPrinting distribution feature            | Power BI subscriptions                           |
| ----------------------------------------- | ------------------------------------------------ |
| Send report as PDF attachment             | Subscription with PDF attachment                 |
| Send report as Excel attachment           | Subscription with Excel attachment               |
| Send to distribution list                 | Subscribe Entra ID group or email list           |
| Custom email subject and body             | Custom subject line; body includes report link   |
| Conditional sending (only if data exists) | Data-driven subscription with condition          |
| Burst by dimension (one per region)       | Data-driven subscription with row-level security |
| Schedule (daily, weekly, monthly, custom) | Flexible scheduling (hourly through monthly)     |
| Retry on failure                          | Automatic retry; failure notification to admin   |

### 5.2 File output (folder/share)

NPrinting can output reports to file shares. Power BI subscriptions support email only natively, but Power Automate extends this:

1. Create a Power Automate flow triggered on a schedule
2. Use the "Export paginated report" action
3. Save the output to SharePoint, OneDrive, or Azure Blob Storage
4. Optionally email a link to the saved file

### 5.3 Burst reports (cycle)

NPrinting "cycle" sends a personalized report to each recipient based on their data slice. Power BI achieves this through:

1. **Data-driven subscriptions** -- configure a subscription that sends to multiple recipients, each seeing data filtered by RLS
2. **Power Automate loop** -- iterate over a list of recipients, export a paginated report with parameters set per recipient, and email each one

---

## 6. NPrinting migration checklist

- [ ] **Inventory all NPrinting reports** -- list templates, schedules, recipients, formats, parameters
- [ ] **Classify by complexity** -- simple table reports vs complex multi-page layouts
- [ ] **Identify data sources** -- map NPrinting connections to Power BI semantic models
- [ ] **Create paginated reports** -- design in Report Builder, matching layout and data
- [ ] **Configure parameters** -- recreate all NPrinting parameters including cascading
- [ ] **Set up subscriptions** -- configure email distribution matching NPrinting schedules
- [ ] **Configure data-driven subscriptions** -- for burst/cycle scenarios
- [ ] **Set up Power Automate** -- for file share output and complex distribution scenarios
- [ ] **Validate output** -- compare NPrinting and paginated report output side-by-side
- [ ] **User acceptance** -- get sign-off from report consumers
- [ ] **Parallel run** -- run both NPrinting and paginated reports for 2-4 weeks
- [ ] **Decommission NPrinting** -- shut down NPrinting server after validation period
- [ ] **Calculate savings** -- document NPrinting license and infrastructure cost eliminated

---

## 7. Cost impact

| Cost category                      | NPrinting (annual) | Paginated reports (annual)  | Savings             |
| ---------------------------------- | ------------------ | --------------------------- | ------------------- |
| NPrinting license                  | $18,000-$50,000    | $0 (included in Premium)    | $18,000-$50,000     |
| NPrinting server (Windows + SQL)   | $8,000-$15,000     | $0 (SaaS)                   | $8,000-$15,000      |
| NPrinting administration (0.1 FTE) | $12,000-$20,000    | $0 (no separate admin)      | $12,000-$20,000     |
| NPrinting Designer licenses        | $2,000-$5,000      | $0 (Report Builder is free) | $2,000-$5,000       |
| **Total annual savings**           |                    |                             | **$40,000-$90,000** |

---

## Cross-references

| Topic                               | Document                                              |
| ----------------------------------- | ----------------------------------------------------- |
| Server migration context            | [Server Migration](server-migration.md)               |
| Feature mapping (reporting section) | [Feature Mapping](feature-mapping-complete.md)        |
| Full migration playbook             | [Migration Playbook](../qlik-to-powerbi.md)           |
| Federal compliance for reports      | [Federal Migration Guide](federal-migration-guide.md) |

---

**Maintainers:** CSA-in-a-Box core team
**Last updated:** 2026-04-30
