# Loom Copy Job Editor — Fabric-parity spec

> Captured 2026-05-26 by catalog agent `a30c2872e59523af4`. Source: live `CopyJob_1` in `casino-fabric-poc` + Fabric docs.

## Overview
No-code, wizard-based data movement (no pipeline / activity authoring required). Strength: ease for simple source→destination copies; weakness: limited transforms (column mapping only).

## Wizard panels

### 1. Source Configuration
- **Connector picker**: searchable 100+ connectors by category (Databases / Cloud Storage / SaaS / APIs / File Systems)
- **Connection settings**: server/endpoint URL · auth credentials · DB/container select · table/file picker w/ preview · validation
- **Source preview**: sample rows · row count · column types · data quality indicators
- **Supported sources**: Azure SQL DB/MI · On-prem SQL Server · Oracle/PostgreSQL/MySQL · Snowflake/BigQuery · Amazon RDS/Redshift · Azure Synapse · Fabric Lakehouse · ADLS · S3/GCS · Salesforce/Dynamics 365/Dataverse · 80+ more

### 2. Destination Configuration
- **Type selector**: Lakehouse · Warehouse · KQL DB · SQL DB · ADLS · Azure SQL · Snowflake · Dataverse
- **Settings**: connection, DB/container, schema select, auto-create table, truncate-before-load option
- **Preview**: existing tables list, target schema

### 3. Column Mapping Designer
- **Source columns list (left)** — name, type, sample values
- **Mapping (center)** — drag-drop, type conversion rules, rename, unmapped indicators
- **Destination columns list (right)** — target name, target type, auto-mapping suggestions
- **Options**: auto-map by name · auto-map by position · skip columns · rename during copy · custom transformations

### 4. Copy Mode Selector
- **Full Copy** — overwrite destination every run; for refreshes/initial loads
- **Incremental Copy** — first run = full; subsequent runs = only changed rows. Needs incremental column (ROWVERSION / DateTime / Date / Int / String-as-datetime)
- **CDC** — tracks inserts/updates/deletes. Requires CDC enabled on source. Preserves delete info. SCD Type 2 historical tracking option

### 5. Write Behavior
- **Append** — adds rows, preserves existing (default)
- **Overwrite** — replaces all data
- **Merge** — update by primary key + insert new
- **SCD Type 2** — versioned rows, effective dating, soft deletes (CDC mode only)

### 6. Schedule & Trigger
- Run Once / Schedule (cron-based, daily/weekly/etc, timezone, start+end dates, enable toggle) / Event Triggers (file arrival, DB changes)
- Manual Execution: Run button respects incremental state

### 7. Advanced Settings
- **Auto-partitioning (Preview)** — parallel reads for large tables, balanced boundaries (SQL Server family, Oracle, SAP HANA, Fabric)
- **Audit columns** — extraction timestamp, source file path, workspace ID, Copy Job ID, Run ID, job name, incremental window bounds, custom user values appended to each row
- **Performance** — parallel degree, timeout, retry policy, batch size
- **Network**: on-prem data gateway, VNet gateway, VNet service endpoint, SSL/TLS

### 8. Table Selection
- Source table browser with schema hierarchy, row counts, filter/search, multi-select
- Per-table options: column subset, custom query for filtering, incremental column assignment, write mode override, truncate override

### 9. Summary & Review
- Source/destination + types · table count · copy mode · write behavior · schedule · audit columns · estimated data volume
- Validation indicators (completeness, warnings, missing settings)

### 10. Run History & Monitoring
- Run timestamp / status (Running/Succeeded/Failed/Skipped) / duration / rows read / rows written / error messages
- Per-run detail expansion: per-table stats, source-vs-destination row counts, data size, incremental state, error logs
- Real-time live progress bar, row count updates, duration timer, cancel button

### 11. Job Settings & Editing
- Edit source/destination · table selection · column mappings · write behavior · schedule · reset incremental state (full reload) · rename · description

## Key UI elements
- Mode Toggle (Full / Incremental / CDC) with visual distinction
- Connection management: Add / Manage / Validate
- Status indicators: connection, completeness %, preview loading, schedule validation
- Action buttons: Save · Save+Run · Run · Test Connection · Preview Data · Advanced Options

## What Loom has
- Cosmos persistence (state.copyJob.{source, destination, mode, schedule, mappings})
- `/run` POSTs to ADF copy activity (already wired in v3)

## Gaps for parity
1. **Wizard-style UI** — Loom has flat form, needs the 11-panel guided flow
2. **Connector picker** — needs the 100+ connector browser
3. **Column mapping designer** — needs the drag-drop side-by-side UI
4. **Per-table multi-select** — currently single table only
5. **Auto-partitioning + audit columns** — config not exposed
6. **Run history pane** — needs the per-run drill-down with row counts

## Backend mapping
- Existing ADF Copy activity does most of the work
- Need: ADF Linked Service browser (already exists at `/api/adf/linked-services` — needs UI), schema inference endpoint (need to add), row-count probe (Synapse Serverless `COUNT(*)` against source connector)

## Estimated effort
2-3 sessions: wizard UI scaffold + 11 panels + connector picker reuse from ADF.
