# Loom Semantic Model Editor — Fabric-parity spec

> Captured 2026-05-26 by catalog agent `a6112853cd6c023e5`. Fabric semantic model = Direct Lake / Import / DirectQuery analytic model with DAX.

## UI components

### Ribbon (4 tabs)
- **Home**: New Measure · New Parameter · Save · Refresh
- **Modeling**: Manage Relationships · New Column · View As (RLS testing) · Data Category
- **View**: Model View · Data View · Expression Editor toggle · Zoom controls · Layout creation
- **Help**: Docs · Support · Keyboard Shortcuts

### Model View (visual data modeling canvas)
- Tables as interactive cards (expandable column listings)
- Relationship connectors with cardinality (1:1 · 1:* · *:1 · *:*)
- Bi-directional notation (double arrowheads)
- Filter direction visualization (single / double arrows)
- Drag-drop relationship creation between tables
- Right-click context menus (table/relationship management)

### DAX Editor
- Syntax highlighting for Data Analysis Expressions
- Real-time function auto-complete + parameter hints
- Context-aware column/table reference suggestions
- Formula validation + error highlighting
- Commit/cancel UI for measure creation
- Format string spec (number, currency, percentage)

### Table View (data preview)
- Column data preview with sortable headers
- Data type indicators
- Row count
- Basic per-column filtering
- Horizontal/vertical scrolling

### Relationship Designer
- Cardinality config (1:1 / 1:* / *:1 / *:*)
- Filter direction toggle (single / bi-directional)
- Active/Inactive relationship status
- Cross-filter direction management
- Ambiguity detection alerts
- USERELATIONSHIP() support for inactive activation

### Row-Level Security (RLS) Editor
- Role creation + DAX filter definition
- USERNAME() / USERPRINCIPALNAME() dynamic security functions
- Default editor (simple) + DAX editor (complex)
- Role assignment to users/security groups
- "Test as Role" validation feature
- Viewer-only scope enforcement (Admins/Members/Contributors bypass)

### Properties & Formatting Panes
- Display name vs internal name
- Hidden/Visible toggles for reporting
- Synonyms (natural language Q&A)
- Data category classification (Location, Image, Web URL)
- Format string spec
- Sort order

## What Loom has
- Cosmos persistence of model definition (state.tables, state.measures, state.relationships)
- C-grade verdict — listing works, no execution wired

## Gaps for parity
1. **Model canvas** — no visual table+relationship designer
2. **DAX editor with intellisense** — only plain textarea
3. **Live data preview** — no Direct Lake / Import / DirectQuery against source
4. **Relationship designer** — no drag-drop FK creation
5. **RLS editor** — not present
6. **No Power BI tenant integration** — semantic models in Fabric live in Power BI capacity; Loom needs to publish via PBI REST API

## Backend mapping
- Loom needs **Power BI REST API** integration with the tenant's PBI capacity (already partially exposed via `/api/powerbi/workspaces` in phase3-editors)
- DAX execution: PBI XMLA endpoint OR Tabular Model Scripting Language (TMSL)
- Direct Lake mode: PBI semantic model pointing at a Loom Lakehouse's Delta files
- Refresh: PBI `/groups/{ws}/datasets/{id}/refreshes` POST

## Required Azure resources
- Power BI Premium capacity OR Fabric capacity (for Direct Lake mode)
- Tenant setting: "Service principals can use Fabric APIs" enabled

## Estimated effort
4-5 sessions. Direct Lake + DAX editor is the heaviest piece. MVP path: list+create model via PBI REST, defer canvas designer.
