# cdc-control-plane — parity with Debezium / Fabric Mirroring control plane

Source UI: Debezium UI + Kafka Connect connector management
(https://debezium.io/documentation/reference/stable/operations/debezium-ui.html)
and Microsoft Fabric Mirroring monitoring
(https://learn.microsoft.com/fabric/database/mirrored-database/monitor).

CSA Loom item: **N7b — CDC connector control plane** (`/cdc`). A control plane
OVER the existing Azure-native mirror engine (`lib/azure/mirror-engine.ts`): the
wizard writes the flat source config the engine already consumes; the monitor
reads the engine's real run state + the N6 dead-letter tree. No Microsoft Fabric,
no Kafka/Kafka-Connect requirement — the Loom mirror engine is the runtime.

## Debezium / Fabric feature inventory (every capability)

| # | Capability (Debezium UI / Fabric Mirroring) | Notes |
|---|----------------------------------------------|-------|
| 1 | Create a source connector from a list of connector types (SQL Server, PostgreSQL, MySQL, MongoDB, Oracle) | Debezium "Create connector" wizard |
| 2 | Connector configuration via guided form (host, database, credentials, table include list) | Debezium properties form |
| 3 | Credentials held as a secret reference, never inline | Kafka Connect secret providers / KV |
| 4 | Choose snapshot mode (initial snapshot then streaming, snapshot-only, etc.) | Debezium `snapshot.mode` |
| 5 | Select which tables/collections to capture | Debezium `table.include.list` |
| 6 | Start / stop / delete a connector | Kafka Connect connector lifecycle |
| 7 | Connector status: snapshot in progress → streaming | Debezium connector state |
| 8 | Initial-snapshot progress (% of tables loaded) | Fabric Mirroring "Monitor replication" |
| 9 | Streaming lag (how far behind the source) | Fabric replication lag / Debezium metrics |
| 10 | Per-table replication status + row counts + last-sync | Fabric per-table monitor grid |
| 11 | Schema-change events (source DDL drift) | Debezium schema-change topic |
| 12 | Dead-letter queue for rows that fail processing | Kafka Connect DLQ |
| 13 | Contract/quality enforcement at the ingest boundary | (Loom N6 — beyond Debezium) |

## Loom coverage

| # | Status | Where | Backend |
|---|--------|-------|---------|
| 1 | ✅ | `ConnectorWizard` source dropdown (`CDC_SOURCES`, 5 families) | pure registry |
| 2 | ✅ | wizard steps (host / database / credential / table picker) — dropdown + identifier fields only | `POST /api/cdc/connectors` → `validateConnectorWizard` |
| 3 | ✅ | credential field is a **Key Vault reference**; `isKeyVaultReference` rejects an inline value | validator |
| 4 | ✅ | sync-mode dropdown (incremental / snapshot / continuous) → engine `syncMode` | mirror engine |
| 5 | ✅ | table include picker, enumerated from the real source | `POST …/source-tables` → `listTables` / `listPostgresTables` |
| 6 | ✅ | Start / Stop / Delete | `POST …/state`, `DELETE …/[id]` → `runMirrorSnapshot` / `deleteOwnedItem` |
| 7 | ✅ | phase badge (`not-started`→`snapshotting`→`streaming`→`stopped`/`error`) | `deriveConnectorHealth` over real run state |
| 8 | ✅ | initial-snapshot ProgressBar (replicated / selected tables) | `deriveConnectorHealth.snapshotPercent` |
| 9 | ✅ | streaming-lag KPI (now − newest table `lastSync`) | `deriveConnectorHealth.streamingLagSeconds` |
| 10 | ✅ | per-table grid (status / mode / rows / last-sync) | engine `tablesStatus` (Cosmos) |
| 11 | ✅ | schema-change feed (table/column add/remove) | `captureSourceSchema` at Start → `foldSchemaCapture` |
| 12 | ✅ | dead-letter panel (per-dataset counts + sampled rejected rows w/ ODCS violations) | **real ADLS read** `readDeadLetter` over the N6 `_rejected` tree |
| 13 | ✅ | N6 enforcement at the Bronze boundary (warn-quarantine default) | `runMirrorSnapshot(..., { tenantId })` → `enforceOrPassThrough` (reused, not re-implemented) |

Zero ❌.

## Backend per control

- **Wizard create** → `POST /api/cdc/connectors` → `validateConnectorWizard`
  (dropdown-only, KV-ref credential) → `createOwnedItem('cdc-connector', …)`.
  The stored `state` IS the mirror engine's `MirrorSource` config.
- **Table picker** → `POST /api/cdc/connectors/[id]/source-tables` → the same
  per-family enumerators the mirror engine uses. ADF-copy families return an
  honest gate (leave empty / type entries).
- **Start** → `POST /api/cdc/connectors/[id]/state` → `runMirrorSnapshot`
  (initial snapshot → ADLS Bronze CSV, then watermark-incremental change
  capture). N6 enforcement runs INSIDE the engine at the Bronze boundary.
  Source schema is captured (`captureSourceSchema`) and diffed into the
  schema-change log.
- **Monitor** → `GET /api/cdc/connectors/[id]/monitor` → `deriveConnectorHealth`
  (phase / snapshot % / lag), the persisted `tablesStatus`, the schema-change
  log, and a **real ADLS read** of the `_rejected` dead-letter tree.

## Azure-native / no-Fabric

Every source maps to an Azure-native engine backend. **PostgreSQL** and
**SQL Server** replicate end-to-end today via the built-in TDS/pg snapshot +
change-capture engine → ADLS Bronze (Entra-token auth; no inline secret).
**MySQL / MongoDB / Oracle** replicate via the Azure-native ADF copy runtime —
Start surfaces the exact linked service to configure. `LOOM_DEFAULT_FABRIC_WORKSPACE`
is never read; no `api.fabric.microsoft.com` / `api.powerbi.com` call on any path.

## IL5 / sovereign

Full capability runs DISCONNECTED in an IL5 / air-gapped enclave: the source is
reached over its private endpoint, Bronze + the `_rejected` dead-letter tree are
the deployment's own in-boundary ADLS Gen2, N6 enforcement + alerting route
through in-boundary Cosmos + the shared Azure Monitor action group, and the
credential is an in-boundary Key Vault reference. No SaaS destination is required.

## Acceptance (per no-vaporware E2E)

Add a Postgres source in-UI → Start → watch the initial-snapshot ProgressBar
climb to 100% (per-table rows land) → phase flips to `streaming` with a measured
lag → rows are queryable in ADLS Bronze (the per-table OPENROWSET the engine
returns). A row violating a bound N6 contract appears in the dead-letter panel
(sampled from the real `_rejected/*.jsonl`) instead of corrupting Bronze.

## FLAG0

`runtimeFlag('n7b-cdc-control-plane', { default: true })` — OFF renders `/cdc` as
a guided "turned off" notice and empties the list/monitor APIs; already-started
connectors keep replicating (kill-switch is UI-scoped, never a data gate).
