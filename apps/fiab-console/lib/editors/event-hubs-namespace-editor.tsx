'use client';

/**
 * EventHubsNamespaceEditor — navigator over the deployment-pinned Azure Event
 * Hubs namespace (Microsoft.EventHub/namespaces). Real ARM via
 * /api/items/event-hubs-namespace (reusing eventhubs-client). Lists namespace
 * properties + event hubs, creates/deletes hubs and consumer groups. Honest
 * 503 gate when the namespace env vars are unset. Azure-native — no Fabric.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Subtitle2, Caption1, Body1, Badge, Button, Spinner, Input, Field,
  Tab, TabList,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  Dialog, DialogTrigger, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Add20Regular, ArrowSync20Regular, Delete20Regular, Stream20Regular,
} from '@fluentui/react-icons';
import { ItemEditorChrome } from './item-editor-chrome';
import { MessagingMetricsTab } from '@/lib/components/messaging/metrics-tab';
import { EventHubsDataExplorer } from '@/lib/components/messaging/event-hubs-data-explorer';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';

const useStyles = makeStyles({
  pad: { padding: tokens.spacingVerticalL, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, flex: 1, minHeight: 0, minWidth: 0, overflowY: 'auto' },
  tabs: { borderBottom: `1px solid ${tokens.colorNeutralStroke2}`, padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalS} 0` },
  toolbar: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap' },
  grid: { display: 'grid', gridTemplateColumns: 'max-content minmax(0, 1fr)', gap: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalL}`, alignItems: 'center', maxWidth: '720px' },
  mono: { fontFamily: tokens.fontFamilyMonospace, fontSize: tokens.fontSizeBase200, overflowWrap: 'anywhere', wordBreak: 'break-word', minWidth: 0 },
  tableWrap: { overflow: 'auto', border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium },
  field: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS },
});

interface NamespaceProps { name?: string; location?: string; sku?: string; status?: string; provisioningState?: string; minimumTlsVersion?: string; disableLocalAuth?: boolean; serviceBusEndpoint?: string }
interface HubEntity { name: string; partitionCount?: number; messageRetentionInDays?: number; status?: string }
interface ConsumerGroup { name: string; eventHub?: string; userMetadata?: string; createdAt?: string }
interface Props { item: FabricItemType; id: string }

export function EventHubsNamespaceEditor({ item, id }: Props) {
  const s = useStyles();
  const [tab, setTab] = useState('hubs');
  const [loading, setLoading] = useState(true);
  const [gate, setGate] = useState<{ error: string; hint?: string; missing?: string } | null>(null);
  const [ns, setNs] = useState<NamespaceProps | null>(null);
  const [hubs, setHubs] = useState<HubEntity[]>([]);
  const [msg, setMsg] = useState<{ intent: 'success' | 'error'; text: string } | null>(null);

  // Create-hub dialog
  const [createOpen, setCreateOpen] = useState(false);
  const [cName, setCName] = useState('');
  const [cParts, setCParts] = useState('4');
  const [cRetention, setCRetention] = useState('1');
  const [cBusy, setCBusy] = useState(false);

  // Consumer-group drill-in
  const [cgHub, setCgHub] = useState<string | null>(null);
  const [cgs, setCgs] = useState<ConsumerGroup[] | null>(null);
  const [cgName, setCgName] = useState('');
  const [cgBusy, setCgBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setGate(null);
    try {
      const r = await fetch('/api/items/event-hubs-namespace');
      const j = await r.json();
      if (!j.ok) { setGate({ error: j.error || 'not available', hint: j.hint, missing: j.missing }); setNs(null); setHubs([]); return; }
      setNs(j.namespace || null);
      setHubs(Array.isArray(j.hubs) ? j.hubs : []);
    } catch (e: any) { setGate({ error: e?.message || String(e) }); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const loadCgs = useCallback(async (hub: string) => {
    setCgHub(hub); setCgs(null);
    try {
      const r = await fetch(`/api/items/event-hubs-namespace?hub=${encodeURIComponent(hub)}&consumerGroups=1`);
      const j = await r.json();
      setCgs(j.ok ? (j.consumerGroups || []) : []);
    } catch { setCgs([]); }
  }, []);

  const createHub = useCallback(async () => {
    if (!cName.trim()) return;
    setCBusy(true); setMsg(null);
    try {
      const r = await fetch('/api/items/event-hubs-namespace', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'create-hub', name: cName.trim(), partitionCount: Number(cParts) || 4, messageRetentionInDays: Number(cRetention) || 1 }),
      });
      const j = await r.json();
      if (!j.ok) { setMsg({ intent: 'error', text: j.error || 'create failed' }); return; }
      setMsg({ intent: 'success', text: `Created event hub "${cName.trim()}".` });
      setCreateOpen(false); setCName('');
      await load();
    } finally { setCBusy(false); }
  }, [cName, cParts, cRetention, load]);

  const deleteHub = useCallback(async (name: string) => {
    setMsg(null);
    try {
      const r = await fetch(`/api/items/event-hubs-namespace?hub=${encodeURIComponent(name)}`, { method: 'DELETE' });
      const j = await r.json();
      if (!j.ok) { setMsg({ intent: 'error', text: j.error || 'delete failed' }); return; }
      setMsg({ intent: 'success', text: `Deleted "${name}".` });
      if (cgHub === name) { setCgHub(null); setCgs(null); }
      await load();
    } catch (e: any) { setMsg({ intent: 'error', text: e?.message || String(e) }); }
  }, [load, cgHub]);

  const createCg = useCallback(async () => {
    if (!cgHub || !cgName.trim()) return;
    setCgBusy(true); setMsg(null);
    try {
      const r = await fetch('/api/items/event-hubs-namespace', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'create-consumer-group', hub: cgHub, name: cgName.trim() }),
      });
      const j = await r.json();
      if (!j.ok) { setMsg({ intent: 'error', text: j.error || 'create failed' }); return; }
      setCgName('');
      await loadCgs(cgHub);
    } finally { setCgBusy(false); }
  }, [cgHub, cgName, loadCgs]);

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Namespace', actions: [{ label: 'Refresh', onClick: () => void load() }] },
      { label: 'Event hubs', actions: [{ label: 'New event hub', onClick: gate ? undefined : () => setCreateOpen(true), disabled: !!gate }] },
      { label: 'View', actions: [
        { label: 'Event hubs', onClick: () => setTab('hubs') },
        { label: 'Metrics', onClick: () => setTab('metrics') },
        { label: 'Data Explorer', onClick: () => setTab('explorer') },
        { label: 'Overview', onClick: () => setTab('overview') },
      ]},
    ]},
  ], [gate, load]);

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon} main={
      <>
        <div className={s.tabs}>
          <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as string)}>
            <Tab value="hubs">Event hubs</Tab>
            <Tab value="metrics">Metrics</Tab>
            <Tab value="explorer">Data Explorer</Tab>
            <Tab value="overview">Overview</Tab>
          </TabList>
        </div>
        <div className={s.pad}>
          <div className={s.toolbar}>
            <Badge appearance="filled" color="brand" icon={<Stream20Regular />}>Event Hubs namespace</Badge>
            {ns?.name && <Caption1 className={s.mono}>{ns.name}{ns.location ? ` · ${ns.location}` : ''}{ns.sku ? ` · ${ns.sku}` : ''}</Caption1>}
            <Button appearance="outline" icon={<ArrowSync20Regular />} onClick={() => void load()}>Refresh</Button>
          </div>

          {loading && <Spinner size="small" label="Loading namespace…" labelPosition="after" />}

          {gate && (
            <MessageBar intent="warning">
              <MessageBarBody>
                <MessageBarTitle>Event Hubs namespace not configured</MessageBarTitle>
                {gate.error}{gate.hint ? ` ${gate.hint}` : ''}
              </MessageBarBody>
            </MessageBar>
          )}

          {msg && <MessageBar intent={msg.intent}><MessageBarBody>{msg.text}</MessageBarBody></MessageBar>}

          {!loading && !gate && tab === 'hubs' && (
            <>
              <div className={s.toolbar}>
                <Dialog open={createOpen} onOpenChange={(_, d) => setCreateOpen(d.open)}>
                  <DialogTrigger disableButtonEnhancement>
                    <Button appearance="primary" icon={<Add20Regular />}>New event hub</Button>
                  </DialogTrigger>
                  <DialogSurface>
                    <DialogBody>
                      <DialogTitle>Create event hub</DialogTitle>
                      <DialogContent>
                        <Field label="Name" required><Input value={cName} onChange={(_, d) => setCName(d.value)} placeholder="orders" /></Field>
                        <Field label="Partition count"><Input type="number" value={cParts} onChange={(_, d) => setCParts(d.value)} /></Field>
                        <Field label="Retention (days)"><Input type="number" value={cRetention} onChange={(_, d) => setCRetention(d.value)} /></Field>
                      </DialogContent>
                      <DialogActions>
                        <Button appearance="secondary" onClick={() => setCreateOpen(false)}>Cancel</Button>
                        <Button appearance="primary" disabled={cBusy || !cName.trim()} onClick={createHub}>{cBusy ? 'Creating…' : 'Create'}</Button>
                      </DialogActions>
                    </DialogBody>
                  </DialogSurface>
                </Dialog>
              </div>
              {hubs.length === 0 ? (
                <MessageBar intent="info"><MessageBarBody>No event hubs yet. Click <strong>New event hub</strong> to create the first one.</MessageBarBody></MessageBar>
              ) : (
                <div className={s.tableWrap}>
                  <Table aria-label="Event hubs" size="small">
                    <TableHeader><TableRow>
                      <TableHeaderCell>Event hub</TableHeaderCell>
                      <TableHeaderCell>Partitions</TableHeaderCell>
                      <TableHeaderCell>Retention (d)</TableHeaderCell>
                      <TableHeaderCell>Status</TableHeaderCell>
                      <TableHeaderCell>Actions</TableHeaderCell>
                    </TableRow></TableHeader>
                    <TableBody>
                      {hubs.map((h) => (
                        <TableRow key={h.name}>
                          <TableCell className={s.mono}>{h.name}</TableCell>
                          <TableCell>{h.partitionCount ?? '—'}</TableCell>
                          <TableCell>{h.messageRetentionInDays ?? '—'}</TableCell>
                          <TableCell><Badge appearance="tint" color={h.status === 'Active' ? 'success' : 'informative'}>{h.status || '—'}</Badge></TableCell>
                          <TableCell>
                            <Button size="small" appearance="subtle" onClick={() => loadCgs(h.name)}>Consumer groups</Button>
                            <Button size="small" appearance="subtle" icon={<Delete20Regular />} onClick={() => deleteHub(h.name)}>Delete</Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}

              {cgHub && (
                <div className={s.field}>
                  <Subtitle2>Consumer groups · {cgHub}</Subtitle2>
                  <div className={s.toolbar}>
                    <Input value={cgName} onChange={(_, d) => setCgName(d.value)} placeholder="group name" />
                    <Button appearance="outline" icon={<Add20Regular />} disabled={cgBusy || !cgName.trim()} onClick={createCg}>{cgBusy ? 'Adding…' : 'Add group'}</Button>
                  </div>
                  {cgs === null ? <Spinner size="tiny" label="Loading…" /> : cgs.length === 0 ? <Caption1>Only the built-in $Default group exists.</Caption1> : (
                    <div className={s.tableWrap}>
                      <Table aria-label="Consumer groups" size="small">
                        <TableHeader><TableRow><TableHeaderCell>Consumer group</TableHeaderCell><TableHeaderCell>Created</TableHeaderCell></TableRow></TableHeader>
                        <TableBody>
                          {cgs.map((c) => <TableRow key={c.name}><TableCell className={s.mono}>{c.name}</TableCell><TableCell>{c.createdAt || '—'}</TableCell></TableRow>)}
                        </TableBody>
                      </Table>
                    </div>
                  )}
                </div>
              )}
            </>
          )}

          {!loading && !gate && tab === 'overview' && ns && (
            <div className={s.grid}>
              <Caption1>Namespace</Caption1><code className={s.mono}>{ns.name}</code>
              <Caption1>Location</Caption1><code className={s.mono}>{ns.location || '—'}</code>
              <Caption1>SKU</Caption1><code className={s.mono}>{ns.sku || '—'}</code>
              <Caption1>Provisioning</Caption1><code className={s.mono}>{ns.provisioningState || ns.status || '—'}</code>
              <Caption1>Minimum TLS</Caption1><code className={s.mono}>{ns.minimumTlsVersion || '—'}</code>
              <Caption1>Local auth</Caption1><code className={s.mono}>{ns.disableLocalAuth ? 'disabled (Entra-only)' : 'enabled'}</code>
            </div>
          )}
          {!loading && !gate && tab === 'overview' && !ns && <Body1>Namespace properties unavailable.</Body1>}

          {!loading && !gate && tab === 'metrics' && <MessagingMetricsTab kind="event-hubs" scopeLabel={ns?.name} />}

          {!loading && !gate && tab === 'explorer' && <EventHubsDataExplorer hubs={hubs} />}
        </div>
      </>
    } />
  );
}
