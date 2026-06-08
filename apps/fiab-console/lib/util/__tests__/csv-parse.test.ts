import { describe, it, expect } from 'vitest';
import { parseCsv, validateImportCsv, splitTags, MAX_IMPORT_ROWS } from '../csv-parse';

describe('parseCsv', () => {
  it('parses a simple CSV with normalised headers', () => {
    const { headers, rows } = parseCsv('Name,Owner\r\nA,alice@x.com\r\nB,bob@x.com\r\n');
    expect(headers).toEqual(['name', 'owner']);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ name: 'A', owner: 'alice@x.com' });
    expect(rows[1].name).toBe('B');
  });

  it('honours RFC-4180 quoting: embedded commas, newlines, doubled quotes', () => {
    const text = 'name,description\r\n"Sales, Inc","line1\nline2"\r\n"He said ""hi""",ok\r\n';
    const { rows } = parseCsv(text);
    expect(rows[0].name).toBe('Sales, Inc');
    expect(rows[0].description).toBe('line1\nline2');
    expect(rows[1].name).toBe('He said "hi"');
  });

  it('strips a UTF-8 BOM and ignores empty trailing rows', () => {
    const { headers, rows } = parseCsv('﻿name,owner\nA,a\n\n');
    expect(headers[0]).toBe('name');
    expect(rows).toHaveLength(1);
  });

  it('handles LF-only line endings', () => {
    const { rows } = parseCsv('name,owner\nA,a\nB,b');
    expect(rows).toHaveLength(2);
    expect(rows[1].owner).toBe('b');
  });
});

describe('validateImportCsv', () => {
  const good = 'name,description,domain,owner,tags\nA,desc,Sales,a@x.com,finance;daily\nB,desc2,Ops,b@x.com,iot\n';

  it('accepts a valid 2-row CSV', () => {
    const v = validateImportCsv(good);
    expect(v.errors).toHaveLength(0);
    expect(v.validRowCount).toBe(2);
    expect(v.tooLarge).toBe(false);
  });

  it('flags a missing required column at the header row', () => {
    const v = validateImportCsv('name,description,domain\nA,d,Sales\n');
    const header = v.errors.filter((e) => e.row === 1);
    expect(header.some((e) => /owner/.test(e.error))).toBe(true);
  });

  it('reports an invalid row WITHOUT discarding the valid rows', () => {
    // row 3 (sheet) has an empty owner — should be reported but not block row 2.
    const v = validateImportCsv('name,description,domain,owner\nGood,d,Sales,a@x.com\nBad,d,Ops,\n');
    expect(v.validRowCount).toBe(1);
    const rowErr = v.errors.find((e) => e.row === 3);
    expect(rowErr).toBeTruthy();
    expect(rowErr?.column).toBe('owner');
  });

  it('flags too-large files over the cap', () => {
    const header = 'name,description,domain,owner\n';
    const body = Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, i) => `n${i},d,Sales,o@x.com`).join('\n');
    const v = validateImportCsv(header + body + '\n');
    expect(v.tooLarge).toBe(true);
  });
});

describe('splitTags', () => {
  it('splits on semicolons and commas and trims', () => {
    expect(splitTags('finance; daily ,crm')).toEqual(['finance', 'daily', 'crm']);
  });
  it('returns [] for empty/undefined', () => {
    expect(splitTags(undefined)).toEqual([]);
    expect(splitTags('')).toEqual([]);
  });
});
