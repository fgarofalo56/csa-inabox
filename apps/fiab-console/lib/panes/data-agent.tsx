'use client';

/**
 * DataAgentPane — Loom's one-for-one of the Fabric / Foundry "data agent"
 * consumption experience.
 *
 * Intended Fabric/Foundry UX (grounded in Microsoft Learn — "Consume Fabric
 * data agent from Microsoft Foundry Services" + "Fabric data agent concepts"):
 * a data agent is a published, conversational Q&A surface grounded in governed
 * data (warehouse / lakehouse / semantic model / KQL / mirrored / ontology).
 * The consumer picks one PUBLISHED agent from a list, asks plain-language
 * questions, and gets a structured answer. Under the hood the agent parses the
 * question, picks the right source, generates + executes a read-only query
 * (NL2SQL / NL2DAX / NL2KQL), and returns the answer — and you can inspect the
 * run STEPS to see exactly which tool/query produced it.
 *
 * Loom layout (Web 3.0): a two-pane shell —
 *   • LEFT RAIL — selectable list of real published Foundry agents
 *     (GET /api/foundry/agents → listAgents → real Agent Service REST).
 *   • RIGHT — a chat surface whose composer is PINNED at the bottom (Send is
 *     always visible, never scroll-to-find). Each turn runs the question
 *     through the selected agent (POST /api/data-agent/run-steps →
 *     runAgentAndInspect: thread → message → run → poll → steps) and renders
 *     the answer plus the run steps (the SQL/KQL/tool calls) as citations.
 *
 * Both backends are gated by LOOM_FOUNDRY_PROJECT_ENDPOINT. When unset, the
 * route returns 501 code:'not_configured' and this pane renders an honest
 * Fluent MessageBar naming the exact env var + bicep module. No mock agents,
 * no fake answers, no dead Send button. See .claude/rules/no-vaporware.md.
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import Link from 'next/link';
import {
  Body1,
  Caption1,
  Text,
  makeStyles,
  tokens,
  Button,
  Textarea,
  Avatar,
  Spinner,
  Badge,
  Dropdown,
  Option,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  MessageBarActions,
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
  Settings20Regular,
} from '@fluentui/react-icons';
import { WorkspaceAgentConfigDialog } from './workspace-agent-config-dialog';

// ---------------------------------------------------------------------------
// Wire types — mirror the BFF route shapes.
// ---------------------------------------------------------------------------

interface FoundryAgentRow {
  name: string;
  description?: string;
  metadata?: Record<string, string>;
}

interface WorkspaceRow {
  id: string;
  name: string;
}

interface RunStepToolCall {
  type: string;
  name?: string;
  input?: string;
  output?: string;
}

interface RunStep {
  id: string;
  type: string;
  status: string;
  toolCalls: RunStepToolCall[];
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  steps?: RunStep[];
  status?: string;
  pending?: boolean;
  error?: boolean;
}

/** Honest infra-gate payload (HTTP 501 from the BFF). */
interface NotConfigured {
  error: string;
  hint?: string;
  missing?: string;
}

const FOUNDRY_BICEP = 'platform/fiab/bicep/modules/ai/foundry-project.bicep';

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const useStyles = makeStyles({
  // Full-height two-pane shell. Composer is pinned because the chat column is
  // its own flex container with an overflow:auto transcript above it.
  shell: {
    display: 'grid',
    gridTemplateColumns: '300px 1fr',
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
    ':focus-visible': {
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
    backgroundColor: 'rgba(75,29,143,0.12)', // fabric-iq deep purple tint
    color: 'var(--loom-accent-purple)',
  },
  agentMeta: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0, flex: 1 },
  agentName: {
    fontWeight: tokens.fontWeightSemibold,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  agentDesc: {
    color: tokens.colorNeutralForeground3,
    display: '-webkit-box',
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
  },
  railFoot: {
    padding: tokens.spacingVerticalS,
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  railState: {
    padding: tokens.spacingVerticalL,
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    alignItems: 'center',
    textAlign: 'center',
    color: tokens.colorNeutralForeground3,
  },

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
  chatHeadMeta: { display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 },
  chatHeadTitle: {
    fontWeight: tokens.fontWeightSemibold,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
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
  emptyGlyph: { color: 'var(--loom-accent-purple)', opacity: 0.85 },
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
  steps: {
    marginTop: tokens.spacingVerticalM,
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXS,
  },
  stepsLabel: {
    color: tokens.colorNeutralForeground3,
    fontWeight: tokens.fontWeightSemibold,
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
  },
  step: {
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
  stepHead: { fontWeight: tokens.fontWeightSemibold, marginBottom: '2px' },
  runStatus: { color: tokens.colorNeutralForeground3, marginTop: '4px' },

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

  const [agents, setAgents] = useState<FoundryAgentRow[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [loadingAgents, setLoadingAgents] = useState(true);
  const [gate, setGate] = useState<NotConfigured | null>(null);
  const [listError, setListError] = useState<string | null>(null);

  // Workspace scoping — a workspace can target its own Foundry project/agent.
  const [workspaces, setWorkspaces] = useState<WorkspaceRow[]>([]);
  const [workspaceId, setWorkspaceId] = useState<string>('');
  const [configOpen, setConfigOpen] = useState(false);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);

  const transcriptRef = useRef<HTMLDivElement>(null);

  // --- load the user's workspaces (so data agents can be workspace-scoped) ---
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

  // --- load real published agents from Foundry --------------------------
  const loadAgents = useCallback(async () => {
    setLoadingAgents(true);
    setGate(null);
    setListError(null);
    try {
      const qs = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : '';
      const res = await fetch(`/api/foundry/agents${qs}`, { method: 'GET' });
      const data = await res.json().catch(() => ({}));
      if (res.status === 501 || data?.code === 'not_configured') {
        setGate({ error: data?.error || 'Foundry Agent Service not configured', hint: data?.hint, missing: data?.missing });
        setAgents([]);
        return;
      }
      if (!res.ok || !data?.ok) {
        setListError(data?.error || `Failed to list agents (HTTP ${res.status})`);
        setAgents([]);
        return;
      }
      const rows: FoundryAgentRow[] = Array.isArray(data.agents) ? data.agents : [];
      setAgents(rows);
      const preferred: string | undefined = data?.defaultAgent;
      setSelected((cur) => {
        if (cur && rows.some((a) => a.name === cur)) return cur;
        if (preferred && rows.some((a) => a.name === preferred)) return preferred;
        return rows[0]?.name ?? null;
      });
    } catch (e) {
      setListError(e instanceof Error ? e.message : String(e));
      setAgents([]);
    } finally {
      setLoadingAgents(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    void loadAgents();
  }, [loadAgents]);

  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  // Switching agents starts a fresh conversation (each Foundry run is a new thread).
  function pick(name: string) {
    if (name === selected) return;
    setSelected(name);
    setMessages([]);
  }

  // --- ask the selected agent (real run-steps backend) ------------------
  const send = useCallback(
    async (text: string) => {
      const q = text.trim();
      if (!q || sending || !selected) return;

      const userMsg: ChatMessage = { id: crypto.randomUUID(), role: 'user', content: q };
      const pendingId = crypto.randomUUID();
      const pendingMsg: ChatMessage = {
        id: pendingId,
        role: 'assistant',
        content: '',
        pending: true,
        status: 'running',
      };
      setMessages((m) => [...m, userMsg, pendingMsg]);
      setInput('');
      setSending(true);

      try {
        const res = await fetch('/api/data-agent/run-steps', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agent: selected, question: q, workspaceId: workspaceId || undefined }),
        });
        const data = await res.json().catch(() => ({}));

        if (res.status === 501 || data?.code === 'not_configured') {
          setGate({ error: data?.error || 'Foundry Agent Service not configured', hint: data?.hint, missing: data?.missing });
          setMessages((m) => m.filter((x) => x.id !== pendingId && x.id !== userMsg.id));
          return;
        }

        if (!res.ok || !data?.ok) {
          setMessages((m) =>
            m.map((x) =>
              x.id === pendingId
                ? { ...x, pending: false, error: true, content: `Run failed (HTTP ${res.status}): ${data?.error || 'unknown error'}` }
                : x,
            ),
          );
          return;
        }

        const run = data.data || {};
        const answer: string =
          run.answer ||
          (run.status === 'completed'
            ? 'The agent completed without returning text.'
            : `Run ended with status "${run.status}".${run.lastError ? ` ${run.lastError}` : ''}`);
        setMessages((m) =>
          m.map((x) =>
            x.id === pendingId
              ? {
                  ...x,
                  pending: false,
                  content: answer,
                  steps: Array.isArray(run.steps) ? run.steps : [],
                  status: run.status,
                  error: run.status !== 'completed',
                }
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
    [sending, selected, workspaceId],
  );

  const selectedAgent = agents.find((a) => a.name === selected) || null;

  return (
    <div className={s.shell}>
      {/* ---------------- LEFT RAIL: selectable agents ---------------- */}
      <div className={s.rail}>
        <div className={s.railHead}>
          <ChatMultiple24Regular style={{ color: 'var(--loom-accent-purple)' }} />
          <Text className={s.railTitle}>Data agents</Text>
          {workspaceId && (
            <Button
              appearance="subtle"
              size="small"
              icon={<Settings20Regular />}
              aria-label="Configure workspace data agents"
              title="Configure which Foundry agent / models this workspace uses"
              onClick={() => setConfigOpen(true)}
            />
          )}
          <Button
            appearance="subtle"
            size="small"
            icon={<ArrowClockwise20Regular />}
            aria-label="Refresh agents"
            onClick={() => void loadAgents()}
            disabled={loadingAgents}
          />
        </div>

        {/* Workspace scope selector — pick the workspace whose data agents to use. */}
        <div style={{ padding: tokens.spacingVerticalS, borderBottom: `1px solid ${tokens.colorNeutralStroke2}` }}>
          <Dropdown
            size="small"
            placeholder="All / tenant default"
            value={workspaces.find((w) => w.id === workspaceId)?.name || ''}
            selectedOptions={workspaceId ? [workspaceId] : []}
            onOptionSelect={(_, d) => { setWorkspaceId(d.optionValue === '__all__' ? '' : (d.optionValue || '')); setMessages([]); }}
            aria-label="Workspace scope"
            style={{ width: '100%' }}
          >
            <Option value="__all__" text="All / tenant default">All / tenant default</Option>
            {workspaces.map((w) => <Option key={w.id} value={w.id} text={w.name}>{w.name}</Option>)}
          </Dropdown>
        </div>

        {loadingAgents ? (
          <div className={s.railState}>
            <Spinner size="tiny" label="Loading agents…" />
          </div>
        ) : gate ? (
          <div className={s.railState}>
            <Caption1>No agents — backend not configured. See the gate on the right.</Caption1>
          </div>
        ) : listError ? (
          <div className={s.railState}>
            <Caption1>Could not load agents.</Caption1>
            <Button size="small" onClick={() => void loadAgents()}>Retry</Button>
          </div>
        ) : agents.length === 0 ? (
          <div className={s.railState}>
            <Caption1>
              No published agents in this Foundry project yet. Build and publish a data agent from the
              Data Agent editor, then refresh.
            </Caption1>
          </div>
        ) : (
          <div className={s.railList} role="listbox" aria-label="Data agents">
            {agents.map((a) => {
              const active = a.name === selected;
              return (
                <button
                  key={a.name}
                  type="button"
                  role="option"
                  aria-selected={active}
                  className={mergeClasses(s.agentItem, active && s.agentItemActive)}
                  onClick={() => pick(a.name)}
                >
                  <span className={s.agentChip} aria-hidden>
                    <ChatMultiple24Regular />
                  </span>
                  <span className={s.agentMeta}>
                    <Text className={s.agentName} title={a.name}>{a.name}</Text>
                    {a.description && (
                      <Caption1 className={s.agentDesc} title={a.description}>{a.description}</Caption1>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        )}

        <div className={s.railFoot}>
          <Caption1 style={{ color: tokens.colorNeutralForeground4 }}>
            Published agents from the Foundry project. Cross-item orchestration lives at{' '}
            <Link href="/copilot">/copilot</Link>.
          </Caption1>
        </div>
      </div>

      {/* ---------------- CHAT COLUMN ---------------- */}
      <div className={s.chat}>
        <div className={s.chatHead}>
          <Avatar
            icon={<Bot24Regular />}
            color="colorful"
            style={{ backgroundColor: 'var(--loom-accent-purple)', color: '#fff' }}
            aria-hidden
          />
          <div className={s.chatHeadMeta}>
            <Text className={s.chatHeadTitle}>
              {selectedAgent ? selectedAgent.name : 'Data agent'}
            </Text>
            <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
              Conversational Q&A grounded in your warehouse, lakehouse, semantic models, and KQL — every
              query runs read-only under your Entra identity (RLS/CLS applies).
            </Caption1>
          </div>
          {messages.length > 0 && (
            <Button appearance="subtle" size="small" onClick={() => setMessages([])} disabled={sending}>
              New chat
            </Button>
          )}
        </div>

        {/* Honest infra-gate — full surface still renders. */}
        {gate && (
          <MessageBar intent="warning" style={{ flexShrink: 0, margin: tokens.spacingHorizontalL, marginBottom: 0 }}>
            <MessageBarBody>
              <MessageBarTitle>Foundry Agent Service not configured</MessageBarTitle>
              {gate.hint || gate.error}
              <div style={{ marginTop: 6, fontSize: 12 }}>
                Required env: <code>{gate.missing || 'LOOM_FOUNDRY_PROJECT_ENDPOINT'}</code>
                {' · '}Bicep: <code>{FOUNDRY_BICEP}</code>
              </div>
            </MessageBarBody>
            <MessageBarActions>
              <Link href="/copilot">
                <Button appearance="primary">Open Copilot orchestrator</Button>
              </Link>
            </MessageBarActions>
          </MessageBar>
        )}

        <div className={s.transcript} ref={transcriptRef}>
          {messages.length === 0 ? (
            <div className={s.empty}>
              <Sparkle20Regular className={s.emptyGlyph} style={{ width: 40, height: 40 }} />
              <Body1>
                {gate
                  ? 'Configure the Foundry project endpoint to chat with your published data agents.'
                  : selected
                    ? `Ask ${selected} a question about your data.`
                    : 'Select a data agent on the left to begin.'}
              </Body1>
              {!gate && selected && (
                <div className={s.starters}>
                  {STARTERS.map((q) => (
                    <Button key={q} appearance="outline" size="small" onClick={() => void send(q)} disabled={sending}>
                      {q}
                    </Button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            messages.map((m) => (
              <div key={m.id} className={mergeClasses(s.msg, m.role === 'user' && s.msgUser)}>
                <Avatar
                  icon={m.role === 'assistant' ? <Bot24Regular /> : <Person24Regular />}
                  color={m.role === 'assistant' ? 'brand' : 'neutral'}
                  aria-hidden
                />
                <div
                  className={mergeClasses(
                    s.bubble,
                    m.role === 'user' && s.bubbleUser,
                    m.error && s.bubbleError,
                  )}
                >
                  {m.pending ? (
                    <Spinner size="tiny" label="Running query…" />
                  ) : (
                    <Body1>{m.content}</Body1>
                  )}

                  {m.steps && m.steps.length > 0 && (
                    <div className={s.steps}>
                      <Caption1 className={s.stepsLabel}>
                        <Database16Regular /> How this was answered ({m.steps.length} run step
                        {m.steps.length === 1 ? '' : 's'})
                      </Caption1>
                      {m.steps.map((step) =>
                        step.toolCalls.length > 0 ? (
                          step.toolCalls.map((tc, i) => (
                            <div key={`${step.id}-${i}`} className={s.step}>
                              <div className={s.stepHead}>
                                {(tc.name || tc.type).toUpperCase()} · {step.status}
                              </div>
                              {tc.input && <div>{tc.input}</div>}
                              {tc.output && (
                                <div style={{ color: tokens.colorNeutralForeground3 }}>
                                  → {tc.output.slice(0, 600)}
                                </div>
                              )}
                            </div>
                          ))
                        ) : (
                          <div key={step.id} className={s.step}>
                            <div className={s.stepHead}>
                              {step.type.toUpperCase()} · {step.status}
                            </div>
                          </div>
                        ),
                      )}
                    </div>
                  )}

                  {!m.pending && m.role === 'assistant' && m.status && m.status !== 'completed' && (
                    <Caption1 className={s.runStatus}>Run status: {m.status}</Caption1>
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
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send(input);
              }
            }}
            placeholder={
              gate
                ? 'Backend not configured — see the warning above.'
                : selected
                  ? `Ask ${selected}…`
                  : 'Select a data agent to start.'
            }
            disabled={sending || !!gate || !selected}
            aria-label="Ask the data agent"
          />
          <Button
            appearance="primary"
            icon={sending ? <Spinner size="tiny" /> : <Send24Filled />}
            onClick={() => void send(input)}
            disabled={sending || !!gate || !selected || !input.trim()}
          >
            Send
          </Button>
        </div>
        <Caption1 className={s.composerHint}>
          Enter to send · Shift+Enter for a new line. Answers are generated by an LLM and may be
          imprecise — verify before acting.
          {selectedAgent && (
            <> · <Badge appearance="tint" color="brand" size="small">Published agent</Badge></>
          )}
        </Caption1>
      </div>

      {workspaceId && (
        <WorkspaceAgentConfigDialog
          open={configOpen}
          onOpenChange={setConfigOpen}
          workspaceId={workspaceId}
          agents={agents}
          onSaved={() => { setConfigOpen(false); void loadAgents(); }}
        />
      )}
    </div>
  );
}
