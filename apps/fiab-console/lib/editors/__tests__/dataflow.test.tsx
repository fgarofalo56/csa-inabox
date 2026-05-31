/**
 * DataflowGen2Editor — vitest render + interaction.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import React from 'react';

// The Diagram tab projects the dataflow onto the shared React Flow canvas
// (@xyflow/react + ELK layout). Pulling that whole engine into the jsdom
// worker OOMs the vitest fork before any assertion runs — it's a transform/
// heap limit of the canvas import chain, not a product issue (the canvas
// renders fine in the browser; it has its own specs in lib/components/
// pipeline). Stub the diagram child so the editor-under-test still mounts and
// we can assert its real chrome, workspace selector, and ribbon behavior.
vi.mock('@/lib/components/pipeline/dataflow-diagram', () => ({
  DataflowDiagram: ({ mScript, onChange }: { mScript: string; onChange: (v: string) => void }) =>
    React.createElement('textarea', {
      'data-testid': 'dataflow-diagram-stub',
      'aria-label': 'Dataflow diagram',
      value: mScript ?? '',
      onChange: (e: any) => onChange?.(e.target.value),
    }),
}));

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
  // vitest.config.ts sets globals:false, so RTL does not auto-register
  // afterEach(cleanup). Without an explicit cleanup the first render's DOM
  // tree stays mounted, so the second test sees two [data-testid="ribbon"]
  // nodes and getByTestId throws "Found multiple elements". Unmount here.
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

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
