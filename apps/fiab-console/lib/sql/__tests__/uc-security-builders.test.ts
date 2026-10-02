import { describe, it, expect } from 'vitest';
import {
  btick,
  sqlString,
  sanitizeFnPart,
  UcBuildError,
  buildUcColumnMask,
  buildUcDropColumnMask,
  buildUcRowFilter,
  buildUcDropRowFilter,
  ucListColumnMasks,
  ucListRowFilters,
  ucListSchemas,
  ucListTablesInSchema,
  ucListColumnsForTable,
  ucSelectSample,
} from '../uc-security-builders';

describe('btick', () => {
  it('back-tick-quotes a plain identifier', () => {
    expect(btick('main')).toBe('`main`');
  });
  it('doubles embedded back-ticks', () => {
    expect(btick('ev`il')).toBe('`ev``il`');
  });
  it('rejects empty / oversized identifiers', () => {
    expect(() => btick('')).toThrow(UcBuildError);
    expect(() => btick('x'.repeat(256))).toThrow(UcBuildError);
  });
});

describe('sqlString', () => {
  it('escapes single quotes by the Spark SQL rule', () => {
    // Breaks under T-SQL doubling: 'a''b'.
    expect(sqlString("a'b")).toBe("'a\\'b'");
  });
  it('escapes the backslash before the quote', () => {
    // Breaks if the backslash is not escaped: 'C:\' leaves the literal open.
    expect(sqlString('C:\\')).toBe("'C:\\\\'");
  });
  it('carries a control character instead of refusing it', () => {
    // Breaks if sqlString throws on a control character, emits NUL raw, or
    // encodes the other controls (Spark takes any Unicode character raw; NUL
    // is written as the documented \0 escape).
    expect(sqlString('a\u0000b')).toBe("'a\\0b'");
    expect(sqlString('a\u001bb\u000c')).toBe("'a\u001bb\u000c'");
  });
});

describe('sanitizeFnPart', () => {
  it('replaces unsafe chars with underscore', () => {
    expect(sanitizeFnPart('ssn-col.1')).toBe('ssn_col_1');
  });
  it('collapses repeats and trims edges', () => {
    expect(sanitizeFnPart('--a__b--')).toBe('a_b');
  });
  it('throws when nothing safe remains', () => {
    expect(() => sanitizeFnPart('---')).toThrow(UcBuildError);
  });
});

describe('buildUcColumnMask', () => {
  it('builds a NULL mask for any column type', () => {
    const r = buildUcColumnMask({
      catalog: 'main', schema: 'sales', tableName: 'employees',
      columnName: 'salary', columnType: 'BIGINT',
      maskMode: 'null', allowedGroup: 'hr-admins',
    });
    expect(r.functionSql).toContain('CREATE OR REPLACE FUNCTION `main`.`sales`.`loom_mask_salary`(val BIGINT)');
    expect(r.functionSql).toContain("IS_ACCOUNT_GROUP_MEMBER('hr-admins')");
    expect(r.functionSql).toContain('ELSE NULL');
    expect(r.alterSql).toBe('ALTER TABLE `main`.`sales`.`employees`\nALTER COLUMN `salary` SET MASK `main`.`sales`.`loom_mask_salary`;');
    expect(r.combined).toContain(r.functionSql);
    expect(r.combined).toContain(r.alterSql);
  });

  it('builds a literal mask for a STRING column and escapes the literal', () => {
    const r = buildUcColumnMask({
      catalog: 'main', schema: 'sales', tableName: 'employees',
      columnName: 'ssn', columnType: 'STRING',
      maskSchema: 'security', maskMode: 'literal', maskLiteral: "***'**", allowedGroup: 'hr',
    });
    expect(r.functionName).toBe('`main`.`security`.`loom_mask_ssn`');
    // Breaks under doubling: ELSE '***''**'.
    expect(r.functionSql).toContain("ELSE '***\\'**'");
    expect(r.alterSql).toContain('SET MASK `main`.`security`.`loom_mask_ssn`');
  });

  it('rejects a literal mask on a non-STRING column', () => {
    expect(() => buildUcColumnMask({
      catalog: 'main', schema: 'sales', tableName: 't',
      columnName: 'amount', columnType: 'DECIMAL(10,2)',
      maskMode: 'literal', maskLiteral: 'x', allowedGroup: 'g',
    })).toThrow(UcBuildError);
  });

  it('rejects a missing allowed group', () => {
    expect(() => buildUcColumnMask({
      catalog: 'main', schema: 's', tableName: 't',
      columnName: 'c', columnType: 'STRING', maskMode: 'null', allowedGroup: '   ',
    })).toThrow(UcBuildError);
  });

  it('rejects a column type that is not a single type name', () => {
    expect(() => buildUcColumnMask({
      catalog: 'main', schema: 's', tableName: 't',
      columnName: 'c', columnType: 'STRING; DROP TABLE x',
      maskMode: 'null', allowedGroup: 'g',
    })).toThrow(UcBuildError);
  });
});

describe('buildUcDropColumnMask', () => {
  it('emits ALTER COLUMN … DROP MASK', () => {
    expect(buildUcDropColumnMask({ catalog: 'main', schema: 's', tableName: 't', columnName: 'c' }))
      .toBe('ALTER TABLE `main`.`s`.`t`\nALTER COLUMN `c` DROP MASK;');
  });
});

describe('buildUcRowFilter', () => {
  it('builds a CURRENT_USER row filter and binds it ON the column', () => {
    const r = buildUcRowFilter({
      catalog: 'main', schema: 'sales', tableName: 'orders',
      filterColumn: 'owner_email', filterColumnType: 'STRING',
      adminGroup: 'data-admins',
    });
    expect(r.functionSql).toContain('CREATE OR REPLACE FUNCTION `main`.`sales`.`loom_rowfilter_orders`(owner_col STRING)');
    expect(r.functionSql).toContain('RETURN CURRENT_USER() = owner_col');
    expect(r.functionSql).toContain("IS_ACCOUNT_GROUP_MEMBER('data-admins')");
    expect(r.alterSql).toBe('ALTER TABLE `main`.`sales`.`orders`\nSET ROW FILTER `main`.`sales`.`loom_rowfilter_orders` ON (`owner_email`);');
  });

  it('defaults the filter column type to STRING and schema to the table schema', () => {
    const r = buildUcRowFilter({
      catalog: 'c', schema: 'sch', tableName: 'tbl', filterColumn: 'o', adminGroup: 'admins',
    });
    expect(r.functionSql).toContain('(owner_col STRING)');
    expect(r.functionName).toBe('`c`.`sch`.`loom_rowfilter_tbl`');
  });

  it('rejects a missing admin group', () => {
    expect(() => buildUcRowFilter({
      catalog: 'c', schema: 's', tableName: 't', filterColumn: 'o', adminGroup: '',
    })).toThrow(UcBuildError);
  });
});

describe('buildUcDropRowFilter', () => {
  it('emits DROP ROW FILTER', () => {
    expect(buildUcDropRowFilter({ catalog: 'c', schema: 's', tableName: 't' }))
      .toBe('ALTER TABLE `c`.`s`.`t`\nDROP ROW FILTER;');
  });
});

describe('information_schema reads', () => {
  it('lists column masks from the catalog information_schema', () => {
    const sql = ucListColumnMasks('main');
    expect(sql).toContain('`main`.information_schema.column_masks');
  });
  it('lists row filters', () => {
    expect(ucListRowFilters('main')).toContain('`main`.information_schema.row_filters');
  });
  it('lists schemas, excluding information_schema', () => {
    const sql = ucListSchemas('main');
    expect(sql).toContain('`main`.information_schema.schemata');
    expect(sql).toContain("schema_name <> 'information_schema'");
  });
  it('escapes the schema filter in tables read', () => {
    // Spark SQL rule. Breaks under doubling: 's''x'.
    expect(ucListTablesInSchema('main', "s'x")).toContain("table_schema = 's\\'x'");
  });
  it('escapes schema + table filters in columns read', () => {
    const sql = ucListColumnsForTable('main', 'sales', "o'rders");
    expect(sql).toContain("table_schema = 'sales'");
    // Breaks under doubling: 'o''rders'.
    expect(sql).toContain("table_name = 'o\\'rders'");
  });
  it('clamps the sample LIMIT', () => {
    expect(ucSelectSample('c', 's', 't', 5)).toBe('SELECT * FROM `c`.`s`.`t` LIMIT 5;');
    expect(ucSelectSample('c', 's', 't', 99999)).toContain('LIMIT 10;');
  });
});
