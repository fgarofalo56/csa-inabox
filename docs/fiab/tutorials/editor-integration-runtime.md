# Tutorial: Integration runtime editor

> CSA Loom `integration-runtime` editor — the IR manager for the deployment
> Data Factory: **Azure**, **Self-Hosted**, and **Azure-SSIS** integration
> runtimes as real `Microsoft.DataFactory/factories/integrationruntimes`
> resources. Real ARM, **no Microsoft Fabric required.**

## What it is

An Integration runtime (IR) is the compute infrastructure Azure Data Factory /
Synapse pipelines use for activity dispatch, data movement, SSIS package
execution, and data-flow Spark execution. In Loom every IR is a real ARM
resource on the deployment-default factory — the editor lists IRs with live
status, creates all three types from structured forms, reveals Self-Hosted
install keys, and manages start / stop / delete lifecycle.

## When to use it

- Your Copy activities or Mapping data flows need compute in a specific region
  or size.
- You must reach private / on-prem data — a **Self-Hosted IR** is the gateway.
- You're lifting SSIS packages — an **Azure-SSIS IR** runs them as-is.

## Step-by-step in Loom

1. **Create the item.** Choose **+ New item → Integration runtime** (Data
   Factory). The editor opens at `/items/integration-runtime/<id>` and lists
   the factory's IRs with live status.
2. **Choose a type.** **Azure IR** (managed, region-pinned cloud compute),
   **Self-Hosted IR** (a gateway to private / on-prem data), or **Azure-SSIS
   IR** (lift-and-shift SSIS packages).
3. **Configure + create.** Fill the type's structured form (region, compute
   size, node count) — never freeform JSON — then create via a real ARM PUT.
4. **Register Self-Hosted nodes.** Reveal the install (auth) keys and register
   the Microsoft Integration Runtime on each gateway machine to reach private /
   on-prem data.
5. **Manage lifecycle.** Start, stop, and delete Self-Hosted / Azure-SSIS
   runtimes; the built-in **AutoResolveIntegrationRuntime** is always available
   by default.

## The Azure backend it rides on

- **Resources:** `Microsoft.DataFactory/factories/integrationruntimes` ARM REST
  on the deployment-default factory.
- **Gate:** when the factory env (`LOOM_SUBSCRIPTION_ID` / `LOOM_DLZ_RG` /
  `LOOM_ADF_NAME`) is unset the surface still renders and shows an honest
  infra-gate naming the vars.

## No Fabric required

IRs are Data Factory ARM resources; no Fabric capacity, workspace, or OneLake
is involved.

## Learn more

- Integration runtime concepts:
  <https://learn.microsoft.com/azure/data-factory/concepts-integration-runtime>
