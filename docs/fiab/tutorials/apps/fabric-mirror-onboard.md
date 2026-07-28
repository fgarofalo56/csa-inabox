# Mirror Onboarding — from install to a replicated OLTP source in Bronze

Install `app-fabric-mirror-onboard` and get an **Azure SQL source replicated into your
ADLS Gen2 Bronze layer**, a **seeded Bronze lakehouse** so downstream items have real
rows immediately, and a **verification notebook** that checks row-count parity and
replication lag. **~25 minutes.**

!!! warning "Read this first — the default backend is NOT Fabric"
    The app is named for the Fabric Mirroring workflow it reproduces, and the bundle
    copy talks about OneLake. **The provisioner's default path is Azure-native:** a
    real **Azure Data Factory CDC / copy** pipeline that lands the source tables into
    ADLS Gen2 **Bronze** as Parquet — the same Bronze the Silver/Gold notebooks read —
    using the factory's managed identity on both ends.

    A Fabric Mirrored Database is an **opt-in alternative**, selected with
    `LOOM_MIRROR_BACKEND=fabric` **and** a bound workspace. If `fabric` is selected but
    no workspace is bound, the provisioner **transparently falls back to ADF CDC** —
    there is no "bind a Fabric workspace" gate anywhere on the default path.

## Prerequisites

| You need | Why | If it is missing |
| --- | --- | --- |
| A Loom workspace | Apps install into a workspace | [Tutorial 01 — First workspace](../01-first-workspace.md) |
| `LOOM_ADF_SUBSCRIPTION_ID` / `LOOM_ADF_RG` / `LOOM_ADF_FACTORY` (or `LOOM_SUBSCRIPTION_ID` / `LOOM_DLZ_RG`) | Author the Bronze copy pipeline | *"Azure Data Factory is not configured for this deployment. Set … No Microsoft Fabric required."* |
| `LOOM_ADLS_ACCOUNT` (+ optional `LOOM_BRONZE_CONTAINER`, default `bronze`) | The Bronze sink | *"No ADLS Gen2 account configured for the Bronze sink."* |
| **Your own** Azure SQL server + database | The mirror descriptor ships with editable **placeholders** | *"Mirror source server / database is not set."* |
| Factory MI granted `db_datareader` on the source **and** Storage Blob Data Contributor on the ADLS account | The copy runs as the factory's identity | Surfaced as a precise note on the row |

!!! note "The source names are placeholders, on purpose"
    `sql-retail-oltp.example.database.windows.net` / `RetailSalesOLTP` are the
    onboarding form's editable defaults, clearly labelled as placeholders in the bundle
    source. They are **not** claimed to be sourced facts. Replace them with your own
    server and database before starting replication.

## 1. Install the app

1. Left nav → **Apps** → **Fabric Mirror Onboarding**
   (`/apps/app-fabric-mirror-onboard`).
2. **Install into workspace** → workspace, optional folder (e.g. `Mirroring`).
3. **Deploy artifacts to live Azure services** → **On**. **Compute** → **Shared**.
4. **Install**.

## 2. What gets provisioned

| Item | Provisioner | Real backend |
| --- | --- | --- |
| `Retail OLTP Mirror (Azure SQL)` (`mirrored-database`) | `mirroredDatabaseProvisioner` | **Azure-native default:** an ADF linked service to the source (`AzureSqlDatabase`, `SystemAssignedManagedIdentity`), an ADF linked service to the sink (`AzureBlobFS`), a source + sink dataset **per table**, and a `<item>_to_bronze` copy pipeline landing Parquet at `<bronze-container>/<database>/<schema>/<table>` |
| `Retail Bronze Lakehouse` (`lakehouse`) | `lakehouseProvisioner` | ADLS Gen2 + managed Delta: seeds `Customers`, `Products`, `Sales` from the `examples/fabric-e2e` sample CSVs |
| `Mirror Verification` (`notebook`) | `notebookProvisioner` | Synapse nbformat artifact or Databricks SOURCE notebook |

Source tables mirrored: `dbo.Customers`, `dbo.Products`, `dbo.Sales`. Wildcards
(`dbo.*`) are **skipped with a note** — list explicit tables so the copy activity can
be built per table.

!!! info "The `mirrored_onelake` shortcut installs as pending"
    The lakehouse declares a shortcut named `mirrored_onelake` targeting
    `Files/MirroredRetailOLTP`. That is a bare target with no `repoDataset`,
    `internal://` prefix, or `publicAnonymous` flag, so the provisioner registers it
    **`pending`** with an honest gate rather than claiming it is active over an
    unreachable path. It becomes meaningful only on the opt-in Fabric leg once
    mirroring is running. On the Azure-native path, read Bronze directly — the seeded
    lakehouse tables are the real thing.

## 3. Seeded data

Three managed Delta tables seeded from the reference sample CSVs, column-for-column:

- **`Customers`** — `customer_id`, `customer_name`, `customer_segment`, `country`,
  `region`, `signup_date` (e.g. `C00001 / Customer 1 / Consumer / CA / North America /
  2021-07-17`).
- **`Products`** — from `examples/fabric-e2e/sample_data/products.csv`.
- **`Sales`** — from `examples/fabric-e2e/sample_data/sales.csv`.

The seed exists so **every downstream item renders with queryable rows immediately**,
including while a live replication is still doing its initial snapshot. It stands in
for the replicated output, and the verification notebook reads it by default
(`MIRROR_LH = "Retail Bronze Lakehouse"`), with a comment telling you to swap to the
mirror lakehouse once replication is live.

## 4. First meaningful task — point it at your source and prove parity

1. Open **`Retail OLTP Mirror (Azure SQL)`** and replace the placeholder **server** and
   **database** with your own. List the tables you actually want replicated
   (`schema.table`, no wildcards). Save.
2. Re-run the install (idempotent) or **Retry** the row so the provisioner re-authors
   the linked services, datasets, and the `_to_bronze` pipeline against your source.
3. Check the row's step log — it names each linked service, each table copy activity,
   and the resolved `<account>/<container>` sink.
4. Open **`Mirror Verification`**, attach a compute, and work through it:
   - **Cell 0 — Configuration.** Set `SOURCE_SERVER` / `SOURCE_DB` to your values.
     The JDBC URL uses **Active Directory MSI** authentication, read-only.
   - **Cell 1 — Row-count parity.** Counts each table on the source over JDBC and on
     the mirror/seeded side via the attached lakehouse. If the source is unreachable
     (no MI grant yet) the cell reports the mirror side only rather than failing the
     whole notebook — an honest partial, not a fake pass.
   - **Cell 2 — Replication health & CDC lag.** Two grounded checks: source-side
     change-feed DMVs (`sys.dm_change_feed_log_scan_sessions`,
     `sys.dm_change_feed_errors`, `sp_help_change_feed`) and the mirror-side monitoring
     surfaces. *There is deliberately no invented `_system/sync_watermark` path or
     `_last_synced_at` column — those were removed because the platform does not expose
     them.*
   - **Cell 3 — Per-table sample queries** plus a SQL spot-check, confirming
     column-level parity, not just row counts.

## 5. Verify it worked

- **Install dialog**: the mirror row is `created` and its step log lists
  `Linked service '<name>_src_sql' → <server>/<database> (factory MI auth)`,
  `Linked service '<name>_sink_adls' → <account>.dfs.core.windows.net`, and
  `Created ADF pipeline '<name>_to_bronze' with N table copy activities`.
- **ADF portal**: the pipeline exists, annotated `loom-mirror`, with a completed run.
- **Storage**: Parquet under `<bronze-container>/<database>/<schema>/<table>/`.
- **Notebook cell 1**: source and mirror counts match per table.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Row = `remediation`, "Azure Data Factory is not configured" | ADF variables unset | Set `LOOM_ADF_SUBSCRIPTION_ID` / `LOOM_ADF_RG` / `LOOM_ADF_FACTORY` (or the `LOOM_SUBSCRIPTION_ID` / `LOOM_DLZ_RG` fallback), then **Retry** |
| "No ADLS Gen2 account configured for the Bronze sink" | `LOOM_ADLS_ACCOUNT` unset | Set it (and optionally `LOOM_BRONZE_CONTAINER`) |
| "Mirror source server / database is not set" | Still on the placeholders | Edit the mirrored-database item with your real server + database |
| "No explicit source tables to copy to Bronze" | Only a wildcard (`dbo.*`) was listed | List explicit `schema.table` entries |
| Copy activity fails authenticating to the source | Factory MI has no read grant | Grant the factory's managed identity `db_datareader` on the source database |
| Copy activity fails writing Parquet | Factory MI has no storage grant | Grant **Storage Blob Data Contributor** on the ADLS account |
| Notebook cell 1 reports only the mirror side | The notebook identity cannot reach the source over JDBC | Grant the notebook's MI read access, or accept the partial — the cell is designed to degrade honestly |
| Shortcut shows `pending` | Expected on the Azure-native path | Read the Bronze tables directly; the shortcut is a Fabric-leg affordance |

## Cleanup

Delete the three items, or the workspace. **The ADF linked services, datasets, and the
`_to_bronze` pipeline persist** in the factory, and the Parquet stays in Bronze —
remove them there. The seeded Delta tables are also real ADLS objects.

## What's next

- [Lakehouse Inspector](lakehouse-inspector.md) — profile the Bronze you just landed.
- [Tutorial 06 — Mirror Cosmos DB to a Lakehouse](../06-mirroring-cosmos.md) — the
  change-feed variant of the same idea.
- [Editor guide — Mirrored database](../editor-mirrored-database.md).
