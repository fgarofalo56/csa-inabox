'use client';

/**
 * LoomDataTable — the one data table for CSA Loom.
 *
 * Built on Fluent v9 `DataGrid`. Every page that renders tabular data uses
 * this so they all get, for free:
 *   • Sortable columns        (click header; Fluent sortable + getSortDirection)
 *   • Resizable columns       (Fluent resizableColumns + columnSizingOptions)
 *   • Per-column filtering     (a filter input row under the header; client-side
 *                               substring match per column)
 *   • Sticky header, generous cell padding (no content butting borders),
 *     row hover, subtle row separators (not heavy table grid lines)
 *   • Empty-state + loading (Spinner) states
 *   • optional onRowClick
 *
 * Typed, generic API — replaces the app's ad-hoc `<table>`/`<Table>` usages.
 *
 *   <LoomDataTable
 *     columns={[
 *       { key: 'name', label: 'Name', sortable: true, filterable: true,
 *         render: (r) => <strong>{r.name}</strong> },
 *       { key: 'type', label: 'Type', sortable: true, filterable: true },
 *       { key: 'modified', label: 'Modified', sortable: true, width: 160 },
 *     ]}
 *     rows={items}
 *     getRowId={(r) => r.id}
 *     onRowClick={(r) => router.push(`/items/${r.type}/${r.id}`)}
 *     loading={isLoading}
 *     empty="No items in this workspace yet."
 *   />
 */

import * as React from 'react';
import {
  DataGrid,
  DataGridHeader,
  DataGridHeaderCell,
  DataGridRow,
  DataGridBody,
  DataGridCell,
  createTableColumn,
  Spinner,
  Input,
  Text,
  makeStyles,
  tokens,
  mergeClasses,
  type TableColumnDefinition,
  type TableColumnSizingOptions,
} from '@fluentui/react-components';
import { DismissCircle24Regular, Search16Regular } from '@fluentui/react-icons';

/** A single column definition. Generic over the row type. */
export interface LoomColumn<T> {
  /** Stable key; also the property read for default sort/filter/cell text. */
  key: string;
  /** Header label. */
  label: string;
  /** Custom cell renderer. Defaults to `String(row[key])`. */
  render?: (row: T) => React.ReactNode;
  /** Plain-text accessor for sort + filter. Defaults to `String(row[key])`. */
  getValue?: (row: T) => string | number;
  /** Enable click-to-sort on this column. Default true. */
  sortable?: boolean;
  /** Show a per-column filter input under the header. Default true. */
  filterable?: boolean;
  /** Initial/ideal column width in px (still user-resizable). */
  width?: number;
  /** Min width in px for resize. */
  minWidth?: number;
}

export interface LoomDataTableProps<T> {
  columns: LoomColumn<T>[];
  rows: T[];
  /** Stable id per row. */
  getRowId: (row: T) => string;
  /** Show the loading Spinner instead of rows. */
  loading?: boolean;
  /** Message (or node) shown when there are zero rows. */
  empty?: React.ReactNode;
  /** Row click handler — rows become keyboard-activatable when set. */
  onRowClick?: (row: T) => void;
  /** Disable the per-column filter row entirely. Default false. */
  noFilters?: boolean;
  /** Optional aria-label for the grid. */
  ariaLabel?: string;
}

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    width: '100%',
    minWidth: 0,
  },
  // Sticky header + subtle separators, generous padding, no heavy grid lines.
  grid: {
    width: '100%',
    '& [role="row"]': {
      borderBottom: `1px solid ${tokens.colorNeutralStroke3}`,
    },
    // generous cell padding so text never butts a border
    '& [role="gridcell"], & [role="columnheader"]': {
      paddingTop: '10px',
      paddingBottom: '10px',
      paddingLeft: tokens.spacingHorizontalM,
      paddingRight: tokens.spacingHorizontalM,
    },
  },
  headerRow: {
    position: 'sticky',
    top: 0,
    zIndex: 2,
    backgroundColor: tokens.colorNeutralBackground1,
    borderBottom: `2px solid ${tokens.colorNeutralStroke2}`,
  },
  headerCell: {
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorNeutralForeground1,
  },
  bodyRow: {
    transitionDuration: tokens.durationFaster,
    transitionProperty: 'background-color',
    ':hover': {
      backgroundColor: tokens.colorNeutralBackground1Hover,
    },
  },
  clickableRow: {
    cursor: 'pointer',
  },
  // filter row: a tinted band of inputs directly under the header
  filterRow: {
    display: 'flex',
    gap: tokens.spacingHorizontalS,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    backgroundColor: tokens.colorNeutralBackground2,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    position: 'sticky',
    top: 0,
    zIndex: 1,
    flexWrap: 'wrap',
  },
  filterField: {
    minWidth: '140px',
    flex: '1 1 160px',
    maxWidth: '320px',
  },
  filterInput: {
    width: '100%',
  },
  // empty + loading states: padded, centered, never edge-to-edge
  stateBox: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: tokens.spacingVerticalM,
    padding: tokens.spacingVerticalXXXL,
    minHeight: '180px',
    color: tokens.colorNeutralForeground3,
    textAlign: 'center',
  },
});

function defaultGetValue<T>(col: LoomColumn<T>, row: T): string | number {
  if (col.getValue) return col.getValue(row);
  const v = (row as Record<string, unknown>)[col.key];
  if (v == null) return '';
  if (typeof v === 'number') return v;
  return String(v);
}

export function LoomDataTable<T>(props: LoomDataTableProps<T>): React.ReactElement {
  const {
    columns,
    rows,
    getRowId,
    loading = false,
    empty = 'No items to show.',
    onRowClick,
    noFilters = false,
    ariaLabel,
  } = props;
  const styles = useStyles();

  // per-column filter text, keyed by column.key
  const [filters, setFilters] = React.useState<Record<string, string>>({});
  const anyFilterable =
    !noFilters && columns.some((c) => c.filterable !== false);

  // client-side substring filtering, per column
  const filteredRows = React.useMemo(() => {
    const active = Object.entries(filters).filter(([, v]) => v.trim() !== '');
    if (active.length === 0) return rows;
    return rows.filter((row) =>
      active.every(([key, needle]) => {
        const col = columns.find((c) => c.key === key);
        if (!col) return true;
        const hay = String(defaultGetValue(col, row)).toLowerCase();
        return hay.includes(needle.toLowerCase());
      }),
    );
  }, [rows, filters, columns]);

  // Fluent column definitions with compareItems (sort) + renderCell.
  const fluentColumns: TableColumnDefinition<T>[] = React.useMemo(
    () =>
      columns.map((col) =>
        createTableColumn<T>({
          columnId: col.key,
          compare: (a, b) => {
            const av = defaultGetValue(col, a);
            const bv = defaultGetValue(col, b);
            if (typeof av === 'number' && typeof bv === 'number') return av - bv;
            return String(av).localeCompare(String(bv));
          },
          renderHeaderCell: () => col.label,
          renderCell: (row) =>
            col.render ? col.render(row) : String(defaultGetValue(col, row)),
        }),
      ),
    [columns],
  );

  // resizable column sizing options from declared widths
  const columnSizingOptions: TableColumnSizingOptions = React.useMemo(() => {
    const out: TableColumnSizingOptions = {};
    for (const col of columns) {
      out[col.key] = {
        minWidth: col.minWidth ?? 100,
        idealWidth: col.width ?? 200,
        defaultWidth: col.width ?? 200,
      };
    }
    return out;
  }, [columns]);

  // which columns are sortable (Fluent `sortable` is grid-wide; per-column we
  // gate by not registering a sort handler on non-sortable headers)
  const sortableKeys = React.useMemo(
    () => new Set(columns.filter((c) => c.sortable !== false).map((c) => c.key)),
    [columns],
  );

  if (loading) {
    return (
      <div className={styles.root}>
        <div className={styles.stateBox}>
          <Spinner size="medium" label="Loading…" />
        </div>
      </div>
    );
  }

  return (
    <div className={styles.root}>
      {anyFilterable && (
        <div className={styles.filterRow} role="search">
          {columns.map((col) =>
            col.filterable !== false ? (
              <div key={col.key} className={styles.filterField}>
                <Input
                  className={styles.filterInput}
                  size="small"
                  contentBefore={<Search16Regular />}
                  placeholder={`Filter ${col.label}`}
                  aria-label={`Filter by ${col.label}`}
                  value={filters[col.key] ?? ''}
                  onChange={(_e, data) =>
                    setFilters((f) => ({ ...f, [col.key]: data.value }))
                  }
                  contentAfter={
                    filters[col.key] ? (
                      <DismissCircle24Regular
                        role="button"
                        aria-label={`Clear ${col.label} filter`}
                        tabIndex={0}
                        style={{ cursor: 'pointer', width: 16, height: 16 }}
                        onClick={() =>
                          setFilters((f) => ({ ...f, [col.key]: '' }))
                        }
                      />
                    ) : undefined
                  }
                />
              </div>
            ) : null,
          )}
        </div>
      )}

      <DataGrid
        items={filteredRows}
        columns={fluentColumns}
        getRowId={getRowId}
        sortable
        resizableColumns
        columnSizingOptions={columnSizingOptions}
        focusMode="cell"
        aria-label={ariaLabel ?? 'Data table'}
        className={styles.grid}
      >
        <DataGridHeader>
          <DataGridRow className={styles.headerRow}>
            {({ renderHeaderCell, columnId }) => (
              <DataGridHeaderCell
                className={styles.headerCell}
                // disable sort affordance on non-sortable columns
                {...(sortableKeys.has(String(columnId))
                  ? {}
                  : { 'aria-sort': undefined })}
              >
                {renderHeaderCell()}
              </DataGridHeaderCell>
            )}
          </DataGridRow>
        </DataGridHeader>

        <DataGridBody<T>>
          {({ item, rowId }) => (
            <DataGridRow<T>
              key={rowId}
              className={mergeClasses(
                styles.bodyRow,
                onRowClick ? styles.clickableRow : undefined,
              )}
              onClick={onRowClick ? () => onRowClick(item) : undefined}
              onKeyDown={
                onRowClick
                  ? (e: React.KeyboardEvent) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onRowClick(item);
                      }
                    }
                  : undefined
              }
            >
              {({ renderCell }) => (
                <DataGridCell>{renderCell(item)}</DataGridCell>
              )}
            </DataGridRow>
          )}
        </DataGridBody>
      </DataGrid>

      {filteredRows.length === 0 && (
        <div className={styles.stateBox}>
          <Text>{empty}</Text>
        </div>
      )}
    </div>
  );
}

export default LoomDataTable;
