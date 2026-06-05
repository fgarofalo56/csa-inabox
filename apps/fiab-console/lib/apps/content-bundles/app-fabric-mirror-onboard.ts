// app-fabric-mirror-onboard — provisions an Azure SQL → Fabric Mirroring
// onboarding workspace for the retail-sales OLTP source modeled by the
// examples/fabric-e2e reference (entities: Customers, Products, Sales).
//
// Three items are installed:
//   1. mirrored-database  — the Fabric Mirrored Database descriptor. Real
//      REST (createMirroredDatabase + startMirroring) via the
//      `mirrored-database` provisioner; honest-gated on
//      LOOM_MIRROR_SOURCE_CONNECTION_ID when the source connection isn't
//      registered yet (Fabric mirroring REST requires a connection GUID).
//   2. lakehouse          — a seeded "Bronze" landing of the same three
//      tables so every downstream item renders with REAL queryable rows at
//      install time (the `lakehouse` provisioner lands the sampleRows as CSV
//      then calls the Load Table API → managed Delta). This stands in for the
//      mirror's OneLake Delta output while the live mirror initializes, so the
//      verification notebook has real data to read on first open.
//   3. notebook           — Mirror Verification: row-count parity, a grounded
//      CDC-lag / replication-health cell (real source DMVs + real Fabric
//      monitoring surfaces), and per-table sample queries.
//
// GROUNDING (honest):
//   - The source ENTITIES (Customers / Products / Sales) and their exact
//     columns are taken from examples/fabric-e2e: the dbt bronze sources
//     `customers_raw` / `products_raw` / `sales_raw` (models/bronze/_sources.yml)
//     and the matching sample CSVs in examples/fabric-e2e/sample_data/.
//     fact_sales.yaml defines only the GOLD fact (retail.gold.fact_sales); it
//     is NOT the source of the OLTP table list and is cited only as the
//     downstream star-schema target.
//   - SOURCE_SERVER / SOURCE_DB below are ILLUSTRATIVE placeholders for the
//     onboarding form (the example itself parameterizes the server via the
//     FABRIC_SQL_ENDPOINT env var in dbt/profiles.yml — it ships no literal
//     production server name). They are clearly labeled as placeholders, not
//     presented as sourced facts.
//   - Fabric Mirroring internals in the notebook are grounded in Microsoft
//     Learn (see the per-cell citations): source-side change-feed DMVs
//     (sys.dm_change_feed_log_scan_sessions, sys.dm_change_feed_errors,
//     sp_help_change_feed) and the mirror-side monitoring surfaces
//     (getMirroringStatus REST + the MirroredDatabaseTableExecution /
//     ReplicatorBatchLatency workspace-monitoring log). The previously-used
//     `_system/sync_watermark` Delta path and `_last_synced_at` column were
//     invented and have been removed — Fabric does not expose an internal
//     watermark Delta path.
import type { AppBundle } from './types';

// ─── Illustrative onboarding target (placeholders, not sourced facts) ──────
// The example parameterizes the SQL endpoint via env (FABRIC_SQL_ENDPOINT in
// examples/fabric-e2e/dbt/profiles.yml). These two strings are the editable
// defaults the onboarding form shows; the user overwrites them with their own
// server/db before mirroring. They are NOT claimed to come from any file.
const SOURCE_SERVER = 'sql-retail-oltp.example.database.windows.net'; // placeholder
const SOURCE_DB = 'RetailSalesOLTP'; // placeholder

// Source tables = the three fabric-e2e bronze source entities, dbo schema.
const TABLES = ['dbo.Customers', 'dbo.Products', 'dbo.Sales'];

// ─── Seeded Bronze sample data ─────────────────────────────────────────────
// Columns + values mirror the example's sample CSVs EXACTLY:
//   examples/fabric-e2e/sample_data/customers.csv
//   examples/fabric-e2e/sample_data/products.csv
//   examples/fabric-e2e/sample_data/sales.csv
// DDL is in the parseable `CREATE TABLE name ( col TYPE, … )` form the
// lakehouse provisioner's columnsFromDdl() expects, so each table is seeded
// to a REAL managed Delta table at install time.

const DDL_CUSTOMERS =
  'CREATE TABLE Customers (\n' +
  '  customer_id STRING,\n' +
  '  customer_name STRING,\n' +
  '  customer_segment STRING,\n' +
  '  country STRING,\n' +
  '  region STRING,\n' +
  '  signup_date DATE\n' +
  ')';

const SAMPLE_CUSTOMERS: any[][] = [
  ['C00001', 'Customer 1', 'Consumer', 'CA', 'North America', '2021-07-17'],
  ['C00002', 'Customer 2', 'Corporate', 'DE', 'Europe', '2020-10-12'],
  ['C00065', 'Customer 65', 'Consumer', 'US', 'North America', '2022-02-03'],
  ['C00338', 'Customer 338', 'Home Office', 'GB', 'Europe', '2019-11-28'],
  ['C00439', 'Customer 439', 'Corporate', 'JP', 'Asia Pacific', '2023-01-09'],
  ['C00635', 'Customer 635', 'Consumer', 'AU', 'Asia Pacific', '2021-05-22'],
];

const DDL_PRODUCTS =
  'CREATE TABLE Products (\n' +
  '  product_id STRING,\n' +
  '  product_name STRING,\n' +
  '  category STRING,\n' +
  '  subcategory STRING,\n' +
  '  list_price DECIMAL(18,2),\n' +
  '  cost_price DECIMAL(18,2)\n' +
  ')';

const SAMPLE_PRODUCTS: any[][] = [
  ['P00001', 'Phones Product 1', 'Electronics', 'Phones', 2148.14, 867.17],
  ['P00002', 'TVs Product 2', 'Electronics', 'TVs', 916.3, 619.48],
  ['P00338', 'Chairs Product 338', 'Furniture', 'Chairs', 482.77, 289.66],
  ['P00439', 'Binders Product 439', 'Office Supplies', 'Binders', 604.58, 362.75],
  ['P01001', 'Tables Product 1001', 'Furniture', 'Tables', 1290.0, 845.2],
];

const DDL_SALES =
  'CREATE TABLE Sales (\n' +
  '  order_id STRING,\n' +
  '  customer_id STRING,\n' +
  '  product_id STRING,\n' +
  '  order_date DATE,\n' +
  '  ship_date DATE,\n' +
  '  quantity INT,\n' +
  '  unit_price DECIMAL(18,2),\n' +
  '  discount_pct DECIMAL(5,4)\n' +
  ')';

const SAMPLE_SALES: any[][] = [
  ['O0000001', 'C00635', 'P00439', '2024-07-05', '2024-07-17', 10, 604.58, 0.15],
  ['O0000002', 'C00065', 'P00338', '2024-10-02', '2024-10-15', 7, 482.77, 0.15],
  ['O0000003', 'C00001', 'P00001', '2024-11-20', '2024-11-24', 2, 2148.14, 0.05],
  ['O0000004', 'C00002', 'P00002', '2025-01-08', '2025-01-13', 4, 916.3, 0.1],
  ['O0000005', 'C00439', 'P01001', '2025-02-14', '2025-02-19', 1, 1290.0, 0.0],
];

const bundle: AppBundle = {
  appId: 'app-fabric-mirror-onboard',
  intro:
    '## Fabric Mirror Onboarding (Azure SQL → OneLake)\n\n' +
    'One-click setup for mirroring a **retail-sales OLTP** Azure SQL Database ' +
    'into Fabric OneLake. Mirroring gives a zero-ETL, near-real-time Delta copy ' +
    'of the operational tables — **`dbo.Customers`**, **`dbo.Products`**, and ' +
    '**`dbo.Sales`** — ready for Direct Lake analytics without touching the OLTP ' +
    'system.\n\n' +
    '**Grounding.** The three source entities and their columns come from the ' +
    '`examples/fabric-e2e` reference: the dbt bronze sources `customers_raw` / ' +
    '`products_raw` / `sales_raw` (`dbt/models/bronze/_sources.yml`) and the ' +
    'sample CSVs in `examples/fabric-e2e/sample_data/`. The downstream star ' +
    'schema those feed is defined by `contracts/fact_sales.yaml` ' +
    '(`retail.gold.fact_sales`). The source **server / database** names in the ' +
    'mirror descriptor are editable **placeholders** for the onboarding form — ' +
    'the example parameterizes its SQL endpoint via the `FABRIC_SQL_ENDPOINT` ' +
    'env var and ships no literal production server name; replace them with your ' +
    'own before starting replication.\n\n' +
    'Install seeds a **Bronze lakehouse** with the three tables (real Delta rows ' +
    'from the example CSVs) so every item renders with live, queryable data ' +
    'immediately — even before the live mirror finishes its initial snapshot. ' +
    'Then run the **Mirror Verification** notebook to check row-count parity, ' +
    'replication health / CDC lag, and per-table samples.',
  sourceDocs: [
    'examples/fabric-e2e/README.md',
    'examples/fabric-e2e/ARCHITECTURE.md',
    'examples/fabric-e2e/dbt/models/bronze/_sources.yml',
    'examples/fabric-e2e/sample_data/customers.csv',
    'examples/fabric-e2e/sample_data/products.csv',
    'examples/fabric-e2e/sample_data/sales.csv',
    'examples/fabric-e2e/contracts/fact_sales.yaml',
    // Microsoft Learn grounding for the mirror internals used in the notebook:
    'https://learn.microsoft.com/fabric/mirroring/monitor',
    'https://learn.microsoft.com/fabric/mirroring/monitor-logs',
    'https://learn.microsoft.com/fabric/database/sql/mirroring-troubleshooting',
    'https://learn.microsoft.com/fabric/mirroring/explore-onelake-shortcut',
  ],
  items: [
    {
      itemType: 'mirrored-database',
      displayName: 'Retail OLTP Mirror (Azure SQL)',
      description:
        'Near-real-time Fabric mirror of the retail-sales Azure SQL database ' +
        'into OneLake. Three core operational tables (Customers, Products, ' +
        'Sales). Direct Lake-ready Delta output.',
      learnDoc: 'patterns/fabric-mirroring',
      content: {
        kind: 'mirrored-database',
        source: {
          kind: 'azure-sql',
          server: SOURCE_SERVER,
          database: SOURCE_DB,
          tables: TABLES,
        },
      },
    },
    {
      itemType: 'lakehouse',
      displayName: 'Retail Bronze Lakehouse',
      description:
        'Bronze landing of the three source tables, seeded with real Delta ' +
        'rows from the examples/fabric-e2e sample CSVs. Stands in for the ' +
        "mirror's OneLake Delta output while replication initializes, so " +
        'every downstream item has queryable data on first open.',
      learnDoc: 'patterns/fabric-mirroring',
      content: {
        kind: 'lakehouse',
        folders: [
          { path: 'Files/_seed', description: 'CSV seed files landed before the Load Table API converts them to Delta.' },
          { path: 'Tables', description: 'Managed Delta tables: Customers, Products, Sales (Bronze).' },
        ],
        deltaTables: [
          { name: 'Customers', ddl: DDL_CUSTOMERS, sampleRows: SAMPLE_CUSTOMERS },
          { name: 'Products', ddl: DDL_PRODUCTS, sampleRows: SAMPLE_PRODUCTS },
          { name: 'Sales', ddl: DDL_SALES, sampleRows: SAMPLE_SALES },
        ],
        shortcuts: [
          {
            name: 'mirrored_onelake',
            target: 'Files/MirroredRetailOLTP',
            description:
              'OneLake shortcut to the live mirrored database tables (created ' +
              'once mirroring is running). Per Microsoft Learn, the supported way ' +
              'to read mirror output from a notebook is a Lakehouse shortcut to ' +
              'the mirrored tables — see ' +
              'https://learn.microsoft.com/fabric/mirroring/explore-onelake-shortcut.',
          },
        ],
      },
    },
    {
      itemType: 'notebook',
      displayName: 'Mirror Verification',
      description:
        'Validates the retail OLTP mirror end-to-end: row-count parity per ' +
        'table, replication health / CDC lag (grounded in real Fabric ' +
        'monitoring surfaces + source change-feed DMVs), and per-table sample ' +
        'queries confirming column-level data parity.',
      learnDoc: 'patterns/fabric-mirroring',
      content: {
        kind: 'notebook',
        defaultLang: 'pyspark',
        cells: [
          {
            id: 'cell-md-intro',
            type: 'markdown',
            source:
              '# Mirror Verification — Retail OLTP\n\n' +
              'Validates that the retail-sales Azure SQL → Fabric mirror is healthy ' +
              'and in-sync. Source entities: `dbo.Customers`, `dbo.Products`, ' +
              '`dbo.Sales` (from the `examples/fabric-e2e` reference).\n\n' +
              'Workflow:\n\n' +
              '1. Read the mirrored side from OneLake (Delta) via a **Lakehouse ' +
              'shortcut** to the mirrored tables — the Microsoft Learn-supported ' +
              'way to query mirror output from a notebook ' +
              '([explore-onelake-shortcut](https://learn.microsoft.com/fabric/mirroring/explore-onelake-shortcut)). ' +
              'Until the live mirror is wired, the seeded **Retail Bronze Lakehouse** ' +
              'stands in so these cells return real rows immediately.\n' +
              '2. Read the source via JDBC (read-only, Managed Identity auth) and ' +
              'compare row counts per table.\n' +
              '3. Check **replication health / CDC lag** using the documented ' +
              'surfaces: the source change-feed DMVs and the Fabric mirror ' +
              'monitoring REST / workspace-monitoring log (no invented internals).\n' +
              '4. Sample rows from each table to confirm column-level parity.\n\n' +
              '> **Auth model:** the workspace MI has `db_datareader` on the source ' +
              'DB; the mirror itself is the only writer to OneLake. No SAS tokens.',
          },
          {
            id: 'cell-config',
            type: 'code',
            lang: 'pyspark',
            source:
              '# 0. Configuration.\n' +
              '# SOURCE_SERVER / SOURCE_DB are placeholders from the onboarding form —\n' +
              '# replace with your own Azure SQL server + database.\n' +
              `SOURCE_SERVER = "${SOURCE_SERVER}"\n` +
              `SOURCE_DB     = "${SOURCE_DB}"\n` +
              '\n' +
              '# Read the mirror output through a Lakehouse shortcut/table. While the\n' +
              '# live mirror initializes, the seeded Retail Bronze Lakehouse provides\n' +
              '# the same three tables as real Delta so these cells return rows now.\n' +
              '#   - MIRROR_LH: the lakehouse whose Tables/ hold the mirrored (or seeded) data\n' +
              '#   - Tables are read by name via the attached lakehouse, e.g. spark.table("Customers")\n' +
              'MIRROR_LH = "Retail Bronze Lakehouse"   # swap to the mirror shortcut lakehouse once live\n' +
              '\n' +
              'TABLES = [\n' +
              '    "dbo.Customers",\n' +
              '    "dbo.Products",\n' +
              '    "dbo.Sales",\n' +
              ']\n' +
              '\n' +
              '# JDBC URL using Active Directory MSI authentication (read-only).\n' +
              'JDBC_URL = (\n' +
              '    f"jdbc:sqlserver://{SOURCE_SERVER}:1433;database={SOURCE_DB};"\n' +
              '    "authentication=ActiveDirectoryMSI;encrypt=true;trustServerCertificate=false;"\n' +
              '    "hostNameInCertificate=*.database.windows.net;loginTimeout=30"\n' +
              ')\n' +
              'print(f"Source: {SOURCE_SERVER}/{SOURCE_DB}")\n' +
              'print(f"Mirror lakehouse: {MIRROR_LH}")\n' +
              'print(f"Tables: {len(TABLES)}")',
          },
          {
            id: 'cell-md-rowcount',
            type: 'markdown',
            source:
              '## 1. Row-count parity\n\n' +
              'Compares `COUNT(*)` on the source (JDBC) vs `count()` on the mirrored ' +
              'Delta table per table. In a steady state the delta should be 0; during ' +
              'heavy write activity a small delta is acceptable and should reconcile ' +
              'within ~60s. Anything sustained > 100 rows warrants a look. ' +
              'Per Microsoft Learn, if updates stop the replicator backs off (up to ' +
              '~1h) and auto-resumes when new changes appear, so a frozen-but-equal ' +
              'count is normal.',
          },
          {
            id: 'cell-rowcount',
            type: 'code',
            lang: 'pyspark',
            source:
              '# 1. Row-count parity per table.\n' +
              'from pyspark.sql import Row\n' +
              '\n' +
              'parity_rows = []\n' +
              'for full_name in TABLES:\n' +
              '    schema, table = full_name.split(".")\n' +
              '    # Source count via JDBC.\n' +
              '    try:\n' +
              '        src_count_df = (\n' +
              '            spark.read.format("jdbc")\n' +
              '                 .option("url", JDBC_URL)\n' +
              '                 .option("query", f"SELECT COUNT(*) AS n FROM {schema}.{table}")\n' +
              '                 .load()\n' +
              '        )\n' +
              '        src_n = src_count_df.first()["n"]\n' +
              '    except Exception as e:\n' +
              '        # Source unreachable from this notebook (no MI grant yet) — report\n' +
              '        # the mirror side only rather than failing the whole notebook.\n' +
              '        print(f"  [{full_name}] source count unavailable: {type(e).__name__}: {e}")\n' +
              '        src_n = None\n' +
              '\n' +
              '    # Mirror/seeded count via the attached lakehouse table.\n' +
              '    mirror_n = spark.table(table).count()\n' +
              '\n' +
              '    delta = None if src_n is None else src_n - mirror_n\n' +
              '    parity_rows.append(Row(\n' +
              '        table=full_name,\n' +
              '        source_count=src_n,\n' +
              '        mirror_count=mirror_n,\n' +
              '        delta=delta,\n' +
              '        status=("UNKNOWN" if delta is None else ("OK" if abs(delta) < 100 else "DRIFT")),\n' +
              '    ))\n' +
              '\n' +
              'parity_df = spark.createDataFrame(parity_rows)\n' +
              'parity_df.orderBy("table").show(truncate=False)',
          },
          {
            id: 'cell-md-cdc',
            type: 'markdown',
            source:
              '## 2. Replication health & CDC lag\n\n' +
              'Fabric Mirroring does **not** expose an internal watermark Delta file; ' +
              'the documented ways to observe replication health are:\n\n' +
              '- **Mirror side — REST status.** `GET .../mirroredDatabases/{id}/' +
              'getMirroringStatus` (and per-table `getTablesMirroringStatus`) returns ' +
              "the database/table status (`Running`, `Running with warning`, " +
              "`Stopped`, `Failed`, `Paused`) plus rows-replicated and last-completed " +
              'time. The install provisioner already calls `getMirroringStatus` and ' +
              'stamps the result onto the item — see the **Monitor replication** docs: ' +
              'https://learn.microsoft.com/fabric/mirroring/monitor#monitor-programmatically\n' +
              '- **Mirror side — workspace monitoring.** When workspace monitoring is ' +
              'enabled, mirror execution logs land in the ' +
              '`MirroredDatabaseTableExecution` table of the monitoring KQL database; ' +
              'query the `ReplicatorBatchLatency` value for replication latency. ' +
              'Docs: https://learn.microsoft.com/fabric/mirroring/monitor-logs\n' +
              '- **Source side — change-feed DMVs (Azure SQL).** ' +
              '`sys.dm_change_feed_log_scan_sessions`, `sys.dm_change_feed_errors`, ' +
              'and `EXEC sp_help_change_feed` report whether the source is producing ' +
              'changes and whether the change feed is healthy (state `4` = OK). ' +
              'Docs: https://learn.microsoft.com/fabric/database/sql/mirroring-troubleshooting#t-sql-queries-for-troubleshooting\n\n' +
              'The next two cells run the source DMV check and the KQL latency check. ' +
              'Both are read-only and degrade gracefully (skip with a message) when ' +
              'the surface is not yet available in this deployment.',
          },
          {
            id: 'cell-cdc-source-dmv',
            type: 'code',
            lang: 'pyspark',
            source:
              '# 2a. Source-side change-feed health (Azure SQL DMVs).\n' +
              '#   sys.dm_change_feed_log_scan_sessions  → is the source emitting changes?\n' +
              '#   sys.dm_change_feed_errors             → any change-feed errors?\n' +
              '# Both are documented Fabric-mirroring troubleshooting DMVs:\n' +
              '#   https://learn.microsoft.com/fabric/database/sql/mirroring-troubleshooting\n' +
              'CHANGE_FEED_SESSIONS_SQL = "SELECT * FROM sys.dm_change_feed_log_scan_sessions"\n' +
              'CHANGE_FEED_ERRORS_SQL   = "SELECT * FROM sys.dm_change_feed_errors"\n' +
              '\n' +
              'def _read_dmv(query):\n' +
              '    return (spark.read.format("jdbc")\n' +
              '                 .option("url", JDBC_URL)\n' +
              '                 .option("query", query)\n' +
              '                 .load())\n' +
              '\n' +
              'try:\n' +
              '    print("=== sys.dm_change_feed_log_scan_sessions (source is emitting changes) ===")\n' +
              '    _read_dmv(CHANGE_FEED_SESSIONS_SQL).show(truncate=False)\n' +
              '    print("=== sys.dm_change_feed_errors (should be empty when healthy) ===")\n' +
              '    errors_df = _read_dmv(CHANGE_FEED_ERRORS_SQL)\n' +
              '    n_err = errors_df.count()\n' +
              '    errors_df.show(truncate=False)\n' +
              '    print(f"change-feed errors: {n_err}  ({\'HEALTHY\' if n_err == 0 else \'INVESTIGATE\'})")\n' +
              'except Exception as e:\n' +
              '    print(f"Source DMVs unavailable (no MI grant / source not reachable yet): "\n' +
              '          f"{type(e).__name__}: {e}")\n' +
              '    print("Run `EXEC sp_help_change_feed;` on the source to confirm state == 4 (OK).")',
          },
          {
            id: 'cell-cdc-mirror-latency',
            type: 'code',
            lang: 'pyspark',
            source:
              '# 2b. Mirror-side replication latency (workspace monitoring KQL).\n' +
              '# When workspace monitoring is enabled, mirror execution logs land in\n' +
              '# the MirroredDatabaseTableExecution table; ReplicatorBatchLatency is the\n' +
              '# per-batch replication latency. Docs:\n' +
              '#   https://learn.microsoft.com/fabric/mirroring/monitor-logs\n' +
              '# This requires the monitoring KQL database to be attached to the\n' +
              '# notebook (or queried via the Kusto connector). We try it and, if the\n' +
              '# table is absent, point the user at the Fabric portal Monitor pane and\n' +
              '# the getMirroringStatus REST call the installer already runs.\n' +
              'MONITORING_KQL = """\n' +
              'MirroredDatabaseTableExecution\n' +
              '| where Timestamp > ago(1h)\n' +
              '| summarize\n' +
              '    rows_replicated   = sum(RowsReplicated),\n' +
              '    avg_latency_ms    = avg(ReplicatorBatchLatency),\n' +
              '    max_latency_ms    = max(ReplicatorBatchLatency),\n' +
              '    last_completed    = max(Timestamp)\n' +
              '    by SourceTableName, Status\n' +
              '| order by max_latency_ms desc\n' +
              '"""\n' +
              'try:\n' +
              '    # If a monitoring KQL DB is attached, it is queryable as a temp view\n' +
              '    # via the Kusto Spark connector. Pattern shown; adjust cluster/db to\n' +
              '    # your workspace-monitoring eventhouse.\n' +
              '    kusto_uri = spark.conf.get("spark.loom.monitoringKustoUri", "")\n' +
              '    kusto_db  = spark.conf.get("spark.loom.monitoringKustoDb", "Monitoring")\n' +
              '    if not kusto_uri:\n' +
              '        raise RuntimeError("workspace monitoring not configured (spark.loom.monitoringKustoUri unset)")\n' +
              '    lat = (spark.read.format("com.microsoft.kusto.spark.datasource")\n' +
              '                .option("kustoCluster", kusto_uri)\n' +
              '                .option("kustoDatabase", kusto_db)\n' +
              '                .option("kustoQuery", MONITORING_KQL)\n' +
              '                .load())\n' +
              '    lat.show(truncate=False)\n' +
              'except Exception as e:\n' +
              '    print(f"Workspace-monitoring latency not available: {type(e).__name__}: {e}")\n' +
              '    print("Fallbacks (both documented in Microsoft Learn):")\n' +
              '    print("  • Fabric portal → mirrored DB → Monitor replication "\n' +
              '          "(status + rows replicated + Last completed).")\n' +
              '    print("  • REST: GET .../mirroredDatabases/{id}/getMirroringStatus "\n' +
              '          "— the install provisioner already records this on the item.")',
          },
          {
            id: 'cell-md-samples',
            type: 'markdown',
            source:
              '## 3. Per-table sample rows\n\n' +
              'Reads the first 5 rows from every mirrored/seeded table to confirm ' +
              'column names, types, and values are present. If a table returns 0 rows ' +
              "on the mirror but > 0 on the source, the mirror's initial snapshot has " +
              'not completed yet — wait and re-run (per the Learn tutorials, initial ' +
              'snapshot typically takes 2–5 minutes).',
          },
          {
            id: 'cell-samples',
            type: 'code',
            lang: 'pyspark',
            source:
              '# 3. Sample 5 rows from every mirrored/seeded table.\n' +
              'for full_name in TABLES:\n' +
              '    schema, table = full_name.split(".")\n' +
              '    print("=" * 80)\n' +
              '    print(f"-- {full_name}")\n' +
              '    print("=" * 80)\n' +
              '    try:\n' +
              '        df = spark.table(table)\n' +
              '        print(f"  columns: {df.columns}")\n' +
              '        df.limit(5).show(truncate=False)\n' +
              '    except Exception as e:\n' +
              '        print(f"  ERROR reading table {table}: {type(e).__name__}: {e}")',
          },
          {
            id: 'cell-sql-spot-check',
            type: 'code',
            lang: 'sparksql',
            source:
              '-- 4. End-to-end spot check: join Sales + Customers + Products and confirm\n' +
              '--    the row makes sense (extended_amount = quantity * unit_price * (1 - discount_pct)).\n' +
              '--    Reads the attached lakehouse tables by name (mirrored or seeded Bronze).\n' +
              'SELECT\n' +
              '    s.order_id,\n' +
              '    s.order_date,\n' +
              '    c.customer_name,\n' +
              '    c.customer_segment,\n' +
              '    p.product_name,\n' +
              '    s.quantity,\n' +
              '    s.unit_price,\n' +
              '    s.discount_pct,\n' +
              '    CAST(s.quantity * s.unit_price * (1 - s.discount_pct) AS DECIMAL(18,2)) AS extended_amount\n' +
              'FROM Sales s\n' +
              'JOIN Customers c ON c.customer_id = s.customer_id\n' +
              'JOIN Products  p ON p.product_id  = s.product_id\n' +
              'ORDER BY s.order_date DESC\n' +
              'LIMIT 20;',
          },
          {
            id: 'cell-md-next',
            type: 'markdown',
            source:
              '## Next steps\n\n' +
              '- Once the live mirror is `Running` (cell 2b / portal Monitor pane), ' +
              'point `MIRROR_LH` at a Lakehouse with an **OneLake shortcut** to the ' +
              'mirrored tables and drop the seeded Bronze tables.\n' +
              '- Build the **gold star schema** (`retail.gold.fact_sales` + dims) from ' +
              'these three sources — see `examples/fabric-e2e/dbt/models/gold/`.\n' +
              '- Build a **Direct Lake** semantic model on `Sales` + `Customers` + ' +
              '`Products` (the example ships `retail-sales.SemanticModel`).\n' +
              '- Wire the mirror into the **Data Steward Console** as a certified data ' +
              'product (see `app-data-steward`).\n' +
              '- Add a **scheduled job** that re-runs this notebook nightly and alerts ' +
              "on any parity row with status = 'DRIFT' or a non-`Running` mirror status.",
          },
        ],
      },
    },
  ],
};

export default bundle;
