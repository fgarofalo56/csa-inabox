'use client';

/**
 * ReportVisualDesigner — the Power-BI-style visual gallery + Fields / Format /
 * Filters panes, built INTO the Loom report editor (no Power BI Desktop round
 * trip). It is the front end of the no-freeform-config visual pipeline:
 *
 *   field wells + filters  ──(dax-visual-compiler)──▶  DAX EVALUATE query
 *        (this component)                                       │
 *                                                               ▼
 *                          POST /api/items/report/[id]/query  (executeQueries)
 *                                                               │
 *                                                               ▼
 *                                  real rows ──▶ rendered visual + per-visual
 *                                                DAX receipt (disclosure)
 *
 * Parity target: the Power BI report canvas — the Visualizations gallery (19
 * visual types), the Fields well list, the Format pane, and the Filters pane
 * (Visual / Page / Report scopes). Only the theme (Fluent v9 + Loom tokens)
 * differs; the interaction model matches (pick a visual → drop fields into its
 * wells → it renders real data; change format → it restyles; add a filter → it
 * re-queries).
 *
 * Power BI is opt-in (no-fabric-dependency.md): this surface only renders inside
 * the report editor when the Console UAMI is registered in a Power BI workspace
 * and a dataset is selected. The query engine (executeQueries) works against any
 * Power BI dataset regardless of its loomSemanticBackend.
 *
 * No mock data: every row comes from the live executeQueries response. The only
 * non-functional state is the map/filled-map geographic-tile gate, surfaced as
 * an honest Fluent MessageBar (LOOM_BING_MAPS_KEY) — and even then the queried
 * rows are still shown in a grid below the gate.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Dropdown, Option, Field, Input, Switch, Button, Text, Caption1, Subtitle2,
  Badge, MessageBar, MessageBarBody, MessageBarTitle, Spinner, Tab, TabList,
  Tooltip, makeStyles, tokens,
} from '@fluentui/react-components';
import {
  DataBarVertical20Regular, DataBarHorizontal20Regular, DataLine20Regular,
  DataArea20Regular, DataPie20Regular, DataTreemap20Regular, DataFunnel20Regular,
  DataScatter20Regular, ChartMultiple20Regular, Gauge20Regular,
  TextNumberFormat20Regular, Map20Regular, Table20Regular, GridDots20Regular,
  Filter20Regular, PaintBrush20Regular, Options20Regular, Add20Regular,
  Delete20Regular, ArrowSync20Regular,
} from '@fluentui/react-icons';
import type { FluentIcon } from '@fluentui/react-icons';
import { ResultVisualize } from './result-visualize';
import {
  compileDaxQuery, VISUAL_CATALOG, refToAlias,
  type DaxVisualType, type VisualDef, type DaxFieldBinding, type DaxFilterDef,
  type DaxFormatDef, type DaxAgg, type VisualWellRole, type LegendPosition,
} from '../dax-visual-compiler';

// ── Flat field model derived from the dataset's tables ──────────────────────
interface PbiTableLite {
  name: string;
  columns?: Array<{ name: string; dataType?: string }>;
  measures?: Array<{ name: string; expression?: string }>;
}
interface FlatField {
  ref: string;            // 'Table'[Name]
  table: string;
  name: string;
  kind: 'column' | 'measure';
  numeric: boolean;
}

const NUMERIC_TYPES = new Set(['int64', 'double', 'decimal', 'currency', 'automatic']);

function flattenFields(tables: PbiTableLite[]): FlatField[] {
  const out: FlatField[] = [];
  for (const t of tables || []) {
    for (const c of t.columns || []) {
      out.push({
        ref: `'${t.name}'[${c.name}]`, table: t.name, name: c.name, kind: 'column',
        numeric: NUMERIC_TYPES.has((c.dataType || '').toLowerCase()),
      });
    }
    for (const m of t.measures || []) {
      out.push({ ref: `'${t.name}'[${m.name}]`, table: t.name, name: m.name, kind: 'measure', numeric: true });
    }
  }
  return out;
}

// ── Visual → gallery icon + grouping ────────────────────────────────────────
const VISUAL_ICON: Record<DaxVisualType, FluentIcon> = {
  bar: DataBarHorizontal20Regular,
  column: DataBarVertical20Regular,
  line: DataLine20Regular,
  area: DataArea20Regular,
  combo: ChartMultiple20Regular,
  pie: DataPie20Regular,
  donut: DataPie20Regular,
  card: TextNumberFormat20Regular,
  'multi-row-card': TextNumberFormat20Regular,
  kpi: Gauge20Regular,
  table: Table20Regular,
  matrix: GridDots20Regular,
  map: Map20Regular,
  'filled-map': Map20Regular,
  scatter: DataScatter20Regular,
  gauge: Gauge20Regular,
  funnel: DataFunnel20Regular,
  treemap: DataTreemap20Regular,
  slicer: Filter20Regular,
};

const AGGS: DaxAgg[] = ['SUM', 'AVERAGE', 'MIN', 'MAX', 'COUNT', 'DISTINCTCOUNT'];
const LEGEND_POSITIONS: LegendPosition[] = ['right', 'top', 'bottom', 'left', 'none'];
const DEFAULT_COLORS = ['#5b8def', '#22c1a6', '#e0a83a', '#d9534f', '#9b6bdf', '#3aa0e0'];

// Roles that take an aggregation when bound to a plain column.
const VALUE_ROLES = new Set<VisualWellRole>(['value', 'valueLine', 'target']);
// Single-binding wells.
const SINGLE_ROLES = new Set<VisualWellRole>(['matrixColumn', 'location', 'target']);

const useStyles = makeStyles({
  root: { display: 'flex', gap: '12px', alignItems: 'stretch', minHeight: '560px', minWidth: 0 },
  gallery: {
    flex: '0 0 168px', display: 'flex', flexDirection: 'column', gap: '6px',
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: '10px',
    padding: '10px', backgroundColor: tokens.colorNeutralBackground1, overflowY: 'auto', maxHeight: '720px',
  },
  galleryGrid: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '6px' },
  galleryTile: {
    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    gap: '2px', padding: '8px 4px', borderRadius: '8px', cursor: 'pointer',
    border: `1px solid ${tokens.colorNeutralStroke2}`, backgroundColor: tokens.colorNeutralBackground1,
    minHeight: '52px', textAlign: 'center',
  },
  galleryTileActive: { border: `2px solid ${tokens.colorBrandStroke1}`, backgroundColor: tokens.colorBrandBackground2 },
  tileLabel: { fontSize: '9px', lineHeight: '11px', color: tokens.colorNeutralForeground2 },
  canvas: {
    flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '10px',
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: '10px', padding: '14px',
    backgroundColor: tokens.colorNeutralBackground1,
  },
  panes: {
    flex: '0 0 300px', display: 'flex', flexDirection: 'column', gap: '8px',
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: '10px',
    padding: '10px', backgroundColor: tokens.colorNeutralBackground1, overflowY: 'auto', maxHeight: '720px',
  },
  well: { display: 'flex', flexDirection: 'column', gap: '4px', marginBottom: '10px' },
  wellRow: { display: 'flex', gap: '4px', alignItems: 'center' },
  filterCard: {
    display: 'flex', flexDirection: 'column', gap: '6px', padding: '8px',
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: '8px', marginBottom: '8px',
  },
  scopeLabel: { fontWeight: 600, fontSize: '12px', marginTop: '6px', color: tokens.colorNeutralForeground2 },
  daxBox: {
    fontFamily: 'ui-monospace, Consolas, monospace', fontSize: '11px', whiteSpace: 'pre-wrap',
    backgroundColor: tokens.colorNeutralBackground3, borderRadius: '8px', padding: '10px',
    border: `1px solid ${tokens.colorNeutralStroke2}`, maxHeight: '220px', overflow: 'auto',
    color: tokens.colorNeutralForeground2,
  },
  cardGrid: { display: 'flex', flexWrap: 'wrap', gap: '12px' },
  bigCard: {
    minWidth: '160px', padding: '16px 20px', borderRadius: '10px',
    border: `1px solid ${tokens.colorNeutralStroke2}`, backgroundColor: tokens.colorNeutralBackground2,
    display: 'flex', flexDirection: 'column', gap: '4px',
  },
  bigValue: { fontSize: '30px', fontWeight: 700, color: tokens.colorBrandForeground1 },
  grid: { width: '100%', borderCollapse: 'collapse', fontSize: '12px' },
  meta: { fontSize: '11px', color: tokens.colorNeutralForeground3 },
});

export interface ReportVisualDesignerProps {
  workspaceId: string;
  datasetId: string;
  reportId: string;
  /** Pre-loaded model tables; when omitted the designer fetches them itself. */
  tables?: PbiTableLite[];
}

type Bindings = Partial<Record<VisualWellRole, DaxFieldBinding[]>>;

export function ReportVisualDesigner({ workspaceId, datasetId, reportId, tables: tablesProp }: ReportVisualDesignerProps) {
  const s = useStyles();
  const [tables, setTables] = useState<PbiTableLite[]>(tablesProp || []);
  const [tablesErr, setTablesErr] = useState<string | null>(null);
  const [visualType, setVisualType] = useState<DaxVisualType>('column');
  const [bindings, setBindings] = useState<Bindings>({});
  const [filters, setFilters] = useState<{ visual: DaxFilterDef[]; page: DaxFilterDef[]; report: DaxFilterDef[] }>(
    { visual: [], page: [], report: [] },
  );
  const [format, setFormat] = useState<DaxFormatDef>({ title: '', dataLabels: true, legendPosition: 'right' });
  const [pane, setPane] = useState<'fields' | 'format' | 'filters'>('fields');
  const [rows, setRows] = useState<Array<Record<string, unknown>>>([]);
  const [runErr, setRunErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [lastDax, setLastDax] = useState('');
  const [showDax, setShowDax] = useState(false);

  const fields = useMemo(() => flattenFields(tables), [tables]);

  // Self-fetch tables when the parent didn't pass them.
  useEffect(() => {
    if (tablesProp && tablesProp.length) { setTables(tablesProp); return; }
    if (!workspaceId || !datasetId) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/items/semantic-model/${encodeURIComponent(datasetId)}?workspaceId=${encodeURIComponent(workspaceId)}`);
        const j = await r.json();
        if (cancelled) return;
        if (j.ok) { setTables(j.tables || []); setTablesErr(null); }
        else setTablesErr(j.error || `HTTP ${r.status}`);
      } catch (e: any) {
        if (!cancelled) setTablesErr(e?.message || String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [workspaceId, datasetId, tablesProp]);

  const wells = useMemo(
    () => VISUAL_CATALOG.find((c) => c.type === visualType)?.wells || [],
    [visualType],
  );

  // Assemble a VisualDef from the per-role bindings + filters + format.
  const visualDef = useMemo<VisualDef>(() => ({
    type: visualType,
    categoryFields: bindings.category || [],
    legendFields: bindings.legend || [],
    valueFields: bindings.value || [],
    valueLineFields: bindings.valueLine || [],
    columnFields: bindings.column || [],
    matrixColumnField: bindings.matrixColumn?.[0],
    targetField: bindings.target?.[0],
    locationField: bindings.location?.[0],
    visualFilters: filters.visual,
    pageFilters: filters.page,
    reportFilters: filters.report,
    format,
  }), [visualType, bindings, filters, format]);

  const dax = useMemo(() => compileDaxQuery(visualDef), [visualDef]);

  // Run the compiled DAX whenever it changes (and looks runnable).
  useEffect(() => {
    const runnable = /\bEVALUATE\b/i.test(dax);
    if (!runnable) { setRows([]); setRunErr(null); setLastDax(''); return; }
    let cancelled = false;
    setBusy(true); setRunErr(null);
    (async () => {
      try {
        const r = await fetch(`/api/items/report/${encodeURIComponent(reportId)}/query`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ workspaceId, datasetId, dax }),
        });
        const j = await r.json();
        if (cancelled) return;
        if (j.ok) { setRows(j.rows || []); setLastDax(j.dax || dax); setRunErr(null); }
        else { setRows([]); setRunErr(j.error || `HTTP ${r.status}`); setLastDax(dax); }
      } catch (e: any) {
        if (!cancelled) { setRows([]); setRunErr(e?.message || String(e)); }
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => { cancelled = true; };
  }, [dax, workspaceId, datasetId, reportId]);

  // ── Binding mutators ──────────────────────────────────────────────────────
  const setRoleBindings = useCallback((role: VisualWellRole, next: DaxFieldBinding[]) => {
    setBindings((prev) => ({ ...prev, [role]: next }));
  }, []);

  const makeBinding = useCallback((ref: string, role: VisualWellRole): DaxFieldBinding => {
    const f = fields.find((x) => x.ref === ref);
    const isMeasure = f?.kind === 'measure';
    const b: DaxFieldBinding = { ref, alias: refToAlias(ref) };
    if (isMeasure) b.isMeasure = true;
    else if (VALUE_ROLES.has(role)) b.agg = f?.numeric ? 'SUM' : 'COUNT';
    return b;
  }, [fields]);

  // ── Convert executeQueries row objects → columns + matrix for ResultVisualize ─
  const { columns, rowMatrix } = useMemo(() => {
    if (!rows.length) return { columns: [] as string[], rowMatrix: [] as unknown[][] };
    const cols = Array.from(rows.reduce((set, r) => {
      Object.keys(r).forEach((k) => set.add(k));
      return set;
    }, new Set<string>()));
    const matrix = rows.map((r) => cols.map((c) => r[c]));
    return { columns: cols, rowMatrix: matrix };
  }, [rows]);

  const galleryTiles = (
    <div className={s.galleryGrid}>
      {VISUAL_CATALOG.map((c) => {
        const Icon = VISUAL_ICON[c.type];
        const active = c.type === visualType;
        return (
          <Tooltip key={c.type} content={c.label} relationship="label">
            <div
              className={`${s.galleryTile} ${active ? s.galleryTileActive : ''}`}
              role="button" tabIndex={0} aria-pressed={active} aria-label={c.label}
              onClick={() => setVisualType(c.type)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setVisualType(c.type); }}
            >
              <Icon />
              <span className={s.tileLabel}>{c.label.replace(/ (chart|map)$/i, '')}</span>
            </div>
          </Tooltip>
        );
      })}
    </div>
  );

  return (
    <div>
      {tablesErr && (
        <MessageBar intent="warning" style={{ marginBottom: 10 }}>
          <MessageBarBody>
            <MessageBarTitle>Could not load model fields</MessageBarTitle>
            {tablesErr}. Confirm the Console UAMI is a Member/Contributor on this workspace and the dataset exposes tables.
          </MessageBarBody>
        </MessageBar>
      )}
      <div className={s.root}>
        {/* ── Gallery ── */}
        <div className={s.gallery}>
          <Subtitle2 style={{ marginBottom: 4 }}>Visualizations</Subtitle2>
          {galleryTiles}
        </div>

        {/* ── Canvas ── */}
        <div className={s.canvas}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Badge appearance="filled" color="brand">{VISUAL_CATALOG.find((c) => c.type === visualType)?.label}</Badge>
            {busy && <Spinner size="tiny" label="Querying…" />}
            <div style={{ flex: 1 }} />
            <Caption1 className={s.meta}>{rows.length} row{rows.length === 1 ? '' : 's'}</Caption1>
            <Button size="small" appearance="subtle" icon={<ArrowSync20Regular />}
              onClick={() => setShowDax((v) => !v)}>{showDax ? 'Hide DAX' : 'Show DAX'}</Button>
          </div>

          {format.title ? <Subtitle2>{format.title}</Subtitle2> : null}

          {runErr && (
            <MessageBar intent="error">
              <MessageBarBody><MessageBarTitle>Query failed</MessageBarTitle>{runErr}</MessageBarBody>
            </MessageBar>
          )}

          <VisualCanvas
            type={visualType}
            columns={columns}
            rowMatrix={rowMatrix}
            rows={rows}
            format={format}
            styles={s}
          />

          {/* Per-visual DAX receipt (Performance-Analyzer-style "Copy query"). */}
          {showDax && (
            <div>
              <Caption1 className={s.meta} style={{ marginBottom: 4, display: 'block' }}>
                Generated DAX (this is the query Power BI runs for this visual):
              </Caption1>
              <pre className={s.daxBox}>{lastDax || dax}</pre>
              <Button size="small" appearance="outline"
                onClick={() => navigator.clipboard?.writeText(lastDax || dax)}>Copy query</Button>
            </div>
          )}
        </div>

        {/* ── Panes ── */}
        <div className={s.panes}>
          <TabList selectedValue={pane} onTabSelect={(_, d) => setPane(d.value as typeof pane)} size="small">
            <Tab value="fields" icon={<Options20Regular />}>Fields</Tab>
            <Tab value="format" icon={<PaintBrush20Regular />}>Format</Tab>
            <Tab value="filters" icon={<Filter20Regular />}>Filters</Tab>
          </TabList>

          {pane === 'fields' && (
            <FieldsPane
              wells={wells} bindings={bindings} fields={fields} styles={s}
              onSet={setRoleBindings} makeBinding={makeBinding}
            />
          )}
          {pane === 'format' && (
            <FormatPane format={format} setFormat={setFormat} valueCount={(bindings.value || []).length || 1} styles={s} />
          )}
          {pane === 'filters' && (
            <FiltersPane filters={filters} setFilters={setFilters} fields={fields} styles={s} />
          )}
        </div>
      </div>
    </div>
  );
}

// ============================================================
// Canvas — renders the queried rows per visual type
// ============================================================
type Styles = ReturnType<typeof useStyles>;

function VisualCanvas({
  type, columns, rowMatrix, rows, format, styles,
}: {
  type: DaxVisualType; columns: string[]; rowMatrix: unknown[][];
  rows: Array<Record<string, unknown>>; format: DaxFormatDef; styles: Styles;
}) {
  if (!rows.length) {
    return (
      <MessageBar intent="info">
        <MessageBarBody>Add fields to the visual&rsquo;s wells (Fields pane) to render real data.</MessageBarBody>
      </MessageBar>
    );
  }

  // Chart family → the live SVG chart picker (real rows).
  if (['bar', 'column', 'line', 'area', 'pie', 'donut', 'scatter', 'combo'].includes(type)) {
    return <ResultVisualize columns={columns} rows={rowMatrix} />;
  }

  // Card / KPI / Multi-row card → scalar cards.
  if (['card', 'kpi', 'multi-row-card'].includes(type)) {
    return <CardCanvas columns={columns} rows={rows} styles={styles} />;
  }

  // Gauge → SVG arc (value vs target).
  if (type === 'gauge') return <GaugeCanvas columns={columns} rows={rows} />;

  // Funnel → SVG stacked horizontal bars.
  if (type === 'funnel') return <FunnelCanvas columns={columns} rowMatrix={rowMatrix} />;

  // Treemap → proportional rectangles.
  if (type === 'treemap') return <TreemapCanvas columns={columns} rowMatrix={rowMatrix} />;

  // Map / Filled map → honest geo-tile gate, but still show the queried rows.
  if (type === 'map' || type === 'filled-map') {
    return (
      <>
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Map tiles require a geographic tile service</MessageBarTitle>
            The location query ran and returned real rows (below). Rendering them on a basemap
            needs a tile key — set <code>LOOM_BING_MAPS_KEY</code> (or a configured Azure Maps account)
            to draw bubbles/regions. Until then the location aggregates show as a grid.
          </MessageBarBody>
        </MessageBar>
        <GridCanvas columns={columns} rowMatrix={rowMatrix} styles={styles} />
      </>
    );
  }

  // Table / Matrix → grid (matrix pivots are shown flat; the query group-bys
  // both row + column fields).
  return <GridCanvas columns={columns} rowMatrix={rowMatrix} styles={styles} />;
}

function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
  return null;
}
function fmtNum(n: number): string {
  if (Math.abs(n) >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}
function cell(v: unknown): string {
  if (v == null) return '—';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function CardCanvas({ columns, rows, styles }: { columns: string[]; rows: Array<Record<string, unknown>>; styles: Styles }) {
  // One card per numeric column of the first row (Card/KPI), or one card per
  // row for grouped multi-row cards.
  const first = rows[0] || {};
  const numericCols = columns.filter((c) => num(first[c]) != null);
  const cards = numericCols.length
    ? numericCols.map((c) => ({ label: c, value: fmtNum(num(first[c]) as number) }))
    : columns.map((c) => ({ label: c, value: cell(first[c]) }));
  return (
    <div className={styles.cardGrid}>
      {cards.map((c, i) => (
        <div key={i} className={styles.bigCard}>
          <span className={styles.bigValue}>{c.value}</span>
          <Caption1>{c.label}</Caption1>
        </div>
      ))}
    </div>
  );
}

function GridCanvas({ columns, rowMatrix, styles }: { columns: string[]; rowMatrix: unknown[][]; styles: Styles }) {
  const shown = rowMatrix.slice(0, 200);
  return (
    <div style={{ overflow: 'auto', maxHeight: 420 }}>
      <table className={styles.grid}>
        <thead>
          <tr>{columns.map((c, i) => (
            <th key={i} style={{ textAlign: 'left', borderBottom: `1px solid ${tokens.colorNeutralStroke2}`, padding: '6px 10px', position: 'sticky', top: 0, background: tokens.colorNeutralBackground1 }}>{c}</th>
          ))}</tr>
        </thead>
        <tbody>
          {shown.map((r, ri) => (
            <tr key={ri}>{r.map((v, ci) => (
              <td key={ci} style={{ borderBottom: `1px solid ${tokens.colorNeutralStroke3}`, padding: '5px 10px' }}>{cell(v)}</td>
            ))}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function GaugeCanvas({ columns, rows }: { columns: string[]; rows: Array<Record<string, unknown>> }) {
  const first = rows[0] || {};
  const numericCols = columns.filter((c) => num(first[c]) != null);
  const value = num(first[numericCols[0]]) ?? 0;
  const target = numericCols[1] != null ? (num(first[numericCols[1]]) ?? value * 1.25) : value * 1.25;
  const max = Math.max(value, target) * 1.1 || 1;
  const frac = Math.max(0, Math.min(1, value / max));
  const cx = 150, cy = 140, r = 110;
  const a0 = Math.PI, a1 = Math.PI + frac * Math.PI;
  const arc = (from: number, to: number) =>
    `M ${cx + r * Math.cos(from)} ${cy + r * Math.sin(from)} A ${r} ${r} 0 ${to - from > Math.PI ? 1 : 0} 1 ${cx + r * Math.cos(to)} ${cy + r * Math.sin(to)}`;
  const tA = Math.PI + Math.max(0, Math.min(1, target / max)) * Math.PI;
  return (
    <svg viewBox="0 0 300 170" width="100%" height={200} role="img" aria-label={`Gauge ${numericCols[0]}`}>
      <path d={arc(Math.PI, 2 * Math.PI)} fill="none" stroke={tokens.colorNeutralStroke2} strokeWidth={18} strokeLinecap="round" />
      <path d={arc(a0, a1)} fill="none" stroke="#5b8def" strokeWidth={18} strokeLinecap="round" />
      <line x1={cx + (r - 14) * Math.cos(tA)} y1={cy + (r - 14) * Math.sin(tA)} x2={cx + (r + 6) * Math.cos(tA)} y2={cy + (r + 6) * Math.sin(tA)} stroke={tokens.colorPaletteRedForeground1} strokeWidth={3} />
      <text x={cx} y={cy - 10} textAnchor="middle" fontSize={28} fontWeight={700} fill={tokens.colorBrandForeground1}>{fmtNum(value)}</text>
      <text x={cx} y={cy + 14} textAnchor="middle" fontSize={11} fill={tokens.colorNeutralForeground3}>target {fmtNum(target)}</text>
    </svg>
  );
}

function FunnelCanvas({ columns, rowMatrix }: { columns: string[]; rowMatrix: unknown[][] }) {
  // First column = stage label; first numeric column = value.
  const valIdx = columns.findIndex((_, i) => rowMatrix.some((r) => num(r[i]) != null));
  const labIdx = columns.findIndex((_, i) => i !== valIdx);
  const items = rowMatrix
    .map((r) => ({ label: cell(r[labIdx >= 0 ? labIdx : 0]), value: num(r[valIdx]) ?? 0 }))
    .filter((d) => d.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, 12);
  if (!items.length) return <Caption1>No funnel values.</Caption1>;
  const max = items[0].value || 1;
  const W = 600, rowH = 34;
  return (
    <svg viewBox={`0 0 ${W} ${items.length * rowH + 10}`} width="100%" height={items.length * rowH + 10} role="img" aria-label="Funnel">
      {items.map((d, i) => {
        const w = (d.value / max) * (W - 160);
        const x = (W - 160 - w) / 2 + 4;
        return (
          <g key={i}>
            <rect x={x} y={i * rowH + 4} width={Math.max(w, 2)} height={rowH - 8} rx={3} fill={DEFAULT_COLORS[i % DEFAULT_COLORS.length]} opacity={0.85} />
            <text x={W - 150} y={i * rowH + rowH / 2 + 4} fontSize={11} fill={tokens.colorNeutralForeground2}>
              {d.label.length > 18 ? `${d.label.slice(0, 17)}…` : d.label} · {fmtNum(d.value)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function TreemapCanvas({ columns, rowMatrix }: { columns: string[]; rowMatrix: unknown[][] }) {
  const valIdx = columns.findIndex((_, i) => rowMatrix.some((r) => num(r[i]) != null));
  const labIdx = columns.findIndex((_, i) => i !== valIdx);
  const items = rowMatrix
    .map((r) => ({ label: cell(r[labIdx >= 0 ? labIdx : 0]), value: Math.abs(num(r[valIdx]) ?? 0) }))
    .filter((d) => d.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, 16);
  if (!items.length) return <Caption1>No treemap values.</Caption1>;
  // Simple row-stripe treemap (sufficient, deterministic, no external lib).
  const total = items.reduce((a, b) => a + b.value, 0) || 1;
  const W = 600, H = 300;
  const rectsPerRow = Math.ceil(Math.sqrt(items.length));
  let idx = 0; const out: React.ReactNode[] = [];
  const rowsCount = Math.ceil(items.length / rectsPerRow);
  for (let row = 0; row < rowsCount; row++) {
    const rowItems = items.slice(row * rectsPerRow, (row + 1) * rectsPerRow);
    const rowTotal = rowItems.reduce((a, b) => a + b.value, 0) || 1;
    const y = (row / rowsCount) * H;
    let x = 0;
    for (const it of rowItems) {
      const w = (it.value / rowTotal) * W;
      out.push(
        <g key={idx}>
          <rect x={x} y={y} width={Math.max(w - 2, 1)} height={H / rowsCount - 2} fill={DEFAULT_COLORS[idx % DEFAULT_COLORS.length]} opacity={0.85} />
          {w > 60 && <text x={x + 6} y={y + 16} fontSize={10} fill="#fff">{it.label.length > 14 ? `${it.label.slice(0, 13)}…` : it.label}</text>}
          {w > 60 && <text x={x + 6} y={y + 30} fontSize={10} fill="#fff">{fmtNum(it.value)}</text>}
        </g>,
      );
      x += w; idx++;
    }
  }
  return <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={300} role="img" aria-label="Treemap">{out}</svg>;
}

// ============================================================
// Fields pane
// ============================================================
function FieldsPane({
  wells, bindings, fields, styles, onSet, makeBinding,
}: {
  wells: ReadonlyArray<{ role: VisualWellRole; label: string; multi: boolean }>;
  bindings: Bindings; fields: FlatField[]; styles: Styles;
  onSet: (role: VisualWellRole, next: DaxFieldBinding[]) => void;
  makeBinding: (ref: string, role: VisualWellRole) => DaxFieldBinding;
}) {
  return (
    <div style={{ paddingTop: 8 }}>
      {wells.map((well) => {
        const current = bindings[well.role] || [];
        const single = SINGLE_ROLES.has(well.role) || !well.multi;
        const available = fields.filter((f) => !current.some((c) => c.ref === f.ref));
        return (
          <div key={well.role} className={styles.well}>
            <Caption1 style={{ fontWeight: 600 }}>{well.label}</Caption1>
            {current.map((b, i) => {
              const f = fields.find((x) => x.ref === b.ref);
              return (
                <div key={b.ref} className={styles.wellRow}>
                  <Badge appearance="tint" color={f?.kind === 'measure' ? 'success' : 'informative'} style={{ flex: 1, justifyContent: 'flex-start', overflow: 'hidden' }}>
                    {b.ref}
                  </Badge>
                  {VALUE_ROLES.has(well.role) && f?.kind === 'column' && (
                    <Dropdown size="small" style={{ minWidth: 92 }} value={b.agg || 'SUM'} selectedOptions={[b.agg || 'SUM']}
                      aria-label="aggregation"
                      onOptionSelect={(_, d) => {
                        const next = [...current]; next[i] = { ...b, agg: d.optionValue as DaxAgg }; onSet(well.role, next);
                      }}>
                      {AGGS.map((a) => <Option key={a} value={a}>{a}</Option>)}
                    </Dropdown>
                  )}
                  <Button size="small" appearance="subtle" icon={<Delete20Regular />} aria-label="remove field"
                    onClick={() => onSet(well.role, current.filter((c) => c.ref !== b.ref))} />
                </div>
              );
            })}
            {(!single || current.length === 0) && (
              <Dropdown
                size="small" placeholder="Add field…" value="" selectedOptions={[]}
                aria-label={`add field to ${well.label}`}
                onOptionSelect={(_, d) => {
                  if (!d.optionValue) return;
                  const b = makeBinding(d.optionValue, well.role);
                  onSet(well.role, single ? [b] : [...current, b]);
                }}
              >
                {available.map((f) => (
                  <Option key={f.ref} value={f.ref} text={f.ref}>
                    {f.name} {f.kind === 'measure' ? '(measure)' : `· ${f.table}`}
                  </Option>
                ))}
              </Dropdown>
            )}
          </div>
        );
      })}
      {fields.length === 0 && <Caption1>No fields in this model yet.</Caption1>}
    </div>
  );
}

// ============================================================
// Format pane
// ============================================================
function FormatPane({
  format, setFormat, valueCount, styles,
}: { format: DaxFormatDef; setFormat: (f: DaxFormatDef) => void; valueCount: number; styles: Styles }) {
  const colors = format.colors || DEFAULT_COLORS.slice(0, Math.max(1, valueCount));
  return (
    <div style={{ paddingTop: 8, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Field label="Title">
        <Input size="small" value={format.title || ''} placeholder="Visual title"
          onChange={(_, d) => setFormat({ ...format, title: d.value })} />
      </Field>
      <Switch label="Data labels" checked={!!format.dataLabels}
        onChange={(_, d) => setFormat({ ...format, dataLabels: d.checked })} />
      <Field label="Legend position">
        <Dropdown size="small" value={format.legendPosition || 'right'} selectedOptions={[format.legendPosition || 'right']}
          onOptionSelect={(_, d) => setFormat({ ...format, legendPosition: d.optionValue as LegendPosition })}>
          {LEGEND_POSITIONS.map((p) => <Option key={p} value={p}>{p}</Option>)}
        </Dropdown>
      </Field>
      <Field label="X axis title">
        <Input size="small" value={format.xAxisTitle || ''} onChange={(_, d) => setFormat({ ...format, xAxisTitle: d.value })} />
      </Field>
      <Field label="Y axis title">
        <Input size="small" value={format.yAxisTitle || ''} onChange={(_, d) => setFormat({ ...format, yAxisTitle: d.value })} />
      </Field>
      <div>
        <Caption1 style={{ fontWeight: 600 }}>Series colors</Caption1>
        <div className={styles.wellRow} style={{ flexWrap: 'wrap', marginTop: 4 }}>
          {colors.map((c, i) => (
            <input key={i} type="color" value={c} aria-label={`series ${i + 1} color`}
              onChange={(e) => {
                const next = [...colors]; next[i] = e.target.value; setFormat({ ...format, colors: next });
              }} />
          ))}
        </div>
      </div>
    </div>
  );
}

// ============================================================
// Filters pane (Visual / Page / Report scopes)
// ============================================================
function FiltersPane({
  filters, setFilters, fields, styles,
}: {
  filters: { visual: DaxFilterDef[]; page: DaxFilterDef[]; report: DaxFilterDef[] };
  setFilters: (f: { visual: DaxFilterDef[]; page: DaxFilterDef[]; report: DaxFilterDef[] }) => void;
  fields: FlatField[]; styles: Styles;
}) {
  const columnFields = fields.filter((f) => f.kind === 'column');
  const scopes: Array<{ key: 'visual' | 'page' | 'report'; label: string }> = [
    { key: 'visual', label: 'Filters on this visual' },
    { key: 'page', label: 'Filters on this page' },
    { key: 'report', label: 'Filters on all pages (report)' },
  ];
  return (
    <div style={{ paddingTop: 8 }}>
      {scopes.map((scope) => {
        const list = filters[scope.key];
        return (
          <div key={scope.key}>
            <div className={styles.scopeLabel}>{scope.label}</div>
            {list.map((f, i) => (
              <div key={i} className={styles.filterCard}>
                <div className={styles.wellRow}>
                  <Dropdown size="small" style={{ flex: 1 }} value={f.column} selectedOptions={[f.column]} placeholder="Column"
                    aria-label="filter column"
                    onOptionSelect={(_, d) => {
                      const next = { ...filters }; next[scope.key] = list.map((x, xi) => xi === i ? { ...x, column: d.optionValue || '' } : x); setFilters(next);
                    }}>
                    {columnFields.map((cf) => <Option key={cf.ref} value={cf.ref} text={cf.ref}>{cf.name} · {cf.table}</Option>)}
                  </Dropdown>
                  <Button size="small" appearance="subtle" icon={<Delete20Regular />} aria-label="remove filter"
                    onClick={() => { const next = { ...filters }; next[scope.key] = list.filter((_, xi) => xi !== i); setFilters(next); }} />
                </div>
                <Field label="Keep values (comma-separated)">
                  <Input size="small" value={f.values.join(', ')} placeholder="e.g. East, West, 2026"
                    onChange={(_, d) => {
                      const vals = d.value.split(',').map((v) => v.trim()).filter(Boolean);
                      const next = { ...filters }; next[scope.key] = list.map((x, xi) => xi === i ? { ...x, values: vals } : x); setFilters(next);
                    }} />
                </Field>
              </div>
            ))}
            <Button size="small" appearance="outline" icon={<Add20Regular />} style={{ marginBottom: 8 }}
              onClick={() => { const next = { ...filters }; next[scope.key] = [...list, { column: '', type: 'in', values: [] }]; setFilters(next); }}>
              Add filter
            </Button>
          </div>
        );
      })}
      {fields.length === 0 && <Caption1>Load model fields to add filters.</Caption1>}
    </div>
  );
}
