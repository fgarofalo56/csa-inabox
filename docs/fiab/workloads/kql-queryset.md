# KQL Queryset editor

A **KQL Queryset** is a named collection of saved KQL queries (think
"queries.json" file in a Fabric workspace). The Loom editor stores the
queries on the parent Cosmos item record (`state.queries`) and executes
them against the same shared ADX cluster as the KQL Database editor.

## Backend

| Layer | Implementation |
|---|---|
| Persistence | Cosmos DB `items` container, `state.queries: [{title, kql, database?}]` |
| Execution | Same ADX REST endpoints as KQL Database editor |
| BFF routes | `GET /api/items/kql-queryset/[id]`, `PUT /api/items/kql-queryset/[id]` (save array), `POST /api/items/kql-queryset/[id]/run` (run by index or ad-hoc kql) |

## What works today

| Action | Backend call | Status |
|---|---|---|
| Read saved queries | Cosmos read | live |
| Add / rename / delete query | client state + `PUT` on save | live |
| Save queries (Ctrl+S or button) | Cosmos `replace()` | live |
| Run current query | `/v1/rest/query` (or `/mgmt` if starts with `.`) | live |
| Run saved query by index | Same | live |
| Unsaved-edit protection on switch | client guard with `window.confirm` | live |

## What's intentionally honest-disabled

| Ribbon action | Reason |
|---|---|
| Cancel running query | KQL query cancellation REST API not yet wired |
| Save to dashboard | Pin-to-KQL-Dashboard handoff not yet wired |
| Set alert | Activator rule from query not yet wired |

## Bicep

- Cluster + databases: same as [Eventhouse](eventhouse.md)
- Cosmos `items` container: `platform/fiab/bicep/modules/admin-plane/cosmos.bicep`

## Env vars

Same as [KQL Database](kql-database.md). No extra config required.
