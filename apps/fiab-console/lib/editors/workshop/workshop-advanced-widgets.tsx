'use client';

/**
 * workshop-advanced-widgets — the WS-4.5 "B+" widgets over REAL backends, plus
 * the multi-page + overlay + conditional-visibility UI primitives, extracted
 * from workshop-app-builder.tsx (keeps the builder under its ratchet ceiling).
 *
 * Every widget renders REAL data (no mock, per no-vaporware.md):
 *   • object-view — the selected object's full drill-in (properties / linked /
 *     timeseries / map) via the AGE-backed ontology object-view route (reuses
 *     lib/foundry/object-view.ts + ObjectViewPanel).
 *   • links       — linked objects grouped by link type, from the same AGE route.
 *   • map         — an object type's geo rows projected to GeoJSON (object-view's
 *     pure toGeoFeatureCollection) rendered with the sovereign GeoJsonMap
 *     (MapLibre-compatible offline twin — no external tiles, Gov-safe).
 *   • pivot       — a row × column matrix aggregating a measure (pivotShape) over
 *     real Synapse rows from the run-action route.
 *   • timeline    — a time-ordered event stream (timelineShape) over real rows.
 *   • aip-copilot — the per-surface Copilot pane grounded in this app's ontology
 *     + variables (registerCopilotContext + the csaloom:open-copilot event →
 *     /api/copilot/orchestrate).
 *
 * Azure-native (AGE / Synapse) + AOAI — no Microsoft Fabric, Gov-safe.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Body1, Caption1, Subtitle2, Badge, Button, Field, Dropdown, Option, Input, Textarea, Spinner,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle, Menu, MenuTrigger, MenuList, MenuItem, MenuPopover,
  Drawer, DrawerHeader, DrawerHeaderTitle, DrawerBody, Tab, TabList,
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Add20Regular, Dismiss16Regular, BrainCircuit20Regular, Link20Regular, Eye20Regular,
  MoreHorizontal20Regular, Open20Regular, Timeline20Regular,
} from '@fluentui/react-icons';
import { clientFetch } from '@/lib/client-fetch';
import { EmptyState } from '@/lib/components/empty-state';
import { GeoJsonMap } from '@/lib/components/graph/geojson-map';
import { ObjectViewPanel } from '@/lib/editors/phase4/object-view-panel';
import { registerCopilotContext } from '@/lib/copilot/use-copilot-context';
import type { AtelierFilter } from '@/lib/editors/_family-utils';
import {
  pivotShape, timelineShape, resolvePages, type WorkshopWidget, type WorkshopVariable,
  type WorkshopPage, type WorkshopVisibilityRule, type WorkshopVisibilityOp, type WorkshopAggFn,
  type WorkshopOverlayStyle,
} from './_workshop-model';
import { toGeoFeatureCollection } from '@/lib/foundry/object-view';

const AGG_FNS: WorkshopAggFn[] = ['count', 'sum', 'avg', 'min', 'max'];
const VIS_OPS: WorkshopVisibilityOp[] = ['eq', 'ne', 'empty', 'notEmpty', 'truthy', 'falsy'];
const VIS_OP_LABEL: Record<WorkshopVisibilityOp, string> = {
  eq: 'equals', ne: 'not equals', empty: 'is empty', notEmpty: 'is not empty', truthy: 'is truthy', falsy: 'is falsy',
};

const useStyles = makeStyles({
  fill: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, minWidth: 0, minHeight: 0, height: '100%' },
  hint: { color: tokens.colorNeutralForeground3, minWidth: 0, overflowWrap: 'anywhere' },
  empty: {
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: tokens.spacingHorizontalS,
    padding: tokens.spacingVerticalL, color: tokens.colorNeutralForeground3, textAlign: 'center', height: '100%',
    borderRadius: tokens.borderRadiusMedium, border: `1px dashed ${tokens.colorNeutralStroke2}`, backgroundColor: tokens.colorNeutralBackground2,
  },
  tableWrap: { overflow: 'auto', minWidth: 0, borderRadius: tokens.borderRadiusMedium, border: `1px solid ${tokens.colorNeutralStroke2}` },
  linkSec: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, minWidth: 0, paddingBottom: tokens.spacingVerticalS },
  linkHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap', minWidth: 0 },
  neighbor: {
    display: 'flex', flexDirection: 'column', minWidth: 0, padding: tokens.spacingVerticalXS,
    borderRadius: tokens.borderRadiusSmall, border: `1px solid ${tokens.colorNeutralStroke3}`, backgroundColor: tokens.colorNeutralBackground1,
  },
  timeline: { position: 'relative', display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, minWidth: 0, paddingLeft: tokens.spacingHorizontalL },
  tlRow: { position: 'relative', display: 'flex', flexDirection: 'column', minWidth: 0 },
  tlDot: {
    position: 'absolute', left: `calc(-1 * ${tokens.spacingHorizontalL})`, top: '4px', width: '10px', height: '10px',
    borderRadius: '50%', backgroundColor: tokens.colorBrandBackground, border: `2px solid ${tokens.colorNeutralBackground1}`,
  },
  tlRail: { position: 'absolute', left: `calc(-1 * ${tokens.spacingHorizontalL} + 4px)`, top: '0', bottom: '0', width: '2px', backgroundColor: tokens.colorNeutralStroke2 },
  pivotTh: { textAlign: 'right', whiteSpace: 'nowrap' },
  pivotRowHead: { fontWeight: tokens.fontWeightSemibold, whiteSpace: 'nowrap' },
  copilotCard: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, minWidth: 0, height: '100%',
    alignItems: 'flex-start', justifyContent: 'center',
    padding: tokens.spacingVerticalM, borderRadius: tokens.borderRadiusMedium,
    background: `linear-gradient(135deg, ${tokens.colorBrandBackground2}, ${tokens.colorNeutralBackground1})`,
  },
  pageStrip: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', minWidth: 0 },
  visRow: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, minWidth: 0 },
});

// ───────────────────────── shared data helpers (self-contained) ─────────────────────────

interface AdvRunResult { columns?: string[]; rows?: unknown[][]; error?: string; gate?: { reason: string; remediation: string } }

async function advRun(id: string, body: Record<string, unknown>): Promise<AdvRunResult> {
  try {
    const r = await clientFetch(`/api/items/workshop-app/${encodeURIComponent(id)}/run-action`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (!j?.ok) return { error: j?.error || `HTTP ${r.status}`, gate: j?.gate };
    return { columns: j.columns || [], rows: j.rows || [] };
  } catch (e: unknown) { return { error: e instanceof Error ? e.message : String(e) }; }
}

function toRecords(columns: string[], rows: unknown[][]): Array<Record<string, unknown>> {
  return rows.map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i]])));
}

/** Object-set-filter predicates the widget applies (server-side WHERE), from live runtime. */
function collectFilters(widget: WorkshopWidget, variables: WorkshopVariable[], runtime: Record<string, unknown>): AtelierFilter[] {
  const out: AtelierFilter[] = [];
  for (const vid of widget.appliesVariableIds || []) {
    const v = variables.find((x) => x.id === vid);
    if (!v || v.type !== 'object-set-filter') continue;
    if (v.entityType && widget.entityType && v.entityType !== widget.entityType) continue;
    const rv = runtime[vid];
    if (Array.isArray(rv)) out.push(...(rv as AtelierFilter[]));
  }
  return out;
}

/** The selected object key (AGE vertex id) a drill-in widget reads, from its bound variable. */
function resolveKeyValue(widget: WorkshopWidget, runtime: Record<string, unknown>): string {
  if (!widget.keyVariableId) return '';
  const rv = runtime[widget.keyVariableId];
  return typeof rv === 'string' ? rv.trim() : '';
}

// ───────────────────────── data-fetch hook (Run mode) ─────────────────────────

function useWidgetRows(id: string, widget: WorkshopWidget, variables: WorkshopVariable[], runtime: Record<string, unknown>, active: boolean) {
  const [state, setState] = useState<AdvRunResult & { loading?: boolean }>({});
  const filterKey = JSON.stringify(collectFilters(widget, variables, runtime));
  useEffect(() => {
    if (!active || !widget.entityType) return;
    let cancelled = false;
    setState({ loading: true });
    void advRun(id, { entityType: widget.entityType, op: 'list', top: 500, filters: JSON.parse(filterKey) }).then((res) => {
      if (!cancelled) setState(res);
    });
    return () => { cancelled = true; };
  }, [id, widget.entityType, active, filterKey]);
  return state;
}

function GateOrError({ res }: { res: AdvRunResult }) {
  if (res.gate) return <MessageBar intent="warning"><MessageBarBody><MessageBarTitle>Configure backend</MessageBarTitle>{res.gate.reason} {res.gate.remediation}</MessageBarBody></MessageBar>;
  return <MessageBar intent="error"><MessageBarBody>{res.error}</MessageBarBody></MessageBar>;
}

// ───────────────────────── map ─────────────────────────

function MapBody({ id, widget, variables, runtime, readOnly, height }: BodyProps) {
  const s = useStyles();
  const res = useWidgetRows(id, widget, variables, runtime, readOnly);
  if (!widget.entityType) return <div className={s.empty}><Caption1>Pick an object type in the inspector.</Caption1></div>;
  if (!readOnly) return <div className={s.empty}><Caption1>Switch to Preview to load real geo rows.</Caption1></div>;
  if (res.loading) return <div className={s.empty}><Spinner size="tiny" label="Reading…" labelPosition="after" /></div>;
  if (res.error || res.gate) return <GateOrError res={res} />;
  const records = toRecords(res.columns || [], res.rows || []).map((r) => ({ properties: r }));
  const fc = toGeoFeatureCollection(records, widget.geoColumn ? { geoProp: widget.geoColumn } : undefined);
  if (!fc) return <div className={s.empty}><Caption1>No location data in these rows. Add a geopoint/geoshape column (e.g. "lat,lon") or set the map column in the inspector.</Caption1></div>;
  return <GeoJsonMap geojson={fc} height={Math.max(160, height - 44)} layers={[{ id: 'pts', type: 'point' }]} />;
}

// ───────────────────────── pivot ─────────────────────────

function PivotBody({ id, widget, variables, runtime, readOnly }: BodyProps) {
  const s = useStyles();
  const res = useWidgetRows(id, widget, variables, runtime, readOnly);
  if (!widget.entityType) return <div className={s.empty}><Caption1>Pick an object type in the inspector.</Caption1></div>;
  if (!widget.pivotRowField || !widget.pivotColField) return <div className={s.empty}><Caption1>Set the row + column fields in the inspector to build the pivot.</Caption1></div>;
  if (!readOnly) return <div className={s.empty}><Caption1>Switch to Preview to load real rows.</Caption1></div>;
  if (res.loading) return <div className={s.empty}><Spinner size="tiny" label="Reading…" labelPosition="after" /></div>;
  if (res.error || res.gate) return <GateOrError res={res} />;
  const p = pivotShape(res.columns || [], res.rows || [], widget.pivotRowField, widget.pivotColField, widget.pivotAggFn || 'count', widget.pivotAggColumn);
  if (!p.rowKeys.length) return <div className={s.empty}><Caption1>No rows to pivot.</Caption1></div>;
  const fmt = (n: number) => Number.isInteger(n) ? n.toLocaleString() : n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return (
    <div className={s.tableWrap}>
      <Table size="small" aria-label={`Pivot of ${widget.entityType} by ${widget.pivotRowField} × ${widget.pivotColField}`}>
        <TableHeader>
          <TableRow>
            <TableHeaderCell>{widget.pivotRowField}</TableHeaderCell>
            {p.colKeys.map((c) => <TableHeaderCell key={c} className={s.pivotTh}>{c || '—'}</TableHeaderCell>)}
            <TableHeaderCell className={s.pivotTh}>Total</TableHeaderCell>
          </TableRow>
        </TableHeader>
        <TableBody>
          {p.rowKeys.map((rk) => (
            <TableRow key={rk}>
              <TableCell className={s.pivotRowHead}>{rk || '—'}</TableCell>
              {p.colKeys.map((ck) => <TableCell key={ck} className={s.pivotTh}>{fmt(p.cells[rk][ck])}</TableCell>)}
              <TableCell className={s.pivotTh}><strong>{fmt(p.rowTotals[rk])}</strong></TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

// ───────────────────────── timeline ─────────────────────────

function TimelineBody({ id, widget, variables, runtime, readOnly }: BodyProps) {
  const s = useStyles();
  const res = useWidgetRows(id, widget, variables, runtime, readOnly);
  if (!widget.entityType) return <div className={s.empty}><Caption1>Pick an object type in the inspector.</Caption1></div>;
  if (!widget.timeColumn) return <div className={s.empty}><Caption1>Set the time column in the inspector to order the events.</Caption1></div>;
  if (!readOnly) return <div className={s.empty}><Caption1>Switch to Preview to load real rows.</Caption1></div>;
  if (res.loading) return <div className={s.empty}><Spinner size="tiny" label="Reading…" labelPosition="after" /></div>;
  if (res.error || res.gate) return <GateOrError res={res} />;
  const events = timelineShape(res.columns || [], res.rows || [], widget.timeColumn, widget.labelColumn);
  if (!events.length) return <div className={s.empty}><Caption1><Timeline20Regular /> No rows have a parseable date in "{widget.timeColumn}".</Caption1></div>;
  return (
    <div className={s.timeline}>
      <div className={s.tlRail} aria-hidden />
      {events.slice(0, 200).map((e, i) => (
        <div key={i} className={s.tlRow}>
          <span className={s.tlDot} aria-hidden />
          <Caption1 className={s.hint}>{new Date(e.ms).toLocaleString()}</Caption1>
          <Body1>{e.label}</Body1>
        </div>
      ))}
    </div>
  );
}

// ───────────────────────── object-view ─────────────────────────

function ObjectViewBody({ widget, ontologyId, runtime }: BodyProps) {
  const s = useStyles();
  const vid = resolveKeyValue(widget, runtime);
  if (!widget.entityType) return <div className={s.empty}><Caption1>Pick an object type in the inspector.</Caption1></div>;
  if (!ontologyId) return <div className={s.empty}><Caption1><Eye20Regular /> Bind an ontology to the app to drill into objects.</Caption1></div>;
  if (!widget.keyVariableId) return <div className={s.empty}><Caption1>Set a "selected object" variable in the inspector — its value is the object to view.</Caption1></div>;
  if (!vid) return <div className={s.empty}><Caption1>No object selected. A table row-select (or filter) sets the bound variable, then the detail loads here.</Caption1></div>;
  return (
    <div className={s.fill} style={{ overflow: 'auto' }}>
      <ObjectViewPanel ontologyId={ontologyId} objectType={widget.entityType} vertexId={vid} onClose={() => { /* embedded — nav owned by the host page */ }} />
    </div>
  );
}

// ───────────────────────── links ─────────────────────────

interface LinkNeighbor { id: string; objectType: string; properties: Record<string, unknown> }
interface LinkSection { key: string; label: string; direction: 'in' | 'out'; count: number; neighbors: LinkNeighbor[] }

function LinksBody({ widget, ontologyId, runtime, readOnly }: BodyProps) {
  const s = useStyles();
  const vid = resolveKeyValue(widget, runtime);
  const [state, setState] = useState<{ loading?: boolean; error?: string; sections?: LinkSection[] }>({});
  useEffect(() => {
    if (!readOnly || !ontologyId || !widget.entityType || !vid) { setState({}); return; }
    let cancelled = false;
    setState({ loading: true });
    (async () => {
      try {
        const r = await clientFetch(`/api/items/ontology/${encodeURIComponent(ontologyId)}/objects/${encodeURIComponent(vid)}/view?objectType=${encodeURIComponent(widget.entityType!)}`);
        const j = await r.json().catch(() => ({}));
        if (cancelled) return;
        if (!j?.ok) { setState({ error: j?.error || `HTTP ${r.status}` }); return; }
        setState({ sections: Array.isArray(j.linked) ? j.linked : [] });
      } catch (e: unknown) { if (!cancelled) setState({ error: e instanceof Error ? e.message : String(e) }); }
    })();
    return () => { cancelled = true; };
  }, [readOnly, ontologyId, widget.entityType, vid]);

  if (!widget.entityType) return <div className={s.empty}><Caption1>Pick an object type in the inspector.</Caption1></div>;
  if (!ontologyId) return <div className={s.empty}><Caption1><Link20Regular /> Bind an ontology to traverse links.</Caption1></div>;
  if (!widget.keyVariableId) return <div className={s.empty}><Caption1>Set a "selected object" variable — its value is the object whose links load here.</Caption1></div>;
  if (!readOnly) return <div className={s.empty}><Caption1>Switch to Preview to traverse real links.</Caption1></div>;
  if (!vid) return <div className={s.empty}><Caption1>No object selected. A table row-select sets the bound variable, then linked objects load here.</Caption1></div>;
  if (state.loading) return <div className={s.empty}><Spinner size="tiny" label="Traversing…" labelPosition="after" /></div>;
  if (state.error) return <MessageBar intent="error"><MessageBarBody>{state.error}</MessageBarBody></MessageBar>;
  if (!state.sections || !state.sections.length) return <div className={s.empty}><Caption1>No linked objects for this instance.</Caption1></div>;
  const previewProps = (p: Record<string, unknown>) => Object.entries(p || {}).filter(([k]) => !k.startsWith('_')).slice(0, 3).map(([k, v]) => `${k}: ${v ?? ''}`).join(' · ');
  return (
    <div className={s.fill} style={{ overflow: 'auto' }}>
      {state.sections.map((sec) => (
        <div key={sec.key} className={s.linkSec}>
          <div className={s.linkHead}>
            <Subtitle2>{sec.label}</Subtitle2>
            <Badge appearance="tint" color={sec.direction === 'out' ? 'brand' : 'informative'}>{sec.direction}</Badge>
            <Badge appearance="outline">{sec.count}</Badge>
          </div>
          {sec.neighbors.slice(0, 25).map((n) => (
            <div key={n.id} className={s.neighbor}>
              <Caption1><strong>{n.objectType}</strong> · {n.id}</Caption1>
              {previewProps(n.properties) && <Caption1 className={s.hint}>{previewProps(n.properties)}</Caption1>}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

// ───────────────────────── aip-copilot ─────────────────────────

function CopilotBody({ id, widget, ontologyId, entityTypes, variables }: BodyProps) {
  const s = useStyles();
  // Ground the per-surface Copilot in this app's ontology + variables + hint.
  useEffect(() => {
    registerCopilotContext({
      slug: 'default',
      payload: {
        itemId: id,
        surface: 'workshop-app',
        ontologyId: ontologyId || '(none bound)',
        objectTypes: (entityTypes || []).join(', '),
        variables: (variables || []).map((v) => `${v.name} (${v.type})`).join(', '),
        ...(widget.copilotHint ? { hint: widget.copilotHint } : {}),
      },
    });
  }, [id, ontologyId, entityTypes, variables, widget.copilotHint]);
  const open = useCallback(() => { window.dispatchEvent(new Event('csaloom:open-copilot')); }, []);
  return (
    <div className={s.copilotCard}>
      <Subtitle2><BrainCircuit20Regular /> AIP Copilot</Subtitle2>
      <Caption1 className={s.hint}>
        Grounded in this app{ontologyId ? '’s bound ontology' : ''} and its {(entityTypes || []).length} object type{(entityTypes || []).length === 1 ? '' : 's'} + {(variables || []).length} variable{(variables || []).length === 1 ? '' : 's'}. Ask it to explain data, draft a filter, or suggest a page.
      </Caption1>
      <Button appearance="primary" icon={<BrainCircuit20Regular />} onClick={open}>Ask AIP Copilot</Button>
    </div>
  );
}

// ───────────────────────── dispatcher ─────────────────────────

export interface BodyProps {
  id: string;
  widget: WorkshopWidget;
  ontologyId?: string;
  entityTypes?: string[];
  variables: WorkshopVariable[];
  runtime: Record<string, unknown>;
  readOnly: boolean;
  height: number;
}

/** Render a WS-4.5 advanced widget body. The builder delegates the 6 kinds here. */
export function AdvancedWidgetBody(props: BodyProps): ReactNode {
  switch (props.widget.kind) {
    case 'object-view': return <ObjectViewBody {...props} />;
    case 'links': return <LinksBody {...props} />;
    case 'map': return <MapBody {...props} />;
    case 'pivot': return <PivotBody {...props} />;
    case 'timeline': return <TimelineBody {...props} />;
    case 'aip-copilot': return <CopilotBody {...props} />;
    default: return null;
  }
}

// ───────────────────────── inspector fragments ─────────────────────────

export function AdvancedWidgetInspector({
  widget, variables, columns, onChange,
}: {
  widget: WorkshopWidget; variables: WorkshopVariable[]; columns: string[];
  onChange: (patch: Partial<WorkshopWidget>) => void;
}) {
  const scalarVars = variables.filter((v) => v.type !== 'object-set-filter');
  const colOpts = (val: string | undefined, key: keyof WorkshopWidget, label: string, hint?: string) => (
    <Field label={label} hint={hint}>
      <Dropdown value={val || ''} selectedOptions={val ? [val] : []} placeholder={columns.length ? 'Select column' : 'Select an object type first'}
        onOptionSelect={(_, d) => onChange({ [key]: d.optionValue || undefined } as Partial<WorkshopWidget>)}>
        {columns.map((c) => <Option key={c} value={c}>{c}</Option>)}
      </Dropdown>
    </Field>
  );

  return (
    <>
      {(widget.kind === 'object-view' || widget.kind === 'links') && (
        <Field label="Selected-object variable" hint="A string variable whose live value is the object id to drill into (set it from a table row-select event).">
          <Dropdown value={scalarVars.find((v) => v.id === widget.keyVariableId)?.name || ''} selectedOptions={widget.keyVariableId ? [widget.keyVariableId] : []}
            placeholder={scalarVars.length ? 'Select variable' : 'Add a string variable first'}
            onOptionSelect={(_, d) => onChange({ keyVariableId: d.optionValue || undefined })}>
            {scalarVars.map((v) => <Option key={v.id} value={v.id} text={v.name}>{v.name}</Option>)}
          </Dropdown>
        </Field>
      )}
      {widget.kind === 'map' && colOpts(widget.geoColumn, 'geoColumn', 'Geo column (optional)', 'Column holding a geopoint / geoshape ("lat,lon", {lat,lon}, or GeoJSON). Auto-detected when unset.')}
      {widget.kind === 'pivot' && (
        <>
          {colOpts(widget.pivotRowField, 'pivotRowField', 'Rows (group by)')}
          {colOpts(widget.pivotColField, 'pivotColField', 'Columns (group by)')}
          <Field label="Aggregation">
            <Dropdown value={widget.pivotAggFn || 'count'} selectedOptions={[widget.pivotAggFn || 'count']} onOptionSelect={(_, d) => onChange({ pivotAggFn: (d.optionValue as WorkshopAggFn) || 'count' })}>
              {AGG_FNS.map((a) => <Option key={a} value={a}>{a}</Option>)}
            </Dropdown>
          </Field>
          {widget.pivotAggFn && widget.pivotAggFn !== 'count' && colOpts(widget.pivotAggColumn, 'pivotAggColumn', 'Measure column')}
        </>
      )}
      {widget.kind === 'timeline' && (
        <>
          {colOpts(widget.timeColumn, 'timeColumn', 'Time column', 'The date/timestamp column that orders events.')}
          {colOpts(widget.labelColumn, 'labelColumn', 'Label column (optional)', 'Shown per event; defaults to the first non-time column.')}
        </>
      )}
      {widget.kind === 'aip-copilot' && (
        <Field label="Grounding hint (optional)" hint="Extra context handed to the Copilot alongside the app's ontology + variables.">
          <Textarea value={widget.copilotHint || ''} onChange={(_, d) => onChange({ copilotHint: d.value })} rows={3} resize="vertical" placeholder="e.g. This app tracks field-service work orders." />
        </Field>
      )}
    </>
  );
}

// ───────────────────────── conditional-visibility wizard ─────────────────────────

export function VisibilityRuleField({
  rule, variables, onChange,
}: {
  rule: WorkshopVisibilityRule | undefined; variables: WorkshopVariable[]; onChange: (rule: WorkshopVisibilityRule | undefined) => void;
}) {
  const s = useStyles();
  const enabled = !!rule?.variableId;
  return (
    <Field label="Show this widget when" hint="Conditional visibility — the widget hides in Run mode unless the rule holds (no code, wizard-driven).">
      <div className={s.visRow}>
        <Dropdown value={variables.find((v) => v.id === rule?.variableId)?.name || 'Always visible'} selectedOptions={rule?.variableId ? [rule.variableId] : ['__always__']}
          onOptionSelect={(_, d) => {
            if (!d.optionValue || d.optionValue === '__always__') { onChange(undefined); return; }
            onChange({ variableId: d.optionValue, op: rule?.op || 'notEmpty', value: rule?.value });
          }}>
          <Option value="__always__" text="Always visible">Always visible</Option>
          {variables.map((v) => <Option key={v.id} value={v.id} text={v.name}>{v.name}</Option>)}
        </Dropdown>
        {enabled && (
          <Dropdown value={VIS_OP_LABEL[rule!.op]} selectedOptions={[rule!.op]} onOptionSelect={(_, d) => onChange({ ...rule!, op: (d.optionValue as WorkshopVisibilityOp) || 'notEmpty' })}>
            {VIS_OPS.map((o) => <Option key={o} value={o} text={VIS_OP_LABEL[o]}>{VIS_OP_LABEL[o]}</Option>)}
          </Dropdown>
        )}
        {enabled && (rule!.op === 'eq' || rule!.op === 'ne') && (
          <Input value={rule!.value || ''} onChange={(_, d) => onChange({ ...rule!, value: d.value })} placeholder="Comparison value" />
        )}
      </div>
    </Field>
  );
}

// ───────────────────────── page strip (multi-page nav + management) ─────────────────────────

const OVERLAY_STYLES: WorkshopOverlayStyle[] = ['drawer', 'modal'];

export function PageStrip({
  pages, currentPageId, readOnly, onSelect, onPagesChange,
}: {
  pages: WorkshopPage[]; currentPageId: string; readOnly: boolean;
  onSelect: (id: string) => void; onPagesChange: (next: WorkshopPage[]) => void;
}) {
  const s = useStyles();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const resolved = resolvePages(pages);
  // Run mode: only navigable pages appear in the app nav (overlays open via events).
  const shown = readOnly ? resolved.filter((p) => p.kind === 'page') : resolved;

  const addPage = (kind: WorkshopPage['kind']) => {
    const n = resolved.filter((p) => p.kind === kind).length + 1;
    const page: WorkshopPage = { id: `pg_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`, name: kind === 'overlay' ? `Overlay ${n}` : `Page ${n}`, kind, ...(kind === 'overlay' ? { overlayStyle: 'drawer' as const } : {}) };
    onPagesChange([...resolved, page]);
    onSelect(page.id);
  };
  const patchPage = (id: string, patch: Partial<WorkshopPage>) => onPagesChange(resolved.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  const removePage = (id: string) => {
    const next = resolved.filter((p) => p.id !== id);
    onPagesChange(next);
    if (currentPageId === id) onSelect((next.find((p) => p.kind === 'page') || next[0])?.id || '');
  };

  return (
    <div className={s.pageStrip}>
      <TabList selectedValue={currentPageId} onTabSelect={(_, d) => onSelect(d.value as string)}>
        {shown.map((p) => (
          <Tab key={p.id} value={p.id} icon={p.kind === 'overlay' ? <Open20Regular /> : undefined}>
            {renaming === p.id ? (
              <Input size="small" autoFocus value={draft} onChange={(_, d) => setDraft(d.value)}
                onBlur={() => { if (draft.trim()) patchPage(p.id, { name: draft.trim() }); setRenaming(null); }}
                onKeyDown={(e) => { if (e.key === 'Enter') { if (draft.trim()) patchPage(p.id, { name: draft.trim() }); setRenaming(null); } }} />
            ) : p.name}
          </Tab>
        ))}
      </TabList>
      {!readOnly && (
        <>
          <Menu>
            <MenuTrigger disableButtonEnhancement><Button size="small" appearance="subtle" icon={<Add20Regular />}>Add page</Button></MenuTrigger>
            <MenuPopover><MenuList>
              <MenuItem onClick={() => addPage('page')}>Page (nav)</MenuItem>
              <MenuItem onClick={() => addPage('overlay')}>Overlay (drawer / modal)</MenuItem>
            </MenuList></MenuPopover>
          </Menu>
          {currentPageId && resolved.some((p) => p.id === currentPageId) && (
            <Menu>
              <MenuTrigger disableButtonEnhancement><Button size="small" appearance="subtle" icon={<MoreHorizontal20Regular />} aria-label="Page options" /></MenuTrigger>
              <MenuPopover><MenuList>
                <MenuItem onClick={() => { const p = resolved.find((x) => x.id === currentPageId)!; setDraft(p.name); setRenaming(currentPageId); }}>Rename</MenuItem>
                {(() => { const p = resolved.find((x) => x.id === currentPageId)!; return p.kind === 'overlay' ? (
                  <MenuItem onClick={() => patchPage(p.id, { overlayStyle: p.overlayStyle === 'modal' ? 'drawer' : 'modal' })}>
                    Style: {p.overlayStyle === 'modal' ? 'Modal → Drawer' : 'Drawer → Modal'}
                  </MenuItem>
                ) : null; })()}
                <MenuItem disabled={resolved.length <= 1} icon={<Dismiss16Regular />} onClick={() => removePage(currentPageId)}>Delete page</MenuItem>
              </MenuList></MenuPopover>
            </Menu>
          )}
        </>
      )}
    </div>
  );
}

// ───────────────────────── overlay host (Run mode) ─────────────────────────

/** Render an open overlay page as a Fluent Drawer or Dialog, its widgets from `renderPage`. */
export function OverlayHost({
  overlay, onClose, renderPage,
}: {
  overlay: WorkshopPage | null; onClose: () => void; renderPage: (pageId: string) => ReactNode;
}) {
  if (!overlay) return null;
  if (overlay.overlayStyle === 'modal') {
    return (
      <Dialog open onOpenChange={(_, d) => { if (!d.open) onClose(); }}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>{overlay.name}</DialogTitle>
            <DialogContent>{renderPage(overlay.id)}</DialogContent>
            <DialogActions><Button appearance="secondary" onClick={onClose}>Close</Button></DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    );
  }
  return (
    <Drawer type="overlay" position="end" open onOpenChange={(_, d) => { if (!d.open) onClose(); }} size="medium">
      <DrawerHeader>
        <DrawerHeaderTitle action={<Button appearance="subtle" aria-label="Close overlay" icon={<Dismiss16Regular />} onClick={onClose} />}>{overlay.name}</DrawerHeaderTitle>
      </DrawerHeader>
      <DrawerBody>{renderPage(overlay.id)}</DrawerBody>
    </Drawer>
  );
}
