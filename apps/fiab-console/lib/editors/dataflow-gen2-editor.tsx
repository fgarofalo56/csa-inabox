'use client';

/**
 * DataflowGen2Editor — Fabric-native Dataflow Gen2 editor wired to live
 * Fabric REST. Dataflows are managed as items + JSON definition; Refresh
 * triggers a Refresh job on the item.
 *
 * Auth gate: requires Console UAMI SP authorized in the Fabric tenant and
 * added to the target workspace. Underlying 401/403 surface verbatim.
 *
 * Backed by /api/loom/workspaces + /api/items/dataflow/**.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Subtitle2, Caption1, Badge, Button, Spinner, Input,
  Tree, TreeItem, TreeItemLayout, Select,
  MessageBar, MessageBarBody, MessageBarTitle,
  Dialog, DialogTrigger, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Add20Regular, Save20Regular, ArrowSync20Regular, Delete20Regular, Flow20Regular,
} from '@fluentui/react-icons';
import { ItemEditorChrome } from './item-editor-chrome';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';
import { MonacoTextarea } from '@/lib/components/editor/monaco-textarea';

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
});

interface WorkspaceLite { id: string; name: string; isOnDedicatedCapacity?: boolean; }
interface DataflowLite { id: string; displayName: string; description?: string; }

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

const STARTER_M = `// Power Query M (mashup.pq). Edit then click Save.
section Section1;
shared Query1 = let
    Source = #table({"col1","col2"}, {{"hello", "world"}})
in
    Source;`;

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

export function DataflowGen2Editor({ item, id }: Props) {
  const s = useStyles();
  const ws = useWorkspaces();
  const [workspaceId, setWorkspaceId] = useState('');
  const [dataflows, setDataflows] = useState<DataflowLite[] | null>(null);
  const [dataflowId, setDataflowId] = useState('');
  const [defText, setDefText] = useState(STARTER_M);
  const [partPath, setPartPath] = useState('mashup.pq');
  const [dirty, setDirty] = useState(false);
  const [listErr, setListErr] = useState<string | null>(null);
  const [listHint, setListHint] = useState<string | null>(null);
  const [detailErr, setDetailErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshMsg, setRefreshMsg] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createBusy, setCreateBusy] = useState(false);
  const [createErr, setCreateErr] = useState<string | null>(null);

  const loadList = useCallback(async (wsId: string) => {
    setListErr(null); setListHint(null);
    try {
      const r = await fetch(`/api/items/dataflow?workspaceId=${encodeURIComponent(wsId)}`);
      const j = await r.json();
      if (!j.ok) { setDataflows([]); setListErr(j.error); setListHint(j.hint); return; }
      setDataflows(j.dataflows || []);
      if ((j.dataflows || []).length && !dataflowId) setDataflowId(j.dataflows[0].id);
    } catch (e: any) { setDataflows([]); setListErr(e?.message || String(e)); }
  }, [dataflowId]);

  const loadDetail = useCallback(async (wsId: string, dId: string) => {
    setDetailErr(null); setRefreshMsg(null);
    try {
      const r = await fetch(`/api/items/dataflow/${encodeURIComponent(dId)}?workspaceId=${encodeURIComponent(wsId)}`);
      const j = await r.json();
      if (!j.ok) { setDetailErr(j.error); return; }
      const parts: Array<{ path: string; payload: string }> = j.definition?.parts || [];
      const main = parts.find((p) => /mashup\.(pq|m)$/i.test(p.path))
        || parts.find((p) => /queryMetadata\.json$/i.test(p.path))
        || parts[0];
      if (main?.payload) { setPartPath(main.path); setDefText(fromB64(main.payload)); }
      else { setPartPath('mashup.pq'); setDefText(STARTER_M); }
      setDirty(false);
    } catch (e: any) { setDetailErr(e?.message || String(e)); }
  }, []);

  useEffect(() => { if (workspaceId) loadList(workspaceId); }, [workspaceId, loadList]);
  useEffect(() => { if (workspaceId && dataflowId) loadDetail(workspaceId, dataflowId); }, [workspaceId, dataflowId, loadDetail]);

  const save = useCallback(async () => {
    if (!workspaceId || !dataflowId) return;
    setSaving(true); setDetailErr(null); setRefreshMsg('Saving dataflow…');
    // Phase 4.5 — snapshot defText via functional setter so a Run-then-Edit
    // race doesn't clobber in-flight edits with a stale closure capture.
    let textSnapshot = defText;
    setDefText((prev) => { textSnapshot = prev; return prev; });
    try {
      const definition = { parts: [{ path: partPath, payload: toB64(textSnapshot), payloadType: 'InlineBase64' }] };
      const r = await fetch(`/api/items/dataflow/${encodeURIComponent(dataflowId)}?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ definition }),
      });
      const j = await r.json();
      if (!j.ok) {
        setDetailErr(j.error || 'save failed');
        setRefreshMsg(`Save failed: ${j.error || 'unknown'}`);
      } else {
        setDirty(false);
        setRefreshMsg(`Saved at ${new Date().toLocaleTimeString()}`);
      }
    } catch (e: any) {
      setDetailErr(e?.message || String(e));
      setRefreshMsg(`Save failed: ${e?.message || e}`);
    } finally { setSaving(false); }
  }, [workspaceId, dataflowId, partPath, defText]);

  // Phase 4.5 — Ctrl+S / Cmd+S keyboard shortcut for Save.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (workspaceId && dataflowId && dirty && !saving) save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [workspaceId, dataflowId, dirty, saving, save]);

  const refresh = useCallback(async () => {
    if (!workspaceId || !dataflowId) return;
    setRefreshing(true); setRefreshMsg(null);
    try {
      const r = await fetch(`/api/items/dataflow/${encodeURIComponent(dataflowId)}/refresh?workspaceId=${encodeURIComponent(workspaceId)}`, { method: 'POST' });
      const j = await r.json();
      if (!j.ok) setRefreshMsg(`Refresh failed: ${j.error}`);
      else setRefreshMsg('Refresh job queued.');
    } finally { setRefreshing(false); }
  }, [workspaceId, dataflowId]);

  const create = useCallback(async () => {
    if (!workspaceId || !createName.trim()) return;
    setCreateBusy(true); setCreateErr(null);
    try {
      const r = await fetch(`/api/items/dataflow?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ displayName: createName.trim() }),
      });
      const j = await r.json();
      if (!j.ok) { setCreateErr(j.error || 'create failed'); return; }
      setCreateOpen(false); setCreateName('');
      await loadList(workspaceId);
      if (j.dataflow?.id) setDataflowId(j.dataflow.id);
    } finally { setCreateBusy(false); }
  }, [workspaceId, createName, loadList]);

  const del = useCallback(async () => {
    if (!workspaceId || !dataflowId) return;
    if (!confirm('Delete this dataflow? This cannot be undone.')) return;
    await fetch(`/api/items/dataflow/${encodeURIComponent(dataflowId)}?workspaceId=${encodeURIComponent(workspaceId)}`, { method: 'DELETE' });
    setDataflowId('');
    await loadList(workspaceId);
  }, [workspaceId, dataflowId, loadList]);

  const canRefresh = !refreshing && !!dataflowId;
  const canSave = !saving && !!dataflowId && dirty;
  const canDelete = !!dataflowId;
  const canCreate = !!workspaceId;
  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Refresh', actions: [
        { label: refreshing ? 'Refreshing…' : 'Refresh now', onClick: canRefresh ? refresh : undefined, disabled: !canRefresh },
      ]},
      { label: 'Item', actions: [
        { label: 'New dataflow', onClick: canCreate ? () => setCreateOpen(true) : undefined, disabled: !canCreate },
        { label: saving ? 'Saving…' : 'Save', onClick: canSave ? save : undefined, disabled: !canSave },
        { label: 'Delete', onClick: canDelete ? del : undefined, disabled: !canDelete },
      ]},
    ]},
  ], [refreshing, canRefresh, refresh, canCreate, saving, canSave, save, canDelete, del]);

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon}
      leftPanel={
        <div className={s.treePad}>
          <Subtitle2 style={{ marginBottom: 8 }}>Dataflows Gen2</Subtitle2>
          {!workspaceId && <Caption1>Select a workspace.</Caption1>}
          {workspaceId && dataflows === null && <Spinner size="tiny" label="Loading…" />}
          {dataflows && dataflows.length === 0 && !listErr && <Caption1>No dataflows.</Caption1>}
          <Tree aria-label="Dataflows">
            {(dataflows || []).map((d) => (
              <TreeItem key={d.id} itemType="leaf" value={d.id} onClick={() => setDataflowId(d.id)}>
                <TreeItemLayout iconBefore={<Flow20Regular />}>
                  {dataflowId === d.id ? <strong>{d.displayName}</strong> : d.displayName}
                </TreeItemLayout>
              </TreeItem>
            ))}
          </Tree>
        </div>
      }
      main={
        <div className={s.pad}>
          <div className={s.toolbar}>
            <Badge appearance="filled" color="brand">Dataflow Gen2</Badge>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 280 }}>
              <Caption1>Workspace</Caption1>
              <Select value={workspaceId} onChange={(_, d) => setWorkspaceId(d.value)} disabled={ws.loading || (ws.workspaces?.length ?? 0) === 0}>
                {!workspaceId && <option value="">{ws.loading ? 'Loading workspaces…' : 'Select a workspace'}</option>}
                {(ws.workspaces || []).map((w) => (
                  <option key={w.id} value={w.id}>{w.name}{w.isOnDedicatedCapacity ? ' · F/P SKU' : ''}</option>
                ))}
              </Select>
            </div>
            <Button appearance="outline" icon={<ArrowSync20Regular />} onClick={() => workspaceId && loadList(workspaceId)} disabled={!workspaceId}>Refresh list</Button>
            <Dialog open={createOpen} onOpenChange={(_, d) => setCreateOpen(d.open)}>
              <DialogTrigger disableButtonEnhancement>
                <Button appearance="outline" icon={<Add20Regular />} disabled={!workspaceId}>New</Button>
              </DialogTrigger>
              <DialogSurface>
                <DialogBody>
                  <DialogTitle>Create Fabric dataflow Gen2</DialogTitle>
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
            <Button appearance="outline" icon={<Save20Regular />} disabled={saving || !dataflowId || !dirty} onClick={save}>{saving ? 'Saving…' : 'Save'}</Button>
            <Button appearance="primary" icon={<ArrowSync20Regular />} disabled={refreshing || !dataflowId} onClick={refresh}>{refreshing ? 'Refreshing…' : 'Refresh'}</Button>
            <Button appearance="subtle" icon={<Delete20Regular />} disabled={!dataflowId} onClick={del}>Delete</Button>
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
          {refreshMsg && <MessageBar intent="info"><MessageBarBody>{refreshMsg}</MessageBarBody></MessageBar>}

          {dataflowId && (
            <>
              {dirty && <Badge appearance="outline" color="warning" style={{ alignSelf: 'flex-start' }}>unsaved</Badge>}
              <Caption1>Definition part: <code>{partPath}</code></Caption1>
              <MonacoTextarea
                value={defText}
                onChange={(v) => { setDefText(v); setDirty(true); }}
                /* Pick a sensible Monaco language based on the active part: .pq/.m
                   is Power Query M (no first-class Monaco mode — fall back to
                   plaintext); queryMetadata.json + the rest are JSON. */
                language={/\.(pq|m)$/i.test(partPath) ? 'plaintext' : 'json'}
                height={360}
                minHeight={280}
                ariaLabel="Dataflow definition"
              />
            </>
          )}
        </div>
      }
    />
  );
}
