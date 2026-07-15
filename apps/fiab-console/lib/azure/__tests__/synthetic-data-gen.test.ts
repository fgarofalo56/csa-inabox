import { describe, it, expect } from 'vitest';
import {
  generateRows, rowsToCsv, inferStrategy, GEN_STRATEGIES,
  type ColumnGenSpec,
} from '../synthetic-data-gen';

const specs: ColumnGenSpec[] = [
  { name: 'id', strategy: 'sequence', options: { startAt: 1 } },
  { name: 'name', strategy: 'full_name', pii: true },
  { name: 'email', strategy: 'email', pii: true },
  { name: 'amount', strategy: 'decimal', options: { min: 0, max: 100, precision: 2 } },
  { name: 'tier', strategy: 'categorical', options: { values: ['gold', 'silver'] } },
  { name: 'active', strategy: 'boolean' },
  { name: 'created', strategy: 'date', options: { start: '2024-01-01', end: '2024-12-31' } },
];

describe('synthetic-data-gen', () => {
  it('generates exactly N rows with every column present', () => {
    const rows = generateRows(specs, 100, 7);
    expect(rows).toHaveLength(100);
    for (const r of rows) {
      expect(Object.keys(r).sort()).toEqual(specs.map((s) => s.name).sort());
    }
  });

  it('sequence increments, decimal respects range + precision, categorical stays in the value set', () => {
    const rows = generateRows(specs, 50, 3);
    expect(rows[0].id).toBe(1);
    expect(rows[49].id).toBe(50);
    for (const r of rows) {
      const a = r.amount as number;
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThanOrEqual(100);
      expect(Number(a.toFixed(2))).toBe(a); // no more than 2 decimal places
      expect(['gold', 'silver']).toContain(r.tier);
      expect(typeof r.active).toBe('boolean');
      expect(String(r.created)).toMatch(/^2024-\d{2}-\d{2}$/);
    }
  });

  it('is deterministic for a fixed seed (preview == run head)', () => {
    const a = generateRows(specs, 10, 42);
    const b = generateRows(specs, 10, 42);
    expect(a).toEqual(b);
    const c = generateRows(specs, 10, 43);
    expect(c).not.toEqual(a);
  });

  it('PII columns synthesize fake values — never real PII (emails are @example.com, names from the curated list)', () => {
    const rows = generateRows(specs, 30, 11);
    for (const r of rows) {
      expect(String(r.email)).toMatch(/@example\.com$/);
      expect(String(r.name).split(' ')).toHaveLength(2);
    }
  });

  it('injects nulls at the configured rate', () => {
    const withNulls: ColumnGenSpec[] = [{ name: 'x', strategy: 'integer', options: { min: 1, max: 9, nullRate: 1 } }];
    const rows = generateRows(withNulls, 20, 1);
    expect(rows.every((r) => r.x === null)).toBe(true);
  });

  it('serializes to CSV with a header and escapes commas/quotes', () => {
    const csvSpecs: ColumnGenSpec[] = [{ name: 'note', strategy: 'constant', options: { constant: 'a,b "c"' } }];
    const csv = rowsToCsv(generateRows(csvSpecs, 2, 1), csvSpecs);
    const lines = csv.split('\n');
    expect(lines[0]).toBe('note');
    expect(lines[1]).toBe('"a,b ""c"""');
  });

  it('inferStrategy maps a PII-classified column to a synthetic strategy (no real data path)', () => {
    const email = inferStrategy({ name: 'email_addr', type: 'string', classification: 'PII' });
    expect(email.strategy).toBe('email');
    expect(email.pii).toBe(true);
    const ssn = inferStrategy({ name: 'ssn', type: 'string', classification: 'PII' });
    expect(ssn.pii).toBe(true);
    // No name heuristic → redacted mask (still never real).
    expect(ssn.strategy).toBe('redacted');
    // Non-PII id column → sequence.
    expect(inferStrategy({ name: 'order_id', type: 'bigint' }).strategy).toBe('sequence');
  });

  it('every strategy in GEN_STRATEGIES produces a value without throwing', () => {
    for (const meta of GEN_STRATEGIES) {
      const spec: ColumnGenSpec = { name: 'c', strategy: meta.value, options: { values: ['x'], constant: 'k', min: 0, max: 5 } };
      const rows = generateRows([spec], 3, 5);
      expect(rows).toHaveLength(3);
    }
  });
});
