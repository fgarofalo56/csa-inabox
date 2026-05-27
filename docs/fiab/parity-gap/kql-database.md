# KQL Database — Parity gap (validator verdict 2026-05-26)

**Grade: C (BLOCKER: textarea not Monaco/kusto)**

Validator: v2 4-phase live-browser + source-code review.

Loom URL:
`https://loom-console-fvbbctd4eehqbkcs.b02.azurefd.net/items/kql-database/9f86ed75-8194-43f2-9787-0c843ccaa6b5`

Loom screenshot: `temp/parity/kql-database-loom.png`.

## Phase 1 — Fabric reference (from spec)

Tabbed navigation: Eventhouse / Database / Queryset. Toolbar: Live view, New,
Get data, Query with code, KQL Queryset, Notebook, Real-Time Dashboard, Data
Agent, Data policies, OneLake. Left sidebar: hierarchical schema (Tables /
Shortcuts / Materialized views / Functions / Data streams) with search filter.
Query editor: **line-numbered Monaco with kusto language service, IntelliSense,
real-time validation, syntax highlighting (comments green, keywords blue,
operators red)**. Results grid with sortable columns, filters, type indicators,
visualization toggle, "Run a query…" empty-state, timestamp metadata. Export
to CSV, Share query, Save to dashboard, Power BI report, Add alert, KQL Tools.

## Phase 2 — Loom under test (live)

Left rail: Tree with `info` branch (size MB / hot cache / soft-delete) and
`tables` branch (table names). Clicking a table sets the query body to
`["TableName"]\n| take 100`. Main area: ribbon (Home with New / Data / Manage
groups, all labels static), then a toolbar with Cluster badge + DB badge +
Refresh + **Run (Shift+Enter)** button. Below: a **`<textarea className={s.monaco}>`**
seeded with `// Welcome to KQL. Try a sample:\nprint smoke = "ok"…`. Below
that: `KqlResultsPanel` rendering execution results as a Fluent `<Table>` with
columns and row count + execution time badges.

Source confirmation: `apps/fiab-console/lib/editors/phase3-editors.tsx` lines
294-407.

Critical line 394: `<textarea className={s.monaco} …>`. The `s.monaco` style at
line 44-55 is just `fontFamily: Consolas; fontSize:13; padding:12; border:…`
applied to a vanilla `<textarea>`. **This is the false-positive marker pattern
called out in `no-scaffold-claims.md` — a "monaco" CSS class on a textarea is
NOT a Monaco editor.**

Package check: zero `@monaco-editor/react`, zero `monaco-editor`, zero
`@kusto/monaco-kusto` in `apps/fiab-console/package.json`.

## Phase 3 — Side-by-side gap matrix

| Fabric element | Loom | Severity |
|---|---|---|
| **Monaco editor with `kusto` language service (`@kusto/monaco-kusto`) + IntelliSense + error squiggles** | **Missing** — vanilla `<textarea>` with CSS class named `monaco` | **BLOCKER** (per fabric-parity-loop workflow contract, Phase 4 mandatory check #1) |
| Syntax highlighting (comments green, keywords blue, operators red) | Missing — plain text | BLOCKER (workflow contract) |
| Line numbers in editor | Missing | MAJOR |
| Autocomplete / IntelliSense (Ctrl+Space) | Missing | BLOCKER |
| Tab navigation (Eventhouse / Database / Queryset) | Missing — Loom uses item-type routing instead of in-editor tabs | MAJOR |
| Toolbar: Live view, New, Get data, KQL Queryset, Notebook, Real-Time Dashboard, Data Agent, Data policies, OneLake | Subset present (ribbon labels). Most are no-op static labels | MAJOR |
| Left sidebar schema browser (Tables / Shortcuts / Materialized views / Functions / Data streams) | Partial — Tables only, plus an info branch. No Shortcuts / MV / Functions / Data streams | MAJOR |
| Search box to filter schema | Missing | MINOR |
| Empty-database "Get data" CTA | Missing — shows `No tables yet. Use .create table.` | MINOR |
| Run button | **Present** — primary action | (positive) |
| Results grid (Fluent `<Table>` with column names, execution time, row count) | Present — basic, no sort / filter / column type indicators / chart toggle | MAJOR for chart toggle |
| Export to CSV | Missing | MAJOR |
| Share query | Missing | MAJOR |
| Save to dashboard | Missing | MAJOR |
| Power BI report from results | Missing | MAJOR |
| Add alert | Missing | MAJOR |
| KQL Tools | Missing | MAJOR |
| Real-time validation (red underline on parse error) | Missing | BLOCKER |
| Chart View toggle on results | Missing — table only | BLOCKER (workflow contract mandatory check #5: "every editor that produces tabular output must have a Chart View toggle") |
| Status bar (cluster connected / autosave / row N of M / language=kusto) | Missing | MINOR |
| Honest MessageBar for missing dashboard / alert / Power BI infra | Missing — buttons would silently fail if clicked | MAJOR (vaporware risk) |

## Phase 4 — Functional click-every-button verification

| Loom control | Result |
|---|---|
| `GET /api/items/kql-database/{id}` | 200 — real cluster + DB resolved, tables[] empty |
| `GET /api/items/kql-database/{id}/tables` | 200 — `{ok:true, database, tables:[], schema:null}` |
| `POST /api/items/kql-database/{id}/query` body=`print x=1` | **200** — real ADX execution, `{columns:["x"], rows:[[1]], rowCount:1, executionMs:27, executedBy:"fgarofalo@…"}`. **PRIMARY ACTION WORKS** against real cluster. |
| Same body but with `now(), current_principal()` | 403 (Front Door WAF false-positive on curly-quote charset; not an editor bug) |
| **Run** button | Fires the query, results panel renders — works |
| **Refresh** button | Re-fetches DB info — works |
| Tree → click table name | Replaces editor content with `["Table"]\n| take 100` — works |
| Ribbon: Table / Materialized view / Function / Update policy / Shortcut / Get data / Query with code / Data policies / OneLake availability | **All no-op** — static labels only. **BROKEN** (silently dead) |

## Verdict

**C-grade**. Real backend (KQL executes against real ADX), primary action works,
but:
- **Editor is a textarea, not Monaco** → BLOCKER per workflow contract
- No IntelliSense, no syntax highlighting, no kusto language service → BLOCKER
- No chart-view toggle on results → BLOCKER per workflow contract
- No real-time validation / squiggles → BLOCKER per workflow contract
- 8+ ribbon buttons silently dead → BROKEN per `no-vaporware.md`
- No Export CSV / Share / Save to dashboard / Power BI / Add alert
- Sidebar shows only Tables, missing Shortcuts / Materialized views / Functions / Data streams

This is the exact "scaffold one step above textarea" pattern called out in
`no-scaffold-claims.md` — strings exist, run works, but the rich UX is absent.

## Required for ≥ B grade

1. **Replace `<textarea className={s.monaco}>` with real `@monaco-editor/react`**
   bound to `@kusto/monaco-kusto` language service. Configure dark theme to match.
   Implement schema-aware IntelliSense by fetching `.show database schema as json`
   on item load and feeding it to the language service.
2. Wire `setModelMarkers` for parse errors → red squiggle.
3. Add Chart View toggle next to the results table (use `recharts`; line / bar / pie
   chooser).
4. Sidebar — add Shortcuts / Materialized views / Functions / Data streams branches.
   Each branch reads from `.show database` mgmt commands.
5. Wire ribbon buttons. For any that need infra not yet deployed (Power BI,
   dashboards), surface honest MessageBar per `no-vaporware.md`.
6. Status bar at the bottom: cluster connected indicator, kusto language label,
   row N of M when result loaded.

Estimated effort to B: 2 focused sessions (Monaco + kusto + Chart view).
To A: 4-5 sessions (full ribbon, side-tree, export/share/dashboard).

## Evidence

- Live API calls (validator run):
  - `GET .../kql-database/9f86ed75-…` → 200 (real cluster + DB)
  - `POST .../query body={kql:"print x=1"}` → 200 with real KQL result `[[1]]`
- Source code: `apps/fiab-console/lib/editors/phase3-editors.tsx` lines 271-407.
- Package check: no `@monaco-editor/react`, no `@kusto/monaco-kusto`.
- Screenshot: `temp/parity/kql-database-loom.png`.
