/**
 * Statement-text tests for the call sites switched from the T-SQL literal
 * escape (quote doubling) to the Spark SQL literal escape (backslash rule).
 * One describe per site; each builds the real statement through the module's
 * exported entry point and asserts the literal as it appears in the text.
 *
 * The fixtures carry BOTH a quote and a backslash:
 *   - a quote alone distinguishes the two rules (`\'` vs `''`);
 *   - a backslash distinguishes "escaped the backslash first" from not
 *     (`'C:\\'` vs `'C:\'`, which never closes under the Spark rule).
 *
 * WHAT BREAKS EACH ONE: reverting that site to escapeSqlLiteral (the quote then
 * shows as `''` and the backslash is left single), or to a Spark helper that
 * skips the backslash step. Where a site keeps the T-SQL rule on another
 * dialect branch, a second assertion pins that branch so a blanket switch is
 * caught too.
 */
import { describe, it, expect } from 'vitest';
import { buildCheckSql, type DqCheck } from '@/lib/azure/dq-check-compile';
import { buildCreateMlvSql, type MlvSpec } from '@/lib/azure/materialized-lake-view-model';
import { sparkString } from '@/lib/azure/rls-compiler';
import { buildCreateTableFormatDdl, TableFormatBuildError } from '@/lib/sql/uc-table-format-builders';
import { compileDltSql, emptyDltModel, type DltPipelineModel } from '@/lib/editors/databricks/dlt-spec';
import { buildCreateStreamingTable, buildCreateMaterializedView } from '@/lib/editors/databricks/streaming-sql';
import { resolveTimeTravel, applySqlTableSuffix } from '@/lib/time-machine/time-machine';
import { generateTransformProject } from '@/lib/transform/transform-codegen';
import { emptyTransformProject, type TransformProject } from '@/lib/transform/transform-project-model';
import { foldAppliedStepsToSql } from '@/lib/components/pipeline/dataflow/m-script';
import { buildDatabricksAiSnippet } from '@/lib/editors/components/ai-functions-helper';

/** Input: a quote in the middle and a trailing backslash. */
const V = "a'b\\";
/** V as the inner text of a Spark SQL literal: `a\'b\\`. */
const SPARK = "a\\'b\\\\";
/** V as the inner text of a T-SQL literal: `a''b\`. */
const TSQL = "a''b\\";

describe('fixture arithmetic', () => {
  it('the two escapes differ on V, so every assertion below can tell them apart', () => {
    expect(SPARK).not.toBe(TSQL);
    // Spelled out character by character, independent of any escaping helper.
    expect([...V]).toEqual(['a', "'", 'b', '\\']);
    expect([...SPARK]).toEqual(['a', '\\', "'", 'b', '\\', '\\']);
    expect([...TSQL]).toEqual(['a', "'", "'", 'b', '\\']);
  });
});

describe('dq-check-compile buildCheckSql', () => {
  const check = (p: Partial<DqCheck>): DqCheck => ({ id: 'c1', table: 'orders', rule: 'not_null', severity: 'error', ...p });

  it('spark accepted_values uses the Spark rule; tsql keeps doubling', () => {
    const spark = buildCheckSql('spark', check({ column: 'k', rule: 'accepted_values', value: `${V},z` }), 'REF');
    expect('sql' in spark && spark.sql).toContain(`NOT IN ('${SPARK}', 'z')`);
    const tsql = buildCheckSql('tsql', check({ column: 'k', rule: 'accepted_values', value: `${V},z` }), 'REF');
    expect('sql' in tsql && tsql.sql).toContain(`NOT IN ('${TSQL}', 'z')`);
  });

  it('spark regex uses the Spark rule; duckdb keeps doubling', () => {
    const spark = buildCheckSql('spark', check({ column: 'k', rule: 'regex', value: V }), 'REF');
    expect('sql' in spark && spark.sql).toContain(`RLIKE '${SPARK}')`);
    const duck = buildCheckSql('duckdb', check({ column: 'k', rule: 'regex', value: V }), 'REF');
    expect('sql' in duck && duck.sql).toContain(`regexp_matches(CAST("k" AS VARCHAR), '${TSQL}')`);
  });
});

describe('materialized-lake-view-model buildCreateMlvSql', () => {
  const base: MlvSpec = {
    language: 'sql', container: 'silver', schema: 'silver', viewName: 'v',
    sql: 'SELECT 1 AS x',
  };
  it('COMMENT and TBLPROPERTIES key/value use the Spark rule', () => {
    const ddl = buildCreateMlvSql({ ...base, comment: V, tableProperties: { [V]: V } });
    expect(ddl).toContain(`COMMENT '${SPARK}'`);
    // The key was emitted unescaped before; breaks if either side is not escaped.
    expect(ddl).toContain(`TBLPROPERTIES ('${SPARK}' = '${SPARK}')`);
  });
});

describe('rls-compiler sparkString', () => {
  it('wraps with the Spark rule', () => {
    expect(sparkString(V)).toBe(`'${SPARK}'`);
  });
});

describe('uc-table-format-builders buildCreateTableFormatDdl', () => {
  const base = { catalog: 'c', schema: 's', name: 't', format: 'DELTA' as const };
  it('table and column COMMENT use the Spark rule', () => {
    const sql = buildCreateTableFormatDdl({ ...base, comment: V, columns: [{ name: 'id', type: 'BIGINT', comment: V }] });
    expect(sql).toContain(`\`id\` BIGINT COMMENT '${SPARK}'`);
    expect(sql).toContain(`\nCOMMENT '${SPARK}'`);
  });
  it('a control character is a TableFormatBuildError (400), not an untyped throw', () => {
    // Breaks if lit() stops mapping LiteralEscapeError to the module's error.
    expect(() => buildCreateTableFormatDdl({ ...base, comment: 'a\u0001b', columns: [{ name: 'id', type: 'BIGINT' }] }))
      .toThrow(TableFormatBuildError);
  });
});

describe('dlt-spec compileDltSql', () => {
  it('files source path and dataset COMMENT use the Spark rule', () => {
    const model: DltPipelineModel = {
      ...emptyDltModel('p'),
      nodes: [
        { id: 'src1', kind: 'source', name: 'raw', sourceKind: 'files', path: `abfss://raw@acct.dfs.core.windows.net/${V}`, fileFormat: 'json' },
        { id: 'st1', kind: 'streaming_table', name: 'bronze', comment: V },
      ],
      edges: [{ id: 'e1', source: 'src1', target: 'st1' }],
    };
    const sql = compileDltSql(model);
    expect(sql).toContain(`read_files('abfss://raw@acct.dfs.core.windows.net/${SPARK}', format => 'json')`);
    expect(sql).toContain(`COMMENT '${SPARK}'`);
  });
});

describe('streaming-sql builders', () => {
  it('streaming table: files path, COMMENT and CRON time zone use the Spark rule', () => {
    const sql = buildCreateStreamingTable({
      target: { name: 't' },
      source: { kind: 'files', path: V, fileFormat: 'csv' },
      schedule: { kind: 'cron', cron: '0 0 3 * * ?', timezone: V },
      comment: V,
    });
    expect(sql).toContain(`STREAM read_files('${SPARK}', format => 'csv')`);
    expect(sql).toContain(`COMMENT '${SPARK}'`);
    expect(sql).toContain(`AT TIME ZONE '${SPARK}'`);
  });
  it('materialized view COMMENT uses the Spark rule', () => {
    expect(buildCreateMaterializedView({ target: { name: 'mv' }, query: 'SELECT 1', comment: V }))
      .toContain(`COMMENT '${SPARK}'`);
  });
});

describe('time-machine resolveTimeTravel', () => {
  // Disclosure: every production caller passes a coordinator-normalized ISO
  // string (no quote, no backslash), so on reachable inputs this switch is an
  // EQUIVALENT MUTANT. These assertions pin the per-engine rule at the helper,
  // with an input only a direct caller could supply.
  it('delta uses the Spark rule; synapse-temporal keeps doubling', () => {
    // Through applySqlTableSuffix (the exported consumer), so a resolution that
    // came back unsupported also fails: the bare `t` would be returned.
    expect(applySqlTableSuffix('t', resolveTimeTravel('delta', { kind: 'timestamp', iso: V })))
      .toBe(`t TIMESTAMP AS OF '${SPARK}'`);
    expect(applySqlTableSuffix('t', resolveTimeTravel('synapse-temporal', { kind: 'timestamp', iso: V })))
      .toBe(`t FOR SYSTEM_TIME AS OF '${TSQL}'`);
  });
});

describe('transform-codegen SQLMesh audits', () => {
  const project = (engine: 'databricks' | 'synapse'): TransformProject => ({
    ...emptyTransformProject('p'),
    backend: 'sqlmesh',
    target: { ...emptyTransformProject('p').target, engine },
    models: [{
      name: 'm', layer: 'bronze', materialized: 'view', sql: 'SELECT 1 AS k', refs: [], sources: [],
      tests: [{ column: 'k', type: 'accepted_values', values: [V] }],
    }],
  });
  const audits = (p: TransformProject) =>
    generateTransformProject(p).find((f) => f.path === 'audits/loom_audits.sql')?.content ?? '';

  it('a databricks project uses the Spark rule; a synapse project keeps doubling', () => {
    expect(audits(project('databricks'))).toContain(`WHERE k NOT IN ('${SPARK}');`);
    expect(audits(project('synapse'))).toContain(`WHERE k NOT IN ('${TSQL}');`);
  });
});

describe('m-script foldAppliedStepsToSql', () => {
  // M strings take "" for a quote and treat the backslash as data, so V's
  // M form is "a'b\" (no escaping needed).
  const body = (lit: string) => `let\n    Source = x,\n    Filtered = Table.SelectRows(Source, each [region] = "${lit}")\nin\n    Filtered`;

  it('databricks-sql uses the Spark rule; tsql keeps doubling', () => {
    const dbx = foldAppliedStepsToSql('SELECT * FROM t', body(V), 'databricks-sql');
    expect(dbx.ok && dbx.sql).toContain(`= '${SPARK}'`);
    const tsql = foldAppliedStepsToSql('SELECT * FROM t', body(V), 'tsql');
    expect(tsql.ok && tsql.sql).toContain(`= '${TSQL}'`);
  });

  it('a control character on databricks-sql is an unfoldable step, not a throw', () => {
    // Breaks if the LiteralEscapeError catch in foldAppliedStepsToSql is removed.
    expect(foldAppliedStepsToSql('SELECT * FROM t', body('a\u0001b'), 'databricks-sql'))
      .toEqual({ ok: false, unfoldableStep: 'Filtered' });
  });
});

describe('ai-functions-helper buildDatabricksAiSnippet', () => {
  it('translate target language and classify labels use the Spark rule', () => {
    expect(buildDatabricksAiSnippet({ fn: 'translate', column: 'c', table: 't', targetLang: V }))
      .toContain(`ai_translate(\`c\`, '${SPARK}')`);
    expect(buildDatabricksAiSnippet({ fn: 'classify', column: 'c', table: 't', labels: [V, 'z'] }))
      .toContain(`ARRAY('${SPARK}', 'z')`);
  });
  it('a control character yields an empty snippet rather than throwing in render', () => {
    expect(buildDatabricksAiSnippet({ fn: 'translate', column: 'c', table: 't', targetLang: 'a\u0001b' })).toBe('');
  });
});
