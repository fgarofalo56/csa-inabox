/**
 * Ingestion mapping wizard — pure-logic coverage (node env, no jsdom).
 *
 * Exercises the two load-bearing helpers the wizard exports:
 *   - detectSchema: auto-detect a column-map grid from a sample file
 *   - serializeMapping: render the grid into the Kusto mapping JSON definition
 *     (Ordinal for tabular, Path for JSON/ORC/Parquet, Field for Avro),
 *     grounded in Microsoft Learn (kusto/management/mappings).
 *
 * These are the functions that decide whether ingested rows land in the right
 * columns, so they are tested directly against real File inputs (Node 22 ships
 * a global File with a working .text()). No mocks. (Per no-vaporware.md.)
 */
import { describe, it, expect } from 'vitest';
import { detectSchema, serializeMapping, type MappingRow } from '../ingestion-mapping-format';

describe('detectSchema', () => {
  it('detects CSV header + types from a sample file (Ordinal source)', async () => {
    const file = new File(['ts,tenant,value\n2026-01-01T00:00:00Z,acme,42\n'], 's.csv', { type: 'text/csv' });
    const rows = await detectSchema(file, 'csv');
    expect(rows).toEqual([
      { source: '0', column: 'ts', datatype: 'datetime' },
      { source: '1', column: 'tenant', datatype: 'string' },
      { source: '2', column: 'value', datatype: 'long' },
    ]);
  });

  it('honors TSV / PSV delimiters', async () => {
    const tsv = new File(['a\tb\n1\t2\n'], 's.tsv', { type: 'text/plain' });
    const psv = new File(['a|b\n1|2\n'], 's.psv', { type: 'text/plain' });
    expect((await detectSchema(tsv, 'tsv')).map((r) => r.column)).toEqual(['a', 'b']);
    expect((await detectSchema(psv, 'psv')).map((r) => r.column)).toEqual(['a', 'b']);
  });

  it('detects JSON fields with $.path source + inferred types', async () => {
    const file = new File(['{"ts":"2026-01-01T00:00:00Z","n":3,"ok":true,"obj":{"x":1}}'], 's.json', { type: 'application/json' });
    const rows = await detectSchema(file, 'json');
    expect(rows).toEqual([
      { source: '$.ts', column: 'ts', datatype: 'datetime' },
      { source: '$.n', column: 'n', datatype: 'long' },
      { source: '$.ok', column: 'ok', datatype: 'bool' },
      { source: '$.obj', column: 'obj', datatype: 'dynamic' },
    ]);
  });

  it('returns [] for binary formats (no client-side parse)', async () => {
    const file = new File(['PAR1'], 's.parquet', { type: 'application/octet-stream' });
    expect(await detectSchema(file, 'parquet')).toEqual([]);
    expect(await detectSchema(file, 'avro')).toEqual([]);
    expect(await detectSchema(file, 'orc')).toEqual([]);
  });
});

describe('serializeMapping', () => {
  it('uses Ordinal Properties for tabular (csv/tsv/psv) and includes datatype', () => {
    const rows: MappingRow[] = [
      { source: '0', column: 'ts', datatype: 'datetime' },
      { source: '1', column: 'value', datatype: 'long' },
    ];
    const parsed = JSON.parse(serializeMapping(rows, 'csv'));
    expect(parsed).toEqual([
      { Column: 'ts', Properties: { Ordinal: 0 }, datatype: 'datetime' },
      { Column: 'value', Properties: { Ordinal: 1 }, datatype: 'long' },
    ]);
  });

  it('uses Path Properties for JSON / ORC / Parquet', () => {
    const rows: MappingRow[] = [{ source: '$.ts', column: 'ts', datatype: '' }];
    expect(JSON.parse(serializeMapping(rows, 'json'))).toEqual([
      { Column: 'ts', Properties: { Path: '$.ts' } },
    ]);
    expect(JSON.parse(serializeMapping(rows, 'orc'))[0].Properties).toEqual({ Path: '$.ts' });
  });

  it('uses Field Properties for Avro', () => {
    const rows: MappingRow[] = [{ source: 'Field1', column: 'a', datatype: 'string' }];
    expect(JSON.parse(serializeMapping(rows, 'avro'))).toEqual([
      { Column: 'a', Properties: { Field: 'Field1' }, datatype: 'string' },
    ]);
  });

  it('falls back to $.<column> when a Path source is blank, and drops nameless rows', () => {
    const rows: MappingRow[] = [
      { source: '', column: 'a', datatype: '' },
      { source: '$.b', column: '', datatype: '' }, // no column → dropped
    ];
    expect(JSON.parse(serializeMapping(rows, 'json'))).toEqual([
      { Column: 'a', Properties: { Path: '$.a' } },
    ]);
  });
});
