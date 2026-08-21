/**
 * LoomDataTable — column-definition memo stability for the consumers that do
 * NOT opt into `selection` (measured 2026-08-20: 155 non-test call sites across
 * 85 files, of which exactly ONE — /admin/workspaces — passes the prop).
 *
 * WHY THIS FILE EXISTS. `selectVisibleIds` feeds the `fluentColumns` memo. When
 * it returned a fresh `[]` for tables without a `selection` prop, that memo
 * broke on every render — and `filteredRows` returns the `rows` prop BY IDENTITY
 * when no column filter is active, so any consumer passing an inline
 * `.filter()`/`.map()`, or any keystroke in the built-in column filter, rebuilt
 * every column definition of every table in the console. Measured with the
 * counter below, no `selection` prop: 6 rebuilds across 3 re-renders and 6
 * across 3 filter keystrokes. The fix is the module-scope `NO_SELECTION_IDS`
 * constant in loom-data-table.tsx; these tests are what keep it there.
 *
 * The mock wraps Fluent's REAL `createTableColumn` (it delegates), so the grid
 * under test is the real one — the spy only counts.
 *
 * Lives in its own file because `vi.mock` of `@fluentui/react-components` is
 * hoisted and file-wide; the behavioural suite next door must keep the
 * unmodified module.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';

/** Incremented once per column definition built by the table under test. */
let columnBuilds = 0;

vi.mock('@fluentui/react-components', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@fluentui/react-components')>();
  return {
    ...actual,
    createTableColumn: (...args: unknown[]) => {
      columnBuilds += 1;
      return (actual.createTableColumn as (...a: unknown[]) => unknown)(...args);
    },
  };
});

// Imported AFTER the mock so the table picks up the counting wrapper.
import { LoomDataTable, type LoomColumn, type LoomSelection } from '../loom-data-table';

interface Row { id: string; name: string; type: string }
const ROWS: Row[] = [
  { id: 'a', name: 'Alpha', type: 'lakehouse' },
  { id: 'b', name: 'Bravo', type: 'notebook' },
];
/** Filtering off — the plain re-render scenarios. */
const COLUMNS: LoomColumn<Row>[] = [
  { key: 'name', label: 'Name', filterable: false },
  { key: 'type', label: 'Type', filterable: false },
];
/** Name carries a free-text filter, so keystrokes drive `filteredRows`. */
const FILTER_COLUMNS: LoomColumn<Row>[] = [
  { key: 'name', label: 'Name', filterType: 'text' },
  { key: 'type', label: 'Type', filterable: false },
];

function wrap(ui: React.ReactElement) {
  return render(<FluentProvider theme={webLightTheme}>{ui}</FluentProvider>);
}
function themed(ui: React.ReactElement) {
  return <FluentProvider theme={webLightTheme}>{ui}</FluentProvider>;
}

beforeEach(() => { columnBuilds = 0; });
afterEach(cleanup);

describe('LoomDataTable — column-definition memo stability', () => {
  /**
   * The embedded control. Everything below asserts a ZERO, and a zero is also
   * what a counter that stopped counting reports. This proves the counter is
   * live and that one mount costs exactly one definition per declared column.
   */
  it('CONTROL: the counter is live — one mount builds one definition per column', () => {
    wrap(<LoomDataTable columns={COLUMNS} rows={ROWS} getRowId={(r) => r.id} />);
    expect(columnBuilds).toBe(COLUMNS.length);
  });

  it('rebuilds NO column definitions when a consumer without `selection` re-renders with a fresh rows array', () => {
    const { rerender } = wrap(
      // The shape 172 consumers use: an inline derivation, new array identity
      // every render.
      <LoomDataTable columns={COLUMNS} rows={ROWS.filter(() => true)} getRowId={(r) => r.id} />,
    );
    columnBuilds = 0;
    for (let i = 0; i < 3; i += 1) {
      rerender(
        themed(<LoomDataTable columns={COLUMNS} rows={ROWS.filter(() => true)} getRowId={(r) => r.id} />),
      );
    }
    expect(columnBuilds).toBe(0);
  });

  it('rebuilds NO column definitions when a consumer without `selection` types in a column filter', () => {
    wrap(<LoomDataTable columns={FILTER_COLUMNS} rows={ROWS} getRowId={(r) => r.id} />);
    columnBuilds = 0;
    const input = screen.getByLabelText('Filter by Name');
    for (const value of ['B', 'Br', 'Bra']) {
      fireEvent.change(input, { target: { value } });
    }
    // The filter really did narrow the grid — otherwise this asserts nothing.
    expect(screen.queryByText('Alpha')).not.toBeInTheDocument();
    expect(columnBuilds).toBe(0);
  });

  it('rebuilds NO column definitions when a consumer without `selection` re-renders with a stable rows array', () => {
    const { rerender } = wrap(
      <LoomDataTable columns={COLUMNS} rows={ROWS} getRowId={(r) => r.id} />,
    );
    columnBuilds = 0;
    for (let i = 0; i < 3; i += 1) {
      rerender(themed(<LoomDataTable columns={COLUMNS} rows={ROWS} getRowId={(r) => r.id} />));
    }
    expect(columnBuilds).toBe(0);
  });

  /**
   * The other half of the control: a table that DOES opt into selection must
   * still rebuild when the visible id set changes, because the checkbox column
   * closes over `selectVisibleIds`. If this ever reads 0 the memo has been
   * over-tightened and select-all would fire with a stale id list.
   */
  it('CONTROL: a consumer WITH `selection` does rebuild when the filter changes the visible ids', () => {
    const selection: LoomSelection<Row> = {
      selectedIds: new Set<string>(),
      onToggleRow: vi.fn(),
      onToggleAll: vi.fn(),
    };
    wrap(
      <LoomDataTable
        columns={FILTER_COLUMNS} rows={ROWS} getRowId={(r) => r.id} selection={selection}
      />,
    );
    columnBuilds = 0;
    fireEvent.change(screen.getByLabelText('Filter by Name'), { target: { value: 'Bravo' } });
    expect(columnBuilds).toBeGreaterThan(0);
  });
});
