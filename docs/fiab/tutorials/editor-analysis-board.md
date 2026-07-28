# Tutorial: Analysis board editor

> CSA Loom `analysis-board` editor — a **point-and-click analysis pipeline** over
> Azure Data Explorer (the Loom equivalent of Palantir Foundry **Contour**). A
> board is a data **source** plus an ordered list of typed **steps**; Loom
> compiles it to real KQL, shows you the compiled query, and runs it against ADX.
> Azure-native — **no Microsoft Fabric**.

## What it is

Each step in a board maps to exactly **one KQL pipe operator**. You never write
the query, but you can always read it — the compiled KQL is displayed live and
updates as you edit. Identifiers are validated and values escaped, so the
compiler either produces a safe query or returns a precise error and refuses to
emit anything.

## When to use it

- An analyst needs to explore an ADX table without learning KQL.
- You want a *reproducible, editable* analysis rather than a one-off query
  someone pasted into a chat.
- You want to see the KQL a point-and-click analysis produces, in order to learn
  it or to lift it into a queryset.

## Step-by-step in Loom

1. **Create the item.** **+ New item → Analysis board**. The header carries a
   `Contour-parity` badge, plus **Save** and **Run**.
2. **Pick the source.** In **Source**, choose a **Kind**:
   - **Table** — an ADX table name (for example `Events`).
   - **Base query** — a KQL expression the steps append onto (for example
     `Events | where Timestamp > ago(1d)`).
3. **Add steps.** Pick a step from **Add step** and click **Add**. Seven types:

   | Step | Fields | Compiles to |
   |---|---|---|
   | **Filter rows** | column, operator, value | `where` |
   | **Select columns** | comma-separated columns | `project` |
   | **Derive column** | new column name, arithmetic expression | `extend` |
   | **Aggregate** | group by, function, column, alias | `summarize` |
   | **Sort** | column, `asc` / `desc` | `order by` |
   | **Limit** | row count | `take` |
   | **Distinct** | comma-separated columns | `distinct` |

   Filter operators: `==`, `!=`, `>`, `>=`, `<`, `<=`, `contains`, `startswith`,
   `in` (comma-separated values). Aggregate functions: `count`, `sum`, `avg`,
   `min`, `max`, `dcount`.
4. **Reorder or remove.** Each step card has move-up / move-down / remove
   buttons — the order *is* the pipeline order.
5. **Read the compiled KQL.** The **Compiled KQL** card shows the live query. A
   freshly created, untouched board shows a guided hint (*"Pick a source table
   (or base query) above"*) rather than a red error; validation errors appear
   only once you have started editing, and each names the failing step precisely.
6. **Run it.** **Run** executes the compiled query against Azure Data Explorer
   and shows the results grid (first 200 rows) plus a success message with the
   row count and elapsed milliseconds. If the board does not compile, the run is
   refused client-side with the compiler's error — no partial query is ever sent.
7. **Save.** **Save** persists the board (source + steps) to the item's state so
   the analysis is reproducible.

## The Azure backend it rides on

- **Engine:** **Azure Data Explorer**, through Loom's Kusto client.
- **Compiler:** the board-to-KQL compiler runs client-side for the live preview
  and server-side for execution — one model, one query.
- **Routes:** `POST /api/items/analysis-board/<id>/run`,
  `PATCH /api/items/analysis-board/<id>` for state.

## Honest gates

| Condition | What you see | Exact remediation |
|---|---|---|
| ADX not configured | A warning MessageBar titled *"ADX not configured"* carrying the gate's own remediation text (HTTP 503 from the run route) | Apply the remediation the gate names — set the ADX cluster variable on the console env |
| Board does not compile | The compiler's precise per-step error; **Run** refuses to send anything | Fix the step the error names |
| Fresh, untouched board | A guided hint, not a red error | Pick a source table or base query |

## No Fabric required

Azure Data Explorer only. No Fabric capacity, workspace, OneLake path, or Power
BI workspace is used on any path.

## Learn more

- KQL queryset editor tutorial: `editor-kql-queryset.md`
- KQL database editor tutorial: `editor-kql-database.md`
- Notepad editor tutorial (narrative + live KQL): `editor-notepad.md`
- Kusto query language:
  <https://learn.microsoft.com/azure/data-explorer/kusto/query/>
