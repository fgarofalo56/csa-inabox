'use client';

/**
 * KustoResultsGrid — the rich KQL results grid for the CSA Loom ADX/Kusto
 * query surface, modelled one-for-one on the Azure Data Explorer web UI
 * results grid (`https://dataexplorer.azure.com`).
 *
 * This is a PURE CLIENT-SIDE component over the REAL `{ columns, columnTypes,
 * rows }` already returned by the live Kusto query route
 * (`/api/items/kql-database/[id]/query`, `/api/items/kql-queryset/[id]/run`)
 * via `lib/azure/kusto-client.ts` → `executeQuery` / `executeMgmtCommand`.
 * No backend change, no mock data (per `.claude/rules/no-vaporware.md`).
 *
 * Parity inventory built here (ADX web-UI results grid features B2–B9):
 *   - Sort by column header (asc → desc → none), type-aware: numeric and
 *     datetime columns sort by value, not lexically.
 *   - Per-column filter (substring, case-insensitive) + a global
 *     search-in-grid box; matching cells are highlighted.
 *   - Column statistics popover: numeric → count / nulls / min / max / sum /
 *     avg; any column → distinct count + most-common value.
 *   - Export: download the *visible* (sorted + filtered) rows as CSV
 *     (real client-side Blob), and Copy-to-clipboard as TSV.
 *   - "Showing N of M" readout, sticky header, and a render cap so large
 *     result sets never freeze the tab (the cap is honest: it tells you how
 *     many of the matched rows are rendered).
 *
 * Theme: Fluent v9 + Loom tokens. All `makeStyles` declarations use
 * STRING-valued CSS (e.g. `gap: '8px'`) to avoid the Griffel numeric-quirk
 * type errors that plague the older numeric `makeStyles` blocks in this app.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Button, Input, Caption1, Badge, Tooltip, Divider,
  Popover, PopoverTrigger, PopoverSurface,
  makeStyles, tokens, mergeClasses,
} from '@fluentui/react-components';
import {
  ArrowSortUp16Regular, ArrowSortDown16Regular, ArrowSort16Regular,
  Search16Regular, Filter16Regular, FilterDismiss16Regular,
  ArrowDownload16Regular, Copy16Regular, DataHistogram16Regular,
} from '@fluentui/react-icons';

// ============================================================
// Types
// ============================================================
export interface KustoResultsGridProps {
  columns: string[];
  /** Kusto data types per column (e.g. 'Int64', 'DateTime', 'String'). Optional. */
  columnTypes?: string[];
  rows: unknown[][];
  /** Total server-side row count, if larger than `rows` (truncation note). */
  totalRowCount?: number;
  /** Max rows actually rendered to the DOM at once (perf cap). Default 1000. */
  renderCap?: number;
  /** Base name for the exported CSV file (no extension). */
  exportName?: string;
}

type SortDir = 'asc' | 'desc' | null;

interface ColumnStats {
  count: number;
  nulls: number;
  distinct: number;
  isNumeric: boolean;
  min?: number;
  max?: number;
  sum?: number;
  avg?: number;
  mostCommon?: { value: string; n: number };
}

// ============================================================
// Pure helpers (exported for testing — real assertions, no UI)
// ============================================================

/** Format a single cell value for display / export (objects → JSON). */
export function formatCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

const NUMERIC_KUSTO_TYPES = new Set([
  'int', 'int32', 'int64', 'long', 'real', 'double', 'decimal', 'float',
]);
const DATETIME_KUSTO_TYPES = new Set(['datetime', 'date']);

/**
 * Decide whether a column should sort numerically. Prefers the declared Kusto
 * type; falls back to sampling the actual cell values when the type is unknown.
 */
export function isNumericColumn(
  colIdx: number,
  rows: unknown[][],
  columnTypes?: string[],
): boolean {
  const declared = columnTypes?.[colIdx]?.toLowerCase().trim();
  if (declared) {
    if (NUMERIC_KUSTO_TYPES.has(declared)) return true;
    if (DATETIME_KUSTO_TYPES.has(declared)) return false;
    if (declared === 'string' || declared === 'guid' || declared === 'bool' || declared === 'boolean') {
      return false;
    }
  }
  // Unknown type → sample up to 50 non-empty cells; numeric only if ALL parse.
  let seen = 0;
  for (const r of rows) {
    const v = r[colIdx];
    if (v === null || v === undefined || v === '') continue;
    if (typeof v === 'number') { seen++; if (seen >= 50) break; continue; }
    const n = Number(v);
    if (Number.isNaN(n)) return false;
    seen++;
    if (seen >= 50) break;
  }
  return seen > 0;
}

function isDateTimeColumn(colIdx: number, columnTypes?: string[]): boolean {
  const declared = columnTypes?.[colIdx]?.toLowerCase().trim();
  return !!declared && DATETIME_KUSTO_TYPES.has(declared);
}

/**
 * Type-aware comparator builder for one column. Numbers compare numerically,
 * datetimes by epoch ms, everything else as a case-insensitive string. Null /
 * empty values always sort last (regardless of direction), matching ADX.
 */
export function makeComparator(
  colIdx: number,
  dir: Exclude<SortDir, null>,
  rows: unknown[][],
  columnTypes?: string[],
): (a: unknown[], b: unknown[]) => number {
  const numeric = isNumericColumn(colIdx, rows, columnTypes);
  const datetime = isDateTimeColumn(colIdx, columnTypes);
  const mult = dir === 'asc' ? 1 : -1;
  const key = (row: unknown[]): { empty: boolean; n: number; s: string } => {
    const v = row[colIdx];
    const empty = v === null || v === undefined || v === '';
    if (empty) return { empty: true, n: 0, s: '' };
    if (numeric) return { empty: false, n: Number(v), s: '' };
    if (datetime) {
      const t = Date.parse(String(v));
      return { empty: Number.isNaN(t), n: Number.isNaN(t) ? 0 : t, s: '' };
    }
    return { empty: false, n: 0, s: formatCell(v).toLowerCase() };
  };
  return (a, b) => {
    const ka = key(a);
    const kb = key(b);
    // Empties always last.
    if (ka.empty && kb.empty) return 0;
    if (ka.empty) return 1;
    if (kb.empty) return -1;
    if (numeric || datetime) return (ka.n - kb.n) * mult;
    return ka.s.localeCompare(kb.s) * mult;
  };
}

/** Compute per-column statistics over the supplied rows. */
export function computeColumnStats(
  colIdx: number,
  rows: unknown[][],
  columnTypes?: string[],
): ColumnStats {
  const numeric = isNumericColumn(colIdx, rows, columnTypes);
  let count = 0;
  let nulls = 0;
  let sum = 0;
  let numericCount = 0;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  const freq = new Map<string, number>();
  for (const r of rows) {
    count++;
    const v = r[colIdx];
    if (v === null || v === undefined || v === '') { nulls++; continue; }
    const s = formatCell(v);
    freq.set(s, (freq.get(s) || 0) + 1);
    if (numeric) {
      const n = Number(v);
      if (!Number.isNaN(n)) {
        sum += n;
        numericCount++;
        if (n < min) min = n;
        if (n > max) max = n;
      }
    }
  }
  let mostCommon: { value: string; n: number } | undefined;
  for (const [value, n] of freq) {
    if (!mostCommon || n > mostCommon.n) mostCommon = { value, n };
  }
  return {
    count,
    nulls,
    distinct: freq.size,
    isNumeric: numeric,
    min: numericCount ? min : undefined,
    max: numericCount ? max : undefined,
    sum: numericCount ? sum : undefined,
    avg: numericCount ? sum / numericCount : undefined,
    mostCommon,
  };
}

/**
 * Build RFC-4180 CSV text from columns + rows. Cells containing a comma,
 * double-quote, or newline are quoted with `"` doubled. Exported for testing.
 */
export function buildCsv(columns: string[], rows: unknown[][]): string {
  const esc = (cell: unknown): string => {
    const s = formatCell(cell);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = columns.map(esc).join(',');
  const body = rows.map((r) => columns.map((_, j) => esc(r[j])).join(',')).join('\n');
  return body ? `${header}\n${body}` : header;
}

/** Build TSV text (used for clipboard copy). Exported for testing. */
export function buildTsv(columns: string[], rows: unknown[][]): string {
  const esc = (cell: unknown): string => formatCell(cell).replace(/[\t\n\r]/g, ' ');
  const header = columns.map(esc).join('\t');
  const body = rows.map((r) => columns.map((_, j) => esc(r[j])).join('\t')).join('\n');
  return body ? `${header}\n${body}` : header;
}

/** Min / max draggable column width (px) — matches the ADX results grid feel. */
export const MIN_COL_WIDTH = 48;
export const MAX_COL_WIDTH = 900;

/** Clamp a dragged column width into the allowed range. Exported for testing. */
export function clampColumnWidth(px: number): number {
  if (Number.isNaN(px)) return MIN_COL_WIDTH;
  return Math.max(MIN_COL_WIDTH, Math.min(MAX_COL_WIDTH, Math.round(px)));
}

// ============================================================
// Styles (string-valued only → no Griffel numeric-quirk errors)
// ============================================================
const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    minWidth: '0',
  },
  toolbar: {
    display: 'flex',
    gap: '8px',
    alignItems: 'center',
    flexWrap: 'wrap',
  },
  spacer: { marginLeft: 'auto' },
  search: { minWidth: '220px' },
  scroll: {
    overflow: 'auto',
    maxHeight: '420px',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: '4px',
  },
  table: {
    borderCollapse: 'collapse',
    width: '100%',
    fontSize: '12px',
    fontFamily: 'Consolas, "Cascadia Code", monospace',
  },
  thead: {
    position: 'sticky',
    top: '0',
    zIndex: '1',
  },
  th: {
    textAlign: 'left',
    padding: '0',
    backgroundColor: tokens.colorNeutralBackground3,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRight: `1px solid ${tokens.colorNeutralStroke3}`,
    verticalAlign: 'top',
    whiteSpace: 'nowrap',
    position: 'relative',
  },
  resizeHandle: {
    position: 'absolute',
    top: '0',
    right: '0',
    bottom: '0',
    width: '6px',
    cursor: 'col-resize',
    userSelect: 'none',
    backgroundColor: 'transparent',
    zIndex: '2',
    ':hover': { backgroundColor: tokens.colorBrandStroke1 },
  },
  resizeHandleActive: {
    backgroundColor: tokens.colorBrandStroke1,
  },
  thInner: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    padding: '4px 6px',
  },
  thHeaderRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    cursor: 'pointer',
    userSelect: 'none',
  },
  thLabel: {
    fontWeight: tokens.fontWeightSemibold,
    fontFamily: tokens.fontFamilyBase,
  },
  thType: {
    color: tokens.colorNeutralForeground4,
    fontFamily: tokens.fontFamilyBase,
    fontWeight: tokens.fontWeightRegular,
  },
  colFilter: {
    minWidth: '0',
    width: '100%',
  },
  td: {
    padding: '2px 6px',
    borderBottom: `1px solid ${tokens.colorNeutralStroke3}`,
    borderRight: `1px solid ${tokens.colorNeutralStroke3}`,
    whiteSpace: 'nowrap',
    maxWidth: '420px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  tdNumeric: { textAlign: 'right' },
  rowEven: { backgroundColor: tokens.colorNeutralBackground1 },
  rowOdd: { backgroundColor: tokens.colorNeutralBackground2 },
  highlight: {
    backgroundColor: tokens.colorPaletteYellowBackground2,
    color: tokens.colorNeutralForeground1,
    borderRadius: '2px',
  },
  statsPanel: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    minWidth: '220px',
    maxWidth: '320px',
  },
  statRow: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: '16px',
  },
  statLabel: { color: tokens.colorNeutralForeground3 },
  statValue: {
    fontFamily: 'Consolas, monospace',
    fontWeight: tokens.fontWeightSemibold,
  },
  empty: { padding: '12px' },
  statBtn: {
    minWidth: 'auto',
    padding: '2px',
  },
});

// ============================================================
// Highlight helper — wrap matched substrings in a <mark>-like span
// ============================================================
function HighlightedText({ text, term, className }: { text: string; term: string; className: string }) {
  if (!term) return <>{text}</>;
  const lower = text.toLowerCase();
  const needle = term.toLowerCase();
  const out: React.ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < text.length) {
    const found = lower.indexOf(needle, i);
    if (found < 0) { out.push(text.slice(i)); break; }
    if (found > i) out.push(text.slice(i, found));
    out.push(
      <span key={key++} className={className}>{text.slice(found, found + needle.length)}</span>,
    );
    i = found + needle.length;
  }
  return <>{out}</>;
}

// ============================================================
// Column stats popover
// ============================================================
function ColumnStatsPopover({
  colName, colIdx, rows, columnTypes,
}: {
  colName: string;
  colIdx: number;
  rows: unknown[][];
  columnTypes?: string[];
}) {
  const s = useStyles();
  const [open, setOpen] = useState(false);
  // Compute lazily, only when the popover is opened (avoids scanning on render).
  const stats = useMemo<ColumnStats | null>(
    () => (open ? computeColumnStats(colIdx, rows, columnTypes) : null),
    [open, colIdx, rows, columnTypes],
  );
  const fmtNum = (n: number | undefined) =>
    n === undefined ? '—' : (Number.isInteger(n) ? n.toLocaleString() : n.toLocaleString(undefined, { maximumFractionDigits: 4 }));
  return (
    <Popover open={open} onOpenChange={(_, d) => setOpen(d.open)} positioning="below-end" withArrow>
      <PopoverTrigger disableButtonEnhancement>
        <Tooltip content={`Column statistics — ${colName}`} relationship="label">
          <Button
            className={s.statBtn}
            appearance="subtle"
            size="small"
            icon={<DataHistogram16Regular />}
            aria-label={`Statistics for ${colName}`}
            onClick={(e) => { e.stopPropagation(); }}
          />
        </Tooltip>
      </PopoverTrigger>
      <PopoverSurface>
        <div className={s.statsPanel}>
          <Caption1><strong>{colName}</strong> statistics (current view)</Caption1>
          <Divider />
          {stats && (
            <>
              <div className={s.statRow}><span className={s.statLabel}>Rows</span><span className={s.statValue}>{fmtNum(stats.count)}</span></div>
              <div className={s.statRow}><span className={s.statLabel}>Nulls / empty</span><span className={s.statValue}>{fmtNum(stats.nulls)}</span></div>
              <div className={s.statRow}><span className={s.statLabel}>Distinct</span><span className={s.statValue}>{fmtNum(stats.distinct)}</span></div>
              {stats.isNumeric && (
                <>
                  <Divider />
                  <div className={s.statRow}><span className={s.statLabel}>Min</span><span className={s.statValue}>{fmtNum(stats.min)}</span></div>
                  <div className={s.statRow}><span className={s.statLabel}>Max</span><span className={s.statValue}>{fmtNum(stats.max)}</span></div>
                  <div className={s.statRow}><span className={s.statLabel}>Sum</span><span className={s.statValue}>{fmtNum(stats.sum)}</span></div>
                  <div className={s.statRow}><span className={s.statLabel}>Avg</span><span className={s.statValue}>{fmtNum(stats.avg)}</span></div>
                </>
              )}
              {!stats.isNumeric && stats.mostCommon && (
                <>
                  <Divider />
                  <div className={s.statRow}>
                    <span className={s.statLabel}>Most common</span>
                    <span className={s.statValue} title={stats.mostCommon.value}>
                      {stats.mostCommon.value.length > 18 ? stats.mostCommon.value.slice(0, 18) + '…' : stats.mostCommon.value} ({stats.mostCommon.n})
                    </span>
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </PopoverSurface>
    </Popover>
  );
}

// ============================================================
// Main grid
// ============================================================
export function KustoResultsGrid({
  columns,
  columnTypes,
  rows,
  totalRowCount,
  renderCap = 1000,
  exportName = 'kusto-results',
}: KustoResultsGridProps) {
  const s = useStyles();
  const [sortCol, setSortCol] = useState<number | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>(null);
  const [globalSearch, setGlobalSearch] = useState('');
  const [colFilters, setColFilters] = useState<Record<number, string>>({});
  const [showColFilters, setShowColFilters] = useState(false);
  const linkRef = useRef<HTMLAnchorElement | null>(null);
  // Column resize — drag the right edge of any header to set an explicit
  // column width, one-for-one with the ADX web-UI results grid. Empty by
  // default → columns auto-size; a resized column persists its px width.
  const [columnWidths, setColumnWidths] = useState<Record<number, number>>({});
  const [resizingCol, setResizingCol] = useState<number | null>(null);
  // Live drag session (no re-render per mousemove until width changes).
  const dragRef = useRef<{ col: number; startX: number; startW: number } | null>(null);

  // Window-level move/up listeners drive the drag. Attaching once and gating on
  // dragRef keeps the resize smooth and unmounts cleanly mid-drag.
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      e.preventDefault();
      const next = clampColumnWidth(d.startW + (e.clientX - d.startX));
      setColumnWidths((prev) => (prev[d.col] === next ? prev : { ...prev, [d.col]: next }));
    };
    const onUp = () => {
      if (dragRef.current) { dragRef.current = null; setResizingCol(null); }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  const startResize = useCallback((e: React.MouseEvent, col: number) => {
    // Don't trigger header sort while resizing.
    e.preventDefault();
    e.stopPropagation();
    const th = (e.currentTarget as HTMLElement).parentElement; // the <th>
    const startW = columnWidths[col] ?? (th ? th.getBoundingClientRect().width : MIN_COL_WIDTH);
    dragRef.current = { col, startX: e.clientX, startW: clampColumnWidth(startW) };
    setResizingCol(col);
  }, [columnWidths]);

  const autoFitColumn = useCallback((col: number) => {
    // Double-click the handle clears the explicit width → back to auto-size.
    setColumnWidths((prev) => {
      if (!(col in prev)) return prev;
      const next = { ...prev };
      delete next[col];
      return next;
    });
  }, []);

  const numericFlags = useMemo(
    () => columns.map((_, c) => isNumericColumn(c, rows, columnTypes)),
    [columns, rows, columnTypes],
  );

  const activeColFilters = useMemo(
    () => Object.entries(colFilters).filter(([, v]) => v.trim() !== '') as [string, string][],
    [colFilters],
  );

  // 1) Filter (per-column + global), 2) sort. Pure derivation over real rows.
  const filtered = useMemo(() => {
    const g = globalSearch.trim().toLowerCase();
    const perCol = activeColFilters.map(([k, v]) => [Number(k), v.trim().toLowerCase()] as [number, string]);
    if (!g && perCol.length === 0) return rows;
    return rows.filter((row) => {
      if (g) {
        const hit = columns.some((_, j) => formatCell(row[j]).toLowerCase().includes(g));
        if (!hit) return false;
      }
      for (const [idx, term] of perCol) {
        if (!formatCell(row[idx]).toLowerCase().includes(term)) return false;
      }
      return true;
    });
  }, [rows, columns, globalSearch, activeColFilters]);

  const sorted = useMemo(() => {
    if (sortCol === null || sortDir === null) return filtered;
    const cmp = makeComparator(sortCol, sortDir, rows, columnTypes);
    return [...filtered].sort(cmp);
  }, [filtered, sortCol, sortDir, rows, columnTypes]);

  const capped = useMemo(
    () => (sorted.length > renderCap ? sorted.slice(0, renderCap) : sorted),
    [sorted, renderCap],
  );

  const totalRows = totalRowCount ?? rows.length;

  const cycleSort = useCallback((col: number) => {
    setSortCol((prevCol) => {
      if (prevCol !== col) { setSortDir('asc'); return col; }
      // same column: asc → desc → none
      setSortDir((d) => (d === 'asc' ? 'desc' : d === 'desc' ? null : 'asc'));
      return col;
    });
  }, []);

  const setColFilter = useCallback((col: number, value: string) => {
    setColFilters((prev) => ({ ...prev, [col]: value }));
  }, []);

  const clearFilters = useCallback(() => {
    setColFilters({});
    setGlobalSearch('');
  }, []);

  const downloadCsv = useCallback(() => {
    const csv = buildCsv(columns, sorted);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = linkRef.current ?? document.createElement('a');
    a.href = url;
    a.download = `${exportName}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }, [columns, sorted, exportName]);

  const copyTsv = useCallback(async () => {
    const tsv = buildTsv(columns, sorted);
    try {
      await navigator.clipboard.writeText(tsv);
    } catch {
      // Clipboard blocked (insecure context / permissions) — fall back to a
      // hidden textarea + execCommand so Copy still works. Honest: no silent
      // success if both paths fail.
      const ta = document.createElement('textarea');
      ta.value = tsv;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } finally { document.body.removeChild(ta); }
    }
  }, [columns, sorted]);

  if (columns.length === 0) {
    return <Caption1 className={s.empty}>Query returned no columns.</Caption1>;
  }

  const filtersActive = activeColFilters.length > 0 || globalSearch.trim() !== '';
  const shown = capped.length;
  const matched = sorted.length;

  return (
    <div className={s.root}>
      {/* Toolbar: search, column-filter toggle, readout, export, copy */}
      <div className={s.toolbar}>
        <Input
          className={s.search}
          size="small"
          contentBefore={<Search16Regular />}
          placeholder="Search in grid…"
          value={globalSearch}
          onChange={(_, d) => setGlobalSearch(d.value)}
          aria-label="Search in grid"
        />
        <Tooltip content={showColFilters ? 'Hide column filters' : 'Show per-column filters'} relationship="label">
          <Button
            size="small"
            appearance={showColFilters ? 'primary' : 'subtle'}
            icon={<Filter16Regular />}
            aria-label="Toggle column filters"
            onClick={() => setShowColFilters((v) => !v)}
          />
        </Tooltip>
        {filtersActive && (
          <Tooltip content="Clear all filters" relationship="label">
            <Button size="small" appearance="subtle" icon={<FilterDismiss16Regular />} aria-label="Clear filters" onClick={clearFilters} />
          </Tooltip>
        )}
        <Caption1 aria-label="row readout">
          Showing <strong>{shown.toLocaleString()}</strong>
          {matched !== shown && <> of <strong>{matched.toLocaleString()}</strong> matched</>}
          {(filtersActive || matched !== totalRows) && <> · {totalRows.toLocaleString()} total</>}
          {' '}rows
        </Caption1>
        {matched > shown && (
          <Badge appearance="outline" color="warning">capped at {renderCap.toLocaleString()}</Badge>
        )}
        <div className={s.spacer} />
        <Tooltip content="Copy visible rows (TSV) to clipboard" relationship="label">
          <Button size="small" appearance="subtle" icon={<Copy16Regular />} onClick={copyTsv}>Copy</Button>
        </Tooltip>
        <Tooltip content="Download visible rows as CSV" relationship="label">
          <Button size="small" appearance="subtle" icon={<ArrowDownload16Regular />} onClick={downloadCsv}>CSV</Button>
        </Tooltip>
        {/* eslint-disable-next-line jsx-a11y/anchor-has-content */}
        <a ref={linkRef} style={{ display: 'none' }} aria-hidden />
      </div>

      {/* Grid */}
      <div className={s.scroll} role="region" aria-label="KQL results grid">
        <table className={s.table}>
          <thead className={s.thead}>
            <tr>
              {columns.map((c, ci) => {
                const isSorted = sortCol === ci;
                const SortIcon = isSorted && sortDir === 'asc'
                  ? ArrowSortUp16Regular
                  : isSorted && sortDir === 'desc'
                    ? ArrowSortDown16Regular
                    : ArrowSort16Regular;
                return (
                  <th key={ci} className={s.th} style={columnWidths[ci] ? { width: `${columnWidths[ci]}px` } : undefined}>
                    <div className={s.thInner}>
                      <div
                        className={s.thHeaderRow}
                        onClick={() => cycleSort(ci)}
                        role="button"
                        tabIndex={0}
                        aria-label={`Sort by ${c}`}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); cycleSort(ci); } }}
                      >
                        <span className={s.thLabel}>{c}</span>
                        {columnTypes?.[ci] && <span className={s.thType}>{columnTypes[ci]}</span>}
                        <SortIcon />
                        <ColumnStatsPopover colName={c} colIdx={ci} rows={sorted} columnTypes={columnTypes} />
                      </div>
                      {showColFilters && (
                        <Input
                          className={s.colFilter}
                          size="small"
                          placeholder="filter…"
                          value={colFilters[ci] ?? ''}
                          onChange={(_, d) => setColFilter(ci, d.value)}
                          onClick={(e) => e.stopPropagation()}
                          aria-label={`Filter ${c}`}
                        />
                      )}
                    </div>
                    <div
                      className={mergeClasses(s.resizeHandle, resizingCol === ci && s.resizeHandleActive)}
                      role="separator"
                      aria-orientation="vertical"
                      aria-label={`Resize ${c} column`}
                      onMouseDown={(e) => startResize(e, ci)}
                      onDoubleClick={(e) => { e.stopPropagation(); autoFitColumn(ci); }}
                      onClick={(e) => e.stopPropagation()}
                    />
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {capped.map((row, ri) => (
              <tr key={ri} className={ri % 2 === 0 ? s.rowEven : s.rowOdd}>
                {columns.map((_, ci) => {
                  const text = formatCell(row[ci]);
                  const cls = mergeClasses(s.td, numericFlags[ci] && s.tdNumeric);
                  const w = columnWidths[ci];
                  return (
                    <td key={ci} className={cls} title={text} style={w ? { width: `${w}px`, maxWidth: `${w}px` } : undefined}>
                      {globalSearch.trim()
                        ? <HighlightedText text={text} term={globalSearch.trim()} className={s.highlight} />
                        : text}
                    </td>
                  );
                })}
              </tr>
            ))}
            {capped.length === 0 && (
              <tr>
                <td className={s.td} colSpan={columns.length}>
                  <Caption1>No rows match the current filters.</Caption1>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default KustoResultsGrid;
