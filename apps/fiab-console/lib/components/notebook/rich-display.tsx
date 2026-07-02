'use client';

/**
 * RichDisplay — the interactive grid + chart-recommendation surface that
 * renders when a notebook cell calls display(df). Parity with Synapse Studio /
 * Fabric notebook display():
 *
 *   • Table view  — TanStack-style data grid (sortable headers, column select →
 *     Inspect pane with real stats, row select, summary-stats footer, CSV copy,
 *     "5,000 of N rows" badge, pagination).
 *   • Chart view  — up to 5 recommended Vega-Lite-equivalent charts rendered as
 *     native SVG (bar / scatter / line / heatmap). Per-chart controls: X/Y/
 *     legend/agg selectors, rename, duplicate, delete, reorder. "Aggregate over
 *     all rows" fires a REAL Spark job (groupBy/agg over the full dataset) via
 *     the existing /run + /runs poll path and re-renders the chart.
 *
 * No charting dependency — pure <svg>, matching the repo's KqlChart/MetricChart
 * pattern (bundled, no CDN, IL5-safe). Data is real: rows + stats come from the
 * kernel payload (ai-display.py) or the server profiler (display-stats.ts).
 */

import { useCallback, useMemo, useState } from 'react';
import {
  makeStyles, tokens, Tab, TabList, Button, Caption1, Badge, Select, Input,
  Checkbox, Tooltip, Text, MessageBar, MessageBarBody, Spinner, mergeClasses,
} from '@fluentui/react-components';
import {
  Copy16Regular, Add16Regular, Delete16Regular, ChevronUp16Regular,
  ChevronDown16Regular, ArrowSortUp16Regular, ArrowSortDown16Regular,
  ArrowSort16Regular, Rename16Regular, Table16Regular, Info16Regular,
  Dismiss16Regular, ChartMultiple16Regular, Play16Regular, ArrowDownload16Regular,
} from '@fluentui/react-icons';
import type {
  LoomDisplayPayload, LoomDisplayColumn, LoomDisplayChartRec,
  LoomChartType, LoomChartAgg,
} from '@/lib/types/notebook-cell';
import { isNumericDtype, buildAggCode } from '@/lib/notebook/display-stats';

const SERIES_COLORS = ['#5b8def', '#22c1a6', '#e0a83a', '#d9534f', '#9b6bdf', '#3aa0e0', '#e07ab5', '#7bc043'];

const useStyles = makeStyles({
  root: { border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: '6px', backgroundColor: tokens.colorNeutralBackground1, overflow: 'hidden' },
  toolbar: { display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 8px', borderBottom: `1px solid ${tokens.colorNeutralStroke2}`, backgroundColor: tokens.colorNeutralBackground2 },
  spacer: { flex: 1 },
  body: { display: 'flex', minHeight: 0 },
  gridWrap: { flex: 1, overflow: 'auto', maxHeight: '360px', minWidth: 0 },
  table: { borderCollapse: 'collapse', width: '100%', fontSize: '12px', fontFamily: 'Consolas, "Cascadia Code", monospace' },
  th: { position: 'sticky', top: 0, backgroundColor: tokens.colorNeutralBackground3, borderBottom: `1px solid ${tokens.colorNeutralStroke1}`, borderRight: `1px solid ${tokens.colorNeutralStroke3}`, padding: '4px 8px', textAlign: 'left', cursor: 'pointer', whiteSpace: 'nowrap', userSelect: 'none' },
  thInner: { display: 'flex', alignItems: 'center', gap: '4px' },
  thSelected: { backgroundColor: tokens.colorBrandBackground2 },
  thType: { color: tokens.colorNeutralForeground3, fontWeight: 400, fontSize: '10px' },
  td: { borderBottom: `1px solid ${tokens.colorNeutralStroke3}`, borderRight: `1px solid ${tokens.colorNeutralStroke3}`, padding: '3px 8px', whiteSpace: 'nowrap', maxWidth: '280px', overflow: 'hidden', textOverflow: 'ellipsis' },
  tdNull: { color: tokens.colorNeutralForeground4, fontStyle: 'italic' },
  rowSel: { backgroundColor: tokens.colorBrandBackground2 },
  idxCell: { color: tokens.colorNeutralForeground4, textAlign: 'right', padding: '3px 6px', borderRight: `1px solid ${tokens.colorNeutralStroke3}`, borderBottom: `1px solid ${tokens.colorNeutralStroke3}`, userSelect: 'none' },
  footer: { display: 'flex', alignItems: 'center', gap: '12px', padding: '4px 8px', borderTop: `1px solid ${tokens.colorNeutralStroke2}`, backgroundColor: tokens.colorNeutralBackground2, fontSize: '11px', color: tokens.colorNeutralForeground3, flexWrap: 'wrap' },
  inspect: { width: '240px', flexShrink: 0, borderLeft: `1px solid ${tokens.colorNeutralStroke2}`, padding: '10px', display: 'flex', flexDirection: 'column', gap: '6px', backgroundColor: tokens.colorNeutralBackground2, overflow: 'auto', maxHeight: '360px' },
  inspectRow: { display: 'flex', justifyContent: 'space-between', gap: '8px', fontSize: '12px' },
  inspectKey: { color: tokens.colorNeutralForeground3 },
  inspectVal: { fontFamily: 'Consolas, monospace', color: tokens.colorNeutralForeground1, textAlign: 'right', wordBreak: 'break-all' },
  chartsWrap: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: '12px', padding: '12px', maxHeight: '520px', overflow: 'auto' },
  chartCard: { border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: '8px', padding: '10px', display: 'flex', flexDirection: 'column', gap: '8px', backgroundColor: tokens.colorNeutralBackground1 },
  chartHead: { display: 'flex', alignItems: 'center', gap: '4px' },
  chartTitle: { flex: 1, fontWeight: 600, fontSize: '13px', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  controls: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' },
  ctrlLabel: { fontSize: '10px', color: tokens.colorNeutralForeground3, marginBottom: '2px' },
  chartMeta: { fontSize: '10px', color: tokens.colorNeutralForeground3 },
  empty: { padding: '16px', color: tokens.colorNeutralForeground3, fontSize: '13px' },
});

export interface RichDisplayProps {
  payload: LoomDisplayPayload;
  cellId: string;
  notebookId: string;
  workspaceId: string;
  computeId: string;
}

const CHART_TYPES: { value: LoomChartType; label: string }[] = [
  { value: 'bar', label: 'Bar' }, { value: 'line', label: 'Line' },
  { value: 'scatter', label: 'Scatter' }, { value: 'heatmap', label: 'Heatmap (pivot)' },
];
const AGGS: LoomChartAgg[] = ['count', 'sum', 'mean', 'min', 'max'];

function colVal(payload: LoomDisplayPayload, rowIdx: number, colName: string): unknown {
  const ci = payload.columns.findIndex((c) => c.name === colName);
  return ci < 0 ? undefined : payload.rows[rowIdx]?.[ci];
}
function toNum(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
  return null;
}

export function RichDisplay({ payload, cellId, notebookId, workspaceId, computeId }: RichDisplayProps) {
  const s = useStyles();
  const [tab, setTab] = useState<'table' | 'charts'>('table');
  const [charts, setCharts] = useState<LoomDisplayChartRec[]>(() =>
    (payload.chartRecs || []).map((c, i) => ({ ...c, id: c.id || `rec-${i}` })));

  return (
    <div className={s.root}>
      <div className={s.toolbar}>
        <TabList size="small" selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as 'table' | 'charts')}>
          <Tab value="table" icon={<Table16Regular />}>Table</Tab>
          <Tab value="charts" icon={<ChartMultiple16Regular />}>Charts</Tab>
        </TabList>
        <div className={s.spacer} />
        <Badge appearance="tint" color="informative" size="small">
          {payload.sampleSize.toLocaleString()} of {payload.totalCount.toLocaleString()} rows
        </Badge>
      </div>
      {tab === 'table'
        ? <TableView payload={payload} />
        : <ChartsView payload={payload} charts={charts} setCharts={setCharts}
            notebookId={notebookId} workspaceId={workspaceId} computeId={computeId} />}
    </div>
  );
}

// ── Table view ──────────────────────────────────────────────────────────────
function TableView({ payload }: { payload: LoomDisplayPayload }) {
  const s = useStyles();
  const PAGE = 100;
  const [page, setPage] = useState(0);
  const [sortCol, setSortCol] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [selCol, setSelCol] = useState<string | null>(null);
  const [selRows, setSelRows] = useState<Set<number>>(new Set());

  const cols = payload.columns;

  // Sorted view (over the full sample) — indices into payload.rows.
  const order = useMemo(() => {
    const idx = payload.rows.map((_, i) => i);
    if (!sortCol) return idx;
    const ci = cols.findIndex((c) => c.name === sortCol);
    if (ci < 0) return idx;
    const numeric = isNumericDtype(cols[ci].dtype);
    idx.sort((a, b) => {
      const va = payload.rows[a]?.[ci]; const vb = payload.rows[b]?.[ci];
      if (va == null && vb == null) return 0;
      if (va == null) return 1; if (vb == null) return -1;
      let cmp: number;
      if (numeric) cmp = (toNum(va) ?? 0) - (toNum(vb) ?? 0);
      else cmp = String(va).localeCompare(String(vb));
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return idx;
  }, [payload.rows, cols, sortCol, sortDir]);

  const pageCount = Math.max(1, Math.ceil(order.length / PAGE));
  const safePage = Math.min(page, pageCount - 1);
  const pageRows = order.slice(safePage * PAGE, safePage * PAGE + PAGE);

  const toggleSort = (name: string) => {
    if (sortCol === name) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortCol(name); setSortDir('asc'); }
  };
  const toggleRow = (i: number) => setSelRows((prev) => {
    const next = new Set(prev); next.has(i) ? next.delete(i) : next.add(i); return next;
  });

  const copyCsv = useCallback(async () => {
    const rowsToCopy = selRows.size ? order.filter((i) => selRows.has(i)) : order;
    const esc = (v: unknown) => {
      const str = v == null ? '' : String(v);
      return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
    };
    const header = cols.map((c) => esc(c.name)).join(',');
    const lines = rowsToCopy.map((ri) => cols.map((_, ci) => esc(payload.rows[ri]?.[ci])).join(','));
    const csv = [header, ...lines].join('\n');
    try { await navigator.clipboard.writeText(csv); } catch { /* clipboard blocked — no-op */ }
  }, [selRows, order, cols, payload.rows]);

  const selectedColInfo = selCol ? cols.find((c) => c.name === selCol) ?? null : null;

  return (
    <>
      <div className={s.body}>
        <div className={s.gridWrap}>
          <table className={s.table}>
            <thead>
              <tr>
                <th className={s.idxCell} aria-label="row index" />
                {cols.map((c) => {
                  const sorted = sortCol === c.name;
                  return (
                    <th key={c.name}
                        className={mergeClasses(s.th, selCol === c.name && s.thSelected)}
                        onClick={() => toggleSort(c.name)}
                        title={`${c.name} (${c.dtype}) — click to sort`}>
                      <div className={s.thInner}>
                        <Button size="small" appearance="transparent" icon={<Info16Regular />}
                          aria-label={`Inspect column ${c.name}`}
                          onClick={(e) => { e.stopPropagation(); setSelCol(selCol === c.name ? null : c.name); }} />
                        <span>{c.name}</span>
                        {sorted ? (sortDir === 'asc' ? <ArrowSortUp16Regular /> : <ArrowSortDown16Regular />) : <ArrowSort16Regular />}
                      </div>
                      <div className={s.thType}>{c.dtype}</div>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {pageRows.map((ri) => (
                <tr key={ri} className={mergeClasses(selRows.has(ri) && s.rowSel)}>
                  <td className={s.idxCell}>
                    <Checkbox size="medium" checked={selRows.has(ri)}
                      onChange={() => toggleRow(ri)} aria-label={`Select row ${ri}`} />
                  </td>
                  {cols.map((c, ci) => {
                    const v = payload.rows[ri]?.[ci];
                    return (
                      <td key={c.name} className={mergeClasses(s.td, (v == null || v === '') && s.tdNull)}
                        style={selCol === c.name ? { backgroundColor: tokens.colorBrandBackground2 } : undefined}>
                        {v == null ? 'null' : String(v)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {selectedColInfo && (
          <div className={s.inspect}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <Text weight="semibold">{selectedColInfo.name}</Text>
              <div style={{ flex: 1 }} />
              <Button size="small" appearance="subtle" icon={<Dismiss16Regular />}
                aria-label="Close inspect" onClick={() => setSelCol(null)} />
            </div>
            <InspectRows col={selectedColInfo} sampleSize={payload.sampleSize} />
          </div>
        )}
      </div>
      <div className={s.footer}>
        <Button size="small" appearance="subtle" icon={<Copy16Regular />} onClick={copyCsv}>
          Copy {selRows.size ? `${selRows.size} rows` : 'all'} as CSV
        </Button>
        <span>{cols.length} cols · {order.length.toLocaleString()} sampled rows{selRows.size ? ` · ${selRows.size} selected` : ''}</span>
        <div style={{ flex: 1 }} />
        <Button size="small" appearance="subtle" icon={<ChevronUp16Regular />} disabled={safePage <= 0}
          onClick={() => setPage((p) => Math.max(0, p - 1))} aria-label="Previous page" />
        <span>Page {safePage + 1} / {pageCount}</span>
        <Button size="small" appearance="subtle" icon={<ChevronDown16Regular />} disabled={safePage >= pageCount - 1}
          onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))} aria-label="Next page" />
      </div>
    </>
  );
}

function InspectRows({ col, sampleSize }: { col: LoomDisplayColumn; sampleSize: number }) {
  const s = useStyles();
  const rows: [string, string][] = [['Type', col.dtype], ['Nulls', `${col.nullCount} (${((col.nullCount / Math.max(1, sampleSize)) * 100).toFixed(1)}%)`]];
  if (col.min != null) rows.push(['Min', col.min]);
  if (col.max != null) rows.push(['Max', col.max]);
  if (col.mean != null) rows.push(['Mean', col.mean]);
  if (col.stddev != null) rows.push(['Std dev', col.stddev]);
  if (col.cardinality != null) rows.push(['Distinct', String(col.cardinality)]);
  return (
    <>
      {rows.map(([k, v]) => (
        <div key={k} className={s.inspectRow}>
          <span className={s.inspectKey}>{k}</span>
          <span className={s.inspectVal}>{v}</span>
        </div>
      ))}
      {col.topValues && col.topValues.length > 0 && (
        <>
          <Caption1 style={{ marginTop: 6, color: tokens.colorNeutralForeground3 }}>Top values</Caption1>
          {col.topValues.map((tv) => (
            <div key={tv.value} className={s.inspectRow}>
              <span className={s.inspectVal} style={{ textAlign: 'left', flex: 1 }}>{tv.value || '∅'}</span>
              <span className={s.inspectKey}>{tv.count}</span>
            </div>
          ))}
        </>
      )}
    </>
  );
}

// ── Charts view ─────────────────────────────────────────────────────────────
interface ChartsViewProps {
  payload: LoomDisplayPayload;
  charts: LoomDisplayChartRec[];
  setCharts: React.Dispatch<React.SetStateAction<LoomDisplayChartRec[]>>;
  notebookId: string; workspaceId: string; computeId: string;
}

function ChartsView({ payload, charts, setCharts, notebookId, workspaceId, computeId }: ChartsViewProps) {
  const s = useStyles();
  // Per-chart full-dataset override: { columns:[x,value], rows:[[x,v]…] }.
  const [fullData, setFullData] = useState<Record<string, { cat: string; series: string; value: number }[]>>({});

  const addChart = () => {
    const firstNum = payload.columns.find((c) => isNumericDtype(c.dtype));
    const firstCat = payload.columns.find((c) => !isNumericDtype(c.dtype)) ?? payload.columns[0];
    setCharts((prev) => [...prev, {
      id: `chart-${Date.now()}`, type: 'bar',
      xField: firstCat?.name ?? '', yField: firstNum?.name ?? firstCat?.name ?? '',
      agg: firstNum ? 'mean' : 'count', title: 'New chart',
    }]);
  };
  const patch = (id: string, p: Partial<LoomDisplayChartRec>) =>
    setCharts((prev) => prev.map((c) => (c.id === id ? { ...c, ...p } : c)));
  const remove = (id: string) => setCharts((prev) => prev.filter((c) => c.id !== id));
  const duplicate = (id: string) => setCharts((prev) => {
    const i = prev.findIndex((c) => c.id === id); if (i < 0) return prev;
    const copy = { ...prev[i], id: `chart-${Date.now()}`, title: `${prev[i].title} (copy)` };
    return [...prev.slice(0, i + 1), copy, ...prev.slice(i + 1)];
  });
  const move = (id: string, delta: -1 | 1) => setCharts((prev) => {
    const i = prev.findIndex((c) => c.id === id); const j = i + delta;
    if (i < 0 || j < 0 || j >= prev.length) return prev;
    const next = [...prev]; const [m] = next.splice(i, 1); next.splice(j, 0, m); return next;
  });

  if (charts.length === 0) {
    return (
      <div className={s.empty}>
        <MessageBar intent="info">
          <MessageBarBody>No chart recommendations for this DataFrame shape. Use “Add chart” to build one.</MessageBarBody>
        </MessageBar>
        <div style={{ marginTop: 8 }}>
          <Button size="small" icon={<Add16Regular />} onClick={addChart}>Add chart</Button>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className={s.toolbar} style={{ borderTop: 'none' }}>
        <Button size="small" appearance="subtle" icon={<Add16Regular />} onClick={addChart}>Add chart</Button>
        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{charts.length} of 5+ charts</Caption1>
      </div>
      <div className={s.chartsWrap}>
        {charts.map((c, i) => (
          <ChartCard key={c.id} chart={c} index={i} total={charts.length} payload={payload}
            full={fullData[c.id]}
            onPatch={(p) => patch(c.id, p)} onRemove={() => remove(c.id)}
            onDuplicate={() => duplicate(c.id)} onMove={(d) => move(c.id, d)}
            onFull={(data) => setFullData((prev) => ({ ...prev, [c.id]: data }))}
            notebookId={notebookId} workspaceId={workspaceId} computeId={computeId} />
        ))}
      </div>
    </>
  );
}

interface ChartCardProps {
  chart: LoomDisplayChartRec; index: number; total: number; payload: LoomDisplayPayload;
  full?: { cat: string; series: string; value: number }[];
  onPatch: (p: Partial<LoomDisplayChartRec>) => void;
  onRemove: () => void; onDuplicate: () => void; onMove: (d: -1 | 1) => void;
  onFull: (data: { cat: string; series: string; value: number }[]) => void;
  notebookId: string; workspaceId: string; computeId: string;
}

function ChartCard({ chart, index, total, payload, full, onPatch, onRemove, onDuplicate, onMove, onFull, notebookId, workspaceId, computeId }: ChartCardProps) {
  const s = useStyles();
  const [renaming, setRenaming] = useState(false);
  const [aggState, setAggState] = useState<'idle' | 'running' | 'error'>('idle');
  const [aggMsg, setAggMsg] = useState('');

  const colNames = payload.columns.map((c) => c.name);
  const numNames = payload.columns.filter((c) => isNumericDtype(c.dtype)).map((c) => c.name);

  // Aggregate the SAMPLE rows client-side for the default render.
  const sampleData = useMemo(() => aggregateSample(payload, chart), [payload, chart]);
  const data = full ?? sampleData;

  const runFullAgg = useCallback(async () => {
    if (!payload.dfVarName) return;
    if (!notebookId || !workspaceId || !computeId) { setAggState('error'); setAggMsg('No compute bound'); return; }
    setAggState('running'); setAggMsg('Submitting Spark job…');
    try {
      const code = buildAggCode(chart, payload.dfVarName);
      const r = await fetch(`/api/items/notebook/${encodeURIComponent(notebookId)}/run?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ compute: computeId, cellId: `agg-${chart.id}`, source: code, lang: 'pyspark' }),
      });
      const j = await r.json();
      if (!j.ok) { setAggState('error'); setAggMsg(j.error || 'dispatch failed'); return; }
      let runId: string = j.runId;
      const start = Date.now(); const MAX = 12 * 60 * 1000;
      while (Date.now() - start < MAX) {
        await new Promise((res) => setTimeout(res, 1500));
        const pr = await fetch(`/api/items/notebook/${encodeURIComponent(notebookId)}/runs/${encodeURIComponent(runId)}?workspaceId=${encodeURIComponent(workspaceId)}`);
        const p = await pr.json();
        if (!p.ok) { setAggState('error'); setAggMsg(p.error || 'poll failed'); return; }
        if (p.runId && p.runId !== runId) runId = p.runId;
        setAggMsg(`Spark: ${p.status}…`);
        if (p.output) {
          if (p.output.status === 'error') { setAggState('error'); setAggMsg(p.output.evalue || 'spark error'); return; }
          const rd: LoomDisplayPayload | undefined = p.output.richDisplay;
          if (rd && rd.columns?.length >= 2) {
            onFull(fullFromAggResult(rd, !!chart.legend));
            setAggState('idle'); setAggMsg(`Full dataset (${rd.totalCount.toLocaleString()} rows aggregated)`);
          } else {
            setAggState('error'); setAggMsg('Aggregation returned no chartable result');
          }
          return;
        }
        if (['error', 'dead', 'killed'].includes(p.status)) { setAggState('error'); setAggMsg(`Spark ${p.status}`); return; }
      }
      setAggState('error'); setAggMsg('timed out');
    } catch (e: any) { setAggState('error'); setAggMsg(e?.message || String(e)); }
  }, [chart, payload.dfVarName, notebookId, workspaceId, computeId, onFull]);

  return (
    <div className={s.chartCard}>
      <div className={s.chartHead}>
        {renaming ? (
          <Input size="small" defaultValue={chart.title} autoFocus style={{ flex: 1 }}
            onBlur={(e) => { onPatch({ title: e.target.value || chart.title }); setRenaming(false); }}
            onKeyDown={(e) => { if (e.key === 'Enter') { onPatch({ title: (e.target as HTMLInputElement).value || chart.title }); setRenaming(false); } if (e.key === 'Escape') setRenaming(false); }} />
        ) : (
          <span className={s.chartTitle} title={chart.title}>{chart.title}</span>
        )}
        <Tooltip content="Rename" relationship="label">
          <Button size="small" appearance="subtle" icon={<Rename16Regular />} onClick={() => setRenaming(true)} />
        </Tooltip>
        <Tooltip content="Duplicate" relationship="label">
          <Button size="small" appearance="subtle" icon={<Copy16Regular />} onClick={onDuplicate} />
        </Tooltip>
        <Tooltip content="Move up" relationship="label">
          <Button size="small" appearance="subtle" icon={<ChevronUp16Regular />} disabled={index === 0} onClick={() => onMove(-1)} />
        </Tooltip>
        <Tooltip content="Move down" relationship="label">
          <Button size="small" appearance="subtle" icon={<ChevronDown16Regular />} disabled={index === total - 1} onClick={() => onMove(1)} />
        </Tooltip>
        <Tooltip content="Delete" relationship="label">
          <Button size="small" appearance="subtle" icon={<Delete16Regular />} onClick={onRemove} />
        </Tooltip>
      </div>

      <ChartSvg chart={chart} data={data} />

      <div className={s.controls}>
        <label>
          <div className={s.ctrlLabel}>Type</div>
          <Select size="small" value={chart.type} onChange={(_, d) => onPatch({ type: d.value as LoomChartType })}>
            {CHART_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </Select>
        </label>
        <label>
          <div className={s.ctrlLabel}>Aggregate</div>
          <Select size="small" value={chart.agg} onChange={(_, d) => onPatch({ agg: d.value as LoomChartAgg })}>
            {AGGS.map((a) => <option key={a} value={a}>{a}</option>)}
          </Select>
        </label>
        <label>
          <div className={s.ctrlLabel}>X axis</div>
          <Select size="small" value={chart.xField} onChange={(_, d) => onPatch({ xField: d.value })}>
            {colNames.map((n) => <option key={n} value={n}>{n}</option>)}
          </Select>
        </label>
        <label>
          <div className={s.ctrlLabel}>Y axis</div>
          <Select size="small" value={chart.yField} onChange={(_, d) => onPatch({ yField: d.value })}>
            {(numNames.length ? numNames : colNames).map((n) => <option key={n} value={n}>{n}</option>)}
          </Select>
        </label>
        <label style={{ gridColumn: '1 / span 2' }}>
          <div className={s.ctrlLabel}>Legend / series (optional)</div>
          <Select size="small" value={chart.legend ?? ''} onChange={(_, d) => onPatch({ legend: d.value || undefined })}>
            <option value="">(none)</option>
            {colNames.map((n) => <option key={n} value={n}>{n}</option>)}
          </Select>
        </label>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Tooltip
          content={payload.dfVarName ? 'Run a Spark job to aggregate over every row, not just the sample' : 'Assign the DataFrame to a named variable before display() to enable full-dataset aggregation'}
          relationship="label">
          <Button size="small" appearance="primary"
            icon={aggState === 'running' ? <Spinner size="tiny" /> : <Play16Regular />}
            disabled={!payload.dfVarName || aggState === 'running'} onClick={runFullAgg}>
            {aggState === 'running' ? 'Aggregating…' : 'Aggregate over all rows'}
          </Button>
        </Tooltip>
        <Caption1 className={s.chartMeta} style={aggState === 'error' ? { color: tokens.colorPaletteRedForeground1 } : undefined}>
          {aggMsg || (full ? 'full dataset' : `sample (${payload.sampleSize.toLocaleString()} rows)`)}
        </Caption1>
      </div>
    </div>
  );
}

// ── Chart aggregation + SVG rendering ────────────────────────────────────────
interface ChartDatum { cat: string; series: string; value: number }

function aggregateSample(payload: LoomDisplayPayload, chart: LoomDisplayChartRec): ChartDatum[] {
  const { xField, yField, legend, agg, type } = chart;
  const n = payload.rows.length;

  // Scatter: raw (x, y) points from the sample — no grouping.
  if (type === 'scatter') {
    const out: ChartDatum[] = [];
    for (let i = 0; i < n && out.length < 2000; i++) {
      const x = toNum(colVal(payload, i, xField)); const y = toNum(colVal(payload, i, yField));
      if (x == null || y == null) continue;
      out.push({ cat: String(x), series: legend ? String(colVal(payload, i, legend) ?? '') : yField, value: y });
    }
    return out;
  }

  // Grouped aggregation by (xField [, legend]).
  const buckets = new Map<string, { sum: number; count: number; min: number; max: number; series: string; cat: string }>();
  for (let i = 0; i < n; i++) {
    const cat = String(colVal(payload, i, xField) ?? '∅');
    const series = legend ? String(colVal(payload, i, legend) ?? '') : '';
    const key = `${cat} ${series}`;
    const yv = toNum(colVal(payload, i, yField));
    let b = buckets.get(key);
    if (!b) { b = { sum: 0, count: 0, min: Infinity, max: -Infinity, series, cat }; buckets.set(key, b); }
    b.count++;
    if (yv != null) { b.sum += yv; b.min = Math.min(b.min, yv); b.max = Math.max(b.max, yv); }
  }
  const out: ChartDatum[] = [];
  for (const b of buckets.values()) {
    let value: number;
    switch (agg) {
      case 'count': value = b.count; break;
      case 'sum': value = b.sum; break;
      case 'mean': value = b.count ? b.sum / b.count : 0; break;
      case 'min': value = b.min === Infinity ? 0 : b.min; break;
      case 'max': value = b.max === -Infinity ? 0 : b.max; break;
      default: value = b.count;
    }
    out.push({ cat: b.cat, series: b.series, value });
  }
  out.sort((a, b) => a.cat.localeCompare(b.cat, undefined, { numeric: true }));
  return out.slice(0, 200);
}

/** Map a full-dataset agg result payload (cols = [x, value] or [x, series, value]) to ChartData. */
function fullFromAggResult(rd: LoomDisplayPayload, hasLegend: boolean): ChartDatum[] {
  const cols = rd.columns.map((c) => c.name);
  const xi = 0;
  const valIdx = cols.length - 1;
  const serIdx = hasLegend && cols.length >= 3 ? 1 : -1;
  const out: ChartDatum[] = [];
  for (const row of rd.rows) {
    const v = toNum(row[valIdx]); if (v == null) continue;
    out.push({ cat: String(row[xi] ?? '∅'), series: serIdx >= 0 ? String(row[serIdx] ?? '') : '', value: v });
  }
  out.sort((a, b) => a.cat.localeCompare(b.cat, undefined, { numeric: true }));
  return out.slice(0, 500);
}

function fmt(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

const W = 320, H = 200, PAD_L = 40, PAD_B = 30, PAD_T = 10, PAD_R = 12;

function ChartSvg({ chart, data }: { chart: LoomDisplayChartRec; data: ChartDatum[] }) {
  const s = useStyles();
  if (!data.length) {
    return <div className={s.chartMeta} style={{ padding: 16, textAlign: 'center' }}>No chartable data for this field selection.</div>;
  }
  const seriesNames = Array.from(new Set(data.map((d) => d.series)));
  const colorFor = (sName: string) => SERIES_COLORS[Math.max(0, seriesNames.indexOf(sName)) % SERIES_COLORS.length];

  if (chart.type === 'scatter') return <ScatterSvg chart={chart} data={data} colorFor={colorFor} seriesNames={seriesNames} />;
  if (chart.type === 'line') return <LineSvg chart={chart} data={data} colorFor={colorFor} seriesNames={seriesNames} />;
  if (chart.type === 'heatmap') return <HeatmapSvg chart={chart} data={data} />;
  return <BarSvg chart={chart} data={data} colorFor={colorFor} seriesNames={seriesNames} />;
}

function Legend({ names, colorFor }: { names: string[]; colorFor: (n: string) => string }) {
  if (names.length <= 1 && (names[0] === '' || names[0] === undefined)) return null;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, fontSize: 10, color: tokens.colorNeutralForeground2 }}>
      {names.map((n) => (
        <span key={n} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ width: 9, height: 9, borderRadius: 2, background: colorFor(n) }} />{n || '(all)'}
        </span>
      ))}
    </div>
  );
}

function BarSvg({ chart, data, colorFor, seriesNames }: { chart: LoomDisplayChartRec; data: ChartDatum[]; colorFor: (n: string) => string; seriesNames: string[] }) {
  // Distinct categories along x; one bar per category per series.
  const cats = Array.from(new Set(data.map((d) => d.cat))).slice(0, 24);
  const max = Math.max(1, ...data.map((d) => Math.abs(d.value)));
  const groupW = (W - PAD_L - PAD_R) / cats.length;
  const barW = Math.max(2, (groupW - 4) / Math.max(1, seriesNames.length));
  const y = (v: number) => H - PAD_B - (Math.abs(v) / max) * (H - PAD_B - PAD_T);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <Legend names={seriesNames} colorFor={colorFor} />
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label={`${chart.agg} of ${chart.yField} by ${chart.xField}`}>
        {[0, 0.5, 1].map((t) => { const yy = PAD_T + t * (H - PAD_B - PAD_T); const val = max * (1 - t);
          return <g key={t}><line x1={PAD_L} y1={yy} x2={W - PAD_R} y2={yy} stroke={tokens.colorNeutralStroke3} strokeWidth={0.5} /><text x={2} y={yy + 3} fontSize={9} fill={tokens.colorNeutralForeground3}>{fmt(val)}</text></g>; })}
        {cats.map((cat, ci) => seriesNames.map((sn, si) => {
          const d = data.find((dd) => dd.cat === cat && dd.series === sn); if (!d) return null;
          const x = PAD_L + ci * groupW + 2 + si * barW;
          return <rect key={`${ci}-${si}`} x={x} y={y(d.value)} width={Math.max(1, barW - 1)} height={H - PAD_B - y(d.value)} fill={colorFor(sn)} opacity={0.88}><title>{`${cat} · ${sn || chart.yField}: ${fmt(d.value)}`}</title></rect>;
        }))}
        {cats.map((cat, ci) => (
          <text key={cat} x={PAD_L + ci * groupW + groupW / 2} y={H - PAD_B + 12} fontSize={9} fill={tokens.colorNeutralForeground3} textAnchor="middle">
            {cat.length > 7 ? `${cat.slice(0, 6)}…` : cat}
          </text>
        ))}
      </svg>
    </div>
  );
}

function LineSvg({ chart, data, colorFor, seriesNames }: { chart: LoomDisplayChartRec; data: ChartDatum[]; colorFor: (n: string) => string; seriesNames: string[] }) {
  const cats = Array.from(new Set(data.map((d) => d.cat)));
  const vals = data.map((d) => d.value);
  const lo = Math.min(0, ...vals); const hi = Math.max(1, ...vals); const span = hi - lo || 1;
  const x = (i: number) => PAD_L + (cats.length <= 1 ? 0 : (i / (cats.length - 1)) * (W - PAD_L - PAD_R));
  const y = (v: number) => H - PAD_B - ((v - lo) / span) * (H - PAD_B - PAD_T);
  const paths = seriesNames.map((sn) => {
    let d = '';
    cats.forEach((cat, i) => { const pt = data.find((dd) => dd.cat === cat && dd.series === sn); if (!pt) return; d += d === '' ? `M ${x(i)} ${y(pt.value)}` : ` L ${x(i)} ${y(pt.value)}`; });
    return { d, sn };
  });
  const ticks = cats.length <= 1 ? [0] : [0, Math.floor(cats.length / 2), cats.length - 1];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <Legend names={seriesNames} colorFor={colorFor} />
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none" role="img" aria-label={`${chart.yField} trend over ${chart.xField}`}>
        {[0, 0.5, 1].map((t) => { const val = lo + t * span; const yy = y(val);
          return <g key={t}><line x1={PAD_L} y1={yy} x2={W - PAD_R} y2={yy} stroke={tokens.colorNeutralStroke3} strokeWidth={0.5} /><text x={2} y={yy + 3} fontSize={9} fill={tokens.colorNeutralForeground3}>{fmt(val)}</text></g>; })}
        {ticks.map((i) => <text key={i} x={x(i)} y={H - 8} fontSize={9} fill={tokens.colorNeutralForeground3} textAnchor={i === 0 ? 'start' : i === cats.length - 1 ? 'end' : 'middle'}>{(cats[i] ?? '').length > 8 ? `${cats[i].slice(0, 7)}…` : cats[i]}</text>)}
        {paths.map((p) => p.d ? <path key={p.sn} d={p.d} fill="none" stroke={colorFor(p.sn)} strokeWidth={1.8} /> : null)}
      </svg>
    </div>
  );
}

function ScatterSvg({ chart, data, colorFor, seriesNames }: { chart: LoomDisplayChartRec; data: ChartDatum[]; colorFor: (n: string) => string; seriesNames: string[] }) {
  const xs = data.map((d) => toNum(d.cat) ?? 0); const ys = data.map((d) => d.value);
  const xlo = Math.min(...xs), xhi = Math.max(...xs), xspan = xhi - xlo || 1;
  const ylo = Math.min(...ys), yhi = Math.max(...ys), yspan = yhi - ylo || 1;
  const px = (v: number) => PAD_L + ((v - xlo) / xspan) * (W - PAD_L - PAD_R);
  const py = (v: number) => H - PAD_B - ((v - ylo) / yspan) * (H - PAD_B - PAD_T);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <Legend names={seriesNames} colorFor={colorFor} />
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label={`${chart.yField} vs ${chart.xField}`}>
        {[0, 0.5, 1].map((t) => { const yy = PAD_T + t * (H - PAD_B - PAD_T);
          return <line key={t} x1={PAD_L} y1={yy} x2={W - PAD_R} y2={yy} stroke={tokens.colorNeutralStroke3} strokeWidth={0.5} />; })}
        {data.map((d, i) => <circle key={i} cx={px(toNum(d.cat) ?? 0)} cy={py(d.value)} r={2.4} fill={colorFor(d.series)} opacity={0.7}><title>{`${chart.xField}=${d.cat}, ${chart.yField}=${fmt(d.value)}`}</title></circle>)}
        <text x={PAD_L} y={H - 4} fontSize={9} fill={tokens.colorNeutralForeground3}>{fmt(xlo)}</text>
        <text x={W - PAD_R} y={H - 4} fontSize={9} fill={tokens.colorNeutralForeground3} textAnchor="end">{fmt(xhi)}</text>
      </svg>
    </div>
  );
}

function HeatmapSvg({ chart, data }: { chart: LoomDisplayChartRec; data: ChartDatum[] }) {
  // Pivot: x = chart.xField (cat), y = legend or series, cell = value (count).
  const xs = Array.from(new Set(data.map((d) => d.cat))).slice(0, 16);
  const ys = Array.from(new Set(data.map((d) => d.series || chart.yField))).slice(0, 12);
  const max = Math.max(1, ...data.map((d) => d.value));
  const cellW = (W - PAD_L - PAD_R) / Math.max(1, xs.length);
  const cellH = (H - PAD_B - PAD_T) / Math.max(1, ys.length);
  const lookup = (x: string, y: string) => data.find((d) => d.cat === x && (d.series || chart.yField) === y)?.value ?? 0;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label={`heatmap of ${chart.xField} by ${chart.legend ?? chart.yField}`}>
      {ys.map((yv, yi) => xs.map((xv, xi) => {
        const v = lookup(xv, yv); const intensity = v / max;
        return <rect key={`${xi}-${yi}`} x={PAD_L + xi * cellW} y={PAD_T + yi * cellH} width={Math.max(1, cellW - 1)} height={Math.max(1, cellH - 1)} fill={SERIES_COLORS[0]} opacity={0.12 + intensity * 0.82}><title>{`${xv} × ${yv}: ${fmt(v)}`}</title></rect>;
      }))}
      {xs.map((xv, xi) => <text key={xv} x={PAD_L + xi * cellW + cellW / 2} y={H - PAD_B + 12} fontSize={8} fill={tokens.colorNeutralForeground3} textAnchor="middle">{xv.length > 6 ? `${xv.slice(0, 5)}…` : xv}</text>)}
      {ys.map((yv, yi) => <text key={yv} x={2} y={PAD_T + yi * cellH + cellH / 2 + 3} fontSize={8} fill={tokens.colorNeutralForeground3}>{yv.length > 5 ? `${yv.slice(0, 4)}…` : yv}</text>)}
    </svg>
  );
}
