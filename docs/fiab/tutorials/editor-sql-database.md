# Tutorial: SQL database editor

> CSA Loom `sql-database` editor — the unified Azure database surface: **Azure
> SQL Database, SQL Managed Instance, or PostgreSQL Flexible Server**. Tenant
> inventory, provisioning, live SQL, schema browsing, and catalog registration.
> **No Microsoft Fabric required.**

## What it is

In CSA Loom the SQL database surface is backed by real Azure database services
— Azure SQL Database, SQL Managed Instance, and Azure Database for PostgreSQL
Flexible Server — not Fabric SQL. It lists existing deployments across the
subscription via ARM, lets you connect to one, provision new ones (ARM PUT),
run SQL over the live TDS path, browse the schema, and register the database as
a governed OneLake/Purview catalog asset.

## When to use it

- You need an operational relational database and want the family picker to
  route you to the right service (Azure SQL DB / MI / PostgreSQL).
- You want tenant-wide inventory of database servers with connect-and-query
  from the console.

## Step-by-step in Loom

1. **Create the item.** Choose **+ New item → SQL database** (Databases). The
   editor opens at `/items/sql-database/<id>`.
2. **Connect to existing.** Browse the tenant inventory of Azure SQL servers,
   SQL Managed Instances, and PostgreSQL flexible servers (ARM list) and bind
   one to this item.
3. **Provision new.** Create an Azure SQL database on an existing server, or a
   new PostgreSQL flexible server, via ARM PUT — or get an honest role/quota
   gate.
4. **Run SQL.** Execute T-SQL over TDS + AAD against the selected Azure SQL
   database; PostgreSQL and MI query paths surface honest infra-gates where the
   driver path isn't wired.
5. **Register in the catalog.** Surface the database as a OneLake/Purview
   catalog asset so it shows up alongside lakehouses and warehouses.

## The Azure backend it rides on

- **Control plane:** `Microsoft.Sql/servers` + `Microsoft.Sql/managedInstances`
  + `Microsoft.DBforPostgreSQL/flexibleServers` ARM REST.
- **Data plane:** TDS with Entra (AAD) auth via the azure-sql-client.
- **Catalog:** Purview registration through the Loom governance surface.

## No Fabric required

Everything runs on Azure SQL / PostgreSQL services; mirroring a database into
Fabric/OneLake is opt-in only, never the default.

## Learn more

- Azure SQL Database overview:
  <https://learn.microsoft.com/azure/azure-sql/database/sql-database-paas-overview>
