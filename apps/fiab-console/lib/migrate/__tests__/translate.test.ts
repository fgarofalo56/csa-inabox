/**
 * M3 — code-translation unit tests (pure).
 *
 * Pins the DIE-HARD honesty contract: a supported construct yields a real
 * mechanical translation; an unsupported construct is flagged needs-review WITH
 * the exact reason and NO fabricated output; the DAX path reuses the A1 parser +
 * A2/A3 fold (never re-implements DAX); the report path reuses the N16 parser.
 */
import { describe, it, expect } from 'vitest';
import { transpileSql } from '@/lib/migrate/sql-transpile';
import { translateDaxMeasure, translateReport, buildCodeReportSource } from '@/lib/migrate/artifact-transpile';
import { translateArtifact, translateBatch } from '@/lib/migrate/translate';

describe('transpileSql — Snowflake → Loom SQL', () => {
  it('translates a simple view: NVL→ISNULL + requoted identifiers', () => {
    const r = transpileSql(
      `CREATE OR REPLACE VIEW active AS SELECT "Id", NVL(name, 'n/a') AS name FROM customers WHERE active = TRUE`,
      'snowflake',
    );
    expect(r.supported).toBe(true);
    expect(r.needsReviewCount).toBe(0);
    expect(r.loomSql).toContain('ISNULL(');
    expect(r.loomSql).toContain('[Id]');
    expect(r.loomSql).toContain('CREATE OR ALTER VIEW');
    expect(r.loomSql).not.toContain('NVL(');
    // string literal is preserved verbatim (masking works)
    expect(r.loomSql).toContain("'n/a'");
  });

  it('does NOT fire renames on tokens inside a string literal', () => {
    const r = transpileSql(`SELECT 'NVL is a function' AS note FROM t`, 'snowflake');
    expect(r.supported).toBe(true);
    expect(r.loomSql).toContain("'NVL is a function'");
  });

  it('flags QUALIFY as needs-review with the exact reason and NO output', () => {
    const r = transpileSql(
      `SELECT id, ROW_NUMBER() OVER (PARTITION BY k ORDER BY t) rn FROM t QUALIFY rn = 1`,
      'snowflake',
    );
    expect(r.supported).toBe(false);
    expect(r.loomSql).toBeNull();
    const flag = r.statements[0].flags.find((f) => !f.supported);
    expect(flag?.construct).toBe('QUALIFY');
    expect(flag?.reason).toMatch(/no T-SQL equivalent/i);
    // source preserved verbatim — never fabricated
    expect(r.statements[0].source).toContain('QUALIFY');
    expect(r.statements[0].loomSql).toBeNull();
  });

  it('flags LATERAL FLATTEN and :: cast as needs-review', () => {
    const r = transpileSql(`SELECT f.value::string AS v FROM t, LATERAL FLATTEN(input => t.arr) f`, 'snowflake');
    expect(r.supported).toBe(false);
    const constructs = r.statements[0].flags.filter((f) => !f.supported).map((f) => f.construct);
    expect(constructs).toContain('LATERAL FLATTEN');
    expect(constructs).toContain(':: cast');
  });

  it('flags a CREATE PROCEDURE (stored routine) as needs-review, mirroring M1', () => {
    const r = transpileSql(`CREATE OR REPLACE PROCEDURE p() RETURNS INT AS $$ BEGIN RETURN 1; END $$`, 'snowflake');
    expect(r.supported).toBe(false);
    expect(r.statements[0].flags[0].reason).toMatch(/stored procedure|user-data-function/i);
  });
});

describe('transpileSql — T-SQL → Loom SQL', () => {
  it('passes a compatible SELECT through verbatim', () => {
    const r = transpileSql(`SELECT TOP 10 id FROM dbo.orders WHERE amount > 0`, 'tsql');
    expect(r.supported).toBe(true);
    expect(r.loomSql).toContain('SELECT TOP 10 id');
  });

  it('flags a #temp table as needs-review on Synapse-serverless', () => {
    const r = transpileSql(`SELECT id INTO #tmp FROM orders`, 'tsql');
    expect(r.supported).toBe(false);
    const constructs = r.statements[0].flags.filter((f) => !f.supported).map((f) => f.construct);
    expect(constructs).toContain('temp table');
  });
});

describe('translateDaxMeasure — reuses A1 parser + A2/A3 fold', () => {
  it('folds a simple aggregate measure to loom-native SQL (supported)', () => {
    const t = translateDaxMeasure('Total Amount', 'Sales', 'CALCULATE(SUM(Sales[Amount]))');
    expect(t.parses).toBe(true);
    expect(t.supported).toBe(true);
    expect(t.loomNativeSql).toBeTruthy();
    expect(t.loomNativeSql).toMatch(/SUM\(\[Amount\]\)/i);
    // carried over verbatim as an N9 measure metric (sourceRef = original DAX)
    expect(t.metricDraft?.sourceKind).toBe('measure');
    expect(t.metricDraft?.sourceRef).toBe('CALCULATE(SUM(Sales[Amount]))');
  });

  it('flags an UNPARSEABLE measure needs-review with the parser error and NO metric', () => {
    const t = translateDaxMeasure('Broken', 'Sales', 'SUM(');
    expect(t.parses).toBe(false);
    expect(t.supported).toBe(false);
    expect(t.loomNativeSql).toBeNull();
    expect(t.metricDraft).toBeUndefined();
    expect(t.reason).toMatch(/does not parse/i);
  });

  it('parses but does not fold → needs-review, but still a faithful measure carry-over', () => {
    const t = translateDaxMeasure('Pathy', 'Sales', 'PATH(Sales[a], Sales[b])');
    expect(t.parses).toBe(true);
    expect(t.supported).toBe(false);          // outside the SQL-fold surface
    expect(t.loomNativeSql).toBeNull();        // never fabricated
    expect(t.metricDraft).toBeDefined();       // faithful verbatim carry-over
    expect(t.reason).toMatch(/outside the loom-native SQL-fold surface/i);
  });
});

describe('translateReport — reuses the N16 code-report parser', () => {
  const good = {
    name: 'Sales overview',
    narrative: 'Monthly sales by region.',
    engine: 'synapse' as const,
    queries: [{ name: 'by_region', sql: 'SELECT region, SUM(amount) AS total FROM sales GROUP BY region' }],
    visuals: [{ type: 'bar' as const, query: 'by_region', x: 'region', y: 'total', title: 'By region' }],
  };

  it('assembles + validates a report to a code-report (supported)', () => {
    const t = translateReport(good);
    expect(t.supported).toBe(true);
    expect(t.stats).toEqual({ queries: 1, visuals: 1 });
    expect(t.source).toContain('```sql by_region');
    expect(t.source).toContain('{bar query=by_region');
  });

  it('flags a visual referencing an undefined query as needs-review (N16 error surfaced)', () => {
    const t = translateReport({ ...good, visuals: [{ type: 'bar', query: 'missing', x: 'a', y: 'b' }] });
    expect(t.supported).toBe(false);
    expect(t.reason).toMatch(/N16 validation|undefined query/i);
  });

  it('flags a mutating dataset query via the N16 read-only guard', () => {
    const t = translateReport({ ...good, queries: [{ name: 'bad', sql: 'DELETE FROM sales' }], visuals: [] });
    expect(t.supported).toBe(false);
    expect(t.reason).toMatch(/read-only|single statement/i);
  });

  it('buildCodeReportSource quotes attribute values containing whitespace', () => {
    const src = buildCodeReportSource(good);
    expect(src).toContain('title="By region"');
  });
});

describe('translateArtifact / translateBatch — orchestration', () => {
  it('produces a draft warehouse item for a supported SQL view', () => {
    const a = translateArtifact({ kind: 'sql-view', name: 'vw', dialect: 'snowflake', sql: 'SELECT "Id" FROM t' });
    expect(a.status).toBe('supported');
    expect(a.draftItem?.itemType).toBe('warehouse');
    expect((a.draftItem?.state as any)?.migration?.draft).toBe(true);
  });

  it('produces a draft semantic-model + metricDraft for a parseable DAX measure', () => {
    const a = translateArtifact({ kind: 'dax-measure', name: 'Total', table: 'Sales', dax: 'SUM(Sales[Amount])' });
    expect(a.draftItem?.itemType).toBe('semantic-model');
    expect(a.metricDraft).toBeDefined();
  });

  it('rolls up totals across a batch and never fabricates a needs-review artifact', () => {
    const res = translateBatch([
      { kind: 'sql-view', name: 'ok', dialect: 'tsql', sql: 'SELECT 1 AS x' },
      { kind: 'sql-view', name: 'bad', dialect: 'snowflake', sql: 'SELECT x FROM t QUALIFY 1=1' },
    ]);
    expect(res.totals.total).toBe(2);
    expect(res.totals.supported).toBe(1);
    expect(res.totals.needsReview).toBe(1);
    const bad = res.artifacts.find((a) => a.name === 'bad')!;
    expect(bad.generated).toBeNull();
  });
});
