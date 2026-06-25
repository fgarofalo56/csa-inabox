'use client';

/**
 * EventGridTopicEditor — navigator over the deployment-pinned Azure Event Grid
 * custom topics (Microsoft.EventGrid/topics). Real ARM via
 * /api/items/event-grid-topic (reusing eventgrid-topics-client). Lists topics,
 * shows a topic's endpoint + access keys + event subscriptions, and creates /
 * deletes custom topics (CloudEvents v1.0 schema). Honest 503 gate when the
 * Event Grid env vars are unset. Azure-native — no Fabric.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Subtitle2, Caption1, Badge, Button, Spinner, Input, Field,
  Tab, TabList,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  Dialog, DialogTrigger, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Add20Regular, ArrowSync20Regular, Delete20Regular, Flash20Regular,
} from '@fluentui/react-icons';
import { ItemEditorChrome } from './item-editor-chrome';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';

const useStyles = makeStyles({
  pad: { padding: tokens.spacingVerticalL, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, flex: 1, minHeight: 0, minWidth: 0, overflowY: 'auto' },
  tabs: { borderBottom: `1px solid ${tokens.colorNeutralStroke2}`, padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalS} 0` },
  toolbar: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap' },
  grid: { display: 'grid', gridTemplateColumns: 'max-content minmax(0, 1fr)', gap: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalL}`, alignItems: 'center', maxWidth: '760px' },
  mono: { fontFamily: tokens.fontFamilyMonospace, fontSize: tokens.fontSizeBase200, overflowWrap: 'anywhere', wordBreak: 'break-word', minWidth: 0 },
  tableWrap: { overflow: 'auto', border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium },
  section: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
});

interface TopicSummary { name: string; endpoint?: string; provisioningState?: string; inputSchema?: string; location?: string }
interface Subscription { name: string; destination?: string; provisioningState?: string }
interface Props { item: FabricItemType; id: string }

export function EventGridTopicEditor({ item, id }: Props) {
  const s = useStyles();
  const [tab, setTab] = useState('topics');
  const [loading, setLoading] = useState(true);
  const [gate, setGate] = useState<{ error: string; hint?: string } | null>(null);
  const [topics, setTopics] = useState<TopicSummary[]>([]);
  const [msg, setMsg] = useState<{ intent: 'success' | 'error'; text: string } | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [cName, setCName] = useState('');
  const [cBusy, setCBusy] = useState(false);

  // Detail drill-in
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ topic: any; subscriptions: Subscription[]; keys: any } | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setGate(null);
    try {
      const r = await fetch('/api/items/event-grid-topic');
      const j = await r.json();
      if (!j.ok) { setGate({ error: j.error || 'not available', hint: j.hint }); setTopics([]); return; }
      setTopics(Array.isArray(j.topics) ? j.topics : []);
    } catch (e: any) { setGate({ error: e?.message || String(e) }); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const loadDetail = useCallback(async (name: string) => {
    setSelected(name); setDetail(null); setDetailLoading(true); setTab('detail');
    try {
      const r = await fetch(`/api/items/event-grid-topic?topic=${encodeURIComponent(name)}&detail=1`);
      const j = await r.json();
      if (j.ok) setDetail({ topic: j.topic, subscriptions: j.subscriptions || [], keys: j.keys });
    } finally { setDetailLoading(false); }
  }, []);

  const create = useCallback(async () => {
    if (!cName.trim()) return;
    setCBusy(true); setMsg(null);
    try {
      const r = await fetch('/api/items/event-grid-topic', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: cName.trim(), inputSchema: 'CloudEventSchemaV1_0' }),
      });
      const j = await r.json();
      if (!j.ok) { setMsg({ intent: 'error', text: j.error || 'create failed' }); return; }
      setMsg({ intent: 'success', text: `Created topic "${cName.trim()}".` });
      setCreateOpen(false); setCName('');
      await load();
    } finally { setCBusy(false); }
  }, [cName, load]);

  const del = useCallback(async (name: string) => {
    setMsg(null);
    try {
      const r = await fetch(`/api/items/event-grid-topic?name=${encodeURIComponent(name)}`, { method: 'DELETE' });
      const j = await r.json();
      if (!j.ok) { setMsg({ intent: 'error', text: j.error || 'delete failed' }); return; }
      setMsg({ intent: 'success', text: `Deleted "${name}".` });
      if (selected === name) { setSelected(null); setDetail(null); setTab('topics'); }
      await load();
    } catch (e: any) { setMsg({ intent: 'error', text: e?.message || String(e) }); }
  }, [load, selected]);

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Topics', actions: [
        { label: 'New topic', onClick: gate ? undefined : () => setCreateOpen(true), disabled: !!gate },
        { label: 'Refresh', onClick: () => void load() },
      ]},
      { label: 'View', actions: [
        { label: 'Topics', onClick: () => setTab('topics') },
        { label: 'Detail', onClick: () => setTab('detail'), disabled: !selected },
      ]},
    ]},
  ], [gate, load, selected]);

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon} main={
      <>
        <div className={s.tabs}>
          <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as string)}>
            <Tab value="topics">Topics</Tab>
            <Tab value="detail" disabled={!selected}>Detail</Tab>
          </TabList>
        </div>
        <div className={s.pad}>
          <div className={s.toolbar}>
            <Badge appearance="filled" color="brand" icon={<Flash20Regular />}>Event Grid topics</Badge>
            <Button appearance="outline" icon={<ArrowSync20Regular />} onClick={() => void load()}>Refresh</Button>
          </div>

          {loading && <Spinner size="small" label="Loading topics…" labelPosition="after" />}

          {gate && (
            <MessageBar intent="warning">
              <MessageBarBody>
                <MessageBarTitle>Event Grid not configured</MessageBarTitle>
                {gate.error}{gate.hint ? ` ${gate.hint}` : ''}
              </MessageBarBody>
            </MessageBar>
          )}

          {msg && <MessageBar intent={msg.intent}><MessageBarBody>{msg.text}</MessageBarBody></MessageBar>}

          {!loading && !gate && tab === 'topics' && (
            <>
              <div className={s.toolbar}>
                <Dialog open={createOpen} onOpenChange={(_, d) => setCreateOpen(d.open)}>
                  <DialogTrigger disableButtonEnhancement>
                    <Button appearance="primary" icon={<Add20Regular />}>New topic</Button>
                  </DialogTrigger>
                  <DialogSurface>
                    <DialogBody>
                      <DialogTitle>Create custom topic</DialogTitle>
                      <DialogContent>
                        <Field label="Name" required hint="Created with the CloudEvents v1.0 input schema."><Input value={cName} onChange={(_, d) => setCName(d.value)} placeholder="orders-events" /></Field>
                      </DialogContent>
                      <DialogActions>
                        <Button appearance="secondary" onClick={() => setCreateOpen(false)}>Cancel</Button>
                        <Button appearance="primary" disabled={cBusy || !cName.trim()} onClick={create}>{cBusy ? 'Creating…' : 'Create'}</Button>
                      </DialogActions>
                    </DialogBody>
                  </DialogSurface>
                </Dialog>
              </div>
              {topics.length === 0 ? (
                <MessageBar intent="info"><MessageBarBody>No custom topics yet. Click <strong>New topic</strong> to create one.</MessageBarBody></MessageBar>
              ) : (
                <div className={s.tableWrap}>
                  <Table aria-label="Event Grid topics" size="small">
                    <TableHeader><TableRow>
                      <TableHeaderCell>Topic</TableHeaderCell><TableHeaderCell>Schema</TableHeaderCell>
                      <TableHeaderCell>Location</TableHeaderCell><TableHeaderCell>State</TableHeaderCell>
                      <TableHeaderCell>Actions</TableHeaderCell>
                    </TableRow></TableHeader>
                    <TableBody>
                      {topics.map((t) => (
                        <TableRow key={t.name}>
                          <TableCell className={s.mono}>{t.name}</TableCell>
                          <TableCell>{t.inputSchema || 'CloudEventSchemaV1_0'}</TableCell>
                          <TableCell>{t.location || '—'}</TableCell>
                          <TableCell><Badge appearance="tint" color={t.provisioningState === 'Succeeded' ? 'success' : 'informative'}>{t.provisioningState || '—'}</Badge></TableCell>
                          <TableCell>
                            <Button size="small" appearance="subtle" onClick={() => loadDetail(t.name)}>Open</Button>
                            <Button size="small" appearance="subtle" icon={<Delete20Regular />} onClick={() => del(t.name)}>Delete</Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </>
          )}

          {!loading && !gate && tab === 'detail' && (
            <>
              {!selected && <Caption1>Select a topic on the Topics tab.</Caption1>}
              {detailLoading && <Spinner size="small" label="Loading topic…" labelPosition="after" />}
              {selected && detail && (
                <div className={s.section}>
                  <Subtitle2>{selected}</Subtitle2>
                  <div className={s.grid}>
                    <Caption1>Endpoint</Caption1><code className={s.mono}>{detail.topic?.endpoint || '—'}</code>
                    <Caption1>Input schema</Caption1><code className={s.mono}>{detail.topic?.inputSchema || 'CloudEventSchemaV1_0'}</code>
                    <Caption1>Access key 1</Caption1><code className={s.mono}>{detail.keys?.key1 ? `${String(detail.keys.key1).slice(0, 6)}… (hidden)` : '—'}</code>
                  </div>
                  <Subtitle2>Event subscriptions</Subtitle2>
                  {detail.subscriptions.length === 0 ? (
                    <MessageBar intent="info"><MessageBarBody>No event subscriptions on this topic yet. Add one to route events to a handler (Function, webhook, Event Hubs, Service Bus).</MessageBarBody></MessageBar>
                  ) : (
                    <div className={s.tableWrap}>
                      <Table aria-label="Subscriptions" size="small">
                        <TableHeader><TableRow><TableHeaderCell>Subscription</TableHeaderCell><TableHeaderCell>Destination</TableHeaderCell><TableHeaderCell>State</TableHeaderCell></TableRow></TableHeader>
                        <TableBody>
                          {detail.subscriptions.map((sub) => (
                            <TableRow key={sub.name}>
                              <TableCell className={s.mono}>{sub.name}</TableCell>
                              <TableCell>{sub.destination || '—'}</TableCell>
                              <TableCell>{sub.provisioningState || '—'}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </>
    } />
  );
}
