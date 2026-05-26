# Loom Power BI Report Editor — Fabric-parity spec

> Captured 2026-05-26 by catalog agent `a6112853cd6c023e5`.

## UI components

### Embedded Report Canvas
- Live Power BI report rendering within Fabric workspace
- Page navigation tabs at canvas bottom
- Real-time visualization updates
- Interactive visual selection + modification

### Visualizations Pane (right side)
- **Visual type gallery**: bar / line / pie / card / table / slicer / map / scatter / waterfall / gauge / KPI / decomposition tree / smart narrative / Q&A (20+ types)
- **Build visual** tab — fields in active visual (drag-drop buckets: Axis, Legend, Values, Tooltips, etc.)
- **Format visual** tab — styling options (paint-brush icon)
- **Analytics** tab — trend lines / reference lines / forecast (magnifying glass icon)

### Data (Fields) Pane (rightmost or stacked)
- Semantic model table listing (full)
- Expandable tables → columns + measures
- Green checkmarks for fields used in active visual
- Drag-drop field assignment to visual buckets
- Hierarchies with drill-down arrows
- Field-type icons (measure / column / hierarchy)

### Filters Pane
- **Three-tier hierarchy**:
  - Filters on all pages (report-level)
  - Filters on this page (page-level)
  - Filters on this visual (visual-level)
- Shaded filter cards indicating active filters
- Filter type config (Basic vs Advanced)
- Value selection checkboxes
- Numerical range sliders (continuous data)

### Pages Navigation
- Page tabs at bottom of canvas
- New page via Insert tab or + button
- Delete via x icon
- Drag-drop reordering
- Multi-page report support
- Drillthrough page configuration

### Ribbon Tabs
- **Home**: New Report · Save · Undo · Redo · Share
- **Insert**: New Page · Text box · Shape · Image · Q&A · R/Python script
- **Modeling**: Relationships · Manage relationships · New Column · New Measure · Data Category
- **View**: Reading View · Edit View · Focus Mode · Bookmark panes · Selection pane · Navigator pane
- **Help**: Documentation · Support · Feedback

### Format Pane (paint-brush)
- Visual formatting: colors, fonts, axes
- Legend configuration
- Data label formatting
- Background + border styling
- Conditional formatting rules
- Title + subtitle config
- Tooltip customization

## What Loom has
- Plain Cosmos persistence of "report definition" (state.pages, state.visuals)
- C-grade verdict — listing works, embed not present

## Gaps for parity
1. **No embedded Power BI report** — Fabric shows the actual rendered report; Loom shows nothing live
2. **No Visualizations pane** with 20+ visual types
3. **No Fields pane** showing semantic model
4. **No Filters pane** with 3-tier hierarchy
5. **No Pages tabs** for multi-page reports
6. **No Format pane**
7. **No Q&A natural language query** (Insert > Q&A)
8. **No Bookmark / Selection / Navigator panes** under View

## Backend mapping
- **Power BI embed token** flow: `/api/embedToken` for current user → embed via `powerbi-client` JS SDK
- Report definition JSON read/write via PBI REST `/reports/{id}` (Fabric stores reports as JSON via .pbip format)
- Live data queries flow through the embedded report itself (no Loom proxy)

## Required Azure resources / tenant settings
- Power BI Premium / Fabric capacity for embed
- "Service principals can use Power BI APIs" tenant setting ON
- "Embed content in apps" tenant setting ON
- Workspace assigned to the capacity

## Estimated effort
3-4 sessions. Phase 1: embed the actual PBI report via embed token (1-2 sessions). Phase 2: surface the right-side panes (Visualizations / Fields / Filters / Format) by re-rendering them around the embedded report iframe (the embedded PBI client exposes events for visual selection, etc).

## Notes
- Loom won't recreate the full PBI editor from scratch — that's prohibitive
- Loom EMBEDS the PBI editor inside Loom's chrome; users get the full PBI experience without leaving Loom
- This is the same pattern Fabric uses (Fabric IS a chrome around the PBI engine)
