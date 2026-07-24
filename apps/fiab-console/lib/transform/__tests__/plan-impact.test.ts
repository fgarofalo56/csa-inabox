/**
 * N4 — plan/diff parsing tests.
 *
 * The fixtures below are shaped exactly like what the loom-transform-runner
 * emits: for SQLMesh the projection of a real `Plan` (`context_diff`
 * modified/added/removed + `SnapshotChangeCategory` + `columns_to_types` +
 * missing intervals), for dbt the real manifest state comparison
 * (`target/manifest.json` diff + `catalog.json` column types + `child_map`
 * downstream). The assertions pin the BREAKING classification, since that is the
 * decision an operator acts on before applying.
 */
import { describe, expect, it } from 'vitest';
import {
  diffColumns, parseDbtPlan, parsePlanPayload, parseSqlMeshPlan, parseTableDiff,
  severityFromColumns, severityFromSqlMeshCategory, sortImpactRows, summarize,
} from '../plan-impact';

// ── SQLMesh fixture ─────────────────────────────────────────────────────────
const SQLMESH_PLAN = {
  ok: true,
  engine: 'sqlmesh',
  plan: {
    environment: 'dev',
    hasChanges: true,
    changes: [
      {
        // Directly modified + SQLMesh says BREAKING (a column was dropped).
        model: 'analytics.orders',
        changeType: 'modified',
        category: 'breaking',
        direct: true,
        downstream: ['analytics.order_summary', 'analytics.revenue_daily'],
        columns: { id: 'INT', customer_id: 'INT', amount: 'DECIMAL(18,2)' },
        previousColumns: { id: 'INT', customer_id: 'INT', amount: 'DECIMAL(18,2)', legacy_code: 'VARCHAR(10)' },
      },
      {
        // Indirectly modified — SQLMesh categorizes it INDIRECT_NON_BREAKING.
        model: 'analytics.order_summary',
        changeType: 'modified',
        category: 'indirect_non_breaking',
        direct: false,
        downstream: [],
        columns: { order_id: 'INT', total: 'DECIMAL(18,2)' },
        previousColumns: { order_id: 'INT', total: 'DECIMAL(18,2)' },
      },
      {
        model: 'analytics.customer_tier',
        changeType: 'added',
        category: 'breaking',
        direct: true,
        downstream: [],
        columns: { customer_id: 'INT', tier: 'VARCHAR(20)' },
        previousColumns: {},
      },
      {
        model: 'analytics.legacy_orders',
        changeType: 'removed',
        category: 'breaking',
        direct: true,
        downstream: [],
        columns: {},
        previousColumns: { id: 'INT' },
      },
      {
        // Uncategorized (auto-categorization off) → derive from the columns:
        // a widened type is a type-change ⇒ breaking.
        model: 'analytics.revenue_daily',
        changeType: 'modified',
        category: 'unknown',
        direct: true,
        downstream: ['analytics.exec_dashboard'],
        columns: { day: 'DATE', revenue: 'DECIMAL(38,2)' },
        previousColumns: { day: 'DATE', revenue: 'DECIMAL(18,2)' },
      },
    ],
    backfills: [
      { model: 'analytics.orders', intervals: 12 },
      { model: 'analytics.revenue_daily', intervals: 3 },
    ],
    restatements: [],
  },
};

describe('parseSqlMeshPlan', () => {
  const impact = parseSqlMeshPlan(SQLMESH_PLAN);

  it('normalizes every change into an impact row', () => {
    expect(impact.engine).toBe('sqlmesh');
    expect(impact.environment).toBe('dev');
    expect(impact.hasChanges).toBe(true);
    expect(impact.rows).toHaveLength(5);
  });

  it('reports a newly ADDED model as additive even though SQLMesh categorizes new snapshots BREAKING', () => {
    // SQLMesh's BREAKING on a brand-new snapshot means "must be built", not
    // "breaks consumers" — a model with no prior contract cannot break one.
    const added = impact.rows.find((r) => r.model === 'analytics.customer_tier')!;
    expect(added.changeType).toBe('added');
    expect(added.engineCategory).toBe('breaking');
    expect(added.severity).toBe('non-breaking');
  });

  it('honors the engine category verbatim (breaking + indirect non-breaking)', () => {
    const orders = impact.rows.find((r) => r.model === 'analytics.orders')!;
    expect(orders.severity).toBe('breaking');
    expect(orders.engineCategory).toBe('breaking');
    expect(orders.direct).toBe(true);
    expect(orders.downstreamCount).toBe(2);

    const summary = impact.rows.find((r) => r.model === 'analytics.order_summary')!;
    expect(summary.severity).toBe('non-breaking');
    expect(summary.direct).toBe(false);
  });

  it('derives breaking from a retyped column when the snapshot is uncategorized', () => {
    const revenue = impact.rows.find((r) => r.model === 'analytics.revenue_daily')!;
    expect(revenue.engineCategory).toBe('unknown');
    expect(revenue.severity).toBe('breaking');
    expect(revenue.columns).toEqual([
      { name: 'revenue', change: 'type-changed', fromType: 'DECIMAL(18,2)', toType: 'DECIMAL(38,2)' },
    ]);
  });

  it('reports the removed column on the breaking model', () => {
    const orders = impact.rows.find((r) => r.model === 'analytics.orders')!;
    expect(orders.columns).toEqual([
      { name: 'legacy_code', change: 'removed', fromType: 'VARCHAR(10)' },
    ]);
  });

  it('carries the backfill intervals per model', () => {
    expect(impact.rows.find((r) => r.model === 'analytics.orders')!.backfillIntervals).toBe(12);
    expect(impact.summary.backfillIntervals).toBe(15);
  });

  it('summarizes counts + the distinct downstream blast radius', () => {
    expect(impact.summary).toMatchObject({
      added: 1, modified: 3, removed: 1,
      // orders (stated breaking) + revenue_daily (derived breaking) +
      // legacy_orders (removed) = 3; order_summary + customer_tier are additive.
      breaking: 3, nonBreaking: 2, forwardOnly: 0, metadata: 0,
    });
    // orders → 2 downstream, revenue_daily → 1, deduped across rows.
    expect(impact.summary.downstreamImpacted).toBe(3);
  });

  it('sorts breaking rows first (removed before modified before added)', () => {
    expect(impact.rows[0].severity).toBe('breaking');
    expect(impact.rows[0].model).toBe('analytics.legacy_orders'); // removed sorts first
    expect(impact.rows[impact.rows.length - 1].severity).toBe('non-breaking');
  });
});

// ── dbt fixture ─────────────────────────────────────────────────────────────
const DBT_PLAN = {
  ok: true,
  engine: 'dbt',
  plan: {
    hasState: true,
    added: [
      {
        uniqueId: 'model.loom.dim_customer',
        name: 'dim_customer',
        schema: 'analytics',
        materialized: 'table',
        downstream: ['model.loom.fct_orders'],
        columns: { customer_id: 'int', name: 'varchar' },
      },
    ],
    modified: [
      {
        // Column REMOVED → breaking regardless of what dbt thinks (dbt has no
        // categorization at all; the contract is the only signal).
        uniqueId: 'model.loom.fct_orders',
        name: 'fct_orders',
        schema: 'analytics',
        downstream: ['model.loom.rpt_revenue', 'test.loom.not_null_fct_orders_id'],
        columns: { order_id: 'int', amount: 'numeric' },
        previousColumns: { order_id: 'int', amount: 'numeric', discount_code: 'varchar' },
        sqlChanged: true,
        configChanged: false,
      },
      {
        // Only an ADDED column → additive.
        uniqueId: 'model.loom.stg_payments',
        name: 'stg_payments',
        schema: 'analytics',
        downstream: [],
        columns: { payment_id: 'int', method: 'varchar' },
        previousColumns: { payment_id: 'int' },
        sqlChanged: true,
        configChanged: false,
      },
      {
        // Config/metadata-only change, no column movement → metadata.
        uniqueId: 'model.loom.stg_customers',
        name: 'stg_customers',
        schema: 'analytics',
        downstream: [],
        columns: { customer_id: 'int' },
        previousColumns: { customer_id: 'int' },
        sqlChanged: false,
        configChanged: true,
      },
    ],
    removed: [
      {
        uniqueId: 'model.loom.legacy_report',
        name: 'legacy_report',
        schema: 'analytics',
        previousColumns: { id: 'int' },
      },
    ],
  },
};

describe('parseDbtPlan', () => {
  const impact = parseDbtPlan(DBT_PLAN, 'prod');

  it('classifies a removed column as breaking', () => {
    const fct = impact.rows.find((r) => r.model === 'analytics.fct_orders')!;
    expect(fct.severity).toBe('breaking');
    expect(fct.columns).toEqual([
      { name: 'discount_code', change: 'removed', fromType: 'varchar' },
    ]);
  });

  it('classifies an added-column-only change as additive', () => {
    const stg = impact.rows.find((r) => r.model === 'analytics.stg_payments')!;
    expect(stg.severity).toBe('non-breaking');
    expect(stg.columns).toEqual([{ name: 'method', change: 'added', toType: 'varchar' }]);
  });

  it('classifies a config-only change with no column movement as metadata', () => {
    const stg = impact.rows.find((r) => r.model === 'analytics.stg_customers')!;
    expect(stg.severity).toBe('metadata');
    expect(stg.columns).toEqual([]);
  });

  it('treats a removed model as breaking and a new model as additive', () => {
    expect(impact.rows.find((r) => r.model === 'analytics.legacy_report')!.severity).toBe('breaking');
    expect(impact.rows.find((r) => r.model === 'analytics.dim_customer')!.severity).toBe('non-breaking');
  });

  it('shortens child_map unique ids to model names for the downstream list', () => {
    const fct = impact.rows.find((r) => r.model === 'analytics.fct_orders')!;
    expect(fct.downstream).toEqual(['rpt_revenue', 'not_null_fct_orders_id']);
    expect(fct.downstreamCount).toBe(2);
  });

  it('carries the environment + summary', () => {
    expect(impact.engine).toBe('dbt');
    expect(impact.environment).toBe('prod');
    expect(impact.summary).toMatchObject({ added: 1, modified: 3, removed: 1, breaking: 2 });
    expect(impact.noDeployedState).toBe(false);
  });

  it('flags the first-plan case when there is no deployed-state manifest', () => {
    const first = parseDbtPlan({ engine: 'dbt', plan: { hasState: false, added: [], modified: [], removed: [] } });
    expect(first.noDeployedState).toBe(true);
    expect(first.hasChanges).toBe(false);
  });
});

describe('parsePlanPayload dispatch', () => {
  it('follows the engine the runner declares, not the requested backend', () => {
    expect(parsePlanPayload(SQLMESH_PLAN, 'dbt').engine).toBe('sqlmesh');
    expect(parsePlanPayload(DBT_PLAN, 'sqlmesh').engine).toBe('dbt');
  });

  it('falls back to the requested backend when the runner declares nothing', () => {
    expect(parsePlanPayload({ plan: { changes: [] } }, 'sqlmesh').engine).toBe('sqlmesh');
    expect(parsePlanPayload({ plan: {} }, 'dbt').engine).toBe('dbt');
  });
});

describe('classification primitives', () => {
  it('maps every SQLMesh change category', () => {
    expect(severityFromSqlMeshCategory('BREAKING')).toBe('breaking');
    expect(severityFromSqlMeshCategory('indirect_breaking')).toBe('breaking');
    expect(severityFromSqlMeshCategory('NON_BREAKING')).toBe('non-breaking');
    expect(severityFromSqlMeshCategory('indirect_non_breaking')).toBe('non-breaking');
    expect(severityFromSqlMeshCategory('forward_only')).toBe('forward-only');
    expect(severityFromSqlMeshCategory('metadata')).toBe('metadata');
    expect(severityFromSqlMeshCategory('something-else')).toBeNull();
    expect(severityFromSqlMeshCategory(undefined)).toBeNull();
  });

  it('never claims "all columns added" when there is no previous column metadata', () => {
    // Both sides empty → no column rows at all (an honest "unknown", not a lie).
    expect(diffColumns({}, {})).toEqual([]);
  });

  it('treats type comparison as case/whitespace insensitive', () => {
    expect(diffColumns({ a: 'INT' }, { a: 'int' })).toEqual([]);
    expect(diffColumns({ a: 'DECIMAL(18, 2)' }, { a: 'decimal(18, 2)' })).toEqual([]);
  });

  it('derives severity from the column contract', () => {
    expect(severityFromColumns('removed', [], false)).toBe('breaking');
    expect(severityFromColumns('added', [], false)).toBe('non-breaking');
    expect(severityFromColumns('modified', [{ name: 'x', change: 'removed' }], true)).toBe('breaking');
    expect(severityFromColumns('modified', [{ name: 'x', change: 'type-changed' }], true)).toBe('breaking');
    expect(severityFromColumns('modified', [{ name: 'x', change: 'added' }], true)).toBe('non-breaking');
    expect(severityFromColumns('modified', [], true)).toBe('non-breaking');
    expect(severityFromColumns('modified', [], false)).toBe('metadata');
  });

  it('summarize + sort are stable on an empty plan', () => {
    expect(summarize([])).toMatchObject({ added: 0, breaking: 0, downstreamImpacted: 0 });
    expect(sortImpactRows([])).toEqual([]);
  });
});

describe('parseTableDiff', () => {
  it('normalizes a SQLMesh table_diff into column impacts + row counts', () => {
    const diffs = parseTableDiff({
      ok: true,
      diffs: [{
        model: 'analytics.orders',
        source: 'dev',
        target: 'prod',
        columnsAdded: { tier: 'VARCHAR(20)' },
        columnsRemoved: { legacy_code: 'VARCHAR(10)' },
        columnsModified: { amount: ['DECIMAL(18,2)', 'DECIMAL(38,2)'] },
        sourceRows: 1200,
        targetRows: 1180,
        joinCount: 1175,
      }],
    });
    expect(diffs).toHaveLength(1);
    expect(diffs[0].columns).toEqual([
      { name: 'tier', change: 'added', toType: 'VARCHAR(20)' },
      { name: 'legacy_code', change: 'removed', fromType: 'VARCHAR(10)' },
      { name: 'amount', change: 'type-changed', fromType: 'DECIMAL(18,2)', toType: 'DECIMAL(38,2)' },
    ]);
    expect(diffs[0].sourceRows).toBe(1200);
    expect(diffs[0].joinCount).toBe(1175);
  });

  it('returns [] for a payload with no diffs (never a fabricated row)', () => {
    expect(parseTableDiff({ ok: true })).toEqual([]);
    expect(parseTableDiff(null)).toEqual([]);
  });
});
