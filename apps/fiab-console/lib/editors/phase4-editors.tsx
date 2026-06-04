'use client';

/**
 * Phase 4 editors — Data Science, APIs / Functions, Fabric IQ.
 *
 * MlModelEditor binds a Loom item (Cosmos GUID) to a REAL Azure Machine
 * Learning registered model (state.modelName + optional state.workspaceName)
 * and drives the AML model registry via the BFF — the route id is never used
 * as the model name (fixes the confirmed 404 crash). MlExperimentEditor is
 * wired live to the AI Foundry hub jobs/runs.
 *   GET  /api/items/ml-model/[id]            → bound model + versions (412 unbound)
 *   GET  /api/items/ml-model/[id]/bind       → AML workspaces + models + binding
 *   POST /api/items/ml-model/[id]/bind       → persist binding
 *   POST /api/items/ml-model/[id]/register   → register a new model version
 *   GET/POST /api/items/ml-model/[id]/endpoint → list / create online endpoint
 *   GET /api/items/ml-experiment/[id]        → job OR experiment grouping of runs
 * No mock data; all fetches content-type-guarded; errors surface in MessageBar.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Subtitle2, Body1, Caption1, Badge, Button, Input, Textarea, Spinner,
  Tab, TabList,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  Tree, TreeItem, TreeItemLayout,
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  Field, Dropdown, Option, Switch,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { ItemEditorChrome } from './item-editor-chrome';
import { NewItemBrowseGate, NewItemCreateGate } from './new-item-gate';
import { safeModelJson } from './model-fetch';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';
import { MonacoTextarea } from '@/lib/components/editor/monaco-textarea';
import { ComputePicker } from '@/lib/components/compute-picker';
import { ForceDirectedGraph } from '@/lib/components/graph/force-directed-graph';
import { GeoJsonMap } from '@/lib/components/graph/geojson-map';
// Pure-logic helpers extracted for vitest coverage. See
// `lib/editors/__tests__/family-utils.test.ts`.
import {
  validateVarValue,
  parseOntologyHierarchy,
  computeGeoBbox,
  bboxToZoom,
  parseUdfFunctions,
  normalizeDaSources,
  daSupportsExampleQueries,
  shapeDaHistory,
  canSendDaQuestion,
  type VarType,
  type UdfFunction,
  type DaSourceType,
  type DaSource,
} from './_family-utils';

/**
 * Defensive array coercion for persisted Cosmos state. Legacy / hand-edited /
 * partially-migrated records can store an array field as a string, object, null
 * or undefined; calling `.map`/`.length`/`.filter` on those throws at render
 * (e.g. the reported `eo.map is not a function` on a data-agent whose `sources`
 * was persisted as a comma-separated STRING). Every read of a persisted array
 * field below funnels through `arr()` so an odd shape renders an empty list
 * instead of crashing the editor. See .claude/rules/no-vaporware.md.
 */
function arr<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

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

  /* ---- Data-agent test chat: flex column with a scrollable thread that grows
     and a composer pinned at the bottom so Send is ALWAYS reachable. ---- */
  chatShell: {
    display: 'flex',
    flexDirection: 'column',
    flex: 1,
    minHeight: 0,
    height: '62vh',
    gap: '10px',
  },
  chatHead: { display: 'flex', flexDirection: 'column', gap: '2px', flexShrink: 0 },
  chatThread: {
    flex: 1,
    minHeight: 0,
    overflowY: 'auto',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: '6px',
    padding: '12px',
    backgroundColor: tokens.colorNeutralBackground2,
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
  },
  chatRowUser: { alignSelf: 'flex-end', maxWidth: '85%', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '4px' },
  chatRowBot: { alignSelf: 'flex-start', maxWidth: '85%', display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '4px' },
  bubbleUser: {
    padding: '8px 12px', borderRadius: '12px 12px 2px 12px',
    backgroundColor: tokens.colorBrandBackground,
    color: tokens.colorNeutralForegroundOnBrand,
    whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: '14px', lineHeight: '20px',
  },
  bubbleBot: {
    padding: '8px 12px', borderRadius: '12px 12px 12px 2px',
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    color: tokens.colorNeutralForeground1,
    whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: '14px', lineHeight: '20px',
  },
  bubbleErr: {
    padding: '8px 12px', borderRadius: '12px 12px 12px 2px',
    backgroundColor: tokens.colorStatusDangerBackground1,
    border: `1px solid ${tokens.colorStatusDangerBorder1}`,
    color: tokens.colorStatusDangerForeground1,
    whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: '14px', lineHeight: '20px',
  },
  chatMeta: { color: tokens.colorNeutralForeground3, fontSize: '11px', paddingLeft: '4px' },
  chatComposer: {
    display: 'flex', gap: '8px', alignItems: 'flex-end', flexShrink: 0,
    paddingTop: '4px',
  },
  chatSource: {
    fontFamily: 'monospace', fontSize: '12px',
    backgroundColor: tokens.colorNeutralBackground3,
    padding: '8px', borderRadius: '4px', overflowX: 'auto',
    marginTop: '4px', whiteSpace: 'pre', color: tokens.colorNeutralForeground1,
  },
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
  flavors?: Record<string, unknown>;
}

interface MlWorkspaceLite { name: string; kind?: string; isHub?: boolean }
interface ModelBindingState { modelName: string; workspaceName?: string; version?: string }
interface OnlineEndpointLite { id?: string; name: string; provisioningState?: string; scoringUri?: string; authMode?: string }

export function MlModelEditor({ item, id }: { item: FabricItemType; id: string }) {
  const isNew = id === 'new' || !id;
  // /new — real Cosmos create (workspace + name), then the editor binds the new
  // item to a registered Azure ML model. No fake create, no dead button.
  if (isNew) {
    return (
      <NewItemCreateGate
        item={item}
        createLabel="Create ML model item"
        intro="Creates an ML model item in your Loom workspace, then opens the editor where you bind it to a registered model in Azure Machine Learning (workspace + model registry) to view versions, register new versions, and deploy real-time endpoints."
      />
    );
  }
  return <MlModelEditorBody item={item} id={id} />;
}

/**
 * Bound ML-model editor. The Loom item (GUID `id`) binds to a real AML
 * registered model via `state.modelName` + optional `state.workspaceName`.
 * Resolution happens server-side (BFF resolveModelBinding) — the route id is
 * NEVER used as the model name (fixes the confirmed 404 crash). When unbound,
 * the full surface still renders with a bind picker (workspace + model from the
 * real AML registry). Tabs: Detail | Versions | Deploy. Register-version dialog
 * + content-type-guarded fetches throughout.
 */
function MlModelEditorBody({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const apiBase = `/api/items/ml-model/${encodeURIComponent(id)}`;

  // ---- Binding ----
  const [bindLoading, setBindLoading] = useState(true);
  const [bound, setBound] = useState<ModelBindingState | null>(null);
  const [workspaces, setWorkspaces] = useState<MlWorkspaceLite[]>([]);
  const [models, setModels] = useState<Array<{ name: string; latestVersion?: string }>>([]);
  const [wsError, setWsError] = useState<string | null>(null);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [pickWs, setPickWs] = useState<string>('');
  const [pickModel, setPickModel] = useState<string>('');
  const [bindBusy, setBindBusy] = useState(false);
  const [bindError, setBindError] = useState<string | null>(null);
  // Bundle-installed definition (algorithm + hyperparameters + features +
  // training code) stamped on the Cosmos item. Rendered as a read-only panel
  // so the model item opens fully built-out before it's registered/bound.
  const [bundleContent, setBundleContent] = useState<any | null>(null);

  // ---- Loaded model ----
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [model, setModel] = useState<ModelSummary | null>(null);
  const [versions, setVersions] = useState<ModelVersion[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<'detail' | 'versions' | 'deploy'>('detail');

  // ---- Deploy ----
  const [instanceType, setInstanceType] = useState('Standard_DS3_v2');
  const [deploying, setDeploying] = useState(false);
  const [endpointMsg, setEndpointMsg] = useState<{ intent: 'success' | 'error'; text: string } | null>(null);
  const [endpoints, setEndpoints] = useState<OnlineEndpointLite[]>([]);

  // ---- Register-version dialog ----
  const [regOpen, setRegOpen] = useState(false);
  const [regUri, setRegUri] = useState('');
  const [regVersion, setRegVersion] = useState('');
  const [regType, setRegType] = useState<'mlflow_model' | 'custom_model' | 'triton_model'>('mlflow_model');
  const [registering, setRegistering] = useState(false);
  const [regMsg, setRegMsg] = useState<{ intent: 'success' | 'error'; text: string } | null>(null);

  // Load the binding + picker data. Reloads `models` when `wsOverride` changes.
  const loadBinding = useCallback(async (wsOverride?: string) => {
    setBindLoading(true); setBindError(null);
    try {
      const url = wsOverride !== undefined
        ? `${apiBase}/bind?workspaceName=${encodeURIComponent(wsOverride)}`
        : `${apiBase}/bind`;
      const res = await fetch(url);
      const j = await safeModelJson(res);
      if (!j.ok) { setBindError(j.error || `HTTP ${j.status}`); return; }
      setBound(j.data?.bound || null);
      setWorkspaces(j.data?.workspaces || []);
      setModels(j.data?.models || []);
      setWsError(j.data?.workspacesError || null);
      setModelsError(j.data?.modelsError || null);
      setBundleContent(j.data?.content || null);
    } catch (e: any) { setBindError(e?.message || String(e)); }
    finally { setBindLoading(false); }
  }, [apiBase]);

  // Load the bound model + versions (content-type guarded — an HTML 404 from
  // the BFF surfaces as a structured message, never a JSON.parse crash).
  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await fetch(apiBase);
      const j = await safeModelJson(res);
      if (!j.ok) {
        // 412 unbound is expected before binding — handled by the bind UI, not
        // an error banner.
        if (j.code !== 'unbound') setError(j.error || `HTTP ${j.status}`);
        setModel(null); setVersions([]);
        return;
      }
      setModel(j.data?.model || null);
      setVersions(j.data?.versions || []);
      setSelected(j.data?.binding?.version || j.data?.versions?.[0]?.version || null);
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setLoading(false); }
  }, [apiBase]);

  const loadEndpoints = useCallback(async () => {
    try {
      const res = await fetch(`${apiBase}/endpoint`);
      const j = await safeModelJson(res);
      if (j.ok) setEndpoints(j.data?.endpoints || []);
    } catch { /* non-critical */ }
  }, [apiBase]);

  useEffect(() => { loadBinding(); }, [loadBinding]);
  useEffect(() => { if (bound?.modelName) { load(); loadEndpoints(); } }, [bound?.modelName, load, loadEndpoints]);

  const doBind = useCallback(async () => {
    if (!pickModel) { setBindError('Select a model to bind.'); return; }
    setBindBusy(true); setBindError(null);
    try {
      const res = await fetch(`${apiBase}/bind`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ modelName: pickModel, workspaceName: pickWs || undefined }),
      });
      const j = await safeModelJson(res);
      if (!j.ok) { setBindError(j.error || `HTTP ${j.status}`); return; }
      setBound(j.data?.bound || { modelName: pickModel, workspaceName: pickWs || undefined });
    } catch (e: any) { setBindError(e?.message || String(e)); }
    finally { setBindBusy(false); }
  }, [apiBase, pickModel, pickWs]);

  const unbind = useCallback(() => { setBound(null); setModel(null); setVersions([]); loadBinding(pickWs); }, [loadBinding, pickWs]);

  const createEndpoint = useCallback(async () => {
    setDeploying(true); setEndpointMsg(null);
    try {
      const res = await fetch(`${apiBase}/endpoint`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ version: selected || undefined, instanceType }),
      });
      const j = await safeModelJson(res);
      if (!j.ok) { setEndpointMsg({ intent: 'error', text: j.error || `HTTP ${j.status}` }); return; }
      setEndpointMsg({ intent: 'success', text: j.data?.message || `Endpoint ${j.data?.endpoint?.name} provisioning.` });
      loadEndpoints();
    } catch (e: any) { setEndpointMsg({ intent: 'error', text: e?.message || String(e) }); }
    finally { setDeploying(false); }
  }, [apiBase, selected, instanceType, loadEndpoints]);

  const registerVersion = useCallback(async () => {
    if (!regUri.trim()) { setRegMsg({ intent: 'error', text: 'Model artifact URI is required.' }); return; }
    setRegistering(true); setRegMsg(null);
    try {
      const res = await fetch(`${apiBase}/register`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ modelUri: regUri.trim(), version: regVersion.trim() || undefined, modelType: regType }),
      });
      const j = await safeModelJson(res);
      if (!j.ok) { setRegMsg({ intent: 'error', text: j.error || `HTTP ${j.status}` }); return; }
      setRegMsg({ intent: 'success', text: `Registered ${j.data?.model} v${j.data?.version?.version}` });
      setRegOpen(false);
      load();
    } catch (e: any) { setRegMsg({ intent: 'error', text: e?.message || String(e) }); }
    finally { setRegistering(false); }
  }, [apiBase, regUri, regVersion, regType, load]);

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Model', actions: [
        { label: loading || bindLoading ? 'Reloading…' : 'Reload', onClick: (loading || bindLoading) ? undefined : (bound?.modelName ? load : () => loadBinding(pickWs)), disabled: loading || bindLoading },
        { label: 'Re-bind', onClick: bound?.modelName ? unbind : undefined, disabled: !bound?.modelName },
      ]},
      { label: 'Versions', actions: [
        { label: 'Register version', onClick: bound?.modelName ? () => { setRegUri(''); setRegVersion(''); setRegMsg(null); setRegOpen(true); } : undefined, disabled: !bound?.modelName },
      ]},
      { label: 'Serve', actions: [
        { label: deploying ? 'Deploying…' : 'Real-time endpoint', onClick: createEndpoint, disabled: deploying || !versions.length },
      ]},
    ]},
  ], [loading, bindLoading, bound?.modelName, load, loadBinding, pickWs, unbind, deploying, createEndpoint, versions.length]);

  const current = versions.find((v) => v.version === selected) || versions[0];

  // ---- Unbound: full surface still renders, with a bind picker ----
  const bindPanel = (
    <div className={s.card} style={{ maxWidth: 640 }}>
      <Subtitle2>Bind to an Azure ML registered model</Subtitle2>
      <Body1 style={{ color: tokens.colorNeutralForeground3, marginTop: 4 }}>
        Choose the Azure Machine Learning workspace and a registered model. The binding is saved on this item; all actions then target the bound model&apos;s real registry.
      </Body1>
      {wsError && (
        <MessageBar intent="warning" style={{ marginTop: 8 }}>
          <MessageBarBody>
            <MessageBarTitle>Azure ML workspaces not reachable</MessageBarTitle>
            {wsError}
            <br /><Caption1>Set <code>LOOM_SUBSCRIPTION_ID</code> + <code>LOOM_FOUNDRY_RG</code> and grant the Console UAMI <strong>AzureML Data Scientist</strong> (or Reader) on the resource group.</Caption1>
          </MessageBarBody>
        </MessageBar>
      )}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end', marginTop: 12 }}>
        <Field label="Workspace (blank = Foundry hub)">
          <Dropdown
            placeholder={workspaces.length ? 'Foundry hub (default)' : 'No AML workspaces found'}
            value={pickWs}
            selectedOptions={pickWs ? [pickWs] : []}
            onOptionSelect={(_, d) => { const w = d.optionValue || ''; setPickWs(w); setPickModel(''); loadBinding(w); }}
          >
            <Option value="">Foundry hub (default)</Option>
            {workspaces.map((w) => <Option key={w.name} value={w.name}>{w.name}{w.isHub ? ' (hub)' : w.kind ? ` (${w.kind})` : ''}</Option>)}
          </Dropdown>
        </Field>
        <Field label="Registered model">
          <Dropdown
            placeholder={models.length ? 'Select a model' : 'No models in this workspace'}
            value={pickModel}
            selectedOptions={pickModel ? [pickModel] : []}
            onOptionSelect={(_, d) => setPickModel(d.optionValue || '')}
          >
            {models.map((m) => <Option key={m.name} value={m.name}>{m.name}{m.latestVersion ? ` (latest v${m.latestVersion})` : ''}</Option>)}
          </Dropdown>
        </Field>
        <Button appearance="primary" onClick={doBind} disabled={bindBusy || !pickModel}>
          {bindBusy ? 'Binding…' : 'Bind'}
        </Button>
      </div>
      {modelsError && (
        <MessageBar intent="warning" style={{ marginTop: 8 }}>
          <MessageBarBody>
            <MessageBarTitle>Models not reachable</MessageBarTitle>
            {modelsError}
          </MessageBarBody>
        </MessageBar>
      )}
      {bindError && <MessageBar intent="error" style={{ marginTop: 8 }}><MessageBarBody>{bindError}</MessageBarBody></MessageBar>}
    </div>
  );

  return (
    <ItemEditorChrome
      item={item}
      id={id}
      ribbon={ribbon}
      leftPanel={
        <div style={{ padding: 8 }}>
          <Caption1 style={{ padding: '4px 8px', color: tokens.colorNeutralForeground3 }}>
            {bound?.modelName ? `Versions (${versions.length})` : 'Not bound'}
          </Caption1>
          {bound?.modelName && versions.length === 0 && !loading && (
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
          {bindLoading && <Spinner size="small" label="Loading binding…" labelPosition="after" />}

          {/* Bundle definition — algorithm + hyperparameters + features +
              training code stamped at install. Renders fully built-out whether
              or not the model is registered/bound yet; Register/Bind/Deploy
              still target the real Azure ML registry. */}
          {!bindLoading && bundleContent && (
            <div className={s.card} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <Subtitle2>Model definition</Subtitle2>
                <Badge appearance="filled" color="brand">{bundleContent.algorithm}</Badge>
                {bundleContent.framework && <Badge appearance="outline">{bundleContent.framework}</Badge>}
                {bundleContent.target && <Badge appearance="tint">target: {bundleContent.target}</Badge>}
                <Badge appearance="outline" color="warning">bundle template</Badge>
              </div>
              {bundleContent.hyperparameters && Object.keys(bundleContent.hyperparameters).length > 0 && (
                <div>
                  <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Hyperparameters</Caption1>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
                    {Object.entries(bundleContent.hyperparameters).map(([k, v]) => (
                      <Badge key={k} appearance="outline">{k}={String(v)}</Badge>
                    ))}
                  </div>
                </div>
              )}
              {Array.isArray(bundleContent.features) && bundleContent.features.length > 0 && (
                <div>
                  <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Features ({bundleContent.features.length})</Caption1>
                  <Table aria-label="Model features" size="small">
                    <TableHeader><TableRow><TableHeaderCell>Name</TableHeaderCell><TableHeaderCell>Type</TableHeaderCell></TableRow></TableHeader>
                    <TableBody>
                      {bundleContent.features.map((f: any) => (
                        <TableRow key={f.name}><TableCell><strong>{f.name}</strong></TableCell><TableCell>{f.type}</TableCell></TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
              {bundleContent.trainingCode && (
                <div>
                  <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Training code</Caption1>
                  <div className={s.monaco} style={{ whiteSpace: 'pre', overflow: 'auto', maxHeight: 320 }}>
                    {bundleContent.trainingCode}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Unbound — render the bind picker. Full surface still present. */}
          {!bindLoading && !bound?.modelName && bindPanel}

          {/* Bound — model detail / versions / deploy. */}
          {!bindLoading && bound?.modelName && (
            <>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <Badge appearance="filled" color="brand">{bound.modelName}</Badge>
                <Badge appearance="outline">{bound.workspaceName || 'Foundry hub'}</Badge>
                <Button size="small" appearance="subtle" onClick={unbind}>Re-bind</Button>
              </div>

              {loading && <Spinner size="small" label="Loading model…" labelPosition="after" />}
              {error && (
                <MessageBar intent="error">
                  <MessageBarBody><MessageBarTitle>Load failed</MessageBarTitle>{error}</MessageBarBody>
                </MessageBar>
              )}

              {model && !error && (
                <>
                  <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as any)}>
                    <Tab value="detail">Detail</Tab>
                    <Tab value="versions">Versions ({versions.length})</Tab>
                    <Tab value="deploy">Deploy</Tab>
                  </TabList>

                  {tab === 'detail' && (
                    <>
                      <Subtitle2>{model.name}</Subtitle2>
                      {model.description && <Body1>{model.description}</Body1>}
                      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                        <Badge appearance="tint">Latest: v{model.latestVersion || '—'}</Badge>
                        <Badge appearance="tint">{versions.length} version(s)</Badge>
                      </div>
                      {current && (
                        <>
                          <Subtitle2 style={{ marginTop: 8 }}>Selected version: v{current.version}</Subtitle2>
                          {current.description && <Body1>{current.description}</Body1>}
                          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                            <Badge appearance="outline">type: {current.modelType || '—'}</Badge>
                            {current.createdAt && <Badge appearance="outline">created: {current.createdAt}</Badge>}
                          </div>
                          {current.modelUri && (
                            <Caption1 style={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>{current.modelUri}</Caption1>
                          )}
                          {current.flavors && Object.keys(current.flavors).length > 0 && (
                            <div>
                              <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>MLflow flavors / signature</Caption1>
                              <div className={s.monaco} style={{ whiteSpace: 'pre-wrap', overflow: 'auto', maxHeight: 200 }}>
                                {JSON.stringify(current.flavors, null, 2)}
                              </div>
                            </div>
                          )}
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
                          {current.properties && Object.keys(current.properties).length > 0 && (
                            <div>
                              <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Properties (lineage / run)</Caption1>
                              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
                                {Object.entries(current.properties).map(([k, v]) => (
                                  <Badge key={k} appearance="outline">{k}={String(v)}</Badge>
                                ))}
                              </div>
                            </div>
                          )}
                        </>
                      )}
                    </>
                  )}

                  {tab === 'versions' && (
                    <>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <Button appearance="primary" onClick={() => { setRegUri(''); setRegVersion(''); setRegMsg(null); setRegOpen(true); }}>
                          Register new version
                        </Button>
                      </div>
                      <Table aria-label="Model versions" size="small">
                        <TableHeader><TableRow>
                          <TableHeaderCell>Version</TableHeaderCell>
                          <TableHeaderCell>Type</TableHeaderCell>
                          <TableHeaderCell>Created</TableHeaderCell>
                          <TableHeaderCell>URI</TableHeaderCell>
                        </TableRow></TableHeader>
                        <TableBody>
                          {versions.map((v) => (
                            <TableRow key={v.version} onClick={() => setSelected(v.version)} style={{ cursor: 'pointer', background: v.version === selected ? tokens.colorNeutralBackground2 : undefined }}>
                              <TableCell><strong>v{v.version}</strong></TableCell>
                              <TableCell>{v.modelType || '—'}</TableCell>
                              <TableCell>{v.createdAt || '—'}</TableCell>
                              <TableCell style={{ fontFamily: 'monospace', fontSize: 12, wordBreak: 'break-all' }}>{v.modelUri || '—'}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </>
                  )}

                  {tab === 'deploy' && (
                    <>
                      <Subtitle2>Deploy to a managed online (real-time) endpoint</Subtitle2>
                      <Body1 style={{ color: tokens.colorNeutralForeground3 }}>
                        Creates a managed online endpoint + a &quot;blue&quot; deployment serving <code>{bound.modelName}:{selected || model.latestVersion || '?'}</code> via real ARM PUTs in <strong>{bound.workspaceName || 'the Foundry hub'}</strong>.
                      </Body1>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                        <Field label="Endpoint VM size">
                          <Input value={instanceType} onChange={(_, d) => setInstanceType(d.value)} placeholder="Standard_DS3_v2" />
                        </Field>
                        <Button appearance="primary" disabled={deploying || !versions.length} onClick={createEndpoint}>
                          {deploying ? 'Deploying…' : `Deploy v${selected || model.latestVersion || '?'}`}
                        </Button>
                      </div>
                      {endpointMsg && (
                        <MessageBar intent={endpointMsg.intent}>
                          <MessageBarBody>{endpointMsg.text}</MessageBarBody>
                        </MessageBar>
                      )}
                      <Subtitle2 style={{ marginTop: 8 }}>Existing endpoints ({endpoints.length})</Subtitle2>
                      {endpoints.length === 0
                        ? <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>No managed online endpoints in this workspace yet.</Caption1>
                        : (
                          <Table aria-label="Online endpoints" size="small">
                            <TableHeader><TableRow>
                              <TableHeaderCell>Endpoint</TableHeaderCell>
                              <TableHeaderCell>State</TableHeaderCell>
                              <TableHeaderCell>Auth</TableHeaderCell>
                              <TableHeaderCell>Scoring URI</TableHeaderCell>
                            </TableRow></TableHeader>
                            <TableBody>
                              {endpoints.map((ep) => (
                                <TableRow key={ep.name}>
                                  <TableCell><strong>{ep.name}</strong></TableCell>
                                  <TableCell>{ep.provisioningState || '—'}</TableCell>
                                  <TableCell>{ep.authMode || '—'}</TableCell>
                                  <TableCell style={{ fontFamily: 'monospace', fontSize: 12, wordBreak: 'break-all' }}>{ep.scoringUri || '—'}</TableCell>
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        )}
                    </>
                  )}
                </>
              )}
            </>
          )}

          {/* Register-version dialog */}
          <Dialog open={regOpen} onOpenChange={(_, d) => { if (!d.open) setRegOpen(false); }}>
            <DialogSurface>
              <DialogBody>
                <DialogTitle>Register a new model version</DialogTitle>
                <DialogContent>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    <Caption1>Registers a new version of <strong>{bound?.modelName}</strong> from a model artifact URI (real ARM PUT to the model registry).</Caption1>
                    <Field label="Model artifact URI">
                      <Input value={regUri} onChange={(_, d) => setRegUri(d.value)} placeholder="azureml://jobs/<run>/outputs/artifacts/paths/model/" />
                    </Field>
                    <Field label="Version (blank = auto)">
                      <Input value={regVersion} onChange={(_, d) => setRegVersion(d.value)} placeholder="auto" />
                    </Field>
                    <Field label="Model type">
                      <Dropdown value={regType} selectedOptions={[regType]} onOptionSelect={(_, d) => setRegType((d.optionValue as any) || 'mlflow_model')}>
                        <Option value="mlflow_model">mlflow_model</Option>
                        <Option value="custom_model">custom_model</Option>
                        <Option value="triton_model">triton_model</Option>
                      </Dropdown>
                    </Field>
                    {regMsg && <MessageBar intent={regMsg.intent}><MessageBarBody>{regMsg.text}</MessageBarBody></MessageBar>}
                  </div>
                </DialogContent>
                <DialogActions>
                  <Button onClick={() => setRegOpen(false)}>Cancel</Button>
                  <Button appearance="primary" disabled={registering || !regUri.trim()} onClick={registerVersion}>{registering ? 'Registering…' : 'Register'}</Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>
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

// ----- MLflow tracking shapes (mirror lib/azure/mlflow-client.ts) -----
interface MlflowMetric { key: string; value: number; timestamp?: number; step?: number }
interface MlflowParam { key: string; value: string }
interface MlflowRunTag { key: string; value: string }
interface MlflowRun {
  runId: string; runName?: string; experimentId?: string; status?: string;
  startTime?: number; endTime?: number; artifactUri?: string; lifecycleStage?: string;
  metrics: MlflowMetric[]; params: MlflowParam[]; tags: MlflowRunTag[];
}

function fmtEpochMs(ms?: number): string {
  if (!ms || !Number.isFinite(ms)) return '—';
  try { return new Date(ms).toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z'); } catch { return '—'; }
}

/**
 * Minimal self-contained SVG line chart for a single MLflow metric series
 * (step on x, value on y) — no extra deps, consistent with the Loom theme via
 * Fluent tokens. Returns null with fewer than 2 points; the caller shows the
 * values table alongside so a single-point metric is still readable.
 */
function MetricLineChart({ points }: { points: MlflowMetric[] }) {
  const W = 640, H = 200, padL = 48, padR = 12, padT = 12, padB = 28;
  const series = points
    .map((p, i) => ({ x: p.step ?? i, y: p.value }))
    .filter((p) => Number.isFinite(p.y));
  if (series.length < 2) return null;
  const xs = series.map((p) => p.x), ys = series.map((p) => p.y);
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  const yMin = Math.min(...ys), yMax = Math.max(...ys);
  const xSpan = xMax - xMin || 1, ySpan = yMax - yMin || 1;
  const sx = (x: number) => padL + ((x - xMin) / xSpan) * (W - padL - padR);
  const sy = (y: number) => H - padB - ((y - yMin) / ySpan) * (H - padT - padB);
  const d = series.map((p, i) => `${i === 0 ? 'M' : 'L'}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(' ');
  const yTicks = [yMin, (yMin + yMax) / 2, yMax];
  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Metric history chart"
      style={{ border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 6, background: tokens.colorNeutralBackground2, maxWidth: W }}>
      {yTicks.map((t, i) => (
        <g key={i}>
          <line x1={padL} y1={sy(t)} x2={W - padR} y2={sy(t)} stroke={tokens.colorNeutralStroke3} strokeWidth={1} />
          <text x={padL - 6} y={sy(t) + 4} textAnchor="end" fontSize={10} fill={tokens.colorNeutralForeground3}>
            {t.toPrecision(4)}
          </text>
        </g>
      ))}
      <text x={padL} y={H - 8} textAnchor="start" fontSize={10} fill={tokens.colorNeutralForeground3}>{xMin}</text>
      <text x={W - padR} y={H - 8} textAnchor="end" fontSize={10} fill={tokens.colorNeutralForeground3}>{xMax}</text>
      <text x={(padL + W - padR) / 2} y={H - 8} textAnchor="middle" fontSize={10} fill={tokens.colorNeutralForeground3}>step</text>
      <path d={d} fill="none" stroke={tokens.colorBrandStroke1} strokeWidth={2} />
      {series.map((p, i) => (
        <circle key={i} cx={sx(p.x)} cy={sy(p.y)} r={2.5} fill={tokens.colorBrandForeground1} />
      ))}
    </svg>
  );
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
  // Submission compute for "Submit run"; plus run/environment for a real
  // command-job submit and the Register-model flow.
  const [computeId, setComputeId] = useState('');
  const [envId, setEnvId] = useState('azureml://registries/azureml/environments/sklearn-1.5/labels/latest');
  const [command, setCommand] = useState('python train.py');
  const [submitting, setSubmitting] = useState(false);
  const [submitMsg, setSubmitMsg] = useState<{ intent: 'success' | 'error'; text: string } | null>(null);
  const [regOpen, setRegOpen] = useState(false);
  const [regName, setRegName] = useState('');
  const [registering, setRegistering] = useState(false);
  const [regMsg, setRegMsg] = useState<{ intent: 'success' | 'error'; text: string } | null>(null);

  // ---- MLflow tracking (Runs tab) ----
  const [tab, setTab] = useState<'overview' | 'mlflowRuns'>('overview');
  const [mlflowLoading, setMlflowLoading] = useState(false);
  const [mlflowConfigured, setMlflowConfigured] = useState(true);
  const [mlflowHint, setMlflowHint] = useState<string | null>(null);
  const [mlflowError, setMlflowError] = useState<string | null>(null);
  const [mlflowRuns, setMlflowRuns] = useState<MlflowRun[]>([]);
  const [selMlflowRun, setSelMlflowRun] = useState<string | null>(null);
  // Metric-history view for the selected run.
  const [metricKeys, setMetricKeys] = useState<string[]>([]);
  const [selMetric, setSelMetric] = useState<string>('');
  const [metricHistory, setMetricHistory] = useState<MlflowMetric[]>([]);
  const [metricLoading, setMetricLoading] = useState(false);
  const [metricError, setMetricError] = useState<string | null>(null);

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

  const submitRun = useCallback(async () => {
    setSubmitting(true); setSubmitMsg(null);
    try {
      const r = await fetch('/api/items/ml-experiment/submit', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          command, environmentId: envId,
          computeId: computeId ? `azureml:${computeId}` : undefined,
          experimentName: expName || undefined,
        }),
      });
      const j = await r.json();
      if (!j.ok) { setSubmitMsg({ intent: 'error', text: j.error || `HTTP ${r.status}` }); return; }
      setSubmitMsg({ intent: 'success', text: `Submitted run ${j.job?.name} (${j.job?.status || 'queued'})` });
      load();
    } catch (e: any) { setSubmitMsg({ intent: 'error', text: e?.message || String(e) }); }
    finally { setSubmitting(false); }
  }, [command, envId, computeId, expName, load]);

  const registerModel = useCallback(async () => {
    const runName = current?.name;
    if (!runName || !regName.trim()) { setRegMsg({ intent: 'error', text: 'Select a run and enter a model name.' }); return; }
    setRegistering(true); setRegMsg(null);
    try {
      const r = await fetch(`/api/items/ml-experiment/${encodeURIComponent(runName)}/register`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ modelName: regName.trim() }),
      });
      const j = await r.json();
      if (!j.ok) { setRegMsg({ intent: 'error', text: j.error || `HTTP ${r.status}` }); return; }
      setRegMsg({ intent: 'success', text: `Registered ${j.model} v${j.version?.version}` });
      setRegOpen(false);
    } catch (e: any) { setRegMsg({ intent: 'error', text: e?.message || String(e) }); }
    finally { setRegistering(false); }
  }, [current, regName]);

  // Load the experiment's MLflow runs (real run metrics + params + status that
  // the AML job properties don't carry). `id` is the experiment name.
  const loadMlflowRuns = useCallback(async () => {
    setMlflowLoading(true); setMlflowError(null);
    try {
      const r = await fetch(`/api/items/ml-experiment/${encodeURIComponent(id)}/runs`);
      const j = await r.json();
      if (!j.ok) { setMlflowError(j.error || `HTTP ${r.status}`); setMlflowRuns([]); return; }
      setMlflowConfigured(j.configured !== false);
      setMlflowHint(j.hint || null);
      const rows: MlflowRun[] = Array.isArray(j.runs) ? j.runs : [];
      setMlflowRuns(rows);
      setSelMlflowRun((prev) => (prev && rows.some((x) => x.runId === prev)) ? prev : (rows[0]?.runId || null));
    } catch (e: any) { setMlflowError(e?.message || String(e)); setMlflowRuns([]); }
    finally { setMlflowLoading(false); }
  }, [id]);

  // Lazy-load runs when the user first opens the MLflow Runs tab.
  useEffect(() => {
    if (tab === 'mlflowRuns' && !mlflowLoading && mlflowRuns.length === 0 && mlflowConfigured && !mlflowError) {
      loadMlflowRuns();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  // When the selected run changes, fetch its available metric keys (from runs/get).
  const selectedMlflowRun = mlflowRuns.find((r) => r.runId === selMlflowRun) || null;
  useEffect(() => {
    const keys = Array.from(new Set((selectedMlflowRun?.metrics || []).map((m) => m.key))).sort();
    setMetricKeys(keys);
    setSelMetric((prev) => (prev && keys.includes(prev)) ? prev : (keys[0] || ''));
    setMetricHistory([]);
    setMetricError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selMlflowRun]);

  // Load the full step/value history for the chosen metric on the chosen run.
  const loadMetricHistory = useCallback(async () => {
    if (!selMlflowRun || !selMetric) { setMetricHistory([]); return; }
    setMetricLoading(true); setMetricError(null);
    try {
      const r = await fetch(`/api/items/ml-experiment/${encodeURIComponent(id)}/runs/${encodeURIComponent(selMlflowRun)}/metrics?metricKey=${encodeURIComponent(selMetric)}`);
      const j = await r.json();
      if (!j.ok) { setMetricError(j.error || `HTTP ${r.status}`); setMetricHistory([]); return; }
      if (j.configured === false) { setMlflowConfigured(false); setMlflowHint(j.hint || null); setMetricHistory([]); return; }
      setMetricHistory(Array.isArray(j.history) ? j.history : []);
    } catch (e: any) { setMetricError(e?.message || String(e)); setMetricHistory([]); }
    finally { setMetricLoading(false); }
  }, [id, selMlflowRun, selMetric]);

  useEffect(() => { if (selMlflowRun && selMetric) loadMetricHistory(); }, [selMlflowRun, selMetric, loadMetricHistory]);

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Runs', actions: [
        { label: loading ? 'Reloading…' : 'Reload', onClick: loading ? undefined : load, disabled: loading },
        { label: submitting ? 'Submitting…' : 'Submit run', onClick: submitRun, disabled: submitting },
      ]},
      { label: 'Tracking', actions: [
        { label: mlflowLoading ? 'Loading…' : 'MLflow runs', onClick: () => { setTab('mlflowRuns'); loadMlflowRuns(); }, disabled: mlflowLoading },
      ]},
      { label: 'Model', actions: [
        { label: 'Register model', onClick: () => { setRegName(''); setRegMsg(null); setRegOpen(true); }, disabled: !current },
      ]},
    ]},
  ], [loading, load, submitting, submitRun, current, mlflowLoading, loadMlflowRuns]);

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
            <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as any)}>
              <Tab value="overview">Overview</Tab>
              <Tab value="mlflowRuns">Runs &amp; metrics</Tab>
            </TabList>
          )}

          {tab === 'overview' && !loading && !error && (kind === 'experiment' || kind === 'job') && (
            <div style={{ border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 6, padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <Subtitle2>Submit a run (Command job)</Subtitle2>
              <ComputePicker
                label="Submission compute"
                filter={['synapse-spark', 'databricks-cluster']}
                value={computeId}
                onChange={setComputeId}
              />
              <Field label="Environment (azureml:<name>:<ver> or registry URI)">
                <Input value={envId} onChange={(_, d) => setEnvId(d.value)} />
              </Field>
              <Field label="Command">
                <Input value={command} onChange={(_, d) => setCommand(d.value)} placeholder="python train.py" />
              </Field>
              <Button appearance="primary" disabled={submitting || !command || !envId} onClick={submitRun} style={{ alignSelf: 'flex-start' }}>
                {submitting ? 'Submitting…' : 'Submit run'}
              </Button>
              {submitMsg && <MessageBar intent={submitMsg.intent}><MessageBarBody>{submitMsg.text}</MessageBarBody></MessageBar>}
            </div>
          )}
          <Dialog open={regOpen} onOpenChange={(_, d) => { if (!d.open) setRegOpen(false); }}>
            <DialogSurface>
              <DialogBody>
                <DialogTitle>Register model from run</DialogTitle>
                <DialogContent>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    <Caption1>Run: <strong>{current?.displayName || current?.name || '—'}</strong></Caption1>
                    <Field label="Model name"><Input value={regName} onChange={(_, d) => setRegName(d.value)} placeholder="fraud-classifier" /></Field>
                    {regMsg && <MessageBar intent={regMsg.intent}><MessageBarBody>{regMsg.text}</MessageBarBody></MessageBar>}
                  </div>
                </DialogContent>
                <DialogActions>
                  <Button onClick={() => setRegOpen(false)}>Cancel</Button>
                  <Button appearance="primary" disabled={registering || !regName.trim()} onClick={registerModel}>{registering ? 'Registering…' : 'Register'}</Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>
          {tab === 'overview' && !loading && !error && runs.length > 0 && (
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

          {/* ---- MLflow Runs & metrics (real AML MLflow tracking REST) ---- */}
          {tab === 'mlflowRuns' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {mlflowLoading && <Spinner size="small" label="Loading MLflow runs…" labelPosition="after" />}

              {!mlflowConfigured && (
                <MessageBar intent="warning">
                  <MessageBarBody>
                    <MessageBarTitle>Azure ML MLflow tracking not configured</MessageBarTitle>
                    {mlflowHint || 'Set LOOM_AML_WORKSPACE / LOOM_AML_REGION to a deployed Azure Machine Learning workspace and grant the Console UAMI the AzureML Data Scientist role on it.'}
                    <br />
                    <Caption1>
                      Env: <code>LOOM_AML_WORKSPACE</code> (falls back to <code>LOOM_FOUNDRY_NAME</code>),{' '}
                      <code>LOOM_AML_REGION</code> (falls back to <code>LOOM_FOUNDRY_REGION</code>),{' '}
                      <code>LOOM_SUBSCRIPTION_ID</code>.
                    </Caption1>
                  </MessageBarBody>
                </MessageBar>
              )}

              {mlflowError && (
                <MessageBar intent="error">
                  <MessageBarBody><MessageBarTitle>MLflow load failed</MessageBarTitle>{mlflowError}</MessageBarBody>
                </MessageBar>
              )}

              {!mlflowLoading && mlflowConfigured && !mlflowError && mlflowRuns.length === 0 && (
                <MessageBar intent="info">
                  <MessageBarBody>
                    <MessageBarTitle>No MLflow runs for this experiment</MessageBarTitle>
                    Submit a run that logs with MLflow (e.g. <code>mlflow.start_run()</code> +{' '}
                    <code>mlflow.log_metric()</code>) under experiment <strong>{expName || id}</strong>.
                  </MessageBarBody>
                </MessageBar>
              )}

              {!mlflowLoading && mlflowConfigured && mlflowRuns.length > 0 && (
                <>
                  <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                    {mlflowRuns.length} MLflow run(s) — click a row to view its params and per-step metric history.
                  </Caption1>
                  <Table aria-label="MLflow runs" size="small">
                    <TableHeader><TableRow>
                      <TableHeaderCell>Run</TableHeaderCell>
                      <TableHeaderCell>Status</TableHeaderCell>
                      <TableHeaderCell>Started</TableHeaderCell>
                      <TableHeaderCell>Params</TableHeaderCell>
                      <TableHeaderCell>Metrics (latest)</TableHeaderCell>
                    </TableRow></TableHeader>
                    <TableBody>
                      {mlflowRuns.map((r) => (
                        <TableRow
                          key={r.runId}
                          onClick={() => setSelMlflowRun(r.runId)}
                          style={{ cursor: 'pointer', background: r.runId === selMlflowRun ? tokens.colorNeutralBackground2 : undefined }}
                        >
                          <TableCell><strong>{r.runName || r.runId}</strong></TableCell>
                          <TableCell>
                            <Badge
                              appearance="tint"
                              color={r.status === 'FINISHED' ? 'success' : r.status === 'FAILED' || r.status === 'KILLED' ? 'danger' : 'informative'}
                            >
                              {r.status || '—'}
                            </Badge>
                          </TableCell>
                          <TableCell>{fmtEpochMs(r.startTime)}</TableCell>
                          <TableCell>{r.params.length}</TableCell>
                          <TableCell>{r.metrics.length}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>

                  {selectedMlflowRun && (
                    <div className={s.card} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                      <Subtitle2>Run: {selectedMlflowRun.runName || selectedMlflowRun.runId}</Subtitle2>
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        <Badge appearance="outline">{selectedMlflowRun.status || '—'}</Badge>
                        <Badge appearance="outline">start: {fmtEpochMs(selectedMlflowRun.startTime)}</Badge>
                        <Badge appearance="outline">end: {fmtEpochMs(selectedMlflowRun.endTime)}</Badge>
                      </div>

                      {selectedMlflowRun.params.length > 0 && (
                        <div>
                          <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Parameters</Caption1>
                          <Table aria-label="Run params" size="small">
                            <TableHeader><TableRow><TableHeaderCell>Key</TableHeaderCell><TableHeaderCell>Value</TableHeaderCell></TableRow></TableHeader>
                            <TableBody>
                              {selectedMlflowRun.params.map((p) => (
                                <TableRow key={p.key}>
                                  <TableCell style={{ fontFamily: 'monospace', fontSize: 12 }}>{p.key}</TableCell>
                                  <TableCell style={{ fontFamily: 'monospace', fontSize: 12 }}>{p.value}</TableCell>
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        </div>
                      )}

                      {selectedMlflowRun.metrics.length > 0 && (
                        <div>
                          <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Metrics (latest logged value)</Caption1>
                          <Table aria-label="Run metrics" size="small">
                            <TableHeader><TableRow><TableHeaderCell>Metric</TableHeaderCell><TableHeaderCell>Value</TableHeaderCell><TableHeaderCell>Step</TableHeaderCell></TableRow></TableHeader>
                            <TableBody>
                              {selectedMlflowRun.metrics.map((m) => (
                                <TableRow key={m.key}>
                                  <TableCell style={{ fontFamily: 'monospace', fontSize: 12 }}>{m.key}</TableCell>
                                  <TableCell style={{ fontFamily: 'monospace', fontSize: 12 }}>{m.value}</TableCell>
                                  <TableCell style={{ fontFamily: 'monospace', fontSize: 12 }}>{m.step ?? '—'}</TableCell>
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        </div>
                      )}

                      {/* Per-metric history (step/value over time) */}
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                          <Field label="Metric history">
                            <Dropdown
                              placeholder={metricKeys.length ? 'Select a metric' : 'No metrics logged on this run'}
                              value={selMetric}
                              selectedOptions={selMetric ? [selMetric] : []}
                              onOptionSelect={(_, d) => setSelMetric(d.optionValue || '')}
                              disabled={metricKeys.length === 0}
                            >
                              {metricKeys.map((k) => <Option key={k} value={k}>{k}</Option>)}
                            </Dropdown>
                          </Field>
                          {metricLoading && <Spinner size="tiny" label="Loading history…" labelPosition="after" />}
                        </div>

                        {metricError && (
                          <MessageBar intent="error"><MessageBarBody>{metricError}</MessageBarBody></MessageBar>
                        )}

                        {!metricLoading && !metricError && selMetric && metricHistory.length === 0 && (
                          <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                            No history points for <code>{selMetric}</code>.
                          </Caption1>
                        )}

                        {!metricLoading && metricHistory.length > 0 && (
                          <>
                            <MetricLineChart points={metricHistory} />
                            <Table aria-label="Metric history" size="small">
                              <TableHeader><TableRow><TableHeaderCell>Step</TableHeaderCell><TableHeaderCell>Value</TableHeaderCell><TableHeaderCell>Timestamp</TableHeaderCell></TableRow></TableHeader>
                              <TableBody>
                                {metricHistory.map((m, i) => (
                                  <TableRow key={`${m.step ?? i}-${m.timestamp ?? i}`}>
                                    <TableCell style={{ fontFamily: 'monospace', fontSize: 12 }}>{m.step ?? i}</TableCell>
                                    <TableCell style={{ fontFamily: 'monospace', fontSize: 12 }}>{m.value}</TableCell>
                                    <TableCell style={{ fontFamily: 'monospace', fontSize: 12 }}>{fmtEpochMs(m.timestamp)}</TableCell>
                                  </TableRow>
                                ))}
                              </TableBody>
                            </Table>
                          </>
                        )}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
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
  // Test query console.
  const [queryText, setQueryText] = useState('query {\n  __typename\n}');
  const [queryVars, setQueryVars] = useState('');
  const [queryBusy, setQueryBusy] = useState(false);
  const [queryResp, setQueryResp] = useState<{ status: number; body: string } | null>(null);
  const [queryErr, setQueryErr] = useState<string | null>(null);

  const runQuery = useCallback(async () => {
    setQueryBusy(true); setQueryErr(null); setQueryResp(null);
    let variables: any = {};
    if (queryVars.trim()) {
      try { variables = JSON.parse(queryVars); } catch (e: any) { setQueryErr(`Variables must be valid JSON: ${e?.message}`); setQueryBusy(false); return; }
    }
    try {
      const r = await fetch(`/api/items/graphql-api/${encodeURIComponent(id)}/query`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: queryText, variables }),
      });
      const j = await r.json();
      if (!j.ok) { setQueryErr(j.error || `HTTP ${r.status}`); return; }
      setQueryResp({ status: j.status, body: j.body });
    } catch (e: any) { setQueryErr(e?.message || String(e)); }
    finally { setQueryBusy(false); }
  }, [id, queryText, queryVars]);

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
      { label: 'Run', actions: [
        { label: queryBusy ? 'Running…' : 'Run query', onClick: runQuery, disabled: queryBusy },
      ]},
      { label: 'Resolvers', actions: [
        { label: 'Edit resolver policies', onClick: () => window.location.assign(`/items/apim-policy/${encodeURIComponent(id)}?scope=api&apiId=${encodeURIComponent(id)}`) },
      ]},
    ]},
  ], [reload, publish, publishing, saving, queryBusy, runQuery, id]);

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
        {/* Subscription required — now a live form control (the deferred ribbon
            button is removed; this persists to Cosmos and is sent on publish). */}
        <Field label="Subscription required (consumers need an APIM subscription key)">
          <Switch
            checked={!!state.subscriptionRequired}
            onChange={(_, d) => setState((p) => ({ ...p, subscriptionRequired: d.checked }))}
            label={state.subscriptionRequired ? 'Yes' : 'No (anonymous)'}
          />
        </Field>
        <Subtitle2 style={{ marginTop: 8 }}>Schema (SDL)</Subtitle2>
        <MonacoTextarea value={state.sdl} onChange={(v) => setState((p) => ({ ...p, sdl: v }))} language="graphql" height={260} minHeight={200} ariaLabel="GraphQL SDL" />
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

        {/* Test query console — runs against the published APIM GraphQL endpoint. */}
        <Subtitle2 style={{ marginTop: 8 }}>Test query console</Subtitle2>
        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Runs against the published APIM GraphQL endpoint. Publish first if you haven&apos;t.</Caption1>
        <MonacoTextarea value={queryText} onChange={setQueryText} language="graphql" height={140} minHeight={100} ariaLabel="GraphQL query" />
        <Caption1>Variables (JSON, optional)</Caption1>
        <Textarea value={queryVars} onChange={(_, d) => setQueryVars(d.value)} rows={2} placeholder={'{ "region": "EU" }'} />
        <Button appearance="primary" onClick={runQuery} disabled={queryBusy} style={{ alignSelf: 'flex-start' }}>{queryBusy ? 'Running…' : 'Run query'}</Button>
        {queryErr && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Query failed</MessageBarTitle>{queryErr}</MessageBarBody></MessageBar>}
        {queryResp && (
          <>
            <Caption1>HTTP {queryResp.status}</Caption1>
            <div className={s.monaco} style={{ whiteSpace: 'pre-wrap', overflow: 'auto', maxHeight: 240 }}>{queryResp.body || '(empty)'}</div>
          </>
        )}

        {/* Resolver authoring is the APIM synthetic-GraphQL set-graphql-resolver
            policy at field scope — honest gate, deep-links to the policy editor. */}
        <MessageBar intent="info">
          <MessageBarBody>
            <MessageBarTitle>Field resolvers</MessageBarTitle>
            GraphQL resolvers are authored as <code>set-graphql-resolver</code> / <code>&lt;http-data-source&gt;</code> policies at the API scope. Use the <strong>Edit resolver policies</strong> ribbon action (opens the apim-policy editor for this API) to map each field to its backend.
          </MessageBarBody>
        </MessageBar>

        <SaveBar
          saving={saving} savedAt={savedAt} error={error} dirty={dirty} onSave={() => save()}
          extraRight={<Button onClick={publish} disabled={publishing || saving}>{publishing ? 'Publishing…' : 'Publish to APIM'}</Button>}
        />
      </div>
    } />
  );
}

// ----- User Data Function (Fabric UDF — code, test/invoke, connections, libraries) -----
const UDF_SAMPLE = `import datetime\nimport fabric.functions as fn\nimport logging\n\nudf = fn.UserDataFunctions()\n\n@udf.function()\ndef compute_score(user_id: str, weight: float = 1.0) -> dict:\n    logging.info('Python UDF trigger function processed a request.')\n    return {"user": user_id, "score": weight * 42}`;
interface UdfLibrary { name: string; version?: string; kind: 'pypi' | 'wheel' }
interface UdfState {
  runtime: 'python';
  entrypoint: string;
  source: string;
  connections: string;
  libraries: UdfLibrary[];
  // Set once the item is published to a Fabric workspace.
  fabricEndpoint?: string;
  fabricWorkspaceId?: string;
  fabricItemId?: string;
  [k: string]: unknown;
}

export function UserDataFunctionEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const { state, setState, loading, saving, error, savedAt, save, reload, dirty } = useItemState<UdfState>('user-data-function', id, {
    runtime: 'python', entrypoint: 'compute_score', source: UDF_SAMPLE, connections: '', libraries: [],
  });

  // Functions parsed from the source — drives the explorer + Test panel.
  const functions = useMemo<UdfFunction[]>(() => parseUdfFunctions(state.source || ''), [state.source]);

  // Test / Run panel.
  const [testFn, setTestFn] = useState('');
  const [testParams, setTestParams] = useState<Record<string, string>>({});
  const [testBusy, setTestBusy] = useState(false);
  const [testOut, setTestOut] = useState<{ ok: boolean; status?: number; body?: string } | null>(null);
  const [testGate, setTestGate] = useState<string | null>(null);
  const selectedFn = functions.find((f) => f.name === testFn) || functions[0];

  // Generate invocation code dialog.
  const [genOpen, setGenOpen] = useState(false);
  const [genTarget, setGenTarget] = useState<'notebook' | 'python' | 'openapi'>('notebook');

  // Library form.
  const [libName, setLibName] = useState('');
  const [libVer, setLibVer] = useState('');
  const [libKind, setLibKind] = useState<'pypi' | 'wheel'>('pypi');

  const addLibrary = () => {
    if (!libName.trim()) return;
    setState((p) => ({ ...p, libraries: [...arr<{ name: string }>(p.libraries), { name: libName.trim(), version: libVer.trim() || undefined, kind: libKind }] }));
    setLibName(''); setLibVer('');
  };
  const removeLibrary = (name: string) => setState((p) => ({ ...p, libraries: arr<{ name: string }>(p.libraries).filter((l) => l.name !== name) }));

  const runTest = useCallback(async () => {
    if (!selectedFn) return;
    setTestBusy(true); setTestOut(null); setTestGate(null);
    // Coerce typed params: numbers/bools parsed, everything else string.
    const parameters: Record<string, unknown> = {};
    for (const p of selectedFn.params) {
      const raw = testParams[p.name] ?? '';
      if (p.type && /int|float|number/i.test(p.type)) parameters[p.name] = raw === '' ? null : Number(raw);
      else if (p.type && /bool/i.test(p.type)) parameters[p.name] = raw === 'true';
      else parameters[p.name] = raw;
    }
    try {
      const r = await fetch(`/api/items/user-data-function/${encodeURIComponent(id)}/invoke`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ functionName: selectedFn.name, parameters }),
      });
      const j = await r.json();
      if (r.status === 409 && j.gated) { setTestGate(j.hint || j.error); return; }
      setTestOut({ ok: j.ok, status: j.status, body: j.body || j.error });
    } catch (e: any) { setTestOut({ ok: false, body: e?.message || String(e) }); }
    finally { setTestBusy(false); }
  }, [id, selectedFn, testParams]);

  const invocationCode = useMemo(() => {
    const fn = selectedFn;
    if (!fn) return '# Add a function to generate invocation code';
    const argList = fn.params.map((p) => `${p.name}=${p.type && /int|float|number/i.test(p.type) ? '0' : '"value"'}`).join(', ');
    if (genTarget === 'notebook') {
      return `# Fabric Notebook (mssparkutils)\nimport notebookutils\nresult = notebookutils.udf.run("${item.displayName || id}", "${fn.name}", { ${fn.params.map((p) => `"${p.name}": "value"`).join(', ')} })\ndisplay(result)`;
    }
    if (genTarget === 'python') {
      return `# Python client (external app)\nimport requests\nfrom azure.identity import DefaultAzureCredential\n\ntoken = DefaultAzureCredential().get_token("https://api.fabric.microsoft.com/.default").token\nresp = requests.post(\n    "<UDF_ENDPOINT>/functions/${fn.name}/invoke",\n    headers={"Authorization": f"Bearer {token}"},\n    json={ ${fn.params.map((p) => `"${p.name}": "value"`).join(', ')} },\n)\nprint(resp.status_code, resp.json())`;
    }
    // OpenAPI fragment for the function.
    const props = fn.params.map((p) => `        "${p.name}": { "type": "${p.type && /int|float|number/i.test(p.type) ? 'number' : p.type && /bool/i.test(p.type) ? 'boolean' : 'string'}" }`).join(',\n');
    return `{\n  "openapi": "3.0.1",\n  "info": { "title": "${item.displayName || id}", "version": "1.0" },\n  "paths": {\n    "/functions/${fn.name}/invoke": {\n      "post": {\n        "operationId": "${fn.name}",\n        "requestBody": { "content": { "application/json": { "schema": {\n          "type": "object",\n          "properties": {\n${props}\n          }\n        } } } },\n        "responses": { "200": { "description": "OK" } }\n      }\n    }\n  }\n}`;
  }, [selectedFn, genTarget, id, item.displayName]);

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Function', actions: [
        { label: 'Reload', onClick: reload },
        { label: saving ? 'Publishing…' : 'Publish', onClick: () => save(), disabled: saving || dirty === false, title: 'Saves source + definition to Cosmos (publish)' },
      ]},
      { label: 'Tools', actions: [
        { label: 'Generate invocation code', onClick: () => setGenOpen(true), disabled: functions.length === 0 },
      ]},
    ]},
  ], [reload, save, saving, dirty, functions.length]);

  return (
    <ItemEditorChrome
      item={item}
      id={id}
      ribbon={ribbon}
      leftPanel={
        <div style={{ padding: 8 }}>
          <Caption1 style={{ padding: '4px 8px', color: tokens.colorNeutralForeground3 }}>Functions ({functions.length})</Caption1>
          {functions.length === 0 && <Body1 style={{ padding: 8, color: tokens.colorNeutralForeground3 }}>No <code>@udf.function()</code> definitions found.</Body1>}
          <Tree aria-label="Functions">
            {functions.map((f) => (
              <TreeItem key={f.name} itemType="leaf" onClick={() => setTestFn(f.name)} style={{ background: f.name === (testFn || functions[0]?.name) ? tokens.colorNeutralBackground2 : undefined }}>
                <TreeItemLayout>
                  <span style={{ fontFamily: 'monospace', fontSize: 12 }}>{f.name}({f.params.map((p) => p.name).join(', ')})</span>
                </TreeItemLayout>
              </TreeItem>
            ))}
          </Tree>
        </div>
      }
      main={
        <div className={s.pad}>
          {loading && <Spinner size="small" label="Loading…" labelPosition="after" />}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Field label="Runtime"><Input value="python (fabric-user-data-functions)" disabled /></Field>
            <Field label="Default entrypoint"><Input value={state.entrypoint} onChange={(_, d) => setState((p) => ({ ...p, entrypoint: d.value }))} /></Field>
          </div>

          <Subtitle2 style={{ marginTop: 8 }}>function_app.py</Subtitle2>
          <MonacoTextarea value={state.source} onChange={(v) => setState((p) => ({ ...p, source: v }))} language="python" height={280} minHeight={200} ariaLabel="Function source" />

          {/* Test / Run panel */}
          <Subtitle2 style={{ marginTop: 8 }}>Test / Run</Subtitle2>
          <div style={{ border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 6, padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <Field label="Function">
              <Dropdown
                placeholder={functions.length ? 'Select a function' : 'No functions to run'}
                value={selectedFn?.name || ''}
                selectedOptions={selectedFn ? [selectedFn.name] : []}
                onOptionSelect={(_, d) => { setTestFn(d.optionValue || ''); setTestParams({}); }}
              >
                {functions.map((f) => <Option key={f.name} value={f.name}>{f.name}</Option>)}
              </Dropdown>
            </Field>
            {selectedFn?.params.map((p) => (
              <Field key={p.name} label={`${p.name}${p.type ? ` : ${p.type}` : ''}${p.default ? ` (default ${p.default})` : ''}`}>
                <Input value={testParams[p.name] ?? ''} onChange={(_, d) => setTestParams((cur) => ({ ...cur, [p.name]: d.value }))} placeholder={p.default || ''} />
              </Field>
            ))}
            <Button appearance="primary" onClick={runTest} disabled={testBusy || !selectedFn} style={{ alignSelf: 'flex-start' }}>{testBusy ? 'Running…' : 'Run'}</Button>
            {testGate && (
              <MessageBar intent="warning"><MessageBarBody><MessageBarTitle>Function not published yet</MessageBarTitle>{testGate}</MessageBarBody></MessageBar>
            )}
            {testOut && (
              <>
                <Caption1>Output {testOut.status != null ? `(HTTP ${testOut.status})` : ''}</Caption1>
                <div className={s.monaco} style={{ whiteSpace: 'pre-wrap', overflow: 'auto', maxHeight: 200 }}>{testOut.body || '(empty)'}</div>
              </>
            )}
          </div>

          {/* Manage connections */}
          <Subtitle2 style={{ marginTop: 8 }}>Manage connections (Fabric data sources)</Subtitle2>
          <Input value={state.connections} onChange={(_, d) => setState((p) => ({ ...p, connections: d.value }))} placeholder="fin-warehouse, ldn-gold-lakehouse" />

          {/* Library management */}
          <Subtitle2 style={{ marginTop: 8 }}>Library management</Subtitle2>
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <Field label="Package"><Input value={libName} onChange={(_, d) => setLibName(d.value)} placeholder="numpy" /></Field>
            <Field label="Version"><Input value={libVer} onChange={(_, d) => setLibVer(d.value)} placeholder="2.0.0" style={{ width: 120 }} /></Field>
            <Field label="Type">
              <Dropdown value={libKind} selectedOptions={[libKind]} onOptionSelect={(_, d) => d.optionValue && setLibKind(d.optionValue as 'pypi' | 'wheel')}>
                <Option value="pypi">PyPI</Option>
                <Option value="wheel">Private wheel</Option>
              </Dropdown>
            </Field>
            <Button onClick={addLibrary} disabled={!libName.trim()}>Add library</Button>
          </div>
          <Table size="small" aria-label="Libraries">
            <TableHeader><TableRow><TableHeaderCell>Package</TableHeaderCell><TableHeaderCell>Version</TableHeaderCell><TableHeaderCell>Type</TableHeaderCell><TableHeaderCell /></TableRow></TableHeader>
            <TableBody>
              {arr<{ name: string; version?: string; kind: string }>(state.libraries).length === 0 && <TableRow><TableCell>No libraries added.</TableCell><TableCell /><TableCell /><TableCell /></TableRow>}
              {arr<{ name: string; version?: string; kind: string }>(state.libraries).map((l) => (
                <TableRow key={l.name}>
                  <TableCell><strong>{l.name}</strong></TableCell>
                  <TableCell>{l.version || 'latest'}</TableCell>
                  <TableCell>{l.kind}</TableCell>
                  <TableCell><Button size="small" onClick={() => removeLibrary(l.name)}>Remove</Button></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          <SaveBar saving={saving} savedAt={savedAt} error={error} dirty={dirty} onSave={() => save()} />

          {/* Generate invocation code dialog */}
          <Dialog open={genOpen} onOpenChange={(_, d) => { if (!d.open) setGenOpen(false); }}>
            <DialogSurface style={{ maxWidth: '90vw', width: 760 }}>
              <DialogBody>
                <DialogTitle>Generate invocation code — {selectedFn?.name}</DialogTitle>
                <DialogContent>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    <TabList selectedValue={genTarget} onTabSelect={(_, d) => setGenTarget(d.value as typeof genTarget)}>
                      <Tab value="notebook">Notebook</Tab>
                      <Tab value="python">Python client</Tab>
                      <Tab value="openapi">OpenAPI</Tab>
                    </TabList>
                    <div className={s.monaco} style={{ whiteSpace: 'pre-wrap', overflow: 'auto', maxHeight: 320 }}>{invocationCode}</div>
                    <Button onClick={() => navigator.clipboard?.writeText(invocationCode).catch(() => {})}>Copy</Button>
                  </div>
                </DialogContent>
                <DialogActions>
                  <Button onClick={() => setGenOpen(false)}>Close</Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>
        </div>
      }
    />
  );
}

// ----- Variable Library (Cosmos, typed key/value with value sets) -----
// v3.27: extended to Fabric's 7 variable types — String/Integer/Number/
// Boolean/DateTime/Guid/ItemReference/ConnectionReference. Plus the
// Loom-native `secret-ref` for KV / env-var lookups.
// `VarType` is imported from `_family-utils` (see the top-of-file
// import block — it matches the vitest contract).
interface VarDef { name: string; type: VarType; default: string; dev?: string; test?: string; prod?: string; description?: string; }
// `activeValueSet` mirrors Fabric's per-workspace active value set (settings.json).
interface VlState { variables: VarDef[]; activeValueSet?: string; [k: string]: unknown }
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
      const next = [...arr<VarDef>(prev.variables)];
      next[idx] = { ...next[idx], ...patch };
      return { ...prev, variables: next };
    });
  };
  const addRow = () => setState((prev) => {
    const cur = arr<VarDef>(prev.variables);
    return { ...prev, variables: [...cur, { name: `var${cur.length + 1}`, type: 'string', default: '' }] };
  });
  const deleteRow = (idx: number) => setState((prev) => ({
    ...prev,
    variables: arr<VarDef>(prev.variables).filter((_, i) => i !== idx),
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
          {/* Active value set — mirrors Fabric's per-workspace active set. The
              runtime executor reads state.activeValueSet to resolve values. */}
          <Field label="Active value set (resolved at runtime)">
            <Dropdown
              value={state.activeValueSet || 'default'}
              selectedOptions={[state.activeValueSet || 'default']}
              onOptionSelect={(_, d) => d.optionValue && setState((p) => ({ ...p, activeValueSet: d.optionValue }))}
            >
              {VL_VALUE_SETS.map((v) => <Option key={v} value={v}>{v}{v === (state.activeValueSet || 'default') ? ' (active)' : ''}</Option>)}
            </Dropdown>
          </Field>
          <Table aria-label="Variables" size="small">
            <TableHeader><TableRow>
              <TableHeaderCell>Name</TableHeaderCell>
              <TableHeaderCell>Type</TableHeaderCell>
              <TableHeaderCell>Value ({tab})</TableHeaderCell>
              <TableHeaderCell>Description</TableHeaderCell>
              <TableHeaderCell />
            </TableRow></TableHeader>
            <TableBody>
              {arr<VarDef>(state.variables).map((v, i) => {
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

// Render the parsed ontology class hierarchy as an IS_A force-directed graph.
function OntologyHierarchyViz({ classes }: { classes: { name: string; parent?: string; description?: string }[] }) {
  const g = useMemo(() => {
    const ids = new Set(classes.map((c) => c.name));
    const nodes = classes.map((c) => ({ id: c.name, label: c.name }));
    const edges = classes
      .filter((c) => c.parent && ids.has(c.parent))
      .map((c) => ({ source: c.name, target: c.parent as string, label: 'is_a' }));
    return { nodes, edges };
  }, [classes]);
  if (g.nodes.length === 0) return <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Add a class to see the hierarchy graph.</Caption1>;
  return <ForceDirectedGraph nodes={g.nodes} edges={g.edges} width={320} height={260} />;
}

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
            <Subtitle2 style={{ marginTop: 12 }}>Hierarchy graph</Subtitle2>
            <OntologyHierarchyViz classes={classes} />
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

// Derive a force-directed graph from the graph-model schema: one node per
// node type, one edge per edge type. Edges that recorded srcType/dstType
// connect the right node types; otherwise they fan from the first node type.
function GraphModelSchemaViz({ nodes, edges }: { nodes: GraphDecl[]; edges: GraphDecl[] }) {
  const g = useMemo(() => {
    const vizNodes = nodes.map((n) => ({ id: n.name, label: n.name }));
    const ids = new Set(vizNodes.map((n) => n.id));
    const vizEdges = edges.map((e) => {
      const src = e.properties?.find((p) => p.name === 'srcType')?.type;
      const dst = e.properties?.find((p) => p.name === 'dstType')?.type;
      // srcType/dstType were stored as property *types* in the add dialog when
      // a from/to node was chosen; fall back to first/last node type.
      const source = (src && ids.has(src) ? src : nodes[0]?.name) || e.name;
      const target = (dst && ids.has(dst) ? dst : nodes[nodes.length - 1]?.name) || e.name;
      return { source, target, label: e.name };
    });
    return { nodes: vizNodes, edges: vizEdges };
  }, [nodes, edges]);
  if (g.nodes.length === 0) return <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Add a node type to see the schema graph.</Caption1>;
  return <ForceDirectedGraph nodes={g.nodes} edges={g.edges} height={300} />;
}

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
    if (arr<{ name: string }>(state.nodes).some((n) => n.name === name)) { setDlgErr(`Entity "${name}" already exists.`); return; }
    persistIfExisting({ ...state, nodes: [...arr(state.nodes), { name, properties: parseProps(propsText) }] });
    setNodeDlgOpen(false);
  }, [newName, propsText, state, id, setState, save]);

  const addRelationship = useCallback(() => {
    const name = newName.trim();
    if (!/^[A-Za-z_][\w]*$/.test(name)) { setDlgErr('Relationship name must start with a letter/underscore (letters, digits, _).'); return; }
    if (arr<{ name: string }>(state.edges).some((e) => e.name === name)) { setDlgErr(`Relationship "${name}" already exists.`); return; }
    const props = parseProps(propsText);
    // src/dst node types captured as edge properties so the materialize step +
    // queries can reference the connected node types.
    if (edgeSrc.trim()) props.unshift({ name: 'srcType', type: 'string' });
    if (edgeDst.trim()) props.unshift({ name: 'dstType', type: 'string' });
    persistIfExisting({ ...state, edges: [...arr(state.edges), { name, properties: props }] });
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
        body: JSON.stringify({ database: state.database, nodes: arr(state.nodes), edges: arr(state.edges) }),
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
        <Subtitle2 style={{ marginTop: 8 }}>Schema graph</Subtitle2>
        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
          Node types are vertices; edge types whose properties carry <code>srcType</code> / <code>dstType</code> connect them, others link to a shared hub.
        </Caption1>
        <GraphModelSchemaViz nodes={arr(state.nodes)} edges={arr(state.edges)} />
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
                      {arr<{ name: string }>(state.nodes).map((n) => <Option key={n.name} value={n.name}>{n.name}</Option>)}
                    </Dropdown>
                  </Field>
                  <Field label="To entity">
                    <Dropdown value={edgeDst} selectedOptions={edgeDst ? [edgeDst] : []} onOptionSelect={(_, d) => setEdgeDst(d.optionValue || '')} placeholder="(optional)">
                      {arr<{ name: string }>(state.nodes).map((n) => <Option key={n.name} value={n.name}>{n.name}</Option>)}
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
      const next = [...arr<PlanTask>(prev.tasks)];
      next[idx] = { ...next[idx], ...patch };
      return { ...prev, tasks: next };
    });
  };
  const add = () => setState((prev) => ({
    ...prev,
    tasks: [...arr<PlanTask>(prev.tasks), { title: '', owner: '', due: '', status: 'todo' }],
  }));
  const remove = (idx: number) => setState((prev) => ({
    ...prev,
    tasks: arr<PlanTask>(prev.tasks).filter((_, i) => i !== idx),
  }));

  // v3.27: D-upgrade — compute and surface progress + overdue counts.
  const taskList = arr<PlanTask>(state.tasks);
  const counts = taskList.reduce(
    (acc, t) => { acc[t.status] = (acc[t.status] || 0) + 1; return acc; },
    {} as Record<PlanTask['status'], number>,
  );
  const todo = counts.todo || 0;
  const doing = counts.doing || 0;
  const done = counts.done || 0;
  const total = taskList.length;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const today = new Date().toISOString().slice(0, 10);
  const overdue = taskList.filter(t => t.status !== 'done' && t.due && t.due < today).length;

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
            {taskList.map((t, i) => (
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
  let parsedGeo: unknown = null;
  // bbox + zoom computed via `_family-utils` (vitest-covered).
  let bbox: { minLon: number; maxLon: number; minLat: number; maxLat: number } | null = null;
  try {
    const j = JSON.parse(state.geojson);
    parsedGeo = j;
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
          <MessageBar intent="info">
            <MessageBarBody>
              <MessageBarTitle>Vector overlay rendered offline</MessageBarTitle>
              The GeoJSON features render as a live SVG overlay below — no Azure Maps account required. To layer an
              Azure Maps raster basemap <em>behind</em> the overlay, set <code>NEXT_PUBLIC_LOOM_AZURE_MAPS_KEY</code> in
              the Container App env to a key from a <code>Microsoft.Maps/accounts</code> resource.
            </MessageBarBody>
          </MessageBar>
        )}
        <Subtitle2>GeoJSON ({featureCount} feature{featureCount === 1 ? '' : 's'})</Subtitle2>
        <MonacoTextarea value={state.geojson} onChange={(v) => setState((p) => ({ ...p, geojson: v }))} language="json" height={280} minHeight={200} ariaLabel="GeoJSON" />
        {parseErr && <MessageBar intent="error"><MessageBarBody>Invalid JSON: {parseErr}</MessageBarBody></MessageBar>}
        {validateMsg && <MessageBar intent={validateMsg.intent}><MessageBarBody>{validateMsg.text}</MessageBarBody></MessageBar>}
        {!parseErr && (
          <>
            <Subtitle2>Map{tileUrl ? ` (Azure Maps basemap · zoom ${zoom}, center ${centerLat.toFixed(3)}, ${centerLon.toFixed(3)})` : ' (vector overlay)'}</Subtitle2>
            <GeoJsonMap geojson={parsedGeo} rasterUrl={tileUrl} />
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

// ----- Data Agent — typed five-source picker + per-source grounding +
// real grounded test chat + publish to Foundry Agent Service + Copilot
// Studio handoff. Backed by:
//   PATCH /api/items/data-agent/[id]            (Cosmos persist)
//   POST  /api/items/data-agent/[id]/chat       (live AOAI grounded chat)
//   POST  /api/items/data-agent/[id]/publish    (Foundry Agent Service)
//   GET   /api/items/by-type?types=...          (typed source picker)
interface DataAgentState {
  instructions: string;
  sources: DaSource[];
  description?: string;
  // Back-compat with the legacy free-text bag (read-only on load).
  systemPrompt?: string; model?: string;
  foundryAgentId?: string; foundryProjectId?: string; publishedAt?: string;
  lastDeployedAt?: string;
  [k: string]: unknown;
}

const DA_SOURCE_TYPES: { value: DaSourceType; label: string; itemType: string }[] = [
  { value: 'warehouse', label: 'Warehouse', itemType: 'warehouse' },
  { value: 'lakehouse', label: 'Lakehouse', itemType: 'lakehouse' },
  { value: 'kql', label: 'KQL database', itemType: 'kql-database' },
  { value: 'semantic-model', label: 'Semantic model', itemType: 'semantic-model' },
  { value: 'ai-search', label: 'AI Search', itemType: 'ai-search-index' },
  { value: 'ontology', label: 'Ontology', itemType: 'ontology' },
  { value: 'graph', label: 'Graph model', itemType: 'graph-model' },
];
// Schema-selection label per type (Fabric exposes Tables/Views/Functions for
// SQL + Eventhouse, model name for semantic models, none for graph/ontology).
const DA_SCHEMA_LABEL: Record<DaSourceType, string> = {
  warehouse: 'Tables / views / functions in scope (comma-separated)',
  lakehouse: 'Tables in scope (comma-separated)',
  kql: 'Tables / materialized views / functions in scope (comma-separated)',
  'semantic-model': 'Tables / model in scope (comma-separated)',
  'ai-search': 'Index fields in scope (optional, comma-separated)',
  ontology: 'Ontology is queried whole — no table scoping',
  graph: 'Graph is queried whole — no node/edge scoping',
};
const DA_INSTRUCTION_TEMPLATE = '## General knowledge\n\n## Table descriptions\n\n## When asked about\n';

// `normalizeDaSources` / `guessDaSourceType` / DaSource(Type) are imported from
// `_family-utils` (vitest coverage at lib/editors/__tests__/family-utils.test.ts)
// so the legacy-string migration is unit-tested without the Fluent UI bundle.

interface DaChatMsg { role: 'user' | 'assistant'; content: string; query?: string; sourceUsed?: string; error?: boolean; usage?: { totalTokens?: number }; model?: string }

export function DataAgentEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const { state, setState, loading, saving, error, savedAt, save, reload, dirty } = useItemState<DataAgentState>('data-agent', id, {
    instructions: 'Route financial / aggregated metrics to the semantic model; raw exploration to the lakehouse / warehouse; log analysis to the KQL database.',
    sources: [],
    description: '',
  });
  const [tab, setTab] = useState<'build' | 'test' | 'publish' | 'inspect'>('build');

  // ---- source picker data (real Loom items) ----
  const [pickerType, setPickerType] = useState<DaSourceType>('warehouse');
  const [available, setAvailable] = useState<Record<string, { id: string; name: string }[]>>({});
  const [pickerLoading, setPickerLoading] = useState(false);
  const loadAvailable = useCallback(async (t: DaSourceType) => {
    const cfg = DA_SOURCE_TYPES.find((x) => x.value === t)!;
    setPickerLoading(true);
    try {
      const r = await fetch(`/api/items/by-type?types=${encodeURIComponent(cfg.itemType)}`);
      const j = await r.json();
      const items = (j.items || []).map((it: any) => ({ id: it.id, name: it.displayName || it.id }));
      setAvailable((prev) => ({ ...prev, [t]: items }));
    } catch { /* leave empty; user can still pick another type */ }
    finally { setPickerLoading(false); }
  }, []);
  useEffect(() => { if (!available[pickerType]) loadAvailable(pickerType); }, [pickerType, available, loadAvailable]);

  const [pickSel, setPickSel] = useState('');
  const addSource = () => {
    if (!pickSel || arr<DaSource>(state.sources).length >= 5) return;
    const opts = available[pickerType] || [];
    const chosen = opts.find((o) => o.id === pickSel);
    setState((p) => ({
      ...p,
      sources: [...arr<DaSource>(p.sources), {
        id: `${pickerType}:${pickSel}:${Date.now()}`,
        type: pickerType,
        name: chosen?.name || pickSel,
        tables: '', description: '', instructions: DA_INSTRUCTION_TEMPLATE, examples: [],
      }],
    }));
    setPickSel('');
  };
  const updateSource = (sid: string, patch: Partial<DaSource>) => {
    setState((p) => ({ ...p, sources: arr<DaSource>(p.sources).map((x) => x.id === sid ? { ...x, ...patch } : x) }));
  };
  const removeSource = (sid: string) => setState((p) => ({ ...p, sources: arr<DaSource>(p.sources).filter((x) => x.id !== sid) }));
  const updateSourceExamples = (sid: string, fn: (ex: { question: string; query: string }[]) => { question: string; query: string }[]) => {
    setState((p) => ({ ...p, sources: arr<DaSource>(p.sources).map((x) => x.id === sid ? { ...x, examples: fn(arr(x.examples)) } : x) }));
  };
  const addExample = (sid: string) => updateSourceExamples(sid, (ex) => [...ex, { question: '', query: '' }]);

  // ---- test chat ----
  const [chat, setChat] = useState<DaChatMsg[]>([]);
  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
  const threadRef = useRef<HTMLDivElement | null>(null);
  // Keep the latest turn in view as the thread grows / a turn lands.
  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat, asking]);
  const canSend = canSendDaQuestion(question, asking);
  const ask = useCallback(async () => {
    const q = question.trim();
    if (!q || asking) return;
    if (dirty) await save();
    // Build history from the thread BEFORE we append the new user turn.
    const history = shapeDaHistory(chat);
    setChat((c) => [...c, { role: 'user', content: q }]);
    setQuestion(''); setAsking(true);
    try {
      const r = await fetch(`/api/items/data-agent/${encodeURIComponent(id)}/chat`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: q, history }),
      });
      // Content-type guard: a 404/500 returns an HTML page, not JSON — calling
      // r.json() on that throws "Unexpected token <" and the answer is lost.
      const res = await safeModelJson<{ answer?: string; query?: string; sourceUsed?: string; hint?: string; usage?: { totalTokens?: number }; model?: string }>(r);
      const j = res.data;
      if (res.ok && j) {
        setChat((c) => [...c, { role: 'assistant', content: String(j.answer ?? ''), query: j.query, sourceUsed: j.sourceUsed, usage: j.usage, model: j.model }]);
      } else {
        const detail = res.error || j?.error || `HTTP ${res.status}`;
        const hint = j?.hint ? `\n\n${j.hint}` : '';
        setChat((c) => [...c, { role: 'assistant', content: `${detail}${hint}`, error: true }]);
      }
    } catch (e: any) {
      setChat((c) => [...c, { role: 'assistant', content: e?.message || String(e), error: true }]);
    } finally { setAsking(false); }
  }, [question, asking, chat, dirty, save, id]);

  // ---- publish ----
  const [publishing, setPublishing] = useState(false);
  const [publishResult, setPublishResult] = useState<any>(null);
  const publish = useCallback(async () => {
    setPublishing(true); setPublishResult(null);
    try {
      const saved = await save();
      if (!saved) { setPublishResult({ ok: false, error: 'Save failed before publish.' }); return; }
      const r = await fetch(`/api/items/data-agent/${encodeURIComponent(id)}/publish`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ description: state.description }),
      });
      const j = await r.json();
      setPublishResult(j);
      if (j.ok) await reload();
    } catch (e: any) { setPublishResult({ ok: false, error: e?.message || String(e) }); }
    finally { setPublishing(false); }
  }, [id, save, reload, state.description]);

  // ---- run-steps inspector (debug a PUBLISHED agent via the Foundry Agent Service) ----
  const [inspectAgent, setInspectAgent] = useState('');
  const [inspectQuestion, setInspectQuestion] = useState('');
  const [inspecting, setInspecting] = useState(false);
  const [inspectResult, setInspectResult] = useState<any>(null);
  const [inspectGate, setInspectGate] = useState<string | null>(null);
  // Prefill the agent name from the last publish (artifactId) when available.
  useEffect(() => {
    if (publishResult?.artifactId && !inspectAgent) setInspectAgent(String(publishResult.artifactId));
  }, [publishResult, inspectAgent]);
  const runInspect = useCallback(async () => {
    const agent = inspectAgent.trim(); const q = inspectQuestion.trim();
    // The agent name is OPTIONAL now — without a published Foundry agent the
    // inspector runs the Azure-native grounded backend over this item's sources
    // (no Microsoft Fabric / published asst_ required). Only the question + the
    // item id are needed.
    if (!q || inspecting) return;
    setInspecting(true); setInspectResult(null); setInspectGate(null);
    try {
      const r = await fetch('/api/data-agent/run-steps', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agent: agent || undefined, question: q, id }),
      });
      const j = await r.json();
      if (r.status === 501 || j?.code === 'not_configured') { setInspectGate(j?.hint || j?.error || 'No AOAI model deployed. Deploy one from the AI Foundry hub.'); return; }
      setInspectResult(j);
    } catch (e: any) { setInspectResult({ ok: false, error: e?.message || String(e) }); }
    finally { setInspecting(false); }
  }, [inspectAgent, inspectQuestion, inspecting, id]);

  // One-time migration: if a legacy record persisted `sources` as a string (or
  // any non-array shape), rewrite state to a clean DaSource[] so the agent both
  // renders AND can be re-saved in the new schema. Runs after load settles.
  useEffect(() => {
    if (loading) return;
    if (state.sources !== undefined && !Array.isArray(state.sources)) {
      const migrated = normalizeDaSources(state.sources);
      setState((p) => ({ ...p, sources: migrated }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, state.sources]);

  const sources = normalizeDaSources(state.sources);
  const instrLen = (typeof state.instructions === 'string' ? state.instructions : '').length;
  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Agent', actions: [
        { label: saving ? 'Saving…' : 'Save', onClick: () => save(), disabled: saving || dirty === false },
        { label: 'Build', onClick: () => setTab('build') },
        { label: 'Test chat', onClick: () => setTab('test') },
        { label: 'Publish', onClick: () => setTab('publish') },
        { label: 'Run inspector', onClick: () => setTab('inspect') },
      ]},
    ]},
  ], [save, saving, dirty]);

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon} main={
      <>
        <div className={s.tabBar}>
          <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as typeof tab)}>
            <Tab value="build">Build ({sources.length}/5 sources)</Tab>
            <Tab value="test">Test chat</Tab>
            <Tab value="publish">Publish</Tab>
            <Tab value="inspect">Run inspector</Tab>
          </TabList>
        </div>
        <div className={s.pad}>
          {loading && <Spinner size="small" label="Loading…" labelPosition="after" />}

          {tab === 'build' && (
            <>
              <Subtitle2>Agent instructions ({instrLen}/15000)</Subtitle2>
              <Textarea
                value={state.instructions} maxLength={15000} rows={5}
                onChange={(_, d) => setState((p) => ({ ...p, instructions: d.value }))}
                placeholder="Declare which source handles which question type…"
              />

              <Subtitle2 style={{ marginTop: 8 }}>Data sources ({sources.length}/5)</Subtitle2>
              <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                <Field label="Type">
                  <Dropdown value={DA_SOURCE_TYPES.find((t) => t.value === pickerType)?.label} selectedOptions={[pickerType]}
                    onOptionSelect={(_, d) => { if (d.optionValue) { setPickerType(d.optionValue as DaSourceType); setPickSel(''); } }}>
                    {DA_SOURCE_TYPES.map((t) => <Option key={t.value} value={t.value}>{t.label}</Option>)}
                  </Dropdown>
                </Field>
                <Field label="Item">
                  <Dropdown value={(available[pickerType] || []).find((o) => o.id === pickSel)?.name || ''} selectedOptions={pickSel ? [pickSel] : []}
                    placeholder={pickerLoading ? 'Loading…' : ((available[pickerType] || []).length ? 'Select…' : 'None found')}
                    onOptionSelect={(_, d) => d.optionValue && setPickSel(d.optionValue)}>
                    {(available[pickerType] || []).map((o) => <Option key={o.id} value={o.id}>{o.name}</Option>)}
                  </Dropdown>
                </Field>
                <Button appearance="primary" onClick={addSource} disabled={!pickSel || sources.length >= 5}>+ Add source</Button>
              </div>

              {sources.map((src) => (
                <div key={src.id} className={s.card}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Badge appearance="tint" color="brand">{DA_SOURCE_TYPES.find((t) => t.value === src.type)?.label || src.type}</Badge>
                    <strong>{src.name}</strong>
                    <div style={{ flex: 1 }} />
                    <Button size="small" onClick={() => removeSource(src.id)}>Remove</Button>
                  </div>
                  <Caption1 style={{ marginTop: 6 }}>Data source description (helps the agent route questions to this source)</Caption1>
                  <Input value={src.description || ''} onChange={(_, d) => updateSource(src.id, { description: d.value })} placeholder="Finance facts: revenue, margin, bookings by region & quarter." />
                  <Caption1 style={{ marginTop: 6 }}>{DA_SCHEMA_LABEL[src.type]}</Caption1>
                  {src.type === 'ontology' || src.type === 'graph' ? (
                    <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                      Fabric does not scope {src.type === 'graph' ? 'graphs to specific nodes/edges' : 'ontologies to subsets'}; the whole source is queried.
                    </Caption1>
                  ) : (
                    <Input value={src.tables || ''} onChange={(_, d) => updateSource(src.id, { tables: d.value })} placeholder="dim_date, fact_sales" />
                  )}
                  <Caption1 style={{ marginTop: 6 }}>Data source instructions</Caption1>
                  <Textarea value={src.instructions || ''} rows={4} onChange={(_, d) => updateSource(src.id, { instructions: d.value })} />
                  {daSupportsExampleQueries(src.type) ? (
                    <>
                      <Caption1 style={{ marginTop: 6 }}>Example question → query pairs (few-shot)</Caption1>
                      {arr<{ question: string; query: string }>(src.examples).map((ex, i) => (
                        <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 6, marginBottom: 4 }}>
                          <Input value={ex.question} placeholder="question" onChange={(_, d) => updateSourceExamples(src.id, (arr) => arr.map((e, j) => j === i ? { ...e, question: d.value } : e))} />
                          <Input value={ex.query} placeholder="SQL / KQL / GQL" onChange={(_, d) => updateSourceExamples(src.id, (arr) => arr.map((e, j) => j === i ? { ...e, query: d.value } : e))} />
                          <Button size="small" onClick={() => updateSourceExamples(src.id, (arr) => arr.filter((_, j) => j !== i))}>×</Button>
                        </div>
                      ))}
                      <Button size="small" onClick={() => addExample(src.id)}>+ Example</Button>
                    </>
                  ) : (
                    <Caption1 style={{ marginTop: 6, color: tokens.colorNeutralForeground3 }}>
                      {src.type === 'semantic-model'
                        ? 'Fabric does not support example queries for semantic models — author Verified Answers via Power BI “Prep for AI” instead.'
                        : 'Fabric does not support example queries for ontologies.'}
                    </Caption1>
                  )}
                </div>
              ))}
              {sources.length === 0 && (
                <MessageBar intent="info"><MessageBarBody>Attach up to five typed sources. Each becomes a grounded tool for the agent. The test chat and Publish both require at least one.</MessageBarBody></MessageBar>
              )}
              <SaveBar saving={saving} savedAt={savedAt} error={error} dirty={dirty} onSave={() => save()} />
            </>
          )}

          {tab === 'test' && (
            <div className={s.chatShell}>
              <div className={s.chatHead}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Subtitle2>Test chat</Subtitle2>
                  <Badge appearance="tint" color="brand">live · grounded</Badge>
                  <div style={{ flex: 1 }} />
                  <Button size="small" appearance="subtle" onClick={() => { setChat([]); setQuestion(''); }} disabled={asking || (chat.length === 0 && !question)}>+ New thread</Button>
                </div>
                <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                  Each turn runs against the live AOAI deployment on the Foundry hub, grounded on the {sources.length} source{sources.length === 1 ? '' : 's'} + instructions in Build.
                </Caption1>
                {sources.length === 0 && (
                  <MessageBar intent="warning"><MessageBarBody>No data sources attached yet — answers will be ungrounded. Add at least one source in the <strong>Build</strong> tab for real grounded responses.</MessageBarBody></MessageBar>
                )}
              </div>

              <div ref={threadRef} className={s.chatThread} aria-live="polite">
                {chat.length === 0 && !asking && (
                  <div style={{ margin: 'auto', textAlign: 'center', color: tokens.colorNeutralForeground3 }}>
                    <Body1 style={{ display: 'block', marginBottom: 4 }}>Ask the agent a question to start a thread.</Body1>
                    <Caption1>e.g. “What was total revenue by region last quarter?”</Caption1>
                  </div>
                )}
                {chat.map((m, i) => (
                  <div key={i} className={m.role === 'user' ? s.chatRowUser : s.chatRowBot}>
                    <span className={s.chatMeta}>{m.role === 'user' ? 'You' : m.error ? 'Agent · error' : 'Agent'}{m.sourceUsed && !m.error ? ` · source: ${m.sourceUsed}` : ''}{m.model && !m.error ? ` · ${m.model}` : ''}{m.usage?.totalTokens && !m.error ? ` · ${m.usage.totalTokens} tokens` : ''}</span>
                    <div className={m.role === 'user' ? s.bubbleUser : m.error ? s.bubbleErr : s.bubbleBot}>
                      {m.content || (m.error ? 'Unknown error' : '')}
                    </div>
                    {m.query && (
                      <details style={{ marginTop: 2 }}>
                        <summary style={{ cursor: 'pointer', fontSize: 12, color: tokens.colorNeutralForeground2 }}>Generated query{m.sourceUsed ? ` · ${m.sourceUsed}` : ''}</summary>
                        <pre className={s.chatSource}>{m.query}</pre>
                      </details>
                    )}
                  </div>
                ))}
                {asking && (
                  <div className={s.chatRowBot}>
                    <span className={s.chatMeta}>Agent</span>
                    <div className={s.bubbleBot} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <Spinner size="tiny" /> Thinking…
                    </div>
                  </div>
                )}
              </div>

              <div className={s.chatComposer}>
                <Textarea
                  value={question}
                  onChange={(_, d) => setQuestion(d.value)}
                  placeholder="Ask the agent…  (Enter to send · Shift+Enter for a new line)"
                  resize="none"
                  rows={2}
                  textarea={{ style: { maxHeight: 120, overflowY: 'auto' } }}
                  style={{ flex: 1 }}
                  disabled={asking}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      if (canSend) ask();
                    }
                  }}
                />
                <Button appearance="primary" onClick={ask} disabled={!canSend}>{asking ? 'Sending…' : 'Send'}</Button>
              </div>
            </div>
          )}

          {tab === 'publish' && (
            <>
              <Subtitle2>Publish to Foundry Agent Service</Subtitle2>
              <Caption1>Publishing upserts a prompt-agent (instructions + typed sources as tools) into the Foundry project. Consumers (Foundry agents, Copilot Studio) read the description to decide when to call this agent.</Caption1>
              <Caption1 style={{ marginTop: 6 }}>Description (orchestrators see this)</Caption1>
              <Textarea value={state.description || ''} rows={3} onChange={(_, d) => setState((p) => ({ ...p, description: d.value }))} placeholder="Answers finance questions grounded on the FY warehouse + revenue semantic model." />
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <Button appearance="primary" onClick={publish} disabled={publishing || saving || sources.length === 0}>{publishing ? 'Publishing…' : 'Publish'}</Button>
              </div>
              {state.publishedAt && (
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 6 }}>
                  <Badge appearance="filled" color="success">published</Badge>
                  <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{new Date(state.publishedAt).toLocaleString()}</Caption1>
                </div>
              )}
              {publishResult && (
                <MessageBar intent={publishResult.ok ? 'success' : publishResult.deferred ? 'warning' : 'error'}>
                  <MessageBarBody>
                    <MessageBarTitle>
                      {publishResult.ok ? 'Published' : publishResult.deferred ? 'Foundry Agent Service not configured' : 'Publish failed'}
                    </MessageBarTitle>
                    {publishResult.ok && (
                      <div style={{ marginTop: 4 }}>
                        Connect from Foundry / Copilot Studio with this GUID pair (mark both as secrets):
                        <div style={{ fontFamily: 'monospace', fontSize: 12, marginTop: 4 }}>
                          workspace-id (project): <strong>{publishResult.workspaceId}</strong><br />
                          artifact-id (agent): <strong>{publishResult.artifactId}</strong>
                        </div>
                        <Caption1 style={{ marginTop: 6, display: 'block' }}>
                          Copilot Studio: Agents → + Add → Microsoft Fabric → pick this published agent.
                          Foundry: Management Center → Connected resources → new Microsoft Fabric connection.
                        </Caption1>
                      </div>
                    )}
                    {publishResult.error && <div>{publishResult.error}</div>}
                    {publishResult.hint && <div style={{ marginTop: 4 }}><em>Hint:</em> {publishResult.hint}</div>}
                  </MessageBarBody>
                </MessageBar>
              )}
            </>
          )}

          {tab === 'inspect' && (
            <>
              <Subtitle2>Run-steps inspector</Subtitle2>
              <Caption1>Run a question through a PUBLISHED Foundry agent and trace the run steps it executed (tool calls / queries / message creation). Requires the agent to be published and LOOM_FOUNDRY_PROJECT_ENDPOINT configured.</Caption1>
              {inspectGate && (
                <MessageBar intent="warning" style={{ marginTop: 8 }}>
                  <MessageBarBody>
                    <MessageBarTitle>Foundry Agent Service not configured</MessageBarTitle>
                    <div>{inspectGate}</div>
                  </MessageBarBody>
                </MessageBar>
              )}
              <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap', marginTop: 8 }}>
                <Field label="Published agent (name / artifact id)">
                  <Input value={inspectAgent} onChange={(_, d) => setInspectAgent(d.value)} placeholder="from Publish (artifact-id)" style={{ minWidth: 300 }} />
                </Field>
              </div>
              <Textarea value={inspectQuestion} rows={2} onChange={(_, d) => setInspectQuestion(d.value)} placeholder="Ask a question to trace through the agent…" style={{ marginTop: 8 }} />
              <div style={{ marginTop: 8 }}>
                <Button appearance="primary" onClick={runInspect} disabled={inspecting || !inspectAgent.trim() || !inspectQuestion.trim()}>{inspecting ? 'Running…' : 'Run + inspect'}</Button>
              </div>
              {inspectResult && inspectResult.ok && inspectResult.data && (
                <div style={{ marginTop: 12 }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <Badge appearance="filled" color={inspectResult.data.status === 'completed' ? 'success' : inspectResult.data.status === 'failed' ? 'danger' : 'warning'}>{inspectResult.data.status}</Badge>
                    <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>run {inspectResult.data.runId}</Caption1>
                  </div>
                  {inspectResult.data.lastError && <MessageBar intent="error" style={{ marginTop: 6 }}><MessageBarBody>{inspectResult.data.lastError}</MessageBarBody></MessageBar>}
                  {inspectResult.data.answer && (
                    <div style={{ marginTop: 8 }}><Subtitle2>Answer</Subtitle2><div style={{ whiteSpace: 'pre-wrap' }}>{inspectResult.data.answer}</div></div>
                  )}
                  <Subtitle2 style={{ marginTop: 10 }}>Run steps ({inspectResult.data.steps?.length || 0})</Subtitle2>
                  {(inspectResult.data.steps || []).map((st: any, i: number) => (
                    <div key={st.id || i} style={{ border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 6, padding: 8, marginTop: 6 }}>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <Badge appearance="outline">{st.type}</Badge>
                        <Badge appearance="filled" color={st.status === 'completed' ? 'success' : st.status === 'failed' ? 'danger' : 'informative'}>{st.status}</Badge>
                      </div>
                      {(st.toolCalls || []).map((tc: any, j: number) => (
                        <div key={j} style={{ marginTop: 6, fontFamily: 'monospace', fontSize: 12 }}>
                          <div><strong>{tc.type}{tc.name ? ` · ${tc.name}` : ''}</strong></div>
                          {tc.input && <div style={{ whiteSpace: 'pre-wrap', color: tokens.colorNeutralForeground3 }}>{tc.input}</div>}
                          {tc.output && <div style={{ whiteSpace: 'pre-wrap' }}>{tc.output}</div>}
                        </div>
                      ))}
                      {st.error && <div style={{ color: tokens.colorPaletteRedForeground1, marginTop: 4 }}>{st.error}</div>}
                    </div>
                  ))}
                </div>
              )}
              {inspectResult && !inspectResult.ok && !inspectGate && (
                <MessageBar intent="error" style={{ marginTop: 8 }}><MessageBarBody>{inspectResult.error || 'Run failed'}</MessageBarBody></MessageBar>
              )}
            </>
          )}
        </div>
      </>
    } />
  );
}
