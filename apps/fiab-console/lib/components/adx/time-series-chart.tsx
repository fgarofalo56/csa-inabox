'use client';

/**
 * TimeSeriesChart — the RTI / Fabric Real-Time Dashboard time-series visual.
 *
 * Renders a multi-series line/area chart over the REAL ADX result grid
 * (`{ columns, columnTypes, rows }`) already returned by the live Kusto query
 * route — no backend change, no mock data (per `.claude/rules/no-vaporware.md`).
 *
 * Parity inventory built here, matching the Fabric Real-Time Dashboard
 * time-series visual controls (Build 2026 #17):
 *   - Legend search       — type to filter the (potentially hundreds of) series
 *                           by name; click a legend entry to isolate/toggle it.
 *   - Pin & overlay       — "pin" one or more series so they stay highlighted
 *                           (bold + opaque) while the rest dim, letting you
 *                           overlay a few series for comparison.
 *   - Multi-panel         — switch from "overlay" (all series in one panel) to
 *                           "split" (one small-multiple panel per visible series).
 *   - Y-axis scaling      — linear/log toggle + auto/manual min-max so spiky or
 *                           wide-dynamic-range series stay readable.
 *   - Zoom (range) slider — a brush over the X axis that clamps every panel to a
 *                           sub-window without re-querying.
 *
 * This is the Azure-native default surface for the kql-dashboard item — it works
 * with `LOOM_DEFAULT_FABRIC_WORKSPACE` UNSET because it reads ADX rows, not
 * Fabric. Theme: Fluent v9 + Loom tokens; makeStyles values are string-valued
 * to avoid the Griffel numeric quirk.
 */

import { useMemo, useState, useCallback } from 'react';
import {
  Caption1, Input, Button, Switch, Badge, Tooltip,
  makeStyles, tokens, mergeClasses,
} from '@fluentui/react-components';
import {
  Pin16Regular, Pin16Filled, Search16Regular,
  ChartMultiple16Regular, ArrowMaximize16Regular,
} from '@fluentui/react-icons';
import {
  buildTimeSeries, filterSeriesByQuery, pointsInRange, scaleY, fmtX,
  type TimeSeriesShape, type Series,
} from './time-series-model';

const SERIES_PALETTE = [
  tokens.colorBrandForeground1,
  tokens.colorPaletteGreenForeground1,
  tokens.colorPalettePurpleForeground2,
  tokens.colorPaletteMarigoldForeground1,
  tokens.colorPaletteRedForeground1,
  tokens.colorPaletteBlueForeground2,
  tokens.colorPaletteTealForeground2,
  tokens.colorPaletteBerryForeground1,
  tokens.colorPaletteLavenderForeground2,
  tokens.colorPalettePeachForeground2,
];

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: '8px', width: '100%' },
  toolbar: {
    display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px',
    padding: '6px 8px', borderRadius: '6px',
    backgroundColor: tokens.colorNeutralBackground2,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  toolGroup: { display: 'flex', alignItems: 'center', gap: '6px' },
  spacer: { flexGrow: 1 },
  searchBox: { minWidth: '160px' },
  legend: {
    display: 'flex', flexWrap: 'wrap', gap: '6px', maxHeight: '96px',
    overflowY: 'auto', padding: '4px 0',
  },
  legendItem: {
    display: 'inline-flex', alignItems: 'center', gap: '6px',
    padding: '2px 8px', borderRadius: '12px', cursor: 'pointer',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    fontSize: '12px', userSelect: 'none',
    transitionDuration: tokens.durationFaster,
    transitionProperty: 'background-color, border-color',
    ':hover': {
      backgroundColor: tokens.colorNeutralBackground1Hover,
      borderColor: tokens.colorNeutralStroke1,
    },
  },
  legendItemPinned: {
    borderColor: tokens.colorBrandStroke1,
    backgroundColor: tokens.colorBrandBackground2,
  },
  legendItemDim: { opacity: '0.4' },
  swatch: { width: '10px', height: '10px', borderRadius: '2px', flexShrink: 0 },
  panels: { display: 'flex', flexDirection: 'column', gap: '8px' },
  panelGrid: { display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '8px' },
  panel: {
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: '6px',
    backgroundColor: tokens.colorNeutralBackground1, padding: '4px',
  },
  panelTitle: { padding: '2px 6px', fontWeight: '600', fontSize: '12px' },
  rangeRow: {
    display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 8px',
    borderRadius: '6px',
    backgroundColor: tokens.colorNeutralBackground2,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  rangeLabel: {
    color: tokens.colorNeutralForeground3, whiteSpace: 'nowrap',
    fontWeight: '600',
  },
  rangePair: { display: 'flex', flexDirection: 'column', flexGrow: 1, gap: '2px' },
  range: {
    flexGrow: 1, width: '100%', height: '16px', cursor: 'pointer',
    accentColor: tokens.colorBrandBackground,
  },
  rangeReadout: {
    color: tokens.colorNeutralForeground2, minWidth: '210px',
    textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
  },
  numInput: { width: '92px' },
});

interface TimeSeriesChartProps {
  columns: string[];
  rows: unknown[][];
  columnTypes?: string[];
  /** Optional fixed render height per panel (px). */
  height?: number;
  /** When true the toolbar is compact (small tiles). Default false. */
  compact?: boolean;
}

type YScale = 'linear' | 'log';
type Layout = 'overlay' | 'split';

export function TimeSeriesChart({ columns, rows, columnTypes, height = 220, compact = false }: TimeSeriesChartProps) {
  const s = useStyles();
  const shape = useMemo<TimeSeriesShape | null>(
    () => buildTimeSeries(columns, rows, columnTypes),
    [columns, rows, columnTypes],
  );

  const [search, setSearch] = useState('');
  const [pinned, setPinned] = useState<Set<string>>(new Set());
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [layout, setLayout] = useState<Layout>('overlay');
  const [yScale, setYScale] = useState<YScale>('linear');
  const [yAuto, setYAuto] = useState(true);
  const [yMinManual, setYMinManual] = useState<string>('');
  const [yMaxManual, setYMaxManual] = useState<string>('');
  // Zoom window expressed as a 0..1 fraction of the full X range.
  const [zoom, setZoom] = useState<{ lo: number; hi: number }>({ lo: 0, hi: 1 });

  const togglePin = useCallback((key: string) => {
    setPinned((prev) => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; });
  }, []);
  const toggleHidden = useCallback((key: string) => {
    setHidden((prev) => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; });
  }, []);

  if (!shape) {
    return <Caption1>No numeric measure to plot over time. Switch to the table view.</Caption1>;
  }

  // Legend = search-filtered series. Hidden series are dimmed + excluded from
  // panels; pinned series are emphasised and (in split layout) sorted first.
  const searched = filterSeriesByQuery(shape.series, search);
  const visible = searched.filter((srx) => !hidden.has(srx.key));
  const hasPins = pinned.size > 0;

  // Resolve the X zoom window into absolute x positions.
  const xSpan = shape.xMax - shape.xMin || 1;
  const x0 = shape.xMin + zoom.lo * xSpan;
  const x1 = shape.xMin + zoom.hi * xSpan;

  // Resolve Y bounds (auto from visible+windowed data, or manual override).
  let yLo = Infinity, yHi = -Infinity;
  for (const srx of visible) {
    for (const p of pointsInRange(srx.points, x0, x1)) {
      if (p.y < yLo) yLo = p.y;
      if (p.y > yHi) yHi = p.y;
    }
  }
  if (!Number.isFinite(yLo)) { yLo = shape.yMin; yHi = shape.yMax; }
  if (!yAuto) {
    const mn = Number(yMinManual), mx = Number(yMaxManual);
    if (Number.isFinite(mn) && yMinManual !== '') yLo = mn;
    if (Number.isFinite(mx) && yMaxManual !== '') yHi = mx;
  }
  if (yScale === 'log') { yLo = Math.max(yLo, 1e-9); yHi = Math.max(yHi, yLo * 10); }

  const seriesIndex = (key: string) => shape.series.findIndex((srx) => srx.key === key);

  const renderPanel = (panelSeries: Series[], title?: string, h = height) => (
    <Panel
      seriesList={panelSeries}
      title={title}
      x0={x0}
      x1={x1}
      yLo={yLo}
      yHi={yHi}
      yScale={yScale}
      xIsTime={shape.xIsTime}
      pinned={pinned}
      hasPins={hasPins}
      colorOf={(key) => SERIES_PALETTE[Math.max(0, seriesIndex(key)) % SERIES_PALETTE.length]}
      height={h}
    />
  );

  return (
    <div className={s.root}>
      {/* Controls toolbar */}
      <div className={s.toolbar}>
        <div className={s.toolGroup}>
          <Search16Regular />
          <Input
            className={s.searchBox}
            size="small"
            value={search}
            placeholder="Search series…"
            aria-label="Search series"
            onChange={(_, d) => setSearch(d.value)}
            contentBefore={undefined}
          />
        </div>

        <div className={s.toolGroup}>
          <Tooltip content="Toggle single overlay panel vs. one panel per series" relationship="label">
            <Button
              size="small"
              appearance={layout === 'split' ? 'primary' : 'subtle'}
              icon={<ChartMultiple16Regular />}
              aria-label="Multi-panel layout"
              aria-pressed={layout === 'split'}
              onClick={() => setLayout((l) => (l === 'overlay' ? 'split' : 'overlay'))}
            >
              {layout === 'split' ? 'Multi-panel' : 'Overlay'}
            </Button>
          </Tooltip>
        </div>

        <div className={s.toolGroup}>
          <Caption1>Y axis</Caption1>
          <Tooltip content="Linear or logarithmic Y scale" relationship="label">
            <Button
              size="small"
              appearance={yScale === 'log' ? 'primary' : 'subtle'}
              aria-label="Logarithmic Y axis"
              aria-pressed={yScale === 'log'}
              onClick={() => setYScale((v) => (v === 'linear' ? 'log' : 'linear'))}
            >
              {yScale === 'log' ? 'Log' : 'Linear'}
            </Button>
          </Tooltip>
          <Switch
            checked={yAuto}
            label="Auto"
            aria-label="Auto Y scale"
            onChange={(_, d) => setYAuto(!!d.checked)}
          />
          {!yAuto && (
            <>
              <Input
                className={s.numInput}
                size="small"
                type="number"
                value={yMinManual}
                placeholder="min"
                aria-label="Y axis minimum"
                onChange={(_, d) => setYMinManual(d.value)}
              />
              <Input
                className={s.numInput}
                size="small"
                type="number"
                value={yMaxManual}
                placeholder="max"
                aria-label="Y axis maximum"
                onChange={(_, d) => setYMaxManual(d.value)}
              />
            </>
          )}
        </div>

        <div className={s.spacer} />
        <Badge appearance="outline" color="brand">{visible.length} / {shape.series.length} series</Badge>
        {hasPins && (
          <Button size="small" appearance="subtle" onClick={() => setPinned(new Set())} aria-label="Clear pins">
            Clear pins
          </Button>
        )}
      </div>

      {/* Zoom range slider over the X axis (no re-query). The two handles
          clamp the start and end of the visible window. */}
      <div className={s.rangeRow}>
        <Caption1 className={s.rangeLabel}>Zoom</Caption1>
        <div className={s.rangePair}>
          <Tooltip content="Drag to clamp the start of the visible window" relationship="label">
            <input
              className={s.range}
              type="range"
              min={0}
              max={1}
              step={0.001}
              value={zoom.lo}
              aria-label="Zoom window start"
              onChange={(e) => { const v = Number(e.target.value); setZoom((z) => ({ lo: Math.min(v, z.hi - 0.01), hi: z.hi })); }}
            />
          </Tooltip>
          <Tooltip content="Drag to clamp the end of the visible window" relationship="label">
            <input
              className={s.range}
              type="range"
              min={0}
              max={1}
              step={0.001}
              value={zoom.hi}
              aria-label="Zoom window end"
              onChange={(e) => { const v = Number(e.target.value); setZoom((z) => ({ lo: z.lo, hi: Math.max(v, z.lo + 0.01) })); }}
            />
          </Tooltip>
        </div>
        <Caption1 className={s.rangeReadout}>
          {fmtX(x0, shape.xIsTime)} → {fmtX(x1, shape.xIsTime)}
        </Caption1>
        {(zoom.lo > 0 || zoom.hi < 1) && (
          <Button size="small" appearance="subtle" icon={<ArrowMaximize16Regular />} aria-label="Reset zoom"
            onClick={() => setZoom({ lo: 0, hi: 1 })}>Reset</Button>
        )}
      </div>

      {/* Legend — searchable, clickable to show/hide, pin to overlay. */}
      <div className={s.legend} role="list" aria-label="Series legend">
        {searched.length === 0 && <Caption1>No series match “{search}”.</Caption1>}
        {searched.map((srx) => {
          const isHidden = hidden.has(srx.key);
          const isPinned = pinned.has(srx.key);
          const color = SERIES_PALETTE[Math.max(0, seriesIndex(srx.key)) % SERIES_PALETTE.length];
          return (
            <div
              key={srx.key}
              role="listitem"
              className={mergeClasses(
                s.legendItem,
                isPinned && s.legendItemPinned,
                isHidden && s.legendItemDim,
              )}
              title={`${srx.name} — ${srx.points.length} points`}
            >
              <span className={s.swatch} style={{ backgroundColor: color }} />
              <span
                role="button"
                tabIndex={0}
                aria-label={`Toggle series ${srx.name}`}
                aria-pressed={!isHidden}
                onClick={() => toggleHidden(srx.key)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleHidden(srx.key); } }}
                style={{ cursor: 'pointer' }}
              >
                {srx.name}
              </span>
              <Button
                size="small"
                appearance="transparent"
                icon={isPinned ? <Pin16Filled /> : <Pin16Regular />}
                aria-label={`${isPinned ? 'Unpin' : 'Pin'} series ${srx.name}`}
                aria-pressed={isPinned}
                onClick={() => togglePin(srx.key)}
              />
            </div>
          );
        })}
      </div>

      {/* Panels */}
      <div className={s.panels}>
        {layout === 'overlay'
          ? renderPanel(visible)
          : (
            <div className={compact ? s.panels : s.panelGrid}>
              {/* Pinned series first in split layout for quick comparison. */}
              {[...visible].sort((a, b) => Number(pinned.has(b.key)) - Number(pinned.has(a.key))).map((srx) => (
                <div key={srx.key} className={s.panel}>
                  <div className={s.panelTitle}>{srx.name}</div>
                  {renderPanel([srx], undefined, Math.max(120, Math.round(height * 0.7)))}
                </div>
              ))}
              {visible.length === 0 && <Caption1>All series hidden. Toggle one in the legend.</Caption1>}
            </div>
          )}
      </div>
    </div>
  );
}

/** A single SVG plotting panel for a set of series within the zoom + Y window. */
function Panel({
  seriesList, title, x0, x1, yLo, yHi, yScale, xIsTime, pinned, hasPins, colorOf, height,
}: {
  seriesList: Series[];
  title?: string;
  x0: number; x1: number;
  yLo: number; yHi: number;
  yScale: YScale;
  xIsTime: boolean;
  pinned: Set<string>;
  hasPins: boolean;
  colorOf: (key: string) => string;
  height: number;
}) {
  const W = 720, H = height;
  const padL = 56, padR = 12, padT = 10, padB = 28;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const xSpan = x1 - x0 || 1;
  const ySpanRaw = (yScale === 'log' ? scaleY(yHi, 'log') - scaleY(yLo, 'log') : yHi - yLo) || 1;

  const xPix = (x: number) => padL + ((x - x0) / xSpan) * plotW;
  const yPix = (y: number) => {
    const v = yScale === 'log' ? scaleY(y, 'log') : y;
    const base = yScale === 'log' ? scaleY(yLo, 'log') : yLo;
    return padT + plotH - ((v - base) / ySpanRaw) * plotH;
  };

  const gridY = [0, 0.25, 0.5, 0.75, 1].map((f) => {
    const yVal = yScale === 'log'
      ? Math.pow(10, scaleY(yLo, 'log') + f * ySpanRaw)
      : yLo + f * (yHi - yLo);
    return { f, yVal, py: padT + plotH - f * plotH };
  });
  const gridX = [0, 0.5, 1].map((f) => ({ f, xVal: x0 + f * xSpan, px: padL + f * plotW }));

  return (
    <svg
      width="100%"
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={title ? `${title} time series` : 'time series chart'}
      style={{ border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 4, background: tokens.colorNeutralBackground1 }}
    >
      {/* Y grid + labels */}
      {gridY.map((g, i) => (
        <g key={`gy${i}`}>
          <line x1={padL} y1={g.py} x2={W - padR} y2={g.py} stroke={tokens.colorNeutralStroke3} strokeDasharray="2 3" />
          <text x={padL - 6} y={g.py + 3} fontSize="9" textAnchor="end" fill={tokens.colorNeutralForeground3}>
            {g.yVal.toLocaleString(undefined, { maximumFractionDigits: 2 })}
          </text>
        </g>
      ))}
      {/* X axis labels */}
      {gridX.map((g, i) => (
        <text key={`gx${i}`} x={g.px} y={H - 8} fontSize="9" textAnchor={i === 0 ? 'start' : i === gridX.length - 1 ? 'end' : 'middle'} fill={tokens.colorNeutralForeground3}>
          {fmtX(g.xVal, xIsTime)}
        </text>
      ))}
      {/* Axes */}
      <line x1={padL} y1={padT + plotH} x2={W - padR} y2={padT + plotH} stroke={tokens.colorNeutralStroke2} />
      <line x1={padL} y1={padT} x2={padL} y2={padT + plotH} stroke={tokens.colorNeutralStroke2} />

      {/* Series polylines. Pinned series render bold + opaque; the rest dim
          when any pin is active (the "pin & overlay" affordance). */}
      {seriesList.map((srx) => {
        const pts = pointsInRange(srx.points, x0, x1);
        if (pts.length === 0) return null;
        const dimmed = hasPins && !pinned.has(srx.key);
        const isPinned = pinned.has(srx.key);
        const color = colorOf(srx.key);
        const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${xPix(p.x).toFixed(1)},${yPix(p.y).toFixed(1)}`).join(' ');
        return (
          <g key={srx.key} opacity={dimmed ? 0.18 : 1}>
            <path d={d} fill="none" stroke={color} strokeWidth={isPinned ? 2.6 : 1.4} />
            {pts.length <= 60 && pts.map((p, i) => (
              <circle key={i} cx={xPix(p.x)} cy={yPix(p.y)} r={isPinned ? 2.4 : 1.6} fill={color}>
                <title>{`${srx.name}\n${fmtX(p.x, xIsTime)}: ${p.y.toLocaleString()}`}</title>
              </circle>
            ))}
          </g>
        );
      })}
    </svg>
  );
}
