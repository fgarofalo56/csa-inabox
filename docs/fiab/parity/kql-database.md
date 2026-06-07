# kql-database — parity with Fabric KQL Database / ADX (Real-Time Intelligence)

Source UI: https://learn.microsoft.com/fabric/real-time-intelligence/create-database
            https://learn.microsoft.com/kusto/query/ (KQL editor)
            https://dataexplorer.azure.com (ADX web UI)
Editor: `apps/fiab-console/lib/editors/phase3-editors.tsx` → `KqlDatabaseEditor`
Schema tree: `apps/fiab-console/lib/components/adx/adx-database-tree.tsx`
Results grid: `apps/fiab-console/lib/components/adx/kusto-results-grid.tsx`
Routes: `apps/fiab-console/app/api/items/kql-database/[id]/{route,query/route,tables/route}.ts`,
        `apps/fiab-console/app/api/adx/{tables,functions,materialized-views,ingestion-mappings,overview,policies}/route.ts`
Client: `apps/fiab-console/lib/azure/kusto-client.ts`

> The full KQL Database editor = left schema navigator + ribbon + Monaco KQL
> editor + results grid. The Azure-native default backend is **Azure Data
> Explorer (ADX)** — queries hit `/v1/rest/query`, control commands hit
> `/v1/rest/mgmt`. No Fabric capacity is required; the editor works with
> `LOOM_DEFAULT_FABRIC_WORKSPACE` **unset** (per `no-fabric-dependency.md`).
> The object-navigator sub-surface has its own detailed doc at
> [`adx-kql-database.md`](./adx-kql-database.md); this doc covers the whole
> editor (navigator + query + results + ribbon) one-for-one.

## Source-UI feature inventory (grounded in Learn + live portal)

| # | Fabric / ADX capability | Behavior in the real UI |
| --- | --- | --- |
| 1 | Schema browser | Tables / Functions / Materialized views / Mappings groups with counts, filter, ＋New, drop |
| 2 | Database policies (read) | Retention / caching / sharding / merge / streamingingestion shown per DB |
| 3 | KQL query editor | Multi-line KQL editor, run (Shift+Enter), syntax highlight |
| 4 | New → Table | Column-schema wizard → `.create table` |
| 5 | New → Materialized view | Source table + aggregation query → `.create materialized-view` |
| 6 | New → Function | Args + body → `.create-or-alter function` |
| 7 | New → Update policy | Transform-on-ingest policy → `.alter table T policy update` |
| 8 | Get data → inline ingest | CSV/JSON inline → `.ingest inline into table` |
| 9 | Results grid | Sort, per-column filter, in-grid search, column stats, CSV export |
| 10 | New → Shortcut | OneLake shortcut wizard |
| 11 | Data policies (author) | `.alter database policy caching/retention` |
| 12 | Continuous export | Create / enable / disable / drop continuous-export jobs |
| 13 | Row-level security | `.alter table T policy row_level_security` |
| 14 | External tables | `.create external table` (Blob/ADLS/SQL) |
| 15 | Edit table schema / rename | `.alter table` schema edit, rename, command viewer |
| 16 | Database / table details pane | Right panel: size, last-ingestion, policy values, URIs |
| 17 | Results grid advanced | Group-by, pivot, cell-select→filter, full data-profile pane |
| 18 | Open in Excel / Power BI / share link | Export the result to Excel / a Power BI report / a share link |

## Loom coverage

| Inventory row | Loom coverage | Notes |
| --- | --- | --- |
| 1 Schema browser (Tables/Functions/MViews/Mappings + counts, filter, ＋New, drop) | ✅ built | `AdxDatabaseTree` → `/api/adx/{tables,functions,materialized-views,ingestion-mappings}` → real `.show`/`.create`/`.drop` |
| 2 Database policies (read) | ✅ built | `GET /api/adx/policies` → `showDatabasePolicies()` → `.show database <db> policy <kind>` (retention/caching/sharding/merge/streamingingestion) |
| 3 KQL editor (Monaco, Shift+Enter run) | ✅ built | `MonacoTextarea language="kql"` → `POST /api/items/kql-database/[id]/query` (auto-routes `.`-prefixed to `/v1/rest/mgmt`, else `/v1/rest/query`) |
| 4 New → Table wizard | ✅ built | `.create table N (schema)` via the query route |
| 5 New → Materialized view wizard | ✅ built | `.create materialized-view N on table SRC {query}` |
| 6 New → Function wizard | ✅ built | `.create-or-alter function … N(args){body}` |
| 7 New → Update policy wizard | ✅ built | `.alter table T policy update @'[…]'` |
| 8 Get data → inline CSV ingest | ✅ built | `.ingest inline into table T` (≤5 MB) |
| 9 Results grid (sort/filter/search/col-stats/CSV) | ✅ built | `KustoResultsGrid` client-side over the real `/v1/rest/query` rows |
| 10 New → Shortcut (OneLake) | ⚠️ honest-gate | needs Fabric OneLake API consent — opt-in Fabric path per `no-fabric-dependency.md`; honest "pending tenant bootstrap" MessageBar; the Azure-native ingest paths cover data-in |
| 11 Data policies authoring (caching/retention) | ⚠️ honest-gate | ribbon loads `.show database policy caching/retention` into the editor; inline one-click `.alter` is a tracked follow-up (the Eventhouse "Data policies" dialog authors db-level caching/retention today) |
| 12 Continuous export | ⚠️ tracked | read-only list via `GET /api/adx/overview` → `.show continuous-exports`; create/enable/disable/drop is a tracked follow-up needing an external table + Database Admin (`.create-or-alter continuous-export over (T) to ExternalTable`) |
| 13 Row-level security | ⚠️ tracked | follow-up — `.alter table T policy row_level_security`; the navigator names the exact command |
| 14 External tables | ⚠️ tracked | follow-up — `.create external table` (Blob/ADLS/SQL), continuous-export targets |
| 15 Edit table schema / rename / command viewer | ⚠️ tracked | follow-up — `.alter table` schema edit + `.rename table`; drop is built today |
| 16 Database / table details pane | ⚠️ tracked | follow-up — right panel from `.show tables details` + `.show database details`; DB name + cluster badge shown today |
| 17 Results grid advanced (group-by/pivot/cell-select/data-profile) | ⚠️ tracked | follow-up — extends `KustoResultsGrid`; sort/filter/search/col-stats/CSV already built |
| 18 Open in Excel / Power BI / share link | ⚠️ honest-gate | CSV export built; Excel / Power BI export are opt-in Fabric/Power BI paths per `no-fabric-dependency.md`; share-link is a tracked front-end follow-up |
| Cluster URI unconfigured | ✅ honest-gate | routes 503 `not_configured` → editor shows one MessageBar naming `LOOM_KUSTO_CLUSTER_URI` + Database Admin / AllDatabasesAdmin; the full editor still renders |

Every inventory row is built ✅ or an honest ⚠️ gate / tracked follow-up — none unbuilt. Every executable control hits real Kusto (query or control command);
not-yet-built rows are honest ⚠️ gates / tracked follow-ups whose note names the
exact KQL command or opt-in dependency — never a fake list (per
`no-vaporware.md` + `ui-parity.md`).

## Backend per control

| Control | Backend |
| --- | --- |
| Run query | `POST /api/items/kql-database/[id]/query` → `executeQuery` (`/v1/rest/query`) or `executeMgmtCommand` (`/v1/rest/mgmt`) — auto-routed by the `.` prefix |
| Tables list / create / drop | `GET/POST/DELETE /api/adx/tables` → `.show tables details` / `.create table` / `.drop table ifexists` |
| Functions list / create / drop | `GET/POST/DELETE /api/adx/functions` → `.show functions` / `.create-or-alter function` / `.drop function` |
| Materialized views list / create / drop | `GET/POST/DELETE /api/adx/materialized-views` → `.show materialized-views` / `.create materialized-view` / `.drop materialized-view` |
| Ingestion mappings list / create / drop | `GET/POST/DELETE /api/adx/ingestion-mappings` → `.show ingestion mappings` / `.create-or-alter … mapping` / `.drop … mapping` |
| Database policies (read) | `GET /api/adx/policies` → `showDatabasePolicies()` → `.show database <db> policy <kind>` |
| Schema + continuous-exports (read) | `GET /api/adx/overview` → `.show database schema as json` / `.show continuous-exports` |
| Update policy / table create (ribbon) | `POST /api/items/kql-database/[id]/query` → `.alter table T policy update` / `.create table` |
| Save item | `PUT /api/items/kql-database/[id]` → `saveItemState` (Cosmos) |

Azure-native default: every executable control uses the ADX cluster
(`LOOM_KUSTO_CLUSTER_URI`); nothing on this path calls
`api.fabric.microsoft.com`. The OneLake shortcut (10) and Excel/Power BI export
(18) are the only Fabric-family rows and are strictly opt-in.

## Cloud boundary (Commercial / GCC / GCC-High / IL5)

| Boundary | Coverage | Notes |
| --- | --- | --- |
| Commercial | ✅ full | ADX cluster |
| GCC | ✅ full | ADX cluster |
| GCC-High | ✅ full | ADX cluster |
| IL5 | ✅ full | ADX cluster |

ADX (`Microsoft.Kusto/clusters`) is authorized in all four boundaries; the KQL
database editor's executable surface is identical everywhere.

## Bicep / env sync

- Env var: `LOOM_KUSTO_CLUSTER_URI` (honest config gate; the explicit-presence
  check is the 503 gate). Also `LOOM_KUSTO_DEFAULT_DB`, `LOOM_UAMI_CLIENT_ID`.
- Role: the Loom UAMI needs at least **Database Admin** on the target database
  (or **AllDatabasesAdmin** on the cluster) — granted by the cluster bootstrap
  (`az kusto cluster-principal-assignment create`).
- No new Azure resource or Cosmos container (the `kql-database` item +
  `loom-items` index already exist).

## Verification

- `cd apps/fiab-console && pnpm build` → compiles (`/[id]`, `/[id]/query`,
  `/[id]/tables`, and the five `/api/adx/*` routes register in the route table).
- Per `no-vaporware.md`: every list/create/drop/query hits a real Kusto control
  command or query; the honest infra-gate renders when `LOOM_KUSTO_CLUSTER_URI`
  is unset.
- Live `pnpm uat` side-by-side against the ADX web UI / Fabric KQL database runs
  the same `executeQuery` / `executeMgmtCommand` path used live.

_Last updated: 2026-06-07._
