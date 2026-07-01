'use client';

/**
 * EventGridTopicEditor — navigator over the deployment-pinned Azure Event Grid
 * custom topics (Microsoft.EventGrid/topics). Real ARM via
 * /api/items/event-grid-topic (reusing eventgrid-topics-client). Lists topics,
 * shows a topic's endpoint + access keys + event subscriptions, creates /
 * deletes custom topics (CloudEvents v1.0 schema), CREATES event subscriptions
 * (destination picker + subject/event-type/advanced filters + dead-letter +
 * retry policy) and regenerates access keys. Honest 503 gate when the Event
 * Grid env vars are unset. Azure-native — no Fabric.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Subtitle2, Caption1, Body1, Badge, Button, Spinner, Input, Field, Divider,
  Dropdown, Option, Checkbox,
  Tab, TabList,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  Dialog, DialogTrigger, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Add20Regular, ArrowSync20Regular, Delete20Regular, Flash20Regular,
  KeyReset20Regular, Dismiss16Regular,
} from '@fluentui/react-icons';
import { ItemEditorChrome } from './item-editor-chrome';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';

const useStyles = makeStyles({
  pad: { padding: tokens.spacingVerticalL, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, flex: 1, minHeight: 0, minWidth: 0, overflowY: 'auto' },
  tabs: { borderBottom: `1px solid ${tokens.colorNeutralStroke2}`, padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalS} 0` },
  toolbar: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap' },
  grid: { display: 'grid', gridTemplateColumns: 'max-content minmax(0, 1fr)', gap: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalL}`, alignItems: 'center', maxWidth: '760px' },
  keyRow: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', minWidth: 0 },
  mono: { fontFamily: tokens.fontFamilyMonospace, fontSize: tokens.fontSizeBase200, overflowWrap: 'anywhere', wordBreak: 'break-word', minWidth: 0 },
  tableWrap: { overflow: 'auto', border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium },
  section: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  dialogWide: { maxWidth: '640px', width: '640px' },
  dialogScroll: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, maxHeight: '68vh', overflowY: 'auto', paddingRight: tokens.spacingHorizontalXS },
  formCol: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  two: { display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: tokens.spacingHorizontalM },
  advRow: { display: 'grid', gridTemplateColumns: 'minmax(0,1.2fr) minmax(0,1fr) minmax(0,1.4fr) max-content', gap: tokens.spacingHorizontalS, alignItems: 'end' },
  sectionHead: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS, marginTop: tokens.spacingVerticalXS },
});

const DESTINATIONS: { key: DestType; label: string; needs: 'resourceId' | 'endpointUrl' | 'storageQueue'; hint: string }[] = [
  { key: 'AzureFunction', label: 'Azure Function', needs: 'resourceId', hint: 'Function resource ID: …/sites/{app}/functions/{fn}' },
  { key: 'WebHook', label: 'Web Hook', needs: 'endpointUrl', hint: 'HTTPS endpoint URL (Event Grid performs a validation handshake)' },
  { key: 'EventHub', label: 'Event Hub', needs: 'resourceId', hint: 'Event Hub resource ID: …/namespaces/{ns}/eventhubs/{hub}' },
  { key: 'ServiceBusQueue', label: 'Service Bus queue', needs: 'resourceId', hint: 'Queue resource ID: …/namespaces/{ns}/queues/{q}' },
  { key: 'ServiceBusTopic', label: 'Service Bus topic', needs: 'resourceId', hint: 'Topic resource ID: …/namespaces/{ns}/topics/{t}' },
  { key: 'StorageQueue', label: 'Storage queue', needs: 'storageQueue', hint: 'Storage account resource ID + queue name' },
];

const ADV_OPERATORS = [
  'StringIn', 'StringNotIn', 'StringBeginsWith', 'StringEndsWith', 'StringContains',
  'NumberIn', 'NumberGreaterThan', 'NumberLessThan', 'BoolEquals',
];

type DestType = 'AzureFunction' | 'WebHook' | 'EventHub' | 'ServiceBusQueue' | 'ServiceBusTopic' | 'StorageQueue';
interface AdvFilterRow { key: string; operatorType: string; values: string }

interface TopicSummary { name: string; endpoint?: string; provisioningState?: string; inputSchema?: string; location?: string }
interface Subscription { name: string; destination?: string; destinationType?: string; provisioningState?: string }
interface Props { item: FabricItemType; id: string }

const emptyAdv = (): AdvFilterRow => ({ key: '', operatorType: 'StringIn', values: '' });

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

  // New event-subscription dialog
  const [subOpen, setSubOpen] = useState(false);
  const [subBusy, setSubBusy] = useState(false);
  const [subName, setSubName] = useState('');
  const [destType, setDestType] = useState<DestType>('AzureFunction');
  const [destResourceId, setDestResourceId] = useState('');
  const [destEndpointUrl, setDestEndpointUrl] = useState('');
  const [destQueueName, setDestQueueName] = useState('');
  const [subjectBeginsWith, setSubjectBeginsWith] = useState('');
  const [subjectEndsWith, setSubjectEndsWith] = useState('');
  const [includedEventTypes, setIncludedEventTypes] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [advFilters, setAdvFilters] = useState<AdvFilterRow[]>([]);
  const [dlResourceId, setDlResourceId] = useState('');
  const [dlContainer, setDlContainer] = useState('');
  const [maxAttempts, setMaxAttempts] = useState('30');
  const [ttlMinutes, setTtlMinutes] = useState('1440');
  const [deliverySchema, setDeliverySchema] = useState<'CloudEventSchemaV1_0' | 'EventGridSchema'>('CloudEventSchemaV1_0');

  // Access-key regenerate
  const [keyBusy, setKeyBusy] = useState<'key1' | 'key2' | null>(null);

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

  const resetSubForm = useCallback(() => {
    setSubName(''); setDestType('AzureFunction'); setDestResourceId(''); setDestEndpointUrl('');
    setDestQueueName(''); setSubjectBeginsWith(''); setSubjectEndsWith(''); setIncludedEventTypes('');
    setCaseSensitive(false); setAdvFilters([]); setDlResourceId(''); setDlContainer('');
    setMaxAttempts('30'); setTtlMinutes('1440'); setDeliverySchema('CloudEventSchemaV1_0');
  }, []);

  const createSubscription = useCallback(async () => {
    if (!selected || !subName.trim()) return;
    const meta = DESTINATIONS.find((d) => d.key === destType);
    // Client-side guard mirrors the server so the user gets an inline error fast.
    if (meta?.needs === 'endpointUrl' && !destEndpointUrl.trim()) { setMsg({ intent: 'error', text: 'Endpoint URL is required for a Web Hook destination.' }); return; }
    if (meta?.needs === 'resourceId' && !destResourceId.trim()) { setMsg({ intent: 'error', text: 'A resource ID is required for this destination.' }); return; }
    if (meta?.needs === 'storageQueue' && (!destResourceId.trim() || !destQueueName.trim())) { setMsg({ intent: 'error', text: 'Storage queue destination needs a storage account resource ID and a queue name.' }); return; }
    setSubBusy(true); setMsg(null);
    try {
      const subscription: any = {
        name: subName.trim(),
        destinationType: destType,
        eventDeliverySchema: deliverySchema,
        filter: {
          subjectBeginsWith: subjectBeginsWith.trim() || undefined,
          subjectEndsWith: subjectEndsWith.trim() || undefined,
          includedEventTypes: includedEventTypes.split(',').map((s) => s.trim()).filter(Boolean),
          isSubjectCaseSensitive: caseSensitive,
          advancedFilters: advFilters
            .filter((r) => r.key.trim() && r.operatorType.trim())
            .map((r) => ({ operatorType: r.operatorType, key: r.key.trim(), values: r.values.split(',').map((v) => v.trim()).filter(Boolean) })),
        },
        deadLetter: dlResourceId.trim() && dlContainer.trim() ? { resourceId: dlResourceId.trim(), blobContainerName: dlContainer.trim() } : undefined,
        retryPolicy: {
          maxDeliveryAttempts: Number(maxAttempts) || undefined,
          eventTimeToLiveInMinutes: Number(ttlMinutes) || undefined,
        },
      };
      if (destType === 'WebHook') subscription.endpointUrl = destEndpointUrl.trim();
      else subscription.resourceId = destResourceId.trim();
      if (destType === 'StorageQueue') subscription.queueName = destQueueName.trim();

      const r = await fetch('/api/items/event-grid-topic', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'create-event-subscription', topic: selected, subscription }),
      });
      const j = await r.json();
      if (!j.ok) { setMsg({ intent: 'error', text: j.error || 'create subscription failed' }); return; }
      setMsg({ intent: 'success', text: `Created event subscription "${subName.trim()}".` });
      setSubOpen(false); resetSubForm();
      await loadDetail(selected);
    } catch (e: any) { setMsg({ intent: 'error', text: e?.message || String(e) }); }
    finally { setSubBusy(false); }
  }, [selected, subName, destType, destResourceId, destEndpointUrl, destQueueName, subjectBeginsWith, subjectEndsWith, includedEventTypes, caseSensitive, advFilters, dlResourceId, dlContainer, maxAttempts, ttlMinutes, deliverySchema, loadDetail, resetSubForm]);

  const regenerateKey = useCallback(async (keyName: 'key1' | 'key2') => {
    if (!selected) return;
    setKeyBusy(keyName); setMsg(null);
    try {
      const r = await fetch('/api/items/event-grid-topic', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'regenerate-key', topic: selected, keyName }),
      });
      const j = await r.json();
      if (!j.ok) { setMsg({ intent: 'error', text: j.error || 'regenerate failed' }); return; }
      setMsg({ intent: 'success', text: `Regenerated ${keyName} for "${selected}".` });
      setDetail((prev) => (prev ? { ...prev, keys: j.keys } : prev));
    } catch (e: any) { setMsg({ intent: 'error', text: e?.message || String(e) }); }
    finally { setKeyBusy(null); }
  }, [selected]);

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Topics', actions: [
        { label: 'New topic', onClick: gate ? undefined : () => setCreateOpen(true), disabled: !!gate },
        { label: 'Refresh', onClick: () => void load() },
      ]},
      { label: 'Subscriptions', actions: [
        { label: 'New subscription', onClick: () => { setTab('detail'); setSubOpen(true); }, disabled: !selected },
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
                    <Caption1>Access key 1</Caption1>
                    <div className={s.keyRow}>
                      <code className={s.mono}>{detail.keys?.key1 ? `${String(detail.keys.key1).slice(0, 6)}… (hidden)` : '—'}</code>
                      <Button size="small" appearance="subtle" icon={<KeyReset20Regular />} disabled={keyBusy !== null} onClick={() => void regenerateKey('key1')}>{keyBusy === 'key1' ? 'Regenerating…' : 'Regenerate'}</Button>
                    </div>
                    <Caption1>Access key 2</Caption1>
                    <div className={s.keyRow}>
                      <code className={s.mono}>{detail.keys?.key2 ? `${String(detail.keys.key2).slice(0, 6)}… (hidden)` : '—'}</code>
                      <Button size="small" appearance="subtle" icon={<KeyReset20Regular />} disabled={keyBusy !== null} onClick={() => void regenerateKey('key2')}>{keyBusy === 'key2' ? 'Regenerating…' : 'Regenerate'}</Button>
                    </div>
                  </div>

                  <div className={s.toolbar}>
                    <Subtitle2>Event subscriptions</Subtitle2>
                    <Button appearance="primary" size="small" icon={<Add20Regular />} onClick={() => setSubOpen(true)}>New subscription</Button>
                    <Button appearance="subtle" size="small" icon={<ArrowSync20Regular />} onClick={() => selected && void loadDetail(selected)}>Refresh</Button>
                  </div>
                  {detail.subscriptions.length === 0 ? (
                    <MessageBar intent="info"><MessageBarBody>No event subscriptions on this topic yet. Click <strong>New subscription</strong> to route events to a handler (Function, webhook, Event Hubs, Service Bus, Storage Queue).</MessageBarBody></MessageBar>
                  ) : (
                    <div className={s.tableWrap}>
                      <Table aria-label="Subscriptions" size="small">
                        <TableHeader><TableRow><TableHeaderCell>Subscription</TableHeaderCell><TableHeaderCell>Type</TableHeaderCell><TableHeaderCell>Destination</TableHeaderCell><TableHeaderCell>State</TableHeaderCell></TableRow></TableHeader>
                        <TableBody>
                          {detail.subscriptions.map((sub) => (
                            <TableRow key={sub.name}>
                              <TableCell className={s.mono}>{sub.name}</TableCell>
                              <TableCell>{sub.destinationType || '—'}</TableCell>
                              <TableCell className={s.mono}>{sub.destination || '—'}</TableCell>
                              <TableCell><Badge appearance="tint" color={sub.provisioningState === 'Succeeded' ? 'success' : 'informative'}>{sub.provisioningState || '—'}</Badge></TableCell>
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

        {/* New event-subscription dialog — destination + filters + dead-letter + retry */}
        <Dialog open={subOpen} onOpenChange={(_, d) => { setSubOpen(d.open); if (!d.open) resetSubForm(); }}>
          <DialogSurface className={s.dialogWide}>
            <DialogBody>
              <DialogTitle>New event subscription{selected ? ` — ${selected}` : ''}</DialogTitle>
              <DialogContent>
                <div className={s.dialogScroll}>
                  <Field label="Subscription name" required>
                    <Input value={subName} onChange={(_, d) => setSubName(d.value)} placeholder="orders-to-function" />
                  </Field>

                  <div className={s.sectionHead}>
                    <Subtitle2>Destination</Subtitle2>
                    <Caption1>{DESTINATIONS.find((d) => d.key === destType)?.hint}</Caption1>
                  </div>
                  <Field label="Handler type">
                    <Dropdown
                      value={DESTINATIONS.find((d) => d.key === destType)?.label || ''}
                      selectedOptions={[destType]}
                      onOptionSelect={(_, d) => setDestType((d.optionValue as DestType) || 'AzureFunction')}
                    >
                      {DESTINATIONS.map((d) => <Option key={d.key} value={d.key} text={d.label}>{d.label}</Option>)}
                    </Dropdown>
                  </Field>
                  {destType === 'WebHook' ? (
                    <Field label="Endpoint URL" required>
                      <Input value={destEndpointUrl} onChange={(_, d) => setDestEndpointUrl(d.value)} placeholder="https://my-func.azurewebsites.net/runtime/webhooks/eventgrid?..." />
                    </Field>
                  ) : (
                    <Field label={destType === 'StorageQueue' ? 'Storage account resource ID' : 'Handler resource ID'} required>
                      <Input value={destResourceId} onChange={(_, d) => setDestResourceId(d.value)} placeholder="/subscriptions/…/resourceGroups/…/providers/…" />
                    </Field>
                  )}
                  {destType === 'StorageQueue' && (
                    <Field label="Queue name" required>
                      <Input value={destQueueName} onChange={(_, d) => setDestQueueName(d.value)} placeholder="eventgrid-queue" />
                    </Field>
                  )}
                  <Field label="Event delivery schema">
                    <Dropdown
                      value={deliverySchema === 'EventGridSchema' ? 'Event Grid schema' : 'CloudEvents v1.0'}
                      selectedOptions={[deliverySchema]}
                      onOptionSelect={(_, d) => setDeliverySchema((d.optionValue as 'CloudEventSchemaV1_0' | 'EventGridSchema') || 'CloudEventSchemaV1_0')}
                    >
                      <Option value="CloudEventSchemaV1_0" text="CloudEvents v1.0">CloudEvents v1.0</Option>
                      <Option value="EventGridSchema" text="Event Grid schema">Event Grid schema</Option>
                    </Dropdown>
                  </Field>

                  <Divider />
                  <div className={s.sectionHead}>
                    <Subtitle2>Filters</Subtitle2>
                    <Caption1>Only events matching every filter below are delivered.</Caption1>
                  </div>
                  <div className={s.two}>
                    <Field label="Subject begins with"><Input value={subjectBeginsWith} onChange={(_, d) => setSubjectBeginsWith(d.value)} placeholder="/orders/" /></Field>
                    <Field label="Subject ends with"><Input value={subjectEndsWith} onChange={(_, d) => setSubjectEndsWith(d.value)} placeholder=".json" /></Field>
                  </div>
                  <Field label="Included event types" hint="Comma-separated, e.g. Order.Placed, Order.Cancelled. Leave blank for all.">
                    <Input value={includedEventTypes} onChange={(_, d) => setIncludedEventTypes(d.value)} placeholder="Order.Placed, Order.Cancelled" />
                  </Field>
                  <Checkbox checked={caseSensitive} onChange={(_, d) => setCaseSensitive(!!d.checked)} label="Subject is case-sensitive" />

                  <div className={s.sectionHead}>
                    <Body1>Advanced filters</Body1>
                    <Caption1>Test a field in the event payload (e.g. <code>data.priority</code>). Values are comma-separated.</Caption1>
                  </div>
                  {advFilters.map((row, i) => (
                    <div key={i} className={s.advRow}>
                      <Field label={i === 0 ? 'Key' : undefined}><Input value={row.key} onChange={(_, d) => setAdvFilters((prev) => prev.map((r, j) => j === i ? { ...r, key: d.value } : r))} placeholder="data.priority" /></Field>
                      <Field label={i === 0 ? 'Operator' : undefined}>
                        <Dropdown
                          value={row.operatorType}
                          selectedOptions={[row.operatorType]}
                          onOptionSelect={(_, d) => setAdvFilters((prev) => prev.map((r, j) => j === i ? { ...r, operatorType: (d.optionValue as string) || 'StringIn' } : r))}
                        >
                          {ADV_OPERATORS.map((op) => <Option key={op} value={op} text={op}>{op}</Option>)}
                        </Dropdown>
                      </Field>
                      <Field label={i === 0 ? 'Values' : undefined}><Input value={row.values} onChange={(_, d) => setAdvFilters((prev) => prev.map((r, j) => j === i ? { ...r, values: d.value } : r))} placeholder="high, urgent" /></Field>
                      <Button appearance="subtle" icon={<Dismiss16Regular />} aria-label="Remove filter" onClick={() => setAdvFilters((prev) => prev.filter((_, j) => j !== i))} />
                    </div>
                  ))}
                  <div><Button appearance="secondary" size="small" icon={<Add20Regular />} onClick={() => setAdvFilters((prev) => [...prev, emptyAdv()])}>Add advanced filter</Button></div>

                  <Divider />
                  <div className={s.sectionHead}><Subtitle2>Dead-letter (optional)</Subtitle2><Caption1>Undeliverable events are written to a Storage blob container.</Caption1></div>
                  <Field label="Storage account resource ID"><Input value={dlResourceId} onChange={(_, d) => setDlResourceId(d.value)} placeholder="/subscriptions/…/storageAccounts/…" /></Field>
                  <Field label="Blob container name"><Input value={dlContainer} onChange={(_, d) => setDlContainer(d.value)} placeholder="eventgrid-deadletter" /></Field>

                  <Divider />
                  <div className={s.sectionHead}><Subtitle2>Retry policy</Subtitle2></div>
                  <div className={s.two}>
                    <Field label="Max delivery attempts" hint="1–30"><Input type="number" min={1} max={30} value={maxAttempts} onChange={(_, d) => setMaxAttempts(d.value)} /></Field>
                    <Field label="Event time-to-live (min)" hint="1–1440"><Input type="number" min={1} max={1440} value={ttlMinutes} onChange={(_, d) => setTtlMinutes(d.value)} /></Field>
                  </div>
                </div>
              </DialogContent>
              <DialogActions>
                <Button appearance="secondary" onClick={() => { setSubOpen(false); resetSubForm(); }}>Cancel</Button>
                <Button appearance="primary" disabled={subBusy || !subName.trim() || !selected} onClick={createSubscription}>{subBusy ? 'Creating…' : 'Create subscription'}</Button>
              </DialogActions>
            </DialogBody>
          </DialogSurface>
        </Dialog>
      </>
    } />
  );
}
