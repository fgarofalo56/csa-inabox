/**
 * /data-products — ViewToggle + tile/list behaviour (Vitest, jsdom).
 *
 * This page was migrated from a raw Fluent <Table> to LoomDataTable and gained
 * a Tile | List ViewToggle + ItemTile grid. Asserts:
 *   - the ViewToggle renders only when data products exist,
 *   - toggling to List swaps the ItemTile grid for the LoomDataTable
 *     (the list-only "Governance domain" column header appears),
 *   - the chosen view persists to the documented localStorage key.
 *
 * Network is caught by installFetchMock; next/navigation is stubbed by
 * vitest.setup.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { installFetchMock } from '@/lib/editors/__tests__/test-helpers';
import DataProductsPage from '../page';

const LS_KEY = 'loom.dataProducts.viewMode.v1';

const PRODUCTS = [
  { id: 'p1', displayName: 'Customer 360', type: 'Master', status: 'PUBLISHED', governanceDomainName: 'Finance', endorsed: true, purviewRegistered: true },
  { id: 'p2', displayName: 'Sales draft', type: 'Analytical', status: 'DRAFT', governanceDomainName: 'Sales', endorsed: false, purviewRegistered: false },
];

function mount() {
  return render(
    <FluentProvider theme={webLightTheme}>
      <DataProductsPage />
    </FluentProvider>,
  );
}

describe('DataProductsPage view toggle', () => {
  beforeEach(() => { window.localStorage.clear(); vi.restoreAllMocks(); });
  afterEach(() => { cleanup(); });

  it('renders the ViewToggle and tiles when data products exist', async () => {
    installFetchMock({ '/api/data-products': () => ({ ok: true, dataProducts: PRODUCTS }) });
    mount();
    await waitFor(() => expect(screen.getByText('Customer 360')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'List view' })).toBeInTheDocument();
  });

  it('does NOT render the ViewToggle when there are zero data products', async () => {
    installFetchMock({ '/api/data-products': () => ({ ok: true, dataProducts: [] }) });
    mount();
    await waitFor(() => expect(screen.getByText(/No data products yet/i)).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'List view' })).toBeNull();
  });

  it('swaps tiles for the LoomDataTable and persists the choice on toggle', async () => {
    installFetchMock({ '/api/data-products': () => ({ ok: true, dataProducts: PRODUCTS }) });
    mount();
    await waitFor(() => expect(screen.getByText('Customer 360')).toBeInTheDocument());
    // "Governance domain" is a list-only column header (tiles show the value only).
    expect(screen.queryByText('Governance domain')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'List view' }));
    await waitFor(() => expect(screen.getByText('Governance domain')).toBeInTheDocument());
    expect(window.localStorage.getItem(LS_KEY)).toBe('list');
  });
});
