'use client';

/**
 * DataProfiling — the Power Query "Column profile" / "Column distribution"
 * surface for BOTH the Dataflow Gen2 PowerQueryHost and the report Transform
 * host (Wave 4). Renders the REAL profile-route response — one aggregate SQL per
 * column run on Synapse over the resolved/folded derived relation — as Fluent
 * mini bar charts (value distribution) plus count / distinct / null% / min / max
 * stat chips under each column header.
 *
 * It is presentation-only over a typed contract; it never fabricates data:
 *   - Controlled mode    — the host passes `columns` (+ `rowCount` / `sampled`)
 *     it already fetched, plus `loading` / `error` / `missing` for the gate.
 *   - Self-fetching mode — the host passes `onProfile`, an async fetcher hitting
 *       report   → POST /api/items/report/[id]/profile
 *       dataflow → POST /api/items/dataflow/profile
 *     and this component owns the loading / error / honest-gate lifecycle and a
 *     Refresh affordance. Either way the numbers come from a real backend.
 *
 * Rules compliance:
 *  - no-vaporware: zero mock columns / sample rows. With no data and no fetcher
 *    it shows a styled EmptyState; a backend gate (env var / unbound source)
 *    renders an honest Fluent MessageBar naming the remediation. The bars are
 *    drawn from the route's real COUNT / COUNT(DISTINCT) / GROUP BY response.
 *  - no-fabric-dependency: the profile route runs aggregate SQL on Synapse
 *    (synapse-sql-client) over the Azure-native folded relation — no Fabric /
 *    Power BI / OneLake host on any path. This file makes no network call of its
 *    own; it only invokes the host-supplied `onProfile`.
 *  - web3-ui: Fluent v9 + Loom tokens + canvas-node-kit `transform` accent
 *    (same violet the PowerQueryHost uses) + TileGrid + EmptyState + elevated
 *    cards with hover. No hard-coded px spacing / hex colors / radii — only the
 *    data-driven bar widths are inline percentages.
 *
 * ADDITIVE: importing/rendering this does not change the dataflow editor mount;
 * the host opts in by passing it (View tab / column-profile pane).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Subtitle2, Body1Strong, Body1, Caption1, Badge, Button, Spinner, Tooltip,
  MessageBar, MessageBarBody, MessageBarTitle, MessageBarActions,
  makeStyles, mergeClasses, tokens,
} from '@fluentui/react-components';
import {
  ArrowClockwise16Regular, DataHistogram20Regular, DataBarVertical20Regular,
} from '@fluentui/react-icons';
import { CATEGORY_ACCENT, accentTint, accentGradient } from '@/lib/components/canvas/canvas-node-kit';
import { TileGrid } from '@/lib/components/ui/tile-grid';
import { EmptyState } from '@/lib/components/empty-state';

// Column profiling is a data-shaping read → reuse the kit's `transform` accent
// (violet), so this surface reads as the same product as the PowerQueryHost.
const ACCENT = CATEGORY_ACCENT.transform;

// ── Contract (section 4 of the Wave-4 design; shared by the report + dataflow
//    profile routes and any host that renders this). Exported so the routes and
//    the host import ONE shape rather than re-declaring it. ───────────────────

/** One bar in a column's value-distribution histogram (real GROUP BY row). */
export interface ProfileDistributionBin {
  /** The distinct value, stringified by the backend (`''` ⇒ blank/empty). */
  value: string;
  /** COUNT(*) for this value. */
  count: number;
}

/** Real per-column profile (one aggregate SQL per column on the folded relation). */
export interface ProfileColumn {
  name: string;
  /** Source/derived data type, when the resolver knows it. */
  dataType?: string;
  /** COUNT(col) — non-null row count. */
  count: number;
  /** COUNT(DISTINCT col). */
  distinct: number;
  /** SUM(CASE WHEN col IS NULL THEN 1 ELSE 0 END). */
  nulls: number;
  /** nulls / rowCount * 100, precomputed by the route. */
  nullPct: number;
  /** MIN(col) — omitted for non-orderable types. */
  min?: string | number;
  /** MAX(col) — omitted for non-orderable types. */
  max?: string | number;
  /** TOP-12 GROUP BY <col> ORDER BY count DESC. */
  distribution: ProfileDistributionBin[];
}

/** 200 response from the profile routes. */
export interface ProfileOk {
  ok: true;
  rowCount: number;
  /** True when the route profiled a sample (TABLESAMPLE / TOP) rather than the full relation. */
  sampled: boolean;
  columns: ProfileColumn[];
}

/** 412 honest-gate / 502 backend-error response from the profile routes. */
export interface ProfileGate {
  ok: false;
  /** 'gate' | 'unbound' (412) — the not-foldable case is surfaced by native-query, not profile. */
  code?: 'gate' | 'unbound' | 'not-foldable';
  error: string;
  /** Env vars / roles / resources the backend reported missing (412 gate). */
  missing?: string[];
  /** Upstream HTTP status on a 502 backend error. */
  status?: number;
}

export type ProfileResponse = ProfileOk | ProfileGate;

export interface DataProfilingProps {
  /** Controlled mode: profiled columns to render (the route's `columns`). */
  columns?: ProfileColumn[];
  /** Controlled mode: total rows of the profiled relation (drives the share %). */
  rowCount?: number;
  /** Controlled mode: whether the profile sampled rather than scanned the full relation. */
  sampled?: boolean;
  /** Controlled loading flag (ignored once `onProfile` drives its own lifecycle). */
  loading?: boolean;
  /** Controlled error / honest-gate message. */
  error?: string | null;
  /** Honest-gate: env vars / roles / resources the backend reported missing. */
  missing?: string[];
  /** Intent for the error MessageBar — 'warning' for an honest gate, 'error' for a 502. Default 'warning'. */
  errorIntent?: 'warning' | 'error';
  /**
   * Self-fetching mode: host-supplied fetcher hitting the report
   * (POST /api/items/report/[id]/profile) or dataflow (POST /api/items/dataflow/profile)
   * route. When provided, this component fetches on mount + Refresh and owns its
   * loading / error / columns state (controlled props become the initial view).
   */
  onProfile?: () => Promise<ProfileResponse>;
  /** Auto-run the profile on mount when `onProfile` is supplied. Default true. */
  autoRun?: boolean;
}

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minHeight: 0, flex: 1 },
  toolbar: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    gap: tokens.spacingHorizontalM, flexWrap: 'wrap',
  },
  toolbarLeft: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, minWidth: 0 },
  titleIcon: {
    flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: '28px', height: '28px', borderRadius: tokens.borderRadiusMedium,
    background: accentTint(ACCENT, 14), color: ACCENT,
  },
  badges: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap' },
  // Elevated profile card per column — same chrome the PowerQueryHost panels use.
  card: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS,
    padding: tokens.spacingHorizontalM,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    boxShadow: tokens.shadow4,
    backgroundColor: tokens.colorNeutralBackground1,
    transitionProperty: 'box-shadow, border-color',
    transitionDuration: tokens.durationNormal,
    transitionTimingFunction: tokens.curveEasyEase,
    ':hover': { boxShadow: tokens.shadow8 },
    '@media (prefers-reduced-motion: reduce)': { transitionDuration: '0.01ms' },
  },
  cardHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, minWidth: 0 },
  colIcon: {
    flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: '24px', height: '24px', borderRadius: tokens.borderRadiusMedium,
    background: accentGradient(ACCENT), color: ACCENT,
    border: `1px solid ${accentTint(ACCENT, 24)}`,
  },
  colName: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  stats: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalXS },
  // A label:value stat chip (Count / Distinct / Nulls / Min / Max).
  stat: {
    display: 'inline-flex', alignItems: 'baseline', gap: tokens.spacingHorizontalXXS,
    paddingTop: tokens.spacingVerticalXXS, paddingBottom: tokens.spacingVerticalXXS,
    paddingLeft: tokens.spacingHorizontalS, paddingRight: tokens.spacingHorizontalS,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    maxWidth: '100%',
  },
  statLabel: { color: tokens.colorNeutralForeground3 },
  statValue: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '160px' },
  distLabel: { color: tokens.colorNeutralForeground3, marginTop: tokens.spacingVerticalXXS },
  dist: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS },
  // One distribution row: value | bar | count.
  bar: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  barValue: {
    flexShrink: 0, width: '116px',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    color: tokens.colorNeutralForeground2, fontSize: tokens.fontSizeBase200,
  },
  barTrack: {
    flex: 1, minWidth: 0, height: '14px',
    backgroundColor: tokens.colorNeutralBackground3,
    borderRadius: tokens.borderRadiusSmall, overflow: 'hidden',
  },
  barFill: {
    height: '100%', minWidth: '2px',
    backgroundImage: `linear-gradient(90deg, ${ACCENT}, ${accentTint(ACCENT, 55)})`,
    borderRadius: tokens.borderRadiusSmall,
    transitionProperty: 'width',
    transitionDuration: tokens.durationNormal,
    transitionTimingFunction: tokens.curveEasyEase,
    '@media (prefers-reduced-motion: reduce)': { transitionDuration: '0.01ms' },
  },
  barCount: {
    flexShrink: 0, minWidth: '92px', textAlign: 'right',
    color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200,
    fontVariantNumeric: 'tabular-nums',
  },
  blank: { fontStyle: 'italic', color: tokens.colorNeutralForeground4 },
  muted: { color: tokens.colorNeutralForeground3 },
  loadingPane: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    gap: tokens.spacingHorizontalS, minHeight: '160px',
    color: tokens.colorNeutralForeground3,
  },
  gateCode: {
    fontFamily: tokens.fontFamilyMonospace, fontSize: tokens.fontSizeBase200,
    backgroundColor: tokens.colorNeutralBackground3,
    paddingLeft: tokens.spacingHorizontalXS, paddingRight: tokens.spacingHorizontalXS,
    borderRadius: tokens.borderRadiusSmall,
  },
});

// ── pure formatters (token-free, no fabricated data) ─────────────────────────

function fmtInt(n: number | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return Math.round(n).toLocaleString();
}

/** Clamp + format a percentage to ≤1 decimal (drops a trailing .0). */
function fmtPct(n: number | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const v = Math.max(0, Math.min(100, n));
  return (Math.round(v * 10) / 10).toString();
}

/** Render a scalar (min/max/value) for display; empty string ⇒ blank marker handled by caller. */
function fmtScalar(v: string | number | undefined | null): string {
  if (v == null) return '';
  return typeof v === 'number' ? v.toLocaleString() : v;
}

/**
 * DataProfiling — see file header. Pure presentation over {@link ProfileColumn}
 * with an optional self-fetch lifecycle driven by `onProfile`.
 */
export function DataProfiling(props: DataProfilingProps) {
  const s = useStyles();
  const {
    columns, rowCount, sampled, loading, error, missing,
    errorIntent = 'warning', onProfile, autoRun = true,
  } = props;

  const selfDriven = typeof onProfile === 'function';

  // Self-fetch state (only consulted when `onProfile` is supplied).
  const [fetched, setFetched] = useState<ProfileOk | null>(null);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<ProfileGate | null>(null);
  const [ran, setRan] = useState(false);

  const run = useCallback(async () => {
    if (!onProfile) return;
    setRunning(true);
    setRunError(null);
    try {
      const res = await onProfile();
      if (res.ok) { setFetched(res); setRunError(null); }
      else { setFetched(null); setRunError(res); }
    } catch (e: any) {
      setFetched(null);
      setRunError({ ok: false, error: e?.message || String(e) });
    } finally {
      setRunning(false);
      setRan(true);
    }
  }, [onProfile]);

  useEffect(() => {
    if (selfDriven && autoRun && !ran) void run();
  }, [selfDriven, autoRun, ran, run]);

  // Resolve the view from whichever mode is active.
  const view = useMemo(() => {
    if (selfDriven) {
      return {
        loading: running || (autoRun && !ran),
        error: runError?.error ?? null,
        missing: runError?.missing,
        intent: runError && (runError.code === 'gate' || runError.code === 'unbound' || runError.code == null)
          ? ('warning' as const) : ('error' as const),
        columns: fetched?.columns ?? [],
        rowCount: fetched?.rowCount,
        sampled: fetched?.sampled,
      };
    }
    return {
      loading: !!loading,
      error: error ?? null,
      missing,
      intent: errorIntent,
      columns: columns ?? [],
      rowCount,
      sampled,
    };
  }, [
    selfDriven, running, autoRun, ran, runError, fetched,
    loading, error, missing, errorIntent, columns, rowCount, sampled,
  ]);

  const refresh = selfDriven ? (
    <Tooltip content="Re-run column profiling" relationship="label">
      <Button
        size="small" appearance="subtle" icon={<ArrowClockwise16Regular />}
        onClick={() => void run()} disabled={view.loading} aria-label="Refresh profile"
      >
        Refresh
      </Button>
    </Tooltip>
  ) : null;

  const header = (
    <div className={s.toolbar}>
      <span className={s.toolbarLeft}>
        <span className={s.titleIcon} aria-hidden="true"><DataHistogram20Regular /></span>
        <Subtitle2>Column profile</Subtitle2>
      </span>
      <span className={s.badges}>
        {view.rowCount != null && (
          <Badge appearance="tint" color="informative">{fmtInt(view.rowCount)} rows</Badge>
        )}
        {view.sampled === true && (
          <Tooltip content="Profiled a sample of rows for speed — not a full scan." relationship="label">
            <Badge appearance="tint" color="warning">Sampled</Badge>
          </Tooltip>
        )}
        {view.sampled === false && view.rowCount != null && (
          <Badge appearance="tint" color="success">Full scan</Badge>
        )}
        {refresh}
      </span>
    </div>
  );

  // ── Loading ────────────────────────────────────────────────────────────────
  if (view.loading) {
    return (
      <div className={s.root}>
        {header}
        <div className={s.loadingPane}>
          <Spinner size="tiny" /> <Caption1>Profiling columns on Synapse…</Caption1>
        </div>
      </div>
    );
  }

  // ── Honest gate / backend error ─────────────────────────────────────────────
  if (view.error) {
    return (
      <div className={s.root}>
        {header}
        <MessageBar intent={view.intent}>
          <MessageBarBody>
            <MessageBarTitle>Column profiling unavailable</MessageBarTitle>
            {view.error}
            {view.missing && view.missing.length > 0 && (
              <>
                {' '}Provision / set:{' '}
                {view.missing.map((m, i) => (
                  <span key={m}>
                    {i > 0 ? ', ' : ''}<code className={s.gateCode}>{m}</code>
                  </span>
                ))}.
              </>
            )}
          </MessageBarBody>
          {selfDriven && (
            <MessageBarActions>
              <Button size="small" appearance="subtle" icon={<ArrowClockwise16Regular />}
                onClick={() => void run()}>Retry</Button>
            </MessageBarActions>
          )}
        </MessageBar>
      </div>
    );
  }

  // ── Empty (no profiler wired / nothing profiled yet) ────────────────────────
  if (view.columns.length === 0) {
    return (
      <div className={s.root}>
        {header}
        <EmptyState
          icon={<DataBarVertical20Regular />}
          title="No profile yet"
          body={selfDriven
            ? 'Run column profiling to see real value distributions, distinct counts, and null rates for every column in this query — computed by an aggregate query over the Azure-native source.'
            : 'Bind a source and apply your Power Query steps, then profile this query to see real value distributions and column statistics.'}
          primaryAction={selfDriven ? { label: 'Run profile', appearance: 'primary', onClick: () => void run() } : undefined}
        />
      </div>
    );
  }

  // ── Profiled columns ────────────────────────────────────────────────────────
  return (
    <div className={s.root}>
      {header}
      <TileGrid minTileWidth={320}>
        {view.columns.map((col) => (
          <ColumnProfileCard key={col.name} col={col} rowCount={view.rowCount} styles={s} />
        ))}
      </TileGrid>
    </div>
  );
}

// ── Per-column card ──────────────────────────────────────────────────────────

function ColumnProfileCard({
  col, rowCount, styles: s,
}: {
  col: ProfileColumn;
  rowCount?: number;
  styles: ReturnType<typeof useStyles>;
}) {
  const dist = col.distribution ?? [];
  // Bar widths scale to the tallest bin in THIS column; the share % uses the
  // real row total when the route supplied it, else the summed distribution.
  const maxCount = dist.reduce((m, b) => Math.max(m, b.count || 0), 0) || 1;
  const distTotal = dist.reduce((sum, b) => sum + (b.count || 0), 0);
  const shareDenom = (rowCount && rowCount > 0) ? rowCount : (distTotal || 1);

  const minStr = fmtScalar(col.min);
  const maxStr = fmtScalar(col.max);
  const hasMin = col.min != null && minStr !== '';
  const hasMax = col.max != null && maxStr !== '';

  return (
    <div className={s.card}>
      <div className={s.cardHead}>
        <span className={s.colIcon} aria-hidden="true"><DataBarVertical20Regular /></span>
        <Tooltip content={col.name} relationship="label">
          <Body1Strong className={s.colName}>{col.name}</Body1Strong>
        </Tooltip>
        {col.dataType && <Badge appearance="outline" color="brand">{col.dataType}</Badge>}
      </div>

      {/* Real column statistics */}
      <div className={s.stats}>
        <Stat label="Count" value={fmtInt(col.count)} s={s} />
        <Stat label="Distinct" value={fmtInt(col.distinct)} s={s} />
        <Stat label="Nulls" value={`${fmtInt(col.nulls)} (${fmtPct(col.nullPct)}%)`} s={s} />
        {hasMin && <Stat label="Min" value={minStr} s={s} title={minStr} />}
        {hasMax && <Stat label="Max" value={maxStr} s={s} title={maxStr} />}
      </div>

      {/* Value distribution (real TOP-N GROUP BY) */}
      <Caption1 className={s.distLabel}>Value distribution (top {dist.length})</Caption1>
      {dist.length === 0 ? (
        <Caption1 className={s.muted}>No distribution available for this column.</Caption1>
      ) : (
        <div className={s.dist}>
          {dist.map((b, i) => {
            const widthPct = Math.max(2, Math.round((b.count / maxCount) * 100));
            const sharePct = fmtPct((b.count / shareDenom) * 100);
            const blank = b.value === '' || b.value == null;
            const label = blank ? '(blank)' : b.value;
            return (
              <div className={s.bar} key={`${b.value}-${i}`}>
                <Tooltip content={label} relationship="label">
                  <span className={mergeClasses(s.barValue, blank && s.blank)}>{label}</span>
                </Tooltip>
                <span className={s.barTrack} aria-hidden="true">
                  <span className={s.barFill} style={{ width: `${widthPct}%` }} />
                </span>
                <span className={s.barCount} aria-label={`${fmtInt(b.count)} rows, ${sharePct} percent`}>
                  {fmtInt(b.count)} · {sharePct}%
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Stat({
  label, value, s, title,
}: {
  label: string;
  value: string;
  s: ReturnType<typeof useStyles>;
  title?: string;
}) {
  return (
    <span className={s.stat}>
      <Caption1 className={s.statLabel}>{label}</Caption1>
      <Body1 className={s.statValue} title={title ?? value}>{value}</Body1>
    </span>
  );
}

export default DataProfiling;
