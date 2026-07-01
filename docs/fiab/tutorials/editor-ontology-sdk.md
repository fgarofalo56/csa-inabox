# Tutorial: Ontology SDK editor

> CSA Loom `ontology-sdk` editor — the Azure-native equivalent of Palantir's
> **OSDK (Ontology SDK)**: a typed TypeScript / Python client plus a REST /
> GraphQL Data API generated over an Ontology's object, link, and action types.
> Runs on Azure with **no Microsoft Fabric workspace required**.

## What it is

Palantir's OSDK generates a strongly-typed client so application code can work
with ontology objects, links, and actions instead of raw tables. The Loom
equivalent points **Microsoft Data API Builder (DAB)** at an ontology's bound
data source and generates a typed **TS / Python** client from the ontology's
parsed entity types. DAB runs on **Azure Container Apps** and the endpoint
publishes through **Azure API Management** — no Fabric workspace required.

## When to use it

- You want application developers to call your ontology's data through a typed
  client with autocompletion, not hand-written SQL.
- You want a governed REST + GraphQL Data API over the ontology that apps (for
  example a Slate app) can consume through APIM.
- You need both TypeScript and Python clients generated from a single source of
  truth (the ontology).

## Step-by-step in Loom

1. **Create the item.** Choose **+ New item → Ontology SDK** (Fabric IQ). The
   editor opens at `/items/ontology-sdk/<id>`.
2. **Bind an ontology.** Pick a saved Ontology; its entity types and bound
   Lakehouse / Warehouse define the SDK surface. Use **Select all** to include
   every entity type, or pick a subset.
3. **Generate the SDK.** Click **Generate SDK**. Loom emits real typed
   **TypeScript** and **Python** client source from the ontology's object / link
   / action types, which you can copy into your app repo.
4. **Review the Data API.** Inspect the generated **Data API Builder** entity
   configuration (REST + GraphQL) that backs the client.
5. **Publish to APIM.** Click **Publish to APIM** to expose the Data API through
   Azure API Management so apps can call the typed endpoints behind a managed
   gateway.

## The Azure backend it rides on

- **API runtime:** Microsoft **Data API Builder** on Azure Container Apps.
- **Gateway:** **Azure API Management** publishes the REST / GraphQL endpoint.
- **Data:** the ontology's bound **Synapse warehouse** or **ADLS Gen2 + Delta
  lakehouse**.

## No Fabric required

The SDK and Data API are generated from a **Loom Ontology** and served entirely
by Azure services (DAB + APIM). No Fabric capacity, workspace, or OneLake is
involved on the default path.

## Learn more

- Ontology editor tutorial: `editor-ontology.md`
- Data API Builder: <https://learn.microsoft.com/azure/data-api-builder/overview>
- API Management concepts:
  <https://learn.microsoft.com/azure/api-management/api-management-key-concepts>
