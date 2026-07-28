# loom-migrate — estate-assessment reader (M1)

The backend of the CSA Loom **inbound-migration on-ramp**. An internal-ingress
Container App the Console BFF (`/api/migrate/assess`) calls to **enumerate** a
source estate and hand back a canonical inventory the console's assessment
engine (`apps/fiab-console/lib/migrate/assessment.ts`) turns into a
**migration-readiness report** — every schema, table, model, notebook, and
report mapped to a Loom item type with a `1:1` / `needs-review` effort flag.

## Sources

| `sourceType`     | Enumerated via                                   | Connection prerequisite                     |
|------------------|--------------------------------------------------|---------------------------------------------|
| `snowflake`      | SQL REST API over `INFORMATION_SCHEMA`           | `host`, `token`, `catalog` (database)       |
| `databricks-uc`  | Unity Catalog REST (`/api/2.1/unity-catalog/*`)  | `host` (workspace URL), `token` (PAT); opt. `catalog` |
| `fabric`         | Fabric REST (`/v1/workspaces/{id}/items`)        | `workspaceId`, `token` (Fabric bearer)      |
| `powerbi`        | Power BI REST (`/v1.0/myorg/groups/{id}/*`)      | `workspaceId` (group), `token` (PBI bearer) |

Every connector makes a **real REST call** to the source — no mock data. When a
connection prerequisite is missing the connector returns an **honest gate**
naming exactly what to supply (never a fabricated count).

**No-Fabric-dependency:** the `fabric` / `powerbi` connectors reach
`api.fabric.microsoft.com` / `api.powerbi.com` (or the sovereign-cloud host you
pass as `apiBase`) **only as an inbound migration source** — an operator
explicitly picks that source type and provides credentials. Loom itself needs no
Fabric.

## Endpoints

- `GET /health` — liveness / readiness.
- `GET /capabilities` — which source connectors this build ships.
- `POST /enumerate` — `{ sourceType, connection }` → `{ ok, inventory }`, or
  `{ ok:false, gated:true, gate:{ prerequisite, message } }` when the source
  needs credentials.

## Security

- **Internal ingress only.** The Console BFF is the sole door and audits every
  assessment.
- The reader holds **no standing source credentials**. Each request carries the
  source connection (URL + a bearer the BFF resolved from Key Vault); it is used
  for that one enumeration and kept nowhere.

## Deploy

`platform/fiab/bicep/modules/data-plane/loom-migrate-aca.bicep` (out-of-band
standalone entrypoint; `admin-plane/main.bicep` is at the 256-param ceiling),
then set `LOOM_MIGRATE_URL` on the Console app. Unset → `/admin/migrate` still
renders (guided empty state) and the assess route honest-gates with a Fix-it.
