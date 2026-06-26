'use client';

/**
 * ReportDesigner — the Loom-native interactive REPORT DESIGNER.
 *
 * Power BI report-authoring parity, Azure-native (no-fabric-dependency.md): the
 * default report editor is no longer a read-only viewer. You can CREATE and
 * design a report end-to-end against the bound Azure Analysis Services tabular
 * model — NO Power BI / Fabric workspace required.
 *
 * Layout mirrors the Power BI report canvas (ui-parity.md), Loom-themed:
 *   ├─ left   : Pages list  (add / rename / delete / select a page)
 *   ├─ center : report CANVAS — a grid of visuals; add via a visual-type
 *   │           gallery; select to edit; remove; resize (span) + reorder
 *   └─ right  : Visualizations + Fields pane — pick a visual type, drag/assign
 *               model columns & measures into wells (Axis/Category, Values,
 *               Legend), choose an aggregation (Sum/Avg/Count/Min/Max)
 *
 * Every visual LIVE-RENDERS real rows by POSTing its field wells to
 * /api/items/report/[id]/query (DAX SUMMARIZECOLUMNS over the AAS model — real
 * backend, no mock). Save persists the whole definition via PUT
 * /api/items/report/[id]/definition. The Fields tree is loaded from
 * /api/items/report/[id]/fields (real TMSCHEMA Discover). When no AAS model is
 * bound the surface still renders, with an honest Fluent gate naming the exact
 * binding to set (no-vaporware.md).
 *
 * no-freeform-config.md: visual type, fields, and aggregations are all
 * pickers / wells — there is never a typed-DAX or JSON box.
 *
 * The Power BI embed path (NEXT_PUBLIC_LOOM_BI_BACKEND=powerbi → ReportLikeEditor)
 * is untouched; this is strictly the Azure-native default.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Badge, Button, Caption1, Dropdown, Option, Divider, Input,
  Menu, MenuTrigger, MenuPopover, MenuList, MenuItem, MenuGroup, MenuGroupHeader, MenuDivider,
  MessageBar, MessageBarBody, MessageBarTitle, Spinner, Subtitle2, Text, Title3, Tooltip,
  Tree, TreeItem, TreeItemLayout, TabList, Tab,
  Table, TableHeader, TableHeaderCell, TableBody, TableRow, TableCell,
  makeStyles, tokens, mergeClasses,
} from '@fluentui/react-components';
import {
  Add20Regular, Delete20Regular, Save20Regular, ArrowSync20Regular, Edit20Regular,
  DataBarVerticalRegular, DataBarHorizontalRegular, DataLineRegular, DataAreaRegular,
  DataPieRegular, DataScatterRegular, Table20Regular, GridRegular, NumberSymbol20Regular,
  Filter20Regular, Dismiss16Regular, ChevronUp20Regular, ChevronDown20Regular, Sparkle20Regular,
} from '@fluentui/react-icons';
import type { ReactElement } from 'react';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';
import { ItemEditorChrome } from './item-editor-chrome';
import { EmptyState } from '@/lib/components/empty-state';
import { LoomChart, type LoomChartType } from '@/lib/components/charts/loom-chart';
import { ReportPowerBiCopilot, type CopilotVisualSpec } from '@/lib/components/report/report-powerbi-copilot';

// ── Model ───────────────────────────────────────────────────────────────────

type VisualType =
  | 'table' | 'matrix' | 'card' | 'bar' | 'column' | 'line' | 'area' | 'pie' | 'donut' | 'scatter' | 'slicer';

type Agg = 'Sum' | 'Avg' | 'Count' | 'Min' | 'Max';
const AGGS: Agg[] = ['Sum', 'Avg', 'Count', 'Min', 'Max'];

type WellName = 'category' | 'values' | 'legend';

interface WellField {
  uid: string;
  table?: string;
  column?: string;
  measure?: string;
  aggregation?: Agg;
}
interface Wells { category: WellField[]; values: WellField[]; legend: WellField[] }
interface DVisual {
  id: string;
  type: VisualType;
  title: string;
  wells: Wells;
  /** column span on a 12-col canvas grid + a row-height hint */
  w: number;
  h: number;
}
interface DPage { id: string; name: string; visuals: DVisual[] }

interface FieldColumn { name: string; dataType: string; summarizeBy?: string; isHidden: boolean }
interface FieldMeasure { name: string; isHidden: boolean }
interface FieldTable { name: string; columns: FieldColumn[]; measures: FieldMeasure[] }

interface VisualState { rows: Array<Record<string, unknown>>; loading: boolean; err: string | null }

// ── Visual catalogue (gallery) ───────────────────────────────────────────────

const VISUALS: { type: VisualType; label: string; icon: ReactElement }[] = [
  { type: 'table',   label: 'Table',          icon: <Table20Regular /> },
  { type: 'matrix',  label: 'Matrix',         icon: <GridRegular /> },
  { type: 'card',    label: 'Card / KPI',     icon: <NumberSymbol20Regular /> },
  { type: 'column',  label: 'Column chart',   icon: <DataBarVerticalRegular /> },
  { type: 'bar',     label: 'Bar chart',      icon: <DataBarHorizontalRegular /> },
  { type: 'line',    label: 'Line chart',     icon: <DataLineRegular /> },
  { type: 'area',    label: 'Area chart',     icon: <DataAreaRegular /> },
  { type: 'pie',     label: 'Pie chart',      icon: <DataPieRegular /> },
  { type: 'donut',   label: 'Donut chart',    icon: <DataPieRegular /> },
  { type: 'scatter', label: 'Scatter',        icon: <DataScatterRegular /> },
  { type: 'slicer',  label: 'Slicer',         icon: <Filter20Regular /> },
];
const CHART_TYPES = new Set<VisualType>(['bar', 'column', 'line', 'area', 'pie', 'donut', 'scatter']);

/** Which wells a given visual type exposes, with parity-correct labels. */
function wellsFor(type: VisualType): { name: WellName; label: string }[] {
  if (type === 'card') return [{ name: 'values', label: 'Fields' }];
  if (type === 'slicer') return [{ name: 'category', label: 'Field' }];
  if (type === 'table') return [{ name: 'values', label: 'Columns' }];
  if (type === 'matrix') return [
    { name: 'category', label: 'Rows' },
    { name: 'legend', label: 'Columns' },
    { name: 'values', label: 'Values' },
  ];
  // charts
  return [
    { name: 'category', label: type === 'scatter' ? 'Details' : 'Axis' },
    { name: 'values', label: 'Values' },
    { name: 'legend', label: 'Legend' },
  ];
}

// ── helpers ───────────────────────────────────────────────────────────────────

function uid(prefix = 'v'): string {
  const r = (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(16).slice(2, 10);
  return `${prefix}_${r}`;
}
function fieldKey(f: WellField): string { return f.measure ? `m:${f.measure}` : `c:${f.table}.${f.column}`; }
function fieldLabel(f: WellField): string {
  if (f.measure) return f.measure;
  const agg = f.aggregation ? `${f.aggregation} of ` : '';
  return `${agg}${f.column}`;
}

/** Parse a stored single-`field` ('Table'[Col] / [Measure]) for back-compat. */
function parseFieldRef(field?: string): WellField | null {
  if (!field) return null;
  let m = /^'?([^'[]+?)'?\[([^\]]+)\]$/.exec(field.trim());
  if (m) return { uid: uid('f'), table: m[1].trim(), column: m[2].trim() };
  m = /^\[([^\]]+)\]$/.exec(field.trim());
  if (m) return { uid: uid('f'), measure: m[1].trim() };
  return null;
}

/** Build the wire `visual` payload the /query route understands (type + field + wells). */
function queryVisual(v: DVisual) {
  const strip = (a: WellField[]) => a.map(({ uid: _u, ...rest }) => rest);
  const cat = strip(v.wells.category);
  const vals = strip(v.wells.values);
  const first = vals[0] || cat[0];
  const field = first?.measure
    ? `[${first.measure}]`
    : first?.column
      ? `${first.table ? `'${first.table.replace(/'/g, "''")}'` : ''}[${first.column}]`
      : undefined;
  return {
    type: v.type,
    field,
    wells: { category: cat, values: vals, legend: strip(v.wells.legend) },
  };
}

/** True when a visual has at least one bound field (i.e. is runnable). */
function hasBinding(v: DVisual): boolean {
  return v.wells.category.length + v.wells.values.length + v.wells.legend.length > 0;
}

// ── styles ────────────────────────────────────────────────────────────────────

const useStyles = makeStyles({
  pane: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, padding: tokens.spacingVerticalM, minHeight: 0 },
  pageRow: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS,
    padding: tokens.spacingVerticalXS, borderRadius: tokens.borderRadiusMedium, cursor: 'pointer',
  },
  pageRowActive: { backgroundColor: tokens.colorNeutralBackground1Selected, fontWeight: tokens.fontWeightSemibold },
  pageRowName: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  canvasWrap: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, padding: tokens.spacingVerticalL, minHeight: 0 },
  canvasGrid: { display: 'grid', gridTemplateColumns: 'repeat(12, minmax(0, 1fr))', gap: tokens.spacingHorizontalM },
  vcard: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS,
    padding: tokens.spacingVerticalM,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
    transitionProperty: 'box-shadow, border-color', transitionDuration: tokens.durationFaster,
    minHeight: '180px',
    ':hover': { boxShadow: tokens.shadow16 },
  },
  vcardSel: { border: `1px solid ${tokens.colorBrandStroke1}`, boxShadow: tokens.shadow16 },
  vcardHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS },
  vcardTitle: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  vcardBody: { flex: 1, minWidth: 0, overflow: 'auto' },
  toolbar: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  spacer: { flex: 1 },
  gallery: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: tokens.spacingHorizontalXS },
  galleryBtn: {
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: tokens.spacingVerticalXXS,
    padding: tokens.spacingVerticalS, minWidth: 0,
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground1, cursor: 'pointer',
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover },
  },
  galleryBtnActive: { border: `1px solid ${tokens.colorBrandStroke1}`, backgroundColor: tokens.colorBrandBackground2 },
  well: {
    border: `1px dashed ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium,
    padding: tokens.spacingVerticalXS, minHeight: '44px', display: 'flex', flexDirection: 'column',
    gap: tokens.spacingVerticalXXS, backgroundColor: tokens.colorNeutralBackground2,
  },
  wellOver: { border: `1px dashed ${tokens.colorBrandStroke1}`, backgroundColor: tokens.colorBrandBackground2 },
  wellHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS },
  token: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS,
    padding: `${tokens.spacingVerticalXXS} ${tokens.spacingHorizontalXS}`,
    borderRadius: tokens.borderRadiusMedium, backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  tokenName: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  chip: {
    display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalXXS, cursor: 'grab',
    padding: `${tokens.spacingVerticalXXS} ${tokens.spacingHorizontalXS}`,
    borderRadius: tokens.borderRadiusMedium, border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  section: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS },
  kpi: { fontSize: tokens.fontSizeHero800, fontWeight: tokens.fontWeightSemibold, lineHeight: tokens.lineHeightHero800 },
  muted: { color: tokens.colorNeutralForeground3 },
});
type Styles = ReturnType<typeof useStyles>;

// ── visual render ─────────────────────────────────────────────────────────────

function VisualBody({ visual, state, styles }: { visual: DVisual; state?: VisualState; styles: Styles }) {
  if (!hasBinding(visual)) {
    return <Caption1 className={styles.muted}>Add a field from the Fields pane to render this {visual.type}.</Caption1>;
  }
  if (!state || state.loading) return <Spinner size="tiny" label="Querying model…" />;
  if (state.err) return <MessageBar intent="error"><MessageBarBody>{state.err}</MessageBarBody></MessageBar>;
  const rows = state.rows;
  if (rows.length === 0) return <Caption1 className={styles.muted}>No rows returned.</Caption1>;
  const cols = Object.keys(rows[0]);

  if (visual.type === 'card') {
    const val = Object.values(rows[0])[0];
    return <div className={styles.kpi}>{val == null ? '—' : String(val)}</div>;
  }

  if (visual.type === 'slicer') {
    const col = cols[0];
    return (
      <Dropdown placeholder={`Filter by ${col}`} aria-label={`slicer ${col}`}>
        {rows.slice(0, 200).map((r, i) => (
          <Option key={i} text={String(r[col] ?? '—')}>{String(r[col] ?? '—')}</Option>
        ))}
      </Dropdown>
    );
  }

  if (CHART_TYPES.has(visual.type) && visual.type !== 'scatter') {
    const hasNumeric = rows.some((r) => Object.values(r).some((v) => v != null && v !== '' && !Number.isNaN(Number(v))));
    if (hasNumeric) {
      return <LoomChart type={visual.type as LoomChartType} rows={rows} height={200} />;
    }
  }
  if (visual.type === 'scatter') {
    return <LoomChart type="scatter" rows={rows} height={200} />;
  }

  // table / matrix / non-numeric fallback
  return (
    <Table size="small">
      <TableHeader><TableRow>{cols.map((c) => <TableHeaderCell key={c}>{c}</TableHeaderCell>)}</TableRow></TableHeader>
      <TableBody>
        {rows.slice(0, 100).map((row, ri) => (
          <TableRow key={ri}>{cols.map((c) => <TableCell key={c}>{row[c] == null ? '—' : String(row[c])}</TableCell>)}</TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

// ── well editor (right pane) ────────────────────────────────────────────────

function WellEditor({
  visual, well, label, tables, styles, onAdd, onRemove, onAgg, onDrop,
}: {
  visual: DVisual; well: WellName; label: string; tables: FieldTable[]; styles: Styles;
  onAdd: (well: WellName, f: WellField) => void;
  onRemove: (well: WellName, uid: string) => void;
  onAgg: (well: WellName, uid: string, agg: Agg) => void;
  onDrop: (well: WellName, payload: WellField) => void;
}) {
  const [over, setOver] = useState(false);
  const items = visual.wells[well];
  return (
    <div className={styles.section}>
      <div className={styles.wellHead}>
        <Caption1><strong>{label}</strong></Caption1>
        <div className={styles.spacer} />
        <Menu>
          <MenuTrigger disableButtonEnhancement>
            <Button size="small" appearance="subtle" icon={<Add20Regular />} aria-label={`add field to ${label}`} />
          </MenuTrigger>
          <MenuPopover>
            <MenuList>
              {tables.length === 0 && <MenuItem disabled>No model fields loaded</MenuItem>}
              {tables.map((t) => (
                <MenuGroup key={t.name}>
                  <MenuGroupHeader>{t.name}</MenuGroupHeader>
                  {t.measures.map((m) => (
                    <MenuItem key={`m:${m.name}`} icon={<NumberSymbol20Regular />}
                      onClick={() => onAdd(well, { uid: uid('f'), measure: m.name })}>{m.name}</MenuItem>
                  ))}
                  {t.columns.map((c) => (
                    <MenuItem key={`c:${c.name}`}
                      onClick={() => onAdd(well, { uid: uid('f'), table: t.name, column: c.name, aggregation: well === 'values' ? 'Sum' : undefined })}>{c.name}</MenuItem>
                  ))}
                  <MenuDivider />
                </MenuGroup>
              ))}
            </MenuList>
          </MenuPopover>
        </Menu>
      </div>
      <div
        className={mergeClasses(styles.well, over && styles.wellOver)}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault(); setOver(false);
          try {
            const p = JSON.parse(e.dataTransfer.getData('application/json')) as WellField;
            if (p && (p.column || p.measure)) onDrop(well, { ...p, uid: uid('f'), aggregation: well === 'values' && p.column ? (p.aggregation || 'Sum') : p.aggregation });
          } catch { /* ignore non-field drops */ }
        }}
      >
        {items.length === 0 && <Caption1 className={styles.muted}>Drop a field here</Caption1>}
        {items.map((f) => (
          <div key={f.uid} className={styles.token}>
            <span className={styles.tokenName}>{fieldLabel(f)}</span>
            {well === 'values' && f.column && (
              <Dropdown size="small" value={f.aggregation || 'Sum'} selectedOptions={[f.aggregation || 'Sum']}
                aria-label="aggregation" style={{ minWidth: '92px' }}
                onOptionSelect={(_e, d) => onAgg(well, f.uid, (d.optionValue as Agg) || 'Sum')}>
                {AGGS.map((a) => <Option key={a} value={a}>{a}</Option>)}
              </Dropdown>
            )}
            <Button size="small" appearance="subtle" icon={<Dismiss16Regular />}
              aria-label={`remove ${fieldLabel(f)}`} onClick={() => onRemove(well, f.uid)} />
          </div>
        ))}
      </div>
    </div>
  );
}

// ── main ────────────────────────────────────────────────────────────────────

export function ReportDesigner({ item, id }: { item: FabricItemType; id: string }) {
  const styles = useStyles();

  const [pages, setPages] = useState<DPage[]>([]);
  const [activePage, setActivePage] = useState(0);
  const [selectedVisual, setSelectedVisual] = useState<string | null>(null);
  /** Right rail mode: the Build pane (visualizations + fields) or the Power BI Copilot. */
  const [rightTab, setRightTab] = useState<'build' | 'copilot'>('build');
  const [reportName, setReportName] = useState('');
  const [aasServer, setAasServer] = useState<string | null>(null);
  const [aasDatabase, setAasDatabase] = useState<string | null>(null);

  const [tables, setTables] = useState<FieldTable[]>([]);
  const [fieldsErr, setFieldsErr] = useState<string | null>(null);
  const [fieldsLoading, setFieldsLoading] = useState(false);

  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [visualRows, setVisualRows] = useState<Record<string, VisualState>>({});

  const bound = !!(aasServer && aasDatabase);

  // ── load definition ────────────────────────────────────────────────────────
  const loadDetail = useCallback(async () => {
    setLoading(true); setLoadErr(null);
    try {
      const r = await fetch(`/api/items/report/${encodeURIComponent(id)}`);
      const j = await r.json();
      if (!j.ok) { setLoadErr(j.error || `HTTP ${r.status}`); return; }
      setReportName(j.report?.name || '');
      setAasServer(j.aasServer ?? null);
      setAasDatabase(j.aasDatabase ?? null);
      const dpages: DPage[] = (j.pages || []).map((p: any, pi: number): DPage => ({
        id: uid('p'),
        name: p.displayName || p.name || `Page ${pi + 1}`,
        visuals: (p.visuals || []).map((v: any): DVisual => {
          const cfgWells = v.config?.wells;
          const reUid = (a: any[]): WellField[] => (Array.isArray(a) ? a : []).map((f) => ({ uid: uid('f'), ...f }));
          let wells: Wells;
          if (cfgWells) {
            wells = { category: reUid(cfgWells.category), values: reUid(cfgWells.values), legend: reUid(cfgWells.legend) };
          } else {
            // Back-compat: seed a single well from the legacy `field` string.
            const parsed = parseFieldRef(v.field);
            const into: WellName = parsed?.measure ? 'values' : 'category';
            wells = { category: [], values: [], legend: [] };
            if (parsed) wells[into] = [parsed.measure ? parsed : { ...parsed, aggregation: undefined }];
          }
          return {
            id: uid('v'),
            type: (v.type as VisualType) || 'table',
            title: v.title || '',
            wells,
            w: Math.min(12, Math.max(1, Number(v.config?.layout?.w) || 6)),
            h: Math.max(1, Number(v.config?.layout?.h) || 4),
          };
        }),
      }));
      setPages(dpages.length ? dpages : [{ id: uid('p'), name: 'Page 1', visuals: [] }]);
      setActivePage(0);
      setDirty(false);
    } catch (e: any) { setLoadErr(e?.message || String(e)); }
    finally { setLoading(false); }
  }, [id]);

  // ── load fields (model schema) ───────────────────────────────────────────────
  const loadFields = useCallback(async () => {
    setFieldsLoading(true); setFieldsErr(null);
    try {
      const r = await fetch(`/api/items/report/${encodeURIComponent(id)}/fields`);
      const j = await r.json();
      if (j.ok) { setTables(j.tables || []); }
      else { setTables([]); setFieldsErr(j.error || `HTTP ${r.status}`); }
    } catch (e: any) { setTables([]); setFieldsErr(e?.message || String(e)); }
    finally { setFieldsLoading(false); }
  }, [id]);

  useEffect(() => { loadDetail(); loadFields(); }, [loadDetail, loadFields]);

  const page = pages[activePage];
  const selected = useMemo(
    () => (page?.visuals || []).find((v) => v.id === selectedVisual) || null,
    [page, selectedVisual],
  );

  // ── live render: query each visual on the active page ─────────────────────────
  const runVisual = useCallback(async (v: DVisual) => {
    if (!hasBinding(v)) return;
    setVisualRows((p) => ({ ...p, [v.id]: { rows: p[v.id]?.rows || [], loading: true, err: null } }));
    try {
      const r = await fetch(`/api/items/report/${encodeURIComponent(id)}/query`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ visual: queryVisual(v) }),
      });
      const j = await r.json();
      if (j.ok) setVisualRows((p) => ({ ...p, [v.id]: { rows: j.rows || [], loading: false, err: null } }));
      else setVisualRows((p) => ({ ...p, [v.id]: { rows: [], loading: false, err: j.error || `HTTP ${r.status}` } }));
    } catch (e: any) {
      setVisualRows((p) => ({ ...p, [v.id]: { rows: [], loading: false, err: e?.message || String(e) } }));
    }
  }, [id]);

  // Re-query a visual whenever its binding signature changes (and on page load).
  const bindingSig = (v: DVisual) => `${v.type}|${JSON.stringify(queryVisual(v).wells)}`;
  useEffect(() => {
    if (!bound || !page) return;
    page.visuals.forEach((v) => { if (hasBinding(v)) runVisual(v); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bound, activePage, page?.visuals.map(bindingSig).join('~')]);

  // ── mutation helpers ─────────────────────────────────────────────────────────
  const mutatePage = useCallback((fn: (p: DPage) => DPage) => {
    setPages((prev) => prev.map((p, i) => (i === activePage ? fn(p) : p)));
    setDirty(true);
  }, [activePage]);

  const mutateVisual = useCallback((vid: string, fn: (v: DVisual) => DVisual) => {
    mutatePage((p) => ({ ...p, visuals: p.visuals.map((v) => (v.id === vid ? fn(v) : v)) }));
  }, [mutatePage]);

  const addVisual = useCallback((type: VisualType) => {
    const v: DVisual = { id: uid('v'), type, title: VISUALS.find((x) => x.type === type)?.label || type, wells: { category: [], values: [], legend: [] }, w: type === 'card' ? 3 : 6, h: 4 };
    mutatePage((p) => ({ ...p, visuals: [...p.visuals, v] }));
    setSelectedVisual(v.id);
  }, [mutatePage]);

  const removeVisual = useCallback((vid: string) => {
    mutatePage((p) => ({ ...p, visuals: p.visuals.filter((v) => v.id !== vid) }));
    if (selectedVisual === vid) setSelectedVisual(null);
  }, [mutatePage, selectedVisual]);

  const moveVisual = useCallback((vid: string, dir: -1 | 1) => {
    mutatePage((p) => {
      const idx = p.visuals.findIndex((v) => v.id === vid);
      const to = idx + dir;
      if (idx < 0 || to < 0 || to >= p.visuals.length) return p;
      const next = [...p.visuals];
      const [moved] = next.splice(idx, 1);
      next.splice(to, 0, moved);
      return { ...p, visuals: next };
    });
  }, [mutatePage]);

  const addToWell = useCallback((vid: string, well: WellName, f: WellField) => {
    mutateVisual(vid, (v) => {
      if (v.wells[well].some((x) => fieldKey(x) === fieldKey(f))) return v;
      // single-field wells (card uses many values; slicer/category single)
      const single = well === 'category' && (v.type === 'slicer');
      const cur = single ? [] : v.wells[well];
      return { ...v, wells: { ...v.wells, [well]: [...cur, f] } };
    });
  }, [mutateVisual]);
  const removeFromWell = useCallback((vid: string, well: WellName, fuid: string) => {
    mutateVisual(vid, (v) => ({ ...v, wells: { ...v.wells, [well]: v.wells[well].filter((x) => x.uid !== fuid) } }));
  }, [mutateVisual]);
  const setAgg = useCallback((vid: string, well: WellName, fuid: string, agg: Agg) => {
    mutateVisual(vid, (v) => ({ ...v, wells: { ...v.wells, [well]: v.wells[well].map((x) => (x.uid === fuid ? { ...x, aggregation: agg } : x)) } }));
  }, [mutateVisual]);

  // ── pages ──────────────────────────────────────────────────────────────────
  const addPage = () => {
    setPages((prev) => {
      const np: DPage = { id: uid('p'), name: `Page ${prev.length + 1}`, visuals: [] };
      setActivePage(prev.length);
      return [...prev, np];
    });
    setDirty(true);
  };
  const renamePage = (pid: string, name: string) => {
    setPages((prev) => prev.map((p) => (p.id === pid ? { ...p, name } : p)));
    setDirty(true);
  };
  const deletePage = (pid: string) => {
    setPages((prev) => {
      const next = prev.filter((p) => p.id !== pid);
      const safe = next.length ? next : [{ id: uid('p'), name: 'Page 1', visuals: [] }];
      setActivePage((ap) => Math.max(0, Math.min(ap, safe.length - 1)));
      return safe;
    });
    setDirty(true);
  };

  // ── Power BI Copilot actions (applied to the SAME in-memory designer state) ──
  // The Copilot pane proposes structured specs (never DAX); the user approves and
  // these handlers add the visual / page to the active page. The visual then
  // live-renders via …/query and persists on the existing Save (PUT …/definition).
  const applyCopilotVisual = useCallback((spec: CopilotVisualSpec) => {
    const reUid = (a?: Array<{ table?: string; column?: string; measure?: string; aggregation?: Agg }>): WellField[] =>
      (a || []).map((f) => ({ uid: uid('f'), ...f }));
    const v: DVisual = {
      id: uid('v'),
      type: spec.type,
      title: spec.title || VISUALS.find((x) => x.type === spec.type)?.label || spec.type,
      wells: {
        category: reUid(spec.wells?.category),
        values: reUid(spec.wells?.values),
        legend: reUid(spec.wells?.legend),
      },
      w: spec.w && spec.w >= 2 ? Math.min(12, spec.w) : (spec.type === 'card' ? 3 : 6),
      h: spec.h && spec.h >= 1 ? spec.h : 4,
    };
    mutatePage((p) => ({ ...p, visuals: [...p.visuals, v] }));
    setSelectedVisual(v.id);
  }, [mutatePage]);

  const addCopilotPage = useCallback((name?: string) => {
    setPages((prev) => {
      const np: DPage = { id: uid('p'), name: (name || '').trim() || `Page ${prev.length + 1}`, visuals: [] };
      setActivePage(prev.length);
      return [...prev, np];
    });
    setDirty(true);
  }, []);

  // ── save ─────────────────────────────────────────────────────────────────────
  const save = useCallback(async () => {
    setSaveBusy(true); setSaveMsg(null);
    try {
      const body = {
        pages: pages.map((p) => ({
          name: p.name,
          visuals: p.visuals.map((v) => ({
            visualType: v.type,
            title: v.title,
            wells: queryVisual(v).wells,
            layout: { x: 0, y: 0, w: v.w, h: v.h },
          })),
        })),
      };
      const r = await fetch(`/api/items/report/${encodeURIComponent(id)}/definition`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      const j = await r.json();
      if (j.ok) { setDirty(false); setSaveMsg({ ok: true, text: `Saved ${j.pageCount} page(s), ${j.visualCount} visual(s).` }); }
      else setSaveMsg({ ok: false, text: j.error || `HTTP ${r.status}` });
    } catch (e: any) { setSaveMsg({ ok: false, text: e?.message || String(e) }); }
    finally { setSaveBusy(false); }
  }, [id, pages]);

  // ── ribbon ───────────────────────────────────────────────────────────────────
  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Report', actions: [
        { label: saveBusy ? 'Saving…' : 'Save', icon: <Save20Regular />, onClick: save, disabled: saveBusy || !dirty, title: 'persist the whole report definition' },
        { label: 'Refresh', icon: <ArrowSync20Regular />, onClick: () => { loadDetail(); loadFields(); }, title: 'reload definition + model fields' },
      ]},
      { label: 'Insert', actions: [
        { label: 'New page', icon: <Add20Regular />, onClick: addPage, title: 'add a report page' },
      ]},
    ]},
  ], [save, saveBusy, dirty, loadDetail, loadFields]);

  // ── left: pages ──────────────────────────────────────────────────────────────
  const leftPanel = (
    <div className={styles.pane}>
      <div className={styles.toolbar}>
        <Subtitle2>Pages</Subtitle2>
        <div className={styles.spacer} />
        <Tooltip content="Add page" relationship="label">
          <Button size="small" appearance="subtle" icon={<Add20Regular />} onClick={addPage} />
        </Tooltip>
      </div>
      {pages.map((p, i) => (
        <div key={p.id} className={mergeClasses(styles.pageRow, i === activePage && styles.pageRowActive)}
          onClick={() => { setActivePage(i); setSelectedVisual(null); }}>
          <Text className={styles.pageRowName}>{p.name}</Text>
          <Menu>
            <MenuTrigger disableButtonEnhancement>
              <Button size="small" appearance="subtle" icon={<Edit20Regular />} aria-label="page actions" onClick={(e) => e.stopPropagation()} />
            </MenuTrigger>
            <MenuPopover>
              <MenuList>
                <RenamePageItem name={p.name} onRename={(n) => renamePage(p.id, n)} />
                <MenuItem icon={<Delete20Regular />} onClick={() => deletePage(p.id)}>Delete page</MenuItem>
              </MenuList>
            </MenuPopover>
          </Menu>
        </div>
      ))}
      {pages.length === 0 && <Caption1 className={styles.muted}>No pages.</Caption1>}
    </div>
  );

  // ── center: canvas ───────────────────────────────────────────────────────────
  const main = (
    <div className={styles.canvasWrap}>
      <div className={styles.toolbar}>
        <Badge appearance="filled" color="brand">Report · Loom-native (Azure Analysis Services)</Badge>
        {reportName && <Subtitle2>{reportName}{page ? ` — ${page.name}` : ''}</Subtitle2>}
        <div className={styles.spacer} />
        {dirty && <Badge appearance="tint" color="warning">Unsaved</Badge>}
        <Button appearance="primary" icon={<Save20Regular />} disabled={saveBusy || !dirty} onClick={save}>
          {saveBusy ? 'Saving…' : 'Save'}
        </Button>
      </div>

      {loadErr && <MessageBar intent="error"><MessageBarBody>{loadErr}</MessageBarBody></MessageBar>}
      {saveMsg && <MessageBar intent={saveMsg.ok ? 'success' : 'error'}><MessageBarBody>{saveMsg.text}</MessageBarBody></MessageBar>}
      {!bound && !loading && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Bind an Azure Analysis Services model</MessageBarTitle>
            Visuals render by querying a bound AAS tabular model with DAX — no Power BI workspace required.
            Set <strong>state.aasServer</strong> (XMLA URI, e.g. <code>asazure://eastus2.asazure.windows.net/my-server</code>)
            and <strong>state.aasDatabase</strong> on this item, or configure <strong>LOOM_AAS_SERVER</strong> + <strong>LOOM_AAS_DATABASE</strong>
            {' '}(admin-plane/main.bicep). The Console UAMI must be a server admin on the AAS instance. You can still lay out pages and visuals now;
            they will render once the model is bound.
          </MessageBarBody>
        </MessageBar>
      )}

      {loading && <Spinner label="Loading report…" />}

      {!loading && page && page.visuals.length === 0 && (
        <EmptyState
          icon={<DataBarVerticalRegular />}
          title="Design your first visual"
          body="Pick a visualization from the Visualizations pane on the right, then drag model fields into its wells. Every visual renders live against the bound tabular model."
        />
      )}

      {!loading && page && page.visuals.length > 0 && (
        <div className={styles.canvasGrid}>
          {page.visuals.map((v, i) => (
            <div key={v.id} className={mergeClasses(styles.vcard, selectedVisual === v.id && styles.vcardSel)}
              style={{ gridColumn: `span ${Math.min(12, Math.max(2, v.w))}` }}
              onClick={() => setSelectedVisual(v.id)}>
              <div className={styles.vcardHead}>
                <Badge appearance="tint" size="small">{VISUALS.find((x) => x.type === v.type)?.label || v.type}</Badge>
                <Text className={styles.vcardTitle} weight="semibold">{v.title || '(untitled)'}</Text>
                <Tooltip content="Move left" relationship="label"><Button size="small" appearance="subtle" icon={<ChevronUp20Regular />} onClick={(e) => { e.stopPropagation(); moveVisual(v.id, -1); }} disabled={i === 0} /></Tooltip>
                <Tooltip content="Move right" relationship="label"><Button size="small" appearance="subtle" icon={<ChevronDown20Regular />} onClick={(e) => { e.stopPropagation(); moveVisual(v.id, 1); }} disabled={i === page.visuals.length - 1} /></Tooltip>
                <Tooltip content="Remove visual" relationship="label"><Button size="small" appearance="subtle" icon={<Delete20Regular />} onClick={(e) => { e.stopPropagation(); removeVisual(v.id); }} /></Tooltip>
              </div>
              <div className={styles.vcardBody}>
                <VisualBody visual={v} state={visualRows[v.id]} styles={styles} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );

  // ── right: visualizations + fields ──────────────────────────────────────────
  const sizes: { label: string; w: number }[] = [
    { label: 'S', w: 3 }, { label: 'M', w: 6 }, { label: 'L', w: 9 }, { label: 'XL', w: 12 },
  ];
  const rightPanel = (
    <div className={styles.pane}>
      <TabList selectedValue={rightTab} onTabSelect={(_e, d) => setRightTab(d.value as 'build' | 'copilot')} size="small">
        <Tab value="build" icon={<DataBarVerticalRegular />}>Build</Tab>
        <Tab value="copilot" icon={<Sparkle20Regular />}>Power BI Copilot</Tab>
      </TabList>
      {rightTab === 'copilot' ? (
        <ReportPowerBiCopilot
          reportId={id}
          tables={tables}
          pageIndex={activePage}
          pageName={page?.name || ''}
          visualCount={page?.visuals.length || 0}
          onApplyVisual={applyCopilotVisual}
          onAddPage={addCopilotPage}
        />
      ) : (
      <>
      <Title3>Visualizations</Title3>
      <div className={styles.gallery}>
        {VISUALS.map((vt) => (
          <button key={vt.type} type="button"
            className={mergeClasses(styles.galleryBtn, selected?.type === vt.type && styles.galleryBtnActive)}
            onClick={() => (selected ? mutateVisual(selected.id, (v) => ({ ...v, type: vt.type })) : addVisual(vt.type))}
            title={selected ? `change to ${vt.label}` : `add a ${vt.label}`}>
            {vt.icon}
            <Caption1>{vt.label}</Caption1>
          </button>
        ))}
      </div>

      <Divider />

      {!selected && <Caption1 className={styles.muted}>Select a visual on the canvas, or click a visualization above to add one, then assign fields.</Caption1>}

      {selected && (
        <>
          <div className={styles.section}>
            <Caption1><strong>Title</strong></Caption1>
            <Input size="small" value={selected.title}
              onChange={(_e, d) => mutateVisual(selected.id, (v) => ({ ...v, title: d.value }))} />
          </div>
          <div className={styles.section}>
            <Caption1><strong>Size</strong></Caption1>
            <div className={styles.toolbar}>
              {sizes.map((s) => (
                <Button key={s.label} size="small" appearance={selected.w === s.w ? 'primary' : 'outline'}
                  onClick={() => mutateVisual(selected.id, (v) => ({ ...v, w: s.w }))}>{s.label}</Button>
              ))}
            </div>
          </div>

          {wellsFor(selected.type).map((w) => (
            <WellEditor key={w.name} visual={selected} well={w.name} label={w.label} tables={tables} styles={styles}
              onAdd={(well, f) => addToWell(selected.id, well, f)}
              onRemove={(well, fuid) => removeFromWell(selected.id, well, fuid)}
              onAgg={(well, fuid, agg) => setAgg(selected.id, well, fuid, agg)}
              onDrop={(well, f) => addToWell(selected.id, well, f)} />
          ))}
        </>
      )}

      <Divider />

      <div className={styles.toolbar}>
        <Title3>Fields</Title3>
        <div className={styles.spacer} />
        <Tooltip content="Reload model fields" relationship="label">
          <Button size="small" appearance="subtle" icon={<ArrowSync20Regular />} onClick={loadFields} />
        </Tooltip>
      </div>
      {fieldsLoading && <Spinner size="tiny" label="Reading model…" />}
      {fieldsErr && !fieldsLoading && (
        <MessageBar intent="warning"><MessageBarBody>{fieldsErr}</MessageBarBody></MessageBar>
      )}
      {!fieldsLoading && tables.length > 0 && (
        <Tree aria-label="Model fields">
          {tables.map((t) => (
            <TreeItem key={t.name} itemType="branch" value={t.name}>
              <TreeItemLayout>{t.name}</TreeItemLayout>
              <Tree>
                {t.measures.map((m) => (
                  <TreeItem key={`m:${m.name}`} itemType="leaf" value={`m:${t.name}.${m.name}`}>
                    <TreeItemLayout iconBefore={<NumberSymbol20Regular />}>
                      <span className={styles.chip} draggable
                        onDragStart={(e) => e.dataTransfer.setData('application/json', JSON.stringify({ measure: m.name }))}>
                        {m.name}
                      </span>
                    </TreeItemLayout>
                  </TreeItem>
                ))}
                {t.columns.map((c) => (
                  <TreeItem key={`c:${c.name}`} itemType="leaf" value={`c:${t.name}.${c.name}`}>
                    <TreeItemLayout>
                      <span className={styles.chip} draggable
                        onDragStart={(e) => e.dataTransfer.setData('application/json', JSON.stringify({ table: t.name, column: c.name }))}>
                        {c.name}
                      </span>
                    </TreeItemLayout>
                  </TreeItem>
                ))}
              </Tree>
            </TreeItem>
          ))}
        </Tree>
      )}
      {!fieldsLoading && tables.length === 0 && !fieldsErr && (
        <Caption1 className={styles.muted}>No model fields. Bind an AAS model to populate the Fields tree.</Caption1>
      )}
      </>
      )}
    </div>
  );

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon}
      leftPanel={leftPanel} main={main} rightPanel={rightPanel} rightPanelLabel="Build" />
  );
}

/** Inline rename control rendered inside the page's action menu. */
function RenamePageItem({ name, onRename }: { name: string; onRename: (n: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(name);
  if (!editing) {
    return <MenuItem icon={<Edit20Regular />} persistOnClick onClick={(e) => { e?.preventDefault?.(); setVal(name); setEditing(true); }}>Rename page</MenuItem>;
  }
  return (
    <div style={{ display: 'flex', gap: tokens.spacingHorizontalXS, padding: tokens.spacingVerticalXS }}>
      <Input size="small" value={val} autoFocus onClick={(e) => e.stopPropagation()}
        onChange={(_e, d) => setVal(d.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') { onRename(val.trim() || name); setEditing(false); } }} />
      <Button size="small" appearance="primary" onClick={() => { onRename(val.trim() || name); setEditing(false); }}>OK</Button>
    </div>
  );
}

export default ReportDesigner;
