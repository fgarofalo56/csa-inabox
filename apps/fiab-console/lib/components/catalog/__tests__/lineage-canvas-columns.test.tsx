/**
 * L5 — LineageCanvas column fan-out + impact analysis render tests.
 *
 * Covers what the UX rules make BLOCKING for this surface:
 *   • clean first open — column nodes are COLLAPSED by default (table-grain
 *     primary, like Databricks Catalog Explorer) and no error banner renders;
 *   • the hover-revealed expand affordance fans a table out into its real
 *     column nodes (and back);
 *   • the toolbar "Columns" toggle expands/collapses every fan-out at once,
 *     and the "Impact" mode toggle is present when column data exists;
 *   • selecting a column opens the column detail panel with the impact
 *     summary (direct/transitive downstream counts) + the declared transform;
 *   • the l5-column-lineage-ui kill-switch OFF reverts to the pre-L5
 *     table-grain canvas (no column affordances at all).
 *
 * `@xyflow/react` is stubbed (the assets-canvas.test.tsx precedent — pulling
 * the whole canvas engine into the jsdom worker OOMs the vitest fork). The
 * stub still renders the REAL lineage node components through `nodeTypes`, so
 * the node anatomy under test is the real one.
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

// The l5 kill-switch (default-ON fail-open). Swappable per test.
const flags = { 'l5-column-lineage-ui': true } as Record<string, boolean>;
vi.mock('@/lib/components/ui/use-runtime-flag', () => ({
  useRuntimeFlag: (id: string, def = true) => flags[id] ?? def,
}));

import {
  LineageCanvas, type CanvasLineageNode, type CanvasLineageEdge,
} from '../lineage-canvas';

afterEach(() => { cleanup(); flags['l5-column-lineage-ui'] = true; });

function wrap(ui: React.ReactElement) {
  return render(<FluentProvider theme={webLightTheme}>{ui}</FluentProvider>);
}

const NODES: CanvasLineageNode[] = [
  { id: 'main.bronze.raw', label: 'raw', type: 'table', source: 'unity-catalog' },
  { id: 'main.bronze.customers', label: 'customers', type: 'table', source: 'unity-catalog', focus: true },
  {
    id: 'col:main.bronze.raw::id', label: 'id', type: 'column', source: 'unity-catalog',
    parentTableId: 'main.bronze.raw', columnOf: 'main.bronze.raw',
  },
  {
    id: 'col:main.bronze.customers::customer_id', label: 'customer_id', type: 'column',
    source: 'unity-catalog', parentTableId: 'main.bronze.customers', columnOf: 'main.bronze.customers',
  },
];
const EDGES: CanvasLineageEdge[] = [
  { from: 'main.bronze.raw', to: 'main.bronze.customers' },
  {
    from: 'col:main.bronze.raw::id', to: 'col:main.bronze.customers::customer_id',
    type: 'column', kind: 'column', transform: 'UPPER(id)',
  },
];

describe('LineageCanvas — column fan-out (L5)', () => {
  it('opens clean: table-grain only, no error banner, no column nodes yet', () => {
    wrap(<LineageCanvas nodes={NODES} edges={EDGES} focusId="main.bronze.customers" />);
    expect(screen.getByTestId('rf-node-main.bronze.raw')).toBeInTheDocument();
    expect(screen.queryByTestId('rf-node-col:main.bronze.raw::id')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    // the fan-out affordance and both L5 toolbar toggles are offered
    expect(screen.getByTestId('lineage-col-toggle-main.bronze.raw')).toBeInTheDocument();
    expect(screen.getByTestId('lineage-columns-toggle')).toBeInTheDocument();
    expect(screen.getByTestId('lineage-impact-toggle')).toBeInTheDocument();
  });

  it('expands a table into its real column nodes via the node chevron, then collapses back', async () => {
    wrap(<LineageCanvas nodes={NODES} edges={EDGES} focusId="main.bronze.customers" />);
    fireEvent.click(screen.getByTestId('lineage-col-toggle-main.bronze.raw'));
    await waitFor(() => {
      expect(screen.getByTestId('rf-node-col:main.bronze.raw::id')).toBeInTheDocument();
    });
    // the other table stays collapsed
    expect(screen.queryByTestId('rf-node-col:main.bronze.customers::customer_id')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('lineage-col-toggle-main.bronze.raw'));
    await waitFor(() => {
      expect(screen.queryByTestId('rf-node-col:main.bronze.raw::id')).not.toBeInTheDocument();
    });
  });

  it('the toolbar Columns toggle fans out EVERY table at once', async () => {
    wrap(<LineageCanvas nodes={NODES} edges={EDGES} focusId="main.bronze.customers" />);
    fireEvent.click(screen.getByTestId('lineage-columns-toggle'));
    await waitFor(() => {
      expect(screen.getByTestId('rf-node-col:main.bronze.raw::id')).toBeInTheDocument();
      expect(screen.getByTestId('rf-node-col:main.bronze.customers::customer_id')).toBeInTheDocument();
    });
  });

  it('selecting a column opens the impact panel: downstream count + transform expression', async () => {
    wrap(<LineageCanvas nodes={NODES} edges={EDGES} focusId="main.bronze.customers" />);
    fireEvent.click(screen.getByTestId('lineage-columns-toggle'));
    await waitFor(() => screen.getByTestId('rf-node-col:main.bronze.raw::id'));
    fireEvent.click(screen.getByTestId('rf-node-col:main.bronze.raw::id'));

    await waitFor(() => {
      expect(screen.getByLabelText('Column detail and impact analysis')).toBeInTheDocument();
    });
    expect(screen.getByTestId('column-impact-summary')).toHaveTextContent('1 downstream column');
    expect(screen.getByTestId('column-impact-downstream')).toHaveTextContent('customer_id');
    expect(screen.getByTestId('column-impact-downstream')).toHaveTextContent('UPPER(id)');
    expect(screen.getByTestId('column-impact-upstream')).toHaveTextContent(/No recorded upstream column/i);
    expect(screen.getByTestId('column-analyze-impact')).toBeInTheDocument();
  });

  it('a downstream column reports its upstream contributor with the transform', async () => {
    wrap(<LineageCanvas nodes={NODES} edges={EDGES} focusId="main.bronze.customers" />);
    fireEvent.click(screen.getByTestId('lineage-columns-toggle'));
    await waitFor(() => screen.getByTestId('rf-node-col:main.bronze.customers::customer_id'));
    fireEvent.click(screen.getByTestId('rf-node-col:main.bronze.customers::customer_id'));

    await waitFor(() => {
      expect(screen.getByTestId('column-impact-upstream')).toHaveTextContent('id');
    });
    expect(screen.getByTestId('column-impact-upstream')).toHaveTextContent('UPPER(id)');
    expect(screen.getByTestId('column-impact-summary')).toHaveTextContent(/No recorded downstream column/i);
  });

  it('kill-switch OFF reverts to the pre-L5 table-grain canvas (no column affordances)', () => {
    flags['l5-column-lineage-ui'] = false;
    wrap(<LineageCanvas nodes={NODES} edges={EDGES} focusId="main.bronze.customers" />);
    expect(screen.getByTestId('rf-node-main.bronze.raw')).toBeInTheDocument();
    expect(screen.queryByTestId('lineage-col-toggle-main.bronze.raw')).not.toBeInTheDocument();
    expect(screen.queryByTestId('lineage-columns-toggle')).not.toBeInTheDocument();
    expect(screen.queryByTestId('lineage-impact-toggle')).not.toBeInTheDocument();
    expect(screen.queryByTestId('rf-node-col:main.bronze.raw::id')).not.toBeInTheDocument();
  });
});
