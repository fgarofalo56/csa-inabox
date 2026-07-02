'use client';

/**
 * DeltaPreviewGrid — Fluent v9 DataGrid table preview for the Lakehouse editor,
 * one-for-one with the Fabric Lakehouse "Preview" data grid + Data Wrangler
 * column-summary panel:
 *
 *   - Sortable columns (numeric-aware compare), client-side filter box.
 *   - Resizable columns + multi-select rows.
 *   - Copy-as-CSV (Ctrl/Cmd+C, or toolbar button) — selected rows, or all
 *     rows when nothing is selected. RFC-4180 quoting. Header row included.
 *   - Download-as-CSV of the whole preview.
 *   - Cell preview dialog (click a cell to see the full, un-truncated value).
 *   - Column-summary card with real Spark-computed min/max/mean/stddev/nulls
 *     + a 10-bucket CSS histogram, with a Spinner while the async job runs.
 *   - File / Table mode toggle.
 *
 * Rows + columns come from /api/lakehouse/preview (structured). Stats come from
 * /api/lakehouse/table-stats (Spark summary job) — both passed in as props by
 * the parent so this stays a pure presentational grid. No mock data.
 */

import { useCallback, useMemo, useState } from 'react';
import {
  DataGrid, DataGridHeader, DataGridRow, DataGridHeaderCell, DataGridCell, DataGridBody,
  TableColumnDefinition, TableRowId, TableColumnSizingOptions,
  createTableColumn, useArrowNavigationGroup,
  Input, Button, Badge, Caption1, Spinner, Subtitle2, Text, Tooltip,
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Copy20Regular, ArrowDownload20Regular, Filter20Regular,
  ChevronDown20Regular, ChevronUp20Regular,
  TableSimple20Regular, DocumentTable20Regular, DataHistogram20Regular,
} from '@fluentui/react-icons';
import {
  formatCell, isNullish, columnIsNumeric, toCsv, fmtNum, rowMatchesFilter,
} from './delta-preview-grid-utils';

export interface ColStat {
  count: number;
  mean?: number | null;
  stddev?: number | null;
  min?: string | null;
  max?: string | null;
  nullCount?: number;
  histogram?: number[] | null;
}

export interface DeltaPreviewGridProps {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  executionMs?: number;
  truncated?: boolean;
  columnStats?: Record<string, ColStat> | null;
  statsLoading?: boolean;
  statsError?: string | null;
  mode: 'file' | 'table';
  onModeChange?: (m: 'file' | 'table') => void;
}

interface GridRow {
  __id: number;
  cells: unknown[];
}

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, minHeight: 0, flex: 1 },
  toolbar: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap', padding: `${tokens.spacingVerticalXS} 0` },
  spacer: { flex: 1 },
  filterInput: { maxWidth: '260px' },
  gridWrap: {
    overflow: 'auto', maxHeight: '520px',
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium,
    flex: 1, minHeight: 0,
  },
  monoCell: {
    fontFamily: 'Consolas, "Cascadia Code", monospace', fontSize: tokens.fontSizeBase200,
    whiteSpace: 'nowrap', maxWidth: '360px', overflow: 'hidden', textOverflow: 'ellipsis',
    cursor: 'pointer',
  },
  nullCell: { color: tokens.colorNeutralForeground4, fontStyle: 'italic' },
  statsPanel: {
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium,
    background: tokens.colorNeutralBackground2,
  },
  statsHeader: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`, cursor: 'pointer',
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  statsGrid: {
    display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
    gap: tokens.spacingHorizontalS, padding: tokens.spacingVerticalM,
  },
  statCard: {
    padding: tokens.spacingVerticalS, background: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium,
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS,
  },
  statRow: { display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', alignItems: 'center' },
  hist: { display: 'flex', alignItems: 'flex-end', gap: '1px', height: '32px', marginTop: tokens.spacingVerticalXS },
  histBar: { flex: 1, background: tokens.colorBrandBackground, borderRadius: '1px', minHeight: '1px' },
  dialogValue: {
    fontFamily: 'Consolas, monospace', fontSize: tokens.fontSizeBase200, whiteSpace: 'pre-wrap',
    wordBreak: 'break-all', maxHeight: '50vh', overflow: 'auto',
    background: tokens.colorNeutralBackground3, padding: tokens.spacingVerticalM, borderRadius: tokens.borderRadiusMedium,
  },
});

export function DeltaPreviewGrid(props: DeltaPreviewGridProps) {
  const s = useStyles();
  const { columns, rows, rowCount, executionMs, truncated, columnStats, statsLoading, statsError, mode, onModeChange } = props;

  const [filterText, setFilterText] = useState('');
  const [selectedRows, setSelectedRows] = useState<Set<TableRowId>>(new Set());
  const [statsOpen, setStatsOpen] = useState(true);
  const [cellDialog, setCellDialog] = useState<{ col: string; value: unknown } | null>(null);
  const arrowNav = useArrowNavigationGroup({ axis: 'grid' });

  // Which columns are numeric (drives sort compare + histogram styling).
  const numericCols = useMemo(() => {
    const set = new Set<number>();
    columns.forEach((_, i) => { if (columnIsNumeric(rows, i)) set.add(i); });
    return set;
  }, [columns, rows]);

  // Client-side filter — match across any cell, case-insensitive. No re-fetch.
  const filteredRows = useMemo<GridRow[]>(() => {
    const needle = filterText.trim().toLowerCase();
    const mapped = rows.map((cells, idx) => ({ __id: idx, cells }));
    if (!needle) return mapped;
    return mapped.filter((r) => rowMatchesFilter(r.cells, needle));
  }, [rows, filterText]);

  const gridColumns = useMemo<TableColumnDefinition<GridRow>[]>(() =>
    columns.map((colName, colIdx) =>
      createTableColumn<GridRow>({
        columnId: `c${colIdx}`,
        compare: (a, b) => {
          const av = a.cells[colIdx];
          const bv = b.cells[colIdx];
          if (numericCols.has(colIdx)) return Number(av) - Number(bv);
          return formatCell(av).localeCompare(formatCell(bv));
        },
        renderHeaderCell: () => colName,
        renderCell: (row) => {
          const v = row.cells[colIdx];
          const display = formatCell(v);
          return (
            <span
              className={isNullish(v) ? `${s.monoCell} ${s.nullCell}` : s.monoCell}
              title={display}
              onClick={() => setCellDialog({ col: colName, value: v })}
              role="button"
              tabIndex={-1}
            >
              {display}
            </span>
          );
        },
      }),
    ),
  [columns, numericCols, s]);

  const columnSizingOptions = useMemo<TableColumnSizingOptions>(() => {
    const opts: TableColumnSizingOptions = {};
    columns.forEach((_, colIdx) => { opts[`c${colIdx}`] = { minWidth: 80, defaultWidth: 160, idealWidth: 160 }; });
    return opts;
  }, [columns]);

  // Copy-as-CSV — selected rows (mapped back to source order) or all filtered rows.
  const copyCsv = useCallback(async () => {
    const source = selectedRows.size > 0
      ? filteredRows.filter((r) => selectedRows.has(r.__id)).map((r) => r.cells)
      : filteredRows.map((r) => r.cells);
    const csv = toCsv(columns, source);
    try {
      await navigator.clipboard.writeText(csv);
    } catch {
      // Clipboard API unavailable (insecure context) — fall back to a hidden textarea.
      const ta = document.createElement('textarea');
      ta.value = csv;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } finally { document.body.removeChild(ta); }
    }
  }, [selectedRows, filteredRows, columns]);

  const downloadCsv = useCallback(() => {
    const csv = toCsv(columns, filteredRows.map((r) => r.cells));
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'preview.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [columns, filteredRows]);

  // Ctrl/Cmd+C anywhere in the grid copies the CSV selection (matches Fabric).
  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C')) {
      // Only intercept when there is no active text selection the browser
      // would otherwise copy.
      const sel = typeof window !== 'undefined' ? window.getSelection?.()?.toString() : '';
      if (!sel) {
        e.preventDefault();
        void copyCsv();
      }
    }
  }, [copyCsv]);

  const statEntries = useMemo(() => {
    if (!columnStats) return [];
    return columns.map((c) => ({ col: c, stat: columnStats[c] })).filter((e) => e.stat);
  }, [columnStats, columns]);

  return (
    <div className={s.root}>
      <div className={s.toolbar}>
        <Button
          appearance={mode === 'file' ? 'primary' : 'outline'}
          icon={<DocumentTable20Regular />}
          size="small"
          onClick={() => onModeChange?.('file')}
        >
          File
        </Button>
        <Button
          appearance={mode === 'table' ? 'primary' : 'outline'}
          icon={<TableSimple20Regular />}
          size="small"
          onClick={() => onModeChange?.('table')}
        >
          Table
        </Button>
        <Input
          className={s.filterInput}
          size="small"
          contentBefore={<Filter20Regular />}
          placeholder="Filter rows…"
          value={filterText}
          onChange={(_, d) => setFilterText(d.value)}
        />
        <Caption1>
          {filteredRows.length === rows.length
            ? `${rowCount.toLocaleString()} rows`
            : `${filteredRows.length.toLocaleString()} of ${rows.length.toLocaleString()} shown`}
          {selectedRows.size > 0 ? ` · ${selectedRows.size} selected` : ''}
          {executionMs !== undefined ? ` · ${executionMs} ms` : ''}
          {truncated ? ' · truncated' : ''}
        </Caption1>
        <div className={s.spacer} />
        <Tooltip content="Copy selection as CSV (Ctrl+C)" relationship="label">
          <Button appearance="subtle" size="small" icon={<Copy20Regular />} onClick={() => void copyCsv()}>
            Copy CSV
          </Button>
        </Tooltip>
        <Tooltip content="Download all shown rows as CSV" relationship="label">
          <Button appearance="subtle" size="small" icon={<ArrowDownload20Regular />} onClick={downloadCsv}>
            Download
          </Button>
        </Tooltip>
      </div>

      <div className={s.gridWrap} {...arrowNav} onKeyDown={onKeyDown} tabIndex={0}>
        <DataGrid
          items={filteredRows}
          columns={gridColumns}
          sortable
          resizableColumns
          columnSizingOptions={columnSizingOptions}
          selectionMode="multiselect"
          getRowId={(item) => (item as GridRow).__id}
          selectedItems={selectedRows}
          onSelectionChange={(_, data) => setSelectedRows(new Set(data.selectedItems))}
          focusMode="composite"
          size="small"
        >
          <DataGridHeader>
            <DataGridRow selectionCell={{ 'aria-label': 'Select all rows' }}>
              {({ renderHeaderCell }) => <DataGridHeaderCell>{renderHeaderCell()}</DataGridHeaderCell>}
            </DataGridRow>
          </DataGridHeader>
          <DataGridBody<GridRow>>
            {({ item, rowId }) => (
              <DataGridRow<GridRow> key={rowId} selectionCell={{ 'aria-label': 'Select row' }}>
                {({ renderCell }) => <DataGridCell>{renderCell(item)}</DataGridCell>}
              </DataGridRow>
            )}
          </DataGridBody>
        </DataGrid>
      </div>

      {/* Column-summary card — real Spark-computed stats. */}
      <div className={s.statsPanel}>
        <div className={s.statsHeader} onClick={() => setStatsOpen((o) => !o)} role="button" tabIndex={0}>
          <DataHistogram20Regular />
          <Subtitle2>Column statistics</Subtitle2>
          {statsLoading && <Spinner size="tiny" label="Spark summary running…" labelPosition="after" />}
          {!statsLoading && statEntries.length > 0 && <Badge appearance="tint" color="brand">{statEntries.length} columns</Badge>}
          <div className={s.spacer} />
          {statsOpen ? <ChevronUp20Regular /> : <ChevronDown20Regular />}
        </div>
        {statsOpen && (
          <>
            {statsLoading && statEntries.length === 0 && (
              <div className={s.statsGrid}>
                <Caption1>Computing min / max / mean / stddev / distribution on the Spark pool…</Caption1>
              </div>
            )}
            {!statsLoading && statsError && (
              <div className={s.statsGrid}><Caption1>Column statistics unavailable: {statsError}</Caption1></div>
            )}
            {!statsLoading && !statsError && statEntries.length === 0 && (
              <div className={s.statsGrid}><Caption1>Select a file to compute column statistics.</Caption1></div>
            )}
            {statEntries.length > 0 && (
              <div className={s.statsGrid}>
                {statEntries.map(({ col, stat }) => {
                  const hist = stat.histogram;
                  const maxH = hist && hist.length ? Math.max(...hist, 0.0001) : 0;
                  return (
                    <div key={col} className={s.statCard}>
                      <Text weight="semibold" truncate title={col}>{col}</Text>
                      <div className={s.statRow}>
                        <Badge appearance="outline" size="small">count {fmtNum(stat.count)}</Badge>
                        {stat.nullCount !== undefined && <Badge appearance="outline" size="small" color="warning">nulls {fmtNum(stat.nullCount)}</Badge>}
                      </div>
                      <div className={s.statRow}>
                        <Caption1>min {stat.min ?? '—'}</Caption1>
                        <Caption1>max {stat.max ?? '—'}</Caption1>
                      </div>
                      {(stat.mean !== null && stat.mean !== undefined) && (
                        <div className={s.statRow}>
                          <Caption1>mean {fmtNum(stat.mean)}</Caption1>
                          <Caption1>stddev {fmtNum(stat.stddev)}</Caption1>
                        </div>
                      )}
                      {hist && hist.length > 0 && maxH > 0 && (
                        <div className={s.hist} aria-label="value distribution">
                          {hist.map((h, i) => (
                            <div key={i} className={s.histBar} style={{ height: `${Math.max(2, (h / maxH) * 100)}%` }} />
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>

      <Dialog open={!!cellDialog} onOpenChange={(_, d) => { if (!d.open) setCellDialog(null); }}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>{cellDialog?.col}</DialogTitle>
            <DialogContent>
              <div className={s.dialogValue}>{cellDialog ? formatCell(cellDialog.value) : ''}</div>
            </DialogContent>
            <DialogActions>
              <Button
                appearance="secondary"
                icon={<Copy20Regular />}
                onClick={() => { if (cellDialog) void navigator.clipboard?.writeText(formatCell(cellDialog.value)).catch(() => {}); }}
              >
                Copy value
              </Button>
              <Button appearance="primary" onClick={() => setCellDialog(null)}>Close</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
}
