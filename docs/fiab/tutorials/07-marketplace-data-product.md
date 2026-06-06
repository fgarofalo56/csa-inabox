# Tutorial 07 — Publish & discover data products

Share data across the platform using the three shipped surfaces: the **API
marketplace**, the **Unified catalog**, and **data product templates**.
**20 minutes.**

## Prerequisites

- Workspace with `noaa_silver_daily` table from Tutorial 02
- Workspace Admin (or a steward role) to publish

There is no marketplace CLI and no YAML data-product manifest. The flows
below are the real, shipped UI surfaces.

---

## Surface A — Publish a table as an API

Expose a lakehouse/warehouse table as a managed API via APIM.

### 1. Open the source item

Left nav → **Workspaces** → open your workspace → open the lakehouse or
warehouse holding `noaa_silver_daily`.

### 2. Publish as an API

In the item's **Weave** menu → **Publish as an API**
(`POST /api/thread/publish-as-api`). Loom creates an APIM API product from
a Synapse Serverless view (or Databricks SQL endpoint) over the table.

### 3. Subscribe and try it

Left nav → **API marketplace** (`/api-marketplace`). The published APIM
products and APIs are listed. From a product you can **Try it** in-browser,
copy the subscription key, or **Use as source** to wire the API into a Data
Agent or a mini-app.

---

## Surface B — Discover & request data assets

### 4. Browse the Unified catalog

Left nav → **Unified catalog** (`/catalog`). It indexes data assets across
Purview (Gov) or Unity Catalog (Commercial). Filter to find your table
(e.g. by `domain: weather` if you tagged it in
[Tutorial 02](02-first-lakehouse.md) §11).

### 5. Request access

Click **Request access** on an asset. This triggers the underlying
access-policy request — a Purview data-access policy request (Gov) or a UC
entitlement request (Commercial). The approval workflow lives in those
governance systems, not in the Loom Console.

---

## Surface C — Spawn a data product from a template

### 6. Create a Data product template item

Open your workspace → **New item** → category **Data Engineering** → **Data
product template**. The Data Product Template editor opens and loads the
curated template grid (`GET /api/items/data-product-template`).

### 7. Pick a template

Select a template to see its components, description, and estimated monthly
cost.

### 8. Spawn into a workspace

Choose a target workspace and a display name, then click **Spawn into
workspace** (POSTs `{ workspaceId, displayName }` to
`POST /api/items/data-product-template/<slug>/instantiate`). On success you
land on the new **Data Product Instance** editor, which lists the spawned
component items and their status/health.

## What's next

- [Federal Data Mesh use case](../use-cases/federal-data-mesh.md) —
  multi-domain sharing patterns
- [Workspace RBAC](../governance/workspace-rbac.md) — managing access
- [Catalog](../governance/catalog.md) — full catalog architecture

## Cleanup

- API: delete the published API product from the source item's Weave menu
  (or the API marketplace) if your deployment supports it
- Template instance: delete the Data Product Instance item from the
  workspace tree (right-click → Delete)

## Troubleshooting

- "Publish as an API" gated: provision/grant the APIM service the action
  reports
- Asset not in the catalog: confirm Purview/UC scanning has indexed the
  source, then refresh
