/**
 * Pure-compiler acceptance for the DLT visual-model compiler (Wave 10, DBX-3).
 * No DOM — exercises validation, SQL compilation (streaming tables /
 * materialized views / expectations / auto-generated SELECTs), the create-spec,
 * and the existing-pipeline library graph.
 */
import { describe, it, expect } from 'vitest';
import {
  emptyDltModel, validateDltModel, compileDltSql, compileDltPipelineSpec, parseLibraryGraph,
  upstreamOf, expectationsOf,
  type DltPipelineModel, type DltSourceNode, type DltDatasetNode, type DltExpectationNode,
} from '../dlt-spec';

function modelWith(nodes: DltPipelineModel['nodes'], edges: DltPipelineModel['edges'] = []): DltPipelineModel {
  return { ...emptyDltModel('sales_pipeline'), nodes, edges };
}

const filesSource: DltSourceNode = {
  id: 'src1', kind: 'source', name: 'raw', sourceKind: 'files',
  path: 'abfss://raw@acct.dfs.core.windows.net/events/', fileFormat: 'json',
};
const streamingTable: DltDatasetNode = { id: 'st1', kind: 'streaming_table', name: 'events_bronze' };
const mv: DltDatasetNode = { id: 'mv1', kind: 'materialized_view', name: 'daily_metrics', query: 'SELECT day, count(*) AS n FROM events_bronze GROUP BY day' };

describe('validateDltModel', () => {
  it('rejects an empty model', () => {
    const problems = validateDltModel(emptyDltModel());
    expect(problems.some((p) => /at least one/.test(p))).toBe(true);
  });

  it('rejects a dataset with no query and no wired source', () => {
    const problems = validateDltModel(modelWith([streamingTable]));
    expect(problems.some((p) => /no query and no wired source/.test(p))).toBe(true);
  });

  it('rejects invalid + duplicate dataset names', () => {
    const bad: DltDatasetNode = { id: 'x', kind: 'streaming_table', name: '1bad', query: 'SELECT 1' };
    const dup1: DltDatasetNode = { id: 'a', kind: 'materialized_view', name: 'dup', query: 'SELECT 1' };
    const dup2: DltDatasetNode = { id: 'b', kind: 'materialized_view', name: 'dup', query: 'SELECT 1' };
    const problems = validateDltModel(modelWith([bad, dup1, dup2]));
    expect(problems.some((p) => /not a valid name/.test(p))).toBe(true);
    expect(problems.some((p) => /Duplicate dataset name/.test(p))).toBe(true);
  });

  it('accepts a source → streaming table with a valid path', () => {
    const m = modelWith([filesSource, streamingTable], [{ id: 'e1', source: 'src1', target: 'st1' }]);
    expect(validateDltModel(m)).toEqual([]);
  });

  it('flags an unattached expectation', () => {
    const exp: DltExpectationNode = { id: 'x1', kind: 'expectation', name: 'valid', condition: 'id IS NOT NULL', action: 'drop' };
    const m = modelWith([filesSource, streamingTable, exp], [{ id: 'e1', source: 'src1', target: 'st1' }]);
    const problems = validateDltModel(m);
    expect(problems.some((p) => /not attached to a dataset/.test(p))).toBe(true);
  });
});

describe('graph helpers', () => {
  it('resolves upstream sources and attached expectations', () => {
    const exp: DltExpectationNode = { id: 'x1', kind: 'expectation', name: 'valid', condition: 'id IS NOT NULL', action: 'warn' };
    const m = modelWith([filesSource, streamingTable, exp], [
      { id: 'e1', source: 'src1', target: 'st1' },
      { id: 'e2', source: 'x1', target: 'st1' },
    ]);
    expect(upstreamOf(m, 'st1')).toContain('src1');
    expect(expectationsOf(m, 'st1').map((e) => e.id)).toEqual(['x1']);
  });
});

describe('compileDltSql', () => {
  it('auto-generates a STREAM read_files SELECT for a files source', () => {
    const m = modelWith([filesSource, streamingTable], [{ id: 'e1', source: 'src1', target: 'st1' }]);
    const sql = compileDltSql(m);
    expect(sql).toContain('CREATE OR REFRESH STREAMING TABLE `events_bronze`');
    expect(sql).toContain("FROM STREAM read_files('abfss://raw@acct.dfs.core.windows.net/events/', format => 'json')");
  });

  it('emits CONSTRAINT … EXPECT with the right ON VIOLATION clause', () => {
    const drop: DltExpectationNode = { id: 'x1', kind: 'expectation', name: 'valid_id', condition: 'id IS NOT NULL', action: 'drop' };
    const fail: DltExpectationNode = { id: 'x2', kind: 'expectation', name: 'valid_ts', condition: 'ts IS NOT NULL', action: 'fail' };
    const warn: DltExpectationNode = { id: 'x3', kind: 'expectation', name: 'has_amount', condition: 'amount > 0', action: 'warn' };
    const m = modelWith([filesSource, streamingTable, drop, fail, warn], [
      { id: 'e1', source: 'src1', target: 'st1' },
      { id: 'e2', source: 'x1', target: 'st1' },
      { id: 'e3', source: 'x2', target: 'st1' },
      { id: 'e4', source: 'x3', target: 'st1' },
    ]);
    const sql = compileDltSql(m);
    expect(sql).toContain('CONSTRAINT `valid_id` EXPECT (id IS NOT NULL) ON VIOLATION DROP ROW');
    expect(sql).toContain('CONSTRAINT `valid_ts` EXPECT (ts IS NOT NULL) ON VIOLATION FAIL UPDATE');
    expect(sql).toMatch(/CONSTRAINT `has_amount` EXPECT \(amount > 0\)(?!\s+ON VIOLATION)/);
  });

  it('emits an explicit materialized-view query verbatim (semicolon stripped)', () => {
    const m = modelWith([mv]);
    const sql = compileDltSql(m);
    expect(sql).toContain('CREATE OR REFRESH MATERIALIZED VIEW `daily_metrics`');
    expect(sql).toContain('AS SELECT day, count(*) AS n FROM events_bronze GROUP BY day');
  });

  it('back-tick escapes a malicious dataset name (injection-safe identifiers)', () => {
    const evil: DltDatasetNode = { id: 'z', kind: 'streaming_table', name: 'a`b', query: 'SELECT 1' };
    // name is invalid per validation, but the compiler must still quote safely.
    const sql = compileDltSql(modelWith([evil]));
    expect(sql).toContain('`a``b`');
  });
});

describe('compileDltPipelineSpec', () => {
  it('produces a create-spec with the notebook library + Azure-first defaults', () => {
    const m: DltPipelineModel = {
      ...modelWith([filesSource, streamingTable], [{ id: 'e1', source: 'src1', target: 'st1' }]),
      catalog: 'main', target: 'bronze', serverless: true, photon: true, channel: 'CURRENT',
      configuration: { 'pipelines.reset.allowed': 'true', __proto__: 'evil' } as any,
    };
    const spec = compileDltPipelineSpec(m, '/Shared/loom-dlt/sales_pipeline');
    expect(spec.libraries).toEqual([{ notebook: { path: '/Shared/loom-dlt/sales_pipeline' } }]);
    expect(spec.catalog).toBe('main');
    expect(spec.target).toBe('bronze');
    expect(spec.serverless).toBe(true);
    // __proto__ key is dropped (prototype-pollution safe).
    expect(spec.configuration).toEqual({ 'pipelines.reset.allowed': 'true' });
    expect(Object.getPrototypeOf(spec.configuration)).toBe(Object.prototype);
  });
});

describe('parseLibraryGraph', () => {
  it('derives one node per library wired to a single target node', () => {
    const g = parseLibraryGraph({
      catalog: 'main', target: 'sales',
      libraries: [{ notebook: { path: '/Repos/etl/bronze' } }, { file: { path: '/Workspace/etl/silver.sql' } }],
    });
    expect(g.nodes.filter((n) => n.kind === 'library')).toHaveLength(2);
    expect(g.nodes.find((n) => n.kind === 'target')?.label).toBe('main.sales');
    expect(g.edges).toHaveLength(2);
    expect(g.edges.every((e) => e.target === '__target__')).toBe(true);
  });

  it('handles a spec with no libraries', () => {
    const g = parseLibraryGraph(undefined);
    expect(g.nodes.filter((n) => n.kind === 'library')).toHaveLength(0);
    expect(g.nodes.find((n) => n.kind === 'target')).toBeTruthy();
  });
});
