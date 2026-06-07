'use client';

/**
 * CopilotPane — the persistent, context-aware Copilot chat drawer docked on the
 * right of the Notebook editor (~25% width). It is the notebook-native sibling
 * of the cross-item Copilot, and the Loom parity surface for the Fabric Notebook
 * Copilot sidebar — but Azure-native (no Fabric Copilot dependency).
 *
 * What it does (per ui-parity / no-vaporware):
 *  - Shows the running chat history + the live STREAMING response.
 *  - Slash-command menu: /fix /explain /comments /optimize (a fixed allowlist,
 *    no free-form config). Typing `/` opens it; selecting fills the input.
 *  - Context builder: sends the CURRENT cell + the prior 5 cells; the server
 *    appends the lakehouse datastore schema (Delta column names + types).
 *  - Streams a real Azure OpenAI answer via POST /api/copilot/notebook-assist
 *    (SSE), referencing the user's actual variable + column names.
 *  - Multi-cell / code answers render with an Apply-to-notebook control that
 *    writes the parsed code blocks back into the notebook cells.
 *  - Honest gate: a 503 `no_aoai` surfaces as a Fluent MessageBar naming the
 *    exact admin action — the rest of the notebook keeps working.
 *  - "Previous sessions" reuses GET /api/copilot/sessions (the same store).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  InlineDrawer, DrawerHeader, DrawerHeaderTitle, DrawerBody,
  Button, Input, Spinner, Badge, Caption1, Subtitle2, Body1, Divider,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Dismiss20Regular, Send20Regular, Sparkle20Regular, History20Regular,
  Checkmark16Regular,
} from '@fluentui/react-icons';
import type { NotebookCell, NotebookCellLang } from '@/lib/types/notebook-cell';

interface AttachedSource {
  kind: 'lakehouse' | 'warehouse' | 'kql-database';
  id: string;
  displayName: string;
  isDefault?: boolean;
}

export interface CopilotPaneProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  notebookId: string;
  workspaceId: string;
  cells: NotebookCell[];
  activeCellId: string | null;
  attachedSources: AttachedSource[];
  defaultLang: NotebookCellLang;
  /** Apply parsed code blocks back into the notebook, starting at the active
   *  cell and walking backwards for multi-block answers. */
  onApplyCells?: (updated: { source: string }[]) => void;
}

const SLASH_COMMANDS: { cmd: string; label: string; help: string }[] = [
  { cmd: '/fix', label: '/fix', help: 'Fix the error in the current cell' },
  { cmd: '/explain', label: '/explain', help: 'Explain what the current cell does' },
  { cmd: '/comments', label: '/comments', help: 'Add inline comments to the current cell' },
  { cmd: '/optimize', label: '/optimize', help: 'Rewrite the current cell for performance' },
];

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  /** Parsed fenced code blocks (for the assistant's Apply affordance). */
  codeBlocks?: string[];
}

interface SessionSummary {
  id: string;
  sessionId: string;
  prompt: string;
  updatedAt: string;
  stepCount: number;
}

const useStyles = makeStyles({
  drawer: {
    width: '25%',
    minWidth: '320px',
    maxWidth: '560px',
    borderLeft: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  body: { display: 'flex', flexDirection: 'column', gap: '8px', height: '100%', minHeight: 0 },
  history: { flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '10px', paddingRight: '4px' },
  bubbleUser: {
    alignSelf: 'flex-end', maxWidth: '92%',
    backgroundColor: tokens.colorBrandBackground2,
    color: tokens.colorNeutralForeground1,
    borderRadius: '8px', padding: '6px 10px', fontSize: '13px', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
  },
  bubbleAssistant: {
    alignSelf: 'flex-start', maxWidth: '98%',
    backgroundColor: tokens.colorNeutralBackground3,
    borderRadius: '8px', padding: '8px 10px', fontSize: '13px',
    whiteSpace: 'pre-wrap', wordBreak: 'break-word',
  },
  code: {
    fontFamily: 'Consolas, "Cascadia Code", monospace', fontSize: '12px',
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: '4px',
    padding: '8px', overflowX: 'auto', whiteSpace: 'pre', margin: '6px 0',
  },
  inputRow: { display: 'flex', flexDirection: 'column', gap: '4px' },
  slashMenu: {
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: '6px',
    backgroundColor: tokens.colorNeutralBackground1, overflow: 'hidden',
  },
  slashItem: {
    display: 'flex', flexDirection: 'column', gap: '0px',
    padding: '6px 10px', cursor: 'pointer',
    ':hover': { backgroundColor: tokens.colorNeutralBackground2 },
  },
  slashItemActive: { backgroundColor: tokens.colorBrandBackground2 },
  sessions: { display: 'flex', flexDirection: 'column', gap: '4px', maxHeight: '160px', overflowY: 'auto' },
  sessionRow: {
    display: 'flex', flexDirection: 'column', padding: '4px 6px', borderRadius: '4px', cursor: 'default',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
});

/** Pull ```lang\n...\n``` fenced blocks out of a model answer. */
function parseCodeBlocks(text: string): string[] {
  const blocks: string[] = [];
  const re = /```[a-zA-Z0-9_+-]*\s*\n?([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const code = m[1].replace(/\n+$/, '');
    if (code.trim()) blocks.push(code);
  }
  return blocks;
}

/** Split an answer into ordered text/code segments for rendering. */
function segments(text: string): { type: 'text' | 'code'; value: string }[] {
  const out: { type: 'text' | 'code'; value: string }[] = [];
  const re = /```[a-zA-Z0-9_+-]*\s*\n?([\s\S]*?)```/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push({ type: 'text', value: text.slice(last, m.index) });
    out.push({ type: 'code', value: m[1].replace(/\n+$/, '') });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ type: 'text', value: text.slice(last) });
  return out;
}

export function CopilotPane({
  open, onOpenChange, notebookId, workspaceId, cells, activeCellId, attachedSources, defaultLang, onApplyCells,
}: CopilotPaneProps) {
  const s = useStyles();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [streamText, setStreamText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [noAoai, setNoAoai] = useState<string | null>(null);
  const [slashIdx, setSlashIdx] = useState(0);
  const [showSessions, setShowSessions] = useState(false);
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const sessionIdRef = useRef<string>(
    typeof crypto !== 'undefined' && crypto.randomUUID
      ? `nbcopilot-${crypto.randomUUID()}`
      : `nbcopilot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  const abortRef = useRef<AbortController | null>(null);
  const historyEndRef = useRef<HTMLDivElement | null>(null);

  const slashOpen = input.startsWith('/') && !input.includes(' ');
  const slashMatches = useMemo(
    () => (slashOpen ? SLASH_COMMANDS.filter((c) => c.cmd.startsWith(input.toLowerCase())) : []),
    [slashOpen, input],
  );

  useEffect(() => {
    historyEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamText]);

  // Lazy-load previous sessions when the user expands the section.
  const loadSessions = useCallback(async () => {
    try {
      const r = await fetch('/api/copilot/sessions');
      const j = await r.json();
      if (j.ok) setSessions(j.sessions || []);
      else setSessions([]);
    } catch {
      setSessions([]);
    }
  }, []);

  useEffect(() => {
    if (showSessions && sessions === null) void loadSessions();
  }, [showSessions, sessions, loadSessions]);

  // Assemble the current cell + prior 5 cells for the context builder.
  const contextCells = useCallback((): NotebookCell[] => {
    const idx = activeCellId ? cells.findIndex((c) => c.id === activeCellId) : cells.length - 1;
    const end = idx >= 0 ? idx : cells.length - 1;
    const start = Math.max(0, end - 5);
    return cells.slice(start, end + 1);
  }, [cells, activeCellId]);

  const send = useCallback(
    async (rawText: string) => {
      const text = rawText.trim();
      if (!text || streaming) return;

      // Parse a leading slash command into {command, errorText}.
      const m = text.match(/^\/(\w+)\b\s*(.*)$/s);
      const command = m ? m[1].toLowerCase() : 'explain';
      const known = ['fix', 'explain', 'comments', 'optimize'];
      const cmd = known.includes(command) ? command : 'explain';

      const ctx = contextCells();
      if (ctx.length === 0) {
        setError('Add a cell to the notebook before asking Copilot.');
        return;
      }
      const active = activeCellId || ctx[ctx.length - 1].id;
      const activeCell = ctx.find((c) => c.id === active) || ctx[ctx.length - 1];
      const errorText =
        cmd === 'fix'
          ? activeCell.output?.status === 'error'
            ? [activeCell.output.ename, activeCell.output.evalue, ...(activeCell.output.traceback || [])]
                .filter(Boolean)
                .join('\n')
            : (m?.[2] || '')
          : '';

      setError(null);
      setNoAoai(null);
      setMessages((prev) => [...prev, { role: 'user', content: text }]);
      setInput('');
      setStreaming(true);
      setStreamText('');

      const ac = new AbortController();
      abortRef.current = ac;
      let full = '';
      try {
        const res = await fetch('/api/copilot/notebook-assist', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            sessionId: sessionIdRef.current,
            command: cmd,
            cells: ctx,
            activeCellId: active,
            lang: activeCell.lang || defaultLang,
            errorText,
            attachedSources,
            notebookId,
            workspaceId,
          }),
          signal: ac.signal,
        });

        if (!res.ok && res.headers.get('content-type')?.includes('application/json')) {
          const j = await res.json().catch(() => ({}));
          if (res.status === 503 && j?.code === 'no_aoai') {
            setNoAoai(j.hint || j.error || 'Copilot is not configured for this deployment.');
          } else {
            setError(j?.error || `Request failed (${res.status})`);
          }
          setStreaming(false);
          return;
        }
        if (!res.body) {
          setError('No response stream from Copilot.');
          setStreaming(false);
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let event = '';
        const handle = (evt: string, data: any) => {
          if (evt === 'chunk' && typeof data?.delta === 'string') {
            full += data.delta;
            setStreamText(full);
          } else if (evt === 'error' && data?.error) {
            setError(String(data.error));
          }
        };
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let nl: number;
          while ((nl = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, nl);
            buffer = buffer.slice(nl + 1);
            const t = line.trimEnd();
            if (t.startsWith('event:')) {
              event = t.slice(6).trim();
            } else if (t.startsWith('data:')) {
              const payload = t.slice(5).trim();
              try {
                handle(event, JSON.parse(payload));
              } catch {
                /* ignore parse error on partial line */
              }
            }
          }
        }

        const codeBlocks = parseCodeBlocks(full);
        setMessages((prev) => [...prev, { role: 'assistant', content: full, codeBlocks }]);
      } catch (e: any) {
        if (e?.name !== 'AbortError') setError(e?.message || String(e));
        if (full) setMessages((prev) => [...prev, { role: 'assistant', content: full, codeBlocks: parseCodeBlocks(full) }]);
      } finally {
        setStreaming(false);
        setStreamText('');
        abortRef.current = null;
      }
    },
    [streaming, contextCells, activeCellId, defaultLang, attachedSources, notebookId, workspaceId],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (slashOpen && slashMatches.length > 0) {
        if (e.key === 'ArrowDown') { e.preventDefault(); setSlashIdx((i) => (i + 1) % slashMatches.length); return; }
        if (e.key === 'ArrowUp') { e.preventDefault(); setSlashIdx((i) => (i - 1 + slashMatches.length) % slashMatches.length); return; }
        if (e.key === 'Tab') { e.preventDefault(); setInput(slashMatches[slashIdx]?.cmd + ' '); setSlashIdx(0); return; }
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (slashOpen && slashMatches.length > 0 && input === slashMatches[slashIdx]?.cmd) {
          // bare command with no arg → run it directly
          void send(input);
        } else {
          void send(input);
        }
      }
    },
    [slashOpen, slashMatches, slashIdx, input, send],
  );

  const applyBlocks = useCallback(
    (blocks: string[]) => {
      if (!onApplyCells || blocks.length === 0) return;
      onApplyCells(blocks.map((source) => ({ source })));
    },
    [onApplyCells],
  );

  return (
    <InlineDrawer open={open} position="end" separator className={s.drawer}>
      <DrawerHeader>
        <DrawerHeaderTitle
          action={
            <Button appearance="subtle" icon={<Dismiss20Regular />} aria-label="Close Copilot" onClick={() => onOpenChange(false)} />
          }
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Sparkle20Regular /> Copilot
          </span>
        </DrawerHeaderTitle>
      </DrawerHeader>
      <DrawerBody>
        <div className={s.body}>
          <Caption1>
            Context: current cell + up to 5 prior cells + lakehouse schema.
            {attachedSources.length > 0 && ` ${attachedSources.length} source${attachedSources.length === 1 ? '' : 's'} attached.`}
          </Caption1>

          <div className={s.history}>
            {messages.length === 0 && !streaming && (
              <Body1 style={{ color: tokens.colorNeutralForeground3 }}>
                Ask about the current cell, or use a slash command: <code>/fix</code>, <code>/explain</code>,{' '}
                <code>/comments</code>, <code>/optimize</code>.
              </Body1>
            )}

            {messages.map((msg, i) =>
              msg.role === 'user' ? (
                <div key={i} className={s.bubbleUser}>{msg.content}</div>
              ) : (
                <div key={i} className={s.bubbleAssistant}>
                  {segments(msg.content).map((seg, j) =>
                    seg.type === 'code' ? (
                      <pre key={j} className={s.code}>{seg.value}</pre>
                    ) : (
                      <span key={j}>{seg.value}</span>
                    ),
                  )}
                  {onApplyCells && msg.codeBlocks && msg.codeBlocks.length > 0 && (
                    <div style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                      <Button size="small" appearance="primary" icon={<Checkmark16Regular />} onClick={() => applyBlocks(msg.codeBlocks!)}>
                        {msg.codeBlocks.length > 1 ? `Apply ${msg.codeBlocks.length} cells to notebook` : 'Apply to notebook'}
                      </Button>
                      {msg.codeBlocks.length > 1 && (
                        <Badge appearance="outline" color="brand" size="small">diff · {msg.codeBlocks.length} blocks</Badge>
                      )}
                    </div>
                  )}
                </div>
              ),
            )}

            {streaming && (
              <div className={s.bubbleAssistant}>
                {streamText
                  ? segments(streamText).map((seg, j) =>
                      seg.type === 'code' ? <pre key={j} className={s.code}>{seg.value}</pre> : <span key={j}>{seg.value}</span>,
                    )
                  : <Spinner size="tiny" label="Thinking…" />}
              </div>
            )}
            <div ref={historyEndRef} />
          </div>

          {noAoai && (
            <MessageBar intent="warning">
              <MessageBarBody>
                <MessageBarTitle>Copilot not configured</MessageBarTitle>
                {noAoai}
              </MessageBarBody>
            </MessageBar>
          )}
          {error && (
            <MessageBar intent="error">
              <MessageBarBody>{error}</MessageBarBody>
            </MessageBar>
          )}

          <div className={s.inputRow}>
            {slashOpen && slashMatches.length > 0 && (
              <div className={s.slashMenu} role="listbox" aria-label="Slash commands">
                {slashMatches.map((c, i) => (
                  <div
                    key={c.cmd}
                    role="option"
                    aria-selected={i === slashIdx}
                    className={`${s.slashItem} ${i === slashIdx ? s.slashItemActive : ''}`}
                    onMouseEnter={() => setSlashIdx(i)}
                    onClick={() => { setInput(c.cmd + ' '); setSlashIdx(0); }}
                  >
                    <Subtitle2>{c.label}</Subtitle2>
                    <Caption1>{c.help}</Caption1>
                  </div>
                ))}
              </div>
            )}
            <Input
              value={input}
              onChange={(_, d) => { setInput(d.value); setSlashIdx(0); }}
              onKeyDown={onKeyDown}
              placeholder="/fix · /explain · /comments · /optimize — or ask anything"
              disabled={streaming}
              contentAfter={
                streaming ? (
                  <Button size="small" appearance="subtle" onClick={() => abortRef.current?.abort()}>Stop</Button>
                ) : (
                  <Button size="small" appearance="subtle" icon={<Send20Regular />} aria-label="Send" onClick={() => void send(input)} disabled={!input.trim()} />
                )
              }
            />
          </div>

          <Divider />
          <Button
            size="small"
            appearance="subtle"
            icon={<History20Regular />}
            onClick={() => setShowSessions((v) => !v)}
            style={{ alignSelf: 'flex-start' }}
          >
            {showSessions ? 'Hide previous sessions' : 'Previous sessions'}
          </Button>
          {showSessions && (
            <div className={s.sessions}>
              {sessions === null && <Spinner size="tiny" label="Loading…" />}
              {sessions && sessions.length === 0 && <Caption1>No previous Copilot sessions.</Caption1>}
              {(sessions || []).map((sess) => (
                <div key={sess.id} className={s.sessionRow}>
                  <Caption1 style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {sess.prompt || '(no prompt)'}
                  </Caption1>
                  <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                    {new Date(sess.updatedAt).toLocaleString()} · {sess.stepCount} step{sess.stepCount === 1 ? '' : 's'}
                  </Caption1>
                </div>
              ))}
            </div>
          )}
        </div>
      </DrawerBody>
    </InlineDrawer>
  );
}
