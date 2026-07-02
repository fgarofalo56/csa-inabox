# Tutorial: Mirrored Databricks catalog editor

> CSA Loom `mirrored-databricks` editor — mount a Databricks **Unity Catalog**
> as a read-only mirror into ADLS Gen2 Delta and query it via Synapse. **No
> Microsoft Fabric or OneLake required.**

## What it is

A Mirrored Databricks catalog brings a Databricks Unity Catalog into Loom
analytics as a read-only mirror. The UC Delta tables are mirrored into ADLS
Bronze (ADF CDC / Synapse Link) and queried via the Synapse serverless SQL
analytics endpoint, without re-ingesting or copying governed data. Fabric
mirroring into OneLake exists only as an explicit opt-in — never the default.

## When to use it

- Databricks owns the governed data (Unity Catalog) and you need it queryable
  alongside Loom lakehouses and warehouses.
- You want cross-engine joins (Synapse SQL over UC Delta) without an ETL copy
  job to maintain.

## Step-by-step in Loom

1. **Create the item.** Choose **+ New item → Mirrored Databricks catalog**
   (Data Factory). The editor opens at `/items/mirrored-databricks/<id>`.
2. **Provide the workspace.** Point at the Azure Databricks workspace and Unity
   Catalog you want to mirror.
3. **Select the catalog/schema.** Choose which catalog and schemas to expose as
   a read-only mirror in ADLS Bronze Delta.
4. **Query via Synapse SQL.** Read the mirrored Delta tables via the Synapse
   serverless SQL analytics endpoint or Spark — no copy required.
5. **Respect source governance.** Mirroring is read-only; writes and
   permissions stay governed by Unity Catalog on the Databricks side.

## The Azure backend it rides on

- **Mirror:** ADF CDC / Synapse Link copy into ADLS Gen2 Bronze Delta.
- **Query:** Synapse serverless SQL (analytics endpoint) or Spark over the
  mirrored Delta.
- **Governance:** Unity Catalog remains the source of truth on the Databricks
  side.

## No Fabric required

The default mirror path is ADLS + Synapse; Fabric/OneLake mirroring is opt-in
only.

## Learn more

- Databricks mirroring (parity source):
  <https://learn.microsoft.com/fabric/database/mirrored-database/azure-databricks-tutorial>
