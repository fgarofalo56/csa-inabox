# Tutorial: Notepad editor

> CSA Loom `notepad` editor — a **live-data document**. An ordered list of blocks
> (heading, text, or **KQL query**) where the query blocks run inline against
> Azure Data Explorer and render a live results grid, so narrative and data sit
> together in one artifact. Azure-native — **no Microsoft Fabric**.

## What it is

A regular document goes stale the moment you paste a number into it. A notepad
does not: the numbers are query blocks, and re-running them re-reads the live
data. Use it to write the *reasoning* around an investigation with the evidence
attached and reproducible.

Three block types:

| Block | What it is |
|---|---|
| **Heading** | A section title, rendered as a heading beneath its input |
| **Text** | Free narrative prose |
| **KQL query** | A Kusto query with a **Run** button and its own results grid |

## When to use it

- An incident write-up, investigation log, or analysis narrative where the
  supporting numbers must stay live.
- A shift-handover or runbook page whose checks anyone can re-run in place.
- For a point-and-click pipeline over one table, use an **Analysis board**; for a
  BI document with charts and governed metrics, use a **Code report**.

## Step-by-step in Loom

1. **Create the item.** **+ New item → Notepad**. The header shows a `Live-data
   document` badge and an empty state: *"No blocks yet — add a heading, text, or
   KQL query block."*
2. **Add a block.** Choose **Heading**, **Text**, or **KQL query** in the **Add
   block** dropdown and click **Add**. The new block appends to the end.
3. **Write.** Headings use a single-line input and render as a section title
   below it. Text blocks use a resizable textarea. Query blocks use a
   monospaced textarea, for example:
   ```kusto
   Events | summarize count() by bin(Timestamp, 1h)
   ```
4. **Run a query block.** Each query block has its own **Run** button. Loom
   executes it against Azure Data Explorer and renders a results grid directly
   beneath the block with a caption reading `<n> row(s) · <n> ms`. The grid shows
   the first 100 rows. Only one block runs at a time — the others' Run buttons
   disable while one is executing.
5. **Reorder and prune.** Every block header carries move-up, move-down, and
   remove buttons, so the document's order is entirely yours.
6. **Save.** **Save** persists the whole block list to the item's state; a
   MessageBar confirms *Saved.* or reports the failure honestly.

## The Azure backend it rides on

- **Query execution:** **Azure Data Explorer**, via
  `POST /api/items/notepad/<id>/run-block`.
- **Persistence:** `PATCH /api/items/notepad/<id>` writes `state.blocks`; the
  editor reads it back from the item store on open.

## Honest gates

| Condition | What you see | Exact remediation |
|---|---|---|
| ADX not configured | A warning MessageBar carrying the run route's own gate remediation text appended to the error | Apply the remediation the gate names — set the ADX cluster variable on the console env |
| Query fails | The error message from ADX, shown verbatim | Fix the KQL |
| Save fails | *"Save failed."* rather than a silent discard | Retry; check session / connectivity |

## No Fabric required

Azure Data Explorer only. No Fabric capacity, workspace, OneLake path, or Power
BI workspace is used on any path.

## Learn more

- Analysis board editor tutorial: `editor-analysis-board.md`
- KQL queryset editor tutorial: `editor-kql-queryset.md`
- Code report editor tutorial: `editor-code-report.md`
- Kusto query language:
  <https://learn.microsoft.com/azure/data-explorer/kusto/query/>
