# Tutorial: Fusion sheet editor

> CSA Loom `fusion-sheet` editor — **Preview**. An A1-addressed spreadsheet grid
> whose cells hold literals or `=formulas`, evaluated live by Loom's own pure
> formula engine. Azure-native — **no Microsoft Fabric**.

## What it is

Sometimes an analysis is a spreadsheet, not a query. A fusion sheet is a
20-row × 10-column grid (`A1` through `J20`) addressed the way every analyst
already expects. Cells hold either a literal value or a formula starting with
`=`. The engine evaluates the whole sheet on every edit, resolves cell and range
references, detects circular references, and reports Excel-style errors.

## When to use it

- A small model, ratio table, or hand calculation that belongs next to your data
  items rather than in an emailed workbook.
- A scratch pad for arithmetic during an investigation, saved with the workspace.
- For anything that needs to query a backend, use an **Analysis board**,
  **SQL Lab**, or a **Notepad** query block instead — the fusion sheet engine is
  a pure calculator over its own cells.

## Step-by-step in Loom

1. **Create the item.** **+ New item → Fusion sheet**. The editor opens with a
   **Preview** badge and an empty grid with column headers `A`–`J` and row
   headers `1`–`20`.
2. **Enter values.** Click a cell to edit it. Type a literal, or start with `=`
   for a formula. **Enter** commits, **Escape** cancels, and clicking away also
   commits. Clearing a cell removes it from the sheet.
3. **Write formulas.** The engine supports:

   | Function | Purpose |
   |---|---|
   | `SUM` | Total of cells or ranges |
   | `AVG` (or `AVERAGE`) | Mean |
   | `MIN` / `MAX` | Extremes |
   | `COUNT` | Count of numeric values |
   | `IF` | Conditional |
   | `ROUND` | Rounding (optional decimal places) |
   | `ABS` | Absolute value |
   | `CONCAT` | String join |

   References may be single cells (`B2`) or ranges (`A1:B3`), for example
   `=SUM(A1:A10)` or `=IF(B2>100, "over", "under")`. Arithmetic operators
   `+ - * / ^`, comparison operators `= <> < > <= >=`, and parentheses are
   supported.
4. **Read the results.** Each cell displays its **evaluated** value; hovering
   shows the underlying literal or formula as a tooltip. Cells that fail
   evaluation render in red with an Excel-style error value: `#REF!`, `#DIV/0!`,
   `#VALUE!`, `#CYCLE!` (circular reference), `#NAME?` (unknown function), or
   `#ERROR!`.
5. **Save.** **Save** persists the cell map to the item's state; a caption
   confirms *Saved.* or *Save failed.* honestly.

## The backend it rides on

- **Evaluation:** Loom's **pure** `fusion-sheet-engine` — it runs in the browser
  over the sheet's own cells. There is no external calculation service and no
  data-plane call.
- **Persistence:** `PATCH /api/items/fusion-sheet/<id>` writes `state.cells`;
  the editor loads it back from the item store on open.

## Honest gates

There is no infrastructure gate on this surface — the engine is pure and the
only backend call is the item-state save. A failed save reports *"Save failed."*
rather than silently discarding your work.

## Limits (stated honestly)

- Fixed **20 rows × 10 columns** (`A1`–`J20`).
- The function set above; no external data references, no charts, no formatting.
- Tagged **Preview**.

## No Fabric required

Pure client-side evaluation plus the item store. No Fabric capacity, workspace,
OneLake path, or Power BI workspace is involved.

## Learn more

- Analysis board editor tutorial: `editor-analysis-board.md`
- Notepad editor tutorial: `editor-notepad.md`
