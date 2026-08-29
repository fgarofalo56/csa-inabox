/**
 * SparkJobDefinitionEditor — vitest render + interaction.
 * Mocks /api/items/synapse-spark-pool/list and /api/items/spark-job-definition/[id]
 * so the editor mounts with a real-shaped fixture.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SparkJobDefinitionEditor } from '../spark-job-definition-editor';
import { makeItem, installFetchMock } from './test-helpers';

describe('SparkJobDefinitionEditor', () => {
  beforeEach(() => {
    installFetchMock({
      '/api/items/synapse-spark-pool/list': () => ({
        ok: true,
        pools: [{ name: 'pool-fixture', nodeSize: 'Small', state: 'Online' }],
      }),
      '/api/items/environment': () => ({ ok: true, items: [] }),
      '/api/items/spark-job-definition/sjd-1/runs': () => ({ ok: true, sessions: [] }),
      '/api/items/spark-job-definition/sjd-1': () => ({
        ok: true,
        item: {
          id: 'sjd-1',
          workspaceId: 'ws-1',
          displayName: 'sjd-fixture',
          state: { spec: { file: 'abfss://lake/foo.py', pool: 'pool-fixture' } },
        },
      }),
    });
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('renders editor chrome and ribbon', async () => {
    render(<SparkJobDefinitionEditor item={makeItem('spark-job-definition', 'Spark Job Definition')} id="sjd-1" />);
    await waitFor(() => {
      expect(screen.getByTestId('chrome')).toBeInTheDocument();
    });
    expect(screen.getByTestId('ribbon').querySelectorAll('button').length).toBeGreaterThan(0);
  });

  it('shows the form with the loaded spec', async () => {
    render(<SparkJobDefinitionEditor item={makeItem('spark-job-definition', 'Spark Job Definition')} id="sjd-1" />);
    await waitFor(() => {
      // The application file input should be populated from cosmos state
      const inputs = screen.getAllByRole('textbox');
      expect(inputs.length).toBeGreaterThan(0);
    });
  });
});

/**
 * #3570 — the runs fetch skips when the PERSISTED spec has no pool, so a freshly
 * created item does not open on a red "Operation failed" bar. That skip is right,
 * and its first cut broke the PRIMARY FLOW.
 *
 * WHY THE SUITE ABOVE CANNOT CATCH IT: its fixture persists
 * `spec: { pool: 'pool-fixture' }`, so `persistedPool` is always truthy and the
 * skip branch is never taken. The defect only appears on an item whose persisted
 * spec has NO pool — which is exactly the state a just-created item is in when
 * `submit()` fires `setTimeout(loadRuns, 1500)` without a `reload()`.
 *
 * The bug: `loadRuns` returned early, the just-submitted batch never appeared,
 * `anyActive` stayed false so the 5s auto-refresh never armed, and "Refresh runs"
 * called the same dead closure. Only a full page reload recovered.
 *
 * These two specs are the population control for that branch — one proves the
 * skip still holds on a genuinely unconfigured item (the #3570 behaviour), the
 * other proves the fetch is NOT skipped once a pool has been chosen.
 */
describe('SparkJobDefinitionEditor — the runs skip does not strand a fresh item (#3570)', () => {
  const runsCalls: string[] = [];

  beforeEach(() => {
    runsCalls.length = 0;
    installFetchMock({
      '/api/items/synapse-spark-pool/list': () => ({
        ok: true,
        pools: [{ name: 'pool-fixture', nodeSize: 'Small', state: 'Online' }],
      }),
      '/api/items/environment': () => ({ ok: true, items: [] }),
      '/api/items/spark-job-definition/sjd-new/runs': (url?: string) => {
        runsCalls.push(url || 'runs');
        return { ok: true, sessions: [], scanned: 0, total: 0, truncatedBy: null };
      },
      // The state a just-created item is in: NO pool in the persisted spec.
      '/api/items/spark-job-definition/sjd-new': () => ({
        ok: true,
        item: {
          id: 'sjd-new',
          workspaceId: 'ws-1',
          displayName: 'sjd-fresh',
          state: { spec: {} },
        },
      }),
    });
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('skips the runs fetch while nothing is configured — no red bar on first open', async () => {
    render(<SparkJobDefinitionEditor item={makeItem('spark-job-definition', 'Spark Job Definition')} id="sjd-new" />);
    await waitFor(() => {
      expect(screen.getByTestId('chrome')).toBeInTheDocument();
    });
    // THE #3570 BEHAVIOUR, kept: persisted spec has no pool and the user has not
    // chosen one, so the fetch is skipped and the guided empty state stands.
    expect(runsCalls).toHaveLength(0);
  });

  it('once a pool is chosen the fetch is NOT skipped, even before cosmos catches up', async () => {
    // THE REGRESSION GUARD, and it has to DRIVE the selection to be one. Before
    // the fix `loadRuns` read only the persisted spec, so after submit() — which
    // saves but does not reload() — this fetch never happened and the submitted
    // batch was invisible. Asserting only that a combobox renders would pass on
    // the broken code, which is not a guard.
    const user = userEvent.setup();
    render(<SparkJobDefinitionEditor item={makeItem('spark-job-definition', 'Spark Job Definition')} id="sjd-new" />);
    await waitFor(() => {
      expect(screen.getByTestId('chrome')).toBeInTheDocument();
    });
    // Baseline: nothing configured, nothing fetched (the spec above pins this).
    expect(runsCalls).toHaveLength(0);

    // The pool control is a Fluent v9 `Dropdown` (`onOptionSelect`), not the
    // native <select> the azure-sql-database suite drives with fireEvent.change,
    // so open it and click the option. Both shapes are attempted rather than
    // assumed: if neither selects a pool the final assertion fails, which is the
    // correct outcome for a guard — it must not pass without a selection.
    const combos = screen.getAllByRole('combobox');
    let picked = false;
    for (const c of combos) {
      await user.click(c);
      const opt = screen.queryByRole('option', { name: /pool-fixture/i });
      if (opt) { await user.click(opt); picked = true; break; }
    }
    expect(picked).toBe(true);

    // With a pool selected the skip must no longer fire. Drive the explicit
    // Refresh so the assertion does not hang on the 5s auto-refresh timer.
    const refresh = screen.queryByRole('button', { name: /refresh runs/i });
    if (refresh) await user.click(refresh);

    await waitFor(() => {
      expect(runsCalls.length).toBeGreaterThan(0);
    });
  });
});
