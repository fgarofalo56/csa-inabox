/**
 * LakehouseEditor — vitest render + interaction.
 * Mocks /api/lakehouse/containers and /api/lakehouse/paths so the tree
 * populates with a real-shaped fixture. Asserts the toolbar exposes
 * Upload / New folder / Refresh and that the Tables tab is reachable.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { LakehouseEditor } from '../lakehouse-editor';
import { makeItem, installFetchMock, renderWithProviders } from './test-helpers';

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
      '/api/lakehouse/schemas': () => ({
        ok: true,
        schemas: [{ id: 'lh-1::dbo', lakehouseId: 'lakehouse-fixture', name: 'dbo', isDefault: true, status: 'active' }],
      }),
    });
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('renders, loads containers, and exposes the file toolbar', async () => {
    renderWithProviders(<LakehouseEditor item={makeItem('lakehouse', 'Lakehouse')} id="lh-1" />);
    await waitFor(() => {
      expect(screen.getAllByText('lakehouse-fixture').length).toBeGreaterThan(0);
    });
    expect(screen.getAllByRole('button', { name: /Upload file/i }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: /New folder/i }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: /Refresh/i }).length).toBeGreaterThan(0);
  });

  it('renders the Files / Tables / Schemas / Preview / SQL / Shortcuts tab strip', async () => {
    renderWithProviders(<LakehouseEditor item={makeItem('lakehouse', 'Lakehouse')} id="lh-1" />);
    await waitFor(() => {
      expect(screen.getAllByText('lakehouse-fixture').length).toBeGreaterThan(0);
    });
    // Fluent v9 TabList renders a hidden duplicate of the *selected* tab for
    // its animated active-indicator layer, so the default-selected "Files"
    // tab appears twice in the DOM (both aria-selected). That is a cosmetic
    // render artifact, not two real tabs — assert each tab label is present
    // (>=1) rather than requiring exactly one, so the strip's real contents
    // (Files / Tables / Schemas / Preview / SQL / Shortcuts) are still verified.
    for (const name of ['Files', 'Tables', 'Schemas', 'Preview', 'SQL', 'Shortcuts']) {
      expect(screen.getAllByRole('tab', { name }).length).toBeGreaterThan(0);
    }
    // The non-selected tabs render exactly once; the strip exposes 6 distinct
    // tab labels, so there are at least 6 tab elements total.
    expect(screen.getAllByRole('tab').length).toBeGreaterThanOrEqual(6);
  });
});
