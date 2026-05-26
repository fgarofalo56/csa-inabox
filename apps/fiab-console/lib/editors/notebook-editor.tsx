'use client';

/**
 * NotebookEditor — Fabric-native notebook editor wired to live Fabric REST.
 *
 * Auth gate: requires the Console UAMI's SP to be (a) registered in the
 * Fabric tenant ("Service principals can use Fabric APIs") and (b) added
 * to the target workspace. If either is missing, the editor surfaces the
 * underlying 401/403 verbatim via MessageBar — no mocks.
 *
 * Backed by /api/fabric/workspaces + /api/items/notebook/**.
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
      const r = await fetch('/api/fabric/workspaces');
      const j = await r.json();
      if (!j.ok) { setError(j.error || 'failed'); setHint(j.hint || null); setWorkspaces([]); }
      else setWorkspaces(j.workspaces || []);
    } catch (e: any) { setError(e?.message || String(e)); setWorkspaces([]); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);
  return { workspaces, error, hint, loading, reload: load };
}

const STARTER_PY = `# Fabric Notebook (PySpark)\n# Edit, then click Save. Click Run to queue a notebook job instance.\ndf = spark.range(10)\ndf.show()\n`;

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

export function NotebookEditor({ item, id }: Props) {
  const s = useStyles();
  const ws = useWorkspaces();
  const [workspaceId, setWorkspaceId] = useState('');
  const [notebooks, setNotebooks] = useState<NotebookLite[] | null>(null);
  const [notebookId, setNotebookId] = useState('');
  const [source, setSource] = useState(STARTER_PY);
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

  // Pick up Lakehouse "Open in notebook" prefill (stored in localStorage before route push).
  useEffect(() => {
    if (typeof window === 'undefined' || id !== 'new') return;
    try {
      const raw = localStorage.getItem('loom.notebook.prefill');
      if (!raw) return;
      const data = JSON.parse(raw);
      if (data?.code) {
        setSource(data.code);
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
      const part = j.definition?.parts?.find((p: any) => /notebook-content\.(py|sql|scala|r)$/.test(p.path));
      if (part?.payload) setSource(decodePy(part.payload));
      else setSource(STARTER_PY);
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
      const definition = {
        format: 'fabricGitSource',
        parts: [{ path: 'notebook-content.py', payload: encodePy(source), payloadType: 'InlineBase64' }],
      };
      const r = await fetch(`/api/items/notebook/${encodeURIComponent(notebookId)}?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ definition }),
      });
      const j = await r.json();
      if (!j.ok) setDetailErr(j.error || 'save failed');
      else setDirty(false);
    } finally { setSaving(false); }
  }, [workspaceId, notebookId, source]);

  const run = useCallback(async () => {
    if (!workspaceId || !notebookId) return;
    setRunning(true); setRunMsg(null);
    try {
      const r = await fetch(`/api/items/notebook/${encodeURIComponent(notebookId)}/run?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      const j = await r.json();
      if (!j.ok) setRunMsg(`Run failed: ${j.error}`);
      else { setRunMsg('Job queued. Status polling starts via Refresh.'); setTimeout(() => loadJobs(workspaceId, notebookId), 1500); }
    } finally { setRunning(false); }
  }, [workspaceId, notebookId, loadJobs]);

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
            <Badge appearance="filled" color="brand">Fabric Notebook</Badge>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 280 }}>
              <Caption1>Workspace</Caption1>
              <Select value={workspaceId} onChange={(_, d) => setWorkspaceId(d.value)} disabled={ws.loading || (ws.workspaces?.length ?? 0) === 0}>
                {!workspaceId && <option value="">{ws.loading ? 'Loading workspaces…' : 'Select a workspace'}</option>}
                {(ws.workspaces || []).map((w) => (
                  <option key={w.id} value={w.id}>{w.name}{w.isOnDedicatedCapacity ? ' · F/P SKU' : ''}</option>
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
              {dirty && <Badge appearance="outline" color="warning" style={{ alignSelf: 'flex-start' }}>unsaved</Badge>}
              <textarea
                className={s.editor}
                spellCheck={false}
                value={source}
                onChange={(e) => { setSource(e.target.value); setDirty(true); }}
                aria-label="Notebook PySpark source"
              />
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
