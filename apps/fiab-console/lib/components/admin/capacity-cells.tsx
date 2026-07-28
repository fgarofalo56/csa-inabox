'use client';

/**
 * Capacity grid cells — the lazy, real-backend "$/mo" and "Utilization (24h)"
 * columns for /admin/capacity.
 *
 * Backends (real REST only, per no-vaporware.md):
 *   cost → /api/admin/capacity/cost?resourceId=…  (Microsoft.CostManagement)
 *   util → /api/admin/capacity/utilization        (Azure Monitor metrics)
 *
 * WHY THIS FILE EXISTS (perf): both cells used to fetch from a plain mount
 * effect, so painting an N-row inventory issued 2N Azure calls immediately,
 * queued behind deliberately small concurrency limiters (Cost Management's QPU
 * quota is 12 per 10s). On the live estate that made the page take ~44s to
 * mount and never reach `networkidle`. The cells now DEFER their request until
 * the row is actually on screen (`useInViewport`), so the inventory table
 * paints from ARM alone and the per-row Azure reads fill in progressively.
 *
 * The limiters stay as the QPU backstop — deferral reduces how many requests
 * are asked for; the limiters still bound how many are in flight.
 *
 * Every non-value state is honest and designed: a skeleton while deferred, a
 * spinner while in flight, a "No access" badge for an infra gate, an em dash
 * with the reason in a tooltip for no-data/error. Never a blank cell that reads
 * as "$0" or "idle".
 */

import * as React from 'react';
import {
  Badge, Caption1, Skeleton, SkeletonItem, Spinner, Tooltip,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { clientFetch } from '@/lib/client-fetch';
import { useInViewport } from '@/lib/components/ui/use-in-viewport';

/** One Azure resource row of the /admin/capacity inventory. */
export interface AzureRes {
  id: string;
  name: string;
  type: string;
  location: string;
  resourceGroup: string;
  sku?: string;
  kind?: string;
  provisioningState?: string;
}

export type CostResult =
  /** Deferred — the row has not been on screen yet, so nothing was requested. */
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ok'; cost: number; currency: string }
  | { status: 'gate'; message: string }
  | { status: 'error'; message: string };

export interface MetricSeries {
  metricName: string;
  label: string;
  unit: string;
  aggregation: string;
  points: { timeStamp: string; value: number | null }[];
}

export type UtilResult =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'metric'; metric: MetricSeries }
  | { status: 'none' }            // no catalog metrics, or no data in window
  | { status: 'gate'; message: string }
  | { status: 'error'; message: string };

// --- module-level caches -----------------------------------------------------
// Keyed by resourceId so scrolling back, re-filtering, or (in windowed mode)
// a row remounting never refetches. The BFF caches server-side too (15 min),
// but the client cache is what makes a scroll-back free.
export const costCache = new Map<string, CostResult>();
export const utilCache = new Map<string, UtilResult>();
/** Full metric set for the detail drawer (all metrics for one resource). */
export const detailCache = new Map<string, MetricSeries[]>();

// In-flight de-dupe: two cells asking for the same resource (a remount while
// the first request is still pending) share the ONE request.
const costInflight = new Map<string, Promise<CostResult>>();
const utilInflight = new Map<string, Promise<UtilResult>>();

/** Tiny concurrency limiter — Cost Management QPU quota is small (12/10s). */
export function makeLimiter(max: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  const pump = () => {
    if (active >= max || queue.length === 0) return;
    active += 1;
    const job = queue.shift()!;
    job();
  };
  return <T,>(fn: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      queue.push(() => {
        fn().then(resolve, reject).finally(() => { active -= 1; pump(); });
      });
      pump();
    });
}
const costLimit = makeLimiter(3);
const utilLimit = makeLimiter(5);

/** Test-only: drop every cached/in-flight entry so specs start clean. */
export function __resetCapacityCellCaches(): void {
  costCache.clear();
  utilCache.clear();
  detailCache.clear();
  costInflight.clear();
  utilInflight.clear();
}

export function fmtCurrency(n: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency || 'USD', maximumFractionDigits: 2 }).format(n);
  } catch {
    return `${currency || '$'} ${n.toFixed(2)}`;
  }
}

export function fmtNum(n: number): string {
  if (Math.abs(n) >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(1);
}

// --- loaders (cache → in-flight → network) -----------------------------------

function loadCost(resourceId: string): Promise<CostResult> {
  const cached = costCache.get(resourceId);
  if (cached && cached.status !== 'idle' && cached.status !== 'loading') return Promise.resolve(cached);
  const pending = costInflight.get(resourceId);
  if (pending) return pending;

  const p = costLimit(() =>
    clientFetch(`/api/admin/capacity/cost?resourceId=${encodeURIComponent(resourceId)}`, { cache: 'no-store' })
      .then((r) => r.json()),
  )
    .then((j: any): CostResult => {
      let result: CostResult;
      if (j?.ok) result = { status: 'ok', cost: Number(j.cost) || 0, currency: j.currency || 'USD' };
      else if (j?.gate) result = { status: 'gate', message: j.gate.message || 'No access' };
      else result = { status: 'error', message: j?.error || 'error' };
      // Only durable outcomes are cached; a transport error stays retryable.
      if (result.status !== 'error') costCache.set(resourceId, result);
      return result;
    })
    .catch((e): CostResult => ({ status: 'error', message: String(e) }))
    .finally(() => { costInflight.delete(resourceId); });

  costInflight.set(resourceId, p);
  return p;
}

function loadUtil(resourceId: string, resourceType: string): Promise<UtilResult> {
  const cached = utilCache.get(resourceId);
  if (cached && cached.status !== 'idle' && cached.status !== 'loading') return Promise.resolve(cached);
  const pending = utilInflight.get(resourceId);
  if (pending) return pending;

  const p = utilLimit(() =>
    clientFetch('/api/admin/capacity/utilization', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ resourceId, resourceType, timespan: 'P1D', interval: 'PT15M' }),
      cache: 'no-store',
    }).then((r) => r.json()),
  )
    .then((j: any): UtilResult => {
      let result: UtilResult;
      if (j?.ok && j.data?.gate === 'no_metrics_for_type') result = { status: 'none' };
      else if (j?.ok && j.data?.metric) {
        const m: MetricSeries = j.data.metric;
        const hasData = (m.points || []).some((pt) => typeof pt.value === 'number');
        result = hasData ? { status: 'metric', metric: m } : { status: 'none' };
      } else if (j?.gate) result = { status: 'gate', message: j.gate.message || 'No access' };
      else if (j?.ok) result = { status: 'none' };
      else result = { status: 'error', message: j?.error || 'error' };
      if (result.status !== 'error') utilCache.set(resourceId, result);
      return result;
    })
    .catch((e): UtilResult => ({ status: 'error', message: String(e) }))
    .finally(() => { utilInflight.delete(resourceId); });

  utilInflight.set(resourceId, p);
  return p;
}

// --- styles ------------------------------------------------------------------

const useStyles = makeStyles({
  cell: { display: 'inline-flex', alignItems: 'center', minWidth: 0, maxWidth: '100%' },
  costCell: { fontVariantNumeric: 'tabular-nums', fontWeight: tokens.fontWeightSemibold },
  spark: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, minWidth: 0 },
  sparkSvg: { flexShrink: 0 },
  sparkVal: {
    fontSize: tokens.fontSizeBase200, fontWeight: tokens.fontWeightSemibold,
    fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
  },
  dim: { color: tokens.colorNeutralForeground3 },
  // Deferred placeholders — sized like the value they stand in for so the
  // column never reflows when the real number arrives.
  skeletonCost: { width: '64px', height: '14px' },
  skeletonSpark: { width: '110px', height: '18px' },
});

// --- compact inline sparkline (cell-sized; the detail pane uses MetricChart) --

const SPARK_W = 110;
const SPARK_H = 26;

export function MiniSpark({ points }: { points: { value: number | null }[] }) {
  const styles = useStyles();
  const vals = points.map((p) => (typeof p.value === 'number' ? p.value : null));
  const present = vals.filter((v): v is number => v != null);
  if (present.length === 0) return null;
  const lo = Math.min(...present);
  const hi = Math.max(...present);
  const span = hi - lo || 1;
  const n = vals.length;
  const x = (i: number) => (n <= 1 ? 0 : (i / (n - 1)) * SPARK_W);
  const y = (v: number) => SPARK_H - 2 - ((v - lo) / span) * (SPARK_H - 4);
  let d = '';
  vals.forEach((v, i) => { if (v == null) return; const px = x(i); const py = y(v); d += d === '' ? `M ${px} ${py}` : ` L ${px} ${py}`; });
  return (
    <svg viewBox={`0 0 ${SPARK_W} ${SPARK_H}`} width={SPARK_W} height={SPARK_H} preserveAspectRatio="none" role="img" aria-label="utilization sparkline" className={styles.sparkSvg}>
      {d ? <path d={d} fill="none" stroke={tokens.colorBrandStroke1} strokeWidth={1.5} /> : null}
    </svg>
  );
}

// --- cells -------------------------------------------------------------------

export interface CostCellProps {
  resourceId: string;
  onCost: (id: string, cost: number, currency: string) => void;
  /** Bypass the visibility gate (the "Load all costs" action). */
  eager?: boolean;
}

/**
 * Month-to-date cost for one resource. Requests nothing until the row is on
 * screen (or `eager`), then renders the real Cost Management number, an honest
 * gate badge, or a reasoned em dash.
 */
export function CostCell({ resourceId, onCost, eager = false }: CostCellProps) {
  const styles = useStyles();
  const { ref, inViewport } = useInViewport<HTMLSpanElement>({ eager });
  const [state, setState] = React.useState<CostResult>(() => costCache.get(resourceId) || { status: 'idle' });

  React.useEffect(() => {
    let cancelled = false;
    const cached = costCache.get(resourceId);
    if (cached && cached.status !== 'idle') {
      setState(cached);
      if (cached.status === 'ok') onCost(resourceId, cached.cost, cached.currency);
      return;
    }
    // Deferred: nothing is requested until this row scrolls into view.
    if (!inViewport) { setState((s) => (s.status === 'idle' ? s : { status: 'idle' })); return; }
    setState({ status: 'loading' });
    loadCost(resourceId).then((result) => {
      if (cancelled) return;
      setState(result);
      if (result.status === 'ok') onCost(resourceId, result.cost, result.currency);
    });
    return () => { cancelled = true; };
  }, [resourceId, inViewport, onCost]);

  let body: React.ReactNode;
  if (state.status === 'idle') {
    body = (
      <Skeleton aria-label="Cost loads when this row scrolls into view">
        <SkeletonItem shape="rectangle" className={styles.skeletonCost} />
      </Skeleton>
    );
  } else if (state.status === 'loading') {
    body = <Spinner size="extra-tiny" aria-label="Loading cost" />;
  } else if (state.status === 'ok') {
    body = <span className={styles.costCell}>{fmtCurrency(state.cost, state.currency)}</span>;
  } else if (state.status === 'gate') {
    body = (
      <Tooltip content={state.message} relationship="description">
        <Badge appearance="outline" color="warning" size="small">No access</Badge>
      </Tooltip>
    );
  } else {
    body = (
      <Tooltip content={state.message} relationship="description">
        <Caption1 className={styles.dim}>—</Caption1>
      </Tooltip>
    );
  }

  return <span ref={ref} className={styles.cell} data-loom-cost-cell={state.status}>{body}</span>;
}

export interface UtilizationSparkCellProps {
  res: AzureRes;
  /** Bypass the visibility gate. */
  eager?: boolean;
}

/**
 * 24h utilization sparkline for one resource. Same deferral contract as
 * `CostCell` — Azure Monitor is only queried once the row is on screen.
 */
export function UtilizationSparkCell({ res, eager = false }: UtilizationSparkCellProps) {
  const styles = useStyles();
  const { ref, inViewport } = useInViewport<HTMLSpanElement>({ eager });
  const [state, setState] = React.useState<UtilResult>(() => utilCache.get(res.id) || { status: 'idle' });

  const resId = res.id;
  const resType = res.type;
  React.useEffect(() => {
    let cancelled = false;
    const cached = utilCache.get(resId);
    if (cached && cached.status !== 'idle') { setState(cached); return; }
    if (!inViewport) { setState((s) => (s.status === 'idle' ? s : { status: 'idle' })); return; }
    setState({ status: 'loading' });
    loadUtil(resId, resType).then((result) => {
      if (!cancelled) setState(result);
    });
    return () => { cancelled = true; };
  }, [resId, resType, inViewport]);

  let body: React.ReactNode;
  if (state.status === 'idle') {
    body = (
      <Skeleton aria-label="Utilization loads when this row scrolls into view">
        <SkeletonItem shape="rectangle" className={styles.skeletonSpark} />
      </Skeleton>
    );
  } else if (state.status === 'loading') {
    body = <Spinner size="extra-tiny" aria-label="Loading utilization" />;
  } else if (state.status === 'gate') {
    body = (
      <Tooltip content={state.message} relationship="description">
        <Badge appearance="outline" color="warning" size="small">No access</Badge>
      </Tooltip>
    );
  } else if (state.status === 'none' || state.status === 'error') {
    body = <Caption1 className={styles.dim}>—</Caption1>;
  } else {
    const pts = state.metric.points || [];
    const last = [...pts].reverse().find((p) => typeof p.value === 'number')?.value ?? null;
    const isPct = /%|percent/i.test(`${state.metric.label} ${state.metric.unit}`);
    body = (
      <Tooltip content={`${state.metric.label}${state.metric.unit ? ` (${state.metric.unit})` : ''} · ${state.metric.aggregation}`} relationship="description">
        <span className={styles.spark}>
          <MiniSpark points={pts} />
          {last != null ? <span className={styles.sparkVal}>{fmtNum(last)}{isPct ? '%' : ''}</span> : null}
        </span>
      </Tooltip>
    );
  }

  return <span ref={ref} className={styles.cell} data-loom-util-cell={state.status}>{body}</span>;
}
