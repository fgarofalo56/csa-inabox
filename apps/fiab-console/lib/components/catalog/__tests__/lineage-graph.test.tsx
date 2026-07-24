/**
 * L5 — LineageGraph host tests (/catalog/lineage + /catalog/[source]/[id]).
 *
 * Pins the L5 upgrade of this surface:
 *   • the request ALWAYS opts into the L1 column facet (`?columns=true`);
 *   • the shared LineageCanvas renders the returned graph with the column
 *     nodes derived from the canonical `col:<table>::<column>` edge endpoints;
 *   • the "Column lineage" toggle hides/shows the column grain WITHOUT a
 *     refetch;
 *   • zero captured column lineage renders the honest "nothing captured yet"
 *     hint — never an error (ux-baseline clean first open);
 *   • a BFF gate renders the honest MessageBar, an empty graph the EmptyState.
 *
 * `@xyflow/react` is stubbed per the assets-canvas.test.tsx precedent.
 */
import React from 'react';
import { describe, expect, it, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';

vi.mock('@xyflow/react', () => {
  const Passthrough = ({ children }: { children?: React.ReactNode }) =>
    React.createElement('div', null, children);
  return {
    ReactFlow: ({ nodes, nodeTypes, onNodeClick, onPaneClick, children }: any) =>
      React.createElement(
        'div',
        { 'data-testid': 'rf-canvas', onClick: () => onPaneClick?.() },
        ...(nodes || []).map((n: any) => {
          const NodeComponent = nodeTypes?.[n.type];
          return React.createElement(
            'div',
            {
              key: n.id,
              'data-testid': `rf-node-${n.id}`,
              onClick: (e: React.MouseEvent) => { e.stopPropagation(); onNodeClick?.(e, n); },
            },
            NodeComponent
              ? React.createElement(NodeComponent, { id: n.id, data: n.data, selected: n.selected })
              : null,
          );
        }),
        children,
      ),
    ReactFlowProvider: Passthrough,
    Background: () => null,
    MiniMap: () => null,
    Panel: Passthrough,
    Handle: () => null,
    Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' },
    BackgroundVariant: { Dots: 'dots' },
    MarkerType: { ArrowClosed: 'arrowclosed' },
    useReactFlow: () => ({
      zoomIn: vi.fn(), zoomOut: vi.fn(), fitView: vi.fn(), setCenter: vi.fn(),
      setViewport: vi.fn(), getViewport: () => ({ x: 0, y: 0, zoom: 1 }),
    }),
    useNodesState: (initial: any[]) => {
      const [nodes, setNodes] = React.useState(initial);
      return [nodes, setNodes, vi.fn()];
    },
    useViewport: () => ({ x: 0, y: 0, zoom: 1 }),
  };
});

vi.mock('@/lib/components/ui/use-runtime-flag', () => ({
  useRuntimeFlag: (_id: string, def = true) => def,
}));

import { LineageGraph } from '../lineage-graph';

afterEach(() => { vi.restoreAllMocks(); cleanup(); });

function wrap(ui: React.ReactElement) {
  return render(<FluentProvider theme={webLightTheme}>{ui}</FluentProvider>);
}

const PAYLOAD = {
  ok: true,
  source: 'unity-catalog',
  nodes: [
    { id: 'main.bronze.raw', label: 'main.bronze.raw', type: 'table', source: 'unity-catalog' },
    { id: 'main.bronze.customers', label: 'main.bronze.customers', type: 'table', source: 'unity-catalog', columns: ['customer_id'] },
  ],
  edges: [{ from: 'main.bronze.raw', to: 'main.bronze.customers' }],
  columnEdges: [
    {
      from: 'col:main.bronze.raw::id', to: 'col:main.bronze.customers::customer_id',
      type: 'column', kind: 'column', transform: 'UPPER(id)',
    },
  ],
};

function mockFetch(body: unknown) {
  const calls: string[] = [];
  vi.spyOn(global, 'fetch').mockImplementation((async (url: any) => {
    calls.push(String(url));
    return new Response(JSON.stringify(body), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }) as any);
  return calls;
}

describe('LineageGraph (L5 host)', () => {
  it('always requests the column facet and renders the shared canvas with column nodes available', async () => {
    const calls = mockFetch(PAYLOAD);
    wrap(<LineageGraph source="unity-catalog" id="main.bronze.customers" host="adb-1.azuredatabricks.net" />);
    await waitFor(() => expect(screen.getByTestId('lineage-canvas')).toBeInTheDocument());
    expect(calls[0]).toContain('/api/catalog/lineage?');
    expect(calls[0]).toContain('columns=true');
    // table nodes on the canvas; columns collapsed by default but the fan-out
    // affordance is offered (real derived col: node anchored to its table)
    expect(await screen.findByTestId('rf-node-main.bronze.raw')).toBeInTheDocument();
    expect(await screen.findByTestId('lineage-col-toggle-main.bronze.raw')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('lineage-col-toggle-main.bronze.raw'));
    await waitFor(() => expect(screen.getByTestId('rf-node-col:main.bronze.raw::id')).toBeInTheDocument());
  });

  it('the Column lineage switch hides the column grain without refetching', async () => {
    const calls = mockFetch(PAYLOAD);
    wrap(<LineageGraph source="unity-catalog" id="main.bronze.customers" host="adb-1.azuredatabricks.net" />);
    await waitFor(() => expect(screen.getByTestId('lineage-canvas')).toBeInTheDocument());
    const fetches = calls.length;
    fireEvent.click(screen.getByRole('switch', { name: /column-level lineage/i }));
    await waitFor(() => {
      expect(screen.queryByTestId('lineage-col-toggle-main.bronze.raw')).not.toBeInTheDocument();
    });
    expect(calls.length).toBe(fetches); // display-only toggle
  });

  it('zero captured column lineage → honest hint, no error banner', async () => {
    mockFetch({ ...PAYLOAD, columnEdges: [] });
    wrap(<LineageGraph source="unity-catalog" id="main.bronze.customers" host="adb-1.azuredatabricks.net" />);
    await waitFor(() => expect(screen.getByTestId('lineage-canvas')).toBeInTheDocument());
    expect(screen.getByTestId('columns-empty-hint')).toHaveTextContent(/No column-level lineage captured yet/i);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('a BFF gate renders the honest MessageBar with the hint payload', async () => {
    mockFetch({ ok: false, error: 'Unity Catalog is not configured', hint: { missingEnvVar: 'LOOM_DATABRICKS_WORKSPACES' } });
    wrap(<LineageGraph source="unity-catalog" id="main.bronze.customers" host="adb-1.azuredatabricks.net" />);
    await waitFor(() => expect(screen.getByText(/Lineage unavailable/i)).toBeInTheDocument());
    expect(screen.getByText(/LOOM_DATABRICKS_WORKSPACES/)).toBeInTheDocument();
  });

  it('an empty graph renders the guided EmptyState, never a bare div', async () => {
    mockFetch({ ok: true, source: 'unity-catalog', nodes: [], edges: [], columnEdges: [] });
    wrap(<LineageGraph source="unity-catalog" id="main.bronze.customers" host="adb-1.azuredatabricks.net" />);
    await waitFor(() => expect(screen.getByText('No lineage edges')).toBeInTheDocument());
  });
});
