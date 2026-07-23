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

          {/* N11 — graph-path citations (the exact ontology traversal) */}
          {!!receipt.graphPathCitations?.length && (
            <div className={s.section} data-testid="receipt-graph-paths">
              <span className={s.sectionTitle}>
                <Flowchart16Regular aria-hidden />Graph paths ({receipt.graphPathCitations.length})
              </span>
              <ol className={s.planList}>
                {receipt.graphPathCitations.map((p, i) => (
                  <li key={p.id || i} className={s.planItem}>
                    <span style={{ fontFamily: tokens.fontFamilyMonospace }}>{p.text}</span>
                    <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalXXS, marginLeft: tokens.spacingHorizontalXS, minWidth: 0 }}>
                      <Badge size="extra-small" appearance="outline" color="informative">
                        {p.hops} hop{p.hops === 1 ? '' : 's'}
                      </Badge>
                      {p.communityId && (
                        <Badge size="extra-small" appearance="tint" color="subtle">{p.communityId}</Badge>
                      )}
                    </span>
                  </li>
                ))}
              </ol>
              <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                Traversed on the authored ontology (Apache AGE on in-VNet PostgreSQL — no external egress).
              </Caption1>
            </div>
          )}

          {/* N12 — self-healing repair attempts */}
          {!!receipt.repairAttempts?.length && (
            <div className={s.section} data-testid="receipt-repair-attempts">
              <span className={s.sectionTitle}>
                <Wrench16Regular aria-hidden />Repair attempts ({receipt.repairAttempts.length})
              </span>
              {receipt.repairAttempts.map((r, i) => (
                <div key={i} className={s.query}>
                  <div className={s.queryHead}>
                    <Badge
                      size="extra-small"
                      appearance="tint"
                      color={r.outcome === 'repaired' ? 'success' : r.outcome === 'abandoned' ? 'danger' : 'warning'}
                    >
                      step {r.step} · attempt {r.attempt} · {r.outcome}
                    </Badge>
                    <span className={s.queryMeta}>
                      {typeof r.rowCount === 'number' && (
                        <Badge size="extra-small" appearance="outline" color="informative">
                          {r.rowCount.toLocaleString()} row{r.rowCount === 1 ? '' : 's'}
                        </Badge>
                      )}
                      {r.metricConsulted && (
                        <Badge size="extra-small" appearance="outline" color="subtle" icon={<DataTrending16Regular />}>
                          {r.metricConsulted}
                        </Badge>
                      )}
                    </span>
                  </div>
                  <Caption1 style={{ color: tokens.colorNeutralForeground2 }}>{r.reason}</Caption1>
                  {r.error && (
                    <Caption1 style={{ color: tokens.colorPaletteRedForeground1 }}>— {r.error}</Caption1>
                  )}
                  {r.rewrittenQuery && <pre className={s.code}>{r.rewrittenQuery}</pre>}
                  {r.explainSummary && (
                    <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>EXPLAIN: {r.explainSummary}</Caption1>
                  )}
                  {r.explainError && (
                    <Caption1 style={{ color: tokens.colorPaletteYellowForeground1 }}>
                      EXPLAIN rejected the rewrite (not executed): {r.explainError}
                    </Caption1>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* N12 — plausibility: does the answer follow from the real rows? */}
          {receipt.plausibility && (
            <div className={s.section} data-testid="receipt-plausibility">
              <span className={s.sectionTitle}>
                {receipt.plausibility.plausible
                  ? <CheckmarkCircle16Regular aria-hidden className={s.ok} />
                  : <Warning16Regular aria-hidden />}
                Plausibility
              </span>
              <Caption1 style={{ color: tokens.colorNeutralForeground2 }}>
                {receipt.plausibility.reason}
              </Caption1>
              {!!receipt.plausibility.unsupportedFigures?.length && (
                <div className={s.chipRow}>
                  {receipt.plausibility.unsupportedFigures.map((f, i) => (
                    <Badge key={i} size="extra-small" appearance="outline" color="danger">unsupported: {f}</Badge>
                  ))}
                </div>
              )}
            </div>
          )}

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
