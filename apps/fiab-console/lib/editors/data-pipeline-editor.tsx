'use client';

/**
 * DataPipelineEditor — Fabric Data Pipeline parity rebuild.
 *
 * Three-pane layout (matches Fabric exactly):
 *   ┌──────────┬────────────────────────────────────┬───────────────┐
 *   │ Activities│      Canvas (DAG + DnD)            │  Properties  │
 *   │  palette  │                                    │   (selected) │
 *   ├──────────┴────────────────────────────────────┴───────────────┤
 *   │  Top tabs: Pipeline | Parameters | Variables | Settings | Output│
 *   └─────────────────────────────────────────────────────────────────┘
 *
 * Ribbon (above): Home (Save, Refresh, Validate, Run, Debug, Schedule,
 * Add trigger, Discard), View (Show grid, Snap to grid, Fit to screen,
 * Reset zoom), Output (pin/unpin).
 *
 * Real backend per .claude/rules/no-vaporware.md:
 *   - Save     → PUT /api/items/data-pipeline/[id] (ADF upsertPipeline)
 *   - Validate → POST /api/items/data-pipeline/[id]/validate
 *   - Run      → POST /api/items/data-pipeline/[id]/run
 *   - Debug    → POST /api/items/data-pipeline/[id]/debug
 *   - Schedule → POST /api/items/data-pipeline/[id]/triggers
 *   - Output   → GET  /api/items/data-pipeline/[id]/output[?runId=...]
 *   - List/Create → /api/items/data-pipeline
 *
 * Activities not natively supported by ADF (DataflowGen2 refresh,
 * Office365 send-email) are saveable but flagged "Save-only" with a
 * MessageBar so the editor stays honest.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Subtitle2, Caption1, Badge, Button, Spinner, Input,
  Tree, TreeItem, TreeItemLayout, Select, Field, Textarea,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  makeStyles, mergeClasses, tokens,
  Toast, ToastTitle, useToastController, Toaster, useId,
} from '@fluentui/react-components';
import {
  Play20Regular, Add20Regular, Save20Regular, ArrowSync20Regular, Delete20Regular, Flow20Regular,
  Checkmark20Regular, Bug20Regular, Clock20Regular, Settings20Regular,
} from '@fluentui/react-icons';
import { ItemEditorChrome } from './item-editor-chrome';
import { ManagePanel } from '@/lib/components/pipeline/manage-panel';
import { ActivityPalette } from '@/lib/components/pipeline/palette';
import { PipelineCanvas, type CanvasHandle } from '@/lib/components/pipeline/canvas';
import { PropertiesPanel } from '@/lib/components/pipeline/properties-panel';
import { TopTabs, type TopTabId } from '@/lib/components/pipeline/top-tabs';
import { OutputPane } from '@/lib/components/pipeline/output-pane';
import {
  ACTIVITY_CATALOG, findByKey, nextNameSuffix, type ActivityTypeDef,
} from '@/lib/components/pipeline/activity-catalog';
import {
  type PipelineActivity, type PipelineSpec, type PipelineParameter, type PipelineVariable,
  type PipelineParameterType,
  textToSpec, specToText, paramsFromSpec, paramsToSpec, varsFromSpec, varsToSpec,
} from '@/lib/components/pipeline/types';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';
import { MonacoTextarea } from '@/lib/components/editor/monaco-textarea';

const useStyles = makeStyles({
  shell: {
    display: 'flex', flexDirection: 'column', gap: '8px', padding: '12px', flex: 1, minHeight: 0,
  },
  topbar: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' },
  threePane: { display: 'flex', flex: 1, minHeight: '480px', gap: '8px' },
  paletteCol: {
    flexShrink: 0,
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: '4px',
    overflow: 'hidden',
    display: 'flex',
  },
  centerCol: { flex: 1, display: 'flex', flexDirection: 'column', gap: '8px', minWidth: 0 },
  treePad: { padding: '8px' },
  tabBody: { padding: '12px', overflow: 'auto', flex: 1, display: 'flex', flexDirection: 'column', gap: '8px' },

  // ── ADF-Studio designer layout: palette | (canvas over a resizable config dock) ──
  // The canvas FILLS the space above the dock; the dock has an explicit,
  // user-dragged height with its own internal scroll, so expanding/collapsing
  // sections inside the activity config NEVER resizes the canvas.
  designerRow: { display: 'flex', flex: 1, minHeight: '560px', gap: '8px', minWidth: 0 },
  designerMain: { flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 },
  canvasWrap: { flex: 1, minHeight: '180px', display: 'flex', overflow: 'hidden' },
  splitter: {
    flexShrink: 0,
    height: '10px',
    cursor: 'row-resize',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    touchAction: 'none',
    ':hover': { backgroundColor: tokens.colorNeutralBackground3 },
  },
  splitterActive: { backgroundColor: tokens.colorBrandBackground2 },
  splitterGrip: {
    width: '44px',
    height: '4px',
    borderRadius: '2px',
    backgroundColor: tokens.colorNeutralStroke1,
  },
  configDock: {
    flexShrink: 0,
    overflow: 'auto',
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: '4px',
    minHeight: '120px',
  },
});

interface WorkspaceLite { id: string; name: string; isOnDedicatedCapacity?: boolean; }
interface PipelineLite { id: string; displayName: string; description?: string; }

function toB64(s: string): string {
  return typeof window === 'undefined' ? Buffer.from(s, 'utf-8').toString('base64')
    : btoa(unescape(encodeURIComponent(s)));
}
function fromB64(b: string): string {
  try {
    return typeof window === 'undefined' ? Buffer.from(b, 'base64').toString('utf-8')
      : decodeURIComponent(escape(atob(b)));
  } catch { return ''; }
}

const STARTER: PipelineSpec = {
  properties: {
    activities: [],
    parameters: {},
    variables: {},
    annotations: [],
  },
};

function useWorkspaces() {
  const [workspaces, setWorkspaces] = useState<WorkspaceLite[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true); setError(null); setHint(null);
    try {
      const r = await fetch('/api/loom/workspaces');
      const j = await r.json();
      if (!j.ok) { setError(j.error || 'failed'); setHint(j.hint || null); setWorkspaces([]); }
      else setWorkspaces(j.workspaces || []);
    } catch (e: any) { setError(e?.message || String(e)); setWorkspaces([]); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);
  return { workspaces, error, hint, loading };
}

interface Props { item: FabricItemType; id: string; }

export function DataPipelineEditor({ item, id }: Props) {
  const s = useStyles();
  const ws = useWorkspaces();
  const toastId = useId('pipeline-toaster');
  const { dispatchToast } = useToastController(toastId);
  const canvasRef = useRef<CanvasHandle>(null);

  // Workspace / pipeline picker state
  const [workspaceId, setWorkspaceId] = useState('');
  const [pipelines, setPipelines] = useState<PipelineLite[] | null>(null);
  const [pipelineId, setPipelineId] = useState('');
  const [listErr, setListErr] = useState<string | null>(null);
  const [listHint, setListHint] = useState<string | null>(null);
  const [detailErr, setDetailErr] = useState<string | null>(null);

  // Spec state — single source of truth: a parsed PipelineSpec.
  const [spec, setSpec] = useState<PipelineSpec>(STARTER);
  const [dirty, setDirty] = useState(false);

  // Editor chrome state
  const [topTab, setTopTab] = useState<TopTabId>('pipeline');
  const [selectedActivity, setSelectedActivity] = useState<string | null>(null);
  const [snapToGrid, setSnapToGrid] = useState(true);
  const [showGrid, setShowGrid] = useState(true);
  const [outputPinned, setOutputPinned] = useState(false);

  // Activity-config dock height (ADF Studio docks config at the bottom of the
  // canvas with a draggable divider). Explicit height + internal scroll means
  // expanding/collapsing sections never resizes the canvas above it.
  const [configHeight, setConfigHeight] = useState(300);
  const [resizing, setResizing] = useState(false);
  const startResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = configHeight;
    setResizing(true);
    const onMove = (ev: MouseEvent) => {
      // Dragging up (clientY decreases) grows the bottom dock.
      const next = Math.max(120, Math.min(680, startH - (ev.clientY - startY)));
      setConfigHeight(next);
    };
    const onUp = () => {
      setResizing(false);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [configHeight]);

  // Lifecycle state
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [debugging, setDebugging] = useState(false);
  const [validating, setValidating] = useState(false);
  const [validation, setValidation] = useState<{ ok: boolean; message: string } | null>(null);

  // Create dialog
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createBusy, setCreateBusy] = useState(false);
  const [createErr, setCreateErr] = useState<string | null>(null);

  // Schedule dialog
  const [scheduleOpen, setScheduleOpen] = useState(false);
  // Manage hub (linked services / datasets) — Synapse-backed, the Azure-native
  // default for the Fabric data pipeline item.
  const [manageOpen, setManageOpen] = useState(false);
  const [triggerName, setTriggerName] = useState('');
  const [triggerCron, setTriggerCron] = useState('0 0 * * *');
  const [triggerBusy, setTriggerBusy] = useState(false);
  const [triggerErr, setTriggerErr] = useState<string | null>(null);
  const [triggers, setTriggers] = useState<Array<{ name: string; type?: string; runtimeState?: string }>>([]);

  // ============ Loaders ============
  const loadList = useCallback(async (wsId: string) => {
    setListErr(null); setListHint(null);
    try {
      const r = await fetch(`/api/items/data-pipeline?workspaceId=${encodeURIComponent(wsId)}`);
      const j = await r.json();
      if (!j.ok) { setPipelines([]); setListErr(j.error); setListHint(j.hint); return; }
      setPipelines(j.pipelines || []);
      if ((j.pipelines || []).length && !pipelineId) setPipelineId(j.pipelines[0].id);
    } catch (e: any) { setPipelines([]); setListErr(e?.message || String(e)); }
  }, [pipelineId]);

  const loadDetail = useCallback(async (wsId: string, pId: string) => {
    setDetailErr(null);
    try {
      const r = await fetch(`/api/items/data-pipeline/${encodeURIComponent(pId)}?workspaceId=${encodeURIComponent(wsId)}`);
      const j = await r.json();
      if (!j.ok) { setDetailErr(j.error); return; }
      // The detail route returns `definition` as the raw ADF pipeline JSON
      // (with `properties.activities`). Older format had `parts: [...]`
      // (Fabric InlineBase64) which we still tolerate for back-compat.
      let nextSpec: PipelineSpec | null = null;
      const def = j.definition;
      if (def?.properties) {
        nextSpec = { name: def.name, properties: def.properties };
      } else if (def?.parts) {
        const part = def.parts.find((p: any) => /pipeline-content\.json$/.test(p.path));
        if (part?.payload) {
          const decoded = fromB64(part.payload);
          nextSpec = textToSpec(decoded);
        }
      }
      setSpec(nextSpec || STARTER);
      setDirty(false);
      setSelectedActivity(null);
    } catch (e: any) { setDetailErr(e?.message || String(e)); }
  }, []);

  const loadTriggers = useCallback(async (wsId: string, pId: string) => {
    try {
      const r = await fetch(`/api/items/data-pipeline/${encodeURIComponent(pId)}/triggers?workspaceId=${encodeURIComponent(wsId)}`);
      const j = await r.json();
      if (j.ok) setTriggers(j.triggers || []);
    } catch { /* keep last */ }
  }, []);

  // Resolve THIS item's workspace + bind to its pipeline id from the route id,
  // so a deep-linked / app-installed pipeline auto-loads its canvas instead of
  // showing an empty "Select a workspace" state with the activities stranded in
  // the bundle banner. Mirrors the notebook editor's wsId self-resolution.
  useEffect(() => {
    if (!id || id === 'new' || workspaceId) return;
    let alive = true;
    (async () => {
      try {
        const r = await fetch(`/api/cosmos-items/data-pipeline/${encodeURIComponent(id)}`);
        const j = await r.json().catch(() => ({}));
        if (alive && j?.workspaceId) { setWorkspaceId(j.workspaceId); setPipelineId(id); }
      } catch { /* fall back to manual workspace pick */ }
    })();
    return () => { alive = false; };
  }, [id, workspaceId]);

  useEffect(() => { if (workspaceId) loadList(workspaceId); }, [workspaceId, loadList]);
  useEffect(() => {
    if (workspaceId && pipelineId) {
      loadDetail(workspaceId, pipelineId);
      loadTriggers(workspaceId, pipelineId);
    }
  }, [workspaceId, pipelineId, loadDetail, loadTriggers]);

  // ============ Derived ============
  const activities = spec.properties.activities;
  const parameters = useMemo<PipelineParameter[]>(() => paramsFromSpec(spec), [spec]);
  const variables = useMemo<PipelineVariable[]>(() => varsFromSpec(spec), [spec]);
  const selected = activities.find((a) => a.name === selectedActivity) || null;

  const errorActivities = useMemo(() => {
    return activities.filter((a) => {
      const def = ACTIVITY_CATALOG.find((c) => c.type === a.type);
      return def && !def.runnable;
    });
  }, [activities]);

  // ============ Spec mutators ============
  const patchSpec = (updater: (prev: PipelineSpec) => PipelineSpec) => {
    setSpec((prev) => {
      const next = updater(prev);
      setDirty(true);
      return next;
    });
  };

  const insertActivity = useCallback((def: ActivityTypeDef) => {
    let newName = '';
    patchSpec((prev) => {
      const n = nextNameSuffix(prev.properties.activities, def.namePrefix);
      newName = `${def.namePrefix}${n}`;
      const a = def.build(newName);
      return {
        ...prev,
        properties: {
          ...prev.properties,
          activities: [...prev.properties.activities, a],
        },
      };
    });
    setTimeout(() => { if (newName) setSelectedActivity(newName); }, 0);
  }, []);

  const patchActivity = useCallback((name: string, patch: Partial<PipelineActivity>) => {
    patchSpec((prev) => ({
      ...prev,
      properties: {
        ...prev.properties,
        activities: prev.properties.activities.map((a) => a.name === name ? { ...a, ...patch } : a),
      },
    }));
    if (patch.name && patch.name !== name) setSelectedActivity(patch.name);
  }, []);

  const deleteActivity = useCallback((name: string) => {
    patchSpec((prev) => ({
      ...prev,
      properties: {
        ...prev.properties,
        activities: prev.properties.activities
          .filter((a) => a.name !== name)
          .map((a) => ({
            ...a,
            dependsOn: (a.dependsOn || []).filter((d) => d.activity !== name),
          })),
      },
    }));
    setSelectedActivity(null);
  }, []);

  // Wire a success dependency from→to (drag a node's output port to another
  // node's input port). Cycle-guarded so the DAG stays acyclic.
  const connect = useCallback((from: string, to: string) => {
    if (from === to) return;
    patchSpec((prev) => {
      const acts = prev.properties.activities;
      // ancestry walk from `from`; refuse if `to` already an ancestor
      const ancestors = new Set<string>();
      const stack = [from];
      while (stack.length) {
        const cur = stack.pop()!;
        const node = acts.find((a) => a.name === cur);
        for (const d of node?.dependsOn || []) {
          if (!ancestors.has(d.activity)) { ancestors.add(d.activity); stack.push(d.activity); }
        }
      }
      if (ancestors.has(to)) return prev;
      return {
        ...prev,
        properties: {
          ...prev.properties,
          activities: acts.map((a) => {
            if (a.name !== to) return a;
            const deps = a.dependsOn || [];
            if (deps.some((d) => d.activity === from)) return a;
            return { ...a, dependsOn: [...deps, { activity: from, dependencyConditions: ['Succeeded'] }] };
          }),
        },
      };
    });
  }, []);

  // ============ Backend actions ============
  const save = useCallback(async () => {
    if (!workspaceId || !pipelineId) return;
    setSaving(true); setDetailErr(null);
    try {
      const payload = {
        definition: {
          name: spec.name,
          properties: spec.properties,
        },
      };
      const r = await fetch(`/api/items/data-pipeline/${encodeURIComponent(pipelineId)}?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const j = await r.json();
      if (!j.ok) {
        setDetailErr(j.error || 'save failed');
        dispatchToast(<Toast><ToastTitle>Save failed: {j.error || 'unknown'}</ToastTitle></Toast>, { intent: 'error' });
      } else {
        setDirty(false);
        dispatchToast(<Toast><ToastTitle>Saved.</ToastTitle></Toast>, { intent: 'success' });
      }
    } catch (e: any) {
      setDetailErr(e?.message || String(e));
      dispatchToast(<Toast><ToastTitle>Save failed: {e?.message || e}</ToastTitle></Toast>, { intent: 'error' });
    } finally { setSaving(false); }
  }, [workspaceId, pipelineId, spec, dispatchToast]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (workspaceId && pipelineId && dirty && !saving) save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [workspaceId, pipelineId, dirty, saving, save]);

  const validate = useCallback(async () => {
    if (!workspaceId || !pipelineId) return;
    setValidating(true); setValidation(null);
    try {
      const r = await fetch(`/api/items/data-pipeline/${encodeURIComponent(pipelineId)}/validate?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ definition: { properties: spec.properties } }),
      });
      const j = await r.json();
      const okMsg = j.ok
        ? `Validation passed — ADF accepts ${j.validation?.activities?.length ?? activities.length} activities.`
        : `Validation failed: ${j.error || 'unknown'}`;
      setValidation({ ok: !!j.ok, message: okMsg });
      dispatchToast(
        <Toast><ToastTitle>{okMsg}</ToastTitle></Toast>,
        { intent: j.ok ? 'success' : 'error' },
      );
    } catch (e: any) {
      setValidation({ ok: false, message: e?.message || String(e) });
      dispatchToast(<Toast><ToastTitle>Validate failed: {e?.message || e}</ToastTitle></Toast>, { intent: 'error' });
    } finally { setValidating(false); }
  }, [workspaceId, pipelineId, spec, activities.length, dispatchToast]);

  const run = useCallback(async () => {
    if (!workspaceId || !pipelineId) return;
    setRunning(true);
    try {
      const r = await fetch(`/api/items/data-pipeline/${encodeURIComponent(pipelineId)}/run?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
      });
      const j = await r.json();
      if (!j.ok) dispatchToast(<Toast><ToastTitle>Run failed: {j.error}</ToastTitle></Toast>, { intent: 'error' });
      else {
        dispatchToast(<Toast><ToastTitle>Run queued · {j.runId?.slice(0, 8)}</ToastTitle></Toast>, { intent: 'success' });
        setTopTab('output');
      }
    } finally { setRunning(false); }
  }, [workspaceId, pipelineId, dispatchToast]);

  const debug = useCallback(async () => {
    if (!workspaceId || !pipelineId) return;
    setDebugging(true);
    try {
      const r = await fetch(`/api/items/data-pipeline/${encodeURIComponent(pipelineId)}/debug?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
      });
      const j = await r.json();
      if (!j.ok) dispatchToast(<Toast><ToastTitle>Debug failed: {j.error}</ToastTitle></Toast>, { intent: 'error' });
      else {
        dispatchToast(<Toast><ToastTitle>Debug run started · {j.runId?.slice(0, 8)}</ToastTitle></Toast>, { intent: 'success' });
        setTopTab('output');
      }
    } finally { setDebugging(false); }
  }, [workspaceId, pipelineId, dispatchToast]);

  const create = useCallback(async () => {
    if (!workspaceId || !createName.trim()) return;
    setCreateBusy(true); setCreateErr(null);
    try {
      const definition = {
        parts: [{
          path: 'pipeline-content.json',
          payload: toB64(specToText(STARTER)),
          payloadType: 'InlineBase64' as const,
        }],
      };
      const r = await fetch(`/api/items/data-pipeline?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ displayName: createName.trim(), definition }),
      });
      const j = await r.json();
      if (!j.ok) { setCreateErr(j.error || 'create failed'); return; }
      setCreateOpen(false); setCreateName('');
      await loadList(workspaceId);
      if (j.pipeline?.id) setPipelineId(j.pipeline.id);
    } finally { setCreateBusy(false); }
  }, [workspaceId, createName, loadList]);

  const del = useCallback(async () => {
    if (!workspaceId || !pipelineId) return;
    if (!confirm('Delete this pipeline? This cannot be undone.')) return;
    await fetch(`/api/items/data-pipeline/${encodeURIComponent(pipelineId)}?workspaceId=${encodeURIComponent(workspaceId)}`, { method: 'DELETE' });
    setPipelineId('');
    await loadList(workspaceId);
  }, [workspaceId, pipelineId, loadList]);

  const discard = useCallback(() => {
    if (!workspaceId || !pipelineId) return;
    if (dirty && !confirm('Discard unsaved changes?')) return;
    loadDetail(workspaceId, pipelineId);
  }, [workspaceId, pipelineId, dirty, loadDetail]);

  const createTrigger = useCallback(async () => {
    if (!workspaceId || !pipelineId || !triggerName.trim()) return;
    setTriggerBusy(true); setTriggerErr(null);
    try {
      const r = await fetch(`/api/items/data-pipeline/${encodeURIComponent(pipelineId)}/triggers?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: triggerName.trim(),
          properties: {
            type: 'ScheduleTrigger',
            runtimeState: 'Stopped',
            typeProperties: {
              recurrence: {
                frequency: 'Day',
                interval: 1,
                startTime: new Date().toISOString(),
                timeZone: 'UTC',
              },
            },
          },
        }),
      });
      const j = await r.json();
      if (!j.ok) { setTriggerErr(j.error || 'create failed'); return; }
      setScheduleOpen(false); setTriggerName('');
      await loadTriggers(workspaceId, pipelineId);
      dispatchToast(<Toast><ToastTitle>Trigger created — start it from the list below.</ToastTitle></Toast>, { intent: 'success' });
    } finally { setTriggerBusy(false); }
  }, [workspaceId, pipelineId, triggerName, triggerCron, loadTriggers, dispatchToast]);

  const startStopTrigger = useCallback(async (name: string, action: 'start' | 'stop') => {
    if (!workspaceId || !pipelineId) return;
    const r = await fetch(`/api/items/data-pipeline/${encodeURIComponent(pipelineId)}/triggers?workspaceId=${encodeURIComponent(workspaceId)}&triggerName=${encodeURIComponent(name)}&action=${action}`, {
      method: 'PUT',
    });
    const j = await r.json();
    if (!j.ok) dispatchToast(<Toast><ToastTitle>{action} failed: {j.error}</ToastTitle></Toast>, { intent: 'error' });
    else {
      dispatchToast(<Toast><ToastTitle>Trigger {action}ed.</ToastTitle></Toast>, { intent: 'success' });
      await loadTriggers(workspaceId, pipelineId);
    }
  }, [workspaceId, pipelineId, loadTriggers, dispatchToast]);

  // ============ Ribbon ============
  const canRun = !running && !!pipelineId;
  const canDebug = !debugging && !!pipelineId;
  const canSave = !saving && !!pipelineId && dirty;
  const canValidate = !validating && !!pipelineId;
  const canDelete = !!pipelineId;
  const canCreate = !!workspaceId;
  const canDiscard = !!pipelineId;

  const ribbon: RibbonTab[] = useMemo(() => [
    {
      id: 'home', label: 'Home', groups: [
        { label: 'Item', actions: [
          { label: 'New pipeline', icon: <Add20Regular />, onClick: canCreate ? () => setCreateOpen(true) : undefined, disabled: !canCreate },
          { label: saving ? 'Saving…' : 'Save', icon: <Save20Regular />, onClick: canSave ? save : undefined, disabled: !canSave },
          { label: 'Refresh', icon: <ArrowSync20Regular />, onClick: workspaceId ? () => loadList(workspaceId) : undefined, disabled: !workspaceId },
          { label: 'Discard', onClick: canDiscard ? discard : undefined, disabled: !canDiscard || !dirty },
        ]},
        { label: 'Validate', actions: [
          { label: validating ? 'Validating…' : 'Validate', icon: <Checkmark20Regular />, onClick: canValidate ? validate : undefined, disabled: !canValidate },
        ]},
        { label: 'Manage', actions: [
          { label: 'Manage', icon: <Settings20Regular />, onClick: () => setManageOpen(true), title: 'Linked services and datasets' },
        ]},
        { label: 'Run', actions: [
          { label: running ? 'Queuing…' : 'Run', icon: <Play20Regular />, onClick: canRun ? run : undefined, disabled: !canRun },
          { label: debugging ? 'Debugging…' : 'Debug', icon: <Bug20Regular />, onClick: canDebug ? debug : undefined, disabled: !canDebug },
        ]},
        { label: 'Schedule', actions: [
          { label: 'Schedule', icon: <Clock20Regular />, onClick: pipelineId ? () => setScheduleOpen(true) : undefined, disabled: !pipelineId },
          { label: 'Add trigger', onClick: pipelineId ? () => setScheduleOpen(true) : undefined, disabled: !pipelineId },
        ]},
        { label: 'Delete', actions: [
          { label: 'Delete', icon: <Delete20Regular />, onClick: canDelete ? del : undefined, disabled: !canDelete },
        ]},
      ],
    },
    {
      id: 'view', label: 'View', groups: [
        { label: 'Grid', actions: [
          { label: showGrid ? 'Hide grid' : 'Show grid', onClick: () => setShowGrid((v) => !v) },
          { label: snapToGrid ? 'Snap: on' : 'Snap: off', onClick: () => setSnapToGrid((v) => !v) },
        ]},
        { label: 'Zoom', actions: [
          { label: 'Fit to screen', onClick: () => canvasRef.current?.fitToScreen() },
          { label: 'Reset zoom', onClick: () => canvasRef.current?.resetZoom() },
        ]},
      ],
    },
    {
      id: 'output', label: 'Output', groups: [
        { label: 'Output', actions: [
          { label: outputPinned ? 'Unpin' : 'Pin output', onClick: () => setOutputPinned((v) => !v) },
          { label: 'Open Output tab', onClick: pipelineId ? () => setTopTab('output') : undefined, disabled: !pipelineId },
        ]},
      ],
    },
  ], [
    canCreate, saving, canSave, save, workspaceId, loadList, canDiscard, dirty, discard,
    validating, canValidate, validate, running, canRun, run, debugging, canDebug, debug,
    pipelineId, canDelete, del, showGrid, snapToGrid, outputPinned,
  ]);

  // ============ Render ============
  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon}
      leftPanel={
        <div className={s.treePad}>
          <Subtitle2 style={{ marginBottom: 8 }}>Pipelines</Subtitle2>
          {!workspaceId && <Caption1>Select a workspace.</Caption1>}
          {workspaceId && pipelines === null && <Spinner size="tiny" label="Loading…" />}
          {pipelines && pipelines.length === 0 && !listErr && <Caption1>No pipelines.</Caption1>}
          <Tree aria-label="Pipelines">
            {(pipelines || []).map((p) => (
              <TreeItem key={p.id} itemType="leaf" value={p.id} onClick={() => setPipelineId(p.id)}>
                <TreeItemLayout iconBefore={<Flow20Regular />}>
                  {pipelineId === p.id ? <strong>{p.displayName}</strong> : p.displayName}
                </TreeItemLayout>
              </TreeItem>
            ))}
          </Tree>
        </div>
      }
      main={
        <div className={s.shell}>
          <Toaster toasterId={toastId} />
          <div className={s.topbar}>
            <Badge appearance="filled" color="brand">Fabric Data Pipeline</Badge>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 280 }}>
              <Caption1>Workspace</Caption1>
              <Select value={workspaceId} onChange={(_, d) => setWorkspaceId(d.value)} disabled={ws.loading || (ws.workspaces?.length ?? 0) === 0}>
                {!workspaceId && <option value="">{ws.loading ? 'Loading workspaces…' : 'Select a workspace'}</option>}
                {(ws.workspaces || []).map((w) => (
                  <option key={w.id} value={w.id}>{w.name}{w.isOnDedicatedCapacity ? ' · F/P SKU' : ''}</option>
                ))}
              </Select>
            </div>
            {dirty && <Badge appearance="outline" color="warning">unsaved</Badge>}
            {validation && (
              <Badge appearance="filled" color={validation.ok ? 'success' : 'danger'}>
                {validation.ok ? 'Validated' : 'Invalid'}
              </Badge>
            )}
            {errorActivities.length > 0 && (
              <Badge appearance="outline" color="warning" title={`${errorActivities.length} activity(s) will not run on ADF backing`}>
                {errorActivities.length} save-only
              </Badge>
            )}
          </div>

          {(ws.error || listErr) && (
            <MessageBar intent="error">
              <MessageBarBody>
                <MessageBarTitle>Fabric not reachable</MessageBarTitle>
                {ws.error || listErr}
                {(ws.hint || listHint) && <><br /><Caption1>{ws.hint || listHint}</Caption1></>}
              </MessageBarBody>
            </MessageBar>
          )}
          {detailErr && <MessageBar intent="error"><MessageBarBody>{detailErr}</MessageBarBody></MessageBar>}

          {!pipelineId && (
            <MessageBar intent="info">
              <MessageBarBody>
                Design your pipeline below — drag activities from the palette onto the canvas and wire them
                up. To <strong>Save / Validate / Run</strong> against the live Fabric backing, pick a workspace
                and pipeline from the left rail (or click <strong>New pipeline</strong> in the ribbon).
              </MessageBarBody>
            </MessageBar>
          )}

          {/* Visual designer always renders so the canvas + palette are
              available even before a backend pipeline is selected. Only the
              ribbon's Save/Validate/Run wire to the live Fabric backing. */}
          {(
            <TopTabs active={topTab} onChange={setTopTab}
              counts={{
                parameters: parameters.length,
                variables: variables.length,
                pipeline: activities.length,
              }}>
              {topTab === 'pipeline' && (
                <div className={s.designerRow}>
                  <div className={s.paletteCol}>
                    <ActivityPalette onInsert={(d) => insertActivity(d)} />
                  </div>
                  <div className={s.designerMain}>
                    {/* Canvas FILLS the space above the dock — fixed relative to
                        the dock height, never resized by config expand/collapse. */}
                    <div className={s.canvasWrap}>
                      <PipelineCanvas
                        ref={canvasRef}
                        activities={activities}
                        selectedName={selectedActivity || undefined}
                        onSelect={setSelectedActivity}
                        snapToGrid={snapToGrid}
                        showGrid={showGrid}
                        onDropPaletteKey={(key) => {
                          const def = findByKey(key);
                          if (def) insertActivity(def);
                        }}
                        onConnect={connect}
                      />
                    </div>
                    {/* Draggable divider — drag up/down to resize the config dock. */}
                    <div
                      className={mergeClasses(s.splitter, resizing && s.splitterActive)}
                      onMouseDown={startResize}
                      role="separator"
                      aria-orientation="horizontal"
                      aria-label="Resize activity configuration panel"
                      title="Drag to resize the configuration panel"
                    >
                      <div className={s.splitterGrip} />
                    </div>
                    {/* Bottom-docked activity configuration — explicit height + own scroll. */}
                    <div className={s.configDock} style={{ height: configHeight }}>
                      <PropertiesPanel
                        activity={selected}
                        allActivities={activities}
                        parameters={parameters}
                        variables={variables}
                        layout="dock"
                        onPatch={(patch) => { if (selected) patchActivity(selected.name, patch); }}
                        onDelete={() => { if (selected) deleteActivity(selected.name); }}
                      />
                    </div>
                  </div>
                </div>
              )}

              {topTab === 'parameters' && (
                <div className={s.tabBody}>
                  <Subtitle2>Pipeline parameters</Subtitle2>
                  <Caption1>Typed inputs passed in at run time. Reference with <code>@pipeline().parameters.&lt;name&gt;</code>.</Caption1>
                  <Table size="small">
                    <TableHeader>
                      <TableRow>
                        <TableHeaderCell>Name</TableHeaderCell>
                        <TableHeaderCell>Type</TableHeaderCell>
                        <TableHeaderCell>Default value</TableHeaderCell>
                        <TableHeaderCell></TableHeaderCell>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {parameters.length === 0 && (
                        <TableRow><TableCell colSpan={4}><Caption1>No parameters yet.</Caption1></TableCell></TableRow>
                      )}
                      {parameters.map((p) => (
                        <TableRow key={p.name}>
                          <TableCell>
                            <Input size="small" value={p.name}
                              onChange={(_, d) => patchSpec((prev) => {
                                const next = parameters.map((x) => x.name === p.name ? { ...x, name: d.value } : x);
                                return { ...prev, properties: { ...prev.properties, parameters: paramsToSpec(next) } };
                              })} />
                          </TableCell>
                          <TableCell>
                            <Select size="small" value={p.type}
                              onChange={(_, d) => patchSpec((prev) => {
                                const next = parameters.map((x) => x.name === p.name ? { ...x, type: d.value as PipelineParameterType } : x);
                                return { ...prev, properties: { ...prev.properties, parameters: paramsToSpec(next) } };
                              })}>
                              <option value="string">string</option>
                              <option value="int">int</option>
                              <option value="float">float</option>
                              <option value="bool">bool</option>
                              <option value="array">array</option>
                              <option value="object">object</option>
                              <option value="secureString">secureString</option>
                            </Select>
                          </TableCell>
                          <TableCell>
                            <Input size="small" value={String(p.defaultValue ?? '')}
                              onChange={(_, d) => patchSpec((prev) => {
                                const next = parameters.map((x) => x.name === p.name ? { ...x, defaultValue: d.value } : x);
                                return { ...prev, properties: { ...prev.properties, parameters: paramsToSpec(next) } };
                              })} />
                          </TableCell>
                          <TableCell>
                            <Button size="small" appearance="subtle" icon={<Delete20Regular />}
                              onClick={() => patchSpec((prev) => {
                                const next = parameters.filter((x) => x.name !== p.name);
                                return { ...prev, properties: { ...prev.properties, parameters: paramsToSpec(next) } };
                              })} />
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                  <Button size="small" icon={<Add20Regular />}
                    onClick={() => patchSpec((prev) => {
                      const n = parameters.length + 1;
                      const next: PipelineParameter[] = [...parameters, { name: `param${n}`, type: 'string', defaultValue: '' }];
                      return { ...prev, properties: { ...prev.properties, parameters: paramsToSpec(next) } };
                    })}>Add parameter</Button>
                </div>
              )}

              {topTab === 'variables' && (
                <div className={s.tabBody}>
                  <Subtitle2>Pipeline variables</Subtitle2>
                  <Caption1>Scoped variables you can SetVariable / AppendVariable from activities.</Caption1>
                  <Table size="small">
                    <TableHeader>
                      <TableRow>
                        <TableHeaderCell>Name</TableHeaderCell>
                        <TableHeaderCell>Type</TableHeaderCell>
                        <TableHeaderCell>Default value</TableHeaderCell>
                        <TableHeaderCell></TableHeaderCell>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {variables.length === 0 && (
                        <TableRow><TableCell colSpan={4}><Caption1>No variables yet.</Caption1></TableCell></TableRow>
                      )}
                      {variables.map((v) => (
                        <TableRow key={v.name}>
                          <TableCell>
                            <Input size="small" value={v.name}
                              onChange={(_, d) => patchSpec((prev) => {
                                const next = variables.map((x) => x.name === v.name ? { ...x, name: d.value } : x);
                                return { ...prev, properties: { ...prev.properties, variables: varsToSpec(next) } };
                              })} />
                          </TableCell>
                          <TableCell>
                            <Select size="small" value={v.type}
                              onChange={(_, d) => patchSpec((prev) => {
                                const next = variables.map((x) => x.name === v.name ? { ...x, type: d.value as PipelineVariable['type'] } : x);
                                return { ...prev, properties: { ...prev.properties, variables: varsToSpec(next) } };
                              })}>
                              <option value="String">String</option>
                              <option value="Boolean">Boolean</option>
                              <option value="Array">Array</option>
                            </Select>
                          </TableCell>
                          <TableCell>
                            <Input size="small" value={String(v.defaultValue ?? '')}
                              onChange={(_, d) => patchSpec((prev) => {
                                const next = variables.map((x) => x.name === v.name ? { ...x, defaultValue: d.value } : x);
                                return { ...prev, properties: { ...prev.properties, variables: varsToSpec(next) } };
                              })} />
                          </TableCell>
                          <TableCell>
                            <Button size="small" appearance="subtle" icon={<Delete20Regular />}
                              onClick={() => patchSpec((prev) => {
                                const next = variables.filter((x) => x.name !== v.name);
                                return { ...prev, properties: { ...prev.properties, variables: varsToSpec(next) } };
                              })} />
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                  <Button size="small" icon={<Add20Regular />}
                    onClick={() => patchSpec((prev) => {
                      const n = variables.length + 1;
                      const next: PipelineVariable[] = [...variables, { name: `var${n}`, type: 'String', defaultValue: '' }];
                      return { ...prev, properties: { ...prev.properties, variables: varsToSpec(next) } };
                    })}>Add variable</Button>
                </div>
              )}

              {topTab === 'settings' && (
                <div className={s.tabBody}>
                  <Subtitle2>Pipeline settings</Subtitle2>
                  <Field label="Description">
                    <Textarea value={spec.properties.description || ''} rows={3}
                      onChange={(_, d) => patchSpec((prev) => ({
                        ...prev, properties: { ...prev.properties, description: d.value },
                      }))} />
                  </Field>
                  <Field label="Concurrency (max parallel runs)">
                    <Input type="number" value={String(spec.properties.concurrency ?? 1)}
                      onChange={(_, d) => patchSpec((prev) => ({
                        ...prev, properties: { ...prev.properties, concurrency: parseInt(d.value, 10) || 1 },
                      }))} />
                  </Field>
                  <Field label="Annotations (comma-separated)">
                    <Input value={(spec.properties.annotations || []).join(', ')}
                      onChange={(_, d) => patchSpec((prev) => ({
                        ...prev, properties: { ...prev.properties, annotations: d.value.split(',').map((x) => x.trim()).filter(Boolean) },
                      }))} />
                  </Field>

                  <Subtitle2 style={{ marginTop: 16 }}>Active triggers ({triggers.length})</Subtitle2>
                  {triggers.length === 0 && <Caption1>No triggers wired to this pipeline yet.</Caption1>}
                  <Table size="small">
                    <TableBody>
                      {triggers.map((t) => (
                        <TableRow key={t.name}>
                          <TableCell><code>{t.name}</code></TableCell>
                          <TableCell>{t.type}</TableCell>
                          <TableCell>
                            <Badge size="small" color={t.runtimeState === 'Started' ? 'success' : 'subtle'}>
                              {t.runtimeState || '—'}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            {t.runtimeState === 'Started'
                              ? <Button size="small" onClick={() => startStopTrigger(t.name, 'stop')}>Stop</Button>
                              : <Button size="small" appearance="primary" onClick={() => startStopTrigger(t.name, 'start')}>Start</Button>}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>

                  <Subtitle2 style={{ marginTop: 16 }}>Raw spec</Subtitle2>
                  <Caption1>Edit pipeline JSON directly. Saved on Save.</Caption1>
                  <MonacoTextarea
                    value={specToText(spec)}
                    onChange={(v) => {
                      const next = textToSpec(v);
                      if (next) setSpec(next);
                      setDirty(true);
                    }}
                    language="json"
                    height={260}
                    minHeight={200}
                    ariaLabel="Pipeline JSON"
                  />
                </div>
              )}

              {topTab === 'output' && (
                <OutputPane workspaceId={workspaceId} pipelineId={pipelineId} />
              )}
            </TopTabs>
          )}

          {/* Manage hub — linked services / datasets (Synapse-backed) */}
          <ManagePanel open={manageOpen} backend="synapse" onOpenChange={setManageOpen} />

          {/* Create dialog */}
          <Dialog open={createOpen} onOpenChange={(_, d) => setCreateOpen(d.open)}>
            <DialogSurface>
              <DialogBody>
                <DialogTitle>Create Fabric data pipeline</DialogTitle>
                <DialogContent>
                  <Input placeholder="displayName" value={createName} onChange={(_, d) => setCreateName(d.value)} style={{ width: '100%' }} />
                  {createErr && <MessageBar intent="error" style={{ marginTop: 8 }}><MessageBarBody>{createErr}</MessageBarBody></MessageBar>}
                </DialogContent>
                <DialogActions>
                  <Button appearance="secondary" onClick={() => setCreateOpen(false)}>Cancel</Button>
                  <Button appearance="primary" disabled={createBusy || !createName.trim()} onClick={create}>{createBusy ? 'Creating…' : 'Create'}</Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>

          {/* Schedule dialog */}
          <Dialog open={scheduleOpen} onOpenChange={(_, d) => setScheduleOpen(d.open)}>
            <DialogSurface>
              <DialogBody>
                <DialogTitle>Add schedule trigger</DialogTitle>
                <DialogContent>
                  <Field label="Trigger name" required>
                    <Input value={triggerName} onChange={(_, d) => setTriggerName(d.value)} />
                  </Field>
                  <Field label="Recurrence cron (UTC)">
                    <Input value={triggerCron} onChange={(_, d) => setTriggerCron(d.value)} />
                  </Field>
                  <Caption1>Creates a Daily ScheduleTrigger in Stopped state. Hit Start to activate it.</Caption1>
                  {triggerErr && <MessageBar intent="error" style={{ marginTop: 8 }}><MessageBarBody>{triggerErr}</MessageBarBody></MessageBar>}
                </DialogContent>
                <DialogActions>
                  <Button appearance="secondary" onClick={() => setScheduleOpen(false)}>Cancel</Button>
                  <Button appearance="primary" disabled={triggerBusy || !triggerName.trim()} onClick={createTrigger}>
                    {triggerBusy ? 'Creating…' : 'Create trigger'}
                  </Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>
        </div>
      }
    />
  );
}
