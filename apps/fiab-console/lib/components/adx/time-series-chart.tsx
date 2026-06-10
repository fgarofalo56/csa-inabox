'use client';

/**
 * TimeSeriesChart — Fabric Real-Time Dashboard time-chart parity.
 *
 * Renders REAL ADX series (the columns/rows of a live Kusto query result) as a
 * multi-series line chart with the interactive controls the Fabric / ADX
 * Real-Time Dashboard exposes on a time-chart tile:
 *
 *   1. Legend search  — filter the legend (and the plotted lines) by name.
 *   2. Pin & overlay  — pin one or more series so they stay highlighted while
 *                       the rest dim; pinned series draw on top, full opacity.
 *   3. Multi-panel    — split each (visible) series into its own stacked panel
 *                       with an independent Y axis (the ADX "Multiple y-axes" /
 *                       small-multiples mode), vs. a single overlaid panel.
 *   4. Y-axis scaling — linear vs. logarithmic Y axis (ADX "Y axis: log").
 *   5. Zoom slider    — a dual-thumb range brush over the X (time) domain that
 *                       zooms the visible window onto a sub-range of points.
 *
 * The component is presentation-only and dependency-free (pure responsive
 * <svg>), so it works against any KqlResult shape the /run BFF returns — no
 * mock data, no charting library. It auto-detects the two ADX time-series row
 * shapes:
 *
 *   wide : [ time, valueA, valueB, … ]              (one column per series)
 *   long : [ time, seriesName, value ]              (pivoted by the name col)
 *
 * Both are produced by real Kusto: wide from `summarize … by bin(t)` projected
 * across metric columns, long from `summarize v=… by name, bin(t)`.
 */

import { useId, useMemo, useState } from 'react';
import {
  makeStyles, tokens, Input, Button, Switch, Tooltip, Caption1, Text,
} from '@fluentui/react-components';
import {
  Pin16Regular, PinOff16Regular, Search16Regular, ZoomIn16Regular,
} from '@fluentui/react-icons';
import {
  parseSeries, zoomWindow, fmtVal, fmtX,
  type SeriesPoint, type Series,
} from './time-series-model';

// Brand-leaning categorical palette (light + dark safe), aligned with the
// Monitor KqlChart so all Loom charts share one series color language.
const SERIES_COLORS = [
  '#5b8def', '#22c1a6', '#e0a83a', '#d9534f', '#9b6bdf', '#3aa0e0',
  '#e07ab5', '#7bc043', '#f0883e', '#4dc0b5', '#c678dd', '#56b6c2',
];

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: '8px', minWidth: 0 },
  toolbar: {
    display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap',
    paddingBottom: '4px',
  },
  legendBar: { display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center' },
  legendChip: {
    display: 'inline-flex', alignItems: 'center', gap: '5px', cursor: 'pointer',
    padding: '2px 6px', borderRadius: '12px', fontSize: '11px',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    userSelect: 'none',
  },
  swatch: { width: '10px', height: '10px', borderRadius: '2px', flexShrink: 0 },
  meta: { fontSize: '11px', color: tokens.colorNeutralForeground3 },
  searchInput: { maxWidth: '180px' },
  zoomRow: { display: 'flex', alignItems: 'center', gap: '8px', paddingTop: '2px' },
  zoomTrack: {
    position: 'relative', flex: 1, height: '22px',
    display: 'flex', alignItems: 'center',
  },
  empty: { color: tokens.colorNeutralForeground3, fontSize: '12px', padding: '8px 0' },
});

export interface TimeSeriesChartProps {
  columns: string[];
  rows: unknown[][];
  /** Optional Kusto column types (e.g. 'DateTime','Real') to aid axis detection. */
  columnTypes?: string[];
  /** Larger render (fullscreen tile) bumps the panel height. */
  large?: boolean;
}


interface PanelProps {
  axis: SeriesPoint[];
  series: Series[];
  start: number;
  end: number;
  logScale: boolean;
  pinned: Set<string>;
  height: number;
  showXLabels: boolean;
}

/** One plotting panel (overlaid series, or a single series in multi-panel). */
function ChartPanel({ axis, series, start, end, logScale, pinned, height, showXLabels }: PanelProps) {
  const W = 720;
  const H = height;
  const PAD_L = 52;
  const PAD_R = 14;
  const PAD_T = 10;
  const PAD_B = showXLabels ? 30 : 10;
  const win = axis.slice(start, end + 1);
  const n = win.length;

  // Y domain across the visible window + visible series.
  const vals: number[] = [];
  for (const sr of series) {
    for (let i = start; i <= end; i++) {
      const v = sr.values[i];
      if (v != null && (!logScale || v > 0)) vals.push(v);
    }
  }
  const rawLo = vals.length ? Math.min(...vals) : 0;
  const rawHi = vals.length ? Math.max(...vals) : 1;
  const anyPinned = pinned.size > 0;

  const tY = (v: number): number => {
    if (logScale) {
      const lo = Math.log10(Math.max(rawLo, 1e-9));
      const hi = Math.log10(Math.max(rawHi, lo + 1e-9));
      const lv = Math.log10(Math.max(v, 1e-9));
      return H - PAD_B - ((lv - lo) / (hi - lo || 1)) * (H - PAD_B - PAD_T);
    }
    const lo = Math.min(rawLo, 0);
    const hi = rawHi;
    return H - PAD_B - ((v - lo) / (hi - lo || 1)) * (H - PAD_B - PAD_T);
  };
  const tX = (i: number): number => PAD_L + (n <= 1 ? 0 : (i / (n - 1)) * (W - PAD_L - PAD_R));

  // Y gridline labels (3 ticks).
  const yTicks = [0, 0.5, 1].map((f) => (
    logScale
      ? Math.pow(10, Math.log10(Math.max(rawLo, 1e-9)) + f * (Math.log10(Math.max(rawHi, 1e-9)) - Math.log10(Math.max(rawLo, 1e-9))))
      : Math.min(rawLo, 0) + f * (rawHi - Math.min(rawLo, 0))
  ));

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label="time series chart"
      style={{ border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 6, background: tokens.colorNeutralBackground1 }}>
      {/* Y gridlines + labels */}
      {yTicks.map((v, i) => {
        const yy = tY(v);
        return (
          <g key={i}>
            <line x1={PAD_L} y1={yy} x2={W - PAD_R} y2={yy} stroke={tokens.colorNeutralStroke2} strokeDasharray="2 3" />
            <text x={PAD_L - 6} y={yy + 3} fontSize="9" textAnchor="end" fill={tokens.colorNeutralForeground3}>{fmtVal(v)}</text>
          </g>
        );
      })}
      {/* axes */}
      <line x1={PAD_L} y1={H - PAD_B} x2={W - PAD_R} y2={H - PAD_B} stroke={tokens.colorNeutralStroke1} />
      <line x1={PAD_L} y1={PAD_T} x2={PAD_L} y2={H - PAD_B} stroke={tokens.colorNeutralStroke1} />
      {/* series — pinned drawn last (on top) */}
      {[...series].sort((a, b) => Number(pinned.has(a.name)) - Number(pinned.has(b.name))).map((sr) => {
        const color = SERIES_COLORS[sr.colorIdx % SERIES_COLORS.length];
        const dimmed = anyPinned && !pinned.has(sr.name);
        let d = '';
        let started = false;
        for (let i = start; i <= end; i++) {
          const v = sr.values[i];
          if (v == null || (logScale && v <= 0)) { started = false; continue; }
          const px = tX(i - start);
          const py = tY(v);
          d += `${started ? 'L' : 'M'}${px.toFixed(1)},${py.toFixed(1)}`;
          started = true;
        }
        return (
          <path key={sr.name} d={d} fill="none" stroke={color}
            strokeWidth={pinned.has(sr.name) ? 2.6 : 1.6}
            opacity={dimmed ? 0.18 : 1}>
            <title>{sr.name}</title>
          </path>
        );
      })}
      {/* X labels (first / mid / last of window) */}
      {showXLabels && n > 0 && [0, Math.floor((n - 1) / 2), n - 1]
        .filter((v, i, a) => a.indexOf(v) === i)
        .map((i) => (
          <text key={i} x={tX(i)} y={H - PAD_B + 16} fontSize="9"
            textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}
            fill={tokens.colorNeutralForeground3}>
            {fmtX(win[i].label)}
          </text>
        ))}
    </svg>
  );
}

export function TimeSeriesChart({ columns, rows, columnTypes, large }: TimeSeriesChartProps) {
  const s = useStyles();
  const sliderId = useId();
  const parsed = useMemo(() => parseSeries(columns, rows, columnTypes), [columns, rows, columnTypes]);

  // ---- controls state ----
  const [search, setSearch] = useState('');
  const [pinned, setPinned] = useState<Set<string>>(new Set());
  const [multiPanel, setMultiPanel] = useState(false);
  const [logScale, setLogScale] = useState(false);
  const [zoomLo, setZoomLo] = useState(0); // 0..1000 fraction of axis
  const [zoomHi, setZoomHi] = useState(1000);

  if (!parsed) {
    return <div className={s.empty}>No time-series columns to chart. Switch to the table view.</div>;
  }
  const { axis, series } = parsed;
  const axisN = axis.length;

  // Visible series = legend-search filter applied.
  const q = search.trim().toLowerCase();
  const visible = q ? series.filter((x) => x.name.toLowerCase().includes(q)) : series;

  // Zoom window → integer index range over the axis.
  const { start, end } = zoomWindow(axisN, zoomLo, zoomHi);
  const zoomed = !(start === 0 && end === axisN - 1);

  const togglePin = (name: string) => {
    setPinned((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  };

  const panelH = large ? 280 : 200;
  const subPanelH = large ? 150 : 110;

  return (
    <div className={s.root}>
      {/* ── Toolbar: legend search, multi-panel, Y-scale ───────────────── */}
      <div className={s.toolbar}>
        <Input
          className={s.searchInput}
          size="small"
          value={search}
          onChange={(_, d) => setSearch(d.value)}
          placeholder="Search series…"
          contentBefore={<Search16Regular />}
          aria-label="Search the legend by series name"
        />
        <Tooltip content="Linear / logarithmic Y axis" relationship="label">
          <span><Switch label="Log Y" checked={logScale} onChange={(_, d) => setLogScale(!!d.checked)} /></span>
        </Tooltip>
        <Tooltip content="Split each series into its own stacked panel (multiple Y axes)" relationship="label">
          <span><Switch label="Multi-panel" checked={multiPanel} onChange={(_, d) => setMultiPanel(!!d.checked)} /></span>
        </Tooltip>
        {pinned.size > 0 && (
          <Button size="small" appearance="subtle" icon={<PinOff16Regular />} onClick={() => setPinned(new Set())}>
            Clear pins ({pinned.size})
          </Button>
        )}
        <Caption1 className={s.meta} style={{ marginLeft: 'auto' }}>
          {visible.length}/{series.length} series · {end - start + 1}/{axisN} points
        </Caption1>
      </div>

      {/* ── Legend: click swatch to pin/overlay, dims others ───────────── */}
      <div className={s.legendBar} role="group" aria-label="Series legend (click to pin)">
        {visible.length === 0 ? (
          <Caption1 className={s.meta}>No series match “{search}”.</Caption1>
        ) : visible.map((x) => {
          const color = SERIES_COLORS[x.colorIdx % SERIES_COLORS.length];
          const isPinned = pinned.has(x.name);
          return (
            <span
              key={x.name}
              className={s.legendChip}
              role="button"
              tabIndex={0}
              aria-pressed={isPinned}
              title={isPinned ? `Unpin ${x.name}` : `Pin & overlay ${x.name}`}
              onClick={() => togglePin(x.name)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); togglePin(x.name); } }}
              style={isPinned ? { borderColor: color, fontWeight: 600 } : undefined}
            >
              <span className={s.swatch} style={{ backgroundColor: color }} />
              {x.name}
              {isPinned ? <Pin16Regular /> : null}
            </span>
          );
        })}
      </div>

      {/* ── Chart body: single overlaid panel, or one panel per series ── */}
      {visible.length === 0 ? null : multiPanel ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: large ? '60vh' : 360, overflowY: 'auto' }}>
          {visible.map((x, i) => (
            <div key={x.name}>
              <Caption1 className={s.meta}>{x.name}</Caption1>
              <ChartPanel
                axis={axis}
                series={[x]}
                start={start}
                end={end}
                logScale={logScale}
                pinned={pinned}
                height={subPanelH}
                showXLabels={i === visible.length - 1}
              />
            </div>
          ))}
        </div>
      ) : (
        <ChartPanel
          axis={axis}
          series={visible}
          start={start}
          end={end}
          logScale={logScale}
          pinned={pinned}
          height={panelH}
          showXLabels
        />
      )}

      {/* ── Zoom slider: dual-thumb range brush over the X (time) domain ─ */}
      <div className={s.zoomRow}>
        <Tooltip content="Zoom the visible time window" relationship="label">
          <span style={{ display: 'inline-flex', color: tokens.colorNeutralForeground3 }}><ZoomIn16Regular /></span>
        </Tooltip>
        <Text className={s.meta} style={{ minWidth: 120 }}>{fmtX(axis[start].label)}</Text>
        <div className={s.zoomTrack}>
          {/* Two overlaid native range inputs form the dual-thumb brush. */}
          <input
            type="range" min={0} max={1000} step={1} value={zoomLo}
            aria-label="Zoom window start"
            aria-describedby={sliderId}
            onChange={(e) => setZoomLo(Math.min(Number(e.target.value), zoomHi - 1))}
            style={{ position: 'absolute', width: '100%', pointerEvents: 'auto', accentColor: tokens.colorBrandBackground }}
          />
          <input
            type="range" min={0} max={1000} step={1} value={zoomHi}
            aria-label="Zoom window end"
            onChange={(e) => setZoomHi(Math.max(Number(e.target.value), zoomLo + 1))}
            style={{ position: 'absolute', width: '100%', pointerEvents: 'auto', accentColor: tokens.colorBrandBackground }}
          />
        </div>
        <Text className={s.meta} style={{ minWidth: 120, textAlign: 'right' }}>{fmtX(axis[end].label)}</Text>
        {zoomed && (
          <Button size="small" appearance="subtle" onClick={() => { setZoomLo(0); setZoomHi(1000); }}>
            Reset zoom
          </Button>
        )}
      </div>
      <Caption1 id={sliderId} className={s.meta}>
        Drag the two handles to zoom onto a sub-range of the real ADX series.
      </Caption1>
    </div>
  );
}
