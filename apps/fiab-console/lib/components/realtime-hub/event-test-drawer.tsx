'use client';

/**
 * EventTestDrawer — Fabric Real-Time hub "Preview data" for a live event source
 * (Event Hub entity or a Loom eventstream's provisioned ingest endpoint). Lets
 * an operator test a stream end-to-end:
 *
 *   - Send a test event over the REAL HTTPS data-plane (works today, no AMQP).
 *   - Peek recent events from the source (real AMQP receive). Event Hubs has no
 *     HTTPS receive path, so when @azure/event-hubs + LOOM_EVENTHUB_RECEIVE_ENABLED
 *     aren't present the eventstream peek route falls back to reading the newest
 *     rows from the stream's ADX ingestion sink table (real Azure Data Explorer
 *     query — also works under private networking); the drawer flags those rows
 *     with an info MessageBar naming the sink. Only when NEITHER AMQP receive
 *     NOR an ADX sink is available does the route return the honest 501
 *     dependency-gate, rendered as a precise MessageBar (never faked events).
 *
 * Two backends, one UI:
 *   - kind 'eventhub'    → /api/eventhubs/data-explorer (op=peek|send, hub)
 *   - kind 'eventstream' → /api/items/eventstream/{id}/events (GET peek / POST send)
 *
 * The test payload is a single message string (not raw JSON config) — the body
 * is built as { message, ts, source:'rti-hub-test' }, so this stays within the
 * "no freeform JSON config" rule while remaining a real, functional send.
 */

import { useState } from 'react';
import {
  Drawer, DrawerHeader, DrawerHeaderTitle, DrawerBody,
  Button, Input, Field, Caption1, Body1, Badge, Spinner, Link,
  MessageBar, MessageBarBody, MessageBarTitle, MessageBarActions,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Dismiss20Regular, Eye20Regular, Send20Regular, PlugConnected20Regular } from '@fluentui/react-icons';

const useStyles = makeStyles({
  section: { marginBottom: tokens.spacingVerticalM },
  row: { display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', alignItems: 'center' },
  event: { marginTop: tokens.spacingVerticalS, padding: tokens.spacingVerticalS, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium },
  meta: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap', marginBottom: tokens.spacingVerticalXS },
  body: { fontFamily: 'monospace', fontSize: '12px', whiteSpace: 'pre-wrap', wordBreak: 'break-all', margin: 0 },
});

interface ReceivedEvent {
  sequenceNumber?: number; enqueuedTime?: string; partitionId?: string; partitionKey?: string;
  body: unknown; properties?: Record<string, unknown>;
}

export type EventTestTarget =
  | { kind: 'eventhub'; hub: string }
  | { kind: 'eventstream'; id: string; nodeIdx?: number };

export interface EventTestDrawerProps {
  open: boolean;
  onClose: () => void;
  /** Drawer title (the stream / hub name). */
  title: string;
  target: EventTestTarget | null;
}

export function EventTestDrawer({ open, onClose, title, target }: EventTestDrawerProps) {
  const styles = useStyles();
  const [message, setMessage] = useState('Hello from CSA Loom');
  const [peekBusy, setPeekBusy] = useState(false);
  const [sendBusy, setSendBusy] = useState(false);
  const [events, setEvents] = useState<ReceivedEvent[] | null>(null);
  const [gate, setGate] = useState<{ title: string; detail: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  // Set when the peeked events came from the eventstream's ADX ingestion sink
  // (the always-real fallback when AMQP receive isn't enabled) — rendered as an
  // info MessageBar naming the sink table so the operator knows the source.
  const [adxNote, setAdxNote] = useState<string | null>(null);
  // 409 from a not-yet-provisioned eventstream → offer in-place provisioning.
  const [needsProvision, setNeedsProvision] = useState<{ detail: string; canProvision: boolean; link?: string } | null>(null);
  const [provisionBusy, setProvisionBusy] = useState(false);
  const [provisioned, setProvisioned] = useState<string | null>(null);

  // Reset transient state when the drawer opens onto a new target.
  const [seededFor, setSeededFor] = useState<string | null>(null);
  if (open && seededFor !== title) {
    setSeededFor(title);
    setEvents(null); setGate(null); setError(null); setSent(null); setAdxNote(null);
    setNeedsProvision(null); setProvisioned(null);
  }
  if (!open && seededFor !== null) setSeededFor(null);

  function peekUrl(): string {
    if (!target) return '';
    return target.kind === 'eventhub'
      ? `/api/eventhubs/data-explorer?op=peek&hub=${encodeURIComponent(target.hub)}&maxEvents=20`
      : `/api/items/eventstream/${encodeURIComponent(target.id)}/events?maxEvents=20&nodeIdx=${target.nodeIdx ?? 0}`;
  }

  async function sendFetch(): Promise<Response> {
    const body = { message, ts: new Date().toISOString(), source: 'rti-hub-test' };
    if (target!.kind === 'eventhub') {
      return fetch('/api/eventhubs/data-explorer', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op: 'send', hub: target!.hub, events: [{ body }] }),
      });
    }
    return fetch(`/api/items/eventstream/${encodeURIComponent((target as any).id)}/events`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nodeIdx: (target as any).nodeIdx ?? 0, events: [{ body }] }),
    });
  }

  /** A 409 from the events route means the source has no provisioned ingest
   *  endpoint yet. For an eventstream target we can provision it in place
   *  (state.sources[nodeIdx] → real Azure Event Hub) — never for a bare
   *  Event Hub entity (which always exists). Returns true when handled. */
  function handle409(status: number, j: any): boolean {
    if (status !== 409 || !target || target.kind !== 'eventstream') return false;
    setNeedsProvision({
      detail: j?.error || 'This source has no provisioned ingest endpoint yet.',
      canProvision: true,
    });
    return true;
  }

  async function provision() {
    if (!target || target.kind !== 'eventstream') return;
    setProvisionBusy(true); setError(null); setProvisioned(null);
    try {
      const res = await fetch(`/api/items/eventstream/${encodeURIComponent(target.id)}/source`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ nodeIdx: target.nodeIdx ?? 0, fromSaved: true }),
      });
      const j = await res.json().catch(() => ({}));
      if (res.status === 422 && j?.code === 'needs_editor') {
        setNeedsProvision({ detail: j.error || 'This source must be configured in the eventstream editor first.', canProvision: false, link: j.link });
        return;
      }
      if (res.status === 503 && j?.code === 'not_configured') {
        setError(`${j.error || 'Azure infrastructure is not configured.'}${j.hint ? ` ${j.hint}` : ''}`);
        return;
      }
      if (!res.ok || !j.ok) { setError(j.error || `Provisioning failed (HTTP ${res.status}).`); return; }
      setNeedsProvision(null);
      const ep = j.endpoint?.entityPath ? ` Ingest endpoint: ${j.endpoint.entityPath}.` : '';
      setProvisioned(`Ingest endpoint provisioned.${ep}${j.hint ? ` ${j.hint}` : ''} You can now send a test event, then peek.`);
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setProvisionBusy(false); }
  }

  async function peek() {
    if (!target) return;
    setPeekBusy(true); setEvents(null); setGate(null); setError(null); setNeedsProvision(null); setAdxNote(null);
    try {
      const res = await fetch(peekUrl());
      const j = await res.json().catch(() => ({}));
      if (res.status === 501 || j?.code === 'receive_unavailable') {
        setGate({
          title: 'Live event receive is not enabled in this runtime',
          detail: `${j.hint || j.error || 'Event Hubs has no HTTPS receive path.'}${j.missing ? ` Set ${j.missing}.` : ''} You can still Send a test event now over the HTTPS data-plane.`,
        });
        return;
      }
      if (handle409(res.status, j)) return;
      if (!res.ok || !j.ok) { setError(j.error || `Peek failed (HTTP ${res.status}).`); return; }
      // ADX-sink fallback: the route read real rows from the stream's KQL
      // Database destination because AMQP receive isn't enabled — flag it.
      if (j.source === 'adx-sink') {
        setAdxNote(j.note || `Showing rows from the stream's ADX sink table${j.sink?.table ? ` '${j.sink.table}'` : ''} (live AMQP receive is not enabled).`);
      }
      setEvents(Array.isArray(j.events) ? j.events : []);
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setPeekBusy(false); }
  }

  async function send() {
    if (!target || !message.trim()) return;
    setSendBusy(true); setError(null); setSent(null); setNeedsProvision(null);
    try {
      const res = await sendFetch();
      const j = await res.json().catch(() => ({}));
      if (handle409(res.status, j)) return;
      if (!res.ok || !j.ok) { setError(j.error || `Send failed (HTTP ${res.status}).`); return; }
      setSent(`Sent ${j.sent ?? 1} test event${(j.sent ?? 1) === 1 ? '' : 's'} (HTTP ${j.status ?? 201}).`);
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setSendBusy(false); }
  }

  return (
    <Drawer open={open} position="end" size="medium" onOpenChange={(_, d) => { if (!d.open) onClose(); }}>
      <DrawerHeader>
        <DrawerHeaderTitle action={<Button appearance="subtle" icon={<Dismiss20Regular />} onClick={onClose} aria-label="Close" />}>
          Preview / test — {title}
        </DrawerHeaderTitle>
      </DrawerHeader>
      <DrawerBody>
        <div className={styles.section}>
          <Caption1>
            Send a test event over the real HTTPS data-plane, then peek recent events to confirm the stream is flowing.
            Receiving (peek) uses AMQP; when that dependency isn&apos;t enabled an honest gate is shown — sending still works.
          </Caption1>
        </div>

        <Field label="Test message" className={styles.section}
          hint="Sent as { message, ts, source } to the source endpoint.">
          <Input value={message} onChange={(_, d) => setMessage(d.value)} />
        </Field>

        <div className={`${styles.row} ${styles.section}`}>
          <Button appearance="primary" icon={sendBusy ? <Spinner size="tiny" /> : <Send20Regular />}
            disabled={!message.trim() || sendBusy || !target} onClick={send}>
            {sendBusy ? 'Sending…' : 'Send test event'}
          </Button>
          <Button appearance="secondary" icon={peekBusy ? <Spinner size="tiny" /> : <Eye20Regular />}
            disabled={peekBusy || !target} onClick={peek}>
            {peekBusy ? 'Peeking…' : 'Peek recent events'}
          </Button>
        </div>

        {sent && <MessageBar intent="success" className={styles.section}><MessageBarBody>{sent}</MessageBarBody></MessageBar>}
        {provisioned && <MessageBar intent="success" className={styles.section}><MessageBarBody>{provisioned}</MessageBarBody></MessageBar>}
        {needsProvision && (
          <MessageBar intent="warning" className={styles.section}>
            <MessageBarBody>
              <MessageBarTitle>Not provisioned yet</MessageBarTitle>
              {needsProvision.canProvision
                ? 'A newly subscribed eventstream must be provisioned before it can receive test events. Provision the ingest endpoint now, then send a test event.'
                : needsProvision.detail}
              {!needsProvision.canProvision && needsProvision.link && (
                <> <Link href={needsProvision.link}>Open the eventstream editor</Link></>
              )}
            </MessageBarBody>
            {needsProvision.canProvision && (
              <MessageBarActions>
                <Button appearance="primary" size="small"
                  icon={provisionBusy ? <Spinner size="tiny" /> : <PlugConnected20Regular />}
                  disabled={provisionBusy} onClick={provision}>
                  {provisionBusy ? 'Provisioning…' : 'Provision ingest endpoint'}
                </Button>
              </MessageBarActions>
            )}
          </MessageBar>
        )}
        {gate && (
          <MessageBar intent="warning" className={styles.section}>
            <MessageBarBody>
              <MessageBarTitle>{gate.title}</MessageBarTitle>
              {gate.detail}
            </MessageBarBody>
          </MessageBar>
        )}
        {adxNote && (
          <MessageBar intent="info" className={styles.section}>
            <MessageBarBody>
              <MessageBarTitle>Previewing from the ADX ingestion sink</MessageBarTitle>
              {adxNote}
            </MessageBarBody>
          </MessageBar>
        )}
        {error && <MessageBar intent="error" className={styles.section}><MessageBarBody>{error}</MessageBarBody></MessageBar>}

        {events && events.length === 0 && (
          <Body1 style={{ marginTop: tokens.spacingVerticalM, display: 'block' }}>
            {adxNote
              ? 'No rows in the sink table yet. Send a test event and let the stream’s ASA job land it in ADX, then peek again.'
              : 'No events in the peeked window. Send a test event, then peek again.'}
          </Body1>
        )}
        {events && events.map((ev, i) => (
          <div key={i} className={styles.event}>
            <div className={styles.meta}>
              {ev.sequenceNumber != null && <Badge appearance="tint" size="small">seq {ev.sequenceNumber}</Badge>}
              {ev.partitionId != null && <Badge appearance="outline" size="small">p{ev.partitionId}</Badge>}
              {ev.enqueuedTime && <Caption1>{ev.enqueuedTime}</Caption1>}
            </div>
            <pre className={styles.body}>{typeof ev.body === 'string' ? ev.body : JSON.stringify(ev.body, null, 2)}</pre>
          </div>
        ))}
      </DrawerBody>
    </Drawer>
  );
}
