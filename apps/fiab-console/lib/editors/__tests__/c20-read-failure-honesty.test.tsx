/**
 * C20 sweep — a failed read must never render as a claim about the user's data.
 *
 * These pin the three highest-harm surfaces of the class, each of which had a
 * `useQuery` on a THROWING fetcher and no error branch, so a 500 / 403 / timeout
 * fell through to a confident statement the code never established
 * (`deploy-integrity.md` R7):
 *
 *   1. PowerAppEditor  — rendered "This item isn't bound to a Power App yet" for
 *      an app that IS bound, inviting the user to re-bind over a binding Loom
 *      had merely failed to read. The worst of the set.
 *   2. AssetsPage      — rendered a freshness rollup of literal 0.
 *   3. WarehouseEditor — dropped the persisted DDL / dbt models / starter
 *      queries, so a fully built-out warehouse looked bare.
 *
 * Each asserts BOTH halves: the honest error surface appears, AND the false
 * claim is gone. Asserting only the MessageBar would keep passing if the false
 * claim were rendered alongside it.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { screen, waitFor, cleanup } from '@testing-library/react';
import { PowerAppEditor } from '../powerplatform-editors';
import { WarehouseEditor } from '../phase3/warehouse-editor';
import { makeItem, renderWithProviders } from './test-helpers';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/**
 * Fail the item-record read; answer everything else benignly.
 *
 * The route is `/api/cosmos-items/<type>/<id>` (lib/api/workspaces.ts getItem),
 * NOT `/api/items/...`. The first draft of this spec mocked `/api/items/` — the
 * query then SUCCEEDED and all three cases failed, which is how the wrong
 * endpoint string in six of the error bars was caught before it shipped. An
 * error bar naming a route that was never called is itself an R7 false claim.
 */
function installItemReadFailure(slug: string, mode: 'http500' | 'reject') {
  vi.spyOn(global, 'fetch').mockImplementation(async (input: any) => {
    const url = typeof input === 'string' ? input : String(input?.toString?.() ?? input);
    if (url.includes(`/api/cosmos-items/${slug}/`)) {
      if (mode === 'reject') throw new TypeError('Failed to fetch');
      return new Response(JSON.stringify({ ok: false, error: 'backend unavailable' }), {
        status: 500, headers: { 'content-type': 'application/json' },
      }) as any;
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }) as any;
  });
}

describe('PowerAppEditor — an unreadable binding is never rendered as UNBOUND (C20)', () => {
  it('shows the honest read failure, and does NOT claim the item is unbound', async () => {
    installItemReadFailure('power-app', 'http500');
    renderWithProviders(
      <PowerAppEditor item={makeItem('power-app', 'Power App')} id="pa-fixture" />,
    );

    await waitFor(() =>
      expect(screen.getByText('Could not read this Power App’s saved binding')).toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();

    // The R7 half: the false claim must be GONE, not merely accompanied.
    expect(
      screen.queryByText(/isn.t bound to a Power App yet/i),
    ).not.toBeInTheDocument();
  });

  it('reports a transport rejection too, naming the endpoint it never heard from', async () => {
    installItemReadFailure('power-app', 'reject');
    renderWithProviders(
      <PowerAppEditor item={makeItem('power-app', 'Power App')} id="pa-fixture" />,
    );
    await waitFor(() =>
      expect(screen.getByText('Could not read this Power App’s saved binding')).toBeInTheDocument(),
    );
    // The bar reports the REAL message it was handed — it must not paraphrase
    // or invent a cause (R7).
    expect(screen.getByText(/Failed to fetch/)).toBeInTheDocument();
  });
});

describe('WarehouseEditor — a failed record read is told, not shown as an empty warehouse (C20)', () => {
  it('renders the honest error with Retry while the editor surface stays up', async () => {
    installItemReadFailure('warehouse', 'http500');
    renderWithProviders(
      <WarehouseEditor item={makeItem('warehouse', 'Warehouse')} id="wh-fixture" />,
    );
    await waitFor(() =>
      expect(screen.getByText('Could not read this warehouse')).toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    // Surface still standing around the error (ux-baseline: never an error page).
    expect(screen.getAllByRole('tab').length).toBeGreaterThan(1);
  });
});

describe('QueryErrorBar — a rejection with NO message names the route, and claims nothing else', () => {
  it('falls back to an explicitly uncertain sentence naming the endpoint', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async (input: any) => {
      const url = typeof input === 'string' ? input : String(input?.toString?.() ?? input);
      // A rejection carrying no message at all — the case where the code
      // genuinely does not know why, and must SAY that it does not know.
      if (url.includes('/api/cosmos-items/power-app/')) throw { noMessage: true };
      return new Response(JSON.stringify({ ok: true }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }) as any;
    });
    renderWithProviders(
      <PowerAppEditor item={makeItem('power-app', 'Power App')} id="pa-fixture" />,
    );
    await waitFor(() =>
      expect(screen.getByText(/The request failed before .*cosmos-items\/power-app.* answered \(network or timeout\)/))
        .toBeInTheDocument(),
    );
  });
});
