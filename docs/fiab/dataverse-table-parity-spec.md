# Dataverse Table Editor — maker-portal parity spec

> Captured 2026-05-26 by catalog agent from Microsoft Learn (Power Apps maker portal · Dataverse Web API EntityDefinitions reference) and inspection of `apps/fiab-console/lib/editors/powerplatform-editors.tsx::DataverseTableEditor` + `apps/fiab-console/lib/azure/powerplatform-client.ts`. Loom has working Dataverse Web API read of tables and attributes (UAT-verified); this spec compares Loom's current surface against the full Power Apps maker-portal **Table hub** UX.

## Overview

A Dataverse **table** (formerly "entity") is the unit of data modeling in Power Platform. Each table has a logical name (e.g., `account`), schema name (`Account`), display name (localised), entity set name (`accounts` — used in the Web API), primary ID attribute (`accountid`), primary name attribute (`name`), and a collection of typed columns, keys, relationships, business rules, views, forms, charts, dashboards, and security row-filters. Tables come in three kinds — **System** (out-of-box, e.g. `account`, `contact`, `systemuser`), **Standard** (Microsoft-shipped business tables that can be extended), and **Custom** (created in the maker portal or via solution). Tables are the foundation for canvas apps, model-driven apps, Power Pages lists/forms, Copilot Studio Dataverse knowledge sources, and AI Builder training datasets.

## Power Apps maker portal — Table hub UX

### Tables list
- Filter pivots: **All** · **Custom** · **Default** · **Activity** · **Managed**
- Columns: **Display name** · **Name** (logical) · **Type** · **Managed by** · **Customizable** · **Last modified**
- Command bar: **+ New table** · **Import** (Excel / CSV / Power Query) · **Sync from Excel** · **Connect to virtual data source** · **Export to Excel**
- Per-row: open table hub, copy logical name, delete (custom only)

### Table hub (per-table)
Single landing canvas split into:

#### Properties panel
- Display name (sing / plural) · Description · Name (logical, immutable after create) · Schema name · Primary column (Name) · Type (Standard / Activity / Virtual) · Ownership (User/Team · Organization) · Audit changes · Track changes · Provide custom Help · Enable for mobile · Enable for tablet · Enable for offline · Enable quick-create · Enable duplicate detection · Enable connections · Enable mail merge · Enable Knowledge Articles · Enable SharePoint document management

#### Schema area
- **Columns** — typed column list with filter (Custom · Required · All) and `+ New column`. Data types: Single line of text · Multiple lines · Whole number · Decimal · Currency · Date/Time · Choice (Yes/No, Optionset, MultiSelect) · Lookup · File · Image · Customer · Owner · Status · Status Reason · Autonumber · Calculated · Rollup · Power Fx formula · Big int
- Each column edit reveals: required level (None / Recommended / Required) · searchable · audit · field security · description · format (Email / Phone / URL / TickerSymbol / Text Area) · max length · default value · IME mode · range
- **Relationships** — Many-to-One · One-to-Many · Many-to-Many; per-rel cascade rules: Assign · Reparent · Share · Delete · Unshare · Merge · Rollup View (Cascade All / Active / User-owned / None / Remove Link / Restrict)
- **Keys** — alternate keys (composite columns, used as natural keys in upsert)

#### Data experiences
- **Forms** — Main · Quick Create · Quick View · Card · Mobile Express; form designer with sections / tabs / columns / sub-grids / iframes / web resources / business rules attached to form
- **Views** — System views and personal; view designer with column picker, sort, filter (incl. related-table joins), aggregations
- **Charts** — system charts (bar / column / line / pie / funnel / tag) bound to a view
- **Dashboards** — multi-chart + view tiles

#### Customizations
- **Business rules** — scope: Entity / All forms / specific form; condition + actions (set value · clear value · set required level · show/hide · enable/disable · validation message · recommendation); designer with graphical condition editor or code-view IF-THEN
- **Commands** — modern Command Bar buttons (icon, label, visibility expression, action — Power Fx OR Run Flow OR JavaScript)
- **Business process flows** — multi-stage process bar (Qualify → Develop → Propose → Close); stages with data steps + branching

#### Table columns and data
- Inline data editor: view rows, add row, edit cell, delete row, choose visible columns
- Column-stats panel (count, null %, distinct count) for custom tables
- Search box + simple OData filter

#### Tools (right rail)
- Solutions membership (which solutions contain this table)
- Dependency map · Created on / by · Modified on / by

### Solution authoring tie-in
- Tables belong to solutions (managed vs unmanaged)
- All schema edits land in the currently-active solution layer; managed properties (can-customize) gate downstream edits

## What Loom has today

From `apps/fiab-console/lib/editors/powerplatform-editors.tsx::DataverseTableEditor` and `apps/fiab-console/lib/azure/powerplatform-client.ts`:

- **Environment picker** (shared `useEnvironments`) → drives the per-env Dataverse base URL
- **List tables** — `GET /api/data/v9.2/EntityDefinitions?$select=MetadataId,LogicalName,SchemaName,DisplayName,IsCustomEntity,EntitySetName,PrimaryIdAttribute,PrimaryNameAttribute` filtered client-side to custom + a curated set of system tables (`account`, `contact`, `systemuser`, `team`, `msdyn_aimodel`, `mspp_website`); first 500
- **Tables table** — Logical name (clickable) · Display name · Entity set · Custom? — sortable by row
- **Click a table** → schema view loads attributes
- **List attributes** — `GET .../EntityDefinitions(LogicalName='<name>')/Attributes?$select=MetadataId,LogicalName,SchemaName,AttributeType,RequiredLevel,DisplayName,IsCustomAttribute,IsPrimaryId,IsPrimaryName`
- **Attributes table** — Logical name (with PK + Name badges) · Display name · Data type · Required · Custom? — first 500
- Reload button on both list and detail
- Solution listing client method (`listSolutions`) exists in the client but no UI surface today
- Error MessageBars on 401/403/404 with hint

## Gaps for parity

1. **No `+ New table` create flow** — can't create a custom table (display name, plural, logical-name prefix, primary column, ownership, audit, custom Help, mobile/offline toggles) from Loom
2. **No table-properties editor** — can't toggle audit, change tracking, quick-create, duplicate detection, SharePoint doc mgmt, knowledge articles on an existing table
3. **No column-create / edit / delete** — Loom is read-only on attributes; no `+ New column` typed form (text · number · choice · lookup · etc.), no required-level edit, no default-value, no calculated / rollup / Power Fx authoring
4. **No relationship designer** — 1:N / N:N relationships not listed and can't be created; cascade-behavior matrix not exposed
5. **No keys (alternate-key) editor** — can't define composite natural keys for upsert
6. **No views designer** — Loom doesn't list system views, can't add/edit a view (column picker, sort, filter, aggregations)
7. **No forms designer** — Main / Quick-Create / Quick-View / Card / Mobile Express forms not listed and can't be edited
8. **No charts / dashboards** — not surfaced
9. **No business-rules designer** — Loom can't list, create, or edit business rules (condition + actions, scope, error message)
10. **No commands / modern Command Bar editor** — no button list, no Power Fx / Run Flow / JS action authoring
11. **No business-process-flow editor** — multi-stage process bar not surfaced
12. **No inline data editor** — can't view rows of a table, can't add/edit/delete a row from Loom; Loom only shows the metadata schema
13. **Tables list filter** — Loom uses a hardcoded allow-list of 5 system tables + all custom; no `All / Custom / Default / Activity / Managed` filter pivot, no full-text search by display name
14. **Solutions panel** — `listSolutions` exists in client but has no UI; can't show which solutions contain a table, can't switch active solution
15. **Managed properties** — `IsManaged`, `CanBeCustomized` not shown; edit attempts on managed tables would silently fail
16. **Column data types beyond name+type** — Loom shows `AttributeType` but not the underlying typed metadata (max length for strings, precision for decimals, target table(s) for lookups, optionset values for choices, formula expression for calculated columns)
17. **Dependency view** — no map of "what depends on this table" (apps, flows, reports, business rules)
18. **Import data flows** — no Excel/CSV/Power Query import, no virtual-table connect
19. **Pagination** — hard-capped at 500 rows; no `$skiptoken`-based paging for large schemas (Dynamics envs commonly have 1500+ tables)

## Backend mapping

Live Dataverse Web API is the canonical path (Loom has read working):
- **List tables** — `GET /api/data/v9.2/EntityDefinitions`
- **Get table** — `GET .../EntityDefinitions(LogicalName='<name>')` with `$expand=Attributes($select=...)`
- **Create table** — `POST .../EntityDefinitions` with `Microsoft.Dynamics.CRM.EntityMetadata` payload (DisplayName, SchemaName, DisplayCollectionName, OwnershipType, PrimaryNameAttribute)
- **Update table** — `PUT .../EntityDefinitions(LogicalName='<name>')`
- **Delete table** — `DELETE .../EntityDefinitions(LogicalName='<name>')` (only when custom + unmanaged)
- **Columns CRUD** — `POST/PUT/DELETE .../EntityDefinitions(LogicalName='<name>')/Attributes` with type-specific metadata classes (`StringAttributeMetadata`, `IntegerAttributeMetadata`, `LookupAttributeMetadata`, `PicklistAttributeMetadata`, etc.)
- **Relationships** — `POST .../RelationshipDefinitions` (`OneToManyRelationshipMetadata`, `ManyToManyRelationshipMetadata`)
- **Keys** — `POST .../EntityDefinitions(LogicalName='<name>')/Keys`
- **Views (savedqueries)** — `GET/POST/PATCH /api/data/v9.2/savedqueries`
- **Forms (systemforms)** — `GET/POST/PATCH /api/data/v9.2/systemforms` with `formxml` payload
- **Business rules (workflows kind=2)** — `GET .../workflows?$filter=category eq 2`
- **Commands** — `appactions` / `commanddefinitions` tables (modern command bar)
- **Row data** — `GET/POST/PATCH/DELETE /api/data/v9.2/<entitySetName>(id)` with `Prefer: odata.include-annotations="*"`
- **Solutions** — `GET /api/data/v9.2/solutions` + `AddSolutionComponent` action
- **Publish customizations** — `POST .../PublishAllXml` (required after schema changes for the maker UX to pick them up)

## Required Azure resources / tenant settings

- Dataverse-enabled Power Platform environment (every operation is per-env)
- MSAL Web App SP registered as Application User with `System Customizer` (read) or `System Administrator` (full CRUD) on the target env
- Solution membership: schema edits should be made in an unmanaged solution; surface a solution picker in the editor
- For column types that need extra services: **File / Image** columns require Dataverse storage capacity; **Power Fx formula** columns require formula engine; **Calculated / Rollup** require server-side workflow engine (all on by default for Production envs)

## Estimated effort

5 sessions. Column CRUD with all data types + required-level + default-value is ~1 session (largest UX). Relationships designer (1:N / N:N / cascade matrix) + Keys editor is ~1 session. Views designer + Forms designer (form-XML round-trip) is ~1 session — Forms is the hardest because the canonical representation is form-XML, not JSON. Business rules + Commands + Business-process flows is ~1 session. Inline data editor (rows + filter + add/edit/delete) + Solutions picker + Publish-all-customizations + dependency view is the fifth.
