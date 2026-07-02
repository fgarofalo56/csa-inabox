# Tutorial: Slate app editor

> CSA Loom `slate-app` editor — the Azure-native equivalent of Palantir Foundry
> **Slate**: a pixel-perfect custom application over a query surface. In Loom it
> is a **backed template** that instantiates two real, editable items, running on
> Azure with **no Microsoft Fabric workspace required**.

## What it is

Slate is Foundry's builder for custom, data-driven web apps. The Loom equivalent
is not a copy-to-repo stub — picking it **instantiates a real stack**:

- a **`data-api-builder` item** — the query surface, powered by Microsoft **Data
  API Builder (DAB)** on Azure Container Apps, publishing REST/GraphQL through
  **Azure API Management**, and
- a **`workshop-app` item** — the runnable low-code app,

wired together so the app is bound to the real Data API on first open. You can
also emit a deployable **Azure Static Web Apps** bundle for the web tier.

## When to use it

- You want a bespoke UI over a query (SQL / KQL / REST) rather than over an
  ontology's object model directly.
- You want the query surface published as a governed REST/GraphQL API (through
  APIM) that other apps can also consume.
- You need to ship the finished web tier outside Loom to Azure Static Web Apps.

## Step-by-step in Loom

1. **Pick workspace + name.** Choose **+ New item → Slate app** (Fabric IQ),
   then the target workspace and a name for the app stack.
2. **Instantiate the stack.** Loom creates a real **data-api-builder** item and a
   real **workshop-app** item and binds the app's data to the Data API — both are
   fully editable Loom items, not stubs.
3. **Author queries.** In the app's **Queries** panel choose **Add query** and a
   **Type** (SQL / KQL / REST). Fill the **SQL** / **KQL** editor (with an
   optional **Database**) or the REST **Method / Path / Result path**, then use
   **Run preview** to load data.
4. **Design the page.** On the **Design** tab, **Add widget** (table, chart bound
   to a query, markdown) and set widget **Properties**; switch to **Preview** to
   see it with live data.
5. **Define variables.** Declare app **variables** with default values and
   reference them anywhere — widget text, query bodies, REST paths — with
   `{{name}}` interpolation; queries re-resolve when a variable changes.
6. **Wire interactions.** On any widget choose **Add interactions** and wire
   events — **click**, **row-select**, **load** — to effects: set a variable,
   refresh queries, navigate, or write back. Interactions execute live in
   **Preview**, and effect values support `{{variable}}` interpolation.
7. **Publish to Static Web Apps.** Use the in-editor **Publish** action to
   provision a real **Azure Static Web App** and deploy the generated bundle
   one-click (each publish is version-tracked and returns the live URL). You
   can still **Generate bundle** to download the `index.html` + `app.js` +
   `staticwebapp.config.json` artifact and ship it yourself. Publishing
   requires the SWA env wiring; if it is missing the editor shows an honest
   gate naming the exact env vars.

## The Azure backend it rides on

- **Query surface:** Microsoft **Data API Builder** on Azure Container Apps,
  fronted by **APIM** (REST + GraphQL).
- **Web tier (optional):** **Azure Static Web Apps** for the emitted bundle.
- **Data:** whatever the queries target — Synapse SQL, ADX (KQL), or a REST
  endpoint — all real Azure backends.

## No Fabric required

Both instantiated items are Azure-native (Container Apps + DAB + APIM + Static
Web Apps). No Fabric capacity, workspace, or OneLake is used on the default path.

## Learn more

- Workshop app editor tutorial: `editor-workshop-app.md`
- Data API Builder: <https://learn.microsoft.com/azure/data-api-builder/overview>
- Azure Static Web Apps: <https://learn.microsoft.com/azure/static-web-apps/overview>
