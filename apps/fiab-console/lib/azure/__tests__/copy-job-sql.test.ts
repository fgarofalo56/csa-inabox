/**
 * Second-order SQL injection regression suite for the copy-job pipeline payload.
 *
 * The route does not run this SQL locally — it ships it inside an ADF pipeline
 * definition, and ADF executes it against the linked services, including the
 * SHARED `loom-control` watermark database as the FACTORY'S managed identity.
 * Every test below encodes a payload that used to escape its context.
 */
import { describe, it, expect } from 'vitest';
import {
  CopyJobSqlError,
  buildBoundedSelectSql,
  buildCdcNetChangesSql,
  buildFullSelectSql,
  buildMaxWatermarkSql,
  buildTruncateSql,
  buildWatermarkLookupSql,
  copyJobCaptureInstance,
} from '../copy-job-sql';

const OLD_EXPR = "@{activity('LookupOldWatermark').output.resultSets[0].rows[0].last_value}";
const NEW_EXPR = "@{activity('LookupNewWatermark').output.resultSets[0].rows[0].new_value}";

describe('copy-job SQL builders — literal escaping (shared control DB)', () => {
  it('escapes a quote-breakout sourceName instead of emitting a second statement', () => {
    // Pre-fix this produced:
    //   ... WHERE source = 'x'; DROP TABLE dbo.copy_watermark; --'
    // executed on loom-control as the ADF MI.
    const sql = buildWatermarkLookupSql("x'; DROP TABLE dbo.copy_watermark; --", 'dbo.orders', 'last_value');
    expect(sql).toContain("N'x''; DROP TABLE dbo.copy_watermark; --'");
    // The closing quote of the literal is never reached early: exactly two
    // N'' literals, and no statement terminator outside them.
    expect(sql.match(/N'/g)).toHaveLength(2);
    expect(sql.replace(/N'(?:[^']|'')*'/g, '')).not.toContain(';');
  });

  it('escapes a quote-breakout sourceTable in the LSN lookup too', () => {
    const sql = buildWatermarkLookupSql('src', "o' OR 1=1 --", 'last_lsn_hex');
    expect(sql).toContain("N'o'' OR 1=1 --'");
    expect(sql).toContain('last_value AS last_lsn_hex');
  });

  it('handles an apostrophe in a legitimate name without corrupting it', () => {
    expect(buildWatermarkLookupSql("O'Brien feed", 'dbo.t', 'last_value')).toContain("N'O''Brien feed'");
  });
});

describe('copy-job SQL builders — identifier validation', () => {
  it('rejects a statement-terminator destination table (sink pre-copy script)', () => {
    // Pre-fix: preCopyScript = "TRUNCATE TABLE x; DROP TABLE dbo.customers; --"
    // ran on the SINK database before the copy.
    expect(() => buildTruncateSql('x; DROP TABLE dbo.customers; --')).toThrow(CopyJobSqlError);
  });

  it('rejects a bracket-breakout watermark column', () => {
    expect(() => buildMaxWatermarkSql('id]) AS x FROM sys.tables --', 'dbo.t')).toThrow(CopyJobSqlError);
  });

  it('rejects a UNION-injecting source table', () => {
    expect(() => buildFullSelectSql('t UNION ALL SELECT * FROM sys.sql_logins')).toThrow(CopyJobSqlError);
  });

  it('brackets a legitimate schema-qualified table and defaults to dbo', () => {
    expect(buildTruncateSql('sales.orders')).toBe('TRUNCATE TABLE [sales].[orders]');
    expect(buildFullSelectSql('orders')).toBe('SELECT * FROM [dbo].[orders]');
  });

  it('rejects a three-part name rather than silently mis-splitting it', () => {
    expect(() => buildFullSelectSql('db.sales.orders')).toThrow(/at most one dot/);
  });

  it('brackets both identifiers in the bounded incremental read', () => {
    const sql = buildBoundedSelectSql('sales.orders', 'modified_at', OLD_EXPR, NEW_EXPR);
    expect(sql).toContain('FROM [sales].[orders]');
    expect(sql).toContain('WHERE [modified_at] >');
    expect(sql).toContain(OLD_EXPR);
  });

  it('refuses to interpolate anything that is not an ADF activity-output expression', () => {
    expect(() => buildBoundedSelectSql('dbo.t', 'ts', "' OR 1=1 --", NEW_EXPR)).toThrow(
      /only ADF activity-output expressions/,
    );
  });
});

describe('copy-job SQL builders — CDC capture instance', () => {
  it('rejects a capture instance that would break out of the object name', () => {
    // Spliced into `cdc.fn_cdc_get_net_changes_<inst>` where bracketing cannot help.
    expect(() => copyJobCaptureInstance("dbo_t(@a,@b,'all'); DROP TABLE x; --")).toThrow(CopyJobSqlError);
    expect(() => buildCdcNetChangesSql("x'); SELECT 1 --", OLD_EXPR, NEW_EXPR)).toThrow(CopyJobSqlError);
  });

  it('accepts the sys.sp_cdc_enable_table default grammar', () => {
    const sql = buildCdcNetChangesSql('dbo_orders', OLD_EXPR, NEW_EXPR);
    expect(sql).toContain('cdc.fn_cdc_get_net_changes_dbo_orders(@from_lsn, @to_lsn,');
    expect(sql).toContain("sys.fn_cdc_get_min_lsn('dbo_orders')");
  });

  it('rejects a hyphen/space, which brackets would have hidden elsewhere', () => {
    expect(() => copyJobCaptureInstance('dbo orders')).toThrow(CopyJobSqlError);
  });
});
