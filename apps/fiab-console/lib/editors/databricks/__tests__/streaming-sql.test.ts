/**
 * Pure-builder acceptance for the streaming-table / materialized-view SQL
 * builders (Wave 10, DBX-7). No DOM — exercises DDL generation, schedule
 * formatting, refresh + alter statements, validation, and injection-safe
 * quoting.
 */
import { describe, it, expect } from 'vitest';
import {
  buildCreateStreamingTable, buildCreateMaterializedView,
  buildRefreshStatement, buildAlterSchedule,
  formatSchedule, validateSchedule, validateStreamingObject,
  quoteQualified, quoteFullName,
  type CreateStreamingTableSpec, type CreateMaterializedViewSpec, type RefreshSchedule,
} from '../streaming-sql';

describe('buildCreateStreamingTable', () => {
  it('auto-generates a STREAM read_files SELECT from a files source', () => {
    const spec: CreateStreamingTableSpec = {
      target: { catalog: 'main', schema: 'bronze', name: 'events_raw' },
      source: { kind: 'files', path: 'abfss://raw@acct.dfs.core.windows.net/events/', fileFormat: 'csv' },
    };
    const sql = buildCreateStreamingTable(spec);
    expect(sql).toContain('CREATE OR REFRESH STREAMING TABLE `main`.`bronze`.`events_raw`');
    expect(sql).toContain("AS SELECT * FROM STREAM read_files('abfss://raw@acct.dfs.core.windows.net/events/', format => 'csv')");
    expect(sql.endsWith(';')).toBe(true);
  });

  it('streams a table source and honours an explicit query + expectations + schedule', () => {
    const spec: CreateStreamingTableSpec = {
      target: { name: 'silver' },
      source: { kind: 'table', tableName: 'main.bronze.events' },
      query: 'SELECT id, ts FROM STREAM main.bronze.events WHERE id IS NOT NULL',
      expectations: [{ name: 'has_id', condition: 'id IS NOT NULL', action: 'drop' }],
      schedule: { kind: 'every', everyNumber: 6, everyUnit: 'HOURS' },
      comment: 'silver layer',
    };
    const sql = buildCreateStreamingTable(spec);
    expect(sql).toContain('CONSTRAINT `has_id` EXPECT (id IS NOT NULL) ON VIOLATION DROP ROW');
    expect(sql).toContain('SCHEDULE EVERY 6 HOURS');
    expect(sql).toContain("COMMENT 'silver layer'");
    expect(sql).toContain('AS SELECT id, ts FROM STREAM main.bronze.events WHERE id IS NOT NULL');
  });
});

describe('buildCreateMaterializedView', () => {
  it('emits CREATE OR REPLACE MATERIALIZED VIEW with a CRON schedule', () => {
    const spec: CreateMaterializedViewSpec = {
      target: { catalog: 'main', schema: 'gold', name: 'daily' },
      query: 'SELECT day, count(*) AS n FROM main.silver.events GROUP BY day',
      schedule: { kind: 'cron', cron: '0 0 3 * * ?', timezone: 'UTC' },
    };
    const sql = buildCreateMaterializedView(spec);
    expect(sql).toContain('CREATE OR REPLACE MATERIALIZED VIEW `main`.`gold`.`daily`');
    expect(sql).toContain("SCHEDULE CRON '0 0 3 * * ?' AT TIME ZONE 'UTC'");
    expect(sql).toContain('AS SELECT day, count(*) AS n FROM main.silver.events GROUP BY day');
  });
});

describe('formatSchedule', () => {
  it('returns empty for manual', () => {
    expect(formatSchedule({ kind: 'manual' })).toBe('');
    expect(formatSchedule(undefined)).toBe('');
  });
  it('formats EVERY and CRON', () => {
    expect(formatSchedule({ kind: 'every', everyNumber: 2, everyUnit: 'DAYS' })).toBe('SCHEDULE EVERY 2 DAYS');
    expect(formatSchedule({ kind: 'cron', cron: '0 */15 * * * ?' })).toBe("SCHEDULE CRON '0 */15 * * * ?'");
  });
  it('escapes a single quote in the cron literal (injection-safe)', () => {
    expect(formatSchedule({ kind: 'cron', cron: "x' OR '1'='1" })).toContain("CRON 'x'' OR ''1''=''1'");
  });
});

describe('validateSchedule', () => {
  it('bounds EVERY intervals per unit', () => {
    expect(validateSchedule({ kind: 'every', everyNumber: 73, everyUnit: 'HOURS' })).not.toEqual([]);
    expect(validateSchedule({ kind: 'every', everyNumber: 9, everyUnit: 'WEEKS' })).not.toEqual([]);
    expect(validateSchedule({ kind: 'every', everyNumber: 6, everyUnit: 'HOURS' })).toEqual([]);
  });
  it('requires a 6-field CRON', () => {
    expect(validateSchedule({ kind: 'cron', cron: '0 0 * * *' })).not.toEqual([]);
    expect(validateSchedule({ kind: 'cron', cron: '0 0 3 * * ?' })).toEqual([]);
  });
});

describe('validateStreamingObject', () => {
  it('requires a valid name + a source or query for a streaming table', () => {
    const problems = validateStreamingObject('streaming_table', {
      target: { name: '' },
      source: { kind: 'files' },
    } as CreateStreamingTableSpec);
    expect(problems.some((p) => /Name is required/.test(p))).toBe(true);
    expect(problems.some((p) => /File source needs a path/.test(p))).toBe(true);
  });
  it('requires a query for a materialized view', () => {
    const problems = validateStreamingObject('materialized_view', {
      target: { name: 'x' }, query: '',
    } as CreateMaterializedViewSpec);
    expect(problems.some((p) => /requires a query/.test(p))).toBe(true);
  });
});

describe('refresh + alter schedule', () => {
  it('builds REFRESH statements with and without FULL', () => {
    expect(buildRefreshStatement('streaming_table', 'main.bronze.events')).toBe('REFRESH STREAMING TABLE `main`.`bronze`.`events`;');
    expect(buildRefreshStatement('materialized_view', 'main.gold.daily', true)).toBe('REFRESH MATERIALIZED VIEW `main`.`gold`.`daily` FULL;');
  });
  it('builds ADD SCHEDULE and DROP SCHEDULE', () => {
    const add = buildAlterSchedule('materialized_view', 'main.gold.daily', { kind: 'every', everyNumber: 1, everyUnit: 'DAY' });
    expect(add).toBe('ALTER MATERIALIZED VIEW `main`.`gold`.`daily` ADD SCHEDULE EVERY 1 DAY;');
    const drop = buildAlterSchedule('streaming_table', 'main.bronze.events', { kind: 'manual' } as RefreshSchedule);
    expect(drop).toBe('ALTER STREAMING TABLE `main`.`bronze`.`events` DROP SCHEDULE;');
  });
});

describe('quoting', () => {
  it('drops empty parts and back-tick quotes each identifier', () => {
    expect(quoteQualified({ name: 'events' })).toBe('`events`');
    expect(quoteQualified({ catalog: 'main', schema: 'bronze', name: 'events' })).toBe('`main`.`bronze`.`events`');
    expect(quoteFullName('a`b.c')).toBe('`a``b`.`c`');
  });
});
