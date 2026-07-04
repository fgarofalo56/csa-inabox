'use client';

import { clientFetch } from '@/lib/client-fetch';
/**
 * KqlDashboardEditor — extracted from phase3-editors.tsx (byte-for-byte move).
 *
 * Fabric Real-Time Dashboard parity on the Azure-native ADX cluster (no Fabric
 * required): a tile grid with per-tile KQL bound to a data source + visual type
 * rendering REAL Kusto results, a data-sources panel, dashboard parameters
 * substituted into tile KQL, auto/manual refresh, and Save persisting the model
 * to Cosmos via /api/items/kql-dashboard/[id]. The editor's exclusive helpers
 * (Dash* types, DashboardState, TIME_ORDER, TILE_VIZ_OPTIONS, REFRESH_INTERVALS,
 * refreshLabel, genId, CF_*_LABELS, CfColumnField, ConditionalFormattingEditor)
 * move with it. The shared tile-render surface (TileVisual + CSV/download
 * helpers + KqlResult / TileViz models) is imported from ./kql-results; the
 * shared phase3 styles hook from ./styles. phase3-editors.tsx re-exports
 * KqlDashboardEditor from a barrel line so the registry resolves it unchanged.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Caption1, Badge, Button, Input, Spinner, Field, Link,
  MessageBar, MessageBarBody, MessageBarTitle, MessageBarActions,
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  Label, Select, Textarea, Switch,
  mergeClasses, tokens,
} from '@fluentui/react-components';
import {
  Database20Regular, Play20Regular, Save20Regular,
  Add20Regular, Delete20Regular, ArrowSync20Regular,
  MathFormula20Regular, Sparkle20Regular, ArrowDownload20Regular, Copy20Regular,
  Alert20Regular, Open20Regular,
} from '@fluentui/react-icons';
import { ItemEditorChrome } from '../item-editor-chrome';
import { NewItemCreateGate } from '../new-item-gate';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';
import { MonacoTextarea } from '@/lib/components/editor/monaco-textarea';
import {
  CF_OPERATORS, CF_COLORS, CF_ICONS, CF_THEMES,
  type ConditionalRule, type CfCondition,
  type CfColor, type CfIcon, type CfOperator, type CfTheme,
} from '@/lib/azure/kql-dashboard-model';
import {
  TileVisual, kqlResultToCsv, downloadTextFile, slugifyForFile,
  type KqlResult, type TileViz,
} from './kql-results';
import { AnomalyForecastDialog } from './anomaly-forecast';
import { useStyles } from './styles';

// ----- KQL Dashboard (Fabric Real-Time Dashboard parity) -----
// A real dashboard builder: tile grid (add/remove/resize) where each tile has
// a KQL query bound to a data source + a visual type, rendering its REAL Kusto
// result; a data-sources panel; dashboard parameters (free-text / fixed /
// query-based / time range) substituted into tile KQL; per-dashboard
// auto-refresh + manual refresh; Save persists the full model to Cosmos.
// Backed by /api/items/kql-dashboard/[id] (GET ?run=1 / PUT) + /run + /param-values.

interface DashTile {
  title: string;
  kql: string;
  viz: TileViz;
  dataSourceId?: string;
  database?: string;
  w?: number; // grid column span 1..12
  h?: number; // grid row units 1..8
  conditionalRules?: ConditionalRule[];
  /** Drill-through: clicking a result value sets a dashboard parameter. */
  drillthrough?: { column: string; paramName: string };
  result?: KqlResult;
  error?: string;
}

interface DashDataSource { id: string; name: string; database: string; clusterUri?: string; }

/** A shared KQL snippet referenced by tiles via `$baseQuery('name')`. */
interface DashBaseQuery { id: string; name: string; kql: string; }

type DashParamType = 'freetext' | 'fixed' | 'multi' | 'query' | 'datasource' | 'duration';
type DashParamDataType = 'string' | 'long' | 'int' | 'real' | 'datetime' | 'bool';

interface DashParam {
  variableName: string;
  label?: string;
  type: DashParamType;
  dataType?: DashParamDataType;
  values?: string[];
  query?: string;
  dataSourceId?: string;
  value?: string | string[];
}

interface DashboardState {
  ok: boolean;
  database?: string;
  defaultDatabase?: string;
  tiles?: DashTile[];
  dataSources?: DashDataSource[];
  parameters?: DashParam[];
  baseQueries?: DashBaseQuery[];
  timeRange?: string;
  autoRefreshMs?: number;
  error?: string;
}

type TimeRangeKey = 'last-15m' | 'last-1h' | 'last-4h' | 'last-24h' | 'last-7d' | 'last-30d' | 'all';
const TIME_ORDER: TimeRangeKey[] = ['last-15m', 'last-1h', 'last-4h', 'last-24h', 'last-7d', 'last-30d', 'all'];

const TILE_VIZ_OPTIONS: TileViz[] = ['table', 'timechart', 'line', 'column', 'bar', 'pie', 'stat', 'map'];

// Auto-refresh interval choices (Fabric "Manage > Auto refresh" exposes an
// explicit minimum interval + default rate). The ADX /v1/rest/query round-trip
// is 2–10s, so the tightest live cadences (5s/30s) are paired with an in-flight
// guard in the auto-refresh effect below: a tick is SKIPPED while the previous
// runAll() is still resolving, so a slow cluster can never pile up overlapping
// queries. Matches the Fabric Real-Time Dashboard continuous-refresh behavior.
const REFRESH_INTERVALS: { ms: number; label: string }[] = [
  { ms: 0,         label: 'Off' },
  { ms: 5_000,     label: '5 seconds' },
  { ms: 30_000,    label: '30 seconds' },
  { ms: 60_000,    label: '1 minute' },
  { ms: 300_000,   label: '5 minutes' },
  { ms: 1_800_000, label: '30 minutes' },
  { ms: 3_600_000, label: '1 hour' },
];

function refreshLabel(ms: number): string {
  const hit = REFRESH_INTERVALS.find((r) => r.ms === ms);
  if (!ms) return 'Auto-refresh: off';
  return `Auto-refresh: ${hit ? hit.label : `${ms / 1000}s`}`;
}

function genId(): string {
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  } catch { /* noop */ }
  return 'ds-' + Math.random().toString(36).slice(2, 10);
}

const CF_COLOR_LABELS: Record<CfColor, string> = { red: 'Red', yellow: 'Yellow', green: 'Green', blue: 'Blue' };
const CF_ICON_LABELS: Record<CfIcon, string> = { warning: 'Warning', error: 'Error', success: 'Success', info: 'Info' };
const CF_THEME_LABELS: Record<CfTheme, string> = {
  'traffic-lights': 'Traffic lights', cold: 'Cold', warm: 'Warm', blue: 'Blue', red: 'Red', yellow: 'Yellow',
};

/** A column field — Select when the live result has columns, else a free Input. */
function CfColumnField({ value, columns, onChange, label }: { value: string; columns: string[]; onChange: (v: string) => void; label: string }) {
  if (columns.length > 0) {
    return (
      <Select size="small" value={value} aria-label={label} onChange={(_: unknown, d: any) => onChange(d.value)}>
        {!columns.includes(value) && <option value={value}>{value || '(pick column)'}</option>}
        {columns.map((c) => <option key={c} value={c}>{c}</option>)}
      </Select>
    );
  }
  return <Input size="small" value={value} aria-label={label} placeholder="column name" onChange={(_: unknown, d: any) => onChange(d.value)} />;
}

/**
 * Per-tile conditional-formatting rule editor (Fabric Real-Time Dashboard
 * parity). Supports "Color by condition" (threshold → color/icon/tag, AND-ed
 * conditions, cells-or-row) and table-only "Color by value" (gradient theme).
 * Every field is a dropdown / typed Input — no freeform JSON (operator
 * no-freeform-config mandate). Rules apply client-side at render time.
 */
function ConditionalFormattingEditor({ viz, rules, columns, onChange }: {
  viz: 'table' | 'stat';
  rules: ConditionalRule[];
  columns: string[];
  onChange: (rules: ConditionalRule[]) => void;
}) {
  const isTable = viz === 'table';
  const update = (idx: number, patch: Partial<ConditionalRule>) =>
    onChange(rules.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  const removeRule = (idx: number) => onChange(rules.filter((_, i) => i !== idx));
  const addRule = (type: 'condition' | 'value') => {
    const col = columns[0] || '';
    const base: ConditionalRule = type === 'condition'
      ? { type, color: 'red', colorStyle: 'bold', applyTo: 'cells', conditions: [{ column: col, operator: '>', value: '' }] }
      : { type, theme: 'traffic-lights', column: col, applyTo: 'cells' };
    onChange([...rules, base]);
  };
  const updateCond = (ri: number, ci: number, patch: Partial<CfCondition>) =>
    onChange(rules.map((r, i) => (i === ri ? { ...r, conditions: (r.conditions || []).map((c, j) => (j === ci ? { ...c, ...patch } : c)) } : r)));
  const addCond = (ri: number) =>
    onChange(rules.map((r, i) => (i === ri ? { ...r, conditions: [...(r.conditions || []), { column: columns[0] || '', operator: '>', value: '' }] } : r)));
  const removeCond = (ri: number, ci: number) =>
    onChange(rules.map((r, i) => (i === ri ? { ...r, conditions: (r.conditions || []).filter((_, j) => j !== ci) } : r)));

  const fieldRow: React.CSSProperties = { display: 'flex', gap: tokens.spacingVerticalS, alignItems: 'center', flexWrap: 'wrap' };
  return (
    <div style={{ border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge, padding: tokens.spacingVerticalS, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, background: tokens.colorNeutralBackground2 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: tokens.spacingVerticalS, flexWrap: 'wrap' }}>
        <Caption1 style={{ fontWeight: 600 }}>Conditional formatting</Caption1>
        <div style={{ display: 'flex', gap: tokens.spacingVerticalXS}}>
          <Button size="small" icon={<Add20Regular />} onClick={() => addRule('condition')}>Color by condition</Button>
          {isTable && <Button size="small" icon={<Add20Regular />} onClick={() => addRule('value')}>Color by value</Button>}
        </div>
      </div>
      {columns.length === 0 && (
        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Run the tile first to pick columns from its real result. You can still type column names below.</Caption1>
      )}
      {rules.length === 0 && (
        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>No rules — cells render unstyled. Add a rule to color cells by a data threshold.</Caption1>
      )}
      {rules.map((rule, ri) => (
        <div key={ri} style={{ border: `1px solid ${tokens.colorNeutralStroke3}`, borderRadius: tokens.borderRadiusMedium, padding: tokens.spacingVerticalS, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, background: tokens.colorNeutralBackground1 }}>
          <div style={{ display: 'flex', gap: tokens.spacingVerticalS, alignItems: 'center', justifyContent: 'space-between' }}>
            <Badge appearance="outline" color={rule.type === 'value' ? 'informative' : 'brand'}>{rule.type === 'value' ? 'Color by value' : 'Color by condition'}</Badge>
            <Input size="small" style={{ flex: 1 }} value={rule.name || ''} placeholder={`Rule ${ri + 1} name (optional)`} aria-label={`Rule ${ri + 1} name`} onChange={(_: unknown, d: any) => update(ri, { name: d.value || undefined })} />
            <Button size="small" appearance="subtle" icon={<Delete20Regular />} aria-label={`Delete rule ${ri + 1}`} onClick={() => removeRule(ri)} />
          </div>

          {rule.type === 'condition' ? (
            <>
              {(rule.conditions || []).map((cond, ci) => (
                <div key={ci} style={fieldRow}>
                  {ci > 0 && <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>AND</Caption1>}
                  <div style={{ minWidth: 130 }}>
                    <CfColumnField label={`Rule ${ri + 1} condition ${ci + 1} column`} value={cond.column} columns={columns} onChange={(v) => updateCond(ri, ci, { column: v })} />
                  </div>
                  <Select size="small" value={cond.operator} aria-label={`Rule ${ri + 1} condition ${ci + 1} operator`} onChange={(_: unknown, d: any) => updateCond(ri, ci, { operator: d.value as CfOperator })}>
                    {CF_OPERATORS.map((op) => <option key={op} value={op}>{op}</option>)}
                  </Select>
                  <Input
                    size="small"
                    style={{ width: 110 }}
                    value={cond.value || ''}
                    aria-label={`Rule ${ri + 1} condition ${ci + 1} value`}
                    placeholder="value"
                    disabled={cond.operator === 'is empty' || cond.operator === 'is not empty'}
                    onChange={(_: unknown, d: any) => updateCond(ri, ci, { value: d.value })}
                  />
                  {(rule.conditions || []).length > 1 && (
                    <Button size="small" appearance="subtle" icon={<Delete20Regular />} aria-label={`Remove condition ${ci + 1}`} onClick={() => removeCond(ri, ci)} />
                  )}
                </div>
              ))}
              <div>
                <Button size="small" appearance="subtle" icon={<Add20Regular />} onClick={() => addCond(ri)}>Add condition</Button>
              </div>
              <div style={fieldRow}>
                <Label size="small">Color</Label>
                <Select size="small" value={rule.color || 'red'} aria-label={`Rule ${ri + 1} color`} onChange={(_: unknown, d: any) => update(ri, { color: d.value as CfColor })}>
                  {CF_COLORS.map((c) => <option key={c} value={c}>{CF_COLOR_LABELS[c]}</option>)}
                </Select>
                <Label size="small">Style</Label>
                <Select size="small" value={rule.colorStyle || 'bold'} aria-label={`Rule ${ri + 1} style`} onChange={(_: unknown, d: any) => update(ri, { colorStyle: d.value as 'bold' | 'light' })}>
                  <option value="bold">Bold</option>
                  <option value="light">Light</option>
                </Select>
                <Label size="small">Icon</Label>
                <Select size="small" value={rule.icon || ''} aria-label={`Rule ${ri + 1} icon`} onChange={(_: unknown, d: any) => update(ri, { icon: (d.value || undefined) as CfIcon | undefined })}>
                  <option value="">None</option>
                  {CF_ICONS.map((ic) => <option key={ic} value={ic}>{CF_ICON_LABELS[ic]}</option>)}
                </Select>
                <Label size="small">Tag</Label>
                <Input size="small" style={{ width: 110 }} value={rule.tag || ''} placeholder="optional" aria-label={`Rule ${ri + 1} tag`} onChange={(_: unknown, d: any) => update(ri, { tag: d.value || undefined })} />
              </div>
            </>
          ) : (
            <div style={fieldRow}>
              <Label size="small">Column</Label>
              <div style={{ minWidth: 130 }}>
                <CfColumnField label={`Rule ${ri + 1} value column`} value={rule.column || ''} columns={columns} onChange={(v) => update(ri, { column: v })} />
              </div>
              <Label size="small">Theme</Label>
              <Select size="small" value={rule.theme || 'traffic-lights'} aria-label={`Rule ${ri + 1} theme`} onChange={(_: unknown, d: any) => update(ri, { theme: d.value as CfTheme })}>
                {CF_THEMES.map((th) => <option key={th} value={th}>{CF_THEME_LABELS[th]}</option>)}
              </Select>
              <Label size="small">Min</Label>
              <Input size="small" type="number" style={{ width: 80 }} value={rule.minValue ?? '' as any} placeholder="auto" aria-label={`Rule ${ri + 1} min`} onChange={(_: unknown, d: any) => update(ri, { minValue: d.value === '' ? undefined : Number(d.value) })} />
              <Label size="small">Max</Label>
              <Input size="small" type="number" style={{ width: 80 }} value={rule.maxValue ?? '' as any} placeholder="auto" aria-label={`Rule ${ri + 1} max`} onChange={(_: unknown, d: any) => update(ri, { maxValue: d.value === '' ? undefined : Number(d.value) })} />
              <Switch label="Reverse" checked={!!rule.reverseColors} aria-label={`Rule ${ri + 1} reverse colors`} onChange={(_: unknown, d: any) => update(ri, { reverseColors: d.checked || undefined })} />
            </div>
          )}

          {isTable && (
            <div style={fieldRow}>
              <Label size="small">Apply to</Label>
              <Select size="small" value={rule.applyTo || 'cells'} aria-label={`Rule ${ri + 1} apply to`} onChange={(_: unknown, d: any) => update(ri, { applyTo: d.value as 'cells' | 'row' })}>
                <option value="cells">Matched cells</option>
                <option value="row">Entire row</option>
              </Select>
              {(rule.applyTo || 'cells') === 'cells' && (
                <>
                  <Label size="small">Target column</Label>
                  <Select size="small" value={rule.targetColumn || ''} aria-label={`Rule ${ri + 1} target column`} onChange={(_: unknown, d: any) => update(ri, { targetColumn: d.value || undefined })}>
                    <option value="">{rule.type === 'value' ? '(graded column)' : '(all conditioned columns)'}</option>
                    {columns.map((c) => <option key={c} value={c}>{c}</option>)}
                  </Select>
                  <Switch label="Hide text" checked={!!rule.hideText} aria-label={`Rule ${ri + 1} hide text`} onChange={(_: unknown, d: any) => update(ri, { hideText: d.checked || undefined })} />
                </>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export function KqlDashboardEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const [state, setState] = useState<DashboardState | null>(null);
  const [tiles, setTiles] = useState<DashTile[]>([]);
  const [dataSources, setDataSources] = useState<DashDataSource[]>([]);
  const [params, setParams] = useState<DashParam[]>([]);
  const [baseQueries, setBaseQueries] = useState<DashBaseQuery[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  // True while a runAll() ADX requery is in flight. Read synchronously inside
  // the auto-refresh interval so a tight cadence (5s/30s) skips a tick rather
  // than stacking overlapping /run round-trips against a slow cluster.
  const runInFlightRef = useRef(false);
  // Wall-clock of the last successful auto/manual refresh — surfaced in the
  // toolbar so the user can see the live cadence is actually firing.
  const [lastRefreshedAt, setLastRefreshedAt] = useState<number | null>(null);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  // Index of the tile whose edit flyout (Dialog) is open, or null. Mirrors the
  // Fabric Real-Time Dashboard "tile editing window" — a single side panel that
  // edits one tile at a time, rather than expanding the card inline.
  const [tileFlyoutIdx, setTileFlyoutIdx] = useState<number | null>(null);
  const [jsonOpen, setJsonOpen] = useState(false);
  const [jsonText, setJsonText] = useState('');
  const [jsonErr, setJsonErr] = useState<string | null>(null);
  const [autoRefreshMs, setAutoRefreshMs] = useState(0);
  const [timeRange, setTimeRange] = useState<TimeRangeKey>('last-24h');
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [paramsOpen, setParamsOpen] = useState(false);
  const [baseQueriesOpen, setBaseQueriesOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  // AI tile generator (NL → KQL) — Fabric RTI "Copilot add a tile" parity.
  const [aiOpen, setAiOpen] = useState(false);
  const [aiPrompt, setAiPrompt] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [aiErr, setAiErr] = useState<string | null>(null);
  const [aiNote, setAiNote] = useState<string | null>(null);
  const [aiDataSourceId, setAiDataSourceId] = useState('');
  // Anomaly/forecast tile builder — native-KQL time-series ML (series_decompose)
  // over the Azure-native ADX cluster. Composes the tile's KQL, no Fabric.
  const [anomalyOpen, setAnomalyOpen] = useState(false);
  // Set-alert-on-tile (Fabric RTD "Set alert" parity): the per-tile action
  // creates a REAL Activator rule (sourceKind:'adx') from the tile's KQL on the
  // ADX-native Activator runtime — lazily creating + linking a backing
  // Activator item (state.activatorId), same pattern as the Eventstream
  // "Add alert" quick-create. Azure-native default; no Fabric Reflex.
  const [alertTileIdx, setAlertTileIdx] = useState<number | null>(null);
  const [alertName, setAlertName] = useState('');
  const [alertFireOn, setAlertFireOn] = useState<'rows' | 'condition'>('rows');
  const [alertColumn, setAlertColumn] = useState('');
  const [alertOperator, setAlertOperator] = useState<'gt' | 'lt' | 'gte' | 'lte' | 'eq' | 'ne' | 'contains'>('gt');
  const [alertThreshold, setAlertThreshold] = useState('0');
  const [alertFrequency, setAlertFrequency] = useState<'PT1M' | 'PT5M' | 'PT15M' | 'PT1H'>('PT5M');
  const [alertEmail, setAlertEmail] = useState('');
  const [alertBusy, setAlertBusy] = useState(false);
  const [alertErr, setAlertErr] = useState<string | null>(null);
  const [alertHint, setAlertHint] = useState<string | null>(null);
  const [alertResult, setAlertResult] = useState<{
    activatorId: string; activatorName?: string; ruleId: string; database?: string;
    scheduled?: boolean; note?: string;
    preview?: { count: number; fired: boolean }; previewError?: string;
  } | null>(null);
  // Query-based param value caches: variableName → string[]
  const [paramValueCache, setParamValueCache] = useState<Record<string, string[]>>({});
  // Real KQL databases on the shared Loom ADX cluster — populates the data
  // source database dropdown so binding a source defaults to a deployed DB
  // instead of a blank free-text box (operator no-freeform mandate).
  const [clusterDbs, setClusterDbs] = useState<string[]>([]);

  const defaultDb = state?.database || state?.defaultDatabase || 'loomdb-default';

  // Build the live model the /run + /param-values + PUT routes consume.
  const buildModel = useCallback(() => ({
    tiles: tiles.map(({ result, error, ...t }) => t),
    dataSources,
    parameters: params,
    baseQueries,
    timeRange,
    autoRefreshMs,
  }), [tiles, dataSources, params, baseQueries, timeRange, autoRefreshMs]);

  // Load the saved model (GET). When runTiles, GET ?run=1 executes every tile.
  const load = useCallback(async (runTiles = false) => {
    if (!id || id === 'new') return;
    const sp = new URLSearchParams();
    if (runTiles) { sp.set('run', '1'); sp.set('time', timeRange); }
    for (const p of params) {
      if (!p.variableName) continue;
      if (Array.isArray(p.value)) p.value.forEach((v) => sp.append(`param.${p.variableName}`, v));
      else if (p.value !== undefined && p.value !== '') sp.set(`param.${p.variableName}`, String(p.value));
    }
    const qs = sp.toString();
    try {
      const r = await clientFetch(`/api/items/kql-dashboard/${id}${qs ? '?' + qs : ''}`);
      const ct = r.headers.get('content-type') || '';
      const j: DashboardState = ct.includes('application/json')
        ? await r.json()
        : { ok: false, error: `HTTP ${r.status}` };
      setState(j);
      if (j.ok) {
        setTiles(j.tiles || []);
        setDataSources(j.dataSources || []);
        setParams(j.parameters || []);
        setBaseQueries(j.baseQueries || []);
        if (typeof j.autoRefreshMs === 'number') setAutoRefreshMs(j.autoRefreshMs);
        if (j.timeRange && TIME_ORDER.includes(j.timeRange as TimeRangeKey)) setTimeRange(j.timeRange as TimeRangeKey);
        setDirty(false);
      }
    } catch (e: any) {
      setState({ ok: false, error: e?.message || String(e) });
    }
  }, [id, timeRange, params]);

  // Run the CURRENT (possibly unsaved) builder model live via POST /run.
  const runAll = useCallback(async () => {
    if (tiles.length === 0) return;
    runInFlightRef.current = true;
    setRunning(true); setSaveErr(null);
    try {
      const r = await clientFetch(`/api/items/kql-dashboard/${id}/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(buildModel()),
      });
      const ct = r.headers.get('content-type') || '';
      const j = ct.includes('application/json') ? await r.json() : { ok: false, error: `HTTP ${r.status}` };
      if (!j.ok) { setSaveErr(j.error || `run failed (HTTP ${r.status})`); return; }
      // Merge results back onto tiles by index (order preserved by /run).
      setTiles((prev) => prev.map((t, i) => ({
        ...t,
        result: j.tiles?.[i]?.result,
        error: j.tiles?.[i]?.error,
      })));
      setLastRefreshedAt(Date.now());
    } catch (e: any) {
      setSaveErr(e?.message || String(e));
    } finally {
      runInFlightRef.current = false;
      setRunning(false);
    }
  }, [id, tiles.length, buildModel]);

  // Initial load: fetch the saved model, then run it live so tiles render real data.
  useEffect(() => { load(false); /* eslint-disable-next-line */ }, [id]);
  useEffect(() => { if (state?.ok && tiles.length > 0) runAll(); /* eslint-disable-next-line */ }, [state?.ok]);

  // Fetch the real KQL databases on the shared cluster once, so data-source
  // binding is a dropdown of deployed databases (not a blank text box). Best
  // effort: if the cluster is unreachable the dialog falls back to free text.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await clientFetch('/api/items/eventhouse/cluster');
        const ct = r.headers.get('content-type') || '';
        const j = ct.includes('application/json') ? await r.json() : { ok: false };
        if (!cancelled && j.ok && Array.isArray(j.databases)) {
          setClusterDbs(j.databases.map((d: { name: string }) => d.name).filter(Boolean));
        }
      } catch { /* dropdown falls back to free text */ }
    })();
    return () => { cancelled = true; };
  }, []);

  const addTile = useCallback(() => {
    setTiles((prev) => {
      const next: DashTile[] = [...prev, {
        title: `Tile ${prev.length + 1}`,
        kql: `// KQL for this tile. Use parameters (_startTime, _endTime, or your own _vars).\nprint value = 1`,
        viz: 'table', w: 4, h: 2,
      }];
      setTileFlyoutIdx(next.length - 1);
      return next;
    });
    setDirty(true);
  }, []);

  // AI tile generator: POST the NL prompt → server grounds on the live ADX
  // schema, asks AOAI for {title, kql, viz}, validates by executing the KQL,
  // and returns a ready tile (with its first-page result inlined). We append it
  // to the grid and open its editor so the operator can review/tweak. This is
  // the Fabric Real-Time Dashboard "Copilot — add a tile from a question" flow,
  // Azure-native (ADX + AOAI), no Fabric/Power BI on the path.
  const generateTile = useCallback(async () => {
    const prompt = aiPrompt.trim();
    if (!prompt) { setAiErr('Describe the tile you want (e.g. "errors per service over time").'); return; }
    setAiBusy(true); setAiErr(null); setAiNote(null);
    try {
      const r = await clientFetch(`/api/items/kql-dashboard/${id}/generate-tile`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt, dataSourceId: aiDataSourceId || undefined, timeRange }),
      });
      const ct = r.headers.get('content-type') || '';
      const j = ct.includes('application/json') ? await r.json() : { ok: false, error: `HTTP ${r.status}` };
      if (!j.ok) { setAiErr(j.error || `generation failed (HTTP ${r.status})`); return; }
      const g = j.tile || {};
      const newTile: DashTile = {
        title: g.title || prompt.slice(0, 60),
        kql: g.kql || '',
        viz: (g.viz || 'table') as TileViz,
        dataSourceId: g.dataSourceId || undefined,
        database: g.database || undefined,
        w: g.w || 4,
        h: g.h || 2,
        result: g.result,
        error: j.validated ? undefined : (j.validationError || undefined),
      };
      let insertedIdx = 0;
      setTiles((prev) => { insertedIdx = prev.length; return [...prev, newTile]; });
      setDirty(true);
      setTileFlyoutIdx(insertedIdx);
      if (!j.schemaGrounded) {
        setAiNote('Generated without a live schema (the database returned no tables). Review the column names in the tile editor.');
      } else if (!j.validated) {
        setAiNote(`Tile added, but its KQL did not validate against ${j.resolvedDatabase}: ${j.validationError || 'unknown error'}. Edit it in the tile editor.`);
      }
      setAiOpen(false);
      setAiPrompt('');
    } catch (e: any) {
      setAiErr(e?.message || String(e));
    } finally {
      setAiBusy(false);
    }
  }, [aiPrompt, aiDataSourceId, id, timeRange]);

  const deleteTile = useCallback((idx: number) => {
    if (typeof window !== 'undefined' && !window.confirm('Delete this tile? This cannot be undone until you reload without saving.')) return;
    setTiles((prev) => prev.filter((_, i) => i !== idx));
    setDirty(true);
    setTileFlyoutIdx((cur) => (cur === idx ? null : cur !== null && cur > idx ? cur - 1 : cur));
  }, []);

  const updateTile = useCallback((idx: number, patch: Partial<DashTile>) => {
    setTiles((prev) => prev.map((t, i) => i === idx ? { ...t, ...patch } : t));
    setDirty(true);
  }, []);

  // Export a tile's REAL result (the same Kusto rows already rendered) to CSV.
  // Fabric Real-Time Dashboard tiles expose an "Export to CSV" / "Copy to
  // clipboard" tile action; this is the 1:1. Pure client-side — the result is
  // already in memory, so no backend round-trip is needed.
  const exportTileCsv = useCallback((idx: number) => {
    const t = tiles[idx];
    const res = t?.result;
    if (!res?.ok || !Array.isArray(res.columns) || !Array.isArray(res.rows)) {
      setSaveErr('Run the tile first — there is no result to export yet.');
      return;
    }
    const csv = kqlResultToCsv(res.columns, res.rows);
    downloadTextFile(`${slugifyForFile(t.title)}.csv`, csv);
    setSaveErr(null);
    setSaveMsg(`Exported ${res.rows.length} row${res.rows.length === 1 ? '' : 's'} from “${t.title}” to CSV.`);
  }, [tiles]);

  const copyTileCsv = useCallback(async (idx: number) => {
    const t = tiles[idx];
    const res = t?.result;
    if (!res?.ok || !Array.isArray(res.columns) || !Array.isArray(res.rows)) {
      setSaveErr('Run the tile first — there is no result to copy yet.');
      return;
    }
    const csv = kqlResultToCsv(res.columns, res.rows);
    try {
      if (typeof navigator === 'undefined' || !navigator.clipboard) throw new Error('Clipboard unavailable in this browser.');
      await navigator.clipboard.writeText(csv);
      setSaveErr(null);
      setSaveMsg(`Copied ${res.rows.length} row${res.rows.length === 1 ? '' : 's'} from “${t.title}” to the clipboard (CSV).`);
    } catch (e: any) {
      setSaveErr(`Could not copy to clipboard: ${e?.message || e}. Use Export CSV instead.`);
    }
  }, [tiles]);

  // Run a single tile live (the tile-editor "Run" button — Fabric parity).
  const runTile = useCallback(async (idx: number) => {
    const t = tiles[idx];
    if (!t) return;
    updateTile(idx, { error: undefined });
    try {
      const r = await clientFetch(`/api/items/kql-dashboard/${id}/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...buildModel(), tiles: [{ title: t.title, kql: t.kql, viz: t.viz, dataSourceId: t.dataSourceId, database: t.database }] }),
      });
      const ct = r.headers.get('content-type') || '';
      const j = ct.includes('application/json') ? await r.json() : { ok: false, error: `HTTP ${r.status}` };
      if (!j.ok) { updateTile(idx, { error: j.error || `run failed (HTTP ${r.status})`, result: undefined }); return; }
      updateTile(idx, { result: j.tiles?.[0]?.result, error: j.tiles?.[0]?.error });
    } catch (e: any) {
      updateTile(idx, { error: e?.message || String(e) });
    }
  }, [id, tiles, buildModel, updateTile]);

  // Append an anomaly/forecast tile from the AnomalyForecastDialog. The dialog
  // hands back the fully-composed series_decompose KQL; we add it as a normal
  // time-chart tile (bound to the dashboard default DB) and run it live so the
  // decomposition renders immediately via the existing TimeSeriesChart.
  const addAnomalyTile = useCallback(({ kql, title }: { kql: string; title: string; mode: 'anomaly' | 'forecast' }) => {
    let insertedIdx = 0;
    setTiles((prev) => {
      insertedIdx = prev.length;
      return [...prev, { title, kql, viz: 'timechart' as TileViz, database: defaultDb, w: 6, h: 3 }];
    });
    setDirty(true);
    setAnomalyOpen(false);
    setTileFlyoutIdx(insertedIdx);
    setTimeout(() => runTile(insertedIdx), 0);
  }, [defaultDb, runTile]);

  // Resolve the database a tile targets (explicit override → bound data source
  // → dashboard default) — mirrors the server-side resolveTileDatabase.
  const tileDatabase = useCallback((t: DashTile): string => {
    if (t.database && t.database.trim()) return t.database.trim();
    if (t.dataSourceId) {
      const ds = dataSources.find((d) => d.id === t.dataSourceId);
      if (ds?.database) return ds.database;
    }
    return defaultDb;
  }, [dataSources, defaultDb]);

  // Open the per-tile Set-alert dialog pre-filled from the tile (name, first
  // result column, and — displayed read-only — its KQL + resolved database).
  const openSetAlert = useCallback((idx: number) => {
    const t = tiles[idx];
    if (!t) return;
    setAlertName(`${t.title}-alert`.slice(0, 60));
    setAlertFireOn('rows');
    setAlertColumn(t.result?.columns?.[0] || '');
    setAlertOperator('gt');
    setAlertThreshold('0');
    setAlertFrequency('PT5M');
    setAlertEmail('');
    setAlertErr(null); setAlertHint(null); setAlertResult(null);
    setAlertTileIdx(idx);
  }, [tiles]);

  // Create the alert: POST the tile's KQL + the dashboard context (data
  // sources, parameters, base queries, time range — substituted server-side)
  // to the dashboard activator route, which lazily creates + links a backing
  // Activator item and mints a REAL sourceKind:'adx' rule on the ADX-native
  // Activator runtime (kusto-client evaluation; ADX-scoped scheduledQueryRule
  // when LOOM_ADX_ALERT_SCOPE is provisioned). No Fabric.
  const doSetAlert = useCallback(async () => {
    if (alertTileIdx === null) return;
    const t = tiles[alertTileIdx];
    if (!t) return;
    setAlertBusy(true); setAlertErr(null); setAlertHint(null); setAlertResult(null);
    try {
      const action = alertEmail.trim() ? { target: alertEmail.trim() } : undefined;
      const r = await clientFetch(`/api/items/kql-dashboard/${id}/activator`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ruleName: alertName.trim() || undefined,
          tileTitle: t.title,
          tileKql: t.kql,
          dataSourceId: t.dataSourceId || undefined,
          database: t.database || undefined,
          fireOn: alertFireOn,
          ...(alertFireOn === 'condition' ? {
            property: alertColumn.trim() || 'value',
            operator: alertOperator,
            threshold: alertThreshold.trim(),
          } : {}),
          evaluationFrequency: alertFrequency,
          windowSize: alertFrequency,
          ...(action ? { action } : {}),
          dataSources,
          parameters: params,
          baseQueries,
          timeRange,
        }),
      });
      const ct = r.headers.get('content-type') || '';
      const j = ct.includes('application/json') ? await r.json() : { ok: false, error: `HTTP ${r.status}` };
      if (!j.ok) {
        setAlertErr(j.error || `HTTP ${r.status}`);
        setAlertHint(j.gate?.remediation || j.hint || null);
        return;
      }
      setAlertResult({
        activatorId: j.activatorId, activatorName: j.activatorName, ruleId: j.ruleId,
        database: j.database, scheduled: j.scheduled, note: j.note,
        preview: j.preview, previewError: j.previewError,
      });
    } catch (e: any) {
      setAlertErr(e?.message || String(e));
    } finally {
      setAlertBusy(false);
    }
  }, [alertTileIdx, tiles, id, alertName, alertFireOn, alertColumn, alertOperator, alertThreshold, alertFrequency, alertEmail, dataSources, params, baseQueries, timeRange]);

  // Re-run ONLY the tiles whose KQL body references the given parameter
  // variable name (selective dependent-tile re-run, like Fabric re-evaluating
  // just the tiles a changed filter feeds). `duration` params affect every
  // tile that uses the synthetic _startTime/_endTime tokens, so those re-run
  // the whole dashboard via runAll.
  const runDependentTiles = useCallback((varName: string) => {
    if (!varName) return;
    const esc = varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\b${esc}\\b`);
    tiles.forEach((t, idx) => {
      if (re.test(t.kql)) runTile(idx);
    });
  }, [tiles, runTile]);

  const save = useCallback(async () => {
    setSaving(true); setSaveErr(null); setSaveMsg('Saving…');
    try {
      const r = await clientFetch(`/api/items/kql-dashboard/${id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(buildModel()),
      });
      const ct = r.headers.get('content-type') || '';
      const j = ct.includes('application/json') ? await r.json() : { ok: false, error: `HTTP ${r.status}` };
      if (j.ok) {
        setDirty(false);
        setSaveMsg(`Saved at ${new Date().toLocaleTimeString()}`);
      } else {
        setSaveErr(j.error || 'save failed');
        setSaveMsg(`Save failed: ${j.error || 'unknown'}`);
      }
    } catch (e: any) {
      setSaveErr(e?.message || String(e));
      setSaveMsg(`Save failed: ${e?.message || e}`);
    } finally {
      setSaving(false);
    }
  }, [id, buildModel]);

  // Ctrl+S
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (dirty && !saving) save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dirty, saving, save]);

  // Auto-refresh — re-run the live model (real ADX requery via /run) every N ms.
  // A tick is SKIPPED when the previous requery is still resolving so a tight
  // cadence (5s/30s) against a slow cluster can never pile up overlapping
  // queries — the next tick simply picks up once the in-flight run completes.
  useEffect(() => {
    if (!autoRefreshMs || autoRefreshMs <= 0) return;
    const t = setInterval(() => {
      if (runInFlightRef.current) return;
      runAll();
    }, autoRefreshMs);
    return () => clearInterval(t);
  }, [autoRefreshMs, runAll]);

  // --- Data sources ---
  const addDataSource = useCallback(() => {
    // Default to a real deployed database (prefer the cluster default) rather
    // than a blank box — operator no-freeform mandate.
    const seedDb = clusterDbs.includes(defaultDb) ? defaultDb : (clusterDbs[0] || defaultDb);
    setDataSources((prev) => [...prev, { id: genId(), name: `Source ${prev.length + 1}`, database: seedDb }]);
    setDirty(true);
  }, [defaultDb, clusterDbs]);
  const updateDataSource = useCallback((idx: number, patch: Partial<DashDataSource>) => {
    setDataSources((prev) => prev.map((d, i) => i === idx ? { ...d, ...patch } : d));
    setDirty(true);
  }, []);
  const removeDataSource = useCallback((idx: number) => {
    setDataSources((prev) => prev.filter((_, i) => i !== idx));
    setDirty(true);
  }, []);

  // --- Parameters ---
  const addParam = useCallback(() => {
    setParams((prev) => [...prev, { variableName: `_param${prev.length + 1}`, label: `Parameter ${prev.length + 1}`, type: 'freetext', dataType: 'string', value: '' }]);
    setDirty(true);
  }, []);
  const updateParam = useCallback((idx: number, patch: Partial<DashParam>) => {
    setParams((prev) => prev.map((p, i) => i === idx ? { ...p, ...patch } : p));
    setDirty(true);
  }, []);
  const removeParam = useCallback((idx: number) => {
    setParams((prev) => prev.filter((_, i) => i !== idx));
    setDirty(true);
  }, []);

  // --- Base queries (shared KQL snippets referenced via $baseQuery('name')) ---
  const addBaseQuery = useCallback(() => {
    setBaseQueries((prev) => [...prev, { id: genId(), name: `Query${prev.length + 1}`, kql: '// Shared KQL — referenced from a tile as $baseQuery(\'Query1\')\nStormEvents | where StartTime > _startTime' }]);
    setDirty(true);
  }, []);
  const updateBaseQuery = useCallback((idx: number, patch: Partial<DashBaseQuery>) => {
    setBaseQueries((prev) => prev.map((q, i) => i === idx ? { ...q, ...patch } : q));
    setDirty(true);
  }, []);
  const removeBaseQuery = useCallback((idx: number) => {
    setBaseQueries((prev) => prev.filter((_, i) => i !== idx));
    setDirty(true);
  }, []);

  // Resolve a query-based parameter's dropdown values from the real cluster.
  const loadParamValues = useCallback(async (p: DashParam) => {
    if (p.type !== 'query' || !p.query?.trim()) return;
    try {
      const r = await clientFetch(`/api/items/kql-dashboard/${id}/param-values`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: p.query, dataSourceId: p.dataSourceId, dataSources }),
      });
      const ct = r.headers.get('content-type') || '';
      const j = ct.includes('application/json') ? await r.json() : { ok: false };
      if (j.ok) setParamValueCache((prev) => ({ ...prev, [p.variableName]: j.values || [] }));
    } catch { /* surfaced lazily; dropdown just stays empty */ }
  }, [id, dataSources]);

  const openJson = useCallback(() => {
    setJsonText(JSON.stringify(buildModel(), null, 2));
    setJsonErr(null);
    setJsonOpen(true);
  }, [buildModel]);

  const applyJson = useCallback(() => {
    try {
      const parsed = JSON.parse(jsonText);
      const model = Array.isArray(parsed) ? { tiles: parsed } : parsed;
      if (Array.isArray(model.tiles)) setTiles(model.tiles);
      if (Array.isArray(model.dataSources)) setDataSources(model.dataSources);
      if (Array.isArray(model.parameters)) setParams(model.parameters);
      if (Array.isArray(model.baseQueries)) setBaseQueries(model.baseQueries);
      if (typeof model.timeRange === 'string' && TIME_ORDER.includes(model.timeRange)) setTimeRange(model.timeRange);
      setDirty(true); setJsonOpen(false); setJsonErr(null);
    } catch (e: any) {
      setJsonErr(e?.message || 'invalid JSON');
    }
  }, [jsonText]);

  const cycleTime = useCallback(() => {
    const i = TIME_ORDER.indexOf(timeRange);
    const next = TIME_ORDER[(i + 1) % TIME_ORDER.length];
    setTimeRange(next);
    setTimeout(() => runAll(), 0);
  }, [timeRange, runAll]);

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Edit', actions: [
        { label: 'Add tile', onClick: addTile },
        { label: 'Add tile with Copilot', onClick: () => { setAiErr(null); setAiNote(null); setAiOpen(true); } },
        { label: 'Add anomaly / forecast tile', onClick: () => setAnomalyOpen(true) },
        { label: 'Data sources', onClick: () => setSourcesOpen(true) },
        { label: 'Parameters', onClick: () => setParamsOpen(true) },
        { label: 'Base queries', onClick: () => setBaseQueriesOpen(true) },
        { label: 'Edit JSON', onClick: openJson },
      ]},
      { label: 'View', actions: [
        { label: running ? 'Refreshing…' : 'Refresh all', onClick: running ? undefined : runAll, disabled: running },
        // The auto-refresh interval is authored + displayed via the toolbar
        // <Select> (a status-only, click-undefined ribbon button was a dead
        // action — no-vaporware). Time stays a real cycle action.
        { label: `Time: ${timeRange}`, onClick: cycleTime },
      ]},
      { label: 'Manage', actions: [
        { label: saving ? 'Saving…' : 'Save', onClick: saving ? undefined : save, disabled: saving },
        { label: 'Share', onClick: () => setShareOpen(true) },
      ]},
    ]},
  ], [addTile, openJson, running, runAll, autoRefreshMs, timeRange, cycleTime, saving, save]);

  const main = (
    <div className={s.pad}>
      <div className={s.toolbar}>
        <Badge appearance="filled" color="brand">Real-Time Dashboard</Badge>
        <Caption1>db: <strong>{defaultDb}</strong> · {tiles.length} tiles · {dataSources.length} sources · {params.length} params</Caption1>
        {dirty && <Badge appearance="outline" color="warning">unsaved</Badge>}
        <Button size="small" appearance="outline" icon={<Add20Regular />} onClick={addTile}>Add tile</Button>
        <Button size="small" appearance="primary" icon={<Sparkle20Regular />} onClick={() => { setAiErr(null); setAiNote(null); setAiOpen(true); }}>Add tile with Copilot</Button>
        <Button size="small" appearance="outline" icon={<MathFormula20Regular />} onClick={() => setAnomalyOpen(true)}>Anomaly / forecast</Button>
        <Button size="small" appearance="outline" icon={<Database20Regular />} onClick={() => setSourcesOpen(true)}>Data sources</Button>
        <Button size="small" appearance="outline" icon={<MathFormula20Regular />} onClick={() => setParamsOpen(true)}>Parameters</Button>
        <Button size="small" appearance="outline" onClick={() => setBaseQueriesOpen(true)}>Base queries</Button>
        <Button size="small" appearance="outline" onClick={openJson}>Edit JSON</Button>
        <Button size="small" appearance="outline" icon={<ArrowSync20Regular />} onClick={runAll} disabled={running}>{running ? 'Refreshing…' : 'Refresh all'}</Button>
        <Select
          size="small"
          aria-label="Auto-refresh interval"
          value={String(autoRefreshMs)}
          onChange={(_: unknown, d: any) => { setAutoRefreshMs(Number(d.value) || 0); setDirty(true); }}
          style={{ minWidth: 150 }}
        >
          {REFRESH_INTERVALS.map(({ ms, label }) => (
            <option key={ms} value={String(ms)}>
              {ms === 0 ? 'Auto-refresh: off' : `Auto-refresh: every ${label}`}
            </option>
          ))}
        </Select>
        {autoRefreshMs > 0 && (
          <span
            className={s.livePill}
            role="status"
            aria-live="polite"
            title={`Auto-refreshing every ${refreshLabel(autoRefreshMs).replace(/^Auto-refresh:\s*/i, '')}`}
          >
            <span className={mergeClasses(s.liveDot, running && s.liveDotActive)} aria-hidden />
            <Caption1>
              {running
                ? 'Refreshing…'
                : lastRefreshedAt
                  ? `Live · updated ${new Date(lastRefreshedAt).toLocaleTimeString()}`
                  : 'Live · waiting for first refresh…'}
            </Caption1>
          </span>
        )}
        <Button size="small" appearance="primary" icon={<Save20Regular />} onClick={save} disabled={saving || !dirty} style={{ marginLeft: 'auto' }}>
          {saving ? 'Saving…' : 'Save (Ctrl+S)'}
        </Button>
      </div>

      {/* Parameter filter bar — Fabric renders selected dashboard params here. */}
      {params.length > 0 && (
        <div style={{ display: 'flex', gap: tokens.spacingVerticalM, flexWrap: 'wrap', alignItems: 'flex-end', padding: `${tokens.spacingVerticalXS} 0` }}>
          {params.map((p, i) => (
            <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS, minWidth: 160 }}>
              <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{p.label || p.variableName}</Caption1>
              {p.type === 'fixed' || p.type === 'datasource' ? (
                <Select value={(p.value as string) || ''}
                  onChange={(_: unknown, d: any) => { updateParam(i, { value: d.value }); setTimeout(() => runDependentTiles(p.variableName), 0); }}>
                  <option value="">(all)</option>
                  {(p.type === 'datasource' ? dataSources.map((d) => d.name) : (p.values || [])).map((v) => <option key={v} value={v}>{v}</option>)}
                </Select>
              ) : p.type === 'query' ? (
                <Select value={(p.value as string) || ''}
                  onFocus={() => { if (!paramValueCache[p.variableName]) loadParamValues(p); }}
                  onChange={(_: unknown, d: any) => { updateParam(i, { value: d.value }); setTimeout(() => runDependentTiles(p.variableName), 0); }}>
                  <option value="">(all)</option>
                  {(paramValueCache[p.variableName] || []).map((v) => <option key={v} value={v}>{v}</option>)}
                </Select>
              ) : p.type === 'duration' ? (
                // Time-range picker — matches the Fabric "Duration" param type.
                // Changing it sets the global time range (which drives the
                // synthetic _startTime/_endTime tokens) and re-runs every tile.
                <Select value={(p.value as string) || timeRange}
                  onChange={(_: unknown, d: any) => {
                    updateParam(i, { value: d.value });
                    if (TIME_ORDER.includes(d.value as TimeRangeKey)) setTimeRange(d.value as TimeRangeKey);
                    setTimeout(() => runAll(), 0);
                  }}>
                  {TIME_ORDER.map((k) => <option key={k} value={k}>{k}</option>)}
                </Select>
              ) : p.type === 'multi' ? (
                p.values && p.values.length > 0 ? (
                  // Fixed-value multi-select — native <select multiple> backed
                  // by the param's allowed values list.
                  <select
                    multiple
                    size={Math.min(p.values.length, 5)}
                    value={Array.isArray(p.value) ? (p.value as string[]) : []}
                    onChange={(e) => updateParam(i, { value: Array.from(e.target.selectedOptions).map((o) => o.value) })}
                    onBlur={() => runDependentTiles(p.variableName)}
                    aria-label={p.label || p.variableName}
                    style={{ minWidth: 160, padding: tokens.spacingVerticalXS, border: `1px solid ${tokens.colorNeutralStroke1}`, borderRadius: tokens.borderRadiusMedium, background: tokens.colorNeutralBackground1, color: tokens.colorNeutralForeground1 }}>
                    {p.values.map((v) => <option key={v} value={v}>{v}</option>)}
                  </select>
                ) : (
                  <Input placeholder="comma,separated,values"
                    value={Array.isArray(p.value) ? p.value.join(',') : ''}
                    onChange={(_: unknown, d: any) => updateParam(i, { value: d.value.split(',').map((x: string) => x.trim()).filter(Boolean) })}
                    onBlur={() => runDependentTiles(p.variableName)} />
                )
              ) : (
                <Input value={Array.isArray(p.value) ? '' : (p.value || '')}
                  onChange={(_: unknown, d: any) => updateParam(i, { value: d.value })}
                  onBlur={() => runDependentTiles(p.variableName)} />
              )}
            </div>
          ))}
          <Button size="small" appearance="primary" icon={<Play20Regular />} onClick={runAll} disabled={running}>Apply</Button>
        </div>
      )}

      {saveMsg && !saveErr && <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{saveMsg}</Caption1>}
      {saveErr && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Error</MessageBarTitle>{saveErr}</MessageBarBody></MessageBar>}
      {aiNote && (
        <MessageBar intent="warning">
          <MessageBarBody><MessageBarTitle>Copilot tile</MessageBarTitle>{aiNote}</MessageBarBody>
          <MessageBarActions>
            <Button size="small" onClick={() => setAiNote(null)}>Dismiss</Button>
          </MessageBarActions>
        </MessageBar>
      )}
      {state && !state.ok && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Dashboard data source not ready</MessageBarTitle>
            {state.error || 'unknown'} — the dashboard still renders; bind tiles to a KQL database
            (via Data sources) on the Loom shared ADX cluster. If no Eventhouse / KQL DB is provisioned,
            create one in the Eventhouse editor first (ARM Microsoft.Kusto/clusters/databases).
          </MessageBarBody>
        </MessageBar>
      )}

      {/* Tile grid — 12-col CSS grid; each tile spans its w/h. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(12, 1fr)', gap: tokens.spacingVerticalM, gridAutoRows: 'minmax(120px, auto)' }}>
        {tiles.map((t, i) => {
          const span = Math.max(1, Math.min(12, t.w || 4));
          const rowSpan = Math.max(1, Math.min(8, t.h || 2));
          const dsName = t.dataSourceId ? (dataSources.find((d) => d.id === t.dataSourceId)?.name || t.dataSourceId) : (t.database || defaultDb);
          return (
            <div key={i} className={s.card} style={{ gridColumn: `span ${span}`, gridRow: `span ${rowSpan}`, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div>
                  <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{t.viz.toUpperCase()} · {dsName}</Caption1>
                  <div style={{ fontSize: tokens.fontSizeBase300, fontWeight: 600 }}>{t.title}</div>
                </div>
                <div style={{ display: 'flex', gap: tokens.spacingVerticalXXS}}>
                  <Button size="small" appearance="subtle" icon={<Play20Regular />} onClick={() => runTile(i)} aria-label="Run tile" title="Run this tile" />
                  <Button
                    size="small" appearance="subtle" icon={<Alert20Regular />}
                    onClick={() => openSetAlert(i)}
                    aria-label="Set alert on this tile"
                    title="Set alert — create an Activator rule from this tile's KQL (evaluated on the ADX cluster; Azure-native, no Fabric)" />
                  <Button
                    size="small" appearance="subtle" icon={<ArrowDownload20Regular />}
                    onClick={() => exportTileCsv(i)} disabled={!t.result?.ok}
                    aria-label="Export tile result to CSV"
                    title={t.result?.ok ? 'Export this tile’s result to CSV' : 'Run the tile first to enable export'} />
                  <Button
                    size="small" appearance="subtle" icon={<Copy20Regular />}
                    onClick={() => copyTileCsv(i)} disabled={!t.result?.ok}
                    aria-label="Copy tile result to clipboard"
                    title={t.result?.ok ? 'Copy this tile’s result (CSV) to the clipboard' : 'Run the tile first to enable copy'} />
                  <Button size="small" appearance="subtle" onClick={() => setTileFlyoutIdx(i)} aria-label="Edit tile">
                    Edit
                  </Button>
                  <Button size="small" appearance="subtle" icon={<Delete20Regular />} onClick={() => deleteTile(i)} aria-label="Delete tile" />
                </div>
              </div>

              {t.error && <MessageBar intent="error" style={{ marginTop: tokens.spacingVerticalS}}><MessageBarBody>{t.error}</MessageBarBody></MessageBar>}
              {t.result && t.result.ok && (
                <div style={{ marginTop: tokens.spacingVerticalS, flex: 1, minHeight: 0 }}>
                  <TileVisual
                    viz={t.viz}
                    result={t.result}
                    conditionalRules={t.conditionalRules}
                    drillthrough={t.drillthrough}
                    onDrillthrough={t.drillthrough ? (paramName, value) => {
                      // Inject the clicked value into the target parameter, then
                      // re-run every tile so the dashboard cross-filters — the
                      // single-page Loom equivalent of Fabric drill-through.
                      setParams((prev) => prev.map((p) => p.variableName === paramName ? { ...p, value } : p));
                      setTimeout(() => runAll(), 0);
                    } : undefined}
                  />
                  {/* Stable, machine-readable first-row snapshot — the
                      before/after receipt target for the param-change E2E. */}
                  <span data-testid="tile-result-row" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>
                    {JSON.stringify(t.result.rows?.[0] ?? [])}
                  </span>
                </div>
              )}
              {!t.result && !t.error && <Caption1 style={{ marginTop: tokens.spacingVerticalS, color: tokens.colorNeutralForeground3 }}>Run the tile to see results.</Caption1>}
            </div>
          );
        })}
        {tiles.length === 0 && <Caption1 style={{ gridColumn: 'span 12' }}>No tiles yet. Click <strong>Add tile</strong> to start building.</Caption1>}
      </div>

      {/* Tile edit flyout — Fabric "tile editing window": one Dialog edits the
          tile at tileFlyoutIdx (title, visual, data source, geometry, KQL),
          runs it live, and renders the real result inline before Apply. */}
      <Dialog open={tileFlyoutIdx !== null} onOpenChange={(_: unknown, d: any) => { if (!d.open) setTileFlyoutIdx(null); }}>
        <DialogSurface style={{ maxWidth: 760 }}>
          <DialogBody>
            <DialogTitle>Edit tile</DialogTitle>
            <DialogContent>
              {tileFlyoutIdx !== null && tiles[tileFlyoutIdx] && (() => {
                const i = tileFlyoutIdx;
                const t = tiles[i];
                return (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS}}>
                    <div>
                      <Caption1>Title</Caption1>
                      <Input value={t.title} onChange={(_: unknown, d: any) => updateTile(i, { title: d.value })} placeholder="Title" aria-label="Tile title" />
                    </div>
                    <div style={{ display: 'flex', gap: tokens.spacingVerticalS, flexWrap: 'wrap' }}>
                      <div style={{ flex: 1, minWidth: 140 }}>
                        <Caption1>Visual</Caption1>
                        <Select value={t.viz} onChange={(_: unknown, d: any) => updateTile(i, { viz: d.value as TileViz })} aria-label="Tile visual type">
                          {TILE_VIZ_OPTIONS.map((v) => <option key={v} value={v}>{v}</option>)}
                        </Select>
                      </div>
                      <div style={{ flex: 1, minWidth: 140 }}>
                        <Caption1>Data source</Caption1>
                        <Select value={t.dataSourceId || ''} onChange={(_: unknown, d: any) => updateTile(i, { dataSourceId: d.value || undefined })} aria-label="Tile data source">
                          <option value="">{`(dashboard default: ${defaultDb})`}</option>
                          {dataSources.map((ds) => <option key={ds.id} value={ds.id}>{ds.name} → {ds.database}</option>)}
                        </Select>
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: tokens.spacingVerticalS}}>
                      <div style={{ flex: 1 }}>
                        <Caption1>Width (1–12)</Caption1>
                        <Input type="number" value={String(t.w || 4)} onChange={(_: unknown, d: any) => updateTile(i, { w: Math.max(1, Math.min(12, parseInt(d.value, 10) || 4)) })} aria-label="Tile width" />
                      </div>
                      <div style={{ flex: 1 }}>
                        <Caption1>Height (1–8)</Caption1>
                        <Input type="number" value={String(t.h || 2)} onChange={(_: unknown, d: any) => updateTile(i, { h: Math.max(1, Math.min(8, parseInt(d.value, 10) || 2)) })} aria-label="Tile height" />
                      </div>
                    </div>
                    <Caption1>KQL query{baseQueries.length > 0 ? ' — reference a base query as $baseQuery(\'name\')' : ''}</Caption1>
                    <MonacoTextarea
                      value={t.kql}
                      onChange={(v) => updateTile(i, { kql: v })}
                      language="kql"
                      height={220}
                      minHeight={180}
                      ariaLabel={`Tile ${i + 1} KQL`}
                    />
                    <Button size="small" appearance="primary" icon={<Play20Regular />} onClick={() => runTile(i)}>Run tile</Button>
                    {t.error && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Query failed</MessageBarTitle>{t.error}</MessageBarBody></MessageBar>}
                    {t.result && t.result.ok && (
                      <div style={{ border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge, padding: tokens.spacingVerticalS }}>
                        <TileVisual viz={t.viz} result={t.result} conditionalRules={t.conditionalRules} />
                      </div>
                    )}

                    {/* Drill-through (Fabric: visual Interactions > Drillthrough).
                        Clicking a result value sets a dashboard parameter and
                        re-runs every tile (single-page cross-filter). */}
                    <div style={{ borderTop: `1px solid ${tokens.colorNeutralStroke2}`, paddingTop: tokens.spacingVerticalS, marginTop: tokens.spacingVerticalXS}}>
                      <Caption1 style={{ fontWeight: 600 }}>Drill-through</Caption1>
                      <Caption1 style={{ color: tokens.colorNeutralForeground3, display: 'block', marginBottom: tokens.spacingVerticalXS}}>
                        Clicking a value in this tile injects it into a dashboard parameter and re-runs all tiles.
                      </Caption1>
                      {params.length === 0 ? (
                        <MessageBar intent="info">
                          <MessageBarBody>
                            Add at least one dashboard <strong>Parameter</strong> first — drill-through targets a parameter.
                          </MessageBarBody>
                        </MessageBar>
                      ) : (
                        <div style={{ display: 'flex', gap: tokens.spacingVerticalS, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                          <div style={{ flex: 1, minWidth: 140 }}>
                            <Caption1>Column (from query result)</Caption1>
                            {t.result?.ok && (t.result.columns?.length ?? 0) > 0 ? (
                              <Select
                                value={t.drillthrough?.column || ''}
                                aria-label="Drillthrough column"
                                onChange={(_: unknown, d: any) => {
                                  const column = d.value;
                                  const paramName = t.drillthrough?.paramName || '';
                                  updateTile(i, {
                                    drillthrough: column.trim() || paramName ? { column, paramName } : undefined,
                                  });
                                }}
                              >
                                <option value="">(none)</option>
                                {(t.result.columns || []).map((c) => (
                                  <option key={c} value={c}>{c}</option>
                                ))}
                              </Select>
                            ) : (
                              <Input
                                value={t.drillthrough?.column || ''}
                                placeholder="Run the tile to pick a column"
                                aria-label="Drillthrough column"
                                onChange={(_: unknown, d: any) => {
                                  const column = d.value;
                                  const paramName = t.drillthrough?.paramName || '';
                                  updateTile(i, {
                                    drillthrough: column.trim() || paramName ? { column, paramName } : undefined,
                                  });
                                }}
                              />
                            )}
                          </div>
                          <div style={{ flex: 1, minWidth: 140 }}>
                            <Caption1>Target parameter</Caption1>
                            <Select
                              value={t.drillthrough?.paramName || ''}
                              aria-label="Drillthrough target parameter"
                              onChange={(_: unknown, d: any) => {
                                const paramName = d.value;
                                const column = t.drillthrough?.column || '';
                                updateTile(i, {
                                  drillthrough: column.trim() || paramName ? { column, paramName } : undefined,
                                });
                              }}
                            >
                              <option value="">(none — disable drill-through)</option>
                              {params.map((p) => (
                                <option key={p.variableName} value={p.variableName}>{p.label || p.variableName}</option>
                              ))}
                            </Select>
                          </div>
                        </div>
                      )}
                      {t.drillthrough?.column && t.drillthrough?.paramName && (
                        <Caption1 style={{ color: tokens.colorNeutralForeground3, display: 'block', marginTop: tokens.spacingVerticalXS}}>
                          Click a value in this tile → sets <code>{t.drillthrough.paramName}</code> to the value in column <code>{t.drillthrough.column}</code> and re-runs all tiles.
                        </Caption1>
                      )}
                    </div>

                    {/* Conditional formatting (Fabric RTD: color by condition / by value).
                        Applies to table + stat (card) visuals. */}
                    {(t.viz === 'table' || t.viz === 'stat') && (
                      <div style={{ borderTop: `1px solid ${tokens.colorNeutralStroke2}`, paddingTop: tokens.spacingVerticalS, marginTop: tokens.spacingVerticalXS}}>
                        <ConditionalFormattingEditor
                          viz={t.viz}
                          rules={t.conditionalRules || []}
                          columns={t.result?.columns || []}
                          onChange={(rules) => updateTile(i, { conditionalRules: rules.length ? rules : undefined })}
                        />
                      </div>
                    )}
                  </div>
                );
              })()}
            </DialogContent>
            <DialogActions>
              {tileFlyoutIdx !== null && (
                <Button appearance="secondary" icon={<Delete20Regular />} onClick={() => deleteTile(tileFlyoutIdx)}>Delete tile</Button>
              )}
              <Button appearance="primary" onClick={() => setTileFlyoutIdx(null)}>Apply</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* Set alert on tile — Fabric Real-Time Dashboard "Set alert" parity.
          Creates a REAL Activator rule (sourceKind:'adx') from the tile's KQL,
          routed through the ADX-native Activator runtime: the rule's KQL runs
          against the tile's resolved KQL database on the Azure Data Explorer
          cluster (kusto-client), with an ADX-scoped Azure Monitor
          scheduledQueryRule for hands-off evaluation when LOOM_ADX_ALERT_SCOPE
          is provisioned. A backing Activator item is lazily created + linked
          onto this dashboard (state.activatorId). Azure-native; no Fabric. */}
      <Dialog open={alertTileIdx !== null} onOpenChange={(_: unknown, d: any) => { if (!d.open && !alertBusy) setAlertTileIdx(null); }}>
        <DialogSurface style={{ maxWidth: 640 }}>
          <DialogBody>
            <DialogTitle>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalS }}>
                <Alert20Regular /> Set alert on tile
              </span>
            </DialogTitle>
            <DialogContent>
              {alertTileIdx !== null && tiles[alertTileIdx] && (() => {
                const t = tiles[alertTileIdx];
                const db = tileDatabase(t);
                const opGlyph = { gt: '>', lt: '<', gte: '≥', lte: '≤', eq: '=', ne: '≠', contains: 'contains' }[alertOperator];
                const freqLabel = { PT1M: '1 minute', PT5M: '5 minutes', PT15M: '15 minutes', PT1H: '1 hour' }[alertFrequency];
                return (
                  <>
                    <div
                      style={{
                        display: 'flex',
                        gap: tokens.spacingHorizontalS,
                        padding: tokens.spacingVerticalS,
                        borderRadius: tokens.borderRadiusMedium,
                        border: `1px solid ${tokens.colorNeutralStroke2}`,
                        background: tokens.colorNeutralBackground2,
                      }}
                    >
                      <Alert20Regular style={{ flexShrink: 0, marginTop: tokens.spacingVerticalXXS, color: tokens.colorBrandForeground1 }} />
                      <Caption1 style={{ color: tokens.colorNeutralForeground2 }}>
                        Creates an <strong>Activator</strong> rule from this tile&apos;s KQL, linked to this
                        dashboard. The rule evaluates against <strong>{db}</strong> on the Azure Data
                        Explorer cluster (Azure-native default — no Microsoft Fabric Reflex required)
                        and fires when the condition below matches.
                      </Caption1>
                    </div>
                    <Field label={`Tile query — "${t.title}"`} style={{ marginTop: tokens.spacingVerticalM }}
                      hint="Base queries, parameters, and the dashboard time range are substituted when the rule is created.">
                      <div
                        style={{
                          fontFamily: tokens.fontFamilyMonospace,
                          fontSize: tokens.fontSizeBase200,
                          whiteSpace: 'pre-wrap',
                          wordBreak: 'break-word',
                          maxHeight: 120,
                          overflowY: 'auto',
                          padding: tokens.spacingVerticalS,
                          borderRadius: tokens.borderRadiusMedium,
                          border: `1px solid ${tokens.colorNeutralStroke2}`,
                          background: tokens.colorNeutralBackground3,
                          color: tokens.colorNeutralForeground1,
                        }}
                      >
                        {t.kql}
                      </div>
                    </Field>
                    <Field label="Alert name" style={{ marginTop: tokens.spacingVerticalM }}>
                      <Input value={alertName} onChange={(_: unknown, d: any) => setAlertName(d.value)}
                        placeholder={`${t.title}-alert`} aria-label="Alert name" />
                    </Field>
                    <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, marginTop: tokens.spacingVerticalM, flexWrap: 'wrap' }}>
                      <Field label="Fire when" style={{ flex: 2, minWidth: 200 }}>
                        <Select value={alertFireOn} aria-label="Fire when"
                          onChange={(_: unknown, d: any) => setAlertFireOn(d.value as 'rows' | 'condition')}>
                          <option value="rows">The query returns any rows</option>
                          <option value="condition">A result column crosses a threshold</option>
                        </Select>
                      </Field>
                      <Field label="Evaluate every" style={{ flex: 1, minWidth: 130 }}>
                        <Select value={alertFrequency} aria-label="Evaluation frequency"
                          onChange={(_: unknown, d: any) => setAlertFrequency(d.value)}>
                          <option value="PT1M">1 minute</option>
                          <option value="PT5M">5 minutes</option>
                          <option value="PT15M">15 minutes</option>
                          <option value="PT1H">1 hour</option>
                        </Select>
                      </Field>
                    </div>
                    {alertFireOn === 'condition' && (
                      <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, marginTop: tokens.spacingVerticalM, flexWrap: 'wrap' }}>
                        <div style={{ flex: 2, minWidth: 150 }}>
                          <Field label="Result column">
                            <CfColumnField label="Alert condition column" value={alertColumn}
                              columns={t.result?.columns || []} onChange={setAlertColumn} />
                          </Field>
                        </div>
                        <Field label="Operator" style={{ flex: 1, minWidth: 120 }}>
                          <Select value={alertOperator} aria-label="Alert operator"
                            onChange={(_: unknown, d: any) => setAlertOperator(d.value)}>
                            <option value="gt">greater than</option>
                            <option value="lt">less than</option>
                            <option value="gte">≥</option>
                            <option value="lte">≤</option>
                            <option value="eq">equals</option>
                            <option value="ne">not equals</option>
                            <option value="contains">contains</option>
                          </Select>
                        </Field>
                        <Field label="Threshold" style={{ flex: 1, minWidth: 90 }}>
                          <Input value={alertThreshold} onChange={(_: unknown, d: any) => setAlertThreshold(d.value)}
                            placeholder="0" aria-label="Alert threshold" />
                        </Field>
                      </div>
                    )}
                    <Field label="Notify email (optional)" style={{ marginTop: tokens.spacingVerticalM }}
                      hint="Creates a real Azure Monitor action group receiver for the rule.">
                      <Input value={alertEmail} onChange={(_: unknown, d: any) => setAlertEmail(d.value)}
                        placeholder="oncall@contoso.com" aria-label="Notify email" />
                    </Field>
                    {/* Live rule preview — mirrors the Azure portal's alert condition summary. */}
                    <div
                      aria-live="polite"
                      style={{
                        marginTop: tokens.spacingVerticalM,
                        padding: tokens.spacingVerticalS,
                        borderRadius: tokens.borderRadiusMedium,
                        background: tokens.colorNeutralBackground3,
                        border: `1px solid ${tokens.colorNeutralStroke2}`,
                      }}
                    >
                      <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Rule preview</Caption1>
                      <div style={{ marginTop: tokens.spacingVerticalXS, fontFamily: tokens.fontFamilyMonospace, fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground1 }}>
                        {alertFireOn === 'rows'
                          ? <>Fire when the tile query returns <strong>any rows</strong> on <strong>{db}</strong></>
                          : <>Fire when <strong>{alertColumn.trim() || 'value'}</strong> {opGlyph} <strong>{alertThreshold.trim() || '0'}</strong> on <strong>{db}</strong></>}
                        , evaluated every {freqLabel}
                        {alertEmail.trim() ? <> → email <strong>{alertEmail.trim()}</strong></> : null}.
                      </div>
                    </div>
                    {alertErr && (
                      <MessageBar intent={alertHint ? 'warning' : 'error'} style={{ marginTop: tokens.spacingVerticalM }}>
                        <MessageBarBody>
                          <MessageBarTitle>{alertHint ? 'Azure backend not configured' : 'Set alert failed'}</MessageBarTitle>
                          {alertErr}{alertHint ? <><br /><Caption1>{alertHint}</Caption1></> : null}
                        </MessageBarBody>
                      </MessageBar>
                    )}
                    {alertResult && !alertErr && (
                      <MessageBar intent="success" style={{ marginTop: tokens.spacingVerticalM }}>
                        <MessageBarBody>
                          <MessageBarTitle>Alert created and linked</MessageBarTitle>
                          Linked Activator <strong>{alertResult.activatorName || alertResult.activatorId}</strong> with
                          rule <code>{alertResult.ruleId}</code> on <strong>{alertResult.database || db}</strong>.
                          {alertResult.preview && (
                            <> Evaluated now against the live cluster: <strong>{alertResult.preview.fired ? 'would fire' : 'would not fire'}</strong> ({alertResult.preview.count} row{alertResult.preview.count === 1 ? '' : 's'}).</>
                          )}
                          {' '}
                          <Link href={`/items/activator/${alertResult.activatorId}`} target="_blank">
                            Open the Activator <Open20Regular style={{ verticalAlign: 'middle' }} />
                          </Link>
                          {alertResult.previewError && (
                            <><br /><Caption1>Live evaluation unavailable: {alertResult.previewError}</Caption1></>
                          )}
                          {!alertResult.scheduled && alertResult.note && (
                            <><br /><Caption1>{alertResult.note}</Caption1></>
                          )}
                        </MessageBarBody>
                      </MessageBar>
                    )}
                  </>
                );
              })()}
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setAlertTileIdx(null)} disabled={alertBusy}>Close</Button>
              <Button appearance="primary" icon={alertBusy ? <Spinner size="tiny" /> : <Alert20Regular />}
                onClick={doSetAlert}
                disabled={alertBusy || (alertFireOn === 'condition' && !alertThreshold.trim())}>
                {alertBusy ? 'Creating…' : 'Create alert'}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* Base queries dialog — shared KQL snippets referenced via $baseQuery('name') */}
      <Dialog open={baseQueriesOpen} onOpenChange={(_: unknown, d: any) => setBaseQueriesOpen(d.open)}>
        <DialogSurface style={{ maxWidth: 640 }}>
          <DialogBody>
            <DialogTitle>Base queries</DialogTitle>
            <DialogContent>
              <Caption1>
                Define shared KQL snippets once and reference them from any tile with
                <code> $baseQuery('name')</code>. At run time the snippet is inlined as a
                parenthesised sub-query, so a common filter or projection backs many tiles
                without copy-paste (Fabric Real-Time Dashboard base-query parity).
              </Caption1>
              <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, marginTop: tokens.spacingVerticalS}}>
                {baseQueries.map((q, idx) => (
                  <div key={q.id} style={{ border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge, padding: tokens.spacingVerticalS, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS}}>
                    <div style={{ display: 'flex', gap: tokens.spacingVerticalS, alignItems: 'flex-end' }}>
                      <div style={{ flex: 1 }}>
                        <Caption1>Name (referenced as $baseQuery('…'))</Caption1>
                        <Input value={q.name} onChange={(_: unknown, d: any) => updateBaseQuery(idx, { name: d.value })} placeholder="Filtered" aria-label="Base query name" />
                      </div>
                      <Button appearance="subtle" icon={<Delete20Regular />} onClick={() => removeBaseQuery(idx)} aria-label="Remove base query" />
                    </div>
                    <Caption1>KQL</Caption1>
                    <MonacoTextarea
                      value={q.kql}
                      onChange={(v) => updateBaseQuery(idx, { kql: v })}
                      language="kql"
                      height={120}
                      minHeight={90}
                      ariaLabel={`Base query ${idx + 1} KQL`}
                    />
                  </div>
                ))}
                {baseQueries.length === 0 && <Caption1>No base queries yet. Add one to share a KQL snippet across tiles.</Caption1>}
                <Button appearance="outline" icon={<Add20Regular />} onClick={addBaseQuery}>Add base query</Button>
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance="primary" onClick={() => setBaseQueriesOpen(false)}>Close</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* AI tile generator dialog (NL → KQL) — Fabric RTI "Copilot add a tile" parity. */}
      <Dialog open={aiOpen} onOpenChange={(_: unknown, d: any) => { if (!aiBusy) setAiOpen(d.open); }}>
        <DialogSurface style={{ maxWidth: 640 }}>
          <DialogBody>
            <DialogTitle>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: tokens.spacingVerticalS}}>
                <Sparkle20Regular /> Add a tile with Copilot
              </span>
            </DialogTitle>
            <DialogContent>
              <Caption1 style={{ display: 'block', marginBottom: tokens.spacingVerticalM, color: tokens.colorNeutralForeground3 }}>
                Describe the visualization you want in plain language. Copilot reads the live
                schema of <strong>{defaultDb}</strong>, writes the KQL, picks a chart type, and
                validates the query against Azure Data Explorer before adding the tile.
              </Caption1>
              <Field label="What should this tile show?">
                <Textarea
                  value={aiPrompt}
                  onChange={(_: unknown, d: any) => setAiPrompt(d.value)}
                  placeholder="e.g. Count of failed requests per service over time as a line chart"
                  rows={3}
                  disabled={aiBusy}
                  onKeyDown={(e) => {
                    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !aiBusy) { e.preventDefault(); generateTile(); }
                  }}
                />
              </Field>
              <Caption1 style={{ display: 'block', marginTop: tokens.spacingVerticalXS, color: tokens.colorNeutralForeground3 }}>
                Press <kbd style={{ fontFamily: tokens.fontFamilyMonospace }}>Ctrl</kbd>+<kbd style={{ fontFamily: tokens.fontFamilyMonospace }}>Enter</kbd> to generate.
              </Caption1>
              {dataSources.length > 0 && (
                <Field label="Data source (optional)" style={{ marginTop: tokens.spacingVerticalM}}>
                  <Select value={aiDataSourceId} onChange={(_: unknown, d: any) => setAiDataSourceId(d.value)} disabled={aiBusy}>
                    <option value="">Dashboard default ({defaultDb})</option>
                    {dataSources.map((ds) => <option key={ds.id} value={ds.id}>{ds.name} · {ds.database}</option>)}
                  </Select>
                </Field>
              )}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: tokens.spacingVerticalS, marginTop: tokens.spacingVerticalM}}>
                <Caption1 style={{ color: tokens.colorNeutralForeground3, width: '100%' }}>Try:</Caption1>
                {[
                  'Total events in the last 24 hours',
                  'Top 10 error messages by count as a bar chart',
                  'Requests per minute over time',
                ].map((ex) => (
                  <Button
                    key={ex}
                    size="small"
                    appearance="outline"
                    shape="circular"
                    disabled={aiBusy}
                    onClick={() => setAiPrompt(ex)}
                  >
                    {ex}
                  </Button>
                ))}
              </div>
              {aiErr && (
                <MessageBar intent="error" style={{ marginTop: tokens.spacingVerticalM}}>
                  <MessageBarBody><MessageBarTitle>Could not generate the tile</MessageBarTitle>{aiErr}</MessageBarBody>
                </MessageBar>
              )}
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setAiOpen(false)} disabled={aiBusy}>Cancel</Button>
              <Button appearance="primary" icon={aiBusy ? <Spinner size="tiny" /> : <Sparkle20Regular />} onClick={generateTile} disabled={aiBusy || !aiPrompt.trim()}>
                {aiBusy ? 'Generating…' : 'Generate tile'}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* Data sources dialog */}
      <Dialog open={sourcesOpen} onOpenChange={(_: unknown, d: any) => setSourcesOpen(d.open)}>
        <DialogSurface style={{ maxWidth: 620 }}>
          <DialogBody>
            <DialogTitle>Data sources</DialogTitle>
            <DialogContent>
              <Caption1>Bind the dashboard to one or more KQL databases on the Loom shared ADX cluster. Tiles select a source; query-based parameters can run against a source.</Caption1>
              <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, marginTop: tokens.spacingVerticalS}}>
                {dataSources.map((ds, idx) => (
                  <div key={ds.id} style={{ display: 'flex', gap: tokens.spacingVerticalS, alignItems: 'flex-end' }}>
                    <div style={{ flex: 1 }}>
                      <Caption1>Name</Caption1>
                      <Input value={ds.name} onChange={(_: unknown, d: any) => updateDataSource(idx, { name: d.value })} />
                    </div>
                    <div style={{ flex: 1 }}>
                      <Caption1>KQL database</Caption1>
                      {clusterDbs.length > 0 ? (
                        <Select
                          value={clusterDbs.includes(ds.database) ? ds.database : '__custom__'}
                          onChange={(_: unknown, d: any) => { if (d.value !== '__custom__') updateDataSource(idx, { database: d.value }); }}
                          aria-label="KQL database"
                        >
                          {clusterDbs.map((db) => <option key={db} value={db}>{db}</option>)}
                          <option value="__custom__">Other (type below)…</option>
                        </Select>
                      ) : null}
                      {(clusterDbs.length === 0 || !clusterDbs.includes(ds.database)) && (
                        <Input value={ds.database} onChange={(_: unknown, d: any) => updateDataSource(idx, { database: d.value })} placeholder="loomdb-default" aria-label="KQL database (custom)" style={{ marginTop: clusterDbs.length > 0 ? 4 : 0 }} />
                      )}
                    </div>
                    <Button appearance="subtle" icon={<Delete20Regular />} onClick={() => removeDataSource(idx)} aria-label="Remove data source" />
                  </div>
                ))}
                {dataSources.length === 0 && <Caption1>No explicit data sources — tiles use the dashboard default database <strong>{defaultDb}</strong>.</Caption1>}
                <Button appearance="outline" icon={<Add20Regular />} onClick={addDataSource}>Add data source</Button>
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance="primary" onClick={() => setSourcesOpen(false)}>Done</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* Parameters dialog — free-text / fixed / multi / query / datasource / duration */}
      <Dialog open={paramsOpen} onOpenChange={(_: unknown, d: any) => setParamsOpen(d.open)}>
        <DialogSurface style={{ maxWidth: 720 }}>
          <DialogBody>
            <DialogTitle>Dashboard parameters</DialogTitle>
            <DialogContent>
              <Caption1>
                Parameters substitute into tile KQL by their variable name (Fabric convention, e.g. <code>_eventType</code>).
                Time range exposes <code>_startTime</code>/<code>_endTime</code>; <code>_loomTimeFrom</code> is also supported.
                <code> multi</code> renders as <code>dynamic([...])</code> for <code>x in (_var)</code> filters.
              </Caption1>
              <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, marginTop: tokens.spacingVerticalS}}>
                {params.map((p, idx) => (
                  <div key={idx} style={{ border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge, padding: tokens.spacingVerticalS, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS}}>
                    <div style={{ display: 'flex', gap: tokens.spacingVerticalS}}>
                      <div style={{ flex: 1 }}>
                        <Caption1>Variable name</Caption1>
                        <Input value={p.variableName} onChange={(_: unknown, d: any) => updateParam(idx, { variableName: d.value })} placeholder="_eventType" />
                      </div>
                      <div style={{ flex: 1 }}>
                        <Caption1>Label</Caption1>
                        <Input value={p.label || ''} onChange={(_: unknown, d: any) => updateParam(idx, { label: d.value })} />
                      </div>
                      <Button appearance="subtle" icon={<Delete20Regular />} onClick={() => removeParam(idx)} aria-label="Remove parameter" />
                    </div>
                    <div style={{ display: 'flex', gap: tokens.spacingVerticalS}}>
                      <div style={{ flex: 1 }}>
                        <Caption1>Type</Caption1>
                        <Select value={p.type} onChange={(_: unknown, d: any) => updateParam(idx, { type: d.value as DashParamType })}>
                          <option value="freetext">Free text</option>
                          <option value="fixed">Fixed values (single)</option>
                          <option value="multi">Multi-select</option>
                          <option value="query">Query-based</option>
                          <option value="datasource">Data source</option>
                          <option value="duration">Duration (time range)</option>
                        </Select>
                      </div>
                      <div style={{ flex: 1 }}>
                        <Caption1>Data type</Caption1>
                        <Select value={p.dataType || 'string'} onChange={(_: unknown, d: any) => updateParam(idx, { dataType: d.value as DashParamDataType })}>
                          <option value="string">string</option>
                          <option value="long">long</option>
                          <option value="int">int</option>
                          <option value="real">real</option>
                          <option value="datetime">datetime</option>
                          <option value="bool">bool</option>
                        </Select>
                      </div>
                    </div>
                    {(p.type === 'fixed' || p.type === 'multi') && (
                      <div>
                        <Caption1>Allowed values (comma-separated)</Caption1>
                        <Input value={(p.values || []).join(',')} onChange={(_: unknown, d: any) => updateParam(idx, { values: d.value.split(',').map((x: string) => x.trim()).filter(Boolean) })} />
                      </div>
                    )}
                    {p.type === 'query' && (
                      <>
                        <Caption1>Values query (returns one column)</Caption1>
                        <Textarea value={p.query || ''} onChange={(_: unknown, d: any) => updateParam(idx, { query: d.value })} rows={2} style={{ fontFamily: 'Consolas, monospace', fontSize: tokens.fontSizeBase200}} placeholder="StormEvents | distinct State" />
                        <div style={{ display: 'flex', gap: tokens.spacingVerticalS, alignItems: 'flex-end' }}>
                          <div style={{ flex: 1 }}>
                            <Caption1>Run against source</Caption1>
                            <Select value={p.dataSourceId || ''} onChange={(_: unknown, d: any) => updateParam(idx, { dataSourceId: d.value || undefined })}>
                              <option value="">{`(default: ${defaultDb})`}</option>
                              {dataSources.map((ds) => <option key={ds.id} value={ds.id}>{ds.name}</option>)}
                            </Select>
                          </div>
                          <Button size="small" appearance="outline" onClick={() => loadParamValues(p)}>Preview values</Button>
                        </div>
                        {paramValueCache[p.variableName] && <Caption1>{paramValueCache[p.variableName].length} values loaded.</Caption1>}
                      </>
                    )}
                  </div>
                ))}
                <Button appearance="outline" icon={<Add20Regular />} onClick={addParam}>Add parameter</Button>
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setParamsOpen(false)}>Close</Button>
              <Button appearance="primary" onClick={() => { setParamsOpen(false); runAll(); }}>Apply &amp; re-run</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* Edit JSON model dialog */}
      <Dialog open={jsonOpen} onOpenChange={(_: unknown, d: any) => setJsonOpen(d.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Edit dashboard model (JSON)</DialogTitle>
            <DialogContent>
              <Caption1>Full model: <code>{`{ tiles, dataSources, parameters, timeRange }`}</code>. An array root is accepted as just the tiles.</Caption1>
              <Textarea
                value={jsonText}
                onChange={(_: unknown, d: any) => { setJsonText(d.value); setJsonErr(null); }}
                rows={20}
                style={{ width: '100%', fontFamily: 'Consolas, monospace', fontSize: tokens.fontSizeBase200, marginTop: tokens.spacingVerticalS}}
                aria-label="Dashboard JSON model"
              />
              {jsonErr && <MessageBar intent="error" style={{ marginTop: tokens.spacingVerticalS}}><MessageBarBody><MessageBarTitle>JSON parse error</MessageBarTitle>{jsonErr}</MessageBarBody></MessageBar>}
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setJsonOpen(false)}>Cancel</Button>
              <Button appearance="primary" onClick={applyJson}>Apply</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* Share dialog */}
      <Dialog open={shareOpen} onOpenChange={(_: unknown, d: any) => setShareOpen(d.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Share dashboard</DialogTitle>
            <DialogContent>
              <Caption1>Anyone with access to this Loom item can view it. Permissions are managed via the workspace item ACL.</Caption1>
              <div style={{ marginTop: tokens.spacingVerticalS, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS}}>
                <Caption1>Canonical URL</Caption1>
                <Input value={typeof window !== 'undefined' ? window.location.href : ''} readOnly />
                <Button appearance="outline" onClick={() => { if (typeof navigator !== 'undefined' && navigator.clipboard) navigator.clipboard.writeText(window.location.href).catch(() => {}); }}>Copy URL</Button>
                <Caption1>To grant another user access, add them to this item via the workspace permissions page (Loom RBAC). Tenant-wide sharing is not enabled in this deployment.</Caption1>
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance="primary" onClick={() => setShareOpen(false)}>Close</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* Anomaly / forecast tile builder — native-KQL time-series ML over ADX.
          The dialog composes the series_decompose KQL and hands it back; we add
          it as a time-chart tile bound to the dashboard default database. */}
      <AnomalyForecastDialog
        open={anomalyOpen}
        onOpenChange={setAnomalyOpen}
        itemId={id}
        database={defaultDb}
        fetchSchema={false}
        defaultMode="anomaly"
        onAddTile={addAnomalyTile}
      />
    </div>
  );

  // On /new there is no Cosmos record yet, so Save (PUT) / Run (POST) would
  // 404/operate without persistence. Mirror the Eventstream/Activator pattern:
  // an ENABLED create surface mints a Cosmos kql-dashboard item, then routes to
  // this live editor where Add tile + Run + Save + parameters all work against
  // the real Kusto cluster + Cosmos.
  if (id === 'new') {
    return (
      <NewItemCreateGate item={item} createLabel="New Real-Time Dashboard"
        intro="A Real-Time (KQL) Dashboard is a collection of tiles — each a KQL query bound to a KQL database, rendered as a table, time chart, bar/column, pie, stat card, or map. Bind data sources, add dashboard parameters (free-text, fixed, query-based, time range) that substitute into tile KQL, set auto-refresh, and Save. Create it, then build tiles that run live against the Loom shared ADX cluster." />
    );
  }

  return <ItemEditorChrome item={item} id={id} ribbon={ribbon} main={main} />;
}
