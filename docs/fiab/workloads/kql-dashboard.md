# KQL Dashboard editor

A **KQL Dashboard** is a multi-tile dashboard backed by KQL queries. Each
tile pins one query + a viz type (table, line, bar) and is re-runnable via
the dashboard's Re-run-all button.

## Backend

| Layer | Implementation |
|---|---|
| Persistence | Cosmos DB `items` container, `state.tiles: [{title, kql, viz, database?}]` |
| Execution | ADX `/v1/rest/query` per tile, fan-out at `GET ?run=1` time |
| BFF routes | `GET /api/items/kql-dashboard/[id]` (read, with optional `?run=1` to inline results), `PUT /api/items/kql-dashboard/[id]` (save tiles) |

## What works today

| Action | Backend call | Status |
|---|---|---|
| Read tiles | Cosmos read | live |
| Run tile (server-side fan-out) | ADX `/v1/rest/query` | live |
| Add / delete / inline-edit tile | client state + `PUT` on save | live |
| Save tiles | Cosmos `replace()` | live |
| Edit JSON (raw tile array) | client state | live |
| Re-run all | `GET ?run=1` | live |

## What's intentionally honest-disabled

| Ribbon action | Reason |
|---|---|
| Add data source | Multi-cluster data source picker not yet wired |
| Parameters | Dashboard parameter editor not yet wired |
| Auto-refresh | Per-tile auto-refresh schedule not yet wired |
| Time range | Global time-range picker not yet wired |
| Share | Dashboard-share / permissions not yet wired |

## Bicep

Same backing as [KQL Database](kql-database.md) — dashboards are pure
client-side composition over the same ADX cluster.

## Env vars

Same as [KQL Database](kql-database.md).
