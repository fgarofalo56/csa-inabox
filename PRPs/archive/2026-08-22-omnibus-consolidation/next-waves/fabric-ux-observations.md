# Fabric designer UX observations — live capture 2026-07-09
Workspace: casino-fabric-poc (7899f58d), real tenant, dark theme. Browser-verified by the orchestrator.

## Cross-cutting design language (applies to ALL Fabric designers)
1. **Node anatomy**: compact card, COLORED HEADER BAND (activity-type color, e.g. green for Copy) with type label; body = icon + instance name; INLINE ACTION BAR ON THE NODE (delete / view-code </> / clone / open →) visible on select/hover; TYPED PORT HANDLES on right edge as small colored squares (success ✓ green / fail ✗ red / skip / completion) — not generic dots.
2. **Ghost next-step node**: the canvas scaffolds the NEXT action as a large placeholder node ("Transform events or add destination" with icon + dropdown) — the empty canvas teaches the flow left→right. Eventstream even pre-draws source → stream → ghost.
3. **Draft/publish separation**: Eventstream has explicit Edit mode with banner "Changes will go live once you publish them" + Publish button + Undo/Redo in toolbar.
4. **Docked bottom panel** (not side drawer) for the object inspector:
   - Pipeline: tabs General / Source / Destination / Mapping / Settings with RED VALIDATION SUPERSCRIPT DOTS on tabs with missing required config (errors visible pre-run), required-field asterisks, Learn-more links, activity state radio, timeout, retry toggle.
   - Eventstream: tabs Data preview / Authoring errors + Refresh; LIVE data table with TYPE-BADGED column headers (Abc/123/latlong icons), data-type dropdown (Json), "Show data from: Last hour" time-range picker, search, Show details.
5. **Canvas chrome**: right rail = zoom slider + fit-to-screen + auto-layout + collapse; canvas Copilot bubble top-left; smooth curved bezier edges w/ circular connection ports.
6. **Empty states as guided launchers**: Pipeline empty state = 4 paths (blank canvas / Copy data assistant / sample data / Templates) + "Ask Copilot"; Eventstream = 3 cards (Connect sources / Use sample data / Custom endpoint) + Learn more.
7. **Activity/operator pickers**: searchable dropdown with CATEGORY HEADERS (Move and transform / Metadata and validation / Control flow) and per-item icons; Transform menu: Custom code (SQL code [New badge]) + Predefined operations (Filter, Manage fields, Aggregate, Join, Group by, Union, Expand).
8. **Ribbon**: contextual tab groups (Home/Activities/Run/View), quick-insert activity buttons directly in ribbon (Copy data, Dataflow, Notebook, Lookup, Invoke Pipeline), Copilot button rightmost.
9. **New-item gallery**: Favorites tab + All-items categorized cards (with star-to-favorite per card), filter box, category sections (Visualize data etc.), preview badges.
10. **Workspace list**: task-flows band on top (predesigned task flows), item table with Status/Type/Task/Owner/Refreshed/Next refresh/Endorsement/Sensitivity columns, FOLDERS, nested child items (eventhouse → KQL DB indented), filter + view toggles.
11. **Node status inline**: source node shows live state ("Loading data…" with spinner) inside the node; selection = teal outline glow.

## Fabric items seen/created for comparison (leave in workspace)
- Pipeline_2 (canvas + Copy data1 activity + bottom inspector), es_parity_review (eventstream w/ Bicycles sample source, live preview streaming). Also present: Dataflow 2 (Gen2), dbt job, eventhouse1 (+KQL DB child), map_1, Notebook_1, Pipeline_3, adf-loom-default-centralus (mounted ADF), CopyJob_1, folders (lh_bronze/silver/gold, data_pipelines, reports, semantic_models).

## Loom deltas already known (from this session's live work on Loom canvases)
- Loom pipeline canvas: nodes are plainer (no colored header band, no inline node action bar, no typed ports), inspector is side-panel not docked-bottom-with-validation-dot-tabs, no ghost next-step node, no draft/publish banner (saves directly), activity picker exists but flat, Factory Resources tree has no right-click (being fixed), no canvas Copilot bubble.
- Loom eventstream canvas: has topology nodes but no live per-node data preview dock, no authoring-errors tab, no publish/edit separation, no type-badged preview columns.
- Loom has: undo/redo + copy/paste + align/distribute + shortcut sheet (Wave 2) — parity or better on THOSE.

## PART 2 — remaining surfaces (captured 2026-07-09 ~14:30)

### Dataflow Gen2 (Power Query editor)
- Office-ribbon layout: Home / Transform / Add column / View / Help tabs, ~30 icon operations per tab, dedicated command SEARCH bar ("Search (Alt + Q)") centered in title bar.
- Empty state = import cards (Add default destination / Import from Excel / SQL Server / Text-CSV / dataflows / Run MDF transforms) + "Get data from another source →" + "Import from a Power Query template" links.

### Notebook
- Ribbon tabs: Home / Edit / AI tools / Run / View. Toolbar: Run all, Connect (session picker), language dropdown (PySpark), Environment, "Workspace default", Data Wrangler button, VS Code open, Copilot.
- LEFT EXPLORER: Data items / Resources / Connections tabs; "No data sources added" + Add data items CTA (Loom has this concept as "Data items" pane — comparable).
- Status bar: session state (Preparing), AutoSave: On, Copilot completions: Off, "Selected Cell 1 of 1".
- Cells: line numbers, per-cell run arrow + collapse, per-cell toolbar (top-right icons), language chip per cell.
- Org-access warning banner ("Other people in your organization may have access…").

### Eventhouse / KQL Database
- Item-level tab strip: Eventhouse | Database (two related editors in one item chrome).
- Toolbar cross-links EVERY RTI surface: Live view, New, Get data, Query with code, KQL Queryset, Notebook, Real-Time Dashboard, Data Agent, Operations Agent, Data policies, OneLake. "Analyze data with ▾" CTA top-right.
- Left tree: System overview / Databases / Monitoring + KQL databases list → database → queryset child, Tables / Shortcuts / Materialized views / Functions / Data streams.
- Main area: Overview | Entity diagram TOGGLE (visual schema diagram!). Empty DB = big + icon "This database is empty. Get data".
- RIGHT DETAILS PANEL: Database details — Compressed/Original size stats, OneLake availability toggle + info, Overview facts (created by/on, region, Query URI + **MCP Server URI** with Copy buttons, last ingestion, caching policy + retention policy with inline edit pencils), Related elements w/ find-by-name.

### Lakehouse explorer
- Tabs: Home | Materialized lake views. Toolbar: Get data, New SparkSQL query, New semantic model, Add to data agent, Manage OneLake security, Update all variables.
- Left Explorer: lakehouse → Tables → schema (dbo) → tables, Files; "Add lakehouses" button; collapse.
- Tables open as CLOSEABLE TABS in the main area with instant 1000-row preview, "Table view" dropdown, status bar: "Succeeded (3 sec 30 ms)" + "Columns 54 Rows 1,000".
- Teaching toast: "Analyze your data — explore in a notebook, SQL analytics endpoint, or eventhouse endpoint". Info banners with dismiss.

### NOT yet captured (next round): dbt job, Graph model.

## PART 3 — CAP-R2, the 7 remaining surfaces (captured 2026-07-09 ~17:00, casino-fabric-poc, dark theme)

### Task flows (workspace band) — CAPTURED
- **Gallery dialog** ("Apply predesigned task flow"): left list of 10 predesigned flows (General, Basic data analytics, Data analytics using a SQL analytics endpoint, Medallion, Event analytics, Lambda, Sensitive data insights, Basic machine learning models, Event medallion, Translytical), each w/ 1-2-line description; right pane = live MINI-DIAGRAM preview of the flow (color-coded task nodes + edges), task count ("9 Tasks"), long description, **Recommended workloads** (icon list: Data Engineering / Data Factory / Data Science / Data Warehouse / RTI / Power BI) and **Recommended item types** (long icon list per flow). Select/Cancel footer.
- **Applied band** = a real mini-CANVAS docked above the item list: toolbar "Untitled task flow ▾ · Add task ▾ · Add a connector · Apply predesigned task flow"; zoom-in/out + fit right-rail buttons; dotted-grid background.
- **Task nodes color-coded by TASK TYPE**: get data = green, store data = teal, prepare data = blue, visualize = orange, analyze/train = red. Node anatomy: left color band + type icon, task name, category subtitle, "No items" count, inline "+ New item" button + connector (link) affordance on the node. Edges = orthogonal connectors between tasks.
- **Right details panel (flow-level)**: title "Untitled task flow", "Task flow details" + description, Edit pencil, "Tasks" section listing every task as a COLOR-CODED CHIP; header icons: expand-panel, view-switch, delete-flow.
- **Right details panel (task-level, on node select)**: tabs **About / Connections / Properties**; task name + "No items"; actions **+ New item / Attach item / delete**; description w/ Edit; **Task type dropdown** (e.g. "Store data") that filters **Item recommendation** ("Select an item type from the predefined list").
- **Selecting a task node FILTERS the workspace item list** below: breadcrumb becomes "casino-fabric-poc → Filtered results" with a filter-chip row ("Clear all · Task: Bronze data ×") and a designed empty-state (illustrated folder icon + "Unable to find any search results").
- Item table has a **Task column** — items are assigned to tasks from the list or the task panel.

### Copy job — CAPTURED
- Ribbon: **Home / View** tabs; Home = settings gear, **Run**, Choose data source, **Edit mapping**, **Add to pipeline**, **View run history**. Item-title breadcrumb top-left w/ sensitivity "No label ▾" chip.
- Editor opens as a **6-step vertical STEPPER wizard** (left rail, collapsible «): Choose data source → Choose data → Choose data destination → Settings → Map to destination → Review + save. Completed steps get a green ✓ dot; active step shows a helper sub-line ("Select a connector. Then enter the connection information.").
- **Choose data source** step = a full get-data hub: tabs **Home / + New / OneLake catalog / Azure / Sample data**; big search bar; "New sources" CARD GRID (SQL Server, SharePoint folder, Dataverse, SharePoint Online list, Azure SQL, Folder, OData, Oracle, Odbc, MySQL) with "View more →"; **embedded OneLake catalog table** (All / Recommended / Recent pill filters; columns Name/Type/Owner/Refreshed/Location/Endorsement/Sensitivity) listing items ACROSS workspaces.
- **Choose data** step: **Tables / Files** radio CARDS (selected card = teal outline + radio dot), left tree pane w/ "filter by name" box, right **"Preview data"** pane (instant preview on select), collapse chevron between panes. Footer **Back / Next** buttons (primary teal).
- Pattern for Loom: copy-job = wizard-first editor; every step has search/filter; preview always beside selection; the same get-data hub is REUSED across Copy job / Dataflow / Pipeline Copy assistant.

### Map (Azure Maps item) — CAPTURED
- **Two modes via top-right dropdown: Viewing ▾ / Editing ▾** (pencil/no-pencil icons) + green **Share** button. Viewing = full-bleed map, ribbon shows only Refresh.
- **Editing ribbon**: save icon, refresh, settings gear, **New tileset**, **Tileset activity**, **Map settings**.
- **Left Explorer panel** (collapsible «): tabs **Fabric items / External sources [Preview badge]**; guided empty state (illustration + "No data added yet — Add your first item to begin customizing your map view" + teal **Add ▾**).
- **Add ▾ source menu**: **Lakehouse / KQL database / Ontology (preview)** — each w/ item-type icon.
- Map canvas = real Azure Maps: right-rail controls (locate me, zoom +/-, style/terrain picker, bearing), scale bar bottom-left, "Microsoft Azure" attribution + TomTom credits bottom-right.
- Pattern for Loom: map editor = Explorer-panel + full-bleed canvas; view/edit mode split; sources are typed Fabric items; tilesets as first-class assets with activity log.

### Real-Time Dashboard — CAPTURED
- **Create dialog integrates task flows**: Name + Location (workspace dropdown + expand picker) + **"Assign to task"** field pre-filled from the matching task-flow task ("Data visualize ×").
- Ribbon: **Home / Manage** tabs; Home = save ▾, refresh, **Add visual ▾ / Add Markdown / Add alert ▾ / Add data source ▾ / Add parameter**. Top-right **Editing ▾ / Viewing** mode dropdown + Share. URL carries the time-range as params (`v-_startTime=1hours&v-_endTime=now`) — dashboard state is URL-shareable.
- **Guided empty state** = "Add a data source" hub: **Sources by type** cards (KQL Database / Azure Data Explorer / Log Analytics / Application Insights, each icon + 1-line description) + **"Suggested from the Workspace"** row (eventhouse1).
- **Proactive suggestion TOAST** (bottom-left card): "Suggested data source — the Workspace contains a single KQL database, would you like to use it as a data source? **Continue / No thanks**" with source→dashboard icon diagram. One click wires it; success toast "Data source added successfully".
- **Data sources right panel** (collapsible rail): per-source row w/ gear + ⋯ menu and **"Used in: 0 Tiles, 0 Parameters, 0 Base queries"** usage stats + Details ▾.
- After wiring a source the canvas scaffolds a **dashed GHOST TILE "Add visual"** with quick-pick icons (Time Series, Bar chart, Column chart, Pie chart, Table, More ▾).
- **Tile editor** = full-screen takeover: left panel tabs **Source / Visualization** (source picker + schema tree: Tables / Materialized Views / Shortcuts / Functions, w/ search + refresh); center visual preview with an **inline Copilot NL prompt "Describe the visual you want to create" →**; bottom **Query editor** (line-numbered KQL, toolbar Run / Show Results / Parameters ▾ / Base queries / expand; UTC timestamp status bar). Top-right Copilot icon + **Done ▾**.
- Left **Pages** rail (collapsible) for multi-page dashboards; **Manage tab** holds auto-refresh/parameters/base-queries/permissions.

### KQL Queryset — CAPTURED
- **Create dialog** again has Name + Location + **Assign to task** (pre-filled "High-volume data ingest").
- **Guided empty state** "Get started…": subtitle "Run queries and cross-service queries between Fabric and Azure data sources, to produce shareable insights (results and visuals)." + **Add data sources** cards: KQL Database / Azure Data Explorer / Azure Application insights / Azure Log Analytics (each icon + description) + "Need help? Learn more".
- **Source picker = OneLake catalog dialog**: "Select a KQL Database from the catalog", pill filters **All / Endorsed in your org / My data / Favorites**, keyword filter, **All domains ▾** dropdown, item table (Name/Owner/Refreshed/Location/Endorsement/Sensitivity), collapsed Explorer rail, Connect/Cancel.
- **Welcome teaching dialog** on first open: illustration, "Welcome to KQL Queryset!", 3 icon bullets (Craft and Run Queries / Pin Insights to Dashboards / Visualize in Real-Time), Learn more, **carousel 1-of-2 dots + Next / Not now + "Don't show again" checkbox**.
- Editor chrome: **query TABS strip** (per-source tab w/ rename pencil, "+" add tab, tab-count badge right). Toolbar: **Run · Preview · Recall · Share query · Save to Dashboard ▾ · KQL Tools ▾ · Export to CSV · Power BI report · Add alert**. Ribbon Home/Help + Save + Add data source ▾ + **Copilot**.
- Left **Explorer**: search box; per-database node (dropdown + ⋯ menu); tree **Tables / Materialized Views / Shortcuts / Entity Groups / Functions**; separate **"Data sources"** section w/ + add and view-toggle.
- **Editor pre-seeded with commented starter queries** (take 100 / count / summarize by bin(ingestion_time())) using `YOUR_TABLE_HERE` placeholders — red validation markers in gutter until replaced.
- Results pane: "Run a query and explore the results here" empty hint + **UTC timestamp status chip** and collapse control.

### Semantic model view — CAPTURED (sm_casino_gold, live model w/ 10 gold tables)
- Ribbon **File / Home / Help**; Home organized in LABELED GROUPS under the buttons: **Data** (Get data, OneLake catalog) · **Queries** (Transform data, Refresh) · **Calculations** (New measure, New column, New table, Calculation group) · **Parameters** (New parameter) · **Security** (Manage roles, Manage permissions) · **Relationships** (Manage relationships) · **Modeling** (Edit tables) · **Model health** (Best practice analyzer, Memory analyzer, Community notebooks) · **Ontology** (Generate Ontology) · **Explore** (New report, Explore, Lineage, Analyze in Excel) · **Copilot** (Prep data for Copilot AI).
- Green info banner: "You are in Viewing mode and changes will not be saved" + **Viewing ▾ / Editing** dropdown top-right + Share.
- **Model view = ERD canvas**: table cards (header w/ icon + name + ⋯ menu, dashed selection top border), column lists w/ Σ measure icons, per-card scrollbar + collapse chevron; relationship lines with **cardinality markers (1/\*) and direction arrows**; pan/zoom (100% bottom-right).
- **Two stacked right rails**: **Properties** (contextual; Cards section w/ toggles "Show the database in the header", "Show related fields when card is collapsed", "Pin related fields to top of card") and **Data** (tabs **Tables / Model**, search, expandable table list).
- Bottom: **diagram-layout TABS "All tables" + [+]** (multiple saved layouts) and a **"Model view / DAX query view"** mode switcher bottom-left.
- "New report" opens the report editor on this model in a NEW browser tab.

### Report editor — CAPTURED (new report on sm_casino_gold)
- **Menu-bar style** (not ribbon): File ▾ · View ▾ · Reading view · Mobile layout | right cluster: **Copilot · Explore this data · Ask a question · Data/drill ▾ · Text box · Shapes ▾ · Buttons ▾ · Visual interactions ▾ · Refresh · Save · ⋯**.
- **Three docked right panels**: **Filters** (search; "Filters on this page" + "Filters on all pages" each w/ dashed "Add data fields here" drop target), **Visualizations** ("Build visual" mode toggle + ~40-icon visual-type gallery + **Values "Add data fields here"** buckets + Drill-through section w/ Cross-report Off / Keep-all-filters On toggles), **Data** (search + expandable per-table field tree).
- Canvas: **guided empty state** "Build visuals with your data — Select or drag fields from the Data pane onto the report canvas" + drag illustration; dotted page boundary; snap grid.
- Bottom bar: **desktop/mobile preview toggles**, **page tabs ("Page1" + green [+])**, page navigation arrows.
- Whole editor is a drag-drop field-well model: fields drag from Data → visual buckets in Visualizations → filters accept the same drag.

### CAP-R2 STATUS: ALL 7 SURFACES CAPTURED (task flows, Copy job, Map, Real-Time Dashboard, KQL Queryset, Semantic model view, Report editor). dbt job + Graph model remain optional extras.
Items created for capture (left in workspace per convention): NewRTDashboard_1, KustoQueryWorkbench_1, Untitled report (unsaved), applied Medallion task flow.

## STANDING DIRECTIVE (operator, 2026-07-09)
"Every single Fabric UX compared to Loom; update Loom to be AS GOOD OR BETTER. Apply the same level/baseline to ALL Loom UXs, not just 1:1-with-Fabric ones. Fabric = the baseline for visual/functionality/usability; every Loom UX must meet or exceed that grade."
Cross-cutting bar derived from all captures: item-tab strips for multi-editor items; toolbar cross-links between related surfaces; right details panels with copyable URIs + inline-edit policies; tabbed content previews with instant data + timing status bars; teaching toasts/banners; guided empty states everywhere; entity/schema DIAGRAM views; command search; per-surface Copilot entry.
