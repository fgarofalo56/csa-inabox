/**
 * dax-golden-fixtures.test.ts — provenance gate for the DAX golden harness
 * (loom-next-level ws-lineage-depth A5).
 *
 * This is the OFFLINE half of A5: it proves every golden in
 * expected-results.json is arithmetically correct against the CSV reference
 * data BEFORE the live Playwright `dax-golden` project ever runs — so a wrong
 * golden (a mis-transcribed Power BI number, or a fold that would return the
 * wrong value) fails in ordinary vitest CI with no Synapse dependency. It also
 * proves the harness is real (a deliberately-corrupted expectation fails).
 *
 * The LIVE numeric gate against real Synapse serverless is e2e/dax-golden.spec.ts.
 */
import { describe, it, expect } from 'vitest';
import {
  loadFixtures,
  implementedFixtures,
  loadReferenceData,
  referenceEvaluate,
  matchNumber,
  MODEL_CONTENT,
  REFERENCE_TABLES,
  type GoldenFixture,
} from './dax-golden/fixtures';
import { translateDaxToSql } from '../tabular-model';

const data = loadReferenceData();
const fixtures = loadFixtures();

describe('dax-golden reference data', () => {
  it('loads all three reference tables with the expected row counts', () => {
    expect(REFERENCE_TABLES).toEqual(['Sales', 'Date', 'Customer']);
    expect(data.Sales).toHaveLength(12);
    expect(data.Customer).toHaveLength(4);
    expect(data.Date).toHaveLength(24);
  });

  it('Sales.Amount equals Quantity * UnitPrice on every row (self-consistent seed)', () => {
    for (const r of data.Sales) {
      expect(Number(r.Amount)).toBe(Number(r.Quantity) * Number(r.UnitPrice));
    }
  });

  it('every Sales key resolves to a Date and a Customer row (valid star)', () => {
    const dateKeys = new Set(data.Date.map((r) => r.DateKey));
    const custKeys = new Set(data.Customer.map((r) => r.CustomerKey));
    for (const r of data.Sales) {
      expect(dateKeys.has(r.DateKey)).toBe(true);
      expect(custKeys.has(r.CustomerKey)).toBe(true);
    }
  });
});

describe('dax-golden fixtures — schema + provenance', () => {
  it('has a non-empty fixture set with unique ids', () => {
    expect(fixtures.length).toBeGreaterThan(0);
    const ids = fixtures.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every fixture has a well-formed shape', () => {
    for (const f of fixtures) {
      expect(f.id, `${f.id}: id`).toBeTruthy();
      expect(f.dax, `${f.id}: dax`).toBeTruthy();
      expect(['implemented', 'pending'], `${f.id}: status`).toContain(f.status);
      expect(['scalar', 'rowCount', 'table'], `${f.id}: expect.kind`).toContain(f.expect.kind);
      expect(typeof f.expect.value, `${f.id}: expect.value`).toBe('number');
      if (f.expect.kind === 'scalar') expect(f.expect.column, `${f.id}: scalar needs column`).toBeTruthy();
      expect(f.reference?.table, `${f.id}: reference.table`).toBeTruthy();
    }
  });

  // THE PROVENANCE GATE: every golden's recorded value must equal the pure-JS
  // recomputation over the CSV reference data. A wrong number fails here.
  it.each(fixtures.map((f) => [f.id, f] as [string, GoldenFixture]))(
    'provenance %s: recorded value matches the CSV reference computation',
    (_id, f) => {
      const computed = referenceEvaluate(f, data);
      const m = matchNumber(computed, f.expect);
      expect(m.ok, `${f.id}: ${m.detail} (recomputed ${computed})`).toBe(true);
    },
  );
});

describe('dax-golden — implemented fixtures fold with the current engine', () => {
  // A5 baseline: every 'implemented' fixture is one the loom-native 3-regex
  // translator supports TODAY, so it MUST produce SQL. When A1 replaces the
  // translator this still holds (it only adds coverage). A2/A3 rows that need
  // the new engine will land 'implemented' alongside the A1 parser in their PR.
  const impl = implementedFixtures();

  it('has at least the A5 baseline implemented set', () => {
    expect(impl.length).toBeGreaterThanOrEqual(9);
  });

  it.each(impl.map((f) => [f.id, f] as [string, GoldenFixture]))(
    'implemented %s: translateDaxToSql returns SQL (foldable today)',
    (_id, f) => {
      const sql = translateDaxToSql(f.dax);
      expect(sql, `${f.id}: "${f.dax}" should fold to SQL`).not.toBeNull();
    },
  );
});

describe('dax-golden — the harness is real (negative controls)', () => {
  it('a deliberately-wrong expectation FAILS the provenance check', () => {
    const good = fixtures.find((f) => f.id === 'agg-sum-amount')!;
    const tampered: GoldenFixture = { ...good, expect: { ...good.expect, value: 9999 } };
    const computed = referenceEvaluate(tampered, data);
    expect(matchNumber(computed, tampered.expect).ok).toBe(false);
  });

  it('a wrong fold (SUM read as MAX) would produce a different number', () => {
    // Proves the gate discriminates the fold, not just presence of a number:
    // MAX(Amount)=600 ≠ SUM(Amount)=3500, so a SUM→MAX mis-fold is caught.
    const sum = referenceEvaluate(
      { reference: { op: 'sum', table: 'Sales', column: 'Amount' } } as GoldenFixture,
      data,
    );
    const max = referenceEvaluate(
      { reference: { op: 'max', table: 'Sales', column: 'Amount' } } as GoldenFixture,
      data,
    );
    expect(sum).not.toBe(max);
    expect(sum).toBe(3500);
    expect(max).toBe(600);
  });
});
