/**
 * preview-shaping — pure logic behind the Eventstream docked data-preview
 * (column type inference, flattening, search + time-range filters).
 */
import { describe, it, expect } from 'vitest';
import {
  coerceBody, inferValueType, inferColumnType, shapeEventPreview,
  filterPreviewRows, filterByTimeRange, formatPreviewCell, columnLabel,
  SYS_PARTITION, SYS_ENQUEUED,
} from '../preview-shaping';

describe('coerceBody', () => {
  it('passes an object body through', () => {
    expect(coerceBody({ a: 1 })).toEqual({ a: 1 });
  });
  it('parses a JSON-string body', () => {
    expect(coerceBody('{"a":1}')).toEqual({ a: 1 });
  });
  it('wraps a scalar/plain string under value', () => {
    expect(coerceBody('hello')).toEqual({ value: 'hello' });
    expect(coerceBody(42)).toEqual({ value: 42 });
  });
  it('wraps an array body under value (not spread as columns)', () => {
    expect(coerceBody([1, 2])).toEqual({ value: [1, 2] });
  });
});

describe('inferValueType', () => {
  it('detects primitives', () => {
    expect(inferValueType(true)).toBe('boolean');
    expect(inferValueType(3.14)).toBe('number');
    expect(inferValueType('sensor-A')).toBe('string');
  });
  it('detects ISO datetimes', () => {
    expect(inferValueType('2026-07-09T12:04:11Z')).toBe('datetime');
    expect(inferValueType('2026-07-09')).toBe('datetime');
  });
  it('detects numeric strings but keeps leading-zero ids as string', () => {
    expect(inferValueType('42')).toBe('number');
    expect(inferValueType('007')).toBe('string');
  });
  it('detects geo points by shape and by key', () => {
    expect(inferValueType({ lat: 1, lon: 2 })).toBe('geo');
    expect(inferValueType([12.3, 45.6], 'location')).toBe('geo');
  });
  it('treats plain objects as record', () => {
    expect(inferValueType({ nested: true })).toBe('record');
  });
  it('ignores null/undefined', () => {
    expect(inferValueType(null)).toBeNull();
    expect(inferValueType(undefined)).toBeNull();
  });
});

describe('inferColumnType', () => {
  it('falls back to string on mixed types', () => {
    expect(inferColumnType([1, 'x'])).toBe('string');
  });
  it('is number when every non-null value is numeric', () => {
    expect(inferColumnType([1, 2, null, 3])).toBe('number');
  });
  it('defaults empty columns to string', () => {
    expect(inferColumnType([null, undefined])).toBe('string');
  });
});

describe('shapeEventPreview', () => {
  const events = [
    { partitionId: '0', enqueuedTime: '2026-07-09T12:00:00Z', body: { deviceId: 'A', temp: 30.1, ok: true } },
    { partitionId: '1', enqueuedTime: '2026-07-09T12:00:05Z', body: '{"deviceId":"B","temp":29.4,"ok":false}' },
  ];

  it('emits system columns first, then body fields in first-seen order', () => {
    const shape = shapeEventPreview(events);
    expect(shape.columns.map((c) => c.key)).toEqual([SYS_PARTITION, SYS_ENQUEUED, 'deviceId', 'temp', 'ok']);
    expect(shape.columns[0].system).toBe(true);
    expect(shape.columns[1].type).toBe('datetime');
  });

  it('infers body column types', () => {
    const shape = shapeEventPreview(events);
    const byKey = Object.fromEntries(shape.columns.map((c) => [c.key, c.type]));
    expect(byKey.deviceId).toBe('string');
    expect(byKey.temp).toBe('number');
    expect(byKey.ok).toBe('boolean');
  });

  it('applies a per-column type override', () => {
    const shape = shapeEventPreview(events, { typeOverrides: { temp: 'string' } });
    expect(shape.columns.find((c) => c.key === 'temp')!.type).toBe('string');
  });

  it('flattens JSON-string bodies into the same columns as object bodies', () => {
    const shape = shapeEventPreview(events);
    expect(shape.rows[1].deviceId).toBe('B');
    expect(shape.rows[1].temp).toBe(29.4);
  });

  it('returns an empty shape for no events', () => {
    expect(shapeEventPreview([])).toEqual({ columns: [], rows: [] });
  });
});

describe('filterPreviewRows', () => {
  const shape = shapeEventPreview([
    { body: { deviceId: 'sensor-A', temp: 30 } },
    { body: { deviceId: 'sensor-B', temp: 12 } },
  ]);
  it('matches across any cell, case-insensitively', () => {
    expect(filterPreviewRows(shape.rows, shape.columns, 'SENSOR-a')).toHaveLength(1);
    expect(filterPreviewRows(shape.rows, shape.columns, '12')).toHaveLength(1);
  });
  it('returns all rows for a blank query', () => {
    expect(filterPreviewRows(shape.rows, shape.columns, '  ')).toHaveLength(2);
  });
});

describe('filterByTimeRange', () => {
  const now = Date.parse('2026-07-09T12:00:00Z');
  const rows = [
    { [SYS_ENQUEUED]: '2026-07-09T11:59:30Z' }, // 30s ago
    { [SYS_ENQUEUED]: '2026-07-09T10:00:00Z' }, // 2h ago
    { foo: 'no-timestamp' },                    // unknown age
  ];
  it('keeps only rows within the window (plus rows with no timestamp)', () => {
    const kept = filterByTimeRange(rows, 5 * 60_000, now);
    expect(kept).toHaveLength(2); // 30s-ago row + the no-timestamp row
  });
  it('keeps everything for a null range', () => {
    expect(filterByTimeRange(rows, null, now)).toHaveLength(3);
  });
});

describe('formatPreviewCell / columnLabel', () => {
  it('stringifies objects and passes primitives', () => {
    expect(formatPreviewCell({ a: 1 })).toBe('{"a":1}');
    expect(formatPreviewCell('x')).toBe('x');
    expect(formatPreviewCell(null)).toBe('');
  });
  it('gives system columns friendly labels', () => {
    expect(columnLabel(SYS_PARTITION)).toBe('Partition');
    expect(columnLabel(SYS_ENQUEUED)).toBe('Enqueued time');
    expect(columnLabel('deviceId')).toBe('deviceId');
  });
});
