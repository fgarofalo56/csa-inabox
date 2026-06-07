'use client';

/**
 * NotebookEditor — Fabric-native notebook editor wired to live Fabric REST.
 *
 * Auth gate: requires the Console UAMI's SP to be (a) registered in the
 * Fabric tenant ("Service principals can use Fabric APIs") and (b) added
 * to the target workspace. If either is missing, the editor surfaces the
 * underlying 401/403 verbatim via MessageBar — no mocks.
 *
 * Backed by /api/loom/workspaces + /api/items/notebook/**.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Subtitle2, Caption1, Badge, Button, Spinner, Input,
  Tree, TreeItem, TreeItemLayout, Select,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  Dialog, DialogTrigger, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Play20Regular, Add20Regular, Save20Regular, ArrowSync20Regular, Delete20Regular, Notebook20Regular,
  History20Regular, ArrowUpload20Regular,
} from '@fluentui/react-icons';
import { ItemEditorChrome } from './item-editor-chrome';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';
import { CodeCell } from '@/lib/components/notebook/code-cell';
import { MarkdownCell } from '@/lib/components/notebook/markdown-cell';
import { CellAdder } from '@/lib/components/notebook/cell-adder';
import { HistoryDrawer } from '@/lib/components/notebook/history-drawer';
import { type NotebookCell, type NotebookCellLang, emptyCell, migrateLegacyState } from '@/lib/types/notebook-cell';

// Ribbon is now built dynamically inside the component so each action can
// hold a real onClick wired to the editor's handlers. See `buildRibbon`
// below the component declarations.

const useStyles = makeStyles({
  pad: { padding: 16, display: 'flex', flexDirection: 'column', gap: 12, flex: 1, minHeight: 0 },
  toolbar: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
  editor: {
    width: '100%', minHeight: 280,
    fontFamily: 'Consolas, "Cascadia Code", monospace', fontSize: 13, padding: 12,
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 4,
    backgroundColor: tokens.colorNeutralBackground3, color: tokens.colorNeutralForeground1,
    resize: 'vertical',
  },
  treePad: { padding: 8 },
  tableWrap: { overflow: 'auto', maxHeight: 240, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 4 },
  cell: { fontFamily: 'Consolas, monospace', fontSize: 12, whiteSpace: 'nowrap' },
});

interface WorkspaceLite { id: string; name: string; isOnDedicatedCapacity?: boolean; }
interface NotebookLite { id: string; displayName: string; description?: string; }
interface JobLite {
  id: string; status?: string; jobType?: string; invokeType?: string;
  startTimeUtc?: string; endTimeUtc?: string;
  failureReason?: { errorCode?: string; message?: string } | null;
}
interface LakehouseLite { id: string; displayName: string; description?: string; }
interface AttachedSource {
  kind: 'lakehouse' | 'warehouse' | 'kql-database';
  id: string;
  displayName: string;
  isDefault?: boolean;
}

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
  return { workspaces, error, hint, loading, reload: load };
}

const STARTER_PY = `# Fabric Notebook (PySpark)\n# Edit, then click Save. Click Run cell to queue execution.\ndf = spark.range(10)\ndf.show()\n`;

function starterCells(): NotebookCell[] {
  return [
    { ...emptyCell('markdown'), source: '# New notebook\n\nDouble-click to edit. Use **+ Code** between cells to add code cells.' },
    { ...emptyCell('code', 'pyspark'), source: STARTER_PY },
  ];
}

function encodePy(src: string): string {
  // browser btoa needs latin-1 — encode utf-8 first.
  return typeof window === 'undefined' ? Buffer.from(src, 'utf-8').toString('base64')
    : btoa(unescape(encodeURIComponent(src)));
}
function decodePy(b64: string): string {
  try {
    return typeof window === 'undefined' ? Buffer.from(b64, 'base64').toString('utf-8')
      : decodeURIComponent(escape(atob(b64)));
  } catch { return ''; }
}

interface Props { item: FabricItemType; id: string; }

interface ComputeTarget {
  id: string;
  name: string;
  kind: 'synapse-spark' | 'databricks-cluster' | 'synapse-dedicated-sql' | 'synapse-serverless-sql';
  state?: string;
}

function useComputes() {
  const [computes, setComputes] = useState<ComputeTarget[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      const j = await (await fetch('/api/loom/compute-targets')).json();
      if (j.ok) setComputes(j.computes || []);
      else setError(j.error || 'failed to list compute');
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  return { computes, loading, error, refresh };
}

const COMPUTE_RUNNING = ['Available', 'Online', 'Running', 'RUNNING', 'idle'];
function isComputeRunning(state?: string): boolean {
  return COMPUTE_RUNNING.includes(state || '');
}

export function NotebookEditor({ item, id }: Props) {
  const s = useStyles();
  const ws = useWorkspaces();
  const cp = useComputes();
  const [workspaceId, setWorkspaceId] = useState('');
  const [computeId, setComputeId] = useState('');
  const [notebooks, setNotebooks] = useState<NotebookLite[] | null>(null);
  const [notebookId, setNotebookId] = useState('');
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
  const [createBusy, setCreateBusy] = useState(false);
  const [createErr, setCreateErr] = useState<string | null>(null);
  const [prefill, setPrefill] = useState<{ source: string; container?: string; path?: string } | null>(null);
  // Phase 2: attached data sources (Lakehouses / Warehouses / KQL DBs).
  const [attachedSources, setAttachedSources] = useState<AttachedSource[]>([]);
  const [attachOpen, setAttachOpen] = useState(false);
  const [availableLakehouses, setAvailableLakehouses] = useState<LakehouseLite[] | null>(null);
  const [attachBusy, setAttachBusy] = useState(false);
  // Phase 3: History drawer
  const [historyOpen, setHistoryOpen] = useState(false);
  // Import-from-file (desktop .ipynb / .py / .sql / .scala / .r → Loom notebook)
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [importing, setImporting] = useState(false);

  // Auto-pick first runnable compute (skip serverless SQL — not for notebooks)
  useEffect(() => {
    if (!computeId && cp.computes.length) {
      const first = cp.computes.find(c => c.kind === 'synapse-spark' || c.kind === 'databricks-cluster');
      if (first) setComputeId(first.id);
    }
  }, [cp.computes, computeId]);

  // Pre-warm session on compute selection: if a Synapse Spark compute is picked,
  // immediately POST to /run with no code to initialize the Livy session in the background.
  // This amortizes the 60-90s cold-start across the idle time before the user's first cell run.
  const prewarmSession = useCallback(async (cId: string) => {
    if (!workspaceId || !notebookId || !cId.startsWith('spark:')) return;
    try {
      await fetch(`/api/items/notebook/${encodeURIComponent(notebookId)}/run?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ compute: cId, cellId: '__prewarm__' }),
      }).catch(() => { /* silent — warmup is best-effort */ });
    } catch { /* ignore */ }
  }, [workspaceId, notebookId]);

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
  const startCompute = useCallback(async () => {
    if (!computeId) return;
    setStartingCompute(true); setRunMsg('Starting compute…');
    try {
      const r = await fetch(`/api/loom/compute-targets/${encodeURIComponent(computeId)}/start`, { method: 'POST' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j?.ok === false) {
        setRunMsg(`Could not start compute: ${j?.error || `HTTP ${r.status}`}`);
        return;
      }
      // Poll state until it reports running (cluster start is ~60-90s).
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

  // v3.28: honor URL deep-link — when /items/notebook/{id} loads, discover
  // the owning workspace from the Cosmos record and auto-select it so the
  // cells actually render. Previously workspaceId stayed empty until the
  // user manually picked from the dropdown, leaving the editor blank.
  useEffect(() => {
    if (id === 'new' || !id || workspaceId || notebookId) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/cosmos-items/notebook/${encodeURIComponent(id)}`);
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
      const r = await fetch(`/api/items/notebook?workspaceId=${encodeURIComponent(wsId)}`);
      const j = await r.json();
      if (!j.ok) { setNotebooks([]); setListErr(j.error); setListHint(j.hint); return; }
      setNotebooks(j.notebooks || []);
      if ((j.notebooks || []).length && !notebookId) setNotebookId(j.notebooks[0].id);
    } catch (e: any) { setNotebooks([]); setListErr(e?.message || String(e)); }
  }, [notebookId]);

  const loadDetail = useCallback(async (wsId: string, nbId: string) => {
    setDetailErr(null); setRunMsg(null);
    try {
      const r = await fetch(`/api/items/notebook/${encodeURIComponent(nbId)}?workspaceId=${encodeURIComponent(wsId)}`);
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
      setDirty(false);
    } catch (e: any) { setDetailErr(e?.message || String(e)); }
  }, []);

  const loadJobs = useCallback(async (wsId: string, nbId: string) => {
    try {
      const r = await fetch(`/api/items/notebook/${encodeURIComponent(nbId)}/jobs?workspaceId=${encodeURIComponent(wsId)}`);
      const j = await r.json();
      if (j.ok) setJobs(j.jobs || []);
    } catch { /* keep last */ }
  }, []);

  useEffect(() => { if (workspaceId) loadList(workspaceId); }, [workspaceId, loadList]);
  useEffect(() => {
    if (workspaceId && notebookId) { loadDetail(workspaceId, notebookId); loadJobs(workspaceId, notebookId); }
  }, [workspaceId, notebookId, loadDetail, loadJobs]);

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
      const r = await fetch(`/api/items/notebook/${encodeURIComponent(notebookId)}?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ definition: { cells: cellsForSave, defaultLang, attachedSources } }),
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
  }, [workspaceId, notebookId, cells, defaultLang, attachedSources]);

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
      const r = await fetch(`/api/items/lakehouse?workspaceId=${encodeURIComponent(workspaceId)}`);
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
      const r = await fetch(`/api/items/notebook/${encodeURIComponent(notebookId)}?workspaceId=${encodeURIComponent(workspaceId)}`, {
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

  const run = useCallback(async () => {
    if (!workspaceId || !notebookId) return;
    if (!computeId) {
      setRunMsg('Pick a compute target before running.');
      return;
    }
    setRunning(true);
    setRunMsg('Submitting run…');
    try {
      const r = await fetch(`/api/items/notebook/${encodeURIComponent(notebookId)}/run?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ compute: computeId }),
      });
      const j = await r.json();
      if (!j.ok) {
        setRunMsg(`Run failed: ${j.error}${j.hint ? ' — ' + j.hint : ''}`);
        setRunning(false);
        return;
      }

      // Poll the run endpoint every 4s for status — Synapse cold-start can
      // take 60-90s; Databricks 30-60s. Keep polling for up to 8 min.
      let runId: string = j.runId;
      setRunMsg(`${j.compute?.kind || 'compute'} ${j.compute?.pool || j.compute?.clusterId} — ${j.status} (runId ${runId})`);
      const start = Date.now();
      const MAX_MS = 12 * 60 * 1000; // 12 min to allow for slow cold-starts
      // Adaptive polling tuned to feel native: fast while a statement is actually
      // executing on a WARM session (~600ms ≈ Databricks' own refresh cadence),
      // backing off only while a COLD session/cluster is still spinning up so we
      // don't hammer the API during a 60-90s start. The old flat 2s floor made
      // every fast cell feel ~2s slow even on a warm cluster.
      let pollInterval = 600; // responsive first poll for warm sessions
      while (Date.now() - start < MAX_MS) {
        await new Promise(res => setTimeout(res, pollInterval));
        const pollRes = await fetch(`/api/items/notebook/${encodeURIComponent(notebookId)}/runs/${encodeURIComponent(runId)}?workspaceId=${encodeURIComponent(workspaceId)}`);
        const p = await pollRes.json();
        if (!p.ok) { setRunMsg(`Poll error: ${p.error || pollRes.status}`); break; }
        if (p.runId && p.runId !== runId) runId = p.runId; // promotion when statement is submitted
        const phase = p.phase ? ` · ${p.phase}` : '';
        setRunMsg(`Status: ${p.status}${phase}`);
        // Stay fast while a statement runs on a warm session; back off to 2s only
        // while a cold session/cluster is still starting (PENDING/starting/queued).
        const cold = p.phase === 'session-starting' || /^(starting|pending|queued)$/i.test(String(p.status || ''));
        pollInterval = cold ? 2000 : 600;
        if (p.output) {
          if (p.output.status === 'ok') {
            const txt = p.output.textPlain || JSON.stringify(p.output.data || {}, null, 2);
            setRunMsg(`✓ Completed:\n${txt}`);
          } else if (p.output.status === 'error') {
            setRunMsg(`✗ Error: ${p.output.ename} ${p.output.evalue}${p.output.traceback ? '\n' + (Array.isArray(p.output.traceback) ? p.output.traceback.join('\n') : p.output.traceback) : ''}`);
          } else {
            setRunMsg(`Completed: ${JSON.stringify(p.output)}`);
          }
          break;
        }
        if (['error', 'dead', 'killed', 'TERMINATED', 'INTERNAL_ERROR'].includes(p.status)) {
          setRunMsg(`Run ended: ${p.status}${p.resultState ? ` (${p.resultState})` : ''}`);
          break;
        }
      }
      loadJobs(workspaceId, notebookId);
    } finally { setRunning(false); }
  }, [workspaceId, notebookId, computeId, loadJobs]);

  const create = useCallback(async () => {
    if (!workspaceId || !createName.trim()) return;
    setCreateBusy(true); setCreateErr(null);
    try {
      const definition = {
        format: 'fabricGitSource',
        parts: [{ path: 'notebook-content.py', payload: encodePy(STARTER_PY), payloadType: 'InlineBase64' }],
      };
      const r = await fetch(`/api/items/notebook?workspaceId=${encodeURIComponent(workspaceId)}`, {
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
  }, [workspaceId, createName, loadList]);

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
      const r = await fetch('/api/items/notebook/import', {
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
    await fetch(`/api/items/notebook/${encodeURIComponent(notebookId)}?workspaceId=${encodeURIComponent(workspaceId)}`, { method: 'DELETE' });
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

  const deleteCell = useCallback((id: string) => {
    setCells(prev => prev.length <= 1 ? prev : prev.filter(c => c.id !== id));
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

  // Per-cell run: dispatches a single cell's source to the notebook /run endpoint with cellId, then polls.
  // CRITICAL: use patchCell (not updateCell) for output mutations so source
  // edits the user makes WHILE the cell is running don't get overwritten
  // by the stale `cell` snapshot captured here. That bug caused Save to
  // appear broken — clicking Save persisted the pre-Run cell source.
  const runCell = useCallback(async (cell: NotebookCell) => {
    if (!workspaceId || !notebookId) return;
    if (!computeId) { setRunMsg('Pick a compute target before running.'); return; }
    if (cell.type !== 'code') return;
    patchCell(cell.id, { output: { status: 'pending' } });
    setRunMsg(`Running cell ${cell.id.slice(0, 6)}…`);
    const prevExec = cell.executionCount || 0;
    try {
      const r = await fetch(`/api/items/notebook/${encodeURIComponent(notebookId)}/run?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ compute: computeId, cellId: cell.id, source: cell.source, lang: cell.lang || defaultLang }),
      });
      const j = await r.json();
      if (!j.ok) {
        patchCell(cell.id, { output: { status: 'error', ename: 'DispatchError', evalue: j.error || 'dispatch failed' } });
        setRunMsg(`Cell run failed: ${j.error}`);
        return;
      }
      let runId: string = j.runId;
      const start = Date.now();
      const MAX_MS = 12 * 60 * 1000; // 12 min to allow for slow cold-starts
      let pollInterval = 2000; // 2s during session-starting, 1s during statement
      while (Date.now() - start < MAX_MS) {
        await new Promise(res => setTimeout(res, pollInterval));
        const pollRes = await fetch(`/api/items/notebook/${encodeURIComponent(notebookId)}/runs/${encodeURIComponent(runId)}?workspaceId=${encodeURIComponent(workspaceId)}`);
        const p = await pollRes.json();
        if (!p.ok) {
          patchCell(cell.id, { output: { status: 'error', ename: 'PollError', evalue: p.error || String(pollRes.status) } });
          break;
        }
        if (p.runId && p.runId !== runId) runId = p.runId;
        const elapsed = Math.floor((Date.now() - start) / 1000);
        const phaseHint = p.phase === 'session-starting'
          ? ` · cold-start: Spark pool warming up (~60-90s on first cell)`
          : p.phase ? ` · ${p.phase}` : '';
        setRunMsg(`Cell ${cell.id.slice(0, 6)}: ${p.status}${phaseHint} · ${elapsed}s`);
        // Adaptive polling: speed up after session is idle
        if (p.phase === 'statement-running') pollInterval = 1000;
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
            },
          });
          setRunMsg(`Cell ${cell.id.slice(0, 6)} complete`);
          break;
        }
        if (['error', 'dead', 'killed', 'TERMINATED', 'INTERNAL_ERROR'].includes(p.status)) {
          patchCell(cell.id, { output: { status: 'error', ename: p.status, evalue: p.resultState || '' } });
          break;
        }
      }
      loadJobs(workspaceId, notebookId);
    } catch (e: any) {
      patchCell(cell.id, { output: { status: 'error', ename: 'Exception', evalue: e?.message || String(e) } });
    }
  }, [workspaceId, notebookId, computeId, defaultLang, patchCell, loadJobs]);

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
          { label: saving ? 'Saving…' : 'Save', onClick: canSave ? save : undefined, disabled: !canSave },
          { label: 'Delete', onClick: canDelete ? del : undefined, disabled: !canDelete },
        ]},
        { label: 'Workspace', actions: [
          { label: 'Refresh list', onClick: workspaceId ? () => loadList(workspaceId) : undefined, disabled: !workspaceId },
        ]},
      ]},
      { id: 'insert', label: 'Insert', groups: [
        { label: 'Cells', actions: [
          { label: '+ Code cell', onClick: () => insertCell(insertAfter, 'code') },
          { label: '+ Markdown cell', onClick: () => insertCell(insertAfter, 'markdown') },
        ]},
        { label: 'Data', actions: [
          { label: 'Attach Lakehouse', onClick: workspaceId ? openAttach : undefined, disabled: !workspaceId },
        ]},
      ]},
      { id: 'view', label: 'View', groups: [
        { label: 'Panes', actions: [
          { label: 'Run history', onClick: canHistory ? () => setHistoryOpen(true) : undefined, disabled: !canHistory },
        ]},
      ]},
      { id: 'run', label: 'Run', groups: [
        { label: 'Execute', actions: [
          { label: 'Run all', onClick: canRun ? run : undefined, disabled: !canRun },
        ]},
      ]},
      { id: 'help', label: 'Help', groups: [
        { label: 'Resources', actions: [
          { label: 'Notebook docs', onClick: () => window.open('https://learn.microsoft.com/fabric/data-engineering/how-to-use-notebook', '_blank') },
        ]},
      ]},
    ];
  }, [
    cells, activeCellId, notebookId, running, dirty, saving, workspaceId, computeId, importing,
    run, save, del, loadList, insertCell, openAttach,
  ]);

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon}
      leftPanel={
        <div className={s.treePad}>
          <Subtitle2 style={{ marginBottom: 8 }}>Notebooks</Subtitle2>
          {!workspaceId && <Caption1>Select a workspace.</Caption1>}
          {workspaceId && notebooks === null && <Spinner size="tiny" label="Loading…" />}
          {notebooks && notebooks.length === 0 && !listErr && <Caption1>No notebooks in this workspace.</Caption1>}
          <Tree aria-label="Notebooks">
            {(notebooks || []).map((n) => (
              <TreeItem key={n.id} itemType="leaf" value={n.id} onClick={() => setNotebookId(n.id)}>
                <TreeItemLayout iconBefore={<Notebook20Regular />}>
                  {notebookId === n.id ? <strong>{n.displayName}</strong> : n.displayName}
                </TreeItemLayout>
              </TreeItem>
            ))}
          </Tree>

          {/* Phase 2: Data items pane — Fabric "Explorer" tab equivalent */}
          {notebookId && (
            <>
              <Subtitle2 style={{ marginTop: 16, marginBottom: 4 }}>Data items</Subtitle2>
              {attachedSources.length === 0 ? (
                <Caption1>No sources attached. Attach a Lakehouse so cells can read its OneLake mount.</Caption1>
              ) : (
                <Tree aria-label="Attached sources">
                  {attachedSources.map((src) => (
                    <TreeItem key={src.id} itemType="leaf" value={src.id}>
                      <TreeItemLayout
                        iconBefore={<Notebook20Regular />}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%' }}>
                          <span style={{ flex: 1 }}>
                            {src.isDefault ? <strong>{src.displayName}</strong> : src.displayName}
                            {src.isDefault && <Badge appearance="outline" color="brand" size="small" style={{ marginLeft: 6 }}>default</Badge>}
                          </span>
                          {!src.isDefault && (
                            <Button size="small" appearance="subtle" onClick={(e) => { e.stopPropagation(); promoteDefault(src.id); }}>Pin</Button>
                          )}
                          <Button size="small" appearance="subtle" onClick={(e) => { e.stopPropagation(); detachSource(src.id); }}>×</Button>
                        </div>
                      </TreeItemLayout>
                    </TreeItem>
                  ))}
                </Tree>
              )}
              <Button size="small" appearance="outline" icon={<Add20Regular />} onClick={openAttach} disabled={!workspaceId} style={{ marginTop: 8, alignSelf: 'flex-start' }}>
                Add data items
              </Button>
            </>
          )}
        </div>
      }
      main={
        <div className={s.pad}>
          <div className={s.toolbar}>
            <Badge appearance="filled" color="brand">Loom Notebook</Badge>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 240 }}>
              <Caption1>Workspace</Caption1>
              <Select aria-label="Workspace" value={workspaceId} onChange={(_, d) => setWorkspaceId(d.value)} disabled={ws.loading || (ws.workspaces?.length ?? 0) === 0}>
                {!workspaceId && <option value="">{ws.loading ? 'Loading workspaces…' : 'Select a workspace'}</option>}
                {(ws.workspaces || []).map((w) => (
                  <option key={w.id} value={w.id}>{w.name}{w.isOnDedicatedCapacity ? ' · dedicated' : ''}</option>
                ))}
              </Select>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 280 }}>
              <Caption1>Compute target</Caption1>
              <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
                <div style={{ flex: 1 }}>
                  <Select aria-label="Compute target" value={computeId} onChange={(_, d) => setComputeId(d.value)} disabled={cp.loading || cp.computes.length === 0}>
                    {!computeId && <option value="">{cp.loading ? 'Loading compute…' : 'Select compute'}</option>}
                    {cp.computes
                      .filter(c => c.kind === 'synapse-spark' || c.kind === 'databricks-cluster')
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
                {/* Start a terminated cluster / paused pool right here. */}
                {computeId && selectedCompute && !isComputeRunning(selectedCompute.state) &&
                  (selectedCompute.kind === 'databricks-cluster' || selectedCompute.kind === 'synapse-dedicated-sql') && (
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
              </div>
            </div>
            <Button appearance="outline" icon={<ArrowSync20Regular />} onClick={() => workspaceId && loadList(workspaceId)} disabled={!workspaceId}>Refresh</Button>
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
                  <DialogTitle>Create Fabric notebook</DialogTitle>
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
            {/*
              Save lives in the ribbon (Home → Item → Save) now that the
              ribbon actions are wired. Avoid a second Save here so users
              aren't confused by two visually-identical Save buttons.
              Ctrl+S still works from anywhere.
            */}
            <Button
              appearance="primary"
              icon={<Play20Regular />}
              disabled={running || !notebookId || !computeId}
              title={!notebookId ? 'Open or create a notebook first'
                : !computeId ? 'Select a compute target first'
                : undefined}
              onClick={run}
            >{running ? 'Queuing…' : 'Run'}</Button>
            <Button appearance="outline" icon={<History20Regular />} disabled={!notebookId} onClick={() => setHistoryOpen(true)}>History</Button>
            <Button appearance="subtle" icon={<Delete20Regular />} disabled={!notebookId} onClick={del}>Delete</Button>
          </div>

          {/* Phase 3: HistoryDrawer — right-side OverlayDrawer wired to /jobs */}
          <HistoryDrawer
            open={historyOpen}
            onOpenChange={setHistoryOpen}
            notebookId={notebookId}
            workspaceId={workspaceId}
            computeId={computeId}
            onRerun={run}
          />

          {/* Phase 2: Attach Lakehouse modal */}
          <Dialog open={attachOpen} onOpenChange={(_, d) => setAttachOpen(d.open)}>
            <DialogSurface>
              <DialogBody>
                <DialogTitle>Attach Lakehouse</DialogTitle>
                <DialogContent>
                  {availableLakehouses === null && <Spinner size="tiny" label="Loading lakehouses…" />}
                  {availableLakehouses && availableLakehouses.length === 0 && (
                    <Caption1>No lakehouses found in this workspace. Create one first from the workspace +New menu.</Caption1>
                  )}
                  {availableLakehouses && availableLakehouses.length > 0 && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 320, overflow: 'auto' }}>
                      {availableLakehouses.map((lh) => {
                        const already = attachedSources.some(s => s.kind === 'lakehouse' && s.id === lh.id);
                        return (
                          <div key={lh.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 6, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 4 }}>
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
                <MessageBarTitle>Fabric not reachable</MessageBarTitle>
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
          {!cp.loading && !cp.error && cp.computes.filter(c => c.kind === 'synapse-spark' || c.kind === 'databricks-cluster').length === 0 && (
            <MessageBar intent="warning">
              <MessageBarBody>
                <MessageBarTitle>No notebook compute is available</MessageBarTitle>
                Notebooks run on a Synapse Spark pool or a Databricks cluster. Provision one and
                set <code>LOOM_SYNAPSE_WORKSPACE</code> (Synapse Spark) or
                {' '}<code>LOOM_DATABRICKS_HOSTNAME</code> (Databricks) so it appears in the compute
                picker above. You can still edit and save cells without compute.
              </MessageBarBody>
            </MessageBar>
          )}
          {runMsg && <MessageBar intent="info"><MessageBarBody>{runMsg}</MessageBarBody></MessageBar>}

          {notebookId && (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {dirty && <Badge appearance="outline" color="warning">unsaved</Badge>}
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
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <CellAdder
                  onAddCode={() => insertCell(-1, 'code')}
                  onAddMarkdown={() => insertCell(-1, 'markdown')}
                />
                {cells.map((c, idx) => (
                  <div key={c.id}>
                    {c.type === 'code' ? (
                      <CodeCell
                        cell={c}
                        active={activeCellId === c.id}
                        onFocus={() => setActiveCellId(c.id)}
                        onChange={(next) => updateCell(c.id, next)}
                        onRun={runCell}
                        onDelete={() => deleteCell(c.id)}
                        onMoveUp={() => moveCell(c.id, -1)}
                        onMoveDown={() => moveCell(c.id, 1)}
                        onDuplicate={() => duplicateCell(c.id)}
                        canMoveUp={idx > 0}
                        canMoveDown={idx < cells.length - 1}
                        notebookId={notebookId}
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
                    ) : (
                      <MarkdownCell
                        cell={c}
                        active={activeCellId === c.id}
                        onFocus={() => setActiveCellId(c.id)}
                        onChange={(next) => updateCell(c.id, next)}
                        onDelete={() => deleteCell(c.id)}
                        onMoveUp={() => moveCell(c.id, -1)}
                        onMoveDown={() => moveCell(c.id, 1)}
                        onDuplicate={() => duplicateCell(c.id)}
                        canMoveUp={idx > 0}
                        canMoveDown={idx < cells.length - 1}
                      />
                    )}
                    <CellAdder
                      onAddCode={() => insertCell(idx, 'code')}
                      onAddMarkdown={() => insertCell(idx, 'markdown')}
                    />
                  </div>
                ))}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Subtitle2>Run history ({jobs.length})</Subtitle2>
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
        </div>
      }
    />
  );
}
