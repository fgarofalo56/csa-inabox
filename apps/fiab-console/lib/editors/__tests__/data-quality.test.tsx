/**
 * DataQualityEditor — behaviour specs (FINISHLINE C14).
 *
 * `data-quality` had no editor test. The riskiest thing about this surface is
 * that it runs against THREE different backends (ADX / Databricks SQL / Synapse
 * SQL) and each one needs a different target shape. A regression that leaves
 * the wrong fields mounted, or persists the wrong backend, produces a run
 * against the wrong system that still LOOKS successful.
 *
 * These pin:
 *   - the backend radio genuinely swaps the target fields (per-backend forms)
 *   - the backend + target reach the persisted item state
 *   - the config gate probe is surfaced with the exact env var
 *   - a run auto-saves a dirty item first, so what runs matches what is stored
 *   - the scorecard reads the right summary fields, incl. the no_rules case
 *     that must NOT be reported as a pass
 *   - the N7d flag genuinely hides both extra tabs
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { DataQualityEditor } from '../data-quality-editor';
import { makeItem, renderWithProviders } from './test-helpers';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

interface Call { url: string; init?: RequestInit }

function installFetch(opts: {
  state?: Record<string, unknown>;
  gate?: string | null;
  n7dEnabled?: boolean;
  run?: () => Response;
} = {}) {
  const calls: Call[] = [];
  vi.spyOn(global, 'fetch').mockImplementation(async (input: any, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String(input?.toString?.() ?? input);
    calls.push({ url, init });
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }) as any;

    if (url.includes('/checks')) return json({ ok: true, enabled: opts.n7dEnabled ?? false });
    if (url.includes('/run')) {
      if (init?.method === 'POST') {
        return (opts.run ? opts.run() : json({ ok: true, run: emptyRun() })) as any;
      }
      return json({ ok: true, gate: opts.gate ? { missing: opts.gate } : undefined });
    }
    if (url.includes('/api/items/data-quality/')) return json({ ok: true, state: opts.state ?? {} });
    return json({ ok: true });
  });
  return calls;
}

function emptyRun(over: Record<string, unknown> = {}) {
  return {
    id: 'run1', ranAt: new Date().toISOString(), backend: 'kusto', target: 'loomdb',
    score: 100, ruleCount: 1, passingRules: 1, failingRules: 0,
    status: 'passed', breakdown: [], ranBy: 'tester', ...over,
  };
}

function renderEditor(id = 'dq-fixture') {
  return renderWithProviders(<DataQualityEditor item={makeItem('data-quality', 'Data Quality')} id={id} />);
}

const runBtn = () => screen.getByRole('button', { name: /Run quality checks|Running/ });

describe('DataQualityEditor — per-backend target forms', () => {
  it('mounts the ADX target field for the default kusto backend', async () => {
    installFetch();
    renderEditor();

    await waitFor(() => expect(screen.getByText('Backend & target')).toBeInTheDocument());
    expect(screen.getByText('ADX database')).toBeInTheDocument();
    // Databricks-only and Synapse-only fields must NOT be mounted.
    expect(screen.queryByText('SQL warehouse id')).not.toBeInTheDocument();
    expect(screen.queryByText('Pool')).not.toBeInTheDocument();
  });

  it('swaps to the Databricks fields (warehouse / catalog / schema) when that backend is picked', async () => {
    installFetch();
    renderEditor();

    await waitFor(() => expect(screen.getByText('ADX database')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('radio', { name: 'Databricks SQL' }));

    await waitFor(() => expect(screen.getByText('SQL warehouse id')).toBeInTheDocument());
    expect(screen.getByText('Catalog')).toBeInTheDocument();
    expect(screen.getByText('Schema')).toBeInTheDocument();
    // ADX field is gone — a stale field would let a user set a target the
    // selected backend cannot use.
    expect(screen.queryByText('ADX database')).not.toBeInTheDocument();
  });

  it('swaps to the Synapse fields (pool / database) when that backend is picked', async () => {
    installFetch();
    renderEditor();

    await waitFor(() => expect(screen.getByText('ADX database')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('radio', { name: 'Synapse SQL' }));

    await waitFor(() => expect(screen.getByText('Pool')).toBeInTheDocument());
    expect(screen.queryByText('SQL warehouse id')).not.toBeInTheDocument();
  });

  it('restores the persisted backend on load rather than defaulting to kusto', async () => {
    // A silent reset to kusto would run the checks against the wrong system.
    installFetch({ state: { backend: 'databricks', warehouseId: 'wh-123' } });
    renderEditor();

    await waitFor(() => expect(screen.getByText('SQL warehouse id')).toBeInTheDocument());
    expect(screen.getByDisplayValue('wh-123')).toBeInTheDocument();
  });
});

describe('DataQualityEditor — config gate', () => {
  it('surfaces the probed gate with the exact env var and names the backend', async () => {
    installFetch({ gate: 'LOOM_ADX_CLUSTER_URI' });
    renderEditor();

    await waitFor(() => expect(screen.getByText('kusto backend not configured')).toBeInTheDocument());
    expect(screen.getByText('LOOM_ADX_CLUSTER_URI')).toBeInTheDocument();
  });

  it('shows no gate banner when the backend is configured', async () => {
    installFetch({ gate: null });
    renderEditor();

    await waitFor(() => expect(screen.getByText('Backend & target')).toBeInTheDocument());
    expect(screen.queryByText(/backend not configured/)).not.toBeInTheDocument();
  });
});

describe('DataQualityEditor — run behaviour', () => {
  it('saves a dirty item BEFORE running so the run matches the persisted config', async () => {
    // Otherwise the scorecard is attributed to a target that was never stored,
    // and re-opening the item shows a score for a different configuration.
    const calls = installFetch();
    renderEditor();

    await waitFor(() => expect(screen.getByText('ADX database')).toBeInTheDocument());
    // Make the item dirty.
    fireEvent.change(screen.getByPlaceholderText('loomdb'), { target: { value: 'salesdb' } });
    fireEvent.click(runBtn());

    await waitFor(() => {
      const patchIdx = calls.findIndex((c) => c.init?.method === 'PATCH');
      const runIdx = calls.findIndex((c) => c.init?.method === 'POST' && c.url.includes('/run'));
      expect(patchIdx, 'a PATCH must be issued for a dirty item').toBeGreaterThanOrEqual(0);
      expect(runIdx, 'the run must be POSTed').toBeGreaterThanOrEqual(0);
      expect(patchIdx).toBeLessThan(runIdx);
    });
  });

  it('renders the composite score and the passing/failing split from the run', async () => {
    installFetch({
      run: () =>
        new Response(JSON.stringify({
          ok: true,
          run: emptyRun({ score: 62, ruleCount: 8, passingRules: 5, failingRules: 3, status: 'failed' }),
        }), { status: 200, headers: { 'content-type': 'application/json' } }) as any,
    });
    renderEditor();

    await waitFor(() => expect(runBtn()).toBeEnabled());
    fireEvent.click(runBtn());

    await waitFor(() => expect(screen.getByText('Data-quality scorecard')).toBeInTheDocument());
    expect(screen.getByText('62%')).toBeInTheDocument();
    expect(screen.getByText('5 passing')).toBeInTheDocument();
    expect(screen.getByText('3 failing')).toBeInTheDocument();
    expect(screen.getByText('failed')).toBeInTheDocument();
  });

  it('does NOT present "no rules matched" as a passing score', async () => {
    // The dangerous confusion: zero rules is zero information, not a clean
    // bill of health. It must render its own explanatory message, not a score.
    installFetch({
      run: () =>
        new Response(JSON.stringify({
          ok: true,
          run: emptyRun({ status: 'no_rules', score: null, ruleCount: 0, passingRules: 0, failingRules: 0 }),
        }), { status: 200, headers: { 'content-type': 'application/json' } }) as any,
    });
    renderEditor();

    await waitFor(() => expect(runBtn()).toBeEnabled());
    fireEvent.click(runBtn());

    await waitFor(() =>
      expect(screen.getByText(/No enabled rules matched this target/)).toBeInTheDocument(),
    );
    expect(screen.queryByText('100%')).not.toBeInTheDocument();
  });

  it('renders the per-rule breakdown so a failing rule is identifiable', async () => {
    installFetch({
      run: () =>
        new Response(JSON.stringify({
          ok: true,
          run: emptyRun({
            score: 50, ruleCount: 2, passingRules: 1, failingRules: 1, status: 'failed',
            breakdown: [
              { ruleId: 'r1', name: 'orders.id not null', check: 'not_null', scope: 'orders.id', percentage: 100, passed: true, detail: 'ok' },
              { ruleId: 'r2', name: 'orders.email regex', check: 'regex', scope: 'orders.email', percentage: 62.5, passed: false, detail: '3 of 8 failed' },
            ],
          }),
        }), { status: 200, headers: { 'content-type': 'application/json' } }) as any,
    });
    renderEditor();

    await waitFor(() => expect(runBtn()).toBeEnabled());
    fireEvent.click(runBtn());

    await waitFor(() => expect(screen.getByText('orders.email regex')).toBeInTheDocument());
    expect(screen.getByText('62.5%')).toBeInTheDocument();
    expect(screen.getByText('3 of 8 failed')).toBeInTheDocument();
    expect(screen.getByText('fail')).toBeInTheDocument();
  });

  it('surfaces the run error AND its hint on failure', async () => {
    installFetch({
      run: () =>
        new Response(JSON.stringify({ ok: false, error: 'TDS login failed', hint: 'grant the console UAMI db_datareader' }),
          { status: 200, headers: { 'content-type': 'application/json' } }) as any,
    });
    renderEditor();

    await waitFor(() => expect(runBtn()).toBeEnabled());
    fireEvent.click(runBtn());

    await waitFor(() => expect(screen.getByText('Run failed')).toBeInTheDocument());
    expect(screen.getByText(/TDS login failed — grant the console UAMI db_datareader/)).toBeInTheDocument();
  });
});

describe('DataQualityEditor — N7d runtime flag', () => {
  it('hides both extra tabs when the n7d flag is off (kill-switch works)', async () => {
    installFetch({ n7dEnabled: false });
    renderEditor();

    await waitFor(() => expect(screen.getByRole('tab', { name: 'Run' })).toBeInTheDocument());
    expect(screen.queryByRole('tab', { name: 'Runner checks' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Data diff' })).not.toBeInTheDocument();
  });

  it('shows both extra tabs when the n7d flag is on', async () => {
    installFetch({ n7dEnabled: true });
    renderEditor();

    await waitFor(() => expect(screen.getByRole('tab', { name: 'Runner checks' })).toBeInTheDocument());
    expect(screen.getByRole('tab', { name: 'Data diff' })).toBeInTheDocument();
  });
});
