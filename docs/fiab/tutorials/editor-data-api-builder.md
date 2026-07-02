# Tutorial: Data API builder editor

> CSA Loom `data-api-builder` editor — expose Azure SQL / PostgreSQL / Cosmos
> tables as secured **REST + GraphQL** endpoints with Microsoft **Data API
> builder (DAB)**. **No Microsoft Fabric required.**

## What it is

Data API builder (DAB) generates secured REST and GraphQL endpoints over a
relational or Cosmos source from a single `dab-config.json`. In Loom the editor
introspects the database schema, maps tables/views/stored procedures to
entities with per-role permissions, relationships, and policies, emits the
canonical `dab-config.json`, and — when a DAB runtime Container App is deployed
— tests the live REST + GraphQL endpoints and publishes through APIM.

## When to use it

- You want a governed API over a database without writing a backend service.
- You need both REST (OData-style) and GraphQL over the same entities.
- You're building a Slate app / Ontology SDK stack — DAB is the query surface
  those items ride on.

## Step-by-step in Loom

1. **Create the item.** Choose **+ New item → Data API builder** (APIs &
   Functions). The editor opens at `/items/data-api-builder/<id>`.
2. **Pick a data source.** Choose Azure SQL / PostgreSQL / Cosmos and the
   connection — the connection string is referenced via `@env()`, never stored
   as a literal.
3. **Add entities.** Introspect the schema and map tables/views to entities
   with REST paths, GraphQL types, and field aliases.
4. **Secure with permissions.** Grant per-role create/read/update/delete with
   field-level include/exclude and database policies.
5. **Preview and publish.** Validate the config, test the live REST + GraphQL
   endpoints against the DAB runtime, then publish the API through Azure API
   Management.

## The Azure backend it rides on

- **Runtime:** Microsoft **Data API builder** on Azure Container Apps.
- **Gateway:** **Azure API Management** publishes the REST / GraphQL endpoint.
- **Data:** Azure SQL, PostgreSQL Flexible Server, or Cosmos DB.

## No Fabric required

DAB, Container Apps, and APIM are all first-class Azure services; no Fabric
capacity, workspace, or OneLake is involved.

## Learn more

- Data API builder: <https://learn.microsoft.com/azure/data-api-builder/overview>
