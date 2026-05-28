'use client';

/**
 * HelpCopilotWidget — floating chat widget mounted at the app shell.
 *
 * Replaces the previous "Copilot pane (not setup)" message. Toggled by:
 *   - top-right Sparkle button (fires `csaloom:open-copilot` event)
 *   - Ctrl/Cmd + / keyboard shortcut
 *
 * The deep cross-item orchestrator at /copilot is kept as-is; this
 * widget hands off to it when the user asks for an ACT.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Button, Input, makeStyles, tokens,
  Caption1, Subtitle2,
} from '@fluentui/react-components';
import {
  Send24Regular, Sparkle24Regular, Dismiss20Regular,
  ArrowReset20Regular, Open20Regular,
} from '@fluentui/react-icons';
import { HelpEmptyState } from './empty-state';
import {
  MessageList, AoaiGateBar, SearchDegradedBar,
  type ChatMsg, type HelpStep,
} from './messages';
import type { Citation } from './citations';

const EVT_OPEN = 'csaloom:open-copilot';
const EVT_TOGGLE = 'csaloom:toggle-copilot';

export function openHelpCopilot() {
  window.dispatchEvent(new Event(EVT_OPEN));
}
export function toggleHelpCopilot() {
  window.dispatchEvent(new Event(EVT_TOGGLE));
}

const useStyles = makeStyles({
  panel: {
    position: 'fixed', right: 16, bottom: 16,
    width: 420, height: 'min(640px, calc(100vh - 96px))',
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: 16,
    boxShadow: '-8px 8px 32px rgba(0,0,0,0.18)',
    display: 'flex', flexDirection: 'column', zIndex: 1100,
    overflow: 'hidden',
  },
  header: {
    padding: '10px 12px',
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    display: 'flex', alignItems: 'center', gap: 8,
    background: 'linear-gradient(90deg, rgba(125,108,255,0.16), rgba(89,165,255,0.08))',
  },
  title: { display: 'flex', alignItems: 'center', gap: 8, flex: 1 },
  body: {
    flex: 1, overflowY: 'auto', padding: 12,
    display: 'flex', flexDirection: 'column', gap: 8,
  },
  composer: {
    padding: 10,
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    display: 'flex', gap: 6,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  hintRow: {
    padding: '4px 12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    fontSize: 11, color: tokens.colorNeutralForeground3,
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
  },
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

export function HelpCopilotWidget() {
  const s = useStyles();
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [gateError, setGateError] = useState<string | null>(null);
  const [searchBackend, setSearchBackend] = useState<'ai-search' | 'cosmos' | 'unknown'>('unknown');
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

  // Probe the search backend on first open so we can show the degraded bar.
  useEffect(() => {
    if (!open || searchBackend !== 'unknown') return;
    fetch('/api/help-copilot/reindex')
      .then((r) => r.ok ? r.json() : null)
      .then((j) => {
        if (j?.backend === 'ai-search' || j?.backend === 'cosmos') setSearchBackend(j.backend);
      })
      .catch(() => { /* ignore */ });
  }, [open, searchBackend]);

  function reset() {
    setMsgs([]);
    sessionRef.current = null;
    setGateError(null);
  }

  async function send(text: string) {
    const prompt = text.trim();
    if (!prompt || busy) return;
    setDraft('');
    setGateError(null);
    setBusy(true);
    setMsgs((m) => [
      ...m,
      { who: 'you', text: prompt },
      { who: 'copilot', text: '', steps: [], streaming: true },
    ]);

    // Track the streaming citation accumulator separately so we can
    // attach the dedupe'd list to the message when 'final' arrives.
    const liveCitations: Citation[] = [];

    try {
      const res = await fetch('/api/help-copilot/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt, sessionId: sessionRef.current ?? undefined }),
      });

      if (res.status === 503) {
        const j = await res.json().catch(() => ({ error: 'AOAI not wired' }));
        setGateError(j.error || 'AOAI deployment not wired');
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
              const step = JSON.parse(ev.data) as HelpStep;
              setMsgs((m) => m.map((x) => {
                if (!x.streaming) return x;
                if (step.kind === 'final') {
                  // Frontend tool: openLoomPage navigation honored here too
                  return { ...x, text: step.content, streaming: false, citations: liveCitations.slice() };
                }
                if (step.kind === 'error') {
                  return { ...x, text: `Error: ${step.error}`, streaming: false };
                }
                if (step.kind === 'citation') {
                  for (const c of step.citations) {
                    if (!liveCitations.find((existing) => existing.id === c.id)) {
                      liveCitations.push(c);
                    }
                  }
                  return { ...x, citations: liveCitations.slice() };
                }
                if (step.kind === 'handoff') {
                  return { ...x, handoff: { reason: step.reason, deepLink: step.deepLink, suggestedPrompt: step.suggestedPrompt } };
                }
                if (step.kind === 'tool_result' && step.name === 'openLoomPage') {
                  const r = step.result as { ok?: boolean; slug?: string } | undefined;
                  if (r?.ok && r.slug && typeof window !== 'undefined') {
                    // Defer navigation until after the final message renders so
                    // the user actually sees the answer.
                    setTimeout(() => { window.location.href = r.slug!; }, 800);
                  }
                }
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

  const isEmpty = useMemo(() => msgs.length === 0, [msgs]);

  if (!open) return null;

  return (
    <aside className={s.panel} aria-label="CSA Loom Help Copilot" role="dialog" data-testid="help-copilot-widget">
      <div className={s.header}>
        <div className={s.title}>
          <Sparkle24Regular style={{ color: tokens.colorBrandForeground1 }} />
          <Subtitle2>Help Copilot</Subtitle2>
          <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>· docs-grounded</Caption1>
        </div>
        <Button appearance="subtle" size="small" icon={<ArrowReset20Regular />}
          onClick={reset} aria-label="New conversation" disabled={busy} title="New conversation" />
        <Button appearance="subtle" size="small" icon={<Open20Regular />}
          as="a" href="/copilot" target="_self" aria-label="Open full Loom Copilot"
          title="Open full Loom Copilot (cross-item orchestrator)" />
        <Button appearance="subtle" size="small" icon={<Dismiss20Regular />}
          onClick={() => setOpen(false)} aria-label="Close Help Copilot" />
      </div>

      <div className={s.body} ref={bodyRef}>
        {gateError && <AoaiGateBar message={gateError} />}
        {searchBackend === 'cosmos' && <SearchDegradedBar />}
        {isEmpty && !gateError && <HelpEmptyState onPick={send} />}
        <MessageList messages={msgs} />
      </div>

      <div className={s.composer}>
        <Input
          style={{ flex: 1 }}
          value={draft}
          onChange={(_, d) => setDraft(d.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !busy) send(draft); }}
          placeholder={busy ? 'Thinking…' : 'Ask about CSA Loom…'}
          disabled={busy}
          aria-label="Ask the Help Copilot"
          data-testid="help-input"
        />
        <Button appearance="primary" icon={<Send24Regular />} onClick={() => send(draft)}
          disabled={busy || !draft.trim()} aria-label="Send" data-testid="help-send" />
      </div>

      <div className={s.hintRow}>
        <span>Ctrl + / to toggle</span>
        <span>Answers from docs + repo</span>
      </div>
    </aside>
  );
}
