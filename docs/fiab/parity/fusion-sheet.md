# fusion-sheet — Loom-native surface (no Azure or Fabric analog)

**Source UI: NONE.** `fusion-sheet` is a Loom-native item type: an A1-addressed
spreadsheet grid whose cells hold literals or `=formulas`, evaluated by a pure
in-repo engine. It was built as Loom's answer to Palantir Foundry's Fusion
(Foundry-parity row 3.4) — **not** a Microsoft product. There is no Azure portal
blade and no Microsoft Fabric item type that this is a one-for-one twin of:

- Excel / Excel for the web is a Microsoft product, but it is **M365, not Azure**,
  and grading a 20×10 in-console grid against the full Excel surface would
  produce a parity table with ~200 ❌ rows that tells no one anything useful. It
  is also not what this item claims to be.
- Fabric has **no** spreadsheet item type. The nearest Fabric surfaces
  (Dataflow Gen2's Power Query grid, the Warehouse query grid) are *data
  transformation* surfaces, not formula sheets, and both already have their own
  Loom twins with their own parity docs (`dataflow`, `warehouse`).

Per `ui-parity.md` inventing a source UI would be fiction. Per `ux-baseline.md`
("apply the same baseline to **all** Loom UXs"), this document grades the
surface against the **`docs/fiab/ux-standards.md` §7 checklist**.

**Surface files:**
- `apps/fiab-console/lib/editors/phase4/fusion-sheet-editor.tsx` (119 lines)
- `apps/fiab-console/lib/editors/fusion-sheet-engine.ts` (the pure evaluator)

**Route:** `/items/fusion-sheet/[id]` · Tagged **Preview** in the catalog.

---

## What the engine genuinely supports (the real capability floor)

Read from `fusion-sheet-engine.ts` and its existing spec
(`lib/editors/__tests__/fusion-sheet-engine.test.ts`):

| Capability | Status |
|---|---|
| Literal cells (number / text) | ✅ |
| `=` formulas | ✅ |
| Functions: `SUM`, `AVG`, `MIN`, `MAX`, `COUNT`, `IF`, `ROUND`, `ABS`, `CONCAT` | ✅ (9) |
| Cell references (`A1`) and ranges (`A1:B3`) | ✅ |
| Arithmetic operators | ✅ |
| Cycle detection | ✅ (`#CYCLE!`) |
| Excel-style error values | ✅ |
| Recalculation on every edit | ✅ (pure `useMemo` over the cell map) |

This is a genuine, tested formula engine — the surface is **not** vaporware.
The gaps below are UI/chrome gaps, not a fake backend.

## Grade against the ux-baseline §7 checklist

| # | Baseline bar item | Status | Evidence / gap |
|---|---|---|---|
| U1 | Fluent v9 + Loom tokens, no hard-coded px/hex | ⚠️ | Almost: every color/radius/spacing is a token, but `minWidth: '72px'` is hard-coded on `s.th`/`s.td` and `minHeight: '20px'` on `s.cellShown`. `web3-ui.md` forbids raw px "where a token exists" — grid-cell sizing is arguably a genuine layout constant, so this is ⚠️ not ❌. |
| U2 | Real backend on every control | ✅ | Load `GET /api/cosmos-items/fusion-sheet/:id`; save `PATCH /api/items/fusion-sheet/:id`. Evaluation is intentionally client-side and pure — correct for a formula engine. No mocks. |
| U3 | Honest gate when infra missing | n/a | No infra dependency — Cosmos only, which is always present. |
| U4 | Guided `EmptyState` | n/a | A blank grid IS the empty state for a spreadsheet; a launcher card would be wrong here. |
| U5 | Skeleton / spinner on load | ❌ | No loading state. The `GET` at `:40-49` populates cells on success. |
| U6 | Error surface is honest | ❌ | `catch { /* keep empty */ }` — a failed or forbidden load renders as an **empty sheet**, indistinguishable from a genuinely empty one. Same `unknown-reported-as-negative` class as `notepad`. Worse here: a user could start typing into what looks like a fresh sheet and then Save, **overwriting real persisted cells with an empty map**. This is the most consequential defect on the surface. |
| U7 | LearnPopover / teaching guidance | ⚠️ | A `<Body1>` line documents the formula syntax inline (`:82`) — genuinely useful and better than nothing — but there is no `LearnPopover` and no `TeachingBanner`. |
| E1 | `ItemEditorChrome` shell | ❌ | **Not used.** Bare `<div>`. No ribbon, no item-tab strip, no right details panel, no Copilot entry, no command-palette registration. |
| E2 | Ribbon + contextual groups | ❌ | Consequence of E1. Save is a loose `<Button>`. |
| E3 | SC-9 command search | ❌ | Consequence of E1. |
| E4 | SC-2 right details panel | ❌ | Consequence of E1. A sheet has obvious details to show (cell count, error count, last saved) and shows none. |
| E5 | Per-surface Copilot | ❌ | Consequence of E1. A formula surface is a natural Copilot target ("write me a formula that…") and has no entry. |
| E6 | Explicit dirty state / unsaved warning | ❌ | Editing mutates `cells`; nothing indicates unsaved changes. Combined with U6 this is how data loss happens. |
| E7 | Undo/redo | ❌ | None. `ux-baseline.md` makes undo/redo a *mandatory canvas standard* and states Loom's richer bar "becomes the standard and every canvas carries it". A grid editor is the archetypal undo surface; a mistyped formula over a populated cell is unrecoverable. |
| E8 | G3 resizable pane (`SplitPane` + `sizingKey`) | ❌ | Fixed 20×10 grid in a fixed wrapper. No `SplitPane`, no `sizingKey`. |
| E9 | Keyboard navigation | ❌ | Only `Enter` (commit) and `Escape` (cancel) are handled (`:102`). There is **no arrow-key cell navigation, no Tab-to-next-cell, no type-to-edit** — a user must physically click every cell. For a spreadsheet this is the defining interaction and it is absent. `ux-baseline.md` requires keyboard a11y. |
| E10 | Grid is resizable / scalable | ❌ | `ROWS = 20`, `COLS = 10` are **module constants** (`:18-19`). There is no add-row, add-column, or scroll-to-extend. A sheet needing 21 rows cannot be built. Formulas may reference cells outside the rendered window, but the user cannot see or edit them. |
| E11 | Clean first-open | ✅ | A new sheet renders an empty grid — no error banner. |
| E12 | Badge rows wrap | ✅ | `s.bar` sets `flexWrap: 'wrap'`. |
| E13 | Select/copy/paste a range | ❌ | No selection model at all — one cell is "editing" or none is. No multi-cell select, no copy/paste, no fill-down. |
| E14 | Preview tagged in catalog | ✅ | `Badge appearance="tint" color="brand">Preview` on the surface and `preview: true` in the catalog — `no-vaporware.md` "allowed with disclosure" is satisfied. |

**Totals: 4 ✅ · 3 ⚠️ · 12 ❌ · 2 n/a (21 rows).**

## Backend per control

| Control | Call | Real backend |
|---|---|---|
| Initial load | `GET /api/cosmos-items/fusion-sheet/:id` | Cosmos DB item state |
| **Save** | `PATCH /api/items/fusion-sheet/:id` body `{state:{cells}}` | Cosmos DB |
| Cell edit / formula evaluation | `evaluateSheet()` — pure, in-process | — (by design) |

No Azure data-plane call is needed or made. No Fabric host is contacted.

## Verdict

**Not A-grade — and this is the weakest of the fourteen surfaces in this batch.**
The formula engine is real and tested; the *editor around it* is a prototype.
Ranked by user impact:

1. **U6 — the silent-load-failure → save-over-real-data path.** A read failure
   is rendered as an empty sheet, and Save then persists that emptiness. This is
   a correctness bug, not a polish gap, and should be fixed first regardless of
   lane priority.
2. **E9 — no keyboard navigation.** For a spreadsheet this is not a nice-to-have.
3. **E7 — no undo.** Paired with E9 (click-only editing) it makes the surface
   hostile to real use.
4. **E10 — hard-coded 20×10.** Caps the surface's usefulness at toy size.
5. **E1** — closing it resolves E2-E5 together.

## Verification

- **V3 (in-browser click-walk): OWED.** `loom-ui-verify` red since 2026-08-04
  (FINISHLINE C13); Actions degraded. When recovered:
  ```bash
  gh workflow run loom-ui-verify.yml --ref main -f target_route=/items/fusion-sheet/<id>
  ```
  The walk must specifically attempt: arrow-key navigation (expected to fail),
  undo after a bad edit (expected to fail), and a load against a Cosmos read
  that 500s (expected to render an empty grid — the U6 defect).
- Grades read from source; static evidence only, not a functional grade.
