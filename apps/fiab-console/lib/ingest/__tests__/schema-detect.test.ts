import { describe, it, expect } from 'vitest';
import { detectSchema, parseCsvLine, abfssToHttps, isSasUrl } from '@/lib/ingest/schema-detect';

describe('schema-detect — parseCsvLine', () => {
  it('splits a simple line', () => {
    expect(parseCsvLine('a,b,c')).toEqual(['a', 'b', 'c']);
  });
  it('honors RFC-4180 quoted commas and escaped quotes', () => {
    expect(parseCsvLine('"a,1","b""2",c')).toEqual(['a,1', 'b"2', 'c']);
  });
});

describe('schema-detect — detectSchema (CSV)', () => {
  it('detects columns + sample rows from CSV', () => {
    const csv = 'ts,value,name\n2026-01-01,10,alpha\n2026-01-02,20,beta\n';
    const p = detectSchema(csv, 'data.csv');
    expect(p.detectedFormat).toBe('csv');
    expect(p.columns).toEqual(['ts', 'value', 'name']);
    expect(p.sampleRows[0]).toEqual(['2026-01-01', '10', 'alpha']);
    expect(p.sampleRowCount).toBe(2);
  });

  it('drops a trailing partial line from a truncated chunk', () => {
    const csv = 'a,b\n1,2\n3,4\n5,'; // last line is truncated, no newline
    const p = detectSchema(csv, 'data.csv');
    expect(p.columns).toEqual(['a', 'b']);
    // truncated last row dropped
    expect(p.sampleRows.every((r) => r.length === 2)).toBe(true);
  });
});

describe('schema-detect — detectSchema (JSON)', () => {
  it('detects columns from a JSON array', () => {
    const json = '[{"id":1,"name":"a"},{"id":2,"name":"b"}]';
    const p = detectSchema(json, 'data.json');
    expect(p.detectedFormat).toBe('multijson');
    expect(p.columns.sort()).toEqual(['id', 'name']);
    expect(p.sampleRowCount).toBe(2);
  });

  it('detects columns from JSONL', () => {
    const jsonl = '{"x":1,"y":2}\n{"x":3,"y":4}';
    const p = detectSchema(jsonl, 'data.jsonl');
    expect(p.detectedFormat).toBe('json');
    expect(p.columns.sort()).toEqual(['x', 'y']);
  });

  it('recovers leading objects from a truncated JSON array', () => {
    const truncated = '[{"a":1,"b":2},{"a":3,"b":4},{"a":5,"b":'; // cut off mid-object
    const p = detectSchema(truncated, 'data.json');
    expect(p.columns.sort()).toEqual(['a', 'b']);
    expect(p.sampleRowCount).toBe(2); // only the two complete objects
  });
});

describe('schema-detect — url helpers', () => {
  it('rewrites abfss:// to https:// DFS form', () => {
    expect(abfssToHttps('abfss://bronze@sa1.dfs.core.windows.net/folder/f.csv'))
      .toBe('https://sa1.dfs.core.windows.net/bronze/folder/f.csv');
  });
  it('leaves https:// unchanged', () => {
    const u = 'https://sa1.blob.core.windows.net/c/f.csv?sv=2021&sig=abc';
    expect(abfssToHttps(u)).toBe(u);
  });
  it('detects SAS urls', () => {
    expect(isSasUrl('https://x/y?sv=2021&sig=abc')).toBe(true);
    expect(isSasUrl('https://x/y')).toBe(false);
    expect(isSasUrl('abfss://c@a.dfs.core.windows.net/p')).toBe(false);
  });
});
