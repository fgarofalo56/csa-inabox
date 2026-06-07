/**
 * delta-preview-grid-utils — pure logic for the Lakehouse preview DataGrid.
 * Node-env unit tests (no render) covering CSV serialization, numeric-column
 * detection, cell formatting, and the client-side filter.
 */
import { describe, it, expect } from 'vitest';
import {
  formatCell, columnIsNumeric, csvField, toCsv, fmtNum, rowMatchesFilter,
} from '../components/delta-preview-grid-utils';

describe('delta-preview-grid-utils', () => {
  describe('formatCell', () => {
    it('renders NULL for null/undefined', () => {
      expect(formatCell(null)).toBe('NULL');
      expect(formatCell(undefined)).toBe('NULL');
    });
    it('JSON-stringifies objects', () => {
      expect(formatCell({ a: 1 })).toBe('{"a":1}');
    });
    it('stringifies primitives', () => {
      expect(formatCell(42)).toBe('42');
      expect(formatCell('hi')).toBe('hi');
      expect(formatCell(false)).toBe('false');
    });
  });

  describe('columnIsNumeric', () => {
    const rows: unknown[][] = [
      ['a', 1, '2.5', null],
      ['b', 2, '3.0', ''],
      ['c', 3, 'x', null],
    ];
    it('detects an all-numeric column (ignoring nulls/empties)', () => {
      expect(columnIsNumeric(rows, 1)).toBe(true);
    });
    it('treats numeric strings as numeric', () => {
      expect(columnIsNumeric([['1'], ['2'], [null]], 0)).toBe(true);
    });
    it('rejects a column with a non-numeric value', () => {
      expect(columnIsNumeric(rows, 2)).toBe(false);
      expect(columnIsNumeric(rows, 0)).toBe(false);
    });
    it('returns false for an all-null column (no values seen)', () => {
      expect(columnIsNumeric(rows, 3)).toBe(false);
    });
  });

  describe('csvField (RFC-4180)', () => {
    it('passes plain values through', () => {
      expect(csvField('hello')).toBe('hello');
      expect(csvField(123)).toBe('123');
    });
    it('emits empty for null/undefined', () => {
      expect(csvField(null)).toBe('');
      expect(csvField(undefined)).toBe('');
    });
    it('quotes + escapes commas, quotes, and newlines', () => {
      expect(csvField('a,b')).toBe('"a,b"');
      expect(csvField('say "hi"')).toBe('"say ""hi"""');
      expect(csvField('line1\nline2')).toBe('"line1\nline2"');
    });
    it('serializes objects as JSON, quoted because of commas', () => {
      expect(csvField({ a: 1, b: 2 })).toBe('"{""a"":1,""b"":2}"');
    });
  });

  describe('toCsv', () => {
    it('produces a header row + CRLF-joined data rows', () => {
      const csv = toCsv(['id', 'name'], [[1, 'Ann'], [2, 'Bo,b']]);
      expect(csv).toBe('id,name\r\n1,Ann\r\n2,"Bo,b"');
    });
    it('aligns cells to the column count, filling missing with empty', () => {
      const csv = toCsv(['a', 'b', 'c'], [[1, 2]]);
      expect(csv).toBe('a,b,c\r\n1,2,');
    });
  });

  describe('fmtNum', () => {
    it('renders an em-dash for null/undefined/NaN', () => {
      expect(fmtNum(null)).toBe('—');
      expect(fmtNum(undefined)).toBe('—');
      expect(fmtNum(NaN)).toBe('—');
    });
    it('formats integers without decimals', () => {
      expect(fmtNum(1000)).toBe((1000).toLocaleString());
    });
    it('caps decimals at 4 places', () => {
      expect(fmtNum(1.23456789)).toBe((1.2346).toLocaleString(undefined, { maximumFractionDigits: 4 }));
    });
  });

  describe('rowMatchesFilter', () => {
    const cells = ['Orders', 42, null, { region: 'east' }];
    it('matches an empty needle', () => {
      expect(rowMatchesFilter(cells, '')).toBe(true);
    });
    it('matches case-insensitively across cells', () => {
      expect(rowMatchesFilter(cells, 'order')).toBe(true);
      expect(rowMatchesFilter(cells, '42')).toBe(true);
      expect(rowMatchesFilter(cells, 'EAST')).toBe(true);
    });
    it('does not match an absent needle', () => {
      expect(rowMatchesFilter(cells, 'zzz')).toBe(false);
    });
  });
});
