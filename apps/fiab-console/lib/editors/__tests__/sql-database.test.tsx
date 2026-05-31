/**
 * SqlDatabaseEditor (Fabric SQLDatabase) — vitest render + ribbon assertion.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
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
  // vitest.config.ts runs with globals:false, so @testing-library/react never
  // auto-registers afterEach(cleanup). With two it() blocks each render() would
  // otherwise pile up in the document, so the second test sees two
  // data-testid="ribbon" trees and getByTestId() throws "multiple elements".
  // Explicit cleanup matches the sibling editor specs (activator, dataflow, …).
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

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
