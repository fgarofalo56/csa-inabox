'use client';

/**
 * BusinessEventsView — Activator structured-signals / "business events"
 * publishing surface, Azure-native (Event Grid custom topics + Event Hubs).
 *
 * One-for-one with Microsoft Fabric's Activator "business events" / Real-Time
 * hub structured-signal publishing, but with NO Fabric dependency:
 *
 *   - Governed event-type registry: register a typed, governed event schema
 *     once (name, category, fields with types + required flags, channels,
 *     owner). Stored in Cosmos. Every publish is validated against it.
 *   - Publish: a structured form generated FROM the governed schema (no raw
 *     JSON) — emits a CloudEvents v1.0 envelope to the Event Grid custom topic
 *     AND the durable Event Hub, both over real data planes.
 *   - Channels + capacity: the real Event Grid topics + Event Hub entities the
 *     UAMI can publish to, with live Azure Monitor throughput (PublishSuccessCount
 *     / IncomingMessages) so consumption is metered, not guessed.
 *
 * Every control calls a real BFF route backed by real Azure REST. Missing infra
 * surfaces as an honest Fluent MessageBar (the exact env var to set) and the
 * full UI still renders.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Spinner, Badge, Button, MessageBar, MessageBarBody, MessageBarTitle,
  Dialog, DialogTrigger, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  Field, Input, Textarea, Dropdown, Option, Checkbox, Caption1, Body1, Subtitle2,
  Card, CardHeader, Switch, Divider, makeStyles, tokens, Tooltip,
} from '@fluentui/react-components';
import {
  Add20Regular, Delete20Regular, Send20Regular, ArrowSync20Regular,
  Flash24Regular, ShieldCheckmark20Regular, DataUsage20Regular, Channel20Regular,
} from '@fluentui/react-icons';
import { SignInRequired } from '@/lib/components/sign-in-required';
import { Section } from '@/lib/components/ui/section';

type FieldType = 'string' | 'number' | 'boolean' | 'datetime' | 'json';
const FIELD_TYPES: FieldType[] = ['string', 'number', 'boolean', 'datetime', 'json'];
type Channel = 'eventgrid' | 'eventhub';

interface EventField { name: string; type: FieldType; required: boolean; description?: string }
interface EventType {
  id: string; eventType: string; displayName: string; category: string; description?: string;
  fields: EventField[]; channels: Channel[]; eventGridTopic?: string; eventHubName?: string;
  owner?: string; updatedAt?: string; updatedBy?: string;
}
interface MeterSeries { name: string; unit: string; points: { timeStamp: string; value: number | null }[] }
interface ChannelsResp {
  ok: boolean;
  eventGrid: { configured: boolean; topics: { name: string; inputSchema?: string; provisioningState?: string }[]; gate?: { missing: string } };
  eventHub: { configured: boolean; namespace?: string; hubs: { name: string; partitionCount?: number; messageRetentionInDays?: number }[]; gate?: { missing: string } };
  metering: { window: string; eventGrid: MeterSeries[]; eventHub: MeterSeries[] } | null;
  error?: string;
}

const useStyles = makeStyles({
  stats: {
    display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
    gap: tokens.spacingHorizontalM, marginBottom: tokens.spacingVerticalL,
  },
  stat: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM,
    padding: tokens.spacingVerticalM, borderRadius: tokens.borderRadiusXLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1, boxShadow: tokens.shadow2,
  },
  statChip: {
    flexShrink: 0, width: '40px', height: '40px',
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    borderRadius: tokens.borderRadiusLarge, backgroundColor: tokens.colorBrandBackground2,
    color: tokens.colorBrandForeground1,
  },
  statNum: { fontSize: '22px', fontWeight: tokens.fontWeightBold, lineHeight: 1.1 },
  statLabel: { color: tokens.colorNeutralForeground3, fontSize: '12px' },
  toolbar: { display: 'flex', gap: tokens.spacingHorizontalM, alignItems: 'center', marginBottom: tokens.spacingVerticalM, flexWrap: 'wrap' },
  typeGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: tokens.spacingHorizontalM },
  typeCard: { padding: tokens.spacingVerticalM },
  fieldRow: { display: 'grid', gridTemplateColumns: '1.4fr 1fr auto auto', gap: tokens.spacingHorizontalS, alignItems: 'end', marginBottom: tokens.spacingVerticalS },
  meter: { display: 'flex', gap: tokens.spacingHorizontalL, flexWrap: 'wrap' },
  meterCard: { minWidth: 200, padding: tokens.spacingVerticalM, borderRadius: tokens.borderRadiusLarge, border: `1px solid ${tokens.colorNeutralStroke2}` },
  mono: { fontFamily: 'monospace', fontSize: '12px' },
  chips: { display: 'flex', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap' },
  dialogCol: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: 480 },
});

function sumMeter(series?: MeterSeries): number {
  if (!series) return 0;
  return series.points.reduce((a, p) => a + (typeof p.value === 'number' ? p.value : 0), 0);
}

export function BusinessEventsView() {
  const s = useStyles();
  const [types, setTypes] = useState<EventType[] | null>(null);
  const [channels, setChannels] = useState<ChannelsResp | null>(null);
  const [unauth, setUnauth] = useState(false);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [regGate, setRegGate] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const [tRes, cRes] = await Promise.all([
        fetch('/api/business-events/types', { cache: 'no-store' }),
        fetch('/api/business-events/channels', { cache: 'no-store' }),
      ]);
      if (tRes.status === 401 || cRes.status === 401) { setUnauth(true); return; }
      const t = await tRes.json().catch(() => ({}));
      const c = await cRes.json().catch(() => ({}));
      if (t?.code === 'not_configured') { setRegGate(t.missing || 'LOOM_COSMOS_ENDPOINT'); setTypes([]); }
      else if (t?.ok) { setTypes(t.types || []); setRegGate(null); }
      else { setLoadErr(t?.error || 'Failed to load governed event types'); setTypes([]); }
      if (c?.ok) setChannels(c);
      else setChannels(null);
    } catch (e: any) {
      setLoadErr(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (unauth) return <SignInRequired subject="business events" />;

  const egTopics = channels?.eventGrid.topics ?? [];
  const ehHubs = channels?.eventHub.hubs ?? [];

  return (
    <div>
      {loadErr && (
        <MessageBar intent="error" style={{ marginBottom: 12 }}>
          <MessageBarBody><MessageBarTitle>Load error</MessageBarTitle>{loadErr}</MessageBarBody>
        </MessageBar>
      )}
      {regGate && (
        <MessageBar intent="warning" style={{ marginBottom: 12 }}>
          <MessageBarBody>
            <MessageBarTitle>Business-event registry not configured</MessageBarTitle>
            The governed event-type registry needs Cosmos. Set <code>{regGate}</code> on the Console app.
            See <code>platform/fiab/bicep/modules/landing-zone/eventgrid-business.bicep</code>.
          </MessageBarBody>
        </MessageBar>
      )}

      {/* ── Stats ─────────────────────────────────────────────── */}
      <div className={s.stats}>
        <div className={s.stat}>
          <span className={s.statChip}><ShieldCheckmark20Regular /></span>
          <div><div className={s.statNum}>{types?.length ?? '—'}</div><div className={s.statLabel}>Governed event types</div></div>
        </div>
        <div className={s.stat}>
          <span className={s.statChip}><Flash24Regular /></span>
          <div><div className={s.statNum}>{egTopics.length}</div><div className={s.statLabel}>Event Grid topics</div></div>
        </div>
        <div className={s.stat}>
          <span className={s.statChip}><Channel20Regular /></span>
          <div><div className={s.statNum}>{ehHubs.length}</div><div className={s.statLabel}>Event Hubs</div></div>
        </div>
        <div className={s.stat}>
          <span className={s.statChip}><DataUsage20Regular /></span>
          <div>
            <div className={s.statNum}>
              {channels?.metering ? sumMeter(channels.metering.eventGrid.find((m) => /PublishSuccess/i.test(m.name))) + sumMeter(channels.metering.eventHub.find((m) => /IncomingMessages/i.test(m.name))) : '—'}
            </div>
            <div className={s.statLabel}>Events / 24h (metered)</div>
          </div>
        </div>
      </div>

      <div className={s.toolbar}>
        <RegisterTypeDialog egTopics={egTopics.map((t) => t.name)} ehHubs={ehHubs.map((h) => h.name)} onSaved={load} disabled={!!regGate} />
        <Button icon={<ArrowSync20Regular />} appearance="subtle" onClick={load} disabled={busy}>Refresh</Button>
        {busy && <Spinner size="tiny" />}
      </div>

      {/* ── Governed event types ──────────────────────────────── */}
      <Section title="Governed event types">
        {!types ? (
          <Spinner label="Loading governed types…" />
        ) : types.length === 0 ? (
          <Body1>No governed event types yet. Register one to start publishing structured business signals.</Body1>
        ) : (
          <div className={s.typeGrid}>
            {types.map((t) => (
              <Card key={t.id} className={s.typeCard}>
                <CardHeader
                  header={<Subtitle2>{t.displayName}</Subtitle2>}
                  description={<Caption1 className={s.mono}>{t.eventType}</Caption1>}
                  action={
                    <Tooltip content="Delete governed type" relationship="label">
                      <Button
                        icon={<Delete20Regular />} appearance="subtle" size="small"
                        onClick={async () => {
                          if (!confirm(`Delete governed type "${t.displayName}"?`)) return;
                          await fetch(`/api/business-events/types?id=${encodeURIComponent(t.id)}`, { method: 'DELETE' });
                          load();
                        }}
                      />
                    </Tooltip>
                  }
                />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div className={s.chips}>
                    <Badge appearance="tint" color="brand">{t.category}</Badge>
                    {t.channels.map((c) => <Badge key={c} appearance="outline">{c === 'eventgrid' ? 'Event Grid' : 'Event Hubs'}</Badge>)}
                  </div>
                  {t.description && <Caption1>{t.description}</Caption1>}
                  <Caption1>{t.fields.length} field{t.fields.length === 1 ? '' : 's'}{t.owner ? ` · owner ${t.owner}` : ''}</Caption1>
                  <PublishDialog type={t} onPublished={load} />
                </div>
              </Card>
            ))}
          </div>
        )}
      </Section>

      {/* ── Channels + capacity ───────────────────────────────── */}
      <Section title="Channels & capacity">
        {channels?.eventGrid.gate && (
          <MessageBar intent="warning" style={{ marginBottom: 8 }}>
            <MessageBarBody>
              <MessageBarTitle>Event Grid channel not configured</MessageBarTitle>
              Set <code>{channels.eventGrid.gate.missing}</code> to enable the Event Grid fan-out channel.
            </MessageBarBody>
          </MessageBar>
        )}
        {channels?.eventHub.gate && (
          <MessageBar intent="warning" style={{ marginBottom: 8 }}>
            <MessageBarBody>
              <MessageBarTitle>Event Hubs channel not configured</MessageBarTitle>
              Set <code>{channels.eventHub.gate.missing}</code> to enable the durable Event Hubs channel.
            </MessageBarBody>
          </MessageBar>
        )}
        <div className={s.meter}>
          <div className={s.meterCard}>
            <Subtitle2>Event Grid topics</Subtitle2>
            {egTopics.length === 0 ? <Caption1>No custom topics.</Caption1> : (
              <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                {egTopics.map((t) => <li key={t.name}><span className={s.mono}>{t.name}</span> <Caption1>· {t.inputSchema || 'CloudEvents'}</Caption1></li>)}
              </ul>
            )}
            {channels?.metering && (
              <Caption1 style={{ display: 'block', marginTop: 6 }}>
                Published (24h): {sumMeter(channels.metering.eventGrid.find((m) => /PublishSuccess/i.test(m.name)))} · failed {sumMeter(channels.metering.eventGrid.find((m) => /PublishFail/i.test(m.name)))}
              </Caption1>
            )}
            <CreateTopicDialog onCreated={load} disabled={!channels?.eventGrid.configured} />
          </div>
          <div className={s.meterCard}>
            <Subtitle2>Event Hubs{channels?.eventHub.namespace ? ` · ${channels.eventHub.namespace}` : ''}</Subtitle2>
            {ehHubs.length === 0 ? <Caption1>No event hubs.</Caption1> : (
              <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                {ehHubs.map((h) => <li key={h.name}><span className={s.mono}>{h.name}</span> <Caption1>· {h.partitionCount ?? '—'}p · {h.messageRetentionInDays ?? '—'}d</Caption1></li>)}
              </ul>
            )}
            {channels?.metering && (
              <Caption1 style={{ display: 'block', marginTop: 6 }}>
                Incoming (24h): {sumMeter(channels.metering.eventHub.find((m) => /IncomingMessages/i.test(m.name)))} msgs
              </Caption1>
            )}
          </div>
        </div>
        <Caption1 style={{ display: 'block', marginTop: 10 }}>
          Published business events appear as subscribable sources in the <a href="/realtime-hub">Real-Time hub</a> and can drive
          {' '}<a href="/activator">Activator</a> rules. Throughput above is read live from Azure Monitor.
        </Caption1>
      </Section>
    </div>
  );
}

/* ───────────────────────── Register governed type ─────────────────────── */

function RegisterTypeDialog({
  egTopics, ehHubs, onSaved, disabled,
}: { egTopics: string[]; ehHubs: string[]; onSaved: () => void; disabled?: boolean }) {
  const s = useStyles();
  const [open, setOpen] = useState(false);
  const [eventType, setEventType] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [category, setCategory] = useState('Operations');
  const [description, setDescription] = useState('');
  const [owner, setOwner] = useState('');
  const [chEventGrid, setChEventGrid] = useState(true);
  const [chEventHub, setChEventHub] = useState(false);
  const [egTopic, setEgTopic] = useState('');
  const [ehName, setEhName] = useState('');
  const [fields, setFields] = useState<EventField[]>([{ name: 'id', type: 'string', required: true }]);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const reset = () => {
    setEventType(''); setDisplayName(''); setCategory('Operations'); setDescription(''); setOwner('');
    setChEventGrid(true); setChEventHub(false); setEgTopic(''); setEhName('');
    setFields([{ name: 'id', type: 'string', required: true }]); setErr(null);
  };

  const save = async () => {
    setSaving(true); setErr(null);
    const channels: Channel[] = [];
    if (chEventGrid) channels.push('eventgrid');
    if (chEventHub) channels.push('eventhub');
    try {
      const res = await fetch('/api/business-events/types', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          eventType, displayName, category, description: description || undefined, owner: owner || undefined,
          channels, eventGridTopic: egTopic || undefined, eventHubName: ehName || undefined,
          fields: fields.filter((f) => f.name.trim()),
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j?.ok) { setErr(j?.error || `Save failed (${res.status})`); return; }
      setOpen(false); reset(); onSaved();
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setSaving(false); }
  };

  return (
    <Dialog open={open} onOpenChange={(_, d) => { setOpen(d.open); if (!d.open) reset(); }}>
      <DialogTrigger disableButtonEnhancement>
        <Button appearance="primary" icon={<Add20Regular />} disabled={disabled}>Register event type</Button>
      </DialogTrigger>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Register a governed event type</DialogTitle>
          <DialogContent>
            <div className={s.dialogCol}>
              {err && <MessageBar intent="error"><MessageBarBody>{err}</MessageBarBody></MessageBar>}
              <Field label="Event type (CloudEvents type)" required hint="e.g. Order.Placed">
                <Input value={eventType} onChange={(_, d) => setEventType(d.value)} placeholder="Order.Placed" />
              </Field>
              <Field label="Display name" required>
                <Input value={displayName} onChange={(_, d) => setDisplayName(d.value)} placeholder="Order placed" />
              </Field>
              <Field label="Category" required>
                <Dropdown value={category} selectedOptions={[category]} onOptionSelect={(_, d) => setCategory(d.optionValue || 'Operations')}>
                  {['Commerce', 'Operations', 'Security', 'Finance', 'Customer', 'Platform'].map((c) => <Option key={c} value={c}>{c}</Option>)}
                </Dropdown>
              </Field>
              <Field label="Description">
                <Textarea value={description} onChange={(_, d) => setDescription(d.value)} />
              </Field>
              <Field label="Owner / steward">
                <Input value={owner} onChange={(_, d) => setOwner(d.value)} placeholder="team@contoso.com" />
              </Field>

              <Divider />
              <Subtitle2>Fields (governed schema)</Subtitle2>
              {fields.map((f, i) => (
                <div className={s.fieldRow} key={i}>
                  <Field label={i === 0 ? 'Name' : undefined}>
                    <Input value={f.name} onChange={(_, d) => setFields((p) => p.map((x, j) => j === i ? { ...x, name: d.value } : x))} />
                  </Field>
                  <Field label={i === 0 ? 'Type' : undefined}>
                    <Dropdown value={f.type} selectedOptions={[f.type]} onOptionSelect={(_, d) => setFields((p) => p.map((x, j) => j === i ? { ...x, type: (d.optionValue as FieldType) || 'string' } : x))}>
                      {FIELD_TYPES.map((t) => <Option key={t} value={t}>{t}</Option>)}
                    </Dropdown>
                  </Field>
                  <Checkbox checked={f.required} label="Req" onChange={(_, d) => setFields((p) => p.map((x, j) => j === i ? { ...x, required: !!d.checked } : x))} />
                  <Button icon={<Delete20Regular />} appearance="subtle" size="small" onClick={() => setFields((p) => p.filter((_, j) => j !== i))} />
                </div>
              ))}
              <Button icon={<Add20Regular />} appearance="subtle" size="small" onClick={() => setFields((p) => [...p, { name: '', type: 'string', required: false }])}>Add field</Button>

              <Divider />
              <Subtitle2>Channels</Subtitle2>
              <Switch checked={chEventGrid} label="Event Grid (fan-out router)" onChange={(_, d) => setChEventGrid(!!d.checked)} />
              {chEventGrid && (
                <Field label="Event Grid topic (blank = deployment default)">
                  <Dropdown value={egTopic} selectedOptions={egTopic ? [egTopic] : []} placeholder="loom-business-events" onOptionSelect={(_, d) => setEgTopic(d.optionValue || '')}>
                    <Option value="">Deployment default</Option>
                    {egTopics.map((t) => <Option key={t} value={t}>{t}</Option>)}
                  </Dropdown>
                </Field>
              )}
              <Switch checked={chEventHub} label="Event Hubs (durable stream)" onChange={(_, d) => setChEventHub(!!d.checked)} />
              {chEventHub && (
                <Field label="Event Hub (blank = loom-telemetry)">
                  <Dropdown value={ehName} selectedOptions={ehName ? [ehName] : []} placeholder="loom-telemetry" onOptionSelect={(_, d) => setEhName(d.optionValue || '')}>
                    <Option value="">Default (loom-telemetry)</Option>
                    {ehHubs.map((h) => <Option key={h} value={h}>{h}</Option>)}
                  </Dropdown>
                </Field>
              )}
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={() => setOpen(false)}>Cancel</Button>
            <Button appearance="primary" onClick={save} disabled={saving || !eventType.trim() || !displayName.trim() || (!chEventGrid && !chEventHub)}>
              {saving ? <Spinner size="tiny" /> : 'Register'}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

/* ───────────────────────── Publish a governed event ───────────────────── */

function PublishDialog({ type, onPublished }: { type: EventType; onPublished: () => void }) {
  const s = useStyles();
  const [open, setOpen] = useState(false);
  const [subject, setSubject] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [publishing, setPublishing] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);

  const coerce = useCallback((f: EventField, raw: string): unknown => {
    if (raw === '' && !f.required) return undefined;
    switch (f.type) {
      case 'number': return Number(raw);
      case 'boolean': return raw === 'true' || raw === '1';
      case 'json': try { return JSON.parse(raw); } catch { return raw; }
      default: return raw;
    }
  }, []);

  const publish = async () => {
    setPublishing(true); setErr(null); setErrors([]); setResult(null);
    const data: Record<string, unknown> = {};
    for (const f of type.fields) {
      const v = coerce(f, values[f.name] ?? '');
      if (v !== undefined) data[f.name] = v;
    }
    try {
      const res = await fetch('/api/business-events/publish', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ typeId: type.id, subject, data }),
      });
      const j = await res.json().catch(() => ({}));
      if (j?.code === 'schema_validation_failed') { setErrors(j.errors || []); return; }
      if (!res.ok || !j?.ok) {
        const ce = j?.channelErrors ? Object.entries(j.channelErrors).map(([k, v]) => `${k}: ${v}`).join('; ') : '';
        setErr(j?.error || ce || `Publish failed (${res.status})`); return;
      }
      const parts: string[] = [];
      if (j.results?.eventgrid) parts.push(`Event Grid (${j.results.eventgrid.published})`);
      if (j.results?.eventhub) parts.push(`Event Hubs (${j.results.eventhub.sent})`);
      setResult(`Published to ${parts.join(' + ') || 'no channel'}.`);
      onPublished();
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setPublishing(false); }
  };

  return (
    <Dialog open={open} onOpenChange={(_, d) => { setOpen(d.open); if (!d.open) { setResult(null); setErr(null); setErrors([]); } }}>
      <DialogTrigger disableButtonEnhancement>
        <Button appearance="primary" size="small" icon={<Send20Regular />} style={{ marginTop: 8 }}>Publish event</Button>
      </DialogTrigger>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Publish · {type.displayName}</DialogTitle>
          <DialogContent>
            <div className={s.dialogCol}>
              {err && <MessageBar intent="error"><MessageBarBody>{err}</MessageBarBody></MessageBar>}
              {errors.length > 0 && (
                <MessageBar intent="error">
                  <MessageBarBody>
                    <MessageBarTitle>Schema validation failed</MessageBarTitle>
                    <ul style={{ margin: 0, paddingLeft: 18 }}>{errors.map((e, i) => <li key={i}>{e}</li>)}</ul>
                  </MessageBarBody>
                </MessageBar>
              )}
              {result && <MessageBar intent="success"><MessageBarBody>{result}</MessageBarBody></MessageBar>}
              <Field label="Subject" required hint="The resource this event is about, e.g. orders/12345">
                <Input value={subject} onChange={(_, d) => setSubject(d.value)} />
              </Field>
              <Divider />
              <Caption1>Payload (validated against the governed schema)</Caption1>
              {type.fields.map((f) => (
                <Field key={f.name} label={`${f.name}${f.required ? ' *' : ''}`} hint={`${f.type}${f.description ? ` — ${f.description}` : ''}`}>
                  {f.type === 'boolean' ? (
                    <Dropdown value={values[f.name] || 'false'} selectedOptions={[values[f.name] || 'false']} onOptionSelect={(_, d) => setValues((p) => ({ ...p, [f.name]: d.optionValue || 'false' }))}>
                      <Option value="true">true</Option><Option value="false">false</Option>
                    </Dropdown>
                  ) : f.type === 'json' ? (
                    <Textarea value={values[f.name] || ''} onChange={(_, d) => setValues((p) => ({ ...p, [f.name]: d.value }))} placeholder='{ "key": "value" }' />
                  ) : (
                    <Input
                      type={f.type === 'number' ? 'number' : f.type === 'datetime' ? 'datetime-local' : 'text'}
                      value={values[f.name] || ''}
                      onChange={(_, d) => setValues((p) => ({ ...p, [f.name]: d.value }))}
                    />
                  )}
                </Field>
              ))}
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={() => setOpen(false)}>Close</Button>
            <Button appearance="primary" icon={<Send20Regular />} onClick={publish} disabled={publishing || !subject.trim()}>
              {publishing ? <Spinner size="tiny" /> : 'Publish'}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

/* ───────────────────────── Create Event Grid topic ────────────────────── */

function CreateTopicDialog({ onCreated, disabled }: { onCreated: () => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [schema, setSchema] = useState<'CloudEventSchemaV1_0' | 'EventGridSchema'>('CloudEventSchemaV1_0');
  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const create = async () => {
    setCreating(true); setErr(null);
    try {
      const res = await fetch('/api/business-events/topics', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, inputSchema: schema }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j?.ok) { setErr(j?.error || `Create failed (${res.status})`); return; }
      setOpen(false); setName(''); onCreated();
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setCreating(false); }
  };

  return (
    <Dialog open={open} onOpenChange={(_, d) => { setOpen(d.open); if (!d.open) setErr(null); }}>
      <DialogTrigger disableButtonEnhancement>
        <Button appearance="subtle" size="small" icon={<Add20Regular />} disabled={disabled} style={{ marginTop: 8 }}>New topic</Button>
      </DialogTrigger>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Create Event Grid custom topic</DialogTitle>
          <DialogContent>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 400 }}>
              {err && <MessageBar intent="error"><MessageBarBody>{err}</MessageBarBody></MessageBar>}
              <Field label="Topic name" required>
                <Input value={name} onChange={(_, d) => setName(d.value)} placeholder="loom-business-events" />
              </Field>
              <Field label="Input schema">
                <Dropdown value={schema} selectedOptions={[schema]} onOptionSelect={(_, d) => setSchema((d.optionValue as any) || 'CloudEventSchemaV1_0')}>
                  <Option value="CloudEventSchemaV1_0">CloudEvents v1.0 (recommended)</Option>
                  <Option value="EventGridSchema">Event Grid schema (legacy)</Option>
                </Dropdown>
              </Field>
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={() => setOpen(false)}>Cancel</Button>
            <Button appearance="primary" onClick={create} disabled={creating || !name.trim()}>
              {creating ? <Spinner size="tiny" /> : 'Create'}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
