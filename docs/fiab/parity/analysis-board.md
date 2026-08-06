# analysis-board — Loom-native surface (Palantir Contour parity; no Azure/Fabric analog)

**Source UI: NONE first-party.** `analysis-board` is a Loom-native item type
built as parity for **Palantir Foundry Contour** (Foundry-parity row 3.1) — a
point-and-click board where an ordered list of typed transform steps compiles to
a real query. Palantir is not a Microsoft product; there is no Azure portal blade
and no Fabric item type this is a one-for-one twin of.

Measured against the plausible candidates, so this is not an assumption:

- **Fabric Dataflow Gen2 / Power Query** is the nearest *shaped* Microsoft
  surface (ordered applied steps over a source), but it is an **ETL authoring**
  tool that writes a destination, not an **interactive analysis** surface. Loom
  already has a `dataflow` item with its own parity doc for that comparison.
- **KQL Queryset** (Fabric RTI) and the **ADX web UI** are the closest ADX
  surfaces, but both are *free-text KQL editors*. This surface's entire premise
  is the opposite: point-and-click steps, no typing KQL. Loom has `kql-queryset`
  separately.
- The **Azure portal** has no equivalent surface of any kind.

Per `ui-parity.md`, naming one of those as "the source UI" would produce a
fictional table. Per `ux-baseline.md` this document therefore grades the surface
against the **`docs/fiab/ux-standards.md` §7 checklist**, plus a functional
inventory of what a step-based board must do to be useful.

**Surface file:** `apps/fiab-console/lib/editors/phase4/analysis-board-editor.tsx` (254 lines)
**Compiler:** `apps/fiab-console/lib/editors/analysis-board-model.ts` (16 existing unit tests)
**Route:** `/items/analysis-board/[id]` · Tagged **Preview**.

## Block 1 — functional capability (what a step-based board needs)

| # | Capability | Status | Evidence / gap |
|---|---|---|---|
| F1 | Source: pick a table | built | Typed `Input`, compiles into the KQL head. |
| F2 | Source: base query to append steps onto | built | `Textarea` alternative — an escape hatch for KQL users without forcing everyone into it. |
| F3 | Source: **browse** real tables | **MISSING** | The table name is **free text** (`placeholder="Events"`). No database picker, no table dropdown, no column list — even though sibling surfaces (`data-contract`, `synthetic-data`) already cascade real backend dropdowns from the same kind of routes. A typo is indistinguishable from a missing table until you press Run. |
| F4 | Step: **filter** (column, operator, value) | built | 6+ operators from `FILTER_OPS`; `in` documented as comma-separated. |
| F5 | Step: **select** columns | built | Comma-separated. |
| F6 | Step: **distinct** | built | |
| F7 | Step: **derive** (new column from an expression) | built | |
| F8 | Step: **aggregate** (group-by + function) | partial | Group-by is multi-column, but only **one aggregation** is editable — `step.aggregations[0]` is hard-indexed in all four handlers (`:232-237`). The model is an array; the UI can only ever author element 0. "Count and sum in one step" is not expressible. |
| F9 | Step: **sort** | built | Column + asc/desc. |
| F10 | Step: **limit** | built | Clamped to at least 1. |
| F11 | Reorder steps | built | Move up / move down with `aria-label`s. |
| F12 | Remove a step | built | |
| F13 | **Live compiled-query preview** | built (strong) | `compileBoardToKql` runs on every edit in a `useMemo`; the KQL is always visible. Teaches KQL by showing the translation rather than hiding it. |
| F14 | Run against the real backend | built | `POST …/run` reaches real ADX via `kusto-client`. |
| F15 | Results grid | partial | Renders, capped at 200 rows — but hand-built `<Table>`, **not** `PreviewTable`: no type badges, and no indication that the display is truncated at 200 while `rowCount` may be larger. |
| F16 | Save the board | built | `PATCH …/:id`. |
| F17 | Duplicate / branch a board | **MISSING** | Not offered. Contour's core workflow is branching to try a variant; here you must rebuild. |
| F18 | Step-level intermediate results | **MISSING** | Only the final result is shown. **The defining affordance of a step-based tool** — inspecting the data between steps — is absent. |
| F19 | Chart / visualise the result | **MISSING** | Table only. |
| F20 | Export results (CSV / clipboard) | **MISSING** | Not offered. |
| F21 | Publish the board as a dataset or pin it to a dashboard | **MISSING** | The output is a dead end — it cannot feed anything else in Loom. |
| F22 | Column autocomplete from the source schema | **MISSING** | Every column name in every step is free text. Consequence of F3. |
| F23 | Join / union across sources | **MISSING** | Single source only. |

**Block 1: 13 built · 2 partial · 8 MISSING (23 rows).**

## Block 2 — ux-baseline §7 checklist

| # | Bar | Status | Evidence / gap |
|---|---|---|---|
| U1 | Fluent v9 + Loom tokens; no hard-coded px/hex | built | Tokens throughout `makeStyles`. |
| U2 | Real backend on every control | built | See the backend table. |
| U3 | Honest gate when ADX is unconfigured | partial | A 503 from the run route is correctly downgraded to `intent="warning"` with an **"ADX not configured"** title and the route's `gate.remediation` appended (`:105`, `:180`) — deliberate and honest. But it is **not** the shared `HonestGate`, so no inline **Fix it** and no gate-registry entry (**G2**). |
| U4 | Guided `EmptyState` | **MISSING** | No empty state at all — a board with no steps renders just the Source card and an empty compiled-KQL hint. `EmptyState` is not imported. |
| U5 | Skeleton / spinner on load | **MISSING** | The initial `GET` (`:62-71`) has no loading state. |
| U6 | Error surface is honest on load | **MISSING** | `catch { /* keep default */ }` — a failed or forbidden load renders as a **blank new board**. Same unknown-reported-as-negative class as `notepad` and `fusion-sheet`: a subsequent Save would then persist the blank board over the real one. |
| U7 | Teaching guidance / Learn link | **MISSING** | One `<Body1>` line; no `TeachingBanner`, no `LearnPopover`. |
| E1 | `ItemEditorChrome` shell | **MISSING** | **Not used** — bare `<div>`. No ribbon, no item-tab strip, no right details panel, no Copilot entry, no command-palette registration. |
| E2-E5 | Ribbon / command search / details panel / Copilot | **MISSING** | All four are consequences of E1. Counted once here as a single row to avoid inflating the total; individually they are four missing bars. |
| E6 | Explicit dirty state | **MISSING** | Edits mutate `board`; the only feedback is a transient "Saved." caption after the fact. No unsaved indicator. |
| E7 | Undo/redo | **MISSING** | None. Removing a step is unrecoverable. |
| E8 | G3 resizable panes (`SplitPane` + `sizingKey`) | **MISSING** | Fixed layout; the compiled-KQL block and the results grid cannot be resized. |
| E9 | Clean first-open (no red on a fresh item) | built (exemplary) | `:173-177` carries an explicit `ux-baseline G6` comment: an untouched board with no table and no steps shows a **guided hint**, not a red compile error. Validation surfaces only after touch. This is the correct pattern and the only surface in this batch that implements it deliberately. |
| E10 | Badge rows wrap | built | `flexWrap: 'wrap'` on `row` and `stepHead`; `minWidth: 0` on `wrap`. |
| E11 | Row-key stability | partial | Steps keyed by array index (`key={i}`, `:156`) while `moveStep` swaps in place — React reconciles the wrong node onto a moved step, so a focused input can carry stale transient state across a reorder. Steps have no id to key on. |

**Block 2: 3 built · 3 partial · 9 MISSING (15 rows).**

**Combined totals: 16 built · 5 partial · 17 MISSING (38 rows).**

## Backend per control

| Control | Call | Real backend |
|---|---|---|
| Initial load | `GET /api/cosmos-items/analysis-board/:id` | Cosmos DB |
| **Save** | `PATCH /api/items/analysis-board/:id` body `{state:{board}}` | Cosmos DB |
| **Run** | `POST /api/items/analysis-board/:id/run` body `{board}` | **Azure Data Explorer** via `kusto-client` |
| Step editing / compiled-KQL preview | `compileBoardToKql()` — pure, in-process | none needed (instant feedback, no round-trip) |

Real backend on every control that needs one. No mocks. No Fabric host contacted
— `no-fabric-dependency.md` satisfied (ADX is the Azure-native backend).

## Assessment

**C.** The compiler is the strong part — pure, 16 existing unit tests, and the
live-preview design (always show the KQL you just built) is a genuinely good
idea that teaches the query language instead of hiding it. The ADX backend is
real and the 503 handling is deliberately honest. E9 (clean first-open) is the
best implementation of that bar in this batch.

What holds it back, in order:

1. **F18 — no intermediate step results.** For a step-based tool this is not a
   missing feature, it is the missing *point*: you cannot see what your data
   looked like after step 3, which is the whole reason to build the work as
   steps rather than as one query.
2. **U6 — silent load failure, blank board, Save overwrites.** Same
   data-loss-shaped defect as `fusion-sheet`. Fix regardless of lane priority.
3. **F3 + F22 — everything is free text.** No table browse, no column
   autocomplete, on a surface whose premise is *not typing queries*. Sibling
   editors already have the routes to do this.
4. **F8 — one aggregation per step**, despite the model being an array.
5. **E1** — closing it resolves four bars at once.
6. **F21 — the output goes nowhere.** A board you cannot publish or pin is a
   scratchpad.

## Verification

- **V3 (in-browser click-walk): OWED.** `loom-ui-verify` red since 2026-08-04
  (FINISHLINE C13); GitHub Actions degraded. When recovered:
  ```bash
  gh workflow run loom-ui-verify.yml --ref main -f target_route=/items/analysis-board/<id>
  ```
  The walk must include: a first-open pass on a freshly created board (confirming
  E9's guided hint, not a red error), a reorder-then-edit pass (E11), and a load
  against a Cosmos read that 500s (expected to render a blank board — the U6
  defect).
- Coverage read from source; static evidence only (`no_scaffold_claims`).
