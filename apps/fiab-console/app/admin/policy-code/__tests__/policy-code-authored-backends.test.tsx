/**
 * #3752 — the authored set and the compiled panes must describe the SAME set.
 *
 * `backendsUsed` read `data.compiledBackends`, i.e. what the SERVER compiled for
 * the LAST SAVED set. "Load sample" only calls `setSet()`, so the left pane
 * rendered the sample's 3 statements — whose resources name synapse,
 * unity-catalog, adx, purview and api-scope — while the badge inches to their
 * right said "compiles to 0 backend(s)" and every backend tab said the set
 * produces no statements for that backend. Two panes, two different policy
 * sets, and nothing on screen said so.
 *
 * The narrow bypass this pins shut: fixing ONLY the badge would leave the tab
 * panels still asserting "This policy set produces no statements for this
 * backend" about a set that plainly does. Both are asserted below.
 */
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders, installFetchMock } from '@/lib/editors/__tests__/test-helpers';

vi.mock('next/navigation', () => ({
  usePathname: () => '/admin/policy-code',
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

import AdminPolicyCodePage from '../page';

/** An EMPTY persisted set — the state a first-time operator hits "Load sample" from. */
const EMPTY_PERSISTED = {
  ok: true,
  exists: false,
  set: { name: 'loom-governance', description: '', statements: [] },
  yaml: '',
  backends: [],
  validation: { ok: true, errors: [], warnings: [] },
  artifacts: [],
  compiledBackends: [],
  totalOps: 0,
  lastReceipt: null,
};

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('/admin/policy-code — "Load sample" and the compiled panes agree', () => {
  it('the badge counts the backends the AUTHORED set targets, not the last saved one', async () => {
    installFetchMock({ '/api/admin/policy-code': () => EMPTY_PERSISTED });
    renderWithProviders(<AdminPolicyCodePage />);

    // Baseline: an empty persisted set genuinely compiles to nothing.
    await waitFor(() => expect(screen.getByText('compiles to 0 backend(s)')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: /Load sample/i }));

    // The sample names five backends. Before the fix this still read 0.
    await waitFor(() => expect(screen.getByText('compiles to 5 backend(s)')).toBeInTheDocument());
    expect(screen.queryByText('compiles to 0 backend(s)')).toBeNull();
    expect(screen.getByText('3 statement(s)')).toBeInTheDocument();
  });

  it('a backend tab never claims the on-screen set produces nothing for it while unsaved', async () => {
    installFetchMock({ '/api/admin/policy-code': () => EMPTY_PERSISTED });
    renderWithProviders(<AdminPolicyCodePage />);

    await waitFor(() => expect(screen.getByText('compiles to 0 backend(s)')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /Load sample/i }));
    await waitFor(() => expect(screen.getByText('compiles to 5 backend(s)')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('tab', { name: /^synapse/ }));

    // The false claim about the set on screen is gone...
    expect(screen.queryByText(/This policy set produces no statements for this backend/i)).toBeNull();
    // ...replaced by which set the pane is actually describing, and what to do.
    await waitFor(() => expect(screen.getByText(/not compiled yet/i)).toBeInTheDocument());
    expect(screen.getByText(/these edits are unsaved so nothing has been compiled/i)).toBeInTheDocument();
  });

  it('REGRESSION CONTROL — with a SAVED set the compiled panes keep their real counts and copy', async () => {
    installFetchMock({
      '/api/admin/policy-code': () => ({
        ...EMPTY_PERSISTED,
        exists: true,
        set: {
          name: 'loom-governance',
          description: '',
          statements: [{
            id: 'analysts-read-gold',
            actions: ['read'],
            principals: [{ id: 'g1', name: 'analysts' }],
            resources: [{ backend: 'synapse', object: 'gold.orders' }],
          }],
        },
        backends: ['synapse'],
        compiledBackends: ['synapse'],
        artifacts: [{
          backend: 'synapse', applicable: true, summary: ['1 DENY'], warnings: [],
          ops: [{ key: 'op-1', kind: 'sql', statement: 'DENY SELECT ON gold.orders' }],
        }],
        totalOps: 1,
      }),
    });
    renderWithProviders(<AdminPolicyCodePage />);

    await waitFor(() => expect(screen.getByText('compiles to 1 backend(s)')).toBeInTheDocument());
    // The op count stays on the tab while the set is clean — it is a true
    // statement about the set on screen in that state.
    expect(screen.getByRole('tab', { name: 'synapse (1)' })).toBeInTheDocument();

    // A backend the saved set does NOT target keeps the original wording.
    await userEvent.click(screen.getByRole('tab', { name: /^trino/ }));
    await waitFor(() =>
      expect(screen.getByText(/This policy set produces no statements for this backend/i)).toBeInTheDocument(),
    );
  });
});
