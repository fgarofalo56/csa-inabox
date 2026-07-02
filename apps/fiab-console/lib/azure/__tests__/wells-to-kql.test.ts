/**
 * wells-to-kql — unit spec for the staged ADX-engine wells→KQL compiler.
 *
 * WHY THIS EXISTS: `buildKqlFromVisual` is a COMPLETE, real KQL synthesizer that
 * is intentionally not yet wired into the live Get-Data pipeline (no bindable
 * `adx` LoomConnection in Wave 1 — `report-model-resolver.ts` honest-gates the
 * ADX path; see the module header). Without a consumer it would read as dead
 * code. This spec is that consumer: it exercises every visual shape (table /
 * slicer / card / grouped chart / time-series make-series / Top-N) plus the
 * shared Filters-pane model (scalar / in / between / contains / relativeDate)
 * and the injection-safety contract (identifier whitelisting + literal
 * escaping), so the compiler's SHARED-CONTRACT output is regression-guarded NOW
 * and the single additive `case 'adx':` activation can light it up later without
 * a behavioral surprise.
 *
 * Pure-function spec — no Azure SDK, no network, runs on the node env (per
 * vitest.config.ts) like the wells-to-sql / aas-dax siblings. Per no-vaporware:
 * these assertions check the REAL emitted KQL text, not a mocked stand-in.
 */
import { describe, it, expect } from 'vitest';
import { buildKqlFromVisual, kqlIdent, type KqlSource } from '../wells-to-kql';
import type { DaxVisual } from '../aas-dax';
import type { ReportFilterInput } from '../wells-to-sql';

/** A representative ADX source: a Sales table with a datetime axis. */
const SRC: KqlSource = {
  table: 'Sales',
  columns: [
    { name: 'Region', dataType: 'string' },
    { name: 'Amount', dataType: 'real' },
    { name: 'Id', dataType: 'long' },
    { name: 'OrderDate', dataType: 'datetime' },
  ],
};

const v = (type: string, wells: NonNullable<DaxVisual['wells']>): DaxVisual => ({ type, wells });

describe('buildKqlFromVisual — query shapes', () => {
  it('table visual → project + capped deterministic ordering', () => {
    const out = buildKqlFromVisual(
      v('table', { category: [{ column: 'Region' }], values: [{ column: 'Amount', aggregation: 'Sum' }] }),
      undefined,
      SRC,
    );
    expect(out).not.toBeNull();
    expect(out!.kql).toBe('Sales\n| project Region, Amount\n| top 1000 by Region asc');
  });

  it('slicer visual → distinct category values', () => {
    const out = buildKqlFromVisual(v('slicer', { category: [{ column: 'Region' }] }), undefined, SRC);
    expect(out!.kql).toBe('Sales\n| distinct Region\n| take 1000');
  });

  it('card visual → single-row summarize, no grouping, no ordering', () => {
    const out = buildKqlFromVisual(
      v('card', { values: [{ column: 'Amount', aggregation: 'Sum' }] }),
      undefined,
      SRC,
    );
    expect(out!.kql).toBe("Sales\n| summarize ['Sum of Amount'] = sum(Amount)");
  });

  it('Count aggregation → count() with no column argument', () => {
    const out = buildKqlFromVisual(
      v('card', { values: [{ column: 'Id', aggregation: 'Count' }] }),
      undefined,
      SRC,
    );
    expect(out!.kql).toBe("Sales\n| summarize ['Count of Id'] = count()");
  });

  it('grouped chart → summarize ... by <group> with default ROW_CAP ranking', () => {
    const out = buildKqlFromVisual(
      v('bar', { category: [{ column: 'Region' }], values: [{ column: 'Amount', aggregation: 'Sum' }] }),
      undefined,
      SRC,
    );
    expect(out!.kql).toBe(
      "Sales\n| summarize ['Sum of Amount'] = sum(Amount) by Region\n| top 1000 by ['Sum of Amount'] desc",
    );
  });

  it('Top-N directive → top N by the chosen by-measure (desc)', () => {
    const filters: ReportFilterInput[] = [
      { op: 'topN', topN: 5, byMeasure: 'Sum of Amount', topNType: 'top' },
    ];
    const out = buildKqlFromVisual(
      v('bar', { category: [{ column: 'Region' }], values: [{ column: 'Amount', aggregation: 'Sum' }] }),
      filters,
      SRC,
    );
    expect(out!.kql).toBe(
      "Sales\n| summarize ['Sum of Amount'] = sum(Amount) by Region\n| top 5 by ['Sum of Amount'] desc",
    );
  });

  it('bottom-N directive → ascending ranking', () => {
    const filters: ReportFilterInput[] = [
      { op: 'topN', topN: 3, byMeasure: 'Sum of Amount', topNType: 'bottom' },
    ];
    const out = buildKqlFromVisual(
      v('bar', { category: [{ column: 'Region' }], values: [{ column: 'Amount', aggregation: 'Sum' }] }),
      filters,
      SRC,
    );
    expect(out!.kql).toContain("top 3 by ['Sum of Amount'] asc");
  });

  it('line chart over a single datetime category → make-series (daily grain, default=0)', () => {
    const out = buildKqlFromVisual(
      v('line', { category: [{ column: 'OrderDate' }], values: [{ column: 'Amount', aggregation: 'Sum' }] }),
      undefined,
      SRC,
    );
    expect(out!.kql).toBe(
      "Sales\n| make-series ['Sum of Amount'] = sum(Amount) default=0 on OrderDate step 1d",
    );
  });

  it('group-only chart (no values) → distinct grouping', () => {
    const out = buildKqlFromVisual(v('bar', { category: [{ column: 'Region' }] }), undefined, SRC);
    expect(out!.kql).toBe('Sales\n| distinct Region\n| take 1000');
  });
});

describe('buildKqlFromVisual — Filters pane (shared model across SQL/DAX/KQL)', () => {
  it('scalar eq → pre-summarize where predicate', () => {
    const filters: ReportFilterInput[] = [{ op: 'eq', column: 'Region', value: 'West' }];
    const out = buildKqlFromVisual(
      v('card', { values: [{ column: 'Amount', aggregation: 'Sum' }] }),
      filters,
      SRC,
    );
    expect(out!.kql).toBe("Sales\n| where Region == 'West'\n| summarize ['Sum of Amount'] = sum(Amount)");
  });

  it('in operator → in (...) set with escaped literals', () => {
    const filters: ReportFilterInput[] = [{ op: 'in', column: 'Region', values: ['West', 'East'] }];
    const out = buildKqlFromVisual(
      v('card', { values: [{ column: 'Amount', aggregation: 'Sum' }] }),
      filters,
      SRC,
    );
    expect(out!.kql).toContain("where Region in ('West', 'East')");
  });

  it('between on a datetime column → todatetime-wrapped bounds', () => {
    const filters: ReportFilterInput[] = [
      { op: 'between', column: 'OrderDate', value: '2026-01-01', value2: '2026-12-31' },
    ];
    const out = buildKqlFromVisual(
      v('card', { values: [{ column: 'Amount', aggregation: 'Sum' }] }),
      filters,
      SRC,
    );
    expect(out!.kql).toContain(
      "where OrderDate >= todatetime('2026-01-01') and OrderDate <= todatetime('2026-12-31')",
    );
  });

  it('contains → KQL case-insensitive substring match', () => {
    const filters: ReportFilterInput[] = [{ op: 'contains', column: 'Region', value: 'est' }];
    const out = buildKqlFromVisual(
      v('card', { values: [{ column: 'Amount', aggregation: 'Sum' }] }),
      filters,
      SRC,
    );
    expect(out!.kql).toContain("where Region contains 'est'");
  });

  it('relativeDate last N days → rolling window vs now()', () => {
    const filters: ReportFilterInput[] = [
      { op: 'relativeDate', column: 'OrderDate', relN: 7, relUnit: 'days', relDir: 'last' },
    ];
    const out = buildKqlFromVisual(
      v('card', { values: [{ column: 'Amount', aggregation: 'Sum' }] }),
      filters,
      SRC,
    );
    expect(out!.kql).toContain('where OrderDate >= ago(7d) and OrderDate <= now()');
  });

  it('relativeDate next N months → datetime_add forward window', () => {
    const filters: ReportFilterInput[] = [
      { op: 'relativeDate', column: 'OrderDate', relN: 3, relUnit: 'months', relDir: 'next' },
    ];
    const out = buildKqlFromVisual(
      v('card', { values: [{ column: 'Amount', aggregation: 'Sum' }] }),
      filters,
      SRC,
    );
    expect(out!.kql).toContain("OrderDate <= datetime_add('month', 3, now())");
  });

  it('measure filter → post-summarize where (HAVING analogue)', () => {
    const filters: ReportFilterInput[] = [{ op: 'gt', measure: 'Sum of Amount', value: '100' }];
    const out = buildKqlFromVisual(
      v('bar', { category: [{ column: 'Region' }], values: [{ column: 'Amount', aggregation: 'Sum' }] }),
      filters,
      SRC,
    );
    // summarize first, then the measure where, then the ranking cap.
    expect(out!.kql).toContain("by Region\n| where ['Sum of Amount'] > 100");
  });
});

describe('buildKqlFromVisual — injection safety + null contract', () => {
  it('drops fields not on the resolver whitelist', () => {
    const out = buildKqlFromVisual(
      v('table', { category: [{ column: 'Region; DROP TABLE x' }], values: [{ column: 'NotAColumn' }] }),
      undefined,
      SRC,
    );
    // Neither bogus identifier resolves → no whitelisted columns → null.
    expect(out).toBeNull();
  });

  it('drops filter predicates whose column is not whitelisted', () => {
    const filters: ReportFilterInput[] = [{ op: 'eq', column: "x'); DROP--", value: 'boom' }];
    const out = buildKqlFromVisual(
      v('card', { values: [{ column: 'Amount', aggregation: 'Sum' }] }),
      filters,
      SRC,
    );
    expect(out!.kql).toBe("Sales\n| summarize ['Sum of Amount'] = sum(Amount)");
    expect(out!.kql).not.toContain('DROP');
  });

  it('escapes single quotes inside literal values', () => {
    const filters: ReportFilterInput[] = [{ op: 'eq', column: 'Region', value: "O'Brien" }];
    const out = buildKqlFromVisual(
      v('card', { values: [{ column: 'Amount', aggregation: 'Sum' }] }),
      filters,
      SRC,
    );
    expect(out!.kql).toContain("Region == 'O\\'Brien'");
  });

  it('returns null when a visual has no usable wells', () => {
    expect(buildKqlFromVisual(v('bar', {}), undefined, SRC)).toBeNull();
    expect(buildKqlFromVisual(v('card', { values: [{ measure: 'PhantomMeasure' }] }), undefined, SRC)).toBeNull();
  });
});

describe('kqlIdent — identifier quoting', () => {
  it('emits a simple name bare', () => {
    expect(kqlIdent('Region')).toBe('Region');
    expect(kqlIdent('_col0')).toBe('_col0');
  });

  it('bracket-quotes names with spaces/punctuation', () => {
    expect(kqlIdent('Sum of Amount')).toBe("['Sum of Amount']");
  });

  it('escapes backslash and quote inside a bracketed identifier', () => {
    expect(kqlIdent("we'ird")).toBe("['we\\'ird']");
    expect(kqlIdent('back\\slash')).toBe("['back\\\\slash']");
  });
});
