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
 *
 * THE SECOND BYPASS — found in review, and it is the one the first cut of this
 * fix actually shipped. Deriving the badge from `backendsInSet(set)` in EVERY
 * state looks like the general answer, and it re-creates the identical
 * contradiction one state over. TARGETED ⊋ COMPILED is reachable: `dsl.ts`
 * adds `purview` for any statement carrying a `condition.marking`, while
 * `compilers/purview.ts` SKIPS that statement when it names no purview
 * resource. On a CLEAN, saved set of that shape the badge said "compiles to 2
 * backend(s)" while the purview tab said the set produced nothing for it — and
 * the original regression control could not see it, because its fixture used
 * `backends: ['synapse'], compiledBackends: ['synapse']`, where the two are
 * equal by construction. The last test below is that missing case, built from
 * the REAL `compileAll()` output rather than hand-written artifacts, and it
 * pins TARGETED and COMPILED explicitly so the fixture cannot silently
 * degenerate into another targeted == compiled case.
 */
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders, installFetchMock } from '@/lib/editors/__tests__/test-helpers';
import { backendsInSet, normalizePolicyCodeSet, toYaml } from '@/lib/governance/policy-code/dsl';
import { compileAll } from '@/lib/governance/policy-code/compile';

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
    await waitFor(() => expect(screen.getByText('targets 5 backend(s)')).toBeInTheDocument());
    expect(screen.queryByText('compiles to 0 backend(s)')).toBeNull();
    // ...and the verb changed with the number. Nothing has been compiled for
    // these unsaved edits, so the badge must not say "compiles to" at all.
    expect(screen.queryByText(/compiles to \d+ backend\(s\)/)).toBeNull();
    expect(screen.getByText('3 statement(s)')).toBeInTheDocument();
  });

  it('a backend tab never claims the on-screen set produces nothing for it while unsaved', async () => {
    installFetchMock({ '/api/admin/policy-code': () => EMPTY_PERSISTED });
    renderWithProviders(<AdminPolicyCodePage />);

    await waitFor(() => expect(screen.getByText('compiles to 0 backend(s)')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /Load sample/i }));
    await waitFor(() => expect(screen.getByText('targets 5 backend(s)')).toBeInTheDocument());

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

  /**
   * The case the control above cannot reach. Its fixture has
   * `backends === compiledBackends`, so a badge derived from EITHER reads the
   * same — a mutation swapping one for the other survives it. This one is built
   * so the two genuinely differ, from the REAL compiler rather than
   * hand-written artifacts, and it asserts the divergence exists before it
   * asserts anything about the DOM.
   */
  it('BLOCKING — a SAVED set whose TARGETED backends exceed its COMPILED ones never claims it compiles to the targeted count', async () => {
    // A marking with no purview resource: `backendsInSet` counts purview
    // (dsl.ts — a marking implies the backend), `compilePurview` skips the
    // statement and produces no ops, so purview is NOT in compiledBackends.
    const SAVED = normalizePolicyCodeSet({
      apiVersion: 'loom.governance/v1',
      name: 'loom-governance',
      description: '',
      statements: [{
        id: 'gold-orders-marked',
        actions: ['read'],
        principals: [{ id: 'g-analysts', name: 'analysts' }],
        resources: [{ backend: 'synapse', object: 'gold.orders' }],
        condition: { marking: 'Confidential' },
      }],
    });
    const compiled = compileAll(SAVED);

    // POPULATION FLOOR. If a future compiler change makes purview applicable
    // for a marking-only statement, targeted == compiled and every DOM
    // assertion below becomes vacuously true. Fail loudly here instead: the
    // fixture must keep being a targeted ⊋ compiled case for the test to mean
    // anything.
    expect(backendsInSet(SAVED)).toEqual(['synapse', 'purview']);
    expect(compiled.compiledBackends).toEqual(['synapse']);

    installFetchMock({
      '/api/admin/policy-code': () => ({
        ok: true,
        exists: true,
        set: SAVED,
        yaml: toYaml(SAVED),
        backends: backendsInSet(SAVED),
        validation: compiled.validation,
        artifacts: compiled.artifacts,
        compiledBackends: compiled.compiledBackends,
        totalOps: compiled.totalOps,
        lastReceipt: null,
      }),
    });
    renderWithProviders(<AdminPolicyCodePage />);

    // The badge counts what was COMPILED — 1, not the 2 the set targets.
    await waitFor(() => expect(screen.getByText('compiles to 1 backend(s)')).toBeInTheDocument());
    expect(screen.queryByText('compiles to 2 backend(s)')).toBeNull();
    expect(screen.queryByText(/targets \d+ backend\(s\)/)).toBeNull();

    // ...and the purview tab, which the badge just declined to count, explains
    // the gap instead of asserting the set names nothing for it. That sentence
    // would be the same contradiction, one state over.
    await userEvent.click(screen.getByRole('tab', { name: /^purview/ }));
    await waitFor(() =>
      expect(screen.getByText(/targeted, nothing compiled/i)).toBeInTheDocument(),
    );
    expect(screen.queryByText(/This policy set produces no statements for this backend/i)).toBeNull();
    // The compiler's own reason — dropped on the floor before, because
    // artifact.warnings only rendered on APPLICABLE artifacts.
    expect(screen.getByText(/no purview resource to apply it to/i)).toBeInTheDocument();

    // The tab strip must not carry an op count for it either.
    expect(screen.queryByRole('tab', { name: /^purview \(/ })).toBeNull();
  });
});
