'use client';

/**
 * TurnDetailPanel — the expanded Tier-2 detail behind the per-message badge
 * (CTS-02). Opens from the MessageMetadataBar chevron and shows:
 *   • a per-tool-call table (name · via-server/built-in · duration · status)
 *   • routing / delegation info when a persona routed the turn
 *   • a "Sources (N)" grouping of grounding citations by kind (CTS-04)
 *
 * Read-only, Fluent v9 + Loom tokens. The citations render through the shared
 * CitationChips so a doc / schema / memory source stays clickable.
 */

import { Badge, Caption1, Divider, makeStyles, tokens } from '@fluentui/react-components';
import {
  CheckmarkCircle16Regular, ErrorCircle16Regular,
  BranchCompare16Regular, PlugConnected16Regular, Wrench16Regular,
} from '@fluentui/react-icons';
import { CitationChips } from '@/lib/components/help-copilot/citations';
import type { Citation, TurnDetail } from './types';

const useStyles = makeStyles({
  panel: {
    marginTop: tokens.spacingVerticalXS,
    padding: tokens.spacingHorizontalM,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground3,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS,
  },
  section: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS },
  sectionTitle: {
    fontWeight: tokens.fontWeightSemibold, color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeBase200,
  },
  toolRow: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS,
    fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground2,
    flexWrap: 'wrap',
  },
  toolName: { fontWeight: tokens.fontWeightSemibold },
  dur: { color: tokens.colorNeutralForeground3, marginLeft: 'auto' },
  ok: { color: tokens.colorPaletteGreenForeground1, flexShrink: 0 },
  bad: { color: tokens.colorPaletteRedForeground1, flexShrink: 0 },
  errText: { color: tokens.colorPaletteRedForeground1, width: '100%' },
  routeRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap' },
  empty: { color: tokens.colorNeutralForeground3, fontStyle: 'italic' },
});

export interface TurnDetailPanelProps {
  detail?: TurnDetail;
  citations?: Citation[];
}

export function TurnDetailPanel({ detail, citations }: TurnDetailPanelProps) {
  const s = useStyles();
  const tools = detail?.tools ?? [];
  const hasRouting = !!(detail?.routedAgentName || detail?.routedReason);
  const hasCitations = !!(citations && citations.length);

  // Group citations by kind for the "Sources (N)" section.
  const byKind = new Map<string, Citation[]>();
  for (const c of citations ?? []) {
    const k = c.kind || 'source';
    byKind.set(k, [...(byKind.get(k) ?? []), c]);
  }

  return (
    <div className={s.panel} data-testid="copilot-turn-detail">
      {hasRouting && (
        <div className={s.section}>
          <span className={s.sectionTitle}>Routing</span>
          <div className={s.routeRow}>
            <Badge size="small" appearance="tint" color="brand" icon={<BranchCompare16Regular />}>
              {detail!.routedAgentName || 'Agent'}
            </Badge>
            {detail!.routedReason && (
              <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{detail!.routedReason}</Caption1>
            )}
          </div>
        </div>
      )}

      <div className={s.section}>
        <span className={s.sectionTitle}>
          Tool calls{tools.length ? ` (${tools.length})` : ''}
        </span>
        {tools.length === 0 ? (
          <Caption1 className={s.empty}>No tools were called — answered from the model directly.</Caption1>
        ) : (
          tools.map((t, i) => (
            <div key={i} className={s.toolRow}>
              {t.ok
                ? <CheckmarkCircle16Regular className={s.ok} aria-label="Succeeded" />
                : <ErrorCircle16Regular className={s.bad} aria-label="Failed" />}
              <Wrench16Regular aria-hidden style={{ color: tokens.colorNeutralForeground3, flexShrink: 0 }} />
              <span className={s.toolName}>{t.name}</span>
              {t.serverName ? (
                <Badge size="extra-small" appearance="outline" color="informative" icon={<PlugConnected16Regular />}>
                  via {t.serverName}
                </Badge>
              ) : (
                <Badge size="extra-small" appearance="outline" color="subtle">built-in</Badge>
              )}
              <span className={s.dur}>{t.durationMs}ms</span>
              {t.error && <span className={s.errText}>— {t.error}</span>}
            </div>
          ))
        )}
      </div>

      {hasCitations && (
        <div className={s.section}>
          <Divider />
          <span className={s.sectionTitle}>Sources ({citations!.length})</span>
          {[...byKind.entries()].map(([kind, cs]) => (
            <div key={kind} className={s.section}>
              <Caption1 style={{ color: tokens.colorNeutralForeground3, textTransform: 'capitalize' }}>{kind}</Caption1>
              <CitationChips citations={cs} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
