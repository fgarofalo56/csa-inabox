/**
 * NotebookEditor — vitest render + interaction.
 * Mocks /api/loom/workspaces + /api/items/notebook to return a single
 * Loom workspace and one notebook fixture. Asserts the editor mounts and
 * the workspace picker is populated.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { NotebookEditor } from '../notebook-editor';
import { makeItem, installFetchMock } from './test-helpers';

describe('NotebookEditor', () => {
  beforeEach(() => {
    installFetchMock({
      '/api/loom/workspaces': () => ({
        ok: true,
        workspaces: [{ id: 'ws-1', name: 'workspace-fixture' }],
      }),
      '/api/loom/compute-targets': () => ({
        ok: true,
        targets: [{ id: 'syn-1', kind: 'synapse-spark', name: 'syn-pool' }],
      }),
      '/api/items/notebook': () => ({
        ok: true,
        workspaceId: 'ws-1',
        notebooks: [{ id: 'nb-1', displayName: 'notebook-fixture' }],
      }),
    });
  });
  // vitest.config.ts sets globals:false, so RTL does not auto-register
  // afterEach(cleanup). Without an explicit cleanup the first render's DOM
  // tree stays mounted, so the second test sees two [data-testid="chrome"]
  // nodes and getByTestId throws "Found multiple elements". Unmount here.
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('renders and lists Loom workspaces', async () => {
    render(<NotebookEditor item={makeItem('notebook', 'Notebook')} id="new" />);
    await waitFor(() => {
      expect(screen.getAllByText(/workspace-fixture/i).length).toBeGreaterThan(0);
    });
  });

  it('shows the notebook chrome (ribbon + left panel + main pane)', async () => {
    render(<NotebookEditor item={makeItem('notebook', 'Notebook')} id="new" />);
    await waitFor(() => {
      expect(screen.getByTestId('chrome')).toBeInTheDocument();
    });
    expect(screen.getByTestId('left-panel')).toBeInTheDocument();
    expect(screen.getByTestId('main-panel')).toBeInTheDocument();
  });
});
