import { describe, it, expect } from 'vitest';
import {
  validateLoadTableName,
  suggestTableName,
  abfssUrl,
  readExprFor,
  buildLoadToTablePySpark,
  parseLoadRowCount,
  SUPPORTED_LOAD_FORMATS,
} from '../load-to-table-codegen';

describe('validateLoadTableName', () => {
  it('accepts valid names', () => {
    expect(validateLoadTableName('sales')).toBeNull();
    expect(validateLoadTableName('sales_2024')).toBeNull();
    expect(validateLoadTableName('t1')).toBeNull();
  });
  it('rejects invalid names', () => {
    expect(validateLoadTableName('')).toMatch(/required/i);
    expect(validateLoadTableName('1sales')).toBeTruthy(); // must start with a letter
    expect(validateLoadTableName('Sales')).toBeTruthy(); // uppercase
    expect(validateLoadTableName('my-table')).toBeTruthy(); // dash
    expect(validateLoadTableName('a'.repeat(65))).toBeTruthy(); // too long
  });
});

describe('suggestTableName', () => {
  it('strips extension and slugifies', () => {
    expect(suggestTableName('Files/Sales 2024.csv')).toBe('sales_2024');
    expect(suggestTableName('data/events.parquet')).toBe('events');
  });
  it('prefixes when starting with a non-letter', () => {
    expect(suggestTableName('2024-data.json')).toMatch(/^t_2024_data$/);
  });
  it('falls back when empty', () => {
    expect(suggestTableName('___.csv')).toBe('loaded_table');
  });
});

describe('abfssUrl', () => {
  it('builds an abfss url and strips leading slashes', () => {
    expect(abfssUrl('acct', 'bronze', '/Files/x.csv')).toBe(
      'abfss://bronze@acct.dfs.core.windows.net/Files/x.csv',
    );
  });
});

describe('readExprFor', () => {
  it('uses header+inferSchema for csv', () => {
    const e = readExprFor('csv', 'abfss://b@a.dfs.core.windows.net/x.csv');
    expect(e).toContain('.option("header", "true")');
    expect(e).toContain('.option("inferSchema", "true")');
    expect(e).toContain('.csv(');
  });
  it('uses multiline for json and direct readers for parquet/orc/avro/text', () => {
    expect(readExprFor('json', 'p')).toContain('.option("multiline", "true")');
    expect(readExprFor('parquet', 'p')).toContain('.parquet(');
    expect(readExprFor('orc', 'p')).toContain('.orc(');
    expect(readExprFor('avro', 'p')).toContain('format("avro")');
    expect(readExprFor('text', 'p')).toContain('.text(');
  });
});

describe('buildLoadToTablePySpark', () => {
  it('emits a saveAsTable job writing to the container Tables/ path', () => {
    const code = buildLoadToTablePySpark({
      container: 'bronze',
      account: 'loomstg',
      path: 'Files/sales.csv',
      tableName: 'sales',
      writeMode: 'overwrite',
      format: 'csv',
    });
    expect(code).toContain('abfss://bronze@loomstg.dfs.core.windows.net/Files/sales.csv');
    expect(code).toContain('abfss://bronze@loomstg.dfs.core.windows.net/Tables/sales');
    expect(code).toContain('.format("delta")');
    expect(code).toContain('.mode("overwrite")');
    expect(code).toContain('.saveAsTable("sales")');
    expect(code).toContain('LOOM_LOAD_RESULT rows=');
    // No Fabric host anywhere in generated code.
    expect(code).not.toContain('fabric');
    expect(code).not.toContain('onelake');
  });
  it('honors append mode', () => {
    const code = buildLoadToTablePySpark({
      container: 'silver', account: 'a', path: 'Files/e.json', tableName: 'e', writeMode: 'append', format: 'json',
    });
    expect(code).toContain('.mode("append")');
  });
  it('throws on invalid table name', () => {
    expect(() => buildLoadToTablePySpark({
      container: 'bronze', account: 'a', path: 'x.csv', tableName: 'Bad-Name', writeMode: 'overwrite', format: 'csv',
    })).toThrow();
  });
  it('covers every supported format without throwing', () => {
    for (const format of SUPPORTED_LOAD_FORMATS) {
      expect(() => buildLoadToTablePySpark({
        container: 'gold', account: 'a', path: `x.${format}`, tableName: 'tbl', writeMode: 'overwrite', format,
      })).not.toThrow();
    }
  });
});

describe('parseLoadRowCount', () => {
  it('extracts the row count from the result marker', () => {
    expect(parseLoadRowCount('LOOM_LOAD_RESULT rows=1234 table=sales')).toBe(1234);
  });
  it('returns null when absent', () => {
    expect(parseLoadRowCount(undefined)).toBeNull();
    expect(parseLoadRowCount('some other output')).toBeNull();
  });
});
