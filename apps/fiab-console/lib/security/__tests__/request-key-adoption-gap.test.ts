/**
 * The guard-adoption gap in the request-key class — the sites CodeQL did NOT
 * report (refs the four alerts triaged with #2672).
 *
 * `lib/security/__tests__/request-key-sinks.test.ts` already proves the general
 * point: `/^[A-Za-z_][\w]{0,62}$/` reads as a strict identifier check and
 * ACCEPTS `__proto__`, `constructor`, `prototype`, `toString`, `valueOf` and
 * `hasOwnProperty`, because `_` is `\w`. That reasoning was written down when
 * the ontology objects/links routes were moved onto `safeRecord()` in #2657.
 *
 * Three siblings behind the SAME filter never adopted it, and CodeQL reported
 * none of them:
 *
 *   object-dataset-sync.resultToObjects  — keys are SOURCE COLUMN NAMES
 *   object-dataset-sync (AGE upsert)     — keys are `datasource.columnMap` values
 *   object-dataset-sync (AI Search doc)  — same
 *
 * …plus a fourth, in a different shape: `report/[id]/refresh` carried a THIRD
 * copy of `parseTableStorage`. Its two siblings — the data-source route (the
 * write side) and report-model-resolver's `parseTableStorageState` — were both
 * moved to `safeRecord()`; this one was missed, so the map written safely by one
 * route was read back into a prototype-bearing object by another.
 *
 * These tests reproduce the shape rather than importing the functions (they are
 * module-private and sit behind Azure clients). Each pairs the OLD shape with
 * the NEW one, so the difference is the assertion.
 */
import { describe, it, expect } from 'vitest';
import { safeRecord } from '@/lib/security/safe-object';

const COLUMN_FILTER = /^[A-Za-z_][\w]{0,62}$/;

/** `resultToObjects` / the props loops, as they were. */
function plainProps(entries: Array<[string, unknown]>): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  for (const [col, val] of entries) if (COLUMN_FILTER.test(col)) props[col] = val;
  return props;
}

/** …and as they are now. */
function safeProps(entries: Array<[string, unknown]>): Record<string, unknown> {
  const props = safeRecord<unknown>();
  for (const [col, val] of entries) if (COLUMN_FILTER.test(col)) props[col] = val;
  return props;
}

describe('object-dataset-sync — column names are keys', () => {
  it('the filter lets every prototype-slot name through (this is why the record must be safe)', () => {
    for (const col of ['__proto__', 'constructor', 'prototype', 'toString', 'valueOf']) {
      expect(COLUMN_FILTER.test(col)).toBe(true);
    }
  });

  it('OLD: a `__proto__` column swapped the row object\'s prototype and vanished from the row', () => {
    const row = plainProps([['__proto__', { injected: true }], ['ok', 1]]);
    expect(Object.keys(row)).toEqual(['ok']);
    expect(JSON.parse(JSON.stringify(row))).toEqual({ ok: 1 });
    expect((row as Record<string, unknown>).injected).toBe(true);
    expect(Object.getPrototypeOf(row)).not.toBe(Object.prototype);
  });

  it('OLD: a `toString` column made the row unprintable — a 500 for any consumer that stringifies it', () => {
    const row = plainProps([['toString', 'a value']]);
    expect(() => String(row)).toThrow(TypeError);
  });

  it('NEW: every column round-trips as plain data, including the reserved names', () => {
    const row = safeProps([['__proto__', { injected: true }], ['toString', 'a value'], ['ok', 1]]);
    expect(Object.keys(row).sort()).toEqual(['__proto__', 'ok', 'toString']);
    expect((row as Record<string, unknown>).injected).toBeUndefined();
    expect(String(row.toString)).toBe('a value');
  });

  it('NEW: serialises exactly like the object literal did — the persisted shape is unchanged', () => {
    const entries: Array<[string, unknown]> = [['id', 7], ['name', 'x']];
    expect(JSON.stringify(safeProps(entries))).toBe(JSON.stringify(plainProps(entries)));
  });

  // CONTROL — a column the filter should still reject, and one it should keep.
  it('CONTROL: the filter still drops a column with a space and still keeps a normal one', () => {
    const row = safeProps([['bad name', 1], ['good_name', 2]]);
    expect(Object.keys(row)).toEqual(['good_name']);
  });
});

/** `parseTableStorage`, as the refresh route had it. */
function plainTableStorage(value: unknown): Record<string, { mode: string }> {
  const out: Record<string, { mode: string }> = {};
  for (const [table, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') continue;
    const mode = (raw as Record<string, unknown>).mode;
    if (typeof mode === 'string') out[table] = { mode };
  }
  return out;
}

/** …and as it is now. */
function safeTableStorage(value: unknown): Record<string, { mode: string }> {
  const out = safeRecord<{ mode: string }>();
  for (const [table, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') continue;
    const mode = (raw as Record<string, unknown>).mode;
    if (typeof mode === 'string') out[table] = { mode };
  }
  return out;
}

describe('report refresh — the third copy of parseTableStorage', () => {
  // JSON.parse, not an object literal: this is how a persisted Cosmos document
  // arrives, and it is the only one of the two that yields a real OWN
  // `__proto__` key for Object.entries to hand back.
  const PERSISTED = () => JSON.parse('{"__proto__":{"mode":"Import"},"Sales":{"mode":"Dual"}}');

  it('OLD: a persisted `__proto__` table replaced the map\'s prototype', () => {
    const out = plainTableStorage(PERSISTED());
    expect(Object.keys(out)).toEqual(['Sales']);
    expect(Object.getPrototypeOf(out)).not.toBe(Object.prototype);
    // The decision table now answers a question nobody asked it.
    expect((out as unknown as { mode?: string }).mode).toBe('Import');
  });

  it('NEW: the same document is data, and an unknown table is still undefined', () => {
    const out = safeTableStorage(PERSISTED());
    expect(Object.keys(out).sort()).toEqual(['Sales', '__proto__']);
    expect((out as unknown as { mode?: string }).mode).toBeUndefined();
    expect(out['NotATable']).toBeUndefined();
  });

  // CONTROL — the ordinary path must behave identically before and after.
  it('CONTROL: an ordinary document parses the same either way', () => {
    const doc = { Sales: { mode: 'Dual' }, Inventory: { mode: 'Import' } };
    expect({ ...safeTableStorage(doc) }).toEqual({ ...plainTableStorage(doc) });
    expect(safeTableStorage(doc)['Sales']).toEqual({ mode: 'Dual' });
  });
});
