/**
 * Explain-this (W19) — render + contract tests for both entry points.
 *
 * These jsdom tests exercise the REAL components with a mocked `clientFetch`
 * (no network) and assert:
 *   1. ExplainThisButton auto-runs an ITEM-scoped request over the live
 *      definition when its drawer opens, and renders the structured result;
 *   2. the honest no_aoai gate (503) surfaces the warning MessageBar;
 *   3. ExplainNodeDrawer auto-runs a NODE-scoped request carrying the focus
 *      node's definition + its in-canvas neighbors, and titles by node name.
 *
 * Real backend wiring (the AOAI call) is covered by the route's own tests; here
 * we assert the client contract (payload shape + honest states), per
 * no-vaporware.md (no test pretends to exercise the backend).
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';

const clientFetchMock = vi.fn();
vi.mock('@/lib/client-fetch', () => ({ clientFetch: (...a: any[]) => clientFetchMock(...a) }));

import { ExplainThisButton, ExplainNodeDrawer, type ExplainNodeTarget } from '../explain-this';

function wrap(ui: React.ReactElement) {
  return render(<FluentProvider theme={webLightTheme}>{ui}</FluentProvider>);
}

const okResult = {
  ok: true,
  family: 'pipeline',
  scope: 'item',
  explanation: {
    summary: 'Copies orders from Azure SQL into the lakehouse nightly.',
    steps: ['Lookup watermark', 'Copy data'],
    inputs: ['AzureSqlOrders'],
    outputs: ['bronze.orders'],
    risks: ['No retry policy on the Copy activity'],
  },
};

function resolve(body: any, status = 200) {
  clientFetchMock.mockResolvedValue({ ok: status < 400, status, json: async () => body });
}

beforeEach(() => { clientFetchMock.mockReset(); resolve(okResult); });
afterEach(cleanup);

describe('ExplainThisButton (item scope)', () => {
  it('auto-runs an item-scoped request over the live definition and renders the result', async () => {
    const getDefinition = vi.fn(() => ({ properties: { activities: [{ name: 'CopyOrders' }] } }));
    wrap(<ExplainThisButton itemType="data-pipeline" itemId="i1" family="pipeline" getDefinition={getDefinition} />);
    fireEvent.click(screen.getByRole('button', { name: /explain/i }));
    await waitFor(() => expect(clientFetchMock).toHaveBeenCalled());
    const [url, opts] = clientFetchMock.mock.calls[0];
    expect(url).toBe('/api/items/data-pipeline/i1/explain');
    const payload = JSON.parse(opts.body);
    expect(payload.scope).toBe('item');
    expect(payload.definition.properties.activities[0].name).toBe('CopyOrders');
    expect(await screen.findByText(/Copies orders from Azure SQL/)).toBeInTheDocument();
    expect(screen.getByText('No retry policy on the Copy activity')).toBeInTheDocument();
  });

  it('surfaces the honest no_aoai warning gate on a 503', async () => {
    resolve({ ok: false, code: 'no_aoai', hint: 'Set LOOM_AOAI_ENDPOINT and LOOM_AOAI_DEPLOYMENT.' }, 503);
    wrap(<ExplainThisButton itemType="data-pipeline" itemId="i1" family="pipeline" getDefinition={() => ({ properties: {} })} />);
    fireEvent.click(screen.getByRole('button', { name: /explain/i }));
    expect(await screen.findByText(/Azure OpenAI not configured/i)).toBeInTheDocument();
    expect(screen.getByText(/LOOM_AOAI_ENDPOINT/)).toBeInTheDocument();
  });
});

describe('ExplainNodeDrawer (node scope)', () => {
  const node: ExplainNodeTarget = {
    name: 'CopyOrders',
    definition: { name: 'CopyOrders', type: 'Copy' },
    upstream: ['GetWatermark'],
    downstream: ['NotifyDone'],
  };

  it('auto-runs a node-scoped request with the focus neighbors when opened', async () => {
    resolve({ ...okResult, scope: 'node' });
    wrap(<ExplainNodeDrawer open itemType="data-pipeline" itemId="i1" family="pipeline" node={node} onOpenChange={() => {}} />);
    await waitFor(() => expect(clientFetchMock).toHaveBeenCalled());
    const payload = JSON.parse(clientFetchMock.mock.calls[0][1].body);
    expect(payload.scope).toBe('node');
    expect(payload.definition.name).toBe('CopyOrders');
    expect(payload.focus.upstream).toEqual(['GetWatermark']);
    expect(payload.focus.downstream).toEqual(['NotifyDone']);
    // Titled by the node name.
    expect(await screen.findByText(/Explain "CopyOrders"/)).toBeInTheDocument();
  });

  it('does not fetch while closed', () => {
    wrap(<ExplainNodeDrawer open={false} itemType="data-pipeline" itemId="i1" family="pipeline" node={node} onOpenChange={() => {}} />);
    expect(clientFetchMock).not.toHaveBeenCalled();
  });
});
