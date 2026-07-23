'use client';

/**
 * PreviewTable (SC-5) — the shared, Fabric-grade data-preview grid.
 *
 *   ┌ table_a ✕ | table_b ✕ ─────────────────── [range ▾] [search] Refresh ┐
 *   │ ┌ Abc name ┬ 123 qty ┬ latlong loc ┬ time ts ─────────────────────┐  │
 *   │ │  sensor  │   30.1  │  47.6,-122  │  2026-07-09T…                │  │
 *   ├─────────────────────────────────────────────────────────────────────┤
 *   │ Succeeded (3 sec 30 ms) · Columns 54 · Rows 1,000                     │
 *   └─────────────────────────────────────────────────────────────────────┘
 *
 * Generalizes `components/eventstream/data-preview-dock.tsx` into a reusable
 * component every Loom data surface can adopt:
 *   - TYPE-BADGED column headers (Abc / 123 / latlong / bool / Json / time),
 *     inferred from the real rows, with an optional per-column type override.
 *   - "Succeeded (Xs) · Columns N · Rows N" timing STATUS BAR.
 *   - client-side SEARCH; optional time-range picker + Refresh.
 *   - CLOSEABLE per-source TABS (one lakehouse table per tab; one query result
 *     per tab).
 *
 * Every source provides EITHER preloaded `data` (static mode — the caller
 * already ran the query, e.g. the Warehouse editor) OR an async `load` (fetch
 * mode — the grid pulls the newest rows itself, e.g. a Lakehouse table preview).
 * Both feed the SAME real Azure backend (`{ columns, rows }` from OPENROWSET /
 * TDS / ADX). No mock data; nothing here touches Microsoft Fabric.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Tab, TabList, Button, Select, Input, Caption1, Spinner, Tooltip,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, shorthands, tokens,
} from '@fluentui/react-components';
import { ArrowSync16Regular, Search16Regular, Dismiss12Regular } from '@fluentui/react-icons';
import {
  shapeColumnarPreview, filterColumnarRows, formatPreviewCell, statusBarText,
  TYPE_BADGE_TEXT, PREVIEW_CELL_TYPES,
  type PreviewCellType, type PreviewColumn,
} from './preview-table-shaping';
import { useInEditorResultsSplit, SPLIT_FILL_STYLE } from '@/lib/components/editor/editor-split-context';

/** Preset time ranges for the optional "Show data from" picker. */
export interface PreviewTimeRange { id: string; label: string }
export const PREVIEW_TIME_RANGES: PreviewTimeRange[] = [
  { id: '5m', label: 'Last 5 minutes' },
  { id: '1h', label: 'Last hour' },
  { id: '24h', label: 'Last 24 hours' },
  { id: '7d', label: 'Last 7 days' },
  { id: 'all', label: 'All time' },
];

/** A columnar preview result — the shape every Loom data-plane route returns. */
export interface PreviewData {
  columns: string[];
  rows: unknown[][];
  /** Server-reported execution time for the status bar (ms). */
  elapsedMs?: number;
  /** Total row count when it differs from `rows.length` (server truncated). */
  rowCount?: number;
  /** The backend capped the row set (renders a "+" on the Rows count). */
  truncated?: boolean;
  /** Optional note shown above the grid (e.g. "newest rows from the ADX sink"). */
  note?: string;
}

export type PreviewLoadResult =
  | { ok: true; data: PreviewData }
  | { ok: false; gate?: string; error?: string };

export type PreviewLoader = (ctx: { rangeId: string }) => Promise<PreviewLoadResult>;

/** One preview source = one closeable tab. Provide `data` OR `load`. */
export interface PreviewSource {
  id: string;
  label: string;
  /** Static mode: preloaded rows (the caller already ran the query). */
  data?: PreviewData;
  /** Fetch mode: the grid loads rows itself (and on Refresh / range change). */
  load?: PreviewLoader;
  /** Whether this tab shows a ✕ close affordance (default: true when >1 tab). */
  closeable?: boolean;
}

export interface PreviewTableProps {
  sources: PreviewSource[];
  /** Controlled active tab id (uncontrolled if omitted). */
  activeSourceId?: string;
  onActiveSourceChange?: (id: string) => void;
  /** Close a tab (renders a ✕ per closeable source). */
  onCloseSource?: (id: string) => void;
  /** Force the tab strip on/off (default: shown when >1 source). */
  showTabs?: boolean;
  /** Show the time-range picker (default false — off for static table previews). */
  showTimeRange?: boolean;
  /** Show the search box (default true). */
  showSearch?: boolean;
  /** Show the Refresh button (default: any source has a `load`). */
  showRefresh?: boolean;
  /** Allow per-column data-type override via the header dropdown (default false). */
  typeOverridable?: boolean;
  /** Max rows rendered into the DOM (default 1000, the Fabric preview cap). */
  maxRows?: number;
  /** Grid max height (default 360px). */
  maxHeight?: number | string;
  ariaLabel?: string;
}

interface LoadedState {
  status: 'idle' | 'loading' | 'ok' | 'gate' | 'error';
  data?: PreviewData;
  gate?: string;
  error?: string;
}

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    backgroundColor: tokens.colorNeutralBackground1,
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke2),
    ...shorthands.borderRadius(tokens.borderRadiusMedium),
    overflow: 'hidden',
    minWidth: 0,
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    ...shorthands.padding(tokens.spacingVerticalXS, tokens.spacingHorizontalS),
    ...shorthands.borderBottom('1px', 'solid', tokens.colorNeutralStroke2),
    backgroundColor: tokens.colorNeutralBackground2,
    gap: tokens.spacingHorizontalS,
    flexWrap: 'wrap',
  },
  tab: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXXS },
  tabClose: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    color: tokens.colorNeutralForeground3,
    ...shorthands.borderRadius(tokens.borderRadiusSmall),
    ':hover': { color: tokens.colorNeutralForeground1, backgroundColor: tokens.colorNeutralBackground1Hover },
  },
  toolbar: {
    display: 'flex',
    alignItems: 'flex-end',
    gap: tokens.spacingHorizontalS,
    ...shorthands.padding(tokens.spacingVerticalS, tokens.spacingHorizontalS),
    flexWrap: 'wrap',
  },
  field: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS },
  fieldLabel: { color: tokens.colorNeutralForeground3 },
  search: { marginLeft: 'auto', minWidth: '180px' },
  body: {
    overflow: 'auto',
    maxHeight: '360px',
    minHeight: '96px',
    ...shorthands.padding('0', tokens.spacingHorizontalS, tokens.spacingVerticalS),
  },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: tokens.fontSizeBase200 },
  th: {
    textAlign: 'left',
    position: 'sticky',
    top: '0',
    backgroundColor: tokens.colorNeutralBackground2,
    ...shorthands.padding(tokens.spacingVerticalXS, tokens.spacingHorizontalS),
    ...shorthands.borderBottom('1px', 'solid', tokens.colorNeutralStroke2),
    whiteSpace: 'nowrap',
    verticalAlign: 'bottom',
  },
  thInner: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS },
  typeBadge: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: '30px',
    height: '16px',
    ...shorthands.padding('0', tokens.spacingHorizontalXXS),
    ...shorthands.borderRadius(tokens.borderRadiusSmall),
    backgroundColor: tokens.colorNeutralBackground4,
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeBase100,
    fontFamily: tokens.fontFamilyMonospace,
    lineHeight: '16px',
    userSelect: 'none',
  },
  typeSelect: { minWidth: '92px', marginTop: tokens.spacingVerticalXXS },
  td: {
    ...shorthands.padding(tokens.spacingVerticalXS, tokens.spacingHorizontalS),
    ...shorthands.borderBottom('1px', 'solid', tokens.colorNeutralStroke3),
    fontFamily: tokens.fontFamilyMonospace,
    maxWidth: '340px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  rowAlt: { backgroundColor: tokens.colorNeutralBackground2 },
  empty: {
    color: tokens.colorNeutralForeground3,
    ...shorthands.padding(tokens.spacingVerticalL, tokens.spacingHorizontalS),
    fontStyle: 'italic',
  },
  statusBar: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    ...shorthands.padding(tokens.spacingVerticalXS, tokens.spacingHorizontalS),
    ...shorthands.borderTop('1px', 'solid', tokens.colorNeutralStroke2),
    backgroundColor: tokens.colorNeutralBackground2,
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
  },
});

const EMPTY_ROWS: unknown[][] = [];

export function PreviewTable(props: PreviewTableProps) {
  const {
    sources, activeSourceId, onActiveSourceChange, onCloseSource,
    showTimeRange = false, showSearch = true, typeOverridable = false,
    maxRows = 1000, maxHeight, ariaLabel = 'Data preview',
  } = props;
  const s = useStyles();
  // U6 — inside an EditorResultsSplit results pane the grid flex-fills the
  // user-sized pane instead of capping at the flow-layout maxHeight.
  const inSplit = useInEditorResultsSplit();

  const showTabs = props.showTabs ?? sources.length > 1;
  const showRefresh = props.showRefresh ?? sources.some((src) => typeof src.load === 'function');

  // Active tab — controlled by the parent when `activeSourceId` is provided.
  const [innerActive, setInnerActive] = useState<string | undefined>(sources[0]?.id);
  const activeId = activeSourceId ?? innerActive;
  const active = sources.find((src) => src.id === activeId) ?? sources[0];

  const [search, setSearch] = useState('');
  const [rangeId, setRangeId] = useState('1h');
  const [overrides, setOverrides] = useState<Record<string, PreviewCellType>>({});

  // Per-source load state (fetch mode). Static sources resolve immediately.
  const [loaded, setLoaded] = useState<Record<string, LoadedState>>({});
  const loadedRef = useRef(loaded);
  loadedRef.current = loaded;

  const setActive = useCallback((id: string) => {
    if (onActiveSourceChange) onActiveSourceChange(id);
    else setInnerActive(id);
    setSearch('');
  }, [onActiveSourceChange]);

  const runLoad = useCallback(async (src: PreviewSource, force: boolean) => {
    if (!src.load) return;
    if (!force && loadedRef.current[src.id]?.status && loadedRef.current[src.id].status !== 'idle') return;
    setLoaded((prev) => ({ ...prev, [src.id]: { status: 'loading' } }));
    try {
      const res = await src.load({ rangeId });
      setLoaded((prev) => ({
        ...prev,
        [src.id]: res.ok
          ? { status: 'ok', data: res.data }
          : res.gate
            ? { status: 'gate', gate: res.gate }
            : { status: 'error', error: res.error || 'preview failed' },
      }));
    } catch (e: unknown) {
      setLoaded((prev) => ({ ...prev, [src.id]: { status: 'error', error: e instanceof Error ? e.message : String(e) } }));
    }
  }, [rangeId]);

  // Auto-load the active fetch-mode source the first time it becomes active.
  useEffect(() => {
    if (active?.load) void runLoad(active, false);
  }, [active, runLoad]);

  const refresh = useCallback(() => { if (active) void runLoad(active, true); }, [active, runLoad]);

  // Resolve the data currently backing the active tab (static or fetched).
  const state: LoadedState = active?.data
    ? { status: 'ok', data: active.data }
    : (active ? loaded[active.id] ?? { status: 'idle' } : { status: 'idle' });

  const data = state.data;
  const shape = useMemo(
    () => shapeColumnarPreview(data?.columns ?? [], data?.rows ?? EMPTY_ROWS, { typeOverrides: overrides }),
    [data, overrides],
  );
  const visibleRows = useMemo(
    () => (showSearch ? filterColumnarRows(data?.rows ?? EMPTY_ROWS, search) : (data?.rows ?? EMPTY_ROWS)),
    [data, search, showSearch],
  );

  const setColType = useCallback((name: string, type: PreviewCellType) => {
    setOverrides((prev) => ({ ...prev, [name]: type }));
  }, []);

  const busy = state.status === 'loading';
  const totalRows = data?.rowCount ?? data?.rows?.length ?? 0;

  return (
    <div
      className={s.root}
      role="region"
      aria-label={ariaLabel}
      style={inSplit ? { flexGrow: 1, flexShrink: 1, flexBasis: '0%', minHeight: 0 } : undefined}
    >
      <div className={s.header}>
        {showTabs ? (
          <TabList selectedValue={activeId} onTabSelect={(_, d) => setActive(d.value as string)} size="small">
            {sources.map((src) => {
              const closeable = src.closeable ?? sources.length > 1;
              return (
                <Tab key={src.id} value={src.id}>
                  <span className={s.tab}>
                    {src.label}
                    {closeable && onCloseSource && (
                      // A span (not a <button>) so we never nest interactive
                      // elements inside Fluent's <button role="tab"> (invalid DOM).
                      <span
                        role="button"
                        tabIndex={0}
                        aria-label={`Close ${src.label}`}
                        className={s.tabClose}
                        onClick={(e) => { e.stopPropagation(); onCloseSource(src.id); }}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onCloseSource(src.id); } }}
                      >
                        <Dismiss12Regular />
                      </span>
                    )}
                  </span>
                </Tab>
              );
            })}
          </TabList>
        ) : (
          <Caption1 style={{ fontWeight: tokens.fontWeightSemibold }}>{active?.label ?? 'Preview'}</Caption1>
        )}
        {showRefresh && (
          <Button
            size="small"
            appearance="subtle"
            icon={busy ? <Spinner size="tiny" /> : <ArrowSync16Regular />}
            onClick={refresh}
            disabled={busy || !active?.load}
          >
            {busy ? 'Refreshing…' : 'Refresh'}
          </Button>
        )}
      </div>

      {(showTimeRange || showSearch) && (
        <div className={s.toolbar}>
          {showTimeRange && (
            <label className={s.field}>
              <Caption1 className={s.fieldLabel}>Show data from</Caption1>
              <Select
                size="small"
                value={rangeId}
                onChange={(_, d) => { setRangeId(d.value); if (active?.load) void runLoad(active, true); }}
                aria-label="Time range"
              >
                {PREVIEW_TIME_RANGES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
              </Select>
            </label>
          )}
          {showSearch && (
            <Input
              className={s.search}
              size="small"
              contentBefore={<Search16Regular />}
              value={search}
              onChange={(_, d) => setSearch(d.value)}
              placeholder="Search rows…"
              aria-label="Search preview rows"
            />
          )}
        </div>
      )}

      <div className={s.body} style={inSplit ? SPLIT_FILL_STYLE : maxHeight !== undefined ? { maxHeight } : undefined}>
        {state.status === 'gate' && (
          <MessageBar intent="warning">
            <MessageBarBody><MessageBarTitle>Preview not available</MessageBarTitle>{state.gate}</MessageBarBody>
          </MessageBar>
        )}
        {state.status === 'error' && (
          <MessageBar intent="error">
            <MessageBarBody><MessageBarTitle>Preview failed</MessageBarTitle>{state.error}</MessageBarBody>
          </MessageBar>
        )}
        {data?.note && state.status === 'ok' && (
          <Caption1 className={s.fieldLabel} style={{ display: 'block', padding: `${tokens.spacingVerticalXS} 0` }}>{data.note}</Caption1>
        )}

        {state.status === 'idle' && !busy && (
          <div className={s.empty}>No preview loaded yet.</div>
        )}
        {busy && !data && (
          <div style={{ padding: tokens.spacingVerticalM }}><Spinner size="tiny" label="Loading preview…" /></div>
        )}

        {state.status === 'ok' && shape.columns.length > 0 && (
          <table className={s.table} aria-label={`${active?.label ?? 'Preview'} rows`}>
            <thead>
              <tr>
                {shape.columns.map((c) => (
                  <PreviewHeader
                    key={c.index}
                    col={c}
                    overridable={typeOverridable}
                    onType={setColType}
                    className={{ th: s.th, inner: s.thInner, badge: s.typeBadge, select: s.typeSelect }}
                  />
                ))}
              </tr>
            </thead>
            <tbody>
              {visibleRows.slice(0, maxRows).map((row, ri) => (
                <tr key={ri} className={ri % 2 ? s.rowAlt : undefined}>
                  {shape.columns.map((c) => {
                    const cell = Array.isArray(row) ? row[c.index] : undefined;
                    return <td key={c.index} className={s.td} title={formatPreviewCell(cell)}>{formatPreviewCell(cell)}</td>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {state.status === 'ok' && shape.columns.length === 0 && (
          <div className={s.empty}>The query ran but returned no columns.</div>
        )}
        {state.status === 'ok' && shape.columns.length > 0 && visibleRows.length === 0 && (
          <div className={s.empty}>No rows match the current search.</div>
        )}
      </div>

      {state.status === 'ok' && data && (
        <div className={s.statusBar} role="status" aria-label="Preview status">
          <span>{statusBarText('succeeded', {
            elapsedMs: data.elapsedMs,
            columns: shape.columns.length,
            rows: totalRows,
            truncated: data.truncated,
          })}</span>
        </div>
      )}
    </div>
  );
}

function PreviewHeader({
  col, overridable, onType, className,
}: {
  col: PreviewColumn;
  overridable: boolean;
  onType: (name: string, type: PreviewCellType) => void;
  className: { th: string; inner: string; badge: string; select: string };
}) {
  const badge = TYPE_BADGE_TEXT[col.type];
  return (
    <th className={className.th}>
      <div className={className.inner}>
        <Tooltip content={badge.label} relationship="label">
          <span className={className.badge} aria-label={`${badge.label} column`}>{badge.text}</span>
        </Tooltip>
        <span>{col.name}</span>
      </div>
      {overridable && (
        <Select
          className={className.select}
          size="small"
          value={col.type}
          onChange={(_, d) => onType(col.name, d.value as PreviewCellType)}
          aria-label={`${col.name} data type`}
        >
          {PREVIEW_CELL_TYPES.map((t) => <option key={t} value={t}>{TYPE_BADGE_TEXT[t].label}</option>)}
        </Select>
      )}
    </th>
  );
}
