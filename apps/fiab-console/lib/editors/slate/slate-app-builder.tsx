'use client';

/**
 * Slate app builder — the real, live dashboard/app builder surface for the
 * Fabric IQ `slate-app` item (Palantir Foundry Slate parity). Replaces the old
 * flat "title + kind + REST path" widget list with:
 *
 *   • a multi-type QUERY ENGINE + Queries panel (rest-dab / KQL / SQL) with
 *     Run/Preview against real Azure backends (ADX, Synapse serverless, DAB/APIM
 *     REST) via POST /api/items/slate-app/[id]/query/run — no mock data;
 *   • a DRAG-RESIZE widget CANVAS with a typed palette (Table / Chart / Metric /
 *     Text / Container) and a Fluent property inspector — every widget carries a
 *     persisted { x, y, w, h } layout;
 *   • a live in-editor PREVIEW (Run mode) that binds each widget to its query's
 *     live results with per-widget Spinner / EmptyState / honest-gate states.
 *
 * Azure-native by default (no Microsoft Fabric / Power BI). All config is
 * dropdown / structured-form driven; the only freeform surfaces are the KQL /
 * SQL query editors (legitimate query surfaces, allowed by .claude/rules).
 *
 * Persistence is via the parent editor's item PATCH (Cosmos): `onQueriesChange`
 * / `onWidgetsChange` write back into the slate-app item `state`.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type ReactElement } from 'react';
import {
  Body1, Caption1, Subtitle2, Badge, Button, Input, Textarea, Field, Dropdown, Option,
  Spinner, Tab, TabList, Tooltip, Divider,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  makeStyles, mergeClasses, tokens,
} from '@fluentui/react-components';
import {
  Add20Regular, Dismiss16Regular, Play20Regular, ArrowSync20Regular,
  Table20Regular, DataUsage20Regular, NumberSymbol20Regular, DocumentText20Regular,
  Apps20Regular, Globe20Regular, Flash20Regular, Database20Regular,
  Edit20Regular, ArrowMaximize20Regular,
} from '@fluentui/react-icons';
import { MonacoTextarea } from '@/lib/components/editor/monaco-textarea';
import { LoomChart, type LoomChartType } from '@/lib/components/charts/loom-chart';
import { EmptyState } from '@/lib/components/empty-state';

// ───────────────────────── types ─────────────────────────

export type SlateQueryType = 'rest-dab' | 'kql' | 'sql';

export interface SlateQueryDef {
  id: string;
  name: string;
  type: SlateQueryType;
  // rest-dab
  path?: string;
  method?: 'GET' | 'POST';
  resultPath?: string;
  // kql
  kql?: string;
  database?: string;
  // sql
  sql?: string;
}

export type SlateWidgetKind = 'table' | 'chart' | 'metric' | 'text' | 'container';

export interface SlateWidgetLayout { x: number; y: number; w: number; h: number }

export interface SlateWidgetDef {
  id: string;
  title: string;
  kind: SlateWidgetKind;
  queryId?: string;
  /** Legacy REST path (back-compat with the original flat editor). */
  query?: string;
  layout?: SlateWidgetLayout;
  // chart
  chartType?: LoomChartType;
  // metric
  metricField?: string;
  metricAgg?: 'count' | 'sum' | 'avg' | 'min' | 'max' | 'first';
  // text
  text?: string;
}

interface RunResult {
  loading?: boolean;
  error?: string;
  gate?: { reason: string; remediation: string };
  columns?: string[];
  rows?: unknown[][];
  rowCount?: number;
  executionMs?: number;
}

// ───────────────────────── canvas geometry (inherent px) ─────────────────────────
// Absolute-grid layout dimensions; no Fluent token expresses pixel coordinates.
const GRID = 16;             // snap step
const CANVAS_MIN_W = 720;    // logical canvas width (scrolls if narrower)
const CANVAS_MIN_H = 520;    // floor canvas height
const HEADER_H = 34;         // widget header strip height
const snap = (v: number) => Math.max(0, Math.round(v / GRID) * GRID);

const DEFAULT_SIZE: Record<SlateWidgetKind, { w: number; h: number }> = {
  table: { w: 384, h: 256 },
  chart: { w: 384, h: 256 },
  metric: { w: 208, h: 144 },
  text: { w: 320, h: 160 },
  container: { w: 480, h: 288 },
};

const KIND_META: Record<SlateWidgetKind, { label: string; icon: ReactElement; hint: string }> = {
  table: { label: 'Table', icon: <Table20Regular />, hint: 'Grid with sort + paging, bound to a query' },
  chart: { label: 'Chart', icon: <DataUsage20Regular />, hint: 'Bar / line / area / pie over query results' },
  metric: { label: 'Metric', icon: <NumberSymbol20Regular />, hint: 'A single aggregated KPI number' },
  text: { label: 'Text', icon: <DocumentText20Regular />, hint: 'Markdown-lite label / description' },
  container: { label: 'Container', icon: <Apps20Regular />, hint: 'A titled layout frame to group widgets' },
};

const QUERY_TYPE_META: Record<SlateQueryType, { label: string; icon: ReactElement; backend: string }> = {
  'rest-dab': { label: 'REST (HTTP-JSON)', icon: <Globe20Regular />, backend: 'Data API Builder / APIM REST' },
  kql: { label: 'KQL', icon: <Flash20Regular />, backend: 'Azure Data Explorer (ADX)' },
  sql: { label: 'SQL', icon: <Database20Regular />, backend: 'Synapse serverless SQL' },
};

const CHART_TYPES: LoomChartType[] = ['column', 'bar', 'line', 'area', 'pie', 'donut', 'scatter'];
const METRIC_AGGS: NonNullable<SlateWidgetDef['metricAgg']>[] = ['count', 'sum', 'avg', 'min', 'max', 'first'];

// ───────────────────────── data helpers ─────────────────────────

/** Run one query against the BFF engine. `body` is { queryId } or { query }. */
async function runSlateQuery(id: string, body: { queryId?: string; query?: Partial<SlateQueryDef> }): Promise<RunResult> {
  try {
    const r = await fetch(`/api/items/slate-app/${encodeURIComponent(id)}/query/run`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (!j?.ok) return { error: j?.error || `HTTP ${r.status}`, gate: j?.gate };
    return { columns: j.columns || [], rows: j.rows || [], rowCount: j.rowCount ?? (j.rows?.length || 0), executionMs: j.executionMs };
  } catch (e: any) {
    return { error: e?.message || String(e) };
  }
}

/** Whether a widget has a data binding (a saved query id or a legacy REST path). */
function isBound(w: SlateWidgetDef): boolean {
  return !!(w.queryId || w.query);
}

/**
 * Resolve the run body for a widget by materializing the FULL query object
 * client-side (so Run/Preview works before the item is saved — the route accepts
 * an ad-hoc `query`). Returns null when the binding can't be resolved.
 */
function resolveQueryBody(w: SlateWidgetDef, queries: SlateQueryDef[]): { query: Partial<SlateQueryDef> } | null {
  if (w.queryId) {
    const q = queries.find((x) => x.id === w.queryId);
    return q ? { query: q } : null;
  }
  if (w.query) return { query: { type: 'rest-dab', path: w.query } };
  return null;
}

function toRecords(columns: string[], rows: unknown[][]): Array<Record<string, unknown>> {
  return rows.map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i]])));
}

function aggregate(columns: string[], rows: unknown[][], field: string | undefined, agg: SlateWidgetDef['metricAgg']): number {
  if (agg === 'count' || !agg || !field) return rows.length;
  const ci = columns.indexOf(field);
  if (ci < 0) return rows.length;
  const nums = rows.map((r) => Number(r[ci])).filter((n) => Number.isFinite(n));
  if (nums.length === 0) return 0;
  switch (agg) {
    case 'sum': return nums.reduce((a, b) => a + b, 0);
    case 'avg': return nums.reduce((a, b) => a + b, 0) / nums.length;
    case 'min': return Math.min(...nums);
    case 'max': return Math.max(...nums);
    case 'first': return nums[0];
    default: return rows.length;
  }
}

function fmtMetric(v: number): string {
  if (!Number.isFinite(v)) return '—';
  if (Math.abs(v) >= 1_000_000) return (v / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 1 }) + 'M';
  if (Math.abs(v) >= 1_000) return (v / 1_000).toLocaleString(undefined, { maximumFractionDigits: 1 }) + 'K';
  return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

/** Minimal, safe markdown → React nodes (headings / bold / list / paragraph). */
function renderMarkdownLite(text: string): ReactNode {
  const lines = (text || '').split('\n');
  const out: ReactNode[] = [];
  let list: string[] = [];
  const flush = () => {
    if (list.length) {
      out.push(<ul key={`ul${out.length}`} style={{ margin: 0, paddingLeft: 18 }}>{list.map((li, i) => <li key={i}>{inlineBold(li)}</li>)}</ul>);
      list = [];
    }
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^#{1,3}\s/.test(line)) { flush(); const lvl = line.match(/^#+/)![0].length; const t = line.replace(/^#+\s/, ''); out.push(lvl <= 1 ? <Subtitle2 key={out.length} block>{t}</Subtitle2> : <Body1 key={out.length} block><strong>{t}</strong></Body1>); }
    else if (/^[-*]\s/.test(line)) { list.push(line.replace(/^[-*]\s/, '')); }
    else if (line === '') { flush(); }
    else { flush(); out.push(<Body1 key={out.length} block>{inlineBold(line)}</Body1>); }
  }
  flush();
  return out;
}
function inlineBold(s: string): ReactNode {
  const parts = s.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((p, i) => /^\*\*[^*]+\*\*$/.test(p) ? <strong key={i}>{p.slice(2, -2)}</strong> : <span key={i}>{p}</span>);
}

// ───────────────────────── styles ─────────────────────────

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: 0 },
  modeBar: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM, flexWrap: 'wrap',
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalM}`,
    borderRadius: tokens.borderRadiusLarge, backgroundColor: tokens.colorNeutralBackground2,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  spacer: { flex: 1 },
  section: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: 0,
    padding: tokens.spacingVerticalL, borderRadius: tokens.borderRadiusXLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`, backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
  },
  sectionHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  sectionIcon: {
    display: 'flex', alignItems: 'center', justifyContent: 'center', width: '32px', height: '32px',
    borderRadius: tokens.borderRadiusMedium, backgroundColor: tokens.colorBrandBackground2, color: tokens.colorBrandForeground1, flexShrink: 0,
  },
  hint: { color: tokens.colorNeutralForeground3, minWidth: 0, overflowWrap: 'anywhere' },
  designGrid: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: tokens.spacingVerticalM, minWidth: 0 },
  designGridSel: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(280px, 320px)', gap: tokens.spacingHorizontalM, minWidth: 0,
    '@media (max-width: 1100px)': { gridTemplateColumns: 'minmax(0, 1fr)' } },
  palette: { display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', alignItems: 'center' },
  // Bounded canvas region; overflow auto so absolute widgets can be scrolled to.
  canvasWrap: {
    position: 'relative', overflow: 'auto', minWidth: 0,
    borderRadius: tokens.borderRadiusLarge, border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
    backgroundImage: `radial-gradient(${tokens.colorNeutralStroke2} 1px, transparent 0)`,
    backgroundSize: `${GRID}px ${GRID}px`,
  },
  canvas: { position: 'relative', minWidth: `${CANVAS_MIN_W}px` },
  widget: {
    position: 'absolute', display: 'flex', flexDirection: 'column', overflow: 'hidden',
    borderRadius: tokens.borderRadiusMedium, border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1, boxShadow: tokens.shadow4,
  },
  widgetSelected: { border: `1px solid ${tokens.colorBrandStroke1}`, boxShadow: `0 0 0 2px ${tokens.colorBrandStroke1}, ${tokens.shadow8}` },
  widgetHeader: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, height: `${HEADER_H}px`, flexShrink: 0,
    padding: `0 ${tokens.spacingHorizontalS}`, cursor: 'move', userSelect: 'none',
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    background: `linear-gradient(135deg, ${tokens.colorBrandBackground2}, ${tokens.colorNeutralBackground1})`,
  },
  widgetTitle: { flex: 1, minWidth: 0, fontWeight: tokens.fontWeightSemibold, fontSize: tokens.fontSizeBase200, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  widgetBody: { flex: 1, minHeight: 0, overflow: 'auto', padding: tokens.spacingHorizontalS },
  resizeHandle: {
    position: 'absolute', right: 0, bottom: 0, width: '16px', height: '16px', cursor: 'nwse-resize',
    background: `linear-gradient(135deg, transparent 50%, ${tokens.colorNeutralStroke1} 50%)`,
    borderBottomRightRadius: tokens.borderRadiusMedium,
  },
  metricBig: { fontSize: '34px', fontWeight: tokens.fontWeightBold, color: tokens.colorBrandForeground1, lineHeight: '1.1' },
  metricWrap: { display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'flex-start', gap: tokens.spacingVerticalXXS, height: '100%' },
  containerBody: { border: `1px dashed ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium, height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: tokens.colorNeutralForeground3 },
  inspector: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: 0,
    padding: tokens.spacingVerticalL, borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`, backgroundColor: tokens.colorNeutralBackground2, height: 'fit-content',
  },
  queryRow: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', minWidth: 0,
    padding: tokens.spacingVerticalS, borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`, backgroundColor: tokens.colorNeutralBackground1,
  },
  tableWrap: { overflow: 'auto', minWidth: 0, borderRadius: tokens.borderRadiusMedium, border: `1px solid ${tokens.colorNeutralStroke2}` },
  pager: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, padding: tokens.spacingVerticalXS },
  empty: {
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: tokens.spacingHorizontalS,
    padding: tokens.spacingVerticalL, color: tokens.colorNeutralForeground3, textAlign: 'center', height: '100%',
    borderRadius: tokens.borderRadiusMedium, border: `1px dashed ${tokens.colorNeutralStroke2}`, backgroundColor: tokens.colorNeutralBackground2,
  },
  dialogForm: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: 'min(540px, 100%)', maxWidth: '100%' },
  sortableHead: { cursor: 'pointer', userSelect: 'none' },
  mono: { fontFamily: tokens.fontFamilyMonospace, fontSize: tokens.fontSizeBase200 },
});

// ───────────────────────── result table (sort + page) ─────────────────────────

function QueryResultTable({ columns, rows, pageSize = 25 }: { columns: string[]; rows: unknown[][]; pageSize?: number }) {
  const s = useStyles();
  const [page, setPage] = useState(0);
  const [sortCol, setSortCol] = useState<number | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  const sorted = useMemo(() => {
    if (sortCol == null) return rows;
    const dir = sortDir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const av = a[sortCol], bv = b[sortCol];
      const an = Number(av), bn = Number(bv);
      if (Number.isFinite(an) && Number.isFinite(bn)) return (an - bn) * dir;
      return String(av ?? '').localeCompare(String(bv ?? '')) * dir;
    });
  }, [rows, sortCol, sortDir]);

  const pages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const clampedPage = Math.min(page, pages - 1);
  const slice = sorted.slice(clampedPage * pageSize, clampedPage * pageSize + pageSize);

  const onSort = (ci: number) => {
    if (sortCol === ci) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortCol(ci); setSortDir('asc'); }
  };

  if (columns.length === 0) return <div className={s.empty}><Caption1>No columns returned.</Caption1></div>;

  return (
    <>
      <div className={s.tableWrap}>
        <Table size="small" aria-label="Query result">
          <TableHeader>
            <TableRow>
              {columns.map((c, ci) => (
                <TableHeaderCell key={c} className={s.sortableHead} onClick={() => onSort(ci)}>
                  {c}{sortCol === ci ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''}
                </TableHeaderCell>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {slice.map((row, ri) => (
              <TableRow key={ri}>
                {columns.map((_, ci) => <TableCell key={ci}>{row[ci] === null || row[ci] === undefined ? '' : String(row[ci])}</TableCell>)}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {sorted.length > pageSize && (
        <div className={s.pager}>
          <Button size="small" appearance="subtle" disabled={clampedPage === 0} onClick={() => setPage(clampedPage - 1)}>Prev</Button>
          <Caption1 className={s.hint}>Page {clampedPage + 1} / {pages} · {sorted.length} rows</Caption1>
          <Button size="small" appearance="subtle" disabled={clampedPage >= pages - 1} onClick={() => setPage(clampedPage + 1)}>Next</Button>
        </div>
      )}
    </>
  );
}

// ───────────────────────── widget content renderer ─────────────────────────

function WidgetView({ widget, result, height }: { widget: SlateWidgetDef; result?: RunResult; height: number }) {
  const s = useStyles();
  if (widget.kind === 'text') {
    return <div>{renderMarkdownLite(widget.text || '_Empty text widget — set its content in the inspector._')}</div>;
  }
  if (widget.kind === 'container') {
    return <div className={s.containerBody}><Caption1>Container — group related widgets inside this frame</Caption1></div>;
  }
  // Data-bound widgets (table / chart / metric).
  if (!isBound(widget)) {
    return <div className={s.empty}><Caption1>Bind a query in the inspector to show data.</Caption1></div>;
  }
  if (result?.loading) return <div className={s.empty}><Spinner size="tiny" label="Running query…" labelPosition="after" /></div>;
  if (result?.gate) return <MessageBar intent="warning"><MessageBarBody><MessageBarTitle>Configure backend</MessageBarTitle>{result.gate.reason} {result.gate.remediation}</MessageBarBody></MessageBar>;
  if (result?.error) return <MessageBar intent="error"><MessageBarBody>{result.error}</MessageBarBody></MessageBar>;
  if (!result || !result.columns) return <div className={s.empty}><Caption1>Run preview to load data.</Caption1></div>;
  const columns = result.columns, rows = result.rows || [];
  if (widget.kind === 'metric') {
    const v = aggregate(columns, rows, widget.metricField, widget.metricAgg || 'count');
    return (
      <div className={s.metricWrap}>
        <span className={s.metricBig}>{fmtMetric(v)}</span>
        <Caption1 className={s.hint}>{(widget.metricAgg || 'count')}{widget.metricField ? ` · ${widget.metricField}` : ' of rows'}</Caption1>
      </div>
    );
  }
  if (widget.kind === 'chart') {
    if (rows.length === 0) return <div className={s.empty}><Caption1>Query returned no rows.</Caption1></div>;
    return <LoomChart type={widget.chartType || 'column'} rows={toRecords(columns, rows)} height={Math.max(120, height - HEADER_H - 24)} />;
  }
  // table
  if (rows.length === 0) return <div className={s.empty}><Caption1>Query returned no rows.</Caption1></div>;
  return <QueryResultTable columns={columns} rows={rows} pageSize={10} />;
}

// ───────────────────────── canvas widget (drag + resize) ─────────────────────────

function CanvasWidget({
  widget, selected, readOnly, result, onSelect, onMove, onResize, onRemove,
}: {
  widget: SlateWidgetDef; selected: boolean; readOnly: boolean; result?: RunResult;
  onSelect: () => void; onMove: (x: number, y: number) => void; onResize: (w: number, h: number) => void; onRemove: () => void;
}) {
  const s = useStyles();
  const layout = widget.layout || { x: GRID, y: GRID, ...DEFAULT_SIZE[widget.kind] };

  const startDrag = useCallback((e: React.PointerEvent) => {
    if (readOnly) return;
    e.preventDefault(); e.stopPropagation(); onSelect();
    const sx = e.clientX, sy = e.clientY, ox = layout.x, oy = layout.y;
    const move = (ev: PointerEvent) => onMove(snap(ox + (ev.clientX - sx)), snap(oy + (ev.clientY - sy)));
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  }, [readOnly, layout.x, layout.y, onMove, onSelect]);

  const startResize = useCallback((e: React.PointerEvent) => {
    if (readOnly) return;
    e.preventDefault(); e.stopPropagation(); onSelect();
    const sx = e.clientX, sy = e.clientY, ow = layout.w, oh = layout.h;
    const move = (ev: PointerEvent) => onResize(
      Math.max(GRID * 8, snap(ow + (ev.clientX - sx))),
      Math.max(GRID * 5, snap(oh + (ev.clientY - sy))),
    );
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  }, [readOnly, layout.w, layout.h, onResize, onSelect]);

  return (
    <div
      className={mergeClasses(s.widget, selected && !readOnly && s.widgetSelected)}
      style={{ left: layout.x, top: layout.y, width: layout.w, height: layout.h }}
      onPointerDown={readOnly ? undefined : (e) => { e.stopPropagation(); onSelect(); }}
      aria-label={`${widget.title} (${widget.kind})`}
    >
      <div className={s.widgetHeader} onPointerDown={startDrag}>
        <span style={{ display: 'flex', color: tokens.colorBrandForeground1 }}>{KIND_META[widget.kind].icon}</span>
        <span className={s.widgetTitle} title={widget.title}>{widget.title}</span>
        {!readOnly && (
          <Tooltip content="Remove widget" relationship="label">
            <Button size="small" appearance="subtle" icon={<Dismiss16Regular />} aria-label={`Remove ${widget.title}`}
              onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); onRemove(); }} />
          </Tooltip>
        )}
      </div>
      <div className={s.widgetBody}>
        <WidgetView widget={widget} result={result} height={layout.h} />
      </div>
      {!readOnly && <div className={s.resizeHandle} onPointerDown={startResize} aria-hidden />}
    </div>
  );
}

// ───────────────────────── widget palette ─────────────────────────

function WidgetPalette({ onAdd }: { onAdd: (kind: SlateWidgetKind) => void }) {
  const s = useStyles();
  return (
    <div className={s.palette}>
      <Caption1 className={s.hint}>Add widget:</Caption1>
      {(Object.keys(KIND_META) as SlateWidgetKind[]).map((k) => (
        <Tooltip key={k} content={KIND_META[k].hint} relationship="label">
          <Button size="small" appearance="outline" icon={KIND_META[k].icon} onClick={() => onAdd(k)}>{KIND_META[k].label}</Button>
        </Tooltip>
      ))}
    </div>
  );
}

// ───────────────────────── inspector ─────────────────────────

function WidgetInspector({
  widget, queries, discoveredColumns, onChange, onRemove,
}: {
  widget: SlateWidgetDef; queries: SlateQueryDef[]; discoveredColumns: string[];
  onChange: (patch: Partial<SlateWidgetDef>) => void; onRemove: () => void;
}) {
  const s = useStyles();
  const dataBound = widget.kind === 'table' || widget.kind === 'chart' || widget.kind === 'metric';
  return (
    <div className={s.inspector}>
      <div className={s.sectionHead}>
        <span className={s.sectionIcon}><Edit20Regular /></span>
        <div><Subtitle2>Properties</Subtitle2><Caption1 as="p" block className={s.hint}>{KIND_META[widget.kind].label} widget</Caption1></div>
      </div>
      <Field label="Title"><Input value={widget.title} onChange={(_, d) => onChange({ title: d.value })} /></Field>

      {dataBound && (
        <Field label="Bound query" hint="The query whose live results this widget renders.">
          <Dropdown value={queries.find((q) => q.id === widget.queryId)?.name || (widget.query ? `(legacy: ${widget.query})` : 'None')}
            selectedOptions={widget.queryId ? [widget.queryId] : []}
            onOptionSelect={(_, d) => onChange({ queryId: d.optionValue || undefined, query: undefined })}>
            <Option value="">None</Option>
            {queries.map((q) => <Option key={q.id} value={q.id} text={q.name}>{`${q.name} · ${QUERY_TYPE_META[q.type].label}`}</Option>)}
          </Dropdown>
        </Field>
      )}

      {widget.kind === 'chart' && (
        <Field label="Chart type">
          <Dropdown value={widget.chartType || 'column'} selectedOptions={[widget.chartType || 'column']}
            onOptionSelect={(_, d) => onChange({ chartType: (d.optionValue as LoomChartType) || 'column' })}>
            {CHART_TYPES.map((t) => <Option key={t} value={t}>{t}</Option>)}
          </Dropdown>
        </Field>
      )}

      {widget.kind === 'metric' && (
        <>
          <Field label="Aggregation">
            <Dropdown value={widget.metricAgg || 'count'} selectedOptions={[widget.metricAgg || 'count']}
              onOptionSelect={(_, d) => onChange({ metricAgg: (d.optionValue as SlateWidgetDef['metricAgg']) || 'count' })}>
              {METRIC_AGGS.map((a) => <Option key={a} value={a}>{a}</Option>)}
            </Dropdown>
          </Field>
          {(widget.metricAgg && widget.metricAgg !== 'count') && (
            <Field label="Value column" hint={discoveredColumns.length ? 'Columns discovered from the last preview.' : 'Run preview once to discover columns.'}>
              <Dropdown value={widget.metricField || ''} selectedOptions={widget.metricField ? [widget.metricField] : []}
                onOptionSelect={(_, d) => onChange({ metricField: d.optionValue || undefined })} placeholder="Select a column">
                {discoveredColumns.map((c) => <Option key={c} value={c}>{c}</Option>)}
              </Dropdown>
            </Field>
          )}
        </>
      )}

      {widget.kind === 'text' && (
        <Field label="Content (markdown-lite)" hint="# heading, **bold**, - list items.">
          <Textarea value={widget.text || ''} onChange={(_, d) => onChange({ text: d.value })} rows={6} resize="vertical" placeholder={'# Section title\nSome **bold** copy.\n- point one\n- point two'} />
        </Field>
      )}

      <Divider />
      <Button appearance="subtle" icon={<Dismiss16Regular />} onClick={onRemove}>Remove widget</Button>
    </div>
  );
}

// ───────────────────────── queries panel ─────────────────────────

const emptyQuery = (): SlateQueryDef => ({ id: `q_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, name: '', type: 'rest-dab', method: 'GET' });

function QueriesPanel({
  id, queries, onChange, onColumns,
}: {
  id: string; queries: SlateQueryDef[]; onChange: (next: SlateQueryDef[]) => void; onColumns: (queryId: string, columns: string[]) => void;
}) {
  const s = useStyles();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<SlateQueryDef>(emptyQuery());
  const [editing, setEditing] = useState(false);
  const [results, setResults] = useState<Record<string, RunResult>>({});

  const beginAdd = () => { setDraft(emptyQuery()); setEditing(false); setOpen(true); };
  const beginEdit = (q: SlateQueryDef) => { setDraft({ ...q }); setEditing(true); setOpen(true); };
  const commit = () => {
    const name = draft.name.trim() || `Query ${queries.length + 1}`;
    const next = { ...draft, name };
    onChange(editing ? queries.map((q) => (q.id === next.id ? next : q)) : [...queries, next]);
    setOpen(false);
  };
  const remove = (qid: string) => onChange(queries.filter((q) => q.id !== qid));

  const run = useCallback(async (q: SlateQueryDef) => {
    setResults((p) => ({ ...p, [q.id]: { loading: true } }));
    const res = await runSlateQuery(id, { query: q });
    setResults((p) => ({ ...p, [q.id]: res }));
    if (res.columns) onColumns(q.id, res.columns);
  }, [id, onColumns]);

  return (
    <div className={s.section}>
      <div className={s.sectionHead}>
        <span className={s.sectionIcon}><Database20Regular /></span>
        <div><Subtitle2>Queries</Subtitle2><Caption1 as="p" block className={s.hint}>Named datasources — REST (DAB/APIM), KQL (ADX), or SQL (Synapse serverless). Run to preview real results; bind widgets to them.</Caption1></div>
        <span className={s.spacer} />
        <Button appearance="primary" icon={<Add20Regular />} onClick={beginAdd}>Add query</Button>
      </div>

      {queries.length === 0 ? (
        <div className={s.empty}><Caption1>No queries yet — add one to bind widgets to live data.</Caption1></div>
      ) : queries.map((q) => {
        const r = results[q.id];
        return (
          <div key={q.id} style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS }}>
            <div className={s.queryRow}>
              <Badge appearance="tint" icon={QUERY_TYPE_META[q.type].icon}>{QUERY_TYPE_META[q.type].label}</Badge>
              <Body1><strong>{q.name}</strong></Body1>
              <Caption1 className={mergeClasses(s.hint, s.mono)}>{q.type === 'rest-dab' ? `${q.method || 'GET'} ${q.path || ''}` : q.type === 'kql' ? (q.kql || '').slice(0, 64) : (q.sql || '').slice(0, 64)}</Caption1>
              <span className={s.spacer} />
              <Button size="small" appearance="primary" icon={r?.loading ? <Spinner size="tiny" /> : <Play20Regular />} disabled={r?.loading} onClick={() => run(q)}>Run</Button>
              <Button size="small" appearance="subtle" icon={<Edit20Regular />} onClick={() => beginEdit(q)}>Edit</Button>
              <Button size="small" appearance="subtle" icon={<Dismiss16Regular />} aria-label={`Remove ${q.name}`} onClick={() => remove(q.id)} />
            </div>
            {r?.gate && <MessageBar intent="warning"><MessageBarBody><MessageBarTitle>Configure backend</MessageBarTitle>{r.gate.reason} {r.gate.remediation}</MessageBarBody></MessageBar>}
            {r?.error && !r.gate && <MessageBar intent="error"><MessageBarBody>{r.error}</MessageBarBody></MessageBar>}
            {r?.columns && (
              <div style={{ paddingLeft: tokens.spacingHorizontalM }}>
                <Caption1 className={s.hint}>{r.rowCount} row(s){typeof r.executionMs === 'number' ? ` · ${r.executionMs} ms` : ''}</Caption1>
                <QueryResultTable columns={r.columns} rows={r.rows || []} pageSize={10} />
              </div>
            )}
          </div>
        );
      })}

      <QueryDialog open={open} draft={draft} editing={editing} onDraft={setDraft} onCancel={() => setOpen(false)} onCommit={commit} />
    </div>
  );
}

function QueryDialog({
  open, draft, editing, onDraft, onCancel, onCommit,
}: {
  open: boolean; draft: SlateQueryDef; editing: boolean;
  onDraft: (q: SlateQueryDef) => void; onCancel: () => void; onCommit: () => void;
}) {
  const s = useStyles();
  const set = (patch: Partial<SlateQueryDef>) => onDraft({ ...draft, ...patch });
  const valid = draft.type === 'rest-dab' ? !!(draft.path || '').trim() : draft.type === 'kql' ? !!(draft.kql || '').trim() : !!(draft.sql || '').trim();
  return (
    <Dialog open={open} onOpenChange={(_, d) => { if (!d.open) onCancel(); }}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>{editing ? 'Edit query' : 'New query'}</DialogTitle>
          <DialogContent>
            <div className={s.dialogForm}>
              <Field label="Name"><Input value={draft.name} onChange={(_, d) => set({ name: d.value })} placeholder="Open orders" /></Field>
              <Field label="Type" hint={QUERY_TYPE_META[draft.type].backend}>
                <Dropdown value={QUERY_TYPE_META[draft.type].label} selectedOptions={[draft.type]}
                  onOptionSelect={(_, d) => set({ type: (d.optionValue as SlateQueryType) || 'rest-dab' })}>
                  {(Object.keys(QUERY_TYPE_META) as SlateQueryType[]).map((t) => <Option key={t} value={t} text={QUERY_TYPE_META[t].label}>{`${QUERY_TYPE_META[t].label} — ${QUERY_TYPE_META[t].backend}`}</Option>)}
                </Dropdown>
              </Field>

              {draft.type === 'rest-dab' && (
                <>
                  <Field label="Method">
                    <Dropdown value={draft.method || 'GET'} selectedOptions={[draft.method || 'GET']} onOptionSelect={(_, d) => set({ method: (d.optionValue as 'GET' | 'POST') || 'GET' })}>
                      <Option value="GET">GET</Option><Option value="POST">POST</Option>
                    </Dropdown>
                  </Field>
                  <Field label="Path" hint="Appended to the app's Data API base (e.g. `customer` → /api/customer). An absolute https URL is used verbatim.">
                    <Input value={draft.path || ''} onChange={(_, d) => set({ path: d.value })} placeholder="customer" />
                  </Field>
                  <Field label="Result path (optional)" hint="Dot path to the array in the JSON response (e.g. `value` or `data.items`). DAB `value` is auto-detected.">
                    <Input value={draft.resultPath || ''} onChange={(_, d) => set({ resultPath: d.value })} placeholder="value" />
                  </Field>
                </>
              )}

              {draft.type === 'kql' && (
                <>
                  <Field label="Database (optional)" hint="ADX database; defaults to the Loom shared database when blank.">
                    <Input value={draft.database || ''} onChange={(_, d) => set({ database: d.value })} placeholder="loomdb-default" />
                  </Field>
                  <Field label="KQL">
                    <MonacoTextarea language="kql" value={draft.kql || ''} onChange={(v) => set({ kql: v })} height={180} ariaLabel="KQL query" />
                  </Field>
                </>
              )}

              {draft.type === 'sql' && (
                <>
                  <Field label="Database (optional)" hint="Synapse serverless database; defaults to `master`.">
                    <Input value={draft.database || ''} onChange={(_, d) => set({ database: d.value })} placeholder="master" />
                  </Field>
                  <Field label="SQL">
                    <MonacoTextarea language="sql" value={draft.sql || ''} onChange={(v) => set({ sql: v })} height={180} ariaLabel="SQL query" />
                  </Field>
                </>
              )}
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onCancel}>Cancel</Button>
            <Button appearance="primary" disabled={!valid} onClick={onCommit}>{editing ? 'Save query' : 'Add query'}</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

// ───────────────────────── the builder ─────────────────────────

export interface SlateAppBuilderProps {
  id: string;
  apiBaseUrl: string;
  queries: SlateQueryDef[];
  widgets: SlateWidgetDef[];
  onQueriesChange: (next: SlateQueryDef[]) => void;
  onWidgetsChange: (next: SlateWidgetDef[]) => void;
}

export function SlateAppBuilder({ id, queries, widgets, onQueriesChange, onWidgetsChange }: SlateAppBuilderProps) {
  const s = useStyles();
  const [mode, setMode] = useState<'design' | 'preview'>('design');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, RunResult>>({});
  const [colsByQuery, setColsByQuery] = useState<Record<string, string[]>>({});
  const [previewBusy, setPreviewBusy] = useState(false);
  const savedRef = useRef(id);
  savedRef.current = id;

  const selected = widgets.find((w) => w.id === selectedId) || null;

  // Normalize: every widget gets a layout (auto-place legacy widgets in a column).
  const normalized = useMemo(() => {
    let y = GRID;
    return widgets.map((w) => {
      if (w.layout) return w;
      const size = DEFAULT_SIZE[w.kind] || DEFAULT_SIZE.table;
      const placed = { ...w, layout: { x: GRID, y, w: size.w, h: size.h } };
      y += size.h + GRID;
      return placed;
    });
  }, [widgets]);

  // Canvas height grows to fit the lowest widget.
  const canvasHeight = useMemo(() => {
    const maxBottom = normalized.reduce((m, w) => Math.max(m, (w.layout?.y || 0) + (w.layout?.h || 0)), 0);
    return Math.max(CANVAS_MIN_H, maxBottom + GRID * 3);
  }, [normalized]);

  const addWidget = useCallback((kind: SlateWidgetKind) => {
    const size = DEFAULT_SIZE[kind];
    const maxBottom = normalized.reduce((m, w) => Math.max(m, (w.layout?.y || 0) + (w.layout?.h || 0)), 0);
    const wid = `w_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const widget: SlateWidgetDef = {
      id: wid, kind, title: `${KIND_META[kind].label} ${widgets.filter((w) => w.kind === kind).length + 1}`,
      layout: { x: GRID, y: maxBottom ? maxBottom + GRID : GRID, w: size.w, h: size.h },
      ...(kind === 'chart' ? { chartType: 'column' as LoomChartType } : {}),
      ...(kind === 'metric' ? { metricAgg: 'count' as const } : {}),
      ...(kind === 'text' ? { text: '# New text widget\nEdit me in the inspector.' } : {}),
    };
    onWidgetsChange([...widgets, widget]);
    setSelectedId(wid);
  }, [normalized, widgets, onWidgetsChange]);

  const patchWidget = useCallback((wid: string, patch: Partial<SlateWidgetDef>) => {
    onWidgetsChange(widgets.map((w) => {
      if (w.id !== wid) return w;
      const base = w.layout ? w : { ...w, layout: { x: GRID, y: GRID, ...DEFAULT_SIZE[w.kind] } };
      return { ...base, ...patch };
    }));
  }, [widgets, onWidgetsChange]);

  const moveWidget = useCallback((wid: string, x: number, y: number) => {
    onWidgetsChange(widgets.map((w) => (w.id === wid ? { ...w, layout: { ...(w.layout || { w: DEFAULT_SIZE[w.kind].w, h: DEFAULT_SIZE[w.kind].h, x, y }), x, y } } : w)));
  }, [widgets, onWidgetsChange]);

  const resizeWidget = useCallback((wid: string, w: number, h: number) => {
    onWidgetsChange(widgets.map((it) => (it.id === wid ? { ...it, layout: { ...(it.layout || { x: GRID, y: GRID, w, h }), w, h } } : it)));
  }, [widgets, onWidgetsChange]);

  const removeWidget = useCallback((wid: string) => {
    onWidgetsChange(widgets.filter((w) => w.id !== wid));
    if (selectedId === wid) setSelectedId(null);
  }, [widgets, onWidgetsChange, selectedId]);

  // Run every data-bound widget's query (real backend) for the live Preview.
  const runPreview = useCallback(async () => {
    setPreviewBusy(true);
    const bound = normalized.filter((w) => resolveQueryBody(w, queries));
    setResults((p) => { const next = { ...p }; for (const w of bound) next[w.id] = { loading: true }; return next; });
    await Promise.all(bound.map(async (w) => {
      const body = resolveQueryBody(w, queries)!;
      const res = await runSlateQuery(savedRef.current, body);
      setResults((p) => ({ ...p, [w.id]: res }));
      if (res.columns && w.queryId) setColsByQuery((p) => ({ ...p, [w.queryId!]: res.columns! }));
    }));
    setPreviewBusy(false);
  }, [normalized, queries]);

  // Auto-run the preview the first time the user switches into Run mode.
  const didPreview = useRef(false);
  useEffect(() => {
    if (mode === 'preview' && !didPreview.current) { didPreview.current = true; void runPreview(); }
  }, [mode, runPreview]);

  const discoveredForSelected = (selected?.queryId && colsByQuery[selected.queryId]) || [];

  return (
    <div className={s.root}>
      <div className={s.modeBar}>
        <TabList selectedValue={mode} onTabSelect={(_, d) => setMode(d.value as 'design' | 'preview')}>
          <Tab value="design" icon={<Edit20Regular />}>Design</Tab>
          <Tab value="preview" icon={<Play20Regular />}>Preview</Tab>
        </TabList>
        <span className={s.spacer} />
        {mode === 'preview' && (
          <Button appearance="primary" icon={previewBusy ? <Spinner size="tiny" /> : <ArrowSync20Regular />} disabled={previewBusy} onClick={runPreview}>
            {previewBusy ? 'Running…' : 'Run all'}
          </Button>
        )}
        <Badge appearance="outline" icon={<ArrowMaximize20Regular />}>{normalized.length} widget{normalized.length === 1 ? '' : 's'}</Badge>
        <Badge appearance="outline" icon={<Database20Regular />}>{queries.length} quer{queries.length === 1 ? 'y' : 'ies'}</Badge>
      </div>

      {mode === 'design' && (
        <QueriesPanel id={id} queries={queries} onChange={onQueriesChange} onColumns={(qid, cols) => setColsByQuery((p) => ({ ...p, [qid]: cols }))} />
      )}

      {mode === 'design' ? (
        <div className={s.section}>
          <div className={s.sectionHead}>
            <span className={s.sectionIcon}><Apps20Regular /></span>
            <div><Subtitle2>Canvas</Subtitle2><Caption1 as="p" block className={s.hint}>Drag widget headers to move, drag the corner to resize. Click a widget to edit it in the inspector.</Caption1></div>
          </div>
          <WidgetPalette onAdd={addWidget} />
          <div className={selected ? s.designGridSel : s.designGrid}>
            <div className={s.canvasWrap} style={{ height: canvasHeight }} onPointerDown={() => setSelectedId(null)}>
              <div className={s.canvas} style={{ height: canvasHeight }}>
                {normalized.length === 0 ? (
                  <div style={{ position: 'absolute', inset: 0 }}>
                    <EmptyState icon={<Apps20Regular />} title="Empty canvas" body="Add a widget from the palette above, then bind it to a query to show live data." />
                  </div>
                ) : normalized.map((w) => (
                  <CanvasWidget key={w.id} widget={w} selected={selectedId === w.id} readOnly={false} result={results[w.id]}
                    onSelect={() => setSelectedId(w.id)} onMove={(x, y) => moveWidget(w.id, x, y)} onResize={(cw, ch) => resizeWidget(w.id, cw, ch)} onRemove={() => removeWidget(w.id)} />
                ))}
              </div>
            </div>
            {selected && (
              <WidgetInspector widget={selected} queries={queries} discoveredColumns={discoveredForSelected}
                onChange={(patch) => patchWidget(selected.id, patch)} onRemove={() => removeWidget(selected.id)} />
            )}
          </div>
        </div>
      ) : (
        <div className={s.section}>
          <div className={s.sectionHead}>
            <span className={s.sectionIcon}><Play20Regular /></span>
            <div><Subtitle2>Live preview (Run mode)</Subtitle2><Caption1 as="p" block className={s.hint}>Every data-bound widget is rendered against its query's real Azure backend (ADX / Synapse / DAB REST).</Caption1></div>
          </div>
          <div className={s.canvasWrap} style={{ height: canvasHeight }}>
            <div className={s.canvas} style={{ height: canvasHeight }}>
              {normalized.length === 0 ? (
                <div style={{ position: 'absolute', inset: 0 }}>
                  <EmptyState icon={<Play20Regular />} title="Nothing to preview yet" body="Switch to Design and add widgets bound to queries, then come back to Run mode." />
                </div>
              ) : normalized.map((w) => (
                <CanvasWidget key={w.id} widget={w} selected={false} readOnly result={results[w.id]}
                  onSelect={() => {}} onMove={() => {}} onResize={() => {}} onRemove={() => {}} />
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
