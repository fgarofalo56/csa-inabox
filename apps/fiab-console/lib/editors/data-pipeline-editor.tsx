'use client';

/**
 * DataPipelineEditor — Fabric-native data pipeline editor wired to live
 * Fabric REST. Pipeline definition is edited as JSON (pipeline-content.json
 * inline-base64). Runs trigger Pipeline jobs on the item.
 *
 * Auth gate: requires Console UAMI SP authorized in the Fabric tenant and
 * added to the target workspace. Underlying 401/403 surface verbatim.
 *
 * Backed by /api/loom/workspaces + /api/items/data-pipeline/**.
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
  Play20Regular, Add20Regular, Save20Regular, ArrowSync20Regular, Delete20Regular, Flow20Regular,
} from '@fluentui/react-icons';
import { ItemEditorChrome } from './item-editor-chrome';
import { PipelineDagView, extractActivities } from '@/lib/components/pipeline/pipeline-dag-view';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';

const RIBBON: RibbonTab[] = [
  { id: 'home', label: 'Home', groups: [
    { label: 'Run', actions: [{ label: 'Run' }, { label: 'Run history' }] },
    { label: 'Item', actions: [{ label: 'New pipeline' }, { label: 'Save' }, { label: 'Delete' }] },
  ]},
];

const useStyles = makeStyles({
  pad: { padding: 16, display: 'flex', flexDirection: 'column', gap: 12, flex: 1, minHeight: 0 },
  toolbar: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
  editor: {
    width: '100%', minHeight: 300,
    fontFamily: 'Consolas, "Cascadia Code", monospace', fontSize: 12, padding: 12,
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 4,
    backgroundColor: tokens.colorNeutralBackground3, color: tokens.colorNeutralForeground1,
    resize: 'vertical',
  },
  treePad: { padding: 8 },
  tableWrap: { overflow: 'auto', maxHeight: 240, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 4 },
  cell: { fontFamily: 'Consolas, monospace', fontSize: 12, whiteSpace: 'nowrap' },
});

interface WorkspaceLite { id: string; name: string; isOnDedicatedCapacity?: boolean; }
interface PipelineLite { id: string; displayName: string; description?: string; }
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
  return { workspaces, error, hint, loading };
}

const STARTER_PIPELINE = `{
  "properties": {
    "activities": [
      {
        "name": "Wait1",
        "type": "Wait",
        "typeProperties": { "waitTimeInSeconds": 5 }
      }
    ]
  }
}`;

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

interface Props { item: FabricItemType; id: string; }

export function DataPipelineEditor({ item, id }: Props) {
  const s = useStyles();
  const ws = useWorkspaces();
  const [workspaceId, setWorkspaceId] = useState('');
  const [pipelines, setPipelines] = useState<PipelineLite[] | null>(null);
  const [pipelineId, setPipelineId] = useState('');
  const [defText, setDefText] = useState(STARTER_PIPELINE);
  const [dirty, setDirty] = useState(false);
  const [listErr, setListErr] = useState<string | null>(null);
  const [listHint, setListHint] = useState<string | null>(null);
  const [detailErr, setDetailErr] = useState<string | null>(null);
  const [parseErr, setParseErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [runMsg, setRunMsg] = useState<string | null>(null);
  const [jobs, setJobs] = useState<JobLite[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createBusy, setCreateBusy] = useState(false);
  const [createErr, setCreateErr] = useState<string | null>(null);

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
    setDetailErr(null); setRunMsg(null);
    try {
      const r = await fetch(`/api/items/data-pipeline/${encodeURIComponent(pId)}?workspaceId=${encodeURIComponent(wsId)}`);
      const j = await r.json();
      if (!j.ok) { setDetailErr(j.error); return; }
      const part = j.definition?.parts?.find((p: any) => /pipeline-content\.json$/.test(p.path));
      if (part?.payload) {
        const decoded = fromB64(part.payload);
        try { setDefText(JSON.stringify(JSON.parse(decoded), null, 2)); } catch { setDefText(decoded); }
      } else {
        setDefText(STARTER_PIPELINE);
      }
      setDirty(false);
    } catch (e: any) { setDetailErr(e?.message || String(e)); }
  }, []);

  const loadJobs = useCallback(async (wsId: string, pId: string) => {
    try {
      const r = await fetch(`/api/items/data-pipeline/${encodeURIComponent(pId)}/jobs?workspaceId=${encodeURIComponent(wsId)}`);
      const j = await r.json();
      if (j.ok) setJobs(j.jobs || []);
    } catch { /* keep last */ }
  }, []);

  useEffect(() => { if (workspaceId) loadList(workspaceId); }, [workspaceId, loadList]);
  useEffect(() => {
    if (workspaceId && pipelineId) { loadDetail(workspaceId, pipelineId); loadJobs(workspaceId, pipelineId); }
  }, [workspaceId, pipelineId, loadDetail, loadJobs]);

  const save = useCallback(async () => {
    if (!workspaceId || !pipelineId) return;
    setParseErr(null); setDetailErr(null);
    try { JSON.parse(defText); } catch (e: any) { setParseErr(e?.message || 'invalid JSON'); return; }
    setSaving(true);
    try {
      const definition = {
        parts: [{ path: 'pipeline-content.json', payload: toB64(defText), payloadType: 'InlineBase64' }],
      };
      const r = await fetch(`/api/items/data-pipeline/${encodeURIComponent(pipelineId)}?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ definition }),
      });
      const j = await r.json();
      if (!j.ok) setDetailErr(j.error || 'save failed');
      else setDirty(false);
    } finally { setSaving(false); }
  }, [workspaceId, pipelineId, defText]);

  const run = useCallback(async () => {
    if (!workspaceId || !pipelineId) return;
    setRunning(true); setRunMsg(null);
    try {
      const r = await fetch(`/api/items/data-pipeline/${encodeURIComponent(pipelineId)}/run?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
      });
      const j = await r.json();
      if (!j.ok) setRunMsg(`Run failed: ${j.error}`);
      else { setRunMsg('Pipeline queued.'); setTimeout(() => loadJobs(workspaceId, pipelineId), 1500); }
    } finally { setRunning(false); }
  }, [workspaceId, pipelineId, loadJobs]);

  const create = useCallback(async () => {
    if (!workspaceId || !createName.trim()) return;
    setCreateBusy(true); setCreateErr(null);
    try {
      const definition = {
        parts: [{ path: 'pipeline-content.json', payload: toB64(STARTER_PIPELINE), payloadType: 'InlineBase64' }],
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

  return (
    <ItemEditorChrome item={item} id={id} ribbon={RIBBON}
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
        <div className={s.pad}>
          <div className={s.toolbar}>
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
            <Button appearance="outline" icon={<ArrowSync20Regular />} onClick={() => workspaceId && loadList(workspaceId)} disabled={!workspaceId}>Refresh</Button>
            <Dialog open={createOpen} onOpenChange={(_, d) => setCreateOpen(d.open)}>
              <DialogTrigger disableButtonEnhancement>
                <Button appearance="outline" icon={<Add20Regular />} disabled={!workspaceId}>New</Button>
              </DialogTrigger>
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
            <Button appearance="outline" icon={<Save20Regular />} disabled={saving || !pipelineId || !dirty} onClick={save}>{saving ? 'Saving…' : 'Save'}</Button>
            <Button appearance="primary" icon={<Play20Regular />} disabled={running || !pipelineId} onClick={run}>{running ? 'Queuing…' : 'Run'}</Button>
            <Button appearance="subtle" icon={<Delete20Regular />} disabled={!pipelineId} onClick={del}>Delete</Button>
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
          {parseErr && <MessageBar intent="error"><MessageBarBody>JSON parse error: {parseErr}</MessageBarBody></MessageBar>}
          {runMsg && <MessageBar intent="info"><MessageBarBody>{runMsg}</MessageBarBody></MessageBar>}

          {pipelineId && (
            <>
              {dirty && <Badge appearance="outline" color="warning" style={{ alignSelf: 'flex-start' }}>unsaved</Badge>}
              {/* v3.27: read-only DAG view derived from JSON state */}
              <Subtitle2>Activity graph ({extractActivities(defText).length})</Subtitle2>
              <PipelineDagView
                activities={extractActivities(defText)}
                emptyHint="No activities in this pipeline yet. Edit the JSON below and add objects under properties.activities[]."
              />
              <Caption1>Pipeline definition (JSON)</Caption1>
              <textarea
                className={s.editor}
                spellCheck={false}
                value={defText}
                onChange={(e) => { setDefText(e.target.value); setDirty(true); }}
                aria-label="Pipeline JSON"
              />
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Subtitle2>Run history ({jobs.length})</Subtitle2>
                <Button size="small" appearance="subtle" icon={<ArrowSync20Regular />} onClick={() => loadJobs(workspaceId, pipelineId)}>Refresh</Button>
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
