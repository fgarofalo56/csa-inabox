# Tutorial: Code report editor

> CSA Loom `code-report` editor — **BI-as-code**, built Loom-native (the
> Evidence.dev / Rill / Observable class of tool). The report *is* one Markdown
> document with fenced SQL blocks and inline `{visual}` directives: versionable,
> PR-reviewable, CI-testable, diff-able. Every query executes against a real
> Azure backend — **no Microsoft Fabric, no Power BI**.

## What it is

A drag-and-drop report is a binary blob you cannot review in a pull request. A
code report is a text document. You write prose in Markdown, name your queries
in fenced blocks, and place visuals inline with a directive. Loom parses the
document, executes every query block on the bound engine, and renders the whole
thing live in the preview pane.

Two kinds of query block, and the difference matters:

- ` ```sql <name> ` — a **raw read-only query** on the report's bound engine.
- ` ```sql loom <name> ` with `metric: <id>` — a **governed metric** resolved
  through Loom's metrics layer, so the number here is the same number every
  other surface shows. There is no second execute path.

## When to use it

- The report needs to live in git next to the code that produces its data.
- You want reviewers to see the *diff* of a metric change, not a screenshot.
- You want governed metrics and ad-hoc SQL in one document.
- For a drag-and-drop canvas experience, use the `report` or `dashboard` item
  instead.

## Step-by-step in Loom

1. **Create the item.** **+ New item → Code report**. The editor opens at
   `/items/code-report/<id>` as a single draggable **SplitPane** — source on the
   left, live preview on the right. The divider position is persisted.
2. **Pick a starting point.** A brand-new report shows a guided (never-red)
   empty state with two paths: **Start from an example** (inserts a starter with
   a governed-metric line chart and a raw-SQL table) or **Start blank**.
3. **Bind the engine.** The **Engine (raw sql blocks)** dropdown sets where raw
   `sql` blocks execute:
   - `Synapse serverless (T-SQL)`
   - `Lakehouse (serverless T-SQL over Delta)`
   - `Azure Data Explorer (KQL)`

   Governed `sql loom` metric blocks always resolve through the metrics layer
   regardless of this setting.
4. **Write the document.** Markdown for prose, then:
   ````markdown
   ```sql loom revenue_by_month
   metric: revenue
   dimensions: order_month
   grain: month
   ```

   {line query=revenue_by_month x=order_month y=revenue title="Revenue by month"}

   ```sql top_products
   SELECT product_name, SUM(amount) AS revenue
   FROM analytics.sales
   GROUP BY product_name
   ORDER BY revenue DESC
   ```

   {table query=top_products}
   ````
   The header **Learn** popover lists the full directive syntax:
   `{table query=…}`, `{bar|line|area query=… x=… y=…}`, and
   `{bignumber query=… value=…}` for a KPI.
5. **Run it.** **Run** in the ribbon saves the source + engine binding
   (`PUT …/content`) and then executes (`POST …/render`). Every query block runs
   against the real backend; the preview renders prose through the Markdown
   renderer and each `{visual}` as a real table, chart, or KPI from the actual
   response rows. Per-query status shows the engine, dialect, row count,
   execution time, and whether the result was cached.
6. **Iterate.** **Save** persists without running. A report with saved content
   auto-renders once on open, so returning to it shows live data immediately.

## The Azure backend it rides on

- **Raw `sql` blocks:** **Synapse serverless SQL** (T-SQL, including over Delta
  for the lakehouse binding) or **Azure Data Explorer** (KQL), executed
  read-only-guarded.
- **`sql loom` metric blocks:** Loom's **governed metrics layer** — the single
  one-metric-one-number execute path.
- **Persistence:** the item's own state (source + engine binding).
- **Auth:** the render route is owner/tenant-scoped; no-access returns 404, not
  403, so item existence is not leaked.
- **Audit:** every render writes an `_auditLog` row **and** fans out through the
  audit event stream (SIEM / webhooks), emitted synchronously first.

## Honest gates

| Condition | What you see | Exact remediation |
|---|---|---|
| A query's backend is not configured | That **single query** degrades to an honest per-query gate in the preview; the rest of the report still renders | Configure the named backend (Synapse serverless / ADX) for that engine binding |
| Source has a syntax error | The render returns a parse error (HTTP 400) and the editor shows it verbatim | Fix the fenced block or directive named in the message |
| `n16-code-report` flag off | The render route returns a guided 503 gate | Re-enable the flag in **Admin → Runtime flags** |

## No Fabric required

Synapse serverless + ADX + the Loom metrics layer, all in-boundary (both are
Gov-GA services). No Fabric capacity, workspace, OneLake path, or Power BI
workspace is used on this path.

## Learn more

- Semantic model / metrics layer: `editor-semantic-model.md`
- Report editor tutorial (drag-and-drop): `editor-report.md`
- Parity source: `docs/fiab/parity/code-report.md`
- Evidence.dev query concepts (syntax lineage):
  <https://docs.evidence.dev/core-concepts/queries/>
