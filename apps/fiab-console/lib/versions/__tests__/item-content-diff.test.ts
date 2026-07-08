/**
 * Unit tests for the field-level content diff + summarizer (Wave-2 W6).
 * Pure functions — no mocks needed.
 */
import { describe, it, expect } from 'vitest';
import {
  diffItemContent,
  summarizeChanges,
  summarizeContentDiff,
  type FieldChange,
} from '../item-content-diff';

const byPath = (changes: FieldChange[]) => Object.fromEntries(changes.map((c) => [c.path, c]));

describe('diffItemContent', () => {
  it('reports no changes for identical content', () => {
    const a = { displayName: 'X', state: { content: { a: 1, b: [1, 2] } } };
    const b = { displayName: 'X', state: { content: { a: 1, b: [1, 2] } } };
    expect(diffItemContent(a, b)).toEqual([]);
  });

  it('detects a changed leaf with old→new values and a dotted path', () => {
    const a = { displayName: 'Sales', state: { rows: 100 } };
    const b = { displayName: 'Sales', state: { rows: 200 } };
    const m = byPath(diffItemContent(a, b));
    expect(m['state.rows']).toEqual({ path: 'state.rows', kind: 'changed', oldValue: 100, newValue: 200 });
    expect(m['displayName']).toBeUndefined();
  });

  it('detects added and removed fields', () => {
    const a = { state: { a: 1, gone: true } };
    const b = { state: { a: 1, added: 'new' } };
    const m = byPath(diffItemContent(a, b));
    expect(m['state.added']).toMatchObject({ kind: 'added', newValue: 'new' });
    expect(m['state.gone']).toMatchObject({ kind: 'removed', oldValue: true });
  });

  it('indexes array elements with bracket paths', () => {
    const a = { state: { tables: [{ name: 'old' }, { name: 'keep' }] } };
    const b = { state: { tables: [{ name: 'new' }, { name: 'keep' }, { name: 'extra' }] } };
    const m = byPath(diffItemContent(a, b));
    expect(m['state.tables[0].name']).toMatchObject({ kind: 'changed', oldValue: 'old', newValue: 'new' });
    expect(m['state.tables[2].name']).toMatchObject({ kind: 'added', newValue: 'extra' });
    expect(m['state.tables[1].name']).toBeUndefined();
  });

  it('treats a shape change (object↔leaf) as a single changed node', () => {
    const a = { state: { x: { nested: 1 } } };
    const b = { state: { x: 'flat' } };
    const m = byPath(diffItemContent(a, b));
    expect(m['state.x']).toMatchObject({ kind: 'changed', oldValue: { nested: 1 }, newValue: 'flat' });
  });

  it('treats null and missing distinctly (null defined, undefined missing)', () => {
    const a = { state: { a: null as unknown } };
    const b = { state: {} };
    const m = byPath(diffItemContent(a, b));
    expect(m['state.a']).toMatchObject({ kind: 'removed', oldValue: null });
  });
});

describe('summarizeChanges', () => {
  it('summarizes an empty change set', () => {
    const s = summarizeChanges([]);
    expect(s).toMatchObject({ added: 0, removed: 0, changed: 0, total: 0, text: 'No changes' });
  });

  it('counts buckets and renders a compact sentence', () => {
    const changes: FieldChange[] = [
      { path: 'a', kind: 'changed', oldValue: 1, newValue: 2 },
      { path: 'b', kind: 'changed', oldValue: 3, newValue: 4 },
      { path: 'c', kind: 'added', newValue: 5 },
    ];
    const s = summarizeChanges(changes);
    expect(s).toMatchObject({ changed: 2, added: 1, removed: 0, total: 3 });
    expect(s.text).toBe('2 changed, 1 added');
  });

  it('uses friendly single-bucket phrasing', () => {
    expect(summarizeChanges([{ path: 'a', kind: 'changed', oldValue: 1, newValue: 2 }]).text)
      .toBe('1 field changed');
    expect(summarizeChanges([{ path: 'a', kind: 'added', newValue: 1 }]).text)
      .toBe('1 field added');
  });

  it('summarizeContentDiff composes diff + summary', () => {
    const s = summarizeContentDiff({ state: { a: 1 } }, { state: { a: 2, b: 3 } });
    expect(s.total).toBe(2);
    expect(s.changed).toBe(1);
    expect(s.added).toBe(1);
  });
});
