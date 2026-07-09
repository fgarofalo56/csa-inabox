/**
 * PreviewTable (SC-5) — render + contract (jsdom).
 *
 * Asserts the shared preview grid renders type-badged headers, real rows, and
 * the Fabric-parity "Succeeded (Xs) · Columns N · Rows N" status bar from a
 * static columnar result — the shape every Loom data-plane route returns.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PreviewTable, type PreviewSource } from '../preview-table';

const staticSource: PreviewSource = {
  id: 'orders',
  label: 'orders_delta',
  data: {
    columns: ['name', 'qty', 'ts'],
    rows: [['sensor-a', 30.1, '2026-07-09T00:00:00Z'], ['sensor-b', 12, '2026-07-09T01:00:00Z']],
    elapsedMs: 3030,
    rowCount: 2,
  },
};

describe('PreviewTable', () => {
  it('renders type-badged headers, rows, and the timing status bar', () => {
    render(<PreviewTable sources={[staticSource]} />);
    expect(screen.getByText('Abc')).toBeInTheDocument(); // string column badge
    expect(screen.getByText('123')).toBeInTheDocument(); // number column badge
    expect(screen.getByText('sensor-a')).toBeInTheDocument();
    expect(screen.getByText(/Succeeded \(3 sec 30 ms\) · Columns 3 · Rows 2/)).toBeInTheDocument();
  });

  it('filters rows via the search box', () => {
    render(<PreviewTable sources={[staticSource]} />);
    fireEvent.change(screen.getByLabelText('Search preview rows'), { target: { value: 'sensor-b' } });
    expect(screen.queryByText('sensor-a')).not.toBeInTheDocument();
    expect(screen.getByText('sensor-b')).toBeInTheDocument();
  });

  it('renders a closeable tab per source and dispatches onCloseSource', () => {
    const onClose = vi.fn();
    render(
      <PreviewTable
        sources={[staticSource, { id: 'b', label: 'lineitems', data: { columns: ['x'], rows: [[1]] } }]}
        onCloseSource={onClose}
      />,
    );
    // Fluent's TabList clones tab content into its overflow measurer, so the
    // close affordance can appear more than once in jsdom — click the first.
    fireEvent.click(screen.getAllByLabelText('Close lineitems')[0]);
    expect(onClose).toHaveBeenCalledWith('b');
  });
});
