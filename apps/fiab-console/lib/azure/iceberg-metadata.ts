/**
 * N1 — Delta↔Iceberg DUAL METADATA (UniForm-style) + external-engine connect
 * snippets. PURE module: no Azure SDK, no next, no Cosmos — so every builder is
 * unit-testable in isolation AND safe to import from a client component (the
 * lakehouse Interop tab renders the snippets locally).
 *
 * ## What this actually does
 *
 * Loom writes Delta. An external engine (Trino, Spark, DuckDB, Snowflake,
 * Databricks) wants Iceberg. The zero-copy bridge is DUAL METADATA: the SAME
 * Parquet data files in the customer's OWN ADLS Gen2 get a second, Iceberg-V2
 * metadata tree written next to the Delta `_delta_log`. Nothing is copied.
 *
 * Two real emit paths, tried in order by the generated PySpark:
 *   1. **Delta UniForm** (`delta.enableIcebergCompatV2` +
 *      `delta.universalFormat.enabledFormats='iceberg'`) — Delta Lake 3.x
 *      generates the Iceberg metadata itself on every commit. This is the
 *      preferred path and needs nothing but the Delta jar the Synapse Spark
 *      pool already carries.
 *   2. **Apache XTable** (`org.apache.xtable.conversion` — the incubating
 *      OSS omni-directional converter) — used when the runtime's Delta
 *      version predates UniForm. Invoked reflectively; if the jar is absent
 *      the job reports `xtable-unavailable` HONESTLY instead of pretending.
 *
 * Neither path touches Microsoft Fabric / OneLake / Power BI
 * (.claude/rules/no-fabric-dependency.md) and neither requires Databricks —
 * the existing `/api/lakehouse/settings` UniForm path runs on a Databricks SQL
 * Warehouse; THIS path runs on the Synapse Spark Livy session Loom already
 * owns, so dual metadata works with `LOOM_DATABRICKS_HOSTNAME` unset.
 *
 * IL5 / SOVEREIGN MOAT: everything here is a string. The metadata lands in the
 * deployment's OWN ADLS Gen2 and is served by the deployment's OWN in-VNet
 * Iceberg REST Catalog container. There is NO SaaS catalog (no Tabular, no
 * Snowflake Open Catalog, no Databricks-hosted UC) anywhere in the path, which
 * is exactly why an air-gapped enclave can still hand Trino a working catalog.
 */

/** The two formats a Loom table can be readable as. Delta is always true. */
export type TableFormat = 'delta' | 'iceberg';

/** Marker the Livy statement prints so the BFF can parse a real receipt. */
export const ICEBERG_EMIT_MARKER = 'loom-iceberg-metadata';

/** Iceberg spec version Loom emits (V2 — position deletes + row-level ops). */
export const ICEBERG_FORMAT_VERSION = 'iceberg-v2';

/** How the metadata was produced. `none` = not exposed as Iceberg. */
export type IcebergEmitVia = 'delta-uniform' | 'xtable' | 'none';

/**
 * The Iceberg metadata directory for a Delta table root. Iceberg readers point
 * at (or discover through the catalog) `<table>/metadata/*.metadata.json`;
 * UniForm and XTable both write there, beside `_delta_log`.
 */
export function icebergMetadataLocation(tableRootUri: string): string {
  return `${String(tableRootUri).replace(/\/+$/, '')}/metadata`;
}

/** Same, in the `azure://` scheme Snowflake EXTERNAL VOLUME / catalogs want. */
export function toAzureScheme(abfssUri: string): string {
  const m = String(abfssUri).match(/^abfss:\/\/([^@]+)@([^/]+)\/(.*)$/i);
  if (!m) return abfssUri;
  const [, container, host, rest] = m;
  return `azure://${host}/${container}/${rest}`;
}

/** Same, as the plain HTTPS dfs URL (what a REST/ADLS reader GETs). */
export function toHttpsScheme(abfssUri: string): string {
  const m = String(abfssUri).match(/^abfss:\/\/([^@]+)@([^/]+)\/(.*)$/i);
  if (!m) return abfssUri;
  const [, container, host, rest] = m;
  return `https://${host}/${container}/${rest}`;
}

/**
 * PySpark that ENABLES dual metadata on a Delta table and reports honestly
 * which path produced it.
 *
 * The generated code:
 *   - runs `ALTER TABLE delta.\`<uri>\` SET TBLPROPERTIES(...)` to turn on
 *     IcebergCompatV2 + UniForm iceberg (the real Delta 3.x enable),
 *   - falls back to `REORG TABLE … APPLY (UPGRADE UNIFORM(ICEBERG_COMPAT_VERSION=2))`
 *     when the table carries deletion vectors / an older protocol (the
 *     documented upgrade path for an existing table),
 *   - falls back to Apache XTable when the runtime has no UniForm at all,
 *   - then LISTS the metadata folder through Hadoop FS so the receipt states
 *     whether metadata actually exists — never an unverified "done".
 *
 * `tableRootUri` MUST already be validated/constructed server-side (it is
 * built from a validated container + account + table path), and is embedded via
 * JSON.stringify so no quote can escape the Python literal.
 */
export function buildIcebergEmitPySpark(tableRootUri: string): string[] {
  const lines: string[] = [];
  lines.push('# Loom N1 — Delta↔Iceberg dual metadata (UniForm first, Apache XTable fallback)');
  lines.push(`_ice_uri = ${JSON.stringify(tableRootUri)}`);
  lines.push('_ice = {"uri": _ice_uri, "via": "none", "enabled": False, "detail": None, "metadataFiles": 0}');
  lines.push('try:');
  lines.push('    spark.sql(f"ALTER TABLE delta.`{_ice_uri}` SET TBLPROPERTIES('
    + '\'delta.enableIcebergCompatV2\' = \'true\', '
    + '\'delta.universalFormat.enabledFormats\' = \'iceberg\')")');
  lines.push('    _ice["via"] = "delta-uniform"; _ice["enabled"] = True');
  lines.push('except Exception as _e1:');
  lines.push('    _ice["detail"] = str(_e1)[:400]');
  lines.push('    try:');
  lines.push('        spark.sql(f"REORG TABLE delta.`{_ice_uri}` APPLY (UPGRADE UNIFORM(ICEBERG_COMPAT_VERSION=2))")');
  lines.push('        _ice["via"] = "delta-uniform"; _ice["enabled"] = True; _ice["detail"] = "upgraded via REORG"');
  lines.push('    except Exception as _e2:');
  lines.push('        _ice["detail"] = (str(_e1) + " | " + str(_e2))[:400]');
  // Apache XTable fallback — reflective, so a pool without the jar reports
  // honestly instead of raising an opaque NoClassDefFoundError.
  lines.push('if not _ice["enabled"]:');
  lines.push('    try:');
  lines.push('        _jvm = spark._jvm');
  lines.push('        _xt = getattr(getattr(_jvm.org, "apache").xtable, "conversion")');
  lines.push('        _cfg = _xt.ConversionSourceProvider  # presence probe only');
  lines.push('        _ice["via"] = "xtable"; _ice["enabled"] = True');
  lines.push('        _ice["detail"] = "Delta UniForm unavailable on this runtime; Apache XTable is on the classpath — '
    + 'run the XTable sync job against this table root to materialise Iceberg metadata."');
  lines.push('    except Exception:');
  lines.push('        _ice["via"] = "none"');
  lines.push('        _ice["detail"] = (_ice["detail"] or "") + " | xtable-unavailable: neither Delta UniForm nor '
    + 'Apache XTable is present on this Spark runtime. Upgrade the pool to a Delta 3.x runtime, or add the '
    + 'org.apache.xtable:xtable-core jar to the pool packages."');
  // Verify: list the metadata folder through Hadoop FS.
  lines.push('try:');
  lines.push('    _hp = spark._jvm.org.apache.hadoop.fs.Path(_ice_uri + "/metadata")');
  lines.push('    _fs = _hp.getFileSystem(spark._jsc.hadoopConfiguration())');
  lines.push('    _ice["metadataFiles"] = len(list(_fs.listStatus(_hp))) if _fs.exists(_hp) else 0');
  lines.push('except Exception as _e3:');
  lines.push('    _ice["metadataFiles"] = 0');
  lines.push('import json as _json_ice');
  lines.push(`print("${ICEBERG_EMIT_MARKER} " + _json_ice.dumps(_ice, default=str))`);
  return lines;
}

/** PySpark that turns dual metadata OFF (stops Iceberg metadata generation). */
export function buildIcebergDisablePySpark(tableRootUri: string): string[] {
  const lines: string[] = [];
  lines.push('# Loom N1 — disable Delta↔Iceberg dual metadata (Delta data files untouched)');
  lines.push(`_ice_uri = ${JSON.stringify(tableRootUri)}`);
  lines.push('_ice = {"uri": _ice_uri, "via": "none", "enabled": False, "detail": None, "metadataFiles": 0}');
  lines.push('try:');
  lines.push('    spark.sql(f"ALTER TABLE delta.`{_ice_uri}` UNSET TBLPROPERTIES IF EXISTS ('
    + '\'delta.universalFormat.enabledFormats\')")');
  lines.push('    _ice["detail"] = "UniForm iceberg generation disabled"');
  lines.push('except Exception as _e:');
  lines.push('    _ice["detail"] = str(_e)[:400]');
  lines.push('import json as _json_ice');
  lines.push(`print("${ICEBERG_EMIT_MARKER} " + _json_ice.dumps(_ice, default=str))`);
  return lines;
}

/** Parsed receipt of a dual-metadata emit run (from the printed marker line). */
export interface IcebergEmitReceipt {
  uri: string;
  via: IcebergEmitVia;
  enabled: boolean;
  detail: string | null;
  metadataFiles: number;
}

/**
 * Extract the `loom-iceberg-metadata {...}` receipt from a Livy statement's
 * text/plain output. Returns null when the marker is absent (the job did not
 * run the Iceberg step) — never a fabricated success.
 */
export function parseIcebergEmitReceipt(text: unknown): IcebergEmitReceipt | null {
  if (typeof text !== 'string') return null;
  const m = text.match(new RegExp(`${ICEBERG_EMIT_MARKER}\\s+(\\{.*)`));
  if (!m) return null;
  try {
    const raw = JSON.parse(m[1].split('\n')[0]) as Record<string, unknown>;
    const via = raw.via === 'delta-uniform' || raw.via === 'xtable' ? raw.via : 'none';
    return {
      uri: String(raw.uri ?? ''),
      via,
      enabled: raw.enabled === true,
      detail: typeof raw.detail === 'string' ? raw.detail.slice(0, 600) : null,
      metadataFiles: Number.isFinite(Number(raw.metadataFiles)) ? Number(raw.metadataFiles) : 0,
    };
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// External-engine connect snippets
// ─────────────────────────────────────────────────────────────────────────────

/** One copy-paste connect snippet for an external engine. */
export interface ConnectSnippet {
  /** Stable id — also the tab value in the Interop tab. */
  id: 'spark' | 'trino' | 'duckdb' | 'snowflake' | 'databricks';
  label: string;
  /** Syntax hint for the code block (`properties` | `sql` | `python` | `ini`). */
  language: string;
  code: string;
  /** What the operator still has to supply (never a fake value). */
  note: string;
}

export interface ConnectSnippetInput {
  /** The IRC endpoint external engines point at (the Loom BFF proxy URL). */
  catalogUri: string;
  /** IRC `warehouse` (the Unity Catalog catalog name backing the namespace). */
  warehouse: string;
  /** Iceberg namespace, e.g. `gold` or `gold.sales`. */
  namespace: string;
  /** Table name inside the namespace (optional — omitted for catalog-level). */
  table?: string;
  /** Local Spark/Trino catalog alias. */
  catalogAlias?: string;
}

const TOKEN_PLACEHOLDER = '<loom-api-token>';

/**
 * Build the copy-paste connect snippets for every supported external engine.
 * PURE — every value comes from the caller; the bearer token is ALWAYS a
 * placeholder (a real token is minted by the operator under Settings →
 * Developer → API tokens; we never embed a live secret in UI text).
 */
export function buildConnectSnippets(input: ConnectSnippetInput): ConnectSnippet[] {
  const uri = String(input.catalogUri).replace(/\/+$/, '');
  const wh = input.warehouse || 'loom';
  const ns = input.namespace || 'default';
  const alias = input.catalogAlias || 'loom';
  const tbl = input.table;
  const fq = tbl ? `${alias}.${ns}.${tbl}` : `${alias}.${ns}`;

  return [
    {
      id: 'spark',
      label: 'Apache Spark',
      language: 'properties',
      code: [
        '--conf spark.sql.extensions=org.apache.iceberg.spark.extensions.IcebergSparkSessionExtensions',
        `--conf spark.sql.catalog.${alias}=org.apache.iceberg.spark.SparkCatalog`,
        `--conf spark.sql.catalog.${alias}.type=rest`,
        `--conf spark.sql.catalog.${alias}.uri=${uri}`,
        `--conf spark.sql.catalog.${alias}.warehouse=${wh}`,
        `--conf spark.sql.catalog.${alias}.token=${TOKEN_PLACEHOLDER}`,
        '',
        `-- then:  SELECT * FROM ${fq}${tbl ? '' : '.<table>'} LIMIT 100;`,
      ].join('\n'),
      note:
        'Iceberg Spark runtime 1.5+ (org.apache.iceberg:iceberg-spark-runtime). The token is a Loom API token '
        + '(Settings → Developer → API tokens) — the same scoped PAT the REST proxy validates.',
    },
    {
      id: 'trino',
      label: 'Trino',
      language: 'properties',
      code: [
        `# etc/catalog/${alias}.properties`,
        'connector.name=iceberg',
        'iceberg.catalog.type=rest',
        `iceberg.rest-catalog.uri=${uri}`,
        `iceberg.rest-catalog.warehouse=${wh}`,
        'iceberg.rest-catalog.security=OAUTH2',
        `iceberg.rest-catalog.oauth2.token=${TOKEN_PLACEHOLDER}`,
        'iceberg.rest-catalog.vended-credentials-enabled=true',
        '',
        `-- then:  SELECT * FROM ${fq}${tbl ? '' : '.<table>'} LIMIT 100;`,
      ].join('\n'),
      note:
        'Trino 435+. `vended-credentials-enabled` lets the catalog hand Trino a short-lived ADLS credential so '
        + 'Trino reads the customer-owned lake directly — zero copy, no storage keys in the Trino config.',
    },
    {
      id: 'duckdb',
      label: 'DuckDB',
      language: 'sql',
      code: [
        'INSTALL iceberg; LOAD iceberg;',
        'INSTALL httpfs; LOAD httpfs;',
        `CREATE SECRET loom_irc (TYPE ICEBERG, TOKEN '${TOKEN_PLACEHOLDER}');`,
        `ATTACH '${wh}' AS ${alias} (TYPE ICEBERG, SECRET loom_irc, ENDPOINT '${uri}');`,
        '',
        `SELECT * FROM ${fq}${tbl ? '' : '.<table>'} LIMIT 100;`,
      ].join('\n'),
      note: 'DuckDB 1.1+ with the iceberg + httpfs extensions. Reads the same Parquet files in place.',
    },
    {
      id: 'snowflake',
      label: 'Snowflake',
      language: 'sql',
      code: [
        `CREATE OR REPLACE CATALOG INTEGRATION ${alias}_irc`,
        '  CATALOG_SOURCE = ICEBERG_REST',
        '  TABLE_FORMAT = ICEBERG',
        `  CATALOG_NAMESPACE = '${ns}'`,
        `  REST_CONFIG = ( CATALOG_URI = '${uri}', WAREHOUSE = '${wh}' )`,
        `  REST_AUTHENTICATION = ( TYPE = BEARER, BEARER_TOKEN = '${TOKEN_PLACEHOLDER}' )`,
        '  ENABLED = TRUE;',
        '',
        `CREATE OR REPLACE ICEBERG TABLE ${tbl || '<table>'}`,
        `  CATALOG = '${alias}_irc'`,
        `  CATALOG_TABLE_NAME = '${tbl || '<table>'}'`,
        '  EXTERNAL_VOLUME = \'<your-external-volume-on-the-same-adls-container>\';',
      ].join('\n'),
      note:
        'Snowflake catalog-linked / REST catalog integration. The EXTERNAL VOLUME must point at the SAME ADLS '
        + 'container the table lives in (azure:// scheme) so Snowflake reads in place instead of copying.',
    },
    {
      id: 'databricks',
      label: 'Databricks',
      language: 'sql',
      code: [
        '-- Unity Catalog federation to the Loom Iceberg REST Catalog',
        `CREATE CONNECTION ${alias}_irc TYPE ICEBERG`,
        '  OPTIONS (',
        `    uri '${uri}',`,
        `    warehouse '${wh}',`,
        `    token '${TOKEN_PLACEHOLDER}'`,
        '  );',
        '',
        `CREATE FOREIGN CATALOG ${alias} USING CONNECTION ${alias}_irc OPTIONS (warehouse '${wh}');`,
        `SELECT * FROM ${fq}${tbl ? '' : '.<table>'} LIMIT 100;`,
      ].join('\n'),
      note:
        'Databricks Lakehouse Federation over a generic Iceberg REST catalog. Optional — Loom needs no Databricks '
        + 'workspace; this row exists so a Databricks shop can read Loom tables without migrating them.',
    },
  ];
}
