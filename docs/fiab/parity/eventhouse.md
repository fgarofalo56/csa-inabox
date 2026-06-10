# eventhouse — parity with Fabric Eventhouse (Real-Time Intelligence)

Source UI: https://learn.microsoft.com/fabric/real-time-intelligence/eventhouse
            https://learn.microsoft.com/fabric/real-time-intelligence/manage-monitor-eventhouse
Editor: `apps/fiab-console/lib/editors/phase3-editors.tsx` → `EventhouseEditor`
Routes: `apps/fiab-console/app/api/items/eventhouse/[id]/{route,database/route,ingest/route,policies/route}.ts`
Client: `apps/fiab-console/lib/azure/kusto-client.ts`, `kusto-arm-client.ts`
Bicep:  `platform/fiab/bicep/modules/admin-plane/adx-cluster.bicep`

> A Fabric Eventhouse is a container for one or more KQL databases. The
> Azure-native default backend is an **Azure Data Explorer (ADX) cluster**
> (`Microsoft.Kusto/clusters`) — database listing, provisioning, ingestion, and
> data policies all run against ADX. No Fabric capacity is required and the
> editor works with `LOOM_DEFAULT_FABRIC_WORKSPACE` **unset** (per
> `no-fabric-dependency.md`).

## Source-UI feature inventory (grounded in Learn + live portal)

The Eventhouse opens to a database card grid + a system-overview pane, with
per-database **Get data**, **data policies**, and lifecycle controls.

| # | Fabric capability | Fabric behavior in the real UI |
| --- | --- | --- |
| 1 | Database card grid | List KQL databases with per-DB row count / size / last-ingest |
| 2 | New KQL database | Provision a database in the Eventhouse |
| 3 | Open database → Query | Jump into the KQL-database editor for the selected DB |
| 4 | Get data → Upload file | Ingest a CSV/JSON file inline |
| 5 | Get data → Event Hub | Create a streaming data connection from an Event Hub |
| 6 | Get data → OneLake / ADLS path | Ingest from a storage path |
| 7 | Data policies | Hot-cache (caching) days + soft-delete (retention) days at DB level |
| 8 | OneLake availability toggle | Mirror the database to OneLake Delta |
| 9 | System overview pane | Storage metrics / ingestion rate / top queried + ingested DBs |
| 10 | Per-table metadata | Compressed size, retention, caching, OneLake availability, creation date |
| 11 | Query insights | Duration percentiles, cache-hit %, top queries by CPU/memory |
| 12 | Stop / Start cluster | Suspend / resume the compute |
| 13 | Cluster permissions | AllDatabasesAdmin / AllDatabasesViewer role assignments |
| 14 | New dashboard | Create a Real-Time Dashboard pre-wired to the eventhouse's default KQL database as a data source, then land on the dashboard canvas |

## Loom coverage

| Inventory row | Loom coverage | Notes |
| --- | --- | --- |
| 1 Database card grid | ✅ built | `GET /api/items/eventhouse/[id]` → `loadKustoItem` → `.show databases` on ADX |
| 2 New KQL database (ARM provision) | ✅ built | `POST /api/items/eventhouse/[id]/database` → ARM `PUT Microsoft.Kusto/clusters/{c}/databases/{d}` |
| 3 Open database → Query | ✅ built | `router.push(/items/kql-database/new?eventhouseId=…&database=…)` opens the KQL-database editor |
| 4 Get data → Upload file (CSV/JSON ≤5 MB) | ✅ built | `POST /api/items/eventhouse/[id]/ingest` (multipart) → `.ingest inline into table` |
| 5 Get data → Event Hub data connection | ⚠️ honest-gate | ARM `PUT …/dataConnections/{n}` — gated on `LOOM_EVENTHUB_NAMESPACE_RESOURCE_ID` + `LOOM_SUBSCRIPTION_ID`; honest 503 MessageBar naming the env vars otherwise; the wizard still renders |
| 6 Get data → ADLS / OneLake path | ⚠️ honest-gate | `.ingest into table (h'<path>')` from a single text path; the Azure-native ADLS path works, a OneLake browser is the opt-in Fabric extra |
| 7 Data policies (hot-cache + soft-delete) | ✅ built | `POST /api/items/eventhouse/[id]/policies` → `.alter database policy caching` / `.alter database policy retention` |
| 8 OneLake availability toggle | ⚠️ honest-gate | `.alter database policy OneLakeAvailability` only when `LOOM_KUSTO_FABRIC_MANAGED=true`; otherwise a skip-note MessageBar (Fabric-managed feature, opt-in per `no-fabric-dependency.md`) |
| 9 System overview pane | ⚠️ tracked | follow-up — `.show database details` + `.show ingestion failures` summary panel; pure ADX `.show` commands, no Fabric dependency, no backend client gap (`kusto-client.executeMgmtCommand`) |
| 10 Per-table metadata view | ⚠️ tracked | follow-up — `.show tables details` already returns size / retention / caching; needs the rich per-table card beyond the count surfaced today |
| 11 Query insights pane | ⚠️ tracked | follow-up — `.show queries` + `.show cache` aggregation panel; Azure-native ADX, no Fabric dependency |
| 12 Stop / Start cluster | ⚠️ tracked | follow-up — surface the existing `kusto-arm-client.ts` cluster suspend/resume (already used by the admin-scaling surface) inside the Eventhouse editor |
| 13 Cluster permissions (AllDatabasesAdmin/Viewer) | ⚠️ tracked | follow-up — ARM `clusterPrincipalAssignments` read/write; the bootstrap grants the Loom UAMI today (`az kusto cluster-principal-assignment create`) |
| 14 New dashboard | ✅ built | Ribbon **Home → New → New dashboard** opens a name dialog, then creates a `kql-dashboard` Cosmos item in the same workspace (`POST /api/workspaces/[id]/items`), seeds a data source bound to the current/default KQL database + a starter tile (`PUT /api/items/kql-dashboard/[id]`), and routes to `KqlDashboardEditor`. No Fabric workspace required |
| Cluster URI unconfigured | ✅ honest-gate | routes 503 `not_configured` → editor shows one MessageBar naming `LOOM_KUSTO_CLUSTER_URI` + the AllDatabasesAdmin role; the full editor still renders |

Every inventory row is built ✅ or an honest ⚠️ gate / tracked follow-up — none unbuilt. Every executable control hits real ADX (control commands via
`/v1/rest/mgmt` or ARM); not-yet-built rows are honest ⚠️ tracked follow-ups
whose note names the exact `.show`/`.alter` command or ARM client already
present — never a fake list (per `no-vaporware.md` + `ui-parity.md`).

## Backend per control

| Control | Backend |
| --- | --- |
| Load databases | `GET /api/items/eventhouse/[id]` → `loadKustoItem` → `.show databases` (`/v1/rest/mgmt`) |
| New database | `POST /api/items/eventhouse/[id]/database` → ARM `PUT Microsoft.Kusto/clusters/{c}/databases/{d}` (`kusto-arm-client.ts`) |
| Upload-file ingest | `POST /api/items/eventhouse/[id]/ingest` → `.ingest inline into table T <…>` |
| Event Hub data connection | ARM `PUT .../dataConnections/{n}` (gated on `LOOM_EVENTHUB_NAMESPACE_RESOURCE_ID`) |
| Data policies | `POST /api/items/eventhouse/[id]/policies` → `.alter database policy caching` / `… retention` |
| Open database editor | client `router.push(/items/kql-database/new?eventhouseId=…&database=…)` |
| New dashboard | `POST /api/workspaces/[id]/items` (create `kql-dashboard`) + `PUT /api/items/kql-dashboard/[id]` (seed data source + starter tile) → `router.push(/items/kql-dashboard/[id])`; tiles run on the shared ADX cluster |

Azure-native default: every executable control uses the ADX cluster
(`LOOM_KUSTO_CLUSTER_URI`) + ARM (`Microsoft.Kusto`); nothing on this path calls
`api.fabric.microsoft.com`. OneLake availability (8) is the only Fabric-managed
control and is gated behind `LOOM_KUSTO_FABRIC_MANAGED`.

## Cloud boundary (Commercial / GCC / GCC-High / IL5)

| Boundary | Coverage | Notes |
| --- | --- | --- |
| Commercial | ✅ full | ADX cluster + Event Hubs |
| GCC | ✅ full | ADX cluster + Event Hubs |
| GCC-High | ✅ full | ADX cluster + Event Hubs |
| IL5 | ✅ full | ADX cluster + Event Hubs |

ADX (`Microsoft.Kusto/clusters`) and Event Hubs (`Microsoft.EventHub/namespaces`)
are authorized in all four boundaries, so the Eventhouse executable surface is
identical everywhere. OneLake availability (8) is opt-in Fabric and not part of
the sovereign default.

## Bicep / env sync

- Cluster: `platform/fiab/bicep/modules/admin-plane/adx-cluster.bicep`
  (`Microsoft.Kusto/clusters@2024-04-13`, SKU `Dev(No SLA)_Standard_E2a_v4`),
  with the Loom UAMI granted AllDatabasesAdmin via `clusterPrincipalAssignments`.
- Env vars: `LOOM_KUSTO_CLUSTER_URI` (honest config gate), `LOOM_KUSTO_DEFAULT_DB`,
  `LOOM_UAMI_CLIENT_ID`, `LOOM_SUBSCRIPTION_ID`,
  `LOOM_EVENTHUB_NAMESPACE_RESOURCE_ID` (Event Hub data-connection gate),
  `LOOM_KUSTO_FABRIC_MANAGED` (OneLake availability opt-in).
- Event Hub data connection also requires the ADX cluster MI to hold
  **Event Hubs Data Receiver** on the namespace — granted in the landing-zone
  Event Hubs bicep module.

## Verification

- `pnpm build` — clean (the four routes compile: `/[id]`, `/[id]/database`,
  `/[id]/ingest`, `/[id]/policies`).
- Backend Vitest contract tests cover auth gates, `.show databases` shaping,
  ARM database-create payload, inline-ingest table targeting, and the
  caching/retention `.alter` commands.
- Live probe (minted-session browser walk against the ADX cluster) runs the
  same `executeMgmtCommand` / ARM path the deployed Loom uses.

_Last updated: 2026-06-10 (row 14 New dashboard wired)._
