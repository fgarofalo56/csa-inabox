'use client';

/**
 * ServiceBusNamespaceEditor — navigator over the deployment-pinned Azure Service
 * Bus namespace (Microsoft.ServiceBus/namespaces). Real ARM via
 * /api/items/service-bus-namespace (reusing the thin servicebus-client). Lists
 * namespace properties + queues + topics, creates/deletes both. Honest 503 gate
 * when the namespace env vars are unset. Azure-native — no Fabric.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Caption1, Body1, Badge, Button, Spinner, Input, Field, Checkbox,
  Tab, TabList,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Add20Regular, ArrowSync20Regular, Delete20Regular, Mailbox20Regular,
} from '@fluentui/react-icons';
import { ItemEditorChrome } from './item-editor-chrome';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';

const useStyles = makeStyles({
  pad: { padding: tokens.spacingVerticalL, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, flex: 1, minHeight: 0, minWidth: 0, overflowY: 'auto' },
  tabs: { borderBottom: `1px solid ${tokens.colorNeutralStroke2}`, padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalS} 0` },
  toolbar: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap' },
  grid: { display: 'grid', gridTemplateColumns: 'max-content minmax(0, 1fr)', gap: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalL}`, alignItems: 'center', maxWidth: '720px' },
  mono: { fontFamily: tokens.fontFamilyMonospace, fontSize: tokens.fontSizeBase200, overflowWrap: 'anywhere', wordBreak: 'break-word', minWidth: 0 },
  tableWrap: { overflow: 'auto', border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium },
});

interface NamespaceProps { name?: string; location?: string; sku?: string; tier?: string; status?: string; provisioningState?: string; endpoint?: string; disableLocalAuth?: boolean; minimumTlsVersion?: string }
interface QueueEntity { name: string; status?: string; maxSizeInMegabytes?: number; messageCount?: number; requiresSession?: boolean }
interface TopicEntity { name: string; status?: string; maxSizeInMegabytes?: number; subscriptionCount?: number }
interface Props { item: FabricItemType; id: string }

export function ServiceBusNamespaceEditor({ item, id }: Props) {
  const s = useStyles();
  const [tab, setTab] = useState('queues');
  const [loading, setLoading] = useState(true);
  const [gate, setGate] = useState<{ error: string; hint?: string } | null>(null);
  const [ns, setNs] = useState<NamespaceProps | null>(null);
  const [queues, setQueues] = useState<QueueEntity[]>([]);
  const [topics, setTopics] = useState<TopicEntity[]>([]);
  const [msg, setMsg] = useState<{ intent: 'success' | 'error'; text: string } | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [kind, setKind] = useState<'queue' | 'topic'>('queue');
  const [cName, setCName] = useState('');
  const [cSize, setCSize] = useState('1024');
  const [cSession, setCSession] = useState(false);
  const [cBusy, setCBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setGate(null);
    try {
      const r = await fetch('/api/items/service-bus-namespace');
      const j = await r.json();
      if (!j.ok) { setGate({ error: j.error || 'not available', hint: j.hint }); setNs(null); setQueues([]); setTopics([]); return; }
      setNs(j.namespace || null);
      setQueues(Array.isArray(j.queues) ? j.queues : []);
      setTopics(Array.isArray(j.topics) ? j.topics : []);
    } catch (e: any) { setGate({ error: e?.message || String(e) }); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const openCreate = useCallback((k: 'queue' | 'topic') => { setKind(k); setCName(''); setCSession(false); setCreateOpen(true); }, []);

  const create = useCallback(async () => {
    if (!cName.trim()) return;
    setCBusy(true); setMsg(null);
    try {
      const r = await fetch('/api/items/service-bus-namespace', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: kind === 'queue' ? 'create-queue' : 'create-topic', name: cName.trim(), maxSizeInMegabytes: Number(cSize) || 1024, requiresSession: cSession }),
      });
      const j = await r.json();
      if (!j.ok) { setMsg({ intent: 'error', text: j.error || 'create failed' }); return; }
      setMsg({ intent: 'success', text: `Created ${kind} "${cName.trim()}".` });
      setCreateOpen(false);
      await load();
    } finally { setCBusy(false); }
  }, [kind, cName, cSize, cSession, load]);

  const del = useCallback(async (k: 'queue' | 'topic', name: string) => {
    setMsg(null);
    try {
      const r = await fetch(`/api/items/service-bus-namespace?${k}=${encodeURIComponent(name)}`, { method: 'DELETE' });
      const j = await r.json();
      if (!j.ok) { setMsg({ intent: 'error', text: j.error || 'delete failed' }); return; }
      setMsg({ intent: 'success', text: `Deleted ${k} "${name}".` });
      await load();
    } catch (e: any) { setMsg({ intent: 'error', text: e?.message || String(e) }); }
  }, [load]);

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Namespace', actions: [{ label: 'Refresh', onClick: () => void load() }] },
      { label: 'Entities', actions: [
        { label: 'New queue', onClick: gate ? undefined : () => openCreate('queue'), disabled: !!gate },
        { label: 'New topic', onClick: gate ? undefined : () => openCreate('topic'), disabled: !!gate },
      ]},
      { label: 'View', actions: [
        { label: 'Queues', onClick: () => setTab('queues') },
        { label: 'Topics', onClick: () => setTab('topics') },
        { label: 'Overview', onClick: () => setTab('overview') },
      ]},
    ]},
  ], [gate, load, openCreate]);

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon} main={
      <>
        <div className={s.tabs}>
          <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as string)}>
            <Tab value="queues">Queues</Tab>
            <Tab value="topics">Topics</Tab>
            <Tab value="overview">Overview</Tab>
          </TabList>
        </div>
        <div className={s.pad}>
          <div className={s.toolbar}>
            <Badge appearance="filled" color="brand" icon={<Mailbox20Regular />}>Service Bus namespace</Badge>
            {ns?.name && <Caption1 className={s.mono}>{ns.name}{ns.location ? ` · ${ns.location}` : ''}{ns.sku ? ` · ${ns.sku}` : ''}</Caption1>}
            <Button appearance="outline" icon={<ArrowSync20Regular />} onClick={() => void load()}>Refresh</Button>
          </div>

          {loading && <Spinner size="small" label="Loading namespace…" labelPosition="after" />}

          {gate && (
            <MessageBar intent="warning">
              <MessageBarBody>
                <MessageBarTitle>Service Bus namespace not configured</MessageBarTitle>
                {gate.error}{gate.hint ? ` ${gate.hint}` : ''}
              </MessageBarBody>
            </MessageBar>
          )}

          {msg && <MessageBar intent={msg.intent}><MessageBarBody>{msg.text}</MessageBarBody></MessageBar>}

          <Dialog open={createOpen} onOpenChange={(_, d) => setCreateOpen(d.open)}>
            <DialogSurface>
              <DialogBody>
                <DialogTitle>Create {kind}</DialogTitle>
                <DialogContent>
                  <Field label="Name" required><Input value={cName} onChange={(_, d) => setCName(d.value)} placeholder={kind === 'queue' ? 'orders-queue' : 'orders-topic'} /></Field>
                  <Field label="Max size (MB)"><Input type="number" value={cSize} onChange={(_, d) => setCSize(d.value)} /></Field>
                  {kind === 'queue' && <Checkbox label="Requires session (ordered FIFO)" checked={cSession} onChange={(_, d) => setCSession(!!d.checked)} />}
                </DialogContent>
                <DialogActions>
                  <Button appearance="secondary" onClick={() => setCreateOpen(false)}>Cancel</Button>
                  <Button appearance="primary" disabled={cBusy || !cName.trim()} onClick={create}>{cBusy ? 'Creating…' : 'Create'}</Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>

          {!loading && !gate && tab === 'queues' && (
            <>
              <div className={s.toolbar}><Button appearance="primary" icon={<Add20Regular />} onClick={() => openCreate('queue')}>New queue</Button></div>
              {queues.length === 0 ? (
                <MessageBar intent="info"><MessageBarBody>No queues yet. Click <strong>New queue</strong> for point-to-point messaging.</MessageBarBody></MessageBar>
              ) : (
                <div className={s.tableWrap}>
                  <Table aria-label="Queues" size="small">
                    <TableHeader><TableRow>
                      <TableHeaderCell>Queue</TableHeaderCell><TableHeaderCell>Max size (MB)</TableHeaderCell>
                      <TableHeaderCell>Messages</TableHeaderCell><TableHeaderCell>Session</TableHeaderCell>
                      <TableHeaderCell>Status</TableHeaderCell><TableHeaderCell>Actions</TableHeaderCell>
                    </TableRow></TableHeader>
                    <TableBody>
                      {queues.map((q) => (
                        <TableRow key={q.name}>
                          <TableCell className={s.mono}>{q.name}</TableCell>
                          <TableCell>{q.maxSizeInMegabytes ?? '—'}</TableCell>
                          <TableCell>{q.messageCount ?? '—'}</TableCell>
                          <TableCell>{q.requiresSession ? 'yes' : 'no'}</TableCell>
                          <TableCell><Badge appearance="tint" color={q.status === 'Active' ? 'success' : 'informative'}>{q.status || '—'}</Badge></TableCell>
                          <TableCell><Button size="small" appearance="subtle" icon={<Delete20Regular />} onClick={() => del('queue', q.name)}>Delete</Button></TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </>
          )}

          {!loading && !gate && tab === 'topics' && (
            <>
              <div className={s.toolbar}><Button appearance="primary" icon={<Add20Regular />} onClick={() => openCreate('topic')}>New topic</Button></div>
              {topics.length === 0 ? (
                <MessageBar intent="info"><MessageBarBody>No topics yet. Click <strong>New topic</strong> for publish-subscribe fan-out.</MessageBarBody></MessageBar>
              ) : (
                <div className={s.tableWrap}>
                  <Table aria-label="Topics" size="small">
                    <TableHeader><TableRow>
                      <TableHeaderCell>Topic</TableHeaderCell><TableHeaderCell>Max size (MB)</TableHeaderCell>
                      <TableHeaderCell>Subscriptions</TableHeaderCell><TableHeaderCell>Status</TableHeaderCell>
                      <TableHeaderCell>Actions</TableHeaderCell>
                    </TableRow></TableHeader>
                    <TableBody>
                      {topics.map((t) => (
                        <TableRow key={t.name}>
                          <TableCell className={s.mono}>{t.name}</TableCell>
                          <TableCell>{t.maxSizeInMegabytes ?? '—'}</TableCell>
                          <TableCell>{t.subscriptionCount ?? 0}</TableCell>
                          <TableCell><Badge appearance="tint" color={t.status === 'Active' ? 'success' : 'informative'}>{t.status || '—'}</Badge></TableCell>
                          <TableCell><Button size="small" appearance="subtle" icon={<Delete20Regular />} onClick={() => del('topic', t.name)}>Delete</Button></TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </>
          )}

          {!loading && !gate && tab === 'overview' && ns && (
            <div className={s.grid}>
              <Caption1>Namespace</Caption1><code className={s.mono}>{ns.name}</code>
              <Caption1>Location</Caption1><code className={s.mono}>{ns.location || '—'}</code>
              <Caption1>SKU / tier</Caption1><code className={s.mono}>{ns.sku || '—'}{ns.tier ? ` (${ns.tier})` : ''}</code>
              <Caption1>Endpoint</Caption1><code className={s.mono}>{ns.endpoint || '—'}</code>
              <Caption1>Provisioning</Caption1><code className={s.mono}>{ns.provisioningState || ns.status || '—'}</code>
              <Caption1>Local auth</Caption1><code className={s.mono}>{ns.disableLocalAuth ? 'disabled (Entra-only)' : 'enabled'}</code>
            </div>
          )}
          {!loading && !gate && tab === 'overview' && !ns && <Body1>Namespace properties unavailable.</Body1>}
        </div>
      </>
    } />
  );
}
