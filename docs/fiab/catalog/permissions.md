# Catalog — Permissions

Loom-native role matrix that fans out to the right back-end privileges.

## Loom role → back-end privilege mapping

| Loom role | Unity Catalog privileges | Fabric workspace role |
|---|---|---|
| **Reader** | `SELECT`, `USE_CATALOG`, `USE_SCHEMA`, `READ_VOLUME` | `Viewer` |
| **Contributor** | Reader + `MODIFY`, `REFRESH`, `WRITE_VOLUME` | `Contributor` |
| **Admin** | Contributor + `APPLY_TAG`, `EXECUTE` | `Member` |
| **Owner** | `ALL_PRIVILEGES` | `Admin` |

The mapping is enforced server-side in `app/api/catalog/permissions/route.ts → UC_PRIVS / FABRIC_ROLE`.

## Endpoints

- `GET /api/catalog/permissions?source=unity-catalog&host=<>&secType=<>&securable=<>` — read REST-style grants
- `GET /api/catalog/permissions?source=onelake&workspaceId=<>` — list Fabric workspace users
- `POST /api/catalog/permissions` body `{ source, loomRole, principal, secType?, securable?, host?, useSQL?, warehouseId?, workspaceId?, principalType? }` — grant
- `DELETE /api/catalog/permissions` same body — revoke

### UC REST vs SQL fan-out

The route supports two modes for Unity Catalog grants:

- **REST** (default) — `PATCH /api/2.1/unity-catalog/permissions/<sec>/<name>` with `{ add: […] }` / `{ remove: […] }`. Covers `SELECT`, `MODIFY`, `USE_CATALOG`, etc.
- **SQL fan-out** (set `useSQL: true` + `warehouseId`) — issues a real `GRANT … ON … TO …` statement via `executeStatement`. Required for `EXECUTE ON FUNCTION` (mask functions, row filter functions) and any privilege the REST API doesn't model. The principal is back-tick-quoted when it contains a `@`, `.`, `-`, or whitespace.

## NotConfigured

Same 501 + hint contract as the rest of the catalog. Missing UC → bicep + `LOOM_DATABRICKS_HOSTNAMES` hint. Missing Fabric tenant grant → propagates the upstream Fabric error verbatim ("tenant admin must enable 'Service principals can use Fabric APIs'").

## UI

`/catalog/permissions` → form for picking source, securable, principal, role + a per-session audit log of every grant/revoke action with the upstream API mode (`mode=rest`, `mode=sql`, `mode=fabric`).
