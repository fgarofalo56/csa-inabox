# Loom Semantic Model — Fabric parity gap

> **Validator: v2 4-phase (live browser) — 2026-05-26**
> Loom URL: `https://loom-console-fvbbctd4eehqbkcs.b02.azurefd.net/items/semantic-model/new`
> Fabric reference: `https://app.fabric.microsoft.com` (casino-fabric-poc workspace) — login-gated; spec-derived from `docs/fiab/semantic-model-parity-spec.md` and Microsoft Learn Power BI desktop docs.
> Screenshots: `temp/parity/semantic-model-loom.png` (full page) · `temp/parity/fabric-login-gate.png` (Fabric requires interactive MFA)
> Source under review: `apps/fiab-console/lib/editors/phase3-editors.tsx` lines 1325-1538

## Phase 1 + 2 captures

**Live Loom DOM (heading + ribbon, captured 2026-05-26):**
- Heading: `New semantic model`
- Subtitle: `Tables, relationships, measures, and roles backing Power BI reports.`
- Ribbon tab: `Home` only (vs Fabric: Home + Modeling + View + Help)
- Ribbon buttons: `New measure`, `New role`, `New perspective`, `Refresh`, `Direct Lake`, `Import`, plus toolbar `Refresh` + `Refresh dataset`
- Monaco editor present: **NO**
- Textareas in `<main>`: **0**
- `<iframe>` count: **0**
- Fluent `MessageBar` count: **0**

## Phase 3 — Side-by-side gap matrix

| Fabric element | Loom present? | Severity | Notes |
|---|---|---|---|
| **Ribbon — Home** (New measure / New parameter / Save / Refresh) | partial — has "New measure" label only, no Save, no New parameter | MAJOR | Buttons are labels; click does nothing |
| **Ribbon — Modeling** (Manage Relationships · New Column · View As · Data Category) | MISSING | BLOCKER | No Modeling tab at all |
| **Ribbon — View** (Model View · Data View · Expression Editor toggle · Zoom · Layout) | MISSING | BLOCKER | No View tab |
| **Ribbon — Help** | MISSING | MINOR | No Help tab |
| **Model View canvas** (visual table+relationship designer with drag-drop, cardinality glyphs, bi-directional arrows) | MISSING | BLOCKER | No canvas exists; Loom shows a flat HTML `<Table>` of column/measure names |
| **Relationship designer** (drag-drop FK, cardinality picker, filter direction toggle, active/inactive, ambiguity detector, USERELATIONSHIP) | MISSING | BLOCKER | Loom "Relationships" tab renders only the text "Power BI REST returns relationships only via the XMLA endpoint (TMSL). Click Refresh dataset to validate metadata; full TMSL graph rendering lands in v2.2." — no UI |
| **DAX Editor** (syntax highlighting, intellisense for `[Measure]/Column/Table`, formula validation, format-string picker, commit/cancel) | MISSING | BLOCKER | Loom "Measures (DAX)" tab is a read-only `<pre>` block of `m.expression` — NO editor, NO Monaco, NO highlighting, NO completion. Cannot CREATE a measure. |
| **Data preview / Table View** (sortable columns, type indicators, row count, filters, scroll) | MISSING | BLOCKER | Loom Tables tab is a flat `Table` with column-list strings; no data rows from the model |
| **Row-Level Security (RLS) editor** (role + DAX filter + Test as Role) | MISSING | BLOCKER | Ribbon has a "New role" label that does nothing on click |
| **Properties / Formatting panes** (display name vs internal, Hidden toggle, Synonyms, Data Category, Format string, Sort by) | MISSING | BLOCKER | No right-rail property pane at all |
| **"View As" RLS simulation** | MISSING | BLOCKER | Not present |
| **Direct Lake / Import / DirectQuery mode picker** | label-only | MAJOR | Buttons "Direct Lake" and "Import" exist as labels, no handler |
| **Save** | MISSING | MAJOR | No Save button anywhere in the ribbon |
| **Cosmos persistence of model definition (state.tables/measures/relationships)** | per parity-spec line 60-63 the spec claims this exists, but the editor does not expose a write surface | MAJOR | Editor reads via `/api/items/semantic-model/{id}` but has no create/edit/persist flow — only Refresh dataset |
| **Refresh dataset (POST `/datasets/{id}/refreshes`)** | PRESENT but gated | MINOR | Button is disabled until a dataset is selected from the (empty by default) list; once workspace+dataset chosen, the POST is wired |
| **Refresh history list** | PRESENT | — | Table renders rows from `/api/items/semantic-model/{id}/refreshes` |

## Phase 4 — Functional click-every-button verification

Performed via Playwright on the live Loom URL while the route was stable at `/items/semantic-model/new`:

| Button (ribbon) | Action | Observed result | Status |
|---|---|---|---|
| `New measure` | Click → expect DAX editor dialog | NO modal, NO Monaco, NO textarea appeared in DOM; `dialogs=0`, `monaco=false`, `textareas=0` | **BROKEN — primary action no-op** |
| `New role` | Click → expect RLS role dialog | Same: nothing happened | **BROKEN** |
| `New perspective` | Click → expect perspective dialog | Same: nothing happened | **BROKEN** |
| `Direct Lake` | Click → expect storage-mode picker | Same: nothing happened | **BROKEN** |
| `Import` | Click → expect import picker | Same: nothing happened | **BROKEN** |
| `Refresh` (ribbon) | Click → ribbon group `Refresh` | Same: nothing happened | **BROKEN** |
| `Refresh dataset` (toolbar) | Click → POST `/api/items/semantic-model/{id}/refresh` | Disabled until dataset selected; once enabled, wired to real Power BI REST (verified via source) | OK (gated) |
| `Refresh` (toolbar) | Click → reload dataset list | Wired (`loadList`) — works once workspaceId chosen | OK (gated) |

**Root cause** (source-level): `SM_RIBBON` (phase3-editors.tsx:1327) is a `RibbonTab[]` where every `RibbonAction` carries only `{ label }` with no `onClick`. The `Ribbon` component (lib/components/ribbon.tsx:96-103) spreads `...rest` to `<Button>`, which means the spread is empty — these buttons literally have no click handler attached.

## Final grade

**Grade: D (multiple BLOCKERS)**

Per `parity-validation-standard`:
- Phase 3 has 9 BLOCKER rows (no Model View canvas, no Modeling ribbon tab, no View tab, no relationship designer, no DAX editor, no data preview, no RLS editor, no Properties pane, no View As).
- Phase 4 has 6 BROKEN primary controls (`New measure` is the most damning — it is the headline action of a semantic-model editor and it does nothing).
- Only Refresh dataset / Refresh list buttons function, and only when a real Power BI workspace + dataset is already provisioned.

The editor is best described as a **read-only metadata viewer** that lists tables, columns, and measure names harvested from `/api/items/semantic-model/{id}`. It is **not** a semantic-model editor.

## Recommended remediation (per build contract in `fabric-parity-loop.md` §"Build phase contract")

1. **Replace the DAX `<pre>` viewer with Monaco** (`@monaco-editor/react`) configured `language="dax"` (use `monaco-dax` or register a custom DAX tokenizer + completion provider seeded with `CALCULATE / SUM / SUMX / DIVIDE / FILTER / RELATED` and the model's column/measure names from `detail.tables`). Add error squiggles via `setModelMarkers`. Theme: `vs-dark`.
2. **Wire `New measure` to open a Dialog** with the Monaco DAX editor + measure-name input + format-string picker + Save → POST `/api/items/semantic-model/{id}/measures` (route does not yet exist; add it + the BFF call to PBI XMLA / TMSL).
3. **Build a Modeling ribbon tab** with real handlers for Manage relationships, New column, View As, Data Category — each opening the appropriate dialog.
4. **Build a Model View canvas** — start with a flat SVG / Mermaid representation of `detail.tables` + `relationships`. Render a card per table with column rows. Render edges with cardinality labels. Drag-drop is Phase 2.
5. **Build an RLS pane** — wire `New role` to open a role-creation dialog with a Monaco DAX filter editor + role-name + "Test as Role" toggle. Persist via TMSL.
6. **Add an honest MessageBar** for features blocked on tenant config (XMLA endpoint enable, Direct Lake capacity assignment) per `no-vaporware.md` rather than leaving label-only buttons.
7. **Bicep sync**: TMSL execution requires the XMLA endpoint on a Premium / Fabric capacity. Document the capacity SKU + tenant setting "XMLA endpoint = Read/Write" in `docs/fiab/v3-tenant-bootstrap.md` and add the workspace-to-capacity assignment to `platform/fiab/bicep/`.

**Estimated effort to reach grade B**: 3-4 focused sessions (Monaco DAX + measure dialog + RLS pane + flat Model View). Grade A requires the visual canvas + drag-drop relationship designer — add 2 more sessions.
