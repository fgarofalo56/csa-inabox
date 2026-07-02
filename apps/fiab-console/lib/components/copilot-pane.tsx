'use client';

/**
 * CopilotPane — THE one Loom Copilot chat window (audit-t155).
 *
 * Historically the app shell mounted TWO chat surfaces (this right rail + a
 * floating Help Copilot widget) that both listened to `csaloom:open-copilot`
 * and Ctrl+/, so the topbar Sparkle opened two popups at once. This pane is
 * now the SINGLE window behind the single launcher: it owns the only
 * listeners for open/toggle/context/persona/tutorial-step events and streams
 * from `/api/copilot/orchestrate`, whose server-side router
 * (lib/azure/copilot-router.ts) classifies intent per turn — docs/how-to
 * questions go to the docs/help agent (RAG + citations), build/data/ops
 * requests go to the cross-item build agent — and emits an `agent` step this
 * pane renders as an inline ATLAS-style attribution badge (which agent
 * answered + why). A docs-agent `handoff` becomes an in-window "Do it with
 * the build agent" re-ask — never a second popup.
 *
 * Honest gates preserved: 503 AOAI MessageBar with the Foundry CTA, the
 * content-safety gate from /api/copilot/status, and content-safety blocks.
 * Per-message thumbs up/down feedback (PATCH /api/copilot/sessions/[id]),
 * "Clear chat" (DELETE /api/copilot/sessions/[id]), and a History drawer
 * (GET /api/copilot/sessions) are all wired to real Cosmos-backed BFF routes.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';
import { usePathname } from 'next/navigation';
import {
  Button, Input, MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens, Caption1, Body1, Subtitle2, Spinner, Badge,
  OverlayDrawer, DrawerHeader, DrawerHeaderTitle, DrawerBody, Tooltip,
} from '@fluentui/react-components';
import {
  Send24Regular, Sparkle24Regular, Sparkle20Regular, Dismiss20Regular,
  ThumbLike20Regular, ThumbDislike20Regular,
  History20Regular, Delete20Regular, BranchCompare16Regular,
  CheckmarkCircle16Regular, ErrorCircle16Regular, Wrench16Regular,
  Lightbulb16Regular, DocumentEdit16Regular,
} from '@fluentui/react-icons';
import { LoomDataTable, type LoomColumn } from './ui/loom-data-table';
import { CopilotResult } from '@/lib/components/copilot-result';
import { tagResult } from '@/lib/components/copilot-result-tagger';
import { CopilotChips } from '@/lib/components/copilot-chips';
import type { CopilotContext } from '@/lib/azure/copilot-personas';
import { getPanePersona } from '@/lib/azure/copilot-personas';
import { useCopilotContext } from '@/lib/copilot/use-copilot-context';
import { CopilotDiff, type ProposedChange } from './copilot-diff';
import { applyChange } from '@/lib/copilot/apply-change';
import { CitationChips, type Citation } from './help-copilot/citations';
import { receiptScopeFromTutorialId } from './help-copilot/tutorial-scope';

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
  | { kind: 'tool_call'; name: string; callId: string; args?: unknown }
  | { kind: 'tool_result'; name: string; callId: string; durationMs: number; result?: unknown; error?: string }
  | { kind: 'final'; content: string; usage?: CopilotUsage; model?: string }
  | { kind: 'error'; error: string; code?: string }
  | { kind: 'proposed_change'; target: string; before: string; after: string; lang?: string; callId?: string; summary?: string }
  // Unified-router steps: `agent` is the attribution badge (which agent
  // answered + why); `citation`/`handoff` flow through from the docs agent.
  | { kind: 'agent'; agentId: string; agentName: string; reason: string }
  | { kind: 'citation'; citations: Citation[] }
  | { kind: 'handoff'; reason: string; deepLink: string; suggestedPrompt: string };

interface Msg {
  who: 'you' | 'copilot' | 'system';
  text: string;
  steps?: Step[];
  streaming?: boolean;
  usage?: CopilotUsage;
  model?: string;
  /** Index of this (copilot) message in the thread — the feedback key. */
  msgIndex?: number;
  /** ATLAS-style attribution: which agent/persona answered this turn + why. */
  agent?: { agentName: string; reason: string };
  /** Docs-agent source citations rendered as chips below the answer. */
  citations?: Citation[];
  /** Docs-agent "this is an act" handoff → an inline button that re-asks the
   *  build agent with the suggested prompt (stays in this one window). */
  handoff?: { reason: string; suggestedPrompt: string };
}

interface SessionSummary {
  id: string;
  sessionId: string;
  prompt: string;
  createdAt: string;
  updatedAt: string;
  stepCount: number;
}

const SEED: Msg[] = [
  { who: 'copilot', text: 'Hi! Ask me anything — docs and how-to questions route to the Help & docs agent; build, query, and ops requests route to the Build & data agent. Each answer is badged with the agent that handled it. What are we working on?' },
];

const EVT_OPEN = 'csaloom:open-copilot';
const EVT_TOGGLE = 'csaloom:toggle-copilot';
const EVT_CONTEXT = 'csaloom:copilot-context';
const EVT_PERSONA = 'csaloom:copilot-persona';
/** Dispatched by the in-app tutorial stepper (item-side-panel LearnPane) so the
 *  one Copilot window opens on the docs/help agent scoped to the active step. */
const EVT_TUTORIAL_STEP = 'csaloom:tutorial-step';

export interface TutorialStepDetail {
  id: string;
  stepIndex: number;
  stepTitle?: string;
  stepBody?: string;
  totalSteps?: number;
}

export function openCopilot() {
  window.dispatchEvent(new Event(EVT_OPEN));
}
export function toggleCopilot() {
  window.dispatchEvent(new Event(EVT_TOGGLE));
}
/**
 * Editors dispatch their persona + live context (table names, attached
 * lakehouses, defaultLang) so the global Copilot pane can surface
 * context-aware suggested-prompt chips grounded in real symbols.
 */
export function setCopilotContext(ctx: CopilotContext) {
  window.dispatchEvent(new CustomEvent<CopilotContext>(EVT_CONTEXT, { detail: ctx }));
}

/** Detail payload for the persona-open event. */
export interface CopilotPersonaDetail {
  /** Persona id, e.g. 'activator'. */
  persona: string;
  /** Per-surface context injected as a system message (activator id, rule names…). */
  personaContext?: Record<string, unknown>;
  /** Pre-fill the composer with this prompt (the user can edit before sending). */
  prefillPrompt?: string;
}

/**
 * Open the Copilot pane bound to a specific persona (e.g. the Activator
 * Copilot). The next message the user sends carries `persona` +
 * `personaContext` to /api/copilot/orchestrate, which narrows the system
 * prompt + tool set to that persona.
 */
export function openCopilotWithPersona(detail: CopilotPersonaDetail) {
  window.dispatchEvent(new CustomEvent(EVT_PERSONA, { detail }));
}

/** Page/route awareness forwarded to the docs agent (so "what's on this
 *  screen / help me here" answers in context). Mirrors the help widget's
 *  derivation that this window replaces. */
interface HelpPageContext {
  path: string;
  label: string;
  itemType?: string;
  itemId?: string;
  workspaceId?: string;
}

function pageContextFromPath(pathname: string | null): HelpPageContext {
  const path = pathname || '/';
  const seg = path.split('/').filter(Boolean);
  const itemsIdx = seg.indexOf('items');
  let itemType: string | undefined;
  let itemId: string | undefined;
  if (itemsIdx >= 0 && seg[itemsIdx + 1]) { itemType = seg[itemsIdx + 1]; itemId = seg[itemsIdx + 2]; }
  const wsIdx = seg.indexOf('workspaces');
  const workspaceId = wsIdx >= 0 && seg[wsIdx + 1] && seg[wsIdx + 1] !== 'items' ? seg[wsIdx + 1] : undefined;
  const LABELS: Record<string, string> = {
    '': 'Home', browse: 'Browse', workspaces: 'Workspaces', copilot: 'Loom Copilot',
    governance: 'Governance', monitor: 'Monitor', admin: 'Admin portal', marketplace: 'Apps marketplace',
  };
  let label: string;
  if (itemType) label = `${itemType.replace(/-/g, ' ')} editor`;
  else if (seg[0] === 'admin' && seg[1]) label = `Admin · ${seg[1].replace(/-/g, ' ')}`;
  else if (seg[0] === 'governance' && seg[1]) label = `Governance · ${seg[1].replace(/-/g, ' ')}`;
  else label = LABELS[seg[0] || ''] || (seg[0] ? seg[0].replace(/-/g, ' ') : 'Home');
  return { path, label, itemType, itemId, workspaceId };
}

const useStyles = makeStyles({
  panel: {
    position: 'fixed', right: 0, top: 'var(--loom-topbar-height)', bottom: 0,
    width: 'min(420px, 100vw)',
    backgroundColor: tokens.colorNeutralBackground1,
    borderLeft: `1px solid ${tokens.colorNeutralStroke2}`,
    boxShadow: '-8px 0 24px rgba(0,0,0,0.10)',
    display: 'flex', flexDirection: 'column', zIndex: 1000,
  },
  header: {
    padding: tokens.spacingHorizontalM, borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, minWidth: 0,
    background: 'linear-gradient(90deg, rgba(125,108,255,0.10), transparent)',
  },
  headerTitle: {
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0,
  },
  headerHint: { color: tokens.colorNeutralForeground3, marginLeft: 'auto', flexShrink: 0 },
  body: { flex: 1, overflowY: 'auto', padding: tokens.spacingHorizontalM, display: 'flex', flexDirection: 'column', gap: tokens.spacingHorizontalS },
  msg: { padding: '10px 14px', borderRadius: '14px', maxWidth: '92%' },
  msgCopilot: { backgroundColor: tokens.colorNeutralBackground2, alignSelf: 'flex-start', borderTopLeftRadius: '4px' },
  msgYou: { backgroundColor: tokens.colorBrandBackground2, alignSelf: 'flex-end', borderTopRightRadius: '4px' },
  msgSystem: { backgroundColor: tokens.colorNeutralBackground3, alignSelf: 'stretch' },
  stepRow: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalSNudge,
    color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200,
    paddingLeft: tokens.spacingHorizontalXS, marginTop: tokens.spacingVerticalXS,
  },
  stepOk: { color: tokens.colorPaletteGreenForeground1, flexShrink: 0 },
  stepErr: { color: tokens.colorPaletteRedForeground1, flexShrink: 0 },
  stepIcon: { color: tokens.colorNeutralForeground3, flexShrink: 0 },
  feedbackRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, marginTop: tokens.spacingVerticalXS },
  agentBadgeRow: { marginBottom: tokens.spacingVerticalSNudge },
  handoffBox: {
    marginTop: tokens.spacingVerticalS, padding: '8px 10px', borderRadius: '10px',
    border: `1px solid ${tokens.colorBrandStroke2}`,
    backgroundColor: tokens.colorBrandBackground2,
    display: 'flex', flexDirection: 'column', gap: tokens.spacingHorizontalSNudge,
  },
  composer: { padding: tokens.spacingHorizontalM, borderTop: `1px solid ${tokens.colorNeutralStroke2}`, display: 'flex', gap: tokens.spacingHorizontalS },
  historyItem: {
    padding: '10px 8px', borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    cursor: 'pointer', borderRadius: tokens.borderRadiusLarge,
    transition: 'background-color 120ms ease',
    ':hover': { backgroundColor: tokens.colorNeutralBackground2 },
    ':focus-visible': { outline: `2px solid ${tokens.colorBrandStroke1}`, outlineOffset: '-2px' },
  },
  historyEmpty: {
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: tokens.spacingHorizontalS,
    padding: '40px 16px', textAlign: 'center', color: tokens.colorNeutralForeground3,
  },
  chipsBar: { borderTop: `1px solid ${tokens.colorNeutralStroke3}` },
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
  // Per-pane persona (contextSlug → PersonaEntry). The active editor pane
  // registers its slug + payload via registerCopilotContext (use-copilot-context);
  // the pane header reflects the persona title and every orchestrate request
  // carries contextSlug + contextPayload so the server composes the per-pane
  // system prompt + scopes the tool catalog.
  const paneCtx = useCopilotContext();
  const panePersona = useMemo(() => getPanePersona(paneCtx.slug), [paneCtx.slug]);
  const slugRef = useRef<string>(paneCtx.slug);
  // Route awareness forwarded to the docs agent when a turn routes to it.
  const pathname = usePathname();
  const pageCtx = useMemo(() => pageContextFromPath(pathname), [pathname]);
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>(SEED);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [gateError, setGateError] = useState<string | null>(null);
  // Content-safety: blocked-response reason (input or output) + honest-gate
  // when no Content Safety endpoint is configured in this deployment.
  const [safetyBlock, setSafetyBlock] = useState<string | null>(null);
  const [safetyGate, setSafetyGate] = useState<boolean>(false);
  const [ratings, setRatings] = useState<Record<number, 'up' | 'down'>>({});
  const [historyOpen, setHistoryOpen] = useState(false);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [copilotCtx, setCopilotCtx] = useState<CopilotContext>({ persona: 'default' });
  const [pendingChange, setPendingChange] = useState<ProposedChange | null>(null);
  const sessionRef = useRef<string | null>(null);
  const msgIndexRef = useRef(0);
  const bodyRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Active persona binding (set by the EVT_PERSONA event from an editor's
  // "Copilot" button). Carried on every orchestrate request while set.
  const personaRef = useRef<string | null>(null);
  const personaContextRef = useRef<Record<string, unknown> | null>(null);
  // Active tutorial step (set by the item-side-panel LearnPane "help with this
  // step" button). While set, the next turn is forced to the docs/help agent
  // and carries this step's context so the answer targets THIS step.
  const [tutorial, setTutorial] = useState<TutorialStepDetail | null>(null);
  const tutorialRef = useRef<TutorialStepDetail | null>(null);

  useEffect(() => {
    if (!open) return;
    fetch('/api/copilot/status')
      .then((r) => r.json())
      .then((j) => { if (j?.ok && j.contentSafety === false) setSafetyGate(true); })
      .catch(() => {});
  }, [open]);

  useEffect(() => {
    const o = () => setOpen(true);
    const t = () => setOpen((x) => !x);
    const onCtx = (e: Event) => {
      const detail = (e as CustomEvent<CopilotContext>).detail;
      if (detail) setCopilotCtx(detail);
    };
    const p = (e: Event) => {
      const detail = (e as CustomEvent<CopilotPersonaDetail>).detail;
      if (!detail) return;
      personaRef.current = detail.persona || null;
      personaContextRef.current = detail.personaContext || null;
      if (detail.persona) {
        setMsgs((m) => [...m, { who: 'system', text: `Switched to ${detail.persona === 'activator' ? 'Activator' : detail.persona} Copilot.` }]);
      }
      if (detail.prefillPrompt) setDraft(detail.prefillPrompt);
      setOpen(true);
    };
    const k = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === '/') { e.preventDefault(); t(); }
    };
    // Tutorial stepper (item-side-panel LearnPane) → bind this step + open the
    // one window. The next send is forced to the docs/help agent with the step
    // context attached. (This is the same event the retired Help widget used.)
    const onStep = (e: Event) => {
      const detail = (e as CustomEvent<TutorialStepDetail>).detail;
      if (!detail || !detail.id) return;
      tutorialRef.current = detail;
      setTutorial(detail);
      setOpen(true);
    };
    window.addEventListener(EVT_OPEN, o);
    window.addEventListener(EVT_TOGGLE, t);
    window.addEventListener(EVT_CONTEXT, onCtx);
    window.addEventListener(EVT_PERSONA, p as EventListener);
    window.addEventListener(EVT_TUTORIAL_STEP, onStep as EventListener);
    window.addEventListener('keydown', k);
    return () => {
      window.removeEventListener(EVT_OPEN, o);
      window.removeEventListener(EVT_TOGGLE, t);
      window.removeEventListener(EVT_CONTEXT, onCtx);
      window.removeEventListener(EVT_PERSONA, p as EventListener);
      window.removeEventListener(EVT_TUTORIAL_STEP, onStep as EventListener);
      window.removeEventListener('keydown', k);
    };
  }, []);

  // Switching editor panes swaps the persona: reset the thread to the new
  // persona's greeting and start a fresh session so warehouse history doesn't
  // bleed into the notebook persona (and vice versa). Skipped mid-stream.
  useEffect(() => {
    if (slugRef.current === paneCtx.slug) return;
    slugRef.current = paneCtx.slug;
    if (busy) return;
    sessionRef.current = null;
    setGateError(null);
    setMsgs([{ who: 'copilot', text: panePersona.greeting }]);
  }, [paneCtx.slug, panePersona.greeting, busy]);

  useEffect(() => {
    if (bodyRef.current) {
      bodyRef.current.scrollTo({ top: bodyRef.current.scrollHeight, behavior: 'smooth' });
    }
  }, [msgs]);

  // Keep the composer focused: on open, and again when a turn finishes (the
  // Input is disabled while busy, which drops focus).
  useEffect(() => {
    if (open && !busy && !historyOpen) inputRef.current?.focus();
  }, [open, busy, historyOpen]);

  async function sendText(rawText: string) {
    const text = rawText.trim();
    if (!text || busy) return;
    setDraft('');
    setGateError(null);
    setSafetyBlock(null);
    setBusy(true);
    // Tutorial binding is one-shot: this turn carries the step context + is
    // forced to the docs agent, then routing reverts to classification so a
    // follow-up "now build it" still routes to the build agent.
    const tut = tutorialRef.current;
    if (tut) { tutorialRef.current = null; setTutorial(null); }
    setMsgs((m) => [...m, { who: 'you', text }, { who: 'copilot', text: '', steps: [], streaming: true }]);

    try {
      const res = await fetch('/api/copilot/orchestrate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          prompt: text,
          sessionId: sessionRef.current ?? undefined,
          persona: personaRef.current ?? undefined,
          personaContext: personaContextRef.current ?? undefined,
          contextSlug: paneCtx.slug,
          contextPayload: paneCtx.payload,
          // Route/tutorial awareness for the docs agent (when a turn routes to
          // it). receiptScope lets the docs agent read the open item's receipts.
          helpContext: {
            path: pageCtx.path,
            label: pageCtx.label,
            itemType: pageCtx.itemType,
            itemId: pageCtx.itemId,
            tutorial: tut
              ? {
                  id: tut.id,
                  stepIndex: tut.stepIndex,
                  stepTitle: tut.stepTitle,
                  stepBody: tut.stepBody,
                  totalSteps: tut.totalSteps,
                }
              : undefined,
            // Receipt scope priority: the route-bound open item, else the item
            // encoded in the active editor tutorial's id (audit-t41). Either way
            // the docs agent's readReceipts tool resolves to a concrete item for
            // auto-error detection; absent both, it honestly reports
            // "No item in context".
            receiptScope: pageCtx.itemId
              ? { itemId: pageCtx.itemId, itemType: pageCtx.itemType, workspaceId: pageCtx.workspaceId }
              : receiptScopeFromTutorialId(tut?.id),
          },
          // A bound tutorial step is always a docs/help question; otherwise the
          // server classifies intent for the global launcher.
          forceAgent: tut ? 'docs' : undefined,
        }),
      });

      if (res.status === 503) {
        const j = await res.json().catch(() => ({ error: 'Copilot AOAI not wired' }));
        setGateError(j.error || 'Copilot AOAI deployment not wired');
        setMsgs((m) => m.filter((x) => !x.streaming));
        return;
      }
      if (res.status === 400) {
        // Content-safety INPUT block (or other validation error) returned by
        // the orchestrate route before the SSE stream opened.
        const j = await res.json().catch(() => ({ error: {} }));
        const reason = j?.error?.reason || j?.error || 'Content was blocked by safety filters.';
        if (j?.error?.code === 'content_safety_input' || typeof j?.error === 'object') {
          setSafetyBlock(typeof reason === 'string' ? reason : 'Content was blocked by safety filters.');
          setMsgs((m) => m.filter((x) => !x.streaming));
          return;
        }
        setMsgs((m) => m.map((x) => x.streaming ? { ...x, text: `Error: ${reason}`, streaming: false } : x));
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
              if (step.kind === 'error' &&
                  (step.code === 'content_safety_input' || step.code === 'content_safety_output')) {
                // Content-safety block (input echoed back via SSE, or output
                // filtered) — surface as a MessageBar, not inline error text.
                setSafetyBlock(step.error);
                setMsgs((m) => m.filter((x) => !x.streaming));
                continue;
              }
              setMsgs((m) => m.map((x) => {
                if (!x.streaming) return x;
                if (step.kind === 'final') {
                  // Assign a stable, monotonic index used as the feedback key.
                  const idx = msgIndexRef.current++;
                  return { ...x, text: step.content, streaming: false, usage: step.usage, model: step.model, msgIndex: idx };
                }
                if (step.kind === 'error') return { ...x, text: `Error: ${step.error}`, streaming: false };
                // Attribution badge: which agent answered this turn + why.
                if (step.kind === 'agent') {
                  return { ...x, agent: { agentName: step.agentName, reason: step.reason } };
                }
                // Docs-agent source citations — accumulate + dedupe by id.
                if (step.kind === 'citation') {
                  const merged = [...(x.citations ?? [])];
                  for (const c of step.citations) {
                    if (!merged.find((e) => e.id === c.id)) merged.push(c);
                  }
                  return { ...x, citations: merged };
                }
                // Docs-agent "this is an act" → inline re-ask button (in-window).
                if (step.kind === 'handoff') {
                  return { ...x, handoff: { reason: step.reason, suggestedPrompt: step.suggestedPrompt } };
                }
                return { ...x, steps: [...(x.steps ?? []), step] };
              }));
              // Docs-agent openLoomPage navigation — defer so the user sees the
              // answer first (parity with the retired Help widget).
              if (step.kind === 'tool_result' && step.name === 'openLoomPage') {
                const r = step.result as { ok?: boolean; slug?: string } | undefined;
                if (r?.ok && r.slug && typeof window !== 'undefined') {
                  const slug = r.slug;
                  setTimeout(() => { window.location.href = slug; }, 800);
                }
              }
              // A proposed change opens the Keep/Undo diff modal. The editor is
              // NOT mutated here — only on Keep (handled in the modal callbacks).
              if (step.kind === 'proposed_change') {
                setPendingChange({
                  target: step.target,
                  before: step.before,
                  after: step.after,
                  lang: step.lang,
                  callId: step.callId,
                  summary: step.summary,
                });
              }
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

  /** Persist a per-message thumbs up/down to the feedback pipeline. */
  async function sendFeedback(msgIndex: number, rating: 'up' | 'down') {
    if (!sessionRef.current) return;
    // Optimistic — the rating shows immediately; the PATCH writes the doc.
    setRatings((r) => ({ ...r, [msgIndex]: rating }));
    try {
      await fetch(`/api/copilot/sessions/${encodeURIComponent(sessionRef.current)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rating, messageIndex: msgIndex }),
      });
    } catch {
      /* best-effort — UI already reflects the rating */
    }
  }

  /** "Clear chat": delete the session doc and reset the pane to SEED. */
  async function clearChat() {
    if (busy) return;
    if (sessionRef.current) {
      try {
        await fetch(`/api/copilot/sessions/${encodeURIComponent(sessionRef.current)}`, { method: 'DELETE' });
      } catch {
        /* best-effort — still clear the pane */
      }
      sessionRef.current = null;
    }
    setMsgs(SEED);
    setRatings({});
    setGateError(null);
    tutorialRef.current = null;
    setTutorial(null);
    msgIndexRef.current = 0;
  }

  /** Load prior sessions for the History drawer. */
  async function loadHistory() {
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const r = await fetch('/api/copilot/sessions');
      const j = await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
      if (j.ok) setSessions(j.sessions || []);
      else setHistoryError(j.error || `HTTP ${r.status}`);
    } catch (e: any) {
      setHistoryError(e?.message || String(e));
    } finally {
      setHistoryLoading(false);
    }
  }

  /** Open a prior session: bind the id + replay its steps into the pane. */
  async function openSession(sessionId: string) {
    setHistoryOpen(false);
    setBusy(true);
    try {
      const r = await fetch(`/api/copilot/sessions/${encodeURIComponent(sessionId)}`);
      const j = await r.json().catch(() => ({ ok: false }));
      if (!j.ok || !j.session) {
        setMsgs((m) => [...m, { who: 'system', text: `Could not load session: ${j.error || r.status}` }]);
        return;
      }
      sessionRef.current = sessionId;
      setRatings({});
      msgIndexRef.current = 0;
      const replay: Msg[] = [...SEED];
      const steps: Step[] = j.session.steps || [];
      if (j.session.prompt) replay.push({ who: 'you', text: j.session.prompt });
      let toolSteps: Step[] = [];
      for (const st of steps) {
        if (st.kind === 'final') {
          const idx = msgIndexRef.current++;
          replay.push({ who: 'copilot', text: st.content, steps: toolSteps, usage: st.usage, model: st.model, msgIndex: idx });
          toolSteps = [];
        } else if (st.kind === 'error') {
          replay.push({ who: 'copilot', text: `Error: ${st.error}` });
          toolSteps = [];
        } else if (st.kind === 'tool_call' || st.kind === 'tool_result' || st.kind === 'thought') {
          toolSteps.push(st);
        }
      }
      setMsgs(replay);
    } finally {
      setBusy(false);
    }
  }

  function send() {
    void sendText(draft);
  }

  if (!open) return null;

  // Keep: apply the approved change to the registered editor bridge. If the
  // target editor has since closed (no bridge), surface an honest system note
  // rather than silently dropping the change.
  function keepChange(c: ProposedChange) {
    const applied = applyChange(c.target, c.after);
    setPendingChange(null);
    if (!applied) {
      setMsgs((m) => [...m, {
        who: 'system',
        text: `Could not apply the change — the editor for ${c.target} is no longer open. Re-open it and ask again.`,
      }]);
    }
  }

  return (
    <>
      <aside
        className={s.panel}
        aria-label="Copilot"
        data-testid="copilot-pane"
        onKeyDown={(e) => {
          // Escape closes the pane — unless the history drawer or the Keep/Undo
          // diff dialog is up (those own their Escape handling).
          if (e.key === 'Escape' && !historyOpen && !pendingChange) {
            e.stopPropagation();
            setOpen(false);
          }
        }}
      >
        <div className={s.header}>
          <Sparkle24Regular style={{ color: tokens.colorBrandForeground1, flexShrink: 0 }} />
          <Subtitle2 className={s.headerTitle} title={panePersona.title}>{panePersona.title}</Subtitle2>
          {tutorial && (
            <Badge appearance="tint" size="small" color="success" data-testid="copilot-tutorial-badge"
              title={tutorial.stepTitle ? `Step: ${tutorial.stepTitle}` : tutorial.id}>
              step {tutorial.stepIndex + 1}{tutorial.totalSteps ? `/${tutorial.totalSteps}` : ''}
            </Badge>
          )}
          <Caption1 className={s.headerHint}>Ctrl + /</Caption1>
          <Tooltip content="Chat history" relationship="label">
            <Button
              appearance="subtle"
              icon={<History20Regular />}
              onClick={() => { setHistoryOpen(true); loadHistory(); }}
              aria-label="Chat history"
            />
          </Tooltip>
          <Tooltip content="Clear chat" relationship="label">
            <Button
              appearance="subtle"
              icon={<Delete20Regular />}
              onClick={clearChat}
              disabled={busy}
              aria-label="Clear chat"
            />
          </Tooltip>
          <Button appearance="subtle" icon={<Dismiss20Regular />} onClick={() => setOpen(false)} aria-label="Close Copilot" />
        </div>
        <div className={s.body} ref={bodyRef} aria-live="polite">
          {gateError && (
            <MessageBar intent="warning">
              <MessageBarBody>
                <MessageBarTitle>Copilot AOAI deployment not wired</MessageBarTitle>
                {gateError} — set up the AI Foundry hub + a chat-completions deployment.
                Open the AI Foundry editor and click <strong>Deployments → New</strong>.
              </MessageBarBody>
            </MessageBar>
          )}
          {safetyGate && (
            <MessageBar intent="warning">
              <MessageBarBody>
                <MessageBarTitle>Content Safety not configured</MessageBarTitle>
                Prompts and responses are not filtered in this deployment. Ask your administrator to
                provision Azure AI Content Safety and set <strong>LOOM_CONTENT_SAFETY_ENDPOINT</strong> on
                the Console Container App.
              </MessageBarBody>
            </MessageBar>
          )}
          {safetyBlock && (
            <MessageBar intent="error">
              <MessageBarBody>
                <MessageBarTitle>Response blocked by content safety</MessageBarTitle>
                {safetyBlock}
              </MessageBarBody>
            </MessageBar>
          )}
          {msgs.map((m, i) => (
            <div key={i} className={`${s.msg} ${m.who === 'copilot' ? s.msgCopilot : m.who === 'you' ? s.msgYou : s.msgSystem}`} data-testid={`copilot-msg-${m.who}`}>
              {m.agent && (
                <div className={s.agentBadgeRow}>
                  <Tooltip content={m.agent.reason} relationship="description">
                    <Badge appearance="tint" color="brand" size="small"
                      icon={<BranchCompare16Regular />} data-testid="copilot-agent-badge">
                      {m.agent.agentName}
                    </Badge>
                  </Tooltip>
                </div>
              )}
              {m.text && <Body1 style={{ whiteSpace: 'pre-wrap' }}>{m.text}</Body1>}
              {m.steps?.map((step, j) => {
                if (step.kind === 'tool_call') {
                  return (
                    <div key={j} className={s.stepRow}>
                      <Wrench16Regular className={s.stepIcon} aria-hidden />
                      calling <strong>{step.name}</strong>…
                    </div>
                  );
                }
                if (step.kind === 'tool_result') {
                  return (
                    <div key={j}>
                      <div className={s.stepRow}>
                        {step.error
                          ? <ErrorCircle16Regular className={s.stepErr} aria-label="Tool failed" />
                          : <CheckmarkCircle16Regular className={s.stepOk} aria-label="Tool succeeded" />}
                        {step.name} <span>({step.durationMs}ms)</span>
                        {step.error && <span style={{ color: tokens.colorPaletteRedForeground1 }}> — {step.error}</span>}
                      </div>
                      {!step.error && step.name.startsWith('tabular_') && <TabularResult result={step.result} />}
                      {!step.error && !step.name.startsWith('tabular_') && step.result != null && (
                        <CopilotResult result={tagResult(step.result, step.name)} toolName={step.name} />
                      )}
                    </div>
                  );
                }
                if (step.kind === 'thought') {
                  return (
                    <div key={j} className={s.stepRow}>
                      <Lightbulb16Regular className={s.stepIcon} aria-hidden />
                      {step.content.slice(0, 120)}
                    </div>
                  );
                }
                if (step.kind === 'proposed_change') {
                  return (
                    <div key={j} className={s.stepRow}>
                      <DocumentEdit16Regular className={s.stepIcon} aria-hidden />
                      proposed change to <code>{step.target}</code>
                      <Button size="small" appearance="subtle" onClick={() => setPendingChange({
                        target: step.target, before: step.before, after: step.after,
                        lang: step.lang, callId: step.callId, summary: step.summary,
                      })}>Review</Button>
                    </div>
                  );
                }
                return null;
              })}
              {m.streaming && !m.text && (
                <div className={s.stepRow}><Spinner size="extra-tiny" /> Thinking…</div>
              )}
              {m.citations && m.citations.length > 0 && <CitationChips citations={m.citations} />}
              {m.handoff && (
                <div className={s.handoffBox} role="region" aria-label="Switch to the build agent">
                  <Caption1 style={{ color: tokens.colorNeutralForeground2 }}>{m.handoff.reason}</Caption1>
                  <Button
                    appearance="primary"
                    size="small"
                    icon={<Sparkle20Regular />}
                    onClick={() => void sendText(m.handoff!.suggestedPrompt)}
                    disabled={busy}
                    data-testid="copilot-handoff-btn"
                  >
                    Do it with the build agent
                  </Button>
                </div>
              )}
              {m.who === 'copilot' && !m.streaming && m.usage && (
                <Caption1 className={s.stepRow} style={{ color: tokens.colorNeutralForeground3 }}>
                  {m.usage.toolCalls > 0 ? `${m.usage.toolCalls} tool${m.usage.toolCalls === 1 ? '' : 's'} · ` : ''}
                  {m.usage.totalTokens.toLocaleString()} tokens
                  {m.usage.aoaiCalls > 1 ? ` · ${m.usage.aoaiCalls} turns` : ''}
                  {m.model ? ` · ${m.model}` : ''}
                </Caption1>
              )}
              {m.who === 'copilot' && !m.streaming && m.msgIndex !== undefined && (
                <div className={s.feedbackRow}>
                  <Tooltip content="Helpful" relationship="label">
                    <Button
                      appearance="subtle"
                      size="small"
                      icon={<ThumbLike20Regular />}
                      style={{ color: ratings[m.msgIndex] === 'up' ? tokens.colorBrandForeground1 : undefined }}
                      onClick={() => sendFeedback(m.msgIndex!, 'up')}
                      aria-label="Thumbs up"
                      aria-pressed={ratings[m.msgIndex] === 'up'}
                    />
                  </Tooltip>
                  <Tooltip content="Not helpful" relationship="label">
                    <Button
                      appearance="subtle"
                      size="small"
                      icon={<ThumbDislike20Regular />}
                      style={{ color: ratings[m.msgIndex] === 'down' ? tokens.colorPaletteRedForeground1 : undefined }}
                      onClick={() => sendFeedback(m.msgIndex!, 'down')}
                      aria-label="Thumbs down"
                      aria-pressed={ratings[m.msgIndex] === 'down'}
                    />
                  </Tooltip>
                </div>
              )}
            </div>
          ))}
        </div>
        {msgs.length <= 1 && (
          <div className={s.chipsBar}>
            <CopilotChips ctx={copilotCtx} busy={busy} onSelect={(prompt) => void sendText(prompt)} />
          </div>
        )}
        <div className={s.composer}>
          <Input
            ref={inputRef}
            style={{ flex: 1 }}
            value={draft}
            onChange={(_, d) => setDraft(d.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !busy) send(); }}
            placeholder={busy ? 'Working…' : `Ask ${panePersona.title}…`}
            disabled={busy}
            aria-label={`Message ${panePersona.title}`}
            data-testid="copilot-input"
          />
          <Button appearance="primary" icon={<Send24Regular />} onClick={send} disabled={busy || !draft.trim()} aria-label="Send message" data-testid="copilot-send" />
        </div>
        <CopilotDiff
          change={pendingChange}
          onKeep={keepChange}
          onUndo={() => setPendingChange(null)}
        />
      </aside>

      <OverlayDrawer
        open={historyOpen}
        onOpenChange={(_, d) => setHistoryOpen(d.open)}
        position="end"
        aria-label="Copilot chat history"
      >
        <DrawerHeader>
          <DrawerHeaderTitle
            action={
              <Button
                appearance="subtle"
                icon={<Dismiss20Regular />}
                onClick={() => setHistoryOpen(false)}
                aria-label="Close history"
              />
            }
          >
            Chat history
          </DrawerHeaderTitle>
        </DrawerHeader>
        <DrawerBody>
          {historyLoading && <div className={s.stepRow}><Spinner size="extra-tiny" /> Loading…</div>}
          {historyError && (
            <MessageBar intent="error">
              <MessageBarBody>{historyError}</MessageBarBody>
            </MessageBar>
          )}
          {!historyLoading && !historyError && sessions.length === 0 && (
            <div className={s.historyEmpty}>
              <History20Regular style={{ width: 28, height: 28 }} aria-hidden />
              <Body1>No prior sessions</Body1>
              <Caption1>
                Conversations you have with Loom Copilot are saved here so you can
                pick them back up later.
              </Caption1>
            </div>
          )}
          {sessions.map((sess) => (
            <div
              key={sess.id}
              className={s.historyItem}
              role="button"
              tabIndex={0}
              onClick={() => openSession(sess.sessionId || sess.id)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openSession(sess.sessionId || sess.id); } }}
            >
              <Body1 style={{ display: 'block' }}>{sess.prompt || 'Untitled session'}</Body1>
              <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                {sess.updatedAt ? new Date(sess.updatedAt).toLocaleString() : ''} · {sess.stepCount} step{sess.stepCount === 1 ? '' : 's'}
              </Caption1>
            </div>
          ))}
        </DrawerBody>
      </OverlayDrawer>
    </>
  );
}
