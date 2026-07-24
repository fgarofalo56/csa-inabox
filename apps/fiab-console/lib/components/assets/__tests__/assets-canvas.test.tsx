/**
 * N5 — Assets canvas + freshness-policy editor render tests.
 *
 * Covers what the UX rules make BLOCKING for this surface:
 *   • an estate with no derived assets shows a GUIDED empty state, never a red
 *     error banner (ux-baseline "clean first open");
 *   • a freshly derived asset with no saved policy opens clean — "Unmanaged",
 *     a guided caption, and no error;
 *   • node compactness — exactly ONE on-node badge (the freshness chip), with
 *     the rest of the record in the inspector;
 *   • Materialize is disabled (with an honest tooltip) until a materializer is
 *     bound, and calls the real handler once one is;
 *   • the policy editor is DROPDOWNS ONLY — no free-text cadence input
 *     (loom_no_freeform_config).
 *
 * `@xyflow/react` is stubbed: pulling the whole canvas engine into the jsdom
 * worker OOMs the vitest fork (the dataflow.test.tsx precedent). The stub still
 * renders the REAL `canvas-node-kit` node components through `nodeTypes`, so the
 * node anatomy under test is the real one.
 */
import React from 'react';
import { describe, expect, it, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
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
    useReactFlow: () => ({
      zoomIn: vi.fn(), zoomOut: vi.fn(), fitView: vi.fn(),
      setViewport: vi.fn(), getViewport: () => ({ x: 0, y: 0, zoom: 1 }),
    }),
    useViewport: () => ({ x: 0, y: 0, zoom: 1 }),
  };
});

import { AssetsCanvas, type AssetNodeView } from '../assets-canvas';

afterEach(cleanup);

function wrap(ui: React.ReactElement) {
  return render(<FluentProvider theme={webLightTheme}>{ui}</FluentProvider>);
}

function asset(overrides: Partial<AssetNodeView> = {}): AssetNodeView {
  return {
    key: 'table:main.silver.orders',
    name: 'orders',
    kind: 'table',
    group: 'silver',
    sources: ['unity-catalog'],
    producedBy: ['notebook abc123'],
    columns: ['order_id', 'customer_id'],
    owners: [],
    tags: [],
    policy: { cadence: 'none', grace: 'hourly', mode: 'manual', alertSeverity: 'none' },
    materializer: { kind: 'none' },
    freshness: {
      status: 'unmanaged', ageMinutes: null, cadenceMinutes: 0, graceMinutes: 60,
      dueAt: null, overdueByMinutes: 0,
    },
    upstream: ['table:main.bronze.orders_raw'],
    configured: false,
    ...overrides,
  };
}

const noop = async () => {};
const noopRun = async () => 'ok';

describe('AssetsCanvas — empty estate', () => {
  it('shows a GUIDED empty state, not an error', () => {
    wrap(<AssetsCanvas assets={[]} deps={[]} onSavePolicy={noop} onMaterialize={noopRun} />);
    expect(screen.getByText('No assets derived yet')).toBeInTheDocument();
    expect(screen.getByText(/Loom builds this graph from the lineage it already has/i)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('AssetsCanvas — nodes', () => {
  it('renders one node per asset with exactly ONE on-node badge (the freshness chip)', () => {
    wrap(
      <AssetsCanvas
        assets={[asset(), asset({ key: 'table:main.gold.orders_agg', name: 'orders_agg', group: 'gold' })]}
        deps={[{ from: 'table:main.silver.orders', to: 'table:main.gold.orders_agg' }]}
        onSavePolicy={noop}
        onMaterialize={noopRun}
      />,
    );
    const node = screen.getByTestId('rf-node-table:main.silver.orders');
    expect(within(node).getAllByText('Unmanaged')).toHaveLength(1);
    // Node compactness: owners/columns/upstream are NOT on the node.
    expect(within(node).queryByText('order_id')).not.toBeInTheDocument();
    expect(screen.getByTestId('rf-node-table:main.gold.orders_agg')).toBeInTheDocument();
  });

  it('badges an overdue asset distinctly from a never-materialized one', () => {
    wrap(
      <AssetsCanvas
        assets={[
          asset({
            key: 'table:a',
            name: 'late_table',
            freshness: { status: 'overdue', ageMinutes: 200, cadenceMinutes: 60, graceMinutes: 15, dueAt: null, overdueByMinutes: 125 },
          }),
          asset({
            key: 'table:b',
            name: 'new_table',
            freshness: { status: 'never', ageMinutes: null, cadenceMinutes: 60, graceMinutes: 15, dueAt: null, overdueByMinutes: 0 },
          }),
        ]}
        deps={[]}
        onSavePolicy={noop}
        onMaterialize={noopRun}
      />,
    );
    expect(within(screen.getByTestId('rf-node-table:a')).getByText('Overdue')).toBeInTheDocument();
    expect(within(screen.getByTestId('rf-node-table:b')).getByText('Not materialized')).toBeInTheDocument();
  });
});

describe('AssetsCanvas — inspector', () => {
  it('opens with the guided "select an asset" copy and the freshness legend', () => {
    wrap(<AssetsCanvas assets={[asset()]} deps={[]} onSavePolicy={noop} onMaterialize={noopRun} />);
    const inspector = screen.getByLabelText('Asset details');
    expect(within(inspector).getByText('Asset details')).toBeInTheDocument();
    expect(within(inspector).getByText(/Select an asset to see its software-defined-asset record/i)).toBeInTheDocument();
    expect(within(inspector).getByText('Fresh')).toBeInTheDocument();
    expect(within(inspector).getByText('Overdue')).toBeInTheDocument();
  });

  it('selecting a node shows its derived record — and NO red banner on a fresh asset', async () => {
    wrap(<AssetsCanvas assets={[asset()]} deps={[]} onSavePolicy={noop} onMaterialize={noopRun} />);
    fireEvent.click(screen.getByTestId('rf-node-table:main.silver.orders'));

    const inspector = screen.getByLabelText('Asset details');
    await waitFor(() => {
      expect(within(inspector).getByText('table:main.silver.orders')).toBeInTheDocument();
    });
    expect(within(inspector).getByText('table:main.bronze.orders_raw')).toBeInTheDocument();
    expect(within(inspector).getByText(/notebook abc123/)).toBeInTheDocument();
    expect(within(inspector).getByText('Never')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('disables Materialize until a materializer is bound, then calls the real handler', async () => {
    const onMaterialize = vi.fn(async () => 'Synapse pipeline p1 started (runId r1).');
    const { rerender } = wrap(
      <AssetsCanvas assets={[asset()]} deps={[]} onSavePolicy={noop} onMaterialize={onMaterialize} />,
    );
    fireEvent.click(screen.getByTestId('rf-node-table:main.silver.orders'));
    // Exact name — the node's own hover action bar is labelled "Materialize orders".
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Materialize' })).toBeDisabled();
    });

    rerender(
      <FluentProvider theme={webLightTheme}>
        <AssetsCanvas
          assets={[asset({ materializer: { kind: 'synapse-pipeline', pipelineName: 'p1' } })]}
          deps={[]}
          onSavePolicy={noop}
          onMaterialize={onMaterialize}
        />
      </FluentProvider>,
    );
    const button = screen.getByRole('button', { name: 'Materialize' });
    expect(button).not.toBeDisabled();
    fireEvent.click(button);
    await waitFor(() => {
      expect(onMaterialize).toHaveBeenCalledWith('table:main.silver.orders');
    });
    await waitFor(() => {
      expect(screen.getByText('Synapse pipeline p1 started (runId r1).')).toBeInTheDocument();
    });
  });
});

describe('FreshnessPolicyEditor (inside the inspector)', () => {
  it('is DROPDOWN-ONLY — no free-text cadence surface', async () => {
    wrap(<AssetsCanvas assets={[asset()]} deps={[]} onSavePolicy={noop} onMaterialize={noopRun} />);
    fireEvent.click(screen.getByTestId('rf-node-table:main.silver.orders'));

    await waitFor(() => {
      expect(screen.getByLabelText('Freshness cadence')).toBeInTheDocument();
    });
    for (const label of ['Freshness grace', 'Materialization mode', 'Overdue alert severity']) {
      expect(screen.getByLabelText(label)).toBeInTheDocument();
    }
    // A cron box / JSON textarea escape hatch would be a loom_no_freeform_config
    // violation — there is NO free-text input anywhere on this surface.
    expect(screen.queryAllByRole('textbox')).toHaveLength(0);
    expect(screen.queryAllByRole('spinbutton')).toHaveLength(0);
  });

  it('opens CLEAN on an unconfigured asset — a guided caption, never a red banner', async () => {
    wrap(<AssetsCanvas assets={[asset()]} deps={[]} onSavePolicy={noop} onMaterialize={noopRun} />);
    fireEvent.click(screen.getByTestId('rf-node-table:main.silver.orders'));
    await waitFor(() => {
      expect(screen.getByText(/This asset has no policy yet/i)).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /Save policy/i })).toBeDisabled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('saves the chosen cadence through the real handler', async () => {
    const onSavePolicy = vi.fn(async () => {});
    wrap(<AssetsCanvas assets={[asset()]} deps={[]} onSavePolicy={onSavePolicy} onMaterialize={noopRun} />);
    fireEvent.click(screen.getByTestId('rf-node-table:main.silver.orders'));

    await waitFor(() => {
      expect(screen.getByLabelText('Freshness cadence')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByLabelText('Freshness cadence'));
    fireEvent.click(await screen.findByRole('option', { name: 'Hourly' }));

    const save = screen.getByRole('button', { name: /Save policy/i });
    await waitFor(() => expect(save).not.toBeDisabled());
    fireEvent.click(save);

    await waitFor(() => {
      expect(onSavePolicy).toHaveBeenCalledWith(
        'table:main.silver.orders',
        expect.objectContaining({ cadence: 'hourly' }),
      );
    });
  });
});
