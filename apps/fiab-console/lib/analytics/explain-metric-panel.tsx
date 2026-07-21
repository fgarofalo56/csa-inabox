'use client';

/**
 * ExplainMetricPanel — the WS-2.3 AI/BI "Explain this metric" surface (Databricks
 * AI/BI dashboards parity, P1-8). Dropped onto any REAL query result (columns +
 * rows from the semantic-model DAX path or a report/warehouse SQL result), it
 * turns a chosen numeric metric into three grounded cards, all over the SAME real
 * rows the grid shows:
 *
 *   1. AI-authored visualization — an Azure OpenAI turn (POST /api/analytics/
 *      visualize) proposes the best chart kind + X/Y encoding for the metric,
 *      rendered here over the real rows. Honest 503 gate when no AOAI deployment
 *      is wired (the other two cards still work — they are pure local math).
 *   2. One-click forecast — a REAL Holt-Winters / Holt-linear projection
 *      (lib/analytics/forecast) with a confidence band that widens with the
 *      horizon. No fabricated trend line.
 *   3. Key drivers — a REAL correlation / correlation-ratio ranking
 *      (lib/analytics/key-drivers) of the other columns against the metric.
 *
 * no-vaporware.md / G1: cards 2 + 3 are pure statistics over the real rows (unit-
 * tested); card 1 is a real AOAI call validated against the real column list.
 * no-fabric-dependency.md: AAS/SQL rows in, AOAI for the encoding — never Power BI
 * / Fabric. web3-ui.md / ux-baseline.md: Fluent v9 + Loom tokens, TileGrid-style
 * card layout, EmptyState guidance, clean first-open (no red before Explain).
 */

import { useMemo, useState, useCallback, type ReactElement } from 'react';
import {
  Button, Dropdown, Option, Field, Caption1, Subtitle2, Badge, Spinner,
  MessageBar, MessageBarBody, MessageBarTitle, makeStyles, tokens,
} from '@fluentui/react-components';
import {
  SparkleFilled, DataTrending24Regular, ArrowTrendingLines20Regular,
  DataUsageRegular, LightbulbFilamentRegular,
} from '@fluentui/react-icons';
import { EmptyState } from '@/lib/components/empty-state';
import { forecastSeries, detectSeasonLength, type ForecastResult } from '@/lib/analytics/forecast';
import { rankKeyDrivers, type KeyDriverResult } from '@/lib/analytics/key-drivers';

// ── shared numeric helpers (lock-step with result-visualize) ─────────────────
function toNum(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
  return null;
}
function isNumericColumn(rows: unknown[][], idx: number): boolean {
  let seen = 0;
  for (const r of rows) {
    const v = r[idx];
    if (v == null || v === '') continue;
    if (toNum(v) == null) return false;
    seen++;
  }
  return seen > 0;
}
function fmt(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1_000_000_000) return `${(n / 1e9).toFixed(1)}B`;
  if (Math.abs(n) >= 1_000_000) return `${(n / 1e6).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1e3).toFixed(1)}K`;
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}
function labelOf(v: unknown): string {
  if (v == null) return '—';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

const ACCENT = '#5b8def';
const BAND = '#5b8def';
const DRIVER_POS = '#22c1a6';
const DRIVER_NEG = '#d9534f';

interface ChartSpec { kind: string; x: string; y: string; series?: string; title: string; rationale: string }

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: 0 },
  controls: { display: 'flex', gap: tokens.spacingHorizontalM, flexWrap: 'wrap', alignItems: 'flex-end' },
  picker: { minWidth: '180px' },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 340px), 1fr))',
    gap: tokens.spacingHorizontalM,
    minWidth: 0,
  },
  card: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground1,
    padding: tokens.spacingVerticalL,
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    minWidth: 0,
    boxShadow: tokens.shadow4,
    transitionProperty: 'box-shadow',
    transitionDuration: tokens.durationNormal,
    ':hover': { boxShadow: tokens.shadow16 },
  },
  cardHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, minWidth: 0, flexWrap: 'wrap' },
  cardIcon: {
    display: 'flex', alignItems: 'center', justifyContent: 'center', width: '28px', height: '28px',
    borderRadius: tokens.borderRadiusMedium, backgroundColor: tokens.colorBrandBackground2,
    color: tokens.colorBrandForeground2, flexShrink: 0,
  },
  cardTitle: { display: 'flex', flexDirection: 'column', minWidth: 0 },
  meta: { fontSize: tokens.fontSizeBase100, color: tokens.colorNeutralForeground3 },
  driverRow: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS, minWidth: 0 },
  driverHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, justifyContent: 'space-between', minWidth: 0 },
  driverName: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  driverTrack: { width: '100%', height: '8px', borderRadius: tokens.borderRadiusCircular, backgroundColor: tokens.colorNeutralBackground3, overflow: 'hidden' },
  driverFill: { height: '100%', borderRadius: tokens.borderRadiusCircular },
  driverList: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, minWidth: 0 },
});

// ── geometry ─────────────────────────────────────────────────────────────────
const W = 640;
const H = 240;
const PAD_L = 48;
const PAD_R = 16;
const PAD_T = 12;
const PAD_B = 32;

function GridY({ min, max, y }: { min: number; max: number; y: (v: number) => number }) {
  const span = max - min || 1;
  return (
    <>
      {[0, 0.25, 0.5, 0.75, 1].map((t) => {
        const val = min + t * span;
        const yy = y(val);
        return (
          <g key={t}>
            <line x1={PAD_L} y1={yy} x2={W - PAD_R} y2={yy} stroke={tokens.colorNeutralStroke3} strokeWidth={0.5} />
            <text x={PAD_L - 6} y={yy + 3} fontSize={10} fill={tokens.colorNeutralForeground3} textAnchor="end">{fmt(val)}</text>
          </g>
        );
      })}
    </>
  );
}

// ── AI-authored chart (renders the model's chosen encoding over real rows) ─────
function EncodedChart({ spec, columns, rows }: { spec: ChartSpec; columns: string[]; rows: unknown[][] }): ReactElement {
  const xIdx = columns.indexOf(spec.x);
  const yIdx = columns.indexOf(spec.y);
  const data = useMemo(() => rows
    .map((r) => ({ x: labelOf(r[xIdx]), xNum: toNum(r[xIdx]), y: toNum(r[yIdx]) }))
    .filter((d) => d.y != null) as { x: string; xNum: number | null; y: number }[], [rows, xIdx, yIdx]);

  if (data.length === 0) {
    return <MessageBar intent="info"><MessageBarBody>No plottable points for {spec.y}.</MessageBarBody></MessageBar>;
  }
  const kind = spec.kind;
  if (kind === 'pie') {
    const items = data.map((d) => ({ label: d.x, value: Math.abs(d.y) })).filter((d) => d.value > 0).slice(0, 10);
    const total = items.reduce((a, b) => a + b.value, 0) || 1;
    const cx = 130, cy = H / 2, r = Math.min(cy - PAD_T, 100);
    let angle = -Math.PI / 2;
    const colors = [ACCENT, '#22c1a6', '#e0a83a', '#d9534f', '#9b6bdf', '#3aa0e0', '#e07ab5', '#7bc043'];
    const slices = items.map((d, i) => {
      const frac = d.value / total; const a0 = angle; const a1 = angle + frac * 2 * Math.PI; angle = a1;
      const large = a1 - a0 > Math.PI ? 1 : 0;
      const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0), x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
      return { path: `M ${cx} ${cy} L ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1} Z`, color: colors[i % colors.length], label: d.label, pct: (frac * 100).toFixed(1) };
    });
    return (
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label={`Pie of ${spec.y}`}>
        {slices.map((sl, i) => <path key={i} d={sl.path} fill={sl.color} opacity={0.88} stroke={tokens.colorNeutralBackground1} strokeWidth={1} />)}
        {slices.map((sl, i) => (
          <g key={`l${i}`}>
            <rect x={280} y={PAD_T + i * 18} width={11} height={11} rx={2} fill={sl.color} />
            <text x={298} y={PAD_T + i * 18 + 10} fontSize={11} fill={tokens.colorNeutralForeground2}>
              {(sl.label.length > 24 ? `${sl.label.slice(0, 23)}…` : sl.label)} ({sl.pct}%)
            </text>
          </g>
        ))}
      </svg>
    );
  }

  const min = Math.min(...data.map((d) => d.y), 0);
  const max = Math.max(...data.map((d) => d.y), 0);
  const span = max - min || 1;
  const n = data.length;
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;
  const y = (v: number) => PAD_T + (1 - (v - min) / span) * plotH;

  if (kind === 'scatter') {
    const pts = data.map((d, i) => ({ x: d.xNum ?? i, y: d.y }));
    const xs = pts.map((p) => p.x); const xMin = Math.min(...xs); const xMax = Math.max(...xs); const xSpan = xMax - xMin || 1;
    const sx = (v: number) => PAD_L + ((v - xMin) / xSpan) * plotW;
    return (
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label={`Scatter of ${spec.y}`}>
        <GridY min={min} max={max} y={y} />
        {pts.map((p, i) => <circle key={i} cx={sx(p.x)} cy={y(p.y)} r={3} fill={ACCENT} opacity={0.7} />)}
      </svg>
    );
  }

  const items = data.slice(0, 200);
  const nn = items.length;
  const x = (i: number) => PAD_L + (nn <= 1 ? plotW / 2 : (i / (nn - 1)) * plotW);
  if (kind === 'bar') {
    const step = plotW / nn; const bw = Math.max(2, step * 0.7); const zeroY = y(0);
    const tickIdx = nn <= 8 ? items.map((_, i) => i) : [0, Math.floor(nn / 2), nn - 1];
    return (
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label={`Bar of ${spec.y}`}>
        <GridY min={min} max={max} y={y} />
        {items.map((d, i) => {
          const cx = PAD_L + i * step + (step - bw) / 2; const top = y(Math.max(d.y, 0)); const h = Math.abs(y(d.y) - zeroY);
          return <rect key={i} x={cx} y={top} width={bw} height={Math.max(h, 1)} rx={2} fill={ACCENT} opacity={0.85} />;
        })}
        {tickIdx.map((i) => (
          <text key={i} x={PAD_L + i * step + step / 2} y={H - PAD_B + 14} fontSize={10} fill={tokens.colorNeutralForeground3} textAnchor="middle">
            {items[i].x.length > 10 ? `${items[i].x.slice(0, 9)}…` : items[i].x}
          </text>
        ))}
      </svg>
    );
  }
  // line / area
  let dPath = '';
  items.forEach((d, i) => { dPath += dPath === '' ? `M ${x(i)} ${y(d.y)}` : ` L ${x(i)} ${y(d.y)}`; });
  const areaPath = `${dPath} L ${x(nn - 1)} ${y(min)} L ${x(0)} ${y(min)} Z`;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label={`${kind} of ${spec.y}`}>
      <GridY min={min} max={max} y={y} />
      {kind === 'area' && <path d={areaPath} fill={ACCENT} opacity={0.18} />}
      <path d={dPath} fill="none" stroke={ACCENT} strokeWidth={1.8} />
    </svg>
  );
}

// ── Forecast chart (history + projection + confidence band) ───────────────────
function ForecastChart({ history, result, xLabels }: { history: number[]; result: ForecastResult; xLabels: string[] }): ReactElement {
  const n = history.length;
  const fc = result.points;
  const total = n + fc.length;
  const allVals = [...history, ...fc.map((p) => p.y), ...fc.map((p) => p.lower), ...fc.map((p) => p.upper)];
  const min = Math.min(...allVals);
  const max = Math.max(...allVals);
  const span = max - min || 1;
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;
  const x = (i: number) => PAD_L + (total <= 1 ? plotW / 2 : (i / (total - 1)) * plotW);
  const y = (v: number) => PAD_T + (1 - (v - min) / span) * plotH;

  let histPath = '';
  history.forEach((v, i) => { histPath += histPath === '' ? `M ${x(i)} ${y(v)}` : ` L ${x(i)} ${y(v)}`; });
  // forecast line begins at the last historical point for continuity
  let fcPath = `M ${x(n - 1)} ${y(history[n - 1])}`;
  fc.forEach((p) => { fcPath += ` L ${x(p.index)} ${y(p.y)}`; });
  // band polygon (upper forward, lower back), anchored at the last history point
  let band = `M ${x(n - 1)} ${y(history[n - 1])}`;
  fc.forEach((p) => { band += ` L ${x(p.index)} ${y(p.upper)}`; });
  for (let i = fc.length - 1; i >= 0; i--) band += ` L ${x(fc[i].index)} ${y(fc[i].lower)}`;
  band += ' Z';

  const firstX = xLabels[0] ?? '0';
  const lastHistX = xLabels[n - 1] ?? String(n - 1);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label="Forecast with confidence band">
      <GridY min={min} max={max} y={y} />
      <line x1={x(n - 1)} y1={PAD_T} x2={x(n - 1)} y2={H - PAD_B} stroke={tokens.colorNeutralStroke2} strokeWidth={1} strokeDasharray="2 2" />
      <path d={band} fill={BAND} opacity={0.14} />
      <path d={histPath} fill="none" stroke={ACCENT} strokeWidth={1.8} />
      <path d={fcPath} fill="none" stroke={ACCENT} strokeWidth={1.8} strokeDasharray="5 3" />
      {fc.map((p) => <circle key={p.index} cx={x(p.index)} cy={y(p.y)} r={2.2} fill={ACCENT} />)}
      <text x={PAD_L} y={H - 8} fontSize={10} fill={tokens.colorNeutralForeground3} textAnchor="start">{firstX.length > 12 ? `${firstX.slice(0, 11)}…` : firstX}</text>
      <text x={x(n - 1)} y={H - 8} fontSize={10} fill={tokens.colorNeutralForeground3} textAnchor="middle">{lastHistX.length > 12 ? `${lastHistX.slice(0, 11)}…` : lastHistX}</text>
      <text x={W - PAD_R} y={H - 8} fontSize={10} fill={tokens.colorNeutralForeground3} textAnchor="end">+{fc.length}</text>
    </svg>
  );
}

// ── Key-driver ranked bars ─────────────────────────────────────────────────────
function DriverBars({ result, styles }: { result: KeyDriverResult; styles: ReturnType<typeof useStyles> }): ReactElement {
  if (result.drivers.length === 0) {
    return <MessageBar intent="info"><MessageBarBody>No columns show a measurable relationship to {result.metric}.</MessageBarBody></MessageBar>;
  }
  const maxImp = Math.max(...result.drivers.map((d) => d.importance), 0.0001);
  return (
    <div className={styles.driverList}>
      {result.drivers.map((d) => {
        const pct = Math.round((d.importance / maxImp) * 100);
        const color = d.kind === 'categorical' ? ACCENT : (d.direction === 'negative' ? DRIVER_NEG : DRIVER_POS);
        const strengthLabel = d.kind === 'numeric'
          ? `r = ${(d.correlation ?? 0).toFixed(2)}`
          : `η = ${d.importance.toFixed(2)}${d.topCategory ? ` · top: ${d.topCategory}` : ''}`;
        return (
          <div key={d.name} className={styles.driverRow}>
            <div className={styles.driverHead}>
              <Caption1 className={styles.driverName}><strong>{d.name}</strong></Caption1>
              <Caption1 className={styles.meta}>{strengthLabel}</Caption1>
            </div>
            <div className={styles.driverTrack}>
              <div className={styles.driverFill} style={{ width: `${pct}%`, backgroundColor: color }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Panel ──────────────────────────────────────────────────────────────────────
export interface ExplainMetricPanelProps {
  columns: string[];
  rows: unknown[][];
}

export function ExplainMetricPanel({ columns, rows }: ExplainMetricPanelProps): ReactElement {
  const s = useStyles();

  const numericIdx = useMemo(
    () => columns.map((_, i) => i).filter((i) => isNumericColumn(rows, i)),
    [columns, rows],
  );
  const defaultX = useMemo(() => {
    const firstCat = columns.findIndex((_, i) => !numericIdx.includes(i));
    return firstCat >= 0 ? firstCat : 0;
  }, [columns, numericIdx]);
  const defaultMetric = useMemo(() => numericIdx.find((i) => i !== defaultX) ?? numericIdx[0] ?? -1, [numericIdx, defaultX]);

  const [metricIdx, setMetricIdx] = useState<number>(defaultMetric);
  const [xIdx, setXIdx] = useState<number>(defaultX);
  const [explained, setExplained] = useState(false);
  const [loading, setLoading] = useState(false);
  const [aiSpec, setAiSpec] = useState<ChartSpec | null>(null);
  const [aiGate, setAiGate] = useState<string | null>(null);

  const metric = columns[metricIdx];

  const forecast = useMemo<ForecastResult | null>(() => {
    if (!explained || metricIdx < 0) return null;
    const series = rows.map((r) => toNum(r[metricIdx])).filter((v): v is number => v != null);
    if (series.length < 2) return null;
    const season = detectSeasonLength(series);
    const periods = Math.min(24, Math.max(4, Math.round(series.length / 4)));
    return forecastSeries(series, { seasonLength: season, periods, confidence: 95 });
  }, [explained, rows, metricIdx]);

  const drivers = useMemo<KeyDriverResult | null>(() => {
    if (!explained || metricIdx < 0) return null;
    return rankKeyDrivers({ columns, rows, metric });
  }, [explained, columns, rows, metric, metricIdx]);

  const xLabels = useMemo(() => rows.map((r) => labelOf(r[xIdx])), [rows, xIdx]);
  const history = useMemo(() => rows.map((r) => toNum(r[metricIdx])).filter((v): v is number => v != null), [rows, metricIdx]);

  const explain = useCallback(async () => {
    if (metricIdx < 0) return;
    setExplained(true);
    setLoading(true);
    setAiGate(null);
    setAiSpec(null);
    try {
      const res = await fetch('/api/analytics/visualize', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ columns, sampleRows: rows.slice(0, 25), metric: columns[metricIdx] }),
      });
      const j = await res.json().catch(() => ({}));
      if (res.ok && j?.ok && j.spec) setAiSpec(j.spec as ChartSpec);
      else setAiGate(typeof j?.error === 'string' ? j.error : `AI visualization unavailable (HTTP ${res.status}).`);
    } catch (e) {
      setAiGate(e instanceof Error ? e.message : 'AI visualization request failed.');
    } finally {
      setLoading(false);
    }
  }, [columns, rows, metricIdx]);

  if (!columns.length || !rows.length) {
    return (
      <EmptyState
        icon={<SparkleFilled />}
        title="Nothing to explain yet"
        body="Run a query that returns rows, then pick a metric and choose Explain to get an AI-authored chart, a forecast, and its key drivers."
      />
    );
  }
  if (numericIdx.length === 0) {
    return (
      <MessageBar intent="warning">
        <MessageBarBody>
          This result has no numeric column to explain. Add an aggregate (e.g. <code>SUM(...)</code>) or a measure, then Explain.
        </MessageBarBody>
      </MessageBar>
    );
  }

  return (
    <div className={s.root}>
      <div className={s.controls}>
        <Field label="Metric to explain" className={s.picker}>
          <Dropdown
            size="small"
            value={columns[metricIdx] ?? ''}
            selectedOptions={[String(metricIdx)]}
            aria-label="Metric column"
            onOptionSelect={(_, d) => { setMetricIdx(Number(d.optionValue)); }}
          >
            {numericIdx.map((i) => <Option key={i} value={String(i)}>{columns[i]}</Option>)}
          </Dropdown>
        </Field>
        <Field label="Over (X axis)" className={s.picker}>
          <Dropdown
            size="small"
            value={columns[xIdx] ?? ''}
            selectedOptions={[String(xIdx)]}
            aria-label="X axis column"
            onOptionSelect={(_, d) => setXIdx(Number(d.optionValue))}
          >
            {columns.map((c, i) => <Option key={i} value={String(i)}>{c}</Option>)}
          </Dropdown>
        </Field>
        <Button appearance="primary" icon={loading ? <Spinner size="tiny" /> : <SparkleFilled />} onClick={explain} disabled={loading}>
          {loading ? 'Explaining…' : 'Explain this metric'}
        </Button>
      </div>

      {!explained ? (
        <EmptyState
          icon={<LightbulbFilamentRegular />}
          title="Explain a metric with AI + statistics"
          body="Choose a metric and select Explain. Loom picks the best chart with Azure OpenAI, forecasts the metric forward with a confidence band, and ranks the columns that drive it — all over these real rows."
        />
      ) : (
        <div className={s.grid}>
          {/* AI-authored visualization */}
          <div className={s.card}>
            <div className={s.cardHead}>
              <span className={s.cardIcon} aria-hidden><SparkleFilled /></span>
              <div className={s.cardTitle}>
                <Subtitle2>AI-authored visualization</Subtitle2>
                <Caption1 className={s.meta}>{aiSpec ? aiSpec.title : `Best chart for ${metric}`}</Caption1>
              </div>
              {aiSpec && <Badge appearance="tint" color="brand">{aiSpec.kind}</Badge>}
            </div>
            {loading ? (
              <Spinner size="small" label="Asking Azure OpenAI to pick a chart…" />
            ) : aiSpec ? (
              <>
                <EncodedChart spec={aiSpec} columns={columns} rows={rows} />
                {aiSpec.rationale && <Caption1 className={s.meta}>{aiSpec.rationale}</Caption1>}
              </>
            ) : (
              <MessageBar intent="warning">
                <MessageBarBody>
                  <MessageBarTitle>AI chart unavailable</MessageBarTitle>
                  {aiGate ?? 'No Azure OpenAI deployment is wired.'} The forecast and key-driver cards below still work — they are computed locally.
                </MessageBarBody>
              </MessageBar>
            )}
          </div>

          {/* Forecast */}
          <div className={s.card}>
            <div className={s.cardHead}>
              <span className={s.cardIcon} aria-hidden><ArrowTrendingLines20Regular /></span>
              <div className={s.cardTitle}>
                <Subtitle2>Forecast</Subtitle2>
                <Caption1 className={s.meta}>
                  {forecast ? `${forecast.method === 'holt-winters' ? `Holt-Winters (season ${forecast.seasonLength})` : 'Holt linear trend'} · 95% band` : `Project ${metric} forward`}
                </Caption1>
              </div>
              {forecast && <Badge appearance="tint" color="informative">+{forecast.points.length}</Badge>}
            </div>
            {forecast ? (
              <ForecastChart history={history} result={forecast} xLabels={xLabels} />
            ) : (
              <MessageBar intent="info"><MessageBarBody>Need at least two numeric points in {metric} to forecast.</MessageBarBody></MessageBar>
            )}
          </div>

          {/* Key drivers */}
          <div className={s.card}>
            <div className={s.cardHead}>
              <span className={s.cardIcon} aria-hidden><DataUsageRegular /></span>
              <div className={s.cardTitle}>
                <Subtitle2>Key drivers</Subtitle2>
                <Caption1 className={s.meta}>What most relates to {metric}</Caption1>
              </div>
            </div>
            {drivers ? <DriverBars result={drivers} styles={s} /> : (
              <MessageBar intent="info"><MessageBarBody>Pick a numeric metric to rank its drivers.</MessageBarBody></MessageBar>
            )}
            {drivers && drivers.drivers.length > 0 && (
              <Caption1 className={s.meta}>
                Ranked by correlation (numeric) / correlation ratio η (categorical) over {drivers.rows} rows — an association ranking, not a fitted ML model.
              </Caption1>
            )}
          </div>
        </div>
      )}

      <Caption1 className={s.meta}>
        <DataTrending24Regular style={{ verticalAlign: 'text-bottom', width: 14, height: 14, marginRight: 4 }} />
        Forecast + key drivers are real statistics computed in your browser over these rows. The chart choice uses Azure OpenAI; no Power BI or Fabric.
      </Caption1>
    </div>
  );
}

export default ExplainMetricPanel;
