/**
 * FinopsCockpitPane — the Spend breakdown section (PR #4771, review comment
 * 5894822431 findings 1 and 2).
 *
 * Two things are pinned here, each through the REAL pane with per-route fetch
 * mocking (the same harness as `l5a-confident-state-honesty.test.tsx`):
 *
 *   1. The "No breakdown data" EmptyState is a claim about the customer's
 *      spend. It must not render when the breakdown READ failed. `getJson`
 *      resolves a non-2xx instead of throwing, so a 504 is the discriminating
 *      shape: react-query's own `isError` stays false and only `readState()`
 *      sees it. Paired with a positive control (a 200 with no rows still shows
 *      the EmptyState), so deleting the EmptyState cannot satisfy the suite.
 *   2. On the `tag` dimension the section renders `CostTagNotice` from the
 *      forwarded `tagQueryErrors`, so a throttled or refused tag query is told
 *      apart from "no tags found".
 *
 * What breaks each test is stated at its site.
 */
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

/**
 * Every finops route answers 200 `{ ok: true }` except the breakdown, whose
 * status and body are chosen per test (and may depend on the requested
 * dimension, read from the URL).
 */
function routeMock(breakdown: (url: string) => { status: number; body: unknown }) {
  vi.spyOn(global, 'fetch').mockImplementation(async (input: any) => {
    const url = typeof input === 'string' ? input : String(input);
    const r = url.includes('/api/admin/finops/breakdown') ? breakdown(url) : { status: 200, body: { ok: true } };
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } }) as any;
  });
}

async function pickTagDimension() {
  await userEvent.click(await screen.findByRole('combobox', { name: 'Breakdown dimension' }));
  await userEvent.click(await screen.findByRole('option', { name: 'tag' }));
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const TAG_ERRORS = [{ subscription: 'bbbbbbbb-0000-0000-0000-000000000002', error: 'Too many requests for test' }];
const ok = (body: Record<string, unknown>) => ({ status: 200, body: { ok: true, ...body } });

describe('FinopsCockpitPane breakdown — a failed read is never a confident empty state', () => {
  it('shows the read-failure bar and NOT "No breakdown data" when the breakdown read answers 504', async () => {
    routeMock(() => ({ status: 504, body: { ok: false, error: 'timed out for test' } }));
    mount(<FinopsCockpitPane />);
    // This reassurance text belongs to the breakdown QueryErrorBar only, so its
    // presence proves the 504 was seen by readState(breakdownQ).
    await waitFor(() => expect(screen.getByText(/whether there is spend to break down/)).toBeInTheDocument());
    // Breaks if the `readState(breakdownQ).isError ? null :` gate is removed or
    // narrowed to react-query's own `breakdownQ.isError` (false on a resolved
    // 504): the EmptyState then renders under the failure bar.
    expect(screen.queryByText('No breakdown data')).toBeNull();
  });

  it('POSITIVE CONTROL: a 200 with no rows still shows the guided EmptyState', async () => {
    routeMock(() => ok({ rows: [], total: 0 }));
    mount(<FinopsCockpitPane />);
    // Breaks if the EmptyState is deleted or gated on something a healthy empty
    // read does not satisfy.
    await waitFor(() => expect(screen.getByText('No breakdown data')).toBeInTheDocument());
    expect(screen.queryByText(/whether there is spend to break down/)).toBeNull();
  });
});

describe('FinopsCockpitPane breakdown — the tag dimension tells a failed tag query from "no tags"', () => {
  it('partial: rows AND tagQueryErrors show the partial notice above the chart', async () => {
    routeMock((url) => ok({
      rows: url.includes('dimension=tag') ? [{ key: 'commercial', cost: 5 }] : [{ key: 'svc', cost: 5 }],
      total: 5, tagKey: 'Environment', tagQueryErrors: TAG_ERRORS,
    }));
    mount(<FinopsCockpitPane />);
    await pickTagDimension();
    // Breaks if the rows-present branch drops `<CostTagNotice>`, or if the pane
    // stops passing `tagQueryErrors` into it (state becomes `ok`, renders null).
    await waitFor(() => expect(screen.getByText(/omits spend from 1 subscription/)).toBeInTheDocument());
  });

  it('failed: no rows AND tagQueryErrors say "could not be loaded", never "no tags found"', async () => {
    routeMock((url) => ok({
      rows: url.includes('dimension=tag') ? [] : [{ key: 'svc', cost: 5 }],
      total: 5, tagKey: 'Environment', tagQueryErrors: TAG_ERRORS,
    }));
    mount(<FinopsCockpitPane />);
    await pickTagDimension();
    // Breaks if the empty-tag branch renders the generic EmptyState instead of
    // the notice, or if `tagQueryErrors` is dropped (state becomes `none` and
    // the notice claims no tags were found).
    await waitFor(() => expect(screen.getByText(/tag breakdown could not be loaded/)).toBeInTheDocument());
    expect(screen.queryByText(/No cost-allocation tags found/)).toBeNull();
    expect(screen.queryByText('No breakdown data')).toBeNull();
  });

  it('none: no rows and no tagQueryErrors say "no tags found"', async () => {
    routeMock((url) => ok({
      rows: url.includes('dimension=tag') ? [] : [{ key: 'svc', cost: 5 }],
      total: 5, tagKey: 'Environment', tagQueryErrors: [],
    }));
    mount(<FinopsCockpitPane />);
    await pickTagDimension();
    // Breaks if the empty-tag branch renders the generic EmptyState instead of
    // the notice: the tag-specific remediation would be lost.
    await waitFor(() => expect(screen.getByText(/No cost-allocation tags found/)).toBeInTheDocument());
    expect(screen.queryByText('No breakdown data')).toBeNull();
  });

  it('a non-tag dimension with no rows shows the EmptyState, not the tag notice', async () => {
    routeMock(() => ok({ rows: [], total: 0, tagKey: 'Environment', tagQueryErrors: TAG_ERRORS }));
    mount(<FinopsCockpitPane />);
    // Breaks if the `dimension === 'tag'` test is dropped from the empty
    // branch: the service view would then carry a tag failure it never asked about.
    await waitFor(() => expect(screen.getByText('No breakdown data')).toBeInTheDocument());
    expect(screen.queryByText(/could not be loaded/)).toBeNull();
  });

  it('a subscription whose whole cost read failed is disclosed, never "no tags found" (#4771 R7, B-4)', async () => {
    const SUB_ERRORS = [{ subscription: 'cccccccc-0000-0000-0000-000000000003', error: 'AuthorizationFailed for test' }];
    routeMock((url) => ok({
      rows: url.includes('dimension=tag') ? [] : [{ key: 'svc', cost: 5 }],
      total: 5, tagKey: 'Environment', tagQueryErrors: [], subscriptionErrors: SUB_ERRORS,
    }));
    mount(<FinopsCockpitPane />);
    await pickTagDimension();
    // Breaks if the pane does not pass `subscriptionErrors` into tagSummary:
    // with no tag errors and no rows the state would be `none`, and the
    // notice would claim no tags exist for spend it never read.
    await waitFor(() => expect(screen.getByText('Tag breakdown could not be loaded')).toBeInTheDocument());
    expect(screen.getByText(/AuthorizationFailed for test/)).toBeInTheDocument();
    expect(screen.queryByText(/No cost-allocation tags found/)).toBeNull();
  });

  it('Retry on a failed tag notice re-reads the breakdown', async () => {
    routeMock((url) => ok({
      rows: url.includes('dimension=tag') ? [] : [{ key: 'svc', cost: 5 }],
      total: 5, tagKey: 'Environment', tagQueryErrors: TAG_ERRORS,
    }));
    mount(<FinopsCockpitPane />);
    await pickTagDimension();
    const title = await screen.findByText('Tag breakdown could not be loaded');
    // Another panel carries its own Retry, so scope to the tag notice.
    const notice = title.closest('.fui-MessageBar') as HTMLElement;
    expect(notice).not.toBeNull();
    const tagReads = () => (global.fetch as any).mock.calls
      .filter(([u]: [unknown]) => String(u).includes('/api/admin/finops/breakdown') && String(u).includes('dimension=tag')).length;
    const before = tagReads();
    await userEvent.click(within(notice).getByRole('button', { name: 'Retry' }));
    // Breaks if Retry is not wired to `breakdownQ.refetch()`: the tag
    // breakdown would be read no further times.
    await waitFor(() => expect(tagReads()).toBe(before + 1));
  });
});

describe('FinopsCockpitPane breakdown — every dimension discloses a partial breakdown (#4771 R8, B-1)', () => {
  const SUB_ERRORS = [{ subscription: 'dddddddd-0000-0000-0000-000000000004', error: 'AuthorizationFailed for partial test' }];
  const PARTIAL = /omits spend from 1 subscription whose cost read failed/;

  it('service with rows AND subscriptionErrors: the partial notice renders with the chart', async () => {
    routeMock(() => ok({ rows: [{ key: 'svc', cost: 5 }], total: 5, tagQueryErrors: [], subscriptionErrors: SUB_ERRORS }));
    mount(<FinopsCockpitPane />);
    // Positive half: the rows branch was reached, so the chart is on screen.
    expect((await screen.findAllByText(/Spend by service/)).length).toBeGreaterThan(0);
    // Breaks on the B-1 defect: `subscriptionErrors` read only for `tag`, so the
    // service breakdown rendered as complete with no notice at all.
    expect(screen.getByText('Partial breakdown')).toBeInTheDocument();
    expect(screen.getByText(PARTIAL)).toBeInTheDocument();
    // Breaks if the notice drops the error list: the failing subscription and
    // its reason would not be named.
    expect(screen.getByText(/AuthorizationFailed for partial test/)).toBeInTheDocument();
  });

  it('POSITIVE CONTROL: service with rows and NO subscriptionErrors shows the chart and no partial notice', async () => {
    routeMock(() => ok({ rows: [{ key: 'svc', cost: 5 }], total: 5, tagQueryErrors: [], subscriptionErrors: [] }));
    mount(<FinopsCockpitPane />);
    expect((await screen.findAllByText(/Spend by service/)).length).toBeGreaterThan(0);
    // Breaks if the notice renders unconditionally, e.g. on an empty error list.
    expect(screen.queryByText('Partial breakdown')).toBeNull();
  });

  it('service with NO rows but subscriptionErrors: the partial notice, never "No breakdown data"', async () => {
    routeMock(() => ok({ rows: [], total: 0, tagQueryErrors: [], subscriptionErrors: SUB_ERRORS }));
    mount(<FinopsCockpitPane />);
    // Breaks if the empty branch ignores subscriptionErrors: the EmptyState would
    // then claim no service rows for spend it never read.
    expect(await screen.findByText('Partial breakdown')).toBeInTheDocument();
    expect(screen.queryByText('No breakdown data')).toBeNull();
  });

  it('Retry on the partial notice re-reads the service breakdown', async () => {
    routeMock(() => ok({ rows: [{ key: 'svc', cost: 5 }], total: 5, tagQueryErrors: [], subscriptionErrors: SUB_ERRORS }));
    mount(<FinopsCockpitPane />);
    const notice = (await screen.findByText('Partial breakdown')).closest('.fui-MessageBar') as HTMLElement;
    expect(notice).not.toBeNull();
    const reads = () => (global.fetch as any).mock.calls
      .filter(([u]: [unknown]) => String(u).includes('/api/admin/finops/breakdown') && String(u).includes('dimension=service')).length;
    const before = reads();
    await userEvent.click(within(notice).getByRole('button', { name: 'Retry' }));
    // Breaks if the notice's Retry is missing (getByRole throws) or not wired
    // to `breakdownQ.refetch()` (no further read).
    await waitFor(() => expect(reads()).toBe(before + 1));
  });

  it('tag keeps its own notice: subscriptionErrors are not disclosed twice', async () => {
    routeMock(() => ok({ rows: [{ key: 'commercial', cost: 5 }], total: 5, tagKey: 'Environment', tagQueryErrors: [], subscriptionErrors: SUB_ERRORS }));
    mount(<FinopsCockpitPane />);
    await pickTagDimension();
    // Positive half: the tag notice folds the same error into its partial state.
    await waitFor(() => expect(screen.getByText('Partial tag breakdown')).toBeInTheDocument());
    // Breaks if the generic notice is also rendered on `tag`.
    expect(screen.queryByText('Partial breakdown')).toBeNull();
  });

  /** The period-to-date KPI tile, found by its label. */
  const mtdTile = async () => (await screen.findByText('Spend (period to date)')).parentElement as HTMLElement;

  it('the period-to-date tile marks a total that omits subscriptions as partial (#4771 R9)', async () => {
    routeMock(() => ok({ rows: [{ key: 'svc', cost: 5 }], total: 5, tagQueryErrors: [], subscriptionErrors: SUB_ERRORS }));
    mount(<FinopsCockpitPane />);
    const tile = await mtdTile();
    // Positive half: the tile carries the partial read's total.
    await waitFor(() => expect(tile.textContent).toContain('5.00'));
    // Breaks if the tile renders the short total with no marker (B's nit), or
    // if the omitted count is not the length of subscriptionErrors (1 here).
    expect(within(tile).getByText('Partial: 1 subscription omitted')).toBeInTheDocument();
    // Breaks if the marker lands on every KPI tile: only the spend total is
    // short, the forecast, anomaly and budget counts are not read from it.
    // (The partial notice's own body also begins "Partial:", so the pattern is
    // the marker's whole text.)
    expect(screen.getAllByText(/^Partial: \d+ subscriptions? omitted$/)).toHaveLength(1);
  });

  it('POSITIVE CONTROL: a complete total carries no partial marker on the period-to-date tile', async () => {
    routeMock(() => ok({ rows: [{ key: 'svc', cost: 5 }], total: 5, tagQueryErrors: [], subscriptionErrors: [] }));
    mount(<FinopsCockpitPane />);
    const tile = await mtdTile();
    await waitFor(() => expect(tile.textContent).toContain('5.00'));
    // Breaks if the marker renders on an empty error list.
    expect(within(tile).queryByText(/^Partial:/)).toBeNull();
  });
});

describe('FinopsCockpitPane breakdown — loading', () => {
  it('a pending breakdown read holds the panel with a labelled skeleton', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async (input: any) => {
      const url = typeof input === 'string' ? input : String(input);
      if (url.includes('/api/admin/finops/breakdown')) return new Promise<Response>(() => {});
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }) as any;
    });
    mount(<FinopsCockpitPane />);
    // Breaks if the breakdown loading state reverts to a Spinner (no element
    // carries this label) or is dropped altogether.
    expect(await screen.findByLabelText('Loading breakdown')).toBeInTheDocument();
    expect(screen.queryByText('No breakdown data')).toBeNull();
  });

  it('every touched panel holds a labelled skeleton while its read is pending', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(() => new Promise<Response>(() => {}));
    mount(<FinopsCockpitPane />);
    // Each breaks if that panel's loading state reverts to a bare Spinner
    // (no element would carry the label) or is dropped.
    expect(await screen.findByLabelText('Loading anomaly feed')).toBeInTheDocument();
    expect(screen.getByLabelText('Loading breakdown')).toBeInTheDocument();
    expect(screen.getByLabelText('Loading budgets')).toBeInTheDocument();
  });
});
