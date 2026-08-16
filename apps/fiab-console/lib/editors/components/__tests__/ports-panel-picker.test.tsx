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
function storedPorts(ref = 'dp-GONE', kind = 'data-product') {
  return {
    ok: true,
    ports: {
      input: [{ id: 'in-1', name: 'upstream', direction: 'input', kind, ref }],
      output: [],
      management: [],
    },
    summary: { input: 1, output: 0, management: 0, total: 1 },
  };
}

/** An input port whose ref is a data-plane ASSET, not a Loom item — the branch
 *  that still ships a free-text `<Input>` (declared gap in the file header). */
function assetPorts(ref = 'sales/bronze') {
  return {
    ok: true,
    ports: {
      input: [{ id: 'in-1', name: 'raw', direction: 'input', kind: 'adls-path', ref }],
      output: [],
      management: [],
    },
    summary: { input: 1, output: 0, management: 0, total: 1 },
  };
}

const IN_SCOPE = [
  { id: 'dp-1', itemType: 'data-product', displayName: 'Curated sales', description: 'gold' },
  { id: 'dp-2', itemType: 'data-product', displayName: 'Customer 360' },
];
/** The product the ROUTE withholds because the caller cannot see its workspace. */
const OUT_OF_SCOPE = { id: 'dp-Z', itemType: 'data-product', displayName: 'Out-of-scope product' };

const VISIBLE_PRODUCTS = { ok: true, items: IN_SCOPE };

function mount() {
  return render(
    <FluentProvider theme={webLightTheme}>
      <PortsPanel id={HOST} />
    </FluentProvider>,
  );
}

describe('refProductId / withProductId — kind-aware ref splitting', () => {
  it('reads the product half of an output-port ref', () => {
    expect(refProductId('dp-1:out-3', 'output-port')).toBe('dp-1');
    expect(refProductId('dp-1', 'output-port')).toBe('dp-1');
    expect(refProductId(undefined, 'output-port')).toBe('');
  });

  it('replacing the product PRESERVES the port suffix the user already chose', () => {
    expect(withProductId('dp-1:out-3', 'dp-2', 'output-port')).toBe('dp-2:out-3');
    expect(withProductId('dp-1', 'dp-2', 'output-port')).toBe('dp-2');
    expect(withProductId('dp-1:out-3', '', 'output-port')).toBe('');
  });

  it('a data-product ref is the id WHOLE — the split must not touch it', () => {
    // The free-text placeholder this panel used to ship (`dp-123 or abfss://…`)
    // invited exactly this value. Splitting on ':' read the product as `abfss`
    // and re-joining wrote `dp-2://c/p` — a corrupted ref pointing at nothing.
    expect(refProductId('abfss://c/p', 'data-product')).toBe('abfss://c/p');
    expect(withProductId('abfss://c/p', 'dp-2', 'data-product')).toBe('dp-2');
  });

  it('a URI under an OUTPUT-PORT kind is still not a `<product>:<port>` split', () => {
    expect(refProductId('abfss://c/p', 'output-port')).toBe('abfss://c/p');
    expect(withProductId('abfss://c/p', 'dp-2', 'output-port')).toBe('dp-2');
  });

  it('never emits a ref containing `://` after a pick', () => {
    for (const kind of ['data-product', 'output-port'] as const) {
      for (const legacy of ['abfss://c/p', 'https://x/y', 's3://b/k', 'dp-1:out-3', 'dp-1', '']) {
        expect(withProductId(legacy, 'dp-2', kind)).not.toContain('://');
      }
    }
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

  it('renders only what the route returned — a product it withheld never appears', async () => {
    // POSITIVE CONTROL FIRST: when the route DOES return dp-Z the option is
    // there. Without this the negative below is vacuous — nothing in the client
    // could have produced dp-Z, so asserting its absence proves nothing.
    installFetchMock({
      [`/api/data-products/${HOST}/ports`]: () => storedPorts(''),
      '/api/items/by-type': () => ({ ok: true, items: [...IN_SCOPE, OUT_OF_SCOPE] }),
    });
    mount();
    fireEvent.click(await screen.findByRole('combobox', { name: 'Upstream data product' }));
    await waitFor(() => expect(screen.getByText('Out-of-scope product')).toBeInTheDocument());
    cleanup();

    // NEGATIVE: the route withholds it (the caller cannot see its workspace) and
    // the client neither caches nor synthesizes it.
    vi.restoreAllMocks();
    installFetchMock({
      [`/api/data-products/${HOST}/ports`]: () => storedPorts(''),
      '/api/items/by-type': () => VISIBLE_PRODUCTS,
    });
    mount();
    fireEvent.click(await screen.findByRole('combobox', { name: 'Upstream data product' }));
    await waitFor(() => expect(screen.getByText('Curated sales')).toBeInTheDocument());
    expect(screen.queryByText('Out-of-scope product')).toBeNull();
  });

  it('fetches the product list ONCE for the whole panel, not once per row', async () => {
    const { calls } = installFetchMock({
      [`/api/data-products/${HOST}/ports`]: () => ({
        ok: true,
        ports: {
          input: [
            { id: 'in-1', name: 'a', direction: 'input', kind: 'data-product', ref: '' },
            { id: 'in-2', name: 'b', direction: 'input', kind: 'data-product', ref: '' },
            { id: 'in-3', name: 'c', direction: 'input', kind: 'output-port', ref: '' },
          ],
          output: [], management: [],
        },
        summary: { input: 3, output: 0, management: 0, total: 3 },
      }),
      '/api/items/by-type': () => VISIBLE_PRODUCTS,
    });
    mount();
    await waitFor(() => expect(screen.getAllByRole('combobox', { name: 'Upstream data product' })).toHaveLength(3));
    // `/api/items/by-type` is a cross-partition Cosmos scan; three rows must not
    // mean three scans.
    expect(calls.filter((c) => c.url.includes('/api/items/by-type'))).toHaveLength(1);
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

  it('DECLARED GAP: an asset-kind port still ships a free-text ref box', async () => {
    // Not an endorsement — a lock on the honest statement in the file header, so
    // "the guard counts 0" can never be read as "no free-text ask remains".
    installFetchMock({
      [`/api/data-products/${HOST}/ports`]: () => assetPorts('sales/bronze'),
      '/api/items/by-type': () => VISIBLE_PRODUCTS,
    });
    mount();
    await waitFor(() => expect(screen.getByDisplayValue('sales/bronze')).toBeInTheDocument());
    expect(screen.queryByRole('combobox', { name: 'Upstream data product' })).toBeNull();
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

  it('a stored ref with surrounding whitespace still renders and still selects', async () => {
    // These fields were free text people pasted into, so ' dp-1 ' is realistic.
    // A merge that trims while the lookup does not leaves a BLANK required field
    // with no warning — the exact symptom the picker exists to prevent.
    installFetchMock({
      [`/api/data-products/${HOST}/ports`]: () => storedPorts(' dp-1 '),
      '/api/items/by-type': () => VISIBLE_PRODUCTS,
    });
    mount();
    const dd = await screen.findByRole('combobox', { name: 'Upstream data product' });
    await waitFor(() => expect((dd as HTMLInputElement).value).toBe('Curated sales'));
    // It resolved, so it must NOT be flagged unresolved.
    expect(screen.queryByText(/not in the products you can see right now/i)).toBeNull();
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

  it('picking a product on a LEGACY URI ref replaces it whole — never `dp-2://…`', async () => {
    const { calls } = installFetchMock({
      [`/api/data-products/${HOST}/ports`]: () => storedPorts('abfss://c@a.dfs.core.windows.net/p'),
      [`/api/data-products/${HOST}`]: () => ({ ok: true }),
      '/api/items/by-type': () => VISIBLE_PRODUCTS,
    });
    mount();
    const dd = await screen.findByRole('combobox', { name: 'Upstream data product' });
    await waitFor(() => expect((dd as HTMLInputElement).value).toBe('abfss://c@a.dfs.core.windows.net/p'));
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
