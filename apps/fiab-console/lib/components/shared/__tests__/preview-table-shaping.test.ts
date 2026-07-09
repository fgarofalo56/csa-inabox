/**
 * preview-table-shaping — pure logic behind the shared <PreviewTable> (SC-5):
 * columnar type inference, cell formatting, row search, and the Fabric-parity
 * "Succeeded (Xs) · Columns N · Rows N" status bar.
 */
import { describe, it, expect } from 'vitest';
import {
  inferValueType, inferColumnType, shapeColumnarPreview, formatPreviewCell,
  filterColumnarRows, formatElapsed, statusBarText,
  TYPE_BADGE_TEXT, PREVIEW_CELL_TYPES,
  type PreviewCellType,
} from '../preview-table-shaping';

describe('inferValueType', () => {
  it('detects primitives', () => {
    expect(inferValueType(true)).toBe('boolean');
    expect(inferValueType(42)).toBe('number');
    expect(inferValueType(new Date())).toBe('datetime');
  });
  it('returns null for null/undefined', () => {
    expect(inferValueType(null)).toBeNull();
    expect(inferValueType(undefined)).toBeNull();
  });
  it('detects ISO datetime strings and numeric strings', () => {
    expect(inferValueType('2026-07-09T14:30:00Z')).toBe('datetime');
    expect(inferValueType('2026-07-09')).toBe('datetime');
    expect(inferValueType('-12.5')).toBe('number');
  });
  it('keeps leading-zero ids as string, not number', () => {
    expect(inferValueType('007')).toBe('string');
  });
  it('detects geo by shape and by key', () => {
    expect(inferValueType([47.6, -122.3])).toBe('geo');
    expect(inferValueType({ lat: 47.6, lon: -122.3 })).toBe('geo');
    expect(inferValueType({ a: 1 }, 'location')).toBe('json'); // not geo-shaped
  });
  it('treats plain objects/arrays as json', () => {
    expect(inferValueType({ a: 1, b: 2 })).toBe('json');
    expect(inferValueType([1, 2, 3])).toBe('json');
  });
});

describe('inferColumnType', () => {
  it('resolves a uniform column', () => {
    expect(inferColumnType([1, 2, 3])).toBe('number');
  });
  it('falls back to string on a mix that includes a plain string', () => {
    expect(inferColumnType([1, 'abc', 3])).toBe('string');
  });
  it('ignores nulls', () => {
    expect(inferColumnType([null, 2, null])).toBe('number');
    expect(inferColumnType([null, null])).toBe('string');
  });
});

describe('shapeColumnarPreview', () => {
  it('builds typed columns from positional rows', () => {
    const shape = shapeColumnarPreview(
      ['name', 'qty', 'ts'],
      [['sensor-a', 30.1, '2026-07-09T00:00:00Z'], ['sensor-b', 12, '2026-07-09T01:00:00Z']],
    );
    expect(shape.columns.map((c) => c.type)).toEqual(['string', 'number', 'datetime']);
    expect(shape.columns.map((c) => c.name)).toEqual(['name', 'qty', 'ts']);
    expect(shape.columns.map((c) => c.index)).toEqual([0, 1, 2]);
  });
  it('honours a per-column type override by name', () => {
    const overrides: Record<string, PreviewCellType> = { qty: 'string' };
    const shape = shapeColumnarPreview(['qty'], [[1], [2]], { typeOverrides: overrides });
    expect(shape.columns[0].type).toBe('string');
  });
  it('yields an empty shape for no columns', () => {
    expect(shapeColumnarPreview([], []).columns).toEqual([]);
  });
});

describe('formatPreviewCell', () => {
  it('formats scalars and json', () => {
    expect(formatPreviewCell(null)).toBe('');
    expect(formatPreviewCell('hi')).toBe('hi');
    expect(formatPreviewCell(3.5)).toBe('3.5');
    expect(formatPreviewCell({ a: 1 })).toBe('{"a":1}');
  });
});

describe('filterColumnarRows', () => {
  const rows = [['sensor-a', 30], ['sensor-b', 12]];
  it('returns all rows for an empty query', () => {
    expect(filterColumnarRows(rows, '')).toBe(rows);
  });
  it('matches any cell case-insensitively', () => {
    expect(filterColumnarRows(rows, 'SENSOR-B')).toEqual([['sensor-b', 12]]);
    expect(filterColumnarRows(rows, '30')).toEqual([['sensor-a', 30]]);
  });
});

describe('formatElapsed', () => {
  it('formats sub-second and multi-second', () => {
    expect(formatElapsed(820)).toBe('820 ms');
    expect(formatElapsed(3030)).toBe('3 sec 30 ms');
    expect(formatElapsed(3000)).toBe('3 sec');
  });
  it('clamps negatives / NaN to 0 ms', () => {
    expect(formatElapsed(-5)).toBe('0 ms');
    expect(formatElapsed(NaN)).toBe('0 ms');
  });
});

describe('statusBarText', () => {
  it('builds the Fabric-parity success line', () => {
    expect(statusBarText('succeeded', { elapsedMs: 3030, columns: 54, rows: 1000 }))
      .toBe('Succeeded (3 sec 30 ms) · Columns 54 · Rows 1,000');
  });
  it('marks truncated row counts with a +', () => {
    expect(statusBarText('succeeded', { elapsedMs: 10, columns: 1, rows: 5000, truncated: true }))
      .toBe('Succeeded (10 ms) · Columns 1 · Rows 5,000+');
  });
  it('handles running and failed states', () => {
    expect(statusBarText('running')).toBe('Running…');
    expect(statusBarText('failed', { columns: 2 })).toBe('Failed · Columns 2');
  });
});

describe('badge tables', () => {
  it('has a badge for every preview cell type', () => {
    for (const t of PREVIEW_CELL_TYPES) {
      expect(TYPE_BADGE_TEXT[t]).toBeTruthy();
      expect(typeof TYPE_BADGE_TEXT[t].text).toBe('string');
    }
  });
});
