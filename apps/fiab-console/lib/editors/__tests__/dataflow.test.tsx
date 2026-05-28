/**
 * DataflowGen2Editor — vitest render + interaction.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { DataflowGen2Editor } from '../dataflow-gen2-editor';
import { makeItem, installFetchMock } from './test-helpers';

describe('DataflowGen2Editor', () => {
  beforeEach(() => {
    installFetchMock({
      '/api/loom/workspaces': () => ({
        ok: true,
        workspaces: [{ id: 'ws-1', name: 'workspace-fixture' }],
      }),
      '/api/items/dataflow': () => ({
        ok: true,
        workspaceId: 'ws-1',
        dataflows: [{ id: 'df-1', displayName: 'dataflow-fixture' }],
      }),
    });
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('renders and shows the editor chrome', async () => {
    render(<DataflowGen2Editor item={makeItem('dataflow', 'Dataflow Gen2')} id="new" />);
    await waitFor(() => {
      expect(screen.getByTestId('chrome')).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getAllByText(/workspace-fixture/i).length).toBeGreaterThan(0);
    });
  });

  it('provides ribbon actions for the user', async () => {
    render(<DataflowGen2Editor item={makeItem('dataflow', 'Dataflow Gen2')} id="new" />);
    await waitFor(() => {
      expect(screen.getByTestId('ribbon').querySelectorAll('button').length).toBeGreaterThan(0);
    });
  });
});
