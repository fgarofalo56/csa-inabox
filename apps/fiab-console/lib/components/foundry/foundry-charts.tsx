'use client';

/**
 * foundry-charts — lightweight, dependency-free SVG visualizations for the AI
 * Foundry surfaces (fine-tuning loss curves, evaluation pass-rate trends, and
 * the observability / Application-analytics dashboard time-series).
 *
 * WHY HAND-ROLLED SVG (no recharts / chart.js): the fiab-console bundle does
 * NOT ship a charting library, and adding one is out of scope for this surface.
 * These charts render REAL data passed in by the caller (no mocks) using inline
 * SVG + Fluent v9 design tokens so they match the Loom theme. Every series the
 * caller passes comes from a live Azure REST response — fine-tuning events
 * (trainingLoss/validationLoss per step), eval run resultCounts (passed/total),
 * or App-Insights KQL aggregations. Empty input renders an honest "no data yet"
 * note rather than a fabricated line (.claude/rules/no-vaporware.md).
 */

import { tokens } from '@fluentui/react-components';

export interface LineSeries {
  /** Legend label, e.g. "Training loss". */
  label: string;
  /** Stroke colour (defaults cycle through the Loom palette when omitted). */
  color?: string;
  /** Points in x-order. x = step / run-index / timestamp-ms; y = metric value. */
  points: { x: number; y: number }[];
}

const PALETTE = [
  tokens.colorBrandForeground1,
  tokens.colorPaletteGreenForeground1,
  tokens.colorPaletteRedForeground1,
  tokens.colorPalettePurpleForeground2,
  tokens.colorPaletteYellowForeground1,
];

function niceBounds(values: number[]): { min: number; max: number } {
  if (!values.length) return { min: 0, max: 1 };
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (min === max) {
    // Flat series — pad so the line isn't a degenerate edge.
    const pad = Math.abs(min) > 0 ? Math.abs(min) * 0.1 : 1;
    min -= pad;
    max += pad;
  }
  return { min, max };
}

/**
 * Multi-series line chart. Pure presentational SVG — no state, no fetch.
 * `xLabel`/`yLabel` are axis captions; `xIsTime` formats x-ticks as clock times.
 */
export function LineChart({
  series,
  width = 520,
  height = 220,
  xLabel,
  yLabel,
  xIsTime = false,
  yFormat,
  emptyText = 'No data points yet.',
}: {
  series: LineSeries[];
  width?: number;
  height?: number;
  xLabel?: string;
  yLabel?: string;
  xIsTime?: boolean;
  yFormat?: (v: number) => string;
  emptyText?: string;
}) {
  const all = series.flatMap((s) => s.points);
  if (!all.length) {
    return (
      <div style={{ padding: 16, color: tokens.colorNeutralForeground3, fontStyle: 'italic', fontSize: 12 }}>
        {emptyText}
      </div>
    );
  }
  const padL = 48;
  const padR = 12;
  const padT = 12;
  const padB = 28;
  const innerW = width - padL - padR;
  const innerH = height - padT - padB;

  const xs = all.map((p) => p.x);
  const ys = all.map((p) => p.y);
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const { min: yMin, max: yMax } = niceBounds(ys);

  const xScale = (x: number) => (xMax === xMin ? padL + innerW / 2 : padL + ((x - xMin) / (xMax - xMin)) * innerW);
  const yScale = (y: number) => padT + innerH - ((y - yMin) / (yMax - yMin)) * innerH;

  const fmtY = yFormat || ((v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(3)));
  const fmtX = (v: number) =>
    xIsTime ? new Date(v).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : String(Math.round(v));

  // Y grid ticks (4 divisions).
  const yTicks = [0, 1, 2, 3, 4].map((i) => yMin + ((yMax - yMin) * i) / 4);
  // X ticks (first / mid / last).
  const xTicks = xMin === xMax ? [xMin] : [xMin, (xMin + xMax) / 2, xMax];

  return (
    <div>
      <svg
        width={width}
        height={height}
        role="img"
        aria-label={`${series.map((s) => s.label).join(', ')} line chart`}
        style={{ maxWidth: '100%', border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 4, background: tokens.colorNeutralBackground1 }}
      >
        {/* Y gridlines + labels */}
        {yTicks.map((t, i) => {
          const y = yScale(t);
          return (
            <g key={`y${i}`}>
              <line x1={padL} y1={y} x2={width - padR} y2={y} stroke={tokens.colorNeutralStroke3} strokeWidth={1} />
              <text x={padL - 6} y={y + 3} textAnchor="end" fontSize={10} fill={tokens.colorNeutralForeground3}>{fmtY(t)}</text>
            </g>
          );
        })}
        {/* X ticks */}
        {xTicks.map((t, i) => {
          const x = xScale(t);
          return (
            <text key={`x${i}`} x={x} y={height - padB + 16} textAnchor="middle" fontSize={10} fill={tokens.colorNeutralForeground3}>{fmtX(t)}</text>
          );
        })}
        {/* Axes */}
        <line x1={padL} y1={padT} x2={padL} y2={padT + innerH} stroke={tokens.colorNeutralStroke1} strokeWidth={1} />
        <line x1={padL} y1={padT + innerH} x2={width - padR} y2={padT + innerH} stroke={tokens.colorNeutralStroke1} strokeWidth={1} />
        {/* Series */}
        {series.map((srs, si) => {
          const color = srs.color || PALETTE[si % PALETTE.length];
          const pts = [...srs.points].sort((a, b) => a.x - b.x);
          const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${xScale(p.x).toFixed(1)},${yScale(p.y).toFixed(1)}`).join(' ');
          return (
            <g key={si}>
              <path d={d} fill="none" stroke={color} strokeWidth={2} />
              {pts.map((p, i) => (
                <circle key={i} cx={xScale(p.x)} cy={yScale(p.y)} r={2.5} fill={color}>
                  <title>{`${srs.label}: ${fmtY(p.y)} @ ${fmtX(p.x)}`}</title>
                </circle>
              ))}
            </g>
          );
        })}
      </svg>
      {/* Legend + axis captions */}
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 6, fontSize: 11, color: tokens.colorNeutralForeground3 }}>
        {series.map((srs, si) => (
          <span key={si} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <span style={{ width: 12, height: 3, background: srs.color || PALETTE[si % PALETTE.length], display: 'inline-block', borderRadius: 2 }} />
            {srs.label}
          </span>
        ))}
        {(xLabel || yLabel) && (
          <span style={{ marginLeft: 'auto' }}>{yLabel ? `y: ${yLabel}` : ''}{yLabel && xLabel ? ' · ' : ''}{xLabel ? `x: ${xLabel}` : ''}</span>
        )}
      </div>
    </div>
  );
}

export interface Bar {
  label: string;
  value: number;
  /** Optional second stacked value (e.g. failed) rendered after `value`. */
  value2?: number;
  color?: string;
  color2?: string;
}

/**
 * Horizontal bar chart used for the eval pass-rate-per-run view (passed vs
 * failed) and for the observability per-operation latency breakdown.
 */
export function BarChart({
  bars,
  width = 520,
  height,
  valueFormat,
  emptyText = 'No bars to show yet.',
}: {
  bars: Bar[];
  width?: number;
  height?: number;
  valueFormat?: (v: number) => string;
  emptyText?: string;
}) {
  if (!bars.length) {
    return (
      <div style={{ padding: 16, color: tokens.colorNeutralForeground3, fontStyle: 'italic', fontSize: 12 }}>
        {emptyText}
      </div>
    );
  }
  const rowH = 26;
  const gap = 8;
  const labelW = 150;
  const h = height || bars.length * (rowH + gap) + gap;
  const maxV = Math.max(1, ...bars.map((b) => (b.value || 0) + (b.value2 || 0)));
  const trackW = width - labelW - 60;
  const fmt = valueFormat || ((v: number) => String(v));

  return (
    <svg
      width={width}
      height={h}
      role="img"
      aria-label="bar chart"
      style={{ maxWidth: '100%', border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 4, background: tokens.colorNeutralBackground1 }}
    >
      {bars.map((b, i) => {
        const y = gap + i * (rowH + gap);
        const w1 = ((b.value || 0) / maxV) * trackW;
        const w2 = ((b.value2 || 0) / maxV) * trackW;
        const c1 = b.color || tokens.colorPaletteGreenForeground1;
        const c2 = b.color2 || tokens.colorPaletteRedForeground1;
        return (
          <g key={i}>
            <text x={labelW - 8} y={y + rowH / 2 + 4} textAnchor="end" fontSize={11} fill={tokens.colorNeutralForeground2}>
              {b.label.length > 22 ? `${b.label.slice(0, 21)}…` : b.label}
            </text>
            <rect x={labelW} y={y} width={trackW} height={rowH} fill={tokens.colorNeutralBackground3} rx={3} />
            <rect x={labelW} y={y} width={w1} height={rowH} fill={c1} rx={3}>
              <title>{`${b.label}: ${fmt(b.value)}`}</title>
            </rect>
            {b.value2 !== undefined && (
              <rect x={labelW + w1} y={y} width={w2} height={rowH} fill={c2}>
                <title>{`${b.label}: ${fmt(b.value2)}`}</title>
              </rect>
            )}
            <text x={labelW + trackW + 8} y={y + rowH / 2 + 4} fontSize={11} fill={tokens.colorNeutralForeground3}>
              {b.value2 !== undefined ? `${fmt(b.value)} / ${fmt((b.value || 0) + (b.value2 || 0))}` : fmt(b.value)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/** A single big-number KPI tile used by the observability dashboard header. */
export function StatTile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div
      style={{
        padding: '10px 14px',
        border: `1px solid ${tokens.colorNeutralStroke2}`,
        borderRadius: tokens.borderRadiusLarge,
        minWidth: 130,
        background: tokens.colorNeutralBackground1,
        boxShadow: tokens.shadow2,
      }}
    >
      <div style={{ fontSize: 11, color: tokens.colorNeutralForeground3 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 600, color: tokens.colorNeutralForeground1 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: tokens.colorNeutralForeground3 }}>{sub}</div>}
    </div>
  );
}
