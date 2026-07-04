'use client';

import { clientFetch } from '@/lib/client-fetch';
/**
 * EventHubsDataExplorer — the Send + View (peek) events surface for the Event
 * Hubs namespace editor. Wires the EXISTING data-plane BFF route
 * /api/eventhubs/data-explorer (eventhubs-data-client.ts):
 *
 *   - Send events: real HTTPS data-plane POST to the runtime endpoint (Entra
 *     auth). Publishing works today with no extra dependency.
 *   - View (peek) events: Event Hubs has no HTTPS REST receive path — receiving
 *     is AMQP-only (@azure/event-hubs), gated behind LOOM_EVENTHUB_RECEIVE_ENABLED.
 *     When receive isn't opted in the route returns an honest 501 and this panel
 *     shows the exact remediation (no fake events).
 *
 * Azure Data Explorer parity for the Event Hubs data plane. No mocks.
 */

import { useCallback, useState } from 'react';
import {
  Subtitle2, Caption1, Body1, Button, Spinner, Input, Field, Textarea, Checkbox,
  Dropdown, Option, Badge,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Send20Regular, Eye20Regular } from '@fluentui/react-icons';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, minWidth: 0 },
  panel: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS,
    padding: tokens.spacingVerticalM,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    background: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
  },
  head: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap' },
  row: { display: 'flex', gap: tokens.spacingHorizontalM, alignItems: 'flex-end', flexWrap: 'wrap' },
  narrow: { maxWidth: '200px' },
  tableWrap: { overflow: 'auto', border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium },
  mono: { fontFamily: tokens.fontFamilyMonospace, fontSize: tokens.fontSizeBase200, overflowWrap: 'anywhere', wordBreak: 'break-word', minWidth: 0, maxWidth: '420px' },
});

interface ReceivedEvent {
  offset?: string;
  sequenceNumber?: number;
  enqueuedTime?: string;
  partitionId?: string;
  partitionKey?: string;
  body: unknown;
  properties?: Record<string, unknown>;
}

interface Props {
  hubs: { name: string }[];
}

function bodyPreview(b: unknown): string {
  if (b == null) return '';
  if (typeof b === 'string') return b;
  try { return JSON.stringify(b); } catch { return String(b); }
}

export function EventHubsDataExplorer({ hubs }: Props) {
  const s = useStyles();
  const [hub, setHub] = useState(hubs[0]?.name || '');

  // Send
  const [body, setBody] = useState('{\n  "orderId": "A-1001",\n  "amount": 42.5\n}');
  const [partitionKey, setPartitionKey] = useState('');
  const [sending, setSending] = useState(false);
  const [sendMsg, setSendMsg] = useState<{ intent: 'success' | 'error'; text: string } | null>(null);

  // Peek / View
  const [partition, setPartition] = useState('');
  const [maxEvents, setMaxEvents] = useState('20');
  const [consumerGroup, setConsumerGroup] = useState('');
  const [fromLatest, setFromLatest] = useState(false);
  const [peeking, setPeeking] = useState(false);
  const [events, setEvents] = useState<ReceivedEvent[] | null>(null);
  const [peekGate, setPeekGate] = useState<{ title: string; body: string } | null>(null);
  const [peekError, setPeekError] = useState<string | null>(null);

  const send = useCallback(async () => {
    if (!hub) { setSendMsg({ intent: 'error', text: 'Select an event hub first.' }); return; }
    const raw = body.trim();
    if (!raw) { setSendMsg({ intent: 'error', text: 'Event body is required.' }); return; }
    // Send parsed JSON when the body is valid JSON, otherwise the raw string.
    let payload: unknown = raw;
    try { payload = JSON.parse(raw); } catch { /* send verbatim string */ }
    setSending(true); setSendMsg(null);
    try {
      const r = await clientFetch('/api/eventhubs/data-explorer', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op: 'send', hub, events: [{ body: payload }], partitionKey: partitionKey.trim() || undefined }),
      });
      const j = await r.json();
      if (!j.ok) { setSendMsg({ intent: 'error', text: j.error || `send failed (${r.status})` }); return; }
      setSendMsg({ intent: 'success', text: `Sent ${j.sent ?? 1} event to "${hub}" (HTTP ${j.status}).` });
    } catch (e: any) {
      setSendMsg({ intent: 'error', text: e?.message || String(e) });
    } finally { setSending(false); }
  }, [hub, body, partitionKey]);

  const peek = useCallback(async () => {
    if (!hub) { setPeekError('Select an event hub first.'); return; }
    setPeeking(true); setPeekGate(null); setPeekError(null); setEvents(null);
    try {
      const r = await clientFetch('/api/eventhubs/data-explorer', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          op: 'peek', hub,
          partition: partition.trim() || undefined,
          maxEvents: Number(maxEvents) || 20,
          fromLatest,
          consumerGroup: consumerGroup.trim() || undefined,
        }),
      });
      const j = await r.json();
      if (!j.ok) {
        if (j.code === 'receive_unavailable') {
          setPeekGate({ title: 'Viewing events not enabled', body: `${j.error || ''}${j.hint ? ` ${j.hint}` : ''}`.trim() });
        } else {
          setPeekError(j.error || `peek failed (${r.status})`);
        }
        return;
      }
      setEvents(Array.isArray(j.events) ? j.events : []);
    } catch (e: any) {
      setPeekError(e?.message || String(e));
    } finally { setPeeking(false); }
  }, [hub, partition, maxEvents, fromLatest, consumerGroup]);

  if (hubs.length === 0) {
    return (
      <MessageBar intent="info">
        <MessageBarBody>No event hubs yet. Create one on the <strong>Event hubs</strong> tab before sending or viewing events.</MessageBarBody>
      </MessageBar>
    );
  }

  return (
    <div className={s.root}>
      <div className={s.head}>
        <Badge appearance="filled" color="brand">Data Explorer</Badge>
        <Field label="Event hub" className={s.narrow}>
          <Dropdown value={hub} selectedOptions={[hub]} onOptionSelect={(_, d) => setHub((d.optionValue as string) || hub)}>
            {hubs.map((h) => <Option key={h.name} value={h.name} text={h.name}>{h.name}</Option>)}
          </Dropdown>
        </Field>
      </div>

      {/* SEND */}
      <div className={s.panel}>
        <div className={s.head}><Send20Regular /><Subtitle2>Send events</Subtitle2></div>
        <Caption1>Publishes to the real Event Hubs runtime endpoint over HTTPS (Entra auth). A JSON body is sent as an object; anything else is sent verbatim.</Caption1>
        <Field label="Event body">
          <Textarea value={body} onChange={(_, d) => setBody(d.value)} resize="vertical" rows={5} />
        </Field>
        <div className={s.row}>
          <Field label="Partition key (optional)" hint="Events sharing a key land on the same partition, in order." className={s.narrow}>
            <Input value={partitionKey} onChange={(_, d) => setPartitionKey(d.value)} placeholder="customer-42" />
          </Field>
          <Button appearance="primary" icon={<Send20Regular />} disabled={sending || !hub} onClick={send}>{sending ? 'Sending…' : 'Send event'}</Button>
        </div>
        {sendMsg && <MessageBar intent={sendMsg.intent}><MessageBarBody>{sendMsg.text}</MessageBarBody></MessageBar>}
      </div>

      {/* VIEW / PEEK */}
      <div className={s.panel}>
        <div className={s.head}><Eye20Regular /><Subtitle2>View events</Subtitle2></div>
        <Caption1>Reads a bounded batch of recent events from one partition. Requires the AMQP receive path to be enabled for this deployment.</Caption1>
        <div className={s.row}>
          <Field label="Partition (optional)" className={s.narrow}><Input value={partition} onChange={(_, d) => setPartition(d.value)} placeholder="0" /></Field>
          <Field label="Max events" className={s.narrow}><Input type="number" value={maxEvents} onChange={(_, d) => setMaxEvents(d.value)} /></Field>
          <Field label="Consumer group (optional)" className={s.narrow}><Input value={consumerGroup} onChange={(_, d) => setConsumerGroup(d.value)} placeholder="$Default" /></Field>
          <Checkbox label="From latest (tail)" checked={fromLatest} onChange={(_, d) => setFromLatest(!!d.checked)} />
          <Button appearance="outline" icon={<Eye20Regular />} disabled={peeking || !hub} onClick={peek}>{peeking ? 'Reading…' : 'View events'}</Button>
        </div>

        {peeking && <Spinner size="tiny" label="Reading events…" />}

        {peekGate && (
          <MessageBar intent="warning">
            <MessageBarBody>
              <MessageBarTitle>{peekGate.title}</MessageBarTitle>
              {peekGate.body}
            </MessageBarBody>
          </MessageBar>
        )}
        {peekError && <MessageBar intent="error"><MessageBarBody>{peekError}</MessageBarBody></MessageBar>}

        {events && events.length === 0 && !peekGate && (
          <MessageBar intent="info"><MessageBarBody>No events read from this partition in the wait window.</MessageBarBody></MessageBar>
        )}
        {events && events.length > 0 && (
          <div className={s.tableWrap}>
            <Table aria-label="Events" size="small">
              <TableHeader><TableRow>
                <TableHeaderCell>Seq #</TableHeaderCell>
                <TableHeaderCell>Enqueued</TableHeaderCell>
                <TableHeaderCell>Partition</TableHeaderCell>
                <TableHeaderCell>Body</TableHeaderCell>
              </TableRow></TableHeader>
              <TableBody>
                {events.map((e, i) => (
                  <TableRow key={`${e.sequenceNumber ?? i}`}>
                    <TableCell>{e.sequenceNumber ?? '—'}</TableCell>
                    <TableCell>{e.enqueuedTime ? new Date(e.enqueuedTime).toLocaleString() : '—'}</TableCell>
                    <TableCell>{e.partitionId ?? '—'}{e.partitionKey ? ` · ${e.partitionKey}` : ''}</TableCell>
                    <TableCell className={s.mono}>{bodyPreview(e.body)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        {!events && !peeking && !peekGate && !peekError && <Body1 className={s.mono}>Click <strong>View events</strong> to read recent events.</Body1>}
      </div>
    </div>
  );
}
