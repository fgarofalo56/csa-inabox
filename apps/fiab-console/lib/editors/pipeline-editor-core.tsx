'use client';

/**
 * Shared core for the ADF + Synapse pipeline editors (the Integrate experience).
 *
 * This fixes the confirmed 404 binding bug: a Loom pipeline item is a Cosmos
 * GUID, NOT an Azure pipeline name. The editor first resolves the item's
 * BINDING (state.pipelineName) via `/api/items/<slug>/<id>/bind`. When unbound,
 * it shows a picker — bind to an existing factory/workspace pipeline OR create
 * a new one — while still rendering the full editor surface (graph/JSON/runs/
 * triggers). All per-item operations target the GUID route; the BFF resolves
 * the bound pipeline name server-side.
 *
 * Both families share this component; only the slug, activity palette, and the
 * Validate affordance (ADF only) differ.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Subtitle2, Body1, Caption1, Badge, Button, Input, Dropdown, Option, Field,
  Tab, TabList, Spinner, RadioGroup, Radio,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  Tree, TreeItem, TreeItemLayout,
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  DocumentTable20Regular, Play20Regular, Server20Regular,
  ArrowSync20Regular, Save20Regular, Bug20Regular, Checkmark20Regular,
  Clock20Regular, Link20Regular, Add20Regular, Settings20Regular,
  PlugConnected20Regular, Database20Regular, Dismiss24Regular,
} from '@fluentui/react-icons';
import { ManagePanel } from '@/lib/components/pipeline/manage-panel';
import { PipelineManageHub } from '@/lib/components/pipeline/pipeline-manage-hub';
import { FactoryResourcesTree } from '@/lib/components/pipeline/factory-resources-tree';
import { AdfCdcEditor } from '@/lib/adf/adf-cdc-editor';
import { SynapseWorkspaceTree } from '@/lib/components/pipeline/synapse-workspace-tree';
import { SynapseKqlEditor } from './synapse-kql-editor';
import { SynapseSparkEditor } from './synapse-spark-editor';
import { ItemEditorChrome } from './item-editor-chrome';
import { PipelineCopilotPane } from './pipeline-editor';
import { BackendStateBar } from '@/lib/components/backend-state-bar';
import { extractActivities, writeActivitiesToSpec, type PipelineActivity } from '@/lib/components/pipeline/pipeline-dag-view';
import { PipelineDesigner, type PipelineDesignerHandle } from '@/lib/components/pipeline/pipeline-designer';
import { ParametersPane, VariablesPane, SettingsPane } from '@/lib/components/pipeline/pipeline-config-panes';
import { TriggerWizard } from '@/lib/components/pipeline/trigger-wizard';
import type { ParamBinding } from '@/lib/components/pipeline/param-source-picker';
import {
  paramsFromSpec, paramsToSpec, varsFromSpec, varsToSpec,
  type PipelineParameter, type PipelineVariable, type PipelineSpec,
} from '@/lib/components/pipeline/types';
import { MonacoTextarea } from '@/lib/components/editor/monaco-textarea';
import { safePipelineJson } from './pipeline-fetch';
import { AzureResourcePicker } from '@/lib/components/azure/azure-resource-picker';
import { LinkedServiceGallery } from '@/lib/components/pipeline/linked-service-gallery';
import { IntegrationRuntimeManager } from '@/lib/components/pipeline/integration-runtime-manager';
import type { PipelineRuntimeContext } from '@/lib/components/pipeline/types';
import { createItem } from '@/lib/api/workspaces';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';

// Common Azure regions for the "Create new factory" location picker (Commercial
// + US Government). The default is the chosen resource group's location.
const ADF_FACTORY_REGIONS = [
  'eastus', 'eastus2', 'centralus', 'southcentralus', 'westus', 'westus2', 'westus3',
  'northcentralus', 'westcentralus', 'canadacentral', 'northeurope', 'westeurope',
  'uksouth', 'francecentral', 'germanywestcentral', 'switzerlandnorth',
  'norwayeast', 'swedencentral', 'eastasia', 'southeastasia', 'japaneast',
  'australiaeast', 'centralindia', 'koreacentral', 'brazilsouth', 'uaenorth',
  // US Government
  'usgovvirginia', 'usgovarizona', 'usgovtexas',
];

const useStyles = makeStyles({
  pad: { padding: tokens.spacingVerticalL, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: 0, maxWidth: '100%' },
  gate: { padding: tokens.spacingVerticalL, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, maxWidth: '720px', minWidth: 0 },
  row: { display: 'flex', gap: tokens.spacingHorizontalM, alignItems: 'flex-end', flexWrap: 'wrap' },
  field: { flex: 1, minWidth: '220px', display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS },
});

export interface ActivityTemplate {
  label: string;
  build: (name: string) => PipelineActivity;
  prefix: string;
}

export interface PipelineEditorConfig {
  /** API slug: 'adf-pipeline' | 'synapse-pipeline'. */
  slug: string;
  /** Human label for the bound resource container. */
  containerLabel: string;   // "factory" | "workspace"
  /** Activity palette templates for the ribbon. */
  palette: ActivityTemplate[];
  /** ADF exposes a Validate action; Synapse doesn't. */
  supportsValidate: boolean;
}

interface PipelineRunDTO {
  runId: string;
  pipelineName: string;
  status?: string;
  runStart?: string;
  runEnd?: string;
  durationInMs?: number;
  message?: string;
  invokedBy?: { name?: string; invokedByType?: string };
}

export function PipelineEditorCore({
  item, id, config, runtimeContext,
}: {
  item: FabricItemType;
  id: string;
  config: PipelineEditorConfig;
  /**
   * Optional runtime context so the unified DataPipelineEditor can drive this
   * same core with a runtime selector (adf / synapse / fabric). When omitted the
   * behaviour is IDENTICAL to today: the runtime is inferred from `config.slug`
   * (adf-pipeline → adf, synapse-pipeline → synapse) and every existing caller
   * (the Synapse / Adf wrappers) keeps compiling and rendering unchanged.
   */
  runtimeContext?: PipelineRuntimeContext;
}) {
  const s = useStyles();
  const router = useRouter();
  // A `/new` route lands here with the literal id "new" and NO Cosmos item yet
  // (e.g. "+ New item" opened from home, before any workspace is chosen). We must
  // NOT drive the per-item bind / spec / run routes with "new" — loadPipelineItem
  // 404s on it ("Item new (<slug>) not found"). Instead we guard those effects
  // off and render a create-gate that creates a REAL Loom item first, then
  // redirects to the real GUID where the existing bind/run/save flow works.
  const isNew = id === 'new';
  // Per-item route base. Only ever fetched for a REAL id — every per-item effect
  // below short-circuits while `isNew`, so this never carries the literal "new".
  const apiBase = `/api/items/${config.slug}/${encodeURIComponent(id)}`;

  // ---- Binding state ----
  const [bindingLoading, setBindingLoading] = useState(true);
  const [bound, setBound] = useState<string | null>(null);
  const [available, setAvailable] = useState<Array<{ name: string }>>([]);
  const [listError, setListError] = useState<string | null>(null);
  // Preview graph for an UNBOUND bundle-installed item: the rich activity graph
  // stamped into state.content, surfaced by the bind GET so the canvas renders
  // FULLY BUILT-OUT (read-only) while the bind gate prompts to push it live.
  const [preview, setPreview] = useState<any | null>(null);
  const [pickName, setPickName] = useState<string>('');     // bind-to-existing selection
  const [newName, setNewName] = useState<string>('');       // create-new input
  const [bindBusy, setBindBusy] = useState(false);
  const [bindError, setBindError] = useState<string | null>(null);

  // ---- New-item create gate (isNew only) ----
  // A `/new` route has no Cosmos item, so binding can't run. The gate picks a
  // Loom workspace + name and creates a REAL item via createItem (no mock), then
  // redirects to its GUID. itemType MUST equal config.slug ('adf-pipeline' |
  // 'synapse-pipeline') because the bind route's loadPipelineItem filters Cosmos
  // on c.itemType=@t — the created type has to match the slug the editor binds
  // through, or the per-item routes 404 after redirect.
  const [createWorkspaces, setCreateWorkspaces] = useState<Array<{ id: string; name: string }> | null>(null);
  const [createWsError, setCreateWsError] = useState<string | null>(null);
  const [createWsLoading, setCreateWsLoading] = useState(isNew);
  const [createWorkspaceId, setCreateWorkspaceId] = useState('');
  const [createName, setCreateName] = useState('');
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Effective runtime: the explicit runtimeContext wins (unified editor), else
  // it's inferred from the slug. Azure-native 'adf' is the DEFAULT per
  // no-fabric-dependency.md; 'fabric' is never auto-selected here.
  const runtime = runtimeContext?.runtime ?? (config.slug === 'synapse-pipeline' ? 'synapse' : 'adf');

  // Cross-subscription factory selection (ADF only). Lets the operator point
  // this pipeline item at WHICH Data Factory — across every subscription they
  // have RBAC for — before binding to one of its pipelines. ADF surfaces show
  // for the adf-pipeline slug OR when the unified editor selects runtime 'adf'.
  const isAdf = runtime === 'adf';
  const [factory, setFactory] = useState<{ id: string; name: string; subscriptionId: string; resourceGroup: string } | null>(null);

  // ---- Backing-service "Create new" affordances (bind gate) ----
  // Each picker is Use-existing | Create-new. Use-existing is the default and is
  // unchanged from today; Create-new opens a STRUCTURED wizard (no JSON) that
  // calls the real ARM/REST route, then refreshes the pipeline list / counts.
  const [factoryMode, setFactoryMode] = useState<'existing' | 'create'>('existing');
  // New-factory wizard state — name + target RG (carries subscriptionId via the
  // AzureResourcePicker) + location. POSTs /api/adf/factories/create (Contract E#1).
  const [newFactoryName, setNewFactoryName] = useState('');
  const [newFactoryRg, setNewFactoryRg] = useState<{ id: string; name: string; subscriptionId: string; resourceGroup: string; location: string } | null>(null);
  const [newFactoryLocation, setNewFactoryLocation] = useState('');
  const [factoryCreateBusy, setFactoryCreateBusy] = useState(false);
  const [factoryCreateError, setFactoryCreateError] = useState<string | null>(null);
  // Linked-service / integration-runtime create-new dialogs (reuse the shared
  // structured wizards — connector gallery + IR type catalog; real ARM REST).
  const [lsDialogOpen, setLsDialogOpen] = useState(false);
  const [irDialogOpen, setIrDialogOpen] = useState(false);

  // ---- Spec / run state ----
  const [spec, setSpec] = useState<string>('');
  const [origSpec, setOrigSpec] = useState<string>('');
  const [runs, setRuns] = useState<PipelineRunDTO[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<'graph' | 'parameters' | 'variables' | 'settings' | 'json' | 'runs'>('graph');
  const [validation, setValidation] = useState<{ ok: boolean; message: string } | null>(null);
  const designerRef = useRef<PipelineDesignerHandle>(null);

  const [runsAfterDays, setRunsAfterDays] = useState<number>(7);
  const [runsStatus, setRunsStatus] = useState<string>('');

  // ---- Manage (factory resources) dialog state — ADF only ----
  const [manageOpen, setManageOpen] = useState(false);
  // Catalog-driven Manage hub (connector gallery + dataset wizard) — Wave-2
  // authoring foundation, surfaced additively alongside the quick ManagePanel.
  const [manageHubOpen, setManageHubOpen] = useState(false);
  const [manageHubTab, setManageHubTab] = useState<'linked-services' | 'datasets' | 'integration-runtimes'>('linked-services');
  const openManageHub = useCallback((t: 'linked-services' | 'datasets' | 'integration-runtimes') => {
    setManageHubTab(t); setManageHubOpen(true);
  }, []);
  const [openCdc, setOpenCdc] = useState<string | null>(null);
  // Bump to force the navigator (ADF Factory Resources / Synapse Workspace
  // Resources) to re-list after a bind/create/manage action mutates the backend.
  const [factoryRefreshKey, setFactoryRefreshKey] = useState(0);
  const [workspaceRefreshKey, setWorkspaceRefreshKey] = useState(0);
  // Synapse workspace KQL-script / Spark-job-definition editor overlays. Opened
  // from the Workspace Resources navigator; rendered as Drawer overlays.
  const [kqlScriptOpen, setKqlScriptOpen] = useState<string | null>(null);
  const [sparkJobDefOpen, setSparkJobDefOpen] = useState<string | null>(null);

  // ---- Triggers dialog state ----
  const [triggersOpen, setTriggersOpen] = useState(false);
  const [triggersList, setTriggersList] = useState<Array<{ name: string; type?: string; runtimeState?: string }>>([]);
  const [triggersBusy, setTriggersBusy] = useState(false);
  const [triggersError, setTriggersError] = useState<string | null>(null);
  // Deepened "Add trigger → New" wizard (Schedule / Tumbling / Storage event /
  // Custom event + trigger-parameter mapping). Replaces the inline schedule-only
  // form; the existing list (start/stop/delete) stays in the manage dialog.
  const [triggerWizardOpen, setTriggerWizardOpen] = useState(false);
  // Which schedule-time param sources the deployment exposes (KV / App Config),
  // surfaced as the honest gate hint inside the wizard's value-source picker.
  const [paramSources, setParamSources] = useState<{ kvAvailable: boolean; appConfigAvailable: boolean }>(
    { kvAvailable: true, appConfigAvailable: true },
  );

  // ------------------------------------------------------------------
  // Binding
  // ------------------------------------------------------------------
  const loadBinding = useCallback(async () => {
    // Never GET /api/items/<slug>/new/bind — the route 404s on the literal "new"
    // (no Cosmos doc), which used to paint a spurious red bind-error banner on a
    // fresh /new before any user action. The create-gate handles `isNew`.
    if (isNew) { setBindingLoading(false); return; }
    setBindingLoading(true); setBindError(null);
    try {
      const res = await fetch(`${apiBase}/bind`);
      const { ok, data, error: e } = await safePipelineJson(res);
      if (!ok || !data) { setBindError(e || 'failed to load binding'); return; }
      setBound(data.bound ?? null);
      setAvailable(Array.isArray(data.pipelines) ? data.pipelines : []);
      setListError(data.listError || null);
      setPreview(data.preview ?? null);
      if (data.bound && !pickName) setPickName(data.bound);
    } catch (e: any) {
      setBindError(e?.message || String(e));
    } finally {
      setBindingLoading(false);
    }
  }, [apiBase, pickName, isNew]);

  useEffect(() => { loadBinding(); }, [loadBinding]);

  // Load the Loom workspace catalog for the create-gate picker (isNew only).
  // Reuses the {ok, workspaces:[{id,name}]} shape every editor's picker expects.
  useEffect(() => {
    if (!isNew) return;
    let cancelled = false;
    (async () => {
      setCreateWsLoading(true); setCreateWsError(null);
      try {
        const r = await fetch('/api/loom/workspaces');
        const j = await r.json();
        if (cancelled) return;
        if (!j.ok) { setCreateWsError(j.error || `HTTP ${r.status}`); setCreateWorkspaces([]); }
        else { setCreateWorkspaces(Array.isArray(j.workspaces) ? j.workspaces : []); }
      } catch (e: any) {
        if (!cancelled) { setCreateWsError(e?.message || String(e)); setCreateWorkspaces([]); }
      } finally {
        if (!cancelled) setCreateWsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [isNew]);

  // Create a REAL Loom pipeline item, then reopen the page on its GUID. After
  // the redirect the existing bind/run/save flow works against the real item
  // via the matching slug. No mock; Azure-native adf/synapse default.
  const createPipelineItem = useCallback(async () => {
    if (!createWorkspaceId || !createName.trim() || createBusy) return;
    setCreateBusy(true); setCreateError(null);
    try {
      const created = await createItem(createWorkspaceId, {
        itemType: config.slug,            // MUST equal the bind route's slug
        displayName: createName.trim(),
      });
      router.replace(`/items/${encodeURIComponent(config.slug)}/${encodeURIComponent(created.id)}`);
    } catch (e: any) {
      setCreateError(e?.message || String(e));
      setCreateBusy(false);               // keep busy through the redirect on success
    }
  }, [createWorkspaceId, createName, createBusy, config.slug, router]);

  const bindTo = useCallback(async (name: string, create: boolean) => {
    // Binding only makes sense for a real, persisted item — a `/new` route has
    // no GUID to bind against (the create-gate creates one first).
    if (isNew || !name.trim()) return;
    setBindBusy(true); setBindError(null);
    try {
      const res = await fetch(`${apiBase}/bind`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pipelineName: name.trim(), create }),
      });
      const { ok, data, error: e } = await safePipelineJson(res);
      if (!ok || !data) { setBindError(e || 'bind failed'); return; }
      setBound(data.bound);
      setNewName('');
      setFactoryRefreshKey((k) => k + 1);
      setWorkspaceRefreshKey((k) => k + 1);
      await loadBinding();
    } catch (e: any) {
      setBindError(e?.message || String(e));
    } finally {
      setBindBusy(false);
    }
  }, [apiBase, loadBinding, isNew]);

  // Create a NEW Data Factory across any subscription/RG the operator can reach,
  // then select it (setFactory) so binding can proceed against it. Real ARM PUT
  // via the create route (Contract E#1) — no mock. The honest 403 gate message
  // (Console UAMI lacks Contributor on the RG) is surfaced verbatim from the
  // route, per no-vaporware.md.
  const createFactory = useCallback(async () => {
    const name = newFactoryName.trim();
    const target = newFactoryRg;
    const location = (newFactoryLocation || target?.location || '').trim();
    if (!name || !target || !location) return;
    setFactoryCreateBusy(true); setFactoryCreateError(null);
    try {
      const res = await fetch('/api/adf/factories/create', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name,
          location,
          subscriptionId: target.subscriptionId,
          resourceGroup: target.resourceGroup || target.name,
        }),
      });
      const { ok, data, error: e } = await safePipelineJson(res);
      if (!ok || !data?.factory) { setFactoryCreateError(e || data?.error || 'factory create failed'); return; }
      const f = data.factory as { id: string; name: string; subscriptionId: string; resourceGroup: string };
      setFactory({ id: f.id, name: f.name, subscriptionId: f.subscriptionId, resourceGroup: f.resourceGroup });
      setFactoryMode('existing');
      setNewFactoryName('');
      setFactoryRefreshKey((k) => k + 1);
      // Re-list pipelines in the (now bindable) factory.
      await loadBinding();
    } catch (e: any) {
      setFactoryCreateError(e?.message || String(e));
    } finally {
      setFactoryCreateBusy(false);
    }
  }, [newFactoryName, newFactoryRg, newFactoryLocation, loadBinding]);

  // ------------------------------------------------------------------
  // Spec + runs (only meaningful once bound; routes 412 otherwise)
  // ------------------------------------------------------------------
  const loadPipeline = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(apiBase);
      const { ok, data, error: e } = await safePipelineJson(res);
      if (!ok || !data) {
        if (data?.code === 'unbound') return; // gate handles it
        setError(e || 'get failed'); return;
      }
      const txt = JSON.stringify(data.pipeline, null, 2);
      setSpec(txt); setOrigSpec(txt);
    } catch (e: any) { setError(e?.message || String(e)); }
  }, [apiBase]);

  const loadRuns = useCallback(async () => {
    try {
      const after = new Date(Date.now() - runsAfterDays * 24 * 60 * 60 * 1000).toISOString();
      const qs = new URLSearchParams({ after });
      if (runsStatus) qs.set('status', runsStatus);
      const res = await fetch(`${apiBase}/runs?${qs.toString()}`);
      const { ok, data } = await safePipelineJson(res);
      if (!ok || !data) { setRuns([]); return; }
      setRuns(Array.isArray(data.runs) ? data.runs : []);
    } catch { setRuns([]); }
  }, [apiBase, runsAfterDays, runsStatus]);

  useEffect(() => {
    // Spec + runs only load for a real, bound item. `bound` stays null while
    // `isNew` (loadBinding short-circuits), so this never targets "new".
    if (bound && !isNew) { loadPipeline(); loadRuns(); }
  }, [bound, isNew, loadPipeline, loadRuns]);

  const save = useCallback(async () => {
    if (!bound) return;
    setBusy(true); setError(null);
    try { window.dispatchEvent(new CustomEvent('loom:item-saving')); } catch {}
    try {
      const parsed = JSON.parse(spec);
      const res = await fetch(apiBase, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(parsed),
      });
      const { ok, data, error: e } = await safePipelineJson(res);
      if (!ok) throw new Error(e || 'save failed');
      setOrigSpec(spec);
      try { window.dispatchEvent(new CustomEvent('loom:item-saved', { detail: { label: bound } })); } catch {}
      void data;
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setBusy(false); }
  }, [apiBase, bound, spec]);

  const dirty = spec !== origSpec;

  const kick = useCallback(async (action: 'run' | 'debug') => {
    if (!bound) return;
    setBusy(true); setError(null);
    try {
      const res = await fetch(`${apiBase}/${action}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ params: {} }),
      });
      const { ok, error: e } = await safePipelineJson(res);
      if (!ok) throw new Error(e || `${action} failed`);
      setTimeout(() => loadRuns(), 1500);
      setTab('runs');
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setBusy(false); }
  }, [apiBase, bound, loadRuns]);

  const validate = useCallback(async () => {
    if (!bound) return;
    setBusy(true); setError(null); setValidation(null);
    try {
      let parsed: any = undefined;
      try { parsed = JSON.parse(spec); } catch { /* validate persisted */ }
      const res = await fetch(`${apiBase}/validate`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(parsed ? { definition: parsed } : {}),
      });
      const { data } = await safePipelineJson(res);
      if (!data || data.ok === false) { setValidation({ ok: false, message: data?.error || 'validation failed' }); return; }
      const n = data.validation?.activities?.length ?? 0;
      setValidation({ ok: true, message: `Validation passed — accepts ${n} activit${n === 1 ? 'y' : 'ies'}.` });
    } catch (e: any) { setValidation({ ok: false, message: e?.message || String(e) }); }
    finally { setBusy(false); }
  }, [apiBase, bound, spec]);

  // ------------------------------------------------------------------
  // Triggers
  // ------------------------------------------------------------------
  const loadTriggers = useCallback(async () => {
    setTriggersError(null);
    try {
      const res = await fetch(`${apiBase}/triggers`);
      const { ok, data, error: e } = await safePipelineJson(res);
      if (!ok || !data) { setTriggersList([]); setTriggersError(e || 'list triggers failed'); return; }
      setTriggersList((data.triggers || []).map((t: any) => ({
        name: t.name,
        type: t.properties?.type || t.type,
        runtimeState: t.properties?.runtimeState || t.runtimeState,
      })));
      if (data.paramSources) setParamSources(data.paramSources);
    } catch (e: any) { setTriggersError(e?.message || String(e)); }
  }, [apiBase]);

  const openTriggers = useCallback(() => { setTriggersOpen(true); if (bound) loadTriggers(); }, [bound, loadTriggers]);

  const triggerAction = useCallback(async (name: string, action: 'start' | 'stop' | 'delete') => {
    setTriggersBusy(true); setTriggersError(null);
    try {
      const res = await fetch(`${apiBase}/triggers`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, action }),
      });
      const { ok, error: e } = await safePipelineJson(res);
      if (!ok) throw new Error(e || `${action} failed`);
      await loadTriggers();
    } catch (e: any) { setTriggersError(e?.message || String(e)); }
    finally { setTriggersBusy(false); }
  }, [apiBase, loadTriggers]);

  // Create ANY ADF trigger type from the deepened guided wizard's structured
  // payload (no cron / no JSON). `properties` is the assembled ADF trigger
  // `properties` object; `paramBindings` carry per-parameter VALUE sources
  // (direct / Key Vault / App Config) the BFF route resolves server-side. The
  // wizard already bakes trigger-output expressions into properties.pipelines[].
  const createTriggerWith = useCallback(async (
    name: string,
    properties: Record<string, unknown>,
    paramBindings: Record<string, ParamBinding>,
  ) => {
    if (!bound || !name.trim()) return;
    setTriggersBusy(true); setTriggersError(null);
    try {
      const res = await fetch(`${apiBase}/triggers`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), properties, parameterBindings: paramBindings }),
      });
      const { ok, error: e } = await safePipelineJson(res);
      if (!ok) throw new Error(e || 'create failed');
      setTriggerWizardOpen(false);
      await loadTriggers();
    } catch (e: any) { setTriggersError(e?.message || String(e)); }
    finally { setTriggersBusy(false); }
  }, [apiBase, bound, loadTriggers]);

  // ------------------------------------------------------------------
  // Activities — extracted from the spec; the designer (palette + canvas)
  // owns adding/removing/wiring them and writes back via onActivitiesChange.
  // ------------------------------------------------------------------
  const activities = extractActivities(spec);
  const activityCount = activities.length;

  // ------------------------------------------------------------------
  // Pipeline-level config model (Parameters / Variables / Settings) — these
  // round-trip the spec's `properties.parameters|variables|concurrency|
  // annotations|description` without touching activities. Each editor maps to
  // the ADF "pipeline configurations pane".
  // ------------------------------------------------------------------
  const specModel = useMemo<PipelineSpec>(() => {
    try {
      const obj = JSON.parse(spec || '{}');
      if (!obj.properties) obj.properties = { activities: [] };
      if (!Array.isArray(obj.properties.activities)) obj.properties.activities = [];
      return obj as PipelineSpec;
    } catch {
      return { properties: { activities: [] } };
    }
  }, [spec]);

  const pipelineParameters = useMemo(() => paramsFromSpec(specModel), [specModel]);
  const pipelineVariables = useMemo(() => varsFromSpec(specModel), [specModel]);

  const patchSpecProperties = useCallback((patch: (props: PipelineSpec['properties']) => void) => {
    setSpec((prev) => {
      let parsed: any;
      try { parsed = JSON.parse(prev || '{"properties":{}}'); } catch { return prev; }
      if (!parsed.properties || typeof parsed.properties !== 'object') parsed.properties = {};
      if (!Array.isArray(parsed.properties.activities)) parsed.properties.activities = [];
      patch(parsed.properties);
      return JSON.stringify(parsed, null, 2);
    });
  }, []);

  const setPipelineParameters = useCallback((next: PipelineParameter[]) => {
    patchSpecProperties((p) => { p.parameters = paramsToSpec(next); });
  }, [patchSpecProperties]);

  const setPipelineVariables = useCallback((next: PipelineVariable[]) => {
    patchSpecProperties((p) => { p.variables = varsToSpec(next); });
  }, [patchSpecProperties]);

  const setPipelineSettings = useCallback((next: { description?: string; concurrency?: number; annotations?: string[] }) => {
    patchSpecProperties((p) => {
      if ('description' in next) p.description = next.description;
      if ('concurrency' in next) { if (next.concurrency == null) delete (p as any).concurrency; else p.concurrency = next.concurrency; }
      if ('annotations' in next) p.annotations = next.annotations;
    });
  }, [patchSpecProperties]);

  // Ctrl+S to save
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (bound && dirty && !busy) save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [bound, dirty, busy, save]);

  // ------------------------------------------------------------------
  // Canvas apply bridge — the Pipeline Copilot pane (rightPanel) emits a
  // generated/upserted spec via `onApplySpec`; we set it on the real React-Flow
  // canvas. The spec is ALREADY persisted to the bound ADF/Synapse pipeline by
  // the pipeline_apply_canvas tool, so we mark it clean (origSpec = spec) and
  // refresh runs. fitToScreen after the designer re-renders the new nodes.
  // ------------------------------------------------------------------
  const applyGeneratedSpec = useCallback((generated: PipelineSpec) => {
    const txt = JSON.stringify(generated, null, 2);
    setSpec(txt);
    setOrigSpec(txt);
    setTab('graph');
    setValidation(null);
    setTimeout(() => designerRef.current?.fitToScreen(), 150);
    void loadRuns();
  }, [loadRuns]);

  // ADF Studio toolbar — Save · Validate · Debug · Run (trigger now) · Add
  // trigger · canvas layout controls (auto-align / fit). Activities are added
  // from the left palette pane in the designer, matching ADF Studio (no
  // activity buttons in the toolbar).
  const ribbon: RibbonTab[] = useMemo(() => {
    const validateGroup: RibbonTab['groups'] = config.supportsValidate ? [{
      label: 'Validate', actions: [
        { label: busy ? 'Validating…' : 'Validate', icon: <Checkmark20Regular />, onClick: !busy && bound ? validate : undefined, disabled: busy || !bound, title: !bound ? 'Bind a pipeline first' : undefined },
      ],
    }] : [];
    // Manage hub — linked services / datasets (+ integration runtimes for ADF).
    // Available for BOTH ADF and Synapse pipelines, regardless of pipeline
    // binding. Synapse pipelines reach their own /api/synapse/* resources; the
    // backend is selected on the ManagePanel below.
    const manageGroup: RibbonTab['groups'] = [{
      label: 'Manage', actions: [
        { label: 'Manage', icon: <Settings20Regular />, onClick: () => setManageOpen(true), title: isAdf ? 'Linked services, datasets and integration runtimes (quick)' : 'Linked services and datasets (quick)' },
        { label: 'Linked services', icon: <PlugConnected20Regular />, onClick: () => openManageHub('linked-services'), title: 'Connector gallery — browse 30+ connectors, create, edit and delete connections' },
        { label: 'Datasets', icon: <Database20Regular />, onClick: () => openManageHub('datasets'), title: 'Dataset wizard — create, edit and delete datasets (connector → connection → shape → schema)' },
        { label: 'Integration runtimes', icon: <Server20Regular />, onClick: () => openManageHub('integration-runtimes'), title: 'Azure auto-resolve / Self-Hosted / Azure-SSIS integration runtimes' },
      ],
    }];
    return [
      { id: 'home', label: 'Home', groups: [
        { label: 'Save', actions: [
          { label: busy ? 'Saving…' : 'Save', icon: <Save20Regular />, onClick: !busy && bound && dirty ? save : undefined, disabled: busy || !bound || !dirty, title: !bound ? 'Bind a pipeline first' : (!dirty ? 'No changes' : undefined) },
        ] },
        ...validateGroup,
        ...manageGroup,
        { label: 'Run', actions: [
          { label: busy ? 'Running…' : 'Debug', icon: <Bug20Regular />, onClick: !busy && bound && !dirty ? () => kick('debug') : undefined, disabled: busy || !bound || dirty, title: dirty ? 'Save the spec first' : (!bound ? 'Bind a pipeline first' : undefined) },
          { label: busy ? 'Running…' : 'Trigger now', icon: <Play20Regular />, onClick: !busy && bound && !dirty ? () => kick('run') : undefined, disabled: busy || !bound || dirty, title: dirty ? 'Save the spec first' : (!bound ? 'Bind a pipeline first' : undefined) },
          { label: 'Add trigger', icon: <Clock20Regular />, onClick: bound ? openTriggers : undefined, disabled: !bound, title: !bound ? 'Bind a pipeline first' : undefined },
        ] },
        { label: 'Layout', actions: [
          { label: 'Auto align', onClick: bound ? () => designerRef.current?.autoAlign() : undefined, disabled: !bound },
          { label: 'Zoom to fit', onClick: bound ? () => designerRef.current?.fitToScreen() : undefined, disabled: !bound },
        ] },
      ] },
    ];
  }, [config.supportsValidate, isAdf, busy, bound, dirty, save, kick, validate, openTriggers, openManageHub]);

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------
  const bindGate = (
    <MessageBar intent="warning">
      <MessageBarBody>
        <MessageBarTitle>This pipeline isn’t bound to a real Azure pipeline yet</MessageBarTitle>
        A Loom pipeline item is a handle — bind it to an existing {config.containerLabel} pipeline, or create a
        new one. Every action below (Run, Debug, Validate, Triggers, Save) targets the bound pipeline.
        {listError && (<><br /><strong>Listing pipelines failed:</strong> {listError}</>)}
      </MessageBarBody>
    </MessageBar>
  );

  // ------------------------------------------------------------------
  // [BUG A] New-item create gate. A `/new` route (e.g. "+ New item" from home)
  // has no Cosmos item, so the per-item bind route can't run with the literal
  // "new" (it 404s). Render a create-gate that creates a REAL Loom item first,
  // then redirects to its GUID where the full bind/run/save flow takes over.
  // This single change fixes BOTH the data-pipeline delegation path
  // (AdfPipelineEditor / SynapsePipelineEditor) and the direct
  // /items/adf-pipeline/new + /items/synapse-pipeline/new routes — all funnel
  // through PipelineEditorCore. All hooks above run unconditionally, so this
  // early return is hooks-safe.
  // ------------------------------------------------------------------
  if (isNew) {
    const wsList = createWorkspaces || [];
    const noWorkspaces = !createWsLoading && !createWsError && wsList.length === 0;
    const selectedWsName = wsList.find((w) => w.id === createWorkspaceId)?.name || '';
    const canCreate = !createBusy && !!createWorkspaceId && !!createName.trim();
    const createRibbon: RibbonTab[] = [
      { id: 'home', label: 'Home', groups: [
        { label: 'New', actions: [
          { label: createBusy ? 'Creating…' : 'Create pipeline', icon: <Add20Regular />,
            onClick: canCreate ? createPipelineItem : undefined, disabled: !canCreate,
            title: !createWorkspaceId ? 'Select a workspace' : !createName.trim() ? 'Enter a pipeline name' : undefined },
        ] },
      ] },
    ];
    return (
      <ItemEditorChrome item={item} id={id} ribbon={createRibbon} main={
        <div className={s.gate}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS }}>
            <Subtitle2>New {isAdf ? 'Data Factory' : 'Synapse'} pipeline</Subtitle2>
            <Body1 style={{ display: 'block', color: tokens.colorNeutralForeground3 }}>
              Pick a Loom workspace and name this pipeline. Loom creates the item, then opens the
              full editor where you bind it to a real {config.containerLabel} pipeline and
              Save / Run / Validate / Triggers run against the real Azure backend.
            </Body1>
          </div>

          {createWsError && (
            <MessageBar intent="warning">
              <MessageBarBody>
                <MessageBarTitle>Workspaces not reachable</MessageBarTitle>
                {createWsError}
                <br /><Caption1>The Cosmos `workspaces` container must be reachable and the Console UAMI granted data access.</Caption1>
              </MessageBarBody>
            </MessageBar>
          )}
          {noWorkspaces && (
            <MessageBar intent="warning">
              <MessageBarBody>
                <MessageBarTitle>Create or select a workspace first</MessageBarTitle>
                You don’t have any Loom workspaces yet. Create one (Home → New workspace), then return to create a pipeline.
              </MessageBarBody>
            </MessageBar>
          )}

          <Field label="Workspace">
            <Dropdown
              placeholder={createWsLoading ? 'Loading workspaces…' : noWorkspaces ? 'No workspaces available' : 'Select a workspace'}
              value={selectedWsName}
              selectedOptions={createWorkspaceId ? [createWorkspaceId] : []}
              disabled={createWsLoading || noWorkspaces || createBusy}
              onOptionSelect={(_, d) => setCreateWorkspaceId(d.optionValue || '')}
            >
              {wsList.map((w) => (<Option key={w.id} value={w.id} text={w.name}>{w.name}</Option>))}
            </Dropdown>
          </Field>
          <Field label="Pipeline name">
            <Input
              value={createName}
              onChange={(_, d) => setCreateName(d.value)}
              placeholder="ingest_orders"
              disabled={createBusy}
              onKeyDown={(e) => { if (e.key === 'Enter' && canCreate) createPipelineItem(); }}
            />
          </Field>
          <div className={s.row}>
            <Button appearance="primary" icon={<Add20Regular />} onClick={createPipelineItem} disabled={!canCreate}>
              {createBusy ? 'Creating…' : 'Create pipeline'}
            </Button>
            {createBusy && <Spinner size="tiny" />}
          </div>
          {createError && (
            <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Create failed</MessageBarTitle>{createError}</MessageBarBody></MessageBar>
          )}
          <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
            Creates the item in Cosmos and opens the full editor, where binding + the primary actions run against the real backend.
          </Caption1>
        </div>
      } />
    );
  }

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon}
      rightPanel={
        <PipelineCopilotPane apiBase={apiBase} bound={bound} onApplySpec={applyGeneratedSpec} />
      }
      leftPanel={
        isAdf ? (
          // ADF Studio Factory Resources navigator — typed groups with live
          // counts + ＋ New + delete, all real ADF REST. Selecting a pipeline
          // binds + opens it on the canvas.
          <FactoryResourcesTree
            boundPipeline={bound}
            onOpenPipeline={(name) => bindTo(name, false)}
            onOpenManage={() => setManageOpen(true)}
            onOpenCdc={(name) => setOpenCdc(name)}
            refreshKey={factoryRefreshKey}
          />
        ) : (
          // Synapse Studio Workspace Resources navigator — typed groups with
          // live counts + ＋ New + delete, all real Synapse dev-plane REST.
          <SynapseWorkspaceTree
            boundPipeline={bound}
            onOpenPipeline={(name) => bindTo(name, false)}
            onOpenKqlScript={(name) => setKqlScriptOpen(name)}
            onOpenSparkJobDef={(name) => setSparkJobDefOpen(name)}
            refreshKey={workspaceRefreshKey}
          />
        )
      }
      main={
        <div className={s.pad}>
          {bindingLoading ? (
            <div className={s.gate}><Spinner label="Resolving pipeline binding…" /></div>
          ) : !bound ? (
            <div className={s.gate}>
              {bindGate}
              {preview && Array.isArray(preview?.properties?.activities) && preview.properties.activities.length > 0 && (
                <div>
                  <div style={{ display: 'flex', gap: tokens.spacingVerticalS, alignItems: 'center', flexWrap: 'wrap', marginBottom: tokens.spacingVerticalS }}>
                    <Subtitle2>Starter graph from this app</Subtitle2>
                    <Badge appearance="outline">
                      {preview.properties.activities.length} activit{preview.properties.activities.length === 1 ? 'y' : 'ies'}
                    </Badge>
                    <Badge appearance="filled" color="informative">Preview · read-only</Badge>
                  </div>
                  <Body1 style={{ display: 'block', color: tokens.colorNeutralForeground3, marginBottom: tokens.spacingVerticalS }}>
                    This pipeline was installed from an app with a fully built-out activity graph
                    (every activity, dependency, and parameter shown below). Bind it to a real
                    {` ${config.containerLabel}`} pipeline above to push this graph live and enable
                    Save / Run / Validate / Triggers.
                  </Body1>
                  <PipelineDesigner
                    activities={extractActivities(JSON.stringify(preview)) as any}
                    parameters={paramsFromSpec(preview as PipelineSpec)}
                    variables={varsFromSpec(preview as PipelineSpec)}
                    onActivitiesChange={() => { /* read-only until bound */ }}
                  />
                </div>
              )}
              {isAdf && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS }}>
                  <Subtitle2>Data Factory</Subtitle2>
                  <Body1 style={{ display: 'block', color: tokens.colorNeutralForeground3 }}>
                    Use an existing Azure Data Factory across any subscription your account can see (Azure Resource Graph, your RBAC), or create a new one.
                  </Body1>
                  <RadioGroup
                    layout="horizontal"
                    value={factoryMode}
                    onChange={(_, d) => { setFactoryMode(d.value as 'existing' | 'create'); setFactoryCreateError(null); }}
                  >
                    <Radio value="existing" label="Use existing factory" />
                    <Radio value="create" label="Create new factory" />
                  </RadioGroup>

                  {factoryMode === 'existing' ? (
                    <>
                      <AzureResourcePicker
                        type="Microsoft.DataFactory/factories"
                        label="Data Factory"
                        placeholder="Select a factory across all subscriptions"
                        value={factory?.id}
                        onChange={(r) => setFactory(r)}
                      />
                      {factory && (
                        <MessageBar intent="info">
                          <MessageBarBody>
                            <MessageBarTitle>Factory selected: {factory.name}</MessageBarTitle>
                            Pipeline binding below lists pipelines from the deployment-default factory
                            (LOOM_ADF_NAME / LOOM_DLZ_RG). If <strong>{factory.name}</strong> is a different
                            factory, grant the Loom UAMI &quot;Data Factory Contributor&quot; on it and set
                            LOOM_ADF_NAME / LOOM_DLZ_RG / LOOM_SUBSCRIPTION_ID to point at it, or use the
                            MountedDataFactory editor which targets an external factory by reference.
                          </MessageBarBody>
                        </MessageBar>
                      )}
                    </>
                  ) : (
                    // Create-new factory wizard — name + target resource group
                    // (carries the subscription) + location. Real ARM PUT via
                    // /api/adf/factories/create (Contract E#1). No JSON textarea.
                    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, maxWidth: '560px' }}>
                      <Field label="New factory name" required hint="Globally unique within Azure; 3-63 chars, letters/digits/hyphens.">
                        <Input
                          value={newFactoryName}
                          onChange={(_, d) => { setNewFactoryName(d.value); setFactoryCreateError(null); }}
                          placeholder="adf-loom-myteam"
                        />
                      </Field>
                      <AzureResourcePicker
                        type="Microsoft.Resources/subscriptions/resourceGroups"
                        label="Target resource group"
                        placeholder="Select a resource group (across all subscriptions)"
                        value={newFactoryRg?.id}
                        onChange={(r) => {
                          setNewFactoryRg(r);
                          // Default the factory's region to the resource group's
                          // location; the operator can override below.
                          if (r?.location && !newFactoryLocation) setNewFactoryLocation(r.location);
                          setFactoryCreateError(null);
                        }}
                      />
                      <Field label="Location" required hint="Azure region for the new Data Factory.">
                        <Dropdown
                          placeholder="Select a region"
                          value={newFactoryLocation}
                          selectedOptions={newFactoryLocation ? [newFactoryLocation] : []}
                          onOptionSelect={(_, d) => setNewFactoryLocation(d.optionValue || '')}
                        >
                          {ADF_FACTORY_REGIONS.map((r) => (<Option key={r} value={r} text={r}>{r}</Option>))}
                        </Dropdown>
                      </Field>
                      <div className={s.row}>
                        <Button
                          appearance="primary"
                          icon={<Add20Regular />}
                          disabled={factoryCreateBusy || !newFactoryName.trim() || !newFactoryRg || !(newFactoryLocation || newFactoryRg?.location)}
                          onClick={createFactory}
                        >
                          {factoryCreateBusy ? 'Creating…' : 'Create factory'}
                        </Button>
                      </div>
                      {factoryCreateError && (
                        <MessageBar intent="error">
                          <MessageBarBody>
                            <MessageBarTitle>Could not create the factory</MessageBarTitle>
                            {factoryCreateError}
                          </MessageBarBody>
                        </MessageBar>
                      )}
                    </div>
                  )}
                </div>
              )}

              {!isAdf && (
                // Synapse runtime: the workspace picker's "Create new" is an
                // HONEST infra-gate (Contract E#4) — workspace provisioning is a
                // heavy deploy out of scope for in-editor creation. "Use existing"
                // remains fully functional via the env-pinned workspace.
                <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS }}>
                  <Subtitle2>Synapse workspace</Subtitle2>
                  <Body1 style={{ display: 'block', color: tokens.colorNeutralForeground3 }}>
                    Pipelines below are listed from the deployment-bound Synapse workspace.
                  </Body1>
                  <MessageBar intent="warning">
                    <MessageBarBody>
                      <MessageBarTitle>Create a new Synapse workspace from infrastructure</MessageBarTitle>
                      Provisioning a Synapse Analytics workspace is a full infrastructure deploy, not an
                      in-editor create. Deploy one with the bicep module
                      <code> platform/fiab/bicep/modules/data/synapse.bicep</code> and set
                      <code> LOOM_SYNAPSE_WORKSPACE</code> on the Console to point this editor at it. Using an
                      existing workspace (the binding below) works today with no further action.
                    </MessageBarBody>
                  </MessageBar>
                </div>
              )}

              {/* Backing services — Linked services & Integration runtimes.
                  Use-existing (the Manage hub, opened from the ribbon) | Create-new
                  (a STRUCTURED wizard: connector gallery → typed fields → name, or
                  IR type catalog → typed fields → name). Both POST the EXISTING
                  real ARM REST routes (no JSON textarea, no mock). IRs are
                  ADF-only (Synapse uses its own workspace IRs). */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS }}>
                <Subtitle2>Backing services</Subtitle2>
                <Body1 style={{ display: 'block', color: tokens.colorNeutralForeground3 }}>
                  Connect data stores (linked services){isAdf ? ' and integration runtimes' : ''} this pipeline&apos;s
                  activities use. Use existing ones, or create new ones with a guided wizard — all real Azure REST.
                </Body1>
                <div className={s.row}>
                  <Button appearance="secondary" icon={<Add20Regular />} onClick={() => setLsDialogOpen(true)}>
                    Create linked service
                  </Button>
                  {isAdf && (
                    <Button appearance="secondary" icon={<Add20Regular />} onClick={() => setIrDialogOpen(true)}>
                      Create integration runtime
                    </Button>
                  )}
                  <Button appearance="subtle" icon={<PlugConnected20Regular />} onClick={() => openManageHub('linked-services')}>
                    Manage existing
                  </Button>
                </div>
              </div>
              <div>
                <Subtitle2>Bind to an existing pipeline</Subtitle2>
                <div className={s.row} style={{ marginTop: tokens.spacingVerticalS }}>
                  <div className={s.field}>
                    <Field label={`Pipeline in this ${config.containerLabel}`}>
                      <Dropdown
                        placeholder={available.length ? 'Select a pipeline' : 'No pipelines found'}
                        value={pickName}
                        selectedOptions={pickName ? [pickName] : []}
                        onOptionSelect={(_, d) => setPickName(d.optionValue || '')}
                        disabled={!available.length || bindBusy}
                      >
                        {available.map((p) => (<Option key={p.name} value={p.name} text={p.name}>{p.name}</Option>))}
                      </Dropdown>
                    </Field>
                  </div>
                  <Button appearance="primary" icon={<Link20Regular />} disabled={!pickName || bindBusy} onClick={() => bindTo(pickName, false)}>
                    {bindBusy ? 'Binding…' : 'Bind'}
                  </Button>
                </div>
              </div>
              <div>
                <Subtitle2>Create a new pipeline</Subtitle2>
                <Body1 style={{ display: 'block', color: tokens.colorNeutralForeground3 }}>
                  Creates an empty pipeline in the {config.containerLabel} via the real REST API and binds this item to it.
                </Body1>
                <div className={s.row} style={{ marginTop: tokens.spacingVerticalS }}>
                  <div className={s.field}>
                    <Field label="New pipeline name">
                      <Input value={newName} onChange={(_, d) => setNewName(d.value)} placeholder="ingest_orders" />
                    </Field>
                  </div>
                  <Button appearance="secondary" icon={<Add20Regular />} disabled={!newName.trim() || bindBusy} onClick={() => bindTo(newName, true)}>
                    {bindBusy ? 'Creating…' : 'Create & bind'}
                  </Button>
                </div>
              </div>
              {bindError && (
                <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Bind failed</MessageBarTitle>{bindError}</MessageBarBody></MessageBar>
              )}
            </div>
          ) : (
            <>
              <div style={{ display: 'flex', gap: tokens.spacingVerticalS, alignItems: 'center', flexWrap: 'wrap', minWidth: 0 }}>
                <Badge appearance="filled" color="brand" style={{ maxWidth: '100%', overflowWrap: 'anywhere', wordBreak: 'break-word', height: 'auto' }}>{bound}</Badge>
                <Badge appearance="outline">{activityCount} activit{activityCount === 1 ? 'y' : 'ies'}</Badge>
                {dirty && <Badge appearance="outline" color="warning">unsaved</Badge>}
                {validation && <Badge appearance="filled" color={validation.ok ? 'success' : 'danger'}>{validation.ok ? 'Validated' : 'Invalid'}</Badge>}
                <Button size="small" appearance="subtle" icon={<Link20Regular />} onClick={() => { setBound(null); loadBinding(); }}>Rebind</Button>
                <Button size="small" appearance="subtle" icon={<ArrowSync20Regular />} onClick={() => { loadPipeline(); loadRuns(); }} style={{ marginLeft: 'auto' }}>Refresh</Button>
              </div>
              {error && (<BackendStateBar error={error} title="Pipeline API" />)}
              {validation && (
                <MessageBar intent={validation.ok ? 'success' : 'error'}><MessageBarBody>{validation.message}</MessageBarBody></MessageBar>
              )}
              {/* ADF Studio pipeline configurations tab row: the canvas
                  ("Activities") plus the configuration panes. */}
              <div style={{ borderBottom: `1px solid ${tokens.colorNeutralStroke2}` }}>
                <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as typeof tab)}>
                  <Tab value="graph">Activities</Tab>
                  <Tab value="parameters">Parameters ({pipelineParameters.length})</Tab>
                  <Tab value="variables">Variables ({pipelineVariables.length})</Tab>
                  <Tab value="settings">Settings</Tab>
                  <Tab value="json">Code (JSON)</Tab>
                  <Tab value="runs">Output ({runs.length})</Tab>
                </TabList>
              </div>
              {tab === 'graph' && (
                <PipelineDesigner
                  ref={designerRef}
                  activities={activities as any}
                  parameters={pipelineParameters}
                  variables={pipelineVariables}
                  onActivitiesChange={(next) => setSpec((prev) => writeActivitiesToSpec(prev || '{"properties":{}}', next as any))}
                />
              )}
              {tab === 'parameters' && (
                <ParametersPane
                  parameters={pipelineParameters}
                  variables={pipelineVariables}
                  onChange={setPipelineParameters}
                  pipelineId={id}
                />
              )}
              {tab === 'variables' && (
                <VariablesPane variables={pipelineVariables} onChange={setPipelineVariables} />
              )}
              {tab === 'settings' && (
                <SettingsPane
                  description={specModel.properties.description || ''}
                  concurrency={specModel.properties.concurrency}
                  annotations={(specModel.properties.annotations as string[]) || []}
                  onChange={setPipelineSettings}
                />
              )}
              {tab === 'json' && (
                <MonacoTextarea value={spec} onChange={setSpec} language="json" height={400} minHeight={320} ariaLabel="Pipeline spec editor" />
              )}
              {tab === 'runs' && (
                <div style={{ overflow: 'auto' }}>
                  <div style={{ display: 'flex', gap: tokens.spacingVerticalM, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: tokens.spacingVerticalS }}>
                    <Field label="Window">
                      <Dropdown
                        value={runsAfterDays === 1 ? 'Last 24 hours' : runsAfterDays === 14 ? 'Last 14 days' : runsAfterDays === 30 ? 'Last 30 days' : 'Last 7 days'}
                        selectedOptions={[String(runsAfterDays)]}
                        onOptionSelect={(_, d) => d.optionValue && setRunsAfterDays(Number(d.optionValue) || 7)}
                      >
                        <Option value="1" text="Last 24 hours">Last 24 hours</Option>
                        <Option value="7" text="Last 7 days">Last 7 days</Option>
                        <Option value="14" text="Last 14 days">Last 14 days</Option>
                        <Option value="30" text="Last 30 days">Last 30 days</Option>
                      </Dropdown>
                    </Field>
                    <Field label="Status">
                      <Dropdown value={runsStatus || 'Any'} selectedOptions={[runsStatus]} onOptionSelect={(_, d) => setRunsStatus(d.optionValue || '')}>
                        <Option value="" text="Any">Any</Option>
                        <Option value="Succeeded" text="Succeeded">Succeeded</Option>
                        <Option value="Failed" text="Failed">Failed</Option>
                        <Option value="InProgress" text="In progress">In progress</Option>
                        <Option value="Cancelled" text="Cancelled">Cancelled</Option>
                        <Option value="Queued" text="Queued">Queued</Option>
                      </Dropdown>
                    </Field>
                    <Button appearance="outline" icon={<ArrowSync20Regular />} onClick={() => loadRuns()}>Apply filter</Button>
                  </div>
                  <Table aria-label="Pipeline runs" size="small">
                    <TableHeader><TableRow>
                      <TableHeaderCell>Run ID</TableHeaderCell>
                      <TableHeaderCell>Status</TableHeaderCell>
                      <TableHeaderCell>Start</TableHeaderCell>
                      <TableHeaderCell>Duration</TableHeaderCell>
                      <TableHeaderCell>Invoked by</TableHeaderCell>
                    </TableRow></TableHeader>
                    <TableBody>
                      {runs.length === 0 && (<TableRow><TableCell colSpan={5}><Caption1>No runs in window.</Caption1></TableCell></TableRow>)}
                      {runs.map((r) => (
                        <TableRow key={r.runId}>
                          <TableCell><code style={{ fontSize: tokens.fontSizeBase100 }}>{r.runId.slice(0, 8)}…</code></TableCell>
                          <TableCell><Badge appearance="filled" color={r.status === 'Succeeded' ? 'success' : r.status === 'Failed' ? 'danger' : r.status === 'InProgress' ? 'warning' : 'informative'}>{r.status || '—'}</Badge></TableCell>
                          <TableCell>{r.runStart ? new Date(r.runStart).toLocaleString() : '—'}</TableCell>
                          <TableCell>{r.durationInMs != null ? `${(r.durationInMs / 1000).toFixed(1)}s` : '—'}</TableCell>
                          <TableCell>{r.invokedBy?.name || '—'} <Caption1>({r.invokedBy?.invokedByType || '—'})</Caption1></TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </>
          )}

          <ManagePanel
            open={manageOpen}
            backend={isAdf ? 'adf' : 'synapse'}
            onOpenChange={(open) => {
              setManageOpen(open);
              // On close, the navigator re-lists so linked-service / dataset /
              // IR changes made in the Manage hub reflect in the counts.
              if (!open) {
                if (isAdf) setFactoryRefreshKey((k) => k + 1);
                else setWorkspaceRefreshKey((k) => k + 1);
              }
            }}
          />

          {/* Catalog-driven Manage hub — connector gallery (create/edit/delete
              linked services) + dataset wizard (create/edit/delete) + the
              Integration runtimes tab. Factory/workspace-level; the ADF IR tab is
              factory-scoped (deployment-default factory via /api/adf/
              integration-runtimes), so itemId/workspaceId are not needed. */}
          <PipelineManageHub
            open={manageHubOpen}
            onOpenChange={(open) => {
              setManageHubOpen(open);
              if (!open) {
                if (isAdf) setFactoryRefreshKey((k) => k + 1);
                else setWorkspaceRefreshKey((k) => k + 1);
              }
            }}
            engine={isAdf ? 'adf' : 'synapse'}
            initialTab={manageHubTab}
          />

          {/* Create-new LINKED SERVICE (bind-gate entry point) — reuses the
              shared structured connector wizard: a searchable connector gallery →
              per-connector typed fields (NO JSON textarea) → name, posting the
              real /api/adf/linked-services (or /api/synapse/linkedservices) ARM
              upsert. On create we bump the navigator so the new connection shows
              in its live counts. */}
          <Dialog open={lsDialogOpen} onOpenChange={(_, d) => { if (!d.open) setLsDialogOpen(false); }}>
            <DialogSurface style={{ maxWidth: '920px', width: '92vw' }}>
              <DialogBody>
                <DialogTitle
                  action={<Button appearance="subtle" icon={<Dismiss24Regular />} aria-label="Close" onClick={() => setLsDialogOpen(false)} />}>
                  New linked service
                </DialogTitle>
                <DialogContent>
                  <LinkedServiceGallery
                    engine={isAdf ? 'adf' : 'synapse'}
                    hideExisting
                    onSelected={() => {
                      setLsDialogOpen(false);
                      if (isAdf) setFactoryRefreshKey((k) => k + 1);
                      else setWorkspaceRefreshKey((k) => k + 1);
                    }}
                  />
                </DialogContent>
                <DialogActions>
                  <Button appearance="secondary" onClick={() => setLsDialogOpen(false)}>Cancel</Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>

          {/* Create-new INTEGRATION RUNTIME (bind-gate entry point, ADF only) —
              reuses the shared IR manager (factory-scoped → /api/adf/
              integration-runtimes). Type catalog (Azure / Self-Hosted / Azure-SSIS)
              → typed config fields (NO JSON), real ARM upsert. */}
          {isAdf && (
            <Dialog open={irDialogOpen} onOpenChange={(_, d) => { if (!d.open) setIrDialogOpen(false); }}>
              <DialogSurface style={{ maxWidth: '860px', width: '92vw' }}>
                <DialogBody>
                  <DialogTitle
                    action={<Button appearance="subtle" icon={<Dismiss24Regular />} aria-label="Close" onClick={() => setIrDialogOpen(false)} />}>
                    Integration runtimes
                  </DialogTitle>
                  <DialogContent>
                    <IntegrationRuntimeManager
                      factoryScoped
                      engine="adf"
                      onSelect={() => { setFactoryRefreshKey((k) => k + 1); }}
                    />
                  </DialogContent>
                  <DialogActions>
                    <Button appearance="secondary" onClick={() => setIrDialogOpen(false)}>Close</Button>
                  </DialogActions>
                </DialogBody>
              </DialogSurface>
            </Dialog>
          )}

          {/* Change Data Capture (preview) detail panel — opened from the
              Factory Resources navigator. Inspect status + source→target
              mapping and Start/Stop/Delete (real ADF adfcdcs ARM REST). */}
          <AdfCdcEditor
            name={openCdc}
            onClose={(changed) => {
              setOpenCdc(null);
              if (changed) setFactoryRefreshKey((k) => k + 1);
            }}
          />

          {/* Synapse workspace artifact editors (Develop hub parity). Opened
              from the Workspace Resources navigator; on close the navigator
              re-lists so any rename/connection change reflects in the counts. */}
          {kqlScriptOpen && (
            <SynapseKqlEditor
              name={kqlScriptOpen}
              onClose={() => { setKqlScriptOpen(null); setWorkspaceRefreshKey((k) => k + 1); }}
            />
          )}
          {sparkJobDefOpen && (
            <SynapseSparkEditor
              name={sparkJobDefOpen}
              onClose={() => { setSparkJobDefOpen(null); setWorkspaceRefreshKey((k) => k + 1); }}
            />
          )}

          <Dialog open={triggersOpen} onOpenChange={(_, d) => setTriggersOpen(d.open)}>
            <DialogSurface style={{ maxWidth: '760px', width: '90vw' }}>
              <DialogBody>
                <DialogTitle>Triggers — {bound}</DialogTitle>
                <DialogContent>
                  <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' }}>
                    <Caption1 style={{ flex: 1, minWidth: '200px' }}>Triggers that fire this pipeline — schedule, tumbling window, storage event, or custom event. Start / stop / delete existing ones, or create a new one with the guided wizard (real ARM REST).</Caption1>
                    <Button size="small" appearance="primary" icon={<Add20Regular />} disabled={triggersBusy} onClick={() => { setTriggersError(null); setTriggerWizardOpen(true); }}>New trigger</Button>
                  </div>
                  <div style={{ overflow: 'auto', marginTop: tokens.spacingVerticalS, marginBottom: tokens.spacingVerticalM }}>
                    <Table aria-label="Triggers for pipeline" size="small">
                      <TableHeader><TableRow>
                        <TableHeaderCell>Name</TableHeaderCell>
                        <TableHeaderCell>Type</TableHeaderCell>
                        <TableHeaderCell>State</TableHeaderCell>
                        <TableHeaderCell>Actions</TableHeaderCell>
                      </TableRow></TableHeader>
                      <TableBody>
                        {triggersList.length === 0 && (<TableRow><TableCell colSpan={4}><Caption1>No triggers wired to this pipeline.</Caption1></TableCell></TableRow>)}
                        {triggersList.map((t) => (
                          <TableRow key={t.name}>
                            <TableCell><strong>{t.name}</strong></TableCell>
                            <TableCell><code>{t.type || '—'}</code></TableCell>
                            <TableCell><Badge appearance="filled" color={t.runtimeState === 'Started' ? 'success' : t.runtimeState === 'Stopped' ? 'informative' : 'warning'}>{t.runtimeState || '—'}</Badge></TableCell>
                            <TableCell>
                              <div style={{ display: 'flex', gap: tokens.spacingVerticalXS }}>
                                <Button size="small" disabled={triggersBusy || t.runtimeState === 'Started'} onClick={() => triggerAction(t.name, 'start')}>Start</Button>
                                <Button size="small" disabled={triggersBusy || t.runtimeState !== 'Started'} onClick={() => triggerAction(t.name, 'stop')}>Stop</Button>
                                <Button size="small" appearance="subtle" disabled={triggersBusy} onClick={() => triggerAction(t.name, 'delete')}>Delete</Button>
                              </div>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                  {triggersError && (<MessageBar intent="error" style={{ marginTop: tokens.spacingVerticalM }}><MessageBarBody><MessageBarTitle>Trigger action failed</MessageBarTitle>{triggersError}</MessageBarBody></MessageBar>)}
                </DialogContent>
                <DialogActions>
                  <Button appearance="secondary" onClick={() => setTriggersOpen(false)} disabled={triggersBusy}>Close</Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>

          {/* Deepened "Add trigger → New" wizard — Schedule / Tumbling window /
              Storage event / Custom event with structured controls + per-param
              trigger-output / value-source mapping (no cron / no JSON). Created
              triggers round-trip the trigger JSON on the real ARM REST. */}
          <TriggerWizard
            open={triggerWizardOpen}
            onClose={() => { setTriggerWizardOpen(false); setTriggersError(null); }}
            onCreate={createTriggerWith}
            onActivate={(name) => triggerAction(name, 'start')}
            pipelineParams={pipelineParameters}
            engine={isAdf ? 'adf' : 'synapse'}
            kvAvailable={paramSources.kvAvailable}
            appConfigAvailable={paramSources.appConfigAvailable}
            busy={triggersBusy}
            error={triggersError}
          />
        </div>
      }
    />
  );
}
