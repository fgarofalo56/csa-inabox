/**
 * MirroredDatabaseEditor — vitest render + interaction.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MirroredDatabaseEditor } from '../mirrored-database-editor';
import { makeItem, installFetchMock } from './test-helpers';

describe('MirroredDatabaseEditor', () => {
  beforeEach(() => {
    installFetchMock({
      '/api/loom/workspaces': () => ({
        ok: true,
        workspaces: [{ id: 'ws-1', name: 'workspace-fixture' }],
      }),
      '/api/items/mirrored-database': () => ({
        ok: true,
        workspaceId: 'ws-1',
        mirroredDatabases: [{ id: 'm-1', displayName: 'mirror-fixture' }],
      }),
    });
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('renders the editor chrome and lists workspaces', async () => {
    render(<MirroredDatabaseEditor item={makeItem('mirrored-database', 'Mirrored database')} id="new" />);
    await waitFor(() => {
      expect(screen.getByTestId('chrome')).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getAllByText(/workspace-fixture/i).length).toBeGreaterThan(0);
    });
  });

  it('exposes ribbon actions', async () => {
    render(<MirroredDatabaseEditor item={makeItem('mirrored-database', 'Mirrored database')} id="new" />);
    await waitFor(() => {
      expect(screen.getByTestId('ribbon').querySelectorAll('button').length).toBeGreaterThan(0);
    });
  });
});
