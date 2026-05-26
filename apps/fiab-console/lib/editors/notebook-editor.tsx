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

import { useCallback, useEffect, useState } from 'react';
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
} from '@fluentui/react-icons';
import { ItemEditorChrome } from './item-editor-chrome';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';
import { CodeCell } from '@/lib/components/notebook/code-cell';
import { MarkdownCell } from '@/lib/components/notebook/markdown-cell';
import { CellAdder } from '@/lib/components/notebook/cell-adder';
import { type NotebookCell, type NotebookCellLang, emptyCell, migrateLegacyState } from '@/lib/types/notebook-cell';

const RIBBON: RibbonTab[] = [
  { id: 'home', label: 'Home', groups: [
    { label: 'Run', actions: [{ label: 'Run' }, { label: 'Run history' }] },
    { label: 'Item', actions: [{ label: 'New notebook' }, { label: 'Save' }, { label: 'Delete' }] },
    { label: 'Workspace', actions: [{ label: 'Switch workspace' }, { label: 'Refresh list' }] },
  ]},
];

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
  useEffect(() => {
    fetch('/api/loom/compute-targets').then(r => r.json()).then(j => {
      if (j.ok) setComputes(j.computes || []);
      else setError(j.error || 'failed to list compute');
    }).catch(e => setError(e?.message || String(e))).finally(() => setLoading(false));
  }, []);
  return { computes, loading, error };
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

  // Auto-pick first runnable compute (skip serverless SQL — not for notebooks)
  useEffect(() => {
    if (!computeId && cp.computes.length) {
      const first = cp.computes.find(c => c.kind === 'synapse-spark' || c.kind === 'databricks-cluster');
      if (first) setComputeId(first.id);
    }
  }, [cp.computes, computeId]);

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
    try {
      const r = await fetch(`/api/items/notebook/${encodeURIComponent(notebookId)}?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ definition: { cells, defaultLang } }),
      });
      const j = await r.json();
      if (!j.ok) setDetailErr(j.error || 'save failed');
      else setDirty(false);
    } finally { setSaving(false); }
  }, [workspaceId, notebookId, cells, defaultLang]);

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
      const MAX_MS = 8 * 60 * 1000;
      while (Date.now() - start < MAX_MS) {
        await new Promise(res => setTimeout(res, 4000));
        const pollRes = await fetch(`/api/items/notebook/${encodeURIComponent(notebookId)}/runs/${encodeURIComponent(runId)}?workspaceId=${encodeURIComponent(workspaceId)}`);
        const p = await pollRes.json();
        if (!p.ok) { setRunMsg(`Poll error: ${p.error || pollRes.status}`); break; }
        if (p.runId && p.runId !== runId) runId = p.runId; // promotion when statement is submitted
        const phase = p.phase ? ` · ${p.phase}` : '';
        setRunMsg(`Status: ${p.status}${phase}`);
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

  // Per-cell run: dispatches a single cell's source to the notebook /run endpoint with cellId, then polls.
  const runCell = useCallback(async (cell: NotebookCell) => {
    if (!workspaceId || !notebookId) return;
    if (!computeId) { setRunMsg('Pick a compute target before running.'); return; }
    if (cell.type !== 'code') return;
    updateCell(cell.id, { ...cell, output: { status: 'pending' } });
    setRunMsg(`Running cell ${cell.id.slice(0, 6)}…`);
    try {
      const r = await fetch(`/api/items/notebook/${encodeURIComponent(notebookId)}/run?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ compute: computeId, cellId: cell.id, source: cell.source, lang: cell.lang || defaultLang }),
      });
      const j = await r.json();
      if (!j.ok) {
        updateCell(cell.id, { ...cell, output: { status: 'error', ename: 'DispatchError', evalue: j.error || 'dispatch failed' } });
        setRunMsg(`Cell run failed: ${j.error}`);
        return;
      }
      let runId: string = j.runId;
      const start = Date.now();
      const MAX_MS = 8 * 60 * 1000;
      while (Date.now() - start < MAX_MS) {
        await new Promise(res => setTimeout(res, 4000));
        const pollRes = await fetch(`/api/items/notebook/${encodeURIComponent(notebookId)}/runs/${encodeURIComponent(runId)}?workspaceId=${encodeURIComponent(workspaceId)}`);
        const p = await pollRes.json();
        if (!p.ok) {
          updateCell(cell.id, { ...cell, output: { status: 'error', ename: 'PollError', evalue: p.error || String(pollRes.status) } });
          break;
        }
        if (p.runId && p.runId !== runId) runId = p.runId;
        setRunMsg(`Cell ${cell.id.slice(0, 6)}: ${p.status}${p.phase ? ' · ' + p.phase : ''}`);
        if (p.output) {
          updateCell(cell.id, {
            ...cell,
            executionCount: (cell.executionCount || 0) + 1,
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
          updateCell(cell.id, { ...cell, output: { status: 'error', ename: p.status, evalue: p.resultState || '' } });
          break;
        }
      }
      loadJobs(workspaceId, notebookId);
    } catch (e: any) {
      updateCell(cell.id, { ...cell, output: { status: 'error', ename: 'Exception', evalue: e?.message || String(e) } });
    }
  }, [workspaceId, notebookId, computeId, defaultLang, updateCell, loadJobs]);

  return (
    <ItemEditorChrome item={item} id={id} ribbon={RIBBON}
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
        </div>
      }
      main={
        <div className={s.pad}>
          <div className={s.toolbar}>
            <Badge appearance="filled" color="brand">Loom Notebook</Badge>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 240 }}>
              <Caption1>Workspace</Caption1>
              <Select value={workspaceId} onChange={(_, d) => setWorkspaceId(d.value)} disabled={ws.loading || (ws.workspaces?.length ?? 0) === 0}>
                {!workspaceId && <option value="">{ws.loading ? 'Loading workspaces…' : 'Select a workspace'}</option>}
                {(ws.workspaces || []).map((w) => (
                  <option key={w.id} value={w.id}>{w.name}{w.isOnDedicatedCapacity ? ' · dedicated' : ''}</option>
                ))}
              </Select>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 280 }}>
              <Caption1>Compute target</Caption1>
              <Select value={computeId} onChange={(_, d) => setComputeId(d.value)} disabled={cp.loading || cp.computes.length === 0}>
                {!computeId && <option value="">{cp.loading ? 'Loading compute…' : 'Select compute'}</option>}
                {cp.computes
                  .filter(c => c.kind === 'synapse-spark' || c.kind === 'databricks-cluster')
                  .map(c => (
                    <option key={c.id} value={c.id}>{c.name}{c.state ? ` · ${c.state}` : ''}</option>
                  ))}
              </Select>
            </div>
            <Button appearance="outline" icon={<ArrowSync20Regular />} onClick={() => workspaceId && loadList(workspaceId)} disabled={!workspaceId}>Refresh</Button>
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
            <Button appearance="outline" icon={<Save20Regular />} disabled={saving || !notebookId || !dirty} onClick={save}>{saving ? 'Saving…' : 'Save'}</Button>
            <Button appearance="primary" icon={<Play20Regular />} disabled={running || !notebookId} onClick={run}>{running ? 'Queuing…' : 'Run'}</Button>
            <Button appearance="subtle" icon={<Delete20Regular />} disabled={!notebookId} onClick={del}>Delete</Button>
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
                        canMoveUp={idx > 0}
                        canMoveDown={idx < cells.length - 1}
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
