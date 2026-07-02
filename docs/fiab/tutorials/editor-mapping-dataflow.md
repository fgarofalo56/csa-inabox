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
5. **Debug + run.** Turn on **Data flow debug** to preview rows at each
   transformation — this needs a live Spark data-flow debug cluster (an Azure
   IR with data-flow compute); without one the preview is an honest gate, never
   faked. Run the flow in production from a pipeline's **Execute data flow**
   activity.

## The Azure backend it rides on

- **Resource:** `Microsoft.DataFactory/factories/dataflows`
  (`type: MappingDataFlow`) on the deployment-default factory.
- **Compute:** an Azure integration runtime with data-flow (Spark) compute.
- **Orchestration:** pipeline **Execute data flow** activity.

## No Fabric required

The flow compiles and runs on ADF / Synapse Spark; no Fabric capacity,
workspace, or OneLake is involved.

## Learn more

- Mapping data flows overview:
  <https://learn.microsoft.com/azure/data-factory/concepts-data-flow-overview>
