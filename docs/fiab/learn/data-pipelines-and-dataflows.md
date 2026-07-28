# Data pipelines & Mapping Data Flow

Loom's data-integration surface is one-for-one with Azure Data Factory / Fabric
Data Factory: a **pipeline** is a visual DAG of activities (Copy data,
Notebook, Mapping data flow, Dataflow Gen2, control flow) on a drag-and-drop
canvas, and the two transformation item types — **Dataflow Gen2** (Power Query
/ M) and **Mapping data flow** (a Spark-executed transform graph) — are
authored separately and invoked from a pipeline activity. This guide walks the
real Loom pipeline editor.

## When to use which

| Tool | Use when |
|---|---|
| **Copy job** | Pure source → sink bulk movement, no transforms. The simplest, fault-tolerant loader. |
| **Data pipeline** | Orchestration: chain Copy data, Notebook, Mapping data flow / Dataflow Gen2, and control-flow activities with dependencies, parameters, and triggers. |
| **Dataflow Gen2** | Visual, code-free transformation authored in the Power Query Editor (M expressions). |
| **Mapping data flow** | Scaled-out transformation (joins, derived columns, aggregates, pivots, windows) drawn as a Source → transform → Sink graph and executed on Spark. |

Rule of thumb: orchestrate with a **pipeline**, transform with a **dataflow**,
move raw bytes with a **copy job**.

## The pipeline editor

Open a pipeline item at `/items/data-pipeline/<id>`. You get the ADF-Studio-style
canvas (React Flow + Bezier edges) with an **Activities** palette on the left,
the **canvas** in the centre, and a **properties** panel on the right. Above the
canvas, a tab strip switches between **Pipeline · Parameters · Variables ·
Settings · Output**. The ribbon's **Home** tab carries the item actions (New
pipeline, Save, Refresh, Discard), **Validate**, **Manage** (Linked services,
Datasets), **Run** (Publish, Run, Debug), **Schedule** (Schedule, Add trigger),
Delete, and Import/Export; a **View** tab holds grid and zoom controls, and an
**Output** tab pins the output pane, opens the Output tab, or shows the
in-canvas output dock.

### Step-by-step: ingest → transform → schedule

1. **Add a Copy data activity.** Drag *Copy data* onto the canvas. In its
   properties set the **Source** (one of 300+ connectors) and the **Sink**
   (your lakehouse `Tables/` or `Files/` path).
2. **Add a Notebook activity** for a PySpark transform. Drag *Notebook*, then
   bind it to an existing notebook item. Wire the **green success edge** from
   Copy data → Notebook so the transform runs only after ingest succeeds.
3. **Add a transform activity** (optional) to do a code-free transform instead
   of, or alongside, the notebook. The palette's **Move & transform** group has
   *Mapping data flow* (runs a published mapping data flow on an integration
   runtime) and *Dataflow Gen2* (runs a Power Query / M wrangling dataflow).
4. **Validate.** Click **Validate** — the editor checks every activity's
   bindings and surfaces errors inline before you run.
5. **Debug.** Click **Home → Run → Debug** to dispatch a debug run. Loom
   publishes the pipeline to ADF first if it has no backing yet, then keeps you
   on the canvas: each activity node paints its live run status, a run strip
   shows overall progress (with **Rerun from failed** on a failed run), the
   eyeglass on a node opens that activity's input / output / error JSON, and the
   resizable **Output dock** opens under the graph.
6. **Run.** Click **Run** to queue a real trigger run; the editor switches to the
   **Output** tab, whose Monitor and Debug tables read the live
   `queryPipelineRuns` / `queryActivityRuns` history. The Monitor table columns
   are Run ID, Status, Invoked by, Start, End, Duration, Message; expanding a
   run shows its activities (Activity, Type, Status, Duration, Output / error
   peek).
7. **Schedule.** Use **Schedule → Schedule** (or **Add trigger**) to attach a
   schedule, tumbling-window, or event-based trigger so the pipeline runs
   automatically.

## Dataflow Gen2 vs Mapping data flow

These are two **different item types**, not two names for one thing:

- **Dataflow Gen2** (`/items/dataflow/<id>`) — Power Query / M authoring. Reads
  from any of the 300+ connectors, transforms in the Power Query Editor, and
  writes to a lakehouse, warehouse, or SQL database as its **data destination**.
- **Mapping data flow** (`/items/mapping-dataflow/<id>`) — a Spark-executed
  graph of Source → transformation → Sink nodes, compiled to a Data Flow Script
  and run on an integration runtime with data-flow compute. It is a real
  `Microsoft.DataFactory/factories/dataflows` resource.

Both are authored as their own item and invoked from a pipeline activity — the
palette's **Move & transform** group carries **Dataflow Gen2** (activity type
`ExecuteWranglingDataflow`) and **Mapping data flow** (activity type
`ExecuteDataFlow`) — so they can be scheduled. Use either for the conform/clean
step from Bronze → Silver where you want the transform visual and reusable
rather than buried in notebook code.

The mapping-data-flow editor has a **Debug** panel under the canvas. Flip
**Data flow debug** on to hold one real ADF debug session for the whole
authoring loop, then per transform: **Data preview** (typed sample rows,
reflecting unsaved canvas edits), **Inspect** (in/out schema with schema-drift
badges), and **Statistics** (nulls, distinct, min/max/mean/std-dev plus a
top-values chart). A column's `⋯` menu in the preview grid inserts a
Typecast / Derived-Column / Select transform into the graph as a draft. Full
walkthrough: `docs/fiab/tutorials/editor-mapping-dataflow.md`.

## Honest infra gate

If the Synapse / ADF integration runtime or a linked service isn't wired, the
activity's properties panel shows a `MessageBar` naming the exact linked-service
or runtime to provision — the canvas and palette still render in full.

## Learn more

- **MS Learn — [Pipelines and activities (Azure Data Factory)](https://learn.microsoft.com/azure/data-factory/concepts-pipelines-activities)** — ADF/Synapse is the default backend Loom pipelines run on.
- MS Learn — [Mapping data flows (ADF)](https://learn.microsoft.com/azure/data-factory/concepts-data-flow-overview)
- MS Learn — [Power Query M / wrangling data flows (ADF)](https://learn.microsoft.com/azure/data-factory/wrangling-overview)
- Parity reference only — [What is Data Factory in Microsoft Fabric?](https://learn.microsoft.com/fabric/data-factory/data-factory-overview) and [Dataflow Gen2 overview](https://learn.microsoft.com/fabric/data-factory/dataflows-gen2-overview). Loom needs no Fabric capacity or workspace; these describe the surface Loom is one-for-one with.
- Loom editor guides — [Data pipeline](../tutorials/editor-data-pipeline.md) · [Dataflow](../tutorials/editor-dataflow.md) · [Copy job](../tutorials/editor-copy-job.md)
