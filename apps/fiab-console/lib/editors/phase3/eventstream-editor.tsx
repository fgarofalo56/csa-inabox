'use client';

/**
 * EventstreamEditor — extracted from phase3-editors.tsx (byte-for-byte move).
 *
 * Azure-native by DEFAULT (Azure Event Hubs + Stream Analytics); no Fabric is
 * required. The editor's exclusive helpers (StreamCfg / EventstreamState types,
 * DEFAULT_ES_CFG, the SQL-operator tab: SqlSinkRow / DEFAULT_SQL_QUERY /
 * aliasesFromQuery / EventstreamSqlOperatorTab) move with it. The shared Loom
 * workspace picker (useWorkspaces / WorkspacePicker) is imported from
 * ./workspace-picker; the shared phase3 styles hook from ./styles.
 * phase3-editors.tsx re-exports EventstreamEditor from a barrel line, so the
 * registry resolves it unchanged.
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Subtitle2, Caption1, Badge, Button, Input, Spinner, Field, Link,
  Tab, TabList, Dropdown, Option, Tooltip,
  MessageBar, MessageBarBody, MessageBarTitle,
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  Select, tokens,
} from '@fluentui/react-components';
import {
  Play20Regular, Pause20Regular, Save20Regular, Add20Regular, Delete20Regular, ArrowSync20Regular,
  ArrowUp20Regular, ArrowDown20Regular,
  MathFormula20Regular, Flowchart20Regular, Open20Regular, Form20Regular, Flash20Regular,
  Filter20Regular, Table20Regular, DataArea20Regular, Merge20Regular, Branch20Regular,
  Notebook20Regular, DocumentBulletList20Regular,
} from '@fluentui/react-icons';
import { ItemEditorChrome } from '../item-editor-chrome';
import { NewItemCreateGate } from '../new-item-gate';
import { MonacoTextarea } from '@/lib/components/editor/monaco-textarea';
import { EventHubsNamespaceTree } from '@/lib/components/eventhubs/eventhubs-tree';
import {
  VisualDesigner as EventstreamVisualDesigner,
  type PipelineConfig as VisualPipelineConfig,
  type SourceNode as VisualSourceNode,
  type TransformNode as VisualTransformNode,
  type SinkNode as VisualSinkNode,
} from '@/lib/components/eventstream/visual-designer';
import { compileToSaql } from '@/lib/azure/asa-query-compiler';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';
import { useWorkspaces, WorkspacePicker } from './workspace-picker';
import { useStyles } from './styles';

interface StreamCfg {
  source?: Record<string, any>;
  sink?: Record<string, any>;
  transforms?: Array<Record<string, any>>;
}

interface EventstreamState {
  ok: boolean;
  runtimeStatus?: string;
  runtimeNote?: string;
  displayName?: string;
  config?: StreamCfg;
  asaJobName?: string | null;
  error?: string;
}

const DEFAULT_ES_CFG: StreamCfg = {
  source: { kind: 'eventhub', namespace: '', name: '', consumerGroup: '$Default' },
  transforms: [],
  sink: { kind: 'kusto', database: 'loomdb-default', table: '' },
};

// ============================================================
// Eventstream operator model (Fabric Eventstream parity: the 7 stream
// operators). Operators are stored as entries in the same wire `transforms[]`
// array the visual designer + provision route already read — so the guided
// builder, the canvas, and the Azure-native provisioner stay one model. The
// four operators the shared SAQL compiler does not model natively
// (Manage fields, Expand — plus Union/Join which it does) are emitted by the
// local `esBuildSaql` below; everything is typed config (no JSON authoring),
// clearing the no-freeform-config gate.
// ============================================================

interface EsFieldMap {
  /** Source column (or expression) to keep. */
  source: string;
  /** Rename target (blank = keep source name). */
  target?: string;
  /** Optional CAST target type (SAQL scalar type). */
  cast?: string;
}

type EsOpKind = 'filter' | 'manage-fields' | 'aggregate' | 'group-by' | 'expand' | 'union' | 'join';

const ES_OPERATOR_KINDS: Array<{ value: EsOpKind; label: string; icon: ReactNode; hint: string }> = [
  { value: 'filter', label: 'Filter', icon: <Filter20Regular />, hint: 'Keep only events matching a WHERE condition.' },
  { value: 'manage-fields', label: 'Manage fields', icon: <Table20Regular />, hint: 'Add, remove, rename or re-type columns (projection with CAST/alias).' },
  { value: 'aggregate', label: 'Aggregate', icon: <MathFormula20Regular />, hint: 'Windowed aggregate (SUM/COUNT/AVG/MIN/MAX) over a tumbling/hopping window.' },
  { value: 'group-by', label: 'Group by', icon: <MathFormula20Regular />, hint: 'Group events by columns + window and aggregate each group.' },
  { value: 'expand', label: 'Expand', icon: <DataArea20Regular />, hint: 'Flatten an array column into one row per element (CROSS APPLY GetArrayElements).' },
  { value: 'union', label: 'Union', icon: <Merge20Regular />, hint: 'Merge all upstream sources into one stream.' },
  { value: 'join', label: 'Join', icon: <Branch20Regular />, hint: 'Temporal JOIN with another source within a time bound.' },
];

const ES_CAST_TYPES = ['', 'bigint', 'float', 'nvarchar(max)', 'datetime', 'bit', 'record', 'array'];
const ES_AGG_FUNCS = ['COUNT', 'SUM', 'AVG', 'MIN', 'MAX'] as const;
const ES_WINDOW_TYPES = ['Tumbling', 'Hopping', 'Sliding', 'Session', 'Snapshot'] as const;
const ES_WINDOW_UNITS = ['second', 'minute', 'hour', 'day'] as const;

/** Default typed config for a freshly-added operator of `kind`. */
function esDefaultOperator(kind: EsOpKind, n: number): Record<string, any> {
  const base = { kind, name: `${kind}-${n}` };
  switch (kind) {
    case 'filter':
      return { ...base, expression: '' };
    case 'manage-fields':
      return { ...base, fieldMap: [{ source: '', target: '', cast: '' }] as EsFieldMap[] };
    case 'aggregate':
    case 'group-by':
      return {
        ...base, groupBy: [] as string[],
        aggregates: [{ func: 'COUNT', field: '*', alias: 'eventCount' }],
        windowType: 'Tumbling', windowSize: 5, windowUnit: 'minute', havingExpression: '',
      };
    case 'expand':
      return { ...base, expandField: '', expandAlias: 'element', expandOutput: '' };
    case 'union':
      return { ...base };
    case 'join':
      return { ...base, joinSource: '', joinType: 'INNER', joinOn: 'L.id = R.id', joinDurationSeconds: 60 };
    default:
      return base;
  }
}

// ---- self-contained SAQL emitter (covers the 2 operators the shared
// compiler doesn't: manage-fields + expand). Grounded in the Stream Analytics
// Query Language reference: CAST, CROSS APPLY GetArrayElements, TumblingWindow,
// System.Timestamp(), HAVING, DATEDIFF join, UNION. ----
function esBr(name?: string): string {
  const clean = (name || 'input').replace(/[[\]]/g, '').trim();
  return `[${clean || 'input'}]`;
}
function esWindowClause(t: any): string | null {
  if (!t.windowType) return null;
  const unit = t.windowUnit || 'second';
  const size = t.windowSize ?? 30;
  switch (t.windowType) {
    case 'Tumbling': return `TumblingWindow(${unit}, ${size})`;
    case 'Hopping': return `HoppingWindow(${unit}, ${size}, ${t.hopSize ?? size})`;
    case 'Sliding': return `SlidingWindow(${unit}, ${size})`;
    case 'Session': return `SessionWindow(${unit}, ${size}, ${t.hopSize ?? size})`;
    case 'Snapshot': return 'SnapshotWindow()';
    default: return null;
  }
}
function esAggregateSelectList(t: any): string {
  const parts: string[] = [];
  (t.groupBy || []).forEach((c: string) => c && parts.push(c.trim()));
  (t.selectFields || []).forEach((c: string) => c && parts.push(c.trim()));
  (t.aggregates || []).forEach((a: any) => {
    if (!a || !a.func) return;
    const field = a.func === 'COUNT' ? (a.field && a.field !== '*' ? a.field : '*') : a.field || '*';
    const alias = (a.alias || `${String(a.func).toLowerCase()}_${(a.field || 'all').replace(/[^A-Za-z0-9_]/g, '')}`).trim();
    parts.push(`${a.func}(${field}) AS ${alias}`);
  });
  if (esWindowClause(t)) parts.push('System.Timestamp() AS windowEnd');
  return parts.length ? parts.join(', ') : '*';
}
function esManageFieldsSelectList(t: any): string {
  const maps: EsFieldMap[] = Array.isArray(t.fieldMap) ? t.fieldMap.filter((m: EsFieldMap) => m && (m.source || '').trim()) : [];
  if (!maps.length) return '*';
  return maps.map((m) => {
    const src = m.source.trim();
    const tgt = (m.target || '').trim();
    const cast = (m.cast || '').trim();
    const base = cast ? `CAST(${src} AS ${cast})` : src;
    if (tgt && tgt !== src) return `${base} AS ${tgt}`;
    if (cast) return `${base} AS ${src}`;
    return base;
  }).join(', ');
}
function esSelectList(t: any): string {
  switch (t.kind) {
    case 'manage-fields': return esManageFieldsSelectList(t);
    case 'aggregate':
    case 'group-by':
    case 'window': return esAggregateSelectList(t);
    case 'expand': {
      const alias = (t.expandAlias || 'element').trim() || 'element';
      const outCol = (t.expandOutput || t.expandField || 'value').trim() || 'value';
      return `${alias}.ArrayValue AS ${outCol}`;
    }
    case 'join': return 'L.*, R.*';
    case 'filter':
    case 'union':
    default: return '*';
  }
}
function esTail(t: any, fromRef: string, isSource: boolean, sources: any[]): string {
  const ts = isSource && t.timestampBy ? ` TIMESTAMP BY ${String(t.timestampBy).trim()}` : '';
  switch (t.kind) {
    case 'filter': {
      const where = (t.expression || '').trim();
      return `FROM ${fromRef}${ts}${where ? `\nWHERE ${where}` : ''}`;
    }
    case 'manage-fields':
      return `FROM ${fromRef}${ts}`;
    case 'aggregate':
    case 'group-by':
    case 'window': {
      const gb: string[] = [...(t.groupBy || []).map((c: string) => c.trim()).filter(Boolean)];
      const w = esWindowClause(t);
      if (w) gb.push(w);
      const groupBy = gb.length ? `\nGROUP BY ${gb.join(', ')}` : '';
      const having = (t.havingExpression || '').trim() ? `\nHAVING ${t.havingExpression.trim()}` : '';
      return `FROM ${fromRef}${ts}${groupBy}${having}`;
    }
    case 'expand': {
      const alias = (t.expandAlias || 'element').trim() || 'element';
      const arr = (t.expandField || 'items').trim() || 'items';
      return `FROM ${fromRef}${ts}\nCROSS APPLY GetArrayElements(${arr}) AS ${alias}`;
    }
    case 'join': {
      const right = esBr(t.joinSource || sources[1]?.name || 'right');
      const jt = t.joinType || 'INNER';
      const on = (t.joinOn || 'L.id = R.id').trim();
      const dur = t.joinDurationSeconds ?? 60;
      return `FROM ${fromRef} L${ts}\n${jt} JOIN ${right} R\nON ${on}\nAND DATEDIFF(second, L, R) BETWEEN 0 AND ${dur}`;
    }
    case 'union': {
      const aliases = sources.length ? sources.map((sn: any) => esBr(sn.name)) : [fromRef];
      const [first, ...rest] = aliases;
      const tail = rest.map((a: string) => `UNION\nSELECT *\nFROM ${a}`).join('\n');
      return tail ? `FROM ${first}\n${tail}` : `FROM ${first}`;
    }
    default:
      return `FROM ${fromRef}${ts}`;
  }
}
const ES_SAQL_HEADER = '-- Generated by CSA Loom Eventstream operator builder — edit the operators, not this text.';
/** Emit SAQL for the whole operator chain (all 7 operators). */
function esBuildSaql(sources: any[], transforms: any[], sinks: any[]): string {
  const srcAlias = esBr(sources[0]?.name || 'input');
  const sinkList = sinks.length ? sinks : [{ kind: 'kusto', name: 'output' }];
  if (!transforms.length) {
    const body = sinkList.map((sk) => `SELECT *\nINTO ${esBr(sk.name)}\nFROM ${srcAlias}`).join(';\n\n');
    return `${ES_SAQL_HEADER}\n\n${body}\n`;
  }
  const hasUnion = transforms.some((t) => t.kind === 'union');
  if (transforms.length === 1 && !hasUnion) {
    const t = transforms[0];
    const selectList = esSelectList(t);
    const body = sinkList.map((sk) => `SELECT ${selectList}\nINTO ${esBr(sk.name)}\n${esTail(t, srcAlias, true, sources)}`).join(';\n\n');
    return `${ES_SAQL_HEADER}\n\n${body}\n`;
  }
  const ctes: string[] = [];
  let prev = srcAlias;
  let prevIsSource = true;
  transforms.forEach((t, i) => {
    const stepName = `step${i + 1}`;
    const inner = `  SELECT ${esSelectList(t)}\n  ${esTail(t, prev, prevIsSource, sources).replace(/\n/g, '\n  ')}`;
    ctes.push(`${stepName} AS (\n${inner}\n)`);
    prev = stepName;
    prevIsSource = false;
  });
  const finalSelects = sinkList.map((sk) => `SELECT *\nINTO ${esBr(sk.name)}\nFROM ${prev}`).join(';\n\n');
  return `${ES_SAQL_HEADER}\n\nWITH ${ctes.join(',\n')}\n${finalSelects}\n`;
}
/**
 * Compile the topology to a definition SAQL. Reuses the shared, proven
 * compiler for the kinds it models; falls back to the local emitter only when
 * a Manage-fields / Expand operator is present (the two it doesn't model).
 */
function esCompileDefinition(sources: any[], transforms: any[], sinks: any[]): string {
  const hasCustom = (transforms || []).some((t: any) => t.kind === 'manage-fields' || t.kind === 'expand');
  if (!hasCustom) {
    try { return compileToSaql(sources as any, transforms as any, sinks as any); } catch { /* fall through */ }
  }
  return esBuildSaql(sources, transforms, sinks);
}
/** Normalize a parsed cfg into { sources[], transforms[], sinks[] }. */
function esTopology(cfg: any): { sources: any[]; transforms: any[]; sinks: any[] } {
  const c = cfg || {};
  const sources = Array.isArray(c.sources) && c.sources.length ? c.sources : (c.source ? [c.source] : []);
  const sinks = Array.isArray(c.sinks) && c.sinks.length ? c.sinks : (c.sink ? [c.sink] : []);
  const transforms = Array.isArray(c.transforms) ? c.transforms : [];
  return { sources, transforms, sinks };
}

export function EventstreamEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const ws = useWorkspaces();
  const [workspaceId, setWorkspaceId] = useState('');
  const [state, setState] = useState<EventstreamState | null>(null);
  const [cfgText, setCfgText] = useState(JSON.stringify(DEFAULT_ES_CFG, null, 2));
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [parseErr, setParseErr] = useState<string | null>(null);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'designer' | 'operators' | 'sql' | 'definition'>('designer');
  // Publish-to-Fabric dialog state. Publishing creates/updates a REAL
  // Fabric Eventstream item via the definition REST API.
  const [publishOpen, setPublishOpen] = useState(false);
  const [fabricWsId, setFabricWsId] = useState('');
  const [publishBusy, setPublishBusy] = useState(false);
  const [publishErr, setPublishErr] = useState<string | null>(null);
  const [publishHint, setPublishHint] = useState<string | null>(null);
  const [publishMsg, setPublishMsg] = useState<string | null>(null);
  const [publishedId, setPublishedId] = useState<string | null>(null);
  // Push-to-ASA: materialize the saved destination nodes as real Azure Stream
  // Analytics outputs (KQL DB → ADX, Lakehouse → ADLS Gen2 Blob, Event Hub,
  // Activator → Event Hub). The target ASA job is named here and persisted.
  const [asaJobName, setAsaJobName] = useState(
    (typeof process !== 'undefined' && process.env.NEXT_PUBLIC_LOOM_ASA_JOB_NAME) || '',
  );
  const [asaSyncBusy, setAsaSyncBusy] = useState(false);
  const [asaSyncErr, setAsaSyncErr] = useState<string | null>(null);
  const [asaSyncHint, setAsaSyncHint] = useState<string | null>(null);
  const [asaSyncMsg, setAsaSyncMsg] = useState<string | null>(null);
  const [asaOutputs, setAsaOutputs] = useState<Array<{ name: string; type: string; id: string }>>([]);
  // Provision-to-Azure (Azure-native default: Event Hubs + Stream Analytics).
  // Maps the saved canvas topology onto real ARM resources — no Fabric needed.
  const [provisionBusy, setProvisionBusy] = useState(false);
  const [provisionResult, setProvisionResult] = useState<{ ehId?: string; asaJobId?: string | null; steps?: string[]; partial?: boolean; hint?: string | null } | null>(null);
  const [provisionErr, setProvisionErr] = useState<string | null>(null);
  const [provisionHint, setProvisionHint] = useState<string | null>(null);
  // Add-alert (embedded Activator): the ribbon quick-create lazily creates a
  // REAL backing Activator item linked to this stream and pre-seeds an Azure
  // Monitor scheduled-query alert rule from the stream's source. No Fabric.
  const [alertOpen, setAlertOpen] = useState(false);
  const [alertName, setAlertName] = useState('');
  const [alertProperty, setAlertProperty] = useState('value');
  const [alertOperator, setAlertOperator] = useState<'gt' | 'lt' | 'gte' | 'lte' | 'eq' | 'ne'>('gt');
  const [alertThreshold, setAlertThreshold] = useState('0');
  const [alertFrequency, setAlertFrequency] = useState<'PT1M' | 'PT5M' | 'PT15M' | 'PT1H'>('PT5M');
  const [alertEmail, setAlertEmail] = useState('');
  const [alertBusy, setAlertBusy] = useState(false);
  const [alertErr, setAlertErr] = useState<string | null>(null);
  const [alertHint, setAlertHint] = useState<string | null>(null);
  const [alertResult, setAlertResult] = useState<{ activatorId: string; activatorName?: string; ruleId: string; source?: { kind: string; name: string } | null } | null>(null);

  // Visual designer ↔ JSON sync. Best-effort: when JSON parses we mirror
  // it into the designer; when the designer changes we re-serialize JSON.
  let parsedVisual: VisualPipelineConfig = {};
  try { parsedVisual = JSON.parse(cfgText) as VisualPipelineConfig; } catch { parsedVisual = {}; }

  const onDesignerChange = useCallback((next: VisualPipelineConfig) => {
    // Project back to the on-wire shape { source, transforms[], sink } that the BFF persists.
    const sources = Array.isArray(next.sources) ? next.sources : (next.source ? [next.source] : []);
    const sinks = Array.isArray(next.sinks) ? next.sinks : (next.sink ? [next.sink] : []);
    const projected: any = {
      source: sources[0] as VisualSourceNode | undefined,
      transforms: (next.transforms || []) as VisualTransformNode[],
      sink: sinks[0] as VisualSinkNode | undefined,
    };
    // Preserve multi-source/multi-sink if present so we don't lose data.
    if (sources.length > 1) projected.sources = sources;
    if (sinks.length > 1) projected.sinks = sinks;
    setCfgText(JSON.stringify(projected, null, 2));
    setDirty(true);
    setParseErr(null);
    setSaveErr(null);
  }, []);

  // Merge a partial topology patch (sources/transforms/sinks) into the wire cfg
  // and push it through the same projection the designer uses, so the guided
  // Operators builder, the canvas, and the JSON model stay in lock-step.
  const commitTopology = useCallback(
    (patch: { sources?: any[]; transforms?: any[]; sinks?: any[] }) => {
      let cur: VisualPipelineConfig = {};
      try { cur = JSON.parse(cfgText) as VisualPipelineConfig; } catch { cur = {}; }
      const t = esTopology(cur);
      onDesignerChange({
        sources: patch.sources ?? t.sources,
        transforms: patch.transforms ?? t.transforms,
        sinks: patch.sinks ?? t.sinks,
      });
    },
    [cfgText, onDesignerChange],
  );

  // Auto-pick the first workspace once loaded so the editor isn't blocked
  // on a manual click for the common single-workspace deployments. Users
  // can still switch via the picker below.
  useEffect(() => {
    if (!workspaceId && ws.workspaces && ws.workspaces.length > 0) {
      setWorkspaceId(ws.workspaces[0].id);
    }
  }, [workspaceId, ws.workspaces]);

  const load = useCallback(async () => {
    // Pre-save gate: /items/eventstream/new fires this before any record exists
    // (was returning 404 on the walkthrough validator). Skip the fetch so the
    // editor renders its default DEFAULT_ES_CFG until the user saves.
    if (!id || id === 'new') return;
    try {
      const r = await fetch(`/api/items/eventstream/${id}`);
      const j = (await r.json()) as EventstreamState & { fabricEventstreamId?: string | null };
      setState(j);
      if (j.fabricEventstreamId) setPublishedId(j.fabricEventstreamId);
      if (j.asaJobName) setAsaJobName(j.asaJobName);
      const cfg = j.config && (j.config.source || j.config.sink || (j.config.transforms?.length ?? 0) > 0)
        ? j.config
        : DEFAULT_ES_CFG;
      setCfgText(JSON.stringify(cfg, null, 2));
      setDirty(false);
      setParseErr(null); setSaveErr(null); setSaveMsg(null);
    } catch (e: any) {
      setState({ ok: false, error: e?.message || String(e) });
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  const save = useCallback(async () => {
    setParseErr(null); setSaveErr(null);
    let parsed: StreamCfg;
    try { parsed = JSON.parse(cfgText); }
    catch (e: any) {
      const m = e?.message || 'invalid JSON';
      setParseErr(m);
      setSaveMsg(`Cannot save: JSON parse error — ${m}`);
      return;
    }
    setSaving(true); setSaveMsg('Saving…');
    try {
      const r = await fetch(`/api/items/eventstream/${id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ config: parsed }),
      });
      const j = await r.json();
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
  }, [id, cfgText]);

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

  // Publish the saved pipeline to a REAL Fabric Eventstream item. Saves
  // first if there are unsaved edits, then POSTs to the publish route.
  const doPublish = useCallback(async () => {
    if (!fabricWsId.trim()) { setPublishErr('Fabric workspace ID is required'); return; }
    setPublishBusy(true); setPublishErr(null); setPublishHint(null); setPublishMsg(null);
    try {
      if (dirty) { await save(); }
      const r = await fetch(`/api/items/eventstream/${id}/publish?fabricWorkspaceId=${encodeURIComponent(fabricWsId.trim())}`, {
        method: 'POST',
      });
      const j = await r.json();
      if (!j.ok) {
        setPublishErr(j.error || 'publish failed');
        setPublishHint(j.hint || null);
        return;
      }
      setPublishedId(j.fabricEventstreamId || null);
      setPublishMsg(
        j.accepted
          ? 'Publish accepted by Fabric (provisioning asynchronously). The Eventstream item will appear in the Fabric workspace shortly.'
          : `Published to Fabric Eventstream${j.fabricEventstreamId ? ` (${j.fabricEventstreamId})` : ''}.`,
      );
      load();
    } catch (e: any) {
      setPublishErr(e?.message || String(e));
    } finally {
      setPublishBusy(false);
    }
  }, [fabricWsId, dirty, save, id, load]);

  // Pull the LIVE topology back from the published Fabric Eventstream item
  // (real getDefinition REST), decode it, and load it into the designer. This
  // closes the round-trip: design → publish → pull-back-and-edit.
  const [pullBusy, setPullBusy] = useState(false);
  const pullFromFabric = useCallback(async () => {
    setPullBusy(true); setSaveErr(null); setSaveMsg('Pulling live topology from Fabric…');
    try {
      const qs = fabricWsId.trim() ? `?fabricWorkspaceId=${encodeURIComponent(fabricWsId.trim())}` : '';
      const r = await fetch(`/api/items/eventstream/${id}/definition${qs}`);
      const j = await r.json();
      if (!j.ok) {
        setSaveErr(j.error || `HTTP ${r.status}`);
        setSaveMsg(j.hint ? `${j.error} — ${j.hint}` : (j.error || 'pull failed'));
        return;
      }
      setCfgText(JSON.stringify(j.config, null, 2));
      setDirty(true);
      setActiveTab('designer');
      setSaveMsg('Pulled the live Fabric topology into the designer. Save to persist locally.');
    } catch (e: any) {
      setSaveErr(e?.message || String(e));
    } finally {
      setPullBusy(false);
    }
  }, [id, fabricWsId]);

  const canSave = !saving && dirty;

  // Push the saved destination nodes to a real ASA job as outputs. Saves first
  // if there are unsaved edits so the route reads the latest topology.
  const pushToAsa = useCallback(async () => {
    if (!asaJobName.trim()) { setAsaSyncErr('ASA job name is required'); return; }
    setAsaSyncBusy(true); setAsaSyncErr(null); setAsaSyncHint(null); setAsaSyncMsg(null);
    try {
      if (dirty) { await save(); }
      const r = await fetch(`/api/items/eventstream/${id}/asa-sync`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ asaJobName: asaJobName.trim() }),
      });
      const j = await r.json();
      if (!j.ok) {
        setAsaSyncErr(j.error || `HTTP ${r.status}`);
        setAsaSyncHint(j.hint || null);
        setAsaOutputs([]);
        return;
      }
      setAsaOutputs(j.outputs || []);
      const n = (j.outputs || []).length;
      const skippedNote = (j.skipped || []).length ? ` (${j.skipped.length} skipped)` : '';
      setAsaSyncMsg(
        n
          ? `Created ${n} ASA output${n === 1 ? '' : 's'} on job "${j.asaJobName}"${skippedNote}. Start the job in the Stream Analytics editor to land transformed events.`
          : `No external outputs were created${skippedNote}. Add a KQL Database, Lakehouse, or Event Hub destination.`,
      );
    } catch (e: any) {
      setAsaSyncErr(e?.message || String(e));
    } finally {
      setAsaSyncBusy(false);
    }
  }, [asaJobName, dirty, save, id]);

  // Provision the saved canvas topology onto the Azure-native backend: an
  // Event Hub (transport) + a Stream Analytics job (transform) when transforms
  // exist. Returns the ARM resource IDs of both as the receipt. No Fabric.
  const doProvision = useCallback(async () => {
    setProvisionBusy(true); setProvisionErr(null); setProvisionHint(null); setProvisionResult(null);
    try {
      // Persist the current canvas first so the route reads the latest topology.
      await save();
      const r = await fetch(`/api/items/eventstream/${id}/provision`, { method: 'POST' });
      const j = await r.json();
      if (!j.ok) {
        setProvisionErr(j.error || `HTTP ${r.status}`);
        setProvisionHint(j.hint || null);
        return;
      }
      setProvisionResult({ ehId: j.ehId, asaJobId: j.asaJobId, steps: j.steps, partial: j.partial, hint: j.hint });
      load();
    } catch (e: any) {
      setProvisionErr(e?.message || String(e));
    } finally {
      setProvisionBusy(false);
    }
  }, [save, id, load]);

  // Add-alert: create + link a backing Activator pre-seeded with this stream's
  // source. Saves the canvas first so the route reads the latest topology (the
  // alert KQL is composed from the first source node), then POSTs to the
  // eventstream activator route. The created Activator is linked onto this
  // stream (state.activatorId) and a real Azure Monitor scheduledQueryRule is
  // created — Azure-native default, no Fabric Reflex required.
  const doAddAlert = useCallback(async () => {
    setAlertBusy(true); setAlertErr(null); setAlertHint(null); setAlertResult(null);
    try {
      if (dirty) { await save(); }
      const action = alertEmail.trim() ? { target: alertEmail.trim() } : undefined;
      const r = await fetch(`/api/items/eventstream/${id}/activator`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ruleName: alertName.trim() || undefined,
          property: alertProperty.trim() || 'value',
          operator: alertOperator,
          threshold: alertThreshold.trim(),
          evaluationFrequency: alertFrequency,
          windowSize: alertFrequency,
          ...(action ? { action } : {}),
        }),
      });
      const j = await r.json();
      if (!j.ok) {
        setAlertErr(j.error || `HTTP ${r.status}`);
        setAlertHint(j.gate?.remediation || j.hint || null);
        return;
      }
      setAlertResult({ activatorId: j.activatorId, activatorName: j.activatorName, ruleId: j.ruleId, source: j.source });
    } catch (e: any) {
      setAlertErr(e?.message || String(e));
    } finally {
      setAlertBusy(false);
    }
  }, [dirty, save, id, alertEmail, alertName, alertProperty, alertOperator, alertThreshold, alertFrequency]);

  // Ribbon-driven add/transform helpers. They mutate cfgText (the on-wire
  // shape) directly so the visual designer + Monaco JSON view stay in sync.
  const ribbonAdd = useCallback(
    (kind: 'source' | 'sink' | 'transform', preset?: Record<string, any>) => {
      let cur: VisualPipelineConfig = {};
      try { cur = JSON.parse(cfgText) as VisualPipelineConfig; } catch { cur = {}; }
      const sources: any[] = Array.isArray(cur.sources) ? cur.sources : (cur.source ? [cur.source] : []);
      const sinks: any[] = Array.isArray(cur.sinks) ? cur.sinks : (cur.sink ? [cur.sink] : []);
      const transforms: any[] = cur.transforms || [];
      if (kind === 'source') {
        sources.push({ kind: 'eventhub', name: `source-${sources.length + 1}`, namespace: '', consumerGroup: '$Default' });
      } else if (kind === 'sink') {
        const sinkKind = (preset?.kind as any) || 'kusto';
        const base: Record<string, any> = { kind: sinkKind, name: `sink-${sinks.length + 1}` };
        if (sinkKind === 'kusto') { base.database = 'loomdb-default'; base.table = ''; }
        if (sinkKind === 'lakehouse') { base.container = ''; base.pathPattern = 'events/{date}/{time}'; }
        sinks.push({ ...base, ...preset });
      } else {
        const tk = ((preset?.kind as any) || 'filter') as EsOpKind;
        transforms.push(esDefaultOperator(tk, transforms.length + 1));
      }
      onDesignerChange({ sources, sinks, transforms });
      setActiveTab(kind === 'transform' ? 'operators' : 'designer');
    },
    [cfgText, onDesignerChange],
  );

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Source', actions: [
        { label: 'Add source', onClick: () => ribbonAdd('source') },
        { label: 'Sample data', onClick: () => {
            let cur: VisualPipelineConfig = {};
            try { cur = JSON.parse(cfgText) as VisualPipelineConfig; } catch { cur = {}; }
            const sources = Array.isArray(cur.sources) ? cur.sources : (cur.source ? [cur.source] : []);
            sources.push({ kind: 'sample', name: `sample-${sources.length + 1}` });
            onDesignerChange({ sources, sinks: cur.sinks || (cur.sink ? [cur.sink] : []), transforms: cur.transforms || [] });
            setActiveTab('designer');
          } },
      ]},
      { label: 'Transform', actions: [
        { label: 'Filter', onClick: () => ribbonAdd('transform', { kind: 'filter' }) },
        { label: 'Manage fields', onClick: () => ribbonAdd('transform', { kind: 'manage-fields' }) },
        { label: 'Aggregate', onClick: () => ribbonAdd('transform', { kind: 'aggregate' }) },
        { label: 'Group by', onClick: () => ribbonAdd('transform', { kind: 'group-by' }) },
        { label: 'Expand', onClick: () => ribbonAdd('transform', { kind: 'expand' }) },
        { label: 'Union', onClick: () => ribbonAdd('transform', { kind: 'union' }) },
        { label: 'Join', onClick: () => ribbonAdd('transform', { kind: 'join' }) },
      ]},
      { label: 'Destination', actions: [
        { label: 'KQL Database', onClick: () => ribbonAdd('sink', { kind: 'kusto' }) },
        { label: 'Lakehouse (ADLS)', onClick: () => ribbonAdd('sink', { kind: 'lakehouse' }) },
        { label: 'Event Hub', onClick: () => ribbonAdd('sink', { kind: 'eventhub' }) },
        { label: 'Activator', onClick: () => ribbonAdd('sink', { kind: 'reflex' }) },
      ]},
      { label: 'Alerts', actions: [
        // Fabric Eventstream "Set alert" parity — create + link an Activator
        // pre-seeded with this stream's source (Azure Monitor alert, no Fabric).
        { label: 'Add alert', onClick: () => { setAlertResult(null); setAlertErr(null); setAlertHint(null); setAlertOpen(true); },
          title: 'Create a linked Activator alert pre-seeded with this stream’s source (Azure Monitor scheduled-query rule)' },
      ]},
      { label: 'Publish', actions: [
        { label: saving ? 'Saving…' : 'Save', onClick: canSave ? save : undefined, disabled: !canSave },
        { label: asaSyncBusy ? 'Pushing…' : 'Push to ASA', onClick: !asaSyncBusy && asaJobName.trim() ? pushToAsa : undefined,
          disabled: asaSyncBusy || !asaJobName.trim(),
          title: asaJobName.trim() ? 'Create ASA outputs for each destination (real ARM PUT)' : 'Enter an ASA job name first' },
        { label: provisionBusy ? 'Provisioning…' : 'Provision to Azure', onClick: provisionBusy ? undefined : doProvision, disabled: provisionBusy,
          title: 'Create an Event Hub (transport) + Stream Analytics job (transform) from the canvas topology — Azure-native, no Fabric required' },
        { label: 'Publish to Fabric', onClick: () => setPublishOpen(true) },
        { label: pullBusy ? 'Pulling…' : 'Pull from Fabric', onClick: pullBusy ? undefined : pullFromFabric, disabled: pullBusy,
          title: 'Reload the live topology from the published Fabric Eventstream (getDefinition REST)' },
      ]},
    ]},
  ], [saving, canSave, save, ribbonAdd, cfgText, onDesignerChange, pullBusy, pullFromFabric, asaSyncBusy, asaJobName, pushToAsa, provisionBusy, doProvision]);

  // On /new there is no Cosmos record yet, so Save (PUT) would 404 — the
  // designer rendered but couldn't persist (the "wonky / not functional"
  // verdict). Mirror the Activator pattern: an ENABLED create surface mints a
  // Cosmos eventstream item and routes to the live editor below, where Save +
  // Publish-to-Fabric + Pull-from-Fabric all work against the real backend.
  if (id === 'new') {
    return (
      <NewItemCreateGate item={item} createLabel="New eventstream"
        intro="An Eventstream is a streaming topology: sources (Event Hubs, IoT Hub, Kafka, sample data) → operators (filter, manage fields, aggregate, group-by, expand, union, join) → destinations (Eventhouse/KQL, Lakehouse, Activator, derived stream, Spark notebook). Create it, then design the topology on the visual canvas or the guided Operators builder and Provision to Azure to stand up a real Event Hub (transport) + Stream Analytics job (transform) — Azure-native, no Fabric required. Publishing to Microsoft Fabric is available as an opt-in alternative." />
    );
  }

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon}
      leftPanel={
        // Azure Event Hubs namespace navigator (parity wave 5): the underlying
        // Azure service that feeds Fabric Eventstream sources. Typed groups for
        // Event hubs / Consumer groups (per hub) / Schema groups / Authorization
        // rules / Networking / Geo-recovery with live counts, ＋New, filter, and
        // inline delete — all on real Microsoft.EventHub ARM REST. Picking an
        // event hub copies its name for use as an Eventstream source.
        <EventHubsNamespaceTree
          onSelectEventHub={(eh) => {
            if (typeof navigator !== 'undefined' && navigator.clipboard) {
              void navigator.clipboard.writeText(eh).catch(() => { /* clipboard may be blocked */ });
            }
          }}
        />
      }
      main={
      <div className={s.pad}>
        <MessageBar intent="info">
          <MessageBarBody>
            <MessageBarTitle>Design here, provision to Azure (Fabric optional)</MessageBarTitle>
            Design the topology below — it is saved to Cosmos as you edit. <strong>Provision to Azure</strong>
            {' '}stands up the Azure-native backend — a real Event Hub (transport) + Stream Analytics job
            (transform) from the canvas — no Fabric required. <strong>Publish to Fabric</strong> is an opt-in
            alternative that creates (or updates) a Fabric Eventstream item via the Fabric definition REST API
            ({' '}<code>POST /workspaces/&#123;ws&#125;/eventstreams</code>); after publishing, activate the
            stream&apos;s nodes in the Fabric portal (the per-node Activate/Deactivate toggle is portal-only —
            it is not exposed in the public Fabric REST surface).
          </MessageBarBody>
        </MessageBar>

        <div className={s.toolbar}>
          <Badge appearance="filled" color="brand">Eventstream</Badge>
          <WorkspacePicker value={workspaceId} onChange={setWorkspaceId} {...ws} />
          {state?.runtimeStatus && <Badge appearance="outline">{state.runtimeStatus}</Badge>}
          {publishedId && <Badge appearance="filled" color="success">published</Badge>}
          {dirty && <Badge appearance="outline" color="warning">unsaved</Badge>}
          <Button appearance="outline" icon={<ArrowSync20Regular />} onClick={load}>Reload</Button>
          {publishedId && (
            <Button appearance="outline" onClick={pullFromFabric} disabled={pullBusy}>
              {pullBusy ? 'Pulling…' : 'Pull from Fabric'}
            </Button>
          )}
          <Button appearance="outline" onClick={doProvision} disabled={provisionBusy} style={{ marginLeft: 'auto' }}>
            {provisionBusy ? 'Provisioning…' : 'Provision to Azure'}
          </Button>
          <Button appearance="outline" onClick={() => setPublishOpen(true)}>Publish to Fabric</Button>
          <Button appearance="primary" icon={<Save20Regular />} onClick={save} disabled={saving || !dirty}>
            {saving ? 'Saving…' : 'Save (Ctrl+S)'}
          </Button>
        </div>

        {/* Destination → Azure Stream Analytics outputs. Materialize each saved
            destination node (KQL DB → ADX, Lakehouse → ADLS Gen2, Event Hub,
            Activator → Event Hub) as a real ASA output via ARM. */}
        <div className={s.toolbar}>
          <Field label="ASA job" style={{ minWidth: 240 }}>
            <Input
              value={asaJobName}
              onChange={(_: unknown, d: any) => setAsaJobName(d.value)}
              placeholder="asa-loom-default-eastus2"
            />
          </Field>
          <Button
            appearance="primary"
            onClick={pushToAsa}
            disabled={asaSyncBusy || !asaJobName.trim()}
            style={{ alignSelf: 'flex-end' }}
          >
            {asaSyncBusy ? 'Pushing…' : 'Push destinations to ASA'}
          </Button>
          <Caption1 style={{ color: tokens.colorNeutralForeground3, alignSelf: 'flex-end' }}>
            Creates one ASA output per destination, then start the job in the Stream Analytics editor.
          </Caption1>
        </div>

        {asaSyncErr && (
          <MessageBar intent={asaSyncHint ? 'warning' : 'error'}>
            <MessageBarBody>
              <MessageBarTitle>{asaSyncHint ? 'Stream Analytics not configured' : 'Push to ASA failed'}</MessageBarTitle>
              {asaSyncErr}{asaSyncHint ? <><br /><Caption1>{asaSyncHint}</Caption1></> : null}
            </MessageBarBody>
          </MessageBar>
        )}
        {asaSyncMsg && !asaSyncErr && (
          <MessageBar intent="success">
            <MessageBarBody>
              <MessageBarTitle>Destinations pushed to ASA</MessageBarTitle>
              {asaSyncMsg}
              {asaOutputs.length > 0 && (
                <ul style={{ margin: `${tokens.spacingVerticalXS} 0 0`, paddingLeft: 18 }}>
                  {asaOutputs.map((o) => (
                    <li key={o.name}><code>{o.name}</code> → {o.type}</li>
                  ))}
                </ul>
              )}
            </MessageBarBody>
          </MessageBar>
        )}

        <Dialog open={publishOpen} onOpenChange={(_: unknown, d: any) => setPublishOpen(d.open)}>
          <DialogSurface>
            <DialogBody>
              <DialogTitle>Publish to Fabric Eventstream</DialogTitle>
              <DialogContent>
                <Caption1>
                  Publishes this pipeline as a real Fabric Eventstream item. Enter the target
                  Fabric workspace GUID (app.fabric.microsoft.com &rarr; workspace &rarr; Settings).
                  The Console UAMI must be a Contributor (or higher) on that workspace and the tenant
                  must have &quot;Service principals can use Fabric APIs&quot; enabled.
                </Caption1>
                <Field label="Fabric workspace ID" required style={{ marginTop: tokens.spacingVerticalM}}>
                  <Input
                    value={fabricWsId}
                    onChange={(_: unknown, d: any) => setFabricWsId(d.value)}
                    placeholder="00000000-0000-0000-0000-000000000000"
                  />
                </Field>
                {publishErr && (
                  <MessageBar intent="error" style={{ marginTop: tokens.spacingVerticalM}}>
                    <MessageBarBody>
                      <MessageBarTitle>Publish failed</MessageBarTitle>
                      {publishErr}{publishHint ? <><br /><Caption1>{publishHint}</Caption1></> : null}
                    </MessageBarBody>
                  </MessageBar>
                )}
                {publishMsg && !publishErr && (
                  <MessageBar intent="success" style={{ marginTop: tokens.spacingVerticalM}}>
                    <MessageBarBody>{publishMsg}</MessageBarBody>
                  </MessageBar>
                )}
              </DialogContent>
              <DialogActions>
                <Button appearance="secondary" onClick={() => setPublishOpen(false)} disabled={publishBusy}>Close</Button>
                <Button appearance="primary" onClick={doPublish} disabled={publishBusy || !fabricWsId.trim()}>
                  {publishBusy ? 'Publishing…' : 'Publish'}
                </Button>
              </DialogActions>
            </DialogBody>
          </DialogSurface>
        </Dialog>

        {/* Add-alert (embedded Activator). Fabric Eventstream "Set alert" parity:
            create + link an Activator pre-seeded with this stream's source. The
            backend creates a real Azure Monitor scheduledQueryRule — no Fabric. */}
        <Dialog open={alertOpen} onOpenChange={(_: unknown, d: any) => setAlertOpen(d.open)}>
          <DialogSurface>
            <DialogBody>
              <DialogTitle>Add alert (linked Activator)</DialogTitle>
              <DialogContent>
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
                  <Flash20Regular style={{ flexShrink: 0, marginTop: tokens.spacingVerticalXXS, color: tokens.colorBrandForeground1 }} />
                  <Caption1 style={{ color: tokens.colorNeutralForeground2 }}>
                    Creates an <strong>Activator</strong> alert linked to this Eventstream and
                    pre-seeds it with the stream&apos;s source. Loom maps the alert to a real
                    Azure Monitor scheduled-query rule (Azure-native default — no Microsoft
                    Fabric Reflex required). The rule fires when the condition below matches
                    this stream&apos;s events.
                  </Caption1>
                </div>
                <Field label="Alert name" style={{ marginTop: tokens.spacingVerticalM}}>
                  <Input
                    value={alertName}
                    onChange={(_: unknown, d: any) => setAlertName(d.value)}
                    placeholder={`${state?.displayName || 'stream'}-alert`}
                    aria-label="Alert name"
                  />
                </Field>
                <div style={{ display: 'flex', gap: tokens.spacingVerticalS, marginTop: tokens.spacingVerticalM}}>
                  <Field label="Event property" style={{ flex: 2 }}>
                    <Input
                      value={alertProperty}
                      onChange={(_: unknown, d: any) => setAlertProperty(d.value)}
                      placeholder="value"
                      aria-label="Event property"
                    />
                  </Field>
                  <Field label="Operator" style={{ flex: 1 }}>
                    <Dropdown
                      selectedOptions={[alertOperator]}
                      value={{ gt: 'greater than', lt: 'less than', gte: '≥', lte: '≤', eq: 'equals', ne: 'not equals' }[alertOperator]}
                      onOptionSelect={(_: unknown, d: any) => setAlertOperator(d.optionValue)}
                      aria-label="Operator"
                    >
                      <Option value="gt">greater than</Option>
                      <Option value="lt">less than</Option>
                      <Option value="gte">≥</Option>
                      <Option value="lte">≤</Option>
                      <Option value="eq">equals</Option>
                      <Option value="ne">not equals</Option>
                    </Dropdown>
                  </Field>
                  <Field label="Threshold" style={{ flex: 1 }}>
                    <Input
                      value={alertThreshold}
                      onChange={(_: unknown, d: any) => setAlertThreshold(d.value)}
                      placeholder="0"
                      aria-label="Threshold"
                    />
                  </Field>
                </div>
                <div style={{ display: 'flex', gap: tokens.spacingVerticalS, marginTop: tokens.spacingVerticalM}}>
                  <Field label="Evaluate every" style={{ flex: 1 }}>
                    <Dropdown
                      selectedOptions={[alertFrequency]}
                      value={{ PT1M: '1 minute', PT5M: '5 minutes', PT15M: '15 minutes', PT1H: '1 hour' }[alertFrequency]}
                      onOptionSelect={(_: unknown, d: any) => setAlertFrequency(d.optionValue)}
                      aria-label="Evaluation frequency"
                    >
                      <Option value="PT1M">1 minute</Option>
                      <Option value="PT5M">5 minutes</Option>
                      <Option value="PT15M">15 minutes</Option>
                      <Option value="PT1H">1 hour</Option>
                    </Dropdown>
                  </Field>
                  <Field label="Notify email (optional)" style={{ flex: 2 }}>
                    <Input
                      value={alertEmail}
                      onChange={(_: unknown, d: any) => setAlertEmail(d.value)}
                      placeholder="oncall@contoso.com"
                      aria-label="Notify email"
                    />
                  </Field>
                </div>
                {/* Live rule preview — mirrors Azure portal's alert condition summary. */}
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
                    Fire when <strong>{(alertProperty.trim() || 'value')}</strong>{' '}
                    {{ gt: '>', lt: '<', gte: '≥', lte: '≤', eq: '=', ne: '≠' }[alertOperator]}{' '}
                    <strong>{(alertThreshold.trim() || '0')}</strong>, evaluated every{' '}
                    {{ PT1M: '1 minute', PT5M: '5 minutes', PT15M: '15 minutes', PT1H: '1 hour' }[alertFrequency]}
                    {alertEmail.trim() ? <> → email <strong>{alertEmail.trim()}</strong></> : null}.
                  </div>
                </div>
                {alertErr && (
                  <MessageBar intent={alertHint ? 'warning' : 'error'} style={{ marginTop: tokens.spacingVerticalM}}>
                    <MessageBarBody>
                      <MessageBarTitle>{alertHint ? 'Azure Monitor not configured' : 'Add alert failed'}</MessageBarTitle>
                      {alertErr}{alertHint ? <><br /><Caption1>{alertHint}</Caption1></> : null}
                    </MessageBarBody>
                  </MessageBar>
                )}
                {alertResult && !alertErr && (
                  <MessageBar intent="success" style={{ marginTop: tokens.spacingVerticalM}}>
                    <MessageBarBody>
                      <MessageBarTitle>Alert created and linked</MessageBarTitle>
                      Linked Activator <strong>{alertResult.activatorName || alertResult.activatorId}</strong> with
                      rule <code>{alertResult.ruleId}</code>
                      {alertResult.source ? <> (pre-seeded from source <code>{alertResult.source.name}</code>)</> : null}.
                      {' '}
                      <Link href={`/items/activator/${alertResult.activatorId}`} target="_blank">
                        Open the Activator <Open20Regular style={{ verticalAlign: 'middle' }} />
                      </Link>
                    </MessageBarBody>
                  </MessageBar>
                )}
              </DialogContent>
              <DialogActions>
                <Button appearance="secondary" onClick={() => setAlertOpen(false)} disabled={alertBusy}>Close</Button>
                <Button appearance="primary" icon={<Flash20Regular />} onClick={doAddAlert} disabled={alertBusy || !alertThreshold.trim()}>
                  {alertBusy ? 'Creating…' : 'Create alert'}
                </Button>
              </DialogActions>
            </DialogBody>
          </DialogSurface>
        </Dialog>

        {saveMsg && !saveErr && !parseErr && <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{saveMsg}</Caption1>}
        {state && !state.ok && <MessageBar intent="error"><MessageBarBody>{state.error}</MessageBarBody></MessageBar>}
        {parseErr && (
          <MessageBar intent="error">
            <MessageBarBody>
              <MessageBarTitle>JSON parse error</MessageBarTitle>
              {parseErr}
            </MessageBarBody>
          </MessageBar>
        )}
        {saveErr && !parseErr && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Save failed</MessageBarTitle>{saveErr}</MessageBarBody></MessageBar>}

        {provisionErr && (
          <MessageBar intent={provisionHint ? 'warning' : 'error'}>
            <MessageBarBody>
              <MessageBarTitle>Provision to Azure failed</MessageBarTitle>
              {provisionErr}
              {provisionHint && <><br /><Caption1>{provisionHint}</Caption1></>}
            </MessageBarBody>
          </MessageBar>
        )}
        {provisionResult && (
          <MessageBar intent={provisionResult.partial ? 'warning' : 'success'}>
            <MessageBarBody>
              <MessageBarTitle>{provisionResult.partial ? 'Provisioned (partial)' : 'Provisioned to Azure'}</MessageBarTitle>
              {provisionResult.ehId && <>Event Hub: <code>{provisionResult.ehId}</code><br /></>}
              {provisionResult.asaJobId
                ? <>Stream Analytics job: <code>{provisionResult.asaJobId}</code><br /></>
                : <Caption1>No Stream Analytics job (no transforms, or transform not available in this cloud).<br /></Caption1>}
              {provisionResult.hint && <Caption1>{provisionResult.hint}</Caption1>}
            </MessageBarBody>
          </MessageBar>
        )}

        <TabList selectedValue={activeTab} onTabSelect={(_: unknown, d: any) => setActiveTab((d.value as 'designer' | 'operators' | 'sql' | 'definition') || 'designer')}>
          <Tab value="designer" icon={<Flowchart20Regular />}>Visual designer</Tab>
          <Tab value="operators" icon={<Filter20Regular />}>Operators</Tab>
          <Tab value="sql" icon={<MathFormula20Regular />}>SQL operator</Tab>
          <Tab value="definition" icon={<DocumentBulletList20Regular />}>Definition</Tab>
        </TabList>

        {activeTab === 'designer' && (
          <EventstreamVisualDesigner config={parsedVisual} onChange={onDesignerChange} itemId={id} />
        )}

        {activeTab === 'operators' && (
          <EventstreamOperatorsTab
            id={id}
            cfg={parsedVisual}
            asaJobName={asaJobName}
            onAsaJobName={setAsaJobName}
            dirty={dirty}
            saving={saving}
            onCommit={commitTopology}
            onSave={save}
          />
        )}

        {activeTab === 'sql' && (
          <EventstreamSqlOperatorTab id={id} asaJobName={asaJobName} onAsaJobName={setAsaJobName} />
        )}

        {activeTab === 'definition' && (
          <EventstreamDefinitionView cfg={parsedVisual} />
        )}
      </div>
    } />
  );
}

// ============================================================
// Eventstream — code-first T-SQL (Stream Analytics SAQL) operator tab.
//
// Parity with Fabric Eventstream's "Edit code" / Stream Analytics query
// surface, Azure-native by default (real ASA job, no Fabric required):
//   • Monaco SQL editor for a multi-INTO SAQL query.
//   • Named sinks manager — one row per `INTO [alias]`, each mapped to a
//     real ASA output (ADX / ADLS Gen2 / Event Hub).
//   • Compile  → real ASA compileQuery (whole query) — always available.
//   • Per-output Test → scopes the query to one sink alias + runs ASA
//     testQuery over sample events, returning that sink's produced rows.
//   • Save → persists to Cosmos + pushes the transformation to the ASA job.
//   • Apply sinks → creates/updates the ASA outputs for every named sink.
//
// All actions hit /api/items/eventstream/[id]/sql-operator (real ARM). When
// ASA isn't provisioned the route returns an honest 501 naming the bicep
// module + env vars; the UI surfaces it in a warning MessageBar.
// ============================================================
interface SqlSinkRow {
  alias: string;
  kind: 'kusto' | 'lakehouse' | 'eventhub' | 'reflex';
  // kusto
  kustoClusterUrl?: string;
  database?: string;
  table?: string;
  // lakehouse
  storageAccount?: string;
  container?: string;
  pathPattern?: string;
  // eventhub / reflex
  namespace?: string;
  eventHubName?: string;
}

const DEFAULT_SQL_QUERY = `-- Code-first T-SQL (Stream Analytics SAQL) operator.
-- Write one SELECT ... INTO [<sink alias>] per named destination.
-- Each [alias] must match a sink in the "Named sinks" list on the right.

SELECT *
INTO [hot-path]
FROM [eventstream-input]
WHERE [eventType] = 'order';

SELECT
  System.Timestamp() AS windowEnd,
  COUNT(*)           AS orders
INTO [aggregates]
FROM [eventstream-input]
GROUP BY TumblingWindow(minute, 5);`;

function aliasesFromQuery(query: string): string[] {
  const out = new Set<string>();
  const re = /\binto\s+\[?([A-Za-z0-9_-]+)\]?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(query)) !== null) out.add(m[1].trim());
  return [...out];
}

function EventstreamSqlOperatorTab({
  id, asaJobName, onAsaJobName,
}: {
  id: string;
  asaJobName: string;
  onAsaJobName: (v: string) => void;
}) {
  const s = useStyles();
  const [query, setQuery] = useState(DEFAULT_SQL_QUERY);
  const [sinks, setSinks] = useState<SqlSinkRow[]>([]);
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(true);

  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [saveHint, setSaveHint] = useState<string | null>(null);

  const [compiling, setCompiling] = useState(false);
  const [compileResult, setCompileResult] = useState<{ valid: boolean; errors: Array<{ message: string; startLine?: number }>; warnings: string[]; outputs: string[] } | null>(null);
  const [compileErr, setCompileErr] = useState<string | null>(null);
  const [compileHint, setCompileHint] = useState<string | null>(null);

  const [applyBusy, setApplyBusy] = useState(false);
  const [applyMsg, setApplyMsg] = useState<string | null>(null);
  const [applyErr, setApplyErr] = useState<string | null>(null);
  const [applyHint, setApplyHint] = useState<string | null>(null);

  // Per-output test state.
  const [testAlias, setTestAlias] = useState('');
  const [sampleText, setSampleText] = useState('[\n  { "eventType": "order", "amount": 42 },\n  { "eventType": "view", "amount": 0 }\n]');
  const [testBusy, setTestBusy] = useState(false);
  const [testResult, setTestResult] = useState<{ outputAlias: string; status: string; rows: any[]; outputUri?: string; errors?: string[] } | null>(null);
  const [testErr, setTestErr] = useState<string | null>(null);
  const [testHint, setTestHint] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id || id === 'new') { setLoading(false); return; }
    setLoading(true);
    try {
      const r = await fetch(`/api/items/eventstream/${id}/sql-operator`);
      const j = await r.json();
      if (j.ok && j.sqlOperator) {
        setQuery(j.sqlOperator.query || DEFAULT_SQL_QUERY);
        setSinks(Array.isArray(j.sqlOperator.sinks) ? j.sqlOperator.sinks.map((x: any) => ({
          alias: x.alias || '',
          kind: (x.kind as SqlSinkRow['kind']) || 'kusto',
          kustoClusterUrl: x.kustoClusterUrl, database: x.database, table: x.table,
          storageAccount: x.storageAccount, container: x.container, pathPattern: x.pathPattern,
          namespace: x.namespace, eventHubName: x.eventHubName,
        })) : []);
        if (j.sqlOperator.asaJobName && !asaJobName) onAsaJobName(j.sqlOperator.asaJobName);
      }
      setDirty(false);
    } catch {
      /* keep defaults; save still works once a record exists */
    } finally {
      setLoading(false);
    }
  }, [id, asaJobName, onAsaJobName]);

  useEffect(() => { load(); }, [load]);

  const referencedAliases = useMemo(() => aliasesFromQuery(query), [query]);
  const declaredAliases = useMemo(() => new Set(sinks.map((x) => x.alias.trim()).filter(Boolean)), [sinks]);
  // Aliases referenced by INTO but with no matching sink row — surfaced so the
  // user knows which sinks still need declaring.
  const missingSinks = referencedAliases.filter((a) => !declaredAliases.has(a));

  const updateSink = useCallback((idx: number, patch: Partial<SqlSinkRow>) => {
    setSinks((prev) => prev.map((x, i) => (i === idx ? { ...x, ...patch } : x)));
    setDirty(true);
  }, []);
  const addSink = useCallback((alias?: string) => {
    setSinks((prev) => [...prev, { alias: alias || `sink-${prev.length + 1}`, kind: 'kusto', database: 'loomdb-default', table: '' }]);
    setDirty(true);
  }, []);
  const removeSink = useCallback((idx: number) => {
    setSinks((prev) => prev.filter((_, i) => i !== idx));
    setDirty(true);
  }, []);

  const doSave = useCallback(async () => {
    setSaving(true); setSaveMsg(null); setSaveErr(null); setSaveHint(null);
    try {
      const r = await fetch(`/api/items/eventstream/${id}/sql-operator`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'save', query, sinks, asaJobName: asaJobName.trim() || undefined }),
      });
      const j = await r.json();
      if (!j.ok) { setSaveErr(j.error || `HTTP ${r.status}`); setSaveHint(j.hint || null); return; }
      setDirty(false);
      setSaveMsg(j.asaPushed
        ? `Saved and pushed the transformation to ASA job "${asaJobName.trim()}".`
        : (j.hint || `Saved at ${new Date().toLocaleTimeString()}.`));
    } catch (e: any) {
      setSaveErr(e?.message || String(e));
    } finally { setSaving(false); }
  }, [id, query, sinks, asaJobName]);

  const doCompile = useCallback(async () => {
    setCompiling(true); setCompileResult(null); setCompileErr(null); setCompileHint(null);
    try {
      const r = await fetch(`/api/items/eventstream/${id}/sql-operator`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'compile', query }),
      });
      const j = await r.json();
      if (!j.ok) { setCompileErr(j.error || `HTTP ${r.status}`); setCompileHint(j.hint || null); return; }
      setCompileResult({ valid: !!j.valid, errors: j.errors || [], warnings: j.warnings || [], outputs: j.outputs || [] });
    } catch (e: any) {
      setCompileErr(e?.message || String(e));
    } finally { setCompiling(false); }
  }, [id, query]);

  const doApplySinks = useCallback(async () => {
    if (!asaJobName.trim()) { setApplyErr('Enter an ASA job name first.'); return; }
    if (!sinks.length) { setApplyErr('Add at least one named sink.'); return; }
    setApplyBusy(true); setApplyMsg(null); setApplyErr(null); setApplyHint(null);
    try {
      const r = await fetch(`/api/items/eventstream/${id}/sql-operator`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'apply-sinks', asaJobName: asaJobName.trim(), sinks }),
      });
      const j = await r.json();
      if (!j.ok) { setApplyErr(j.error || `HTTP ${r.status}`); setApplyHint(j.hint || null); return; }
      const n = (j.outputs || []).length;
      setApplyMsg(`Created/updated ${n} ASA output${n === 1 ? '' : 's'} on job "${j.asaJobName}". Start the job in the Stream Analytics editor to land events.`);
    } catch (e: any) {
      setApplyErr(e?.message || String(e));
    } finally { setApplyBusy(false); }
  }, [id, asaJobName, sinks]);

  const doTest = useCallback(async () => {
    if (!testAlias.trim()) { setTestErr('Choose a sink (INTO alias) to test.'); return; }
    let sampleInput: Array<{ inputAlias: string; events: any[] }>;
    try {
      const events = JSON.parse(sampleText);
      if (!Array.isArray(events)) throw new Error('sample data must be a JSON array of events');
      sampleInput = [{ inputAlias: 'eventstream-input', events }];
    } catch (e: any) {
      setTestErr(`Sample data: ${e?.message || 'invalid JSON'}`); return;
    }
    setTestBusy(true); setTestResult(null); setTestErr(null); setTestHint(null);
    try {
      const r = await fetch(`/api/items/eventstream/${id}/sql-operator`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'test', query, outputAlias: testAlias.trim(), asaJobName: asaJobName.trim() || undefined, sampleInput }),
      });
      const j = await r.json();
      if (!j.ok) { setTestErr(j.error || `HTTP ${r.status}`); setTestHint(j.hint || null); return; }
      setTestResult({ outputAlias: j.outputAlias, status: j.status, rows: j.rows || [], outputUri: j.outputUri, errors: j.errors });
    } catch (e: any) {
      setTestErr(e?.message || String(e));
    } finally { setTestBusy(false); }
  }, [id, query, testAlias, asaJobName, sampleText]);

  const testColumns = useMemo(() => {
    const cols = new Set<string>();
    (testResult?.rows || []).slice(0, 50).forEach((row) => { if (row && typeof row === 'object') Object.keys(row).forEach((k) => cols.add(k)); });
    return [...cols];
  }, [testResult]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM}}>
      <MessageBar intent="info">
        <MessageBarBody>
          <MessageBarTitle>Code-first T-SQL operator</MessageBarTitle>
          Write a multi-output Stream Analytics query. Each <code>SELECT … INTO [alias]</code> targets a
          named sink (ADX / ADLS Gen2 / Event Hub). <strong>Compile</strong> validates the whole query,
          <strong> Test output</strong> runs one sink over sample events, and <strong>Apply sinks</strong>
          {' '}creates the real ASA outputs. Azure-native — no Fabric workspace required.
        </MessageBarBody>
      </MessageBar>

      <div style={{ display: 'flex', gap: tokens.spacingVerticalM, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <Field label="ASA job" style={{ minWidth: 240 }}>
          <Input value={asaJobName} onChange={(_: unknown, d: any) => onAsaJobName(d.value)} placeholder="asa-loom-default-eastus2" />
        </Field>
        <Button appearance="primary" icon={<Save20Regular />} onClick={doSave} disabled={saving || loading}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
        <Button appearance="outline" icon={<Play20Regular />} onClick={doCompile} disabled={compiling || loading}>
          {compiling ? 'Compiling…' : 'Compile'}
        </Button>
        <Button appearance="outline" icon={<ArrowSync20Regular />} onClick={doApplySinks} disabled={applyBusy || loading || !asaJobName.trim() || !sinks.length}
          title={!asaJobName.trim() ? 'Enter an ASA job name first' : 'Create/update one ASA output per named sink (real ARM PUT)'}>
          {applyBusy ? 'Applying…' : 'Apply sinks to ASA'}
        </Button>
        {loading && <Spinner size="tiny" label="Loading saved operator…" labelPosition="after" />}
        {dirty && !loading && <Badge appearance="outline" color="warning">Unsaved changes</Badge>}
      </div>

      {saveErr && (
        <MessageBar intent={saveHint ? 'warning' : 'error'}>
          <MessageBarBody><MessageBarTitle>{saveHint ? 'Stream Analytics not configured' : 'Save failed'}</MessageBarTitle>{saveErr}{saveHint ? <><br /><Caption1>{saveHint}</Caption1></> : null}</MessageBarBody>
        </MessageBar>
      )}
      {saveMsg && !saveErr && <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{saveMsg}</Caption1>}

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.6fr) minmax(0, 1fr)', gap: tokens.spacingVerticalL, alignItems: 'start' }}>
        {/* T-SQL editor */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS}}>
          <Caption1>Stream Analytics query (T-SQL / SAQL). Input alias: <code>[eventstream-input]</code>.</Caption1>
          <MonacoTextarea
            value={query}
            onChange={(v) => { setQuery(v); setDirty(true); }}
            language="sql"
            height={380}
            minHeight={300}
            ariaLabel="Eventstream T-SQL operator query"
          />
          {compileErr && (
            <MessageBar intent={compileHint ? 'warning' : 'error'}>
              <MessageBarBody><MessageBarTitle>{compileHint ? 'Compile unavailable' : 'Compile failed'}</MessageBarTitle>{compileErr}{compileHint ? <><br /><Caption1>{compileHint}</Caption1></> : null}</MessageBarBody>
            </MessageBar>
          )}
          {compileResult && (
            <MessageBar intent={compileResult.valid && compileResult.errors.length === 0 ? 'success' : 'error'}>
              <MessageBarBody>
                <MessageBarTitle>{compileResult.valid && compileResult.errors.length === 0 ? 'Query compiled' : 'Compile errors'}</MessageBarTitle>
                {compileResult.errors.length === 0
                  ? <>Outputs: {compileResult.outputs.length ? compileResult.outputs.map((o) => <code key={o} style={{ marginRight: tokens.spacingHorizontalS}}>{o}</code>) : '(none)'}</>
                  : <ul style={{ margin: `${tokens.spacingVerticalXS} 0 0`, paddingLeft: 18 }}>{compileResult.errors.map((e, i) => <li key={i}>{e.startLine ? `Line ${e.startLine}: ` : ''}{e.message}</li>)}</ul>}
                {compileResult.warnings.length > 0 && (
                  <ul style={{ margin: `${tokens.spacingVerticalXS} 0 0`, paddingLeft: 18, color: tokens.colorPaletteYellowForeground2 }}>
                    {compileResult.warnings.map((w, i) => <li key={i}>{w}</li>)}
                  </ul>
                )}
              </MessageBarBody>
            </MessageBar>
          )}
        </div>

        {/* Named sinks manager */}
        <div className={s.card} style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM}}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: tokens.spacingVerticalS}}>
            <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingVerticalS, minWidth: 0 }}>
              <Subtitle2>Named sinks</Subtitle2>
              {sinks.length > 0 && <Badge appearance="tint" color="informative">{sinks.length}</Badge>}
            </div>
            <Button appearance="outline" size="small" icon={<Add20Regular />} onClick={() => addSink()}>Add sink</Button>
          </div>
          {applyErr && (
            <MessageBar intent={applyHint ? 'warning' : 'error'}>
              <MessageBarBody><MessageBarTitle>{applyHint ? 'Stream Analytics not configured' : 'Apply failed'}</MessageBarTitle>{applyErr}{applyHint ? <><br /><Caption1>{applyHint}</Caption1></> : null}</MessageBarBody>
            </MessageBar>
          )}
          {applyMsg && !applyErr && <MessageBar intent="success"><MessageBarBody>{applyMsg}</MessageBarBody></MessageBar>}
          {missingSinks.length > 0 && (
            <MessageBar intent="warning">
              <MessageBarBody>
                <MessageBarTitle>Undeclared sinks</MessageBarTitle>
                These <code>INTO</code> targets have no sink row yet:{' '}
                {missingSinks.map((a) => (
                  <Button key={a} appearance="transparent" size="small" onClick={() => addSink(a)}>＋ {a}</Button>
                ))}
              </MessageBarBody>
            </MessageBar>
          )}
          {sinks.length === 0 && <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>No sinks yet. Add one per <code>INTO [alias]</code> in your query.</Caption1>}
          {sinks.map((sink, idx) => (
            <div key={idx} style={{ border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge, padding: tokens.spacingVerticalM, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS }}>
              <div style={{ display: 'flex', gap: tokens.spacingVerticalS, alignItems: 'flex-end' }}>
                <Field label="INTO alias" style={{ flex: 1 }}>
                  <Input value={sink.alias} onChange={(_: unknown, d: any) => updateSink(idx, { alias: d.value })} placeholder="hot-path" />
                </Field>
                <Field label="Kind" style={{ minWidth: 150 }}>
                  <Select value={sink.kind} onChange={(_: unknown, d: any) => updateSink(idx, { kind: d.value as SqlSinkRow['kind'] })}>
                    <option value="kusto">KQL Database (ADX)</option>
                    <option value="lakehouse">Lakehouse (ADLS Gen2)</option>
                    <option value="eventhub">Event Hub</option>
                    <option value="reflex">Activator</option>
                  </Select>
                </Field>
                <Button appearance="subtle" icon={<Delete20Regular />} onClick={() => removeSink(idx)} aria-label={`Remove sink ${sink.alias}`} />
              </div>
              {sink.kind === 'kusto' && (
                <div style={{ display: 'flex', gap: tokens.spacingVerticalS}}>
                  <Field label="Database" style={{ flex: 1 }}>
                    <Input value={sink.database || ''} onChange={(_: unknown, d: any) => updateSink(idx, { database: d.value })} placeholder="loomdb-default" />
                  </Field>
                  <Field label="Table" style={{ flex: 1 }}>
                    <Input value={sink.table || ''} onChange={(_: unknown, d: any) => updateSink(idx, { table: d.value })} placeholder="Orders" />
                  </Field>
                </div>
              )}
              {sink.kind === 'lakehouse' && (
                <div style={{ display: 'flex', gap: tokens.spacingVerticalS, flexWrap: 'wrap' }}>
                  <Field label="Storage account" style={{ flex: 1, minWidth: 120 }}>
                    <Input value={sink.storageAccount || ''} onChange={(_: unknown, d: any) => updateSink(idx, { storageAccount: d.value })} placeholder="(or LOOM_ADLS_ACCOUNT)" />
                  </Field>
                  <Field label="Container" style={{ flex: 1, minWidth: 120 }}>
                    <Input value={sink.container || ''} onChange={(_: unknown, d: any) => updateSink(idx, { container: d.value })} placeholder="bronze" />
                  </Field>
                  <Field label="Path pattern" style={{ flex: 1, minWidth: 120 }}>
                    <Input value={sink.pathPattern || ''} onChange={(_: unknown, d: any) => updateSink(idx, { pathPattern: d.value })} placeholder="events/{date}/{time}" />
                  </Field>
                </div>
              )}
              {(sink.kind === 'eventhub' || sink.kind === 'reflex') && (
                <div style={{ display: 'flex', gap: tokens.spacingVerticalS}}>
                  <Field label="Namespace" style={{ flex: 1 }}>
                    <Input value={sink.namespace || ''} onChange={(_: unknown, d: any) => updateSink(idx, { namespace: d.value })} placeholder="(or LOOM_EVENTHUB_NAMESPACE)" />
                  </Field>
                  <Field label="Event hub" style={{ flex: 1 }}>
                    <Input value={sink.eventHubName || ''} onChange={(_: unknown, d: any) => updateSink(idx, { eventHubName: d.value })} placeholder="processed-events" />
                  </Field>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Per-output test */}
      <div className={s.card} style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM}}>
        <Subtitle2>Test a single output</Subtitle2>
        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
          Runs only the statements writing to the selected <code>INTO</code> alias against the sample events and returns that sink&apos;s rows (real ASA Test Query).
        </Caption1>
        <div style={{ display: 'flex', gap: tokens.spacingVerticalM, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <Field label="Output (INTO alias)" style={{ minWidth: 220 }}>
            <Select value={testAlias} onChange={(_: unknown, d: any) => setTestAlias(d.value)}>
              <option value="">Select an output…</option>
              {referencedAliases.map((a) => <option key={a} value={a}>{a}</option>)}
            </Select>
          </Field>
          <Button appearance="primary" icon={<Play20Regular />} onClick={doTest} disabled={testBusy || !testAlias.trim()}>
            {testBusy ? 'Testing…' : 'Test output'}
          </Button>
        </div>
        <Field label="Sample input events (JSON array)">
          <MonacoTextarea
            value={sampleText}
            onChange={(v) => setSampleText(v)}
            language="json"
            height={140}
            minHeight={120}
            ariaLabel="Sample input events"
          />
        </Field>
        {testErr && (
          <MessageBar intent={testHint ? 'warning' : 'error'}>
            <MessageBarBody><MessageBarTitle>{testHint ? 'Test Query not available' : 'Test failed'}</MessageBarTitle>{testErr}{testHint ? <><br /><Caption1>{testHint}</Caption1></> : null}</MessageBarBody>
          </MessageBar>
        )}
        {testResult && (
          <div className={s.resultBox}>
            <Caption1>
              Output <code>{testResult.outputAlias}</code> — status <Badge appearance="outline">{testResult.status}</Badge>
              {' '}· {testResult.rows.length} row{testResult.rows.length === 1 ? '' : 's'}
            </Caption1>
            {testResult.errors && testResult.errors.length > 0 && (
              <MessageBar intent="error" style={{ marginTop: tokens.spacingVerticalS}}><MessageBarBody>{testResult.errors.join('; ')}</MessageBarBody></MessageBar>
            )}
            {testResult.rows.length > 0 ? (
              <>
                <div className={s.tableWrap} style={{ marginTop: tokens.spacingVerticalS}}>
                  <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: tokens.fontSizeBase200}}>
                    <thead>
                      <tr>{testColumns.map((c) => <th key={c} style={{ textAlign: 'left', padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalS}`, borderBottom: `1px solid ${tokens.colorNeutralStroke2}`, position: 'sticky', top: 0, background: tokens.colorNeutralBackground2, fontWeight: 600, whiteSpace: 'nowrap' }}>{c}</th>)}</tr>
                    </thead>
                    <tbody>
                      {testResult.rows.slice(0, 100).map((row, ri) => (
                        <tr key={ri} style={{ background: ri % 2 ? tokens.colorNeutralBackground1 : tokens.colorNeutralBackground2 }}>
                          {testColumns.map((c) => <td key={c} className={s.cell} style={{ padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`, borderBottom: `1px solid ${tokens.colorNeutralStroke3}` }}>{typeof row?.[c] === 'object' ? JSON.stringify(row[c]) : String(row?.[c] ?? '')}</td>)}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {testResult.rows.length > 100 && (
                  <Caption1 style={{ color: tokens.colorNeutralForeground3, marginTop: tokens.spacingVerticalS}}>
                    Showing first 100 of {testResult.rows.length} rows.
                  </Caption1>
                )}
              </>
            ) : (
              <Caption1 style={{ color: tokens.colorNeutralForeground3, marginTop: tokens.spacingVerticalS}}>
                No rows produced{testResult.outputUri ? ' (output written to the test storage location).' : '.'}
              </Caption1>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================
// Eventstream — guided Operators builder (Fabric Eventstream's 7 stream
// operators) + derived-stream and Spark-notebook destinations.
//
// Every operator is configured through typed controls (dropdowns, field rows,
// number inputs) — NO JSON authoring (clears loom_no_freeform_config). The
// only freeform slots are the single-expression WHERE / HAVING / JOIN-ON boxes,
// the explicitly-allowed 1:1 builder exception. The whole chain compiles to
// SAQL (esCompileDefinition) shown read-only, and the real Azure backend is hit
// two ways: Validate → ASA compileQuery (subscription-scoped RP action) and
// Apply to ASA → saveTransformation (PUT on the live streaming job). Honest
// Fluent gates surface when Stream Analytics / Spark bindings aren't provisioned.
// ============================================================
function EventstreamOperatorsTab({
  id, cfg, asaJobName, onAsaJobName, dirty, saving, onCommit, onSave,
}: {
  id: string;
  cfg: VisualPipelineConfig;
  asaJobName: string;
  onAsaJobName: (v: string) => void;
  dirty: boolean;
  saving: boolean;
  onCommit: (patch: { sources?: any[]; transforms?: any[]; sinks?: any[] }) => void;
  onSave: () => void;
}) {
  const s = useStyles();
  const { sources, transforms, sinks } = useMemo(() => esTopology(cfg), [cfg]);

  const compiledSaql = useMemo(() => esCompileDefinition(sources, transforms, sinks), [sources, transforms, sinks]);

  const [validating, setValidating] = useState(false);
  const [validateResult, setValidateResult] = useState<{ valid: boolean; errors: Array<{ message: string; startLine?: number }>; warnings: string[]; outputs: string[] } | null>(null);
  const [validateErr, setValidateErr] = useState<string | null>(null);
  const [validateHint, setValidateHint] = useState<string | null>(null);

  const [applyBusy, setApplyBusy] = useState(false);
  const [applyMsg, setApplyMsg] = useState<string | null>(null);
  const [applyErr, setApplyErr] = useState<string | null>(null);
  const [applyHint, setApplyHint] = useState<string | null>(null);

  // ---- operator mutations (operators live in transforms[]) ----
  const updateOp = useCallback((idx: number, patch: Record<string, any>) => {
    onCommit({ transforms: transforms.map((t, i) => (i === idx ? { ...t, ...patch } : t)) });
  }, [transforms, onCommit]);
  const addOp = useCallback((kind: EsOpKind) => {
    onCommit({ transforms: [...transforms, esDefaultOperator(kind, transforms.length + 1)] });
  }, [transforms, onCommit]);
  const removeOp = useCallback((idx: number) => {
    onCommit({ transforms: transforms.filter((_, i) => i !== idx) });
  }, [transforms, onCommit]);
  const moveOp = useCallback((idx: number, dir: -1 | 1) => {
    const j = idx + dir;
    if (j < 0 || j >= transforms.length) return;
    const next = [...transforms];
    [next[idx], next[j]] = [next[j], next[idx]];
    onCommit({ transforms: next });
  }, [transforms, onCommit]);

  // ---- destination mutations (derived streams + spark-notebook live in sinks[]) ----
  const updateSink = useCallback((idx: number, patch: Record<string, any>) => {
    onCommit({ sinks: sinks.map((sk, i) => (i === idx ? { ...sk, ...patch } : sk)) });
  }, [sinks, onCommit]);
  const removeSink = useCallback((idx: number) => {
    onCommit({ sinks: sinks.filter((_, i) => i !== idx) });
  }, [sinks, onCommit]);
  const addDerived = useCallback(() => {
    onCommit({ sinks: [...sinks, { kind: 'derivedStream', name: `derived-${sinks.length + 1}`, paused: false }] });
  }, [sinks, onCommit]);
  const addSparkSink = useCallback(() => {
    onCommit({ sinks: [...sinks, { kind: 'spark-notebook', name: `notebook-sink-${sinks.length + 1}`, notebook: '', sparkPool: '', binding: 'transport' }] });
  }, [sinks, onCommit]);

  const derivedStreams = sinks.map((sk, i) => ({ sk, i })).filter((x) => x.sk?.kind === 'derivedStream');
  const sparkSinks = sinks.map((sk, i) => ({ sk, i })).filter((x) => x.sk?.kind === 'spark-notebook');

  const doValidate = useCallback(async () => {
    setValidating(true); setValidateResult(null); setValidateErr(null); setValidateHint(null);
    try {
      const r = await fetch(`/api/items/eventstream/${id}/sql-operator`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'compile', query: compiledSaql }),
      });
      const j = await r.json();
      if (!j.ok) { setValidateErr(j.error || `HTTP ${r.status}`); setValidateHint(j.hint || null); return; }
      setValidateResult({ valid: !!j.valid, errors: j.errors || [], warnings: j.warnings || [], outputs: j.outputs || [] });
    } catch (e: any) {
      setValidateErr(e?.message || String(e));
    } finally { setValidating(false); }
  }, [id, compiledSaql]);

  const doApplyToAsa = useCallback(async () => {
    if (!asaJobName.trim()) { setApplyErr('Enter an ASA job name first.'); setApplyHint(null); return; }
    setApplyBusy(true); setApplyMsg(null); setApplyErr(null); setApplyHint(null);
    try {
      const r = await fetch(`/api/items/eventstream/${id}/sql-operator`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'save', query: compiledSaql, asaJobName: asaJobName.trim() }),
      });
      const j = await r.json();
      if (!j.ok) { setApplyErr(j.error || `HTTP ${r.status}`); setApplyHint(j.hint || null); return; }
      setApplyMsg(j.asaPushed
        ? `Pushed the operator chain to ASA job "${asaJobName.trim()}" (live transformation updated). Start the job in the Stream Analytics editor to land events.`
        : (j.hint || 'Saved the operator chain.'));
    } catch (e: any) {
      setApplyErr(e?.message || String(e));
    } finally { setApplyBusy(false); }
  }, [id, compiledSaql, asaJobName]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM }}>
      <MessageBar intent="info">
        <MessageBarBody>
          <MessageBarTitle>Guided operator builder — Filter · Manage fields · Aggregate · Group by · Expand · Union · Join</MessageBarTitle>
          Build the stream transformation with typed controls (no query typing). The chain compiles to a
          Stream Analytics query shown below — <strong>Validate</strong> runs the real ASA compiler and
          <strong> Apply to ASA</strong> pushes it to the live streaming job. Azure-native — no Fabric required.
        </MessageBarBody>
      </MessageBar>

      {/* ── Add operator palette ─────────────────────────────────────────── */}
      <div className={s.card} style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS }}>
          <Subtitle2>Operators</Subtitle2>
          {transforms.length > 0 && <Badge appearance="tint" color="informative">{transforms.length}</Badge>}
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalS }}>
          {ES_OPERATOR_KINDS.map((op) => (
            <Tooltip key={op.value} content={op.hint} relationship="description">
              <Button appearance="outline" size="small" icon={op.icon as any} onClick={() => addOp(op.value)}>{op.label}</Button>
            </Tooltip>
          ))}
        </div>
        {transforms.length === 0 && (
          <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
            No operators yet. Add one above — the stream passes through unchanged until you do.
          </Caption1>
        )}
      </div>

      {/* ── Operator chain ───────────────────────────────────────────────── */}
      {transforms.map((op, idx) => (
        <EsOperatorCard
          key={idx}
          idx={idx}
          total={transforms.length}
          op={op}
          sources={sources}
          onChange={(patch) => updateOp(idx, patch)}
          onRemove={() => removeOp(idx)}
          onMove={(dir) => moveOp(idx, dir)}
        />
      ))}

      {/* ── Compiled SAQL preview (read-only) ────────────────────────────── */}
      <div className={s.card} style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' }}>
          <Subtitle2>Compiled Stream Analytics query</Subtitle2>
          <Badge appearance="outline" color="brand">read-only · generated</Badge>
          <Field label="ASA job" style={{ minWidth: 220, marginLeft: 'auto' }}>
            <Input value={asaJobName} onChange={(_: unknown, d: any) => onAsaJobName(d.value)} placeholder="asa-loom-default-eastus2" />
          </Field>
        </div>
        <MonacoTextarea value={compiledSaql} onChange={() => { /* read-only */ }} language="sql" height={220} minHeight={160} readOnly ariaLabel="Compiled Stream Analytics query (read-only)" />
        <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' }}>
          <Button appearance="outline" icon={<Play20Regular />} onClick={doValidate} disabled={validating}>
            {validating ? 'Validating…' : 'Validate (ASA compile)'}
          </Button>
          <Button appearance="outline" icon={<ArrowSync20Regular />} onClick={doApplyToAsa} disabled={applyBusy || !asaJobName.trim()}
            title={asaJobName.trim() ? 'Push the compiled query to the live ASA job transformation (real PUT)' : 'Enter an ASA job name first'}>
            {applyBusy ? 'Applying…' : 'Apply to ASA job'}
          </Button>
          <Button appearance="primary" icon={<Save20Regular />} onClick={onSave} disabled={saving || !dirty}>
            {saving ? 'Saving…' : 'Save topology'}
          </Button>
        </div>
        {validateErr && (
          <MessageBar intent={validateHint ? 'warning' : 'error'}>
            <MessageBarBody><MessageBarTitle>{validateHint ? 'Stream Analytics not configured' : 'Validation failed'}</MessageBarTitle>{validateErr}{validateHint ? <><br /><Caption1>{validateHint}</Caption1></> : null}</MessageBarBody>
          </MessageBar>
        )}
        {validateResult && (
          <MessageBar intent={validateResult.valid && validateResult.errors.length === 0 ? 'success' : 'error'}>
            <MessageBarBody>
              <MessageBarTitle>{validateResult.valid && validateResult.errors.length === 0 ? 'Query compiled' : 'Compile errors'}</MessageBarTitle>
              {validateResult.errors.length === 0
                ? <>Outputs: {validateResult.outputs.length ? validateResult.outputs.map((o) => <code key={o} style={{ marginRight: tokens.spacingHorizontalS }}>{o}</code>) : '(none)'}</>
                : <ul style={{ margin: `${tokens.spacingVerticalXS} 0 0`, paddingLeft: 18 }}>{validateResult.errors.map((e, i) => <li key={i}>{e.startLine ? `Line ${e.startLine}: ` : ''}{e.message}</li>)}</ul>}
              {validateResult.warnings.length > 0 && (
                <ul style={{ margin: `${tokens.spacingVerticalXS} 0 0`, paddingLeft: 18, color: tokens.colorPaletteYellowForeground2 }}>
                  {validateResult.warnings.map((w, i) => <li key={i}>{w}</li>)}
                </ul>
              )}
            </MessageBarBody>
          </MessageBar>
        )}
        {applyErr && (
          <MessageBar intent={applyHint ? 'warning' : 'error'}>
            <MessageBarBody><MessageBarTitle>{applyHint ? 'Stream Analytics not configured' : 'Apply failed'}</MessageBarTitle>{applyErr}{applyHint ? <><br /><Caption1>{applyHint}</Caption1></> : null}</MessageBarBody>
          </MessageBar>
        )}
        {applyMsg && !applyErr && <MessageBar intent="success"><MessageBarBody>{applyMsg}</MessageBarBody></MessageBar>}
      </div>

      {/* ── Derived streams (pause / resume) ─────────────────────────────── */}
      <div className={s.card} style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS }}>
          <Branch20Regular style={{ color: tokens.colorBrandForeground1 }} />
          <Subtitle2>Derived streams</Subtitle2>
          {derivedStreams.length > 0 && <Badge appearance="tint" color="informative">{derivedStreams.length}</Badge>}
          <Button appearance="outline" size="small" icon={<Add20Regular />} onClick={addDerived} style={{ marginLeft: 'auto' }}>Add derived stream</Button>
        </div>
        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
          A derived stream fans this stream out to a downstream Eventstream. <strong>Pause</strong> excludes it
          from the running topology; the paused state is persisted and honored when you Provision to Azure /
          Push to ASA. Save to persist changes.
        </Caption1>
        {derivedStreams.length === 0 && (
          <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>No derived streams. Add one to branch this stream to another consumer.</Caption1>
        )}
        {derivedStreams.map(({ sk, i }) => {
          const paused = !!sk.paused;
          return (
            <div key={i} style={{ display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'flex-end', border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge, padding: tokens.spacingVerticalM }}>
              <Field label="Name" style={{ flex: 1 }}>
                <Input value={sk.name || ''} onChange={(_: unknown, d: any) => updateSink(i, { name: d.value })} placeholder="derived-1" />
              </Field>
              <Badge appearance="filled" color={paused ? 'warning' : 'success'} style={{ alignSelf: 'center' }}>{paused ? 'Paused' : 'Running'}</Badge>
              <Button appearance={paused ? 'primary' : 'outline'} icon={paused ? <Play20Regular /> : <Pause20Regular />}
                onClick={() => updateSink(i, { paused: !paused })}>
                {paused ? 'Resume' : 'Pause'}
              </Button>
              <Button appearance="subtle" icon={<Delete20Regular />} aria-label={`Remove derived stream ${sk.name || i}`} onClick={() => removeSink(i)} />
            </div>
          );
        })}
      </div>

      {/* ── Spark notebook sink (honest-gated) ───────────────────────────── */}
      <div className={s.card} style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS }}>
          <Notebook20Regular style={{ color: tokens.colorBrandForeground1 }} />
          <Subtitle2>Spark notebook sink</Subtitle2>
          {sparkSinks.length > 0 && <Badge appearance="tint" color="informative">{sparkSinks.length}</Badge>}
          <Button appearance="outline" size="small" icon={<Add20Regular />} onClick={addSparkSink} style={{ marginLeft: 'auto' }}>Add Spark notebook sink</Button>
        </div>
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Requires a Spark structured-streaming binding</MessageBarTitle>
            Routing the stream to a notebook runs an Azure-native Spark structured-streaming job that reads the
            stream&apos;s Event Hub / ADLS landing. Set <code>LOOM_SYNAPSE_WORKSPACE</code> (or
            <code> LOOM_DATABRICKS_WORKSPACE_URL</code>) and pick a Spark pool below. Until the binding is
            provisioned the mapping is saved as configuration only — no events are processed yet.
          </MessageBarBody>
        </MessageBar>
        {sparkSinks.length === 0 && (
          <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>No Spark notebook sinks. Add one to hand the stream to a PySpark notebook.</Caption1>
        )}
        {sparkSinks.map(({ sk, i }) => (
          <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge, padding: tokens.spacingVerticalM }}>
            <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <Field label="Name" style={{ flex: 1, minWidth: 140 }}>
                <Input value={sk.name || ''} onChange={(_: unknown, d: any) => updateSink(i, { name: d.value })} placeholder="notebook-sink-1" />
              </Field>
              <Field label="Notebook" style={{ flex: 1, minWidth: 140 }}>
                <Input value={sk.notebook || ''} onChange={(_: unknown, d: any) => updateSink(i, { notebook: d.value })} placeholder="stream-processor" />
              </Field>
              <Button appearance="subtle" icon={<Delete20Regular />} aria-label={`Remove Spark notebook sink ${sk.name || i}`} onClick={() => removeSink(i)} />
            </div>
            <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <Field label="Spark pool" style={{ flex: 1, minWidth: 140 }}>
                <Input value={sk.sparkPool || ''} onChange={(_: unknown, d: any) => updateSink(i, { sparkPool: d.value })} placeholder="(or LOOM_SYNAPSE_SPARK_POOL)" />
              </Field>
              <Field label="Reads from" style={{ minWidth: 200 }}>
                <Select value={sk.binding || 'transport'} onChange={(_: unknown, d: any) => updateSink(i, { binding: d.value })}>
                  <option value="transport">Transport Event Hub (this stream)</option>
                  <option value="adls">ADLS Gen2 landing (Lakehouse sink)</option>
                </Select>
              </Field>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---- one operator card (typed config per Fabric Eventstream operator) ----
function EsOperatorCard({
  idx, total, op, sources, onChange, onRemove, onMove,
}: {
  idx: number;
  total: number;
  op: any;
  sources: any[];
  onChange: (patch: Record<string, any>) => void;
  onRemove: () => void;
  onMove: (dir: -1 | 1) => void;
}) {
  const s = useStyles();
  const kind = op.kind as EsOpKind;
  const meta = ES_OPERATOR_KINDS.find((k) => k.value === kind);
  const isAgg = kind === 'aggregate' || kind === 'group-by';

  const setFieldMap = (rows: EsFieldMap[]) => onChange({ fieldMap: rows });
  const fieldMap: EsFieldMap[] = Array.isArray(op.fieldMap) ? op.fieldMap : [];

  const setAggs = (rows: any[]) => onChange({ aggregates: rows });
  const aggregates: any[] = Array.isArray(op.aggregates) ? op.aggregates : [];

  const csv = (a?: string[]) => (a || []).join(', ');
  const toArr = (v: string) => v.split(',').map((x) => x.trim()).filter(Boolean);

  return (
    <div className={s.card} style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' }}>
        <Badge appearance="filled" color="brand">{idx + 1}</Badge>
        {meta?.icon}
        <Field label="Operation" style={{ minWidth: 180 }}>
          <Select value={kind} onChange={(_: unknown, d: any) => onChange({ kind: d.value })} aria-label={`Operator ${idx + 1} operation`}>
            {ES_OPERATOR_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
          </Select>
        </Field>
        <Field label="Name" style={{ flex: 1, minWidth: 140 }}>
          <Input value={op.name || ''} onChange={(_: unknown, d: any) => onChange({ name: d.value })} placeholder={`${kind}-${idx + 1}`} />
        </Field>
        <Tooltip content="Move up" relationship="label">
          <Button appearance="subtle" icon={<ArrowUp20Regular />} disabled={idx === 0} onClick={() => onMove(-1)} aria-label="Move operator up" />
        </Tooltip>
        <Tooltip content="Move down" relationship="label">
          <Button appearance="subtle" icon={<ArrowDown20Regular />} disabled={idx === total - 1} onClick={() => onMove(1)} aria-label="Move operator down" />
        </Tooltip>
        <Button appearance="subtle" icon={<Delete20Regular />} onClick={onRemove} aria-label={`Remove operator ${idx + 1}`} />
      </div>
      {meta?.hint && <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{meta.hint}</Caption1>}

      {/* FILTER */}
      {kind === 'filter' && (
        <Field label="WHERE condition" hint="e.g. temperature > 30 AND deviceId = 'sensor-A'">
          <MonacoTextarea value={op.expression || ''} onChange={(v) => onChange({ expression: v })} language="sql" height={64} lineNumbers={false} ariaLabel="WHERE condition" />
        </Field>
      )}

      {/* MANAGE FIELDS */}
      {kind === 'manage-fields' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS }}>
          <Caption1>Choose which columns to keep, rename them, or change their type. Leave the list empty to pass every field through.</Caption1>
          {fieldMap.map((m, i) => (
            <div key={i} style={{ display: 'flex', gap: tokens.spacingHorizontalXS, alignItems: 'flex-end' }}>
              <Field label={i === 0 ? 'Source column' : undefined} style={{ flex: 1 }}>
                <Input value={m.source} onChange={(_: unknown, d: any) => setFieldMap(fieldMap.map((r, j) => j === i ? { ...r, source: d.value } : r))} placeholder="deviceId" aria-label={`Field ${i + 1} source`} />
              </Field>
              <Field label={i === 0 ? 'Rename to' : undefined} style={{ flex: 1 }}>
                <Input value={m.target || ''} onChange={(_: unknown, d: any) => setFieldMap(fieldMap.map((r, j) => j === i ? { ...r, target: d.value } : r))} placeholder="(keep name)" aria-label={`Field ${i + 1} rename`} />
              </Field>
              <Field label={i === 0 ? 'Cast type' : undefined} style={{ minWidth: 130 }}>
                <Select value={m.cast || ''} onChange={(_: unknown, d: any) => setFieldMap(fieldMap.map((r, j) => j === i ? { ...r, cast: d.value } : r))} aria-label={`Field ${i + 1} cast`}>
                  {ES_CAST_TYPES.map((c) => <option key={c || 'none'} value={c}>{c || '(no cast)'}</option>)}
                </Select>
              </Field>
              <Button appearance="subtle" icon={<Delete20Regular />} onClick={() => setFieldMap(fieldMap.filter((_, j) => j !== i))} aria-label={`Remove field ${i + 1}`} />
            </div>
          ))}
          <Button appearance="secondary" size="small" icon={<Add20Regular />} onClick={() => setFieldMap([...fieldMap, { source: '', target: '', cast: '' }])}>Add field</Button>
        </div>
      )}

      {/* AGGREGATE / GROUP BY */}
      {isAgg && (
        <>
          <Field label="Group by columns" hint="Comma-separated (optional)">
            <Input value={csv(op.groupBy)} onChange={(_: unknown, d: any) => onChange({ groupBy: toArr(d.value) })} placeholder="deviceId, region" />
          </Field>
          <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS }}>
            <Caption1>Aggregations</Caption1>
            {aggregates.map((a, i) => (
              <div key={i} style={{ display: 'flex', gap: tokens.spacingHorizontalXS, alignItems: 'flex-end' }}>
                <Field style={{ minWidth: 100 }}>
                  <Select value={a.func || 'COUNT'} onChange={(_: unknown, d: any) => setAggs(aggregates.map((r, j) => j === i ? { ...r, func: d.value } : r))} aria-label={`Aggregation ${i + 1} function`}>
                    {ES_AGG_FUNCS.map((f) => <option key={f} value={f}>{f}</option>)}
                  </Select>
                </Field>
                <Field style={{ flex: 1 }}>
                  <Input value={a.field || ''} onChange={(_: unknown, d: any) => setAggs(aggregates.map((r, j) => j === i ? { ...r, field: d.value } : r))} placeholder={a.func === 'COUNT' ? '* (or field)' : 'field'} aria-label={`Aggregation ${i + 1} field`} />
                </Field>
                <Field style={{ flex: 1 }}>
                  <Input value={a.alias || ''} onChange={(_: unknown, d: any) => setAggs(aggregates.map((r, j) => j === i ? { ...r, alias: d.value } : r))} placeholder="alias" aria-label={`Aggregation ${i + 1} alias`} />
                </Field>
                <Button appearance="subtle" icon={<Delete20Regular />} onClick={() => setAggs(aggregates.filter((_, j) => j !== i))} aria-label={`Remove aggregation ${i + 1}`} />
              </div>
            ))}
            <Button appearance="secondary" size="small" icon={<Add20Regular />} onClick={() => setAggs([...aggregates, { func: 'AVG', field: '', alias: '' }])}>Add aggregation</Button>
          </div>
          <Field label="Timestamp column (TIMESTAMP BY)" hint="Event-time column used for windowing (optional)">
            <Input value={op.timestampBy || ''} onChange={(_: unknown, d: any) => onChange({ timestampBy: d.value })} placeholder="EventEnqueuedUtcTime" />
          </Field>
          <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' }}>
            <Field label="Window" style={{ minWidth: 130 }}>
              <Select value={op.windowType || 'Tumbling'} onChange={(_: unknown, d: any) => onChange({ windowType: d.value })}>
                {ES_WINDOW_TYPES.map((w) => <option key={w} value={w}>{w}</option>)}
              </Select>
            </Field>
            {op.windowType !== 'Snapshot' && (
              <>
                <Field label="Size" style={{ minWidth: 90 }}>
                  <Input type="number" value={String(op.windowSize ?? 5)} onChange={(_: unknown, d: any) => onChange({ windowSize: Number(d.value) || 0 })} />
                </Field>
                <Field label="Unit" style={{ minWidth: 110 }}>
                  <Select value={op.windowUnit || 'minute'} onChange={(_: unknown, d: any) => onChange({ windowUnit: d.value })}>
                    {ES_WINDOW_UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
                  </Select>
                </Field>
                {(op.windowType === 'Hopping' || op.windowType === 'Session') && (
                  <Field label={op.windowType === 'Hopping' ? 'Hop' : 'Max duration'} style={{ minWidth: 90 }}>
                    <Input type="number" value={String(op.hopSize ?? op.windowSize ?? 1)} onChange={(_: unknown, d: any) => onChange({ hopSize: Number(d.value) || 0 })} />
                  </Field>
                )}
              </>
            )}
          </div>
          <Field label="HAVING (optional)" hint="Filter on aggregates, e.g. COUNT(*) > 100">
            <MonacoTextarea value={op.havingExpression || ''} onChange={(v) => onChange({ havingExpression: v })} language="sql" height={52} lineNumbers={false} ariaLabel="HAVING expression" />
          </Field>
        </>
      )}

      {/* EXPAND */}
      {kind === 'expand' && (
        <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' }}>
          <Field label="Array column to flatten" style={{ flex: 1, minWidth: 160 }} hint="Emits one row per element (CROSS APPLY GetArrayElements)">
            <Input value={op.expandField || ''} onChange={(_: unknown, d: any) => onChange({ expandField: d.value })} placeholder="tags" />
          </Field>
          <Field label="Element alias" style={{ minWidth: 130 }}>
            <Input value={op.expandAlias || 'element'} onChange={(_: unknown, d: any) => onChange({ expandAlias: d.value })} placeholder="element" />
          </Field>
          <Field label="Output column" style={{ minWidth: 140 }} hint="Name for the flattened value">
            <Input value={op.expandOutput || ''} onChange={(_: unknown, d: any) => onChange({ expandOutput: d.value })} placeholder="tag" />
          </Field>
        </div>
      )}

      {/* UNION */}
      {kind === 'union' && (
        <MessageBar intent={sources.length > 1 ? 'success' : 'warning'}>
          <MessageBarBody>
            {sources.length > 1
              ? <>Merges all {sources.length} sources ({sources.map((sn) => sn.name).join(', ')}) into one stream. No extra configuration required.</>
              : <>Union merges multiple sources — add a second source on the Visual designer for this to have an effect.</>}
          </MessageBarBody>
        </MessageBar>
      )}

      {/* JOIN */}
      {kind === 'join' && (
        <>
          <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' }}>
            <Field label="Join with source" style={{ flex: 1, minWidth: 160 }}>
              <Select value={op.joinSource || ''} onChange={(_: unknown, d: any) => onChange({ joinSource: d.value })}>
                <option value="">{sources.length > 1 ? 'Select a source…' : 'Add a second source first'}</option>
                {sources.map((sn) => <option key={sn.name} value={sn.name}>{sn.name}</option>)}
              </Select>
            </Field>
            <Field label="Join type" style={{ minWidth: 140 }}>
              <Select value={op.joinType || 'INNER'} onChange={(_: unknown, d: any) => onChange({ joinType: d.value })}>
                <option value="INNER">INNER</option>
                <option value="LEFT OUTER">LEFT OUTER</option>
              </Select>
            </Field>
            <Field label="Within (seconds)" style={{ minWidth: 130 }} hint="DATEDIFF temporal bound">
              <Input type="number" value={String(op.joinDurationSeconds ?? 60)} onChange={(_: unknown, d: any) => onChange({ joinDurationSeconds: Number(d.value) || 0 })} />
            </Field>
          </div>
          <Field label="ON condition" hint="e.g. L.deviceId = R.deviceId (L = this stream, R = joined source)">
            <MonacoTextarea value={op.joinOn || ''} onChange={(v) => onChange({ joinOn: v })} language="sql" height={52} lineNumbers={false} ariaLabel="JOIN ON condition" />
          </Field>
        </>
      )}
    </div>
  );
}

// ============================================================
// Eventstream — read-only Definition view.
//
// Replaces the former editable JSON tab (a loom_no_freeform_config BLOCKING
// violation: a raw editable JSON authoring surface). The topology is now edited
// exclusively through typed controls (Visual designer + Operators builder); this
// view renders the GENERATED, read-only definition: the compiled Stream
// Analytics query plus the resolved topology JSON. Nothing here is editable.
// ============================================================
function EventstreamDefinitionView({ cfg }: { cfg: VisualPipelineConfig }) {
  const s = useStyles();
  const { sources, transforms, sinks } = useMemo(() => esTopology(cfg), [cfg]);
  const compiledSaql = useMemo(() => esCompileDefinition(sources, transforms, sinks), [sources, transforms, sinks]);
  const topologyJson = useMemo(() => JSON.stringify({ sources, transforms, sinks }, null, 2), [sources, transforms, sinks]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM }}>
      <MessageBar intent="info">
        <MessageBarBody>
          <MessageBarTitle>Generated definition (read-only)</MessageBarTitle>
          Edit the stream on the <strong>Visual designer</strong> or <strong>Operators</strong> tabs. The
          Stream Analytics query and the topology below are generated from those typed controls — this view
          is read-only.
        </MessageBarBody>
      </MessageBar>

      <div className={s.card} style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS }}>
          <MathFormula20Regular style={{ color: tokens.colorBrandForeground1 }} />
          <Subtitle2>Compiled Stream Analytics query</Subtitle2>
          <Badge appearance="outline" color="brand">read-only</Badge>
        </div>
        <MonacoTextarea value={compiledSaql} onChange={() => { /* read-only */ }} language="sql" height={240} minHeight={180} readOnly ariaLabel="Compiled Stream Analytics query definition (read-only)" />
      </div>

      <div className={s.card} style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS }}>
          <Form20Regular style={{ color: tokens.colorBrandForeground1 }} />
          <Subtitle2>Resolved topology</Subtitle2>
          <Badge appearance="outline" color="brand">read-only</Badge>
          <Caption1 style={{ color: tokens.colorNeutralForeground3, marginLeft: 'auto' }}>
            {sources.length} source{sources.length === 1 ? '' : 's'} · {transforms.length} operator{transforms.length === 1 ? '' : 's'} · {sinks.length} destination{sinks.length === 1 ? '' : 's'}
          </Caption1>
        </div>
        <MonacoTextarea value={topologyJson} onChange={() => { /* read-only */ }} language="json" height={240} minHeight={180} readOnly ariaLabel="Resolved topology definition (read-only)" />
      </div>
    </div>
  );
}
