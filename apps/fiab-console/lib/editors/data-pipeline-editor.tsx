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

import {
  useCallback, useEffect, useMemo, useRef, useState,
  type ReactNode, type PointerEvent as ReactPointerEvent, type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import {
  Subtitle2, Caption1, Badge, Button, Spinner, Input,
  Tree, TreeItem, TreeItemLayout, Select, Field, Textarea,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  RadioGroup, Radio,
  makeStyles, mergeClasses, tokens,
  Toast, ToastTitle, useToastController, Toaster, useId,
} from '@fluentui/react-components';
import { ResizableCanvasRegion } from '@/lib/components/canvas/resizable-canvas';
import {
  Play20Regular, Add20Regular, Save20Regular, ArrowSync20Regular, Delete20Regular, Flow20Regular,
  Checkmark20Regular, Bug20Regular, Clock20Regular, Settings20Regular, CloudArrowUp20Regular,
  ArrowDownload20Regular, ArrowUpload20Regular, AppsList20Regular,
  PlugConnected20Regular, Database20Regular,
  Flow24Regular, NumberSymbol20Regular, Tag20Regular, Code20Regular, CalendarClock20Regular,
} from '@fluentui/react-icons';
import { ItemEditorChrome } from './item-editor-chrome';
import { TileGrid } from '@/lib/components/ui/tile-grid';
import { ManagePanel } from '@/lib/components/pipeline/manage-panel';
import { PipelineManageHub } from '@/lib/components/pipeline/pipeline-manage-hub';
import { ActivityPalette } from '@/lib/components/pipeline/palette';
import { PipelineCanvas, type CanvasHandle } from '@/lib/components/pipeline/canvas';
import { PropertiesPanel } from '@/lib/components/pipeline/properties-panel';
import { TopTabs, type TopTabId } from '@/lib/components/pipeline/top-tabs';
import { TriggerWizard } from '@/lib/components/pipeline/trigger-wizard';
import type { ParamBinding } from '@/lib/components/pipeline/param-source-picker';
import { OutputPane } from '@/lib/components/pipeline/output-pane';
import { TemplateGalleryFlyout } from '@/lib/components/pipeline/templates/gallery';
import { PIPELINE_TEMPLATES, type PipelineTemplate } from '@/lib/components/pipeline/templates/catalog';
import {
  ACTIVITY_CATALOG, findByKey, nextNameSuffix, type ActivityTypeDef,
} from '@/lib/components/pipeline/activity-catalog';
import {
  type PipelineActivity, type PipelineSpec, type PipelineParameter, type PipelineVariable,
  type PipelineParameterType, type PipelineRuntime, DEFAULT_PIPELINE_RUNTIME,
  textToSpec, specToText, paramsFromSpec, paramsToSpec, varsFromSpec, varsToSpec,
} from '@/lib/components/pipeline/types';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';
import { MonacoTextarea } from '@/lib/components/editor/monaco-textarea';
// Azure-native runtime delegates (Contract B): when this unified editor is the
// one mounted for a slug — `data-pipeline`, or `adf-pipeline` (the ONLY slug
// that carries `aliasOf:'data-pipeline'` in the catalog, so the item page resolves
// it to THIS editor with runtimePreset 'adf') — its 'adf'/'synapse' runtime paths
// delegate to the SAME purpose-built editors so bind/run/save/validate/debug/
// runs/triggers reuse the EXISTING `/api/items/{adf-pipeline|synapse-pipeline}/{id}/*`
// routes (no new routes, no duplicated binding logic).
//
// IMPORTANT — `synapse-pipeline` is NOT an alias of `data-pipeline`. Its catalog
// entry has `runtimePreset:'synapse'` but no `aliasOf`, so the item page opens
// `SynapsePipelineEditor` DIRECTLY; that editor's `{item,id}` signature does not
// accept (and so ignores) runtimePreset. Back-compat for existing
// adf-pipeline / synapse-pipeline / geo-pipeline instances still holds because
// `SynapsePipelineEditor` is PipelineEditorCore-backed — the same core this file
// delegates to. 'fabric' keeps this file's existing body.
import { AdfPipelineEditor, SynapsePipelineEditor } from './azure-services-editors';
// A12 — dock the Pipeline Copilot in the flagship editor's right rail (same pane
// the alias editors mount via pipeline-editor-core.tsx:755). It POSTs the real
// SSE orchestrator at /api/items/data-pipeline/{id}/copilot (Azure-native ADF
// backend per no-fabric-dependency.md) and applies the generated spec to THIS
// file's canvas via onApplySpec.
import { PipelineCopilotPane } from './pipeline-editor';
import { useSharedEditorStyles } from './shared-styles';

const useLocalStyles = makeStyles({
  shell: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, padding: tokens.spacingHorizontalM, flex: 1, minHeight: 0,
  },
  topbar: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap' },
  threePane: { display: 'flex', flex: 1, minHeight: '480px', gap: tokens.spacingHorizontalS },
  paletteCol: {
    flexShrink: 0,
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusSmall,
    overflow: 'hidden',
    display: 'flex',
  },
  centerCol: { flex: 1, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, minWidth: 0 },
  tabBody: { padding: tokens.spacingHorizontalM, overflow: 'auto', flex: 1, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },

  // ── ADF-Studio designer layout: palette | (canvas over a resizable config dock) ──
  // The canvas FILLS the space above the dock; the dock has an explicit,
  // user-dragged height with its own internal scroll, so expanding/collapsing
  // sections inside the activity config NEVER resizes the canvas.
  designerRow: { display: 'flex', flex: 1, minHeight: '560px', gap: tokens.spacingHorizontalS, minWidth: 0 },
  designerMain: { flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 },
  canvasWrap: { flex: 1, minHeight: '180px', display: 'flex', overflow: 'hidden' },
  splitter: {
    flexShrink: 0,
    height: '10px',  // inherent: drag-grip bar thickness — no spacing token is this thin
    cursor: 'row-resize',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    touchAction: 'none',
    ':hover': { backgroundColor: tokens.colorNeutralBackground3 },
    // Keyboard-focus affordance — the handle is focusable (tabIndex=0) and
    // Arrow/Page/Home/End resizable, matching the canvas handle above it.
    ':focus-visible': {
      outline: `2px solid ${tokens.colorStrokeFocus2}`,
      outlineOffset: '-2px',
    },
  },
  splitterActive: { backgroundColor: tokens.colorBrandBackground2 },
  splitterGrip: {
    width: '44px',   // inherent: grip-pill width (decorative drag affordance — no token expresses it)
    height: '4px',   // inherent: grip-pill thickness
    borderRadius: tokens.borderRadiusCircular,
    backgroundColor: tokens.colorNeutralStroke1,
    pointerEvents: 'none',  // pointer events belong to the separator, not the grip
  },
  configDock: {
    flexShrink: 0,
    overflow: 'auto',
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusSmall,
    minHeight: '240px',  // inherent: matches DOCK_MIN_PX floor
    // Smooth keyboard-driven height changes; during a pointer drag the
    // transition is suppressed inline (onPointerDown) so dragging stays direct.
    transitionProperty: 'height',
    transitionDuration: tokens.durationFast,
    transitionTimingFunction: tokens.curveEasyEase,
    '@media (prefers-reduced-motion: reduce)': { transitionProperty: 'none' },
  },

  // ── Web-5.0 polish: elevated, interactive start-cards (blank / practice /
  //    templates). Flat→shadow4, hover→shadow16, brand-accented hairline. ──
  startCard: {
    cursor: 'pointer',
    padding: tokens.spacingHorizontalXL,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    minWidth: 0,
    overflowWrap: 'anywhere',
    transitionProperty: 'box-shadow, border-color, transform',
    transitionDuration: tokens.durationNormal,
    transitionTimingFunction: tokens.curveEasyEase,
    ':hover': {
      boxShadow: tokens.shadow16,
      borderTopColor: tokens.colorBrandStroke1,
      borderRightColor: tokens.colorBrandStroke1,
      borderBottomColor: tokens.colorBrandStroke1,
      borderLeftColor: tokens.colorBrandStroke1,
    },
  },
  startCardDisabled: {
    cursor: 'not-allowed',
    opacity: 0.6,
    ':hover': {
      boxShadow: tokens.shadow4,
      borderTopColor: tokens.colorNeutralStroke2,
      borderRightColor: tokens.colorNeutralStroke2,
      borderBottomColor: tokens.colorNeutralStroke2,
      borderLeftColor: tokens.colorNeutralStroke2,
    },
  },
  cardIcon: { color: tokens.colorBrandForeground1, fontSize: '24px' },
  sectionHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS },
});

function useStyles() {
  const shared = useSharedEditorStyles();
  const local = useLocalStyles();
  return useMemo(() => ({ ...shared, ...local }), [shared, local]);
}

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

// ── Activity-config dock divider — inherent layout dimensions ───────────────
// Raw px below are layout bounds / drag-steps that no Fluent token expresses
// (mirrors resizable-canvas.tsx). They are the documented carve-out from the
// web3-ui token-discipline rule (resize min/max bounds + step sizes). The
// ceiling is NOT a fixed px: it tracks 80vh of the viewport (recomputed on
// resize, exactly like the shared primitive); the const below is only the
// SSR-safe placeholder used until the first client measurement.
const DOCK_MIN_PX = 240;          // floor — below this the config form is unusable
const DOCK_MAX_FALLBACK = 680;    // SSR-safe ceiling placeholder; corrected to 80vh on mount
const DOCK_DEFAULT_PX = 300;      // initial dock height
const DOCK_STEP = 24;             // Arrow-key resize step (px)
const DOCK_STEP_LARGE = 96;       // Shift+Arrow / PageUp-Down resize step (px)
// Per-surface persistence (matches the canvas region's storageKey).
const DOCK_STORAGE_KEY = 'loom.dockHeight.adf-data-pipeline';

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(Math.round(value), min), Math.max(min, max));
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

interface Props {
  item: FabricItemType;
  id: string;
  /**
   * Lock the runtime selector to this backend (Contract D). Set by the item
   * page when the opened slug is an alias/preset (e.g. `adf-pipeline` →
   * runtimePreset 'adf', `synapse-pipeline` → 'synapse'). When undefined the
   * selector defaults to the Azure-native ADF runtime and stays user-changeable.
   */
  runtimePreset?: PipelineRuntime;
  /**
   * Instantiate this template's spec onto the canvas on mount when creating a
   * NEW pipeline (Contract F — e.g. the geo-pipeline alias passes 'geo-enrich').
   */
  templateId?: string;
}

export function DataPipelineEditor({ item, id, runtimePreset, templateId }: Props) {
  const s = useStyles();
  const ws = useWorkspaces();

  // ── Runtime selector (Contract A/B) — the ONE unified pipeline authoring
  //    experience. 'adf' (Azure-native ADF, standalone factory) is the DEFAULT
  //    per no-fabric-dependency.md. 'synapse' is the Azure-native Synapse path.
  //    'fabric' is STRICTLY opt-in: selectable only when a Fabric workspace is
  //    bound, never auto-selected, never a gate. When a runtimePreset prop is
  //    set, the selector is locked. In practice the only slug that reaches THIS
  //    editor with a preset is `adf-pipeline` (aliasOf:'data-pipeline' → preset
  //    'adf'); `synapse-pipeline` has no aliasOf and opens SynapsePipelineEditor
  //    directly, so its preset never flows in here. geo-pipeline (templateOf →
  //    'adf' preset + templateId) also reaches this editor and locks to ADF.
  const [runtime, setRuntime] = useState<PipelineRuntime>(runtimePreset ?? DEFAULT_PIPELINE_RUNTIME);
  useEffect(() => { if (runtimePreset) setRuntime(runtimePreset); }, [runtimePreset]);
  const runtimeLocked = !!runtimePreset;
  // The Fabric path reuses the existing /api/loom/workspaces picker below; the
  // 'fabric' option is enabled only once at least one Fabric workspace is
  // reachable (i.e. a workspace IS bound). We never auto-select it.
  const fabricAvailable = (ws.workspaces?.length ?? 0) > 0;
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
  //
  // The divider matches the canvas handle's accessible Pointer-Events standard
  // (see ResizableCanvasRegion): pointer-capture drag that works for mouse /
  // touch / pen and survives the pointer leaving the handle; rAF-coalesced,
  // DOM-direct height writes during drag (no per-frame React re-render →
  // smooth, no layout thrash); keyboard resize (Arrow ±24 / Shift+Arrow /
  // PageUp-Down ±96 / Home=min / End=max); full ARIA; and a height persisted
  // per-surface in localStorage. Dragging UP grows the dock.
  const configDockRef = useRef<HTMLDivElement | null>(null);
  const [configHeight, setConfigHeight] = useState(DOCK_DEFAULT_PX);
  const [resizing, setResizing] = useState(false);
  // Ceiling tracks 80vh of the viewport (recomputed on resize); the fallback
  // keeps SSR and the first client render identical (no hydration mismatch).
  const [dockMax, setDockMax] = useState(DOCK_MAX_FALLBACK);
  const configHeightRef = useRef(configHeight);
  configHeightRef.current = configHeight;
  // Render-synced mirror so pointer/keyboard handlers read the live ceiling
  // without being torn down and rebuilt on every resize.
  const dockMaxRef = useRef(dockMax);
  dockMaxRef.current = dockMax;
  const dockDragRef = useRef(false);
  const dockStartYRef = useRef(0);
  const dockStartHRef = useRef(0);
  const dockPendingYRef = useRef(0);
  const dockRafRef = useRef<number | null>(null);

  // Commit a dock height: clamp into bounds → state → localStorage.
  const commitDockHeight = useCallback((next: number) => {
    const clamped = clamp(next, DOCK_MIN_PX, dockMaxRef.current);
    setConfigHeight(clamped);
    try { window.localStorage.setItem(DOCK_STORAGE_KEY, String(clamped)); }
    catch { /* storage unavailable (private mode / quota) — height still applies */ }
  }, []);

  // Track the 80vh ceiling — recomputed on viewport resize (mirrors the shared
  // canvas primitive). SSR keeps the fallback; the client corrects on mount.
  useEffect(() => {
    const recompute = () => setDockMax(Math.round(window.innerHeight * 0.8));
    recompute();
    window.addEventListener('resize', recompute);
    return () => window.removeEventListener('resize', recompute);
  }, []);

  // Apply the persisted dock height once, after mount. Init stays at the
  // default so SSR and first client render match (avoids a hydration mismatch).
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(DOCK_STORAGE_KEY);
      if (raw != null) {
        const parsed = parseInt(raw, 10);
        if (Number.isFinite(parsed)) setConfigHeight(clamp(parsed, DOCK_MIN_PX, dockMaxRef.current));
      }
    } catch { /* ignore */ }
  }, []);

  // Re-clamp the current height whenever the ceiling changes (e.g. viewport shrank).
  useEffect(() => { setConfigHeight((h) => clamp(h, DOCK_MIN_PX, dockMax)); }, [dockMax]);

  const startResize = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* pointer capture best-effort */ }
    dockStartYRef.current = e.clientY;
    dockStartHRef.current = configDockRef.current?.offsetHeight ?? configHeightRef.current;
    dockDragRef.current = true;
    setResizing(true);
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
    // Suppress the keyboard transition so direct DOM writes never lag the drag.
    if (configDockRef.current) configDockRef.current.style.transition = 'none';
  }, []);

  const onDockPointerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dockDragRef.current) return;
    dockPendingYRef.current = e.clientY;
    if (dockRafRef.current != null) return;
    dockRafRef.current = requestAnimationFrame(() => {
      dockRafRef.current = null;
      // Dragging UP (clientY decreases) grows the bottom dock.
      const dy = dockPendingYRef.current - dockStartYRef.current;
      const next = clamp(dockStartHRef.current - dy, DOCK_MIN_PX, dockMaxRef.current);
      // Write height DIRECTLY — no setState during drag → smooth, no thrash.
      if (configDockRef.current) configDockRef.current.style.height = `${next}px`;
    });
  }, []);

  const endDockResize = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dockDragRef.current) return;
    dockDragRef.current = false;
    if (dockRafRef.current != null) { cancelAnimationFrame(dockRafRef.current); dockRafRef.current = null; }
    setResizing(false);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    // Read back what the drag painted, restore the transition (revert the inline
    // override to the stylesheet), then commit to state + storage.
    const committed = configDockRef.current?.offsetHeight ?? configHeightRef.current;
    if (configDockRef.current) configDockRef.current.style.transition = '';
    commitDockHeight(committed);
  }, [commitDockHeight]);

  const onDockKeyDown = useCallback((e: ReactKeyboardEvent<HTMLDivElement>) => {
    let next: number | null = null;
    switch (e.key) {
      // Dragging the divider UP grows the dock, so ArrowUp/PageUp grow it.
      case 'ArrowUp':   next = configHeightRef.current + (e.shiftKey ? DOCK_STEP_LARGE : DOCK_STEP); break;
      case 'ArrowDown': next = configHeightRef.current - (e.shiftKey ? DOCK_STEP_LARGE : DOCK_STEP); break;
      case 'PageUp':    next = configHeightRef.current + DOCK_STEP_LARGE; break;
      case 'PageDown':  next = configHeightRef.current - DOCK_STEP_LARGE; break;
      case 'Home':      next = DOCK_MIN_PX; break;
      case 'End':       next = dockMaxRef.current; break;
      default: return;
    }
    e.preventDefault();
    commitDockHeight(next);
  }, [commitDockHeight]);

  // Cancel any in-flight rAF on unmount; restore body styles defensively.
  useEffect(() => () => {
    if (dockRafRef.current != null) cancelAnimationFrame(dockRafRef.current);
    if (dockDragRef.current) { document.body.style.cursor = ''; document.body.style.userSelect = ''; }
  }, []);

  // Lifecycle state
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [publishing, setPublishing] = useState(false);
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
  // Catalog-driven Manage hub (connector gallery + dataset wizard + IR manager)
  // — the Wave-2 authoring foundation, surfaced additively alongside ManagePanel.
  const [manageHubOpen, setManageHubOpen] = useState(false);
  const [manageHubTab, setManageHubTab] = useState<'linked-services' | 'datasets' | 'integration-runtimes'>('linked-services');
  const openManageHub = useCallback((tab: 'linked-services' | 'datasets' | 'integration-runtimes') => {
    setManageHubTab(tab); setManageHubOpen(true);
  }, []);
  const [triggerName, setTriggerName] = useState('');
  const [triggerBusy, setTriggerBusy] = useState(false);
  const [triggerErr, setTriggerErr] = useState<string | null>(null);
  const [triggers, setTriggers] = useState<Array<{ name: string; type?: string; runtimeState?: string }>>([]);
  // F4: which schedule-time parameter sources the deployment has configured.
  const [paramSources, setParamSources] = useState<{ kvAvailable: boolean; appConfigAvailable: boolean }>(
    { kvAvailable: false, appConfigAvailable: false },
  );

  // "Practice with sample data" landing-card state. Seeds real ADLS + runs a
  // real ADF copy pipeline — honest gate when LOOM_SAMPLE_ADLS is unset.
  const [seeding, setSeeding] = useState(false);
  const [seedErr, setSeedErr] = useState<string | null>(null);
  const [seedErrIntent, setSeedErrIntent] = useState<'warning' | 'error'>('error');

  // ── Import / Export / Template gallery (F3 + F28) ──
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [importErr, setImportErr] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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
      // Contract F race-guard: on the primary inline-create flow loadDetail
      // resolves the just-persisted (still-empty) definition. If the template
      // seed has already fired, an empty load here would clobber the seeded
      // geo-enrich canvas — so never overwrite a seeded template with an empty
      // spec. A real saved pipeline (non-empty activities) always loads.
      const loadedActivities = nextSpec?.properties?.activities?.length ?? 0;
      if (templateSeeded.current && loadedActivities === 0) {
        setDirty(false);
        setSelectedActivity(null);
        return;
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
      if (j.ok) {
        setTriggers(j.triggers || []);
        if (j.paramSources) setParamSources(j.paramSources);
      }
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
      const warnCount = j.validation?.warningCount ?? 0;
      const actCount = j.validation?.activities?.length ?? activities.length;
      const okMsg = j.ok
        ? `Validation passed — ${actCount} activit${actCount === 1 ? 'y' : 'ies'} checked${warnCount ? `, ${warnCount} warning${warnCount === 1 ? '' : 's'}` : ''}.`
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

  // Publish the current canvas to a LIVE Azure Data Factory pipeline (creates
  // the ADF backing + stamps adfPipelineName) so Run / Debug / Schedule work.
  // This is the concrete resolution for the "no ADF backing yet" gate. Returns
  // true on success so Run/Debug can publish-then-retry transparently.
  const publishToAdf = useCallback(async (): Promise<boolean> => {
    if (!workspaceId || !pipelineId) return false;
    const r = await fetch(`/api/items/data-pipeline/${encodeURIComponent(pipelineId)}/publish?workspaceId=${encodeURIComponent(workspaceId)}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ definition: { name: spec.name, properties: spec.properties } }),
    });
    const j = await r.json();
    if (!j.ok) {
      dispatchToast(<Toast><ToastTitle>Publish failed: {j.gate?.remediation || j.error}</ToastTitle></Toast>, { intent: 'error' });
      return false;
    }
    setDirty(false);
    dispatchToast(<Toast><ToastTitle>Published to ADF · {j.adfPipelineName}</ToastTitle></Toast>, { intent: 'success' });
    return true;
  }, [workspaceId, pipelineId, spec, dispatchToast]);

  const publish = useCallback(async () => {
    setPublishing(true);
    try { await publishToAdf(); } finally { setPublishing(false); }
  }, [publishToAdf]);

  const run = useCallback(async () => {
    if (!workspaceId || !pipelineId) return;
    setRunning(true);
    try {
      const url = `/api/items/data-pipeline/${encodeURIComponent(pipelineId)}/run?workspaceId=${encodeURIComponent(workspaceId)}`;
      let r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) });
      let j = await r.json();
      // Not yet backed by ADF → publish, then retry once. No dead-end.
      if (!j.ok && (j.gate || /no ADF backing/i.test(j.error || ''))) {
        dispatchToast(<Toast><ToastTitle>Publishing to ADF first…</ToastTitle></Toast>, { intent: 'info' });
        if (await publishToAdf()) {
          r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) });
          j = await r.json();
        }
      }
      if (!j.ok) dispatchToast(<Toast><ToastTitle>Run failed: {j.gate?.remediation || j.error}</ToastTitle></Toast>, { intent: 'error' });
      else {
        dispatchToast(<Toast><ToastTitle>Run queued · {j.runId?.slice(0, 8)}</ToastTitle></Toast>, { intent: 'success' });
        setTopTab('output');
      }
    } finally { setRunning(false); }
  }, [workspaceId, pipelineId, dispatchToast, publishToAdf]);

  const debug = useCallback(async () => {
    if (!workspaceId || !pipelineId) return;
    setDebugging(true);
    try {
      const url = `/api/items/data-pipeline/${encodeURIComponent(pipelineId)}/debug?workspaceId=${encodeURIComponent(workspaceId)}`;
      let r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) });
      let j = await r.json();
      if (!j.ok && (j.gate || /no ADF backing/i.test(j.error || ''))) {
        dispatchToast(<Toast><ToastTitle>Publishing to ADF first…</ToastTitle></Toast>, { intent: 'info' });
        if (await publishToAdf()) {
          r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) });
          j = await r.json();
        }
      }
      if (!j.ok) dispatchToast(<Toast><ToastTitle>Debug failed: {j.gate?.remediation || j.error}</ToastTitle></Toast>, { intent: 'error' });
      else {
        dispatchToast(<Toast><ToastTitle>Debug run started · {j.runId?.slice(0, 8)}</ToastTitle></Toast>, { intent: 'success' });
        setTopTab('output');
      }
    } finally { setDebugging(false); }
  }, [workspaceId, pipelineId, dispatchToast, publishToAdf]);

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

  // "Practice with sample data" — seed real ADLS Gen2 with a sample CSV, create
  // + run an ADF copy pipeline, then navigate to the generated pipeline item and
  // surface its Output tab. No simulated success: an honest MessageBar renders
  // the precise infra gate when LOOM_SAMPLE_ADLS / ADF is unset.
  const practiceWithSampleData = useCallback(async () => {
    setSeedErr(null);
    if (!workspaceId) {
      setSeedErr('Select a workspace first (dropdown above) before seeding sample data.');
      setSeedErrIntent('warning');
      return;
    }
    setSeeding(true);
    try {
      const r = await fetch('/api/items/data-pipeline/practice-seed', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId }),
      });
      const j = await r.json();
      if (!j.ok) {
        setSeedErr(j.gate?.remediation || j.gate?.reason || j.error || 'Seeding failed');
        setSeedErrIntent(j.gate ? 'warning' : 'error');
        return;
      }
      // Navigate to the generated pipeline and surface its real run in Output.
      setPipelineId(j.pipelineId);
      setTopTab('output');
      await loadList(workspaceId);
      dispatchToast(
        <Toast><ToastTitle>Sample data seeded · run {String(j.runId || '').slice(0, 8)} queued</ToastTitle></Toast>,
        { intent: 'success' },
      );
    } catch (e: any) {
      setSeedErr(e?.message || String(e));
      setSeedErrIntent('error');
    } finally { setSeeding(false); }
  }, [workspaceId, dispatchToast, loadList]);

  // ── Export: GET the packaged .zip and trigger a browser download ──
  const exportPipeline = useCallback(async () => {
    if (!workspaceId || !pipelineId) return;
    try {
      const r = await fetch(
        `/api/items/data-pipeline/${encodeURIComponent(pipelineId)}/export?workspaceId=${encodeURIComponent(workspaceId)}`,
      );
      if (!r.ok) {
        const j = await r.json().catch(() => ({} as any));
        dispatchToast(<Toast><ToastTitle>Export failed: {j.error || r.statusText}</ToastTitle></Toast>, { intent: 'error' });
        return;
      }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${(spec.name || 'pipeline').replace(/[^\w\s-]/g, '_')}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      dispatchToast(<Toast><ToastTitle>Exported.</ToastTitle></Toast>, { intent: 'success' });
    } catch (e: any) {
      dispatchToast(<Toast><ToastTitle>Export error: {e?.message || e}</ToastTitle></Toast>, { intent: 'error' });
    }
  }, [workspaceId, pipelineId, spec.name, dispatchToast]);

  // ── Import: POST the .zip; on success reload the list and select it ──
  const importPipeline = useCallback(async (file: File) => {
    if (!workspaceId) return;
    setImportErr(null);
    const form = new FormData();
    form.append('file', file);
    try {
      const r = await fetch(
        `/api/items/data-pipeline/import?workspaceId=${encodeURIComponent(workspaceId)}&displayName=${encodeURIComponent(file.name.replace(/\.zip$/i, ''))}`,
        { method: 'POST', body: form },
      );
      const j = await r.json().catch(() => ({ ok: false, error: r.statusText }));
      if (!j.ok) {
        setImportErr(j.error || 'import failed');
        dispatchToast(<Toast><ToastTitle>Import failed: {j.error}</ToastTitle></Toast>, { intent: 'error' });
        return;
      }
      await loadList(workspaceId);
      if (j.pipeline?.id) setPipelineId(j.pipeline.id);
      dispatchToast(
        <Toast><ToastTitle>Imported &ldquo;{j.pipeline?.displayName}&rdquo;
          {j.gate ? ` (Loom only — ${j.gate.reason})` : j.adfPublished ? ' and published to ADF.' : '.'}
        </ToastTitle></Toast>,
        { intent: j.gate ? 'warning' : 'success' },
      );
    } catch (e: any) {
      setImportErr(e?.message || String(e));
      dispatchToast(<Toast><ToastTitle>Import error: {e?.message || e}</ToastTitle></Toast>, { intent: 'error' });
    }
  }, [workspaceId, loadList, dispatchToast]);

  // ── Template gallery: instantiate the selected spec onto the canvas ──
  const instantiateTemplate = useCallback((templateSpec: PipelineSpec, t: PipelineTemplate) => {
    patchSpec(() => ({
      ...templateSpec,
      name: `${templateSpec.name || t.id}_${Date.now().toString(36)}`,
    }));
    setSelectedActivity(null);
    setTopTab('pipeline');
    dispatchToast(
      <Toast><ToastTitle>Template &ldquo;{t.title}&rdquo; loaded — wire in linked services and datasets, then Save.</ToastTitle></Toast>,
      { intent: 'info' },
    );
  }, [dispatchToast]);

  // ── Contract F: when opened with a templateId (e.g. the geo-pipeline alias →
  //    'geo-enrich'), instantiate that template's complete, ADF-runnable spec
  //    onto the canvas once. This must fire for BOTH the legacy no-workspace
  //    flow (id==='new', router.push('/items/geo-pipeline/new')) AND the primary
  //    Wave-C inline-create flow, where new-item-dialog.tsx persists the
  //    data-pipeline item FIRST then navigates to
  //    /items/data-pipeline/<REAL_ID>?runtime=adf&templateId=geo-enrich. In that
  //    case `id` is a real persisted id and loadDetail loads the still-empty
  //    STARTER definition — so the seed MUST run on a freshly-created item too,
  //    else the user gets a BLANK pipeline instead of the geo-enrichment they
  //    picked (a no-vaporware violation). We no longer gate on id==='new';
  //    instead we seed whenever the loaded canvas is still empty. Re-seeding is
  //    impossible (templateSeeded ref) and a saved pipeline is never clobbered
  //    (activities.length>0 guard). `activities.length` is in the deps so the
  //    seed re-evaluates AFTER loadDetail resolves the empty persisted spec.
  const templateSeeded = useRef(false);
  useEffect(() => {
    if (templateSeeded.current) return;
    if (!templateId) return;
    if (activities.length > 0) return;
    const t = PIPELINE_TEMPLATES.find((x) => x.id === templateId);
    if (!t) return;
    templateSeeded.current = true;
    instantiateTemplate(t.spec, t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templateId, id, activities.length, instantiateTemplate]);

  // Create any ADF trigger type from the guided wizard's payload (no JSON/cron).
  // paramBindings carry per-parameter value sources (direct / Key Vault / App
  // Config); the BFF route resolves KV/App Config server-side at creation time.
  const createTriggerWith = useCallback(async (
    name: string,
    properties: Record<string, unknown>,
    paramBindings: Record<string, ParamBinding>,
  ) => {
    if (!workspaceId || !pipelineId || !name.trim()) return;
    setTriggerBusy(true); setTriggerErr(null);
    try {
      const r = await fetch(`/api/items/data-pipeline/${encodeURIComponent(pipelineId)}/triggers?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), properties, parameterBindings: paramBindings }),
      });
      const j = await r.json();
      if (!j.ok) { setTriggerErr(j.error || 'create failed'); return; }
      setScheduleOpen(false); setTriggerName('');
      await loadTriggers(workspaceId, pipelineId);
      dispatchToast(<Toast><ToastTitle>Trigger created — start it from the list below.</ToastTitle></Toast>, { intent: 'success' });
    } finally { setTriggerBusy(false); }
  }, [workspaceId, pipelineId, loadTriggers, dispatchToast]);

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
          { label: 'Manage', icon: <Settings20Regular />, onClick: () => setManageOpen(true), title: 'Linked services and datasets (quick)' },
          { label: 'Linked services', icon: <PlugConnected20Regular />, onClick: () => openManageHub('linked-services'), title: 'Connector gallery — browse 30+ connectors and create a connection' },
          { label: 'Datasets', icon: <Database20Regular />, onClick: () => openManageHub('datasets'), title: 'New dataset wizard — connector → connection → shape → schema' },
        ]},
        { label: 'Run', actions: [
          { label: publishing ? 'Publishing…' : 'Publish', icon: <CloudArrowUp20Regular />, onClick: pipelineId && !publishing ? publish : undefined, disabled: !pipelineId || publishing, title: 'Deploy this pipeline to Azure Data Factory so it can Run / Debug / schedule' },
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
        { label: 'Import / Export', actions: [
          { label: 'Export', icon: <ArrowDownload20Regular />, onClick: pipelineId ? exportPipeline : undefined, disabled: !pipelineId, title: 'Download this pipeline as a .zip (pipeline-content.json)' },
          { label: 'Import', icon: <ArrowUpload20Regular />, onClick: workspaceId ? () => fileInputRef.current?.click() : undefined, disabled: !workspaceId, title: 'Import a pipeline from a .zip' },
          { label: 'Templates', icon: <AppsList20Regular />, onClick: () => setGalleryOpen(true), title: 'Open the curated template gallery' },
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
    publish, publishing,
    pipelineId, canDelete, del, showGrid, snapToGrid, outputPinned,
    exportPipeline, openManageHub,
  ]);

  // ============ Render ============
  // Runtime selector (Contract A/B) — rendered at the top of EVERY runtime path
  // so this stays the single, unified pipeline authoring experience. Fluent v9
  // RadioGroup, Loom tokens only (web3-ui), no JSON/freeform. Locked (read-only
  // Caption) when the editor was opened from an alias/preset slug.
  const runtimeSelector = (
    <div
      style={{
        display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS,
        padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
        backgroundColor: tokens.colorNeutralBackground1,
        border: `1px solid ${tokens.colorNeutralStroke2}`,
        borderRadius: tokens.borderRadiusMedium,
      }}
    >
      <div className={s.sectionHead}>
        <Flow20Regular style={{ color: tokens.colorBrandForeground1 }} />
        <Subtitle2>Runtime</Subtitle2>
        {runtimeLocked && <Badge size="small" appearance="outline" color="brand">{runtime === 'adf' ? 'ADF preset' : runtime === 'synapse' ? 'Synapse preset' : 'preset'}</Badge>}
      </div>
      <RadioGroup
        layout="horizontal"
        value={runtime}
        disabled={runtimeLocked}
        onChange={(_, d) => {
          const next = d.value as PipelineRuntime;
          // Never auto-/force-select fabric without a bound workspace.
          if (next === 'fabric' && !fabricAvailable) return;
          setRuntime(next);
        }}
        aria-label="Pipeline runtime"
      >
        <Radio value="adf" label="Azure Data Factory (standalone)" />
        <Radio value="synapse" label="Synapse workspace" />
        <Radio value="fabric" label="Microsoft Fabric (opt-in)" disabled={!fabricAvailable} />
      </RadioGroup>
      {runtimeLocked ? (
        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
          Runtime is locked to the{' '}
          {runtime === 'synapse' ? 'Synapse' : 'Azure Data Factory'} preset for this item type.
        </Caption1>
      ) : !fabricAvailable ? (
        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
          Azure Data Factory is the default. Bind a Fabric workspace to enable the Microsoft Fabric runtime (opt-in).
        </Caption1>
      ) : (
        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
          Azure-native by default — ADF or Synapse. Microsoft Fabric is opt-in.
        </Caption1>
      )}
    </div>
  );

  // For the Azure-native runtimes ('adf' / 'synapse') delegate the full
  // bind/run/save/validate/debug/runs/triggers surface to the SAME purpose-built
  // editors (Contract B) — they consume the existing
  // `/api/items/{adf-pipeline|synapse-pipeline}/{id}/*` routes and ship the same
  // rich three-pane designer. We only prepend the runtime selector so the user
  // can switch backends. (Note: the `synapse-pipeline` SLUG itself isn't routed
  // here — it has no aliasOf and opens SynapsePipelineEditor directly; this
  // delegation only fires when the user picks the 'synapse' runtime inside the
  // unified editor.) 'fabric' keeps this file's existing body below.
  //
  // Exception (Contract F): when this editor is hosting a TEMPLATE instantiation
  // (templateId set, e.g. the geo-pipeline alias → 'geo-enrich'), we stay on
  // THIS file's own canvas so the seeded, ADF-runnable spec is visible and
  // editable here (the delegate editors take no spec/template prop). This holds
  // for the legacy id==='new' flow AND the primary Wave-C inline-create flow,
  // where the data-pipeline item is persisted FIRST and we arrive with a real
  // id plus ?templateId=… — delegating to <AdfPipelineEditor> there would show a
  // BLANK pipeline (it has no spec prop), dropping the geo-enrichment the user
  // picked. A `templateId` is only present for templated creates (geo-pipeline /
  // templated data-pipeline); plain adf-pipeline / synapse-pipeline instances
  // carry none, so they still delegate exactly as before (back-compat intact).
  const hostTemplate = !!templateId;
  if (!hostTemplate && (runtime === 'adf' || runtime === 'synapse')) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, minHeight: 0, flex: 1 }}>
        <Toaster toasterId={toastId} />
        {runtimeSelector}
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          {runtime === 'adf'
            ? <AdfPipelineEditor item={item} id={id} />
            : <SynapsePipelineEditor item={item} id={id} />}
        </div>
      </div>
    );
  }

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon}
      rightPanelLabel="Copilot"
      rightPanel={
        // A12 — docked Pipeline Copilot. ItemEditorChrome renders this in a
        // collapsible right rail (Fluent v9 CollapseToggle / CollapsedRail,
        // per-surface persisted, dark-legible) exactly like the alias editors
        // (pipeline-editor-core.tsx:755), so the palette|canvas|properties
        // designer below is untouched. The pane streams real SSE from
        // /api/items/data-pipeline/{id}/copilot and applies the generated spec
        // to THIS file's canvas (setSpec is the spec source-of-truth at :311);
        // mirrors applyGeneratedSpec at pipeline-editor-core.tsx:594.
        //
        // A12 id-mismatch fix: the canvas and EVERY real action (Save/Run/
        // Debug/Triggers) operate on `pipelineId` — the selected pipeline,
        // which defaults to the first in the workspace (loadList :506), NOT the
        // route `id`. Anchoring the Copilot to the route `id` let it generate /
        // run against a DIFFERENT pipeline than the one on the canvas. Bind the
        // pane to the SAME `pipelineId` (falling back to the route `id` only
        // while unbound, when `bound` is null and no request fires anyway) so
        // Copilot always targets the pipeline the user sees.
        <PipelineCopilotPane
          apiBase={`/api/items/data-pipeline/${encodeURIComponent(pipelineId || id)}`}
          bound={pipelineId || null}
          onApplySpec={(genSpec) => {
            setSpec(genSpec);
            setDirty(true);
            setSelectedActivity(null);
            setTopTab('pipeline');
            setTimeout(() => canvasRef.current?.fitToScreen(), 150);
          }}
        />
      }
      leftPanel={
        <div className={s.treePad}>
          <div className={s.sectionHead} style={{ marginBottom: tokens.spacingVerticalS }}>
            <Flow24Regular style={{ color: tokens.colorBrandForeground1 }} />
            <Subtitle2>Pipelines</Subtitle2>
          </div>
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
          {runtimeSelector}
          <div className={s.topbar}>
            <Badge appearance="filled" color="brand">
              {runtime === 'adf' ? 'Azure Data Factory' : runtime === 'synapse' ? 'Synapse pipeline' : 'Microsoft Fabric'}
            </Badge>
            <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, minWidth: 280 }}>
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

          {/* Onboarding banner + start cards: only while the canvas is EMPTY and
              no pipeline is bound. The moment the first activity is dropped (or a
              pipeline loads), collapse them so the designer + the selected-node
              properties panel get the full height — previously they stayed
              (pipelineId still null until Save) and squeezed the properties into
              a tiny bottom strip you could only read by collapsing the palette. */}
          {!pipelineId && activities.length === 0 && (
            <div>
              {seedErr && (
                <MessageBar intent={seedErrIntent} style={{ marginBottom: tokens.spacingVerticalS }}>
                  <MessageBarBody>
                    <MessageBarTitle>Practice with sample data</MessageBarTitle>
                    {seedErr}
                  </MessageBarBody>
                </MessageBar>
              )}
              <MessageBar intent="info" style={{ marginBottom: tokens.spacingVerticalS }}>
                <MessageBarBody>
                  Pipelines run Azure-native by default — switch the <strong>Runtime</strong> above to
                  <strong> Azure Data Factory</strong> (the default) or <strong>Synapse</strong> to author against
                  Azure with no Fabric capacity required. The <strong>Microsoft Fabric</strong> runtime shown here
                  is opt-in. Design your pipeline below — drag activities from the palette onto the canvas and wire
                  them up. To <strong>Save / Validate / Run</strong> against the Fabric backing, pick a workspace and
                  pipeline from the left rail, click <strong>New pipeline</strong>, or start from a card below.
                </MessageBarBody>
              </MessageBar>
              <TileGrid minTileWidth={220}>
                {/* Card: Start with a blank canvas */}
                <div
                  role="button"
                  tabIndex={0}
                  className={mergeClasses(s.startCard, !canCreate && s.startCardDisabled)}
                  onClick={canCreate ? () => setCreateOpen(true) : undefined}
                  onKeyDown={(e) => { if (canCreate && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setCreateOpen(true); } }}
                >
                  <Add20Regular className={s.cardIcon} />
                  <Subtitle2>Start with blank canvas</Subtitle2>
                  <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                    Create an empty pipeline and drag activities from the palette.
                    {!canCreate ? ' Select a workspace first.' : ''}
                  </Caption1>
                </div>

                {/* Card: Practice with sample data (real ADLS seed + ADF run) */}
                <div
                  role="button"
                  tabIndex={0}
                  aria-busy={seeding}
                  className={s.startCard}
                  style={seeding ? { cursor: 'default' } : undefined}
                  onClick={seeding ? undefined : practiceWithSampleData}
                  onKeyDown={(e) => { if (!seeding && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); practiceWithSampleData(); } }}
                >
                  {seeding
                    ? <Spinner size="extra-small" label="Seeding ADLS…" />
                    : <CloudArrowUp20Regular className={s.cardIcon} />}
                  <Subtitle2>Practice with sample data</Subtitle2>
                  <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                    Seed a real CSV to ADLS Gen2, run an auto-generated copy pipeline,
                    and see live Output rows — no mock data.
                  </Caption1>
                </div>

                {/* Card: Templates gallery — opens the real curated gallery */}
                <div
                  role="button"
                  tabIndex={0}
                  className={s.startCard}
                  onClick={() => setGalleryOpen(true)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setGalleryOpen(true); } }}
                >
                  <AppsList20Regular className={s.cardIcon} />
                  <Subtitle2>Templates gallery</Subtitle2>
                  <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                    Curated templates: incremental copy, metadata-driven, ForEach patterns.
                  </Caption1>
                </div>
              </TileGrid>
            </div>
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
                    {/* Canvas region — user-resizable height (drag the grip below
                        the canvas, or focus it and use Arrow keys). Height is
                        persisted per-surface; the canvas FILLS this region and is
                        never resized by config expand/collapse. The dock divider
                        below is complementary and resizes only the config dock. */}
                    <ResizableCanvasRegion
                      storageKey="adf-data-pipeline"
                      defaultPx={460}
                      minPx={300}
                      ariaLabel="Resize pipeline canvas height"
                    >
                      <div className={s.canvasWrap} style={{ flex: 1, height: '100%', minHeight: 0 }}>
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
                    </ResizableCanvasRegion>
                    {/* Draggable divider — same accessible Pointer-Events standard
                        as the canvas handle above: pointer-capture drag (mouse /
                        touch / pen), Arrow/Page/Home/End keyboard resize, full
                        ARIA. Drag UP (or ArrowUp) grows the dock below. */}
                    <div
                      className={mergeClasses(s.splitter, resizing && s.splitterActive)}
                      role="separator"
                      aria-orientation="horizontal"
                      aria-label="Resize activity configuration panel. Use Arrow Up and Arrow Down keys."
                      aria-valuemin={DOCK_MIN_PX}
                      aria-valuemax={dockMax}
                      aria-valuenow={configHeight}
                      tabIndex={0}
                      title="Drag, or focus and use Arrow keys, to resize the configuration panel"
                      onPointerDown={startResize}
                      onPointerMove={onDockPointerMove}
                      onPointerUp={endDockResize}
                      onLostPointerCapture={endDockResize}
                      onKeyDown={onDockKeyDown}
                    >
                      <div className={s.splitterGrip} />
                    </div>
                    {/* Bottom-docked activity configuration — explicit height + own scroll. */}
                    <div ref={configDockRef} className={s.configDock} style={{ height: configHeight }}>
                      <PropertiesPanel
                        activity={selected}
                        allActivities={activities}
                        parameters={parameters}
                        variables={variables}
                        layout="dock"
                        itemId={pipelineId}
                        pipelineId={pipelineId}
                        workspaceId={workspaceId}
                        apiSlug="data-pipeline"
                        onPatch={(patch) => { if (selected) patchActivity(selected.name, patch); }}
                        onDelete={() => { if (selected) deleteActivity(selected.name); }}
                      />
                    </div>
                  </div>
                </div>
              )}

              {topTab === 'parameters' && (
                <div className={s.tabBody}>
                  <div className={s.sectionHead}>
                    <NumberSymbol20Regular style={{ color: tokens.colorBrandForeground1 }} />
                    <Subtitle2>Pipeline parameters</Subtitle2>
                  </div>
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
                              aria-label="Delete parameter"
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
                  <div className={s.sectionHead}>
                    <Tag20Regular style={{ color: tokens.colorBrandForeground1 }} />
                    <Subtitle2>Pipeline variables</Subtitle2>
                  </div>
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
                              aria-label="Delete variable"
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
                  <div className={s.sectionHead}>
                    <Settings20Regular style={{ color: tokens.colorBrandForeground1 }} />
                    <Subtitle2>Pipeline settings</Subtitle2>
                  </div>
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

                  <div className={s.sectionHead} style={{ marginTop: tokens.spacingVerticalL }}>
                    <CalendarClock20Regular style={{ color: tokens.colorBrandForeground1 }} />
                    <Subtitle2>Active triggers ({triggers.length})</Subtitle2>
                  </div>
                  {triggers.length === 0 && <Caption1>No triggers wired to this pipeline yet.</Caption1>}
                  <Table size="small">
                    <TableBody>
                      {triggers.map((t) => (
                        <TableRow key={t.name}>
                          <TableCell><code style={{ overflowWrap: 'anywhere', wordBreak: 'break-word' }}>{t.name}</code></TableCell>
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

                  <div className={s.sectionHead} style={{ marginTop: tokens.spacingVerticalL }}>
                    <Code20Regular style={{ color: tokens.colorBrandForeground1 }} />
                    <Subtitle2>Raw spec</Subtitle2>
                  </div>
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
                <OutputPane
                  workspaceId={workspaceId}
                  pipelineId={pipelineId}
                  pipelineParams={parameters}
                  paramNames={parameters.map((p) => p.name)}
                  variableNames={variables.map((v) => v.name)}
                  activityNames={activities.map((a) => a.name)}
                />
              )}
            </TopTabs>
          )}

          {/* Manage hub — linked services / datasets (Synapse-backed) */}
          <ManagePanel open={manageOpen} backend="synapse" onOpenChange={setManageOpen} />

          {/* Catalog-driven Manage hub — connector gallery + dataset wizard
              (Synapse-backed; IR tab is ADF-only and stays hidden here). */}
          <PipelineManageHub
            open={manageHubOpen}
            onOpenChange={setManageHubOpen}
            engine="synapse"
            initialTab={manageHubTab}
            itemId={pipelineId || undefined}
            workspaceId={workspaceId || undefined}
          />

          {/* Create dialog */}
          <Dialog open={createOpen} onOpenChange={(_, d) => setCreateOpen(d.open)}>
            <DialogSurface>
              <DialogBody>
                <DialogTitle>Create Fabric data pipeline</DialogTitle>
                <DialogContent>
                  <Input placeholder="displayName" value={createName} onChange={(_, d) => setCreateName(d.value)} style={{ width: '100%' }} />
                  {createErr && <MessageBar intent="error" style={{ marginTop: tokens.spacingVerticalS }}><MessageBarBody>{createErr}</MessageBarBody></MessageBar>}
                </DialogContent>
                <DialogActions>
                  <Button appearance="secondary" onClick={() => setCreateOpen(false)}>Cancel</Button>
                  <Button appearance="primary" disabled={createBusy || !createName.trim()} onClick={create}>{createBusy ? 'Creating…' : 'Create'}</Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>

          {/* Schedule dialog */}
          <TriggerWizard
            open={scheduleOpen}
            onClose={() => { setScheduleOpen(false); setTriggerErr(null); }}
            onCreate={createTriggerWith}
            onActivate={(name) => startStopTrigger(name, 'start')}
            pipelineParams={parameters}
            kvAvailable={paramSources.kvAvailable}
            appConfigAvailable={paramSources.appConfigAvailable}
            busy={triggerBusy}
            error={triggerErr}
          />

          {/* Hidden file input for Import (.zip) */}
          <input
            ref={fileInputRef}
            type="file"
            accept=".zip"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) importPipeline(f);
              e.target.value = '';  // reset so the same file can be re-selected
            }}
          />

          {importErr && (
            <MessageBar intent="error">
              <MessageBarBody>Import failed: {importErr}</MessageBarBody>
            </MessageBar>
          )}

          {/* Template gallery flyout */}
          <TemplateGalleryFlyout
            open={galleryOpen}
            onOpenChange={setGalleryOpen}
            onSelect={instantiateTemplate}
          />
        </div>
      }
    />
  );
}
