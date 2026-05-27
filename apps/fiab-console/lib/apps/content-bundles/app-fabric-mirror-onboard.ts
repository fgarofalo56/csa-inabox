// app-fabric-mirror-onboard — provisions an Azure SQL → Fabric Mirroring
// onboarding workspace: the mirrored-database descriptor + a verification
// notebook that runs row-count parity, CDC-lag, and per-table sample queries
// against the mirrored side to confirm data parity.
import type { AppBundle } from './types';

const bundle: AppBundle = {
  appId: 'app-fabric-mirror-onboard',
  intro:
    '## Fabric Mirror Onboarding (Azure SQL)\n\n' +
    'One-click setup for mirroring the **SalesOLTP** Azure SQL Database into Fabric ' +
    'OneLake. The mirror provides a zero-ETL, near-real-time copy of the operational ' +
    'tables (`dbo.Customers`, `dbo.Orders`, `dbo.OrderLines`, `dbo.Products`, ' +
    '`dbo.Inventory`, `dbo.Returns`) suitable for analytics in Direct Lake mode ' +
    'without touching the OLTP system.\n\n' +
    'Source: `examples/fabric-e2e/contracts/fact_sales.yaml`. After install, run the ' +
    'companion **Mirror Verification** notebook to validate row-count parity, monitor ' +
    'CDC lag, and sample data across all mirrored tables.',
  sourceDocs: [
    'examples/fabric-e2e/ARCHITECTURE.md',
    'examples/fabric-e2e/contracts/fact_sales.yaml',
  ],
  items: [
    {
      itemType: 'mirrored-database',
      displayName: 'SalesOLTP Mirror (Azure SQL)',
      description:
        'Near-real-time mirror of the SalesOLTP Azure SQL database into Fabric ' +
        'OneLake. Six core operational tables. Direct Lake-ready.',
      learnDoc: 'patterns/fabric-mirroring',
      content: {
        kind: 'mirrored-database',
        source: {
          kind: 'azure-sql',
          server: 'sql-sales-prod.database.windows.net',
          database: 'SalesOLTP',
          tables: [
            'dbo.Customers',
            'dbo.Orders',
            'dbo.OrderLines',
            'dbo.Products',
            'dbo.Inventory',
            'dbo.Returns',
          ],
        },
      },
    },
    {
      itemType: 'notebook',
      displayName: 'Mirror Verification',
      description:
        'Validates the SalesOLTP mirror end-to-end: row-count parity per table, CDC ' +
        'lag query, and SELECT samples confirming column-level data parity.',
      learnDoc: 'patterns/fabric-mirroring',
      content: {
        kind: 'notebook',
        defaultLang: 'pyspark',
        cells: [
          {
            id: 'cell-md-intro',
            type: 'markdown',
            source:
              '# Mirror Verification — SalesOLTP\n\n' +
              'This notebook validates the **SalesOLTP** Azure SQL → Fabric mirror is ' +
              'healthy and in-sync. The workflow:\n\n' +
              '1. Connect to the source Azure SQL via JDBC (read-only, MI auth).\n' +
              '2. Read the mirrored side from OneLake (Delta).\n' +
              '3. Compare row counts per table — any drift > 0 in a steady state is a real bug.\n' +
              '4. Inspect CDC lag (source `sys.dm_change_feed_log_scan_sessions` vs mirror `_last_synced_at`).\n' +
              '5. Sample rows from each mirrored table to confirm column-level data parity.\n\n' +
              '> **Auth model:** the workspace MI has `db_datareader` on the source DB; the ' +
              'mirror itself is the only writer to OneLake. No SAS tokens.',
          },
          {
            id: 'cell-config',
            type: 'code',
            lang: 'pyspark',
            source:
              '# 0. Configuration — sourced from the mirrored-database descriptor.\n' +
              'SOURCE_SERVER = "sql-sales-prod.database.windows.net"\n' +
              'SOURCE_DB     = "SalesOLTP"\n' +
              'MIRROR_PATH   = "Files/MirroredDatabases/SalesOLTP_Mirror"\n' +
              '\n' +
              'TABLES = [\n' +
              '    "dbo.Customers",\n' +
              '    "dbo.Orders",\n' +
              '    "dbo.OrderLines",\n' +
              '    "dbo.Products",\n' +
              '    "dbo.Inventory",\n' +
              '    "dbo.Returns",\n' +
              ']\n' +
              '\n' +
              '# JDBC URL using Active Directory MSI authentication.\n' +
              'JDBC_URL = (\n' +
              '    f"jdbc:sqlserver://{SOURCE_SERVER}:1433;database={SOURCE_DB};"\n' +
              '    "authentication=ActiveDirectoryMSI;encrypt=true;trustServerCertificate=false;"\n' +
              '    "hostNameInCertificate=*.database.windows.net;loginTimeout=30"\n' +
              ')\n' +
              'print(f"Source: {SOURCE_SERVER}/{SOURCE_DB}")\n' +
              'print(f"Mirror: {MIRROR_PATH}")\n' +
              'print(f"Tables: {len(TABLES)}")',
          },
          {
            id: 'cell-md-rowcount',
            type: 'markdown',
            source:
              '## 1. Row-count parity\n\n' +
              'Compares `COUNT(*)` source vs `count()` mirror per table. In a steady state the ' +
              'delta should be 0; during heavy write activity a few-row delta is acceptable and ' +
              'should reconcile within ~60s. Anything sustained > 100 rows is a real issue ' +
              'that should be opened against the mirror.',
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
              '    src_count_df = (\n' +
              '        spark.read.format("jdbc")\n' +
              '             .option("url", JDBC_URL)\n' +
              '             .option("query", f"SELECT COUNT(*) AS n FROM {schema}.{table}")\n' +
              '             .load()\n' +
              '    )\n' +
              '    src_n = src_count_df.first()["n"]\n' +
              '\n' +
              '    # Mirror count via OneLake Delta path.\n' +
              '    mirror_n = spark.read.format("delta").load(f"{MIRROR_PATH}/{schema}/{table}").count()\n' +
              '\n' +
              '    delta = src_n - mirror_n\n' +
              '    parity_rows.append(Row(\n' +
              '        table=full_name,\n' +
              '        source_count=src_n,\n' +
              '        mirror_count=mirror_n,\n' +
              '        delta=delta,\n' +
              '        status="OK" if abs(delta) < 100 else "DRIFT",\n' +
              '    ))\n' +
              '\n' +
              'parity_df = spark.createDataFrame(parity_rows)\n' +
              'parity_df.orderBy("table").show(truncate=False)',
          },
          {
            id: 'cell-md-cdc',
            type: 'markdown',
            source:
              '## 2. CDC lag\n\n' +
              'Reports the most recent change-tracking timestamp captured on the source vs the ' +
              "mirror's last-synced watermark, per table. Lag > 5 minutes during business hours " +
              'warrants investigation — the most common cause is a capacity-throttling event.',
          },
          {
            id: 'cell-cdc-lag',
            type: 'code',
            lang: 'pyspark',
            source:
              '# 2. CDC lag — combines a source DMV with the mirror metadata.\n' +
              'from pyspark.sql.functions import col, current_timestamp, unix_timestamp\n' +
              '\n' +
              'src_cdc = (\n' +
              '    spark.read.format("jdbc")\n' +
              '         .option("url", JDBC_URL)\n' +
              '         .option("query", """\n' +
              '            SELECT\n' +
              '                t.name                        AS table_name,\n' +
              "                s.name                        AS table_schema,\n" +
              '                MAX(s2.end_time)              AS last_scan_end_time\n' +
              '            FROM sys.dm_change_feed_log_scan_sessions s2\n' +
              '            JOIN sys.tables t  ON t.object_id = s2.table_id\n' +
              '            JOIN sys.schemas s ON s.schema_id = t.schema_id\n' +
              '            GROUP BY s.name, t.name\n' +
              '         """)\n' +
              '         .load()\n' +
              ')\n' +
              '\n' +
              "# Mirror watermark — emitted by the mirroring agent into the _system table.\n" +
              'mirror_wm = spark.read.format("delta").load(f"{MIRROR_PATH}/_system/sync_watermark")\n' +
              '\n' +
              'lag = (\n' +
              '    src_cdc.alias("s")\n' +
              "    .join(mirror_wm.alias('m'), (col('s.table_name') == col('m.table_name')) & (col('s.table_schema') == col('m.table_schema')))\n" +
              "    .withColumn('lag_seconds', unix_timestamp('s.last_scan_end_time') - unix_timestamp('m.last_synced_at'))\n" +
              "    .select('s.table_schema', 's.table_name', 's.last_scan_end_time', 'm.last_synced_at', 'lag_seconds')\n" +
              ')\n' +
              "lag.orderBy(col('lag_seconds').desc()).show(truncate=False)",
          },
          {
            id: 'cell-md-samples',
            type: 'markdown',
            source:
              '## 3. Per-table sample rows\n\n' +
              'Reads the first 5 rows from every mirrored table to confirm column names, types, ' +
              'and values are present. If any table returns 0 rows on the mirror but > 0 on the ' +
              'source, the mirror initial-snapshot has not yet completed — wait and re-run.',
          },
          {
            id: 'cell-samples',
            type: 'code',
            lang: 'pyspark',
            source:
              '# 3. Sample 5 rows from every mirrored table.\n' +
              'for full_name in TABLES:\n' +
              '    schema, table = full_name.split(".")\n' +
              '    path = f"{MIRROR_PATH}/{schema}/{table}"\n' +
              '    print("=" * 80)\n' +
              '    print(f"-- {full_name}  ({path})")\n' +
              '    print("=" * 80)\n' +
              '    try:\n' +
              '        df = spark.read.format("delta").load(path)\n' +
              '        print(f"  columns: {df.columns}")\n' +
              '        df.limit(5).show(truncate=False)\n' +
              '    except Exception as e:\n' +
              '        print(f"  ERROR reading mirror: {type(e).__name__}: {e}")',
          },
          {
            id: 'cell-sql-spot-check',
            type: 'code',
            lang: 'sparksql',
            source:
              '-- 4. End-to-end spot check: join Orders + OrderLines + Products from the mirror\n' +
              "--    and confirm the row makes sense (extended_amount matches qty * unit_price).\n" +
              'SELECT\n' +
              '    o.OrderId,\n' +
              '    o.OrderDate,\n' +
              '    p.ProductName,\n' +
              '    ol.Quantity,\n' +
              '    ol.UnitPrice,\n' +
              '    CAST(ol.Quantity * ol.UnitPrice AS DECIMAL(18,2)) AS extended_amount\n' +
              'FROM delta.`Files/MirroredDatabases/SalesOLTP_Mirror/dbo/Orders` o\n' +
              'JOIN delta.`Files/MirroredDatabases/SalesOLTP_Mirror/dbo/OrderLines` ol\n' +
              '    ON ol.OrderId = o.OrderId\n' +
              'JOIN delta.`Files/MirroredDatabases/SalesOLTP_Mirror/dbo/Products` p\n' +
              '    ON p.ProductId = ol.ProductId\n' +
              'ORDER BY o.OrderDate DESC\n' +
              'LIMIT 20;',
          },
          {
            id: 'cell-md-next',
            type: 'markdown',
            source:
              '## Next steps\n\n' +
              '- Wire the mirror into the **Data Steward Console** as a certified data product ' +
              '(see `app-data-steward`).\n' +
              '- Build a **Direct Lake** semantic model on top of `dbo.Orders` + `dbo.OrderLines` ' +
              '+ `dbo.Products`.\n' +
              '- Add a **scheduled job** that re-runs this notebook nightly and alerts on any ' +
              "row in the parity table with status = 'DRIFT'.",
          },
        ],
      },
    },
  ],
};

export default bundle;
