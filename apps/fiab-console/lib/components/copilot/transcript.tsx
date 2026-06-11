'use client';

/**
 * Transcript — the Loom Copilot console message stream (audit-T121).
 *
 * Renders grouped conversation turns with a modern chat design:
 *   • User vs assistant bubbles with avatars + role chips.
 *   • Assistant answers as markdown (syntax-highlighted code via Monaco + copy).
 *   • Readable intermediate tool-call + run-receipt rows (reusing CopilotResult
 *     for typed results: DataGrid / chart / Monaco / change-set).
 *   • A streaming "Thinking…" indicator.
 *   • Citations (CitationChips) under an answer when the tool returned sources.
 *   • Per-answer Copy / Regenerate / thumbs-up-down feedback (real PATCH).
 *
 * No mocks: every action calls back to the parent which wires the real routes.
 */

import { useState } from 'react';
import {
  Avatar, Badge, Body1, Caption1, Button, Spinner, Tooltip,
  makeStyles, tokens, mergeClasses,
} from '@fluentui/react-components';
import {
  BotSparkle20Filled, Person20Regular,
  Copy16Regular, Checkmark16Regular, ArrowClockwise16Regular,
  ThumbLike16Regular, ThumbDislike16Regular,
  Wrench16Regular, ErrorCircle16Regular, CheckmarkCircle16Regular,
} from '@fluentui/react-icons';
import { CopilotResult } from '@/lib/components/copilot-result';
import { tagResult } from '@/lib/components/copilot-result-tagger';
import { CitationChips } from '@/lib/components/help-copilot/citations';
import { CopilotMarkdown } from './markdown';
import type { Step, Turn } from './types';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL },
  turn: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  row: { display: 'flex', gap: tokens.spacingHorizontalM, alignItems: 'flex-start' },
  rowUser: { flexDirection: 'row-reverse' },
  bubble: {
    borderRadius: tokens.borderRadiusXLarge,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalL}`,
    maxWidth: '82%',
    minWidth: 0,
  },
  bubbleUser: {
    backgroundColor: tokens.colorBrandBackground2,
    borderTopRightRadius: tokens.borderRadiusSmall,
    color: tokens.colorNeutralForeground1,
  },
  bubbleAssistant: {
    backgroundColor: tokens.colorNeutralBackground2,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderTopLeftRadius: tokens.borderRadiusSmall,
    flex: 1,
  },
  roleChip: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, marginBottom: '2px' },
  roleName: { fontWeight: tokens.fontWeightSemibold, fontSize: tokens.fontSizeBase200 },
  stepGroup: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, margin: `${tokens.spacingVerticalXS} 0` },
  stepRow: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS,
    color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200,
  },
  stepResult: { marginTop: '2px', marginLeft: tokens.spacingHorizontalL },
  thought: { fontStyle: 'italic', color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
  actions: { display: 'flex', alignItems: 'center', gap: '2px', marginTop: tokens.spacingVerticalXS },
  usage: { color: tokens.colorNeutralForeground3, marginTop: tokens.spacingVerticalXS },
  errorBubble: {
    backgroundColor: tokens.colorPaletteRedBackground1,
    border: `1px solid ${tokens.colorPaletteRedBorder2}`,
    borderRadius: tokens.borderRadiusXLarge,
    borderTopLeftRadius: tokens.borderRadiusSmall,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalL}`,
    flex: 1,
  },
  active: { color: tokens.colorBrandForeground1 },
});

function StepStream({ steps }: { steps: Step[] }) {
  const s = useStyles();
  if (steps.length === 0) return null;
  return (
    <div className={s.stepGroup}>
      {steps.map((step, i) => {
        if (step.kind === 'thought') {
          return <div key={i} className={s.thought}>{step.content}</div>;
        }
        if (step.kind === 'tool_call') {
          return (
            <div key={i} className={s.stepRow}>
              <Wrench16Regular /> calling <strong>{step.name}</strong>…
            </div>
          );
        }
        if (step.kind === 'tool_result') {
          return (
            <div key={i}>
              <div className={s.stepRow}>
                {step.error
                  ? <ErrorCircle16Regular style={{ color: tokens.colorPaletteRedForeground1 }} />
                  : <CheckmarkCircle16Regular style={{ color: tokens.colorPaletteGreenForeground1 }} />}
                <strong>{step.name}</strong> · {step.durationMs}ms
                {step.error && <span style={{ color: tokens.colorPaletteRedForeground1 }}> — {step.error}</span>}
              </div>
              {!step.error && step.result != null && (
                <div className={s.stepResult}>
                  <CopilotResult result={tagResult(step.result, step.name)} toolName={step.name} />
                </div>
              )}
            </div>
          );
        }
        if (step.kind === 'proposed_change') {
          return (
            <div key={i} className={s.stepRow}>
              <Wrench16Regular /> proposed change to <code>{step.target}</code>
              {step.summary ? ` — ${step.summary}` : ''}
            </div>
          );
        }
        return null;
      })}
    </div>
  );
}

interface CopyButtonProps { text: string; }
function CopyButton({ text }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* ignore */ }
  };
  return (
    <Tooltip content={copied ? 'Copied' : 'Copy answer'} relationship="label">
      <Button appearance="subtle" size="small" icon={copied ? <Checkmark16Regular /> : <Copy16Regular />} onClick={copy} aria-label="Copy answer" />
    </Tooltip>
  );
}

export interface TranscriptProps {
  turns: Turn[];
  /** Persona/title shown on assistant role chips. */
  assistantName?: string;
  ratings: Record<number, 'up' | 'down'>;
  onFeedback: (msgIndex: number, rating: 'up' | 'down') => void;
  onRegenerate: (turn: Turn) => void;
  canRegenerate: boolean;
}

export function Transcript({ turns, assistantName = 'Copilot', ratings, onFeedback, onRegenerate, canRegenerate }: TranscriptProps) {
  const s = useStyles();
  return (
    <div className={s.root}>
      {turns.map((turn, ti) => {
        const isLast = ti === turns.length - 1;
        return (
          <div key={ti} className={s.turn}>
            {turn.user && (
              <div className={mergeClasses(s.row, s.rowUser)}>
                <Avatar size={28} icon={<Person20Regular />} color="neutral" aria-label="You" />
                <div className={mergeClasses(s.bubble, s.bubbleUser)}>
                  <Body1 style={{ whiteSpace: 'pre-wrap' }}>{turn.user}</Body1>
                </div>
              </div>
            )}

            <div className={s.row}>
              <Avatar size={28} icon={<BotSparkle20Filled />} color="brand" aria-label={assistantName} />
              {turn.error ? (
                <div className={s.errorBubble}>
                  <div className={s.roleChip}>
                    <ErrorCircle16Regular style={{ color: tokens.colorPaletteRedForeground1 }} />
                    <span className={s.roleName}>Error</span>
                  </div>
                  <Caption1>{turn.error}</Caption1>
                </div>
              ) : (
                <div className={mergeClasses(s.bubble, s.bubbleAssistant)}>
                  <div className={s.roleChip}>
                    <span className={s.roleName}>{assistantName}</span>
                    {turn.model && <Badge size="small" appearance="outline" color="subtle">{turn.model}</Badge>}
                  </div>

                  <StepStream steps={turn.steps} />

                  {turn.streaming && turn.final === undefined && (
                    <div className={s.stepRow}><Spinner size="extra-tiny" /> Thinking…</div>
                  )}

                  {turn.final !== undefined && <CopilotMarkdown source={turn.final || '(no content)'} />}

                  {turn.citations && turn.citations.length > 0 && (
                    <CitationChips citations={turn.citations} />
                  )}

                  {turn.usage && (
                    <Caption1 className={s.usage}>
                      {turn.usage.toolCalls > 0 ? `${turn.usage.toolCalls} tool${turn.usage.toolCalls === 1 ? '' : 's'} · ` : ''}
                      {turn.usage.totalTokens.toLocaleString()} tokens
                      {turn.usage.aoaiCalls > 1 ? ` · ${turn.usage.aoaiCalls} turns` : ''}
                    </Caption1>
                  )}

                  {turn.final !== undefined && !turn.streaming && (
                    <div className={s.actions}>
                      <CopyButton text={turn.final || ''} />
                      {isLast && canRegenerate && (turn.user) && (
                        <Tooltip content="Regenerate" relationship="label">
                          <Button appearance="subtle" size="small" icon={<ArrowClockwise16Regular />} onClick={() => onRegenerate(turn)} aria-label="Regenerate answer" />
                        </Tooltip>
                      )}
                      {turn.msgIndex !== undefined && (
                        <>
                          <Tooltip content="Helpful" relationship="label">
                            <Button
                              appearance="subtle" size="small" icon={<ThumbLike16Regular />}
                              style={{ color: ratings[turn.msgIndex] === 'up' ? tokens.colorBrandForeground1 : undefined }}
                              onClick={() => onFeedback(turn.msgIndex!, 'up')}
                              aria-label="Thumbs up" aria-pressed={ratings[turn.msgIndex] === 'up'}
                            />
                          </Tooltip>
                          <Tooltip content="Not helpful" relationship="label">
                            <Button
                              appearance="subtle" size="small" icon={<ThumbDislike16Regular />}
                              style={{ color: ratings[turn.msgIndex] === 'down' ? tokens.colorPaletteRedForeground1 : undefined }}
                              onClick={() => onFeedback(turn.msgIndex!, 'down')}
                              aria-label="Thumbs down" aria-pressed={ratings[turn.msgIndex] === 'down'}
                            />
                          </Tooltip>
                        </>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
