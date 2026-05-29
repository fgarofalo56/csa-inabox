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

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Subtitle2, Body1, Caption1, Badge, Button, Input, Textarea, Spinner,
  Tab, TabList,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  Tree, TreeItem, TreeItemLayout,
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  Field, Dropdown, Option,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { ItemEditorChrome } from './item-editor-chrome';
import { NewItemBrowseGate } from './new-item-gate';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';
import { MonacoTextarea } from '@/lib/components/editor/monaco-textarea';
import { ComputePicker } from '@/lib/components/compute-picker';
// Pure-logic helpers extracted for vitest coverage. See
// `lib/editors/__tests__/family-utils.test.ts`.
import {
  validateVarValue,
  parseOntologyHierarchy,
  computeGeoBbox,
  bboxToZoom,
  type VarType,
} from './_family-utils';

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
  const isNew = id === 'new' || !id;
  // Read-only registry: models are authored in Azure ML. On /new, browse the
  // real registry (GET /api/items/ml-model) and Open one — no fake create.
  if (isNew) {
    return (
      <NewItemBrowseGate
        item={item}
        endpoint="/api/items/ml-model"
        listKey="models"
        openSlug="ml-model"
        studioUrl="https://ml.azure.com/model/list"
        studioLabel="Open Azure ML Studio"
        intro="ML models are registered in Azure Machine Learning (via training jobs / MLflow), not authored in Loom. Select a registered model below and Open it to view its versions, lineage, and apply/endpoint actions."
        gateHint="No models found — register one by running a job in ml-experiment or Azure ML Studio. If this errors, set LOOM_AML_WORKSPACE / LOOM_FOUNDRY_* and grant the Console UAMI the AzureML Data Scientist role."
        mapEntity={(m: ModelSummary) => ({
          id: m.name,
          name: m.name,
          detail: m.description,
          badge: m.latestVersion ? `latest v${m.latestVersion}` : undefined,
        })}
      />
    );
  }
  return <MlModelEditorBody item={item} id={id} />;
}

function MlModelEditorBody({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const isNew = false;
  const [loading, setLoading] = useState(!isNew);
  const [error, setError] = useState<string | null>(null);
  const [model, setModel] = useState<ModelSummary | null>(null);
  const [versions, setVersions] = useState<ModelVersion[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  // Compute target for Apply (PREDICT) — wired even though the Apply BFF
  // route is deferred to v2.x; at least the user can select compute now and
  // see lifecycle state instead of staring at a dead button with no context.
  const [computeId, setComputeId] = useState('');

  const load = useCallback(async () => {
    if (isNew) return;
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
  }, [id, isNew]);
  useEffect(() => { load(); }, [load]);

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Versions', actions: [
        { label: loading ? 'Reloading…' : 'Reload', onClick: loading ? undefined : load, disabled: loading },
        { label: 'Compare versions', disabled: true, title: 'needs compute target + BFF route (deferred)' },
      ]},
      { label: 'Apply', actions: [
        { label: 'Apply (PREDICT)', disabled: true, title: 'needs compute target + BFF route (deferred)' },
        { label: 'Real-time endpoint', disabled: true, title: 'needs compute target + BFF route (deferred)' },
      ]},
    ]},
  ], [loading, load]);

  const current = versions.find((v) => v.version === selected) || versions[0];

  return (
    <ItemEditorChrome
      item={item}
      id={id}
      ribbon={ribbon}
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
              {/*
               * Compute target for Apply (PREDICT). The Apply BFF is deferred
               * but exposing the picker now lets users pre-select compute and
               * see its state (Resume a paused Databricks cluster, etc.) so
               * v2.x's Apply wiring is one click away from working.
               */}
              <ComputePicker
                label="Predict compute"
                filter={['synapse-spark', 'databricks-cluster']}
                value={computeId}
                onChange={setComputeId}
              />
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

interface FoundryJob {
  id: string; name: string; displayName?: string; jobType?: string;
  experimentName?: string; status?: string; startTimeUtc?: string; endTimeUtc?: string;
  computeId?: string; description?: string;
  tags?: Record<string, string>; properties?: Record<string, string>;
}

export function MlExperimentEditor({ item, id }: { item: FabricItemType; id: string }) {
  const isNew = id === 'new' || !id;
  // Read-only: experiments/runs are submitted via Azure ML / MLflow. On /new,
  // browse the real experiment rollup (GET /api/items/ml-experiment) and Open
  // one to view its runs and metrics.
  if (isNew) {
    return (
      <NewItemBrowseGate
        item={item}
        endpoint="/api/items/ml-experiment"
        listKey="experiments"
        openSlug="ml-experiment"
        studioUrl="https://ml.azure.com/experiments"
        studioLabel="Open Azure ML Studio"
        intro="ML experiments group MLflow runs submitted from notebooks or Azure ML. Select an experiment below and Open it to view its runs, metrics, and register-model action."
        gateHint="No experiments found — submit a run via mlflow.start_run() in a notebook. If this errors, set LOOM_AML_WORKSPACE / LOOM_FOUNDRY_* and grant the Console UAMI the AzureML Data Scientist role."
        mapEntity={(e: { name: string; runCount: number }) => ({
          id: e.name,
          name: e.name,
          badge: `${e.runCount} run${e.runCount === 1 ? '' : 's'}`,
        })}
      />
    );
  }
  return <MlExperimentEditorBody item={item} id={id} />;
}

function MlExperimentEditorBody({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const isNew = false;
  const [loading, setLoading] = useState(!isNew);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<'job' | 'experiment' | null>(null);
  const [job, setJob] = useState<FoundryJob | null>(null);
  const [runs, setRuns] = useState<FoundryJob[]>([]);
  const [expName, setExpName] = useState<string>('');
  const [selectedRun, setSelectedRun] = useState<string | null>(null);
  // Compute target for hypothetical "submit new run" / Register-model flow;
  // wired even though the submit BFF is deferred so the lifecycle UI is
  // surfaced now (resume paused Databricks before submitting from a notebook).
  const [computeId, setComputeId] = useState('');

  const load = useCallback(async () => {
    if (isNew) return;
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
  }, [id, isNew]);
  useEffect(() => { load(); }, [load]);

  const current = runs.find((r) => r.name === selectedRun) || runs[0] || job;

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Runs', actions: [
        { label: loading ? 'Reloading…' : 'Reload', onClick: loading ? undefined : load, disabled: loading },
        { label: 'Register model', disabled: true, title: 'needs MLflow registry write + BFF route (deferred)' },
      ]},
      { label: 'Charts', actions: [
        { label: 'Parallel coordinates', disabled: true, title: 'chart renderer deferred to v2.x' },
        { label: 'Scatter', disabled: true, title: 'chart renderer deferred to v2.x' },
      ]},
    ]},
  ], [loading, load]);

  return (
    <ItemEditorChrome
      item={item}
      id={id}
      ribbon={ribbon}
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
          {!loading && !error && (kind === 'experiment' || kind === 'job') && (
            // Picker for future "submit new run" — exposes Spark / Databricks
            // lifecycle so users can resume a paused cluster ahead of time.
            <ComputePicker
              label="Submission compute"
              filter={['synapse-spark', 'databricks-cluster']}
              value={computeId}
              onChange={setComputeId}
            />
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
  const [state, setStateRaw] = useState<T>(fallback);
  // Phase 4.5 — dirty flag: any external setState call (typing, button click,
  // patch/etc.) flips this true. load() / save() reset it false. SaveBar +
  // Ctrl+S handler read it to gate behavior.
  const [dirty, setDirty] = useState(false);
  // Suppress dirty when load() applies server state.
  const suppressDirty = useRef(false);

  const setState = useCallback<typeof setStateRaw>((updater) => {
    setStateRaw(updater as any);
    if (!suppressDirty.current) setDirty(true);
  }, []);

  const load = useCallback(async () => {
    // Pre-save gate: /items/<type>/new fires useItemState before any Cosmos
    // record exists. Skip the fetch so the editor renders its `fallback`
    // initial state until the user saves and we have a real id.
    if (!id || id === 'new') {
      setLoading(false);
      return;
    }
    setLoading(true); setError(null);
    try {
      const r = await fetch(`/api/items/${slug}/${encodeURIComponent(id)}`);
      const j = await r.json();
      if (!r.ok) { setError(j?.error || `HTTP ${r.status}`); return; }
      const doc = j as ItemDoc;
      if (doc.state && typeof doc.state === 'object') {
        suppressDirty.current = true;
        setStateRaw({ ...fallback, ...(doc.state as T) });
        setDirty(false);
        // Release the suppression on next tick so user-triggered setState
        // calls after this load() correctly mark dirty.
        queueMicrotask(() => { suppressDirty.current = false; });
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
      // Phase 4.5: explicit save success → no longer dirty. When called
      // programmatically with a `next` arg (publish-then-save, materialize-
      // then-save, deploy-then-save), also clear dirty — the next arg IS
      // the snapshot we just persisted.
      setDirty(false);
      return true;
    } catch (e: any) { setError(e?.message || String(e)); return false; }
    finally { setSaving(false); }
  }, [slug, id, state]);

  // Phase 4.5 — Ctrl+S / Cmd+S shortcut.
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

  return { state, setState, loading, saving, error, savedAt, save, reload: load, dirty };
}

function SaveBar({ saving, savedAt, error, onSave, extraRight, dirty }: {
  saving: boolean; savedAt: string | null; error: string | null;
  onSave: () => void; extraRight?: ReactNode;
  // Phase 4.5 — when provided, gates Save button + shows "unsaved" badge.
  dirty?: boolean;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 0', borderTop: `1px solid ${tokens.colorNeutralStroke2}` }}>
      <Button appearance="primary" onClick={onSave} disabled={saving || dirty === false}>
        {saving ? 'Saving…' : dirty === false ? 'Saved' : 'Save (Ctrl+S)'}
      </Button>
      {dirty && <Badge appearance="outline" color="warning">unsaved</Badge>}
      {savedAt && !saving && <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Saved {new Date(savedAt).toLocaleTimeString()}</Caption1>}
      {error && <Caption1 style={{ color: tokens.colorPaletteRedForeground1 }}>{error}</Caption1>}
      <div style={{ flex: 1 }} />
      {extraRight}
    </div>
  );
}

// ----- GraphQL API (Cosmos state + real APIM publish) -----
const GQL_SAMPLE = `type Query {\n  customers(region: String, first: Int = 10): [Customer!]!\n}\ntype Customer { id: ID! name: String! orders: [Order!]! }\ntype Order { id: ID! total: Float! }`;
interface GqlState { displayName: string; path: string; serviceUrl: string; sdl: string; description: string; subscriptionRequired: boolean; lastPublishedAt?: string; lastPublishedTo?: string; [k: string]: unknown }
export function GraphqlApiEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const { state, setState, loading, saving, error, savedAt, save, reload, dirty } = useItemState<GqlState>('graphql-api', id, {
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
      // v3.28 Phase 4.5: functional setState so SDL/path edits made WHILE the
      // publish POST is in flight aren't reset by the old `state` snapshot.
      let merged: GqlState | null = null;
      setState((prev) => {
        merged = { ...prev, lastPublishedAt: new Date().toISOString(), lastPublishedTo: j.api?.id || id };
        return merged;
      });
      if (merged) await save(merged);
      setPublishMsg({ intent: 'success', text: `Published to APIM as ${j.api?.name || id}` });
    } catch (e: any) { setPublishMsg({ intent: 'error', text: e?.message || String(e) }); }
    finally { setPublishing(false); }
  }, [id, item.displayName, state, save, setState]);

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Schema', actions: [
        { label: 'Reload', onClick: reload },
        { label: publishing ? 'Publishing…' : 'Publish to APIM', onClick: publish, disabled: publishing || saving },
      ]},
      { label: 'Auth', actions: [
        { label: 'Subscription required', disabled: true, title: 'authoring of subscription requirements via UI deferred — toggle persists from form below' },
      ]},
    ]},
  ], [reload, publish, publishing, saving]);

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon} main={
      <div className={s.pad}>
        {loading && <Spinner size="small" label="Loading…" labelPosition="after" />}
        <Subtitle2>API configuration</Subtitle2>
        {/* v3.28 Phase 4.5: functional setState so publish-to-APIM (which calls
            setState(next) after the request) doesn't clobber concurrent typing. */}
        <Caption1>Display name</Caption1>
        <Input value={state.displayName} onChange={(_, d) => setState((p) => ({ ...p, displayName: d.value }))} placeholder={item.displayName || id} />
        <Caption1>URL path suffix (under APIM gateway)</Caption1>
        <Input value={state.path} onChange={(_, d) => setState((p) => ({ ...p, path: d.value }))} placeholder={id} />
        <Caption1>Backend service URL (optional resolver target)</Caption1>
        <Input value={state.serviceUrl} onChange={(_, d) => setState((p) => ({ ...p, serviceUrl: d.value }))} placeholder="https://backend.example.com/graphql" />
        <Caption1>Description</Caption1>
        <Input value={state.description} onChange={(_, d) => setState((p) => ({ ...p, description: d.value }))} />
        <Subtitle2 style={{ marginTop: 8 }}>Schema (SDL)</Subtitle2>
        <MonacoTextarea value={state.sdl} onChange={(v) => setState((p) => ({ ...p, sdl: v }))} language="graphql" height={300} minHeight={240} ariaLabel="GraphQL SDL" />
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
          saving={saving} savedAt={savedAt} error={error} dirty={dirty} onSave={() => save()}
          extraRight={<Button onClick={publish} disabled={publishing || saving}>{publishing ? 'Publishing…' : 'Publish to APIM'}</Button>}
        />
      </div>
    } />
  );
}

// ----- User Data Function (Cosmos code+config; deploy is config-only in v2.1) -----
const UDF_SAMPLE = `import fabric.functions as fn\nudf = fn.UserDataFunctions()\n\n@udf.function()\ndef compute_score(user_id: str, weight: float = 1.0) -> dict:\n    return {"user": user_id, "score": weight * 42}`;
interface UdfState { runtime: 'python' | 'node' | 'dotnet'; entrypoint: string; source: string; functionAppName: string; connections: string; [k: string]: unknown }

interface FunctionAppDTO {
  id: string; name: string; location?: string; kind?: string;
  state?: string; defaultHostName?: string; resourceGroup?: string;
}

function useFunctionApps() {
  const [functionApps, setFunctionApps] = useState<FunctionAppDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch('/api/azure/function-apps');
        const j = await r.json();
        if (!j.ok) { setError(j.error || `HTTP ${r.status}`); setHint(j.hint || null); setFunctionApps([]); }
        else { setFunctionApps(j.functionApps || []); }
      } catch (e: any) {
        setError(e?.message || String(e));
        setFunctionApps([]);
      } finally { setLoading(false); }
    })();
  }, []);
  return { functionApps, error, hint, loading };
}

export function UserDataFunctionEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const { state, setState, loading, saving, error, savedAt, save, reload, dirty } = useItemState<UdfState>('user-data-function', id, {
    runtime: 'python', entrypoint: 'compute_score', source: UDF_SAMPLE, functionAppName: '', connections: '',
  });
  const fnApps = useFunctionApps();
  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Function', actions: [
        { label: 'Reload', onClick: reload },
        { label: saving ? 'Saving…' : 'Save', onClick: () => save(), disabled: saving || dirty === false },
      ]},
      { label: 'Deploy', actions: [
        { label: 'Deploy to Function App', disabled: true, title: 'v2.x — requires Function App ARM mutation' },
      ]},
    ]},
  ], [reload, save, saving, dirty]);
  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon} main={
      <div className={s.pad}>
        {loading && <Spinner size="small" label="Loading…" labelPosition="after" />}
        <MessageBar intent="info">
          <MessageBarBody>
            <MessageBarTitle>v2.1: code + config persisted</MessageBarTitle>
            Source and metadata save to Cosmos. Deploy-to-Azure-Functions wiring (ARM Microsoft.Web/sites publish) is deferred to v2.x — there is no Function App provisioned in this Loom instance yet.
          </MessageBarBody>
        </MessageBar>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
          {/* v3.28 Phase 4.5: functional setState everywhere. */}
          <div>
            <Caption1>Runtime</Caption1>
            <select value={state.runtime} onChange={(e) => setState((p) => ({ ...p, runtime: e.target.value as UdfState['runtime'] }))}
              style={{ width: '100%', padding: 6, borderRadius: 4, border: `1px solid ${tokens.colorNeutralStroke2}`, background: tokens.colorNeutralBackground1, color: tokens.colorNeutralForeground1 }}>
              <option value="python">python</option>
              <option value="node">node</option>
              <option value="dotnet">dotnet</option>
            </select>
          </div>
          <div>
            <Caption1>Entrypoint</Caption1>
            <Input value={state.entrypoint} onChange={(_, d) => setState((p) => ({ ...p, entrypoint: d.value }))} />
          </div>
          <div>
            <Caption1>Target Function App (deploy)</Caption1>
            <select
              value={state.functionAppName}
              onChange={(e) => setState((p) => ({ ...p, functionAppName: e.target.value }))}
              disabled={fnApps.loading || (fnApps.functionApps?.length ?? 0) === 0}
              title={fnApps.error ? `Function App discovery failed: ${fnApps.error}` : undefined}
              style={{ width: '100%', padding: 6, borderRadius: 4, border: `1px solid ${tokens.colorNeutralStroke2}`, background: tokens.colorNeutralBackground1, color: tokens.colorNeutralForeground1 }}
            >
              {fnApps.loading && <option value="">Loading Function Apps…</option>}
              {!fnApps.loading && (fnApps.functionApps?.length ?? 0) === 0 && (
                <option value="">{fnApps.error ? 'Discovery failed — see hint below' : 'No Function Apps found'}</option>
              )}
              {!fnApps.loading && (fnApps.functionApps?.length ?? 0) > 0 && !state.functionAppName && (
                <option value="">Select a Function App</option>
              )}
              {(fnApps.functionApps || []).map((fa) => (
                <option key={fa.id} value={fa.name}>
                  {fa.name}{fa.location ? ` · ${fa.location}` : ''}{fa.state ? ` · ${fa.state}` : ''}
                </option>
              ))}
            </select>
          </div>
        </div>
        {fnApps.error && (
          <MessageBar intent="warning">
            <MessageBarBody>
              <MessageBarTitle>Function App discovery failed</MessageBarTitle>
              {fnApps.error}
              {fnApps.hint && <><br /><Caption1>{fnApps.hint}</Caption1></>}
            </MessageBarBody>
          </MessageBar>
        )}
        <Subtitle2 style={{ marginTop: 8 }}>function_app source</Subtitle2>
        <MonacoTextarea value={state.source} onChange={(v) => setState((p) => ({ ...p, source: v }))} language="python" height={320} minHeight={240} ariaLabel="Function source" />
        <Caption1>Connections (comma-separated workspace items)</Caption1>
        <Input value={state.connections} onChange={(_, d) => setState((p) => ({ ...p, connections: d.value }))} placeholder="fin-warehouse, ldn-gold-lakehouse" />
        <SaveBar saving={saving} savedAt={savedAt} error={error} dirty={dirty} onSave={() => save()} />
      </div>
    } />
  );
}

// ----- Variable Library (Cosmos, typed key/value with value sets) -----
// v3.27: extended to Fabric's 7 variable types — String/Integer/Number/
// Boolean/DateTime/Guid/ItemReference/ConnectionReference. Plus the
// Loom-native `secret-ref` for KV / env-var lookups.
// `VarType` is imported from `_family-utils` (see the top-of-file
// import block — it matches the vitest contract).
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

// `validateVarValue` is imported from `_family-utils` (see top-of-file
// imports — vitest coverage at `lib/editors/__tests__/family-utils.test.ts`).

export function VariableLibraryEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const { state, setState, loading, saving, error, savedAt, save, dirty } = useItemState<VlState>('variable-library', id, {
    variables: [
      { name: 'ENV', type: 'string', default: 'dev' },
      { name: 'BatchSize', type: 'number', default: '5000' },
      { name: 'EnableCopilot', type: 'bool', default: 'true' },
    ],
  });
  const [tab, setTab] = useState<typeof VL_VALUE_SETS[number]>('default');
  // v3.28 Phase 4.5: functional setState so concurrent edits + the auto-reload
  // from useItemState's PATCH response don't clobber rapid typing.
  const update = (idx: number, patch: Partial<VarDef>) => {
    setState((prev) => {
      const next = [...prev.variables];
      next[idx] = { ...next[idx], ...patch };
      return { ...prev, variables: next };
    });
  };
  const addRow = () => setState((prev) => ({
    ...prev,
    variables: [...prev.variables, { name: `var${prev.variables.length + 1}`, type: 'string', default: '' }],
  }));
  const deleteRow = (idx: number) => setState((prev) => ({
    ...prev,
    variables: prev.variables.filter((_, i) => i !== idx),
  }));
  const valueKey = tab === 'default' ? 'default' : tab;

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Variables', actions: [
        { label: 'New variable', onClick: addRow },
        { label: saving ? 'Saving…' : 'Save', onClick: () => save(), disabled: saving || dirty === false },
      ]},
      { label: 'Value sets', actions: [
        { label: 'dev', onClick: () => setTab('dev'), appearance: tab === 'dev' ? 'primary' : 'subtle' },
        { label: 'test', onClick: () => setTab('test'), appearance: tab === 'test' ? 'primary' : 'subtle' },
        { label: 'prod', onClick: () => setTab('prod'), appearance: tab === 'prod' ? 'primary' : 'subtle' },
      ]},
    ]},
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [save, saving, dirty, tab, addRow]);

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon} main={
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
          <SaveBar saving={saving} savedAt={savedAt} error={error} dirty={dirty} onSave={() => save()} />
        </div>
      </>
    } />
  );
}

// ----- Ontology (text-stored OWL/RDF; class tree parsed client-side) -----
const ONTO_SAMPLE = `# Turtle-ish — define entity types and a parent hierarchy.\n# Each line: "ClassName : ParentClass  -- description"\nThing :  -- root\nParty : Thing -- person or org\nCustomer : Party -- buying party\nVendor : Party -- selling party\nOrder : Thing -- transaction record\nFlight : Thing -- aviation event\n`;
interface OntoState { source: string; [k: string]: unknown }

// `parseOntologyHierarchy` is imported from `_family-utils` (vitest coverage
// at `lib/editors/__tests__/family-utils.test.ts`).

export function OntologyEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const { state, setState, loading, saving, error, savedAt, save, dirty } = useItemState<OntoState>('ontology', id, { source: ONTO_SAMPLE });
  const classes = parseOntologyHierarchy(state.source || '');
  const [materializing, setMaterializing] = useState(false);
  const [matMsg, setMatMsg] = useState<string | null>(null);

  // Add entity / Add relationship dialogs. Both append a line to the ontology
  // DSL (`Name : Parent -- description`) and persist via useItemState.save().
  const [entityDlgOpen, setEntityDlgOpen] = useState(false);
  const [relDlgOpen, setRelDlgOpen] = useState(false);
  const [entName, setEntName] = useState('');
  const [entParent, setEntParent] = useState('');
  const [entDesc, setEntDesc] = useState('');
  const [relChild, setRelChild] = useState('');
  const [relParent, setRelParent] = useState('');
  const [dlgErr, setDlgErr] = useState<string | null>(null);

  const openEntityDlg = () => { setEntName(''); setEntParent(''); setEntDesc(''); setDlgErr(null); setEntityDlgOpen(true); };
  const openRelDlg = () => { setRelChild(''); setRelParent(''); setDlgErr(null); setRelDlgOpen(true); };

  // Persist eagerly for existing items; for /new the Cosmos row doesn't exist
  // yet so save() would 404 — the user persists with the Save button instead.
  const persistOnto = useCallback((next: OntoState) => {
    setState(() => next);
    if (id && id !== 'new') save(next);
  }, [id, setState, save]);

  const appendSource = useCallback((line: string) => {
    persistOnto({ ...state, source: `${(state.source || '').replace(/\s*$/, '')}\n${line}\n` });
  }, [state, persistOnto]);

  const addEntity = useCallback(() => {
    const name = entName.trim();
    if (!/^[A-Za-z_][\w]*$/.test(name)) { setDlgErr('Entity name must start with a letter/underscore (letters, digits, _).'); return; }
    if (classes.some((c) => c.name === name)) { setDlgErr(`Entity "${name}" already exists.`); return; }
    const parent = entParent.trim();
    const desc = entDesc.trim();
    appendSource(`${name} : ${parent} ${desc ? `-- ${desc}` : ''}`.trimEnd());
    setEntityDlgOpen(false);
  }, [entName, entParent, entDesc, classes, appendSource]);

  const addRelationship = useCallback(() => {
    const child = relChild.trim();
    const parent = relParent.trim();
    if (!child || !parent) { setDlgErr('Pick both a child and a parent entity.'); return; }
    if (child === parent) { setDlgErr('Child and parent must differ.'); return; }
    // IS_A is the `Child : Parent` edge in the DSL. Rewrite the child's
    // existing line (keeping any description) so we set the parent in place
    // rather than appending a duplicate class definition.
    const lineRe = new RegExp(`^(\\s*)${child}(\\s*:)[^\\n]*$`, 'm');
    let nextSource: string;
    if (lineRe.test(state.source || '')) {
      nextSource = (state.source || '').replace(lineRe, (_m, indent: string) => {
        const existing = classes.find((c) => c.name === child);
        const desc = existing?.description ? ` -- ${existing.description}` : '';
        return `${indent}${child} : ${parent}${desc}`;
      });
    } else {
      nextSource = `${(state.source || '').replace(/\s*$/, '')}\n${child} : ${parent} -- is_a\n`;
    }
    persistOnto({ ...state, source: nextSource });
    setRelDlgOpen(false);
  }, [relChild, relParent, classes, state, persistOnto]);

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
          displayName: `${item.displayName || 'Ontology'} graph (from ontology ${id})`,
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
  }, [classes, id, item.displayName]);

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Author', actions: [
        { label: 'Add entity', onClick: openEntityDlg, disabled: saving, title: 'Add an ontology class' },
        { label: 'Add relationship', onClick: openRelDlg, disabled: saving || classes.length < 1, title: classes.length < 1 ? 'Add at least one entity first' : 'Add an IS_A relationship between two classes' },
      ]},
      { label: 'Bind', actions: [
        { label: saving ? 'Saving…' : 'Save', onClick: () => save(), disabled: saving || dirty === false },
        { label: materializing ? 'Materializing…' : 'Materialize', onClick: materializeToGraphModel, disabled: materializing || classes.length === 0 },
      ]},
    ]},
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [save, saving, dirty, materializeToGraphModel, materializing, classes.length]);

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon} main={
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
            {/* v3.28 Phase 4.5: functional setState — materializeToGraphModel
                does NOT write back to state, so this is defensive but cheap. */}
            <MonacoTextarea value={state.source} onChange={(v) => setState((p) => ({ ...p, source: v }))} language="json" height={400} minHeight={320} ariaLabel="Ontology source" />
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
        <SaveBar saving={saving} savedAt={savedAt} error={error} dirty={dirty} onSave={() => save()} />

        <Dialog open={entityDlgOpen} onOpenChange={(_, d) => setEntityDlgOpen(d.open)}>
          <DialogSurface>
            <DialogBody>
              <DialogTitle>Add entity (ontology class)</DialogTitle>
              <DialogContent>
                <Field label="Class name" required>
                  <Input value={entName} onChange={(_, d) => setEntName(d.value)} placeholder="Invoice" />
                </Field>
                <Field label="Parent class (optional)">
                  <Dropdown value={entParent} selectedOptions={entParent ? [entParent] : []} onOptionSelect={(_, d) => setEntParent(d.optionValue || '')} placeholder="(none — root)">
                    <Option value="">(none — root)</Option>
                    {classes.map((c) => <Option key={c.name} value={c.name}>{c.name}</Option>)}
                  </Dropdown>
                </Field>
                <Field label="Description (optional)">
                  <Input value={entDesc} onChange={(_, d) => setEntDesc(d.value)} placeholder="billing document" />
                </Field>
                {dlgErr && <MessageBar intent="error"><MessageBarBody>{dlgErr}</MessageBarBody></MessageBar>}
              </DialogContent>
              <DialogActions>
                <Button appearance="secondary" onClick={() => setEntityDlgOpen(false)}>Cancel</Button>
                <Button appearance="primary" onClick={addEntity}>Add entity</Button>
              </DialogActions>
            </DialogBody>
          </DialogSurface>
        </Dialog>

        <Dialog open={relDlgOpen} onOpenChange={(_, d) => setRelDlgOpen(d.open)}>
          <DialogSurface>
            <DialogBody>
              <DialogTitle>Add relationship (IS_A)</DialogTitle>
              <DialogContent>
                <Caption1>Sets the parent of one class to another (the IS_A hierarchy this ontology models).</Caption1>
                <Field label="Child class" required>
                  <Dropdown value={relChild} selectedOptions={relChild ? [relChild] : []} onOptionSelect={(_, d) => setRelChild(d.optionValue || '')} placeholder="Select a class">
                    {classes.map((c) => <Option key={c.name} value={c.name}>{c.name}</Option>)}
                  </Dropdown>
                </Field>
                <Field label="Parent class" required>
                  <Dropdown value={relParent} selectedOptions={relParent ? [relParent] : []} onOptionSelect={(_, d) => setRelParent(d.optionValue || '')} placeholder="Select a class">
                    {classes.map((c) => <Option key={c.name} value={c.name}>{c.name}</Option>)}
                  </Dropdown>
                </Field>
                {dlgErr && <MessageBar intent="error"><MessageBarBody>{dlgErr}</MessageBarBody></MessageBar>}
              </DialogContent>
              <DialogActions>
                <Button appearance="secondary" onClick={() => setRelDlgOpen(false)}>Cancel</Button>
                <Button appearance="primary" onClick={addRelationship}>Add relationship</Button>
              </DialogActions>
            </DialogBody>
          </DialogSurface>
        </Dialog>
      </div>
    } />
  );
}

// ----- Graph Model (Cosmos config + real ADX materialize) -----
interface GraphDecl { name: string; properties: { name: string; type: string }[] }
interface GraphState { nodes: GraphDecl[]; edges: GraphDecl[]; database: string; lastMaterializedAt?: string; [k: string]: unknown }

export function GraphModelEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const { state, setState, loading, saving, error, savedAt, save, dirty } = useItemState<GraphState>('graph-model', id, {
    nodes: [{ name: 'Customer', properties: [{ name: 'name', type: 'string' }] }],
    edges: [{ name: 'PLACED', properties: [{ name: 'at', type: 'datetime' }] }],
    database: 'loomdb-default',
  });
  const [materializing, setMaterializing] = useState(false);
  const [matResult, setMatResult] = useState<any>(null);

  // Add entity / Add relationship dialogs — append a typed declaration to
  // state.nodes[] / state.edges[]. The edit flows the dirty flag so SaveBar
  // (and Ctrl+S) persist to Cosmos via useItemState.save().
  const [nodeDlgOpen, setNodeDlgOpen] = useState(false);
  const [edgeDlgOpen, setEdgeDlgOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [propsText, setPropsText] = useState('');
  const [edgeSrc, setEdgeSrc] = useState('');
  const [edgeDst, setEdgeDst] = useState('');
  const [dlgErr, setDlgErr] = useState<string | null>(null);

  // Parse "name:type, name2:type2" → [{name,type}]. Blank → [].
  const parseProps = (txt: string): { name: string; type: string }[] =>
    txt.split(',').map((p) => p.trim()).filter(Boolean).map((p) => {
      const [n, t] = p.split(':').map((x) => x.trim());
      return { name: n, type: (t || 'string') };
    });

  const openNodeDlg = () => { setNewName(''); setPropsText(''); setDlgErr(null); setNodeDlgOpen(true); };
  const openEdgeDlg = () => { setNewName(''); setPropsText(''); setEdgeSrc(''); setEdgeDst(''); setDlgErr(null); setEdgeDlgOpen(true); };

  // Add buttons mutate state + flip dirty; the user persists with Save / Ctrl+S
  // (or Materialize, which saves first). For an already-persisted item we also
  // fire save(next) so the addition lands immediately; for /new items save()
  // would 404 (no Cosmos row yet), so we skip the eager save there.
  const persistIfExisting = (next: GraphState) => {
    setState(() => next);
    if (id && id !== 'new') save(next);
  };

  const addEntity = useCallback(() => {
    const name = newName.trim();
    if (!/^[A-Za-z_][\w]*$/.test(name)) { setDlgErr('Entity name must start with a letter/underscore (letters, digits, _).'); return; }
    if (state.nodes.some((n) => n.name === name)) { setDlgErr(`Entity "${name}" already exists.`); return; }
    persistIfExisting({ ...state, nodes: [...state.nodes, { name, properties: parseProps(propsText) }] });
    setNodeDlgOpen(false);
  }, [newName, propsText, state, id, setState, save]);

  const addRelationship = useCallback(() => {
    const name = newName.trim();
    if (!/^[A-Za-z_][\w]*$/.test(name)) { setDlgErr('Relationship name must start with a letter/underscore (letters, digits, _).'); return; }
    if (state.edges.some((e) => e.name === name)) { setDlgErr(`Relationship "${name}" already exists.`); return; }
    const props = parseProps(propsText);
    // src/dst node types captured as edge properties so the materialize step +
    // queries can reference the connected node types.
    if (edgeSrc.trim()) props.unshift({ name: 'srcType', type: 'string' });
    if (edgeDst.trim()) props.unshift({ name: 'dstType', type: 'string' });
    persistIfExisting({ ...state, edges: [...state.edges, { name, properties: props }] });
    setEdgeDlgOpen(false);
  }, [newName, propsText, edgeSrc, edgeDst, state, id, setState, save]);

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
        // v3.28 Phase 4.5: stale-closure fix. Previously `next = { ...state, ... }`
        // captured `state` at click-time and clobbered any typing that happened
        // during the in-flight POST. Use functional setState + capture the merged
        // result for the immediate save() call so what we PATCH matches what
        // the user sees.
        let merged: GraphState | null = null;
        setState((prev) => {
          merged = { ...prev, lastMaterializedAt: new Date().toISOString() };
          return merged;
        });
        if (merged) await save(merged);
      }
    } catch (e: any) { setMatResult({ ok: false, error: e?.message || String(e) }); }
    finally { setMaterializing(false); }
  }, [id, save, setState]);

  const editJson = (key: 'nodes' | 'edges', text: string) => {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) setState((p) => ({ ...p, [key]: parsed }));
    } catch { /* leave previous */ }
  };

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Author', actions: [
        { label: 'Add entity', onClick: openNodeDlg, disabled: saving, title: 'Add a node type to the graph model' },
        { label: 'Add relationship', onClick: openEdgeDlg, disabled: saving, title: 'Add an edge type connecting node types' },
      ]},
      { label: 'Bind', actions: [
        { label: saving ? 'Saving…' : 'Save', onClick: () => save(), disabled: saving || dirty === false },
        { label: materializing ? 'Materializing…' : 'Materialize', onClick: materialize, disabled: materializing || saving },
      ]},
    ]},
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [save, saving, dirty, materialize, materializing]);

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon} main={
      <div className={s.pad}>
        {loading && <Spinner size="small" label="Loading…" labelPosition="after" />}
        <Caption1>Target ADX database</Caption1>
        <Input value={state.database} onChange={(_, d) => setState((p) => ({ ...p, database: d.value }))} />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div>
            <Subtitle2>Node types</Subtitle2>
            <MonacoTextarea value={JSON.stringify(state.nodes, null, 2)} onChange={(v) => editJson('nodes', v)} language="json" height={260} minHeight={200} ariaLabel="Node types JSON" />
          </div>
          <div>
            <Subtitle2>Edge types</Subtitle2>
            <MonacoTextarea value={JSON.stringify(state.edges, null, 2)} onChange={(v) => editJson('edges', v)} language="json" height={260} minHeight={200} ariaLabel="Edge types JSON" />
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
          saving={saving} savedAt={savedAt} error={error} dirty={dirty} onSave={() => save()}
          extraRight={<Button onClick={materialize} disabled={materializing || saving}>{materializing ? 'Materializing…' : 'Materialize to ADX'}</Button>}
        />

        <Dialog open={nodeDlgOpen} onOpenChange={(_, d) => setNodeDlgOpen(d.open)}>
          <DialogSurface>
            <DialogBody>
              <DialogTitle>Add entity (node type)</DialogTitle>
              <DialogContent>
                <Field label="Entity name" required>
                  <Input value={newName} onChange={(_, d) => setNewName(d.value)} placeholder="Customer" />
                </Field>
                <Field label="Properties (name:type, comma-separated)" hint="e.g. name:string, age:int, joined:datetime. An id:string column is always added at materialize.">
                  <Input value={propsText} onChange={(_, d) => setPropsText(d.value)} placeholder="name:string, region:string" />
                </Field>
                {dlgErr && <MessageBar intent="error"><MessageBarBody>{dlgErr}</MessageBarBody></MessageBar>}
              </DialogContent>
              <DialogActions>
                <Button appearance="secondary" onClick={() => setNodeDlgOpen(false)}>Cancel</Button>
                <Button appearance="primary" onClick={addEntity}>Add entity</Button>
              </DialogActions>
            </DialogBody>
          </DialogSurface>
        </Dialog>

        <Dialog open={edgeDlgOpen} onOpenChange={(_, d) => setEdgeDlgOpen(d.open)}>
          <DialogSurface>
            <DialogBody>
              <DialogTitle>Add relationship (edge type)</DialogTitle>
              <DialogContent>
                <Field label="Relationship name" required>
                  <Input value={newName} onChange={(_, d) => setNewName(d.value)} placeholder="PLACED" />
                </Field>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <Field label="From entity">
                    <Dropdown value={edgeSrc} selectedOptions={edgeSrc ? [edgeSrc] : []} onOptionSelect={(_, d) => setEdgeSrc(d.optionValue || '')} placeholder="(optional)">
                      {state.nodes.map((n) => <Option key={n.name} value={n.name}>{n.name}</Option>)}
                    </Dropdown>
                  </Field>
                  <Field label="To entity">
                    <Dropdown value={edgeDst} selectedOptions={edgeDst ? [edgeDst] : []} onOptionSelect={(_, d) => setEdgeDst(d.optionValue || '')} placeholder="(optional)">
                      {state.nodes.map((n) => <Option key={n.name} value={n.name}>{n.name}</Option>)}
                    </Dropdown>
                  </Field>
                </div>
                <Field label="Properties (name:type, comma-separated)" hint="src:string and dst:string columns are always added at materialize.">
                  <Input value={propsText} onChange={(_, d) => setPropsText(d.value)} placeholder="at:datetime, weight:real" />
                </Field>
                {dlgErr && <MessageBar intent="error"><MessageBarBody>{dlgErr}</MessageBarBody></MessageBar>}
              </DialogContent>
              <DialogActions>
                <Button appearance="secondary" onClick={() => setEdgeDlgOpen(false)}>Cancel</Button>
                <Button appearance="primary" onClick={addRelationship}>Add relationship</Button>
              </DialogActions>
            </DialogBody>
          </DialogSurface>
        </Dialog>
      </div>
    } />
  );
}

// ----- Plan (Cosmos task list) -----
interface PlanTask { title: string; owner: string; due: string; status: 'todo' | 'doing' | 'done'; dependsOn?: string }
interface PlanState { tasks: PlanTask[]; [k: string]: unknown }

export function PlanEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const { state, setState, loading, saving, error, savedAt, save, dirty } = useItemState<PlanState>('plan', id, {
    tasks: [{ title: 'Define semantic model', owner: '', due: '', status: 'todo' }],
  });
  // v3.28 Phase 4.5: functional setState so rapid Update/Add/Delete edits don't
  // clobber each other via the stale `state` captured at click-time.
  const update = (idx: number, patch: Partial<PlanTask>) => {
    setState((prev) => {
      const next = [...prev.tasks];
      next[idx] = { ...next[idx], ...patch };
      return { ...prev, tasks: next };
    });
  };
  const add = () => setState((prev) => ({
    ...prev,
    tasks: [...prev.tasks, { title: '', owner: '', due: '', status: 'todo' }],
  }));
  const remove = (idx: number) => setState((prev) => ({
    ...prev,
    tasks: prev.tasks.filter((_, i) => i !== idx),
  }));

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

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Tasks', actions: [
        { label: 'New task', onClick: add },
        { label: saving ? 'Saving…' : 'Save', onClick: () => save(), disabled: saving || dirty === false },
      ]},
    ]},
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [save, saving, dirty, add]);

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon} main={
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
        <SaveBar saving={saving} savedAt={savedAt} error={error} dirty={dirty} onSave={() => save()} />
      </div>
    } />
  );
}

// ----- Map (Cosmos GeoJSON + JSON preview) -----
const GEO_SAMPLE = `{\n  "type": "FeatureCollection",\n  "features": [\n    { "type": "Feature", "properties": { "name": "Seattle" }, "geometry": { "type": "Point", "coordinates": [-122.33, 47.61] } }\n  ]\n}`;
interface MapState { geojson: string; [k: string]: unknown }

export function MapEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const { state, setState, loading, saving, error, savedAt, save, dirty } = useItemState<MapState>('map', id, { geojson: GEO_SAMPLE });
  const [validateMsg, setValidateMsg] = useState<{ intent: 'success' | 'error'; text: string } | null>(null);
  let parseErr: string | null = null;
  let featureCount = 0;
  // bbox + zoom computed via `_family-utils` (vitest-covered).
  let bbox: { minLon: number; maxLon: number; minLat: number; maxLat: number } | null = null;
  try {
    const j = JSON.parse(state.geojson);
    featureCount = Array.isArray(j?.features) ? j.features.length : 0;
    bbox = computeGeoBbox(j);
  } catch (e: any) { parseErr = e?.message || String(e); }

  // v3.27: D-upgrade — Azure Maps tile preview. Static-map REST API is the
  // simplest no-deps integration: just emit an <img>. Falls back to a
  // MessageBar gate when LOOM_AZURE_MAPS_SUBSCRIPTION_KEY isn't set.
  const mapsKey = process.env.NEXT_PUBLIC_LOOM_AZURE_MAPS_KEY;
  const centerLon = bbox ? (bbox.minLon + bbox.maxLon) / 2 : -122.33;
  const centerLat = bbox ? (bbox.minLat + bbox.maxLat) / 2 : 47.61;
  // Naive zoom heuristic in `_family-utils.bboxToZoom` (vitest-covered).
  const zoom = bboxToZoom(bbox);
  const tileUrl = mapsKey
    ? `https://atlas.microsoft.com/map/static?api-version=2024-04-01&style=main&zoom=${zoom}&center=${centerLon},${centerLat}&width=640&height=320&subscription-key=${mapsKey}`
    : null;

  const runValidate = useCallback(() => {
    try {
      const j = JSON.parse(state.geojson);
      const fc = Array.isArray(j?.features) ? j.features.length : 0;
      setValidateMsg({ intent: 'success', text: `Valid GeoJSON — ${fc} feature(s) parsed.` });
    } catch (e: any) {
      setValidateMsg({ intent: 'error', text: `Invalid JSON: ${e?.message || String(e)}` });
    }
  }, [state.geojson]);

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Layer', actions: [
        { label: saving ? 'Saving…' : 'Save', onClick: () => save(), disabled: saving || dirty === false },
        { label: 'Validate', onClick: runValidate },
      ]},
    ]},
  ], [save, saving, dirty, runValidate]);

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon} main={
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
        <MonacoTextarea value={state.geojson} onChange={(v) => setState((p) => ({ ...p, geojson: v }))} language="json" height={320} minHeight={240} ariaLabel="GeoJSON" />
        {parseErr && <MessageBar intent="error"><MessageBarBody>Invalid JSON: {parseErr}</MessageBarBody></MessageBar>}
        {validateMsg && <MessageBar intent={validateMsg.intent}><MessageBarBody>{validateMsg.text}</MessageBarBody></MessageBar>}
        {tileUrl && (
          <>
            <Subtitle2>Azure Maps preview (zoom {zoom}, center {centerLat.toFixed(3)}, {centerLon.toFixed(3)})</Subtitle2>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={tileUrl} alt="Azure Maps tile preview" style={{ width: '100%', maxWidth: 640, borderRadius: 4, border: `1px solid ${tokens.colorNeutralStroke2}` }} />
            <Caption1>Static-map preview only — features above are NOT rendered as overlays in this snapshot. Use the vector overlay path in v2.x for live layer rendering.</Caption1>
          </>
        )}
        <SaveBar saving={saving} savedAt={savedAt} error={error} dirty={dirty} onSave={() => save()} />
      </div>
    } />
  );
}

// ----- Operations Agent (Cosmos config + Phase 1 Foundry deploy stub) -----
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
  const { state, setState, loading, saving, error, savedAt, save, reload, dirty } = useItemState<AgentState>('operations-agent', id, {
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

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Agent', actions: [
        { label: saving ? 'Saving…' : 'Save', onClick: () => save(), disabled: saving || dirty === false },
        { label: deploying ? 'Deploying…' : 'Deploy to Foundry', onClick: onDeploy, disabled: deploying || saving },
      ]},
    ]},
  ], [save, saving, dirty, onDeploy, deploying]);

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon} main={
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
        {/* v3.28 Phase 4.5: functional setState so deploy/reload doesn't clobber typing. */}
        <Caption1>System prompt</Caption1>
        <Textarea value={state.systemPrompt} onChange={(_, d) => setState((p) => ({ ...p, systemPrompt: d.value }))} rows={6} />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div><Caption1>Model</Caption1><Input value={state.model} onChange={(_, d) => setState((p) => ({ ...p, model: d.value }))} /></div>
          <div><Caption1>Tools (comma)</Caption1><Input value={state.tools} onChange={(_, d) => setState((p) => ({ ...p, tools: d.value }))} /></div>
          <div><Caption1>Eventhouse binding</Caption1><Input value={state.eventhouse} onChange={(_, d) => setState((p) => ({ ...p, eventhouse: d.value }))} placeholder="eventhouse item id" /></div>
          <div><Caption1>Ontology binding</Caption1><Input value={state.ontology} onChange={(_, d) => setState((p) => ({ ...p, ontology: d.value }))} placeholder="ontology item id" /></div>
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
          saving={saving} savedAt={savedAt} error={error} dirty={dirty} onSave={() => save()}
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
interface DataAgentState {
  systemPrompt: string; model: string; sources: string;
  sqlEndpoints: string; kqlDatabases: string; lakehousePaths: string; examples: string;
  foundryAgentId?: string; foundryProjectId?: string; lastDeployedAt?: string;
  [k: string]: unknown;
}
export function DataAgentEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const { state, setState, loading, saving, error, savedAt, save, reload, dirty } = useItemState<DataAgentState>('data-agent', id, {
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

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Sources', actions: [
        { label: saving ? 'Saving…' : 'Save', onClick: () => save(), disabled: saving || dirty === false },
        { label: deploying ? 'Deploying…' : 'Deploy to Foundry', onClick: onDeploy, disabled: deploying || saving },
      ]},
      { label: 'Test', actions: [
        { label: 'Chat preview', disabled: true, title: 'test chat pane deferred — see docs/fiab/data-agent-parity-spec.md' },
      ]},
    ]},
  ], [save, saving, dirty, onDeploy, deploying]);

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon} main={
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
        {/* v3.28 Phase 4.5: functional setState so deploy/reload doesn't clobber typing. */}
        <Caption1>System prompt / AI instructions</Caption1>
        <Textarea value={state.systemPrompt} onChange={(_, d) => setState((p) => ({ ...p, systemPrompt: d.value }))} rows={5} />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div><Caption1>Model</Caption1><Input value={state.model} onChange={(_, d) => setState((p) => ({ ...p, model: d.value }))} /></div>
          <div><Caption1>Sources (free text)</Caption1><Input value={state.sources} onChange={(_, d) => setState((p) => ({ ...p, sources: d.value }))} /></div>
          <div><Caption1>Synapse Serverless SQL endpoints</Caption1><Input value={state.sqlEndpoints} onChange={(_, d) => setState((p) => ({ ...p, sqlEndpoints: d.value }))} placeholder="serverless-sql-pool name" /></div>
          <div><Caption1>KQL databases</Caption1><Input value={state.kqlDatabases} onChange={(_, d) => setState((p) => ({ ...p, kqlDatabases: d.value }))} placeholder="loomdb-default" /></div>
          <div style={{ gridColumn: 'span 2' }}>
            <Caption1>Lakehouse paths (abfss://...)</Caption1>
            <Textarea value={state.lakehousePaths} onChange={(_, d) => setState((p) => ({ ...p, lakehousePaths: d.value }))} rows={3} />
          </div>
        </div>
        <Caption1>Example queries (one per line)</Caption1>
        <Textarea value={state.examples} onChange={(_, d) => setState((p) => ({ ...p, examples: d.value }))} rows={4} />
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
          saving={saving} savedAt={savedAt} error={error} dirty={dirty} onSave={() => save()}
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
