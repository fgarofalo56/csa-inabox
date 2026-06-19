import { describe, it, expect } from 'vitest';
import {
  buildCreateMlvSql,
  buildRefreshPySpark,
  extractSqlSources,
  extractPySparkSources,
  deriveSources,
  validateMlvSpec,
  mlvFqn,
  mlvDeltaPath,
  buildRefreshAdfPipeline,
  type MlvSpec,
} from '../materialized-lake-view-model';

const baseSql: MlvSpec = {
  language: 'sql',
  container: 'silver',
  schema: 'silver',
  viewName: 'customer_enriched',
  sql: 'SELECT id, name FROM bronze.customer_bronze WHERE name IS NOT NULL',
  constraints: [{ name: 'name_chk', expression: 'name IS NOT NULL', onViolation: 'DROP' }],
};

const basePy: MlvSpec = {
  language: 'pyspark',
  container: 'gold',
  schema: 'gold',
  viewName: 'sales_agg',
  pyspark: 'df = spark.read.table("silver.customer_enriched")\nreturn df',
};

describe('mlv identity helpers', () => {
  it('builds the fully-qualified name', () => {
    expect(mlvFqn(baseSql)).toBe('silver.customer_enriched');
  });
  it('builds the Delta path', () => {
    expect(mlvDeltaPath(baseSql)).toBe('Tables/silver/customer_enriched');
  });
});

describe('buildCreateMlvSql', () => {
  it('emits CREATE MATERIALIZED LAKE VIEW with constraints', () => {
    const ddl = buildCreateMlvSql(baseSql);
    expect(ddl).toContain('CREATE MATERIALIZED LAKE VIEW IF NOT EXISTS silver.customer_enriched');
    expect(ddl).toContain('CONSTRAINT name_chk CHECK (name IS NOT NULL) ON MISMATCH DROP');
    expect(ddl).toContain('AS\nSELECT id, name FROM bronze.customer_bronze');
  });
  it('includes PARTITIONED BY + TBLPROPERTIES when set', () => {
    const ddl = buildCreateMlvSql({ ...baseSql, partitionCols: ['year'], tableProperties: { enableChangeDataFeed: 'true' } });
    expect(ddl).toContain('PARTITIONED BY (year)');
    expect(ddl).toContain("TBLPROPERTIES ('enableChangeDataFeed' = 'true')");
  });
});

describe('source extraction', () => {
  it('extracts FROM/JOIN tables from SQL, skipping CTEs', () => {
    const s = extractSqlSources('WITH t AS (SELECT * FROM bronze.a) SELECT * FROM t JOIN bronze.b ON t.id = bronze.b.id');
    expect(s).toContain('bronze.a');
    expect(s).toContain('bronze.b');
    expect(s).not.toContain('t');
  });
  it('extracts spark.read.table + load from PySpark', () => {
    const s = extractPySparkSources('df = spark.read.table("silver.x"); df2 = spark.read.format("delta").load("abfss://c@h/p")');
    expect(s).toContain('silver.x');
    expect(s).toContain('abfss://c@h/p');
  });
  it('deriveSources dispatches by language', () => {
    expect(deriveSources(baseSql)).toContain('bronze.customer_bronze');
    expect(deriveSources(basePy)).toContain('silver.customer_enriched');
  });
});

describe('buildRefreshPySpark', () => {
  const url = 'abfss://silver@acct.dfs.core.windows.net/materialized-lake-views/customer_enriched/Tables/silver/customer_enriched';
  it('SQL MLV runs spark.sql and writes Delta to the abfss path', () => {
    const py = buildRefreshPySpark(baseSql, url);
    expect(py).toContain('spark.sql(__mlv_sql)');
    expect(py).toContain('.format("delta")');
    expect(py).toContain(url);
  });
  it('DROP constraint becomes a filter', () => {
    const py = buildRefreshPySpark(baseSql, url);
    expect(py).toContain('df = df.filter(name IS NOT NULL)');
  });
  it('FAIL constraint raises on violation', () => {
    const py = buildRefreshPySpark(
      { ...baseSql, constraints: [{ name: 'must', expression: 'id > 0', onViolation: 'FAIL' }] },
      url,
    );
    expect(py).toContain('df.filter(~(id > 0))');
    expect(py).toContain('raise Exception');
  });
  it('PySpark MLV inlines the user function body', () => {
    const py = buildRefreshPySpark(basePy, url);
    expect(py).toContain('def __mlv_define():');
    expect(py).toContain('spark.read.table("silver.customer_enriched")');
  });
});

describe('validateMlvSpec', () => {
  it('passes a valid SQL spec', () => {
    expect(validateMlvSpec(baseSql)).toEqual([]);
  });
  it('flags missing SQL', () => {
    expect(validateMlvSpec({ ...baseSql, sql: '' }).join(' ')).toMatch(/SQL definition/);
  });
  it('flags PySpark without return', () => {
    expect(validateMlvSpec({ ...basePy, pyspark: 'df = spark.table("x")' }).join(' ')).toMatch(/return/);
  });
  it('flags bad identifiers + container', () => {
    const errs = validateMlvSpec({ ...baseSql, schema: '1bad', viewName: 'no-dash', container: 'nope' as any });
    expect(errs.length).toBeGreaterThanOrEqual(2);
  });
});

describe('buildRefreshAdfPipeline', () => {
  it('emits a single Web activity refresh pipeline', () => {
    const p = buildRefreshAdfPipeline({ refreshUrl: 'https://x/api/refresh', fqn: 'silver.v', deltaUrl: 'abfss://...' });
    const acts = p.properties.activities as any[];
    expect(acts).toHaveLength(1);
    expect(acts[0].name).toBe('RefreshMaterializedLakeView');
    expect(acts[0].type).toBe('WebActivity');
    expect(acts[0].typeProperties.url).toBe('https://x/api/refresh');
    expect(p.properties.annotations).toContain('loom:materialized-lake-view');
  });
});
