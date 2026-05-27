# Loom warehouse editor — Fabric parity gap (v2 validator, 2026-05-26)

> Validator agent: independent fabric-parity-loop v2 validator
> Loom build under test: `https://loom-console-fvbbctd4eehqbkcs.b02.azurefd.net` (Azure Front Door)
> Loom routes tested: `/items/warehouse/new` (WarehouseEditor) AND `/items/synapse-dedicated-sql-pool/new` (SynapseDedicatedSqlPoolEditor)
> Fabric reference: see `docs/fiab/warehouse-parity-spec.md` (Phase-1 catalog spec) — live Fabric capture was BLOCKED on MSAL re-auth, see Phase 1 note below.

## Final grade: **D**

Multiple BLOCKERs: T-SQL editor is a plain `<textarea>` not Monaco (NO intellisense, NO syntax highlighting, NO schema-aware autocomplete, NO error squiggles), no Model view, no Visual Query Designer, no multi-tab SQL editor, no results-grid features (sort/filter/export/visualize), no Messages tab. Several ribbon labels are silently dead (BROKEN per `no-vaporware.md`). Same `D` rating for the `synapse-dedicated-sql-pool` route (textarea-based editor with identical issues).

Rationale below.

## Phase 1 — Fabric reference capture

**Status: BLOCKED on MSAL.** Playwright session does not have a usable Fabric token — the validator session is signed in to Loom but `https://app.fabric.microsoft.com` triggers an interactive MSAL redirect. Per the validation-standard failure-handling protocol, proceeding using the Phase-1 catalog spec already captured in this repo on 2026-05-26.

Reference document used: `docs/fiab/warehouse-parity-spec.md`. That spec was produced by a sibling Explore agent and matches the public Fabric Data Warehouse docs.

Screenshot placeholder: `temp/parity/warehouse-fabric.png` (MSAL login page — proof that interactive auth is required).

## Phase 2 — Loom under test capture

Screenshot: `temp/parity/warehouse-loom.png` (captured at h1="New warehouse", URL=`/items/warehouse/new`).

DOM marker dump: `temp/parity/warehouse-loom.dump.json`:

```json
{ "url": "/items/warehouse/new",
  "h1": "New warehouse",
  "monaco": 0,
  "textareas": 1,
  "treeItems": 2,
  "tableRowCount": 0,
  "resultsGrid": false,
  "exportButtons": 0,
  "visualizeButton": false,
  "messagesTab": false,
  "modelViewTab": false,
  "visualQueryTab": false,
  "multipleSqlTabs": 0,
  "allButtonLabels": ["...","Home","New SQL query","Run","Save as table","Open in Excel",
                      "New measure","Manage relationships","Permissions","Source control",
                      "Refresh","Run"]
}
```

Synapse Dedicated SQL pool secondary route (`/items/synapse-dedicated-sql-pool/new`) is essentially the same shape: `monaco: 0, textareas: 1` with a Resume / Pause toolbar + a single T-SQL textarea seeded with a smoke-test SELECT. See `temp/parity/synapse-dedicated-sql-pool-loom.dump.json`.

## Phase 3 — Side-by-side gap matrix

| # | Fabric element (from parity-spec.md) | Loom presence (`/items/warehouse/new`) | Severity |
|---|---|---|---|
| 1 | Top toolbar — tab strip (Schema / Model / Query view modes) | Loom has tab strip in the Loom app shell but **no editor-mode tab switcher** (Schema / Model / Query). | MAJOR |
| 2 | **+ New SQL query** button opens a new query tab | Loom has a "New SQL query" label in the ribbon — **silently dead (no click handler)**. See Phase 4. | **BROKEN** |
| 3 | **Multi-tab SQL editor** (multiple T-SQL queries open simultaneously) | Loom: `multipleSqlTabs: 0` — single textarea only. | **BLOCKER** |
| 4 | Save / Save as / Share | Save absent; Share is in the top-right item toolbar (generic). | MAJOR |
| 5 | Refresh schema cache | Present, wired to `loadSchema()` — OK | OK |
| 6 | **Left — Object Explorer**: Schemas → Tables (with columns + types + nullability), Views, Stored procedures, Functions, Types | Loom renders ONLY Schemas → Tables (with row count). No Views / Procs / Funcs / Types sub-branches. Columns / types / nullability NOT visible — table-leaf click sets the textarea to `SELECT TOP 100 * FROM [s].[t]`. (phase3-editors.tsx lines 1216-1253) | **MAJOR** |
| 7 | Right-click on tree item: Query top 100 / Drop / Properties / Refresh / Create stored proc / ... | Absent — only the left-click "set textarea to SELECT TOP 100" action. No context menu. | MAJOR |
| 8 | "Search objects" box at top of Object Explorer | Absent | MINOR |
| 9 | **Monaco-based T-SQL editor with grammar + intellisense + column auto-complete from schema** | **Absent. Plain `<textarea>` at phase3-editors.tsx line 1273-1279.** className `s.monaco` is **misleading** — it is a textarea styled to look like Monaco but with **NO** syntax highlighting, **NO** completion, **NO** signature help, **NO** error squiggles. Repo-wide grep confirms zero `monaco-editor` imports in `apps/fiab-console/`. | **BLOCKER** |
| 10 | Run button + dropdown (Run query / Run selection / Explain plan) | Loom has one Run button, no dropdown, no "Run selection", no "Explain plan". | MAJOR |
| 11 | Cancel query button when active | Loom shows a Spinner during loading but no cancel control. | MINOR |
| 12 | **Results grid** — column types annotation, sortable + filterable columns, Export menu (CSV/JSON/Parquet), Visualize toggle, row count + execution time | Partially present. Row count + executionMs badges render. **NO sort, NO filter, NO export buttons (`exportButtons: 0`), NO visualize toggle (`visualizeButton: false`). Column type annotations absent.** | **BLOCKER** |
| 13 | **Messages tab** alongside Results (errors / warnings / info / query plan) | **Absent (`messagesTab: false`).** Errors render in a single MessageBar. No tab. No plan output. | **BLOCKER** |
| 14 | **Model view** — relationship canvas with table cards + FK lines, drag to create FK, properties pane for cardinality/cross-filter | **Absent (`modelViewTab: false`).** | **BLOCKER** |
| 15 | **Visual Query Designer** — drag-drop query builder, joins via canvas, generates T-SQL behind the scenes | **Absent (`visualQueryTab: false`).** | **BLOCKER** |
| 16 | Settings tab — workspace context, capacity binding, refresh policies, security (workspace roles, RLS, column-level, dynamic data masking) | Absent | MAJOR |
| 17 | Status bar (Connected / AutoSave / language / cursor pos) | Absent | MINOR |
| 18 | Auth-gated controls show honest MessageBar with required env-var / role / bicep | "Warehouse compute is Unknown" MessageBar renders when pool is offline — OK, honest gate. | OK |

### Severity tallies

- BLOCKER: 5 rows
- MAJOR: 6 rows
- MINOR: 3 rows
- BROKEN (Phase-4 carry-back): 1 row (New SQL query)
- OK: 2 rows

## Phase 4 — Functional click-every-button verification

Tested via Playwright `evaluate` on `/items/warehouse/new` (pool is offline in this Loom environment):

| Loom control | Source | State | Click effect | Verdict |
|---|---|---|---|---|
| Ribbon "Source control" label | WH_RIBBON definition in phase3-editors.tsx | enabled | dialogs 0→0, alerts 0→0, url unchanged | **BROKEN — silently dead** |
| Ribbon "New measure" label | same | enabled | dialogs 0→0, url unchanged | **BROKEN — silently dead** (and also semantically wrong — measures belong to semantic models, not warehouses) |
| Ribbon "Manage relationships" label | same | enabled | (untested but same RIBBON pattern → expected no-effect) | **BROKEN — silently dead (presumed)** |
| Ribbon "Permissions" label | same | enabled | (untested but same RIBBON pattern → expected no-effect) | **BROKEN — silently dead (presumed)** |
| Ribbon "New SQL query" label | same | enabled | (untested — but same RIBBON pattern → expected no-effect; also no second textarea would render since `multipleSqlTabs: 0`) | **BROKEN — silently dead (presumed)** |
| Ribbon "Save as table" label | same | enabled | (untested — same RIBBON pattern) | **BROKEN — silently dead (presumed)** |
| Ribbon "Open in Excel" label | same | enabled | (untested — same RIBBON pattern) | **BROKEN — silently dead (presumed)** |
| Ribbon "Run" label (top) | same | enabled | (untested directly — same RIBBON pattern; the working Run is the in-toolbar Run, gated on `ready`) | **BROKEN — silently dead (presumed)** |
| Toolbar "Refresh" | inline `loadSchema` | enabled | Fires GET `/api/items/warehouse/[id]/schema` | OK |
| Toolbar "Run" (workspace) | inline `run` | disabled while pool offline | Correctly gated, fires `/api/items/warehouse/[id]/query` POST when enabled | OK (assumption — not exercised because pool was offline) |

Two ribbon controls were exercised in this run (Source control + New measure). Both confirmed BROKEN. The remaining 6 ribbon labels share the same `RIBBON` declaration pattern — they are listed as `{ label: 'X' }` in WH_RIBBON with no onClick prop, identical to the data-pipeline editor's ribbon (which was exercised fully and confirmed BROKEN across all 5 labels). Per `no-vaporware.md` rule "Silently dead buttons = BROKEN", these are all marked BROKEN (presumed) and should be verified on remediation.

### Honesty-check verdicts

| Honesty check | Verdict |
|---|---|
| **"Does the editor use Monaco with T-SQL syntax + intellisense, or just a `<textarea>`?"** | **CONFIRMED `<textarea>`.** `document.querySelectorAll('[class*="monaco-editor"]')` returns 0 on `/items/warehouse/new` (`monaco: 0`) and on `/items/synapse-dedicated-sql-pool/new` (`monaco: 0`). Both editors have exactly 1 `<textarea>` for T-SQL. Repo-wide `monaco-editor` grep returns 0 in `apps/fiab-console/`. The className `s.monaco` at phase3-editors.tsx line 1274 is **misleading naming** for a styled `<textarea>` — not an actual Monaco editor. |

## Grading rationale

Per parity-validation-standard rubric (STRICTEST observed):

- Phase 3 has 5 BLOCKER rows (no Monaco + IntelliSense; no results-grid features; no Messages tab; no Model view; no Visual Query Designer) → **C** is the ceiling.
- Phase 4 has 2 confirmed BROKEN + 6 presumed-BROKEN ribbon controls. Even with the conservative "verify before marking BROKEN" rule, 2 confirmed BROKEN ribbon controls is enough to drop one grade → **D**.
- Per Build-phase contract section 1, **no editor that uses a textarea where Monaco is required can grade above C**. Combined with confirmed BROKEN ribbon controls → **D**.

**Final grade: D.** Loop back to Build phase.

## Recommended Build-phase remediation (ordered by impact)

1. **Replace `<textarea>` with `@monaco-editor/react`** at phase3-editors.tsx line 1273 (Warehouse) and synapse-sql-editors.tsx line 467 (Dedicated SQL pool). Configure `language="sql"`, `theme="vs-dark"`. Register a `monaco.languages.registerCompletionItemProvider('sql', ...)` seeded from the live `schema` object so column names auto-complete. Enable `setModelMarkers` for client-side T-SQL parse errors (use a simple tokenizer or `node-sql-parser`).
2. **Wire ribbon labels to real handlers (or remove them)**. WH_RIBBON in phase3-editors.tsx currently produces 8+ dead labels (`New SQL query` / `Run` / `Save as table` / `Open in Excel` / `New measure` / `Manage relationships` / `Permissions` / `Source control`). Either wire each to a real action, hide it behind a feature flag, or delete it. `New measure` and `Manage relationships` likely shouldn't be on the Warehouse ribbon at all — those are semantic-model concerns.
3. **Multi-tab SQL editor**: convert `sqlText` state to an array of tabs `{ id, title, sql, results }`; render a TabList above the Monaco editor; "+ New SQL query" appends a tab. Persist active tab in URL fragment for shareability.
4. **Results-grid features**:
   - Column-type annotation in headers (read `result.columns[].type`).
   - Sort: click column header to toggle ASC/DESC (in-memory sort over `result.rows`).
   - Filter: column-header filter popover.
   - Export menu: `/api/items/warehouse/[id]/export?format=csv|json|parquet` — new BFF route required.
   - Visualize toggle: render `recharts` line/bar/pie from the results.
5. **Messages tab**: split Results pane into a TabList with `Results` + `Messages` tabs. Messages tab gets the MessageBar content + query-plan output when an `EXPLAIN` or `SHOWPLAN_XML` query is run.
6. **Object Explorer expansion**: Schemas → Tables/Views/Stored procedures/Functions/Types. Each Table leaf shows columns sub-tree with type + nullability (read from INFORMATION_SCHEMA.COLUMNS via a new `/api/items/warehouse/[id]/object-tree` BFF route — already noted in parity-spec.md).
7. **Right-click context menu** on tree items: Query top 100 / Drop / Properties / Refresh / Create stored proc with this / Generate INSERT.
8. **Model view** (Power BI-style canvas): use `reactflow` or hand-built SVG to render table cards with FK relationship lines. Read FK metadata via `/api/items/warehouse/[id]/relationships` (new BFF route — needs sys.foreign_keys query).
9. **Visual Query Designer**: drag-drop joins canvas → generates T-SQL. Scope-cut option: a simpler "Select tables + join columns" form that emits a starter SELECT.
10. **Settings tab**: workspace context, capacity, security (RLS / CLS / DDM forms).
11. **Status bar**: bottom-of-pane bar showing Connected / pool sku / language / Cell N of M (cursor pos in Monaco).

Estimated effort to reach **B**: 2-3 focused sessions (Monaco swap + intellisense seed = 1; ribbon wiring + Messages tab + multi-tab = 0.5; results-grid features = 0.5; Object Explorer expansion = 0.5).

To reach **A** add: right-click context menus + Model view + Visual Query Designer + Settings tab + status bar.

## Receipts

- `temp/parity/warehouse-fabric.png` (MSAL block page)
- `temp/parity/warehouse-loom.png` (captured during validation; the production-app tab-rotator unfortunately overwrote the file before the final fullPage screenshot completed — see side-finding below; the dump.json was captured first and is authoritative for DOM markers)
- `temp/parity/warehouse-loom.dump.json` (DOM marker dump — captured at h1="New warehouse")
- `temp/parity/warehouse-buttons-state.json` (button enabled/disabled state)
- `temp/parity/warehouse-ribbon-clicks.json` (2 BROKEN ribbon clicks: Source control + New measure)
- `temp/parity/synapse-dedicated-sql-pool-loom.dump.json` (sibling textarea-based editor)
- Source code references: `apps/fiab-console/lib/editors/phase3-editors.tsx` (WarehouseEditor), `apps/fiab-console/lib/editors/synapse-sql-editors.tsx` (SynapseDedicatedSqlPoolEditor)
- Reference spec: `docs/fiab/warehouse-parity-spec.md`

## Side-finding (carried from the data-pipeline gap doc)

The live Loom production app has a runtime tab-rotator that auto-changes the URL every ~3-6 seconds without user input. This affects screenshot fidelity (the rotator can race against `await page.screenshot()`). DOM dumps captured inside a single `page.evaluate()` are reliable because they execute atomically inside the page context; the dump.json files in `temp/parity/` were each verified to be at the correct h1 + URL before being persisted.
