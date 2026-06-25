'use client';

/**
 * LakehouseShortcutEditor — the Azure-native equivalent of a OneLake shortcut:
 * a named pointer to external Delta/Parquet a lakehouse reads IN PLACE without
 * copying. The pointer persists as a Cosmos workspace item; the LIVE backend is
 * ADLS Gen2. Create + Verify list the target via the real ADLS client (reused
 * through /api/items/lakehouse-shortcut) to prove resolution WITHOUT copying.
 * No Microsoft Fabric / OneLake dependency.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Caption1, Badge, Button, Spinner, Input, Textarea, Field, Select,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  Dialog, DialogTrigger, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Add20Regular, ArrowSync20Regular, Delete20Regular, Link20Regular, CheckmarkCircle20Regular,
} from '@fluentui/react-icons';
import { ItemEditorChrome } from './item-editor-chrome';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';

const useStyles = makeStyles({
  pad: { padding: tokens.spacingVerticalL, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, flex: 1, minHeight: 0, minWidth: 0, overflowY: 'auto' },
  toolbar: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'flex-end', flexWrap: 'wrap' },
  field: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, minWidth: '220px' },
  mono: { fontFamily: tokens.fontFamilyMonospace, fontSize: tokens.fontSizeBase200, overflowWrap: 'anywhere', wordBreak: 'break-word', minWidth: 0 },
  tableWrap: { overflow: 'auto', border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium },
  section: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
});

const CONTAINERS = ['bronze', 'silver', 'gold', 'landing', 'csv-imports'];

interface WorkspaceLite { id: string; name: string }
interface Shortcut { id: string; displayName: string; container?: string; path?: string; abfss?: string; httpsUrl?: string; entryCount?: number; lastVerifiedAt?: string }
interface Props { item: FabricItemType; id: string }

export function LakehouseShortcutEditor({ item, id }: Props) {
  const s = useStyles();
  const [workspaces, setWorkspaces] = useState<WorkspaceLite[] | null>(null);
  const [workspaceId, setWorkspaceId] = useState('');
  const [shortcuts, setShortcuts] = useState<Shortcut[] | null>(null);
  const [adlsConfigured, setAdlsConfigured] = useState(true);
  const [msg, setMsg] = useState<{ intent: 'success' | 'error'; text: string } | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [cName, setCName] = useState('');
  const [cContainer, setCContainer] = useState('bronze');
  const [cPath, setCPath] = useState('');
  const [cBusy, setCBusy] = useState(false);
  const [cErr, setCErr] = useState<string | null>(null);
  const [verifyResult, setVerifyResult] = useState<{ resolved: boolean; reason?: string; abfss?: string; entryCount?: number; sample?: any[] } | null>(null);
  const [verifyBusy, setVerifyBusy] = useState(false);

  useEffect(() => {
    fetch('/api/loom/workspaces').then(r => r.json()).then(j => setWorkspaces(j.ok ? (j.workspaces || []) : [])).catch(() => setWorkspaces([]));
  }, []);

  const load = useCallback(async (wsId: string) => {
    setShortcuts(null);
    try {
      const r = await fetch(`/api/items/lakehouse-shortcut?workspaceId=${encodeURIComponent(wsId)}`);
      const j = await r.json();
      if (!j.ok) { setShortcuts([]); return; }
      setShortcuts(j.shortcuts || []);
      setAdlsConfigured(!!j.adlsConfigured);
    } catch { setShortcuts([]); }
  }, []);

  useEffect(() => { if (workspaceId) void load(workspaceId); }, [workspaceId, load]);

  const verify = useCallback(async () => {
    if (!workspaceId || !cContainer) return;
    setVerifyBusy(true); setVerifyResult(null); setCErr(null);
    try {
      const r = await fetch(`/api/items/lakehouse-shortcut?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'verify', container: cContainer, path: cPath.trim() }),
      });
      const j = await r.json();
      if (!j.ok) { setCErr(j.error || 'verify failed'); return; }
      setVerifyResult(j);
    } catch (e: any) { setCErr(e?.message || String(e)); }
    finally { setVerifyBusy(false); }
  }, [workspaceId, cContainer, cPath]);

  const create = useCallback(async () => {
    if (!workspaceId || !cName.trim() || !cContainer) return;
    setCBusy(true); setCErr(null);
    try {
      const r = await fetch(`/api/items/lakehouse-shortcut?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ displayName: cName.trim(), container: cContainer, path: cPath.trim() }),
      });
      const j = await r.json();
      if (!j.ok) { setCErr(j.error || 'create failed'); return; }
      setMsg({ intent: 'success', text: `Created shortcut "${cName.trim()}" → resolved ${j.resolution?.entryCount ?? 0} entries (no copy).` });
      setCreateOpen(false); setCName(''); setCPath(''); setVerifyResult(null);
      await load(workspaceId);
    } finally { setCBusy(false); }
  }, [workspaceId, cName, cContainer, cPath, load]);

  const del = useCallback(async (sid: string) => {
    if (!workspaceId) return;
    setMsg(null);
    try {
      const r = await fetch(`/api/items/lakehouse-shortcut?workspaceId=${encodeURIComponent(workspaceId)}&id=${encodeURIComponent(sid)}`, { method: 'DELETE' });
      const j = await r.json();
      if (!j.ok) { setMsg({ intent: 'error', text: j.error || 'delete failed' }); return; }
      setMsg({ intent: 'success', text: 'Shortcut deleted (the external data is untouched).' });
      await load(workspaceId);
    } catch (e: any) { setMsg({ intent: 'error', text: e?.message || String(e) }); }
  }, [workspaceId, load]);

  const ribbon: RibbonTab[] = [
    { id: 'home', label: 'Home', groups: [
      { label: 'Shortcut', actions: [
        { label: 'New shortcut', onClick: workspaceId ? () => setCreateOpen(true) : undefined, disabled: !workspaceId },
        { label: 'Refresh', onClick: workspaceId ? () => void load(workspaceId) : undefined, disabled: !workspaceId },
      ]},
    ]},
  ];

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon} main={
      <div className={s.pad}>
        <div className={s.toolbar}>
          <Badge appearance="filled" color="brand" icon={<Link20Regular />}>Lakehouse shortcut</Badge>
          <div className={s.field}>
            <Caption1>Workspace</Caption1>
            <Select value={workspaceId} onChange={(_, d) => setWorkspaceId(d.value)} disabled={(workspaces?.length ?? 0) === 0}>
              {!workspaceId && <option value="">{workspaces === null ? 'Loading…' : 'Select a workspace'}</option>}
              {(workspaces || []).map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
            </Select>
          </div>
          <Button appearance="outline" icon={<ArrowSync20Regular />} onClick={() => workspaceId && void load(workspaceId)} disabled={!workspaceId}>Refresh</Button>
        </div>

        {!adlsConfigured && (
          <MessageBar intent="warning">
            <MessageBarBody>
              <MessageBarTitle>No ADLS Gen2 data lake configured</MessageBarTitle>
              Shortcuts resolve against the DLZ medallion containers. Set <code>LOOM_BRONZE_URL</code> / <code>LOOM_SILVER_URL</code> / <code>LOOM_GOLD_URL</code> so Loom can verify external paths in place.
            </MessageBarBody>
          </MessageBar>
        )}

        {msg && <MessageBar intent={msg.intent}><MessageBarBody>{msg.text}</MessageBarBody></MessageBar>}

        <Dialog open={createOpen} onOpenChange={(_, d) => { setCreateOpen(d.open); if (!d.open) { setVerifyResult(null); setCErr(null); } }}>
          <DialogTrigger disableButtonEnhancement>
            <Button appearance="primary" icon={<Add20Regular />} disabled={!workspaceId}>New shortcut</Button>
          </DialogTrigger>
          <DialogSurface style={{ maxWidth: '640px', width: '90vw' }}>
            <DialogBody>
              <DialogTitle>Create lakehouse shortcut</DialogTitle>
              <DialogContent>
                <div className={s.section}>
                  <Field label="Display name" required><Input value={cName} onChange={(_, d) => setCName(d.value)} placeholder="external-orders" /></Field>
                  <Field label="Target container" required>
                    <Select value={cContainer} onChange={(_, d) => { setCContainer(d.value); setVerifyResult(null); }}>
                      {CONTAINERS.map(c => <option key={c} value={c}>{c}</option>)}
                    </Select>
                  </Field>
                  <Field label="Target path" hint="Path under the container, e.g. external/orders/ (the external Delta/Parquet folder).">
                    <Textarea value={cPath} onChange={(_, d) => { setCPath(d.value); setVerifyResult(null); }} rows={2} className={s.mono} />
                  </Field>
                  <div>
                    <Button appearance="outline" icon={verifyBusy ? <Spinner size="tiny" /> : <CheckmarkCircle20Regular />} disabled={verifyBusy || !cContainer} onClick={verify}>{verifyBusy ? 'Verifying…' : 'Verify resolves (no copy)'}</Button>
                  </div>
                  {verifyResult && (
                    <MessageBar intent={verifyResult.resolved ? 'success' : 'warning'}>
                      <MessageBarBody>
                        <MessageBarTitle>{verifyResult.resolved ? 'Target resolves in place' : 'Could not resolve'}</MessageBarTitle>
                        {verifyResult.resolved
                          ? <>Listed <strong>{verifyResult.entryCount ?? 0}</strong> entries at <code className={s.mono}>{verifyResult.abfss}</code> via the ADLS client — no data copied.</>
                          : (verifyResult.reason || 'The target path could not be listed.')}
                      </MessageBarBody>
                    </MessageBar>
                  )}
                  {cErr && <MessageBar intent="error"><MessageBarBody>{cErr}</MessageBarBody></MessageBar>}
                </div>
              </DialogContent>
              <DialogActions>
                <Button appearance="secondary" onClick={() => setCreateOpen(false)}>Cancel</Button>
                <Button appearance="primary" disabled={cBusy || !cName.trim() || !cContainer} onClick={create}>{cBusy ? 'Creating…' : 'Create'}</Button>
              </DialogActions>
            </DialogBody>
          </DialogSurface>
        </Dialog>

        {!workspaceId && <Caption1>Select a workspace to list its lakehouse shortcuts.</Caption1>}
        {workspaceId && shortcuts === null && <Spinner size="small" label="Loading shortcuts…" labelPosition="after" />}
        {workspaceId && shortcuts && shortcuts.length === 0 && (
          <MessageBar intent="info"><MessageBarBody>No shortcuts yet. Click <strong>New shortcut</strong> to point at external Delta/Parquet without copying it.</MessageBarBody></MessageBar>
        )}
        {workspaceId && shortcuts && shortcuts.length > 0 && (
          <div className={s.tableWrap}>
            <Table aria-label="Lakehouse shortcuts" size="small">
              <TableHeader><TableRow>
                <TableHeaderCell>Name</TableHeaderCell><TableHeaderCell>Target (abfss)</TableHeaderCell>
                <TableHeaderCell>Entries</TableHeaderCell><TableHeaderCell>Last verified</TableHeaderCell>
                <TableHeaderCell>Actions</TableHeaderCell>
              </TableRow></TableHeader>
              <TableBody>
                {shortcuts.map((sc) => (
                  <TableRow key={sc.id}>
                    <TableCell className={s.mono}>{sc.displayName}</TableCell>
                    <TableCell className={s.mono}>{sc.abfss || `${sc.container}/${sc.path || ''}`}</TableCell>
                    <TableCell>{sc.entryCount ?? '—'}</TableCell>
                    <TableCell>{sc.lastVerifiedAt?.replace('T', ' ').replace(/\..*/, '') || '—'}</TableCell>
                    <TableCell><Button size="small" appearance="subtle" icon={<Delete20Regular />} onClick={() => del(sc.id)}>Delete</Button></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    } />
  );
}
