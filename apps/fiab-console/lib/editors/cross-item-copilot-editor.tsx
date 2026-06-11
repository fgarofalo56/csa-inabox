'use client';

/**
 * Cross-item Copilot console — shared UI for both
 *   - /copilot                                (full-screen page)
 *   - /items/cross-item-copilot/<id>          (embedded editor)
 *
 * Best-in-class chat surface (audit-T121):
 *   • Left rail  — fully manageable sessions (SessionList): search, recency
 *     grouping, rename / pin / duplicate / delete, active state, empty state.
 *   • Centre     — modern transcript (Transcript): user/assistant bubbles,
 *     avatars, markdown + syntax-highlighted code, tool-call + run-receipt
 *     rendering, citations, copy / regenerate / feedback. Composer is pinned at
 *     the bottom (flex-shrink:0); only the transcript scrolls (T118).
 *   • Right rail — self-explanatory tools + active persona (ToolsPanel).
 *
 * Streams from POST /api/copilot/orchestrate via SSE. Every control wires to a
 * real Cosmos/AOAI-backed BFF route — no mocks, no dead buttons.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Title3, Caption1, Body1, Badge, Spinner, Button, Textarea,
  MessageBar, MessageBarBody, MessageBarTitle, MessageBarActions,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { BotSparkle24Filled, Send20Filled } from '@fluentui/react-icons';
import { ItemEditorChrome } from './item-editor-chrome';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';
import { SessionList } from '@/lib/components/copilot/session-list';
import { ToolsPanel } from '@/lib/components/copilot/tools-panel';
import { Transcript } from '@/lib/components/copilot/transcript';
import { groupTurns, type Step, type Tool, type SessionSummary, type Turn } from '@/lib/components/copilot/types';

const useStyles = makeStyles({
  // Full-screen page wrapper — bounded height so panels scroll INTERNALLY and
  // the AppShell scrollbar never toggles (the proven anti-flicker layout).
  page: {
    padding: tokens.spacingHorizontalL,
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
    height: 'calc(100vh - 52px)',
    minHeight: 0,
    overflow: 'hidden',
    boxSizing: 'border-box',
  },
  hero: {
    position: 'relative',
    overflow: 'hidden',
    flexShrink: 0,
    borderRadius: tokens.borderRadiusXLarge,
    padding: `${tokens.spacingVerticalL} ${tokens.spacingHorizontalXXL}`,
    color: tokens.colorNeutralForegroundOnBrand,
    background:
      'radial-gradient(900px 300px at 10% -40%, #7c3aed 0%, transparent 55%),' +
      'radial-gradient(700px 320px at 98% 140%, #0078d4 0%, transparent 55%),' +
      'linear-gradient(135deg, #2a1458 0%, #1a1342 55%, #0b1e3f 100%)',
    boxShadow: tokens.shadow8,
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalL,
  },
  heroIcon: {
    flexShrink: 0,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: '48px', height: '48px',
    borderRadius: tokens.borderRadiusLarge,
    background: 'linear-gradient(135deg, rgba(255,255,255,0.25), rgba(255,255,255,0.08))',
    border: '1px solid rgba(255,255,255,0.25)',
  },
  heroText: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0, flex: 1 },
  heroTitle: { color: tokens.colorNeutralForegroundOnBrand, margin: 0, lineHeight: 1.1 },
  heroLead: { color: 'rgba(255,255,255,0.82)' },

  shell: {
    display: 'grid',
    gridTemplateColumns: '280px minmax(0, 1fr) 340px',
    gridTemplateRows: 'minmax(0, 1fr)',
    gap: tokens.spacingHorizontalM,
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    overflow: 'hidden',
  },
  rail: {
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    padding: tokens.spacingVerticalM,
    minHeight: 0,
    overflow: 'hidden',
  },
  main: {
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
    minHeight: 0,
    overflow: 'hidden',
  },
  banners: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS,
    padding: tokens.spacingVerticalM,
    flexShrink: 0,
  },
  transcriptScroll: {
    flex: 1,
    overflow: 'auto',
    minHeight: 0,
    padding: tokens.spacingVerticalL,
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
  },
  emptyState: {
    flex: 1,
    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    gap: tokens.spacingVerticalS, textAlign: 'center',
    color: tokens.colorNeutralForeground3,
    padding: tokens.spacingVerticalXXL,
  },
  emptyIcon: {
    width: '56px', height: '56px', borderRadius: tokens.borderRadiusXLarge,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    background: 'linear-gradient(135deg, rgba(124,58,237,0.18), rgba(0,120,212,0.12))',
    color: tokens.colorBrandForeground1,
  },
  composer: {
    flexShrink: 0,
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    padding: tokens.spacingVerticalM,
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXS,
  },
  composerRow: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'flex-end' },
  composerFoot: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, color: tokens.colorNeutralForeground3 },
});

/**
 * shouldAutoScroll — pure predicate for the transcript autoscroll guard.
 *
 * Returns true only when the viewport is already within `threshold` px of the
 * bottom of the scroll container. Load-bearing half of the flicker fix: we only
 * nudge the inner container to the bottom (instantly) when the user hasn't
 * scrolled up to read history. Exported so it can be unit-tested without a DOM.
 */
export function shouldAutoScroll(
  m: { scrollHeight: number; scrollTop: number; clientHeight: number },
  threshold = 120,
): boolean {
  return m.scrollHeight - m.scrollTop - m.clientHeight < threshold;
}

interface OrchestratorStatus {
  ok: boolean;
  ready?: boolean;
  configured?: boolean;
  cloud?: string;
  endpoint?: string;
  model?: string;
  aoai?: {
    ok: boolean;
    endpoint?: string;
    deployment?: string;
    model?: string;
    error?: string;
    remediation?: string;
    portalDeepLink?: string;
  };
  tools?: { count: number; byService: Record<string, number> };
  sessions?: { recent: number };
}

const EXAMPLE_PROMPTS = [
  'Find the top 10 revenue customers from gold.fact_sales last quarter.',
  'Run a KQL query for the 5 slowest requests in the last hour.',
  'Trigger the nightly ADF ingestion pipeline and report its run status.',
  'Refresh the Sales semantic model, then tell me when it last completed.',
];

export function CopilotConsoleView({ embedded = false, contextSlug = 'default', onBack }: { embedded?: boolean; contextSlug?: string; onBack?: () => void }) {
  const s = useStyles();
  const [composer, setComposer] = useState('');
  const [steps, setSteps] = useState<Step[]>([]);
  const [running, setRunning] = useState(false);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [userPrompts, setUserPrompts] = useState<string[]>([]);
  const [aoaiUnavailable, setAoaiUnavailable] = useState<string | null>(null);
  const [topError, setTopError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [tools, setTools] = useState<Record<string, Tool[]>>({});
  const [toolCount, setToolCount] = useState(0);
  const [status, setStatus] = useState<OrchestratorStatus | null>(null);
  const [ratings, setRatings] = useState<Record<number, 'up' | 'down'>>({});

  const stepsRef = useRef<HTMLDivElement | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      const r = await fetch('/api/copilot/status');
      setStatus(await r.json());
    } catch {/* ignore */}
  }, []);

  const loadSessions = useCallback(async () => {
    setSessionsLoading(true);
    try {
      const r = await fetch('/api/copilot/sessions');
      const j = await r.json();
      if (j.ok) setSessions(j.sessions || []);
    } catch {} finally { setSessionsLoading(false); }
  }, []);

  const loadTools = useCallback(async () => {
    try {
      const r = await fetch('/api/copilot/tools');
      const j = await r.json();
      if (j.ok) { setTools(j.grouped || {}); setToolCount(j.count || 0); }
    } catch {}
  }, []);

  const loadSessionDetail = useCallback(async (id: string) => {
    try {
      const r = await fetch(`/api/copilot/sessions/${encodeURIComponent(id)}`);
      const j = await r.json();
      if (j.ok && j.session) {
        setActiveSessionId(id);
        setComposer('');
        setRatings({});
        setSteps((j.session.steps || []) as Step[]);
        // Only the first prompt is persisted on the session doc.
        setUserPrompts(j.session.prompt ? [j.session.prompt] : []);
        setTopError(null);
        setAoaiUnavailable(null);
      }
    } catch {}
  }, []);

  useEffect(() => { loadStatus(); }, [loadStatus]);
  useEffect(() => { loadSessions(); loadTools(); }, [loadSessions, loadTools]);

  // Auto-scroll the transcript to the bottom as new steps arrive — instant,
  // inner-container-only, and only when the user is already near the bottom.
  useEffect(() => {
    const el = stepsRef.current;
    if (!el) return;
    if (shouldAutoScroll(el)) el.scrollTop = el.scrollHeight;
  }, [steps.length, running]);

  const newSession = useCallback(() => {
    setActiveSessionId(null);
    setComposer('');
    setSteps([]);
    setUserPrompts([]);
    setRatings({});
    setTopError(null);
    setAoaiUnavailable(null);
  }, []);

  // Embedded ribbon "New"/"Refresh" buttons dispatch a CustomEvent.
  useEffect(() => {
    if (!embedded || typeof window === 'undefined') return;
    const handler = (e: Event) => {
      const kind = (e as CustomEvent<{ kind?: 'new' | 'refresh' }>).detail?.kind;
      if (kind === 'new') newSession();
      else if (kind === 'refresh') loadSessions();
    };
    window.addEventListener('loom-copilot:session', handler);
    return () => window.removeEventListener('loom-copilot:session', handler);
  }, [embedded, newSession, loadSessions]);

  const runOrchestrate = useCallback(async (rawPrompt: string) => {
    const p = rawPrompt.trim();
    if (!p || running) return;
    setRunning(true);
    setComposer('');
    setUserPrompts((prev) => [...prev, p]);
    setAoaiUnavailable(null);
    setTopError(null);

    try {
      const res = await fetch('/api/copilot/orchestrate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: p, sessionId: activeSessionId || undefined, contextSlug }),
      });

      if (res.status === 503) {
        const j = await res.json().catch(() => ({}));
        setAoaiUnavailable(j.error || 'No AOAI deployment on the Foundry hub.');
        setRunning(false);
        setUserPrompts((prev) => prev.slice(0, -1));
        return;
      }
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => ({}));
        setTopError(j.error || `HTTP ${res.status}`);
        setRunning(false);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let currentEvent = 'message';
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split(/\r?\n/);
        buf = lines.pop() || '';
        for (const line of lines) {
          if (line.startsWith('event:')) {
            currentEvent = line.slice(6).trim();
          } else if (line.startsWith('data:')) {
            const data = line.slice(5).trim();
            if (!data) continue;
            try {
              const parsed = JSON.parse(data);
              if (currentEvent === 'session') {
                if (parsed.sessionId) setActiveSessionId(parsed.sessionId);
              } else if (currentEvent === 'step') {
                setSteps((prev) => [...prev, parsed as Step]);
              }
            } catch {}
          }
        }
      }
    } catch (e: any) {
      setTopError(e?.message || String(e));
    } finally {
      setRunning(false);
      loadSessions();
    }
  }, [running, activeSessionId, contextSlug, loadSessions]);

  // Per-message thumbs up/down → real Cosmos feedback doc (PATCH).
  const sendFeedback = useCallback(async (messageIndex: number, rating: 'up' | 'down') => {
    if (!activeSessionId) return;
    setRatings((r) => ({ ...r, [messageIndex]: rating }));
    try {
      await fetch(`/api/copilot/sessions/${encodeURIComponent(activeSessionId)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rating, messageIndex }),
      });
    } catch {/* best-effort */}
  }, [activeSessionId]);

  // Rename / pin → real PATCH; optimistic local update + reload.
  const renameSession = useCallback(async (sessionId: string, title: string) => {
    setSessions((prev) => prev.map((x) => x.sessionId === sessionId ? { ...x, title } : x));
    try {
      await fetch(`/api/copilot/sessions/${encodeURIComponent(sessionId)}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title }),
      });
    } catch {} finally { loadSessions(); }
  }, [loadSessions]);

  const togglePin = useCallback(async (sessionId: string, pinned: boolean) => {
    setSessions((prev) => prev.map((x) => x.sessionId === sessionId ? { ...x, pinned } : x));
    try {
      await fetch(`/api/copilot/sessions/${encodeURIComponent(sessionId)}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pinned }),
      });
    } catch {} finally { loadSessions(); }
  }, [loadSessions]);

  const deleteSession = useCallback(async (sessionId: string) => {
    setSessions((prev) => prev.filter((x) => x.sessionId !== sessionId));
    if (activeSessionId === sessionId) newSession();
    try {
      await fetch(`/api/copilot/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
    } catch {} finally { loadSessions(); }
  }, [activeSessionId, newSession, loadSessions]);

  // Duplicate = start a fresh chat pre-filled with the source prompt (a new
  // session doc is created by the orchestrator on first send).
  const duplicateSession = useCallback((session: SessionSummary) => {
    newSession();
    setComposer(session.prompt || '');
  }, [newSession]);

  const turns = useMemo<Turn[]>(
    () => groupTurns(steps, { userPrompts, streaming: running }),
    [steps, userPrompts, running],
  );

  const foundryPortalUrl = useMemo(
    () => status?.aoai?.portalDeepLink ?? 'https://ai.azure.com',
    [status?.aoai?.portalDeepLink],
  );

  const send = useCallback(() => { void runOrchestrate(composer); }, [runOrchestrate, composer]);
  const regenerate = useCallback((turn: Turn) => { if (turn.user) void runOrchestrate(turn.user); }, [runOrchestrate]);

  const hasTranscript = turns.length > 0;

  const body = (
    <div className={s.shell}>
      {/* Left rail — sessions */}
      <aside className={s.rail}>
        <SessionList
          sessions={sessions}
          activeSessionId={activeSessionId}
          loading={sessionsLoading}
          onSelect={loadSessionDetail}
          onNew={newSession}
          onRename={renameSession}
          onTogglePin={togglePin}
          onDuplicate={duplicateSession}
          onDelete={deleteSession}
        />
      </aside>

      {/* Main — banners · transcript · pinned composer */}
      <section className={s.main}>
        {(status && !status.ready) || aoaiUnavailable || topError ? (
          <div className={s.banners}>
            {status && !status.ready && (
              <MessageBar intent={status.aoai?.ok ? 'warning' : 'info'}>
                <MessageBarBody>
                  <MessageBarTitle>Orchestrator status</MessageBarTitle>
                  {status.aoai?.ok
                    ? `AOAI reachable (${status.aoai.deployment}) · ${status.tools?.count ?? 0} tools registered.`
                    : `AOAI not reachable — ${status.aoai?.error || 'unknown'}. ${status.tools?.count ?? 0} tools still callable directly via the right rail.`}
                  {status.aoai?.remediation && <div style={{ marginTop: 6, fontSize: 12 }}>{status.aoai.remediation}</div>}
                </MessageBarBody>
                <MessageBarActions>
                  {!status.aoai?.ok && (
                    <Button as="a" href={foundryPortalUrl} target="_blank" rel="noopener noreferrer" appearance="primary">
                      Configure in AI Foundry
                    </Button>
                  )}
                  <Button appearance="subtle" onClick={loadStatus}>Recheck</Button>
                </MessageBarActions>
              </MessageBar>
            )}
            {aoaiUnavailable && (
              <MessageBar intent="warning">
                <MessageBarBody>
                  <MessageBarTitle>No AOAI deployment</MessageBarTitle>
                  {aoaiUnavailable}
                </MessageBarBody>
                <MessageBarActions>
                  <Button as="a" href={foundryPortalUrl} target="_blank" rel="noopener noreferrer">Go to AI Foundry</Button>
                </MessageBarActions>
              </MessageBar>
            )}
            {topError && (
              <MessageBar intent="error">
                <MessageBarBody><MessageBarTitle>Orchestrator error</MessageBarTitle>{topError}</MessageBarBody>
              </MessageBar>
            )}
          </div>
        ) : null}

        <div className={s.transcriptScroll} ref={stepsRef}>
          {!hasTranscript ? (
            <div className={s.emptyState}>
              <span className={s.emptyIcon}><BotSparkle24Filled fontSize={30} /></span>
              <Title3>Ask CSA Loom Copilot</Title3>
              <Body1 style={{ maxWidth: 520 }}>
                One prompt, orchestrated across every wired service — Synapse, Lakehouse,
                Databricks, APIM, ADX, ADF, Power BI, and the AI Foundry hub. Copilot picks
                the right tools and runs them against real backends.
              </Body1>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalS, justifyContent: 'center', marginTop: tokens.spacingVerticalS }}>
                {EXAMPLE_PROMPTS.map((ex) => (
                  <Button key={ex} appearance="outline" size="small" onClick={() => setComposer(ex)}>{ex}</Button>
                ))}
              </div>
            </div>
          ) : (
            <Transcript
              turns={turns}
              ratings={ratings}
              onFeedback={sendFeedback}
              onRegenerate={regenerate}
              canRegenerate={!running}
            />
          )}
        </div>

        {/* Pinned composer */}
        <div className={s.composer}>
          <div className={s.composerRow}>
            <Textarea
              style={{ flex: 1 }}
              placeholder='Ask anything — e.g. "Trigger the nightly ingestion pipeline and report its status."'
              value={composer}
              onChange={(_e, d) => setComposer(d.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
              }}
              rows={2}
              disabled={running}
              aria-label="Message CSA Loom Copilot"
            />
            <Button
              appearance="primary"
              icon={running ? <Spinner size="tiny" /> : <Send20Filled />}
              disabled={running || !composer.trim()}
              onClick={send}
              aria-label="Send"
            >
              {running ? 'Working…' : 'Send'}
            </Button>
          </div>
          <div className={s.composerFoot}>
            <Caption1>Enter to send · Shift+Enter for a new line</Caption1>
            <div style={{ flex: 1 }} />
            {status?.ready
              ? <Badge appearance="tint" color="success">Ready · {toolCount} tools</Badge>
              : <Caption1>{toolCount} tools registered</Caption1>}
          </div>
        </div>
      </section>

      {/* Right rail — tools + persona */}
      <aside className={s.rail}>
        <ToolsPanel
          contextSlug={contextSlug}
          tools={tools}
          toolCount={toolCount}
          ready={status?.ready}
          deployment={status?.aoai?.deployment}
          onSuggestedPrompt={(p) => setComposer(p)}
        />
      </aside>
    </div>
  );

  if (embedded) return body;
  return (
    <div className={s.page}>
      <div className={s.hero}>
        <span className={s.heroIcon} aria-hidden><BotSparkle24Filled fontSize={26} /></span>
        <div className={s.heroText}>
          <Title3 className={s.heroTitle}>Loom Copilot</Title3>
          <Caption1 className={s.heroLead}>
            Orchestrates the right tools across every wired CSA Loom service from one natural-language prompt.
          </Caption1>
        </div>
        {onBack && (
          <Button
            appearance="outline"
            onClick={onBack}
            style={{ color: '#fff', borderColor: 'rgba(255,255,255,0.4)' }}
          >
            Back to overview
          </Button>
        )}
      </div>
      {body}
    </div>
  );
}

// -------- Editor variant (for /items/cross-item-copilot/<id>) --------

function dispatchSessionEvent(kind: 'new' | 'refresh') {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('loom-copilot:session', { detail: { kind } }));
}

function viewToolRegistry() {
  if (typeof window === 'undefined') return;
  window.open('/api/copilot/tools', '_blank', 'noopener,noreferrer');
}

const RIBBON: RibbonTab[] = [
  { id: 'home', label: 'Home', groups: [
    { label: 'Session', actions: [
      { label: 'New', onClick: () => dispatchSessionEvent('new') },
      { label: 'Refresh', onClick: () => dispatchSessionEvent('refresh') },
    ] },
    { label: 'Tools', actions: [
      { label: 'View registry', onClick: viewToolRegistry },
    ] },
  ]},
];

export function CrossItemCopilotEditor({ item, id }: { item: FabricItemType; id: string }) {
  return (
    <ItemEditorChrome
      item={item}
      id={id}
      ribbon={RIBBON}
      main={<CopilotConsoleView embedded />}
    />
  );
}
