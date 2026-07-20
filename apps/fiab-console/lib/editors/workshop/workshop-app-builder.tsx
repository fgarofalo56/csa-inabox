'use client';

import { clientFetch } from '@/lib/client-fetch';
/**
 * Workshop app builder — the real, live low-code app builder surface for the
 * Loom IQ `workshop-app` item (Palantir Foundry **Workshop** parity). Replaces
 * the old single scrolling config form (bind ontology → toggle object views →
 * add CRUD actions → run a dialog) with an actual app builder:
 *
 *   • a drag-resize widget CANVAS with a typed palette — Object Table, Chart,
 *     Metric/KPI, Filter, Form (real CRUD), Button, Text — and a Fluent property
 *     INSPECTOR; every widget carries a persisted { x, y, w, h } layout;
 *   • app-level typed VARIABLES (object-set-filter / string / number / boolean /
 *     date) with typed default controls — no JSON. Object-set-filter variables
 *     are written by Filter widgets (and table row-select events) and CONSUME by
 *     data widgets as a server-side parameterised WHERE — that is the
 *     "a filter drives a table" binding, resolved against real Synapse;
 *   • EVENT → effect wiring on Button / Table widgets (click / row-select /
 *     page-load → set-variable / run-action / refresh / clear-variable),
 *     executed live in Preview;
 *   • a live in-editor PREVIEW (Run mode) that binds every data widget to its
 *     ontology object type's real rows via POST /run-action (op list / aggregate
 *     / distinct against the bound ontology's Synapse warehouse) — no mock data.
 *
 * Azure-native by default (no Microsoft Fabric / Power BI). All reads/writes run
 * the existing /api/items/workshop-app/[id]/run-action route (parameterised
 * T-SQL on the Synapse dedicated SQL pool behind the bound ontology). All config
 * is dropdown / structured-form driven (per .claude/rules — no freeform JSON).
 *
 * Persistence is via the parent editor's item PATCH (Cosmos): `onWidgetsChange`
 * / `onVariablesChange` write back into the workshop-app item `state`.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type ReactElement } from 'react';
import {
  Body1, Caption1, Subtitle2, Title3, Badge, Button, Input, Textarea, Field, Dropdown, Option,
  Spinner, Switch, Tab, TabList, Tooltip, Divider,
  Accordion, AccordionItem, AccordionHeader, AccordionPanel,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  makeStyles, mergeClasses, tokens,
} from '@fluentui/react-components';
import {
  Add20Regular, Dismiss16Regular, Play20Regular, ArrowSync20Regular,
  Table20Regular, DataUsage20Regular, NumberSymbol20Regular, DocumentText20Regular,
  Apps20Regular, Filter20Regular, Form20Regular, Cursor20Regular, Edit20Regular,
  ArrowMaximize20Regular, Flash20Regular, Database20Regular, Code20Regular, Sparkle20Regular, ChevronRight16Regular, ChevronDown16Regular,
} from '@fluentui/react-icons';
import { LoomChart, type LoomChartType } from '@/lib/components/charts/loom-chart';
import { EmptyState } from '@/lib/components/empty-state';
import { SplitPane } from '@/lib/components/shared/split-pane';
import type { AtelierFilter, AtelierFilterOp } from '@/lib/editors/_family-utils';

// ───────────────────────── types (persisted in Cosmos item state) ─────────────────────────
// Defined in ./_workshop-model (plain module, no 'use client') so server-side
// consumers (the publish route, _palantir-codegen) can import them without a
// server→client layering inversion. Re-exported here to keep this file's
// public surface stable for existing importers (e.g. palantir-editors.tsx).

import type {
  WorkshopVarType, WorkshopVariable, WorkshopWidgetKind,
  WorkshopEventTrigger, WorkshopEventEffect, WorkshopAggFn, WorkshopEvent, WorkshopWidget,
} from './_workshop-model';
import { nestedWidgetIds } from './_workshop-model';
export type {
  WorkshopVarType, WorkshopVariable, WorkshopWidgetKind, WorkshopWidgetLayout,
  WorkshopEventTrigger, WorkshopEventEffect, WorkshopAggFn, WorkshopEvent, WorkshopWidget,
} from './_workshop-model';

interface RunResult {
  loading?: boolean;
  error?: string;
  gate?: { reason: string; remediation: string };
  columns?: string[];
  rows?: unknown[][];
  rowCount?: number;
}

/** Runtime value of a variable while Preview runs. */
type RuntimeVarValue = AtelierFilter[] | string;

// ───────────────────────── canvas geometry ─────────────────────────
const GRID = 16;
const CANVAS_MIN_W = 760;
const CANVAS_MIN_H = 540;
const HEADER_H = 34;
const snap = (v: number) => Math.max(0, Math.round(v / GRID) * GRID);

const DEFAULT_SIZE: Record<WorkshopWidgetKind, { w: number; h: number }> = {
  table: { w: 448, h: 288 },
  chart: { w: 400, h: 272 },
  metric: { w: 224, h: 144 },
  filter: { w: 288, h: 128 },
  form: { w: 384, h: 320 },
  button: { w: 224, h: 96 },
  text: { w: 336, h: 160 },
  image: { w: 336, h: 224 },
  link: { w: 224, h: 80 },
  divider: { w: 448, h: 48 },
  badge: { w: 224, h: 80 },
  iframe: { w: 448, h: 320 },
  heading: { w: 448, h: 80 },
  progress: { w: 336, h: 80 },
  spacer: { w: 224, h: 64 },
  timestamp: { w: 224, h: 64 },
  'kpi-row': { w: 448, h: 112 },
  gauge: { w: 288, h: 128 },
  callout: { w: 448, h: 96 },
  quote: { w: 400, h: 112 },
  rating: { w: 224, h: 80 },
  'tag-list': { w: 336, h: 80 },
  delta: { w: 224, h: 96 },
  checklist: { w: 336, h: 160 },
  avatar: { w: 224, h: 96 },
  'code-block': { w: 448, h: 160 },
  'key-value': { w: 336, h: 160 },
  countdown: { w: 224, h: 96 },
  'stat-pair': { w: 336, h: 112 },
  'mini-table': { w: 448, h: 176 },
  breadcrumb: { w: 448, h: 64 },
  'json-view': { w: 448, h: 176 },
  tabs: { w: 448, h: 192 },
  accordion: { w: 448, h: 192 },
  sparkline: { w: 224, h: 80 },
  'video-embed': { w: 448, h: 288 },
  'map-embed': { w: 448, h: 288 },
};

const KIND_META: Record<WorkshopWidgetKind, { label: string; icon: ReactElement; hint: string; data: boolean }> = {
  table: { label: 'Object Table', icon: <Table20Regular />, hint: 'Rows of an ontology object type, filtered by variables', data: true },
  chart: { label: 'Chart', icon: <DataUsage20Regular />, hint: 'Aggregate (GROUP BY) over an object type', data: true },
  metric: { label: 'Metric', icon: <NumberSymbol20Regular />, hint: 'A single aggregated KPI number', data: true },
  filter: { label: 'Filter', icon: <Filter20Regular />, hint: 'A control that writes an object-set-filter variable', data: true },
  form: { label: 'Form', icon: <Form20Regular />, hint: 'Create / update / delete an object — real write-back', data: true },
  button: { label: 'Button', icon: <Cursor20Regular />, hint: 'Fires events: set a variable, run an action, refresh', data: false },
  text: { label: 'Text', icon: <DocumentText20Regular />, hint: 'Markdown-lite label with {{variable}} interpolation', data: false },
  image: { label: 'Image', icon: <Apps20Regular />, hint: 'An https image by URL', data: false },
  link: { label: 'Link', icon: <ArrowMaximize20Regular />, hint: 'A styled link to an https URL', data: false },
  divider: { label: 'Divider', icon: <Edit20Regular />, hint: 'A horizontal section divider', data: false },
  badge: { label: 'Badge', icon: <Flash20Regular />, hint: 'A colored status badge with {{variable}} interpolation', data: false },
  iframe: { label: 'Embed', icon: <Code20Regular />, hint: 'Embed an https page (iframe)', data: false },
  heading: { label: 'Heading', icon: <DocumentText20Regular />, hint: 'A section heading (levels 1–3) with {{variable}} interpolation', data: false },
  progress: { label: 'Progress', icon: <DataUsage20Regular />, hint: 'A progress bar (0–100%), value supports {{variable}}', data: false },
  spacer: { label: 'Spacer', icon: <ArrowMaximize20Regular />, hint: 'Blank layout spacing', data: false },
  timestamp: { label: 'Timestamp', icon: <Flash20Regular />, hint: 'Shows when the page was last refreshed', data: false },
  'kpi-row': { label: 'KPI Row', icon: <NumberSymbol20Regular />, hint: 'A row of labeled KPI chips — values support {{variable}}', data: false },
  gauge: { label: 'Gauge', icon: <DataUsage20Regular />, hint: 'A value against a min–max range, colored by fill', data: false },
  callout: { label: 'Callout', icon: <Flash20Regular />, hint: 'A highlighted MessageBar note (info/success/warning/error)', data: false },
  quote: { label: 'Quote', icon: <DocumentText20Regular />, hint: 'A styled blockquote with {{variable}} interpolation', data: false },
  rating: { label: 'Rating', icon: <Sparkle20Regular />, hint: 'Star rating (value / max), value supports {{variable}}', data: false },
  'tag-list': { label: 'Tags', icon: <Filter20Regular />, hint: 'A wrapping row of tag badges', data: false },
  delta: { label: 'Delta', icon: <DataUsage20Regular />, hint: 'Current vs previous — signed change, colored by direction', data: false },
  checklist: { label: 'Checklist', icon: <Form20Regular />, hint: 'A static checklist — prefix a line with [x] to check it', data: false },
  avatar: { label: 'Avatar', icon: <Cursor20Regular />, hint: 'An initials avatar with name + caption', data: false },
  'code-block': { label: 'Code', icon: <Code20Regular />, hint: 'Monospace pre-formatted block', data: false },
  'key-value': { label: 'Key–Value', icon: <Table20Regular />, hint: 'Key: value lines with {{variable}} interpolation', data: false },
  countdown: { label: 'Countdown', icon: <Flash20Regular />, hint: 'Days remaining until a date', data: false },
  'stat-pair': { label: 'Stat Pair', icon: <NumberSymbol20Regular />, hint: 'Two labeled stats side by side, {{variable}} values', data: false },
  'mini-table': { label: 'Mini Table', icon: <Table20Regular />, hint: 'A small static table (CSV: first line headers)', data: false },
  breadcrumb: { label: 'Breadcrumb', icon: <ChevronRight16Regular />, hint: 'A navigation trail of segments', data: false },
  'json-view': { label: 'JSON', icon: <Code20Regular />, hint: 'Pretty-printed JSON block', data: false },
  tabs: { label: 'Tabs', icon: <Apps20Regular />, hint: 'A tab strip with per-tab text content (v1 — child widgets tracked)', data: false },
  accordion: { label: 'Accordion', icon: <ChevronDown16Regular />, hint: 'Collapsible titled sections', data: false },
  sparkline: { label: 'Sparkline', icon: <DataUsage20Regular />, hint: 'A tiny inline trend line from a number list', data: false },
  'video-embed': { label: 'Video', icon: <Play20Regular />, hint: 'Embed an https video player (sandboxed iframe)', data: false },
  'map-embed': { label: 'Map', icon: <ArrowMaximize20Regular />, hint: 'Embed an https map view (sandboxed iframe)', data: false },
};

const CHART_TYPES: LoomChartType[] = ['column', 'bar', 'line', 'area', 'pie', 'donut'];
const AGG_FNS: WorkshopAggFn[] = ['count', 'sum', 'avg', 'min', 'max'];
const FILTER_OPS: AtelierFilterOp[] = ['eq', 'ne', 'gt', 'lt', 'gte', 'lte', 'contains', 'startsWith'];
const FILTER_OP_LABEL: Record<AtelierFilterOp, string> = {
  eq: 'equals', ne: 'not equals', gt: 'greater than', lt: 'less than',
  gte: '≥', lte: '≤', contains: 'contains', startsWith: 'starts with',
};
const VAR_TYPE_LABEL: Record<WorkshopVarType, string> = {
  'object-set-filter': 'Object-set filter', string: 'String', number: 'Number', boolean: 'Boolean', date: 'Date',
};

// ───────────────────────── data helpers ─────────────────────────

interface RunActionBody {
  entityType: string;
  op: 'list' | 'get' | 'aggregate' | 'distinct' | 'create' | 'update' | 'delete';
  top?: number;
  key?: string;
  keyColumn?: string;
  values?: Record<string, string>;
  filters?: AtelierFilter[];
  groupBy?: string;
  aggFn?: WorkshopAggFn;
  aggColumn?: string;
  column?: string;
}

async function runAction(id: string, body: RunActionBody): Promise<RunResult & { recordsAffected?: number }> {
  try {
    const r = await clientFetch(`/api/items/workshop-app/${encodeURIComponent(id)}/run-action`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (!j?.ok) return { error: j?.error || `HTTP ${r.status}`, gate: j?.gate };
    return { columns: j.columns || [], rows: j.rows || [], rowCount: j.rowCount ?? (j.rows?.length || 0), recordsAffected: j.recordsAffected };
  } catch (e: any) {
    return { error: e?.message || String(e) };
  }
}

/** Collect the parameterised filter predicates a data widget should apply. */
function collectFilters(widget: WorkshopWidget, variables: WorkshopVariable[], runtime: Record<string, RuntimeVarValue>): AtelierFilter[] {
  const out: AtelierFilter[] = [];
  for (const vid of widget.appliesVariableIds || []) {
    const v = variables.find((x) => x.id === vid);
    if (!v || v.type !== 'object-set-filter') continue;
    if (v.entityType && widget.entityType && v.entityType !== widget.entityType) continue;
    const rv = runtime[vid];
    if (Array.isArray(rv)) out.push(...rv);
  }
  return out;
}

function toRecords(columns: string[], rows: unknown[][]): Array<Record<string, unknown>> {
  return rows.map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i]])));
}

function fmtMetric(v: number): string {
  if (!Number.isFinite(v)) return '—';
  if (Math.abs(v) >= 1_000_000) return (v / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 1 }) + 'M';
  if (Math.abs(v) >= 1_000) return (v / 1_000).toLocaleString(undefined, { maximumFractionDigits: 1 }) + 'K';
  return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

/**
 * Tabs widget — tab strip + per-tab text content + nested child widgets.
 * In Run mode each tab renders its nested children's FULL live bodies (real
 * reads / filters / buttons via renderChild); in Design mode nested children
 * stay editable on the canvas, so the tab pane shows their names as chips.
 */
function TabsWidget({ items, variables, runtime, childIdsPerTab, renderChild, childLabel }: {
  items: string; variables: WorkshopVariable[]; runtime: Record<string, RuntimeVarValue>;
  childIdsPerTab?: string[][];
  /** Run mode: renders a nested child's live WidgetBody (null = child gone). */
  renderChild?: (wid: string) => ReactNode;
  /** Design mode: resolves a nested child's display name (null = child gone). */
  childLabel?: (wid: string) => string | null;
}) {
  const entries = items.split('|').map((p) => p.trim()).filter(Boolean).map((p) => { const i = p.indexOf(':'); return i < 0 ? { t: p, b: '' } : { t: p.slice(0, i).trim(), b: p.slice(i + 1).trim() }; });
  const [active, setActive] = useState(0);
  if (!entries.length) return <Caption1>Add "Title: content | Title: content" entries in the inspector.</Caption1>;
  const idx = Math.min(active, entries.length - 1);
  const cur = entries[idx];
  const childIds = (childIdsPerTab?.[idx] || []).filter(Boolean);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, minWidth: 0 }}>
      <TabList selectedValue={String(idx)} onTabSelect={(_, d) => setActive(Number(d.value))}>
        {entries.map((e, i) => <Tab key={i} value={String(i)}>{e.t}</Tab>)}
      </TabList>
      {cur.b !== '' && <Body1>{renderText(cur.b, variables, runtime)}</Body1>}
      {childIds.length > 0 && renderChild && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, minWidth: 0 }}>
          {childIds.map((cid) => <div key={cid} style={{ minWidth: 0 }}>{renderChild(cid)}</div>)}
        </div>
      )}
      {childIds.length > 0 && !renderChild && childLabel && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalXS, minWidth: 0 }}>
          {childIds.map((cid) => { const t = childLabel(cid); return t === null ? null : <Badge key={cid} appearance="outline">{t}</Badge>; })}
        </div>
      )}
    </div>
  );
}

/** Render markdown-lite with {{variable}} interpolation from current runtime values. */
function renderText(text: string, variables: WorkshopVariable[], runtime: Record<string, RuntimeVarValue>): ReactNode {
  const resolve = (name: string): string => {
    const v = variables.find((x) => x.name === name.trim());
    if (!v) return `{{${name}}}`;
    const rv = runtime[v.id];
    if (Array.isArray(rv)) return rv.map((p) => `${p.column} ${p.op} ${p.value}`).join(', ') || '(no filter)';
    if (typeof rv === 'string') return rv;
    return v.defaultValue ?? '';
  };
  const interpolated = (text || '').replace(/\{\{([^}]+)\}\}/g, (_, n) => resolve(String(n)));
  const lines = interpolated.split('\n');
  const out: ReactNode[] = [];
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^#{1,3}\s/.test(line)) { const t = line.replace(/^#+\s/, ''); out.push(<Subtitle2 key={out.length} block>{t}</Subtitle2>); }
    else if (/^[-*]\s/.test(line)) out.push(<Body1 key={out.length} block>• {line.replace(/^[-*]\s/, '')}</Body1>);
    else if (line === '') out.push(<div key={out.length} style={{ height: tokens.spacingVerticalXS }} />);
    else out.push(<Body1 key={out.length} block>{line}</Body1>);
  }
  return out;
}

// ───────────────────────── styles ─────────────────────────

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: 0 },
  hrDivider: { border: 'none', borderTop: `1px solid ${tokens.colorNeutralStroke2}`, width: '100%' },
  quoteBlock: { margin: '0', paddingLeft: tokens.spacingHorizontalM, borderLeft: `3px solid ${tokens.colorBrandStroke1}`, color: tokens.colorNeutralForeground2, fontStyle: 'italic' },
  miniTh: { textAlign: 'left', padding: tokens.spacingVerticalXS, borderBottom: `1px solid ${tokens.colorNeutralStroke2}` },
  miniTd: { padding: tokens.spacingVerticalXS, borderBottom: `1px solid ${tokens.colorNeutralStroke3}` },
  avatarCircle: { width: '40px', height: '40px', borderRadius: '50%', backgroundColor: tokens.colorBrandBackground, color: tokens.colorNeutralForegroundOnBrand, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
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
  designGridSel: {
    display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(300px, 340px)', gap: tokens.spacingHorizontalM, minWidth: 0,
    '@media (max-width: 1100px)': { gridTemplateColumns: 'minmax(0, 1fr)' },
  },
  palette: { display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', alignItems: 'center' },
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
    padding: `0 ${tokens.spacingHorizontalS}`, userSelect: 'none',
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    background: `linear-gradient(135deg, ${tokens.colorBrandBackground2}, ${tokens.colorNeutralBackground1})`,
  },
  widgetHeaderDrag: { cursor: 'move' },
  widgetTitle: { flex: 1, minWidth: 0, fontWeight: tokens.fontWeightSemibold, fontSize: tokens.fontSizeBase200, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  widgetBody: { flex: 1, minHeight: 0, overflow: 'auto', padding: tokens.spacingHorizontalS },
  resizeHandle: {
    position: 'absolute', right: 0, bottom: 0, width: '16px', height: '16px', cursor: 'nwse-resize',
    background: `linear-gradient(135deg, transparent 50%, ${tokens.colorNeutralStroke1} 50%)`,
    borderBottomRightRadius: tokens.borderRadiusMedium,
  },
  metricBig: { fontSize: '34px', fontWeight: tokens.fontWeightBold, color: tokens.colorBrandForeground1, lineHeight: '1.1' },
  metricWrap: { display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'flex-start', gap: tokens.spacingVerticalXXS, height: '100%' },
  inspector: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: 0,
    padding: tokens.spacingVerticalL, borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`, backgroundColor: tokens.colorNeutralBackground2, height: 'fit-content',
  },
  varRow: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', minWidth: 0,
    padding: tokens.spacingVerticalS, borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`, backgroundColor: tokens.colorNeutralBackground1,
  },
  eventRow: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, minWidth: 0,
    padding: tokens.spacingVerticalS, borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`, backgroundColor: tokens.colorNeutralBackground1,
  },
  tableWrap: { overflow: 'auto', minWidth: 0, borderRadius: tokens.borderRadiusMedium, border: `1px solid ${tokens.colorNeutralStroke2}` },
  selRow: { cursor: 'pointer' },
  selRowActive: { backgroundColor: tokens.colorBrandBackground2 },
  empty: {
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: tokens.spacingHorizontalS,
    padding: tokens.spacingVerticalL, color: tokens.colorNeutralForeground3, textAlign: 'center', height: '100%',
    borderRadius: tokens.borderRadiusMedium, border: `1px dashed ${tokens.colorNeutralStroke2}`, backgroundColor: tokens.colorNeutralBackground2,
  },
  dialogForm: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: 'min(480px, 100%)', maxWidth: '100%' },
  formScroll: { maxHeight: '46vh', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, paddingRight: tokens.spacingHorizontalXS },
  inlineForm: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, minWidth: 0 },
  btnWrap: { display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' },
  fVarName: { minWidth: '140px' },
  fVarType: { minWidth: '160px' },
  eventCol: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, minWidth: 0 },
  eventTop: { display: 'flex', gap: tokens.spacingHorizontalXS, alignItems: 'center', flexWrap: 'wrap' },
});

// ───────────────────────── columns discovery (cached) ─────────────────────────

function useEntityColumns(id: string) {
  const [colsByEntity, setCols] = useState<Record<string, string[]>>({});
  const inflight = useRef<Set<string>>(new Set());
  const ensure = useCallback(async (entityType?: string) => {
    if (!entityType || colsByEntity[entityType] || inflight.current.has(entityType)) return;
    inflight.current.add(entityType);
    const res = await runAction(id, { entityType, op: 'list', top: 1 });
    if (res.columns && res.columns.length) setCols((p) => ({ ...p, [entityType]: res.columns! }));
    inflight.current.delete(entityType);
  }, [id, colsByEntity]);
  return { colsByEntity, ensure };
}

// ───────────────────────── result table (with optional row-select) ─────────────────────────

function ResultTable({
  columns, rows, pageSize = 8, selectable, selectedRow, onSelectRow,
}: {
  columns: string[]; rows: unknown[][]; pageSize?: number;
  selectable?: boolean; selectedRow?: number | null; onSelectRow?: (index: number, row: unknown[]) => void;
}) {
  const s = useStyles();
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  const clamped = Math.min(page, pages - 1);
  const slice = rows.slice(clamped * pageSize, clamped * pageSize + pageSize);
  if (columns.length === 0) return <div className={s.empty}><Caption1>No columns returned.</Caption1></div>;
  return (
    <>
      <div className={s.tableWrap}>
        <Table size="small" aria-label="Object rows">
          <TableHeader><TableRow>{columns.map((c) => <TableHeaderCell key={c}>{c}</TableHeaderCell>)}</TableRow></TableHeader>
          <TableBody>
            {slice.map((row, ri) => {
              const absIndex = clamped * pageSize + ri;
              return (
                <TableRow key={absIndex}
                  className={selectable ? mergeClasses(s.selRow, selectedRow === absIndex && s.selRowActive) : undefined}
                  onClick={selectable && onSelectRow ? () => onSelectRow(absIndex, row) : undefined}>
                  {columns.map((_, ci) => <TableCell key={ci}>{row[ci] === null || row[ci] === undefined ? '' : String(row[ci])}</TableCell>)}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
      {rows.length > pageSize && (
        <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, paddingTop: tokens.spacingVerticalXS }}>
          <Button size="small" appearance="subtle" disabled={clamped === 0} onClick={() => setPage(clamped - 1)}>Prev</Button>
          <Caption1 className={s.hint}>Page {clamped + 1} / {pages} · {rows.length} rows</Caption1>
          <Button size="small" appearance="subtle" disabled={clamped >= pages - 1} onClick={() => setPage(clamped + 1)}>Next</Button>
        </div>
      )}
    </>
  );
}

// ───────────────────────── inline CRUD form (Form widget + button run-action) ─────────────────────────

function CrudForm({
  id, entityType, kind, columns, onDone,
}: {
  id: string; entityType: string; kind: 'create' | 'update' | 'delete'; columns: string[];
  onDone?: (recordsAffected: number) => void;
}) {
  const s = useStyles();
  const [values, setValues] = useState<Record<string, string>>({});
  const [keyColumn, setKeyColumn] = useState('');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ intent: 'success' | 'error' | 'warning'; text: string } | null>(null);

  const submit = useCallback(async () => {
    setBusy(true); setMsg(null);
    const body: RunActionBody = { entityType, op: kind };
    if (kind === 'create' || kind === 'update') {
      const vals: Record<string, string> = {};
      for (const [k, v] of Object.entries(values)) if (v !== '') vals[k] = v;
      body.values = vals;
    }
    if (kind === 'update' || kind === 'delete') { if (keyColumn.trim()) body.keyColumn = keyColumn.trim(); body.key = key; }
    const res = await runAction(id, body);
    setBusy(false);
    if (res.error) { setMsg({ intent: res.gate ? 'warning' : 'error', text: res.gate ? `${res.gate.reason} ${res.gate.remediation}` : res.error }); return; }
    setMsg({ intent: 'success', text: `${kind} succeeded — ${res.recordsAffected ?? 0} row(s) affected.` });
    if (kind === 'create') setValues({});
    onDone?.(res.recordsAffected ?? 0);
  }, [id, entityType, kind, values, keyColumn, key, onDone]);

  return (
    <div className={s.inlineForm}>
      {kind === 'delete' && (
        <MessageBar intent="warning"><MessageBarBody>Deletes a row from <strong>{entityType}</strong> by key. Writes to the bound Synapse warehouse and cannot be undone.</MessageBarBody></MessageBar>
      )}
      {(kind === 'update' || kind === 'delete') && (
        <>
          <Field label="Key column" hint="Primary-key column to match (or set keyColumns on the ontology binding).">
            <Input value={keyColumn} onChange={(_, d) => setKeyColumn(d.value)} placeholder="Id" />
          </Field>
          <Field label="Key value"><Input value={key} onChange={(_, d) => setKey(d.value)} placeholder="42" /></Field>
        </>
      )}
      {(kind === 'create' || kind === 'update') && (
        columns.length === 0
          ? <Caption1 className={s.hint}>No columns discovered yet — ensure a Warehouse table is mapped to {entityType} on the ontology.</Caption1>
          : (
            <div className={s.formScroll}>
              {columns.map((col) => (
                <Field key={col} label={col}>
                  <Input value={values[col] ?? ''} onChange={(_, d) => setValues((p) => ({ ...p, [col]: d.value }))} placeholder={`${col} value`} />
                </Field>
              ))}
            </div>
          )
      )}
      <Button appearance="primary" icon={busy ? <Spinner size="tiny" /> : <Flash20Regular />} disabled={busy} onClick={submit}>
        {busy ? 'Running…' : `Run ${kind}`}
      </Button>
      {msg && <MessageBar intent={msg.intent}><MessageBarBody>{msg.text}</MessageBarBody></MessageBar>}
    </div>
  );
}

// ───────────────────────── filter control (Preview) ─────────────────────────

function FilterControl({
  id, widget, value, onChange,
}: {
  id: string; widget: WorkshopWidget; value: string; onChange: (v: string) => void;
}) {
  const s = useStyles();
  const [options, setOptions] = useState<string[] | null>(null);
  const wantDropdown = (widget.filterControl || 'dropdown') === 'dropdown';
  useEffect(() => {
    if (!wantDropdown || !widget.entityType || !widget.filterColumn) return;
    let cancelled = false;
    (async () => {
      const res = await runAction(id, { entityType: widget.entityType!, op: 'distinct', column: widget.filterColumn!, top: 200 });
      if (cancelled) return;
      if (res.rows) setOptions(res.rows.map((r) => (r[0] === null || r[0] === undefined ? '' : String(r[0]))).filter((v) => v !== ''));
      else setOptions([]);
    })();
    return () => { cancelled = true; };
  }, [id, wantDropdown, widget.entityType, widget.filterColumn]);

  if (!widget.entityType || !widget.filterColumn) return <div className={s.empty}><Caption1>Set object type + column in the inspector.</Caption1></div>;
  return (
    <Field label={`${widget.filterColumn} ${FILTER_OP_LABEL[widget.filterOp || 'eq']}`}>
      {wantDropdown && options
        ? (
          <Dropdown value={value} selectedOptions={value ? [value] : []} placeholder="Any" onOptionSelect={(_, d) => onChange(d.optionValue === '__any__' ? '' : (d.optionValue || ''))}>
            <Option value="__any__" text="Any">Any</Option>
            {options.map((o) => <Option key={o} value={o}>{o}</Option>)}
          </Dropdown>
        )
        : <Input value={value} onChange={(_, d) => onChange(d.value)} placeholder="Filter value" />}
    </Field>
  );
}

// ───────────────────────── widget body renderer ─────────────────────────

function WidgetBody({
  id, widget, variables, runtime, result, readOnly, height,
  selectedRow, onSelectRow, onClickButton, setFilterValue, filterValue, columnsForEntity,
  renderNested, nestedLabel,
}: {
  id: string; widget: WorkshopWidget; variables: WorkshopVariable[]; runtime: Record<string, RuntimeVarValue>;
  result?: RunResult; readOnly: boolean; height: number;
  selectedRow: number | null; onSelectRow: (index: number, row: unknown[]) => void;
  onClickButton: () => void; setFilterValue: (v: string) => void; filterValue: string; columnsForEntity: string[];
  /** tabs nesting — Run mode renders a nested child's live body inside its tab pane. */
  renderNested?: (wid: string) => ReactNode;
  /** tabs nesting — Design mode shows nested child names as chips. */
  nestedLabel?: (wid: string) => string | null;
}) {
  const s = useStyles();

  if (widget.kind === 'text') {
    return <div>{renderText(widget.text || '_Empty text widget — set its content in the inspector._', variables, runtime)}</div>;
  }

  if (widget.kind === 'tabs') {
    return (
      <TabsWidget items={String(widget.tabItems || '')} variables={variables} runtime={runtime}
        childIdsPerTab={widget.tabChildIds}
        renderChild={readOnly ? renderNested : undefined}
        childLabel={nestedLabel} />
    );
  }
  if (widget.kind === 'accordion') {
    const sections = String(widget.accordionItems || '').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { const i = l.indexOf(':'); return i < 0 ? { t: l, b: '' } : { t: l.slice(0, i).trim(), b: l.slice(i + 1).trim() }; });
    if (!sections.length) return <Caption1 className={s.hint}>Add "Title: body" lines in the inspector.</Caption1>;
    return (
      <Accordion multiple collapsible>
        {sections.map((sec, i) => (
          <AccordionItem key={i} value={String(i)}>
            <AccordionHeader>{sec.t}</AccordionHeader>
            <AccordionPanel><Body1>{renderText(sec.b, variables, runtime)}</Body1></AccordionPanel>
          </AccordionItem>
        ))}
      </Accordion>
    );
  }
  if (widget.kind === 'sparkline') {
    const nums = String(widget.sparkValues || '').split(',').map((x) => Number(x.trim())).filter((n) => Number.isFinite(n));
    if (nums.length < 2) return <Caption1 className={s.hint}>Add a comma list of numbers in the inspector.</Caption1>;
    const min = Math.min(...nums); const max = Math.max(...nums); const span = max - min || 1;
    const W = 200; const H = 40;
    const pts = nums.map((n, i) => `${(i / (nums.length - 1)) * W},${H - ((n - min) / span) * H}`).join(' ');
    return (
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', maxHeight: '48px' }} aria-label="Sparkline">
        <polyline points={pts} fill="none" stroke={tokens.colorBrandStroke1} strokeWidth="2" />
      </svg>
    );
  }
  if (widget.kind === 'video-embed' || widget.kind === 'map-embed') {
    const src = (widget.embedUrl || '').trim();
    if (!/^https:\/\//i.test(src)) return <Caption1 className={s.hint}>Set an https embed URL in the inspector.</Caption1>;
    return <iframe src={src} title={widget.title} style={{ width: '100%', height: '100%', border: 'none' }} sandbox="allow-scripts allow-same-origin allow-presentation" allowFullScreen />;
  }
  if (widget.kind === 'stat-pair') {
    const parse = (v: string | undefined) => { const [l, ...r] = String(v || '').split('='); return { l: (l || '').trim(), v: String(renderText(r.join('='), variables, runtime)) }; };
    const a = parse(widget.statLeft); const b = parse(widget.statRight);
    return (
      <div style={{ display: 'flex', gap: tokens.spacingHorizontalL }}>
        {[a, b].map((x, i) => <div key={i}><Caption1 block>{x.l || '—'}</Caption1><Subtitle2>{x.v}</Subtitle2></div>)}
      </div>
    );
  }
  if (widget.kind === 'mini-table') {
    const lines = String(widget.miniTable || '').split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length < 2) return <Caption1 className={s.hint}>First line = headers, following lines = rows (comma-separated).</Caption1>;
    const heads = lines[0].split(',').map((h) => h.trim());
    const rows = lines.slice(1).map((l) => l.split(',').map((c) => c.trim()));
    return (
      <table style={{ borderCollapse: 'collapse', width: '100%' }}>
        <thead><tr>{heads.map((h, i) => <th key={i} className={s.miniTh}><Caption1>{h}</Caption1></th>)}</tr></thead>
        <tbody>{rows.map((r, ri) => <tr key={ri}>{heads.map((_, ci) => <td key={ci} className={s.miniTd}><Caption1>{r[ci] ?? ''}</Caption1></td>)}</tr>)}</tbody>
      </table>
    );
  }
  if (widget.kind === 'breadcrumb') {
    const crumbs = String(widget.crumbs || '').split(',').map((c) => c.trim()).filter(Boolean);
    if (!crumbs.length) return <Caption1 className={s.hint}>Add comma-separated segments in the inspector.</Caption1>;
    return <Caption1>{crumbs.join(' › ')}</Caption1>;
  }
  if (widget.kind === 'json-view') {
    let pretty = String(widget.json || '');
    try { pretty = JSON.stringify(JSON.parse(pretty), null, 2); } catch { /* show raw */ }
    return <pre style={{ margin: '0', padding: tokens.spacingVerticalS, borderRadius: tokens.borderRadiusMedium, backgroundColor: tokens.colorNeutralBackground3, fontFamily: 'Consolas, monospace', fontSize: tokens.fontSizeBase200, overflowX: 'auto' }}>{pretty || '{}'}</pre>;
  }
  if (widget.kind === 'avatar') {
    const name = String(renderText(widget.avatarName || widget.title, variables, runtime));
    const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase() || '').join('') || '?';
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS }}>
        <div className={s.avatarCircle}>
          <Subtitle2>{initials}</Subtitle2>
        </div>
        <div><Body1 block>{name}</Body1>{widget.avatarCaption && <Caption1>{widget.avatarCaption}</Caption1>}</div>
      </div>
    );
  }
  if (widget.kind === 'code-block') {
    return <pre style={{ margin: '0', padding: tokens.spacingVerticalS, borderRadius: tokens.borderRadiusMedium, backgroundColor: tokens.colorNeutralBackground3, fontFamily: 'Consolas, monospace', fontSize: tokens.fontSizeBase200, overflowX: 'auto' }}>{widget.code || '// code'}</pre>;
  }
  if (widget.kind === 'key-value') {
    const rows = String(widget.keyValues || '').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { const i = l.indexOf(':'); return i < 0 ? { k: l, v: '' } : { k: l.slice(0, i).trim(), v: String(renderText(l.slice(i + 1).trim(), variables, runtime)) }; });
    if (!rows.length) return <Caption1 className={s.hint}>Add "Key: value" lines in the inspector.</Caption1>;
    return (
      <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: tokens.spacingHorizontalM, rowGap: tokens.spacingVerticalXS }}>
        {rows.map((r, i) => (<><Caption1 key={`k${i}`}>{r.k}</Caption1><Body1 key={`v${i}`}>{r.v}</Body1></>))}
      </div>
    );
  }
  if (widget.kind === 'countdown') {
    const target = new Date(String(widget.countdownTo || ''));
    if (isNaN(target.getTime())) return <Caption1 className={s.hint}>Set a target date (yyyy-mm-dd) in the inspector.</Caption1>;
    const days = Math.ceil((target.getTime() - Date.now()) / 86_400_000);
    return <div><Subtitle2>{Math.abs(days)} day{Math.abs(days) === 1 ? '' : 's'}</Subtitle2><Caption1>{days >= 0 ? 'until' : 'since'} {target.toLocaleDateString()}</Caption1></div>;
  }
  if (widget.kind === 'rating') {
    const num = (v: string | undefined, d: number) => { const n = Number(String(renderText(String(v ?? ''), variables, runtime)).replace(/[^0-9.]/g, '')); return Number.isFinite(n) && String(v ?? '') !== '' ? n : d; };
    const max = Math.max(1, Math.min(10, Math.round(num(widget.ratingMax, 5))));
    const val = Math.max(0, Math.min(max, num(widget.ratingValue, 0)));
    return <Subtitle2 aria-label={`${val} of ${max}`}>{'★'.repeat(Math.round(val))}{'☆'.repeat(max - Math.round(val))} <Caption1>{val}/{max}</Caption1></Subtitle2>;
  }
  if (widget.kind === 'tag-list') {
    const tags = String(widget.tags || '').split(',').map((t) => t.trim()).filter(Boolean);
    if (!tags.length) return <Caption1 className={s.hint}>Add comma-separated tags in the inspector.</Caption1>;
    return <div style={{ display: 'flex', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap' }}>{tags.map((t, i) => <Badge key={i} appearance="tint">{t}</Badge>)}</div>;
  }
  if (widget.kind === 'delta') {
    const num = (v: string | undefined) => { const n = Number(String(renderText(String(v ?? ''), variables, runtime)).replace(/[^0-9.-]/g, '')); return Number.isFinite(n) ? n : 0; };
    const cur = num(widget.deltaValue); const prev = num(widget.deltaPrevious);
    const diff = cur - prev; const pct = prev !== 0 ? (diff / Math.abs(prev)) * 100 : 0;
    const up = diff >= 0;
    return (
      <div>
        <Subtitle2>{cur.toLocaleString()}</Subtitle2>
        <Caption1 style={{ color: up ? tokens.colorPaletteGreenForeground1 : tokens.colorPaletteRedForeground1 }}>
          {up ? '▲' : '▼'} {Math.abs(diff).toLocaleString()} ({Math.abs(pct).toFixed(1)}%)
        </Caption1>
      </div>
    );
  }
  if (widget.kind === 'checklist') {
    const lines = String(widget.checklistItems || '').split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return <Caption1 className={s.hint}>Add one item per line; prefix with [x] to check.</Caption1>;
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS }}>
        {lines.map((l, i) => { const done = /^\[x\]/i.test(l); const label = l.replace(/^\[[x ]?\]\s*/i, ''); return (
          <Caption1 key={i} style={done ? { textDecoration: 'line-through', color: tokens.colorNeutralForeground3 } : undefined}>{done ? '☑' : '☐'} {label}</Caption1>
        ); })}
      </div>
    );
  }
  if (widget.kind === 'kpi-row') {
    const items = String(widget.kpiItems || '').split(',').map((p) => p.trim()).filter(Boolean).map((p) => {
      const [label, ...rest] = p.split('=');
      const val = renderText(rest.join('=') || '', variables, runtime);
      return { label: (label || '').trim(), val };
    });
    if (!items.length) return <Caption1 className={s.hint}>Add KPI items in the inspector — e.g. Orders=42, Revenue={'{{revenue}}'}.</Caption1>;
    return (
      <div style={{ display: 'flex', gap: tokens.spacingHorizontalM, flexWrap: 'wrap' }}>
        {items.map((it, i) => (
          <div key={i} style={{ padding: tokens.spacingVerticalS, borderRadius: tokens.borderRadiusMedium, backgroundColor: tokens.colorNeutralBackground3, minWidth: 0 }}>
            <Caption1 block>{it.label}</Caption1>
            <Subtitle2>{it.val}</Subtitle2>
          </div>
        ))}
      </div>
    );
  }
  if (widget.kind === 'gauge') {
    const num = (v: string | undefined, d: number) => { const n = Number(String(renderText(String(v ?? ''), variables, runtime)).replace(/[^0-9.-]/g, '')); return Number.isFinite(n) && String(v ?? '') !== '' ? n : d; };
    const min = num(widget.gaugeMin, 0); const max = num(widget.gaugeMax, 100); const val = num(widget.gaugeValue, 0);
    const pct = max > min ? Math.max(0, Math.min(100, ((val - min) / (max - min)) * 100)) : 0;
    return (
      <div style={{ width: '100%' }}>
        <Subtitle2>{val}</Subtitle2>
        <div style={{ height: tokens.spacingVerticalS, borderRadius: tokens.borderRadiusMedium, backgroundColor: tokens.colorNeutralBackground5, overflow: 'hidden' }}>
          <div style={{ width: `${pct}%`, height: '100%', backgroundColor: pct > 80 ? tokens.colorPaletteRedBackground3 : pct > 60 ? tokens.colorPaletteMarigoldBackground3 : tokens.colorBrandBackground }} />
        </div>
        <Caption1>{min} – {max}</Caption1>
      </div>
    );
  }
  if (widget.kind === 'callout') {
    return <MessageBar intent={widget.calloutIntent || 'info'}><MessageBarBody>{renderText(widget.text || widget.title, variables, runtime)}</MessageBarBody></MessageBar>;
  }
  if (widget.kind === 'quote') {
    return <blockquote className={s.quoteBlock}>{renderText(widget.text || widget.title, variables, runtime)}</blockquote>;
  }
  if (widget.kind === 'heading') {
    const lvl = widget.headingLevel || 2;
    const txt = renderText(widget.text || widget.title, variables, runtime);
    return lvl === 1 ? <Title3>{txt}</Title3> : lvl === 2 ? <Subtitle2>{txt}</Subtitle2> : <Body1><strong>{txt}</strong></Body1>;
  }
  if (widget.kind === 'progress') {
    const raw = String(widget.progressValue ?? '0');
    // resolve {{variable}} then coerce; clamp 0..100.
    const resolved = typeof renderText(raw, variables, runtime) === 'string' ? String(renderText(raw, variables, runtime)) : raw;
    const pct = Math.max(0, Math.min(100, Number(resolved.replace(/[^0-9.]/g, '')) || 0));
    return (
      <div style={{ width: '100%' }}>
        <div style={{ height: tokens.spacingVerticalS, borderRadius: tokens.borderRadiusMedium, backgroundColor: tokens.colorNeutralBackground5, overflow: 'hidden' }}>
          <div style={{ width: `${pct}%`, height: '100%', backgroundColor: tokens.colorBrandBackground }} />
        </div>
        <Caption1>{pct}%</Caption1>
      </div>
    );
  }
  if (widget.kind === 'spacer') {
    return <div aria-hidden="true" />;
  }
  if (widget.kind === 'timestamp') {
    return <Caption1>Last refreshed {new Date().toLocaleString()}</Caption1>;
  }
  if (widget.kind === 'divider') {
    return <hr className={s.hrDivider} aria-label="Divider" />;
  }
  if (widget.kind === 'badge') {
    return <Badge appearance="filled" color={widget.badgeColor || 'brand'}>{renderText(widget.text || widget.title, variables, runtime)}</Badge>;
  }
  if (widget.kind === 'image') {
    const src = (widget.src || '').trim();
    if (!/^https:\/\//i.test(src)) return <Caption1 className={s.hint}>Set an https image URL in the inspector.</Caption1>;
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={src} alt={widget.title} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />;
  }
  if (widget.kind === 'link') {
    const href = (widget.href || '').trim();
    if (!/^https:\/\//i.test(href)) return <Caption1 className={s.hint}>Set an https link URL in the inspector.</Caption1>;
    return <a href={href} target="_blank" rel="noreferrer noopener" style={{ color: tokens.colorBrandForeground1 }}>{widget.text?.trim() || widget.title}</a>;
  }
  if (widget.kind === 'iframe') {
    const src = (widget.src || '').trim();
    if (!/^https:\/\//i.test(src)) return <Caption1 className={s.hint}>Set an https embed URL in the inspector.</Caption1>;
    return <iframe src={src} title={widget.title} style={{ width: '100%', height: '100%', border: 'none' }} sandbox="allow-scripts allow-same-origin" />;
  }

  if (widget.kind === 'button') {
    const evs = widget.events || [];
    return (
      <div className={s.btnWrap}>
        <Button appearance="primary" icon={<Cursor20Regular />} disabled={!readOnly} onClick={readOnly ? onClickButton : undefined}
          title={readOnly ? 'Run this button\'s events' : 'Switch to Preview to run'}>
          {widget.title}
        </Button>
        {!readOnly && <Caption1 className={s.hint} style={{ marginLeft: tokens.spacingHorizontalS }}>{evs.length} event{evs.length === 1 ? '' : 's'}</Caption1>}
      </div>
    );
  }

  if (widget.kind === 'filter') {
    return <FilterControl id={id} widget={widget} value={filterValue} onChange={setFilterValue} />;
  }

  if (widget.kind === 'form') {
    if (!widget.entityType) return <div className={s.empty}><Caption1>Pick an object type in the inspector.</Caption1></div>;
    return <CrudForm id={id} entityType={widget.entityType} kind={widget.formKind || 'create'} columns={columnsForEntity} onDone={() => onClickButton()} />;
  }

  // Data widgets (table / chart / metric)
  if (!widget.entityType) return <div className={s.empty}><Caption1>Pick an object type in the inspector.</Caption1></div>;
  if (result?.loading) return <div className={s.empty}><Spinner size="tiny" label="Reading…" labelPosition="after" /></div>;
  if (result?.gate) return <MessageBar intent="warning"><MessageBarBody><MessageBarTitle>Configure backend</MessageBarTitle>{result.gate.reason} {result.gate.remediation}</MessageBarBody></MessageBar>;
  if (result?.error) return <MessageBar intent="error"><MessageBarBody>{result.error}</MessageBarBody></MessageBar>;
  if (!result || !result.columns) return <div className={s.empty}><Caption1>{readOnly ? 'Loading…' : 'Switch to Preview to load real data.'}</Caption1></div>;

  const columns = result.columns, rows = result.rows || [];
  if (widget.kind === 'metric') {
    const v = Number(rows[0]?.[0]);
    return (
      <div className={s.metricWrap}>
        <span className={s.metricBig}>{fmtMetric(v)}</span>
        <Caption1 className={s.hint}>{(widget.metricFn || 'count')}{widget.metricColumn ? ` · ${widget.metricColumn}` : ' of rows'} · {widget.entityType}</Caption1>
      </div>
    );
  }
  if (widget.kind === 'chart') {
    if (rows.length === 0) return <div className={s.empty}><Caption1>No rows.</Caption1></div>;
    return <LoomChart type={widget.chartType || 'column'} rows={toRecords(columns, rows)} height={Math.max(120, height - HEADER_H - 28)} />;
  }
  // table
  if (rows.length === 0) return <div className={s.empty}><Caption1>No rows{(widget.appliesVariableIds?.length ? ' match the active filters.' : '.')}</Caption1></div>;
  const selectable = readOnly && (widget.events || []).some((e) => e.trigger === 'row-select');
  return <ResultTable columns={columns} rows={rows} selectable={selectable} selectedRow={selectedRow} onSelectRow={onSelectRow} />;
}

// ───────────────────────── canvas widget (drag + resize) ─────────────────────────

function CanvasWidget({
  widget, selected, readOnly, onSelect, onMove, onResize, onRemove, children,
}: {
  widget: WorkshopWidget; selected: boolean; readOnly: boolean;
  onSelect: () => void; onMove: (x: number, y: number) => void; onResize: (w: number, h: number) => void; onRemove: () => void;
  children: ReactNode;
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
      <div className={mergeClasses(s.widgetHeader, !readOnly && s.widgetHeaderDrag)} onPointerDown={readOnly ? undefined : startDrag}>
        <span style={{ display: 'flex', color: tokens.colorBrandForeground1 }}>{KIND_META[widget.kind].icon}</span>
        <span className={s.widgetTitle} title={widget.title}>{widget.title}</span>
        {!readOnly && (
          <Tooltip content="Remove widget" relationship="label">
            <Button size="small" appearance="subtle" icon={<Dismiss16Regular />} aria-label={`Remove ${widget.title}`}
              onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); onRemove(); }} />
          </Tooltip>
        )}
      </div>
      <div className={s.widgetBody}>{children}</div>
      {!readOnly && <div className={s.resizeHandle} onPointerDown={startResize} aria-hidden />}
    </div>
  );
}

// ───────────────────────── widget palette ─────────────────────────

function WidgetPalette({ onAdd, disabled }: { onAdd: (kind: WorkshopWidgetKind) => void; disabled: boolean }) {
  const s = useStyles();
  return (
    <div className={s.palette}>
      <Caption1 className={s.hint}>Add widget:</Caption1>
      {(Object.keys(KIND_META) as WorkshopWidgetKind[]).map((k) => (
        <Tooltip key={k} content={KIND_META[k].hint} relationship="label">
          <Button size="small" appearance="outline" icon={KIND_META[k].icon} disabled={disabled} onClick={() => onAdd(k)}>{KIND_META[k].label}</Button>
        </Tooltip>
      ))}
    </div>
  );
}

// ───────────────────────── inspector ─────────────────────────

function WidgetInspector({
  widget, entityTypes, variables, columns, onChange, onRemove, allWidgets = [],
}: {
  widget: WorkshopWidget; entityTypes: string[]; variables: WorkshopVariable[]; columns: string[];
  onChange: (patch: Partial<WorkshopWidget>) => void; onRemove: () => void;
  /** tabs nesting — the full widget list, so tabs can pick child widgets per tab. */
  allWidgets?: WorkshopWidget[];
}) {
  const s = useStyles();
  const meta = KIND_META[widget.kind];
  const filterVars = variables.filter((v) => v.type === 'object-set-filter');
  const appliesIds = widget.appliesVariableIds || [];
  const toggleApplies = (vid: string) => {
    const next = appliesIds.includes(vid) ? appliesIds.filter((x) => x !== vid) : [...appliesIds, vid];
    onChange({ appliesVariableIds: next });
  };

  return (
    <div className={s.inspector}>
      <div className={s.sectionHead}>
        <span className={s.sectionIcon}><Edit20Regular /></span>
        <div><Subtitle2>Properties</Subtitle2><Caption1 as="p" block className={s.hint}>{meta.label} widget</Caption1></div>
      </div>
      <Field label="Title"><Input value={widget.title} onChange={(_, d) => onChange({ title: d.value })} /></Field>

      {/* object-type binding for data widgets */}
      {meta.data && (
        <Field label="Object type" hint="The bound ontology entity type (a Synapse table behind the ontology).">
          <Dropdown value={widget.entityType || ''} selectedOptions={widget.entityType ? [widget.entityType] : []}
            placeholder={entityTypes.length ? 'Select object type' : 'Bind an ontology first'}
            onOptionSelect={(_, d) => onChange({ entityType: d.optionValue || undefined, groupBy: undefined, aggColumn: undefined, metricColumn: undefined, filterColumn: undefined })}>
            {entityTypes.map((t) => <Option key={t} value={t}>{t}</Option>)}
          </Dropdown>
        </Field>
      )}

      {widget.kind === 'chart' && (
        <>
          <Field label="Chart type">
            <Dropdown value={widget.chartType || 'column'} selectedOptions={[widget.chartType || 'column']} onOptionSelect={(_, d) => onChange({ chartType: (d.optionValue as LoomChartType) || 'column' })}>
              {CHART_TYPES.map((t) => <Option key={t} value={t}>{t}</Option>)}
            </Dropdown>
          </Field>
          <Field label="Group by (category)" hint={columns.length ? 'Column to group rows by.' : 'Select an object type to discover columns.'}>
            <Dropdown value={widget.groupBy || ''} selectedOptions={widget.groupBy ? [widget.groupBy] : []} placeholder="Select column" onOptionSelect={(_, d) => onChange({ groupBy: d.optionValue || undefined })}>
              {columns.map((c) => <Option key={c} value={c}>{c}</Option>)}
            </Dropdown>
          </Field>
          <Field label="Aggregation">
            <Dropdown value={widget.aggFn || 'count'} selectedOptions={[widget.aggFn || 'count']} onOptionSelect={(_, d) => onChange({ aggFn: (d.optionValue as WorkshopAggFn) || 'count' })}>
              {AGG_FNS.map((a) => <Option key={a} value={a}>{a}</Option>)}
            </Dropdown>
          </Field>
          {widget.aggFn && widget.aggFn !== 'count' && (
            <Field label="Measure column">
              <Dropdown value={widget.aggColumn || ''} selectedOptions={widget.aggColumn ? [widget.aggColumn] : []} placeholder="Select column" onOptionSelect={(_, d) => onChange({ aggColumn: d.optionValue || undefined })}>
                {columns.map((c) => <Option key={c} value={c}>{c}</Option>)}
              </Dropdown>
            </Field>
          )}
        </>
      )}

      {widget.kind === 'metric' && (
        <>
          <Field label="Aggregation">
            <Dropdown value={widget.metricFn || 'count'} selectedOptions={[widget.metricFn || 'count']} onOptionSelect={(_, d) => onChange({ metricFn: (d.optionValue as WorkshopAggFn) || 'count' })}>
              {AGG_FNS.map((a) => <Option key={a} value={a}>{a}</Option>)}
            </Dropdown>
          </Field>
          {widget.metricFn && widget.metricFn !== 'count' && (
            <Field label="Value column">
              <Dropdown value={widget.metricColumn || ''} selectedOptions={widget.metricColumn ? [widget.metricColumn] : []} placeholder="Select column" onOptionSelect={(_, d) => onChange({ metricColumn: d.optionValue || undefined })}>
                {columns.map((c) => <Option key={c} value={c}>{c}</Option>)}
              </Dropdown>
            </Field>
          )}
        </>
      )}

      {widget.kind === 'filter' && (
        <>
          <Field label="Filter column">
            <Dropdown value={widget.filterColumn || ''} selectedOptions={widget.filterColumn ? [widget.filterColumn] : []} placeholder="Select column" onOptionSelect={(_, d) => onChange({ filterColumn: d.optionValue || undefined })}>
              {columns.map((c) => <Option key={c} value={c}>{c}</Option>)}
            </Dropdown>
          </Field>
          <Field label="Operator">
            <Dropdown value={FILTER_OP_LABEL[widget.filterOp || 'eq']} selectedOptions={[widget.filterOp || 'eq']} onOptionSelect={(_, d) => onChange({ filterOp: (d.optionValue as AtelierFilterOp) || 'eq' })}>
              {FILTER_OPS.map((o) => <Option key={o} value={o} text={FILTER_OP_LABEL[o]}>{FILTER_OP_LABEL[o]}</Option>)}
            </Dropdown>
          </Field>
          <Field label="Control">
            <Dropdown value={widget.filterControl === 'text' ? 'Text input' : 'Distinct-value dropdown'} selectedOptions={[widget.filterControl || 'dropdown']} onOptionSelect={(_, d) => onChange({ filterControl: (d.optionValue as 'dropdown' | 'text') || 'dropdown' })}>
              <Option value="dropdown" text="Distinct-value dropdown">Distinct-value dropdown</Option>
              <Option value="text" text="Text input">Text input</Option>
            </Dropdown>
          </Field>
          <Field label="Writes variable" hint="The object-set-filter variable this control sets. Data widgets that apply it are filtered.">
            <Dropdown value={filterVars.find((v) => v.id === widget.targetVariableId)?.name || ''} selectedOptions={widget.targetVariableId ? [widget.targetVariableId] : []}
              placeholder={filterVars.length ? 'Select variable' : 'Create an object-set-filter variable first'} onOptionSelect={(_, d) => onChange({ targetVariableId: d.optionValue || undefined })}>
              {filterVars.map((v) => <Option key={v.id} value={v.id} text={v.name}>{v.name}{v.entityType ? ` (${v.entityType})` : ''}</Option>)}
            </Dropdown>
          </Field>
        </>
      )}

      {widget.kind === 'form' && (
        <Field label="Action kind">
          <Dropdown value={widget.formKind || 'create'} selectedOptions={[widget.formKind || 'create']} onOptionSelect={(_, d) => onChange({ formKind: (d.optionValue as 'create' | 'update' | 'delete') || 'create' })}>
            <Option value="create">create</Option><Option value="update">update</Option><Option value="delete">delete</Option>
          </Dropdown>
        </Field>
      )}

      {widget.kind === 'text' && (
        <Field label="Content (markdown-lite)" hint="# heading, - list. Use {{variableName}} to interpolate a live variable value.">
          <Textarea value={widget.text || ''} onChange={(_, d) => onChange({ text: d.value })} rows={6} resize="vertical" placeholder={'# Title\nSelected: {{selectedOrder}}'} />
        </Field>
      )}

      {widget.kind === 'tabs' && (() => {
        const tabTitles = String(widget.tabItems || '').split('|').map((p) => p.trim()).filter(Boolean).map((p) => { const i = p.indexOf(':'); return i < 0 ? p : p.slice(0, i).trim(); });
        const nestable = allWidgets.filter((w) => w.id !== widget.id && w.kind !== 'tabs');
        const childIds = widget.tabChildIds || [];
        const setTabChildren = (ti: number, ids: string[]) => {
          const next = tabTitles.map((_, i) => (i === ti ? ids : childIds[i] || []));
          onChange({ tabChildIds: next });
        };
        return (
          <>
            <Field label="Tabs" hint={'"Title: content | Title: content" — content supports {{variableName}}.'}><Textarea value={widget.tabItems || ''} onChange={(_, d) => onChange({ tabItems: d.value })} rows={4} resize="vertical" placeholder={'Overview: Key numbers here | Details: More depth here'} /></Field>
            {tabTitles.map((t, ti) => (
              <Field key={ti} label={`"${t}" tab widgets`} hint="Nested widgets render inside this tab in Run mode (full live body) instead of on the canvas.">
                <Dropdown multiselect placeholder={nestable.length ? 'Pick widgets to nest' : 'Add other widgets first'}
                  selectedOptions={(childIds[ti] || []).filter((cid) => nestable.some((w) => w.id === cid))}
                  value={(childIds[ti] || []).map((cid) => nestable.find((w) => w.id === cid)?.title).filter(Boolean).join(', ')}
                  onOptionSelect={(_, d) => setTabChildren(ti, (d.selectedOptions as string[]) || [])}>
                  {nestable.map((w) => <Option key={w.id} value={w.id} text={w.title || w.kind}>{w.title || w.kind}</Option>)}
                </Dropdown>
              </Field>
            ))}
          </>
        );
      })()}
      {widget.kind === 'accordion' && (
        <Field label="Sections" hint={'One "Title: body" per line; body supports {{variableName}}.'}><Textarea value={widget.accordionItems || ''} onChange={(_, d) => onChange({ accordionItems: d.value })} rows={5} resize="vertical" placeholder={'FAQ 1: Answer one\nFAQ 2: Answer two'} /></Field>
      )}
      {widget.kind === 'sparkline' && (
        <Field label="Values" hint="Comma-separated numbers."><Input value={widget.sparkValues || ''} onChange={(_, d) => onChange({ sparkValues: d.value })} placeholder="3, 5, 2, 8, 6, 9" /></Field>
      )}
      {(widget.kind === 'video-embed' || widget.kind === 'map-embed') && (
        <Field label="Embed URL (https)" hint="https:// only — sandboxed iframe."><Input value={widget.embedUrl || ''} onChange={(_, d) => onChange({ embedUrl: d.value })} placeholder="https://…" /></Field>
      )}
      {widget.kind === 'stat-pair' && (
        <>
          <Field label="Left stat" hint="Label=value; value supports {{variableName}}."><Input value={widget.statLeft || ''} onChange={(_, d) => onChange({ statLeft: d.value })} placeholder="Orders=42" /></Field>
          <Field label="Right stat"><Input value={widget.statRight || ''} onChange={(_, d) => onChange({ statRight: d.value })} placeholder="Revenue={{revenue}}" /></Field>
        </>
      )}
      {widget.kind === 'mini-table' && (
        <Field label="Table (CSV)" hint="First line = headers; following lines = rows."><Textarea value={widget.miniTable || ''} onChange={(_, d) => onChange({ miniTable: d.value })} rows={5} resize="vertical" placeholder={'Region, Total\nWest, 42\nEast, 17'} /></Field>
      )}
      {widget.kind === 'breadcrumb' && (
        <Field label="Segments" hint="Comma-separated."><Input value={widget.crumbs || ''} onChange={(_, d) => onChange({ crumbs: d.value })} placeholder="Home, Sales, Q3" /></Field>
      )}
      {widget.kind === 'json-view' && (
        <Field label="JSON" hint="Pretty-printed when valid; raw otherwise."><Textarea aria-label="JSON data payload shown by the JSON widget" value={widget.json || ''} onChange={(_, d) => onChange({ json: d.value })} rows={6} resize="vertical" placeholder='{"region": "West"}' /></Field>
      )}
      {widget.kind === 'avatar' && (
        <>
          <Field label="Name" hint="Initials derive from it; supports {{variableName}}."><Input value={widget.avatarName || ''} onChange={(_, d) => onChange({ avatarName: d.value })} placeholder="Ada Lovelace" /></Field>
          <Field label="Caption"><Input value={widget.avatarCaption || ''} onChange={(_, d) => onChange({ avatarCaption: d.value })} placeholder="Data engineer" /></Field>
        </>
      )}
      {widget.kind === 'code-block' && (
        <Field label="Code"><Textarea value={widget.code || ''} onChange={(_, d) => onChange({ code: d.value })} rows={6} resize="vertical" placeholder={'SELECT *\nFROM orders'} /></Field>
      )}
      {widget.kind === 'key-value' && (
        <Field label="Pairs" hint={'One "Key: value" per line; values support {{variableName}}.'}><Textarea value={widget.keyValues || ''} onChange={(_, d) => onChange({ keyValues: d.value })} rows={5} resize="vertical" placeholder={'Owner: Frank\nRegion: {{region}}'} /></Field>
      )}
      {widget.kind === 'countdown' && (
        <Field label="Target date"><Input type="date" value={widget.countdownTo || ''} onChange={(_, d) => onChange({ countdownTo: d.value })} /></Field>
      )}
      {widget.kind === 'rating' && (
        <>
          <Field label="Value" hint="Number or {{variableName}}."><Input value={widget.ratingValue || ''} onChange={(_, d) => onChange({ ratingValue: d.value })} placeholder="4" /></Field>
          <Field label="Max stars (1–10)"><Input value={widget.ratingMax || ''} onChange={(_, d) => onChange({ ratingMax: d.value })} placeholder="5" /></Field>
        </>
      )}
      {widget.kind === 'tag-list' && (
        <Field label="Tags" hint="Comma-separated."><Input value={widget.tags || ''} onChange={(_, d) => onChange({ tags: d.value })} placeholder="gold, verified, priority" /></Field>
      )}
      {widget.kind === 'delta' && (
        <>
          <Field label="Current value" hint="Number or {{variableName}}."><Input value={widget.deltaValue || ''} onChange={(_, d) => onChange({ deltaValue: d.value })} placeholder="1250" /></Field>
          <Field label="Previous value"><Input value={widget.deltaPrevious || ''} onChange={(_, d) => onChange({ deltaPrevious: d.value })} placeholder="1100" /></Field>
        </>
      )}
      {widget.kind === 'checklist' && (
        <Field label="Items" hint="One per line; prefix with [x] to check."><Textarea value={widget.checklistItems || ''} onChange={(_, d) => onChange({ checklistItems: d.value })} rows={5} resize="vertical" placeholder={'[x] Kickoff\n[ ] Review\n[ ] Ship'} /></Field>
      )}
      {widget.kind === 'kpi-row' && (
        <Field label="KPI items" hint="Comma list of Label=value; values support {{variableName}}."><Input value={widget.kpiItems || ''} onChange={(_, d) => onChange({ kpiItems: d.value })} placeholder="Orders=42, Revenue={{revenue}}" /></Field>
      )}
      {widget.kind === 'gauge' && (
        <>
          <Field label="Value" hint="Number or {{variableName}}."><Input value={widget.gaugeValue || ''} onChange={(_, d) => onChange({ gaugeValue: d.value })} placeholder="75" /></Field>
          <Field label="Min"><Input value={widget.gaugeMin || ''} onChange={(_, d) => onChange({ gaugeMin: d.value })} placeholder="0" /></Field>
          <Field label="Max"><Input value={widget.gaugeMax || ''} onChange={(_, d) => onChange({ gaugeMax: d.value })} placeholder="100" /></Field>
        </>
      )}
      {(widget.kind === 'callout' || widget.kind === 'quote') && (
        <Field label={widget.kind === 'callout' ? 'Callout text' : 'Quote text'} hint="Supports {{variableName}} interpolation."><Textarea value={widget.text || ''} onChange={(_, d) => onChange({ text: d.value })} resize="vertical" /></Field>
      )}
      {widget.kind === 'callout' && (
        <Field label="Intent">
          <Dropdown value={widget.calloutIntent || 'info'} selectedOptions={[widget.calloutIntent || 'info']} onOptionSelect={(_, d) => onChange({ calloutIntent: (d.optionValue as WorkshopWidget['calloutIntent']) || 'info' })}>
            {(['info', 'success', 'warning', 'error'] as const).map((c) => <Option key={c} value={c}>{c}</Option>)}
          </Dropdown>
        </Field>
      )}
      {widget.kind === 'heading' && (
        <>
          <Field label="Heading text" hint="Supports {{variableName}} interpolation."><Input value={widget.text || ''} onChange={(_, d) => onChange({ text: d.value })} placeholder="Section title" /></Field>
          <Field label="Level">
            <Dropdown value={String(widget.headingLevel || 2)} selectedOptions={[String(widget.headingLevel || 2)]} onOptionSelect={(_, d) => onChange({ headingLevel: (Number(d.optionValue) as 1 | 2 | 3) || 2 })}>
              <Option value="1">1 — large</Option><Option value="2">2 — medium</Option><Option value="3">3 — small</Option>
            </Dropdown>
          </Field>
        </>
      )}
      {widget.kind === 'progress' && (
        <Field label="Value (0–100)" hint="A number or {{variableName}}."><Input value={widget.progressValue || ''} onChange={(_, d) => onChange({ progressValue: d.value })} placeholder="75 or {{pct}}" /></Field>
      )}
      {(widget.kind === 'image' || widget.kind === 'iframe') && (
        <Field label={widget.kind === 'image' ? 'Image URL (https)' : 'Embed URL (https)'} hint="https:// only — non-https sources are not rendered.">
          <Input value={widget.src || ''} onChange={(_, d) => onChange({ src: d.value })} placeholder="https://…" />
        </Field>
      )}
      {widget.kind === 'link' && (
        <>
          <Field label="Link URL (https)"><Input value={widget.href || ''} onChange={(_, d) => onChange({ href: d.value })} placeholder="https://…" /></Field>
          <Field label="Link text"><Input value={widget.text || ''} onChange={(_, d) => onChange({ text: d.value })} placeholder="Open dashboard" /></Field>
        </>
      )}
      {widget.kind === 'badge' && (
        <>
          <Field label="Badge text" hint="Supports {{variableName}} interpolation."><Input value={widget.text || ''} onChange={(_, d) => onChange({ text: d.value })} placeholder="Status: {{status}}" /></Field>
          <Field label="Color">
            <Dropdown value={widget.badgeColor || 'brand'} selectedOptions={[widget.badgeColor || 'brand']} onOptionSelect={(_, d) => onChange({ badgeColor: (d.optionValue as WorkshopWidget['badgeColor']) || 'brand' })}>
              {(['brand', 'success', 'warning', 'danger', 'informative'] as const).map((c) => <Option key={c} value={c}>{c}</Option>)}
            </Dropdown>
          </Field>
        </>
      )}

      {/* applied object-set-filter variables for data widgets */}
      {(widget.kind === 'table' || widget.kind === 'chart' || widget.kind === 'metric') && (
        <Field label="Filtered by variables" hint="Object-set-filter variables that constrain this widget's reads (server-side WHERE).">
          {filterVars.length === 0
            ? <Caption1 className={s.hint}>No object-set-filter variables yet — add one in the Variables panel.</Caption1>
            : filterVars.map((v) => (
              <Switch key={v.id} checked={appliesIds.includes(v.id)} onChange={() => toggleApplies(v.id)} label={`${v.name}${v.entityType ? ` (${v.entityType})` : ''}`} />
            ))}
        </Field>
      )}

      {/* events for button + table */}
      {(widget.kind === 'button' || widget.kind === 'table') && (
        <EventEditor widget={widget} variables={variables} entityTypes={entityTypes} columns={columns} onChange={onChange} />
      )}

      <Divider />
      <Button appearance="subtle" icon={<Dismiss16Regular />} onClick={onRemove}>Remove widget</Button>
    </div>
  );
}

// ───────────────────────── event editor ─────────────────────────

function EventEditor({
  widget, variables, entityTypes, columns, onChange,
}: {
  widget: WorkshopWidget; variables: WorkshopVariable[]; entityTypes: string[]; columns: string[];
  onChange: (patch: Partial<WorkshopWidget>) => void;
}) {
  const s = useStyles();
  const events = widget.events || [];
  const isButton = widget.kind === 'button';
  const defaultTrigger: WorkshopEventTrigger = isButton ? 'click' : 'row-select';

  const addEvent = () => onChange({
    events: [...events, { id: `ev_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`, trigger: defaultTrigger, effect: 'set-variable' }],
  });
  const patchEvent = (eid: string, patch: Partial<WorkshopEvent>) => onChange({ events: events.map((e) => (e.id === eid ? { ...e, ...patch } : e)) });
  const removeEvent = (eid: string) => onChange({ events: events.filter((e) => e.id !== eid) });

  const triggers: WorkshopEventTrigger[] = isButton ? ['click', 'page-load'] : ['row-select'];
  const effects: WorkshopEventEffect[] = isButton ? ['set-variable', 'clear-variable', 'run-action', 'refresh'] : ['set-variable'];

  return (
    <Field label="Events" hint={isButton ? 'What this button does when clicked (or on page load).' : 'What happens when a row is selected (master → detail).'}>
      <div className={s.eventCol}>
        {events.length === 0 && <Caption1 className={s.hint}>No events yet.</Caption1>}
        {events.map((e) => {
          const targetVar = variables.find((v) => v.id === e.targetVariableId);
          return (
            <div key={e.id} className={s.eventRow}>
              <div className={s.eventTop}>
                <Dropdown size="small" value={e.trigger} selectedOptions={[e.trigger]} onOptionSelect={(_, d) => patchEvent(e.id, { trigger: (d.optionValue as WorkshopEventTrigger) || defaultTrigger })}>
                  {triggers.map((t) => <Option key={t} value={t}>{t}</Option>)}
                </Dropdown>
                <Dropdown size="small" value={e.effect} selectedOptions={[e.effect]} onOptionSelect={(_, d) => patchEvent(e.id, { effect: (d.optionValue as WorkshopEventEffect) || 'set-variable' })}>
                  {effects.map((ef) => <Option key={ef} value={ef}>{ef}</Option>)}
                </Dropdown>
                <span className={s.spacer} />
                <Button size="small" appearance="subtle" icon={<Dismiss16Regular />} aria-label="Remove event" onClick={() => removeEvent(e.id)} />
              </div>

              {(e.effect === 'set-variable' || e.effect === 'clear-variable') && (
                <Dropdown size="small" placeholder="Target variable" value={targetVar?.name || ''} selectedOptions={e.targetVariableId ? [e.targetVariableId] : []}
                  onOptionSelect={(_, d) => patchEvent(e.id, { targetVariableId: d.optionValue || undefined })}>
                  {variables.map((v) => <Option key={v.id} value={v.id} text={v.name}>{v.name} · {VAR_TYPE_LABEL[v.type]}</Option>)}
                </Dropdown>
              )}

              {e.effect === 'set-variable' && targetVar?.type === 'object-set-filter' && (
                <>
                  <Dropdown size="small" placeholder="Predicate column" value={e.filterColumn || ''} selectedOptions={e.filterColumn ? [e.filterColumn] : []}
                    onOptionSelect={(_, d) => patchEvent(e.id, { filterColumn: d.optionValue || undefined })}>
                    {columns.map((c) => <Option key={c} value={c}>{c}</Option>)}
                  </Dropdown>
                  <Dropdown size="small" value={FILTER_OP_LABEL[e.filterOp || 'eq']} selectedOptions={[e.filterOp || 'eq']} onOptionSelect={(_, d) => patchEvent(e.id, { filterOp: (d.optionValue as AtelierFilterOp) || 'eq' })}>
                    {FILTER_OPS.map((o) => <Option key={o} value={o} text={FILTER_OP_LABEL[o]}>{FILTER_OP_LABEL[o]}</Option>)}
                  </Dropdown>
                  {e.trigger === 'row-select'
                    ? (
                      <Dropdown size="small" placeholder="Value from selected row column" value={e.selectionColumn || ''} selectedOptions={e.selectionColumn ? [e.selectionColumn] : []}
                        onOptionSelect={(_, d) => patchEvent(e.id, { selectionColumn: d.optionValue || undefined })}>
                        {columns.map((c) => <Option key={c} value={c}>{c}</Option>)}
                      </Dropdown>
                    )
                    : <Input size="small" placeholder="Literal value" value={e.value || ''} onChange={(_, d) => patchEvent(e.id, { value: d.value })} />}
                </>
              )}

              {e.effect === 'set-variable' && targetVar && targetVar.type !== 'object-set-filter' && (
                <Input size="small" placeholder="Literal value" value={e.value || ''} onChange={(_, d) => patchEvent(e.id, { value: d.value })} />
              )}

              {e.effect === 'run-action' && (
                <>
                  <Dropdown size="small" placeholder="Object type" value={e.actionEntityType || ''} selectedOptions={e.actionEntityType ? [e.actionEntityType] : []}
                    onOptionSelect={(_, d) => patchEvent(e.id, { actionEntityType: d.optionValue || undefined })}>
                    {entityTypes.map((t) => <Option key={t} value={t}>{t}</Option>)}
                  </Dropdown>
                  <Dropdown size="small" value={e.actionKind || 'create'} selectedOptions={[e.actionKind || 'create']} onOptionSelect={(_, d) => patchEvent(e.id, { actionKind: (d.optionValue as 'create' | 'update' | 'delete') || 'create' })}>
                    <Option value="create">create</Option><Option value="update">update</Option><Option value="delete">delete</Option>
                  </Dropdown>
                </>
              )}
            </div>
          );
        })}
        <Button size="small" appearance="outline" icon={<Add20Regular />} onClick={addEvent}>Add event</Button>
      </div>
    </Field>
  );
}

// ───────────────────────── variables panel ─────────────────────────

function VariablesPanel({
  variables, entityTypes, runtime, runMode, onChange, onRuntimeChange,
}: {
  variables: WorkshopVariable[]; entityTypes: string[]; runtime: Record<string, RuntimeVarValue>; runMode: boolean;
  onChange: (next: WorkshopVariable[]) => void; onRuntimeChange: (varId: string, value: RuntimeVarValue) => void;
}) {
  const s = useStyles();
  const add = () => onChange([...variables, {
    id: `var_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`, name: `var${variables.length + 1}`, type: 'object-set-filter',
  }]);
  const patch = (vid: string, p: Partial<WorkshopVariable>) => onChange(variables.map((v) => (v.id === vid ? { ...v, ...p } : v)));
  const remove = (vid: string) => onChange(variables.filter((v) => v.id !== vid));

  const runtimeLabel = (v: WorkshopVariable): string => {
    const rv = runtime[v.id];
    if (Array.isArray(rv)) return rv.length ? rv.map((p) => `${p.column} ${p.op} ${p.value}`).join(', ') : '(no filter)';
    if (typeof rv === 'string') return rv || '(empty)';
    return v.defaultValue ?? '(default)';
  };

  return (
    <div className={s.section}>
      <div className={s.sectionHead}>
        <span className={s.sectionIcon}><Code20Regular /></span>
        <div><Subtitle2>Variables</Subtitle2><Caption1 as="p" block className={s.hint}>App-level typed state. Object-set-filter variables are written by Filter widgets / row-select events and consumed by data widgets as a server-side WHERE.</Caption1></div>
        <span className={s.spacer} />
        <Button appearance="primary" icon={<Add20Regular />} onClick={add}>Add variable</Button>
      </div>
      {variables.length === 0
        ? <div className={s.empty}><Caption1>No variables yet — add one to drive filtering or hold app state.</Caption1></div>
        : variables.map((v) => (
          <div key={v.id} className={s.varRow}>
            <Field label="Name" className={s.fVarName}><Input value={v.name} onChange={(_, d) => patch(v.id, { name: d.value })} /></Field>
            <Field label="Type" className={s.fVarType}>
              <Dropdown value={VAR_TYPE_LABEL[v.type]} selectedOptions={[v.type]} onOptionSelect={(_, d) => patch(v.id, { type: (d.optionValue as WorkshopVarType) || 'string' })}>
                {(Object.keys(VAR_TYPE_LABEL) as WorkshopVarType[]).map((t) => <Option key={t} value={t} text={VAR_TYPE_LABEL[t]}>{VAR_TYPE_LABEL[t]}</Option>)}
              </Dropdown>
            </Field>
            {v.type === 'object-set-filter' && (
              <Field label="Object type" className={s.fVarType}>
                <Dropdown value={v.entityType || ''} selectedOptions={v.entityType ? [v.entityType] : []} placeholder="Any" onOptionSelect={(_, d) => patch(v.id, { entityType: d.optionValue || undefined })}>
                  {entityTypes.map((t) => <Option key={t} value={t}>{t}</Option>)}
                </Dropdown>
              </Field>
            )}
            {v.type === 'boolean' && (
              <Field label="Default"><Switch checked={(v.defaultValue ?? 'false') === 'true'} onChange={(_, d) => patch(v.id, { defaultValue: d.checked ? 'true' : 'false' })} /></Field>
            )}
            {(v.type === 'string' || v.type === 'number' || v.type === 'date') && (
              <Field label="Default" className={s.fVarName}>
                <Input type={v.type === 'number' ? 'number' : v.type === 'date' ? 'date' : 'text'} value={v.defaultValue ?? ''} onChange={(_, d) => patch(v.id, { defaultValue: d.value })} />
              </Field>
            )}
            <span className={s.spacer} />
            {runMode && <Badge appearance="tint" color="brand" title="Live runtime value">{runtimeLabel(v)}</Badge>}
            {runMode && typeof runtime[v.id] === 'string' && (
              <Button size="small" appearance="subtle" onClick={() => onRuntimeChange(v.id, '')}>Clear</Button>
            )}
            <Button size="small" appearance="subtle" icon={<Dismiss16Regular />} aria-label={`Remove ${v.name}`} onClick={() => remove(v.id)} />
          </div>
        ))}
    </div>
  );
}

// ───────────────────────── the builder ─────────────────────────

export interface WorkshopAppBuilderProps {
  id: string;
  entityTypes: string[];
  widgets: WorkshopWidget[];
  variables: WorkshopVariable[];
  onWidgetsChange: (next: WorkshopWidget[]) => void;
  onVariablesChange: (next: WorkshopVariable[]) => void;
}

export function WorkshopAppBuilder({ id, entityTypes, widgets, variables, onWidgetsChange, onVariablesChange }: WorkshopAppBuilderProps) {
  const s = useStyles();
  const [mode, setMode] = useState<'design' | 'preview'>('design');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, RunResult>>({});
  const [runtime, setRuntime] = useState<Record<string, RuntimeVarValue>>({});
  const [filterValues, setFilterValues] = useState<Record<string, string>>({});
  const [selectedRows, setSelectedRows] = useState<Record<string, number | null>>({});
  const [busy, setBusy] = useState(false);
  const [actionDialog, setActionDialog] = useState<{ entityType: string; kind: 'create' | 'update' | 'delete' } | null>(null);
  const { colsByEntity, ensure } = useEntityColumns(id);

  const selected = widgets.find((w) => w.id === selectedId) || null;
  const saved = id && id !== 'new';

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

  const canvasHeight = useMemo(() => {
    const maxBottom = normalized.reduce((m, w) => Math.max(m, (w.layout?.y || 0) + (w.layout?.h || 0)), 0);
    return Math.max(CANVAS_MIN_H, maxBottom + GRID * 3);
  }, [normalized]);

  // Discover columns for every bound entity type (inspectors + forms need them).
  useEffect(() => {
    const types = new Set<string>();
    for (const w of widgets) if (w.entityType) types.add(w.entityType);
    if (selected?.entityType) types.add(selected.entityType);
    types.forEach((t) => void ensure(t));
  }, [widgets, selected, ensure]);

  // ── widget mutations ──
  const addWidget = useCallback((kind: WorkshopWidgetKind) => {
    const size = DEFAULT_SIZE[kind];
    const maxBottom = normalized.reduce((m, w) => Math.max(m, (w.layout?.y || 0) + (w.layout?.h || 0)), 0);
    const wid = `w_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const widget: WorkshopWidget = {
      id: wid, kind, title: `${KIND_META[kind].label} ${widgets.filter((w) => w.kind === kind).length + 1}`,
      layout: { x: GRID, y: maxBottom ? maxBottom + GRID : GRID, w: size.w, h: size.h },
      ...(kind === 'chart' ? { chartType: 'column' as LoomChartType, aggFn: 'count' as WorkshopAggFn } : {}),
      ...(kind === 'metric' ? { metricFn: 'count' as WorkshopAggFn } : {}),
      ...(kind === 'filter' ? { filterOp: 'eq' as AtelierFilterOp, filterControl: 'dropdown' as const } : {}),
      ...(kind === 'form' ? { formKind: 'create' as const } : {}),
      ...(kind === 'text' ? { text: '# New text widget\nUse {{variableName}} to show a live value.' } : {}),
      ...(kind === 'badge' ? { text: 'Status', badgeColor: 'brand' as const } : {}),
      ...(kind === 'heading' ? { text: 'Section title', headingLevel: 2 as const } : {}),
      ...(kind === 'progress' ? { progressValue: '50' } : {}),
      ...(kind === 'kpi-row' ? { kpiItems: 'Orders=42, Revenue=1.2M' } : {}),
      ...(kind === 'gauge' ? { gaugeValue: '75', gaugeMin: '0', gaugeMax: '100' } : {}),
      ...(kind === 'callout' ? { text: 'Heads up — check the latest numbers.', calloutIntent: 'info' as const } : {}),
      ...(kind === 'quote' ? { text: 'Data beats opinions.' } : {}),
      ...(kind === 'rating' ? { ratingValue: '4', ratingMax: '5' } : {}),
      ...(kind === 'tag-list' ? { tags: 'gold, verified, priority' } : {}),
      ...(kind === 'delta' ? { deltaValue: '1250', deltaPrevious: '1100' } : {}),
      ...(kind === 'checklist' ? { checklistItems: '[x] Kickoff\n[ ] Review\n[ ] Ship' } : {}),
      ...(kind === 'avatar' ? { avatarName: 'Ada Lovelace', avatarCaption: 'Data engineer' } : {}),
      ...(kind === 'code-block' ? { code: 'SELECT *\nFROM orders' } : {}),
      ...(kind === 'key-value' ? { keyValues: 'Owner: Frank\nRegion: Central US' } : {}),
      ...(kind === 'countdown' ? { countdownTo: '2026-12-31' } : {}),
      ...(kind === 'stat-pair' ? { statLeft: 'Orders=42', statRight: 'Revenue=1.2M' } : {}),
      ...(kind === 'mini-table' ? { miniTable: 'Region, Total\nWest, 42\nEast, 17' } : {}),
      ...(kind === 'breadcrumb' ? { crumbs: 'Home, Sales, Q3' } : {}),
      ...(kind === 'json-view' ? { json: '{"region": "West", "total": 42}' } : {}),
      ...(kind === 'tabs' ? { tabItems: 'Overview: Key numbers here | Details: More depth here' } : {}),
      ...(kind === 'accordion' ? { accordionItems: 'FAQ 1: Answer one\nFAQ 2: Answer two' } : {}),
      ...(kind === 'sparkline' ? { sparkValues: '3, 5, 2, 8, 6, 9' } : {}),
    };
    onWidgetsChange([...widgets, widget]);
    setSelectedId(wid);
  }, [normalized, widgets, onWidgetsChange]);

  // Widgets claimed as nested children by a tabs widget — hidden from the
  // top-level canvas in Run mode (they render inside their tab pane instead).
  const nestedIds = useMemo(() => nestedWidgetIds(normalized), [normalized]);

  const patchWidget = useCallback((wid: string, patch: Partial<WorkshopWidget>) => {
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
    // Drop the widget AND strip any stale nesting claims on it from tabs widgets.
    onWidgetsChange(widgets.filter((w) => w.id !== wid).map((w) => (
      w.kind === 'tabs' && w.tabChildIds?.some((t) => t?.includes(wid))
        ? { ...w, tabChildIds: w.tabChildIds.map((t) => (t || []).filter((cid) => cid !== wid)) }
        : w
    )));
    if (selectedId === wid) setSelectedId(null);
  }, [widgets, onWidgetsChange, selectedId]);

  // ── preview runtime ──
  const runDataWidget = useCallback(async (w: WorkshopWidget, rt: Record<string, RuntimeVarValue>) => {
    if (!w.entityType) return;
    setResults((p) => ({ ...p, [w.id]: { loading: true } }));
    const filters = collectFilters(w, variables, rt);
    let body: RunActionBody;
    if (w.kind === 'chart') body = { entityType: w.entityType, op: 'aggregate', groupBy: w.groupBy, aggFn: w.aggFn || 'count', aggColumn: w.aggColumn, filters, top: 50 };
    else if (w.kind === 'metric') body = { entityType: w.entityType, op: 'aggregate', aggFn: w.metricFn || 'count', aggColumn: w.metricColumn, filters, top: 1 };
    else body = { entityType: w.entityType, op: 'list', filters, top: 200 };
    const res = await runAction(id, body);
    setResults((p) => ({ ...p, [w.id]: res }));
  }, [id, variables]);

  const runAllData = useCallback(async (rt: Record<string, RuntimeVarValue>) => {
    setBusy(true);
    const dataWidgets = normalized.filter((w) => (w.kind === 'table' || w.kind === 'chart' || w.kind === 'metric') && w.entityType);
    await Promise.all(dataWidgets.map((w) => runDataWidget(w, rt)));
    setBusy(false);
  }, [normalized, runDataWidget]);

  // Apply an event effect into a runtime map (run-action is handled by the caller).
  const applyEffectInto = useCallback((rt: Record<string, RuntimeVarValue>, e: WorkshopEvent, selectionRow?: { columns: string[]; row: unknown[] }) => {
    const v = variables.find((x) => x.id === e.targetVariableId);
    if (e.effect === 'clear-variable' && v) { rt[v.id] = v.type === 'object-set-filter' ? [] : ''; return; }
    if (e.effect !== 'set-variable' || !v) return;
    if (v.type === 'object-set-filter') {
      let value = e.value || '';
      if (e.trigger === 'row-select' && selectionRow && e.selectionColumn) {
        const ci = selectionRow.columns.indexOf(e.selectionColumn);
        value = ci >= 0 ? String(selectionRow.row[ci] ?? '') : '';
      }
      rt[v.id] = e.filterColumn && value !== '' ? [{ column: e.filterColumn, op: e.filterOp || 'eq', value }] : [];
    } else {
      rt[v.id] = e.value || '';
    }
  }, [variables]);

  // Seed runtime from variable defaults, run page-load events, run reads on entering Preview.
  const didPreview = useRef(false);
  useEffect(() => {
    if (mode !== 'preview') { didPreview.current = false; return; }
    if (didPreview.current) return;
    didPreview.current = true;
    const rt: Record<string, RuntimeVarValue> = {};
    for (const v of variables) rt[v.id] = v.type === 'object-set-filter' ? [] : (v.defaultValue ?? '');
    for (const w of widgets) {
      if (w.kind !== 'button') continue;
      for (const e of w.events || []) { if (e.trigger === 'page-load') applyEffectInto(rt, e); }
    }
    setRuntime(rt);
    setFilterValues({});
    setSelectedRows({});
    void runAllData(rt);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  // Filter widget changed its value in Preview → set its target variable + re-read affected widgets.
  const onFilterChange = useCallback((w: WorkshopWidget, value: string) => {
    setFilterValues((p) => ({ ...p, [w.id]: value }));
    if (!w.targetVariableId || !w.filterColumn) return;
    const predicates: AtelierFilter[] = value !== '' ? [{ column: w.filterColumn, op: w.filterOp || 'eq', value }] : [];
    const next: Record<string, RuntimeVarValue> = { ...runtime, [w.targetVariableId]: predicates };
    setRuntime(next);
    void runAllData(next);
  }, [runtime, runAllData]);

  // Table row selected → run its row-select set-variable events (master → detail).
  const onRowSelect = useCallback((w: WorkshopWidget, index: number, row: unknown[]) => {
    setSelectedRows((p) => ({ ...p, [w.id]: index }));
    const cols = results[w.id]?.columns || [];
    const next = { ...runtime };
    let touched = false;
    for (const e of w.events || []) {
      if (e.trigger === 'row-select' && e.effect === 'set-variable') { applyEffectInto(next, e, { columns: cols, row }); touched = true; }
    }
    if (touched) { setRuntime(next); void runAllData(next); }
  }, [runtime, results, runAllData, applyEffectInto]);

  // Button clicked → run its click events.
  const onButtonClick = useCallback((w: WorkshopWidget) => {
    const next = { ...runtime };
    let needsRead = false;
    for (const e of w.events || []) {
      if (e.trigger !== 'click') continue;
      if (e.effect === 'run-action' && e.actionEntityType) { setActionDialog({ entityType: e.actionEntityType, kind: e.actionKind || 'create' }); continue; }
      if (e.effect === 'refresh') { needsRead = true; continue; }
      applyEffectInto(next, e);
      needsRead = true;
    }
    if (needsRead) { setRuntime(next); void runAllData(next); }
  }, [runtime, runAllData, applyEffectInto]);


  const setRuntimeScalar = useCallback((varId: string, value: RuntimeVarValue) => {
    setRuntime((p) => ({ ...p, [varId]: value }));
  }, []);

  const colsForSelected = (selected?.entityType && colsByEntity[selected.entityType]) || [];
  const readOnly = mode === 'preview';

  const renderWidgetBody = (w: WorkshopWidget) => (
    <WidgetBody
      id={id} widget={w} variables={variables} runtime={runtime} result={results[w.id]} readOnly={readOnly}
      height={w.layout?.h || DEFAULT_SIZE[w.kind].h}
      selectedRow={selectedRows[w.id] ?? null}
      onSelectRow={(index, row) => onRowSelect(w, index, row)}
      onClickButton={() => (w.kind === 'button' ? onButtonClick(w) : runAllData(runtime))}
      setFilterValue={(v) => onFilterChange(w, v)}
      filterValue={filterValues[w.id] || ''}
      columnsForEntity={(w.entityType && colsByEntity[w.entityType]) || []}
      renderNested={(cid) => {
        const cw = normalized.find((x) => x.id === cid);
        if (!cw || cw.kind === 'tabs') return null; // gone or would cycle
        return (
          <div style={{ minWidth: 0 }}>
            <Caption1 block>{cw.title || KIND_META[cw.kind]?.label || cw.kind}</Caption1>
            {renderWidgetBody(cw)}
          </div>
        );
      }}
      nestedLabel={(cid) => {
        const cw = normalized.find((x) => x.id === cid);
        return cw && cw.kind !== 'tabs' ? (cw.title || KIND_META[cw.kind]?.label || cw.kind) : null;
      }}
    />
  );

  // Design-mode canvas block, extracted so both the SplitPane (widget selected)
  // and the plain single-column layout (nothing selected) render the same canvas
  // without duplicating JSX. Closes over normalized / canvasHeight / selectedId
  // and the widget handlers, all in scope here.
  const canvasBlock = (
    <div className={s.canvasWrap} style={{ height: canvasHeight }} onPointerDown={() => setSelectedId(null)}>
      <div className={s.canvas} style={{ height: canvasHeight }}>
        {normalized.length === 0 ? (
          <div style={{ position: 'absolute', inset: 0 }}>
            <EmptyState icon={<Apps20Regular />} title="Empty canvas" body="Add a widget from the palette above, bind it to an ontology object type, then switch to Preview to see real data." />
          </div>
        ) : normalized.map((w) => (
          <CanvasWidget key={w.id} widget={w} selected={selectedId === w.id} readOnly={false}
            onSelect={() => setSelectedId(w.id)} onMove={(x, y) => moveWidget(w.id, x, y)} onResize={(cw, ch) => resizeWidget(w.id, cw, ch)} onRemove={() => removeWidget(w.id)}>
            {renderWidgetBody(w)}
          </CanvasWidget>
        ))}
      </div>
    </div>
  );

  return (
    <div className={s.root}>
      <div className={s.modeBar}>
        <TabList selectedValue={mode} onTabSelect={(_, d) => setMode(d.value as 'design' | 'preview')}>
          <Tab value="design" icon={<Edit20Regular />}>Design</Tab>
          <Tab value="preview" icon={<Play20Regular />}>Preview</Tab>
        </TabList>
        <span className={s.spacer} />
        {mode === 'preview' && (
          <Button appearance="primary" icon={busy ? <Spinner size="tiny" /> : <ArrowSync20Regular />} disabled={busy} onClick={() => runAllData(runtime)}>
            {busy ? 'Running…' : 'Refresh data'}
          </Button>
        )}
        <Badge appearance="outline" icon={<ArrowMaximize20Regular />}>{normalized.length} widget{normalized.length === 1 ? '' : 's'}</Badge>
        <Badge appearance="outline" icon={<Database20Regular />}>{entityTypes.length} object type{entityTypes.length === 1 ? '' : 's'}</Badge>
      </div>

      {!saved && (
        <MessageBar intent="warning"><MessageBarBody>Save the app once (Ctrl+S) to run reads — Preview executes real T-SQL against the bound ontology's Synapse warehouse.</MessageBarBody></MessageBar>
      )}

      {mode === 'design' && (
        <VariablesPanel variables={variables} entityTypes={entityTypes} runtime={runtime} runMode={false}
          onChange={onVariablesChange} onRuntimeChange={setRuntimeScalar} />
      )}
      {mode === 'preview' && variables.length > 0 && (
        <VariablesPanel variables={variables} entityTypes={entityTypes} runtime={runtime} runMode
          onChange={onVariablesChange} onRuntimeChange={setRuntimeScalar} />
      )}

      <div className={s.section}>
        <div className={s.sectionHead}>
          <span className={s.sectionIcon}><Apps20Regular /></span>
          <div><Subtitle2>{mode === 'design' ? 'Canvas' : 'Live app (Run mode)'}</Subtitle2>
            <Caption1 as="p" block className={s.hint}>{mode === 'design'
              ? 'Drag widget headers to move, drag the corner to resize. Click a widget to edit it in the inspector.'
              : 'Every data widget reads its object type\'s real rows from Synapse; filters, buttons and row-selection are live.'}</Caption1></div>
        </div>
        {mode === 'design' && <WidgetPalette onAdd={addWidget} disabled={false} />}

        {mode === 'design' ? (
          selected ? (
            <SplitPane
              direction="horizontal"
              primary="second"
              storageKey="workshop-app.inspector"
              defaultSize={340}
              minSize={280}
              maxSize={540}
              dividerLabel="Resize inspector"
            >
              {canvasBlock}
              <WidgetInspector widget={selected} entityTypes={entityTypes} variables={variables} columns={colsForSelected}
                allWidgets={normalized}
                onChange={(patch) => patchWidget(selected.id, patch)} onRemove={() => removeWidget(selected.id)} />
            </SplitPane>
          ) : (
            <div className={s.designGrid}>
              {canvasBlock}
            </div>
          )
        ) : (
          <div className={s.canvasWrap} style={{ height: canvasHeight }}>
            <div className={s.canvas} style={{ height: canvasHeight }}>
              {normalized.length === 0 ? (
                <div style={{ position: 'absolute', inset: 0 }}>
                  <EmptyState icon={<Play20Regular />} title="Nothing to preview yet" body="Switch to Design and add widgets bound to object types, then come back to Run mode." />
                </div>
              ) : normalized.filter((w) => !nestedIds.has(w.id)).map((w) => (
                <CanvasWidget key={w.id} widget={w} selected={false} readOnly
                  onSelect={() => {}} onMove={() => {}} onResize={() => {}} onRemove={() => {}}>
                  {renderWidgetBody(w)}
                </CanvasWidget>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Button run-action CRUD dialog (real write-back). */}
      <Dialog open={!!actionDialog} onOpenChange={(_, d) => { if (!d.open) setActionDialog(null); }}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>{actionDialog ? `${actionDialog.kind} ${actionDialog.entityType}` : 'Run action'}</DialogTitle>
            <DialogContent>
              <div className={s.dialogForm}>
                {actionDialog && (
                  <CrudForm id={id} entityType={actionDialog.entityType} kind={actionDialog.kind}
                    columns={colsByEntity[actionDialog.entityType] || []} onDone={() => { void runAllData(runtime); }} />
                )}
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setActionDialog(null)}>Close</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
}
