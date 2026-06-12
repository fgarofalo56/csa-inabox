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
import { usePathname } from 'next/navigation';
import {
  Button, Input, makeStyles, tokens,
  Caption1, Subtitle2, Badge, Divider, Tooltip,
} from '@fluentui/react-components';
import {
  Send24Regular, Sparkle24Regular, Dismiss20Regular,
  ArrowReset20Regular, Open20Regular, Dismiss12Regular,
  BookQuestionMark16Regular,
} from '@fluentui/react-icons';
import { HelpEmptyState } from './empty-state';
import {
  MessageList, AoaiGateBar, SearchDegradedBar,
  type ChatMsg, type HelpStep,
} from './messages';
import type { Citation } from './citations';
import { CopilotDiff, type ProposedChange } from '../copilot-diff';
import { applyChange } from '@/lib/copilot/apply-change';
import { receiptScopeFromTutorialId } from './tutorial-scope';

const EVT_OPEN = 'csaloom:open-copilot';
const EVT_TOGGLE = 'csaloom:toggle-copilot';
/** Dispatched by the tutorial stepper (item-side-panel LearnPane) to tell the
 *  widget which step the user wants help with. detail: TutorialStepDetail. */
const EVT_TUTORIAL_STEP = 'csaloom:tutorial-step';

export interface TutorialStepDetail {
  id: string;
  stepIndex: number;
  stepTitle?: string;
  stepBody?: string;
  totalSteps?: number;
}

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
  title: { display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0 },
  titleText: {
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  headerActions: { display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0 },
  headerDivider: { flexShrink: 0, height: 20 },
  // Tutorial context strip — shows the active step the next ask attaches to,
  // and lets the user clear it without resetting the whole conversation.
  tutorialStrip: {
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '6px 12px',
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorPaletteGreenBackground1,
    color: tokens.colorNeutralForeground2,
  },
  tutorialIcon: { color: tokens.colorPaletteGreenForeground1, flexShrink: 0 },
  tutorialLabel: {
    flex: 1, minWidth: 0,
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  body: {
    flex: 1, overflowY: 'auto', padding: 12,
    display: 'flex', flexDirection: 'column', gap: 8,
  },
  composer: {
    padding: 10,
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    display: 'flex', gap: 6, alignItems: 'flex-end',
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

/** Derive a friendly page label + (when on an item) its type/id from the route,
 *  so the agent is aware of what the user is looking at. */
function pageContextFromPath(pathname: string | null): { path: string; label: string; itemType?: string; itemId?: string; workspaceId?: string } {
  const path = pathname || '/';
  const seg = path.split('/').filter(Boolean);
  // /workspaces/:wsId/items/:itemType/:itemId  OR  /items/:itemType/:itemId
  const itemsIdx = seg.indexOf('items');
  let itemType: string | undefined;
  let itemId: string | undefined;
  if (itemsIdx >= 0 && seg[itemsIdx + 1]) { itemType = seg[itemsIdx + 1]; itemId = seg[itemsIdx + 2]; }
  // workspaceId when the route is /workspaces/:wsId/...
  const wsIdx = seg.indexOf('workspaces');
  const workspaceId = wsIdx >= 0 && seg[wsIdx + 1] && seg[wsIdx + 1] !== 'items' ? seg[wsIdx + 1] : undefined;

  const LABELS: Record<string, string> = {
    '': 'Home', browse: 'Browse', workspaces: 'Workspaces', copilot: 'Loom Copilot',
    governance: 'Governance', monitor: 'Monitor', admin: 'Admin portal', marketplace: 'Apps marketplace',
  };
  let label: string;
  if (itemType) {
    label = `${itemType.replace(/-/g, ' ')} editor`;
  } else if (seg[0] === 'admin' && seg[1]) {
    label = `Admin · ${seg[1].replace(/-/g, ' ')}`;
  } else if (seg[0] === 'governance' && seg[1]) {
    label = `Governance · ${seg[1].replace(/-/g, ' ')}`;
  } else {
    label = LABELS[seg[0] || ''] || (seg[0] ? seg[0].replace(/-/g, ' ') : 'Home');
  }
  return { path, label, itemType, itemId, workspaceId };
}

export function HelpCopilotWidget() {
  const s = useStyles();
  const pathname = usePathname();
  const pageCtx = useMemo(() => pageContextFromPath(pathname), [pathname]);
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [gateError, setGateError] = useState<string | null>(null);
  const [searchBackend, setSearchBackend] = useState<'ai-search' | 'cosmos' | 'unknown'>('unknown');
  const [tutorial, setTutorial] = useState<TutorialStepDetail | null>(null);
  const [pendingFix, setPendingFix] = useState<ProposedChange | null>(null);
  const sessionRef = useRef<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const o = () => setOpen(true);
    const t = () => setOpen((x) => !x);
    const k = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === '/') { e.preventDefault(); t(); }
    };
    // Tutorial stepper → seed step context + open the widget. The next send()
    // attaches this tutorial step to the request context.
    const step = (e: Event) => {
      const detail = (e as CustomEvent<TutorialStepDetail>).detail;
      if (detail && detail.id) {
        setTutorial(detail);
        setOpen(true);
      }
    };
    window.addEventListener(EVT_OPEN, o);
    window.addEventListener(EVT_TOGGLE, t);
    window.addEventListener(EVT_TUTORIAL_STEP, step as EventListener);
    window.addEventListener('keydown', k);
    return () => {
      window.removeEventListener(EVT_OPEN, o);
      window.removeEventListener(EVT_TOGGLE, t);
      window.removeEventListener(EVT_TUTORIAL_STEP, step as EventListener);
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
    setTutorial(null);
    setPendingFix(null);
  }

  /** Keep: apply the approved edit to the open editor via the bridge registry.
   *  If the editor has since closed (no bridge), say so honestly rather than
   *  pretending the change applied. */
  function keepFix(change: ProposedChange) {
    const applied = applyChange(change.target, change.after);
    setPendingFix(null);
    setMsgs((m) => [
      ...m,
      {
        who: 'system',
        text: applied
          ? `Applied the fix to ${change.target}.`
          : `Could not apply — the editor for ${change.target} is no longer open. Re-open it and ask again.`,
      },
    ]);
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
        body: JSON.stringify({
          prompt,
          sessionId: sessionRef.current ?? undefined,
          context: {
            ...pageCtx,
            tutorial: tutorial ?? undefined,
            // Receipt scope priority: the route-bound open item, else the item
            // encoded in the active editor tutorial's id. Either way the agent's
            // readReceipts tool resolves to a concrete item for auto-error
            // detection; absent both, it honestly reports "No item in context".
            receiptScope: pageCtx.itemId
              ? { itemId: pageCtx.itemId, itemType: pageCtx.itemType, workspaceId: pageCtx.workspaceId }
              : receiptScopeFromTutorialId(tutorial?.id),
          },
        }),
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
                if (step.kind === 'proposed_change') {
                  // Open the approval-gated Keep/Undo diff. Mutation happens ONLY
                  // on Keep (handled below); never here.
                  setPendingFix({
                    target: step.target,
                    before: step.before,
                    after: step.after,
                    lang: step.lang,
                    summary: step.summary,
                    callId: step.callId,
                  });
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
    <>
    <aside className={s.panel} aria-label="CSA Loom Help Copilot" role="dialog" data-testid="help-copilot-widget">
      <div className={s.header}>
        <div className={s.title}>
          <Sparkle24Regular style={{ color: tokens.colorBrandForeground1, flexShrink: 0 }} />
          <Subtitle2 className={s.titleText}>Loom Copilot</Subtitle2>
          <Badge appearance="tint" size="small" color="brand"
            title={`Aware you're on: ${pageCtx.label} (${pageCtx.path})`}>
            on: {pageCtx.label}
          </Badge>
        </div>
        <div className={s.headerActions}>
          <Tooltip content="New conversation" relationship="label" withArrow>
            <Button appearance="subtle" size="small" icon={<ArrowReset20Regular />}
              onClick={reset} aria-label="New conversation" disabled={busy} />
          </Tooltip>
          <Tooltip content="Open full Loom Copilot (cross-item orchestrator)" relationship="label" withArrow>
            <Button appearance="subtle" size="small" icon={<Open20Regular />}
              as="a" href="/copilot" target="_self" aria-label="Open full Loom Copilot" />
          </Tooltip>
          <Divider vertical className={s.headerDivider} />
          <Tooltip content="Close" relationship="label" withArrow>
            <Button appearance="subtle" size="small" icon={<Dismiss20Regular />}
              onClick={() => setOpen(false)} aria-label="Close Help Copilot" />
          </Tooltip>
        </div>
      </div>

      {tutorial && (
        <div className={s.tutorialStrip} data-testid="help-tutorial-strip">
          <BookQuestionMark16Regular className={s.tutorialIcon} />
          <Caption1 className={s.tutorialLabel}
            title={tutorial.stepTitle ? `Step: ${tutorial.stepTitle}` : tutorial.id}>
            Helping with step {tutorial.stepIndex + 1}{tutorial.totalSteps ? ` of ${tutorial.totalSteps}` : ''}
            {tutorial.stepTitle ? ` — ${tutorial.stepTitle}` : ''}
          </Caption1>
          <Badge appearance="tint" size="small" color="success" data-testid="help-tutorial-badge">
            step {tutorial.stepIndex + 1}{tutorial.totalSteps ? `/${tutorial.totalSteps}` : ''}
          </Badge>
          <Tooltip content="Stop using this tutorial step as context" relationship="label" withArrow>
            <Button appearance="subtle" size="small" icon={<Dismiss12Regular />}
              onClick={() => setTutorial(null)} aria-label="Clear tutorial step context"
              data-testid="help-tutorial-clear" />
          </Tooltip>
        </div>
      )}

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
          placeholder={busy ? 'Thinking…' : `Ask about ${pageCtx.label} or anything in Loom…`}
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
    {/* Approval-gated fix diff — mutates the open editor ONLY on Keep. */}
    <CopilotDiff change={pendingFix} onKeep={keepFix} onUndo={() => setPendingFix(null)} />
    </>
  );
}
