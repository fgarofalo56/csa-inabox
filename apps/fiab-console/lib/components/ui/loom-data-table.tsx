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
  Skeleton,
  SkeletonItem,
  Input,
  Dropdown,
  Option,
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
  /** Show a per-column filter under the header. Default true. */
  filterable?: boolean;
  /**
   * Filter control kind. Per the Loom filter standard, free-form text is for
   * Name-like columns ONLY; enumerable columns get a multi-select dropdown of
   * their distinct values; date columns get a from/to calendar range (gt/lt).
   * When unset it is inferred: name/title → 'text', date-like → 'date',
   * low-cardinality → 'select', otherwise 'text'.
   */
  filterType?: 'text' | 'select' | 'date';
  /** Explicit dropdown options for filterType 'select' (else distinct values are derived from the rows). */
  filterOptions?: string[];
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
  /**
   * Opt-in skeleton loading state. When `loading` is true AND this is set,
   * render gray placeholder rows that match the column layout (a stable
   * skeleton) instead of the bare centered Spinner. Defaults off so existing
   * consumers keep the Spinner behavior. Pass a number for the row count, or
   * `true` for the default of 6 rows.
   */
  skeleton?: boolean | number;
}

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    width: '100%',
    minWidth: 0,
    maxWidth: '100%',
    // When declared column widths exceed the container, scroll the table
    // horizontally WITHIN itself rather than letting it widen the page.
    overflowX: 'auto',
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
      // Clip cell content to its column so a long value can never spill over
      // (overlap) into the next column. minWidth:0 lets the cell shrink to its
      // resized width; overflow:hidden trims the excess. Multi-line cells still
      // wrap within their own width.
      minWidth: 0,
      overflow: 'hidden',
    },
    '& [role="gridcell"] > *': { minWidth: 0, maxWidth: '100%' },
  },
  headerRow: {
    position: 'sticky',
    top: 0,
    // Header must stay ABOVE both the body and the sticky filter row on scroll.
    zIndex: 3,
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
    // Above the body rows, but below the header row (zIndex 3) so the header
    // is never occluded by the filter band when the body scrolls under it.
    zIndex: 2,
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
  dateInput: {
    flex: 1,
    minWidth: 0,
    fontFamily: tokens.fontFamilyBase,
    fontSize: tokens.fontSizeBase200,
    padding: '3px 6px',
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    backgroundColor: tokens.colorNeutralBackground1,
    color: tokens.colorNeutralForeground1,
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
  // aria-live region announcing the filtered result count to screen readers.
  // Visually hidden — the count is already visible via the rows themselves.
  srStatus: {
    position: 'absolute',
    width: '1px',
    height: '1px',
    padding: 0,
    margin: '-1px',
    overflow: 'hidden',
    clip: 'rect(0 0 0 0)',
    whiteSpace: 'nowrap',
    border: 0,
  },
  // skeleton loading state: placeholder rows matching the column layout
  skeletonRow: {
    display: 'flex',
    gap: tokens.spacingHorizontalS,
    paddingTop: '10px',
    paddingBottom: '10px',
    paddingLeft: tokens.spacingHorizontalM,
    paddingRight: tokens.spacingHorizontalM,
    borderBottom: `1px solid ${tokens.colorNeutralStroke3}`,
  },
  skeletonHeaderRow: {
    backgroundColor: tokens.colorNeutralBackground1,
    borderBottom: `2px solid ${tokens.colorNeutralStroke2}`,
  },
  skeletonCell: {
    flex: '1 1 0',
    minWidth: 0,
  },
});

function defaultGetValue<T>(col: LoomColumn<T>, row: T): string | number {
  if (col.getValue) return col.getValue(row);
  const v = (row as Record<string, unknown>)[col.key];
  if (v == null) return '';
  if (typeof v === 'number') return v;
  return String(v);
}

type FilterKind = 'text' | 'select' | 'date';
/** Per-column filter value. text: substring; select: value ∈ set; date: from/to (gt/lt). */
interface ColFilter { text?: string; selected?: string[]; from?: string; to?: string }

const NAME_RE = /(^|_|\b)(name|title|displayname|label)(\b|_|$)/i;
const DATE_RE = /(date|time|created|modified|updated|timestamp|lastrun|expires|expiry|when)/i;
const SELECT_CARDINALITY_CAP = 40;

function looksDate(v: string): boolean {
  if (!v) return false;
  if (/^\d{4}-\d{2}-\d{2}/.test(v)) return true; // ISO-ish
  const t = Date.parse(v);
  return Number.isFinite(t) && /[-/:]/.test(v);
}

/** Resolve the filter control kind for a column (explicit → inferred). */
function resolveFilterKind<T>(col: LoomColumn<T>, distinct: string[]): FilterKind {
  if (col.filterType) return col.filterType;
  const k = `${col.key} ${col.label}`;
  if (NAME_RE.test(k)) return 'text';
  if (DATE_RE.test(k) || (distinct.length > 0 && distinct.slice(0, 8).every(looksDate))) return 'date';
  // Enumerable → dropdown; high-cardinality free-text → text.
  if (distinct.length > 0 && distinct.length <= SELECT_CARDINALITY_CAP) return 'select';
  return 'text';
}

function asDateMs(v: string | number): number | null {
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
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
    skeleton = false,
  } = props;
  const styles = useStyles();

  // per-column filter value, keyed by column.key
  const [filters, setFilters] = React.useState<Record<string, ColFilter>>({});
  const anyFilterable =
    !noFilters && columns.some((c) => c.filterable !== false);

  // Distinct values per column (for select dropdowns) + the resolved kind.
  const colMeta = React.useMemo(() => {
    const m: Record<string, { kind: FilterKind; options: string[] }> = {};
    for (const col of columns) {
      if (col.filterable === false) continue;
      let options = col.filterOptions;
      if (!options) {
        const set = new Set<string>();
        for (const row of rows) {
          const v = String(defaultGetValue(col, row)).trim();
          if (v) set.add(v);
          if (set.size > SELECT_CARDINALITY_CAP + 1) break;
        }
        options = Array.from(set).sort((a, b) => a.localeCompare(b));
      }
      m[col.key] = { kind: resolveFilterKind(col, options), options };
    }
    return m;
  }, [columns, rows]);

  // client-side filtering per column kind: text=substring, select=membership,
  // date=from/to range (gt/lt when one bound is blank).
  const filteredRows = React.useMemo(() => {
    const active = Object.entries(filters).filter(([key, f]) => {
      if (!f) return false;
      return (f.text && f.text.trim() !== '') || (f.selected && f.selected.length > 0) || f.from || f.to;
    });
    if (active.length === 0) return rows;
    return rows.filter((row) =>
      active.every(([key, f]) => {
        const col = columns.find((c) => c.key === key);
        if (!col) return true;
        const kind = colMeta[key]?.kind ?? 'text';
        const raw = defaultGetValue(col, row);
        if (kind === 'select') {
          if (!f.selected || f.selected.length === 0) return true;
          return f.selected.includes(String(raw).trim());
        }
        if (kind === 'date') {
          const ms = asDateMs(raw);
          if (ms == null) return false;
          if (f.from) { const fm = Date.parse(f.from); if (Number.isFinite(fm) && ms < fm) return false; }
          if (f.to) { const tm = Date.parse(f.to); if (Number.isFinite(tm) && ms > tm + 86_399_999) return false; }
          return true;
        }
        const needle = (f.text || '').trim().toLowerCase();
        if (!needle) return true;
        return String(raw).toLowerCase().includes(needle);
      }),
    );
  }, [rows, filters, columns, colMeta]);

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
    // Opt-in skeleton: stable placeholder rows matching the column layout so
    // the table doesn't collapse to a spinner / jump when data arrives.
    if (skeleton) {
      const rowCount = typeof skeleton === 'number' ? Math.max(1, skeleton) : 6;
      return (
        <div className={styles.root}>
          <Skeleton aria-label="Loading data table">
            <div className={mergeClasses(styles.skeletonRow, styles.skeletonHeaderRow)}>
              {columns.map((col) => (
                <div key={col.key} className={styles.skeletonCell}>
                  <SkeletonItem shape="rectangle" style={{ width: '60%', height: 16 }} />
                </div>
              ))}
            </div>
            {Array.from({ length: rowCount }).map((_, r) => (
              <div key={r} className={styles.skeletonRow}>
                {columns.map((col) => (
                  <div key={col.key} className={styles.skeletonCell}>
                    <SkeletonItem shape="rectangle" style={{ width: '85%', height: 14 }} />
                  </div>
                ))}
              </div>
            ))}
          </Skeleton>
        </div>
      );
    }
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
      {/* Announce the filtered result count to assistive tech. */}
      <div className={styles.srStatus} role="status" aria-live="polite">
        {filteredRows.length === rows.length
          ? `Showing ${rows.length} ${rows.length === 1 ? 'item' : 'items'}`
          : `Showing ${filteredRows.length} of ${rows.length} ${rows.length === 1 ? 'item' : 'items'}`}
      </div>
      {anyFilterable && (
        <div className={styles.filterRow} role="search">
          {columns.map((col) => {
            if (col.filterable === false) return null;
            const meta = colMeta[col.key];
            const f = filters[col.key] || {};
            const setF = (patch: Partial<ColFilter>) =>
              setFilters((prev) => ({ ...prev, [col.key]: { ...prev[col.key], ...patch } }));

            // Enumerable column → multi-select dropdown of distinct values.
            if (meta?.kind === 'select') {
              const sel = f.selected || [];
              return (
                <div key={col.key} className={styles.filterField}>
                  <Dropdown
                    className={styles.filterInput}
                    size="small"
                    multiselect
                    placeholder={`Filter ${col.label}`}
                    aria-label={`Filter by ${col.label}`}
                    selectedOptions={sel}
                    value={sel.length ? `${sel.length} selected` : ''}
                    onOptionSelect={(_e, d) => setF({ selected: d.selectedOptions })}
                  >
                    {meta.options.map((o) => (
                      <Option key={o} value={o}>{o}</Option>
                    ))}
                  </Dropdown>
                </div>
              );
            }

            // Date column → from/to calendar range (gt/lt when one side blank).
            if (meta?.kind === 'date') {
              return (
                <div key={col.key} className={styles.filterField} style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                  <span style={{ fontSize: '11px', color: tokens.colorNeutralForeground3 }}>{col.label}</span>
                  <div style={{ display: 'flex', gap: '4px' }}>
                    <input type="date" aria-label={`${col.label} from (on or after)`} value={f.from || ''}
                      onChange={(e) => setF({ from: e.target.value })} className={styles.dateInput} />
                    <input type="date" aria-label={`${col.label} to (on or before)`} value={f.to || ''}
                      onChange={(e) => setF({ to: e.target.value })} className={styles.dateInput} />
                  </div>
                </div>
              );
            }

            // Name-like / free-text column → text substring (the only free-form case).
            return (
              <div key={col.key} className={styles.filterField}>
                <Input
                  className={styles.filterInput}
                  size="small"
                  contentBefore={<Search16Regular />}
                  placeholder={`Filter ${col.label}`}
                  aria-label={`Filter by ${col.label}`}
                  value={f.text ?? ''}
                  onChange={(_e, data) => setF({ text: data.value })}
                  contentAfter={
                    f.text ? (
                      <DismissCircle24Regular
                        role="button"
                        aria-label={`Clear ${col.label} filter`}
                        tabIndex={0}
                        style={{ cursor: 'pointer', width: 16, height: 16 }}
                        onClick={() => setF({ text: '' })}
                      />
                    ) : undefined
                  }
                />
              </div>
            );
          })}
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
