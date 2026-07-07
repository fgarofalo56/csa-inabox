# Loom Apps

**Loom Apps** are how you **build and distribute applications** on CSA Loom — the
Azure-native answer to Microsoft Fabric's Apps surface (including the Build-2026
"Rayfin" data-app shape), with **no Microsoft Fabric or Power BI dependency**
(`.claude/rules/no-fabric-dependency.md`).

There are two shapes of app, mirroring what Fabric's Apps surface offers:

- **Org apps** — bundle items you already have (reports, dashboards, notebooks,
  semantic models, …) into a distributable, audience-scoped experience.
- **Data apps** — scaffold a runnable, full-stack, data-driven application on
  Azure-native services (Functions + Cosmos DB + Static Web Apps).

## The four Loom app items

| Loom item | Shape | Maps to (Fabric) | Azure-native backend |
|---|---|---|---|
| **Loom app** (`loom-app`) | Org app | Fabric / Power BI **org app** | Cosmos-persisted definition + Loom's existing per-item routes and access model |
| **Data app** (`rayfin-app`) *(Preview)* | Data app | Fabric **Rayfin** data app (Build 2026) | **Azure Functions** (API) + **Cosmos DB** (store) + **Static Web App** (web), wired together |
| **Workshop app** (`workshop-app`) *(Preview)* | Operational app | Fabric IQ **Workshop** | Low-code app bound to a Loom **Ontology** — object views, link traversal, write-back actions |
| **Slate app** (`slate-app`) *(Preview)* | Data app template | Fabric IQ **Slate** | Scaffolds a real Workshop app + **Data API builder** stack over a query surface; deploys to **Azure Static Web Apps** |

## Loom app — the org app

A **Loom app** packages the items already in a workspace into a single, navigable
experience for consumers — the equivalent of a Fabric / Power BI org app, built
entirely on Azure-native services. You:

1. **Add content** — pick items from the workspace (the real, live Cosmos-backed
   inventory: reports, dashboards, notebooks, semantic models, and every other
   item type).
2. **Arrange navigation** — group content into named sections and order the
   entries; this is exactly what consumers see in the app's left nav.
3. **Define audiences** — create one or more audiences, each with its own access
   list (users / groups) and, optionally, a subset of visible content — the Fabric
   org-app "audiences" model, on Loom's access layer.
4. **Publish** — mint a consumer app view at `/apps/<id>`; each publish records a
   version.
5. **Open as a consumer** — the published view resolves the caller's audience
   membership, renders the navigation, and deep-links each tile to the **live
   item** under the consumer's identity, network, and governance.

The definition and audiences persist to **Cosmos DB**; the published view reuses
Loom's existing per-item routes and access model, so every tile opens the real
item — no static snapshots.

## Data app — the Rayfin-shape full-stack app

A **Data app** scaffolds a full-stack, data-driven application on Azure-native
services — the Loom equivalent of Fabric's Rayfin data-app shape, with no Fabric
workspace required. Picking it **instantiates three real, editable Loom items** and
wires them together:

- a **user-data-function** item — the API tier on **Azure Functions**;
- an **azure-cosmos-account** item — the data store on **Cosmos DB**;
- a **slate-app** item — the web tier on an **Azure Static Web App**.

The web app calls the Functions route, and the Functions item reads/writes the
Cosmos store. Every scaffolded item is a runnable Loom item, not a stub. Any
unprovisioned runtime surfaces each editor's honest infra-gate while the full UI
still renders.

!!! note "OSS Rayfin remains an opt-in path"
    Fabric's open-source Rayfin SDK/CLI (TypeScript + `@microsoft/rayfin-core`
    decorators, deployed with `npx rayfin up`) stays available as an explicit
    alternative for teams that specifically want it — but it is never required and
    never the default.

## Workshop app and Slate app — operational apps over an Ontology

**Workshop** and **Slate** apps come from the **Fabric IQ** family and are built
over a Loom **Ontology**:

- A **Workshop app** is an operational, low-code application bound to an Ontology —
  it presents **object views**, lets users **traverse links** between objects, and
  supports **write-back actions** against the underlying data.
- A **Slate app** is a backed template that scaffolds a real Workshop app plus a
  **Data API builder** stack over a query surface, deploying the web tier to
  **Azure Static Web Apps**.

Both are Azure-native and require no Fabric workspace. See
[Fabric → Azure-native mapping](fabric-to-azure-mapping.md) for how the Fabric IQ
family maps onto Cosmos + ADX graph + Azure-native services.

## Related

- [What is CSA Loom](index.md)
- [Item catalog](item-catalog.md) — the **Loom Apps** and **Fabric IQ** sections
- [Architecture](architecture.md)
