'use client';

/**
 * MetricChart — a small SVG line/area chart for a single Azure Monitor
 * metric time-series. No charting dependency; renders a responsive
 * <svg> polyline + filled area + min/max/last summary, matching the
 * lightweight look of the Azure portal metric tiles.
 */

import { useMemo } from 'react';
import { makeStyles, tokens, Text } from '@fluentui/react-components';

export interface MetricPoint {
  timeStamp: string;
  value: number | null;
}

const useStyles = makeStyles({
  card: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground1,
    padding: tokens.spacingVerticalL,
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    minWidth: 0,
  },
  head: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: tokens.spacingHorizontalS },
  title: { fontSize: '13px', fontWeight: 600, color: tokens.colorNeutralForeground1 },
  unit: { fontSize: '11px', color: tokens.colorNeutralForeground3 },
  last: { fontSize: '22px', fontWeight: 700, color: tokens.colorBrandForeground1, lineHeight: 1.1 },
  meta: { fontSize: '11px', color: tokens.colorNeutralForeground3 },
  empty: { fontSize: '12px', color: tokens.colorNeutralForeground3, paddingTop: tokens.spacingVerticalL, paddingBottom: tokens.spacingVerticalL, textAlign: 'center' },
});

const W = 260;
const H = 64;

function fmt(n: number): string {
  if (Math.abs(n) >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(2);
}

export function MetricChart({
  title,
  unit,
  points,
}: {
  title: string;
  unit?: string;
  points: MetricPoint[];
}) {
  const styles = useStyles();

  const { path, area, last, min, max } = useMemo(() => {
    const vals = points.map((p) => (typeof p.value === 'number' ? p.value : null));
    const present = vals.filter((v): v is number => v != null);
    if (present.length === 0) {
      return { path: '', area: '', last: null as number | null, min: null as number | null, max: null as number | null };
    }
    const lo = Math.min(...present);
    const hi = Math.max(...present);
    const span = hi - lo || 1;
    const n = vals.length;
    const x = (i: number) => (n <= 1 ? 0 : (i / (n - 1)) * W);
    const y = (v: number) => H - 4 - ((v - lo) / span) * (H - 8);
    let d = '';
    let lastX = 0;
    let lastY = H;
    vals.forEach((v, i) => {
      if (v == null) return;
      const px = x(i);
      const py = y(v);
      d += d === '' ? `M ${px} ${py}` : ` L ${px} ${py}`;
      lastX = px;
      lastY = py;
    });
    const areaPath = d ? `${d} L ${lastX} ${H} L 0 ${H} Z` : '';
    const lastVal = [...present].slice(-1)[0];
    return { path: d, area: areaPath, last: lastVal, min: lo, max: hi };
  }, [points]);

  return (
    <div className={styles.card}>
      <div className={styles.head}>
        <span className={styles.title}>{title}</span>
        {unit ? <span className={styles.unit}>{unit}</span> : null}
      </div>
      {last == null ? (
        <div className={styles.empty}>No data points in window</div>
      ) : (
        <>
          <span className={styles.last}>{fmt(last)}</span>
          <svg
            viewBox={`0 0 ${W} ${H}`}
            width="100%"
            height={H}
            preserveAspectRatio="none"
            role="img"
            aria-label={`${title} sparkline`}
          >
            {area ? <path d={area} fill={tokens.colorBrandBackground2} opacity={0.5} /> : null}
            {path ? (
              <path d={path} fill="none" stroke={tokens.colorBrandStroke1} strokeWidth={1.5} />
            ) : null}
          </svg>
          <Text className={styles.meta}>
            min {fmt(min!)} · max {fmt(max!)} · {points.length} pts
          </Text>
        </>
      )}
    </div>
  );
}
