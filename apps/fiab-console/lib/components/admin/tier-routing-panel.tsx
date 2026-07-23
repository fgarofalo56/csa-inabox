'use client';

/**
 * TierRoutingPanel — the "Tier routing" tab of /admin/copilot-quality (E6).
 *
 * Renders REAL tier-router decision quality from GET
 * /api/admin/copilot-quality/tier (Cosmos loom-copilot-evals `tier-run` docs,
 * written by the copilot-evaluator tier mode, which runs the REAL routeTurnTier
 * over the golden content/evals/_tier-labels.jsonl set): tier-decision accuracy,
 * the tier confusion heatmap (expected × chosen), per-task-class accuracy, the
 * per-tier cost-per-quality view (judged grounding per estimated $ from the
 * cost-estimate price coefficients), an accuracy trend, the E3 tierFloors status,
 * a misrouted-prompt drill-in, and a "Run tier evals" trigger.
 *
 * States mirror the answer + search panels: Skeleton, guided EmptyState,
 * HonestGate + Fix-it when the evaluator Function is unwired, FLAG0 kill-switch
 * notice (e6-tier-routing-tab), clean first-open. Fluent v9 + Loom tokens only;
 * badge rows wrap (minWidth:0 + flexWrap) so nothing overlaps at narrow widths.
 * Azure-native, no Fabric/Power BI dependency.
 */
import { Fragment, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Badge, Body1, Button, Caption1, Dialog, DialogSurface, DialogTitle, DialogBody,
  DialogContent, DialogActions, Link as FluentLink, MessageBar, MessageBarBody,
  MessageBarTitle, Skeleton, SkeletonItem, Spinner, Subtitle2, Table, TableBody,
  TableCell, TableHeader, TableHeaderCell, TableRow, Text, Tooltip, makeStyles, tokens,
} from '@fluentui/react-components';
import {
  ArrowSync20Regular, Play20Regular, Router24Regular, Warning20Regular,
  CheckmarkCircle20Regular, DocumentSearch24Regular, Money24Regular,
} from '@fluentui/react-icons';
import NextLink from 'next/link';
import { clientFetch } from '@/lib/client-fetch';
import { EmptyState } from '@/lib/components/empty-state';
import { HonestGate } from '@/lib/components/shared/honest-gate';
import { LoomChart } from '@/lib/components/charts/loom-chart';
import type { TierSummary, TierCostQualityRow, QualityGrade, TierMatrixRow } from '@/lib/admin/copilot-quality';

interface TierResponse {
  ok: boolean;
  flagEnabled: boolean;
  tier: TierSummary | null;
  meanGrounding: number | null;
  costPerQuality: TierCostQualityRow[];
  evaluatorConfigured: boolean;
  drill?: {
    runId: string | null;
    decisions: Array<{ rowId: string; prompt: string; expectedTier: string; chosenTier: string; taskClass: string; chosenTaskClass: string; correct: boolean; deployment?: string }>;
  };
}

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, minWidth: 0 },
  toolbar: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: tokens.spacingHorizontalM, flexWrap: 'wrap', minWidth: 0 },
  overview: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: tokens.spacingHorizontalM },
  tile: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS, minWidth: 0,
    padding: tokens.spacingVerticalM, borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`, backgroundColor: tokens.colorNeutralBackground1, boxShadow: tokens.shadow4,
  },
  tileLabel: { fontSize: tokens.fontSizeBase100, textTransform: 'uppercase', letterSpacing: '0.06em', color: tokens.colorNeutralForeground3, fontWeight: tokens.fontWeightSemibold },
  tileValue: { fontSize: tokens.fontSizeBase500, fontWeight: tokens.fontWeightBold, lineHeight: 1.1, fontVariantNumeric: 'tabular-nums' },
  cards: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 340px), 1fr))', gap: tokens.spacingHorizontalL },
  card: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: 0,
    padding: tokens.spacingVerticalL, borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`, backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4, transition: 'box-shadow 0.15s ease', ':hover': { boxShadow: tokens.shadow16 },
  },
  sectionHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, minWidth: 0 },
  badges: { display: 'flex', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap', minWidth: 0, alignItems: 'center' },
  muted: { color: tokens.colorNeutralForeground3 },
  // Confusion heatmap grid: header + 3 truth rows, each with a corner label cell.
  matrix: { display: 'grid', gridTemplateColumns: 'auto repeat(3, minmax(0, 1fr))', gap: tokens.spacingHorizontalXS, minWidth: 0 },
  mCell: {
    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    padding: tokens.spacingVerticalXS, borderRadius: tokens.borderRadiusMedium, minWidth: 0,
    fontVariantNumeric: 'tabular-nums',
  },
  mHead: { fontSize: tokens.fontSizeBase100, fontWeight: tokens.fontWeightSemibold, color: tokens.colorNeutralForeground3, textAlign: 'center' },
  mCount: { fontSize: tokens.fontSizeBase400, fontWeight: tokens.fontWeightSemibold },
  costRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: tokens.spacingHorizontalM, minWidth: 0, flexWrap: 'wrap' },
  wide: { maxWidth: '900px', width: '92vw' },
});

const GRADE_COLOR: Record<QualityGrade, 'success' | 'brand' | 'warning' | 'danger'> = {
  A: 'success', B: 'brand', C: 'warning', D: 'danger', F: 'danger',
};
const pct = (v: number): string => `${Math.round(v * 100)}%`;

/** A confusion-matrix cell: diagonal (correct) tints green, off-diagonal misroutes red. */
function MatrixCell({ row, chosenTier, count }: { row: TierMatrixRow; chosenTier: string; count: number }) {
  const styles = useStyles();
  const onDiagonal = row.expectedTier === chosenTier;
  const bg = count === 0
    ? tokens.colorNeutralBackground2
    : onDiagonal
      ? tokens.colorPaletteGreenBackground2
      : tokens.colorPaletteRedBackground2;
  const fg = count === 0
    ? tokens.colorNeutralForeground4
    : onDiagonal
      ? tokens.colorPaletteGreenForeground1
      : tokens.colorPaletteRedForeground1;
  const share = row.total > 0 ? Math.round((count / row.total) * 100) : 0;
  return (
    <div className={styles.mCell} style={{ backgroundColor: bg }}>
      <span className={styles.mCount} style={{ color: fg }}>{count}</span>
      <Caption1 style={{ color: fg }}>{share}%</Caption1>
    </div>
  );
}

export function TierRoutingPanel() {
  const styles = useStyles();
  const qc = useQueryClient();
  const [drillOpen, setDrillOpen] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [runNote, setRunNote] = useState<string | null>(null);

  const q = useQuery<TierResponse>({
    queryKey: ['tier-quality'],
    queryFn: async () => {
      const r = await clientFetch('/api/admin/copilot-quality/tier');
      const j = await r.json();
      if (!j?.ok) throw new Error(j?.error || `load failed (${r.status})`);
      return j as TierResponse;
    },
  });

  const runNow = useMutation({
    mutationFn: async () => {
      setRunError(null); setRunNote(null);
      const r = await clientFetch('/api/admin/copilot-quality/run', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'tier' }),
      });
      const j = await r.json().catch(() => null);
      if (!j?.ok) throw new Error(j?.error || j?.gate?.remediation || `run failed (${r.status})`);
      return j;
    },
    onSuccess: (j) => { setRunNote(j?.note || 'Tier eval run accepted.'); setTimeout(() => qc.invalidateQueries({ queryKey: ['tier-quality'] }), 4000); },
    onError: (e) => setRunError(e instanceof Error ? e.message : String(e)),
  });

  if (q.isLoading) {
    return (
      <Skeleton aria-label="Loading tier routing">
        <div className={styles.overview} style={{ marginBottom: tokens.spacingVerticalL }}>
          {[0, 1, 2, 3].map((i) => <SkeletonItem key={i} style={{ height: '76px', borderRadius: tokens.borderRadiusLarge }} />)}
        </div>
        <div className={styles.cards}>{[0, 1].map((i) => <SkeletonItem key={i} style={{ height: '220px', borderRadius: tokens.borderRadiusLarge }} />)}</div>
      </Skeleton>
    );
  }
  if (q.isError) {
    return <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Could not load tier routing</MessageBarTitle>{(q.error as Error)?.message}</MessageBarBody></MessageBar>;
  }

  const data = q.data!;

  // FLAG0 kill-switch — OFF hides the tab body behind a guided notice (no roll).
  if (data.flagEnabled === false) {
    return (
      <MessageBar intent="info" layout="multiline"><MessageBarBody>
        <MessageBarTitle>Tier routing tab is turned off</MessageBarTitle>
        The <code>e6-tier-routing-tab</code> runtime flag is currently OFF. The copilot-evaluator tier mode and its
        nightly/per-roll runs keep going; only this view is hidden. Re-enable it under{' '}
        <NextLink href="/admin/runtime-flags" legacyBehavior><FluentLink>Runtime flags</FluentLink></NextLink>.
      </MessageBarBody></MessageBar>
    );
  }

  const tier = data.tier;

  return (
    <div className={styles.root}>
      {!data.evaluatorConfigured && (
        <HonestGate gateId="svc-copilot-evaluator" surface="Tier routing — Run tier evals" onResolved={() => q.refetch()} />
      )}
      <div className={styles.toolbar}>
        <div className={styles.badges}>
          <Router24Regular />
          <Subtitle2>Tier-router decision quality</Subtitle2>
          <Caption1 className={styles.muted}>REAL routeTurnTier vs the labeled set</Caption1>
        </div>
        <div className={styles.badges}>
          <Button appearance="secondary" icon={<ArrowSync20Regular />} onClick={() => q.refetch()} disabled={q.isFetching}>Refresh</Button>
          <Tooltip content={data.evaluatorConfigured ? 'Run the golden tier-label set through the real router.' : 'Configure LOOM_COPILOT_EVALUATOR_URL to enable on-demand runs.'} relationship="label">
            <Button appearance="primary" icon={runNow.isPending ? <Spinner size="tiny" /> : <Play20Regular />}
              disabled={!data.evaluatorConfigured || runNow.isPending} onClick={() => runNow.mutate()}>
              Run tier evals
            </Button>
          </Tooltip>
        </div>
      </div>

      {runError && <MessageBar intent="warning"><MessageBarBody>{runError}</MessageBarBody></MessageBar>}
      {runNote && <MessageBar intent="success"><MessageBarBody>{runNote}</MessageBarBody></MessageBar>}

      {/* Overview tiles */}
      <div className={styles.overview}>
        <div className={styles.tile}><span className={styles.tileLabel}>Tier accuracy</span><span className={styles.tileValue}>{tier ? pct(tier.latest.totals.tierAccuracy) : '—'}</span><Caption1 className={styles.muted}>{tier ? `${tier.latest.totals.rows} labeled prompts` : 'no runs yet'}</Caption1></div>
        <div className={styles.tile}><span className={styles.tileLabel}>Task-class accuracy</span><span className={styles.tileValue}>{tier ? pct(tier.latest.totals.taskClassAccuracy) : '—'}</span><Caption1 className={styles.muted}>classifier vs labels</Caption1></div>
        <div className={styles.tile}><span className={styles.tileLabel}>Grade</span><span className={styles.tileValue}>{tier ? tier.grade : '—'}</span><Caption1 className={styles.muted}>accuracy band</Caption1></div>
        <div className={styles.tile}>
          <span className={styles.tileLabel}>Floor</span>
          <span className={styles.tileValue} style={{ fontSize: tokens.fontSizeBase300, color: tier?.belowFloor ? tokens.colorPaletteRedForeground1 : undefined }}>
            {tier?.floorStatus.floor == null ? 'no floor' : `${pct(tier.floorStatus.floor)} min`}
          </span>
          <Caption1 className={styles.muted}>{tier?.provisionalFloor ? 'provisional seed' : 'tierFloors.router'}</Caption1>
        </div>
      </div>

      {!tier ? (
        <EmptyState
          icon={<DocumentSearch24Regular />}
          title="No tier-routing runs yet"
          body={data.evaluatorConfigured
            ? 'The evaluator is wired but has no tier-run docs yet. Click "Run tier evals" (or wait for the nightly run) to route the golden _tier-labels.jsonl prompts through the real model-tier-router and score each decision.'
            : 'Deploy the copilot-evaluator Function and set LOOM_COPILOT_EVALUATOR_URL, then run the tier-label set. Tier accuracy, the confusion heatmap, and cost-per-quality will trend here.'}
          primaryAction={data.evaluatorConfigured ? { label: 'Run tier evals', onClick: () => runNow.mutate() } : { label: 'Gate registry', href: '/admin/gates' }}
          secondaryAction={{ label: 'Runtime flags', href: '/admin/runtime-flags' }}
        />
      ) : (
        <>
          <div className={styles.badges}>
            {tier.floorStatus.verdict === 'ok' && <Badge appearance="tint" color="success" size="small" icon={<CheckmarkCircle20Regular />}>accuracy ≥ floor</Badge>}
            {tier.floorStatus.verdict === 'below' && <Badge appearance="tint" color="danger" size="small" icon={<Warning20Regular />}>accuracy &lt; floor</Badge>}
            {tier.provisionalFloor && <Badge appearance="outline" size="small" color="informative">provisional floor</Badge>}
            <Badge appearance="filled" color={GRADE_COLOR[tier.grade]} size="large">{tier.grade}</Badge>
          </div>

          <div className={styles.cards}>
            {/* Confusion heatmap: expected (truth) × chosen (prediction) */}
            <div className={styles.card}>
              <div className={styles.sectionHead}><Router24Regular /><Subtitle2>Tier confusion</Subtitle2></div>
              <Caption1 className={styles.muted}>Rows = expected tier · columns = tier the router chose. Diagonal = correct.</Caption1>
              <div className={styles.matrix}>
                <div className={styles.mHead} />
                {tier.matrix.map((r) => <div key={`h-${r.expectedTier}`} className={styles.mHead}>{r.expectedTier}</div>)}
                {tier.matrix.map((row) => (
                  <Fragment key={`row-${row.expectedTier}`}>
                    <div className={styles.mHead} style={{ display: 'flex', alignItems: 'center' }}>{row.expectedTier}</div>
                    {row.cells.map((c) => (
                      <MatrixCell key={`${row.expectedTier}-${c.chosenTier}`} row={row} chosenTier={c.chosenTier} count={c.count} />
                    ))}
                  </Fragment>
                ))}
              </div>
              <div className={styles.badges}>
                <Button size="small" appearance="secondary" icon={<DocumentSearch24Regular />} onClick={() => setDrillOpen(true)}>Misrouted prompts</Button>
              </div>
            </div>

            {/* Per-task-class accuracy */}
            <div className={styles.card}>
              <div className={styles.sectionHead}><CheckmarkCircle20Regular /><Subtitle2>Accuracy by task class</Subtitle2></div>
              <LoomChart
                type="bar"
                height={160}
                rows={tier.perClass.map((c) => ({ Class: c.taskClass, Accuracy: Math.round(c.accuracy * 100) }))}
              />
              <div className={styles.badges}>
                {tier.perClass.map((c) => (
                  <Badge key={c.taskClass} appearance="outline" size="small">{c.taskClass}: {pct(c.accuracy)} ({c.correct}/{c.total})</Badge>
                ))}
              </div>
            </div>

            {/* Cost-per-quality */}
            <div className={styles.card}>
              <div className={styles.sectionHead}><Money24Regular /><Subtitle2>Cost-per-quality</Subtitle2></div>
              <Caption1 className={styles.muted}>
                Judged grounding per estimated $ — {data.meanGrounding == null ? 'grounding not yet judged' : `${data.meanGrounding.toFixed(2)}/5 grounding`} ÷ blended tier list price. Higher = cheaper quality.
              </Caption1>
              {data.costPerQuality.map((row) => (
                <div key={row.tier} className={styles.costRow}>
                  <div className={styles.badges}>
                    <Badge appearance="tint" size="small" color={row.tier === 'mini' ? 'success' : row.tier === 'strong' ? 'danger' : 'brand'}>{row.tier}</Badge>
                    <Caption1 className={styles.muted}>${row.coeff.toFixed(4)}/1K</Caption1>
                  </div>
                  <Text style={{ fontWeight: tokens.fontWeightSemibold, fontVariantNumeric: 'tabular-nums' }}>
                    {row.qualityPerDollar == null ? '—' : `${row.qualityPerDollar.toLocaleString()} q/$`}
                  </Text>
                </div>
              ))}
            </div>
          </div>

          {/* Accuracy trend */}
          <div className={styles.card}>
            <div className={styles.sectionHead}><ArrowSync20Regular /><Subtitle2>Accuracy trend</Subtitle2></div>
            {tier.trend.length > 1 ? (
              <LoomChart type="line" height={130}
                rows={tier.trend.map((p) => ({ Run: (p.finishedAt || '').slice(5, 10), 'Tier acc': Math.round(p.tierAccuracy * 100), 'Class acc': Math.round(p.taskClassAccuracy * 100) }))} />
            ) : (
              <Caption1 className={styles.muted}>{tier.latest.totals.rows} prompts · one run so far — the trend appears after the next run.</Caption1>
            )}
            <Caption1 className={styles.muted}>{tier.runCount} run(s) retained · last {new Date(tier.latest.finishedAt).toLocaleString()} · {tier.latest.trigger}</Caption1>
          </div>
        </>
      )}

      {drillOpen && <TierDrillDialog onClose={() => setDrillOpen(false)} />}
    </div>
  );
}

function TierDrillDialog({ onClose }: { onClose: () => void }) {
  const styles = useStyles();
  const drill = useQuery<TierResponse>({
    queryKey: ['tier-quality-drill'],
    queryFn: async () => {
      const r = await clientFetch('/api/admin/copilot-quality/tier?drill=1');
      const j = await r.json();
      if (!j?.ok) throw new Error(j?.error || `drill load failed (${r.status})`);
      return j as TierResponse;
    },
  });
  const decisions = drill.data?.drill?.decisions ?? [];
  const misrouted = decisions.filter((d) => !d.correct);

  return (
    <Dialog open onOpenChange={(_, d) => { if (!d.open) onClose(); }}>
      <DialogSurface className={styles.wide}>
        <DialogBody>
          <DialogTitle>Tier routing — decisions</DialogTitle>
          <DialogContent>
            {drill.isLoading && <Spinner size="tiny" label="Loading run…" labelPosition="after" />}
            {drill.isError && <MessageBar intent="error"><MessageBarBody>{(drill.error as Error)?.message}</MessageBarBody></MessageBar>}
            {drill.data && (
              <div className={styles.root}>
                {decisions.length === 0 ? (
                  <MessageBar intent="info"><MessageBarBody>No scored decisions in this run yet.</MessageBarBody></MessageBar>
                ) : misrouted.length === 0 ? (
                  <MessageBar intent="success"><MessageBarBody>
                    <MessageBarTitle>Every labeled prompt routed correctly</MessageBarTitle>
                    All {decisions.length} decisions matched the expected tier.
                  </MessageBarBody></MessageBar>
                ) : (
                  <Table size="small" aria-label="Misrouted prompts">
                    <TableHeader><TableRow>
                      <TableHeaderCell>Prompt</TableHeaderCell>
                      <TableHeaderCell>Expected</TableHeaderCell>
                      <TableHeaderCell>Chosen</TableHeaderCell>
                      <TableHeaderCell>Task class</TableHeaderCell>
                    </TableRow></TableHeader>
                    <TableBody>
                      {misrouted.map((d) => (
                        <TableRow key={d.rowId}>
                          <TableCell><Text truncate wrap={false} style={{ maxWidth: '360px', display: 'block' }}>{d.prompt}</Text></TableCell>
                          <TableCell><Badge appearance="tint" size="small" color="informative">{d.expectedTier}</Badge></TableCell>
                          <TableCell><Badge appearance="tint" size="small" color="danger">{d.chosenTier}</Badge></TableCell>
                          <TableCell><Caption1>{d.taskClass} → {d.chosenTaskClass}</Caption1></TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
                {decisions.length > 0 && (
                  <Body1 className={styles.muted}>{decisions.length - misrouted.length} of {decisions.length} routed correctly.</Body1>
                )}
              </div>
            )}
          </DialogContent>
          <DialogActions><Button appearance="secondary" onClick={onClose}>Close</Button></DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
