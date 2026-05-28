/**
 * SqlDatabaseEditor (Fabric SQLDatabase) — vitest render + ribbon assertion.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { SqlDatabaseEditor } from '../sql-database-editor';
import { makeItem, installFetchMock } from './test-helpers';

describe('SqlDatabaseEditor', () => {
  beforeEach(() => {
    installFetchMock({
      '/api/loom/workspaces': () => ({ ok: true, workspaces: [{ id: 'ws-1', name: 'workspace-fixture' }] }),
      '/api/items/sql-database': () => ({
        ok: true,
        workspaceId: 'ws-1',
        fabricWorkspaceId: 'fab-ws-1',
        sqlDatabases: [{ id: 'sdb-1', displayName: 'orders-fabric', description: 'Fabric SQL fixture' }],
      }),
    });
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('renders editor chrome', async () => {
    render(<SqlDatabaseEditor item={makeItem('sql-database', 'SQL database')} id="new" />);
    await waitFor(() => { expect(screen.getByTestId('chrome')).toBeInTheDocument(); });
  });

  it('exposes ribbon actions', async () => {
    render(<SqlDatabaseEditor item={makeItem('sql-database', 'SQL database')} id="new" />);
    await waitFor(() => {
      const buttons = screen.getByTestId('ribbon').querySelectorAll('button');
      expect(buttons.length).toBeGreaterThanOrEqual(2);
    });
  });
});
