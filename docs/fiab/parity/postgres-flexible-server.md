# postgres-flexible-server — parity with Azure Database for PostgreSQL Flexible Server

Source UI: **Azure portal — Azure Database for PostgreSQL Flexible Server**
(`Microsoft.DBforPostgreSQL/flexibleServers`):
<https://learn.microsoft.com/azure/postgresql/flexible-server/overview>.
Create/manage: <https://learn.microsoft.com/azure/postgresql/flexible-server/quickstart-create-server-portal>.
Firewall: <https://learn.microsoft.com/azure/postgresql/flexible-server/how-to-manage-firewall-portal>.
Entra auth: <https://learn.microsoft.com/azure/postgresql/flexible-server/concepts-azure-ad-authentication>.

This is a native Azure service (not a Fabric object). Loom renders it through
the shared `UnifiedSqlDatabaseEditor` with `family = 'postgres'`. Backend is
real ARM + the real `pg` wire protocol with a Microsoft Entra access token (no
stored password).

Editor: `apps/fiab-console/lib/editors/unified-sql-database-editor.tsx`
(tabs: Connect · Provision · Query · Saved queries · Schema · Server admin ·
Catalog · Get data). Catalog: `fabric-item-types.ts` slug
`postgres-flexible-server`, category **Databases**.

## Azure/Fabric feature inventory

1. **List servers** across the subscription.
2. **Provision a new flexible server** (SKU, tier, version, admin) via ARM PUT.
3. **List / manage databases** on a server.
4. **Manage firewall rules** (`flexibleServers/firewallRules`).
5. **Run SQL** against a database (query editor).
6. **Browse schema** (tables / columns / objects).
7. **Microsoft Entra admin** management.
8. **Register the server** as a catalog (Purview/OneLake) asset.
9. High-availability / read-replica / backup config (portal Compute+Storage / HA blades).

## Loom coverage    (built ✅ / honest-gate ⚠️ / MISSING ❌)

| # | Capability | Status | Notes |
|---|---|---|---|
| 1 | List servers | ✅ | `GET /api/items/postgres-flexible-server` (ARM inventory). |
| 2 | Provision new server | ✅ | Provision tab → ARM PUT (SKU/tier/version/admin). |
| 3 | List databases | ✅ | `GET …/[id]/databases`. |
| 4 | Firewall rules | ✅ | Server-admin tab → `…/[id]/firewall` GET/POST/DELETE (ARM `Microsoft.DBforPostgreSQL/flexibleServers/firewallRules`); ARM 403 surfaced if UAMI lacks Contributor. |
| 5 | Run SQL | ✅ / ⚠️ | Query tab (Monaco) → `POST …/[id]/query` over the real `pg` wire with an Entra token. Honest gate `PG_QUERY_GATED` (503) when the console identity isn't a registered PG Entra principal (`LOOM_POSTGRES_AAD_USER` unset) — names the one-time setup, never fabricated rows. |
| 6 | Schema browser | ✅ | Schema tab object navigator over the live connection (gated behind the same PG Entra registration). |
| 8 | Catalog registration | ✅ | Catalog tab surfaces the server as a Purview/OneLake asset. |
| 7 | Microsoft Entra admin (PG) | ⚠️ | The shared Entra-admin control is wired for the `azure-sql` family; for `postgres` the server-admin surface honest-gates (PG admin is set at provision / via the PG-specific ARM path). |
| 9 | HA / read-replica / backup blades | ❌ | Not built; portal Compute+Storage/HA/Backup blades are out of current scope. |

## Backend per control

- List / provision → `app/api/items/postgres-flexible-server/route.ts` (ARM).
- Databases → `…/[id]/databases/route.ts`.
- Firewall → `…/[id]/firewall/route.ts` (ARM upsert/delete).
- Query → `…/[id]/query/route.ts` → `postgres-flex-client`
  (`getServer` resolves FQDN from ARM, `executePostgresQuery` over `pg` with an
  Entra token; `postgresQueryGate()` returns the honest 503 gate).
- All family routing (`family: 'postgres'`) and the honest-gate wording live in
  the editor header comment and `postgres-flex-client`.
