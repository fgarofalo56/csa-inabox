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
