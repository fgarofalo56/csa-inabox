/**
 * /connections — ViewToggle + tile/list behaviour (Vitest, jsdom).
 *
 * Asserts the additive UI-parity behaviour this page gained:
 *   - the Tile | List ViewToggle renders only when there are connections,
 *   - toggling to List swaps the ItemTile grid for the LoomDataTable
 *     (a list-only column header appears),
 *   - the chosen view persists to the documented localStorage key.
 *
 * Network is caught by installFetchMock; next/navigation is stubbed by
 * vitest.setup.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { installFetchMock } from '@/lib/editors/__tests__/test-helpers';
import ConnectionsPage from '../page';

const LS_KEY = 'loom.connections.viewMode.v1';

const CONNS = [
  { id: 'c1', name: 'sales-sql', type: 'azure-sql', authMethod: 'entra-mi', hasSecret: true, host: 'srv.database.windows.net', database: 'sales' },
  { id: 'c2', name: 'lake-store', type: 'storage-adls', authMethod: 'account-key', hasSecret: true, host: 'acct.dfs.core.windows.net' },
];

function mount() {
  return render(
    <FluentProvider theme={webLightTheme}>
      <ConnectionsPage />
    </FluentProvider>,
  );
}

describe('ConnectionsPage view toggle', () => {
  beforeEach(() => { window.localStorage.clear(); vi.restoreAllMocks(); });
  afterEach(() => { cleanup(); });

  it('renders the ViewToggle and tiles when connections exist', async () => {
    installFetchMock({ '/api/connections': () => ({ ok: true, connections: CONNS }) });
    mount();
    await waitFor(() => expect(screen.getByText('sales-sql')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'List view' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Tile view' })).toBeInTheDocument();
  });

  it('does NOT render the ViewToggle when there are zero connections', async () => {
    installFetchMock({ '/api/connections': () => ({ ok: true, connections: [] }) });
    mount();
    await waitFor(() =>
      expect(screen.getByText(/No connections yet/i)).toBeInTheDocument(),
    );
    expect(screen.queryByRole('button', { name: 'List view' })).toBeNull();
  });

  it('swaps tiles for the LoomDataTable and persists the choice on toggle', async () => {
    installFetchMock({ '/api/connections': () => ({ ok: true, connections: CONNS }) });
    mount();
    await waitFor(() => expect(screen.getByText('sales-sql')).toBeInTheDocument());
    // Host is a list-only column header (not present in the tile view).
    expect(screen.queryByText('Host')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'List view' }));
    await waitFor(() => expect(screen.getByText('Host')).toBeInTheDocument());
    expect(window.localStorage.getItem(LS_KEY)).toBe('list');
  });
});
