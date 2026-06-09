'use client';

/**
 * CopilotPane — collapsible right rail wired to the real
 * `/api/copilot/orchestrate` SSE endpoint backed by Foundry-resolved
 * Azure OpenAI. Streams assistant tokens + tool-call steps live; surfaces
 * a Fluent MessageBar with the AOAI-deep-link CTA when the BFF returns
 * 503 (no deployment wired) per the no-vaporware contract.
 */

import { useEffect, useRef, useState } from 'react';
import {
  Button, Input, MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens, Caption1, Body1, Subtitle2, Spinner,
} from '@fluentui/react-components';
import { Send24Regular, Sparkle24Regular, Dismiss20Regular } from '@fluentui/react-icons';
import { LoomDataTable, type LoomColumn } from './ui/loom-data-table';

/**
 * Render a tabular_* tool result ({ columns, rows }) as a real LoomDataTable
 * (T7) so a notebook / DAX Copilot answer shows the model's measures, tables,
 * or DAX values as a sortable/filterable grid — not a raw JSON blob.
 */
function TabularResult({ result }: { result: unknown }): JSX.Element | null {
  const r = result as { columns?: unknown; rows?: unknown } | null;
  const columns = Array.isArray(r?.columns) ? (r!.columns as string[]) : null;
  const rawRows = Array.isArray(r?.rows) ? (r!.rows as Record<string, unknown>[]) : null;
  if (!columns || !rawRows || columns.length === 0) return null;
  // Inject a stable per-row id (results can contain duplicate rows).
  const rows = rawRows.map((row, i) => ({ ...row, __rid: String(i) }));
  const cols: LoomColumn<Record<string, unknown>>[] = columns.map((c) => ({
    key: c,
    label: c,
    render: (row) => String(row[c] ?? ''),
  }));
  return (
    <div style={{ marginTop: 6, maxHeight: 320, overflow: 'auto' }}>
      <LoomDataTable<Record<string, unknown>>
        columns={cols}
        rows={rows}
        getRowId={(row) => String(row.__rid)}
        noFilters
        ariaLabel="Tabular result"
        empty="No rows."
      />
    </div>
  );
}

interface CopilotUsage { promptTokens: number; completionTokens: number; totalTokens: number; aoaiCalls: number; toolCalls: number; }

type Step =
  | { kind: 'thought'; content: string }
  | { kind: 'tool_call'; name: string; callId: string }
  | { kind: 'tool_result'; name: string; callId: string; durationMs: number; result?: unknown; error?: string }
  | { kind: 'final'; content: string; usage?: CopilotUsage; model?: string }
  | { kind: 'error'; error: string };

interface Msg {
  who: 'you' | 'copilot' | 'system';
  text: string;
  steps?: Step[];
  streaming?: boolean;
  usage?: CopilotUsage;
  model?: string;
}

const SEED: Msg[] = [
  { who: 'copilot', text: 'Hi! I can help you build pipelines, write KQL or T-SQL, summarize a report, or set up an Activator rule. What are we working on?' },
];

const EVT_OPEN = 'csaloom:open-copilot';
const EVT_TOGGLE = 'csaloom:toggle-copilot';

export function openCopilot() {
  window.dispatchEvent(new Event(EVT_OPEN));
}
export function toggleCopilot() {
  window.dispatchEvent(new Event(EVT_TOGGLE));
}

const useStyles = makeStyles({
  panel: {
    position: 'fixed', right: 0, top: 'var(--loom-topbar-height)', bottom: 0,
    width: 420,
    backgroundColor: tokens.colorNeutralBackground1,
    borderLeft: `1px solid ${tokens.colorNeutralStroke2}`,
    boxShadow: '-8px 0 24px rgba(0,0,0,0.10)',
    display: 'flex', flexDirection: 'column', zIndex: 1000,
  },
  header: {
    padding: 12, borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    display: 'flex', alignItems: 'center', gap: 8,
    background: 'linear-gradient(90deg, rgba(125,108,255,0.10), transparent)',
  },
  body: { flex: 1, overflowY: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 8 },
  msg: { padding: '10px 14px', borderRadius: 14, maxWidth: '92%' },
  msgCopilot: { backgroundColor: tokens.colorNeutralBackground2, alignSelf: 'flex-start', borderTopLeftRadius: 4 },
  msgYou: { backgroundColor: tokens.colorBrandBackground2, alignSelf: 'flex-end', borderTopRightRadius: 4 },
  msgSystem: { backgroundColor: tokens.colorNeutralBackground3, alignSelf: 'stretch' },
  stepRow: {
    display: 'flex', alignItems: 'center', gap: 6,
    color: tokens.colorNeutralForeground3, fontSize: 12,
    paddingLeft: 4, marginTop: 4,
  },
  composer: { padding: 12, borderTop: `1px solid ${tokens.colorNeutralStroke2}`, display: 'flex', gap: 8 },
});

function parseSse(buffer: string): { events: Array<{ event: string; data: string }>; remaining: string } {
  const out: Array<{ event: string; data: string }> = [];
  const blocks = buffer.split(/\n\n/);
  const remaining = blocks.pop() ?? '';
  for (const block of blocks) {
    let event = 'message';
    let data = '';
    for (const line of block.split(/\n/)) {
      if (line.startsWith('event: ')) event = line.slice(7).trim();
      else if (line.startsWith('data: ')) data += (data ? '\n' : '') + line.slice(6);
    }
    if (data) out.push({ event, data });
  }
  return { events: out, remaining };
}

export function CopilotPane() {
  const s = useStyles();
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>(SEED);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [gateError, setGateError] = useState<string | null>(null);
  const sessionRef = useRef<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const o = () => setOpen(true);
    const t = () => setOpen((x) => !x);
    const k = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === '/') { e.preventDefault(); t(); }
    };
    window.addEventListener(EVT_OPEN, o);
    window.addEventListener(EVT_TOGGLE, t);
    window.addEventListener('keydown', k);
    return () => {
      window.removeEventListener(EVT_OPEN, o);
      window.removeEventListener(EVT_TOGGLE, t);
      window.removeEventListener('keydown', k);
    };
  }, []);

  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [msgs]);

  async function send() {
    const text = draft.trim();
    if (!text || busy) return;
    setDraft('');
    setGateError(null);
    setBusy(true);
    setMsgs((m) => [...m, { who: 'you', text }, { who: 'copilot', text: '', steps: [], streaming: true }]);

    try {
      const res = await fetch('/api/copilot/orchestrate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: text, sessionId: sessionRef.current ?? undefined }),
      });

      if (res.status === 503) {
        const j = await res.json().catch(() => ({ error: 'Copilot AOAI not wired' }));
        setGateError(j.error || 'Copilot AOAI deployment not wired');
        setMsgs((m) => m.filter((x) => !x.streaming));
        return;
      }
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        setMsgs((m) => m.map((x) => x.streaming ? { ...x, text: `Error: ${j.error || res.statusText}`, streaming: false } : x));
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const { events, remaining } = parseSse(buffer);
        buffer = remaining;

        for (const ev of events) {
          if (ev.event === 'session') {
            try {
              const data = JSON.parse(ev.data);
              if (data.sessionId) sessionRef.current = data.sessionId;
            } catch {}
          } else if (ev.event === 'step') {
            try {
              const step = JSON.parse(ev.data) as Step;
              setMsgs((m) => m.map((x) => {
                if (!x.streaming) return x;
                if (step.kind === 'final') return { ...x, text: step.content, streaming: false, usage: step.usage, model: step.model };
                if (step.kind === 'error') return { ...x, text: `Error: ${step.error}`, streaming: false };
                return { ...x, steps: [...(x.steps ?? []), step] };
              }));
            } catch {}
          } else if (ev.event === 'done') {
            setMsgs((m) => m.map((x) => x.streaming ? { ...x, streaming: false } : x));
          }
        }
      }
    } catch (e: any) {
      setMsgs((m) => m.map((x) => x.streaming ? { ...x, text: `Network error: ${e?.message || e}`, streaming: false } : x));
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;

  return (
    <aside className={s.panel} aria-label="Copilot">
      <div className={s.header}>
        <Sparkle24Regular style={{ color: tokens.colorBrandForeground1 }} />
        <Subtitle2>Copilot</Subtitle2>
        <Caption1 style={{ color: tokens.colorNeutralForeground3, marginLeft: 'auto' }}>Ctrl + /</Caption1>
        <Button appearance="subtle" icon={<Dismiss20Regular />} onClick={() => setOpen(false)} aria-label="Close Copilot" />
      </div>
      <div className={s.body} ref={bodyRef}>
        {gateError && (
          <MessageBar intent="warning">
            <MessageBarBody>
              <MessageBarTitle>Copilot AOAI deployment not wired</MessageBarTitle>
              {gateError} — set up the AI Foundry hub + a chat-completions deployment.
              Open the AI Foundry editor and click <strong>Deployments → New</strong>.
            </MessageBarBody>
          </MessageBar>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={`${s.msg} ${m.who === 'copilot' ? s.msgCopilot : m.who === 'you' ? s.msgYou : s.msgSystem}`}>
            {m.text && <Body1 style={{ whiteSpace: 'pre-wrap' }}>{m.text}</Body1>}
            {m.steps?.map((step, j) => {
              if (step.kind === 'tool_call') {
                return <div key={j} className={s.stepRow}>↪ calling <strong>{step.name}</strong>…</div>;
              }
              if (step.kind === 'tool_result') {
                return (
                  <div key={j} className={s.stepRow}>
                    {step.error ? '⚠' : '✓'} {step.name} <span>({step.durationMs}ms)</span>
                    {step.error && <span style={{ color: tokens.colorPaletteRedForeground1 }}> — {step.error}</span>}
                    {!step.error && step.name.startsWith('tabular_') && <TabularResult result={step.result} />}
                  </div>
                );
              }
              if (step.kind === 'thought') {
                return <div key={j} className={s.stepRow}>💭 {step.content.slice(0, 120)}</div>;
              }
              return null;
            })}
            {m.streaming && !m.text && (
              <div className={s.stepRow}><Spinner size="extra-tiny" /> Thinking…</div>
            )}
            {m.who === 'copilot' && !m.streaming && m.usage && (
              <Caption1 className={s.stepRow} style={{ color: tokens.colorNeutralForeground3 }}>
                {m.usage.toolCalls > 0 ? `${m.usage.toolCalls} tool${m.usage.toolCalls === 1 ? '' : 's'} · ` : ''}
                {m.usage.totalTokens.toLocaleString()} tokens
                {m.usage.aoaiCalls > 1 ? ` · ${m.usage.aoaiCalls} turns` : ''}
                {m.model ? ` · ${m.model}` : ''}
              </Caption1>
            )}
          </div>
        ))}
      </div>
      <div className={s.composer}>
        <Input
          style={{ flex: 1 }}
          value={draft}
          onChange={(_, d) => setDraft(d.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !busy) send(); }}
          placeholder={busy ? 'Working…' : 'Ask Copilot…'}
          disabled={busy}
          aria-label="Message Copilot"
        />
        <Button appearance="primary" icon={<Send24Regular />} onClick={send} disabled={busy} aria-label="Send message" />
      </div>
    </aside>
  );
}
