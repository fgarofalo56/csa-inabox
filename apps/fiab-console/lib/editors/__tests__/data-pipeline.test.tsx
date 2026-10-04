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
import { makeItem, installFetchMock, selectOptionValue } from './test-helpers';
import { fireEvent } from '@testing-library/react';

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

  // #3549-adjacent: the opt-in Fabric-runtime "+ New pipeline" dialog used to
  // wrap its definition in a Fabric git-integration `parts[].payload` (base64
  // JSON) envelope, which POST /api/items/data-pipeline never reads — the
  // route only reads `body.definition.properties` (the same flat ADF shape the
  // PUT/save route, `[id]/route.ts`, consumes). So the route's own
  // `|| { activities: [] }` fallback fired on EVERY create, unconditionally.
  // WHAT WOULD MAKE THIS FAIL: a regression back to the `parts` envelope makes
  // `definition.properties` undefined, and the `toEqual` below fails outright.
  it('sends the create request in the flat ADF shape the route actually reads', async () => {
    const { fetchMock } = installFetchMock({
      '/api/loom/workspaces': () => ({
        ok: true,
        workspaces: [{ id: 'ws-1', name: 'workspace-fixture' }],
      }),
      '/api/items/data-pipeline': () => ({
        ok: true,
        workspaceId: 'ws-1',
        pipelines: [],
        pipeline: { id: 'p-new' },
      }),
    });
    render(
      <DataPipelineEditor
        item={makeItem('data-pipeline', 'Data pipeline')}
        id="new"
        runtimePreset="fabric"
      />,
    );
    await waitFor(() => expect(screen.getByTestId('chrome')).toBeInTheDocument());

    const select = (await screen.findByDisplayValue('Select a workspace')) as HTMLSelectElement;
    await selectOptionValue(select, 'ws-1');

    fireEvent.click(screen.getByRole('button', { name: 'New pipeline' }));
    const dialogInput = await screen.findByPlaceholderText('displayName');
    fireEvent.change(dialogInput, { target: { value: 'my-new-pipeline' } });
    // Fluent's Dialog/Tabster modal marks its own DialogSurface aria-hidden in
    // jsdom (no real layout engine to drive the focus-trap), which getByRole
    // excludes by default — `hidden: true` opts back in to query inside it.
    fireEvent.click(screen.getByRole('button', { name: 'Create', hidden: true }));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([url, init]: any[]) =>
          String(url).includes('/api/items/data-pipeline?workspaceId=') && init?.method === 'POST'),
      ).toBe(true);
    });
    const [, init] = fetchMock.mock.calls.find(([url, i]: any[]) =>
      String(url).includes('/api/items/data-pipeline?workspaceId=') && i?.method === 'POST')!;
    const sent = JSON.parse(String(init.body));
    expect(sent.definition.parts).toBeUndefined();
    expect(sent.definition.properties).toEqual({
      activities: [], parameters: {}, variables: {}, annotations: [],
    });
  });
});

