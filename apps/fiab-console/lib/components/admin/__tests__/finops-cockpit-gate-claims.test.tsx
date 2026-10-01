/**
 * FinopsCockpitPane — a GATED 200 never renders a confident empty claim
 * (PR #4771, re-review 5898687296 finding 6).
 *
 * `anomalies/route.ts` and `budgets/route.ts` answer HTTP 200 with
 * `{ feed: [] | budgets: [], gate }` when Azure Monitor is not configured.
 * `readState()` deliberately treats that as success (it is not a failed read),
 * so before this fix the pane rendered the GateBar AND, under it, "No
 * anomalies detected" / "No budgets yet" — claims about the customer's spend
 * and budgets that no read established (deploy-integrity R7).
 *
 * Each gated case is paired with a POSITIVE CONTROL (an ungated 200 with an
 * empty list still shows the EmptyState), so deleting the EmptyState cannot
 * satisfy the suite. What breaks each test is stated at its site.
 */
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { FinopsCockpitPane } from '../finops-cockpit-pane';

function mount(ui: React.ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <FluentProvider theme={webLightTheme}>{ui}</FluentProvider>
    </QueryClientProvider>,
  );
}

/** Every finops route answers 200 `{ ok: true }` unless `routes` names it. */
function routeMock(routes: Record<string, unknown>) {
  vi.spyOn(global, 'fetch').mockImplementation(async (input: any) => {
    const url = typeof input === 'string' ? input : String(input);
    const hit = Object.keys(routes).find((k) => url.includes(k));
    const body = hit ? routes[hit] : { ok: true };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }) as any;
  });
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

// Distinct per route, so finding the text proves THAT section's GateBar rendered.
const ANOMALY_GATE = { missing: ['LOOM_COST_SCOPE'], message: 'Anomaly gate for test: Monitor is not configured.' };
const BUDGET_GATE = { missing: ['LOOM_COST_SCOPE'], message: 'Budget gate for test: Monitor is not configured.' };

describe('FinopsCockpitPane anomalies — a gated 200 is not "no anomalies"', () => {
  it('shows the gate and NOT "No anomalies detected" when the feed is gated', async () => {
    routeMock({ '/api/admin/finops/anomalies': { ok: true, rules: [], feed: [], gate: ANOMALY_GATE } });
    mount(<FinopsCockpitPane />);
    await waitFor(() => expect(screen.getByText(/Anomaly gate for test/)).toBeInTheDocument());
    // Breaks if `anomaliesQ.data?.gate ? null :` is removed: the empty `feed`
    // falls through to the EmptyState under the GateBar.
    expect(screen.queryByText('No anomalies detected')).toBeNull();
  });

  it('POSITIVE CONTROL: an ungated 200 with an empty feed still says "No anomalies detected"', async () => {
    routeMock({ '/api/admin/finops/anomalies': { ok: true, rules: [], feed: [] } });
    mount(<FinopsCockpitPane />);
    // Breaks if the EmptyState is deleted, or gated on something a healthy
    // empty feed does not satisfy.
    await waitFor(() => expect(screen.getByText('No anomalies detected')).toBeInTheDocument());
    expect(screen.queryByText(/Anomaly gate for test/)).toBeNull();
  });
});

describe('FinopsCockpitPane budgets — a gated 200 is not "no budgets"', () => {
  it('shows the gate and NOT "No budgets yet" when the budget list is gated', async () => {
    routeMock({ '/api/admin/finops/budgets': { ok: true, budgets: [], gate: BUDGET_GATE } });
    mount(<FinopsCockpitPane />);
    await waitFor(() => expect(screen.getByText(/Budget gate for test/)).toBeInTheDocument());
    // Breaks if `budgetsQ.data?.gate ? null :` is removed.
    expect(screen.queryByText('No budgets yet')).toBeNull();
  });

  it('POSITIVE CONTROL: an ungated 200 with no budgets still says "No budgets yet"', async () => {
    routeMock({ '/api/admin/finops/budgets': { ok: true, budgets: [], currency: 'USD', subscriptions: [] } });
    mount(<FinopsCockpitPane />);
    await waitFor(() => expect(screen.getByText('No budgets yet')).toBeInTheDocument());
    expect(screen.queryByText(/Budget gate for test/)).toBeNull();
  });
});
