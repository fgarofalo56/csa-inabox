# Tutorial: Rayfin app editor

> CSA Loom `rayfin-app` — a **backed template** that scaffolds the Rayfin
> Backend-as-a-Service shape with real Azure services: Azure Functions + Cosmos
> DB + a Static Web App, wired together and fully editable. **No Microsoft
> Fabric required.**

## What it is

Rayfin is Microsoft's open-source Backend-as-a-Service for Fabric (Build 2026
preview). The CSA Loom equivalent is a BACKED template: picking it INSTANTIATES
three real, editable Loom items —

- a **`user-data-function`** item — the API tier on **Azure Functions**,
- an **`azure-cosmos-account`** item — the data store on **Cosmos DB**, and
- a **`slate-app`** item — the **Static Web App** web tier,

wired together so the web app calls the Functions route and the Functions item
reads/writes the Cosmos store. Every scaffolded item is a runnable Loom item,
not a stub. The original code-first Rayfin SDK/CLI path (TypeScript +
`@microsoft/rayfin-core` decorators deployed with `npx rayfin up`) remains an
opt-in alternative.

## When to use it

- You want a full app stack (web + API + store) scaffolded in one click on
  your own tenant's Azure services.
- You're evaluating the Rayfin programming model without a Fabric workspace.

## Step-by-step in Loom

1. **Pick workspace + name.** Choose **+ New item → Rayfin app** (Fabric apps),
   then the target Loom workspace and a name for the app stack.
2. **Instantiate the stack.** Loom creates the user-data-function (Azure
   Functions API), azure-cosmos-account (Cosmos DB store), and slate-app
   (Static Web App) items, then wires the web app to the Functions route and
   the Functions item to the Cosmos store.
3. **Land in the web app.** You open the slate-app web tier, already bound to
   the Functions + Cosmos backend. Add widgets and queries over the live API.
4. **Author the backend.** Open the user-data-function item to author the API
   (Python/TypeScript) and the azure-cosmos-account item to manage containers —
   all real, editable Loom items.
5. **Run it on your tenant.** The stack runs on your tenant's Azure Functions,
   Cosmos DB, and Static Web Apps under your identity/network/governance; any
   unprovisioned runtime surfaces each editor's honest infra-gate while the
   full UI still renders.

## The Azure backend it rides on

- **API tier:** Azure Functions (user-data-function item).
- **Data tier:** Azure Cosmos DB (azure-cosmos-account item).
- **Web tier:** Azure Static Web Apps (slate-app item).

## No Fabric required

All three tiers are first-class Azure services on your tenant; no Fabric
workspace, capacity, or OneLake is involved.

## Learn more

- Fabric apps overview (parity source):
  <https://learn.microsoft.com/fabric/apps/overview>
