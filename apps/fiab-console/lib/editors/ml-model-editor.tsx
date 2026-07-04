'use client';

/**
 * ML Model editor — binds a Loom item (Cosmos GUID `id`) to a REAL Azure
 * Machine Learning registered model (state.modelName + optional
 * state.workspaceName) and drives the AML model registry via the BFF. The
 * route id is NEVER used as the model name (fixes the confirmed 404 crash).
 *
 * Surfaces, one-for-one with the AML studio "Models" experience:
 *   - Detail        — model + selected-version metadata, MLflow flavors/signature,
 *                     tags, properties, AND the source-run lineage link.
 *   - Versions      — every registered version + its MLflow STAGE (None /
 *                     Staging / Production / Archived) with an inline
 *                     "Transition stage" action, plus "Register new version"
 *                     (artifact URI OR register-from-run with lineage).
 *   - Deploy        — managed online (real-time) endpoint + blue deployment.
 *
 * BFF routes (all real Azure REST — no mocks):
 *   GET  /api/items/ml-model/[id]            → bound model + ARM versions (412 unbound)
 *   GET  /api/items/ml-model/[id]/bind       → AML workspaces + models + binding
 *   POST /api/items/ml-model/[id]/bind       → persist binding
 *   POST /api/items/ml-model/[id]/register   → register a new model version (ARM or MLflow-from-run)
 *   GET  /api/items/ml-model/[id]/stage      → MLflow model-versions w/ current_stage + run lineage
 *   POST /api/items/ml-model/[id]/stage      → transition a version's stage (real MLflow REST)
 *   GET/POST /api/items/ml-model/[id]/endpoint → list / create online endpoint
 *
 * Stages are an MLflow-layer concept (Microsoft Learn "how-to-manage-models-mlflow"):
 * ARM model versions don't carry a stage, so the version table is decorated
 * from the /stage MLflow surface. When that surface isn't configured the editor
 * shows an honest Fluent MessageBar (env vars to set) and the rest still works.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Subtitle2, Body1, Caption1, Badge, Button, Input, Spinner, Switch,
  Tab, TabList,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  Tree, TreeItem, TreeItemLayout,
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  Field, Dropdown, Option,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { ItemEditorChrome } from './item-editor-chrome';
import { NewItemCreateGate } from './new-item-gate';
import { safeModelJson } from './model-fetch';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';
import { useSharedEditorStyles } from './shared-styles';

const useLocalStyles = makeStyles({
  monaco: {
    width: '100%', minHeight: '180px', maxWidth: '100%', boxSizing: 'border-box',
    fontFamily: 'Consolas, "Cascadia Code", monospace',
    fontSize: tokens.fontSizeBase300, padding: tokens.spacingVerticalM,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground3,
    color: tokens.colorNeutralForeground1,
    resize: 'vertical', overflowWrap: 'anywhere',
  },
  card: { padding: tokens.spacingVerticalM, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge },
});

function useStyles() {
  const shared = useSharedEditorStyles();
  const local = useLocalStyles();
  return useMemo(() => ({ ...shared, ...local }), [shared, local]);
}

// ----- ML Model shapes (mirror lib/azure/foundry-client + mlflow-client) -----

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
/** MLflow model-version view — carries the stage + source-run lineage. */
interface MlflowVersionLite {
  name: string; version: string; currentStage?: string;
  source?: string; runId?: string; status?: string;
}
interface MlWorkspaceLite { name: string; kind?: string; isHub?: boolean }
interface ModelBindingState { modelName: string; workspaceName?: string; version?: string }
interface OnlineEndpointLite { id?: string; name: string; provisioningState?: string; scoringUri?: string; authMode?: string; traffic?: Record<string, number> }
interface OnlineDeploymentLite { name: string; endpointName: string; model?: string; instanceType?: string; instanceCount?: number; provisioningState?: string }

type Stage = 'None' | 'Staging' | 'Production' | 'Archived';
const STAGES: Stage[] = ['None', 'Staging', 'Production', 'Archived'];

/** Fluent Badge color per MLflow stage (production = success, staging = warning). */
function stageColor(stage?: string): 'success' | 'warning' | 'subtle' | 'informative' {
  switch (stage) {
    case 'Production': return 'success';
    case 'Staging': return 'warning';
    case 'Archived': return 'subtle';
    default: return 'informative';
  }
}

export function MlModelEditor({ item, id }: { item: FabricItemType; id: string }) {
  const isNew = id === 'new' || !id;
  // /new — real Cosmos create (workspace + name), then the editor binds the new
  // item to a registered Azure ML model. No fake create, no dead button.
  if (isNew) {
    return (
      <NewItemCreateGate
        item={item}
        createLabel="Create ML model item"
        intro="Creates an ML model item in your Loom workspace, then opens the editor where you bind it to a registered model in Azure Machine Learning (workspace + model registry) to view versions, register new versions, transition stages, and deploy real-time endpoints."
      />
    );
  }
  return <MlModelEditorBody item={item} id={id} />;
}

/**
 * Bound ML-model editor. The Loom item (GUID `id`) binds to a real AML
 * registered model via `state.modelName` + optional `state.workspaceName`.
 * Resolution happens server-side (BFF resolveModelBinding) — the route id is
 * NEVER used as the model name. When unbound, the full surface still renders
 * with a bind picker (workspace + model from the real AML registry).
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

  // ---- MLflow stages + lineage (decorate the ARM version table) ----
  const [mlflowVersions, setMlflowVersions] = useState<MlflowVersionLite[]>([]);
  const [mlflowGate, setMlflowGate] = useState<{ hint?: string; missing?: string[] } | null>(null);

  // ---- Stage-transition dialog ----
  const [stagePickVer, setStagePickVer] = useState<string | null>(null);
  const [stagePick, setStagePick] = useState<Stage>('None');
  const [stageArchive, setStageArchive] = useState(false);
  const [stageBusy, setStageBusy] = useState(false);
  const [stageMsg, setStageMsg] = useState<{ intent: 'success' | 'error'; text: string; receipt?: string } | null>(null);

  // ---- Deploy ----
  const [instanceType, setInstanceType] = useState('Standard_DS3_v2');
  const [instanceCount, setInstanceCount] = useState('1');
  const [deploying, setDeploying] = useState(false);
  const [endpointMsg, setEndpointMsg] = useState<{ intent: 'success' | 'error'; text: string } | null>(null);
  const [endpoints, setEndpoints] = useState<OnlineEndpointLite[]>([]);
  const [deployments, setDeployments] = useState<OnlineDeploymentLite[]>([]);
  // Blue-green traffic split + per-endpoint admin (scale / delete) ops.
  const [trafficEp, setTrafficEp] = useState<string | null>(null);
  const [bluePct, setBluePct] = useState(100);
  const [opBusy, setOpBusy] = useState<string | null>(null);

  // ---- Register-version dialog ----
  const [regOpen, setRegOpen] = useState(false);
  const [regUri, setRegUri] = useState('');
  const [regVersion, setRegVersion] = useState('');
  const [regRunId, setRegRunId] = useState('');
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

  // Load MLflow model-versions (stage + run lineage). Honest gate when the AML
  // MLflow tracking endpoint isn't configured — the rest of the editor works.
  const loadMlflowVersions = useCallback(async () => {
    try {
      const res = await fetch(`${apiBase}/stage`);
      const j = await safeModelJson(res);
      if (j.ok) { setMlflowVersions(j.data?.versions || []); setMlflowGate(null); }
      else if (j.code === 'mlflow_unconfigured') { setMlflowVersions([]); setMlflowGate({ hint: j.data?.hint, missing: j.data?.missing }); }
      else { setMlflowVersions([]); /* non-critical: ARM versions still render */ }
    } catch { /* non-critical */ }
  }, [apiBase]);

  const loadEndpoints = useCallback(async () => {
    try {
      const res = await fetch(`${apiBase}/endpoint`);
      const j = await safeModelJson(res);
      if (j.ok) { setEndpoints(j.data?.endpoints || []); setDeployments(j.data?.deployments || []); }
    } catch { /* non-critical */ }
  }, [apiBase]);

  // Blue-green: set the traffic split for an endpoint (blue=pct, green=100-pct).
  const applyTraffic = useCallback(async () => {
    if (!trafficEp) return;
    const deps = deployments.filter((d) => d.endpointName === trafficEp);
    const blue = deps[0]?.name || 'blue'; const green = deps[1]?.name;
    const traffic: Record<string, number> = green ? { [blue]: bluePct, [green]: 100 - bluePct } : { [blue]: 100 };
    setOpBusy(`traffic:${trafficEp}`); setEndpointMsg(null);
    try {
      const res = await fetch(`${apiBase}/endpoint`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpointName: trafficEp, traffic }) });
      const j = await safeModelJson(res);
      setEndpointMsg({ intent: j.ok ? 'success' : 'error', text: j.ok ? `Traffic: ${JSON.stringify(traffic)}` : (j.error || `HTTP ${j.status}`) });
      if (j.ok) { setTrafficEp(null); loadEndpoints(); }
    } catch (e: any) { setEndpointMsg({ intent: 'error', text: e?.message || String(e) }); }
    finally { setOpBusy(null); }
  }, [apiBase, trafficEp, bluePct, deployments, loadEndpoints]);

  const deleteEndpoint = useCallback(async (name: string) => {
    setOpBusy(`del:${name}`); setEndpointMsg(null);
    try {
      const res = await fetch(`${apiBase}/endpoint?endpoint=${encodeURIComponent(name)}`, { method: 'DELETE' });
      const j = await safeModelJson(res);
      setEndpointMsg({ intent: j.ok ? 'success' : 'error', text: j.ok ? `Endpoint ${name} deletion started.` : (j.error || `HTTP ${j.status}`) });
      if (j.ok) loadEndpoints();
    } catch (e: any) { setEndpointMsg({ intent: 'error', text: e?.message || String(e) }); }
    finally { setOpBusy(null); }
  }, [apiBase, loadEndpoints]);

  useEffect(() => { loadBinding(); }, [loadBinding]);
  useEffect(() => {
    if (bound?.modelName) { load(); loadEndpoints(); loadMlflowVersions(); }
  }, [bound?.modelName, load, loadEndpoints, loadMlflowVersions]);

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

  const unbind = useCallback(() => { setBound(null); setModel(null); setVersions([]); setMlflowVersions([]); setMlflowGate(null); loadBinding(pickWs); }, [loadBinding, pickWs]);

  const createEndpoint = useCallback(async () => {
    setDeploying(true); setEndpointMsg(null);
    try {
      const res = await fetch(`${apiBase}/endpoint`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ version: selected || undefined, instanceType, instanceCount: Number(instanceCount) || 1 }),
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
        body: JSON.stringify({
          modelUri: regUri.trim(),
          version: regVersion.trim() || undefined,
          modelType: regType,
          runId: regRunId.trim() || undefined,
        }),
      });
      const j = await safeModelJson(res);
      if (!j.ok) {
        const hint = j.data?.hint ? ` — ${j.data.hint}` : '';
        setRegMsg({ intent: 'error', text: `${j.error || `HTTP ${j.status}`}${hint}` });
        return;
      }
      const lineage = j.data?.version?.runId || j.data?.lineage?.runId;
      setRegMsg({ intent: 'success', text: `Registered ${j.data?.model} v${j.data?.version?.version}${lineage ? ` (lineage → run ${lineage})` : ''}` });
      setRegOpen(false);
      load(); loadMlflowVersions();
    } catch (e: any) { setRegMsg({ intent: 'error', text: e?.message || String(e) }); }
    finally { setRegistering(false); }
  }, [apiBase, regUri, regVersion, regType, regRunId, load, loadMlflowVersions]);

  // Stage map: version → current MLflow stage, for the table + detail badge.
  const stageByVersion = useMemo(() => {
    const m = new Map<string, MlflowVersionLite>();
    for (const v of mlflowVersions) m.set(String(v.version), v);
    return m;
  }, [mlflowVersions]);

  const openStageDialog = useCallback((ver: string) => {
    const cur = stageByVersion.get(String(ver))?.currentStage;
    setStagePick((STAGES.includes(cur as Stage) ? cur : 'None') as Stage);
    setStageArchive(false);
    setStageMsg(null);
    setStagePickVer(ver);
  }, [stageByVersion]);

  const transitionStage = useCallback(async () => {
    if (!stagePickVer) return;
    setStageBusy(true); setStageMsg(null);
    try {
      const res = await fetch(`${apiBase}/stage`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ version: stagePickVer, stage: stagePick, archiveExistingVersions: stageArchive }),
      });
      const j = await safeModelJson(res);
      if (!j.ok) {
        const hint = j.data?.hint ? ` — ${j.data.hint}` : '';
        setStageMsg({ intent: 'error', text: `${j.error || `HTTP ${j.status}`}${hint}` });
        return;
      }
      const receipt = j.data?.receipt ?? j.data?.modelVersion;
      setStageMsg({
        intent: 'success',
        text: j.data?.message || `v${stagePickVer} transitioned to ${stagePick}.`,
        receipt: receipt ? JSON.stringify(receipt, null, 2) : undefined,
      });
      await loadMlflowVersions();
    } catch (e: any) { setStageMsg({ intent: 'error', text: e?.message || String(e) }); }
    finally { setStageBusy(false); }
  }, [apiBase, stagePickVer, stagePick, stageArchive, loadMlflowVersions]);

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Model', actions: [
        { label: loading || bindLoading ? 'Reloading…' : 'Reload', onClick: (loading || bindLoading) ? undefined : (bound?.modelName ? () => { load(); loadMlflowVersions(); } : () => loadBinding(pickWs)), disabled: loading || bindLoading },
        { label: 'Re-bind', onClick: bound?.modelName ? unbind : undefined, disabled: !bound?.modelName },
      ]},
      { label: 'Versions', actions: [
        { label: 'Register version', onClick: bound?.modelName ? () => { setRegUri(''); setRegVersion(''); setRegRunId(''); setRegMsg(null); setRegOpen(true); } : undefined, disabled: !bound?.modelName },
        { label: 'Transition stage', onClick: (bound?.modelName && (selected || versions[0]?.version)) ? () => openStageDialog(selected || versions[0]!.version) : undefined, disabled: !bound?.modelName || !versions.length },
      ]},
      { label: 'Serve', actions: [
        { label: deploying ? 'Deploying…' : 'Real-time endpoint', onClick: createEndpoint, disabled: deploying || !versions.length },
      ]},
    ]},
  ], [loading, bindLoading, bound?.modelName, load, loadMlflowVersions, loadBinding, pickWs, unbind, deploying, createEndpoint, versions, selected, openStageDialog]);

  const current = versions.find((v) => v.version === selected) || versions[0];
  const currentMlflow = current ? stageByVersion.get(String(current.version)) : undefined;

  // ---- Unbound: full surface still renders, with a bind picker ----
  const bindPanel = (
    <div className={s.card} style={{ maxWidth: 640 }}>
      <Subtitle2>Bind to an Azure ML registered model</Subtitle2>
      <Body1 style={{ color: tokens.colorNeutralForeground3, marginTop: tokens.spacingVerticalXS }}>
        Choose the Azure Machine Learning workspace and a registered model. The binding is saved on this item; all actions then target the bound model&apos;s real registry.
      </Body1>
      {wsError && (
        <MessageBar intent="warning" style={{ marginTop: tokens.spacingVerticalS }}>
          <MessageBarBody>
            <MessageBarTitle>Azure ML workspaces not reachable</MessageBarTitle>
            {wsError}
            <br /><Caption1>Set <code>LOOM_SUBSCRIPTION_ID</code> + <code>LOOM_FOUNDRY_RG</code> and grant the Console UAMI <strong>AzureML Data Scientist</strong> (or Reader) on the resource group.</Caption1>
          </MessageBarBody>
        </MessageBar>
      )}
      <div style={{ display: 'flex', gap: tokens.spacingHorizontalM, flexWrap: 'wrap', alignItems: 'flex-end', marginTop: tokens.spacingVerticalM }}>
        <Field label="Workspace (blank = Foundry hub)">
          <Dropdown
            placeholder={workspaces.length ? 'Foundry hub (default)' : 'No AML workspaces found'}
            value={pickWs}
            selectedOptions={pickWs ? [pickWs] : []}
            onOptionSelect={(_, d) => { const w = d.optionValue || ''; setPickWs(w); setPickModel(''); loadBinding(w); }}
          >
            <Option value="">Foundry hub (default)</Option>
            {workspaces.map((w) => <Option key={w.name} value={w.name}>{`${w.name}${w.isHub ? ' (hub)' : w.kind ? ` (${w.kind})` : ''}`}</Option>)}
          </Dropdown>
        </Field>
        <Field label="Registered model">
          <Dropdown
            placeholder={models.length ? 'Select a model' : 'No models in this workspace'}
            value={pickModel}
            selectedOptions={pickModel ? [pickModel] : []}
            onOptionSelect={(_, d) => setPickModel(d.optionValue || '')}
          >
            {models.map((m) => <Option key={m.name} value={m.name}>{`${m.name}${m.latestVersion ? ` (latest v${m.latestVersion})` : ''}`}</Option>)}
          </Dropdown>
        </Field>
        <Button appearance="primary" onClick={doBind} disabled={bindBusy || !pickModel}>
          {bindBusy ? 'Binding…' : 'Bind'}
        </Button>
      </div>
      {modelsError && (
        <MessageBar intent="warning" style={{ marginTop: tokens.spacingVerticalS }}>
          <MessageBarBody>
            <MessageBarTitle>Models not reachable</MessageBarTitle>
            {modelsError}
          </MessageBarBody>
        </MessageBar>
      )}
      {bindError && <MessageBar intent="error" style={{ marginTop: tokens.spacingVerticalS }}><MessageBarBody>{bindError}</MessageBarBody></MessageBar>}
    </div>
  );

  return (
    <ItemEditorChrome
      item={item}
      id={id}
      ribbon={ribbon}
      leftPanel={
        <div style={{ padding: tokens.spacingVerticalS }}>
          <Caption1 style={{ padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`, color: tokens.colorNeutralForeground3 }}>
            {bound?.modelName ? `Versions (${versions.length})` : 'Not bound'}
          </Caption1>
          {bound?.modelName && versions.length === 0 && !loading && (
            <Body1 style={{ padding: tokens.spacingVerticalS, color: tokens.colorNeutralForeground3 }}>No versions registered.</Body1>
          )}
          <Tree aria-label="Model versions">
            {versions.map((v) => {
              const st = stageByVersion.get(String(v.version))?.currentStage;
              return (
                <TreeItem
                  itemType="leaf"
                  key={v.version}
                  onClick={() => setSelected(v.version)}
                  style={{ background: v.version === selected ? tokens.colorNeutralBackground2 : undefined }}
                >
                  <TreeItemLayout>
                    v{v.version}
                    {model?.latestVersion === v.version && (
                      <Badge appearance="tint" color="brand" style={{ marginLeft: tokens.spacingHorizontalS }}>latest</Badge>
                    )}
                    {st && st !== 'None' && (
                      <Badge appearance="tint" color={stageColor(st)} style={{ marginLeft: tokens.spacingHorizontalS }}>{st}</Badge>
                    )}
                  </TreeItemLayout>
                </TreeItem>
              );
            })}
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
            <div className={s.card} style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS }}>
              <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', alignItems: 'center' }}>
                <Subtitle2>Model definition</Subtitle2>
                <Badge appearance="filled" color="brand">{bundleContent.algorithm}</Badge>
                {bundleContent.framework && <Badge appearance="outline">{bundleContent.framework}</Badge>}
                {bundleContent.target && <Badge appearance="tint">target: {bundleContent.target}</Badge>}
                <Badge appearance="outline" color="warning">bundle template</Badge>
              </div>
              {bundleContent.hyperparameters && Object.keys(bundleContent.hyperparameters).length > 0 && (
                <div>
                  <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Hyperparameters</Caption1>
                  <div style={{ display: 'flex', gap: tokens.spacingHorizontalSNudge, flexWrap: 'wrap', marginTop: tokens.spacingVerticalXS }}>
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
              <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', alignItems: 'center' }}>
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
                      <div style={{ display: 'flex', gap: tokens.spacingHorizontalM, flexWrap: 'wrap' }}>
                        <Badge appearance="tint">Latest: v{model.latestVersion || '—'}</Badge>
                        <Badge appearance="tint">{versions.length} version(s)</Badge>
                      </div>
                      {current && (
                        <>
                          <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', alignItems: 'center', marginTop: tokens.spacingVerticalS }}>
                            <Subtitle2>Selected version: v{current.version}</Subtitle2>
                            <Badge appearance="filled" color={stageColor(currentMlflow?.currentStage)}>
                              {currentMlflow?.currentStage || 'None'}
                            </Badge>
                            <Button size="small" appearance="subtle" onClick={() => openStageDialog(current.version)}>Transition stage</Button>
                          </div>
                          {current.description && <Body1>{current.description}</Body1>}
                          <div style={{ display: 'flex', gap: tokens.spacingHorizontalM, flexWrap: 'wrap' }}>
                            <Badge appearance="outline">type: {current.modelType || '—'}</Badge>
                            {current.createdAt && <Badge appearance="outline">created: {current.createdAt}</Badge>}
                            {currentMlflow?.status && <Badge appearance="outline">status: {currentMlflow.status}</Badge>}
                          </div>
                          {current.modelUri && (
                            <Caption1 style={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>{current.modelUri}</Caption1>
                          )}
                          {/* Source-run lineage — the canonical MLflow run_id link. */}
                          {currentMlflow?.runId && (
                            <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, marginTop: tokens.spacingVerticalXS, flexWrap: 'wrap' }}>
                              <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Source run (lineage)</Caption1>
                              <Badge appearance="tint">{currentMlflow.runId}</Badge>
                              <Button
                                size="small"
                                appearance="subtle"
                                as="a"
                                href={`/workspace/ml-experiment/${encodeURIComponent(currentMlflow.runId)}`}
                              >
                                Open run
                              </Button>
                            </div>
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
                              <div style={{ display: 'flex', gap: tokens.spacingHorizontalSNudge, flexWrap: 'wrap', marginTop: tokens.spacingVerticalXS }}>
                                {Object.entries(current.tags).map(([k, v]) => (
                                  <Badge key={k} appearance="outline">{k}={String(v)}</Badge>
                                ))}
                              </div>
                            </div>
                          )}
                          {current.properties && Object.keys(current.properties).length > 0 && (
                            <div>
                              <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Properties (lineage / run)</Caption1>
                              <div style={{ display: 'flex', gap: tokens.spacingHorizontalSNudge, flexWrap: 'wrap', marginTop: tokens.spacingVerticalXS }}>
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
                      <div style={{ display: 'flex', gap: tokens.spacingHorizontalS }}>
                        <Button appearance="primary" onClick={() => { setRegUri(''); setRegVersion(''); setRegRunId(''); setRegMsg(null); setRegOpen(true); }}>
                          Register new version
                        </Button>
                      </div>
                      {mlflowGate && (
                        <MessageBar intent="warning">
                          <MessageBarBody>
                            <MessageBarTitle>Model stages unavailable</MessageBarTitle>
                            Stage (None / Staging / Production / Archived) is served by the Azure ML MLflow registry, which isn&apos;t configured in this deployment.
                            {mlflowGate.missing?.length ? <> Set <code>{mlflowGate.missing.join('</code> + <code>')}</code>.</> : null}
                            {mlflowGate.hint ? <><br /><Caption1>{mlflowGate.hint}</Caption1></> : null}
                          </MessageBarBody>
                        </MessageBar>
                      )}
                      <div style={{ overflowX: 'auto', maxWidth: '100%' }}>
                      <Table aria-label="Model versions" size="small">
                        <TableHeader><TableRow>
                          <TableHeaderCell>Version</TableHeaderCell>
                          <TableHeaderCell>Stage</TableHeaderCell>
                          <TableHeaderCell>Type</TableHeaderCell>
                          <TableHeaderCell>Created</TableHeaderCell>
                          <TableHeaderCell>URI</TableHeaderCell>
                          <TableHeaderCell>Stage action</TableHeaderCell>
                        </TableRow></TableHeader>
                        <TableBody>
                          {versions.map((v) => {
                            const st = stageByVersion.get(String(v.version))?.currentStage;
                            return (
                              <TableRow key={v.version} onClick={() => setSelected(v.version)} style={{ cursor: 'pointer', background: v.version === selected ? tokens.colorNeutralBackground2 : undefined }}>
                                <TableCell><strong>v{v.version}</strong></TableCell>
                                <TableCell><Badge appearance="tint" color={stageColor(st)}>{st || 'None'}</Badge></TableCell>
                                <TableCell>{v.modelType || '—'}</TableCell>
                                <TableCell>{v.createdAt || '—'}</TableCell>
                                <TableCell style={{ fontFamily: 'monospace', fontSize: tokens.fontSizeBase200, wordBreak: 'break-all' }}>{v.modelUri || '—'}</TableCell>
                                <TableCell>
                                  <Button size="small" appearance="subtle" onClick={(e) => { e.stopPropagation(); openStageDialog(v.version); }}>Transition</Button>
                                </TableCell>
                              </TableRow>
                            );
                          })}
                        </TableBody>
                      </Table>
                      </div>
                    </>
                  )}

                  {tab === 'deploy' && (
                    <>
                      <Subtitle2>Deploy to a managed online (real-time) endpoint</Subtitle2>
                      <Body1 style={{ color: tokens.colorNeutralForeground3 }}>
                        Creates a managed online endpoint + a &quot;blue&quot; deployment serving <code>{bound.modelName}:{selected || model.latestVersion || '?'}</code> via real ARM PUTs in <strong>{bound.workspaceName || 'the Foundry hub'}</strong>.
                      </Body1>
                      <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                        <Field label="Endpoint VM size">
                          <Input value={instanceType} onChange={(_, d) => setInstanceType(d.value)} placeholder="Standard_DS3_v2" />
                        </Field>
                        <Field label="Instances (scale)">
                          <Input type="number" value={instanceCount} onChange={(_, d) => setInstanceCount(d.value)} style={{ width: 96 }} />
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
                      <Subtitle2 style={{ marginTop: tokens.spacingVerticalS }}>Existing endpoints ({endpoints.length})</Subtitle2>
                      {endpoints.length === 0
                        ? <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>No managed online endpoints in this workspace yet.</Caption1>
                        : (
                          <div style={{ overflowX: 'auto', maxWidth: '100%' }}>
                          <Table aria-label="Online endpoints" size="small">
                            <TableHeader><TableRow>
                              <TableHeaderCell>Endpoint</TableHeaderCell>
                              <TableHeaderCell>State</TableHeaderCell>
                              <TableHeaderCell>Traffic</TableHeaderCell>
                              <TableHeaderCell>Scoring URI</TableHeaderCell>
                              <TableHeaderCell>Actions</TableHeaderCell>
                            </TableRow></TableHeader>
                            <TableBody>
                              {endpoints.map((ep) => {
                                const traffic = ep.traffic && Object.keys(ep.traffic).length
                                  ? Object.entries(ep.traffic).map(([d, p]) => `${d}:${p}%`).join(' / ') : '—';
                                return (
                                <TableRow key={ep.name}>
                                  <TableCell><strong>{ep.name}</strong></TableCell>
                                  <TableCell><Badge appearance="tint" color={ep.provisioningState === 'Succeeded' ? 'success' : ep.provisioningState === 'Failed' ? 'danger' : 'warning'}>{ep.provisioningState || '—'}</Badge></TableCell>
                                  <TableCell>{traffic}</TableCell>
                                  <TableCell style={{ fontFamily: 'monospace', fontSize: tokens.fontSizeBase200, wordBreak: 'break-all' }}>{ep.scoringUri || '—'}</TableCell>
                                  <TableCell>
                                    <div style={{ display: 'flex', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap' }}>
                                      <Button size="small" appearance="subtle" onClick={() => { setTrafficEp(ep.name); setBluePct(50); }}>Traffic</Button>
                                      <Button size="small" appearance="subtle" as="a" href={`/workspace/monitor?endpoint=${encodeURIComponent(ep.name)}`}>Monitor</Button>
                                      <Button size="small" appearance="subtle" disabled={opBusy === `del:${ep.name}`} onClick={() => deleteEndpoint(ep.name)}>{opBusy === `del:${ep.name}` ? 'Deleting…' : 'Delete'}</Button>
                                    </div>
                                  </TableCell>
                                </TableRow>
                                );
                              })}
                            </TableBody>
                          </Table>
                          </div>
                        )}
                      {/* Deploy history — blue/green deployments + their model + scale. */}
                      {deployments.length > 0 && (
                        <>
                          <Subtitle2 style={{ marginTop: tokens.spacingVerticalS }}>Deployments ({deployments.length})</Subtitle2>
                          <div style={{ overflowX: 'auto', maxWidth: '100%' }}>
                          <Table aria-label="Deployment history" size="small">
                            <TableHeader><TableRow>
                              <TableHeaderCell>Deployment</TableHeaderCell><TableHeaderCell>Endpoint</TableHeaderCell>
                              <TableHeaderCell>Model</TableHeaderCell><TableHeaderCell>VM / count</TableHeaderCell><TableHeaderCell>State</TableHeaderCell>
                            </TableRow></TableHeader>
                            <TableBody>
                              {deployments.map((d) => (
                                <TableRow key={`${d.endpointName}/${d.name}`}>
                                  <TableCell><strong>{d.name}</strong></TableCell>
                                  <TableCell>{d.endpointName}</TableCell>
                                  <TableCell style={{ fontFamily: 'monospace', fontSize: tokens.fontSizeBase200, wordBreak: 'break-all' }}>{d.model || '—'}</TableCell>
                                  <TableCell>{d.instanceType || '—'} × {d.instanceCount ?? '—'}</TableCell>
                                  <TableCell><Badge appearance="tint" color={d.provisioningState === 'Succeeded' ? 'success' : 'warning'}>{d.provisioningState || '—'}</Badge></TableCell>
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                          </div>
                        </>
                      )}
                      {/* Blue-green traffic split dialog */}
                      <Dialog open={!!trafficEp} onOpenChange={(_, d) => { if (!d.open) setTrafficEp(null); }}>
                        <DialogSurface>
                          <DialogBody>
                            <DialogTitle>Traffic split — {trafficEp}</DialogTitle>
                            <DialogContent>
                              <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM }}>
                                <Caption1>Blue/green split across deployments via a real ARM PUT to <code>onlineEndpoints/{trafficEp}</code> traffic. First deployment = blue, second = green.</Caption1>
                                <Field label={`Blue ${bluePct}% / Green ${100 - bluePct}%`}>
                                  <input type="range" min={0} max={100} step={5} value={bluePct} onChange={(e) => setBluePct(Number(e.target.value))} />
                                </Field>
                              </div>
                            </DialogContent>
                            <DialogActions>
                              <Button onClick={() => setTrafficEp(null)}>Cancel</Button>
                              <Button appearance="primary" disabled={!!opBusy} onClick={applyTraffic}>{opBusy?.startsWith('traffic') ? 'Applying…' : 'Apply split'}</Button>
                            </DialogActions>
                          </DialogBody>
                        </DialogSurface>
                      </Dialog>
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
                  <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM }}>
                    <Caption1>Registers a new version of <strong>{bound?.modelName}</strong> from a model artifact URI. Supplying a source run ID uses the MLflow registry path so the version records run lineage; otherwise a real ARM PUT to the model registry is used.</Caption1>
                    <Field label="Model artifact URI">
                      <Input value={regUri} onChange={(_, d) => setRegUri(d.value)} placeholder="azureml://jobs/<run>/outputs/artifacts/paths/model/" />
                    </Field>
                    <Field label="Source run ID (optional — records lineage)">
                      <Input value={regRunId} onChange={(_, d) => setRegRunId(d.value)} placeholder="e.g. 8a1b2c3d-…" />
                    </Field>
                    <Field label="Version (blank = auto)">
                      <Input value={regVersion} onChange={(_, d) => setRegVersion(d.value)} placeholder="auto" disabled={!!regRunId.trim()} />
                    </Field>
                    <Field label="Model type">
                      <Dropdown value={regType} selectedOptions={[regType]} onOptionSelect={(_, d) => setRegType((d.optionValue as any) || 'mlflow_model')} disabled={!!regRunId.trim()}>
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

          {/* Stage-transition dialog */}
          <Dialog open={!!stagePickVer} onOpenChange={(_, d) => { if (!d.open) setStagePickVer(null); }}>
            <DialogSurface>
              <DialogBody>
                <DialogTitle>Transition stage — v{stagePickVer}</DialogTitle>
                <DialogContent>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM }}>
                    <Caption1>
                      Moves <strong>{bound?.modelName} v{stagePickVer}</strong> to a new MLflow registry stage via a real <code>model-versions/transition-stage</code> call. The registry response (post-transition model version) is shown as the receipt.
                    </Caption1>
                    <Field label="Target stage">
                      <Dropdown value={stagePick} selectedOptions={[stagePick]} onOptionSelect={(_, d) => setStagePick((d.optionValue as Stage) || 'None')}>
                        {STAGES.map((st) => <Option key={st} value={st}>{st}</Option>)}
                      </Dropdown>
                    </Field>
                    <Switch
                      label="Archive other versions currently in this stage"
                      checked={stageArchive}
                      onChange={(_, d) => setStageArchive(!!d.checked)}
                    />
                    {stageMsg && (
                      <MessageBar intent={stageMsg.intent}>
                        <MessageBarBody>
                          {stageMsg.text}
                          {stageMsg.receipt && (
                            <div className={s.monaco} style={{ whiteSpace: 'pre-wrap', overflow: 'auto', maxHeight: 220, marginTop: tokens.spacingVerticalS }}>
                              {stageMsg.receipt}
                            </div>
                          )}
                        </MessageBarBody>
                      </MessageBar>
                    )}
                  </div>
                </DialogContent>
                <DialogActions>
                  <Button onClick={() => setStagePickVer(null)}>Close</Button>
                  <Button appearance="primary" disabled={stageBusy} onClick={transitionStage}>{stageBusy ? 'Transitioning…' : 'Transition'}</Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>
        </div>
      }
    />
  );
}
