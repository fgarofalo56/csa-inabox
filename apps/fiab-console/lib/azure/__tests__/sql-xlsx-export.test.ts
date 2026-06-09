import { describe, it, expect } from 'vitest';
import { recordsetsToXlsxBuffer } from '../sql-xlsx-export';
import type { RecordsetSlice, InfoMessage } from '../azure-sql-client';

// Decode the raw ZIP bytes as latin1 so we can assert on the STORED
// (uncompressed) XML parts directly — no SheetJS dependency needed.
function asText(buf: Uint8Array): string {
  return Buffer.from(buf).toString('latin1');
}

const rs = (columns: string[], rows: unknown[][], rowCount?: number, truncated = false): RecordsetSlice => ({
  columns, rows, rowCount: rowCount ?? rows.length, truncated,
});

describe('recordsetsToXlsxBuffer', () => {
  it('produces a ZIP/XLSX with the PK magic bytes', () => {
    const buf = recordsetsToXlsxBuffer([rs(['id', 'name'], [[1, 'Alice'], [2, 'Bob']])], []);
    expect(buf.length).toBeGreaterThan(0);
    expect(buf[0]).toBe(0x50); // 'P'
    expect(buf[1]).toBe(0x4b); // 'K'
    expect(buf[2]).toBe(0x03);
    expect(buf[3]).toBe(0x04);
  });

  it('emits the required OOXML package parts + the cell values', () => {
    const buf = recordsetsToXlsxBuffer([rs(['id', 'name'], [[1, 'Alice'], [2, 'Bob']])], []);
    const text = asText(buf);
    expect(text).toContain('[Content_Types].xml');
    expect(text).toContain('xl/workbook.xml');
    expect(text).toContain('xl/worksheets/sheet1.xml');
    expect(text).toContain('Result 1');
    // Inline string values are present verbatim.
    expect(text).toContain('<t xml:space="preserve">Alice</t>');
    expect(text).toContain('<t xml:space="preserve">id</t>');
    // Numeric cell uses <v> not inlineStr.
    expect(text).toContain('<v>1</v>');
  });

  it('produces one worksheet per recordset', () => {
    const buf = recordsetsToXlsxBuffer([rs(['a'], [[1]]), rs(['b'], [[2]])], []);
    const text = asText(buf);
    expect(text).toContain('xl/worksheets/sheet1.xml');
    expect(text).toContain('xl/worksheets/sheet2.xml');
    expect(text).toContain('Result 1');
    expect(text).toContain('Result 2');
    expect(text).not.toContain('xl/worksheets/sheet3.xml');
  });

  it('adds a Messages sheet only when messages are present', () => {
    const msgs: InfoMessage[] = [
      { message: 'batch start', number: 0, severity: 0, lineNumber: 1, serverName: 'srv', procName: '' },
    ];
    const withMsg = asText(recordsetsToXlsxBuffer([rs(['x'], [[1]])], msgs));
    expect(withMsg).toContain('name="Messages"');
    expect(withMsg).toContain('<t xml:space="preserve">batch start</t>');

    const noMsg = asText(recordsetsToXlsxBuffer([rs(['x'], [[1]])], []));
    expect(noMsg).not.toContain('name="Messages"');
  });

  it('writes an honest truncation note row for capped result sets', () => {
    const buf = recordsetsToXlsxBuffer([rs(['x'], [[1], [2]], 12345, true)], []);
    const text = asText(buf);
    expect(text).toContain('Showing first 2 of 12,345 rows');
  });

  it('xml-escapes special characters in cell values', () => {
    const buf = recordsetsToXlsxBuffer([rs(['v'], [['a < b & "c"']])], []);
    const text = asText(buf);
    expect(text).toContain('a &lt; b &amp; &quot;c&quot;');
  });
});
