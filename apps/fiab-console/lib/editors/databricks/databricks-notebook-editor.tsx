'use client';

import { clientFetch } from '@/lib/client-fetch';
/**
 * Databricks Notebook editor — extracted verbatim from
 * databricks-editors.tsx (behavior-preserving split — zero logic change).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Subtitle2, Body1, Caption1, Badge, Button, Spinner, Dropdown, Option,
  Combobox,
  Input, Field, Switch, Textarea, Tooltip, Divider,
  Tab, TabList,
  Tree, TreeItem, TreeItemLayout,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Database20Regular, DocumentTable20Regular, Play20Regular, Stop20Regular,
  ArrowSync20Regular, Folder20Regular, Document20Regular,
  Save20Regular, Delete20Regular, Add20Regular, Key20Regular, Sparkle20Regular,
  Flowchart20Regular,
  DataBarVertical20Regular,
  TableAdd20Regular, Copy20Regular,
  Eye20Regular, MathFormula20Regular,
  ArrowDownload20Regular,
  Organization20Regular,
  Tag20Regular,
  CloudLink20Regular, PlugConnected20Regular,
  History20Regular, ShieldTask20Regular, Link20Regular,
  ArrowUpload20Regular, CloudArrowUp24Regular, Dismiss16Regular,
  BuildingShop20Regular, ShieldLock20Regular, People20Regular, Star20Regular,
} from '@fluentui/react-icons';
import { ModelViewPanel } from '../components/model-view-canvas';
import { ItemEditorChrome } from '../item-editor-chrome';
import { StatsMaintenanceDialog } from '../components/stats-maintenance-dialog';
import { WarehouseMonitoringTab } from '../components/warehouse-monitoring';
import { ConnectionDetailsPanel } from '../components/connection-details';
import { AiFunctionsHelper } from '../components/ai-functions-helper';
import { SqlObjectScriptMenu, SqlRowCountBadge } from '@/lib/components/sql-object-script-menu';
import { DatabricksWorkspaceTree } from '@/lib/components/databricks/databricks-workspace-tree';
import { UcLineagePanel } from '@/lib/components/databricks/uc-lineage-panel';
import { UcSecurityPanel } from '@/lib/panes/uc-security-panel';
import { PipelineDagView, type PipelineActivity } from '@/lib/components/pipeline/pipeline-dag-view';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';
import { MonacoTextarea } from '@/lib/components/editor/monaco-textarea';
import { useSqlTabs, SqlTabBar, getRunSql } from '@/lib/components/editor/sql-editor-kit';
import { registerSqlIntelliSense, createEmptyCache, type SqlSchemaCache } from '@/lib/components/editor/sql-intellisense';
import { WarehouseAlerts } from '../components/warehouse-alerts';
import { SqlCopilotEditor } from '@/lib/components/editor/sql-copilot-editor';
import { VisualQueryCanvas, type VqSourceTable } from '../components/visual-query-canvas';
import { downloadResultsCsv, downloadResultsJson } from '../components/result-export';
import { CodeCell } from '@/lib/components/notebook/code-cell';
import { MarkdownCell } from '@/lib/components/notebook/markdown-cell';
import { CellAdder } from '@/lib/components/notebook/cell-adder';
import type { NotebookCell, NotebookCellLang } from '@/lib/types/notebook-cell';
import { emptyCell } from '@/lib/types/notebook-cell';
import {
  parseSource, serializeCells,
  type DbxBaseLanguage,
} from '../databricks-notebook-source';
import { QueryParamsBar, substituteDbx, type QueryParam } from '../components/query-params';
import { ResultVisualize } from '../components/result-visualize';
import { useStyles, formatCell, clusterStateColor, runStateColor, fmtTime, fmtDuration, detectBase } from './shared';
import type { Cluster, WorkspaceObject, RunRow, CellResult } from './shared';
import { TeachingBanner } from '@/lib/components/shared/teaching-toast';
import { resolveDbxCommand } from './dbx-magics';
import { parseWidgets, buildWidgetPreamble, effectiveWidgetValues } from './dbx-widgets';
import { DbxWidgetsBar, type WidgetChangeBehavior } from '@/lib/components/databricks/dbx-widgets-bar';
import { DbxScheduleDialog } from '@/lib/components/databricks/dbx-schedule-dialog';
import { DbxVersionsDialog } from '@/lib/components/databricks/dbx-versions-dialog';
import { DbxDataProfileView } from '@/lib/components/databricks/dbx-data-profile-view';
import { VariablesPane, type VarRow } from '@/lib/components/notebook/variables-pane';
import { CopilotChatPane } from '@/lib/components/notebook/copilot-chat-pane';
import { RichDisplay } from '@/lib/components/notebook/rich-display';
import { buildDbxDataProfile } from './dbx-data-profile';
import { CalendarClock20Regular, Bot20Regular } from '@fluentui/react-icons';

export function DatabricksNotebookEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();

  // ---- Workspace tree ----
  const [rootPath, setRootPath] = useState('/Workspace');
  const [tree, setTree] = useState<Record<string, WorkspaceObject[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['/Workspace']));
  const [treeError, setTreeError] = useState<string | null>(null);

  // ---- Open notebook ----
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [baseLanguage, setBaseLanguage] = useState<DbxBaseLanguage>('PYTHON');
  const [loadingFile, setLoadingFile] = useState(false);
  const [savingFile, setSavingFile] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [fileMessage, setFileMessage] = useState<string | null>(null);

  // ---- Cells (the core of the editor) ----
  const [cells, setCells] = useState<NotebookCell[]>([emptyCell('code', 'python')]);
  const [origSerialized, setOrigSerialized] = useState<string>('');
  const [activeCellId, setActiveCellId] = useState<string | null>(null);
  const [cellResults, setCellResults] = useState<Record<string, CellResult>>({});

  // ---- Cluster + execution context ----
  const [clusters, setClusters] = useState<Cluster[]>([]);
  const [clusterId, setClusterId] = useState<string>('');
  const [clustersError, setClustersError] = useState<string | null>(null);
  // One execution context per (cluster, command-language) so REPL state
  // persists across cells of the same language. Keyed `${clusterId}:${lang}`.
  const contextsRef = useRef<Record<string, string>>({});
  const [runningAll, setRunningAll] = useState(false);

  // ---- R4-DBX: widgets, panes, dialogs ----
  const [widgetValues, setWidgetValues] = useState<Record<string, string>>({});
  const [widgetBehavior, setWidgetBehavior] = useState<WidgetChangeBehavior>('nothing');
  // Python contexts that already have the widget preamble applied for the
  // current values; cleared whenever a value changes so the next run re-applies.
  const widgetsAppliedRef = useRef<Set<string>>(new Set());
  const [varsOpen, setVarsOpen] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [copilotOpen, setCopilotOpen] = useState(false);

  const serialized = useMemo(() => serializeCells(cells, baseLanguage), [cells, baseLanguage]);
  const dirty = !!selectedPath && serialized !== origSerialized;

  // Widgets declared by any cell's dbutils.widgets.* / CREATE WIDGET calls.
  const widgets = useMemo(() => parseWidgets(cells.map((c) => c.source)), [cells]);
  // Default-language for the shared panes (Copilot / variable explorer).
  const paneLang: NotebookCellLang = baseLanguage === 'SQL' ? 'sparksql'
    : baseLanguage === 'SCALA' ? 'spark'
    : baseLanguage === 'R' ? 'sparkr' : 'python';

  // ---- Load tree + clusters on mount ----
  const loadDir = useCallback(async (path: string) => {
    try {
      const r = await clientFetch(`/api/items/databricks-notebook/list?path=${encodeURIComponent(path)}`);
      const j = await r.json();
      if (!j.ok) { setTreeError(j.error || `HTTP ${r.status}`); return; }
      setTreeError(null);
      setTree((t) => ({ ...t, [path]: (j.objects || []) as WorkspaceObject[] }));
    } catch (e: any) {
      setTreeError(e?.message || String(e));
    }
  }, []);

  const loadClusters = useCallback(async () => {
    try {
      const r = await clientFetch('/api/items/databricks-cluster');
      const j = await r.json();
      if (!j.ok) { setClustersError(j.error || `HTTP ${r.status}`); return; }
      setClustersError(null);
      const list = (j.clusters || []) as Cluster[];
      setClusters(list);
      setClusterId((prev) => {
        if (prev && list.some((c) => c.cluster_id === prev)) return prev;
        const running = list.find((c) => c.state === 'RUNNING');
        return running ? running.cluster_id : (list[0]?.cluster_id || '');
      });
    } catch (e: any) {
      setClustersError(e?.message || String(e));
    }
  }, []);

  useEffect(() => {
    void loadDir(rootPath);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootPath]);
  useEffect(() => { void loadClusters(); }, [loadClusters]);

  // ---- Hydrate from the installed item's bundle cells ----
  // A bundle-installed databricks-notebook has its NotebookContent cells
  // stamped into Cosmos (state.cells, or state.content.cells when only the
  // NotebookContent shape was written). The live-workspace tree on the left
  // doesn't surface those, so on mount we open the item populated with every
  // markdown + code cell instead of a single empty cell — the bundle content
  // is no longer stranded. Once the user clicks a real workspace path the
  // openNotebook flow takes over (export from the live Databricks workspace).
  useEffect(() => {
    if (!id || id === 'new') return;
    let cancelled = false;
    (async () => {
      try {
        const r = await clientFetch(`/api/cosmos-items/databricks-notebook/${encodeURIComponent(id)}`);
        if (!r.ok) return;
        const item = await r.json();
        if (cancelled) return;
        const st = (item?.state as any) || {};
        const raw: any[] = (Array.isArray(st.cells) && st.cells.length > 0)
          ? st.cells
          : (st.content?.kind === 'notebook' && Array.isArray(st.content.cells) ? st.content.cells : []);
        if (raw.length === 0) return;
        const hydrated: NotebookCell[] = raw.map((c, i) => ({
          id: typeof c?.id === 'string' && c.id ? c.id : `bundle-${i}`,
          type: c?.type === 'markdown' ? 'markdown' : 'code',
          lang: (c?.lang || c?.language || st.defaultLang || st.content?.defaultLang || 'python') as NotebookCell['lang'],
          source: typeof c?.source === 'string' ? c.source : Array.isArray(c?.source) ? c.source.join('') : '',
        }));
        setCells(hydrated);
        setBaseLanguage('PYTHON');
        setOrigSerialized(serializeCells(hydrated, 'PYTHON'));
        setActiveCellId(hydrated[0]?.id || null);
        setFileMessage('Loaded notebook cells from the installed app bundle. Click a workspace notebook on the left to open the deployed copy.');
      } catch { /* fall back to the empty starter cell */ }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const toggle = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else { next.add(path); if (!tree[path]) void loadDir(path); }
      return next;
    });
  }, [tree, loadDir]);

  // ---- Open a notebook: export SOURCE, parse to cells ----
  const openNotebook = useCallback(async (path: string, lang?: string) => {
    setSelectedPath(path);
    setFileError(null);
    setFileMessage(null);
    setLoadingFile(true);
    setCellResults({});
    try {
      const r = await clientFetch(`/api/items/databricks-notebook/${id}?path=${encodeURIComponent(path)}`);
      const j = await r.json();
      if (!j.ok) { setFileError(j.error || `HTTP ${r.status}`); return; }
      const base = detectBase(lang || j.language);
      setBaseLanguage(base);
      const parsed = parseSource(j.content || '', base);
      setCells(parsed);
      setOrigSerialized(serializeCells(parsed, base));
      setActiveCellId(parsed[0]?.id || null);
    } catch (e: any) {
      setFileError(e?.message || String(e));
    } finally {
      setLoadingFile(false);
    }
  }, [id]);

  // ---- Save: serialise cells -> SOURCE -> workspace/import ----
  const save = useCallback(async () => {
    if (!selectedPath) return;
    setSavingFile(true);
    setFileError(null);
    setFileMessage(null);
    const snapshot = serializeCells(cells, baseLanguage);
    try {
      const r = await clientFetch(`/api/items/databricks-notebook/${id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: selectedPath, language: baseLanguage, content: snapshot }),
      });
      const j = await r.json();
      if (!j.ok) setFileError(j.error || `HTTP ${r.status}`);
      else {
        setOrigSerialized(snapshot);
        setFileMessage(`Saved to ${selectedPath} at ${new Date().toLocaleTimeString()}`);
        // R4-DBX-3: capture a SOURCE version snapshot on every successful save
        // (best-effort — never blocks the save).
        void clientFetch(`/api/items/databricks-notebook/${id}/versions`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path: selectedPath, language: baseLanguage, source: snapshot, description: 'Saved' }),
        }).catch(() => { /* versioning is best-effort */ });
      }
    } catch (e: any) {
      setFileError(e?.message || String(e));
    } finally {
      setSavingFile(false);
    }
  }, [id, selectedPath, baseLanguage, cells]);

  // Ctrl/Cmd+S
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (selectedPath && dirty && !savingFile) save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedPath, dirty, savingFile, save]);

  // ---- New notebook in the workspace ----
  const newNotebook = useCallback(async () => {
    const suggested = `${rootPath.replace(/\/$/, '')}/loom-notebook-${Date.now()}`;
    const path = window.prompt('New notebook path', suggested);
    if (!path) return;
    setFileError(null); setFileMessage(null);
    const starter = [emptyCell('code', 'python')];
    const src = serializeCells(starter, 'PYTHON');
    try {
      const r = await clientFetch(`/api/items/databricks-notebook/${id}`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path, language: 'PYTHON', content: src }),
      });
      const j = await r.json();
      if (!j.ok) { setFileError(j.error || `HTTP ${r.status}`); return; }
      setTree({}); void loadDir(rootPath);
      await openNotebook(path, 'PYTHON');
    } catch (e: any) { setFileError(e?.message || String(e)); }
  }, [id, rootPath, loadDir, openNotebook]);

  // ---- Delete a notebook from the tree ----
  const deleteObject = useCallback(async (path: string, isDir: boolean) => {
    if (!window.confirm(`Delete ${path}${isDir ? ' (and contents)' : ''}?`)) return;
    try {
      const qs = `path=${encodeURIComponent(path)}${isDir ? '&recursive=true' : ''}`;
      const r = await clientFetch(`/api/items/databricks-notebook/${id}?${qs}`, { method: 'DELETE' });
      const j = await r.json();
      if (!j.ok) { setTreeError(j.error || `HTTP ${r.status}`); return; }
      if (selectedPath === path) { setSelectedPath(null); setCells([emptyCell('code', 'python')]); }
      setTree({}); void loadDir(rootPath);
    } catch (e: any) { setTreeError(e?.message || String(e)); }
  }, [id, rootPath, loadDir, selectedPath]);

  // ---- Cell mutations ----
  const updateCell = useCallback((next: NotebookCell) => {
    setCells((cs) => cs.map((c) => (c.id === next.id ? next : c)));
  }, []);
  const addCell = useCallback((type: 'code' | 'markdown', afterId?: string) => {
    const fresh = emptyCell(type, type === 'code' ? 'python' : 'python');
    setCells((cs) => {
      if (!afterId) return [...cs, fresh];
      const idx = cs.findIndex((c) => c.id === afterId);
      if (idx < 0) return [...cs, fresh];
      const copy = cs.slice();
      copy.splice(idx + 1, 0, fresh);
      return copy;
    });
    setActiveCellId(fresh.id);
  }, []);
  const deleteCell = useCallback((cellId: string) => {
    setCells((cs) => (cs.length <= 1 ? cs : cs.filter((c) => c.id !== cellId)));
    setCellResults((r) => { const n = { ...r }; delete n[cellId]; return n; });
  }, []);
  const duplicateCell = useCallback((cellId: string) => {
    setCells((cs) => {
      const idx = cs.findIndex((c) => c.id === cellId);
      if (idx < 0) return cs;
      const src = cs[idx];
      const dup: NotebookCell = { ...src, id: emptyCell('code').id, output: undefined, executionCount: undefined };
      const copy = cs.slice();
      copy.splice(idx + 1, 0, dup);
      return copy;
    });
  }, []);
  const moveCell = useCallback((cellId: string, dir: -1 | 1) => {
    setCells((cs) => {
      const idx = cs.findIndex((c) => c.id === cellId);
      const j = idx + dir;
      if (idx < 0 || j < 0 || j >= cs.length) return cs;
      const copy = cs.slice();
      [copy[idx], copy[j]] = [copy[j], copy[idx]];
      return copy;
    });
  }, []);

  // ---- Execute a single cell against the cluster ----
  const selectedCluster = useMemo(
    () => clusters.find((c) => c.cluster_id === clusterId) || null,
    [clusters, clusterId],
  );
  const clusterRunning = selectedCluster?.state === 'RUNNING';

  // Low-level Command Execution call with per-(cluster,language) context reuse.
  // Returns the parsed JSON body (or throws on network error).
  const postCommand = useCallback(async (cmdLang: string, command: string) => {
    const ctxKey = `${clusterId}:${cmdLang}`;
    const res = await clientFetch(`/api/items/databricks-notebook/${id}/command`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clusterId, language: cmdLang, command, contextId: contextsRef.current[ctxKey] || undefined }),
    });
    const j = await res.json();
    if (j?.contextId) contextsRef.current[ctxKey] = j.contextId; // REPL persistence
    return { res, j } as { res: Response; j: any };
  }, [id, clusterId]);

  // Ensure the widget values are set in the python REPL context that this cell
  // will run against, so `dbutils.widgets.get(name)` returns the chosen value.
  const ensureWidgets = useCallback(async (cmdLang: string) => {
    if (widgets.length === 0 || cmdLang !== 'python') return;
    const ctxKey = `${clusterId}:${cmdLang}`;
    if (widgetsAppliedRef.current.has(ctxKey)) return;
    const preamble = buildWidgetPreamble(widgets, effectiveWidgetValues(widgets, widgetValues));
    if (preamble.trim()) await postCommand('python', preamble);
    widgetsAppliedRef.current.add(ctxKey);
  }, [widgets, widgetValues, clusterId, postCommand]);

  const runCell = useCallback(async (cell: NotebookCell): Promise<void> => {
    if (cell.type === 'markdown') return; // markdown renders client-side
    if (!clusterId) {
      setCellResults((r) => ({ ...r, [cell.id]: { status: 'error', error: 'No cluster selected. Pick a cluster above.' } }));
      return;
    }
    // Resolve Databricks magics (%sql/%sh/%fs/%pip/%run/%python…) → a concrete
    // (command language, command) with faithful semantics, incl. %sql→_sqldf.
    const resolved = resolveDbxCommand(cell, baseLanguage);
    const cmdLang = resolved.commandLanguage;
    const t0 = Date.now();
    setCellResults((r) => ({ ...r, [cell.id]: { status: 'running' } }));
    try {
      await ensureWidgets(cmdLang);
      const { res, j } = await postCommand(cmdLang, resolved.command);
      if (!j.ok) {
        setCellResults((r) => ({ ...r, [cell.id]: { status: 'error', error: j.error || `HTTP ${res.status}` } }));
        return;
      }
      const ms = Date.now() - t0;
      if (j.resultType === 'error' || j.status === 'Error') {
        setCellResults((r) => ({ ...r, [cell.id]: { status: 'error', resultType: 'error', error: j.error, cause: j.cause, ms } }));
      } else {
        setCellResults((r) => ({
          ...r,
          [cell.id]: {
            status: 'ok',
            resultType: j.resultType,
            text: j.text,
            columns: j.columns,
            rows: j.rows,
            image: j.image,
            truncated: j.truncated,
            ms,
          },
        }));
      }
    } catch (e: any) {
      setCellResults((r) => ({ ...r, [cell.id]: { status: 'error', error: e?.message || String(e) } }));
    }
  }, [id, clusterId, baseLanguage, ensureWidgets, postCommand]);

  const runAll = useCallback(async () => {
    setRunningAll(true);
    try {
      for (const cell of cells) {
        if (cell.type === 'markdown') continue;
        if (!cell.source.trim()) continue;
        await runCell(cell);
        const res = cellResults[cell.id];
        // stop-on-error parity with Databricks "Run all"
        if (res?.status === 'error') break;
      }
    } finally {
      setRunningAll(false);
    }
  }, [cells, runCell, cellResults]);

  const clearOutputs = useCallback(() => setCellResults({}), []);

  // ---- R4-DBX-7: Clear state (fresh REPL) + clear-and-run-all ----
  // Dropping the cached context ids forces a brand-new execution context on the
  // next run — a clean REPL with no prior variables (Databricks "Clear state").
  const clearState = useCallback(() => {
    contextsRef.current = {};
    widgetsAppliedRef.current = new Set();
    setCellResults({});
  }, []);
  const clearAndRunAll = useCallback(async () => {
    clearState();
    await runAll();
  }, [clearState, runAll]);

  // ---- R4-DBX-2: widget changes ----
  const runWithWidgets = useCallback(async () => {
    widgetsAppliedRef.current = new Set(); // force re-apply with current values
    await runAll();
  }, [runAll]);
  // Bumped when a widget changes AND behavior is 'run-all'; an effect then
  // re-runs the notebook with the committed value (no stale closure).
  const [widgetRunToken, setWidgetRunToken] = useState(0);
  const setWidgetValue = useCallback((name: string, value: string) => {
    setWidgetValues((v) => ({ ...v, [name]: value }));
    widgetsAppliedRef.current = new Set(); // invalidate applied preambles
    if (widgetBehavior === 'run-all') setWidgetRunToken((t) => t + 1);
  }, [widgetBehavior]);
  useEffect(() => {
    if (widgetRunToken > 0) void runWithWidgets();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [widgetRunToken]);

  // ---- R4-DBX-4: variable explorer — introspect the live python REPL ----
  const inspectVariables = useCallback(async (): Promise<VarRow[]> => {
    if (!clusterId) throw new Error('Attach a cluster before inspecting variables.');
    const INSPECT_SOURCE = [
      'import json as __loom_j__',
      '__loom_v__ = []',
      "__loom_skip__ = ('In','Out','exit','quit','get_ipython','spark','sc','sqlContext','dbutils','displayHTML','display')",
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
    const { j } = await postCommand('python', INSPECT_SOURCE);
    if (!j.ok) throw new Error(j.error || 'variable inspection failed');
    if (j.resultType === 'error' || j.status === 'Error') throw new Error(j.error || j.cause || 'kernel error');
    const text: string = typeof j.text === 'string' ? j.text : '';
    const idx = text.lastIndexOf('__LOOM_VARS__:');
    if (idx < 0) return [];
    const jsonStr = text.slice(idx + '__LOOM_VARS__:'.length).split('\n')[0].trim();
    let raw: Array<{ n: string; t: string; l: number | null; r: string }>;
    try { raw = JSON.parse(jsonStr); } catch { throw new Error('Could not parse the kernel variable snapshot.'); }
    return raw.map((x) => ({ name: x.n, type: x.t, len: x.l, repr: x.r }));
  }, [clusterId, postCommand]);

  // ---- R4-DBX-3: restore a version's SOURCE into the editor ----
  const restoreVersionSource = useCallback((src: string) => {
    const base = detectBase(baseLanguage);
    const parsed = parseSource(src, base);
    setCells(parsed);
    setActiveCellId(parsed[0]?.id || null);
    setCellResults({});
  }, [baseLanguage]);

  // ---- Runs history (jobs runs/list) ----
  const [runs, setRuns] = useState<RunRow[]>([]);
  const loadRuns = useCallback(async () => {
    const r = await clientFetch(`/api/items/databricks-notebook/${id}/runs`);
    const j = await r.json();
    if (j.ok) setRuns(j.runs || []);
  }, [id]);
  const [runsOpen, setRunsOpen] = useState(false);
  const openRuns = useCallback(() => { setRunsOpen(true); void loadRuns(); }, [loadRuns]);

  // ---- Tree render ----
  const renderTree = (path: string, depth = 0) => {
    const items = tree[path] || [];
    return items.map((o) => {
      const isDir = o.object_type === 'DIRECTORY' || o.object_type === 'REPO';
      const isNb = o.object_type === 'NOTEBOOK';
      const isOpen = expanded.has(o.path);
      return (
        <div key={o.path} style={{ paddingLeft: depth * 12 }}>
          <div
            className={s.treeRow}
            style={{ background: selectedPath === o.path ? tokens.colorNeutralBackground2Selected : undefined }}
          >
            <div
              role="button"
              tabIndex={0}
              aria-label={`${isDir ? 'Toggle' : 'Open'} ${o.path}`}
              style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, flex: 1, cursor: 'pointer', minWidth: 0 }}
              onClick={() => isDir ? toggle(o.path) : isNb ? openNotebook(o.path, o.language) : undefined}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  if (isDir) toggle(o.path); else if (isNb) openNotebook(o.path, o.language);
                }
              }}
            >
              {isDir ? <Folder20Regular /> : isNb ? <Document20Regular /> : <DocumentTable20Regular />}
              <Caption1 style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {o.path.split('/').pop() || o.path}
              </Caption1>
              {o.language && <Caption1 style={{ opacity: 0.6 }}>· {o.language}</Caption1>}
            </div>
            {(isNb || isDir) && (
              <Button
                size="small" appearance="subtle" icon={<Delete20Regular />}
                className={s.treeDelete}
                aria-label={`Delete ${o.path}`}
                onClick={(e) => { e.stopPropagation(); deleteObject(o.path, isDir); }}
              />
            )}
          </div>
          {isDir && isOpen && tree[o.path] !== undefined && renderTree(o.path, depth + 1)}
          {isDir && isOpen && tree[o.path] === undefined && (
            <div style={{ paddingLeft: (depth + 1) * 12 }}><Caption1>(loading…)</Caption1></div>
          )}
        </div>
      );
    });
  };

  const refreshTree = useCallback(() => { setTree({}); void loadDir(rootPath); }, [rootPath, loadDir]);
  const canRunAll = !!clusterId && !runningAll && cells.some((c) => c.type === 'code' && c.source.trim());

  const ribbonNb: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'File', actions: [
        { label: 'New notebook', onClick: newNotebook },
        { label: savingFile ? 'Saving…' : 'Save', onClick: selectedPath && dirty && !savingFile ? save : undefined, disabled: !selectedPath || !dirty || savingFile },
      ]},
      { label: 'Cells', actions: [
        { label: 'Add code cell', onClick: () => addCell('code', activeCellId || undefined) },
        { label: 'Add markdown', onClick: () => addCell('markdown', activeCellId || undefined) },
      ]},
      { label: 'Run', actions: [
        { label: runningAll ? 'Running all…' : 'Run all', onClick: canRunAll ? runAll : undefined, disabled: !canRunAll },
        { label: 'Clear outputs', onClick: clearOutputs },
        { label: 'Clear state', onClick: clearState },
        { label: 'Clear state & run all', onClick: canRunAll ? clearAndRunAll : undefined, disabled: !canRunAll },
        { label: 'View runs', onClick: openRuns },
      ]},
      { label: 'Schedule & history', actions: [
        { label: 'Schedule as job', icon: <CalendarClock20Regular />, onClick: () => setScheduleOpen(true), disabled: !selectedPath },
        { label: 'Version history', icon: <History20Regular />, onClick: () => setVersionsOpen(true), disabled: !selectedPath },
      ]},
      { label: 'Tools', actions: [
        { label: 'Variables', icon: <MathFormula20Regular />, onClick: () => setVarsOpen(true) },
        { label: 'Copilot', icon: <Bot20Regular />, onClick: () => setCopilotOpen(true) },
      ]},
      { label: 'Workspace', actions: [
        { label: 'Refresh tree', onClick: refreshTree },
        { label: 'Refresh clusters', onClick: () => void loadClusters() },
      ]},
    ]},
  ], [newNotebook, savingFile, selectedPath, dirty, save, addCell, activeCellId, runningAll, canRunAll, runAll, clearOutputs, clearState, clearAndRunAll, openRuns, refreshTree, loadClusters]);

  return (
    <ItemEditorChrome
      item={item}
      id={id}
      ribbon={ribbonNb}
      leftPanel={
        <div className={s.treePad}>
          <div style={{ display: 'flex', gap: tokens.spacingHorizontalXS, marginBottom: tokens.spacingVerticalXS }}>
            <Input
              value={rootPath}
              onChange={(_, d) => setRootPath(d.value || '/Workspace')}
              size="small"
              style={{ flex: 1 }}
            />
            <Button size="small" icon={<ArrowSync20Regular />} aria-label="Refresh tree" onClick={refreshTree} />
            <Button size="small" icon={<Add20Regular />} aria-label="New notebook" onClick={newNotebook} />
          </div>
          {treeError && (
            <MessageBar intent="error">
              <MessageBarBody><MessageBarTitle>Workspace error</MessageBarTitle>{treeError}</MessageBarBody>
            </MessageBar>
          )}
          {renderTree(rootPath)}
        </div>
      }
      main={
        <div className={s.pad}>
          <TeachingBanner
            surfaceKey="databricks-notebook-editor"
            title="Run notebooks on Databricks"
            message="Attach a cluster, mix Python, SQL, and Scala cells against Unity Catalog, then schedule the notebook as a job. Cells run on your real Databricks workspace and results stream back here."
            learnMoreHref="https://learn.microsoft.com/azure/databricks/notebooks/"
          />
          {/* Toolbar: notebook id + base language + cluster + run-all */}
          <div className={s.toolbar}>
            <Caption1 style={{ fontWeight: 600 }}>{selectedPath || 'New notebook (unsaved)'}</Caption1>
            <Dropdown
              aria-label="Notebook language"
              value={baseLanguage}
              selectedOptions={[baseLanguage]}
              onOptionSelect={(_, d) => d.optionValue && setBaseLanguage(d.optionValue as DbxBaseLanguage)}
              size="small"
              style={{ width: 120 }}
            >
              <Option value="PYTHON">Python</Option>
              <Option value="SQL">SQL</Option>
              <Option value="SCALA">Scala</Option>
              <Option value="R">R</Option>
            </Dropdown>
            <Dropdown
              placeholder="Attach cluster"
              aria-label="Cluster"
              value={selectedCluster ? `${selectedCluster.cluster_name || selectedCluster.cluster_id} · ${selectedCluster.state}` : ''}
              selectedOptions={clusterId ? [clusterId] : []}
              onOptionSelect={(_, d) => d.optionValue && setClusterId(d.optionValue)}
              size="small"
              style={{ minWidth: 240 }}
              disabled={clusters.length === 0}
            >
              {clusters.map((c) => (
                <Option key={c.cluster_id} value={c.cluster_id} text={`${c.cluster_name || c.cluster_id} · ${c.state}`}>
                  {c.cluster_name || c.cluster_id} · {c.state}
                </Option>
              ))}
            </Dropdown>
            {selectedCluster && (
              <Badge appearance="filled" color={clusterStateColor(selectedCluster.state)}>
                {selectedCluster.state}
              </Badge>
            )}
            <Tooltip
              content={
                runningAll ? 'Running all cells…'
                  : !clusterId ? 'Attach a cluster first'
                  : !cells.some((c) => c.type === 'code' && c.source.trim()) ? 'Add a non-empty code cell'
                  : 'Run every code cell top-to-bottom (stops on first error)'
              }
              relationship="label"
            >
              <Button
                appearance="primary"
                icon={<Play20Regular />}
                disabled={!canRunAll}
                onClick={runAll}
                style={{ marginLeft: 'auto' }}
              >
                {runningAll ? 'Running all…' : 'Run all'}
              </Button>
            </Tooltip>
            <Tooltip
              content={
                !selectedPath ? 'Open or create a notebook first'
                  : savingFile ? 'Saving…'
                  : !dirty ? 'No unsaved changes'
                  : 'Save to the workspace (workspace/import)'
              }
              relationship="label"
            >
              <Button
                appearance="primary"
                icon={<Save20Regular />}
                disabled={!selectedPath || !dirty || savingFile}
                onClick={save}
              >
                {savingFile ? 'Saving…' : dirty ? 'Save *' : 'Save'}
              </Button>
            </Tooltip>
          </div>

          {clustersError && (
            <MessageBar intent="error">
              <MessageBarBody><MessageBarTitle>Could not list clusters</MessageBarTitle>{clustersError}</MessageBarBody>
            </MessageBar>
          )}
          {!clustersError && clusters.length === 0 && (
            <MessageBar intent="warning">
              <MessageBarBody>
                <MessageBarTitle>No clusters in this workspace</MessageBarTitle>
                Create a cluster in the Databricks Cluster editor (or the Databricks portal: Compute → Create compute).
                Cells need an attached cluster to execute via the Command Execution API.
              </MessageBarBody>
            </MessageBar>
          )}
          {!clustersError && clusters.length > 0 && !clusterRunning && (
            <MessageBar intent="warning">
              <MessageBarBody>
                <MessageBarTitle>Cluster is {selectedCluster?.state?.toLowerCase() || 'not running'}</MessageBarTitle>
                Start <strong>{selectedCluster?.cluster_name || clusterId}</strong> in the Databricks Cluster editor
                (Start), then return here. Cells run against a RUNNING cluster; submitting now will start one on demand and may take 2–5 min.
              </MessageBarBody>
            </MessageBar>
          )}
          {fileError && (
            <MessageBar intent="error"><MessageBarBody>
              <MessageBarTitle>Notebook error</MessageBarTitle>{fileError}
            </MessageBarBody></MessageBar>
          )}
          {fileMessage && (
            <MessageBar intent="success"><MessageBarBody>{fileMessage}</MessageBarBody></MessageBar>
          )}

          {/* R4-DBX-2: dbutils.widgets input strip */}
          <DbxWidgetsBar
            widgets={widgets}
            values={widgetValues}
            onChange={setWidgetValue}
            behavior={widgetBehavior}
            onBehaviorChange={setWidgetBehavior}
            onRunAll={runWithWidgets}
            runDisabled={!canRunAll}
          />

          {/* Cell list */}
          {loadingFile ? (
            <Spinner size="small" label="Loading notebook source…" labelPosition="after" />
          ) : (
            <div className={s.cellList}>
              <CellAdder
                onAddCode={() => addCell('code', undefined)}
                onAddMarkdown={() => addCell('markdown', undefined)}
              />
              {cells.map((cell, i) => {
                const res = cellResults[cell.id];
                const cellNode = cell.type === 'markdown' ? (
                  <MarkdownCell
                    key={cell.id}
                    cell={cell}
                    active={activeCellId === cell.id}
                    onFocus={() => setActiveCellId(cell.id)}
                    onChange={updateCell}
                    onDelete={() => deleteCell(cell.id)}
                    onMoveUp={() => moveCell(cell.id, -1)}
                    onMoveDown={() => moveCell(cell.id, 1)}
                    onDuplicate={() => duplicateCell(cell.id)}
                    canMoveUp={i > 0}
                    canMoveDown={i < cells.length - 1}
                  />
                ) : (
                  <div key={cell.id}>
                    <CodeCell
                      cell={cell}
                      active={activeCellId === cell.id}
                      onFocus={() => setActiveCellId(cell.id)}
                      onChange={updateCell}
                      onRun={runCell}
                      onDelete={() => deleteCell(cell.id)}
                      onMoveUp={() => moveCell(cell.id, -1)}
                      onMoveDown={() => moveCell(cell.id, 1)}
                      onDuplicate={() => duplicateCell(cell.id)}
                      canMoveUp={i > 0}
                      canMoveDown={i < cells.length - 1}
                      priorCells={cells.slice(0, i).filter((pc) => pc.type === 'code').slice(-3).map((pc) => pc.source)}
                    />
                    <DbxCellOutput res={res} cellId={cell.id} notebookId={id} />
                  </div>
                );
                return (
                  <div key={`${cell.id}-wrap`}>
                    {cellNode}
                    <CellAdder
                      onAddCode={() => addCell('code', cell.id)}
                      onAddMarkdown={() => addCell('markdown', cell.id)}
                    />
                  </div>
                );
              })}
            </div>
          )}

          {/* Runs history dialog */}
          <Dialog open={runsOpen} onOpenChange={(_, d) => setRunsOpen(d.open)}>
            <DialogSurface style={{ maxWidth: '1080px', width: '95vw' }}>
              <DialogBody>
                <DialogTitle>Workspace runs</DialogTitle>
                <DialogContent>
                  <div className={s.tableWrap}>
                    <Table size="small" aria-label="Recent runs">
                      <TableHeader><TableRow>
                        <TableHeaderCell>run_id</TableHeaderCell>
                        <TableHeaderCell>Name</TableHeaderCell>
                        <TableHeaderCell>State</TableHeaderCell>
                        <TableHeaderCell>Start</TableHeaderCell>
                        <TableHeaderCell>Exec</TableHeaderCell>
                        <TableHeaderCell>Creator</TableHeaderCell>
                      </TableRow></TableHeader>
                      <TableBody>
                        {runs.length === 0 && (
                          <TableRow><TableCell colSpan={6}><Caption1>No runs yet.</Caption1></TableCell></TableRow>
                        )}
                        {runs.map((r) => (
                          <TableRow key={r.run_id}>
                            <TableCell>{r.run_id}</TableCell>
                            <TableCell>{r.run_name || '—'}</TableCell>
                            <TableCell>
                              <Badge appearance="outline" color={runStateColor(r.state?.result_state)}>
                                {r.state?.life_cycle_state || '—'}{r.state?.result_state ? ` · ${r.state.result_state}` : ''}
                              </Badge>
                            </TableCell>
                            <TableCell>{fmtTime(r.start_time)}</TableCell>
                            <TableCell>{fmtDuration(r.execution_duration)}</TableCell>
                            <TableCell>{r.creator_user_name || '—'}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </DialogContent>
                <DialogActions>
                  <Button appearance="secondary" onClick={() => setRunsOpen(false)}>Close</Button>
                  <Button appearance="primary" onClick={() => void loadRuns()}>Refresh</Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>

          {/* R4-DBX-4: variable explorer */}
          <VariablesPane
            open={varsOpen}
            onOpenChange={setVarsOpen}
            onInspect={inspectVariables}
            defaultLang={paneLang}
          />

          {/* R4-DBX-1: schedule-as-a-job */}
          <DbxScheduleDialog
            open={scheduleOpen}
            onOpenChange={setScheduleOpen}
            itemId={id}
            notebookPath={selectedPath}
            clusterId={clusterId}
            widgetValues={widgets.length ? effectiveWidgetValues(widgets, widgetValues) : undefined}
          />

          {/* R4-DBX-3: version history + diff + restore */}
          <DbxVersionsDialog
            open={versionsOpen}
            onOpenChange={setVersionsOpen}
            itemId={id}
            notebookPath={selectedPath}
            language={baseLanguage}
            currentSource={serialized}
            onRestore={restoreVersionSource}
          />

          {/* R4-DBX-8: notebook-wide Copilot / Assistant */}
          <CopilotChatPane
            open={copilotOpen}
            onOpenChange={setCopilotOpen}
            notebookId={id}
            workspaceId={id}
            cells={cells}
            activeCellId={activeCellId}
            attachedSources={[]}
            defaultLang={paneLang}
            runtime="databricks"
            notebookName={selectedPath || 'Databricks notebook'}
            onApplyCells={(updated) => {
              setCells((cs) => cs.map((c, i) => (updated[i] ? { ...c, source: updated[i].source } : c)));
            }}
          />
        </div>
      }
    />
  );
}

// Renders a single cell's Command Execution result: text / table / image / error.
// Table results get the shared RichDisplay (sortable grid + viz builder + CSV/
// JSON download) plus a Data Profile tab (R4-DBX-6) — one-for-one with the
// Databricks notebook output surface.
function DbxCellOutput({ res, cellId, notebookId }: { res?: CellResult; cellId: string; notebookId: string }) {
  const s = useStyles();
  const [tab, setTab] = useState<'results' | 'profile'>('results');
  const payload = useMemo(
    () => (res?.status === 'ok' && res.resultType === 'table' ? buildDbxDataProfile(res.columns, res.rows) : null),
    [res],
  );

  if (!res || res.status === 'idle') return null;
  if (res.status === 'running') {
    return (
      <div className={s.cellOutput}>
        <Spinner size="tiny" label="Running on cluster…" labelPosition="after" />
      </div>
    );
  }
  if (res.status === 'error') {
    return (
      <div className={s.cellOutput}>
        <MessageBar intent="error">
          <MessageBarBody>
            <MessageBarTitle>Command failed</MessageBarTitle>
            {res.error || 'Unknown error'}
          </MessageBarBody>
        </MessageBar>
        {res.cause && (
          <pre className={s.cellPre} style={{ color: tokens.colorPaletteRedForeground1 }}>{res.cause}</pre>
        )}
      </div>
    );
  }
  // ok
  return (
    <div className={s.cellOutput}>
      <div className={s.resultMeta}>
        <Badge appearance="filled" color="success">{res.resultType || 'text'}</Badge>
        {typeof res.ms === 'number' && <Caption1>· {res.ms} ms</Caption1>}
        {res.truncated && <Badge appearance="outline" color="warning">truncated</Badge>}
      </div>
      {res.resultType === 'table' && payload ? (
        <>
          <TabList size="small" selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as 'results' | 'profile')}>
            <Tab value="results" icon={<DocumentTable20Regular />}>Results</Tab>
            <Tab value="profile" icon={<DataBarVertical20Regular />}>Data profile</Tab>
          </TabList>
          {tab === 'results'
            ? <RichDisplay payload={payload} cellId={cellId} notebookId={notebookId} workspaceId="" computeId="" />
            : <DbxDataProfileView columns={res.columns} rows={res.rows} />}
        </>
      ) : res.resultType === 'table' ? (
        <div className={s.tableWrap}>
          <Table aria-label="Cell result" size="small">
            <TableHeader>
              <TableRow>
                {(res.columns || []).map((c, i) => <TableHeaderCell key={`${c}-${i}`}>{c}</TableHeaderCell>)}
              </TableRow>
            </TableHeader>
            <TableBody>
              {(res.rows || []).map((row, i) => (
                <TableRow key={i}>
                  {(res.columns || []).map((_, j) => (
                    <TableCell key={j} className={s.cell}>{formatCell((row as unknown[])[j])}</TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : res.resultType === 'image' && res.image ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img alt="cell output" src={res.image.startsWith('data:') ? res.image : `data:image/png;base64,${res.image}`} style={{ maxWidth: '100%' }} />
      ) : (
        <pre className={s.cellPre}>{res.text || '(no output)'}</pre>
      )}
    </div>
  );
}
