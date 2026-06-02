# Cosmos Data Explorer

Loom's Cosmos surface builds the Azure Cosmos DB **Data Explorer** one-for-one:
browse databases and containers, create and edit JSON items, and run NoSQL
(SQL-syntax) queries against the real Cosmos data plane through the Console
managed identity.

## When to use it

- **Operate** an Azure Cosmos DB for NoSQL account — inspect documents, fix a
  record, or validate a partition key — without leaving Loom.
- **Query** JSON items with the built-in SQL query syntax, including nested
  objects and arrays.
- **Prototype** the data behind a Data Agent, GraphQL API, or app, then wire it
  into a pipeline or mirror it to OneLake.

## The Cosmos editor

Open the Cosmos account item. The ribbon mirrors the Azure portal:

- **Home** — account context.
- **Data Explorer** — the database → container → Items tree.
- **New SQL Query** — open a query tab.
- **Refresh** — re-read the tree.

Containers expose their **partition key**, and **New Container** creates one
(database, container id, partition key, throughput).

### Step-by-step: add an item, then query it

1. Open **Data Explorer** and expand a database → container → **Items**.
2. **New Item** — paste a JSON document and **Save**:

   ```json
   {
     "id": "aaaaaaaa-0000-1111-2222-bbbbbbbbbbbb",
     "name": { "first": "Kai", "last": "Carter" },
     "department": { "name": "Logistics" }
   }
   ```

3. **New SQL Query** — run a NoSQL query and **Execute**:

   ```sql
   SELECT VALUE {
       "name": CONCAT(e.name.last, " ", e.name.first),
       "department": e.department.name
   }
   FROM employees e
   WHERE STRINGEQUALS(e.department.name, "logistics", true)
   ```

4. Query nested data with dot notation, `ARRAY_CONTAINS`, or `JOIN ... IN`:

   ```sql
   SELECT c.id, t AS tag
   FROM c JOIN t IN c.tags
   WHERE t.name = "waterproof"
   ```

5. Observe the JSON-array output in the results pane. Edit an item inline and
   **Save** to write it back through the Cosmos data plane.

## Beyond the explorer

- **Mirror to OneLake** — replicate the container into a lakehouse and query the
  mirror with T-SQL (`OPENJSON` / `CROSS APPLY` to flatten nested arrays)
  without hitting the source. See the [Mirror Cosmos DB tutorial](../tutorials/06-mirroring-cosmos.md).
- **Serverless SQL over analytical store** — `OPENROWSET('CosmosDB', ...)` reads
  the analytical store for ad-hoc reporting.

## Honest infra gate

If `EXISTING_COSMOS_ACCOUNT` isn't resolved (or the Console UAMI lacks the
**DocumentDB Account Contributor** role), the editor shows a `MessageBar` naming
the account env var / RBAC grant — the Data Explorer tree and query tab still
render.

## Learn more

- **MS Learn — [Azure Cosmos DB Data Explorer](https://learn.microsoft.com/azure/cosmos-db/data-explorer)**
- MS Learn — [Tutorial: Query data in Cosmos DB for NoSQL](https://learn.microsoft.com/azure/cosmos-db/tutorial-query)
- MS Learn — [Getting started with SQL queries](https://learn.microsoft.com/cosmos-db/query/overview)
- MS Learn — [Mirror Azure Cosmos DB in Fabric](https://learn.microsoft.com/fabric/mirroring/azure-cosmos-db)
- Loom tutorial — [Mirror Cosmos DB to a Lakehouse](../tutorials/06-mirroring-cosmos.md)
