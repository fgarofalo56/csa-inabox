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

## Loom coverage — shipped (Azure-native default; no Power BI / Fabric required)

> **Status update (2026-07-08).** The C-grade "listing only" verdict above is
> superseded. The semantic-model editor is a **full authoring surface that runs
> Azure-native by default** — the model canvas, DAX editor, relationship designer,
> and RLS/OLS editor render and function with **neither a Fabric/Power BI
> workspace nor an Analysis Services server bound**. The default backend is the
> **Loom-native tabular layer**: relationships, hierarchies, measures, calculation
> groups, and field parameters are persisted with the item (Cosmos, via
> `apps/fiab-console/app/api/items/_lib/semantic-model-store.ts`) and emitted as
> TMSL at provision time. Per the die-hard `no-fabric-dependency` rule
> (`.claude/rules/no-fabric-dependency.md`), Power BI / Fabric is **strictly
> opt-in** and never on the default path.

Verified in `apps/fiab-console/lib/editors/phase3/semantic-model-editor.tsx` +
`apps/fiab-console/lib/azure/aas-client.ts`:

| Fabric capability | Loom coverage | Backend on the default path |
|---|---|---|
| Model view (relationship diagram) | ✅ interactive diagram — cardinality, cross-filter direction, active/inactive, drag-drop; writes TMSL | Loom-native (Cosmos) |
| Relationship designer | ✅ dedicated Relationships tab + create/edit | Loom-native (Cosmos) |
| DAX editor with IntelliSense | ✅ Monaco DAX editor + server-side validation + **Test** + **DAX Copilot** (NL2DAX / explain / optimize / auto-describe) | Loom-native validate; AAS XMLA when bound |
| Calculation groups + field parameters | ✅ calc-group / field-parameter (`NAMEOF`) builders → TMSL `createOrReplace` | Loom-native (Cosmos) → TMSL |
| RLS / OLS editor | ✅ Security tab — per-role row-filter DAX + OLS table/column matrix + **Test-as-role** (XMLA `EffectiveUserName`) | Loom-native author; AAS XMLA `createOrReplace` when bound |
| Drill hierarchies | ✅ hierarchy/level editor in Model view | Loom-native (Cosmos) |
| Live data preview / Direct Lake | ✅ Direct Lake query tab with transparent **Synapse Serverless** fallback | AAS DAX query / Synapse Serverless |

## Backend mapping (default → opt-in)

- **Default — Loom-native tabular layer (Azure-native, no Fabric/PBI/AAS).** The
  full model definition is authored and persisted in Cosmos and rendered as a
  read-only `model.bim` TMSL preview so the operator sees exactly what would be
  written. Every editor surface above works with nothing bound.
- **Opt-in — Azure Analysis Services (XMLA over HTTP).** Selected when
  **`LOOM_AAS_XMLA_ENDPOINT`** is set (writes: TMSL `createOrReplace` / `alter`
  via SOAP/XMLA `Execute`) and **`LOOM_AAS_SERVER` + `LOOM_AAS_MODEL`** for the
  async-refresh + data-plane DAX-query path. This is the azure-native, **no-Fabric**
  execution backend. AAS is **not offered in Azure Government** — in GCC-High / DoD
  the client returns an honest gate (`AAS_NOT_IN_GOV`) and directs DAX to Synapse
  Serverless `OPENROWSET(... FORMAT='DELTA')`.
- **Opt-in — Direct-Lake-Shim (Power BI enhanced refresh).** Gated by
  **`LOOM_DIRECT_LAKE_SHIM_ENABLED=true`**; drives partition-scoped Power BI
  Premium enhanced refresh for 5–30 s freshness (honest gap vs Fabric's sub-second,
  which needs an F-SKU). When off, the BFF renders the honest setup MessageBar.
- **Opt-in — Microsoft Fabric / Power BI (REST `updateDefinition`).** Selected
  **only** when **`LOOM_SEMANTIC_MODEL_BACKEND=fabric`** + a bound workspace, per
  the die-hard opt-in rule. **Never** reached on the default path.

## Required Azure resources

- **Default path:** none beyond the base Loom deployment (Cosmos + the Lakehouse
  Delta the model reads). No Power BI / Fabric capacity, no AAS server.
- **Opt-in AAS execution:** an Azure Analysis Services server (Commercial / GCC
  only) deployed by `platform/fiab/bicep/modules/landing-zone/aas.bicep`; the
  Console UAMI must hold the AAS **server administrator** role.
- **Opt-in Power BI / Fabric:** a Power BI Premium / Fabric capacity + the
  "Service principals can use Fabric APIs" tenant setting — required **only** for
  the opt-in Power BI / Fabric backends.

## Verdict

**A-grade Azure-native.** Full authoring parity on the default path; Power BI /
Fabric demoted to explicitly-gated opt-in execution backends.
