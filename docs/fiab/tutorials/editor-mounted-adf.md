# Tutorial: Mounted Data Factory editor

> CSA Loom `mounted-adf` editor — a read-only attachment of an **existing Azure
> Data Factory**: run its pipelines and watch run history from inside Loom
> without migrating anything. **No Microsoft Fabric required.**

## What it is

A Mounted Data Factory is a read-only attachment of an existing Azure Data
Factory. In Loom the run history and monitoring surface natively so you can run
ADF pipelines without migrating them — a way to fold existing ADF investments
into Loom.

## When to use it

- You have production pipelines in an existing ADF and want to trigger and
  monitor them from the Loom console.
- You are consolidating operations into Loom but authoring stays in ADF Studio.

## Step-by-step in Loom

1. **Create the item.** Choose **+ New item → Mounted Data Factory** (Data
   Factory). The editor opens at `/items/mounted-adf/<id>`.
2. **Reference the factory.** Point at the existing Azure Data Factory resource
   by subscription and resource group.
3. **Browse its pipelines.** Loom lists the factory's pipelines so you can
   trigger them from inside the console.
4. **Run and monitor.** Trigger a pipeline run and watch run history surfaced
   from the ADF monitoring API.
5. **Keep authoring in ADF.** Pipeline editing stays in ADF Studio; the mount
   is a run-and-monitor surface, not a full authoring replacement.

## The Azure backend it rides on

- **Control:** ADF ARM REST — pipeline list, createRun, and the monitoring API
  for run history.
- **RBAC:** the Console UAMI needs **Data Factory Contributor** (run) or
  Reader (monitor-only) on the mounted factory.

## No Fabric required

The mount talks straight to Azure Data Factory; no Fabric capacity, workspace,
or OneLake is involved.

## Learn more

- Using an existing ADF (parity source):
  <https://learn.microsoft.com/fabric/data-factory/use-existing-adf-in-fabric>
