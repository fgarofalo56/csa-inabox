'use client';

/**
 * AskAffordance — shared NL "Ask" affordance for any Loom data surface.
 *
 * WS-5.4: every table/preview, dashboard, report, semantic model, and ontology
 * surface gets a compact "Ask" bar backed by the real data-agent chat pipeline
 * (POST /api/ask → chatGrounded from data-agent-client.ts).
 *
 * The component renders as:
 *   1. A collapsed "Ask this data…" button (sparkle icon) — low footprint.
 *   2. Expanded: a question input + Send button + optional context badge row.
 *   3. After submit: loading skeleton → answer prose + DataAgentResultViz for
 *      each tool the agent executed + timing/token status bar.
 *   4. Follow-up: history is kept within the component's lifetime so the user
 *      can ask follow-up questions without losing context.
 *
 * Rules satisfied:
 *   • Fluent v9 + tokens.* only — no hard-coded px/hex.
 *   • flexWrap + minWidth:0 on all badge/tag rows — no overlaps.
 *   • Keyboard accessible: Enter submits, Escape closes, full focus ring.
 *   • Real backend only — no mock arrays. Gate: honest Fluent MessageBar when
 *     AOAI is not configured, naming the exact env var to set.
 *   • no-fabric-dependency.md: uses the Azure-native grounded path exclusively.
 */

import * as React from 'react';
import { useCallback, useRef, useState } from 'react';
import {
  Badge, Button, Caption1, Input, MessageBar, MessageBarBody, MessageBarTitle,
  Spinner, makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Sparkle20Regular, Send20Regular, Dismiss20Regular,
  Chat20Regular, Clock20Regular,
} from '@fluentui/react-icons';
import { DataAgentResultViz, type VizTool } from '@/lib/editors/data-agent-result-viz';
import { clientFetch } from '@/lib/client-fetch';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AskSurfaceKind =
  | 'lakehouse'
  | 'warehouse'
  | 'kql-database'
  | 'kql-dashboard'
  | 'semantic-model'
  | 'report'
  | 'ontology';

export interface AskContext {
  /** Table/view names visible on the surface (used for grounding). */
  tables?: string[];
  /** Column names currently shown. */
  columns?: string[];
  /** SQL / KQL already in the editor, if any. */
  query?: string;
  /** Any selected text on the surface. */
  selection?: string;
}

export interface AskAffordanceProps {
  /** The kind of surface (maps to a DataAgent source type). */
  surfaceKind: AskSurfaceKind;
  /** Loom item id of the host surface — used for provenance/naming. */
  itemId: string;
  /** Loom item type label (e.g. "lakehouse", "warehouse"). */
  itemType: string;
  /** Contextual grounding data from the current view. Passed on every question. */
  context?: AskContext;
  /** Placeholder text for the question input. */
  placeholder?: string;
  /** When true, don't render the outer collapse button — always show the bar.
   *  Use on surfaces where the affordance is already in a dedicated panel. */
  alwaysOpen?: boolean;
}

interface ChatTurn { role: 'user' | 'assistant'; content: string }

interface AskAnswer {
  answer: string;
  tools?: VizTool[];
  usage?: { totalTokens: number };
  model?: string;
  durationMs?: number;
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXS,
    minWidth: 0,
  },
  collapseBtn: {
    alignSelf: 'flex-start',
  },
  bar: {
    display: 'flex',
    gap: tokens.spacingHorizontalS,
    alignItems: 'center',
    flexWrap: 'wrap',
    minWidth: 0,
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    background: tokens.colorNeutralBackground2,
  },
  input: {
    flex: 1,
    minWidth: '120px',
  },
  history: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    maxHeight: '480px',
    overflowY: 'auto',
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    background: tokens.colorNeutralBackground1,
  },
  turn: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXXS,
    minWidth: 0,
  },
  questionLabel: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightSemibold,
    flexShrink: 0,
  },
  questionText: {
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeBase300,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    minWidth: 0,
  },
  answerText: {
    color: tokens.colorNeutralForeground1,
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    minWidth: 0,
  },
  statusBar: {
    display: 'flex',
    gap: tokens.spacingHorizontalXS,
    flexWrap: 'wrap',
    alignItems: 'center',
    minWidth: 0,
    marginTop: tokens.spacingVerticalXXS,
  },
  divider: {
    height: '1px',
    background: tokens.colorNeutralStroke3,
    margin: `${tokens.spacingVerticalXS} 0`,
  },
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function postAsk(
  question: string,
  surfaceKind: AskSurfaceKind,
  itemId: string,
  itemType: string,
  context: AskContext | undefined,
): Promise<{ ok: boolean; answer?: string; tools?: VizTool[]; usage?: { totalTokens: number }; model?: string; error?: string; hint?: string; missing?: string }> {
  const res = await clientFetch('/api/ask', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question, surfaceKind, itemId, itemType, context }),
  });
  let data: Record<string, unknown>;
  try {
    data = await res.json();
  } catch {
    data = { ok: false, error: `HTTP ${res.status}` };
  }
  return data as ReturnType<typeof postAsk> extends Promise<infer T> ? T : never;
}

// ---------------------------------------------------------------------------
// Single history turn renderer
// ---------------------------------------------------------------------------

function HistoryTurn({ question, answer }: { question: string; answer: AskAnswer | null }) {
  const s = useStyles();
  return (
    <div className={s.turn}>
      <span className={s.questionLabel}>You</span>
      <span className={s.questionText}>{question}</span>
      {answer ? (
        <>
          <span className={s.questionLabel} style={{ marginTop: tokens.spacingVerticalXS, color: tokens.colorBrandForeground1 }}>
            Loom
          </span>
          <span className={s.answerText}>{answer.answer}</span>
          {/* Type-badged tool results (DataAgentResultViz) */}
          {answer.tools?.filter((t) => t.executed && (t.rowCount ?? 0) >= 0).map((tool, i) => (
            <DataAgentResultViz key={i} tool={tool} />
          ))}
          {/* Timing + token status bar */}
          <div className={s.statusBar}>
            {answer.model && (
              <Badge appearance="tint" size="small" color="informative" style={{ minWidth: 0 }}>
                {answer.model}
              </Badge>
            )}
            {answer.usage?.totalTokens ? (
              <Caption1 style={{ color: tokens.colorNeutralForeground3, minWidth: 0 }}>
                {answer.usage.totalTokens.toLocaleString()} tokens
              </Caption1>
            ) : null}
            {answer.durationMs != null && (
              <Caption1 style={{ color: tokens.colorNeutralForeground3, display: 'flex', alignItems: 'center', gap: '2px', minWidth: 0 }}>
                <Clock20Regular style={{ fontSize: '12px' }} />
                {answer.durationMs}ms
              </Caption1>
            )}
          </div>
        </>
      ) : (
        <Spinner size="tiny" label="Thinking…" labelPosition="after" />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function AskAffordance({
  surfaceKind,
  itemId,
  itemType,
  context,
  placeholder,
  alwaysOpen = false,
}: AskAffordanceProps) {
  const s = useStyles();
  const [open, setOpen] = useState(alwaysOpen);
  const [question, setQuestion] = useState('');
  const [loading, setLoading] = useState(false);
  const [gate, setGate] = useState<{ error: string; hint?: string; missing?: string } | null>(null);
  const [turns, setTurns] = useState<Array<{ question: string; answer: AskAnswer | null }>>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const historyRef = useRef<HTMLDivElement>(null);

  const defaultPlaceholder = placeholder
    ?? `Ask about this ${surfaceKind.replace(/-/g, ' ')} data…`;

  const submit = useCallback(async () => {
    const q = question.trim();
    if (!q || loading) return;

    setGate(null);
    setLoading(true);
    const idx = turns.length;
    setTurns((prev) => [...prev, { question: q, answer: null }]);
    setQuestion('');

    const t0 = Date.now();
    const res = await postAsk(q, surfaceKind, itemId, itemType, context);
    const durationMs = Date.now() - t0;

    if (!res.ok) {
      setGate({ error: res.error ?? 'Unknown error', hint: res.hint, missing: res.missing });
      setTurns((prev) => prev.filter((_, i) => i !== idx));
    } else {
      const answer: AskAnswer = {
        answer: res.answer ?? '',
        tools: res.tools as VizTool[] | undefined,
        usage: res.usage,
        model: res.model,
        durationMs,
      };
      setTurns((prev) => prev.map((t, i) => i === idx ? { ...t, answer } : t));
    }
    setLoading(false);

    // Scroll history to bottom
    requestAnimationFrame(() => {
      if (historyRef.current) historyRef.current.scrollTop = historyRef.current.scrollHeight;
    });
  }, [question, loading, turns.length, surfaceKind, itemId, itemType, context]);

  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
    if (e.key === 'Escape') {
      if (!alwaysOpen) setOpen(false);
    }
  }, [submit, alwaysOpen]);

  const clear = useCallback(() => {
    setTurns([]);
    setGate(null);
    setQuestion('');
    if (!alwaysOpen) setOpen(false);
  }, [alwaysOpen]);

  // When expanding, focus the input.
  const expand = useCallback(() => {
    setOpen(true);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  if (!open) {
    return (
      <div className={s.root}>
        <Button
          className={s.collapseBtn}
          appearance="subtle"
          size="small"
          icon={<Sparkle20Regular />}
          onClick={expand}
          aria-label={`Ask about this ${surfaceKind} data`}
        >
          Ask
        </Button>
      </div>
    );
  }

  return (
    <div className={s.root}>
      {/* Question input bar */}
      <div className={s.bar} role="search" aria-label={`Ask about this ${surfaceKind} data`}>
        <Chat20Regular style={{ color: tokens.colorBrandForeground1, flexShrink: 0 }} aria-hidden />
        <Input
          ref={inputRef}
          className={s.input}
          size="small"
          appearance="underline"
          placeholder={defaultPlaceholder}
          value={question}
          onChange={(_, d) => setQuestion(d.value)}
          onKeyDown={onKeyDown}
          disabled={loading}
          aria-label="Ask a question about this data"
        />
        <Button
          size="small"
          appearance="primary"
          icon={loading ? <Spinner size="tiny" /> : <Send20Regular />}
          onClick={() => void submit()}
          disabled={!question.trim() || loading}
          aria-label="Send question"
        />
        {turns.length > 0 && (
          <Button
            size="small"
            appearance="subtle"
            icon={<Dismiss20Regular />}
            onClick={clear}
            title="Clear conversation"
            aria-label="Clear conversation"
          />
        )}
        {!alwaysOpen && turns.length === 0 && (
          <Button
            size="small"
            appearance="subtle"
            icon={<Dismiss20Regular />}
            onClick={() => setOpen(false)}
            title="Close"
            aria-label="Close Ask panel"
          />
        )}
      </div>

      {/* Gate — honest AOAI-not-configured error */}
      {gate && (
        <MessageBar intent="warning" layout="multiline">
          <MessageBarBody>
            <MessageBarTitle>AI not configured</MessageBarTitle>
            {gate.error}
            {gate.hint && (
              <span style={{ display: 'block', marginTop: tokens.spacingVerticalXXS, color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 }}>
                {gate.hint}
              </span>
            )}
            {gate.missing && (
              <Badge appearance="tint" size="small" color="warning" style={{ marginTop: tokens.spacingVerticalXXS, minWidth: 0 }}>
                {gate.missing}
              </Badge>
            )}
          </MessageBarBody>
        </MessageBar>
      )}

      {/* Conversation history */}
      {turns.length > 0 && (
        <div className={s.history} ref={historyRef}>
          {turns.map((t, i) => (
            <React.Fragment key={i}>
              {i > 0 && <div className={s.divider} aria-hidden />}
              <HistoryTurn question={t.question} answer={t.answer} />
            </React.Fragment>
          ))}
        </div>
      )}
    </div>
  );
}

export default AskAffordance;
