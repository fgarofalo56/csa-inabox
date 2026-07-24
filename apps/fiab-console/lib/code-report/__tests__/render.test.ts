/**
 * render.test.ts — the N16 renderer routes each block to the RIGHT execute path.
 *
 * The contract that matters: a `sql loom` block resolves through the N15 metrics
 * path (runGovernedMetricQuery), a raw `sql` block runs on the bound engine, and
 * a per-query gate degrades to an honest error rather than failing the render.
 * We inject BOTH execute seams so the test is pure (no Azure), and mock the
 * heavy server modules so importing render.ts doesn't pull real clients.
 */
import { describe, it, expect, vi } from 'vitest';

// render.ts imports the real N15 run path + Synapse/ADX clients at module load;
// stub them so the import is side-effect-free (the test injects its own deps).
vi.mock('@/lib/metrics/run', () => ({ runGovernedMetricQuery: vi.fn() }));
vi.mock('@/lib/azure/synapse-sql-client', () => ({
  serverlessTarget: vi.fn(() => ({})),
  executeQuery: vi.fn(),
}));
vi.mock('@/lib/azure/kusto-client', () => ({
  executeQuery: vi.fn(),
  defaultDatabase: vi.fn(() => 'db'),
  kustoConfigGate: vi.fn(() => null),
  KustoError: class KustoError extends Error {},
}));

import { renderCodeReport, type RenderDeps, type RawExecOutcome } from '../render';
import { CodeReportParseError } from '../parse';

const actor = { oid: 'oid-1', who: 'u@example.com', tenantId: 'tid-1' };

function okMetric() {
  return {
    ok: true as const,
    result: {
      metric: 'revenue', engine: 'synapse' as const, dialect: 'synapse' as const,
      sql: 'SELECT SUM([amount]) AS [revenue] FROM [dbo].[sales]',
      columns: ['revenue'], rows: [{ revenue: 42 }], rowCount: 1, executionMs: 12, groupBy: [], cached: false,
    },
  };
}

function okRaw(): RawExecOutcome {
  return { ok: true, dialect: 'synapse', columns: ['x'], rows: [{ x: 1 }], rowCount: 1, executionMs: 5 };
}

describe('renderCodeReport — execute-path routing', () => {
  it('routes a metric block through runMetric and a raw block through runRaw', async () => {
    const runMetric = vi.fn().mockResolvedValue(okMetric());
    const runRaw = vi.fn().mockResolvedValue(okRaw());
    const deps: RenderDeps = { runMetric, runRaw };

    const source = [
      '```sql loom rev',
      'metric: revenue',
      'dimensions: order_month',
      'grain: month',
      '```',
      '',
      '```sql raw_q',
      'SELECT x FROM t',
      '```',
    ].join('\n');

    const out = await renderCodeReport({ actor, source, engine: 'synapse' }, deps);

    // Metric block → N15 path with the compiled args.
    expect(runMetric).toHaveBeenCalledTimes(1);
    expect(runMetric).toHaveBeenCalledWith(actor, expect.objectContaining({
      metric: 'revenue', dimensions: ['order_month'], grain: 'month', engine: 'synapse',
    }));
    // Raw block → engine path with the bound engine + verbatim sql.
    expect(runRaw).toHaveBeenCalledTimes(1);
    expect(runRaw).toHaveBeenCalledWith('synapse', 'SELECT x FROM t');

    const rev = out.results['rev'];
    const raw = out.results['raw_q'];
    expect(rev.ok && rev.kind === 'metric' && rev.rowCount).toBe(1);
    expect(raw.ok && raw.kind === 'raw' && raw.rows[0]).toEqual({ x: 1 });
    expect(out.counts).toMatchObject({ total: 2, metric: 1, raw: 1, ok: 2, failed: 0 });
  });

  it('honors a per-block engine override for a metric block', async () => {
    const runMetric = vi.fn().mockResolvedValue(okMetric());
    const runRaw = vi.fn();
    const source = ['```sql loom rev', 'metric: revenue', 'engine: adx', '```'].join('\n');

    await renderCodeReport({ actor, source, engine: 'synapse' }, { runMetric, runRaw });
    expect(runMetric).toHaveBeenCalledWith(actor, expect.objectContaining({ engine: 'adx' }));
  });

  it('degrades a per-query gate to an honest error, not a page failure', async () => {
    const runMetric = vi.fn().mockResolvedValue({
      ok: false, status: 412, code: 'no_metrics_spec', error: 'No governed metrics defined.',
    });
    const runRaw = vi.fn().mockResolvedValue({
      ok: false, status: 503, code: 'not_configured', missing: 'LOOM_SYNAPSE_WORKSPACE', error: 'not configured',
    } as RawExecOutcome);
    const source = ['```sql loom m', 'metric: revenue', '```', '```sql r', 'SELECT 1', '```'].join('\n');

    const out = await renderCodeReport({ actor, source, engine: 'synapse' }, { runMetric, runRaw });
    expect(out.results['m'].ok).toBe(false);
    expect(out.results['r'].ok).toBe(false);
    const r = out.results['r'];
    expect(!r.ok && r.missing).toBe('LOOM_SYNAPSE_WORKSPACE');
    expect(out.counts).toMatchObject({ total: 2, ok: 0, failed: 2 });
  });

  it('propagates a parse error (route maps it to 400)', async () => {
    const deps: RenderDeps = { runMetric: vi.fn(), runRaw: vi.fn() };
    await expect(renderCodeReport({ actor, source: '```sql\nSELECT 1\n```', engine: 'synapse' }, deps))
      .rejects.toBeInstanceOf(CodeReportParseError);
  });

  it('renders an empty source into an empty AST with no execution', async () => {
    const deps: RenderDeps = { runMetric: vi.fn(), runRaw: vi.fn() };
    const out = await renderCodeReport({ actor, source: '# just prose\n\nno queries', engine: 'synapse' }, deps);
    expect(out.counts.total).toBe(0);
    expect(deps.runMetric).not.toHaveBeenCalled();
    expect(deps.runRaw).not.toHaveBeenCalled();
    expect(out.nodes[0]).toMatchObject({ kind: 'markdown' });
  });
});
