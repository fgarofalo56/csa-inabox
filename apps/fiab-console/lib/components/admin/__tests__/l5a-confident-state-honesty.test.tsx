/**
 * L5-A — "a surface must not state something the same page contradicts".
 *
 * Five of the seven fixes in this batch are ONE defect: a confident state
 * rendered over a read that failed, was stale, or was contradicted by a sibling
 * field on the same screen (no-vaporware.md; deploy-integrity.md R7 — an error
 * must not assert something it did not establish). This spec pins the shared
 * invariant across the surfaces in lib/components/**, so a later edit cannot
 * quietly restore any of them.
 *
 * ── WHY EACH TEST IS SHAPED THE WAY IT IS ─────────────────────────────────────
 *
 * THE NARROW BYPASS this spec exists to close (#3739). `FinopsCockpitPane`'s
 * `getJson` does NOT throw on a non-2xx — it merges `status` into the resolved
 * body deliberately. So on a 504 react-query's own `isError` is FALSE, and only
 * `readState()`'s `httpFailed` branch sees the failure. A "fix" written as
 *     anomaliesQ.isError ? null : …
 * instead of
 *     readState(anomaliesQ).isError ? null : …
 * passes a transport-failure test and STILL renders "No anomalies detected"
 * under a 504. Every failure case below therefore uses a RESOLVING non-2xx
 * response, which is the shape that discriminates, and asserts on BOTH panels
 * — fixing one and not the other was the other available narrow bypass.
 *
 * THE POSITIVE CONTROLS matter as much as the failure cases. Deleting an
 * EmptyState outright would satisfy every "the false claim is gone" assertion
 * while destroying a real guided-empty surface (ux-baseline.md). Each fix below
 * is therefore paired with a healthy-read test asserting the empty state STILL
 * renders when the backend genuinely returned nothing.
 */
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';

import { FinopsCockpitPane } from '../finops-cockpit-pane';
import { PerfRecommendationsCard } from '../perf-recommendations-card';
import { TokenBudgetPanel } from '../token-budget-panel';
import { NotConfiguredBar } from '../../admin-security/not-configured-bar';
import { Ribbon, type RibbonTab } from '../../ribbon';

/** Render inside the providers every one of these surfaces expects. */
function mount(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <FluentProvider theme={webLightTheme}>{ui}</FluentProvider>
    </QueryClientProvider>,
  );
}

/**
 * A fetch mock with PER-ROUTE STATUS CONTROL. `installFetchMock` in
 * lib/editors/__tests__/test-helpers always answers 200, which cannot express
 * the failure shape these surfaces actually mishandle.
 */
function routeMock(routes: Record<string, { status: number; body: unknown }>) {
  vi.spyOn(global, 'fetch').mockImplementation(async (input: any) => {
    const url = typeof input === 'string' ? input : String(input?.toString?.() ?? input);
    const key = Object.keys(routes).sort((a, b) => b.length - a.length).find((k) => url.includes(k));
    const r = key ? routes[key] : { status: 200, body: { ok: true } };
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: { 'content-type': 'application/json' },
    }) as any;
  });
}

const GATEWAY_TIMEOUT = { status: 504, body: { ok: false, error: 'Cost Management timed out.' } };

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

// ── #3739 — FinOps cockpit: anomalies + budgets ──────────────────────────────
describe('#3739 FinopsCockpitPane — a failed read never becomes a confident empty state', () => {
  it('shows NEITHER "No anomalies detected" NOR "No budgets yet" when both reads 504', async () => {
    routeMock({
      '/api/admin/finops/anomalies': GATEWAY_TIMEOUT,
      '/api/admin/finops/budgets': GATEWAY_TIMEOUT,
      '/api/admin/finops/forecast': GATEWAY_TIMEOUT,
      '/api/admin/finops/breakdown': GATEWAY_TIMEOUT,
    });
    mount(<FinopsCockpitPane />);

    // The pane's own disclaimer is the truth in this state, and it is rendered.
    await waitFor(() =>
      expect(screen.getByText(/An empty feed below would be misleading/i)).toBeInTheDocument(),
    );
    expect(screen.getByText(/Existing budgets are unchanged/i)).toBeInTheDocument();

    // ...and the claims that CONTRADICTED it are gone. Before the fix both of
    // these rendered directly beneath the disclaimers above.
    expect(screen.queryByText('No anomalies detected')).toBeNull();
    expect(screen.queryByText(/Every scope's daily spend is within its expected range/i)).toBeNull();
    expect(screen.queryByText('No budgets yet')).toBeNull();
  });

  it('POSITIVE CONTROL — a healthy 200 with genuinely empty results still shows both guided empty states', async () => {
    routeMock({
      '/api/admin/finops/anomalies': { status: 200, body: { ok: true, feed: [], rules: [] } },
      '/api/admin/finops/budgets': { status: 200, body: { ok: true, budgets: [], subscriptions: ['sub-a'] } },
      '/api/admin/finops/forecast': { status: 200, body: { ok: true, data: null } },
      '/api/admin/finops/breakdown': { status: 200, body: { ok: true, rows: [], total: 0 } },
    });
    mount(<FinopsCockpitPane />);

    await waitFor(() => expect(screen.getByText('No anomalies detected')).toBeInTheDocument());
    expect(screen.getByText('No budgets yet')).toBeInTheDocument();
  });
});

// ── #3733 — Performance hub recommendations card ─────────────────────────────
describe('#3733 PerfRecommendationsCard — "everything is inside its bars" is not claimable', () => {
  it('does not render the confident empty state when the derivation FAILED', async () => {
    routeMock({
      '/api/admin/performance/recommendations': {
        status: 200,
        body: { ok: false, error: 'ARM probe for the ADX cluster timed out.' },
      },
    });
    mount(<PerfRecommendationsCard />);

    await waitFor(() =>
      expect(screen.getByText(/ARM probe for the ADX cluster timed out/i)).toBeInTheDocument(),
    );
    // `load()` never calls setRecs on failure, so `recs` stayed null and the
    // EmptyState rendered UNDER the red error bar.
    expect(screen.queryByText(/No actionable recommendations/i)).toBeNull();
    expect(screen.queryByText(/everything is inside its bars/i)).toBeNull();
  });

  it('POSITIVE CONTROL — zero recommendations still guides, but never claims every signal is within target', async () => {
    routeMock({
      '/api/admin/performance/recommendations': {
        status: 200,
        body: { ok: true, recommendations: [], autoApplicable: [] },
      },
    });
    mount(<PerfRecommendationsCard />);

    await waitFor(() =>
      expect(screen.getByText('No actionable recommendations')).toBeInTheDocument(),
    );
    // The exact sentence rules 7 and 11 make false: at an admin bound a REAL
    // breach yields zero cards. Zero cards means "nothing left to auto-apply".
    expect(screen.queryByText(/everything is inside its bars/i)).toBeNull();
    expect(screen.queryByText(/is currently within target/i)).toBeNull();
    // ...and it says so, rather than going silent.
    expect(screen.getByText(/would exceed its admin bound/i)).toBeInTheDocument();
  });

  it('REGRESSION CONTROL — a DENIED apply shows its error without blanking the real cards', async () => {
    // `err` is shared between load() and apply(). Suppressing the whole body on
    // `err` would hide a populated, correct list because a 403 came back from
    // an Apply — trading the reported defect for a worse one. This pins the
    // boundary: the error test belongs INSIDE the zero-recommendations branch.
    routeMock({
      '/api/admin/performance/recommendations/apply': { status: 403, body: { ok: false, error: 'forbidden' } },
      '/api/admin/performance/recommendations': {
        status: 200,
        body: {
          ok: true,
          autoApplicable: [],
          recommendations: [{
            id: 'cache-raise-ttl', cls: 'cache-ttl', severity: 'medium',
            title: 'Cache hit-rate 9% is under the 60% target',
            whatsWrong: 'Only 9% of 400 lookups were served from cache.',
            why: 'Entries expire before the repeat query arrives.',
            change: 'Raise result-cache TTL 60s -> 120s.',
            apply: { kind: 'cache-override' },
            evidence: [{ signal: 'cache hit-rate', value: '9%', threshold: '< 60%' }],
          }],
        },
      },
    });
    mount(<PerfRecommendationsCard />);

    await waitFor(() =>
      expect(screen.getByText('Cache hit-rate 9% is under the 60% target')).toBeInTheDocument(),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Apply for real' }));

    await waitFor(() =>
      expect(screen.getByText(/Tenant admin required to apply performance changes/i)).toBeInTheDocument(),
    );
    // The card is STILL on screen — the denial is about the write, not the read.
    expect(screen.getByText('Cache hit-rate 9% is under the 60% target')).toBeInTheDocument();
  });
});

// ── #3749 — the DLP "not configured" bar ─────────────────────────────────────
describe('#3749 NotConfiguredBar — never blames an env var the producer says is set', () => {
  const SET_HINT = {
    missingEnvVar: 'LOOM_DLP_ENABLED',
    envVarState: 'set' as const,
    bicepStatus: 'LOOM_DLP_ENABLED=true and the Console UAMI holds Policy.Read.All, but Microsoft Graph does not expose a readable DLP policy segment for this tenant.',
  };

  it('with envVarState:"set" the headline and the env line both stop asserting a config gap', () => {
    mount(<NotConfiguredBar surface="DLP policies" hint={SET_HINT} />);

    expect(screen.queryByText(/Missing env var/i)).toBeNull();
    expect(screen.queryByText('DLP policies is not wired in this deployment')).toBeNull();
    expect(screen.getByText('DLP policies is enabled but unavailable in this tenant')).toBeInTheDocument();
    // The flag is still named — it is useful context, just not a blamed cause.
    expect(screen.getByText(/is set — this is not a configuration gap/i)).toBeInTheDocument();
  });

  it('REGRESSION CONTROL — an omitted envVarState keeps today\'s wording verbatim for every existing caller', () => {
    mount(<NotConfiguredBar surface="DSPM for AI" hint={{ missingEnvVar: 'LOOM_DSPM_COSMOS' }} />);

    expect(screen.getByText('DSPM for AI is not wired in this deployment')).toBeInTheDocument();
    expect(screen.getByText(/Missing env var/i)).toBeInTheDocument();
    expect(screen.queryByText(/enabled but unavailable/i)).toBeNull();
  });
});

// ── #3673 — RibbonAction.title ───────────────────────────────────────────────
describe('#3673 Ribbon — an author-supplied title is never discarded', () => {
  function tabsWith(actions: RibbonTab['groups'][number]['actions']): RibbonTab[] {
    return [{ id: 'home', label: 'Home', groups: [{ label: 'Group', actions }] }];
  }

  it('a DISABLED action keeps its explanation (the exact case that lost it)', () => {
    mount(<Ribbon tabs={tabsWith([
      { label: 'Publish', disabled: true, onClick: () => {}, title: 'Save the item before publishing.' },
    ])} />);

    const btn = screen.getByRole('button', { name: 'Publish' });
    // Before the fix: `dead` is false whenever `disabled` is true, so the
    // ternary handed Fluent `undefined` and the reason vanished.
    expect(btn).toHaveAttribute('title', 'Save the item before publishing.');
  });

  it('an ENABLED action with a title keeps it too — including the dropdown branch', () => {
    mount(<Ribbon tabs={tabsWith([
      { label: 'Refresh', onClick: () => {}, title: 'Re-read from the backend.' },
      { label: 'Get data', onClick: () => {}, title: 'Bring data into this item.', dropdownItems: [{ label: 'From lakehouse', onClick: () => {} }] },
    ])} />);

    expect(screen.getByRole('button', { name: 'Refresh' })).toHaveAttribute('title', 'Re-read from the backend.');
    // The dropdown branch had the INVERSE bug: `disabled ? rest.title : undefined`
    // threw the tooltip away while the action was usable.
    expect(screen.getByRole('button', { name: /Get data/ })).toHaveAttribute('title', 'Bring data into this item.');
  });

  it('REGRESSION CONTROL — an action with NO title and no handler still gets the honest "not wired" fallback', () => {
    mount(<Ribbon tabs={tabsWith([{ label: 'Analyze' }])} />);

    expect(screen.getByRole('button', { name: 'Analyze' }))
      .toHaveAttribute('title', 'Analyze — not wired in this editor');
  });
});

// ── #3742 — token-budget scope picker ────────────────────────────────────────
describe('#3742 TokenBudgetPanel — the budget scope is picked from real data, not typed', () => {
  const DASHBOARD = {
    ok: true,
    flagEnabled: true,
    rows: [
      { scope: 'agent', scopeId: 'agent-sql-helper', label: 'SQL helper', budget: null, usage: null, verdict: null },
    ],
    totals: { tokens: 0, usd: 0, turns: 0, over: 0, warning: 0 },
  };

  /**
   * The shape `/api/workspaces` ACTUALLY returns: `listAccessibleWorkspaces()`
   * verbatim, typed `Workspace[]`, whose display field is `name` — there is no
   * `displayName` on `Workspace` (lib/types/workspace.ts; `displayName` lives on
   * `WorkspaceItem`, a different type). The first cut of this spec fed the
   * picker `displayName`, so `label: w.displayName || w.name || w.id` could have
   * its `w.name` operand — the ONLY one production ever evaluates — deleted and
   * every assertion still passed, while every workspace rendered as a raw GUID
   * live. That is the exact defect #3742 is about, so the fixture models the
   * route, not the test. `ws-3` pins the `w.id` tail of the same chain.
   */
  const WORKSPACES = [
    { id: 'ws-1', name: 'Sales analytics' },
    { id: 'ws-2', name: 'Finance' },
    { id: 'ws-3' },
  ];

  it('offers the real workspaces instead of a free-text Scope id box', async () => {
    routeMock({
      '/api/admin/copilot-quality/budgets': { status: 200, body: DASHBOARD },
      '/api/workspaces': { status: 200, body: WORKSPACES },
    });
    mount(<TokenBudgetPanel />);

    await userEvent.click(await screen.findByRole('button', { name: 'New budget' }));

    const dialog = await screen.findByRole('dialog');
    // The free-text field the issue names is gone...
    expect(within(dialog).queryByLabelText('Scope id')).toBeNull();
    // ...replaced by a real picker offering the real workspaces by NAME.
    const picker = await within(dialog).findByRole('combobox', { name: /Workspace/i });
    await userEvent.click(picker);
    expect(await screen.findByRole('option', { name: 'Sales analytics' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Finance' })).toBeInTheDocument();
    // A workspace with no name falls back to its id rather than an empty row —
    // an unlabelled option is unpickable, which is the same dead end.
    expect(screen.getByRole('option', { name: 'ws-3' })).toBeInTheDocument();
  });

  it('switching scope to "agent" offers the agents the ledger has actually attributed', async () => {
    routeMock({
      '/api/admin/copilot-quality/budgets': { status: 200, body: DASHBOARD },
      '/api/workspaces': { status: 200, body: [{ id: 'ws-1', name: 'Sales analytics' }] },
    });
    mount(<TokenBudgetPanel />);

    await userEvent.click(await screen.findByRole('button', { name: 'New budget' }));
    const dialog = await screen.findByRole('dialog');

    await userEvent.click(within(dialog).getByRole('combobox', { name: /^Scope$/ }));
    await userEvent.click(await screen.findByRole('option', { name: 'agent' }));

    const picker = await within(dialog).findByRole('combobox', { name: /Agent/i });
    await userEvent.click(picker);
    expect(await screen.findByRole('option', { name: 'SQL helper' })).toBeInTheDocument();
  });

  it('switching scope DISCARDS the id picked under the previous scope', async () => {
    // The handler clears `scopeId` on a scope change, and the docblock beside it
    // says why: a workspace id is never a valid agent id, and enforcement joins
    // on the exact id — so a budget saved against the other scope's identifier
    // is accepted, listed as active, and can never match a usage row. Nothing
    // asserted it, so dropping the `setScopeId('')` statement shipped green.
    routeMock({
      '/api/admin/copilot-quality/budgets': { status: 200, body: DASHBOARD },
      '/api/workspaces': { status: 200, body: [{ id: 'ws-1', name: 'Sales analytics' }] },
    });
    mount(<TokenBudgetPanel />);

    await userEvent.click(await screen.findByRole('button', { name: 'New budget' }));
    const dialog = await screen.findByRole('dialog');

    // Pick a WORKSPACE, so a real id is held.
    await userEvent.click(await within(dialog).findByRole('combobox', { name: /Workspace/i }));
    await userEvent.click(await screen.findByRole('option', { name: 'Sales analytics' }));
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Save' })).toBeEnabled());

    // Now switch the scope. The workspace id must NOT survive into agent scope.
    await userEvent.click(within(dialog).getByRole('combobox', { name: /^Scope$/ }));
    await userEvent.click(await screen.findByRole('option', { name: 'agent' }));

    // Save gates on `scopeId`, so a stale id leaves it enabled — that is the
    // one-click path to the silently-unmatchable budget.
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled());
    // ...and the stale workspace id is not sitting in the Agent field either.
    expect(within(dialog).queryByText('ws-1')).toBeNull();
    expect(within(dialog).queryByDisplayValue('ws-1')).toBeNull();
  });

  it('HONEST FALLBACK — when the workspace list cannot be read the dialog is not a dead end', async () => {
    routeMock({
      '/api/admin/copilot-quality/budgets': { status: 200, body: DASHBOARD },
      '/api/workspaces': { status: 200, body: { workspaces: [] } },
    });
    mount(<TokenBudgetPanel />);

    await userEvent.click(await screen.findByRole('button', { name: 'New budget' }));
    const dialog = await screen.findByRole('dialog');

    // auto-bind-by-default forbids "no items found" + a disabled control. With
    // no real options the operator can still proceed, and is told why.
    await waitFor(() =>
      expect(within(dialog).getByText(/Enter the id directly/i)).toBeInTheDocument(),
    );
    expect(within(dialog).getByRole('textbox', { name: /Workspace/i })).toBeEnabled();
  });
});
