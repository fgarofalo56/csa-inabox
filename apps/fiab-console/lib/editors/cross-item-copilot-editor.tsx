'use client';

import { clientFetch } from '@/lib/client-fetch';
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
  Title3, Subtitle2, Caption1, Body1, Badge, Spinner, Button, Textarea,
  MessageBar, MessageBarBody, MessageBarTitle, MessageBarActions,
  InfoLabel, Tooltip, makeStyles, tokens,
} from '@fluentui/react-components';
import {
  BotSparkle24Filled, Send20Filled, DataPie24Regular, Open16Regular,
  ChevronDown16Regular, ChevronRight16Regular, Sparkle16Regular,
} from '@fluentui/react-icons';
import { ItemEditorChrome } from './item-editor-chrome';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';
import { SessionList } from '@/lib/components/copilot/session-list';
import { ToolsPanel } from '@/lib/components/copilot/tools-panel';
import { Transcript } from '@/lib/components/copilot/transcript';
import { groupTurns, type Step, type Tool, type SessionSummary, type Turn } from '@/lib/components/copilot/types';
import {
  POWERBI_AUTHORING_SKILLS,
  POWERBI_MCP_CLIENT_ID_ENV,
  POWERBI_MCP_TENANT_SETTING,
} from '@/lib/copilot/powerbi-skills';

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
      'radial-gradient(900px 300px at 10% -40%, var(--loom-accent-violet) 0%, transparent 55%),' +
      'radial-gradient(700px 320px at 98% 140%, var(--loom-accent-blue) 0%, transparent 55%),' +
      'linear-gradient(135deg, #2a1458 0%, var(--loom-navy-800) 55%, #0b1e3f 100%)',
    boxShadow: tokens.shadow8,
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
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
  heroText: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS, minWidth: 0, flex: 1 },
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
    boxShadow: tokens.shadow4,
    padding: tokens.spacingVerticalM,
    minHeight: 0,
    overflow: 'hidden',
  },
  main: {
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    boxShadow: tokens.shadow4,
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
  emptyBody: { maxWidth: '520px' },
  exampleRow: {
    display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalS,
    justifyContent: 'center', marginTop: tokens.spacingVerticalS,
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
  composerFoot: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: tokens.spacingHorizontalS, color: tokens.colorNeutralForeground3 },
  // Long backend error / remediation strings (AOAI errors, URLs) must wrap
  // inside the status MessageBar rather than force horizontal overflow.
  bannerText: { overflowWrap: 'anywhere', wordBreak: 'break-word', minWidth: 0 },

  // Right rail variant — same chrome as `rail`, but a flex column so the Power BI
  // authoring card sits above the (internally-scrolling) ToolsPanel.
  rightRail: {
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    boxShadow: tokens.shadow4,
    padding: tokens.spacingVerticalM,
    minHeight: 0,
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
  },
  rightRailTools: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' },

  // Power BI authoring group — a card inside the right rail, styled like the
  // ToolsPanel persona card for a cohesive look (web3-ui).
  pbiCard: {
    flexShrink: 0,
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS,
    padding: tokens.spacingVerticalM,
    borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    background: 'linear-gradient(135deg, rgba(124,58,237,0.12), rgba(0,120,212,0.08))',
  },
  pbiHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  pbiHeadIcon: { color: tokens.colorBrandForeground1, flexShrink: 0 },
  pbiHeadText: { display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 },
  pbiNote: { color: tokens.colorNeutralForeground3, overflowWrap: 'anywhere' },
  chipLink: {
    textDecoration: 'none', flexShrink: 0,
    borderRadius: tokens.borderRadiusCircular,
    ':focus-visible': { outline: `2px solid ${tokens.colorStrokeFocus2}`, outlineOffset: '2px' },
  },
  pbiSkillList: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS,
    maxHeight: '260px', overflowY: 'auto', marginTop: tokens.spacingVerticalXS,
  },
  // Mirrors ToolsPanel's toolRow/toolText so the skill list reads as the same
  // catalog rail — text block + a small "Use" action.
  pbiSkillRow: {
    display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'flex-start',
    padding: tokens.spacingVerticalS,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  pbiSkillText: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '2px' },
  pbiSkillName: { fontSize: tokens.fontSizeBase200, fontWeight: tokens.fontWeightSemibold },
  pbiSkillWhen: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase100,
    lineHeight: tokens.lineHeightBase100,
  },
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

/**
 * Starter prompts that seed the composer for each Power BI authoring skill. The
 * skill `guidance` (the actual best-practice system text from the open-source
 * powerbi-authoring skills) is injected server-side by the orchestrator's
 * per-pane persona path — these are just human-friendly kick-off prompts so a
 * click does something real (fills the composer), consistent with the
 * ToolsPanel suggested-prompt chips. Keyed by the skill `id`.
 */
const PBI_SKILL_STARTERS: Record<string, string> = {
  'semantic-model-authoring':
    'Help me author a semantic model: propose a star schema (fact + dimension tables), the key DAX measures, and AI-ready descriptions so it answers natural-language questions well.',
  'power-bi-report-authoring':
    'Help me build a report: create a page and suggest visuals grounded on real aggregates from my semantic model, one visual at a time.',
  'power-bi-report-design':
    'Draft a design brief for a report — the audience, the top business questions, page layout, visual hierarchy, color, and typography.',
  'power-bi-report-planner':
    'Plan a complete report from my existing semantic model: inspect its tables and measures, then propose pages and visuals grounded in real fields.',
  'power-bi-report-management':
    'List my reports and help me organize, rename, and re-bind them — and (opt-in) publish to a Power BI workspace if connected.',
};

interface PbiMcpStatus { configured: boolean; registered: boolean; tokenReady: boolean }

/**
 * PowerBiAuthoringPanel — the "Power BI authoring" group in the Copilot right
 * rail. Lists the 5 powerbi-authoring skills (name + when-to-use) and surfaces
 * the opt-in remote Power BI MCP connect state as a chip.
 *
 * RULE COMPLIANCE
 *  - no-fabric-dependency: the skills work day-one on Loom's Azure-native
 *    semantic-model / report path — NO behavioural coupling to the chip state.
 *    The remote Power BI MCP is strictly opt-in; the chip merely reflects whether
 *    it is configured + registered + has a per-user OBO token, and deep-links to
 *    /admin/mcp-servers to connect it.
 *  - no-vaporware: the chip is driven by a REAL GET /api/admin/mcp-servers/powerbi
 *    (no mock); when not connected the note names the exact env var + the Power BI
 *    tenant setting (the full honest gate — Entra app reg, scopes — lives on the
 *    admin page the chip links to). Each "Use" fills the composer with a real
 *    starter prompt that drives the orchestrator.
 */
function PowerBiAuthoringPanel({ onSuggestedPrompt }: { onSuggestedPrompt: (p: string) => void }) {
  const s = useStyles();
  const [open, setOpen] = useState(true);
  const [loading, setLoading] = useState(true);
  const [pbi, setPbi] = useState<PbiMcpStatus | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await clientFetch('/api/admin/mcp-servers/powerbi');
        const j = await r.json().catch(() => ({} as any));
        if (!alive) return;
        setPbi(
          j && j.ok
            ? { configured: !!j.configured, registered: !!j.registered, tokenReady: !!j.tokenReady }
            : { configured: false, registered: false, tokenReady: false },
        );
      } catch {
        if (alive) setPbi({ configured: false, registered: false, tokenReady: false });
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, []);

  // "Connected" = opted in (env var set) + registered as an McpServerConfig row +
  // a per-user OBO token cached (so calls won't 401). Anything less is a partial
  // setup the operator finishes in admin.
  const connected = !!pbi && pbi.configured && pbi.registered && pbi.tokenReady;
  const chipColor: 'success' | 'warning' | 'brand' =
    connected ? 'success' : pbi?.configured ? 'warning' : 'brand';
  const chipLabel = connected ? 'Connected' : pbi?.configured ? 'Finish connecting' : 'Connect Power BI';

  return (
    <div className={s.pbiCard}>
      <div className={s.pbiHead}>
        <DataPie24Regular className={s.pbiHeadIcon} aria-hidden />
        <div className={s.pbiHeadText}>
          <Subtitle2>
            <InfoLabel info="5 cloud-native semantic-model & report authoring skills; Azure-native by default, Power BI MCP is opt-in">
              Power BI authoring
            </InfoLabel>
          </Subtitle2>
          <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
            {POWERBI_AUTHORING_SKILLS.length} skills · Azure-native by default
          </Caption1>
        </div>
        {loading ? (
          <Tooltip relationship="label" content="Verifying Power BI MCP connection state">
            <Badge appearance="tint" color="informative">Checking…</Badge>
          </Tooltip>
        ) : (
          <a
            className={s.chipLink}
            href="/admin/mcp-servers"
            aria-label={connected ? 'Power BI MCP connected — manage in admin' : 'Connect the Power BI MCP in admin'}
          >
            <Badge appearance="tint" color={chipColor} icon={<Open16Regular />}>{chipLabel}</Badge>
          </a>
        )}
        <Button
          appearance="subtle"
          size="small"
          icon={open ? <ChevronDown16Regular /> : <ChevronRight16Regular />}
          aria-expanded={open}
          aria-label={open ? 'Collapse Power BI skills' : 'Expand Power BI skills'}
          onClick={() => setOpen((v) => !v)}
        />
      </div>

      {!loading && (
        <Caption1 className={s.pbiNote}>
          {connected
            ? 'Connected — schema-aware query + Copilot DAX run read-only under your Power BI RBAC. These skills also drive Loom’s Azure-native authoring.'
            : `Opt-in: set ${POWERBI_MCP_CLIENT_ID_ENV} and enable the “${POWERBI_MCP_TENANT_SETTING}” tenant setting to add schema-aware query + Copilot DAX. These skills already work on Loom’s Azure-native semantic-model & report path.`}
        </Caption1>
      )}

      {open && (
        <div className={s.pbiSkillList}>
          {POWERBI_AUTHORING_SKILLS.map((skill) => (
            <div key={skill.id} className={s.pbiSkillRow}>
              <div className={s.pbiSkillText}>
                <span className={s.pbiSkillName}>{skill.name}</span>
                <span className={s.pbiSkillWhen}>{skill.whenToUse}</span>
              </div>
              <Button
                size="small"
                appearance="subtle"
                icon={<Sparkle16Regular />}
                onClick={() => onSuggestedPrompt(PBI_SKILL_STARTERS[skill.id] ?? skill.whenToUse)}
                aria-label={`Use the ${skill.name} skill`}
              >
                Use
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

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
        // forceAgent:'build' — the full console IS the build agent surface the
        // user navigated to deliberately; the unified router's docs-vs-build
        // classification applies only to the global launcher window.
        body: JSON.stringify({ prompt: p, sessionId: activeSessionId || undefined, contextSlug, forceAgent: 'build' }),
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
                <MessageBarBody className={s.bannerText}>
                  <MessageBarTitle>Orchestrator status</MessageBarTitle>
                  {status.aoai?.ok
                    ? `AOAI reachable (${status.aoai.deployment}) · ${status.tools?.count ?? 0} tools registered.`
                    : `AOAI not reachable — ${status.aoai?.error || 'unknown'}. ${status.tools?.count ?? 0} tools still callable directly via the right rail.`}
                  {status.aoai?.remediation && <div style={{ marginTop: tokens.spacingVerticalS, fontSize: tokens.fontSizeBase200 }}>{status.aoai.remediation}</div>}
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
                <MessageBarBody className={s.bannerText}>
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
                <MessageBarBody className={s.bannerText}><MessageBarTitle>Orchestrator error</MessageBarTitle>{topError}</MessageBarBody>
              </MessageBar>
            )}
          </div>
        ) : null}

        <div className={s.transcriptScroll} ref={stepsRef}>
          {!hasTranscript ? (
            <div className={s.emptyState}>
              <span className={s.emptyIcon}><BotSparkle24Filled fontSize={30} /></span>
              <Title3>Ask CSA Loom Copilot</Title3>
              <Body1 className={s.emptyBody}>
                One prompt, orchestrated across every wired service — Synapse, Lakehouse,
                Databricks, APIM, ADX, ADF, Power BI, and the AI Foundry hub. Copilot picks
                the right tools and runs them against real backends.
              </Body1>
              <div className={s.exampleRow}>
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

      {/* Right rail — Power BI authoring · tools + persona */}
      <aside className={s.rightRail}>
        <PowerBiAuthoringPanel onSuggestedPrompt={(p) => setComposer(p)} />
        <div className={s.rightRailTools}>
          <ToolsPanel
            contextSlug={contextSlug}
            tools={tools}
            toolCount={toolCount}
            ready={status?.ready}
            deployment={status?.aoai?.deployment}
            onSuggestedPrompt={(p) => setComposer(p)}
          />
        </div>
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
