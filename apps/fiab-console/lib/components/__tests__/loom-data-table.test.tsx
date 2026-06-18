/**
 * LoomDataTable — vitest jsdom render + behavior tests.
 *
 * Drives the shared table the way a user drives any Loom collection page:
 *   - all rows render,
 *   - clicking a sortable column header reorders the rows,
 *   - typing in a per-column filter narrows the visible rows (substring),
 *   - the empty state shows when no rows match.
 *
 * Pure client-side over data already in hand (per no-vaporware.md) — no
 * backend faked. Order is asserted by reading row cell text from the DOM.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { LoomDataTable, type LoomColumn } from '../ui/loom-data-table';

interface Row {
  id: string;
  name: string;
  type: string;
  size: number;
}

const ROWS: Row[] = [
  { id: '1', name: 'Charlie', type: 'lakehouse', size: 30 },
  { id: '2', name: 'Alice', type: 'warehouse', size: 10 },
  { id: '3', name: 'Bob', type: 'notebook', size: 20 },
];

const COLUMNS: LoomColumn<Row>[] = [
  { key: 'name', label: 'Name', sortable: true, filterable: true },
  { key: 'type', label: 'Type', sortable: true, filterable: true },
  { key: 'size', label: 'Size', sortable: true, filterable: false },
];

function renderTable(extra?: Partial<React.ComponentProps<typeof LoomDataTable<Row>>>) {
  return render(
    <FluentProvider theme={webLightTheme}>
      <LoomDataTable<Row>
        columns={COLUMNS}
        rows={ROWS}
        getRowId={(r) => r.id}
        {...extra}
      />
    </FluentProvider>,
  );
}

/** Read the first-cell (Name) text of every body row, in DOM order. */
function nameColumnOrder(): string[] {
  const rows = screen
    .getAllByRole('row')
    .filter((r) => within(r).queryAllByRole('gridcell').length > 0);
  return rows.map((r) => within(r).getAllByRole('gridcell')[0].textContent ?? '');
}

afterEach(cleanup);

describe('LoomDataTable', () => {
  it('renders every row', () => {
    renderTable();
    expect(screen.getByText('Charlie')).toBeInTheDocument();
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('Bob')).toBeInTheDocument();
    expect(nameColumnOrder()).toHaveLength(3);
  });

  it('sorts rows when a column header is clicked', () => {
    renderTable();
    // initial DOM order = input order
    expect(nameColumnOrder()).toEqual(['Charlie', 'Alice', 'Bob']);

    // click the Name header to sort ascending
    const nameHeader = screen.getByRole('columnheader', { name: /Name/i });
    fireEvent.click(nameHeader);
    expect(nameColumnOrder()).toEqual(['Alice', 'Bob', 'Charlie']);

    // click again to sort descending
    fireEvent.click(nameHeader);
    expect(nameColumnOrder()).toEqual(['Charlie', 'Bob', 'Alice']);
  });

  it('filters rows by per-column substring', () => {
    renderTable();
    const filter = screen.getByLabelText('Filter by Name');
    fireEvent.change(filter, { target: { value: 'li' } }); // Charlie, Alice
    const order = nameColumnOrder();
    expect(order).toContain('Charlie');
    expect(order).toContain('Alice');
    expect(order).not.toContain('Bob');
    expect(order).toHaveLength(2);
  });

  it('shows the empty state when filters match nothing', () => {
    renderTable({ empty: 'Nothing here.' });
    const filter = screen.getByLabelText('Filter by Name');
    fireEvent.change(filter, { target: { value: 'zzz-no-match' } });
    expect(screen.getByText('Nothing here.')).toBeInTheDocument();
  });

  it('renders the loading spinner instead of rows', () => {
    renderTable({ loading: true });
    expect(screen.getByText('Loading…')).toBeInTheDocument();
    expect(screen.queryByText('Charlie')).not.toBeInTheDocument();
  });

  it('renders an opt-in skeleton (no spinner) when loading + skeleton', () => {
    const { container } = renderTable({ loading: true, skeleton: true });
    // The bare spinner label must NOT appear; the skeleton region does.
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Loading data table')).toBeInTheDocument();
    expect(screen.queryByText('Charlie')).not.toBeInTheDocument();
    // skeleton renders placeholder items (header + body rows)
    expect(container.querySelectorAll('[aria-label="Loading data table"]').length).toBe(1);
  });

  it('announces the filtered count via an aria-live status', () => {
    renderTable();
    // unfiltered: shows the total
    expect(screen.getByText('Showing 3 items')).toBeInTheDocument();
    const filter = screen.getByLabelText('Filter by Name');
    fireEvent.change(filter, { target: { value: 'li' } });
    expect(screen.getByText('Showing 2 of 3 items')).toBeInTheDocument();
  });
});
