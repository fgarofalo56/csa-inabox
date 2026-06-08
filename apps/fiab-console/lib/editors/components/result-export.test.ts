import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  csvEscape, resultsToCsv, resultsToJson,
  downloadBlob, downloadResultsCsv, downloadResultsJson,
} from './result-export';

describe('csvEscape', () => {
  it('passes plain values through unquoted', () => {
    expect(csvEscape('hello')).toBe('hello');
    expect(csvEscape(42)).toBe('42');
    expect(csvEscape(true)).toBe('true');
  });
  it('renders null/undefined as empty string', () => {
    expect(csvEscape(null)).toBe('');
    expect(csvEscape(undefined)).toBe('');
  });
  it('quotes and doubles embedded quotes', () => {
    expect(csvEscape('a,b')).toBe('"a,b"');
    expect(csvEscape('he said "hi"')).toBe('"he said ""hi"""');
    expect(csvEscape('line1\nline2')).toBe('"line1\nline2"');
  });
  it('JSON-stringifies objects', () => {
    expect(csvEscape({ a: 1 })).toBe('"{""a"":1}"');
  });
});

describe('resultsToCsv', () => {
  it('emits a header row then data rows with CRLF endings', () => {
    const cols = ['id', 'name'];
    const rows = [[1, 'Ada'], [2, 'Linus']];
    expect(resultsToCsv(cols, rows)).toBe('id,name\r\n1,Ada\r\n2,Linus');
  });
  it('escapes fields that contain delimiters', () => {
    const cols = ['id', 'note'];
    const rows = [[1, 'a,b'], [2, 'q"x']];
    expect(resultsToCsv(cols, rows)).toBe('id,note\r\n1,"a,b"\r\n2,"q""x"');
  });
  it('renders nulls as empty CSV fields', () => {
    expect(resultsToCsv(['a', 'b'], [[null, 1]])).toBe('a,b\r\n,1');
  });
  it('handles an empty result set (header only)', () => {
    expect(resultsToCsv(['a', 'b'], [])).toBe('a,b');
  });
});

describe('resultsToJson', () => {
  it('produces a valid JSON array of row objects keyed by column', () => {
    const cols = ['id', 'name'];
    const rows = [[1, 'Ada'], [2, 'Linus']];
    const json = resultsToJson(cols, rows);
    expect(JSON.parse(json)).toEqual([
      { id: 1, name: 'Ada' },
      { id: 2, name: 'Linus' },
    ]);
  });
  it('coerces undefined cells to null', () => {
    const json = resultsToJson(['a', 'b'], [[undefined, 'x']]);
    expect(JSON.parse(json)).toEqual([{ a: null, b: 'x' }]);
  });
  it('emits a valid empty array for no rows', () => {
    expect(JSON.parse(resultsToJson(['a'], []))).toEqual([]);
  });
});

describe('download triggers', () => {
  let clickSpy: ReturnType<typeof vi.fn>;
  let lastAnchor: any;

  beforeEach(() => {
    clickSpy = vi.fn();
    (globalThis as any).Blob = class {
      parts: any[]; type: string;
      constructor(parts: any[], opts: any) { this.parts = parts; this.type = opts?.type; }
    };
    (globalThis as any).URL = { createObjectURL: vi.fn(() => 'blob:fake'), revokeObjectURL: vi.fn() };
    lastAnchor = null;
    (globalThis as any).document = {
      createElement: () => {
        lastAnchor = { href: '', download: '', click: clickSpy };
        return lastAnchor;
      },
      body: { appendChild: vi.fn(), removeChild: vi.fn() },
    };
  });
  afterEach(() => {
    delete (globalThis as any).Blob;
    delete (globalThis as any).URL;
    delete (globalThis as any).document;
  });

  it('downloadBlob sets filename + clicks an anchor', () => {
    downloadBlob('x.csv', 'text/csv', 'a,b');
    expect(lastAnchor.download).toBe('x.csv');
    expect(clickSpy).toHaveBeenCalledOnce();
  });
  it('downloadResultsCsv appends .csv to the basename', () => {
    downloadResultsCsv('query-results', ['a'], [[1]]);
    expect(lastAnchor.download).toBe('query-results.csv');
  });
  it('downloadResultsJson appends .json to the basename', () => {
    downloadResultsJson('query-results', ['a'], [[1]]);
    expect(lastAnchor.download).toBe('query-results.json');
  });
});
