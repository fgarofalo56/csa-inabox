'use client';

/**
 * SearchQualityPanel — the "Search relevance" tab of /admin/copilot-quality
 * (SRCH1). Renders REAL per-domain federated-search (/catalog) relevance scores
 * from GET /api/admin/copilot-quality/search (Cosmos loom-copilot-evals
 * `search-run` docs, written by the copilot-evaluator searchRelevance mode):
 * hit-rate@k + NDCG@k + MRR per domain, floor status, run-history trend, a
 * worst-query drill-in (expected vs retrieved results), and a "Run search evals"
 * trigger.
 *
 * States mirror the answer-quality panel: skeleton, guided EmptyState naming the
 * unblocking step, HonestGate + Fix-it when the evaluator Function is unwired,
 * clean first-open. Fluent v9 + Loom tokens; badge rows wrap.
 */
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Badge, Body1, Button, Caption1, Dialog, DialogSurface, DialogTitle, DialogBody,
  DialogContent, DialogActions, MessageBar, MessageBarBody, MessageBarTitle,
  Skeleton, SkeletonItem, Spinner, Subtitle2, Table, TableBody, TableCell,
  TableHeader, TableHeaderCell, TableRow, Text, Tooltip, makeStyles, tokens,
} from '@fluentui/react-components';
import {
  ArrowSync20Regular, Play20Regular, Search24Regular, Warning20Regular,
  CheckmarkCircle20Regular, DocumentSearch24Regular,
} from '@fluentui/react-icons';
import { clientFetch } from '@/lib/client-fetch';
import { EmptyState } from '@/lib/components/empty-state';
import { HonestGate } from '@/lib/components/shared/honest-gate';
import { LoomChart } from '@/lib/components/charts/loom-chart';
import type { SearchSummary, SearchFloorStatus, QualityGrade } from '@/lib/admin/copilot-quality';

interface SearchResponse {
  ok: boolean;
  domains: SearchSummary[];
  evaluatorConfigured: boolean;
  drill?: {
    runId: string | null;
    queries: Array<{ queryId: string; query: string; hit: boolean; mrr: number; ndcg: number; matched: number; k: number; expectedResults: string[]; retrieved: string[]; backend?: string }>;
  };
}

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, minWidth: 0 },
  toolbar: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: tokens.spacingHorizontalM, flexWrap: 'wrap', minWidth: 0 },
  cards: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 320px), 1fr))', gap: tokens.spacingHorizontalL },
  card: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, minWidth: 0,
    padding: tokens.spacingVerticalL, borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`, backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4, transition: 'box-shadow 0.15s ease', ':hover': { boxShadow: tokens.shadow16 },
  },
  cardHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, justifyContent: 'space-between', minWidth: 0 },
  name: { fontWeight: tokens.fontWeightSemibold, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  metricRow: { display: 'flex', gap: tokens.spacingHorizontalL, flexWrap: 'wrap', minWidth: 0 },
  metric: { display: 'flex', flexDirection: 'column', minWidth: 0 },
  metricVal: { fontSize: tokens.fontSizeBase400, fontWeight: tokens.fontWeightSemibold, fontVariantNumeric: 'tabular-nums' },
  badges: { display: 'flex', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap', minWidth: 0, alignItems: 'center' },
  muted: { color: tokens.colorNeutralForeground3 },
  chunk: { fontFamily: tokens.fontFamilyMonospace, fontSize: tokens.fontSizeBase200, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 },
  drillSection: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, minWidth: 0 },
  wide: { maxWidth: '900px', width: '92vw' },
});

const GRADE_COLOR: Record<QualityGrade, 'success' | 'brand' | 'warning' | 'danger'> = {
  A: 'success', B: 'brand', C: 'warning', D: 'danger', F: 'danger',
};
const pct = (v: number): string => `${Math.round(v * 100)}%`;

function SearchFloorBadge({ f }: { f: SearchFloorStatus }) {
  if (f.verdict === 'no-floor' || f.verdict === 'not-judged') return null;
  const ok = f.verdict === 'ok';
  const label = f.metric === 'searchHitRate' ? 'hit-rate' : 'NDCG';
  return (
    <Badge appearance="tint" color={ok ? 'success' : 'danger'} size="small"
      icon={ok ? <CheckmarkCircle20Regular /> : <Warning20Regular />}>
      {label} {ok ? '≥ floor' : '< floor'}
    </Badge>
  );
}

export function SearchQualityPanel() {
  const styles = useStyles();
  const qc = useQueryClient();
  const [drillDomain, setDrillDomain] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [runNote, setRunNote] = useState<string | null>(null);

  const q = useQuery<SearchResponse>({
    queryKey: ['search-quality'],
    queryFn: async () => {
      const r = await clientFetch('/api/admin/copilot-quality/search');
      const j = await r.json();
      if (!j?.ok) throw new Error(j?.error || `load failed (${r.status})`);
      return j as SearchResponse;
    },
  });

  const runNow = useMutation({
    mutationFn: async (domains: string[]) => {
      setRunError(null); setRunNote(null);
      const r = await clientFetch('/api/admin/copilot-quality/run', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'search', domains }),
      });
      const j = await r.json().catch(() => null);
      if (!j?.ok) throw new Error(j?.error || j?.gate?.remediation || `run failed (${r.status})`);
      return j;
    },
    onSuccess: (j) => { setRunNote(j?.note || 'Search eval run accepted.'); setTimeout(() => qc.invalidateQueries({ queryKey: ['search-quality'] }), 4000); },
    onError: (e) => setRunError(e instanceof Error ? e.message : String(e)),
  });

  if (q.isLoading) {
    return (
      <Skeleton aria-label="Loading search relevance">
        <div className={styles.cards}>{[0, 1, 2].map((i) => <SkeletonItem key={i} style={{ height: '180px', borderRadius: tokens.borderRadiusLarge }} />)}</div>
      </Skeleton>
    );
  }
  if (q.isError) {
    return <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Could not load search relevance</MessageBarTitle>{(q.error as Error)?.message}</MessageBarBody></MessageBar>;
  }

  const data = q.data!;
  const allDomains = data.domains.map((d) => d.domain);

  return (
    <div className={styles.root}>
      {!data.evaluatorConfigured && (
        <HonestGate gateId="svc-copilot-evaluator" surface="Search relevance — Run evals" onResolved={() => q.refetch()} />
      )}
      <div className={styles.toolbar}>
        <div className={styles.badges}><Search24Regular /><Subtitle2>Federated-search relevance</Subtitle2>
          <Caption1 className={styles.muted}>hit-rate@k / NDCG over the /catalog search</Caption1>
        </div>
        <div className={styles.badges}>
          <Button appearance="secondary" icon={<ArrowSync20Regular />} onClick={() => q.refetch()} disabled={q.isFetching}>Refresh</Button>
          <Tooltip content={data.evaluatorConfigured ? 'Run the golden search queries through the real /catalog search.' : 'Configure LOOM_COPILOT_EVALUATOR_URL to enable on-demand runs.'} relationship="label">
            <Button appearance="primary" icon={runNow.isPending ? <Spinner size="tiny" /> : <Play20Regular />}
              disabled={!data.evaluatorConfigured || runNow.isPending} onClick={() => runNow.mutate(allDomains)}>
              Run search evals
            </Button>
          </Tooltip>
        </div>
      </div>

      {runError && <MessageBar intent="warning"><MessageBarBody>{runError}</MessageBarBody></MessageBar>}
      {runNote && <MessageBar intent="success"><MessageBarBody>{runNote}</MessageBarBody></MessageBar>}

      {data.domains.length === 0 ? (
        <EmptyState
          icon={<DocumentSearch24Regular />}
          title="No search relevance runs yet"
          body={data.evaluatorConfigured
            ? 'The evaluator is wired but has no search-run docs yet. Click "Run search evals" (or wait for the nightly run) to score the golden /catalog queries against real search results. Requires LOOM_EVAL_SEARCH_PRINCIPAL_OID (the demo/admin principal whose workspaces hold the golden items).'
            : 'Deploy the copilot-evaluator Function and set LOOM_COPILOT_EVALUATOR_URL + LOOM_EVAL_SEARCH_PRINCIPAL_OID, then run the golden search sets. Hit-rate@k / NDCG per domain will trend here.'}
          primaryAction={data.evaluatorConfigured ? { label: 'Run search evals', onClick: () => runNow.mutate(allDomains) } : { label: 'Gate registry', href: '/admin/gates' }}
        />
      ) : (
        <div className={styles.cards}>
          {data.domains.map((d) => (
            <div key={d.domain} className={styles.card}>
              <div className={styles.cardHead}>
                <Tooltip content={d.domain} relationship="label"><span className={styles.name}>{d.domain}</span></Tooltip>
                <Badge appearance="filled" color={GRADE_COLOR[d.grade]} size="large">{d.grade}</Badge>
              </div>
              <div className={styles.metricRow}>
                <div className={styles.metric}><Caption1 className={styles.muted}>Hit-rate@{d.latest.k}</Caption1><span className={styles.metricVal}>{pct(d.latest.totals.hitRate)}</span></div>
                <div className={styles.metric}><Caption1 className={styles.muted}>NDCG</Caption1><span className={styles.metricVal}>{d.latest.totals.ndcgAvg.toFixed(2)}</span></div>
                <div className={styles.metric}><Caption1 className={styles.muted}>MRR</Caption1><span className={styles.metricVal}>{d.latest.totals.mrrAvg.toFixed(2)}</span></div>
                <div className={styles.metric}><Caption1 className={styles.muted}>Queries</Caption1><span className={styles.metricVal}>{d.latest.totals.queries}</span></div>
              </div>
              <div className={styles.badges}>
                {d.floorStatus.map((f) => <SearchFloorBadge key={f.metric} f={f} />)}
                {d.provisionalFloor && <Badge appearance="outline" size="small" color="informative">provisional floor</Badge>}
              </div>
              {d.trend.length > 1 ? (
                <LoomChart type="line" height={110}
                  rows={d.trend.map((p) => ({ Run: (p.finishedAt || '').slice(5, 10), 'Hit-rate': Math.round(p.hitRate * 100), NDCG: Math.round(p.ndcgAvg * 100) }))} />
              ) : (
                <Caption1 className={styles.muted}>{d.latest.totals.queries} queries · one run so far.</Caption1>
              )}
              <div className={styles.badges}>
                <Button size="small" appearance="secondary" icon={<DocumentSearch24Regular />} onClick={() => setDrillDomain(d.domain)}>Drill in</Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {drillDomain && <SearchDrillDialog domain={drillDomain} onClose={() => setDrillDomain(null)} />}
    </div>
  );
}

function SearchDrillDialog({ domain, onClose }: { domain: string; onClose: () => void }) {
  const styles = useStyles();
  const drill = useQuery<SearchResponse>({
    queryKey: ['search-quality-drill', domain],
    queryFn: async () => {
      const r = await clientFetch(`/api/admin/copilot-quality/search?domain=${encodeURIComponent(domain)}`);
      const j = await r.json();
      if (!j?.ok) throw new Error(j?.error || `drill load failed (${r.status})`);
      return j as SearchResponse;
    },
  });
  const [expanded, setExpanded] = useState<string | null>(null);
  const queries = drill.data?.drill?.queries ?? [];
  const expandedQuery = queries.find((x) => x.queryId === expanded) ?? null;

  return (
    <Dialog open onOpenChange={(_, d) => { if (!d.open) onClose(); }}>
      <DialogSurface className={styles.wide}>
        <DialogBody>
          <DialogTitle>Search relevance — {domain}</DialogTitle>
          <DialogContent>
            {drill.isLoading && <Spinner size="tiny" label="Loading run…" labelPosition="after" />}
            {drill.isError && <MessageBar intent="error"><MessageBarBody>{(drill.error as Error)?.message}</MessageBarBody></MessageBar>}
            {drill.data && (
              <div className={styles.root}>
                {queries.length === 0 ? (
                  <MessageBar intent="info"><MessageBarBody>No scored queries in this run yet.</MessageBarBody></MessageBar>
                ) : (
                  <Table size="small" aria-label="Queries">
                    <TableHeader><TableRow>
                      <TableHeaderCell>Query</TableHeaderCell>
                      <TableHeaderCell>Hit</TableHeaderCell>
                      <TableHeaderCell>NDCG</TableHeaderCell>
                      <TableHeaderCell>MRR</TableHeaderCell>
                      <TableHeaderCell />
                    </TableRow></TableHeader>
                    <TableBody>
                      {queries.map((w) => (
                        <TableRow key={w.queryId} appearance={expanded === w.queryId ? 'neutral' : undefined}>
                          <TableCell><Text truncate wrap={false} style={{ maxWidth: '340px', display: 'block' }}>{w.query}</Text></TableCell>
                          <TableCell><Badge appearance="tint" size="small" color={w.hit ? 'success' : 'danger'}>{w.hit ? 'hit' : 'miss'}</Badge></TableCell>
                          <TableCell>{w.ndcg.toFixed(2)}</TableCell>
                          <TableCell>{w.mrr.toFixed(2)}</TableCell>
                          <TableCell><Button size="small" appearance="transparent" onClick={() => setExpanded(expanded === w.queryId ? null : w.queryId)}>{expanded === w.queryId ? 'Hide' : 'Results'}</Button></TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
                {expandedQuery && (
                  <div className={styles.card}>
                    <Subtitle2>{expandedQuery.query}</Subtitle2>
                    <div className={styles.drillSection}>
                      <Caption1 className={styles.muted} style={{ textTransform: 'uppercase', letterSpacing: '0.06em' }}>Expected results</Caption1>
                      {expandedQuery.expectedResults.map((c, i) => <code key={i} className={styles.chunk}>{c}</code>)}
                      <Caption1 className={styles.muted} style={{ textTransform: 'uppercase', letterSpacing: '0.06em', marginTop: tokens.spacingVerticalXS }}>Retrieved top-{expandedQuery.k}</Caption1>
                      {expandedQuery.retrieved.length ? expandedQuery.retrieved.map((c, i) => <code key={i} className={styles.chunk}>{i + 1}. {c}</code>) : <Caption1 className={styles.muted}>(no results returned)</Caption1>}
                      <Caption1 className={styles.muted}>{expandedQuery.matched} of {expandedQuery.expectedResults.length} expected matched · backend {expandedQuery.backend || '—'}</Caption1>
                    </div>
                  </div>
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
