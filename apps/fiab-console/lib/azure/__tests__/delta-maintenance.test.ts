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

  // N1 — Delta↔Iceberg dual metadata rides the SAME maintenance job.
  it('lists the Iceberg emit/disable op', () => {
    const base = { container: 'b', tableName: 't', pool: 'p', compaction: false, vacuumRetentionHours: 0, zorderColumns: [] };
    expect(buildMaintenancePlan({ ...base, icebergMetadata: true }))
      .toEqual(['EMIT ICEBERG METADATA (UniForm / XTable)']);
    expect(buildMaintenancePlan({ ...base, icebergMetadata: false }))
      .toEqual(['DISABLE ICEBERG METADATA']);
    // Unset leaves the plan (and the generated job) exactly as before N1.
    expect(buildMaintenancePlan({ ...base, compaction: true })).toEqual(['OPTIMIZE']);
  });
});

describe('N1 — Iceberg dual metadata on the maintenance job', () => {
  it('accepts an Iceberg-only request (the Interop tab submits exactly that)', () => {
    const r = validateMaintenanceRequest({
      container: 'gold', tableName: 'orders', pool: 'loompool',
      compaction: false, vacuumRetentionHours: 0, zorderColumns: [], icebergMetadata: true,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.icebergMetadata).toBe(true);
  });

  it('still rejects a request with nothing at all to do', () => {
    const r = validateMaintenanceRequest({
      container: 'gold', tableName: 'orders', pool: 'loompool',
      compaction: false, vacuumRetentionHours: 0, zorderColumns: [],
    });
    expect(r.ok).toBe(false);
  });

  it('emits the UniForm enable AFTER compaction, against the same table URI', () => {
    const { code, ops } = buildMaintenancePySpark(
      {
        container: 'gold', tableName: 'orders', pool: 'loompool',
        compaction: true, vacuumRetentionHours: 0, zorderColumns: [], icebergMetadata: true,
      },
      'loomdlz01',
    );
    const uri = 'abfss://gold@loomdlz01.dfs.core.windows.net/Tables/orders';
    expect(code).toContain(`_ice_uri = ${JSON.stringify(uri)}`);
    expect(code).toContain("'delta.universalFormat.enabledFormats' = 'iceberg'");
    // Ordering matters: the registered Iceberg snapshot must point at the
    // freshly bin-packed files, so OPTIMIZE precedes the Iceberg step.
    expect(code.indexOf('OPTIMIZE delta.')).toBeLessThan(code.indexOf('_ice_uri ='));
    expect(ops).toEqual(['OPTIMIZE', 'EMIT ICEBERG METADATA (UniForm / XTable)']);
  });

  it('generates the disable statement without touching data or the Delta log', () => {
    const { code } = buildMaintenancePySpark(
      {
        container: 'gold', tableName: 'orders', pool: 'loompool',
        compaction: false, vacuumRetentionHours: 0, zorderColumns: [], icebergMetadata: false,
      },
      'loomdlz01',
    );
    expect(code).toContain("UNSET TBLPROPERTIES IF EXISTS ('delta.universalFormat.enabledFormats')");
    expect(code).not.toContain('VACUUM delta.');
    expect(code).not.toContain('OPTIMIZE delta.');
  });

  it('leaves the pre-N1 job byte-identical when icebergMetadata is unset', () => {
    const req = {
      container: 'gold', tableName: 'orders', pool: 'loompool',
      compaction: true, vacuumRetentionHours: 168, zorderColumns: ['order_date'],
    };
    const { code } = buildMaintenancePySpark(req, 'loomdlz01');
    expect(code).not.toContain('_ice_uri');
    expect(code).not.toContain('loom-iceberg-metadata');
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
