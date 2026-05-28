/**
 * LakehouseEditor — vitest render + interaction.
 * Mocks /api/lakehouse/containers and /api/lakehouse/paths so the tree
 * populates with a real-shaped fixture. Asserts the toolbar exposes
 * Upload / New folder / Refresh and that the Tables tab is reachable.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { LakehouseEditor } from '../lakehouse-editor';
import { makeItem, installFetchMock } from './test-helpers';

describe('LakehouseEditor', () => {
  beforeEach(() => {
    installFetchMock({
      '/api/lakehouse/containers': () => ({
        ok: true,
        containers: [{ name: 'lakehouse-fixture', url: 'https://acct.dfs.core.windows.net/lakehouse-fixture' }],
      }),
      '/api/lakehouse/paths': () => ({
        ok: true,
        paths: [
          { name: 'Files', isDirectory: true, size: 0 },
          { name: 'Tables', isDirectory: true, size: 0 },
        ],
      }),
    });
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('renders, loads containers, and exposes the file toolbar', async () => {
    render(<LakehouseEditor item={makeItem('lakehouse', 'Lakehouse')} id="lh-1" />);
    await waitFor(() => {
      expect(screen.getAllByText('lakehouse-fixture').length).toBeGreaterThan(0);
    });
    expect(screen.getAllByRole('button', { name: /Upload file/i }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: /New folder/i }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: /Refresh/i }).length).toBeGreaterThan(0);
  });

  it('renders the Files / Tables / Preview / SQL / Shortcuts tab strip', async () => {
    render(<LakehouseEditor item={makeItem('lakehouse', 'Lakehouse')} id="lh-1" />);
    await waitFor(() => {
      expect(screen.getAllByText('lakehouse-fixture').length).toBeGreaterThan(0);
    });
    expect(screen.getByRole('tab', { name: 'Files' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Tables' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Preview' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'SQL' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Shortcuts' })).toBeInTheDocument();
  });
});
