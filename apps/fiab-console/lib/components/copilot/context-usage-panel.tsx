'use client';

/**
 * ContextUsagePanel — the segmented context-window meter (CTS-05), a 1:1 clone
 * of ATLAS's ContextUsagePanel on Loom's Fluent v9 + Loom tokens.
 *
 * Collapsed: `Context {util}% · {used}/{window}` + a skills chip + a live
 * message count + a color-coded utilization dot, above an always-visible thin
 * multi-segment bar (one segment per contributor).
 *
 * Expanded: one drillable row per segment — system prompt, persona context,
 * skills, tools, memory, knowledge, conversation, remaining — each with its
 * token count. Skills drills to the active skill names; Tools to tool-name
 * chips; System prompt opens a preview modal (first ~2k chars + Copy). Footer:
 * Copy Report + (CTS-06) "Dump to memory" — folds the conversation into durable
 * facts via POST /api/copilot/memory/flush when the host wires onDumpToMemory.
 *
 * The payload is computed server-side by the PURE buildContextUsagePayload with
 * the segment-sum invariant, so every number here is real, not estimated in the
 * browser. Read-only — no freeform config.
 */

import { useState } from 'react';
import {
  Badge, Button, Caption1, Dialog, DialogSurface, DialogBody, DialogTitle,
  DialogContent, DialogActions, DialogTrigger, Tooltip, Text, Spinner,
  makeStyles, tokens, mergeClasses,
} from '@fluentui/react-components';
import {
  ChevronDown16Regular, ChevronUp16Regular, Copy16Regular, Checkmark16Regular,
  DocumentText16Regular, Memory16Regular,
} from '@fluentui/react-icons';
import type { ContextUsage } from './types';

const useStyles = makeStyles({
  root: {
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalM}`,
  },
  header: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS,
    cursor: 'pointer', width: '100%', background: 'none', border: 'none',
    padding: `${tokens.spacingVerticalXXS} 0`, textAlign: 'left',
    color: tokens.colorNeutralForeground2, fontSize: tokens.fontSizeBase200,
    ':focus-visible': { outline: `2px solid ${tokens.colorBrandStroke1}`, outlineOffset: '2px' },
  },
  dot: { width: '8px', height: '8px', borderRadius: '50%', flexShrink: 0 },
  headerLabel: { fontWeight: tokens.fontWeightSemibold },
  headerMeta: { color: tokens.colorNeutralForeground3, marginLeft: 'auto', display: 'flex', gap: tokens.spacingHorizontalXS, alignItems: 'center' },
  bar: {
    display: 'flex', height: '6px', width: '100%', borderRadius: tokens.borderRadiusSmall,
    overflow: 'hidden', marginTop: tokens.spacingVerticalXXS,
    backgroundColor: tokens.colorNeutralBackground4,
  },
  seg: { height: '100%' },
  rows: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS, marginTop: tokens.spacingVerticalS },
  row: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, fontSize: tokens.fontSizeBase200 },
  swatch: { width: '10px', height: '10px', borderRadius: '2px', flexShrink: 0 },
  rowLabel: { color: tokens.colorNeutralForeground2 },
  rowTokens: { color: tokens.colorNeutralForeground3, marginLeft: 'auto', fontVariantNumeric: 'tabular-nums' },
  drill: { marginLeft: '18px', display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalXXS, marginBottom: tokens.spacingVerticalXXS },
  footer: { display: 'flex', gap: tokens.spacingHorizontalS, marginTop: tokens.spacingVerticalS },
  preview: {
    whiteSpace: 'pre-wrap', fontFamily: tokens.fontFamilyMonospace, fontSize: tokens.fontSizeBase200,
    backgroundColor: tokens.colorNeutralBackground3, padding: tokens.spacingHorizontalM,
    borderRadius: tokens.borderRadiusMedium, maxHeight: '50vh', overflow: 'auto',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
});

/** One bar/legend segment. Colors are Loom/Fluent palette tokens (theme-aware). */
interface Seg { key: string; label: string; tokens: number; color: string; drill?: string[] }

function utilColor(pct: number): string {
  if (pct < 60) return tokens.colorPaletteGreenForeground1;
  if (pct < 85) return tokens.colorPaletteYellowForeground1;
  return tokens.colorPaletteRedForeground1;
}

export interface ContextUsagePanelProps {
  usage: ContextUsage;
  /** Live conversation message count shown in the collapsed header. */
  messageCount?: number;
  /**
   * CTS-06 — "Dump conversation to long-term memory". When provided, the footer
   * shows a "Dump to memory" action that folds the recent conversation into
   * durable facts (real backend: POST /api/copilot/memory/flush). Resolves with
   * how many facts were stored; the panel surfaces a transient confirmation.
   * Absent → the action is omitted (per no-vaporware, never a dead button).
   */
  onDumpToMemory?: () => Promise<{ stored: number } | void>;
}

export function ContextUsagePanel({ usage, messageCount, onDumpToMemory }: ContextUsagePanelProps) {
  const s = useStyles();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [dumpState, setDumpState] = useState<'idle' | 'saving' | 'done'>('idle');
  const [dumpMsg, setDumpMsg] = useState('');

  const dumpToMemory = async () => {
    if (!onDumpToMemory || dumpState === 'saving') return;
    setDumpState('saving');
    setDumpMsg('');
    try {
      const res = await onDumpToMemory();
      const stored = res && typeof res.stored === 'number' ? res.stored : 0;
      setDumpMsg(stored > 0 ? `Saved ${stored} memor${stored === 1 ? 'y' : 'ies'}` : 'Nothing durable to save');
    } catch {
      setDumpMsg('Could not save to memory');
    } finally {
      setDumpState('done');
      setTimeout(() => { setDumpState('idle'); setDumpMsg(''); }, 3000);
    }
  };

  const segs: Seg[] = [
    { key: 'system', label: 'System prompt', tokens: usage.systemPromptTokens, color: tokens.colorPaletteBlueForeground2 },
    { key: 'persona', label: 'Persona context', tokens: usage.personaContextTokens, color: tokens.colorPalettePurpleForeground2 },
    { key: 'skills', label: 'Skills', tokens: usage.skills.tokens, color: tokens.colorPaletteTealForeground2, drill: usage.skills.names },
    { key: 'tools', label: 'Tools', tokens: usage.tools.tokens, color: tokens.colorPaletteMarigoldForeground2, drill: usage.tools.names },
    { key: 'memory', label: 'Memory', tokens: usage.memory.tokens, color: tokens.colorPaletteCranberryForeground2 },
    { key: 'knowledge', label: 'Knowledge', tokens: usage.knowledge.tokens, color: tokens.colorPaletteSeafoamForeground2 },
    { key: 'conversation', label: 'Conversation', tokens: usage.conversationHistory.tokens, color: tokens.colorPaletteGreenForeground2 },
  ];
  const usedSegs = segs.filter((seg) => seg.tokens > 0);
  const denom = Math.max(usage.contextWindow, usage.totalInputTokens, 1);

  const copyReport = async () => {
    const lines = [
      `Context window: ${usage.contextWindow.toLocaleString()} tokens`,
      `Used: ${usage.totalInputTokens.toLocaleString()} (${usage.utilizationPct}%)`,
      `Remaining: ${usage.remainingTokens.toLocaleString()}`,
      '',
      ...segs.map((seg) => `${seg.label}: ${seg.tokens.toLocaleString()}`),
      `Remaining: ${usage.remainingTokens.toLocaleString()}`,
      '',
      `Segment sum: ${usage.segmentSum.toLocaleString()} (${usage.segmentsConsistent ? 'consistent' : 'INCONSISTENT'})`,
      usage.skills.names.length ? `Active skills: ${usage.skills.names.join(', ')}` : '',
      usage.tools.names.length ? `Tools: ${usage.tools.names.join(', ')}` : '',
    ].filter(Boolean);
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* ignore */ }
  };

  return (
    <div className={s.root} data-testid="copilot-context-panel">
      <button
        className={s.header}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={open ? 'Collapse context usage' : 'Expand context usage'}
      >
        <span className={s.dot} style={{ backgroundColor: utilColor(usage.utilizationPct) }} aria-hidden />
        <span className={s.headerLabel}>Context {usage.utilizationPct}%</span>
        <span className={s.headerMeta}>
          {usage.skills.count > 0 && (
            <Badge size="extra-small" appearance="tint" color="informative">{usage.skills.count} skills</Badge>
          )}
          {messageCount != null && <span>{messageCount} msg</span>}
          <span>{usage.totalInputTokens.toLocaleString()}/{usage.contextWindow.toLocaleString()}</span>
          {open ? <ChevronUp16Regular aria-hidden /> : <ChevronDown16Regular aria-hidden />}
        </span>
      </button>

      <div className={s.bar} role="img" aria-label={`Context ${usage.utilizationPct}% used`}>
        {usedSegs.map((seg) => (
          <div
            key={seg.key}
            className={s.seg}
            style={{ width: `${(seg.tokens / denom) * 100}%`, backgroundColor: seg.color }}
            title={`${seg.label}: ${seg.tokens.toLocaleString()}`}
          />
        ))}
      </div>

      {open && (
        <>
          <div className={s.rows}>
            {segs.map((seg) => (
              <div key={seg.key}>
                <div className={s.row}>
                  <span className={s.swatch} style={{ backgroundColor: seg.color }} aria-hidden />
                  <span className={s.rowLabel}>{seg.label}</span>
                  <span className={s.rowTokens}>{seg.tokens.toLocaleString()}</span>
                </div>
                {open && seg.drill && seg.drill.length > 0 && (
                  <div className={s.drill}>
                    {seg.drill.map((name) => (
                      <Badge key={name} size="extra-small" appearance="outline" color="subtle">{name}</Badge>
                    ))}
                  </div>
                )}
              </div>
            ))}
            <div className={mergeClasses(s.row)}>
              <span className={s.swatch} style={{ backgroundColor: tokens.colorNeutralBackground5 }} aria-hidden />
              <span className={s.rowLabel}>Remaining</span>
              <span className={s.rowTokens}>{usage.remainingTokens.toLocaleString()}</span>
            </div>
          </div>

          <div className={s.footer}>
            <Dialog>
              <DialogTrigger disableButtonEnhancement>
                <Button size="small" appearance="secondary" icon={<DocumentText16Regular />}>
                  View system prompt
                </Button>
              </DialogTrigger>
              <DialogSurface>
                <DialogBody>
                  <DialogTitle>System prompt (first {Math.min(usage.systemPromptPreview.length, 2000)} chars)</DialogTitle>
                  <DialogContent>
                    {usage.systemPromptPreview
                      ? <div className={s.preview}>{usage.systemPromptPreview}</div>
                      : <Caption1>No system prompt preview available for this turn.</Caption1>}
                  </DialogContent>
                  <DialogActions>
                    <Button
                      appearance="primary"
                      icon={<Copy16Regular />}
                      onClick={() => { void navigator.clipboard.writeText(usage.systemPromptPreview).catch(() => {}); }}
                    >
                      Copy prompt
                    </Button>
                    <DialogTrigger disableButtonEnhancement>
                      <Button appearance="secondary">Close</Button>
                    </DialogTrigger>
                  </DialogActions>
                </DialogBody>
              </DialogSurface>
            </Dialog>

            <Button
              size="small"
              appearance="secondary"
              icon={copied ? <Checkmark16Regular /> : <Copy16Regular />}
              onClick={copyReport}
            >
              {copied ? 'Copied' : 'Copy report'}
            </Button>

            {onDumpToMemory && (
              <Tooltip
                content="Extract durable facts from this conversation into long-term memory so a later session recalls them."
                relationship="label"
              >
                <Button
                  size="small"
                  appearance="secondary"
                  icon={dumpState === 'saving' ? <Spinner size="tiny" /> : <Memory16Regular />}
                  disabled={dumpState === 'saving'}
                  onClick={dumpToMemory}
                >
                  {dumpState === 'done' && dumpMsg ? dumpMsg : 'Dump to memory'}
                </Button>
              </Tooltip>
            )}

            {!usage.segmentsConsistent && (
              <Tooltip content="Segment sum did not match total input tokens" relationship="label">
                <Text size={200} style={{ color: tokens.colorPaletteRedForeground1 }}>⚠ inconsistent</Text>
              </Tooltip>
            )}
          </div>
        </>
      )}
    </div>
  );
}
