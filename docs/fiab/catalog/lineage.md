# Catalog — Lineage

Federated lineage subgraph.

## Endpoint

`GET /api/catalog/lineage?source=<source>&id=<asset>&host=<>&workspaceId=<>`

Per source:

- **Purview** → `GET /datamap/api/atlas/v2/lineage/{guid}?direction=BOTH&depth=3` (Atlas lineage)
- **Unity Catalog** → `POST /api/2.0/lineage-tracking/table-lineage` (Databricks lineage tracking, requires SQL warehouse runs to have hydrated the lineage store)
- **OneLake** → `POST /v1.0/myorg/admin/workspaces/getInfo?lineage=true` then poll `scanStatus/{id}` then read `scanResult/{id}`. Tenant flight flag required.

## Known constraints

- **Fabric admin scan is tenant-flag gated.** If the tenant has not enabled "Enhance admin APIs responses with detailed metadata" the route throws `OneLakeLineageNotSupportedError` and the UI surfaces the exact admin remediation. This is documented honest config-only state per `no-vaporware.md`.
- **UC lineage is hydrated lazily** — a table only has lineage edges after a SQL warehouse or notebook has actually read/written it. Empty edges for a newly-created table is **not** a bug.
- **Cross-source lineage merge** (collapsing nodes that share a `qualifiedName` across Purview + UC) is a phase-2 deliverable. Today each source returns its own subgraph.

## UI

`/catalog/lineage` — pick source, paste an asset id, render the radial subgraph. The detail page on each asset embeds the same component scoped to that asset.

We render pure SVG (no D3 / vis-network) to keep the bundle thin.
