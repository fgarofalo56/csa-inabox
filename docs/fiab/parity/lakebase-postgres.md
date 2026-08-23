<!-- parity-doc-meta
Reviewed-on: 2026-08-23
Validated-against:
  - apps/fiab-console/lib/editors/lakebase-editor.tsx
  - apps/fiab-console/app/api/items/lakebase-postgres
-->

# lakebase-postgres — parity with the Azure Database for PostgreSQL Flexible Server portal blade

**Source UI:** Azure portal — Azure Database for PostgreSQL Flexible Server
<https://learn.microsoft.com/azure/postgresql/configure-maintain/how-to-manage-server-portal>
Supporting (per-row URLs cited in the table):
<https://learn.microsoft.com/azure/postgresql/overview>
· <https://learn.microsoft.com/azure/postgresql/high-availability/concepts-high-availability>
· <https://learn.microsoft.com/azure/postgresql/read-replica/concepts-read-replicas>
· <https://learn.microsoft.com/azure/postgresql/backup-restore/concepts-backup-restore>
· <https://learn.microsoft.com/azure/postgresql/parameters/concepts-parameters>
· <https://learn.microsoft.com/azure/postgresql/monitor/concepts-query-performance-insight>

Secondary reference: **Databricks Lakebase** (the OLTP-on-the-lakehouse shape this
item is named for) — available as an explicit opt-in backend.

**Surface file:** `apps/fiab-console/lib/editors/lakebase-editor.tsx` (645 lines)
**Existing test:** `lib/editors/__tests__/lakebase.test.tsx`
**Route:** `/items/lakebase-postgres/[id]`

**Companion doc (different scope, not a duplicate):**
`docs/fiab/parity/lakebase.md` is the **UX-Wave-3 lift** record — it grades this
surface against the `ux-standards.md` §7 editor checklist and documents what the
UX wave changed. It does **not** contain an Azure-portal feature inventory, so it
does not satisfy the `ui-parity.md` per-slug requirement on its own. This file is
that deliverable: the portal blade, row by row.

## Portal-blade inventory and Loom coverage

| # | Azure portal capability | Loom | Evidence / gap |
|---|---|---|---|
| 1 | **Overview** blade: server details, status, connection info | built | Overview tab + docked `DetailsPanel` (state, version, compute SKU, storage GiB, HA, region, pgvector). |
| 2 | Overview: **Reset password** | **MISSING** | No credential management. |
| 3 | Overview: **Delete** (type-name confirmation) | partial | The Loom item can be deleted; whether that deletes the Azure server is not surfaced, and there is no type-name confirmation for a destructive Azure operation. |
| 4 | Overview: **Stop / Start / Restart** compute | **MISSING** | No lifecycle control. Azure auto-restarts a stopped server after 7 days; a user cannot stop one from Loom to save cost. |
| 5 | **Connect** page: `libpq` variables, bash strings, port 5432 / **6432** PgBouncer | built (exceeds) | `DetailsPanel` **Endpoints** section renders three copyable values: server FQDN, a full connection string with `sslmode=require`, and a ready `psql` command. More directly usable than the portal's page. **Gap:** the **6432 PgBouncer** pooled port is not offered. |
| 6 | **Compute + storage**: tier (Burstable / General Purpose / Memory Optimized), vCores, storage size, IOPS, performance tier | partial | Compute SKU and storage are **shown** in the details panel and are settable **at provision time** via the wizard (`catalog` drives the dropdowns). There is **no scale-after-creation path** — the single most-used blade on a running server. |
| 7 | Storage **autogrow** toggle | **MISSING** | Not exposed. |
| 8 | **High availability**: enable/disable, zone-redundant vs same-zone | partial | Selectable in the provision wizard (`catalog.ha`) and shown in details; **not changeable** on an existing server. |
| 9 | **Backup and restore**: retention 7-35 days, geo-redundant, **point-in-time restore** | partial | PITR exists in the strongest form — `POST …/snapshot` then `POST …/branches` creates a **branch server from a snapshot**, which is Lakebase-style branching *built on* PITR and is better than the portal's restore flow for dev/test. But backup **retention**, **geo-redundancy**, and a plain restore-in-place are not configurable. |
| 10 | **Read replicas**: create up to 5, cross-region, **Promote** | partial | `GET/POST …/replicas` lists and creates real replicas. **No promote**, no cross-region choice, no replica count guard. |
| 11 | **Virtual endpoints** (stable read-write / read-only that follow the role) | **MISSING** | Not modelled. Without promote (row 10) this matters less, but both are needed for a real failover story. |
| 12 | **Networking — private access (VNet integration)**, delegated subnet + Private DNS | partial | The deployment provisions into the hub VNet with private endpoints by construction (`auto-bind-by-default.md`), so the *outcome* is right — but the surface exposes no networking view, so a user cannot confirm or inspect it. |
| 13 | **Networking — Private Link / private endpoint** | partial | Same as row 12. |
| 14 | **Networking — public access + firewall rules** | **MISSING** | Deliberately: Loom's posture is private-only. Recorded because the portal exposes it. |
| 15 | **Server parameters** grid (searchable, static vs dynamic) | **MISSING** | No parameter surface at all. `pg_qs.*`, `pgbouncer.enabled`, `index_tuning.*` are unreachable from Loom. |
| 16 | **Extensions allow-list** (`azure.extensions` multi-select) | partial | **pgvector specifically** is enabled with one action (`POST …/pgvector {action:'enable'}`), which is the common case and is better than hunting through a parameter grid. **No other extension** (PostGIS, pg_cron, pgaudit, DiskANN) can be allowed from Loom. |
| 17 | **Security → Authentication** mode + **Entra admins** picker | **MISSING** | Not exposed. Loom's deployment is Entra-based, but the surface neither shows the mode nor manages admins. |
| 18 | Data encryption / CMK | **MISSING** | Not exposed. |
| 19 | **Monitoring → Metrics** (+ enhanced metrics opt-in) | **MISSING** | No metrics on this surface. |
| 20 | **Monitoring → Diagnostic settings / logs** | **MISSING** | Not exposed. |
| 21 | **Query Performance Insight**: long-running queries, wait statistics, top queries by calls / data / IOPS / temp files | **MISSING** | Nothing. For a database surface this is the largest observability gap — you can run a query but cannot see why the server is slow. |
| 22 | Query Store + index tuning parameters | **MISSING** | Consequence of row 15. |
| 23 | **Databases** list | built | `DetailsPanel` **Databases** section with find-by-name and switch-working-database. |
| 24 | **Maintenance window** (system-managed or custom schedule) | **MISSING** | Not exposed. |
| 25 | **Major version upgrade** | **MISSING** | Not exposed. |
| 26 | **Automation → Tasks** | **MISSING** | Not exposed. |
| 27 | Ad-hoc **query execution** | built (exceeds portal) | `POST …/query` over the **pg wire protocol**, 60 s timeout, results through the shared **`PreviewTable`** (type badges + timing + row count + command). The Azure portal has **no query editor at all** for PostgreSQL — this is a capability Azure does not ship. |
| 28 | **pgvector kNN search UI** | built (Loom-only) | `POST …/pgvector {action:'search'}` with table, vector column, distance metric, and limit — results through `PreviewTable`. No Azure portal equivalent. |
| 29 | **Provision from the surface** (create the server) | built (exceeds) | `POST …/provision` performs a real ARM PUT from a typed wizard — `auto-bind-by-default.md` satisfied: creating the Loom item leads to a real Flexible Server with no portal round-trip. |
| 30 | **Backend choice**: Azure PostgreSQL (default) vs Databricks Lakebase (opt-in) | built (Loom-only) | Inline policy pencil in the `DetailsPanel`. `no-fabric-dependency.md` posture is correct — Azure-native is the default. |

## Totals

**7 built (3 of them exceeding the portal, 2 Loom-only) · 8 partial · 15 MISSING — 30 rows.**

> **Corrected 2026-08-23.** This line previously read *"9 built (4 of them
> exceeding the portal, 2 Loom-only) · 7 partial · 14 MISSING"*. The row total
> (30) was right, which is why the error survived — but the split was wrong in
> three of four cells. Recounted mechanically from the coverage column of the
> table above: **built** = rows 1, 5, 23, 27, 28, 29, 30; **partial** = rows 3, 6,
> 8, 9, 10, 12, 13, 16; **MISSING** = rows 2, 4, 7, 11, 14, 15, 17, 18, 19, 20,
> 21, 22, 24, 25, 26. The "exceeding" count of 4 also disagreed with the
> Assessment section below, which says **three** — the Assessment was right
> (rows 5, 27, 29).

## Scope note — why this grades against Azure PostgreSQL, not Databricks Lakebase

Recorded because #3778 proposed re-baselining the whole doc against the
**Databricks Lakebase GA-on-Azure** surface. That is deliberately not what this
doc measures, and the reason is a die-hard rule rather than a preference.

`no-fabric-dependency.md` requires the **Azure-native backend to be the default**
and any vendor backend to be strictly opt-in. For this item the default is Azure
Database for PostgreSQL Flexible Server; Databricks Lakebase is the opt-in
alternative, selected by the inline policy pencil in row 30. Grading the surface
against Lakebase would score Loom against the backend most customers never
select, and — under `cloud-parity.md` — against one **not available in Azure
Government at all**, which would make the resulting grade meaningless for
sovereign boundaries. The portal blade is the correct baseline.

Two things follow, both of which are real work and neither of which is a
re-baseline:

1. **Lakebase-specific capabilities deserve their own rows**, in a clearly
   marked opt-in-backend section, graded separately so the default-path grade
   stays interpretable. Row 30 currently records only that the choice exists.
2. **The row-9 branching story is already Lakebase-shaped** — snapshot → branch
   server via PITR — and is called out as exceeding the portal. That is the
   pattern to extend, and it works on the Azure-native default.

If the operator wants the Lakebase-GA inventory regardless, it should land as a
sibling doc (`docs/fiab/parity/lakebase-databricks.md`), not as a rewrite of this
one. **This is a judgement call, flagged for the operator rather than actioned.**

## ux-baseline §7 spot-check

| Bar | Status |
|---|---|
| `ItemEditorChrome` + ribbon (Data / Lifecycle groups) + `SC-9` command search | built |
| `TeachingBanner` (dismiss-persisted) | built |
| `GuidedEmptyState` on the no-server Overview (Provision / Bind existing / Ask Copilot / Learn more — each a real action) | built |
| `DetailsPanel` with copyable endpoints + inline-editable policies (SC-2) | built |
| Query and pgvector results through shared **`PreviewTable`** | built |
| Tabs: Overview / Provision / Query / Branches / … | built |
| Honest gates (Databricks backend, query gate) | partial — Fluent `MessageBar`s, **not** the shared `HonestGate`: no inline **Fix it**, no gate-registry entry (**G2**). |
| SC-10 entity/relationship diagram | **MISSING** — acknowledged in `lakebase.md`; needs a schema-introspection backend call. |
| G3 `SplitPane` + persisted `sizingKey` | **MISSING** — `splitKeyPrefix` is not passed to `ItemEditorChrome` here (the sibling `feature-table` and `sql-lab` editors do pass it). |

## Backend per control

| Control | Call | Real backend |
|---|---|---|
| Load / Refresh | `GET /api/items/lakebase-postgres/:id` | Cosmos + live ARM read |
| Provision status | `GET …/provision` | **ARM** (Flexible Server) |
| **Provision** (wizard) | `POST …/provision` | **ARM PUT** — real server creation |
| Policy pencils (working DB, backend) | `PATCH …/:id` | Cosmos |
| **Query** | `POST …/query` (60 s) | **PostgreSQL wire protocol** |
| **Snapshot** | `POST …/snapshot` | ARM / PITR |
| **Branch** | `POST …/branches` | New server from snapshot (PITR) |
| **Replicas** | `GET/POST …/replicas` | ARM read replicas |
| **pgvector** enable / search | `POST …/pgvector` | `CREATE EXTENSION` / real kNN query |

Real backend on every control. No mocks. No Fabric host contacted —
`no-fabric-dependency.md` satisfied (Azure PostgreSQL is the default; Databricks
Lakebase is opt-in).

## Assessment

**B for what it does; C against the portal blade.** The surface is one of the
better-built editors in this batch — guided empty state, real details panel with
copyable endpoints, `PreviewTable` on both result grids, and a provision path
that creates a real ARM server with no portal round-trip. Three capabilities
genuinely **exceed** the Azure portal: an in-product query editor (the portal has
none for PostgreSQL), a pgvector kNN search UI, and snapshot-branching as a
first-class action.

The gap is **day-2 operations**, and it is systematic rather than incidental —
almost everything the portal offers on a *running* server is absent:

1. **Row 21 — no Query Performance Insight.** You can run a query but cannot see
   long-running queries, wait statistics, or top consumers. On a database
   surface this is the biggest single omission.
2. **Rows 6/8 — configuration is provision-time only.** Compute, storage, and HA
   can be chosen when creating and never changed. Scaling is the portal's
   most-used blade.
3. **Row 4 — no stop/start.** A cost lever the portal makes one click.
4. **Rows 15/16 — no server-parameters grid; only pgvector among extensions.**
5. **Rows 10/11 — replicas can be created but not promoted**, and there are no
   virtual endpoints, so there is no complete failover story.
6. **Rows 19/20 — no metrics, no diagnostic settings.**

Cheapest high-value additions: **row 5's 6432 PgBouncer string** (one more
`DetailsPanel` row), **row 4 stop/start** (two ARM calls), then row 6 scaling.

## Verification

- **V3 (in-browser click-walk): OWED — but no longer blocked.** This doc
  previously recorded `loom-ui-verify` as "red since 2026-08-04 (FINISHLINE C13);
  GitHub Actions degraded". Measured 2026-08-23, that is no longer true: the
  workflow produced a **success on 2026-08-15T23:59:20Z** against `main` (its
  most recent run, 2026-08-17, failed — so it is flaky, not down). The walk is
  runnable today and simply has not been run for this surface:
  ```bash
  gh workflow run loom-ui-verify.yml --ref main -f target_route=/items/lakebase-postgres/<id>
  ```
  The walk must cover the full lifecycle — provision → query → snapshot → branch
  → replica → pgvector enable → kNN search — because the tabs only make sense in
  sequence, and provision is an ARM PUT that cannot be verified any other way.
- Coverage read from source; static evidence only (`no_scaffold_claims`).
