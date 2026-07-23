'use client';

/**
 * CopilotQualityPanel — the /admin/copilot-quality view (E5, loom-next-level).
 *
 * Renders REAL per-surface Copilot eval scores from GET
 * /api/admin/copilot-quality (Cosmos loom-copilot-evals, written by the E2
 * copilot-evaluator Function): a headline overview, per-surface scorecards
 * (composite grade + retrieval hit-rate / grounding / pass-rate + floor status
 * + run-history sparkline), a "Run now" trigger (POST …/run → the E2 HTTP
 * trigger, honest-gated when the Function URL is unwired), and a per-surface
 * drill-in dialog (worst questions with expected-vs-retrieved chunks + the LLM
 * judge's own rationale).
 *
 * States (ux-baseline): Skeleton while loading; guided EmptyState naming the
 * exact unblocking step when no runs exist yet; HonestGate + Fix-it when the
 * evaluator Function is unconfigured (never a red first-open — the page still
 * renders whatever history exists); FLAG0 kill-switch notice when the
 * e5-copilot-quality-page flag is OFF. Fluent v9 + Loom tokens only; badge rows
 * wrap (minWidth:0 + flexWrap) so nothing overlaps at narrow widths.
 */
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Badge, Body1, Button, Caption1, Dialog, DialogSurface, DialogTitle, DialogBody,
  DialogContent, DialogActions, Dropdown, Link as FluentLink, MessageBar,
  MessageBarBody, MessageBarTitle, Option, Skeleton, SkeletonItem, Spinner,
  Subtitle2, Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow,
  Text, Tooltip, makeStyles, tokens,
} from '@fluentui/react-components';
import {
  ArrowSync20Regular, Play20Regular, TargetArrow24Regular, Warning20Regular,
  CheckmarkCircle20Regular, DocumentSearch24Regular,
} from '@fluentui/react-icons';
import NextLink from 'next/link';
import { clientFetch } from '@/lib/client-fetch';
import { EmptyState } from '@/lib/components/empty-state';
import { HonestGate } from '@/lib/components/shared/honest-gate';
import { LoomChart } from '@/lib/components/charts/loom-chart';
import type {
  SurfaceSummary, QualityOverview, FloorStatus, QualityGrade, WorstQuestion,
} from '@/lib/admin/copilot-quality';
import { worstReasonLabel } from '@/lib/admin/copilot-quality';

interface SummariesResponse {
  ok: boolean;
  flagEnabled: boolean;
  surfaces: SurfaceSummary[];
  overview: QualityOverview;
  floorsMeta: { lastRatchet?: string | null; note?: string } | null;
  evaluatorConfigured: boolean;
}

interface DrillResponse {
  ok: boolean;
  surface: string;
  runId: string | null;
  history: Array<{ runId: string; finishedAt: string; trigger: string; judgeModel: string; corpusCommit: string; totals: SurfaceSummary['latest']['totals'] }>;
  worst: WorstQuestion[];
  resultCount: number;
}

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, minWidth: 0 },
  toolbar: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    gap: tokens.spacingHorizontalM, flexWrap: 'wrap', minWidth: 0,
  },
  overview: {
    display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
    gap: tokens.spacingHorizontalM,
  },
  tile: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS, minWidth: 0,
    padding: tokens.spacingVerticalM, borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`, backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
  },
  tileLabel: {
    fontSize: tokens.fontSizeBase100, textTransform: 'uppercase', letterSpacing: '0.06em',
    color: tokens.colorNeutralForeground3, fontWeight: tokens.fontWeightSemibold,
  },
  tileValue: { fontSize: tokens.fontSizeBase500, fontWeight: tokens.fontWeightBold, lineHeight: 1.1, fontVariantNumeric: 'tabular-nums' },
  cards: {
    display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 320px), 1fr))',
    gap: tokens.spacingHorizontalL,
  },
  card: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, minWidth: 0,
    padding: tokens.spacingVerticalL, borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`, backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4, transition: 'box-shadow 0.15s ease',
    ':hover': { boxShadow: tokens.shadow16 },
  },
  cardHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, justifyContent: 'space-between', minWidth: 0 },
  surfaceName: { fontWeight: tokens.fontWeightSemibold, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  metricRow: { display: 'flex', gap: tokens.spacingHorizontalL, flexWrap: 'wrap', minWidth: 0 },
  metric: { display: 'flex', flexDirection: 'column', minWidth: 0 },
  metricVal: { fontSize: tokens.fontSizeBase400, fontWeight: tokens.fontWeightSemibold, fontVariantNumeric: 'tabular-nums' },
  badges: { display: 'flex', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap', minWidth: 0, alignItems: 'center' },
  muted: { color: tokens.colorNeutralForeground3 },
  chunk: {
    fontFamily: tokens.fontFamilyMonospace, fontSize: tokens.fontSizeBase200,
    display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0,
  },
  drillSection: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, minWidth: 0 },
  wide: { maxWidth: '920px', width: '92vw' },
});

const GRADE_COLOR: Record<QualityGrade, 'success' | 'brand' | 'warning' | 'danger'> = {
  A: 'success', B: 'brand', C: 'warning', D: 'danger', F: 'danger',
};

function pct(v: number | null): string {
  return v == null ? '—' : `${Math.round(v * 100)}%`;
}
function grounding(v: number | null): string {
  return v == null ? 'deferred' : `${v.toFixed(2)} / 5`;
}

function FloorBadge({ f }: { f: FloorStatus }) {
  if (f.verdict === 'no-floor' || f.verdict === 'not-judged') return null;
  const ok = f.verdict === 'ok';
  const label = f.metric === 'retrievalHitRate' ? 'hit-rate' : f.metric === 'groundingAvg' ? 'grounding' : 'pass-rate';
  return (
    <Badge appearance="tint" color={ok ? 'success' : 'danger'} size="small"
      icon={ok ? <CheckmarkCircle20Regular /> : <Warning20Regular />}>
      {label} {ok ? '≥ floor' : '< floor'}
    </Badge>
  );
}

export function CopilotQualityPanel() {
  const styles = useStyles();
  const qc = useQueryClient();
  const [drillSurface, setDrillSurface] = useState<string | null>(null);
  const [drillRun, setDrillRun] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [runNote, setRunNote] = useState<string | null>(null);

  const summaries = useQuery<SummariesResponse>({
    queryKey: ['copilot-quality'],
    queryFn: async () => {
      const r = await clientFetch('/api/admin/copilot-quality');
      const j = await r.json();
      if (!j?.ok) throw new Error(j?.error || `load failed (${r.status})`);
      return j as SummariesResponse;
    },
  });

  const runNow = useMutation({
    mutationFn: async (surfaces: string[]) => {
      setRunError(null); setRunNote(null);
      const r = await clientFetch('/api/admin/copilot-quality/run', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ surfaces }),
      });
      const j = await r.json().catch(() => null);
      if (!j?.ok) throw new Error(j?.error || j?.gate?.remediation || `run failed (${r.status})`);
      return j;
    },
    onSuccess: (j) => {
      setRunNote(j?.note || 'Run accepted.');
      // Re-read after a short delay so freshly-written scores appear.
      setTimeout(() => qc.invalidateQueries({ queryKey: ['copilot-quality'] }), 4000);
    },
    onError: (e) => setRunError(e instanceof Error ? e.message : String(e)),
  });

  if (summaries.isLoading) {
    return (
      <Skeleton aria-label="Loading Copilot quality">
        <div className={styles.overview} style={{ marginBottom: tokens.spacingVerticalL }}>
          {[0, 1, 2, 3, 4].map((i) => <SkeletonItem key={i} style={{ height: '76px', borderRadius: tokens.borderRadiusLarge }} />)}
        </div>
        <div className={styles.cards}>
          {[0, 1, 2, 3].map((i) => <SkeletonItem key={i} style={{ height: '190px', borderRadius: tokens.borderRadiusLarge }} />)}
        </div>
      </Skeleton>
    );
  }

  if (summaries.isError) {
    return (
      <MessageBar intent="error"><MessageBarBody>
        <MessageBarTitle>Could not load Copilot quality</MessageBarTitle>
        {(summaries.error as Error)?.message}
      </MessageBarBody></MessageBar>
    );
  }

  const data = summaries.data!;

  // FLAG0 kill-switch — OFF hides the page body behind a guided notice (no roll).
  if (data.flagEnabled === false) {
    return (
      <MessageBar intent="info" layout="multiline"><MessageBarBody>
        <MessageBarTitle>Copilot quality page is turned off</MessageBarTitle>
        The <code>e5-copilot-quality-page</code> runtime flag is currently OFF. The copilot-evaluator
        Function and its nightly/per-roll runs keep going; only this admin view is hidden.
        Re-enable it under <NextLink href="/admin/runtime-flags" legacyBehavior><FluentLink>Runtime flags</FluentLink></NextLink>.
      </MessageBarBody></MessageBar>
    );
  }

  const { surfaces, overview } = data;
  const allSurfaces = surfaces.map((s) => s.surface);

  return (
    <div className={styles.root}>
      {/* Honest evaluator posture — Run-now needs the Function URL; scores still render. */}
      {!data.evaluatorConfigured && (
        <HonestGate gateId="svc-copilot-evaluator" surface="Copilot quality — Run now"
          onResolved={() => summaries.refetch()} />
      )}

      <div className={styles.toolbar}>
        <div className={styles.badges}>
          <TargetArrow24Regular />
          <Subtitle2>Per-surface Copilot quality</Subtitle2>
          {overview.lastRunAt && (
            <Caption1 className={styles.muted}>last run {new Date(overview.lastRunAt).toLocaleString()}</Caption1>
          )}
        </div>
        <div className={styles.badges}>
          <Button appearance="secondary" icon={<ArrowSync20Regular />} onClick={() => summaries.refetch()}
            disabled={summaries.isFetching}>Refresh</Button>
          <Tooltip
            content={data.evaluatorConfigured
              ? 'Fire an on-demand evaluation across every surface (the E2 HTTP trigger).'
              : 'Configure LOOM_COPILOT_EVALUATOR_URL to enable on-demand runs.'}
            relationship="label">
            <Button appearance="primary" icon={runNow.isPending ? <Spinner size="tiny" /> : <Play20Regular />}
              disabled={!data.evaluatorConfigured || runNow.isPending}
              onClick={() => runNow.mutate(allSurfaces)}>
              Run now
            </Button>
          </Tooltip>
        </div>
      </div>

      {runError && <MessageBar intent="warning"><MessageBarBody>{runError}</MessageBarBody></MessageBar>}
      {runNote && <MessageBar intent="success"><MessageBarBody>{runNote}</MessageBarBody></MessageBar>}

      {/* Overview tiles */}
      <div className={styles.overview}>
        <div className={styles.tile}><span className={styles.tileLabel}>Surfaces</span><span className={styles.tileValue}>{overview.surfaces || '—'}</span><Caption1 className={styles.muted}>{overview.runs} runs retained</Caption1></div>
        <div className={styles.tile}><span className={styles.tileLabel}>Mean hit-rate</span><span className={styles.tileValue}>{pct(overview.meanHitRate)}</span><Caption1 className={styles.muted}>retrieval @k, latest run</Caption1></div>
        <div className={styles.tile}><span className={styles.tileLabel}>Mean grounding</span><span className={styles.tileValue}>{overview.meanGrounding == null ? '—' : `${overview.meanGrounding.toFixed(2)}`}</span><Caption1 className={styles.muted}>judged surfaces / 5</Caption1></div>
        <div className={styles.tile}><span className={styles.tileLabel}>Below floor</span><span className={styles.tileValue} style={{ color: overview.belowFloor > 0 ? tokens.colorPaletteRedForeground1 : undefined }}>{overview.belowFloor}</span><Caption1 className={styles.muted}>surfaces under an E3 floor</Caption1></div>
        <div className={styles.tile}><span className={styles.tileLabel}>Floors</span><span className={styles.tileValue} style={{ fontSize: tokens.fontSizeBase300 }}>{data.floorsMeta?.lastRatchet ? `ratcheted ${new Date(data.floorsMeta.lastRatchet).toLocaleDateString()}` : 'provisional seed'}</span><Caption1 className={styles.muted}>content/evals/eval-floors.json</Caption1></div>
      </div>

      {surfaces.length === 0 ? (
        <EmptyState
          icon={<DocumentSearch24Regular />}
          title="No Copilot evaluations yet"
          body={data.evaluatorConfigured
            ? 'The copilot-evaluator Function is wired but has not written any eval-run docs yet. Click "Run now" to fire an on-demand evaluation, or wait for the nightly / per-roll run. Scores appear here once the run finishes writing to Cosmos.'
            : 'Deploy the copilot-evaluator Function (modules/admin-plane/copilot-evaluator-function.bicep, default-ON) and set LOOM_COPILOT_EVALUATOR_URL, then run the golden eval sets. Retrieval hit-rate / MRR and LLM-judge grounding will trend here per surface.'}
          primaryAction={data.evaluatorConfigured
            ? { label: 'Run now', onClick: () => runNow.mutate(allSurfaces) }
            : { label: 'Gate registry', href: '/admin/gates' }}
          secondaryAction={{ label: 'Runtime flags', href: '/admin/runtime-flags' }}
        />
      ) : (
        <div className={styles.cards}>
          {surfaces.map((s) => (
            <div key={s.surface} className={styles.card}>
              <div className={styles.cardHead}>
                <Tooltip content={s.surface} relationship="label">
                  <span className={styles.surfaceName}>{s.surface}</span>
                </Tooltip>
                <Badge appearance="filled" color={GRADE_COLOR[s.grade]} size="large">{s.grade}</Badge>
              </div>
              <div className={styles.metricRow}>
                <div className={styles.metric}><Caption1 className={styles.muted}>Hit-rate</Caption1><span className={styles.metricVal}>{pct(s.latest.totals.retrievalHitRate)}</span></div>
                <div className={styles.metric}><Caption1 className={styles.muted}>Grounding</Caption1><span className={styles.metricVal}>{grounding(s.latest.totals.groundingAvg)}</span></div>
                <div className={styles.metric}><Caption1 className={styles.muted}>Pass-rate</Caption1><span className={styles.metricVal}>{pct(s.latest.totals.passRate)}</span></div>
                <div className={styles.metric}><Caption1 className={styles.muted}>MRR</Caption1><span className={styles.metricVal}>{s.latest.totals.mrrAvg.toFixed(2)}</span></div>
              </div>
              <div className={styles.badges}>
                {s.floorStatus.map((f) => <FloorBadge key={f.metric} f={f} />)}
                {s.provisionalFloor && <Badge appearance="outline" size="small" color="informative">provisional floor</Badge>}
                {s.latest.totals.groundingAvg == null && <Badge appearance="outline" size="small">judge deferred</Badge>}
              </div>
              {s.trend.length > 1 ? (
                <LoomChart
                  type="line"
                  height={110}
                  rows={s.trend.map((p) => ({
                    Run: (p.finishedAt || '').slice(5, 10),
                    'Hit-rate': Math.round(p.retrievalHitRate * 100),
                    'Pass-rate': Math.round(p.passRate * 100),
                  }))}
                />
              ) : (
                <Caption1 className={styles.muted}>{s.latest.totals.questions} questions · one run so far — the trend appears after the next run.</Caption1>
              )}
              <div className={styles.badges}>
                <Caption1 className={styles.muted}>judge: {s.latest.judgeModel || 'none'} · {s.latest.totals.questions} Q</Caption1>
                <Button size="small" appearance="secondary" icon={<DocumentSearch24Regular />}
                  onClick={() => { setDrillSurface(s.surface); setDrillRun(null); }}>
                  Drill in
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {drillSurface && (
        <DrillDialog
          surface={drillSurface}
          run={drillRun}
          onRun={setDrillRun}
          onClose={() => setDrillSurface(null)}
        />
      )}
    </div>
  );
}

function DrillDialog({
  surface, run, onRun, onClose,
}: { surface: string; run: string | null; onRun: (r: string) => void; onClose: () => void }) {
  const styles = useStyles();
  const drill = useQuery<DrillResponse>({
    queryKey: ['copilot-quality-drill', surface, run],
    queryFn: async () => {
      const r = await clientFetch(`/api/admin/copilot-quality/${encodeURIComponent(surface)}${run ? `?run=${encodeURIComponent(run)}` : ''}`);
      const j = await r.json();
      if (!j?.ok) throw new Error(j?.error || `drill load failed (${r.status})`);
      return j as DrillResponse;
    },
  });
  const [expanded, setExpanded] = useState<string | null>(null);
  const expandedQuestion = drill.data?.worst.find((w) => w.questionId === expanded) ?? null;

  return (
    <Dialog open onOpenChange={(_, d) => { if (!d.open) onClose(); }}>
      <DialogSurface className={styles.wide}>
        <DialogBody>
          <DialogTitle>Drill in — {surface}</DialogTitle>
          <DialogContent>
            {drill.isLoading && <Spinner size="tiny" label="Loading run…" labelPosition="after" />}
            {drill.isError && <MessageBar intent="error"><MessageBarBody>{(drill.error as Error)?.message}</MessageBarBody></MessageBar>}
            {drill.data && (
              <div className={styles.root}>
                <div className={styles.badges}>
                  <Caption1 className={styles.muted}>Run</Caption1>
                  <Dropdown
                    value={drill.data.runId ?? ''}
                    selectedOptions={drill.data.runId ? [drill.data.runId] : []}
                    onOptionSelect={(_, d) => d.optionValue && onRun(d.optionValue)}
                    style={{ minWidth: '260px' }}>
                    {drill.data.history.map((h) => (
                      <Option key={h.runId} value={h.runId} text={h.runId}>
                        {new Date(h.finishedAt).toLocaleString()} · {h.trigger} · hit {Math.round(h.totals.retrievalHitRate * 100)}% · {h.totals.questions} Q
                      </Option>
                    ))}
                  </Dropdown>
                </div>

                {drill.data.worst.length === 0 ? (
                  <MessageBar intent="success"><MessageBarBody>
                    Every question in this run passed — no forbidden phrases, retrieval misses, or low-grounding answers.
                  </MessageBarBody></MessageBar>
                ) : (
                  <Table size="small" aria-label="Worst questions">
                    <TableHeader>
                      <TableRow>
                        <TableHeaderCell>Question</TableHeaderCell>
                        <TableHeaderCell>Issue</TableHeaderCell>
                        <TableHeaderCell>Grounding</TableHeaderCell>
                        <TableHeaderCell>MRR</TableHeaderCell>
                        <TableHeaderCell />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {drill.data.worst.map((w) => (
                        <TableRow key={w.questionId}
                          appearance={expanded === w.questionId ? 'neutral' : undefined}>
                          <TableCell><Text truncate wrap={false} style={{ maxWidth: '360px', display: 'block' }}>{w.question}</Text></TableCell>
                          <TableCell>
                            <Badge appearance="tint" size="small"
                              color={w.reason === 'forbidden-phrase' ? 'danger' : w.reason === 'retrieval-miss' ? 'warning' : 'informative'}>
                              {worstReasonLabel(w.reason)}
                            </Badge>
                          </TableCell>
                          <TableCell>{w.grounding == null ? '—' : `${w.grounding}/5`}</TableCell>
                          <TableCell>{w.mrr.toFixed(2)}</TableCell>
                          <TableCell>
                            <Button size="small" appearance="transparent"
                              onClick={() => setExpanded(expanded === w.questionId ? null : w.questionId)}>
                              {expanded === w.questionId ? 'Hide' : 'Evidence'}
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}

                {/* Evidence detail panel for the selected question (real chunks + judge rationale). */}
                {expandedQuestion && (
                  <div className={styles.card}>
                    <Subtitle2>{expandedQuestion.question}</Subtitle2>
                    <div className={styles.drillSection}>
                      <Caption1 className={styles.tileLabel}>Expected chunks</Caption1>
                      {expandedQuestion.expectedChunks.length
                        ? expandedQuestion.expectedChunks.map((c, i) => <code key={i} className={styles.chunk}>{c}</code>)
                        : <Caption1 className={styles.muted}>—</Caption1>}
                      <Caption1 className={styles.tileLabel} style={{ marginTop: tokens.spacingVerticalXS }}>Retrieved chunks</Caption1>
                      {expandedQuestion.retrievedChunks.length
                        ? expandedQuestion.retrievedChunks.map((c, i) => <code key={i} className={styles.chunk}>{c}</code>)
                        : <Caption1 className={styles.muted}>(none retrieved)</Caption1>}
                      {expandedQuestion.rationale && (<><Caption1 className={styles.tileLabel} style={{ marginTop: tokens.spacingVerticalXS }}>Judge rationale</Caption1><Body1>{expandedQuestion.rationale}</Body1></>)}
                      {expandedQuestion.answer && (<><Caption1 className={styles.tileLabel} style={{ marginTop: tokens.spacingVerticalXS }}>Answer graded</Caption1><Body1 className={styles.muted}>{expandedQuestion.answer}</Body1></>)}
                    </div>
                  </div>
                )}
              </div>
            )}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>Close</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
