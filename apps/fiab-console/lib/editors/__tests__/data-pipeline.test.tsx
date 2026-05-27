/**
 * DataPipelineEditor — vitest render + interaction.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { DataPipelineEditor } from '../data-pipeline-editor';
import { makeItem, installFetchMock } from './test-helpers';

describe('DataPipelineEditor', () => {
  beforeEach(() => {
    installFetchMock({
      '/api/loom/workspaces': () => ({
        ok: true,
        workspaces: [{ id: 'ws-1', name: 'workspace-fixture' }],
      }),
      '/api/items/data-pipeline': () => ({
        ok: true,
        workspaceId: 'ws-1',
        pipelines: [{ id: 'p-1', displayName: 'pipeline-fixture', adfPipelineName: 'p-1' }],
      }),
    });
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('renders, loads workspaces, and shows the editor chrome', async () => {
    render(<DataPipelineEditor item={makeItem('data-pipeline', 'Data pipeline')} id="new" />);
    await waitFor(() => {
      expect(screen.getByTestId('chrome')).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getAllByText(/workspace-fixture/i).length).toBeGreaterThan(0);
    });
  });

  it('exposes a ribbon with at least one action button', async () => {
    render(<DataPipelineEditor item={makeItem('data-pipeline', 'Data pipeline')} id="new" />);
    await waitFor(() => {
      expect(screen.getByTestId('ribbon')).toBeInTheDocument();
    });
    expect(screen.getByTestId('ribbon').querySelectorAll('button').length).toBeGreaterThan(0);
  });
});
