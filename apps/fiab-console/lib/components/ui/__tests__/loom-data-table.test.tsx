/**
 * LoomDataTable — W3 dense-grid feature tests (density + hover row actions +
 * right-click context menu). Exercises the REAL Fluent DataGrid-based primitive.
 *
 * Asserts:
 *   1. rows + columns render;
 *   2. hover row-actions render a real button that fires its onClick;
 *   3. right-clicking a row opens the context menu and its items fire onClick;
 *   4. compact density renders without error (back-compat: default is comfortable).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { Open16Regular } from '@fluentui/react-icons';
import {
  LoomDataTable, type LoomColumn, type LoomRowAction, type LoomRowMenuItem,
  type LoomSelection,
} from '../loom-data-table';

interface Row { id: string; name: string; type: string }
const ROWS: Row[] = [
  { id: 'a', name: 'Alpha', type: 'lakehouse' },
  { id: 'b', name: 'Bravo', type: 'notebook' },
];
const COLUMNS: LoomColumn<Row>[] = [
  { key: 'name', label: 'Name', filterable: false },
  { key: 'type', label: 'Type', filterable: false },
];

function wrap(ui: React.ReactElement) {
  return render(<FluentProvider theme={webLightTheme}>{ui}</FluentProvider>);
}

afterEach(cleanup);

describe('LoomDataTable — dense grid features', () => {
  it('renders rows and columns', () => {
    wrap(<LoomDataTable columns={COLUMNS} rows={ROWS} getRowId={(r) => r.id} />);
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('Bravo')).toBeInTheDocument();
  });

  it('renders hover row-actions and fires their onClick', () => {
    const onClick = vi.fn();
    const rowActions = (): LoomRowAction<Row>[] => [
      { key: 'open', label: 'Open row', icon: <Open16Regular />, onClick },
    ];
    wrap(
      <LoomDataTable columns={COLUMNS} rows={ROWS} getRowId={(r) => r.id} rowActions={rowActions} />,
    );
    const buttons = screen.getAllByLabelText('Open row');
    expect(buttons.length).toBe(ROWS.length);
    fireEvent.click(buttons[0]);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onClick).toHaveBeenCalledWith(ROWS[0]);
  });

  it('opens the context menu on right-click and fires an item onClick', () => {
    const onMenuClick = vi.fn();
    const rowMenu = (): LoomRowMenuItem<Row>[] => [
      { key: 'copy', label: 'Copy ID', onClick: onMenuClick },
    ];
    wrap(
      <LoomDataTable columns={COLUMNS} rows={ROWS} getRowId={(r) => r.id} rowMenu={rowMenu} />,
    );
    // Right-click the first data row (find via its cell text, walk to the row).
    const cell = screen.getByText('Alpha');
    fireEvent.contextMenu(cell);
    const menuItem = screen.getByText('Copy ID');
    expect(menuItem).toBeInTheDocument();
    fireEvent.click(menuItem);
    expect(onMenuClick).toHaveBeenCalledTimes(1);
    expect(onMenuClick).toHaveBeenCalledWith(ROWS[0]);
  });

  it('renders in compact density without error', () => {
    wrap(
      <LoomDataTable columns={COLUMNS} rows={ROWS} getRowId={(r) => r.id} density="compact" />,
    );
    expect(screen.getByText('Alpha')).toBeInTheDocument();
  });
});

/**
 * Opt-in multi-select (`selection`). The FIRST test here is the one that
 * matters most: `selection` is absent on 80 of this primitive's 81 consumers,
 * so "no checkbox column when the prop is absent" is what keeps this change
 * additive. If that assertion ever fails, every table in the console grew a
 * column.
 */
describe('LoomDataTable — multi-select', () => {
  function sel(over: Partial<LoomSelection<Row>> = {}): LoomSelection<Row> {
    return {
      selectedIds: new Set<string>(),
      onToggleRow: vi.fn(),
      onToggleAll: vi.fn(),
      ...over,
    };
  }

  it('renders NO checkbox column when `selection` is omitted (back-compat)', () => {
    wrap(<LoomDataTable columns={COLUMNS} rows={ROWS} getRowId={(r) => r.id} />);
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    expect(screen.queryByLabelText('Select all rows')).not.toBeInTheDocument();
  });

  it('renders a header select-all plus one checkbox per row', () => {
    wrap(
      <LoomDataTable columns={COLUMNS} rows={ROWS} getRowId={(r) => r.id} selection={sel()} />,
    );
    // 1 header + 1 per row.
    expect(screen.getAllByRole('checkbox')).toHaveLength(ROWS.length + 1);
    expect(screen.getByLabelText('Select all rows')).toBeInTheDocument();
  });

  it('fires onToggleRow with the row id when a row checkbox is clicked', () => {
    const onToggleRow = vi.fn();
    wrap(
      <LoomDataTable
        columns={COLUMNS} rows={ROWS} getRowId={(r) => r.id}
        selection={sel({ onToggleRow, ariaLabel: (r) => `Select ${r.name}` })}
      />,
    );
    fireEvent.click(screen.getByLabelText('Select Alpha'));
    expect(onToggleRow).toHaveBeenCalledTimes(1);
    expect(onToggleRow).toHaveBeenCalledWith('a');
  });

  it('passes every VISIBLE row id to onToggleAll', () => {
    const onToggleAll = vi.fn();
    wrap(
      <LoomDataTable
        columns={COLUMNS} rows={ROWS} getRowId={(r) => r.id}
        selection={sel({ onToggleAll })}
      />,
    );
    fireEvent.click(screen.getByLabelText('Select all rows'));
    expect(onToggleAll).toHaveBeenCalledWith(['a', 'b']);
  });

  /**
   * The one that discriminates "visible" from "all". A page-level test cannot:
   * consumers usually pre-filter `rows` themselves, so `rows` and the table's
   * internal `filteredRows` coincide. Only the table's OWN column filter pulls
   * them apart — and sweeping filtered-out rows into a bulk DELETE is the
   * footgun this guards.
   */
  it('excludes rows hidden by a column filter from onToggleAll', () => {
    const onToggleAll = vi.fn();
    // `filterable` defaults on; give Name a free-text filter to drive.
    const filterCols: LoomColumn<Row>[] = [
      { key: 'name', label: 'Name', filterType: 'text' },
      { key: 'type', label: 'Type', filterable: false },
    ];
    wrap(
      <LoomDataTable
        columns={filterCols} rows={ROWS} getRowId={(r) => r.id}
        selection={sel({ onToggleAll })}
      />,
    );
    // Narrow to Bravo only.
    fireEvent.change(screen.getByLabelText('Filter by Name'), { target: { value: 'Bravo' } });
    expect(screen.queryByText('Alpha')).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Select all rows'));
    expect(onToggleAll).toHaveBeenCalledWith(['b']);
    expect(onToggleAll).not.toHaveBeenCalledWith(['a', 'b']);
  });

  it('shows the header checkbox as mixed on a partial selection, checked on a full one', () => {
    const { rerender } = wrap(
      <LoomDataTable
        columns={COLUMNS} rows={ROWS} getRowId={(r) => r.id}
        selection={sel({ selectedIds: new Set(['a']) })}
      />,
    );
    // Fluent renders tri-state as the DOM `indeterminate` PROPERTY (there is no
    // aria-checked="mixed" attribute on the input), so assert the property.
    const partial = screen.getByLabelText('Select all rows') as HTMLInputElement;
    expect(partial.indeterminate).toBe(true);
    expect(partial.checked).toBe(false);

    rerender(
      <FluentProvider theme={webLightTheme}>
        <LoomDataTable
          columns={COLUMNS} rows={ROWS} getRowId={(r) => r.id}
          selection={sel({ selectedIds: new Set(['a', 'b']) })}
        />
      </FluentProvider>,
    );
    // Full selection flips the label to the deselect affordance and leaves
    // `indeterminate` behind — this half is what makes the assertion above
    // capable of failing rather than passing on a checkbox that is always mixed.
    const full = screen.getByLabelText('Deselect all rows') as HTMLInputElement;
    expect(full.indeterminate).toBe(false);
    expect(full.checked).toBe(true);
  });

  it('does NOT fire onRowClick when a checkbox is clicked', () => {
    const onRowClick = vi.fn();
    const onToggleRow = vi.fn();
    wrap(
      <LoomDataTable
        columns={COLUMNS} rows={ROWS} getRowId={(r) => r.id}
        onRowClick={onRowClick}
        selection={sel({ onToggleRow, ariaLabel: (r) => `Select ${r.name}` })}
      />,
    );
    fireEvent.click(screen.getByLabelText('Select Alpha'));
    expect(onToggleRow).toHaveBeenCalledTimes(1);
    // The checkbox lives inside the row; without stopPropagation this would
    // also open whatever the row click does (a settings pane, a navigation).
    expect(onRowClick).not.toHaveBeenCalled();

    // Control: clicking the row itself still works.
    fireEvent.click(screen.getByText('Alpha'));
    expect(onRowClick).toHaveBeenCalledTimes(1);
  });

  it('marks selected rows with aria-selected', () => {
    wrap(
      <LoomDataTable
        columns={COLUMNS} rows={ROWS} getRowId={(r) => r.id}
        selection={sel({ selectedIds: new Set(['a']) })}
      />,
    );
    const selectedRows = screen.getAllByRole('row').filter(
      (r) => r.getAttribute('aria-selected') === 'true',
    );
    expect(selectedRows).toHaveLength(1);
    expect(within(selectedRows[0]!).getByText('Alpha')).toBeInTheDocument();
  });
});
