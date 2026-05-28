# Catalog — Asset detail page

`/catalog/{source}/{id}` — per-asset deep-dive page.

## Endpoint

`GET /api/catalog/asset/{id}?source=<>&host=<>`

Returns a single payload containing:

- `detail` — the source-native entity (UC table with columns; Purview entity with classifications + relationships; OneLake item with workspace context — phase 2)
- `lineage` — pre-computed lineage subgraph centered on the asset
- `upstreamLink` — best-effort deep link to the source-native portal as a fallback ("Open in Purview", "Open in Databricks")

The single-payload design means the page renders in one round-trip; there is no N+1 fetch chain per tile.

## UI tiles

- **Overview card** — name, type, owner, comment, "Open in upstream tool" link
- **Schema card** (UC) — column table with type + nullable
- **Classifications card** (Purview) — chips for each Atlas classification typeName
- **Lineage card** — embedded `LineageGraph` scoped to this asset

## Forbidden

Per `no-vaporware.md`: the page never reads from `useState(MOCK_DATA)` or pre-configured stubs. If the asset is unreachable the page renders a `MessageBar` with the upstream error + hint. The "Open in upstream tool" link is a **fallback**, not the primary action.
