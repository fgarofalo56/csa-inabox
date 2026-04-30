# Tutorial: Rebuilding a Workshop App in Power Apps

**A hands-on walkthrough for analyzing a Palantir Foundry Workshop application and rebuilding it as a Power Apps canvas app with Power Automate flows, Power BI embedded visuals, and Azure-native data sources.**

---

## Overview

| Detail | Value |
|---|---|
| **Estimated time** | 2-3 hours |
| **Difficulty** | Intermediate |
| **Prerequisites** | Power Apps license (per-app or per-user), Power Automate, Azure SQL or Dataverse, Power BI workspace |
| **What you will build** | A canvas app that replicates a Foundry Workshop app, including data galleries, detail forms, action flows, map controls, and embedded Power BI dashboards |

Palantir Foundry Workshop is the platform's no-code application builder. It lets users assemble screens from widgets (tables, charts, maps, forms, action buttons) that bind to Ontology objects and actions. This tutorial walks through the full process of migrating a Workshop app to Power Apps, step by step.

> **Foundry-to-Azure comparison:** Workshop is a proprietary, Ontology-coupled app builder with no export path. Power Apps is a general-purpose low-code platform that connects to hundreds of data sources, runs on web and mobile, and integrates with the entire Microsoft 365 and Azure ecosystem. Once rebuilt in Power Apps, your application is portable, extensible, and not locked to a single vendor's data layer.

---

## Widget mapping reference

Before you start building, use this table to identify the Power Apps equivalent for each Workshop widget you encounter.

| Workshop widget | Power Apps equivalent | Notes |
|---|---|---|
| **Resource List / Object Table** | Gallery control (vertical or horizontal) | Bind to a data source; supports templates, icons, conditional formatting |
| **Object Detail View** | Display form or Edit form | Use `Item` property bound to gallery selection |
| **Filter Bar** | Dropdown, ComboBox, DatePicker, TextInput | Chain filters with `Filter()` and `Search()` functions |
| **Tab Navigation** | Tab List control or custom toggle buttons | Use `Visible` property on containers to switch screens inline, or use `Navigate()` for separate screens |
| **Action Button** | Button control + Power Automate flow | Use `Run()` to invoke a Power Automate flow from the button's `OnSelect` |
| **Metric / KPI Card** | Label or Card control with aggregation | Use `CountRows()`, `Sum()`, `Average()` on the data source |
| **Chart (Bar, Line, Pie)** | Power BI tile embedded in Power Apps | Embed a Power BI visual for full interactivity; use the native Charts control only for simple cases |
| **Map Widget** | Map control (preview) or Power BI map visual | Native Map control supports pins and routes; embed Power BI for choropleths |
| **Inbox / Task List** | Gallery with status filters | Add filter buttons for "Open", "In Progress", "Closed" |
| **Form (Writeback)** | Edit form control | Bind to data source with `SubmitForm()` for writes |
| **Linked Object List** | Second gallery filtered by parent record | Use `Filter(ChildTable, ParentID = Gallery1.Selected.ID)` |
| **Embedded Dashboard** | Power BI report or tile control | Use the Power BI connector in Power Apps |
| **Image / Attachment** | Image control + Attachment control | Dataverse supports native attachments; Azure SQL uses blob URLs |
| **Toggle / Switch** | Toggle control | Maps directly |
| **Status Badge** | Label with conditional `Fill` and `Color` | Use `Switch()` or `If()` to set colors by status value |

---

## Step 1: Analyze the Workshop app

**Goal:** Document every screen, widget, data source, action, and event in the existing Workshop app so you have a complete migration specification.

### 1.1 Inventory screens and widgets

Open the Workshop app in Foundry. For each screen, record the following in a spreadsheet or table:

| Field | What to capture |
|---|---|
| Screen name | The tab or page title (e.g., "Case Inbox", "Case Detail", "Dashboard") |
| Widgets | Every widget on the screen and its type (table, chart, map, form, button, metric card) |
| Data source | The Ontology object type(s) or dataset(s) each widget binds to |
| Filters | Filter widgets and which properties they filter on |
| Actions | Action buttons and what each action does (update status, create object, send notification) |
| Events | Widget-to-widget events (e.g., selecting a row in a table populates a detail panel) |
| Conditional logic | Any conditional visibility, formatting, or validation rules |

### 1.2 Identify common Workshop patterns

Most Workshop apps follow one or more of these structural patterns. Identify which patterns your app uses, because each maps to a specific Power Apps layout:

| Workshop pattern | Description | Power Apps equivalent |
|---|---|---|
| **Inbox / Task List** | Filterable list of work items with status badges and action buttons | Gallery + filter dropdowns + Power Automate flows |
| **COP Dashboard** | Common operating picture with KPI cards, charts, and a map | Power BI embedded report with slicers |
| **Detail View** | Single-object view with properties, related lists, and action buttons | Form + related galleries + flow buttons |
| **Data Entry Form** | Multi-field input form with validation and writeback | Edit form control with `SubmitForm()` |
| **Master-Detail** | Split view with a list on the left and detail on the right | Two-column layout with Gallery + Form |

### 1.3 Map data sources

For each Ontology object type used in the Workshop app, identify the corresponding table in your Azure environment:

- If you followed the [Ontology Migration](ontology-migration.md) guide, your Ontology object types are now dbt gold-layer tables in Azure SQL or Fabric SQL endpoint.
- If you are using Dataverse, your object types are Dataverse tables.
- Record the table name, primary key, and important columns for each object type.

> **Foundry-to-Azure comparison:** In Foundry, Workshop binds directly to Ontology object types. In Power Apps, you connect to data sources (Azure SQL, Dataverse, SharePoint, etc.) and bind controls to those tables. The data binding model is conceptually the same, but Power Apps gives you more flexibility in which data sources you combine.

**Expected result after this step:** A complete inventory document listing every screen, widget, data source, action, and event in the Workshop app, along with the corresponding Azure data source for each Ontology object type.

---

## Step 2: Set up data sources

**Goal:** Connect Power Apps to the Azure data layer that replaced Foundry's Ontology.

### 2.1 Option A: Azure SQL via Data API Builder

If your gold-layer tables are in Azure SQL Database, use Data API Builder (DAB) to expose them as a REST or GraphQL API that Power Apps can consume via a custom connector.

1. **Deploy Data API Builder** alongside your Azure SQL instance. If you used CSA-in-a-Box, DAB is already configured in the Data Landing Zone.
2. **Define entities** in the DAB configuration for each table Power Apps needs. Example snippet for a `cases` table:

   ```json
   {
     "entities": {
       "Case": {
         "source": "gold.cases",
         "rest": { "path": "/cases" },
         "permissions": [
           {
             "role": "authenticated",
             "actions": ["read", "update"]
           }
         ]
       }
     }
   }
   ```

3. **Create a custom connector** in Power Apps that points to your DAB endpoint. Use the OpenAPI definition DAB auto-generates.
4. **Test the connection** by querying a few records in the Power Apps designer.

### 2.2 Option B: Dataverse

If you migrated Ontology objects into Dataverse tables:

1. Open Power Apps at [make.powerapps.com](https://make.powerapps.com).
2. Go to **Tables** in the left navigation and verify your tables exist (e.g., `Case`, `Evidence`, `Party`).
3. When building the canvas app, add Dataverse as a data source -- tables appear automatically.

### 2.3 Configure security

| Foundry mechanism | Azure equivalent |
|---|---|
| Ontology object-level markings | Dataverse row-level security or Azure SQL row-level security (RLS) policies |
| Property-level classifications | Dataverse column security profiles or Azure SQL column-level permissions |
| Action permissions | Power Automate flow-level RBAC via Entra ID security groups |

> **Foundry-to-Azure comparison:** Foundry enforces security through markings applied to objects and properties. Azure uses Entra ID-based RBAC at every layer. Row-level security in Azure SQL uses `SESSION_CONTEXT` or security predicates; Dataverse uses business units and security roles. Both approaches achieve the same outcome but use standard, auditable Azure identity primitives.

**Expected result after this step:** Power Apps can read from and write to your Azure data sources, with security rules enforced at the data layer.

---

## Step 3: Build the main screen

**Goal:** Create the canvas app and build the primary list/inbox screen.

### 3.1 Create the canvas app

1. Go to [make.powerapps.com](https://make.powerapps.com).
2. Select **+ Create** > **Blank app** > **Blank canvas app**.
3. Name the app (e.g., "Case Management Portal").
4. Choose **Tablet** layout for desktop-first apps or **Phone** layout for mobile-first. Tablet is the closer match to Workshop's desktop layout.
5. Add your data source(s) (Azure SQL custom connector or Dataverse tables).

### 3.2 Add a gallery (Workshop Resource List equivalent)

The gallery control is the Power Apps equivalent of Workshop's Object Table / Resource List widget.

1. Insert a **Vertical gallery** control.
2. Set its `Items` property to your data source table:

   ```
   Cases
   ```

3. Configure the gallery template to show key fields. For a case management app, display case ID, title, status, and assigned analyst.
4. Add conditional formatting for the status badge. In the status label's `Fill` property:

   ```
   Switch(
       ThisItem.Status,
       "Open", RGBA(0, 120, 212, 0.15),
       "In Progress", RGBA(255, 185, 0, 0.15),
       "Closed", RGBA(16, 124, 16, 0.15),
       RGBA(200, 200, 200, 0.15)
   )
   ```

### 3.3 Add filters (Workshop Filter Bar equivalent)

1. Insert a **Dropdown** control above the gallery for status filtering. Set its `Items` to:

   ```
   ["All", "Open", "In Progress", "Closed"]
   ```

2. Insert a **TextInput** control for search.
3. Update the gallery's `Items` property to apply both filters:

   ```
   Filter(
       Cases,
       (StatusDropdown.Selected.Value = "All" Or Status = StatusDropdown.Selected.Value)
       And (SearchInput.Text = "" Or Title in SearchInput.Text)
   )
   ```

### 3.4 Add navigation (Workshop Tabs equivalent)

If the Workshop app has multiple tabs (e.g., "Inbox", "Dashboard", "Admin"):

1. Insert a **Tab List** control (modern control) or create custom toggle buttons in a horizontal container.
2. Create separate screens for each major section: `InboxScreen`, `DashboardScreen`, `AdminScreen`.
3. Wire navigation. In each tab's `OnSelect`:

   ```
   Navigate(InboxScreen, ScreenTransition.None)
   ```

**Expected result after this step:** A working main screen with a filterable, searchable list of records and navigation to other screens. This replaces the Workshop inbox/task list pattern.

---

## Step 4: Build detail screens

**Goal:** Create the detail view that appears when a user selects a record from the main gallery.

### 4.1 Create the detail form (Workshop Object Detail View equivalent)

1. Add a new screen named `DetailScreen`.
2. Insert a **Display form** control (use **Edit form** if you need inline editing).
3. Set the form's `Item` property to the selected record from the gallery:

   ```
   InboxGallery.Selected
   ```

4. Configure which fields appear and their order. Drag fields in the form editor to rearrange.
5. Add a **Back** button with `Navigate(InboxScreen, ScreenTransition.None)` in its `OnSelect`.

### 4.2 Add related data galleries (Workshop Linked Object Lists equivalent)

If the Workshop detail view shows related objects (e.g., evidence items linked to a case):

1. Insert a second **Vertical gallery** on the detail screen.
2. Set its `Items` property to filter the related table by the parent record's key:

   ```
   Filter(Evidence, CaseID = InboxGallery.Selected.ID)
   ```

3. Configure the gallery template to show relevant fields from the related table.

### 4.3 Embed a Power BI visual (Workshop Chart Widget equivalent)

For charts that require advanced visualization (time series, geospatial heatmaps, complex aggregations), embed a Power BI visual rather than using Power Apps' native chart control.

1. In Power BI Desktop, create a report page with the visual you need (e.g., a bar chart of case counts by category).
2. Publish the report to your Power BI workspace.
3. In Power Apps, insert a **Power BI tile** control.
4. Set the `Workspace` and `Report` properties to point to your published report.
5. Optionally apply filters so the embedded visual responds to the selected record:

   ```
   "cases/case_id eq '" & InboxGallery.Selected.ID & "'"
   ```

> **Foundry-to-Azure comparison:** Workshop embeds Contour boards and Quiver charts as widgets. In Power Apps, you embed Power BI reports or tiles. The Power BI visuals offer richer interactivity (drill-through, cross-filtering, Q&A) than Contour boards, and the same report can be used standalone, in Teams, or in Power Apps.

**Expected result after this step:** A detail screen showing the selected record's properties, related record lists, and embedded Power BI visuals. This replaces Workshop's object detail view pattern.

---

## Step 5: Add actions with Power Automate

**Goal:** Replace Workshop Action buttons with Power Automate flows triggered from Power Apps.

### 5.1 Understand the mapping

| Workshop concept | Power Automate equivalent |
|---|---|
| Action type (e.g., "Update Status") | Flow with data connector action (SQL update, Dataverse patch) |
| Action parameters (user inputs) | Flow trigger inputs (text, choice, date) |
| Action validation rules | Flow condition steps or Power Apps input validation |
| Action side effects (notifications) | Flow actions: Send Email, Post to Teams, Push Notification |
| Action permissions | Flow connection RBAC + Entra ID group checks |

### 5.2 Create an example flow: "Escalate Case"

This flow replicates a Workshop action that updates a case's priority and notifies a supervisor.

1. In [make.powerautomate.com](https://make.powerautomate.com), select **+ Create** > **Instant cloud flow**.
2. Choose the trigger **PowerApps (V2)**.
3. Add input parameters the flow will receive from Power Apps:
   - `CaseID` (text)
   - `EscalationReason` (text)
   - `NewPriority` (text)
4. Add a **SQL Server: Execute a SQL query** action (or **Dataverse: Update a row**) to update the case:

   ```sql
   UPDATE gold.cases
   SET priority = @{triggerBody()['text_2']},
       escalation_reason = @{triggerBody()['text_1']},
       updated_at = GETUTCDATE()
   WHERE case_id = @{triggerBody()['text']}
   ```

5. Add a **Send an email (V2)** action to notify the supervisor:
   - **To:** Supervisor's email (look up from a reference table or hard-code for the tutorial)
   - **Subject:** `Case @{triggerBody()['text']} escalated`
   - **Body:** `Case has been escalated to @{triggerBody()['text_2']} priority. Reason: @{triggerBody()['text_1']}`
6. Add a **Post message in a chat or channel** action (Microsoft Teams) for team visibility.
7. Save the flow.

### 5.3 Connect the flow to Power Apps

1. In the Power Apps designer on the detail screen, insert a **Button** control labeled "Escalate Case".
2. In the button's `OnSelect` property, call the flow:

   ```
   EscalateCase.Run(
       InboxGallery.Selected.ID,
       EscalationReasonInput.Text,
       PriorityDropdown.Selected.Value
   )
   ```

3. Add a confirmation message using `Notify()`:

   ```
   Notify("Case escalated successfully", NotificationType.Success)
   ```

4. Optionally refresh the gallery to reflect the updated status:

   ```
   Refresh(Cases)
   ```

> **Foundry-to-Azure comparison:** Workshop Actions are Ontology-coupled and run inside Foundry's compute. Power Automate flows are standalone, cloud-hosted workflows with 500+ connectors. A single flow can update a database, send an email, post to Teams, call an Azure Function, and trigger a Logic App, all in one execution. Flows are also versioned, monitored, and governed independently from the app.

**Expected result after this step:** A working "Escalate Case" button on the detail screen that updates the database and sends notifications. Repeat this pattern for every Workshop action in your inventory.

---

## Step 6: Add maps and geospatial (if applicable)

**Goal:** Replace Workshop map widgets with Power Apps map controls.

### 6.1 Enable the Map control

The Power Apps Map control (preview) renders an interactive map with pins, routes, and shapes.

1. In the Power Apps designer, go to **Settings** > **Upcoming features** > **Preview** and enable **Map**.
2. Insert a **Map** control onto the appropriate screen.

### 6.2 Configure data binding

1. Set the map's `Items` property to your geospatial data source:

   ```
   Filter(Cases, Not(IsBlank(Latitude)) And Not(IsBlank(Longitude)))
   ```

2. Set `ItemsLatitudes` to `"Latitude"` and `ItemsLongitudes` to `"Longitude"`.
3. Set `ItemsLabels` to `"Title"` to display labels on pins.
4. Set `ItemsColors` to a status-based color column if you want color-coded pins.

### 6.3 Alternative: Embed a Power BI map

For choropleths, heatmaps, or ArcGIS-style maps, embed a Power BI report that uses the ArcGIS Maps or Azure Maps visual:

1. Create the map visual in Power BI Desktop.
2. Publish to your workspace.
3. Embed in Power Apps using the **Power BI tile** control (same process as step 4.3).

> **Foundry-to-Azure comparison:** Workshop's map widget uses Mapbox under the hood. Power Apps Map uses Azure Maps. For advanced geospatial (polygons, geofences, spatial queries), use Azure Maps REST APIs called from Power Automate or embed the ArcGIS visual in Power BI.

**Expected result after this step:** An interactive map displaying location-based records with pins, replacing Workshop's map widget.

---

## Step 7: Embed Power BI dashboards

**Goal:** Replace Workshop embedded Contour and Quiver boards with Power BI reports inside Power Apps.

### 7.1 Build the Power BI report

1. Open Power BI Desktop.
2. Connect to your data source (Azure SQL via DirectQuery or Import, or Fabric SQL endpoint via Direct Lake).
3. Build the dashboard visuals that replicate the Workshop dashboard:
   - KPI cards for key metrics
   - Bar/line charts for trends
   - Tables for detailed data
   - Maps for geospatial views
4. Add slicers for filtering (date range, category, status).
5. Publish the report to your Power BI workspace.

### 7.2 Embed in Power Apps

1. In Power Apps, create a `DashboardScreen` (or add to an existing screen).
2. Insert a **Power BI tile** control.
3. Set the `Workspace` property to your Power BI workspace name.
4. Set the `Dashboard` or `Report` property to the published report.
5. Resize the control to fill the screen area.

### 7.3 Add cross-filtering (optional)

To pass filter context from Power Apps controls (e.g., a dropdown) to the embedded Power BI report:

1. Set the Power BI tile's `TileUrl` property with a filter parameter:

   ```
   "https://app.powerbigov.us/reportEmbed?reportId=<REPORT_ID>&filter=cases/status eq '"
   & StatusDropdown.Selected.Value & "'"
   ```

2. This lets users filter the embedded dashboard without leaving Power Apps.

> **Foundry-to-Azure comparison:** Workshop embeds Contour boards (dataset-level analysis) and Quiver dashboards (Ontology-level analysis) as widgets. Power BI replaces both with a single, richer visualization platform. Power BI reports can be consumed in Power Apps, Teams, SharePoint, the Power BI service, and mobile apps from a single published artifact.

**Expected result after this step:** A dashboard screen in Power Apps with embedded Power BI visuals that replicate the Workshop COP dashboard pattern.

---

## Step 8: Test and publish

**Goal:** Validate the rebuilt app with pilot users and publish to the organization.

### 8.1 Functional testing

Walk through every screen and verify:

| Test area | What to verify |
|---|---|
| **Data loading** | All galleries and forms display correct data from Azure SQL or Dataverse |
| **Filtering** | Dropdowns, search boxes, and date pickers filter records correctly |
| **Navigation** | All tabs, buttons, and back-navigation work as expected |
| **Detail view** | Selecting a record shows the correct detail form and related data |
| **Actions** | Every Power Automate flow executes successfully (check flow run history) |
| **Notifications** | Email and Teams notifications are sent with correct content |
| **Maps** | Pins render at correct locations; clicking a pin shows the right record |
| **Power BI visuals** | Embedded reports load, display data, and respond to filters |
| **Security** | Users see only the records they are authorized to view (test with multiple accounts) |
| **Performance** | Screens load within 3 seconds; galleries paginate or delegate correctly |

### 8.2 Delegation and performance

Power Apps has a delegation limit (default 500 rows, configurable to 2,000). For tables with more rows, ensure your filter expressions are delegable to the data source:

- **Dataverse:** Most filter operations are delegable.
- **SQL Server:** `Filter()`, `Search()`, and `Sort()` are delegable. Complex expressions may not be.
- **Custom connectors (DAB):** Delegation depends on connector configuration; implement server-side paging.

If the Workshop app displays large datasets, use server-side paging in your DAB API or Dataverse views.

### 8.3 Pilot testing

1. Share the app with 3-5 pilot users from the original Workshop user base.
2. Collect feedback on:
   - Missing functionality compared to the Workshop app
   - Usability issues
   - Performance concerns
3. Iterate on the app based on feedback.

### 8.4 Publish to app catalog

1. In the Power Apps designer, select **File** > **Save** > **Publish**.
2. Set the app icon, description, and background color.
3. Share the app with the appropriate Entra ID security group(s).
4. For broad distribution, add the app to a **Managed Environment** and pin it in the Microsoft Teams app bar.

### 8.5 Set up mobile access

1. Users install the **Power Apps** mobile app from their device's app store.
2. The published app appears automatically in their app list.
3. For offline scenarios, configure offline profiles in Dataverse (Dataverse only; Azure SQL requires connectivity).

> **Foundry-to-Azure comparison:** Workshop apps are only accessible through a web browser inside the Foundry platform. Power Apps runs on web, iOS, Android, and Windows. It can be embedded in Teams, SharePoint, and Power Pages. Users do not need a Foundry license or VPN to the Foundry environment.

**Expected result after this step:** A published, tested Power Apps canvas app available to users on web and mobile, fully replacing the original Workshop application.

---

## Recap and next steps

You have now completed the full migration of a Workshop app to Power Apps. Here is what each step accomplished:

| Step | Workshop capability replaced | Azure service used |
|---|---|---|
| 1. Analyze | Workshop app inventory | Documentation |
| 2. Data sources | Ontology object binding | Azure SQL (DAB) or Dataverse |
| 3. Main screen | Resource list, filters, tabs | Power Apps Gallery, Dropdown, Tab List |
| 4. Detail screens | Object detail view, linked objects, charts | Power Apps Form, Gallery, Power BI tile |
| 5. Actions | Action buttons, writeback, notifications | Power Automate flows |
| 6. Maps | Map widget | Power Apps Map control or Power BI map |
| 7. Dashboards | Embedded Contour/Quiver boards | Embedded Power BI reports |
| 8. Publish | Workshop deployment | Power Apps publish, Teams, mobile |

### Suggested next steps

- **Add role-based views:** Use `User().Email` in Power Apps to show or hide screens and controls based on the signed-in user's role.
- **Add offline support:** If using Dataverse, configure offline profiles for field users.
- **Automate data refresh:** Set up scheduled Power Automate flows or ADF pipelines to keep data current.
- **Monitor usage:** Use Power Apps analytics and Power BI usage metrics to track adoption.
- **Migrate additional Workshop apps:** Repeat this tutorial for each Workshop app in your Foundry environment.

---

## Further reading

- [Analytics Migration](analytics-migration.md) -- migrating Contour, Quiver, and other analytics surfaces
- [Ontology Migration](ontology-migration.md) -- migrating the Foundry Ontology to Azure
- [Best Practices](best-practices.md) -- pre-migration assessment and common pitfalls
- [Data Integration Migration](data-integration-migration.md) -- migrating Foundry data connectors to Azure Data Factory

---

**Last updated:** 2026-04-30
**Maintainers:** CSA-in-a-Box core team
