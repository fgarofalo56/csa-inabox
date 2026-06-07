import { describe, it, expect } from 'vitest';
import {
  KUSTO_TYPES, toKustoSchema, parseKustoSchema, validateColumns,
  type ColumnDef,
} from '../column-grid-schema';

describe('KUSTO_TYPES', () => {
  it('exposes the 10 Kusto scalar types', () => {
    expect([...KUSTO_TYPES].sort()).toEqual(
      ['bool', 'datetime', 'decimal', 'dynamic', 'guid', 'int', 'long', 'real', 'string', 'timespan'],
    );
  });
});

describe('toKustoSchema', () => {
  it('serializes columns to a CSL schema string', () => {
    const cols: ColumnDef[] = [
      { name: 'ts', type: 'datetime' },
      { name: 'value', type: 'long' },
    ];
    expect(toKustoSchema(cols)).toBe('ts:datetime, value:long');
  });

  it('trims names and drops blank rows', () => {
    const cols: ColumnDef[] = [
      { name: '  ts  ', type: 'datetime' },
      { name: '', type: 'string' },
    ];
    expect(toKustoSchema(cols)).toBe('ts:datetime');
  });
});

describe('parseKustoSchema', () => {
  it('round-trips with toKustoSchema', () => {
    const schema = 'ts:datetime, tenant:string, value:long';
    expect(toKustoSchema(parseKustoSchema(schema))).toBe(schema);
  });

  it('tolerates whitespace and empty input', () => {
    expect(parseKustoSchema('')).toEqual([]);
    expect(parseKustoSchema('  a : int ,  b:real ')).toEqual([
      { name: 'a', type: 'int' },
      { name: 'b', type: 'real' },
    ]);
  });

  it('falls back unknown types to string', () => {
    expect(parseKustoSchema('x:int64')).toEqual([{ name: 'x', type: 'string' }]);
  });
});

describe('validateColumns', () => {
  it('passes a valid column set', () => {
    expect(validateColumns([{ name: 'ts', type: 'datetime' }])).toBeNull();
  });

  it('requires at least one named column', () => {
    expect(validateColumns([])).toMatch(/at least one/i);
    expect(validateColumns([{ name: '  ', type: 'string' }])).toMatch(/needs a name|at least one/i);
  });

  it('rejects invalid column names', () => {
    expect(validateColumns([{ name: '1bad', type: 'int' }])).toMatch(/not a valid/i);
  });

  it('rejects duplicate names (case-insensitive)', () => {
    expect(validateColumns([
      { name: 'TS', type: 'datetime' },
      { name: 'ts', type: 'long' },
    ])).toMatch(/duplicate/i);
  });
});
