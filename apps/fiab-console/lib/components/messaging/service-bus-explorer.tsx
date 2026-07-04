'use client';

import { clientFetch } from '@/lib/client-fetch';
/**
 * ServiceBusExplorer — the Send + Peek surface for the Service Bus namespace
 * editor (parity with the Azure portal's Service Bus Explorer). Wires the
 * data-plane BFF route /api/items/service-bus-namespace/data-explorer
 * (servicebus-data-client.ts):
 *
 *   - Send a test message to a queue or topic (real HTTPS data-plane POST).
 *   - Peek (non-destructive) recent messages from a queue or a topic
 *     subscription — real peek-lock + unlock, no messages consumed.
 *
 * Entra auth; a missing "Azure Service Bus Data Sender/Receiver" role surfaces
 * the real service error. No mocks.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Subtitle2, Caption1, Body1, Button, Spinner, Input, Field, Textarea, Badge,
  Dropdown, Option, RadioGroup, Radio,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody,
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
  narrow: { minWidth: '180px', maxWidth: '220px' },
  inline: { display: 'flex', gap: tokens.spacingHorizontalM, alignItems: 'center', flexWrap: 'wrap' },
  tableWrap: { overflow: 'auto', border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium },
  mono: { fontFamily: tokens.fontFamilyMonospace, fontSize: tokens.fontSizeBase200, overflowWrap: 'anywhere', wordBreak: 'break-word', minWidth: 0, maxWidth: '420px' },
});

interface PeekedMessage {
  messageId?: string;
  sequenceNumber?: number;
  label?: string;
  enqueuedTime?: string;
  deliveryCount?: number;
  body: unknown;
}

interface Props {
  queues: { name: string }[];
  topics: { name: string }[];
}

function bodyPreview(b: unknown): string {
  if (b == null) return '';
  if (typeof b === 'string') return b;
  try { return JSON.stringify(b); } catch { return String(b); }
}

export function ServiceBusExplorer({ queues, topics }: Props) {
  const s = useStyles();

  // Send
  const [sendKind, setSendKind] = useState<'queue' | 'topic'>(queues.length ? 'queue' : 'topic');
  const [sendTarget, setSendTarget] = useState('');
  const [body, setBody] = useState('{\n  "orderId": "A-1001",\n  "amount": 42.5\n}');
  const [label, setLabel] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [sending, setSending] = useState(false);
  const [sendMsg, setSendMsg] = useState<{ intent: 'success' | 'error'; text: string } | null>(null);

  // Peek
  const [peekKind, setPeekKind] = useState<'queue' | 'subscription'>(queues.length ? 'queue' : 'subscription');
  const [peekQueue, setPeekQueue] = useState('');
  const [peekTopic, setPeekTopic] = useState('');
  const [peekSub, setPeekSub] = useState('');
  const [subs, setSubs] = useState<{ name: string }[] | null>(null);
  const [maxMessages, setMaxMessages] = useState('10');
  const [peeking, setPeeking] = useState(false);
  const [messages, setMessages] = useState<PeekedMessage[] | null>(null);
  const [peekError, setPeekError] = useState<string | null>(null);

  const sendOptions = sendKind === 'queue' ? queues : topics;

  // Load subscriptions when a topic is picked for peeking.
  useEffect(() => {
    if (peekKind !== 'subscription' || !peekTopic) { setSubs(null); return; }
    let cancelled = false;
    (async () => {
      try {
        const r = await clientFetch(`/api/items/service-bus-namespace?topic=${encodeURIComponent(peekTopic)}&subscriptions=1`);
        const j = await r.json();
        if (!cancelled) setSubs(j.ok ? (j.subscriptions || []) : []);
      } catch { if (!cancelled) setSubs([]); }
    })();
    return () => { cancelled = true; };
  }, [peekKind, peekTopic]);

  const send = useCallback(async () => {
    const target = sendTarget.trim();
    if (!target) { setSendMsg({ intent: 'error', text: `Select a ${sendKind} first.` }); return; }
    const raw = body.trim();
    if (!raw) { setSendMsg({ intent: 'error', text: 'Message body is required.' }); return; }
    let payload: unknown = raw;
    try { payload = JSON.parse(raw); } catch { /* send verbatim string */ }
    setSending(true); setSendMsg(null);
    try {
      const r = await clientFetch('/api/items/service-bus-namespace/data-explorer', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op: 'send', entity: target, body: payload, label: label.trim() || undefined, sessionId: sessionId.trim() || undefined }),
      });
      const j = await r.json();
      if (!j.ok) { setSendMsg({ intent: 'error', text: j.error || `send failed (${r.status})` }); return; }
      setSendMsg({ intent: 'success', text: `Sent message to ${sendKind} "${target}" (HTTP ${j.status}).` });
    } catch (e: any) { setSendMsg({ intent: 'error', text: e?.message || String(e) }); }
    finally { setSending(false); }
  }, [sendKind, sendTarget, body, label, sessionId]);

  const peek = useCallback(async () => {
    setPeeking(true); setPeekError(null); setMessages(null);
    const payload: any = { op: 'peek', max: Number(maxMessages) || 10 };
    if (peekKind === 'queue') {
      if (!peekQueue) { setPeekError('Select a queue first.'); setPeeking(false); return; }
      payload.queue = peekQueue;
    } else {
      if (!peekTopic || !peekSub) { setPeekError('Select a topic and subscription first.'); setPeeking(false); return; }
      payload.topic = peekTopic; payload.subscription = peekSub;
    }
    try {
      const r = await clientFetch('/api/items/service-bus-namespace/data-explorer', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
      });
      const j = await r.json();
      if (!j.ok) { setPeekError(j.error || `peek failed (${r.status})`); return; }
      setMessages(Array.isArray(j.messages) ? j.messages : []);
    } catch (e: any) { setPeekError(e?.message || String(e)); }
    finally { setPeeking(false); }
  }, [peekKind, peekQueue, peekTopic, peekSub, maxMessages]);

  if (queues.length === 0 && topics.length === 0) {
    return (
      <MessageBar intent="info">
        <MessageBarBody>No queues or topics yet. Create one on the <strong>Queues</strong> or <strong>Topics</strong> tab before sending or peeking messages.</MessageBarBody>
      </MessageBar>
    );
  }

  return (
    <div className={s.root}>
      <div className={s.head}><Badge appearance="filled" color="brand">Service Bus Explorer</Badge></div>

      {/* SEND */}
      <div className={s.panel}>
        <div className={s.head}><Send20Regular /><Subtitle2>Send message</Subtitle2></div>
        <Caption1>Sends a test message to the real Service Bus runtime over HTTPS (Entra auth). A JSON body is sent as application/json; anything else as text/plain.</Caption1>
        <div className={s.inline}>
          <RadioGroup layout="horizontal" value={sendKind} onChange={(_, d) => { setSendKind(d.value as 'queue' | 'topic'); setSendTarget(''); }}>
            <Radio value="queue" label="Queue" disabled={queues.length === 0} />
            <Radio value="topic" label="Topic" disabled={topics.length === 0} />
          </RadioGroup>
          <Field label={sendKind === 'queue' ? 'Queue' : 'Topic'} className={s.narrow}>
            <Dropdown value={sendTarget} selectedOptions={[sendTarget]} onOptionSelect={(_, d) => setSendTarget((d.optionValue as string) || '')} placeholder={`Select a ${sendKind}`}>
              {sendOptions.map((o) => <Option key={o.name} value={o.name} text={o.name}>{o.name}</Option>)}
            </Dropdown>
          </Field>
        </div>
        <Field label="Message body">
          <Textarea value={body} onChange={(_, d) => setBody(d.value)} resize="vertical" rows={5} />
        </Field>
        <div className={s.row}>
          <Field label="Label / Subject (optional)" className={s.narrow}><Input value={label} onChange={(_, d) => setLabel(d.value)} placeholder="orders" /></Field>
          <Field label="Session ID (optional)" hint="Required for session-enabled entities" className={s.narrow}><Input value={sessionId} onChange={(_, d) => setSessionId(d.value)} /></Field>
          <Button appearance="primary" icon={<Send20Regular />} disabled={sending || !sendTarget} onClick={send}>{sending ? 'Sending…' : 'Send message'}</Button>
        </div>
        {sendMsg && <MessageBar intent={sendMsg.intent}><MessageBarBody>{sendMsg.text}</MessageBarBody></MessageBar>}
      </div>

      {/* PEEK */}
      <div className={s.panel}>
        <div className={s.head}><Eye20Regular /><Subtitle2>Peek messages</Subtitle2></div>
        <Caption1>Non-destructive peek (peek-lock + unlock) — recent messages are read without being consumed or dead-lettered.</Caption1>
        <div className={s.inline}>
          <RadioGroup layout="horizontal" value={peekKind} onChange={(_, d) => { setPeekKind(d.value as 'queue' | 'subscription'); setMessages(null); }}>
            <Radio value="queue" label="Queue" disabled={queues.length === 0} />
            <Radio value="subscription" label="Subscription" disabled={topics.length === 0} />
          </RadioGroup>
          {peekKind === 'queue' ? (
            <Field label="Queue" className={s.narrow}>
              <Dropdown value={peekQueue} selectedOptions={[peekQueue]} onOptionSelect={(_, d) => setPeekQueue((d.optionValue as string) || '')} placeholder="Select a queue">
                {queues.map((q) => <Option key={q.name} value={q.name} text={q.name}>{q.name}</Option>)}
              </Dropdown>
            </Field>
          ) : (
            <>
              <Field label="Topic" className={s.narrow}>
                <Dropdown value={peekTopic} selectedOptions={[peekTopic]} onOptionSelect={(_, d) => { setPeekTopic((d.optionValue as string) || ''); setPeekSub(''); }} placeholder="Select a topic">
                  {topics.map((t) => <Option key={t.name} value={t.name} text={t.name}>{t.name}</Option>)}
                </Dropdown>
              </Field>
              <Field label="Subscription" className={s.narrow}>
                <Dropdown value={peekSub} selectedOptions={[peekSub]} onOptionSelect={(_, d) => setPeekSub((d.optionValue as string) || '')} placeholder={subs === null ? 'Pick a topic first' : 'Select a subscription'} disabled={!peekTopic}>
                  {(subs || []).map((sub) => <Option key={sub.name} value={sub.name} text={sub.name}>{sub.name}</Option>)}
                </Dropdown>
              </Field>
            </>
          )}
          <Field label="Max messages" className={s.narrow}><Input type="number" value={maxMessages} onChange={(_, d) => setMaxMessages(d.value)} /></Field>
          <Button appearance="outline" icon={<Eye20Regular />} disabled={peeking} onClick={peek}>{peeking ? 'Peeking…' : 'Peek'}</Button>
        </div>

        {peeking && <Spinner size="tiny" label="Peeking messages…" />}
        {peekError && <MessageBar intent="error"><MessageBarBody>{peekError}</MessageBarBody></MessageBar>}
        {messages && messages.length === 0 && <MessageBar intent="info"><MessageBarBody>No messages available to peek in this entity.</MessageBarBody></MessageBar>}
        {messages && messages.length > 0 && (
          <div className={s.tableWrap}>
            <Table aria-label="Peeked messages" size="small">
              <TableHeader><TableRow>
                <TableHeaderCell>Seq #</TableHeaderCell>
                <TableHeaderCell>Message ID</TableHeaderCell>
                <TableHeaderCell>Label</TableHeaderCell>
                <TableHeaderCell>Enqueued</TableHeaderCell>
                <TableHeaderCell>Body</TableHeaderCell>
              </TableRow></TableHeader>
              <TableBody>
                {messages.map((m, i) => (
                  <TableRow key={`${m.sequenceNumber ?? m.messageId ?? i}`}>
                    <TableCell>{m.sequenceNumber ?? '—'}</TableCell>
                    <TableCell className={s.mono}>{m.messageId || '—'}</TableCell>
                    <TableCell>{m.label || '—'}</TableCell>
                    <TableCell>{m.enqueuedTime ? new Date(m.enqueuedTime).toLocaleString() : '—'}</TableCell>
                    <TableCell className={s.mono}>{bodyPreview(m.body)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        {!messages && !peeking && !peekError && <Body1 className={s.mono}>Click <strong>Peek</strong> to read recent messages.</Body1>}
      </div>
    </div>
  );
}
