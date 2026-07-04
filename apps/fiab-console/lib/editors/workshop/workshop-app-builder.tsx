'use client';

import { clientFetch } from '@/lib/client-fetch';
/**
 * Workshop app builder — the real, live low-code app builder surface for the
 * Fabric IQ `workshop-app` item (Palantir Foundry **Workshop** parity). Replaces
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
  Body1, Caption1, Subtitle2, Badge, Button, Input, Textarea, Field, Dropdown, Option,
  Spinner, Switch, Tab, TabList, Tooltip, Divider,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  makeStyles, mergeClasses, tokens,
} from '@fluentui/react-components';
import {
  Add20Regular, Dismiss16Regular, Play20Regular, ArrowSync20Regular,
  Table20Regular, DataUsage20Regular, NumberSymbol20Regular, DocumentText20Regular,
  Apps20Regular, Filter20Regular, Form20Regular, Cursor20Regular, Edit20Regular,
  ArrowMaximize20Regular, Flash20Regular, Database20Regular, Code20Regular,
} from '@fluentui/react-icons';
import { LoomChart, type LoomChartType } from '@/lib/components/charts/loom-chart';
import { EmptyState } from '@/lib/components/empty-state';
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
};

const KIND_META: Record<WorkshopWidgetKind, { label: string; icon: ReactElement; hint: string; data: boolean }> = {
  table: { label: 'Object Table', icon: <Table20Regular />, hint: 'Rows of an ontology object type, filtered by variables', data: true },
  chart: { label: 'Chart', icon: <DataUsage20Regular />, hint: 'Aggregate (GROUP BY) over an object type', data: true },
  metric: { label: 'Metric', icon: <NumberSymbol20Regular />, hint: 'A single aggregated KPI number', data: true },
  filter: { label: 'Filter', icon: <Filter20Regular />, hint: 'A control that writes an object-set-filter variable', data: true },
  form: { label: 'Form', icon: <Form20Regular />, hint: 'Create / update / delete an object — real write-back', data: true },
  button: { label: 'Button', icon: <Cursor20Regular />, hint: 'Fires events: set a variable, run an action, refresh', data: false },
  text: { label: 'Text', icon: <DocumentText20Regular />, hint: 'Markdown-lite label with {{variable}} interpolation', data: false },
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
}: {
  id: string; widget: WorkshopWidget; variables: WorkshopVariable[]; runtime: Record<string, RuntimeVarValue>;
  result?: RunResult; readOnly: boolean; height: number;
  selectedRow: number | null; onSelectRow: (index: number, row: unknown[]) => void;
  onClickButton: () => void; setFilterValue: (v: string) => void; filterValue: string; columnsForEntity: string[];
}) {
  const s = useStyles();

  if (widget.kind === 'text') {
    return <div>{renderText(widget.text || '_Empty text widget — set its content in the inspector._', variables, runtime)}</div>;
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
  widget, entityTypes, variables, columns, onChange, onRemove,
}: {
  widget: WorkshopWidget; entityTypes: string[]; variables: WorkshopVariable[]; columns: string[];
  onChange: (patch: Partial<WorkshopWidget>) => void; onRemove: () => void;
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
    };
    onWidgetsChange([...widgets, widget]);
    setSelectedId(wid);
  }, [normalized, widgets, onWidgetsChange]);

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
    onWidgetsChange(widgets.filter((w) => w.id !== wid));
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
    />
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
          <div className={selected ? s.designGridSel : s.designGrid}>
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
            {selected && (
              <WidgetInspector widget={selected} entityTypes={entityTypes} variables={variables} columns={colsForSelected}
                onChange={(patch) => patchWidget(selected.id, patch)} onRemove={() => removeWidget(selected.id)} />
            )}
          </div>
        ) : (
          <div className={s.canvasWrap} style={{ height: canvasHeight }}>
            <div className={s.canvas} style={{ height: canvasHeight }}>
              {normalized.length === 0 ? (
                <div style={{ position: 'absolute', inset: 0 }}>
                  <EmptyState icon={<Play20Regular />} title="Nothing to preview yet" body="Switch to Design and add widgets bound to object types, then come back to Run mode." />
                </div>
              ) : normalized.map((w) => (
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
