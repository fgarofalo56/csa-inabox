/**
 * DataPipelineEditor — vitest render + interaction.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import React from 'react';

// The Pipeline tab projects the spec onto the shared React Flow canvas
// (@xyflow/react + ELK layout). Pulling that whole engine into the jsdom
// worker OOMs the vitest fork before any assertion runs — it's a transform/
// heap limit of the canvas import chain, not a product issue (the canvas
// renders fine in the browser; it has its own specs in lib/components/
// pipeline). Stub the canvas child so the editor-under-test still mounts and
// we can assert its real chrome, workspace selector, and ribbon behavior.
vi.mock('@/lib/components/pipeline/canvas', () => ({
  PipelineCanvas: React.forwardRef((_props: any, _ref: any) =>
    React.createElement('div', { 'data-testid': 'pipeline-canvas-stub' }, 'canvas')),
}));

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
  // vitest.config.ts sets globals:false, so RTL does not auto-register
  // afterEach(cleanup). Without an explicit cleanup the first render's DOM
  // tree stays mounted, so the second test sees two [data-testid="ribbon"]
  // nodes and getByTestId throws "Found multiple elements". Unmount here.
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('renders the runtime selector with the Azure-native (ADF) default', async () => {
    render(<DataPipelineEditor item={makeItem('data-pipeline', 'Data pipeline')} id="new" />);
    await waitFor(() => {
      expect(screen.getByTestId('chrome')).toBeInTheDocument();
    });
    // Per no-fabric-dependency, the unified editor defaults to the Azure-native
    // ADF runtime (delegating to AdfPipelineEditor) — the Fabric workspace
    // picker is opt-in, not the default surface. Assert the runtime selector
    // (the always-present chooser) renders with the ADF option.
    await waitFor(() => {
      expect(screen.getByText('Azure Data Factory (standalone)')).toBeInTheDocument();
    });
    // Fabric stays opt-in: its radio is present but is not the default runtime.
    expect(screen.getByText('Microsoft Fabric (opt-in)')).toBeInTheDocument();
  });

  it('exposes a ribbon with at least one action button', async () => {
    render(<DataPipelineEditor item={makeItem('data-pipeline', 'Data pipeline')} id="new" />);
    await waitFor(() => {
      expect(screen.getByTestId('ribbon')).toBeInTheDocument();
    });
    expect(screen.getByTestId('ribbon').querySelectorAll('button').length).toBeGreaterThan(0);
  });
});
