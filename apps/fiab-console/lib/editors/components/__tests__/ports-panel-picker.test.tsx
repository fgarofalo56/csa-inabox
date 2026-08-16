/**
 * PortsPanel — the upstream-ref adoption (Vitest, jsdom).
 *
 * The defect: an input port of kind `data-product` / `output-port` points at
 * ANOTHER LOOM ITEM by its Loom item id, and the row asked the user to type that
 * id as free text (`dp-123 or abfss://…`). Every id it can accept is one Loom
 * already has.
 *
 * These tests hold the three things the replacement must not get wrong:
 *   - it lists from the CALLER-SCOPED lister, and a product outside that scope
 *     never appears (an unscoped list would leak product display names from
 *     workspaces the user cannot open — the route-level proof lives in
 *     app/api/items/by-type/__tests__/{workspace-scope,tenant-browse}.test.ts);
 *   - a stored upstream the caller cannot currently resolve still renders AND
 *     still round-trips through save → reload unchanged;
 *   - an empty product list leaves the surface usable.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { installFetchMock } from '@/lib/editors/__tests__/test-helpers';
import { PortsPanel, refProductId, withProductId } from '../ports-panel';

const HOST = 'dp-host';

/** Ports as stored on the product: one input port pinned to an upstream the
 *  caller can no longer resolve (deleted, or in a workspace they lost access to). */
function storedPorts(ref = 'dp-GONE') {
  return {
    ok: true,
    ports: {
      input: [{ id: 'in-1', name: 'upstream', direction: 'input', kind: 'data-product', ref }],
      output: [],
      management: [],
    },
    summary: { input: 1, output: 0, management: 0, total: 1 },
  };
}

/** The route only ever returns products the caller may see. `dp-Z` is NOT here
 *  — it is the out-of-scope control. */
const VISIBLE_PRODUCTS = {
  ok: true,
  items: [
    { id: 'dp-1', itemType: 'data-product', displayName: 'Curated sales', description: 'gold' },
    { id: 'dp-2', itemType: 'data-product', displayName: 'Customer 360' },
  ],
};

function mount() {
  return render(
    <FluentProvider theme={webLightTheme}>
      <PortsPanel id={HOST} />
    </FluentProvider>,
  );
}

describe('refProductId / withProductId — the output-port `<productId>:<portId>` split', () => {
  it('reads the product half of an output-port ref', () => {
    expect(refProductId('dp-1:out-3')).toBe('dp-1');
    expect(refProductId('dp-1')).toBe('dp-1');
    expect(refProductId(undefined)).toBe('');
  });

  it('replacing the product PRESERVES the port suffix the user already chose', () => {
    expect(withProductId('dp-1:out-3', 'dp-2')).toBe('dp-2:out-3');
    expect(withProductId('dp-1', 'dp-2')).toBe('dp-2');
    expect(withProductId('dp-1:out-3', '')).toBe('');
  });
});

describe('PortsPanel — upstream data product is picked, not typed', () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => { cleanup(); });

  it('lists upstream products from the CALLER-SCOPED lister', async () => {
    const { calls } = installFetchMock({
      [`/api/data-products/${HOST}/ports`]: () => storedPorts(''),
      '/api/items/by-type': () => VISIBLE_PRODUCTS,
    });
    mount();
    const dd = await screen.findByRole('combobox', { name: 'Upstream data product' });
    fireEvent.click(dd);
    await waitFor(() => expect(screen.getByText('Curated sales')).toBeInTheDocument());

    const listCall = calls.find((c) => c.url.includes('/api/items/by-type'));
    expect(listCall).toBeTruthy();
    // The scoped lister, asked for exactly one item type — not a tenant-wide
    // `types=all` scan and not an unauthenticated catalog search.
    expect(listCall!.url).toContain('types=data-product');
  });

  it('a product OUTSIDE the caller’s scope never appears as an option', async () => {
    installFetchMock({
      [`/api/data-products/${HOST}/ports`]: () => storedPorts(''),
      '/api/items/by-type': () => VISIBLE_PRODUCTS, // dp-Z deliberately withheld
    });
    mount();
    const dd = await screen.findByRole('combobox', { name: 'Upstream data product' });
    fireEvent.click(dd);
    await waitFor(() => expect(screen.getByText('Curated sales')).toBeInTheDocument());
    expect(screen.queryByText('Out-of-scope product')).toBeNull();
    expect(screen.queryByText('dp-Z')).toBeNull();
  });

  it('the free-text upstream-ref box is gone', async () => {
    installFetchMock({
      [`/api/data-products/${HOST}/ports`]: () => storedPorts(''),
      '/api/items/by-type': () => VISIBLE_PRODUCTS,
    });
    mount();
    await screen.findByRole('combobox', { name: 'Upstream data product' });
    expect(screen.queryByText('Upstream ref (product id / asset)')).toBeNull();
    // …and nothing teaches the user to compose a storage URI here any more.
    expect(document.querySelector('input[placeholder*="abfss"]')).toBeNull();
  });

  it('an UNRESOLVABLE stored upstream survives render → save → reload', async () => {
    const { calls } = installFetchMock({
      [`/api/data-products/${HOST}/ports`]: () => storedPorts('dp-GONE'),
      [`/api/data-products/${HOST}`]: () => ({ ok: true }),
      '/api/items/by-type': () => VISIBLE_PRODUCTS, // cannot resolve dp-GONE
    });
    mount();

    // 1. RENDER — the stored id is shown, not blanked.
    const dd = await screen.findByRole('combobox', { name: 'Upstream data product' });
    await waitFor(() => expect((dd as HTMLInputElement).value).toBe('dp-GONE'));
    expect(screen.getByText(/not in the products you can see right now/i)).toBeInTheDocument();

    // 2. SAVE — the PATCH must carry the ORIGINAL ref. A picker that computed
    //    its selection from the fetched list would send `ref: undefined` here
    //    and silently drop the dependency.
    fireEvent.click(screen.getByRole('button', { name: /save ports/i }));
    await waitFor(() => {
      const patch = calls.find((c) => c.init?.method === 'PATCH');
      expect(patch).toBeTruthy();
      const body = JSON.parse(String(patch!.init!.body));
      expect(body.ports.input[0].ref).toBe('dp-GONE');
    });

    // 3. RELOAD — save() refetches; the value is still there afterwards.
    await waitFor(() => {
      const reloads = calls.filter((c) => c.url.includes(`/api/data-products/${HOST}/ports`));
      expect(reloads.length).toBeGreaterThan(1);
    });
    await waitFor(() =>
      expect((screen.getByRole('combobox', { name: 'Upstream data product' }) as HTMLInputElement).value)
        .toBe('dp-GONE'));
  });

  it('stays usable when there are no other data products', async () => {
    installFetchMock({
      [`/api/data-products/${HOST}/ports`]: () => storedPorts(''),
      '/api/items/by-type': () => ({ ok: true, items: [] }),
    });
    mount();
    await waitFor(() => expect(screen.getByText('No other data products yet')).toBeInTheDocument());
    const dd = screen.getByRole('combobox', { name: 'Upstream data product' });
    expect(dd).not.toBeDisabled();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeInTheDocument();
    // The row's other controls are untouched — an empty upstream list must not
    // take the whole port editor down with it.
    expect(screen.getByRole('button', { name: /save ports/i })).toBeEnabled();
  });

  it('a failed product list is reported as an error, never as "there are none"', async () => {
    installFetchMock({
      [`/api/data-products/${HOST}/ports`]: () => storedPorts('dp-GONE'),
      '/api/items/by-type': () => ({ ok: false, error: 'workspace not found' }),
    });
    mount();
    await waitFor(() => expect(screen.getByText('workspace not found')).toBeInTheDocument());
    expect(screen.queryByText('No other data products yet')).toBeNull();
    // The stored dependency is still visible through the outage.
    expect((screen.getByRole('combobox', { name: 'Upstream data product' }) as HTMLInputElement).value)
      .toBe('dp-GONE');
  });

  it('picking a product writes its Loom item id to the port ref', async () => {
    const { calls } = installFetchMock({
      [`/api/data-products/${HOST}/ports`]: () => storedPorts(''),
      [`/api/data-products/${HOST}`]: () => ({ ok: true }),
      '/api/items/by-type': () => VISIBLE_PRODUCTS,
    });
    mount();
    const dd = await screen.findByRole('combobox', { name: 'Upstream data product' });
    fireEvent.click(dd);
    fireEvent.click(await screen.findByText('Customer 360'));
    fireEvent.click(screen.getByRole('button', { name: /save ports/i }));
    await waitFor(() => {
      const patch = calls.find((c) => c.init?.method === 'PATCH');
      expect(patch).toBeTruthy();
      expect(JSON.parse(String(patch!.init!.body)).ports.input[0].ref).toBe('dp-2');
    });
  });
});
