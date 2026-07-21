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

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  DataGrid, DataGridHeader, DataGridRow, DataGridHeaderCell, DataGridCell, DataGridBody,
  TableColumnDefinition, TableRowId, TableColumnSizingOptions,
  createTableColumn, useArrowNavigationGroup,
  Input, Button, Badge, Caption1, Spinner, Subtitle2, Text, Tooltip,
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  TabList, Tab,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Copy20Regular, ArrowDownload20Regular, Filter20Regular,
  ChevronDown20Regular, ChevronUp20Regular,
  TableSimple20Regular, DocumentTable20Regular, DataHistogram20Regular,
  Sparkle20Regular, Grid20Regular,
} from '@fluentui/react-icons';
import {
  formatCell, isNullish, columnIsNumeric, toCsv, fmtNum, rowMatchesFilter,
  type ColStat,
} from './delta-preview-grid-utils';
import { AddAiColumnDialog, type ProducedAiColumn } from './add-ai-column-dialog';
import { DataWranglerAiPanel, type PreviewSource } from './data-wrangler-ai-panel';
import { AskAffordance, type AskSurfaceKind } from '@/lib/components/ask/AskAffordance';

// Re-exported for existing consumers that import `ColStat` from this module
// (e.g. lakehouse-editor-shell). The type now lives in the leaf utils module.
export type { ColStat };

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
  /** G2 — show the "Add AI column" action (Fabric parity). Default true. Set
   *  false for surfaces where enriching the preview makes no sense. */
  enableAiColumn?: boolean;
  /** G4 — show the Data Wrangler "AI" tab (cleaning suggestions + NL-to-code +
   *  live transform preview). Default true; forced off in the nested result
   *  grid the AI panel renders (no infinite nesting). */
  enableAiTab?: boolean;
  /** G4 — the ADLS source of this preview, so the AI tab can run a candidate
   *  transform against a Livy-sampled DataFrame before apply. When absent the AI
   *  tab still renders but the live-preview action is disabled with a reason. */
  previewSource?: PreviewSource | null;
  /** G4 — insert generated/suggested code into a bound notebook cell. When
   *  absent the AI tab falls back to copy-to-clipboard. */
  onInsertToNotebook?: (code: string, lang: string) => void;
  // WS-5.4 — NL "Ask" affordance. When all three are provided, an "Ask" bar
  // appears below the grid backed by /api/ask → data-agent-client chatGrounded.
  askSurfaceKind?: AskSurfaceKind;
  askItemId?: string;
  askItemType?: string;
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
  const { columns: baseColumns, rows: baseRows, rowCount, executionMs, truncated, columnStats, statsLoading, statsError, mode, onModeChange, enableAiColumn = true, enableAiTab = true, previewSource, onInsertToNotebook, askSurfaceKind, askItemId, askItemType } = props;

  const [filterText, setFilterText] = useState('');
  const [selectedRows, setSelectedRows] = useState<Set<TableRowId>>(new Set());
  const [statsOpen, setStatsOpen] = useState(true);
  const [cellDialog, setCellDialog] = useState<{ col: string; value: unknown } | null>(null);
  // G4 — Data view vs. AI (Data Wrangler) tab.
  const [tab, setTab] = useState<'data' | 'ai'>('data');
  // G2 — AI columns appended over the loaded preview via /api/ai-functions/table.
  const [aiColumns, setAiColumns] = useState<ProducedAiColumn[]>([]);
  const [aiDialogOpen, setAiDialogOpen] = useState(false);
  const arrowNav = useArrowNavigationGroup({ axis: 'grid' });

  // Reset appended AI columns whenever the underlying preview changes (new file
  // / table / query) so a stale AI column can never misalign with fresh rows.
  useEffect(() => { setAiColumns([]); }, [baseColumns, baseRows]);

  // Effective grid = base columns/rows + any AI columns the user materialized.
  const columns = useMemo(
    () => (aiColumns.length ? [...baseColumns, ...aiColumns.map((c) => c.name)] : baseColumns),
    [baseColumns, aiColumns],
  );
  const rows = useMemo(
    () => (aiColumns.length
      ? baseRows.map((cells, idx) => [...cells, ...aiColumns.map((c) => c.values[idx] ?? '')])
      : baseRows),
    [baseRows, aiColumns],
  );

  // Which columns are numeric (drives sort compare + histogram styling).
  const numericCols = useMemo(() => {
    const set = new Set<number>();
    columns.forEach((_, i) => { if (columnIsNumeric(rows, i)) set.add(i); });
    return set;
  }, [columns, rows]);

  // Numeric column NAMES — fed to the Data Wrangler AI profile (G4).
  const numericColNames = useMemo(
    () => columns.filter((_, i) => numericCols.has(i)),
    [columns, numericCols],
  );

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
      {enableAiTab && (
        <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as 'data' | 'ai')} size="small">
          <Tab value="data" icon={<Grid20Regular />}>Data</Tab>
          <Tab value="ai" icon={<Sparkle20Regular />}>AI</Tab>
        </TabList>
      )}

      {tab === 'ai' && enableAiTab ? (
        <DataWranglerAiPanel
          columns={columns}
          rows={rows}
          columnStats={columnStats}
          numericColNames={numericColNames}
          previewSource={previewSource}
          onInsertToNotebook={onInsertToNotebook}
          renderResultGrid={(cols, resultRows, ms) => (
            <DeltaPreviewGrid
              columns={cols}
              rows={resultRows}
              rowCount={resultRows.length}
              executionMs={ms}
              mode="table"
              enableAiColumn={false}
              enableAiTab={false}
            />
          )}
        />
      ) : (
      <>
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
        {enableAiColumn && (
          <Tooltip content="Add a column computed by an Azure OpenAI function over these rows" relationship="label">
            <Button
              appearance="primary"
              size="small"
              icon={<Sparkle20Regular />}
              disabled={baseColumns.length === 0 || baseRows.length === 0}
              onClick={() => setAiDialogOpen(true)}
            >
              Add AI column
            </Button>
          </Tooltip>
        )}
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
      </>
      )}

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

      {enableAiColumn && aiDialogOpen && (
        <AddAiColumnDialog
          open={aiDialogOpen}
          onOpenChange={setAiDialogOpen}
          columns={columns}
          rows={rows}
          onApply={(produced) => setAiColumns((prev) => [...prev, ...produced])}
        />
      )}

      {/* WS-5.4 — NL "Ask" affordance: appears when the host passes askSurfaceKind
          + askItemId. Backed by /api/ask → chatGrounded (no Fabric required). */}
      {askSurfaceKind && askItemId && (
        <AskAffordance
          surfaceKind={askSurfaceKind}
          itemId={askItemId}
          itemType={askItemType ?? askSurfaceKind}
          context={{ columns, tables: undefined }}
          placeholder={`Ask about these ${rowCount.toLocaleString()} rows…`}
        />
      )}
    </div>
  );
}
