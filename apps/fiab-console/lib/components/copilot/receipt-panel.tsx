'use client';

/**
 * ReceiptPanel — the per-answer Answer Receipt (N10) in the Copilot dock.
 *
 * A collapsible panel under every agentic answer that renders the assembled
 * {@link AnswerReceipt}: the plan the loop followed, the EXACT SQL/KQL/Cypher it
 * executed with real row counts, the grounding sources + graph paths + metrics,
 * which model tier answered, the token cost, the per-phase timings, and the
 * Verified ✓ / Unverified ⚠ / Refused ⛔ verdict — plus the persisted
 * governance-audit reference (the loom-answer-receipts doc id). For a CDO/auditor
 * this is the buy signal; in an IL5 / air-gap boundary the receipt IS the
 * compliance artifact.
 *
 * Collapsed by default (the verdict badge is always visible; the body expands on
 * click). Fluent v9 + Loom tokens only, keyboard-accessible (button toggle with
 * aria-expanded / aria-controls; the body is a labelled region).
 */

import { useId, useState, type ReactElement } from 'react';
import { Badge, Button, Caption1, Divider, Tooltip, makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import {
  ShieldCheckmark16Regular, Warning16Regular, DismissCircle16Regular,
  Database16Regular, Flowchart16Regular, DataTrending16Regular,
  Money16Regular, Timer16Regular, BranchFork16Regular, Wrench16Regular,
  PlugConnected16Regular, DocumentBulletList16Regular, TextBulletList16Regular,
  CheckmarkCircle16Regular, ChevronDown12Regular, ChevronRight12Regular,
} from '@fluentui/react-icons';
import { VERDICT_META, type AnswerReceipt, type ReceiptQuery, type ReceiptVerdict } from '@/lib/copilot/answer-receipt';

const useStyles = makeStyles({
  root: {
    marginTop: tokens.spacingVerticalXS,
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground3,
    overflow: 'hidden',
  },
  header: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS,
    width: '100%', justifyContent: 'flex-start',
    paddingLeft: tokens.spacingHorizontalS, paddingRight: tokens.spacingHorizontalS,
  },
  headerSpacer: { marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalXS },
  body: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM,
    padding: tokens.spacingHorizontalM,
    borderTop: `1px solid ${tokens.colorNeutralStroke3}`,
  },
  section: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, minWidth: 0 },
  sectionTitle: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS,
    fontWeight: tokens.fontWeightSemibold, color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeBase200,
  },
  planList: { margin: 0, paddingLeft: tokens.spacingHorizontalL, display: 'flex', flexDirection: 'column', gap: '2px' },
  planItem: { color: tokens.colorNeutralForeground2, fontSize: tokens.fontSizeBase200 },
  query: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS,
    padding: tokens.spacingHorizontalS,
    borderRadius: tokens.borderRadiusSmall,
    backgroundColor: tokens.colorNeutralBackground2,
    border: `1px solid ${tokens.colorNeutralStroke3}`,
    minWidth: 0,
  },
  queryHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap', minWidth: 0 },
  queryTool: { fontWeight: tokens.fontWeightSemibold, color: tokens.colorNeutralForeground2, fontSize: tokens.fontSizeBase200 },
  queryMeta: { marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalXS },
  code: {
    margin: 0,
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground1,
    backgroundColor: tokens.colorNeutralBackground1,
    borderRadius: tokens.borderRadiusSmall,
    padding: tokens.spacingHorizontalS,
    whiteSpace: 'pre',
    overflowX: 'auto',
    maxHeight: '160px',
    overflowY: 'auto',
  },
  chipRow: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalXS, minWidth: 0 },
  footer: {
    display: 'flex', alignItems: 'center', flexWrap: 'wrap',
    gap: tokens.spacingHorizontalS, rowGap: tokens.spacingVerticalXXS,
  },
  footChip: {
    display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalXXS,
    color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200, whiteSpace: 'nowrap',
  },
  refId: {
    fontFamily: tokens.fontFamilyMonospace, color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase100, wordBreak: 'break-all',
  },
  empty: { color: tokens.colorNeutralForeground3, fontStyle: 'italic', fontSize: tokens.fontSizeBase200 },
  ok: { color: tokens.colorPaletteGreenForeground1, flexShrink: 0 },
  bad: { color: tokens.colorPaletteRedForeground1, flexShrink: 0 },
});

/** Verdict → Fluent Badge color + icon. */
const VERDICT_BADGE: Record<ReceiptVerdict, { color: 'success' | 'warning' | 'danger'; icon: ReactElement }> = {
  verified: { color: 'success', icon: <ShieldCheckmark16Regular /> },
  unverified: { color: 'warning', icon: <Warning16Regular /> },
  refused: { color: 'danger', icon: <DismissCircle16Regular /> },
};

/** Query dialect → short uppercase label for the chip. */
function langLabel(lang: ReceiptQuery['language']): string {
  return lang === 'query' ? 'QUERY' : lang.toUpperCase();
}

function fmtCost(usd: number): string {
  if (usd <= 0) return '$0';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(usd < 1 ? 3 : 2)}`;
}
function fmtMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
}

export interface ReceiptPanelProps {
  receipt: AnswerReceipt;
  /** Start expanded (default false — collapsed). */
  defaultExpanded?: boolean;
}

export function ReceiptPanel({ receipt, defaultExpanded = false }: ReceiptPanelProps) {
  const s = useStyles();
  const [expanded, setExpanded] = useState(defaultExpanded);
  const bodyId = useId();

  const verdictMeta = VERDICT_META[receipt.verdict];
  const badge = VERDICT_BADGE[receipt.verdict];
  const hasQueries = receipt.queries.length > 0;
  const hasSources = receipt.sources.length > 0;
  const hasPlan = receipt.planSteps.length > 0;
  const hasTools = receipt.tools.length > 0;

  return (
    <div className={s.root} data-testid="copilot-answer-receipt">
      <Button
        appearance="subtle"
        size="small"
        className={s.header}
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        aria-controls={bodyId}
        icon={expanded ? <ChevronDown12Regular /> : <ChevronRight12Regular />}
      >
        <DocumentBulletList16Regular aria-hidden style={{ color: tokens.colorNeutralForeground3 }} />
        <span style={{ fontWeight: tokens.fontWeightSemibold }}>Receipt</span>
        <span className={s.headerSpacer}>
          <Tooltip content={verdictMeta.tip} relationship="label">
            <Badge size="small" appearance="filled" color={badge.color} icon={badge.icon}>
              {verdictMeta.glyph} {verdictMeta.label}
            </Badge>
          </Tooltip>
        </span>
      </Button>

      {expanded && (
        <div className={s.body} id={bodyId} role="region" aria-label="Answer receipt details">
          {receipt.refused && receipt.refusalReason && (
            <Caption1 style={{ color: tokens.colorPaletteRedForeground1 }}>
              {receipt.refusalReason}
            </Caption1>
          )}

          {/* Plan */}
          {hasPlan && (
            <div className={s.section}>
              <span className={s.sectionTitle}>
                <TextBulletList16Regular aria-hidden />Plan
              </span>
              <ol className={s.planList}>
                {receipt.planSteps.map((p, i) => (
                  <li key={i} className={s.planItem}>{p}</li>
                ))}
              </ol>
            </div>
          )}

          {/* Queries executed */}
          <div className={s.section}>
            <span className={s.sectionTitle}>
              <Database16Regular aria-hidden />Queries executed{hasQueries ? ` (${receipt.queries.length})` : ''}
            </span>
            {!hasQueries ? (
              <Caption1 className={s.empty}>No queries were executed — answered from the model + grounding.</Caption1>
            ) : (
              receipt.queries.map((q, i) => (
                <div key={i} className={s.query}>
                  <div className={s.queryHead}>
                    {q.ok
                      ? <CheckmarkCircle16Regular className={s.ok} aria-label="Succeeded" />
                      : <DismissCircle16Regular className={s.bad} aria-label="Failed" />}
                    <Badge size="extra-small" appearance="tint" color="brand">{langLabel(q.language)}</Badge>
                    <span className={s.queryTool}>{q.tool}</span>
                    <span className={s.queryMeta}>
                      {typeof q.rowCount === 'number' && (
                        <Badge size="extra-small" appearance="outline" color="informative">
                          {q.rowCount.toLocaleString()} row{q.rowCount === 1 ? '' : 's'}
                        </Badge>
                      )}
                      {typeof q.durationMs === 'number' && (
                        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{fmtMs(q.durationMs)}</Caption1>
                      )}
                    </span>
                  </div>
                  <pre className={s.code}>{q.text}</pre>
                  {q.error && (
                    <Caption1 style={{ color: tokens.colorPaletteRedForeground1 }}>— {q.error}</Caption1>
                  )}
                </div>
              ))
            )}
          </div>

          {/* Graph paths + metrics */}
          {(receipt.graphPaths > 0 || receipt.metrics.length > 0) && (
            <div className={s.section}>
              <span className={s.sectionTitle}>
                <Flowchart16Regular aria-hidden />Graph &amp; metrics
              </span>
              <div className={s.chipRow}>
                {receipt.graphPaths > 0 && (
                  <Badge size="small" appearance="tint" color="informative" icon={<Flowchart16Regular />}>
                    {receipt.graphPaths.toLocaleString()} graph path{receipt.graphPaths === 1 ? '' : 's'}
                  </Badge>
                )}
                {receipt.metrics.map((m, i) => (
                  <Badge key={i} size="small" appearance="outline" color="subtle" icon={<DataTrending16Regular />}>
                    {m}
                  </Badge>
                ))}
              </div>
            </div>
          )}

          {/* Sources */}
          {hasSources && (
            <div className={s.section}>
              <span className={s.sectionTitle}>
                <DocumentBulletList16Regular aria-hidden />Sources ({receipt.sources.length})
              </span>
              <div className={s.chipRow}>
                {receipt.sources.map((src) => {
                  const label = src.heading || src.path || src.id;
                  const chip = (
                    <Badge size="small" appearance="outline" color="subtle">
                      {src.kind}: {label}
                    </Badge>
                  );
                  return src.url ? (
                    <a key={src.id} href={src.url} target="_blank" rel="noreferrer" style={{ textDecoration: 'none' }}>{chip}</a>
                  ) : (
                    <span key={src.id}>{chip}</span>
                  );
                })}
              </div>
            </div>
          )}

          {/* Tools */}
          {hasTools && (
            <div className={s.section}>
              <span className={s.sectionTitle}>
                <Wrench16Regular aria-hidden />Tools ({receipt.tools.length})
              </span>
              <div className={s.chipRow}>
                {receipt.tools.map((t, i) => (
                  <Badge
                    key={i}
                    size="small"
                    appearance="outline"
                    color={t.ok ? 'subtle' : 'danger'}
                    icon={t.serverName ? <PlugConnected16Regular /> : undefined}
                  >
                    {t.name}{t.serverName ? ` · ${t.serverName}` : ''} · {fmtMs(t.durationMs)}
                  </Badge>
                ))}
              </div>
            </div>
          )}

          <Divider />

          {/* Footer — tier, cost, timing, persisted reference */}
          <div className={s.footer}>
            {receipt.modelTier && (
              <Tooltip content={`Routed to the ${receipt.modelTier} tier${receipt.taskClass ? ` · ${receipt.taskClass} task` : ''}`} relationship="label">
                <span className={s.footChip}><BranchFork16Regular aria-hidden />{receipt.modelTier} tier</span>
              </Tooltip>
            )}
            {receipt.model && (
              <span className={s.footChip}>{receipt.model}</span>
            )}
            {typeof receipt.tokens.total === 'number' && (
              <span className={s.footChip}>Σ {receipt.tokens.total.toLocaleString()} tok</span>
            )}
            {typeof receipt.costUsd === 'number' && (
              <Tooltip content="Estimated cost — list price over this turn's real token counts" relationship="label">
                <span className={s.footChip}><Money16Regular aria-hidden />{fmtCost(receipt.costUsd)}</span>
              </Tooltip>
            )}
            {typeof receipt.totalMs === 'number' && (
              <span className={s.footChip}><Timer16Regular aria-hidden />{fmtMs(receipt.totalMs)}</span>
            )}
          </div>

          {receipt.id && (
            <Tooltip content="Persisted governance-audit reference (loom-answer-receipts)" relationship="label">
              <span className={mergeClasses(s.refId)}>Receipt {receipt.id}</span>
            </Tooltip>
          )}
        </div>
      )}
    </div>
  );
}
