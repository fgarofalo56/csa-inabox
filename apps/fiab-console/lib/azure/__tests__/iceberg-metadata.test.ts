/**
 * N1 — Delta↔Iceberg DUAL METADATA emit + external-engine connect snippets.
 *
 * Pins the actually-load-bearing behaviour: the generated PySpark really turns
 * on Delta UniForm (with the REORG upgrade + Apache XTable fallbacks and an
 * honest "neither is available" report), the receipt parser refuses to invent a
 * success, and the connect snippets are real, engine-correct configuration that
 * never embeds a live token.
 */
import { describe, it, expect } from 'vitest';
import {
  ICEBERG_EMIT_MARKER,
  buildConnectSnippets,
  buildIcebergDisablePySpark,
  buildIcebergEmitPySpark,
  icebergMetadataLocation,
  parseIcebergEmitReceipt,
  toAzureScheme,
  toHttpsScheme,
} from '../iceberg-metadata';

const URI = 'abfss://gold@stloomdev.dfs.core.windows.net/Tables/sales/orders';

describe('metadata locations', () => {
  it('places Iceberg metadata beside the Delta log, under the table root', () => {
    expect(icebergMetadataLocation(URI)).toBe(`${URI}/metadata`);
    // Trailing slashes are normalized (a double slash breaks Hadoop FS listing).
    expect(icebergMetadataLocation(`${URI}///`)).toBe(`${URI}/metadata`);
  });

  it('translates abfss:// to the azure:// and https:// forms readers ask for', () => {
    expect(toAzureScheme(URI)).toBe('azure://stloomdev.dfs.core.windows.net/gold/Tables/sales/orders');
    expect(toHttpsScheme(URI)).toBe('https://stloomdev.dfs.core.windows.net/gold/Tables/sales/orders');
    // A non-abfss input is returned untouched rather than mangled.
    expect(toAzureScheme('s3://bucket/x')).toBe('s3://bucket/x');
  });
});

describe('buildIcebergEmitPySpark', () => {
  const code = buildIcebergEmitPySpark(URI).join('\n');

  it('enables Delta UniForm IcebergCompatV2 as the primary path', () => {
    expect(code).toContain("'delta.enableIcebergCompatV2' = 'true'");
    expect(code).toContain("'delta.universalFormat.enabledFormats' = 'iceberg'");
    expect(code).toContain('ALTER TABLE delta.`{_ice_uri}` SET TBLPROPERTIES');
  });

  it('falls back to REORG … UPGRADE UNIFORM for tables with an older protocol', () => {
    expect(code).toContain('REORG TABLE delta.`{_ice_uri}` APPLY (UPGRADE UNIFORM(ICEBERG_COMPAT_VERSION=2))');
  });

  it('falls back to Apache XTable and reports honestly when neither exists', () => {
    expect(code).toContain('xtable');
    expect(code).toContain('xtable-unavailable');
    // The honest branch must name the concrete remediation, not a vague error.
    expect(code).toContain('org.apache.xtable:xtable-core');
  });

  it('VERIFIES the metadata folder instead of assuming success', () => {
    expect(code).toContain('org.apache.hadoop.fs.Path(_ice_uri + "/metadata")');
    expect(code).toContain('_fs.exists(_hp)');
    expect(code).toContain('"metadataFiles"');
  });

  it('embeds the table URI as a JSON literal (no quote can escape it)', () => {
    const evil = 'abfss://c@a.dfs.core.windows.net/Tables/x"; import os; os.system("rm -rf /") #';
    const line = buildIcebergEmitPySpark(evil).find((l) => l.startsWith('_ice_uri ='))!;
    expect(line).toBe(`_ice_uri = ${JSON.stringify(evil)}`);
    // The dangerous characters are escaped inside the literal, never raw code.
    expect(line).not.toContain('"; import os');
  });

  it('prints the parseable receipt marker', () => {
    expect(code).toContain(`print("${ICEBERG_EMIT_MARKER} "`);
  });
});

describe('buildIcebergDisablePySpark', () => {
  it('unsets ONLY the UniForm format property — never touches data or the Delta log', () => {
    const code = buildIcebergDisablePySpark(URI).join('\n');
    expect(code).toContain("UNSET TBLPROPERTIES IF EXISTS ('delta.universalFormat.enabledFormats')");
    expect(code).not.toMatch(/\bDROP\b|\bDELETE\b|\bVACUUM\b/);
  });
});

describe('parseIcebergEmitReceipt', () => {
  it('parses a real receipt line out of mixed Spark stdout', () => {
    const out = [
      'some spark noise',
      `${ICEBERG_EMIT_MARKER} {"uri":"${URI}","via":"delta-uniform","enabled":true,"detail":null,"metadataFiles":3}`,
      'more noise',
    ].join('\n');
    expect(parseIcebergEmitReceipt(out)).toEqual({
      uri: URI, via: 'delta-uniform', enabled: true, detail: null, metadataFiles: 3,
    });
  });

  it('returns null when the marker is absent — never fabricates a success', () => {
    expect(parseIcebergEmitReceipt('OPTIMIZE done')).toBeNull();
    expect(parseIcebergEmitReceipt(undefined)).toBeNull();
    expect(parseIcebergEmitReceipt(`${ICEBERG_EMIT_MARKER} {not json`)).toBeNull();
  });

  it('normalizes an unknown via to "none" and keeps enabled false', () => {
    const r = parseIcebergEmitReceipt(
      `${ICEBERG_EMIT_MARKER} {"uri":"x","via":"magic","enabled":false,"detail":"xtable-unavailable","metadataFiles":0}`,
    )!;
    expect(r.via).toBe('none');
    expect(r.enabled).toBe(false);
    expect(r.detail).toBe('xtable-unavailable');
  });
});

describe('buildConnectSnippets', () => {
  const snippets = buildConnectSnippets({
    catalogUri: 'https://loom.example.gov/api/catalog/iceberg/',
    warehouse: 'loom',
    namespace: 'gold.sales',
    table: 'orders',
    catalogAlias: 'loom',
  });
  const byId = Object.fromEntries(snippets.map((s) => [s.id, s]));

  it('covers every engine the item promises', () => {
    expect(snippets.map((s) => s.id)).toEqual(['spark', 'trino', 'duckdb', 'snowflake', 'databricks']);
  });

  it('normalizes the catalog URI (no double slash reaches an engine)', () => {
    for (const s of snippets) expect(s.code).not.toContain('iceberg//');
    expect(byId.spark.code).toContain('uri=https://loom.example.gov/api/catalog/iceberg');
  });

  it('emits real Iceberg REST catalog configuration per engine', () => {
    expect(byId.spark.code).toContain('org.apache.iceberg.spark.SparkCatalog');
    expect(byId.spark.code).toContain('spark.sql.catalog.loom.type=rest');
    expect(byId.trino.code).toContain('iceberg.catalog.type=rest');
    expect(byId.trino.code).toContain('iceberg.rest-catalog.warehouse=loom');
    expect(byId.duckdb.code).toContain("ATTACH 'loom' AS loom (TYPE ICEBERG");
    expect(byId.snowflake.code).toContain('CATALOG_SOURCE = ICEBERG_REST');
    expect(byId.snowflake.code).toContain("CATALOG_NAMESPACE = 'gold.sales'");
    expect(byId.databricks.code).toContain('CREATE CONNECTION loom_irc TYPE ICEBERG');
  });

  it('fully qualifies the selected table in every SELECT', () => {
    for (const s of snippets) {
      if (s.code.includes('SELECT')) expect(s.code).toContain('loom.gold.sales.orders');
    }
  });

  it('leaves <table> as a placeholder when no table is selected', () => {
    const catalogLevel = buildConnectSnippets({
      catalogUri: 'https://x/api/catalog/iceberg', warehouse: 'loom', namespace: 'gold',
    });
    expect(catalogLevel.find((s) => s.id === 'spark')!.code).toContain('loom.gold.<table>');
  });

  it('NEVER embeds a live secret — the token is always a placeholder', () => {
    for (const s of snippets) {
      expect(s.code).toContain('<loom-api-token>');
      expect(s.code).not.toMatch(/loom_pat_[A-Za-z0-9]/);
    }
  });

  it('carries an honest note naming what the operator still must supply', () => {
    for (const s of snippets) expect(s.note.length).toBeGreaterThan(20);
    expect(byId.snowflake.note).toContain('EXTERNAL VOLUME');
  });
});
