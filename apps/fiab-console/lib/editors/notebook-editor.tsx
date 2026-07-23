'use client';

import { clientFetch } from '@/lib/client-fetch';
/**
 * NotebookEditor — Azure-native notebook editor (no Microsoft Fabric required).
 *
 * Per .claude/rules/no-fabric-dependency.md this is the DEFAULT path: authoring,
 * listing, and execution work with ZERO Fabric tenant/workspace bound. The
 * notebook definition persists to Cosmos item state; cell execution runs against
 * the Azure-native compute the notebook is bound to (Synapse Spark, Databricks,
 * or Azure ML). A real Microsoft Fabric workspace is strictly opt-in (selected
 * explicitly) — never a precondition; when an opt-in Fabric call returns 401/403
 * the editor surfaces it verbatim via MessageBar — no mocks.
 *
 * Backed by /api/loom/workspaces + /api/items/notebook/**.
 *
 * R9 decomposition (loom-next-level WS-E): the six self-contained explorer/
 * compute dialogs were extracted to ./notebook-editor/dialogs/* (behavior
 * preserved — closed-over state/handlers became fully-typed props; the shell
 * keeps the owning state + handlers). This is the browser-safe first slice of
 * the plan's dialog seam (docs/fiab/decomposition-plan.md §4 step 2); the
 * explorer-tree / cell-list / compute-panel / run-hook pane carving (steps 3-5,
 * heavy shared state) remains a browser-verified follow-up per the plan's G1
 * stipulation.
 *   ./notebook-editor/dialogs/folder-dialogs.tsx  — folder new/rename, folder delete, move, notebook rename
 *   ./notebook-editor/dialogs/compute-dialogs.tsx — Configure compute, New compute instance (AML)
 */

import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Subtitle2, Caption1, Badge, Button, Spinner, Input, Tooltip, Divider,
  Tree, TreeItem, TreeItemLayout, Select,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle, MessageBarActions,
  Menu, MenuTrigger, MenuList, MenuItem, MenuPopover, Field, Switch,
  Dialog, DialogTrigger, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  tokens,
} from '@fluentui/react-components';
import {
  Play20Regular, Add20Regular, Save20Regular, ArrowSync20Regular, Delete20Regular, Notebook20Regular,
  History20Regular, ArrowUpload20Regular, Open20Regular, Library20Regular, Settings20Regular, Sparkle20Regular, BracesVariable20Regular,
  Copy20Regular, Info16Regular, ChevronDown20Regular, ChevronUp20Regular, Server20Regular,
  Notebook16Regular, Database16Regular, History16Regular, Database24Regular, Stop20Regular,
  FolderAdd20Regular, Folder20Filled, ArrowSort20Regular,
  Flash16Regular, CalendarClock20Regular, CalendarClock16Regular,
} from '@fluentui/react-icons';
import { EmptyState } from '@/lib/components/empty-state';
import {
  listFolders, createFolder, renameFolder, deleteFolder, patchWorkspaceItem,
  type WorkspaceFolder,
} from '@/lib/api/workspaces';
import { buildTree, countDescendants, type FolderNode, type TreeItemSort } from '@/lib/panes/folders';
import { ItemEditorChrome } from './item-editor-chrome';
import { useAutosave, AutosaveIndicator } from './use-autosave';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';
import { useRegisterRibbonCommands } from '@/lib/components/shared/ribbon-commands';
import { TeachingBanner } from '@/lib/components/shared/teaching-toast';
import { loomDocUrl } from '@/lib/learn/content';
import { CodeCell, pruneCellHeightKey } from '@/lib/components/notebook/code-cell';
import { MarkdownCell } from '@/lib/components/notebook/markdown-cell';
import { CellAdder } from '@/lib/components/notebook/cell-adder';
import { HistoryDrawer } from '@/lib/components/notebook/history-drawer';
import { DatastoreExplorer } from '@/lib/components/notebook/datastore-explorer';
import { EnvironmentPanel, type AmlEnvironmentLite } from '@/lib/components/notebook/environment-panel';
import {
  SessionConfigDialog, toConfigureOptions, sessionConfigEquals, normalizeSessionConfig,
  DEFAULT_SESSION_CONFIG, type SessionConfig,
} from '@/lib/components/notebook/session-config-dialog';
import { redactReceiptSecrets } from '@/lib/spark/config-presets';
import { CopilotChatPane } from '@/lib/components/notebook/copilot-chat-pane';
import { setCopilotContext } from '@/lib/components/copilot-pane';
import { VariablesPane, type VarRow } from '@/lib/components/notebook/variables-pane';
import { DataWranglerPanel } from '@/lib/components/notebook/data-wrangler-panel';
import { type NotebookCell, type NotebookCellLang, type NotebookResourceFile, emptyCell, migrateLegacyState } from '@/lib/types/notebook-cell';
import { ScheduleWizard, type ScheduleCreateParams } from '@/lib/components/notebook/schedule-wizard';
import { ParametersDialog } from '@/lib/components/notebook/parameters-dialog';
import { ResourcesPane } from '@/lib/components/notebook/resources-pane';
import { OutlinePane } from '@/lib/components/notebook/outline-pane';
import { RunProgress, type SparkRunProgress } from '@/lib/components/notebook/run-progress';
import { registerBridge } from '@/lib/copilot/apply-change';
import { runtimeFromComputeKind, starterCellFor, RUNTIME_LABEL, type ClusterRuntime } from '@/lib/components/editor/cluster-runtime';

// Ribbon is now built dynamically inside the component so each action can
// hold a real onClick wired to the editor's handlers. See `buildRibbon`
// below the component declarations.

import { useStyles } from './notebook-editor/styles';
import type {
  NotebookLite, JobLite, LakehouseLite, AttachedSource,
  AmlScheduleRow, Props, ComputeTarget, WorkspaceType,
} from './notebook-editor/types';
import {
  STARTER_PY, TTL_LABEL, AML_CI_VM_SIZES,
} from './notebook-editor/constants';
import {
  cellRoutesToSpark, starterCells, splitKeep, downloadJson, decodePy,
  isComputeRunning, isCiStopped, looksStreaming,
} from './notebook-editor/helpers';
import { useWorkspaces, useComputes, useAmlConfigured, useMyCi } from './notebook-editor/hooks';
import { DriverLogPane } from './notebook-editor/driver-log-pane';
import {
  NbFolderDialog, NbFolderDeleteDialog, NbMoveDialog, NbRenameDialog,
} from './notebook-editor/dialogs/folder-dialogs';
import {
  ConfigureComputeDialog, NewComputeInstanceDialog,
} from './notebook-editor/dialogs/compute-dialogs';

export function NotebookEditor({ item, id }: Props) {
  const s = useStyles();
  const ws = useWorkspaces();
  const cp = useComputes();
  const { configured: amlConfigured, defaultCompute: amlDefaultCompute } = useAmlConfigured();
  const myCi = useMyCi();
  // Notebook compute backend toggle. Defaults to Loom-native Spark/Databricks;
  // the user flips to Azure ML when they want a Compute Instance + datastores.
  const [workspaceType, setWorkspaceType] = useState<WorkspaceType>('loom');
  const [workspaceId, setWorkspaceId] = useState('');
  const [computeId, setComputeId] = useState('');
  const [notebooks, setNotebooks] = useState<NotebookLite[] | null>(null);
  const [notebookId, setNotebookId] = useState('');
  // ---- Notebooks-pane folders/subfolders + sort + move (reuses the workspace
  // folders engine: lib/panes/folders.tsx buildTree + lib/api/workspaces folder
  // wrappers → real Cosmos cascade). Folder organization is Loom-native; no
  // Fabric dependency. ----
  const [folders, setFolders] = useState<WorkspaceFolder[]>([]);
  const [nbSort, setNbSort] = useState<TreeItemSort>('name');
  const [nbExpanded, setNbExpanded] = useState<Set<string>>(new Set());
  const [nbFolderDialog, setNbFolderDialog] = useState<
    | { mode: 'create'; parent: string | null }
    | { mode: 'rename'; folderId: string; current: string }
    | null
  >(null);
  const [nbFolderName, setNbFolderName] = useState('');
  const [nbConfirmFolderDelete, setNbConfirmFolderDelete] = useState<WorkspaceFolder | null>(null);
  const [nbMoveTarget, setNbMoveTarget] = useState<NotebookLite | null>(null);
  const [nbFolderBusy, setNbFolderBusy] = useState(false);
  const [nbFolderErr, setNbFolderErr] = useState<string | null>(null);
  const [nbDragId, setNbDragId] = useState<string | null>(null);
  const [nbDropTarget, setNbDropTarget] = useState<string | 'root' | null>(null);
  // Pylance/pylsp WS bridge path + VS Code for Web deep-link, resolved from
  // /api/notebook/<id>/lsp (server-only env: LOOM_PYLSP_ENABLED, boundary, AML).
  const [lspWsUrl, setLspWsUrl] = useState<string | null>(null);
  const [vscodeWeb, setVscodeWeb] = useState<{ enabled: boolean; url: string | null; reason?: string }>({ enabled: false, url: null });
  const [cells, setCells] = useState<NotebookCell[]>(starterCells());
  const [defaultLang, setDefaultLang] = useState<NotebookCellLang>('pyspark');
  const [activeCellId, setActiveCellId] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [listErr, setListErr] = useState<string | null>(null);
  const [listHint, setListHint] = useState<string | null>(null);
  const [detailErr, setDetailErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [runMsg, setRunMsg] = useState<string | null>(null);
  const [jobs, setJobs] = useState<JobLite[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState('');
  // New-notebook kernel — Python 3.10 (pyspark/python cells) or R (sparkr).
  const [createKernel, setCreateKernel] = useState<'python' | 'r'>('python');
  const [createBusy, setCreateBusy] = useState(false);
  const [createErr, setCreateErr] = useState<string | null>(null);
  const [prefill, setPrefill] = useState<{ source: string; container?: string; path?: string } | null>(null);
  // Phase 2: attached data sources (Lakehouses / Warehouses / KQL DBs).
  const [attachedSources, setAttachedSources] = useState<AttachedSource[]>([]);
  const [attachOpen, setAttachOpen] = useState(false);
  const [availableLakehouses, setAvailableLakehouses] = useState<LakehouseLite[] | null>(null);
  const [attachBusy, setAttachBusy] = useState(false);
  // Issue #655: resolved abfss path per attached lakehouse id, surfaced in the
  // Data items list so the user sees the REAL path the auto-mount preamble uses
  // (and can copy it). { abfss } when resolvable, { hint } for an honest gate.
  const [resolvedPaths, setResolvedPaths] = useState<Record<string, { abfss?: string; hint?: string }>>({});
  // Phase 3: History drawer
  const [historyOpen, setHistoryOpen] = useState(false);
  // Copilot chat pane (docked right drawer, ~25% width)
  const [copilotOpen, setCopilotOpen] = useState(false);
  // Variable explorer (Synapse/Fabric "Variables" View-pane parity)
  const [variablesOpen, setVariablesOpen] = useState(false);
  // Data Wrangler panel (Fabric "Data Wrangler" 1:1) — visual data-prep over a
  // pandas host; exports pandas/PySpark code back into a notebook cell.
  const [wranglerOpen, setWranglerOpen] = useState(false);
  // Import-from-file (desktop .ipynb / .py / .sql / .scala / .r → Loom notebook)
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [importing, setImporting] = useState(false);

  // Which compute kinds are runnable for the active workspace type.
  const computeMatchesType = useCallback((c: ComputeTarget): boolean => {
    return workspaceType === 'aml'
      ? c.kind === 'aml-ci'
      : (c.kind === 'synapse-spark' || c.kind === 'databricks-cluster');
  }, [workspaceType]);

  // Library & Environment management: attached AML Environment + custom .jar/.whl
  // libraries (Azure-native 1:1 for the Fabric notebook Environment).
  const [attachedAmlEnv, setAttachedAmlEnv] = useState<{ name: string; version: string } | null>(null);
  const [customLibraries, setCustomLibraries] = useState<string[]>([]);
  const [amlEnvs, setAmlEnvs] = useState<AmlEnvironmentLite[]>([]);
  const [envPanelOpen, setEnvPanelOpen] = useState(false);

  // Session configuration ("Configure session" dialog) — sizes the real Livy
  // Spark session (executors / memory / idle timeout). Persisted per-notebook
  // in Cosmos; applied to the session-create body before the first statement
  // runs (the %%configure equivalent). `cfgDraft` is the in-dialog edit copy so
  // Cancel discards. `sessionStatus` drives the bottom-left status badge.
  const [sessionCfg, setSessionCfg] = useState<SessionConfig>(DEFAULT_SESSION_CONFIG);
  const [cfgDraft, setCfgDraft] = useState<SessionConfig>(DEFAULT_SESSION_CONFIG);
  const [cfgDialogOpen, setCfgDialogOpen] = useState(false);
  const [cfgSaving, setCfgSaving] = useState(false);
  // Send an explicit `sessionConfig` on a run/prewarm ONLY when the user has
  // customized the session sizing. When it's the default, send nothing so the
  // server applies its canonical default sizing — whose stable sizingKey matches
  // the warm pool (R3 #1), letting a pre-warmed session be leased instead of
  // cold-starting. A customized config is still sent verbatim → its own session.
  const isDefaultSessionCfg = useMemo(
    () => sessionConfigEquals(sessionCfg, DEFAULT_SESSION_CONFIG),
    [sessionCfg],
  );
  const sessionConfigBody = useCallback(
    (): Record<string, unknown> => (isDefaultSessionCfg ? {} : { sessionConfig: toConfigureOptions(sessionCfg) }),
    [isDefaultSessionCfg, sessionCfg],
  );

  /**
   * Patch only specific fields on a cell — used by the Run flow so output
   * arriving after a user edit doesn't clobber the new source. Without
   * this the stale `cell` captured at runCell-start would overwrite
   * subsequent typing, and clicking Save would persist the OLD source.
   * Does NOT mark the notebook dirty — output mutations are not user
   * edits and shouldn't enable the Save button on their own.
   */
  const patchCell = useCallback((id: string, patch: Partial<NotebookCell>) => {
    setCells(prev => prev.map(c => c.id === id ? { ...c, ...patch } : c));
  }, []);
  // R3 #4 — resume in-flight runs on remount. `currentNbRef` tracks the loaded
  // notebook so a resume loop stops once the user switches away; `resumedRunsRef`
  // guards against double-resuming the same run (React strict-mode double-mount
  // + repeated loadDetail calls). `pendingResume` bridges loadDetail → the
  // resume effect (defined after the poll helper).
  const currentNbRef = useRef<string | null>(null);
  const resumedRunsRef = useRef<Set<string>>(new Set());
  const [pendingResume, setPendingResume] = useState<Record<string, any> | null>(null);
  const [sessionStatus, setSessionStatus] = useState<'Idle' | 'Running' | 'Error'>('Idle');
  const [sessionReceipt, setSessionReceipt] = useState<Record<string, unknown> | null>(null);

  // Compute & setup chrome (backend toggle, workspace/compute pickers,
  // environment, configure-session, history, …) is collapsed by default so the
  // cells get the vertical space — it previously filled ~half the notebook.
  // A slim always-visible bar keeps Run + the selected-compute summary handy;
  // the full config expands on demand. Auto-expands once if no compute is
  // selected so a brand-new notebook still surfaces the picker.
  const [setupOpen, setSetupOpen] = useState(false);
  const autoOpenedSetupRef = useRef(false);

  // ── R4-NB-1 Scheduling (AML job schedules — recurrence only) ──────────────
  const [scheduleWizardOpen, setScheduleWizardOpen] = useState(false);
  const [schedules, setSchedules] = useState<AmlScheduleRow[]>([]);
  const [schedulesConfigured, setSchedulesConfigured] = useState<boolean | null>(null);
  const [scheduleGateHint, setScheduleGateHint] = useState<string | null>(null);
  const [scheduleBusy, setScheduleBusy] = useState(false);
  const [scheduleError, setScheduleError] = useState<string | null>(null);

  // ── R4-NB-2 Parameters (papermill) ────────────────────────────────────────
  const [paramsDialogOpen, setParamsDialogOpen] = useState(false);

  // ── R4-NB-3 Resources pane (Loom-native file bundle) ──────────────────────
  const [resources, setResources] = useState<NotebookResourceFile[]>([]);
  const [resourcesOpen, setResourcesOpen] = useState(false);

  // ── R4-NB-6 Outline nav ───────────────────────────────────────────────────
  const [outlineOpen, setOutlineOpen] = useState(false);
  // Per-cell wrapper refs so the outline can scroll a heading's cell into view.
  const cellRefs = useRef<Map<string, HTMLDivElement | null>>(new Map());

  // ── R4-NB-4 Real-time Spark progress ──────────────────────────────────────
  // Per-cell progress payload from the run poll (shared with R4-SYN-5's poll
  // surface). Until that server field lands, RunProgress shows an honest
  // indeterminate bar keyed to the phase + elapsed seconds below.
  const [cellProgress, setCellProgress] = useState<Map<string, SparkRunProgress>>(() => new Map());
  const [runPhase, setRunPhase] = useState<string | null>(null);
  const cellRunStartRef = useRef<Map<string, number>>(new Map());
  const [nowTs, setNowTs] = useState<number>(() => Date.now());
  // Real per-cell run duration for the cell chrome ("✓ 2.4 s"), measured from
  // the run dispatch. Undefined when no start was recorded (e.g. a resumed run
  // after remount) — the chrome simply omits the duration; never fabricated.
  const cellDurationMs = useCallback((cellId: string): number | undefined => {
    const t0 = cellRunStartRef.current.get(cellId);
    return typeof t0 === 'number' ? Math.max(0, Date.now() - t0) : undefined;
  }, []);
  const clearCellProgress = useCallback((cellId: string) => {
    cellRunStartRef.current.delete(cellId);
    setCellProgress((prev) => {
      if (!prev.has(cellId)) return prev;
      const next = new Map(prev); next.delete(cellId); return next;
    });
  }, []);

  // ── R4-NB-8 Inline rename ──────────────────────────────────────────────────
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [renameBusy, setRenameBusy] = useState(false);

  // Tick a 1s clock only while a run is in flight, so RunProgress can show an
  // honest elapsed-seconds counter without a permanent timer.
  useEffect(() => {
    if (sessionStatus !== 'Running' && !running) return;
    const t = setInterval(() => setNowTs(Date.now()), 1000);
    return () => clearInterval(t);
  }, [sessionStatus, running]);

  // Schema hint for inline code completion (ghost text): the attached
  // lakehouse / warehouse / KQL sources. Grounds AOAI suggestions in the
  // real items this notebook is bound to (no Fabric dependency).
  const inlineSchemaContext = useMemo(() => {
    if (!attachedSources.length) return undefined;
    const lines = attachedSources.map(
      (a) => `${a.kind} "${a.displayName}"${a.isDefault ? ' (default)' : ''}`,
    );
    return `Attached data sources:\n${lines.join('\n')}`;
  }, [attachedSources]);

  // Feed the global Copilot pane notebook-persona context so its suggested
  // prompts reference the real attached lakehouses + active language.
  useEffect(() => {
    setCopilotContext({
      persona: 'notebook',
      attachedSourceNames: attachedSources.map((a) => a.displayName),
      defaultLang,
    });
  }, [attachedSources, defaultLang]);

  // Auto-pick the first runnable compute for the active workspace type. Also
  // clears a selection that no longer matches after the user flips the toggle
  // (e.g. a Spark pool selected, then switched to Azure ML). Serverless SQL is
  // never auto-picked — it's not for notebooks.
  useEffect(() => {
    const selected = cp.computes.find(c => c.id === computeId);
    if (computeId && selected && !computeMatchesType(selected)) {
      setComputeId('');
      return;
    }
    if (!computeId && cp.computes.length) {
      // In Azure ML mode, prefer the caller's OWN per-user CI (multi-user:
      // everyone lands on THEIR compute), then the bicep default CI
      // (LOOM_AML_DEFAULT_COMPUTE), then the first runnable CI.
      if (workspaceType === 'aml') {
        const own = cp.computes.find(c => c.kind === 'aml-ci' && c.mine);
        if (own) { setComputeId(own.id); return; }
        if (amlDefaultCompute) {
          const def = cp.computes.find(c => c.kind === 'aml-ci' && c.name === amlDefaultCompute);
          if (def) { setComputeId(def.id); return; }
        }
      }
      const first = cp.computes.find(computeMatchesType);
      if (first) setComputeId(first.id);
    }
  }, [cp.computes, computeId, computeMatchesType, workspaceType, amlDefaultCompute]);

  // Pre-warm session on compute selection: if a Synapse Spark compute is picked,
  // immediately POST to /run with no code to initialize the Livy session in the
  // background. This amortizes the 60-90s cold-start across the idle time before
  // the user's first cell run. It MUST send the same effective sizing the real
  // run will (via sessionConfigBody) so the prewarmed session's sizingKey matches
  // — otherwise the first real cell run cold-starts a SECOND session and orphans
  // this one (R3 #1).
  const prewarmSession = useCallback(async (cId: string) => {
    if (!workspaceId || !notebookId || !cId.startsWith('spark:')) return;
    try {
      await clientFetch(`/api/items/notebook/${encodeURIComponent(notebookId)}/run?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ compute: cId, cellId: '__prewarm__', ...sessionConfigBody() }),
      }).catch(() => { /* silent — warmup is best-effort */ });
    } catch { /* ignore */ }
  }, [workspaceId, notebookId, sessionConfigBody]);

  useEffect(() => {
    if (computeId && workspaceId && notebookId) {
      const debounce = setTimeout(() => prewarmSession(computeId), 500);
      return () => clearTimeout(debounce);
    }
  }, [computeId, workspaceId, notebookId, prewarmSession]);

  // Start a terminated compute (Databricks cluster / Synapse dedicated pool) right
  // from the notebook, then poll its state to RUNNING. Backend already exists:
  // POST /api/loom/compute-targets/{id}/start. This is what makes a cluster that
  // "just shows TERMINATED" usable, and warms it so cells run at native speed
  // instead of cold-starting on every run.
  const [startingCompute, setStartingCompute] = useState(false);
  const selectedCompute = cp.computes.find(c => c.id === computeId) || null;
  // Open the collapsed setup once if compute finished loading with nothing
  // selected, so a new notebook still surfaces the picker. Ref-guarded so a
  // user who deliberately collapses it isn't fought on the next render.
  useEffect(() => {
    if (!cp.loading && !computeId && !autoOpenedSetupRef.current) {
      autoOpenedSetupRef.current = true;
      setSetupOpen(true);
    }
  }, [cp.loading, computeId]);
  // Runtime derived from the attached compute. Drives cluster-aware IntelliSense
  // (dbutils vs mssparkutils vs azure.ai.ml) + Copilot grounding. Defaults to
  // Synapse Spark (the validated Livy path) when nothing is selected yet.
  const clusterRuntime: ClusterRuntime = runtimeFromComputeKind(selectedCompute?.kind);

  // Warm Spark session-pool indicator. Honest about whether the next run gets a
  // pre-warmed session (⚡ instant) or will cold-start the Synapse Spark pool
  // (~2 min). Polls the pool BFF; only meaningful for a Synapse Spark compute
  // (computeId `spark:<pool>`). Silent when the pool is disabled or the backend
  // isn't Spark — never implies capability that isn't there.
  const [warmPool, setWarmPool] = useState<{ enabled: boolean; warmForPool: boolean } | null>(null);
  const sparkPoolName = computeId.startsWith('spark:') ? computeId.slice('spark:'.length) : '';
  // Pre-warm on notebook LOAD (R3): ACA can idle the Console to zero, so the
  // warm pool is empty until something asks for it. Fire a best-effort warm the
  // moment a Spark notebook opens, so a session is warming while the user writes
  // their first cell — instead of paying the ~2 min cold start on first run. One
  // shot per attached pool; the server no-ops when the pool is disabled or the
  // Spark backend isn't configured (default-ON, opt-out via LOOM_SPARK_POOL).
  useEffect(() => {
    if (!sparkPoolName) return;
    void clientFetch('/api/spark/session-pool', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'warm', backend: 'synapse', poolName: sparkPoolName, kind: 'pyspark' }),
    }).catch(() => { /* best-effort — first run still cold-starts if this fails */ });
  }, [sparkPoolName]);
  useEffect(() => {
    if (!sparkPoolName) { setWarmPool(null); return; }
    let cancelled = false;
    const load = async () => {
      try {
        const r = await clientFetch('/api/spark/session-pool');
        const j = await r.json();
        if (cancelled || !j?.ok) return;
        const st = j.status;
        const warm = Array.isArray(st?.groups)
          ? st.groups.some((gp: any) => gp?.poolName === sparkPoolName && gp?.warm > 0)
          : false;
        setWarmPool({ enabled: !!st?.enabled, warmForPool: warm });
      } catch { /* silent — indicator is best-effort */ }
    };
    load();
    const t = setInterval(load, 15000);
    return () => { cancelled = true; clearInterval(t); };
  }, [sparkPoolName, running]);
  const startCompute = useCallback(async () => {
    if (!computeId) return;
    setStartingCompute(true); setRunMsg('Starting compute…');
    try {
      // AML Compute Instances start via the AML route; Spark/Databricks via the
      // generic compute-targets verb route. computeId is `aml-ci:<name>`.
      const isAmlCi = computeId.startsWith('aml-ci:');
      const startUrl = isAmlCi
        ? `/api/aml/compute-instances/${encodeURIComponent(computeId.slice('aml-ci:'.length))}/start`
        : `/api/loom/compute-targets/${encodeURIComponent(computeId)}/start`;
      const r = await fetch(startUrl, { method: 'POST' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j?.ok === false) {
        setRunMsg(`Could not start compute: ${j?.error || j?.hint || `HTTP ${r.status}`}`);
        return;
      }
      // Poll state until it reports running (cluster/CI start is ~60-90s+).
      const startedAt = Date.now();
      while (Date.now() - startedAt < 8 * 60 * 1000) {
        await new Promise(res => setTimeout(res, 5000));
        await cp.refresh();
        const cur = cp.computes.find(c => c.id === computeId);
        if (isComputeRunning(cur?.state)) { setRunMsg('Compute is running — cells will execute at full speed.'); break; }
        setRunMsg(`Starting compute… (${cur?.state || 'pending'})`);
      }
    } catch (e: any) {
      setRunMsg(`Could not start compute: ${e?.message || String(e)}`);
    } finally { setStartingCompute(false); }
  }, [computeId, cp]);

  // ---- AML Compute Instance lifecycle (Azure ML path only) ----
  // Stop a running CI right from the notebook so it stops billing. Mirrors
  // startCompute's poll-to-state. computeId is `aml-ci:<name>`.
  const [stoppingCompute, setStoppingCompute] = useState(false);
  const stopComputeCi = useCallback(async () => {
    if (!computeId.startsWith('aml-ci:')) return;
    const ciName = computeId.slice('aml-ci:'.length);
    setStoppingCompute(true); setRunMsg('Stopping compute…');
    try {
      const r = await clientFetch(`/api/aml/compute-instances/${encodeURIComponent(ciName)}/stop`, { method: 'POST' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j?.ok === false) {
        setRunMsg(`Could not stop compute: ${j?.error || j?.hint || `HTTP ${r.status}`}`);
        return;
      }
      const startedAt = Date.now();
      while (Date.now() - startedAt < 5 * 60 * 1000) {
        await new Promise(res => setTimeout(res, 5000));
        await cp.refresh();
        const cur = cp.computes.find(c => c.id === computeId);
        if (cur && isCiStopped(cur.state)) { setRunMsg('Compute stopped.'); break; }
        setRunMsg(`Stopping compute… (${cur?.state || 'pending'})`);
      }
    } catch (e: any) {
      setRunMsg(`Could not stop compute: ${e?.message || String(e)}`);
    } finally { setStoppingCompute(false); }
  }, [computeId, cp]);

  // Configure compute — idle auto-shutdown TTL dialog (POST .../idle-shutdown).
  const [configCiOpen, setConfigCiOpen] = useState(false);
  const [configCiTtl, setConfigCiTtl] = useState('PT30M');
  const [configCiBusy, setConfigCiBusy] = useState(false);
  const [configCiErr, setConfigCiErr] = useState<string | null>(null);
  const saveCiIdleShutdown = useCallback(async () => {
    if (!computeId.startsWith('aml-ci:')) return;
    const ciName = computeId.slice('aml-ci:'.length);
    setConfigCiBusy(true); setConfigCiErr(null);
    try {
      const r = await clientFetch(`/api/aml/compute-instances/${encodeURIComponent(ciName)}/idle-shutdown`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ idleTtl: configCiTtl }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j?.ok === false) {
        setConfigCiErr(j?.error || j?.hint || `HTTP ${r.status}`);
        return;
      }
      setConfigCiOpen(false);
      setRunMsg(`Idle shutdown set to ${TTL_LABEL[configCiTtl] || configCiTtl}.`);
      void cp.refresh();
    } catch (e: any) {
      setConfigCiErr(e?.message || String(e));
    } finally { setConfigCiBusy(false); }
  }, [computeId, configCiTtl, cp]);

  // New Compute Instance — create dialog (name + VM size + idle TTL), then
  // refresh the compute list and select the freshly-created CI.
  const [newCiOpen, setNewCiOpen] = useState(false);
  const [newCiName, setNewCiName] = useState('');
  const [newCiVmSize, setNewCiVmSize] = useState(AML_CI_VM_SIZES[0].value);
  const [newCiTtl, setNewCiTtl] = useState('PT30M');
  const [newCiBusy, setNewCiBusy] = useState(false);
  const [newCiErr, setNewCiErr] = useState<string | null>(null);
  const createCiInstance = useCallback(async () => {
    const name = newCiName.trim();
    if (!name) return;
    setNewCiBusy(true); setNewCiErr(null);
    try {
      const r = await clientFetch('/api/aml/compute-instances', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, vmSize: newCiVmSize, idleTtl: newCiTtl }),
      });
      const j = await r.json().catch(() => ({}));
      if ((!r.ok && r.status !== 202) || j?.ok === false) {
        setNewCiErr(j?.error || j?.hint || `HTTP ${r.status}`);
        return;
      }
      setNewCiOpen(false);
      setNewCiName('');
      await cp.refresh();
      setComputeId(`aml-ci:${name}`);
      setRunMsg(`Compute Instance "${name}" is being created — it appears as Creating, then Running.`);
    } catch (e: any) {
      setNewCiErr(e?.message || String(e));
    } finally { setNewCiBusy(false); }
  }, [newCiName, newCiVmSize, newCiTtl, cp]);

  // Provision (or attach) the caller's OWN per-user Compute Instance. This is
  // what makes notebooks genuinely multi-user: a CI is single-user, so each user
  // runs on a CI assigned to THEM (assignedUser = their AAD oid). One click →
  // POST /api/aml/compute-instances/mine → the deterministic ci-loom-<oid> CI is
  // created (or the existing one re-attached), then selected. Honest quota gate
  // surfaces when the tenant per-user limit is hit.
  const [provisioningMyCi, setProvisioningMyCi] = useState(false);
  const [myCiErr, setMyCiErr] = useState<string | null>(null);
  const provisionMyCi = useCallback(async () => {
    setProvisioningMyCi(true); setMyCiErr(null); setRunMsg('Provisioning your compute instance…');
    try {
      const r = await clientFetch('/api/aml/compute-instances/mine', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      const j = await r.json().catch(() => ({}));
      if ((!r.ok && r.status !== 202) || j?.ok === false) {
        setMyCiErr(j?.error || j?.hint || `HTTP ${r.status}`);
        setRunMsg(null);
        return;
      }
      const name: string | undefined = j?.name || j?.mine?.name;
      await Promise.all([cp.refresh(), myCi.refresh()]);
      if (name) setComputeId(`aml-ci:${name}`);
      setRunMsg(
        j?.reused
          ? `Attached your compute instance "${name}".`
          : `Your compute instance "${name}" is being created — it appears as Creating, then Running.`,
      );
    } catch (e: any) {
      setMyCiErr(e?.message || String(e));
      setRunMsg(null);
    } finally { setProvisioningMyCi(false); }
  }, [cp, myCi]);

  // Auto-start a stopped AML Compute Instance when it's selected in AML mode.
  // Debounced 1.5s so flipping through the picker doesn't fire a start per
  // option. Tracks the last CI we kicked so we don't re-POST every refresh.
  const autoStartedRef = useRef<string | null>(null);
  useEffect(() => {
    if (workspaceType !== 'aml' || !computeId.startsWith('aml-ci:')) return;
    if (!selectedCompute || !isCiStopped(selectedCompute.state)) return;
    if (autoStartedRef.current === computeId) return;
    const t = setTimeout(() => {
      autoStartedRef.current = computeId;
      void startCompute();
    }, 1500);
    return () => clearTimeout(t);
  }, [workspaceType, computeId, selectedCompute, startCompute]);

  // v3.28: honor URL deep-link — when /items/notebook/{id} loads, discover
  // the owning workspace from the Cosmos record and auto-select it so the
  // cells actually render. Previously workspaceId stayed empty until the
  // user manually picked from the dropdown, leaving the editor blank.
  useEffect(() => {
    if (id === 'new' || !id || workspaceId || notebookId) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await clientFetch(`/api/cosmos-items/notebook/${encodeURIComponent(id)}`);
        if (!r.ok) return;
        const j = await r.json();
        if (cancelled) return;
        if (j?.workspaceId) {
          setWorkspaceId(j.workspaceId);
          setNotebookId(id);
        }
      } catch { /* ignore — user can still pick manually */ }
    })();
    return () => { cancelled = true; };
  }, [id, workspaceId, notebookId]);

  // Pick up Lakehouse "Open in notebook" prefill (stored in localStorage before route push).
  useEffect(() => {
    if (typeof window === 'undefined' || id !== 'new') return;
    try {
      const raw = localStorage.getItem('loom.notebook.prefill');
      if (!raw) return;
      const data = JSON.parse(raw);
      if (data?.code) {
        setCells([{ ...emptyCell('code', 'pyspark'), source: data.code }]);
        setPrefill({ source: data.source, container: data.container, path: data.path });
        setCreateName(`From ${data.path?.split('/').pop()?.replace(/\.[^.]+$/, '') || 'lakehouse'}`);
        setCreateOpen(true);
      }
      localStorage.removeItem('loom.notebook.prefill');
    } catch { /* ignore */ }
  }, [id]);

  const loadList = useCallback(async (wsId: string) => {
    setListErr(null); setListHint(null);
    try {
      const r = await clientFetch(`/api/items/notebook?workspaceId=${encodeURIComponent(wsId)}`);
      const j = await r.json();
      if (!j.ok) { setNotebooks([]); setListErr(j.error); setListHint(j.hint); return; }
      setNotebooks(j.notebooks || []);
      if ((j.notebooks || []).length && !notebookId) setNotebookId(j.notebooks[0].id);
    } catch (e: any) { setNotebooks([]); setListErr(e?.message || String(e)); }
  }, [notebookId]);

  const loadDetail = useCallback(async (wsId: string, nbId: string) => {
    setDetailErr(null); setRunMsg(null);
    // Mark the active notebook so any resume loop from a PRIOR notebook stops
    // patching the wrong cells once the user switches (R3 #4).
    currentNbRef.current = nbId;
    try {
      const r = await clientFetch(`/api/items/notebook/${encodeURIComponent(nbId)}?workspaceId=${encodeURIComponent(wsId)}`);
      const j = await r.json();
      if (!j.ok) { setDetailErr(j.error); return; }
      // v3.26: cell-based shape. Falls back through legacy `code` then Fabric `parts[]`.
      if (Array.isArray(j.definition?.cells) && j.definition.cells.length > 0) {
        setCells(j.definition.cells);
        setDefaultLang((j.definition.defaultLang as NotebookCellLang) || 'pyspark');
      } else if (j.definition?.code !== undefined) {
        const lang = (j.definition.lang as NotebookCellLang) || 'pyspark';
        setCells(migrateLegacyState({ code: j.definition.code || STARTER_PY, lang }).cells);
        setDefaultLang(lang);
      } else {
        const part = j.definition?.parts?.find((p: any) => /notebook-content\.(py|sql|scala|r)$/.test(p.path));
        const code = part?.payload ? decodePy(part.payload) : STARTER_PY;
        setCells(migrateLegacyState({ code }).cells);
        setDefaultLang('pyspark');
      }
      // Phase 2: attached data sources.
      setAttachedSources(Array.isArray(j.definition?.attachedSources) ? j.definition.attachedSources : []);
      // Library & Environment: attached AML env + custom libraries.
      setAttachedAmlEnv(j.definition?.attachedAmlEnv || null);
      setCustomLibraries(Array.isArray(j.definition?.customLibraries) ? j.definition.customLibraries : []);
      // R4-NB-3 resource files bundled with the notebook.
      setResources(Array.isArray(j.definition?.resources) ? j.definition.resources : []);
      // Session sizing config (Configure session dialog). Defaults when unset.
      setSessionCfg(j.definition?.sessionConfig
        ? normalizeSessionConfig(j.definition.sessionConfig)
        : DEFAULT_SESSION_CONFIG);
      setDirty(false);
      // R3 #4 — hand any in-flight runs the server still tracks to the resume
      // effect (defined after the poll helper). It re-attaches the poll loop so
      // navigating away + back no longer strands cells blank while the statement
      // finishes on Livy.
      setPendingResume(
        j.pendingRuns && typeof j.pendingRuns === 'object' && Object.keys(j.pendingRuns).length
          ? j.pendingRuns
          : null,
      );
    } catch (e: any) { setDetailErr(e?.message || String(e)); }
  }, []);

  const loadJobs = useCallback(async (wsId: string, nbId: string) => {
    try {
      const r = await clientFetch(`/api/items/notebook/${encodeURIComponent(nbId)}/jobs?workspaceId=${encodeURIComponent(wsId)}`);
      const j = await r.json();
      if (j.ok) setJobs(j.jobs || []);
    } catch { /* keep last */ }
  }, []);

  useEffect(() => { if (workspaceId) loadList(workspaceId); }, [workspaceId, loadList]);
  useEffect(() => {
    if (workspaceId && notebookId) { loadDetail(workspaceId, notebookId); loadJobs(workspaceId, notebookId); }
  }, [workspaceId, notebookId, loadDetail, loadJobs]);

  // ---- Notebooks-pane folders: load + ops (real Cosmos folders engine) ----
  const loadFolders = useCallback(async (wsId: string) => {
    try { setFolders(await listFolders(wsId)); }
    catch { setFolders([]); /* folders are optional — pane still lists notebooks */ }
  }, []);
  useEffect(() => { if (workspaceId) loadFolders(workspaceId); else setFolders([]); }, [workspaceId, loadFolders]);

  const refreshNbPane = useCallback(() => {
    if (!workspaceId) return;
    void loadList(workspaceId);
    void loadFolders(workspaceId);
  }, [workspaceId, loadList, loadFolders]);

  const nbTree = useMemo(() => buildTree(folders, notebooks ?? [], nbSort), [folders, notebooks, nbSort]);

  function openNbCreateFolder(parent: string | null) { setNbFolderDialog({ mode: 'create', parent }); setNbFolderName(''); }
  async function submitNbFolderDialog() {
    if (!nbFolderDialog || !workspaceId) return;
    const name = nbFolderName.trim();
    if (!name) return;
    setNbFolderBusy(true); setNbFolderErr(null);
    try {
      if (nbFolderDialog.mode === 'create') await createFolder(workspaceId, { name, parent: nbFolderDialog.parent });
      else await renameFolder(workspaceId, nbFolderDialog.folderId, name);
      setNbFolderDialog(null);
      await loadFolders(workspaceId);
    } catch (e: any) { setNbFolderErr(e?.message || String(e)); }
    finally { setNbFolderBusy(false); }
  }
  async function deleteNbFolder(folderId: string) {
    if (!workspaceId) return;
    setNbFolderBusy(true); setNbFolderErr(null);
    try { await deleteFolder(workspaceId, folderId); refreshNbPane(); }
    catch (e: any) { setNbFolderErr(e?.message || String(e)); }
    finally { setNbFolderBusy(false); }
  }
  async function moveNbToFolder(nbId: string, folderId: string | null) {
    if (!workspaceId) return;
    setNbFolderBusy(true); setNbFolderErr(null);
    try { await patchWorkspaceItem(workspaceId, nbId, { folderId }); refreshNbPane(); }
    catch (e: any) { setNbFolderErr(e?.message || String(e)); }
    finally { setNbFolderBusy(false); }
  }

  // HTML5 drag-drop: drag a notebook leaf onto a folder branch (or the root
  // drop strip) to re-file it — same affordance as the workspace folders pane.
  function onNbDragStart(e: React.DragEvent, nbId: string) {
    e.dataTransfer.setData('text/plain', `nb:${nbId}`);
    e.dataTransfer.effectAllowed = 'move';
    setNbDragId(nbId);
  }
  function onNbFolderDragOver(e: React.DragEvent, target: string | 'root') {
    if (!nbDragId) return;
    e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setNbDropTarget(target);
  }
  async function onNbFolderDrop(e: React.DragEvent, folderId: string | null) {
    e.preventDefault();
    const data = e.dataTransfer.getData('text/plain');
    const dragged = nbDragId;
    setNbDropTarget(null); setNbDragId(null);
    const nbId = data?.startsWith('nb:') ? data.slice('nb:'.length) : dragged;
    if (!nbId) return;
    const nb = (notebooks || []).find((n) => n.id === nbId);
    if (!nb || (nb.folderId || null) === folderId) return;
    await moveNbToFolder(nbId, folderId);
  }

  // Recursive renderers — branch(folder) + leaf(notebook). Leaf click is an
  // in-editor selection (setNotebookId), NOT a navigation.
  const renderNbLeaf = (n: NotebookLite) => (
    <Menu key={n.id} openOnContext>
      <MenuTrigger disableButtonEnhancement>
        <TreeItem itemType="leaf" value={`nb:${n.id}`}>
          <TreeItemLayout
            iconBefore={<Notebook20Regular />}
            onClick={() => setNotebookId(n.id)}
            {...{ draggable: true, onDragStart: (e: React.DragEvent) => onNbDragStart(e, n.id) } as any}
          >
            {notebookId === n.id ? <strong>{n.displayName}</strong> : n.displayName}
          </TreeItemLayout>
        </TreeItem>
      </MenuTrigger>
      <MenuPopover>
        <MenuList>
          <MenuItem onClick={() => setNotebookId(n.id)}>Open</MenuItem>
          <MenuItem onClick={() => setNbMoveTarget(n)}>Move to folder…</MenuItem>
        </MenuList>
      </MenuPopover>
    </Menu>
  );

  const renderNbFolder = (node: FolderNode<NotebookLite>): React.JSX.Element | null => {
    if (!node.folder) return null;
    const f = node.folder;
    const count = countDescendants(node);
    const isExpanded = nbExpanded.has(f.id);
    const isDrop = nbDropTarget === f.id;
    return (
      <Menu key={f.id} openOnContext>
        <MenuTrigger disableButtonEnhancement>
          <TreeItem
            itemType="branch"
            value={`folder:${f.id}`}
            open={isExpanded}
            onOpenChange={(_e, d) => setNbExpanded((prev) => {
              const nx = new Set(prev); if (d.open) nx.add(f.id); else nx.delete(f.id); return nx;
            })}
          >
            <TreeItemLayout
              iconBefore={<Folder20Filled style={{ color: 'var(--loom-accent-gold)' }} />}
              className={isDrop ? s.nbDragOver : undefined}
              {...{
                onDragOver: (e: React.DragEvent) => onNbFolderDragOver(e, f.id),
                onDragLeave: () => setNbDropTarget((cur) => (cur === f.id ? null : cur)),
                onDrop: (e: React.DragEvent) => onNbFolderDrop(e, f.id),
              } as any}
            >
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalXS }}>
                <span>{f.name}</span>
                <Badge appearance="tint" color="informative" size="small">{count}</Badge>
              </span>
            </TreeItemLayout>
            {isExpanded && (
              <Tree>
                {node.childFolders.map(renderNbFolder)}
                {node.childItems.map(renderNbLeaf)}
                {count === 0 && (
                  <TreeItem itemType="leaf" value={`folder:${f.id}:empty`}>
                    <TreeItemLayout><Caption1 style={{ color: tokens.colorNeutralForeground3 }}>(empty)</Caption1></TreeItemLayout>
                  </TreeItem>
                )}
              </Tree>
            )}
          </TreeItem>
        </MenuTrigger>
        <MenuPopover>
          <MenuList>
            <MenuItem onClick={() => openNbCreateFolder(f.id)}>New subfolder…</MenuItem>
            <MenuItem onClick={() => { setNbFolderDialog({ mode: 'rename', folderId: f.id, current: f.name }); setNbFolderName(f.name); }}>Rename</MenuItem>
            <MenuItem onClick={() => setNbConfirmFolderDelete(f)}>Delete</MenuItem>
          </MenuList>
        </MenuPopover>
      </Menu>
    );
  };

  // Probe the Pylance/pylsp bridge + VS Code for Web availability for this
  // notebook. Server route reads the gated env (boundary, LOOM_PYLSP_ENABLED,
  // AML instance/workspace) — the client never sees those directly.
  useEffect(() => {
    if (!notebookId) { setLspWsUrl(null); setVscodeWeb({ enabled: false, url: null }); return; }
    let cancelled = false;
    (async () => {
      try {
        const r = await clientFetch(`/api/notebook/${encodeURIComponent(notebookId)}/lsp`);
        const j = await r.json().catch(() => null);
        if (cancelled || !j?.ok) return;
        setLspWsUrl(j.lspAvailable && j.wsUrl ? j.wsUrl : null);
        setVscodeWeb(j.vscodeWeb || { enabled: false, url: null });
      } catch {
        if (!cancelled) { setLspWsUrl(null); setVscodeWeb({ enabled: false, url: null }); }
      }
    })();
    return () => { cancelled = true; };
  }, [notebookId]);

  // Load the AML environment catalog once so the ribbon selector can list real
  // environments. Honest gate: a 503 (no AML workspace) leaves the list empty —
  // the selector shows "No environment attached" and the Manage panel explains.
  const loadAmlEnvs = useCallback(async () => {
    try {
      const r = await clientFetch('/api/aml/environments');
      const j = await r.json();
      if (j.ok && Array.isArray(j.environments)) setAmlEnvs(j.environments);
    } catch { /* selector stays empty; Manage panel surfaces the error */ }
  }, []);
  useEffect(() => { void loadAmlEnvs(); }, [loadAmlEnvs]);

  const save = useCallback(async () => {
    if (!workspaceId || !notebookId) return;
    setSaving(true); setDetailErr(null);
    setRunMsg('Saving notebook…');
    try {
      // Strip per-cell output before persisting — it's runtime-only state
      // and can blow past Cosmos 2MB doc limits when cells return large
      // tables. The execution count stays.
      const cellsForSave = cells.map(c => ({
        ...c,
        output: undefined,
      }));
      const r = await clientFetch(`/api/items/notebook/${encodeURIComponent(notebookId)}?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ definition: { cells: cellsForSave, defaultLang, attachedSources, attachedAmlEnv, customLibraries, resources } }),
      });
      const j = await r.json();
      if (!j.ok) {
        setDetailErr(j.error || 'save failed');
        setRunMsg(`Save failed: ${j.error || 'unknown error'}`);
      } else {
        setDirty(false);
        setRunMsg(`Saved at ${new Date().toLocaleTimeString()}`);
      }
    } catch (e: any) {
      setDetailErr(e?.message || String(e));
      setRunMsg(`Save failed: ${e?.message || e}`);
    } finally { setSaving(false); }
  }, [workspaceId, notebookId, cells, defaultLang, attachedSources, attachedAmlEnv, customLibraries, resources]);

  // Debounced autosave (rel-T70): once the notebook is loaded and the user has
  // made an edit (dirty), persist via the EXISTING save() after ~2.5s of quiet.
  // Guarded to a real, loaded notebook with at least one cell so an empty/
  // unmodified draft is never autosaved.
  const autosaveStatus = useAutosave({
    dirty,
    enabled: !!notebookId && !!workspaceId && cells.length > 0,
    onSave: save,
  });

  // Ctrl+S / Cmd+S to save when there are unsaved changes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (notebookId && workspaceId && dirty && !saving) save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [notebookId, workspaceId, dirty, saving, save]);

  // Phase 2: load lakehouses in the current workspace for the attach modal.
  const loadLakehouses = useCallback(async () => {
    if (!workspaceId) return;
    try {
      const r = await clientFetch(`/api/items/lakehouse?workspaceId=${encodeURIComponent(workspaceId)}`);
      const j = await r.json();
      if (j.ok && Array.isArray(j.items)) {
        setAvailableLakehouses(j.items.map((x: any) => ({ id: x.id, displayName: x.displayName, description: x.description })));
      } else if (j.ok && Array.isArray(j.lakehouses)) {
        setAvailableLakehouses(j.lakehouses);
      } else {
        setAvailableLakehouses([]);
      }
    } catch { setAvailableLakehouses([]); }
  }, [workspaceId]);

  const openAttach = useCallback(() => {
    setAttachOpen(true);
    if (availableLakehouses === null) loadLakehouses();
  }, [availableLakehouses, loadLakehouses]);

  // Issue #655: resolve the abfss root for each attached lakehouse so the Data
  // items list shows the real path (and an honest gate when unresolvable). The
  // SAME resolution the run route's auto-mount preamble uses.
  useEffect(() => {
    if (!workspaceId) return;
    const lakehouses = attachedSources.filter((s) => s.kind === 'lakehouse');
    if (lakehouses.length === 0) return;
    let cancelled = false;
    (async () => {
      for (const lh of lakehouses) {
        if (resolvedPaths[lh.id]) continue; // already resolved this id
        try {
          const r = await clientFetch(`/api/items/lakehouse/${encodeURIComponent(lh.id)}/abfss?workspaceId=${encodeURIComponent(workspaceId)}`);
          const j = await r.json().catch(() => ({}));
          if (cancelled) return;
          if (j?.ok && j.resolved && j.abfss) {
            setResolvedPaths((prev) => ({ ...prev, [lh.id]: { abfss: j.abfss } }));
          } else if (j?.ok) {
            setResolvedPaths((prev) => ({ ...prev, [lh.id]: { hint: j.hint || 'Path not resolved.' } }));
          }
        } catch { /* leave unresolved — chip shows neither path nor false gate */ }
      }
    })();
    return () => { cancelled = true; };
  }, [attachedSources, workspaceId, resolvedPaths]);

  /**
   * Persist the attached-sources list IMMEDIATELY, with the explicit next
   * array (not the closed-over state, which is one render stale). The operator
   * reported attachments "aren't persistent" — that was because attach/detach
   * only mutated local state and required a manual Save / Ctrl-S. Auto-saving
   * here means a re-open / reload keeps the attachments. Cells are saved too
   * (output stripped) so we don't clobber in-progress edits with a half doc.
   */
  const persistSources = useCallback(async (next: AttachedSource[]) => {
    if (!workspaceId || !notebookId) return;
    try {
      const cellsForSave = cells.map(c => ({ ...c, output: undefined }));
      const r = await clientFetch(`/api/items/notebook/${encodeURIComponent(notebookId)}?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ definition: { cells: cellsForSave, defaultLang, attachedSources: next } }),
      });
      const j = await r.json();
      if (j.ok) { setDirty(false); setRunMsg(`Data sources saved at ${new Date().toLocaleTimeString()}`); }
      else { setRunMsg(`Could not save data sources: ${j.error || 'unknown'} — use Save to retry`); }
    } catch (e: any) {
      setRunMsg(`Could not save data sources: ${e?.message || e} — use Save to retry`);
    }
  }, [workspaceId, notebookId, cells, defaultLang]);

  const attachLakehouse = useCallback((lh: LakehouseLite) => {
    if (attachedSources.some(s => s.kind === 'lakehouse' && s.id === lh.id)) return;
    const next: AttachedSource[] = [
      ...attachedSources,
      { kind: 'lakehouse', id: lh.id, displayName: lh.displayName, isDefault: attachedSources.length === 0 },
    ];
    setAttachedSources(next);
    void persistSources(next);   // auto-persist so the attachment survives reload
  }, [attachedSources, persistSources]);

  const detachSource = useCallback((srcId: string) => {
    const next = attachedSources.filter(s => s.id !== srcId);
    setAttachedSources(next);
    void persistSources(next);
  }, [attachedSources, persistSources]);

  const promoteDefault = useCallback((srcId: string) => {
    const next = attachedSources.map(s => ({ ...s, isDefault: s.id === srcId }));
    setAttachedSources(next);
    void persistSources(next);
  }, [attachedSources, persistSources]);

  // Open the Configure-session dialog seeded with the current sizing.
  const openConfigDialog = useCallback(() => {
    setCfgDraft(sessionCfg);
    setCfgDialogOpen(true);
  }, [sessionCfg]);

  // Apply + persist the session sizing. Saves only the sessionConfig slice
  // (the PUT route handles it independently of cells, so this never clobbers
  // in-progress edits). The next run re-sizes the Livy session because the
  // run route recreates the session when the requested sizing changes.
  const applySessionConfig = useCallback(async () => {
    const next = normalizeSessionConfig(cfgDraft);
    setSessionCfg(next);
    setCfgDialogOpen(false);
    if (!workspaceId || !notebookId) return; // unsaved 'new' notebook — keep in memory
    if (sessionConfigEquals(next, sessionCfg)) return;
    setCfgSaving(true);
    try {
      const r = await clientFetch(`/api/items/notebook/${encodeURIComponent(notebookId)}?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ definition: { sessionConfig: next } }),
      });
      const j = await r.json();
      if (j.ok) {
        if (j.definition?.sessionConfig) setSessionCfg(normalizeSessionConfig(j.definition.sessionConfig));
        setRunMsg(`Session configured: ${next.numExecutors} executors · ${next.executorMemoryGb} GB · ${next.timeoutMinutes} min timeout. Re-sizes on next run.`);
      } else {
        setRunMsg(`Could not save session config: ${j.error || 'unknown'}`);
      }
    } catch (e: any) {
      setRunMsg(`Could not save session config: ${e?.message || e}`);
    } finally { setCfgSaving(false); }
  }, [cfgDraft, sessionCfg, workspaceId, notebookId]);

  // Poll a run's status with a small backoff retry so a transient network blip
  // mid-poll doesn't silently kill the loop and strand a cell on a spinner
  // (R3 #3). Throws after 3 failed attempts so the caller can surface an honest
  // error. Terminal Livy statement/session states the caller must treat as done.
  const pollRunStatus = useCallback(async (runId: string): Promise<any> => {
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await clientFetch(
          `/api/items/notebook/${encodeURIComponent(notebookId!)}/runs/${encodeURIComponent(runId)}?workspaceId=${encodeURIComponent(workspaceId!)}`,
        );
        return await res.json();
      } catch (e) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }, [notebookId, workspaceId]);

  // R3 #4 — resume in-flight runs the server still tracks (state.pendingRuns).
  // On mount / notebook-switch, for each persisted Spark run: mark its cells
  // running (restoring any already-accumulated per-cell outputs), then re-attach
  // the SAME poll loop a live run uses (follow the promoted runId, patch each
  // cell's output as its statement completes). A stale entry (session recycled)
  // resolves on the first poll: the server maps it to an honest SessionGone /
  // terminal error and cleans the entry, and we render that on the cells.
  const resumePendingRuns = useCallback(async (pendingRuns: Record<string, any> | null | undefined) => {
    if (!pendingRuns || !workspaceId || !notebookId) return;
    const nbId = notebookId;
    for (const [baseKey, entry] of Object.entries(pendingRuns)) {
      // Only Synapse Spark runs persist a resumable entry; skip anything already
      // picked up (strict-mode double-mount + repeated loadDetail).
      if (!baseKey.startsWith('spark:') || !entry || typeof entry !== 'object') continue;
      const guardKey = `${nbId}:${baseKey}`;
      if (resumedRunsRef.current.has(guardKey)) continue;
      resumedRunsRef.current.add(guardKey);

      const queue: Array<{ cellId?: string }> = Array.isArray(entry.queue) ? entry.queue : [];
      const affectedIds = new Set<string>();
      queue.forEach((q) => { if (q?.cellId) affectedIds.add(q.cellId); });
      if (typeof entry.cellId === 'string') affectedIds.add(entry.cellId);
      const appliedCells = new Set<string>();
      const applyCellOutputs = (map: Record<string, any> | undefined | null) => {
        if (!map || typeof map !== 'object') return;
        for (const [cid, o] of Object.entries(map)) {
          if (!o || appliedCells.has(cid)) continue;
          appliedCells.add(cid);
          patchCell(cid, {
            output: {
              status: (o as any).status === 'ok' ? 'ok' : 'error',
              textPlain: (o as any).textPlain,
              data: (o as any).data,
              richDisplay: (o as any).richDisplay,
              ename: (o as any).ename,
              evalue: (o as any).evalue,
              traceback: (o as any).traceback,
              executedAtUtc: new Date().toISOString(),
            },
          });
        }
      };
      const markRemaining = (evalue: string, ename = 'Incomplete') => {
        affectedIds.forEach((id) => {
          if (appliedCells.has(id)) return;
          appliedCells.add(id);
          patchCell(id, { output: { status: 'error', ename, evalue } });
        });
      };
      // Restore already-finished cells (server-persisted cellOutputs), then spin
      // the rest so the user immediately sees the run is still live.
      applyCellOutputs(entry.cellOutputs);
      affectedIds.forEach((id) => { if (!appliedCells.has(id)) patchCell(id, { output: { status: 'pending' } }); });

      setRunMsg('Reconnecting to an in-flight run…');
      setSessionStatus('Running');
      void (async () => {
        // Resume from the exact in-flight statement (persisted by the poll route)
        // so we don't re-submit already-run cells; fall back to the base key
        // (session still starting, no statement submitted yet).
        let runId: string = typeof entry.lastRunId === 'string' ? entry.lastRunId : baseKey;
        const start = Date.now();
        const MAX_MS = 12 * 60 * 1000;
        let pollInterval = 1000;
        let endState: 'ok' | 'error' | undefined;
        while (Date.now() - start < MAX_MS) {
          if (currentNbRef.current !== nbId) return; // user switched notebooks — stop
          await new Promise((res) => setTimeout(res, pollInterval));
          let p: any;
          try {
            p = await pollRunStatus(runId);
          } catch (e: any) {
            markRemaining(`Lost contact with the resumed run: ${e?.message || e}. Re-run the cell.`, 'PollError');
            setSessionStatus('Error'); endState = 'error'; break;
          }
          if (!p.ok) {
            markRemaining(`Resumed run ended: ${p.error || 'unknown error'}`, 'PollError');
            setSessionStatus('Error'); endState = 'error'; break;
          }
          if (p.runId && p.runId !== runId) runId = p.runId;
          applyCellOutputs(p.cellOutputs);
          const cold = p.phase === 'session-starting' || /^(starting|pending|queued)$/i.test(String(p.status || ''));
          pollInterval = cold ? 2000 : 700;
          if (p.output) {
            // Single-cell resume (or a run whose final statement carries the only
            // output) — attribute the terminal output to the sole affected cell.
            if (!p.cellOutputs && affectedIds.size === 1) {
              const only = [...affectedIds][0];
              if (!appliedCells.has(only)) {
                appliedCells.add(only);
                patchCell(only, {
                  output: {
                    status: p.output.status === 'ok' ? 'ok' : 'error',
                    textPlain: p.output.textPlain, data: p.output.data, richDisplay: p.output.richDisplay,
                    ename: p.output.ename, evalue: p.output.evalue, traceback: p.output.traceback,
                    executedAtUtc: new Date().toISOString(),
                  },
                });
              }
            }
            endState = p.output.status === 'ok' ? 'ok' : 'error';
            setSessionStatus(endState === 'ok' ? 'Idle' : 'Error');
            if (endState === 'error') markRemaining('An earlier cell failed — this cell did not run.');
            break;
          }
          if (['error', 'dead', 'killed', 'shutting_down', 'cancelled', 'cancelling', 'TERMINATED', 'INTERNAL_ERROR'].includes(p.status)) {
            markRemaining(`Resumed run ended in state '${p.status}'.`, p.status);
            setSessionStatus('Error'); endState = 'error'; break;
          }
        }
        if (endState === undefined) {
          const mins = Math.round(MAX_MS / 60000);
          markRemaining(`Resumed run timed out after ${mins}m — the session may have been recycled. Re-run the cell.`, 'Timeout');
          setSessionStatus('Error');
        } else if (endState === 'ok') {
          // Clear any cell still spinning (an attribution gap) with an honest empty.
          affectedIds.forEach((id) => {
            if (appliedCells.has(id)) return;
            appliedCells.add(id);
            patchCell(id, { output: { status: 'ok', textPlain: '(no output)' } });
          });
          setRunMsg('✓ Reconnected run completed');
        }
        loadJobs(workspaceId, nbId);
      })();
    }
  }, [workspaceId, notebookId, patchCell, pollRunStatus, loadJobs]);

  // Fire resume once loadDetail has handed over the server's pendingRuns.
  useEffect(() => {
    if (pendingResume && workspaceId && notebookId) {
      void resumePendingRuns(pendingResume);
      setPendingResume(null);
    }
  }, [pendingResume, workspaceId, notebookId, resumePendingRuns]);

  const run = useCallback(async () => {
    if (!workspaceId || !notebookId) return;
    if (!computeId) {
      setRunMsg('Pick a compute target before running.');
      return;
    }
    setRunning(true);
    setSessionStatus('Running');
    setRunMsg('Submitting run…');
    // Runnable cells = the code cells the server will actually queue (non-empty).
    // Mark each pending so the user sees per-cell progress, and track which have
    // received output so none is left on an eternal spinner (R3 #2/#3).
    const runnableCellIds = cells.filter((c) => c.type === 'code' && c.source.trim()).map((c) => c.id);
    const runStartNow = Date.now();
    runnableCellIds.forEach((id) => { patchCell(id, { output: { status: 'pending' } }); cellRunStartRef.current.set(id, runStartNow); });
    const appliedCells = new Set<string>();
    const applyCellOutputs = (map: Record<string, any> | undefined | null) => {
      if (!map || typeof map !== 'object') return;
      for (const [cid, o] of Object.entries(map)) {
        if (!o || appliedCells.has(cid)) continue;
        appliedCells.add(cid);
        patchCell(cid, {
          output: {
            status: (o as any).status === 'ok' ? 'ok' : 'error',
            textPlain: (o as any).textPlain,
            data: (o as any).data,
            richDisplay: (o as any).richDisplay,
            ename: (o as any).ename,
            evalue: (o as any).evalue,
            traceback: (o as any).traceback,
            executedAtUtc: new Date().toISOString(),
            durationMs: cellDurationMs(cid),
          },
        });
      }
    };
    const markRemainingError = (evalue: string) => {
      runnableCellIds.forEach((id) => {
        if (appliedCells.has(id)) return;
        appliedCells.add(id);
        patchCell(id, { output: { status: 'error', ename: 'Incomplete', evalue } });
      });
    };
    try {
      const r = await clientFetch(`/api/items/notebook/${encodeURIComponent(notebookId)}/run?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ compute: computeId, ...sessionConfigBody() }),
      });
      const j = await r.json();
      if (!j.ok) {
        setRunMsg(`Run failed: ${j.error}${j.hint ? ' — ' + j.hint : ''}`);
        markRemainingError(`Run failed to submit: ${j.error || 'unknown error'}`);
        setRunning(false);
        setSessionStatus('Error');
        return;
      }
      if (j.session) setSessionReceipt(j.session);

      let runId: string = j.runId;
      setRunMsg(`${j.compute?.kind || 'compute'} ${j.compute?.pool || j.compute?.clusterId || j.compute?.ciName || ''} — ${j.status} (runId ${runId})${j.autoStarted ? ' · auto-started CI' : ''}`);
      const start = Date.now();
      const MAX_MS = 12 * 60 * 1000; // 12 min to allow for slow cold-starts
      // Adaptive polling tuned to feel native: fast while a statement is actually
      // executing on a WARM session (~600ms ≈ Databricks' own refresh cadence),
      // backing off only while a COLD session/cluster is still spinning up so we
      // don't hammer the API during a 60-90s start.
      let pollInterval = 600; // responsive first poll for warm sessions
      let endState: 'ok' | 'error' | undefined;
      while (Date.now() - start < MAX_MS) {
        await new Promise(res => setTimeout(res, pollInterval));
        let p: any;
        try {
          p = await pollRunStatus(runId);
        } catch (e: any) {
          setRunMsg(`Poll error: ${e?.message || e}`);
          setSessionStatus('Error');
          markRemainingError(`Lost contact with the run while polling: ${e?.message || e}. Retry the run.`);
          endState = 'error';
          break;
        }
        if (!p.ok) {
          setRunMsg(`Poll error: ${p.error || 'unknown'}`);
          setSessionStatus('Error');
          markRemainingError(`Run poll failed: ${p.error || 'unknown error'}`);
          endState = 'error';
          break;
        }
        if (p.runId && p.runId !== runId) runId = p.runId; // promotion when statement is submitted
        const phase = p.phase ? ` · ${p.phase}` : '';
        setRunMsg(`Status: ${p.status}${phase}`);
        // R4-NB-4 — real-time Spark progress under whichever cell is still pending.
        setRunPhase(p.phase || p.status || null);
        if (p.progress && typeof p.progress === 'object') {
          // Attribute run-all progress to the cell the poll says is in flight.
          const activeId = runnableCellIds.find((id) => !appliedCells.has(id));
          if (activeId) setCellProgress((prev) => new Map(prev).set(activeId, p.progress as SparkRunProgress));
        }
        // Patch each cell's output the moment its statement completes (R3 #2).
        applyCellOutputs(p.cellOutputs);
        // Stay fast while a statement runs on a warm session; back off to 2s only
        // while a cold session/cluster is still starting (PENDING/starting/queued).
        const cold = p.phase === 'session-starting' || /^(starting|pending|queued)$/i.test(String(p.status || ''));
        pollInterval = cold ? 2000 : 600;
        if (p.output) {
          if (p.output.status === 'ok') {
            setRunMsg('✓ Completed');
            setSessionStatus('Idle');
            endState = 'ok';
          } else if (p.output.status === 'error') {
            setRunMsg(`✗ Error: ${[p.output.ename, p.output.evalue].filter(Boolean).join(' ')}`);
            setSessionStatus('Error');
            markRemainingError('An earlier cell failed — this cell did not run.');
            endState = 'error';
          } else {
            setRunMsg('✓ Completed');
            setSessionStatus('Idle');
            endState = 'ok';
          }
          break;
        }
        // Recognize ALL terminal Livy statement + session states (R3 #3) —
        // cancelled / shutting_down were previously polled until the 12-min
        // timeout, leaving cells blank.
        if (['error', 'dead', 'killed', 'shutting_down', 'cancelled', 'cancelling', 'TERMINATED', 'INTERNAL_ERROR'].includes(p.status)) {
          setRunMsg(`Run ended: ${p.status}${p.resultState ? ` (${p.resultState})` : ''}`);
          setSessionStatus('Error');
          markRemainingError(`Run ended in state '${p.status}'.`);
          endState = 'error';
          break;
        }
      }
      if (endState === undefined) {
        // 12-min timeout with no terminal result — honest error, never a silent
        // blank / eternal spinner (R3 #3).
        const mins = Math.round(MAX_MS / 60000);
        setRunMsg(`Run timed out after ${mins}m — the Spark session may be starting slowly or a statement hung.`);
        setSessionStatus('Error');
        markRemainingError(`Run timed out after ${mins}m — the session may be starting slowly or a statement hung. Retry or Configure session.`);
      } else if (endState === 'ok') {
        // All statements ran OK: clear any cell still showing a spinner (an
        // attribution gap) with an honest empty result rather than a stuck spinner.
        runnableCellIds.forEach((id) => {
          if (appliedCells.has(id)) return;
          appliedCells.add(id);
          patchCell(id, { output: { status: 'ok', textPlain: '(no output)', durationMs: cellDurationMs(id) } });
        });
      }
      loadJobs(workspaceId, notebookId);
    } finally {
      setRunning(false);
      setRunPhase(null);
      setCellProgress(new Map()); cellRunStartRef.current.clear(); // R4-NB-4 cleanup
    }
  }, [workspaceId, notebookId, computeId, cells, patchCell, sessionConfigBody, pollRunStatus, loadJobs, cellDurationMs]);

  // Always-fresh ref to run() so a parameterized run fires the LATEST closure
  // after we inject the override cell + re-render (R4-NB-2).
  const runRef = useRef(run);
  useEffect(() => { runRef.current = run; }, [run]);

  // ── R4-NB-1 Scheduling handlers (AML job schedules, recurrence only) ────────
  const refreshSchedules = useCallback(async () => {
    if (!notebookId) { setSchedules([]); setSchedulesConfigured(null); return; }
    try {
      const r = await clientFetch(`/api/notebook/${encodeURIComponent(notebookId)}/schedule`);
      const j = await r.json();
      if (j?.configured === false) { setSchedulesConfigured(false); setScheduleGateHint(j.hint || null); setSchedules([]); }
      else if (j?.ok) { setSchedulesConfigured(true); setScheduleGateHint(null); setSchedules(j.schedules || []); }
    } catch { /* leave prior state — non-fatal */ }
  }, [notebookId]);
  useEffect(() => { refreshSchedules(); }, [refreshSchedules]);

  const createSchedule = useCallback(async (params: ScheduleCreateParams) => {
    if (!notebookId) return;
    setScheduleBusy(true); setScheduleError(null);
    try {
      const r = await clientFetch(`/api/notebook/${encodeURIComponent(notebookId)}/schedule`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params),
      });
      const j = await r.json();
      if (j?.configured === false) { setScheduleError(j?.hint || 'Notebook scheduling not configured'); return; }
      if (!j?.ok) { setScheduleError(j?.error || 'Create failed'); return; }
      setScheduleWizardOpen(false);
      setRunMsg(`Schedule "${j.schedule?.displayName || j.schedule?.name}" created — every ${j.schedule?.interval} ${String(j.schedule?.frequency || '').toLowerCase()}.`);
      await refreshSchedules();
    } catch (e: any) { setScheduleError(e?.message || String(e)); }
    finally { setScheduleBusy(false); }
  }, [notebookId, refreshSchedules]);

  const toggleSchedule = useCallback(async (scheduleName: string, isEnabled: boolean) => {
    if (!notebookId) return;
    try {
      const r = await clientFetch(`/api/notebook/${encodeURIComponent(notebookId)}/schedule`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scheduleName, isEnabled }),
      });
      const j = await r.json();
      if (j?.ok) await refreshSchedules(); else setRunMsg(j?.error || j?.hint || 'Schedule update failed');
    } catch (e: any) { setRunMsg(e?.message || String(e)); }
  }, [notebookId, refreshSchedules]);

  const deleteSchedule = useCallback(async (scheduleName: string) => {
    if (!notebookId) return;
    try {
      const r = await clientFetch(`/api/notebook/${encodeURIComponent(notebookId)}/schedule?scheduleName=${encodeURIComponent(scheduleName)}`, { method: 'DELETE' });
      const j = await r.json();
      if (j?.ok) { setRunMsg('Schedule deleted.'); await refreshSchedules(); }
      else setRunMsg(j?.error || j?.hint || 'Schedule delete failed');
    } catch (e: any) { setRunMsg(e?.message || String(e)); }
  }, [notebookId, refreshSchedules]);

  // ── R4-NB-2 Parameters (papermill) ─────────────────────────────────────────
  const parametersCell = useMemo(() => cells.find((c) => c.type === 'code' && c.parameters) || null, [cells]);
  const markParametersCell = useCallback((cellId: string) => {
    // Exactly ONE parameters cell — tagging a new one clears the old tag.
    setCells((prev) => prev.map((c) => c.id === cellId
      ? { ...c, parameters: !c.parameters }
      : (c.parameters ? { ...c, parameters: false } : c)));
    setDirty(true);
  }, []);

  // Inject an override cell right after the parameters cell (papermill), persist
  // so the run route sees it, then fire the freshest run() (R4-NB-2).
  const runWithParameters = useCallback(async (overrides: Record<string, string>) => {
    if (!workspaceId || !notebookId) { setRunMsg('Open a notebook first.'); return; }
    if (!computeId) { setRunMsg('Pick a compute target before running.'); return; }
    const paramCell = cells.find((c) => c.type === 'code' && c.parameters);
    if (!paramCell) { setRunMsg('Tag a cell as the parameters cell first.'); return; }
    const lines = Object.entries(overrides).map(([k, v]) => `${k} = ${v}`);
    let nextCells = cells;
    if (lines.length > 0) {
      const injected: NotebookCell = {
        ...emptyCell('code', paramCell.lang || defaultLang),
        source: `# Injected parameters (Run with parameters)\n${lines.join('\n')}\n`,
      };
      const idx = cells.findIndex((c) => c.id === paramCell.id);
      nextCells = [...cells.slice(0, idx + 1), injected, ...cells.slice(idx + 1)];
      setCells(nextCells);
      setActiveCellId(injected.id);
    }
    setParamsDialogOpen(false);
    setDirty(true);
    try {
      const cellsForSave = nextCells.map((c) => ({ ...c, output: undefined }));
      await clientFetch(`/api/items/notebook/${encodeURIComponent(notebookId)}?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ definition: { cells: cellsForSave, defaultLang, attachedSources, attachedAmlEnv, customLibraries, resources } }),
      });
      setDirty(false);
    } catch (e: any) { setRunMsg(`Could not persist parameters: ${e?.message || e}`); return; }
    setRunMsg(lines.length ? `Injected ${lines.length} parameter override${lines.length === 1 ? '' : 's'} — running…` : 'Running with declared defaults…');
    setTimeout(() => { void runRef.current(); }, 60);
  }, [workspaceId, notebookId, computeId, cells, defaultLang, attachedSources, attachedAmlEnv, customLibraries, resources]);

  // ── R4-NB-3 Resources persist (Loom-native, with the notebook) ─────────────
  const persistResources = useCallback(async (next: NotebookResourceFile[]) => {
    if (!workspaceId || !notebookId) return;
    const cellsForSave = cells.map((c) => ({ ...c, output: undefined }));
    const r = await clientFetch(`/api/items/notebook/${encodeURIComponent(notebookId)}?workspaceId=${encodeURIComponent(workspaceId)}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ definition: { cells: cellsForSave, defaultLang, attachedSources, attachedAmlEnv, customLibraries, resources: next } }),
    });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || 'Could not save resource files');
    setRunMsg(`Resource files saved at ${new Date().toLocaleTimeString()}.`);
  }, [workspaceId, notebookId, cells, defaultLang, attachedSources, attachedAmlEnv, customLibraries]);

  // ── R4-NB-6 Outline jump ────────────────────────────────────────────────────
  const jumpToCell = useCallback((cellId: string) => {
    setActiveCellId(cellId);
    cellRefs.current.get(cellId)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setOutlineOpen(false);
  }, []);

  // ── R4-NB-8 Export .ipynb ───────────────────────────────────────────────────
  const exportIpynb = useCallback(() => {
    const nb = {
      nbformat: 4, nbformat_minor: 5,
      metadata: {
        kernelspec: { name: defaultLang === 'sparkr' ? 'ir' : 'python3', display_name: defaultLang === 'sparkr' ? 'R' : 'Python 3', language: defaultLang === 'sparkr' ? 'R' : 'python' },
        language_info: { name: defaultLang === 'sparkr' ? 'R' : 'python' },
      },
      cells: cells.map((c) => c.type === 'markdown'
        ? { cell_type: 'markdown', metadata: {}, source: splitKeep(c.source) }
        : { cell_type: 'code', execution_count: c.executionCount ?? null, metadata: c.parameters ? { tags: ['parameters'] } : {}, outputs: [], source: splitKeep(c.source) }),
    };
    const name = (notebooks || []).find((n) => n.id === notebookId)?.displayName || 'notebook';
    downloadJson(`${name}.ipynb`, nb);
    setRunMsg(`Exported ${name}.ipynb (${cells.length} cell${cells.length === 1 ? '' : 's'}).`);
  }, [cells, defaultLang, notebooks, notebookId]);

  // ── R4-NB-8 Inline rename ───────────────────────────────────────────────────
  const openRename = useCallback(() => {
    setRenameValue((notebooks || []).find((n) => n.id === notebookId)?.displayName || '');
    setRenameOpen(true);
  }, [notebooks, notebookId]);
  const submitRename = useCallback(async () => {
    const name = renameValue.trim();
    if (!name || !workspaceId || !notebookId) return;
    setRenameBusy(true);
    try {
      const r = await clientFetch(`/api/items/notebook/${encodeURIComponent(notebookId)}?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ displayName: name }),
      });
      const j = await r.json();
      if (j.ok) { setRenameOpen(false); await loadList(workspaceId); setRunMsg(`Renamed to "${name}".`); }
      else setRunMsg(`Rename failed: ${j.error || 'unknown'}`);
    } catch (e: any) { setRunMsg(`Rename failed: ${e?.message || e}`); }
    finally { setRenameBusy(false); }
  }, [renameValue, workspaceId, notebookId, loadList]);

  const create = useCallback(async () => {
    if (!workspaceId || !createName.trim()) return;
    setCreateBusy(true); setCreateErr(null);
    try {
      // Kernel-aware starter. On the AML path the cells run on a Compute
      // Instance (plain Python 3.10 / R), not a Spark pool. `lang` drives the
      // editor's default cell language after loadDetail re-parses the record.
      const aml = workspaceType === 'aml';
      const isR = createKernel === 'r';
      const lang: NotebookCellLang = isR ? 'sparkr' : (aml ? 'python' : 'pyspark');
      // Seed with a starter cell that matches the attached cluster TYPE so the
      // first cell already uses the right syntax (Databricks dbutils/display vs
      // Synapse mssparkutils vs Azure ML SDK). AML mode forces the azure-ml
      // runtime; otherwise it follows the selected compute (clusterRuntime).
      const seedRuntime: ClusterRuntime = aml ? 'azure-ml' : clusterRuntime;
      const code = starterCellFor(seedRuntime, lang);
      const definition = { code, lang };
      const r = await clientFetch(`/api/items/notebook?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ displayName: createName.trim(), definition }),
      });
      const j = await r.json();
      if (!j.ok) { setCreateErr(j.error || 'create failed'); return; }
      setCreateOpen(false); setCreateName('');
      await loadList(workspaceId);
      if (j.notebook?.id) setNotebookId(j.notebook.id);
    } finally { setCreateBusy(false); }
  }, [workspaceId, createName, createKernel, workspaceType, loadList]);

  // Import a desktop notebook file (.ipynb / .py / .sql / .scala / .r) into
  // the current workspace as a Loom notebook with every cell populated.
  // Reads the file → base64 → POST /api/items/notebook/import → on success
  // refresh the list and select the new notebook so loadDetail renders its
  // cells immediately.
  const importFile = useCallback(async (file: File) => {
    if (!workspaceId) { setRunMsg('Select a workspace before importing.'); return; }
    setImporting(true);
    setRunMsg(`Importing ${file.name}…`);
    try {
      const buf = await file.arrayBuffer();
      // ArrayBuffer → base64 without blowing the call stack on large files.
      const bytes = new Uint8Array(buf);
      let binary = '';
      const CHUNK = 0x8000;
      for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
      }
      const contentBase64 = btoa(binary);
      const r = await clientFetch('/api/items/notebook/import', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId, filename: file.name, contentBase64 }),
      });
      const j = await r.json();
      if (!j.ok) {
        setDetailErr(j.error || 'import failed');
        setRunMsg(`Import failed: ${j.error || 'unknown error'}`);
        return;
      }
      setRunMsg(`Imported ${file.name} → ${j.cellCount} cell${j.cellCount === 1 ? '' : 's'} (${j.defaultLang}).`);
      await loadList(workspaceId);
      // Select the freshly-created notebook; loadDetail will populate cells.
      if (j.id) setNotebookId(j.id);
    } catch (e: any) {
      setDetailErr(e?.message || String(e));
      setRunMsg(`Import failed: ${e?.message || e}`);
    } finally {
      setImporting(false);
    }
  }, [workspaceId, loadList]);

  const onImportFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Reset so picking the same file again re-fires change.
    e.target.value = '';
    if (file) importFile(file);
  }, [importFile]);

  const del = useCallback(async () => {
    if (!workspaceId || !notebookId) return;
    if (!confirm('Delete this notebook? This cannot be undone.')) return;
    await clientFetch(`/api/items/notebook/${encodeURIComponent(notebookId)}?workspaceId=${encodeURIComponent(workspaceId)}`, { method: 'DELETE' });
    setNotebookId('');
    await loadList(workspaceId);
  }, [workspaceId, notebookId, loadList]);

  // Cell mutations
  const insertCell = useCallback((after: number, type: 'code' | 'markdown') => {
    const fresh = emptyCell(type, defaultLang);
    setCells(prev => [...prev.slice(0, after + 1), fresh, ...prev.slice(after + 1)]);
    setActiveCellId(fresh.id);
    setDirty(true);
  }, [defaultLang]);

  const updateCell = useCallback((id: string, next: NotebookCell) => {
    setCells(prev => prev.map(c => c.id === id ? next : c));
    setDirty(true);
  }, []);

  // Data Wrangler "Add code to notebook" — append a code cell carrying the
  // generated pandas / PySpark code at the end of the notebook, select it, and
  // mark dirty so Ctrl+S persists (the generated cell runs on the user's full
  // DataFrame, per Fabric's export-to-cell contract). No auto-run.
  const insertWranglerCell = useCallback((source: string, lang: 'pyspark' | 'python') => {
    const fresh = { ...emptyCell('code', lang as NotebookCellLang), source };
    setCells(prev => [...prev, fresh]);
    setActiveCellId(fresh.id);
    setDirty(true);
    setWranglerOpen(false);
    setRunMsg('Inserted Data Wrangler code cell — review and Run to apply on your full DataFrame.');
  }, []);

  // "Use this lakehouse" — append a ready-to-run cell against an ATTACHED
  // lakehouse (operator report 2026-07-17: attach existed but there was no way
  // to actually USE it from the notebook). Snippets go through the auto-mount
  // preamble's `loom_lakehouses['<name>']` dict (real abfss paths — see
  // lib/notebook/lakehouse-mount-preamble.ts), matching Fabric's attached-
  // lakehouse "Load data" affordance.
  const insertLakehouseUseCell = useCallback((name: string, what: 'list-tables' | 'list-files' | 'read-table') => {
    const ref = `loom_lakehouses[${JSON.stringify(name)}]`;
    const source = what === 'list-tables'
      ? `# Tables in "${name}" (attached lakehouse)\ndisplay(mssparkutils.fs.ls(${ref} + "/Tables"))`
      : what === 'list-files'
        ? `# Files in "${name}" (attached lakehouse)\ndisplay(mssparkutils.fs.ls(${ref} + "/Files"))`
        : `# Read a Delta table from "${name}" — replace <table> (run the List-tables cell to see names)\ndf = spark.read.format("delta").load(${ref} + "/Tables/<table>")\ndisplay(df)`;
    const fresh = { ...emptyCell('code', 'pyspark' as NotebookCellLang), source };
    setCells(prev => [...prev, fresh]);
    setActiveCellId(fresh.id);
    setDirty(true);
    setRunMsg(`Inserted "${what}" cell for ${name} — Run it against the attached lakehouse.`);
  }, []);

  // Register an editor-mutation bridge per code cell so a Copilot-proposed
  // change (orchestrator `proposed_change` step → CopilotDiff Keep) mutates the
  // REAL cell via applyChange('notebook-cell:<id>', after). The bridge clears
  // the stale output/exec count so the refactored cell shows as un-run. Cells
  // are mutated only on explicit Keep — never automatically.
  useEffect(() => {
    const cleanups = cells
      .filter(c => c.type === 'code')
      .map(cell => registerBridge(`notebook-cell:${cell.id}`, (after: string) => {
        setCells(prev => prev.map(c =>
          c.id === cell.id ? { ...c, source: after, output: undefined, executionCount: undefined } : c,
        ));
        setDirty(true);
        setRunMsg('Applied Copilot change — review and Save (Ctrl+S) to persist.');
      }));
    return () => cleanups.forEach(fn => fn());
  }, [cells]);

  /**
   * Insert a datastore path (abfss:// / wasbs://) into a code cell. Called by
   * the Datastores sidebar on click AND on drag-drop. Appends to the active
   * code cell when there is one; otherwise to the first/last code cell; if the
   * notebook has no code cell yet, a fresh one is created with the path.
   */
  const insertDatastorePath = useCallback((path: string) => {
    setCells(prev => {
      const snippet = `"${path}"`;
      const activeIdx = prev.findIndex(c => c.id === activeCellId && c.type === 'code');
      const idx = activeIdx >= 0 ? activeIdx : prev.map(c => c.type).lastIndexOf('code');
      if (idx >= 0) {
        const cell = prev[idx];
        const sep = cell.source && !cell.source.endsWith('\n') ? '\n' : '';
        const nextCells = [...prev];
        nextCells[idx] = { ...cell, source: cell.source + sep + snippet };
        return nextCells;
      }
      // No code cell — append a new one carrying the path.
      const fresh = { ...emptyCell('code', defaultLang), source: snippet };
      return [...prev, fresh];
    });
    setDirty(true);
  }, [activeCellId, defaultLang]);

  const deleteCell = useCallback((id: string) => {
    setCells(prev => {
      if (prev.length <= 1) return prev;
      // U3 — drop the cell's persisted resize height with the cell so
      // per-cell localStorage keys never outlive the cells they sized.
      pruneCellHeightKey(id);
      return prev.filter(c => c.id !== id);
    });
    setDirty(true);
  }, []);

  const moveCell = useCallback((id: string, delta: -1 | 1) => {
    setCells(prev => {
      const idx = prev.findIndex(c => c.id === id);
      if (idx < 0) return prev;
      const newIdx = idx + delta;
      if (newIdx < 0 || newIdx >= prev.length) return prev;
      const next = [...prev];
      const [moved] = next.splice(idx, 1);
      next.splice(newIdx, 0, moved);
      return next;
    });
    setDirty(true);
  }, []);

  // Phase 3: duplicate a cell — clone with a fresh id and splice right
  // after the source cell. Clears any execution output / count so the
  // copy doesn't inherit stale run state.
  const duplicateCell = useCallback((id: string) => {
    const newId = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : `cell-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setCells(prev => {
      const idx = prev.findIndex(c => c.id === id);
      if (idx < 0) return prev;
      const src = prev[idx];
      const copy: NotebookCell = {
        ...src,
        id: newId,
        executionCount: undefined,
        output: undefined,
      };
      const next = [...prev];
      next.splice(idx + 1, 0, copy);
      return next;
    });
    setActiveCellId(newId);
    setDirty(true);
  }, []);

  // ---- Drag-to-reorder (native HTML5 DnD on the cell drag handle) ----
  // The handle in each cell header is the only draggable element, so dragging
  // never fights Monaco text selection. Dropping persists through the normal
  // Save path (dirty → PUT /api/items/notebook/[id] → Cosmos definition.cells),
  // i.e. the reordered cells survive reload — they are the notebook's .ipynb.
  const dragIndexRef = useRef<number | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

  const reorderCells = useCallback((from: number, to: number) => {
    if (from === to || from < 0 || to < 0) return;
    setCells(prev => {
      if (from >= prev.length || to >= prev.length) return prev;
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
    setDirty(true);
  }, []);

  const onCellDrop = useCallback((targetIdx: number) => {
    const from = dragIndexRef.current;
    dragIndexRef.current = null;
    setDragOverId(null);
    if (from == null) return;
    reorderCells(from, targetIdx);
  }, [reorderCells]);

  // ---- Stop: client-side interrupt registry checked by the poll loops ----
  const cancelRef = useRef<Set<string>>(new Set());
  // Live runId per running cell so Stop can cancel the SERVER-side statement,
  // not just abandon the client poll. Without this a stopped streaming cell
  // (writeStream + awaitTermination) kept running on the Spark pool forever —
  // the root of the "stuck on running" report AND the pool-hog incidents.
  const cellRunIdRef = useRef<Map<string, string>>(new Map());
  const stopCell = useCallback((id: string) => {
    cancelRef.current.add(id);
    // Best-effort server-side cancel (Livy statement cancel via DELETE /runs/[runId]).
    const runId = cellRunIdRef.current.get(id);
    if (runId && workspaceId && notebookId) {
      void clientFetch(
        `/api/items/notebook/${encodeURIComponent(notebookId)}/runs/${encodeURIComponent(runId)}?workspaceId=${encodeURIComponent(workspaceId)}`,
        { method: 'DELETE' },
      ).catch(() => { /* poll abandonment above is the fallback */ });
    }
    cellRunIdRef.current.delete(id);
    patchCell(id, { output: { status: 'error', ename: 'Cancelled', evalue: 'Execution stopped by user.' } });
    setRunMsg(`Cell ${id.slice(0, 6)} stopped${runId ? ' — server-side statement cancelled' : ''}.`);
  }, [patchCell, workspaceId, notebookId]);

  // ---- Split / merge (Edit menu) ----
  // Split a code cell into two at its midpoint (no Monaco cursor coupling):
  // top keeps the source's first half, a new cell below gets the rest.
  const splitCell = useCallback((id: string) => {
    setCells(prev => {
      const idx = prev.findIndex(c => c.id === id);
      if (idx < 0) return prev;
      const cell = prev[idx];
      if (cell.type !== 'code') return prev;
      const lines = cell.source.split('\n');
      if (lines.length < 2) return prev; // nothing meaningful to split
      const mid = Math.ceil(lines.length / 2);
      const fresh = emptyCell('code', cell.lang || defaultLang);
      const newCell: NotebookCell = { ...fresh, source: lines.slice(mid).join('\n') };
      const next = [...prev];
      next.splice(idx, 1,
        { ...cell, source: lines.slice(0, mid).join('\n'), output: undefined, executionCount: undefined },
        newCell,
      );
      return next;
    });
    setDirty(true);
  }, [defaultLang]);

  // Merge a cell with the one below it (same type only). Markdown joins with a
  // blank line; code joins with a blank line too so statements stay separated.
  const mergeCellDown = useCallback((id: string) => {
    setCells(prev => {
      const idx = prev.findIndex(c => c.id === id);
      if (idx < 0 || idx >= prev.length - 1) return prev;
      const top = prev[idx];
      const bot = prev[idx + 1];
      if (top.type !== bot.type) return prev;
      const merged: NotebookCell = {
        ...top,
        source: `${top.source}\n\n${bot.source}`,
        output: undefined,
        executionCount: undefined,
      };
      const next = [...prev];
      next.splice(idx, 2, merged);
      return next;
    });
    setDirty(true);
  }, []);

  // ---- Convert cell type (code ⇄ markdown) ----
  const convertCell = useCallback((id: string, to: 'code' | 'markdown') => {
    setCells(prev => prev.map(c => {
      if (c.id !== id || c.type === to) return c;
      return {
        ...c,
        type: to,
        lang: to === 'code' ? (c.lang || defaultLang) : undefined,
        output: undefined,
        executionCount: undefined,
      };
    }));
    setDirty(true);
  }, [defaultLang]);

  // Route a %%pyspark cell to the dedicated Spark backend (AML Serverless Spark
  // on Commercial/GCC, Synapse Livy on Gov). No compute target needed — backend
  // is chosen server-side from env (LOOM_AML_SPARK / LOOM_SYNAPSE_SPARK_POOL).
  const runSparkCell = useCallback(async (cell: NotebookCell) => {
    if (!workspaceId || !notebookId) return;
    cancelRef.current.delete(cell.id);
    patchCell(cell.id, { output: { status: 'pending' } });
    setRunMsg(`Running %%pyspark cell ${cell.id.slice(0, 6)} on Spark…`);
    const prevExec = cell.executionCount || 0;
    try {
      const r = await clientFetch(`/api/items/notebook/${encodeURIComponent(notebookId)}/execute-spark?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source: cell.source, cellId: cell.id }),
      });
      const j = await r.json();
      if (!j.ok) {
        patchCell(cell.id, { output: { status: 'error', ename: 'DispatchError', evalue: `${j.error || 'dispatch failed'}${j.hint ? ' — ' + j.hint : ''}` } });
        setRunMsg(`%%pyspark dispatch failed: ${j.error}`);
        return;
      }
      let runId: string = j.runId;
      cellRunIdRef.current.set(cell.id, runId);
      const start = Date.now();
      const MAX_MS = 15 * 60 * 1000;
      let pollInterval = 2000;
      while (Date.now() - start < MAX_MS) {
        if (cancelRef.current.has(cell.id)) { cancelRef.current.delete(cell.id); return; }
        await new Promise(res => setTimeout(res, pollInterval));
        const pollRes = await clientFetch(`/api/items/notebook/${encodeURIComponent(notebookId)}/execute-spark?workspaceId=${encodeURIComponent(workspaceId)}&runId=${encodeURIComponent(runId)}`);
        const p = await pollRes.json();
        if (!p.ok) { patchCell(cell.id, { output: { status: 'error', ename: 'PollError', evalue: p.error || String(pollRes.status) } }); break; }
        if (p.runId && p.runId !== runId) { runId = p.runId; cellRunIdRef.current.set(cell.id, runId); }
        const phaseHint = p.phase === 'session-starting' ? ' · Spark pool warming (~60-90s)' : p.phase ? ` · ${p.phase}` : '';
        const elapsed = Math.floor((Date.now() - start) / 1000);
        setRunMsg(`%%pyspark ${cell.id.slice(0, 6)}: ${p.status}${phaseHint} · ${elapsed}s · ${p.backend || ''}`);
        if (p.phase === 'statement-running' || p.phase === 'job-running') pollInterval = 1500;
        if (p.output) {
          patchCell(cell.id, {
            executionCount: prevExec + 1,
            output: {
              status: p.output.status === 'ok' ? 'ok' : 'error',
              textPlain: p.output.textPlain,
              data: p.output.data,
              ename: p.output.ename,
              evalue: p.output.evalue,
              traceback: p.output.traceback,
              executedAtUtc: new Date().toISOString(),
              durationMs: Date.now() - start,
            },
          });
          setRunMsg(`%%pyspark cell ${cell.id.slice(0, 6)} complete (${p.backend || 'spark'})`);
          break;
        }
        if (['error', 'dead', 'killed', 'Failed', 'Canceled'].includes(p.status)) {
          patchCell(cell.id, { output: { status: 'error', ename: p.status, evalue: '' } });
          break;
        }
      }
    } catch (e: any) {
      patchCell(cell.id, { output: { status: 'error', ename: 'Exception', evalue: e?.message || String(e) } });
    } finally {
      cellRunIdRef.current.delete(cell.id);
    }
  }, [workspaceId, notebookId, patchCell]);

  /**
   * Apply Copilot's returned code block(s) back into the notebook. The pane
   * parses fenced code blocks from the streamed AOAI answer (in document
   * order) and calls this. A single block replaces the active code cell; a
   * multi-block answer is mapped onto the trailing run of cells ENDING at the
   * active cell (last block → active cell). Marks the notebook dirty so Ctrl+S
   * persists — no auto-save, the user reviews the diff first.
   */
  const applyCells = useCallback((updated: { source: string }[]) => {
    if (updated.length === 0) return;
    setCells((prev) => {
      if (prev.length === 0) return prev;
      let activeIdx = activeCellId ? prev.findIndex((c) => c.id === activeCellId) : -1;
      if (activeIdx < 0) {
        // No explicit active cell — target the last CODE cell.
        for (let i = prev.length - 1; i >= 0; i--) { if (prev[i].type === 'code') { activeIdx = i; break; } }
        if (activeIdx < 0) activeIdx = prev.length - 1;
      }
      const startIdx = Math.max(0, activeIdx - (updated.length - 1));
      const next = [...prev];
      updated.forEach((u, i) => {
        const tgt = startIdx + i;
        if (tgt <= activeIdx && next[tgt]) next[tgt] = { ...next[tgt], source: u.source, output: undefined };
      });
      return next;
    });
    setDirty(true);
    setRunMsg('Applied Copilot suggestion — review and Save (Ctrl+S) to persist.');
  }, [activeCellId]);

  // Per-cell run: dispatches a single cell's source to the notebook /run endpoint with cellId, then polls.
  // CRITICAL: use patchCell (not updateCell) for output mutations so source
  // edits the user makes WHILE the cell is running don't get overwritten
  // by the stale `cell` snapshot captured here. That bug caused Save to
  // appear broken — clicking Save persisted the pre-Run cell source.
  const runCell = useCallback(async (cell: NotebookCell) => {
    if (!workspaceId || !notebookId) return;
    if (cell.type !== 'code') return;
    // %%pyspark (and language-magic) cells route to the dedicated Spark backend
    // regardless of the selected compute target — that is the explicit cell
    // routing this editor provides.
    if (cellRoutesToSpark(cell.source)) { await runSparkCell(cell); return; }
    if (!computeId) { setRunMsg('Pick a compute target before running.'); return; }
    cancelRef.current.delete(cell.id);
    patchCell(cell.id, { output: { status: 'pending' } });
    cellRunStartRef.current.set(cell.id, Date.now()); // R4-NB-4 elapsed timer
    setSessionStatus('Running');
    setRunMsg(`Running cell ${cell.id.slice(0, 6)}…`);
    const prevExec = cell.executionCount || 0;
    try {
      const r = await clientFetch(`/api/items/notebook/${encodeURIComponent(notebookId)}/run?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ compute: computeId, cellId: cell.id, source: cell.source, lang: cell.lang || defaultLang, ...sessionConfigBody() }),
      });
      const j = await r.json();
      if (!j.ok) {
        patchCell(cell.id, { output: { status: 'error', ename: 'DispatchError', evalue: j.error || 'dispatch failed' } });
        setRunMsg(`Cell run failed: ${j.error}`);
        setSessionStatus('Error');
        return;
      }
      if (j.session) setSessionReceipt(j.session);
      let runId: string = j.runId;
      cellRunIdRef.current.set(cell.id, runId);
      const streaming = looksStreaming(cell.source);
      const start = Date.now();
      const MAX_MS = 12 * 60 * 1000; // 12 min to allow for slow cold-starts
      let pollInterval = 2000; // 2s during session-starting, 1s during statement
      let settled = false; // did the cell reach a terminal output/state?
      while (Date.now() - start < MAX_MS) {
        if (cancelRef.current.has(cell.id)) { cancelRef.current.delete(cell.id); return; }
        await new Promise(res => setTimeout(res, pollInterval));
        let p: any;
        try {
          // Backoff-retry inside pollRunStatus so a transient blip doesn't strand
          // the cell on a spinner (R3 #3).
          p = await pollRunStatus(runId);
        } catch (e: any) {
          patchCell(cell.id, { output: { status: 'error', ename: 'PollError', evalue: `Lost contact with the run: ${e?.message || e}. Retry the cell.` } });
          setSessionStatus('Error');
          settled = true;
          break;
        }
        if (!p.ok) {
          patchCell(cell.id, { output: { status: 'error', ename: 'PollError', evalue: p.error || 'run poll failed' } });
          setSessionStatus('Error');
          settled = true;
          break;
        }
        if (p.runId && p.runId !== runId) { runId = p.runId; cellRunIdRef.current.set(cell.id, runId); }
        const elapsed = Math.floor((Date.now() - start) / 1000);
        const phaseHint = p.phase === 'session-starting'
          ? ` · cold-start: Spark pool warming up (~60-90s on first cell)`
          : p.phase ? ` · ${p.phase}` : '';
        // A streaming cell legitimately never completes — say so instead of
        // reading as a hung "running" (ADF/Databricks show the same live state).
        const streamHint = streaming && p.phase === 'statement-running' ? ' · Streaming (live) — runs until stopped; use Stop to end it' : '';
        setRunMsg(`Cell ${cell.id.slice(0, 6)}: ${p.status}${phaseHint}${streamHint} · ${elapsed}s`);
        // R4-NB-4 — surface real-time Spark progress under the cell. `p.progress`
        // arrives once the shared poll surface (R4-SYN-5) lands; until then the
        // RunProgress bar stays honest-indeterminate off the phase + elapsed.
        setRunPhase(p.phase || p.status || null);
        if (p.progress && typeof p.progress === 'object') {
          setCellProgress((prev) => new Map(prev).set(cell.id, p.progress as SparkRunProgress));
        }
        // Adaptive polling: speed up after session is idle
        if (p.phase === 'statement-running') pollInterval = 1000;
        if (p.output) {
          patchCell(cell.id, {
            executionCount: prevExec + 1,
            output: {
              status: p.output.status === 'ok' ? 'ok' : 'error',
              textPlain: p.output.textPlain,
              data: p.output.data,
              richDisplay: p.output.richDisplay,
              ename: p.output.ename,
              evalue: p.output.evalue,
              traceback: p.output.traceback,
              executedAtUtc: new Date().toISOString(),
              durationMs: cellDurationMs(cell.id),
            },
          });
          setRunMsg(`Cell ${cell.id.slice(0, 6)} complete`);
          setSessionStatus(p.output.status === 'ok' ? 'Idle' : 'Error');
          settled = true;
          break;
        }
        // Recognize ALL terminal Livy statement + session states (R3 #3) —
        // cancelled / cancelling / shutting_down previously polled to the 12-min
        // timeout and left the cell blank.
        if (['error', 'dead', 'killed', 'shutting_down', 'cancelled', 'cancelling', 'TERMINATED', 'INTERNAL_ERROR', 'Failed', 'Canceled'].includes(p.status)) {
          patchCell(cell.id, { output: { status: 'error', ename: p.status, evalue: p.resultState || `Run ended in state '${p.status}'.` } });
          setSessionStatus('Error');
          settled = true;
          break;
        }
      }
      if (!settled) {
        const mins = Math.round(MAX_MS / 60000);
        if (streaming) {
          // A streaming query running past the poll window is EXPECTED, not a
          // fault — stop polling honestly and leave the query live with a clear
          // note + the Stop affordance (the statement keeps running server-side).
          patchCell(cell.id, {
            output: {
              status: 'ok',
              textPlain: `Streaming query is live (polled for ${mins}m, still running server-side).\n`
                + `It processes new data continuously until stopped — click the cell's Stop button to cancel it,\n`
                + `or use trigger(availableNow=True) for a run that completes on its own.`,
              executedAtUtc: new Date().toISOString(),
            },
          });
          setSessionStatus('Idle');
        } else {
          // 12-min timeout with no terminal result — honest error, never a silent
          // spinner (R3 #3).
          patchCell(cell.id, { output: { status: 'error', ename: 'Timeout', evalue: `Run timed out after ${mins}m — the session may be starting slowly or the statement hung. Retry or Configure session.` } });
          setSessionStatus('Error');
        }
      }
      loadJobs(workspaceId, notebookId);
    } catch (e: any) {
      patchCell(cell.id, { output: { status: 'error', ename: 'Exception', evalue: e?.message || String(e) } });
      setSessionStatus('Error');
    } finally {
      cellRunIdRef.current.delete(cell.id);
      clearCellProgress(cell.id); setRunPhase(null); // R4-NB-4 cleanup
    }
  }, [workspaceId, notebookId, computeId, defaultLang, sessionConfigBody, pollRunStatus, patchCell, loadJobs, runSparkCell, clearCellProgress, cellDurationMs]);

  /**
   * Variable explorer — submit a Python introspection snippet to the ACTIVE
   * Livy session and return parsed VarRow[]. Reuses the same warm session as
   * runCell (the run route reuses `state.sparkSession`), so it sees variables
   * that earlier cells defined. Goes through the Task-3 execute path:
   * POST /run (with a sentinel cellId) + poll /runs/[runId].
   *
   * We use `globals()` rather than the IPython `%whos` magic because Synapse
   * Spark runs plain PySpark via Livy (no IPython kernel) — `%whos` would be a
   * SyntaxError there. The snippet prints one JSON line behind a marker so the
   * row data survives any Spark log noise in stdout, then deletes its temps so
   * they don't show up in the next inspection.
   *
   * Honest gate: if no workspace/notebook/compute is selected we throw a
   * human-readable error which the pane surfaces in a MessageBar — no silent
   * failure, per no-vaporware.
   */
  const inspectVariables = useCallback(async (): Promise<VarRow[]> => {
    if (!workspaceId || !notebookId) {
      throw new Error('Open or create a notebook first.');
    }
    if (!computeId) {
      throw new Error('Pick a Spark compute target on the toolbar before inspecting variables.');
    }
    if (!computeId.startsWith('spark:')) {
      throw new Error('The variable explorer runs on a Synapse Spark (Livy) session. Select a Synapse Spark compute target.');
    }
    const INSPECT_SOURCE = [
      'import json as __loom_j__',
      '__loom_v__ = []',
      "__loom_skip__ = ('In','Out','exit','quit','get_ipython','spark','sc','sqlContext','spark_session')",
      'for __loom_k__ in list(globals().keys()):',
      "    if __loom_k__.startswith('_') or __loom_k__ in __loom_skip__:",
      '        continue',
      '    __loom_val__ = globals()[__loom_k__]',
      "    if type(__loom_val__).__name__ in ('module','function','type','builtin_function_or_method'):",
      '        continue',
      '    try:',
      "        __loom_l__ = len(__loom_val__) if hasattr(__loom_val__, '__len__') else None",
      '    except Exception:',
      '        __loom_l__ = None',
      '    try:',
      '        __loom_r__ = repr(__loom_val__)[:300]',
      '    except Exception:',
      "        __loom_r__ = '<unrepresentable>'",
      "    __loom_v__.append({'n': __loom_k__, 't': type(__loom_val__).__name__, 'l': __loom_l__, 'r': __loom_r__})",
      "print('__LOOM_VARS__:' + __loom_j__.dumps(__loom_v__))",
      'del __loom_j__, __loom_v__, __loom_skip__',
    ].join('\n');

    const r = await clientFetch(
      `/api/items/notebook/${encodeURIComponent(notebookId)}/run?workspaceId=${encodeURIComponent(workspaceId)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ compute: computeId, cellId: '__loom_inspect__', source: INSPECT_SOURCE, lang: 'pyspark' }),
      },
    );
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || 'variable inspection dispatch failed');
    let runId: string = j.runId;
    const start = Date.now();
    const MAX_MS = 12 * 60 * 1000;
    let pollInterval = 600;
    while (Date.now() - start < MAX_MS) {
      await new Promise(res => setTimeout(res, pollInterval));
      const pollRes = await clientFetch(
        `/api/items/notebook/${encodeURIComponent(notebookId)}/runs/${encodeURIComponent(runId)}?workspaceId=${encodeURIComponent(workspaceId)}`,
      );
      const p = await pollRes.json();
      if (!p.ok) throw new Error(p.error || `poll failed (${pollRes.status})`);
      if (p.runId && p.runId !== runId) runId = p.runId;
      const cold = p.phase === 'session-starting' || /^(starting|pending|queued)$/i.test(String(p.status || ''));
      pollInterval = cold ? 2000 : 600;
      if (p.output) {
        if (p.output.status === 'error') {
          throw new Error(`${p.output.ename || 'Error'}: ${p.output.evalue || 'kernel raised an error'}`);
        }
        const text: string = p.output.textPlain || '';
        const markerIdx = text.lastIndexOf('__LOOM_VARS__:');
        if (markerIdx < 0) return [];
        const jsonStr = text.slice(markerIdx + '__LOOM_VARS__:'.length).split('\n')[0].trim();
        let raw: Array<{ n: string; t: string; l: number | null; r: string }>;
        try {
          raw = JSON.parse(jsonStr);
        } catch {
          throw new Error('Could not parse the kernel variable snapshot.');
        }
        return raw.map(x => ({ name: x.n, type: x.t, len: x.l, repr: x.r }));
      }
      if (['error', 'dead', 'killed', 'TERMINATED', 'INTERNAL_ERROR'].includes(p.status)) {
        throw new Error(`Spark session ended with status ${p.status}`);
      }
    }
    throw new Error('Variable inspection timed out.');
  }, [workspaceId, notebookId, computeId]);

  // Library & Environment: install a package inline. Append a new code cell with
  // `%pip install <pkg>` and run it on the live session via the same run path
  // (Task 3 execute). The magic installs into the running Livy/Databricks
  // session; the next `import <pkg>` cell then works. Real backend, no stub.
  const installPipPackage = useCallback((pkg: string) => {
    if (!workspaceId || !notebookId) { setRunMsg('Open a notebook before installing packages.'); return; }
    if (!computeId) { setRunMsg('Pick a compute target before installing packages.'); return; }
    const cell: NotebookCell = { ...emptyCell('code', 'pyspark'), source: `%pip install ${pkg}` };
    setCells(prev => [...prev, cell]);
    setActiveCellId(cell.id);
    setEnvPanelOpen(false);
    // Defer so the cell is committed to state before runCell's patchCell runs.
    setTimeout(() => { void runCell(cell); }, 0);
  }, [workspaceId, notebookId, computeId, runCell]);

  // Attach/detach an AML environment from the compact ribbon selector. Persists
  // to Cosmos via the attach route (instant) and mirrors local state.
  const selectAmlEnv = useCallback(async (envName: string) => {
    if (!workspaceId || !notebookId) return;
    if (!envName) {
      try {
        await clientFetch('/api/aml/environments?action=detach', {
          method: 'PATCH', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ notebookId, workspaceId }),
        });
      } catch { /* non-fatal */ }
      setAttachedAmlEnv(null);
      return;
    }
    const env = amlEnvs.find(e => e.name === envName);
    setRunMsg(`Attaching environment ${envName}…`);
    try {
      const r = await clientFetch('/api/aml/environments?action=attach', {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ notebookId, workspaceId, envName, envVersion: env?.latestVersion }),
      });
      const j = await r.json();
      if (!j.ok) { setRunMsg(`Attach failed: ${j.error}${j.hint ? ' — ' + j.hint : ''}`); return; }
      setAttachedAmlEnv(j.attachedAmlEnv);
      setRunMsg(`Attached ${j.attachedAmlEnv.name}:${j.attachedAmlEnv.version}.`);
    } catch (e: any) { setRunMsg(`Attach failed: ${e?.message || e}`); }
  }, [workspaceId, notebookId, amlEnvs]);

  // Build the Fabric-parity ribbon with real handlers. Previously these were
  // decorative labels with no onClick — the Ribbon component auto-disables
  // un-wired actions, which gave the user two visually-identical Save buttons
  // (a disabled ribbon Save + a working toolbar Save). Now both work.
  const ribbon: RibbonTab[] = useMemo(() => {
    const activeIdx = cells.findIndex(c => c.id === activeCellId);
    const insertAfter = activeIdx >= 0 ? activeIdx : cells.length - 1;
    const canRun = !!notebookId && !!computeId && !running;
    const canSave = !!notebookId && dirty && !saving;
    const canDelete = !!notebookId;
    const canHistory = !!notebookId;
    return [
      { id: 'home', label: 'Home', groups: [
        { label: 'Run', actions: [
          { label: running ? 'Queuing…' : 'Run all', onClick: canRun ? run : undefined, disabled: !canRun },
          { label: 'Run history', onClick: canHistory ? () => setHistoryOpen(true) : undefined, disabled: !canHistory },
        ]},
        { label: 'Item', actions: [
          { label: 'New notebook', onClick: workspaceId ? () => setCreateOpen(true) : undefined, disabled: !workspaceId },
          { label: importing ? 'Importing…' : 'Import notebook', onClick: workspaceId && !importing ? () => fileInputRef.current?.click() : undefined, disabled: !workspaceId || importing },
          // R4-NB-8 — export the open notebook to a portable .ipynb, and inline rename.
          { label: 'Export .ipynb', onClick: notebookId ? exportIpynb : undefined, disabled: !notebookId },
          { label: 'Rename', onClick: notebookId ? openRename : undefined, disabled: !notebookId },
          { label: saving ? 'Saving…' : 'Save', onClick: canSave ? save : undefined, disabled: !canSave },
          { label: 'Delete', onClick: canDelete ? del : undefined, disabled: !canDelete },
        ]},
        // R4-NB-1 — recurrence scheduling (Azure ML job schedules), Fabric parity.
        { label: 'Schedule', actions: [
          { label: 'Schedule', onClick: notebookId ? () => setScheduleWizardOpen(true) : undefined, disabled: !notebookId },
        ]},
        { label: 'Workspace', actions: [
          { label: 'Refresh list', onClick: workspaceId ? () => loadList(workspaceId) : undefined, disabled: !workspaceId },
        ]},
        { label: 'Environment', actions: [
          { label: 'Manage environment', onClick: notebookId ? () => setEnvPanelOpen(true) : undefined, disabled: !notebookId },
        ]},
      ]},
      { id: 'insert', label: 'Insert', groups: [
        { label: 'Cells', actions: [
          { label: '+ Code cell', onClick: () => insertCell(insertAfter, 'code') },
          { label: '+ Markdown cell', onClick: () => insertCell(insertAfter, 'markdown') },
        ]},
        { label: 'Data', actions: [
          { label: 'Attach Lakehouse', onClick: workspaceId ? openAttach : undefined, disabled: !workspaceId },
          { label: 'Data Wrangler', onClick: () => setWranglerOpen(true) },
        ]},
      ]},
      { id: 'view', label: 'View', groups: [
        { label: 'Panes', actions: [
          { label: 'Run history', onClick: canHistory ? () => setHistoryOpen(true) : undefined, disabled: !canHistory },
          // R4-NB-6 outline · R4-NB-3 resources.
          { label: 'Outline', onClick: () => setOutlineOpen(true) },
          { label: 'Resources', onClick: () => setResourcesOpen(true) },
          { label: copilotOpen ? 'Hide Copilot' : 'Copilot', onClick: () => setCopilotOpen(v => !v) },
          { label: 'Variables', onClick: notebookId ? () => setVariablesOpen(true) : undefined, disabled: !notebookId },
          { label: 'Data Wrangler', onClick: () => setWranglerOpen(true) },
        ]},
      ]},
      { id: 'edit', label: 'Edit', groups: [
        { label: 'Cell', actions: [
          { label: 'Split cell', onClick: activeCellId ? () => splitCell(activeCellId) : undefined, disabled: !activeCellId },
          { label: 'Merge with below', onClick: activeCellId ? () => mergeCellDown(activeCellId) : undefined, disabled: !activeCellId },
          // R4-NB-2 — tag/untag the active code cell as the papermill parameters cell.
          { label: parametersCell && activeCellId === parametersCell.id ? 'Unmark parameters cell' : 'Mark as parameters cell',
            onClick: activeCellId && cells.find(c => c.id === activeCellId)?.type === 'code' ? () => markParametersCell(activeCellId) : undefined,
            disabled: !activeCellId || cells.find(c => c.id === activeCellId)?.type !== 'code' },
        ]},
        { label: 'Convert', actions: [
          { label: 'To code cell', onClick: activeCellId ? () => convertCell(activeCellId, 'code') : undefined, disabled: !activeCellId },
          { label: 'To markdown cell', onClick: activeCellId ? () => convertCell(activeCellId, 'markdown') : undefined, disabled: !activeCellId },
        ]},
      ]},
      { id: 'ai', label: 'AI tools', groups: [
        { label: 'Copilot', actions: [
          { label: copilotOpen ? 'Hide Copilot' : 'Open Copilot', onClick: () => setCopilotOpen(v => !v) },
          { label: 'Variables', onClick: notebookId ? () => setVariablesOpen(true) : undefined, disabled: !notebookId },
        ]},
        { label: 'Cells', actions: [
          { label: '+ Code cell', onClick: () => insertCell(insertAfter, 'code') },
        ]},
      ]},
      { id: 'run', label: 'Run', groups: [
        { label: 'Execute', actions: [
          { label: 'Run all', onClick: canRun ? run : undefined, disabled: !canRun },
          // R4-NB-2 — parameterized run (papermill). Enabled once a cell is tagged.
          { label: 'Run with parameters', onClick: canRun && parametersCell ? () => setParamsDialogOpen(true) : undefined, disabled: !canRun || !parametersCell },
        ]},
        { label: 'Session', actions: [
          { label: 'Configure session', onClick: () => openConfigDialog() },
        ]},
        { label: 'Schedule', actions: [
          { label: 'Schedule', onClick: notebookId ? () => setScheduleWizardOpen(true) : undefined, disabled: !notebookId },
        ]},
      ]},
      { id: 'help', label: 'Help', groups: [
        { label: 'Resources', actions: [
          { label: 'Notebook docs', onClick: () => window.open(
            workspaceType === 'aml'
              ? 'https://learn.microsoft.com/azure/machine-learning/how-to-run-jupyter-notebooks'
              : 'https://learn.microsoft.com/fabric/data-engineering/how-to-use-notebook',
            '_blank') },
        ]},
      ]},
    ];
  }, [
    cells, activeCellId, notebookId, running, dirty, saving, workspaceId, computeId, importing,
    workspaceType, copilotOpen, parametersCell,
    run, save, del, loadList, insertCell, openAttach, openConfigDialog,
    splitCell, mergeCellDown, convertCell,
    exportIpynb, openRename, markParametersCell,
  ]);

  // SC-9 — publish notebook ribbon actions (Run all, Save, Insert cell, Data
  // Wrangler, Copilot, session config…) to the shared command registry so the
  // in-ribbon Ctrl+Q / Alt+Q CommandSearch can run them.
  useRegisterRibbonCommands(ribbon, 'notebook');

  return (
    <ItemEditorChrome splitKeyPrefix={item.slug} item={item} id={id} ribbon={ribbon} dirty={dirty} commandSearch
      explain={{ family: 'notebook', getDefinition: () => ({ cells, defaultLang }) }}
      leftPanel={
        <div className={s.treePad}>
          <Subtitle2 className={s.sectionHeader} style={{ marginBottom: tokens.spacingVerticalS }}>
            <Notebook16Regular /> Notebooks
          </Subtitle2>
          {!workspaceId && <Caption1>Select a workspace.</Caption1>}
          {workspaceId && notebooks === null && <Spinner size="tiny" label="Loading…" />}
          {workspaceId && notebooks && (
            <>
              <div className={s.nbPaneToolbar}>
                <Tooltip content="New folder" relationship="label">
                  <Button size="small" appearance="subtle" icon={<FolderAdd20Regular />}
                    onClick={() => openNbCreateFolder(null)} disabled={nbFolderBusy}>Folder</Button>
                </Tooltip>
                <div style={{ flex: 1 }} />
                <Menu>
                  <MenuTrigger disableButtonEnhancement>
                    <Tooltip content="Sort notebooks" relationship="label">
                      <Button size="small" appearance="subtle" icon={<ArrowSort20Regular />}>
                        {nbSort === 'updated' ? 'Recent' : 'A–Z'}
                      </Button>
                    </Tooltip>
                  </MenuTrigger>
                  <MenuPopover>
                    <MenuList>
                      <MenuItem onClick={() => setNbSort('name')}>Name (A–Z)</MenuItem>
                      <MenuItem onClick={() => setNbSort('updated')}>Recently updated</MenuItem>
                    </MenuList>
                  </MenuPopover>
                </Menu>
              </div>
              {nbFolderErr && (
                <MessageBar intent="error" style={{ marginBottom: tokens.spacingVerticalS }}>
                  <MessageBarBody>{nbFolderErr}</MessageBarBody>
                </MessageBar>
              )}
              {notebooks.length === 0 && folders.length === 0 && !listErr ? (
                <EmptyState
                  icon={<Notebook20Regular />}
                  title="No notebooks yet"
                  body="Create a notebook, or add a folder to organize them."
                  primaryAction={{ label: 'New folder', onClick: () => openNbCreateFolder(null) }}
                />
              ) : (
                <>
                  <Tree aria-label="Notebooks">
                    {nbTree.childFolders.map(renderNbFolder)}
                    {nbTree.childItems.map(renderNbLeaf)}
                  </Tree>
                  <div
                    className={`${s.nbRootDrop} ${nbDropTarget === 'root' ? s.nbRootDropActive : ''}`}
                    onDragOver={(e) => onNbFolderDragOver(e, 'root')}
                    onDragLeave={() => setNbDropTarget((cur) => (cur === 'root' ? null : cur))}
                    onDrop={(e) => onNbFolderDrop(e, null)}
                  >
                    Drop here to move to root
                  </div>
                </>
              )}
            </>
          )}

          {/* New / rename notebook folder */}
          <NbFolderDialog
            state={nbFolderDialog}
            onClose={() => setNbFolderDialog(null)}
            name={nbFolderName}
            onNameChange={setNbFolderName}
            busy={nbFolderBusy}
            onSubmit={() => void submitNbFolderDialog()}
          />

          {/* Confirm delete notebook folder (cascade reparents to root) */}
          <NbFolderDeleteDialog
            target={nbConfirmFolderDelete}
            onClose={() => setNbConfirmFolderDelete(null)}
            busy={nbFolderBusy}
            onDelete={deleteNbFolder}
          />

          {/* Move notebook to folder */}
          <NbMoveDialog
            target={nbMoveTarget}
            onClose={() => setNbMoveTarget(null)}
            folders={folders}
            onMove={moveNbToFolder}
          />

          {/* Phase 2: Data items pane — Fabric "Explorer" tab equivalent */}
          {notebookId && (
            <>
              <Subtitle2 className={s.sectionHeader} style={{ marginTop: tokens.spacingVerticalL, marginBottom: tokens.spacingVerticalXS }}>
                <Database16Regular /> Data items
              </Subtitle2>
              {attachedSources.length === 0 ? (
                <Caption1>No sources attached. Attach a Lakehouse so cells can read its OneLake mount.</Caption1>
              ) : (
                <Tree aria-label="Attached sources">
                  {attachedSources.map((src) => {
                    const resolved = src.kind === 'lakehouse' ? resolvedPaths[src.id] : undefined;
                    return (
                    <TreeItem key={src.id} itemType="leaf" value={src.id}>
                      <TreeItemLayout
                        iconBefore={<Notebook20Regular />}
                      >
                        <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS, width: '100%' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, width: '100%' }}>
                            <span style={{ flex: 1 }}>
                              {src.isDefault ? <strong>{src.displayName}</strong> : src.displayName}
                              {src.isDefault && <Badge appearance="outline" color="brand" size="small" style={{ marginLeft: tokens.spacingHorizontalXS }}>default</Badge>}
                            </span>
                            {src.kind === 'lakehouse' && (
                              <Menu>
                                <MenuTrigger disableButtonEnhancement>
                                  <Button size="small" appearance="subtle" onClick={(e) => e.stopPropagation()}>Use</Button>
                                </MenuTrigger>
                                <MenuPopover>
                                  <MenuList>
                                    <MenuItem onClick={() => insertLakehouseUseCell(src.displayName, 'list-tables')}>Insert: list tables</MenuItem>
                                    <MenuItem onClick={() => insertLakehouseUseCell(src.displayName, 'read-table')}>Insert: read a table</MenuItem>
                                    <MenuItem onClick={() => insertLakehouseUseCell(src.displayName, 'list-files')}>Insert: list files</MenuItem>
                                    {resolved?.abfss && (
                                      <MenuItem onClick={() => { void navigator.clipboard?.writeText(resolved.abfss || ''); }}>Copy abfss path</MenuItem>
                                    )}
                                  </MenuList>
                                </MenuPopover>
                              </Menu>
                            )}
                            {!src.isDefault && (
                              <Button size="small" appearance="subtle" onClick={(e) => { e.stopPropagation(); promoteDefault(src.id); }}>Pin</Button>
                            )}
                            <Button size="small" appearance="subtle" onClick={(e) => { e.stopPropagation(); detachSource(src.id); }}>×</Button>
                          </div>
                          {/* Issue #655: real abfss path the auto-mount preamble
                              exposes as loom_lakehouses['<name>'] — copyable. An
                              honest gate tooltip when storage isn't configured. */}
                          {resolved?.abfss && (
                            <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingVerticalXS }}>
                              <Caption1
                                style={{ flex: 1, fontFamily: tokens.fontFamilyMonospace, fontSize: tokens.fontSizeBase100, color: tokens.colorNeutralForeground3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                                title={resolved.abfss}
                              >{resolved.abfss}</Caption1>
                              <Tooltip content={`Copy abfss path (use as loom_lakehouses['${src.displayName}'])`} relationship="label">
                                <Button
                                  size="small"
                                  appearance="subtle"
                                  icon={<Copy20Regular />}
                                  onClick={(e) => { e.stopPropagation(); void navigator.clipboard?.writeText(resolved.abfss || ''); }}
                                />
                              </Tooltip>
                            </div>
                          )}
                          {!resolved?.abfss && resolved?.hint && (
                            <Tooltip content={resolved.hint} relationship="description">
                              <Caption1 style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingVerticalXS, color: tokens.colorPaletteYellowForeground1, fontSize: tokens.fontSizeBase100 }}>
                                <Info16Regular /> path not configured
                              </Caption1>
                            </Tooltip>
                          )}
                        </div>
                      </TreeItemLayout>
                    </TreeItem>
                    );
                  })}
                </Tree>
              )}
              <Button size="small" appearance="outline" icon={<Add20Regular />} onClick={openAttach} disabled={!workspaceId} style={{ marginTop: tokens.spacingVerticalS, alignSelf: 'flex-start' }}>
                Add data items
              </Button>
            </>
          )}

          {/* AML path: Datastores sidebar — Azure ML studio "Data > Datastores"
              parity. Click or drag a datastore's abfss:// / wasbs:// path into a
              code cell. Honest gate inside when AML isn't configured. */}
          {workspaceType === 'aml' && (
            <DatastoreExplorer onInsertPath={insertDatastorePath} />
          )}
        </div>
      }
      main={
        <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <div className={s.pad} style={{ flex: 1, minWidth: 0 }}>
          {/* SC-6 — teaching banner: what runs the cells + the data/compute model. */}
          <TeachingBanner
            surfaceKey="notebook"
            title="Cells run on real Spark, Databricks, or Azure ML compute"
            message="Pick a compute target in Compute & setup, then Run — each cell executes against a live Livy / Databricks / Azure ML session (never a mock). Attach data items in the left explorer to reference them by name, and Copilot can draft or explain a cell inline. AutoSave keeps your work; the status bar shows the session state and the selected cell."
            learnMoreHref={loomDocUrl('fiab/parity/notebook')}
          />
          {/* Slim always-visible compute bar: Run + selected-compute summary +
              the Compute & setup disclosure + Copilot. The full configuration
              (backend / workspace / compute / environment / session) collapses
              below so the cells get the vertical space (operator request). */}
          <div className={s.computeBar}>
            <Badge appearance="filled" color="brand">Loom Notebook</Badge>
            <Button
              appearance="primary"
              icon={<Play20Regular />}
              disabled={running || !notebookId || !computeId}
              title={!notebookId ? 'Open or create a notebook first'
                : !computeId ? 'Select a compute target first (open Compute & setup)'
                : undefined}
              onClick={run}
            >{running ? 'Queuing…' : 'Run'}</Button>
            {computeId ? (
              <span className={s.computeSummary}>
                <Server20Regular />
                <Caption1 className={s.computeSummaryName} title={selectedCompute?.name || computeId}>
                  {selectedCompute?.name || computeId}
                </Caption1>
                {selectedCompute?.state && (
                  <Badge appearance="filled" size="small" color={isComputeRunning(selectedCompute?.state) ? 'success' : 'warning'}>
                    {selectedCompute.state}
                  </Badge>
                )}
                <Badge appearance="outline" size="small" color={clusterRuntime === 'databricks' ? 'important' : clusterRuntime === 'azure-ml' ? 'success' : 'brand'}>
                  {RUNTIME_LABEL[clusterRuntime]} syntax
                </Badge>
                {sparkPoolName && warmPool?.enabled && (
                  <Tooltip
                    relationship="label"
                    content={warmPool.warmForPool
                      ? 'A pre-warmed Spark session is on standby — your next run starts instantly instead of cold-starting the pool.'
                      : 'No warm session on standby yet — the next run cold-starts the Synapse Spark pool (~2 min). The warm pool refills in the background so later runs are instant.'}
                  >
                    <Badge
                      appearance="tint"
                      size="small"
                      color={warmPool.warmForPool ? 'success' : 'warning'}
                      icon={<Flash16Regular />}
                    >
                      {warmPool.warmForPool ? 'Warm session ready' : 'Cold start (~2 min)'}
                    </Badge>
                  </Tooltip>
                )}
              </span>
            ) : (
              <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>No compute selected</Caption1>
            )}
            <Button
              appearance="subtle"
              icon={setupOpen ? <ChevronUp20Regular /> : <ChevronDown20Regular />}
              aria-expanded={setupOpen}
              onClick={() => setSetupOpen((v) => !v)}
              title="Show or hide compute backend, workspace, environment, and session settings"
            >{setupOpen ? 'Hide setup' : 'Compute & setup'}</Button>
            <Button appearance={copilotOpen ? 'primary' : 'outline'} icon={<Sparkle20Regular />} onClick={() => setCopilotOpen((v) => !v)}>Copilot</Button>
          </div>
          {setupOpen && (
          <div className={s.toolbar}>
            {/* Compute backend toggle — Loom-native Spark/Databricks vs the
                Azure ML Compute Instance path. Default Loom; flip to Azure ML
                for a CI + datastores. No Fabric dependency on either path. */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS }}>
              <Caption1>Compute backend</Caption1>
              <div style={{ display: 'flex', gap: tokens.spacingHorizontalNone }}>
                <Button
                  size="small"
                  appearance={workspaceType === 'loom' ? 'primary' : 'outline'}
                  onClick={() => setWorkspaceType('loom')}
                  style={{ borderTopRightRadius: 0, borderBottomRightRadius: 0 }}
                >Loom (Spark)</Button>
                <Button
                  size="small"
                  appearance={workspaceType === 'aml' ? 'primary' : 'outline'}
                  onClick={() => setWorkspaceType('aml')}
                  style={{ borderTopLeftRadius: 0, borderBottomLeftRadius: 0 }}
                  title={amlConfigured === false ? 'Azure ML workspace not configured — the picker will explain what to set' : 'Run on an Azure ML Compute Instance'}
                >Azure ML</Button>
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, minWidth: 240 }}>
              <Caption1>Workspace</Caption1>
              <Select aria-label="Workspace" value={workspaceId} onChange={(_, d) => setWorkspaceId(d.value)} disabled={ws.loading || (ws.workspaces?.length ?? 0) === 0}>
                {!workspaceId && <option value="">{ws.loading ? 'Loading workspaces…' : 'Select a workspace'}</option>}
                {(ws.workspaces || []).map((w) => (
                  <option key={w.id} value={w.id}>{w.name}{w.isOnDedicatedCapacity ? ' · dedicated' : ''}</option>
                ))}
              </Select>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, minWidth: 280 }}>
              <Caption1>{workspaceType === 'aml' ? 'Compute Instance' : 'Compute target'}</Caption1>
              <div style={{ display: 'flex', gap: tokens.spacingVerticalS, alignItems: 'flex-end' }}>
                <div style={{ flex: 1 }}>
                  <Select aria-label="Compute target" value={computeId} onChange={(_, d) => setComputeId(d.value)} disabled={cp.loading || cp.computes.length === 0}>
                    {!computeId && <option value="">{cp.loading ? 'Loading compute…' : (workspaceType === 'aml' ? 'Select a Compute Instance' : 'Select compute')}</option>}
                    {cp.computes
                      .filter(computeMatchesType)
                      .map(c => (
                        <option key={c.id} value={c.id}>{c.name}{c.state ? ` · ${c.state}` : ''}</option>
                      ))}
                  </Select>
                </div>
                {computeId && (
                  <Badge
                    appearance="filled"
                    color={isComputeRunning(selectedCompute?.state) ? 'success' : 'warning'}
                    size="small"
                  >
                    {selectedCompute?.state || 'unknown'}
                  </Badge>
                )}
                {computeId && (
                  <Badge
                    appearance="outline"
                    color={clusterRuntime === 'databricks' ? 'important' : clusterRuntime === 'azure-ml' ? 'success' : 'brand'}
                    size="small"
                    title={`IntelliSense, syntax, and Copilot are tuned for ${RUNTIME_LABEL[clusterRuntime]}. Switching the compute switches them.`}
                  >
                    {RUNTIME_LABEL[clusterRuntime]} syntax
                  </Badge>
                )}
                {/* Start a terminated cluster / paused pool / stopped AML CI here. */}
                {computeId && selectedCompute && !isComputeRunning(selectedCompute.state) &&
                  (selectedCompute.kind === 'databricks-cluster' || selectedCompute.kind === 'synapse-dedicated-sql' || selectedCompute.kind === 'aml-ci') && (
                  <Button
                    appearance="primary"
                    size="small"
                    icon={<Play20Regular />}
                    disabled={startingCompute}
                    onClick={startCompute}
                  >
                    {startingCompute ? 'Starting…' : 'Start compute'}
                  </Button>
                )}
                {/* Stop a running AML Compute Instance (deallocates → stops billing). */}
                {computeId && selectedCompute && selectedCompute.kind === 'aml-ci' && isComputeRunning(selectedCompute.state) && (
                  <Button
                    appearance="outline"
                    size="small"
                    icon={<Stop20Regular />}
                    disabled={stoppingCompute}
                    onClick={stopComputeCi}
                  >
                    {stoppingCompute ? 'Stopping…' : 'Stop compute'}
                  </Button>
                )}
                {/* Configure the selected CI's idle auto-shutdown TTL. */}
                {computeId && selectedCompute && selectedCompute.kind === 'aml-ci' && (
                  <Button
                    appearance="outline"
                    size="small"
                    icon={<Settings20Regular />}
                    onClick={() => { setConfigCiErr(null); setConfigCiOpen(true); }}
                    title="Set the idle auto-shutdown time for this Compute Instance"
                  >Configure compute</Button>
                )}
              </div>
              {/* Per-user + custom Compute Instance actions. "Create my compute
                  instance" is the multi-user path: a CI is single-user, so each
                  user provisions one assigned to THEM. Shown when the user has no
                  own CI yet (and per-user CIs are enabled). "New compute
                  instance" remains for a named/custom CI. */}
              {workspaceType === 'aml' && (
                <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', alignItems: 'center', marginTop: tokens.spacingVerticalXS }}>
                  {myCi.enabled && !myCi.mine && (
                    <Button
                      appearance="primary"
                      size="small"
                      icon={<Add20Regular />}
                      disabled={amlConfigured === false || provisioningMyCi || myCi.loading || !!myCi.quota?.atLimit}
                      onClick={provisionMyCi}
                      title={
                        amlConfigured === false ? 'Azure ML workspace not configured'
                          : myCi.quota?.atLimit ? 'Per-user Compute Instance limit reached'
                          : `Provision your own Compute Instance (${myCi.myName || 'ci-loom-…'}), assigned to you`
                      }
                    >{provisioningMyCi ? 'Provisioning…' : 'Create my compute instance'}</Button>
                  )}
                  {myCi.mine && (
                    <Badge appearance="tint" color="brand" size="small" title={`Your Compute Instance ${myCi.mine.name} is assigned to you`}>
                      My compute: {myCi.mine.name}{myCi.mine.state ? ` · ${myCi.mine.state}` : ''}
                    </Badge>
                  )}
                  <Button
                    appearance="outline"
                    size="small"
                    icon={<Add20Regular />}
                    disabled={amlConfigured === false}
                    onClick={() => { setNewCiErr(null); setNewCiOpen(true); }}
                    title={amlConfigured === false ? 'Azure ML workspace not configured' : 'Create a new named Azure ML Compute Instance'}
                  >New compute instance</Button>
                </div>
              )}
            </div>
            <Divider vertical className={s.toolDivider} />
            <Button appearance="outline" icon={<ArrowSync20Regular />} onClick={() => workspaceId && loadList(workspaceId)} disabled={!workspaceId}>Refresh</Button>
            {/* Library & Environment: compact AML environment selector (Fabric ribbon parity). */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, minWidth: 240 }}>
              <Caption1>Environment (libraries)</Caption1>
              <div style={{ display: 'flex', gap: tokens.spacingHorizontalXS, alignItems: 'center' }}>
                <Select
                  aria-label="AML environment"
                  style={{ flex: 1 }}
                  value={attachedAmlEnv?.name || ''}
                  onChange={(_, d) => selectAmlEnv(d.value)}
                  disabled={!notebookId}
                >
                  <option value="">No environment attached</option>
                  {amlEnvs.map((e) => (
                    <option key={e.name} value={e.name}>{e.name}{e.latestVersion ? `:${e.latestVersion}` : ''}</option>
                  ))}
                </Select>
                <Button
                  appearance="outline"
                  icon={<Library20Regular />}
                  disabled={!notebookId}
                  title="Manage environment — libraries, packages, custom .jar"
                  onClick={() => setEnvPanelOpen(true)}
                >Manage</Button>
              </div>
            </div>
            {/* Import a desktop notebook file directly into this workspace. */}
            <input
              ref={fileInputRef}
              type="file"
              accept=".ipynb,.py,.sql,.scala,.r"
              style={{ display: 'none' }}
              onChange={onImportFileChange}
            />
            <Button
              appearance="outline"
              icon={<ArrowUpload20Regular />}
              disabled={!workspaceId || importing}
              title={!workspaceId ? 'Select a workspace first' : 'Import .ipynb / .py / .sql / .scala / .r from your computer'}
              onClick={() => fileInputRef.current?.click()}
            >{importing ? 'Importing…' : 'Import'}</Button>
            <Dialog open={createOpen} onOpenChange={(_, d) => setCreateOpen(d.open)}>
              <DialogTrigger disableButtonEnhancement>
                <Button appearance="outline" icon={<Add20Regular />} disabled={!workspaceId}>New</Button>
              </DialogTrigger>
              <DialogSurface>
                <DialogBody>
                  <DialogTitle>{workspaceType === 'aml' ? 'New notebook (Azure ML)' : 'Create notebook'}</DialogTitle>
                  <DialogContent>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS }}>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS }}>
                        <Caption1>Name</Caption1>
                        <Input placeholder="My notebook" value={createName} onChange={(_, d) => setCreateName(d.value)} style={{ width: '100%' }} />
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS }}>
                        <Caption1>Kernel</Caption1>
                        <Select aria-label="Kernel" value={createKernel} onChange={(_, d) => setCreateKernel(d.value as 'python' | 'r')}>
                          <option value="python">Python 3.10</option>
                          <option value="r">R</option>
                        </Select>
                      </div>
                      {createErr && <MessageBar intent="error"><MessageBarBody>{createErr}</MessageBarBody></MessageBar>}
                    </div>
                  </DialogContent>
                  <DialogActions>
                    <Button appearance="secondary" onClick={() => setCreateOpen(false)}>Cancel</Button>
                    <Button appearance="primary" disabled={createBusy || !createName.trim()} onClick={create}>{createBusy ? 'Creating…' : 'Create'}</Button>
                  </DialogActions>
                </DialogBody>
              </DialogSurface>
            </Dialog>
            {/* Configure compute — idle auto-shutdown TTL for the selected CI. */}
            <ConfigureComputeDialog
              open={configCiOpen}
              onClose={() => setConfigCiOpen(false)}
              selectedCompute={selectedCompute}
              ttl={configCiTtl}
              onTtlChange={setConfigCiTtl}
              err={configCiErr}
              busy={configCiBusy}
              onSave={saveCiIdleShutdown}
            />
            {/* New Compute Instance — name + VM size + idle TTL (dropdowns only). */}
            <NewComputeInstanceDialog
              open={newCiOpen}
              onClose={() => setNewCiOpen(false)}
              name={newCiName}
              onNameChange={setNewCiName}
              vmSize={newCiVmSize}
              onVmSizeChange={setNewCiVmSize}
              ttl={newCiTtl}
              onTtlChange={setNewCiTtl}
              err={newCiErr}
              busy={newCiBusy}
              onCreate={createCiInstance}
            />
            {/*
              Save lives in the ribbon (Home → Item → Save) now that the
              ribbon actions are wired. Avoid a second Save here so users
              aren't confused by two visually-identical Save buttons.
              Ctrl+S still works from anywhere.
            */}
            <Button
              appearance="outline"
              icon={<Settings20Regular />}
              disabled={cfgSaving}
              title="Set Spark session executors, memory, and idle timeout"
              onClick={openConfigDialog}
            >Configure session</Button>
            <Button appearance="outline" icon={<History20Regular />} disabled={!notebookId} onClick={() => setHistoryOpen(true)}>History</Button>
            {/* VS Code for the Web — Commercial-only deep-link to the AML
                compute-instance editor. Hidden in Gov boundaries (GCC / GCC-High
                / DoD) where VS Code for the Web is unavailable, and only shown
                when a real AML instance + workspace are configured (no dead button). */}
            {notebookId && vscodeWeb.enabled && vscodeWeb.url && (
              <Button
                as="a"
                href={vscodeWeb.url}
                target="_blank"
                rel="noopener noreferrer"
                appearance="outline"
                icon={<Open20Regular />}
              >Open in VS Code for Web</Button>
            )}
            <Button appearance="outline" icon={<BracesVariable20Regular />} disabled={!notebookId} onClick={() => setVariablesOpen(true)}>Variables</Button>
            <Button appearance="outline" icon={<Flash16Regular />} onClick={() => setWranglerOpen(true)}>Data Wrangler</Button>
            <Button appearance="subtle" icon={<Delete20Regular />} disabled={!notebookId} onClick={del}>Delete</Button>
          </div>
          )}

          {/* Phase 3: HistoryDrawer — right-side OverlayDrawer wired to /jobs */}
          <HistoryDrawer
            open={historyOpen}
            onOpenChange={setHistoryOpen}
            notebookId={notebookId}
            workspaceId={workspaceId}
            computeId={computeId}
            onRerun={run}
          />

          {/* Library & Environment management dialog */}
          <Dialog open={envPanelOpen} onOpenChange={(_, d) => setEnvPanelOpen(d.open)}>
            <DialogSurface style={{ maxWidth: 640 }}>
              <DialogBody>
                <DialogContent>
                  <EnvironmentPanel
                    notebookId={notebookId}
                    workspaceId={workspaceId}
                    attached={attachedAmlEnv}
                    customLibraries={customLibraries}
                    onAttached={(env) => { setAttachedAmlEnv(env); void loadAmlEnvs(); }}
                    onJarsChanged={setCustomLibraries}
                    onPipInstall={installPipPackage}
                  />
                </DialogContent>
                <DialogActions>
                  <Button appearance="secondary" onClick={() => setEnvPanelOpen(false)}>Close</Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>

          {/* Variable explorer — right-side OverlayDrawer; inspects the live
              Livy session via the Task-3 execute path. Python-only, like
              Synapse Studio / Fabric. */}
          <VariablesPane
            open={variablesOpen}
            onOpenChange={setVariablesOpen}
            onInspect={inspectVariables}
            defaultLang={defaultLang}
          />

          {/* Data Wrangler — right-side OverlayDrawer; visual data-prep over a
              real pandas host (Fabric "Data Wrangler" 1:1). Exports pandas /
              PySpark code back into a notebook cell. */}
          <DataWranglerPanel
            open={wranglerOpen}
            onOpenChange={setWranglerOpen}
            onInsertCell={insertWranglerCell}
            dfVar="df"
            itemType={item.slug}
            itemId={id}
          />

          {/* Phase 2: Attach Lakehouse modal */}
          <Dialog open={attachOpen} onOpenChange={(_, d) => setAttachOpen(d.open)}>
            <DialogSurface>
              <DialogBody>
                <DialogTitle>Attach Lakehouse</DialogTitle>
                <DialogContent>
                  {availableLakehouses === null && <Spinner size="tiny" label="Loading lakehouses…" />}
                  {availableLakehouses && availableLakehouses.length === 0 && (
                    <EmptyState
                      icon={<Database24Regular />}
                      title="No lakehouses in this workspace"
                      body="Create a Lakehouse first from the workspace +New menu, then attach it so cells can read its OneLake mount."
                      primaryAction={{ label: 'Refresh', onClick: loadLakehouses, appearance: 'outline' }}
                    />
                  )}
                  {availableLakehouses && availableLakehouses.length > 0 && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, maxHeight: 320, overflow: 'auto', padding: tokens.spacingHorizontalXXS }}>
                      {availableLakehouses.map((lh) => {
                        const already = attachedSources.some(s => s.kind === 'lakehouse' && s.id === lh.id);
                        return (
                          <div key={lh.id} className={s.lakehouseCard}>
                            <div style={{ flex: 1 }}>
                              <Subtitle2>{lh.displayName}</Subtitle2>
                              {lh.description && <Caption1 style={{ display: 'block' }}>{lh.description}</Caption1>}
                            </div>
                            <Button size="small" appearance={already ? 'subtle' : 'primary'} disabled={already || attachBusy} onClick={() => { attachLakehouse(lh); setAttachOpen(false); }}>
                              {already ? 'Already attached' : 'Attach'}
                            </Button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </DialogContent>
                <DialogActions>
                  <Button appearance="outline" onClick={loadLakehouses}>Refresh</Button>
                  <Button appearance="secondary" onClick={() => setAttachOpen(false)}>Close</Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>

          {(ws.error || listErr) && (
            <MessageBar intent="error">
              <MessageBarBody>
                <MessageBarTitle>Couldn't load workspaces</MessageBarTitle>
                {ws.error || listErr}
                {(ws.hint || listHint) && <><br /><Caption1>{ws.hint || listHint}</Caption1></>}
              </MessageBarBody>
            </MessageBar>
          )}
          {detailErr && <MessageBar intent="error"><MessageBarBody>{detailErr}</MessageBarBody></MessageBar>}
          {/* Honest compute gate — a notebook with no runnable Spark/Databricks
              compute can't execute. Surface the discovery error, or name the env
              vars to provision, instead of silently disabling Run. */}
          {cp.error && (
            <MessageBar intent="error">
              <MessageBarBody>
                <MessageBarTitle>Compute discovery failed</MessageBarTitle>
                {cp.error}
              </MessageBarBody>
            </MessageBar>
          )}
          {!cp.loading && !cp.error && workspaceType === 'loom' && cp.computes.filter(c => c.kind === 'synapse-spark' || c.kind === 'databricks-cluster').length === 0 && (
            <MessageBar intent="warning">
              <MessageBarBody>
                <MessageBarTitle>No notebook compute is available</MessageBarTitle>
                Notebooks run on a Synapse Spark pool or a Databricks cluster. Provision one and
                set <code>LOOM_SYNAPSE_WORKSPACE</code> (Synapse Spark) or
                {' '}<code>LOOM_DATABRICKS_HOSTNAME</code> (Databricks) so it appears in the compute
                picker above. You can still edit and save cells without compute. Or switch the
                compute backend to <strong>Azure ML</strong> to run on a Compute Instance.
              </MessageBarBody>
            </MessageBar>
          )}
          {/* Honest per-user quota gate — the tenant hit its per-user CI ceiling
              (LOOM_AML_CI_MAX). Naming the exact limit + remediation per
              no-vaporware.md. */}
          {workspaceType === 'aml' && myCi.quota?.atLimit && !myCi.mine && (
            <MessageBar intent="warning">
              <MessageBarBody>
                <MessageBarTitle>Per-user Compute Instance limit reached</MessageBarTitle>
                {myCi.quota.used}/{myCi.quota.max} per-user Compute Instances are in use. An
                administrator can raise <code>LOOM_AML_CI_MAX</code>, or stop/delete unused Compute
                Instances in the Azure ML workspace to free capacity.
              </MessageBarBody>
            </MessageBar>
          )}
          {myCiErr && <MessageBar intent="error"><MessageBarBody>{myCiErr}</MessageBarBody></MessageBar>}
          {!cp.loading && !cp.error && workspaceType === 'aml' && amlConfigured !== false && myCi.enabled && !myCi.mine && !myCi.quota?.atLimit && cp.computes.filter(c => c.kind === 'aml-ci' && c.mine).length === 0 && (
            <MessageBar intent="info">
              <MessageBarBody>
                <MessageBarTitle>You don't have a compute instance yet</MessageBarTitle>
                Azure ML Compute Instances are single-user. Provision one assigned to you
                {myCi.myName ? <> (<code>{myCi.myName}</code>)</> : null} to run cells on your own
                compute — it auto-stops after {(myCi.policy?.idleTtl && TTL_LABEL[myCi.policy.idleTtl]) || '30 minutes'} idle.
              </MessageBarBody>
              <MessageBarActions>
                <Button size="small" appearance="primary" icon={<Add20Regular />} disabled={provisioningMyCi || myCi.loading} onClick={provisionMyCi}>
                  {provisioningMyCi ? 'Provisioning…' : 'Create my compute instance'}
                </Button>
              </MessageBarActions>
            </MessageBar>
          )}
          {!cp.loading && !cp.error && workspaceType === 'aml' && cp.computes.filter(c => c.kind === 'aml-ci').length === 0 && (amlConfigured === false || !myCi.enabled) && (
            <MessageBar intent="warning">
              <MessageBarBody>
                <MessageBarTitle>No Azure ML Compute Instance is available</MessageBarTitle>
                The Azure ML path runs cells on a Compute Instance. Set{' '}
                <code>LOOM_AML_WORKSPACE</code> + <code>LOOM_AML_REGION</code> to a deployed Azure
                Machine Learning workspace (the deploy-planner <code>mlWorkspace</code> module
                provisions one), grant the Console UAMI <strong>AzureML Data Scientist</strong>,
                then create a Compute Instance in that workspace. You can still edit and save cells
                without compute, or switch the backend to <strong>Loom (Spark)</strong>.
              </MessageBarBody>
            </MessageBar>
          )}
          {runMsg && <MessageBar intent="info"><MessageBarBody style={{ overflowWrap: 'anywhere', wordBreak: 'break-word', minWidth: 0 }}>{runMsg}</MessageBarBody></MessageBar>}

          {/* Honest receipt: the real Livy session-create body that provisioned
              the running Spark session. numExecutors here is what the session
              actually runs with — confirms the Configure-session sizing. */}
          {sessionReceipt && typeof sessionReceipt.numExecutors === 'number' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, minWidth: 0, maxWidth: '100%' }}>
              <MessageBar intent="success">
                <MessageBarBody style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
                  <MessageBarTitle>Spark session{sessionReceipt.reused ? ' (reused)' : ''}</MessageBarTitle>
                  Session {String(sessionReceipt.id ?? '—')} · <strong>{String(sessionReceipt.numExecutors)} executors</strong>
                  {sessionReceipt.executorMemory ? ` · ${String(sessionReceipt.executorMemory)} executor memory` : ''}
                  {sessionReceipt.driverMemory ? ` · ${String(sessionReceipt.driverMemory)} driver memory` : ''}
                  {typeof sessionReceipt.heartbeatTimeoutInSecond === 'number' ? ` · ${Math.round((sessionReceipt.heartbeatTimeoutInSecond as number) / 60)} min timeout` : ''}
                </MessageBarBody>
              </MessageBar>
              {/* Honest raw Livy receipt rendered as a SEPARATE block BELOW the
                  banner — NOT inside the MessageBar. A tall expanding <details>
                  inside MessageBarBody broke the bar's icon/body alignment when
                  opened. Collapsed by default; bounded + wrapped + scrollable so
                  expanding it just grows this block downward, cleanly. */}
              <details style={{ minWidth: 0, maxWidth: '100%' }}>
                <summary
                  style={{
                    cursor: 'pointer',
                    fontSize: tokens.fontSizeBase200,
                    color: tokens.colorNeutralForeground3,
                    userSelect: 'none',
                  }}
                >Raw Livy receipt</summary>
                <code
                  style={{
                    display: 'block',
                    marginTop: tokens.spacingVerticalXS,
                    padding: tokens.spacingHorizontalS,
                    borderRadius: tokens.borderRadiusSmall,
                    backgroundColor: tokens.colorNeutralBackground3,
                    color: tokens.colorNeutralForeground3,
                    fontFamily: tokens.fontFamilyMonospace,
                    fontSize: tokens.fontSizeBase100,
                    whiteSpace: 'pre-wrap',
                    overflowWrap: 'anywhere',
                    wordBreak: 'break-word',
                    maxWidth: '100%',
                    minWidth: 0,
                    maxHeight: 220,
                    overflow: 'auto',
                    boxSizing: 'border-box',
                  }}
                >{JSON.stringify(redactReceiptSecrets(sessionReceipt), null, 2)}</code>
              </details>
              {notebookId && workspaceId && computeId?.startsWith('spark:') && sessionReceipt.id != null && (
                <DriverLogPane
                  notebookId={notebookId}
                  workspaceId={workspaceId}
                  pool={computeId.slice('spark:'.length)}
                  sessionId={Number(sessionReceipt.id)}
                />
              )}
            </div>
          )}

          {notebookId && (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingVerticalS }}>
                {dirty && <Badge appearance="outline" color="warning">unsaved</Badge>}
                <AutosaveIndicator status={autosaveStatus} />
                <Caption1>{cells.length} cell{cells.length === 1 ? '' : 's'} · default lang <code>{defaultLang}</code></Caption1>
                <div style={{ flex: 1 }} />
                <Select size="small" value={defaultLang} onChange={(_, d) => { setDefaultLang(d.value as NotebookCellLang); setDirty(true); }} aria-label="Default cell language">
                  <option value="pyspark">PySpark (Python)</option>
                  <option value="spark">Spark (Scala)</option>
                  <option value="sparksql">Spark SQL</option>
                  <option value="sparkr">SparkR (R)</option>
                  <option value="python">Python</option>
                  <option value="tsql">T-SQL</option>
                </Select>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS }}>
                <CellAdder
                  onAddCode={() => insertCell(-1, 'code')}
                  onAddMarkdown={() => insertCell(-1, 'markdown')}
                />
                {cells.map((c, idx) => (
                  <div
                    key={c.id}
                    ref={(el) => { cellRefs.current.set(c.id, el); }}
                    onDragOver={(e) => { if (dragIndexRef.current != null) { e.preventDefault(); setDragOverId(c.id); } }}
                    onDrop={(e) => { e.preventDefault(); onCellDrop(idx); }}
                    style={dragOverId === c.id ? { outline: `2px dashed ${tokens.colorBrandStroke1}`, outlineOffset: 2, borderRadius: tokens.borderRadiusMedium } : undefined}
                  >
                    {/* R4-NB-2 — parameters-cell chip (papermill). */}
                    {c.type === 'code' && c.parameters && (
                      <div className={s.paramBadgeRow}>
                        <Badge appearance="tint" color="brand" size="small" icon={<BracesVariable20Regular />}>Parameters</Badge>
                        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Overridable on Run with parameters</Caption1>
                      </div>
                    )}
                    {c.type === 'code' ? (
                      <CodeCell
                        cell={c}
                        active={activeCellId === c.id}
                        onFocus={() => setActiveCellId(c.id)}
                        onChange={(next) => updateCell(c.id, next)}
                        onRun={runCell}
                        onStop={() => stopCell(c.id)}
                        onDelete={() => deleteCell(c.id)}
                        onMoveUp={() => moveCell(c.id, -1)}
                        onMoveDown={() => moveCell(c.id, 1)}
                        onDuplicate={() => duplicateCell(c.id)}
                        onConvertToMarkdown={() => convertCell(c.id, 'markdown')}
                        canMoveUp={idx > 0}
                        canMoveDown={idx < cells.length - 1}
                        dragHandleProps={{
                          draggable: true,
                          onDragStart: () => { dragIndexRef.current = idx; },
                          onDragEnd: () => { dragIndexRef.current = null; setDragOverId(null); },
                        }}
                        notebookId={notebookId}
                        workspaceId={workspaceId}
                        computeId={computeId}
                        runtime={clusterRuntime}
                        lspWsUrl={lspWsUrl}
                        priorCells={cells.slice(0, idx).filter(pc => pc.type === 'code').slice(-3).map(pc => pc.source)}
                        schemaContext={inlineSchemaContext}
                        onInsertBelow={(newCell) => {
                          setCells(prev => {
                            const spliceIdx = prev.findIndex(cell => cell.id === c.id);
                            if (spliceIdx < 0) return [...prev, newCell];
                            const next = [...prev];
                            next.splice(spliceIdx + 1, 0, newCell);
                            return next;
                          });
                          setActiveCellId(newCell.id);
                          setDirty(true);
                        }}
                      />
                    ) : null}
                    {/* R4-NB-4 — live Spark progress under a running code cell. */}
                    {c.type === 'code' && c.output?.status === 'pending' && (
                      <RunProgress
                        progress={cellProgress.get(c.id)}
                        phase={runPhase || undefined}
                        elapsedSec={(() => { const startedAt = cellRunStartRef.current.get(c.id); return startedAt ? Math.floor((nowTs - startedAt) / 1000) : undefined; })()}
                      />
                    )}
                    {c.type === 'markdown' && (
                      <MarkdownCell
                        cell={c}
                        active={activeCellId === c.id}
                        onFocus={() => setActiveCellId(c.id)}
                        onChange={(next) => updateCell(c.id, next)}
                        onDelete={() => deleteCell(c.id)}
                        onMoveUp={() => moveCell(c.id, -1)}
                        onMoveDown={() => moveCell(c.id, 1)}
                        onDuplicate={() => duplicateCell(c.id)}
                        onConvertToCode={() => convertCell(c.id, 'code')}
                        canMoveUp={idx > 0}
                        canMoveDown={idx < cells.length - 1}
                        dragHandleProps={{
                          draggable: true,
                          onDragStart: () => { dragIndexRef.current = idx; },
                          onDragEnd: () => { dragIndexRef.current = null; setDragOverId(null); },
                        }}
                      />
                    )}
                    <CellAdder
                      onAddCode={() => insertCell(idx, 'code')}
                      onAddMarkdown={() => insertCell(idx, 'markdown')}
                    />
                  </div>
                ))}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingVerticalS }}>
                <Subtitle2 className={s.sectionHeader}><History16Regular /> Run history ({jobs.length})</Subtitle2>
                <Button size="small" appearance="subtle" icon={<ArrowSync20Regular />} onClick={() => loadJobs(workspaceId, notebookId)}>Refresh</Button>
              </div>
              <div className={s.tableWrap}>
                <Table aria-label="Jobs" size="small">
                  <TableHeader><TableRow>
                    <TableHeaderCell>Job ID</TableHeaderCell>
                    <TableHeaderCell>Status</TableHeaderCell>
                    <TableHeaderCell>Invoke</TableHeaderCell>
                    <TableHeaderCell>Start</TableHeaderCell>
                    <TableHeaderCell>End</TableHeaderCell>
                    <TableHeaderCell>Failure</TableHeaderCell>
                  </TableRow></TableHeader>
                  <TableBody>
                    {jobs.length === 0 && <TableRow><TableCell colSpan={6}>No runs yet.</TableCell></TableRow>}
                    {jobs.map((j) => (
                      <TableRow key={j.id}>
                        <TableCell className={s.cell}>{j.id.slice(0, 8)}</TableCell>
                        <TableCell>{j.status || '—'}</TableCell>
                        <TableCell>{j.invokeType || '—'}</TableCell>
                        <TableCell className={s.cell}>{j.startTimeUtc || '—'}</TableCell>
                        <TableCell className={s.cell}>{j.endTimeUtc || '—'}</TableCell>
                        <TableCell className={s.cell}>{j.failureReason?.message || ''}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </>
          )}

          {/* ── R4-NB-1 Notebook schedules (AML job schedules) ─────────────── */}
          {notebookId && schedulesConfigured === false && scheduleGateHint && (
            <MessageBar intent="warning">
              <MessageBarBody>
                <MessageBarTitle>Notebook scheduling not configured</MessageBarTitle>
                {scheduleGateHint} Bicep: <code>platform/fiab/bicep/modules/deploy-planner/ml-workspace.bicep</code>.
              </MessageBarBody>
              <MessageBarActions>
                <Button size="small" onClick={refreshSchedules}>Re-check</Button>
              </MessageBarActions>
            </MessageBar>
          )}
          {notebookId && schedulesConfigured && (
            <div className={s.scheduleCard}>
              <div className={s.scheduleHead}>
                <CalendarClock20Regular />
                <Subtitle2>Schedules ({schedules.length})</Subtitle2>
                <div className={s.cardSpacer} />
                <Button size="small" appearance="subtle" icon={<ArrowSync20Regular />} onClick={refreshSchedules}>Refresh</Button>
                <Button size="small" appearance="primary" icon={<CalendarClock16Regular />} onClick={() => setScheduleWizardOpen(true)}>New schedule</Button>
              </div>
              {schedules.length === 0 ? (
                <EmptyState
                  icon={<CalendarClock20Regular />}
                  title="No schedules yet"
                  body="Run this notebook on a recurrence with an Azure ML job schedule. Click New schedule to create one."
                  primaryAction={{ label: 'Create schedule', onClick: () => setScheduleWizardOpen(true) }}
                />
              ) : (
                <Table size="extra-small" aria-label="Notebook schedules">
                  <TableHeader>
                    <TableRow>
                      <TableHeaderCell>Name</TableHeaderCell>
                      <TableHeaderCell>Recurrence</TableHeaderCell>
                      <TableHeaderCell>Start</TableHeaderCell>
                      <TableHeaderCell>State</TableHeaderCell>
                      <TableHeaderCell aria-label="Actions" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {schedules.map((sc) => (
                      <TableRow key={sc.name}>
                        <TableCell>{sc.displayName || sc.name}</TableCell>
                        <TableCell>Every {sc.interval ?? 1} {String(sc.frequency || '').toLowerCase()}</TableCell>
                        <TableCell>{sc.startTime ? new Date(sc.startTime).toLocaleString() : '—'}</TableCell>
                        <TableCell>
                          <Switch
                            checked={sc.isEnabled}
                            onChange={(_, d) => toggleSchedule(sc.name, d.checked)}
                            aria-label={sc.isEnabled ? 'Enabled' : 'Disabled'}
                          />
                        </TableCell>
                        <TableCell>
                          <Button size="small" appearance="subtle" icon={<Delete20Regular />} aria-label={`Delete schedule ${sc.displayName || sc.name}`}
                            onClick={() => deleteSchedule(sc.name)} />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </div>
          )}

          <ScheduleWizard
            open={scheduleWizardOpen}
            onClose={() => { setScheduleWizardOpen(false); setScheduleError(null); }}
            onCreate={createSchedule}
            busy={scheduleBusy}
            error={scheduleError}
          />

          {/* R4-NB-2 — Run with parameters (papermill). */}
          <ParametersDialog
            open={paramsDialogOpen}
            onClose={() => setParamsDialogOpen(false)}
            parameterSource={parametersCell?.source || ''}
            onRun={runWithParameters}
            busy={running}
          />

          {/* R4-NB-3 — Resources pane (Loom-native file bundle). */}
          <ResourcesPane
            open={resourcesOpen}
            onOpenChange={setResourcesOpen}
            resources={resources}
            onChange={setResources}
            onPersist={persistResources}
            notebookOpen={!!notebookId}
          />

          {/* R4-NB-6 — Outline navigation. */}
          <OutlinePane
            open={outlineOpen}
            onOpenChange={setOutlineOpen}
            cells={cells}
            onJump={jumpToCell}
          />

          {/* R4-NB-8 — Inline rename. */}
          <NbRenameDialog
            open={renameOpen}
            onClose={() => setRenameOpen(false)}
            value={renameValue}
            onValueChange={setRenameValue}
            busy={renameBusy}
            onSubmit={() => void submitRename()}
          />

          {/* Configure session dialog — sliders + numeric field, no JSON. */}
          <SessionConfigDialog
            open={cfgDialogOpen}
            config={cfgDraft}
            onConfigChange={setCfgDraft}
            onApply={applySessionConfig}
            onClose={() => setCfgDialogOpen(false)}
          />

          {/* Bottom-left kernel/session status pill — live state color, Fabric
              kernel-indicator parity: Idle (green) / Starting (amber, session
              cold-start) / Busy (brand, statement executing) / Error (red).
              The Starting state is derived from the real Livy poll phase. */}
          {(() => {
            const starting = sessionStatus === 'Running' && runPhase === 'session-starting';
            const label = starting ? 'Starting' : sessionStatus === 'Running' ? 'Busy' : sessionStatus;
            const color = starting ? 'warning' : sessionStatus === 'Running' ? 'brand' : sessionStatus === 'Error' ? 'danger' : 'success';
            return (
              <Badge
                className={s.statusBadge}
                appearance="filled"
                color={color}
                icon={sessionStatus === 'Running' ? <Spinner size="extra-tiny" appearance="inverted" /> : undefined}
                title={
                  sessionReceipt && typeof sessionReceipt.numExecutors === 'number'
                    ? `Spark session ${sessionReceipt.id ?? ''} · ${sessionReceipt.numExecutors} executors · ${sessionReceipt.executorMemory ?? ''}`
                    : starting ? 'Spark session is starting (cold start)' : `Session ${label.toLowerCase()}`
                }
              >
                {label}{sessionReceipt && typeof sessionReceipt.numExecutors === 'number' ? ` · ${sessionReceipt.numExecutors} exec` : ''}
              </Badge>
            );
          })()}
        </div>
        <CopilotChatPane
          open={copilotOpen}
          onOpenChange={setCopilotOpen}
          notebookId={notebookId}
          workspaceId={workspaceId}
          cells={cells}
          activeCellId={activeCellId}
          attachedSources={attachedSources}
          defaultLang={defaultLang}
          runtime={clusterRuntime}
          notebookName={(notebooks || []).find((n) => n.id === notebookId)?.displayName || notebookId}
          sessionReceipt={sessionReceipt}
          sessionConfig={sessionCfg}
          onApplyCells={applyCells}
        />
        </div>
      }
    />
  );
}
