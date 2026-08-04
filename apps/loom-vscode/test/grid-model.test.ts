/**
 * Grid shaping — normalizing the non-uniform SQL/KQL/preview envelopes into a
 * type-badged column + row grid, and the credential-free webview payload.
 *
 * Second MUTATION-PROOF: `shapeGrid` must PREFER the engine's declared column
 * type (`columnTypes[i]`) over the inferred badge. Revert that preference in
 * grid-model.ts (always infer) and the "KQL declared datetime" test goes RED.
 */
import { describe, it, expect } from 'vitest';
import { shapeGrid, buildGridMessage, inferColumnType, renderCell } from '../src/query/grid-model';

describe('renderCell — safe display strings', () => {
  it('renders null/undefined as NULL', () => {
    expect(renderCell(null)).toBe('NULL');
    expect(renderCell(undefined)).toBe('NULL');
  });
  it('renders scalars verbatim, objects as JSON', () => {
    expect(renderCell(42)).toBe('42');
    expect(renderCell(true)).toBe('true');
    expect(renderCell('hi')).toBe('hi');
    expect(renderCell({ a: 1 })).toBe('{"a":1}');
    expect(renderCell([1, 2])).toBe('[1,2]');
  });
});

describe('inferColumnType — honest badge from real cells', () => {
  it('numbers → number, mixed → string, empty → null', () => {
    expect(inferColumnType([1, 2, 3])).toBe('number');
    expect(inferColumnType(['1', '2'])).toBe('number');
    expect(inferColumnType([1, 'x'])).toBe('string');
    expect(inferColumnType([null, undefined, ''])).toBe('null');
    expect(inferColumnType([true, false])).toBe('boolean');
  });
});

describe('shapeGrid — Synapse SQL shape (columns string[], positional rows)', () => {
  it('shapes columns + rows and infers types', () => {
    const model = shapeGrid({
      ok: true,
      columns: ['id', 'name'],
      rows: [
        [1, 'alpha'],
        [2, 'beta'],
      ],
      rowCount: 2,
      executionMs: 42,
    });
    expect(model.kind).toBe('grid');
    if (model.kind !== 'grid') return;
    expect(model.columns.map((c) => c.name)).toEqual(['id', 'name']);
    expect(model.columns[0].type).toBe('number'); // inferred
    expect(model.columns[1].type).toBe('string');
    expect(model.rows).toEqual([
      ['1', 'alpha'],
      ['2', 'beta'],
    ]);
    expect(model.rowCount).toBe(2);
    expect(model.elapsedMs).toBe(42);
  });

  it('renders a NULL cell honestly', () => {
    const model = shapeGrid({ ok: true, columns: ['a'], rows: [[null]] });
    if (model.kind !== 'grid') throw new Error('expected grid');
    expect(model.rows[0][0]).toBe('NULL');
  });
});

describe('shapeGrid — ADX/KQL shape (parallel columnTypes)', () => {
  // ── MUTATION-PROOF ────────────────────────────────────────────────────────
  // The declared engine type MUST win over the inferred one. Revert the
  // `declared ?? inferColumnType(...)` preference → type becomes inferred
  // ('string' / 'datetime'-from-string) and this exact assertion fails.
  it('prefers the engine-declared column type over inference', () => {
    const model = shapeGrid({
      ok: true,
      columns: ['ts', 'label'],
      columnTypes: ['datetime', 'string'],
      rows: [['2020-01-01T00:00:00Z', 'x']],
    });
    if (model.kind !== 'grid') throw new Error('expected grid');
    expect(model.columns[0].type).toBe('datetime');
    expect(model.columns[1].type).toBe('string');
  });
});

describe('shapeGrid — keyed rows + DDL/empty', () => {
  it('orders keyed record rows by the column list', () => {
    const model = shapeGrid({ columns: ['a', 'b'], rows: [{ b: 2, a: 1 }] });
    if (model.kind !== 'grid') throw new Error('expected grid');
    expect(model.rows[0]).toEqual(['1', '2']);
  });

  it('turns a DDL result (no columns, isDdl) into a message', () => {
    const model = shapeGrid({ ok: true, columns: [], rows: [], isDdl: true });
    expect(model.kind).toBe('message');
    if (model.kind !== 'message') return;
    expect(model.isError).toBe(false);
    expect(model.message).toMatch(/completed/i);
  });

  it('carries a cap badge through', () => {
    const model = shapeGrid({ columns: ['a'], rows: [[1]], truncatedByCap: true, cappedBy: 'rows' });
    if (model.kind !== 'grid') throw new Error('expected grid');
    expect(model.truncated).toBe(true);
    expect(model.cappedBy).toBe('rows');
  });
});

describe('buildGridMessage — the payload carries NO credential', () => {
  it('exposes only column/row/meta keys (no token/cookie/session)', () => {
    const model = shapeGrid({
      ok: true,
      columns: ['secret_looking_column'],
      rows: [['a value that mentions loom_pat_abc but is just data']],
      executionMs: 5,
    });
    if (model.kind !== 'grid') throw new Error('expected grid');
    const msg = buildGridMessage('title', 'sql', model);

    // The message shape is a fixed, safe allow-list — structurally impossible
    // for a PAT/cookie/session to ride along.
    expect(Object.keys(msg).sort()).toEqual(['columns', 'engine', 'meta', 'rows', 'title', 'type']);
    expect(Object.keys(msg.meta).sort()).toEqual(['elapsedMs', 'rowCount', 'truncated']);

    const serialized = JSON.stringify(msg).toLowerCase();
    // Cell data may legitimately contain any string, but no credential-bearing
    // KEY may exist anywhere in the payload structure.
    for (const forbidden of ['"authorization"', '"cookie"', '"token"', '"accesstoken"', '"secret"', '"pat"']) {
      expect(serialized.includes(forbidden)).toBe(false);
    }
  });
});
