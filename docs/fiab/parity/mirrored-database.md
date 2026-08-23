<!-- parity-doc-meta
Reviewed-on: 2026-08-23
Validated-against:
  - apps/fiab-console/lib/editors/components/mirror-source-wizard.tsx
  - apps/fiab-console/lib/editors/mirrored-database-editor.tsx
  - apps/fiab-console/lib/azure/mirror-engine.ts
  - apps/fiab-console/lib/install/provisioners/mirrored-database.ts
  - apps/fiab-console/app/api/items/mirrored-database
-->

# mirrored-database — parity with **Fabric Mirroring** (Azure-native: ADF CDC / snapshot → ADLS Bronze)

> Parity audit per `.claude/rules/ui-parity.md` + `.claude/rules/no-vaporware.md`
> + `.claude/rules/no-fabric-dependency.md`. Graded conservatively.

**What this is.** **Mirroring** in Microsoft Fabric continuously replicates an
external operational database (Azure SQL DB/MI, SQL Server, Snowflake, Cosmos DB,
PostgreSQL, …) into OneLake as near-real-time Delta, exposed through a SQL
analytics endpoint. CSA Loom delivers this **Azure-native**, with **no Fabric**:
the source is snapshotted/CDC'd into **ADLS Bronze** and surfaced through a
**Synapse Serverless SQL** analytics endpoint.

**Source UI (grounded in Microsoft Learn, not memory):**
- Fabric mirroring overview: https://learn.microsoft.com/fabric/database/mirrored-database/overview
- Mirror Azure SQL Database (source config + table selection): https://learn.microsoft.com/fabric/database/mirrored-database/azure-sql-database-tutorial
- Monitor mirroring (per-table replication status / metrics): https://learn.microsoft.com/fabric/database/mirrored-database/monitor
- Stop / start / manage replication: https://learn.microsoft.com/fabric/database/mirrored-database/manage
- OneLake security (Loom parity = the Security tab): https://learn.microsoft.com/fabric/onelake/security/get-started-security

**No-Fabric mapping (`no-fabric-dependency.md`).** Fabric Mirroring →
**ADF ChangeDataCapture / direct-engine snapshot → ADLS Bronze Delta**, paired
with a **Synapse Serverless SQL** analytics endpoint. No OneLake, no Fabric
capacity. Fabric hosts are never called on the default path.

**Loom surface:**
- Editor: `apps/fiab-console/lib/editors/mirrored-database-editor.tsx` — tabs
  **Mirroring · Monitor · Security**, a left tree of mirrors, and the
  `MirrorSourceWizard` for New/Edit
  (`lib/editors/components/mirror-source-wizard.tsx`), plus
  `OneLakeSecurityTab` and `OpenMirrorConfig`.
- Catalog: `apps/fiab-console/lib/catalog/item-types/data-factory.ts`
  (`slug: 'mirrored-database'`, `restType: 'MirroredDatabase'`).
- BFF: `app/api/items/mirrored-database/**` — list, `[id]` detail,
  `verify` (Test connection), `source-tables`, `[id]/state` + `[id]/lifecycle`
  (start/stop/restart), `[id]/monitor`, `[id]/sql-endpoint`, `[id]/open-mirror`.

**Backend reality check.** Everything calls real Azure: list/detail/state from
Cosmos; Start runs the real Azure-native mirror engine (TDS/PG/Cosmos snapshot →
ADLS Bronze, incremental via change-tracking watermarks) or, when
`LOOM_ADF_NAME` + linked services are configured, an **ADF ChangeDataCapture →
ADLS Bronze Delta** (the run receipt names the CDC resource). Monitor probes the
real ADLS landing folder (file/byte counts) + ADF pipeline-run telemetry.
Test connection is a real validate round-trip. The paired **Synapse Serverless
SQL** endpoint is auto-provisioned at install. No mocks; honest gates carry the
exact remediation.

---

## Fabric feature inventory → Loom coverage → backend

Legend: built ✅ · honest-gate ⚠️ · MISSING ❌

| # | Fabric Mirroring capability | Loom | Where / backend |
|---|---|---|---|
| 1 | List mirrored databases in a workspace | ✅ built | left tree → `GET /api/items/mirrored-database` |
| 2 | **New mirror wizard** — source picker | ✅ built | `MirrorSourceWizard` → `MIRROR_SOURCES` (`mirror-source-wizard.tsx:49-63`) renders **11 source cards**. Enumerated and compared type-by-type against Fabric's `SourceType` enum in [§ Mirrored source types](#mirrored-source-types) below — that table, not this row, is the source of truth for which sources exist. |
| 3 | Connection step (Key Vault-backed creds, never plaintext) | ✅ built | wizard connection step → KV connection id |
| 4 | **Test connectivity** | ✅ built | `POST …/verify` (real validate) |
| 5 | **Table include/exclude** picker | ✅ built | wizard table picker → `…/source-tables` |
| 6 | Review + Create | ✅ built | wizard create → Cosmos + provisioner |
| 7 | Edit an existing mirror's source config | ✅ built | Edit reopens the wizard pre-filled |
| 8 | **Start** replication | ✅ built | `POST …/[id]/state` / `…/lifecycle {start}` (snapshot or ADF CDC) |
| 9 | **Stop** replication (watermarks retained) | ✅ built | `…/lifecycle {stop}` + confirm dialog |
| 10 | **Restart** (clear watermarks → full re-snapshot) | ✅ built | `…/lifecycle {restart}` + confirm dialog |
| 11 | Delete a mirror | ✅ built | `DELETE …/[id]` |
| 12 | **Per-table replication status** (Running/Replicated/Error) | ✅ built | Mirroring tab + Monitor grid |
| 13 | **Metrics** — rows / bytes / last-sync | ✅ built | detail + Monitor tables (real backend) |
| 14 | Snapshot vs **incremental (CDC)** mode badge | ✅ built | per-table mode badge + watermark tooltip |
| 15 | **Monitor tab** with auto-refresh + ADF run telemetry | ✅ built | `…/[id]/monitor` every 30 s; ADF pipeline-run line |
| 16 | Landing-file probe (committed files/bytes) | ✅ built | Monitor grid landing-files column (ADLS probe) |
| 17 | **SQL analytics endpoint** over the mirror | ✅ built | paired Synapse Serverless SQL (`…/sql-endpoint`); Copy-SQL per table |
| 18 | **OneLake / data security** on the mirror | ✅ built | Security tab → `OneLakeSecurityTab` (Bronze container) |
| 19 | Open-mirror (push Parquet → managed Delta) for generic sources | ✅ built | `OpenMirrorConfig` (ADLS → Synapse Spark merge → managed Delta) |
| 20 | Snowflake Iceberg-table inclusion | ✅ built | wizard `includeIcebergTables` |
| 21 | Continuous/near-real-time streaming CDC (vs scheduled) | ⚠️ partial | snapshot + incremental + ADF CDC; `continuous` mode present, cadence gated on ADF/IR |
| 22 | Replicate DDL / schema-drift auto-evolution | ❌ MISSING | table set is explicit; schema drift not auto-applied |
| 23 | In-place data preview of mirrored data in the editor | ⚠️ partial | Copy-SQL to the paired Serverless endpoint; no inline grid preview |

**Capability table totals: 20 ✅ · 2 ⚠️ · 1 ❌ (23 rows).**

## Mirrored source types

The table above grades the *lifecycle*. It does not grade **which sources can be
mirrored**, and that omission is what made this doc wrong for six weeks: the row-2
cell listed five sources when the wizard shipped eleven, and three feature requests
(#3762 BigQuery, #3763 Oracle, #3774-adjacent) were filed against the doc for
capabilities that were already built. Source coverage now gets its own inventory.

Fabric splits mirroring into two mechanisms, and they are not interchangeable:

- **Database mirroring** — CDC/replication of an operational database. The
  authoritative list is the `SourceType` enum in the Fabric REST
  [mirrored-database definition](https://learn.microsoft.com/rest/api/fabric/articles/item-management/definitions/mirrored-database-definition#mirroreddatabase)
  (13 values), cross-checked against
  [Get started with mirroring](https://learn.microsoft.com/fabric/mirroring/get-started-with-mirroring#set-up-your-mirror).
- **Metadata / catalog mirroring** — no row copy; the item shortcuts an external
  catalog's existing Delta/Parquet storage. Different item shape, different Loom
  home. See [catalog mirroring](https://learn.microsoft.com/fabric/mirroring/catalog-mirroring/azure-monitor).

### Database mirroring — Fabric `SourceType` vs Loom

| Fabric `SourceType` | Loom | Where |
|---|---|---|
| `AzureSqlDatabase` | ✅ built | `MIRROR_SOURCES:49` · SQL Change Tracking → incremental |
| `AzureSqlMI` | ✅ built | `MIRROR_SOURCES:50` |
| `AzurePostgreSql` | ✅ built | `MIRROR_SOURCES:51` · `connTypes: ['postgres']` |
| `CosmosDb` | ✅ built | `MIRROR_SOURCES:52` |
| `Snowflake` | ✅ built | `MIRROR_SOURCES:53` · `includeIcebergTables` (row 20) |
| `GoogleBigQuery` | ✅ built | `MIRROR_SOURCES:54` · `BIGQUERY_SOURCES:67` drives a projectId/dataset connection step instead of a SQL FQDN. **Closes the premise of #3762.** |
| `Oracle` | ✅ built | `MIRROR_SOURCES:55` · `GATEWAY_SOURCES:69` drives the self-hosted-IR/gateway + sync-user step. **Closes the premise of #3763.** |
| `SqlServer2025` | ✅ built | `MIRROR_SOURCES:56` |
| `MSSQL` (SQL Server 2016-2022) | ✅ built | `MIRROR_SOURCES:57` |
| `GenericMirror` (open mirroring) | ✅ built | `MIRROR_SOURCES:58` · `OpenMirrorConfig` (row 19) |
| `AzureMySql` | ❌ MISSING | No MySQL card and no engine branch (`grep -ci mysql` = 0 on both the wizard and `mirror-engine.ts`). MySQL *is* reachable as an **eventstream** source, which is a different item and a different guarantee. |
| `SAP` | ❌ MISSING | Not modelled. |
| `SharePointList` | ❌ MISSING | Not modelled. |

**10 of Fabric's 13 database-mirroring source types built · 3 MISSING.**

### Metadata / catalog mirroring — Fabric vs Loom

| Fabric catalog source | Loom | Where |
|---|---|---|
| Azure Databricks Unity Catalog | ✅ built | A **dedicated item type**, not a `MIRROR_SOURCES` connection: the `DatabricksUC` card (`MIRROR_SOURCES:63`) carries `external: '/items/mirrored-databricks/new'` and routes to `mirrored-databricks-editor.tsx`. Correct shape — UC mounts a catalog, it does not replicate rows. |
| Azure Monitor / Log Analytics (preview) | ❌ MISSING | **This is #3764.** Fabric's item shortcuts Log Analytics' Delta Parquet tables and stands up an **Eventhouse (KQL) endpoint** over them. Loom's Azure-native equivalent under `no-fabric-dependency.md` is therefore an **ADX**-backed catalog mount — *not* a `MIRROR_SOURCES` row, because there is no CDC and no ADLS Bronze landing. Filing it against the mirror wizard would build the wrong shape. |
| Dremio (preview) | ❌ MISSING | Absent from the console entirely (`grep -rli dremio` over `lib/` + `app/` → RC=1, zero files). |

**1 of Fabric's 3 catalog-mirroring sources built · 2 MISSING.**

## Grade

**B for the lifecycle; B− overall once source coverage is counted.**

The full Fabric-Mirroring *lifecycle* — source wizard → test → table selection →
start/stop/restart → per-table status + metrics + Monitor → paired SQL analytics
endpoint → OneLake-equivalent security — is built end-to-end on **real Azure
backends with no Fabric**, and that part is genuinely strong (20 ✅ of 23).

It is not A-grade, and the previous **B+** was scored against an inventory that
undercounted the sources by half in one direction and omitted five ❌ rows in the
other. Per `ui-parity.md` a doc is A-grade only at zero ❌; this one now carries
**six** (row 22 DDL/schema-drift, plus `AzureMySql`, `SAP`, `SharePointList`,
Azure Monitor, Dremio). Ranked by real customer weight:

1. **Azure Monitor catalog mirroring (#3764)** — the only one with an open issue,
   and the one with a clean Azure-native answer (ADX over Log Analytics).
2. **`AzureMySql`** — the sole *database* source with a Loom precedent already in
   the codebase (the eventstream path), so the cheapest of the three.
3. **DDL / schema-drift auto-evolution (row 22)** — affects every source that is
   already built, so it is worth more than any single new source type.
4. `SAP`, `SharePointList`, Dremio — no demand recorded; listed so the next audit
   does not rediscover them as news.

No gap here is Fabric-gated: every one is Loom work on an Azure backend.
