/**
 * statistics-client — unit tests for the statistics + maintenance SQL generators.
 *
 * Covers: identifier validation (incl. injection attempts), Synapse CREATE /
 * UPDATE / DROP / list SQL shapes, Databricks ANALYZE / OPTIMIZE SQL shapes, and
 * a cloud-matrix block proving the generated SQL is cloud-INVARIANT (the SQL text
 * never changes per AZURE_CLOUD — only the endpoint the BFF dials does, which is
 * covered by cloud-matrix.test.ts).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  validateIdent,
  buildSynapseListStatisticsSQL,
  buildSynapseListColumnsSQL,
  buildSynapseCreateStatisticsSQL,
  buildSynapseUpdateStatisticsSQL,
  buildSynapseDropStatisticsSQL,
  buildDatabricksAnalyzeSQL,
  buildDatabricksOptimizeSQL,
  SCAN_MODES,
} from '../statistics-client';

function sql(b: { ok: true; sql: string } | { ok: false; error: string }): string {
  if (!b.ok) throw new Error(`expected ok, got error: ${b.error}`);
  return b.sql;
}

describe('validateIdent', () => {
  it('accepts valid SQL identifiers', () => {
    for (const name of ['dbo', 'Orders', 'customer_id', '_internal', 'col123']) {
      const r = validateIdent(name);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toBe(name);
    }
  });

  it('rejects empty / whitespace', () => {
    expect(validateIdent('').ok).toBe(false);
    expect(validateIdent('   ').ok).toBe(false);
    expect(validateIdent(undefined).ok).toBe(false);
    expect(validateIdent(null).ok).toBe(false);
  });

  it('rejects injection attempts', () => {
    for (const bad of [
      'Orders; DROP TABLE Users',
      "x'); DELETE FROM sys.stats--",
      'a b',
      'tbl]; --',
      'foo`bar',
      'schema.table',
      '1col',
    ]) {
      expect(validateIdent(bad).ok).toBe(false);
    }
  });

  it('rejects over-long identifiers', () => {
    expect(validateIdent('a'.repeat(129)).ok).toBe(false);
  });
});

describe('Synapse statistics SQL', () => {
  it('list: filters to user_created and the given schema/table', () => {
    const out = sql(buildSynapseListStatisticsSQL('dbo', 'Orders'));
    expect(out).toContain('FROM sys.stats st');
    expect(out).toContain("s.name = 'dbo'");
    expect(out).toContain("t.name = 'Orders'");
    expect(out).toContain('st.user_created = 1');
    expect(out).toContain('STATS_DATE(st.object_id, st.stats_id)');
  });

  it('list columns: queries sys.columns', () => {
    const out = sql(buildSynapseListColumnsSQL('sales', 'Fact'));
    expect(out).toContain('FROM sys.columns co');
    expect(out).toContain("s.name = 'sales'");
    expect(out).toContain("t.name = 'Fact'");
  });

  it('create: bracket-quotes and emits the column list (default scan = no clause)', () => {
    const out = sql(buildSynapseCreateStatisticsSQL('dbo', 'Orders', 'stat_cust', ['CustomerId'], 'default'));
    expect(out).toBe('CREATE STATISTICS [stat_cust] ON [dbo].[Orders] ([CustomerId]);');
  });

  it('create: FULLSCAN clause + multi-column', () => {
    const out = sql(buildSynapseCreateStatisticsSQL('dbo', 'Orders', 's1', ['A', 'B'], 'fullscan'));
    expect(out).toBe('CREATE STATISTICS [s1] ON [dbo].[Orders] ([A], [B]) WITH FULLSCAN;');
  });

  it('create: SAMPLE percent clauses', () => {
    expect(sql(buildSynapseCreateStatisticsSQL('dbo', 'T', 's', ['c'], 'sample-20'))).toContain('WITH SAMPLE 20 PERCENT');
    expect(sql(buildSynapseCreateStatisticsSQL('dbo', 'T', 's', ['c'], 'sample-50'))).toContain('WITH SAMPLE 50 PERCENT');
  });

  it('create: dedups columns preserving order', () => {
    const out = sql(buildSynapseCreateStatisticsSQL('dbo', 'T', 's', ['A', 'B', 'A'], 'default'));
    expect(out).toBe('CREATE STATISTICS [s] ON [dbo].[T] ([A], [B]);');
  });

  it('create: requires at least one column', () => {
    const r = buildSynapseCreateStatisticsSQL('dbo', 'T', 's', [], 'default');
    expect(r.ok).toBe(false);
  });

  it('create: rejects injection in any identifier or column', () => {
    expect(buildSynapseCreateStatisticsSQL('dbo', 'T', 's; DROP', ['c'], 'default').ok).toBe(false);
    expect(buildSynapseCreateStatisticsSQL('dbo', 'T', 's', ['c); DROP STATISTICS--'], 'default').ok).toBe(false);
    expect(buildSynapseCreateStatisticsSQL("d'", 'T', 's', ['c'], 'default').ok).toBe(false);
  });

  it('update: named statistics → parenthesised; unnamed → whole table', () => {
    expect(sql(buildSynapseUpdateStatisticsSQL('dbo', 'Orders', 'stat_cust')))
      .toBe('UPDATE STATISTICS [dbo].[Orders] ([stat_cust]);');
    expect(sql(buildSynapseUpdateStatisticsSQL('dbo', 'Orders')))
      .toBe('UPDATE STATISTICS [dbo].[Orders];');
    expect(sql(buildSynapseUpdateStatisticsSQL('dbo', 'Orders', '')))
      .toBe('UPDATE STATISTICS [dbo].[Orders];');
  });

  it('drop: emits the 3-part schema.table.stat name', () => {
    expect(sql(buildSynapseDropStatisticsSQL('dbo', 'Orders', 'stat_cust')))
      .toBe('DROP STATISTICS [dbo].[Orders].[stat_cust];');
  });

  it('drop: requires a statistics name', () => {
    expect(buildSynapseDropStatisticsSQL('dbo', 'Orders', '').ok).toBe(false);
  });
});

describe('Databricks ANALYZE / OPTIMIZE SQL', () => {
  it('analyze: FOR ALL COLUMNS when no columns given', () => {
    expect(sql(buildDatabricksAnalyzeSQL('main', 'sales', 'orders')))
      .toBe('ANALYZE TABLE `main`.`sales`.`orders` COMPUTE STATISTICS FOR ALL COLUMNS;');
  });

  it('analyze: FOR COLUMNS list when columns given', () => {
    expect(sql(buildDatabricksAnalyzeSQL('main', 'sales', 'orders', ['c1', 'c2'])))
      .toBe('ANALYZE TABLE `main`.`sales`.`orders` COMPUTE STATISTICS FOR COLUMNS `c1`, `c2`;');
  });

  it('optimize: plain compaction', () => {
    expect(sql(buildDatabricksOptimizeSQL('main', 'sales', 'orders')))
      .toBe('OPTIMIZE `main`.`sales`.`orders`;');
  });

  it('optimize: ZORDER BY columns', () => {
    expect(sql(buildDatabricksOptimizeSQL('main', 'sales', 'orders', ['region', 'date'])))
      .toBe('OPTIMIZE `main`.`sales`.`orders` ZORDER BY (`region`, `date`);');
  });

  it('optimize: rejects injection in ZORDER columns', () => {
    expect(buildDatabricksOptimizeSQL('main', 'sales', 'orders', ['region`); DROP TABLE x--']).ok).toBe(false);
  });

  it('optimize: rejects injection in catalog name', () => {
    expect(buildDatabricksOptimizeSQL('main`; DROP', 'sales', 'orders').ok).toBe(false);
  });

  it('analyze: rejects injection in schema name', () => {
    expect(buildDatabricksAnalyzeSQL('main', 'sales`; --', 'orders').ok).toBe(false);
  });

  it('SCAN_MODES contains the four allowlisted modes', () => {
    expect(SCAN_MODES).toEqual(['default', 'fullscan', 'sample-20', 'sample-50']);
  });
});

// ============================================================
// Cloud matrix — SQL generation is cloud-INVARIANT
// ============================================================
// The statistics/optimize SQL never changes per sovereign cloud; only the
// endpoint the BFF dials (LOOM_DATABRICKS_HOSTNAME / Synapse SQL suffix) does,
// and that is covered by cloud-matrix.test.ts. This block proves the builders
// emit byte-identical SQL under Commercial, GCC-High and IL5/DoD so a cloud
// change can never silently alter a generated statement.
describe('cloud-matrix — statistics/optimize SQL is cloud-invariant', () => {
  const SAVED = { ...process.env };
  afterEach(() => {
    process.env = { ...SAVED };
    vi.resetModules();
  });

  for (const cloud of ['AzureCloud', 'AzureUSGovernment', 'AzureDOD']) {
    it(`generates identical SQL under ${cloud}`, () => {
      process.env.AZURE_CLOUD = cloud;
      expect(sql(buildSynapseCreateStatisticsSQL('dbo', 'Orders', 's', ['A'], 'fullscan')))
        .toBe('CREATE STATISTICS [s] ON [dbo].[Orders] ([A]) WITH FULLSCAN;');
      expect(sql(buildSynapseDropStatisticsSQL('dbo', 'Orders', 's')))
        .toBe('DROP STATISTICS [dbo].[Orders].[s];');
      expect(sql(buildDatabricksOptimizeSQL('main', 'sales', 'orders', ['r'])))
        .toBe('OPTIMIZE `main`.`sales`.`orders` ZORDER BY (`r`);');
      expect(sql(buildDatabricksAnalyzeSQL('main', 'sales', 'orders')))
        .toBe('ANALYZE TABLE `main`.`sales`.`orders` COMPUTE STATISTICS FOR ALL COLUMNS;');
    });
  }
});
