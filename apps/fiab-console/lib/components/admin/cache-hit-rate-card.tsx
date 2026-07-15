'use client';

/**
 * PSR-5 / PSR-6 — result-cache hit-rate telemetry card for /admin/performance.
 *
 * Renders the LIVE per-backend cache hit/miss counters from
 * GET /api/admin/performance/cache-stats (cache-counters.ts) alongside the
 * always-on result-cache tier config (queryCacheStats) and the target hit-rate
 * KPI. Real in-process numbers, never fabricated (no-vaporware.md); Azure-native
 * only (no-fabric-dependency.md). Fluent v9 + Loom tokens, card elevation, and
 * a LearnPopover — matches the sibling perf surfaces (web3-ui.md).
 */

import { clientFetch } from '@/lib/client-fetch';
import { useCallback, useEffect, useState } from 'react';
import {
  Caption1, Badge, Button, Spinner, Text,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { DatabaseSearch20Regular, ArrowClockwise16Regular } from '@fluentui/react-icons';
import { Section } from '@/lib/components/ui/section';
import { LearnPopover } from '@/lib/components/ui/learn-popover';

interface CounterShape { hits: number; misses: number; hitRate: number }
interface CacheStats {
  kpi: { label: string; targetRate: number; description: string; learnUrl: string };
  resultCache: { enabled: boolean; distributed: boolean; redis: boolean; size: number; hits: number; misses: number; hitRate: number; ttlMs: number };
  counters: {
    byBackend: Record<string, CounterShape>;
    total: CounterShape;
  };
}

const useStyles = makeStyles({
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
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
  chips: { display: 'flex', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap', marginTop: tokens.spacingVerticalXS },
});

const BACKEND_LABEL: Record<string, string> = {
  'result-cache': 'Report / semantic',
  adx: 'ADX (KQL)',
  tabular: 'DAX / tabular',
};

function pct(rate: number): string {
  return `${Math.round((rate || 0) * 100)}%`;
}

export function CacheHitRateCard() {
  const s = useStyles();
  const [stats, setStats] = useState<CacheStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setErr(null);
    clientFetch('/api/admin/performance/cache-stats', { cache: 'no-store' }, 20_000)
      .then((r) => (r.status === 401 ? null : r.json()))
      .then((j: any) => {
        if (!j) { setErr('Sign in as a tenant admin to view cache telemetry.'); return; }
        if (j.ok) setStats(j as CacheStats);
        else setErr(j.error || 'Failed to load cache telemetry');
      })
      .catch((e) => setErr(String(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const total = stats?.counters.total;
  const target = stats?.kpi.targetRate ?? 0.6;
  const meetsTarget = (total?.hitRate ?? 0) >= target;

  return (
    <Section
      title="Result-cache hit-rate"
      actions={
        <div className={s.toolbar}>
          <LearnPopover
            title="Result-cache hit-rate (PSR-5 / PSR-6)"
            content={stats?.kpi.description ??
              'Share of report / semantic-layer / ADX queries served from the Loom result cache (in-process LRU → shared Redis → Cosmos) instead of a live backend round-trip. Target ≥ 60%.'}
            learnMoreHref={stats?.kpi.learnUrl ?? 'https://learn.microsoft.com/azure/data-explorer/query-results-cache'}
          />
          <Button size="small" appearance="subtle" icon={<ArrowClockwise16Regular />} onClick={load} disabled={loading}>
            Refresh
          </Button>
        </div>
      }
    >
      {loading && !stats ? (
        <Spinner size="small" label="Loading cache telemetry…" labelPosition="after" />
      ) : err ? (
        <Text className={s.sub}>{err}</Text>
      ) : stats ? (
        <>
          <div className={s.grid}>
            <div className={s.card}>
              <span className={s.label}>
                <span style={{ display: 'inline-flex', verticalAlign: 'middle', marginRight: tokens.spacingHorizontalXS, color: tokens.colorBrandForeground1 }}>
                  <DatabaseSearch20Regular />
                </span>
                Overall
              </span>
              <span className={s.value} style={{ color: meetsTarget ? tokens.colorPaletteGreenForeground1 : tokens.colorNeutralForeground1 }}>
                {pct(total?.hitRate ?? 0)}
              </span>
              <Caption1 className={s.sub}>
                {total?.hits ?? 0} hits · {total?.misses ?? 0} misses · target {pct(target)}
              </Caption1>
              <div className={s.chips}>
                <Badge appearance="outline" color={meetsTarget ? 'success' : 'warning'}>
                  {meetsTarget ? 'meets target' : 'below target'}
                </Badge>
              </div>
            </div>

            {stats.counters.byBackend && Object.entries(stats.counters.byBackend).map(([backend, c]) => (
              <div key={backend} className={s.card}>
                <span className={s.label}>{BACKEND_LABEL[backend] ?? backend}</span>
                <span className={s.value}>{pct(c.hitRate)}</span>
                <Caption1 className={s.sub}>{c.hits} hits · {c.misses} misses</Caption1>
              </div>
            ))}
          </div>

          <div className={s.chips}>
            <Badge appearance="tint" color={stats.resultCache.enabled ? 'success' : 'danger'}>
              {stats.resultCache.enabled ? 'Cache ON' : 'Cache disabled'}
            </Badge>
            <Badge appearance="tint" color={stats.resultCache.distributed ? 'brand' : 'informative'}>
              {stats.resultCache.distributed ? 'Cosmos tier ON' : 'Cosmos tier off'}
            </Badge>
            <Badge appearance="tint" color={stats.resultCache.redis ? 'brand' : 'informative'}>
              {stats.resultCache.redis ? 'Redis tier ON' : 'Redis tier off'}
            </Badge>
            <Badge appearance="outline">{stats.resultCache.size} entries in-process</Badge>
            <Badge appearance="outline">TTL {Math.round(stats.resultCache.ttlMs / 1000)}s</Badge>
          </div>
        </>
      ) : null}
    </Section>
  );
}

export default CacheHitRateCard;
