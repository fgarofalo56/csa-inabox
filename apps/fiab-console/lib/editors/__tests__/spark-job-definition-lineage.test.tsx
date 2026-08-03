/**
 * #2625 — the LU-8 lineage-harvest honest gate must be VISIBLE and RESOLVABLE.
 *
 * The defect this locks down: `GET /api/items/spark-job-definition/[id]/runs/
 * [runId]` has always returned `lineage.reason` explaining, in the backend's
 * own words, why a succeeded batch produced no lineage — and the Runs tab
 * rendered NOTHING. Per `ux-baseline.md` G2 a remediation the user never sees
 * is not a compliant gate, and a rendered one needs an inline **Fix it**.
 *
 * These specs mount the REAL editor and drive the REAL wizard.
 *
 * OWN FILE, deliberately: every render here is wrapped in a `FluentProvider`,
 * because the Fix-it wizard's `Dialog` and its multiselect listbox portal
 * through the provider's mount node — without one they never open under jsdom.
 * `spark-job-definition.test.tsx` keeps the pre-existing bare-render chrome
 * specs, which must not be disturbed.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { SparkJobDefinitionEditor } from '../spark-job-definition-editor';
import { makeItem, installFetchMock } from './test-helpers';

/** A settled (non-active) Livy batch — the run whose lineage receipt is final. */
const SETTLED_RUN = {
  id: 7, name: 'loom-sjd-fixture-1', state: 'success', result: 'Succeeded',
  submittedAt: '2026-08-01T00:00:00Z', appId: 'app-1',
};

/** The receipt the run route has ALWAYS returned for an undeclared job. */
const NOT_DECLARED = {
  ok: true, events: 0, written: 0, skipped: 0, denied: 0,
  code: 'spark_lineage_not_declared',
  reason:
    'the batch declared no storage input+output (set spark.loom.lineage.inputs/outputs, ' +
    'pass --input/--output paths, or wire the openlineage-spark listener for full column lineage)',
};

function mountWith(lineage: unknown) {
  const mock = installFetchMock({
    '/api/items/synapse-spark-pool/list': () => ({ ok: true, pools: [{ name: 'pool-fixture' }] }),
    '/api/items/environment': () => ({ ok: true, items: [] }),
    '/api/items/spark-job-definition/sjd-1/runs': () => ({ ok: true, sessions: [SETTLED_RUN] }),
    // Longest-key-wins in the helper, so this beats the runs-list handler.
    '/api/items/spark-job-definition/sjd-1/runs/7': () => ({
      ok: true, pool: 'pool-fixture', job: { ...SETTLED_RUN, log: ['line 1'] }, lineage,
    }),
    '/api/items/spark-job-definition/sjd-1/lineage-targets': () => ({
      ok: true,
      targets: [
        { path: 'abfss://bronze@acct.dfs.core.windows.net/sales', itemId: 'lh-1', itemType: 'lakehouse', displayName: 'Bronze lake' },
        { path: 'abfss://silver@acct.dfs.core.windows.net/sales', itemId: 'lh-2', itemType: 'lakehouse', displayName: 'Silver lake' },
      ],
    }),
    '/api/items/spark-job-definition/sjd-1': () => ({
      ok: true,
      item: {
        id: 'sjd-1', workspaceId: 'ws-1', displayName: 'sjd-fixture',
        state: { spec: { file: 'abfss://lake/foo.py', pool: 'pool-fixture', conf: { 'spark.sql.shuffle.partitions': '200' } } },
      },
    }),
  });
  render(
    <FluentProvider theme={webLightTheme}>
      <SparkJobDefinitionEditor item={makeItem('spark-job-definition', 'Spark Job Definition')} id="sjd-1" />
    </FluentProvider>,
  );
  return mock;
}

async function openRunsTab() {
  fireEvent.click(await screen.findByRole('tab', { name: /runs/i }));
}

afterEach(() => { vi.restoreAllMocks(); });

describe('SparkJobDefinitionEditor — lineage harvest gate (#2625)', () => {
  it('renders the backend remediation on the Runs tab instead of dropping it', async () => {
    mountWith(NOT_DECLARED);
    await openRunsTab();
    await waitFor(() => {
      expect(screen.getByText(/this job declares no input or output dataset/i)).toBeInTheDocument();
    });
    // The backend's own words reach the operator — not a generic stub banner.
    expect(screen.getByText(/set spark\.loom\.lineage\.inputs\/outputs/)).toBeInTheDocument();
    // G2: an inline Fix-it, and a live deep link into the gate registry.
    expect(screen.getByRole('button', { name: /fix it/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /gate registry/i }))
      .toHaveAttribute('href', '/admin/gates?q=svc-openlineage');
  });

  it('does NOT nag on a run whose receipt has nothing to say', async () => {
    mountWith({ ok: true, events: 0, written: 0, skipped: 0, denied: 0, code: 'already_harvested', reason: 'already harvested in this replica' });
    await openRunsTab();

    // CONTROLS. Both are load-bearing and both must be AWAITED — this spec's
    // point is the two ABSENCE assertions below, and an absence proves nothing
    // about a surface that has not finished loading.
    //
    // `Run history` is a STATIC section header (spark-job-definition-editor.tsx
    // renders it as a sibling of the rows block, not inside it), so it is in the
    // DOM the instant the tab is selected — before either fetch resolves.
    // Sampling anything synchronously off the back of it is the #2834 race:
    // the query resolves against chrome that exists in the loading state while
    // the data it stands in for has not arrived. Reading the row with a
    // synchronous `getByText` failed 3/3 under full-suite load in CI and passed
    // in isolation, because contention is what lets the render lose the race.
    // Same class as `selectOptionValue` in ./test-helpers — the cure is waiting
    // for THE DATA, never for a timing constant.
    //
    // (1) the runs LIST landed and rendered its row …
    await screen.findByText(/Run history/i);
    await screen.findByText('loom-sjd-fixture-1');
    // (2) … and the run DETAIL landed too. `GET …/runs/7` returns the driver log
    //     and the `lineage` receipt under test in ONE response, so the log tail
    //     reaching the DOM is proof that the receipt reached the component.
    //     Without this the assertions below pass vacuously — they would keep
    //     passing even if `already_harvested` stopped being a silent code.
    fireEvent.click(screen.getByRole('button', { name: /Batch #7/ }));
    await screen.findByText('line 1');

    expect(screen.queryByText(/already harvested/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /fix it/i })).not.toBeInTheDocument();
  });

  it('Fix it opens the picker wizard and writes the two Spark conf keys through the real item PUT', async () => {
    const { calls } = mountWith(NOT_DECLARED);
    await openRunsTab();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /fix it/i }));

    // The wizard offers ONLY discovered workspace roots (loom_no_freeform_config):
    // a multiselect Dropdown, whose options Fluent exposes as menuitemcheckbox.
    // `hidden: true`: jsdom does not resolve the portalled DialogSurface into
    // the accessibility tree once several providers have mounted in one file,
    // so the default accessible-only role query cannot see the pickers. The
    // elements, their labels, and the clicks below are the REAL ones.
    await user.click(await screen.findByRole('combobox', { name: /reads from/i, hidden: true }));
    await user.click(await screen.findByRole('menuitemcheckbox', { name: /Bronze lake/i, hidden: true }));

    await user.click(screen.getByRole('combobox', { name: /writes to/i, hidden: true }));
    await user.click(await screen.findByRole('menuitemcheckbox', { name: /Silver lake/i, hidden: true }));

    await user.click(screen.getByRole('button', { name: /save declaration/i, hidden: true }));

    await waitFor(() => {
      const put = calls.find((c) => c.init?.method === 'PUT' && c.url.includes('/api/items/spark-job-definition/sjd-1'));
      expect(put, 'a real item PUT must carry the declaration').toBeTruthy();
      const body = JSON.parse(String(put!.init!.body));
      expect(body.state.spec.conf['spark.loom.lineage.inputs']).toBe('abfss://bronze@acct.dfs.core.windows.net/sales');
      expect(body.state.spec.conf['spark.loom.lineage.outputs']).toBe('abfss://silver@acct.dfs.core.windows.net/sales');
      // CONTROLS — the wizard edits ONLY the two lineage keys. An over-broad
      // implementation that rewrote the conf or the spec fails right here.
      expect(body.state.spec.conf['spark.sql.shuffle.partitions']).toBe('200');
      expect(body.state.spec.file).toBe('abfss://lake/foo.py');
      expect(body.state.spec.pool).toBe('pool-fixture');
    });
  });
});
