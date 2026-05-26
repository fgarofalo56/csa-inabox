'use client';

/**
 * Phase 4 editors — Data Science, APIs / Functions, Fabric IQ.
 *
 * MlModelEditor and MlExperimentEditor are wired live to the AI Foundry hub
 * (Microsoft.MachineLearningServices/workspaces) via the BFF:
 *   GET /api/items/ml-model/[id]      → model + versions
 *   GET /api/items/ml-experiment/[id] → job OR experiment grouping of runs
 * No mock data; errors surface in MessageBar.
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  Subtitle2, Body1, Caption1, Badge, Button, Input, Textarea, Spinner,
  Tab, TabList,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  Tree, TreeItem, TreeItemLayout,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { ItemEditorChrome } from './item-editor-chrome';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';

const useStyles = makeStyles({
  pad: { padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px' },
  monaco: {
    width: '100%', minHeight: '180px',
    fontFamily: 'Consolas, "Cascadia Code", monospace',
    fontSize: '13px', padding: '12px',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: '4px',
    backgroundColor: tokens.colorNeutralBackground3,
    color: tokens.colorNeutralForeground1,
    resize: 'vertical',
  },
  tabBar: { padding: '8px 16px 0', borderBottom: `1px solid ${tokens.colorNeutralStroke2}` },
  card: { padding: '12px', border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: '6px' },
  cardGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '12px' },
});

// ----- ML Model -----
const ML_RIBBON: RibbonTab[] = [
  { id: 'home', label: 'Home', groups: [
    { label: 'Versions', actions: [{ label: 'Reload' }, { label: 'Compare versions' }] },
    { label: 'Apply', actions: [{ label: 'Apply (PREDICT)' }, { label: 'Real-time endpoint' }] },
  ]},
];

interface ModelSummary {
  id: string; name: string; description?: string; latestVersion?: string;
  tags?: Record<string, string>; properties?: Record<string, string>;
}
interface ModelVersion {
  id: string; name: string; version: string; description?: string;
  modelType?: string; modelUri?: string; createdAt?: string;
  tags?: Record<string, string>; properties?: Record<string, string>;
}

export function MlModelEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [model, setModel] = useState<ModelSummary | null>(null);
  const [versions, setVersions] = useState<ModelVersion[]>([]);
  const [selected, setSelected] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await fetch(`/api/items/ml-model/${encodeURIComponent(id)}`);
      const j = await r.json();
      if (!j.ok) { setError(j.error || `HTTP ${r.status}`); setLoading(false); return; }
      setModel(j.model);
      setVersions(j.versions || []);
      setSelected(j.versions?.[0]?.version || null);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [id]);
  useEffect(() => { load(); }, [load]);

  const current = versions.find((v) => v.version === selected) || versions[0];

  return (
    <ItemEditorChrome
      item={item}
      id={id}
      ribbon={ML_RIBBON}
      leftPanel={
        <div style={{ padding: 8 }}>
          <Caption1 style={{ padding: '4px 8px', color: tokens.colorNeutralForeground3 }}>
            Versions ({versions.length})
          </Caption1>
          {versions.length === 0 && !loading && (
            <Body1 style={{ padding: 8, color: tokens.colorNeutralForeground3 }}>No versions registered.</Body1>
          )}
          <Tree aria-label="Model versions">
            {versions.map((v) => (
              <TreeItem
                itemType="leaf"
                key={v.version}
                onClick={() => setSelected(v.version)}
                style={{ background: v.version === selected ? tokens.colorNeutralBackground2 : undefined }}
              >
                <TreeItemLayout>
                  v{v.version}
                  {model?.latestVersion === v.version && (
                    <Badge appearance="tint" color="brand" style={{ marginLeft: 8 }}>latest</Badge>
                  )}
                </TreeItemLayout>
              </TreeItem>
            ))}
          </Tree>
        </div>
      }
      main={
        <div className={s.pad}>
          {loading && <Spinner size="small" label="Loading model…" labelPosition="after" />}
          {error && (
            <MessageBar intent="error">
              <MessageBarBody><MessageBarTitle>Load failed</MessageBarTitle>{error}</MessageBarBody>
            </MessageBar>
          )}
          {model && !loading && !error && (
            <>
              <Subtitle2>{model.name}</Subtitle2>
              {model.description && <Body1>{model.description}</Body1>}
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                <Badge appearance="tint">Latest: v{model.latestVersion || '—'}</Badge>
                <Badge appearance="tint">{versions.length} version(s)</Badge>
              </div>
              <Subtitle2 style={{ marginTop: 8 }}>Versions</Subtitle2>
              <Table aria-label="Model versions" size="small">
                <TableHeader><TableRow>
                  <TableHeaderCell>Version</TableHeaderCell>
                  <TableHeaderCell>Type</TableHeaderCell>
                  <TableHeaderCell>Created</TableHeaderCell>
                  <TableHeaderCell>URI</TableHeaderCell>
                </TableRow></TableHeader>
                <TableBody>
                  {versions.map((v) => (
                    <TableRow key={v.version}>
                      <TableCell><strong>v{v.version}</strong></TableCell>
                      <TableCell>{v.modelType || '—'}</TableCell>
                      <TableCell>{v.createdAt || '—'}</TableCell>
                      <TableCell style={{ fontFamily: 'monospace', fontSize: 12 }}>{v.modelUri || '—'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {current && (
                <>
                  <Subtitle2 style={{ marginTop: 8 }}>Selected: v{current.version}</Subtitle2>
                  {current.description && <Body1>{current.description}</Body1>}
                  {current.tags && Object.keys(current.tags).length > 0 && (
                    <div>
                      <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Tags</Caption1>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
                        {Object.entries(current.tags).map(([k, v]) => (
                          <Badge key={k} appearance="outline">{k}={String(v)}</Badge>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </div>
      }
    />
  );
}

// ----- ML Experiment -----
const MLE_RIBBON: RibbonTab[] = [
  { id: 'home', label: 'Home', groups: [
    { label: 'Runs', actions: [{ label: 'Reload' }, { label: 'Register model' }] },
    { label: 'Charts', actions: [{ label: 'Parallel coordinates' }, { label: 'Scatter' }] },
  ]},
];

interface FoundryJob {
  id: string; name: string; displayName?: string; jobType?: string;
  experimentName?: string; status?: string; startTimeUtc?: string; endTimeUtc?: string;
  computeId?: string; description?: string;
  tags?: Record<string, string>; properties?: Record<string, string>;
}

export function MlExperimentEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<'job' | 'experiment' | null>(null);
  const [job, setJob] = useState<FoundryJob | null>(null);
  const [runs, setRuns] = useState<FoundryJob[]>([]);
  const [expName, setExpName] = useState<string>('');
  const [selectedRun, setSelectedRun] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await fetch(`/api/items/ml-experiment/${encodeURIComponent(id)}`);
      const j = await r.json();
      if (!j.ok) { setError(j.error || `HTTP ${r.status}`); setLoading(false); return; }
      setKind(j.kind);
      if (j.kind === 'job') {
        setJob(j.job); setRuns([j.job]); setSelectedRun(j.job?.name || null);
      } else {
        setJob(null); setRuns(j.runs || []); setExpName(j.experimentName || '');
        setSelectedRun(j.runs?.[0]?.name || null);
      }
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [id]);
  useEffect(() => { load(); }, [load]);

  const current = runs.find((r) => r.name === selectedRun) || runs[0] || job;

  return (
    <ItemEditorChrome
      item={item}
      id={id}
      ribbon={MLE_RIBBON}
      leftPanel={
        <div style={{ padding: 8 }}>
          <Caption1 style={{ padding: '4px 8px', color: tokens.colorNeutralForeground3 }}>
            Runs ({runs.length})
          </Caption1>
          <Tree aria-label="Runs">
            {runs.map((r) => (
              <TreeItem
                itemType="leaf"
                key={r.name}
                onClick={() => setSelectedRun(r.name)}
                style={{ background: r.name === selectedRun ? tokens.colorNeutralBackground2 : undefined }}
              >
                <TreeItemLayout>
                  <span style={{ fontSize: 12 }}>{r.displayName || r.name}</span>
                  {r.status && (
                    <Badge
                      appearance="tint"
                      color={r.status === 'Completed' ? 'success' : r.status === 'Failed' ? 'danger' : 'informative'}
                      style={{ marginLeft: 8 }}
                    >
                      {r.status}
                    </Badge>
                  )}
                </TreeItemLayout>
              </TreeItem>
            ))}
          </Tree>
        </div>
      }
      main={
        <div className={s.pad}>
          {loading && <Spinner size="small" label="Loading runs…" labelPosition="after" />}
          {error && (
            <MessageBar intent="error">
              <MessageBarBody><MessageBarTitle>Load failed</MessageBarTitle>{error}</MessageBarBody>
            </MessageBar>
          )}
          {!loading && !error && kind === 'experiment' && (
            <>
              <Subtitle2>Experiment: {expName || '(unnamed)'}</Subtitle2>
              <Caption1>{runs.length} run(s)</Caption1>
            </>
          )}
          {!loading && !error && kind === 'job' && job && (
            <>
              <Subtitle2>{job.displayName || job.name}</Subtitle2>
              {job.experimentName && <Caption1>Experiment: {job.experimentName}</Caption1>}
            </>
          )}
          {!loading && !error && runs.length > 0 && (
            <>
              <Table aria-label="Runs" size="small">
                <TableHeader><TableRow>
                  <TableHeaderCell>Run</TableHeaderCell>
                  <TableHeaderCell>Type</TableHeaderCell>
                  <TableHeaderCell>Status</TableHeaderCell>
                  <TableHeaderCell>Started</TableHeaderCell>
                  <TableHeaderCell>Ended</TableHeaderCell>
                </TableRow></TableHeader>
                <TableBody>
                  {runs.map((r) => (
                    <TableRow key={r.name}>
                      <TableCell><strong>{r.displayName || r.name}</strong></TableCell>
                      <TableCell>{r.jobType || '—'}</TableCell>
                      <TableCell>{r.status || '—'}</TableCell>
                      <TableCell>{r.startTimeUtc || '—'}</TableCell>
                      <TableCell>{r.endTimeUtc || '—'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {current && (
                <>
                  <Subtitle2 style={{ marginTop: 8 }}>Selected run: {current.displayName || current.name}</Subtitle2>
                  {current.description && <Body1>{current.description}</Body1>}
                  {current.properties && Object.keys(current.properties).length > 0 && (
                    <>
                      <Caption1 style={{ color: tokens.colorNeutralForeground3, marginTop: 8 }}>Properties / metrics</Caption1>
                      <Table aria-label="Properties" size="small">
                        <TableHeader><TableRow><TableHeaderCell>Key</TableHeaderCell><TableHeaderCell>Value</TableHeaderCell></TableRow></TableHeader>
                        <TableBody>
                          {Object.entries(current.properties).map(([k, v]) => (
                            <TableRow key={k}>
                              <TableCell style={{ fontFamily: 'monospace', fontSize: 12 }}>{k}</TableCell>
                              <TableCell style={{ fontFamily: 'monospace', fontSize: 12 }}>{String(v)}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </>
                  )}
                </>
              )}
            </>
          )}
        </div>
      }
    />
  );
}

// =====================================================================
// v2.x — Phase 4 misc editors wired to real persistence.
//
// Pattern: each editor uses the generic Cosmos-backed item route:
//   GET    /api/items/<slug>/<id>       → returns the WorkspaceItem
//   PATCH  /api/items/<slug>/<id>       → { state: {...} } persists
// State is the editor's source of truth. Where a real Azure runtime
// exists today (APIM for graphql-api, ADX for graph-model materialize),
// a dedicated action endpoint is also wired. Where the runtime is not
// yet deployed (Foundry Agent Service, Functions code-deploy, Activator
// hooks for ontology/plan), an honest MessageBar surfaces what is and
// isn't live in this build.
// =====================================================================

interface ItemDoc { id: string; displayName: string; state?: Record<string, unknown>; updatedAt?: string }

function useItemState<T extends Record<string, unknown>>(slug: string, id: string, fallback: T) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [state, setState] = useState<T>(fallback);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await fetch(`/api/items/${slug}/${encodeURIComponent(id)}`);
      const j = await r.json();
      if (!r.ok) { setError(j?.error || `HTTP ${r.status}`); return; }
      const doc = j as ItemDoc;
      if (doc.state && typeof doc.state === 'object') {
        setState({ ...fallback, ...(doc.state as T) });
      }
      setSavedAt(doc.updatedAt || null);
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setLoading(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, id]);

  useEffect(() => { load(); }, [load]);

  const save = useCallback(async (next?: T) => {
    setSaving(true); setError(null);
    try {
      const payload = next ?? state;
      const r = await fetch(`/api/items/${slug}/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ state: payload }),
      });
      const j = await r.json();
      if (!r.ok) { setError(j?.error || `HTTP ${r.status}`); return false; }
      setSavedAt(j?.updatedAt || new Date().toISOString());
      return true;
    } catch (e: any) { setError(e?.message || String(e)); return false; }
    finally { setSaving(false); }
  }, [slug, id, state]);

  return { state, setState, loading, saving, error, savedAt, save, reload: load };
}

function SaveBar({ saving, savedAt, error, onSave, extraRight }: {
  saving: boolean; savedAt: string | null; error: string | null;
  onSave: () => void; extraRight?: ReactNode;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 0', borderTop: `1px solid ${tokens.colorNeutralStroke2}` }}>
      <Button appearance="primary" onClick={onSave} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
      {savedAt && !saving && <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Saved {new Date(savedAt).toLocaleTimeString()}</Caption1>}
      {error && <Caption1 style={{ color: tokens.colorPaletteRedForeground1 }}>{error}</Caption1>}
      <div style={{ flex: 1 }} />
      {extraRight}
    </div>
  );
}

// ----- GraphQL API (Cosmos state + real APIM publish) -----
const GQL_SAMPLE = `type Query {\n  customers(region: String, first: Int = 10): [Customer!]!\n}\ntype Customer { id: ID! name: String! orders: [Order!]! }\ntype Order { id: ID! total: Float! }`;
const GQL_RIBBON: RibbonTab[] = [
  { id: 'home', label: 'Home', groups: [
    { label: 'Schema', actions: [{ label: 'Reload' }, { label: 'Publish to APIM' }] },
    { label: 'Auth', actions: [{ label: 'Subscription required' }] },
  ]},
];
interface GqlState { displayName: string; path: string; serviceUrl: string; sdl: string; description: string; subscriptionRequired: boolean; lastPublishedAt?: string; lastPublishedTo?: string; [k: string]: unknown }
export function GraphqlApiEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const { state, setState, loading, saving, error, savedAt, save } = useItemState<GqlState>('graphql-api', id, {
    displayName: '', path: '', serviceUrl: '', sdl: GQL_SAMPLE, description: '', subscriptionRequired: true,
  });
  const [publishing, setPublishing] = useState(false);
  const [publishMsg, setPublishMsg] = useState<{ intent: 'success' | 'error'; text: string } | null>(null);

  const publish = useCallback(async () => {
    setPublishing(true); setPublishMsg(null);
    const ok = await save();
    if (!ok) { setPublishing(false); return; }
    try {
      const r = await fetch(`/api/items/graphql-api/${encodeURIComponent(id)}/publish`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          displayName: state.displayName || item.displayName || id,
          path: state.path || id,
          sdl: state.sdl,
          serviceUrl: state.serviceUrl || undefined,
          description: state.description || undefined,
          subscriptionRequired: state.subscriptionRequired,
        }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) { setPublishMsg({ intent: 'error', text: j?.error || `HTTP ${r.status}` }); return; }
      const next = { ...state, lastPublishedAt: new Date().toISOString(), lastPublishedTo: j.api?.id || id };
      setState(next); await save(next);
      setPublishMsg({ intent: 'success', text: `Published to APIM as ${j.api?.name || id}` });
    } catch (e: any) { setPublishMsg({ intent: 'error', text: e?.message || String(e) }); }
    finally { setPublishing(false); }
  }, [id, item.displayName, state, save, setState]);

  return (
    <ItemEditorChrome item={item} id={id} ribbon={GQL_RIBBON} main={
      <div className={s.pad}>
        {loading && <Spinner size="small" label="Loading…" labelPosition="after" />}
        <Subtitle2>API configuration</Subtitle2>
        <Caption1>Display name</Caption1>
        <Input value={state.displayName} onChange={(_, d) => setState({ ...state, displayName: d.value })} placeholder={item.displayName || id} />
        <Caption1>URL path suffix (under APIM gateway)</Caption1>
        <Input value={state.path} onChange={(_, d) => setState({ ...state, path: d.value })} placeholder={id} />
        <Caption1>Backend service URL (optional resolver target)</Caption1>
        <Input value={state.serviceUrl} onChange={(_, d) => setState({ ...state, serviceUrl: d.value })} placeholder="https://backend.example.com/graphql" />
        <Caption1>Description</Caption1>
        <Input value={state.description} onChange={(_, d) => setState({ ...state, description: d.value })} />
        <Subtitle2 style={{ marginTop: 8 }}>Schema (SDL)</Subtitle2>
        <textarea className={s.monaco} value={state.sdl} onChange={(e) => setState({ ...state, sdl: e.target.value })} spellCheck={false} aria-label="GraphQL SDL" style={{ minHeight: 260 }} />
        {state.lastPublishedAt && (
          <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
            Last published {new Date(state.lastPublishedAt).toLocaleString()} → <code>{state.lastPublishedTo}</code>
          </Caption1>
        )}
        {publishMsg && (
          <MessageBar intent={publishMsg.intent}>
            <MessageBarBody>{publishMsg.text}</MessageBarBody>
          </MessageBar>
        )}
        <SaveBar
          saving={saving} savedAt={savedAt} error={error} onSave={() => save()}
          extraRight={<Button onClick={publish} disabled={publishing || saving}>{publishing ? 'Publishing…' : 'Publish to APIM'}</Button>}
        />
      </div>
    } />
  );
}

// ----- User Data Function (Cosmos code+config; deploy is config-only in v2.1) -----
const UDF_SAMPLE = `import fabric.functions as fn\nudf = fn.UserDataFunctions()\n\n@udf.function()\ndef compute_score(user_id: str, weight: float = 1.0) -> dict:\n    return {"user": user_id, "score": weight * 42}`;
const UDF_RIBBON: RibbonTab[] = [
  { id: 'home', label: 'Home', groups: [
    { label: 'Function', actions: [{ label: 'Reload' }, { label: 'Save' }] },
    { label: 'Deploy', actions: [{ label: 'Deploy to Function App' }] },
  ]},
];
interface UdfState { runtime: 'python' | 'node' | 'dotnet'; entrypoint: string; source: string; functionAppName: string; connections: string; [k: string]: unknown }
export function UserDataFunctionEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const { state, setState, loading, saving, error, savedAt, save } = useItemState<UdfState>('user-data-function', id, {
    runtime: 'python', entrypoint: 'compute_score', source: UDF_SAMPLE, functionAppName: '', connections: '',
  });
  return (
    <ItemEditorChrome item={item} id={id} ribbon={UDF_RIBBON} main={
      <div className={s.pad}>
        {loading && <Spinner size="small" label="Loading…" labelPosition="after" />}
        <MessageBar intent="info">
          <MessageBarBody>
            <MessageBarTitle>v2.1: code + config persisted</MessageBarTitle>
            Source and metadata save to Cosmos. Deploy-to-Azure-Functions wiring (ARM Microsoft.Web/sites publish) is deferred to v2.x — there is no Function App provisioned in this Loom instance yet.
          </MessageBarBody>
        </MessageBar>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
          <div>
            <Caption1>Runtime</Caption1>
            <select value={state.runtime} onChange={(e) => setState({ ...state, runtime: e.target.value as UdfState['runtime'] })}
              style={{ width: '100%', padding: 6, borderRadius: 4, border: `1px solid ${tokens.colorNeutralStroke2}`, background: tokens.colorNeutralBackground1, color: tokens.colorNeutralForeground1 }}>
              <option value="python">python</option>
              <option value="node">node</option>
              <option value="dotnet">dotnet</option>
            </select>
          </div>
          <div>
            <Caption1>Entrypoint</Caption1>
            <Input value={state.entrypoint} onChange={(_, d) => setState({ ...state, entrypoint: d.value })} />
          </div>
          <div>
            <Caption1>Target Function App (deploy)</Caption1>
            <Input value={state.functionAppName} onChange={(_, d) => setState({ ...state, functionAppName: d.value })} placeholder="not-yet-provisioned" />
          </div>
        </div>
        <Subtitle2 style={{ marginTop: 8 }}>function_app source</Subtitle2>
        <textarea className={s.monaco} value={state.source} onChange={(e) => setState({ ...state, source: e.target.value })} spellCheck={false} aria-label="Function source" style={{ minHeight: 280 }} />
        <Caption1>Connections (comma-separated workspace items)</Caption1>
        <Input value={state.connections} onChange={(_, d) => setState({ ...state, connections: d.value })} placeholder="fin-warehouse, ldn-gold-lakehouse" />
        <SaveBar saving={saving} savedAt={savedAt} error={error} onSave={() => save()} />
      </div>
    } />
  );
}

// ----- Variable Library (Cosmos, typed key/value with value sets) -----
const VL_RIBBON: RibbonTab[] = [
  { id: 'home', label: 'Home', groups: [
    { label: 'Variables', actions: [{ label: 'New variable' }, { label: 'Save' }] },
    { label: 'Value sets', actions: [{ label: 'dev' }, { label: 'test' }, { label: 'prod' }] },
  ]},
];
// v3.27: extended to Fabric's 7 variable types — String/Integer/Number/
// Boolean/DateTime/Guid/ItemReference/ConnectionReference. Plus the
// Loom-native `secret-ref` for KV / env-var lookups.
type VarType =
  | 'string'
  | 'integer'
  | 'number'
  | 'bool'
  | 'datetime'
  | 'guid'
  | 'item-ref'
  | 'connection-ref'
  | 'secret-ref';
interface VarDef { name: string; type: VarType; default: string; dev?: string; test?: string; prod?: string; description?: string; }
interface VlState { variables: VarDef[]; [k: string]: unknown }
const VL_VALUE_SETS: Array<'default' | 'dev' | 'test' | 'prod'> = ['default', 'dev', 'test', 'prod'];

const VAR_TYPE_LABELS: Record<VarType, string> = {
  string: 'String',
  integer: 'Integer',
  number: 'Number',
  bool: 'Boolean',
  datetime: 'DateTime',
  guid: 'Guid',
  'item-ref': 'ItemReference',
  'connection-ref': 'ConnectionReference',
  'secret-ref': 'SecretReference',
};
const VAR_TYPE_PLACEHOLDERS: Record<VarType, string> = {
  string: '',
  integer: '0',
  number: '0.0',
  bool: 'true | false',
  datetime: 'YYYY-MM-DDThh:mm:ssZ',
  guid: '00000000-0000-0000-0000-000000000000',
  'item-ref': 'Loom item id (Cosmos)',
  'connection-ref': 'connection id (ADF Linked Service / Power Platform connection)',
  'secret-ref': 'kv-uri or env var name',
};

function validateVarValue(type: VarType, value: string): string | null {
  if (!value) return null;
  switch (type) {
    case 'integer': return /^-?\d+$/.test(value) ? null : 'must be an integer';
    case 'number': return /^-?\d+(\.\d+)?$/.test(value) ? null : 'must be a number';
    case 'bool': return /^(true|false)$/i.test(value) ? null : 'must be true or false';
    case 'datetime': return /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?(Z|[+-]\d{2}:?\d{2})?)?$/.test(value) ? null : 'ISO 8601 expected';
    case 'guid': return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? null : 'GUID expected';
    default: return null;
  }
}

export function VariableLibraryEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const { state, setState, loading, saving, error, savedAt, save } = useItemState<VlState>('variable-library', id, {
    variables: [
      { name: 'ENV', type: 'string', default: 'dev' },
      { name: 'BatchSize', type: 'number', default: '5000' },
      { name: 'EnableCopilot', type: 'bool', default: 'true' },
    ],
  });
  const [tab, setTab] = useState<typeof VL_VALUE_SETS[number]>('default');
  const update = (idx: number, patch: Partial<VarDef>) => {
    const next = [...state.variables];
    next[idx] = { ...next[idx], ...patch };
    setState({ ...state, variables: next });
  };
  const addRow = () => setState({ ...state, variables: [...state.variables, { name: `var${state.variables.length + 1}`, type: 'string', default: '' }] });
  const deleteRow = (idx: number) => setState({ ...state, variables: state.variables.filter((_, i) => i !== idx) });
  const valueKey = tab === 'default' ? 'default' : tab;

  return (
    <ItemEditorChrome item={item} id={id} ribbon={VL_RIBBON} main={
      <>
        <div className={s.tabBar}>
          <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as typeof tab)}>
            {VL_VALUE_SETS.map((v) => <Tab key={v} value={v}>{v}</Tab>)}
          </TabList>
        </div>
        <div className={s.pad}>
          {loading && <Spinner size="small" label="Loading…" labelPosition="after" />}
          <MessageBar intent="info">
            <MessageBarBody>
              Reference variables in pipelines / notebooks as <code>@{'{'}variables.NAME{'}'}</code>. The active value set is resolved at runtime by the executor.
            </MessageBarBody>
          </MessageBar>
          <Table aria-label="Variables" size="small">
            <TableHeader><TableRow>
              <TableHeaderCell>Name</TableHeaderCell>
              <TableHeaderCell>Type</TableHeaderCell>
              <TableHeaderCell>Value ({tab})</TableHeaderCell>
              <TableHeaderCell>Description</TableHeaderCell>
              <TableHeaderCell />
            </TableRow></TableHeader>
            <TableBody>
              {state.variables.map((v, i) => {
                const val = (v as any)[valueKey] ?? '';
                const validationErr = validateVarValue(v.type, val);
                return (
                  <TableRow key={i}>
                    <TableCell><Input value={v.name} onChange={(_, d) => update(i, { name: d.value })} /></TableCell>
                    <TableCell>
                      <select value={v.type} onChange={(e) => update(i, { type: e.target.value as VarType })}
                        style={{ padding: 4, borderRadius: 4, border: `1px solid ${tokens.colorNeutralStroke2}`, background: tokens.colorNeutralBackground1, color: tokens.colorNeutralForeground1 }}>
                        {Object.entries(VAR_TYPE_LABELS).map(([t, label]) => (
                          <option key={t} value={t}>{label}</option>
                        ))}
                      </select>
                    </TableCell>
                    <TableCell>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                        <Input value={val} onChange={(_, d) => update(i, { [valueKey]: d.value } as any)}
                          placeholder={VAR_TYPE_PLACEHOLDERS[v.type]} />
                        {validationErr && <Caption1 style={{ color: tokens.colorPaletteRedForeground1 }}>{validationErr}</Caption1>}
                      </div>
                    </TableCell>
                    <TableCell><Input value={v.description ?? ''} onChange={(_, d) => update(i, { description: d.value })} placeholder="optional" /></TableCell>
                    <TableCell><Button size="small" onClick={() => deleteRow(i)}>Delete</Button></TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          <Button onClick={addRow} style={{ alignSelf: 'flex-start' }}>+ New variable</Button>
          <SaveBar saving={saving} savedAt={savedAt} error={error} onSave={() => save()} />
        </div>
      </>
    } />
  );
}

// ----- Ontology (text-stored OWL/RDF; class tree parsed client-side) -----
const ONTO_SAMPLE = `# Turtle-ish — define entity types and a parent hierarchy.\n# Each line: "ClassName : ParentClass  -- description"\nThing :  -- root\nParty : Thing -- person or org\nCustomer : Party -- buying party\nVendor : Party -- selling party\nOrder : Thing -- transaction record\nFlight : Thing -- aviation event\n`;
interface OntoState { source: string; [k: string]: unknown }

function parseOntologyHierarchy(src: string): { name: string; parent?: string; description?: string }[] {
  const out: { name: string; parent?: string; description?: string }[] = [];
  for (const raw of src.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const m = line.match(/^([A-Za-z_][\w]*)\s*:\s*([A-Za-z_][\w]*)?\s*(?:--\s*(.*))?$/);
    if (m) out.push({ name: m[1], parent: m[2] || undefined, description: m[3] });
  }
  return out;
}

export function OntologyEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const { state, setState, loading, saving, error, savedAt, save } = useItemState<OntoState>('ontology', id, { source: ONTO_SAMPLE });
  const classes = parseOntologyHierarchy(state.source || '');
  const [materializing, setMaterializing] = useState(false);
  const [matMsg, setMatMsg] = useState<string | null>(null);

  // v3.27: D-upgrade — materialize the ontology hierarchy as a graph-model.
  // Each class becomes a node type; parent → child edges become an `is_a`
  // relationship type. The new graph-model can then be ADX-materialized
  // via its own /materialize endpoint to create real KQL tables.
  const materializeToGraphModel = useCallback(async () => {
    if (classes.length === 0) {
      setMatMsg('No classes parsed — nothing to materialize.');
      return;
    }
    setMaterializing(true); setMatMsg(null);
    try {
      const nodes = classes.map(c => ({
        name: c.name,
        properties: [
          { name: 'id', type: 'string' },
          ...(c.description ? [{ name: 'description', type: 'string' }] : []),
        ],
      }));
      const hasParents = classes.some(c => c.parent);
      const edges = hasParents
        ? [{ name: 'IS_A', properties: [{ name: 'inheritedAt', type: 'datetime' }] }]
        : [];
      const r = await fetch('/api/items/graph-model', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workspaceId: 'default',
          displayName: `${item.label || 'Ontology'} graph (from ontology ${id})`,
          state: {
            nodes,
            edges,
            database: 'loomdb-default',
            sourceOntologyId: id,
            sourceOntologyClasses: classes.length,
          },
        }),
      });
      const j = await r.json();
      if (!j.ok) { setMatMsg(`Failed: ${j.error || `HTTP ${r.status}`}`); return; }
      setMatMsg(`Materialized as graph-model id=${j.item?.id || j.id} with ${nodes.length} node type(s) + ${edges.length} edge type(s). Open the graph-model editor and click Materialize to push to ADX.`);
    } catch (e: any) {
      setMatMsg(`Failed: ${e?.message || String(e)}`);
    } finally { setMaterializing(false); }
  }, [classes, id, item.label]);

  return (
    <ItemEditorChrome item={item} id={id} ribbon={IQ_RIBBON} main={
      <div className={s.pad}>
        {loading && <Spinner size="small" label="Loading…" labelPosition="after" />}
        <MessageBar intent="info">
          <MessageBarBody>
            <MessageBarTitle>Ontology runtime</MessageBarTitle>
            v3.27 adds the <strong>Materialize as graph-model</strong> action below — converts the parsed class hierarchy into a graph-model item (one node type per class, IS_A edge type for parent relationships). The graph-model can then be ADX-materialized to create real KQL tables. Lakehouse/Warehouse entity binding + Activator triggers are still deferred.
          </MessageBarBody>
        </MessageBar>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: 16 }}>
          <div>
            <Subtitle2>Source ({classes.length} classes)</Subtitle2>
            <textarea className={s.monaco} value={state.source} onChange={(e) => setState({ ...state, source: e.target.value })} spellCheck={false} aria-label="Ontology source" style={{ minHeight: 360 }} />
          </div>
          <div>
            <Subtitle2>Class hierarchy</Subtitle2>
            <Tree aria-label="Class hierarchy">
              {classes.map((c) => (
                <TreeItem itemType="leaf" key={c.name}>
                  <TreeItemLayout>
                    <strong>{c.name}</strong>
                    {c.parent && <Caption1 style={{ marginLeft: 6, color: tokens.colorNeutralForeground3 }}>: {c.parent}</Caption1>}
                  </TreeItemLayout>
                </TreeItem>
              ))}
            </Tree>
            <Button appearance="primary" disabled={materializing || classes.length === 0} onClick={materializeToGraphModel} style={{ marginTop: 8, alignSelf: 'flex-start' }}>
              {materializing ? 'Materializing…' : `Materialize as graph-model (${classes.length} class${classes.length === 1 ? '' : 'es'})`}
            </Button>
            {matMsg && (
              <MessageBar intent={matMsg.startsWith('Failed') ? 'error' : 'success'} style={{ marginTop: 8 }}>
                <MessageBarBody>{matMsg}</MessageBarBody>
              </MessageBar>
            )}
          </div>
        </div>
        <SaveBar saving={saving} savedAt={savedAt} error={error} onSave={() => save()} />
      </div>
    } />
  );
}

// ----- Graph Model (Cosmos config + real ADX materialize) -----
const IQ_RIBBON: RibbonTab[] = [{ id: 'home', label: 'Home', groups: [
  { label: 'Author', actions: [{ label: 'Add entity' }, { label: 'Add relationship' }] },
  { label: 'Bind', actions: [{ label: 'Save' }, { label: 'Materialize' }] },
]}];
interface GraphDecl { name: string; properties: { name: string; type: string }[] }
interface GraphState { nodes: GraphDecl[]; edges: GraphDecl[]; database: string; lastMaterializedAt?: string; [k: string]: unknown }

export function GraphModelEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const { state, setState, loading, saving, error, savedAt, save } = useItemState<GraphState>('graph-model', id, {
    nodes: [{ name: 'Customer', properties: [{ name: 'name', type: 'string' }] }],
    edges: [{ name: 'PLACED', properties: [{ name: 'at', type: 'datetime' }] }],
    database: 'loomdb-default',
  });
  const [materializing, setMaterializing] = useState(false);
  const [matResult, setMatResult] = useState<any>(null);

  const materialize = useCallback(async () => {
    setMaterializing(true); setMatResult(null);
    const ok = await save();
    if (!ok) { setMaterializing(false); return; }
    try {
      const r = await fetch(`/api/items/graph-model/${encodeURIComponent(id)}/materialize`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ database: state.database, nodes: state.nodes, edges: state.edges }),
      });
      const j = await r.json();
      setMatResult(j);
      if (r.ok && j.ok) {
        const next = { ...state, lastMaterializedAt: new Date().toISOString() };
        setState(next); await save(next);
      }
    } catch (e: any) { setMatResult({ ok: false, error: e?.message || String(e) }); }
    finally { setMaterializing(false); }
  }, [id, state, save, setState]);

  const editJson = (key: 'nodes' | 'edges', text: string) => {
    try { const parsed = JSON.parse(text); if (Array.isArray(parsed)) setState({ ...state, [key]: parsed }); }
    catch { /* leave previous */ }
  };

  return (
    <ItemEditorChrome item={item} id={id} ribbon={IQ_RIBBON} main={
      <div className={s.pad}>
        {loading && <Spinner size="small" label="Loading…" labelPosition="after" />}
        <Caption1>Target ADX database</Caption1>
        <Input value={state.database} onChange={(_, d) => setState({ ...state, database: d.value })} />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div>
            <Subtitle2>Node types</Subtitle2>
            <textarea className={s.monaco} defaultValue={JSON.stringify(state.nodes, null, 2)}
              onBlur={(e) => editJson('nodes', e.target.value)} spellCheck={false} aria-label="Node types JSON" style={{ minHeight: 220 }} />
          </div>
          <div>
            <Subtitle2>Edge types</Subtitle2>
            <textarea className={s.monaco} defaultValue={JSON.stringify(state.edges, null, 2)}
              onBlur={(e) => editJson('edges', e.target.value)} spellCheck={false} aria-label="Edge types JSON" style={{ minHeight: 220 }} />
          </div>
        </div>
        {state.lastMaterializedAt && (
          <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Last materialized {new Date(state.lastMaterializedAt).toLocaleString()}</Caption1>
        )}
        {matResult && (
          <MessageBar intent={matResult.ok ? 'success' : 'error'}>
            <MessageBarBody>
              <MessageBarTitle>{matResult.ok ? `Materialized to ${matResult.database}` : 'Materialize failed'}</MessageBarTitle>
              {matResult.created && (
                <ul style={{ margin: '4px 0 0 16px', padding: 0 }}>
                  {matResult.created.map((c: any, i: number) => (
                    <li key={i} style={{ fontFamily: 'monospace', fontSize: 12 }}>
                      {c.ok ? '[ok]' : '[err]'} {c.kind}:{c.name}{c.error ? ` — ${c.error}` : ''}
                    </li>
                  ))}
                </ul>
              )}
              {matResult.error && <span>{matResult.error}</span>}
            </MessageBarBody>
          </MessageBar>
        )}
        <SaveBar
          saving={saving} savedAt={savedAt} error={error} onSave={() => save()}
          extraRight={<Button onClick={materialize} disabled={materializing || saving}>{materializing ? 'Materializing…' : 'Materialize to ADX'}</Button>}
        />
      </div>
    } />
  );
}

// ----- Plan (Cosmos task list) -----
interface PlanTask { title: string; owner: string; due: string; status: 'todo' | 'doing' | 'done'; dependsOn?: string }
interface PlanState { tasks: PlanTask[]; [k: string]: unknown }
const PLAN_RIBBON: RibbonTab[] = [{ id: 'home', label: 'Home', groups: [
  { label: 'Tasks', actions: [{ label: 'New task' }, { label: 'Save' }] },
]}];

export function PlanEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const { state, setState, loading, saving, error, savedAt, save } = useItemState<PlanState>('plan', id, {
    tasks: [{ title: 'Define semantic model', owner: '', due: '', status: 'todo' }],
  });
  const update = (idx: number, patch: Partial<PlanTask>) => {
    const next = [...state.tasks]; next[idx] = { ...next[idx], ...patch }; setState({ ...state, tasks: next });
  };
  const add = () => setState({ ...state, tasks: [...state.tasks, { title: '', owner: '', due: '', status: 'todo' }] });
  const remove = (idx: number) => setState({ ...state, tasks: state.tasks.filter((_, i) => i !== idx) });

  // v3.27: D-upgrade — compute and surface progress + overdue counts.
  const counts = state.tasks.reduce(
    (acc, t) => { acc[t.status] = (acc[t.status] || 0) + 1; return acc; },
    {} as Record<PlanTask['status'], number>,
  );
  const todo = counts.todo || 0;
  const doing = counts.doing || 0;
  const done = counts.done || 0;
  const total = state.tasks.length;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const today = new Date().toISOString().slice(0, 10);
  const overdue = state.tasks.filter(t => t.status !== 'done' && t.due && t.due < today).length;

  return (
    <ItemEditorChrome item={item} id={id} ribbon={PLAN_RIBBON} main={
      <div className={s.pad}>
        {loading && <Spinner size="small" label="Loading…" labelPosition="after" />}
        <MessageBar intent="info">
          <MessageBarBody>
            <MessageBarTitle>Plan runtime</MessageBarTitle>
            Plan rows save to Cosmos. v3.27: progress + status badges surface real counts; overdue tasks (due date passed and not done) get a danger badge. Approval-workflow handoff to <code>power-automate-flow</code> + semantic-model writeback are still deferred.
          </MessageBarBody>
        </MessageBar>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <Badge appearance="filled" color="brand">{total} task{total === 1 ? '' : 's'}</Badge>
          <Badge appearance="outline">to-do: {todo}</Badge>
          <Badge appearance="filled" color="warning">doing: {doing}</Badge>
          <Badge appearance="filled" color="success">done: {done}</Badge>
          {overdue > 0 && <Badge appearance="filled" color="danger">overdue: {overdue}</Badge>}
          <Caption1 style={{ marginLeft: 8 }}>{pct}% complete</Caption1>
          <div style={{ flex: 1, height: 6, backgroundColor: tokens.colorNeutralBackground3, borderRadius: 3, overflow: 'hidden', minWidth: 120, maxWidth: 240 }}>
            <div style={{ width: `${pct}%`, height: '100%', backgroundColor: tokens.colorBrandStroke1, transition: 'width 0.2s' }} />
          </div>
        </div>
        <Table aria-label="Plan tasks" size="small">
          <TableHeader><TableRow>
            <TableHeaderCell>Task</TableHeaderCell>
            <TableHeaderCell>Owner</TableHeaderCell>
            <TableHeaderCell>Due</TableHeaderCell>
            <TableHeaderCell>Status</TableHeaderCell>
            <TableHeaderCell>Depends on</TableHeaderCell>
            <TableHeaderCell />
          </TableRow></TableHeader>
          <TableBody>
            {state.tasks.map((t, i) => (
              <TableRow key={i}>
                <TableCell><Input value={t.title} onChange={(_, d) => update(i, { title: d.value })} /></TableCell>
                <TableCell><Input value={t.owner} onChange={(_, d) => update(i, { owner: d.value })} /></TableCell>
                <TableCell><Input type="date" value={t.due} onChange={(_, d) => update(i, { due: d.value })} /></TableCell>
                <TableCell>
                  <select value={t.status} onChange={(e) => update(i, { status: e.target.value as PlanTask['status'] })}
                    style={{ padding: 4, borderRadius: 4, border: `1px solid ${tokens.colorNeutralStroke2}`, background: tokens.colorNeutralBackground1, color: tokens.colorNeutralForeground1 }}>
                    <option value="todo">todo</option><option value="doing">doing</option><option value="done">done</option>
                  </select>
                </TableCell>
                <TableCell><Input value={t.dependsOn || ''} onChange={(_, d) => update(i, { dependsOn: d.value })} placeholder="task title" /></TableCell>
                <TableCell><Button size="small" onClick={() => remove(i)}>Delete</Button></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <Button onClick={add} style={{ alignSelf: 'flex-start' }}>+ New task</Button>
        <SaveBar saving={saving} savedAt={savedAt} error={error} onSave={() => save()} />
      </div>
    } />
  );
}

// ----- Map (Cosmos GeoJSON + JSON preview) -----
const GEO_SAMPLE = `{\n  "type": "FeatureCollection",\n  "features": [\n    { "type": "Feature", "properties": { "name": "Seattle" }, "geometry": { "type": "Point", "coordinates": [-122.33, 47.61] } }\n  ]\n}`;
interface MapState { geojson: string; [k: string]: unknown }
const MAP_RIBBON: RibbonTab[] = [{ id: 'home', label: 'Home', groups: [
  { label: 'Layer', actions: [{ label: 'Save' }, { label: 'Validate' }] },
]}];

export function MapEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const { state, setState, loading, saving, error, savedAt, save } = useItemState<MapState>('map', id, { geojson: GEO_SAMPLE });
  let parseErr: string | null = null;
  let featureCount = 0;
  let bbox: { minLon: number; maxLon: number; minLat: number; maxLat: number } | null = null;
  try {
    const j = JSON.parse(state.geojson);
    featureCount = Array.isArray(j?.features) ? j.features.length : 0;
    // v3.27: compute bbox to drive the Azure Maps tile preview centerpoint.
    if (Array.isArray(j?.features)) {
      let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
      for (const f of j.features) {
        const coords = f?.geometry?.coordinates;
        const walk = (c: any) => {
          if (!Array.isArray(c)) return;
          if (typeof c[0] === 'number' && typeof c[1] === 'number') {
            const [lon, lat] = c;
            if (lon < minLon) minLon = lon; if (lon > maxLon) maxLon = lon;
            if (lat < minLat) minLat = lat; if (lat > maxLat) maxLat = lat;
          } else { c.forEach(walk); }
        };
        walk(coords);
      }
      if (Number.isFinite(minLon)) bbox = { minLon, maxLon, minLat, maxLat };
    }
  } catch (e: any) { parseErr = e?.message || String(e); }

  // v3.27: D-upgrade — Azure Maps tile preview. Static-map REST API is the
  // simplest no-deps integration: just emit an <img>. Falls back to a
  // MessageBar gate when LOOM_AZURE_MAPS_SUBSCRIPTION_KEY isn't set.
  const mapsKey = process.env.NEXT_PUBLIC_LOOM_AZURE_MAPS_KEY;
  const centerLon = bbox ? (bbox.minLon + bbox.maxLon) / 2 : -122.33;
  const centerLat = bbox ? (bbox.minLat + bbox.maxLat) / 2 : 47.61;
  // Naive zoom heuristic: smaller bbox → larger zoom.
  const span = bbox ? Math.max(bbox.maxLon - bbox.minLon, bbox.maxLat - bbox.minLat) : 0.1;
  const zoom = Math.max(1, Math.min(18, Math.round(11 - Math.log2(Math.max(span, 0.0001)))));
  const tileUrl = mapsKey
    ? `https://atlas.microsoft.com/map/static?api-version=2024-04-01&style=main&zoom=${zoom}&center=${centerLon},${centerLat}&width=640&height=320&subscription-key=${mapsKey}`
    : null;

  return (
    <ItemEditorChrome item={item} id={id} ribbon={MAP_RIBBON} main={
      <div className={s.pad}>
        {loading && <Spinner size="small" label="Loading…" labelPosition="after" />}
        {!mapsKey && (
          <MessageBar intent="warning">
            <MessageBarBody>
              <MessageBarTitle>Azure Maps tile preview disabled</MessageBarTitle>
              GeoJSON persists to Cosmos and validates correctly. To enable the tile preview below, set <code>NEXT_PUBLIC_LOOM_AZURE_MAPS_KEY</code> in the Container App env to a key from an Azure Maps account (or use MI-auth via the future <code>/api/items/map/[id]/preview</code> proxy). Vector overlay rendering of the GeoJSON itself (atlas.data.Source) lands in v2.x.
            </MessageBarBody>
          </MessageBar>
        )}
        <Subtitle2>GeoJSON ({featureCount} feature{featureCount === 1 ? '' : 's'})</Subtitle2>
        <textarea className={s.monaco} value={state.geojson} onChange={(e) => setState({ ...state, geojson: e.target.value })} spellCheck={false} aria-label="GeoJSON" style={{ minHeight: 280 }} />
        {parseErr && <MessageBar intent="error"><MessageBarBody>Invalid JSON: {parseErr}</MessageBarBody></MessageBar>}
        {tileUrl && (
          <>
            <Subtitle2>Azure Maps preview (zoom {zoom}, center {centerLat.toFixed(3)}, {centerLon.toFixed(3)})</Subtitle2>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={tileUrl} alt="Azure Maps tile preview" style={{ width: '100%', maxWidth: 640, borderRadius: 4, border: `1px solid ${tokens.colorNeutralStroke2}` }} />
            <Caption1>Static-map preview only — features above are NOT rendered as overlays in this snapshot. Use the vector overlay path in v2.x for live layer rendering.</Caption1>
          </>
        )}
        <SaveBar saving={saving} savedAt={savedAt} error={error} onSave={() => save()} />
      </div>
    } />
  );
}

// ----- Operations Agent (Cosmos config + Phase 1 Foundry deploy stub) -----
const OPS_RIBBON: RibbonTab[] = [{ id: 'home', label: 'Home', groups: [
  { label: 'Agent', actions: [{ label: 'Save' }, { label: 'Deploy to Foundry' }] },
]}];
interface AgentState {
  systemPrompt: string; model: string; tools: string;
  eventhouse: string; ontology: string;
  foundryAgentId?: string; foundryProjectId?: string; lastDeployedAt?: string;
  [k: string]: unknown;
}

interface DeployResponse {
  ok: boolean;
  deferred?: boolean;
  agentId?: string;
  projectId?: string;
  lastDeployedAt?: string;
  error?: string;
  hint?: string;
}

export function OperationsAgentEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const { state, setState, loading, saving, error, savedAt, save, reload } = useItemState<AgentState>('operations-agent', id, {
    systemPrompt: 'You monitor real-time operational signals and trigger actions when thresholds are breached.',
    model: 'gpt-4o', tools: 'eventhouse-query, activator-trigger', eventhouse: '', ontology: '',
  });
  const [deploying, setDeploying] = useState(false);
  const [deployResult, setDeployResult] = useState<DeployResponse | null>(null);

  const onDeploy = useCallback(async () => {
    setDeploying(true); setDeployResult(null);
    try {
      // Save first so the BFF reads the latest state from Cosmos.
      const saved = await save();
      if (!saved) {
        setDeployResult({ ok: false, error: 'Save failed before deploy — fix the save error and retry.' });
        return;
      }
      const r = await fetch(`/api/items/operations-agent/${encodeURIComponent(id)}/deploy`, { method: 'POST' });
      const j: DeployResponse = await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
      setDeployResult(j);
      if (j.ok) await reload();
    } catch (e: any) {
      setDeployResult({ ok: false, error: e?.message || String(e) });
    } finally {
      setDeploying(false);
    }
  }, [id, save, reload]);

  const deployedAgentId = state.foundryAgentId;
  const deployedAt = state.lastDeployedAt;

  return (
    <ItemEditorChrome item={item} id={id} ribbon={OPS_RIBBON} main={
      <div className={s.pad}>
        {loading && <Spinner size="small" label="Loading…" labelPosition="after" />}
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Phase 1: Foundry Agent deploy stub</MessageBarTitle>
            Agent config persists to Cosmos and the <strong>Deploy to Foundry</strong> button pushes a prompt-agent definition (instructions + model + tools) to the Azure AI Foundry Agent Service. Playbook generation, 5-minute polling, Activator + Power Automate handshake, and Teams notifications are tracked in <code>docs/fiab/operations-agent-parity-spec.md</code> for follow-up sessions.
          </MessageBarBody>
        </MessageBar>
        {deployedAgentId && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <Caption1>Deployed agent:</Caption1>
            <Badge appearance="filled" color="success">{deployedAgentId}</Badge>
            {state.foundryProjectId && <Badge appearance="outline">project {state.foundryProjectId}</Badge>}
            {deployedAt && <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>last deployed {new Date(deployedAt).toLocaleString()}</Caption1>}
          </div>
        )}
        <Caption1>System prompt</Caption1>
        <Textarea value={state.systemPrompt} onChange={(_, d) => setState({ ...state, systemPrompt: d.value })} rows={6} />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div><Caption1>Model</Caption1><Input value={state.model} onChange={(_, d) => setState({ ...state, model: d.value })} /></div>
          <div><Caption1>Tools (comma)</Caption1><Input value={state.tools} onChange={(_, d) => setState({ ...state, tools: d.value })} /></div>
          <div><Caption1>Eventhouse binding</Caption1><Input value={state.eventhouse} onChange={(_, d) => setState({ ...state, eventhouse: d.value })} placeholder="eventhouse item id" /></div>
          <div><Caption1>Ontology binding</Caption1><Input value={state.ontology} onChange={(_, d) => setState({ ...state, ontology: d.value })} placeholder="ontology item id" /></div>
        </div>
        {deployResult && (
          <MessageBar intent={deployResult.ok ? 'success' : deployResult.deferred ? 'warning' : 'error'}>
            <MessageBarBody>
              <MessageBarTitle>
                {deployResult.ok ? 'Deployed to Foundry'
                  : deployResult.deferred ? 'Deploy deferred — Foundry not configured'
                  : 'Deploy failed'}
              </MessageBarTitle>
              {deployResult.ok && deployResult.agentId && (
                <>Agent <code>{deployResult.agentId}</code> upserted in project <code>{deployResult.projectId}</code>. The Foundry Agent Service is now the source of truth for runtime behavior.</>
              )}
              {deployResult.error && <div>{deployResult.error}</div>}
              {deployResult.hint && <div style={{ marginTop: 4 }}><em>Hint:</em> {deployResult.hint}</div>}
            </MessageBarBody>
          </MessageBar>
        )}
        <SaveBar
          saving={saving} savedAt={savedAt} error={error} onSave={() => save()}
          extraRight={
            <Button appearance="primary" onClick={onDeploy} disabled={deploying || saving}>
              {deploying ? 'Deploying…' : 'Deploy to Foundry'}
            </Button>
          }
        />
      </div>
    } />
  );
}

// ----- Data Agent (Cosmos config + Phase 1 Foundry deploy stub) -----
const DA_RIBBON: RibbonTab[] = [{ id: 'home', label: 'Home', groups: [
  { label: 'Sources', actions: [{ label: 'Save' }, { label: 'Deploy to Foundry' }] },
  { label: 'Test', actions: [{ label: 'Chat preview' }] },
]}];
interface DataAgentState {
  systemPrompt: string; model: string; sources: string;
  sqlEndpoints: string; kqlDatabases: string; lakehousePaths: string; examples: string;
  foundryAgentId?: string; foundryProjectId?: string; lastDeployedAt?: string;
  [k: string]: unknown;
}
export function DataAgentEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const { state, setState, loading, saving, error, savedAt, save, reload } = useItemState<DataAgentState>('data-agent', id, {
    systemPrompt: 'You are a finance analyst. Always use dim_date and roll metrics by quarter unless asked otherwise.',
    model: 'gpt-4o',
    sources: 'fin-warehouse, orders semantic model, ldn-gold-lakehouse, ontology-finance',
    sqlEndpoints: '', kqlDatabases: '', lakehousePaths: '',
    examples: 'Top 10 customers by revenue last quarter\nMonthly recurring revenue trend\nForecast next quarter',
  });
  const [deploying, setDeploying] = useState(false);
  const [deployResult, setDeployResult] = useState<DeployResponse | null>(null);

  const onDeploy = useCallback(async () => {
    setDeploying(true); setDeployResult(null);
    try {
      const saved = await save();
      if (!saved) {
        setDeployResult({ ok: false, error: 'Save failed before deploy — fix the save error and retry.' });
        return;
      }
      const r = await fetch(`/api/items/data-agent/${encodeURIComponent(id)}/deploy`, { method: 'POST' });
      const j: DeployResponse = await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
      setDeployResult(j);
      if (j.ok) await reload();
    } catch (e: any) {
      setDeployResult({ ok: false, error: e?.message || String(e) });
    } finally {
      setDeploying(false);
    }
  }, [id, save, reload]);

  const deployedAgentId = state.foundryAgentId;
  const deployedAt = state.lastDeployedAt;

  return (
    <ItemEditorChrome item={item} id={id} ribbon={DA_RIBBON} main={
      <div className={s.pad}>
        {loading && <Spinner size="small" label="Loading…" labelPosition="after" />}
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Phase 1: Foundry Agent deploy stub</MessageBarTitle>
            Data-agent config persists to Cosmos and the <strong>Deploy to Foundry</strong> button pushes a prompt-agent definition to the Azure AI Foundry Agent Service. The typed five-source picker, per-source instructions, test chat pane, Publish flow, and Copilot Studio handoff are tracked in <code>docs/fiab/data-agent-parity-spec.md</code> for follow-up sessions.
          </MessageBarBody>
        </MessageBar>
        {deployedAgentId && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <Caption1>Deployed agent:</Caption1>
            <Badge appearance="filled" color="success">{deployedAgentId}</Badge>
            {state.foundryProjectId && <Badge appearance="outline">project {state.foundryProjectId}</Badge>}
            {deployedAt && <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>last deployed {new Date(deployedAt).toLocaleString()}</Caption1>}
          </div>
        )}
        <Caption1>System prompt / AI instructions</Caption1>
        <Textarea value={state.systemPrompt} onChange={(_, d) => setState({ ...state, systemPrompt: d.value })} rows={5} />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div><Caption1>Model</Caption1><Input value={state.model} onChange={(_, d) => setState({ ...state, model: d.value })} /></div>
          <div><Caption1>Sources (free text)</Caption1><Input value={state.sources} onChange={(_, d) => setState({ ...state, sources: d.value })} /></div>
          <div><Caption1>Synapse Serverless SQL endpoints</Caption1><Input value={state.sqlEndpoints} onChange={(_, d) => setState({ ...state, sqlEndpoints: d.value })} placeholder="serverless-sql-pool name" /></div>
          <div><Caption1>KQL databases</Caption1><Input value={state.kqlDatabases} onChange={(_, d) => setState({ ...state, kqlDatabases: d.value })} placeholder="loomdb-default" /></div>
          <div style={{ gridColumn: 'span 2' }}>
            <Caption1>Lakehouse paths (abfss://...)</Caption1>
            <Textarea value={state.lakehousePaths} onChange={(_, d) => setState({ ...state, lakehousePaths: d.value })} rows={3} />
          </div>
        </div>
        <Caption1>Example queries (one per line)</Caption1>
        <Textarea value={state.examples} onChange={(_, d) => setState({ ...state, examples: d.value })} rows={4} />
        {deployResult && (
          <MessageBar intent={deployResult.ok ? 'success' : deployResult.deferred ? 'warning' : 'error'}>
            <MessageBarBody>
              <MessageBarTitle>
                {deployResult.ok ? 'Deployed to Foundry'
                  : deployResult.deferred ? 'Deploy deferred — Foundry not configured'
                  : 'Deploy failed'}
              </MessageBarTitle>
              {deployResult.ok && deployResult.agentId && (
                <>Agent <code>{deployResult.agentId}</code> upserted in project <code>{deployResult.projectId}</code>. The Foundry Agent Service is now the source of truth for runtime behavior.</>
              )}
              {deployResult.error && <div>{deployResult.error}</div>}
              {deployResult.hint && <div style={{ marginTop: 4 }}><em>Hint:</em> {deployResult.hint}</div>}
            </MessageBarBody>
          </MessageBar>
        )}
        <SaveBar
          saving={saving} savedAt={savedAt} error={error} onSave={() => save()}
          extraRight={
            <Button appearance="primary" onClick={onDeploy} disabled={deploying || saving}>
              {deploying ? 'Deploying…' : 'Deploy to Foundry'}
            </Button>
          }
        />
      </div>
    } />
  );
}
