'use client';

/**
 * WS-G / G3 — docs-Copilot retrieval telemetry card for /admin/performance.
 *
 * Renders the LIVE retrieval metrics from
 * GET /api/admin/performance/retrieval-stats (retrievalMetricsSnapshot +
 * corpusFreshness): docs-retrieval hit-rate vs target, latency p50/p95/avg/max,
 * AI-Search → Cosmos fallback rate, per-backend answered counts, and the corpus
 * freshness state (source commit vs indexed commit). Real in-process numbers,
 * never fabricated (no-vaporware.md); Azure-native only. Fluent v9 + Loom
 * tokens, card elevation, LearnPopover — matches the sibling perf surfaces
 * (web3-ui.md, ux-baseline.md).
 */

import { clientFetch } from '@/lib/client-fetch';
import { useCallback, useEffect, useState } from 'react';
import {
  Caption1, Badge, Button, Spinner, Text,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { DocumentSearch20Regular, ArrowClockwise16Regular } from '@fluentui/react-icons';
import { Section } from '@/lib/components/ui/section';
import { LearnPopover } from '@/lib/components/ui/learn-popover';

interface RetrievalMetrics {
  queries: number;
  hits: number;
  empty: number;
  hitRate: number;
  fallbacks: number;
  fallbackRate: number;
  latency: { p50: number; p95: number; avg: number; max: number; samples: number };
  byBackend: Record<string, number>;
}
interface Freshness {
  state: string;
  reason?: string;
  backend?: string;
  indexedAt?: string | null;
  indexedChunkCount?: number | null;
  sourceCommit?: string | null;
  indexedCommit?: string | null;
}
interface RetrievalStats {
  kpi: { label: string; targetRate: number; description: string; learnUrl: string };
  metrics: RetrievalMetrics;
  freshness: Freshness;
}

const useStyles = makeStyles({
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
    gap: tokens.spacingHorizontalL,
    marginBottom: tokens.spacingVerticalM,
  },
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXS,
    padding: tokens.spacingVerticalL,
    borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
    minWidth: 0,
  },
  label: {
    fontSize: tokens.fontSizeBase100,
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    color: tokens.colorNeutralForeground3,
    fontWeight: tokens.fontWeightSemibold,
  },
  value: { fontSize: tokens.fontSizeBase600, fontWeight: tokens.fontWeightBold, lineHeight: 1.1 },
  sub: { color: tokens.colorNeutralForeground3 },
  toolbar: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  chips: { display: 'flex', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap', marginTop: tokens.spacingVerticalXS, minWidth: 0 },
});

const BACKEND_LABEL: Record<string, string> = {
  'ai-search': 'AI Search',
  cosmos: 'Cosmos substring',
  'cosmos-substring': 'Cosmos substring',
  none: 'No result',
};

function pct(rate: number): string { return `${Math.round((rate || 0) * 100)}%`; }

function freshnessColor(state: string): 'success' | 'warning' | 'danger' | 'informative' {
  const st = (state || '').toLowerCase();
  if (st === 'fresh' || st === 'current') return 'success';
  if (st === 'stale') return 'warning';
  if (st === 'unconfigured' || st === 'unknown') return 'informative';
  return 'danger';
}

export function RetrievalMetricsCard() {
  const s = useStyles();
  const [stats, setStats] = useState<RetrievalStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setErr(null);
    clientFetch('/api/admin/performance/retrieval-stats', { cache: 'no-store' }, 20_000)
      .then((r) => (r.status === 401 ? null : r.json()))
      .then((j: any) => {
        if (!j) { setErr('Sign in as a tenant admin to view retrieval telemetry.'); return; }
        if (j.ok) setStats(j as RetrievalStats);
        else setErr(j.error || 'Failed to load retrieval telemetry');
      })
      .catch((e) => setErr(String(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const m = stats?.metrics;
  const target = stats?.kpi.targetRate ?? 0.7;
  const meetsTarget = (m?.hitRate ?? 0) >= target;
  const fr = stats?.freshness;

  return (
    <Section
      title="Docs-Copilot retrieval telemetry"
      actions={
        <div className={s.toolbar}>
          <LearnPopover
            title="Docs-retrieval hit-rate (WS-G / G3)"
            content={stats?.kpi.description ??
              'Share of Help Copilot doc-retrieval lookups that returned at least one grounding chunk (AI Search → Cosmos-substring fallback), tracked with retrieval latency (p50/p95) and fallback rate so the corpus + index can be tuned.'}
            learnMoreHref={stats?.kpi.learnUrl ?? 'https://learn.microsoft.com/azure/search/search-what-is-azure-search'}
          />
          <Button size="small" appearance="subtle" icon={<ArrowClockwise16Regular />} onClick={load} disabled={loading}>
            Refresh
          </Button>
        </div>
      }
    >
      {loading && !stats ? (
        <Spinner size="small" label="Loading retrieval telemetry…" labelPosition="after" />
      ) : err ? (
        <Text className={s.sub}>{err}</Text>
      ) : stats && m ? (
        <>
          <div className={s.grid}>
            <div className={s.card}>
              <span className={s.label}>
                <span style={{ display: 'inline-flex', verticalAlign: 'middle', marginRight: tokens.spacingHorizontalXS, color: tokens.colorBrandForeground1 }}>
                  <DocumentSearch20Regular />
                </span>
                Hit-rate
              </span>
              <span className={s.value} style={{ color: meetsTarget ? tokens.colorPaletteGreenForeground1 : tokens.colorNeutralForeground1 }}>
                {pct(m.hitRate)}
              </span>
              <Caption1 className={s.sub}>{m.hits} hits · {m.empty} empty · target {pct(target)}</Caption1>
              <div className={s.chips}>
                <Badge appearance="outline" color={meetsTarget ? 'success' : 'warning'}>
                  {m.queries === 0 ? 'no lookups yet' : meetsTarget ? 'meets target' : 'below target'}
                </Badge>
              </div>
            </div>

            <div className={s.card}>
              <span className={s.label}>Latency p50 / p95</span>
              <span className={s.value}>{m.latency.p50}<span className={s.sub} style={{ fontSize: tokens.fontSizeBase300 }}> / {m.latency.p95} ms</span></span>
              <Caption1 className={s.sub}>avg {m.latency.avg}ms · max {m.latency.max}ms · {m.latency.samples} samples</Caption1>
            </div>

            <div className={s.card}>
              <span className={s.label}>Fallback rate</span>
              <span className={s.value} style={{ color: m.fallbackRate > 0.25 ? tokens.colorPaletteYellowForeground1 : tokens.colorNeutralForeground1 }}>
                {pct(m.fallbackRate)}
              </span>
              <Caption1 className={s.sub}>{m.fallbacks} AI-Search→Cosmos fallbacks / {m.queries} lookups</Caption1>
            </div>

            {m.byBackend && Object.entries(m.byBackend).filter(([, n]) => n > 0).map(([backend, n]) => (
              <div key={backend} className={s.card}>
                <span className={s.label}>{BACKEND_LABEL[backend] ?? backend}</span>
                <span className={s.value}>{n}</span>
                <Caption1 className={s.sub}>answered lookups</Caption1>
              </div>
            ))}
          </div>

          {fr ? (
            <div className={s.chips}>
              <Badge appearance="tint" color={freshnessColor(fr.state)}>
                Corpus {fr.state}
              </Badge>
              {typeof fr.indexedChunkCount === 'number' && (
                <Badge appearance="outline">{fr.indexedChunkCount} indexed chunks</Badge>
              )}
              {fr.indexedAt && (
                <Badge appearance="outline">indexed {new Date(fr.indexedAt).toLocaleString()}</Badge>
              )}
              {fr.sourceCommit && (
                <Badge appearance="outline">src {String(fr.sourceCommit).slice(0, 8)}</Badge>
              )}
              {fr.indexedCommit && fr.indexedCommit !== fr.sourceCommit && (
                <Badge appearance="tint" color="warning">idx {String(fr.indexedCommit).slice(0, 8)}</Badge>
              )}
            </div>
          ) : null}
          {fr?.reason ? <Caption1 className={s.sub} style={{ marginTop: tokens.spacingVerticalXS }}>{fr.reason}</Caption1> : null}
        </>
      ) : null}
    </Section>
  );
}

export default RetrievalMetricsCard;
