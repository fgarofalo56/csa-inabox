# Tutorial: Datamart editor (migration template)

> CSA Loom `datamart` — a **DEPRECATED** Power BI datamart surface whose only
> action is **Migrate**: convert the datamart into a Synapse Serverless
> warehouse tier + an Azure Analysis Services semantic-model tier. **No
> Microsoft Fabric or Power BI Premium required.**

## What it is

Power BI datamarts are deprecated, so this is a MIGRATION template — not a
create surface. No new datamarts can be authored; the entry exists only to
migrate existing ones. The Loom migration path converts a datamart into:

- a **Synapse Serverless user database** — always-on OPENROWSET /
  external-table analytics (the warehouse tier), and
- an **Azure Analysis Services tabular model** — Import or DirectQuery over
  Synapse (the semantic-model tier).

The **Migrate** action provisions both automatically via
`/api/items/datamart/migrate` and stamps a migration receipt on the original
item.

## When to use it

- You have existing Power BI datamarts and need an Azure-native landing path
  before the deprecation bites.
- You want the datamart's SQL tier and semantic tier split onto services you
  can govern and scale independently.

## Step-by-step in Loom

1. **Open the deprecated datamart.** The editor shows its name and a
   deprecation banner — no authoring surface is offered.
2. **Migrate.** Click **Migrate**. Loom runs `CREATE DATABASE` on the Synapse
   Serverless endpoint and PUTs an Azure Analysis Services server, then records
   the new database name + AAS connection URI on the item.
3. **Deploy the tabular model.** Use SSDT or SSMS against the AAS XMLA endpoint
   (connection URI in the receipt) to deploy the semantic model to the
   provisioned server.
4. **Reconnect reports.** Point Power BI / Loom reports at the new AAS server
   or the Synapse Serverless SQL endpoint instead of the datamart.

## The Azure backend it rides on

- **Warehouse tier:** Azure Synapse **serverless SQL** (user database over ADLS
  Delta/Parquet).
- **Semantic tier:** **Azure Analysis Services** tabular (XMLA endpoint).
- **Migration:** `/api/items/datamart/migrate` — real `CREATE DATABASE` + ARM
  PUT, receipt stamped on the item.

## No Fabric required

The migration lands on Synapse Serverless + AAS — no Fabric capacity, OneLake,
or Power BI Premium on the default path.

## Learn more

- Power BI datamarts (deprecation context):
  <https://learn.microsoft.com/power-bi/transform-model/datamarts/datamarts-overview>
