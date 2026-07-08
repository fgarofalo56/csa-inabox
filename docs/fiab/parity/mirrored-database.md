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
| 2 | **New mirror wizard** — source picker | ✅ built | `MirrorSourceWizard`: Azure SQL DB/MI, SQL Server, Snowflake, Cosmos DB, PostgreSQL |
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

**Grade: B+.** The full Fabric-Mirroring lifecycle — source wizard → test →
table selection → start/stop/restart → per-table status + metrics + Monitor →
paired SQL analytics endpoint → OneLake-equivalent security — is built end-to-end
on **real Azure backends with no Fabric**. Remaining gaps (true streaming cadence,
DDL/schema-drift auto-evolution, inline data preview) are honest partials/tracked,
never Fabric-gated.
