/**
 * Unit tests for the pure metric-view compilers (DBX-6). No network, no React.
 */
import { describe, it, expect } from 'vitest';
import {
  MetricBuildError,
  compileMetricViewSelect,
  compileMeasureDax,
  buildMetricViewYaml,
  buildCreateMetricViewDdl,
  buildDropMetricViewDdl,
  compileMetricViewQuery,
  buildShowViewsDdl,
  metricViewGroundingText,
  type MetricViewSpec,
} from '@/lib/sql/metric-view-builders';

const SPEC: MetricViewSpec = {
  source: 'sales.public.orders',
  dimensions: [
    { name: 'order_month', expr: "DATE_TRUNC('MONTH', o_orderdate)" },
    { name: 'status', expr: 'o_orderstatus' },
  ],
  measures: [
    { name: 'order_count', aggregation: 'COUNT' },
    { name: 'total_revenue', aggregation: 'SUM', expr: 'o_totalprice' },
    { name: 'distinct_customers', aggregation: 'COUNT_DISTINCT', expr: 'o_custkey' },
    { name: 'rev_per_cust', aggregation: 'CUSTOM', expr: 'SUM(o_totalprice) / COUNT(DISTINCT o_custkey)' },
  ],
  filter: "o_orderstatus <> 'X'",
};

describe('compileMetricViewSelect (Azure-native default)', () => {
  it('emits a GROUP BY SELECT with bracketed identifiers on the synapse dialect', () => {
    const sql = compileMetricViewSelect(SPEC, { dialect: 'synapse' });
    expect(sql).toContain('FROM [sales].[public].[orders]');
    expect(sql).toContain('[order_month]');
    expect(sql).toContain('COUNT(1) AS [order_count]');
    expect(sql).toContain('SUM(o_totalprice) AS [total_revenue]');
    expect(sql).toContain('COUNT(DISTINCT o_custkey) AS [distinct_customers]');
    expect(sql).toContain('SUM(o_totalprice) / COUNT(DISTINCT o_custkey) AS [rev_per_cust]');
    expect(sql).toContain("WHERE o_orderstatus <> 'X'");
    expect(sql).toContain("GROUP BY DATE_TRUNC('MONTH', o_orderdate), o_orderstatus");
    expect(sql.trim().endsWith(';')).toBe(true);
  });

  it('back-tick-quotes identifiers on the databricks-sql dialect', () => {
    const sql = compileMetricViewSelect(SPEC, { dialect: 'databricks-sql' });
    expect(sql).toContain('FROM `sales`.`public`.`orders`');
    expect(sql).toContain('AS `total_revenue`');
  });

  it('applies TOP on synapse and LIMIT on databricks when a limit is set', () => {
    expect(compileMetricViewSelect(SPEC, { dialect: 'synapse', limit: 50 })).toContain('SELECT TOP 50');
    const dbx = compileMetricViewSelect(SPEC, { dialect: 'databricks-sql', limit: 50 });
    expect(dbx).toContain('LIMIT 50');
    expect(dbx).not.toContain('TOP 50');
  });

  it('supports a measure-only metric view (no dimensions, no GROUP BY)', () => {
    const sql = compileMetricViewSelect({ source: 'orders', dimensions: [], measures: [{ name: 'n', aggregation: 'COUNT' }] });
    expect(sql).not.toContain('GROUP BY');
    expect(sql).toContain('COUNT(1) AS [n]');
  });

  it('rejects a spec with no measures', () => {
    expect(() => compileMetricViewSelect({ source: 'orders', dimensions: [], measures: [] })).toThrow(MetricBuildError);
  });

  it('rejects an injection attempt in a measure expression', () => {
    expect(() => compileMetricViewSelect({
      source: 'orders', dimensions: [], measures: [{ name: 'x', aggregation: 'SUM', expr: 'a); DROP TABLE t; --' }],
    })).toThrow(/';'|comment|allowed set/);
  });

  it('rejects expression characters outside the allowlist (backslash, @@, braces)', () => {
    for (const expr of ['name = @@version', 'val\\bad', 'SUM({a})', 'x $ y']) {
      expect(() => compileMetricViewSelect({
        source: 'orders', dimensions: [], measures: [{ name: 'm', aggregation: 'CUSTOM', expr }],
      })).toThrow(MetricBuildError);
    }
  });

  it('accepts a real quoted/aggregate expression through the allowlist', () => {
    const sql = compileMetricViewSelect({
      source: 'orders',
      dimensions: [{ name: 'order_month', expr: "DATE_TRUNC('MONTH', o_orderdate)" }],
      measures: [{ name: 'rev_per_cust', aggregation: 'CUSTOM', expr: 'SUM(o_totalprice) / COUNT(DISTINCT o_custkey)' }],
      filter: "o_orderstatus <> 'X'",
    });
    expect(sql).toContain("DATE_TRUNC('MONTH', o_orderdate)");
    expect(sql).toContain("WHERE o_orderstatus <> 'X'");
  });

  it('rejects a bad measure name (would become an alias)', () => {
    expect(() => compileMetricViewSelect({
      source: 'orders', dimensions: [], measures: [{ name: 'bad name', aggregation: 'COUNT' }],
    })).toThrow(MetricBuildError);
  });

  it('rejects a source with too many parts', () => {
    expect(() => compileMetricViewSelect({ source: 'a.b.c.d', dimensions: [], measures: [{ name: 'n', aggregation: 'COUNT' }] })).toThrow(/1–3 part/);
  });
});

describe('compileMeasureDax (Loom semantic-layer default)', () => {
  it('maps aggregations to DAX', () => {
    expect(compileMeasureDax({ name: 'r', aggregation: 'SUM', expr: 'amount' }, 'Sales')).toBe("SUM ( 'Sales'[amount] )");
    expect(compileMeasureDax({ name: 'a', aggregation: 'AVG', expr: 'amount' }, 'Sales')).toBe("AVERAGE ( 'Sales'[amount] )");
    expect(compileMeasureDax({ name: 'd', aggregation: 'COUNT_DISTINCT', expr: 'cust' }, 'Sales')).toBe("DISTINCTCOUNT ( 'Sales'[cust] )");
    expect(compileMeasureDax({ name: 'c', aggregation: 'COUNT' }, 'Sales')).toBe("COUNTROWS ( 'Sales' )");
  });

  it('passes a CUSTOM expression through', () => {
    expect(compileMeasureDax({ name: 'r', aggregation: 'CUSTOM', expr: 'DIVIDE ( [rev], [cust] )' })).toBe('DIVIDE ( [rev], [cust] )');
  });

  it('escapes a single quote in the table name', () => {
    expect(compileMeasureDax({ name: 'r', aggregation: 'SUM', expr: 'amount' }, "O'Brien")).toContain("'O''Brien'[amount]");
  });
});

describe('buildMetricViewYaml + buildCreateMetricViewDdl (Databricks opt-in)', () => {
  it('emits a valid WITH METRICS LANGUAGE YAML DDL', () => {
    const ddl = buildCreateMetricViewDdl({ catalog: 'main', schema: 'sales', name: 'orders_mv', spec: SPEC, orReplace: true });
    expect(ddl).toContain('CREATE OR REPLACE VIEW `main`.`sales`.`orders_mv`');
    expect(ddl).toContain('WITH METRICS');
    expect(ddl).toContain('LANGUAGE YAML');
    expect(ddl).toContain('AS $$');
    expect(ddl).toContain('version: 0.1');
    expect(ddl).toContain('source: sales.public.orders');
    expect(ddl).toContain('dimensions:');
    expect(ddl).toContain('- name: order_month');
    expect(ddl).toContain('measures:');
    expect(ddl).toContain('- name: total_revenue');
    expect(ddl).toContain('expr: "SUM(o_totalprice)"');
    expect(ddl.trim().endsWith('$$;')).toBe(true);
  });

  it('YAML double-quote-escapes an expression containing a quote', () => {
    const yaml = buildMetricViewYaml({
      source: 'orders', dimensions: [{ name: 'seg', expr: "CASE WHEN x = 'A' THEN 'a' END" }],
      measures: [{ name: 'n', aggregation: 'COUNT' }],
    });
    expect(yaml).toContain('expr: "CASE WHEN x = \'A\' THEN \'a\' END"');
  });

  it('rejects a `$$` breakout in an expression (would end the YAML block)', () => {
    expect(() => buildCreateMetricViewDdl({
      catalog: 'c', schema: 's', name: 'v',
      spec: { source: 'orders', dimensions: [], measures: [{ name: 'n', aggregation: 'CUSTOM', expr: 'x $$ y' }] },
    })).toThrow(/\$\$/);
  });

  it('DROP + SHOW builders quote identifiers', () => {
    expect(buildDropMetricViewDdl('main', 'sales', 'orders_mv')).toBe('DROP VIEW IF EXISTS `main`.`sales`.`orders_mv`;');
    expect(buildShowViewsDdl('main', 'sales')).toBe('SHOW VIEWS IN `main`.`sales`;');
  });
});

describe('compileMetricViewQuery (MEASURE() form)', () => {
  it('wraps measures in MEASURE() and groups by dimensions', () => {
    const sql = compileMetricViewQuery({ catalog: 'main', schema: 'sales', name: 'orders_mv', dimensions: ['status'], measures: ['total_revenue'], limit: 10 });
    expect(sql).toContain('SELECT `status`, MEASURE(`total_revenue`)');
    expect(sql).toContain('FROM `main`.`sales`.`orders_mv`');
    expect(sql).toContain('GROUP BY `status`');
    expect(sql).toContain('LIMIT 10');
  });

  it('requires at least one dimension or measure', () => {
    expect(() => compileMetricViewQuery({ catalog: 'c', schema: 's', name: 'v', dimensions: [], measures: [] })).toThrow(MetricBuildError);
  });
});

describe('metricViewGroundingText (DBX-5 delta)', () => {
  it('lists governed dimensions + measures with their compiled SQL', () => {
    const text = metricViewGroundingText(SPEC, 'orders_mv');
    expect(text).toContain('## Metric view: orders_mv');
    expect(text).toContain('Source table: sales.public.orders');
    expect(text).toContain('order_count = COUNT(1)');
    expect(text).toContain('total_revenue = SUM(o_totalprice)');
    expect(text).toContain('Governed measures');
  });
});
