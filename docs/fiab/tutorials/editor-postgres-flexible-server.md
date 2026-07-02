# Tutorial: PostgreSQL Flexible Server editor

> CSA Loom `postgres-flexible-server` editor — list and provision **Azure
> Database for PostgreSQL Flexible Server** via real ARM, manage databases +
> firewall rules, and register servers in the catalog. **No Microsoft Fabric
> required.**

## What it is

Azure Database for PostgreSQL Flexible Server
(`Microsoft.DBforPostgreSQL/flexibleServers`) is a fully-managed PostgreSQL
service. In Loom you list existing servers across the subscription, provision
new ones via ARM PUT, manage databases + firewall rules, browse schema, and
register the server as a OneLake/Purview catalog asset.

## When to use it

- A workload needs PostgreSQL (extensions, Postgres-native apps, pgvector)
  rather than SQL Server.
- You want server inventory, provisioning, and firewall management from the
  same console as the rest of the estate.

## Step-by-step in Loom

1. **Open the editor.** Choose **+ New item → PostgreSQL Flexible Server**
   (Databases) or reach it via the SQL database family picker. The editor opens
   at `/items/postgres-flexible-server/<id>`.
2. **List servers.** Inventory PostgreSQL flexible servers across the
   subscription via ARM.
3. **Provision.** Create a new flexible server (SKU, tier, version, admin) via
   a real ARM PUT — or get an honest role/quota gate naming what's missing.
4. **Manage firewall.** Review and upsert
   `Microsoft.DBforPostgreSQL/flexibleServers/firewallRules`.
5. **Register in the catalog.** Surface the server as a Purview/OneLake catalog
   asset so it shows up alongside lakehouses and warehouses.

> In-database query execution is an honest infra-gate until the pg driver +
> `LOOM_POSTGRES_QUERY_LIVE` are wired — the editor says so rather than faking
> results.

## The Azure backend it rides on

- **Resources:** `Microsoft.DBforPostgreSQL/flexibleServers` ARM REST (list,
  PUT, firewall rules).
- **Catalog:** Purview registration through the Loom governance surface.

## No Fabric required

PostgreSQL Flexible Server is a first-class Azure service; no Fabric capacity,
workspace, or OneLake is involved.

## Learn more

- PostgreSQL Flexible Server overview:
  <https://learn.microsoft.com/azure/postgresql/flexible-server/overview>
