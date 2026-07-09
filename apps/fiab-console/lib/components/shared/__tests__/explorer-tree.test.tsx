/**
 * ExplorerTree (SC-7) — render + contract (jsdom).
 *
 * Asserts the shared explorer renders typed nodes, activates a leaf via onOpen,
 * dispatches an inline action via onAction, and prunes the forest with the
 * filter box.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Delete16Regular } from '@fluentui/react-icons';
import { ExplorerTree, type ExplorerNode, type ExplorerAction } from '../explorer-tree';

const nodes: ExplorerNode[] = [
  {
    id: 'g-pipelines', label: 'Pipelines', kind: 'group', meta: '2', children: [
      { id: 'p-ingest', label: 'ingest_daily', kind: 'pipeline' },
      { id: 'p-copy', label: 'copy_orders', kind: 'pipeline' },
    ],
  },
];

const actionsFor = (node: ExplorerNode): ExplorerAction[] =>
  node.kind === 'pipeline'
    ? [{ key: 'delete', label: 'Delete', icon: <Delete16Regular />, inline: true, destructive: true }]
    : [];

describe('ExplorerTree', () => {
  it('renders the header title, filter box, and branch nodes', () => {
    render(<ExplorerTree nodes={nodes} title="Workspace Resources" defaultOpenIds={['g-pipelines']} />);
    expect(screen.getByText('Workspace Resources')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Filter resources by name')).toBeInTheDocument();
    expect(screen.getByText('ingest_daily')).toBeInTheDocument();
  });

  it('activates a leaf via onOpen', () => {
    const onOpen = vi.fn();
    render(<ExplorerTree nodes={nodes} onOpen={onOpen} defaultOpenIds={['g-pipelines']} />);
    fireEvent.click(screen.getByText('copy_orders'));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 'p-copy' }));
  });

  it('dispatches an inline action via onAction', () => {
    const onAction = vi.fn();
    render(<ExplorerTree nodes={nodes} actionsFor={actionsFor} onAction={onAction} defaultOpenIds={['g-pipelines']} />);
    fireEvent.click(screen.getByLabelText('Delete ingest_daily'));
    expect(onAction).toHaveBeenCalledWith('delete', expect.objectContaining({ id: 'p-ingest' }));
  });

  it('prunes the forest with the filter box', () => {
    render(<ExplorerTree nodes={nodes} defaultOpenIds={['g-pipelines']} />);
    fireEvent.change(screen.getByPlaceholderText('Filter resources by name'), { target: { value: 'copy' } });
    expect(screen.queryByText('ingest_daily')).not.toBeInTheDocument();
    expect(screen.getByText('copy_orders')).toBeInTheDocument();
  });
});
