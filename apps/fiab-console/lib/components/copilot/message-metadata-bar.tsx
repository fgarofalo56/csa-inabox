'use client';

/**
 * MessageMetadataBar — the always-visible per-turn transparency status bar
 * (CTS-01, ATLAS Tier-1). A slim strip under every assistant answer:
 *   • model + provider badge
 *   • tokens ↑in / ↓out with a Σ running total
 *   • estimated cost ($, rel-T85 list price over the REAL token counts)
 *   • turn latency (wall-clock)
 *   • tool / MCP call count
 *
 * "How fast, how cheap, on what model was this turn" — never buried in a
 * tooltip. Fluent v9 + Loom tokens only. Cost/latency chips take a Loom accent
 * color by threshold (green / amber / red). Every value is optional so a turn
 * persisted before this wave (or a MAF-tier turn) still renders whatever it has.
 */

import { useState } from 'react';
import { Badge, Button, Tooltip, makeStyles, tokens } from '@fluentui/react-components';
import {
  Bot16Regular, ArrowUp12Regular, ArrowDown12Regular,
  Money16Regular, Timer16Regular, Wrench16Regular,
  ChevronDown12Regular, ChevronUp12Regular, BranchFork16Regular,
} from '@fluentui/react-icons';
import { TurnDetailPanel } from './turn-detail-panel';
import type { Citation, CopilotUsage, TurnDetail, TurnMeta } from './types';

const useStyles = makeStyles({
  bar: {
    display: 'flex', alignItems: 'center', flexWrap: 'wrap',
    gap: tokens.spacingHorizontalS, rowGap: tokens.spacingVerticalXXS,
    marginTop: tokens.spacingVerticalXS,
    paddingTop: tokens.spacingVerticalXS,
    borderTop: `1px solid ${tokens.colorNeutralStroke3}`,
  },
  chip: {
    display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalXXS,
    color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200,
    whiteSpace: 'nowrap',
  },
  chipStrong: { color: tokens.colorNeutralForeground2 },
  ok: { color: tokens.colorPaletteGreenForeground1 },
  warn: { color: tokens.colorPaletteYellowForeground1 },
  bad: { color: tokens.colorPaletteRedForeground1 },
  tokenUp: { color: tokens.colorNeutralForeground3, display: 'inline-flex', alignItems: 'center' },
});

/** Latency threshold → Loom accent class. */
function latencyClass(s: ReturnType<typeof useStyles>, ms?: number): string {
  if (ms == null) return s.chip;
  if (ms < 3000) return `${s.chip} ${s.ok}`;
  if (ms < 12000) return `${s.chip} ${s.warn}`;
  return `${s.chip} ${s.bad}`;
}
/** Cost threshold → Loom accent class (per-turn $; cents-scale is normal). */
function costClass(s: ReturnType<typeof useStyles>, usd?: number): string {
  if (usd == null) return s.chip;
  if (usd < 0.02) return `${s.chip} ${s.ok}`;
  if (usd < 0.1) return `${s.chip} ${s.warn}`;
  return `${s.chip} ${s.bad}`;
}

/** CTS-16 tier → short chip label + tooltip. */
const TIER_CHIP: Record<NonNullable<TurnMeta['routedTier']>, { label: string; tip: string }> = {
  mini: { label: 'Mini tier', tip: 'The tier router routed this lightweight turn to the cheaper Mini deployment.' },
  standard: { label: 'Standard tier', tip: 'The tier router kept this turn on the Standard deployment.' },
  strong: { label: 'Strong tier', tip: 'The tier router routed this reasoning-heavy turn to the Strong deployment.' },
};

function fmtLatency(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
}
function fmtCost(usd: number): string {
  if (usd <= 0) return '$0';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(usd < 1 ? 3 : 2)}`;
}

export interface MessageMetadataBarProps extends TurnMeta {
  model?: string;
  usage?: CopilotUsage;
  /** CTS-02 per-message detail (tool table + routing) behind the chevron. */
  turnDetail?: TurnDetail;
  /** CTS-04 grounding citations grouped under "Sources" in the detail panel. */
  citations?: Citation[];
}

export function MessageMetadataBar(props: MessageMetadataBarProps) {
  const s = useStyles();
  const [expanded, setExpanded] = useState(false);
  const { model, provider, usage, turnDetail, citations } = props;
  // The detail chevron appears when there is anything worth expanding: a tool
  // roll-up, routing info, or grounding citations.
  const hasDetail = !!(
    (turnDetail && (turnDetail.tools.length > 0 || turnDetail.routedAgentName || turnDetail.routedReason)) ||
    (citations && citations.length > 0)
  );
  // Prefer the split counts (CTS-01); fall back to usage for older turns.
  const promptTokens = props.promptTokens ?? usage?.promptTokens;
  const completionTokens = props.completionTokens ?? usage?.completionTokens;
  const totalTokens = usage?.totalTokens
    ?? ((promptTokens ?? 0) + (completionTokens ?? 0) || undefined);
  const toolCalls = usage?.toolCalls ?? 0;
  const aoaiCalls = usage?.aoaiCalls;

  // Nothing meaningful to show → render nothing (keeps error turns clean).
  if (!model && totalTokens == null && props.turnLatencyMs == null && props.costUsd == null && !hasDetail) {
    return null;
  }

  return (
    <>
    <div className={s.bar} data-testid="copilot-metadata-bar" aria-label="Turn details">
      {model && (
        <Tooltip content={`${provider || 'Azure OpenAI'} · ${model}`} relationship="label">
          <Badge size="small" appearance="outline" color="brand" icon={<Bot16Regular />}>
            {model}
          </Badge>
        </Tooltip>
      )}

      {props.routedTier && (
        <Tooltip content={TIER_CHIP[props.routedTier].tip} relationship="label">
          <Badge size="small" appearance="tint" color="informative" icon={<BranchFork16Regular />}>
            {TIER_CHIP[props.routedTier].label}
          </Badge>
        </Tooltip>
      )}

      {totalTokens != null && (
        <Tooltip
          content={`${(promptTokens ?? 0).toLocaleString()} input + ${(completionTokens ?? 0).toLocaleString()} output tokens${aoaiCalls && aoaiCalls > 1 ? ` across ${aoaiCalls} model calls` : ''}`}
          relationship="label"
        >
          <span className={`${s.chip} ${s.chipStrong}`}>
            <span className={s.tokenUp}><ArrowUp12Regular aria-hidden />{(promptTokens ?? 0).toLocaleString()}</span>
            {' / '}
            <span className={s.tokenUp}><ArrowDown12Regular aria-hidden />{(completionTokens ?? 0).toLocaleString()}</span>
            {' · Σ'}{totalTokens.toLocaleString()}
          </span>
        </Tooltip>
      )}

      {props.costUsd != null && (
        <Tooltip content="Estimated cost — Azure OpenAI list price over this turn's real token counts" relationship="label">
          <span className={costClass(s, props.costUsd)}><Money16Regular aria-hidden />{fmtCost(props.costUsd)}</span>
        </Tooltip>
      )}

      {props.turnLatencyMs != null && (
        <Tooltip content="Turn latency (wall-clock)" relationship="label">
          <span className={latencyClass(s, props.turnLatencyMs)}><Timer16Regular aria-hidden />{fmtLatency(props.turnLatencyMs)}</span>
        </Tooltip>
      )}

      {toolCalls > 0 && (
        <Tooltip content={`${toolCalls} tool call${toolCalls === 1 ? '' : 's'} this turn`} relationship="label">
          <span className={s.chip}><Wrench16Regular aria-hidden />{toolCalls}</span>
        </Tooltip>
      )}

      {hasDetail && (
        <Button
          appearance="subtle"
          size="small"
          data-testid="copilot-detail-toggle"
          icon={expanded ? <ChevronUp12Regular /> : <ChevronDown12Regular />}
          iconPosition="after"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          aria-label={expanded ? 'Hide turn details' : 'Show turn details'}
        >
          Details
        </Button>
      )}
    </div>
    {hasDetail && expanded && <TurnDetailPanel detail={turnDetail} citations={citations} />}
    </>
  );
}
