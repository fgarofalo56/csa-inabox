# mirrored-database — connection source-type parity with Fabric Mirroring

Source UI: <https://learn.microsoft.com/en-us/fabric/mirroring/overview> ("Types
of mirroring" → the supported-platform table), plus the ADF connector reference
that backs Loom's Azure-native path:
<https://learn.microsoft.com/en-us/azure/data-factory/connector-snowflake>.

Fetched 2026-08-24. Loom implements mirroring **without Microsoft Fabric**
(`no-fabric-dependency.md`): the canonical backend for `mirrored-database` is
ADF CDC / Copy → ADLS Bronze Delta/Parquet.

---

## The defect this doc records

The operator tried to create a mirrored database for Snowflake. The wizard asked
for a connection; "New connection" opened a source-type dropdown that contained
**Azure services only** — no Snowflake. The primary flow of a catalog item type
could not be completed.

That is a dead-end bind under `auto-bind-by-default.md` (a surface that demands a
connection and offers no way to create the one it needs) and vaporware under
`no-vaporware.md` (an offered item type whose flow cannot complete).

Two further defects were found in the same path and are fixed here:

- **The Iceberg toggle changed nothing.** `includeIcebergTables` was declared on
  `MirrorSource` and plumbed through five API routes, but `mirror-engine.ts`
  contained exactly one occurrence of it — the interface field. The engine never
  read it.
- **Snowflake mirroring could never start.** Table enumeration had no Snowflake
  branch (it fell through to "can't be enumerated here"), while
  `runMirrorAdfCopy` refused to run with an empty table list. A closed loop.

---

## Fabric mirroring source inventory vs Loom

| Fabric platform | Fabric mirroring type | Loom source card | Loom connection type | Status |
|---|---|---|---|---|
| Azure SQL Database | Database | `AzureSqlDatabase` | `azure-sql` | ✅ |
| Azure SQL Managed Instance | Database | `AzureSqlMI` | `azure-sql` / `generic-sql` | ✅ |
| SQL Server | Database | `MSSQL`, `SqlServer2025` | `generic-sql` | ✅ |
| Azure Database for PostgreSQL | Database | `AzurePostgreSql` | `postgres` | ✅ |
| Azure Cosmos DB | Database | `CosmosDb` | `cosmos` | ✅ |
| Azure Databricks | Metadata | `DatabricksUC` → dedicated `mirrored-databricks` item | n/a (UC catalog mount) | ✅ |
| **Snowflake** | Database | `Snowflake` | **`snowflake`** (added) | ✅ |
| **Google BigQuery** (preview) | Database | `GoogleBigQuery` | **`bigquery`** (added) | ✅ |
| **Oracle** | Database | `Oracle` | **`oracle`** (added) | ✅ |
| Open mirrored databases | Open mirroring | `GenericMirror` | any lake/db type | ✅ |
| **Azure Database for MySQL** (preview) | Database | ❌ no source card | **`mysql`** (added) | ⚠️ connection only |
| Dremio catalog (preview) | Metadata | ❌ | ❌ | ❌ |
| SAP (Datasphere) | Database | ❌ | ❌ | ❌ |
| SharePoint List (preview) | Database | ❌ | ❌ | ❌ |
| Fabric SQL database | Database (auto) | n/a | n/a | n/a — Fabric-internal; out of scope per `no-fabric-dependency.md` |

**Before:** connection source types = 12, all Azure. Three Loom source cards
(Snowflake, BigQuery, Oracle) had **no creatable connection type at all** — their
`connTypes` pointed at `generic-sql` and the string `'connection-string'`, which
is an *auth method*, not a connection type, so it could never match.

**After:** connection source types = 16. Every non-external source card in
`MIRROR_SOURCES` has at least one creatable connection type, asserted by a test
that iterates `MIRROR_SOURCES` rather than a hard-coded list.

**Still ❌:** Dremio, SAP and SharePoint List have neither a source card nor a
Loom engine. They are **not** claimed as supported anywhere in the product; this
row is the tracked gap, not a silent omission.

---

## Snowflake — Loom coverage per control

| Capability | Loom | Backend |
|---|---|---|
| Create a Snowflake connection | ✅ | `POST /api/connections` → Cosmos metadata + Key Vault secret |
| Account identifier | ✅ | `host` → ADF `accountIdentifier` |
| Warehouse | ✅ | `warehouse` → ADF `warehouse` |
| Database | ✅ | `database` → ADF `database` |
| Role | ✅ | `role` → ADF `role` |
| Schema (session default) | ✅ | `schema` |
| Basic auth (user + password) | ✅ | ADF `authenticationType: Basic`, `password` |
| Key-pair auth (PEM private key) | ✅ | ADF `authenticationType: KeyPair`, `privateKey` |
| Test connection | ⚠️ reachability only | HTTPS round-trip to `<account>.snowflakecomputing.com`; the login itself is exercised by the linked service at Start, and the message says so |
| Bind a linked service | ✅ **auto** | `snowflake-adf.ensureSnowflakeBinding` upserts a `SnowflakeV2` linked service named after the Loom connection |
| List tables | ✅ | ADF Lookup over `INFORMATION_SCHEMA.TABLES` via the same linked service |
| Include Iceberg tables | ✅ | `IS_ICEBERG` column; filters both the wizard's offered list and the engine's replicated set |
| Sync mode — snapshot | ✅ | one pipeline run, **no** trigger |
| Sync mode — incremental | ✅ | `ScheduleTrigger` at `LOOM_MIRROR_COPY_CADENCE` (default 1h) |
| Sync mode — continuous | ✅ | `TumblingWindowTrigger`, 15-minute floor, `maxConcurrency: 1` |
| Replicate to Bronze | ✅ | delete-then-copy → Parquet in ADLS Bronze |
| Report run outcome | ❌ **#4025** | reports `Running` on submit without polling — see below |


### Honest limitation, stated in-product

On the ADF Copy backend, **`incremental` means "re-copied on a schedule", not
row-level change capture** — the ADF Snowflake connector exposes no CDC source,
so every run is a delete-then-copy full refresh. The three modes differ in the
ADF artifacts they create (none / schedule / tumbling window), which is real and
inspectable in the factory, but they do not differ in how much data moves.
Snowflake `CHANGES`/stream-based row-level deltas are a tracked follow-up.

The wizard's per-source sync note says exactly this rather than implying more
(`deploy-integrity.md` R7).

---

## Auto-bind: what the platform now does for the user

Per `auto-bind-by-default.md` §5, `LOOM_MIRROR_SNOWFLAKE_LINKED_SERVICE` is no
longer a prerequisite — it is an **override** for brownfield estates with a
hand-tuned linked service (private endpoints, self-hosted IR). When unset:

1. Loom upserts a `loom_key_vault` linked service (factory managed identity).
2. Loom upserts a `SnowflakeV2` linked service named after the Loom connection,
   referencing the credential as an `AzureKeyVaultSecret` — a secret **name**.
3. Both upserts are unconditional on every Start, so a linked service deleted or
   edited out-of-band self-heals (§3).

The credential therefore never leaves Key Vault and never lands in a
linked-service definition. That requires the factory MI to hold **Key Vault
Secrets User** on the Loom vault — deployed by
`platform/fiab/bicep/modules/admin-plane/adf-keyvault-rbac.bicep`, wired for both
the single-sub and multi-sub DLZ topologies.

Remaining honest gates (things the platform genuinely cannot do for the user):
the connection itself must exist and must carry account / database / warehouse /
user, since only the operator knows those values.

**The Key Vault grant must be confirmed at deploy time.** The new
`adf-keyvault-rbac.bicep` module takes its branch in none of the checked-in
param files — the same gating as the pre-existing sibling `aoai-spark-rbac` it
was modelled on, so this is not new drift, but it does mean the grant is not
proven by any param file in the repo. The credential path has **no fallback**
when it is missing: the linked service upsert still succeeds and the copy then
fails at run time with a Key Vault authorization error, which per **#4025** Loom
currently reports as `Running`.


---

## Live-failure modes an operator must know about

Three things fail at run time in ways the UI does not currently make obvious.
They are listed here because each one looks like a different problem than it is.

### 1. `CREATE STAGE` is required, and its absence is not a permissions error you will recognise

The ADF Copy activity creates an external stage with a SAS URI to unload from
Snowflake. The connection's role therefore needs `CREATE STAGE` on the schema in
addition to `USAGE` on the database/schema and `SELECT` on the tables. Without
it the copy fails *after* enumeration has already succeeded, so the table list
looks healthy.

### 2. `INFORMATION_SCHEMA.TABLES` is privilege-filtered — zero rows, not an error

A role with no grants gets an **empty result set**, not a failure. Reported
bare, "no tables found" is indistinguishable from an empty database and sends
you to look at the wrong thing.

Loom now discriminates these: the enumeration pipeline carries a second
`CountSchemas` Lookup in the *same* run, and the gate message distinguishes
"the role cannot see ANY schema in this database — this is a grants problem"
from "no tables across the N schemas the role can see". When the probe itself
cannot be read the count is `null` and the message says the ambiguity is
unresolved rather than asserting either cause (`deploy-integrity.md` R7).

### 3. Loom reports `Running` without polling — watch the ADF monitor, not the badge

`runMirrorAdfCopy` returns `ok: true, status: 'Running'` immediately after
submitting the pipeline. Every run-time failure — Key Vault authorization, a
missing `CREATE STAGE`, a suspended warehouse, an unreachable source — surfaces
in Loom as **success**, with the per-table grid showing `replicated` and
`rows: 0`.

This predates the connection work and is tracked in **#4025**. Until it is
fixed, validate a mirror by looking at the ADF monitor (the pipeline name is in
the run note), not the Loom status badge.

---

## Cloud parity

Every mechanism used here — ADF `SnowflakeV2` connector, Lookup activity,
schedule and tumbling-window triggers, Key Vault linked services, and the
`4633458b-…` Key Vault Secrets User role GUID (global across clouds) — is
available in Azure Government as well as Commercial. Nothing on this path
depends on a Commercial-only service.

**Verified against:** Commercial and Gov — **neither**, at time of writing. This
change is merged, not deployed; see the PR body for the exact verification state
and what a live Snowflake account is needed for.
