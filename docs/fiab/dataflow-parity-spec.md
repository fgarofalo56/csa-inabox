# Loom Dataflow Gen2 Editor — Fabric-parity spec

!!! info "Comparative positioning note"
    This document is written from the
    perspective of Microsoft Azure, Cloud Scale Analytics, and CSA Loom. Any
    description of third-party or competing products, services, pricing, or
    capabilities is derived from **publicly available documentation and sources**
    believed accurate at the time of writing, and is provided for **general
    comparison only**. We do not claim expertise in, or authority over, any
    non-Microsoft product or service; the respective vendor's official
    documentation is the authoritative source for their offerings, which may
    change over time. Nothing here is intended to disparage any vendor — where a
    competing product has genuine advantages, we aim to note them honestly.
    Verify all third-party details against the vendor's current official
    documentation before making decisions.


> Captured 2026-05-26 by catalog agent `a30c2872e59523af4`. Source: live `Dataflow 1` + `Dataflow 2` in `casino-fabric-poc` workspace + Fabric docs.

## Overview
Cloud-based data transformation using Power Query M editor. No-code data prep without writing code.

## UI components

### Ribbon (5 tabs)
**Home**: Get Data (100+ connectors) · Recent Data · New Source · New Query · Combine (Merge/Append) · Delete · Parameters · Refresh · Options · Help

**Add Column**: Column From Examples · Custom Column · Invoke Function · **Add AI Prompt Column** · Standard math · Text ops · Date & Time · From Number · Conditional Column · Format

**Transform**: Group By · Pivot · Unpivot · Remove Duplicates · Replace Values · **Run Python Script** · Keep/Remove Rows · Sort · Filter · Extract · Split Column · Text→Columns · Format · Data Type · Use First Row as Headers

**View**: Diagram View · Data Preview · Schema View · Layout Options · Data Profiling Tools · Advanced Editor (M code)

**Help**: Docs · Keyboard Shortcuts · Support · Community · Submit Idea · Feedback

### Layout panes
- **Queries pane (left)**: list, search/filter, right-click → Rename / Reference / Delete / Enable-Disable Load / Properties / Advanced Editor
- **Data Preview pane (center)**: tabular preview, column headers w/ filter+sort, row count, scrollable grid
- **Applied Steps pane (right)**: chronological transformation steps, right-click → Delete / Edit / Rename / Properties / Move
- **Schema view**: column name + data type, remove/rename/change-type/duplicate/sort
- **Diagram view**: visual query structure with step icons + dependency lines
- **Status bar**: execution time · column count · row count · processing status · view-toggle buttons

### Data destinations supported
Azure SQL DB · Azure Data Explorer · ADLS Gen2 · Fabric Lakehouse (Tables+Files) · Fabric Data Warehouse · Fabric SQL DB · Azure Synapse · Snowflake · SharePoint

### Key capabilities
- 300+ built-in transformations
- Power Query M code editor (Advanced Editor)
- Column profiling + data quality metrics
- AutoSave + background publishing
- Refresh History tracking
- Monitoring Hub integration
- Copilot NL assistance + AI Prompt Column generation
- Parameter support
- CI/CD + Git integration
- Variable library parameterization
- Scheduled refreshes

## What Loom has today
- Cosmos persistence of dataflow definition (v3.25)
- 503 "Refresh runtime not yet wired" for the Refresh action

## Gaps for parity
1. **Power Query editor** — Loom has plain JSON textarea; needs full M editor with ribbon + applied steps + data preview panes
2. **100+ connector picker** — currently none
3. **Diagram view** — visual query structure
4. **Run runtime wiring** — should dispatch to ADF Mapping Data Flow when invoked
5. **AI Prompt Column / Copilot NL** — not present
6. **Refresh History pane** — not present

## Backend mapping
- Loom equivalent of Power Query is to author M code → translate to ADF Mapping Data Flow JSON → submit via existing ADF client
- Connector library = ADF Linked Services library (already partially exposed via `/api/adf/linked-services`)

## Estimated effort
4-5 sessions — Power Query editor parity is substantial UI work (ribbon, panes, M code with Monaco language plugin). MVP path: provide ribbon + connector picker + applied-steps pane, defer drag-drop visual designer.
