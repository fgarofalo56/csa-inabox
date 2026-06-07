import { describe, it, expect } from 'vitest';
import {
  ALLOWED_RETENTION_HOURS,
  validateMaintenanceRequest,
  buildAbfssUri,
  buildMaintenancePlan,
  buildMaintenancePySpark,
  parseDdlColumns,
} from '../delta-maintenance';

describe('validateMaintenanceRequest', () => {
  const base = { container: 'bronze', tableName: 'orders', pool: 'sparkpool', compaction: true, vacuumRetentionHours: 168, zorderColumns: [] as string[] };

  it('accepts a well-formed request', () => {
    const r = validateMaintenanceRequest(base);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.vacuumRetentionHours).toBe(168);
      expect(r.value.compaction).toBe(true);
    }
  });

  it('rejects a missing container', () => {
    const r = validateMaintenanceRequest({ ...base, container: '' });
    expect(r.ok).toBe(false);
  });

  it('rejects a retention value outside the allowlist', () => {
    const r = validateMaintenanceRequest({ ...base, vacuumRetentionHours: 100 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('vacuumRetentionHours');
  });

  it('accepts every allowlisted retention value', () => {
    for (const h of ALLOWED_RETENTION_HOURS) {
      expect(validateMaintenanceRequest({ ...base, vacuumRetentionHours: h }).ok).toBe(true);
    }
  });

  it('rejects a SQL-injection attempt in a zorder column', () => {
    const r = validateMaintenanceRequest({ ...base, zorderColumns: ['ok_col', 'bad); DROP TABLE x;--'] });
    expect(r.ok).toBe(false);
  });

  it('rejects a bad Spark pool name', () => {
    const r = validateMaintenanceRequest({ ...base, pool: 'pool; rm -rf /' });
    expect(r.ok).toBe(false);
  });

  it('rejects path traversal in tableName', () => {
    const r = validateMaintenanceRequest({ ...base, tableName: '../../secrets' });
    expect(r.ok).toBe(false);
  });

  it('rejects ZORDER without compaction', () => {
    const r = validateMaintenanceRequest({ ...base, compaction: false, vacuumRetentionHours: 168, zorderColumns: ['order_date'] });
    expect(r.ok).toBe(false);
  });

  it('rejects a no-op (no compaction, no vacuum)', () => {
    const r = validateMaintenanceRequest({ ...base, compaction: false, vacuumRetentionHours: 0 });
    expect(r.ok).toBe(false);
  });

  it('allows vacuum-only', () => {
    const r = validateMaintenanceRequest({ ...base, compaction: false, vacuumRetentionHours: 336, zorderColumns: [] });
    expect(r.ok).toBe(true);
  });

  it('dedupes zorder columns', () => {
    const r = validateMaintenanceRequest({ ...base, zorderColumns: ['a', 'a', 'b'] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.zorderColumns).toEqual(['a', 'b']);
  });
});

describe('buildAbfssUri', () => {
  it('builds a Tables/ abfss uri', () => {
    expect(buildAbfssUri('bronze', 'loomdlz01', 'orders')).toBe(
      'abfss://bronze@loomdlz01.dfs.core.windows.net/Tables/orders',
    );
  });
});

describe('buildMaintenancePlan', () => {
  it('lists OPTIMIZE + ZORDER + VACUUM', () => {
    const plan = buildMaintenancePlan({ container: 'b', tableName: 't', pool: 'p', compaction: true, vacuumRetentionHours: 168, zorderColumns: ['c1', 'c2'] });
    expect(plan).toEqual(['OPTIMIZE ZORDER BY (c1, c2)', 'VACUUM RETAIN 168 HOURS']);
  });

  it('lists bare OPTIMIZE when no zorder', () => {
    const plan = buildMaintenancePlan({ container: 'b', tableName: 't', pool: 'p', compaction: true, vacuumRetentionHours: 0, zorderColumns: [] });
    expect(plan).toEqual(['OPTIMIZE']);
  });
});

describe('buildMaintenancePySpark', () => {
  it('emits OPTIMIZE ZORDER + VACUUM pyspark against the table uri', () => {
    const { code, ops } = buildMaintenancePySpark(
      { container: 'bronze', tableName: 'orders', pool: 'sparkpool', compaction: true, vacuumRetentionHours: 168, zorderColumns: ['order_date'] },
      'loomdlz01',
    );
    expect(code).toContain('spark.databricks.delta.retentionDurationCheck.enabled');
    expect(code).toContain('abfss://bronze@loomdlz01.dfs.core.windows.net/Tables/orders');
    expect(code).toContain('OPTIMIZE delta.`{_uri}` ZORDER BY (order_date)');
    expect(code).toContain('VACUUM delta.`{_uri}` RETAIN 168 HOURS');
    expect(code).toContain('loom-maintenance-done');
    expect(ops).toEqual(['OPTIMIZE ZORDER BY (order_date)', 'VACUUM RETAIN 168 HOURS']);
  });

  it('omits VACUUM when retention is 0', () => {
    const { code } = buildMaintenancePySpark(
      { container: 'bronze', tableName: 'orders', pool: 'sparkpool', compaction: true, vacuumRetentionHours: 0, zorderColumns: [] },
      'acct',
    );
    expect(code).toContain('OPTIMIZE delta.`{_uri}`');
    expect(code).not.toContain('RETAIN');
  });
});

describe('parseDdlColumns', () => {
  it('extracts columns from a CREATE TABLE with nested type parens', () => {
    const ddl =
      'CREATE TABLE gold.fact_sales (\n' +
      '    sale_id      BIGINT       NOT NULL,\n' +
      '    amount       DECIMAL(18,2) NOT NULL,\n' +
      '    sale_date    DATE,\n' +
      '    region       VARCHAR(8)\n' +
      ') USING DELTA;';
    expect(parseDdlColumns(ddl)).toEqual(['sale_id', 'amount', 'sale_date', 'region']);
  });

  it('skips table-level constraints', () => {
    const ddl = 'CREATE TABLE t (id BIGINT NOT NULL, name STRING, PRIMARY KEY (id)) USING DELTA;';
    expect(parseDdlColumns(ddl)).toEqual(['id', 'name']);
  });

  it('returns [] for empty / malformed ddl', () => {
    expect(parseDdlColumns('')).toEqual([]);
    expect(parseDdlColumns('not a ddl')).toEqual([]);
  });
});
