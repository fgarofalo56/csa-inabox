# KQL Queryset — Parity gap (validator verdict 2026-05-26)

**Grade: C (BLOCKER: textarea not Monaco/kusto)**

Validator: v2 4-phase live-browser + source-code review.

Loom URL:
`https://loom-console-fvbbctd4eehqbkcs.b02.azurefd.net/items/kql-queryset/573f749a-d5c5-48e3-86ea-da3b206e32b6`

Loom screenshot: `temp/parity/kql-queryset-loom.png`.

## Phase 1 — Fabric reference (from spec)

Multi-tab query workspace embedded under a parent DB. Top tabs: Eventhouse /
Database / Queryset (active). Internal query tabs with rename + close + add (+).
Toolbar per tab: Run, Preview, Recall (query history), Share query, Save to
Dashboard, KQL Tools, Export to CSV, Power BI report, Add alert. Editor:
**line-numbered Monaco with kusto language service, IntelliSense, syntax
highlighting**, pre-populated template with documentation links. Results pane
with sortable columns, filters, type indicators, viz toggle, timestamp.
Left sidebar shows parent DB context (System overview / Databases /
Monitoring / Search box / KQL databases tree).

## Phase 2 — Loom under test (live)

Left rail: "Queries" tree with `+ New` button. Each saved query is a leaf with
a delete (×) trailing button. Main area: ribbon (Home with Run / Save groups,
static labels) + toolbar (title input, db badge, "unsaved" badge if dirty,
Save button, **Run** primary button). Below: a **`<textarea className={s.monaco}>`**
seeded from `SAMPLE_QS` (`'print smoke = "ok", server_time = now()'`). Below
the textarea: `KqlResultsPanel` rendering rows as a Fluent `<Table>` with
execution time / row count badges.

Source confirmation: `apps/fiab-console/lib/editors/phase3-editors.tsx` lines
409-553.

Critical line 540: `<textarea className={s.monaco} …>` — same vaporware-marker
pattern as kql-database. **Same BLOCKER per workflow contract.**

Saved queries persist via `PUT /api/items/kql-queryset/{id}` with `{queries:[…]}`.

Package check: zero `@monaco-editor/react`, zero `@kusto/monaco-kusto`.

## Phase 3 — Side-by-side gap matrix

| Fabric element | Loom | Severity |
|---|---|---|
| **Monaco editor with `kusto` language service + IntelliSense + error squiggles** | **Missing** — vanilla `<textarea>` with `monaco` CSS class | **BLOCKER** (workflow contract Phase 4 check #1) |
| Syntax highlighting (comments / keywords / operators) | Missing | BLOCKER |
| Line numbers | Missing | MAJOR |
| Autocomplete (Ctrl+Space, KQL keywords + table/column suggestions) | Missing | BLOCKER |
| Pre-populated template with KQL docs links | Missing — single-line print smoke | MINOR |
| Multi-tab per-query editor (rename + add (+) + close) | Partial — left rail tree of saved queries with rename via top input. No tab strip in main body | MAJOR |
| Eventhouse / Database / Queryset top tab nav | Missing — Loom uses item-type routing instead | MAJOR |
| Toolbar: Run | **Present** | (positive) |
| Toolbar: Preview (sample results) | Missing | MAJOR |
| Toolbar: Recall (query history) | Missing | MAJOR |
| Toolbar: Share query | Missing | MAJOR |
| Toolbar: Save to Dashboard | Missing | MAJOR |
| Toolbar: KQL Tools | Missing | MAJOR |
| Toolbar: Export to CSV | Missing | MAJOR |
| Toolbar: Power BI report | Missing | MAJOR |
| Toolbar: Add alert | Missing | MAJOR |
| Results pane with chart-view toggle | Missing — table only | **BLOCKER** (workflow contract check #5) |
| Real-time validation (red squiggle) | Missing | BLOCKER |
| Save (persists query) | **Present** — `PUT /api/items/kql-queryset/{id}` works | (positive) |
| Add new tab (+) | Present (Left rail "+ New") | (positive, but Fabric semantics differ) |
| Rename tab | Present (title input) | (positive) |
| Delete tab | Present (× button on each leaf) | (positive) |
| Status bar (db connected, language=kusto, row N) | Missing | MINOR |
| Honest MessageBar for missing dashboard / alert / Power BI infra | Missing | MAJOR |
| Copilot integration | Missing | MAJOR |

## Phase 4 — Functional click-every-button verification

| Loom control | Result |
|---|---|
| `GET /api/items/kql-queryset/{id}` | 200 — `{ok:true, database:"loomdb-default", queries:[]}` |
| `PUT /api/items/kql-queryset/{id}` body=`{queries:[…]}` | 200 — persists |
| `POST /api/items/kql-queryset/{id}/run` body=`print smoke="ok"` | **200** — real ADX execution: `{columns:["smoke"], rows:[["ok"]], rowCount:1, executionMs:15}`. **PRIMARY ACTION WORKS** |
| **Run** button | Fires query → results panel renders. Works |
| **Save** button | `PUT` returns 200, dirty cleared. Works |
| **+ New** (left rail) | Adds a new query to the local list, marks dirty | Works |
| **Delete** on a query leaf | Removes it from the list, marks dirty | Works |
| Title input | Updates draft title | Works |
| Ribbon: Run / Cancel / Save query / Save to dashboard / Set alert | **Mostly no-op** — Run/Save are not ribbon-bound (the editor has its own toolbar Run/Save buttons). Save to dashboard / Set alert are silently dead. **BROKEN** for the dead ones |
| Editor textarea | Updates draft.kql state | Works (but it's a textarea, not Monaco) |
| Shift+Enter shortcut | Fires run() | Works |

## Verdict

**C-grade**. Real backend (KQL executes against real ADX `adx-csa-loom-shared`),
primary actions (Run, Save) work, multi-query CRUD works (add/delete/rename),
but:
- **Editor is a textarea, not Monaco** → BLOCKER per workflow contract
- No IntelliSense, no syntax highlighting, no kusto language service → BLOCKER
- No chart-view toggle on results → BLOCKER per workflow contract
- No real-time validation / squiggles → BLOCKER per workflow contract
- 6+ ribbon/toolbar features missing (Preview, Recall, Share, Save to Dashboard,
  KQL Tools, Export CSV, Power BI report, Add alert)
- Ribbon "Save to dashboard" / "Set alert" silently dead → BROKEN per
  `no-vaporware.md`
- No Copilot NL2KQL

Same fundamental issue as kql-database: the run path is real and works, but
the editor surface is scaffold-grade.

## Required for ≥ B grade

1. **Replace `<textarea className={s.monaco}>` with real `@monaco-editor/react`**
   + `@kusto/monaco-kusto` language service.
2. Implement IntelliSense via kusto-monaco's schema-aware completion provider.
   Feed it the parent DB's schema (`.show database schema as json`).
3. Real-time validation with red-squiggle error markers.
4. Chart View toggle on the results panel (recharts).
5. Wire toolbar Export to CSV (download Blob from `result.rows`).
6. Recall = list previously-executed queries (already stored as `SavedQuery` —
   surface as a dropdown).
7. Multi-tab strip in the main body (matching Fabric's inline tabs) instead of
   only the left rail.
8. For Save to Dashboard / Set alert / Power BI report buttons, surface honest
   MessageBar per `no-vaporware.md` if those backends aren't deployed.

Estimated effort to B: 2 focused sessions (Monaco + chart + CSV export).
To A: 4 sessions (full toolbar + multi-tab strip + Copilot).

## Evidence

- Live API calls (validator run):
  - `GET .../kql-queryset/573f749a-…` → 200
  - `POST .../run body={kql:"print smoke=\"ok\""}` → 200 with real ADX result
- Source code: `apps/fiab-console/lib/editors/phase3-editors.tsx` lines 409-553.
- Package check: no `@monaco-editor/react`, no `@kusto/monaco-kusto`.
- Screenshot: `temp/parity/kql-queryset-loom.png`.
