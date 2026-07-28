# Tutorial: Mapping data flow editor

> CSA Loom `mapping-dataflow` editor — visually design a **Spark-executed**
> data flow (Source → transformations → Sink) as a real
> `Microsoft.DataFactory/factories/dataflows` resource. **No Microsoft Fabric
> required.**

## What it is

A Mapping data flow is a visually-designed, Spark-executed data transformation.
You draw a graph of Source → transformation → Sink nodes on a canvas and Azure
Data Factory / Synapse compiles it to a Data Flow Script that runs on a
scaled-out Spark cluster (an integration runtime with data-flow compute) — no
hand-written Spark code. It is DISTINCT from Dataflow Gen2 (Power Query / M) —
same goal, different engine and authoring model.

## When to use it

- You need scaled-out transformations (joins, aggregates, pivots, windows)
  without writing Spark.
- Your pipeline should invoke the transformation as a governed activity
  (**Execute data flow**) with monitoring.

## Step-by-step in Loom

1. **Create the item.** Choose **+ New item → Mapping data flow** (Data
   Factory). The editor opens at `/items/mapping-dataflow/<id>`.
2. **Add a source.** Drop a **Source** node and bind a dataset (the reusable
   connector object). Sources can allow schema drift and validate the projected
   schema.
3. **Add transformations.** Use the **＋** on a stream to add transformations —
   Select, Derived column, Filter, Join, Aggregate, Pivot, Window, Conditional
   split, and more. Each opens a structured settings panel; column logic uses
   the data-flow expression language (Spark column DSL).
4. **Add a sink.** Terminate each branch in a **Sink** node bound to a
   destination dataset, with insert/update/upsert/delete row policies and key
   columns.
5. **Debug + run.** Flip the **Data flow debug** switch in the **Debug** panel
   under the canvas to hold a debug session, then preview / inspect / profile
   any transform (see below). Run the flow in production from a pipeline's
   **Execute data flow** activity.

## Debug mode — the panel under the canvas

The **Debug** panel sits below the designer. Its header carries the session
chip (state + remaining TTL), the integration runtime the session runs on, and
the **Data flow debug** switch. Turning the switch on acquires ONE held debug
session for the whole authoring loop; turning it off (or leaving the editor)
releases it, so every tab below runs against the same warm session instead of
paying for a cold cluster per click.

Under the switch is a three-tab strip plus shared run controls — a
**Transform** picker (every named source / transformation / sink in the flow)
and, for the row-producing tabs, a **Sample rows** box (default 100, capped at
1000, matching ADF Studio). The run button relabels itself per tab:

| Tab | Button | What you get |
|---|---|---|
| **Data preview** | Preview | The selected transform's output rows in the shared type-badged grid, with search and a timing status bar. Reflects **unsaved** in-canvas edits — the route re-serializes the live graph before each preview. |
| **Inspect** | Inspect | Side-by-side input and output column lists for the selected transform, plus schema-drift badges: `+ col (type)` added, `− col (type)` removed, `col: oldType → newType` retyped. No drift renders "No schema drift". |
| **Statistics** | Profile | A per-column profile card over the sample: nulls (count + %), distinct, and — for numeric columns — min / max / mean / std dev, with a top-values bar chart. The caption states the actual row count profiled vs the sample requested. |

### Quick-actions from the preview grid

Every column header in the **Data preview** grid has a `⋯` menu:

- **Typecast to…** → `string`, `integer`, `long`, `double`, `boolean`, `date`,
  `timestamp` — inserts a Cast transform.
- **Modify (Derived Column)** — inserts a Derived Column transform seeded with
  that column.
- **Remove column** — inserts a Select transform that drops it.

Each inserts the generated transform into the designer graph immediately after
the previewed stream. The insert is a **draft** — the published data flow is
untouched until you **Save**.

### When Debug can't start

Debug needs a data-flow-capable Azure integration runtime. Without one the
panel renders a warning MessageBar ("Debug session not available") naming the
requirement, and authoring keeps working — the editor still writes the real ADF
data-flow definition; only preview / inspect / stats stay dark. Rows are never
fabricated to fill the grid.

On a brand-new, unsaved flow the panel tells you to save first: a debug session
needs a published flow with bound datasets.

### Kill-switch

The panel is behind the default-ON runtime flag `u7-dataflow-debug`
(Admin → Runtime flags). Turning it OFF reverts the editor to the pre-U7
single-stream inline preview on the next load. The ADF debug session, the
factory, and the authoring path are unaffected either way.

## The Azure backend it rides on

- **Resource:** `Microsoft.DataFactory/factories/dataflows`
  (`type: MappingDataFlow`) on the deployment-default factory.
- **Compute:** an Azure integration runtime with data-flow (Spark) compute.
- **Debug:** a real ADF data-flow debug session —
  `createDataFlowDebugSession` → `addDataFlowToDebugSession` →
  `executeDataFlowDebugCommand` — so a preview executes the SAME Data Flow
  Script the production run executes. One compiler, two entry points.
- **Routes:** `POST /api/items/mapping-dataflow/<id>/debug/session`
  (acquire/release), `.../debug/preview`, `.../debug/schema`, `.../debug/stats`.
- **Orchestration:** pipeline **Execute data flow** activity.

## No Fabric required

The flow compiles and runs on ADF / Synapse Spark; no Fabric capacity,
workspace, or OneLake is involved.

## Learn more

- Mapping data flows overview:
  <https://learn.microsoft.com/azure/data-factory/concepts-data-flow-overview>
