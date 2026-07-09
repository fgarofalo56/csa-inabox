/**
 * <EntityDiagram> — render contract (jsdom).
 *
 * Exercises the non-canvas surfaces (the ReactFlow canvas itself needs a real
 * layout pass we don't drive in jsdom): the Overview list renders a card per
 * table from a PROVIDED graph (no fetch), the honest warning MessageBar renders
 * for a gated graph, and providing a graph skips the network entirely.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { EntityDiagram } from '../entity-diagram';
import type { EntityGraph, EntityFetch } from '../entity-diagram-sources';

afterEach(cleanup);

const GRAPH: EntityGraph = {
  modelName: 'Sales',
  tables: [
    { id: 'Fact', name: 'Fact', schema: 'gold', rowCount: 1000, columns: [{ name: 'k', type: 'int64', kind: 'key', isKey: true }, { name: 'amt', type: 'double', kind: 'number' }] },
    { id: 'Dim', name: 'Dim', schema: 'gold', columns: [{ name: 'k', type: 'int64', kind: 'number' }] },
  ],
  relationships: [
    { id: 'r1', fromTable: 'Fact', toTable: 'Dim', cardinality: 'many-to-one', active: true },
  ],
};

function wrap(ui: React.ReactElement) {
  return render(<FluentProvider theme={webLightTheme}>{ui}</FluentProvider>);
}

describe('EntityDiagram', () => {
  it('renders an Overview card per table from a provided graph (no fetch)', () => {
    const fetchImpl = vi.fn() as unknown as EntityFetch;
    wrap(<EntityDiagram source={{ kind: 'lakehouse', itemId: 'lh1' }} graph={GRAPH} defaultView="overview" fetchImpl={fetchImpl} />);
    expect(screen.getByText('Fact')).toBeInTheDocument();
    expect(screen.getByText('Dim')).toBeInTheDocument();
    // header shows the model name + a table/relationship count summary
    expect(screen.getByText('Sales')).toBeInTheDocument();
    expect(screen.getByText(/2 tables · 1 relationships/)).toBeInTheDocument();
    // providing a graph must skip the network entirely
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fires onSelectTable when an overview card is activated', () => {
    const onSelectTable = vi.fn();
    wrap(<EntityDiagram source={{ kind: 'lakehouse', itemId: 'lh1' }} graph={GRAPH} defaultView="overview" onSelectTable={onSelectTable} />);
    fireEvent.click(screen.getByText('Fact'));
    expect(onSelectTable).toHaveBeenCalledWith(expect.objectContaining({ name: 'Fact' }));
  });

  it('renders the honest warning MessageBar for a gated graph', () => {
    const gated: EntityGraph = { tables: [], relationships: [], gate: 'Set LOOM_KUSTO_CLUSTER_URI to reach the ADX cluster.' };
    wrap(<EntityDiagram source={{ kind: 'kql-database', itemId: 'k1' }} graph={gated} />);
    expect(screen.getByText('Schema unavailable')).toBeInTheDocument();
    expect(screen.getByText(/Set LOOM_KUSTO_CLUSTER_URI/)).toBeInTheDocument();
  });

  it('exposes the Overview ⇄ Entity diagram toggle', () => {
    wrap(<EntityDiagram source={{ kind: 'lakehouse', itemId: 'lh1' }} graph={GRAPH} defaultView="overview" />);
    expect(screen.getByRole('tab', { name: 'Overview' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Entity diagram' })).toBeInTheDocument();
  });
});
