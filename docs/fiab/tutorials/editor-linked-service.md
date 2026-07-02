# Tutorial: Linked service editor

> CSA Loom `linked-service` editor — the 31-connector gallery for reusable
> connection definitions on Azure Data Factory (default) or a Synapse
> workspace: the bind target for pipelines, datasets, and data flows. Real
> ARM / Synapse dev plane, **no Microsoft Fabric required.**

## What it is

A Linked service is a first-class, reusable connection definition (connection
string + authentication) that pipelines, datasets, Copy activities, and Mapping
data flows bind to — exactly the ADF / Synapse Studio Manage-hub "Linked
services" object. In Loom every connection is a real
`Microsoft.DataFactory/factories/linkedservices` (or Synapse workspace
linkedservices) resource.

## When to use it

- You're about to author a pipeline, dataset, or data flow and need its
  connection defined once, reusable everywhere.
- You need governed authentication — Managed Identity, key, SAS, or service
  principal — with secrets stored as ARM `secureString`.

## Step-by-step in Loom

1. **Create the item.** Choose **+ New item → Linked service** (Data Factory).
   The editor opens at `/items/linked-service/<id>` in manage mode.
2. **Pick a backend.** Choose **Azure Data Factory** (the deployment-default
   factory) or a **Synapse workspace**. ADF is the Azure-native default; both
   share the same `{name, properties}` contract.
3. **Browse the connector gallery.** Search or browse **31 connectors** grouped
   by Azure / Database / File / NoSQL / Generic protocol / Services & apps,
   then pick one.
4. **Fill the structured form.** Select an authentication method (Managed
   Identity, key, SAS, service principal) and complete its fields. Secrets are
   stored as ARM `secureString` — never round-tripped as plaintext, never
   freeform JSON.
5. **Test + create.** Run **Test connection** (a real validate round-trip via
   the BFF), then **Create** — a real ARM / Synapse upsert. Edit and Delete
   existing linked services from the same surface.

## The Azure backend it rides on

- **Resources:** `Microsoft.DataFactory/factories/linkedservices` ARM REST, or
  the Synapse dev plane for workspace-scoped connections.
- **Secrets:** ARM `secureString` fields; Key Vault references where the
  connector supports them.

## No Fabric required

Linked services live on ADF / Synapse; no Fabric capacity, workspace, or
OneLake is involved.

## Learn more

- Linked services concepts:
  <https://learn.microsoft.com/azure/data-factory/concepts-linked-services>
