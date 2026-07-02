# Tutorial: Azure Cosmos DB account editor

> CSA Loom `azure-cosmos-account` editor — a live **Data Explorer** over a real
> Azure Cosmos DB (NoSQL) account: databases, containers, throughput, documents,
> and server-side scripts. Real ARM + data plane, **no Microsoft Fabric
> required.**

## What it is

An Azure Cosmos DB account (NoSQL / Core SQL API) is a globally-distributed,
multi-model database. In Loom the editor is a live Data Explorer over the
env-pinned account (`LOOM_COSMOS_ACCOUNT`) — databases → containers → stored
procedures / triggers / UDFs — driven by the real ARM control plane
(`Microsoft.DocumentDB/databaseAccounts`). Creates and deletes are real ARM
PUT/DELETE calls; document queries hit the real data plane with live RU
charges.

## When to use it

- You need to inspect or manage the NoSQL store an application rides on —
  containers, partition keys, RU/s, indexing policies.
- You want to run ad-hoc SQL queries over documents and see the real RU cost.
- You author server-side stored procedures, triggers, or UDFs.

## Step-by-step in Loom

1. **Configure the navigator account.** Set `LOOM_COSMOS_ACCOUNT`,
   `LOOM_COSMOS_ACCOUNT_RG`, and `LOOM_SUBSCRIPTION_ID`, and grant the Console
   UAMI the **Cosmos DB Operator** (or DocumentDB Account Contributor) role at
   the account scope. This account is distinct from Loom's own internal store.
2. **Browse the Data Explorer.** Expand **Databases → a database → Containers →
   a container** to see its partition key, throughput, and the stored
   procedures / triggers / UDFs registered on it — counts come from real ARM
   list calls.
3. **Create a database or container.** Use the **＋ New** menu to create a
   database (optional shared throughput) or a container (partition key +
   manual/autoscale RU/s); the create issues a real ARM PUT and the tree
   refreshes.
4. **Query documents.** The document grid runs Monaco SQL with **Execute**
   against the real data plane (live RU charge) and supports JSON document
   CRUD.
5. **Edit policies and author scripts.** The indexing-policy and
   conflict-resolution editors save through real ARM / data-plane PATCH; the
   Stored Procedure / UDF / Trigger tabs create, replace, delete, and execute
   scripts for real. A read-only UAMI surfaces the ARM 403 as an honest
   MessageBar naming the exact role to grant — never faked data.

## The Azure backend it rides on

- **Control plane:** `Microsoft.DocumentDB/databaseAccounts` ARM REST.
- **Data plane:** Cosmos DB SQL data-plane (queries, documents, sproc
  execution) with Entra auth.
- **RBAC:** Cosmos DB Operator / DocumentDB Account Contributor on the account.

## No Fabric required

The editor calls only Cosmos ARM + data-plane REST. No Fabric capacity,
workspace, or OneLake is involved (Fabric mirroring of Cosmos is a separate,
opt-in item).

## Learn more

- Cosmos DB databaseAccounts reference:
  <https://learn.microsoft.com/azure/templates/microsoft.documentdb/2024-11-15/databaseaccounts>
