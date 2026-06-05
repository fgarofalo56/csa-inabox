# Data pipelines & Mapping Data Flow

Loom's data-integration surface is one-for-one with Azure Data Factory / Fabric
Data Factory: a **pipeline** is a visual DAG of activities (Copy data,
Notebook, Dataflow, control flow) on a drag-and-drop canvas, and a **Dataflow
Gen2** is a Power Query / Mapping-Data-Flow transformation you wire as a source
or an activity. This guide walks the real Loom pipeline editor.

## When to use which

| Tool | Use when |
|---|---|
| **Copy job** | Pure source → sink bulk movement, no transforms. The simplest, fault-tolerant loader. |
| **Data pipeline** | Orchestration: chain Copy, Notebook, Dataflow, and control-flow activities with dependencies, parameters, and triggers. |
| **Dataflow Gen2 / Mapping Data Flow** | Visual, code-free transformation (joins, derived columns, aggregates, pivots) authored in the Power Query Editor / data-flow canvas. |

Rule of thumb: orchestrate with a **pipeline**, transform with a **dataflow**,
move raw bytes with a **copy job**.

## The pipeline editor

Open a pipeline item at `/items/data-pipeline/<id>`. You get the ADF-Studio-style
canvas (React Flow + Bezier edges) with an **Activities** palette on the left,
the **canvas** in the centre, and a **properties** panel on the right. The
toolbar exposes **Validate**, **Run**, and **Trigger**.

### Step-by-step: ingest → transform → schedule

1. **Add a Copy data activity.** Drag *Copy data* onto the canvas. In its
   properties set the **Source** (one of 300+ connectors) and the **Sink**
   (your lakehouse `Tables/` or `Files/` path).
2. **Add a Notebook activity** for a PySpark transform. Drag *Notebook*, then
   bind it to an existing notebook item. Wire the **green success edge** from
   Copy data → Notebook so the transform runs only after ingest succeeds.
3. **Add a Dataflow activity** (optional) to do a code-free Mapping Data Flow
   transform instead of, or alongside, the notebook.
4. **Validate.** Click **Validate** — the editor checks every activity's
   bindings and surfaces errors inline before you run.
5. **Run.** Click **Run** to execute on demand. The run streams into the
   **Run history** panel with per-activity status, duration, and rows copied.
6. **Trigger.** Click **Trigger** to attach a schedule, tumbling-window, or
   event-based trigger so the pipeline runs automatically.

## Mapping Data Flow / Dataflow Gen2

A Dataflow Gen2 reads from any of the 300+ connectors, transforms with the
Power Query Editor (M expressions), and writes to a lakehouse, warehouse, or
SQL database as its **data destination**. Author it as its own item, then
reference it from a pipeline's **Dataflow** activity to schedule it. Use
dataflows for the conform/clean step from Bronze → Silver where you want the
transform visual and reusable rather than buried in notebook code.

## Honest infra gate

If the Synapse / ADF integration runtime or a linked service isn't wired, the
activity's properties panel shows a `MessageBar` naming the exact linked-service
or runtime to provision — the canvas and palette still render in full.

## Learn more

- **MS Learn — [What is Data Factory in Microsoft Fabric?](https://learn.microsoft.com/fabric/data-factory/data-factory-overview)**
- MS Learn — [Pipelines and activities (ADF)](https://learn.microsoft.com/azure/data-factory/concepts-pipelines-activities)
- MS Learn — [Dataflow Gen2 overview](https://learn.microsoft.com/fabric/data-factory/dataflows-gen2-overview)
- MS Learn — [Mapping data flows](https://learn.microsoft.com/azure/data-factory/concepts-data-flow-overview)
- Loom editor guides — [Data pipeline](../tutorials/editor-data-pipeline.md) · [Dataflow](../tutorials/editor-dataflow.md) · [Copy job](../tutorials/editor-copy-job.md)
