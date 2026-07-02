'use client';

/**
 * ReportCanvas — renders a parsed CoE {@link ReportModel} as a faithful,
 * scaled page of visuals using lightweight inline SVG (no charting dependency).
 *
 * Parity intent (ui-parity.md): the report lays out exactly like the source
 * Power BI page — each visual sits at its real x/y/w/h on a canvas scaled to the
 * page's design size (1280×720), with the Loom/Fluent v9 theme applied. Cards
 * show the big aggregate; clustered/column charts render as bars; line/area as a
 * polyline; donut/pie as arcs; tableEx/matrix as a dense table. Unknown visual
 * types degrade to an honest "preview not supported yet" tile (never a crash).
 *
 * In live mode the data is REAL — resolved from the deployment's Azure estate,
 * with each visual labelled by its true provenance (live / empty / honest gate);
 * unbound or empty entities render with no rows, never fabricated sample rows.
 * In the admin template-preview (sample) mode the bundled TMDL preview rows are
 * shown behind a clearly-labelled MessageBar.
 */

import * as React from 'react';
import {
  TabList, Tab, Text, Caption1, MessageBar, MessageBarBody, Tooltip,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  DataPie24Regular, PuzzlePiece24Regular,
  CloudCheckmark16Regular, Database16Regular, Warning16Regular,
} from '@fluentui/react-icons';
import type { Page, ReportModel, Visual } from './pbir-parse';
import type { SampleData } from './tmdl-sample';
import type { EntityProvenance } from './use-report';
import {
  buildVisualData, formatValue,
  type BarsData, type LineData, type PieData, type TableData, type CardData,
} from './visual-data';

/** The primary entity a visual projects (first field across its roles). */
function primaryEntity(visual: Visual): string | null {
  for (const role of Object.keys(visual.roles)) {
    const f = visual.roles[role]?.[0];
    if (f?.entity) return f.entity;
  }
  return null;
}

const PALETTE = [
  '#6E56CF', '#0F6CBD', '#107C10', '#CA5010',
  '#038387', '#8764B8', '#C50F1F', '#5C2E91',
  '#B146C2', '#00838F', '#498205', '#005B70',
];

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  tabs: { marginBottom: tokens.spacingVerticalXS },
  canvasWrap: {
    width: '100%',
    backgroundColor: tokens.colorNeutralBackground2,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    padding: tokens.spacingHorizontalM,
    overflow: 'hidden',
  },
  canvas: {
    position: 'relative',
    width: '100%',
    // aspect ratio is set inline from the page design size
  },
  tile: {
    position: 'absolute',
    display: 'flex',
    flexDirection: 'column',
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    boxShadow: tokens.shadow2,
    overflow: 'hidden',
  },
  tileHead: {
    padding: `6px ${tokens.spacingHorizontalS}`,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    color: tokens.colorNeutralForeground1,
    fontWeight: tokens.fontWeightSemibold,
    fontSize: tokens.fontSizeBase200,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXS,
  },
  tileHeadTitle: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0 },
  provDot: { display: 'inline-flex', flexShrink: 0, lineHeight: 1, cursor: 'default' },
  provLive: { color: tokens.colorPaletteGreenForeground1 },
  provSample: { color: tokens.colorNeutralForeground3 },
  provError: { color: tokens.colorPaletteRedForeground1 },
  tileBody: { position: 'relative', flex: 1, minHeight: 0, overflow: 'hidden' },
  cardBody: {
    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    height: '100%', gap: '2px', padding: tokens.spacingHorizontalS, textAlign: 'center',
  },
  cardValue: {
    fontFamily: 'var(--loom-font-display)', fontWeight: tokens.fontWeightBold,
    fontSize: 'clamp(20px, 3.2vw, 40px)', lineHeight: 1, color: tokens.colorBrandForeground1,
  },
  cardLabel: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
  svg: { display: 'block', width: '100%', height: '100%', color: tokens.colorNeutralForeground2 },
  tableScroll: { height: '100%', overflow: 'auto' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: tokens.fontSizeBase200 },
  th: {
    position: 'sticky', top: 0, textAlign: 'left', padding: '4px 8px',
    backgroundColor: tokens.colorNeutralBackground3, color: tokens.colorNeutralForeground2,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`, whiteSpace: 'nowrap',
  },
  td: {
    padding: '3px 8px', borderBottom: `1px solid ${tokens.colorNeutralStroke3}`,
    color: tokens.colorNeutralForeground1, whiteSpace: 'nowrap',
  },
  unsupported: {
    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    height: '100%', gap: tokens.spacingVerticalXS, color: tokens.colorNeutralForeground3,
    textAlign: 'center', padding: tokens.spacingHorizontalS,
  },
  empty: {
    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    gap: tokens.spacingVerticalS, padding: tokens.spacingVerticalXXL, color: tokens.colorNeutralForeground3,
    textAlign: 'center',
  },
});

/** Measure an element's pixel size (ResizeObserver) so SVG can draw at 1:1. */
function useElementSize<T extends HTMLElement>(): [React.RefObject<T | null>, { width: number; height: number }] {
  const ref = React.useRef<T>(null);
  const [size, setSize] = React.useState({ width: 0, height: 0 });
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r) setSize({ width: Math.round(r.width), height: Math.round(r.height) });
    });
    ro.observe(el);
    setSize({ width: el.clientWidth, height: el.clientHeight });
    return () => ro.disconnect();
  }, []);
  return [ref, size];
}

function CardTile({ data }: { data: CardData }) {
  const s = useStyles();
  return (
    <div className={s.cardBody}>
      <span className={s.cardValue}>{data.value}</span>
      <span className={s.cardLabel}>{data.label}</span>
    </div>
  );
}

function BarsTile({ data }: { data: BarsData }) {
  const s = useStyles();
  const [ref, { width, height }] = useElementSize<HTMLDivElement>();
  const grid = tokens.colorNeutralStroke2;
  const horizontal = data.orientation === 'horizontal';
  const cats = data.categories;
  const max = Math.max(1, ...cats.map((c) => c.value));
  const padL = horizontal ? 96 : 36;
  const padR = 10;
  const padT = 16;
  const padB = horizontal ? 8 : 34;
  const cw = Math.max(0, width - padL - padR);
  const ch = Math.max(0, height - padT - padB);

  return (
    <div ref={ref} style={{ width: '100%', height: '100%' }}>
      {width > 0 && height > 0 && cats.length > 0 && (
        <svg className={s.svg} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={data.title}>
          {/* baseline / axis */}
          <line x1={padL} y1={padT} x2={padL} y2={padT + ch} stroke={grid} />
          {!horizontal && <line x1={padL} y1={padT + ch} x2={padL + cw} y2={padT + ch} stroke={grid} />}
          {cats.map((c, i) => {
            const color = PALETTE[i % PALETTE.length];
            if (horizontal) {
              const bh = (ch / cats.length) * 0.6;
              const gap = (ch / cats.length);
              const y = padT + i * gap + (gap - bh) / 2;
              const bw = (c.value / max) * cw;
              return (
                <g key={i}>
                  <text x={padL - 6} y={y + bh / 2} textAnchor="end" dominantBaseline="middle"
                    fontSize={11} fill="currentColor">{trunc(c.label, 16)}</text>
                  <rect x={padL} y={y} width={bw} height={bh} fill={color} rx={2} />
                  <text x={padL + bw + 4} y={y + bh / 2} dominantBaseline="middle"
                    fontSize={10} fill="currentColor">{formatValue(c.value, data.format)}</text>
                </g>
              );
            }
            const gap = cw / cats.length;
            const bw = gap * 0.6;
            const x = padL + i * gap + (gap - bw) / 2;
            const bh = (c.value / max) * ch;
            const y = padT + ch - bh;
            return (
              <g key={i}>
                <rect x={x} y={y} width={bw} height={bh} fill={color} rx={2} />
                <text x={x + bw / 2} y={y - 3} textAnchor="middle" fontSize={10} fill="currentColor">
                  {formatValue(c.value, data.format)}
                </text>
                <text x={x + bw / 2} y={padT + ch + 14} textAnchor="middle" fontSize={10} fill="currentColor">
                  {trunc(c.label, 10)}
                </text>
              </g>
            );
          })}
        </svg>
      )}
    </div>
  );
}

function LineTile({ data }: { data: LineData }) {
  const s = useStyles();
  const [ref, { width, height }] = useElementSize<HTMLDivElement>();
  const grid = tokens.colorNeutralStroke2;
  const pts = data.points;
  const max = Math.max(1, ...pts.map((p) => p.value));
  const min = Math.min(0, ...pts.map((p) => p.value));
  const padL = 40;
  const padR = 12;
  const padT = 16;
  const padB = 28;
  const cw = Math.max(0, width - padL - padR);
  const ch = Math.max(0, height - padT - padB);
  const xy = (i: number, v: number) => {
    const x = padL + (pts.length === 1 ? cw / 2 : (i / (pts.length - 1)) * cw);
    const y = padT + ch - ((v - min) / (max - min || 1)) * ch;
    return [x, y] as const;
  };
  const color = PALETTE[1];
  const poly = pts.map((p, i) => xy(i, p.value).join(',')).join(' ');

  return (
    <div ref={ref} style={{ width: '100%', height: '100%' }}>
      {width > 0 && height > 0 && pts.length > 0 && (
        <svg className={s.svg} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={data.title}>
          <line x1={padL} y1={padT} x2={padL} y2={padT + ch} stroke={grid} />
          <line x1={padL} y1={padT + ch} x2={padL + cw} y2={padT + ch} stroke={grid} />
          <text x={padL - 4} y={padT + 4} textAnchor="end" fontSize={9} fill="currentColor">{formatValue(max, data.format)}</text>
          {pts.length > 1 && <polyline points={poly} fill="none" stroke={color} strokeWidth={2} />}
          {pts.map((p, i) => {
            const [x, y] = xy(i, p.value);
            return (
              <g key={i}>
                <circle cx={x} cy={y} r={3} fill={color} />
                <text x={x} y={y - 7} textAnchor="middle" fontSize={9} fill="currentColor">{formatValue(p.value, data.format)}</text>
                <text x={x} y={padT + ch + 14} textAnchor="middle" fontSize={9} fill="currentColor">{trunc(shortLabel(p.label), 10)}</text>
              </g>
            );
          })}
        </svg>
      )}
    </div>
  );
}

function PieTile({ data }: { data: PieData }) {
  const s = useStyles();
  const [ref, { width, height }] = useElementSize<HTMLDivElement>();
  const slices = data.slices.filter((sl) => sl.value > 0);
  const total = slices.reduce((a, b) => a + b.value, 0) || 1;
  const legendW = Math.min(150, Math.max(90, width * 0.42));
  const cx = (width - legendW) / 2;
  const cy = height / 2;
  const r = Math.max(8, Math.min(cx, cy) - 8);
  const inner = r * 0.55; // donut hole

  let acc = 0;
  const arcs = slices.map((sl, i) => {
    const a0 = (acc / total) * Math.PI * 2 - Math.PI / 2;
    acc += sl.value;
    const a1 = (acc / total) * Math.PI * 2 - Math.PI / 2;
    return { d: donutArc(cx, cy, r, inner, a0, a1), color: PALETTE[i % PALETTE.length], sl };
  });

  return (
    <div ref={ref} style={{ width: '100%', height: '100%' }}>
      {width > 0 && height > 0 && slices.length > 0 && (
        <svg className={s.svg} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={data.title}>
          {arcs.map((a, i) => <path key={i} d={a.d} fill={a.color} />)}
          {arcs.map((a, i) => (
            <g key={`l${i}`} transform={`translate(${width - legendW + 4}, ${12 + i * 16})`}>
              <rect width={10} height={10} rx={2} fill={a.color} />
              <text x={14} y={9} fontSize={10} fill="currentColor">
                {trunc(a.sl.label, 14)} · {formatValue(a.sl.value, data.format)}
              </text>
            </g>
          ))}
        </svg>
      )}
    </div>
  );
}

function TableTile({ data }: { data: TableData }) {
  const s = useStyles();
  return (
    <div className={s.tableScroll}>
      <table className={s.table}>
        <thead>
          <tr>{data.columns.map((c, i) => <th key={i} className={s.th}>{c}</th>)}</tr>
        </thead>
        <tbody>
          {data.rows.map((row, ri) => (
            <tr key={ri}>{row.map((cell, ci) => <td key={ci} className={s.td}>{cell}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ProvenanceDot({ prov }: { prov: EntityProvenance }) {
  const s = useStyles();
  const icon = prov.source === 'live'
    ? <CloudCheckmark16Regular className={s.provLive} />
    : prov.source === 'error'
      ? <Warning16Regular className={s.provError} />
      : <Database16Regular className={s.provSample} />;
  const label = prov.source === 'live' ? 'Live' : prov.source === 'error' ? 'Gate' : 'No data';
  return (
    <Tooltip relationship="description" content={prov.note || `${label} data`} withArrow>
      <span className={s.provDot} aria-label={`${label}: ${prov.note || ''}`}>{icon}</span>
    </Tooltip>
  );
}

function VisualTile({ visual, sample, prov }: { visual: Visual; sample: SampleData; prov?: EntityProvenance }) {
  const s = useStyles();
  const data = React.useMemo(() => buildVisualData(visual, sample), [visual, sample]);
  return (
    <>
      <div className={s.tileHead} title={visual.title}>
        <span className={s.tileHeadTitle}>{visual.title}</span>
        {prov && <ProvenanceDot prov={prov} />}
      </div>
      <div className={s.tileBody}>
        {data.kind === 'card' && <CardTile data={data} />}
        {data.kind === 'bars' && <BarsTile data={data} />}
        {data.kind === 'line' && <LineTile data={data} />}
        {data.kind === 'pie' && <PieTile data={data} />}
        {data.kind === 'table' && <TableTile data={data} />}
        {data.kind === 'unsupported' && (
          <div className={s.unsupported}>
            <PuzzlePiece24Regular />
            <Caption1>“{data.type}” preview not supported yet</Caption1>
          </div>
        )}
      </div>
    </>
  );
}

function PageCanvas({ page, sample, dataSources }: { page: Page; sample: SampleData; dataSources?: Record<string, EntityProvenance> }) {
  const s = useStyles();
  const W = page.width || 1280;
  const H = page.height || 720;
  return (
    <div className={s.canvasWrap}>
      <div className={s.canvas} style={{ aspectRatio: `${W} / ${H}` }}>
        {page.visuals.map((v) => {
          const entity = primaryEntity(v);
          const prov = dataSources && entity ? dataSources[entity] : undefined;
          return (
            <div
              key={v.id}
              className={s.tile}
              style={{
                left: `${(v.x / W) * 100}%`,
                top: `${(v.y / H) * 100}%`,
                width: `${(v.w / W) * 100}%`,
                height: `${(v.h / H) * 100}%`,
                zIndex: v.z,
              }}
            >
              <VisualTile visual={v} sample={sample} prov={prov} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

export interface ReportCanvasProps {
  model: ReportModel;
  /** The table-set to render (live-merged in live mode, else bundled sample). */
  sample: SampleData;
  /** Per-entity provenance (live mode only) — drives per-visual labelling. */
  dataSources?: Record<string, EntityProvenance>;
  /** True when rendering live data (changes the summary banner). */
  liveMode?: boolean;
  /** Optional controls rendered above the banner (Live/Sample toggle, params). */
  header?: React.ReactNode;
}

/** Summarize per-entity provenance into a truthful one-line banner. */
function liveSummary(dataSources?: Record<string, EntityProvenance>): { intent: 'success' | 'warning'; text: string } {
  const entries = Object.entries(dataSources || {});
  const live = entries.filter(([, p]) => p.source === 'live');
  const errored = entries.filter(([, p]) => p.source === 'error');
  const empty = entries.filter(([, p]) => p.source === 'empty');
  if (live.length && !errored.length && !empty.length) {
    return { intent: 'success', text: `Live from your Azure estate — ${live.map(([e]) => e).join(', ')}.` };
  }
  if (live.length) {
    const parts: string[] = [`Live: ${live.map(([e]) => e).join(', ')}`];
    if (empty.length) parts.push(`no rows: ${empty.map(([e]) => e).join(', ')}`);
    if (errored.length) parts.push(`needs setup: ${errored.map(([e]) => e).join(', ')}`);
    return { intent: 'warning', text: parts.join(' · ') };
  }
  return {
    intent: 'warning',
    text: errored.length
      ? `No live data yet — ${errored.map(([e]) => e).join(', ')} need provisioning/permissions (hover each tile).`
      : 'No live data source is bound to this report yet — showing no rows (hover each tile).',
  };
}

export function ReportCanvas({ model, sample, dataSources, liveMode, header }: ReportCanvasProps): React.ReactElement {
  const s = useStyles();
  const pages = model?.pages || [];
  const [active, setActive] = React.useState(pages[0]?.name ?? '');
  React.useEffect(() => { if (pages.length && !pages.some((p) => p.name === active)) setActive(pages[0].name); }, [pages, active]);

  if (!pages.length) {
    return (
      <div className={s.empty}>
        <DataPie24Regular />
        <Text>No report pages to display.</Text>
      </div>
    );
  }
  const page = pages.find((p) => p.name === active) || pages[0];
  const summary = liveMode ? liveSummary(dataSources) : null;

  return (
    <div className={s.root}>
      {header}
      {summary ? (
        <MessageBar intent={summary.intent}>
          <MessageBarBody>{summary.text} No Microsoft Fabric or Power BI workspace is required.</MessageBarBody>
        </MessageBar>
      ) : (
        <MessageBar intent="info">
          <MessageBarBody>
            Sample-data preview — switch to <strong>Live</strong> to render this report against your own Azure
            estate (Cost Management, Log Analytics, Resource Graph, Defender). No Microsoft Fabric or Power BI
            workspace is required.
          </MessageBarBody>
        </MessageBar>
      )}
      {pages.length > 1 && (
        <TabList className={s.tabs} selectedValue={page.name} onTabSelect={(_, d) => setActive(d.value as string)}>
          {pages.map((p) => <Tab key={p.name} value={p.name}>{p.displayName}</Tab>)}
        </TabList>
      )}
      <PageCanvas page={page} sample={sample} dataSources={liveMode ? dataSources : undefined} />
    </div>
  );
}

// --- small helpers ---------------------------------------------------------

function trunc(str: string, n: number): string {
  return str.length > n ? `${str.slice(0, n - 1)}…` : str;
}

/** For ISO datetimes render a compact YYYY-MM; else pass through. */
function shortLabel(label: string): string {
  const m = label.match(/^(\d{4})-(\d{2})-\d{2}T/);
  if (m) return `${m[1]}-${m[2]}`;
  const d = label.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (d) return `${d[1]}-${d[2]}`;
  return label;
}

/** SVG path for a donut/pie slice between two angles (radians). */
function donutArc(cx: number, cy: number, rOuter: number, rInner: number, a0: number, a1: number): string {
  const large = a1 - a0 > Math.PI ? 1 : 0;
  const x0o = cx + rOuter * Math.cos(a0), y0o = cy + rOuter * Math.sin(a0);
  const x1o = cx + rOuter * Math.cos(a1), y1o = cy + rOuter * Math.sin(a1);
  const x0i = cx + rInner * Math.cos(a1), y0i = cy + rInner * Math.sin(a1);
  const x1i = cx + rInner * Math.cos(a0), y1i = cy + rInner * Math.sin(a0);
  return [
    `M ${x0o} ${y0o}`,
    `A ${rOuter} ${rOuter} 0 ${large} 1 ${x1o} ${y1o}`,
    `L ${x0i} ${y0i}`,
    `A ${rInner} ${rInner} 0 ${large} 0 ${x1i} ${y1i}`,
    'Z',
  ].join(' ');
}

export default ReportCanvas;
