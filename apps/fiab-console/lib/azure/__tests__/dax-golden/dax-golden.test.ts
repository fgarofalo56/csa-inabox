/**
 * dax-golden.test.ts — the OFFLINE gate for the DAX golden harness (A5).
 *
 * This runs in ordinary vitest (no backend). It does three things:
 *   1. Loads + structurally validates the fixture suite (schema errors fail here,
 *      not later in a live run).
 *   2. Cross-checks EVERY non-`manual` golden by independently recomputing it
 *      from the seeded CSVs — proving the expected numbers are real, not typos,
 *      the moment they land (this locks A2/A3's pending numbers in NOW).
 *   3. Proves the cross-check actually bites: a deliberately corrupted golden
 *      must fail it (guards against a no-op checker — the A5 acceptance
 *      "a deliberate wrong-fold fails the suite").
 *
 * The LIVE numeric gate (implemented functions against real Synapse serverless)
 * lives in e2e/dax-golden.spec.ts under the reserved `dax-golden` Playwright
 * project — this file is its offline counterpart.
 */
import { describe, it, expect } from 'vitest';
import {
  loadGoldenSuite,
  loadCsv,
  computeReference,
  crossCheckAgainstCsv,
  assertLiveResult,
  type GoldenCase,
} from './fixtures';

const suite = loadGoldenSuite();

describe('dax-golden fixtures', () => {
  it('loads a non-empty, well-formed suite', () => {
    expect(suite.cases.length).toBeGreaterThan(0);
    expect(suite.defaultTolerance).toBeGreaterThan(0);
  });

  it('ships at least the A5 currently-implemented functions', () => {
    const implementedFns = new Set(suite.cases.filter((c) => c.implemented).map((c) => c.fn));
    // The 3-regex translator that A5 gates today: table EVALUATE, TOPN, and
    // ROW(CALCULATE(AGG)) for SUM/COUNT/AVERAGE/MIN/MAX.
    for (const fn of ['EVALUATE <Table>', 'TOPN', 'SUM', 'COUNT', 'AVERAGE', 'MIN', 'MAX']) {
      expect(implementedFns, `expected an implemented golden for ${fn}`).toContain(fn);
    }
  });

  it('every case has provenance and a unique id', () => {
    const ids = new Set<string>();
    for (const c of suite.cases) {
      expect(c.provenance.length, `${c.id} provenance`).toBeGreaterThan(7);
      expect(ids.has(c.id), `duplicate ${c.id}`).toBe(false);
      ids.add(c.id);
    }
  });

  it('the seeded CSVs load and have the expected star-schema shape', () => {
    const sales = loadCsv('sales');
    const date = loadCsv('date');
    const customer = loadCsv('customer');
    expect(sales.length).toBe(12);
    expect(customer.length).toBe(4);
    expect(date.length).toBe(24);
    expect(Object.keys(sales[0]).sort()).toEqual(['Amount', 'CustomerId', 'Date', 'Quantity']);
    expect(Object.keys(customer[0]).sort()).toEqual(['CustomerId', 'Name', 'Region', 'Segment']);
  });
});

describe('dax-golden CSV cross-check (goldens are real, not typos)', () => {
  const recomputable = suite.cases.filter((c) => c.reference.kind !== 'manual');

  it('has recomputable references for the numeric core', () => {
    expect(recomputable.length).toBeGreaterThanOrEqual(8);
  });

  for (const c of recomputable) {
    it(`${c.id} (${c.fn}${c.implemented ? '' : ', pending'}) golden matches an independent CSV recompute`, () => {
      const mismatch = crossCheckAgainstCsv(c, c.tolerance ?? suite.defaultTolerance);
      expect(mismatch, mismatch ?? 'ok').toBeNull();
    });
  }
});

describe('dax-golden manual references', () => {
  const manual = suite.cases.filter((c) => c.reference.kind === 'manual');
  for (const c of manual) {
    it(`${c.id} names an external reference source in provenance`, () => {
      expect(c.provenance).toMatch(/power bi|manual|captured|reference/i);
    });
  }
});

describe('dax-golden cross-check actually bites (negative control)', () => {
  it('a corrupted scalar golden is rejected by the CSV cross-check', () => {
    const good = suite.cases.find(
      (c) => c.expect.kind === 'scalar' && c.reference.kind !== 'manual',
    )!;
    const corrupted: GoldenCase = {
      ...good,
      expect: { kind: 'scalar', column: (good.expect as any).column, value: (good.expect as any).value + 1 },
    };
    expect(crossCheckAgainstCsv(corrupted, good.tolerance ?? suite.defaultTolerance)).not.toBeNull();
  });

  it('a corrupted group golden is rejected', () => {
    const grouped = suite.cases.find((c) => c.expect.kind === 'groupRows' && c.reference.kind !== 'manual');
    if (!grouped) return; // no grouped recomputable case shipped yet
    const rows = (grouped.expect as any).rows.map((r: any, i: number) => (i === 0 ? { ...r, value: r.value + 100 } : r));
    const corrupted: GoldenCase = { ...grouped, expect: { ...(grouped.expect as any), rows } };
    expect(crossCheckAgainstCsv(corrupted, grouped.tolerance ?? suite.defaultTolerance)).not.toBeNull();
  });

  it('computeReference refuses to recompute a manual reference', () => {
    expect(() => computeReference({ kind: 'manual' })).toThrow();
  });
});

describe('assertLiveResult (the live-harness comparator)', () => {
  it('accepts a correct scalar backend result and rejects a wrong one', () => {
    const c = suite.cases.find((x) => x.id === 'a5-sum-amount')!;
    const good = assertLiveResult(c, { columns: ['TotalAmount'], rows: [{ TotalAmount: 2940 }] }, suite.defaultTolerance);
    expect(good.ok).toBe(true);
    const bad = assertLiveResult(c, { columns: ['TotalAmount'], rows: [{ TotalAmount: 2939 }] }, suite.defaultTolerance);
    expect(bad.ok).toBe(false);
  });

  it('tolerates bracketed / differently-cased result column names', () => {
    const c = suite.cases.find((x) => x.id === 'a5-average-amount')!;
    expect(assertLiveResult(c, { rows: [{ '[AvgAmount]': 245 }] }, suite.defaultTolerance).ok).toBe(true);
    expect(assertLiveResult(c, { rows: [{ avgamount: 245 }] }, suite.defaultTolerance).ok).toBe(true);
  });

  it('asserts rowCount cases by returned-row count', () => {
    const c = suite.cases.find((x) => x.id === 'a5-eval-topn-5')!;
    expect(assertLiveResult(c, { rows: new Array(5).fill({ Amount: 1 }) }, suite.defaultTolerance).ok).toBe(true);
    expect(assertLiveResult(c, { rows: new Array(4).fill({ Amount: 1 }) }, suite.defaultTolerance).ok).toBe(false);
  });
});
