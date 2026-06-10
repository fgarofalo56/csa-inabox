'use client';

/**
 * BusinessEventsView — Real-Time hub "Business events" surface (Fabric parity).
 *
 * One-for-one with Fabric's Real-Time hub Business events page
 * (https://learn.microsoft.com/fabric/real-time-hub/business-events/), built on
 * the Azure-native backend (Cosmos definition + Event Hubs transport + optional
 * Event Grid fan-out) — no Microsoft Fabric required.
 *
 *  • Catalog table — every governed signal definition (name, schema set,
 *    transport hub, publisher / consumer counts), sortable / filterable.
 *  • "+ New business event" wizard — name, description, schema set, and a typed
 *    schema builder (property name + type + required), all dropdown/structured
 *    per loom-no-freeform-config. Creates a real Cosmos definition.
 *  • Detail drawer with the Fabric tabs — Publishers, Consumers, Data preview
 *    (publish a test event), Schema. Publishing posts a structured CloudEvent to
 *    the bound Event Hub via the real data plane.
 *
 * Every control calls a real BFF route. When the Event Hubs transport is not
 * configured an honest MessageBar names LOOM_EVENTHUB_NAMESPACE; the full UI
 * still renders and definitions can still be authored.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Spinner, Badge, Button, MessageBar, MessageBarBody, MessageBarTitle,
  Drawer, DrawerHeader, DrawerHeaderTitle, DrawerBody, Tab, TabList,
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  Field, Input, Textarea, Select, Caption1, Body1, Subtitle2, Dropdown, Option,
  Switch, makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Add20Regular, Dismiss20Regular, ArrowSync20Regular, Flash24Regular,
  Send20Regular, Delete20Regular, PlugConnected20Regular, Eye20Regular,
} from '@fluentui/react-icons';
import { Section } from '@/lib/components/ui/section';
import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';

type PropType = 'string' | 'number' | 'boolean' | 'datetime';
interface SchemaProp { name: string; type: PropType; required?: boolean; description?: string }
interface Publisher { id: string; name: string; kind: string; workspaceId?: string; lastPublishedAt?: string; publishCount?: number }
interface Consumer { id: string; name: string; kind: string; endpoint?: string; registeredAt: string }
interface BusinessEvent {
  id: string; name: string; description?: string; schemaSet?: string;
  schema: SchemaProp[]; eventHub: string; eventGridTopic?: string;
  publishers: Publisher[]; consumers: Consumer[]; createdAt: string; updatedAt: string;
}
interface ListResponse {
  ok: boolean; events?: BusinessEvent[]; transportConfigured?: boolean;
  transportMissing?: string; eventGridConfigured?: boolean; defaultEventHub?: string;
  namespace?: string; error?: string;
}

const PROP_TYPES: PropType[] = ['string', 'number', 'boolean', 'datetime'];
const CONSUMER_KINDS = ['activator', 'function', 'logic-app', 'webhook', 'service-bus'] as const;

const useStyles = makeStyles({
  toolbar: { display: 'flex', gap: tokens.spacingHorizontalM, alignItems: 'center', marginBottom: tokens.spacingVerticalM, flexWrap: 'wrap' },
  spacer: { flex: 1 },
  nameCell: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, minWidth: 0 },
  chip: { flexShrink: 0, width: '28px', height: '28px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', borderRadius: tokens.borderRadiusMedium, backgroundColor: '#7c3aed1f', color: 'var(--loom-accent-purple, #7c3aed)' },
  name: { fontWeight: tokens.fontWeightSemibold, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  schemaRow: { display: 'grid', gridTemplateColumns: '1fr 130px 90px 32px', gap: tokens.spacingHorizontalS, alignItems: 'end', marginBottom: tokens.spacingVerticalS },
  section: { marginBottom: tokens.spacingVerticalL },
  kv: { fontFamily: 'monospace', fontSize: '12px', whiteSpace: 'pre-wrap', wordBreak: 'break-all' },
  payloadGrid: { display: 'grid', gridTemplateColumns: '1fr', gap: tokens.spacingVerticalS, marginBottom: tokens.spacingVerticalM },
  empty: { padding: '28px', borderRadius: '12px', textAlign: 'center', lineHeight: 1.6, fontSize: '14px', border: `1px dashed ${tokens.colorNeutralStroke2}`, backgroundColor: tokens.colorNeutralBackground2, color: tokens.colorNeutralForeground2 },
});

export function BusinessEventsView() {
  const styles = useStyles();
  const [data, setData] = useState<ListResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // create wizard
  const [createOpen, setCreateOpen] = useState(false);
  const [cName, setCName] = useState('');
  const [cDesc, setCDesc] = useState('');
  const [cSet, setCSet] = useState('');
  const [cHub, setCHub] = useState('');
  const [cProps, setCProps] = useState<SchemaProp[]>([{ name: '', type: 'string', required: true }]);
  const [createBusy, setCreateBusy] = useState(false);
  const [createErr, setCreateErr] = useState<string | null>(null);

  // detail drawer
  const [detail, setDetail] = useState<BusinessEvent | null>(null);
  const [detailTab, setDetailTab] = useState<'publishers' | 'consumers' | 'preview' | 'schema'>('publishers');

  // publish (data preview) form
  const [payload, setPayload] = useState<Record<string, string>>({});
  const [pubBusy, setPubBusy] = useState(false);
  const [pubErr, setPubErr] = useState<string | null>(null);
  const [pubResult, setPubResult] = useState<{ eventId: string; eventHub: string; eventGridDelivered: boolean; eventGridNote?: string } | null>(null);

  // consumer form
  const [conName, setConName] = useState('');
  const [conKind, setConKind] = useState<typeof CONSUMER_KINDS[number]>('webhook');
  const [conEndpoint, setConEndpoint] = useState('');
  const [conBusy, setConBusy] = useState(false);

  const load = useCallback(() => {
    setData(null); setErr(null);
    fetch('/api/business-events').then(async (r) => {
      const j: ListResponse = await r.json().catch(() => ({ ok: false, error: 'Bad response' }));
      if (!j.ok) setErr(j.error || 'Failed to load business events.');
      setData(j);
    }).catch((e) => { setErr(String(e?.message || e)); setData({ ok: false, events: [] }); });
  }, []);
  useEffect(load, [load]);

  // Keep the open detail drawer in sync after a reload.
  useEffect(() => {
    if (detail && data?.events) {
      const fresh = data.events.find((e) => e.id === detail.id);
      if (fresh) setDetail(fresh);
    }
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  const events = data?.events || [];
  const loading = data === null;

  // ── create ──
  function addProp() { setCProps((p) => [...p, { name: '', type: 'string', required: false }]); }
  function removeProp(i: number) { setCProps((p) => p.filter((_, idx) => idx !== i)); }
  function setProp(i: number, patch: Partial<SchemaProp>) {
    setCProps((p) => p.map((row, idx) => (idx === i ? { ...row, ...patch } : row)));
  }
  function resetCreate() {
    setCName(''); setCDesc(''); setCSet(''); setCHub('');
    setCProps([{ name: '', type: 'string', required: true }]); setCreateErr(null);
  }
  async function submitCreate() {
    setCreateBusy(true); setCreateErr(null);
    const schema = cProps.filter((p) => p.name.trim()).map((p) => ({ name: p.name.trim(), type: p.type, required: !!p.required, description: p.description }));
    if (!schema.length) { setCreateErr('Add at least one schema property.'); setCreateBusy(false); return; }
    try {
      const r = await fetch('/api/business-events', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: cName.trim(), description: cDesc.trim() || undefined, schemaSet: cSet.trim() || undefined, eventHub: cHub.trim() || undefined, schema }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) { setCreateErr(j.error || `Create failed (HTTP ${r.status}).`); return; }
      setCreateOpen(false); resetCreate(); load();
    } catch (e: any) { setCreateErr(e?.message || String(e)); }
    finally { setCreateBusy(false); }
  }

  // ── detail ──
  function openDetail(e: BusinessEvent) {
    setDetail(e); setDetailTab('publishers');
    setPayload({}); setPubResult(null); setPubErr(null);
    setConName(''); setConKind('webhook'); setConEndpoint('');
  }

  async function publishTest() {
    if (!detail) return;
    setPubBusy(true); setPubErr(null); setPubResult(null);
    const data: Record<string, unknown> = {};
    for (const p of detail.schema) { if (payload[p.name] !== undefined && payload[p.name] !== '') data[p.name] = payload[p.name]; }
    try {
      const r = await fetch(`/api/business-events/${encodeURIComponent(detail.id)}/publish`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ data, publisher: { name: 'Data preview (Console)', kind: 'manual' } }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) { setPubErr(j.error || `Publish failed (HTTP ${r.status}).`); return; }
      setPubResult({ eventId: j.eventId, eventHub: j.eventHub, eventGridDelivered: j.eventGridDelivered, eventGridNote: j.eventGridNote });
      load();
    } catch (e: any) { setPubErr(e?.message || String(e)); }
    finally { setPubBusy(false); }
  }

  async function addConsumer() {
    if (!detail || !conName.trim()) return;
    setConBusy(true);
    try {
      const r = await fetch(`/api/business-events/${encodeURIComponent(detail.id)}/consumers`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: conName.trim(), kind: conKind, endpoint: conEndpoint.trim() || undefined }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.ok) { setDetail(j.event); setConName(''); setConEndpoint(''); load(); }
    } finally { setConBusy(false); }
  }
  async function removeConsumerRow(consumerId: string) {
    if (!detail) return;
    const r = await fetch(`/api/business-events/${encodeURIComponent(detail.id)}/consumers?consumerId=${encodeURIComponent(consumerId)}`, { method: 'DELETE' });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.ok) { setDetail(j.event); load(); }
  }
  async function deleteEvent() {
    if (!detail) return;
    if (typeof window !== 'undefined' && !window.confirm(`Delete business event "${detail.name}"? Publishers and consumers will lose this governed signal.`)) return;
    const r = await fetch(`/api/business-events/${encodeURIComponent(detail.id)}`, { method: 'DELETE' });
    if (r.ok) { setDetail(null); load(); }
  }

  const columns: LoomColumn<BusinessEvent>[] = useMemo(() => [
    {
      key: 'name', label: 'Business event', sortable: true, filterable: true, width: 240,
      render: (e) => (
        <span className={styles.nameCell}>
          <span className={styles.chip} aria-hidden><Flash24Regular style={{ width: 18, height: 18 }} /></span>
          <span className={styles.name} title={e.name}>{e.name}</span>
        </span>
      ),
    },
    { key: 'schemaSet', label: 'Schema set', sortable: true, filterType: 'select', width: 160, getValue: (e) => e.schemaSet || '—', render: (e) => e.schemaSet || '—' },
    { key: 'eventHub', label: 'Transport (Event Hub)', sortable: true, filterable: true, width: 200, render: (e) => <code style={{ fontSize: 12 }}>{e.eventHub}</code> },
    { key: 'publishers', label: 'Publishers', sortable: true, width: 110, getValue: (e) => e.publishers?.length || 0, render: (e) => <Badge appearance="tint" color="brand">{e.publishers?.length || 0}</Badge> },
    { key: 'consumers', label: 'Consumers', sortable: true, width: 110, getValue: (e) => e.consumers?.length || 0, render: (e) => <Badge appearance="tint" color="informative">{e.consumers?.length || 0}</Badge> },
    { key: 'schema', label: 'Fields', sortable: true, width: 90, getValue: (e) => e.schema?.length || 0 },
  ], [styles]);

  return (
    <>
      {err && (
        <MessageBar intent="warning" style={{ marginBottom: 16 }}>
          <MessageBarBody><MessageBarTitle>Business events</MessageBarTitle>{err}</MessageBarBody>
        </MessageBar>
      )}

      {data && data.transportConfigured === false && (
        <MessageBar intent="warning" style={{ marginBottom: 16 }}>
          <MessageBarBody>
            <MessageBarTitle>Event Hubs transport not configured</MessageBarTitle>
            Business events publish to Azure Event Hubs (durable, capacity-metered). Set{' '}
            <code>{data.transportMissing || 'LOOM_EVENTHUB_NAMESPACE'}</code> to the deployment Event Hubs namespace to enable
            publishing. You can still define governed signals below; publishing is blocked until the namespace is set.
            See <code>platform/fiab/bicep/modules/realtime/eventhubs.bicep</code>.
          </MessageBarBody>
        </MessageBar>
      )}

      {data && data.transportConfigured && data.eventGridConfigured === false && (
        <MessageBar intent="info" style={{ marginBottom: 16 }}>
          <MessageBarBody>
            Event Grid consumer fan-out is optional and not configured. Set <code>LOOM_BUSINESS_EVENTS_EGTOPIC</code> to a
            custom-topic endpoint to route published signals to webhooks / Logic Apps / Functions. Event Hubs delivery works without it.
          </MessageBarBody>
        </MessageBar>
      )}

      <Section
        title={
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            Business events
            <Badge appearance="tint">{events.length}</Badge>
            <Badge appearance="outline" size="small">Azure-native</Badge>
          </span>
        }
        actions={
          <span style={{ display: 'inline-flex', gap: 8 }}>
            <Button appearance="subtle" icon={<ArrowSync20Regular />} onClick={load}>Refresh</Button>
            <Button appearance="primary" icon={<Add20Regular />} onClick={() => { resetCreate(); setCreateOpen(true); }}>New business event</Button>
          </span>
        }
      >
        <Caption1 style={{ display: 'block', marginBottom: 12, color: tokens.colorNeutralForeground3 }}>
          Governed, schema-typed signals published by Activator rules, eventstreams, and apps — discoverable here and
          consumable by any subscriber. Each signal is durably transported on Azure Event Hubs and routed to consumers via Event Grid.
        </Caption1>

        {loading ? (
          <Spinner label="Loading business events…" />
        ) : events.length === 0 ? (
          <div className={styles.empty}>
            No business events defined yet.<br />
            Select <b>New business event</b> to define a governed signal (name + typed schema). Activator rules and
            eventstreams can then publish to it, and it becomes discoverable across the organization.
          </div>
        ) : (
          <LoomDataTable
            ariaLabel="Business events"
            columns={columns}
            rows={events}
            getRowId={(e) => e.id}
            onRowClick={(e) => openDetail(e)}
            empty="No business events match the current filter."
          />
        )}
      </Section>

      {/* ── Create wizard ── */}
      <Dialog open={createOpen} onOpenChange={(_, d) => { setCreateOpen(d.open); if (!d.open) resetCreate(); }}>
        <DialogSurface style={{ maxWidth: 640 }}>
          <DialogBody>
            <DialogTitle>New business event</DialogTitle>
            <DialogContent>
              <Field label="Name" required hint="Letters, digits, hyphen or underscore. Example: SalesTargetMissed" className={styles.section}>
                <Input value={cName} onChange={(_, d) => setCName(d.value)} placeholder="SalesTargetMissed" />
              </Field>
              <Field label="Description" className={styles.section}>
                <Textarea value={cDesc} onChange={(_, d) => setCDesc(d.value)} placeholder="When a store's sales drop below target." />
              </Field>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }} className={styles.section}>
                <Field label="Schema set" hint="Groups related events (Fabric parity).">
                  <Input value={cSet} onChange={(_, d) => setCSet(d.value)} placeholder="RetailOperations" />
                </Field>
                <Field label="Event Hub" hint={`Defaults to ${data?.defaultEventHub || 'loom-business-events'}.`}>
                  <Input value={cHub} onChange={(_, d) => setCHub(d.value)} placeholder={data?.defaultEventHub || 'loom-business-events'} />
                </Field>
              </div>

              <Subtitle2 style={{ display: 'block', marginBottom: 8 }}>Event schema</Subtitle2>
              {cProps.map((p, i) => (
                <div key={i} className={styles.schemaRow}>
                  <Field label={i === 0 ? 'Property name' : undefined}>
                    <Input value={p.name} onChange={(_, d) => setProp(i, { name: d.value })} placeholder="storeId" />
                  </Field>
                  <Field label={i === 0 ? 'Type' : undefined}>
                    <Select value={p.type} onChange={(_, d) => setProp(i, { type: d.value as PropType })}>
                      {PROP_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                    </Select>
                  </Field>
                  <Field label={i === 0 ? 'Required' : undefined}>
                    <Switch checked={!!p.required} onChange={(_, d) => setProp(i, { required: d.checked })} />
                  </Field>
                  <Button appearance="subtle" icon={<Delete20Regular />} aria-label="Remove property" disabled={cProps.length === 1}
                    onClick={() => removeProp(i)} />
                </div>
              ))}
              <Button appearance="secondary" icon={<Add20Regular />} size="small" onClick={addProp}>Add property</Button>

              {createErr && <MessageBar intent="error" style={{ marginTop: 12 }}><MessageBarBody>{createErr}</MessageBarBody></MessageBar>}
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => { setCreateOpen(false); resetCreate(); }}>Cancel</Button>
              <Button appearance="primary" disabled={!cName.trim() || createBusy} onClick={submitCreate}>
                {createBusy ? 'Creating…' : 'Create'}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* ── Detail drawer ── */}
      <Drawer open={!!detail} position="end" size="large" onOpenChange={(_, d) => { if (!d.open) setDetail(null); }}>
        <DrawerHeader>
          <DrawerHeaderTitle action={<Button appearance="subtle" icon={<Dismiss20Regular />} onClick={() => setDetail(null)} />}>
            {detail?.name}
          </DrawerHeaderTitle>
        </DrawerHeader>
        <DrawerBody>
          {detail && (
            <>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
                {detail.schemaSet && <Badge appearance="tint">{detail.schemaSet}</Badge>}
                <Badge appearance="outline">Hub: {detail.eventHub}</Badge>
                <div style={{ flex: 1 }} />
                <Button appearance="subtle" icon={<Delete20Regular />} onClick={deleteEvent}>Delete</Button>
              </div>
              {detail.description && <Body1 style={{ display: 'block', marginBottom: 12 }}>{detail.description}</Body1>}

              <TabList selectedValue={detailTab} onTabSelect={(_, d) => setDetailTab(d.value as typeof detailTab)} style={{ marginBottom: 12 }}>
                <Tab value="publishers" icon={<PlugConnected20Regular />}>Publishers ({detail.publishers?.length || 0})</Tab>
                <Tab value="consumers" icon={<PlugConnected20Regular />}>Consumers ({detail.consumers?.length || 0})</Tab>
                <Tab value="preview" icon={<Eye20Regular />}>Data preview</Tab>
                <Tab value="schema">Schema</Tab>
              </TabList>

              {detailTab === 'publishers' && (
                (detail.publishers?.length || 0) === 0
                  ? <Body1>No publishers yet. Activator rules, eventstreams, or a Data-preview publish will appear here once they publish this signal.</Body1>
                  : (
                    <LoomDataTable<Publisher>
                      ariaLabel="Publishers"
                      columns={[
                        { key: 'name', label: 'Publisher', sortable: true, filterable: true, width: 220 },
                        { key: 'kind', label: 'Type', sortable: true, filterType: 'select', width: 120 },
                        { key: 'publishCount', label: 'Events', sortable: true, width: 90, getValue: (p) => p.publishCount || 0 },
                        { key: 'lastPublishedAt', label: 'Last published', sortable: true, width: 180, render: (p) => p.lastPublishedAt ? new Date(p.lastPublishedAt).toLocaleString() : '—' },
                      ]}
                      rows={detail.publishers}
                      getRowId={(p) => p.id}
                    />
                  )
              )}

              {detailTab === 'consumers' && (
                <>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 150px 1fr auto', gap: 8, alignItems: 'end', marginBottom: 16 }}>
                    <Field label="Consumer name"><Input value={conName} onChange={(_, d) => setConName(d.value)} placeholder="OrderProcessor" /></Field>
                    <Field label="Type">
                      <Dropdown value={conKind} selectedOptions={[conKind]} onOptionSelect={(_, d) => setConKind((d.optionValue as any) || 'webhook')}>
                        {CONSUMER_KINDS.map((k) => <Option key={k} value={k}>{k}</Option>)}
                      </Dropdown>
                    </Field>
                    <Field label="Endpoint (optional)"><Input value={conEndpoint} onChange={(_, d) => setConEndpoint(d.value)} placeholder="https://… or resource id" /></Field>
                    <Button appearance="primary" icon={<Add20Regular />} disabled={!conName.trim() || conBusy} onClick={addConsumer}>Subscribe</Button>
                  </div>
                  {(detail.consumers?.length || 0) === 0 ? (
                    <Body1>No consumers subscribed yet.</Body1>
                  ) : (
                    <LoomDataTable<Consumer>
                      ariaLabel="Consumers"
                      columns={[
                        { key: 'name', label: 'Consumer', sortable: true, filterable: true, width: 200 },
                        { key: 'kind', label: 'Type', sortable: true, filterType: 'select', width: 120 },
                        { key: 'endpoint', label: 'Endpoint', width: 240, render: (c) => c.endpoint ? <code style={{ fontSize: 12 }}>{c.endpoint}</code> : '—' },
                        { key: 'actions', label: '', sortable: false, filterable: false, width: 60, render: (c) => <Button appearance="subtle" size="small" icon={<Delete20Regular />} aria-label={`Remove ${c.name}`} onClick={(e) => { e.stopPropagation(); removeConsumerRow(c.id); }} /> },
                      ]}
                      rows={detail.consumers}
                      getRowId={(c) => c.id}
                    />
                  )}
                </>
              )}

              {detailTab === 'preview' && (
                <>
                  <Caption1 style={{ display: 'block', marginBottom: 12, color: tokens.colorNeutralForeground3 }}>
                    Publish a structured test event. The payload is validated against the schema, wrapped in a CloudEvents-1.0
                    envelope, and sent to Event Hub <code>{detail.eventHub}</code> (capacity-metered).
                  </Caption1>
                  <div className={styles.payloadGrid}>
                    {detail.schema.map((p) => (
                      <Field key={p.name} label={`${p.name}${p.required ? ' *' : ''}`} hint={`${p.type}${p.description ? ` — ${p.description}` : ''}`}>
                        {p.type === 'boolean' ? (
                          <Select value={payload[p.name] ?? ''} onChange={(_, d) => setPayload((x) => ({ ...x, [p.name]: d.value }))}>
                            <option value="">—</option><option value="true">true</option><option value="false">false</option>
                          </Select>
                        ) : (
                          <Input
                            type={p.type === 'number' ? 'number' : p.type === 'datetime' ? 'datetime-local' : 'text'}
                            value={payload[p.name] ?? ''}
                            onChange={(_, d) => setPayload((x) => ({ ...x, [p.name]: d.value }))}
                          />
                        )}
                      </Field>
                    ))}
                  </div>
                  <Button appearance="primary" icon={<Send20Regular />} disabled={pubBusy} onClick={publishTest}>
                    {pubBusy ? 'Publishing…' : 'Publish event'}
                  </Button>
                  {pubErr && <MessageBar intent="error" style={{ marginTop: 12 }}><MessageBarBody>{pubErr}</MessageBarBody></MessageBar>}
                  {pubResult && (
                    <MessageBar intent="success" style={{ marginTop: 12 }}>
                      <MessageBarBody>
                        <MessageBarTitle>Published</MessageBarTitle>
                        Event <code>{pubResult.eventId}</code> sent to <code>{pubResult.eventHub}</code>.
                        {pubResult.eventGridDelivered ? ' Also fanned out via Event Grid.' : ''}
                        {pubResult.eventGridNote ? <><br />{pubResult.eventGridNote}</> : null}
                      </MessageBarBody>
                    </MessageBar>
                  )}
                </>
              )}

              {detailTab === 'schema' && (
                <LoomDataTable<SchemaProp>
                  ariaLabel="Schema"
                  columns={[
                    { key: 'name', label: 'Property', sortable: true, filterable: true, width: 200 },
                    { key: 'type', label: 'Type', sortable: true, filterType: 'select', width: 130 },
                    { key: 'required', label: 'Required', sortable: true, width: 100, getValue: (p) => (p.required ? 'Yes' : 'No'), render: (p) => p.required ? <Badge appearance="tint" color="danger">Required</Badge> : <Badge appearance="tint">Optional</Badge> },
                    { key: 'description', label: 'Description', width: 240, render: (p) => p.description || '—' },
                  ]}
                  rows={detail.schema}
                  getRowId={(p) => p.name}
                />
              )}
            </>
          )}
        </DrawerBody>
      </Drawer>
    </>
  );
}
