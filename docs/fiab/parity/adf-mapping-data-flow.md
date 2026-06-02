# adf-mapping-data-flow — parity with the ADF Studio Mapping Data Flow designer

> Brutally-honest 1:1 parity audit (2026-06-01). Grading per
> `.claude/rules/no-vaporware.md` + `.claude/rules/ui-parity.md`. Graded
> conservatively; when in doubt, graded DOWN.
>
> Scope: the new **Mapping Data Flow visual designer** in the Mounted ADF editor
> — the flagship ADF Studio surface that `adf-data-factory.md` previously flagged
> as MISSING ("the React Flow canvas is pipeline-only"). This is now a real
> source → transform → sink graph that round-trips to the ADF data-flow REST.

**Source UI (grounded in Microsoft Learn, not memory):**
- Mapping data flows overview (graph, source/transform/sink, debug, data preview): https://learn.microsoft.com/azure/data-factory/concepts-data-flow-overview
- Data flow script (DFS) — the `~>` stream language Loom emits/parses: https://learn.microsoft.com/azure/data-factory/data-flow-script
- Source transformation: https://learn.microsoft.com/azure/data-factory/data-flow-source
- Select / Filter / Join / Aggregate / Derived-column transformations: https://learn.microsoft.com/azure/data-factory/data-flow-transformation-overview
- Sink transformation: https://learn.microsoft.com/azure/data-factory/data-flow-sink

**Loom surface:**
- UI: `apps/fiab-console/lib/editors/mounted-adf-editor.tsx` — `DataFlowsTab` +
  `MappingDataFlowDesigner` / `InnerDesigner` (React Flow canvas, transform palette,
  per-node configuration pane). `DfNode` custom node; DFS round-trip via
  `modelToTypeProperties` / `definitionToModel` / `dfsForStream`.
- BFF: `apps/fiab-console/app/api/adf/dataflows/route.ts` (list/create),
  `…/[name]/route.ts` (get/save/delete); `app/api/adf/datasets` (source/sink picker).

**Backend reality check.** List/create/get/save/delete call real ADF REST
(`Microsoft.DataFactory/factories/dataflows`, api 2018-06-01) against the
env-pinned default factory. The designer parses the saved data-flow `scriptLines`
into a typed stream graph and re-emits canonical DFS on Save (PUT). No `return []`,
no `MOCK_`, no `useState(SAMPLE)`. Honest gate: `not_configured` 503 names
`LOOM_ADF_NAME` / `LOOM_SUBSCRIPTION_ID` / `LOOM_DLZ_RG`; ARM 401/403 surfaced
verbatim. Data preview is an **honest config-gate** (needs an ADF debug session).

---

## Azure feature inventory → Loom coverage → backend

Legend: built ✅ · partial ⚠️ · honest-gate ⚠️ · MISSING ❌

### A. Data-flow lifecycle

| # | ADF Studio capability | Loom | Where / backend |
|---|---|---|---|
| A1 | List data flows in the factory | ✅ built | `GET /api/adf/dataflows` |
| A2 | Create a Mapping Data Flow | ✅ built | "New data flow" dialog → `POST /api/adf/dataflows` |
| A3 | Open / load a data flow into the designer | ✅ built | `GET …/[name]`; `definitionToModel` |
| A4 | Save the data flow (writes DFS to ADF) | ✅ built | Save → `PUT …/[name]` `modelToTypeProperties` |
| A5 | Delete a data flow | ✅ built | `DELETE …/[name]` |
| A6 | Unsaved (dirty) indicator + Refresh + Fit | ✅ built | topbar badges/buttons |
| A7 | Rename / clone data flow | ❌ MISSING | not surfaced |
| A8 | **Publish / Git** (live-mode only) | ❌ MISSING | direct PUT only; no Publish/Discard shell |

### B. Designer canvas

| # | ADF Studio capability | Loom | Where / backend |
|---|---|---|---|
| B1 | Visual graph of streams (nodes + arrows) | ✅ built | React Flow; auto-layout by depth |
| B2 | Per-kind node color + label | ✅ built | `KIND_COLOR`/`KIND_LABEL` bar |
| B3 | Drag nodes; positions persist per session | ✅ built | `onNodeDragStop` → `positions` ref |
| B4 | Mini-map, zoom/pan controls, Fit-to-view | ✅ built | `MiniMap` + `Controls` + `rf.fitView` |
| B5 | Click node → configuration pane | ✅ built | `setSelected` → config column |
| B6 | Transform **palette** (add by clicking) | ✅ built | palette tiles → `addTransform` (chains off selected) |
| B7 | Inline **+** between nodes / drag-to-connect new edges | ⚠️ partial | add chains off selected node; no free edge-drawing on the canvas |
| B8 | Node **search / optimize / inspect / data-preview tabs** per node | ❌ MISSING | single config pane only |

### C. Transformations (the transform library)

| # | ADF transform | Loom | Where / backend |
|---|---|---|---|
| C1 | **Source** (+ dataset picker) | ✅ built | source node; dataset dropdown from `/api/adf/datasets`; DFS `source(...)` |
| C2 | **Sink** (+ dataset picker) | ✅ built | sink node; dataset dropdown; DFS `sink(...)` |
| C3 | **Select** (column mappings) | ✅ built | mappings textarea → `select(mapColumn(...))` |
| C4 | **Filter** (expression) | ✅ built | condition textarea → `filter(expr)` |
| C5 | **Join** (right stream, join type, condition) | ✅ built | right-stream dropdown + joinType + condition → `join(...)` |
| C6 | **Aggregate** (groupBy + agg expressions) | ✅ built | groupBy + aggregates → `aggregate(groupBy(...), ...)` |
| C7 | **Derived column** (name = expression) | ✅ built | columns textarea → `derive(...)` |
| C8 | Rename output stream + delete transform | ✅ built | `renameStream` / `deleteStream` |
| C9 | **Expression builder** (Add-Dynamic-Content, functions, autocomplete) | ❌ MISSING | plain textareas; no visual expression builder |
| C10 | Source **options** (schema/projection/sampling/partitioning, inline vs dataset) | ❌ MISSING | dataset reference only |
| C11 | Sink **settings** (update method, mapping, error-row handling, partitioning) | ❌ MISSING | dataset reference only |
| C12 | Other transforms: Conditional split, Lookup, Exists, Union, Pivot/Unpivot, Window, Rank, Surrogate key, Flatten, Parse, Stringify, Alter row, Assert, Cast, External call, New branch | ❌ MISSING | 7 of ~25 transforms built |
| C13 | Per-transform **schema/projection (Inspect) + column metadata** | ❌ MISSING | not surfaced |

### D. Debug & data preview

| # | ADF Studio capability | Loom | Where / backend |
|---|---|---|---|
| D1 | Live **Data preview** per node | ⚠️ honest-gate | "Data preview" button → MessageBar naming `createDataFlowDebugSession` / `executeDataFlowDebugCommand` (debug helper not wired) |
| D2 | Debug-session toggle + cluster status | ❌ MISSING | not surfaced |
| D3 | Run/Trigger this data flow (via pipeline) | ⚠️ partial | runnable only by running a pipeline in the Pipelines tab; no inline run |

---

## Coverage tally

- **built ✅: 18**
- **partial ⚠️: 3**
- **honest-gate ⚠️: 1**
- **MISSING ❌: 8**

## Honest grade: **B−**

This is a real **visual Mapping Data Flow designer**, not a JSON textarea — it
directly cures the `ui-parity.md` "rich Azure surface → JSON" violation flagged in
`adf-data-factory.md`. It renders the three-pane ADF data-flow layout (transform
palette · React Flow graph · configuration pane), supports the seven core
transforms (source/select/filter/join/aggregate/derive/sink), and **round-trips
real Data Flow Script** to and from the ADF REST definition on open and Save.
**No vaporware** — Save writes the actual ADF data-flow; the data-preview limitation
is an honest, precisely-worded config-gate (allowed).

Held to **B−** (not A) by `ui-parity.md`'s completeness bar: only **7 of ADF's
~25 transformations** are built (no conditional split, lookup, union, pivot, window,
rank, flatten, parse, alter-row, etc.), there is **no visual expression builder**
(Add-Dynamic-Content), **no source/sink options/projection** depth, the canvas
**can't free-draw edges** (add chains off the selected node), and **live data
preview is gated** (the experience operators most associate with data flows). It's
a credible designer skeleton with the most-common transforms, short of the full
library.

## Highest-value gaps to build first

1. **Live data preview** (D1) — wire `createDataFlowDebugSession` +
   `executeDataFlowDebugCommand` into `lib/azure/adf-client.ts`; the gate text
   already names them.
2. **Expression builder** (C9) — Add-Dynamic-Content with the ADF function list.
3. **More transforms** (C12) — conditional split, lookup, union, pivot/unpivot,
   window first (highest-frequency).
4. **Source/sink options** (C10–C11) — projection, partitioning, sink update method.
5. **Free edge-drawing on the canvas** (B7).

## Backend per control

| Control | BFF route | ADF endpoint |
|---|---|---|
| List data flows | `GET /api/adf/dataflows` | `…/factories/{f}/dataflows` (list) |
| Create data flow | `POST /api/adf/dataflows` | data-flow create-or-update |
| Open data flow | `GET /api/adf/dataflows/[name]` | data-flow get |
| Save data flow | `PUT /api/adf/dataflows/[name]` | data-flow create-or-update (DFS) |
| Delete data flow | `DELETE /api/adf/dataflows/[name]` | data-flow delete |
| Source/sink dataset picker | `GET /api/adf/datasets` | datasets list |

## Bicep / env sync

- Env vars consumed: **`LOOM_ADF_NAME`**, **`LOOM_SUBSCRIPTION_ID`**,
  **`LOOM_DLZ_RG`** (the gate MessageBar names them). Bicep:
  `platform/fiab/bicep/modules/data/datafactory.bicep`.
- Role: Loom UAMI needs **Data Factory Contributor** on the default factory
  (ARM 401/403 surfaced verbatim).
- No new Cosmos container.

## Verification

- Per `no-vaporware.md`: list/create/save/delete hit real ADF REST; Save writes the
  actual DFS; the data-preview gap is an honest config-gate.
- Live `pnpm uat` side-by-side against ADF Studio's data-flow canvas: **pending**
  (no minted session / reachable factory in this worktree). MISSING/partial rows
  derived from code, not a live click-through; confirm against the live Studio per
  the no-scaffold rule.
