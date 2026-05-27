# Parity Gap — Power BI + Real-Time Intelligence (v2 validator, 2026-05-26)

> Editors: `dashboard` / `paginated-report` / `scorecard` / `kql-dashboard` / `activator`
> Source: `apps/fiab-console/lib/editors/phase3-editors.tsx` (lines 580-1134, 1636-1873)
> Validator state: source-grade audit. Phase 4 live click blocked by MFA expiration.

## 1. `dashboard` (Power BI)

| Element | app.powerbi.com → Dashboard | Loom | Severity |
|---|---|---|---|
| Dashboard list (left tree) | Workspace tree | `Tree` of dashboards per workspace | present |
| Workspace picker | Top combo | `WorkspacePicker` (shared component) | present |
| Tile grid | Live tiles with thumbnails, click-through to report | Card grid (`s.cardGrid`) with title + subTitle + size caption — **no thumbnails, no live data** | **MAJOR** — pure metadata cards, not real tiles |
| Selected tile detail | Side panel with embed URL + dataset | Card with id / reportId / datasetId / embedUrl | present |
| Edit dashboard (add tile, resize) | Top button + drag | absent | **BLOCKER** for parity |
| Subscribe / Share / Comments | Top toolbar | absent | MAJOR |
| Q&A (natural language) | Top searchbox | absent | MAJOR |
| Refresh tile data | Per-tile | absent | MAJOR |
| Pin tile to home | Action menu | absent | MINOR |

**Grade**: **D** — list dashboards + show tile metadata. No live tiles, no edit. Browse-only.

## 2. `paginated-report` & `report` (Power BI)

Both delegate to `ReportLikeEditor` (one component, two callers — lines 1636-1641).

| Element | app.powerbi.com → Report | Loom | Severity |
|---|---|---|---|
| Report list per workspace | Tree | (in ReportLikeEditor shared component — assumed Tree) | present |
| Workspace picker | Top | shared | present |
| Open report (embedded iframe) | Yes — actual report renders | Likely metadata view + `<a>` to webUrl (didn't fully read shared component) | **MAJOR** if no embed |
| Page navigator (paginated) | Side panel for multi-page reports | absent | **MAJOR** for paginated-report |
| Export to PDF / Excel / PowerPoint | Toolbar | absent | MAJOR |
| Subscribe | Toolbar | absent | MAJOR |
| Bookmarks | Pane | absent | MINOR |
| Comments | Pane | absent | MINOR |
| Edit (Power BI Desktop deeplink) | Toolbar | absent | MAJOR |

**Grade**: **D** for both — metadata-only browse. Without an actual embedded viewer (powerbi-client npm) the parity floor is D.

## 3. `scorecard`

| Element | app.powerbi.com → Scorecard | Loom | Severity |
|---|---|---|---|
| Scorecard list per workspace | Tree | `Tree` | present |
| Goals table | Grid | 4-col Table (Goal / Current / Target / [Add value]) | present |
| **Add value to goal** | Modal | ✓ Dialog with value / target / note Inputs + Save (line 1849-1868) wired to POST `/api/items/scorecard/[id]` | **B-present** ✓ |
| Edit goal definition (name / target / owner) | Yes | absent | MAJOR |
| Add goal | Top button | absent | **MAJOR** |
| Sub-goals / hierarchy | Tree per goal | absent | MAJOR |
| Status auto-roll-up | Computed | absent | MAJOR |
| Connect to Power BI measure | Goal-connect dialog | absent | **MAJOR** for parity |
| History chart per goal | Side panel | absent | MAJOR |
| Owner / followers | Field | absent | MINOR |
| Check-ins | Action | partial (Add value covers this) | C-present |

**Grade**: **C** — Add value is real ✓, but no goal authoring, no measure connection, no history. Goal-display only.

## 4. `kql-dashboard`

| Element | app.fabric.microsoft.com → KQL dashboard | Loom | Severity |
|---|---|---|---|
| Tile grid | Yes | Card grid with title / viz badge / inline rows preview / Edit toggle | **B-present** ✓ |
| **Per-tile KQL editor** | Monaco + Kusto schema-aware | `<Textarea>` (Fluent, line 688-694) with Consolas font | **BLOCKER** ❌ |
| Per-tile viz picker (table / line / bar / pie / column / heatmap / etc.) | Big gallery | native `<Select>` 3 options (table/line/bar) | **MAJOR** — only 3 of N viz types |
| Per-tile title | Input | Fluent Input | present |
| **Run all tiles** | Yes | `Re-run all` Button wired (line 652, calls load with run=1) | **B-present** ✓ |
| **Add tile** | Top | `Add tile` Button wired | **B-present** ✓ |
| **Edit JSON (bulk)** | Yes | `Edit JSON` Button → Dialog with `<Textarea>` (line 707-712) | **B-present** ✓ |
| Save | Toolbar | wired with dirty badge | present |
| Parameter pane (cross-tile filters) | Top bar | absent | **MAJOR** |
| Refresh interval per tile | Settings | absent | MAJOR |
| Drill-down between tiles | Linked | absent | MAJOR |
| Share / Embed | Toolbar | absent | MAJOR |
| Auto-refresh page | Top toggle | absent | MAJOR |
| Per-tile delete | ✓ Trash icon | ✓ `Delete20Regular` per-card | present |
| Result rendering (line/bar charts) | Real charts | First 5 rows as text with " | " separator + "+N more rows" caption — **no actual chart** | **MAJOR** — viz dropdown set to "line" doesn't render a line chart |

**Grade**: **C** — Add tile / Re-run all / Edit JSON / Save / Delete tile all wired. The `<Textarea>` for KQL blocks A; the absence of real charting blocks B (a tile with viz='line' shows the same text-only preview).

## 5. `activator`

| Element | app.fabric.microsoft.com → Activator (Reflex) | Loom | Severity |
|---|---|---|---|
| Reflex list per workspace | Tree | `Tree` | present |
| **Create new reflex** | Modal | ✓ Dialog with displayName + description (line 1046-1064) → POST `/api/items/activator` | **B-present** ✓ |
| Rules list | Grid | 7-col Table (Name / Object · Property / Condition / Action / State / Last triggered / Trigger button) | present |
| **Add rule** | Form-based wizard with object/property picker, condition builder, action picker | Dialog with name + condition JSON `<Textarea>` + action JSON `<Textarea>` | **MAJOR** — JSON editing vs visual rule builder |
| **Trigger rule now** | Yes | `Play20Regular` Button per rule, calls POST with `&trigger=<ruleId>` | **B-present** ✓ |
| Object/property picker | Yes (live binding to KQL / Eventstream stream) | absent | **BLOCKER** for visual parity |
| Action picker (Teams / Power Automate / Email / Custom) | Combo | JSON `<Textarea>` | **MAJOR** |
| Activation history / charts | Side panel | absent | MAJOR |
| Disable / Enable rule | Toggle | absent | MAJOR |
| Per-rule edit | Pencil button | absent | MAJOR |
| Per-rule delete | Bin | absent | MAJOR |

**Grade**: **C** — Create reflex + Add rule (JSON) + Trigger rule are all wired against real Fabric Activator REST. JSON condition/action editor blocks B. No visual rule builder.

## Phase 4 (click-every-button)

| Editor | Wired action buttons | Dead ribbon labels |
|---|---|---|
| dashboard | 1 (Refresh) | ~4 (report-ribbon shared) |
| paginated-report/report | inherits ReportLikeEditor | ~4 |
| scorecard | 2 (Refresh, Add value→Save) | ~4 |
| kql-dashboard | 6 (Add tile, Edit JSON, Re-run all, Save, per-card Delete, per-card Edit toggle) | ~3 |
| activator | 4 (Refresh, New reflex→Create, Add rule→Add, per-rule Trigger) | ~4 (ACT_RIBBON) |

## Summary

| Editor | Grade | Reason |
|---|---|---|
| dashboard | **D** | List + tile metadata only, no live tiles, no edit |
| paginated-report | **D** | Metadata browse only, no embedded viewer, no page navigator |
| report | **D** | Same as paginated-report |
| scorecard | **C** | Add value to goal wired ✓, no goal authoring or measure connect |
| kql-dashboard | **C** | Add tile / Re-run / Edit JSON / Save wired; `<Textarea>` for KQL, no real charts |
| activator | **C** | Create + Add rule + Trigger wired; JSON condition/action (no visual builder) |
