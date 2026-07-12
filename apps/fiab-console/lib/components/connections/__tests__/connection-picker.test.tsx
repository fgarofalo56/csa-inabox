/**
 * ConnectionPicker + useConnections — the shared "reuse a saved connection"
 * control (Vitest, jsdom). Asserts it loads the caller's connections from the
 * live route, filters to the requested types, and yields the picked connection
 * to onSelect. Network is caught by installFetchMock.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { installFetchMock } from '@/lib/editors/__tests__/test-helpers';
import { ConnectionPicker } from '../connection-picker';

const CONNS = [
  { id: 'c1', name: 'sales-sql', type: 'azure-sql', authMethod: 'entra-mi', hasSecret: true, host: 'srv.database.windows.net', database: 'sales' },
  { id: 'c2', name: 'lake-store', type: 'storage-adls', authMethod: 'account-key', hasSecret: true, host: 'acct.dfs.core.windows.net' },
];

function mount(props: Partial<React.ComponentProps<typeof ConnectionPicker>> = {}) {
  const onSelect = vi.fn();
  render(
    <FluentProvider theme={webLightTheme}>
      <ConnectionPicker onSelect={onSelect} {...props} />
    </FluentProvider>,
  );
  return { onSelect };
}

describe('ConnectionPicker', () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => { cleanup(); });

  it('lists all saved connections in the dropdown', async () => {
    installFetchMock({ '/api/connections': () => ({ ok: true, connections: CONNS }) });
    mount();
    const dropdown = await screen.findByRole('combobox', { name: 'Connection' });
    fireEvent.click(dropdown);
    await waitFor(() => expect(screen.getByText('sales-sql')).toBeInTheDocument());
    expect(screen.getByText('lake-store')).toBeInTheDocument();
  });

  it('filters the list to the requested connection types', async () => {
    installFetchMock({ '/api/connections': () => ({ ok: true, connections: CONNS }) });
    mount({ types: ['storage-adls'] });
    const dropdown = await screen.findByRole('combobox', { name: 'Connection' });
    fireEvent.click(dropdown);
    await waitFor(() => expect(screen.getByText('lake-store')).toBeInTheDocument());
    expect(screen.queryByText('sales-sql')).toBeNull();
  });

  it('yields the picked connection to onSelect', async () => {
    installFetchMock({ '/api/connections': () => ({ ok: true, connections: CONNS }) });
    const { onSelect } = mount();
    const dropdown = await screen.findByRole('combobox', { name: 'Connection' });
    fireEvent.click(dropdown);
    const opt = await screen.findByText('sales-sql');
    fireEvent.click(opt);
    await waitFor(() => expect(onSelect).toHaveBeenCalled());
    expect(onSelect.mock.calls.at(-1)?.[0]).toMatchObject({ id: 'c1', type: 'azure-sql' });
  });

  it('shows an honest empty state when there are no matching connections', async () => {
    installFetchMock({ '/api/connections': () => ({ ok: true, connections: [] }) });
    mount({ types: ['azure-sql'] });
    await waitFor(() => expect(screen.getByText(/Add one to get started/i)).toBeInTheDocument());
  });
});
