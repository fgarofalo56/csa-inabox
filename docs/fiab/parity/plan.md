# plan — parity with Microsoft Fabric IQ Plan / Anaplan-style EPM/CPM

**Source UI:**
- Fabric IQ Plan (preview) overview — https://learn.microsoft.com/fabric/iq/plan/overview
- Planning sheets (key capabilities) — https://learn.microsoft.com/fabric/iq/plan/planning-overview#key-capabilities
- Set up scenarios — https://learn.microsoft.com/fabric/iq/plan/planning-how-to-set-up-scenarios
- Writeback / persist data — https://learn.microsoft.com/fabric/iq/plan/planning-writeback/planning-how-to-persist-data
- Intelligence sheets — https://learn.microsoft.com/fabric/iq/plan/intelligence-overview
- Roles in plan — https://learn.microsoft.com/fabric/iq/plan/overview-roles
- Anaplan connected-planning (drivers, breakback, versions) — https://www.anaplan.com/

> **No-Fabric rule.** Everything below is the Azure-native default. Planning cells
> persist to Cosmos; governed writeback MERGEs into Azure SQL; actuals come from a
> Loom semantic model (AAS/XMLA) or Synapse/ADX. A real Fabric capacity is never
> required (`.claude/rules/no-fabric-dependency.md`).
>
> **Honest re-grade (2026-06-29).** The prior version of this doc graded the editor
> "A, zero ❌" against an 18-row inventory that mostly enumerated what Loom already
> built. Measured against the *full* Fabric IQ Plan + Anaplan inventory below, the
> structural EPM core (multidimensional cube, hierarchies/roll-ups, user formulas,
> breakback/spreading, drivers, versions/snapshots) is absent and several polish
> surfaces (Intelligence gallery, comments, export, writeback logs) are thin or
> missing. Real grade today: **C+ / B-**. This doc is the roadmap to true parity.

---

## Real feature inventory

### A. Planning sheet — data model
1. **Multi-dimensional cube** — rows AND columns can each carry one or more
   *dimensions* (Account, Department, Product, Entity, Time), not a fixed
   "line item × period" grid.
2. **Hierarchies + roll-up / drill-down** — members nest (Region → Country →
   Store); parents auto-aggregate children; expand/collapse; drill to leaf.
3. **Member management** — add/rename/reorder/indent members; template rows across
   a hierarchy level.
4. **Measures** — reusable measures (SUM/AVG/COUNT/min/max) over the cube.

### B. Planning sheet — business logic
5. **Formula rows** — Excel-style expressions referencing other rows/cells.
6. **Calculated columns** — per-period computed columns (growth %, YoY, run-rate).
7. **Quick formulas** — one-click common calcs (% of total, cumulative, growth).
8. **Driver-based planning** — a driver row feeds dependent rows through a formula.
9. **Spreading / allocation** — distribute a value down to cells evenly, by weight,
   by growth %, or by an existing distribution.
10. **Breakback (top-down)** — edit a parent/subtotal; the delta pushes back to
    children proportionally.

### C. Planning sheet — exploration
11. Filtering & sorting; **Top N** ranking; grouping rows/columns; adjustable
    column widths/layout; hierarchy navigation.

### D. Scenarios & versions
12. **Scenarios** — create multiple what-if scenarios; compare; per-scenario
    writeback (all / selected); close scenario.
13. **Versions & snapshots** — snapshot a plan state; version management; compare
    A↔B; rolling forecast (lock actuals, forecast the tail).
14. **Scenario security** — per-scenario access control.

### E. Forecasting & analytics
15. Forecast management; what-if simulations; rolling forecasts.
16. **Variance** (plan vs actuals vs forecast) with Δ and Δ%.
17. Trend analysis.

### F. PowerTable
18. Large dimensional grid bound 1:1 to SQL; sort/filter/inline-edit.
19. **Import** from CSV / Excel / JSON; export.
20. Two-way writeback.

### G. Intelligence sheets
21. **100+ chart types**, Gantt, KPI cards, tables on a **storyboard canvas**.
22. **IBCS formatting**; pixel-perfect **export to Excel / PDF**.
23. Canvas- and data-point-level **annotations**; threaded comments; `@mentions`.
24. Compare actuals vs plans; reusable measures across sheets.

### H. InfoBridge (data integration)
25. Consolidate from multiple sources; **transformations** (merge/append/pivot/
    group); real-time integration; data mapping between sheets.

### I. Writeback & persistence
26. **Multiple destinations**; add/manage; **decimal precision** + **text length**
    config; **autowriteback**.
27. **Writeback logs** — milestones, payload size, duration, per-run detail; export.

### J. Collaboration
28. Notes/annotations; comment threads; `@mentions`; email notifications; comment
    digests; comments column + comments pane.

### K. Governance
29. **Roles** — Planner / Stakeholder / Viewer capability matrix.
30. **Approval workflows** — define flow, assign approvers, review/approve, request
    adjustments.

### L. AI
31. AI-assisted planning / Copilot ("AI-ready foundation", AI-assisted decisions).

---

## Loom coverage

| # | Capability | Status | Notes / backend |
| --- | --- | --- | --- |
| 12 | Scenarios (branch/rename/delete, per-scenario cells) | ✅ built | `PlanningSheetPanel`; `cloneScenarioCells`/`dropScenarioCells`; Cosmos |
| 16 | Variance plan vs actuals (Δ, Δ%) | ✅ built | `computeVariance`; variance overlay + Intelligence report |
| 15/17 | Forecast (OLS) + trend | ✅ built | `forecastPeriods`/`linearFit`; `PlanTrendChart` |
| 18 | PowerTable: flat SQL-bound grid, sort/filter/inline-edit | ✅ built | `PlanPowerTablePanel`; `flattenPlanCells` |
| 20 | Two-way writeback (MERGE) + load-from-SQL | ✅ built | `/api/items/plan/[id]/writeback`; `plan-backing-store` (real Azure SQL) |
| 25 (partial) | InfoBridge line-item→source mapping, push to actuals | ✅ built | `PlanInfoBridgePanel`; `applyMappingsToActuals` |
| 30 | Approval workflow (real Office365 Logic App + callback) | ✅ built | `/approval` + `/approval-callback`; `plan-approval-client` |
| — | Semantic-model bind for actuals + Azure SQL provisioning | ✅ built | `PlanSettingsFlyout`; `/binding` |
| 21 (partial) | Intelligence: 1 trend chart + variance table + Gantt | ⚠️ thin | one visual each; no gallery/cards/canvas |
| 4 | Measures (auto subtotal only) | ⚠️ thin | `subtotal` kind auto-sums; no user-defined measures |
| 1 | Multi-dimensional cube (flat line-items × periods only) | ❌ MISSING | 2-D grid only |
| 2/3 | Hierarchies, roll-up/drill-down, member mgmt | ❌ MISSING | — |
| 5/6/7 | Formula rows / calculated columns / quick formulas | ❌ MISSING | — |
| 8 | Driver-based planning | ❌ MISSING | — |
| 9/10 | Spreading/allocation + breakback | ❌ MISSING | — |
| 11 | Top N / grouping / hierarchy nav / column width | ❌ MISSING | basic PowerTable sort only |
| 13 | Versions & snapshots, compare, rolling forecast | ❌ MISSING | — |
| 14/29 | Scenario security + roles (Planner/Stakeholder/Viewer) | ❌ MISSING | — |
| 19 | Import CSV/Excel/JSON | ❌ MISSING | — |
| 22 | Export to Excel / PDF | ❌ MISSING | — |
| 23/28 | Comments, annotations, @mentions, comments pane | ❌ MISSING | — |
| 26/27 | Multiple destinations, decimal/text config, autowriteback, writeback logs | ❌ MISSING | single hard-coded `dbo.loom_plan_cells`, no logs |
| 25 (rest) | InfoBridge transforms (merge/append/pivot/group), sheet-to-sheet | ❌ MISSING | mapping only |
| 31 | AI-assisted planning / Copilot | ❌ MISSING | computed (non-AI) insights only |

---

## Build plan

### P0 — structural EPM core (this is most of the "basic" complaint)

1. **Multi-dimensional cube + hierarchies + roll-ups** (#1,#2,#3,#4).
   - *UI*: extend `PlanningSheetPanel` into a dimension-aware grid. Add a "Model"
     left rail listing **row** and **column dimensions** as chips; a Fluent `Tree`
     first column with expand/collapse carets for nested members; indent/outdent +
     reorder; parent rows bold + read-only (auto roll-up). `TileGrid` for the
     dimension-manager dialog. Loom tokens, `EmptyState`, elevation.
   - *Backend*: extend `_plan-model.ts` with `PlanDimension`/`PlanMember
     {id,label,parentId,level}` and a pure `rollup(sheet,scenario)` aggregating
     leaf cells up the parent chain (vitest-covered). Cosmos state grows
     `dimensions[]`; SQL writeback gains `dimension_path` columns — same
     `plan-backing-store` MERGE, no new Azure service.

2. **Formula rows + calculated columns + quick formulas** (#5,#6,#7).
   - *UI*: a "Formula" line-item kind whose editor opens a guided **Formula
     builder** dialog (function palette + row/measure token picker + live preview,
     mirroring the ADF/Synapse expression-builder pattern — NOT freeform per
     `loom_no_freeform_config`). A "Quick formula" `Menu` per row (% of total,
     cumulative, growth %, YoY).
   - *Backend*: a safe token-AST evaluator in `_plan-model.ts` (row refs +
     arithmetic + SUM/AVG/IF, **no `eval`**), evaluated client-side and
     re-validated server-side in the writeback route. Pure, vitest-covered.

3. **Model editor (cube) tab + validation** (#4 dimensions/measures/hierarchies).
   - *UI*: new **Model** (6th) tab — `TileGrid` of dimension + measure cards;
     "Validate model" → `MessageBar` summary; section headers (`Title3`/`Caption1`),
     Fluent icons, `shadow4`→`shadow16` hover per web3-ui.
   - *Backend*: new `POST /api/items/plan/[id]/model` validates member-parent
     integrity, measure refs, and formula cycles over Cosmos state — no external
     service.

### P1 — planning depth + polish

4. **Spreading / allocation + breakback** (#9,#10).
   - *UI*: cell/total right-click `Menu` → "Spread evenly / by growth % / by
     weight"; editing a parent opens a breakback `Dialog` (proportional vs even).
   - *Backend*: `spread()` + `breakback()` pure helpers in `_plan-model.ts`,
     vitest-covered; Cosmos persist.

5. **Driver-based planning** (#8).
   - *UI*: mark a row **Driver** (`Badge`); dependents reference it in the Formula
     builder; a "Drivers" mini-panel lists drivers + dependents.
   - *Backend*: reuse the formula evaluator; topological recompute on driver edit.

6. **Versions & snapshots + rolling forecast** (#13).
   - *UI*: **Versions** flyout — "Snapshot now", list (timestamp/author/total),
     "Compare A↔B" diff table, "Restore"; rolling-forecast toggle locking periods
     ≤ today as actuals.
   - *Backend*: snapshots = immutable state copies in a Cosmos `plan-snapshots`
     container (`createIfNotExists`); compare is a pure diff.

7. **Intelligence gallery** (#21,#22,#24) — uplift the thin Intelligence tab.
   - *UI*: a **visual gallery** (`TileGrid` of line/bar/area/KPI-card/waterfall/
     Gantt/table) + a storyboard canvas reusing the report-editor `canvas-node-kit`;
     extend the existing KPI strip into a card gallery; IBCS number-format toggle.
   - *Backend*: all client-computed from plan cells (`periodSeries`,
     `forecastPeriods`); export below.

8. **Export to Excel / PDF / CSV** (#22).
   - *UI*: ribbon "Export" `SplitButton`.
   - *Backend*: `GET /api/items/plan/[id]/export?format=xlsx|pdf|csv` — `exceljs`
     for xlsx, print-HTML→PDF (or `pdf-lib`), streamed download. Real bytes.

9. **Writeback logs + destinations + decimal/text config + autowriteback** (#26,#27).
   - *UI*: Settings flyout gains a **Destinations** table (target db, table,
     decimal precision, text length) + a **Writeback logs** table (run id, ts,
     rows, duration, status) with a detail `Drawer`.
   - *Backend*: `plan-backing-store` records each run into
     `dbo.loom_plan_writeback_log`; `GET /writeback?logs=1` returns runs;
     autowriteback = persisted flag firing writeback on save.

10. **Comments / annotations / @mentions** (#23,#28).
    - *UI*: a **Comments pane** (`Drawer`) + comments-column toggle; threaded
      replies; `@mention` combobox over tenant users; `Badge` count.
    - *Backend*: Cosmos `plan-comments` container; `@mention` via the existing
      user/graph lookup; optional email via the approval Logic App.

11. **Import CSV/Excel/JSON into PowerTable** (#19).
    - *UI*: PowerTable "Import" `Button` → file `Dialog` + column-mapping step.
    - *Backend*: `POST /api/items/plan/[id]/import` parses with `papaparse`/
      `exceljs`, maps to cells, MERGEs. Honest errors.

### P2 — governance + AI

12. **Roles + scenario security** (#14,#29).
    - *UI*: a **Sharing/Roles** dialog (Planner/Stakeholder/Viewer) + per-scenario
      access list, reusing `share-dialog.tsx`.
    - *Backend*: role grants on the item; enforced in the BFF routes per the roles
      capability matrix.

13. **AI-assisted planning / Copilot** (#31).
    - *UI*: a collapsible side **Plan Copilot** (reuse the console side-Copilot) —
      "explain this variance", "draft next-quarter forecast", "what drives the
      OpEx jump".
    - *Backend*: Azure OpenAI via the shared `aoai-chat-client` (single AOAI client
      per EH Phase-0), grounded on plan cells/variance. No Fabric Copilot.

14. **Top N / grouping / hierarchy nav / column layout** (#11) — folded into the P0
    cube grid work.

15. **InfoBridge transformations** (#25 rest) — merge/append/pivot/group +
    sheet-to-sheet mapping via a dropdown-driven transform-step builder (no
    freeform).

## Backend per control (existing, preserved)
- Plan CRUD + cell/scenario/sheet edits → PATCH `/api/items/plan/[id]` (Cosmos).
- Semantic-model picker + backing provision → GET/POST `/api/items/plan/[id]/binding`.
- Writeback / read-back → POST/GET `/api/items/plan/[id]/writeback` → `plan-backing-store` (Azure SQL MERGE/SELECT; honest 503 gate on `LOOM_PLAN_BACKING_SQL_*`).
- Intelligence → pure client compute over plan cells/tasks (`_plan-model`).
- Approval → POST `/api/items/plan/[id]/approval` (Azure-native Logic App). No Fabric / Power Automate.
