/**
 * WS-2.2 — unit tests for the PURE incremental Delta→vector sync logic
 * (vector-delta-sync.ts): the row diff, content hashing, SQL shaping, and column
 * safety. These are the correctness core — the diff must upsert exactly the
 * new/changed rows, delete removed rows, and skip unchanged rows so an
 * incremental sync converges to the same index a full rebuild produces.
 */
import { describe, it, expect } from 'vitest';
import {
  diffRows, hashRowContent, rowContent, isSafeColumn, buildDeltaSelectSql,
  type RowHashMap,
} from '../vector-delta-sync';

describe('hashRowContent / rowContent', () => {
  it('hashes deterministically and changes with content', () => {
    expect(hashRowContent('abc')).toBe(hashRowContent('abc'));
    expect(hashRowContent('abc')).not.toBe(hashRowContent('abd'));
    expect(hashRowContent('abc')).toHaveLength(32);
  });
  it('concatenates chosen columns with null-safe stringification', () => {
    const row = { id: 1, title: 'Widget', desc: null, extra: 42 };
    expect(rowContent(row, ['title', 'desc', 'extra'])).toBe('Widget\n\n42');
  });
  it('produces a stable hash for stable content', () => {
    const a = rowContent({ id: 'k', c: 'v' }, ['c']);
    const b = rowContent({ id: 'k', c: 'v' }, ['c']);
    expect(hashRowContent(a)).toBe(hashRowContent(b));
  });
});

describe('diffRows', () => {
  it('classifies new, changed, unchanged, and removed rows', () => {
    const prev: RowHashMap = { a: 'h1', b: 'h2', c: 'h3' };
    const next: RowHashMap = { a: 'h1', b: 'h2-CHANGED', d: 'h4' };
    const diff = diffRows(prev, next);
    // a unchanged; b changed; c removed; d new
    expect(diff.changedKeys.sort()).toEqual(['b', 'd']);
    expect(diff.removedKeys).toEqual(['c']);
    expect(diff.unchanged).toBe(1);
  });

  it('first sync (empty prev) treats every row as changed, nothing removed', () => {
    const diff = diffRows({}, { a: 'h1', b: 'h2' });
    expect(diff.changedKeys.sort()).toEqual(['a', 'b']);
    expect(diff.removedKeys).toEqual([]);
    expect(diff.unchanged).toBe(0);
  });

  it('empty source removes every previously-indexed row', () => {
    const diff = diffRows({ a: 'h1', b: 'h2' }, {});
    expect(diff.changedKeys).toEqual([]);
    expect(diff.removedKeys.sort()).toEqual(['a', 'b']);
  });

  it('identical maps are a full no-op (all skipped)', () => {
    const map: RowHashMap = { a: 'h1', b: 'h2' };
    const diff = diffRows(map, { ...map });
    expect(diff.changedKeys).toEqual([]);
    expect(diff.removedKeys).toEqual([]);
    expect(diff.unchanged).toBe(2);
  });

  it('converges to a full rebuild: applying the diff to prev yields next', () => {
    // Simulate the index-state map: start = prev, apply upserts + deletes = next.
    const prev: RowHashMap = { a: 'h1', b: 'h2', c: 'h3' };
    const next: RowHashMap = { a: 'h1', b: 'hX', d: 'h4' };
    const diff = diffRows(prev, next);
    const applied: RowHashMap = { ...prev };
    for (const k of diff.changedKeys) applied[k] = next[k];
    for (const k of diff.removedKeys) delete applied[k];
    expect(applied).toEqual(next);
  });
});

describe('isSafeColumn', () => {
  it('accepts ordinary identifiers', () => {
    expect(isSafeColumn('id')).toBe(true);
    expect(isSafeColumn('customer_name')).toBe(true);
    expect(isSafeColumn('schema.table')).toBe(true);
    expect(isSafeColumn('col-1')).toBe(true);
  });
  it('rejects injection-y identifiers', () => {
    expect(isSafeColumn("id]; DROP TABLE x --")).toBe(false);
    expect(isSafeColumn("a'b")).toBe(false);
    expect(isSafeColumn('')).toBe(false);
  });
});

describe('buildDeltaSelectSql', () => {
  const url = 'https://acct.dfs.core.windows.net/gold/Tables/products';
  it('selects key + content columns, bracket-quoted, over OPENROWSET DELTA', () => {
    const sql = buildDeltaSelectSql(url, 'id', ['title', 'description'], 100);
    expect(sql).toContain("FORMAT = 'DELTA'");
    expect(sql).toContain('r.[id]');
    expect(sql).toContain('r.[title]');
    expect(sql).toContain('r.[description]');
    expect(sql).toContain('SELECT TOP 100');
    expect(sql).toContain(`BULK '${url}'`);
  });
  it('de-dupes when the key is also a content column', () => {
    const sql = buildDeltaSelectSql(url, 'id', ['id', 'title'], 10);
    expect(sql.match(/r\.\[id\]/g)).toHaveLength(1);
  });
  it('clamps maxRows to 1..50000', () => {
    expect(buildDeltaSelectSql(url, 'id', ['t'], 0)).toContain('SELECT TOP 1');
    expect(buildDeltaSelectSql(url, 'id', ['t'], 999999)).toContain('SELECT TOP 50000');
  });
  it('throws on an unsafe column name', () => {
    expect(() => buildDeltaSelectSql(url, 'id]; DROP', ['t'], 10)).toThrow(/Unsafe column/);
  });
  it('doubles single quotes in the BULK url (injection-safe)', () => {
    const sql = buildDeltaSelectSql("https://a/b'c", 'id', ['t'], 10);
    expect(sql).toContain("BULK 'https://a/b''c'");
  });
});
