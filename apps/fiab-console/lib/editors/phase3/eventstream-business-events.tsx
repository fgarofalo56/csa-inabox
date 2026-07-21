'use client';

/**
 * EventstreamBusinessEventsTab — governed Business Events publisher for CSA
 * Loom Eventstreams.
 *
 * Parity with Fabric Eventstream's "Business events" surface: a governed
 * registry of typed event schemas + a form-driven publisher that validates
 * the payload and emits to the stream's backing Azure Event Hub (no Fabric,
 * no Power BI workspace, no Microsoft Fabric capacity required).
 *
 * Three panels, all typed controls (no freeform JSON per loom_no_freeform_config):
 *   1. Event type registry  — card list of registered governed types.
 *   2. Define event type    — form dialog: event type name, category, owner,
 *      typed field schema (name + primitive-type dropdown + required toggle).
 *   3. Publish event        — pick a registered type, fill schema-driven typed
 *      fields (string/number/boolean/datetime/json), and publish to Event Hubs.
 *
 * All I/O via clientFetch (no bare fetch). All error states via Fluent v9
 * MessageBar. Gate on LOOM_EVENTHUB_NAMESPACE + LOOM_COSMOS_ENDPOINT with
 * honest "Fix it" banners naming the exact env var.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Badge,
  Button,
  Caption1,
  Checkbox,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Dropdown,
  Field,
  Input,
  MessageBar,
  MessageBarActions,
  MessageBarBody,
  MessageBarTitle,
  Option,
  Select,
  Spinner,
  Subtitle2,
  Tab,
  TabList,
  Textarea,
  tokens,
  Tooltip,
} from '@fluentui/react-components';
import {
  Add20Regular,
  ArrowSync20Regular,
  Delete20Regular,
  Flash20Regular,
  FlashCheckmark20Regular,
  Form20Regular,
  List20Regular,
  Send20Regular,
} from '@fluentui/react-icons';
import { clientFetch } from '@/lib/client-fetch';

// ─── types (mirror route shapes) ──────────────────────────────────────────────

type BusinessFieldType = 'string' | 'number' | 'boolean' | 'datetime' | 'json';
type BusinessChannel = 'eventhub' | 'eventgrid';

interface BusinessEventField {
  name: string;
  type: BusinessFieldType;
  required: boolean;
  description?: string;
}

interface BusinessEventType {
  id: string;
  eventType: string;
  displayName: string;
  category: string;
  description?: string;
  fields: BusinessEventField[];
  channels: BusinessChannel[];
  eventHubName?: string;
  owner?: string;
  updatedAt?: string;
}

interface LoadResult {
  ok: boolean;
  eventHub: string | null;
  eventTypes: BusinessEventType[];
  gate?: { missing: string; hint: string };
  ehGate?: { missing: string; hint: string };
  error?: string;
}

const FIELD_TYPES: BusinessFieldType[] = ['string', 'number', 'boolean', 'datetime', 'json'];
const CHANNEL_LABELS: Record<BusinessChannel, string> = {
  eventhub: 'Event Hub',
  eventgrid: 'Event Grid',
};

const EMPTY_FIELD: BusinessEventField = { name: '', type: 'string', required: false };

// ─── sub-component: single field row in the Define dialog ─────────────────────

function FieldRow({
  field,
  idx,
  onChange,
  onRemove,
}: {
  field: BusinessEventField;
  idx: number;
  onChange: (patch: Partial<BusinessEventField>) => void;
  onRemove: () => void;
}) {
  return (
    <div
      style={{
        display: 'flex',
        gap: tokens.spacingHorizontalS,
        alignItems: 'flex-end',
        flexWrap: 'wrap',
      }}
    >
      <Field label={idx === 0 ? 'Field name' : undefined} style={{ flex: 1, minWidth: 130 }}>
        <Input
          value={field.name}
          onChange={(_: unknown, d: any) => onChange({ name: d.value })}
          placeholder="orderId"
          aria-label={`Field ${String(idx + 1)} name`}
        />
      </Field>
      <Field label={idx === 0 ? 'Type' : undefined} style={{ minWidth: 130 }}>
        <Select
          value={field.type}
          onChange={(_: unknown, d: any) => onChange({ type: d.value as BusinessFieldType })}
          aria-label={`Field ${String(idx + 1)} type`}
        >
          {FIELD_TYPES.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </Select>
      </Field>
      <Field label={idx === 0 ? 'Required' : undefined} style={{ minWidth: 90, alignSelf: 'flex-end' }}>
        <Checkbox
          checked={field.required}
          onChange={(_: unknown, d: any) => onChange({ required: !!d.checked })}
          aria-label={`Field ${String(idx + 1)} required`}
        />
      </Field>
      <Button
        appearance="subtle"
        icon={<Delete20Regular />}
        onClick={onRemove}
        aria-label={`Remove field ${String(idx + 1)}`}
        style={{ alignSelf: 'flex-end' }}
      />
    </div>
  );
}

// ─── sub-component: Define event type dialog ──────────────────────────────────

interface DefineDialogProps {
  id: string;
  open: boolean;
  onClose: () => void;
  onSaved: (et: BusinessEventType) => void;
  initial?: BusinessEventType | null;
}

function DefineEventTypeDialog({ id, open, onClose, onSaved, initial }: DefineDialogProps) {
  const [eventType, setEventType] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [category, setCategory] = useState('General');
  const [description, setDescription] = useState('');
  const [owner, setOwner] = useState('');
  const [eventHubName, setEventHubName] = useState('');
  const [fields, setFields] = useState<BusinessEventField[]>([{ ...EMPTY_FIELD }]);
  const [channels, setChannels] = useState<Set<BusinessChannel>>(new Set(['eventhub']));

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Populate form when editing an existing type.
  useEffect(() => {
    if (!open) return;
    if (initial) {
      setEventType(initial.eventType);
      setDisplayName(initial.displayName);
      setCategory(initial.category || 'General');
      setDescription(initial.description || '');
      setOwner(initial.owner || '');
      setEventHubName(initial.eventHubName || '');
      setFields(initial.fields.length ? initial.fields.map((f) => ({ ...f })) : [{ ...EMPTY_FIELD }]);
      setChannels(new Set(initial.channels.length ? initial.channels : ['eventhub']));
    } else {
      setEventType('');
      setDisplayName('');
      setCategory('General');
      setDescription('');
      setOwner('');
      setEventHubName('');
      setFields([{ ...EMPTY_FIELD }]);
      setChannels(new Set(['eventhub']));
    }
    setErr(null);
  }, [open, initial]);

  const updateField = useCallback((idx: number, patch: Partial<BusinessEventField>) => {
    setFields((prev) => prev.map((f, i) => (i === idx ? { ...f, ...patch } : f)));
  }, []);
  const addField = useCallback(() => setFields((prev) => [...prev, { ...EMPTY_FIELD }]), []);
  const removeField = useCallback((idx: number) => setFields((prev) => prev.filter((_, i) => i !== idx)), []);

  const toggleChannel = useCallback((ch: BusinessChannel) => {
    setChannels((prev) => {
      const next = new Set(prev);
      if (next.has(ch)) { if (next.size > 1) next.delete(ch); }
      else next.add(ch);
      return next;
    });
  }, []);

  const canSave = eventType.trim().length > 0 && fields.some((f) => f.name.trim());

  const doSave = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await clientFetch(`/api/items/eventstream/${id}/business-events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'define',
          eventType: eventType.trim(),
          displayName: displayName.trim() || eventType.trim(),
          category: category.trim() || 'General',
          description: description.trim() || undefined,
          owner: owner.trim() || undefined,
          eventHubName: eventHubName.trim() || undefined,
          fields: fields.filter((f) => f.name.trim()),
          channels: [...channels],
        }),
      });
      const j = await r.json();
      if (!j.ok) { setErr(j.error || `HTTP ${String(r.status)}`); return; }
      onSaved(j.eventType as BusinessEventType);
    } catch (e: any) {
      setErr(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }, [id, eventType, displayName, category, description, owner, eventHubName, fields, channels, onSaved]);

  return (
    <Dialog open={open} onOpenChange={(_: unknown, d: any) => { if (!d.open) onClose(); }}>
      <DialogSurface style={{ maxWidth: 640 }}>
        <DialogBody>
          <DialogTitle>{initial ? `Edit — ${initial.displayName}` : 'Register event type'}</DialogTitle>
          <DialogContent>
            <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
              Define a governed event type. Every publish will be validated against this schema before
              being sent to the stream&apos;s backing Azure Event Hub. Azure-native — no Fabric required.
            </Caption1>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)',
                gap: tokens.spacingHorizontalM,
                marginTop: tokens.spacingVerticalM,
              }}
            >
              <Field label="Event type" required hint="e.g. Order.Placed (CloudEvents type)">
                <Input
                  value={eventType}
                  onChange={(_: unknown, d: any) => setEventType(d.value)}
                  placeholder="Order.Placed"
                  disabled={!!initial}
                />
              </Field>
              <Field label="Display name">
                <Input
                  value={displayName}
                  onChange={(_: unknown, d: any) => setDisplayName(d.value)}
                  placeholder="Order Placed"
                />
              </Field>
              <Field label="Category">
                <Input
                  value={category}
                  onChange={(_: unknown, d: any) => setCategory(d.value)}
                  placeholder="Commerce"
                />
              </Field>
              <Field label="Owner team (optional)">
                <Input
                  value={owner}
                  onChange={(_: unknown, d: any) => setOwner(d.value)}
                  placeholder="commerce-platform"
                />
              </Field>
            </div>
            <Field label="Description (optional)" style={{ marginTop: tokens.spacingVerticalS }}>
              <Textarea
                value={description}
                onChange={(_: unknown, d: any) => setDescription(d.value)}
                placeholder="Fired when a customer places a new order."
                rows={2}
              />
            </Field>
            <Field label="Event Hub override (optional)" hint="Leave blank to use the stream's default hub" style={{ marginTop: tokens.spacingVerticalS }}>
              <Input
                value={eventHubName}
                onChange={(_: unknown, d: any) => setEventHubName(d.value)}
                placeholder="(stream default)"
              />
            </Field>
            <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, marginTop: tokens.spacingVerticalS, flexWrap: 'wrap' }}>
              {(['eventhub', 'eventgrid'] as BusinessChannel[]).map((ch) => (
                <Checkbox
                  key={ch}
                  checked={channels.has(ch)}
                  onChange={() => toggleChannel(ch)}
                  label={`Publish to ${CHANNEL_LABELS[ch]}`}
                />
              ))}
            </div>

            <div
              style={{
                marginTop: tokens.spacingVerticalM,
                borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
                paddingTop: tokens.spacingVerticalM,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, marginBottom: tokens.spacingVerticalS }}>
                <Subtitle2>Field schema</Subtitle2>
                {fields.filter((f) => f.name.trim()).length > 0 && (
                  <Badge appearance="tint" color="informative">
                    {String(fields.filter((f) => f.name.trim()).length)}
                  </Badge>
                )}
                <Button
                  appearance="outline"
                  size="small"
                  icon={<Add20Regular />}
                  onClick={addField}
                  style={{ marginLeft: 'auto' }}
                >
                  Add field
                </Button>
              </div>
              {fields.map((f, i) => (
                <FieldRow
                  key={i}
                  field={f}
                  idx={i}
                  onChange={(patch) => updateField(i, patch)}
                  onRemove={() => removeField(i)}
                />
              ))}
              {fields.length === 0 && (
                <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                  No fields. At least one field is required.
                </Caption1>
              )}
            </div>

            {err && (
              <MessageBar intent="error" style={{ marginTop: tokens.spacingVerticalM }}>
                <MessageBarBody>
                  <MessageBarTitle>Save failed</MessageBarTitle>
                  {err}
                </MessageBarBody>
              </MessageBar>
            )}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
            <Button appearance="primary" onClick={doSave} disabled={busy || !canSave}>
              {busy ? 'Saving…' : (initial ? 'Update' : 'Register')}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

// ─── sub-component: Publish event panel ───────────────────────────────────────

function PublishPanel({
  id,
  eventTypes,
  eventHub,
}: {
  id: string;
  eventTypes: BusinessEventType[];
  eventHub: string | null;
}) {
  const [selectedId, setSelectedId] = useState<string>('');
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [partitionKey, setPartitionKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [publishResult, setPublishResult] = useState<{ hub: string; eventType: string; cloudEventId: string } | null>(null);
  const [publishErr, setPublishErr] = useState<string | null>(null);
  const [publishHint, setPublishHint] = useState<string | null>(null);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);

  const selected = useMemo(() => eventTypes.find((et) => et.id === selectedId) ?? null, [eventTypes, selectedId]);

  // Reset field values when a different type is selected.
  useEffect(() => {
    setFieldValues({});
    setPublishResult(null);
    setPublishErr(null);
    setPublishHint(null);
    setValidationErrors([]);
  }, [selectedId]);

  const setFieldValue = useCallback((name: string, value: string) => {
    setFieldValues((prev) => ({ ...prev, [name]: value }));
  }, []);

  /** Coerce a string input to the correct JS type for the field. */
  function coerce(value: string, type: BusinessFieldType): unknown {
    const v = value.trim();
    switch (type) {
      case 'number': {
        const n = Number(v);
        return Number.isNaN(n) ? v : n;
      }
      case 'boolean':
        return v === 'true' || v === '1' || v === 'yes';
      case 'json':
        try { return JSON.parse(v); } catch { return v; }
      case 'datetime':
      case 'string':
      default:
        return v;
    }
  }

  const doPublish = useCallback(async () => {
    if (!selected) return;
    const payload: Record<string, unknown> = {};
    for (const f of selected.fields) {
      const raw = (fieldValues[f.name] ?? '').trim();
      if (raw) payload[f.name] = coerce(raw, f.type);
    }
    setBusy(true);
    setPublishResult(null);
    setPublishErr(null);
    setPublishHint(null);
    setValidationErrors([]);
    try {
      const r = await clientFetch(`/api/items/eventstream/${id}/business-events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'publish',
          id: selected.id,
          payload,
          partitionKey: partitionKey.trim() || undefined,
        }),
      });
      const j = await r.json();
      if (!j.ok) {
        setPublishErr(j.error || `HTTP ${String(r.status)}`);
        setPublishHint(j.hint || null);
        if (Array.isArray(j.validationErrors)) setValidationErrors(j.validationErrors as string[]);
        return;
      }
      setPublishResult({ hub: j.hub as string, eventType: j.eventType as string, cloudEventId: j.cloudEventId as string });
      setFieldValues({});
    } catch (e: any) {
      setPublishErr(e?.message || String(e));
    } finally {
      setBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, selected, fieldValues, partitionKey]);

  if (eventTypes.length === 0) {
    return (
      <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
        No registered event types yet. Define one using the &ldquo;Event types&rdquo; tab first.
      </Caption1>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM }}>
      {eventHub && (
        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
          Publishing to Event Hub: <strong>{eventHub}</strong>
        </Caption1>
      )}
      <Field label="Event type" style={{ maxWidth: 380 }}>
        <Dropdown
          selectedOptions={selectedId ? [selectedId] : []}
          value={selected ? `${selected.displayName} (${selected.eventType})` : ''}
          onOptionSelect={(_: unknown, d: any) => setSelectedId(d.optionValue as string)}
          placeholder="Select a registered event type…"
        >
          {eventTypes.map((et) => (
            <Option key={et.id} value={et.id} text={`${et.displayName} (${et.eventType})`}>
              {`${et.displayName} (${et.eventType})`}
            </Option>
          ))}
        </Dropdown>
      </Field>

      {selected && (
        <>
          {selected.fields.length === 0 ? (
            <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
              This event type has no fields — the payload will be published as an empty object.
            </Caption1>
          ) : (
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
                gap: tokens.spacingHorizontalM,
              }}
            >
              {selected.fields.map((f) => (
                <Field
                  key={f.name}
                  label={f.name}
                  hint={f.description || `${f.type}${f.required ? ' · required' : ''}`}
                >
                  {f.type === 'boolean' ? (
                    <Select
                      value={fieldValues[f.name] ?? ''}
                      onChange={(_: unknown, d: any) => setFieldValue(f.name, d.value)}
                      aria-label={f.name}
                    >
                      <option value="">—</option>
                      <option value="true">true</option>
                      <option value="false">false</option>
                    </Select>
                  ) : (
                    <Input
                      value={fieldValues[f.name] ?? ''}
                      onChange={(_: unknown, d: any) => setFieldValue(f.name, d.value)}
                      placeholder={f.type === 'datetime' ? '2026-07-21T00:00:00Z' : f.type}
                      aria-label={f.name}
                      type={f.type === 'number' ? 'number' : 'text'}
                    />
                  )}
                </Field>
              ))}
            </div>
          )}

          <Field label="Partition key (optional)" hint="Events sharing a key land on the same partition in order" style={{ maxWidth: 320 }}>
            <Input
              value={partitionKey}
              onChange={(_: unknown, d: any) => setPartitionKey(d.value)}
              placeholder="customerId"
              aria-label="Partition key"
            />
          </Field>

          <Button
            appearance="primary"
            icon={busy ? <Spinner size="tiny" /> : <Send20Regular />}
            onClick={doPublish}
            disabled={busy}
            style={{ alignSelf: 'flex-start' }}
          >
            {busy ? 'Publishing…' : 'Publish event'}
          </Button>

          {validationErrors.length > 0 && (
            <MessageBar intent="error">
              <MessageBarBody>
                <MessageBarTitle>Payload validation errors</MessageBarTitle>
                <ul style={{ margin: `${tokens.spacingVerticalXS} 0 0`, paddingLeft: tokens.spacingHorizontalXL }}>
                  {validationErrors.map((e, i) => <li key={i}>{e}</li>)}
                </ul>
              </MessageBarBody>
            </MessageBar>
          )}
          {publishErr && !validationErrors.length && (
            <MessageBar intent={publishHint ? 'warning' : 'error'}>
              <MessageBarBody>
                <MessageBarTitle>{publishHint ? 'Event Hubs not configured' : 'Publish failed'}</MessageBarTitle>
                {publishErr}
                {publishHint && <><br /><Caption1>{publishHint}</Caption1></>}
              </MessageBarBody>
              {publishHint && (
                <MessageBarActions>
                  <Button size="small" appearance="primary" onClick={() => window.open('/admin/environment', '_blank')}>
                    Fix it
                  </Button>
                </MessageBarActions>
              )}
            </MessageBar>
          )}
          {publishResult && (
            <MessageBar intent="success">
              <MessageBarBody>
                <MessageBarTitle>Event published</MessageBarTitle>
                <strong>{publishResult.eventType}</strong> sent to Event Hub{' '}
                <code>{publishResult.hub}</code>. CloudEvents ID:{' '}
                <code>{publishResult.cloudEventId}</code>.
              </MessageBarBody>
            </MessageBar>
          )}
        </>
      )}
    </div>
  );
}

// ─── main export: EventstreamBusinessEventsTab ─────────────────────────────────

export function EventstreamBusinessEventsTab({ id }: { id: string }) {
  const [panel, setPanel] = useState<'types' | 'publish'>('types');
  const [data, setData] = useState<LoadResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [defineOpen, setDefineOpen] = useState(false);
  const [editing, setEditing] = useState<BusinessEventType | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [deleteErr, setDeleteErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await clientFetch(`/api/items/eventstream/${id}/business-events`);
      const j = (await r.json()) as LoadResult;
      setData(j);
    } catch (e: any) {
      setData({ ok: false, eventHub: null, eventTypes: [], error: e?.message || String(e) });
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { void load(); }, [load]);

  const handleSaved = useCallback(
    (_et: BusinessEventType) => {
      setDefineOpen(false);
      setEditing(null);
      void load();
    },
    [load],
  );

  const handleDelete = useCallback(
    async (typeId: string) => {
      setDeleting(typeId);
      setDeleteErr(null);
      try {
        const r = await clientFetch(`/api/items/eventstream/${id}/business-events`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'delete', id: typeId }),
        });
        const j = await r.json();
        if (!j.ok) { setDeleteErr(j.error || `HTTP ${String(r.status)}`); return; }
        void load();
      } catch (e: any) {
        setDeleteErr(e?.message || String(e));
      } finally {
        setDeleting(null);
      }
    },
    [id, load],
  );

  if (loading) {
    return <Spinner size="small" label="Loading business events…" labelPosition="after" />;
  }

  const gate = data?.gate;
  const ehGate = data?.ehGate;
  const eventTypes = data?.eventTypes ?? [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM }}>
      <MessageBar intent="info">
        <MessageBarBody>
          <MessageBarTitle>Business Events publisher</MessageBarTitle>
          Register governed event types (name, category, typed field schema) and publish CloudEvents-shaped
          messages to the stream&apos;s Azure Event Hub. Payloads are validated against the registered
          schema before send. Azure-native — no Microsoft Fabric required.
        </MessageBarBody>
      </MessageBar>

      {gate && (
        <MessageBar intent="warning" layout="multiline">
          <MessageBarBody>
            <MessageBarTitle>Business-event registry not configured</MessageBarTitle>
            Set <code>{gate.missing}</code> to enable the governed event-type registry.{' '}
            {gate.hint}
          </MessageBarBody>
          <MessageBarActions>
            <Button size="small" appearance="primary" onClick={() => window.open('/admin/environment', '_blank')}>
              Fix it
            </Button>
          </MessageBarActions>
        </MessageBar>
      )}

      {ehGate && (
        <MessageBar intent="warning" layout="multiline">
          <MessageBarBody>
            <MessageBarTitle>Event Hubs not configured</MessageBarTitle>
            Set <code>{ehGate.missing}</code> to enable the real Event Hubs publish backend.{' '}
            {ehGate.hint}
          </MessageBarBody>
          <MessageBarActions>
            <Button size="small" appearance="primary" onClick={() => window.open('/admin/environment', '_blank')}>
              Fix it
            </Button>
          </MessageBarActions>
        </MessageBar>
      )}

      {data && !data.ok && data.error && (
        <MessageBar intent="error">
          <MessageBarBody>
            <MessageBarTitle>Load failed</MessageBarTitle>
            {data.error}
          </MessageBarBody>
        </MessageBar>
      )}

      <TabList
        selectedValue={panel}
        onTabSelect={(_: unknown, d: any) => setPanel(d.value as 'types' | 'publish')}
      >
        <Tab value="types" icon={<List20Regular />}>
          Event types
          {eventTypes.length > 0 && (
            <Badge appearance="tint" color="informative" style={{ marginLeft: tokens.spacingHorizontalXS }}>
              {String(eventTypes.length)}
            </Badge>
          )}
        </Tab>
        <Tab value="publish" icon={<Send20Regular />}>Publish event</Tab>
      </TabList>

      {panel === 'types' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS }}>
            <Button
              appearance="primary"
              icon={<Add20Regular />}
              onClick={() => { setEditing(null); setDefineOpen(true); }}
            >
              Register event type
            </Button>
            <Button appearance="outline" icon={<ArrowSync20Regular />} onClick={load}>
              Refresh
            </Button>
          </div>

          {deleteErr && (
            <MessageBar intent="error">
              <MessageBarBody>
                <MessageBarTitle>Delete failed</MessageBarTitle>
                {deleteErr}
              </MessageBarBody>
            </MessageBar>
          )}

          {eventTypes.length === 0 && !gate && (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: tokens.spacingVerticalM,
                padding: `${tokens.spacingVerticalXXL} ${tokens.spacingHorizontalXL}`,
                border: `2px dashed ${tokens.colorNeutralStroke2}`,
                borderRadius: tokens.borderRadiusLarge,
                background: tokens.colorNeutralBackground2,
              }}
            >
              <FlashCheckmark20Regular style={{ fontSize: tokens.fontSizeHero800, color: tokens.colorBrandForeground1 }} />
              <Subtitle2>No event types registered yet</Subtitle2>
              <Caption1 style={{ color: tokens.colorNeutralForeground3, textAlign: 'center', maxWidth: 420 }}>
                Define a governed event type — give it a name, category, and typed field schema. Every
                publish will validate the payload before sending to the Azure Event Hub.
              </Caption1>
              <Button
                appearance="primary"
                icon={<Add20Regular />}
                onClick={() => { setEditing(null); setDefineOpen(true); }}
              >
                Register first event type
              </Button>
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: tokens.spacingHorizontalM }}>
            {eventTypes.map((et) => (
              <div
                key={et.id}
                style={{
                  border: `1px solid ${tokens.colorNeutralStroke2}`,
                  borderRadius: tokens.borderRadiusLarge,
                  padding: tokens.spacingVerticalM,
                  background: tokens.colorNeutralBackground1,
                  boxShadow: tokens.shadow4,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: tokens.spacingVerticalXS,
                  transition: 'box-shadow 0.15s',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap', minWidth: 0 }}>
                  <Flash20Regular style={{ flexShrink: 0, color: tokens.colorBrandForeground1 }} />
                  <strong style={{ fontSize: tokens.fontSizeBase300, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {et.displayName}
                  </strong>
                  <Badge appearance="outline" size="small" style={{ flexShrink: 0 }}>{et.category}</Badge>
                </div>
                <code style={{ fontSize: tokens.fontSizeBase100, color: tokens.colorNeutralForeground3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {et.eventType}
                </code>
                {et.description && (
                  <Caption1 style={{ color: tokens.colorNeutralForeground2 }}>{et.description}</Caption1>
                )}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalXXS, minWidth: 0 }}>
                  {et.fields.map((f) => (
                    <Tooltip
                      key={f.name}
                      content={`${f.type}${f.required ? ' · required' : ''}${f.description ? ` — ${f.description}` : ''}`}
                      relationship="description"
                    >
                      <Badge
                        appearance="tint"
                        color={f.required ? 'brand' : 'informative'}
                        size="small"
                        style={{ cursor: 'default' }}
                      >
                        {f.name}
                      </Badge>
                    </Tooltip>
                  ))}
                  {et.fields.length === 0 && (
                    <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>No fields</Caption1>
                  )}
                </div>
                <div style={{ display: 'flex', gap: tokens.spacingHorizontalXXS, marginTop: tokens.spacingVerticalXS, flexWrap: 'wrap', minWidth: 0 }}>
                  {et.channels.map((ch) => (
                    <Badge key={ch} appearance="filled" color="success" size="small">{CHANNEL_LABELS[ch]}</Badge>
                  ))}
                </div>
                <div style={{ display: 'flex', gap: tokens.spacingHorizontalXS, marginTop: tokens.spacingVerticalXS, alignItems: 'center' }}>
                  <Button
                    appearance="outline"
                    size="small"
                    icon={<Form20Regular />}
                    onClick={() => { setEditing(et); setDefineOpen(true); }}
                  >
                    Edit
                  </Button>
                  <Button
                    appearance="outline"
                    size="small"
                    icon={<Send20Regular />}
                    onClick={() => { setPanel('publish'); }}
                    title="Switch to the Publish tab to send an event of this type"
                  >
                    Publish
                  </Button>
                  <Tooltip content="Delete this event type" relationship="label">
                    <Button
                      appearance="subtle"
                      size="small"
                      icon={deleting === et.id ? <Spinner size="tiny" /> : <Delete20Regular />}
                      onClick={() => handleDelete(et.id)}
                      disabled={deleting === et.id}
                      aria-label={`Delete event type ${et.displayName}`}
                      style={{ marginLeft: 'auto' }}
                    />
                  </Tooltip>
                </div>
                {et.owner && (
                  <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                    Owner: {et.owner}
                  </Caption1>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {panel === 'publish' && (
        <PublishPanel id={id} eventTypes={eventTypes} eventHub={data?.eventHub ?? null} />
      )}

      <DefineEventTypeDialog
        id={id}
        open={defineOpen}
        onClose={() => { setDefineOpen(false); setEditing(null); }}
        onSaved={handleSaved}
        initial={editing}
      />
    </div>
  );
}
