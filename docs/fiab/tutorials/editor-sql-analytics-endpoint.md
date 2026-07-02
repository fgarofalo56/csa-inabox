# Tutorial: SQL analytics endpoint editor

> CSA Loom `sql-analytics-endpoint` editor — the read-only T-SQL analyst
> surface over a lakehouse / warehouse / mirror: **Synapse serverless SQL**
> over the Delta in ADLS, with views, procs, and security grants. **No
> Microsoft Fabric required.**

## What it is

A SQL analytics endpoint is the read-only T-SQL consumption surface that sits
over a lakehouse, warehouse, or mirrored database — the analyst's query layer,
exactly like Fabric's auto-provisioned SQL analytics endpoint. In CSA Loom it
is Azure-native: the endpoint is Azure Synapse serverless SQL querying the
Delta / Parquet in ADLS Gen2 (OPENROWSET / external tables). The editor is the
Synapse Studio-style SQL-script surface: an object explorer (views / procs /
TVFs / external tables), a Monaco T-SQL editor with catalog IntelliSense, a
connect-to-database dropdown, Run / Run-selection, and a Results | Messages
pane.

## When to use it

- Analysts need governed, read-only T-SQL over lake data without provisioning
  compute.
- You author consumption views / procedures / inline TVFs over OPENROWSET.
- You apply object-level and row-level security so each consumer sees only
  their slice.

## Step-by-step in Loom

1. **Create the item.** Choose **+ New item → SQL analytics endpoint** (Data
   Warehouse). The editor opens at `/items/sql-analytics-endpoint/<id>`.
2. **Connect to the endpoint.** The endpoint binds to the deployment Synapse
   serverless SQL pool over the lake's Delta in ADLS. Pick a database in the
   **Connect-to** dropdown (master + user databases created via
   `CREATE DATABASE`).
3. **Explore + query.** Browse views, stored procedures, table-valued
   functions, and external tables in the object explorer; write T-SQL in the
   Monaco editor with catalog-driven IntelliSense and **Run** (Ctrl+Enter) or
   **Run selection**.
4. **Create consumption objects.** Use the **New view / New procedure / New
   function** templates to author `CREATE OR ALTER VIEW / PROCEDURE / inline
   TVF` over OPENROWSET (serverless does not support scalar UDFs — the
   templates emit iTVFs and say so).
5. **Grant access.** Apply object-level GRANT / DENY and row-level security
   (security policies + predicate functions) so analysts get a governed,
   read-only consumption surface. Export results to CSV / JSON or **Open in
   Excel**.

## The Azure backend it rides on

- **Engine:** Azure Synapse **serverless SQL** (`LOOM_SYNAPSE_WORKSPACE`); when
  unset the surface still renders and shows an honest infra-gate.
- **Data:** Delta / Parquet in ADLS Gen2 via OPENROWSET / external tables.

## No Fabric required

The endpoint is Synapse serverless over ADLS; no Fabric capacity, OneLake, or
Power BI workspace is involved.

## Learn more

- Synapse serverless SQL:
  <https://learn.microsoft.com/azure/synapse-analytics/sql/on-demand-workspace-overview>
