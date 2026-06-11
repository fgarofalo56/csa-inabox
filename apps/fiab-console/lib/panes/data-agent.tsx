'use client';

/**
 * DataAgentPane — Loom's full lifecycle-management surface for data agents.
 *
 * A data agent (Fabric / Foundry parity) is a governed, conversational Q&A
 * surface grounded in your data (warehouse / lakehouse / semantic model / KQL /
 * Azure SQL / ontology / graph / AI Search). This page is where an operator
 * MANAGES their real agents end-to-end:
 *
 *   • LEFT RAIL — the operator's REAL data agents from the backing store
 *     (GET /api/items/data-agent → tenant-scoped Cosmos items). Each row shows
 *     name, a status badge (Draft / Published / M365), the number of bound
 *     sources, and when it was last updated, plus a "…" overflow menu:
 *       Open · Configure & enhance · Rename · Duplicate · Publish · Delete.
 *     "New data agent" creates a real item (workspace picker → POST) and routes
 *     straight into its editor. Real loading / empty / error states.
 *
 *   • RIGHT — a live test-chat against the SELECTED real agent
 *     (POST /api/items/data-agent/[id]/chat → grounded Azure-native answer with
 *     the actual SQL/KQL/DAX it ran as citations). Composer PINNED at the bottom.
 *
 * Azure-native by default (no Microsoft Fabric dependency): a data agent is a
 * Cosmos item and the test-chat runs on Azure OpenAI over the bound sources.
 * Publishing to the Foundry Agent Service / Microsoft 365 Copilot is strictly
 * opt-in and lives in the editor's Publish tabs. The only non-functional state
 * is an honest Fluent MessageBar naming the exact env var to set (e.g. no AOAI
 * model deployed). No mock agents, no fake answers, no dead controls. See
 * .claude/rules/no-vaporware.md + .claude/rules/no-fabric-dependency.md.
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Body1,
  Caption1,
  Text,
  makeStyles,
  tokens,
  Button,
  Textarea,
  Input,
  Avatar,
  Spinner,
  Badge,
  Dropdown,
  Option,
  Field,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  MessageBarActions,
  Menu,
  MenuTrigger,
  MenuPopover,
  MenuList,
  MenuItem,
  MenuDivider,
  Dialog,
  DialogSurface,
  DialogBody,
  DialogTitle,
  DialogContent,
  DialogActions,
  mergeClasses,
} from '@fluentui/react-components';
import {
  Send24Filled,
  Bot24Regular,
  Person24Regular,
  ArrowClockwise20Regular,
  ChatMultiple24Regular,
  Database16Regular,
  Sparkle20Regular,
  Add20Regular,
  MoreHorizontal20Regular,
  Open16Regular,
  Settings20Regular,
  Rename16Regular,
  Copy16Regular,
  Delete16Regular,
  CloudArrowUp16Regular,
} from '@fluentui/react-icons';
import { normalizeDaSources } from '@/lib/editors/_family-utils';

// ---------------------------------------------------------------------------
// Wire types — mirror the BFF route shapes.
// ---------------------------------------------------------------------------

/** A real data-agent item row (GET /api/items/data-agent). */
interface AgentItem {
  id: string;
  workspaceId: string;
  displayName: string;
  description?: string;
  state: Record<string, any>;
  createdAt?: string | null;
  updatedAt?: string | null;
}

interface WorkspaceRow {
  id: string;
  name: string;
}

/** Source citation from a grounded chat turn (matches DataAgentTool). */
interface ChatTool {
  source: string;
  type?: string;
  action: string;
  query?: string;
  executed?: boolean;
  rowCount?: number;
  gate?: string;
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  tools?: ChatTool[];
  pending?: boolean;
  error?: boolean;
}

/** Honest infra-gate payload (HTTP 503 from the chat BFF). */
interface NotConfigured {
  error: string;
  hint?: string;
}

type AgentStatus = 'draft' | 'published' | 'm365';

function deriveStatus(state: Record<string, any>): AgentStatus {
  if (state?.m365Copilot?.publishedAt) return 'm365';
  if (state?.publishedAt || state?.foundryAgentId) return 'published';
  return 'draft';
}

function sourceCount(state: Record<string, any>): number {
  try {
    return normalizeDaSources(state?.sources).length;
  } catch {
    return Array.isArray(state?.sources) ? state.sources.length : 0;
  }
}

function relTime(iso?: string | null): string {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const diff = Date.now() - t;
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

const STATUS_META: Record<AgentStatus, { label: string; color: 'informative' | 'success' | 'brand' }> = {
  draft: { label: 'Draft', color: 'informative' },
  published: { label: 'Published', color: 'success' },
  m365: { label: 'M365 Copilot', color: 'brand' },
};

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const useStyles = makeStyles({
  shell: {
    display: 'grid',
    gridTemplateColumns: '320px 1fr',
    gap: tokens.spacingHorizontalL,
    height: 'calc(100vh - 132px)',
    minHeight: '480px',
  },

  // --- left rail ---------------------------------------------------------
  rail: {
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
    borderRadius: tokens.borderRadiusXLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    overflow: 'hidden',
  },
  railHead: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    padding: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalL}`,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  railTitle: { fontWeight: tokens.fontWeightSemibold, flex: 1, minWidth: 0 },
  railActions: {
    display: 'flex',
    gap: tokens.spacingHorizontalS,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  railList: {
    flex: 1,
    overflowY: 'auto',
    padding: tokens.spacingVerticalS,
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXS,
  },
  agentItem: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: tokens.spacingHorizontalM,
    padding: tokens.spacingVerticalM,
    borderRadius: tokens.borderRadiusLarge,
    cursor: 'pointer',
    border: '1px solid transparent',
    textAlign: 'left',
    backgroundColor: 'transparent',
    transitionDuration: tokens.durationFaster,
    transitionProperty: 'background-color, border-color',
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover },
    ':focus-within': {
      outline: `2px solid ${tokens.colorStrokeFocus2}`,
      outlineOffset: '1px',
    },
  },
  agentItemActive: {
    backgroundColor: tokens.colorBrandBackground2,
    border: `1px solid ${tokens.colorBrandStroke1}`,
    ':hover': { backgroundColor: tokens.colorBrandBackground2Hover },
  },
  agentChip: {
    flexShrink: 0,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '36px',
    height: '36px',
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: 'rgba(75,29,143,0.12)',
    color: 'var(--loom-accent-purple)',
  },
  agentBody: {
    flex: 1,
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    border: 'none',
    background: 'transparent',
    padding: 0,
    textAlign: 'left',
    cursor: 'pointer',
    ':focus-visible': { outline: 'none' },
  },
  agentNameRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, minWidth: 0 },
  agentName: {
    fontWeight: tokens.fontWeightSemibold,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    flex: 1,
    minWidth: 0,
  },
  agentMetaRow: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    color: tokens.colorNeutralForeground3,
    flexWrap: 'wrap',
  },
  railState: {
    padding: tokens.spacingVerticalL,
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
    alignItems: 'center',
    textAlign: 'center',
    color: tokens.colorNeutralForeground3,
  },
  railFoot: {
    padding: tokens.spacingVerticalS,
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  footText: { color: tokens.colorNeutralForeground4 },

  // --- chat column -------------------------------------------------------
  chat: {
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
    minWidth: 0,
    borderRadius: tokens.borderRadiusXLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    overflow: 'hidden',
  },
  chatHead: {
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
    padding: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalL}`,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  chatHeadMeta: { display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1, gap: '2px' },
  chatHeadTitleRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, minWidth: 0 },
  chatHeadTitle: {
    fontWeight: tokens.fontWeightSemibold,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  chatHeadSub: { color: tokens.colorNeutralForeground3 },
  chatHeadActions: { display: 'flex', gap: tokens.spacingHorizontalXS, flexShrink: 0 },
  gateBar: { marginLeft: tokens.spacingHorizontalL, marginRight: tokens.spacingHorizontalL, marginTop: tokens.spacingVerticalM },
  gateMeta: { marginTop: '6px', fontSize: tokens.fontSizeBase200 },
  transcript: {
    flex: 1,
    overflowY: 'auto',
    padding: tokens.spacingHorizontalXXL,
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalL,
  },
  empty: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: tokens.spacingVerticalM,
    textAlign: 'center',
    color: tokens.colorNeutralForeground3,
    padding: tokens.spacingHorizontalXXL,
  },
  emptyGlyph: { color: 'var(--loom-accent-purple)', opacity: 0.85, width: '40px', height: '40px' },
  starters: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: tokens.spacingHorizontalS,
    justifyContent: 'center',
    maxWidth: '560px',
  },
  msg: { display: 'flex', gap: tokens.spacingHorizontalM, alignItems: 'flex-start' },
  msgUser: { flexDirection: 'row-reverse' },
  bubble: {
    padding: tokens.spacingVerticalM,
    paddingLeft: tokens.spacingHorizontalL,
    paddingRight: tokens.spacingHorizontalL,
    borderRadius: tokens.borderRadiusXLarge,
    maxWidth: '680px',
    backgroundColor: tokens.colorNeutralBackground2,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },
  bubbleUser: {
    backgroundColor: tokens.colorBrandBackground2,
    color: tokens.colorNeutralForeground1,
  },
  bubbleError: {
    backgroundColor: tokens.colorStatusDangerBackground1,
    border: `1px solid ${tokens.colorStatusDangerBorder1}`,
  },
  cites: {
    marginTop: tokens.spacingVerticalM,
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXS,
  },
  citesLabel: {
    color: tokens.colorNeutralForeground3,
    fontWeight: tokens.fontWeightSemibold,
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
  },
  cite: {
    fontFamily: 'var(--loom-font-mono, Cascadia Code, Consolas, monospace)',
    fontSize: tokens.fontSizeBase200,
    padding: tokens.spacingVerticalS,
    paddingLeft: tokens.spacingHorizontalM,
    backgroundColor: tokens.colorNeutralBackground3,
    borderLeft: `3px solid ${tokens.colorBrandStroke1}`,
    borderRadius: tokens.borderRadiusSmall,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },
  citeHead: { fontWeight: tokens.fontWeightSemibold, marginBottom: '2px' },
  citeMeta: { color: tokens.colorNeutralForeground3 },

  // --- composer (pinned) -------------------------------------------------
  composer: {
    flexShrink: 0,
    display: 'flex',
    alignItems: 'flex-end',
    gap: tokens.spacingHorizontalS,
    padding: tokens.spacingHorizontalL,
    paddingBottom: tokens.spacingVerticalS,
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    // Subtle upward elevation so the pinned bar reads as layered above the
    // scrolling transcript.
    boxShadow: '0 -2px 8px rgba(0,0,0,0.04)',
  },
  composerInput: { flex: 1, minWidth: 0 },
  composerHint: {
    flexShrink: 0,
    color: tokens.colorNeutralForeground4,
    paddingLeft: tokens.spacingHorizontalL,
    paddingRight: tokens.spacingHorizontalL,
    paddingBottom: tokens.spacingVerticalS,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  dialogField: { marginBottom: tokens.spacingVerticalM },
});

const STARTERS = [
  'What are the top 5 products by revenue this quarter?',
  'Show total orders by region.',
  'Which customers churned last month?',
];

// ---------------------------------------------------------------------------
// Pane
// ---------------------------------------------------------------------------

export function DataAgentPane() {
  const s = useStyles();
  const router = useRouter();

  const [agents, setAgents] = useState<AgentItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

  const [workspaces, setWorkspaces] = useState<WorkspaceRow[]>([]);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [gate, setGate] = useState<NotConfigured | null>(null);

  // Dialog state
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createWs, setCreateWs] = useState('');
  const [createBusy, setCreateBusy] = useState(false);
  const [createErr, setCreateErr] = useState<string | null>(null);

  const [renameTarget, setRenameTarget] = useState<AgentItem | null>(null);
  const [renameName, setRenameName] = useState('');
  const [renameBusy, setRenameBusy] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<AgentItem | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteErr, setDeleteErr] = useState<string | null>(null);

  const transcriptRef = useRef<HTMLDivElement>(null);

  // --- load workspaces (for the create dialog picker) -------------------
  useEffect(() => {
    let cancelled = false;
    fetch('/api/workspaces')
      .then(async (r) => {
        const j = await r.json().catch(() => []);
        if (cancelled) return;
        const rows: WorkspaceRow[] = Array.isArray(j) ? j.map((w: any) => ({ id: w.id, name: w.name })) : [];
        setWorkspaces(rows);
      })
      .catch(() => { if (!cancelled) setWorkspaces([]); });
    return () => { cancelled = true; };
  }, []);

  // --- load the operator's real data agents from the store --------------
  const loadAgents = useCallback(async () => {
    setLoading(true);
    setListError(null);
    try {
      const res = await fetch('/api/items/data-agent', { method: 'GET' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok) {
        setListError(data?.error || `Failed to list data agents (HTTP ${res.status})`);
        setAgents([]);
        return;
      }
      const rows: AgentItem[] = Array.isArray(data.items) ? data.items : [];
      setAgents(rows);
      setSelectedId((cur) => {
        if (cur && rows.some((a) => a.id === cur)) return cur;
        return rows[0]?.id ?? null;
      });
    } catch (e) {
      setListError(e instanceof Error ? e.message : String(e));
      setAgents([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadAgents(); }, [loadAgents]);

  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  const selected = agents.find((a) => a.id === selectedId) || null;

  // Switching agents starts a fresh test conversation.
  function pick(id: string) {
    if (id === selectedId) return;
    setSelectedId(id);
    setMessages([]);
    setGate(null);
  }

  // --- test-chat against the SELECTED real agent ------------------------
  const send = useCallback(
    async (text: string) => {
      const q = text.trim();
      if (!q || sending || !selected) return;

      const userMsg: ChatMessage = { id: crypto.randomUUID(), role: 'user', content: q };
      const pendingId = crypto.randomUUID();
      const history = messages
        .filter((m) => !m.pending && !m.error)
        .map((m) => ({ role: m.role, content: m.content }));
      setMessages((m) => [...m, userMsg, { id: pendingId, role: 'assistant', content: '', pending: true }]);
      setInput('');
      setSending(true);

      try {
        const res = await fetch(`/api/items/data-agent/${encodeURIComponent(selected.id)}/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ question: q, history }),
        });
        const data = await res.json().catch(() => ({}));

        if (res.status === 503 || data?.notDeployed) {
          setGate({ error: data?.error || 'No Azure OpenAI model deployed.', hint: data?.hint });
          setMessages((m) => m.filter((x) => x.id !== pendingId && x.id !== userMsg.id));
          return;
        }
        if (!res.ok || !data?.ok) {
          setMessages((m) =>
            m.map((x) =>
              x.id === pendingId
                ? { ...x, pending: false, error: true, content: `Chat failed (HTTP ${res.status}): ${data?.error || 'unknown error'}` }
                : x,
            ),
          );
          return;
        }
        const answer: string = data.answer || 'The agent completed without returning text.';
        setMessages((m) =>
          m.map((x) =>
            x.id === pendingId
              ? { ...x, pending: false, content: answer, tools: Array.isArray(data.tools) ? data.tools : [] }
              : x,
          ),
        );
      } catch (e) {
        setMessages((m) =>
          m.map((x) =>
            x.id === pendingId
              ? { ...x, pending: false, error: true, content: `Error: ${e instanceof Error ? e.message : String(e)}` }
              : x,
          ),
        );
      } finally {
        setSending(false);
      }
    },
    [sending, selected, messages],
  );

  // --- lifecycle actions -------------------------------------------------
  const openEditor = useCallback((id: string) => { router.push(`/items/data-agent/${id}`); }, [router]);
  const openConfigure = useCallback((id: string) => { router.push(`/items/data-agent/${id}?tab=copilot`); }, [router]);
  const openPublish = useCallback((id: string) => { router.push(`/items/data-agent/${id}?tab=publish`); }, [router]);

  function startCreate() {
    setCreateName('');
    setCreateErr(null);
    setCreateWs(workspaces[0]?.id || '');
    setCreateOpen(true);
  }

  const submitCreate = useCallback(async () => {
    const name = createName.trim();
    if (!name || !createWs) { setCreateErr('Pick a workspace and enter a name.'); return; }
    setCreateBusy(true);
    setCreateErr(null);
    try {
      const r = await fetch('/api/items/data-agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId: createWs, displayName: name }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j?.ok || !j?.item?.id) { setCreateErr(j?.error || `Create failed (HTTP ${r.status})`); return; }
      setCreateOpen(false);
      openEditor(j.item.id);
    } catch (e) {
      setCreateErr(e instanceof Error ? e.message : String(e));
    } finally {
      setCreateBusy(false);
    }
  }, [createName, createWs, openEditor]);

  const duplicate = useCallback(async (agent: AgentItem) => {
    try {
      const r = await fetch('/api/items/data-agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: agent.id }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j?.ok && j?.item?.id) {
        await loadAgents();
        setSelectedId(j.item.id);
        setMessages([]);
      } else {
        setListError(j?.error || `Duplicate failed (HTTP ${r.status})`);
      }
    } catch (e) {
      setListError(e instanceof Error ? e.message : String(e));
    }
  }, [loadAgents]);

  function startRename(agent: AgentItem) {
    setRenameTarget(agent);
    setRenameName(agent.displayName);
  }
  const submitRename = useCallback(async () => {
    if (!renameTarget) return;
    const name = renameName.trim();
    if (!name || name === renameTarget.displayName) { setRenameTarget(null); return; }
    setRenameBusy(true);
    try {
      const r = await fetch(`/api/items/data-agent/${encodeURIComponent(renameTarget.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: name }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j?.ok !== false) {
        setAgents((prev) => prev.map((a) => (a.id === renameTarget.id ? { ...a, displayName: name } : a)));
      } else {
        setListError(j?.error || `Rename failed (HTTP ${r.status})`);
      }
    } catch (e) {
      setListError(e instanceof Error ? e.message : String(e));
    } finally {
      setRenameBusy(false);
      setRenameTarget(null);
    }
  }, [renameTarget, renameName]);

  const submitDelete = useCallback(async () => {
    if (!deleteTarget) return;
    setDeleteBusy(true);
    setDeleteErr(null);
    try {
      const r = await fetch(`/api/items/data-agent/${encodeURIComponent(deleteTarget.id)}`, { method: 'DELETE' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j?.ok === false) { setDeleteErr(j?.error || `Delete failed (HTTP ${r.status})`); return; }
      // Reflect immediately.
      setAgents((prev) => prev.filter((a) => a.id !== deleteTarget.id));
      setSelectedId((cur) => (cur === deleteTarget.id ? null : cur));
      setMessages([]);
      setDeleteTarget(null);
    } catch (e) {
      setDeleteErr(e instanceof Error ? e.message : String(e));
    } finally {
      setDeleteBusy(false);
    }
  }, [deleteTarget]);

  // --- render ------------------------------------------------------------
  return (
    <div className={s.shell}>
      {/* ---------------- LEFT RAIL: real data agents ---------------- */}
      <div className={s.rail}>
        <div className={s.railHead}>
          <ChatMultiple24Regular style={{ color: 'var(--loom-accent-purple)' }} />
          <Text className={s.railTitle}>Data agents</Text>
          <Button
            appearance="subtle"
            size="small"
            icon={<ArrowClockwise20Regular />}
            aria-label="Refresh data agents"
            onClick={() => void loadAgents()}
            disabled={loading}
          />
        </div>
        <div className={s.railActions}>
          <Button appearance="primary" size="small" icon={<Add20Regular />} onClick={startCreate}>
            New data agent
          </Button>
        </div>

        {loading ? (
          <div className={s.railState}>
            <Spinner size="tiny" label="Loading data agents…" />
          </div>
        ) : listError ? (
          <div className={s.railState}>
            <MessageBar intent="error">
              <MessageBarBody>{listError}</MessageBarBody>
            </MessageBar>
            <Button size="small" onClick={() => void loadAgents()}>Retry</Button>
          </div>
        ) : agents.length === 0 ? (
          <div className={s.railState}>
            <Sparkle20Regular className={s.emptyGlyph} />
            <Body1>No data agents yet.</Body1>
            <Caption1>
              Create a governed Q&amp;A agent grounded in your warehouse, lakehouse, semantic models, KQL,
              and more — then test and publish it.
            </Caption1>
            <Button appearance="primary" icon={<Add20Regular />} onClick={startCreate}>
              New data agent
            </Button>
          </div>
        ) : (
          <div className={s.railList} role="listbox" aria-label="Data agents">
            {agents.map((a) => {
              const active = a.id === selectedId;
              const status = deriveStatus(a.state);
              const meta = STATUS_META[status];
              const count = sourceCount(a.state);
              return (
                <div
                  key={a.id}
                  className={mergeClasses(s.agentItem, active && s.agentItemActive)}
                >
                  <span className={s.agentChip} aria-hidden>
                    <ChatMultiple24Regular />
                  </span>
                  <button
                    type="button"
                    role="option"
                    aria-selected={active}
                    className={s.agentBody}
                    onClick={() => pick(a.id)}
                    onDoubleClick={() => openEditor(a.id)}
                  >
                    <span className={s.agentNameRow}>
                      <Text className={s.agentName} title={a.displayName}>{a.displayName}</Text>
                      <Badge appearance="tint" color={meta.color} size="small">{meta.label}</Badge>
                    </span>
                    <span className={s.agentMetaRow}>
                      <Caption1><Database16Regular style={{ verticalAlign: 'middle' }} /> {count} source{count === 1 ? '' : 's'}</Caption1>
                      <Caption1>· {relTime(a.updatedAt)}</Caption1>
                    </span>
                  </button>
                  <Menu>
                    <MenuTrigger disableButtonEnhancement>
                      <Button
                        appearance="subtle"
                        size="small"
                        icon={<MoreHorizontal20Regular />}
                        aria-label={`Actions for ${a.displayName}`}
                      />
                    </MenuTrigger>
                    <MenuPopover>
                      <MenuList>
                        <MenuItem icon={<Open16Regular />} onClick={() => openEditor(a.id)}>Open</MenuItem>
                        <MenuItem icon={<Settings20Regular />} onClick={() => openConfigure(a.id)}>Configure &amp; enhance</MenuItem>
                        <MenuItem icon={<CloudArrowUp16Regular />} onClick={() => openPublish(a.id)}>Publish…</MenuItem>
                        <MenuDivider />
                        <MenuItem icon={<Rename16Regular />} onClick={() => startRename(a)}>Rename</MenuItem>
                        <MenuItem icon={<Copy16Regular />} onClick={() => void duplicate(a)}>Duplicate</MenuItem>
                        <MenuDivider />
                        <MenuItem icon={<Delete16Regular />} onClick={() => { setDeleteErr(null); setDeleteTarget(a); }}>Delete</MenuItem>
                      </MenuList>
                    </MenuPopover>
                  </Menu>
                </div>
              );
            })}
          </div>
        )}

        <div className={s.railFoot}>
          <Caption1 className={s.footText}>
            Your real data agents. Cross-item orchestration lives at{' '}
            <Link href="/copilot">/copilot</Link>.
          </Caption1>
        </div>
      </div>

      {/* ---------------- CHAT / DETAIL COLUMN ---------------- */}
      <div className={s.chat}>
        <div className={s.chatHead}>
          <Avatar
            icon={<Bot24Regular />}
            color="colorful"
            style={{ backgroundColor: 'var(--loom-accent-purple)', color: '#fff' }}
            aria-hidden
          />
          <div className={s.chatHeadMeta}>
            <div className={s.chatHeadTitleRow}>
              <Text className={s.chatHeadTitle}>{selected ? selected.displayName : 'Data agent'}</Text>
              {selected && (
                <Badge appearance="tint" color={STATUS_META[deriveStatus(selected.state)].color} size="small">
                  {STATUS_META[deriveStatus(selected.state)].label}
                </Badge>
              )}
            </div>
            <Caption1 className={s.chatHeadSub}>
              {selected
                ? 'Test chat — every query runs read-only under your Entra identity (RLS/CLS applies).'
                : 'Select a data agent on the left, or create one.'}
            </Caption1>
          </div>
          {selected && (
            <div className={s.chatHeadActions}>
              {messages.length > 0 && (
                <Button appearance="subtle" size="small" onClick={() => setMessages([])} disabled={sending}>
                  New chat
                </Button>
              )}
              <Button appearance="subtle" size="small" icon={<Settings20Regular />} onClick={() => openConfigure(selected.id)}>
                Configure
              </Button>
              <Button appearance="secondary" size="small" icon={<Open16Regular />} onClick={() => openEditor(selected.id)}>
                Open editor
              </Button>
            </div>
          )}
        </div>

        {/* Honest infra-gate — full surface still renders. */}
        {gate && (
          <MessageBar intent="warning" className={s.gateBar}>
            <MessageBarBody>
              <MessageBarTitle>No Azure OpenAI model deployed</MessageBarTitle>
              {gate.hint || gate.error}
            </MessageBarBody>
            <MessageBarActions>
              {selected && (
                <Button appearance="primary" onClick={() => openEditor(selected.id)}>Open editor</Button>
              )}
            </MessageBarActions>
          </MessageBar>
        )}

        <div className={s.transcript} ref={transcriptRef}>
          {!selected ? (
            <div className={s.empty}>
              <Sparkle20Regular className={s.emptyGlyph} />
              <Body1>Select a data agent to test it, or create a new one.</Body1>
              <Button appearance="primary" icon={<Add20Regular />} onClick={startCreate}>New data agent</Button>
            </div>
          ) : messages.length === 0 ? (
            <div className={s.empty}>
              <Sparkle20Regular className={s.emptyGlyph} />
              <Body1>Ask {selected.displayName} a question about your data.</Body1>
              <div className={s.starters}>
                {STARTERS.map((q) => (
                  <Button key={q} appearance="outline" size="small" onClick={() => void send(q)} disabled={sending}>
                    {q}
                  </Button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((m) => (
              <div key={m.id} className={mergeClasses(s.msg, m.role === 'user' && s.msgUser)}>
                <Avatar
                  icon={m.role === 'assistant' ? <Bot24Regular /> : <Person24Regular />}
                  color={m.role === 'assistant' ? 'brand' : 'neutral'}
                  aria-hidden
                />
                <div className={mergeClasses(s.bubble, m.role === 'user' && s.bubbleUser, m.error && s.bubbleError)}>
                  {m.pending ? (
                    <Spinner size="tiny" label="Running query…" />
                  ) : (
                    <Body1>{m.content}</Body1>
                  )}

                  {m.tools && m.tools.length > 0 && (
                    <div className={s.cites}>
                      <Caption1 className={s.citesLabel}>
                        <Database16Regular /> How this was answered ({m.tools.length} source{m.tools.length === 1 ? '' : 's'})
                      </Caption1>
                      {m.tools.map((tc, i) => (
                        <div key={i} className={s.cite}>
                          <div className={s.citeHead}>
                            {(tc.source || tc.type || 'source').toUpperCase()} · {tc.action}
                            {tc.executed ? ` · ${tc.rowCount ?? 0} row${tc.rowCount === 1 ? '' : 's'}` : ''}
                          </div>
                          {tc.query && <div>{tc.query}</div>}
                          {tc.gate && <div className={s.citeMeta}>⚠ {tc.gate}</div>}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))
          )}
        </div>

        {/* Composer — PINNED at the bottom; Send always visible. */}
        <div className={s.composer}>
          <Textarea
            className={s.composerInput}
            resize="none"
            value={input}
            onChange={(_, d) => setInput(d.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(input); }
            }}
            placeholder={selected ? `Ask ${selected.displayName}…` : 'Select a data agent to start.'}
            disabled={sending || !selected}
            aria-label="Ask the data agent"
          />
          <Button
            appearance="primary"
            icon={sending ? <Spinner size="tiny" /> : <Send24Filled />}
            onClick={() => void send(input)}
            disabled={sending || !selected || !input.trim()}
          >
            Send
          </Button>
        </div>
        <Caption1 className={s.composerHint}>
          Enter to send · Shift+Enter for a new line. Answers are generated by an LLM and may be
          imprecise — verify before acting.
        </Caption1>
      </div>

      {/* ---------------- New / Create dialog ---------------- */}
      <Dialog open={createOpen} onOpenChange={(_, d) => setCreateOpen(d.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>New data agent</DialogTitle>
            <DialogContent>
              <Field label="Workspace" required className={s.dialogField}>
                <Dropdown
                  placeholder={workspaces.length ? 'Select a workspace' : 'No workspaces found'}
                  value={workspaces.find((w) => w.id === createWs)?.name || ''}
                  selectedOptions={createWs ? [createWs] : []}
                  onOptionSelect={(_, d) => setCreateWs(d.optionValue || '')}
                >
                  {workspaces.map((w) => <Option key={w.id} value={w.id} text={w.name}>{w.name}</Option>)}
                </Dropdown>
              </Field>
              <Field label="Name" required className={s.dialogField}>
                <Input
                  value={createName}
                  placeholder="e.g. Casino Revenue Analyst"
                  maxLength={200}
                  onChange={(_, d) => setCreateName(d.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void submitCreate(); }}
                />
              </Field>
              {createErr && (
                <MessageBar intent="error"><MessageBarBody>{createErr}</MessageBarBody></MessageBar>
              )}
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setCreateOpen(false)} disabled={createBusy}>Cancel</Button>
              <Button appearance="primary" onClick={() => void submitCreate()} disabled={createBusy || !createName.trim() || !createWs}>
                {createBusy ? 'Creating…' : 'Create & open'}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* ---------------- Rename dialog ---------------- */}
      <Dialog open={!!renameTarget} onOpenChange={(_, d) => { if (!d.open) setRenameTarget(null); }}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Rename data agent</DialogTitle>
            <DialogContent>
              <Field label="Name" required>
                <Input
                  value={renameName}
                  maxLength={200}
                  onChange={(_, d) => setRenameName(d.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void submitRename(); }}
                />
              </Field>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setRenameTarget(null)} disabled={renameBusy}>Cancel</Button>
              <Button appearance="primary" onClick={() => void submitRename()} disabled={renameBusy || !renameName.trim()}>
                {renameBusy ? 'Saving…' : 'Rename'}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* ---------------- Delete confirm dialog ---------------- */}
      <Dialog open={!!deleteTarget} onOpenChange={(_, d) => { if (!d.open) setDeleteTarget(null); }}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Delete data agent</DialogTitle>
            <DialogContent>
              <Body1>
                Delete <strong>{deleteTarget?.displayName}</strong>? This removes the agent from the store
                {deleteTarget && deriveStatus(deleteTarget.state) !== 'draft'
                  ? ' and de-provisions its published backing (Azure AI Foundry / Microsoft 365 Copilot)'
                  : ''}. This cannot be undone.
              </Body1>
              {deleteErr && (
                <MessageBar intent="error" style={{ marginTop: tokens.spacingVerticalM }}>
                  <MessageBarBody>{deleteErr}</MessageBarBody>
                </MessageBar>
              )}
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setDeleteTarget(null)} disabled={deleteBusy}>Cancel</Button>
              <Button
                appearance="primary"
                style={{ backgroundColor: tokens.colorStatusDangerBackground3 }}
                onClick={() => void submitDelete()}
                disabled={deleteBusy}
              >
                {deleteBusy ? 'Deleting…' : 'Delete'}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
}
