/**
 * Monitor → Cost tab, "Cost breakdown" grouped by Tag (#4771 round 7, review
 * 5903102490 finding B-1).
 *
 * The defect: `tagLoadState(null)` returned `none`, so with Group by = Tag the
 * breakdown section said "No cost-allocation tags found" whenever NO summary
 * had been read — on first load, after a gateway 504, after a non-JSON body,
 * after `ok:false`, under a gate, after a 401. Nothing was read, so nothing
 * may be claimed.
 *
 * This mounts the REAL `CostTab` with `fetch` stubbed per case, selects
 * Group by = Tag through the real dropdown, and reads the breakdown section.
 * Each null case asserts BOTH halves: the tag site was reached (the skeleton
 * or the neutral "Tag breakdown unavailable" notice is present) AND the none
 * claim is absent — so an absence assertion cannot be satisfied by the site
 * never rendering. A positive control shows the none text DOES render, at
 * this site, for a genuine empty answer.
 *
 * What breaks each test is stated at its site.
 */
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { CostTab } from '../monitor-pane';

const NONE_TEXT = /No cost-allocation tags found/;

function stubFetch(answer: () => Promise<Response>) {
  const spy = vi.spyOn(global, 'fetch').mockImplementation(async (input: any) => {
    const url = typeof input === 'string' ? input : String(input);
    if (url.includes('/api/monitor/cost')) return answer();
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  return spy;
}
const text = (status: number, body: string, type = 'text/html') =>
  async () => new Response(body, { status, headers: { 'content-type': type } });
const json = (status: number, body: unknown) => text(status, JSON.stringify(body), 'application/json');

function mount(onUnauth = () => {}) {
  return render(<FluentProvider theme={webLightTheme}><CostTab onUnauth={onUnauth} /></FluentProvider>);
}

async function groupByTag() {
  await userEvent.click(await screen.findByRole('combobox', { name: 'Group cost breakdown by' }));
  await userEvent.click(await screen.findByRole('option', { name: /^Tag · / }));
}

const EMPTY_SUMMARY = {
  currency: 'USD', timeframe: 'MonthToDate', monthToDate: 0, previousPeriod: null, trendPct: null, forecast: 0,
  byService: [], byResourceGroup: [], bySubscription: [], byResource: [], byResourceType: [], byLocation: [],
  byTag: [], tagKey: 'Environment', tagQueryErrors: [], daily: [], anomalies: [], budgets: [],
  loomResourceGroups: ['rg-a'], subscriptions: ['sub-a'], subscriptionNames: {}, subscriptionErrors: [],
};

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('CostTab — Group by Tag never claims "no tags" when nothing was read', () => {
  it('still loading: a skeleton at the tag site, no claim', async () => {
    stubFetch(() => new Promise<Response>(() => {}));
    mount();
    await groupByTag();
    // Positive half: breaks if the breakdown site does not pass `loading` (the
    // neutral notice would render instead of the skeleton).
    expect(await screen.findByLabelText('Loading the tag breakdown')).toBeInTheDocument();
    // Breaks on the R7 defect: tagLoadState(null) → none → the claim renders.
    expect(screen.queryByText(NONE_TEXT)).toBeNull();
  });

  const FAILED_READS: [string, () => Promise<Response>, RegExp][] = [
    ['a gateway 504 with an HTML body', text(504, '<html>Gateway Timeout</html>'), /timed out at the gateway/],
    ['a non-JSON 200', text(200, 'not json'), /non-JSON response \(HTTP 200\)/],
    ['ok:false', json(500, { ok: false, error: 'cost read failed for test' }), /cost read failed for test/],
    ['a gate', json(200, { ok: true, gate: { missing: ['LOOM_MONITOR_SUBSCRIPTION_ID'], message: 'gate for test' } }), /Cost not configured/],
  ];
  for (const [name, answer, reason] of FAILED_READS) {
    it(`${name}: the neutral notice, never "no tags found"`, async () => {
      stubFetch(answer);
      mount();
      // The pane's own reason for the failed read is on screen first, so the
      // read has settled before the tag site is inspected.
      expect(await screen.findByText(reason)).toBeInTheDocument();
      await groupByTag();
      // Positive half: breaks if `unknown` renders null or a spinner — the tag
      // site would then say nothing and the absence below would be vacuous.
      expect(await screen.findByText('Tag breakdown unavailable')).toBeInTheDocument();
      // Breaks on the R7 defect: a null summary read as `none`.
      expect(screen.queryByText(NONE_TEXT)).toBeNull();
    });
  }

  it('a 401: onUnauth fires and the tag site claims nothing', async () => {
    stubFetch(json(401, { error: 'forbidden for test' }));
    const onUnauth = vi.fn();
    mount(onUnauth);
    await waitFor(() => expect(onUnauth).toHaveBeenCalled());
    await groupByTag();
    // A 401 leaves data null with no err and no gate, so the pane still reads
    // as loading: breaks if that state reaches the none claim.
    expect(await screen.findByLabelText('Loading the tag breakdown')).toBeInTheDocument();
    expect(screen.queryByText(NONE_TEXT)).toBeNull();
  });

  it('POSITIVE CONTROL: a genuine empty answer says "no tags found" at the breakdown site', async () => {
    stubFetch(json(200, { ok: true, data: EMPTY_SUMMARY }));
    mount();
    // Before grouping by Tag the claim appears ONCE: the dedicated tag section.
    await waitFor(() => expect(screen.getAllByText(NONE_TEXT)).toHaveLength(1));
    await groupByTag();
    // Breaks if the breakdown site stops rendering the notice for a real empty
    // answer (e.g. `unknown` applied to every empty result): the count would
    // stay 1. This is what keeps the absence assertions above from being
    // satisfied by deleting the notice.
    await waitFor(() => expect(screen.getAllByText(NONE_TEXT)).toHaveLength(2));
    expect(screen.queryByText('Tag breakdown unavailable')).toBeNull();
  });

  it('Retry on the neutral notice re-reads the summary', async () => {
    const spy = stubFetch(json(500, { ok: false, error: 'cost read failed for test' }));
    mount();
    await screen.findByText(/cost read failed for test/);
    await groupByTag();
    await screen.findByText('Tag breakdown unavailable');
    const before = spy.mock.calls.filter(([u]) => String(u).includes('/api/monitor/cost')).length;
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    // Breaks if Retry is not wired to the pane's re-read (`setTick`): the cost
    // route would be called no further times.
    await waitFor(() => expect(spy.mock.calls.filter(([u]) => String(u).includes('/api/monitor/cost')).length).toBe(before + 1));
  });
});
