import { describe, it, expect } from 'vitest';
import {
  buildDiffSql,
  changedCells,
  readParquetList,
  fileUri,
  DataDiffError,
} from '../dq-data-diff';

describe('readParquetList', () => {
  it('builds a read_parquet list literal', () => {
    expect(readParquetList(['abfss://c@a.dfs/x.parquet'])).toBe("read_parquet(['abfss://c@a.dfs/x.parquet'])");
  });
  it('throws on an empty file-set', () => {
    expect(() => readParquetList([])).toThrow(DataDiffError);
  });
  it('refuses a URI with a single quote (injection guard)', () => {
    expect(() => readParquetList(["abfss://c@a.dfs/x'.parquet"])).toThrow(DataDiffError);
  });
});

describe('fileUri', () => {
  it('builds an abfss uri under the account', () => {
    const uri = fileUri('acct', 'gold', 'sales/orders', 'part-0.parquet');
    expect(uri).toContain('abfss://gold@acct.');
    expect(uri).toContain('/sales/orders/part-0.parquet');
  });
  it('rejects a bad container', () => {
    expect(() => fileUri('acct', 'BAD_CONTAINER', 'p', 'f.parquet')).toThrow(DataDiffError);
  });
});

describe('buildDiffSql', () => {
  it('builds a full-outer-join diff with a key and compare columns', () => {
    const sql = buildDiffSql('SCAN_A', 'SCAN_B', ['id'], ['id', 'amount', 'status'], 100);
    expect(sql).toContain('FULL OUTER JOIN');
    expect(sql).toContain('a."id" = b."id"');
    expect(sql).toContain('a."amount" IS DISTINCT FROM b."amount"');
    expect(sql).toContain("'added'");
    expect(sql).toContain("'removed'");
    expect(sql).toContain('LIMIT');
  });

  it('requires at least one key column', () => {
    expect(() => buildDiffSql('A', 'B', [], ['x'], 10)).toThrow(DataDiffError);
  });

  it('rejects an injectable column name', () => {
    expect(() => buildDiffSql('A', 'B', ['id"; DROP'], ['id'], 10)).toThrow(DataDiffError);
  });
});

describe('changedCells', () => {
  const cols = ['id', 'amount', 'status'];
  it('returns only the cells that differ', () => {
    const row = { a_id: 1, b_id: 1, a_amount: 10, b_amount: 20, a_status: 'ok', b_status: 'ok', _diff: 'changed' };
    const cells = changedCells(row, ['id'], cols);
    expect(cells).toEqual([{ column: 'amount', before: 10, after: 20 }]);
  });

  it('treats null and undefined as equal (no false diff)', () => {
    const row = { a_id: 1, b_id: 1, a_amount: null, b_amount: undefined };
    expect(changedCells(row, ['id'], ['id', 'amount'])).toEqual([]);
  });

  it('is number/string tolerant', () => {
    const row = { a_id: 1, b_id: 1, a_amount: 10, b_amount: '10' };
    expect(changedCells(row, ['id'], ['id', 'amount'])).toEqual([]);
  });

  it('flags a real string change', () => {
    const row = { a_id: 1, b_id: 1, a_status: 'ok', b_status: 'void' };
    expect(changedCells(row, ['id'], ['id', 'status'])).toEqual([{ column: 'status', before: 'ok', after: 'void' }]);
  });
});
