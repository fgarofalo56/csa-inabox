'use client';

/**
 * MessageList — renders the conversation turns + per-message tool steps
 * + per-message citation chips + handoff CTAs. Pure presentation;
 * the widget owns state.
 */

import {
  Body1, Button, Caption1, Spinner, MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens, mergeClasses,
} from '@fluentui/react-components';
import { ArrowRight16Regular, Open16Regular } from '@fluentui/react-icons';
import { CitationChips, type Citation } from './citations';

export type HelpStep =
  | { kind: 'thought'; content: string }
  | { kind: 'tool_call'; name: string; args: unknown; callId: string }
  | { kind: 'tool_result'; name: string; callId: string; durationMs: number; result?: unknown; error?: string }
  | { kind: 'citation'; citations: Citation[] }
  | { kind: 'handoff'; reason: string; deepLink: string; suggestedPrompt: string }
  | { kind: 'final'; content: string }
  | { kind: 'error'; error: string };

export interface ChatMsg {
  who: 'you' | 'copilot' | 'system';
  text: string;
  steps?: HelpStep[];
  citations?: Citation[];
  handoff?: { reason: string; deepLink: string; suggestedPrompt: string };
  streaming?: boolean;
}

const useStyles = makeStyles({
  msg: {
    padding: '10px 14px', borderRadius: 14, maxWidth: '92%',
    display: 'flex', flexDirection: 'column',
  },
  msgCopilot: {
    backgroundColor: tokens.colorNeutralBackground2, alignSelf: 'flex-start',
    borderTopLeftRadius: 4,
  },
  msgYou: {
    backgroundColor: tokens.colorBrandBackground2, alignSelf: 'flex-end',
    borderTopRightRadius: 4,
  },
  msgSystem: { backgroundColor: tokens.colorNeutralBackground3, alignSelf: 'stretch' },
  step: {
    display: 'flex', alignItems: 'center', gap: 6,
    color: tokens.colorNeutralForeground3, fontSize: 12,
    paddingLeft: 4, marginTop: 4,
  },
  stepError: { color: tokens.colorPaletteRedForeground1 },
  handoff: {
    marginTop: 12, padding: 12,
    backgroundColor: tokens.colorBrandBackground2,
    border: `1px solid ${tokens.colorBrandStroke1}`,
    borderRadius: 10, display: 'flex', flexDirection: 'column', gap: 6,
  },
  handoffTitle: { fontWeight: 600, color: tokens.colorBrandForeground1 },
});

function StepRow({ step, classes }: { step: HelpStep; classes: ReturnType<typeof useStyles> }) {
  if (step.kind === 'tool_call') {
    return (
      <div className={classes.step} data-testid="tool-call">
        ↪ calling <strong>{step.name}</strong>…
      </div>
    );
  }
  if (step.kind === 'tool_result') {
    return (
      <div className={mergeClasses(classes.step, step.error ? classes.stepError : undefined)} data-testid="tool-result">
        {step.error ? '⚠' : '✓'} {step.name} <span>({step.durationMs}ms)</span>
        {step.error && <span> — {step.error}</span>}
      </div>
    );
  }
  if (step.kind === 'thought') {
    return <div className={classes.step}>💭 {step.content.slice(0, 120)}</div>;
  }
  return null;
}

export function MessageList({ messages }: { messages: ChatMsg[] }) {
  const s = useStyles();
  return (
    <>
      {messages.map((m, i) => (
        <div
          key={i}
          className={mergeClasses(
            s.msg,
            m.who === 'copilot' ? s.msgCopilot : m.who === 'you' ? s.msgYou : s.msgSystem,
          )}
          data-testid={`help-msg-${m.who}`}
        >
          {m.text && <Body1 style={{ whiteSpace: 'pre-wrap' }}>{m.text}</Body1>}

          {m.steps?.map((step, j) => <StepRow key={j} step={step} classes={s} />)}

          {m.streaming && !m.text && (
            <div className={s.step}>
              <Spinner size="extra-tiny" /> Thinking…
            </div>
          )}

          {m.citations && m.citations.length > 0 && (
            <CitationChips citations={m.citations} />
          )}

          {m.handoff && (
            <div className={s.handoff} role="region" aria-label="Handoff to Loom Copilot">
              <span className={s.handoffTitle}>
                <ArrowRight16Regular /> Switch to Loom Copilot for this action
              </span>
              <Caption1 style={{ color: tokens.colorNeutralForeground2 }}>{m.handoff.reason}</Caption1>
              <Button
                appearance="primary"
                icon={<Open16Regular />}
                as="a"
                href={m.handoff.deepLink}
                data-testid="help-handoff-link"
              >
                Open Loom Copilot with this prompt
              </Button>
            </div>
          )}
        </div>
      ))}
    </>
  );
}

export function AoaiGateBar({ message }: { message: string }) {
  return (
    <MessageBar intent="warning" data-testid="help-aoai-gate">
      <MessageBarBody>
        <MessageBarTitle>Help Copilot AOAI deployment not wired</MessageBarTitle>
        {message} — set up the AI Foundry hub + a chat-completions deployment, then return here.
      </MessageBarBody>
    </MessageBar>
  );
}

export function SearchDegradedBar() {
  return (
    <MessageBar intent="info" data-testid="help-search-degraded">
      <MessageBarBody>
        <MessageBarTitle>Running on the Cosmos fallback index</MessageBarTitle>
        AI Search is not provisioned in this deployment, so results may be less relevant.
        Set <code>LOOM_AI_SEARCH_SERVICE</code> and call <code>POST /api/help-copilot/reindex</code> to upgrade.
      </MessageBarBody>
    </MessageBar>
  );
}
